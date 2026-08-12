'use strict';

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
        // container gone after a successful remove: the teardown reclaims host storage
        getDockerContainer: sinon.stub().resolves(null),
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
        bumpAttempts: sinon.stub().resolves(),
      },
      deploymentProvider: {
        getInstalledDeployment: sinon.stub().resolves(makeDeployment(['web'])),
        buildDeployment: sinon.stub().resolves(makeDeployment(['web'])),
        localIdentities: sinon.stub().resolves([null]),
      },
      appsRepository: {
        getInstalledApp: sinon.stub().resolves({ name: 'app', owner: 'owner1' }),
        getGlobalAppInfo: sinon.stub().resolves(null),
        getAppMessage: sinon.stub().resolves(null),
        existsInstalledApp: sinon.stub().resolves(false),
        // Rows are identity-keyed: the removal drops THIS identity's row, then
        // the remaining count decides whether the app has left the node.
        existsInstalledIdentity: sinon.stub().resolves(false),
        removeInstalledIdentity: sinon.stub().resolves(),
        countInstalledIdentities: sinon.stub().resolves(0),
        removeInstalledApp: sinon.stub().resolves(),
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
      appVolumeService: {},
      syncthingMonitorHelpers: { removeSyncthingFolder: sinon.stub().resolves() },
      volumeService: { getVolumeFilePath: sinon.stub().resolves(null) },
      appSwapPoolService: { reconcile: sinon.stub().resolves() },
      telemetrySinkCache: { deleteSink: sinon.stub(), hasAnyTelemetryApps: sinon.stub().returns(false) },
      telemetryConfigService: { remove: sinon.stub().resolves() },
      fluxShutdowndClient: {
        beginAppStop: sinon.stub().resolves({ outcome: 'not_arcane' }),
        forceAppStop: sinon.stub().resolves({ outcome: 'forced' }),
        deleteAppPlanBestEffort: sinon.stub().resolves(),
        SHUTDOWN_REASON: {
          TTL_EXPIRED: 'ttl-expired', USER_CANCEL: 'user-cancel', REDEPLOY: 'redeploy', EVICTION: 'eviction', MANUAL: 'manual',
        },
      },
      appInspector: { stopAppMonitoring: sinon.stub() },
      operationRegistry: {
        isHeld: sinon.stub().returns(false), get: sinon.stub().returns(null), acquire: sinon.stub().returns('tok'), release: sinon.stub(),
      },
      globalState: {
        runningAppsCache: new Map(), receiveOnlySyncthingAppsCache: new Map(), abortInstall: sinon.stub().returns(false),
      },
      fluxEventBus: { publish: sinon.stub() },
      reconcilerQueue: { enqueueComponent: sinon.stub() },
    };

    appUninstaller = proxyquire('../../ZelBack/src/services/appLifecycle/appUninstaller', {
      config: {
        fluxapps: { manageCollectorLifecycle: false },
        database: {
          appslocal: { database: 'localapps', collections: { appsInformation: 'zelappsinformation', pendingAppTeardowns: 'zelappspendingteardowns' } },
          appsglobal: { database: 'globalapps', collections: { appsInformation: 'zelappsinformation', appsMessages: 'zelappsmessages' } },
        },
      },
      crontab: { load: (cb) => cb(null, fakeCrontab) },
      '../../lib/log': stubs.log,
      '../dockerService': stubs.dockerService,
      '../utils/globalState': stubs.globalState,
      '../upnpService': stubs.upnpService,
      '../fluxNetworkHelper': stubs.fluxNetworkHelper,
      '../fluxCommunicationMessagesSender': stubs.fluxCommunicationMessagesSender,
      '../appDatabase/appsRepository': stubs.appsRepository,
      '../appRuntime/deploymentProvider': stubs.deploymentProvider,
      '../appMonitoring/syncthingMonitorHelpers': stubs.syncthingMonitorHelpers,
      '../utils/volumeService': stubs.volumeService,
      './appSwapPoolService': stubs.appSwapPoolService,
      '../appManagement/appInspector': stubs.appInspector,
      '../appManagement/appsRuntimeState': stubs.appsRuntimeState,
      './pendingTeardownStore': stubs.pendingTeardownStore,
      '../telemetrySinkCache': stubs.telemetrySinkCache,
      '../telemetryConfigService': stubs.telemetryConfigService,
      '../utils/fluxShutdowndClient': stubs.fluxShutdowndClient,
      '../utils/operationRegistry': stubs.operationRegistry,
      '../appMonitoring/reconcilerQueue': stubs.reconcilerQueue,
      '../utils/fluxEventBus': stubs.fluxEventBus,
    });
  });

  afterEach(() => sinon.restore());

  describe('runTeardown (the deferred worker)', () => {
    const doc = () => ({
      key: 'app',
      name: 'app',
      networkName: 'fluxDockerNetwork_app',
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

    it('removes the whole-app docker network (force-disconnecting any endpoints first)', async () => {
      await appUninstaller.runTeardown(doc());
      // Even a graceful teardown force-removes: any endpoints left are foreign linked
      // consumers, and a plain removal would leak the network on "active endpoints".
      // the record carries the resolved network name; removal takes it as the option,
      // so a teardown that outlives the row still takes the right network with it
      expect(stubs.dockerService.forceRemoveFluxAppDockerNetwork.calledOnceWith(
        null, { networkName: 'fluxDockerNetwork_app' },
      )).to.be.true;
      expect(stubs.dockerService.removeFluxAppDockerNetwork.called).to.be.false;
    });

    it('does NOT clear the durable record if a condemned stamp failed to drop (boot recovery re-drives)', async () => {
      stubs.appsRuntimeState.remove.resolves(false);
      await appUninstaller.runTeardown(doc());
      expect(stubs.pendingTeardownStore.clearTeardown.called).to.be.false;
    });

    it('never reclaims host storage (nor clears the record) while the container survives the remove', async () => {
      // A concurrent re-create (or a failed remove) leaves the container present. Destroying
      // its volume now would corrupt a live container, so the teardown must skip the
      // destructive cleanup and stay owed for retry.
      stubs.dockerService.getDockerContainer.resolves({ id: 'still-running' });
      await appUninstaller.runTeardown(doc());
      expect(stubs.dockerService.appDockerRemove.calledOnce, 'remove attempted').to.be.true;
      const umountCalled = serviceHelper.runCommand.getCalls().some((c) => c.args[0] === 'umount');
      expect(umountCalled, 'volume NOT unmounted under a live container').to.be.false;
      expect(stubs.pendingTeardownStore.clearTeardown.called, 'record kept owed for retry').to.be.false;
    });

    it('force teardown kills + force-removes the container and force-removes the network', async () => {
      const forced = { ...doc(), forceKill: true };
      await appUninstaller.runTeardown(forced);
      expect(stubs.dockerService.appDockerKill.calledOnce).to.be.true;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
      expect(stubs.dockerService.appDockerForceRemove.calledOnce).to.be.true;
      expect(stubs.dockerService.forceRemoveFluxAppDockerNetwork.calledOnce).to.be.true;
    });

    // Defect 1: a teardown must not tear a container down while a reconcile start holds the
    // component 'removing' key. It WAITS (bounded) for the start to settle — the acquire
    // succeeding is the signal — then removes, rather than deferring to boot recovery.
    it('waits for an in-flight start (removing key busy) to settle, then removes', async () => {
      stubs.operationRegistry.acquire.onFirstCall().returns(null).onSecondCall().returns('tok');
      await appUninstaller.runTeardown(doc());
      expect(stubs.operationRegistry.acquire.callCount, 'polled the removing lease until the start cleared').to.be.at.least(2);
      expect(stubs.dockerService.appDockerRemove.calledOnce, 'removed once the lease cleared').to.be.true;
      expect(stubs.pendingTeardownStore.clearTeardown.calledOnce, 'teardown completed, not owed').to.be.true;
    });

    // A start that completed in the gap before we took the lease leaves the container
    // running; holding 'removing' now, we escalate to a force remove (its graceful window
    // already elapsed) rather than 409-looping to boot recovery — and the teardown completes.
    it('force-escalates and completes when a start left the container running', async () => {
      stubs.dockerService.getDockerContainer.onFirstCall().resolves({ id: 'running-from-gap' }).onSecondCall().resolves(null);
      await appUninstaller.runTeardown(doc());
      expect(stubs.dockerService.appDockerRemove.calledOnce, 'non-force remove attempted first').to.be.true;
      expect(stubs.dockerService.appDockerForceRemove.calledOnce, 'escalated to a force remove').to.be.true;
      expect(stubs.dockerService.appDockerRemove.calledBefore(stubs.dockerService.appDockerForceRemove)).to.be.true;
      expect(stubs.appsRuntimeState.remove.called, 'runtime state dropped — component fully torn down').to.be.true;
      expect(stubs.pendingTeardownStore.clearTeardown.calledOnce, 'record cleared, not owed').to.be.true;
    });

    // A component whose container cannot be removed (even the force escalation fails) must
    // keep its condemned stamp: dropping it would un-condemn a live container and let the
    // reconciler keep it running until boot recovery. So the teardown must NOT drop its
    // runtime state, and must stay owed.
    it('keeps a surviving component condemned (does not drop its runtime state) and owed', async () => {
      stubs.dockerService.getDockerContainer.resolves({ id: 'stuck' }); // never gone, even after force
      await appUninstaller.runTeardown(doc());
      expect(stubs.dockerService.appDockerForceRemove.called, 'escalation attempted').to.be.true;
      expect(stubs.appsRuntimeState.remove.called, 'must NOT drop runtime state — that would un-condemn a live container').to.be.false;
      expect(stubs.pendingTeardownStore.clearTeardown.called, 'kept owed for boot recovery').to.be.false;
      // and it hands the still-owed teardown to the reconciler to converge (retry with
      // backoff), rather than abandoning it until the next boot.
      expect(stubs.reconcilerQueue.enqueueComponent.calledWith('web_app'), 'enqueued the survivor for the reconciler to re-drive').to.be.true;
    });
  });

  describe('uninstallApplication (the removal prelude)', () => {
    it('records the owed-teardown doc BEFORE deleting the local row, condemns, and awaits teardown (foreground)', async () => {
      const res = await appUninstaller.uninstallApplication('app', { broadcastRemoval: true });
      expect(res.status).to.equal(appUninstaller.UninstallStatus.REMOVED);
      expect(stubs.pendingTeardownStore.writeTeardown.calledOnce, 'doc written').to.be.true;
      expect(stubs.appsRuntimeState.setCondemned.calledWith('web_app', true), 'component condemned').to.be.true;
      expect(stubs.appsRepository.removeInstalledApp.calledOnce, 'local row deleted').to.be.true;
      // ORDER (load-bearing): durable doc persisted BEFORE the row is deleted
      expect(stubs.pendingTeardownStore.writeTeardown.calledBefore(stubs.appsRepository.removeInstalledApp)).to.be.true;
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
      // await the real-token release itself rather than counting scheduler ticks —
      // the detached chain's internal step count is not this test's contract
      // resolve on the app-level release specifically — runTeardown also releases
      // per-component 'removing' leases carrying the same stubbed token
      const released = new Promise((resolve) => {
        stubs.operationRegistry.release.callsFake((name, token) => { if (name === 'app' && token === 'tok') resolve(); });
      });
      const res = await appUninstaller.uninstallApplication('app', { broadcastRemoval: true, background: true });
      expect(res.status).to.equal(appUninstaller.UninstallStatus.REMOVED); // returns fast, before the teardown destroys anything
      await released;
      expect(stubs.dockerService.appDockerRemove.called, 'the deferred worker ran').to.be.true;
      // the detached chain (NOT the finally's null no-op) released the real lease token,
      // so the lease was held through the destructive teardown — deferring a same-name install
      expect(stubs.operationRegistry.release.calledWith('app', 'tok'), 'lease released by the chain').to.be.true;
    });
  });

  describe('recoverOwedTeardowns (boot recovery)', () => {
    const owedDoc = {
      key: 'app', name: 'app', networkName: 'fluxDockerNetwork_app', forceKill: false, owner: 'o', components: [{ identifier: 'web_app', appId: 'web_app', label: 'app', ports: [], image: null }],
    };

    it('re-condemns owed components then hands them to the reconciler to converge (not a one-shot boot drive)', async () => {
      stubs.pendingTeardownStore.readAllTeardowns.resolves([owedDoc]);
      stubs.appsRepository.existsInstalledIdentity.resolves(false);
      await appUninstaller.recoverOwedTeardowns();
      expect(stubs.appsRuntimeState.setCondemned.calledWith('web_app', true)).to.be.true;
      // Boot recovery no longer drives the teardown directly (a partial would be abandoned
      // until the NEXT boot); it enqueues the components so the reconciler converges them.
      expect(stubs.reconcilerQueue.enqueueComponent.calledWith('web_app'), 'enqueued for the reconciler to drive').to.be.true;
      await new Promise((r) => { setImmediate(r); });
      expect(stubs.dockerService.appDockerStop.called, 'no direct boot-time teardown drive').to.be.false;
    });

    it('un-condemns + drops the record without teardown when the app is re-installed (row is back)', async () => {
      stubs.pendingTeardownStore.readAllTeardowns.resolves([owedDoc]);
      stubs.appsRepository.existsInstalledIdentity.resolves(true); // re-installed
      await appUninstaller.recoverOwedTeardowns();
      expect(stubs.appsRuntimeState.setCondemned.calledWith('web_app', false), 'un-condemned').to.be.true;
      expect(stubs.pendingTeardownStore.clearTeardown.calledOnceWith('app')).to.be.true;
      await new Promise((r) => { setImmediate(r); });
      expect(stubs.dockerService.appDockerRemove.called, 'never tear down a re-installed app').to.be.false;
    });

    it('defers (no teardown, keeps the record) when the install-row read fails transiently', async () => {
      stubs.pendingTeardownStore.readAllTeardowns.resolves([owedDoc]);
      stubs.appsRepository.existsInstalledIdentity.rejects(new Error('db blip'));
      await appUninstaller.recoverOwedTeardowns();
      expect(stubs.appsRuntimeState.setCondemned.calledWith('web_app', true), 'must not condemn on a guess').to.be.false;
      expect(stubs.pendingTeardownStore.clearTeardown.called, 'record kept for next boot').to.be.false;
      await new Promise((r) => { setImmediate(r); });
      expect(stubs.dockerService.appDockerRemove.called).to.be.false;
    });
  });

  describe('driveOwedTeardown (the reconciler converge-to-gone actuator)', () => {
    const owedDoc = () => ({
      key: 'app', name: 'app', networkName: 'fluxDockerNetwork_app', forceKill: false, owner: 'o', attempts: 0, components: [{ identifier: 'web_app', appId: 'web_app', label: 'app', ports: [], image: null }],
    });

    it('returns none when nothing is owed (the component is genuinely uninstalled)', async () => {
      stubs.pendingTeardownStore.getTeardown.resolves(null);
      const verdict = await appUninstaller.driveOwedTeardown('app');
      expect(verdict.status).to.equal('none');
      expect(stubs.dockerService.appDockerRemove.called, 'no teardown driven').to.be.false;
    });

    it('drives the teardown and returns removed once the owed record clears', async () => {
      // owed on entry; cleared after the (idempotent) teardown runs
      stubs.pendingTeardownStore.getTeardown.onFirstCall().resolves(owedDoc()).onSecondCall().resolves(null);
      const verdict = await appUninstaller.driveOwedTeardown('app');
      expect(stubs.dockerService.appDockerRemove.called, 'teardown driven').to.be.true;
      expect(verdict.status).to.equal('removed');
    });

    it('returns deferred and bumps the attempt count when the teardown did not converge', async () => {
      // still owed after the pass (a survivor) -> deferred, pace the next attempt
      stubs.pendingTeardownStore.getTeardown.resolves(owedDoc());
      const verdict = await appUninstaller.driveOwedTeardown('app');
      expect(verdict.status).to.equal('deferred');
      expect(stubs.pendingTeardownStore.bumpAttempts.calledOnceWith('app'), 'attempt count bumped for backoff').to.be.true;
      expect(verdict.attempts).to.equal(1);
    });
  });
});
