'use strict';

const { expect } = require('chai');

const rosterOverlay = require('../../ZelBack/src/services/quorumGrant/rosterOverlay');
const { selectCommittee } = require('../../ZelBack/src/services/utils/committeeSelector');

// The cancel overlay: how a node-down certificate cancels a committee seat.
//
// The certificate itself is another plane's object — its jury signatures and
// membership-fingerprint anchoring are verified by the node-down store, and
// this layer treats it as opaque, delegating through the verifier seam. What
// THIS layer owns, and what these tests pin, is the committee arithmetic:
// the applied cancel set is exactly what the published chain names (never a
// privately known certificate), application is deterministic walk-skip
// arithmetic every verifier re-derives identically, and a reinstatement
// re-derives the roster as if the cancellation had never stood.

const KEY = 'cancelapp/master';
const GENERATION = 0;
const WALK_KEY = rosterOverlay.walkKeyFor(KEY, GENERATION);
const SIZE = 5;

function outpointOf(node) {
  return `${node.txhash}:${node.outidx}`;
}

function fleet(count) {
  return Array.from({ length: count }, (unused, i) => ({
    txhash: String(i + 1).padStart(2, '0').repeat(32),
    outidx: 0,
    pubkey: `pub-${i + 1}`,
    ip: `10.${i + 1}.0.1:16127`,
  }));
}

// The verifier seam, shaped as the node-down store will provide it: a
// certificate answers {valid, subject} after cold verification, a refutation
// answers whether the subject's alive announcement supersedes the cert. The
// token fields stand in for the store's own cryptography — the contract under
// test is that this layer believes NOTHING it did not delegate.
function certFor(node, issuedAt = 1_000) {
  return { subject: outpointOf(node), issuedAt, token: 'standing' };
}

function refutationFor(cert, broadcastedAt = 2_000) {
  return { subject: cert.subject, broadcastedAt, token: 'alive' };
}

const verifiers = {
  certificate: (cert) => (cert && cert.token === 'standing'
    ? { valid: true, subject: cert.subject }
    : { valid: false, subject: null }),
  refutation: (refutation, cert) => Boolean(
    refutation && refutation.token === 'alive'
    && refutation.subject === cert.subject
    && refutation.broadcastedAt >= cert.issuedAt,
  ),
};

