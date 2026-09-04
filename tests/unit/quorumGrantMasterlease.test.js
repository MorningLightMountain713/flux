'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const dbHelper = require('../../ZelBack/src/services/dbHelper');
const messageStore = require('../../ZelBack/src/services/appMessaging/messageStore');
const fluxEventBus = require('../../ZelBack/src/services/utils/fluxEventBus');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const fluxCommunicationMessagesSender = require('../../ZelBack/src/services/fluxCommunicationMessagesSender');
const masterleasePublisher = require('../../ZelBack/src/services/quorumGrant/masterleasePublisher');
const networkStateService = require('../../ZelBack/src/services/networkStateService');
const signedEnvelope = require('../../ZelBack/src/services/quorumGrant/signedEnvelope');
const rosterOverlay = require('../../ZelBack/src/services/quorumGrant/rosterOverlay');
const { selectCommittee } = require('../../ZelBack/src/services/utils/committeeSelector');
const bs58check = require('bs58check');
const secp256k1 = require('secp256k1');

// The published grant record on the app-state event plane: one row per app
// role, newer-wins on GENERATION then EPOCH, expiring with a held term and
// durable for a founding. The store's writes are captured rather than
// executed — what is asserted is the row identity, the comparator, and the
// expiry policy, which are exactly the three ways a published record could
// quietly become wrong.

// A membership with real keys, the committee the walk deals for the key at a
// generation, and the term acceptances a quorum of it signs: the proof every
// held record carries. baseMessage() carries a quorum's proof for its own
// generation, epoch and grantee unless a test hands it something else.
const FP = 'd'.repeat(64);
const KEY = 'myapp/master';
const GRANTEE = `${'a'.repeat(64)}:0`;
const keys = new Map();
function keypair(i) {
  if (!keys.has(i)) {
    const priv = Buffer.alloc(32);
    priv.writeUInt32BE(i + 1, 28);
    keys.set(i, {
      wif: bs58check.encode(Buffer.concat([Buffer.from([0x80]), priv])),
      pubkey: Buffer.from(secp256k1.publicKeyCreate(priv, false)).toString('hex'),
    });
  }
  return keys.get(i);
}
const membership = Array.from({ length: 12 }, (unused, i) => ({
  txhash: String(i + 1).padStart(2, '0').repeat(32), outidx: 0, pubkey: keypair(i).pubkey, ip: `10.${i + 1}.0.1:16127`,
}));
const outpointOf = (node) => `${node.txhash}:${node.outidx}`;
const wifOf = new Map(membership.map((node, i) => [outpointOf(node), keypair(i).wif]));
const committeeAt = (generation) => selectCommittee(membership, rosterOverlay.walkKeyFor(KEY, generation), { size: 9 });
function acceptancesFrom(members, count, {
  grantee = GRANTEE, epoch = 3, generation = 0, wif,
} = {}) {
  return members.slice(0, count).map((node) => {
    const fields = signedEnvelope.fieldsFor('termaccept', {
      key: KEY, fingerprint: FP, generation, epoch, grantee,
    });
    return { grantor: outpointOf(node), signature: signedEnvelope.sign('termaccept', fields, wif ?? wifOf.get(outpointOf(node))).signature };
  });
}

function baseMessage(overrides = {}) {
  const message = {
    type: 'fluxmasterlease',
    version: 1,
    ip: '203.0.113.5:16127',
    appName: 'myapp',
    role: 'master',
    grantee: GRANTEE,
    epoch: 3,
    mode: 'held',
    fingerprint: FP,
    ttlMs: 150_000,
    broadcastedAt: 1_750_000_000_000,
    ...overrides,
  };
  if (!('acceptances' in overrides) && message.mode === 'held' && message.released !== true) {
    const committee = committeeAt(message.generation ?? 0);
    message.acceptances = acceptancesFrom(committee.members, committee.quorum, {
      grantee: message.grantee, epoch: message.epoch, generation: message.generation ?? 0,
    });
  }
  if ('acceptances' in overrides && overrides.acceptances === undefined) delete message.acceptances;
  return message;
}

