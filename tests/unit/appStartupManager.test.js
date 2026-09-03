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
      '../utils/appConstants': { localAppsInformation: 'localAppsInformation', NODE_DOWN_GRACE_MS: 420000, RUNNING_EXPIRY_MS: 7500000 },
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
        '../utils/appConstants': { localAppsInformation: 'localAppsInformation', NODE_DOWN_GRACE_MS: 420000, RUNNING_EXPIRY_MS: 7500000 },
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

      expect(globalStateStub.waitForDbReady.calledOnce).to.be.true;
      expect(appUninstallerStub.uninstallApplication.called).to.be.false;
    });

    it('should remove all apps when clean shutdown and downtime > the node-down grace', async () => {
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

    it('an unclean boot past the node-down grace removes every app before the sync: the network has moved on', async () => {
      const bootContext = {
        machineRebooted: true, downtimeMs: 500000, cleanShutdown: false,
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

