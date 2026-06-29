const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');

// Tombstoning teardown: the removal prelude records a durable owed-teardown doc +
// condemns + deletes the local row, and the deferred worker (runTeardown) stops,
// removes, tears down the host state, and clears the record LAST. The order is
// load-bearing (see the adversarial-gate checklist).

describe('appUninstaller tombstoning teardown', () => {
  let appUninstaller;
  let stubs;

  // a fake DeploymentSpec component + deployment
  const makeComponent = (name) => ({
    identifier: `${name}_app`, name, appName: 'app', hostPorts: [8080], image: `${name}:latest`,
  });
  const makeDeployment = (componentNames) => {
    const comps = componentNames.map(makeComponent);
    return {
      componentEntries: () => comps.map((c) => [c.name, c]),
      getComponent: (n) => comps.find((c) => c.name === n) || null,
    };
  };

  beforeEach(() => {
    // The deferred worker's host teardown (umount, rm -rf) goes through
    // serviceHelper.runCommand; stub it so the tests neither spawn real sudo
    // subprocesses nor stall the timing-sensitive lease-release assertion.
    sinon.stub(serviceHelper, 'runCommand').resolves({ error: null, stdout: '', stderr: '' });
    const fakeCrontab = { jobs: () => [], remove: () => {}, save: () => {} };
    stubs = {
      log: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
      dockerService: {
        appDockerStop: sinon.stub().resolves(),
        appDockerKill: sinon.stub().resolves(),
        appDockerRemove: sinon.stub().resolves(),
        appDockerForceRemove: sinon.stub().resolves(),
        appDockerImageRemove: sinon.stub().resolves(),
        removeFluxAppDockerNetwork: sinon.stub().resolves(),
        forceRemoveFluxAppDockerNetwork: sinon.stub().resolves(),
        dockerListContainers: sinon.stub().resolves([]),
        getAppIdentifier: (id) => id,
        getBaseAppName: (id) => id,
      },
      appsRuntimeState: {
        setCondemned: sinon.stub().resolves(),
        remove: sinon.stub().resolves(true),
        getState: sinon.stub().resolves(null),
      },
      pendingTeardownStore: {
        writeTeardown: sinon.stub().resolves(),
        readAllTeardowns: sinon.stub().resolves([]),
        clearTeardown: sinon.stub().resolves(),
        prepareCollection: sinon.stub().resolves(),
        getTeardown: sinon.stub().resolves(null),
      },
      deploymentProvider: { getInstalledDeployment: sinon.stub().resolves(makeDeployment(['web'])) },
      appsRepository: {
        getInstalledApp: sinon.stub().resolves({ name: 'app', owner: 'owner1' }),
        getGlobalAppInfo: sinon.stub().resolves(null),
        getAppMessage: sinon.stub().resolves(null),
        existsInstalledApp: sinon.stub().resolves(false),
      },
      dbHelper: {
        databaseConnection: () => ({ db: () => ({}) }),
        findOneAndDeleteInDatabase: sinon.stub().resolves(),
        findInDatabase: sinon.stub().resolves([]),
        findOneInDatabase: sinon.stub().resolves(null),
        removeDocumentsFromCollection: sinon.stub().resolves(),
      },
      fluxNetworkHelper: {
        getLocalSocketAddress: sinon.stub().resolves('198.18.0.1:16127'),
        isFirewallActive: sinon.stub().resolves(false),
        deleteAllowPortRule: sinon.stub().resolves(),
      },
      upnpService: { isUPNP: sinon.stub().returns(false), removeMapUpnpPort: sinon.stub().resolves() },
      fluxCommunicationMessagesSender: { broadcastMessageToAll: sinon.stub().resolves() },
      appVolumeService: { removeSyncthingFolder: sinon.stub().resolves() },
      appSwapPoolService: { reconcile: sinon.stub().resolves() },
      telemetrySinkCache: { deleteSink: sinon.stub(), hasAnyTelemetryApps: sinon.stub().returns(false) },
      telemetryConfigService: { remove: sinon.stub().resolves() },
      fluxShutdowndClient: { deleteAppPlanBestEffort: sinon.stub().resolves() },
      appInspector: { stopAppMonitoring: sinon.stub() },
      operationRegistry: {
        isHeld: sinon.stub().returns(false), acquire: sinon.stub().returns('tok'), release: sinon.stub(),
      },
      globalState: {
        runningAppsCache: new Map(), receiveOnlySyncthingAppsCache: new Map(), abortInstall: sinon.stub().returns(false),
      },
      fluxEventBus: { publish: sinon.stub() },
    };

    appUninstaller = proxyquire('../../ZelBack/src/services/appLifecycle/appUninstaller', {
      config: {
        database: {
          appslocal: { database: 'localapps', collections: { appsInformation: 'zelappsinformation', pendingAppTeardowns: 'zelappspendingteardowns' } },
          appsglobal: { database: 'globalapps', collections: { appsInformation: 'zelappsinformation', appsMessages: 'zelappsmessages' } },
        },
      },
      crontab: { load: (cb) => cb(null, fakeCrontab) },
      '../../lib/log': stubs.log,
      '../dockerService': stubs.dockerService,
      '../dbHelper': stubs.dbHelper,
      '../utils/globalState': stubs.globalState,
      '../upnpService': stubs.upnpService,
      '../fluxNetworkHelper': stubs.fluxNetworkHelper,
      '../fluxCommunicationMessagesSender': stubs.fluxCommunicationMessagesSender,
      '../appDatabase/appsRepository': stubs.appsRepository,
      '../appRuntime/deploymentProvider': stubs.deploymentProvider,
      './appVolumeService': stubs.appVolumeService,
      './appSwapPoolService': stubs.appSwapPoolService,
      '../appManagement/appInspector': stubs.appInspector,
      '../appManagement/appsRuntimeState': stubs.appsRuntimeState,
      './pendingTeardownStore': stubs.pendingTeardownStore,
      '../telemetrySinkCache': stubs.telemetrySinkCache,
      '../telemetryConfigService': stubs.telemetryConfigService,
      '../utils/fluxShutdowndClient': stubs.fluxShutdowndClient,
      '../utils/operationRegistry': stubs.operationRegistry,
      '../utils/fluxEventBus': stubs.fluxEventBus,
      '../utils/appConstants': { localAppsInformation: 'zelappsinformation', globalAppsMessages: 'zelappsmessages', appsFolder: '/tmp/flux/ZelApps/' },
    });
  });

  afterEach(() => sinon.restore());

  describe('runTeardown (the deferred worker)', () => {
    const doc = () => ({
      key: 'app',
      name: 'app',
      networkName: 'app',
      forceKill: false,
      owner: 'owner1',
      components: [{
        identifier: 'web_app', appId: 'web_app', componentName: 'web', label: 'app', ports: [8080], image: 'web:latest',
      }],
    });

    it('stops, then removes, then drops runtime state LAST, then clears the durable record', async () => {
      const { appDockerStop, appDockerRemove } = stubs.dockerService;
      await appUninstaller.runTeardown(doc());
      expect(appDockerStop.calledOnce, 'graceful stop').to.be.true;
      expect(stubs.dockerService.appDockerKill.called, 'no kill on a graceful teardown').to.be.false;
      expect(appDockerRemove.calledOnce, 'container removed').to.be.true;
      expect(stubs.appsRuntimeState.remove.calledOnce, 'runtime state dropped').to.be.true;
      expect(stubs.pendingTeardownStore.clearTeardown.calledOnce, 'durable record cleared').to.be.true;
      // ORDER (load-bearing): stop -> remove -> drop runtime state (condemned) -> clear record
      expect(appDockerStop.calledBefore(appDockerRemove)).to.be.true;
      expect(appDockerRemove.calledBefore(stubs.appsRuntimeState.remove)).to.be.true;
      expect(stubs.appsRuntimeState.remove.calledBefore(stubs.pendingTeardownStore.clearTeardown)).to.be.true;
    });

    it('removes the whole-app docker network', async () => {
      await appUninstaller.runTeardown(doc());
      expect(stubs.dockerService.removeFluxAppDockerNetwork.calledOnceWith('app')).to.be.true;
    });

    it('does NOT clear the durable record if a condemned stamp failed to drop (boot recovery re-drives)', async () => {
      stubs.appsRuntimeState.remove.resolves(false);
      await appUninstaller.runTeardown(doc());
      expect(stubs.pendingTeardownStore.clearTeardown.called).to.be.false;
    });

    it('force teardown kills + force-removes the container and force-removes the network', async () => {
      const forced = { ...doc(), forceKill: true };
      await appUninstaller.runTeardown(forced);
      expect(stubs.dockerService.appDockerKill.calledOnce).to.be.true;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
      expect(stubs.dockerService.appDockerForceRemove.calledOnce).to.be.true;
      expect(stubs.dockerService.forceRemoveFluxAppDockerNetwork.calledOnce).to.be.true;
    });
  });

  describe('uninstallApplication (the removal prelude)', () => {
    it('records the owed-teardown doc BEFORE deleting the local row, condemns, and awaits teardown (foreground)', async () => {
      const res = await appUninstaller.uninstallApplication('app', { broadcastRemoval: true });
      expect(res.status).to.equal(appUninstaller.UninstallStatus.REMOVED);
      expect(stubs.pendingTeardownStore.writeTeardown.calledOnce, 'doc written').to.be.true;
      expect(stubs.appsRuntimeState.setCondemned.calledWith('web_app', true), 'component condemned').to.be.true;
      expect(stubs.dbHelper.findOneAndDeleteInDatabase.calledOnce, 'local row deleted').to.be.true;
      // ORDER (load-bearing): durable doc persisted BEFORE the row is deleted
      expect(stubs.pendingTeardownStore.writeTeardown.calledBefore(stubs.dbHelper.findOneAndDeleteInDatabase)).to.be.true;
      // foreground (background:false default) actually runs the destructive teardown
      expect(stubs.dockerService.appDockerRemove.called).to.be.true;
      // the prelude aborts any in-flight install of the same app (cancel-vs-install)
      expect(stubs.globalState.abortInstall.calledWith('app'), 'in-flight install aborted').to.be.true;
    });

    it('fails CLOSED: a doc-persist failure aborts the removal WITHOUT deleting the local row', async () => {
      stubs.pendingTeardownStore.writeTeardown.rejects(new Error('db down'));
      const res = await appUninstaller.uninstallApplication('app', { broadcastRemoval: true });
      expect(res.status).to.equal(appUninstaller.UninstallStatus.FAILED);
      expect(stubs.dbHelper.findOneAndDeleteInDatabase.called, 'row must NOT be deleted with no durable record').to.be.false;
      expect(stubs.dockerService.appDockerRemove.called, 'nothing torn down').to.be.false;
    });

    it('broadcasts fluxappremoved fire-and-forget (never blocks the prelude on the broadcast)', async () => {
      let resolveBroadcast;
      stubs.fluxCommunicationMessagesSender.broadcastMessageToAll.returns(new Promise((r) => { resolveBroadcast = r; }));
      // foreground teardown still completes even though the broadcast promise never resolves
      const res = await appUninstaller.uninstallApplication('app', { broadcastRemoval: true });
      expect(res.status).to.equal(appUninstaller.UninstallStatus.REMOVED);
      expect(stubs.fluxCommunicationMessagesSender.broadcastMessageToAll.calledOnce).to.be.true;
      if (resolveBroadcast) resolveBroadcast();
    });

    it('background removal holds the remove lease until the deferred teardown finishes', async () => {
      const res = await appUninstaller.uninstallApplication('app', { broadcastRemoval: true, background: true });
      expect(res.status).to.equal(appUninstaller.UninstallStatus.REMOVED); // returns fast, before the teardown destroys anything
      // let the detached teardown chain run
      await new Promise((r) => { setImmediate(r); });
      await new Promise((r) => { setImmediate(r); });
      expect(stubs.dockerService.appDockerRemove.called, 'the deferred worker ran').to.be.true;
      // the detached chain (NOT the finally's null no-op) released the real lease token,
      // so the lease was held through the destructive teardown — deferring a same-name install
      expect(stubs.operationRegistry.release.calledWith('app', 'tok'), 'lease released by the chain').to.be.true;
    });
  });

  describe('recoverOwedTeardowns (boot recovery)', () => {
    const owedDoc = {
      key: 'app', name: 'app', networkName: 'app', forceKill: false, owner: 'o', components: [{ identifier: 'web_app', appId: 'web_app', label: 'app', ports: [], image: null }],
    };

    it('re-condemns owed components then drives their teardown', async () => {
      stubs.pendingTeardownStore.readAllTeardowns.resolves([owedDoc]);
      stubs.appsRepository.existsInstalledApp.resolves(false);
      await appUninstaller.recoverOwedTeardowns();
      expect(stubs.appsRuntimeState.setCondemned.calledWith('web_app', true)).to.be.true;
      // teardown is fire-and-forget; let the microtask run
      await new Promise((r) => { setImmediate(r); });
      expect(stubs.dockerService.appDockerStop.called).to.be.true;
    });

    it('un-condemns + drops the record without teardown when the app is re-installed (row is back)', async () => {
      stubs.pendingTeardownStore.readAllTeardowns.resolves([owedDoc]);
      stubs.appsRepository.existsInstalledApp.resolves(true); // re-installed
      await appUninstaller.recoverOwedTeardowns();
      expect(stubs.appsRuntimeState.setCondemned.calledWith('web_app', false), 'un-condemned').to.be.true;
      expect(stubs.pendingTeardownStore.clearTeardown.calledOnceWith('app')).to.be.true;
      await new Promise((r) => { setImmediate(r); });
      expect(stubs.dockerService.appDockerRemove.called, 'never tear down a re-installed app').to.be.false;
    });

    it('defers (no teardown, keeps the record) when the install-row read fails transiently', async () => {
      stubs.pendingTeardownStore.readAllTeardowns.resolves([owedDoc]);
      stubs.appsRepository.existsInstalledApp.rejects(new Error('db blip'));
      await appUninstaller.recoverOwedTeardowns();
      expect(stubs.appsRuntimeState.setCondemned.calledWith('web_app', true), 'must not condemn on a guess').to.be.false;
      expect(stubs.pendingTeardownStore.clearTeardown.called, 'record kept for next boot').to.be.false;
      await new Promise((r) => { setImmediate(r); });
      expect(stubs.dockerService.appDockerRemove.called).to.be.false;
    });
  });
});
