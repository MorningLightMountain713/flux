'use strict';

const { expect } = require('chai');
const secp256k1 = require('secp256k1');
const bs58check = require('bs58check');

const rosterOverlay = require('../../ZelBack/src/services/quorumGrant/rosterOverlay');
const signedEnvelope = require('../../ZelBack/src/services/quorumGrant/signedEnvelope');
const { selectCommittee } = require('../../ZelBack/src/services/utils/committeeSelector');
const { rankNodes } = require('../../ZelBack/src/services/utils/rendezvousRank');

// The overlay against real cryptography: every acceptance in these chains is
// signed with a real secp256k1 key whose public half sits in the membership,
// exactly what a verifier resolves in production. Committees and replacements
// are derived IN the test with the same walk the code runs — the fixtures
// assert relationships, never hash-lucky seatings.

const keypairs = new Map();

function keypairFor(index) {
  if (!keypairs.has(index)) {
    const priv = Buffer.alloc(32);
    priv.writeUInt32BE(index + 1, 28);
    keypairs.set(index, {
      wif: bs58check.encode(Buffer.concat([Buffer.from([0x80]), priv])),
      pubkey: Buffer.from(secp256k1.publicKeyCreate(priv, false)).toString('hex'),
    });
  }
  return keypairs.get(index);
}

const KEY = 'rosterapp/master';
const GENERATION = 0;
const WALK_KEY = rosterOverlay.walkKeyFor(KEY, GENERATION);
const FINGERPRINT = 'e'.repeat(64);
const SIZE = 5;

function outpointOf(node) {
  return `${node.txhash}:${node.outidx}`;
}

function fleet(count) {
  return Array.from({ length: count }, (unused, i) => ({
    txhash: String(i + 1).padStart(2, '0').repeat(32),
    outidx: 0,
    pubkey: keypairFor(i).pubkey,
    ip: `10.${i + 1}.0.1:16127`,
  }));
}

function wifByOutpoint(membership) {
  const map = new Map();
  membership.forEach((node, i) => map.set(outpointOf(node), keypairFor(i).wif));
  return map;
}

function signAcceptance(entry, grantorNode, wif) {
  const fields = signedEnvelope.fieldsFor('rosteraccept', {
    key: KEY,
    fingerprint: FINGERPRINT,
    generation: GENERATION,
    seq: entry.seq,
    remove: entry.remove,
    add: entry.add,
  });
  const signed = signedEnvelope.sign('rosteraccept', fields, wif);
  return { grantor: outpointOf(grantorNode), signature: signed.signature };
}

