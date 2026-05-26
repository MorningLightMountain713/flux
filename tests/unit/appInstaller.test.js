const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('appInstaller tests', () => {
  let appInstaller;
  let verificationHelperStub;
  let messageHelperStub;
  let dbHelperStub;
  let logStub;
  let configStub;
  let globalStateStub;
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

    globalStateStub = {
      removalInProgress: false,
      installationInProgress: false,
      masterSlaveAppsRunning: false,
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
      checkAppHWRequirements: sinon.stub().resolves(),
      checkAppStaticIpRequirements: sinon.stub(),
      checkAppNodesRequirements: sinon.stub().resolves(),
      checkAppGeolocationRequirements: sinon.stub(),
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
      '../utils/globalState': globalStateStub,
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
        decryptEnterpriseApps: sinon.stub().callsFake(async (apps) => apps),
      },
      '../utils/registryCredentialHelper': {
        addCredentialsToImageVerifier: sinon.stub().resolves(),
      },
      util: {
        promisify: (fn) => fn,
      },
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('checkAppRequirements', () => {
    it('should check all hardware requirements', async () => {
      const appSpecs = {
        name: 'testapp',
        cpu: 1,
        ram: 1000,
        hdd: 10,
      };

      const result = await appInstaller.checkAppRequirements(appSpecs);

      expect(result).to.be.true;
      expect(hwRequirementsStub.checkAppHWRequirements.calledWith(appSpecs)).to.be.true;
      expect(hwRequirementsStub.checkAppStaticIpRequirements.calledWith(appSpecs)).to.be.true;
      expect(hwRequirementsStub.checkAppNodesRequirements.calledWith(appSpecs)).to.be.true;
      expect(hwRequirementsStub.checkAppGeolocationRequirements.calledWith(appSpecs)).to.be.true;
    });

    it('should propagate hardware requirement errors', async () => {
      const appSpecs = {
        name: 'testapp',
        cpu: 1,
        ram: 1000,
        hdd: 10,
      };
      const error = new Error('Insufficient hardware');

      hwRequirementsStub.checkAppHWRequirements.rejects(error);

      try {
        await appInstaller.checkAppRequirements(appSpecs);
        expect.fail('Should have thrown error');
      } catch (err) {
        expect(err).to.equal(error);
      }
    });
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
      isEncrypted: () => false,
      serialize: () => ({
        version: 2,
        name: 'testapp',
      }),
    };

    beforeEach(() => {
      globalStateStub.removalInProgress = false;
      globalStateStub.installationInProgress = false;
    });

    afterEach(() => {
      globalStateStub.removalInProgress = false;
      globalStateStub.installationInProgress = false;
    });

    it('should return error if removal is in progress', async () => {
      globalStateStub.removalInProgress = true;

      const result = await appInstaller.installApplication(mockInstantiatedSpec);

      expect(logStub.error.called).to.be.true;
      expect(result).to.be.false;
    });

    it('should return error if another installation is in progress', async () => {
      globalStateStub.installationInProgress = true;

      const result = await appInstaller.installApplication(mockInstantiatedSpec);

      expect(logStub.error.called).to.be.true;
      expect(result).to.be.false;
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
          appDockerStart: sinon.stub().resolves('ok'),
          getAppIdentifier: sinon.stub().returns('newapp'),
          dockerPullStream: sinon.stub().yields(null, 'pulled'),
        },
        './appUninstaller': { uninstallApplication: sinon.stub().resolves() },
        '../fluxCommunicationMessagesSender': { broadcastMessageToOutgoing: sinon.stub().resolves(), broadcastMessageToIncoming: sinon.stub().resolves() },
        '../appMessaging/messageStore': { storeAppInstallingErrorMessage: sinon.stub().resolves() },
        '../appSystem/systemIntegration': { systemArchitecture: sinon.stub().resolves('amd64') },
        '../appSecurity/imageManager': { isImageBlocked: sinon.stub().resolves(false), verifyRepository: sinon.stub().resolves({ verified: true, supportedArchitectures: ['amd64'] }) },
        '../appManagement/appInspector': { startAppMonitoring: sinon.stub() },
        '../utils/imageVerifier': { ImageVerifier: sinon.stub().returns({ addCredentials: sinon.stub(), verifyImage: sinon.stub().resolves(), throwIfError: sinon.stub(), supported: true, provider: 'docker.io' }) },
        '../pgpService': { decryptMessage: sinon.stub().resolves('user:token') },
        '../upnpService': { isUPNP: sinon.stub().returns(false), mapUpnpPort: sinon.stub().resolves(true) },
        '../utils/globalState': { removalInProgress: false, installationInProgress: false },
        '../../lib/log': logStub,
        '../utils/appConstants': proxyquire('../../ZelBack/src/services/utils/appConstants', { config: configStub }),
        '../appDatabase/appsRepository': {
          getGlobalAppInfo: sinon.stub().resolves(null),
          existsInstalledApp: sinon.stub().resolves(false),
          getTempMessageByName: sinon.stub().resolves(null),
        },
        '../appRuntime/deploymentProvider': {
          listInstalledDeployments: listInstalledDeploymentsStub,
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
        '../utils/registryCredentialHelper': { addCredentialsToImageVerifier: sinon.stub().resolves() },
        util: { promisify: (fn) => fn },
      });

      const mockInstantiated = {
        name: 'newapp',
        spec: { version: 2, name: 'newapp', componentEntries: () => [] },
        isEncrypted: () => false,
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
});
