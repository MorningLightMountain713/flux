'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const secp256k1 = require('secp256k1');
const bs58check = require('bs58check');

const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const daemonServiceMiscRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceMiscRpcs');
const fluxCommunicationUtils = require('../../ZelBack/src/services/fluxCommunicationUtils');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const networkStateService = require('../../ZelBack/src/services/networkStateService');
const generalService = require('../../ZelBack/src/services/generalService');
const registryManager = require('../../ZelBack/src/services/appDatabase/registryManager');
const messageStore = require('../../ZelBack/src/services/appMessaging/messageStore');
const foundingCommittee = require('../../ZelBack/src/services/appMesh/foundingCommittee');

const FOUNDER_KEY = `myapp/founder-${foundingCommittee.founderToken('myapp', 'db')}@500000`;
const grantRegister = require('../../ZelBack/src/services/quorumGrant/grantRegister');
const downCertificates = require('../../ZelBack/src/services/quorumGrant/downCertificates');
const grantorController = require('../../ZelBack/src/services/quorumGrant/grantorController');
const signedEnvelope = require('../../ZelBack/src/services/quorumGrant/signedEnvelope');
const rosterOverlay = require('../../ZelBack/src/services/quorumGrant/rosterOverlay');
const { selectCommittee } = require('../../ZelBack/src/services/utils/committeeSelector');

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
const FINGERPRINT = 'c'.repeat(64);

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
    generation: 0,
    fingerprint: FINGERPRINT,
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
    sinon.stub(networkStateService, 'membershipAt').returns(fixtureFleet());
    sinon.stub(generalService, 'obtainNodeCollateralInformation').resolves({
      txhash: ASKER_TXHASH, txindex: 0,
    });
    sinon.stub(registryManager, 'appLocation').resolves([
      { ip: `${ASKER_HOST}:16127`, runningSince: Date.now() - 24 * 60 * 60 * 1000 },
      { ip: '10.1.0.1:16127', runningSince: Date.now() - 24 * 60 * 60 * 1000 },
    ]);
    sinon.stub(messageStore, 'getGrantGenerationRecord').resolves(null);
    sinon.stub(foundingCommittee, 'selfOnFoundingCommittee').resolves({
      member: true, reason: null, quorum: 5,
    });
    sinon.stub(grantRegister, 'read').resolves(null);
    sinon.stub(grantRegister, 'probe').resolves({ ok: true, probe: true });
    sinon.stub(grantRegister, 'prepare').resolves({ ok: true, promised: true, promisedEpoch: 3 });
    sinon.stub(grantRegister, 'accept').resolves({ ok: true });
    sinon.stub(grantRegister, 'renew').resolves({ ok: true, renewed: true });
    sinon.stub(grantRegister, 'roster').resolves({
      ok: true, seq: 1, remove: `${'1'.repeat(64)}:0`, add: `${'6'.repeat(64)}:0`,
    });
    sinon.stub(grantRegister, 'release').resolves({ ok: true, released: true });
    sinon.stub(fluxNetworkHelper, 'getFluxNodePrivateKey').resolves(WIF);
    sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
      status: 'success', data: { synced: true, height: 100, header: 100 },
    });
    // the boot-sync gate is fail-closed until the service wiring registers
    // the orchestrator's live state; these tests run with it open
    grantorController.registerSyncReadyProvider(() => true);
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

    it('accept carries mode, ttl, generation, and fingerprint through', async () => {
      const res = fakeRes();
      await grantorController.accept(fakeReq(signedAsk('accept')), res);
      expect(res.statusCode).to.equal(200);
      expect(grantRegister.accept.calledOnceWith('myapp/master', {
        epoch: 3, grantee: ASKER, mode: 'held', ttlMs: 60_000, generation: 0, fingerprint: FINGERPRINT,
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
        signedAsk('prepare', { key: 'app/under_score' }),
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

    it('serves a renew carried by another listed node — the one carrier-independent ask', async () => {
      const res = fakeRes();
      await grantorController.renew(fakeReq(signedAsk('renew'), '10.2.0.1'), res);
      expect(res.statusCode).to.equal(200);
      expect(grantRegister.renew.calledOnce).to.equal(true);
    });

    it('refuses a renew carried by an address the list does not carry', async () => {
      const res = fakeRes();
      await grantorController.renew(fakeReq(signedAsk('renew'), '198.51.100.99'), res);
      expect(res.statusCode).to.equal(403);
      expect(res.body.data.message).to.contain('caller is not a listed node');
      expect(grantRegister.renew.called).to.equal(false);
    });

    it('a carried prepare stays refused — only renew is carrier-independent', async () => {
      const res = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare'), '10.2.0.1'), res);
      expect(res.statusCode).to.equal(403);
      expect(res.body.data.message).to.contain('originate');
      expect(grantRegister.prepare.called).to.equal(false);
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

    it('the committee is computed against the membership the ask NAMES', async () => {
      const res = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare')), res);
      expect(networkStateService.membershipAt.calledOnceWith(FINGERPRINT)).to.equal(true);
    });

    it('409 unknown fingerprint — never a substitution of the current list', async () => {
      networkStateService.membershipAt.returns(null);
      const res = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare')), res);
      expect(res.statusCode).to.equal(409);
      expect(res.body.data.message).to.contain('fingerprint');
      expect(grantRegister.prepare.called).to.equal(false);
    });

    it('409 when the ask names a retired generation, teaching the current one', async () => {
      messageStore.getGrantGenerationRecord.resolves({ data: { generation: 2 } });
      const res = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare')), res);
      expect(res.statusCode).to.equal(409);
      expect(res.body.data.message).to.contain('current is 2');
      expect(grantRegister.prepare.called).to.equal(false);
    });

    it('refuses an ask without a well-formed fingerprint outright', async () => {
      const res = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare', { fingerprint: 'fp-1' })), res);
      expect(res.statusCode).to.equal(400);
    });
  });

  describe('the ordinal plane — write-once rows that reopen', () => {
    // An ordinal register is a founder-shaped oneshot row on the app's
    // founding committee, keyed `ordinal-<n>@<rung>`, with two exits a
    // founder row never has: release by the holder and vacate by a node-down
    // certificate (formal/ordinal-register/RESULTS.md).
    const ORDINAL_KEY = 'myapp/ordinal-0@500000';

    it('an ordinal ask consults the founding committee at its rung, component-blind', async () => {
      const res = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare', { mode: 'oneshot', key: ORDINAL_KEY })), res);
      expect(res.statusCode).to.equal(200);
      expect(foundingCommittee.selfOnFoundingCommittee.calledOnceWith('myapp', 500000, FINGERPRINT, 0)).to.equal(true);
      expect(grantRegister.prepare.firstCall.args[0]).to.equal(`${ORDINAL_KEY}@0`);
    });

    it('release of an ordinal row reaches the register row with the oneshot permission', async () => {
      const res = fakeRes();
      await grantorController.release(fakeReq(signedAsk('release', { key: ORDINAL_KEY, generation: 0 })), res);
      expect(res.statusCode).to.equal(200);
      const [row, request] = grantRegister.release.firstCall.args;
      expect(row).to.equal(`${ORDINAL_KEY}@0`);
      expect(request.allowOneshot).to.equal(true);
      expect(request.grantee).to.equal(ASKER);
    });

    it('release of a founder row carries no such permission — founder rows never reopen', async () => {
      const res = fakeRes();
      await grantorController.release(fakeReq(signedAsk('release', { key: FOUNDER_KEY, generation: 0 })), res);
      expect(res.statusCode).to.equal(200);
      const [row, request] = grantRegister.release.firstCall.args;
      expect(row).to.equal(`${FOUNDER_KEY}@0`);
      expect(request.allowOneshot).to.equal(undefined);
    });

    it('release of a held key is unchanged: the key itself, no permission', async () => {
      const res = fakeRes();
      await grantorController.release(fakeReq(signedAsk('release')), res);
      expect(res.statusCode).to.equal(200);
      const [row, request] = grantRegister.release.firstCall.args;
      expect(row).to.equal('myapp/master');
      expect(request.allowOneshot).to.equal(undefined);
    });

    describe('vacate — reclaim by certificate', () => {
      const HOLDER = `${'7'.repeat(64)}:0`;

      beforeEach(() => {
        sinon.stub(grantRegister, 'vacate').resolves({ ok: true, vacated: true });
        downCertificates.registerProvider({
          standingCertificateFor: async () => null,
          refutationFor: async () => null,
          verifyCertificate: (cert) => ({ valid: cert?.token === 'standing', subject: cert?.subject ?? null }),
          verifyRefutation: () => false,
        });
      });

      afterEach(() => {
        downCertificates.resetForTests();
      });

      it('a verified certificate vacates the row for its subject', async () => {
        const res = fakeRes();
        const ask = signedAsk('vacate', { key: ORDINAL_KEY, generation: 0, cert: { token: 'standing', subject: HOLDER } });
        await grantorController.vacate(fakeReq(ask), res);
        expect(res.statusCode).to.equal(200);
        expect(res.body.data).to.deep.equal({ ok: true, vacated: true });
        const [row, request] = grantRegister.vacate.firstCall.args;
        expect(row).to.equal(`${ORDINAL_KEY}@0`);
        expect(request).to.deep.equal({ subject: HOLDER });
      });

      it('an unverifiable certificate vacates nothing — a register-level refusal, like every other', async () => {
        const res = fakeRes();
        const ask = signedAsk('vacate', { key: ORDINAL_KEY, generation: 0, cert: { token: 'forged', subject: HOLDER } });
        await grantorController.vacate(fakeReq(ask), res);
        expect(res.statusCode).to.equal(200);
        expect(res.body.data.ok).to.equal(false);
        expect(res.body.data.code).to.equal('bad_certificate');
        expect(grantRegister.vacate.called).to.equal(false);
      });

      it('a vacate without a certificate, or against a held or founder key, is refused', async () => {
        let res = fakeRes();
        await grantorController.vacate(fakeReq(signedAsk('vacate', { key: ORDINAL_KEY, generation: 0 })), res);
        expect(res.statusCode).to.equal(400);
        res = fakeRes();
        await grantorController.vacate(fakeReq(signedAsk('vacate', { key: 'myapp/master', generation: 0, cert: { token: 'standing', subject: HOLDER } })), res);
        expect(res.statusCode).to.equal(409);
        res = fakeRes();
        await grantorController.vacate(fakeReq(signedAsk('vacate', { key: FOUNDER_KEY, generation: 0, cert: { token: 'standing', subject: HOLDER } })), res);
        expect(res.statusCode).to.equal(409);
        expect(grantRegister.vacate.called).to.equal(false);
      });

      it('the certificate is verified through the node-down seam, and an inert seam verifies nothing', async () => {
        downCertificates.resetForTests();
        const res = fakeRes();
        const ask = signedAsk('vacate', { key: ORDINAL_KEY, generation: 0, cert: { token: 'standing', subject: HOLDER } });
        await grantorController.vacate(fakeReq(ask), res);
        expect(res.statusCode).to.equal(200);
        expect(res.body.data.code).to.equal('bad_certificate');
        expect(grantRegister.vacate.called).to.equal(false);
      });
    });

    it('the record read addresses an ordinal row like a founder row', async () => {
      const res = fakeRes();
      await grantorController.record({ params: { key: ORDINAL_KEY }, query: { generation: '0' } }, res);
      expect(res.statusCode).to.equal(200);
      expect(grantRegister.read.firstCall.args[0]).to.equal(`${ORDINAL_KEY}@0`);
    });
  });

  describe('the founder plane — oneshot membership answers from the founding record', () => {
    it('an oneshot ask consults the founding committee, never the walk', async () => {
      const res = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare', { mode: 'oneshot', key: FOUNDER_KEY })), res);
      expect(res.statusCode).to.equal(200);
      expect(foundingCommittee.selfOnFoundingCommittee.calledOnceWith('myapp', 500000, FINGERPRINT, 0)).to.equal(true);
      expect(networkStateService.membershipAt.called).to.equal(false);
      expect(messageStore.getGrantGenerationRecord.called).to.equal(false);
    });

    it('refuses an oneshot ask that is not a founder register', async () => {
      const plain = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare', { mode: 'oneshot' })), plain);
      expect(plain.statusCode).to.equal(409);
      expect(plain.body.data.message).to.contain('not a founder register');
      expect(grantRegister.prepare.called).to.equal(false);
    });

    it('answers a basis its own window never covered — the record outlives the album', async () => {
      networkStateService.membershipAt.returns(null);
      const res = fakeRes();
      await grantorController.accept(fakeReq(signedAsk('accept', { mode: 'oneshot', ttlMs: undefined, key: FOUNDER_KEY })), res);
      expect(res.statusCode).to.equal(200);
      expect(grantRegister.accept.calledOnce).to.equal(true);
    });

    it('a founder round addresses one register cell per world and generation', async () => {
      await grantorController.prepare(fakeReq(signedAsk('prepare', { mode: 'oneshot', key: FOUNDER_KEY })), fakeRes());
      expect(grantRegister.prepare.firstCall.args[0]).to.equal(`${FOUNDER_KEY}@0`);

      await grantorController.accept(fakeReq(signedAsk('accept', {
        mode: 'oneshot', ttlMs: undefined, generation: 2, key: FOUNDER_KEY,
      })), fakeRes());
      expect(grantRegister.accept.firstCall.args[0]).to.equal(`${FOUNDER_KEY}@2`);

      await grantorController.prepare(fakeReq(signedAsk('prepare')), fakeRes());
      expect(grantRegister.prepare.secondCall.args[0]).to.equal('myapp/master');
    });

    it('the record read serves a founder round cell by its salted key', async () => {
      grantRegister.read.resolves({ promisedEpoch: 1, accepted: { epoch: 1, grantee: ASKER, mode: 'oneshot' } });
      const req = fakeReq({});
      req.query.key = 'myapp/master@2';
      const res = fakeRes();
      await grantorController.record(req, res);
      expect(res.statusCode).to.equal(200);
      expect(grantRegister.read.calledOnceWith('myapp/master@2')).to.equal(true);
    });

    it('409 naming the reason when the founding committee refuses this node', async () => {
      foundingCommittee.selfOnFoundingCommittee.resolves({
        member: false, reason: 'ask names a different committee basis',
      });
      const res = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare', { mode: 'oneshot', key: FOUNDER_KEY })), res);
      expect(res.statusCode).to.equal(409);
      expect(res.body.data.message).to.contain('basis');
      expect(grantRegister.prepare.called).to.equal(false);
    });

    it('held asks never consult the founding committee', async () => {
      const res = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare')), res);
      expect(res.statusCode).to.equal(200);
      expect(foundingCommittee.selfOnFoundingCommittee.called).to.equal(false);
    });
  });

  describe('holdership — the anti-squat rule', () => {
    it('refuses an asker that does not hold the app', async () => {
      registryManager.appLocation.resolves([]);
      const res = fakeRes();
      await grantorController.accept(fakeReq(signedAsk('accept', { mode: 'oneshot', ttlMs: undefined, key: FOUNDER_KEY })), res);
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

    it('the recorded grantee is never held to the age floor — repairing its own term is not a challenge', async () => {
      // the repair chore re-accepts (and, past a residue promise, re-acquires)
      // the incumbent's own term; the floor binds challengers only, the same
      // principle as lock-delay
      grantRegister.read.resolves({ accepted: { epoch: 2, grantee: ASKER, mode: 'held' } });
      registryManager.appLocation.resolves([
        { ip: `${ASKER_HOST}:16127`, runningSince: Date.now() - 60_000 },
      ]);
      const res = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare')), res);
      expect(res.statusCode).to.equal(200);
      expect(grantRegister.prepare.calledOnce).to.equal(true);
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
      await grantorController.accept(fakeReq(signedAsk('accept', { mode: 'oneshot', ttlMs: undefined, key: FOUNDER_KEY })), res);
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

  describe('the roster proposal', () => {
    const REMOVE = `${'1'.repeat(64)}:0`;
    const ADD = `${'6'.repeat(64)}:0`;

    function rosterAsk(overrides = {}) {
      return signedAsk('roster', {
        remove: REMOVE, add: ADD, seq: 1, ...overrides,
      });
    }

    it('a well-formed proposal reaches the register with the resolved membership, and the reply carries a verifiable acceptance', async () => {
      const res = fakeRes();
      await grantorController.roster(fakeReq(rosterAsk()), res);
      expect(res.statusCode).to.equal(200);

      const [key, request, context] = grantRegister.roster.firstCall.args;
      expect(key).to.equal('myapp/master');
      expect(request.remove).to.equal(REMOVE);
      expect(request.add).to.equal(ADD);
      expect(request.seq).to.equal(1);
      expect(context.membership).to.be.an('array');
      expect(context.committeeSize).to.be.a('number');

      const { acceptance } = res.body.data;
      expect(acceptance.grantor).to.equal(ASKER);
      const fields = signedEnvelope.fieldsFor('rosteraccept', {
        key: 'myapp/master', fingerprint: FINGERPRINT, generation: 0, seq: 1, remove: REMOVE, add: ADD,
      });
      expect(signedEnvelope.verify('rosteraccept', fields, acceptance.signature, PUBKEY)).to.equal(true);
    });

    it('refuses malformed seats and seqs outright', async () => {
      const cases = [
        rosterAsk({ remove: 'not-an-outpoint' }),
        rosterAsk({ add: 'not-an-outpoint' }),
        rosterAsk({ seq: 0 }),
        rosterAsk({ seq: 1.5 }),
      ];
      const results = await Promise.all(cases.map(async (body) => {
        const res = fakeRes();
        await grantorController.roster(fakeReq(body), res);
        return res.statusCode;
      }));
      expect(results).to.deep.equal([400, 400, 400, 400]);
    });

    it('a register refusal carries no acceptance — silence, not a half-signature', async () => {
      grantRegister.roster.resolves({ ok: false, code: 'not_grantee' });
      const res = fakeRes();
      await grantorController.roster(fakeReq(rosterAsk()), res);
      expect(res.statusCode).to.equal(200);
      expect(res.body.data.code).to.equal('not_grantee');
      expect(res.body.data.acceptance).to.equal(undefined);
    });

    it('a carried chain that does not verify stops the proposal before the register', async () => {
      const bogusChain = [{
        seq: 1,
        remove: REMOVE,
        add: ADD,
        at: Date.now(),
        acceptances: [{ grantor: REMOVE, signature: 'AAAA' }],
      }];
      const res = fakeRes();
      await grantorController.roster(fakeReq(rosterAsk({ chain: bogusChain })), res);
      expect(res.statusCode).to.equal(200);
      expect(res.body.data.code).to.equal('bad_chain');
      expect(grantRegister.roster.called).to.equal(false);
    });

    it('refuses a chain that fails even the shape gate', async () => {
      const res = fakeRes();
      await grantorController.roster(fakeReq(rosterAsk({ chain: [{ seq: 1 }] })), res);
      expect(res.statusCode).to.equal(400);
    });
  });

  describe('the roster overlay on committee membership', () => {
    // A fleet with real keypairs: the chain that reshapes the committee is
    // verified against these registered keys, so the entries are signed by
    // a real quorum of the base committee — never a fixture waved through.
        function keypairFor(index) {
      const priv = Buffer.alloc(32);
      priv.writeUInt32BE(index + 1, 28);
      return {
        wif: bs58check.encode(Buffer.concat([Buffer.from([0x80]), priv])),
        pubkey: Buffer.from(secp256k1.publicKeyCreate(priv, false)).toString('hex'),
      };
    }

    const realFleet = [
      {
        txhash: ASKER_TXHASH, outidx: 0, pubkey: PUBKEY, ip: `${ASKER_HOST}:16127`,
      },
      ...Array.from({ length: 12 }, (unused, i) => ({
        txhash: String(i + 1).repeat(64).slice(0, 64),
        outidx: 0,
        pubkey: keypairFor(i + 1).pubkey,
        ip: `10.${i + 1}.0.1:16127`,
      })),
    ];
    const wifOf = new Map([
      [ASKER, WIF],
      ...Array.from({ length: 12 }, (unused, i) => [
        `${String(i + 1).repeat(64).slice(0, 64)}:0`, keypairFor(i + 1).wif,
      ]),
    ]);

    const base = selectCommittee(realFleet, rosterOverlay.walkKeyFor('myapp/master', 0), { size: 9 });
    const outpointOf = (node) => `${node.txhash}:${node.outidx}`;
    const removed = base.members[0];
    const survivors = base.members.filter((node) => node !== removed);
    const added = rosterOverlay.nextReplacement(
      realFleet, rosterOverlay.walkKeyFor('myapp/master', 0), survivors, new Set([outpointOf(removed)]),
    );

    const bare = {
      seq: 1, remove: outpointOf(removed), add: outpointOf(added), at: 1000,
    };
    const chain = [{
      ...bare,
      acceptances: base.members.slice(0, base.quorum).map((signer) => {
        const fields = signedEnvelope.fieldsFor('rosteraccept', {
          key: 'myapp/master', fingerprint: FINGERPRINT, generation: 0, seq: 1, remove: bare.remove, add: bare.add,
        });
        const signed = signedEnvelope.sign('rosteraccept', fields, wifOf.get(outpointOf(signer)));
        return { grantor: outpointOf(signer), signature: signed.signature };
      }),
    }];

    beforeEach(() => {
      fluxCommunicationUtils.deterministicFluxList.resolves(realFleet);
      networkStateService.membershipAt.returns(realFleet);
    });

    it('fixture: the walk seats a full nine and a replacement exists off it', () => {
      expect(base.members).to.have.length(9);
      expect(added).to.not.equal(null);
    });

    // F1. A heal is a SWAP - remove X, add Y in one step - so the majorities
    // either side of it can be disjoint, and X is only dark from someone's
    // point of view. The added seat must therefore ADOPT the standing term
    // before it answers anything, or it is exactly the swing vote a challenger
    // needs. It used to answer straight away; that is the defect.
    it('a freshly seated replacement ADOPTS the standing term before it answers', async () => {
      generalService.obtainNodeCollateralInformation.resolves({
        txhash: added.txhash, txindex: added.outidx,
      });
      // its committee tells it a term stands
      sinon.stub(serviceHelper, 'axiosGet').resolves({
        data: {
          status: 'success',
          data: { accepted: { epoch: 4, grantee: ASKER, mode: 'held' }, remainingMs: 90_000 },
        },
      });
      sinon.stub(grantRegister, 'adopt').resolves(null);

      const bareRes = fakeRes();
      await grantorController.renew(fakeReq(signedAsk('renew')), bareRes);
      expect(bareRes.statusCode, 'no chain, not on the committee at all').to.equal(409);

      const chainRes = fakeRes();
      await grantorController.renew(fakeReq(signedAsk('renew', { chain })), chainRes);
      expect(chainRes.statusCode).to.equal(200);
      expect(grantRegister.adopt.calledOnce, 'it served without adopting').to.equal(true);
      expect(grantRegister.adopt.firstCall.args[1].grantee).to.equal(ASKER);
      expect(grantRegister.adopt.firstCall.args[1].epoch).to.equal(4);
    });

    // FAILS CLOSED. A fresh seat with no state and no way to get any must not
    // answer: answering from that position is the whole defect.
    it('a freshly seated replacement REFUSES when it cannot reach a quorum to adopt', async () => {
      generalService.obtainNodeCollateralInformation.resolves({
        txhash: added.txhash, txindex: added.outidx,
      });
      sinon.stub(serviceHelper, 'axiosGet').rejects(new Error('unreachable'));
      sinon.stub(grantRegister, 'adopt').resolves(null);

      const res = fakeRes();
      await grantorController.renew(fakeReq(signedAsk('renew', { chain })), res);
      expect(res.statusCode).to.equal(409);
      expect(grantRegister.renew.called, 'it served with no state at all').to.equal(false);
    });

    // The QUORUM is the rule, not "somebody said so". A single stray row from a
    // round that reached one grantor and died names a node that never won, and
    // a fresh seat adopting it would shield a master that does not exist.
    it('does NOT adopt a term only a minority reports', async () => {
      generalService.obtainNodeCollateralInformation.resolves({
        txhash: added.txhash, txindex: added.outidx,
      });
      let call = 0;
      sinon.stub(serviceHelper, 'axiosGet').callsFake(async () => {
        call += 1;
        // exactly one peer carries a row; every other answers empty
        return call === 1
          ? {
            data: {
              status: 'success',
              data: { accepted: { epoch: 4, grantee: ASKER, mode: 'held' }, remainingMs: 90_000 },
            },
          }
          : { data: { status: 'success', data: { accepted: null, remainingMs: null } } };
      });
      sinon.stub(grantRegister, 'adopt').resolves(null);

      const res = fakeRes();
      await grantorController.renew(fakeReq(signedAsk('renew', { chain })), res);
      expect(grantRegister.adopt.called, 'adopted a term no quorum records').to.equal(false);
    });

    // A quorum answering "no term stands" is an ANSWER, not an outage: the seat
    // may serve. Distinct from being unable to ask, which refuses above.
    it('a freshly seated replacement serves when a quorum says no term stands', async () => {
      generalService.obtainNodeCollateralInformation.resolves({
        txhash: added.txhash, txindex: added.outidx,
      });
      sinon.stub(serviceHelper, 'axiosGet').resolves({
        data: { status: 'success', data: { accepted: null, remainingMs: null } },
      });
      sinon.stub(grantRegister, 'adopt').resolves(null);

      const res = fakeRes();
      await grantorController.renew(fakeReq(signedAsk('renew', { chain })), res);
      expect(res.statusCode).to.equal(200);
      expect(grantRegister.adopt.called, 'nothing to adopt, so nothing written').to.equal(false);
    });

    it('a displaced seat stops answering the moment the chain reaches it', async () => {
      generalService.obtainNodeCollateralInformation.resolves({
        txhash: removed.txhash, txindex: removed.outidx,
      });

      const bareRes = fakeRes();
      await grantorController.renew(fakeReq(signedAsk('renew')), bareRes);
      expect(bareRes.statusCode).to.equal(200);

      const chainRes = fakeRes();
      await grantorController.renew(fakeReq(signedAsk('renew', { chain })), chainRes);
      expect(chainRes.statusCode).to.equal(409);
    });

    it('the journaled chain reshapes membership with no carry at all', async () => {
      grantRegister.read.resolves({
        accepted: { epoch: 3, grantee: ASKER, mode: 'held' },
        roster: { fingerprint: FINGERPRINT, changedAt: 1, chain },
      });
      generalService.obtainNodeCollateralInformation.resolves({
        txhash: added.txhash, txindex: added.outidx,
      });
      const res = fakeRes();
      await grantorController.renew(fakeReq(signedAsk('renew')), res);
      expect(res.statusCode).to.equal(200);
    });
  });

  describe('the record read', () => {
    it('answers the register state for a key, roster and all', async () => {
      grantRegister.read.resolves({
        promisedEpoch: 5,
        accepted: { epoch: 5, grantee: ASKER },
        roster: { fingerprint: FINGERPRINT, changedAt: 1, chain: [] },
      });
      const req = fakeReq({});
      req.query.key = 'myapp/master';
      const res = fakeRes();
      await grantorController.record(req, res);
      expect(res.statusCode).to.equal(200);
      expect(res.body.data.promisedEpoch).to.equal(5);
      expect(res.body.data.accepted.grantee).to.equal(ASKER);
      expect(res.body.data.roster.fingerprint).to.equal(FINGERPRINT);
    });

    // §7 ships DURATIONS, never deadlines. expiresAt is a figure on THIS
    // grantor's clock, and a node that adds it to its own is comparing a remote
    // timestamp to a local one - the rule §7 states outright, and the defect
    // the model found in the first proposed recovery fix. So the read also
    // answers what is LEFT, computed here, which is the only figure a recovering
    // holder may act on.
    it('answers the remaining term as a DURATION, computed on this grantor clock', async () => {
      const now = Date.now();
      grantRegister.read.resolves({
        promisedEpoch: 5,
        accepted: {
          epoch: 5, grantee: ASKER, mode: 'held', expiresAt: now + 90_000,
        },
      });
      const req = fakeReq({});
      req.query.key = 'myapp/master';
      const res = fakeRes();
      await grantorController.record(req, res);
      expect(res.statusCode).to.equal(200);
      expect(res.body.data.remainingMs).to.be.within(88_000, 90_000);
    });

    it('answers a LAPSED term as zero remaining, never a negative', async () => {
      grantRegister.read.resolves({
        accepted: {
          epoch: 5, grantee: ASKER, mode: 'held', expiresAt: Date.now() - 30_000,
        },
      });
      const req = fakeReq({});
      req.query.key = 'myapp/master';
      const res = fakeRes();
      await grantorController.record(req, res);
      expect(res.body.data.remainingMs).to.equal(0);
    });

    // A one-shot founding is durable and has no expiry: null says "not a term",
    // which is different from zero and must not read as a lapsed one.
    it('answers null remaining for a row that carries no expiry', async () => {
      grantRegister.read.resolves({ accepted: { epoch: 1, grantee: ASKER, mode: 'oneshot' } });
      const req = fakeReq({});
      req.query.key = 'myapp/master';
      const res = fakeRes();
      await grantorController.record(req, res);
      expect(res.body.data.remainingMs).to.equal(null);
    });

    it('answers null remaining when there is no accepted row at all', async () => {
      grantRegister.read.resolves(null);
      const req = fakeReq({});
      req.query.key = 'myapp/master';
      const res = fakeRes();
      await grantorController.record(req, res);
      expect(res.body.data.remainingMs).to.equal(null);
    });

    it('reads a founder cell at its generation row - the write path\'s own addressing', async () => {
      const founderKey = 'myapp/founder-0123456789abcdef@2100088';
      grantRegister.read.resolves(null);
      grantRegister.read.withArgs(`${founderKey}@0`).resolves({
        promisedEpoch: 2,
        accepted: { epoch: 2, grantee: ASKER },
      });
      const req = fakeReq({});
      req.query.key = founderKey;
      const res = fakeRes();
      await grantorController.record(req, res);
      expect(res.statusCode).to.equal(200);
      expect(res.body.data.accepted, 'the generation-0 cell answers the bare founder read').to.not.equal(null);
      expect(res.body.data.accepted.grantee).to.equal(ASKER);
    });

    it('addresses a re-rolled world\'s cell by the generation parameter', async () => {
      const founderKey = 'myapp/founder-0123456789abcdef@2100088';
      grantRegister.read.resolves(null);
      grantRegister.read.withArgs(`${founderKey}@3`).resolves({
        promisedEpoch: 1,
        accepted: { epoch: 1, grantee: ASKER },
      });
      const req = fakeReq({});
      req.query.key = founderKey;
      req.query.generation = '3';
      const res = fakeRes();
      await grantorController.record(req, res);
      expect(res.statusCode).to.equal(200);
      expect(res.body.data.accepted.grantee).to.equal(ASKER);
    });

    it('refuses a malformed generation', async () => {
      const req = fakeReq({});
      req.query.key = 'myapp/founder-0123456789abcdef@2100088';
      req.query.generation = 'x';
      const res = fakeRes();
      await grantorController.record(req, res);
      expect(res.statusCode).to.equal(400);
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

  describe('the cancel overlay at the gauntlet', () => {
    // A fleet wide enough that the walk has spare eligibles: the asker plus
    // thirteen fillers, distinct owners, distinct /16s.
    const wideFleet = [
      {
        txhash: ASKER_TXHASH, outidx: 0, pubkey: PUBKEY, ip: `${ASKER_HOST}:16127`,
      },
      ...Array.from({ length: 13 }, (unused, i) => ({
        txhash: String(i + 1).padStart(2, '0').repeat(32),
        outidx: 0,
        pubkey: `owner-${i + 1}`,
        ip: `10.${i + 1}.0.1:16127`,
      })),
    ];
    const walkKey = rosterOverlay.walkKeyFor('myapp/master', 0);
    const committee = selectCommittee(wideFleet, walkKey, { size: 9 });
    const cancelled = committee.members.find((node) => node.txhash !== ASKER_TXHASH);
    const cancelledOutpoint = `${cancelled.txhash}:${cancelled.outidx}`;
    const survivors = committee.members.filter((node) => node !== cancelled);
    const replacement = rosterOverlay.nextReplacement(
      wideFleet, walkKey, survivors, new Set([cancelledOutpoint]),
    );
    const CANCELS = [{
      seq: 1, cancel: cancelledOutpoint, cert: { subject: cancelledOutpoint, token: 'standing' }, at: 1_000,
    }];

    function selfIs(node) {
      generalService.obtainNodeCollateralInformation.resolves({
        txhash: node.txhash, txindex: node.outidx,
      });
    }

    beforeEach(() => {
      fluxCommunicationUtils.deterministicFluxList.resolves(wideFleet);
      networkStateService.membershipAt.returns(wideFleet);
      sinon.stub(grantRegister, 'adoptCancels').resolves(true);
      // adopt-before-serve quorum reads: every peer answers term-free
      sinon.stub(serviceHelper, 'axiosGet').resolves({
        data: { status: 'success', data: { accepted: null, remainingMs: null } },
      });
      downCertificates.registerProvider({
        standingCertificateFor: async () => null,
        refutationFor: async () => null,
        verifyCertificate: (cert) => ({ valid: cert?.token === 'standing', subject: cert?.subject ?? null }),
        verifyRefutation: () => false,
      });
    });

    afterEach(() => {
      downCertificates.resetForTests();
    });

    it('fixture: the walk can seat a replacement, and the cancelled seat is not the asker', () => {
      expect(replacement).to.not.equal(null);
      expect(cancelled.txhash).to.not.equal(ASKER_TXHASH);
      expect(committee.members.map((node) => node.txhash)).to.not.include(replacement.txhash);
    });

    it('refuses malformed cancels before any verification', async () => {
      const res = fakeRes();
      await grantorController.probe(fakeReq({ ...signedAsk('probe'), cancels: 'bogus' }), res);
      expect(res.statusCode).to.equal(400);
      expect(res.body.data.message).to.match(/cancels/);
    });

    it('a verified carried cancel chain seats the replacement — it answers only through the adopt gate, and the chain is journaled', async () => {
      selfIs(replacement);

      const without = fakeRes();
      await grantorController.probe(fakeReq(signedAsk('probe')), without);
      expect(without.statusCode).to.equal(409);

      const withCancels = fakeRes();
      await grantorController.probe(fakeReq({ ...signedAsk('probe'), cancels: CANCELS }), withCancels);
      expect(withCancels.statusCode).to.equal(200);
      // the seat adopted the standing term off its committee before serving
      expect(serviceHelper.axiosGet.called).to.equal(true);
      expect(grantRegister.adoptCancels.calledOnce).to.equal(true);
      const [key, overlay] = grantRegister.adoptCancels.firstCall.args;
      expect(key).to.equal('myapp/master');
      expect(overlay.fingerprint).to.equal(FINGERPRINT);
      expect(overlay.chain).to.deep.equal(CANCELS);
    });

    it('the cancelled seat itself is refused once the chain names it', async () => {
      selfIs(cancelled);

      const without = fakeRes();
      await grantorController.probe(fakeReq(signedAsk('probe')), without);
      expect(without.statusCode).to.equal(200);

      const withCancels = fakeRes();
      await grantorController.probe(fakeReq({ ...signedAsk('probe'), cancels: CANCELS }), withCancels);
      expect(withCancels.statusCode).to.equal(409);
    });

    it('an unverifiable chain reshapes nothing and is never journaled', async () => {
      downCertificates.resetForTests(); // the inert store verifies nothing
      selfIs(replacement);

      const res = fakeRes();
      await grantorController.probe(fakeReq({ ...signedAsk('probe'), cancels: CANCELS }), res);
      expect(res.statusCode).to.equal(409);
      expect(grantRegister.adoptCancels.called).to.equal(false);
    });

    it('the journaled chain applies without re-verification — its entries were verified when first taught', async () => {
      downCertificates.resetForTests(); // no store at all: the journal is trusted
      selfIs(replacement);
      grantRegister.read.resolves({
        cancels: { fingerprint: FINGERPRINT, generation: 0, chain: CANCELS },
      });

      const res = fakeRes();
      await grantorController.probe(fakeReq(signedAsk('probe')), res);
      expect(res.statusCode).to.equal(200);
    });

    it('the record read says whether this cell is refereeing — stale or returning cells read as dark to witnesses', async () => {
      const req = fakeReq({});
      req.query.key = 'myapp/master';

      const fresh = fakeRes();
      await grantorController.record(req, fresh);
      expect(fresh.body.data.refereeing).to.equal(true);

      daemonServiceMiscRpcs.isDaemonSynced.returns({
        status: 'success', data: { synced: false, height: 0 },
      });
      const stale = fakeRes();
      await grantorController.record(req, stale);
      expect(stale.body.data.refereeing).to.equal(false);

      daemonServiceMiscRpcs.isDaemonSynced.returns({
        status: 'success', data: { synced: true, height: 100, header: 100 },
      });
      sinon.stub(grantRegister, 'heldKeys').resolves(['myapp/master']);
      await grantorController.noteReturnFromUnreachability();
      const returning = fakeRes();
      await grantorController.record(req, returning);
      expect(returning.body.data.refereeing).to.equal(false);
    });

    it('the record read teaches the journaled cancel chain', async () => {
      grantRegister.read.resolves({
        promisedEpoch: 1,
        accepted: null,
        cancels: { fingerprint: FINGERPRINT, generation: 0, chain: CANCELS },
      });
      const req = fakeReq({});
      req.query.key = 'myapp/master';
      const res = fakeRes();
      await grantorController.record(req, res);
      expect(res.statusCode).to.equal(200);
      expect(res.body.data.cancels.chain).to.have.length(1);
    });
  });

  describe('the view-freshness serve gate', () => {
    it('a grantor whose chain view is stale refuses to referee held asks — reads stay open', async () => {
      daemonServiceMiscRpcs.isDaemonSynced.returns({
        status: 'success', data: { synced: false, height: 0 },
      });

      const probeRes = fakeRes();
      await grantorController.probe(fakeReq(signedAsk('probe')), probeRes);
      expect(probeRes.statusCode).to.equal(503);

      const renewRes = fakeRes();
      await grantorController.renew(fakeReq(signedAsk('renew')), renewRes);
      expect(renewRes.statusCode).to.equal(503);

      const recordReq = fakeReq({});
      recordReq.query.key = 'myapp/master';
      const recordRes = fakeRes();
      await grantorController.record(recordReq, recordRes);
      expect(recordRes.statusCode).to.equal(200);
    });

    it('the founder plane is exempt — a write-once register has nothing staleness can corrupt', async () => {
      daemonServiceMiscRpcs.isDaemonSynced.returns({
        status: 'success', data: { synced: false, height: 0 },
      });
      const res = fakeRes();
      await grantorController.probe(
        fakeReq(signedAsk('probe', { key: FOUNDER_KEY, mode: 'oneshot' })), res,
      );
      expect(res.statusCode).to.equal(200);
    });
  });

  describe('the return-resync gate', () => {
    const TERM_RECORD = {
      data: {
        status: 'success',
        data: {
          accepted: {
            grantee: `${'2'.repeat(64)}:0`, epoch: 4, mode: 'held', generation: 0, fingerprint: FINGERPRINT,
          },
          remainingMs: 30_000,
          roster: null,
          cancels: null,
        },
      },
    };

    beforeEach(() => {
      sinon.stub(grantRegister, 'heldKeys').resolves(['myapp/master']);
      sinon.stub(grantRegister, 'adopt').resolves(true);
      sinon.stub(grantRegister, 'adoptCancels').resolves(true);
    });

    it('a returned grantor refuses a held ask until the published record is re-fetched, then serves', async () => {
      await grantorController.noteReturnFromUnreachability();

      sinon.stub(serviceHelper, 'axiosGet').rejects(new Error('unreachable'));
      const refused = fakeRes();
      await grantorController.probe(fakeReq(signedAsk('probe')), refused);
      expect(refused.statusCode).to.equal(503);
      expect(grantRegister.adopt.called).to.equal(false);

      serviceHelper.axiosGet.resolves(TERM_RECORD);
      const served = fakeRes();
      await grantorController.probe(fakeReq(signedAsk('probe')), served);
      expect(served.statusCode).to.equal(200);
      expect(grantRegister.adopt.calledOnce).to.equal(true);
      const [key, term] = grantRegister.adopt.firstCall.args;
      expect(key).to.equal('myapp/master');
      expect(term.epoch).to.equal(4);
      expect(term.grantee).to.equal(`${'2'.repeat(64)}:0`);

      // resynced once: the next ask is served without another fetch
      const again = fakeRes();
      await grantorController.probe(fakeReq(signedAsk('probe')), again);
      expect(again.statusCode).to.equal(200);
      expect(grantRegister.adopt.calledOnce).to.equal(true);
    });

    it('a quorum answering with no standing term is also an answer — nothing adopts and serving resumes', async () => {
      await grantorController.noteReturnFromUnreachability();
      sinon.stub(serviceHelper, 'axiosGet').resolves({
        data: { status: 'success', data: { accepted: null, remainingMs: null, cancels: null } },
      });

      const res = fakeRes();
      await grantorController.probe(fakeReq(signedAsk('probe')), res);
      expect(res.statusCode).to.equal(200);
      expect(grantRegister.adopt.called).to.equal(false);
    });

    it('the resync adopts a longer cancel chain the quorum teaches', async () => {
      const subject = `${'3'.repeat(64)}:0`;
      const taughtCancels = {
        fingerprint: FINGERPRINT,
        generation: 0,
        chain: [{
          seq: 1, cancel: subject, cert: { subject, token: 'standing' }, at: 1_000,
        }],
      };
      await grantorController.noteReturnFromUnreachability();
      sinon.stub(serviceHelper, 'axiosGet').resolves({
        data: {
          status: 'success',
          data: { accepted: null, remainingMs: null, cancels: taughtCancels },
        },
      });

      const res = fakeRes();
      await grantorController.probe(fakeReq(signedAsk('probe')), res);
      expect(res.statusCode).to.equal(200);
      expect(grantRegister.adoptCancels.calledOnce).to.equal(true);
      const [key, overlay] = grantRegister.adoptCancels.firstCall.args;
      expect(key).to.equal('myapp/master');
      expect(overlay.chain).to.have.length(1);
    });

    it('the founder plane is exempt from the return gate', async () => {
      await grantorController.noteReturnFromUnreachability();
      sinon.stub(serviceHelper, 'axiosGet').rejects(new Error('unreachable'));

      const res = fakeRes();
      await grantorController.probe(
        fakeReq(signedAsk('probe', { key: FOUNDER_KEY, mode: 'oneshot' })), res,
      );
      expect(res.statusCode).to.equal(200);
    });
  });

  describe('the generation retirement drain', () => {
    it('a re-rolled generation may not serve until the old world\'s grants are provably dead', async () => {
      messageStore.getGrantGenerationRecord.resolves({
        data: { generation: 1, height: 95 },
      });
      daemonServiceMiscRpcs.isDaemonSynced.returns({
        status: 'success', data: { synced: true, height: 100, header: 100 },
      });

      const draining = fakeRes();
      await grantorController.probe(fakeReq(signedAsk('probe', { generation: 1 })), draining);
      expect(draining.statusCode).to.equal(409);
      expect(draining.body.data.message).to.match(/draining/);

      daemonServiceMiscRpcs.isDaemonSynced.returns({
        status: 'success', data: { synced: true, height: 115, header: 115 },
      });
      const served = fakeRes();
      await grantorController.probe(fakeReq(signedAsk('probe', { generation: 1 })), served);
      expect(served.statusCode).to.equal(200);
    });

    it('generation zero never drains — there is no old world to outlive', async () => {
      const res = fakeRes();
      await grantorController.probe(fakeReq(signedAsk('probe')), res);
      expect(res.statusCode).to.equal(200);
    });
  });

  // The plane's birth is a fleet-wide drain window: nodes cross the
  // activation height at their own tips' pace, and a register that served
  // cold keys the moment its own node crossed would hand every running
  // app's term to whichever pursuer's tip crossed earliest. A virgin row
  // serves nobody until this grantor's view passes activateAt +
  // drainBlocks; rows with accepted history are exempt — renewals and
  // reclaims must never drain, whatever the configured heights say.
  describe('the activation drain', () => {
    afterEach(() => {
      grantorController.resetActivationForTests();
    });

    it('a virgin row serves nobody until the fleet-wide window closes', async () => {
      grantorController.resetActivationForTests({ activateAt: 100, drainBlocks: 20 });
      daemonServiceMiscRpcs.isDaemonSynced.returns({
        status: 'success', data: { synced: true, height: 110, header: 110 },
      });

      const draining = fakeRes();
      await grantorController.probe(fakeReq(signedAsk('probe')), draining);
      expect(draining.statusCode).to.equal(409);
      expect(draining.body.data.message).to.match(/activation is draining until height 120/);

      daemonServiceMiscRpcs.isDaemonSynced.returns({
        status: 'success', data: { synced: true, height: 120, header: 120 },
      });
      const served = fakeRes();
      await grantorController.probe(fakeReq(signedAsk('probe')), served);
      expect(served.statusCode).to.equal(200);
    });

    it('a row with accepted history is exempt — renewals never drain', async () => {
      grantorController.resetActivationForTests({ activateAt: 100, drainBlocks: 20 });
      daemonServiceMiscRpcs.isDaemonSynced.returns({
        status: 'success', data: { synced: true, height: 110, header: 110 },
      });
      grantRegister.read.resolves({ accepted: { epoch: 2, grantee: 'x:1', mode: 'held' } });

      const res = fakeRes();
      await grantorController.probe(fakeReq(signedAsk('probe')), res);
      expect(res.statusCode).to.equal(200);
    });

    it('the founder plane never drains at activation', async () => {
      grantorController.resetActivationForTests({ activateAt: 100, drainBlocks: 20 });
      daemonServiceMiscRpcs.isDaemonSynced.returns({
        status: 'success', data: { synced: true, height: 110, header: 110 },
      });

      const res = fakeRes();
      await grantorController.probe(
        fakeReq(signedAsk('probe', { key: FOUNDER_KEY, mode: 'oneshot' })), res,
      );
      expect(res.statusCode).to.equal(200);
    });
  });

  // A grantor referees FROM its stored records, so it may not referee
  // before this node's boot message-sync has delivered them. The gate is
  // event-derived state read per ask — never elapsed time — and fail-closed
  // until the service wiring registers the orchestrator's live level. Reads
  // stay open and answer refereeing:false, so witnesses count a syncing
  // cell dark and the coast carries masters through fleet-wide restarts.
  describe('the boot-sync serve gate', () => {
    it('refuses held asks while the sync is incomplete — reads stay open, refereeing false', async () => {
      grantorController.registerSyncReadyProvider(() => false);

      const refused = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare')), refused);
      expect(refused.statusCode).to.equal(503);
      expect(refused.body.data.message).to.match(/sync/i);

      const readReq = fakeReq({});
      readReq.query.key = 'myapp/master';
      const read = fakeRes();
      await grantorController.record(readReq, read);
      expect(read.statusCode).to.equal(200);
      expect(read.body.data.refereeing).to.equal(false);
    });

    it('the founder plane is exempt, like every serve gate on write-once state', async () => {
      grantorController.registerSyncReadyProvider(() => false);
      const res = fakeRes();
      await grantorController.probe(
        fakeReq(signedAsk('probe', { key: FOUNDER_KEY, mode: 'oneshot' })), res,
      );
      expect(res.statusCode).to.equal(200);
    });

    it('serves once the provider answers ready, and the reopening stamps the lock-delay anchor', async () => {
      let ready = false;
      grantorController.registerSyncReadyProvider(() => ready);
      await grantorController.prepare(fakeReq(signedAsk('prepare')), fakeRes());

      const before = Date.now();
      ready = true;
      const res = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare')), res);
      expect(res.statusCode).to.equal(200);
      const context = grantRegister.prepare.lastCall.args[2];
      expect(context.refereeingSinceMs).to.be.at.least(before);
    });

    it('an unregistered or throwing provider fails closed', async () => {
      grantorController.registerSyncReadyProvider(null);
      const unregistered = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare')), unregistered);
      expect(unregistered.statusCode).to.equal(503);

      grantorController.registerSyncReadyProvider(() => { throw new Error('boom'); });
      const throwing = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare')), throwing);
      expect(throwing.statusCode).to.equal(503);
    });
  });

  // A coast that outlives lockDelay − slack
  // lets a successor be seated before the incumbent's demote fires, because
  // the lock-delay clock ran while this grantor was refusing everyone. The
  // controller therefore hands every held register write the moment this
  // grantor last RETURNED to refereeing — observed lazily at the gates that
  // already read the synced flag (lazy can only move the anchor later than
  // the true return, the safe direction) and stamped exactly at a resync
  // clearance — and the register anchors the successor's wait at the later
  // of row death and that return.
  describe('the refereeing-return lock-delay anchor', () => {
    it('a prepare after a stale spell carries the return moment to the register', async () => {
      daemonServiceMiscRpcs.isDaemonSynced.returns({
        status: 'success', data: { synced: false, height: 0 },
      });
      const staleRes = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare')), staleRes);
      expect(staleRes.statusCode).to.equal(503);

      const before = Date.now();
      daemonServiceMiscRpcs.isDaemonSynced.returns({
        status: 'success', data: { synced: true, height: 100, header: 100 },
      });
      const res = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare')), res);
      expect(res.statusCode).to.equal(200);
      const context = grantRegister.prepare.lastCall.args[2];
      expect(context, 'the register call must carry the anchor context').to.be.an('object');
      expect(context.refereeingSinceMs).to.be.at.least(before);
      expect(context.refereeingSinceMs).to.be.at.most(Date.now());
    });

    it('a stale spell observed only by the record read still moves the anchor', async () => {
      daemonServiceMiscRpcs.isDaemonSynced.returns({
        status: 'success', data: { synced: false, height: 0 },
      });
      const readReq = fakeReq({});
      readReq.query.key = 'myapp/master';
      await grantorController.record(readReq, fakeRes());

      const before = Date.now();
      daemonServiceMiscRpcs.isDaemonSynced.returns({
        status: 'success', data: { synced: true, height: 100, header: 100 },
      });
      const res = fakeRes();
      await grantorController.accept(fakeReq(signedAsk('accept')), res);
      expect(res.statusCode).to.equal(200);
      const context = grantRegister.accept.lastCall.args[2];
      expect(context, 'the register call must carry the anchor context').to.be.an('object');
      expect(context.refereeingSinceMs).to.be.at.least(before);
    });

    it('a resync clearance stamps the key its own return moment', async () => {
      sinon.stub(grantRegister, 'heldKeys').resolves(['myapp/master']);
      sinon.stub(grantRegister, 'adopt').resolves(true);
      sinon.stub(grantRegister, 'adoptCancels').resolves(true);
      await grantorController.noteReturnFromUnreachability();
      sinon.stub(serviceHelper, 'axiosGet').resolves({
        data: { status: 'success', data: { accepted: null, remainingMs: null, cancels: null } },
      });

      const before = Date.now();
      const res = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare')), res);
      expect(res.statusCode).to.equal(200);
      const context = grantRegister.prepare.lastCall.args[2];
      expect(context, 'the register call must carry the anchor context').to.be.an('object');
      expect(context.refereeingSinceMs).to.be.at.least(before);
    });
  });


  // The teach: every answer names the standing generation for the key, so a
  // holder or witness that has not synced the owner's record learns it from
  // whatever it can reach — the refusals included, which are exactly what a
  // retired world's master keeps hearing. The record itself rides along,
  // owner-signed, so the learner verifies and stores it the way a broadcast
  // is stored, never a bare number on trust.
  describe('the teach — every answer names the standing generation', () => {
    const RECORD = {
      type: 'fluxgrantgeneration',
      version: 1,
      ip: '10.1.0.1:16127',
      appName: 'myapp',
      role: 'master',
      generation: 2,
      // named low enough that the world's drain (20 blocks) has lifted at the
      // fixture's height of 100, so the gates past currency are reachable
      height: 70,
      at: 1_750_000_000_000,
      signature: 'ownersig',
      broadcastedAt: 1_750_000_000_500,
    };

    it('a currency 409 carries the standing record, not just its number', async () => {
      messageStore.getGrantGenerationRecord.resolves({ data: RECORD });
      const res = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare')), res);
      expect(res.statusCode).to.equal(409);
      expect(res.body.data.generation).to.equal(2);
      expect(res.body.data.generationRecord).to.deep.equal(RECORD);
    });

    it('the serve gates teach too — a stale or syncing cell still says which world stands', async () => {
      messageStore.getGrantGenerationRecord.resolves({ data: RECORD });
      daemonServiceMiscRpcs.isDaemonSynced.returns({
        status: 'success', data: { synced: false, height: 100, header: 130 },
      });
      const stale = fakeRes();
      await grantorController.renew(fakeReq(signedAsk('renew')), stale);
      expect(stale.statusCode).to.equal(503);
      expect(stale.body.data.generation).to.equal(2);
      expect(stale.body.data.generationRecord).to.deep.equal(RECORD);

      daemonServiceMiscRpcs.isDaemonSynced.returns({
        status: 'success', data: { synced: true, height: 100, header: 100 },
      });
      grantorController.registerSyncReadyProvider(() => false);
      const syncing = fakeRes();
      await grantorController.renew(fakeReq(signedAsk('renew')), syncing);
      expect(syncing.statusCode).to.equal(503);
      expect(syncing.body.data.generation).to.equal(2);
      expect(syncing.body.data.generationRecord).to.deep.equal(RECORD);
    });

    it('a holdership 403 teaches — an asker off the app is still told what world it asked in', async () => {
      messageStore.getGrantGenerationRecord.resolves({ data: RECORD });
      registryManager.appLocation.resolves([]);
      const res = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare', { generation: 2 })), res);
      expect(res.statusCode).to.equal(403);
      expect(res.body.data.generation).to.equal(2);
      expect(res.body.data.generationRecord).to.deep.equal(RECORD);
    });

    it('an app the owner never re-rolled teaches generation 0 and no record', async () => {
      daemonServiceMiscRpcs.isDaemonSynced.returns({
        status: 'success', data: { synced: false, height: 100, header: 130 },
      });
      const res = fakeRes();
      await grantorController.renew(fakeReq(signedAsk('renew')), res);
      expect(res.statusCode).to.equal(503);
      expect(res.body.data.generation).to.equal(0);
      expect(res.body.data.generationRecord).to.equal(null);
    });

    it('a refusal before the key is read teaches nothing — there is no key to answer for', async () => {
      messageStore.getGrantGenerationRecord.resolves({ data: RECORD });
      const res = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare', { key: 'bad key' })), res);
      expect(res.statusCode).to.equal(400);
      expect(res.body.data).to.not.have.property('generation');
      expect(res.body.data).to.not.have.property('generationRecord');
    });

    it('the record read answers the standing generation record beside the register state', async () => {
      messageStore.getGrantGenerationRecord.resolves({ data: RECORD });
      const req = fakeReq({});
      req.query.key = 'myapp/master';
      const res = fakeRes();
      await grantorController.record(req, res);
      expect(res.statusCode).to.equal(200);
      expect(res.body.data.generation).to.equal(2);
      expect(res.body.data.generationRecord).to.deep.equal(RECORD);
      expect(messageStore.getGrantGenerationRecord.lastCall.args).to.deep.equal(['myapp', 'master']);
    });

    it('a founder cell read carries no held-world generation — the founder plane teaches through its basis', async () => {
      messageStore.getGrantGenerationRecord.resolves({ data: RECORD });
      const req = fakeReq({});
      req.query.key = FOUNDER_KEY;
      const res = fakeRes();
      await grantorController.record(req, res);
      expect(res.statusCode).to.equal(200);
      expect(res.body.data).to.not.have.property('generation');
      expect(res.body.data).to.not.have.property('generationRecord');
    });
  });

});
