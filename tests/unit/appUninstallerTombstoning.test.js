'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const { appsFolder } = require('../../ZelBack/src/services/utils/appConstants');
// The REAL shutdown planner appUninstaller resolves (it is not stubbed below), so
// the budget stamped on the durable record can be compared against the library's
// own answer rather than a number copied into the fixture.
const shutdownPlan = require('../../ZelBack/src/services/appLifecycle/shutdownPlan');
const {
  loadSpecLibrary, V9_SUBMISSION, v9Spec, instantiatedSpec, assertAnswers,
} = require('./fixtures/fluxSpec');

// Tombstoning teardown: the removal prelude records a durable owed-teardown doc +
// condemns + deletes the local row, and the deferred worker (runTeardown) stops,
// removes, tears down the host state, and clears the record LAST. The order is
// load-bearing (see the adversarial-gate checklist).
//
// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. The prelude reads an InstantiatedSpec (owner, identity, placement) and
// projects the durable record off a DeploymentSpec, so those are the two real
// classes below; what stays stubbed is I/O and FluxOS policy (docker, mongo, the
// firewall, flux-shutdownd, the registry).

describe('appUninstaller tombstoning teardown', () => {
  let appUninstaller;
  let stubs;
  let flux;
  // The app being removed: the real InstantiatedSpec its local row hydrates to,
  // and the real DeploymentSpec the deployment layer projects from it.
  let installedSpec;
  let deployment;
  // The globally-registered row for the same app, pinned to this node.
  let globalPinnedSpec;

  // This node's socket address, as fluxNetworkHelper reports it below and as the
  // pinned placement names it.
  const LOCAL_SOCKET = '198.18.0.1:16127';

  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30000);
    flux = await loadSpecLibrary();
  });

  /**
   * A real FluxAppSpecV9 with the named components. Two components may not share
   * a hostPort, so each gets its own; everything else comes from the shared
   * submission fixture.
   */
  const v9App = (appName, components, specOverrides = {}) => {
    let hostPort = 31000;
    const built = {};
    for (const [name, over] of Object.entries(components)) {
      hostPort += 1;
      built[name] = {
        ...V9_SUBMISSION.components.web,
        name,
        ports: { http: { containerPort: 80, hostPort } },
        ...over,
      };
    }
    return v9Spec({ name: appName, components: built, ...specOverrides });
  };

  /** A real DeploymentSpec — the class deploymentProvider hands every caller. */
  const deploymentFor = (spec, opts = {}) => flux.DeploymentSpec.fromSpec(
    spec, appsFolder, { replica: null, ...opts },
  );

  /** The real DeploymentComponent of the single-component app under test. */
  const onlyComponent = () => deployment.componentEntries()[0][1];

  /**
   * The durable owed-teardown record exactly as the prelude writes it — every
   * field projected off the real DeploymentSpec / InstantiatedSpec rather than
   * spelled out, so an identifier, network name, host-port set or image the
   * library would not produce cannot appear in a fixture.
   */
  const teardownDocFor = (dep, overrides = {}) => ({
    key: dep.appName,
    name: dep.appName,
    replica: dep.replica,
    networkName: dep.networkName,
    forceKill: false,
    owner: installedSpec.owner,
    identity: installedSpec.identity,
    reason: null,
    shutdownBudgetSeconds: shutdownPlan.appShutdownBudgetSeconds(dep),
    createdAt: Date.now(),
    attempts: 0,
    components: dep.componentEntries({ reverse: true }).map(([, c]) => ({
      identifier: c.identifier,
      // dockerService.getAppIdentifier is the identity stub below, as in production
      // for an already-prefixed identifier.
      appId: c.identifier,
      componentName: c.name,
      label: c.name === dep.appName ? dep.appName : `component ${c.name} of ${dep.appName}`,
      ports: c.hostPorts,
      image: c.image,
    })),
    ...overrides,
  });

  beforeEach(async () => {
    const spec = await v9App('app', { web: {} });
    installedSpec = await instantiatedSpec(spec);
    deployment = deploymentFor(spec);
    // The GLOBAL registry row the prelude reads for the spawn-throttle clear: a
    // real InstantiatedSpec whose real Placement targets this node's socket
    // address, so hasTargets() and isPinnedTo() are the library's own answers.
    // Legacy specs answered both of these wrongly, which is why nothing here
    // stands in for a Placement.
    globalPinnedSpec = await instantiatedSpec(
      await v9App('app', { web: {} }, { placement: { targetIps: [LOCAL_SOCKET] } }),
      { hash: 'p'.repeat(64) },
    );

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
      // Hands back the REAL DeploymentSpec built for the installed app — the same
      // class the real provider projects. Identifiers, host ports, images, the
      // network name and the shutdown budget are all the library's answers.
      deploymentProvider: {
        getInstalledDeployment: sinon.stub().callsFake(async () => deployment),
        buildDeployment: sinon.stub().callsFake(async () => deployment),
        localIdentities: sinon.stub().resolves([null]),
      },
      appsRepository: {
        getInstalledApp: sinon.stub().callsFake(async () => installedSpec),
        getGlobalAppInfo: sinon.stub().callsFake(async () => globalPinnedSpec),
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
      volumeService: {
        // Mounted, so the teardown's unmount is actually attempted — otherwise the
        // "volume NOT unmounted under a live container" guard below can only ever
        // pass, whatever the production code does.
        isPathMounted: sinon.stub().resolves(true),
        getVolumeFilePath: sinon.stub().resolves(null),
      },
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
        runningAppsCache: new Map(),
        receiveOnlySyncthingAppsCache: new Map(),
        // Seeded with the pinned app's real content hash so the prelude's
        // spawn-throttle clear has something to clear.
        trySpawningGlobalAppCache: new Map([[globalPinnedSpec.hash, Date.now()]]),
        abortInstall: sinon.stub().returns(false),
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
    // The durable record the prelude persisted, projected off the real deployment.
    const doc = (overrides = {}) => teardownDocFor(deployment, overrides);

    it('stops, then removes, then drops runtime state LAST, then clears the durable record', async () => {
      const { appDockerStop, appDockerRemove } = stubs.dockerService;
      await appUninstaller.runTeardown(doc());
      // Addressed by the identifier the real DeploymentSpec minted, not a string
      // the fixture invented.
      expect(
        appDockerStop.calledOnceWith(onlyComponent().identifier),
        'graceful stop of the real identifier',
      ).to.be.true;
      expect(stubs.dockerService.appDockerKill.called, 'no kill on a graceful teardown').to.be.false;
      expect(appDockerRemove.calledOnce, 'container removed').to.be.true;
      expect(stubs.appsRuntimeState.remove.calledOnce, 'runtime state dropped').to.be.true;
      expect(stubs.pendingTeardownStore.clearTeardown.calledOnce, 'durable record cleared').to.be.true;
      // ORDER (load-bearing): stop -> remove -> drop runtime state (condemned) -> clear record
      expect(appDockerStop.calledBefore(appDockerRemove)).to.be.true;
      expect(appDockerRemove.calledBefore(stubs.appsRuntimeState.remove)).to.be.true;
      expect(stubs.appsRuntimeState.remove.calledBefore(stubs.pendingTeardownStore.clearTeardown)).to.be.true;
      // Host storage IS reclaimed once the container is confirmed gone — the
      // positive half of the "never unmount under a live container" guard below,
      // without which that guard could pass on a teardown that never unmounts at all.
      expect(
        serviceHelper.runCommand.getCalls().some((c) => c.args[0] === 'umount'),
        'volume unmounted once the container is confirmed gone',
      ).to.be.true;
    });

    it('removes the whole-app docker network (force-disconnecting any endpoints first)', async () => {
      await appUninstaller.runTeardown(doc());
      // Even a graceful teardown force-removes: any endpoints left are foreign linked
      // consumers, and a plain removal would leak the network on "active endpoints".
      // the record carries the resolved network name; removal takes it as the option,
      // so a teardown that outlives the row still takes the right network with it
      // the network name is the real DeploymentSpec's, derived from the app
      // identity — not a string spelled out here
      expect(stubs.dockerService.forceRemoveFluxAppDockerNetwork.calledOnceWith(
        null, { networkName: deployment.networkName },
      )).to.be.true;
      expect(stubs.dockerService.removeFluxAppDockerNetwork.called).to.be.false;
    });

    it('does NOT clear the durable record if a condemned stamp failed to drop (boot recovery re-drives)', async () => {
      stubs.appsRuntimeState.remove.resolves(false);
      await appUninstaller.runTeardown(doc());
      expect(stubs.pendingTeardownStore.clearTeardown.called).to.be.false;
    });

    // The docstring on teardownComponentCore promises "the host residue is
    // retried by the owed record, never by holding the component hostage". It
    // was not: `removed` was set to true BEFORE the destructive cleanup, so a
    // throw from unmount / appdata / crontab / volume-file removal still
    // reported removed, the caller saw no survivor, and clearTeardown dropped
    // the record. The mount, the appdata directory, the crontab entry and the
    // FLUXFSVOL file were then never retried — not by the reconciler, not at
    // boot.
    it('keeps the durable record when host cleanup fails after the container is gone', async () => {
      stubs.volumeService.isPathMounted.rejects(new Error('/proc/self/mountinfo unreadable'));

      await appUninstaller.runTeardown(doc());

      expect(stubs.pendingTeardownStore.clearTeardown.called, 'residue is still on disk').to.be.false;
      // And NOT by holding the component hostage: its runtime state still drops,
      // which is the half the docstring gets right.
      expect(stubs.appsRuntimeState.remove.called, 'the component is not held hostage').to.be.true;
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
      await appUninstaller.runTeardown(doc({ forceKill: true }));
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
      expect(stubs.reconcilerQueue.enqueueComponent.calledWith(onlyComponent().identifier), 'enqueued the survivor for the reconciler to re-drive').to.be.true;
    });
  });

  describe('uninstallApplication (the removal prelude)', () => {
    it('records the owed-teardown doc BEFORE deleting the local row, condemns, and awaits teardown (foreground)', async () => {
      const res = await appUninstaller.uninstallApplication('app', { broadcastRemoval: true });
      expect(res.status).to.equal(appUninstaller.UninstallStatus.REMOVED);
      expect(stubs.pendingTeardownStore.writeTeardown.calledOnce, 'doc written').to.be.true;
      expect(stubs.appsRuntimeState.setCondemned.calledWith(onlyComponent().identifier, true), 'component condemned').to.be.true;
      expect(stubs.appsRepository.removeInstalledApp.calledOnce, 'local row deleted').to.be.true;
      // ORDER (load-bearing): durable doc persisted BEFORE the row is deleted
      expect(stubs.pendingTeardownStore.writeTeardown.calledBefore(stubs.appsRepository.removeInstalledApp)).to.be.true;
      // foreground (background:false default) actually runs the destructive teardown
      expect(stubs.dockerService.appDockerRemove.called).to.be.true;
      // the prelude aborts any in-flight install of the same app (cancel-vs-install)
      expect(stubs.globalState.abortInstall.calledWith('app'), 'in-flight install aborted').to.be.true;

      // The record the prelude persisted is projected off the REAL deployment: the
      // component identifiers, host ports and images are the library's, and the
      // stop budget is the real shutdown planner's answer over that deployment.
      // Nothing here is a number written twice.
      const [written] = stubs.pendingTeardownStore.writeTeardown.firstCall.args;
      expect(written).to.deep.include({
        key: 'app',
        name: 'app',
        networkName: deployment.networkName,
        owner: installedSpec.owner,
        identity: installedSpec.identity,
        shutdownBudgetSeconds: shutdownPlan.appShutdownBudgetSeconds(deployment),
      });
      expect(written.components.map((c) => c.identifier))
        .to.deep.equal(deployment.componentEntries({ reverse: true }).map(([, c]) => c.identifier));
      expect(written.components.map((c) => c.ports))
        .to.deep.equal(deployment.componentEntries({ reverse: true }).map(([, c]) => c.hostPorts));

      // The two collaborators that stay stubbed and receive the spec: the real
      // deploymentProvider reads name/identity off the row and resolves its
      // cleartext through isEncrypted/spec, so the object handed over must answer
      // all four — and must actually project to the same deployment.
      const [handedForIdentities] = stubs.deploymentProvider.localIdentities.firstCall.args;
      const [handedForBuild, buildOpts] = stubs.deploymentProvider.buildDeployment.firstCall.args;
      for (const handed of [handedForIdentities, handedForBuild]) {
        expect(handed.name).to.equal('app');
        expect(handed.identity).to.equal(null);
        expect(handed.isEncrypted).to.equal(false);
        expect(handed.spec, 'the row must carry a resolvable spec').to.be.an('object');
      }
      // buildDeployment is contractually given an explicit identity — the real one
      // throws without it.
      expect(buildOpts).to.have.property('replica', null);
      // The real provider resolves the row's cleartext and then asks its Placement
      // which replicas this node runs — placement.mode() is the first thing
      // resolveLocalReplicas calls, so the resolved spec has to answer it.
      assertAnswers(handedForBuild.spec.placement, ['mode', 'hasTargets']);
      expect(
        deploymentFor(handedForBuild.spec, { identity: handedForBuild.identity })
          .componentEntries().map(([, c]) => c.identifier),
        'what was handed over really does project to this deployment',
      ).to.deep.equal(deployment.componentEntries().map(([, c]) => c.identifier));

      // The spawn-throttle clear ran against a REAL Placement: hasTargets() and
      // isPinnedTo() answered for a v9 candidate placement naming this node's
      // socket address, so the throttle entry for its content hash is gone.
      expect(
        stubs.globalState.trySpawningGlobalAppCache.has(globalPinnedSpec.hash),
        'throttle cleared for an app whose real placement pins it here',
      ).to.be.false;
    });

    it('leaves the spawn throttle alone when the real placement does not target this node', async () => {
      // Same code path, opposite real answer: an untargeted placement — mode
      // 'none', hasTargets() false — must not read as pinned here.
      globalPinnedSpec = await instantiatedSpec(await v9App('app', { web: {} }), { hash: 'q'.repeat(64) });
      stubs.globalState.trySpawningGlobalAppCache = new Map([[globalPinnedSpec.hash, Date.now()]]);

      await appUninstaller.uninstallApplication('app', { broadcastRemoval: true });

      expect(globalPinnedSpec.placement.hasTargets(), 'the real placement has no targets').to.be.false;
      expect(
        stubs.globalState.trySpawningGlobalAppCache.has(globalPinnedSpec.hash),
        'an unpinned app keeps its throttle',
      ).to.be.true;
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
    // The record a crashed removal left behind — the same projection off the real
    // deployment the prelude writes.
    const owedDoc = () => teardownDocFor(deployment);

    it('re-condemns owed components then hands them to the reconciler to converge (not a one-shot boot drive)', async () => {
      stubs.pendingTeardownStore.readAllTeardowns.resolves([owedDoc()]);
      stubs.appsRepository.existsInstalledIdentity.resolves(false);
      await appUninstaller.recoverOwedTeardowns();
      expect(stubs.appsRuntimeState.setCondemned.calledWith(onlyComponent().identifier, true)).to.be.true;
      // Boot recovery no longer drives the teardown directly (a partial would be abandoned
      // until the NEXT boot); it enqueues the components so the reconciler converges them.
      expect(stubs.reconcilerQueue.enqueueComponent.calledWith(onlyComponent().identifier), 'enqueued for the reconciler to drive').to.be.true;
      await new Promise((r) => { setImmediate(r); });
      expect(stubs.dockerService.appDockerStop.called, 'no direct boot-time teardown drive').to.be.false;
    });

    it('un-condemns + drops the record without teardown when the app is re-installed (row is back)', async () => {
      stubs.pendingTeardownStore.readAllTeardowns.resolves([owedDoc()]);
      stubs.appsRepository.existsInstalledIdentity.resolves(true); // re-installed
      await appUninstaller.recoverOwedTeardowns();
      expect(stubs.appsRuntimeState.setCondemned.calledWith(onlyComponent().identifier, false), 'un-condemned').to.be.true;
      expect(stubs.pendingTeardownStore.clearTeardown.calledOnceWith('app')).to.be.true;
      await new Promise((r) => { setImmediate(r); });
      expect(stubs.dockerService.appDockerRemove.called, 'never tear down a re-installed app').to.be.false;
    });

    it('defers (no teardown, keeps the record) when the install-row read fails transiently', async () => {
      stubs.pendingTeardownStore.readAllTeardowns.resolves([owedDoc()]);
      stubs.appsRepository.existsInstalledIdentity.rejects(new Error('db blip'));
      await appUninstaller.recoverOwedTeardowns();
      expect(stubs.appsRuntimeState.setCondemned.calledWith(onlyComponent().identifier, true), 'must not condemn on a guess').to.be.false;
      expect(stubs.pendingTeardownStore.clearTeardown.called, 'record kept for next boot').to.be.false;
      await new Promise((r) => { setImmediate(r); });
      expect(stubs.dockerService.appDockerRemove.called).to.be.false;
    });
  });

  describe('driveOwedTeardown (the reconciler converge-to-gone actuator)', () => {
    const owedDoc = () => teardownDocFor(deployment);

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
