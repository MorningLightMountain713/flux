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
    };

    dockerServiceStub = {
      dockerListContainers: sinon.stub(),
    };

    fluxNetworkHelperStub = {
      getLocalSocketAddress: sinon.stub(),
    };

    appReconcilerStub = {
      enqueue: sinon.stub(),
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
      '../dbHelper': dbHelperStub,
      '../../lib/log': logStub,
    });

    appStartupManager = proxyquire('../../ZelBack/src/services/appLifecycle/appStartupManager', {
      '../../lib/log': logStub,
      '../dbHelper': dbHelperStub,
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

  describe('appHasValidLocationOnNode', () => {
    it('should return true when expireAt is in the future', async () => {
      const expireAt = new Date(Date.now() + (60 * 1000)); // 1 minute from now
      dbHelperStub.findInDatabase.resolves([{ expireAt }]);

      const result = await appUtilities.appHasValidLocationOnNode('myApp', '10.0.0.1:16127');

      expect(result).to.equal(true);
    });

    it('should return false when no location records exist', async () => {
      dbHelperStub.findInDatabase.resolves([]);

      const result = await appUtilities.appHasValidLocationOnNode('myApp', '10.0.0.1:16127');

      expect(result).to.equal(false);
    });

    it('should return false when records is null', async () => {
      dbHelperStub.findInDatabase.resolves(null);

      const result = await appUtilities.appHasValidLocationOnNode('myApp', '10.0.0.1:16127');

      expect(result).to.equal(false);
    });

    it('should return false when expireAt is in the past', async () => {
      const expireAt = new Date(Date.now() - (60 * 1000)); // 1 minute ago
      dbHelperStub.findInDatabase.resolves([{ expireAt }]);

      const result = await appUtilities.appHasValidLocationOnNode('myApp', '10.0.0.1:16127');

      expect(result).to.equal(false);
    });

    it('should return true if at least one record is still valid among mixed records', async () => {
      const expiredRecord = new Date(Date.now() - (60 * 1000));
      const validRecord = new Date(Date.now() + (300 * 1000));
      dbHelperStub.findInDatabase.resolves([
        { expireAt: expiredRecord },
        { expireAt: validRecord },
      ]);

      const result = await appUtilities.appHasValidLocationOnNode('myApp', '10.0.0.1:16127');

      expect(result).to.equal(true);
    });

    it('should return true on database error (fail-safe)', async () => {
      dbHelperStub.findInDatabase.rejects(new Error('DB connection lost'));

      const result = await appUtilities.appHasValidLocationOnNode('myApp', '10.0.0.1:16127');

      expect(result).to.equal(true);
    });

    it('should query with correct app name and IP', async () => {
      dbHelperStub.findInDatabase.resolves([]);

      await appUtilities.appHasValidLocationOnNode('testApp', '192.168.1.1:16127');

      const query = dbHelperStub.findInDatabase.firstCall.args[2];
      expect(query).to.deep.equal({ name: 'testApp', ip: '192.168.1.1:16127' });
    });

    it('should project only the expireAt field', async () => {
      dbHelperStub.findInDatabase.resolves([]);

      await appUtilities.appHasValidLocationOnNode('testApp', '10.0.0.1:16127');

      const projection = dbHelperStub.findInDatabase.firstCall.args[3];
      expect(projection).to.deep.equal({ _id: 0, expireAt: 1 });
    });

    it('should return false when expireAt field is missing from record', async () => {
      dbHelperStub.findInDatabase.resolves([{ broadcastedAt: new Date() }]);

      const result = await appUtilities.appHasValidLocationOnNode('myApp', '10.0.0.1:16127');

      expect(result).to.equal(false);
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
        '../dbHelper': dbHelperStub,
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
      const futureExpiry = new Date(Date.now() + (300 * 1000));
      dbHelperStub.findInDatabase.onFirstCall().resolves([{ expireAt: futureExpiry }]);

      const results = await appStartupManager.reconcileAppsOnBoot();

      expect(results.appsEnqueued).to.deep.equal(['AppA']);
      expect(results.appsRemoved).to.deep.equal([]);
      expect(appReconcilerStub.enqueue.calledWith('AppA')).to.equal(true);
    });

    it('should remove app when location record has expired', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Names: ['/fluxAppA'], State: 'exited' },
      ]);
      appsRepositoryStub.listInstalledAppNames.resolves(['AppA']);

      // Expired location record (expireAt in the past)
      const pastExpiry = new Date(Date.now() - (60 * 1000));
      dbHelperStub.findInDatabase.onFirstCall().resolves([{ expireAt: pastExpiry }]);

      const results = await appStartupManager.reconcileAppsOnBoot();

      expect(results.appsRemoved).to.deep.equal(['AppA']);
      expect(results.appsEnqueued).to.deep.equal([]);
      expect(appUninstallerStub.uninstallApplication.calledWith('AppA', { forceKill: true, skipGuard: true })).to.equal(true);
      expect(appReconcilerStub.enqueue.called).to.equal(false);
    });

    it('should remove app when location record is missing', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Names: ['/fluxAppA'], State: 'exited' },
      ]);
      appsRepositoryStub.listInstalledAppNames.resolves(['AppA']);

      // No location records
      dbHelperStub.findInDatabase.onFirstCall().resolves([]);

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

      // AppA has valid location (expireAt in the future)
      const futureExpiry = new Date(Date.now() + (300 * 1000));
      dbHelperStub.findInDatabase.onFirstCall().resolves([{ expireAt: futureExpiry }]);

      // AppB has expired location (expireAt in the past)
      const pastExpiry = new Date(Date.now() - (60 * 1000));
      dbHelperStub.findInDatabase.onSecondCall().resolves([{ expireAt: pastExpiry }]);

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
      dbHelperStub.findInDatabase.onFirstCall().resolves([]);

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
      dbHelperStub.findInDatabase.onFirstCall().rejects(new Error('DB error'));

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

      // SyncApp has a valid location, NormalApp's has expired
      const futureExpiry = new Date(Date.now() + (300 * 1000));
      dbHelperStub.findInDatabase.onFirstCall().resolves([{ expireAt: futureExpiry }]);
      dbHelperStub.findInDatabase.onSecondCall().resolves([]);

      const results = await appStartupManager.reconcileAppsOnBoot();

      expect(results.appsEnqueued).to.deep.equal(['SyncApp']);
      expect(results.appsRemoved).to.deep.equal(['NormalApp']);
      expect(appReconcilerStub.enqueue.calledOnceWith('SyncApp')).to.equal(true);
    });

    it('enqueues a multi-component app once, by app name (the reconciler expands components)', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Names: ['/fluxweb_MixedApp'], State: 'exited' },
        { Names: ['/fluxdb_MixedApp'], State: 'exited' },
      ]);
      appsRepositoryStub.listInstalledAppNames.resolves(['MixedApp']);

      // Valid location
      const futureExpiry = new Date(Date.now() + (300 * 1000));
      dbHelperStub.findInDatabase.onFirstCall().resolves([{ expireAt: futureExpiry }]);

      const results = await appStartupManager.reconcileAppsOnBoot();

      expect(results.appsEnqueued).to.deep.equal(['MixedApp']);
      expect(appReconcilerStub.enqueue.calledOnceWith('MixedApp')).to.equal(true);
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