describe('quorumGrant masterlease', () => {
  describe('the published row', () => {
    it('carries released only when the grant says so — an ordinal given back names its row free', async () => {
      const sent = [];
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('203.0.113.5:16127');
      sinon.stub(fluxCommunicationMessagesSender, 'broadcastMessageToAll').callsFake(async (message) => { sent.push(message); return null; });
      sinon.stub(messageStore, 'storeAppStateEvent').resolves();
      try {
        const base = {
          key: 'myapp/ordinal-0@500', grantee: `${'a'.repeat(64)}:0`, epoch: 2, mode: 'oneshot', fingerprint: 'd'.repeat(64), generation: 0,
        };
        await masterleasePublisher.publishMasterlease(base);
        await masterleasePublisher.publishMasterlease({ ...base, released: true });
        expect(sent).to.have.length(2);
        expect(sent[0]).to.not.have.property('released');
        expect(sent[1].released).to.equal(true);
        expect(sent[1]).to.deep.include({ role: 'ordinal-0@500', epoch: 2, mode: 'oneshot' });
      } finally {
        sinon.restore();
      }
    });
  });

  describe('the by-grantee read', () => {
    it('finds every record of one role prefix naming one grantee, across apps', async () => {
      const queries = [];
      const collection = {
        find: (filter, options) => {
          queries.push({ filter, options });
          return { toArray: async () => [] };
        },
      };
      sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({ collection: () => collection }) });
      try {
        const rows = await messageStore.getMasterleaseRecordsByGrantee('ordinal-', `${'a'.repeat(64)}:0`);
        expect(rows).to.deep.equal([]);
        expect(queries).to.have.length(1);
        expect(queries[0].filter.type).to.equal('masterlease');
        expect(queries[0].filter['data.grantee']).to.equal(`${'a'.repeat(64)}:0`);
        // the role prefix is matched inside the dedup key, after the app name
        expect(queries[0].filter.dedupKey.$regex).to.equal('^masterlease:[^/]+/ordinal-');
      } finally {
        sinon.restore();
      }
    });
  });

  describe('the stored record', () => {
    let updates;

    beforeEach(() => {
      updates = [];
      const collection = {
        updateOne: async (filter, update, options) => {
          updates.push({ filter, update, options });
          return { acknowledged: true };
        },
        findOne: async () => null,
      };
      sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({ collection: () => collection }) });
      // the membership every held record's proof is verified against
      sinon.stub(networkStateService, 'membershipAt').callsFake((fp) => (fp === FP ? membership : null));
    });

    afterEach(() => {
      sinon.restore();
    });

    it('keys one row per app role — no ip, so a successor REPLACES the deposed', async () => {
      await messageStore.storeAppStateEvent('masterlease', {
        message: baseMessage(), envelope: null, announcer: messageStore.LOCAL_ANNOUNCER,
      });
      expect(updates).to.have.length(1);
      expect(updates[0].filter).to.deep.equal({
        type: 'masterlease', dedupKey: 'masterlease:myapp/master',
      });
      expect(updates[0].options.upsert).to.equal(true);
    });

    it('a released record stores with its flag — an ordinal given back or vacated, same epoch, newer broadcast', async () => {
      await messageStore.storeAppStateEvent('masterlease', {
        message: baseMessage({
          role: 'ordinal-0@500', mode: 'oneshot', ttlMs: undefined, released: true,
        }),
        envelope: null,
        announcer: messageStore.LOCAL_ANNOUNCER,
      });
      expect(updates).to.have.length(1);
      const { data } = updates[0].update[0].$set;
      // the payload rides the comparator; the flag rides the payload
      expect(JSON.stringify(data)).to.contain('"released":true');
    });

    // The record's grantee is a CLAIM and its signer is a FACT: the envelope
    // binds the signer to the node listed at the record's ip, and nothing
    // else about the record is verified on arrival. Readers act on the
    // grantee — the reconciler's veto, the coordinator's primary intent, the
    // re-rolled seat's exemption — so a listed node publishing a lease that
    // names ANYONE would redirect all of them. A held or founding record
    // therefore stores only when it names its own announcer; a released row
    // is the one exception, because a vacate is published by whichever node
    // holds the certificate, about the node it removed.
    describe('the grantee is bound to the announcer', () => {
      const ANNOUNCER = { txhash: 'b'.repeat(64), outidx: 0, pubkey: 'pk-b', ip: '203.0.113.5:16127' };
      const SELF_NAMED = `${'b'.repeat(64)}:0`;

      it('a network record naming its announcer stores', async () => {
        await messageStore.storeAppStateEvent('masterlease', {
          message: baseMessage({ grantee: SELF_NAMED }), envelope: { pubKey: 'pk-b' }, announcer: ANNOUNCER,
        });
        expect(updates).to.have.length(1);
        expect(updates[0].update[0].$set.outpoint.$cond[1]).to.equal(SELF_NAMED);
      });

      it('a network record naming anyone else is dropped whole, and says so on the bus', async () => {
        const dropped = [];
        sinon.stub(fluxEventBus, 'publish').callsFake((name, payload) => { dropped.push({ name, payload }); });
        await messageStore.storeAppStateEvent('masterlease', {
          message: baseMessage(), envelope: { pubKey: 'pk-b' }, announcer: ANNOUNCER, // grantee aaaa…:0
        });
        expect(updates).to.have.length(0);
        expect(dropped).to.have.length(1);
        expect(dropped[0].name).to.equal('quorumGrant:masterleaseDropped');
        expect(dropped[0].payload).to.deep.include({
          appName: 'myapp', role: 'master', grantee: `${'a'.repeat(64)}:0`, announcer: SELF_NAMED,
        });
      });

      it('a founding record is bound the same way — the winner publishes itself', async () => {
        await messageStore.storeAppStateEvent('masterlease', {
          message: baseMessage({ role: 'founder', mode: 'oneshot', ttlMs: undefined }),
          envelope: { pubKey: 'pk-b' },
          announcer: ANNOUNCER,
        });
        expect(updates).to.have.length(0);
      });

      it('a released row may name a node other than its announcer — the certificate holder publishes the vacate', async () => {
        await messageStore.storeAppStateEvent('masterlease', {
          message: baseMessage({
            role: 'ordinal-0@500', mode: 'oneshot', ttlMs: undefined, released: true,
          }),
          envelope: { pubKey: 'pk-b' },
          announcer: ANNOUNCER,
        });
        expect(updates).to.have.length(1);
      });

      it('a record with no resolved announcer fails closed', async () => {
        await messageStore.storeAppStateEvent('masterlease', {
          message: baseMessage({ grantee: SELF_NAMED }), envelope: { pubKey: 'pk-b' }, announcer: null,
        });
        await messageStore.storeAppStateEvent('masterlease', {
          message: baseMessage({ grantee: SELF_NAMED }), envelope: { pubKey: 'pk-b' },
        });
        expect(updates).to.have.length(0);
      });

      it("this node's own publish stores whatever it names — it is not a network record", async () => {
        await messageStore.storeAppStateEvent('masterlease', {
          message: baseMessage(), envelope: null, announcer: messageStore.LOCAL_ANNOUNCER,
        });
        expect(updates).to.have.length(1);
        expect(updates[0].update[0].$set.outpoint.$cond[1]).to.equal(null);
      });
    });

    it('a record whose released flag is not a boolean is dropped whole', async () => {
      await messageStore.storeAppStateEvent('masterlease', {
        message: baseMessage({ role: 'ordinal-0@500', mode: 'oneshot', ttlMs: undefined, released: 'yes' }),
        envelope: null,
        announcer: messageStore.LOCAL_ANNOUNCER,
      });
      expect(updates).to.have.length(0);
    });

    it('compares generation ahead of epoch, broadcast time only as the full tiebreak', async () => {
      await messageStore.storeAppStateEvent('masterlease', {
        message: baseMessage({ epoch: 7, generation: 3 }), envelope: null, announcer: messageStore.LOCAL_ANNOUNCER,
      });
      const pipeline = updates[0].update;
      const condition = JSON.stringify(pipeline);
      expect(condition).to.contain('$data.generation');
      expect(condition).to.contain('$data.epoch');
      expect(condition).to.contain('"$or"');
      // every incoming ordinal sits in the comparator, not just the payload,
      // and the generation branch stands alone — ahead of the proof's rank
      // and of any epoch talk
      const branches = pipeline[0].$set.data.$cond[0].$or;
      expect(JSON.stringify(branches[0])).to.contain('$data.generation');
      expect(JSON.stringify(branches[0])).to.not.contain('$data.epoch');
      expect(JSON.stringify(branches[0])).to.contain('3');
      expect(JSON.stringify(branches[1])).to.contain('$data.verified');
      expect(JSON.stringify(branches[2])).to.contain('7');
    });

    it('a record without a generation compares as generation zero, never as brand new', async () => {
      await messageStore.storeAppStateEvent('masterlease', {
        message: baseMessage(), envelope: null, announcer: messageStore.LOCAL_ANNOUNCER,
      });
      const condition = JSON.stringify(updates[0].update);
      expect(condition).to.contain('"$ifNull":["$data.generation",0]');
    });

    // A held record's grantee is a claim; the granting committee's signed
    // term acceptances are the proof. Intake verifies a quorum of them
    // against the membership the record's fingerprint names, drops a record
    // that fails, and stores a record whose membership this node cannot
    // rebuild as UNVERIFIED, ranked below any verified one.
    describe('the proof a held record carries', () => {
      const stored = () => updates.map((u) => u.update[0].$set.data.$cond[1]);

      it('stores a held record a quorum of the granting committee signed, marked verified, ranked above an unverified one', async () => {
        const committee = committeeAt(0);
        await messageStore.storeAppStateEvent('masterlease', {
          message: baseMessage({ acceptances: acceptancesFrom(committee.members, committee.quorum) }),
          envelope: null,
          announcer: messageStore.LOCAL_ANNOUNCER,
        });
        expect(updates).to.have.length(1);
        expect(stored()[0].verified).to.equal(true);
        const branches = updates[0].update[0].$set.data.$cond[0].$or;
        expect(JSON.stringify(branches[0])).to.contain('$data.generation');
        expect(JSON.stringify(branches[1]), 'verified ranks right after generation').to.contain('$data.verified');
        expect(JSON.stringify(branches[1]), 'a verified record ranks 1').to.contain('"$gt":[1,{"$ifNull":["$data.verified",0]}]');
        expect(JSON.stringify(branches[1])).to.not.contain('$data.epoch');
        expect(JSON.stringify(branches[2])).to.contain('$data.epoch');
      });

      it('drops a held record below a quorum of acceptances', async () => {
        const committee = committeeAt(0);
        await messageStore.storeAppStateEvent('masterlease', {
          message: baseMessage({ acceptances: acceptancesFrom(committee.members, committee.quorum - 1) }),
          envelope: null,
          announcer: messageStore.LOCAL_ANNOUNCER,
        });
        expect(updates).to.have.length(0);
      });

      it('a duplicate signer counts once', async () => {
        const committee = committeeAt(0);
        const acceptances = acceptancesFrom(committee.members, committee.quorum - 1);
        acceptances.push({ ...acceptances[0] });
        await messageStore.storeAppStateEvent('masterlease', {
          message: baseMessage({ acceptances }), envelope: null, announcer: messageStore.LOCAL_ANNOUNCER,
        });
        expect(updates).to.have.length(0);
      });

      it('drops a record whose acceptances do not verify: a forged signature, a signer off the committee, a signature over another grantee', async () => {
        const committee = committeeAt(0);
        const strangers = membership.filter((node) => !committee.members.includes(node));
        const cases = [
          // one forged signature inside an otherwise exact quorum
          [...acceptancesFrom(committee.members, committee.quorum - 1), ...acceptancesFrom(committee.members.slice(committee.quorum - 1), 1, { wif: keypair(11).wif })],
          // a quorum, but the wrong committee: signers from the generation-1 walk that never granted this term
          acceptancesFrom([...strangers, ...committee.members.slice(0, committee.quorum - strangers.length)], committee.quorum),
          // signed for somebody else
          acceptancesFrom(committee.members, committee.quorum, { grantee: `${'e'.repeat(64)}:0` }),
          // signed over another epoch
          acceptancesFrom(committee.members, committee.quorum, { epoch: 2 }),
        ];
        await Promise.all(cases.map(async (acceptances) => messageStore.storeAppStateEvent('masterlease', {
          message: baseMessage({ acceptances }), envelope: null, announcer: messageStore.LOCAL_ANNOUNCER,
        })));
        expect(updates).to.have.length(0);
      });

      it('drops a held record with no acceptances or malformed ones, whole', async () => {
        const cases = [
          baseMessage({ acceptances: undefined }),
          baseMessage({ acceptances: null }),
          baseMessage({ acceptances: 'many' }),
          baseMessage({ acceptances: [{ grantor: 1, signature: 'x' }] }),
          baseMessage({ acceptances: [{ grantor: 'g' }] }),
        ];
        await Promise.all(cases.map(async (message) => messageStore.storeAppStateEvent('masterlease', {
          message, envelope: null, announcer: messageStore.LOCAL_ANNOUNCER,
        })));
        expect(updates).to.have.length(0);
      });

      it('verifies against the committee of the record\'s OWN generation', async () => {
        const committee = committeeAt(2);
        await messageStore.storeAppStateEvent('masterlease', {
          message: baseMessage({ generation: 2, acceptances: acceptancesFrom(committee.members, committee.quorum, { generation: 2 }) }),
          envelope: null,
          announcer: messageStore.LOCAL_ANNOUNCER,
        });
        expect(updates).to.have.length(1);
        expect(stored()[0].verified).to.equal(true);
      });

      it('stores a record whose membership this node cannot rebuild as unverified, never dropped', async () => {
        const committee = committeeAt(0);
        await messageStore.storeAppStateEvent('masterlease', {
          message: baseMessage({ fingerprint: 'e'.repeat(64), acceptances: acceptancesFrom(committee.members, committee.quorum) }),
          envelope: null,
          announcer: messageStore.LOCAL_ANNOUNCER,
        });
        expect(updates).to.have.length(1);
        expect(stored()[0].verified).to.equal(false);
        const branches = updates[0].update[0].$set.data.$cond[0].$or;
        expect(JSON.stringify(branches[1]), 'an unverified record ranks 0: it never replaces a verified one').to.contain('"$gt":[0,{"$ifNull":["$data.verified",0]}]');
      });

      it('a released record and a founding record need no acceptances', async () => {
        await messageStore.storeAppStateEvent('masterlease', {
          message: baseMessage({ released: true }), envelope: null, announcer: messageStore.LOCAL_ANNOUNCER,
        });
        await messageStore.storeAppStateEvent('masterlease', {
          message: baseMessage({ role: 'founder-abcdef0123456789@10', mode: 'oneshot', ttlMs: undefined }),
          envelope: null,
          announcer: messageStore.LOCAL_ANNOUNCER,
        });
        expect(updates).to.have.length(2);
      });

      it('a network record is bound to its announcer first, then proved', async () => {
        const committee = committeeAt(0);
        const announcer = { txhash: 'a'.repeat(64), outidx: 0 };
        await messageStore.storeAppStateEvent('masterlease', {
          message: baseMessage({ acceptances: acceptancesFrom(committee.members, committee.quorum) }),
          envelope: null,
          announcer,
        });
        expect(updates).to.have.length(1);
        expect(stored()[0].verified).to.equal(true);
        await messageStore.storeAppStateEvent('masterlease', {
          message: baseMessage({ acceptances: acceptancesFrom(committee.members, committee.quorum - 1) }),
          envelope: null,
          announcer,
        });
        expect(updates, 'below quorum drops for a network record too').to.have.length(1);
      });
    });

    it('no record carries an expiry — durable until superseded, held and founding alike', async () => {
      await messageStore.storeAppStateEvent('masterlease', {
        message: baseMessage(), envelope: null, announcer: messageStore.LOCAL_ANNOUNCER,
      });
      const heldSet = updates[0].update[0].$set;
      // A literal null on EVERY touch, never a conditional field: a
      // conditional slot keeps the stored value on a losing touch, so a row
      // carrying a Date would keep being reaped by the TTL index until a
      // strictly newer record happened to arrive. Boot sync re-delivers
      // these records, so every row is touched and cleared.
      expect(heldSet.expireAt).to.equal(null);

      await messageStore.storeAppStateEvent('masterlease', {
        message: baseMessage({ role: 'founder', mode: 'oneshot', ttlMs: undefined }),
        envelope: null,
        announcer: messageStore.LOCAL_ANNOUNCER,
      });
      const oneshotSet = updates[1].update[0].$set;
      expect(oneshotSet.expireAt).to.equal(null);
      expect(updates[1].filter.dedupKey).to.equal('masterlease:myapp/founder');
    });

    it('drops what it cannot vouch for, writing nothing', async () => {
      const garbage = [
        baseMessage({ epoch: 0 }),
        baseMessage({ epoch: 1.5 }),
        baseMessage({ mode: 'lease' }),
        baseMessage({ appName: undefined }),
        baseMessage({ grantee: undefined }),
        baseMessage({ mode: 'held', ttlMs: undefined }),
        baseMessage({ broadcastedAt: 'yesterday' }),
        baseMessage({ generation: -1 }),
        baseMessage({ generation: 1.5 }),
      ];
      await Promise.all(garbage.map(async (message) => messageStore.storeAppStateEvent('masterlease', {
        message, envelope: null, announcer: messageStore.LOCAL_ANNOUNCER,
      })));
      expect(updates).to.have.length(0);
    });

    it('a roster rides the record when its chain verifies — the healed committee\'s acceptances prove the term, the retired seat\'s no longer count — and sinks it when it does not hold its shape', async () => {
      const base = committeeAt(0);
      const walkKey = rosterOverlay.walkKeyFor(KEY, 0);
      const removed = base.members[0];
      const survivors = base.members.slice(1);
      const replacement = rosterOverlay.nextReplacement(membership, walkKey, survivors, new Set([outpointOf(removed)]));
      const rosterFields = signedEnvelope.fieldsFor('rosteraccept', {
        key: KEY, fingerprint: FP, generation: 0, seq: 1, remove: outpointOf(removed), add: outpointOf(replacement),
      });
      const entry = {
        seq: 1,
        remove: outpointOf(removed),
        add: outpointOf(replacement),
        at: 1_750_000_000_000,
        acceptances: base.members.slice(0, base.quorum).map((node) => ({
          grantor: outpointOf(node), signature: signedEnvelope.sign('rosteraccept', rosterFields, wifOf.get(outpointOf(node))).signature,
        })),
      };
      await messageStore.storeAppStateEvent('masterlease', {
        message: baseMessage({ roster: { chain: [entry] }, acceptances: acceptancesFrom([replacement, ...survivors], base.quorum) }),
        envelope: null,
        announcer: messageStore.LOCAL_ANNOUNCER,
      });
      expect(updates).to.have.length(1);
      expect(updates[0].update[0].$set.data.$cond[1].verified).to.equal(true);

      // a quorum that leans on the seat the chain removed is one short
      updates.splice(0);
      await messageStore.storeAppStateEvent('masterlease', {
        message: baseMessage({ roster: { chain: [entry] }, acceptances: acceptancesFrom([removed, ...survivors.slice(0, base.quorum - 1)], base.quorum) }),
        envelope: null,
        announcer: messageStore.LOCAL_ANNOUNCER,
      });
      expect(updates).to.have.length(0);

      const malformed = [
        baseMessage({ roster: null }),
        baseMessage({ roster: {} }),
        baseMessage({ roster: { chain: 'not-a-chain' } }),
        baseMessage({ roster: { chain: [{ seq: 1 }] } }),
      ];
      await Promise.all(malformed.map(async (message) => messageStore.storeAppStateEvent('masterlease', {
        message, envelope: null, announcer: messageStore.LOCAL_ANNOUNCER,
      })));
      expect(updates, 'a malformed roster sinks the record whole').to.have.length(0);
    });

    it('reads back by app and role', async () => {
      const row = { type: 'masterlease', data: baseMessage() };
      dbHelper.databaseConnection.returns({
        db: () => ({
          collection: () => ({
            findOne: async (filter) => {
              expect(filter.dedupKey).to.equal('masterlease:myapp/master');
              return row;
            },
          }),
        }),
      });
      const found = await messageStore.getMasterleaseRecord('myapp', 'master');
      expect(found).to.equal(row);
    });
  });

  describe('the publisher', () => {
    beforeEach(() => {
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('203.0.113.5:16127');
      sinon.stub(fluxCommunicationMessagesSender, 'broadcastMessageToAll').resolves({
        version: 1, timestamp: 123, pubKey: 'pk', signature: 'sig', data: {},
      });
      sinon.stub(messageStore, 'storeAppStateEvent').resolves();
    });

    afterEach(() => {
      sinon.restore();
    });

    it('splits the key, signs, broadcasts, and stores its own record first-party', async () => {
      const sent = await masterleasePublisher.publishMasterlease({
        key: 'myapp/master', grantee: 'a:0', epoch: 4, mode: 'held', fingerprint: 'fp', ttlMs: 150_000,
      });
      expect(sent).to.equal(true);

      const broadcast = fluxCommunicationMessagesSender.broadcastMessageToAll.firstCall.args[0];
      expect(broadcast.type).to.equal('fluxmasterlease');
      expect(broadcast.appName).to.equal('myapp');
      expect(broadcast.role).to.equal('master');
      expect(broadcast.epoch).to.equal(4);
      expect(broadcast.generation).to.equal(0);
      expect(broadcast.ttlMs).to.equal(150_000);
      expect(broadcast.ip).to.equal('203.0.113.5:16127');

      const [type, payload] = messageStore.storeAppStateEvent.firstCall.args;
      expect(type).to.equal('masterlease');
      expect(payload.message).to.equal(broadcast);
      expect(payload.envelope.signature).to.equal('sig');
    });

    it('a founding record carries no ttl at all', async () => {
      await masterleasePublisher.publishMasterlease({
        key: 'myapp/founder', grantee: 'a:0', epoch: 1, mode: 'oneshot', fingerprint: 'fp',
      });
      const broadcast = fluxCommunicationMessagesSender.broadcastMessageToAll.firstCall.args[0];
      expect(broadcast.role).to.equal('founder');
      expect(broadcast.ttlMs).to.equal(undefined);
    });

    it('a held record carries the referees\' signed acceptances the holder passes; a founding record carries none', async () => {
      const acceptances = [{ grantor: `${'b'.repeat(64)}:0`, signature: 'sig-b' }, { grantor: `${'c'.repeat(64)}:0`, signature: 'sig-c' }];
      await masterleasePublisher.publishMasterlease({
        key: 'myapp/master', grantee: 'a:0', epoch: 4, mode: 'held', fingerprint: 'fp', ttlMs: 150_000, acceptances,
      });
      expect(fluxCommunicationMessagesSender.broadcastMessageToAll.lastCall.args[0].acceptances).to.deep.equal(acceptances);
      await masterleasePublisher.publishMasterlease({
        key: 'myapp/founder', grantee: 'a:0', epoch: 1, mode: 'oneshot', fingerprint: 'fp', acceptances,
      });
      expect(fluxCommunicationMessagesSender.broadcastMessageToAll.lastCall.args[0].acceptances).to.equal(undefined);
    });

    it('the roster chain and the generation ride the broadcast when the holder carries them', async () => {
      const roster = { chain: [{ seq: 1, remove: 'x', add: 'y', acceptances: [] }] };
      await masterleasePublisher.publishMasterlease({
        key: 'myapp/master', grantee: 'a:0', epoch: 4, mode: 'held', ttlMs: 150_000, fingerprint: 'fp', generation: 5, roster,
      });
      const broadcast = fluxCommunicationMessagesSender.broadcastMessageToAll.firstCall.args[0];
      expect(broadcast.roster).to.equal(roster);
      expect(broadcast.generation).to.equal(5);

      await masterleasePublisher.publishMasterlease({
        key: 'myapp/master', grantee: 'a:0', epoch: 4, mode: 'held', ttlMs: 150_000, fingerprint: 'fp',
      });
      const bare = fluxCommunicationMessagesSender.broadcastMessageToAll.secondCall.args[0];
      expect(bare.roster).to.equal(undefined);
    });

    it('does not publish what it cannot address', async () => {
      fluxNetworkHelper.getLocalSocketAddress.resolves(null);
      const sent = await masterleasePublisher.publishMasterlease({
        key: 'myapp/master', grantee: 'a:0', epoch: 4, mode: 'held', fingerprint: 'fp', ttlMs: 150_000,
      });
      expect(sent).to.equal(false);
      expect(fluxCommunicationMessagesSender.broadcastMessageToAll.called).to.equal(false);
    });
  });
});
