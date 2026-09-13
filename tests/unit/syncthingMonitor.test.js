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
  // These answer rows, as the service does, so a call site reading one as an
  // envelope is visible from here.
  adjustConfigDevices: sinon.stub().resolves({}),
  adjustConfigFolders: sinon.stub().resolves({}),
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

// The real setSyncedMark stamps the mark with the volume's filesystem id, which
// is a findmnt call. The stamp belongs to appCaches; what this file needs to see
// is WHICH mark a pass writes. This stores it as the real one does, with the
// unreadable stamp an unmounted volume answers.
const appCachesMock = {
  setSyncedMark: sinon.stub().callsFake(async (marks, appId, cache) => {
    const stamped = { ...cache, volumeUuid: null };
    marks.set(appId, stamped);
    return stamped;
  }),
  syncedMark: sinon.stub().callsFake(async (marks, appId) => marks.get(appId) || null),
};

const appReconcilerMock = {
  setControllerDesired: sinon.stub(),
};

// LOUDNESS IS A BEHAVIOUR on the safety paths: a demotion this node could not
// apply leaves a folder broadcasting a bad mount, and the pass saying so is the
// only signal anything gets. The real logger cannot be asserted on.
const logMock = {
  error: sinon.stub(),
  warn: sinon.stub(),
  info: sinon.stub(),
  debug: sinon.stub(),
  child: sinon.stub(),
};
logMock.child.returns(logMock);
const loggedErrors = () => logMock.error.getCalls()
  .map((call) => String(call.args[0]));

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
  '../utils/appCaches': appCachesMock,
  '../../lib/log': logMock,
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
    syncthingServiceMock.adjustConfigDevices.resolves({});
    syncthingServiceMock.adjustConfigFolders.reset();
    syncthingServiceMock.adjustConfigFolders.resolves({});
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
    // reset(), not resetHistory(): a test that drives this true must not leak
    // it into every test after it
    syncthingMonitorHelpersMock.folderNeedsUpdate.reset();
    syncthingMonitorHelpersMock.folderNeedsUpdate.returns(false);
    appsRepositoryMock.appLocationFromEvents.reset();
    appsRepositoryMock.appLocationFromEvents.resolves([]);
    livenessMock.prewarm.resetHistory();
    livenessMock.read.resetHistory();
    appReconcilerMock.setControllerDesired.reset();
    appCachesMock.setSyncedMark.resetHistory();
    logMock.error.resetHistory();
    logMock.warn.resetHistory();
    logMock.info.resetHistory();
    logMock.debug.resetHistory();

    // Default stub behaviors
    syncthingServiceMock.getConfigFolders.resolves([]);
    syncthingServiceMock.getConfigDevices.resolves([]);
    syncthingServiceMock.getConfigRestartRequired.resolves({ requiresRestart: false });
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
        syncthingServiceMock.getConfigFolders.resolves([]);
        syncthingServiceMock.getConfigDevices.resolves([]);
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
        syncthingServiceMock.getConfigFolders.resolves([
          { id: 'fluxweb_writable', type: 'sendreceive' },
          { id: 'fluxweb_readonly', type: 'receiveonly' },
        ]);

        monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
        await clock.tickAsync(100);

        expect(globalStateModule.promotedFolderIds, 'null is "this node has not answered yet"').to.not.equal(null);
        expect([...globalStateModule.promotedFolderIds]).to.deep.equal(['fluxweb_writable']);
      });

      // THE TWO READS ARE CAUGHT SEPARATELY, and these say why that is not
      // tidiness. Sharing one try meant the device read throwing returned the
      // pass, and the folders it had ALREADY READ went unpublished - so every
      // peer asking which folders this node holds writable was told to wait,
      // for as long as the device read kept failing. Ported from development,
      // which has had this coverage all along; this tree gained the behaviour
      // when the envelope-shaped reads were corrected and gained no test with it.
      it('publishes the folders it read even though the device read threw', async () => {
        // eslint-disable-next-line global-require
        const globalStateModule = require('../../ZelBack/src/services/utils/globalState');
        globalStateModule.promotedFolderIds = null;
        deploymentProviderMock.listInstalledDeployments.resolves([]);
        syncthingServiceMock.getConfigFolders.resolves([
          { id: 'fluxweb_writable', type: 'sendreceive' },
          { id: 'fluxweb_readonly', type: 'receiveonly' },
        ]);
        syncthingServiceMock.getConfigDevices.rejects(new Error('simulated unreadable device configuration'));

        monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
        await clock.tickAsync(100);

        expect(globalStateModule.promotedFolderIds, 'the pass withheld folders it had read').to.not.equal(null);
        expect([...globalStateModule.promotedFolderIds]).to.deep.equal(['fluxweb_writable']);
      });

      // A folder read it could not complete is the other case: there is then
      // nothing to publish, and the last good answer must stand rather than be
      // replaced by a claim that this node holds nothing writable.
      it('leaves the last good answer standing when the folder read itself threw', async () => {
        // eslint-disable-next-line global-require
        const globalStateModule = require('../../ZelBack/src/services/utils/globalState');
        globalStateModule.promotedFolderIds = new Set(['fluxweb_writable']);
        deploymentProviderMock.listInstalledDeployments.resolves([]);
        syncthingServiceMock.getConfigFolders.rejects(new Error('simulated unreadable folder configuration'));

        monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
        await clock.tickAsync(100);

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
        syncthingServiceMock.getConfigFolders.resolves([{ id: syncFolderId, type: 'sendreceive', path: syncComp.dir }]);

        monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
        await clock.tickAsync(100);

        sinon.assert.called(syncthingFolderStateMachineMock.verifySendReceiveFolderSafety);
        sinon.assert.notCalled(syncthingFolderStateMachineMock.verifyFolderMountSafety);
      });

      it('leaves a receiveonly folder to the shallow check, which is all it can do harm with', async () => {
        deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
        syncthingEventsConsumerMock.mountVerifyPendingIds.returns([syncFolderId]);
        syncthingServiceMock.getConfigFolders.resolves([{ id: syncFolderId, type: 'receiveonly', path: syncComp.dir }]);

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
        syncthingServiceMock.getConfigFolders.resolves([
          { id: 'fluxweb_sealed', type: 'sendreceive' },
          { id: 'fluxweb_gone', type: 'sendreceive' },
        ]);

        monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
        await clock.tickAsync(100);

        const deleted = syncthingServiceMock.adjustConfigFolders.getCalls()
          .map((call) => call.args[0])
          .filter((options) => options.method === 'delete')
          .map((options) => options.id);
        expect(deleted, 'a folder was kept or removed on the wrong side of readability')
          .to.deep.equal(['fluxweb_gone']);
      });

      // The single-app case, and the property the two-folder test above cannot
      // show: an app this node cannot read costs its own folders' sweep and
      // NOTHING ELSE. Standing the whole pass down instead would stop folder
      // registration, mount safety, promotion and error draining for every app
      // on the node, for as long as one app stayed sealed.
      it('deletes nothing when an enterprise spec cannot be decrypted, and finishes the pass', async () => {
        deploymentProviderMock.listInstalledDeploymentsDetailed.resolves({
          deployments: [],
          unreadableAppNames: new Set(['sealed']),
        });
        syncthingServiceMock.getConfigFolders.resolves([{ id: 'fluxweb_sealed', type: 'sendreceive' }]);

        monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
        await clock.tickAsync(100);

        const deleted = syncthingServiceMock.adjustConfigFolders.getCalls()
          .map((call) => call.args[0])
          .filter((options) => options.method === 'delete');
        expect(deleted, 'the only folder belongs to an app whose spec says nothing').to.deep.equal([]);
        expect(passes(), 'and the pass ran to the folder write anyway').to.have.lengthOf(1);
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
        syncthingServiceMock.getConfigFolders.resolves([{ id: 'fluxweb_sealed', type: 'sendreceive' }]);

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
        syncthingServiceMock.getConfigFolders.resolves([{ id: syncFolderId, type: 'sendreceive', path: `${appsFolder}${syncFolderId}` }]);

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
        syncthingServiceMock.getConfigFolders.resolves([]);

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

      // A backup or restore rebuilds the app's folders itself and holds an
      // operation lease while it works, so no promotion decision is being made
      // underneath it and the peers must not be probed on its behalf.
      it('asks nothing about an app suspended for backup', async () => {
        deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
        mockState.receiveOnlySyncthingAppsCache.set(syncFolderId, { numberOfExecutions: 1 });
        appsRepositoryMock.appLocationFromEvents.resolves([{ ip: '10.0.0.7:16127' }]);
        operationRegistry.acquire(syncDeployment.appName, 'backup', 'test');

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
      syncthingServiceMock.getConfigFolders.resolves([{ id: syncFolderId, path: syncComp.dir, type: 'sendreceive' }]);
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

      sinon.assert.calledWithExactly(syncthingServiceMock.adjustConfigFolders, { method: 'patch', config: { type: 'receiveonly' }, id: syncFolderId });
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

    it('demotes a sendreceive folder over an unrepairable mount and holds it out of the pass', async () => {
      // repair fails (backing image gone), so the folder is demoted and its
      // container held - and the pass carries on. An unsafe mount is an APP-level
      // fault, not a node-level one.
      deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
      syncthingEventsConsumerMock.mountVerifyPendingIds.returns([syncFolderId]);
      syncthingFolderStateMachineMock.verifyFolderMountSafety.resolves({ isSafe: false, isMounted: false, reason: 'unmounted_with_content' });
      // sendreceive, so the DEEPER verifier is the one consulted.
      syncthingFolderStateMachineMock.verifySendReceiveFolderSafety.resolves({ isSafe: false, isMounted: false, reason: 'unmounted_with_content' });
      volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: false, reason: 'volume_file_missing' });
      syncthingServiceMock.getConfigFolders.resolves([{ id: syncFolderId, type: 'sendreceive' }]);

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );
      await clock.tickAsync(100);

      sinon.assert.calledWithExactly(syncthingServiceMock.adjustConfigFolders, { method: 'patch', config: { type: 'receiveonly' }, id: syncFolderId });
      // The reconciler is keyed by the BARE component identifier, never the
      // docker-prefixed folder id and never the app name. That value comes off
      // the real DeploymentComponent, and the reconciler stays stubbed.
      sinon.assert.calledWith(appReconcilerMock.setControllerDesired, syncComp.identifier, 'stopped');
      expect(appReconcilerMock.setControllerDesired.firstCall.args[0]).to.equal('web_testapp');
      expect(appReconcilerMock.setControllerDesired.calledWith('testapp'), 'never acts by app name').to.be.false;
      // the pass carried on past the app it held out
      sinon.assert.called(syncthingServiceMock.getDeviceId);
    });

    // ONE APP'S DEAD VOLUME MUST NOT TAKE THE NODE'S SYNCTHING WITH IT. An app
    // whose backing image is gone can never be mounted, so ending the pass on it
    // ends every pass: no folder registration, no promotion, no error draining
    // and no writable-folder answer for any app on the node, permanently - and
    // the first-run flag never clears, so the full sweep repeats every cycle.
    it('processes healthy apps, and clears the first-run flag, when another app can never mount', async () => {
      const healthy = await deploymentFor('healthyapp', 'web', { persistentStorage: ACTIVE_STANDBY_STORAGE });
      const healthyId = `flux${healthy.getComponent('web').identifier}`;
      mockState.syncthingAppsFirstRun = true;
      deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment, healthy]);
      const brokenMount = async (appId) => (appId === syncFolderId
        ? { isSafe: false, isMounted: false, reason: 'volume_file_missing' }
        : { isSafe: true, isMounted: true, fileCount: 1 });
      syncthingFolderStateMachineMock.verifyFolderMountSafety.callsFake(brokenMount);
      syncthingFolderStateMachineMock.verifySendReceiveFolderSafety.callsFake(brokenMount);
      volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: false, reason: 'volume_file_missing' });
      syncthingServiceMock.getConfigFolders.resolves([]);
      syncthingServiceMock.getConfigDevices.resolves([]);
      syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
      fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');

      monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
      await clock.tickAsync(100);

      const configured = syncthingMonitorHelpersMock.ensureStfolderExists.getCalls().map((call) => String(call.args[0]));
      expect(configured.some((dir) => dir.endsWith(healthyId)), 'the healthy app was configured').to.be.true;
      expect(configured.some((dir) => dir.endsWith(syncFolderId)), 'the broken one was held out').to.be.false;
      expect(mockState.syncthingAppsFirstRun, 'the first-run flag cleared, so the full sweep does not repeat forever').to.be.false;
    });

    // While an app is held out, this pass never did its work - so it never saw
    // that app's peers and cannot tell a peer that is gone from one it simply
    // did not visit.
    it('stands the device sweep down while an app is held out of the pass', async () => {
      deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
      syncthingEventsConsumerMock.mountVerifyPendingIds.returns([syncFolderId]);
      syncthingFolderStateMachineMock.verifyFolderMountSafety.resolves({ isSafe: false, isMounted: false, reason: 'volume_file_missing' });
      syncthingFolderStateMachineMock.verifySendReceiveFolderSafety.resolves({ isSafe: false, isMounted: false, reason: 'volume_file_missing' });
      volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: false, reason: 'volume_file_missing' });
      syncthingServiceMock.getConfigFolders.resolves([{ id: syncFolderId, type: 'sendreceive' }]);
      syncthingServiceMock.getConfigDevices.resolves([{ deviceID: 'PEER-DEVICE' }]);
      syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
      fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');

      monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
      await clock.tickAsync(100);

      const deletes = syncthingServiceMock.adjustConfigDevices.getCalls()
        .map((call) => call.args[0]).filter((options) => options.method === 'delete');
      expect(deletes, 'a peer of the very app waiting to be healed').to.deep.equal([]);
    });

    // A SAFETY ACTION IS NOT CONDITIONED ON A CALL THAT CAN FAIL. Which folders
    // syncthing holds sendreceive is read once a pass, at the top, where a
    // failure returns before anything is judged by it; the demotion reads that
    // off the entry. Asked again here, a failed read answers "no such folder",
    // which is indistinguishable from "nothing to protect" - so the demotion is
    // skipped, the container is not held, and the folder keeps broadcasting its
    // vanished disk state with nothing logged.
    it('demotes without asking syncthing a second time, so a failed read cannot skip the safety action', async () => {
      deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
      syncthingEventsConsumerMock.mountVerifyPendingIds.returns([syncFolderId]);
      syncthingFolderStateMachineMock.verifySendReceiveFolderSafety.resolves({ isSafe: false, isMounted: false, reason: 'unmounted_with_content' });
      volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: false, reason: 'volume_file_missing' });
      // the pass's own read succeeds; any second one does not
      syncthingServiceMock.getConfigFolders.rejects(new Error('the folder configuration is read once a pass'));
      syncthingServiceMock.getConfigFolders.onFirstCall().resolves([{ id: syncFolderId, type: 'sendreceive' }]);

      monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
      await clock.tickAsync(100);

      expect(syncthingServiceMock.getConfigFolders.callCount, 'the folder configuration is read once').to.equal(1);
      sinon.assert.calledWithExactly(syncthingServiceMock.adjustConfigFolders, { method: 'patch', config: { type: 'receiveonly' }, id: syncFolderId });
      sinon.assert.calledWith(appReconcilerMock.setControllerDesired, syncComp.identifier, 'stopped');
    });

    // A demoted folder re-enters the promotion machinery from the start: left
    // where it stood, a folder moments from promotion resumes there once the
    // mount returns, on a sync state established before the volume went away.
    it('restarts the promotion count when it demotes', async () => {
      deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
      mockState.receiveOnlySyncthingAppsCache.set(syncFolderId, { numberOfExecutions: 9 });
      syncthingEventsConsumerMock.mountVerifyPendingIds.returns([syncFolderId]);
      syncthingFolderStateMachineMock.verifySendReceiveFolderSafety.resolves({ isSafe: false, isMounted: false, reason: 'unmounted_with_content' });
      volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: false, reason: 'volume_file_missing' });
      syncthingServiceMock.getConfigFolders.resolves([{ id: syncFolderId, type: 'sendreceive' }]);

      monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
      await clock.tickAsync(100);

      const mark = mockState.receiveOnlySyncthingAppsCache.get(syncFolderId);
      expect(mark.numberOfExecutions, 'the count restarts').to.equal(0);
      expect(mark.mountSafetyBlocked, 'and says why it is parked').to.be.true;
      expect(mark.blockedReason).to.equal('unmounted_with_content');
      // written through appCaches, so the volume stamp cannot be forgotten here
      sinon.assert.calledWith(appCachesMock.setSyncedMark, mockState.receiveOnlySyncthingAppsCache, syncFolderId);
    });

    // The mark describes a DEMOTED folder, so a folder still sendreceive has
    // none.
    it('does not restart the promotion count when the demotion failed', async () => {
      deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
      mockState.receiveOnlySyncthingAppsCache.set(syncFolderId, { numberOfExecutions: 9 });
      syncthingEventsConsumerMock.mountVerifyPendingIds.returns([syncFolderId]);
      syncthingFolderStateMachineMock.verifySendReceiveFolderSafety.resolves({ isSafe: false, isMounted: false, reason: 'unmounted_with_content' });
      volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: false, reason: 'volume_file_missing' });
      syncthingServiceMock.getConfigFolders.resolves([{ id: syncFolderId, type: 'sendreceive' }]);
      syncthingServiceMock.adjustConfigFolders.rejects(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8384'), { code: 'ECONNREFUSED' }));

      monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
      await clock.tickAsync(100);

      sinon.assert.calledWithExactly(syncthingServiceMock.adjustConfigFolders, { method: 'patch', config: { type: 'receiveonly' }, id: syncFolderId });
      expect(mockState.receiveOnlySyncthingAppsCache.get(syncFolderId).numberOfExecutions, 'untouched').to.equal(9);
      sinon.assert.notCalled(appCachesMock.setSyncedMark);
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
      syncthingServiceMock.getConfigFolders.resolves([{ id: syncFolderId, type: 'receiveonly' }]);

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );
      await clock.tickAsync(100);

      sinon.assert.notCalled(syncthingEventsConsumerMock.resolveMountVerify);
    });

    // A flag nothing downstream can match is re-read every pass forever:
    // checkAppFolderMounts walks deployments, and no deployment carries this id.
    // The uninstall that removed the component already removed whatever the flag
    // protected.
    it('resolves a flagged folder no installed component carries', async () => {
      deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
      syncthingEventsConsumerMock.mountVerifyPendingIds.returns(['fluxweb_uninstalled']);
      syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
      fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');

      monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
      await clock.tickAsync(100);

      sinon.assert.calledWith(syncthingEventsConsumerMock.resolveMountVerify, 'fluxweb_uninstalled');
      // the installed component's own folder is not swept up with it
      sinon.assert.neverCalledWith(syncthingEventsConsumerMock.resolveMountVerify, syncFolderId);
    });

    // The guard on the resolution above, and the reason it needs one. An app
    // this node could not read carries nothing HERE, for a reason that says
    // nothing about the folder - resolving on that drops a live protection over
    // a mount nobody has checked.
    it('keeps a safety flag standing when its folder belongs to an app it cannot decrypt', async () => {
      deploymentProviderMock.listInstalledDeploymentsDetailed.resolves({
        deployments: [],
        unreadableAppNames: new Set(['sealed']),
      });
      syncthingEventsConsumerMock.mountVerifyPendingIds.returns(['fluxweb_sealed', 'fluxweb_gone']);
      syncthingServiceMock.getConfigFolders.resolves([]);
      syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
      fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');

      monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
      await clock.tickAsync(100);

      sinon.assert.neverCalledWith(syncthingEventsConsumerMock.resolveMountVerify, 'fluxweb_sealed');
      // the same pass resolved the one that is genuinely gone, so the assertion
      // above is about readability and not about the pass never getting here
      sinon.assert.calledWith(syncthingEventsConsumerMock.resolveMountVerify, 'fluxweb_gone');
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
      syncthingServiceMock.getConfigFolders.resolves([{ id: syncFolderId, type: 'receiveonly' }]);

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );
      await clock.tickAsync(100);

      sinon.assert.notCalled(syncthingServiceMock.adjustConfigFolders);
      sinon.assert.notCalled(appReconcilerMock.setControllerDesired);
    });

    // A COMPONENT THAT SYNCS, A MOUNT THAT IS UNSAFE, AND NO FOLDER: that is a
    // contradiction, not an answer, and it is the one case where "syncthing does
    // not hold it" must not read as "nothing to protect". Nothing is recreated
    // here - the level loop rebuilds the folder once the mount is healthy - but
    // the container is writing to a bad mount now.
    it('holds the container and keeps the flag when an owned folder is unknown to syncthing', async () => {
      deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
      syncthingEventsConsumerMock.mountVerifyPendingIds.returns([syncFolderId]);
      syncthingFolderStateMachineMock.verifyFolderMountSafety.resolves({ isSafe: false, isMounted: false, reason: 'unmounted_with_content' });
      volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: false, reason: 'volume_file_missing' });
      // syncthing holds a folder, just not this component's
      syncthingServiceMock.getConfigFolders.resolves([{ id: 'fluxweb_someotherapp', type: 'sendreceive' }]);

      monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
      await clock.tickAsync(100);

      sinon.assert.calledWith(appReconcilerMock.setControllerDesired, syncComp.identifier, 'stopped');
      // nothing to demote, and nothing is recreated from here
      sinon.assert.notCalled(syncthingServiceMock.adjustConfigFolders);
      // the mount question is unanswered, so the flag stands
      sinon.assert.notCalled(syncthingEventsConsumerMock.resolveMountVerify);
    });

    // The other side, and what keeps the assertion above from being about any
    // folderless component: one that declares no sync has no folder to be
    // missing, so its absence from syncthing says nothing at all.
    // Left standing, the flag is re-read every pass forever, pendingFolderIds
    // never empties, and the node sweeps every mount on every cycle - so
    // "does not sweep mounts in steady state" can never hold for it again.
    it('resolves the flag of a non-syncing component syncthing holds no folder for', async () => {
      const plainFolderId = `flux${plainDeployment.getComponent('web').identifier}`;
      deploymentProviderMock.listInstalledDeployments.resolves([plainDeployment]);
      syncthingEventsConsumerMock.mountVerifyPendingIds.returns([plainFolderId]);
      syncthingFolderStateMachineMock.verifyFolderMountSafety.resolves({ isSafe: false, isMounted: false, reason: 'unmounted_with_content' });
      volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: false, reason: 'volume_file_missing' });
      syncthingServiceMock.getConfigFolders.resolves([]);

      monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
      await clock.tickAsync(100);

      expect(plainDeployment.getComponent('web').hasSyncthing(), 'fixture must declare no sync').to.be.false;
      sinon.assert.calledWith(syncthingEventsConsumerMock.resolveMountVerify, plainFolderId);
    });

    // The other half, and without it the resolution above could be unconditional:
    // a component that DOES sync and whose folder syncthing has lost is a
    // contradiction, not an answer - its flag stands and its container is held.
    it('keeps the flag of a syncing component whose folder syncthing has lost', async () => {
      const syncFolderIdLocal = `flux${syncDeployment.getComponent('web').identifier}`;
      deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
      syncthingEventsConsumerMock.mountVerifyPendingIds.returns([syncFolderIdLocal]);
      syncthingFolderStateMachineMock.verifyFolderMountSafety.resolves({ isSafe: false, isMounted: false, reason: 'unmounted_with_content' });
      syncthingFolderStateMachineMock.verifySendReceiveFolderSafety.resolves({ isSafe: false, isMounted: false, reason: 'unmounted_with_content' });
      volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: false, reason: 'volume_file_missing' });
      syncthingServiceMock.getConfigFolders.resolves([]);

      monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
      await clock.tickAsync(100);

      sinon.assert.neverCalledWith(syncthingEventsConsumerMock.resolveMountVerify, syncFolderIdLocal);
      sinon.assert.calledWith(appReconcilerMock.setControllerDesired, sinon.match.any, 'stopped', sinon.match(/mount safety block/));
    });

    it('leaves a component that declares no sync alone when syncthing has no folder for it', async () => {
      const plainFolderId = `flux${plainDeployment.getComponent('web').identifier}`;
      deploymentProviderMock.listInstalledDeployments.resolves([plainDeployment]);
      syncthingEventsConsumerMock.mountVerifyPendingIds.returns([plainFolderId]);
      syncthingFolderStateMachineMock.verifyFolderMountSafety.resolves({ isSafe: false, isMounted: false, reason: 'unmounted_with_content' });
      volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: false, reason: 'volume_file_missing' });
      syncthingServiceMock.getConfigFolders.resolves([]);

      monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
      await clock.tickAsync(100);

      expect(plainDeployment.getComponent('web').hasSyncthing(), 'fixture must declare no sync').to.be.false;
      sinon.assert.notCalled(appReconcilerMock.setControllerDesired);
      sinon.assert.notCalled(syncthingServiceMock.adjustConfigFolders);
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
      syncthingServiceMock.getConfigFolders.resolves([{ id: syncFolderId, path: syncComp.dir, type: 'sendreceive' }]);
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
        syncthingServiceMock.adjustConfigFolders.calledWith({ method: 'delete', id: syncFolderId }),
        'an installed component owns its folder even when the pass skipped it',
      ).to.be.false;
    });

    it('removes a folder no installed component claims', async () => {
      // The counterpart: the same folder, owned by nothing, IS pruned. Without
      // this the retention test above would pass on a monitor that never deletes.
      syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
      fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');
      deploymentProviderMock.listInstalledDeployments.resolves([plainDeployment]);
      syncthingServiceMock.getConfigFolders.resolves([{ id: syncFolderId, path: syncComp.dir, type: 'sendreceive' }]);

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );
      await clock.tickAsync(100);

      // The plain component declares no sync, so it configures no folder at all...
      sinon.assert.notCalled(syncthingFolderStateMachineMock.manageFolderSyncState);
      sinon.assert.notCalled(syncthingMonitorHelpersMock.createSyncthingFolderConfig);
      // ...and the orphaned folder is removed.
      expect(syncthingServiceMock.adjustConfigFolders.calledWith({ method: 'delete', id: syncFolderId })).to.be.true;
    });

    it('keeps the folder of a component skipped for an unmounted volume', async () => {
      // A DIFFERENT TRIGGER from the state-machine deferral above: the volume is
      // not mounted, so ensureStfolderExists refuses and the pass returns before
      // the folder is configured. Ownership is what spares it, and ownership is
      // not "was reached this pass".
      syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
      fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');
      deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
      syncthingServiceMock.getConfigFolders.resolves([{ id: syncFolderId, path: syncComp.dir, type: 'sendreceive' }]);
      syncthingMonitorHelpersMock.ensureStfolderExists.resolves(false);

      monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
      await clock.tickAsync(100);

      expect(
        syncthingServiceMock.adjustConfigFolders.calledWith({ method: 'delete', id: syncFolderId }),
        'a live app folder was deleted because its volume was not mounted',
      ).to.be.false;
    });

    it('does not touch the ignore file of a folder whose volume is not mounted', async () => {
      // Writing ignores through syncthing for an unmounted folder writes them
      // to the bare host directory under the mountpoint, which is the same
      // class of harm the mount-safety block exists for.
      syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
      fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');
      deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
      syncthingServiceMock.getConfigFolders.resolves([{ id: syncFolderId, type: 'sendreceive', path: syncComp.dir }]);
      syncthingMonitorHelpersMock.ensureStfolderExists.resolves(false);

      monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
      await clock.tickAsync(100);

      sinon.assert.notCalled(syncthingMonitorHelpersMock.ensureStignoreCovers);
    });

    it('deletes the folder of an installed component that no longer syncs', async () => {
      // Ownership is hasSyncthing() on the CURRENT component, not "the app is
      // installed". A spec update that drops the sync block leaves a folder
      // replicating data nothing claims any more.
      syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
      fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');
      deploymentProviderMock.listInstalledDeployments.resolves([plainDeployment]);
      const staleFolderId = `flux${plainDeployment.getComponent('web').identifier}`;
      syncthingServiceMock.getConfigFolders.resolves([{ id: staleFolderId, path: plainDeployment.getComponent('web').dir, type: 'sendreceive' }]);

      monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
      await clock.tickAsync(100);

      expect(plainDeployment.getComponent('web').hasSyncthing(), 'fixture must declare no sync').to.be.false;
      expect(
        syncthingServiceMock.adjustConfigFolders.calledWith({ method: 'delete', id: staleFolderId }),
        'the component is installed but no longer syncs, so its folder is not owned',
      ).to.be.true;
    });

    it('keeps the folder of an app under backup, and of one under restore', async () => {
      // A backup removes the syncthing folder itself and holds an operation
      // lease while it works. The pass leaves the whole app alone rather than
      // re-adding what the backup just took away - and must not read "not
      // processed" as "not owned" and delete it.
      syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
      fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');
      deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
      syncthingServiceMock.getConfigFolders.resolves([{ id: syncFolderId, path: syncComp.dir, type: 'sendreceive' }]);
      operationRegistry.acquire(syncDeployment.appName, 'backup', 'test');

      monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
      await clock.tickAsync(100);

      sinon.assert.notCalled(syncthingFolderStateMachineMock.manageFolderSyncState);
      expect(
        syncthingServiceMock.adjustConfigFolders.calledWith({ method: 'delete', id: syncFolderId }),
        'the folder of an app mid-backup was swept',
      ).to.be.false;
    });

    it('leaves an unreadable app folder alone when its mount is healthy', async () => {
      // The other half of "still mount-checks the folder of an app it could not
      // read": the check runs, and a HEALTHY verdict means nothing is demoted
      // and no container is held. Without this the protection could be a block
      // that acts on every unreadable folder regardless of what it found.
      deploymentProviderMock.listInstalledDeploymentsDetailed.resolves({
        deployments: [],
        unreadableAppNames: new Set(['sealed']),
      });
      syncthingServiceMock.getConfigFolders.resolves([{ id: 'fluxweb_sealed', type: 'sendreceive' }]);
      syncthingFolderStateMachineMock.verifySendReceiveFolderSafety.resolves({ isSafe: true, isMounted: true, reason: 'ok' });

      monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
      await clock.tickAsync(100);

      sinon.assert.neverCalledWith(
        syncthingServiceMock.adjustConfigFolders,
        sinon.match({ method: 'patch', id: 'fluxweb_sealed' }),
      );
      sinon.assert.notCalled(appReconcilerMock.setControllerDesired);
    });

    it('hands the startup safety scan the real component injected excludes and app name', async () => {
      // First run walks syncthing's own folder list, so it starts from a folder id
      // and has to resolve the owning component itself. Both values it resolves
      // come off real objects and go to a stubbed collaborator.
      mockState.syncthingAppsFirstRun = true;
      syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
      fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');
      deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
      syncthingServiceMock.getConfigFolders.resolves([{ id: syncFolderId, path: syncComp.dir, type: 'sendreceive' }]);

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
      sinon.assert.neverCalledWith(syncthingServiceMock.adjustConfigFolders, { method: 'patch', config: { type: 'receiveonly' }, id: syncFolderId });
    });

    // syncthingService answers rows or throws. These state what a refusal
    // looks like from outside: reported, and never reported as applied.
    describe('a configuration write syncthing refused', () => {
      const refused = (message) => Object.assign(new Error(message), { code: 'ECONNREFUSED' });

      // A folder left sendreceive over a vanished mount keeps broadcasting its
      // missing disk state to healthy peers, so nothing may report it as
      // switched unless it was.
      it('says so when the mount-safety demotion could not be applied', async () => {
        deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
        syncthingEventsConsumerMock.mountVerifyPendingIds.returns([syncFolderId]);
        syncthingFolderStateMachineMock.verifySendReceiveFolderSafety.resolves({ isSafe: false, isMounted: false, reason: 'unmounted_with_content' });
        volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: false, reason: 'volume_file_missing' });
        syncthingServiceMock.getConfigFolders.resolves([{ id: syncFolderId, type: 'sendreceive' }]);
        syncthingServiceMock.adjustConfigFolders.rejects(refused('connect ECONNREFUSED 127.0.0.1:8384'));

        monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
        await clock.tickAsync(100);

        // the pass reached the demotion at all - without this the assertions
        // below are true of a pass that never got here
        sinon.assert.calledWithExactly(syncthingServiceMock.adjustConfigFolders, { method: 'patch', config: { type: 'receiveonly' }, id: syncFolderId });
        const errors = loggedErrors();
        expect(errors.some((line) => line.includes('FAILED') && line.includes(syncFolderId)), `the refusal is not reported: ${JSON.stringify(errors)}`).to.be.true;
        expect(errors.some((line) => line.includes('STILL sendreceive')), 'and the folder is reported as still broadcasting').to.be.true;
        expect(errors.some((line) => line.includes('switched to receiveonly')), 'nothing may claim the demotion landed').to.be.false;
      });

      // The flag is this node's memory that the folder's mount is in question.
      // A failed demotion is not an answer to it, so it stands and the next pass
      // comes back - and the container is held now either way, because the harm
      // is this node writing to a bad mount and a failed demotion does not make
      // that less likely.
      it('keeps the flag standing when the demotion fails, so the next pass retries', async () => {
        deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
        syncthingEventsConsumerMock.mountVerifyPendingIds.returns([syncFolderId]);
        syncthingFolderStateMachineMock.verifySendReceiveFolderSafety.resolves({ isSafe: false, isMounted: false, reason: 'unmounted_with_content' });
        volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: false, reason: 'volume_file_missing' });
        syncthingServiceMock.getConfigFolders.resolves([{ id: syncFolderId, type: 'sendreceive' }]);
        syncthingServiceMock.adjustConfigFolders.rejects(refused('connect ECONNREFUSED 127.0.0.1:8384'));

        monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
        await clock.tickAsync(100);

        sinon.assert.calledWithExactly(syncthingServiceMock.adjustConfigFolders, { method: 'patch', config: { type: 'receiveonly' }, id: syncFolderId });
        sinon.assert.notCalled(syncthingEventsConsumerMock.resolveMountVerify);
        sinon.assert.calledWith(appReconcilerMock.setControllerDesired, syncComp.identifier, 'stopped');
      });

      // Everything below the configuration write acts on what it applied: the
      // folder-error scan reads the folders just written, the restart check asks
      // whether they need one, and globalState.promotedFolderIds is published
      // from them - an ASSERTION about syncthing's state made without re-reading
      // it, and what a peer reads before promoting a folder of its own. A
      // refused write leaves all of it describing a configuration syncthing does
      // not hold, so the pass ends and the level loop reassembles next pass.
      it('ends the pass rather than acting on a configuration syncthing refused', async () => {
        // eslint-disable-next-line global-require
        const globalStateModule = require('../../ZelBack/src/services/utils/globalState');
        globalStateModule.promotedFolderIds = null;
        deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
        syncthingServiceMock.getConfigFolders.resolves([]);
        syncthingServiceMock.getConfigDevices.resolves([]);
        syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
        fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');
        // syncthing does not have this folder yet, so the pass has one to write
        syncthingMonitorHelpersMock.folderNeedsUpdate.returns(true);
        syncthingServiceMock.adjustConfigFolders.rejects(refused('connect ECONNREFUSED 127.0.0.1:8384'));

        monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
        await clock.tickAsync(100);

        sinon.assert.calledWith(syncthingServiceMock.adjustConfigFolders, sinon.match({ method: 'put' }));
        expect([...globalStateModule.promotedFolderIds], 'a refused write publishes nothing').to.deep.equal([]);
        // nothing below the write ran on a configuration that was not applied
        sinon.assert.notCalled(syncthingServiceMock.getFolderIdErrors);
        sinon.assert.notCalled(syncthingServiceMock.getConfigRestartRequired);
        expect(
          loggedErrors().some((line) => line.includes('Error in sync monitoring') && line.includes('ECONNREFUSED')),
          `the pass ended silently: ${JSON.stringify(loggedErrors())}`,
        ).to.be.true;
      });

      // The other half, which is what keeps the assertion above from being true
      // of a pass that simply never wrote anything.
      it('publishes it when the write lands', async () => {
        // eslint-disable-next-line global-require
        const globalStateModule = require('../../ZelBack/src/services/utils/globalState');
        globalStateModule.promotedFolderIds = null;
        deploymentProviderMock.listInstalledDeployments.resolves([syncDeployment]);
        syncthingServiceMock.getConfigFolders.resolves([]);
        syncthingServiceMock.getConfigDevices.resolves([]);
        syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
        fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');
        syncthingMonitorHelpersMock.folderNeedsUpdate.returns(true);

        monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
        await clock.tickAsync(100);

        sinon.assert.calledWith(syncthingServiceMock.adjustConfigFolders, sinon.match({ method: 'put' }));
        expect([...globalStateModule.promotedFolderIds]).to.deep.equal([syncFolderId]);
      });

      // The sweep logs "Removing unused Syncthing folder" before asking, so a
      // refusal that says nothing reads as a completed sweep.
      it('says so when an orphan sweep could not be applied', async () => {
        deploymentProviderMock.listInstalledDeployments.resolves([]);
        syncthingServiceMock.getConfigFolders.resolves([{ id: 'fluxweb_gone', type: 'receiveonly' }]);
        syncthingServiceMock.getConfigDevices.resolves([]);
        syncthingServiceMock.getDeviceId.resolves('DEVICE-ID');
        fluxNetworkHelperMock.getLocalSocketAddress.resolves('10.0.0.1:16127');
        syncthingServiceMock.adjustConfigFolders.rejects(refused('connect ECONNREFUSED 127.0.0.1:8384'));

        monitorControl = syncthingMonitor.syncthingApps(mockState, mockGetGlobalStateFn);
        await clock.tickAsync(100);

        sinon.assert.calledWithExactly(syncthingServiceMock.adjustConfigFolders, { method: 'delete', id: 'fluxweb_gone' });
        expect(loggedErrors().some((line) => line.includes('FAILED') && line.includes('fluxweb_gone')), `the refusal is not reported: ${JSON.stringify(loggedErrors())}`).to.be.true;
      });
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
