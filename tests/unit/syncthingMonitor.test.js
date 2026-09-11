'use strict';

// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
// Real registry singleton - un-stubbed in proxyquire, so the module under test
// and the test share it.
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');
const { appsFolder } = require('../../ZelBack/src/services/utils/appConstants');
const {
  loadSpecLibrary, V9_SUBMISSION, v9Spec, assertAnswers,
} = require('./fixtures/fluxSpec');

// The spec library is real here, not stubbed - see tests/unit/fixtures/fluxSpec.js
// for why. What stays stubbed is I/O: the syncthing API, docker, mongo, and the
// filesystem walks the folder state machine performs.
let flux;

// Create mocks for all dependencies

const serviceHelperMock = {
  delay: sinon.stub().resolves(),
};

const dockerServiceMock = {
  // The real one is `flux${identifier}` - a pure string function over the
  // component identifier, so the stub reproduces it rather than inventing an
  // identity mapping. That makes the syncthing folder id in these tests the
  // same string production would use, and the same one `deployComp.dir` ends in.
  getAppIdentifier: sinon.stub().callsFake((identifier) => `flux${identifier}`),
  dockerContainerInspect: sinon.stub(),
  appDockerStart: sinon.stub(),
};

const fluxNetworkHelperMock = {
  getLocalSocketAddress: sinon.stub(),
};

const syncthingServiceMock = {
  getDeviceId: sinon.stub(),
  getConfigFolders: sinon.stub(),
  getConfigDevices: sinon.stub(),
  adjustConfigDevices: sinon.stub().resolves(),
  adjustConfigFolders: sinon.stub().resolves(),
  getFolderIdErrors: sinon.stub(),
  systemRestart: sinon.stub().resolves(),
  getDbStatus: sinon.stub(),
};

const syncthingFolderStateMachineMock = {
  manageFolderSyncState: sinon.stub().resolves({
    syncthingFolder: { type: 'sendreceive' },
    cache: null,
  }),
  getFolderSyncCompletion: sinon.stub(),
  isDesignatedLeader: sinon.stub(),
  verifyFolderMountSafety: sinon.stub().resolves({ isSafe: true, isMounted: true, fileCount: 1 }),
  // The startup mount-safety scan calls this; it walks the folder on disk, so it
  // is I/O and stays stubbed. It was missing from this double entirely, which
  // meant the first-run scan threw into syncthingAppsCore's swallowing catch.
  verifySendReceiveFolderSafety: sinon.stub().resolves({ isSafe: true, isMounted: true, fileCount: 3 }),
};

const syncthingMonitorHelpersMock = {
  sortAndFilterLocations: sinon.stub().callsFake((locs) => locs),
  buildDeviceConfiguration: sinon.stub().resolves([]),
  createSyncthingFolderConfig: sinon.stub().callsFake((id, label, path, devices, type) => ({
    id,
    label,
    path,
    devices,
    type: type || 'sendreceive',
  })),
  // Creates the .stfolder marker on disk - I/O. True means the marker is ready.
  ensureStfolderExists: sinon.stub().resolves(true),
  // Converges .stignore through syncthing's API - I/O.
  ensureStignoreCovers: sinon.stub().resolves(),
  getContainerFolderPath: sinon.stub().returns(''),
  folderNeedsUpdate: sinon.stub().returns(false),
};

const syncthingHealthMonitorMock = {
  monitorFolderHealth: sinon.stub().resolves({
    actions: [],
    summary: { healthy: 0, warnings: 0, issues: 0 },
  }),
};

const deploymentProviderMock = {
  listInstalledDeployments: sinon.stub().resolves([]),
  // The pass asks the DETAILED form, because an app it could not read is not an
  // app that is not installed and the plain list cannot tell those apart. This
  // answers from the same stub so a test that only cares about deployments says
  // one thing, and overrides it where the distinction is the point.
  listInstalledDeploymentsDetailed: sinon.stub(),
};
deploymentProviderMock.listInstalledDeploymentsDetailed.callsFake(async () => ({
  deployments: await deploymentProviderMock.listInstalledDeployments(),
  unreadableAppNames: new Set(),
}));

const syncthingEventsConsumerMock = {
  start: sinon.stub(),
  stop: sinon.stub().resolves(),
  isRunning: sinon.stub().returns(false),
  getFolderErrors: sinon.stub(),
  mountVerifyPendingIds: sinon.stub().returns([]),
  resolveMountVerify: sinon.stub(),
};

const volumeServiceMock = {
  ensureAppVolumeMounted: sinon.stub().resolves({ mounted: true, alreadyMounted: true }),
};

const appReconcilerMock = {
  setControllerDesired: sinon.stub(),
};

// Where an app runs is a mongo read - I/O, stubbed.
const appsRepositoryMock = {
  appLocationFromEvents: sinon.stub().resolves([]),
};

// Load module with mocked dependencies
// Peer liveness, observed rather than performed: the real one probes peers over
// the network, and what this file needs to see is WHICH peers a pass decides to
// ask and how many times it asks.
const livenessMock = {
  read: sinon.stub().resolves({ reachable: true, answerable: true, ready: true, folders: [] }),
  prewarm: sinon.stub().resolves(),
  localConnectivity: sinon.stub().returns({ connected: true, responding: 1, total: 1 }),
};

