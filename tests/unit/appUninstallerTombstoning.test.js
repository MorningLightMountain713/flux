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
const { asConfig } = require('./fixtures/config');
const { AsyncLock } = require('../../ZelBack/src/services/utils/asyncLock');
const { departingApps: realDepartingApps } = require('../../ZelBack/src/services/utils/globalState');
const {
  loadSpecLibrary, V9_SUBMISSION, v9Spec, registeredSpec, assertAnswers,
} = require('./fixtures/fluxSpec');
const { installedRecord } = require('./fixtures/appRecords');

// Tombstoning teardown: the removal prelude marks each instance's record owed +
// condemns, and the deferred worker (runTeardown) stops, removes, tears down what
// the resources name, and takes the records LAST. The order is load-bearing (see
// the adversarial-gate checklist).
//
// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. The prelude reads an HostedInstance (owner, identity, placement) and the
// teardown reads an InstanceResources built from a DeploymentSpec, so those are the
// real classes below; what stays stubbed is I/O and FluxOS policy (docker, mongo,
// the firewall, flux-shutdownd, the registry).

describe('appUninstaller tombstoning teardown', () => {
  let appUninstaller;
  let stubs;
  let flux;
  // The app being removed: the real RegisteredSpec its local row hydrates to,
  // and the real DeploymentSpec the deployment layer projects from it.
  let hostedInstance;
  let deployment;
  // The globally-registered row for the same app, pinned to this node.
  let globalPinnedSpec;

  // This node's socket address, as fluxNetworkHelper reports it below and as the
  // pinned placement names it.
  const LOCAL_SOCKET = '198.18.0.1:16127';

  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30_000);
    flux = await loadSpecLibrary();
  });

  /**
   * A real FluxAppSpecV9 with the named components. Two components may not share
   * a hostPort, so each gets its own; everything else comes from the shared
   * submission fixture.
   */
  const v9App = (appName, components, specOverrides = {}) => {
    let hostPort = 31_000;
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
   * The resources the install wrote for a deployment — every block projected off the
   * real DeploymentSpec rather than spelled out, so an identifier, host-port set or
   * image the library would not produce cannot appear in a fixture.
   */
  const resourcesFor = (dep, blockOverrides = {}) => new flux.InstanceResources({
    name: dep.appName,
    replica: dep.replica ?? null,
    network: { name: dep.networkName },
    components: Object.fromEntries(dep.componentEntries().map(([name, c]) => [name, {
      ...flux.InstanceResources.newBlock({ identifier: c.identifier, image: c.image }),
      hostPorts: c.hostPorts.map((port) => ({ port, opened: ['ufw'] })),
      ...blockOverrides,
    }])),
  });

  /** The owed mark the prelude writes, with the real shutdown planner's budget. */
  const owedFor = (dep, overrides = {}) => ({
    since: 1, reason: null, force: false, broadcast: false, budgetSeconds: shutdownPlan.appShutdownBudgetSeconds(dep), attempts: 0, ...overrides,
  });

  /** The teardown's target: the records' facts and the resources' blocks. */
  const targetFor = (dep, { owed = {}, block = {}, ...overrides } = {}) => {
    const resources = resourcesFor(dep, block);
    return {
      name: dep.appName,
      replica: dep.replica ?? null,
      owner: hostedInstance.owner,
      identity: hostedInstance.identity,
      networkName: resources.network.name,
      components: Object.entries(resources.components).map(([componentName, b]) => ({ componentName, ...b })),
      owed: owedFor(dep, owed),
      source: 'record',
      ...overrides,
    };
  };

  // This node's records: one hosted instance per instance, marked owed by the
  // prelude and taken by the teardown, and its resources beside it.
  let records;
  let instanceResources;
  const recordKey = (name, replica) => `${name.toLowerCase()}\u0000${replica ?? ''}`;
  const installedAt = (name, replica, owedOrNull) => installedRecord(hostedInstance, { replica, owed: owedOrNull });

  beforeEach(async () => {
    const spec = await v9App('app', { web: {} });
    hostedInstance = await registeredSpec(spec);
    deployment = deploymentFor(spec);
    // The GLOBAL registry row the prelude reads for the spawn-throttle clear: a
    // real RegisteredSpec whose real Placement targets this node's socket
    // address, so hasTargets() and isPinnedTo() are the library's own answers.
    // Legacy specs answered both of these wrongly, which is why nothing here
    // stands in for a Placement.
    globalPinnedSpec = await registeredSpec(
      await v9App('app', { web: {} }, { placement: { targetIps: [LOCAL_SOCKET] } }),
      { hash: 'p'.repeat(64) },
    );

    // The deferred worker's host teardown (umount, rm -rf) goes through
    // serviceHelper.runCommand; stub it so the tests neither spawn real sudo
    // subprocesses nor stall the timing-sensitive lease-release assertion.
    sinon.stub(serviceHelper, 'runCommand').resolves({ error: null, stdout: '', stderr: '' });
    const fakeCrontab = { jobs: () => [], remove: () => {}, save: () => {} };
    records = new Map([[recordKey('app', null), { replica: null, owed: null }]]);
    instanceResources = new Map([[recordKey('app', null), resourcesFor(deployment)]]);
    const installed = (name, replica) => {
      const entry = records.get(recordKey(name, replica));
      return entry ? installedAt(name, replica, entry.owed) : null;
    };

    stubs = {
      log: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
      installedApps: {
        byReplica: sinon.stub().callsFake(async (name, replica, { includeOwed = false } = {}) => {
          const found = installed(name, replica);
          return found && (includeOwed || !found.owed) ? found : null;
        }),
        instancesOf: sinon.stub().callsFake(async (name, { includeOwed = false } = {}) => [...records.entries()]
          .filter(([key]) => key.startsWith(`${name.toLowerCase()}\u0000`))
          .map(([, entry]) => installedAt(name, entry.replica, entry.owed))
          .filter((found) => includeOwed || !found.owed)),
        keys: sinon.stub().callsFake(async (name) => [...records.entries()]
          .filter(([key]) => key.startsWith(`${name.toLowerCase()}\u0000`))
          .map(([, entry]) => ({ name, replica: entry.replica }))),
        owed: sinon.stub().callsFake(async () => [...records.entries()].filter(([, entry]) => entry.owed).map(([, entry]) => installedAt('app', entry.replica, entry.owed))),
        markOwed: sinon.stub().callsFake(async (name, replica, owed) => { records.get(recordKey(name, replica)).owed = owed; }),
        remove: sinon.stub().callsFake(async (name, replica) => { records.delete(recordKey(name, replica)); }),
      },
      instanceResources: {
        byInstance: sinon.stub().callsFake(async (name, replica) => instanceResources.get(recordKey(name, replica)) ?? null),
        remove: sinon.stub().callsFake(async (name, replica) => { instanceResources.delete(recordKey(name, replica)); }),
      },
      dockerService: {
        appDockerStop: sinon.stub().resolves(),
        appDockerKill: sinon.stub().resolves(),
        appDockerRemove: sinon.stub().resolves(),
        appDockerForceRemove: sinon.stub().resolves(),
        clearFluxRemovedContainers: sinon.stub(),
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
        readAllTeardowns: sinon.stub().resolves([]),
        clearTeardown: sinon.stub().resolves(),
        getTeardown: sinon.stub().resolves(null),
        bumpAttempts: sinon.stub().resolves(),
      },
      instanceResourceObserver: { discoverVolumeImage: sinon.stub().resolves(null) },
      // Hands back the REAL DeploymentSpec built for the installed app — the same
      // class the real provider projects. Identifiers, host ports, images, the
      // network name and the shutdown budget are all the library's answers.
      deploymentProvider: {
        buildDeployment: sinon.stub().callsFake(async () => deployment),
      },
      appRecords: {
        registry: () => ({ byName: sinon.stub().callsFake(async () => globalPinnedSpec) }),
        instanceResources: () => stubs.instanceResources,
        hostedInstances: () => stubs.installedApps,
        instanceKey: ({ name, replica }) => recordKey(name, replica),
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
      },
      appSwapPoolService: { reconcile: sinon.stub().resolves() },
      telemetrySinkCache: { deleteSink: sinon.stub() },
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
        // The real marks peerNotification reads, and a cycle lock of the shape it holds.
        departingApps: realDepartingApps,
        announceCycle: new AsyncLock(1, { maxHoldMs: 0 }),
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
      config: asConfig({
        fluxapps: { manageCollectorLifecycle: false },
      }),
      crontab: { load: (cb) => cb(null, fakeCrontab) },
      '../../lib/log': stubs.log,
      '../dockerService': stubs.dockerService,
      '../utils/globalState': stubs.globalState,
      '../upnpService': stubs.upnpService,
      '../fluxNetworkHelper': stubs.fluxNetworkHelper,
      '../fluxCommunicationMessagesSender': stubs.fluxCommunicationMessagesSender,
      '../appDatabase/appRecords': stubs.appRecords,
      './instanceResourceObserver': stubs.instanceResourceObserver,
      '../appRuntime/deploymentProvider': stubs.deploymentProvider,
      '../appMonitoring/syncthingMonitorHelpers': stubs.syncthingMonitorHelpers,
      '../utils/volumeService': stubs.volumeService,
      './appSwapPoolService': stubs.appSwapPoolService,
      '../appManagement/appInspector': stubs.appInspector,
      '../appManagement/appsRuntimeState': stubs.appsRuntimeState,
      './pendingTeardownStore': stubs.pendingTeardownStore,
      '../telemetrySinkCache': stubs.telemetrySinkCache,
      '../utils/fluxShutdowndClient': stubs.fluxShutdowndClient,
      '../utils/operationRegistry': stubs.operationRegistry,
      '../appMonitoring/reconcilerQueue': stubs.reconcilerQueue,
      '../utils/fluxEventBus': stubs.fluxEventBus,
    });
  });

  afterEach(() => sinon.restore());

  describe('runTeardown (the deferred worker)', () => {
    // The target the prelude built: the records' facts and the resources' blocks.
    const target = (opts) => targetFor(deployment, opts);

    // A teardown runs only for an instance the prelude marked owed.
    beforeEach(() => { records.get(recordKey('app', null)).owed = owedFor(deployment); });

    it('stops, then removes, then drops runtime state LAST, then takes the records', async () => {
      const { appDockerStop, appDockerRemove } = stubs.dockerService;
      await appUninstaller.runTeardown(target());
      // Addressed by the identifier the real DeploymentSpec minted, not a string
      // the fixture invented.
      expect(
        appDockerStop.calledOnceWith(onlyComponent().identifier),
        'graceful stop of the real identifier',
      ).to.be.true;
      expect(stubs.dockerService.appDockerKill.called, 'no kill on a graceful teardown').to.be.false;
      expect(appDockerRemove.calledOnce, 'container removed').to.be.true;
      expect(stubs.appsRuntimeState.remove.calledOnce, 'runtime state dropped').to.be.true;
      expect(stubs.installedApps.remove.calledOnceWith('app', null), 'the hosted instance taken').to.be.true;
      expect(stubs.instanceResources.remove.calledOnceWith('app', null), 'its resources taken with it').to.be.true;
      expect(records.size, 'no record left').to.equal(0);
      expect(instanceResources.size, 'no resources left').to.equal(0);
      // ORDER (load-bearing): stop -> remove -> drop runtime state (condemned) -> take the records
      expect(appDockerStop.calledBefore(appDockerRemove)).to.be.true;
      expect(appDockerRemove.calledBefore(stubs.appsRuntimeState.remove)).to.be.true;
      expect(stubs.appsRuntimeState.remove.calledBefore(stubs.installedApps.remove)).to.be.true;
      // Host storage IS reclaimed once the container is confirmed gone — the
      // positive half of the "never unmount under a live container" guard below,
      // without which that guard could pass on a teardown that never unmounts at all.
      expect(
        serviceHelper.runCommand.getCalls().some((c) => c.args[0] === 'umount'),
        'volume unmounted once the container is confirmed gone',
      ).to.be.true;
      // The app has left the node: nothing reconciles an app with no record.
      expect(stubs.dockerService.clearFluxRemovedContainers.calledOnceWith([onlyComponent().identifier])).to.be.true;
    });

    it('removes the whole-app docker network (force-disconnecting any endpoints first)', async () => {
      await appUninstaller.runTeardown(target());
      // Even a graceful teardown force-removes: any endpoints left are foreign linked
      // consumers, and a plain removal would leak the network on "active endpoints".
      // The target carries the network name the resources hold; removal takes it as
      // the option. The name is the real DeploymentSpec's, derived from the app
      // identity, not a string spelled out here.
      expect(stubs.dockerService.forceRemoveFluxAppDockerNetwork.calledOnceWith(
        null, { networkName: deployment.networkName },
      )).to.be.true;
      expect(stubs.dockerService.removeFluxAppDockerNetwork.called).to.be.false;
    });

    // The network, like the telemetry sink and the content store, is the app's,
    // shared by every instance of it here: it goes when no instance is still
    // hosted. The instance being removed is marked owed and does not count.
    it('keeps the network while a sibling instance is still hosted, and the removal records with it', async () => {
      records.set(recordKey('app', 's2'), { replica: 's2', owed: null });
      await appUninstaller.runTeardown(target());
      expect(stubs.dockerService.forceRemoveFluxAppDockerNetwork.called, 'the sibling still uses the network').to.be.false;
      expect(stubs.installedApps.remove.calledOnceWith('app', null), 'the instance itself goes').to.be.true;
      expect(stubs.dockerService.clearFluxRemovedContainers.called, 'the sibling keeps the reader of the removal records').to.be.false;
    });

    it('does NOT take the records if a condemned stamp failed to drop (the owed mark re-drives)', async () => {
      stubs.appsRuntimeState.remove.resolves(false);
      await appUninstaller.runTeardown(target());
      expect(stubs.installedApps.remove.called).to.be.false;
      expect(stubs.instanceResources.remove.called).to.be.false;
    });

    // A throw from unmount / appdata / crontab / volume-file removal after the
    // container is gone leaves residue on disk: the mount, the appdata directory,
    // the crontab entry, the FLUXFSVOL file. The records stay owed so it is
    // retried, by the reconciler and at boot, and the component is not held
    // hostage for it.
    it('keeps the records when host cleanup fails after the container is gone', async () => {
      stubs.volumeService.isPathMounted.rejects(new Error('/proc/self/mountinfo unreadable'));

      await appUninstaller.runTeardown(target());

      expect(stubs.installedApps.remove.called, 'residue is still on disk').to.be.false;
      // And NOT by holding the component hostage: its runtime state still drops.
      expect(stubs.appsRuntimeState.remove.called, 'the component is not held hostage').to.be.true;
    });

    // A removal that did not happen is residue, as a throw is: the records stay owed so it
    // is retried, and the stream does not report the data cleaned.
    [
      ['the app data', (c) => c.args[0] === 'rm' && !String(c.args[1].params[1]).endsWith('FLUXFSVOL')],
      ['the volume image', (c) => c.args[0] === 'rm' && String(c.args[1].params[1]).endsWith('FLUXFSVOL')],
    ].forEach(([what, isThatRemoval]) => {
      it(`keeps the records when removing ${what} fails`, async () => {
        // The image file is where the resources say the node put it.
        const block = { volume: { file: '/dat/fluxweb_appFLUXFSVOL', disk: '/dat', fsUuid: 'u', mountDir: `${appsFolder}${onlyComponent().identifier}` } };
        serviceHelper.runCommand.callsFake(async (cmd, opts) => (
          isThatRemoval({ args: [cmd, opts] }) ? { error: new Error('rm: cannot remove: Device or resource busy') } : { error: null, stdout: '', stderr: '' }
        ));
        const statuses = [];

        await appUninstaller.runTeardown(target({ block }), { onStatus: (msg) => statuses.push(msg) });

        expect(serviceHelper.runCommand.getCalls().some((c) => isThatRemoval(c)), 'the removal was never attempted').to.be.true;
        expect(stubs.installedApps.remove.called, 'residue is still on disk').to.be.false;
        expect(statuses.some((msg) => /\bcleaned\b/.test(msg) && !/Database/.test(msg) && (what === 'the app data' ? /^Data of/.test(msg) : /^Volume of/.test(msg))), 'reported cleaned when it was not').to.be.false;
      });
    });

    it('never reclaims host storage (nor takes the records) while the container survives the remove', async () => {
      // A concurrent re-create (or a failed remove) leaves the container present. Destroying
      // its volume now would corrupt a live container, so the teardown must skip the
      // destructive cleanup and stay owed for retry.
      stubs.dockerService.getDockerContainer.resolves({ id: 'still-running' });
      await appUninstaller.runTeardown(target());
      expect(stubs.dockerService.appDockerRemove.calledOnce, 'remove attempted').to.be.true;
      const umountCalled = serviceHelper.runCommand.getCalls().some((c) => c.args[0] === 'umount');
      expect(umountCalled, 'volume NOT unmounted under a live container').to.be.false;
      expect(stubs.installedApps.remove.called, 'records kept owed for retry').to.be.false;
    });

    it('force teardown kills + force-removes the container and force-removes the network', async () => {
      await appUninstaller.runTeardown(target({ owed: { force: true } }));
      expect(stubs.dockerService.appDockerKill.calledOnce).to.be.true;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
      expect(stubs.dockerService.appDockerForceRemove.calledOnce).to.be.true;
      expect(stubs.dockerService.forceRemoveFluxAppDockerNetwork.calledOnce).to.be.true;
    });

    // A teardown must not tear a container down while a reconcile start holds the
    // component 'removing' key. It WAITS (bounded) for the start to settle — the acquire
    // succeeding is the signal — then removes, rather than deferring to boot recovery.
    it('waits for an in-flight start (removing key busy) to settle, then removes', async () => {
      stubs.operationRegistry.acquire.onFirstCall().returns(null).onSecondCall().returns('tok');
      await appUninstaller.runTeardown(target());
      expect(stubs.operationRegistry.acquire.callCount, 'polled the removing lease until the start cleared').to.be.at.least(2);
      expect(stubs.dockerService.appDockerRemove.calledOnce, 'removed once the lease cleared').to.be.true;
      expect(stubs.installedApps.remove.calledOnce, 'teardown completed, not owed').to.be.true;
    });

    // A start that completed in the gap before we took the lease leaves the container
    // running; holding 'removing' now, we escalate to a force remove (its graceful window
    // already elapsed) rather than 409-looping to boot recovery — and the teardown completes.
    it('force-escalates and completes when a start left the container running', async () => {
      stubs.dockerService.getDockerContainer.onFirstCall().resolves({ id: 'running-from-gap' }).onSecondCall().resolves(null);
      await appUninstaller.runTeardown(target());
      expect(stubs.dockerService.appDockerRemove.calledOnce, 'non-force remove attempted first').to.be.true;
      expect(stubs.dockerService.appDockerForceRemove.calledOnce, 'escalated to a force remove').to.be.true;
      expect(stubs.dockerService.appDockerRemove.calledBefore(stubs.dockerService.appDockerForceRemove)).to.be.true;
      expect(stubs.appsRuntimeState.remove.called, 'runtime state dropped — component fully torn down').to.be.true;
      expect(stubs.installedApps.remove.calledOnce, 'records taken, not owed').to.be.true;
    });

    // A component whose container cannot be removed (even the force escalation fails) must
    // keep its condemned stamp: dropping it would un-condemn a live container and let the
    // reconciler keep it running until boot recovery. So the teardown must NOT drop its
    // runtime state, and must stay owed.
    it('keeps a surviving component condemned (does not drop its runtime state) and owed', async () => {
      stubs.dockerService.getDockerContainer.resolves({ id: 'stuck' }); // never gone, even after force
      await appUninstaller.runTeardown(target());
      expect(stubs.dockerService.appDockerForceRemove.called, 'escalation attempted').to.be.true;
      expect(stubs.appsRuntimeState.remove.called, 'must NOT drop runtime state — that would un-condemn a live container').to.be.false;
      expect(stubs.installedApps.remove.called, 'kept owed for boot recovery').to.be.false;
      // and it hands the still-owed teardown to the reconciler to converge (retry with
      // backoff), rather than abandoning it until the next boot.
      expect(stubs.reconcilerQueue.enqueueComponent.calledWith(onlyComponent().identifier), 'enqueued the survivor for the reconciler to re-drive').to.be.true;
    });
  });

  describe('uninstallApplication (the removal prelude)', () => {
    it('marks the instance owed BEFORE condemning, condemns what the resources name, and awaits the teardown (foreground)', async () => {
      const res = await appUninstaller.uninstallApplication('app', { broadcastRemoval: true });
      expect(res.status).to.equal(appUninstaller.UninstallStatus.REMOVED);
      expect(stubs.installedApps.markOwed.calledOnce, 'the instance marked owed').to.be.true;
      expect(stubs.appsRuntimeState.setCondemned.calledWith(onlyComponent().identifier, true), 'component condemned').to.be.true;
      // ORDER (load-bearing): the durable mark BEFORE anything is condemned
      expect(stubs.installedApps.markOwed.calledBefore(stubs.appsRuntimeState.setCondemned)).to.be.true;
      // foreground (background:false default) actually runs the destructive teardown
      expect(stubs.dockerService.appDockerRemove.called).to.be.true;
      // the prelude aborts any in-flight install of the same app (cancel-vs-install)
      expect(stubs.globalState.abortInstall.calledWith('app'), 'in-flight install aborted').to.be.true;

      // The mark names the removal: why, how, whether announced, and the stop
      // budget the daemon is given, the real shutdown planner's answer over the
      // real deployment. Nothing here is a number written twice.
      const [name, replica, mark] = stubs.installedApps.markOwed.firstCall.args;
      expect([name, replica]).to.deep.equal(['app', null]);
      expect(mark).to.deep.include({
        reason: null, force: false, broadcast: true, budgetSeconds: shutdownPlan.appShutdownBudgetSeconds(deployment), attempts: 0,
      });
      expect(mark.since).to.be.a('number');

      // The deployment is built from the instance's record: the real provider
      // reads name/identity off it and resolves its cleartext through
      // isEncrypted/spec, so the object handed over must answer all four — and
      // must actually project to the same deployment.
      const [handed, buildOpts] = stubs.deploymentProvider.buildDeployment.firstCall.args;
      expect(handed.name).to.equal('app');
      expect(handed.identity).to.equal(null);
      expect(handed.isEncrypted).to.equal(false);
      expect(handed.spec, 'the record must carry a resolvable spec').to.be.an('object');
      expect(buildOpts).to.deep.equal({ replica: null });
      // The real provider resolves the record's cleartext and then asks its Placement
      // which replicas this node runs — placement.mode() is the first thing
      // resolveLocalReplicas calls, so the resolved spec has to answer it.
      assertAnswers(handed.spec.placement, ['mode', 'hasTargets']);
      expect(
        deploymentFor(handed.spec, { identity: handed.identity })
          .componentEntries().map(([, c]) => c.identifier),
        'what was handed over really does project to this deployment',
      ).to.deep.equal(deployment.componentEntries().map(([, c]) => c.identifier));

      // The teardown took both records.
      expect(records.size, 'the hosted instance is gone').to.equal(0);
      expect(instanceResources.size, 'and its resources').to.equal(0);

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
      globalPinnedSpec = await registeredSpec(await v9App('app', { web: {} }), { hash: 'q'.repeat(64) });
      stubs.globalState.trySpawningGlobalAppCache = new Map([[globalPinnedSpec.hash, Date.now()]]);

      await appUninstaller.uninstallApplication('app', { broadcastRemoval: true });

      expect(globalPinnedSpec.placement.hasTargets(), 'the real placement has no targets').to.be.false;
      expect(
        stubs.globalState.trySpawningGlobalAppCache.has(globalPinnedSpec.hash),
        'an unpinned app keeps its throttle',
      ).to.be.true;
    });

    it('fails CLOSED: a mark that cannot be written aborts the removal before anything is condemned', async () => {
      stubs.installedApps.markOwed.rejects(new Error('db down'));
      const res = await appUninstaller.uninstallApplication('app', { broadcastRemoval: true });
      expect(res.status).to.equal(appUninstaller.UninstallStatus.FAILED);
      expect(stubs.appsRuntimeState.setCondemned.called, 'nothing condemned without the durable mark').to.be.false;
      expect(stubs.dockerService.appDockerRemove.called, 'nothing torn down').to.be.false;
      expect(records.size, 'the record stays').to.equal(1);
      expect(instanceResources.size, 'and its resources').to.equal(1);
    });

    // A removal whose prelude marked the instance and then died before its
    // teardown leaves an owed instance; a second removal finds it, it does not
    // read it as absent.
    it('removes an instance already marked owed rather than skipping it', async () => {
      records.get(recordKey('app', null)).owed = owedFor(deployment);
      const res = await appUninstaller.uninstallApplication('app', { broadcastRemoval: true });
      expect(res.status).to.equal(appUninstaller.UninstallStatus.REMOVED);
      expect(records.size).to.equal(0);
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

  // The owed-teardown record a release before instance resources wrote for a removal
  // whose teardown it did not finish: driven once through this teardown, then
  // cleared.
  const legacyDoc = () => ({
    key: 'old',
    name: 'old',
    replica: null,
    networkName: 'fluxDockerNetwork_old',
    forceKill: false,
    broadcastRemoval: true,
    owner: '1own',
    identity: null,
    reason: 'user-cancel',
    shutdownBudgetSeconds: 30,
    createdAt: 1,
    attempts: 0,
    components: [{
      identifier: 'web_old', appId: 'web_old', componentName: 'web', label: 'old', ports: [31_001], image: 'nginx:1',
    }],
  });

  describe('recoverOwedTeardowns (boot recovery)', () => {
    const settled = async (done) => {
      for (let i = 0; i < 200 && !done(); i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setImmediate(resolve); });
      }
    };

    it('re-condemns every component an owed instance\'s resources name, then hands them to the reconciler to converge', async () => {
      records.get(recordKey('app', null)).owed = owedFor(deployment);
      await appUninstaller.recoverOwedTeardowns();
      expect(stubs.appsRuntimeState.setCondemned.calledWith(onlyComponent().identifier, true)).to.be.true;
      // Boot recovery does not drive the teardown directly (a partial would be abandoned
      // until the NEXT boot); it enqueues the components so the reconciler converges them.
      expect(stubs.reconcilerQueue.enqueueComponent.calledWith(onlyComponent().identifier), 'enqueued for the reconciler to drive').to.be.true;
      await new Promise((r) => { setImmediate(r); });
      expect(stubs.dockerService.appDockerStop.called, 'no direct boot-time teardown drive').to.be.false;
      expect(records.size, 'the records stay until the reconciler drives the teardown').to.equal(1);
    });

    // An owed instance whose resources name no component gives the reconciler
    // nothing to drive by, so its teardown runs here and takes the records.
    it('drives the teardown of an owed instance the node wrote no resources for, and takes its record', async () => {
      records.get(recordKey('app', null)).owed = owedFor(deployment);
      instanceResources.delete(recordKey('app', null));
      await appUninstaller.recoverOwedTeardowns();
      await settled(() => records.size === 0);
      expect(stubs.installedApps.remove.calledOnceWith('app', null), 'the record taken').to.be.true;
      expect(stubs.reconcilerQueue.enqueueComponent.called, 'nothing for the reconciler to drive by').to.be.false;
      expect(stubs.appsRuntimeState.setCondemned.called, 'nothing to condemn').to.be.false;
    });

    it('leaves the owed instances for the next boot when they cannot be read', async () => {
      records.get(recordKey('app', null)).owed = owedFor(deployment);
      stubs.installedApps.owed.rejects(new Error('db blip'));
      await appUninstaller.recoverOwedTeardowns();
      expect(stubs.appsRuntimeState.setCondemned.called, 'must not condemn on a guess').to.be.false;
      expect(stubs.reconcilerQueue.enqueueComponent.called).to.be.false;
      await new Promise((r) => { setImmediate(r); });
      expect(stubs.dockerService.appDockerRemove.called).to.be.false;
      expect(records.size, 'the record kept for the next boot').to.equal(1);
    });

    it('re-condemns the components of an owed-teardown record a release before instance resources left, and enqueues them', async () => {
      stubs.pendingTeardownStore.readAllTeardowns.resolves([legacyDoc()]);
      await appUninstaller.recoverOwedTeardowns();
      expect(stubs.appsRuntimeState.setCondemned.calledOnceWith('web_old', true, { force: false })).to.be.true;
      expect(stubs.reconcilerQueue.enqueueComponent.calledOnceWith('web_old')).to.be.true;
      await new Promise((r) => { setImmediate(r); });
      expect(stubs.dockerService.appDockerStop.called, 'no direct boot-time teardown drive').to.be.false;
      expect(stubs.pendingTeardownStore.clearTeardown.called, 'the record stays until its teardown finishes').to.be.false;
    });
  });

  describe('driveOwedTeardown (the reconciler converge-to-gone actuator)', () => {
    const ref = { name: 'app', replica: null };

    it('returns none for an instance that is hosted, not owed', async () => {
      const verdict = await appUninstaller.driveOwedTeardown(ref);
      expect(verdict.status).to.equal('none');
      expect(stubs.dockerService.appDockerRemove.called, 'no teardown driven').to.be.false;
    });

    it('drives the teardown and returns removed once the records go', async () => {
      records.get(recordKey('app', null)).owed = owedFor(deployment);
      const verdict = await appUninstaller.driveOwedTeardown(ref);
      expect(stubs.dockerService.appDockerRemove.called, 'teardown driven').to.be.true;
      expect(verdict.status).to.equal('removed');
      expect(records.size).to.equal(0);
    });

    it('returns deferred and counts the pass on the mark when the teardown did not converge', async () => {
      records.get(recordKey('app', null)).owed = owedFor(deployment);
      // still owed after the pass (a survivor) -> deferred, pace the next attempt
      stubs.dockerService.getDockerContainer.resolves({ id: 'survivor' });
      const verdict = await appUninstaller.driveOwedTeardown(ref);
      expect(verdict.status).to.equal('deferred');
      expect(verdict.attempts).to.equal(1);
      expect(stubs.installedApps.markOwed.lastCall.args, 'the pass counted on the mark').to.deep.equal(['app', null, { ...owedFor(deployment), attempts: 1 }]);
      expect(records.get(recordKey('app', null)).owed.attempts).to.equal(1);
    });

    describe('an owed-teardown record a release before instance resources left', () => {
      beforeEach(() => {
        stubs.pendingTeardownStore.getTeardown.callsFake(async (key) => (
          key === 'old' && !stubs.pendingTeardownStore.clearTeardown.called ? legacyDoc() : null
        ));
      });

      it('tears down what the record names, each port as the node opens ports now and the image found once, then clears it', async () => {
        stubs.fluxNetworkHelper.isFirewallActive.resolves(true);
        stubs.instanceResourceObserver.discoverVolumeImage.resolves({ path: '/dat/fluxweb_oldFLUXFSVOL', fsUuid: 'u' });

        const verdict = await appUninstaller.driveOwedTeardown({ legacyKey: 'old' });

        expect(verdict.status).to.equal('removed');
        expect(stubs.dockerService.appDockerRemove.calledOnceWith('web_old')).to.be.true;
        expect(stubs.fluxNetworkHelper.deleteAllowPortRule.calledOnceWith(31_001), 'closed on the firewall the node runs').to.be.true;
        expect(stubs.upnpService.removeMapUpnpPort.called, 'no UPnP here').to.be.false;
        expect(stubs.instanceResourceObserver.discoverVolumeImage.calledOnceWith('web_old', null)).to.be.true;
        expect(
          serviceHelper.runCommand.getCalls().filter((c) => c.args[0] === 'rm').map((c) => c.args[1].params[1]),
          'the image found is the file removed',
        ).to.include('/dat/fluxweb_oldFLUXFSVOL');
        expect(stubs.dockerService.forceRemoveFluxAppDockerNetwork.calledOnceWith(null, { networkName: 'fluxDockerNetwork_old' })).to.be.true;
        expect(stubs.pendingTeardownStore.clearTeardown.calledOnceWith('old')).to.be.true;
        expect(stubs.installedApps.remove.called, 'no hosted instance to take').to.be.false;
      });

      it('returns deferred and counts the pass on the record when the teardown did not converge', async () => {
        stubs.dockerService.getDockerContainer.resolves({ id: 'survivor' });
        const verdict = await appUninstaller.driveOwedTeardown({ legacyKey: 'old' });
        expect(verdict.status).to.equal('deferred');
        expect(stubs.pendingTeardownStore.bumpAttempts.calledOnceWith('old'), 'attempt count bumped for backoff').to.be.true;
        expect(verdict.attempts).to.equal(1);
        expect(stubs.pendingTeardownStore.clearTeardown.called).to.be.false;
      });

      it('returns none once the record is cleared', async () => {
        const verdict = await appUninstaller.driveOwedTeardown({ legacyKey: 'gone' });
        expect(verdict.status).to.equal('none');
        expect(stubs.dockerService.appDockerRemove.called).to.be.false;
      });
    });
  });
});