describe('quorumGrant cancelOverlay', () => {
  const membership = fleet(12);
  const base = selectCommittee(membership, WALK_KEY, { size: SIZE });

  function cancelEntry(seq, node) {
    return {
      seq, cancel: outpointOf(node), cert: certFor(node), at: 1_000,
    };
  }

  function reinstateEntry(seq, node, cert) {
    return {
      seq, reinstate: outpointOf(node), refutation: refutationFor(cert), at: 2_000,
    };
  }

  describe('cancelChainWellFormed', () => {
    it('accepts cancel and reinstate entries, refuses malformed shapes before any verification', () => {
      const cancel = cancelEntry(1, base.members[0]);
      const reinstate = reinstateEntry(2, base.members[0], cancel.cert);
      expect(rosterOverlay.cancelChainWellFormed([cancel, reinstate])).to.equal(true);
      expect(rosterOverlay.cancelChainWellFormed([])).to.equal(true);

      expect(rosterOverlay.cancelChainWellFormed('chain')).to.equal(false);
      expect(rosterOverlay.cancelChainWellFormed([{ ...cancel, seq: 0 }])).to.equal(false);
      expect(rosterOverlay.cancelChainWellFormed([{ ...cancel, cancel: 'not-an-outpoint' }])).to.equal(false);
      expect(rosterOverlay.cancelChainWellFormed([{ ...cancel, cert: undefined }])).to.equal(false);
      expect(rosterOverlay.cancelChainWellFormed([{ ...reinstate, refutation: 'alive' }])).to.equal(false);
      // exactly one of cancel/reinstate — an entry claiming both means nothing
      expect(rosterOverlay.cancelChainWellFormed([
        { ...cancel, reinstate: cancel.cancel },
      ])).to.equal(false);
      expect(rosterOverlay.cancelChainWellFormed([{ seq: 1, at: 1_000 }])).to.equal(false);
      const long = Array.from({ length: 33 }, (unused, i) => cancelEntry(i + 1, base.members[0]));
      expect(rosterOverlay.cancelChainWellFormed(long)).to.equal(false);
    });
  });

  describe('verifyCancelChain', () => {
    it('yields exactly the set the chain names — a verified cancel stands, and nothing else does', () => {
      const target = base.members[1];
      const verified = rosterOverlay.verifyCancelChain(
        membership, [cancelEntry(1, target)], verifiers,
      );
      expect(verified).to.not.equal(null);
      expect([...verified.cancelled]).to.deep.equal([outpointOf(target)]);
    });

    it('refuses a certificate the verifier rejects, and one whose subject is not the named seat', () => {
      const target = base.members[0];
      const forged = { ...cancelEntry(1, target), cert: { ...certFor(target), token: 'revoked' } };
      expect(rosterOverlay.verifyCancelChain(membership, [forged], verifiers)).to.equal(null);

      const other = base.members[1];
      const misdirected = { ...cancelEntry(1, target), cert: certFor(other) };
      expect(rosterOverlay.verifyCancelChain(membership, [misdirected], verifiers)).to.equal(null);
    });

    it('refuses a subject outside the membership, out-of-order seqs, and a second cancel of a standing one', () => {
      const stranger = { txhash: 'ff'.repeat(32), outidx: 0, pubkey: 'pub-x', ip: '10.99.0.1:16127' };
      expect(rosterOverlay.verifyCancelChain(
        membership, [cancelEntry(1, stranger)], verifiers,
      )).to.equal(null);

      const target = base.members[0];
      expect(rosterOverlay.verifyCancelChain(
        membership, [cancelEntry(2, target)], verifiers,
      )).to.equal(null);

      expect(rosterOverlay.verifyCancelChain(
        membership, [cancelEntry(1, target), cancelEntry(2, target)], verifiers,
      )).to.equal(null);
    });

    it('a verified reinstatement lifts the cancellation; an unfounded or unverified one refuses the chain', () => {
      const target = base.members[2];
      const cancel = cancelEntry(1, target);
      const lifted = rosterOverlay.verifyCancelChain(
        membership, [cancel, reinstateEntry(2, target, cancel.cert)], verifiers,
      );
      expect(lifted).to.not.equal(null);
      expect(lifted.cancelled.size).to.equal(0);

      // reinstating a seat nothing cancelled is not a no-op, it is corruption
      expect(rosterOverlay.verifyCancelChain(
        membership, [reinstateEntry(1, target, certFor(target))], verifiers,
      )).to.equal(null);

      // an alive announcement older than the certificate lifts nothing
      const staleRefutation = {
        seq: 2,
        reinstate: outpointOf(target),
        refutation: { ...refutationFor(cancel.cert), broadcastedAt: cancel.cert.issuedAt - 1 },
        at: 2_000,
      };
      expect(rosterOverlay.verifyCancelChain(
        membership, [cancel, staleRefutation], verifiers,
      )).to.equal(null);
    });

    it('a trusted prefix skips certificate re-verification — the journaled entries were verified when first taught', () => {
      const target = base.members[0];
      const other = base.members[1];
      // the first entry's certificate is past the store's retention and no
      // longer cold-verifies; the second is fresh
      const aged = { ...cancelEntry(1, target), cert: { ...certFor(target), token: 'lapsed' } };
      const fresh = cancelEntry(2, other);

      expect(rosterOverlay.verifyCancelChain(membership, [aged, fresh], verifiers)).to.equal(null);

      const verified = rosterOverlay.verifyCancelChain(membership, [aged, fresh], verifiers, 1);
      expect(verified).to.not.equal(null);
      expect([...verified.cancelled].sort()).to.deep.equal(
        [outpointOf(target), outpointOf(other)].sort(),
      );

      // the trust reaches exactly the prefix: a bad entry past it still refuses
      const badFresh = { ...fresh, cert: { ...certFor(other), token: 'lapsed' } };
      expect(rosterOverlay.verifyCancelChain(membership, [aged, badFresh], verifiers, 1)).to.equal(null);
    });

    it('a re-cancellation after a reinstatement stands again', () => {
      const target = base.members[0];
      const first = cancelEntry(1, target);
      const chain = [
        first,
        reinstateEntry(2, target, first.cert),
        cancelEntry(3, target),
      ];
      const verified = rosterOverlay.verifyCancelChain(membership, chain, verifiers);
      expect(verified).to.not.equal(null);
      expect([...verified.cancelled]).to.deep.equal([outpointOf(target)]);
    });
  });

  describe('applyCancellations', () => {
    it('removes the cancelled seat and seats the walk\'s next eligible, deterministically', () => {
      const target = base.members[2];
      const cancelled = new Set([outpointOf(target)]);

      const first = rosterOverlay.applyCancellations(
        membership, WALK_KEY, base.members, new Set(), cancelled,
      );
      const second = rosterOverlay.applyCancellations(
        membership, WALK_KEY, base.members, new Set(), cancelled,
      );
      expect(first.members.map(outpointOf)).to.deep.equal(second.members.map(outpointOf));
      expect(first.members).to.have.length(SIZE);
      expect(first.members.map(outpointOf)).to.not.include(outpointOf(target));

      // the replacement is the same node tier-1's walk would have forced
      const survivors = base.members.filter((node) => node !== target);
      const expected = rosterOverlay.nextReplacement(
        membership, WALK_KEY, survivors, new Set([outpointOf(target)]),
      );
      expect(first.members.map(outpointOf)).to.include(outpointOf(expected));
    });

    it('never seats a cancelled node as a replacement, however well it ranks', () => {
      // cancel two seats: the replacement walk for the first must skip the
      // second's subject even where the ranking would seat it
      const [targetA, targetB] = [base.members[0], base.members[1]];
      const cancelled = new Set([outpointOf(targetA), outpointOf(targetB)]);
      const healed = rosterOverlay.applyCancellations(
        membership, WALK_KEY, base.members, new Set(), cancelled,
      );
      expect(healed.members.map(outpointOf)).to.not.include(outpointOf(targetA));
      expect(healed.members.map(outpointOf)).to.not.include(outpointOf(targetB));
      expect(healed.members).to.have.length(SIZE);
      // both replacements drawn from off the base committee, no collisions
      const owners = new Set(healed.members.map((node) => node.pubkey));
      const hosts = new Set(healed.members.map((node) => node.ip));
      expect(owners.size).to.equal(SIZE);
      expect(hosts.size).to.equal(SIZE);
    });

    it('respects seats already excluded by the tier-1 chain', () => {
      // a node the tier-1 chain removed must not return as a cancel replacement
      const target = base.members[3];
      const cancelled = new Set([outpointOf(target)]);
      const survivors = base.members.filter((node) => node !== target);
      const unconstrained = rosterOverlay.nextReplacement(
        membership, WALK_KEY, survivors, new Set([outpointOf(target)]),
      );

      const tierOneRemoved = new Set([outpointOf(unconstrained)]);
      const healed = rosterOverlay.applyCancellations(
        membership, WALK_KEY, base.members, tierOneRemoved, cancelled,
      );
      expect(healed.members.map(outpointOf)).to.not.include(outpointOf(unconstrained));
      expect(healed.members.map(outpointOf)).to.not.include(outpointOf(target));
      expect(healed.members).to.have.length(SIZE);
    });

    it('a cancellation of an unseated node seats nobody and changes nothing', () => {
      const offRoster = membership.find((node) => !base.members.includes(node));
      const healed = rosterOverlay.applyCancellations(
        membership, WALK_KEY, base.members, new Set(), new Set([outpointOf(offRoster)]),
      );
      expect(healed.members.map(outpointOf)).to.deep.equal(base.members.map(outpointOf));
    });

    it('shrinks the roster rather than refuse when no eligible replacement remains', () => {
      // membership so small the committee consumed it: nothing left to seat
      const tiny = membership.slice(0, SIZE);
      const committee = selectCommittee(tiny, WALK_KEY, { size: SIZE });
      const target = committee.members[0];
      const healed = rosterOverlay.applyCancellations(
        tiny, WALK_KEY, committee.members, new Set(), new Set([outpointOf(target)]),
      );
      expect(healed.members).to.have.length(SIZE - 1);
      expect(healed.members.map(outpointOf)).to.not.include(outpointOf(target));
    });

    it('processes the cancelled set in canonical order — the derivation is a function of the set, not of arrival order', () => {
      const [targetA, targetB] = [base.members[0], base.members[4]];
      const forward = rosterOverlay.applyCancellations(
        membership, WALK_KEY, base.members, new Set(),
        new Set([outpointOf(targetA), outpointOf(targetB)]),
      );
      const backward = rosterOverlay.applyCancellations(
        membership, WALK_KEY, base.members, new Set(),
        new Set([outpointOf(targetB), outpointOf(targetA)]),
      );
      expect(forward.members.map(outpointOf)).to.deep.equal(backward.members.map(outpointOf));
    });

    it('after a reinstatement the roster re-derives as if the cancellation never stood', () => {
      const target = base.members[1];
      const cancel = cancelEntry(1, target);
      const verified = rosterOverlay.verifyCancelChain(
        membership, [cancel, reinstateEntry(2, target, cancel.cert)], verifiers,
      );
      const healed = rosterOverlay.applyCancellations(
        membership, WALK_KEY, base.members, new Set(), verified.cancelled,
      );
      expect(healed.members.map(outpointOf)).to.deep.equal(base.members.map(outpointOf));
    });
  });

  describe('cancelledSubjects', () => {
    it('folds a pre-verified chain to the standing set, last event per subject winning', () => {
      const target = base.members[0];
      const other = base.members[1];
      const first = cancelEntry(1, target);
      const chain = [
        first,
        cancelEntry(2, other),
        reinstateEntry(3, target, first.cert),
      ];
      const standing = rosterOverlay.cancelledSubjects(chain);
      expect([...standing]).to.deep.equal([outpointOf(other)]);
      expect([...rosterOverlay.cancelledSubjects([])]).to.deep.equal([]);
      expect([...rosterOverlay.cancelledSubjects(undefined)]).to.deep.equal([]);
    });
  });

  describe('extendsCancelChain', () => {
    it('accepts an extension, refuses a fork and a truncation', () => {
      const target = base.members[0];
      const first = cancelEntry(1, target);
      const second = reinstateEntry(2, target, first.cert);

      expect(rosterOverlay.extendsCancelChain([first], [first, second])).to.equal(true);
      expect(rosterOverlay.extendsCancelChain([first], [first])).to.equal(true);
      expect(rosterOverlay.extendsCancelChain([first], [])).to.equal(false);

      const fork = [cancelEntry(1, base.members[1]), second];
      expect(rosterOverlay.extendsCancelChain([first], fork)).to.equal(false);
      // same seq, same subject, different KIND is still a fork
      const kindFork = [{
        seq: 1, reinstate: outpointOf(target), refutation: refutationFor(first.cert), at: 1_000,
      }];
      expect(rosterOverlay.extendsCancelChain([first], kindFork)).to.equal(false);
    });
  });
});
