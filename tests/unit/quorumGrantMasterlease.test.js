'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const dbHelper = require('../../ZelBack/src/services/dbHelper');
const messageStore = require('../../ZelBack/src/services/appMessaging/messageStore');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const fluxCommunicationMessagesSender = require('../../ZelBack/src/services/fluxCommunicationMessagesSender');
const masterleasePublisher = require('../../ZelBack/src/services/quorumGrant/masterleasePublisher');

// The published grant record on the app-state event plane: one row per app
// role, newer-wins on EPOCH, expiring with a held term and durable for a
// founding. The store's writes are captured rather than executed — what is
// asserted is the row identity, the comparator, and the expiry policy, which
// are exactly the three ways a published record could quietly become wrong.

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

    it('compares on epoch first, broadcast time only as the tiebreak', async () => {
      await messageStore.storeAppStateEvent('masterlease', {
        message: baseMessage({ epoch: 7 }), envelope: null, announcer: null,
      });
      const pipeline = updates[0].update;
      const condition = JSON.stringify(pipeline);
      expect(condition).to.contain('$data.epoch');
      expect(condition).to.contain('"$or"');
      // the incoming epoch sits in the comparator, not just the payload
      expect(JSON.stringify(pipeline[0].$set.data.$cond[0])).to.contain('7');
    });

    it('a held record expires with its term; a founding record never does', async () => {
      await messageStore.storeAppStateEvent('masterlease', {
        message: baseMessage(), envelope: null, announcer: null,
      });
      const heldSet = updates[0].update[0].$set;
      expect(heldSet.expireAt).to.be.an('object'); // conditional wrapper around the date

      await messageStore.storeAppStateEvent('masterlease', {
        message: baseMessage({ role: 'founder', mode: 'oneshot', ttlMs: undefined }),
        envelope: null,
        announcer: null,
      });
      const oneshotSet = updates[1].update[0].$set;
      expect(oneshotSet.expireAt).to.equal(undefined);
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

    it('the roster chain rides the broadcast when the holder carries one', async () => {
      const roster = { chain: [{ seq: 1, remove: 'x', add: 'y', acceptances: [] }] };
      await masterleasePublisher.publishMasterlease({
        key: 'myapp/master', grantee: 'a:0', epoch: 4, mode: 'held', ttlMs: 150_000, fingerprint: 'fp', roster,
      });
      const broadcast = fluxCommunicationMessagesSender.broadcastMessageToAll.firstCall.args[0];
      expect(broadcast.roster).to.equal(roster);

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
