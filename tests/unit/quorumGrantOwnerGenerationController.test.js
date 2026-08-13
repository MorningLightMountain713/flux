'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const verificationHelper = require('../../ZelBack/src/services/verificationHelper');
const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');
const fluxCommunicationMessagesSender = require('../../ZelBack/src/services/fluxCommunicationMessagesSender');
const messageStore = require('../../ZelBack/src/services/appMessaging/messageStore');
const ownerGenerationRecord = require('../../ZelBack/src/services/quorumGrant/ownerGenerationRecord');
const ownerGenerationController = require('../../ZelBack/src/services/quorumGrant/ownerGenerationController');

// The door: session-authorized, owner-signed, and contiguous at exactly
// stored+1 — with every refusal teaching what the next honest submission
// is. The record's inner signature is REAL in these tests: the door is the
// last stop before a broadcast the whole fleet will verify, so a stubbed
// verifier here would wave through exactly what the fleet would drop.

const OWNER_WIF = '5JTeg79dTLzzHXoJPALMWuoGDM8QmLj4n5f6MeFjx8dzsirvjAh';
const OWNER = '1KoXq8mLxpNt3BSnNLq2HzKC39Ne2pVJtF';

function signedRecord(overrides = {}) {
  const record = {
    appName: 'myapp',
    role: 'founder',
    generation: 1,
    height: 500_100,
    at: 1_750_000_000_000,
    ...overrides,
  };
  record.signature = verificationHelper.signMessage(ownerGenerationRecord.canonical(record), OWNER_WIF);
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
    sinon.stub(appsRepository, 'getGlobalAppOwner').resolves(OWNER);
    sinon.stub(messageStore, 'getGrantGenerationRecord').resolves(null);
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
      await ownerGenerationController.submit(fakeReq(signedRecord()), res);
      expect(res.statusCode).to.equal(200);
      expect(res.body.data).to.deep.equal({ appName: 'myapp', role: 'founder', generation: 1 });

      const broadcast = fluxCommunicationMessagesSender.broadcastMessageToAll.firstCall.args[0];
      expect(broadcast.type).to.equal('fluxgrantgeneration');
      expect(broadcast.generation).to.equal(1);
      expect(broadcast.signature).to.be.a('string');

      const [type, payload] = messageStore.storeAppStateEvent.firstCall.args;
      expect(type).to.equal('grantgeneration');
      expect(payload.message).to.equal(broadcast);
      expect(payload.envelope).to.deep.equal({
        version: 1, timestamp: 1_750_000_000_500, pubKey: 'pk', signature: 'envsig',
      });
    });

    it('accepts exactly stored+1 and refuses everything else, teaching the standing generation', async () => {
      messageStore.getGrantGenerationRecord.resolves({ data: { generation: 2 } });

      const replay = fakeRes();
      await ownerGenerationController.submit(fakeReq(signedRecord({ generation: 2 })), replay);
      expect(replay.statusCode).to.equal(409);
      expect(replay.body.data.message).to.contain('standing generation is 2');

      const skip = fakeRes();
      await ownerGenerationController.submit(fakeReq(signedRecord({ generation: 4 })), skip);
      expect(skip.statusCode).to.equal(409);
      expect(skip.body.data.message).to.contain('the next is 3');

      const next = fakeRes();
      await ownerGenerationController.submit(fakeReq(signedRecord({ generation: 3 })), next);
      expect(next.statusCode).to.equal(200);
      expect(fluxCommunicationMessagesSender.broadcastMessageToAll.calledOnce).to.equal(true);
    });

    it('refuses malformed records before any authority is consulted', async () => {
      const cases = [
        {},
        signedRecord({ generation: 0 }),
        signedRecord({ role: 'foun_der' }),
        { ...signedRecord(), signature: undefined },
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
      await ownerGenerationController.submit(fakeReq(signedRecord()), res);
      expect(res.statusCode).to.equal(401);
      expect(fluxCommunicationMessagesSender.broadcastMessageToAll.called).to.equal(false);
    });

    it('a session cannot smuggle a record the owner never signed', async () => {
      const record = signedRecord();
      record.height += 1;
      const res = fakeRes();
      await ownerGenerationController.submit(fakeReq(record), res);
      expect(res.statusCode).to.equal(403);
      expect(fluxCommunicationMessagesSender.broadcastMessageToAll.called).to.equal(false);

      appsRepository.getGlobalAppOwner.resolves(null);
      const orphan = fakeRes();
      await ownerGenerationController.submit(fakeReq(signedRecord()), orphan);
      expect(orphan.statusCode).to.equal(403);
    });
  });

  describe('the read surface', () => {
    it('answers the standing generation, 0 and no record when the owner never re-rolled', async () => {
      const req = fakeReq({});
      req.params = { appname: 'myapp', role: 'founder' };
      const res = fakeRes();
      await ownerGenerationController.current(req, res);
      expect(res.statusCode).to.equal(200);
      expect(res.body.data).to.deep.equal({
        appName: 'myapp', role: 'founder', generation: 0, record: null,
      });
    });

    it('answers the stored record when one stands', async () => {
      const data = {
        appName: 'myapp', role: 'founder', generation: 3, height: 500_200, at: 1,
      };
      messageStore.getGrantGenerationRecord.resolves({ data });
      const req = fakeReq({});
      req.params = { appname: 'myapp', role: 'founder' };
      const res = fakeRes();
      await ownerGenerationController.current(req, res);
      expect(res.body.data.generation).to.equal(3);
      expect(res.body.data.record).to.deep.equal(data);
    });

    it('refuses malformed names outright', async () => {
      const cases = [
        { appname: 'my|app', role: 'founder' },
        { appname: 'myapp', role: 'foun_der' },
        { appname: undefined, role: 'founder' },
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
