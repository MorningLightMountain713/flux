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
const dockerService = require('../../ZelBack/src/services/dockerService');
const grantClient = require('../../ZelBack/src/services/quorumGrant/grantClient');
const mastershipGrantGate = require('../../ZelBack/src/services/appLifecycle/mastershipGrantGate');
const log = require('../../ZelBack/src/lib/log');

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
    // This node IS running the component unless a test says otherwise. Most of these
    // exercise a node that holds or wins the app, and on a COLD key that is exactly
    // the incumbent — which is what earns it the head start. Left unstubbed it would
    // reach real docker, answer false, and every acquisition here would sit out its
    // wait for reasons that have nothing to do with what is being tested.
    sinon.stub(dockerService, 'dockerContainerInspect').resolves({ State: { Running: true } });
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
    sinon.stub(grantClient, 'relearn').resolves({ recovered: false, holder: null, reason: 'test' });
    sinon.stub(reconcilerQueue, 'enqueueComponent');
  });

  afterEach(() => {
    mastershipGrantGate.resetForTests();
    sinon.restore();
  });

  // The veto asks the registers, never the published record: a running
  // non-holder stops when a quorum of registers names another node, keeps
  // running when they record its own term, and the record's claim decides
  // nothing either way.
  describe('the veto asks the registers', () => {
    const OTHER = `${'7'.repeat(64)}:0`;

    it('stops a running non-holder when a quorum of registers names another node', async () => {
      grantClient.relearn.resolves({
        recovered: false, holder: null, reason: 'no quorum of registers names this node', term: { grantee: OTHER, epoch: 4, remainingMs: 50_000 },
      });
      const verdict = await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp());
      expect(verdict).to.deep.equal({ desired: false, reason: 'peerHoldsGrant' });
    });

    it('a record naming another node stops nothing when the registers record this node\'s term', async () => {
      messageStore.getMasterleaseRecord.resolves({ data: { grantee: OTHER, mode: 'held', epoch: 9 } });
      grantClient.relearn.resolves({
        recovered: true, holder: {}, reason: null, term: { grantee: SELF, epoch: 3, remainingMs: 40_000 },
      });
      expect(await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp())).to.equal(null);
    });

    it('a record naming this node keeps nothing running when the registers do not', async () => {
      messageStore.getMasterleaseRecord.resolves({ data: { grantee: SELF, mode: 'held', epoch: 9 } });
      grantClient.relearn.resolves({
        recovered: false, holder: null, reason: 'no quorum of registers names this node', term: { grantee: null, epoch: null, remainingMs: 0 },
      });
      expect(await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp()))
        .to.deep.equal({ desired: false, reason: 'no quorum of registers names this node' });
    });

    it('an unreadable committee carries its own reason, not a peer\'s claim', async () => {
      grantClient.relearn.resolves({ recovered: false, holder: null, reason: 'committee unavailable for fingerprint' });
      expect(await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp()))
        .to.deep.equal({ desired: false, reason: 'committee unavailable for fingerprint' });
    });
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

  describe('sequencing: the chain decides WHEN, the floor decided WHETHER', () => {
    // The real wiring, config included - node-config is frozen once read, so the
    // config module is injected rather than mutated. Every key the gate reads is
    // supplied: proxyquire replaces the module wholesale and a missing key would
    // read as undefined rather than fail.
    function gateWith({ flag, activateAt, height, synced = true }) {
      return proxyquire('../../ZelBack/src/services/appLifecycle/mastershipGrantGate', {
        config: {
          fluxapps: {
            quorumGrantMastership: flag,
            quorumGrantActivationHeight: activateAt,
            quorumGrantPursuitIntervalMs: 30000,
            quorumGrantHeldTtlMs: 150000,
          },
        },
        '../daemonService/daemonServiceMiscRpcs': {
          isDaemonSynced: () => ({ data: { height, synced } }),
        },
      });
    }

    it('governs once the chain reaches the activation height', async () => {
      const gate = gateWith({ flag: true, activateAt: 2100000, height: 2100000 });
      const verdict = await gate.grantVerdict(IDENTIFIER, activeStandbyComp());
      expect(verdict, 'the plane engaged').to.not.equal(null);
      // The pursuit is fire-and-forget and now asks docker whether this node is the
      // incumbent before it acquires, so the call lands a tick later than the verdict.
      await new Promise(setImmediate);
      expect(grantClient.acquire.called).to.equal(true);
    });

    it('stays inert one block short, however the flag is set', async () => {
      // The boundary, both sides. A height comparison off by one engages a whole
      // fleet a block early - which is a block in which some nodes grant and the
      // rest still elect.
      const gate = gateWith({ flag: true, activateAt: 2100000, height: 2099999 });
      expect(await gate.grantVerdict(IDENTIFIER, activeStandbyComp())).to.equal(null);
      expect(grantClient.acquire.called).to.equal(false);
    });

    it('stays inert while no height is scheduled yet', async () => {
      const gate = gateWith({ flag: true, activateAt: null, height: 9999999 });
      expect(await gate.grantVerdict(IDENTIFIER, activeStandbyComp())).to.equal(null);
      expect(grantClient.acquire.called).to.equal(false);
    });

    it('stays inert while the flag is off, however far past the height', async () => {
      const gate = gateWith({ flag: false, activateAt: 2100000, height: 9999999 });
      expect(await gate.grantVerdict(IDENTIFIER, activeStandbyComp())).to.equal(null);
      expect(grantClient.acquire.called).to.equal(false);
    });

    it('stays inert while the node cannot say where the chain is', async () => {
      // An unsynced node does not get to decide the plane has started. Reading a
      // stale or absent tip as 'reached' would engage exactly the node least able
      // to know, and a node that is behind is the one most likely to be behind on
      // the grant records too.
      const unsynced = gateWith({ flag: true, activateAt: 2100000, height: 2100000, synced: false });
      expect(await unsynced.grantVerdict(IDENTIFIER, activeStandbyComp())).to.equal(null);

      grantClient.acquire.resetHistory();
      const noHeight = gateWith({ flag: true, activateAt: 2100000, height: undefined });
      expect(await noHeight.grantVerdict(IDENTIFIER, activeStandbyComp())).to.equal(null);
      expect(grantClient.acquire.called).to.equal(false);
    });
  });

  // The two heights (ACTIVATION_CROSSING_DESIGN.md §2). The referees serve a
  // fresh key from activateAt - preWindowBlocks; the plane GOVERNS from
  // activateAt. Inside the window the seams answer nothing - the legacy
  // election still decides who runs - and the node whose own docker says it
  // runs the container takes its lease early, so that at the height the key
  // is warm and nothing moves. A lease that lapses inside the window (a
  // referee majority restarting inside one term) is re-acquired, never a
  // docker stop: the plane stops nothing it does not yet govern.
  describe('the window: the register opens before the plane governs', () => {
    const ACTIVATE_AT = 2100000;
    const PRE_WINDOW = 40;

    function windowGate({ height, synced = true, extraConfig = {} }) {
      return proxyquire('../../ZelBack/src/services/appLifecycle/mastershipGrantGate', {
        config: {
          fluxapps: {
            quorumGrantMastership: true,
            quorumGrantActivationHeight: ACTIVATE_AT,
            quorumGrantPreWindowBlocks: PRE_WINDOW,
            quorumGrantPursuitIntervalMs: 30000,
            quorumGrantHeldTtlMs: 150000,
            ...extraConfig,
          },
        },
        '../daemonService/daemonServiceMiscRpcs': {
          isDaemonSynced: () => ({ data: { height, synced } }),
        },
      });
    }

    beforeEach(() => {
      sinon.stub(dockerService, 'appDockerStop').resolves();
    });

    it('inside the window the seam answers nothing, and the node running the component asks', async () => {
      dockerService.dockerContainerInspect.resolves({ State: { Running: true } });
      const gate = windowGate({ height: ACTIVATE_AT - PRE_WINDOW });
      expect(await gate.grantVerdict(IDENTIFIER, activeStandbyComp()), 'no verdict below the height').to.equal(null);
      await new Promise(setImmediate);
      expect(grantClient.acquire.calledOnce, 'the running node asks at the window\'s first block').to.equal(true);
      expect(grantClient.acquire.firstCall.args[0]).to.equal('myapp/master');
    });

    it('one block below the window nobody asks, running or not', async () => {
      dockerService.dockerContainerInspect.resolves({ State: { Running: true } });
      const gate = windowGate({ height: ACTIVATE_AT - PRE_WINDOW - 1 });
      expect(await gate.grantVerdict(IDENTIFIER, activeStandbyComp())).to.equal(null);
      await new Promise(setImmediate);
      expect(grantClient.acquire.called, 'the register is not open yet').to.equal(false);
    });

    it('inside the window a node not running the component never asks', async () => {
      dockerService.dockerContainerInspect.resolves({ State: { Running: false } });
      const gate = windowGate({ height: ACTIVATE_AT - 1 });
      expect(await gate.grantVerdict(IDENTIFIER, activeStandbyComp())).to.equal(null);
      await new Promise(setImmediate);
      expect(grantClient.acquire.called, 'standbys ask at the height, never below it').to.equal(false);
    });

    it('a lease that lapses inside the window is re-acquired, never a docker stop', async () => {
      dockerService.dockerContainerInspect.resolves({ State: { Running: true } });
      let demotion = null;
      grantClient.acquire.callsFake(async (key, options) => {
        demotion = options.onDemoted;
        return { granted: true, holder: { epoch: 1 } };
      });
      const gate = windowGate({ height: ACTIVATE_AT - 10 });
      await gate.grantVerdict(IDENTIFIER, activeStandbyComp());
      await new Promise(setImmediate);
      expect(demotion, 'the window pursuit installed a demotion handler').to.be.a('function');

      demotion('renewal quorum lost past the deadline');
      // the re-acquire runs the pursuit's own await chain (operator state,
      // record, docker) before it reaches acquire
      await new Promise((resolve) => { setTimeout(resolve, 25); });
      expect(dockerService.appDockerStop.called, 'the plane governs nothing below the height').to.equal(false);
      expect(grantClient.acquire.calledTwice, 'the lapse is answered by re-acquiring').to.equal(true);
    });

    it('at the height a lapse stops the container, as it always did', async () => {
      dockerService.dockerContainerInspect.resolves({ State: { Running: true } });
      let demotion = null;
      grantClient.acquire.callsFake(async (key, options) => {
        demotion = options.onDemoted;
        return { granted: true, holder: { epoch: 1 } };
      });
      const gate = windowGate({ height: ACTIVATE_AT });
      await gate.grantVerdict(IDENTIFIER, activeStandbyComp());
      await new Promise(setImmediate);
      expect(demotion).to.be.a('function');

      demotion('a grant at epoch 2 supersedes ours at 1');
      await new Promise(setImmediate);
      expect(dockerService.appDockerStop.calledOnceWith(IDENTIFIER), 'a deposed master stops hard').to.equal(true);
      expect(reconcilerQueue.enqueueComponent.calledWith(IDENTIFIER)).to.equal(true);
    });

    it('the decider seams answer nothing inside the window and still kick the pursuit', async () => {
      // masterIntent is what the activeStandby coordinator asks every
      // interval, so it is the periodic kick a running node gets inside the
      // window - the reconciler's own sweep is hourly.
      dockerService.dockerContainerInspect.resolves({ State: { Running: true } });
      const gate = windowGate({ height: ACTIVATE_AT - 20 });
      expect(await gate.masterIntent(IDENTIFIER, activeStandbyComp()), 'the FDM read stands').to.equal(null);
      expect(await gate.leaderIsSelf(IDENTIFIER, 'myapp', true), 'the lowest-IP election stands').to.equal(null);
      await new Promise((resolve) => { setTimeout(resolve, 25); });
      expect(grantClient.acquire.calledOnce, 'one pursuit, throttled across the seams').to.equal(true);
    });
  });

  // Below the height the rule is the node's own docker and nothing else: a
  // node asks iff it runs the container (ACTIVATION_CROSSING_DESIGN.md §2.2),
  // cold key or lapsed term alike - a standby seated below the height would
  // only be stopped for the running node at it. At and past the height the
  // built pursuit stands: a warm key shields its holder, a cold one is first
  // come. There is no head start and no clock: the fact the 45 s timer stood
  // in for was local all along.
  describe('below the height the docker rule is the whole rule; at it, a cold key is first come', () => {
    const ACTIVATE_AT = 2100000;

    function windowGate({ height }) {
      return proxyquire('../../ZelBack/src/services/appLifecycle/mastershipGrantGate', {
        config: {
          fluxapps: {
            quorumGrantMastership: true,
            quorumGrantActivationHeight: ACTIVATE_AT,
            quorumGrantPreWindowBlocks: 40,
            quorumGrantPursuitIntervalMs: 30000,
            quorumGrantHeldTtlMs: 150000,
          },
        },
        '../daemonService/daemonServiceMiscRpcs': {
          isDaemonSynced: () => ({ data: { height, synced: true } }),
        },
      });
    }

    function windowDecisionLine(info) {
      return info.getCalls().map((c) => c.args[0]).find((m) => String(m).includes('below the height'));
    }

    it('at the height the node running the component asks at once', async () => {
      messageStore.getMasterleaseRecord.resolves(null);
      dockerService.dockerContainerInspect.resolves({ State: { Running: true } });
      await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp());
      await new Promise(setImmediate);
      expect(grantClient.acquire.called).to.equal(true);
    });

    it('at the height a cold key is first come: a node NOT running the component asks at once, no head start', async () => {
      // The running node took its lease inside the window; a key still cold
      // at the height means nobody was running or the running node could not
      // reach its committee for the whole window - the accepted takeover.
      messageStore.getMasterleaseRecord.resolves(null);
      dockerService.dockerContainerInspect.resolves({ State: { Running: false } });
      await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp());
      await new Promise(setImmediate);
      expect(grantClient.acquire.called, 'no wait exists at the height').to.equal(true);
      expect(dockerService.dockerContainerInspect.called, 'docker is not consulted at the height').to.equal(false);
    });

    it('inside the window a node not running the component never asks for a cold key', async () => {
      dockerService.dockerContainerInspect.resolves({ State: { Running: false } });
      const gate = windowGate({ height: ACTIVATE_AT - 5 });
      messageStore.getMasterleaseRecord.resolves(null);
      await gate.grantVerdict(IDENTIFIER, activeStandbyComp());
      await new Promise((resolve) => { setTimeout(resolve, 25); });
      expect(grantClient.acquire.called, 'a cold key is not a standby\'s to take below the height').to.equal(false);
    });

    it('inside the window a node not running the component never asks for a lapsed term either', async () => {
      // A dead master's term inside the window goes to whoever the legacy
      // election seats next - a RUNNING node - never to a resting standby: a
      // standby seated below the height would only be stopped for the running
      // node at it. Its own gate instance: a pursuit throttled by an earlier
      // kick would make this pass for the wrong reason.
      dockerService.dockerContainerInspect.resolves({ State: { Running: false } });
      const gate = windowGate({ height: ACTIVATE_AT - 5 });
      messageStore.getMasterleaseRecord.resolves({ data: { grantee: `${'9'.repeat(64)}:0`, mode: 'held' } });
      grantClient.termLapsed.resolves(true);
      await gate.masterIntent(IDENTIFIER, activeStandbyComp());
      await new Promise((resolve) => { setTimeout(resolve, 25); });
      expect(grantClient.acquire.called, 'a lapsed term is not a standby\'s to take below the height').to.equal(false);
    });

    it('inside the window the running node takes a lapsed term - the plane follows the legacy election', async () => {
      dockerService.dockerContainerInspect.resolves({ State: { Running: true } });
      const gate = windowGate({ height: ACTIVATE_AT - 5 });
      messageStore.getMasterleaseRecord.resolves({ data: { grantee: `${'9'.repeat(64)}:0`, mode: 'held' } });
      grantClient.termLapsed.resolves(true);
      await gate.grantVerdict(IDENTIFIER, activeStandbyComp());
      await new Promise((resolve) => { setTimeout(resolve, 25); });
      expect(grantClient.acquire.calledOnce).to.equal(true);
    });

    it('inside the window a node that cannot read docker waits - the safe side of that error', async () => {
      dockerService.dockerContainerInspect.rejects(new Error('docker unreachable'));
      const gate = windowGate({ height: ACTIVATE_AT - 5 });
      await gate.grantVerdict(IDENTIFIER, activeStandbyComp());
      await new Promise((resolve) => { setTimeout(resolve, 25); });
      expect(grantClient.acquire.called).to.equal(false);
    });

    it('the window decision line names the identifier, the docker name and the verdict', async () => {
      // The instrument itself, run rather than read: on the fleet the only
      // other observable is which node ended up with the term, and that
      // cannot tell a lookup that missed from a node that really was not
      // running the container.
      dockerService.dockerContainerInspect.resolves({ Name: `/flux${IDENTIFIER}`, State: { Running: true } });
      const info = sinon.stub(log, 'info');
      const gate = windowGate({ height: ACTIVATE_AT - 5 });
      await gate.grantVerdict(IDENTIFIER, activeStandbyComp());
      await new Promise((resolve) => { setTimeout(resolve, 25); });
      const line = windowDecisionLine(info);
      expect(line, 'the decision is logged').to.be.a('string');
      expect(line).to.include(`identifier=${IDENTIFIER}`);
      expect(line).to.include(`lookup=/flux${IDENTIFIER}`);
      expect(line).to.include('found=true');
      expect(line).to.include('running=true');
      expect(line).to.include('-> ASK');
    });

    it('a container docker does not hold reads as absent, not as stopped', async () => {
      // The two are one boolean on the decision path and must never be one in
      // the record of it: absent is a lookup that missed, stopped is the rule
      // working.
      dockerService.dockerContainerInspect.resolves(null);
      const info = sinon.stub(log, 'info');
      const gate = windowGate({ height: ACTIVATE_AT - 5 });
      await gate.grantVerdict(IDENTIFIER, activeStandbyComp());
      await new Promise((resolve) => { setTimeout(resolve, 25); });
      const line = windowDecisionLine(info);
      expect(line, 'the decision is logged').to.be.a('string');
      expect(line).to.include('found=false');
      expect(line).to.include('name=none');
      expect(line).to.include('running=false');
      expect(line).to.include('-> WAIT');
    });

    it('a docker that will not answer says so, rather than reading as absent', async () => {
      dockerService.dockerContainerInspect.rejects(new Error('docker unreachable'));
      const info = sinon.stub(log, 'info');
      const gate = windowGate({ height: ACTIVATE_AT - 5 });
      await gate.grantVerdict(IDENTIFIER, activeStandbyComp());
      await new Promise((resolve) => { setTimeout(resolve, 25); });
      const line = windowDecisionLine(info);
      expect(line, 'the decision is logged').to.be.a('string');
      expect(line).to.include('dockerError=docker unreachable');
      expect(line).to.include('-> WAIT');
    });
  });

  // A refused running node inside the window never retries at random
  // (ACTIVATION_CROSSING_DESIGN.md §2.5): it retries at the time the referee
  // taught when the refusal carried one, and re-probes after one ask timeout
  // when it taught nothing - the sync gate, where nobody knows when a chain
  // view catches up. The attempt prepares only on an open quorum. Standbys
  // keep the jittered pursuit for steady-state work; that was never the
  // problem.
  describe('the retry inside the window: at the taught time, or a re-probe after one ask timeout, never at random', () => {
    const ACTIVATE_AT = 2100000;
    const ASK_TIMEOUT = 5000;
    let clock;

    function windowGate({ height }) {
      return proxyquire('../../ZelBack/src/services/appLifecycle/mastershipGrantGate', {
        config: {
          fluxapps: {
            quorumGrantMastership: true,
            quorumGrantActivationHeight: ACTIVATE_AT,
            quorumGrantPreWindowBlocks: 40,
            quorumGrantPursuitIntervalMs: 30000,
            quorumGrantHeldTtlMs: 150000,
            quorumGrantAskTimeoutMs: ASK_TIMEOUT,
          },
        },
        '../daemonService/daemonServiceMiscRpcs': {
          isDaemonSynced: () => ({ data: { height, synced: true } }),
        },
      });
    }

    // the pursuit's own await chain (operator state, docker, record) runs on
    // real microtasks and immediates; only the timers are faked
    async function settle() {
      for (let i = 0; i < 8; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise(setImmediate);
      }
    }

    beforeEach(() => {
      clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      dockerService.dockerContainerInspect.resolves({ State: { Running: true } });
    });

    afterEach(() => {
      clock.restore();
    });

    it('the window attempt prepares only on an open quorum; the built pursuit at the height does not', async () => {
      const gate = windowGate({ height: ACTIVATE_AT - 5 });
      await gate.grantVerdict(IDENTIFIER, activeStandbyComp());
      await settle();
      expect(grantClient.acquire.calledOnce).to.equal(true);
      expect(grantClient.acquire.firstCall.args[1].prepareOnlyIfOpen, 'a probe that prepares only on a promising quorum').to.equal(true);

      grantClient.acquire.resetHistory();
      const governing = windowGate({ height: ACTIVATE_AT });
      await governing.grantVerdict(IDENTIFIER, activeStandbyComp());
      await settle();
      expect(grantClient.acquire.calledOnce).to.equal(true);
      expect(grantClient.acquire.firstCall.args[1].prepareOnlyIfOpen, 'the built pursuit is unchanged').to.not.equal(true);
    });

    it('a refusal that taught a figure is retried at that figure, not at the pursuit jitter', async () => {
      grantClient.acquire.resolves({ granted: false, retryAfterMs: 7000 });
      const gate = windowGate({ height: ACTIVATE_AT - 5 });
      await gate.grantVerdict(IDENTIFIER, activeStandbyComp());
      await settle();
      expect(grantClient.acquire.calledOnce).to.equal(true);

      await clock.tickAsync(6999);
      await settle();
      expect(grantClient.acquire.calledOnce, 'not a millisecond before the taught time').to.equal(true);
      await clock.tickAsync(1);
      await settle();
      expect(grantClient.acquire.calledTwice, 'the retry lands at the taught figure').to.equal(true);
    });

    it('a refusal that taught nothing is re-probed after one ask timeout', async () => {
      grantClient.acquire.resolves({ granted: false, reason: 'no open quorum', retryAfterMs: 0 });
      const gate = windowGate({ height: ACTIVATE_AT - 5 });
      await gate.grantVerdict(IDENTIFIER, activeStandbyComp());
      await settle();
      expect(grantClient.acquire.calledOnce).to.equal(true);

      await clock.tickAsync(ASK_TIMEOUT - 1);
      await settle();
      expect(grantClient.acquire.calledOnce).to.equal(true);
      await clock.tickAsync(1);
      await settle();
      expect(grantClient.acquire.calledTwice, 'one ask timeout, then a re-probe').to.equal(true);
    });

    it('a retry is one per key, and it keeps retrying until something is learned', async () => {
      grantClient.acquire.resolves({ granted: false, reason: 'no open quorum', retryAfterMs: 0 });
      const gate = windowGate({ height: ACTIVATE_AT - 5 });
      await gate.grantVerdict(IDENTIFIER, activeStandbyComp());
      await gate.masterIntent(IDENTIFIER, activeStandbyComp());
      await settle();
      expect(grantClient.acquire.calledOnce, 'the seams share one pursuit').to.equal(true);

      await clock.tickAsync(ASK_TIMEOUT);
      await settle();
      await clock.tickAsync(ASK_TIMEOUT);
      await settle();
      expect(grantClient.acquire.callCount, 'a re-probe per ask timeout, one at a time').to.equal(3);
    });

    it('a refusal by a live incumbent is not retried - the record will name the holder', async () => {
      grantClient.acquire.resolves({ granted: false, incumbent: { grantee: 'other:0', epoch: 3 } });
      const gate = windowGate({ height: ACTIVATE_AT - 5 });
      await gate.grantVerdict(IDENTIFIER, activeStandbyComp());
      await settle();
      await clock.tickAsync(ASK_TIMEOUT * 4);
      await settle();
      expect(grantClient.acquire.calledOnce).to.equal(true);
    });

    it('a retry re-reads docker: a node that stopped running the container stops asking', async () => {
      grantClient.acquire.resolves({ granted: false, reason: 'no open quorum', retryAfterMs: 0 });
      const gate = windowGate({ height: ACTIVATE_AT - 5 });
      await gate.grantVerdict(IDENTIFIER, activeStandbyComp());
      await settle();
      expect(grantClient.acquire.calledOnce).to.equal(true);

      dockerService.dockerContainerInspect.resolves({ State: { Running: false } });
      await clock.tickAsync(ASK_TIMEOUT);
      await settle();
      expect(grantClient.acquire.calledOnce, 'the rule is re-asked of docker on every attempt').to.equal(true);
    });

    it('at the height a refusal is left to the pursuit jitter, as before', async () => {
      grantClient.acquire.resolves({ granted: false, retryAfterMs: 7000 });
      const gate = windowGate({ height: ACTIVATE_AT });
      await gate.grantVerdict(IDENTIFIER, activeStandbyComp());
      await settle();
      await clock.tickAsync(7000);
      await settle();
      expect(grantClient.acquire.calledOnce).to.equal(true);
    });
  });

  // A1. The plane's whole clock-rate-skew budget is the gap between the
  // demotion slack plus the container stop and the grantors' lock-delay -
  // §7's TTL:deadline ratio is 1:1 in the code and carries none of it. The code
  // stated that inequality in a comment for months and never checked it.
  describe('the timing inequality is checked before the plane governs anything', () => {
    function gateWithTiming({ slack, lockDelay }) {
      return proxyquire('../../ZelBack/src/services/appLifecycle/mastershipGrantGate', {
        config: {
          fluxapps: {
            quorumGrantMastership: true,
            quorumGrantActivationHeight: 2100000,
            quorumGrantPursuitIntervalMs: 30000,
            quorumGrantHeldTtlMs: 150000,
            quorumGrantDemotionSlackMs: slack,
            quorumGrantLockDelayMs: lockDelay,
          },
        },
        '../daemonService/daemonServiceMiscRpcs': {
          isDaemonSynced: () => ({ data: { height: 2100000, synced: true } }),
        },
      });
    }

    it('governs normally on the shipped values', async () => {
      const gate = gateWithTiming({ slack: 15_000, lockDelay: 30_000 });
      const verdict = await gate.grantVerdict(IDENTIFIER, activeStandbyComp());
      expect(verdict, 'the plane did not engage on a safe configuration').to.not.equal(null);
    });

    it('stays INERT rather than governing with a slack past the lock-delay', async () => {
      const gate = gateWithTiming({ slack: 40_000, lockDelay: 30_000 });
      const verdict = await gate.grantVerdict(IDENTIFIER, activeStandbyComp());
      expect(verdict, 'the plane governed on a configuration that seats two writers').to.equal(null);
    });

    // the regression this exists to catch: the lock-delay now carries the whole
    // drift budget, so lowering it spends the margin and nothing else notices
    it('stays INERT when the lock-delay is lowered under the slack', async () => {
      const gate = gateWithTiming({ slack: 15_000, lockDelay: 15_000 });
      expect(await gate.grantVerdict(IDENTIFIER, activeStandbyComp())).to.equal(null);
    });

    // FAIL-CLOSED, not fail-loud. The plane is inert by default and the legacy
    // election is what runs without it, so refusing to engage falls back to
    // today's behaviour. Throwing would brick a node over a feature it is not
    // using.
    it('refuses to engage rather than throwing', async () => {
      const gate = gateWithTiming({ slack: 40_000, lockDelay: 30_000 });
      let threw = null;
      try {
        await gate.grantVerdict(IDENTIFIER, activeStandbyComp());
      } catch (error) { threw = error; }
      expect(threw, 'a misconfigured node must not be bricked by an inert feature').to.equal(null);
    });
  });

  describe('the veto-only verdicts', () => {
    it('held answers nothing — the data gates still decide', async () => {
      grantClient.holderFor.returns({ state: 'held' });
      const verdict = await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp());
      expect(verdict).to.equal(null);
    });

    it('a peer in a quorum of registers makes this node a standby, settled; the published record alone decides nothing', async () => {
      messageStore.getMasterleaseRecord.resolves({ data: { grantee: 'other:0' } });
      grantClient.relearn.resolves({
        recovered: false, holder: null, reason: 'no quorum of registers names this node', term: { grantee: null, epoch: null, remainingMs: 0 },
      });
      expect(await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp()))
        .to.deep.equal({ desired: false, reason: 'no quorum of registers names this node' });
      grantClient.relearn.resolves({
        recovered: false, holder: null, reason: 'no quorum of registers names this node', term: { grantee: 'other:0', epoch: 2, remainingMs: 1_000 },
      });
      expect(await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp()))
        .to.deep.equal({ desired: false, reason: 'peerHoldsGrant' });
    });

    it('a record naming THIS node is not a peer verdict — it goes on to ask', async () => {
      messageStore.getMasterleaseRecord.resolves({ data: { grantee: SELF } });
      grantClient.relearn.resolves({ recovered: true, holder: { state: 'held' }, reason: null });
      const verdict = await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp());
      expect(verdict?.reason).to.not.equal('peerHoldsGrant');
      expect(grantClient.relearn.called).to.equal(true);
    });

    it('unknown ASKS the grantors instead of counting - and keeps running when they say it holds', async () => {
      grantClient.relearn.resolves({ recovered: true, holder: { state: 'held' }, reason: null });
      const verdict = await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp());
      expect(grantClient.relearn.called, 'the gate never asked the grantors').to.equal(true);
      expect(verdict).to.equal(null); // held answers nothing; the data gates decide
    });

    it('unknown fails closed the moment a quorum says the term is not this node\'s', async () => {
      grantClient.relearn.resolves({ recovered: false, holder: null, reason: 'no quorum of registers names this node' });
      const verdict = await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp());
      expect(verdict.desired).to.equal(false);
    });

    // THE FLEET BUG. The grantors are inside their rejoin drain and refuse
    // every ask, which is what a release wave produces on every node at once.
    // The old gate counted to 120s and stopped a healthy master 22 seconds
    // before that same node was granted the term back. Reads are served
    // THROUGH the drain, so re-learning answers where acquisition cannot.
    it('a refused ACQUISITION never stops a master whose term a quorum still records', async () => {
      mastershipGrantGate.resetForTests({ enabled: true });
      grantClient.acquire.resolves({ granted: false, reason: 'no prepare quorum' });
      grantClient.relearn.resolves({ recovered: true, holder: { state: 'held' }, reason: null });

      const verdicts = [];
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- passes are sequential
        verdicts.push(await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp()));
      }
      expect(verdicts.every((v) => v === null || v.desired !== false),
        'a pass stopped the master while a quorum still recorded its term').to.equal(true);
    });

    // No amount of elapsed time turns an unanswered question into an answer.
    it('never degrades on elapsed time alone - the same silence answers the same way', async () => {
      mastershipGrantGate.resetForTests({ enabled: true });
      grantClient.relearn.resolves({ recovered: true, holder: { state: 'held' }, reason: null });
      const first = await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp());
      await new Promise((resolve) => { setTimeout(resolve, 25); });
      const later = await mastershipGrantGate.grantVerdict(IDENTIFIER, activeStandbyComp());
      expect(later).to.deep.equal(first);
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
      // a cold key is an UNDECIDED plane: no verdict, not "not leader" —
      // the false verdict needs a record naming a grantee (see the
      // undecided-plane describe below)
      expect(await mastershipGrantGate.leaderIsSelf(IDENTIFIER, 'myapp', true)).to.equal(null);
      // the pursuit is fire-and-forget; let its await chain (operator-state
      // read, record read) settle before asserting it reached acquire
      await new Promise((resolve) => { setTimeout(resolve, 25); });
      expect(grantClient.acquire.calledOnce).to.equal(true);

      grantClient.holderFor.returns({ state: 'held' });
      expect(await mastershipGrantGate.leaderIsSelf(IDENTIFIER, 'myapp', true)).to.equal(true);
    });

    // The self-fence exists to fence a DEPOSED node, and deposed means the
    // plane has DECIDED (a record names a grantee). An undecided plane — a
    // cold key at the crossing or an app's birth, an in-flight own
    // acquisition, an unreadable record — yields no verdict: a false there
    // would stop the running incumbent's container and forfeit the cold-key
    // head start. On the seeding path no-verdict correctly leaves the
    // legacy election in authority until the plane decides.
    describe('leaderIsSelf yields no verdict while the plane is undecided', () => {
      it('answers null while its own acquisition is in flight', async () => {
        mastershipGrantGate.resetForTests({ enabled: true });
        grantClient.isAcquiring.returns(true);
        expect(await mastershipGrantGate.leaderIsSelf(IDENTIFIER, 'myapp', true)).to.equal(null);
      });

      it('answers null on a cold key and still kicks the pursuit', async () => {
        mastershipGrantGate.resetForTests({ enabled: true });
        expect(await mastershipGrantGate.leaderIsSelf(IDENTIFIER, 'myapp', true)).to.equal(null);
        await new Promise((resolve) => { setTimeout(resolve, 25); });
        expect(grantClient.acquire.calledOnce).to.equal(true);
      });

      it('answers null when the record is unreadable', async () => {
        mastershipGrantGate.resetForTests({ enabled: true });
        messageStore.getMasterleaseRecord.rejects(new Error('store down'));
        expect(await mastershipGrantGate.leaderIsSelf(IDENTIFIER, 'myapp', true)).to.equal(null);
      });

      it('answers false once the plane has decided for someone else', async () => {
        mastershipGrantGate.resetForTests({ enabled: true });
        messageStore.getMasterleaseRecord.resolves({
          data: { grantee: `${'9'.repeat(64)}:0`, mode: 'held' },
        });
        expect(await mastershipGrantGate.leaderIsSelf(IDENTIFIER, 'myapp', true)).to.equal(false);
      });

      it('a record naming this node without a held term still fences the corpse', async () => {
        mastershipGrantGate.resetForTests({ enabled: true });
        messageStore.getMasterleaseRecord.resolves({
          data: { grantee: `${SELF_TXHASH}:0`, mode: 'held' },
        });
        expect(await mastershipGrantGate.leaderIsSelf(IDENTIFIER, 'myapp', true)).to.equal(false);
      });
    });

    it('masterIntent answers this node when it holds the term — its own held term, no record read', async () => {
      grantClient.holderFor.returns({ state: 'held' });
      networkStateService.membershipAt.returns([
        { txhash: SELF_TXHASH, outidx: 0, pubkey: 'owner-self', ip: '203.0.113.5:16127' },
      ]);
      const intent = await mastershipGrantGate.masterIntent(IDENTIFIER, activeStandbyComp());
      expect(intent).to.deep.equal({ ip: '203.0.113.5:16127', fdmOk: true });
      expect(messageStore.getMasterleaseRecord.called, 'a holder needs no record').to.equal(false);
    });

    it('masterIntent resolves a VERIFIED record\'s grantee, FDM-shaped — a committee signature, not FDM', async () => {
      networkStateService.membershipAt.returns([
        { txhash: '9'.repeat(64), outidx: 0, pubkey: 'owner-9', ip: '10.9.0.9:16127' },
      ]);
      messageStore.getMasterleaseRecord.resolves({ data: { grantee: `${'9'.repeat(64)}:0`, verified: true } });
      const intent = await mastershipGrantGate.masterIntent(IDENTIFIER, activeStandbyComp());
      expect(intent).to.deep.equal({ ip: '10.9.0.9:16127', fdmOk: true });
    });

    it('an UNVERIFIED record names no primary — a forged or unprovable claim never routes', async () => {
      networkStateService.membershipAt.returns([
        { txhash: '9'.repeat(64), outidx: 0, pubkey: 'owner-9', ip: '10.9.0.9:16127' },
      ]);
      messageStore.getMasterleaseRecord.resolves({ data: { grantee: `${'9'.repeat(64)}:0`, verified: false } });
      const intent = await mastershipGrantGate.masterIntent(IDENTIFIER, activeStandbyComp());
      expect(intent).to.deep.equal({ ip: null, fdmOk: true });
    });

    it('no record answers no-primary for the cycle, never a guess and never FDM', async () => {
      const intent = await mastershipGrantGate.masterIntent(IDENTIFIER, activeStandbyComp());
      expect(intent).to.deep.equal({ ip: null, fdmOk: true });
    });

    it('masterIntent answers null ONLY when the plane is not applicable — the sole path that lets FDM answer', async () => {
      mastershipGrantGate.resetForTests();
      expect(await mastershipGrantGate.masterIntent(IDENTIFIER, activeStandbyComp())).to.equal(null);
      mastershipGrantGate.resetForTests({ enabled: true });
      expect(await mastershipGrantGate.masterIntent(IDENTIFIER, plainComp())).to.equal(null);
    });

    it('a verified grantee no longer on the list resolves to no primary, not a stale address', async () => {
      networkStateService.membershipAt.returns([]);
      messageStore.getMasterleaseRecord.resolves({ data: { grantee: `${'9'.repeat(64)}:0`, verified: true } });
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
