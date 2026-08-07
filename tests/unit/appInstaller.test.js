const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
// Real registry singleton - un-stubbed in proxyquire, so the installer and the test share it.
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');

describe('appInstaller tests', () => {
  let appInstaller;
  let verificationHelperStub;
  let messageHelperStub;
  let logStub;
  let configStub;
  let hwRequirementsStub;

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
      '../appMonitoring/appReconciler': { enqueue: sinon.stub(), awaitConvergence: sinon.stub().resolves({ converged: true, failed: [] }) },
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
        checkAppNetworkRequirements: sinon.stub().resolves(),
        connectComponentToLinkedApps: sinon.stub().resolves(),
        reconnectLinkedApps: sinon.stub().resolves(),
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
    const mockInstantiatedSpec = {
      name: 'testapp',
      spec: {
        version: 2,
        name: 'testapp',
        componentEntries: () => [],
      },
      isEncrypted: false,
      requiresArcane: () => false,
      serialize: () => ({
        version: 2,
        name: 'testapp',
      }),
    };

    afterEach(() => {
      operationRegistry.clear();
    });

    it('defers when the app already holds an operation lease', async () => {
      operationRegistry.acquire('testapp', 'remove', 'test');

      const result = await appInstaller.installApplication(mockInstantiatedSpec);

      expect(logStub.error.called).to.be.true;
      expect(result.status).to.equal(appInstaller.InstallStatus.DEFERRED);
    });
  });

  describe('post-install broadcast + converge-wait', () => {
    // The one component every fresh-install path provisions. Carries just the surface
    // installApplication reads: ports/image, the content predicates, the syslog env scan.
    const mockComponent = {
      identifier: 'web_newapp',
      name: 'web',
      appName: 'newapp',
      hostPorts: [],
      image: 'nginx:latest',
      hasContentBlobs: () => false,
      hasContentSlots: () => false,
      toDockerEnv: () => [],
    };

    function loadFresh(opts = {}) {
      const {
        converge = { converged: true, failed: [] },
        installAborted = false,
        // teardownOwed: a boolean, or an array consumed per call (interlock first, then the
        // catch / converge-rollback) so a test can pass the entry gate yet trip a later check.
        teardownOwed = false,
        installComponentError = null,
        components = [],
        checkAppNetworkRequirements = sinon.stub().resolves(),
        connectComponentToLinkedApps = sinon.stub().resolves(),
      } = opts;

      const onInstallComplete = sinon.stub().resolves();
      const fluxEventBusPublish = sinon.stub();
      const appReconcilerEnqueue = sinon.stub();
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
      const deployment = {
        resourceTotals: () => ({ cpu: 1, memoryMb: 500, storageGb: 10 }),
        reservableHostDiskGb: () => 10,
        allHostPorts: () => [],
        allImages: () => [],
        componentEntries: () => components,
      };

      const appInstallerFresh = proxyquire.noCallThru().load('../../ZelBack/src/services/appLifecycle/appInstaller', {
        config: configStub,
        '../verificationHelper': verificationHelperStub,
        '../messageHelper': messageHelperStub,
        '../dbHelper': {
          databaseConnection: sinon.stub().returns({ db: sinon.stub().returns({}) }),
          findInDatabase: sinon.stub().resolves([]),
          findOneInDatabase: sinon.stub().resolves(null),
          insertOneToDatabase: sinon.stub().resolves(),
        },
        '../serviceHelper': { ensureString: sinon.stub().returnsArg(0), ensureNumber: sinon.stub().returnsArg(0), delay: sinon.stub().resolves() },
        '../generalService': { nodeTier: sinon.stub().resolves('cumulus'), checkSynced: sinon.stub().resolves(true) },
        '../fluxNetworkHelper': {
          getLocalSocketAddress: sinon.stub().resolves('192.168.1.1:16127'),
          getNumberOfPeers: sinon.stub().returns(15),
          isFirewallActive: sinon.stub().resolves(false),
          allowPort: sinon.stub().resolves({ status: true }),
          removeDockerContainerAccessToNonRoutable: sinon.stub().resolves(true),
        },
        '../geolocationService': { isStaticIP: sinon.stub().returns(true) },
        '../appNetwork/appDockerNetwork': { ensureAppDockerNetwork: sinon.stub().resolves('net') },
        '../dockerService': {
          dockerListContainers: sinon.stub().resolves([]),
          pruneContainers: sinon.stub().resolves(),
          pruneNetworks: sinon.stub().resolves(),
          pruneVolumes: sinon.stub().resolves(),
          pruneImages: sinon.stub().resolves(),
          createFluxAppDockerNetwork: sinon.stub().resolves('net'),
          getFluxDockerNetworkPhysicalInterfaceNames: sinon.stub().resolves([]),
          appDockerCreate: sinon.stub().resolves(),
          appDockerImageSize: sinon.stub().resolves(0),
          appDockerStart: sinon.stub().resolves('ok'),
          getAppIdentifier: sinon.stub().returns('newapp'),
          dockerPullStream: sinon.stub().yields(null, 'pulled'),
        },
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
          checkAppNetworkRequirements,
          connectComponentToLinkedApps,
        },
        '../fluxCommunicationMessagesSender': { broadcastMessageToOutgoing: sinon.stub().resolves(), broadcastMessageToIncoming: sinon.stub().resolves(), broadcastMessageToAll },
        '../appMessaging/messageStore': { storeAppInstallingErrorMessage, storeAppRunningMessage: sinon.stub().resolves() },
        '../appSecurity/imageManager': { isImageBlocked: sinon.stub().resolves(false), verifyRepository: sinon.stub().resolves({ verified: true, supportedArchitectures: ['amd64'] }) },
        '../appManagement/appInspector': { startAppMonitoring: sinon.stub() },
        '../pgpService': { decryptMessage: sinon.stub().resolves('user:token') },
        '../upnpService': { isUPNP: sinon.stub().returns(false), mapUpnpPort: sinon.stub().resolves(true) },
        '../../lib/log': logStub,
        '../utils/appConstants': proxyquire('../../ZelBack/src/services/utils/appConstants', { config: configStub }),
        '../appDatabase/appsRepository': {
          getGlobalAppInfo: sinon.stub().resolves(null),
          // exists is false before insert (no stale entry) and true after (insert validated).
          existsInstalledApp: (() => { const s = sinon.stub().resolves(true); s.onCall(0).resolves(false); s.onCall(1).resolves(false); return s; })(),
          // Identity-keyed rows: absent before the insert, present for the
          // post-insert validation read.
          existsInstalledIdentity: (() => { const s = sinon.stub().resolves(true); s.onCall(0).resolves(false); s.onCall(1).resolves(false); return s; })(),
          insertInstalledApp: sinon.stub().resolves({ insertedId: 'id1' }),
          removeInstalledApp: sinon.stub().resolves(),
          removeInstalledIdentity: sinon.stub().resolves(),
          getInstalledApp: sinon.stub().resolves({ name: 'newapp' }),
          getInstalledIdentity: sinon.stub().resolves({ name: 'newapp' }),
          getTempMessageByName: sinon.stub().resolves(null),
        },
        '../appRuntime/deploymentProvider': {
          listInstalledDeployments: sinon.stub().resolves([]),
          getInstalledDeployment: sinon.stub().resolves(deployment),
          buildDeployment: sinon.stub().resolves(deployment),
          resolveDeploymentIdentity: sinon.stub().resolves(null),
        },
        './appVolumeService': { createAppVolume: sinon.stub().resolves() },
        '../utils/specLibs': { getSpecBackend: sinon.stub().resolves({}) },
        '../utils/appUtilities': { findCommonArchitectures: sinon.stub().returns(['amd64']) },
        '../utils/fluxEventBus': { publish: fluxEventBusPublish },
        '../appMonitoring/appReconciler': { enqueue: appReconcilerEnqueue, awaitConvergence: appReconcilerAwaitConvergence },
        '../utils/cpuBurstHelper': { getCpuBurstAllowance: sinon.stub().returns(0), isEnterpriseOwner: sinon.stub().returns(false), isCpuBurstSupported: sinon.stub().resolves(false) },
        '../utils/volumeService': { verifyAppVolumeMount: sinon.stub().resolves() },
        '../appRequirements/hwRequirements': hwRequirementsStub,
        '../appQuery/appQueryService': { listRunningApps: sinon.stub().resolves({ status: 'success', data: [] }) },
        '../utils/registryCredentialHelper': { getCredentials: sinon.stub().resolves(null) },
      });

      appInstallerFresh.setOnInstallComplete(onInstallComplete);
      return {
        installer: appInstallerFresh,
        onInstallComplete,
        fluxEventBusPublish,
        appReconcilerAwaitConvergence,
        uninstallApplication,
        broadcastMessageToAll,
        storeAppInstallingErrorMessage,
        installComponent,
        abortInstall,
        teardownOwedFor,
      };
    }

    const mockPlacement = {
      staticIp: false, dataCenter: false, hasGeoRestrictions: () => false, hasTargets: () => false,
    };
    const mockInstantiated = {
      name: 'newapp',
      version: 2,
      hash: 'hash1',
      owner: 'owner1',
      placement: mockPlacement,
      spec: { version: 2, name: 'newapp', placement: mockPlacement, componentEntries: () => [] },
      isEncrypted: false,
      requiresArcane: () => false,
      serialize: () => ({ version: 2, name: 'newapp' }),
    };

    it('rejects an Arcane-requiring app on a non-Arcane node before any provisioning', async () => {
      const { installer, installComponent } = loadFresh({ converge: { converged: true, failed: [] }, components: [['web', mockComponent]] });

      const result = await installer.installApplication({ ...mockInstantiated, requiresArcane: () => true }, {});

      expect(result.status).to.equal(installer.InstallStatus.REJECTED);
      expect(result.reason).to.include('ArcaneOS');
      expect(installComponent.called, 'nothing may be provisioned').to.be.false;
    });

    it('runs onInstallComplete/app:installed and hands off to the reconciler on a successful install', async () => {
      const {
        installer, onInstallComplete, fluxEventBusPublish, appReconcilerAwaitConvergence,
      } = loadFresh({ converge: { converged: true, failed: [] }, components: [['web', mockComponent]] });

      const result = await installer.installApplication(mockInstantiated, {});

      expect(result.status, 'install succeeded').to.equal(appInstaller.InstallStatus.INSTALLED);
      expect(onInstallComplete.calledOnce, 'post-install broadcast fired').to.be.true;
      expect(fluxEventBusPublish.calledWith('app:installed'), 'app:installed event published').to.be.true;
      expect(appReconcilerAwaitConvergence.calledOnce, 'install handed off + awaited reconciler convergence').to.be.true;
    });

    it('rolls back and returns PROVISIONED-BUT-NOT-RUNNING when a component fails to converge', async () => {
      const { installer, uninstallApplication } = loadFresh({ converge: { converged: false, failed: ['web_newapp'] }, components: [['web', mockComponent]] });

      const result = await installer.installApplication(mockInstantiated, {});

      expect(result.status, 'install failed the converge-wait').to.equal(appInstaller.InstallStatus.FAILED);
      expect(result.reason).to.include('PROVISIONED-BUT-NOT-RUNNING');
      expect(uninstallApplication.calledWith('newapp'), 'a non-converging install is rolled back').to.be.true;
    });

    it('stores + broadcasts fluxappinstallingerror when the install trial fails — the network must learn', async () => {
      const {
        installer, storeAppInstallingErrorMessage, broadcastMessageToAll,
      } = loadFresh({ converge: { converged: false, failed: ['web_newapp'] }, components: [['web', mockComponent]] });

      await installer.installApplication(mockInstantiated, {});

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
        const { installer, installComponent } = loadFresh({ teardownOwed: true, components: [['web', mockComponent]] });

        const result = await installer.installApplication(mockInstantiated, {});

        expect(result.status, 'deferred, not installed/failed').to.equal(appInstaller.InstallStatus.DEFERRED);
        expect(installComponent.called, 'never provisioned anything').to.be.false;
      });

      it('classifies a cancel-aborted install as DEFERRED — no teardown, no network-wide error broadcast', async () => {
        const {
          installer, uninstallApplication, broadcastMessageToAll, storeAppInstallingErrorMessage,
        } = loadFresh({
          installAborted: true, // the cancel latched the abort signal mid-install
          installComponentError: new Error('pull aborted'),
          components: [['web', mockComponent]],
        });

        const result = await installer.installApplication(mockInstantiated, {});

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
          components: [['web', mockComponent]],
        });

        const result = await installer.installApplication(mockInstantiated, {});

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
          components: [['web', mockComponent]],
        });

        const result = await installer.installApplication(mockInstantiated, {});

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
          components: [['web', mockComponent]],
        });

        const result = await installer.installApplication(mockInstantiated, {});

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

          const { installer, installComponent } = loadFresh({ components: [['web', mockComponent]] });
          const result = await installer.installApplication(mockInstantiated, {});

          expect(result.status, 'DEFERRED — FAILED is the 7-day poison').to.equal(appInstaller.InstallStatus.DEFERRED);
          expect(asked.length, 'asked for the capacity back').to.equal(1);
          expect(installComponent.called, 'provisioned nothing').to.be.false;
        });

        it('still FAILS when the node is genuinely too small, reclaim or not', async () => {
          // Short on both readings: no session is holding it, the app does not fit.
          hwRequirementsStub.capacityShortfall.returns('Not enough cpu');
          const asked = [];
          admissionControl.setReclaimer(async (totals) => { asked.push(totals); });

          const { installer } = loadFresh({ components: [['web', mockComponent]] });
          const result = await installer.installApplication(mockInstantiated, {});

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

          const { installer } = loadFresh({ components: [['web', mockComponent]] });
          await installer.installApplication(mockInstantiated, {});

          expect(lockWasFree, 'the lock was free while reclaiming').to.equal(true);
        });
      });

      it('defers (not fails) when a shareWith dependency is not installed yet — no mutation, no rollback', async () => {
        const notReady = Object.assign(new Error("App 'collector' that 'newapp' must be networked with is not installed on this node. Installation aborted."), { code: 'NETWORK_DEPENDENCY_NOT_READY' });
        const {
          installer, installComponent, uninstallApplication, broadcastMessageToAll,
        } = loadFresh({
          checkAppNetworkRequirements: sinon.stub().rejects(notReady),
          components: [['web', mockComponent]],
        });

        const result = await installer.installApplication(mockInstantiated, {});

        expect(result.status, 'a missing dependency defers, never fails').to.equal(appInstaller.InstallStatus.DEFERRED);
        expect(result.reason).to.include('is not installed on this node');
        expect(installComponent.called, 'never provisioned anything').to.be.false;
        expect(uninstallApplication.called, 'nothing to roll back').to.be.false;
        expect(broadcastMessageToAll.called, 'no install-error broadcast for a transient ordering condition').to.be.false;
      });

      it('a code-less network-requirement error (owner mismatch) still fails hard', async () => {
        const { installer, installComponent } = loadFresh({
          checkAppNetworkRequirements: sinon.stub().rejects(new Error("App 'collector' that 'newapp' must be networked with is owned by a different owner. Installation aborted.")),
          components: [['web', mockComponent]],
        });

        const result = await installer.installApplication(mockInstantiated, {});

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
          components: [['web', mockComponent]],
        });

        const result = await installer.installApplication(mockInstantiated, {});

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
          components: [['web', mockComponent]],
        });

        const result = await installer.installApplication(mockInstantiated, {});

        expect(result.status, 'cancel during converge defers').to.equal(appInstaller.InstallStatus.DEFERRED);
        expect(uninstallApplication.called, 'no rollback teardown — the cancel owns it').to.be.false;
      });
    });
  });

});
