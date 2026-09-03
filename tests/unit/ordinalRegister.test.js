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
const downCertificates = require('../../ZelBack/src/services/quorumGrant/downCertificates');
const networkStateService = require('../../ZelBack/src/services/networkStateService');

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
const THIRD = `${'d'.repeat(64)}:1`;
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
    sinon.stub(downCertificates, 'standingCertificateFor').resolves(null);
    sinon.stub(networkStateService, 'membershipFingerprint').returns('f'.repeat(64));
    sinon.stub(networkStateService, 'membershipAt').returns([
      { txhash: SELF_TXHASH, outidx: 0, ip: '10.0.0.5:16127' },
      { txhash: 'b'.repeat(64), outidx: 0, ip: '10.0.0.7:16127' },
    ]);
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

  // R9 (NODE_DOWN_SCENARIOS.md §5): the ordinal vacate follows the
  // derivation's placement-dead edge — the same moment a replacement may be
  // placed — observed on a host's pass and acted on once, never on a timer.
  // The edge is read off the derived locations (a certified node's rows stay
  // until since + the grace, then go; an announce inside the grace refutes),
  // never recomputed; the certificate is the vacate's authority and rides
  // the ask whole. The register's own probe says whether there is anything
  // to vacate at all.
  describe("vacateOrdinal — reclaim by certificate at the derivation's edge", () => {
    const CERT = {
      subject: OTHER, fingerprint: 'c'.repeat(64), height: 100, verdicts: [], since: 1_000, reason: 'unannounced',
    };

    it('vacates a certified holder the derivation no longer places, carrying the certificate, and publishes its row released', async () => {
      downCertificates.standingCertificateFor.resolves({ ...CERT, broadcastedAt: 5_000 });
      grantClient.probeOneshot.resolves({ decided: true, holder: OTHER, epoch: 2 });
      expect(await ordinalRegister.vacateOrdinal('myapp', 1, OTHER)).to.deep.equal({ vacated: true });
      expect(downCertificates.standingCertificateFor.calledOnceWith(OTHER)).to.equal(true);
      expect(grantClient.vacateOneshot.calledOnce).to.equal(true);
      const [key, committee, cert] = grantClient.vacateOneshot.firstCall.args;
      expect(key).to.equal(`myapp/ordinal-1@${RUNG}`);
      expect(committee).to.deep.include({ fingerprint: COMMITTEE.fingerprint });
      expect(cert, 'the certificate travels as gossiped, without the store\'s broadcastedAt').to.deep.equal(CERT);
      const published = masterleasePublisher.publishMasterlease.firstCall.args[0];
      expect(published).to.deep.include({ key: `myapp/ordinal-1@${RUNG}`, grantee: OTHER, epoch: 2, released: true });
      expect(events).to.deep.equal([{ name: 'quorumGrant:ordinalVacated', payload: { appName: 'myapp', ordinal: 1, holder: OTHER } }]);
    });

    it('no standing certificate: nothing is probed, nothing is asked', async () => {
      expect(await ordinalRegister.vacateOrdinal('myapp', 1, OTHER)).to.deep.equal({ vacated: false, reason: 'no standing certificate' });
      expect(grantClient.probeOneshot.called).to.equal(false);
      expect(grantClient.vacateOneshot.called).to.equal(false);
    });

    it("a certified holder the derivation still places is not vacated — the edge is the view's, not a clock's", async () => {
      downCertificates.standingCertificateFor.resolves({ ...CERT, broadcastedAt: 5_000 });
      registryManager.appLocation.resolves([{ ip: '10.0.0.7:16127' }, { ip: '10.0.0.5:16127' }]);
      expect(await ordinalRegister.vacateOrdinal('myapp', 1, OTHER)).to.deep.equal({ vacated: false, reason: 'still placed' });
      expect(grantClient.vacateOneshot.called).to.equal(false);
      expect(events).to.deep.equal([]);
    });

    it('a vacate without a quorum publishes nothing', async () => {
      downCertificates.standingCertificateFor.resolves({ ...CERT, broadcastedAt: 5_000 });
      grantClient.probeOneshot.resolves({ decided: true, holder: OTHER, epoch: 2 });
      grantClient.vacateOneshot.resolves(false);
      expect(await ordinalRegister.vacateOrdinal('myapp', 1, OTHER)).to.deep.equal({ vacated: false, reason: 'no vacate quorum' });
      expect(masterleasePublisher.publishMasterlease.called).to.equal(false);
      expect(events).to.deep.equal([]);
    });

    it("the register's own word decides: another holder vacates nothing, a free row needs no vacate, undecided waits", async () => {
      downCertificates.standingCertificateFor.resolves({ ...CERT, broadcastedAt: 5_000 });
      grantClient.probeOneshot.resolves({ decided: true, holder: THIRD, epoch: 3 });
      expect(await ordinalRegister.vacateOrdinal('myapp', 1, OTHER)).to.deep.equal({ vacated: false, reason: `held by ${THIRD}` });
      grantClient.probeOneshot.resolves({ decided: true, holder: null, epoch: 0 });
      expect(await ordinalRegister.vacateOrdinal('myapp', 1, OTHER)).to.deep.equal({ vacated: true });
      grantClient.probeOneshot.resolves({ decided: false, holder: null, epoch: 0 });
      expect(await ordinalRegister.vacateOrdinal('myapp', 1, OTHER)).to.deep.equal({ vacated: false, reason: 'no quorum answered' });
      expect(grantClient.vacateOneshot.called).to.equal(false);
    });

    it('a holder no longer on the node list is not placed; an unresolvable membership fails closed', async () => {
      downCertificates.standingCertificateFor.resolves({ ...CERT, broadcastedAt: 5_000 });
      grantClient.probeOneshot.resolves({ decided: true, holder: OTHER, epoch: 2 });
      networkStateService.membershipAt.returns([{ txhash: SELF_TXHASH, outidx: 0, ip: '10.0.0.5:16127' }]);
      expect(await ordinalRegister.vacateOrdinal('myapp', 1, OTHER)).to.deep.equal({ vacated: true });
      networkStateService.membershipAt.returns(null);
      expect(await ordinalRegister.vacateOrdinal('myapp', 1, OTHER)).to.deep.equal({ vacated: false, reason: 'membership unavailable' });
      expect(grantClient.vacateOneshot.calledOnce).to.equal(true);
    });

    it('a malformed holder is refused without a read', async () => {
      expect(await ordinalRegister.vacateOrdinal('myapp', 1, null)).to.deep.equal({ vacated: false, reason: 'malformed holder' });
      expect(downCertificates.standingCertificateFor.called).to.equal(false);
    });
  });
});
