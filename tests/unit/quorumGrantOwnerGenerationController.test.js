'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const { stubRegistry, stubMessages } = require('./fixtures/appRecords');

const verificationHelper = require('../../ZelBack/src/services/verificationHelper');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const fluxCommunicationMessagesSender = require('../../ZelBack/src/services/fluxCommunicationMessagesSender');
const messageStore = require('../../ZelBack/src/services/appMessaging/messageStore');
const ownerGenerationRecord = require('../../ZelBack/src/services/quorumGrant/ownerGenerationRecord');
const appHistory = require('../../ZelBack/src/services/appDecisions/appHistory');
const ownerGenerationController = require('../../ZelBack/src/services/quorumGrant/ownerGenerationController');

// The door: session-authorized, owner-signed, and contiguous at exactly
// stored+1 — with every refusal teaching what the next honest submission
// is. The record's inner signature is REAL in these tests: the door is the
// last stop before a broadcast the whole fleet will verify, so a stubbed
// verifier here would wave through exactly what the fleet would drop.

const OWNER_WIF = '5JTeg79dTLzzHXoJPALMWuoGDM8QmLj4n5f6MeFjx8dzsirvjAh';
const OWNER = '1KoXq8mLxpNt3BSnNLq2HzKC39Ne2pVJtF';
// A v9 app's identity; the registry lists the app under another string, its name.
const IDENTITY = 'ab12cd34ef56';
const OWNED_FROM = 500_000;

async function signedRecord(overrides = {}) {
  const record = {
    identity: IDENTITY,
    role: 'founder',
    generation: 1,
    height: 500_100,
    at: 1_750_000_000_000,
    ownedFrom: OWNED_FROM,
    ...overrides,
  };
  record.signature = verificationHelper.signMessage(await ownerGenerationRecord.canonical(record), OWNER_WIF);
  return record;
}

function fakeReq(body) {
  return { body, params: {}, query: {}, headers: {} };
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
}

