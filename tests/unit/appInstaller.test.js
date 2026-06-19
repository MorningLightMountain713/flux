const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
// Real registry singleton - un-stubbed in proxyquire, so the installer and the test share it.
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');

describe('appInstaller tests', () => {
  let appInstaller;
  let verificationHelperStub;
  let messageHelperStub;
  let dbHelperStub;
  let logStub;
  let configStub;
  let hwRequirementsStub;
  let appsRepositoryStub;

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
            appsLocations: 'appsLocations',
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

    dbHelperStub = {
      databaseConnection: sinon.stub(),
      findInDatabase: sinon.stub(),
      findOneInDatabase: sinon.stub(),
      insertOneToDatabase: sinon.stub(),
    };

    hwRequirementsStub = {
      systemArchitecture: sinon.stub().resolves('amd64'),
      checkPlacement: sinon.stub().resolves(),
      checkNodeResources: sinon.stub().resolves(),
    };

    appsRepositoryStub = {
      getGlobalAppInfo: sinon.stub().resolves(null),
      existsInstalledApp: sinon.stub().resolves(false),
      getTempMessageByName: sinon.stub().resolves(null),
    };

    logStub = {
      error: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
    };

    // Proxy require
    appInstaller = proxyquire('../../ZelBack/src/services/appLifecycle/appInstaller', {
      config: configStub,
      '../verificationHelper': verificationHelperStub,
      '../messageHelper': messageHelperStub,
      '../dbHelper': dbHelperStub,
      '../serviceHelper': {
        ensureString: sinon.stub().returnsArg(0),
        ensureNumber: sinon.stub().returnsArg(0),
        delay: sinon.stub().resolves(),
      },
      '../generalService': {
        nodeTier: sinon.stub().resolves('cumulus'),
        checkSynced: sinon.stub().resolves(true),
      },
      '../benchmarkService': {
        getBenchmarks: sinon.stub().resolves({
          status: 'success',
          data: { ipaddress: '192.168.1.1' },
        }),
      },
      '../daemonService/daemonServiceMiscRpcs': {
        isDaemonSynced: sinon.stub().returns({
          status: 'success',
          data: { synced: true, height: 2094961 },
        }),
      },
      '../fluxNetworkHelper': {
        getNumberOfPeers: sinon.stub().returns(15),
        isFirewallActive: sinon.stub().resolves(false),
        allowPort: sinon.stub().resolves({ status: true }),
        removeDockerContainerAccessToNonRoutable: sinon.stub().resolves(true),
        getLocalSocketAddress: sinon.stub().resolves('192.168.1.1:16127'),
      },
      '../geolocationService': {
        isStaticIP: sinon.stub().returns(true),
      },
      '../dockerService': {
        dockerListContainers: sinon.stub().resolves([]),
        pruneContainers: sinon.stub().resolves(),
        pruneNetworks: sinon.stub().resolves(),
        pruneVolumes: sinon.stub().resolves(),
        pruneImages: sinon.stub().resolves(),
        createFluxAppDockerNetwork: sinon.stub().resolves('network-created'),
        getFluxDockerNetworkPhysicalInterfaceNames: sinon.stub().resolves([]),
        appDockerCreate: sinon.stub().resolves(),
        appDockerImageSize: sinon.stub().resolves(0),
        appDockerStart: sinon.stub().resolves('container-started'),
        getAppIdentifier: sinon.stub().returns('testapp'),
        dockerPullStream: sinon.stub().yields(null, 'pulled'),
      },
      './appUninstaller': {
        uninstallApplication: sinon.stub().resolves(),
      },
      '../fluxCommunicationMessagesSender': {
        broadcastMessageToOutgoing: sinon.stub().resolves(),
        broadcastMessageToIncoming: sinon.stub().resolves(),
      },
      '../appMessaging/messageStore': {
        storeAppInstallingErrorMessage: sinon.stub().resolves(),
      },
      '../appSystem/systemIntegration': {
        systemArchitecture: sinon.stub().resolves('amd64'),
      },
      '../appSecurity/imageManager': {
        isImageBlocked: sinon.stub().resolves(false),
        verifyRepository: sinon.stub().resolves({
          verified: true,
          supportedArchitectures: ['amd64', 'arm64'],
        }),
      },
      '../appManagement/appInspector': {
        startAppMonitoring: sinon.stub(),
      },
      '../utils/imageVerifier': {
        ImageVerifier: sinon.stub().returns({
          addCredentials: sinon.stub(),
          verifyImage: sinon.stub().resolves(),
          throwIfError: sinon.stub(),
          supported: true,
          provider: 'docker.io',
        }),
      },
      '../pgpService': {
        decryptMessage: sinon.stub().resolves('user:token'),
      },
      '../upnpService': {
        isUPNP: sinon.stub().returns(false),
        mapUpnpPort: sinon.stub().resolves(true),
      },
      '../../lib/log': logStub,
      '../utils/appConstants': proxyquire('../../ZelBack/src/services/utils/appConstants', {
        config: configStub,
      }),
      '../appDatabase/appsRepository': {
        getGlobalAppInfo: sinon.stub().resolves(null),
        existsInstalledApp: sinon.stub().resolves(false),
        getTempMessageByName: sinon.stub().resolves(null),
      },
      '../appRuntime/deploymentProvider': {
        listInstalledDeployments: sinon.stub().resolves([]),
      },
      './appVolumeService': {
        createAppVolume: sinon.stub().resolves(),
      },
      '../utils/specLibs': {
        getSpecBackend: sinon.stub().resolves({
          PendingSpec: { fromTempMessage: sinon.stub() },
        }),
      },
      '../utils/appUtilities': {
        findCommonArchitectures: sinon.stub().returns(['amd64']),
      },
      '../utils/fluxEventBus': {
        publish: sinon.stub(),
      },
      '../utils/cpuBurstHelper': {
        getCpuBurstAllowance: sinon.stub().returns(0),
      },
      '../utils/volumeService': {
        verifyAppVolumeMount: sinon.stub().resolves(),
      },
      '../appRequirements/hwRequirements': hwRequirementsStub,
      '../appQuery/appQueryService': {
        installedApps: sinon.stub().resolves({ status: 'success', data: [] }),
        listRunningApps: sinon.stub().resolves({ status: 'success', data: [] }),
      },
      '../utils/registryCredentialHelper': {
        getCredentials: sinon.stub().resolves(null),
      },
      util: {
        promisify: (fn) => fn,
      },
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

  describe('testInstallApplicationAPI', () => {
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

      await appInstaller.testInstallApplicationAPI(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(verificationHelperStub.verifyPrivilege.calledWith('user', req)).to.be.true;
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

      await appInstaller.testInstallApplicationAPI(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(logStub.error.called).to.be.true;
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

  describe('prune guard with stopped apps', () => {
    it('should not prune containers when stopped apps exist', async () => {
      const pruneContainersStub = sinon.stub().resolves();
      // Mock a deployment with a component that is installed but not running
      const mockDeployment = {
        componentEntries: sinon.stub().returns([
          ['MyComponent', { identifier: 'MyComponent_enterpriseapp123' }],
        ]),
      };
      const listInstalledDeploymentsStub = sinon.stub().resolves([mockDeployment]);

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
        '../fluxNetworkHelper': { getLocalSocketAddress: sinon.stub().resolves('192.168.1.1:16127'), getNumberOfPeers: sinon.stub().returns(15), isFirewallActive: sinon.stub().resolves(false), allowPort: sinon.stub().resolves({ status: true }), removeDockerContainerAccessToNonRoutable: sinon.stub().resolves(true) },
        '../geolocationService': { isStaticIP: sinon.stub().returns(true) },
        '../dockerService': {
          dockerListContainers: sinon.stub().resolves([]),
          pruneContainers: pruneContainersStub,
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
        './appUninstaller': { uninstallApplication: sinon.stub().resolves() },
        '../fluxCommunicationMessagesSender': { broadcastMessageToOutgoing: sinon.stub().resolves(), broadcastMessageToIncoming: sinon.stub().resolves() },
        '../appMessaging/messageStore': { storeAppInstallingErrorMessage: sinon.stub().resolves() },
        '../appSecurity/imageManager': { isImageBlocked: sinon.stub().resolves(false), verifyRepository: sinon.stub().resolves({ verified: true, supportedArchitectures: ['amd64'] }) },
        '../appManagement/appInspector': { startAppMonitoring: sinon.stub() },
        '../utils/imageVerifier': { ImageVerifier: sinon.stub().returns({ addCredentials: sinon.stub(), verifyImage: sinon.stub().resolves(), throwIfError: sinon.stub(), supported: true, provider: 'docker.io' }) },
        '../pgpService': { decryptMessage: sinon.stub().resolves('user:token') },
        '../upnpService': { isUPNP: sinon.stub().returns(false), mapUpnpPort: sinon.stub().resolves(true) },
        '../../lib/log': logStub,
        '../utils/appConstants': proxyquire('../../ZelBack/src/services/utils/appConstants', { config: configStub }),
        '../appDatabase/appsRepository': {
          getGlobalAppInfo: sinon.stub().resolves(null),
          existsInstalledApp: sinon.stub().resolves(false),
          getTempMessageByName: sinon.stub().resolves(null),
        },
        '../appRuntime/deploymentProvider': {
          listInstalledDeployments: listInstalledDeploymentsStub,
          buildDeployment: sinon.stub().resolves({
            totalResources: () => ({ cpu: 1, memory: 500, storage: 10 }),
            reservableHostDiskGb: () => 10,
            allHostPorts: () => [],
            allImages: () => [],
            componentEntries: () => [],
          }),
        },
        './appVolumeService': { createAppVolume: sinon.stub().resolves() },
        '../utils/specLibs': { getSpecBackend: sinon.stub().resolves({}) },
        '../utils/appUtilities': { findCommonArchitectures: sinon.stub().returns(['amd64']) },
        '../utils/fluxEventBus': { publish: sinon.stub() },
        '../utils/cpuBurstHelper': { getCpuBurstAllowance: sinon.stub().returns(0) },
        '../utils/volumeService': { verifyAppVolumeMount: sinon.stub().resolves() },
        '../appRequirements/hwRequirements': hwRequirementsStub,
        '../appQuery/appQueryService': {
          listRunningApps: sinon.stub().resolves({ status: 'success', data: [] }),
        },
        '../utils/registryCredentialHelper': { getCredentials: sinon.stub().resolves(null) },
        util: { promisify: (fn) => fn },
      });

      const mockPlacement = {
        staticIp: false,
        dataCenter: false,
        hasGeoRestrictions: () => false,
        hasTargets: () => false,
      };
      const mockInstantiated = {
        name: 'newapp',
        version: 2,
        placement: mockPlacement,
        spec: { version: 2, name: 'newapp', placement: mockPlacement, componentEntries: () => [] },
        isEncrypted: false,
        serialize: () => ({ version: 2, name: 'newapp' }),
      };
      // installApplication will proceed past the prune guard before eventually failing on network setup
      try {
        await appInstallerFresh.installApplication(mockInstantiated);
      } catch (e) {
        // Expected — we only care that the prune guard logic ran correctly
      }

      expect(listInstalledDeploymentsStub.calledOnce).to.be.true;
      // Installed app has a stopped component (MyComponent_enterpriseapp123 not running)
      // so pruneContainers should NOT be called
      expect(pruneContainersStub.called).to.be.false;
    });
  });

  describe('post-install broadcast', () => {
    it('runs onInstallComplete/app:installed on a successful install', async () => {
      const onInstallComplete = sinon.stub().resolves();
      const fluxEventBusPublish = sinon.stub();

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
        '../fluxNetworkHelper': { getLocalSocketAddress: sinon.stub().resolves('192.168.1.1:16127'), getNumberOfPeers: sinon.stub().returns(15), isFirewallActive: sinon.stub().resolves(false), allowPort: sinon.stub().resolves({ status: true }), removeDockerContainerAccessToNonRoutable: sinon.stub().resolves(true) },
        '../geolocationService': { isStaticIP: sinon.stub().returns(true) },
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
        './appUninstaller': { uninstallApplication: sinon.stub().resolves() },
        // appNetworkLinker.reconnectLinkedApps runs on the success path (the call kept during
        // the rebase); without this stub the install throws before reaching the broadcast.
        './appNetworkLinker': { reconnectLinkedApps: sinon.stub().resolves(), checkAppNetworkRequirements: sinon.stub().resolves(), connectComponentToLinkedApps: sinon.stub().resolves(), findLinkedAppLogCollector: sinon.stub().returns(null) },
        '../fluxCommunicationMessagesSender': { broadcastMessageToOutgoing: sinon.stub().resolves(), broadcastMessageToIncoming: sinon.stub().resolves(), broadcastMessageToAll: sinon.stub().resolves() },
        '../appMessaging/messageStore': { storeAppInstallingErrorMessage: sinon.stub().resolves(), storeAppRunningMessage: sinon.stub().resolves() },
        '../appSecurity/imageManager': { isImageBlocked: sinon.stub().resolves(false), verifyRepository: sinon.stub().resolves({ verified: true, supportedArchitectures: ['amd64'] }) },
        '../appManagement/appInspector': { startAppMonitoring: sinon.stub() },
        '../utils/imageVerifier': { ImageVerifier: sinon.stub().returns({ addCredentials: sinon.stub(), verifyImage: sinon.stub().resolves(), throwIfError: sinon.stub(), supported: true, provider: 'docker.io' }) },
        '../pgpService': { decryptMessage: sinon.stub().resolves('user:token') },
        '../upnpService': { isUPNP: sinon.stub().returns(false), mapUpnpPort: sinon.stub().resolves(true) },
        '../../lib/log': logStub,
        '../utils/appConstants': proxyquire('../../ZelBack/src/services/utils/appConstants', { config: configStub }),
        '../appDatabase/appsRepository': {
          getGlobalAppInfo: sinon.stub().resolves(null),
          // exists is false before insert (no stale entry) and true after (insert validated).
          existsInstalledApp: (() => { const s = sinon.stub().resolves(true); s.onCall(0).resolves(false); s.onCall(1).resolves(false); return s; })(),
          insertInstalledApp: sinon.stub().resolves({ insertedId: 'id1' }),
          removeInstalledApp: sinon.stub().resolves(),
          getTempMessageByName: sinon.stub().resolves(null),
        },
        '../appRuntime/deploymentProvider': {
          listInstalledDeployments: sinon.stub().resolves([]),
          getInstalledDeployment: sinon.stub().resolves({
            totalResources: () => ({ cpu: 1, memory: 500, storage: 10 }),
            reservableHostDiskGb: () => 10,
            allHostPorts: () => [],
            allImages: () => [],
            componentEntries: () => [],
          }),
          buildDeployment: sinon.stub().resolves({
            totalResources: () => ({ cpu: 1, memory: 500, storage: 10 }),
            reservableHostDiskGb: () => 10,
            allHostPorts: () => [],
            allImages: () => [],
            componentEntries: () => [],
          }),
        },
        './appVolumeService': { createAppVolume: sinon.stub().resolves() },
        '../utils/specLibs': { getSpecBackend: sinon.stub().resolves({}) },
        '../utils/appUtilities': { findCommonArchitectures: sinon.stub().returns(['amd64']) },
        '../utils/fluxEventBus': { publish: fluxEventBusPublish },
        '../utils/cpuBurstHelper': { getCpuBurstAllowance: sinon.stub().returns(0), isEnterpriseOwner: sinon.stub().returns(false), isCpuBurstSupported: sinon.stub().resolves(false) },
        '../utils/volumeService': { verifyAppVolumeMount: sinon.stub().resolves() },
        '../appRequirements/hwRequirements': hwRequirementsStub,
        '../appQuery/appQueryService': { listRunningApps: sinon.stub().resolves({ status: 'success', data: [] }) },
        '../utils/registryCredentialHelper': { getCredentials: sinon.stub().resolves(null) },
        util: { promisify: (fn) => fn },
      });

      appInstallerFresh.setOnInstallComplete(onInstallComplete);

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
        serialize: () => ({ version: 2, name: 'newapp' }),
      };

      const result = await appInstallerFresh.installApplication(mockInstantiated, {});

      expect(result.status, 'install succeeded').to.equal(appInstaller.InstallStatus.INSTALLED);
      expect(onInstallComplete.calledOnce, 'post-install broadcast fired').to.be.true;
      expect(fluxEventBusPublish.calledWith('app:installed'), 'app:installed event published').to.be.true;
    });
  });

});
