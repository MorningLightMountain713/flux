'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const { resetGlobalState } = require('./fixtures/globalState');
const proxyquire = require('proxyquire').noCallThru();
const capabilities = require('../../ZelBack/src/services/utils/capabilities');
const { asConfig } = require('./fixtures/config');
const realConfig = require('config');

describe('appStartupManager tests', () => {
  let appStartupManager;
  let appUtilities;
  let nodeDownStoreStub;
  let logStub;
  let dbHelperStub;
  let appsRepositoryStub;
  let dockerServiceStub;
  let fluxNetworkHelperStub;
  let appReconcilerStub;
  let appUninstallerStub;
  let globalStateStub;
  let whenUpStub;
  let appQueryServiceStub;

  beforeEach(() => {
    logStub = {
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
    };

    dbHelperStub = {
      databaseConnection: sinon.stub(),
      findInDatabase: sinon.stub(),
    };

    // The installed-apps read is names-only and goes through the repository, so
    // it no longer shares a findInDatabase call sequence with the location reads.
    appsRepositoryStub = {
      listInstalledAppNames: sinon.stub().resolves([]),
      appLocationFromEvents: sinon.stub().resolves([]),
      sweepOffListRows: sinon.stub().resolves(0),
    };

    dockerServiceStub = {
      isManagedContainer: ({ labels, name }, labelKeys) => {
        if (labels && labels[labelKeys.IDENTIFIER]) return true;
        if (!name) return false;
        const bare = name.startsWith('/') ? name.slice(1) : name;
        return bare.startsWith('flux') || bare.startsWith('zel');
      },

      dockerListContainers: sinon.stub(),
      getFluxDockerNetworkPhysicalInterfaceNames: sinon.stub().resolves(['br-0123456789ab']),
    };

    fluxNetworkHelperStub = {
      getLocalSocketAddress: sinon.stub(),
      removeDockerContainerAccessToNonRoutable: sinon.stub().resolves(true),
      purgeUFW: sinon.stub().resolves(),
    };

    appReconcilerStub = {
      enqueueApp: sinon.stub(),
    };

    appUninstallerStub = {
      uninstallApplication: sinon.stub().resolves(),
      removeUnrequiredDependencies: sinon.stub().resolves(),
    };

    nodeDownStoreStub = {
      lockoutForAddress: sinon.stub().resolves({ lockedOut: false, count: 0, liftsAt: null }),
    };

    const mockDb = { db: sinon.stub().returns('mockDatabase') };
    dbHelperStub.databaseConnection.returns(mockDb);

    // The real module, with the capability waits stubbed to resolve. The gates stay CLOSED -
    // this suite is about a startup that has not finished - and the waits are
    // stubbed to resolve so a test does not sit on a gate nothing here opens.
    // On the module itself those two are the same fact, which is why this has to
    // be sinon over the real object rather than an object asserting both.
    globalStateStub = resetGlobalState();
    whenUpStub = sinon.stub(capabilities, 'whenUp').resolves();
    // What the boot reconcile needs before its decision counts as up.
    capabilities.resetForTests();
    capabilities.setForTests(['mongoReachable', 'dockerReachable', 'daemonReachable', 'confirmationStatusKnown'], true);

    appQueryServiceStub = {
      installedApps: sinon.stub().resolves({ status: 'success', data: [] }),
    };

    appUtilities = proxyquire('../../ZelBack/src/services/utils/appUtilities', {
      '../appDatabase/appsRepository': appsRepositoryStub,
      '../../lib/log': logStub,
    });

    appStartupManager = proxyquire('../../ZelBack/src/services/appLifecycle/appStartupManager', {
      './crontabAndMountsCleanup': { cleanupCrontabAndMounts: sinon.stub().resolves() },
      './hardwareValidationService': { performBootTimeHardwareValidation: sinon.stub().resolves() },
      './containerMountRecovery': { performContainerMountRecovery: sinon.stub().resolves() },
      '../appSystem/fileOperationRecovery': { recoverInterruptedFileOperations: sinon.stub().resolves() },
      '../../lib/log': logStub,
      '../dockerService': dockerServiceStub,
      '../serviceHelper': { delay: sinon.stub().resolves() },
      '../fluxNetworkHelper': fluxNetworkHelperStub,
      '../nodeDosState': { isNodeDos: sinon.stub().returns(false) },
      '../appMonitoring/appReconciler': appReconcilerStub,
      '../appDatabase/appsRepository': appsRepositoryStub,
      './appUninstaller': appUninstallerStub,
      '../utils/globalState': globalStateStub,
      '../appQuery/appQueryService': appQueryServiceStub,
      '../utils/appConstants': { localAppsInformation: 'localAppsInformation', NODE_DOWN_GRACE_MS: 420_000, RUNNING_EXPIRY_MS: 7_500_000 },
      '../utils/appUtilities': appUtilities,
      '../appMessaging/nodeDownStore': nodeDownStoreStub,
      '../nodeConfirmationService': {
        isConfirmed: sinon.stub().returns(true),
      },
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  // The derivation only returns LIVE claims - an announcement past its TTL, a node
  // past its shutdown grace, and an address off the node list are all excluded by the query - so a
  // row existing is the claim being valid. There is no expiry field to re-check.
  describe('reconcileAppsOnBoot - boot orphan sweep (manageCollectorLifecycle)', () => {
    beforeEach(() => {
      // One installed app whose containers all auto-restarted (nothing stopped):
      // the sweep must still run on such a boot - an orphaned collector's
      // containers are typically running after a reboot.
      appsRepositoryStub.listInstalledAppNames.resolves(['AppX']);
      dockerServiceStub.dockerListContainers.resolves([]);
      fluxNetworkHelperStub.getLocalSocketAddress.resolves('10.0.0.1:16127');
    });

    it('flag off (default): boot does not run the orphan sweep', async () => {
      await appStartupManager.reconcileAppsOnBoot();
      expect(appUninstallerStub.removeUnrequiredDependencies.called).to.equal(false);
    });

    it('flag on: boot reaps orphaned followers after recovery', async () => {
      // Rebuild the module against a config whose lifecycle toggle is on.
      const flaggedStartupManager = proxyquire('../../ZelBack/src/services/appLifecycle/appStartupManager', {
        './crontabAndMountsCleanup': { cleanupCrontabAndMounts: sinon.stub().resolves() },
        './hardwareValidationService': { performBootTimeHardwareValidation: sinon.stub().resolves() },
        './containerMountRecovery': { performContainerMountRecovery: sinon.stub().resolves() },
        '../appSystem/fileOperationRecovery': { recoverInterruptedFileOperations: sinon.stub().resolves() },
        config: asConfig({ ...realConfig, fluxapps: { ...realConfig.fluxapps, manageCollectorLifecycle: true } }),
        '../../lib/log': logStub,
        '../dockerService': dockerServiceStub,
        '../serviceHelper': { delay: sinon.stub().resolves() },
        '../fluxNetworkHelper': fluxNetworkHelperStub,
        '../nodeDosState': { isNodeDos: sinon.stub().returns(false) },
        '../appMonitoring/appReconciler': appReconcilerStub,
        '../appDatabase/appsRepository': appsRepositoryStub,
        './appUninstaller': appUninstallerStub,
        '../utils/globalState': globalStateStub,
        '../appQuery/appQueryService': appQueryServiceStub,
        '../utils/appConstants': { localAppsInformation: 'localAppsInformation', NODE_DOWN_GRACE_MS: 420_000, RUNNING_EXPIRY_MS: 7_500_000 },
        '../utils/appUtilities': appUtilities,
        '../nodeConfirmationService': {
          isConfirmed: sinon.stub().returns(true),
        },
      });

      await flaggedStartupManager.reconcileAppsOnBoot();
      expect(appUninstallerStub.removeUnrequiredDependencies.called).to.equal(true);
    });
  });

  describe('reconcileAppsOnBoot - the node-level placement check (R5) and what starts', () => {
    const stoppedFluxContainers = [
      { Names: ['/fluxAppA'], State: 'exited' },
      { Names: ['/fluxAppB'], State: 'exited' },
      { Names: ['/fluxAppC'], State: 'exited' },
    ];
    const REMOVE = { forceKill: true, skipGuard: true, broadcastRemoval: false };

    beforeEach(() => {
      appsRepositoryStub.listInstalledAppNames.resolves(['AppA', 'AppB', 'AppC']);
      dockerServiceStub.dockerListContainers.resolves(stoppedFluxContainers);
      fluxNetworkHelperStub.getLocalSocketAddress.resolves('10.0.0.1:16127');
    });

    it('asks once about this node, never per app, and starts every stopped app while its rows still place it here', async () => {
      dockerServiceStub.dockerListContainers.resolves([{ Names: ['/fluxAppA'], State: 'exited' }]);
      appsRepositoryStub.listInstalledAppNames.resolves(['AppA']);
      appsRepositoryStub.appLocationFromEvents.resolves([{ name: 'AppA', ip: '10.0.0.1:16127' }]);

      const results = await appStartupManager.reconcileAppsOnBoot();

      expect(results.appsEnqueued).to.deep.equal(['AppA']);
      expect(results.appsRemoved).to.deep.equal([]);
      expect(appReconcilerStub.enqueueApp.calledWith('AppA')).to.equal(true);
      sinon.assert.calledOnceWithExactly(appsRepositoryStub.appLocationFromEvents, { ip: '10.0.0.1:16127' });
    });

    it('removes every installed app, whatever its containers are doing, when no row places this node any more - and broadcasts nothing', async () => {
      // AppA stopped, AppB running: there is no middle ground
      dockerServiceStub.dockerListContainers.resolves([{ Names: ['/fluxAppA'], State: 'exited' }]);
      appsRepositoryStub.listInstalledAppNames.resolves(['AppA', 'AppB']);
      appsRepositoryStub.appLocationFromEvents.resolves([]);

      const results = await appStartupManager.reconcileAppsOnBoot();

      expect(results.appsRemoved).to.deep.equal(['AppA', 'AppB']);
      expect(results.appsEnqueued).to.deep.equal([]);
      expect(appUninstallerStub.uninstallApplication.calledWith('AppA', REMOVE)).to.equal(true);
      expect(appUninstallerStub.uninstallApplication.calledWith('AppB', REMOVE)).to.equal(true);
      expect(appReconcilerStub.enqueueApp.called).to.equal(false);
    });

    it('a FluxOS restart whose node was replaced while it was away removes every app though nothing is stopped', async () => {
      dockerServiceStub.dockerListContainers.resolves([]);
      appsRepositoryStub.listInstalledAppNames.resolves(['AppA']);
      appsRepositoryStub.appLocationFromEvents.resolves([]);

      const results = await appStartupManager.reconcileAppsOnBoot();

      expect(results.appsRemoved).to.deep.equal(['AppA']);
      expect(appUninstallerStub.uninstallApplication.calledWith('AppA', REMOVE)).to.equal(true);
    });

    it('an app without a row of its own is kept while the node\'s rows stand: an install the drop cut off before its announcement', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Names: ['/fluxAppA'], State: 'exited' },
        { Names: ['/fluxAppB'], State: 'exited' },
      ]);
      appsRepositoryStub.listInstalledAppNames.resolves(['AppA', 'AppB']);
      appsRepositoryStub.appLocationFromEvents.resolves([{ name: 'AppA', ip: '10.0.0.1:16127' }]);

      const results = await appStartupManager.reconcileAppsOnBoot();

      expect(results.appsEnqueued).to.deep.equal(['AppA', 'AppB']);
      expect(results.appsRemoved).to.deep.equal([]);
    });

    it('resolves a v9 identity-named container through its app label, never the name', async () => {
      // A v9 container's name embeds the minted identity, not the app name —
      // only the io.runonflux.app label carries the name the installed row uses.
      dockerServiceStub.dockerListContainers.resolves([
        {
          Names: ['/fluxweb_26fbf41541f5'],
          State: 'exited',
          Labels: { 'io.runonflux.app': 'AppA', 'io.runonflux.identifier': 'web_26fbf41541f5' },
        },
      ]);
      appsRepositoryStub.listInstalledAppNames.resolves(['AppA']);
      appsRepositoryStub.appLocationFromEvents.resolves([{ name: 'AppA' }]);

      const results = await appStartupManager.reconcileAppsOnBoot();

      expect(results.appsSkippedNotInstalled).to.deep.equal([]);
      expect(results.appsEnqueued).to.deep.equal(['AppA']);
      expect(appReconcilerStub.enqueueApp.calledWith('AppA')).to.equal(true);
    });

    it('starts the stopped apps without asking when the node has no address to ask about', async () => {
      fluxNetworkHelperStub.getLocalSocketAddress.resolves(null);
      dockerServiceStub.dockerListContainers.resolves([{ Names: ['/fluxAppA'], State: 'exited' }]);
      appsRepositoryStub.listInstalledAppNames.resolves(['AppA']);

      const results = await appStartupManager.reconcileAppsOnBoot();

      expect(results.appsEnqueued).to.deep.equal(['AppA']);
      expect(results.appsRemoved).to.deep.equal([]);
      expect(appsRepositoryStub.appLocationFromEvents.called).to.equal(false);
    });

    it('records the failure and keeps removing when one uninstall throws', async () => {
      dockerServiceStub.dockerListContainers.resolves([{ Names: ['/fluxAppA'], State: 'exited' }]);
      appsRepositoryStub.listInstalledAppNames.resolves(['AppA', 'AppB']);
      appsRepositoryStub.appLocationFromEvents.resolves([]);
      appUninstallerStub.uninstallApplication.callsFake(async (name) => {
        if (name === 'AppA') throw new Error('Remove failed');
      });

      const results = await appStartupManager.reconcileAppsOnBoot();

      expect(results.appsRemoved).to.deep.equal(['AppB']);
      expect(results.appsFailed).to.deep.equal([{ app: 'AppA', error: 'Remove failed' }]);
      expect(results.appsEnqueued).to.deep.equal([]);
    });

    it('starts the stopped apps when the rows cannot be read: a database wobble never deletes an app', async () => {
      dockerServiceStub.dockerListContainers.resolves([{ Names: ['/fluxAppA'], State: 'exited' }]);
      appsRepositoryStub.listInstalledAppNames.resolves(['AppA']);
      appsRepositoryStub.appLocationFromEvents.rejects(new Error('DB error'));

      const results = await appStartupManager.reconcileAppsOnBoot();

      expect(results.appsEnqueued).to.deep.equal(['AppA']);
      expect(results.appsRemoved).to.deep.equal([]);
    });

    it('enqueues apps with replicated components like any other (gating lives in the reconciler)', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Names: ['/fluxSyncApp'], State: 'exited' },
        { Names: ['/fluxNormalApp'], State: 'exited' },
      ]);
      appsRepositoryStub.listInstalledAppNames.resolves(['SyncApp', 'NormalApp']);
      appsRepositoryStub.appLocationFromEvents.resolves([{ name: 'SyncApp' }, { name: 'NormalApp' }]);

      const results = await appStartupManager.reconcileAppsOnBoot();

      expect(results.appsEnqueued).to.deep.equal(['SyncApp', 'NormalApp']);
      expect(results.appsRemoved).to.deep.equal([]);
    });

    it('enqueues a multi-component app once, by app name (the reconciler expands components)', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Names: ['/fluxweb_MixedApp'], State: 'exited' },
        { Names: ['/fluxdb_MixedApp'], State: 'exited' },
      ]);
      appsRepositoryStub.listInstalledAppNames.resolves(['MixedApp']);
      appsRepositoryStub.appLocationFromEvents.resolves([{ name: 'MixedApp' }]);

      const results = await appStartupManager.reconcileAppsOnBoot();

      expect(results.appsEnqueued).to.deep.equal(['MixedApp']);
      expect(appReconcilerStub.enqueueApp.calledOnceWith('MixedApp')).to.equal(true);
    });
  });

  describe('reconcileAppsOnBoot - the placement the boot already decided', () => {
    it('uses the answer handed in and does not ask again', async () => {
      appsRepositoryStub.listInstalledAppNames.resolves(['AppA']);
      dockerServiceStub.dockerListContainers.resolves([]);

      const results = await appStartupManager.reconcileAppsOnBoot({ placement: { placed: true, removed: [], failed: [] } });

      expect(appsRepositoryStub.appLocationFromEvents.called, 'the rows are not read a second time').to.equal(false);
      expect(results.appsRemoved).to.deep.equal([]);
    });

    it('starts nothing when the boot decided the network has moved on', async () => {
      appsRepositoryStub.listInstalledAppNames.resolves(['AppA']);

      const results = await appStartupManager.reconcileAppsOnBoot({ placement: { placed: false, removed: ['AppA'], failed: [] } });

      expect(results.appsRemoved).to.deep.equal(['AppA']);
      expect(appReconcilerStub.enqueueApp.called, 'nothing is started').to.equal(false);
    });
  });

  // The module with the migrations stubbed, for the boot path between the sync
  // and the reconcile. bootSyncTimeoutMs bounds the registry wait and the state
  // pull together, in real milliseconds here.
  let specReconcilerStub;
  let hardwareStub;
  let storageStubs;

  function loadWithMigrations(runBefore, { bootSyncTimeoutMs } = {}) {
    specReconcilerStub = { convergeAtBoot: sinon.stub().resolves() };
    hardwareStub = { performBootTimeHardwareValidation: sinon.stub().resolves() };
    storageStubs = {
      mounts: { cleanupCrontabAndMounts: sinon.stub().resolves() },
      mountRecovery: { performContainerMountRecovery: sinon.stub().resolves() },
      fileOperations: { recoverInterruptedFileOperations: sinon.stub().resolves() },
    };
    return proxyquire('../../ZelBack/src/services/appLifecycle/appStartupManager', {
      ...(bootSyncTimeoutMs === undefined ? {} : {
        config: asConfig({ ...realConfig, system: { ...realConfig.system, bootSyncTimeoutMs } }),
      }),
      '../../lib/log': logStub,
      '../dockerService': dockerServiceStub,
      '../serviceHelper': { delay: sinon.stub().resolves() },
      '../fluxNetworkHelper': fluxNetworkHelperStub,
      '../nodeDosState': { isNodeDos: sinon.stub().returns(false) },
      '../appMonitoring/appReconciler': appReconcilerStub,
      '../appDatabase/appsRepository': appsRepositoryStub,
      './appUninstaller': appUninstallerStub,
      '../utils/globalState': globalStateStub,
      '../appQuery/appQueryService': appQueryServiceStub,
      '../utils/appConstants': { localAppsInformation: 'localAppsInformation', NODE_DOWN_GRACE_MS: 420_000, RUNNING_EXPIRY_MS: 7_500_000 },
      '../utils/appUtilities': appUtilities,
      '../appMessaging/nodeDownStore': nodeDownStoreStub,
      '../nodeConfirmationService': { isConfirmed: sinon.stub().returns(true) },
      '../migrations': { runBefore },
      './contentSlotService': { reconcileBootContent: sinon.stub().resolves() },
      './specReconciler': specReconcilerStub,
      './hardwareValidationService': hardwareStub,
      './crontabAndMountsCleanup': storageStubs.mounts,
      './containerMountRecovery': storageStubs.mountRecovery,
      '../appSystem/fileOperationRecovery': storageStubs.fileOperations,
    });
  }

  describe('manageAppsOnBoot - the boot reconcile decides by the rows when it holds the network\'s view, by the jurors\' clock when it does not', () => {
    const BY_ROWS = { forceKill: true, skipGuard: true, broadcastRemoval: false };
    const BY_CLOCK = { forceKill: true, broadcastRemoval: true };
    let clock;
    let bootStart;

    beforeEach(() => {
      bootStart = Date.now();
      clock = sinon.useFakeTimers({ now: bootStart, toFake: ['Date'] });
      fluxNetworkHelperStub.getLocalSocketAddress.resolves('10.0.0.1:16127');
      appsRepositoryStub.listInstalledAppNames.resolves(['AppA', 'AppB']);
      appsRepositoryStub.appLocationFromEvents.resolves([{ name: 'AppA', ip: '10.0.0.1:16127' }]);
      appQueryServiceStub.installedApps.resolves({ status: 'success', data: [{ name: 'AppA' }, { name: 'AppB' }] });
      dockerServiceStub.dockerListContainers.resolves([]);
    });

    afterEach(() => {
      clock.restore();
    });

    // The context read at process start: the stopped process stamped its drop
    // droppedAgoMs before this process started, and the downtime was read then.
    function contextDropped(droppedAgoMs) {
      return {
        machineRebooted: true, cleanShutdown: true, firstBoot: false, lastAlive: bootStart - droppedAgoMs, downtimeMs: droppedAgoMs,
      };
    }

    // The migrations take migrationsMs of the boot.
    function migrationsTaking(migrationsMs) {
      return sinon.stub().callsFake(async () => {
        clock.tick(migrationsMs);
        return [];
      });
    }

    // The state pull never completes: no peer answers.
    function statePullNeverCompletes() {
      whenUpStub.withArgs('appStateSynced').returns(new Promise(() => {}));
    }

    it('waits for the state pull, runs the migrations, then asks the rows', async () => {
      const runBefore = migrationsTaking(1000);
      const manager = loadWithMigrations(runBefore);

      await manager.manageAppsOnBoot(contextDropped(60_000));

      const pullWait = whenUpStub.withArgs('appStateSynced');
      expect(pullWait.calledOnce, 'the pull is waited for').to.equal(true);
      sinon.assert.calledOnceWithExactly(runBefore, 'bootReconcileDecided');
      expect(pullWait.calledBefore(appsRepositoryStub.appLocationFromEvents), 'the pull before the question').to.equal(true);
      expect(runBefore.calledBefore(appsRepositoryStub.appLocationFromEvents), 'the migrations before the question').to.equal(true);
      expect(appsRepositoryStub.appLocationFromEvents.calledOnce, 'asked once for the whole boot').to.equal(true);
      expect(dockerServiceStub.dockerListContainers.calledOnce, 'the reconcile ran').to.equal(true);
    });

    // An installed app the registry does not list must never start: the cleanup's
    // pass runs once the migrations have moved every app onto its identity, and
    // before the reconcile starts any container.
    it('asks the registry about every installed app after the migrations and before anything starts', async () => {
      const runBefore = migrationsTaking(1000);
      const manager = loadWithMigrations(runBefore);

      await manager.manageAppsOnBoot(contextDropped(60_000));

      sinon.assert.calledOnce(specReconcilerStub.convergeAtBoot);
      expect(runBefore.calledBefore(specReconcilerStub.convergeAtBoot), 'the migrations before the pass').to.equal(true);
      expect(specReconcilerStub.convergeAtBoot.calledBefore(dockerServiceStub.dockerListContainers), 'the pass before the reconcile').to.equal(true);
    });

    // The hardware sum counts only the apps the registry lets this node keep, and
    // an app it removes never starts.
    it('fits the kept apps to the hardware after the registry pass and before anything starts', async () => {
      const runBefore = migrationsTaking(1000);
      const manager = loadWithMigrations(runBefore);

      await manager.manageAppsOnBoot(contextDropped(60_000));

      const hardware = hardwareStub.performBootTimeHardwareValidation;
      sinon.assert.calledOnce(hardware);
      expect(specReconcilerStub.convergeAtBoot.calledBefore(hardware), 'the registry pass before the hardware sum').to.equal(true);
      expect(hardware.calledBefore(dockerServiceStub.dockerListContainers), 'the hardware sum before the reconcile').to.equal(true);
    });

    // The isolation chain is built over the networks the migrations and removals
    // left, and is in place before any container starts.
    it('builds the container firewall over the final networks before anything starts', async () => {
      const runBefore = migrationsTaking(1000);
      const manager = loadWithMigrations(runBefore);

      await manager.manageAppsOnBoot(contextDropped(60_000));

      const isolate = fluxNetworkHelperStub.removeDockerContainerAccessToNonRoutable;
      sinon.assert.calledOnceWithExactly(isolate, ['br-0123456789ab']);
      sinon.assert.calledOnce(fluxNetworkHelperStub.purgeUFW);
      expect(hardwareStub.performBootTimeHardwareValidation.calledBefore(dockerServiceStub.getFluxDockerNetworkPhysicalInterfaceNames), 'the removals before the networks are read').to.equal(true);
      expect(isolate.calledBefore(dockerServiceStub.dockerListContainers), 'the isolation before the reconcile').to.equal(true);
      expect(fluxNetworkHelperStub.purgeUFW.calledBefore(dockerServiceStub.dockerListContainers), 'the deny purge before the reconcile').to.equal(true);
    });

    it('a firewall step that fails is logged, and the deny purge and the apps still run', async () => {
      fluxNetworkHelperStub.removeDockerContainerAccessToNonRoutable.rejects(new Error('iptables gone'));
      const runBefore = migrationsTaking(1000);
      const manager = loadWithMigrations(runBefore);

      await manager.manageAppsOnBoot(contextDropped(60_000));

      sinon.assert.calledOnce(fluxNetworkHelperStub.purgeUFW);
      expect(dockerServiceStub.dockerListContainers.calledOnce, 'the reconcile ran').to.equal(true);
    });

    // Every installed app's storage is touched only under the names the migrations
    // left: volumes mounted, a container started before its mount restarted, an
    // interrupted file operation reclaimed from the mounted volume - in that order,
    // and before anything is asked of the registry or started.
    it('mounts and recovers installed app storage after the migrations and before the registry pass', async () => {
      const runBefore = migrationsTaking(1000);
      const manager = loadWithMigrations(runBefore);

      await manager.manageAppsOnBoot(contextDropped(60_000));

      const { mounts, mountRecovery, fileOperations } = storageStubs;
      sinon.assert.calledOnce(mounts.cleanupCrontabAndMounts);
      expect(runBefore.calledBefore(mounts.cleanupCrontabAndMounts), 'the migrations before the mounts').to.equal(true);
      expect(mounts.cleanupCrontabAndMounts.calledBefore(mountRecovery.performContainerMountRecovery)).to.equal(true);
      expect(mountRecovery.performContainerMountRecovery.calledBefore(fileOperations.recoverInterruptedFileOperations)).to.equal(true);
      expect(fileOperations.recoverInterruptedFileOperations.calledBefore(specReconcilerStub.convergeAtBoot), 'storage before the registry pass').to.equal(true);
    });

    it('the rows outrank the clock: a node long past the grace whose rows still place it starts its apps', async () => {
      const runBefore = migrationsTaking(200_000);
      const manager = loadWithMigrations(runBefore);

      await manager.manageAppsOnBoot(contextDropped(300_000));

      expect(appUninstallerStub.uninstallApplication.called).to.equal(false);
      expect(dockerServiceStub.dockerListContainers.calledOnce, 'the reconcile ran').to.equal(true);
    });

    it('no row places this node once the pull is in: every app removed after the migrations, no broadcast, nothing started', async () => {
      const runBefore = migrationsTaking(1000);
      const manager = loadWithMigrations(runBefore);
      appsRepositoryStub.appLocationFromEvents.resolves([]);

      await manager.manageAppsOnBoot(contextDropped(60_000));

      sinon.assert.calledOnce(runBefore);
      expect(appUninstallerStub.uninstallApplication.calledWith('AppA', BY_ROWS)).to.equal(true);
      expect(appUninstallerStub.uninstallApplication.calledWith('AppB', BY_ROWS)).to.equal(true);
      expect(dockerServiceStub.dockerListContainers.called, 'the reconcile never ran').to.equal(false);
    });

    it('no pull within the sync budget and past the grace since the drop: every app removed, each broadcast, nothing started, the rows never asked', async () => {
      statePullNeverCompletes();
      const runBefore = migrationsTaking(200_000);
      const manager = loadWithMigrations(runBefore, { bootSyncTimeoutMs: 50 });

      await manager.manageAppsOnBoot(contextDropped(300_000));

      sinon.assert.calledOnce(runBefore);
      expect(appUninstallerStub.uninstallApplication.calledWith('AppA', BY_CLOCK)).to.equal(true);
      expect(appUninstallerStub.uninstallApplication.calledWith('AppB', BY_CLOCK)).to.equal(true);
      expect(appsRepositoryStub.appLocationFromEvents.called, 'no rows to ask').to.equal(false);
      expect(dockerServiceStub.dockerListContainers.called, 'the reconcile never ran').to.equal(false);
    });

    it('no pull, inside the grace: the apps start and the rows are not asked', async () => {
      statePullNeverCompletes();
      const runBefore = migrationsTaking(100_000);
      const manager = loadWithMigrations(runBefore, { bootSyncTimeoutMs: 50 });

      await manager.manageAppsOnBoot(contextDropped(100_000));

      expect(appUninstallerStub.uninstallApplication.called).to.equal(false);
      expect(appsRepositoryStub.appLocationFromEvents.called).to.equal(false);
      expect(dockerServiceStub.dockerListContainers.calledOnce, 'the reconcile ran').to.equal(true);
    });

    it('no pull on a first boot: there is no drop to measure from, and the apps start however long the boot took', async () => {
      statePullNeverCompletes();
      const runBefore = migrationsTaking(500_000);
      const manager = loadWithMigrations(runBefore, { bootSyncTimeoutMs: 50 });

      await manager.manageAppsOnBoot({
        machineRebooted: true, downtimeMs: Infinity, cleanShutdown: false, firstBoot: true, lastAlive: null,
      });

      expect(appUninstallerStub.uninstallApplication.called).to.equal(false);
      expect(dockerServiceStub.dockerListContainers.calledOnce, 'the reconcile ran').to.equal(true);
    });
  });

  describe('enforceNodePlacement - the one question a returning node asks (R5)', () => {
    const REMOVE = { forceKill: true, skipGuard: true, broadcastRemoval: false };

    beforeEach(() => {
      fluxNetworkHelperStub.getLocalSocketAddress.resolves('10.0.0.1:16127');
    });

    it('nothing installed: nothing to decide, and the rows are not even read', async () => {
      appsRepositoryStub.listInstalledAppNames.resolves([]);
      expect(await appStartupManager.enforceNodePlacement('boot')).to.deep.equal({ placed: true, removed: [], failed: [] });
      expect(appsRepositoryStub.appLocationFromEvents.called).to.equal(false);
    });

    it('rows place this node: every app kept, the caller announces', async () => {
      appsRepositoryStub.listInstalledAppNames.resolves(['AppA', 'AppB']);
      appsRepositoryStub.appLocationFromEvents.resolves([{ name: 'AppA' }]);
      expect(await appStartupManager.enforceNodePlacement('return')).to.deep.equal({ placed: true, removed: [], failed: [] });
      expect(appUninstallerStub.uninstallApplication.called).to.equal(false);
    });

    it('no rows: every app removed, no broadcast, and the caller announces nothing', async () => {
      appsRepositoryStub.listInstalledAppNames.resolves(['AppA', 'AppB']);
      appsRepositoryStub.appLocationFromEvents.resolves([]);
      expect(await appStartupManager.enforceNodePlacement('certificate')).to.deep.equal({ placed: false, removed: ['AppA', 'AppB'], failed: [] });
      expect(appUninstallerStub.uninstallApplication.calledWith('AppA', REMOVE)).to.equal(true);
      expect(appUninstallerStub.uninstallApplication.calledWith('AppB', REMOVE)).to.equal(true);
    });

    it('a locked-out node removes every app though its rows still stand: the lockout\'s self-uninstall is this branch', async () => {
      appsRepositoryStub.listInstalledAppNames.resolves(['AppA']);
      appsRepositoryStub.appLocationFromEvents.resolves([{ name: 'AppA' }]);
      nodeDownStoreStub.lockoutForAddress.resolves({ lockedOut: true, count: 4, liftsAt: 1 });
      expect(await appStartupManager.enforceNodePlacement('certificate')).to.deep.equal({ placed: false, removed: ['AppA'], failed: [] });
      sinon.assert.calledOnceWithExactly(nodeDownStoreStub.lockoutForAddress, '10.0.0.1:16127');
      expect(appUninstallerStub.uninstallApplication.calledWith('AppA', REMOVE)).to.equal(true);
    });

    it('fails open: a lookup error or a missing address keeps every app', async () => {
      appsRepositoryStub.listInstalledAppNames.resolves(['AppA']);
      appsRepositoryStub.appLocationFromEvents.rejects(new Error('DB error'));
      expect(await appStartupManager.enforceNodePlacement('boot')).to.deep.equal({ placed: true, removed: [], failed: [] });
      fluxNetworkHelperStub.getLocalSocketAddress.resolves(null);
      appsRepositoryStub.appLocationFromEvents.resolves([]);
      expect(await appStartupManager.enforceNodePlacement('boot')).to.deep.equal({ placed: true, removed: [], failed: [] });
      expect(appUninstallerStub.uninstallApplication.called).to.equal(false);
    });
  });

  describe('manageAppsOnBoot', () => {
    it('should reconcile on FluxOS-only restart (no stopped containers)', async () => {
      const bootContext = {
        machineRebooted: false, downtimeMs: 1000, cleanShutdown: true,
      };
      dockerServiceStub.dockerListContainers.resolves([]);
      dbHelperStub.findInDatabase.resolves([]);

      await appStartupManager.manageAppsOnBoot(bootContext);

      expect(whenUpStub.withArgs('appRegistryConsistent').calledOnce).to.be.true;
      expect(appUninstallerStub.uninstallApplication.called).to.be.false;
    });

    it('should remove all apps when clean shutdown and downtime > the node-down grace', async () => {
      const bootContext = {
        machineRebooted: true, downtimeMs: 500_000, cleanShutdown: true,
      };
      appQueryServiceStub.installedApps.resolves({
        status: 'success',
        data: [{ name: 'app1' }, { name: 'app2' }],
      });

      await appStartupManager.manageAppsOnBoot(bootContext);

      expect(appUninstallerStub.uninstallApplication.calledTwice).to.be.true;
      expect(appUninstallerStub.uninstallApplication.firstCall.args[0]).to.equal('app1');
      expect(appUninstallerStub.uninstallApplication.secondCall.args[0]).to.equal('app2');
    });

    it('an unclean boot past the node-down grace removes every app before the sync: the network has moved on', async () => {
      const bootContext = {
        machineRebooted: true, downtimeMs: 500_000, cleanShutdown: false,
      };
      appQueryServiceStub.installedApps.resolves({
        status: 'success',
        data: [{ name: 'app1' }],
      });

      await appStartupManager.manageAppsOnBoot(bootContext);

      expect(appUninstallerStub.uninstallApplication.calledOnce).to.be.true;
      expect(logStub.info.calledWithMatch(/Locations expired/)).to.be.true;
    });

    it('sweeps the off-list register once the database is ready, and starts the apps even when the sweep fails', async () => {
      const bootContext = { machineRebooted: true, downtimeMs: 60_000, cleanShutdown: true };
      appsRepositoryStub.sweepOffListRows.rejects(new Error('distinct failed'));
      await appStartupManager.manageAppsOnBoot(bootContext);
      expect(whenUpStub.withArgs('appRegistryConsistent').calledOnce).to.be.true;
      expect(appsRepositoryStub.sweepOffListRows.calledOnce).to.be.true;
      expect(appsRepositoryStub.sweepOffListRows.calledAfter(whenUpStub.withArgs('appRegistryConsistent'))).to.be.true;
      expect(logStub.warn.calledWithMatch(/off-list boot sweep failed/)).to.be.true;
      expect(capabilities.isUp('bootReconcileDecided')).to.equal(true);
    });

    it('should wait for appRegistryConsistent then start apps when machine rebooted with valid locations', async () => {
      const bootContext = {
        machineRebooted: true, downtimeMs: 60_000, cleanShutdown: false,
      };
      // No stopped containers = reconcileAppsOnBoot does nothing
      dockerServiceStub.dockerListContainers.resolves([]);
      dbHelperStub.findInDatabase.resolves([]);

      await appStartupManager.manageAppsOnBoot(bootContext);

      expect(whenUpStub.withArgs('appRegistryConsistent').calledOnce).to.be.true;
      expect(logStub.info.calledWithMatch(/node confirmed, reconciling/)).to.be.true;
    });

    // The 5-minute sync timeout path is not covered here. SYNC_TIMEOUT_MS reads config.system.bootSyncTimeoutMs, so a
    // suite can lower it and drive this path; until then it is structurally identical
    // to the locations-expired path (calls removeAllApps) and is integration-tested on
    // a live node. Pending, not a hollow green test.
    it('should remove all apps on sync timeout');

    it('should not remove apps on clean shutdown with short downtime', async () => {
      const bootContext = {
        machineRebooted: true, downtimeMs: 120_000, cleanShutdown: true,
      };
      dockerServiceStub.dockerListContainers.resolves([]);
      dbHelperStub.findInDatabase.resolves([]);

      await appStartupManager.manageAppsOnBoot(bootContext);

      expect(appUninstallerStub.uninstallApplication.called).to.be.false;
      expect(whenUpStub.withArgs('appRegistryConsistent').calledOnce).to.be.true;
    });

    it('should not remove apps on first boot (no heartbeat history)', async () => {
      const bootContext = {
        machineRebooted: true, downtimeMs: Infinity, cleanShutdown: false, firstBoot: true,
      };
      dockerServiceStub.dockerListContainers.resolves([]);
      dbHelperStub.findInDatabase.resolves([]);

      await appStartupManager.manageAppsOnBoot(bootContext);

      expect(appUninstallerStub.uninstallApplication.called).to.be.false;
      expect(whenUpStub.withArgs('appRegistryConsistent').calledOnce).to.be.true;
      expect(logStub.info.calledWithMatch(/First boot/)).to.be.true;
    });

    it('should raise bootReconcileDecided on every exit path', async () => {
      // FluxOS restart path (still reconciles, no stopped containers)
      capabilities.setForTests('bootReconcileDecided', false);
      dockerServiceStub.dockerListContainers.resolves([]);
      dbHelperStub.findInDatabase.resolves([]);
      await appStartupManager.manageAppsOnBoot({ machineRebooted: false, downtimeMs: 1000, cleanShutdown: true });
      expect(capabilities.isUp('bootReconcileDecided')).to.be.true;

      // Expired locations path
      capabilities.setForTests('bootReconcileDecided', false);
      appQueryServiceStub.installedApps.resolves({ status: 'success', data: [] });
      await appStartupManager.manageAppsOnBoot({
        machineRebooted: true, downtimeMs: 8_000_000, cleanShutdown: false,
      });
      expect(capabilities.isUp('bootReconcileDecided')).to.be.true;
    });
  });

});

