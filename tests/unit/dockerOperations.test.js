'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const path = require('node:path');
const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const { asConfig } = require('./fixtures/config');
const {
  loadSpecLibrary, V9_SUBMISSION, v9Spec, instantiatedSpec,
} = require('./fixtures/fluxSpec');

// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. What stays stubbed is I/O and the actuator: the shell-out behind
// serviceHelper.runCommand, docker, mongo, the daemon socket, the reconciler.

// The apps folder the module under test is built with. Every DeploymentSpec in this
// file is built with the SAME folder, so a component's own `dir` and the path the
// production code derives from its identifier cannot drift apart.
const APPS_FOLDER = '/tmp/flux/apps/';

let flux;

/** A real DeploymentSpec, built the way deploymentProvider builds one: the
 * identity is stated, never defaulted, exactly as DeploymentSpec.fromSpec demands. */
function deploymentFor(spec, opts = {}) {
  return flux.DeploymentSpec.fromSpec(spec, APPS_FOLDER, { replica: null, ...opts });
}

/** A real FluxAppSpecV9 whose components are named copies of the fixture's. */
function specWithComponents(appName, components) {
  const built = {};
  for (const [compName, overrides] of Object.entries(components)) {
    built[compName] = { ...V9_SUBMISSION.components.web, name: compName, ...overrides };
  }
  return v9Spec({ name: appName, components: built });
}

