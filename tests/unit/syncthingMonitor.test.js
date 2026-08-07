// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
// Real registry singleton - un-stubbed in proxyquire, so the module under test
// and the test share it.
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');

// Create mocks for all dependencies

const serviceHelperMock = {
  delay: sinon.stub().resolves(),
};

const dockerServiceMock = {
  getAppIdentifier: sinon.stub((id) => id),
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
  getConfigRestartRequired: sinon.stub(),
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
};

const syncthingMonitorHelpersMock = {
  sortAndFilterLocations: sinon.stub((locs) => locs),
  buildDeviceConfiguration: sinon.stub().resolves([]),
  createSyncthingFolderConfig: sinon.stub((id, label, path, devices, type) => ({
    id,
    label,
    path,
    devices,
    type: type || 'sendreceive',
  })),
  ensureStfolderExists: sinon.stub().resolves(),
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
};

const syncthingEventsConsumerMock = {
  start: sinon.stub(),
  stop: sinon.stub().resolves(),
  isRunning: sinon.stub().returns(false),
  getFolderErrors: sinon.stub(),
  drainErroredFolderIds: sinon.stub().returns([]),
};

const volumeServiceMock = {
  ensureAppVolumeMounted: sinon.stub().resolves({ mounted: true, alreadyMounted: true }),
};

const appReconcilerMock = {
  setControllerDesired: sinon.stub(),
};

// Load module with mocked dependencies
const syncthingMonitor = proxyquire('../../ZelBack/src/services/appMonitoring/syncthingMonitor', {
  '../serviceHelper': serviceHelperMock,
  '../dockerService': dockerServiceMock,
  '../fluxNetworkHelper': fluxNetworkHelperMock,
  '../syncthingService': syncthingServiceMock,
  '../appRuntime/deploymentProvider': deploymentProviderMock,
  './appReconciler': appReconcilerMock,
  './syncthingFolderStateMachine': syncthingFolderStateMachineMock,
  './syncthingMonitorHelpers': syncthingMonitorHelpersMock,
  './syncthingHealthMonitor': syncthingHealthMonitorMock,
  './syncthingEventsConsumer': syncthingEventsConsumerMock,
  '../utils/volumeService': volumeServiceMock,
});

