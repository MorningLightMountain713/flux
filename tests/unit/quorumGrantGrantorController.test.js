'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const fluxCommunicationUtils = require('../../ZelBack/src/services/fluxCommunicationUtils');
const generalService = require('../../ZelBack/src/services/generalService');
const registryManager = require('../../ZelBack/src/services/appDatabase/registryManager');
const grantRegister = require('../../ZelBack/src/services/quorumGrant/grantRegister');
const grantorController = require('../../ZelBack/src/services/quorumGrant/grantorController');
const signedEnvelope = require('../../ZelBack/src/services/quorumGrant/signedEnvelope');

// The controller's job is the gauntlet: identity, signature, committee
// membership, holdership. The register behind it is stubbed — its rules have
// their own suites — so every assertion here is about who gets THROUGH, not
// what they win. Signatures are real: the asker in these tests signs with the
// repo's fixture key, which is registered as its node pubkey in the fixture
// fleet, because a stubbed verifier would wave through exactly the forgeries
// this surface exists to stop.

const WIF = '5JTeg79dTLzzHXoJPALMWuoGDM8QmLj4n5f6MeFjx8dzsirvjAh';
const PUBKEY = '0474eb4690689bb408139249eda7f361b7881c4254ccbe303d3b4d58c2b48897d0f070b44944941998551f9ea0e1befd96f13adf171c07c885e62d0c2af56d3dab';

const ASKER_HOST = '203.0.113.5';
const ASKER_TXHASH = 'a'.repeat(64);
const ASKER = `${ASKER_TXHASH}:0`;

// Five distinct owners across five /16s: a 5-committee seats all of them, so
// committee membership is decided by whose collateral generalService reports.
function fixtureFleet() {
  const filler = [1, 2, 3, 4].map((i) => ({
    txhash: String(i).repeat(64).slice(0, 64),
    outidx: 0,
    pubkey: `owner-${i}`,
    ip: `10.${i}.0.1:16127`,
  }));
  return [
    {
      txhash: ASKER_TXHASH, outidx: 0, pubkey: PUBKEY, ip: `${ASKER_HOST}:16127`,
    },
    ...filler,
  ];
}

function signedAsk(type, overrides = {}) {
  const ask = {
    key: 'myapp/master',
    mode: 'held',
    epoch: 3,
    candidate: ASKER,
    ttlMs: 60_000,
    fingerprint: 'fp-1',
    at: Date.now(),
    ...overrides,
  };
  const { signature } = signedEnvelope.sign(type, signedEnvelope.fieldsFor(type, ask), WIF);
  return { ...ask, signature };
}

