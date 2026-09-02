'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const dbHelper = require('../../ZelBack/src/services/dbHelper');
const messageStore = require('../../ZelBack/src/services/appMessaging/messageStore');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const fluxCommunicationMessagesSender = require('../../ZelBack/src/services/fluxCommunicationMessagesSender');
const masterleasePublisher = require('../../ZelBack/src/services/quorumGrant/masterleasePublisher');

// The published grant record on the app-state event plane: one row per app
// role, newer-wins on GENERATION then EPOCH, expiring with a held term and
// durable for a founding. The store's writes are captured rather than
// executed — what is asserted is the row identity, the comparator, and the
// expiry policy, which are exactly the three ways a published record could
// quietly become wrong.

function baseMessage(overrides = {}) {
  return {
    type: 'fluxmasterlease',
    version: 1,
    ip: '203.0.113.5:16127',
    appName: 'myapp',
    role: 'master',
    grantee: `${'a'.repeat(64)}:0`,
    epoch: 3,
    mode: 'held',
    fingerprint: 'd'.repeat(64),
    ttlMs: 150_000,
    broadcastedAt: 1_750_000_000_000,
    ...overrides,
  };
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
    });

    afterEach(() => {
      sinon.restore();
    });

    it('keys one row per app role — no ip, so a successor REPLACES the deposed', async () => {
      await messageStore.storeAppStateEvent('masterlease', {
        message: baseMessage(), envelope: null, announcer: null,
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
        announcer: null,
      });
      expect(updates).to.have.length(1);
      const { data } = updates[0].update[0].$set;
      // the payload rides the comparator; the flag rides the payload
      expect(JSON.stringify(data)).to.contain('"released":true');
    });

    it('a record whose released flag is not a boolean is dropped whole', async () => {
      await messageStore.storeAppStateEvent('masterlease', {
        message: baseMessage({ role: 'ordinal-0@500', mode: 'oneshot', ttlMs: undefined, released: 'yes' }),
        envelope: null,
        announcer: null,
      });
      expect(updates).to.have.length(0);
    });

    it('compares generation ahead of epoch, broadcast time only as the full tiebreak', async () => {
      await messageStore.storeAppStateEvent('masterlease', {
        message: baseMessage({ epoch: 7, generation: 3 }), envelope: null, announcer: null,
      });
      const pipeline = updates[0].update;
      const condition = JSON.stringify(pipeline);
      expect(condition).to.contain('$data.generation');
      expect(condition).to.contain('$data.epoch');
      expect(condition).to.contain('"$or"');
      // both incoming ordinals sit in the comparator, not just the payload,
      // and the generation branch stands alone — ahead of any epoch talk
      const branches = pipeline[0].$set.data.$cond[0].$or;
      expect(JSON.stringify(branches[0])).to.contain('$data.generation');
      expect(JSON.stringify(branches[0])).to.not.contain('$data.epoch');
      expect(JSON.stringify(branches[0])).to.contain('3');
      expect(JSON.stringify(branches[1])).to.contain('7');
    });

    it('a record without a generation compares as generation zero, never as brand new', async () => {
      await messageStore.storeAppStateEvent('masterlease', {
        message: baseMessage(), envelope: null, announcer: null,
      });
      const condition = JSON.stringify(updates[0].update);
      expect(condition).to.contain('"$ifNull":["$data.generation",0]');
    });

    it('no record carries an expiry — durable until superseded, held and founding alike', async () => {
      await messageStore.storeAppStateEvent('masterlease', {
        message: baseMessage(), envelope: null, announcer: null,
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
        announcer: null,
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
        message, envelope: null, announcer: null,
      })));
      expect(updates).to.have.length(0);
    });

    it('a roster rides the record when it holds its shape, and sinks it when it does not', async () => {
      const entry = {
        seq: 1,
        remove: `${'b'.repeat(64)}:0`,
        add: `${'c'.repeat(64)}:0`,
        at: 1_750_000_000_000,
        acceptances: [{ grantor: `${'d'.repeat(64)}:0`, signature: 'c2ln' }],
      };
      await messageStore.storeAppStateEvent('masterlease', {
        message: baseMessage({ roster: { chain: [entry] } }), envelope: null, announcer: null,
      });
      expect(updates).to.have.length(1);

      const malformed = [
        baseMessage({ roster: null }),
        baseMessage({ roster: {} }),
        baseMessage({ roster: { chain: 'not-a-chain' } }),
        baseMessage({ roster: { chain: [{ seq: 1 }] } }),
      ];
      await Promise.all(malformed.map(async (message) => messageStore.storeAppStateEvent('masterlease', {
        message, envelope: null, announcer: null,
      })));
      expect(updates).to.have.length(1);
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