describe('syncthingMonitor tests', () => {
  let mockState;
  let mockGetGlobalStateFn;
  let monitorControl;
  let clock;

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
    syncthingServiceMock.getDeviceId.reset();
    syncthingServiceMock.getConfigFolders.reset();
    syncthingServiceMock.getConfigDevices.reset();
    syncthingServiceMock.adjustConfigDevices.reset();
    syncthingServiceMock.adjustConfigFolders.reset();
    syncthingServiceMock.getFolderIdErrors.reset();
    syncthingServiceMock.getConfigRestartRequired.reset();
    syncthingServiceMock.systemRestart.reset();
    fluxNetworkHelperMock.getLocalSocketAddress.reset();
    dockerServiceMock.dockerContainerInspect.reset();
    dockerServiceMock.appDockerStart.reset();
    syncthingHealthMonitorMock.monitorFolderHealth.reset();
    syncthingEventsConsumerMock.start.reset();
    syncthingEventsConsumerMock.stop.reset();
    syncthingEventsConsumerMock.stop.resolves();
    syncthingEventsConsumerMock.drainErroredFolderIds.reset();
    syncthingEventsConsumerMock.drainErroredFolderIds.returns([]);
    volumeServiceMock.ensureAppVolumeMounted.reset();
    volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: true, alreadyMounted: true });
    syncthingFolderStateMachineMock.verifyFolderMountSafety.reset();
    syncthingFolderStateMachineMock.verifyFolderMountSafety.resolves({ isSafe: true, isMounted: true, fileCount: 1 });
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
      operationRegistry.acquire('SomeApp', 'install', 'test');

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );

      // Wait for first execution to complete
      await clock.tickAsync(100);

      sinon.assert.notCalled(deploymentProviderMock.listInstalledDeployments);
      expect(mockState.updateSyncthingRunning).to.be.false;
    });

    it('runs the cycle during a backup (backup is per-app, never a whole-cycle freeze)', async () => {
      operationRegistry.acquire('SomeApp', 'backup', 'test');

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );

      // Wait for first execution to complete
      await clock.tickAsync(100);

      sinon.assert.called(deploymentProviderMock.listInstalledDeployments);
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
        data: [{ id: 'fluxcomp_testapp', path: '/apps/fluxcomp_testapp', type: 'sendreceive' }],
      });
      syncthingServiceMock.adjustConfigFolders.resolves(); // beforeEach reset() wipes behavior; restore it
      syncthingFolderStateMachineMock.verifyFolderMountSafety.resolves({ isSafe: false, reason: 'not mounted' });
      // getAppIdentifier is an identity stub here, so the component identifier is
      // already the docker-style folder id.
      deploymentProviderMock.listInstalledDeployments.resolves([{
        appName: 'testapp',
        componentEntries: () => [['comp', { identifier: 'fluxcomp_testapp' }]],
      }]);

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );
      await clock.tickAsync(10000);

      sinon.assert.calledWithExactly(syncthingServiceMock.adjustConfigFolders, 'patch', { type: 'receiveonly' }, 'fluxcomp_testapp');
      sinon.assert.notCalled(syncthingServiceMock.systemRestart);
    });

    it('demotes a sendreceive folder over an unrepairable mount while skipping the cycle', async () => {
      // repair fails (backing image gone) so the whole cycle is skipped, but a
      // folder left sendreceive over the bad mount could still broadcast its disk
      // state - it must be demoted and its container held before bailing.
      deploymentProviderMock.listInstalledDeployments.resolves([{
        appName: 'testapp',
        componentEntries: () => [['comp', { identifier: 'testapp' }]],
      }]);
      syncthingEventsConsumerMock.drainErroredFolderIds.returns(['testapp']);
      syncthingFolderStateMachineMock.verifyFolderMountSafety.resolves({ isSafe: false, isMounted: false, reason: 'unmounted_with_content' });
      volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: false, reason: 'volume_file_missing' });
      syncthingServiceMock.getConfigFolders.resolves({ data: [{ id: 'testapp', type: 'sendreceive' }] });
      syncthingServiceMock.adjustConfigFolders.resolves(); // beforeEach reset() wipes behavior; restore it

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );
      await clock.tickAsync(100);

      sinon.assert.calledWithExactly(syncthingServiceMock.adjustConfigFolders, 'patch', { type: 'receiveonly' }, 'testapp');
      sinon.assert.calledWith(appReconcilerMock.setControllerDesired, 'testapp', 'stopped');
      // the cycle itself was skipped - per-app processing never ran
      sinon.assert.notCalled(syncthingServiceMock.getDeviceId);
    });

    it('does not re-patch an unsafe folder that is already receiveonly', async () => {
      deploymentProviderMock.listInstalledDeployments.resolves([{
        appName: 'testapp',
        componentEntries: () => [['comp', { identifier: 'testapp' }]],
      }]);
      syncthingEventsConsumerMock.drainErroredFolderIds.returns(['testapp']);
      syncthingFolderStateMachineMock.verifyFolderMountSafety.resolves({ isSafe: false, isMounted: false, reason: 'empty_unmounted_directory' });
      volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: false, reason: 'volume_file_missing' });
      syncthingServiceMock.getConfigFolders.resolves({ data: [{ id: 'testapp', type: 'receiveonly' }] });

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
      deploymentProviderMock.listInstalledDeployments.resolves([{
        appName: 'testapp',
        componentEntries: () => [['comp', { identifier: 'testapp', hasSyncthing: () => false }]],
      }]);
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
      mockState.receiveOnlySyncthingAppsCache.set('fluxcomp_app1', { numberOfExecutions: 3 });

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );
      await clock.tickAsync(100); // initial run completes
      const runsAfterStart = deploymentProviderMock.listInstalledDeployments.callCount;

      const handlers = syncthingEventsConsumerMock.start.firstCall.args[0];
      handlers.onFolderActivity('fluxcomp_app1', 'FolderSummary');
      handlers.onFolderActivity('fluxcomp_app1', 'StateChanged'); // coalesces

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
      mockState.receiveOnlySyncthingAppsCache.set('fluxcomp_done', { restarted: true });

      monitorControl = syncthingMonitor.syncthingApps(
        mockState,
        mockGetGlobalStateFn,
      );
      await clock.tickAsync(100); // initial run completes
      const runsAfterStart = deploymentProviderMock.listInstalledDeployments.callCount;

      const handlers = syncthingEventsConsumerMock.start.firstCall.args[0];
      handlers.onFolderActivity('fluxcomp_untracked', 'FolderSummary');
      handlers.onFolderActivity('fluxcomp_done', 'FolderSummary');
      handlers.onFolderActivity('fluxcomp_done', 'StateChanged');

      await clock.tickAsync(15000); // well past debounce and min gap

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
      handlers.onFolderActivity('fluxcomp_untracked', 'FolderErrors');

      await clock.tickAsync(11000); // past the min gap from the last completed pass

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
      await clock.tickAsync(30000);

      // First execution still not complete - should skip second call
      expect(deploymentProviderMock.listInstalledDeployments.callCount).to.equal(1);

      // Complete first execution
      resolveFirst([]);
      // Give time for all async operations in the promise chain to complete
      await clock.tickAsync(100);

      // Now advance to next interval - should execute again
      await clock.tickAsync(30000);
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
      await clock.tickAsync(30000);
      await clock.tickAsync(100);

      expect(deploymentProviderMock.listInstalledDeployments.callCount).to.be.greaterThan(firstCallCount);
    });
  });
});