describe('quorumGrant ownerGenerationController', () => {
  beforeEach(() => {
    sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
    sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('203.0.113.5:16127');
    stubRegistry().byIdentity.callsFake(async (identity) => (identity === IDENTITY ? { name: 'myapp', owner: OWNER } : null));
    stubMessages();
    sinon.stub(messageStore, 'standingGeneration').resolves({ record: null, aside: false });
    sinon.stub(messageStore, 'getGrantGenerationRecord').resolves(null);
    sinon.stub(messageStore, 'heldGenerationRecords').resolves([]);
    sinon.stub(appHistory, 'ownerships').resolves([{ owner: OWNER, from: OWNED_FROM }]);
    sinon.stub(messageStore, 'getMasterleaseRecord').resolves(null);
    sinon.stub(messageStore, 'storeAppStateEvent').resolves();
    sinon.stub(fluxCommunicationMessagesSender, 'broadcastMessageToAll').resolves({
      version: 1, timestamp: 1_750_000_000_500, pubKey: 'pk', signature: 'envsig',
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('submission', () => {
    it('a first-generation record broadcasts and stores, envelope and all', async () => {
      const res = fakeRes();
      await ownerGenerationController.submit(fakeReq(await signedRecord()), res);
      expect(res.statusCode).to.equal(200);
      expect(res.body.data).to.deep.equal({ identity: IDENTITY, role: 'founder', generation: 1 });

      const broadcast = fluxCommunicationMessagesSender.broadcastMessageToAll.firstCall.args[0];
      expect(broadcast.type).to.equal('fluxgrantgeneration');
      expect(broadcast.ip, 'receivers resolve the announcer by ip').to.equal('203.0.113.5:16127');
      expect(broadcast.generation).to.equal(1);
      expect(broadcast.ownedFrom).to.equal(OWNED_FROM);
      expect(broadcast.signature).to.be.a('string');

      const [type, payload] = messageStore.storeAppStateEvent.firstCall.args;
      expect(type).to.equal('grantgeneration');
      expect(payload.message).to.equal(broadcast);
      expect(payload.envelope).to.deep.equal({
        version: 1, timestamp: 1_750_000_000_500, pubKey: 'pk', signature: 'envsig',
      });
    });

    it('accepts exactly stored+1 and refuses everything else, teaching the standing generation', async () => {
      messageStore.standingGeneration.resolves({ record: { data: { generation: 2, ownedFrom: OWNED_FROM } }, aside: false });

      const replay = fakeRes();
      await ownerGenerationController.submit(fakeReq(await signedRecord({ generation: 2 })), replay);
      expect(replay.statusCode).to.equal(409);
      expect(replay.body.data.message).to.contain('under this ownership is 2');

      const skip = fakeRes();
      await ownerGenerationController.submit(fakeReq(await signedRecord({ generation: 4 })), skip);
      expect(skip.statusCode).to.equal(409);
      expect(skip.body.data.message).to.contain('the next is 3');

      const next = fakeRes();
      await ownerGenerationController.submit(fakeReq(await signedRecord({ generation: 3 })), next);
      expect(next.statusCode).to.equal(200);
      expect(fluxCommunicationMessagesSender.broadcastMessageToAll.calledOnce).to.equal(true);
    });

    it('refuses a record whose ownership height is not the one the listed owner took the app at', async () => {
      const res = fakeRes();
      await ownerGenerationController.submit(fakeReq(await signedRecord({ ownedFrom: OWNED_FROM + 1 })), res);
      expect(res.statusCode).to.equal(409);
      expect(res.body.data.message).to.contain(`took the app at ${OWNED_FROM}`);
      expect(fluxCommunicationMessagesSender.broadcastMessageToAll.called).to.equal(false);
    });

    it('counts generations within one ownership: the first record a new owner signs is 1, whatever the seller signed', async () => {
      messageStore.standingGeneration.resolves({ record: { data: { generation: 7, ownedFrom: OWNED_FROM - 100 } }, aside: false });
      const res = fakeRes();
      await ownerGenerationController.submit(fakeReq(await signedRecord({ generation: 1 })), res);
      expect(res.statusCode).to.equal(200);
      const second = fakeRes();
      await ownerGenerationController.submit(fakeReq(await signedRecord({ generation: 8 })), second);
      expect(second.statusCode).to.equal(409);
    });

    // R16: while a transfer of the app waits for payment on this node, the
    // owner may not re-roll.
    it('refuses a re-roll while a transfer of the app waits for payment on this node, naming the rule', async () => {
      sinon.stub(messageStore, 'waitingTransfer').resolves({ hash: 'a'.repeat(64) });
      const res = fakeRes();
      await ownerGenerationController.submit(fakeReq(await signedRecord()), res);
      expect(res.statusCode).to.equal(409);
      expect(res.body.data.message).to.match(/transfer of the app waits for payment.*R16/);
      sinon.assert.calledWith(messageStore.waitingTransfer, 'myapp', OWNER);
      sinon.assert.notCalled(fluxCommunicationMessagesSender.broadcastMessageToAll);
      sinon.assert.notCalled(messageStore.storeAppStateEvent);
    });

    it('refuses malformed records before any authority is consulted', async () => {
      const cases = [
        {},
        await signedRecord({ generation: 0 }),
        await signedRecord({ role: 'foun_der' }),
        { ...(await signedRecord()), signature: undefined },
      ];
      const results = await Promise.all(cases.map(async (body) => {
        const res = fakeRes();
        await ownerGenerationController.submit(fakeReq(body), res);
        return res.statusCode;
      }));
      expect(results).to.deep.equal([400, 400, 400, 400]);
      expect(verificationHelper.verifyPrivilege.called).to.equal(false);
    });

    it('an unauthorized session submits nothing', async () => {
      verificationHelper.verifyPrivilege.resolves(false);
      const res = fakeRes();
      await ownerGenerationController.submit(fakeReq(await signedRecord()), res);
      expect(res.statusCode).to.equal(401);
      expect(fluxCommunicationMessagesSender.broadcastMessageToAll.called).to.equal(false);
    });

    it('a session cannot smuggle a record the owner never signed', async () => {
      const record = await signedRecord();
      record.height += 1;
      const res = fakeRes();
      await ownerGenerationController.submit(fakeReq(record), res);
      expect(res.statusCode).to.equal(403);
      expect(fluxCommunicationMessagesSender.broadcastMessageToAll.called).to.equal(false);

    });

    it('refuses a record for an app the registry does not list, before any authority is consulted', async () => {
      const res = fakeRes();
      await ownerGenerationController.submit(fakeReq(await signedRecord({ identity: 'ffffffffffff' })), res);
      expect(res.statusCode).to.equal(404);
      expect(verificationHelper.verifyPrivilege.called).to.equal(false);
      expect(fluxCommunicationMessagesSender.broadcastMessageToAll.called).to.equal(false);
    });

    it('asks the session for the privilege over the app the identity names', async () => {
      await ownerGenerationController.submit(fakeReq(await signedRecord()), fakeRes());
      sinon.assert.calledWithMatch(verificationHelper.verifyPrivilege, sinon.match.any, sinon.match.any, { appName: 'myapp' });
    });
  });

  // A re-roll lands under a live held term: the running master steps across
  // to the re-rolled committee on its credential (STEP_ACROSS_DESIGN.md).
  describe('a live term', () => {
    it('does not refuse a re-roll', async () => {
      messageStore.getMasterleaseRecord.resolves({
        data: {
          grantee: `${'2'.repeat(64)}:0`, mode: 'held', ttlMs: 150_000, broadcastedAt: Date.now() - 5000,
        },
      });
      const res = fakeRes();
      await ownerGenerationController.submit(fakeReq(await signedRecord()), res);
      expect(res.statusCode).to.equal(200);
      expect(fluxCommunicationMessagesSender.broadcastMessageToAll.calledOnce).to.equal(true);
    });
  });

  describe('the read surface', () => {
    it('answers the standing generation, 0 and no record when the owner never re-rolled', async () => {
      const req = fakeReq({});
      req.params = { identity: IDENTITY, role: 'founder' };
      const res = fakeRes();
      await ownerGenerationController.current(req, res);
      expect(res.statusCode).to.equal(200);
      expect(res.body.data).to.deep.equal({
        identity: IDENTITY, role: 'founder', generation: 0, record: null, records: [],
      });
    });

    it('answers every record held beside the standing one, so a node asked at its row write keeps what it lacks', async () => {
      messageStore.getGrantGenerationRecord.resolves({ data: { generation: 2 } });
      messageStore.heldGenerationRecords.resolves([{ data: { generation: 1 } }, { data: { generation: 2 } }]);
      const res = fakeRes();
      await ownerGenerationController.current({ params: { identity: IDENTITY, role: 'master' }, query: {} }, res);
      expect(res.statusCode).to.equal(200);
      expect(res.body.data.records).to.deep.equal([{ generation: 1 }, { generation: 2 }]);
      sinon.assert.calledWith(messageStore.heldGenerationRecords, IDENTITY, 'master');
    });

    it('answers the stored record when one stands', async () => {
      const data = {
        identity: IDENTITY, role: 'founder', generation: 3, height: 500_200, at: 1,
      };
      messageStore.getGrantGenerationRecord.resolves({ data });
      const req = fakeReq({});
      req.params = { identity: IDENTITY, role: 'founder' };
      const res = fakeRes();
      await ownerGenerationController.current(req, res);
      expect(res.body.data.generation).to.equal(3);
      expect(res.body.data.record).to.deep.equal(data);
    });

    it('refuses malformed identities and roles outright', async () => {
      const cases = [
        { identity: 'my|app', role: 'founder' },
        { identity: IDENTITY, role: 'foun_der' },
        { identity: undefined, role: 'founder' },
      ];
      const results = await Promise.all(cases.map(async (params) => {
        const req = fakeReq({});
        req.params = params;
        const res = fakeRes();
        await ownerGenerationController.current(req, res);
        return res.statusCode;
      }));
      expect(results).to.deep.equal([400, 400, 400]);
    });
  });
});