describe('dockerOperations tests', () => {
  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30_000);
    flux = await loadSpecLibrary();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('appDeleteDataInMountPoint', () => {
    // The volume directory is there unless a test says otherwise.
    const build = (serviceHelper, log, wipeAppData, stat = sinon.stub().resolves({})) => proxyquire('../../ZelBack/src/services/appManagement/dockerOperations', {
      '../serviceHelper': serviceHelper,
      '../../lib/log': log,
      '../utils/appConstants': { appsFolder: APPS_FOLDER },
      '../utils/appDataEntries': { wipeAppData },
      'node:fs/promises': { stat },
    });

    /**
     * A real DeploymentComponent for a stateful component, plus the appId its
     * SOLE caller passes: appReconciler hands over
     * `dockerService.getAppIdentifier(identifier)`, i.e. the component's real
     * identifier under the platform's `flux` namespace prefix. Passing the bare
     * app name instead — as this test used to — describes a call that is never made.
     */
    async function statefulComponent(appName = 'testapp', compName = 'web') {
      const deployment = deploymentFor(await specWithComponents(appName, { [compName]: {} }));
      const [[, component]] = deployment.componentEntries();
      // A component with mounts always resolves a host dir; a stateless one gets
      // null, and the volume path below would then be derived from nothing.
      expect(component.dir, 'a stateful component must resolve a host dir').to.be.a('string');
      // The prefix is applied exactly once. v9 forbids an app name beginning with
      // `flux`, which is what makes a single prefix unambiguous — a component that
      // carried its own would point the wipe at a different directory.
      expect(component.identifier.startsWith('flux'), 'the identifier must not carry the namespace prefix itself').to.be.false;
      return { component, appId: `flux${component.identifier}` };
    }

    it('wipes the app data in the component volume, and nothing by name', async () => {
      const { component, appId } = await statefulComponent();
      const wipeAppData = sinon.stub().resolves({ error: null });
      const dockerOperations = build(
        { delay: sinon.stub().resolves() },
        { info: sinon.stub(), error: sinon.stub() },
        wipeAppData,
      );

      await dockerOperations.appDeleteDataInMountPoint(appId);

      expect(wipeAppData.calledOnce).to.be.true;
      // The wiped volume is the component's OWN host dir as flux-spec resolves it,
      // not a literal reproduced here: the two derivations of `appsFolder +
      // flux<identifier>` must agree or the node wipes somebody else's directory.
      expect(wipeAppData.firstCall.args).to.deep.equal([component.dir]);
      expect(path.basename(component.dir)).to.equal(appId);
    });

    it('retries until the delete succeeds (the stopped container released the mount)', async () => {
      const { appId } = await statefulComponent();
      const wipeAppData = sinon.stub();
      wipeAppData.onFirstCall().resolves({ error: new Error('device busy') });
      wipeAppData.onSecondCall().resolves({ error: null });
      const log = { info: sinon.stub(), error: sinon.stub() };
      const dockerOperations = build({ delay: sinon.stub().resolves() }, log, wipeAppData);

      await dockerOperations.appDeleteDataInMountPoint(appId, { intervalMs: 1 });

      expect(wipeAppData.calledTwice).to.be.true;
      expect(log.info.calledOnce).to.be.true;
      expect(log.error.called).to.be.false;
    });

    // A wipe that did not happen is not a wipe: the caller holds the clear and retries,
    // and a start can never proceed onto the data it was asked to remove.
    it('throws after the timeout rather than reporting a wipe that did not happen', async () => {
      const { appId } = await statefulComponent();
      const wipeAppData = sinon.stub().resolves({ error: new Error('still busy') });
      const log = { info: sinon.stub(), error: sinon.stub() };
      const dockerOperations = build({ delay: sinon.stub().resolves() }, log, wipeAppData);

      let threw = null;
      try { await dockerOperations.appDeleteDataInMountPoint(appId, { timeoutMs: 0 }); } catch (e) { threw = e; }

      expect(threw, 'the failed wipe was reported as done').to.be.an('error');
      expect(threw.message).to.include('still busy');
      expect(log.info.called).to.be.false;
    });

    it('treats a volume directory that is not there as nothing to clear', async () => {
      const { appId } = await statefulComponent();
      const wipeAppData = sinon.stub().resolves({ error: new Error('No such file or directory') });
      const stat = sinon.stub().rejects(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      const dockerOperations = build({ delay: sinon.stub().resolves() }, { info: sinon.stub(), error: sinon.stub() }, wipeAppData, stat);

      await dockerOperations.appDeleteDataInMountPoint(appId, { timeoutMs: 0 });
    });

    it('treats a volume path that is not a directory as nothing to clear', async () => {
      const { appId } = await statefulComponent();
      const wipeAppData = sinon.stub().resolves({ error: new Error('Not a directory') });
      const stat = sinon.stub().rejects(Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' }));
      const dockerOperations = build({ delay: sinon.stub().resolves() }, { info: sinon.stub(), error: sinon.stub() }, wipeAppData, stat);

      await dockerOperations.appDeleteDataInMountPoint(appId, { timeoutMs: 0 });
    });

    it('throws when the disk answers EIO rather than reading it as empty', async () => {
      const { appId } = await statefulComponent();
      const wipeAppData = sinon.stub().resolves({ error: new Error('Input/output error') });
      const stat = sinon.stub().rejects(Object.assign(new Error('EIO'), { code: 'EIO' }));
      const dockerOperations = build({ delay: sinon.stub().resolves() }, { info: sinon.stub(), error: sinon.stub() }, wipeAppData, stat);

      let threw = null;
      try { await dockerOperations.appDeleteDataInMountPoint(appId, { timeoutMs: 0 }); } catch (e) { threw = e; }
      expect(threw, 'an unreadable disk was reported as nothing to delete').to.be.an('error');
    });

    it('throws when it cannot tell whether the directory is there', async () => {
      const { appId } = await statefulComponent();
      const wipeAppData = sinon.stub().resolves({ error: new Error('Permission denied') });
      const stat = sinon.stub().rejects(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
      const dockerOperations = build({ delay: sinon.stub().resolves() }, { info: sinon.stub(), error: sinon.stub() }, wipeAppData, stat);

      let threw = null;
      try { await dockerOperations.appDeleteDataInMountPoint(appId, { timeoutMs: 0 }); } catch (e) { threw = e; }
      expect(threw).to.be.an('error');
    });
  });
});

describe('appOperations application lifecycle tests', () => {
  let appOperations;
  let dockerServiceStub;
  let registryManagerStub;
  let appsRepositoryStub;
  let buildDeploymentStub;
  let appVolumeServiceStub;
  let appReconcilerStub;
  let logStub;

  before(async function loadLibrary() {
    this.timeout(30_000);
    flux = await loadSpecLibrary();
  });

  beforeEach(() => {
    dockerServiceStub = {
      appDockerStop: sinon.stub().resolves(),
      appDockerRestart: sinon.stub().resolves(),
      appDockerStart: sinon.stub().resolves(),
    };

    registryManagerStub = {
      getApplicationGlobalSpecifications: sinon.stub().resolves(null),
      appLocation: sinon.stub().resolves([]),
    };

    appsRepositoryStub = {
      listInstalledApps: sinon.stub().resolves([]),
      getGlobalAppInfo: sinon.stub().resolves(null),
    };

    // deploymentProvider stays stubbed because the real one resolves this node's
    // identity through two daemon RPCs and the docker socket. What it does with the
    // InstantiatedSpec it is handed is NOT stubbed: the fake runs the real
    // DeploymentSpec.fromSpec on it, exactly as toDeployment does, so a row this
    // module hands over that the real provider could not build from fails here.
    buildDeploymentStub = sinon.stub().callsFake(async (instantiated) => {
      if (!instantiated) return null;
      // Cleartext specs resolve to themselves (resolveInstantiatedSpec); the
      // identity is READ off the row, never recomputed from the name.
      return deploymentFor(instantiated.spec, { identity: instantiated.identity ?? null });
    });

    appVolumeServiceStub = {
      ensureMountSourcesExist: sinon.stub().resolves(),
    };

    appReconcilerStub = {
      drive: sinon.stub().resolves({ converged: true, failed: [] }),
      setControllerDesired: sinon.stub(),
      // The container is DOWN by default. A stop's convergence verdict does not
      // establish that - the anti-hang backstop answers 'provisional' after five
      // minutes and `converged` stays true - so the callers about to replace the
      // volume ask docker itself.
      observedContainerState: sinon.stub().resolves({
        reachable: true, exists: true, running: false, indeterminate: false,
      }),
    };

    logStub = {
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
    };

    appOperations = proxyquire('../../ZelBack/src/services/appLifecycle/appOperations', {
      '../dockerService': dockerServiceStub,
      '../appDatabase/registryManager': registryManagerStub,
      // appOperations destructures three names from this module. noCallThru means
      // an omitted key is `undefined`, not the real export, so a partial stub
      // fails as "x is not a function" on whichever path reaches it first.
      '../utils/specLibs': {
        getSpec: sinon.stub(),
        getSpecBackend: sinon.stub().resolves({}),
        assertUpdateInvariants: sinon.stub(),
      },
      './appVolumeService': appVolumeServiceStub,
      '../appMonitoring/appReconciler': appReconcilerStub,
      '../../lib/log': logStub,
      // Same: appOperations calls seven of these. runCommand is the one that
      // matters — left out it reads as a crash, but it is also the real one that
      // shells out, so it must be present AND stubbed.
      '../serviceHelper': {
        delay: sinon.stub().resolves(),
        ensureString: sinon.stub().returnsArg(0),
        ensureNumber: sinon.stub().returnsArg(0),
        ensureBoolean: sinon.stub().returnsArg(0),
        ensureObject: sinon.stub().returnsArg(0),
        runCommand: sinon.stub().resolves({ error: null, stdout: '', stderr: '' }),
        axiosGet: sinon.stub().resolves({ data: null }),
      },
      '../messageHelper': {},
      '../verificationHelper': {},
      '../daemonService/daemonServiceMiscRpcs': {},
      '../fluxNetworkHelper': { getLocalSocketAddress: sinon.stub().resolves('127.0.0.1:16127') },
      '../upnpService': {},
      '../appDatabase/appsRepository': appsRepositoryStub,
      // checkNodeResourcesReclaiming runs on three redeploy paths and, left
      // real, resolves generalService.nodeTier() — two daemon RPCs.
      '../appRequirements/hwRequirements': {
        checkNodeResourcesReclaiming: sinon.stub().resolves(),
      },
      '../appQuery/appQueryService': { listRunningContainers: sinon.stub().resolves([]), listAllApps: sinon.stub().resolves([]), installedApps: sinon.stub().resolves({ data: [] }) },
      '../appRuntime/deploymentProvider': {
        getInstalledDeployment: sinon.stub().resolves(null),
        buildDeployment: buildDeploymentStub,
        // The request form: `<app>` or `<component>_<app>`.
        appNameFromRequest: (appname) => appname.split('_')[1] || appname,
        // Delegates at call time so per-test overrides of buildDeployment flow
        // through the plural entry the enumeration uses.
        get buildDeployments() {
          const single = this.buildDeployment;
          return async (inst) => {
            const deployment = await single(inst);
            return deployment ? [deployment] : [];
          };
        },
      },
      './appUninstaller': { uninstallApplication: sinon.stub().resolves() },
      './componentProvisioner': { installComponent: sinon.stub().resolves() },
      // No app is mid-drain: a stop reads its containers as soon as the drive settles.
      '../utils/globalState': { getAppShutdownPipelineState: () => null },
      '../utils/appConstants': {
        localAppsInformation: 'test', globalAppsInformation: 'test', globalAppsInstallingErrorsLocations: 'test', globalAppsMessages: 'test', appsFolder: APPS_FOLDER,
      },
      config: asConfig({ fluxapps: { minimumInstances: 3, redeploy: { composedDelay: 30_000 } }, database: { appsglobal: { database: 'globalapps', collections: {} } } }),

      // proxyquire does not recurse: every require absent from this map loads for
      // real, dragging its own dependency tree in with it. The entries below are
      // stubbed because the module — or something it requires — reaches the
      // network, the filesystem, Docker, a child process, a unix socket, Mongo or
      // a daemon RPC. Defaults describe the inert state (nothing configured,
      // nothing present) so a path that runs without an override does no work.
      //
      // Left real on purpose: node:path and https (builtins; `new https.Agent()`
      // opens nothing), ../utils/socketAddressUtils and ./shutdownPlan (no
      // requires at all — pure functions the code under test depends on),
      // ../utils/operationRegistry (an in-memory lease Map over a logger, TTL
      // timers unref'd) and ../utils/fluxEventBus (an in-memory ring buffer whose
      // publish() is inert unless the harness event-stream flag is set).
      'node:fs/promises': {
        // The sole read gates the shutdown-plan resync on the flux-shutdownd
        // socket existing; absent means there is no daemon to talk to.
        access: sinon.stub().rejects(new Error('ENOENT')),
      },
      axios: {
        get: sinon.stub().resolves({ data: { data: [] } }),
        CancelToken: { source: () => ({ token: {}, cancel: sinon.stub() }) },
      },
      '../IOUtils': {
        checkFileExists: sinon.stub().resolves(false),
        createTarGz: sinon.stub().resolves({ status: true }),
        untarFile: sinon.stub().resolves({ status: true }),
        downloadFileFromUrl: sinon.stub().resolves(true),
        removeFile: sinon.stub().resolves(),
        removeDirectory: sinon.stub().resolves(),
      },
      // findmnt via serviceHelper.runCommand. Zero available bytes takes the
      // "no useable volume" branch, which marks the node OK and allocates nothing.
      '../deviceHelper': {
        mountForTarget: sinon.stub().resolves({
          source: '/dev/stub', target: '/tmp/flux', fstype: 'ext4', uuid: null, availableBytes: 0,
        }),
      },
      '../fluxCommunicationMessagesSender': { broadcastTemporaryAppMessage: sinon.stub().resolves() },
      '../syncthingService': {
        getHealth: sinon.stub().resolves({ status: 'OK' }),
        getConfigFolders: sinon.stub().resolves([]),
        adjustConfigFolders: sinon.stub().resolves({ status: 'success' }),
      },
      '../telemetrySinkCache': { extractSink: sinon.stub().returns(null), setSink: sinon.stub() },
      '../telemetryConfigService': { ensureNode: sinon.stub().resolves() },
      '../telemetryIdentityService': { resyncAll: sinon.stub() },
      '../appManagement/appsRuntimeState': { isOperatorStopped: sinon.stub().resolves(false) },
      '../appManagement/globalCommand': { executeAppGlobalCommand: sinon.stub().resolves() },
      '../appMessaging/appEventVerifier': {
        deserializeTempMessage: sinon.stub().resolves({}),
        authorize: sinon.stub().resolves(),
        computeOutboundHash: sinon.stub().resolves('testhash'),
        requestAttestation: sinon.stub().resolves(null),
      },
      '../appMessaging/ingressAttestationService': { emit: sinon.stub().resolves() },
      '../appMessaging/messageVerifier': { requestAppMessage: sinon.stub().resolves() },
      '../appMonitoring/syncthingMonitorHelpers': { removeSyncthingFolder: sinon.stub().resolves() },
      // Destructured at import, so every name the module under test pulls out has
      // to be present — noCallThru() means an omitted key is undefined, not real.
      '../appRequirements/appSubmission': {
        resolveSubmission: sinon.stub().resolves({ spec: null, broadcastBlob: null }),
        assertSecretsNotConflicting: sinon.stub().resolves(),
        parseMultipartSubmission: sinon.stub().resolves({ spec: null, content: null, ownerSigs: null }),
        uploadSealedContent: sinon.stub().resolves(),
      },
      '../utils/appCaches': {
        receiveOnlySyncthingAppsCache: new Map(),
        // The real write stamps the mark with the volume's filesystem id, which
        // costs a findmnt; storing it as given keeps the mark readable.
        setSyncedMark: sinon.stub().resolvesArg(2),
        syncedMark: sinon.stub().resolves(null),
      },
      '../utils/fluxShutdowndClient': {
        SOCKET_PATH: '/run/flux-shutdownd/daemon.sock',
        listAppPlans: sinon.stub().resolves([]),
        upsertAppPlanBestEffort: sinon.stub().resolves(),
        deleteAppPlanBestEffort: sinon.stub().resolves(),
      },
      // Requiring it for real builds the FluxPeerManager singleton, and with it
      // the websocket stack. Destructured inside the functions that use it.
      '../utils/peerState': {
        peerManager: {
          inboundCount: 0,
          outboundCount: 0,
          getRandomPeer: sinon.stub().returns(null),
        },
      },
      '../utils/volumeService': { listComponentVolumeMounts: sinon.stub().resolves([]) },
      './appNetworkLinker': {
        checkAppNetworkRequirements: sinon.stub().resolves(),
        connectComponentToLinkedApps: sinon.stub().resolves(),
      },
      './contentBlobService': { serveBlob: sinon.stub().resolves(null) },
      './pendingTeardownStore': { teardownOwedFor: sinon.stub().resolves(false) },
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  /**
   * A real two-component app and the deployment view of it this node would hold.
   * Two components cannot share a hostPort — the real library rejects it — so the
   * second one is moved off 31000.
   */
  async function twoComponentApp(appName = 'testapp') {
    const spec = await specWithComponents(appName, {
      web: {},
      api: { ports: { http: { containerPort: 8080, hostPort: 31_001 } } },
    });
    return { spec, deployment: deploymentFor(spec) };
  }

  /**
   * The invariant the app-vs-component branch in componentIdentifiersFor rests on:
   * a v9 app name cannot contain `_` (`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`), and a
   * container identifier always does (`<component>_<identity>`). Asserted against
   * the real objects rather than assumed, because the branch is a string test.
   */
  function assertNameSplitsFromIdentifier(appName, identifier) {
    expect(appName.includes('_'), 'a real app name must not contain the separator the branch keys on').to.be.false;
    expect(identifier.includes('_'), 'a real container identifier must contain it').to.be.true;
  }

  // backup/restore drive run-state THROUGH the reconciler (the sole actuator) via
  // appReconciler.drive() — they never touch Docker. A single component resolves to
  // itself (no spec lookup); a whole app expands to every component identifier.
  describe('stopApplication', () => {
    it('should drive a single component to stopped through the reconciler', async () => {
      const { deployment } = await twoComponentApp();
      const [[, web]] = deployment.componentEntries();
      assertNameSplitsFromIdentifier(deployment.appName, web.identifier);

      await appOperations.stopApplication(web.identifier);

      sinon.assert.calledOnceWithExactly(appReconcilerStub.drive, [web.identifier], 'stopped');
      sinon.assert.notCalled(dockerServiceStub.appDockerStop);
    });

    it('should not look up specs when stopping a single component', async () => {
      const { deployment } = await twoComponentApp('myapp');
      const [[, web]] = deployment.componentEntries();

      await appOperations.stopApplication(web.identifier);

      sinon.assert.notCalled(appsRepositoryStub.getGlobalAppInfo);
    });

    // These two used to assert that a failure here was logged and swallowed.
    // It is raised now, and deliberately: both callers are backup and restore,
    // which call this immediately before reading or replacing the volume. A
    // swallowed failure told them the app was down when it was not, and a
    // container still writing had its data archived or overwritten underneath
    // it. The throw reaches each caller's catch, which restarts the app and
    // releases the lease.
    it('refuses the whole app rather than reporting it stopped, when its specs are not found', async () => {
      appsRepositoryStub.getGlobalAppInfo.resolves(null);

      let raised = null;
      await appOperations.stopApplication('testapp').catch((error) => { raised = error; });

      expect(raised, 'a caller about to touch the volume must not be told this succeeded').to.be.an('Error');
      expect(raised.message).to.equal('Application not found');
      sinon.assert.notCalled(appReconcilerStub.drive);
    });

    // CONVERGENCE IS NOT THE FACT THESE CALLERS NEED. awaitConvergence counts
    // only the 'failed' verdict; the anti-hang backstop answers 'provisional'
    // after convergeBackstopMs (five minutes) and that is not counted, so
    // `converged` comes back true. Five minutes is nothing against a stop - the
    // stopping lease is held for its duration, legitimately hours under a
    // graceful drain - so 'provisional' ordinarily means STILL STOPPING.
    it('proves the container is down with docker, not with the convergence verdict', async () => {
      const { deployment } = await twoComponentApp();
      const [[, web]] = deployment.componentEntries();

      await appOperations.stopApplication(web.identifier);

      sinon.assert.calledWith(appReconcilerStub.observedContainerState, web.identifier);
    });

    it('refuses when docker says the container is still running, though the drive converged', async () => {
      const { deployment } = await twoComponentApp();
      const [[, web]] = deployment.componentEntries();
      appReconcilerStub.drive.resolves({ converged: true, failed: [] });
      appReconcilerStub.observedContainerState.resolves({
        reachable: true, exists: true, running: true, indeterminate: false,
      });

      let raised = null;
      await appOperations.stopApplication(web.identifier).catch((error) => { raised = error; });

      expect(raised, 'a container still writing must not have its volume replaced').to.be.an('Error');
      expect(raised.message).to.contain('is still running');
    });

    // A container that is draining answers "running", so it refuses at once
    // rather than spending the daemon budget. The wait exists for a daemon that
    // cannot answer, not for a container that is taking its time.
    it('does not wait on a container that is merely still stopping', async () => {
      const { deployment } = await twoComponentApp();
      const [[, web]] = deployment.componentEntries();
      appReconcilerStub.observedContainerState.resolves({
        reachable: true, exists: true, running: true, indeterminate: false,
      });

      await appOperations.stopApplication(web.identifier).catch(() => {});

      sinon.assert.calledOnce(appReconcilerStub.observedContainerState);
    });

    // "I asked, and the container is up" and "docker did not answer" are
    // different facts, and only one of them is about the container. A dockerd
    // restart clears in seconds, so it is waited out - bounded, and then refused
    // as what it is rather than as a container that refused to stop.
    it('waits out a daemon that cannot answer, then refuses naming the daemon', async () => {
      const { deployment } = await twoComponentApp();
      const [[, web]] = deployment.componentEntries();
      appReconcilerStub.observedContainerState.resolves({ reachable: false });
      const progress = [];

      let raised = null;
      await appOperations.stopApplication(web.identifier, (line) => { progress.push(line); })
        .catch((error) => { raised = error; });

      expect(raised).to.be.an('Error');
      expect(raised.message).to.contain('docker never became able to answer');
      expect(raised.message, 'never blamed on the container').to.not.contain('did not stop');
      expect(appReconcilerStub.observedContainerState.callCount, 'bounded, not forever').to.equal(12);
      expect(progress.length, 'a 200 already went out, so silence risks the connection').to.equal(11);
    });

    // The daemon answered but that one inspect failed - docker is fine and the
    // run-state is unknown. Unknown is not down.
    it('waits out an indeterminate answer rather than reading it as stopped', async () => {
      const { deployment } = await twoComponentApp();
      const [[, web]] = deployment.componentEntries();
      appReconcilerStub.observedContainerState.resolves({
        reachable: true, exists: true, running: false, indeterminate: true,
      });

      let raised = null;
      await appOperations.stopApplication(web.identifier).catch((error) => { raised = error; });

      expect(raised, 'an unknown run-state must not read as down').to.be.an('Error');
      expect(raised.message).to.contain('docker never became able to answer');
    });

    // A container docker confirms is gone cannot write either.
    it('accepts a container docker confirms is gone', async () => {
      const { deployment } = await twoComponentApp();
      const [[, web]] = deployment.componentEntries();
      appReconcilerStub.observedContainerState.resolves({
        reachable: true, exists: false, running: false, indeterminate: false,
      });

      await appOperations.stopApplication(web.identifier);
    });

    it('should drive all components of a whole app to stopped', async () => {
      const { spec, deployment } = await twoComponentApp();
      const installed = await instantiatedSpec(spec);
      appsRepositoryStub.getGlobalAppInfo.resolves(installed);

      await appOperations.stopApplication(spec.name);

      // Every component, in the deployment's own startup order, named by the real
      // container-identifier rule — `<component>_<app>` for an unqualified identity.
      const identifiers = deployment.componentEntries().map(([, comp]) => comp.identifier);
      expect(identifiers, 'the real container-naming rule').to.deep.equal(['web_testapp', 'api_testapp']);
      sinon.assert.calledOnceWithExactly(appReconcilerStub.drive, identifiers, 'stopped');

      // The row handed to the (stubbed) provider must answer what the real
      // toDeployments reads off it: the encryption flag it branches on, the
      // readable spec it builds from, the name it reports, and the stored identity
      // it reads rather than recomputing.
      const [handed] = buildDeploymentStub.firstCall.args;
      expect(handed.isEncrypted, 'resolveInstantiatedSpec branches on this').to.be.a('boolean');
      expect(handed.name).to.equal(spec.name);
      expect(handed).to.have.property('identity');
      expect(flux.DeploymentSpec.fromSpec(handed.spec, APPS_FOLDER, { replica: null, identity: handed.identity ?? null })
        .componentEntries().map(([, comp]) => comp.identifier), 'the real provider must be able to build from what it was handed')
        .to.deep.equal(identifiers);
    });

    it('raises a reconciler failure rather than reporting the component stopped', async () => {
      const { deployment } = await twoComponentApp();
      const [[, web]] = deployment.componentEntries();
      appReconcilerStub.drive.rejects(new Error('converge failed'));

      let raised = null;
      await appOperations.stopApplication(web.identifier).catch((error) => { raised = error; });

      expect(raised, 'the reconciler could not answer, so nothing may act as though it did').to.be.an('Error');
      expect(raised.message).to.equal('converge failed');
    });
  });

  describe('startApplication', () => {
    it('should drive a single component to running through the reconciler', async () => {
      const { deployment } = await twoComponentApp();
      const [[, web]] = deployment.componentEntries();
      assertNameSplitsFromIdentifier(deployment.appName, web.identifier);

      await appOperations.startApplication(web.identifier);

      sinon.assert.calledOnceWithExactly(appReconcilerStub.drive, [web.identifier], 'running');
      sinon.assert.notCalled(dockerServiceStub.appDockerStart);
    });

    it('should drive all components of a whole app to running', async () => {
      const { spec, deployment } = await twoComponentApp();
      appsRepositoryStub.getGlobalAppInfo.resolves(await instantiatedSpec(spec));

      await appOperations.startApplication(spec.name);

      const identifiers = deployment.componentEntries().map(([, comp]) => comp.identifier);
      expect(identifiers, 'the real container-naming rule').to.deep.equal(['web_testapp', 'api_testapp']);
      sinon.assert.calledOnceWithExactly(appReconcilerStub.drive, identifiers, 'running');
    });

    it('should log error and not drive when app not found', async () => {
      appsRepositoryStub.getGlobalAppInfo.resolves(null);

      await appOperations.startApplication('testapp');

      sinon.assert.calledOnce(logStub.error);
      sinon.assert.notCalled(appReconcilerStub.drive);
    });
  });
});
