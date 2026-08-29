'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
// The real registry singleton — the reconciler's hasOperationLease reads it, and
// proxyquire (un-stubbed dep) gives the reconciler this same instance.
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');
const fluxEventBus = require('../../ZelBack/src/services/utils/fluxEventBus');
// The real registry (dependency-free singleton): the engine under test reads
// it directly, so the drift tests write it and every test resets it.
const meshIdentityDrift = require('../../ZelBack/src/services/appMesh/meshIdentityDrift');
const { appsFolder } = require('../../ZelBack/src/services/utils/appConstants');
const {
  loadSpecLibrary, V9_SUBMISSION, V8_SUBMISSION, v1Spec, v8Spec, v9Spec, sealedV8Spec,
  instantiatedSpec, assertAnswers,
} = require('./fixtures/fluxSpec');

// Mirrors appUninstaller.UninstallStatus (proxyquire.noCallThru stubs the real module out).
const UninstallStatus = Object.freeze({
  REMOVED: 'removed',
  SKIPPED: 'skipped',
  DEFERRED: 'deferred',
  FAILED: 'failed',
});

// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. The reconciler drives run-state over a DeploymentSpec and the
// InstantiatedSpec its app row hydrates to, so those are the two real classes the
// fixtures below build; what stays stubbed is I/O (docker, mongo, the volume
// layer) and FluxOS policy.
let flux;

// The owner every fixture app carries: a real FluxID, not a placeholder. The
// desired-network set is validated with it, so a fiction here would be a fiction
// on the wire.
const OWNER = V9_SUBMISSION.owner;

