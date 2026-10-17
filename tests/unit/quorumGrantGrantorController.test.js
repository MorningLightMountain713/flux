'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const config = require('config');
const secp256k1 = require('secp256k1');
const bs58check = require('bs58check').default;

const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const daemonStatus = require('../../ZelBack/src/services/daemonService/daemonStatus');
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
const delistedHolders = require('../../ZelBack/src/services/quorumGrant/delistedHolders');
const fluxEventBus = require('../../ZelBack/src/services/utils/fluxEventBus');
const generationWorld = require('../../ZelBack/src/services/quorumGrant/generationWorld');

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

// An ask in the world the cell stands on when it names the standing generation,
// as a holder asks under the world its own node stands on; a test naming a
// height asks in that world instead.
async function worldAsk(type, overrides = {}) {
  if ('generationHeight' in overrides || overrides.mode === 'oneshot') return signedAsk(type, overrides);
  const [identity, role] = (overrides.key ?? 'myapp/master').split('/');
  const standing = generationWorld.worldOf(await messageStore.standingGeneration(identity, role));
  const named = (overrides.generation ?? 0) === standing.generation && Number.isSafeInteger(standing.height);
  return signedAsk(type, { ...overrides, generationHeight: named ? standing.height : null });
}

// The asker's own running announcement as it was broadcast: a version-1
// envelope around a fluxapprunning payload naming the asker's address.
function runningAnnouncement(ip = `${ASKER_HOST}:16127`) {
  return {
    version: 1,
    timestamp: Date.now(),
    pubKey: PUBKEY,
    signature: 'broadcast-signature',
    data: {
      type: 'fluxapprunning', version: 2, ip, broadcastedAt: Date.now(), apps: [{ name: 'myapp', hash: 'h' }],
    },
  };
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
    sinon.stub(registryManager, 'appLocationOf').resolves([
      { ip: `${ASKER_HOST}:16127`, runningSince: Date.now() - 24 * 60 * 60 * 1000 },
      { ip: '10.1.0.1:16127', runningSince: Date.now() - 24 * 60 * 60 * 1000 },
    ]);
    sinon.stub(messageStore, 'getGrantGenerationRecord').resolves(null);
    // The grantor reads the standing record through standingGeneration; these
    // tests drive it through the record they stub, never set aside, an app
    // that never changed hands.
    // the world before the standing one, against which a step-across credential is proved
    sinon.stub(messageStore, 'predecessorWorld').callsFake(async (identity, role) => {
      const record = await messageStore.getGrantGenerationRecord(identity, role);
      return record ? { generation: record.data.generation - 1, height: null } : null;
    });
    sinon.stub(messageStore, 'standingGeneration').callsFake(async (identity, role) => ({
      record: await messageStore.getGrantGenerationRecord(identity, role),
      aside: false,
      ownership: { owner: 'owner', from: 1, transferred: false },
    }));
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
    sinon.stub(daemonStatus, 'daemonSyncState').returns({ synced: true, height: 100, header: 100 });
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
      await grantorController.prepare(fakeReq(await worldAsk('prepare')), res);
      expect(res.statusCode).to.equal(200);
      expect(res.body.status).to.equal('success');
      expect(grantRegister.prepare.calledOnceWith('myapp/master', {
        epoch: 3, candidate: ASKER,
      })).to.equal(true);
    });

    it('accept carries mode, ttl, generation, and fingerprint through', async () => {
      const res = fakeRes();
      await grantorController.accept(fakeReq(await worldAsk('accept')), res);
      expect(res.statusCode).to.equal(200);
      expect(grantRegister.accept.calledOnceWith('myapp/master', {
        epoch: 3, grantee: ASKER, mode: 'held', ttlMs: 60_000, generation: 0, fingerprint: FINGERPRINT,
      })).to.equal(true);
    });

    // The term acceptance (STEP_ACROSS_DESIGN D1): a referee that accepts or
    // renews a held term signs the term's identity with its own key, exactly
    // as it signs a roster entry. A quorum of these is the incumbent's
    // credential at a re-rolled committee. A referee that cannot sign answers
    // a refusal, never a half-acceptance; a refusal carries nothing.
    it('an accepted term carries the referee\'s signed acceptance over the term\'s identity', async () => {
      grantRegister.accept.resolves({ ok: true, accepted: { epoch: 3, grantee: ASKER, mode: 'held' } });
      const res = fakeRes();
      await grantorController.accept(fakeReq(await worldAsk('accept')), res);
      expect(res.statusCode).to.equal(200);
      const { acceptance } = res.body.data;
      expect(acceptance, 'the reply carries an acceptance').to.be.an('object');
      expect(acceptance.grantor).to.equal(ASKER);
      const fields = signedEnvelope.fieldsFor('termaccept', {
        key: 'myapp/master', fingerprint: FINGERPRINT, generation: 0, epoch: 3, grantee: ASKER,
      });
      expect(signedEnvelope.verify('termaccept', fields, acceptance.signature, PUBKEY)).to.equal(true);
    });

    it('a renewed term carries the same acceptance, at the term\'s epoch and generation', async () => {
      const res = fakeRes();
      await grantorController.renew(fakeReq(await worldAsk('renew', { epoch: 4, generation: 0 })), res);
      expect(res.statusCode).to.equal(200);
      const { acceptance } = res.body.data;
      const fields = signedEnvelope.fieldsFor('termaccept', {
        key: 'myapp/master', fingerprint: FINGERPRINT, generation: 0, epoch: 4, grantee: ASKER,
      });
      expect(signedEnvelope.verify('termaccept', fields, acceptance.signature, PUBKEY)).to.equal(true);
    });

    it('the acceptance names the world the term stands in: after a sale, the sale\'s height with the generation', async () => {
      messageStore.standingGeneration.resolves({ record: null, aside: false, ownership: { owner: 'buyer', from: 50, transferred: true } });
      grantRegister.accept.resolves({ ok: true, accepted: { epoch: 3, grantee: ASKER, mode: 'held' } });
      const res = fakeRes();
      await grantorController.accept(fakeReq(await worldAsk('accept')), res);
      const { acceptance } = res.body.data;
      const inWorld = (generationHeight) => signedEnvelope.fieldsFor('termaccept', {
        key: 'myapp/master', fingerprint: FINGERPRINT, generation: 0, generationHeight, epoch: 3, grantee: ASKER,
      });
      expect(signedEnvelope.verify('termaccept', inWorld(50), acceptance.signature, PUBKEY)).to.equal(true);
      expect(signedEnvelope.verify('termaccept', inWorld(null), acceptance.signature, PUBKEY), 'not the world before the sale').to.equal(false);
    });

    it('a refusal carries no acceptance, and a referee that cannot sign refuses rather than half-accepts', async () => {
      grantRegister.accept.resolves({ ok: false, code: 'lock_delay', retryAfterMs: 5 });
      const refused = fakeRes();
      await grantorController.accept(fakeReq(await worldAsk('accept')), refused);
      expect(refused.body.data).to.not.have.property('acceptance');

      grantRegister.accept.resolves({ ok: true, accepted: { epoch: 3, grantee: ASKER, mode: 'held' } });
      fluxNetworkHelper.getFluxNodePrivateKey.resolves(null);
      const unsigned = fakeRes();
      await grantorController.accept(fakeReq(await worldAsk('accept')), unsigned);
      expect(unsigned.body.data.ok).to.equal(false);
      expect(unsigned.body.data.code).to.equal('unavailable');
    });

    it('renew and release reach the register as the grantee', async () => {
      await grantorController.renew(fakeReq(await worldAsk('renew')), fakeRes());
      await grantorController.release(fakeReq(await worldAsk('release')), fakeRes());
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
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { at: Date.now() - 10 * 60 * 1000 })), res);
      expect(res.statusCode).to.equal(400);
      expect(res.body.data.message).to.contain('stale');
    });

    it('refuses a held accept without a ttl', async () => {
      const res = fakeRes();
      await grantorController.accept(fakeReq(await worldAsk('accept', { ttlMs: undefined })), res);
      expect(res.statusCode).to.equal(400);
    });
  });

  describe('identity — who is asking', () => {
    it('refuses a candidate the list does not carry', async () => {
      const res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { candidate: `${'b'.repeat(64)}:0` })), res);
      expect(res.statusCode).to.equal(403);
      expect(res.body.data.message).to.contain('not a listed node');
    });

    it('refuses an ask arriving from an address that is not the candidate', async () => {
      const res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare'), '198.51.100.99'), res);
      expect(res.statusCode).to.equal(403);
      expect(res.body.data.message).to.contain('originate');
    });

    it('serves a renew carried by another listed node — the one carrier-independent ask', async () => {
      const res = fakeRes();
      await grantorController.renew(fakeReq(await worldAsk('renew'), '10.2.0.1'), res);
      expect(res.statusCode).to.equal(200);
      expect(grantRegister.renew.calledOnce).to.equal(true);
    });

    it('refuses a renew carried by an address the list does not carry', async () => {
      const res = fakeRes();
      await grantorController.renew(fakeReq(await worldAsk('renew'), '198.51.100.99'), res);
      expect(res.statusCode).to.equal(403);
      expect(res.body.data.message).to.contain('caller is not a listed node');
      expect(grantRegister.renew.called).to.equal(false);
    });

    it('a carried prepare stays refused — only renew is carrier-independent', async () => {
      const res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare'), '10.2.0.1'), res);
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
      await grantorController.prepare(fakeReq(await worldAsk('prepare')), res);
      expect(res.statusCode).to.equal(409);
      expect(grantRegister.prepare.called).to.equal(false);
    });

    it('the committee is computed against the membership the ask NAMES', async () => {
      const res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare')), res);
      expect(networkStateService.membershipAt.calledOnceWith(FINGERPRINT)).to.equal(true);
    });

    it('409 unknown fingerprint — never a substitution of the current list', async () => {
      networkStateService.membershipAt.returns(null);
      const res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare')), res);
      expect(res.statusCode).to.equal(409);
      expect(res.body.data.message).to.contain('fingerprint');
      expect(grantRegister.prepare.called).to.equal(false);
    });

    it('409 when the ask names a retired generation, teaching the current one', async () => {
      messageStore.getGrantGenerationRecord.resolves({ data: { generation: 2 } });
      const res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare')), res);
      expect(res.statusCode).to.equal(409);
      expect(res.body.data.message).to.contain('current is generation 2');
      expect(grantRegister.prepare.called).to.equal(false);
    });

    // A release names the generation its row was written under. It removes
    // the asker's own row and nothing else, so a cell that sat on that
    // generation's committee serves it after the generation retired, and
    // through the standing generation's drain.
    it('serves a release naming a retired generation', async () => {
      messageStore.getGrantGenerationRecord.resolves({ data: { generation: 2, height: 50 } });
      const res = fakeRes();
      await grantorController.release(fakeReq(await worldAsk('release', { generation: 1 })), res);
      expect(res.statusCode, JSON.stringify(res.body)).to.equal(200);
      expect(grantRegister.release.calledOnce).to.equal(true);
    });

    it('serves a retired release through the standing generation\'s drain', async () => {
      // standing generation 2 at height 200, this cell at 100: draining until 220
      messageStore.getGrantGenerationRecord.resolves({ data: { generation: 2, height: 200 } });
      const res = fakeRes();
      await grantorController.release(fakeReq(await worldAsk('release', { generation: 1 })), res);
      expect(res.statusCode, JSON.stringify(res.body)).to.equal(200);
      expect(grantRegister.release.calledOnce).to.equal(true);
    });

    // The sale. A transfer names the record the seller signed; every cell
    // drains from the height the transfer applied before it serves the named
    // committee, or the registration's when the transfer named none.
    it('refuses every ask while the spec names a record this cell does not hold', async () => {
      messageStore.standingGeneration.resolves({ record: null, aside: true, ownership: { owner: 'buyer', from: 200, transferred: true } });
      const res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { generation: 0 })), res);
      expect(res.statusCode).to.equal(409);
      expect(res.body.data.message).to.contain('does not hold');
      expect(grantRegister.prepare.called).to.equal(false);
    });

    it('the record a transfer names drains from the height the transfer applied, not its own', async () => {
      // the seller's record at height 50, the sale applied at 200, this cell at 100
      messageStore.standingGeneration.resolves({
        record: { data: { generation: 2, height: 50 }, signer: 'seller' }, aside: false, ownership: { owner: 'buyer', from: 200, transferred: true },
      });
      const res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { generation: 2 })), res);
      expect(res.statusCode).to.equal(409);
      expect(res.body.data.message).to.contain('draining until height 220');
    });

    it('the registration\'s committee drains after a transfer naming nothing, and never for an app that never changed hands', async () => {
      messageStore.standingGeneration.resolves({ record: null, aside: false, ownership: { owner: 'buyer', from: 200, transferred: true } });
      const sold = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { generation: 0 })), sold);
      expect(sold.statusCode).to.equal(409);
      expect(sold.body.data.message).to.contain('draining until height 220');

      messageStore.standingGeneration.resolves({ record: null, aside: false, ownership: { owner: 'owner', from: 200, transferred: false } });
      const kept = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { generation: 0 })), kept);
      expect(kept.statusCode, JSON.stringify(kept.body)).to.equal(200);
    });

    // A sale can hand the key to a new world at the generation it already had:
    // the cell compares the whole world, never the number alone.
    it('refuses an ask naming the standing generation in the world before a sale, serves the world the sale began', async () => {
      // the sale applied at 50 and named no record; this cell at 100 is past its drain
      messageStore.standingGeneration.resolves({ record: null, aside: false, ownership: { owner: 'buyer', from: 50, transferred: true } });
      const before = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { generation: 0, generationHeight: null })), before);
      expect(before.statusCode).to.equal(409);
      expect(before.body.data.message).to.contain('current is generation 0 from height 50');
      expect(grantRegister.prepare.called).to.equal(false);

      const sold = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { generation: 0, generationHeight: 50 })), sold);
      expect(sold.statusCode, JSON.stringify(sold.body)).to.equal(200);
    });

    it('tells the register the asked world drained after a sale, and not for an app that never changed hands', async () => {
      messageStore.standingGeneration.resolves({ record: null, aside: false, ownership: { owner: 'buyer', from: 50, transferred: true } });
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { generation: 0 })), fakeRes());
      expect(grantRegister.prepare.lastCall.args[2].worldDrained).to.equal(true);
      messageStore.standingGeneration.resolves({ record: null, aside: false, ownership: { owner: 'owner', from: 50, transferred: false } });
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { generation: 0 })), fakeRes());
      expect(grantRegister.prepare.lastCall.args[2].worldDrained).to.equal(false);
    });

    it('a retired renew stays refused', async () => {
      messageStore.getGrantGenerationRecord.resolves({ data: { generation: 2, height: 50 } });
      const res = fakeRes();
      await grantorController.renew(fakeReq(await worldAsk('renew', { generation: 1 })), res);
      expect(res.statusCode).to.equal(409);
      expect(res.body.data.message).to.contain('current is generation 2');
      expect(grantRegister.renew.called).to.equal(false);
    });

    it('refuses an ask without a well-formed fingerprint outright', async () => {
      const res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { fingerprint: 'fp-1' })), res);
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
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { mode: 'oneshot', key: ORDINAL_KEY })), res);
      expect(res.statusCode).to.equal(200);
      expect(foundingCommittee.selfOnFoundingCommittee.calledOnceWith('myapp', 500_000, FINGERPRINT, 0)).to.equal(true);
      expect(grantRegister.prepare.firstCall.args[0]).to.equal(`${ORDINAL_KEY}@0`);
    });

    it('a delisted holder resolves to nobody at seat rows only: the ordinal ask carries the delisted-holder read, the founder and held asks do not', async () => {
      await grantorController.probe(fakeReq(await worldAsk('probe', { mode: 'oneshot', key: ORDINAL_KEY })), fakeRes());
      expect(grantRegister.probe.calledOnce).to.equal(true);
      const [, , seatContext] = grantRegister.probe.firstCall.args;
      expect(seatContext.holderDelisted).to.equal(delistedHolders.isDelistedHolder);

      await grantorController.prepare(fakeReq(await worldAsk('prepare', { mode: 'oneshot', key: FOUNDER_KEY })), fakeRes());
      await grantorController.prepare(fakeReq(await worldAsk('prepare')), fakeRes());
      expect(grantRegister.prepare.calledTwice).to.equal(true);
      grantRegister.prepare.getCalls().forEach((call) => {
        expect(call.args[2]).to.not.have.property('holderDelisted');
      });
    });

    it('a seat ask needs no running row: the seat is granted before the container exists', async () => {
      // chud, 2026-09-07: every mesh install on v9 had deferred since the
      // plane landed — the install waited on the seat, the seat on a row only
      // the install could write. The design's reclaims for a seat are the
      // uninstall's release and the holder's certificate, never this check.
      registryManager.appLocationOf.resolves([
        { ip: '10.1.0.1:16127', runningSince: Date.now() - 24 * 60 * 60 * 1000 },
      ]);
      const res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { mode: 'oneshot', key: ORDINAL_KEY })), res);
      expect(res.statusCode).to.equal(200);
      expect(grantRegister.prepare.calledOnce).to.equal(true);
    });

    it('a held ask and a founder ask still need the running row: those are roles a running member fills', async () => {
      registryManager.appLocationOf.resolves([
        { ip: '10.1.0.1:16127', runningSince: Date.now() - 24 * 60 * 60 * 1000 },
      ]);
      let res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare')), res);
      expect(res.statusCode, 'held').to.equal(403);
      res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { mode: 'oneshot', key: FOUNDER_KEY })), res);
      expect(res.statusCode, 'founder').to.equal(403);
      expect(grantRegister.prepare.called).to.equal(false);
    });

    it('release of an ordinal row reaches the register row with the oneshot permission', async () => {
      const res = fakeRes();
      await grantorController.release(fakeReq(await worldAsk('release', { key: ORDINAL_KEY, generation: 0 })), res);
      expect(res.statusCode).to.equal(200);
      const [row, request] = grantRegister.release.firstCall.args;
      expect(row).to.equal(`${ORDINAL_KEY}@0`);
      expect(request.allowOneshot).to.equal(true);
      expect(request.grantee).to.equal(ASKER);
    });

    it('release of a founder row carries no such permission — founder rows never reopen', async () => {
      const res = fakeRes();
      await grantorController.release(fakeReq(await worldAsk('release', { key: FOUNDER_KEY, generation: 0 })), res);
      expect(res.statusCode).to.equal(200);
      const [row, request] = grantRegister.release.firstCall.args;
      expect(row).to.equal(`${FOUNDER_KEY}@0`);
      expect(request.allowOneshot).to.equal(undefined);
    });

    it('release of a held key is unchanged: the key itself, no permission', async () => {
      const res = fakeRes();
      await grantorController.release(fakeReq(await worldAsk('release')), res);
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
        await grantorController.vacate(fakeReq(await worldAsk('vacate', { key: ORDINAL_KEY, generation: 0 })), res);
        expect(res.statusCode).to.equal(400);
        res = fakeRes();
        await grantorController.vacate(fakeReq(await worldAsk('vacate', { key: 'myapp/master', generation: 0, cert: { token: 'standing', subject: HOLDER } })), res);
        expect(res.statusCode).to.equal(409);
        res = fakeRes();
        await grantorController.vacate(fakeReq(await worldAsk('vacate', { key: FOUNDER_KEY, generation: 0, cert: { token: 'standing', subject: HOLDER } })), res);
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
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { mode: 'oneshot', key: FOUNDER_KEY })), res);
      expect(res.statusCode).to.equal(200);
      expect(foundingCommittee.selfOnFoundingCommittee.calledOnceWith('myapp', 500_000, FINGERPRINT, 0)).to.equal(true);
      expect(networkStateService.membershipAt.called).to.equal(false);
      expect(messageStore.getGrantGenerationRecord.called).to.equal(false);
    });

    it('refuses an oneshot ask that is not a founder register', async () => {
      const plain = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { mode: 'oneshot' })), plain);
      expect(plain.statusCode).to.equal(409);
      expect(plain.body.data.message).to.contain('not a founder register');
      expect(grantRegister.prepare.called).to.equal(false);
    });

    it('answers a basis its own window never covered — the record outlives the album', async () => {
      networkStateService.membershipAt.returns(null);
      const res = fakeRes();
      await grantorController.accept(fakeReq(await worldAsk('accept', { mode: 'oneshot', ttlMs: undefined, key: FOUNDER_KEY })), res);
      expect(res.statusCode).to.equal(200);
      expect(grantRegister.accept.calledOnce).to.equal(true);
    });

    it('a founder round addresses one register cell per world and generation', async () => {
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { mode: 'oneshot', key: FOUNDER_KEY })), fakeRes());
      expect(grantRegister.prepare.firstCall.args[0]).to.equal(`${FOUNDER_KEY}@0`);

      await grantorController.accept(fakeReq(await worldAsk('accept', {
        mode: 'oneshot', ttlMs: undefined, generation: 2, key: FOUNDER_KEY,
      })), fakeRes());
      expect(grantRegister.accept.firstCall.args[0]).to.equal(`${FOUNDER_KEY}@2`);

      await grantorController.prepare(fakeReq(await worldAsk('prepare')), fakeRes());
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
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { mode: 'oneshot', key: FOUNDER_KEY })), res);
      expect(res.statusCode).to.equal(409);
      expect(res.body.data.message).to.contain('basis');
      expect(grantRegister.prepare.called).to.equal(false);
    });

    it('held asks never consult the founding committee', async () => {
      const res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare')), res);
      expect(res.statusCode).to.equal(200);
      expect(foundingCommittee.selfOnFoundingCommittee.called).to.equal(false);
    });
  });

  describe('holdership — the anti-squat rule', () => {
    it('refuses an asker that does not hold the app', async () => {
      registryManager.appLocationOf.resolves([]);
      const res = fakeRes();
      await grantorController.accept(fakeReq(await worldAsk('accept', { mode: 'oneshot', ttlMs: undefined, key: FOUNDER_KEY })), res);
      expect(res.statusCode).to.equal(403);
      expect(res.body.data.message).to.contain('holder');
      expect(grantRegister.accept.called).to.equal(false);
    });

    it('probe alone skips the holder check — reading costs nothing', async () => {
      registryManager.appLocationOf.resolves([]);
      const res = fakeRes();
      await grantorController.probe(fakeReq(await worldAsk('probe')), res);
      expect(res.statusCode).to.equal(200);
      expect(grantRegister.probe.calledOnce).to.equal(true);
    });

    it('release skips the holder check — it gives back only the asker\'s own term — and renew does not', async () => {
      // a removal broadcasts its appremoved before its teardown releases, so
      // the releaser's row is already gone at every cell that heard it
      registryManager.appLocationOf.resolves([]);
      const released = fakeRes();
      await grantorController.release(fakeReq(await worldAsk('release')), released);
      expect(released.statusCode).to.equal(200);
      expect(grantRegister.release.calledOnce).to.equal(true);
      const renewed = fakeRes();
      await grantorController.renew(fakeReq(await worldAsk('renew')), renewed);
      expect(renewed.statusCode).to.equal(403);
      expect(grantRegister.renew.called).to.equal(false);
    });

    describe('a cell with no row for the asker seats on the announcement the ask carries', () => {
      const askerRow = { ip: `${ASKER_HOST}:16127`, runningSince: Date.now() - 60_000 };
      let announcement;

      beforeEach(() => {
        announcement = runningAnnouncement();
        sinon.stub(fluxCommunicationUtils, 'verifyFluxBroadcast').resolves({
          result: fluxCommunicationUtils.VerifyResult.OK, announcer: fixtureFleet()[0],
        });
        sinon.stub(messageStore, 'storeBatchAppRunningEvents').resolves({ stored: 1 });
        sinon.stub(messageStore, 'releaseInstallingClaims').resolves({ released: 0 });
        sinon.stub(fluxEventBus, 'publish');
      });

      function servedReport() {
        return fluxEventBus.publish.getCalls().map((call) => call.args).find(([name]) => name === 'quorumGrant:served')[1];
      }

      it('verifies the copy as the gossip intake would, stores it as a synced one, and answers the ask', async () => {
        registryManager.appLocationOf.onFirstCall().resolves([]).onSecondCall().resolves([askerRow]);
        const res = fakeRes();
        await grantorController.accept(fakeReq(await worldAsk('accept', { announcement })), res);
        expect(res.statusCode).to.equal(200);
        expect(grantRegister.accept.calledOnce).to.equal(true);
        expect(fluxCommunicationUtils.verifyFluxBroadcast.calledOnceWith(announcement)).to.equal(true);
        const [stored, announcers] = messageStore.storeBatchAppRunningEvents.firstCall.args;
        expect(stored).to.deep.equal([announcement]);
        expect(announcers.get(announcement)).to.deep.equal(fixtureFleet()[0]);
        expect(messageStore.releaseInstallingClaims.calledOnceWith(announcement.data)).to.equal(true);
        expect(servedReport()).to.include({ outcome: 'served', announcement: 'adopted' });
      });

      it('a renewal seats the same way', async () => {
        registryManager.appLocationOf.onFirstCall().resolves([]).onSecondCall().resolves([askerRow]);
        const res = fakeRes();
        await grantorController.renew(fakeReq(await worldAsk('renew', { announcement })), res);
        expect(res.statusCode).to.equal(200);
        expect(grantRegister.renew.calledOnce).to.equal(true);
      });

      it('a cell that holds the row never reads the copy', async () => {
        const res = fakeRes();
        await grantorController.accept(fakeReq(await worldAsk('accept', { announcement })), res);
        expect(res.statusCode).to.equal(200);
        expect(fluxCommunicationUtils.verifyFluxBroadcast.called).to.equal(false);
        expect(messageStore.storeBatchAppRunningEvents.called).to.equal(false);
        expect(servedReport()).to.not.have.property('announcement');
      });

      it('only the asker\'s own announcement counts: another node\'s copy is refused unread', async () => {
        registryManager.appLocationOf.resolves([]);
        const res = fakeRes();
        await grantorController.accept(fakeReq(await worldAsk('accept', { announcement: runningAnnouncement('10.1.0.1:16127') })), res);
        expect(res.statusCode).to.equal(403);
        expect(res.body.data.message).to.contain('holder');
        expect(fluxCommunicationUtils.verifyFluxBroadcast.called).to.equal(false);
        expect(messageStore.storeBatchAppRunningEvents.called).to.equal(false);
        expect(grantRegister.accept.called).to.equal(false);
      });

      it('a copy the broadcast verifier refuses stores nothing', async () => {
        registryManager.appLocationOf.resolves([]);
        fluxCommunicationUtils.verifyFluxBroadcast.resolves({
          result: fluxCommunicationUtils.VerifyResult.BAD_SIGNATURE, announcer: null,
        });
        const res = fakeRes();
        await grantorController.accept(fakeReq(await worldAsk('accept', { announcement })), res);
        expect(res.statusCode).to.equal(403);
        expect(messageStore.storeBatchAppRunningEvents.called).to.equal(false);
        expect(grantRegister.accept.called).to.equal(false);
        expect(fluxEventBus.publish.getCalls().map((call) => call.args)
          .find(([name]) => name === 'quorumGrant:served')[1]).to.include({ outcome: 'refusedHolder', announcement: 'refused' });
      });

      it('a copy that still names no row for the asker is refused after it is stored', async () => {
        registryManager.appLocationOf.resolves([]);
        const res = fakeRes();
        await grantorController.accept(fakeReq(await worldAsk('accept', { announcement })), res);
        expect(res.statusCode).to.equal(403);
        expect(messageStore.storeBatchAppRunningEvents.calledOnce).to.equal(true);
        expect(registryManager.appLocationOf.calledTwice).to.equal(true);
        expect(grantRegister.accept.called).to.equal(false);
      });

      it('a malformed copy is a malformed ask', async () => {
        const res = fakeRes();
        await grantorController.accept(fakeReq(await worldAsk('accept', { announcement: { version: 2, data: { type: 'fluxapprunning' } } })), res);
        expect(res.statusCode).to.equal(400);
        expect(res.body.data.message).to.equal('malformed announcement');
        expect(registryManager.appLocationOf.called).to.equal(false);
      });

      it('the copy rides outside the signature: the signed fields are the same with and without it', async () => {
        registryManager.appLocationOf.onFirstCall().resolves([]).onSecondCall().resolves([askerRow]);
        const bare = signedAsk('accept');
        const res = fakeRes();
        await grantorController.accept(fakeReq({ ...bare, announcement }), res);
        expect(res.statusCode).to.equal(200);
      });
    });

    it('a young holder may not CHALLENGE an existing held record', async () => {
      grantRegister.read.resolves({ accepted: { epoch: 2, grantee: 'x:1', mode: 'held' } });
      registryManager.appLocationOf.resolves([
        { ip: `${ASKER_HOST}:16127`, runningSince: Date.now() - 60_000 },
      ]);
      const res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare')), res);
      expect(res.statusCode).to.equal(403);
      expect(res.body.data.message).to.contain('young');
    });

    it('the recorded grantee is never held to the age floor — repairing its own term is not a challenge', async () => {
      // the repair chore re-accepts (and, past a residue promise, re-acquires)
      // the incumbent's own term; the floor binds challengers only, the same
      // principle as lock-delay
      grantRegister.read.resolves({ accepted: { epoch: 2, grantee: ASKER, mode: 'held' } });
      registryManager.appLocationOf.resolves([
        { ip: `${ASKER_HOST}:16127`, runningSince: Date.now() - 60_000 },
      ]);
      const res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare')), res);
      expect(res.statusCode).to.equal(200);
      expect(grantRegister.prepare.calledOnce).to.equal(true);
    });

    it('a young holder may make a FIRST acquisition — a fresh app seats its first master', async () => {
      registryManager.appLocationOf.resolves([
        { ip: `${ASKER_HOST}:16127`, runningSince: Date.now() - 60_000 },
      ]);
      const res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare')), res);
      expect(res.statusCode).to.equal(200);
    });

    it('a young holder may found — the age floor is a held-challenge rule only', async () => {
      grantRegister.read.resolves({ accepted: { epoch: 1, grantee: 'x:1', mode: 'oneshot' } });
      registryManager.appLocationOf.resolves([
        { ip: `${ASKER_HOST}:16127`, runningSince: Date.now() - 60_000 },
      ]);
      const res = fakeRes();
      await grantorController.accept(fakeReq(await worldAsk('accept', { mode: 'oneshot', ttlMs: undefined, key: FOUNDER_KEY })), res);
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
      await grantorController.prepare(fakeReq(await worldAsk('prepare'), '10.1.0.1'), otherPeerRes);
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
      await grantorController.renew(fakeReq(await worldAsk('renew')), bareRes);
      expect(bareRes.statusCode, 'no chain, not on the committee at all').to.equal(409);

      const chainRes = fakeRes();
      await grantorController.renew(fakeReq(await worldAsk('renew', { chain })), chainRes);
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
      await grantorController.renew(fakeReq(await worldAsk('renew', { chain })), res);
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
      await grantorController.renew(fakeReq(await worldAsk('renew', { chain })), res);
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
      await grantorController.renew(fakeReq(await worldAsk('renew', { chain })), res);
      expect(res.statusCode).to.equal(200);
      expect(grantRegister.adopt.called, 'nothing to adopt, so nothing written').to.equal(false);
    });

    it('a displaced seat stops answering the moment the chain reaches it', async () => {
      generalService.obtainNodeCollateralInformation.resolves({
        txhash: removed.txhash, txindex: removed.outidx,
      });

      const bareRes = fakeRes();
      await grantorController.renew(fakeReq(await worldAsk('renew')), bareRes);
      expect(bareRes.statusCode).to.equal(200);

      const chainRes = fakeRes();
      await grantorController.renew(fakeReq(await worldAsk('renew', { chain })), chainRes);
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
      await grantorController.renew(fakeReq(await worldAsk('renew')), res);
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

  describe('the committee read', () => {
    const KEY = 'ab12cd34ef56/master';
    const twelve = () => Array.from({ length: 12 }, (_, i) => ({
      txhash: String(i + 1).padStart(64, '0'), outidx: 0, pubkey: `owner-${i + 1}`, ip: `10.${i + 1}.0.1:16127`,
    }));
    const outpoint = (node) => `${node.txhash}:${node.outidx}`;

    beforeEach(() => {
      sinon.stub(networkStateService, 'membershipFingerprint').returns(FINGERPRINT);
      networkStateService.membershipAt.returns(twelve());
    });

    it('answers the walk\'s committee for a held key at a generation, over the membership held now', async () => {
      const res = fakeRes();
      await grantorController.committee({ params: {}, query: { key: KEY, generation: '1' } }, res);
      expect(res.statusCode).to.equal(200);
      const size = config.get('fluxapps.quorumGrantHeldCommitteeSize');
      const expected = selectCommittee(twelve(), rosterOverlay.walkKeyFor(KEY, 1), { size });
      expect(expected.refusal).to.equal(null);
      expect(res.body.data.members.map((m) => m.outpoint)).to.deep.equal(expected.members.map(outpoint));
      expect(res.body.data.members[0].ip).to.equal(expected.members[0].ip);
      expect(res.body.data).to.include({
        key: KEY, generation: 1, fingerprint: FINGERPRINT, size, quorum: expected.quorum, refusal: null,
      });
      expect(networkStateService.membershipAt.calledWith(FINGERPRINT)).to.equal(true);
    });

    it('reads generation 0 when none is given, and the key from the path', async () => {
      const res = fakeRes();
      await grantorController.committee({ params: { key: KEY }, query: {} }, res);
      expect(res.statusCode).to.equal(200);
      const expected = selectCommittee(twelve(), rosterOverlay.walkKeyFor(KEY, 0), { size: config.get('fluxapps.quorumGrantHeldCommitteeSize') });
      expect(res.body.data.generation).to.equal(0);
      expect(res.body.data.members.map((m) => m.outpoint)).to.deep.equal(expected.members.map(outpoint));
    });

    it('refuses a row id, a founder row and a malformed generation', async () => {
      const row = fakeRes();
      await grantorController.committee({ params: {}, query: { key: `${KEY}@1` } }, row);
      expect(row.statusCode).to.equal(400);
      expect(row.body.data.message).to.equal('malformed key');
      const founder = fakeRes();
      await grantorController.committee({ params: {}, query: { key: 'ab12cd34ef56/founder-0123456789abcdef@0' } }, founder);
      expect(founder.statusCode).to.equal(400);
      expect(founder.body.data.message).to.equal('malformed key');
      const generation = fakeRes();
      await grantorController.committee({ params: {}, query: { key: KEY, generation: '-1' } }, generation);
      expect(generation.statusCode).to.equal(400);
      expect(generation.body.data.message).to.equal('malformed generation');
      expect(networkStateService.membershipAt.called).to.equal(false);
    });

    it('answers 503 while this node holds no membership view', async () => {
      networkStateService.membershipFingerprint.returns(null);
      const res = fakeRes();
      await grantorController.committee({ params: {}, query: { key: KEY } }, res);
      expect(res.statusCode).to.equal(503);
      expect(networkStateService.membershipAt.called).to.equal(false);
    });

    it('carries the walk\'s refusal when the membership cannot seat a committee', async () => {
      networkStateService.membershipAt.returns(twelve().slice(0, 2));
      const res = fakeRes();
      await grantorController.committee({ params: {}, query: { key: KEY } }, res);
      expect(res.statusCode).to.equal(200);
      expect(res.body.data.refusal).to.be.a('string');
      expect(res.body.data.members).to.deep.equal([]);
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
      seq: 1, cancel: cancelledOutpoint, cert: { subject: cancelledOutpoint, token: 'standing' }, at: 1000,
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
      await grantorController.probe(fakeReq(await worldAsk('probe')), without);
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
      await grantorController.probe(fakeReq(await worldAsk('probe')), without);
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
      await grantorController.probe(fakeReq(await worldAsk('probe')), res);
      expect(res.statusCode).to.equal(200);
    });

    it('the record read says whether this cell is refereeing — stale or returning cells read as dark to witnesses', async () => {
      const req = fakeReq({});
      req.query.key = 'myapp/master';

      const fresh = fakeRes();
      await grantorController.record(req, fresh);
      expect(fresh.body.data.refereeing).to.equal(true);

      daemonStatus.daemonSyncState.returns({ synced: false, height: 0 });
      const stale = fakeRes();
      await grantorController.record(req, stale);
      expect(stale.body.data.refereeing).to.equal(false);

      daemonStatus.daemonSyncState.returns({ synced: true, height: 100, header: 100 });
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
      daemonStatus.daemonSyncState.returns({ synced: false, height: 0 });

      const probeRes = fakeRes();
      await grantorController.probe(fakeReq(await worldAsk('probe')), probeRes);
      expect(probeRes.statusCode).to.equal(503);

      const renewRes = fakeRes();
      await grantorController.renew(fakeReq(await worldAsk('renew')), renewRes);
      expect(renewRes.statusCode).to.equal(503);

      const recordReq = fakeReq({});
      recordReq.query.key = 'myapp/master';
      const recordRes = fakeRes();
      await grantorController.record(recordReq, recordRes);
      expect(recordRes.statusCode).to.equal(200);
    });

    it('the founder plane is exempt — a write-once register has nothing staleness can corrupt', async () => {
      daemonStatus.daemonSyncState.returns({ synced: false, height: 0 });
      const res = fakeRes();
      await grantorController.probe(
        fakeReq(await worldAsk('probe', { key: FOUNDER_KEY, mode: 'oneshot' })), res,
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
      await grantorController.probe(fakeReq(await worldAsk('probe')), refused);
      expect(refused.statusCode).to.equal(503);
      expect(grantRegister.adopt.called).to.equal(false);

      serviceHelper.axiosGet.resolves(TERM_RECORD);
      const served = fakeRes();
      await grantorController.probe(fakeReq(await worldAsk('probe')), served);
      expect(served.statusCode).to.equal(200);
      expect(grantRegister.adopt.calledOnce).to.equal(true);
      const [key, term] = grantRegister.adopt.firstCall.args;
      expect(key).to.equal('myapp/master');
      expect(term.epoch).to.equal(4);
      expect(term.grantee).to.equal(`${'2'.repeat(64)}:0`);

      // resynced once: the next ask is served without another fetch
      const again = fakeRes();
      await grantorController.probe(fakeReq(await worldAsk('probe')), again);
      expect(again.statusCode).to.equal(200);
      expect(grantRegister.adopt.calledOnce).to.equal(true);
    });

    it('a quorum answering with no standing term is also an answer — nothing adopts and serving resumes', async () => {
      await grantorController.noteReturnFromUnreachability();
      sinon.stub(serviceHelper, 'axiosGet').resolves({
        data: { status: 'success', data: { accepted: null, remainingMs: null, cancels: null } },
      });

      const res = fakeRes();
      await grantorController.probe(fakeReq(await worldAsk('probe')), res);
      expect(res.statusCode).to.equal(200);
      expect(grantRegister.adopt.called).to.equal(false);
    });

    it('the resync adopts a longer cancel chain the quorum teaches', async () => {
      const subject = `${'3'.repeat(64)}:0`;
      const taughtCancels = {
        fingerprint: FINGERPRINT,
        generation: 0,
        chain: [{
          seq: 1, cancel: subject, cert: { subject, token: 'standing' }, at: 1000,
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
      await grantorController.probe(fakeReq(await worldAsk('probe')), res);
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
        fakeReq(await worldAsk('probe', { key: FOUNDER_KEY, mode: 'oneshot' })), res,
      );
      expect(res.statusCode).to.equal(200);
    });
  });

  describe('the generation retirement drain', () => {
    it('a re-rolled generation may not serve until the old world\'s grants are provably dead', async () => {
      messageStore.getGrantGenerationRecord.resolves({
        data: { generation: 1, height: 95 },
      });
      daemonStatus.daemonSyncState.returns({ synced: true, height: 100, header: 100 });

      const draining = fakeRes();
      await grantorController.probe(fakeReq(await worldAsk('probe', { generation: 1 })), draining);
      expect(draining.statusCode).to.equal(409);
      expect(draining.body.data.message).to.match(/draining/);

      daemonStatus.daemonSyncState.returns({ synced: true, height: 115, header: 115 });
      const served = fakeRes();
      await grantorController.probe(fakeReq(await worldAsk('probe', { generation: 1 })), served);
      expect(served.statusCode).to.equal(200);
    });

    it('generation zero never drains — there is no old world to outlive', async () => {
      const res = fakeRes();
      await grantorController.probe(fakeReq(await worldAsk('probe')), res);
      expect(res.statusCode).to.equal(200);
    });
  });

  // The two heights (ACTIVATION_CROSSING_DESIGN.md §2.1). A VIRGIN row is
  // served from activateAt - preWindowBlocks in this grantor's own view and
  // refused below it - the register is not open yet - so the node running
  // the container can take its lease before the plane governs at activateAt,
  // and the key is warm at the crossing. Rows with accepted history are
  // exempt: renewals and reclaims never wait on a height, so an activation
  // height configured above standing terms cannot demote a fleet. The
  // activation drain this replaces (serve nobody until activateAt + 20) is
  // gone: its job, stopping standbys racing at the height, is done by the
  // gate's running-only rule below the height.
  describe('the pre-window: the register opens before the plane governs', () => {
    afterEach(() => {
      grantorController.resetActivationForTests();
    });

    function atHeight(height) {
      daemonStatus.daemonSyncState.returns({ synced: true, height, header: height });
    }

    it('a virgin row is refused one block below the window and served from its first block', async () => {
      grantorController.resetActivationForTests({ activateAt: 100, preWindowBlocks: 40 });
      atHeight(59);
      const shut = fakeRes();
      await grantorController.probe(fakeReq(await worldAsk('probe')), shut);
      expect(shut.statusCode).to.equal(409);
      expect(shut.body.data.message).to.match(/the register opens for new keys at height 60/);

      atHeight(60);
      const served = fakeRes();
      await grantorController.probe(fakeReq(await worldAsk('probe')), served);
      expect(served.statusCode).to.equal(200);
    });

    it('a virgin row is served BELOW the activation height - that is the window', async () => {
      grantorController.resetActivationForTests({ activateAt: 100, preWindowBlocks: 40 });
      atHeight(99);
      const res = fakeRes();
      await grantorController.probe(fakeReq(await worldAsk('probe')), res);
      expect(res.statusCode).to.equal(200);
    });

    it('the window is a config knob beside the activation height, 40 blocks by default', async () => {
      grantorController.resetActivationForTests({ activateAt: 100 });
      atHeight(59);
      const shut = fakeRes();
      await grantorController.probe(fakeReq(await worldAsk('probe')), shut);
      expect(shut.statusCode).to.equal(409);
      expect(shut.body.data.message).to.match(/at height 60/);
    });

    it('a row with accepted history is exempt - renewals never wait on a height', async () => {
      grantorController.resetActivationForTests({ activateAt: 100, preWindowBlocks: 40 });
      atHeight(59);
      grantRegister.read.resolves({ accepted: { epoch: 2, grantee: 'x:1', mode: 'held' } });

      const res = fakeRes();
      await grantorController.probe(fakeReq(await worldAsk('probe')), res);
      expect(res.statusCode).to.equal(200);
    });

    it('the founder plane never waits on a height', async () => {
      grantorController.resetActivationForTests({ activateAt: 100, preWindowBlocks: 40 });
      atHeight(59);

      const res = fakeRes();
      await grantorController.probe(
        fakeReq(await worldAsk('probe', { key: FOUNDER_KEY, mode: 'oneshot' })), res,
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
      await grantorController.prepare(fakeReq(await worldAsk('prepare')), refused);
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
        fakeReq(await worldAsk('probe', { key: FOUNDER_KEY, mode: 'oneshot' })), res,
      );
      expect(res.statusCode).to.equal(200);
    });

    it('serves once the provider answers ready, and the reopening stamps the lock-delay anchor', async () => {
      let ready = false;
      grantorController.registerSyncReadyProvider(() => ready);
      await grantorController.prepare(fakeReq(await worldAsk('prepare')), fakeRes());

      const before = Date.now();
      ready = true;
      const res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare')), res);
      expect(res.statusCode).to.equal(200);
      const context = grantRegister.prepare.lastCall.args[2];
      expect(context.servingSinceMs).to.be.at.least(before);
    });

    it('an unregistered or throwing provider fails closed', async () => {
      grantorController.registerSyncReadyProvider(null);
      const unregistered = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare')), unregistered);
      expect(unregistered.statusCode).to.equal(503);

      grantorController.registerSyncReadyProvider(() => { throw new Error('boom'); });
      const throwing = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare')), throwing);
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
      daemonStatus.daemonSyncState.returns({ synced: false, height: 0 });
      const staleRes = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare')), staleRes);
      expect(staleRes.statusCode).to.equal(503);

      const before = Date.now();
      daemonStatus.daemonSyncState.returns({ synced: true, height: 100, header: 100 });
      const res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare')), res);
      expect(res.statusCode).to.equal(200);
      const context = grantRegister.prepare.lastCall.args[2];
      expect(context, 'the register call must carry the anchor context').to.be.an('object');
      expect(context.servingSinceMs).to.be.at.least(before);
      expect(context.servingSinceMs).to.be.at.most(Date.now());
    });

    it('a stale spell observed only by the record read still moves the anchor', async () => {
      daemonStatus.daemonSyncState.returns({ synced: false, height: 0 });
      const readReq = fakeReq({});
      readReq.query.key = 'myapp/master';
      await grantorController.record(readReq, fakeRes());

      const before = Date.now();
      daemonStatus.daemonSyncState.returns({ synced: true, height: 100, header: 100 });
      const res = fakeRes();
      await grantorController.accept(fakeReq(await worldAsk('accept')), res);
      expect(res.statusCode).to.equal(200);
      const context = grantRegister.accept.lastCall.args[2];
      expect(context, 'the register call must carry the anchor context').to.be.an('object');
      expect(context.servingSinceMs).to.be.at.least(before);
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
      await grantorController.prepare(fakeReq(await worldAsk('prepare')), res);
      expect(res.statusCode).to.equal(200);
      const context = grantRegister.prepare.lastCall.args[2];
      expect(context, 'the register call must carry the anchor context').to.be.an('object');
      expect(context.servingSinceMs).to.be.at.least(before);
    });
  });

  // The carried credential (STEP_ACROSS_DESIGN.md D2): a prepare or accept may
  // carry the retired world's basis and a quorum of its signed term
  // acceptances, outside the ask's signature like a roster chain. The
  // controller resolves the carried basis's membership and the standing
  // generation, verifies through the overlay with real signatures, and hands
  // the register the verified incumbent — or null, in which case the ask is a
  // stranger's and proceeds as one. A malformed credential is refused whole.
  describe('the carried credential', () => {
    const RETIRED_FP = 'e'.repeat(64);
    const retiredKeys = [0, 1, 2, 3, 4].map((i) => {
      const priv = Buffer.alloc(32); priv.writeUInt32BE(i + 11, 28);
      return { wif: bs58check.encode(Buffer.concat([Buffer.from([0x80]), priv])), pubkey: Buffer.from(secp256k1.publicKeyCreate(priv, false)).toString('hex') };
    });
    const retired = retiredKeys.map((k, i) => ({ txhash: String(i + 5).repeat(64).slice(0, 64), outidx: 0, pubkey: k.pubkey, ip: `10.${i + 20}.0.1:16127` }));
    const outpointOf = (n) => `${n.txhash}:${n.outidx}`;
    const credentialFor = (grantee, epoch, signers = retired, generation = 0, generationHeight = null) => ({
      fingerprint: RETIRED_FP,
      generation,
      generationHeight,
      epoch,
      roster: null,
      acceptances: signers.map((node, i) => {
        const fields = signedEnvelope.fieldsFor('termaccept', {
          key: 'myapp/master', fingerprint: RETIRED_FP, generation, generationHeight, epoch, grantee,
        });
        return { grantor: outpointOf(node), signature: signedEnvelope.sign('termaccept', fields, retiredKeys[i].wif).signature };
      }),
    });
    beforeEach(() => {
      networkStateService.membershipAt.restore();
      sinon.stub(networkStateService, 'membershipAt').callsFake((fp) => (fp === RETIRED_FP ? retired : fixtureFleet()));
      // the standing world is generation 1, its drain over, the registration's below it
      messageStore.getGrantGenerationRecord.resolves({ data: { generation: 1, height: 50 } });
      messageStore.predecessorWorld.resolves({ generation: 0, height: null });
    });

    it('after a v8 sale steps the app back to generation 0, a credential from the seller\'s generation 1 verifies: it is the world that stood before', async () => {
      messageStore.standingGeneration.resolves({ record: null, aside: false, ownership: { owner: 'buyer', from: 30, transferred: true } });
      // the seller re-rolled to 1 at height 20; the buyer's world is the registration's from 30
      messageStore.predecessorWorld.resolves({ generation: 1, height: 20 });
      await grantorController.prepare(fakeReq(await worldAsk('prepare', {
        generation: 0, generationHeight: 30, carried: credentialFor(ASKER, 4, retired, 1, 20),
      })), fakeRes());
      expect(grantRegister.prepare.lastCall.args[2].carriedIncumbent).to.equal(ASKER);
      expect(messageStore.predecessorWorld.lastCall.args).to.deep.equal(['myapp', 'master']);
      await grantorController.prepare(fakeReq(await worldAsk('prepare', {
        generation: 0, generationHeight: 30, carried: credentialFor(ASKER, 4, retired, 1, null),
      })), fakeRes());
      expect(grantRegister.prepare.lastCall.args[2].carriedIncumbent, 'the seller\'s generation in another world').to.equal(null);
    });

    it('with no world this cell can name before the standing one, no credential verifies', async () => {
      messageStore.predecessorWorld.resolves(null);
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { generation: 1, carried: credentialFor(ASKER, 4) })), fakeRes());
      expect(grantRegister.prepare.lastCall.args[2].carriedIncumbent).to.equal(null);
    });

    it('a valid credential reaches the register as the verified incumbent', async () => {
      const res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { generation: 1, carried: credentialFor(ASKER, 4) })), res);
      expect(res.statusCode).to.equal(200);
      const context = grantRegister.prepare.lastCall.args[2];
      expect(context.carriedIncumbent).to.equal(ASKER);
      await grantorController.accept(fakeReq(await worldAsk('accept', { generation: 1, carried: credentialFor(ASKER, 4) })), fakeRes());
      expect(grantRegister.accept.lastCall.args[2].carriedIncumbent).to.equal(ASKER);
    });

    it('a credential that does not verify makes the ask a stranger\'s, not a refusal', async () => {
      const res = fakeRes();
      const other = `${'9'.repeat(64)}:0`;
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { generation: 1, carried: credentialFor(other, 4) })), res);
      expect(res.statusCode).to.equal(200);
      expect(grantRegister.prepare.lastCall.args[2].carriedIncumbent).to.equal(null);
      const unknownBasis = { ...credentialFor(ASKER, 4), fingerprint: 'd'.repeat(64) };
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { generation: 1, carried: unknownBasis })), fakeRes());
      expect(grantRegister.prepare.lastCall.args[2].carriedIncumbent).to.equal(null);
    });

    it('an ask without a credential carries null; a malformed one is refused whole', async () => {
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { generation: 1 })), fakeRes());
      expect(grantRegister.prepare.lastCall.args[2].carriedIncumbent).to.equal(null);
      const res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { generation: 1, carried: { fingerprint: RETIRED_FP, acceptances: 'x' } })), res);
      expect(res.statusCode).to.equal(400);
      expect(res.body.data.message).to.match(/malformed credential/);
    });
  });

  // The serving word (formal/quiet-window DrainAwareCoast, rows 23 and 29–31):
  // whether this cell would SERVE an ask for the key right now. `refereeing`
  // deliberately excludes the drains (a draining cell is refereeing and must
  // count as such for everything but the coast); `serving` is refereeing AND
  // the rejoin drain over AND the key's generation not draining. The witness
  // counts only serving cells, so a restart wave reads as committee-down and
  // the incumbent coasts instead of demoting.
  describe('the record read answers serving', () => {
    beforeEach(() => {
      sinon.stub(grantRegister, 'drainRemainingMs').returns(0);
    });
    const readRecord = async () => {
      const req = fakeReq({});
      req.query.key = 'myapp/master';
      const res = fakeRes();
      await grantorController.record(req, res);
      return res.body.data;
    };

    it('serving is true when the cell referees and no drain stands', async () => {
      const data = await readRecord();
      expect(data.refereeing).to.equal(true);
      expect(data.serving).to.equal(true);
    });

    it('the rejoin drain makes the cell non-serving while it still referees', async () => {
      grantRegister.drainRemainingMs.returns(45_000);
      const data = await readRecord();
      expect(data.refereeing).to.equal(true);
      expect(data.serving).to.equal(false);
    });

    it("the key's generation drain makes the cell non-serving for that key, and serving once it lifts", async () => {
      messageStore.getGrantGenerationRecord.resolves({ data: { generation: 1, height: 95 } });
      daemonStatus.daemonSyncState.returns({ synced: true, height: 100, header: 100 });
      expect((await readRecord()).serving).to.equal(false);
      daemonStatus.daemonSyncState.returns({ synced: true, height: 115, header: 115 });
      expect((await readRecord()).serving).to.equal(true);
    });

    it('a sale\'s drain at generation zero makes the cell non-serving, and serving once it lifts', async () => {
      // the sale applied at 200 and named no record: the registration's
      // committee drains until 220
      messageStore.standingGeneration.resolves({ record: null, aside: false, ownership: { owner: 'buyer', from: 200, transferred: true } });
      daemonStatus.daemonSyncState.returns({ synced: true, height: 210, header: 210 });
      expect((await readRecord()).serving).to.equal(false);
      daemonStatus.daemonSyncState.returns({ synced: true, height: 220, header: 220 });
      expect((await readRecord()).serving).to.equal(true);
    });

    it('a cell that does not hold the record the spec names is not serving', async () => {
      messageStore.standingGeneration.resolves({ record: null, aside: true, ownership: { owner: 'buyer', from: 200, transferred: true } });
      daemonStatus.daemonSyncState.returns({ synced: true, height: 300, header: 300 });
      const data = await readRecord();
      expect(data.refereeing).to.equal(true);
      expect(data.serving).to.equal(false);
    });

    it('a cell that is not refereeing is not serving either', async () => {
      grantorController.registerSyncReadyProvider(() => false);
      const data = await readRecord();
      expect(data.refereeing).to.equal(false);
      expect(data.serving).to.equal(false);
    });
  });

  // A witness asks each cell whether it would seat the witness's node now:
  // the register's prepare decision for that candidate in the cell's standing
  // world, the epoch out of reach — what the cell would actually do, not
  // whether it merely serves.
  describe('the record read answers whether it would seat a candidate', () => {
    const CANDIDATE = `${'c'.repeat(64)}:0`;
    beforeEach(() => {
      sinon.stub(grantRegister, 'drainRemainingMs').returns(0);
    });
    const readFor = async (candidate) => {
      const req = fakeReq({});
      req.query.key = 'myapp/master';
      if (candidate !== undefined) req.query.candidate = candidate;
      const res = fakeRes();
      await grantorController.record(req, res);
      return res.body.data;
    };

    it('seats is the register\'s answer to a prepare from the candidate, in the cell\'s standing world, no epoch in the way', async () => {
      messageStore.standingGeneration.resolves({ record: null, aside: false, ownership: { owner: 'buyer', from: 200, transferred: true } });
      daemonStatus.daemonSyncState.returns({ synced: true, height: 230, header: 230 });
      grantRegister.probe.resolves({ ok: false, code: 'lock_delay', retryAfterMs: 9000 });
      expect((await readFor(CANDIDATE)).seats).to.equal(false);
      const [key, request, context] = grantRegister.probe.lastCall.args;
      expect(key).to.equal('myapp/master');
      expect(request).to.deep.include({
        mode: 'held', candidate: CANDIDATE, generation: 0, generationHeight: 200, epoch: Number.MAX_SAFE_INTEGER,
      });
      expect(context.worldDrained, 'the sale\'s world drained, so its empty seats wait').to.equal(true);
      expect(context.servingSinceMs).to.be.a('number');

      grantRegister.probe.resolves({ ok: true, probe: true });
      expect((await readFor(CANDIDATE)).seats).to.equal(true);
    });

    it('a cell that does not serve the key seats nobody, and asks its register nothing', async () => {
      grantRegister.drainRemainingMs.returns(45_000);
      expect((await readFor(CANDIDATE)).seats).to.equal(false);
      expect(grantRegister.probe.called).to.equal(false);
    });

    it('a read naming no candidate, or a malformed one, answers no seat verdict', async () => {
      expect(await readFor()).to.not.have.property('seats');
      expect(await readFor('not-an-outpoint')).to.not.have.property('seats');
      expect(grantRegister.probe.called).to.equal(false);
    });
  });

  // The re-rolled seat's anchor (formal/quiet-window, DrainLiftAnchoredLockDelay
  // and its receipt half): a re-rolled generation's seat at this cell is empty,
  // and the generation drain and the record's receipt both close the register
  // to it without ageing any row. The controller stamps the moment this cell
  // FIRST served under the standing generation past its drain — later than
  // the lift and the receipt, the safe side — once per generation, and the
  // register anchors the successor's wait at the later of that and the
  // refereeing return. Generation zero is an app's birth and stamps nothing.
  describe('the re-rolled generation serving-since anchor', () => {
    const tick = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
    const rerolled = (generation, height) => {
      messageStore.getGrantGenerationRecord.resolves({ data: { generation, height } });
    };
    const viewAt = (height) => {
      daemonStatus.daemonSyncState.returns({ synced: true, height, header: height });
    };

    it('the first ask served under a re-rolled generation stamps the anchor past the refereeing return', async () => {
      rerolled(1, 95);
      viewAt(115);
      // the refereeing return is observed at the very first ask, whatever it asks
      const retired = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { generation: 0 })), retired);
      expect(retired.statusCode).to.equal(409);
      await tick(5);

      const before = Date.now();
      const res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { generation: 1 })), res);
      expect(res.statusCode).to.equal(200);
      const context = grantRegister.prepare.lastCall.args[2];
      expect(context, 'the register call must carry the anchor context').to.be.an('object');
      expect(context.servingSinceMs).to.be.at.least(before);
      expect(context.servingSinceMs).to.be.at.most(Date.now());
    });

    it('a release naming a retired generation does not stamp the standing generation\'s anchor', async () => {
      rerolled(1, 95);
      viewAt(115);
      const released = fakeRes();
      await grantorController.release(fakeReq(await worldAsk('release', { generation: 0 })), released);
      expect(released.statusCode).to.equal(200);
      await tick(5);

      const before = Date.now();
      const res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { generation: 1 })), res);
      expect(res.statusCode).to.equal(200);
      expect(grantRegister.prepare.lastCall.args[2].servingSinceMs, 'the anchor is the first standing-generation ask, not the release')
        .to.be.at.least(before);
    });

    it('the stamp is made once: a later ask under the same generation carries the same moment', async () => {
      rerolled(1, 95);
      viewAt(115);
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { generation: 1 })), fakeRes());
      const first = grantRegister.prepare.lastCall.args[2].servingSinceMs;
      await tick(5);
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { generation: 1 })), fakeRes());
      expect(grantRegister.prepare.lastCall.args[2].servingSinceMs).to.equal(first);
    });

    it('a generation still draining stamps nothing — the anchor is the first serve past the lift', async () => {
      rerolled(1, 95);
      viewAt(100);
      const draining = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { generation: 1 })), draining);
      expect(draining.statusCode).to.equal(409);
      expect(draining.body.data.message).to.match(/draining/);
      await tick(5);

      const before = Date.now();
      viewAt(115);
      const res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { generation: 1 })), res);
      expect(res.statusCode).to.equal(200);
      expect(grantRegister.prepare.lastCall.args[2].servingSinceMs).to.be.at.least(before);
    });

    it('a newer generation re-stamps at its own first serve', async () => {
      rerolled(1, 95);
      viewAt(115);
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { generation: 1 })), fakeRes());
      const first = grantRegister.prepare.lastCall.args[2].servingSinceMs;
      await tick(5);

      const before = Date.now();
      rerolled(2, 110);
      viewAt(130);
      const res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { generation: 2 })), res);
      expect(res.statusCode).to.equal(200);
      const stamped = grantRegister.prepare.lastCall.args[2].servingSinceMs;
      expect(stamped).to.be.at.least(before);
      expect(stamped).to.be.above(first);
    });

    it('past a sale\'s drain the first serve stamps the anchor, so a successor\'s wait starts at the lift', async () => {
      messageStore.standingGeneration.resolves({ record: null, aside: false, ownership: { owner: 'buyer', from: 200, transferred: true } });
      viewAt(210);
      const draining = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { generation: 0 })), draining);
      expect(draining.statusCode).to.equal(409);
      expect(draining.body.data.message).to.contain('draining until height 220');
      await tick(5);

      const before = Date.now();
      viewAt(220);
      const res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { generation: 0 })), res);
      expect(res.statusCode).to.equal(200);
      expect(grantRegister.prepare.lastCall.args[2].servingSinceMs).to.be.at.least(before);
    });

    it("generation zero stamps nothing beyond the refereeing return — an app's birth is not a re-roll", async () => {
      // the refereeing return is stamped at the first ask of all; a FIRST ask
      // about another key, later, must carry that same return and nothing
      // of its own — the stamp is per key, so only a second key can tell
      await grantorController.prepare(fakeReq(await worldAsk('prepare')), fakeRes());
      const returned = grantRegister.prepare.lastCall.args[2].servingSinceMs;
      await tick(5);
      const before = Date.now();
      const res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { key: 'otherapp/master' })), res);
      expect(res.statusCode).to.equal(200);
      const other = grantRegister.prepare.lastCall.args[2].servingSinceMs;
      expect(other).to.equal(returned);
      expect(other).to.be.below(before);
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
      await grantorController.prepare(fakeReq(await worldAsk('prepare')), res);
      expect(res.statusCode).to.equal(409);
      expect(res.body.data.generation).to.equal(2);
      expect(res.body.data.generationRecord).to.deep.equal(RECORD);
    });

    it('the serve gates teach too — a stale or syncing cell still says which world stands', async () => {
      messageStore.getGrantGenerationRecord.resolves({ data: RECORD });
      daemonStatus.daemonSyncState.returns({ synced: false, height: 100, header: 130 });
      const stale = fakeRes();
      await grantorController.renew(fakeReq(await worldAsk('renew')), stale);
      expect(stale.statusCode).to.equal(503);
      expect(stale.body.data.generation).to.equal(2);
      expect(stale.body.data.generationRecord).to.deep.equal(RECORD);

      daemonStatus.daemonSyncState.returns({ synced: true, height: 100, header: 100 });
      grantorController.registerSyncReadyProvider(() => false);
      const syncing = fakeRes();
      await grantorController.renew(fakeReq(await worldAsk('renew')), syncing);
      expect(syncing.statusCode).to.equal(503);
      expect(syncing.body.data.generation).to.equal(2);
      expect(syncing.body.data.generationRecord).to.deep.equal(RECORD);
    });

    it('a holdership 403 teaches — an asker off the app is still told what world it asked in', async () => {
      messageStore.getGrantGenerationRecord.resolves({ data: RECORD });
      registryManager.appLocationOf.resolves([]);
      const res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { generation: 2 })), res);
      expect(res.statusCode).to.equal(403);
      expect(res.body.data.generation).to.equal(2);
      expect(res.body.data.generationRecord).to.deep.equal(RECORD);
    });

    it('an app the owner never re-rolled teaches generation 0 and no record', async () => {
      daemonStatus.daemonSyncState.returns({ synced: false, height: 100, header: 130 });
      const res = fakeRes();
      await grantorController.renew(fakeReq(await worldAsk('renew')), res);
      expect(res.statusCode).to.equal(503);
      expect(res.body.data.generation).to.equal(0);
      expect(res.body.data.generationRecord).to.equal(null);
    });

    it('a refusal before the key is read teaches nothing — there is no key to answer for', async () => {
      messageStore.getGrantGenerationRecord.resolves({ data: RECORD });
      const res = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { key: 'bad key' })), res);
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

    it('a refusal and a record read name the height the standing world took over at: a sale naming no record teaches generation 0 from the sale', async () => {
      messageStore.standingGeneration.resolves({ record: null, aside: false, ownership: { owner: 'buyer', from: 90, transferred: true } });
      const refused = fakeRes();
      await grantorController.prepare(fakeReq(await worldAsk('prepare', { generation: 2 })), refused);
      expect(refused.statusCode).to.equal(409);
      expect(refused.body.data).to.include({ generation: 0, height: 90 });
      const req = fakeReq({});
      req.query.key = 'myapp/master';
      const read = fakeRes();
      await grantorController.record(req, read);
      expect(read.body.data).to.include({ generation: 0, height: 90 });
    });

    it('an app that never changed hands teaches no takeover height', async () => {
      const req = fakeReq({});
      req.query.key = 'myapp/master';
      const read = fakeRes();
      await grantorController.record(req, read);
      expect(read.body.data).to.include({ generation: 0, height: null });
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
