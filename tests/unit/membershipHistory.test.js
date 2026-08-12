'use strict';

const { expect } = require('chai');

const {
  MembershipHistory,
  fingerprintOf,
  tripleOf,
} = require('../../ZelBack/src/services/utils/membershipHistory');
const { NetworkStateManager } = require('../../ZelBack/src/services/utils/networkStateManager');

// The history is the committee-pinning basis: a fingerprint must move exactly
// when membership-relevant facts move, and reconstruction must be exact or
// absent. Every scenario here drives its own clock — retention is arithmetic,
// not scheduling.

const T0 = 1_700_000_000_000;

function node(i, overrides = {}) {
  return {
    txhash: String(i).padStart(4, '0').repeat(16),
    outidx: 0,
    pubkey: `owner-${i}`,
    ip: `10.${i}.0.1:16127`,
    tier: 'STRATUS',
    added_height: 100 + i,
    ...overrides,
  };
}

function membershipLines(triples) {
  return triples
    .map((t) => `${t.txhash}:${t.outidx}|${t.pubkey}|${t.ip}`)
    .sort();
}

describe('membershipHistory', () => {
  describe('the fingerprint', () => {
    it('is deterministic and order-blind', () => {
      const nodes = [node(1), node(2), node(3)].map(tripleOf);
      const reversed = [...nodes].reverse();
      expect(fingerprintOf(nodes)).to.equal(fingerprintOf(reversed));
    });

    it('moves with the outpoint, the owner, and the address — the walk consumes all three', () => {
      const base = [node(1), node(2)].map(tripleOf);
      const outpointMoved = [tripleOf(node(1, { outidx: 1 })), tripleOf(node(2))];
      const ownerMoved = [tripleOf(node(1, { pubkey: 'owner-9' })), tripleOf(node(2))];
      const addressMoved = [tripleOf(node(1, { ip: '10.99.0.1:16127' })), tripleOf(node(2))];
      const fps = new Set([
        fingerprintOf(base),
        fingerprintOf(outpointMoved),
        fingerprintOf(ownerMoved),
        fingerprintOf(addressMoved),
      ]);
      expect(fps.size).to.equal(4);
    });

    it('ignores what no walk consumes', () => {
      const a = [tripleOf(node(1, { tier: 'CUMULUS', last_paid_height: 5 }))];
      const b = [tripleOf(node(1, { tier: 'STRATUS', last_paid_height: 9 }))];
      expect(fingerprintOf(a)).to.equal(fingerprintOf(b));
    });
  });

  describe('recording and reconstruction', () => {
    let history;

    beforeEach(() => {
      history = new MembershipHistory();
    });

    it('a membership-neutral transition records no entry', () => {
      history.record([node(1), node(2)], { height: 100, hash: 'h100' }, T0);
      history.record([node(1, { tier: 'CUMULUS' }), node(2)], { height: 101, hash: 'h101' }, T0 + 30_000);
      expect(history.entryCount()).to.equal(0);
    });

    it('reconstructs every membership a sequence passed through, exactly', () => {
      const memberships = [
        [node(1), node(2), node(3)],
        [node(1), node(2), node(3), node(4)], // add
        [node(1), node(3), node(4)], // remove
        [node(1, { ip: '10.77.0.1:16127' }), node(3), node(4)], // address change
        [node(1, { ip: '10.77.0.1:16127' }), node(3), node(4, { pubkey: 'owner-sold' })], // owner change
      ];
      const fps = memberships.map((nodes, i) => history.record(
        nodes,
        { height: 100 + i, hash: `h${100 + i}` },
        T0 + i * 30_000,
      ));

      memberships.forEach((nodes, i) => {
        const rebuilt = history.membershipAt(fps[i]);
        expect(rebuilt, `membership ${i}`).to.not.equal(null);
        expect(membershipLines(rebuilt)).to.deep.equal(membershipLines(nodes.map(tripleOf)));
      });
    });

    it('reconstruction is immune to in-place mutation of the recorded nodes', () => {
      const one = node(1);
      const fpBefore = history.record([one, node(2)], { height: 100, hash: 'h' }, T0);
      one.ip = '10.99.99.99:16127'; // the state manager updates records in place
      history.record([one, node(2)], { height: 101, hash: 'h2' }, T0 + 1000);
      const rebuilt = history.membershipAt(fpBefore);
      expect(rebuilt.find((t) => t.pubkey === 'owner-1').ip).to.equal('10.1.0.1:16127');
    });

    it('an unknown fingerprint answers null, never an approximation', () => {
      history.record([node(1)], { height: 100, hash: 'h' }, T0);
      expect(history.membershipAt('f'.repeat(64))).to.equal(null);
      expect(history.membershipAt(null)).to.equal(null);
    });

    it('retention expires the oldest transitions and their fingerprints with them', () => {
      const fpOld = history.record([node(1)], { height: 100, hash: 'a' }, T0);
      history.record([node(1), node(2)], { height: 101, hash: 'b' }, T0 + 1000);
      // a transition far past the 150-minute window prunes the first entry
      history.record([node(1), node(2), node(3)], { height: 400, hash: 'c' }, T0 + 155 * 60 * 1000);
      expect(history.membershipAt(fpOld)).to.equal(null);
    });

    it('the entry-count backstop bounds the walk regardless of the clock', () => {
      let fleet = [node(1)];
      history.record(fleet, { height: 1, hash: 'h1' }, T0);
      for (let i = 2; i <= 4200; i += 1) {
        fleet = [...fleet.slice(-3), node(i)];
        history.record(fleet, { height: i, hash: `h${i}` }, T0 + i);
      }
      expect(history.entryCount()).to.be.at.most(4000);
    });
  });

  describe('fingerprintAt — height to committee basis', () => {
    it('answers the fingerprint in force at a height', () => {
      const history = new MembershipHistory();
      history.record([node(1)], { height: 100, hash: 'a' }, T0);
      const fp101 = history.record([node(1), node(2)], { height: 101, hash: 'b' }, T0 + 1000);
      const fp105 = history.record([node(1), node(2), node(3)], { height: 105, hash: 'c' }, T0 + 2000);

      expect(history.fingerprintAt(101)).to.equal(fp101);
      expect(history.fingerprintAt(103)).to.equal(fp101);
      expect(history.fingerprintAt(105)).to.equal(fp105);
      expect(history.fingerprintAt(999)).to.equal(fp105);
    });

    it('a height the window does not reach answers null', () => {
      const history = new MembershipHistory();
      history.record([node(1)], { height: 100, hash: 'a' }, T0);
      history.record([node(1), node(2)], { height: 101, hash: 'b' }, T0 + 1000);
      expect(history.fingerprintAt(99)).to.equal(null);
    });

    it('a seed with no transitions is all there has ever been', () => {
      const history = new MembershipHistory();
      const fp = history.record([node(1)], { height: 100, hash: 'a' }, T0);
      expect(history.fingerprintAt(50)).to.equal(fp);
    });
  });

  describe('fed by the state manager', () => {
    it('snapshot and delta transitions both land in the history', async () => {
      const manager = new NetworkStateManager(async () => ({ nodes: [] }), { intervalMs: 3_600_000 });
      await manager.applySnapshot([node(1), node(2)], 100, 'hash100');
      const fpBefore = manager.membershipHistory.currentFingerprint();
      expect(fpBefore).to.be.a('string');

      const outcome = await manager.applyDelta({
        fromHeight: 100,
        toHeight: 101,
        fromHash: 'hash100',
        toHash: 'hash101',
        added: [{ txid: node(3).txhash, index: 0 }],
        removed: [],
        updated: [],
      }, async () => [node(3)]);
      expect(outcome.applied).to.equal(true);

      const fpAfter = manager.membershipHistory.currentFingerprint();
      expect(fpAfter).to.not.equal(fpBefore);

      const before = manager.membershipHistory.membershipAt(fpBefore);
      expect(membershipLines(before)).to.deep.equal(
        membershipLines([node(1), node(2)].map(tripleOf)),
      );
    });
  });
});
