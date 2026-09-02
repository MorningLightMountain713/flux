'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const generalService = require('../../ZelBack/src/services/generalService');
const messageStore = require('../../ZelBack/src/services/appMessaging/messageStore');
const registryManager = require('../../ZelBack/src/services/appDatabase/registryManager');
const daemonServiceMiscRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceMiscRpcs');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const fluxEventBus = require('../../ZelBack/src/services/utils/fluxEventBus');
const foundingCommittee = require('../../ZelBack/src/services/appMesh/foundingCommittee');
const grantClient = require('../../ZelBack/src/services/quorumGrant/grantClient');
const masterleasePublisher = require('../../ZelBack/src/services/quorumGrant/masterleasePublisher');
const ordinalRegisterSeam = require('../../ZelBack/src/services/appMesh/ordinalRegisterSeam');
const ordinalRegister = require('../../ZelBack/src/services/quorumGrant/ordinalRegister');

// The plane half of ordinals-as-grants, behind the mesh's seam. What is
// asserted: the key the plane addresses (the app's FIRST world's rung, the
// founder plane's generation), the four answers' mapping onto the grant
// outcomes, that "yes" is durable from the node's own record and "no" never
// comes from a record, that a release and a vacate publish a superseding
// record, and that a certificate reclaims every ordinal its subject holds —
// from a host of the app only.

const SELF_TXHASH = 'a'.repeat(64);
const SELF = `${SELF_TXHASH}:0`;
const OTHER = `${'b'.repeat(64)}:0`;
const RUNG = 500000;
const COMMITTEE = {
  fingerprint: 'c'.repeat(64),
  quorum: 5,
  members: [],
};

function row(ordinal, grantee, overrides = {}) {
  return {
    dedupKey: `masterlease:myapp/ordinal-${ordinal}@${overrides.rung ?? RUNG}`,
    data: {
      appName: 'myapp',
      role: `ordinal-${ordinal}@${overrides.rung ?? RUNG}`,
      mode: 'oneshot',
      grantee,
      epoch: overrides.epoch ?? 1,
      generation: overrides.generation ?? 0,
      ...(overrides.released ? { released: true } : {}),
    },
  };
}

