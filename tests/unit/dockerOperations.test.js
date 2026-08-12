'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('dockerOperations tests', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('appDeleteDataInMountPoint', () => {
    const build = (serviceHelper, log) => proxyquire('../../ZelBack/src/services/appManagement/dockerOperations', {
      '../serviceHelper': serviceHelper,
      '../../lib/log': log,
      '../utils/appConstants': { appsFolder: '/tmp/flux/apps/' },
    });

    it('deletes the appdata dir via runCommand (as root, no shell glob)', async () => {
      const runCommand = sinon.stub().resolves({ error: null });
      const dockerOperations = build(
        { runCommand, delay: sinon.stub().resolves() },
        { info: sinon.stub(), error: sinon.stub() },
      );

      await dockerOperations.appDeleteDataInMountPoint('testapp');

      expect(runCommand.calledOnce).to.be.true;
      expect(runCommand.firstCall.args[0]).to.equal('rm');
      expect(runCommand.firstCall.args[1].runAsRoot).to.equal(true);
      expect(runCommand.firstCall.args[1].params).to.deep.equal(['-rf', '/tmp/flux/apps/testapp/appdata']);
    });

    it('retries until the delete succeeds (the stopped container released the mount)', async () => {
      const runCommand = sinon.stub();
      runCommand.onFirstCall().resolves({ error: new Error('device busy') });
      runCommand.onSecondCall().resolves({ error: null });
      const log = { info: sinon.stub(), error: sinon.stub() };
      const dockerOperations = build({ runCommand, delay: sinon.stub().resolves() }, log);

      await dockerOperations.appDeleteDataInMountPoint('testapp', { intervalMs: 1 });

      expect(runCommand.calledTwice).to.be.true;
      expect(log.info.calledOnce).to.be.true;
      expect(log.error.called).to.be.false;
    });

    it('gives up and logs after the timeout (never loops forever)', async () => {
      const runCommand = sinon.stub().resolves({ error: new Error('still busy') });
      const log = { info: sinon.stub(), error: sinon.stub() };
      const dockerOperations = build({ runCommand, delay: sinon.stub().resolves() }, log);

      await dockerOperations.appDeleteDataInMountPoint('testapp', { timeoutMs: 0 });

      expect(log.error.calledOnce).to.be.true;
      expect(log.info.called).to.be.false;
    });
  });
});

function mockInstantiatedSpec(spec) {
  if (!spec) return null;
  return {
    spec,
    name: spec.name,
    version: spec.version || 4,
    hash: 'testhash',
    height: 1000,
    isEncrypted: false,
    serialize: () => ({ ...spec }),
  };
}

describe('appOperations application lifecycle tests', () => {
  let appOperations;
  let dockerServiceStub;
  let registryManagerStub;
  let appsRepositoryStub;
  let buildDeploymentStub;
  let appVolumeServiceStub;
  let appReconcilerStub;
  let logStub;

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

    buildDeploymentStub = sinon.stub().resolves(null);

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
      '../utils/appConstants': { localAppsInformation: 'test', globalAppsInformation: 'test', globalAppsInstallingErrorsLocations: 'test', globalAppsMessages: 'test', appsFolder: '/tmp/flux/apps/' },
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

  // backup/restore drive run-state THROUGH the reconciler (the sole actuator) via
  // appReconciler.drive() — they never touch Docker. A single component resolves to
  // itself (no spec lookup); a whole app expands to every component identifier.
  describe('stopApplication', () => {
    it('should drive a single component to stopped through the reconciler', async () => {
      await appOperations.stopApplication('Component1_TestApp');

      sinon.assert.calledOnceWithExactly(appReconcilerStub.drive, ['Component1_TestApp'], 'stopped');
      sinon.assert.notCalled(dockerServiceStub.appDockerStop);
    });

    it('should not look up specs when stopping a single component', async () => {
      await appOperations.stopApplication('Web_MyApp');

      sinon.assert.notCalled(appsRepositoryStub.getGlobalAppInfo);
    });

    it('should log error and not drive when app specs not found for whole app', async () => {
      appsRepositoryStub.getGlobalAppInfo.resolves(null);

      await appOperations.stopApplication('TestApp');

      sinon.assert.calledOnce(logStub.error);
      sinon.assert.notCalled(appReconcilerStub.drive);
    });

    it('should drive all components of a whole app to stopped', async () => {
      const fakeSpec = { name: 'TestApp', version: 4, components: { Web: {}, API: {} } };
      appsRepositoryStub.getGlobalAppInfo.resolves(mockInstantiatedSpec(fakeSpec));

      const mockDeployment = {
        componentEntries: sinon.stub().returns([
          ['Web', { identifier: 'Web_TestApp' }],
          ['API', { identifier: 'API_TestApp' }],
        ]),
      };
      buildDeploymentStub.resolves(mockDeployment);

      await appOperations.stopApplication('TestApp');

      sinon.assert.calledOnceWithExactly(appReconcilerStub.drive, ['Web_TestApp', 'API_TestApp'], 'stopped');
    });

    it('should handle reconciler errors gracefully', async () => {
      appReconcilerStub.drive.rejects(new Error('converge failed'));

      await appOperations.stopApplication('Component1_TestApp');

      sinon.assert.calledOnce(logStub.error);
    });
  });

  describe('startApplication', () => {
    it('should drive a single component to running through the reconciler', async () => {
      await appOperations.startApplication('Component1_TestApp');

      sinon.assert.calledOnceWithExactly(appReconcilerStub.drive, ['Component1_TestApp'], 'running');
      sinon.assert.notCalled(dockerServiceStub.appDockerStart);
    });

    it('should drive all components of a whole app to running', async () => {
      appsRepositoryStub.getGlobalAppInfo.resolves(mockInstantiatedSpec({ name: 'TestApp' }));

      const mockDeployment = {
        componentEntries: sinon.stub().returns([
          ['Web', { identifier: 'Web_TestApp' }],
          ['API', { identifier: 'API_TestApp' }],
        ]),
      };
      buildDeploymentStub.resolves(mockDeployment);

      await appOperations.startApplication('TestApp');

      sinon.assert.calledOnceWithExactly(appReconcilerStub.drive, ['Web_TestApp', 'API_TestApp'], 'running');
    });

    it('should log error and not drive when app not found', async () => {
      appsRepositoryStub.getGlobalAppInfo.resolves(null);

      await appOperations.startApplication('TestApp');

      sinon.assert.calledOnce(logStub.error);
      sinon.assert.notCalled(appReconcilerStub.drive);
    });
  });
});