const syncthingMonitor = proxyquire('../../ZelBack/src/services/appMonitoring/syncthingMonitor', {
  './peerFolderLiveness': { createPeerFolderLiveness: () => livenessMock },
  '../serviceHelper': serviceHelperMock,
  '../dockerService': dockerServiceMock,
  '../fluxNetworkHelper': fluxNetworkHelperMock,
  '../syncthingService': syncthingServiceMock,
  '../appDatabase/appsRepository': appsRepositoryMock,
  '../appRuntime/deploymentProvider': deploymentProviderMock,
  './appReconciler': appReconcilerMock,
  './syncthingFolderStateMachine': syncthingFolderStateMachineMock,
  './syncthingMonitorHelpers': syncthingMonitorHelpersMock,
  './syncthingHealthMonitor': syncthingHealthMonitorMock,
  './syncthingEventsConsumer': syncthingEventsConsumerMock,
  '../utils/volumeService': volumeServiceMock,
});

/**
 * What makes a component a syncthing component on the real class:
 * persistentStorage.sync. hasSyncthing() / hasActiveStandbySyncthing() /
 * requiresSyncBeforeStart() are all derived from it and cannot be set
 * independently - which is exactly what a hand-written double used to do.
 *
 * The content slot is deliberate: content delivery writes that file on every
 * node and .stignore's it, so the real component's injectedSyncExcludes() is
 * non-empty. The mount-safety walks must receive it, or a fresh volume holding
 * only delivered files reads as "has content" and masks a wiped dataset.
 */
const ACTIVE_STANDBY_STORAGE = {
  sizeGb: 5,
  mounts: {
    '/data': { source: 'data', destination: '/data' },
    '/etc/app/motd.txt': {
      source: 'motd.txt',
      destination: '/etc/app/motd.txt',
      type: 'file',
      contentSlot: 'motd',
      onUpdate: { action: 'restart' },
    },
  },
  sync: { mode: 'activeStandby' },
};

