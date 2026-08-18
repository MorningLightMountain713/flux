'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const generalService = require('../../ZelBack/src/services/generalService');
const networkStateService = require('../../ZelBack/src/services/networkStateService');
const registryManager = require('../../ZelBack/src/services/appDatabase/registryManager');
const messageStore = require('../../ZelBack/src/services/appMessaging/messageStore');
const reconcilerQueue = require('../../ZelBack/src/services/appMonitoring/reconcilerQueue');
const appsRuntimeState = require('../../ZelBack/src/services/appManagement/appsRuntimeState');
const grantClient = require('../../ZelBack/src/services/quorumGrant/grantClient');
const mastershipGrantGate = require('../../ZelBack/src/services/appLifecycle/mastershipGrantGate');

// The reconciler's one question — "does the grant veto this component?" —
// answered veto-only. What matters most here is what the gate does NOT do:
// answer when the feature is off, answer for a mixed fleet, or ever return
// a verdict that starts something.

const SELF_TXHASH = 'a'.repeat(64);
const SELF = `${SELF_TXHASH}:0`;
const IDENTIFIER = 'fluxmyapp_component';

function activeStandbyComp() {
  return { appName: 'myapp', hasActiveStandbySyncthing: () => true };
}

function plainComp() {
  return { appName: 'myapp', hasActiveStandbySyncthing: () => false };
}

