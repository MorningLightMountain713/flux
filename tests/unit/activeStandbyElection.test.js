'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const activeStandbyElection = require('../../ZelBack/src/services/appLifecycle/activeStandbyElection');
const appOperations = require('../../ZelBack/src/services/appLifecycle/appOperations');
const primaryRole = require('../../ZelBack/src/services/appLifecycle/primaryRole');
const appGiveUp = require('../../ZelBack/src/services/appLifecycle/appGiveUp');
const peerComponent = require('../../ZelBack/src/services/appMonitoring/peerComponent');
const mastershipGrantGate = require('../../ZelBack/src/services/appLifecycle/mastershipGrantGate');
const appReconciler = require('../../ZelBack/src/services/appMonitoring/appReconciler');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const log = require('../../ZelBack/src/lib/log');
const deploymentProvider = require('../../ZelBack/src/services/appRuntime/deploymentProvider');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');
const fluxEventBus = require('../../ZelBack/src/services/utils/fluxEventBus');
const globalState = require('../../ZelBack/src/services/utils/globalState');
const appsRuntimeState = require('../../ZelBack/src/services/appManagement/appsRuntimeState');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const registryManager = require('../../ZelBack/src/services/appDatabase/registryManager');
const appQueryService = require('../../ZelBack/src/services/appQuery/appQueryService');
const syncthingService = require('../../ZelBack/src/services/syncthingService');
const config = require('config');
const { appsFolder } = require('../../ZelBack/src/services/utils/appConstants');
const { loadSpecLibrary, V9_SUBMISSION, v9Spec } = require('./fixtures/fluxSpec');

let flux;

// The operator stop lock as appsRuntimeState.operatorStopState answers it.
const UNLOCKED = {
  stopped: false, startRequested: false, force: false, asPrimary: false,
};
const LOCKED = { ...UNLOCKED, stopped: true };

