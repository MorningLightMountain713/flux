'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const dbHelper = require('../../ZelBack/src/services/dbHelper');
const grantRegister = require('../../ZelBack/src/services/quorumGrant/grantRegister');
const rosterOverlay = require('../../ZelBack/src/services/quorumGrant/rosterOverlay');
const { selectCommittee } = require('../../ZelBack/src/services/utils/committeeSelector');

// The shell's own obligations, distinct from the core's: refuse while
// draining, journal before replying, serialize per key, fail closed when the
// store cannot answer. The decision rules themselves are covered in
// quorumGrantRegisterCore.test.js and are exercised here only enough to prove
// the shell carries them faithfully.

const TTL = 60_000;

function servedAlready() {
  // a start stamp far enough in the past that the drain has fully run
  return process.hrtime.bigint() / 1_000_000n - 1_000_000n;
}

describe('quorumGrant grantRegister', () => {
  let store;
  let findDelayMs = 0;

  beforeEach(() => {
    store = new Map();
    findDelayMs = 0;
    grantRegister.resetForTests({ startedMs: servedAlready() });

    sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({ fake: true }) });
    sinon.stub(dbHelper, 'findOneInDatabase').callsFake(async (db, coll, query) => {
      if (findDelayMs > 0) {
        await new Promise((resolve) => { setTimeout(resolve, findDelayMs); });
      }
      const doc = store.get(query._id);
      return doc ? { ...doc, accepted: doc.accepted ? { ...doc.accepted } : null } : null;
    });
    sinon.stub(dbHelper, 'findOneAndUpdateInDatabase').callsFake(async (db, coll, query, update, options) => {
      expect(options.upsert, 'register writes must upsert').to.equal(true);
      expect(options.writeConcern, 'register writes must be journaled').to.deep.equal({ w: 1, j: true });
      const existing = store.get(query._id) ?? { _id: query._id };
      store.set(query._id, { ...existing, ...update.$set });
      return { value: store.get(query._id) };
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('the rejoin drain', () => {
    it('refuses everything but reads until one max TTL has run', async () => {
      grantRegister.resetForTests(); // as if the process just started
      const refused = await grantRegister.prepare('app/master', { epoch: 1, candidate: 'a:0' });
      expect(refused.code).to.equal('draining');
      expect(refused.retryAfterMs).to.be.greaterThan(0);
      expect(dbHelper.findOneAndUpdateInDatabase.called).to.equal(false);
    });

    it('reads are served during the drain — the journal contradicts nothing', async () => {
      store.set('app/master', { _id: 'app/master', promisedEpoch: 3, accepted: null });
      grantRegister.resetForTests();
      const doc = await grantRegister.read('app/master');
      expect(doc.promisedEpoch).to.equal(3);
    });

    it('serves once the drain has elapsed', async () => {
      const reply = await grantRegister.prepare('app/master', { epoch: 1, candidate: 'a:0' });
      expect(reply.ok).to.equal(true);
    });
  });

  describe('journal-before-reply', () => {
    it('a promise is persisted journaled before the reply exists', async () => {
      let persistedWhenReplying = null;
      dbHelper.findOneAndUpdateInDatabase.callsFake(async (db, coll, query, update, options) => {
        expect(options.writeConcern).to.deep.equal({ w: 1, j: true });
        await new Promise((resolve) => { setTimeout(resolve, 20); });
        store.set(query._id, { _id: query._id, ...update.$set });
        return { value: store.get(query._id) };
      });
      const replyPromise = grantRegister.prepare('app/master', { epoch: 2, candidate: 'a:0' }).then((reply) => {
        persistedWhenReplying = store.has('app/master');
        return reply;
      });
      const reply = await replyPromise;
      expect(reply.ok).to.equal(true);
      expect(persistedWhenReplying, 'the journal write must precede the reply').to.equal(true);
    });

    it('a probe decides but never writes', async () => {
      const reply = await grantRegister.probe('app/master', { epoch: 2, candidate: 'a:0' });
      expect(reply.ok).to.equal(true);
      expect(reply.probe).to.equal(true);
      expect(dbHelper.findOneAndUpdateInDatabase.called).to.equal(false);
    });
  });

  describe('failing closed', () => {
    it('no database connection: unavailable, not a guess', async () => {
      dbHelper.databaseConnection.returns(null);
      const reply = await grantRegister.prepare('app/master', { epoch: 1, candidate: 'a:0' });
      expect(reply.code).to.equal('unavailable');
    });

    it('a write that cannot reach the journal refuses rather than answers', async () => {
      dbHelper.findOneAndUpdateInDatabase.rejects(new Error('disk says no'));
      const reply = await grantRegister.prepare('app/master', { epoch: 1, candidate: 'a:0' });
      expect(reply.code).to.equal('unavailable');
    });

    it('one failed operation does not wedge the key', async () => {
      dbHelper.findOneAndUpdateInDatabase.onFirstCall().rejects(new Error('disk says no'));
      const failed = await grantRegister.prepare('app/master', { epoch: 1, candidate: 'a:0' });
      const retried = await grantRegister.prepare('app/master', { epoch: 1, candidate: 'a:0' });
      expect(failed.code).to.equal('unavailable');
      expect(retried.ok).to.equal(true);
    });
  });

  describe('per-key serialization', () => {
    it('two same-tick prepares cannot both win the same epoch', async () => {
      findDelayMs = 10; // widen the read-modify-write window
      const [first, second] = await Promise.all([
        grantRegister.prepare('app/master', { epoch: 5, candidate: 'a:0' }),
        grantRegister.prepare('app/master', { epoch: 5, candidate: 'b:0' }),
      ]);
      const winners = [first, second].filter((reply) => reply.ok);
      const losers = [first, second].filter((reply) => reply.code === 'superseded');
      expect(winners).to.have.length(1);
      expect(losers).to.have.length(1);
      expect(losers[0].promisedEpoch).to.equal(5);
    });

    it('different keys do not queue behind each other', async () => {
      findDelayMs = 10;
      const [a, b] = await Promise.all([
        grantRegister.prepare('app-a/master', { epoch: 1, candidate: 'a:0' }),
        grantRegister.prepare('app-b/master', { epoch: 1, candidate: 'b:0' }),
      ]);
      expect(a.ok).to.equal(true);
      expect(b.ok).to.equal(true);
    });
  });

  describe('the register through the shell', () => {
    it('carries a full held term: prepare, accept, renew, release', async () => {
      const prepared = await grantRegister.prepare('app/master', { epoch: 1, candidate: 'a:0' });
      expect(prepared.ok).to.equal(true);

      const accepted = await grantRegister.accept('app/master', {
        epoch: 1, grantee: 'a:0', mode: 'held', ttlMs: TTL, fingerprint: 'fp',
      });
      expect(accepted.ok).to.equal(true);
      expect(accepted.accepted.expiresAt).to.be.a('number');

      const renewed = await grantRegister.renew('app/master', { epoch: 1, grantee: 'a:0', ttlMs: TTL });
      expect(renewed.ok).to.equal(true);
      expect(renewed.accepted.expiresAt).to.be.at.least(accepted.accepted.expiresAt);

      const released = await grantRegister.release('app/master', { epoch: 1, grantee: 'a:0' });
      expect(released.ok).to.equal(true);

      const stored = store.get('app/master');
      expect(stored.accepted.released).to.equal(true);
    });

    it('a oneshot register is init-only across restarts of everything but the disk', async () => {
      await grantRegister.prepare('app/founder', { epoch: 1, candidate: 'f:1' });
      const founded = await grantRegister.accept('app/founder', {
        epoch: 1, grantee: 'f:1', mode: 'oneshot', fingerprint: 'fp-reg',
      });
      expect(founded.ok).to.equal(true);

      // a rival months later, at any epoch: the record answers, the write never lands
      const rival = await grantRegister.accept('app/founder', {
        epoch: 40, grantee: 'g:2', mode: 'oneshot',
      });
      expect(rival.code).to.equal('already_granted');
      expect(rival.accepted.grantee).to.equal('f:1');
      expect(store.get('app/founder').accepted.grantee).to.equal('f:1');
    });

    it('refuses a TTL beyond the cap, teaching the cap', async () => {
      await grantRegister.prepare('app/master', { epoch: 1, candidate: 'a:0' });
      const tooLong = await grantRegister.accept('app/master', {
        epoch: 1, grantee: 'a:0', mode: 'held', ttlMs: 10 * 60 * 60 * 1000,
      });
      expect(tooLong.code).to.equal('bad_ttl');
      expect(tooLong.maxTtlMs).to.be.a('number');

      const zero = await grantRegister.renew('app/master', { epoch: 1, grantee: 'a:0', ttlMs: 0 });
      expect(zero.code).to.equal('bad_ttl');
    });

    it('a roster change journals the chain beside the grant it heals', async () => {
      const membership = Array.from({ length: 8 }, (unused, i) => ({
        txhash: String(i + 1).padStart(2, '0').repeat(32),
        outidx: 0,
        pubkey: `owner-${i + 1}`,
        ip: `10.${i + 1}.0.1:16127`,
      }));
      const base = selectCommittee(membership, rosterOverlay.walkKeyFor('app/master', 0), { size: 5 });
      const remove = base.members[0];
      const survivors = base.members.filter((node) => node !== remove);
      const removedOutpoint = `${remove.txhash}:${remove.outidx}`;
      const added = rosterOverlay.nextReplacement(
        membership, rosterOverlay.walkKeyFor('app/master', 0), survivors, new Set([removedOutpoint]),
      );

      await grantRegister.prepare('app/master', { epoch: 1, candidate: 'a:0' });
      await grantRegister.accept('app/master', {
        epoch: 1, grantee: 'a:0', mode: 'held', ttlMs: TTL, fingerprint: 'fp',
      });
      const reply = await grantRegister.roster('app/master', {
        epoch: 1,
        candidate: 'a:0',
        remove: removedOutpoint,
        add: `${added.txhash}:${added.outidx}`,
        seq: 1,
        fingerprint: 'fp',
        at: 12345,
      }, { key: 'app/master', membership, committeeSize: 5 });

      expect(reply.ok).to.equal(true);
      const stored = store.get('app/master');
      expect(stored.roster.fingerprint).to.equal('fp');
      expect(stored.roster.chain).to.have.length(1);
      expect(stored.roster.chain[0].remove).to.equal(removedOutpoint);
    });
  });

  describe('the cancel journal', () => {
    const cancelEntry = (seq, subject) => ({
      seq, cancel: subject, cert: { subject, token: 'standing' }, at: 1_000,
    });
    const SUBJECT = `${'9'.repeat(64)}:0`;
    const OTHER = `${'8'.repeat(64)}:0`;

    it('journals a verified chain that extends the journal, durable like every decision', async () => {
      const adopted = await grantRegister.adoptCancels('app/master', {
        fingerprint: 'fp', generation: 0, chain: [cancelEntry(1, SUBJECT)],
      });
      expect(adopted).to.equal(true);
      expect(store.get('app/master').cancels.chain).to.have.length(1);

      const extended = await grantRegister.adoptCancels('app/master', {
        fingerprint: 'fp', generation: 0, chain: [cancelEntry(1, SUBJECT), cancelEntry(2, OTHER)],
      });
      expect(extended).to.equal(true);
      expect(store.get('app/master').cancels.chain).to.have.length(2);
    });

    it('refuses a fork and a chain no longer than the journal', async () => {
      await grantRegister.adoptCancels('app/master', {
        fingerprint: 'fp', generation: 0, chain: [cancelEntry(1, SUBJECT)],
      });

      const fork = await grantRegister.adoptCancels('app/master', {
        fingerprint: 'fp', generation: 0, chain: [cancelEntry(1, OTHER), cancelEntry(2, SUBJECT)],
      });
      expect(fork).to.equal(null);

      const shorter = await grantRegister.adoptCancels('app/master', {
        fingerprint: 'fp', generation: 0, chain: [cancelEntry(1, SUBJECT)],
      });
      expect(shorter).to.equal(null);
      expect(store.get('app/master').cancels.chain).to.have.length(1);
      expect(store.get('app/master').cancels.chain[0].cancel).to.equal(SUBJECT);
    });

    it('a new basis starts a fresh chain — the old world\'s cancellations do not carry', async () => {
      await grantRegister.adoptCancels('app/master', {
        fingerprint: 'fp', generation: 0, chain: [cancelEntry(1, SUBJECT)],
      });
      const rebased = await grantRegister.adoptCancels('app/master', {
        fingerprint: 'fp2', generation: 1, chain: [cancelEntry(1, OTHER)],
      });
      expect(rebased).to.equal(true);
      const stored = store.get('app/master').cancels;
      expect(stored.fingerprint).to.equal('fp2');
      expect(stored.chain).to.have.length(1);
      expect(stored.chain[0].cancel).to.equal(OTHER);
    });

    it('is served during the drain — taught state contradicts nothing', async () => {
      grantRegister.resetForTests(); // as if the process just started
      const adopted = await grantRegister.adoptCancels('app/master', {
        fingerprint: 'fp', generation: 0, chain: [cancelEntry(1, SUBJECT)],
      });
      expect(adopted).to.equal(true);
    });

    it('heldKeys names every held row and never a founder cell — write-once state cannot go stale', async () => {
      sinon.stub(dbHelper, 'findInDatabase').callsFake(
        async () => [...store.keys()].map((id) => ({ _id: id })),
      );
      store.set('app/master', { _id: 'app/master' });
      store.set('other/worker', { _id: 'other/worker' });
      store.set('app/founder-0123456789abcdef@500000@0', { _id: 'app/founder-0123456789abcdef@500000@0' });

      const keys = await grantRegister.heldKeys();
      expect(keys.sort()).to.deep.equal(['app/master', 'other/worker']);
    });

    it('an accept at a new basis clears the journaled chain through the shell', async () => {
      await grantRegister.adoptCancels('app/master', {
        fingerprint: 'fp', generation: 0, chain: [cancelEntry(1, SUBJECT)],
      });
      const reply = await grantRegister.accept('app/master', {
        epoch: 1, grantee: 'a:0', mode: 'held', ttlMs: TTL, fingerprint: 'fp2', generation: 0,
      });
      expect(reply.ok).to.equal(true);
      expect(store.get('app/master').cancels).to.equal(null);
    });
  });
});
