'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
// Real registry singleton - un-stubbed in proxyquire, so the installer and the test share it.
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');
const {
  loadSpecLibrary, v9Spec, sealedV9Spec, instantiatedSpec, assertAnswers,
} = require('./fixtures/fluxSpec');

// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. The installer receives an InstantiatedSpec and works through a
// DeploymentSpec built from it, so both are the real classes. What stays stubbed
// is I/O and FluxOS policy: docker, mongo, the daemon RPCs, the reconciler.
let flux;

// Where DeploymentSpec roots each container's host dir. Only path derivation reads
// it and nothing here touches the filesystem, so no directory has to exist.
const APPS_FOLDER = '/dat/var/lib/fluxos/flux-apps';

describe('appInstaller tests', () => {
  let appInstaller;
  let verificationHelperStub;
  let messageHelperStub;
  let logStub;
  let configStub;
  let hwRequirementsStub;

  // Real objects, built once — the first fromSubmission compiles the ajv schemas.
  let testappInstantiated; // cleartext v9, name 'testapp'
  let newappSpec; // the cleartext v9 spec behind newappInstantiated
  let newappInstantiated; // cleartext v9, name 'newapp', hash 'hash1'
  let arcaneInstantiated; // node-sealed v9 over the same app — genuinely Arcane-only

  before(async function loadLibrary() {
    this.timeout(60000);
    flux = await loadSpecLibrary();
    testappInstantiated = await instantiatedSpec(await v9Spec({ name: 'testapp' }), { hash: 'hash0' });
    newappSpec = await v9Spec({ name: 'newapp' });
    newappInstantiated = await instantiatedSpec(newappSpec, { hash: 'hash1' });
    // NOT a stubbed requiresArcane(): an encrypted spec IS Arcane-only, and
    // InstantiatedSpec freezes itself, so the real answer is the only one on offer.
    arcaneInstantiated = await instantiatedSpec(await sealedV9Spec({ name: 'newapp' }), { hash: 'hash1' });
  });

  beforeEach(() => {
    // Config stub
    configStub = {
      database: {
        daemon: {
          collections: {
            scannedHeight: 'scannedHeight',
            appsHashes: 'appsHashes',
          },
          database: 'daemon',
        },
        appslocal: {
          collections: {
            appsInformation: 'localAppsInformation',
          },
          database: 'localapps',
        },
        appsglobal: {
          collections: {
            appsMessages: 'appsMessages',
            appsInformation: 'globalAppsInformation',
            appsTemporaryMessages: 'appsTemporaryMessages',
            appsInstallingLocations: 'appsInstallingLocations',
            appsInstallingErrorsLocations: 'appsInstallingErrorsLocations',
          },
          database: 'globalapps',
        },
      },
      fluxapps: {
        blocksLasting: 22000,
        latestAppSpecification: 1,
        ownerAppAllowance: 100,
        temporaryAppAllowance: 200,
        maxImageSize: 10000000000,
      },
    };

    // Stubs
    verificationHelperStub = {
      verifyPrivilege: sinon.stub(),
    };

    messageHelperStub = {
      createDataMessage: sinon.stub(),
      createErrorMessage: sinon.stub(),
      createSuccessMessage: sinon.stub(),
      createWarningMessage: sinon.stub(),
      errUnauthorizedMessage: sinon.stub(),
    };

    hwRequirementsStub = {
      systemArchitecture: sinon.stub().resolves('amd64'),
      checkPlacement: sinon.stub().resolves(),
      checkNodeResources: sinon.stub().resolves(),
      // The admission gate reads capacity and decides for itself, so it can tell
      // "does not fit" from "does not fit only because a session is holding it".
      nodeCapacity: sinon.stub().resolves({ availableSpace: 500, availableCpu: 100, availableRam: 30000 }),
      capacityShortfall: sinon.stub().returns(null),
    };

    logStub = {
      error: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
    };

    // Proxy require
    appInstaller = proxyquire('../../ZelBack/src/services/appLifecycle/appInstaller', {
      '../appMonitoring/appReconciler': { awaitConvergence: sinon.stub().resolves({ converged: true, failed: [] }) },
      config: configStub,
      '../verificationHelper': verificationHelperStub,
      '../messageHelper': messageHelperStub,
      '../serviceHelper': {
        ensureString: sinon.stub().returnsArg(0),
        ensureNumber: sinon.stub().returnsArg(0),
        delay: sinon.stub().resolves(),
      },
      '../fluxNetworkHelper': {
        getNumberOfPeers: sinon.stub().returns(15),
        isFirewallActive: sinon.stub().resolves(false),
        allowPort: sinon.stub().resolves({ status: true }),
        removeDockerContainerAccessToNonRoutable: sinon.stub().resolves(true),
        getLocalSocketAddress: sinon.stub().resolves('192.168.1.1:16127'),
      },
      // Stubbed HERE because proxyquire does not recurse: the install path ensures
      // the app network through this module, and leaving it real resolves the real
      // dockerService + fluxNetworkHelper and drives the actual docker daemon.
      '../appNetwork/appDockerNetwork': { ensureAppDockerNetwork: sinon.stub().resolves('net') },
      './appUninstaller': {
        uninstallApplication: sinon.stub().resolves(),
      },
      './pendingTeardownStore': { teardownOwedFor: sinon.stub().resolves(false) },
      '../fluxCommunicationMessagesSender': {
        broadcastMessageToOutgoing: sinon.stub().resolves(),
        broadcastMessageToIncoming: sinon.stub().resolves(),
      },
      '../appMessaging/messageStore': {
        storeAppInstallingErrorMessage: sinon.stub().resolves(),
      },
      '../appSecurity/imageManager': {
        isImageBlocked: sinon.stub().resolves(false),
        verifyRepository: sinon.stub().resolves({
          verified: true,
          supportedArchitectures: ['amd64', 'arm64'],
        }),
      },
      '../pgpService': {
        decryptMessage: sinon.stub().resolves('user:token'),
      },
      '../../lib/log': logStub,
      '../appDatabase/appsRepository': {
        getGlobalAppInfo: sinon.stub().resolves(null),
        existsInstalledApp: sinon.stub().resolves(false),
        existsInstalledIdentity: sinon.stub().resolves(false),
        getTempMessageByName: sinon.stub().resolves(null),
      },
      '../appRuntime/deploymentProvider': {
        listInstalledDeployments: sinon.stub().resolves([]),
        resolveDeploymentIdentity: sinon.stub().resolves(null),
      },
      '../utils/fluxEventBus': {
        publish: sinon.stub(),
      },
      '../utils/cpuBurstHelper': {
        getCpuBurstAllowance: sinon.stub().returns(0),
      },
      '../appRequirements/hwRequirements': hwRequirementsStub,
      // Stubbed for the same reason appDockerNetwork above is: proxyquire does
      // not recurse, so a collaborator left real brings its own real
      // dependencies with it. componentProvisioner is the one that matters —
      // it resolves the real dockerService (which constructs a Docker client at
      // load) and the real appVolumeService, whose createAppVolume shells
      // fallocate, mke2fs and mount as root.
      './componentProvisioner': { installComponent: sinon.stub().resolves() },
      './appNetworkLinker': {
        connectComponentToLinkedApps: sinon.stub().resolves(),
        reconnectLinkedApps: sinon.stub().resolves(),
      },
      './relationshipResolver': {
        checkAppDependencyRequirements: sinon.stub().resolves(),
      },
      './contentBlobService': { provisionContentBlobs: sinon.stub().resolves() },
      './contentSlotService': { provisionContentSlots: sinon.stub().resolves() },
      // Reaches generalService's daemon RPCs and writes real files.
      '../telemetryConfigService': { ensureNode: sinon.stub().resolves() },
      '../telemetrySinkCache': { extractSink: sinon.stub().returns(null), setSink: sinon.stub() },
      // Opens a unix socket to the daemon.
      '../utils/fluxShutdowndClient': { upsertAppPlanBestEffort: sinon.stub().resolves() },
      'node:fs/promises': { chmod: sinon.stub().resolves(), writeFile: sinon.stub().resolves() },
});
  });

  afterEach(() => {
    sinon.restore();
    operationRegistry.clear();
  });

  describe('installApplicationAPI', () => {
    it('should reject unauthorized users', async () => {
      const req = {
        params: { appname: 'testapp' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      verificationHelperStub.verifyPrivilege.resolves(false);
      messageHelperStub.errUnauthorizedMessage.returns({ status: 'error', data: { message: 'Unauthorized' } });

      await appInstaller.installApplicationAPI(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(verificationHelperStub.verifyPrivilege.calledWith('adminandfluxteam', req)).to.be.true;
    });

    it('should handle missing appname parameter', async () => {
      const req = {
        params: {},
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      messageHelperStub.createErrorMessage.returns({ status: 'error', data: { message: 'No Flux App specified' } });

      await appInstaller.installApplicationAPI(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(logStub.error.called).to.be.true;
    });

    it('should handle app not found error', async () => {
      const req = {
        params: { appname: 'nonexistent' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
        setHeader: sinon.stub(),
      };

      verificationHelperStub.verifyPrivilege.resolves(true);

      messageHelperStub.createErrorMessage.returns({ status: 'error', data: { message: 'Application Specifications of nonexistent not found' } });

      await appInstaller.installApplicationAPI(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(logStub.error.called).to.be.true;
    });
  });

  describe('testInstallApplicationAPI (tests nothing)', () => {
    // How the frontend reads the reply, so the assertions below are the real
    // contract rather than a guess at one: it fails the test on a non-success
    // status, then parses `data` as concatenated JSON and scans each message.
    const FRONTEND_ERROR_PATTERN = /ERROR|FAILED|FATAL|Exception|CRASH|ABORT|terminated|exit code [1-9]/i;
    const FRONTEND_WARNING_PATTERN = /WARNING|WARN|deprecated/i;

    function callEndpoint() {
      const req = { params: { appname: 'testapp' }, query: {} };
      const res = { status: sinon.stub().returnsThis(), json: sinon.stub() };
      messageHelperStub.createDataMessage.callsFake((data) => ({ status: 'success', data }));

      return { req, res, done: appInstaller.testInstallApplicationAPI(req, res) };
    }

    function parseNotice(res) {
      const raw = res.json.firstCall.args[0].data;

      return JSON.parse(`[${raw.replace(/}{/g, '},{')}]`);
    }

    it('answers 200 and success, because payment is gated on it', async () => {
      // A new app reaches the payment step only when this call resolves with a
      // non-error body, so anything else leaves it registerable and unpayable.
      const { res, done } = callEndpoint();
      await done;

      expect(res.status.calledWith(200)).to.be.true;
      expect(res.json.firstCall.args[0].status).to.equal('success');
    });

    it('says nothing was installed, and names what replaced it', async () => {
      const { res, done } = callEndpoint();
      await done;

      const messages = parseNotice(res).map((line) => line.message).join(' ');
      expect(messages).to.include('no longer installs your app');
      expect(messages).to.include('Nothing was installed');
      expect(messages).to.include('/apps/imagepreflight');
      expect(messages).to.include('/apps/playground');
      // Says WHY, so the reason the old answer was worthless travels with it.
      expect(messages).to.include('0.2 CPU and 300MB');
    });

    it('words the notice so the frontend does not read it as a failure', async () => {
      // The frontend scans the text it renders, not just the status field, so
      // describing the withdrawal with a word like "deprecated" or "failed"
      // would gate payment shut - the exact regression this endpoint prevents.
      const { res, done } = callEndpoint();
      await done;

      for (const line of parseNotice(res)) {
        expect(line.status).to.be.oneOf(['info', 'success']);
        expect(FRONTEND_ERROR_PATTERN.test(line.message), `error pattern in: ${line.message}`).to.be.false;
        expect(FRONTEND_WARNING_PATTERN.test(line.message), `warning pattern in: ${line.message}`).to.be.false;
      }
    });

    it('does not consult privilege - the reply is a constant', async () => {
      const { res, done } = callEndpoint();
      await done;

      expect(verificationHelperStub.verifyPrivilege.called).to.be.false;
      expect(res.status.calledWith(200)).to.be.true;
    });
  });

  describe('installApplication tests', () => {
    afterEach(() => {
      operationRegistry.clear();
    });

    it('defers when the app already holds an operation lease', async () => {
      operationRegistry.acquire('testapp', 'remove', 'test');

      const result = await appInstaller.installApplication(testappInstantiated);

      expect(logStub.error.called).to.be.true;
      expect(result.status).to.equal(appInstaller.InstallStatus.DEFERRED);
    });
  });

  describe('post-install broadcast + converge-wait', () => {
    function loadFresh(opts = {}) {
      const {
        converge = { converged: true, failed: [] },
        installAborted = false,
        // teardownOwed: a boolean, or an array consumed per call (interlock first, then the
        // catch / converge-rollback) so a test can pass the entry gate yet trip a later check.
        teardownOwed = false,
        installComponentError = null,
        checkAppDependencyRequirements = sinon.stub().resolves(),
        connectComponentToLinkedApps = sinon.stub().resolves(),
      } = opts;

      const onInstallComplete = sinon.stub().resolves();
      const fluxEventBusPublish = sinon.stub();
      const appReconcilerAwaitConvergence = sinon.stub().resolves(converge);
      const uninstallApplication = sinon.stub().resolves();
      const broadcastMessageToAll = sinon.stub().resolves();
      const storeAppInstallingErrorMessage = sinon.stub().resolves();
      const installComponent = installComponentError
        ? sinon.stub().rejects(installComponentError)
        : sinon.stub().resolves();
      const abortInstall = sinon.stub();
      const teardownOwedFor = sinon.stub();
      if (Array.isArray(teardownOwed)) {
        teardownOwed.forEach((v, i) => teardownOwedFor.onCall(i).resolves(v));
        teardownOwedFor.resolves(teardownOwed[teardownOwed.length - 1] || false);
      } else {
        teardownOwedFor.resolves(teardownOwed);
      }
      // The REAL DeploymentSpec the real deploymentProvider would build for this
      // app on this node — one 'web' component, identifier web_newapp. Everything
      // the installer reads off a deployment (resourceTotals, reservableHostDiskGb,
      // allImages, componentEntries, networkName, linkedApps, telemetry) is the
      // class's own answer, and the unstubbed consumers that read it here —
      // admissionControl.reserve, shutdownPlan.appRequiresDaemonShutdown,
      // telemetrySinkCache.extractSink — run against it for real.
      const deployment = flux.DeploymentSpec.fromSpec(newappSpec, APPS_FOLDER, { replica: null });
      const buildDeployment = sinon.stub().resolves(deployment);
      const resolveDeploymentIdentity = sinon.stub().resolves(null);
      const isImageBlocked = sinon.stub().resolves(false);
      const insertInstalledApp = sinon.stub().resolves({ insertedId: 'id1' });

      const appInstallerFresh = proxyquire.noCallThru().load('../../ZelBack/src/services/appLifecycle/appInstaller', {
        config: configStub,
        '../verificationHelper': verificationHelperStub,
        '../messageHelper': messageHelperStub,
        '../serviceHelper': { ensureString: sinon.stub().returnsArg(0), ensureNumber: sinon.stub().returnsArg(0), delay: sinon.stub().resolves() },
        '../fluxNetworkHelper': {
          getLocalSocketAddress: sinon.stub().resolves('192.168.1.1:16127'),
          getNumberOfPeers: sinon.stub().returns(15),
          isFirewallActive: sinon.stub().resolves(false),
          allowPort: sinon.stub().resolves({ status: true }),
          removeDockerContainerAccessToNonRoutable: sinon.stub().resolves(true),
        },
        '../appNetwork/appDockerNetwork': { ensureAppDockerNetwork: sinon.stub().resolves('net') },
        './appUninstaller': { uninstallApplication },
        './pendingTeardownStore': { teardownOwedFor },
        './componentProvisioner': { installComponent },
        '../utils/globalState': {
          installingApps: new Map(), installAborted: sinon.stub().returns(installAborted), abortInstall, runningAppsCache: new Set(), isArcane: sinon.stub().returns(false),
        },
        // appNetworkLinker.reconnectLinkedApps runs on the success path (the call kept during
        // the rebase); without this stub the install throws before reaching the broadcast.
        './appNetworkLinker': {
          reconnectLinkedApps: sinon.stub().resolves(),
          connectComponentToLinkedApps,
        },
        './relationshipResolver': {
          checkAppDependencyRequirements,
        },
        '../fluxCommunicationMessagesSender': { broadcastMessageToOutgoing: sinon.stub().resolves(), broadcastMessageToIncoming: sinon.stub().resolves(), broadcastMessageToAll },
        '../appMessaging/messageStore': { storeAppInstallingErrorMessage, storeAppRunningMessage: sinon.stub().resolves() },
        '../appSecurity/imageManager': { isImageBlocked, verifyRepository: sinon.stub().resolves({ verified: true, supportedArchitectures: ['amd64'] }) },
        '../pgpService': { decryptMessage: sinon.stub().resolves('user:token') },
        '../../lib/log': logStub,
        '../appDatabase/appsRepository': {
          getGlobalAppInfo: sinon.stub().resolves(null),
          // exists is false before insert (no stale entry) and true after (insert validated).
          existsInstalledApp: (() => { const s = sinon.stub().resolves(true); s.onCall(0).resolves(false); s.onCall(1).resolves(false); return s; })(),
          // Identity-keyed rows: absent before the insert, present for the
          // post-insert validation read.
          existsInstalledIdentity: (() => { const s = sinon.stub().resolves(true); s.onCall(0).resolves(false); s.onCall(1).resolves(false); return s; })(),
          insertInstalledApp,
          removeInstalledApp: sinon.stub().resolves(),
          removeInstalledIdentity: sinon.stub().resolves(),
          // The read-back row: appsRepository hydrates it into an InstantiatedSpec,
          // and the installer feeds it straight back to buildDeployment.
          getInstalledApp: sinon.stub().resolves(newappInstantiated),
          getInstalledIdentity: sinon.stub().resolves(newappInstantiated),
          getTempMessageByName: sinon.stub().resolves(null),
        },
        '../appRuntime/deploymentProvider': {
          listInstalledDeployments: sinon.stub().resolves([]),
          getInstalledDeployment: sinon.stub().resolves(deployment),
          buildDeployment,
          resolveDeploymentIdentity,
        },
        '../utils/fluxEventBus': { publish: fluxEventBusPublish },
        '../appMonitoring/appReconciler': { awaitConvergence: appReconcilerAwaitConvergence },
        '../utils/cpuBurstHelper': { getCpuBurstAllowance: sinon.stub().returns(0), isEnterpriseOwner: sinon.stub().returns(false), isCpuBurstSupported: sinon.stub().resolves(false) },
        '../appRequirements/hwRequirements': hwRequirementsStub,
      });

      appInstallerFresh.setOnInstallComplete(onInstallComplete);
      return {
        installer: appInstallerFresh,
        deployment,
        onInstallComplete,
        fluxEventBusPublish,
        appReconcilerAwaitConvergence,
        uninstallApplication,
        broadcastMessageToAll,
        storeAppInstallingErrorMessage,
        installComponent,
        abortInstall,
        teardownOwedFor,
        buildDeployment,
        resolveDeploymentIdentity,
        isImageBlocked,
        insertInstalledApp,
        checkAppDependencyRequirements,
        connectComponentToLinkedApps,
      };
    }

    // Every test below installs `newappInstantiated` — a real InstantiatedSpec over a
    // real cleartext FluxAppSpecV9. Its name, owner, hash, placement, requiresArcane()
    // and serialize() are the classes' own, so nothing here can be written to a shape
    // the real object does not have.

    it('rejects an Arcane-requiring app on a non-Arcane node before any provisioning', async () => {
      const { installer, installComponent } = loadFresh({ converge: { converged: true, failed: [] } });

      // A node-sealed spec, not a stubbed predicate: encrypted IS Arcane-only.
      const result = await installer.installApplication(arcaneInstantiated, {});

      expect(result.status).to.equal(installer.InstallStatus.REJECTED);
      expect(result.reason).to.include('ArcaneOS');
      expect(installComponent.called, 'nothing may be provisioned').to.be.false;
    });

    it('runs onInstallComplete/app:installed and hands off to the reconciler on a successful install', async () => {
      const {
        installer, onInstallComplete, fluxEventBusPublish, appReconcilerAwaitConvergence,
      } = loadFresh({ converge: { converged: true, failed: [] } });

      const result = await installer.installApplication(newappInstantiated, {});

      expect(result.status, 'install succeeded').to.equal(appInstaller.InstallStatus.INSTALLED);
      expect(onInstallComplete.calledOnce, 'post-install broadcast fired').to.be.true;
      expect(fluxEventBusPublish.calledWith('app:installed'), 'app:installed event published').to.be.true;
      expect(appReconcilerAwaitConvergence.calledOnce, 'install handed off + awaited reconciler convergence').to.be.true;
    });

    // Using the real classes is not enough on its own. Every collaborator the
    // installer hands a spec or a deployment to is stubbed here, so nothing
    // exercises what the REAL one would do with the object it received — a
    // delegation could disappear from flux-spec with this suite still green. So
    // read each argument back off its stub and call what the real one calls.
    it('hands each stubbed collaborator an object that answers what the real one asks', async () => {
      const {
        installer, deployment, installComponent, buildDeployment, resolveDeploymentIdentity,
        checkAppDependencyRequirements, connectComponentToLinkedApps, isImageBlocked,
        insertInstalledApp, appReconcilerAwaitConvergence,
      } = loadFresh({ converge: { converged: true, failed: [] } });

      const result = await installer.installApplication(newappInstantiated, {});
      expect(result.status, 'the whole install path must run for these to mean anything')
        .to.equal(appInstaller.InstallStatus.INSTALLED);

      // hwRequirements.checkPlacement reads spec.placement and asks it these three,
      // plus the name and owner it names in its refusals.
      const [placed] = hwRequirementsStub.checkPlacement.firstCall.args;
      assertAnswers(placed.placement, ['mode', 'hasTargets', 'hasGeoRestrictions']);
      expect(placed.name).to.equal('newapp');

      // deploymentProvider.resolveDeploymentIdentity resolves the readable spec view
      // and asks its placement for the mode before it reads the assignment.
      const [identified] = resolveDeploymentIdentity.firstCall.args;
      assertAnswers(identified.spec.placement, ['mode']);

      // relationshipResolver.checkAppDependencyRequirements resolves the same view
      // and reads the app's dependency edges off it.
      const [depChecked] = checkAppDependencyRequirements.firstCall.args;
      assertAnswers(depChecked.spec, ['dependencyEntries']);

      // deploymentProvider.buildDeployment projects the view into a DeploymentSpec —
      // so run the real construction the stub is standing in for.
      const [built, buildOpts] = buildDeployment.firstCall.args;
      expect(buildOpts).to.have.property('replica', null);
      expect(() => flux.DeploymentSpec.fromSpec(built.spec, APPS_FOLDER, { replica: null }))
        .to.not.throw();

      // The blocklist is asked about the deployment's own images.
      expect(isImageBlocked.firstCall.args[1]).to.deep.equal(['nginx:latest']);

      // componentProvisioner.installComponent receives a real DeploymentComponent and
      // interrogates it (TLS, rootFs budget) before handing it to dockerService, which
      // projects the docker create options off the same object.
      const [component, componentOpts] = installComponent.firstCall.args;
      assertAnswers(component, [
        'requiresBackendTls', 'backendTlsPaths', 'imageFitsRootFs',
        'toDockerEnv', 'toDockerPortBindings', 'toDockerExposedPorts',
        'toDockerNanoCpus', 'toDockerMemoryBytes', 'restartPolicyName',
      ]);
      expect(component.identifier).to.equal('web_newapp');
      // installComponent refuses a blank owner outright — a stamped-empty
      // runonflux.owner label silently breaks drain/preStop at node shutdown.
      expect(componentOpts.owner).to.equal(newappInstantiated.owner);

      // appNetworkLinker.connectComponentToLinkedApps reads the deployment's links
      // and its app name for the deferral it raises when one has vanished.
      const [linkedId, linkedDeployment, aliases] = connectComponentToLinkedApps.firstCall.args;
      expect(linkedId).to.equal('web_newapp');
      expect(linkedDeployment.linkedApps).to.be.an('array');
      expect(linkedDeployment.appName).to.equal('newapp');
      expect(aliases).to.be.an('array');

      // The stored row is the spec's own serialization, and the identifiers the
      // reconciler is later asked to converge come from the same deployment.
      const [dbSpecs, replica, componentIdentifiers] = insertInstalledApp.firstCall.args;
      expect(dbSpecs).to.deep.equal(newappInstantiated.serialize());
      expect(replica).to.equal(null);
      expect(componentIdentifiers).to.deep.equal(['web_newapp']);
      expect(deployment.componentEntries().map(([name]) => name)).to.deep.equal(['web']);
      expect(appReconcilerAwaitConvergence.firstCall.args[0]).to.deep.equal(['web_newapp']);
    });

    it('rolls back and returns PROVISIONED-BUT-NOT-RUNNING when a component fails to converge', async () => {
      const { installer, uninstallApplication } = loadFresh({ converge: { converged: false, failed: ['web_newapp'] } });

      const result = await installer.installApplication(newappInstantiated, {});

      expect(result.status, 'install failed the converge-wait').to.equal(appInstaller.InstallStatus.FAILED);
      expect(result.reason).to.include('PROVISIONED-BUT-NOT-RUNNING');
      expect(uninstallApplication.calledWith('newapp'), 'a non-converging install is rolled back').to.be.true;
    });

    it('stores + broadcasts fluxappinstallingerror when the install trial fails — the network must learn', async () => {
      const {
        installer, storeAppInstallingErrorMessage, broadcastMessageToAll,
      } = loadFresh({ converge: { converged: false, failed: ['web_newapp'] } });

      await installer.installApplication(newappInstantiated, {});

      expect(storeAppInstallingErrorMessage.calledOnce, 'error stored locally (feeds error counting)').to.be.true;
      const stored = storeAppInstallingErrorMessage.firstCall.args[0];
      expect(stored.type).to.equal('fluxappinstallingerror');
      expect(stored.name).to.equal('newapp');
      expect(stored.hash).to.equal('hash1');
      expect(broadcastMessageToAll.calledOnceWith(stored), 'the same message is broadcast to peers').to.be.true;
    });

    // cancel-vs-install: a cancel/expiry of an app racing its own install must DEFER the
    // install (retry later), never FAIL it — a FAILED status 7-day-poisons the spawner cache
    // and strands a pinned enterprise app. These guard the classification at each gate.
    describe('cancel-vs-install classification', () => {
      it('install-side interlock: defers (not installs) when a teardown is already owed', async () => {
        const { installer, installComponent } = loadFresh({ teardownOwed: true });

        const result = await installer.installApplication(newappInstantiated, {});

        expect(result.status, 'deferred, not installed/failed').to.equal(appInstaller.InstallStatus.DEFERRED);
        expect(installComponent.called, 'never provisioned anything').to.be.false;
      });

      it('classifies a cancel-aborted install as DEFERRED — no teardown, no network-wide error broadcast', async () => {
        const {
          installer, uninstallApplication, broadcastMessageToAll, storeAppInstallingErrorMessage,
        } = loadFresh({
          installAborted: true, // the cancel latched the abort signal mid-install
          installComponentError: new Error('pull aborted'),
        });

        const result = await installer.installApplication(newappInstantiated, {});

        expect(result.status, 'a cancel-unwind defers, never fails').to.equal(appInstaller.InstallStatus.DEFERRED);
        expect(uninstallApplication.called, 'does NOT run its own teardown (the cancel owns it)').to.be.false;
        expect(broadcastMessageToAll.called, 'no fluxappinstallingerror broadcast for a deliberately torn-down app').to.be.false;
        expect(storeAppInstallingErrorMessage.called, 'no install-error stored either').to.be.false;
      });

      it('classifies a transient registry failure as DEFERRED — cleanup runs, nothing stored or broadcast', async () => {
        const {
          installer, uninstallApplication, broadcastMessageToAll, storeAppInstallingErrorMessage,
        } = loadFresh({
          installComponentError: Object.assign(new Error('dial tcp: connection refused'), { registryErrorClass: 'transient' }),
        });

        const result = await installer.installApplication(newappInstantiated, {});

        expect(result.status, 'a could-not-ask answer defers, never fails').to.equal(appInstaller.InstallStatus.DEFERRED);
        expect(uninstallApplication.called, 'the partial install is still cleaned up').to.be.true;
        expect(storeAppInstallingErrorMessage.called, 'no install-error stored - not a verdict on the app').to.be.false;
        expect(broadcastMessageToAll.called, 'no fluxappinstallingerror broadcast').to.be.false;
      });

      it('classifies an unissuable backend-TLS cert as DEFERRED — cleanup runs, nothing stored or broadcast', async () => {
        // Without the cert the app cannot serve the HTTPS its spec promises, so the
        // install aborts rather than leaving a container up and serving nothing that
        // peers would count as a live instance. The app itself is blameless, so this
        // defers and lets it place on a node that can provision it.
        const {
          installer, uninstallApplication, broadcastMessageToAll, storeAppInstallingErrorMessage,
        } = loadFresh({
          installComponentError: Object.assign(new Error('Could not provision the backend-TLS certificate for web_newapp: signer unreachable'), { code: 'BACKEND_TLS_UNAVAILABLE' }),
        });

        const result = await installer.installApplication(newappInstantiated, {});

        expect(result.status, 'a node that cannot sign defers, never fails').to.equal(appInstaller.InstallStatus.DEFERRED);
        expect(uninstallApplication.called, 'the partial install is still cleaned up').to.be.true;
        expect(storeAppInstallingErrorMessage.called, 'no install-error stored - not a verdict on the app').to.be.false;
        expect(broadcastMessageToAll.called, 'no fluxappinstallingerror broadcast').to.be.false;
      });

      it('a genuine install failure (no cancel) still FAILS, tears down, and broadcasts the error', async () => {
        const {
          installer, uninstallApplication, broadcastMessageToAll,
        } = loadFresh({
          installAborted: false,
          teardownOwed: false,
          installComponentError: new Error('image pull 500'),
        });

        const result = await installer.installApplication(newappInstantiated, {});

        expect(result.status, 'a real failure fails').to.equal(appInstaller.InstallStatus.FAILED);
        expect(uninstallApplication.calledWith('newapp'), 'a real failure rolls back').to.be.true;
        expect(broadcastMessageToAll.called, 'a real failure broadcasts the install error').to.be.true;
      });

      // The headline defect: a free playground session held capacity, the gate
      // threw, the installer returned FAILED, and the spawner benched the app's
      // hash for SEVEN DAYS. A fifteen-minute session cost a paid app a week.
      describe('capacity held by reclaimable work', () => {
        const admissionControl = require('../../ZelBack/src/services/utils/admissionControl');

        afterEach(() => {
          admissionControl.setReclaimer(null);
          admissionControl.clear();
        });

        it('DEFERS and asks for the capacity back when a session is the only obstacle', async () => {
          // Short on the plain reading, fits once the reclaimable share is added back.
          hwRequirementsStub.capacityShortfall
            .onFirstCall().returns('Not enough cpu')
            .onSecondCall().returns(null);
          const asked = [];
          admissionControl.setReclaimer(async (totals) => { asked.push(totals); });

          const { installer, installComponent } = loadFresh();
          const result = await installer.installApplication(newappInstantiated, {});

          expect(result.status, 'DEFERRED — FAILED is the 7-day poison').to.equal(appInstaller.InstallStatus.DEFERRED);
          expect(asked.length, 'asked for the capacity back').to.equal(1);
          expect(installComponent.called, 'provisioned nothing').to.be.false;
        });

        it('still FAILS when the node is genuinely too small, reclaim or not', async () => {
          // Short on both readings: no session is holding it, the app does not fit.
          hwRequirementsStub.capacityShortfall.returns('Not enough cpu');
          const asked = [];
          admissionControl.setReclaimer(async (totals) => { asked.push(totals); });

          const { installer } = loadFresh();
          const result = await installer.installApplication(newappInstantiated, {});

          expect(result.status).to.equal(appInstaller.InstallStatus.FAILED);
          expect(asked.length, 'nothing to reclaim, so nothing asked').to.equal(0);
        });

        it('does not hold the admission lock across the reclaim', async () => {
          // AsyncLock force-releases a slot held past 60s, so reclaiming under it
          // would silently drop the check-and-reserve atomicity. The reclaimer
          // must therefore be able to take the lock itself while it runs.
          hwRequirementsStub.capacityShortfall
            .onFirstCall().returns('Not enough cpu')
            .onSecondCall().returns(null);
          let lockWasFree = false;
          admissionControl.setReclaimer(async () => {
            await admissionControl.withLock(async () => { lockWasFree = true; });
          });

          const { installer } = loadFresh();
          await installer.installApplication(newappInstantiated, {});

          expect(lockWasFree, 'the lock was free while reclaiming').to.equal(true);
        });
      });

      it('defers (not fails) when a dependency is not installed yet — no mutation, no rollback', async () => {
        const notReady = Object.assign(new Error("App 'collector' that 'newapp' depends on is not installed on this node. Installation aborted."), { code: 'NETWORK_DEPENDENCY_NOT_READY' });
        const {
          installer, installComponent, uninstallApplication, broadcastMessageToAll,
        } = loadFresh({
          checkAppDependencyRequirements: sinon.stub().rejects(notReady),
        });

        const result = await installer.installApplication(newappInstantiated, {});

        expect(result.status, 'a missing dependency defers, never fails').to.equal(appInstaller.InstallStatus.DEFERRED);
        expect(result.reason).to.include('is not installed on this node');
        expect(installComponent.called, 'never provisioned anything').to.be.false;
        expect(uninstallApplication.called, 'nothing to roll back').to.be.false;
        expect(broadcastMessageToAll.called, 'no install-error broadcast for a transient ordering condition').to.be.false;
      });

      it('a code-less network-requirement error (owner mismatch) still fails hard', async () => {
        const { installer, installComponent } = loadFresh({
          checkAppDependencyRequirements: sinon.stub().rejects(new Error("App 'collector' that 'newapp' depends on is owned by a different owner. Installation aborted.")),
        });

        const result = await installer.installApplication(newappInstantiated, {});

        expect(result.status, 'a misconfiguration is a real failure').to.equal(appInstaller.InstallStatus.FAILED);
        expect(installComponent.called, 'never provisioned anything').to.be.false;
      });

      it('defers (not fails) when a linked dependency vanishes MID-install — cleans up, no error broadcast', async () => {
        // Passes the pre-check, then the attach at connect-time finds the dependency's
        // network gone (reaped, or the dep's own cancel/expiry completed mid-install).
        const notReady = Object.assign(new Error("Linked app network fluxDockerNetwork_collector for 'newapp' disappeared during install; deferring"), { code: 'NETWORK_DEPENDENCY_NOT_READY' });
        const {
          installer, uninstallApplication, broadcastMessageToAll, storeAppInstallingErrorMessage,
        } = loadFresh({
          installAborted: false,
          teardownOwed: false,
          connectComponentToLinkedApps: sinon.stub().rejects(notReady),
        });

        const result = await installer.installApplication(newappInstantiated, {});

        expect(result.status, 'a mid-install dep-vanish defers, never fails').to.equal(appInstaller.InstallStatus.DEFERRED);
        expect(uninstallApplication.calledWith('newapp'), 'the partial install is cleaned up').to.be.true;
        expect(broadcastMessageToAll.called, 'no network-wide install error for a transient').to.be.false;
        expect(storeAppInstallingErrorMessage.called, 'no install-error stored either').to.be.false;
      });

      it('converge-rollback: a cancel landing during convergence defers instead of poisoning', async () => {
        const { installer, uninstallApplication } = loadFresh({
          converge: { converged: false, failed: ['web_newapp'] },
          // false at the entry interlock, true at the converge-rollback re-check
          teardownOwed: [false, true],
        });

        const result = await installer.installApplication(newappInstantiated, {});

        expect(result.status, 'cancel during converge defers').to.equal(appInstaller.InstallStatus.DEFERRED);
        expect(uninstallApplication.called, 'no rollback teardown — the cancel owns it').to.be.false;
      });
    });
  });

});