describe('activeStandbyElection', () => {
  before(async function loadLibrary() {
    this.timeout(30_000);
    flux = await loadSpecLibrary();
  });

  function deploymentFor(spec, opts = {}) {
    return flux.DeploymentSpec.fromSpec(spec, appsFolder, { replica: null, registrationVersion: 9, ...opts });
  }

  function specWithComponents(appName, components) {
    const built = {};
    for (const [compName, overrides] of Object.entries(components)) {
      built[compName] = { ...V9_SUBMISSION.components.web, name: compName, ...overrides };
    }
    return v9Spec({ name: appName, components: built });
  }

  async function oneComponentDeployment(appName, compName, overrides = {}, depOpts = {}) {
    return deploymentFor(await specWithComponents(appName, { [compName]: overrides }), depOpts);
  }

  afterEach(() => {
    sinon.restore();
    operationRegistry.clear();
    activeStandbyElection.resetForTests();
  });

  // A pass is one call: the cadence lives in startActiveStandbyCoordinator's interval,
  // so a test drives passes by calling coordinateActiveStandbyApps directly.
  describe('coordinateActiveStandbyApps tests', () => {
    let globalStateRef;
    let deploymentProviderStub;

    // What makes a component a g:/masterSlave component on the real class:
    // persistentStorage.sync.mode === activeStandby. hasActiveStandbySyncthing()
    // and hasSyncthing() are derived from it, never set independently.
    const AS_STORAGE = {
      sizeGb: 5,
      mounts: { '/data': { source: 'data', destination: '/data' } },
      sync: { mode: 'activeStandby' },
    };

    /** A real DeploymentSpec for a single-component activeStandby app. */
    const gDeployment = (appName, identifier) => oneComponentDeployment(
      appName, identifier.split('_')[0], { persistentStorage: AS_STORAGE },
    );

    /**
     * A real MIXED app: a plain component declared first, then the activeStandby
     * one. The coordinator must walk past the sibling and act on the g: component.
     */
    async function mixedGDeployment(appName, asComponent) {
      const spec = await specWithComponents(appName, {
        db: { ports: { pg: { containerPort: 5432, hostPort: 31_001 } } },
        [asComponent]: { persistentStorage: AS_STORAGE },
      });
      return deploymentFor(spec);
    }

    /**
     * A running container as the node creates it: named by its component's
     * identifier and stamped with the identity labels the library makes.
     */
    async function runningContainerOf(deployComp) {
      const { identityLabels } = await loadSpecLibrary();
      return { Names: [`/${deployComp.identifier}`], Labels: identityLabels(deployComp) };
    }

    beforeEach(() => {
      globalStateRef = globalState;
      operationRegistry.clear();
      // the first-run mount-safety gate blocks election until the syncthing
      // monitor's first cycle completes; these tests model a settled node
      globalStateRef.syncthingAppsFirstRun = false;
      sinon.stub(appsRuntimeState, 'operatorStopState').resolves(UNLOCKED);
      sinon.stub(primaryRole, 'promote').returns(true);
      sinon.stub(primaryRole, 'standDown').returns(true);
      sinon.stub(primaryRole, 'holdAsPrimary').resolves();
      sinon.stub(primaryRole, 'holdAsStandby').resolves();
      sinon.stub(serviceHelper, 'delay').resolves();

      sinon.stub(syncthingService, 'getHealth').resolves({ status: 'OK' });

      deploymentProviderStub = sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves([]);

      sinon.stub(appQueryService, 'listRunningContainers').resolves([]);

      sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({}) });
      sinon.stub(dbHelper, 'findOneInDatabase').resolves(null);
    });

    it('skips the cycle while syncthing does not answer its health check with OK', async () => {
      syncthingService.getHealth.resolves({ status: 'starting' });

      await activeStandbyElection.electionPass();

      expect(deploymentProviderStub.called).to.be.false;
    });

    it('should skip execution while a folder-set-changing operation is in flight', async () => {
      operationRegistry.acquire('someapp', 'install', 'test');

      await activeStandbyElection.electionPass();

      expect(deploymentProviderStub.called).to.be.false;
    });

    it('should skip apps in backup progress', async () => {
      const appName = 'testapp';
      deploymentProviderStub.resolves([await gDeployment(appName, `web_${appName}`)]);
      operationRegistry.acquire(appName, 'backup', 'test');

      const axiosGetStub = sinon.stub(serviceHelper, 'axiosGet');

      await activeStandbyElection.electionPass();

      // The cycle runs (backup is not a folder-set-changing op) but skips the
      // backed-up app per-app, so it never probes that app's operator status.
      expect(deploymentProviderStub.called).to.be.true;
      expect(axiosGetStub.called).to.be.false;
    });

    it('stops only the active-standby component identifier on a standby node when FDM names a different primary', async () => {
      // Mixed app: 'n8n' is the active-standby component; the coordinator must act on the
      // component identifier (n8n_n8napp), never the app name or a sibling component.
      const identifier = 'n8n_n8napp';
      // coordinateActiveStandbyApps destructures listRunningContainers at module load, so it
      // can't be sinon-stubbed on the module object; proxyquire (callThru) overrides just that
      // one dependency while every other dep (delay, axiosGet, getLocalSocketAddress, docker,
      // deploymentProvider) is object-accessed and so is controlled by the sinon stubs below.
      const mixed = await mixedGDeployment('n8napp', 'n8n');
      expect(mixed.componentEntries()[0][0], 'the plain sibling comes first, so the walk must pass it').to.equal('db');
      expect(mixed.getComponent('n8n').identifier).to.equal(identifier);
      deploymentProviderStub.resolves([mixed]);

      // The active-standby component is currently running on THIS node.
      appQueryService.listRunningContainers.resolves([await runningContainerOf(mixed.getComponent('n8n'))]);

      // FDM reports the primary lives on a DIFFERENT node -> this node is a standby.
      sinon.stub(serviceHelper, 'axiosGet').resolves({ data: { status: 'success', data: { ips: ['203.0.113.99'] } } });

      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.5:16137');
      const count = sinon.stub(fluxEventBus, 'count');
      // The node FDM names has decided it holds the app.
      const undecided = sinon.stub(peerComponent, 'peerUndecided').resolves(false);

      await activeStandbyElection.electionPass();

      sinon.assert.calledOnceWithMatch(undecided, '203.0.113.99:16127', { appIds: [identifier] });
      // a pass that read a primary off FDM is tallied, whichever node it names
      sinon.assert.calledWithExactly(count, 'masterSlave:decision', identifier, 'primaryObserved');

      // The standby stands down the active-standby component by its identifier
      // and folder - never the app name or a sibling.
      sinon.assert.calledOnceWithExactly(primaryRole.standDown, identifier, mixed.getComponent('n8n').syncFolderId, { running: true });
    });

    it('does not stop its own container when it is the primary on a non-default (UPnP) port', async () => {
      // FDM returns a bare IP (no port); this node's socket has a non-default UPnP port. The
      // IP-granular ipsMatch must still recognise this node as the primary, so it must NOT stop
      // its own running container. (Port-sensitive matching would wrongly stop it.)
      const identifier = 'n8n_n8napp';
      const deployment = await gDeployment('n8napp', identifier);
      appQueryService.listRunningContainers.resolves([await runningContainerOf(deployment.getComponent('n8n'))]);

      deploymentProviderStub.resolves([deployment]);

      // FDM names THIS node as primary, returned as a bare IP (production format).
      sinon.stub(serviceHelper, 'axiosGet').resolves({ data: { status: 'success', data: { ips: ['192.168.1.5'] } } });

      // Same IP but a non-default (UPnP) port — ipsMatch ignores the port.
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.5:16137');
      await activeStandbyElection.electionPass();

      sinon.assert.notCalled(primaryRole.standDown);
      sinon.assert.calledOnceWithExactly(primaryRole.holdAsPrimary, identifier, deployment.getComponent('n8n').syncFolderId);
    });

    // The election's decisions are otherwise only observable as side effects on docker and
    // syncthing, so these assert the bus events the loop publishes for each decision.
    const decisionsFor = (publish, identifier, action) => publish.getCalls().filter(
      (c) => c.args[0] === 'activeStandby:decided'
        && c.args[1].identifier === identifier
        && c.args[1].action === action,
    );

    it('announces an operator-stopped component once, not on every pass', async () => {
      const identifier = 'opstopa_appa';
      deploymentProviderStub.resolves([await gDeployment('appa', identifier)]);

      appsRuntimeState.operatorStopState.resolves(LOCKED);
      const publish = sinon.stub(fluxEventBus, 'publish');

      const count = sinon.stub(fluxEventBus, 'count');

      await activeStandbyElection.electionPass();
      await activeStandbyElection.electionPass();

      // silence here is indistinguishable from a dead loop, but a line every 30s is noise
      expect(decisionsFor(publish, identifier, 'operatorStopExcluded')).to.have.lengthOf(1);
      // the tally reports every pass that honoured the stop
      expect(count.getCalls().filter((c) => c.args[1] === identifier && c.args[2] === 'operatorStopped'),
        'each pass that left the stopped component alone is counted').to.have.lengthOf(2);
    });

    it('leaves a component alone while the give-up pass has it standing down', async () => {
      // A node handing an app back stops writing first. The election would
      // otherwise see the component not running here and start it again.
      const identifier = 'stood_appc';
      deploymentProviderStub.resolves([await gDeployment('appc', identifier)]);
      sinon.stub(appGiveUp, 'isStandingDown').callsFake((id) => id === identifier);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.5:16137');
      const fdm = sinon.stub(serviceHelper, 'axiosGet').resolves({ data: { status: 'success', data: { ips: ['192.168.1.5'] } } });
      const publish = sinon.stub(fluxEventBus, 'publish');
      const count = sinon.stub(fluxEventBus, 'count');

      await activeStandbyElection.electionPass();
      await activeStandbyElection.electionPass();

      expect(fdm.called, 'a stood-down component is not a candidate, so nobody is asked who the primary is').to.be.false;
      expect(decisionsFor(publish, identifier, 'standDownExcluded')).to.have.lengthOf(1);
      expect(count.getCalls().filter((c) => c.args[1] === identifier && c.args[2] === 'standingDown'),
        'each pass that left the stood-down component alone is counted').to.have.lengthOf(2);
    });

    it('announces again after the operator lock is lifted and re-applied', async () => {
      const identifier = 'opstopb_appb';
      deploymentProviderStub.resolves([await gDeployment('appb', identifier)]);

      appsRuntimeState.operatorStopState.resolves(LOCKED);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.5:16137');
      sinon.stub(serviceHelper, 'axiosGet').resolves({ data: { status: 'success', data: { ips: [] } } });
      const publish = sinon.stub(fluxEventBus, 'publish');

      await activeStandbyElection.electionPass();

      appsRuntimeState.operatorStopState.resolves(UNLOCKED);
      await activeStandbyElection.electionPass();

      appsRuntimeState.operatorStopState.resolves(LOCKED);
      await activeStandbyElection.electionPass();

      expect(decisionsFor(publish, identifier, 'operatorStopCleared')).to.have.lengthOf(1);
      expect(decisionsFor(publish, identifier, 'operatorStopExcluded')).to.have.lengthOf(2);
    });

    // An app under an operation (backup, restore, install...) is left alone for
    // the cycle, and the skip is tallied so an observer can tell a pass that
    // considered the busy app from one that never ran.
    it('leaves a held app alone for the cycle and tallies the skip', async () => {
      const identifier = 'held_appq';
      deploymentProviderStub.resolves([await gDeployment('appq', identifier)]);
      operationRegistry.acquire('appq', 'backup', 'test', 'backup appq');
      const publish = sinon.stub(fluxEventBus, 'publish');
      const count = sinon.stub(fluxEventBus, 'count');

      await activeStandbyElection.electionPass();

      sinon.assert.calledWithExactly(count, 'masterSlave:decision', 'appq', 'skippedBusy');
      const decisions = publish.getCalls().filter((c) => c.args[0] === 'masterSlave:decision' && c.args[1]?.identifier === identifier);
      expect(decisions, 'an election decision was made on a held app').to.deep.equal([]);
    });

    // FDM's silence is not FDM saying there is no primary. A node that heard
    // nothing from any region must not read the silence as an invitation.
    it('skips primary selection for the cycle when no FDM region answers', async () => {
      const identifier = 'fdmsilent_appq';
      deploymentProviderStub.resolves([await gDeployment('appq', identifier)]);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.5:16137');
      sinon.stub(serviceHelper, 'axiosGet').rejects(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      const publish = sinon.stub(fluxEventBus, 'publish');
      const warn = sinon.stub(log, 'warn');

      await activeStandbyElection.electionPass();

      expect(warn.args.some(([message]) => String(message).includes('All FDM services failed')), 'the silence was named').to.equal(true);
      const decisions = publish.getCalls().filter((c) => c.args[0] === 'masterSlave:decision' && c.args[1]?.identifier === identifier);
      expect(decisions, 'an election decision was made on silence').to.deep.equal([]);
    });

    // Readiness without a synced mark is read off syncthing's folder list by the
    // id the resources record, never by the directory a name would build.
    describe('the readiness fallback when no synced mark is held', () => {
      // An app registered before v9: the folder id is its 8.x name, the
      // directory the component's identifier, so a match by one cannot pass
      // for a match by the other.
      const APP = 'appr';
      const identifier = 'web_appr';
      const FOLDER_ID = 'fluxweb_appr';
      let appLocation;

      beforeEach(async () => {
        const deployment = deploymentFor(await specWithComponents(APP, { web: { persistentStorage: AS_STORAGE } }), { registrationVersion: 8 });
        expect(deployment.getComponent('web').syncFolderId, 'the premise').to.equal(FOLDER_ID);
        deploymentProviderStub.resolves([deployment]);
        sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.5:16137');
        // FDM names no primary and the component is not running here: the pass
        // reaches the election, whose first act after readiness is to ask where
        // the app runs. That ask is the observation point, and it ends the pass.
        sinon.stub(serviceHelper, 'axiosGet').resolves({ data: { status: 'success', data: { ips: [] } } });
        appLocation = sinon.stub(registryManager, 'appLocation').rejects(new Error('observed: readiness passed'));
        sinon.stub(log, 'error');
      });

      it('treats a folder syncthing lists as sendreceive under the recorded id as ready', async () => {
        sinon.stub(syncthingService, 'getConfigFolders').resolves([
          { id: FOLDER_ID, path: `${appsFolder}${identifier}`, type: 'sendreceive' },
        ]);

        await activeStandbyElection.electionPass();

        sinon.assert.calledOnceWithExactly(appLocation, APP);
      });

      it('does not treat a sendreceive folder at the component\'s directory as ready when its id is not the recorded one', async () => {
        sinon.stub(syncthingService, 'getConfigFolders').resolves([
          { id: identifier, path: `${appsFolder}${identifier}`, type: 'sendreceive' },
        ]);

        await activeStandbyElection.electionPass();

        sinon.assert.notCalled(appLocation);
      });

      it('does not treat the recorded folder as ready while it is still receiveonly', async () => {
        sinon.stub(syncthingService, 'getConfigFolders').resolves([
          { id: FOLDER_ID, path: `${appsFolder}${identifier}`, type: 'receiveonly' },
        ]);

        await activeStandbyElection.electionPass();

        sinon.assert.notCalled(appLocation);
      });

      // FDM already names this node as the primary and the component is not
      // running here: the same readiness decides whether the promotion starts,
      // whose first act is to announce itself.
      describe('when FDM names this node as the primary', () => {
        beforeEach(() => {
          serviceHelper.axiosGet.resolves({ data: { status: 'success', data: { ips: ['192.168.1.5'] } } });
        });

        const started = () => primaryRole.promote.getCalls().filter((c) => c.args[0] === identifier && c.args[1] === FOLDER_ID);

        it('starts the promotion when syncthing lists the recorded folder as sendreceive', async () => {
          sinon.stub(syncthingService, 'getConfigFolders').resolves([
            { id: FOLDER_ID, path: `${appsFolder}${identifier}`, type: 'sendreceive' },
          ]);

          await activeStandbyElection.electionPass();

          expect(started()).to.have.lengthOf(1);
        });

        it('starts nothing when only a folder at the component\'s directory is sendreceive, under another id', async () => {
          sinon.stub(syncthingService, 'getConfigFolders').resolves([
            { id: identifier, path: `${appsFolder}${identifier}`, type: 'sendreceive' },
          ]);

          await activeStandbyElection.electionPass();

          expect(started()).to.have.lengthOf(0);
        });

        it('starts nothing while the recorded folder is still receiveonly', async () => {
          sinon.stub(syncthingService, 'getConfigFolders').resolves([
            { id: FOLDER_ID, path: `${appsFolder}${identifier}`, type: 'receiveonly' },
          ]);

          await activeStandbyElection.electionPass();

          expect(started()).to.have.lengthOf(0);
        });
      });
    });

    it('is driven by an interval at the configured cadence, not by re-arming itself', async () => {
      // The loop used to re-arm only from its own finally, so a pass that never settled
      // stopped election on the node permanently until FluxOS restarted.
      const setIntervalStub = sinon.stub(global, 'setInterval').returns('handle');

      const handle = appOperations.startActiveStandbyCoordinator();

      expect(handle).to.equal('handle');
      expect(setIntervalStub.calledOnce).to.be.true;
      expect(setIntervalStub.firstCall.args[1]).to.equal(config.fluxapps.masterSlaveIntervalMs);
    });

    it('never runs two passes at once', async () => {
      // The cadence is fixed, so a pass that outruns it would otherwise have a second one
      // racing its own promotions.
      let releaseFirstPass;
      deploymentProviderStub.onFirstCall().returns(new Promise((resolve) => {
        releaseFirstPass = () => resolve([]);
      }));
      deploymentProviderStub.resolves([]);
      const setIntervalStub = sinon.stub(global, 'setInterval');

      appOperations.startActiveStandbyCoordinator();
      const tick = setIntervalStub.firstCall.args[0];

      const firstPass = tick(); // starts and blocks in the middle of its work
      await Promise.resolve();
      await tick(); // must find the pass in flight and stand down
      expect(deploymentProviderStub.callCount, 'a tick during a pass must not start another').to.equal(1);

      releaseFirstPass();
      await firstPass; // the callback settles only once the pass has finished

      await tick();
      expect(deploymentProviderStub.callCount, 'the next tick after a pass settles must run').to.equal(2);
    });

    it('clears its own stale primary record so a stopped last primary can be elected again', async () => {
      // The node remembers itself as primary but is not running the component - the state
      // two production apps were stuck in for 12 and 25 hours, recoverable only by
      // restarting FluxOS. Without the eviction every start branch is closed to it.
      const identifier = 'staleprim_appc';
      const deployment = await gDeployment('appc', identifier);
      deploymentProviderStub.resolves([deployment]);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.5:16137');

      // Pass 1 records this node as primary (FDM names it, and it is running here, so the
      // loop takes no action beyond the record). Pass 2 is the wedge: FDM has forgotten the
      // app and the container is gone, leaving the record naming a node that isn't running it.
      appQueryService.listRunningContainers.onFirstCall().resolves([await runningContainerOf(deployment.getComponent(identifier.split('_')[0]))]);
      appQueryService.listRunningContainers.resolves([]);

      const axiosGet = sinon.stub(serviceHelper, 'axiosGet');
      axiosGet.onFirstCall().resolves({ data: { status: 'success', data: { ips: ['192.168.1.5'] } } });
      axiosGet.resolves({ data: { status: 'success', data: { ips: [] } } });

      // this node is index 0 and its data is ready
      sinon.stub(registryManager, 'appLocation').resolves([{ ip: '192.168.1.5:16137' }]);
      const folderId = deployment.getComponent(identifier.split('_')[0]).syncFolderId;
      globalStateRef.receiveOnlySyncthingAppsCache.set(folderId, { restarted: true });

      const publish = sinon.stub(fluxEventBus, 'publish');

      await activeStandbyElection.electionPass(); // records this node as primary
      await activeStandbyElection.electionPass(); // gone from FDM, and not running here

      expect(decisionsFor(publish, identifier, 'stalePrimaryEvicted')).to.have.lengthOf(1);
      globalStateRef.receiveOnlySyncthingAppsCache.delete(folderId);
    });
  });

  // Every row of the election, for an app registered on v9 and for one registered
  // before it, whose folder keeps its 8.x name: each role action names the
  // component by its identifier and its folder by its folder id.
  describe('decision table', () => {
    const appName = 'valheimapp';
    const IDENTITY = `b${'c'.repeat(52)}`;
    const here = '90.228.196.203:16127';
    const elsewhere = '10.9.9.9:16127';
    const AS = { sizeGb: 5, mounts: { '/data': { source: 'data', destination: '/data' } }, sync: { mode: 'activeStandby' } };
    const ROLE_ACTIONS = ['promote', 'standDown', 'holdAsPrimary', 'holdAsStandby'];
    const FIXTURES = {
      'registered on v9': async () => deploymentFor(await specWithComponents(appName, { valheim: { persistentStorage: AS } })),
      'registered before v9': async () => deploymentFor(
        await specWithComponents(appName, { valheim: { persistentStorage: AS } }),
        { identity: IDENTITY, names: { valheim: { syncFolderId: `fluxvalheim_${appName}`, aliases: [] } } },
      ),
    };
    const FDM_ROWS = [
      { names: 'here', running: true, expect: ['holdAsPrimary'] },
      { names: 'here', running: false, expect: ['promote'] },
      { names: 'other', running: true, expect: ['standDown'] },
      // standDown is asked first and finds nothing to stand down from
      { names: 'other', running: false, expect: ['standDown', 'holdAsStandby'] },
      { names: 'none', running: true, opinion: false, expect: ['adopt'] },
      { names: 'none', running: true, opinion: true, expect: [] },
      { names: 'here', running: true, operatorStopped: true, expect: [] },
    ];

    let role;
    let adopt;
    let othersHold;
    let undecided;
    let fdm;
    let intent;
    // The component's synced mark as the last pass read it.
    let entry;

    async function pass(deployment, row, { granted = false, mark = {} } = {}) {
      const component = deployment.getComponent('valheim');
      deploymentProvider.listInstalledDeployments.resolves([deployment]);
      const { identityLabels } = await loadSpecLibrary();
      appQueryService.listRunningContainers.resolves(row.running ? [{ Names: [`/${component.identifier}`], Labels: identityLabels(component) }] : []);
      sinon.stub(appReconciler, 'hasControllerOpinion').returns(row.opinion === true);
      appsRuntimeState.operatorStopState.resolves(row.operatorStopped ? LOCKED : UNLOCKED);
      globalState.receiveOnlySyncthingAppsCache.set(component.syncFolderId, { restarted: true, ...mark });
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves(row.names === 'other' ? '192.168.1.5:16127' : here);
      const named = { here, other: elsewhere, none: null }[row.names];
      fdm.resolves({ data: { status: 'success', data: { ips: named ? [named.split(':')[0]] : [] } } });
      if (granted) intent.resolves({ ip: named, fdmOk: true });
      entry = globalState.receiveOnlySyncthingAppsCache.get(component.syncFolderId);
      try {
        await activeStandbyElection.electionPass();
      } finally {
        globalState.receiveOnlySyncthingAppsCache.delete(component.syncFolderId);
      }
      return component;
    }

    beforeEach(() => {
      operationRegistry.clear();
      globalState.syncthingAppsFirstRun = false;
      sinon.stub(syncthingService, 'getHealth').resolves({ status: 'OK' });
      sinon.stub(syncthingService, 'getConfigFolders').resolves([]);
      sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves([]);
      sinon.stub(appQueryService, 'listRunningContainers').resolves([]);
      sinon.stub(appsRuntimeState, 'operatorStopState').resolves(UNLOCKED);
      sinon.stub(appsRuntimeState, 'releaseOperatorStart').resolves(true);
      sinon.stub(registryManager, 'appLocation').resolves([]);
      role = Object.fromEntries(ROLE_ACTIONS.map((name) => [name, sinon.stub(primaryRole, name).returns(true)]));
      adopt = sinon.stub(appReconciler, 'adoptControllerDesired').resolves(true);
      othersHold = sinon.stub(peerComponent, 'componentStateOnOtherHolders').resolves(peerComponent.PeerComponent.NOT_RUNNING);
      undecided = sinon.stub(peerComponent, 'peerUndecided').resolves(false);
      fdm = sinon.stub(serviceHelper, 'axiosGet');
      intent = sinon.stub(mastershipGrantGate, 'masterIntent').resolves(null);
    });

    const taken = () => ROLE_ACTIONS.filter((name) => role[name].called);

    describe('an app with one of two activeStandby components held down by its operator', () => {
      async function passTwoComponents({ granted }) {
        const deployment = deploymentFor(await specWithComponents(appName, { valheim: { persistentStorage: AS }, voice: { persistentStorage: AS, ports: { http: { containerPort: 80, hostPort: 31001 } } } }));
        const held = deployment.getComponent('voice');
        deploymentProvider.listInstalledDeployments.resolves([deployment]);
        appsRuntimeState.operatorStopState.withArgs(held.identifier).resolves(LOCKED);
        sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.5:16127');
        fdm.resolves({ data: { status: 'success', data: { ips: [elsewhere.split(':')[0]] } } });
        if (granted) intent.resolves({ ip: elsewhere, fdmOk: true });
        await activeStandbyElection.electionPass();
        return { free: deployment.getComponent('valheim').identifier, held: held.identifier };
      }

      it('stands both down when the grant names another node', async () => {
        const { free, held } = await passTwoComponents({ granted: true });

        expect(role.standDown.getCalls().map((call) => call.args[0])).to.have.members([free, held]);
      });

      it('leaves the held one alone when FDM names another node', async () => {
        const { free } = await passTwoComponents({ granted: false });

        expect(role.standDown.getCalls().map((call) => call.args[0])).to.deep.equal([free]);
      });
    });

    Object.entries(FIXTURES).forEach(([registered, build]) => {
      describe(`an app ${registered}`, () => {
        FDM_ROWS.forEach((row) => {
          const label = `FDM names ${{ here: 'this node', other: 'another node', none: 'nobody' }[row.names]}, `
            + `${row.running ? 'running' : 'stopped'} here`
            + `${row.opinion === undefined ? '' : `, opinion ${row.opinion ? 'held' : 'unknown'}`}`
            + `${row.operatorStopped ? ', operator-stopped' : ''} -> ${row.expect.join(' ') || 'nothing'}`;

          it(label, async () => {
            // as primaryRole answers: nothing to stand down from where it is not running
            role.standDown.returns(row.running);
            const component = await pass(await build(), row);

            if (row.expect[0] === 'adopt') {
              sinon.assert.calledOnceWithExactly(adopt, component.identifier, 'running', 'masterSlave holder, no primary named');
              expect(taken()).to.deep.equal([]);
              return;
            }
            sinon.assert.notCalled(adopt);
            expect(taken()).to.deep.equal(row.expect);
            row.expect.forEach((name) => sinon.assert.calledWith(role[name], component.identifier, component.syncFolderId));
          });
        });

        // With the grant plane open the grant is final: nobody is asked, and FDM
        // is not read.
        it('the grant names this node, stopped here -> promote, asking nobody', async () => {
          const component = await pass(await build(), { names: 'here', running: false }, { granted: true });

          expect(taken()).to.deep.equal(['promote']);
          sinon.assert.calledWith(role.promote, component.identifier, component.syncFolderId);
          sinon.assert.notCalled(othersHold);
          sinon.assert.notCalled(fdm);
        });

        it('the grant names another node, running here -> standDown, asking nobody', async () => {
          const component = await pass(await build(), { names: 'other', running: true }, { granted: true });

          expect(taken()).to.deep.equal(['standDown']);
          sinon.assert.calledWith(role.standDown, component.identifier, component.syncFolderId, { running: true });
          sinon.assert.notCalled(undecided);
          sinon.assert.notCalled(othersHold);
          sinon.assert.notCalled(fdm);
        });

        it('the grant names another node, stopped here -> holdAsStandby, reading the other holder as running', async () => {
          role.standDown.returns(false);
          const component = await pass(await build(), { names: 'other', running: false }, { granted: true });

          expect(taken()).to.deep.equal(['standDown', 'holdAsStandby']);
          const [identifier, folderId, { othersHold: standbyHolders, appName: named }] = role.holdAsStandby.firstCall.args;
          expect([identifier, folderId, named]).to.deep.equal([component.identifier, component.syncFolderId, appName]);
          expect(await standbyHolders()).to.equal(peerComponent.PeerComponent.RUNNING);
          // another node may already be writing: what this one has not sent is discarded
          expect(role.holdAsStandby.firstCall.args[2].grantedElsewhere).to.equal(true);
          sinon.assert.notCalled(othersHold);
          sinon.assert.notCalled(fdm);
        });

        // An owner's stop keeps the term this node holds. Once the grant names
        // another node its folder stops sending, and the stop lock stays.
        it('the grant names another node, operator-stopped here -> standDown', async () => {
          const component = await pass(await build(), { names: 'other', running: false, operatorStopped: true }, { granted: true });

          expect(taken()).to.deep.equal(['standDown']);
          sinon.assert.calledWith(role.standDown, component.identifier, component.syncFolderId, { running: false });
          sinon.assert.notCalled(appsRuntimeState.releaseOperatorStart);
          sinon.assert.notCalled(fdm);
        });

        it('the grant names another node, operator-stopped here with no role held -> holdAsStandby, unscanned', async () => {
          role.standDown.returns(false);
          const component = await pass(await build(), { names: 'other', running: false, operatorStopped: true }, { granted: true });

          expect(taken()).to.deep.equal(['standDown', 'holdAsStandby']);
          const [identifier, folderId, { grantedElsewhere, othersHold: standbyHolders }] = role.holdAsStandby.firstCall.args;
          expect([identifier, folderId, grantedElsewhere]).to.deep.equal([component.identifier, component.syncFolderId, true]);
          expect(await standbyHolders()).to.equal(peerComponent.PeerComponent.RUNNING);
        });

        it('the grant names this node, operator-stopped here -> nothing', async () => {
          await pass(await build(), { names: 'here', running: false, operatorStopped: true }, { granted: true });

          sinon.assert.calledOnce(intent);
          expect(taken()).to.deep.equal([]);
        });

        it('the grant names nobody yet, operator-stopped here -> nothing', async () => {
          await pass(await build(), { names: 'none', running: false, operatorStopped: true }, { granted: true });

          sinon.assert.calledOnce(intent);
          expect(taken()).to.deep.equal([]);
        });

        it('FDM names another node, operator-stopped here -> nothing', async () => {
          await pass(await build(), { names: 'other', running: false, operatorStopped: true });

          sinon.assert.calledOnce(intent);
          expect(taken()).to.deep.equal([]);
        });

        it('FDM names another node, stopped here -> holdAsStandby, which scans what this node wrote', async () => {
          role.standDown.returns(false);
          await pass(await build(), { names: 'other', running: false });

          expect(role.holdAsStandby.firstCall.args[2].grantedElsewhere).to.equal(false);
        });

        // A node that marked itself the seed withdraws the mark once another node
        // runs the app; the mark is kept under the folder id.
        it('withdraws this node\'s seed mark when another node is named', async () => {
          const deployment = await build();
          const { syncFolderId } = deployment.getComponent('valheim');
          globalState.seedMarks.set(syncFolderId, { stage: 'decided', bytes: 0, newestModified: 0 });
          try {
            await pass(deployment, { names: 'other', running: false });

            expect(globalState.seedMarks.has(syncFolderId)).to.equal(false);
          } finally {
            globalState.seedMarks.clear();
          }
        });

        // The seed is the only holder that can start a newborn app: nobody else
        // holds a copy to sync from, so it starts without waiting its turn.
        describe('the seed, after another holder in the order', () => {
          let peers;
          beforeEach(() => {
            registryManager.appLocation.resolves([
              { ip: elsewhere, runningSince: '2026-01-01T00:01:00.000Z' },
              { ip: here, runningSince: '2026-01-01T00:02:00.000Z' },
            ]);
            peers = sinon.stub(peerComponent, 'componentStateOnPeers').resolves(peerComponent.PeerComponent.NOT_RUNNING);
          });

          it('starts at once, and spends the designation', async () => {
            const component = await pass(await build(), { names: 'none', running: false }, { mark: { designatedLeader: true } });

            expect(taken()).to.deep.equal(['promote']);
            sinon.assert.calledWith(role.promote, component.identifier, component.syncFolderId);
            sinon.assert.called(peers);
            expect(entry.designatedLeader).to.equal(false);
          });

          it('waits its turn without the designation', async () => {
            await pass(await build(), { names: 'none', running: false });

            expect(taken()).to.deep.equal([]);
          });

          it('starts nothing while a peer cannot be ruled out, and keeps the designation', async () => {
            peers.resolves(peerComponent.PeerComponent.UNKNOWN);
            await pass(await build(), { names: 'none', running: false }, { mark: { designatedLeader: true } });

            expect(taken()).to.deep.equal([]);
            expect(entry.designatedLeader).to.equal(true);
          });

          it('starts nothing while a peer runs the app, and spends the designation', async () => {
            peers.resolves(peerComponent.PeerComponent.RUNNING);
            await pass(await build(), { names: 'none', running: false }, { mark: { designatedLeader: true } });

            expect(taken()).to.deep.equal([]);
            expect(entry.designatedLeader).to.equal(false);
          });
        });

        it('the grant names nobody yet -> nothing, and FDM is not read', async () => {
          intent.resolves({ ip: null, fdmOk: true });
          await pass(await build(), { names: 'none', running: false });

          expect(taken()).to.deep.equal([]);
          sinon.assert.notCalled(adopt);
          sinon.assert.notCalled(fdm);
        });

        it('the grant plane closed for the app -> FDM is read', async () => {
          await pass(await build(), { names: 'here', running: true });

          sinon.assert.called(fdm);
          sinon.assert.calledWith(intent, sinon.match.string, sinon.match.has('syncFolderId'));
        });
      });
    });
  });

});
