'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const path = require('node:path');
const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
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
    this.timeout(30000);
    flux = await loadSpecLibrary();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('appDeleteDataInMountPoint', () => {
    const build = (serviceHelper, log) => proxyquire('../../ZelBack/src/services/appManagement/dockerOperations', {
      '../serviceHelper': serviceHelper,
      '../../lib/log': log,
      '../utils/appConstants': { appsFolder: APPS_FOLDER },
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
      // null, and the appdata path below would then be derived from nothing.
      expect(component.dir, 'a stateful component must resolve a host dir').to.be.a('string');
      // The prefix is applied exactly once. v9 forbids an app name beginning with
      // `flux`, which is what makes a single prefix unambiguous — a component that
      // carried its own would point the wipe at a different directory.
      expect(component.identifier.startsWith('flux'), 'the identifier must not carry the namespace prefix itself').to.be.false;
      return { component, appId: `flux${component.identifier}` };
    }

    it('deletes the appdata dir via runCommand (as root, no shell glob)', async () => {
      const { component, appId } = await statefulComponent();
      const runCommand = sinon.stub().resolves({ error: null });
      const dockerOperations = build(
        { runCommand, delay: sinon.stub().resolves() },
        { info: sinon.stub(), error: sinon.stub() },
      );

      await dockerOperations.appDeleteDataInMountPoint(appId);

      expect(runCommand.calledOnce).to.be.true;
      expect(runCommand.firstCall.args[0]).to.equal('rm');
      expect(runCommand.firstCall.args[1].runAsRoot).to.equal(true);
      // The wiped path is the component's OWN host dir as flux-spec resolves it,
      // not a literal reproduced here: the two derivations of `appsFolder +
      // flux<identifier>` must agree or the node wipes somebody else's directory.
      expect(runCommand.firstCall.args[1].params).to.deep.equal(['-rf', path.join(component.dir, 'appdata')]);
    });

    it('retries until the delete succeeds (the stopped container released the mount)', async () => {
      const { appId } = await statefulComponent();
      const runCommand = sinon.stub();
      runCommand.onFirstCall().resolves({ error: new Error('device busy') });
      runCommand.onSecondCall().resolves({ error: null });
      const log = { info: sinon.stub(), error: sinon.stub() };
      const dockerOperations = build({ runCommand, delay: sinon.stub().resolves() }, log);

      await dockerOperations.appDeleteDataInMountPoint(appId, { intervalMs: 1 });

      expect(runCommand.calledTwice).to.be.true;
      expect(log.info.calledOnce).to.be.true;
      expect(log.error.called).to.be.false;
    });

    it('gives up and logs after the timeout (never loops forever)', async () => {
      const { appId } = await statefulComponent();
      const runCommand = sinon.stub().resolves({ error: new Error('still busy') });
      const log = { info: sinon.stub(), error: sinon.stub() };
      const dockerOperations = build({ runCommand, delay: sinon.stub().resolves() }, log);

      await dockerOperations.appDeleteDataInMountPoint(appId, { timeoutMs: 0 });

      expect(log.error.calledOnce).to.be.true;
      expect(log.info.called).to.be.false;
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
    this.timeout(30000);
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
      '../utils/globalState': {},
      '../utils/appConstants': {
        localAppsInformation: 'test', globalAppsInformation: 'test', globalAppsInstallingErrorsLocations: 'test', globalAppsMessages: 'test', appsFolder: APPS_FOLDER,
      },
      config: { fluxapps: { minimumInstances: 3, redeploy: { composedDelay: 30000 } }, database: { appsglobal: { database: 'globalapps', collections: {} } } },

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
        getHealth: sinon.stub().resolves({ status: 'success', data: { status: 'OK' } }),
        getConfigFolders: sinon.stub().resolves({ status: 'success', data: [] }),
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
      api: { ports: { http: { containerPort: 8080, hostPort: 31001 } } },
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

    it('should log error and not drive when app specs not found for whole app', async () => {
      appsRepositoryStub.getGlobalAppInfo.resolves(null);

      await appOperations.stopApplication('testapp');

      sinon.assert.calledOnce(logStub.error);
      sinon.assert.notCalled(appReconcilerStub.drive);
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

    it('should handle reconciler errors gracefully', async () => {
      const { deployment } = await twoComponentApp();
      const [[, web]] = deployment.componentEntries();
      appReconcilerStub.drive.rejects(new Error('converge failed'));

      await appOperations.stopApplication(web.identifier);

      sinon.assert.calledOnce(logStub.error);
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
