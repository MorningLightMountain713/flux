'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const secp256k1 = require('secp256k1');
const bs58check = require('bs58check');

const fluxCommunicationUtils = require('../../ZelBack/src/services/fluxCommunicationUtils');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const networkStateService = require('../../ZelBack/src/services/networkStateService');
const generalService = require('../../ZelBack/src/services/generalService');
const registryManager = require('../../ZelBack/src/services/appDatabase/registryManager');
const messageStore = require('../../ZelBack/src/services/appMessaging/messageStore');
const foundingCommittee = require('../../ZelBack/src/services/appMesh/foundingCommittee');
const grantRegister = require('../../ZelBack/src/services/quorumGrant/grantRegister');
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

  describe('the founder plane — oneshot membership answers from the founding record', () => {
    it('an oneshot ask consults the founding committee, never the walk', async () => {
      const res = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare', { mode: 'oneshot' })), res);
      expect(res.statusCode).to.equal(200);
      expect(foundingCommittee.selfOnFoundingCommittee.calledOnceWith('myapp', FINGERPRINT)).to.equal(true);
      expect(networkStateService.membershipAt.called).to.equal(false);
      expect(messageStore.getGrantGenerationRecord.called).to.equal(false);
    });

    it('answers a basis its own window never covered — the record outlives the album', async () => {
      networkStateService.membershipAt.returns(null);
      const res = fakeRes();
      await grantorController.accept(fakeReq(signedAsk('accept', { mode: 'oneshot', ttlMs: undefined })), res);
      expect(res.statusCode).to.equal(200);
      expect(grantRegister.accept.calledOnce).to.equal(true);
    });

    it('409 naming the reason when the founding committee refuses this node', async () => {
      foundingCommittee.selfOnFoundingCommittee.resolves({
        member: false, reason: 'ask names a different committee basis',
      });
      const res = fakeRes();
      await grantorController.prepare(fakeReq(signedAsk('prepare', { mode: 'oneshot' })), res);
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

    it('a freshly seated replacement answers once the ask carries the chain that seats it', async () => {
      generalService.obtainNodeCollateralInformation.resolves({
        txhash: added.txhash, txindex: added.outidx,
      });

      const bareRes = fakeRes();
      await grantorController.renew(fakeReq(signedAsk('renew')), bareRes);
      expect(bareRes.statusCode).to.equal(409);

      const chainRes = fakeRes();
      await grantorController.renew(fakeReq(signedAsk('renew', { chain })), chainRes);
      expect(chainRes.statusCode).to.equal(200);
      expect(grantRegister.renew.calledOnce).to.equal(true);
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