describe('quorumGrant rosterOverlay', () => {
  const membership = fleet(12);
  const wifs = wifByOutpoint(membership);
  const base = selectCommittee(membership, WALK_KEY, { size: SIZE });

  function signedEntry(entry, signers) {
    return {
      ...entry,
      acceptances: signers.map((node) => signAcceptance(entry, node, wifs.get(outpointOf(node)))),
    };
  }

  /** One valid chain link atop the given roster, quorum-signed by its members. */
  function buildEntry(seq, roster, excluded, removeIndex = 0) {
    const remove = roster[removeIndex];
    const survivors = roster.filter((node) => node !== remove);
    const nextExcluded = new Set([...excluded, outpointOf(remove)]);
    const added = rosterOverlay.nextReplacement(membership, WALK_KEY, survivors, nextExcluded);
    const entry = signedEntry(
      { seq, remove: outpointOf(remove), add: outpointOf(added), at: 1000 },
      roster.slice(0, base.quorum),
    );
    return {
      entry, added, survivors, nextExcluded,
    };
  }

  describe('nextReplacement', () => {
    it('is deterministic and never seats a sitting, removed, owner-colliding or host-colliding node', () => {
      const removed = base.members[2];
      const survivors = base.members.filter((node) => node !== removed);
      const excluded = new Set([outpointOf(removed)]);

      const first = rosterOverlay.nextReplacement(membership, WALK_KEY, survivors, excluded);
      const second = rosterOverlay.nextReplacement(membership, WALK_KEY, survivors, excluded);
      expect(first).to.equal(second);
      expect(first).to.not.equal(null);
      expect(survivors.map(outpointOf)).to.not.include(outpointOf(first));
      expect(outpointOf(first)).to.not.equal(outpointOf(removed));
      expect(survivors.map((node) => node.pubkey)).to.not.include(first.pubkey);
      expect(survivors.map((node) => node.ip)).to.not.include(first.ip);
    });

    it('skips a candidate sharing an owner with a survivor, however well it ranks', () => {
      const removed = base.members[0];
      const survivors = base.members.filter((node) => node !== removed);
      const excluded = new Set([outpointOf(removed)]);
      const wouldSeat = rosterOverlay.nextReplacement(membership, WALK_KEY, survivors, excluded);

      const collided = membership.map((node) => (node === wouldSeat
        ? { ...node, pubkey: survivors[0].pubkey }
        : node));
      const instead = rosterOverlay.nextReplacement(collided, WALK_KEY, survivors, excluded);
      expect(instead).to.not.equal(null);
      expect(outpointOf(instead)).to.not.equal(outpointOf(wouldSeat));
      expect(survivors.map((node) => node.pubkey)).to.not.include(instead.pubkey);
    });

    it('skips a candidate on a survivor address, and falls down the rung ladder rather than refuse', () => {
      const removed = base.members[0];
      const survivors = base.members.filter((node) => node !== removed);
      const excluded = new Set([outpointOf(removed)]);
      const survivorHost = survivors[0].ip.split(':')[0];

      // every off-roster candidate crowded into one survivor's /24: the two
      // prefix rungs admit nobody, the address rung still seats the best-
      // ranked candidate — a replacement that exists beats a spread that
      // refuses
      let spare = 0;
      const crowded = membership.map((node) => {
        if (base.members.includes(node)) return node;
        spare += 1;
        return { ...node, ip: `${survivorHost.split('.').slice(0, 3).join('.')}.${100 + spare}:16127` };
      });
      const instead = rosterOverlay.nextReplacement(crowded, WALK_KEY, survivors, excluded);
      expect(instead).to.not.equal(null);
      const ranked = rankNodes(crowded, WALK_KEY);
      const firstEligible = ranked.find(
        (node) => !survivors.includes(node) && !excluded.has(outpointOf(node))
          && !base.members.some((member) => member.txhash === node.txhash),
      );
      expect(outpointOf(instead)).to.equal(outpointOf(firstEligible));
    });

    it('answers null when no eligible node remains', () => {
      const survivors = membership.slice(0, membership.length - 1);
      const excluded = new Set([outpointOf(membership[membership.length - 1])]);
      expect(rosterOverlay.nextReplacement(membership, WALK_KEY, survivors, excluded)).to.equal(null);
    });
  });

  describe('rosterAfter', () => {
    it('applies entries in order and answers null for a chain from another world', () => {
      const { entry, added } = buildEntry(1, base.members, new Set());
      const roster = rosterOverlay.rosterAfter(base.members, membership, [entry]);
      expect(roster.map(outpointOf)).to.include(outpointOf(added));
      expect(roster.map(outpointOf)).to.not.include(entry.remove);
      expect(roster).to.have.length(SIZE);

      const foreign = [{ ...entry, add: `${'f'.repeat(64)}:0` }];
      expect(rosterOverlay.rosterAfter(base.members, membership, foreign)).to.equal(null);
      const doubled = [entry, entry];
      expect(rosterOverlay.rosterAfter(base.members, membership, doubled)).to.equal(null);
    });
  });

  // The term credential (STEP_ACROSS_DESIGN.md D1/D2): the retired world's
  // basis and a quorum of THAT committee's signed term acceptances, verified by
  // a referee that never sat on it. The committee is derived exactly as the
  // referees derive it — the walk key at the carried generation, then the
  // carried roster chain — and the signatures are over the term's identity
  // with the CANDIDATE as grantee, so a bundle signed for someone else can
  // never admit the node presenting it.
  describe('verifyTermCredential', () => {
    const EPOCH = 7;
    const GRANTEE = outpointOf(membership[11]); // not on the committee, as a master need not be
    const STANDING = GENERATION + 1;
    function termAcceptance(node, wif, overrides = {}) {
      const fields = signedEnvelope.fieldsFor('termaccept', {
        key: KEY, fingerprint: FINGERPRINT, generation: GENERATION, epoch: EPOCH, grantee: GRANTEE, ...overrides,
      });
      const signed = signedEnvelope.sign('termaccept', fields, wif);
      return { grantor: outpointOf(node), signature: signed.signature };
    }
    const credential = (signers, extra = {}) => ({
      fingerprint: FINGERPRINT,
      generation: GENERATION,
      epoch: EPOCH,
      roster: null,
      acceptances: signers.map((node) => termAcceptance(node, wifs.get(outpointOf(node)))),
      ...extra,
    });
    const opts = { committeeSize: SIZE, candidate: GRANTEE, standingGeneration: STANDING };

    it('a quorum of the retired committee\'s signatures over this candidate\'s term names it the incumbent', () => {
      const verified = rosterOverlay.verifyTermCredential(membership, KEY, credential(base.members.slice(0, base.quorum)), opts);
      expect(verified).to.equal(GRANTEE);
    });

    it('below a quorum, or with a forged signature, or signed by outsiders, it names nobody', () => {
      expect(rosterOverlay.verifyTermCredential(membership, KEY, credential(base.members.slice(0, base.quorum - 1)), opts)).to.equal(null);
      const forged = credential(base.members.slice(0, base.quorum));
      forged.acceptances[0] = { ...forged.acceptances[0], signature: forged.acceptances[1].signature };
      expect(rosterOverlay.verifyTermCredential(membership, KEY, forged, opts)).to.equal(null);
      const outsiders = membership.filter((node) => !base.members.includes(node));
      expect(rosterOverlay.verifyTermCredential(membership, KEY, credential(outsiders.slice(0, base.quorum)), opts)).to.equal(null);
      const repeated = credential(base.members.slice(0, base.quorum));
      repeated.acceptances = Array(base.quorum).fill(repeated.acceptances[0]);
      expect(rosterOverlay.verifyTermCredential(membership, KEY, repeated, opts), 'one signer counted once').to.equal(null);
    });

    it('only the world immediately below the standing one, and only for the grantee the signatures name', () => {
      const good = credential(base.members.slice(0, base.quorum));
      expect(rosterOverlay.verifyTermCredential(membership, KEY, good, { ...opts, standingGeneration: STANDING + 1 })).to.equal(null);
      expect(rosterOverlay.verifyTermCredential(membership, KEY, good, { ...opts, standingGeneration: GENERATION })).to.equal(null);
      expect(rosterOverlay.verifyTermCredential(membership, KEY, good, { ...opts, candidate: outpointOf(membership[10]) }), 'presented by someone else').to.equal(null);
      expect(rosterOverlay.verifyTermCredential(membership, KEY, { ...good, epoch: EPOCH + 1 }, opts), 'another epoch is another term').to.equal(null);
    });

    it('a healed committee signs through its roster chain: the seat the chain added counts, the seat it removed does not', () => {
      const { entry, added, survivors } = buildEntry(1, base.members, new Set());
      const removed = base.members[0];
      const healed = [...survivors, added];
      const withChain = credential(healed.slice(0, base.quorum), { roster: { chain: [entry] } });
      expect(rosterOverlay.verifyTermCredential(membership, KEY, withChain, opts)).to.equal(GRANTEE);
      const staleSigners = [removed, ...survivors.slice(0, base.quorum - 1)];
      const stale = credential(staleSigners, { roster: { chain: [entry] } });
      expect(rosterOverlay.verifyTermCredential(membership, KEY, stale, opts)).to.equal(null);
    });

    it('a malformed credential is refused as malformed, never verified', () => {
      expect(rosterOverlay.credentialWellFormed(credential(base.members.slice(0, base.quorum)))).to.equal(true);
      expect(rosterOverlay.credentialWellFormed(null)).to.equal(false);
      expect(rosterOverlay.credentialWellFormed({ fingerprint: FINGERPRINT, generation: 0, epoch: 1, acceptances: 'x' })).to.equal(false);
      expect(rosterOverlay.credentialWellFormed({ fingerprint: FINGERPRINT, generation: 0, epoch: 1, roster: { chain: 'x' }, acceptances: [] })).to.equal(false);
      expect(rosterOverlay.verifyTermCredential(membership, KEY, null, opts)).to.equal(null);
    });
  });

  describe('verifyChain', () => {
    it('accepts a quorum-signed chain and returns the effective roster', () => {
      const { entry, added } = buildEntry(1, base.members, new Set());
      const verified = rosterOverlay.verifyChain(membership, KEY, FINGERPRINT, GENERATION, SIZE, [entry]);
      expect(verified).to.not.equal(null);
      expect(verified.quorum).to.equal(base.quorum);
      expect(verified.members.map(outpointOf)).to.include(outpointOf(added));
      expect(verified.members.map(outpointOf)).to.not.include(entry.remove);
    });

    it('refuses a hand-picked replacement even when a quorum signed it', () => {
      const removed = base.members[0];
      const survivors = base.members.filter((node) => node !== removed);
      const excluded = new Set([outpointOf(removed)]);
      const forced = rosterOverlay.nextReplacement(membership, WALK_KEY, survivors, excluded);
      const offWalk = membership.find(
        (node) => !base.members.includes(node) && outpointOf(node) !== outpointOf(forced),
      );
      const entry = signedEntry(
        {
          seq: 1, remove: outpointOf(removed), add: outpointOf(offWalk), at: 1000,
        },
        base.members.slice(0, base.quorum),
      );
      expect(rosterOverlay.verifyChain(membership, KEY, FINGERPRINT, GENERATION, SIZE, [entry])).to.equal(null);
    });

    it('refuses below quorum, and counts one signer once however many times it signs', () => {
      const removed = base.members[0];
      const survivors = base.members.filter((node) => node !== removed);
      const added = rosterOverlay.nextReplacement(
        membership, WALK_KEY, survivors, new Set([outpointOf(removed)]),
      );
      const bare = {
        seq: 1, remove: outpointOf(removed), add: outpointOf(added), at: 1000,
      };

      const short = signedEntry(bare, base.members.slice(0, base.quorum - 1));
      expect(rosterOverlay.verifyChain(membership, KEY, FINGERPRINT, GENERATION, SIZE, [short])).to.equal(null);

      const repeated = {
        ...bare,
        acceptances: Array.from({ length: base.quorum }, () => signAcceptance(
          bare, base.members[0], wifs.get(outpointOf(base.members[0])),
        )),
      };
      expect(rosterOverlay.verifyChain(membership, KEY, FINGERPRINT, GENERATION, SIZE, [repeated])).to.equal(null);
    });

    it('ignores signatures from outside the pre-change roster', () => {
      const removed = base.members[0];
      const survivors = base.members.filter((node) => node !== removed);
      const added = rosterOverlay.nextReplacement(
        membership, WALK_KEY, survivors, new Set([outpointOf(removed)]),
      );
      const bare = {
        seq: 1, remove: outpointOf(removed), add: outpointOf(added), at: 1000,
      };
      const outsiders = membership.filter((node) => !base.members.includes(node));
      const entry = {
        ...bare,
        acceptances: [
          ...base.members.slice(0, base.quorum - 1).map(
            (node) => signAcceptance(bare, node, wifs.get(outpointOf(node))),
          ),
          signAcceptance(bare, outsiders[0], wifs.get(outpointOf(outsiders[0]))),
        ],
      };
      expect(rosterOverlay.verifyChain(membership, KEY, FINGERPRINT, GENERATION, SIZE, [entry])).to.equal(null);
    });

    it('a second link is judged against the healed roster — its new member counts, its removed member does not', () => {
      const first = buildEntry(1, base.members, new Set());
      const healed = [...first.survivors, first.added];

      // second entry removes another original seat; signers drawn from the
      // healed roster INCLUDING the freshly added member
      const remove2 = first.survivors[0];
      const survivors2 = healed.filter((node) => node !== remove2);
      const excluded2 = new Set([...first.nextExcluded, outpointOf(remove2)]);
      const added2 = rosterOverlay.nextReplacement(membership, WALK_KEY, survivors2, excluded2);
      const bare2 = {
        seq: 2, remove: outpointOf(remove2), add: outpointOf(added2), at: 2000,
      };
      const signers2 = [first.added, ...survivors2.filter((node) => node !== first.added)]
        .slice(0, base.quorum);
      const entry2 = signedEntry(bare2, signers2);

      const verified = rosterOverlay.verifyChain(
        membership, KEY, FINGERPRINT, GENERATION, SIZE, [first.entry, entry2],
      );
      expect(verified).to.not.equal(null);
      expect(verified.members.map(outpointOf)).to.include(outpointOf(added2));

      // the seat removed by the first link cannot help sign the second
      const entry2ByGhost = {
        ...bare2,
        acceptances: [
          ...survivors2.slice(0, base.quorum - 1).map(
            (node) => signAcceptance(bare2, node, wifs.get(outpointOf(node))),
          ),
          signAcceptance(
            bare2,
            base.members.find((node) => outpointOf(node) === first.entry.remove),
            wifs.get(first.entry.remove),
          ),
        ],
      };
      expect(rosterOverlay.verifyChain(
        membership, KEY, FINGERPRINT, GENERATION, SIZE, [first.entry, entry2ByGhost],
      )).to.equal(null);
    });

    it('refuses out-of-order seqs and chains past the cap', () => {
      const { entry } = buildEntry(1, base.members, new Set());
      expect(rosterOverlay.verifyChain(
        membership, KEY, FINGERPRINT, GENERATION, SIZE, [{ ...entry, seq: 2 }],
      )).to.equal(null);

      const overlong = Array.from({ length: SIZE + 1 }, (unused, i) => ({ ...entry, seq: i + 1 }));
      expect(rosterOverlay.verifyChain(membership, KEY, FINGERPRINT, GENERATION, SIZE, overlong)).to.equal(null);
    });

    it('a signature over one basis never verifies a chain claimed at another fingerprint or generation', () => {
      const { entry } = buildEntry(1, base.members, new Set());
      expect(rosterOverlay.verifyChain(
        membership, KEY, 'f'.repeat(64), GENERATION, SIZE, [entry],
      )).to.equal(null);
      expect(rosterOverlay.verifyChain(
        membership, KEY, FINGERPRINT, GENERATION + 1, SIZE, [entry],
      )).to.equal(null);
    });

    it('the walk key is generation-salted unconditionally, and each generation deals its own committee', () => {
      expect(rosterOverlay.walkKeyFor(KEY, 0)).to.equal(`quorumgrant|${KEY}@0`);
      expect(rosterOverlay.walkKeyFor(KEY, 3)).to.equal(`quorumgrant|${KEY}@3`);
      const dealZero = selectCommittee(membership, rosterOverlay.walkKeyFor(KEY, 0), { size: SIZE });
      const dealOne = selectCommittee(membership, rosterOverlay.walkKeyFor(KEY, 1), { size: SIZE });
      expect(dealZero.members.map(outpointOf)).to.not.deep.equal(dealOne.members.map(outpointOf));
    });
  });

  describe('extendsChain', () => {
    it('accepts an extension, refuses a fork and a truncation', () => {
      const first = buildEntry(1, base.members, new Set());
      const healed = [...first.survivors, first.added];
      const second = buildEntry(2, healed, first.nextExcluded, 1);

      const journaled = [first.entry];
      expect(rosterOverlay.extendsChain(journaled, [first.entry, second.entry])).to.equal(true);
      expect(rosterOverlay.extendsChain(journaled, [])).to.equal(false);
      const fork = [{ ...first.entry, add: second.entry.add }, second.entry];
      expect(rosterOverlay.extendsChain(journaled, fork)).to.equal(false);
    });
  });

  describe('chainWellFormed', () => {
    it('bounds entries and acceptances before any cryptography runs', () => {
      const { entry } = buildEntry(1, base.members, new Set());
      expect(rosterOverlay.chainWellFormed([entry])).to.equal(true);
      expect(rosterOverlay.chainWellFormed('chain')).to.equal(false);
      expect(rosterOverlay.chainWellFormed([{ ...entry, remove: 'not-an-outpoint' }])).to.equal(false);
      const packed = {
        ...entry,
        acceptances: Array.from({ length: 17 }, () => entry.acceptances[0]),
      };
      expect(rosterOverlay.chainWellFormed([packed])).to.equal(false);
      const long = Array.from({ length: 33 }, (unused, i) => ({ ...entry, seq: i + 1 }));
      expect(rosterOverlay.chainWellFormed(long)).to.equal(false);
    });
  });
});
