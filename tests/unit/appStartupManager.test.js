'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('appStartupManager tests', () => {
  let appStartupManager;
  let appUtilities;
  let logStub;
  let dbHelperStub;
  let appsRepositoryStub;
  let dockerServiceStub;
  let fluxNetworkHelperStub;
  let appReconcilerStub;
  let appUninstallerStub;
  let globalStateStub;
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
    };

    dockerServiceStub = {
      isManagedContainer: ({ labels, name }, labelKeys) => {
        if (labels && labels[labelKeys.IDENTIFIER]) return true;
        if (!name) return false;
        const bare = name.startsWith('/') ? name.slice(1) : name;
        return bare.startsWith('flux') || bare.startsWith('zel');
      },

      dockerListContainers: sinon.stub(),
    };

    fluxNetworkHelperStub = {
      getLocalSocketAddress: sinon.stub(),
    };

    appReconcilerStub = {
      enqueueApp: sinon.stub(),
    };

    appUninstallerStub = {
      uninstallApplication: sinon.stub().resolves(),
      removeUnrequiredDependencies: sinon.stub().resolves(),
    };

    const mockDb = { db: sinon.stub().returns('mockDatabase') };
    dbHelperStub.databaseConnection.returns(mockDb);

    globalStateStub = {
      dbReady: false,
      daemonReady: false,
      bootContainerStateSettled: false,
      waitForDbReady: sinon.stub().resolves(),
      waitForDaemonReady: sinon.stub().resolves(),
      waitForBootContainerStateSettled: sinon.stub().resolves(),
      appsMonitored: new Map(),
    };

    appQueryServiceStub = {
      installedApps: sinon.stub().resolves({ status: 'success', data: [] }),
    };

    appUtilities = proxyquire('../../ZelBack/src/services/utils/appUtilities', {
      '../appDatabase/appsRepository': appsRepositoryStub,
      '../../lib/log': logStub,
    });

    appStartupManager = proxyquire('../../ZelBack/src/services/appLifecycle/appStartupManager', {
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
      '../utils/appConstants': { localAppsInformation: 'localAppsInformation', SIGTERM_EXPIRY_MS: 420000, RUNNING_EXPIRY_MS: 7500000 },
      '../utils/appUtilities': appUtilities,
      '../nodeConfirmationService': {
        isConfirmed: sinon.stub().returns(true),
        waitForConfirmed: sinon.stub().resolves(),
        waitForConfirmationStatus: sinon.stub().resolves(),
      },
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  // The derivation only returns LIVE claims - an announcement past its TTL, a node
  // past its shutdown grace, and an evicted node are all excluded by the query - so a
  // row existing is the claim being valid. There is no expiry field to re-check.
  describe('appHasValidLocationOnNode', () => {
    it('is true when the network still holds a claim for this app here', async () => {
      appsRepositoryStub.appLocationFromEvents.resolves([{ name: 'myApp', ip: '10.0.0.1:16127' }]);

      expect(await appUtilities.appHasValidLocationOnNode('myApp', '10.0.0.1:16127')).to.equal(true);
    });

    it('is false when no claim remains', async () => {
      appsRepositoryStub.appLocationFromEvents.resolves([]);

      expect(await appUtilities.appHasValidLocationOnNode('myApp', '10.0.0.1:16127')).to.equal(false);
    });

    it('asks only about this app at this node address', async () => {
      appsRepositoryStub.appLocationFromEvents.resolves([]);

      await appUtilities.appHasValidLocationOnNode('testApp', '192.168.1.1:16127');

      expect(appsRepositoryStub.appLocationFromEvents.calledOnceWithExactly({
        appname: 'testApp', ip: '192.168.1.1:16127',
      })).to.equal(true);
    });

    // The caller UNINSTALLS on a false answer, so a read failure must never be the
    // reason an app is deleted.
    it('fails open when the lookup throws', async () => {
      appsRepositoryStub.appLocationFromEvents.rejects(new Error('DB connection lost'));

      expect(await appUtilities.appHasValidLocationOnNode('myApp', '10.0.0.1:16127')).to.equal(true);
    });
  });

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
      // eslint-disable-next-line global-require
      const realConfig = require('config');
      const flaggedStartupManager = proxyquire('../../ZelBack/src/services/appLifecycle/appStartupManager', {
        config: { ...realConfig, fluxapps: { ...realConfig.fluxapps, manageCollectorLifecycle: true } },
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
        '../utils/appConstants': { localAppsInformation: 'localAppsInformation', SIGTERM_EXPIRY_MS: 420000, RUNNING_EXPIRY_MS: 7500000 },
        '../utils/appUtilities': appUtilities,
        '../nodeConfirmationService': {
          isConfirmed: sinon.stub().returns(true),
          waitForConfirmed: sinon.stub().resolves(),
          waitForConfirmationStatus: sinon.stub().resolves(),
        },
      });

      await flaggedStartupManager.reconcileAppsOnBoot();
      expect(appUninstallerStub.removeUnrequiredDependencies.called).to.equal(true);
    });
  });

  describe('reconcileAppsOnBoot - location check and removal', () => {
    const stoppedFluxContainers = [
      { Names: ['/fluxAppA'], State: 'exited' },
      { Names: ['/fluxAppB'], State: 'exited' },
      { Names: ['/fluxAppC'], State: 'exited' },
    ];

    const installedApps = ['AppA', 'AppB', 'AppC'];

    beforeEach(() => {
      // Default: installed apps in local DB
      appsRepositoryStub.listInstalledAppNames.resolves(installedApps);

      // Default: stopped containers
      dockerServiceStub.dockerListContainers.resolves(stoppedFluxContainers);

      // Default: node IP available
      fluxNetworkHelperStub.getLocalSocketAddress.resolves('10.0.0.1:16127');
    });

    it('should start app when location record has not expired', async () => {
      // Only one stopped container
      dockerServiceStub.dockerListContainers.resolves([
        { Names: ['/fluxAppA'], State: 'exited' },
      ]);
      appsRepositoryStub.listInstalledAppNames.resolves(['AppA']);

      // Valid location record (expireAt in the future)
      // the network still claims this app here
      appsRepositoryStub.appLocationFromEvents.resolves([{ name: 'AppA' }]);

      const results = await appStartupManager.reconcileAppsOnBoot();

      expect(results.appsEnqueued).to.deep.equal(['AppA']);
      expect(results.appsRemoved).to.deep.equal([]);
      expect(appReconcilerStub.enqueueApp.calledWith('AppA')).to.equal(true);
    });

    it('should remove app when location record has expired', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Names: ['/fluxAppA'], State: 'exited' },
      ]);
      appsRepositoryStub.listInstalledAppNames.resolves(['AppA']);

      // the claim lapsed while the node was down - the derivation excludes it
      appsRepositoryStub.appLocationFromEvents.resolves([]);

      const results = await appStartupManager.reconcileAppsOnBoot();

      expect(results.appsRemoved).to.deep.equal(['AppA']);
      expect(results.appsEnqueued).to.deep.equal([]);
      expect(appUninstallerStub.uninstallApplication.calledWith('AppA', { forceKill: true, skipGuard: true })).to.equal(true);
      expect(appReconcilerStub.enqueueApp.called).to.equal(false);
    });

    it('should remove app when location record is missing', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Names: ['/fluxAppA'], State: 'exited' },
      ]);
      appsRepositoryStub.listInstalledAppNames.resolves(['AppA']);

      // No location records
      appsRepositoryStub.appLocationFromEvents.resolves([]);

      const results = await appStartupManager.reconcileAppsOnBoot();

      expect(results.appsRemoved).to.deep.equal(['AppA']);
      expect(results.appsEnqueued).to.deep.equal([]);
      expect(appUninstallerStub.uninstallApplication.called).to.equal(true);
    });

    it('should skip location check and start app when IP is not available', async () => {
      fluxNetworkHelperStub.getLocalSocketAddress.resolves(null);

      dockerServiceStub.dockerListContainers.resolves([
        { Names: ['/fluxAppA'], State: 'exited' },
      ]);
      appsRepositoryStub.listInstalledAppNames.resolves(['AppA']);

      const results = await appStartupManager.reconcileAppsOnBoot();

      expect(results.appsEnqueued).to.deep.equal(['AppA']);
      expect(results.appsRemoved).to.deep.equal([]);
    });

    it('should handle mixed apps: enqueue valid, remove expired', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Names: ['/fluxAppA'], State: 'exited' },
        { Names: ['/fluxAppB'], State: 'exited' },
      ]);
      appsRepositoryStub.listInstalledAppNames.resolves(['AppA', 'AppB']);

      // AppA is still claimed here; AppB's claim is gone (the derivation excludes it)
      appsRepositoryStub.appLocationFromEvents.callsFake(
        async ({ appname }) => (appname === 'AppA' ? [{ name: 'AppA' }] : []),
      );

      const results = await appStartupManager.reconcileAppsOnBoot();

      expect(results.appsEnqueued).to.deep.equal(['AppA']);
      expect(results.appsRemoved).to.deep.equal(['AppB']);
    });

    it('should record failure when removeAppLocally throws', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Names: ['/fluxAppA'], State: 'exited' },
      ]);
      appsRepositoryStub.listInstalledAppNames.resolves(['AppA']);

      // Expired location
      appsRepositoryStub.appLocationFromEvents.resolves([]);

      appUninstallerStub.uninstallApplication.rejects(new Error('Remove failed'));

      const results = await appStartupManager.reconcileAppsOnBoot();

      expect(results.appsRemoved).to.deep.equal([]);
      expect(results.appsFailed).to.have.lengthOf(1);
      expect(results.appsFailed[0].app).to.equal('AppA');
      expect(results.appsFailed[0].error).to.equal('Remove failed');
    });

    it('should still start app when location DB check errors (fail-safe)', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Names: ['/fluxAppA'], State: 'exited' },
      ]);
      appsRepositoryStub.listInstalledAppNames.resolves(['AppA']);

      // Location check throws error - appHasValidLocationOnNode returns true (fail-safe)
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

      // SyncApp is still claimed here, NormalApp is not
      appsRepositoryStub.appLocationFromEvents.callsFake(
        async ({ appname }) => (appname === 'SyncApp' ? [{ name: 'SyncApp' }] : []),
      );

      const results = await appStartupManager.reconcileAppsOnBoot();

      expect(results.appsEnqueued).to.deep.equal(['SyncApp']);
      expect(results.appsRemoved).to.deep.equal(['NormalApp']);
      expect(appReconcilerStub.enqueueApp.calledOnceWith('SyncApp')).to.equal(true);
    });

    it('enqueues a multi-component app once, by app name (the reconciler expands components)', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Names: ['/fluxweb_MixedApp'], State: 'exited' },
        { Names: ['/fluxdb_MixedApp'], State: 'exited' },
      ]);
      appsRepositoryStub.listInstalledAppNames.resolves(['MixedApp']);

      // Valid location
      // the network still claims this app here
      appsRepositoryStub.appLocationFromEvents.resolves([{ name: 'AppA' }]);

      const results = await appStartupManager.reconcileAppsOnBoot();

      expect(results.appsEnqueued).to.deep.equal(['MixedApp']);
      expect(appReconcilerStub.enqueueApp.calledOnceWith('MixedApp')).to.equal(true);
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

      expect(globalStateStub.waitForDbReady.calledOnce).to.be.true;
      expect(appUninstallerStub.uninstallApplication.called).to.be.false;
    });

    it('should remove all apps when clean shutdown and downtime > SIGTERM_EXPIRY', async () => {
      const bootContext = {
        machineRebooted: true, downtimeMs: 500000, cleanShutdown: true,
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

    it('should remove all apps when downtime > RUNNING_EXPIRY regardless of shutdown reason', async () => {
      const bootContext = {
        machineRebooted: true, downtimeMs: 8000000, cleanShutdown: false,
      };
      appQueryServiceStub.installedApps.resolves({
        status: 'success',
        data: [{ name: 'app1' }],
      });

      await appStartupManager.manageAppsOnBoot(bootContext);

      expect(appUninstallerStub.uninstallApplication.calledOnce).to.be.true;
      expect(logStub.info.calledWithMatch(/Locations expired/)).to.be.true;
    });

    it('should wait for dbReady then start apps when machine rebooted with valid locations', async () => {
      const bootContext = {
        machineRebooted: true, downtimeMs: 60000, cleanShutdown: false,
      };
      // No stopped containers = reconcileAppsOnBoot does nothing
      dockerServiceStub.dockerListContainers.resolves([]);
      dbHelperStub.findInDatabase.resolves([]);

      await appStartupManager.manageAppsOnBoot(bootContext);

      expect(globalStateStub.waitForDbReady.calledOnce).to.be.true;
      expect(logStub.info.calledWithMatch(/node confirmed, reconciling/)).to.be.true;
    });

    // The 5-minute sync timeout path cannot run in a unit test (SYNC_TIMEOUT_MS is a
    // module const); it is structurally identical to the locations-expired path
    // (calls removeAllApps) and is integration-tested on a live node. Pending, not a
    // hollow green test.
    it('should remove all apps on sync timeout');

    it('should not remove apps on clean shutdown with short downtime', async () => {
      const bootContext = {
        machineRebooted: true, downtimeMs: 120000, cleanShutdown: true,
      };
      dockerServiceStub.dockerListContainers.resolves([]);
      dbHelperStub.findInDatabase.resolves([]);

      await appStartupManager.manageAppsOnBoot(bootContext);

      expect(appUninstallerStub.uninstallApplication.called).to.be.false;
      expect(globalStateStub.waitForDbReady.calledOnce).to.be.true;
    });

    it('should not remove apps on first boot (no heartbeat history)', async () => {
      const bootContext = {
        machineRebooted: true, downtimeMs: Infinity, cleanShutdown: false, firstBoot: true,
      };
      dockerServiceStub.dockerListContainers.resolves([]);
      dbHelperStub.findInDatabase.resolves([]);

      await appStartupManager.manageAppsOnBoot(bootContext);

      expect(appUninstallerStub.uninstallApplication.called).to.be.false;
      expect(globalStateStub.waitForDbReady.calledOnce).to.be.true;
      expect(logStub.info.calledWithMatch(/First boot/)).to.be.true;
    });

    it('should set bootContainerStateSettled on every exit path', async () => {
      // FluxOS restart path (still reconciles, no stopped containers)
      globalStateStub.bootContainerStateSettled = false;
      dockerServiceStub.dockerListContainers.resolves([]);
      dbHelperStub.findInDatabase.resolves([]);
      await appStartupManager.manageAppsOnBoot({ machineRebooted: false, downtimeMs: 1000, cleanShutdown: true });
      expect(globalStateStub.bootContainerStateSettled).to.be.true;

      // Expired locations path
      globalStateStub.bootContainerStateSettled = false;
      appQueryServiceStub.installedApps.resolves({ status: 'success', data: [] });
      await appStartupManager.manageAppsOnBoot({
        machineRebooted: true, downtimeMs: 8000000, cleanShutdown: false,
      });
      expect(globalStateStub.bootContainerStateSettled).to.be.true;
    });
  });

});

