'use strict';

const crypto = require('crypto');
const { expect } = require('chai');

const {
  FLOOR_OWNERS,
  eligible,
  walkRanking,
  selectCommittee,
} = require('../../ZelBack/src/services/utils/committeeSelector');
const { rankNodes } = require('../../ZelBack/src/services/utils/rendezvousRank');

/**
 * Committees are what the grant plane's quorum arithmetic runs on, so these
 * tests are property-heavy by design (the certificates doc's §6.10 discipline):
 * the exclusions must hold on EVERY fleet shape, not on one fixture.
 */

// Deterministic fleet material — no Math.random anywhere, so a failure
// reproduces byte-for-byte. Hex from a counter-seeded hash stands in for
// txhashes; addresses are laid out explicitly per test.
function hex(seed) {
  return crypto.createHash('sha256').update(String(seed)).digest('hex');
}

let outpointCounter = 0;

function mkNode(overrides = {}) {
  outpointCounter += 1;
  return {
    txhash: hex(`tx-${outpointCounter}`),
    outidx: 0,
    pubkey: `owner-${outpointCounter}`,
    ip: `10.${Math.floor(outpointCounter / 250) % 250}.${outpointCounter % 250}.1`,
    tier: 'STRATUS',
    ...overrides,
  };
}

/**
 * `count` nodes, one per owner, addresses spread so every rung is satisfied:
 * each node gets its own /16.
 */
function spreadFleet(count, tag = 'a') {
  return Array.from({ length: count }, (unused, i) => mkNode({
    pubkey: `owner-${tag}-${i}`,
    ip: `10.${i}.0.1`,
  }));
}

function owners(members) {
  return members.map((node) => node.pubkey);
}

function hosts(members) {
  return members.map((node) => node.ip.split(':')[0]);
}

function slash16(host) {
  return host.split('.').slice(0, 2).join('.');
}