describe('quorumGrant mastershipGrantGate', () => {
  beforeEach(() => {
    mastershipGrantGate.resetForTests({ enabled: true });
    // The shape appLocation actually returns (appsRepository RUNNING_ROW_TAIL):
    // an address, and an outpoint that is NULL on this node's own row - a node
    // stores its own announcement with no announcer to resolve it from. Neither
    // txhash nor outidx is ever projected onto a location row; those belong to
    // a list entry, which is where this node's own address is resolved.
    sinon.stub(registryManager, 'appLocation').resolves([
      { ip: '203.0.113.5:16127', outpoint: null },
      { ip: '10.1.0.1:16127', outpoint: `${'1'.repeat(64)}:0` },
    ]);
    sinon.stub(generalService, 'obtainNodeCollateralInformation').resolves({
      txhash: SELF_TXHASH, txindex: 0,
    });
    sinon.stub(networkStateService, 'membershipFingerprint').returns('f'.repeat(64));
    sinon.stub(networkStateService, 'membershipAt').returns([
      { txhash: SELF_TXHASH, outidx: 0, pubkey: 'owner-self', ip: '203.0.113.5:16127' },
    ]);
    sinon.stub(serviceHelper, 'axiosGet').resolves({ data: { status: 'success', data: {} } });
    sinon.stub(messageStore, 'getMasterleaseRecord').resolves(null);
    sinon.stub(grantClient, 'holderFor').returns(null);
    sinon.stub(grantClient, 'isAcquiring').returns(false);
    sinon.stub(appsRuntimeState, 'isOperatorStopped').resolves(false);
    sinon.stub(grantClient, 'acquire').resolves({ granted: false, reason: 'test' });
    sinon.stub(grantClient, 'termLapsed').resolves(false);
    sinon.stub(reconcilerQueue, 'enqueueComponent');
  });

  afterEach(() => {
    mastershipGrantGate.resetForTests();
    sinon.restore();
  });

  describe('staying out of the way', () => {
    it('answers nothing while the feature is off — the default', async () => {
      mastershipGrantGate.resetForTests(); // no override: config default, off
      const verdict = await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp());
      expect(verdict).to.equal(null);
      expect(serviceHelper.axiosGet.called).to.equal(false);
      expect(grantClient.acquire.called).to.equal(false);
    });

    it('answers nothing for components without activeStandby semantics', async () => {
      const verdict = await mastershipGrantGate.grantVerdict(IDENTIFIER, plainComp());
      expect(verdict).to.equal(null);
      expect(serviceHelper.axiosGet.called).to.equal(false);
    });

    it('never probes the fleet for its version - it cannot be asked', async () => {
      // A node without this code cannot report that it lacks it: it can only
      // fail to answer, and so can a dead one. The plane therefore asks nobody.
      await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp());
      expect(serviceHelper.axiosGet.called, 'no holder was probed').to.equal(false);
      expect(registryManager.appLocation.called, 'no holder set was read').to.equal(false);
    });
  });

  describe('sequencing: the version floor decides, not a probe', () => {
    // The real wiring, config included - node-config is frozen once read, so the
    // config module is injected rather than mutated. Every key the gate reads is
    // supplied: proxyquire replaces the module wholesale and a missing key would
    // read as undefined rather than fail.
    function gateWith({ flag, required, floor }) {
      return proxyquire('../../ZelBack/src/services/appLifecycle/mastershipGrantGate', {
        config: {
          minimumFluxOSAllowedVersion: floor,
          fluxapps: {
            quorumGrantMastership: flag,
            quorumGrantMinFluxOSVersion: required,
            quorumGrantUnknownGraceMs: 120000,
            quorumGrantPursuitIntervalMs: 30000,
            quorumGrantHeldTtlMs: 150000,
          },
        },
      });
    }

    it('governs once the enforced floor reaches the release that carries it', async () => {
      const gate = gateWith({ flag: true, required: '8.17.0', floor: '8.17.0' });
      const verdict = await gate.grantVerdict(IDENTIFIER, activeStandbyComp());
      expect(verdict, 'the plane engaged').to.not.equal(null);
      expect(grantClient.acquire.called).to.equal(true);
    });

    it('stays inert while the floor is below it, however the flag is set', async () => {
      const gate = gateWith({ flag: true, required: '8.17.0', floor: '8.13.1' });
      const verdict = await gate.grantVerdict(IDENTIFIER, activeStandbyComp());
      expect(verdict, 'a mixed fleet is still possible, so the plane sits out').to.equal(null);
      expect(grantClient.acquire.called).to.equal(false);
    });

    it('stays inert while no release carries it yet', async () => {
      const gate = gateWith({ flag: true, required: null, floor: '9.9.9' });
      expect(await gate.grantVerdict(IDENTIFIER, activeStandbyComp())).to.equal(null);
      expect(grantClient.acquire.called).to.equal(false);
    });

    it('stays inert while the flag is off, however high the floor', async () => {
      const gate = gateWith({ flag: false, required: '8.17.0', floor: '9.9.9' });
      expect(await gate.grantVerdict(IDENTIFIER, activeStandbyComp())).to.equal(null);
      expect(grantClient.acquire.called).to.equal(false);
    });

    it('compares the floor against the requirement, not the other way round', async () => {
      // The arg-order mistake this guards: a floor ABOVE the requirement must
      // engage, and one below must not. Reversing them inverts both.
      const ahead = gateWith({ flag: true, required: '8.17.0', floor: '9.1.0' });
      expect(await ahead.grantVerdict(IDENTIFIER, activeStandbyComp())).to.not.equal(null);

      grantClient.acquire.resetHistory();
      const behind = gateWith({ flag: true, required: '9.1.0', floor: '8.17.0' });
      expect(await behind.grantVerdict(IDENTIFIER, activeStandbyComp())).to.equal(null);
    });
  });

  describe('the veto-only verdicts', () => {
    it('held answers nothing — the data gates still decide', async () => {
      grantClient.holderFor.returns({ state: 'held' });
      const verdict = await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp());
      expect(verdict).to.equal(null);
    });

    it('a peer on the published record makes this node a standby, settled', async () => {
      messageStore.getMasterleaseRecord.resolves({ data: { grantee: 'other:0' } });
      const verdict = await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp());
      expect(verdict).to.deep.equal({ desired: false, reason: 'peerHoldsGrant' });
    });

    it('a record naming THIS node is not a peer verdict — the defer path runs', async () => {
      messageStore.getMasterleaseRecord.resolves({ data: { grantee: SELF } });
      const verdict = await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp());
      expect(verdict).to.deep.equal({ desired: null, reason: 'grantUnknown' });
    });

    it('unknown defers within the grace, then fails closed past it', async () => {
      mastershipGrantGate.resetForTests({ enabled: true, unknownGraceMs: 0 });
      const first = await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp());
      expect(first.desired).to.equal(null);

      await new Promise((resolve) => { setTimeout(resolve, 10); });
      const second = await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp());
      expect(second).to.deep.equal({ desired: false, reason: 'grantNotHeld' });
    });

    it('never returns desired true, whatever the state', async () => {
      const states = [
        () => grantClient.holderFor.returns({ state: 'held' }),
        () => messageStore.getMasterleaseRecord.resolves({ data: { grantee: 'other:0' } }),
        () => {},
      ];
      const verdicts = [];
      for (const arrange of states) {
        arrange();
        // eslint-disable-next-line no-await-in-loop
        verdicts.push(await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp()));
      }
      verdicts.forEach((verdict) => {
        expect(verdict?.desired ?? null).to.not.equal(true);
      });
    });
  });

  describe('pursuit and demotion', () => {
    it('kicks one acquisition and re-enqueues on demotion', async () => {
      let demotion = null;
      grantClient.acquire.callsFake(async (key, options) => {
        demotion = options.onDemoted;
        return { granted: false };
      });
      await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp());
      await new Promise((resolve) => { setImmediate(resolve); });
      expect(grantClient.acquire.calledOnce).to.equal(true);
      expect(grantClient.acquire.firstCall.args[0]).to.equal('myapp/master');

      demotion('a test deposition');
      expect(reconcilerQueue.enqueueComponent.calledOnceWith(IDENTIFIER)).to.equal(true);
    });

    it('a settled standby RESTS — the record names another and the referees still shield it', async () => {
      messageStore.getMasterleaseRecord.resolves({
        data: { grantee: 'other:0', mode: 'held' },
      });
      grantClient.termLapsed.resolves(false);
      await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp());
      await new Promise((resolve) => { setImmediate(resolve); });
      expect(grantClient.termLapsed.calledOnce).to.equal(true);
      expect(grantClient.acquire.called).to.equal(false);
    });

    it('a provably lapsed term opens the pursuit — the record alone never decides', async () => {
      messageStore.getMasterleaseRecord.resolves({
        data: { grantee: 'other:0', mode: 'held' },
      });
      grantClient.termLapsed.resolves(true);
      await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp());
      await new Promise((resolve) => { setImmediate(resolve); });
      expect(grantClient.acquire.calledOnce).to.equal(true);
    });

    it('a record naming THIS node never suppresses pursuit — the restart re-acquire stays immediate', async () => {
      messageStore.getMasterleaseRecord.resolves({
        data: { grantee: SELF, mode: 'held' },
      });
      await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp());
      await new Promise((resolve) => { setImmediate(resolve); });
      expect(grantClient.termLapsed.called).to.equal(false);
      expect(grantClient.acquire.calledOnce).to.equal(true);
    });

    it('an unreadable record never stops a pursuit — the grantors decide', async () => {
      messageStore.getMasterleaseRecord.rejects(new Error('db down'));
      await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp());
      await new Promise((resolve) => { setImmediate(resolve); });
      expect(grantClient.acquire.calledOnce).to.equal(true);
    });

    it('does not stack pursuits while one is in flight', async () => {
      grantClient.isAcquiring.returns(true);
      await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp());
      expect(grantClient.acquire.called).to.equal(false);
    });

    it('a win re-enqueues the component so the reconciler acts on it', async () => {
      grantClient.acquire.resolves({ granted: true, holder: { epoch: 2 } });
      await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp());
      await new Promise((resolve) => { setImmediate(resolve); });
      expect(reconcilerQueue.enqueueComponent.calledWith(IDENTIFIER)).to.equal(true);
    });
  });

  describe('blocksStart', () => {
    it('blocks on veto and on defer alike, and never when held or off', async () => {
      expect(await mastershipGrantGate.blocksStart(IDENTIFIER, activeStandbyComp())).to.equal(true);

      grantClient.holderFor.returns({ state: 'held' });
      expect(await mastershipGrantGate.blocksStart(IDENTIFIER, activeStandbyComp())).to.equal(false);

      grantClient.holderFor.returns(null);
      mastershipGrantGate.resetForTests();
      expect(await mastershipGrantGate.blocksStart(IDENTIFIER, activeStandbyComp())).to.equal(false);
    });
  });

  describe('the decider intent surfaces', () => {
    it('leaderIsSelf answers null when not applicable, boolean when it is', async () => {
      mastershipGrantGate.resetForTests();
      expect(await mastershipGrantGate.leaderIsSelf(IDENTIFIER, 'myapp', true)).to.equal(null);

      mastershipGrantGate.resetForTests({ enabled: true });
      expect(await mastershipGrantGate.leaderIsSelf(IDENTIFIER, 'myapp', false)).to.equal(null);
      expect(await mastershipGrantGate.leaderIsSelf(IDENTIFIER, 'myapp', true)).to.equal(false);
      // the pursuit is fire-and-forget; let its await chain (operator-state
      // read, record read) settle before asserting it reached acquire
      await new Promise((resolve) => { setTimeout(resolve, 25); });
      expect(grantClient.acquire.calledOnce).to.equal(true);

      grantClient.holderFor.returns({ state: 'held' });
      expect(await mastershipGrantGate.leaderIsSelf(IDENTIFIER, 'myapp', true)).to.equal(true);
    });

    it('masterIntent resolves the record grantee to its listed address, FDM-shaped', async () => {

      networkStateService.membershipAt.returns([
        { txhash: '9'.repeat(64), outidx: 0, pubkey: 'owner-9', ip: '10.9.0.9:16127' },
      ]);
      messageStore.getMasterleaseRecord.resolves({ data: { grantee: `${'9'.repeat(64)}:0` } });

      const intent = await mastershipGrantGate.masterIntent(IDENTIFIER, activeStandbyComp());
      expect(intent).to.deep.equal({ ip: '10.9.0.9:16127', fdmOk: true });
    });

    it('masterIntent with no record answers no-primary, never a guess', async () => {
      const intent = await mastershipGrantGate.masterIntent(IDENTIFIER, activeStandbyComp());
      expect(intent).to.deep.equal({ ip: null, fdmOk: true });
    });

    it('masterIntent answers null entirely when the plane is not applicable', async () => {
      mastershipGrantGate.resetForTests();
      expect(await mastershipGrantGate.masterIntent(IDENTIFIER, activeStandbyComp())).to.equal(null);
      mastershipGrantGate.resetForTests({ enabled: true });
      expect(await mastershipGrantGate.masterIntent(IDENTIFIER, plainComp())).to.equal(null);
    });

    it('a grantee no longer on the list resolves to no primary, not a stale address', async () => {

      networkStateService.membershipAt.returns([]);
      messageStore.getMasterleaseRecord.resolves({ data: { grantee: `${'9'.repeat(64)}:0` } });
      const intent = await mastershipGrantGate.masterIntent(IDENTIFIER, activeStandbyComp());
      expect(intent).to.deep.equal({ ip: null, fdmOk: true });
    });
  });

  describe('the self-demotion note', () => {
    it('records and answers the cooperative fence attestation', () => {
      expect(mastershipGrantGate.folderDemotedAt('myapp')).to.equal(null);
      mastershipGrantGate.noteFolderDemoted('myapp');
      expect(mastershipGrantGate.folderDemotedAt('myapp')).to.be.a('number');
    });
  });

  describe('teardown', () => {
    it('releases a held grant once the container is stopped', async () => {
      const release = sinon.stub().resolves();
      grantClient.holderFor.returns({ release });
      await mastershipGrantGate.onComponentTeardown(IDENTIFIER, 'myapp');
      expect(release.calledOnce).to.equal(true);
    });

    it('is a no-op for non-holders and for a missing app name', async () => {
      grantClient.holderFor.returns(null);
      await mastershipGrantGate.onComponentTeardown(IDENTIFIER, 'myapp');
      await mastershipGrantGate.onComponentTeardown(IDENTIFIER, undefined);
      expect(grantClient.holderFor.callCount).to.equal(1);
    });
  });

  describe('yieldMastership — the operator grant-layer verb', () => {
    it('voluntarily releases a held grant and says it held', async () => {
      // appyield: release BEFORE the stop, so the successor pays no
      // lock-delay — failover is the operator's stated intent, arriving as
      // a command because a stopped container cannot carry it
      const release = sinon.stub().resolves();
      grantClient.holderFor.returns({ release });

      const outcome = await mastershipGrantGate.yieldMastership('myapp');

      expect(outcome.held).to.equal(true);
      sinon.assert.calledOnce(release);
    });

    it('is a no-op on a non-holder — stop-regardless keeps the global fan-out idempotent', async () => {
      const outcome = await mastershipGrantGate.yieldMastership('myapp');
      expect(outcome.held).to.equal(false);
    });

    it('an operator-stopped component never pursues — winning would park the term on a non-runner', async () => {
      // The 1209 fleet runs measured this twice: the yielded master re-took
      // its own released term through the syncthing/coordinate deciders'
      // pursue paths, which never consulted operator state — and the
      // record-names-self fast path skips even the lapse probe. The stop
      // lock must silence EVERY pursue trigger.
      appsRuntimeState.isOperatorStopped.resolves(true);

      await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp());
      await new Promise((resolve) => { setTimeout(resolve, 50); });

      sinon.assert.notCalled(grantClient.acquire);
    });

    it('waits out an acquisition in flight and releases what it won — no stopped-container master', async () => {
      // The fast-succession interleave: a yield can land while this node's
      // own gate is mid-pursuit (e.g. it was already chasing a term another
      // node just yielded). The acquire completes milliseconds later and
      // would seat a master whose container the operator just stopped. The
      // yield must therefore settle the in-flight acquisition and release
      // whatever it won.
      const release = sinon.stub().resolves();
      grantClient.isAcquiring.returns(true);
      setTimeout(() => {
        grantClient.isAcquiring.returns(false);
        grantClient.holderFor.returns({ release });
      }, 300);

      const outcome = await mastershipGrantGate.yieldMastership('myapp');

      expect(outcome.held).to.equal(true);
      sinon.assert.calledOnce(release);
    });
  });
});