describe('syncthingMonitor tests', () => {
  let mockState;
  let mockGetGlobalStateFn;
  let monitorControl;
  let clock;
  // Real DeploymentSpec objects, built once. They are built in `before` because
  // the fake clock installed in `beforeEach` would otherwise be in place while
  // the library loads and compiles its schemas.
  let syncDeployment;
  let plainDeployment;
  let syncComp;
  let syncFolderId;

  /**
   * A real DeploymentSpec - the class deploymentProvider hands syncthingMonitor
   * in production, built the same way (same appsFolder). `replica` is stated,
   * never defaulted, exactly as DeploymentSpec.fromSpec demands.
   */
  async function deploymentFor(appName, compName, overrides = {}) {
    // Callers pass content-slot mounts, which only work on the encrypted path,
    // so the envelope is stated for every spec this helper builds.
    const spec = await v9Spec({
      name: appName,
      components: {
        [compName]: { ...V9_SUBMISSION.components.web, name: compName, ...overrides },
      },
    }, { encrypted: true });
    return flux.DeploymentSpec.fromSpec(spec, appsFolder, { replica: null });
  }

  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30_000);
    flux = await loadSpecLibrary();

    syncDeployment = await deploymentFor('testapp', 'web', { persistentStorage: ACTIVE_STANDBY_STORAGE });
    plainDeployment = await deploymentFor('testapp', 'web');
    syncComp = syncDeployment.getComponent('web');
    syncFolderId = `flux${syncComp.identifier}`;

    // The sync state under test is derived by the library from the submission,
    // never asserted onto the object here.
    expect(syncComp.hasSyncthing(), 'persistentStorage.sync makes it a syncthing component').to.be.true;
    expect(syncComp.hasActiveStandbySyncthing(), 'mode activeStandby is the g: contract').to.be.true;
    expect(syncComp.requiresSyncBeforeStart(), 'activeStandby is not syncFirst').to.be.false;
    expect(plainDeployment.getComponent('web').hasSyncthing(), 'no sync block, no syncthing').to.be.false;
    // A composed (v4+) component's identifier is comp_app - the bare app name is
    // the flat v1-v3 form and cannot be minted from a v9 spec.
    expect(syncComp.identifier).to.equal('web_testapp');
    // The syncthing folder id and the component's host directory are the same
    // docker identifier, which is what makes `${appsFolder}${appId}` the folder.
    expect(syncComp.dir).to.equal(`${appsFolder}${syncFolderId}`);
  });

  beforeEach(() => {
    mockState = {
      updateSyncthingRunning: false,
      syncthingDevicesIDCache: new Map(),
      receiveOnlySyncthingAppsCache: new Map(),
      syncthingAppsFirstRun: false,
    };
    mockGetGlobalStateFn = sinon.stub();

    // Reset all mocked services
    deploymentProviderMock.listInstalledDeployments.reset();
    deploymentProviderMock.listInstalledDeployments.resolves([]);
    deploymentProviderMock.listInstalledDeploymentsDetailed.resetHistory();
    deploymentProviderMock.listInstalledDeploymentsDetailed.callsFake(async () => ({
      deployments: await deploymentProviderMock.listInstalledDeployments(),
      unreadableAppNames: new Set(),
    }));
    syncthingServiceMock.getDeviceId.reset();
    syncthingServiceMock.getConfigFolders.reset();
    syncthingServiceMock.getConfigDevices.reset();
    syncthingServiceMock.adjustConfigDevices.reset();
    syncthingServiceMock.adjustConfigDevices.resolves();
    syncthingServiceMock.adjustConfigFolders.reset();
    syncthingServiceMock.adjustConfigFolders.resolves();
    syncthingServiceMock.getFolderIdErrors.reset();
    syncthingServiceMock.systemRestart.reset();
    syncthingServiceMock.getDbStatus.reset();
    fluxNetworkHelperMock.getLocalSocketAddress.reset();
    dockerServiceMock.dockerContainerInspect.reset();
    dockerServiceMock.appDockerStart.reset();
    dockerServiceMock.getAppIdentifier.resetHistory();
    syncthingHealthMonitorMock.monitorFolderHealth.reset();
    syncthingEventsConsumerMock.start.reset();
    syncthingEventsConsumerMock.stop.reset();
    syncthingEventsConsumerMock.stop.resolves();
    syncthingEventsConsumerMock.mountVerifyPendingIds.reset();
    syncthingEventsConsumerMock.mountVerifyPendingIds.returns([]);
    syncthingEventsConsumerMock.resolveMountVerify.reset();
    volumeServiceMock.ensureAppVolumeMounted.reset();
    volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: true, alreadyMounted: true });
    syncthingFolderStateMachineMock.verifyFolderMountSafety.reset();
    syncthingFolderStateMachineMock.verifyFolderMountSafety.resolves({ isSafe: true, isMounted: true, fileCount: 1 });
    syncthingFolderStateMachineMock.verifySendReceiveFolderSafety.reset();
    syncthingFolderStateMachineMock.verifySendReceiveFolderSafety.resolves({ isSafe: true, isMounted: true, fileCount: 3 });
    syncthingFolderStateMachineMock.manageFolderSyncState.reset();
    syncthingFolderStateMachineMock.manageFolderSyncState.resolves({
      syncthingFolder: { type: 'sendreceive' },
      cache: null,
    });
    syncthingMonitorHelpersMock.ensureStignoreCovers.resetHistory();
    syncthingMonitorHelpersMock.ensureStfolderExists.reset();
    syncthingMonitorHelpersMock.ensureStfolderExists.resolves(true);
    syncthingMonitorHelpersMock.createSyncthingFolderConfig.resetHistory();
    syncthingMonitorHelpersMock.buildDeviceConfiguration.resetHistory();
    syncthingMonitorHelpersMock.folderNeedsUpdate.resetHistory();
    appsRepositoryMock.appLocationFromEvents.reset();
    appsRepositoryMock.appLocationFromEvents.resolves([]);
    livenessMock.prewarm.resetHistory();
    livenessMock.read.resetHistory();
    appReconcilerMock.setControllerDesired.reset();

    // Default stub behaviors
    syncthingServiceMock.getConfigFolders.resolves({ data: [] });
    syncthingServiceMock.getConfigDevices.resolves({ data: [] });
    syncthingServiceMock.getConfigRestartRequired.resolves({
      status: 'success',
      data: { requiresRestart: false },
    });
    syncthingHealthMonitorMock.monitorFolderHealth.resolves({
      actions: [],
      summary: { healthy: 0, warnings: 0, issues: 0 },
    });

    // Use fake timers to control setInterval
    clock = sinon.useFakeTimers();
  });

  afterEach(() => {
    // Stop monitoring service if running
    if (monitorControl && monitorControl.isActive()) {
      monitorControl.stop();
    }
    operationRegistry.clear();
    clock.restore();
  });

  describe('syncthingApps tests', () => {
    it('should return control object with stop and isActive methods', () => {
      syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
      fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );

      expect(monitorControl).to.have.property('stop').that.is.a('function');
      expect(monitorControl).to.have.property('isActive').that.is.a('function');
      expect(monitorControl.isActive()).to.be.true;
    });

    it('should stop monitoring when stop is called', () => {
      syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
      fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );

      expect(monitorControl.isActive()).to.be.true;
      monitorControl.stop();
      expect(monitorControl.isActive()).to.be.false;
    });

    it('should not run while a folder-set-changing operation is in flight', async () => {
      operationRegistry.acquire('someapp', 'install', 'test');

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );

      // Wait for first execution to complete
      await clock.tickAsync(100);

      sinon.assert.notCalled(deploymentProviderMock.listInstalledDeploymentsDetailed);
      expect(mockState.updateSyncthingRunning).to.be.false;
    });

    it('runs the cycle during a backup (backup is per-app, never a whole-cycle freeze)', async () => {
      operationRegistry.acquire('someapp', 'backup', 'test');

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );

      // Wait for first execution to complete
      await clock.tickAsync(100);

      sinon.assert.called(deploymentProviderMock.listInstalledDeployments);
    });

    // This file stubs through proxyquire and has no sinon.restore, so the bus
    // stub is taken and given back here rather than leaking into the next test.
    describe('the pass says it ran', () => {
      // eslint-disable-next-line global-require
      const fluxEventBus = require('../../ZelBack/src/services/utils/fluxEventBus');
      let publish;

      beforeEach(() => {
        publish = sinon.stub(fluxEventBus, 'publish');
        // The pass returns early unless syncthing answers both config reads -
        // the guard that stops it acting on a half-loaded config - and it needs
        // this node's own identity to build a device list at all.
        syncthingServiceMock.getConfigFolders.resolves({ data: [] });
        syncthingServiceMock.getConfigDevices.resolves({ data: [] });
        syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
        fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');
      });

      afterEach(() => {
        publish.restore();
      });

      const passes = () => publish.getCalls()
        .filter((c) => c.args[0] === 'syncthing:passComplete').map((c) => c.args[1]);

      // A pass with nothing to change writes nothing and logs nothing, so "the
      // pass ran and had nothing to do" and "the pass never ran" are the same
      // silence. The harness has waited on this event since the replay and
      // nothing published it - the unused fluxEventBus import in this file was
      // the only trace it was ever meant to.
      it('announces that the pass reached the folder write', async () => {
        deploymentProviderMock.listInstalledDeployments.resolves([]);

        monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
        await clock.tickAsync(100);

        expect(passes(), 'exactly one per pass').to.have.lengthOf(1);
        expect(passes()[0]).to.have.all.keys('wrote', 'heldForBusy');
      });

      // promotedFolderIds had two readers and NO writer, so it stayed null,
      // /apps/promotedfolders answered ready:false forever, and every folder
      // with at least one peer was blocked from promotion fleet-wide.
      it('publishes which folders this node holds writable', async () => {
        // eslint-disable-next-line global-require
        const globalStateModule = require('../../ZelBack/src/services/utils/globalState');
        globalStateModule.promotedFolderIds = null;
        deploymentProviderMock.listInstalledDeployments.resolves([]);
        syncthingServiceMock.getConfigFolders.resolves({
          data: [
            { id: 'fluxweb_writable', type: 'sendreceive' },
            { id: 'fluxweb_readonly', type: 'receiveonly' },
          ],
        });

        monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
        await clock.tickAsync(100);

        expect(globalStateModule.promotedFolderIds, 'null is "this node has not answered yet"').to.not.equal(null);
        expect([...globalStateModule.promotedFolderIds]).to.deep.equal(['fluxweb_writable']);
      });

      // ONE TIMEOUT FOR THE PASS. Both promotion decisions ask the same peers
      // the same question, and the folder loop is sequential - asked inside it,
      // one unreachable holder costs its full timeout again for every folder
      // that elects it. prewarm existed on peerFolderLiveness with no caller.
      it('asks the holders of a folder awaiting promotion once, for the whole pass', async () => {
        deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
        mockState.receiveOnlySyncthingAppsCache.set(syncFolderId, { numberOfExecutions: 1 });
        appsRepositoryMock.appLocationFromEvents.resolves([
          { ip: '10.0.0.7:16127' }, { ip: '10.0.0.8:16127' },
          // the same holder twice, and this node itself: neither is worth asking
          { ip: '10.0.0.7:16127' }, { ip: '10.0.0.1:16127' },
        ]);

        monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
        await clock.tickAsync(100);

        sinon.assert.calledOnce(livenessMock.prewarm);
        const asked = [...livenessMock.prewarm.firstCall.args[0]];
        expect(asked, 'this node probed itself, or a holder was not probed')
          .to.have.members(['10.0.0.7:16127', '10.0.0.8:16127', '10.0.0.7:16127']);
      });

      // SENDRECEIVE IS THE ONLY MODE THAT CAN BROADCAST A DELETION, so it is the
      // only mode where a stale index over an empty volume has to be refused
      // rather than noted - which is what the deeper verifier does. The flag
      // saying which folders syncthing holds sendreceive was never passed to the
      // mount check, so it defaulted to false and the deeper check never ran on
      // any folder, ever.
      it('verifies a sendreceive folder at the deeper level, and a receiveonly one at the shallow', async () => {
        deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
        syncthingEventsConsumerMock.mountVerifyPendingIds.returns([syncFolderId]);
        syncthingServiceMock.getConfigFolders.resolves({
          data: [{ id: syncFolderId, type: 'sendreceive', path: syncComp.dir }],
        });

        monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
        await clock.tickAsync(100);

        sinon.assert.called(syncthingFolderStateMachineMock.verifySendReceiveFolderSafety);
        sinon.assert.notCalled(syncthingFolderStateMachineMock.verifyFolderMountSafety);
      });

      it('leaves a receiveonly folder to the shallow check, which is all it can do harm with', async () => {
        deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
        syncthingEventsConsumerMock.mountVerifyPendingIds.returns([syncFolderId]);
        syncthingServiceMock.getConfigFolders.resolves({
          data: [{ id: syncFolderId, type: 'receiveonly', path: syncComp.dir }],
        });

        monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
        await clock.tickAsync(100);

        sinon.assert.called(syncthingFolderStateMachineMock.verifyFolderMountSafety);
        sinon.assert.notCalled(syncthingFolderStateMachineMock.verifySendReceiveFolderSafety);
      });

      // AN APP THIS NODE COULD NOT READ IS NOT AN APP THAT IS NOT INSTALLED.
      // The sweep deletes any folder no installed app owns, and a deployment
      // list drops an app whose spec failed to decrypt - so the folder of an
      // enterprise app this node cannot read right now was removed as an
      // orphan, taking the index, the peer device list and any standing safety
      // demotion with it, and not coming back until the app is readable again.
      it('protects the folders of an app it could not read from the sweep', async () => {
        deploymentProviderMock.listInstalledDeploymentsDetailed.resolves({
          deployments: [],
          unreadableAppNames: new Set(['sealed']),
        });
        syncthingServiceMock.getConfigFolders.resolves({
          data: [
            { id: 'fluxweb_sealed', type: 'sendreceive' },
            { id: 'fluxweb_gone', type: 'sendreceive' },
          ],
        });

        monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
        await clock.tickAsync(100);

        const deleted = syncthingServiceMock.adjustConfigFolders.getCalls()
          .filter((call) => call.args[0] === 'delete')
          .map((call) => call.args[2]);
        expect(deleted, 'a folder was kept or removed on the wrong side of readability')
          .to.deep.equal(['fluxweb_gone']);
      });

      // Protected from the SWEEP, not from the mount check. The verdict derives
      // entirely from the folder id, so a folder whose owning app cannot be read
      // is verified all the same - one held sendreceive over a vanished mount
      // broadcasts its emptiness whether or not this node can read the spec that
      // named it.
      it('still mount-checks the folder of an app it could not read', async () => {
        deploymentProviderMock.listInstalledDeploymentsDetailed.resolves({
          deployments: [],
          unreadableAppNames: new Set(['sealed']),
        });
        syncthingServiceMock.getConfigFolders.resolves({
          data: [{ id: 'fluxweb_sealed', type: 'sendreceive' }],
        });

        monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
        await clock.tickAsync(100);

        const checked = syncthingFolderStateMachineMock.verifySendReceiveFolderSafety
          .getCalls().map((call) => call.args[0]);
        expect(checked, 'an unreadable app\'s folder went unverified').to.include('fluxweb_sealed');
      });

      // THE IGNORE POLICY IS CONVERGED THROUGH SYNCTHING, which owns .stignore
      // and writes it atomically. Nothing called this: without it every byte a
      // copy, extract or upload stages replicates to every peer only to be
      // deleted again on publish, and a peer's boot sweep can delete a
      // replicated staging directory a live operation elsewhere still needs.
      it('converges the ignore policy on a folder syncthing already knows', async () => {
        deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
        syncthingServiceMock.getConfigFolders.resolves({
          data: [{ id: syncFolderId, type: 'sendreceive', path: `${appsFolder}${syncFolderId}` }],
        });

        monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
        await clock.tickAsync(100);

        sinon.assert.calledWith(syncthingMonitorHelpersMock.ensureStignoreCovers, syncFolderId);
      });

      // The one pass where a fresh install is not yet configured. Its .stignore
      // was seeded at volume creation, and posting ignores for a folder
      // syncthing does not have is not a no-op - it is an error per folder,
      // every pass, until the folder is added.
      it('leaves a folder syncthing does not know yet alone', async () => {
        deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
        syncthingServiceMock.getConfigFolders.resolves({ data: [] });

        monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
        await clock.tickAsync(100);

        sinon.assert.notCalled(syncthingMonitorHelpersMock.ensureStignoreCovers);
      });

      // A node whose synced apps are all running has nothing waiting on a peer,
      // and must keep asking nobody - the probe is not free.
      it('asks nobody when no folder is awaiting promotion', async () => {
        deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
        mockState.receiveOnlySyncthingAppsCache.set(syncFolderId, { restarted: true });
        appsRepositoryMock.appLocationFromEvents.resolves([{ ip: '10.0.0.7:16127' }]);

        monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
        await clock.tickAsync(100);

        sinon.assert.notCalled(livenessMock.prewarm);
      });

      // Set only from a validated read, so a failed one leaves the last good
      // answer standing rather than momentarily claiming this node holds nothing.
      it('leaves the last good answer standing when syncthing does not answer', async () => {
        // eslint-disable-next-line global-require
        const globalStateModule = require('../../ZelBack/src/services/utils/globalState');
        globalStateModule.promotedFolderIds = new Set(['fluxweb_previous']);
        syncthingServiceMock.getConfigFolders.resolves(undefined);

        monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
        await clock.tickAsync(100);

        expect([...globalStateModule.promotedFolderIds]).to.deep.equal(['fluxweb_previous']);
      });

      it('names the folders it held back for a busy app, not just the ones it wrote', async () => {
        // Backup is per-app, so the cycle RUNS and this one app is left alone.
        // Saying so is the difference between "left alone" and "not reached".
        deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
        operationRegistry.acquire('testapp', 'backup', 'test');

        monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
        await clock.tickAsync(100);

        expect(passes()).to.have.lengthOf(1);
        expect(passes()[0].heldForBusy).to.deep.equal([syncFolderId]);
        expect(passes()[0].wrote, 'a held app contributes nothing to the write').to.not.include(syncFolderId);
      });
    });

    it('should not run if already running', async () => {
      mockState.updateSyncthingRunning = true;

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );

      // Wait for first execution to complete
      await clock.tickAsync(100);

      sinon.assert.notCalled(deploymentProviderMock.listInstalledDeployments);
    });

    it('should switch unsafe-mount folders to receiveonly on first run WITHOUT restarting syncthing', async () => {
      // The receiveonly PATCH applies live on syncthing v2 (verified against the
      // fleet's v2.0.x) - a process restart here drops every folder's transfers
      // and delays startup by 5s for nothing.
      mockState.syncthingAppsFirstRun = true;
      syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
      fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');
      syncthingServiceMock.getConfigFolders.resolves({
        data: [{ id: syncFolderId, path: syncComp.dir, type: 'sendreceive' }],
      });
      // The folder is sendreceive, so the mount check takes the DEEPER verifier -
      // that is the only mode that can broadcast a deletion, so it is the only
      // one where a stale index over an empty volume must be refused.
      syncthingFolderStateMachineMock.verifyFolderMountSafety.resolves({ isSafe: false, reason: 'not mounted' });
      syncthingFolderStateMachineMock.verifySendReceiveFolderSafety.resolves({ isSafe: false, reason: 'not mounted' });
      deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );
      await clock.tickAsync(10_000);

      sinon.assert.calledWithExactly(syncthingServiceMock.adjustConfigFolders, 'patch', { type: 'receiveonly' }, syncFolderId);
      sinon.assert.notCalled(syncthingServiceMock.systemRestart);

      // The folder-id the demotion targets is derived from the real component's
      // identifier, and the app name rolled up with it from the real deployment -
      // both stay stubbed collaborator inputs, so read them back.
      // Read off the DEEPER verifier: this folder is sendreceive, so that is the
      // one the mount check consults, and the shallow one is never called.
      const [checkedId, checkedFolder, checkedOpts] = syncthingFolderStateMachineMock
        .verifySendReceiveFolderSafety.firstCall.args;
      expect(checkedId, 'the mount check is keyed by the docker identifier').to.equal(syncFolderId);
      expect(checkedFolder, 'and the folder is that identifier under the apps folder').to.equal(`${appsFolder}${syncFolderId}`);
      expect(checkedOpts.appName, 'the owning app, for incident roll-up').to.equal('testapp');
    });

    // A stateless component has no volume by design — appVolumeService returns
    // early and never creates its directory. Checking for that directory anyway
    // reported base_directory_missing on every pass, which returns before
    // syncthingInitializedSuccessfully is set, so syncthingAppsFirstRun never
    // cleared and syncthing was never configured for ANY app on the node. It
    // also recorded a mount_vanished tampering event each pass, for a volume
    // that was never meant to exist.
    //
    // Invisible while the components were literals: every hand-written double
    // implicitly had a volume, so this loop was never handed one that legitimately
    // does not.
    it('does not mount-check a stateless component, or wedge the cycle on it', async () => {
      const stateless = await deploymentFor('statelessapp', 'web', {
        persistentStorage: { sizeGb: 0 },
      });
      expect(stateless.getComponent('web').isStateless, 'fixture must be stateless').to.be.true;
      expect(stateless.getComponent('web').dir, 'and therefore has no directory').to.equal(null);

      // First run is when every deployment is mount-verified — the pass that
      // has to complete before syncthingAppsFirstRun can clear.
      mockState.syncthingAppsFirstRun = true;
      syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
      deploymentProviderMock.listInstalledDeployments.resolves([stateless]);

      monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
      await clock.tickAsync(10_000);

      sinon.assert.notCalled(syncthingFolderStateMachineMock.verifyFolderMountSafety);
      // The cycle got past the mount gate rather than skipping on a folder that
      // was never supposed to be there.
      sinon.assert.called(syncthingServiceMock.getDeviceId);
    });

    it('demotes a sendreceive folder over an unrepairable mount while skipping the cycle', async () => {
      // repair fails (backing image gone) so the whole cycle is skipped, but a
      // folder left sendreceive over the bad mount could still broadcast its disk
      // state - it must be demoted and its container held before bailing.
      deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
      syncthingEventsConsumerMock.mountVerifyPendingIds.returns([syncFolderId]);
      syncthingFolderStateMachineMock.verifyFolderMountSafety.resolves({ isSafe: false, isMounted: false, reason: 'unmounted_with_content' });
      // sendreceive, so the DEEPER verifier is the one consulted.
      syncthingFolderStateMachineMock.verifySendReceiveFolderSafety.resolves({ isSafe: false, isMounted: false, reason: 'unmounted_with_content' });
      volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: false, reason: 'volume_file_missing' });
      syncthingServiceMock.getConfigFolders.resolves({ data: [{ id: syncFolderId, type: 'sendreceive' }] });

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );
      await clock.tickAsync(100);

      sinon.assert.calledWithExactly(syncthingServiceMock.adjustConfigFolders, 'patch', { type: 'receiveonly' }, syncFolderId);
      // The reconciler is keyed by the BARE component identifier, never the
      // docker-prefixed folder id and never the app name. That value comes off
      // the real DeploymentComponent, and the reconciler stays stubbed.
      sinon.assert.calledWith(appReconcilerMock.setControllerDesired, syncComp.identifier, 'stopped');
      expect(appReconcilerMock.setControllerDesired.firstCall.args[0]).to.equal('web_testapp');
      expect(appReconcilerMock.setControllerDesired.calledWith('testapp'), 'never acts by app name').to.be.false;
      // the cycle itself was skipped - per-app processing never ran
      sinon.assert.notCalled(syncthingServiceMock.getDeviceId);
    });

    it('keeps a mount-verify flag standing while the mount is still unsafe', async () => {
      // The flag is the node's memory that this folder's mount is in question.
      // Clearing it by READING it - which is what the old drainErroredFolderIds
      // did in one call - loses that memory the moment the pass looks, so a pass
      // that dies before it acts never retries the folder it was asked about.
      // Only a completed outcome resolves it, and "still unsafe" is not one.
      deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
      syncthingEventsConsumerMock.mountVerifyPendingIds.returns([syncFolderId]);
      syncthingFolderStateMachineMock.verifyFolderMountSafety.resolves({ isSafe: false, isMounted: false, reason: 'unmounted_with_content' });
      volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: false, reason: 'volume_file_missing' });
      // receiveonly, so the SHALLOW verifier is the one consulted - the deeper
      // check exists for the mode that can broadcast a deletion.
      syncthingServiceMock.getConfigFolders.resolves({ data: [{ id: syncFolderId, type: 'receiveonly' }] });

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );
      await clock.tickAsync(100);

      sinon.assert.notCalled(syncthingEventsConsumerMock.resolveMountVerify);
    });

    it('resolves a mount-verify flag once that folder verifies safe', async () => {
      // The other half, and the one that proves the assertion above is not
      // vacuous: the same path DOES clear the flag when the question is answered.
      deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
      syncthingEventsConsumerMock.mountVerifyPendingIds.returns([syncFolderId]);
      syncthingFolderStateMachineMock.verifyFolderMountSafety.resolves({ isSafe: true, isMounted: true });
      volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: true, alreadyMounted: true });

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );
      await clock.tickAsync(100);

      sinon.assert.calledWith(syncthingEventsConsumerMock.resolveMountVerify, syncFolderId);
    });

    it('does not re-patch an unsafe folder that is already receiveonly', async () => {
      deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
      syncthingEventsConsumerMock.mountVerifyPendingIds.returns([syncFolderId]);
      syncthingFolderStateMachineMock.verifyFolderMountSafety.resolves({ isSafe: false, isMounted: false, reason: 'empty_unmounted_directory' });
      volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: false, reason: 'volume_file_missing' });
      syncthingServiceMock.getConfigFolders.resolves({ data: [{ id: syncFolderId, type: 'receiveonly' }] });

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );
      await clock.tickAsync(100);

      sinon.assert.notCalled(syncthingServiceMock.adjustConfigFolders);
      sinon.assert.notCalled(appReconcilerMock.setControllerDesired);
    });

    it('does not sweep mounts in steady state (no FolderErrors, not first run)', async () => {
      // an unsafe mount exists (verifyFolderMountSafety would report it if asked),
      // but nothing flagged it - the steady-state pass must not go looking:
      // syncthing's .stfolder marker converts real storage loss into
      // FolderErrors, which is the only trigger. The pass still proceeds.
      deploymentProviderMock.listInstalledDeployments.resolves([plainDeployment]);
      syncthingFolderStateMachineMock.verifyFolderMountSafety.resolves({ isSafe: false, isMounted: false, reason: 'empty_unmounted_directory' });
      syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
      fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );
      await clock.tickAsync(100);

      // a sweep would run checkAppFolderMounts over the installed deployment
      sinon.assert.notCalled(syncthingFolderStateMachineMock.verifyFolderMountSafety);
      // the pass itself proceeded - it was not skipped
      sinon.assert.called(syncthingServiceMock.getDeviceId);
    });

    it('drives the folder state machine from the real component, not from an asserted flag', async () => {
      // The state machine stays stubbed, so nothing else proves the values it is
      // handed are the ones a real DeploymentComponent answers. Every one of them
      // is derived by the library from persistentStorage.sync / the content slots.
      syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
      fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');
      deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );
      await clock.tickAsync(100);

      // The provider stays stubbed too: read the deployment back off it and check
      // it can answer everything syncthingAppsCore asks. The whole cycle runs
      // inside a try/catch that logs and swallows, so a member that vanished from
      // the library would otherwise show up only as a silently skipped pass.
      const handed = await deploymentProviderMock.listInstalledDeployments.firstCall.returnValue;
      assertAnswers(handed[0], ['componentEntries']);
      const [, handedComp] = handed[0].componentEntries()[0];
      assertAnswers(handedComp, [
        'hasSyncthing', 'hasActiveStandbySyncthing', 'requiresSyncBeforeStart', 'injectedSyncExcludes',
      ]);

      sinon.assert.calledOnce(syncthingFolderStateMachineMock.manageFolderSyncState);
      const [params] = syncthingFolderStateMachineMock.manageFolderSyncState.firstCall.args;
      expect(params.isActiveStandby, 'hasActiveStandbySyncthing() decides the election-owned mode').to.be.true;
      expect(params.requiresSyncBeforeStart, 'requiresSyncBeforeStart() is syncFirst only').to.be.false;
      expect(params.appId, 'the docker identifier is the syncthing folder id').to.equal(syncFolderId);
      expect(params.identifier, 'and the bare component identifier travels alongside it').to.equal(syncComp.identifier);
      expect(params.installedAppName).to.equal('testapp');
      // injectedSyncExcludes() is what keeps content-delivered files out of the
      // emptiness walk; an empty array here lets delivered content certify a
      // wiped dataset as populated.
      expect(params.injectedExcludePaths).to.deep.equal(syncComp.injectedSyncExcludes());
      expect(params.injectedExcludePaths, 'the content slot must reach the walk').to.have.lengthOf(1);

      // The folder configured for it is the component's own directory.
      const [id, label, folderPath] = syncthingMonitorHelpersMock.createSyncthingFolderConfig.firstCall.args;
      expect(id).to.equal(syncFolderId);
      expect(label).to.equal(syncFolderId);
      expect(folderPath).to.equal(syncComp.dir);
    });

    it('keeps an installed syncthing component folder that was skipped this cycle', async () => {
      // "Unused" means no installed app owns the folder, and ownership is
      // hasSyncthing() on the real component. A skipped pass leaves the folder
      // out of folderIds, so a wrong answer here deletes a live app's folder.
      syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
      fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');
      deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
      syncthingServiceMock.getConfigFolders.resolves({
        data: [{ id: syncFolderId, path: syncComp.dir, type: 'sendreceive' }],
      });
      syncthingFolderStateMachineMock.manageFolderSyncState.resolves({
        syncthingFolder: { type: 'receiveonly' },
        cache: null,
        skipProcessing: true,
      });

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );
      await clock.tickAsync(100);

      expect(
        syncthingServiceMock.adjustConfigFolders.calledWith('delete', undefined, syncFolderId),
        'an installed component owns its folder even when the pass skipped it',
      ).to.be.false;
    });

    it('removes a folder no installed component claims', async () => {
      // The counterpart: the same folder, owned by nothing, IS pruned. Without
      // this the retention test above would pass on a monitor that never deletes.
      syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
      fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');
      deploymentProviderMock.listInstalledDeployments.resolves([plainDeployment]);
      syncthingServiceMock.getConfigFolders.resolves({
        data: [{ id: syncFolderId, path: syncComp.dir, type: 'sendreceive' }],
      });

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );
      await clock.tickAsync(100);

      // The plain component declares no sync, so it configures no folder at all...
      sinon.assert.notCalled(syncthingFolderStateMachineMock.manageFolderSyncState);
      sinon.assert.notCalled(syncthingMonitorHelpersMock.createSyncthingFolderConfig);
      // ...and the orphaned folder is removed.
      expect(syncthingServiceMock.adjustConfigFolders.calledWith('delete', undefined, syncFolderId)).to.be.true;
    });

    it('hands the startup safety scan the real component injected excludes and app name', async () => {
      // First run walks syncthing's own folder list, so it starts from a folder id
      // and has to resolve the owning component itself. Both values it resolves
      // come off real objects and go to a stubbed collaborator.
      mockState.syncthingAppsFirstRun = true;
      syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
      fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');
      deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
      syncthingServiceMock.getConfigFolders.resolves({
        data: [{ id: syncFolderId, path: syncComp.dir, type: 'sendreceive' }],
      });

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );
      await clock.tickAsync(100);

      // TWO calls on a first run, and they are different questions: the mount
      // check asks about every folder it verifies, and the startup safety scan
      // asks about each sendreceive folder with the component's injected
      // excludes. Only the scan carries those, so that is the call read here.
      const scanCall = syncthingFolderStateMachineMock.verifySendReceiveFolderSafety
        .getCalls().find((call) => call.args[2] && 'injectedExcludePaths' in call.args[2]);
      expect(scanCall, 'the startup safety scan never ran').to.not.equal(undefined);
      const [scannedId, scannedPath, opts] = scanCall.args;
      expect(scannedId).to.equal(syncFolderId);
      expect(scannedPath).to.equal(syncComp.dir);
      expect(opts.injectedExcludePaths, 'resolved from the component the folder id belongs to')
        .to.deep.equal(syncComp.injectedSyncExcludes());
      expect(opts.injectedExcludePaths).to.have.lengthOf(1);
      expect(opts.appName, 'the owning app, for incident roll-up').to.equal('testapp');
      // A safe folder is left alone - no demotion.
      sinon.assert.neverCalledWith(syncthingServiceMock.adjustConfigFolders, 'patch', { type: 'receiveonly' }, syncFolderId);
    });

    it('should start the events consumer (edge accelerator) and stop it on shutdown', async () => {
      syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
      fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );

      sinon.assert.calledOnce(syncthingEventsConsumerMock.start);
      const handlers = syncthingEventsConsumerMock.start.firstCall.args[0];
      expect(handlers.onFolderActivity).to.be.a('function');
      expect(handlers.onResync).to.be.a('function');

      monitorControl.stop();
      sinon.assert.calledOnce(syncthingEventsConsumerMock.stop);
    });

    it('should run an early evaluation for a folder in active transition', async () => {
      // events never decide anything - they only run the SAME monitoring pass
      // earlier than the interval would, and only for folders the state machine
      // is actively transitioning (in the receiveOnly cache, not yet restarted).
      syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
      fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');
      mockState.receiveOnlySyncthingAppsCache.set(syncFolderId, { numberOfExecutions: 3 });

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );
      await clock.tickAsync(100); // initial run completes
      const runsAfterStart = deploymentProviderMock.listInstalledDeployments.callCount;

      const handlers = syncthingEventsConsumerMock.start.firstCall.args[0];
      handlers.onFolderActivity(syncFolderId, 'FolderSummary');
      handlers.onFolderActivity(syncFolderId, 'StateChanged'); // coalesces

      // a continuous event stream must not drive back-to-back passes: nothing
      // fires before the min gap from the last completed pass
      await clock.tickAsync(2500);
      expect(deploymentProviderMock.listInstalledDeployments.callCount).to.equal(runsAfterStart);

      // past the min gap, before the interval
      await clock.tickAsync(8500);
      expect(deploymentProviderMock.listInstalledDeployments.callCount).to.equal(runsAfterStart + 1);
    });

    it('should NOT accelerate on activity from steady-state folders', async () => {
      // a healthy folder (synced, or a busy app writing into it) emits events
      // continuously - those belong to the level pass, never the accelerator, or
      // a busy g: app degenerates the cadence into back-to-back full passes.
      syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
      fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');
      // a completed transition (restarted) is steady state too
      mockState.receiveOnlySyncthingAppsCache.set(syncFolderId, { restarted: true });

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );
      await clock.tickAsync(100); // initial run completes
      const runsAfterStart = deploymentProviderMock.listInstalledDeployments.callCount;

      const handlers = syncthingEventsConsumerMock.start.firstCall.args[0];
      handlers.onFolderActivity('fluxweb_untracked', 'FolderSummary');
      handlers.onFolderActivity(syncFolderId, 'FolderSummary');
      handlers.onFolderActivity(syncFolderId, 'StateChanged');

      await clock.tickAsync(15_000); // well past debounce and min gap

      expect(deploymentProviderMock.listInstalledDeployments.callCount).to.equal(runsAfterStart);
    });

    it('should accelerate on FolderErrors regardless of folder state', async () => {
      // FolderErrors is syncthing's own storage-went-bad signal (e.g. the
      // .stfolder marker vanished with its mount) - always worth an early pass,
      // even for a folder the state machine is not otherwise transitioning.
      syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
      fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );
      await clock.tickAsync(100); // initial run completes
      const runsAfterStart = deploymentProviderMock.listInstalledDeployments.callCount;

      const handlers = syncthingEventsConsumerMock.start.firstCall.args[0];
      handlers.onFolderActivity('fluxweb_untracked', 'FolderErrors');

      await clock.tickAsync(11_000); // past the min gap from the last completed pass

      expect(deploymentProviderMock.listInstalledDeployments.callCount).to.equal(runsAfterStart + 1);
    });

    it('should prevent overlapping executions', async () => {
      let resolveFirst;
      const firstPromise = new Promise((resolve) => {
        resolveFirst = resolve;
      });

      deploymentProviderMock.listInstalledDeployments.onFirstCall().returns(firstPromise);
      deploymentProviderMock.listInstalledDeployments.onSecondCall().resolves([]);

      syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
      fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );

      // First execution starts immediately
      await clock.tickAsync(1);

      // Advance to next interval while first is still running
      await clock.tickAsync(30_000);

      // First execution still not complete - should skip second call
      expect(deploymentProviderMock.listInstalledDeployments.callCount).to.equal(1);

      // Complete first execution
      resolveFirst([]);
      // Give time for all async operations in the promise chain to complete
      await clock.tickAsync(100);

      // Now advance to next interval - should execute again
      await clock.tickAsync(30_000);
      await clock.tickAsync(100);

      expect(deploymentProviderMock.listInstalledDeployments.callCount).to.be.greaterThan(1);
    });

    it('should run at regular intervals', async () => {
      syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
      fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );

      // Wait for first execution to complete
      await clock.tickAsync(100);
      const firstCallCount = deploymentProviderMock.listInstalledDeployments.callCount;

      // Advance to next interval and let it complete
      await clock.tickAsync(30_000);
      await clock.tickAsync(100);

      expect(deploymentProviderMock.listInstalledDeployments.callCount).to.be.greaterThan(firstCallCount);
    });
  });
});