describe('quorumGrant ordinalRegister', () => {
  let events;

  beforeEach(() => {
    events = [];
    sinon.stub(fluxEventBus, 'publish').callsFake((name, payload) => events.push({ name, payload }));
    sinon.stub(foundingCommittee, 'appWorld').resolves({ intro: RUNG, rungs: [RUNG], armed: false });
    sinon.stub(foundingCommittee, 'refereeCommittee').resolves(COMMITTEE);
    sinon.stub(messageStore, 'getGrantGenerationRecord').resolves(null);
    sinon.stub(messageStore, 'getMasterleaseRecordsByRolePrefix').resolves([]);
    sinon.stub(messageStore, 'getMasterleaseRecordsByGrantee').resolves([]);
    sinon.stub(generalService, 'obtainNodeCollateralInformation').resolves({ txhash: SELF_TXHASH, txindex: 0 });
    sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({ status: 'success', data: { synced: true } });
    sinon.stub(grantClient, 'probeOneshot').resolves({ decided: true, holder: null, epoch: 0 });
    sinon.stub(grantClient, 'acquire').resolves({ granted: true, founder: SELF });
    sinon.stub(grantClient, 'releaseOneshot').resolves(true);
    sinon.stub(grantClient, 'vacateOneshot').resolves(true);
    sinon.stub(masterleasePublisher, 'publishMasterlease').resolves(true);
    sinon.stub(registryManager, 'appLocation').resolves([{ ip: '10.0.0.5:16127' }]);
    sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('10.0.0.5:16127');
  });

  afterEach(() => {
    sinon.restore();
    ordinalRegisterSeam.resetForTests();
  });

  describe('the key', () => {
    it("addresses the app's FIRST world at its newest rung, and the founder plane's generation", async () => {
      foundingCommittee.appWorld.resolves({ intro: RUNG, rungs: [RUNG, RUNG + 200], armed: false });
      messageStore.getGrantGenerationRecord.resolves({ data: { generation: 2 } });
      await ordinalRegister.askOrdinal('myapp', 3);
      const [key, options] = grantClient.acquire.firstCall.args;
      expect(key).to.equal(`myapp/ordinal-3@${RUNG + 200}`);
      expect(options.mode).to.equal('oneshot');
      expect(options.committee).to.deep.include({ fingerprint: COMMITTEE.fingerprint, generation: 2 });
      expect(foundingCommittee.refereeCommittee.calledOnceWith('myapp', RUNG + 200)).to.equal(true);
    });

    it('role arithmetic round-trips', () => {
      expect(ordinalRegister.roleFor(7, 12)).to.equal('ordinal-7@12');
      expect(ordinalRegister.parseRole('ordinal-7@12')).to.deep.equal({ ordinal: 7, rung: 12 });
      expect(ordinalRegister.parseRole('founder-0123456789abcdef@12')).to.equal(null);
      expect(ordinalRegister.parseRole('master')).to.equal(null);
    });
  });

  describe('probeOrdinal', () => {
    it('is the quorum verdict, and undecided without a basis', async () => {
      grantClient.probeOneshot.resolves({ decided: true, holder: OTHER, epoch: 4 });
      expect(await ordinalRegister.probeOrdinal('myapp', 0)).to.deep.equal({ decided: true, holder: OTHER });
      expect(grantClient.probeOneshot.firstCall.args[0]).to.equal(`myapp/ordinal-0@${RUNG}`);
      // the fold's undecided is the seam's undecided: a quorum that did not
      // answer is never "free"
      grantClient.probeOneshot.resolves({ decided: false, holder: null, epoch: 0 });
      expect(await ordinalRegister.probeOrdinal('myapp', 0)).to.deep.equal({ decided: false, holder: null });
      foundingCommittee.appWorld.resolves(null);
      expect(await ordinalRegister.probeOrdinal('myapp', 0)).to.deep.equal({ decided: false, holder: null });
    });
  });

  describe('askOrdinal', () => {
    it('maps the grant outcomes onto yes / no-with-holder / wait-with-hint', async () => {
      expect(await ordinalRegister.askOrdinal('myapp', 0)).to.deep.equal({ answer: 'yes' });
      expect(events.map((e) => e.name)).to.deep.equal(['quorumGrant:ordinalFounded']);
      expect(events[0].payload).to.deep.equal({ appName: 'myapp', ordinal: 0, holder: SELF });

      grantClient.acquire.resolves({ granted: false, founder: OTHER });
      expect(await ordinalRegister.askOrdinal('myapp', 0)).to.deep.equal({ answer: 'no', holder: OTHER });

      grantClient.acquire.resolves({ granted: false, retryAfterMs: 4000 });
      expect(await ordinalRegister.askOrdinal('myapp', 0)).to.deep.equal({ answer: 'wait', retryAfterMs: 4000 });

      grantClient.acquire.resolves({ granted: false, reason: 'no accept quorum' });
      expect(await ordinalRegister.askOrdinal('myapp', 0)).to.deep.equal({ answer: 'wait', reason: 'no accept quorum' });
    });

    it("yes is durable from the node's OWN record; another node's record never answers no", async () => {
      messageStore.getMasterleaseRecordsByRolePrefix.resolves([row(0, SELF)]);
      expect(await ordinalRegister.askOrdinal('myapp', 0)).to.deep.equal({ answer: 'yes' });
      expect(grantClient.acquire.called).to.equal(false);

      // a record naming someone else may lag their release: the committee
      // decides, never the record
      messageStore.getMasterleaseRecordsByRolePrefix.resolves([row(0, OTHER)]);
      expect(await ordinalRegister.askOrdinal('myapp', 0)).to.deep.equal({ answer: 'yes' });
      expect(grantClient.acquire.calledOnce).to.equal(true);

      // the node's own row, released: no durable yes any more
      messageStore.getMasterleaseRecordsByRolePrefix.resolves([row(0, SELF, { released: true })]);
      await ordinalRegister.askOrdinal('myapp', 0);
      expect(grantClient.acquire.calledTwice).to.equal(true);
    });

    it('the asker gates hold the round: no basis, a stale chain view, an armed world', async () => {
      daemonServiceMiscRpcs.isDaemonSynced.returns({ status: 'success', data: { synced: false } });
      expect(await ordinalRegister.askOrdinal('myapp', 0)).to.deep.equal({ answer: 'wait', reason: 'own chain view stale' });
      daemonServiceMiscRpcs.isDaemonSynced.returns({ status: 'success', data: { synced: true } });
      foundingCommittee.appWorld.resolves({ intro: RUNG, rungs: [RUNG], armed: true });
      expect(await ordinalRegister.askOrdinal('myapp', 0)).to.deep.equal({ answer: 'wait', reason: 'world armed' });
      foundingCommittee.refereeCommittee.resolves(null);
      expect(await ordinalRegister.askOrdinal('myapp', 0)).to.deep.equal({ answer: 'wait', reason: 'no founding basis' });
      expect(grantClient.acquire.called).to.equal(false);
    });
  });

  describe('releaseOrdinal', () => {
    it('releases the row the register names as this node\'s, then publishes it released', async () => {
      grantClient.probeOneshot.resolves({ decided: true, holder: SELF, epoch: 3 });
      expect(await ordinalRegister.releaseOrdinal('myapp', 2)).to.deep.equal({ released: true });
      expect(grantClient.releaseOneshot.calledOnceWith(`myapp/ordinal-2@${RUNG}`, sinon.match.object, 3)).to.equal(true);
      const published = masterleasePublisher.publishMasterlease.firstCall.args[0];
      expect(published).to.deep.include({
        key: `myapp/ordinal-2@${RUNG}`, grantee: SELF, epoch: 3, mode: 'oneshot', released: true, generation: 0,
      });
      expect(events.map((e) => e.name)).to.deep.equal(['quorumGrant:ordinalReleased']);
    });

    it('is a no-op success on a free row, a refusal on another\'s, undecided without a quorum', async () => {
      expect(await ordinalRegister.releaseOrdinal('myapp', 2)).to.deep.equal({ released: true });
      grantClient.probeOneshot.resolves({ decided: true, holder: OTHER, epoch: 3 });
      expect(await ordinalRegister.releaseOrdinal('myapp', 2)).to.deep.equal({ released: false, reason: `held by ${OTHER}` });
      grantClient.probeOneshot.resolves({ decided: false, holder: null, epoch: 0 });
      expect(await ordinalRegister.releaseOrdinal('myapp', 2)).to.deep.equal({ released: false, reason: 'no quorum answered' });
      expect(grantClient.releaseOneshot.called).to.equal(false);
      expect(masterleasePublisher.publishMasterlease.called).to.equal(false);
    });

    it('publishes nothing when the release reached no quorum', async () => {
      grantClient.probeOneshot.resolves({ decided: true, holder: SELF, epoch: 3 });
      grantClient.releaseOneshot.resolves(false);
      expect(await ordinalRegister.releaseOrdinal('myapp', 2)).to.deep.equal({ released: false, reason: 'no release quorum' });
      expect(masterleasePublisher.publishMasterlease.called).to.equal(false);
    });
  });

  describe('ordinalHolders', () => {
    it('reads the fleet-synced records: newest rung per ordinal, released rows free, the current generation only', async () => {
      messageStore.getGrantGenerationRecord.resolves({ data: { generation: 1 } });
      messageStore.getMasterleaseRecordsByRolePrefix.resolves([
        row(0, SELF, { generation: 1 }),
        row(1, OTHER, { generation: 1 }),
        row(1, OTHER, { generation: 1, rung: RUNG + 200, released: true }),
        row(2, OTHER, { generation: 0 }),
        row(3, SELF, { generation: 1, rung: RUNG - 100, released: true }),
        row(3, OTHER, { generation: 1 }),
      ]);
      const holders = await ordinalRegister.ordinalHolders('myapp');
      expect([...holders.entries()]).to.deep.equal([[0, SELF], [3, OTHER]]);
      expect(messageStore.getMasterleaseRecordsByRolePrefix.calledOnceWith('myapp', 'ordinal-')).to.equal(true);
    });
  });

  describe('noteCertificate — reclaim by certificate', () => {
    const CERT = { subject: OTHER, verdicts: [] };

    it('vacates every ordinal the subject holds, from a host of the app, and publishes each released', async () => {
      messageStore.getMasterleaseRecordsByGrantee.resolves([
        row(1, OTHER, { epoch: 2 }),
        row(4, OTHER, { epoch: 5, released: true }),
        { dedupKey: 'masterlease/other/ordinal-0@7', data: { appName: 'other', role: 'ordinal-0@7', mode: 'oneshot', grantee: OTHER, epoch: 1 } },
      ]);
      registryManager.appLocation.callsFake(async (appName) => (appName === 'myapp' ? [{ ip: '10.0.0.5:16127' }] : []));
      await ordinalRegister.noteCertificate(CERT);
      expect(messageStore.getMasterleaseRecordsByGrantee.calledOnceWith('ordinal-', OTHER)).to.equal(true);
      expect(grantClient.vacateOneshot.calledOnce).to.equal(true);
      const [key, committee, cert] = grantClient.vacateOneshot.firstCall.args;
      expect(key).to.equal(`myapp/ordinal-1@${RUNG}`);
      expect(committee).to.deep.include({ fingerprint: COMMITTEE.fingerprint });
      expect(cert).to.equal(CERT);
      const published = masterleasePublisher.publishMasterlease.firstCall.args[0];
      expect(published).to.deep.include({ key: `myapp/ordinal-1@${RUNG}`, grantee: OTHER, epoch: 2, released: true });
      expect(events).to.deep.equal([{ name: 'quorumGrant:ordinalVacated', payload: { appName: 'myapp', ordinal: 1, holder: OTHER } }]);
    });

    it('a node that does not host the app issues nothing; a vacate without a quorum publishes nothing', async () => {
      messageStore.getMasterleaseRecordsByGrantee.resolves([row(1, OTHER, { epoch: 2 })]);
      registryManager.appLocation.resolves([{ ip: '10.9.9.9:16127' }]);
      await ordinalRegister.noteCertificate(CERT);
      expect(grantClient.vacateOneshot.called).to.equal(false);

      registryManager.appLocation.resolves([{ ip: '10.0.0.5:16127' }]);
      grantClient.vacateOneshot.resolves(false);
      await ordinalRegister.noteCertificate(CERT);
      expect(grantClient.vacateOneshot.calledOnce).to.equal(true);
      expect(masterleasePublisher.publishMasterlease.called).to.equal(false);
      expect(events).to.deep.equal([]);
    });

    it('a malformed certificate is ignored', async () => {
      await ordinalRegister.noteCertificate(null);
      await ordinalRegister.noteCertificate({ subject: 7 });
      expect(messageStore.getMasterleaseRecordsByGrantee.called).to.equal(false);
    });
  });

  describe('the seam', () => {
    it('provider() is the full contract and registers cleanly', async () => {
      ordinalRegisterSeam.registerProvider(ordinalRegister.provider());
      expect(ordinalRegisterSeam.registered()).to.equal(true);
      grantClient.probeOneshot.resolves({ decided: true, holder: OTHER, epoch: 1 });
      expect(await ordinalRegisterSeam.probeOrdinal('myapp', 0)).to.deep.equal({ decided: true, holder: OTHER });
    });
  });
});