describe('appReconciler tests', () => {
  let appReconciler;
  let stubs;
  // The app installed on this node: a real InstantiatedSpec (what appsRepository
  // hydrates a row to) and the real DeploymentSpec the deployment layer projects
  // from it. Either may be null — an app that is not installed here.
  let localInst;
  let localDeployment;

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

  /** The v8 compose array for the named components — legacy containerData shapes. */
  const v8Compose = (components) => {
    const [template] = V8_SUBMISSION.compose;
    let hostPort = 31100;
    return Object.entries(components).map(([name, over]) => {
      hostPort += 1;
      return {
        ...template, name, ports: [hostPort], containerPorts: [443], ...over,
      };
    });
  };

  /** A real FluxAppSpecV8 with the named components. */
  const v8App = (appName, components) => v8Spec({ name: appName, compose: v8Compose(components) });

  /**
   * The persistent-storage shapes the sync modes are declared through. The legacy
   * `g:`/`r:`/`s:` containerData prefixes parse to exactly these, and
   * hasActiveStandbySyncthing()/requiresSyncBeforeStart()/hasSyncthing() are
   * derived from them — never settable independently on the real component.
   */
  const syncStorage = (mode) => ({
    sizeGb: 5,
    mounts: { '/data': { source: 'data', destination: '/data' } },
    sync: { mode },
  });
  const ACTIVE_STANDBY = { persistentStorage: syncStorage('activeStandby') }; // legacy g:
  const SYNC_FIRST = { persistentStorage: syncStorage('syncFirst') }; // legacy r:
  const PLAIN_SYNC = { persistentStorage: syncStorage('sync') }; // legacy s:
  // sizeGb 0 — no volume is ever created, so DeploymentComponent.isStateless is true
  const STATELESS = { persistentStorage: undefined };

  /**
   * Install an app on this node: the real InstantiatedSpec the row hydrates to,
   * plus the real DeploymentSpec built from it. `identity` is the app-identity
   * segment container identifiers and the docker network are named from — stated,
   * never derived, exactly as DeploymentSpec.fromSpec demands.
   */
  const installApp = async (spec, { identity = null } = {}) => {
    localInst = await instantiatedSpec(spec, { identity });
    localDeployment = flux.DeploymentSpec.fromSpec(spec, appsFolder, { replica: null, identity });
    return localDeployment;
  };

  /**
   * Install a real ENTERPRISE app: the row hydrates to an InstantiatedSpec over a
   * real EncryptedSpecV8, so `isEncrypted` is the class's own answer rather than a
   * flag a fixture set. The deployment is projected from the CLEARTEXT of the same
   * app — exactly what the deployment layer produces once it has decrypted, and the
   * only thing anything downstream is ever allowed to read.
   */
  const installSealedV8App = async (appName, components) => {
    const compose = v8Compose(components);
    localInst = await instantiatedSpec(await sealedV8Spec({ name: appName, compose }));
    localDeployment = flux.DeploymentSpec.fromSpec(
      await v8Spec({ name: appName, compose }), appsFolder, { replica: null },
    );
    return localDeployment;
  };

  /** Nothing installed here. */
  const installNothing = () => { localInst = null; localDeployment = null; };

  beforeEach(async () => {
    await installApp(await v9App('app', { www: {} }));

    stubs = {
      log: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
      appsRepository: {
        // The reconciler resolves an app from the APP-IDENTITY segment its
        // container identifier carries, never from a parsed name. The fixtures
        // are apps whose identity was borrowed from their name (everything
        // registered before identities were minted), so the segment IS the name
        // here — which is exactly the case that must keep working.
        getInstalledAppByIdentity: sinon.stub().callsFake(async () => localInst),
        // Null by default, so every test below drives the fallback that rows
        // predating the identifier index still need. The index path has its own
        // test rather than being the silent default here.
        getInstalledAppByComponentIdentifier: sinon.stub().resolves(null),
        // The identifier index the app fan-out reads first: empty by default, so the
        // fixtures drive the deployment-layer fallback that rows predating it need.
        listComponentIdentifiers: sinon.stub().resolves([]),
        // The by-NAME lookup, which is the only thing an app-level key can be
        // resolved by: an app name is neither a component identifier nor an
        // identity, so a sweep of a minted app answers here or nowhere.
        getInstalledApp: sinon.stub().callsFake(async () => localInst),
        // Nothing else installed by default, so the cross-app dependent fan-out
        // is inert unless a test states requirers.
        listInstalledApps: sinon.stub().resolves([]),
      },
      // Nothing owed by default: the owed-teardown record is what still names an
      // app whose row has been deleted, so its absence is "genuinely not here".
      pendingTeardownStore: {
        teardownForComponent: sinon.stub().resolves(null),
      },
      // Hands back the REAL DeploymentSpec built for the installed app — the same
      // class the real provider projects. Sync mode, restart policy, identifiers,
      // the network name and the dependency graph are all the library's answers,
      // not a fixture's.
      deploymentProvider: {
        buildDeployment: sinon.stub().callsFake(async () => localDeployment),
        // Delegates at call time so per-test failure injection on buildDeployment
        // flows through the plural path the same way the real provider fails.
        get buildDeployments() {
          const single = this.buildDeployment;
          return async (inst) => [await single(inst)];
        },
        // Every assigned identity is installed in these fixtures, so the runtime
        // view delegates to the assigned one. Suites covering an assigned-but-
        // never-installed identity stub this directly.
        get installedDeployments() {
          const single = this.buildDeployment;
          return async (inst) => [await single(inst)];
        },
        // The app-level edge gate resolves its TARGET app through this. Null by
        // default — no dependency app is installed unless a test says so.
        getInstalledDeployment: sinon.stub().resolves(null),
      },
      appVolumeService: { ensureMountSourcesExist: sinon.stub().resolves() },
      volumeService: {
        ensureAppVolumeMounted: sinon.stub().resolves({ mounted: true, alreadyMounted: true }),
        // the heal will not destroy a container whose volume it cannot verify
        verifyAppVolumeMount: sinon.stub().resolves(true),
      },
      dockerService: {
        dockerContainerInspect: sinon.stub().resolves({ State: { Running: false, Status: 'exited', ExitCode: 1 } }),
        // reachability probe used by dockerActual on an inspect failure; resolves => docker up
        dockerListContainers: sinon.stub().resolves([]),
        // final existence re-check before the remove-on-recreate-failure fallback
        // (real getDockerContainer resolves null when the container is absent)
        getDockerContainer: sinon.stub().resolves(null),
        appDockerStart: sinon.stub().resolves(),
        appDockerStop: sinon.stub().resolves(),
        appDockerRestart: sinon.stub().resolves(),
        appDockerKill: sinon.stub().resolves(),
        appDockerForceRemove: sinon.stub().resolves(),
        // Default: a benign, attached container (not detached), so the network-detach
        // heal stays dormant unless a test opts in.
        classifyContainerNetworkAttachment: sinon.stub().returns({
          managed: false, running: false, networkMode: null, attached: false,
        }),
        isContainerDetachedFromNetwork: sinon.stub().returns(false),
        dockerNetworkState: sinon.stub().resolves('exists'),
        // Default: whatever the container recorded is the live network, i.e. no
        // stale binding. Tests that rebuild a network override this.
        dockerNetworkId: sinon.stub().resolves(null),
        getAppIdentifier: (id) => `flux${id}`,
        getAppDockerNameIdentifier: (id) => `/flux${id}`,
        getBaseAppName: (id) => (id.startsWith('flux') ? id.slice(4) : id),
      },
      globalState: {
        appsMonitored: {},
        bootContainerStateSettled: true,
        waitForBootContainerStateSettled: () => Promise.resolve(),
        getAppShutdownPipelineState: sinon.stub().returns(null),
      },
      appInspector: { startAppMonitoring: sinon.stub(), stopAppMonitoring: sinon.stub() },
      appsRuntimeState: {
        isOperatorStopped: sinon.stub().resolves(false),
        isCondemned: sinon.stub().resolves(false),
        restartWaitMs: sinon.stub().resolves(0),
        recordRestart: sinon.stub().resolves(),
        recordExit: sinon.stub().resolves(),
        getState: sinon.stub().resolves(null),
        setEverStarted: sinon.stub().resolves(),
        setSuccessfullyStarted: sinon.stub().resolves(),
        recordRestartGeneration: sinon.stub().resolves(),
        // durable "I removed this container for a network heal" flag + its own ladder
        isNetworkHealRemoval: sinon.stub().resolves(false),
        setNetworkHealRemoval: sinon.stub().resolves(),
        recordNetworkHealAttempt: sinon.stub().resolves(),
        networkHealWaitMs: sinon.stub().resolves(0),
        clearNetworkHeal: sinon.stub().resolves(),
      },
      appQueryService: {
        installedApps: sinon.stub().resolves({ status: 'success', data: [] }),
      },
      containerHealthMonitor: { recreateMissingContainers: sinon.stub().resolves() },
      appDockerNetwork: { ensureAppNetworkPresent: sinon.stub().resolves('net') },
      appNetworkLinker: {
        ensureContainerNetworkMembership: sinon.stub().resolves({ connected: [], disconnected: [], failed: [] }),
        // Default: every declared link resolves to an installed same-owner network.
        // A membership test that drops a link overrides this for a specific name.
        resolveActiveLinkedNetworks: sinon.stub().callsFake(async (owner, names) => (names || []).map((n) => `fluxDockerNetwork_${n}`)),
      },
      relationshipResolver: {
        // The cross-app fan-out reads installed apps' edges through these. Empty
        // by default; the fan-out test states a requirer's edges.
        buildViewsByName: sinon.stub().resolves({ viewsByName: new Map(), complete: true }),
        edgesOf: sinon.stub().returns([]),
      },
      appUninstaller: {
        UninstallStatus,
        uninstallApplication: sinon.stub().resolves({ status: UninstallStatus.REMOVED, reason: null }),
        driveOwedTeardown: sinon.stub().resolves({ status: 'none', attempts: 0 }),
      },
      appTamperingDetectionService: { recordEvent: sinon.stub().resolves(), isNetworkMissingError: () => false },
      dockerOperations: { appDeleteDataInMountPoint: sinon.stub().resolves() },
      serviceHelper: { delay: sinon.stub().resolves() },
      telemetrySinkCache: { setSink: sinon.stub(), extractSink: sinon.stub().returns(null) },
    };

    // the lightweight scheduling seam the engine drives; proxyquired with the same
    // low-level stubs so the queue + engine integrate exactly as in production
    const reconcilerQueue = proxyquire('../../ZelBack/src/services/appMonitoring/reconcilerQueue', {
      '../../lib/log': stubs.log,
      '../utils/globalState': stubs.globalState,
    });

    appReconciler = proxyquire('../../ZelBack/src/services/appMonitoring/appReconciler', {
      './reconcilerQueue': reconcilerQueue,
      '../../lib/log': stubs.log,
      '../dockerService': stubs.dockerService,
      '../utils/globalState': stubs.globalState,
      '../appManagement/appInspector': stubs.appInspector,
      '../appDatabase/appsRepository': stubs.appsRepository,
      '../appRuntime/deploymentProvider': stubs.deploymentProvider,
      '../appLifecycle/appVolumeService': stubs.appVolumeService,
      '../utils/volumeService': stubs.volumeService,
      '../appManagement/appsRuntimeState': stubs.appsRuntimeState,
      '../appQuery/appQueryService': stubs.appQueryService,
      './containerHealthMonitor': stubs.containerHealthMonitor,
      '../appNetwork/appDockerNetwork': stubs.appDockerNetwork,
      '../appLifecycle/appNetworkLinker': stubs.appNetworkLinker,
      '../appLifecycle/relationshipResolver': stubs.relationshipResolver,
      '../appLifecycle/appUninstaller': stubs.appUninstaller,
      '../appLifecycle/pendingTeardownStore': stubs.pendingTeardownStore,
      '../appTamperingDetectionService': stubs.appTamperingDetectionService,
      '../appManagement/dockerOperations': stubs.dockerOperations,
      '../serviceHelper': stubs.serviceHelper,
      '../telemetrySinkCache': stubs.telemetrySinkCache,
      // specLibs is deliberately NOT stubbed: the identifier rule the reconciler
      // takes an identifier apart with is flux-spec's own DeploymentSpec static,
      // and a re-typed copy of it here would be free to disagree with the rule
      // that MINTED the identifiers these tests reconcile.
    });
  });

  afterEach(() => {
    appReconciler.stop(); operationRegistry.clear(); sinon.restore(); meshIdentityDrift.reset();
  });

  // Stub-fidelity guard: a stubbed dockerService method that does not exist on the
  // real module keeps every test green while production throws "not a function"
  // (getDockerContainerOnly survived a rename exactly this way). Function-shaped
  // stubs must map to real exports; the helpers redefined inline (getAppIdentifier
  // etc.) are covered too since they exist on the real module.
  it('dockerService stub mirrors the real module surface (no phantom methods)', () => {
    // eslint-disable-next-line global-require
    const realDockerService = require('../../ZelBack/src/services/dockerService');
    const phantom = Object.keys(stubs.dockerService)
      .filter((key) => typeof realDockerService[key] !== 'function');
    expect(phantom, `stubbed dockerService methods missing from the real module: ${phantom.join(', ')}`).to.deep.equal([]);
  });

  // resolves exactly when its .resolve() is called — lets tests await the real
  // completion signal of an async reconcile instead of guessing with timer ticks
  const deferred = () => {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
  };

  describe('network-membership convergence', () => {
    // linkedApps is not a settable field: the real DeploymentSpec derives it from
    // the app's NETWORK-BEARING dependency edges. A `wants` edge is the one that
    // shares a network without also gating the start.
    const SHARES_NETWORK_WITH_COLLECTOR = { dependencies: { collector: { strength: 'wants', network: true } } };

    it('steady state: converges a running container onto its own + linked networks', async () => {
      await installApp(await v9App('app', { www: {} }, SHARES_NETWORK_WITH_COLLECTOR));
      stubs.dockerService.dockerContainerInspect.resolves({
        State: { Running: true, Status: 'running' },
        NetworkSettings: { Networks: { fluxDockerNetwork_app: {} } },
      });

      await appReconciler.reconcile('www_app');

      // Desired-set validation runs with the CONSUMER's own owner threaded through —
      // the real FluxID off the spec, which is what a same-owner check compares.
      sinon.assert.calledWith(stubs.appNetworkLinker.resolveActiveLinkedNetworks, OWNER, ['collector']);
      sinon.assert.calledOnceWithExactly(
        stubs.appNetworkLinker.ensureContainerNetworkMembership,
        'www_app',
        ['fluxDockerNetwork_app', 'fluxDockerNetwork_collector'],
        ['fluxDockerNetwork_app'],
      );
    });

    it('desires the IDENTITY-named own network, never the app-name spelling', async () => {
      // The regression this pins: an app whose identity was minted installs onto
      // fluxDockerNetwork_<identity>, so a desired set spelled from the app NAME
      // disconnects the container from the only network it is on and attaches it to
      // one that does not exist - the container then cannot start at all.
      await installApp(await v9App('app', { www: {} }), { identity: 'c32de812b2ff' });
      stubs.appNetworkLinker.resolveActiveLinkedNetworks.resolves([]);
      stubs.dockerService.dockerContainerInspect.resolves({
        State: { Running: true, Status: 'running' },
        NetworkSettings: { Networks: { fluxDockerNetwork_c32de812b2ff: {} } },
      });

      await appReconciler.reconcile('www_c32de812b2ff');

      sinon.assert.calledOnceWithExactly(
        stubs.appNetworkLinker.ensureContainerNetworkMembership,
        'www_c32de812b2ff',
        ['fluxDockerNetwork_c32de812b2ff'],
        ['fluxDockerNetwork_c32de812b2ff'],
      );
    });

    it('wires memberships BEFORE starting a created/stopped container', async () => {
      await installApp(await v9App('app', { www: {} }, SHARES_NETWORK_WITH_COLLECTOR));
      stubs.dockerService.dockerContainerInspect.resolves({
        State: { Running: false, Status: 'created' },
        NetworkSettings: { Networks: { fluxDockerNetwork_app: {} } },
      });

      await appReconciler.reconcile('www_app');

      sinon.assert.calledOnce(stubs.appNetworkLinker.ensureContainerNetworkMembership);
      sinon.assert.calledOnce(stubs.dockerService.appDockerStart);
      sinon.assert.callOrder(stubs.appNetworkLinker.ensureContainerNetworkMembership, stubs.dockerService.appDockerStart);
    });

    it('a failed membership change never blocks the start - it paces a retry instead', async () => {
      await installApp(await v9App('app', { www: {} }, SHARES_NETWORK_WITH_COLLECTOR));
      stubs.appNetworkLinker.ensureContainerNetworkMembership.resolves({ connected: [], disconnected: [], failed: ['fluxDockerNetwork_collector'] });
      stubs.dockerService.dockerContainerInspect.resolves({
        State: { Running: false, Status: 'created' },
        NetworkSettings: { Networks: { fluxDockerNetwork_app: {} } },
      });

      await appReconciler.reconcile('www_app');

      sinon.assert.calledOnce(stubs.dockerService.appDockerStart);
    });
  });

  describe('the app network as a precondition of running anything', () => {
    it('ensures the network before starting a container that already exists', async () => {
      // The gap this closes: a container stuck `created`/`exited` whose network
      // was pruned has exists=true, so it never reaches a recreate path. It is
      // started, the start fails "network not found", and it backs off forever.
      stubs.dockerService.dockerContainerInspect.resolves({
        State: { Running: false, Status: 'created' },
        NetworkSettings: { Networks: { fluxDockerNetwork_app: {} } },
      });

      await appReconciler.reconcile('www_app');

      // The network is named from the component, not spelled from the app name:
      // a real DeploymentComponent carries networkName, so the ensure is given the
      // identity-named network the container actually joins.
      sinon.assert.calledOnceWithExactly(stubs.appDockerNetwork.ensureAppNetworkPresent, 'app', 'fluxDockerNetwork_app');
      sinon.assert.callOrder(stubs.appDockerNetwork.ensureAppNetworkPresent, stubs.dockerService.appDockerStart);
    });

    it('ensures the network before recreating a missing container', async () => {
      stubs.dockerService.dockerContainerInspect.resolves(null);

      await appReconciler.reconcile('www_app');

      sinon.assert.calledOnceWithExactly(stubs.appDockerNetwork.ensureAppNetworkPresent, 'app', 'fluxDockerNetwork_app');
      sinon.assert.callOrder(
        stubs.appDockerNetwork.ensureAppNetworkPresent,
        stubs.containerHealthMonitor.recreateMissingContainers,
      );
    });

    it('does not touch the network for a container that is already running', async () => {
      // Steady state returns above the guarantee; re-checking a demonstrably
      // present network every pass is pure waste.
      stubs.dockerService.dockerContainerInspect.resolves({
        State: { Running: true, Status: 'running', ExitCode: 0 },
        NetworkSettings: { Networks: { fluxDockerNetwork_app: {} } },
      });

      await appReconciler.reconcile('www_app');

      expect(stubs.appDockerNetwork.ensureAppNetworkPresent.called).to.be.false;
    });

    it('does not touch the network when the component should be stopped', async () => {
      stubs.globalState.getAppShutdownPipelineState.returns('stopping');

      await appReconciler.reconcile('www_app');

      expect(stubs.appDockerNetwork.ensureAppNetworkPresent.called).to.be.false;
    });

    // Having the network back is not the same as the container being able to
    // reach it: docker binds to the network's ID, so a same-name rebuild leaves
    // an existing container pointing at one that is gone. Proven on a real
    // daemon - the container keeps the dead id through the rebuild and every
    // start fails "network not found" forever.
    const boundTo = (networkId, status = 'exited') => ({
      State: { Running: false, Status: status, ExitCode: 1 },
      HostConfig: { NetworkMode: 'fluxDockerNetwork_app' },
      NetworkSettings: { Networks: { fluxDockerNetwork_app: { NetworkID: networkId } } },
    });

    it('recreates a container bound to a network id that no longer exists', async () => {
      stubs.dockerService.dockerContainerInspect.resolves(boundTo('deadnetworkid'));
      stubs.dockerService.dockerNetworkId.resolves('livenetworkid');

      await appReconciler.reconcile('www_app');

      expect(stubs.dockerService.appDockerStart.called, 'starting it can only fail - it must be rebuilt').to.be.false;
      expect(stubs.dockerService.appDockerForceRemove.called, 'removed so the recreate can bind it to the live network').to.be.true;
      expect(stubs.appsRuntimeState.setNetworkHealRemoval.calledWith('www_app', true), 'durably marked ours, so the absence is never read as tampering').to.be.true;
    });

    it('starts normally when the container is bound to the live network', async () => {
      stubs.dockerService.dockerContainerInspect.resolves(boundTo('livenetworkid'));
      stubs.dockerService.dockerNetworkId.resolves('livenetworkid');

      await appReconciler.reconcile('www_app');

      expect(stubs.dockerService.appDockerForceRemove.called, 'a healthy binding is not rebuilt').to.be.false;
      sinon.assert.calledOnce(stubs.dockerService.appDockerStart);
    });

    it('destroys nothing when the live network id cannot be read', async () => {
      // This ends in a force-remove, so "cannot tell" must never read as
      // "mismatched".
      stubs.dockerService.dockerContainerInspect.resolves(boundTo('somenetworkid'));
      stubs.dockerService.dockerNetworkId.resolves(null);

      await appReconciler.reconcile('www_app');

      expect(stubs.dockerService.appDockerForceRemove.called).to.be.false;
    });
  });

  describe('shutdown pipeline holds (LB drain state)', () => {
    it('takes no action on a stopped component while its app is stopping', async () => {
      stubs.globalState.getAppShutdownPipelineState.returns('stopping');
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
    });

    it('does not stop a still-running component while its app is draining', async () => {
      stubs.globalState.getAppShutdownPipelineState.returns('draining');
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
    });

    it('does not restart a running-but-unhealthy component while its app is draining', async () => {
      // the shutdown-pipeline hold (desired:null) must win over the livenessProbe actuator
      stubs.globalState.getAppShutdownPipelineState.returns('draining');
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0, Health: { Status: 'unhealthy' } } });
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerRestart.called).to.be.false;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
    });

    it('restarts the stopped component on the first reconcile after the state clears', async () => {
      stubs.globalState.getAppShutdownPipelineState.returns(null);
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStart.calledWith('www_app')).to.be.true;
    });
  });

  describe('policyAllowsRun', () => {
    it('always restarts under the default policy regardless of exit code', () => {
      expect(appReconciler.policyAllowsRun('always', 0)).to.be.true;
      expect(appReconciler.policyAllowsRun('always', 1)).to.be.true;
    });
    it('onFailure restarts only on non-zero exit', () => {
      expect(appReconciler.policyAllowsRun('onFailure', 0)).to.be.false;
      expect(appReconciler.policyAllowsRun('onFailure', 1)).to.be.true;
      expect(appReconciler.policyAllowsRun('onFailure', null)).to.be.true; // never ran -> initial start
    });
    it('never only allows an initial start, never a restart after an exit', () => {
      expect(appReconciler.policyAllowsRun('never', null)).to.be.true;
      expect(appReconciler.policyAllowsRun('never', 0)).to.be.false;
      expect(appReconciler.policyAllowsRun('never', 5)).to.be.false;
    });
    it('reads the per-component spec field', () => {
      expect(appReconciler.getRestartPolicy({ comp: { restartPolicy: 'onFailure' } })).to.equal('onFailure');
    });

    it('does not restart a completed run-once component (onFailure, exit 0)', async () => {
      await installApp(await v9App('app', { init: { restartPolicy: 'onFailure' } }));
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: false, Status: 'exited', ExitCode: 0 } });
      await appReconciler.reconcile('init_app');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('restarts a failed onFailure component (non-zero exit)', async () => {
      await installApp(await v9App('app', { init: { restartPolicy: 'onFailure' } }));
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: false, Status: 'exited', ExitCode: 1 } });
      await appReconciler.reconcile('init_app');
      expect(stubs.dockerService.appDockerStart.calledOnceWith('init_app')).to.be.true;
    });

    it('never restarts a never-policy component after it has run', async () => {
      await installApp(await v9App('app', { job: { restartPolicy: 'never' } }));
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: false, Status: 'exited', ExitCode: 137 } });
      await appReconciler.reconcile('job_app');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });
  });

  describe('livenessProbe actuator (restart running-but-unhealthy)', () => {
    const runningUnhealthy = { State: { Running: true, Status: 'running', ExitCode: 0, Health: { Status: 'unhealthy' } } };

    it('restarts a running container whose healthcheck reports unhealthy', async () => {
      stubs.dockerService.dockerContainerInspect.resolves(runningUnhealthy);
      await appReconciler.reconcile('www_app');
      expect(stubs.appsRuntimeState.recordRestart.calledOnceWith('www_app')).to.be.true;
      expect(stubs.dockerService.appDockerRestart.calledOnceWith('www_app')).to.be.true;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
    });

    it('paces the unhealthy restart off the running-now ladder, not the death-based one', async () => {
      stubs.dockerService.dockerContainerInspect.resolves(runningUnhealthy);
      await appReconciler.reconcile('www_app');
      const [id, opts] = stubs.appsRuntimeState.restartWaitMs.firstCall.args;
      expect(id).to.equal('www_app');
      expect(opts).to.deep.equal({ runningNow: true });
    });

    it('backs off instead of restarting an unhealthy container during its cooldown', async () => {
      stubs.dockerService.dockerContainerInspect.resolves(runningUnhealthy);
      stubs.appsRuntimeState.restartWaitMs.resolves(30000);
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerRestart.called).to.be.false;
      expect(stubs.appsRuntimeState.recordRestart.called).to.be.false;
    });

    it('leaves a running healthy container alone', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0, Health: { Status: 'healthy' } } });
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerRestart.called).to.be.false;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
    });

    it('leaves a running container in the starting grace period alone', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0, Health: { Status: 'starting' } } });
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerRestart.called).to.be.false;
    });

    it('leaves a running container with no healthcheck alone', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerRestart.called).to.be.false;
    });

    it('retries with the managed delay when the unhealthy restart throws', async () => {
      stubs.dockerService.dockerContainerInspect.resolves(runningUnhealthy);
      stubs.dockerService.appDockerRestart.rejects(new Error('docker busy'));
      await appReconciler.reconcile('www_app'); // must not throw
      const loggedFailure = stubs.log.error.getCalls().some((c) => /failed to restart unhealthy/.test(c.args[0]));
      expect(loggedFailure).to.be.true;
    });
  });

  describe('app-level dependency gating (dependencies edges)', () => {
    const flush = async () => {
      for (let i = 0; i < 6; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setImmediate(resolve); });
      }
    };

    const edge = (over = {}) => ({
      strength: 'requires', after: true, condition: 'started', network: false, onRemove: 'detach', ...over,
    });
    // A real app carrying one dependency edge on `collector`. The edge is declared
    // on the spec and read back off the resolved deployment, so the strength/after/
    // condition vocabulary the gate branches on is the schema's, not a literal's.
    const appWithEdge = async (e) => installApp(
      await v9App('app', { www: {} }, { dependencies: { collector: e } }),
    );
    // The TARGET app's resolved deployment — a real one-container app, driven
    // per-identifier through its own component's identifier.
    let targetDeployment;
    const wwwCreated = { State: { Running: false, Status: 'created', ExitCode: 0 } };
    const running = { State: { Running: true, Status: 'running', ExitCode: 0 } };

    beforeEach(async () => {
      targetDeployment = flux.DeploymentSpec.fromSpec(
        await v9App('collector', { main: {} }), appsFolder, { replica: null },
      );
    });

    it('holds a gated start while the dependency app is not installed here', async () => {
      await appWithEdge(edge());
      stubs.dockerService.dockerContainerInspect.withArgs('www_app').resolves(wwwCreated);
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('holds while the dependency app is not running, starts once it is', async () => {
      await appWithEdge(edge());
      stubs.deploymentProvider.getInstalledDeployment.withArgs('collector').resolves(targetDeployment);
      stubs.dockerService.dockerContainerInspect.withArgs('www_app').resolves(wwwCreated);
      stubs.dockerService.dockerContainerInspect.withArgs('main_collector').resolves({ State: { Running: false, Status: 'exited', ExitCode: 0 } });
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStart.called, 'held while the target app is down').to.be.false;

      stubs.dockerService.dockerContainerInspect.withArgs('main_collector').resolves(running);
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStart.calledWith('www_app'), 'starts once the target app runs').to.be.true;
    });

    it('a healthy condition waits for every probe-bearing container of the target', async () => {
      await appWithEdge(edge({ condition: 'healthy' }));
      stubs.deploymentProvider.getInstalledDeployment.withArgs('collector').resolves(targetDeployment);
      stubs.dockerService.dockerContainerInspect.withArgs('www_app').resolves(wwwCreated);
      stubs.dockerService.dockerContainerInspect.withArgs('main_collector').resolves({ State: { Running: true, Status: 'running', ExitCode: 0, Health: { Status: 'starting' } } });
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStart.called, 'held while the target is only starting').to.be.false;

      stubs.dockerService.dockerContainerInspect.withArgs('main_collector').resolves({ State: { Running: true, Status: 'running', ExitCode: 0, Health: { Status: 'healthy' } } });
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStart.calledWith('www_app'), 'starts once the target reads healthy').to.be.true;
    });

    it('boundTo stops a running requirer while its target is down, leaves it once back', async () => {
      await appWithEdge(edge({ strength: 'boundTo', onRemove: 'cascade' }));
      stubs.deploymentProvider.getInstalledDeployment.withArgs('collector').resolves(targetDeployment);
      stubs.dockerService.dockerContainerInspect.withArgs('www_app').resolves(running);
      stubs.dockerService.dockerContainerInspect.withArgs('main_collector').resolves({ State: { Running: false, Status: 'exited', ExitCode: 1 } });
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStop.calledWith('www_app'), 'a boundTo requirer is stopped while its target is down').to.be.true;

      stubs.dockerService.appDockerStop.resetHistory();
      stubs.dockerService.dockerContainerInspect.withArgs('main_collector').resolves(running);
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStop.called, 'a running requirer with its target back is left alone').to.be.false;
    });

    it('an unordered edge (after: false) never gates a start', async () => {
      // No installed target at all — the presence axis owns that; the running
      // axis only gates where the author asked for ordering.
      await appWithEdge(edge({ after: false }));
      stubs.dockerService.dockerContainerInspect.withArgs('www_app').resolves(wwwCreated);
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStart.calledWith('www_app')).to.be.true;
    });

    it('a container milestone in a dependency app re-enqueues its requirers (cross-app fan-out)', async () => {
      await installApp(await v9App('app', { www: {} }));
      stubs.dockerService.dockerContainerInspect.resolves(running);
      // listInstalledApps hydrates its rows, so the fan-out walks InstantiatedSpecs.
      stubs.appsRepository.listInstalledApps.resolves([
        await instantiatedSpec(await v9App('requirer', { www: {} })),
      ]);
      stubs.relationshipResolver.edgesOf.callsFake((views, nameLower) => (nameLower === 'requirer'
        ? [['app', edge()]] : []));

      await appReconciler.enqueueDependents('www_app');
      await flush();

      // The requirer is held as an APP name, so the fan-out resolves it by name and
      // by the identifier index — never by asking whether a name is an identity.
      const fannedOut = stubs.appsRepository.listComponentIdentifiers.getCalls()
        .some((c) => c.args[0] === 'requirer');
      expect(fannedOut, 'the requirer app was fanned out to its components').to.be.true;
      expect(
        stubs.appsRepository.getInstalledAppByIdentity.getCalls().some((c) => c.args[0] === 'requirer'),
        'an app name must never be looked up as an identity',
      ).to.be.false;
    });
  });

  describe('dependsOn condition gating', () => {
    const flush = async () => {
      for (let i = 0; i < 6; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setImmediate(resolve); });
      }
    };

    // web depends on db; db's container state is driven per-identifier via withArgs.
    // `completed` is only legal against a run-once target and `healthy` only against
    // a probe-bearing one; the schema enforces both pairings, so the target's
    // restartPolicy and livenessProbe below are requirements, not decoration.
    const twoComp = async (condition) => installApp(await v9App('app', {
      db: {
        restartPolicy: condition === 'completed' ? 'never' : 'always',
        livenessProbe: condition === 'healthy' ? { cmd: ['true'] } : null,
      },
      web: { dependsOn: { db: { condition } } },
    }));
    // a fresh (never-started) dependent the reconciler would start once unblocked
    const webCreated = { State: { Running: false, Status: 'created', ExitCode: 0 } };

    it('holds a started-dependent while its target is not running', async () => {
      await twoComp('started');
      stubs.dockerService.dockerContainerInspect.withArgs('web_app').resolves(webCreated);
      stubs.dockerService.dockerContainerInspect.withArgs('db_app').resolves({ State: { Running: false, Status: 'exited', ExitCode: 0 } });
      await appReconciler.reconcile('web_app');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('starts a started-dependent once its target is running', async () => {
      await twoComp('started');
      stubs.dockerService.dockerContainerInspect.withArgs('web_app').resolves(webCreated);
      stubs.dockerService.dockerContainerInspect.withArgs('db_app').resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('web_app');
      expect(stubs.dockerService.appDockerStart.calledWith('web_app')).to.be.true;
    });

    it('holds a healthy-dependent while its target is only starting, starts it once healthy', async () => {
      await twoComp('healthy');
      stubs.dockerService.dockerContainerInspect.withArgs('web_app').resolves(webCreated);
      stubs.dockerService.dockerContainerInspect.withArgs('db_app').resolves({ State: { Running: true, Status: 'running', ExitCode: 0, Health: { Status: 'starting' } } });
      await appReconciler.reconcile('web_app');
      expect(stubs.dockerService.appDockerStart.called, 'held while dep only starting').to.be.false;

      stubs.dockerService.dockerContainerInspect.withArgs('db_app').resolves({ State: { Running: true, Status: 'running', ExitCode: 0, Health: { Status: 'healthy' } } });
      await appReconciler.reconcile('web_app');
      expect(stubs.dockerService.appDockerStart.calledWith('web_app'), 'starts once dep healthy').to.be.true;
    });

    it('holds a completed-dependent until its run-once target exits 0', async () => {
      await twoComp('completed');
      stubs.dockerService.dockerContainerInspect.withArgs('web_app').resolves(webCreated);
      stubs.dockerService.dockerContainerInspect.withArgs('db_app').resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('web_app');
      expect(stubs.dockerService.appDockerStart.called, 'held while target still running').to.be.false;

      stubs.dockerService.dockerContainerInspect.withArgs('db_app').resolves({ State: { Running: false, Status: 'exited', ExitCode: 0 } });
      await appReconciler.reconcile('web_app');
      expect(stubs.dockerService.appDockerStart.calledWith('web_app'), 'starts once target exits 0').to.be.true;
    });

    it('treats a completed dependency as satisfied even after its container is removed (durable exit)', async () => {
      await twoComp('completed');
      stubs.dockerService.dockerContainerInspect.withArgs('web_app').resolves(webCreated);
      // db_app vanished: inspect throws, docker's list (default []) confirms it's gone
      stubs.dockerService.dockerContainerInspect.withArgs('db_app').rejects(new Error('no such container'));
      stubs.appsRuntimeState.getState.withArgs('db_app').resolves({ lastExitCode: 0 });
      await appReconciler.reconcile('web_app');
      expect(stubs.dockerService.appDockerStart.calledWith('web_app')).to.be.true;
    });

    it('does not re-run a completed run-once component whose container has vanished (durable exit)', async () => {
      await installApp(await v9App('app', { job: { restartPolicy: 'never' } }));
      stubs.dockerService.dockerContainerInspect.rejects(new Error('no such container'));
      stubs.dockerService.dockerListContainers.resolves([]); // docker confirms it's gone -> exists:false
      stubs.appsRuntimeState.getState.withArgs('job_app').resolves({ lastExitCode: 0 });
      await appReconciler.reconcile('job_app');
      expect(stubs.dockerService.appDockerStart.called, 'must not re-run a completed run-once container').to.be.false;
      expect(stubs.containerHealthMonitor.recreateMissingContainers.called).to.be.false;
    });

    it('enqueueDependents re-evaluates every dependent of a component', async () => {
      await installApp(await v9App('app', {
        db: {},
        web: { dependsOn: { db: { condition: 'started' } } },
        cache: { dependsOn: { db: { condition: 'started' } } },
      }));
      stubs.dockerService.dockerContainerInspect.withArgs('db_app').resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      stubs.dockerService.dockerContainerInspect.withArgs('web_app').resolves(webCreated);
      stubs.dockerService.dockerContainerInspect.withArgs('cache_app').resolves(webCreated);
      const started = [];
      stubs.dockerService.appDockerStart.callsFake(async (id) => { started.push(id); });

      await appReconciler.enqueueDependents('db_app');
      await flush();
      expect(started).to.have.members(['web_app', 'cache_app']);
    });

    it('does not hold a plain component that has no dependsOn', async () => {
      await installApp(await v9App('app', { solo: {} }));
      stubs.dockerService.dockerContainerInspect.resolves(webCreated);
      await appReconciler.reconcile('solo_app');
      expect(stubs.dockerService.appDockerStart.calledWith('solo_app')).to.be.true;
    });

    // Depending on an active-standby component is how an owner asks to be placed with the
    // active instance: the target runs on the elected node only, so the dependent starts
    // there and nowhere else. On every other node the hold is permanent AND correct — so
    // it must read as a settled decision, not as the wedge that the age-based warning
    // exists to catch. A warning that is usually a false alarm gets skimmed past.
    describe('depending on an active-standby target', () => {
      // The activeStandby sync mode is what the real component answers
      // hasActiveStandbySyncthing() from — it is derived from persistentStorage.sync,
      // never settable on its own.
      const withStandbyDb = async () => installApp(await v9App('app', {
        db: ACTIVE_STANDBY,
        web: { dependsOn: { db: { condition: 'started' } } },
      }));

      const settledFor = (spy, identifier) => spy.getCalls().filter(
        (c) => c.args[0] === 'reconciler:actuated'
          && c.args[1].action === 'settledStopped'
          && c.args[1].identifier === identifier,
      );

      it('holds the dependent on a node where the target is not the elected instance', async () => {
        await withStandbyDb();
        stubs.dockerService.dockerContainerInspect.withArgs('web_app').resolves(webCreated);
        stubs.dockerService.dockerContainerInspect.withArgs('db_app').resolves({ State: { Running: false, Status: 'created', ExitCode: 0 } });

        await appReconciler.reconcile('web_app');

        expect(stubs.dockerService.appDockerStart.called, 'must not start without its database').to.be.false;
        expect(stubs.dockerService.appDockerStop.called, 'a hold leaves the container alone').to.be.false;
      });

      it('reports that hold as a settled decision rather than a stall', async () => {
        await withStandbyDb();
        const publishSpy = sinon.spy(fluxEventBus, 'publish');
        stubs.dockerService.dockerContainerInspect.withArgs('web_app').resolves(webCreated);
        stubs.dockerService.dockerContainerInspect.withArgs('db_app').resolves({ State: { Running: false, Status: 'created', ExitCode: 0 } });

        await appReconciler.reconcile('web_app');
        await appReconciler.reconcile('web_app');
        await appReconciler.reconcile('web_app');

        const stated = settledFor(publishSpy, 'web_app');
        expect(stated, 'announced once, not per pass').to.have.lengthOf(1);
        expect(stated[0].args[1].reason).to.equal('awaitingElectedPeer');
      });

      it('starts the dependent on the elected node, where the target is running', async () => {
        await withStandbyDb();
        stubs.dockerService.dockerContainerInspect.withArgs('web_app').resolves(webCreated);
        stubs.dockerService.dockerContainerInspect.withArgs('db_app').resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });

        await appReconciler.reconcile('web_app');

        expect(stubs.dockerService.appDockerStart.calledWith('web_app')).to.be.true;
      });
    });
  });

  describe('reconcile decisions', () => {
    it('does nothing when the app is not installed locally and nothing is owed', async () => {
      installNothing();
      await appReconciler.reconcile('www_app');
      // it checks the OTHER desired state (gone) before concluding "not installed",
      // and asks by the component's own identifier - the record's key is not
      // derivable from it
      expect(stubs.pendingTeardownStore.teardownForComponent.calledOnceWith('www_app')).to.be.true;
      expect(stubs.appUninstaller.driveOwedTeardown.called, 'no record means nothing is owed').to.be.false;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
    });

    // The new desired state: a row-deleted component that still has an owed teardown is
    // NOT uninstalled - it is mid-removal (desired = gone). The reconciler drives the
    // teardown to completion, and once it converges it does NOT retry.
    it('drives an owed teardown to completion and does not retry once converged (desired = gone)', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
      installNothing();
      stubs.pendingTeardownStore.teardownForComponent.resolves({ key: 'app', name: 'app' });
      stubs.appUninstaller.driveOwedTeardown.resolves({ status: 'removed', attempts: 0 });

      await appReconciler.reconcile('www_app');
      expect(stubs.appUninstaller.driveOwedTeardown.calledOnceWith('app')).to.be.true;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
      clock.tick(60 * 60 * 1000); // an hour: a converged removal must not re-drive
      await new Promise((resolve) => { setImmediate(() => { setImmediate(resolve); }); });
      expect(stubs.appUninstaller.driveOwedTeardown.callCount, 'converged - no retry').to.equal(1);
      clock.restore();
    });

    // A replica-targeted removal keys its own record `<app>_<replica>` so siblings can be
    // torn down independently, and that key is NOT derivable from the component identifier.
    // Driving by an app name matches no record, so the reconciler reads "nothing owed",
    // declares the component gone, and the containers and volume sit there until the next
    // boot re-drives the record.
    it('drives a replica-targeted teardown by the record key, not by the app name', async () => {
      installNothing();
      stubs.pendingTeardownStore.teardownForComponent.resolves({ key: 'app_r1', name: 'app' });
      stubs.appUninstaller.driveOwedTeardown.resolves({ status: 'removed', attempts: 0 });

      await appReconciler.reconcile('www_App_r1');

      expect(stubs.pendingTeardownStore.teardownForComponent.calledOnceWith('www_App_r1')).to.be.true;
      expect(
        stubs.appUninstaller.driveOwedTeardown.calledOnceWith('app_r1'),
        'must drive the replica record by its own key - an app name finds nothing',
      ).to.be.true;
    });

    // A teardown that did not converge in one pass (a survivor, a host-cleanup blip) is
    // re-driven with backoff - the reconciler owns the convergence, so it is never
    // abandoned until the next boot.
    it('retries an owed teardown with backoff when it has not converged (attempt count paces it)', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
      installNothing();
      stubs.pendingTeardownStore.teardownForComponent.resolves({ key: 'app', name: 'app' });
      stubs.appUninstaller.driveOwedTeardown.resolves({ status: 'deferred', attempts: 1 });

      await appReconciler.reconcile('www_app');
      expect(stubs.appUninstaller.driveOwedTeardown.callCount).to.equal(1);
      // attempt 1 -> the 30s rung of the removal ladder; tick past it and it re-drives
      clock.tick(30 * 1000 + 100);
      await new Promise((resolve) => { setImmediate(() => { setImmediate(resolve); }); });
      expect(stubs.appUninstaller.driveOwedTeardown.callCount, 'the reconciler re-drives an owed teardown after the backoff').to.equal(2);
      clock.restore();
    });

    it('fails loud on invalid containerData (sync flag on a non-primary mount): no start/stop, no throw', async () => {
      // '/data|g:/...' puts the sync flag on a non-primary mount -> unparseable per the
      // mount model (real prod shape: roundcube). The reconciler must not attempt a start
      // (volume construction would throw) and must surface it, not silently loop "not ready".
      //
      // The spec itself validates — the refusal comes from the deployment projection,
      // which is where the mount model lives. So the build here is the REAL one: it
      // throws flux-spec's own error over a CLEARTEXT row, which is exactly the
      // structural (never-retryable) shape this branch classifies.
      const badSpec = await v8App('app', { www: { containerData: '/data|g:/var/roundcube/db' } });
      localInst = await instantiatedSpec(badSpec);
      localDeployment = null;
      stubs.deploymentProvider.buildDeployment.callsFake(
        async () => flux.DeploymentSpec.fromSpec(badSpec, appsFolder, { replica: null }),
      );
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
      const failedLoud = stubs.log.error.getCalls().some((c) => /invalid containerData/.test(c.args[0]));
      expect(failedLoud, 'should log the invalid-spec error (fail loud), not silently loop').to.equal(true);
    });

    it('defers (does not drop) the reconcile when the local spec read fails transiently', async () => {
      // a momentary DB read failure must not be mistaken for "not installed" - the
      // reconcile defers and retries rather than silently dropping the recovery
      stubs.appsRepository.getInstalledAppByIdentity.rejects(new Error('connection reset'));
      await appReconciler.reconcile('www_app'); // must not throw
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
      const deferred = stubs.log.warn.getCalls().some((c) => /identity read failed, deferring/.test(c.args[0]));
      expect(deferred, 'should log the transient defer, not silently no-op as not-installed').to.equal(true);
    });

    it('stops a running container the operator has stopped', async () => {
      stubs.appsRuntimeState.isOperatorStopped.resolves(true);
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStop.calledOnceWith('www_app')).to.be.true;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('leaves an operator-stopped container alone if already stopped', async () => {
      stubs.appsRuntimeState.isOperatorStopped.resolves(true);
      await appReconciler.reconcile('www_app'); // inspect default: stopped
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    const settledStops = (spy, identifier) => spy.getCalls().filter(
      (c) => c.args[0] === 'reconciler:actuated'
        && c.args[1].action === 'settledStopped'
        && c.args[1].identifier === identifier,
    );

    it('states why a component is down once, not on every pass', async () => {
      // A component that is desired stopped AND already stopped had the pass return in
      // silence, every cycle - the reason was computed and discarded. Four customer
      // outages in 2026-07 were diagnosed from log ABSENCE for exactly this shape.
      const publishSpy = sinon.spy(fluxEventBus, 'publish');
      stubs.appsRuntimeState.isOperatorStopped.resolves(true);

      await appReconciler.reconcile('www_app'); // inspect default: stopped
      await appReconciler.reconcile('www_app');
      await appReconciler.reconcile('www_app');

      const stated = settledStops(publishSpy, 'www_app');
      expect(stated).to.have.lengthOf(1);
      expect(stated[0].args[1].reason).to.equal('operatorStopped');
    });

    it('states the new reason when a stopped component stays down for a different one', async () => {
      const publishSpy = sinon.spy(fluxEventBus, 'publish');
      stubs.appsRuntimeState.isOperatorStopped.resolves(true);
      await appReconciler.reconcile('www_app');

      // the operator lock lifts but the component is condemned - still down, different why
      stubs.appsRuntimeState.isOperatorStopped.resolves(false);
      stubs.appsRuntimeState.isCondemned.resolves(true);
      await appReconciler.reconcile('www_app');

      expect(settledStops(publishSpy, 'www_app').map((c) => c.args[1].reason)).to.eql(['operatorStopped', 'condemned']);
    });

    it('gracefully stops a running condemned container and never starts it (tombstoning)', async () => {
      stubs.appsRuntimeState.isCondemned.resolves(true);
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStop.calledOnceWith('www_app')).to.be.true;
      expect(stubs.dockerService.appDockerKill.called).to.be.false;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('leaves an already-stopped condemned container alone (no re-stop)', async () => {
      stubs.appsRuntimeState.isCondemned.resolves(true);
      await appReconciler.reconcile('www_app'); // inspect default: stopped
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    // A stop that hits an in-flight start ('actuating') must defer + retry, never strand
    // the container running: a bare throw would be logged by the queue WITHOUT rescheduling.
    it('defers (retries) when a desired-stopped stop hits an in-flight start', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
      stubs.appsRuntimeState.isCondemned.resolves(true);
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      const held = new Error("fluxwww_app: an 'actuating' container transition is in flight; deferring 'stopping'");
      held.code = 'ETRANSITIONHELD';
      stubs.dockerService.appDockerStop.rejects(held);

      await appReconciler.reconcile('www_app'); // must not throw (the queue would not reschedule a bare throw)

      expect(stubs.dockerService.appDockerStop.callCount).to.equal(1);
      clock.tick(6000);
      await new Promise((resolve) => { setImmediate(() => { setImmediate(resolve); }); });
      expect(stubs.dockerService.appDockerStop.callCount, 'a deferred stop must retry once the start clears').to.equal(2);
      clock.restore();
    });

    it('condemned wins over the operator lock and stays graceful (operatorStopForce must not leak to a condemn)', async () => {
      stubs.appsRuntimeState.isCondemned.resolves(true);
      stubs.appsRuntimeState.isOperatorStopped.resolves(true);
      // operator force is set, but the reason is 'condemned' so only condemnedForce applies
      stubs.appsRuntimeState.getState.resolves({ operatorStopForce: true });
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStop.calledOnceWith('www_app')).to.be.true;
      expect(stubs.dockerService.appDockerKill.called).to.be.false;
    });

    it('force-kills a condemned-with-force container (operator hard-cancel)', async () => {
      stubs.appsRuntimeState.isCondemned.resolves(true);
      stubs.appsRuntimeState.getState.resolves({ condemnedForce: true });
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerKill.calledOnceWith('www_app')).to.be.true;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
    });

    it('skips the data-clear wipe for a condemned component (never races the teardown rm -rf)', async () => {
      stubs.appsRuntimeState.isCondemned.resolves(true);
      appReconciler.requestStopAndClearData('www_app', 'test'); // dataDesired = 'clear'
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerOperations.appDeleteDataInMountPoint.called).to.be.false;
      // still stopped (condemned desired:false), just not wiped (calledWith, not
      // calledOnce: requestStopAndClearData also enqueues a reconcile)
      expect(stubs.dockerService.appDockerStop.calledWith('www_app')).to.be.true;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('aborts the start when condemned lands mid-reconcile (actuation-time re-read)', async () => {
      // not condemned at the entry gate, but condemned by the time we re-read at actuation
      stubs.appsRuntimeState.isCondemned.onCall(0).resolves(false);
      stubs.appsRuntimeState.isCondemned.onCall(1).resolves(true);
      await appReconciler.reconcile('www_app'); // a stopped component that would otherwise start
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('starts a stopped plain component that should run (default always policy) without seeding the crash ladder', async () => {
      // getState resolves null by default — a first start, which is not a restart, so it
      // must not record: seeding the history would push the container's first crash-recovery
      // off the immediate rung onto the 30s rung.
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStart.calledOnceWith('www_app')).to.be.true;
      expect(stubs.appInspector.startAppMonitoring.calledOnce).to.be.true;
      expect(stubs.appsRuntimeState.recordRestart.called, 'a clean first start does not seed the crash-backoff ladder').to.be.false;
      // deploymentProvider stays stubbed, so nothing here exercises what the real one
      // does with the row it is handed. Read it back and ask it what the real provider
      // asks: resolveInstantiatedSpec branches on isEncrypted and takes `.spec`, then
      // DeploymentSpec.fromSpec projects that spec's own linkedAppNames/dependencyEntries.
      const [handedRow] = stubs.deploymentProvider.buildDeployment.firstCall.args;
      expect(handedRow.name).to.equal('app');
      expect(handedRow.isEncrypted).to.equal(false);
      assertAnswers(handedRow.spec, ['linkedAppNames', 'dependencyEntries']);
    });

    it('marks hasEverStarted on a first start — docker accepting the start is NOT a proven run', async () => {
      // getState resolves null by default — never started here, so this is a first start.
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStart.calledOnceWith('www_app')).to.be.true;
      expect(stubs.appsRuntimeState.setEverStarted.calledOnceWith('www_app')).to.be.true;
      expect(stubs.appsRuntimeState.setSuccessfullyStarted.called, 'start-accept must not latch the proven-run marker').to.be.false;
    });

    it('does not re-mark hasEverStarted when restarting a component docker has launched here before', async () => {
      stubs.appsRuntimeState.getState.withArgs('www_app').resolves({ hasEverStarted: true });
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStart.calledOnceWith('www_app')).to.be.true;
      expect(stubs.appsRuntimeState.setEverStarted.called).to.be.false;
    });

    it('records a restart when starting a stopped component that has run here before (crash-ladder paces repeated crashes)', async () => {
      // hasEverStarted true → this start IS a restart (the container ran, crashed,
      // and is being brought back), so it seeds the ladder that paces repeated crashes.
      stubs.appsRuntimeState.getState.withArgs('www_app').resolves({ hasEverStarted: true });
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStart.calledOnceWith('www_app')).to.be.true;
      expect(stubs.appsRuntimeState.recordRestart.calledOnceWith('www_app')).to.be.true;
    });

    it('treats a pre-marker-split proven doc as already-started (proven implies started)', async () => {
      // docs persisted before the hasEverStarted split carry only hasSuccessfullyStarted;
      // such a component must restart (recording into the ladder), not "first start".
      stubs.appsRuntimeState.getState.withArgs('www_app').resolves({ hasSuccessfullyStarted: true });
      await appReconciler.reconcile('www_app');
      expect(stubs.appsRuntimeState.recordRestart.calledOnceWith('www_app')).to.be.true;
      expect(stubs.appsRuntimeState.setEverStarted.called).to.be.false;
    });

    it('awaitConvergence resolves settled once a converging PROVEN component reconciles to running', async () => {
      // awaitConvergence registers a waiter, enqueues, and blocks until the reconcile
      // settles the component. A proven component settles on the start itself; an
      // unproven one holds the converge open through the first-run proof (see the
      // install-trial describe).
      stubs.appsRuntimeState.getState.withArgs('www_app').resolves({ hasSuccessfullyStarted: true });
      const result = await appReconciler.awaitConvergence(['www_app']);
      expect(stubs.dockerService.appDockerStart.calledWith('www_app')).to.be.true;
      expect(result.converged).to.be.true;
      expect(result.failed).to.deep.equal([]);
    });

  });

  describe('install trial (first-run proof + bounded attempts)', () => {
    // In-memory runtime-state fake mirroring the real semantics the trial reads:
    // recordRestart appends history, the setters latch markers. Timestamps land in
    // the past so trial pacing never delays a test pass.
    let rtState;
    const wireRuntimeStateFake = () => {
      rtState = {};
      stubs.appsRuntimeState.getState.callsFake(async (id) => rtState[id] ?? null);
      stubs.appsRuntimeState.recordRestart.callsFake(async (id) => {
        rtState[id] = rtState[id] ?? {};
        rtState[id].restartHistory = [...(rtState[id].restartHistory ?? []), Date.now() - 60000];
      });
      stubs.appsRuntimeState.setEverStarted.callsFake(async (id) => {
        rtState[id] = { ...(rtState[id] ?? {}), hasEverStarted: true };
      });
      stubs.appsRuntimeState.setSuccessfullyStarted.callsFake(async (id) => {
        rtState[id] = { ...(rtState[id] ?? {}), hasSuccessfullyStarted: true };
      });
    };

    const waitFor = async (cond, timeoutMs = 1500) => {
      const until = Date.now() + timeoutMs;
      while (!cond()) {
        if (Date.now() > until) throw new Error('waitFor timed out');
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setTimeout(resolve, 10); });
      }
    };

    it('a starts-then-dies loop fails the converge after 3 total starts (die path)', async () => {
      wireRuntimeStateFake();
      // dead container, old death evidence: trial pacing never delays
      stubs.dockerService.dockerContainerInspect.resolves({
        State: {
          Running: false, Status: 'exited', ExitCode: 127, FinishedAt: new Date(Date.now() - 60000).toISOString(),
        },
      });
      const convergePromise = appReconciler.awaitConvergence(['www_app']);
      // each start "succeeds", then the container is found dead again; the enqueues
      // stand in for the die-event bridge
      await waitFor(() => stubs.appsRuntimeState.setEverStarted.callCount >= 1);
      appReconciler.enqueueComponent('www_app');
      await waitFor(() => stubs.appsRuntimeState.recordRestart.callCount >= 1);
      appReconciler.enqueueComponent('www_app');
      await waitFor(() => stubs.appsRuntimeState.recordRestart.callCount >= 2);
      appReconciler.enqueueComponent('www_app');
      const result = await convergePromise;
      expect(result.converged).to.be.false;
      expect(result.failed).to.deep.equal(['www_app']);
      expect(stubs.dockerService.appDockerStart.callCount, 'exactly 3 total start attempts').to.equal(3);
    });

    it('a start-refused loop fails the converge after 3 attempts (throw path)', async () => {
      wireRuntimeStateFake();
      stubs.dockerService.appDockerStart.rejects(new Error('oci runtime error: exec not found'));
      // 'created': docker never ran it, so exitCode is null (no clean-exit latch)
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: false, Status: 'created', ExitCode: 0 } });
      const convergePromise = appReconciler.awaitConvergence(['www_app']);
      await waitFor(() => stubs.appsRuntimeState.recordRestart.callCount >= 1);
      appReconciler.enqueueComponent('www_app');
      await waitFor(() => stubs.appsRuntimeState.recordRestart.callCount >= 2);
      appReconciler.enqueueComponent('www_app');
      const result = await convergePromise;
      expect(result.converged).to.be.false;
      expect(result.failed).to.deep.equal(['www_app']);
      expect(stubs.dockerService.appDockerStart.callCount, 'exactly 3 total start attempts').to.equal(3);
    });

    it('a proven component crashing repeatedly never fails the converge (the ladder owns it)', async () => {
      wireRuntimeStateFake();
      rtState.www_app = { hasSuccessfullyStarted: true, restartHistory: [1, 2, 3, 4, 5] };
      stubs.dockerService.dockerContainerInspect.resolves({
        State: {
          Running: false, Status: 'exited', ExitCode: 137, FinishedAt: new Date(Date.now() - 60000).toISOString(),
        },
      });
      const result = await appReconciler.awaitConvergence(['www_app']);
      expect(result.converged, 'a proven app is never rolled back, however deep its history').to.be.true;
      expect(stubs.dockerService.appDockerStart.callCount).to.equal(1);
    });

    it('a clean exit latches the proven-run marker (run-to-completion counts as a run)', async () => {
      wireRuntimeStateFake();
      stubs.dockerService.dockerContainerInspect.resolves({
        State: {
          Running: false, Status: 'exited', ExitCode: 0, FinishedAt: new Date(Date.now() - 60000).toISOString(),
        },
      });
      await appReconciler.reconcile('www_app');
      expect(rtState.www_app && rtState.www_app.hasSuccessfullyStarted).to.be.true;
    });

    it('probe-healthy latches the proven-run marker on a running unproven component', async () => {
      wireRuntimeStateFake();
      stubs.dockerService.dockerContainerInspect.resolves({
        State: { Running: true, Status: 'running', Health: { Status: 'healthy' } },
      });
      await appReconciler.reconcile('www_app');
      expect(rtState.www_app && rtState.www_app.hasSuccessfullyStarted).to.be.true;
    });

    it('uptime past the proof window latches the proven-run marker (probe-less service)', async () => {
      wireRuntimeStateFake();
      stubs.dockerService.dockerContainerInspect.resolves({
        State: { Running: true, Status: 'running', StartedAt: new Date(Date.now() - 61000).toISOString() },
      });
      await appReconciler.reconcile('www_app');
      expect(rtState.www_app && rtState.www_app.hasSuccessfullyStarted).to.be.true;
    });

    it('a probe-less run younger than the proof window does not latch', async () => {
      wireRuntimeStateFake();
      stubs.dockerService.dockerContainerInspect.resolves({
        State: { Running: true, Status: 'running', StartedAt: new Date(Date.now() - 1000).toISOString() },
      });
      await appReconciler.reconcile('www_app');
      expect(rtState.www_app && rtState.www_app.hasSuccessfullyStarted, 'must not latch on a 1s-old run').to.not.be.true;
    });
  });

  describe('running-state actuation decisions', () => {
    it('hard-kills (not graceful-stops) a running operator-stopped component when force is set', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      stubs.appsRuntimeState.isOperatorStopped.resolves(true);
      stubs.appsRuntimeState.getState.withArgs('www_app').resolves({ operatorStopForce: true });
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerKill.calledOnceWith('www_app')).to.be.true;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
    });

    it('gracefully stops a running operator-stopped component when force is not set', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      stubs.appsRuntimeState.isOperatorStopped.resolves(true);
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStop.calledOnceWith('www_app')).to.be.true;
      expect(stubs.dockerService.appDockerKill.called).to.be.false;
    });

    it('rebuilds a running mesh component whose slot identity drifted (confirmed across two passes)', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await installApp(await v9App('app', { www: STATELESS }));
      const drifts = new Map([['www_app', { component: 'www', is: 'www-aaaa1111', wants: 'www-1' }]]);
      meshIdentityDrift.recordPassDrifts(drifts);
      meshIdentityDrift.recordPassDrifts(drifts);
      await appReconciler.reconcile('www_app');
      // The full network-heal discipline: durably marked ours BEFORE the
      // remove, then the no-uninstall recreate.
      expect(stubs.appsRuntimeState.setNetworkHealRemoval.calledWith('www_app', true)).to.be.true;
      expect(stubs.dockerService.appDockerForceRemove.calledWith('www_app')).to.be.true;
      expect(stubs.containerHealthMonitor.recreateMissingContainers.calledWith('www_app')).to.be.true;
      expect(stubs.appUninstaller.uninstallApplication.called).to.be.false;
    });

    it('a drift seen on only ONE mesh pass rebuilds nothing', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await installApp(await v9App('app', { www: STATELESS }));
      meshIdentityDrift.recordPassDrifts(new Map([['www_app', { component: 'www', is: 'www-aaaa1111', wants: 'www-1' }]]));
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerForceRemove.called).to.be.false;
      expect(stubs.containerHealthMonitor.recreateMissingContainers.called).to.be.false;
    });

    it('bounces a running component when a restart is requested (desired generation > actuated)', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      stubs.appsRuntimeState.getState.withArgs('www_app').resolves({ restartGeneration: 1, actuatedRestartGeneration: 0 });
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerRestart.calledOnceWith('www_app')).to.be.true;
      expect(stubs.appsRuntimeState.recordRestartGeneration.calledOnceWith('www_app', 1)).to.be.true;
    });

    it('does not bounce a running component whose restart generation is already actuated', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      stubs.appsRuntimeState.getState.withArgs('www_app').resolves({ restartGeneration: 2, actuatedRestartGeneration: 2 });
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerRestart.called).to.be.false;
    });

    it('re-seeds the telemetry sink on every successful deployment build', async () => {
      // The boot-time sink rebuild races fluxbenchd's unseal; the reconcile
      // retry path is what converges sink state once decryption is available.
      const sink = { provider: 'datadog', apiKey: 'k' };
      stubs.telemetrySinkCache.extractSink.returns(sink);
      await appReconciler.reconcile('www_app');
      expect(stubs.telemetrySinkCache.setSink.calledWith('app', sink)).to.be.true;
      // telemetrySinkCache stays stubbed, so read back what it was handed and ask it
      // what the real extractSink asks: the deployment's own telemetry projection.
      const [handedDeployment] = stubs.telemetrySinkCache.extractSink.firstCall.args;
      expect(handedDeployment, 'extractSink reads deployment.telemetry').to.have.property('telemetry');
      assertAnswers(handedDeployment, ['componentEntries']);
    });

    it('defers ALL actuation when the data volume cannot be mounted', async () => {
      // the app dir without its volume is an ordinary host dir: a start there
      // writes to the host filesystem instead of the volume - the reconciler
      // must keep the component inert and retry, never actuate
      stubs.volumeService.ensureAppVolumeMounted.resolves({ mounted: false, reason: 'mount_failed: bad superblock' });
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
      expect(stubs.dockerOperations.appDeleteDataInMountPoint.called).to.be.false;
      const deferredLoud = stubs.log.error.getCalls().some((c) => /data volume not mounted/.test(c.args[0]));
      expect(deferredLoud, 'should log the volume defer loudly').to.equal(true);
    });

    it('honors a pending stop even when the data volume cannot be mounted (mount-safety hold)', async () => {
      // a stop takes nothing from the app dir; deferring it left the incident's
      // container running over the gutted volume with the hold unenforceable
      stubs.volumeService.ensureAppVolumeMounted.resolves({ mounted: false, reason: 'volume_file_missing' });
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      try {
        appReconciler.setControllerDesired('www_app', 'stopped', 'mount safety block: unmounted_with_content');
        // setControllerDesired enqueues its own reconcile; wait for it to land
        await new Promise((resolve) => { setTimeout(resolve, 50); });
        expect(stubs.dockerService.appDockerStop.calledWith('www_app')).to.be.true;
        expect(stubs.dockerService.appDockerStart.called).to.be.false;
        expect(stubs.dockerOperations.appDeleteDataInMountPoint.called).to.be.false;
      } finally {
        appReconciler.clearControllerDesired('www_app');
      }
    });

    it('never consults the volume for a stateless component, and starts it', async () => {
      // sizeGb 0 means no volume was ever created, so the mount gate would fail
      // closed forever: the component would never start and every pass would
      // report a tampering event. It has no app dir to write through either, so
      // the hazard the gate exists for cannot arise.
      await installApp(await v9App('app', { www: STATELESS }));
      stubs.volumeService.ensureAppVolumeMounted.resolves({ mounted: false, reason: 'volume_file_missing' });
      await appReconciler.reconcile('www_app');
      expect(stubs.volumeService.ensureAppVolumeMounted.called, 'must not probe a volume that cannot exist').to.be.false;
      expect(stubs.dockerService.appDockerStart.calledOnceWith('www_app')).to.be.true;
    });

    it('records no volume tampering event for a stateless component', async () => {
      await installApp(await v9App('app', { www: STATELESS }));
      stubs.volumeService.ensureAppVolumeMounted.resolves({ mounted: false, reason: 'volume_file_missing' });
      await appReconciler.reconcile('www_app');
      await appReconciler.reconcile('www_app');
      const volumeEvents = stubs.appTamperingDetectionService.recordEvent.getCalls()
        .filter((c) => c.args[1] === 'volume_missing');
      expect(volumeEvents, 'a component with no volume is not a tampered one').to.have.lengthOf(0);
    });

    it('mounts an unmounted volume and proceeds with the start', async () => {
      stubs.volumeService.ensureAppVolumeMounted.resolves({ mounted: true, alreadyMounted: false });
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStart.calledOnceWith('www_app')).to.be.true;
      sinon.assert.callOrder(stubs.volumeService.ensureAppVolumeMounted, stubs.dockerService.appDockerStart);
    });

    it('records a tampering event once (not per retry) when the backing image is missing', async () => {
      stubs.volumeService.ensureAppVolumeMounted.resolves({ mounted: false, reason: 'volume_file_missing' });
      await appReconciler.reconcile('www_app');
      await appReconciler.reconcile('www_app');
      const volumeEvents = stubs.appTamperingDetectionService.recordEvent.getCalls()
        .filter((c) => c.args[1] === 'volume_missing');
      expect(volumeEvents).to.have.lengthOf(1);
      expect(volumeEvents[0].args[0]).to.equal('app');
    });

    it('ensures the volume is mounted before actuating a pending data wipe', async () => {
      appReconciler.requestStopAndClearData('www_app', 'test wipe');
      // requestStopAndClearData enqueues its own reconcile; wait for it to land
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      expect(stubs.dockerOperations.appDeleteDataInMountPoint.calledOnce).to.be.true;
      sinon.assert.callOrder(stubs.volumeService.ensureAppVolumeMounted, stubs.dockerOperations.appDeleteDataInMountPoint);
    });

    it('ensures mount sources exist (recreating any syncthing-cleaned source) before starting', async () => {
      await appReconciler.reconcile('www_app');
      expect(stubs.appVolumeService.ensureMountSourcesExist.calledOnce).to.be.true;
      const [comp] = stubs.appVolumeService.ensureMountSourcesExist.firstCall.args;
      expect(comp.identifier).to.equal('www_app');
      // appVolumeService stays stubbed (it shells out and writes files), so nothing
      // here exercises what it does with the component it was handed. Read the
      // argument back and ask it what the REAL implementation asks: it walks
      // `mounts`, keys the stignore path off `dir`, branches on `sync`, and calls
      // injectedSyncExcludes(). A component that could not answer these would fail
      // in production with the suite still green.
      expect(comp.mounts, 'ensureMountSourcesExist iterates mounts').to.be.an('array');
      expect(comp.dir, 'writeStignore keys the stignore path off dir').to.be.a('string');
      expect(comp.sync, 'writeStignore branches on sync').to.satisfy((s) => s === null || typeof s === 'object');
      assertAnswers(comp, ['injectedSyncExcludes', 'hasSyncthing']);
      // and the ensure must happen before the docker start, or the start could fail on a missing mount
      sinon.assert.callOrder(stubs.appVolumeService.ensureMountSourcesExist, stubs.dockerService.appDockerStart);
    });

    it('does not start (or record a restart) when ensuring mount paths fails', async () => {
      stubs.appVolumeService.ensureMountSourcesExist.rejects(new Error('mkdir failed'));
      let threw = false;
      try {
        await appReconciler.reconcile('www_app');
      } catch (err) {
        threw = true;
        expect(err.message).to.equal('mkdir failed');
      }
      expect(threw).to.be.true;
      expect(stubs.appsRuntimeState.recordRestart.called).to.be.false;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('does nothing when the container is already running', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('recreates a missing container that should run (docker reachable)', async () => {
      // production shape of a genuinely-missing container: dockerContainerInspect
      // resolves null (docker's own container list has no match).
      stubs.dockerService.dockerContainerInspect.resolves(null); // docker's list has no match: confirmed absent
      await appReconciler.reconcile('www_app');
      expect(stubs.appTamperingDetectionService.recordEvent.calledWithMatch('app', 'container_vanished')).to.be.true;
      expect(stubs.containerHealthMonitor.recreateMissingContainers.calledOnceWith('www_app')).to.be.true;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
      // containerHealthMonitor stays stubbed (it builds containers), so read back the
      // installed row it was handed and ask it what the real recreate asks: the app
      // NAME it recreates under, the IDENTITY its containers are named from, and the
      // inner spec, which it re-projects through deploymentProvider.installedDeployments.
      const [, handedRow] = stubs.containerHealthMonitor.recreateMissingContainers.firstCall.args;
      expect(handedRow.name, 'the recreate reads instantiated.name').to.equal('app');
      expect(handedRow.identity ?? handedRow.name, 'and instantiated.identity ?? name').to.equal('app');
      expect(handedRow.isEncrypted, 'resolveInstantiatedSpec branches on isEncrypted').to.equal(false);
      assertAnswers(handedRow.spec, ['linkedAppNames', 'dependencyEntries']);
    });

    it('removes a NEVER-RAN app when recreation fails (fresh-install rollback)', async () => {
      stubs.dockerService.dockerContainerInspect.resolves(null); // docker's list has no match: confirmed absent
      stubs.containerHealthMonitor.recreateMissingContainers.rejects(new Error('boom'));
      // getState defaults to null -> never ran here -> removable
      await appReconciler.reconcile('www_app');
      expect(stubs.appTamperingDetectionService.recordEvent.calledWithMatch('app', 'recreation_failed')).to.be.true;
      expect(stubs.appUninstaller.uninstallApplication.calledOnceWith('app', { broadcastRemoval: true })).to.be.true;
    });

    // §14.5: a component that has run here before must NEVER be destroyed on a
    // failed rebuild (unpullable image, bad update) — it degrades to down + retry,
    // so a broken update can't delete an established app + its data.
    it('keeps a HAS-RUN app down and retries instead of removing it when recreation fails', async () => {
      stubs.dockerService.dockerContainerInspect.resolves(null); // docker's list has no match: confirmed absent
      stubs.containerHealthMonitor.recreateMissingContainers.rejects(new Error('image not found'));
      stubs.appsRuntimeState.getState.resolves({ hasSuccessfullyStarted: true });
      await appReconciler.reconcile('www_app');
      expect(stubs.appUninstaller.uninstallApplication.called, 'must NOT destroy an app that has run here').to.be.false;
      expect(stubs.appsRuntimeState.recordRestart.calledWith('www_app')).to.be.true;
    });

    // A recreate provision against a black-holed registry (dead IP behind a stale
    // DNS cache) hangs rather than refuses. Unbounded, the hung await wedges this
    // component's reconcile single-flight forever - every later trigger coalesces
    // into a pass that never runs. The cap fails the recreate instead.
    it('caps a hung recreate provision - the pass fails the recreate instead of wedging the single-flight', async () => {
      stubs.dockerService.dockerContainerInspect.resolves(null); // docker's list has no match: confirmed absent
      stubs.containerHealthMonitor.recreateMissingContainers.returns(new Promise(() => {})); // black hole
      stubs.appsRuntimeState.getState.resolves({ hasSuccessfullyStarted: true });
      await appReconciler.reconcile('www_app'); // must terminate at the cap, not hang
      expect(stubs.appsRuntimeState.recordRestart.calledWith('www_app'), 'the cap is a recreate failure - the proven app is kept and paced').to.be.true;
      const opts = stubs.containerHealthMonitor.recreateMissingContainers.firstCall.args[2];
      expect(opts.abortSignal, 'the provision must receive the abort signal so the pull ends too').to.be.instanceOf(AbortSignal);
      expect(opts.abortSignal.aborted).to.be.true;
    });

    it('publishes recreateFailedKept when a proven app is kept over a failed rebuild (observable keep-vs-remove)', async () => {
      const publishSpy = sinon.spy(fluxEventBus, 'publish');
      stubs.dockerService.dockerContainerInspect.resolves(null); // docker's list has no match: confirmed absent
      stubs.containerHealthMonitor.recreateMissingContainers.rejects(new Error('image not found'));
      stubs.appsRuntimeState.getState.resolves({ hasSuccessfullyStarted: true });
      await appReconciler.reconcile('www_app');
      expect(publishSpy.calledWithMatch('reconciler:actuated', sinon.match({ identifier: 'www_app', action: 'recreateFailedKept' }))).to.be.true;
    });

    // While the install converge is open, the recreate-failure verdict for a
    // never-proven component belongs to the installer: resolving 'failed' hands it
    // the rollback (teardown + fluxappinstallingerror broadcast). An uninstall
    // issued from the reconcile pass would race the open converge - the row
    // disappears, the next pass no-ops, and onSettled would report 'settled' for
    // an app that was just removed.
    it('hands a never-proven recreate failure to an OPEN converge as a failed install (no direct uninstall)', async () => {
      stubs.dockerService.dockerContainerInspect.resolves(null); // docker's list has no match: confirmed absent
      stubs.containerHealthMonitor.recreateMissingContainers.rejects(new Error('pull failed'));
      // getState defaults to null -> never proven
      const result = await appReconciler.awaitConvergence(['www_app']);
      expect(result.converged).to.be.false;
      expect(result.failed).to.deep.equal(['www_app']);
      expect(stubs.appUninstaller.uninstallApplication.called, 'the installer rollback owns the teardown, not the reconcile pass').to.be.false;
    });

    it('resolves an OPEN converge provisional when the recreate failed on an UNREACHABLE registry (node condition, no rollback)', async () => {
      stubs.dockerService.dockerContainerInspect.resolves(null); // docker's list has no match: confirmed absent
      const unreachable = Object.assign(new Error('dial tcp: connection refused'), { registryErrorClass: 'transient' });
      stubs.containerHealthMonitor.recreateMissingContainers.rejects(unreachable);
      // getState defaults to null -> never proven
      const result = await appReconciler.awaitConvergence(['www_app']);
      expect(result.converged, 'a could-not-ask answer must not draw the rollback verdict').to.be.true;
      expect(result.failed).to.deep.equal([]);
      expect(stubs.appUninstaller.uninstallApplication.called).to.be.false;
    });

    it('does not record a restart when the start finds the container removed mid-pass (out-of-band rm)', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: false, Status: 'exited', ExitCode: 137 } });
      stubs.appsRuntimeState.getState.resolves({ hasEverStarted: true, hasSuccessfullyStarted: true });
      const gone = new Error('Container www_app not found');
      gone.code = 'ENOCONTAINER';
      stubs.dockerService.appDockerStart.rejects(gone);
      await appReconciler.reconcile('www_app');
      expect(stubs.appsRuntimeState.recordRestart.called, 'a removal mid-pass is not a crash - it must never advance the ladder').to.be.false;
    });

    it('retries the reconcile when the post-recreate-failure removal is deferred (busy)', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
      stubs.dockerService.dockerContainerInspect.resolves(null); // docker's list has no match: confirmed absent
      stubs.containerHealthMonitor.recreateMissingContainers.rejects(new Error('boom'));
      // a deferred removal means the app is still there - the reconcile must retry, not assume it's gone
      stubs.appUninstaller.uninstallApplication.resolves({ status: UninstallStatus.DEFERRED, reason: 'busy' });

      await appReconciler.reconcile('www_app');
      expect(stubs.appUninstaller.uninstallApplication.callCount).to.equal(1);

      clock.tick(6000); // past MANAGED_RETRY_MS
      await new Promise((resolve) => { setImmediate(() => { setImmediate(resolve); }); });
      expect(stubs.appUninstaller.uninstallApplication.callCount).to.equal(2);
      clock.restore();
    });

    // "Vanished" requires docker to CONFIRM absence: the reachability probe
    // already fetched the full container list, and if the container appears in
    // it the inspect failure was transient (one-off timeout, dockerd finishing
    // a restart between the two calls). Acting on it would falsely write a
    // container_vanished tamper event and recreate->409->uninstall a healthy
    // app. Defer instead - the next inspect succeeds.
    it('defers when inspect fails but the container appears in the docker list (transient inspect failure)', async () => {
      stubs.dockerService.dockerContainerInspect.rejects(new Error('socket hang up'));
      stubs.dockerService.dockerListContainers.resolves([
        { Names: ['/fluxwww_app'], State: 'running' }, // the "missing" container, alive
        { Names: ['/fluxother_other'], State: 'running' },
      ]);
      await appReconciler.reconcile('www_app');
      expect(stubs.containerHealthMonitor.recreateMissingContainers.called, 'must not recreate an existing container').to.be.false;
      expect(stubs.appTamperingDetectionService.recordEvent.called, 'must not write tamper events on a transient failure').to.be.false;
      expect(stubs.appUninstaller.uninstallApplication.called).to.be.false;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
      const deferred = stubs.log.warn.getCalls().some((c) => /deferring/.test(c.args[0]));
      expect(deferred, 'should defer loudly, not silently drop the reconcile').to.equal(true);
    });

    // Removal must be justified by the state of the world at REMOVAL time, not
    // at classification time: between them sits a whole recreate attempt (image
    // pull - seconds to minutes), during which a redeploy can legitimately
    // create the container (hasOperationLease is only sampled at entry), or
    // our own recreate can fail AFTER creating it (start/network step failed).
    it('does not remove the app when the container exists by the time recreation fails', async () => {
      stubs.dockerService.dockerContainerInspect.resolves(null); // docker's list has no match: confirmed absent
      stubs.containerHealthMonitor.recreateMissingContainers.rejects(new Error('409 Conflict: name already in use'));
      stubs.dockerService.getDockerContainer.resolves({ Id: 'abc123' }); // exists at re-check
      await appReconciler.reconcile('www_app');
      expect(stubs.appUninstaller.uninstallApplication.called, 'must not remove - the container exists').to.be.false;
      const recordedFailure = stubs.appTamperingDetectionService.recordEvent.getCalls()
        .some((c) => c.args[1] === 'recreation_failed');
      expect(recordedFailure, 'a moot recreate failure must not pollute the tamper ledger').to.be.false;
    });

    it('defers (never recreates/uninstalls) when docker is unreachable', async () => {
      // dockerd is down (e.g. restarting): inspect throws AND the reachability
      // probe throws too -> must defer, not mistake it for a vanished container.
      const connErr = new Error('connect ENOENT /var/run/docker.sock');
      connErr.code = 'ENOENT';
      stubs.dockerService.dockerContainerInspect.rejects(connErr);
      stubs.dockerService.dockerListContainers.rejects(connErr); // probe: docker is down
      await appReconciler.reconcile('www_app');
      expect(stubs.containerHealthMonitor.recreateMissingContainers.called).to.be.false;
      expect(stubs.appUninstaller.uninstallApplication.called).to.be.false;
      expect(stubs.appTamperingDetectionService.recordEvent.called).to.be.false;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('does NOT start a g: component until a controller elects it', async () => {
      await installApp(await v9App('app', { db: ACTIVE_STANDBY }));
      await appReconciler.reconcile('db_app'); // controllerDesired unset
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('exposes the controller verdict so the election can see a promotion already in effect', () => {
      expect(appReconciler.getControllerDesired('db_app')).to.equal(undefined);
      appReconciler.setControllerDesired('db_app', 'running', 'masterSlave primary (synced)');
      expect(appReconciler.getControllerDesired('db_app')).to.equal('running');
      appReconciler.clearControllerDesired('db_app');
      expect(appReconciler.getControllerDesired('db_app')).to.equal(undefined);
    });

    it('a same-state controller verdict repeat is a no-op; only a transition re-publishes (decider poll ticks)', () => {
      const publishSpy = sinon.spy(fluxEventBus, 'publish');
      const desiredEvents = () => publishSpy.getCalls().filter((c) => c.args[0] === 'reconciler:desiredChanged').length;

      appReconciler.setControllerDesired('db_app', 'running', 'syncthing syncFirst: ensure-running');
      appReconciler.setControllerDesired('db_app', 'running', 'syncthing syncFirst: ensure-running');
      expect(desiredEvents(), 'the repeat must not re-publish/re-enqueue - a syncing app re-asserts every ~3s').to.equal(1);

      appReconciler.setControllerDesired('db_app', 'stopped', 'decider stop');
      expect(desiredEvents(), 'a genuine transition still publishes').to.equal(2);
    });

    it('starts a g: component once a controller sets it running', async () => {
      await installApp(await v9App('app', { db: ACTIVE_STANDBY }));
      // set desired without triggering the workqueue (boot gate closed -> enqueue held)
      stubs.globalState.bootContainerStateSettled = false;
      appReconciler.setControllerDesired('db_app', 'running', 'test');
      stubs.globalState.bootContainerStateSettled = true;
      await appReconciler.reconcile('db_app');
      expect(stubs.dockerService.appDockerStart.calledOnceWith('db_app')).to.be.true;
    });

    // The controller verdict is sampled at reconcile entry, but the syncthing
    // decider's stop wrapper runs OUTSIDE the reconciler's single-flight: it can
    // flip the verdict and begin a data wipe while this reconcile is awaiting
    // (mount-path recreation, DB reads). The verdict must therefore be re-read at
    // actuation time - starting onto a folder mid-wipe corrupts the fresh sync.
    it('aborts the start when the controller verdict flips to stopped mid-reconcile', async () => {
      await installApp(await v9App('app', { db: ACTIVE_STANDBY }));
      stubs.globalState.bootContainerStateSettled = false;
      appReconciler.setControllerDesired('db_app', 'running', 'test');
      stubs.globalState.bootContainerStateSettled = true;
      // decider stop+wipe lands during the mount-path await
      stubs.appVolumeService.ensureMountSourcesExist.callsFake(async () => {
        appReconciler.setControllerDesired('db_app', 'stopped', 'decider stop+wipe');
      });
      await appReconciler.reconcile('db_app');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('aborts the start when the controller verdict is cleared mid-reconcile (uninstall seam)', async () => {
      await installApp(await v9App('app', { db: ACTIVE_STANDBY }));
      stubs.globalState.bootContainerStateSettled = false;
      appReconciler.setControllerDesired('db_app', 'running', 'test');
      stubs.globalState.bootContainerStateSettled = true;
      stubs.appVolumeService.ensureMountSourcesExist.callsFake(async () => {
        appReconciler.clearControllerDesired('db_app');
      });
      await appReconciler.reconcile('db_app');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('does NOT act on a cleared controller verdict (removal seam wipes it)', async () => {
      // uninstall fires appUninstaller's component-removed seam -> serviceManager
      // wires it to clearControllerDesired: a reinstalled g: component must await a
      // fresh election rather than inherit the pre-uninstall verdict
      await installApp(await v9App('app', { db: ACTIVE_STANDBY }));
      stubs.globalState.bootContainerStateSettled = false;
      appReconciler.setControllerDesired('db_app', 'running', 'test');
      stubs.globalState.bootContainerStateSettled = true;
      appReconciler.clearControllerDesired('db_app');
      await appReconciler.reconcile('db_app');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
    });

    // the actuation half of the masterSlave standby path: the decider sets a running
    // g: component desired-stopped, the reconciler is what actually stops Docker.
    it('stops a running g: component a controller has set stopped (masterSlave standby)', async () => {
      await installApp(await v9App('app', { db: ACTIVE_STANDBY }));
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      stubs.globalState.bootContainerStateSettled = false;
      appReconciler.setControllerDesired('db_app', 'stopped', 'masterSlave standby');
      stubs.globalState.bootContainerStateSettled = true;
      await appReconciler.reconcile('db_app');
      expect(stubs.dockerService.appDockerStop.calledOnceWith('db_app')).to.be.true;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    // controllerDesired is in-memory, so a FluxOS restart wipes it while the
    // container keeps running (Docker is independent of the FluxOS process). With
    // no controller opinion yet the reconciler must leave a running g:/r: container
    // alone - stopping it here would bounce every running syncthing app on every
    // FluxOS restart. The decider re-derives intent within its next cycle.
    it('leaves a running g: component alone when no controller has spoken yet', async () => {
      await installApp(await v9App('app', { db: ACTIVE_STANDBY }));
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('db_app'); // controllerDesired unset
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('leaves a running r: component alone when no controller has spoken yet (FluxOS-restart case)', async () => {
      await installApp(await v9App('app', { web: SYNC_FIRST }));
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('web_app'); // controllerDesired unset
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    // plain sync replicates data but no decider owns its run-state: a stopped
    // s: component must restart like any normal component, with no controller
    // opinion required - holding it would leave a crashed one down forever.
    it('starts a stopped s: component without any controller opinion', async () => {
      await installApp(await v9App('app', { cache: PLAIN_SYNC }));
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: false, Status: 'exited', ExitCode: 137 } });
      await appReconciler.reconcile('cache_app'); // controllerDesired unset
      expect(stubs.dockerService.appDockerStart.calledOnceWith('cache_app')).to.be.true;
    });

    it('leaves a running s: component running (no controller involvement either way)', async () => {
      await installApp(await v9App('app', { cache: PLAIN_SYNC }));
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('cache_app');
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    // the syncthing decider wires its callbacks to the flux-prefixed docker name,
    // while masterSlave/die-events use the bare identifier. The reconciler must
    // canonicalise at its boundary so both forms key the same component: a desired
    // state written under the prefixed id is honoured by a reconcile of the bare id.
    it('keys a controller verdict by the identifier the decider passed', async () => {
      // The deciders pass the bare identifier; this engine stores and reads the
      // verdict under exactly that key. It used to strip a `flux` prefix first,
      // which for a component genuinely named `fluxdb` filed the verdict under
      // `db_app` — another component's key.
      await installApp(await v9App('app', { fluxdb: ACTIVE_STANDBY }));
      stubs.globalState.bootContainerStateSettled = false;
      appReconciler.setControllerDesired('fluxdb_app', 'running', 'syncthing synced');
      stubs.globalState.bootContainerStateSettled = true;
      await appReconciler.reconcile('fluxdb_app');
      expect(stubs.dockerService.appDockerStart.calledOnceWith('fluxdb_app')).to.be.true;
    });

    it('defers while an app-scoped operation holds the parent app lease', async () => {
      // any app-scoped lease on the parent app (here: install) owns the whole app's
      // runtime - a reconcile of any component must not actuate. Per-app, not node-wide.
      operationRegistry.acquire('app', 'install', 'test');
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
    });

    it('does NOT defer when the lease is on a DIFFERENT app (no node-wide freeze)', async () => {
      operationRegistry.acquire('otherapp', 'install', 'test');
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStart.calledOnceWith('www_app')).to.be.true;
    });

    // The backup/restore lease: while the parent app holds a backup/restore lease
    // (keyed on the bare MAIN APP name, exactly as appendBackupTask /
    // appendRestoreTask acquire it), the operation owns the whole app's runtime.
    // A reconcile of ANY component of that app must not actuate - not start,
    // not stop, not recreate - while the lease is held; the next reconcile
    // after release enforces desired state again.
    describe('operation leases', () => {
      // Container-construction operations build or destroy containers, so the
      // reconciler stands down while one runs to avoid racing construction.
      ['install', 'remove', 'redeploy', 'rebuild', 'reconcile'].forEach((type) => {
        it(`defers while a ${type} lease is held on the app`, async () => {
          operationRegistry.acquire('app', type, 'test');
          await appReconciler.reconcile('www_app');
          expect(stubs.dockerService.appDockerStart.called).to.be.false;
          expect(stubs.appsRuntimeState.recordRestart.called).to.be.false;
        });
      });

      // backup/restore do NOT freeze the reconciler — they hold run-state through
      // the transient operationDesired (drive()), so the reconciler keeps actuating.
      // The lease alone must never strand a component.
      ['backup', 'restore'].forEach((type) => {
        it(`keeps actuating while a ${type} lease is held (run-state is held via drive, not the lease)`, async () => {
          operationRegistry.acquire('app', type, 'test');
          await appReconciler.reconcile('www_app'); // stopped, should-run, no operation hold
          expect(stubs.dockerService.appDockerStart.calledOnceWith('www_app')).to.be.true;
        });
      });

      // The real backup/restore protection: once it has DRIVEN the component to a
      // hold, the reconciler keeps it stopped and never recreates a missing
      // container (the desired-false short-circuit runs before the recreate path),
      // so it cannot race the volume work.
      it('holds a driven component stopped and does not recreate it when missing during a backup', async () => {
        operationRegistry.acquire('app', 'backup', 'test');
        stubs.dockerService.dockerContainerInspect.resolves(null); // docker's list has no match: confirmed absent
        await appReconciler.drive(['www_app'], 'stopped');
        expect(stubs.dockerService.appDockerStart.called).to.be.false;
        expect(stubs.containerHealthMonitor.recreateMissingContainers.called).to.be.false;
        expect(stubs.appUninstaller.uninstallApplication.called).to.be.false;
      });

      it('enforces desired state again once a construction lease is released', async () => {
        operationRegistry.acquire('app', 'install', 'test');
        await appReconciler.reconcile('www_app');
        expect(stubs.dockerService.appDockerStart.called).to.be.false; // held

        operationRegistry.release('app'); // lease released
        await appReconciler.reconcile('www_app');
        expect(stubs.dockerService.appDockerStart.calledOnceWith('www_app')).to.be.true;
      });
    });

    it('defers while the component holds a stopping lease (transient stop)', async () => {
      operationRegistry.acquire('fluxwww_app', 'stopping', 'test'); // prefixed docker name, as dockerService acquires it
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('backs off instead of restarting when a wait is pending', async () => {
      stubs.appsRuntimeState.restartWaitMs.resolves(30 * 1000);
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
      expect(stubs.appsRuntimeState.recordRestart.called).to.be.false;
    });

    // No die event fires for a FAILED start (the container never ran), so a start
    // throw that is merely logged leaves the component down until the hourly
    // sweep. The failure must schedule its own retry; pacing is free because the
    // attempt was recorded before the start - the retry walks the ladder.
    it('schedules its own retry when the start fails (not the hourly sweep)', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
      stubs.dockerService.appDockerStart.rejects(new Error('failed to attach network'));

      await appReconciler.reconcile('www_app'); // must not throw

      expect(stubs.dockerService.appDockerStart.callCount).to.equal(1);
      clock.tick(6000); // past the near-term retry
      await new Promise((resolve) => { setImmediate(() => { setImmediate(resolve); }); });
      expect(stubs.dockerService.appDockerStart.callCount).to.equal(2);
      // each attempt was recorded, so the follow-ups pace via the backoff ladder
      expect(stubs.appsRuntimeState.recordRestart.callCount).to.equal(2);
      clock.restore();
    });

    it('arms only the post-start verify glance after a successful start of a proven component — it observes, never re-actuates', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
      stubs.appsRuntimeState.getState.withArgs('www_app').resolves({ hasSuccessfullyStarted: true });

      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStart.callCount).to.equal(1);

      // the container is up (and attached — the benign default) when the verify
      // glance lands: it observes and returns, it never re-actuates
      stubs.dockerService.dockerContainerInspect.resolves({
        State: { Running: true, Status: 'running' },
      });
      clock.tick(60 * 1000);
      await new Promise((resolve) => { setImmediate(() => { setImmediate(resolve); }); });
      expect(stubs.dockerService.appDockerStart.callCount).to.equal(1);
      clock.restore();
    });

    it('schedules exactly the first-run proof pass after a successful start of an unproven component', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });

      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStart.callCount).to.equal(1);

      // the container is up when the proof pass lands: it observes and latches,
      // it never re-actuates
      stubs.dockerService.dockerContainerInspect.resolves({
        State: { Running: true, Status: 'running', StartedAt: new Date(Date.now() - 61000).toISOString() },
      });
      clock.tick(60 * 1000);
      await new Promise((resolve) => { setImmediate(() => { setImmediate(resolve); }); });
      expect(stubs.dockerService.appDockerStart.callCount, 'the proof pass observes, never re-starts').to.equal(1);
      expect(stubs.appsRuntimeState.setSuccessfullyStarted.calledWith('www_app')).to.be.true;
      clock.restore();
    });

    // A deferred start (a stop/kill/remove holds the container's lease — e.g. a teardown)
    // is NOT a failure and NOT an attempt: it must schedule a retry but must NOT record a
    // restart (recording would advance the backoff ladder for a collision that never ran).
    it('defers (retries, records no restart) when the start hits an in-flight transition', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
      const held = new Error("fluxwww_app: a 'removing' container transition is in flight; deferring 'actuating'");
      held.code = 'ETRANSITIONHELD';
      stubs.dockerService.appDockerStart.rejects(held);

      await appReconciler.reconcile('www_app'); // must not throw

      expect(stubs.dockerService.appDockerStart.callCount).to.equal(1);
      expect(stubs.appsRuntimeState.recordRestart.called, 'a deferral is not an attempt — it must not touch the backoff ladder').to.be.false;
      clock.tick(6000); // past the near-term retry
      await new Promise((resolve) => { setImmediate(() => { setImmediate(resolve); }); });
      expect(stubs.dockerService.appDockerStart.callCount, 'a deferred start must retry once the transition clears').to.equal(2);
      expect(stubs.appsRuntimeState.recordRestart.called, 'still no restart recorded across deferrals').to.be.false;
      clock.restore();
    });

    it('hands docker FinishedAt to the backoff decision (true death time even when the die event was missed)', async () => {
      const finishedAt = '2026-06-12T08:00:00.000Z';
      stubs.dockerService.dockerContainerInspect.resolves({
        State: {
          Running: false, Status: 'exited', ExitCode: 1, FinishedAt: finishedAt,
        },
      });
      await appReconciler.reconcile('www_app');
      sinon.assert.calledWithExactly(stubs.appsRuntimeState.restartWaitMs, 'www_app', { lastFinishedAtMs: Date.parse(finishedAt) });
    });

    it('passes no death evidence for a container that never ran (docker zero FinishedAt)', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({
        State: {
          Running: false, Status: 'created', ExitCode: 0, FinishedAt: '0001-01-01T00:00:00Z',
        },
      });
      await appReconciler.reconcile('www_app');
      sinon.assert.calledWithExactly(stubs.appsRuntimeState.restartWaitMs, 'www_app', { lastFinishedAtMs: null });
    });
  });

  // The sync layer's first-run / new-app reset was previously an imperative
  // stop+rm-rf done OUTSIDE the reconciler's single-flight, so a backoff-elapsed
  // start could land in the wipe window and corrupt fresh data (the S1 data-loss
  // race). The wipe is now declared as desired data-state and actuated by the
  // reconciler - the sole container/data actuator - inside the per-key single-
  // flight, which makes start-into-wipe structurally impossible.
  describe('data-clear (sync-layer wipe via the reconciler)', () => {
    // requestStopAndClearData is called with the bare component identifier — the
    // key every desired-state input shares — and the reconciler re-prefixes for the
    // on-disk wipe path, which is a docker-namespaced directory.
    it('wipes local appdata (prefixed path) and does not start, on a clear request', async () => {
      await installApp(await v9App('app', { db: ACTIVE_STANDBY }));
      stubs.globalState.bootContainerStateSettled = false;
      appReconciler.requestStopAndClearData('db_app', 'syncthing first-run');
      stubs.globalState.bootContainerStateSettled = true;
      await appReconciler.reconcile('db_app');
      expect(stubs.dockerOperations.appDeleteDataInMountPoint.calledOnceWith('fluxdb_app')).to.be.true;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    // The structural guarantee: even with a contradictory running verdict, the
    // pending clear is resolved before the run decision in the SAME single-flight,
    // so a start can never race the wipe.
    it('never starts while a clear is pending, even if the controller says running', async () => {
      await installApp(await v9App('app', { db: ACTIVE_STANDBY }));
      stubs.globalState.bootContainerStateSettled = false;
      appReconciler.requestStopAndClearData('db_app', 'syncthing first-run');
      appReconciler.setControllerDesired('fluxdb_app', 'running', 'contrived contradiction');
      stubs.globalState.bootContainerStateSettled = true;
      await appReconciler.reconcile('db_app');
      expect(stubs.dockerOperations.appDeleteDataInMountPoint.called).to.be.true;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('stops a running container before wiping (no rm -rf under a live container)', async () => {
      await installApp(await v9App('app', { db: ACTIVE_STANDBY }));
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      stubs.globalState.bootContainerStateSettled = false;
      appReconciler.requestStopAndClearData('db_app', 'syncthing reset');
      stubs.globalState.bootContainerStateSettled = true;
      await appReconciler.reconcile('db_app');
      expect(stubs.dockerService.appDockerStop.calledWith('db_app')).to.be.true;
      sinon.assert.callOrder(stubs.dockerService.appDockerStop, stubs.dockerOperations.appDeleteDataInMountPoint);
    });

    it('is one-shot: wipes first, then the next reconcile starts once the verdict is running', async () => {
      await installApp(await v9App('app', { db: ACTIVE_STANDBY }));
      stubs.globalState.bootContainerStateSettled = false;
      appReconciler.requestStopAndClearData('db_app', 'syncthing first-run');
      // sync layer has already confirmed a source and elected running; the pending
      // clear must still win the first pass
      appReconciler.setControllerDesired('db_app', 'running', 'syncthing synced');
      stubs.globalState.bootContainerStateSettled = true;

      await appReconciler.reconcile('db_app'); // clear wins -> wipes, no start
      expect(stubs.dockerOperations.appDeleteDataInMountPoint.calledOnce).to.be.true;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;

      await appReconciler.reconcile('db_app'); // flag cleared -> now starts
      expect(stubs.dockerService.appDockerStart.calledOnceWith('db_app')).to.be.true;
      expect(stubs.dockerOperations.appDeleteDataInMountPoint.calledOnce).to.be.true; // no second wipe
    });

    it('keys the clear per-component (clearing one app does not wipe another)', async () => {
      stubs.globalState.bootContainerStateSettled = false;
      appReconciler.requestStopAndClearData('db_app', 'reset db');
      appReconciler.setControllerDesired('web_other', 'running', 'synced');
      stubs.globalState.bootContainerStateSettled = true;
      await installApp(await v9App('other', { web: SYNC_FIRST }));
      await appReconciler.reconcile('web_other');
      expect(stubs.dockerOperations.appDeleteDataInMountPoint.called).to.be.false;
      expect(stubs.dockerService.appDockerStart.calledOnceWith('web_other')).to.be.true;
    });

    // A failed stop/wipe (busy mount, fs error, docker blip) is the one actuation
    // path that otherwise just drops to the hourly sweep (~1h down). It must arm its
    // own quick retry like the start path does.
    it('schedules its own retry when the wipe fails (not the hourly sweep)', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
      await installApp(await v9App('app', { db: ACTIVE_STANDBY }));
      stubs.dockerOperations.appDeleteDataInMountPoint.rejects(new Error('mount busy'));
      stubs.globalState.bootContainerStateSettled = false;
      appReconciler.requestStopAndClearData('db_app', 'syncthing first-run');
      stubs.globalState.bootContainerStateSettled = true;

      await appReconciler.reconcile('db_app'); // must not throw

      expect(stubs.dockerOperations.appDeleteDataInMountPoint.callCount).to.equal(1);
      clock.tick(6000); // past the near-term retry (MANAGED_RETRY_MS)
      await new Promise((resolve) => { setImmediate(() => { setImmediate(resolve); }); });
      expect(stubs.dockerOperations.appDeleteDataInMountPoint.callCount).to.equal(2);
      clock.restore();
    });

    // The data-safety invariant must survive a failed wipe: the clear stays pending so
    // a later reconcile re-runs the (idempotent) wipe and can NEVER start the container
    // on un-wiped data, even when the controller already says running.
    it('keeps the clear pending on a failed wipe — never starts on un-wiped data', async () => {
      await installApp(await v9App('app', { db: ACTIVE_STANDBY }));
      stubs.dockerOperations.appDeleteDataInMountPoint.rejects(new Error('mount busy'));
      stubs.globalState.bootContainerStateSettled = false;
      appReconciler.requestStopAndClearData('db_app', 'syncthing first-run');
      appReconciler.setControllerDesired('fluxdb_app', 'running', 'contrived contradiction');
      stubs.globalState.bootContainerStateSettled = true;

      await appReconciler.reconcile('db_app'); // first attempt: wipe throws, caught

      stubs.dockerOperations.appDeleteDataInMountPoint.resetHistory();
      await appReconciler.reconcile('db_app'); // flag still 'clear' -> re-wipes, no start
      expect(stubs.dockerOperations.appDeleteDataInMountPoint.called).to.be.true;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });
  });

  // The reconciler owns the monitoring lifecycle on BOTH ends: it starts
  // monitoring on the start branch, so it must stop monitoring when it stops a
  // container, or a deliberately-stopped container is left with a polling interval
  // erroring against it every minute.
  describe('monitoring follows run-state', () => {
    it('stops monitoring when it stops a running operator-stopped component', async () => {
      stubs.appsRuntimeState.isOperatorStopped.resolves(true);
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStop.calledOnceWith('www_app')).to.be.true;
      expect(stubs.appInspector.stopAppMonitoring.calledOnceWith('www_app', false)).to.be.true;
    });
  });

  // An in-flight operation (backup/restore) drives a component to a desired
  // run-state THROUGH the reconciler (the sole actuator) via drive(), which sets a
  // transient hold (operationDesired) and awaits convergence — it never calls
  // Docker itself.
  describe('drive (operation run-state hold)', () => {
    it('drives a running component to stopped and resolves converged', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      const result = await appReconciler.drive(['www_app'], 'stopped');
      expect(result.converged).to.be.true;
      expect(stubs.dockerService.appDockerStop.calledOnceWith('www_app')).to.be.true;
      expect(stubs.appInspector.stopAppMonitoring.calledOnceWith('www_app', false)).to.be.true;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('keeps a held component stopped on a later reconcile (transient hold persists)', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: false, Status: 'exited', ExitCode: 0 } });
      await appReconciler.drive(['www_app'], 'stopped');
      stubs.dockerService.appDockerStart.resetHistory();
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('drives a held component back to running once the hold is released', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: false, Status: 'exited', ExitCode: 0 } });
      await appReconciler.drive(['www_app'], 'stopped');
      const result = await appReconciler.drive(['www_app'], 'running');
      expect(result.converged).to.be.true;
      expect(stubs.dockerService.appDockerStart.calledOnceWith('www_app')).to.be.true;
    });

    it('settles a driveRunning to stopped when the operator lock still holds (no churn start)', async () => {
      stubs.appsRuntimeState.isOperatorStopped.resolves(true);
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: false, Status: 'exited', ExitCode: 0 } });
      const result = await appReconciler.drive(['www_app'], 'running');
      expect(result.converged).to.be.true;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });
  });

  describe('component selection and enterprise decryption', () => {
    // The reconciler is per-component: reconcile(<comp>_<app>) must resolve exactly the
    // matching compose entry out of a multi-entry app, so a partial state (one component
    // crashed while siblings run) is enforced on the right component with the right type.
    it('selects the matching entry from a multi-component compose (partial state)', async () => {
      await installApp(await v9App('app', {
        www: {},
        db: ACTIVE_STANDBY, // master/slave - needs a controller
        cache: {}, // plain - always policy
      }));
      // 'cache' is plain -> a stopped one is started (picked 'cache', not 'www' or g: 'db')
      await appReconciler.reconcile('cache_app');
      expect(stubs.dockerService.appDockerStart.calledOnceWith('cache_app')).to.be.true;

      // 'db' is g: -> NOT started without a controller (picked 'db', not plain 'cache'/'www')
      stubs.dockerService.appDockerStart.resetHistory();
      await appReconciler.reconcile('db_app');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
    });

    const installEnterpriseApp = async () => {
      await installSealedV8App('app', { db: { containerData: 'g:/data' } });
      expect(localInst.isEncrypted, 'the fixture must be a genuinely sealed app').to.be.true;
    };

    it('acts on the decrypted spec, not the encrypted one, for an enterprise app', async () => {
      // The stored spec is ciphertext — nothing can read a containerData off it.
      // Only the decrypted view says the component is activeStandby.
      await installEnterpriseApp();
      await appReconciler.reconcile('db_app');
      // treated as g: from the DECRYPTED containerData -> not started without a controller.
      // If it had acted on the encrypted spec it could not have known that at all.
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('defers (does not act on encrypted data) when enterprise decryption fails', async () => {
      // The encrypted branch of getLocalComponentSpec: a build failure over a SEALED
      // app is transient (the enterprise key may not be loaded yet), never structural.
      await installEnterpriseApp();
      // decryption failing (e.g. key not loaded at boot) must defer, not act on ciphertext
      stubs.deploymentProvider.buildDeployment.rejects(new Error('Could not resolve spec for app'));
      await appReconciler.reconcile('db_app'); // must not throw
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
      const deferred = stubs.log.warn.getCalls().some((c) => /spec read failed, deferring/.test(c.args[0]));
      expect(deferred, 'should defer on decrypt failure, never act on still-encrypted data').to.equal(true);
      // The two arms are mutually exclusive in their reporting: only the CLEARTEXT
      // arm declares the spec permanently unactuatable. Asserting its absence is
      // what makes this a test of the encrypted arm rather than of "it did nothing".
      const declaredInvalid = stubs.log.error.getCalls().some((c) => /has invalid containerData/.test(c.args[0]));
      expect(declaredInvalid, 'a sealed app must never be declared structurally invalid').to.equal(false);
    });
  });

  // The sweep contract (v9): enqueueAll enqueues every installed app BY NAME;
  // reconcile expands each app-level id to its component identifiers through the
  // deployment layer (which owns version dispatch + decryption) and reconciles
  // each. An app whose spec can't be resolved (e.g. enterprise decrypt fails)
  // DEFERS at reconcile - never acted on with ciphertext - and one failing app
  // never aborts the sweep for the others. Assertions target that coverage.
  describe('enqueueAll sweep coverage', () => {
    // enqueueAll -> reconcile(app) -> expand -> reconcile(component) -> start is a
    // two-hop chain off immediately-resolving stubs; a handful of macrotask turns
    // deterministically drains it rather than guessing exact tick counts.
    const flush = async () => {
      for (let i = 0; i < 6; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setImmediate(resolve); });
      }
    };

    it('enqueues an app by name and reconciles every component it expands to', async () => {
      await installSealedV8App('entapp', { c1: {}, c2: {} });
      // installedApps answers with SERIALIZED rows (appQueryService maps serialize()
      // over the hydrated specs), so the sweep walks the real wire form.
      stubs.appQueryService.installedApps.resolves({ status: 'success', data: [localInst.serialize()] });

      const started = [];
      stubs.dockerService.appDockerStart.callsFake(async (id) => { started.push(id); });

      await appReconciler.enqueueAll('test');
      await flush();
      // the app id expands through the deployment layer to its component ids,
      // each reconciled to a start
      expect(started).to.have.members(['c1_entapp', 'c2_entapp']);
    });

    it('defers an app whose spec cannot be resolved (decrypt fails) - never acts on ciphertext', async () => {
      await installSealedV8App('entapp', { c1: {} });
      stubs.appQueryService.installedApps.resolves({ status: 'success', data: [localInst.serialize()] });
      // benchd unavailable: building the deployment for the still-encrypted spec throws
      stubs.deploymentProvider.buildDeployment.rejects(new Error('benchd unavailable'));

      await appReconciler.enqueueAll('test');
      await flush();
      // the encrypted app defers at reconcile - no expansion onto, nor actuation of, ciphertext
      expect(stubs.dockerService.appDockerStart.called, 'must never start on an unresolved spec').to.be.false;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
    });

    it('one app failing to resolve does not abort the sweep for the others', async () => {
      // Two real installed apps: one sealed (its decrypt will fail), one cleartext.
      const sealedApp = await instantiatedSpec(await sealedV8Spec({ name: 'entapp' }));
      const plainApp = await instantiatedSpec(await v9App('plain', { www: {} }));
      const plainDeployment = flux.DeploymentSpec.fromSpec(plainApp.spec, appsFolder, { replica: null });
      // the failing app FIRST: a sweep that died on it would never reach plain
      stubs.appQueryService.installedApps.resolves({
        status: 'success', data: [sealedApp.serialize(), plainApp.serialize()],
      });
      const byName = { entapp: sealedApp, plain: plainApp };
      stubs.appsRepository.getInstalledAppByIdentity.callsFake(async (n) => byName[n] ?? null);
      stubs.appsRepository.getInstalledApp.callsFake(async (n) => byName[n] ?? null);
      stubs.deploymentProvider.buildDeployment.callsFake(async (inst) => {
        if (inst.name === 'entapp') throw new Error('benchd unavailable');
        return plainDeployment;
      });

      const started = [];
      stubs.dockerService.appDockerStart.callsFake(async (id) => { started.push(id); });

      await appReconciler.enqueueAll('test');
      await flush();
      expect(started, 'the resolvable app must still reconcile and start').to.include('www_plain');
    });

    // Ownership is a lookup on what the row recorded, not a decomposition of the
    // container's own name — a name states the segment its containers were built
    // from, which stops resembling the app's name once identities are minted.
    it('resolves the app from the recorded identifiers, without taking the name apart', async () => {
      await installApp(await v9App('minted', { www: {} }));
      stubs.appQueryService.installedApps.resolves({ status: 'success', data: [localInst.serialize()] });
      stubs.appsRepository.getInstalledAppByComponentIdentifier.resolves(localInst);

      await appReconciler.enqueueAll('test');
      await flush();

      expect(
        stubs.appsRepository.getInstalledAppByComponentIdentifier.called,
        'the index must be consulted',
      ).to.equal(true);
      expect(
        stubs.appsRepository.getInstalledAppByIdentity.called,
        'a row that answers the index must not also be looked up by a parsed identity',
      ).to.equal(false);
    });

    it('sweeps a single-component (flat) app under its bare app name', async () => {
      // A real v1 spec — the flat form whose single synthesized component IS the app,
      // so its container identifier is the bare name with no component segment.
      await installApp(await v1Spec({ name: 'legacy' }));
      stubs.appQueryService.installedApps.resolves({ status: 'success', data: [localInst.serialize()] });

      const started = [];
      stubs.dockerService.appDockerStart.callsFake(async (id) => { started.push(id); });

      await appReconciler.enqueueAll('test');
      await flush();
      // a flat (v1-3) component identifier IS the bare app name, so reconcile
      // resolves it directly (no expansion stutter)
      expect(started).to.deep.equal(['legacy']);
    });

    // A minted identity is NOT the app's name (a sha256(name‖txid) prefix), so the row
    // answers to neither an identity lookup keyed on the name nor the component-identifier
    // index — only to a name lookup. The stubs above model an app whose identity is its
    // name; this one models what the fleet stores.
    it('sweeps an app whose identity was MINTED, not borrowed from its name', async () => {
      await installApp(await v9App('minted', { www: {} }), { identity: '933b4b9a0af3' });
      const row = localInst;
      stubs.appQueryService.installedApps.resolves({ status: 'success', data: [localInst.serialize()] });
      // What the row actually records for an app installed today.
      stubs.appsRepository.listComponentIdentifiers.callsFake(
        async (name) => (name === 'minted' ? ['www_933b4b9a0af3'] : []),
      );
      // The identity lookup answers an IDENTITY - never a name. This is the fidelity
      // that matters: while it answered to a name too, the sweep looked like it worked.
      stubs.appsRepository.getInstalledAppByIdentity.callsFake(
        async (identity) => (identity === '933b4b9a0af3' ? row : null),
      );
      stubs.appsRepository.getInstalledAppByComponentIdentifier.callsFake(
        async (identifier) => (identifier === 'www_933b4b9a0af3' ? row : null),
      );
      stubs.appsRepository.getInstalledApp.callsFake(
        async (name) => (name === 'minted' ? row : null),
      );

      const started = [];
      stubs.dockerService.appDockerStart.callsFake(async (id) => { started.push(id); });

      await appReconciler.enqueueAll('test');
      await flush();

      expect(started, 'the swept app must reach its components').to.deep.equal(['www_933b4b9a0af3']);
    });
  });

  // The boot-drain gate: the first apprunning broadcast must not race the boot
  // reconciles (a too-early snapshot misses apps whose rows then expire on the
  // sigterm TTL). waitForBootDrainSettled() resolves once every boot-held
  // component has completed ONE reconcile pass (started, backoff-deferred,
  // awaiting-controller, or failed loudly) - NOT "all containers running" - and
  // is capped so a wedged reconcile cannot suppress network presence forever.
  describe('boot drain gate', () => {
    const flush = async () => {
      await new Promise((resolve) => { setImmediate(resolve); });
      await new Promise((resolve) => { setImmediate(resolve); });
    };

    it('opens only after every boot-held reconcile completes one pass', async () => {
      stubs.globalState.bootContainerStateSettled = false;
      let openBootGate;
      stubs.globalState.waitForBootContainerStateSettled = () => new Promise((resolve) => { openBootGate = resolve; });
      let finishInspect;
      stubs.dockerService.dockerContainerInspect = sinon.stub().callsFake(() => new Promise((resolve) => {
        finishInspect = () => resolve({ State: { Running: false, Status: 'exited', ExitCode: 1 } });
      }));

      appReconciler.enqueueComponent('www_app'); // held in bootPending
      const startPromise = appReconciler.start();
      let drainSettled = false;
      appReconciler.waitForBootDrainSettled().then(() => { drainSettled = true; });

      stubs.globalState.bootContainerStateSettled = true;
      openBootGate();
      await startPromise;
      await flush();
      expect(drainSettled, 'gate must hold while a boot reconcile is still in flight').to.be.false;

      finishInspect(); // the held reconcile completes its pass (start path runs on stubs)
      await flush();
      expect(drainSettled, 'gate opens once the drained reconciles complete one pass').to.be.true;
    });

    it('opens after the cap even if a boot reconcile wedges', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
      try {
        stubs.globalState.bootContainerStateSettled = false;
        let openBootGate;
        stubs.globalState.waitForBootContainerStateSettled = () => new Promise((resolve) => { openBootGate = resolve; });
        stubs.dockerService.dockerContainerInspect = sinon.stub().callsFake(() => new Promise(() => {})); // wedged forever

        appReconciler.enqueueComponent('www_app');
        const startPromise = appReconciler.start();
        let drainSettled = false;
        appReconciler.waitForBootDrainSettled().then(() => { drainSettled = true; });

        stubs.globalState.bootContainerStateSettled = true;
        openBootGate();
        await startPromise;
        await flush();
        expect(drainSettled).to.be.false;

        clock.tick(2 * 60 * 1000 + 1); // the cap (~2min) fires
        await flush();
        expect(drainSettled, 'the cap must open the gate despite a wedged reconcile').to.be.true;
      } finally {
        clock.restore();
      }
    });
  });

  describe('workqueue', () => {
    it('enqueue runs a reconcile once the boot gate is open', async () => {
      // startAppMonitoring is the last step of a start-path reconcile
      const done = deferred();
      stubs.appInspector.startAppMonitoring = sinon.stub().callsFake(() => done.resolve());
      appReconciler.enqueueComponent('www_app');
      await done.promise;
      expect(stubs.dockerService.appDockerStart.calledOnceWith('www_app')).to.be.true;
    });

    it('holds enqueues until boot settles, then drains them on start()', async () => {
      let openGate;
      stubs.globalState.bootContainerStateSettled = false;
      stubs.globalState.waitForBootContainerStateSettled = () => new Promise((res) => { openGate = res; });

      appReconciler.enqueueComponent('www_app');
      // enqueue is synchronous while the gate is closed, so this is a real assertion
      expect(stubs.dockerService.dockerContainerInspect.called).to.be.false; // held

      const done = deferred();
      stubs.appInspector.startAppMonitoring = sinon.stub().callsFake(() => done.resolve());
      const startPromise = appReconciler.start();
      stubs.globalState.bootContainerStateSettled = true;
      openGate();
      await startPromise;
      await done.promise; // the drained reconcile actually completed
      expect(stubs.dockerService.dockerContainerInspect.called).to.be.true;
    });

    it('expands an app-level identifier to per-component reconciles (boot recovery, sweep)', async () => {
      // Component identifiers live inside the deployment (sometimes behind
      // encryption), so boot recovery and the hourly sweep can only enqueue
      // the bare app name. The reconciler must fan out, not silently drop it.
      await installApp(await v9App('app', { web: {}, cache: {} }));
      const started = [];
      const done = deferred();
      stubs.dockerService.appDockerStart = sinon.stub().callsFake(async (id) => {
        started.push(id);
        if (started.length === 2) done.resolve();
      });
      appReconciler.enqueueApp('app'); // bare app name - no component identifier matches
      await done.promise;
      expect(started.sort()).to.deep.equal(['cache_app', 'web_app']);
    });

    it('expands the bare name of a component named like its app to the name_name identifier', async () => {
      // 146 live production apps are single-component with the component
      // named after the app; their container identifier is the stutter, so a
      // bare-name enqueue must expand rather than half-match the component.
      await installApp(await v9App('app', { app: {} }));
      const done = deferred();
      stubs.dockerService.appDockerStart = sinon.stub().callsFake(async (id) => done.resolve(id));
      appReconciler.enqueueApp('app');
      expect(await done.promise).to.equal('app_app');
    });

    it('surfaces a component identifier that matches nothing instead of dropping it', async () => {
      const done = deferred();
      stubs.log.error = sinon.stub().callsFake(() => done.resolve());
      appReconciler.enqueueComponent('gone_app'); // component "gone" does not exist
      await done.promise;
      expect(stubs.log.error.firstCall.args[0]).to.include('does not match any component');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('coalesces concurrent enqueues for the same id into a single re-run', async () => {
      const resolvers = [];
      const reachedInspect = [deferred(), deferred()];
      stubs.dockerService.dockerContainerInspect = sinon.stub().callsFake(() => new Promise((res) => {
        resolvers.push(() => res({ State: { Running: true, Status: 'running', ExitCode: 0 } }));
        const d = reachedInspect[resolvers.length - 1];
        if (d) d.resolve();
      }));

      appReconciler.enqueueComponent('www_app'); // reconcile #1 -> blocks at inspect
      await reachedInspect[0].promise;
      expect(resolvers).to.have.lengthOf(1);

      appReconciler.enqueueComponent('www_app'); // in-flight -> mark dirty
      appReconciler.enqueueComponent('www_app'); // still dirty (coalesced, not a separate run)
      resolvers[0](); // finish #1 -> exactly one coalesced re-run
      await reachedInspect[1].promise;
      expect(resolvers).to.have.lengthOf(2); // one re-run, not two
      resolvers[1]();
    });
  });

  describe('graceful stop-but-keep routing to the shutdown coordinator', () => {
    beforeEach(() => {
      // desired=false (condemned) + actual running => the reconciler's stop branch
      stubs.appsRuntimeState.isCondemned.resolves(true);
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
    });

    it('routes a non-force condemned stop through the coordinator and takes no docker action when it owns it', async () => {
      const requestGracefulStop = sinon.stub().resolves(true);
      appReconciler.setRequestGracefulStop(requestGracefulStop);

      await appReconciler.reconcile('www_app');

      expect(requestGracefulStop.calledOnceWith('www_app', 'condemned')).to.equal(true);
      expect(stubs.dockerService.appDockerStop.called).to.equal(false);
      expect(stubs.dockerService.appDockerKill.called).to.equal(false);
    });

    it('falls back to a local appDockerStop when the coordinator declines (non-Arcane)', async () => {
      appReconciler.setRequestGracefulStop(sinon.stub().resolves(false));

      await appReconciler.reconcile('www_app');

      expect(stubs.dockerService.appDockerStop.calledOnceWith('www_app')).to.equal(true);
      expect(stubs.dockerService.appDockerKill.called).to.equal(false);
    });

    it('does a local appDockerStop when no coordinator is wired', async () => {
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerStop.calledOnceWith('www_app')).to.equal(true);
    });

    it('still hard-kills a force-condemned app, never routing to the coordinator', async () => {
      stubs.appsRuntimeState.getState.resolves({ condemnedForce: true });
      const requestGracefulStop = sinon.stub().resolves(true);
      appReconciler.setRequestGracefulStop(requestGracefulStop);

      await appReconciler.reconcile('www_app');

      expect(stubs.dockerService.appDockerKill.calledOnceWith('www_app')).to.equal(true);
      expect(requestGracefulStop.called).to.equal(false);
      expect(stubs.dockerService.appDockerStop.called).to.equal(false);
    });
  });

  describe('network-detach heal', () => {
    // A running container reported as detached from its own docker network (stale
    // libnetwork endpoint). isContainerDetachedFromNetwork is stubbed directly so
    // these tests drive the reconciler's control flow, not the classifier (covered
    // by dockerService tests).
    //
    // A heal needs the detach to (a) survive an in-pass re-inspect and (b) persist
    // for DETACHED_PERSIST_MS of wall-clock. Date is faked so tests can cross that
    // window without waiting; setTimeout is NOT faked, so the reconciler's own
    // scheduleRetry timers never fire and each pass is driven explicitly.
    let clock;

    beforeEach(() => {
      clock = sinon.useFakeTimers({ toFake: ['Date'] });
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      stubs.dockerService.classifyContainerNetworkAttachment.returns({
        managed: true, running: true, networkMode: 'fluxDockerNetwork_app', attached: false,
      });
      stubs.dockerService.isContainerDetachedFromNetwork.returns(true);
      // a successful recreate provisions the container in 'created' state (the flip:
      // installComponent never starts) — reflect that, so the follow-up pass the heal
      // enqueues observes a benign, recreated container instead of re-healing forever
      stubs.containerHealthMonitor.recreateMissingContainers.callsFake(async () => {
        stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: false, Status: 'created' } });
        stubs.dockerService.isContainerDetachedFromNetwork.returns(false);
      });
    });

    afterEach(() => {
      clock.restore();
    });

    // first pass opens the persistence window; the second, past it, may act
    const healPasses = async (id = 'www_app') => {
      await appReconciler.reconcile(id);
      clock.tick(61 * 1000);
      await appReconciler.reconcile(id);
      // let the follow-up pass the heal enqueues after a successful recreate settle
      await new Promise((resolve) => { setImmediate(() => { setImmediate(resolve); }); });
    };

    it('leaves a running, properly-attached container alone and clears any heal state', async () => {
      stubs.dockerService.isContainerDetachedFromNetwork.returns(false);
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerForceRemove.called).to.be.false;
      expect(stubs.containerHealthMonitor.recreateMissingContainers.called).to.be.false;
      expect(stubs.appsRuntimeState.clearNetworkHeal.calledWith('www_app'), 'a healthy container clears the durable heal state').to.be.true;
    });

    it('clears the durable heal state for a container that merely EXISTS, even stopped', async () => {
      // the flag means "absent because I removed it" - once the container is back it
      // is stale, whatever its run state. Leaking it would divert a later, genuine
      // disappearance away from the vanished path forever.
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: false, Status: 'exited', ExitCode: 0 } });
      stubs.dockerService.isContainerDetachedFromNetwork.returns(false);
      stubs.appsRuntimeState.restartWaitMs.resolves(60 * 1000); // stay in backoff, never start

      await appReconciler.reconcile('www_app');

      expect(stubs.appsRuntimeState.clearNetworkHeal.calledWith('www_app')).to.be.true;
    });

    it('confirms in-pass before acting: a detached read that clears on re-inspect destroys nothing', async () => {
      // a pass reads the attachment three times: the stale-state clear, the running
      // branch, then the heal's confirming re-inspect. Detached for the first two,
      // attached on the re-inspect - i.e. the first read was transient.
      stubs.dockerService.isContainerDetachedFromNetwork.onCall(2).returns(false);
      await appReconciler.reconcile('www_app');
      expect(stubs.serviceHelper.delay.called, 'settles before re-reading').to.be.true;
      expect(stubs.dockerService.dockerContainerInspect.callCount, 're-inspects to confirm').to.be.at.least(2);
      expect(stubs.dockerService.appDockerForceRemove.called, 'a transient detached read must never destroy a healthy container').to.be.false;
    });

    it('waits for the detach to persist before destroying anything', async () => {
      await appReconciler.reconcile('www_app'); // confirmed detached, but only just now
      expect(stubs.dockerService.appDockerForceRemove.called, 'a detach seen for the first time is not yet actionable').to.be.false;

      clock.tick(61 * 1000);
      await appReconciler.reconcile('www_app');
      expect(stubs.dockerService.appDockerForceRemove.called, 'a detach that persisted is healed').to.be.true;
    });

    it('heals a persisted detach: durable flag before the remove, monitoring stopped, no volume creation on the recreate, never uninstall', async () => {
      await healPasses();
      expect(
        stubs.appsRuntimeState.setNetworkHealRemoval.calledWith('www_app', true),
        'records the deliberate removal durably',
      ).to.be.true;
      expect(
        stubs.appsRuntimeState.setNetworkHealRemoval.calledBefore(stubs.dockerService.appDockerForceRemove),
        'the flag must be durable BEFORE the container is removed, or a restart in the window reads the absence as tampering',
      ).to.be.true;
      expect(stubs.appInspector.stopAppMonitoring.calledWith('www_app', true), 'stops the stats monitor before removing').to.be.true;
      expect(stubs.dockerService.appDockerForceRemove.calledWith('www_app', false), 'force-removes keeping bind-mounted data').to.be.true;
      expect(
        stubs.containerHealthMonitor.recreateMissingContainers.calledOnceWith(
          'www_app', sinon.match.object, { allowVolumeCreation: false },
        ),
        'the recreate must never be allowed to create (reformat) the data volume',
      ).to.be.true;
      expect(stubs.appUninstaller.uninstallApplication.called, 'the heal must NEVER uninstall the app').to.be.false;
    });

    it('refuses to destroy a container whose data volume cannot be verified', async () => {
      // the recreate refuses volume creation, so an unverifiable volume means it
      // would fail AFTER the container was destroyed
      stubs.volumeService.verifyAppVolumeMount.resolves(false);

      await healPasses();

      expect(stubs.dockerService.appDockerForceRemove.called, 'a container whose volume cannot be verified must be left alone').to.be.false;
      expect(stubs.containerHealthMonitor.recreateMissingContainers.called).to.be.false;
      const blocked = stubs.log.error.getCalls().some((c) => /must NOT be recreated/.test(c.args[0]));
      expect(blocked, 'says loudly why it refused').to.be.true;
    });

    it('aborts the remove if another operation takes a lease during the confirmation', async () => {
      // the operation lease is sampled at reconcile entry, but the heal spends
      // seconds confirming - a redeploy starting in that window must not have its
      // container force-removed underneath it.
      await appReconciler.reconcile('www_app'); // opens the persistence window
      clock.tick(61 * 1000);
      stubs.serviceHelper.delay.callsFake(async () => {
        operationRegistry.acquire('app', 'redeploy', 'test'); // a redeploy starts mid-settle
      });

      await appReconciler.reconcile('www_app');

      expect(stubs.dockerService.appDockerForceRemove.called, 'must not actuate on a container another subsystem owns').to.be.false;
    });

    it('does not rebuild the whole node when many containers look detached at once', async () => {
      // a dockerd restart can serve inspects before libnetwork restores endpoint IPs,
      // and the reconnect sweep enqueues everything at that moment
      await installApp(await v9App('app', { www: {}, api: {}, db: {} }));

      await appReconciler.reconcile('www_app');
      await appReconciler.reconcile('api_app');
      await appReconciler.reconcile('db_app');
      clock.tick(61 * 1000);
      await appReconciler.reconcile('www_app');
      await appReconciler.reconcile('api_app');
      await appReconciler.reconcile('db_app');

      expect(stubs.dockerService.appDockerForceRemove.called, 'a node-wide detach is a docker fault, not N stale endpoints').to.be.false;
      const storm = stubs.log.error.getCalls().some((c) => /docker-level fault/.test(c.args[0]));
      expect(storm, 'says loudly that it refused a node-wide rebuild').to.be.true;
    });

    it('rebuilds a missing network and then heals, instead of waiting for someone to restore it', async () => {
      // This used to park: a remove it could not follow with a recreate would
      // take the container from partially-alive to gone. The network is an owned
      // resource now, so the precondition is something to satisfy, not to wait on.
      stubs.dockerService.dockerNetworkState.resolves('absent');

      await healPasses();

      sinon.assert.calledWith(stubs.appDockerNetwork.ensureAppNetworkPresent, 'app', 'fluxDockerNetwork_app');
      sinon.assert.callOrder(
        stubs.appDockerNetwork.ensureAppNetworkPresent,
        stubs.dockerService.appDockerForceRemove,
      );
      expect(stubs.dockerService.appDockerForceRemove.called, 'the heal proceeds once the network is back').to.be.true;
      const pruned = stubs.appTamperingDetectionService.recordEvent.getCalls().some((c) => c.args[1] === 'network_pruned');
      expect(pruned, 'a network does not vanish on its own - still recorded once').to.be.true;
    });

    it('destroys nothing when the network cannot be rebuilt', async () => {
      stubs.dockerService.dockerNetworkState.resolves('absent');
      stubs.appDockerNetwork.ensureAppNetworkPresent.rejects(new Error('no free subnet'));

      await healPasses();

      expect(stubs.dockerService.appDockerForceRemove.called, 'never remove what still cannot be recreated').to.be.false;
      expect(stubs.containerHealthMonitor.recreateMissingContainers.called).to.be.false;
    });

    it('does not rebuild anything on a detach storm - that is a docker fault, not a missing network', async () => {
      // The storm guard sits ABOVE the network question, so making the network
      // rebuildable must not give a node-wide docker fault a way through.
      await installApp(await v9App('app', { www: {}, api: {}, db: {} }));
      stubs.dockerService.dockerNetworkState.resolves('absent');

      await appReconciler.reconcile('www_app');
      await appReconciler.reconcile('api_app');
      await appReconciler.reconcile('db_app');
      clock.tick(61 * 1000);
      await appReconciler.reconcile('www_app');
      await appReconciler.reconcile('api_app');
      await appReconciler.reconcile('db_app');

      expect(stubs.appDockerNetwork.ensureAppNetworkPresent.called, 'no rebuild while docker itself looks broken').to.be.false;
      expect(stubs.dockerService.appDockerForceRemove.called).to.be.false;
    });

    it('defers (destroys nothing, records nothing) when docker cannot say whether the network exists', async () => {
      stubs.dockerService.dockerNetworkState.resolves('unknown');
      await healPasses();
      expect(stubs.dockerService.appDockerForceRemove.called, 'an unreadable network is not a missing network').to.be.false;
      const pruned = stubs.appTamperingDetectionService.recordEvent.getCalls().some((c) => c.args[1] === 'network_pruned');
      expect(pruned, 'must not record a false network_pruned on a transient docker error').to.be.false;
    });

    it('paces heal attempts on its own durable ladder, not the crash-restart one', async () => {
      stubs.appsRuntimeState.networkHealWaitMs.resolves(30 * 1000); // the heal ladder says: not yet
      await healPasses();
      expect(stubs.dockerService.appDockerForceRemove.called, 'no destructive action while backing off').to.be.false;
      expect(stubs.appsRuntimeState.setNetworkHealRemoval.called).to.be.false;
      expect(
        stubs.appsRuntimeState.recordRestart.called,
        'a heal must not write to the crash ladder: it would hold down the container it just fixed',
      ).to.be.false;
    });

    it('does not remove the container if the heal cannot be recorded durably', async () => {
      // the durable flag is what stops a restart mid-heal from uninstalling the app,
      // and the ladder is what stops the retries hammering - without them, no remove
      stubs.appsRuntimeState.setNetworkHealRemoval.rejects(new Error('db unavailable'));

      await healPasses();

      expect(stubs.dockerService.appDockerForceRemove.called, 'an unrecordable heal must not happen at all').to.be.false;
      const noted = stubs.log.error.getCalls().some((c) => /cannot record the network heal/.test(c.args[0]));
      expect(noted, 'logs and retries rather than throwing out of reconcile').to.be.true;
    });

    it('restores monitoring when the force-remove itself fails', async () => {
      stubs.dockerService.appDockerForceRemove.rejects(new Error('device or resource busy'));
      await healPasses();
      expect(
        stubs.appInspector.startAppMonitoring.calledWith('www_app'),
        'the container is still there: it must not be left unmonitored',
      ).to.be.true;
      expect(stubs.appUninstaller.uninstallApplication.called).to.be.false;
    });

    it('a recreate failure retries, records the diagnostics, and never uninstalls the app', async () => {
      stubs.containerHealthMonitor.recreateMissingContainers.rejects(new Error('host port still in use'));
      await healPasses();
      expect(stubs.dockerService.appDockerForceRemove.called).to.be.true;
      expect(stubs.appUninstaller.uninstallApplication.called, 'a transient recreate failure must not uninstall').to.be.false;
      const failed = stubs.appTamperingDetectionService.recordEvent.getCalls().some((c) => c.args[1] === 'recreation_failed');
      expect(failed, 'a silently looping heal is an invisible outage: record the failure').to.be.true;
    });

    it('keeps retrying a broken heal at a bounded rate: no terminal give-up, no uninstall, one tamper event', async () => {
      stubs.containerHealthMonitor.recreateMissingContainers.rejects(new Error('host port still in use'));
      // the container stays "running" (inspect stub), so each pass re-enters the
      // running-detached branch - as the hourly sweep would drive it
      for (let i = 0; i < 8; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await appReconciler.reconcile('www_app');
        clock.tick(61 * 1000);
      }
      expect(stubs.appUninstaller.uninstallApplication.called, 'never uninstalls, however long it stays broken').to.be.false;
      expect(
        stubs.containerHealthMonitor.recreateMissingContainers.callCount,
        'keeps trying (paced by its ladder) rather than parking in a terminal state',
      ).to.be.at.least(6);
      // the durable tampering signal is recorded once per episode, not per attempt
      const detachedEvents = stubs.appTamperingDetectionService.recordEvent.getCalls().filter((c) => c.args[1] === 'network_detached').length;
      expect(detachedEvents, 'records network_detached once per episode, not per attempt').to.equal(1);
    });

    it('a FluxOS restart mid-heal still recreates: the absence is ours, not tampering', async () => {
      // fresh process: no in-memory heal state, container gone (removed just before
      // the crash), but the durable flag survived
      stubs.appsRuntimeState.isNetworkHealRemoval.resolves(true);
      stubs.dockerService.dockerContainerInspect.rejects(new Error('no such container'));
      stubs.dockerService.dockerListContainers.resolves([]); // docker up, container really absent
      stubs.containerHealthMonitor.recreateMissingContainers.rejects(new Error('host port still in use'));

      await appReconciler.reconcile('www_app');

      const vanished = stubs.appTamperingDetectionService.recordEvent.getCalls().some((c) => c.args[1] === 'container_vanished');
      expect(vanished, 'our own removal must not be recorded as tampering').to.be.false;
      expect(stubs.containerHealthMonitor.recreateMissingContainers.called, 'recreates on the heal path').to.be.true;
      expect(stubs.appUninstaller.uninstallApplication.called, 'a failed recreate must not uninstall the app').to.be.false;
    });

    it('defers instead of guessing when the durable heal flag cannot be read', async () => {
      // guessing "not a heal removal" is the destructive guess: it records a false
      // tampering event and can uninstall the app on a failed recreate
      stubs.appsRuntimeState.isNetworkHealRemoval.rejects(new Error('db unavailable'));
      stubs.dockerService.dockerContainerInspect.rejects(new Error('no such container'));
      stubs.dockerService.dockerListContainers.resolves([]);

      await appReconciler.reconcile('www_app');

      expect(stubs.containerHealthMonitor.recreateMissingContainers.called, 'no recreate on an unreadable state').to.be.false;
      expect(stubs.appUninstaller.uninstallApplication.called, 'and above all, no uninstall').to.be.false;
      const vanished = stubs.appTamperingDetectionService.recordEvent.getCalls().some((c) => c.args[1] === 'container_vanished');
      expect(vanished, 'no false tampering event').to.be.false;
    });

    it('a container that vanished on its own (no heal flag) still takes the vanished path', async () => {
      stubs.appsRuntimeState.isNetworkHealRemoval.resolves(false);
      stubs.dockerService.dockerContainerInspect.rejects(new Error('no such container'));
      stubs.dockerService.dockerListContainers.resolves([]);

      await appReconciler.reconcile('www_app');

      const vanished = stubs.appTamperingDetectionService.recordEvent.getCalls().some((c) => c.args[1] === 'container_vanished');
      expect(vanished, 'a genuine vanish is still a tampering signal').to.be.true;
    });
  });

  describe('post-start attachment verification', () => {
    it('re-checks a container shortly after starting it, instead of waiting for the hourly sweep', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
      try {
        await appReconciler.reconcile('www_app'); // stopped -> start
        expect(stubs.dockerService.appDockerStart.calledOnce).to.be.true;
        const inspectsAfterStart = stubs.dockerService.dockerContainerInspect.callCount;

        clock.tick(30 * 1000); // the post-start verification pass
        await new Promise((resolve) => { setImmediate(() => { setImmediate(resolve); }); });

        expect(
          stubs.dockerService.dockerContainerInspect.callCount,
          'the start is when a container can come up detached, so it must be looked at again',
        ).to.be.above(inspectsAfterStart);
      } finally {
        clock.restore();
      }
    });
  });
});