function fakeReq(body, host = ASKER_HOST) {
  return { body, socket: { remoteAddress: `::ffff:${host}` }, params: {}, query: {} };
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

describe('quorumGrant grantorController', () => {
  beforeEach(() => {
    grantorController.reset();

    sinon.stub(fluxCommunicationUtils, 'deterministicFluxList').resolves(fixtureFleet());
    sinon.stub(generalService, 'obtainNodeCollateralInformation').resolves({
      txhash: ASKER_TXHASH, txindex: 0,
    });
    sinon.stub(registryManager, 'appLocation').resolves([
      { ip: `${ASKER_HOST}:16127`, runningSince: Date.now() - 24 * 60 * 60 * 1000 },
      { ip: '10.1.0.1:16127', runningSince: Date.now() - 24 * 60 * 60 * 1000 },
    ]);
    sinon.stub(grantRegister, 'read').resolves(null);
    sinon.stub(grantRegister, 'probe').resolves({ ok: true, probe: true });
    sinon.stub(grantRegister, 'prepare').resolves({ ok: true, promised: true, promisedEpoch: 3 });
    sinon.stub(grantRegister, 'accept').resolves({ ok: true });
    sinon.stub(grantRegister, 'renew').resolves({ ok: true, renewed: true });
    sinon.stub(grantRegister, 'release').resolves({ ok: true, released: true });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('the happy paths', () => {
    it('a well-formed signed prepare reaches the register', async () => {
      const res = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare')), res);
      expect(res.statusCode).to.equal(200);
      expect(res.body.status).to.equal('success');
      expect(grantRegister.prepare.calledOnceWith('myapp/master', {
        epoch: 3, candidate: ASKER,
      })).to.equal(true);
    });

    it('accept carries mode, ttl, and fingerprint through', async () => {
      const res = fakeRes();
      await grantorController.accept(fakeReq(signedAsk('accept')), res);
      expect(res.statusCode).to.equal(200);
      expect(grantRegister.accept.calledOnceWith('myapp/master', {
        epoch: 3, grantee: ASKER, mode: 'held', ttlMs: 60_000, fingerprint: 'fp-1',
      })).to.equal(true);
    });

    it('renew and release reach the register as the grantee', async () => {
      await grantorController.renew(fakeReq(signedAsk('renew')), fakeRes());
      await grantorController.release(fakeReq(signedAsk('release')), fakeRes());
      expect(grantRegister.renew.calledOnce).to.equal(true);
      expect(grantRegister.release.calledOnce).to.equal(true);
    });
  });

  describe('shape and freshness', () => {
    it('refuses malformed keys, modes, epochs, and candidates', async () => {
      const cases = [
        signedAsk('prepare', { key: 'no-role' }),
        signedAsk('prepare', { key: 'app/UPPER' }),
        signedAsk('prepare', { mode: 'lease' }),
        signedAsk('prepare', { epoch: 0 }),
        signedAsk('prepare', { epoch: 1.5 }),
        signedAsk('prepare', { candidate: 'not-an-outpoint' }),
      ];
      const results = await Promise.all(cases.map(async (body) => {
        const res = fakeRes();
        await grantorController.prepare(fakeReq(body), res);
        return res.statusCode;
      }));
      expect(results).to.deep.equal([400, 400, 400, 400, 400, 400]);
    });

    it('refuses a stale ask — signatures do not age well', async () => {
      const res = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare', { at: Date.now() - 10 * 60 * 1000 })), res);
      expect(res.statusCode).to.equal(400);
      expect(res.body.data.message).to.contain('stale');
    });

    it('refuses a held accept without a ttl', async () => {
      const res = fakeRes();
      await grantorController.accept(fakeReq(signedAsk('accept', { ttlMs: undefined })), res);
      expect(res.statusCode).to.equal(400);
    });
  });

  describe('identity — who is asking', () => {
    it('refuses a candidate the list does not carry', async () => {
      const res = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare', { candidate: `${'b'.repeat(64)}:0` })), res);
      expect(res.statusCode).to.equal(403);
      expect(res.body.data.message).to.contain('not a listed node');
    });

    it('refuses an ask arriving from an address that is not the candidate', async () => {
      const res = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare'), '198.51.100.99'), res);
      expect(res.statusCode).to.equal(403);
      expect(res.body.data.message).to.contain('originate');
    });

    it('refuses a signature that does not verify against the registered key', async () => {
      const body = signedAsk('prepare');
      body.epoch = 4; // resign nothing: the signature now covers different fields
      const res = fakeRes();
      await grantorController.prepare(fakeReq(body), res);
      expect(res.statusCode).to.equal(403);
      expect(res.body.data.message).to.contain('signature');
    });

    it('refuses an unsigned ask outright', async () => {
      const body = signedAsk('prepare');
      delete body.signature;
      const res = fakeRes();
      await grantorController.prepare(fakeReq(body), res);
      expect(res.statusCode).to.equal(400);
    });
  });

  describe('committee membership — answering only for what this node is', () => {
    it('409 when this node does not sit on the committee for the key', async () => {
      generalService.obtainNodeCollateralInformation.resolves({
        txhash: 'f'.repeat(64), txindex: 7,
      });
      const res = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare')), res);
      expect(res.statusCode).to.equal(409);
      expect(grantRegister.prepare.called).to.equal(false);
    });
  });

  describe('holdership — the anti-squat rule', () => {
    it('refuses an asker that does not hold the app', async () => {
      registryManager.appLocation.resolves([]);
      const res = fakeRes();
      await grantorController.accept(fakeReq(signedAsk('accept', { mode: 'oneshot', ttlMs: undefined })), res);
      expect(res.statusCode).to.equal(403);
      expect(res.body.data.message).to.contain('holder');
      expect(grantRegister.accept.called).to.equal(false);
    });

    it('probe alone skips the holder check — reading costs nothing', async () => {
      registryManager.appLocation.resolves([]);
      const res = fakeRes();
      await grantorController.probe(fakeReq(signedAsk('probe')), res);
      expect(res.statusCode).to.equal(200);
      expect(grantRegister.probe.calledOnce).to.equal(true);
    });

    it('a young holder may not CHALLENGE an existing held record', async () => {
      grantRegister.read.resolves({ accepted: { epoch: 2, grantee: 'x:1', mode: 'held' } });
      registryManager.appLocation.resolves([
        { ip: `${ASKER_HOST}:16127`, runningSince: Date.now() - 60_000 },
      ]);
      const res = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare')), res);
      expect(res.statusCode).to.equal(403);
      expect(res.body.data.message).to.contain('young');
    });

    it('a young holder may make a FIRST acquisition — a fresh app seats its first master', async () => {
      registryManager.appLocation.resolves([
        { ip: `${ASKER_HOST}:16127`, runningSince: Date.now() - 60_000 },
      ]);
      const res = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare')), res);
      expect(res.statusCode).to.equal(200);
    });

    it('a young holder may found — the age floor is a held-challenge rule only', async () => {
      grantRegister.read.resolves({ accepted: { epoch: 1, grantee: 'x:1', mode: 'oneshot' } });
      registryManager.appLocation.resolves([
        { ip: `${ASKER_HOST}:16127`, runningSince: Date.now() - 60_000 },
      ]);
      const res = fakeRes();
      await grantorController.accept(fakeReq(signedAsk('accept', { mode: 'oneshot', ttlMs: undefined })), res);
      expect(res.statusCode).to.equal(200);
    });
  });

  describe('the peer ceiling', () => {
    it('cuts a peer off within the window and forgets nobody else', async () => {
      const ceiling = 600; // the config default
      const malformed = { key: 'nope' };
      const burst = Array.from({ length: ceiling }, () => grantorController.prepare(fakeReq(malformed), fakeRes()));
      await Promise.all(burst);

      const overflowRes = fakeRes();
      await grantorController.prepare(fakeReq(malformed), overflowRes);
      expect(overflowRes.statusCode).to.equal(429);

      const otherPeerRes = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare'), '10.1.0.1'), otherPeerRes);
      expect(otherPeerRes.statusCode).to.not.equal(429);
    });
  });

  describe('the record read', () => {
    it('answers the register state for a key', async () => {
      grantRegister.read.resolves({ promisedEpoch: 5, accepted: { epoch: 5, grantee: ASKER } });
      const req = fakeReq({});
      req.query.key = 'myapp/master';
      const res = fakeRes();
      await grantorController.record(req, res);
      expect(res.statusCode).to.equal(200);
      expect(res.body.data.promisedEpoch).to.equal(5);
      expect(res.body.data.accepted.grantee).to.equal(ASKER);
    });

    it('refuses a malformed key and answers emptiness honestly', async () => {
      const badReq = fakeReq({});
      badReq.query.key = '///';
      const badRes = fakeRes();
      await grantorController.record(badReq, badRes);
      expect(badRes.statusCode).to.equal(400);

      const emptyReq = fakeReq({});
      emptyReq.query.key = 'ghost/master';
      const emptyRes = fakeRes();
      await grantorController.record(emptyReq, emptyRes);
      expect(emptyRes.statusCode).to.equal(200);
      expect(emptyRes.body.data.promisedEpoch).to.equal(0);
      expect(emptyRes.body.data.accepted).to.equal(null);
    });
  });
});