describe('committeeSelector', () => {
  beforeEach(() => {
    outpointCounter = 0;
  });

  describe('eligibility', () => {
    it('accepts a complete deterministic-list node', () => {
      expect(eligible(mkNode())).to.equal(true);
    });

    it('rejects nodes the rules cannot be applied to', () => {
      expect(eligible(null)).to.equal(false);
      expect(eligible(mkNode({ pubkey: undefined }))).to.equal(false);
      expect(eligible(mkNode({ ip: undefined }))).to.equal(false);
      expect(eligible(mkNode({ txhash: undefined }))).to.equal(false);
      expect(eligible(mkNode({ outidx: undefined }))).to.equal(false);
    });

    it('accepts outidx 0 — falsy is not missing', () => {
      expect(eligible(mkNode({ outidx: 0 }))).to.equal(true);
    });

    it('ineligible nodes are skipped, not fatal', () => {
      const fleet = spreadFleet(6);
      fleet.push({ pubkey: 'no-address' });
      fleet.push(null);
      const result = selectCommittee(fleet, 'k');
      expect(result.refusal).to.equal(null);
      expect(result.members).to.have.length(5);
    });
  });

  describe('the hard rules', () => {
    it('one owner, one seat — however many nodes the owner runs', () => {
      const fleet = spreadFleet(6);
      // one owner floods the fleet with nodes; at most one may seat
      for (let i = 0; i < 40; i += 1) {
        fleet.push(mkNode({ pubkey: 'owner-whale', ip: `172.${i}.0.1` }));
      }
      const result = selectCommittee(fleet, 'whale-key');
      const seatedOwners = owners(result.members);
      const whaleSeats = seatedOwners.filter((o) => o === 'owner-whale');
      expect(whaleSeats.length).to.be.at.most(1);
      expect(new Set(seatedOwners).size).to.equal(result.members.length);
    });

    it('one public address, one seat — two owners behind one IP are one domain', () => {
      const fleet = spreadFleet(5);
      fleet.push(mkNode({ pubkey: 'owner-x', ip: '203.0.113.7' }));
      fleet.push(mkNode({ pubkey: 'owner-y', ip: '203.0.113.7:16137' }));
      const result = selectCommittee(fleet, 'shared-addr');
      const seatedHosts = hosts(result.members);
      expect(new Set(seatedHosts).size).to.equal(result.members.length);
    });

    it('the address rule compares hosts, ignoring the API port', () => {
      const seated = walkRanking(
        rankNodes([
          mkNode({ pubkey: 'p', ip: '198.51.100.9' }),
          mkNode({ pubkey: 'q', ip: '198.51.100.9:16147' }),
        ], 'k'),
        2,
        () => null,
      );
      expect(seated).to.have.length(1);
    });
  });

  describe('determinism — the property everything rides on', () => {
    it('input order never changes the committee', () => {
      const fleet = spreadFleet(30);
      const forward = selectCommittee(fleet, 'stable-key');
      const reversed = selectCommittee([...fleet].reverse(), 'stable-key');
      expect(owners(forward.members)).to.deep.equal(owners(reversed.members));
    });

    it('the same key always yields the same committee, different keys differ', () => {
      const fleet = spreadFleet(40);
      const a1 = selectCommittee(fleet, 'app-a/master');
      const a2 = selectCommittee(fleet, 'app-a/master');
      const b = selectCommittee(fleet, 'app-b/master');
      expect(owners(a1.members)).to.deep.equal(owners(a2.members));
      // 40 spread owners: identical five in identical order is (5/40)^5-class
      // luck; a collision here means the key stopped reaching the hash.
      expect(owners(a1.members)).to.not.deep.equal(owners(b.members));
    });

    it('churn is local: removing a non-member changes nothing', () => {
      const fleet = spreadFleet(30);
      const before = selectCommittee(fleet, 'churn-key');
      const memberSet = new Set(owners(before.members));
      const bystander = fleet.find((node) => !memberSet.has(node.pubkey));
      const after = selectCommittee(
        fleet.filter((node) => node !== bystander),
        'churn-key',
      );
      expect(owners(after.members)).to.deep.equal(owners(before.members));
    });

    it('churn is bounded: removing one member replaces one seat', () => {
      const fleet = spreadFleet(30);
      const before = selectCommittee(fleet, 'churn-key');
      const departed = before.members[2];
      const after = selectCommittee(
        fleet.filter((node) => node !== departed),
        'churn-key',
      );
      const beforeSet = new Set(owners(before.members));
      const afterSet = new Set(owners(after.members));
      const gone = [...beforeSet].filter((o) => !afterSet.has(o));
      const arrived = [...afterSet].filter((o) => !beforeSet.has(o));
      expect(gone).to.deep.equal([departed.pubkey]);
      expect(arrived).to.have.length(1);
    });
  });

  describe('the fault-domain ladder', () => {
    it('reports slash16 when the fleet affords it', () => {
      const result = selectCommittee(spreadFleet(12), 'k');
      expect(result.rung).to.equal('slash16');
      const prefixes = hosts(result.members).map(slash16);
      expect(new Set(prefixes).size).to.equal(result.members.length);
    });

    it('relaxes to slash24 when /16s are scarce, and spreads within it', () => {
      // Ten owners across exactly three /16s — a 5-committee cannot be
      // /16-diverse, but every /24 is distinct.
      const fleet = Array.from({ length: 10 }, (unused, i) => mkNode({
        pubkey: `owner-c-${i}`,
        ip: `10.${i % 3}.${i}.1`,
      }));
      const result = selectCommittee(fleet, 'clustered');
      expect(result.refusal).to.equal(null);
      expect(result.members).to.have.length(5);
      expect(result.rung).to.equal('slash24');
      const p24 = hosts(result.members).map((h) => h.split('.').slice(0, 3).join('.'));
      expect(new Set(p24).size).to.equal(5);
    });

    it('falls to bare address distinctness rather than refuse', () => {
      // Five owners, five addresses, one /24. The committee exists; the
      // ladder just cannot buy any network spread.
      const fleet = Array.from({ length: 5 }, (unused, i) => mkNode({
        pubkey: `owner-d-${i}`,
        ip: `10.0.0.${i + 1}`,
      }));
      const result = selectCommittee(fleet, 'one-rack');
      expect(result.refusal).to.equal(null);
      expect(result.members).to.have.length(5);
      expect(result.rung).to.equal('address');
    });

    it('spread never shrinks the committee: size wins over rung', () => {
      // Nine owners in three /16s: at /16 only 3 could seat, at /24 all
      // nine are distinct. A 5-committee must come from the /24 rung with
      // five seats, never the /16 rung with three.
      const fleet = Array.from({ length: 9 }, (unused, i) => mkNode({
        pubkey: `owner-e-${i}`,
        ip: `10.${i % 3}.${10 + i}.1`,
      }));
      const result = selectCommittee(fleet, 'size-beats-rung');
      expect(result.members).to.have.length(5);
      expect(result.rung).to.equal('slash24');
    });

    it('a provided domainOf becomes the tightest rung', () => {
      const orgOf = (node) => (node.pubkey.endsWith('0') || node.pubkey.endsWith('5') ? 'org-a' : `org-${node.pubkey}`);
      const fleet = spreadFleet(12);
      const result = selectCommittee(fleet, 'org-aware', { domainOf: orgOf });
      expect(result.rung).to.equal('custom');
      const domains = result.members.map((node) => orgOf(node));
      expect(new Set(domains).size).to.equal(result.members.length);
    });

    it('a domainOf that cannot fill relaxes to the prefix rungs', () => {
      const result = selectCommittee(spreadFleet(12), 'one-org', {
        domainOf: () => 'the-only-org',
      });
      expect(result.rung).to.equal('slash16');
      expect(result.members).to.have.length(5);
    });
  });

  describe('sizing and the floor', () => {
    it('defaults to five seats, quorum three', () => {
      const result = selectCommittee(spreadFleet(20), 'k');
      expect(result.members).to.have.length(5);
      expect(result.quorum).to.equal(3);
    });

    it('seats nine with quorum five for the ONE-SHOT size', () => {
      const result = selectCommittee(spreadFleet(20), 'k', { size: 9 });
      expect(result.members).to.have.length(9);
      expect(result.quorum).to.equal(5);
    });

    it('shrinks to the distinct owners available', () => {
      const fleet = spreadFleet(4);
      fleet.push(mkNode({ pubkey: 'owner-a-0', ip: '10.99.0.1' }));
      const result = selectCommittee(fleet, 'k');
      expect(result.members).to.have.length(4);
      expect(result.quorum).to.equal(3);
    });

    it('a 3-owner fleet gets a 3-committee with quorum 2', () => {
      const result = selectCommittee(spreadFleet(3), 'k');
      expect(result.members).to.have.length(3);
      expect(result.quorum).to.equal(2);
    });

    it('refuses below the floor rather than shrink the meaning', () => {
      const result = selectCommittee(spreadFleet(2), 'k');
      expect(result.members).to.equal(null);
      expect(result.quorum).to.equal(0);
      expect(result.refusal).to.contain('floor');
    });

    it('refuses when owners exist but share addresses below the floor', () => {
      // Four owners, two addresses: the wire sees two failure domains.
      const fleet = [
        mkNode({ pubkey: 'w', ip: '203.0.113.1' }),
        mkNode({ pubkey: 'x', ip: '203.0.113.1:16137' }),
        mkNode({ pubkey: 'y', ip: '203.0.113.2' }),
        mkNode({ pubkey: 'z', ip: '203.0.113.2:16137' }),
      ];
      const result = selectCommittee(fleet, 'k');
      expect(result.members).to.equal(null);
      expect(result.refusal).to.contain('floor');
    });

    it('an empty or missing list refuses', () => {
      expect(selectCommittee([], 'k').refusal).to.contain('floor');
      expect(selectCommittee(undefined, 'k').refusal).to.contain('floor');
    });
  });

  describe('properties over many fleet shapes', () => {
    // Fleet shapes chosen to cover the axes that have each broken a walk
    // somewhere: owner multiplicity, shared addresses, prefix clustering,
    // and fleets near the floor.
    const shapes = [];
    for (let s = 0; s < 12; s += 1) {
      const fleet = [];
      const ownerCount = 3 + (s % 7) * 4;
      for (let o = 0; o < ownerCount; o += 1) {
        const nodesForOwner = 1 + ((o + s) % 3);
        for (let n = 0; n < nodesForOwner; n += 1) {
          fleet.push(mkNode({
            pubkey: `owner-p${s}-${o}`,
            ip: `10.${(o + n) % (2 + s)}.${o}.${1 + n}`,
          }));
        }
      }
      shapes.push({ label: `shape-${s} (${ownerCount} owners, ${fleet.length} nodes)`, fleet });
    }

    shapes.forEach(({ label, fleet }) => {
      it(`${label}: exclusions, quorum arithmetic, and size bounds all hold`, () => {
        ['app-1/master', 'app-2/founder', 'app-3/master'].forEach((key) => {
          const result = selectCommittee(fleet, key);
          const distinctOwners = new Set(fleet.filter(eligible).map((n) => n.pubkey)).size;
          if (result.refusal !== null) {
            expect(distinctOwnersSeatable(fleet)).to.be.below(FLOOR_OWNERS);
            return;
          }
          const seated = result.members;
          expect(seated.length).to.be.at.most(5);
          expect(seated.length).to.be.at.most(distinctOwners);
          expect(seated.length).to.be.at.least(FLOOR_OWNERS);
          expect(new Set(owners(seated)).size).to.equal(seated.length);
          expect(new Set(hosts(seated)).size).to.equal(seated.length);
          expect(result.quorum).to.equal(Math.floor(seated.length / 2) + 1);
        });
      });
    });

    function distinctOwnersSeatable(fleet) {
      const ranked = rankNodes(fleet.filter(eligible), 'seatable-probe');
      return walkRanking(ranked, Infinity, () => null).length;
    }
  });
});
