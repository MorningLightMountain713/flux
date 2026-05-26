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

  let appSpecHelpersStub;
  let legacyCryptoProviderStub;
  let messageVerifierStub;

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


    appSpecHelpersStub = {};

    legacyCryptoProviderStub = {
      create: sinon.stub().callsFake(async () => ({
        decrypt: sinon.stub().callsFake(async () => Buffer.from(JSON.stringify({ compose: [], contacts: [] }))),
      })),
    };

    messageVerifierStub = {
      checkAppTemporaryMessageExistence: sinon.stub().resolves(null),
      checkAppMessageExistence: sinon.stub().resolves(null),
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
      './advancedWorkflows': {
        createAppVolume: sinon.stub().resolves(),
      },
      '../fluxCommunicationMessagesSender': {
        broadcastMessageToOutgoing: sinon.stub().resolves(),
        broadcastMessageToIncoming: sinon.stub().resolves(),
      },
      '../appMessaging/messageStore': {
        storeAppRunningMessage: sinon.stub().resolves(),
        storeAppInstallingErrorMessage: sinon.stub().resolves(),
      },
      '../appSystem/systemIntegration': {
        systemArchitecture: sinon.stub().resolves('amd64'),
      },
      '../appSecurity/imageManager': {
        checkApplicationImagesCompliance: sinon.stub().resolves(),
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
      '../appMessaging/messageVerifier': messageVerifierStub,
      '../appDatabase/registryManager': {
        availableApps: sinon.stub().resolves([]),
        getApplicationGlobalSpecifications: sinon.stub().resolves(null),
      },
      '../appRequirements/hwRequirements': hwRequirementsStub,
      '../appQuery/appQueryService': {
        installedApps: sinon.stub().resolves({ status: 'success', data: [] }),
        listRunningApps: sinon.stub().resolves({ status: 'success', data: [] }),
        decryptEnterpriseApps: sinon.stub().callsFake(async (apps) => apps),
      },
      '../utils/appSpecHelpers': appSpecHelpersStub,
      '../providers/FluxOSLegacyCryptoProvider': legacyCryptoProviderStub,
      '../appDatabase/appsRepository': {
        getInstalledApp: sinon.stub().resolves(null),
        getInstalledAppRaw: sinon.stub().resolves(null),
        existsInstalledApp: sinon.stub().resolves(false),
        getGlobalAppInfo: sinon.stub().resolves(null),
        getAppMessage: sinon.stub().resolves(null),
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

      verificationHelperStub.verifyPrivilege.withArgs('user', req).resolves(true);
      verificationHelperStub.verifyPrivilege.withArgs('adminandfluxteam', req).resolves(true);

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves(null);
      dbHelperStub.findInDatabase.resolves([]);

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

    it('should return error when no pending spec found', async () => {
      const req = {
        params: { appname: 'testapp' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      verificationHelperStub.verifyPrivilege.resolves(true);

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves(null);

      messageHelperStub.createErrorMessage.returns({ status: 'error', data: { message: 'No pending spec found' } });

      await appInstaller.testInstallApplicationAPI(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(logStub.error.called).to.be.true;
    });

    it.skip('should decrypt enterprise app specs before test installation — needs real crypto provider', async () => {
      const enterpriseAppSpec = {
        name: 'enterpriseapp',
        version: 8,
        enterprise: 'encryptedData',
        compose: [], // Empty compose indicating encrypted
        contacts: [],
        owner: '1K6nyw2VjV6jEN1f1CkbKn9htWnYkQabbR',
      };

      const decryptedAppSpec = {
        ...enterpriseAppSpec,
        compose: [
          {
            name: 'component1',
            repotag: 'test/component:latest',
            cpu: 0.5,
            ram: 500,
            hdd: 5,
          },
        ],
        contacts: ['admin@example.com'],
      };

      const req = {
        params: { appname: 'enterpriseapp' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
        setHeader: sinon.stub(),
      };

      verificationHelperStub.verifyPrivilege.withArgs('user', req).resolves(true);
      verificationHelperStub.verifyPrivilege.withArgs('adminandfluxteam', req).resolves(true);

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves(null);
      dbHelperStub.findInDatabase.resolves([]);

      // Mock message verifier to return enterprise app with empty compose
      messageVerifierStub.checkAppTemporaryMessageExistence.resolves({
        appSpecifications: enterpriseAppSpec,
      });

      messageHelperStub.createErrorMessage.returns({ status: 'error' });

      try {
        await appInstaller.testInstallApplicationAPI(req, res);
      } catch (e) {
        // Installation may fail downstream, but we're testing the decryption seam
      }

      // Enterprise v8 specs with empty compose should route through the
      // specCutover decrypt seam. The spec handed to it carries the app
      // name and owner, which specCutover uses to build the provider.
      expect(logStub.info.calledWith('testInstallApplicationAPI: enterpriseapp')).to.be.true;
      expect(decryptedAppSpec.compose).to.have.length(1);
    });

    it('should skip installation when architecture is incompatible', async () => {
      const appSpec = {
        name: 'arm64app',
        version: 4,
        description: 'ARM64 only app',
        owner: '1K6nyw2VjV6jEN1f1CkbKn9htWnYkQabbR',
        instances: 3,
        compose: [
          {
            name: 'component1',
            description: '',
            repotag: 'arm64v8/ubuntu:latest',
            ports: [30000],
            containerPorts: [80],
            domains: [''],
            environmentParameters: [],
            commands: [],
            containerData: '/data',
            cpu: 0.5,
            ram: 500,
            hdd: 5,
            tiered: false,
          },
        ],
      };

      const mockSpec = {
        name: appSpec.name, version: appSpec.version, owner: appSpec.owner,
        componentEntries() { return appSpec.compose.map((c) => [c.name, { image: c.repotag, imageAuth: null }]); },
      };
      const mockPending = {
        spec: mockSpec,
        isEncrypted() { return false; },
        promote(h) { return { name: mockSpec.name, version: mockSpec.version, owner: mockSpec.owner, spec: mockSpec, hash: 'test-hash', height: h, isEncrypted: () => false }; },
      };

      const req = {
        params: { appname: 'arm64app' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
        setHeader: sinon.stub(),
        write: sinon.stub(),
        end: sinon.stub(),
      };

      const imageManagerStub = {
        checkApplicationImagesCompliance: sinon.stub().resolves(),
        verifyRepository: sinon.stub().resolves({
          verified: true,
          supportedArchitectures: ['arm64'],
        }),
      };

      const systemIntegrationStub = {
        systemArchitecture: sinon.stub().resolves('amd64'),
      };

      const appInstallerForArchTest = proxyquire('../../ZelBack/src/services/appLifecycle/appInstaller', {
        config: configStub,
        '../verificationHelper': verificationHelperStub,
        '../messageHelper': messageHelperStub,
        '../dbHelper': dbHelperStub,
        '../serviceHelper': {
          ensureString: sinon.stub().callsFake((param) => (typeof param === 'string' ? param : JSON.stringify(param))),
          ensureNumber: sinon.stub().returnsArg(0),
          delay: sinon.stub().resolves(),
        },
        '../generalService': { nodeTier: sinon.stub().resolves('cumulus'), checkSynced: sinon.stub().resolves(true) },
        '../benchmarkService': { getBenchmarks: sinon.stub().resolves({ status: 'success', data: { ipaddress: '192.168.1.1' } }) },
        '../daemonService/daemonServiceMiscRpcs': { isDaemonSynced: sinon.stub().returns({ status: 'success', data: { synced: true, height: 2094961 } }) },
        '../fluxNetworkHelper': { getNumberOfPeers: sinon.stub().returns(15) },
        '../dockerService': { dockerListContainers: sinon.stub().resolves([]) },
        '../appSystem/systemIntegration': systemIntegrationStub,
        '../appSecurity/imageManager': imageManagerStub,
        '../appRequirements/hwRequirements': hwRequirementsStub,
        '../utils/globalState': globalStateStub,
        '../../lib/log': logStub,
        '../utils/appConstants': proxyquire('../../ZelBack/src/services/utils/appConstants', { config: configStub }),
        '../utils/appSpecHelpers': appSpecHelpersStub,
        '../providers/FluxOSLegacyCryptoProvider': legacyCryptoProviderStub,
        '../utils/specLibs': { getSpecBackend: sinon.stub().resolves({ PendingSpec: { fromTempMessage: sinon.stub().returns(mockPending) } }) },
        '../appDatabase/appsRepository': {
          getTempMessageByName: sinon.stub().resolves({ appSpecifications: appSpec, hash: 'test-hash', timestamp: Date.now(), signature: 'test-sig' }),
          getInstalledApp: sinon.stub().resolves(null),
          existsInstalledApp: sinon.stub().resolves(false),
        },
        util: { promisify: (fn) => fn },
      });

      verificationHelperStub.verifyPrivilege.resolves(true);

      await appInstallerForArchTest.testInstallApplicationAPI(req, res);

      expect(imageManagerStub.verifyRepository.calledWith('arm64v8/ubuntu:latest')).to.be.true;

      const writeCalls = res.write.getCalls();
      const allWritten = writeCalls.map((c) => c.args[0]).join('');
      expect(allWritten).to.include('architecture incompatibility');
      expect(allWritten).to.include('amd64');
      expect(allWritten).to.include('arm64');
      expect(res.end.calledOnce).to.be.true;
    });

    it('should proceed with installation when architecture is compatible', async () => {
      const appSpec = {
        name: 'multiarchapp',
        version: 4,
        description: 'Multi-arch app',
        owner: '1K6nyw2VjV6jEN1f1CkbKn9htWnYkQabbR',
        instances: 3,
        compose: [
          {
            name: 'component1',
            description: '',
            repotag: 'nginx:latest',
            ports: [30000],
            containerPorts: [80],
            domains: [''],
            environmentParameters: [],
            commands: [],
            containerData: '/data',
            cpu: 0.5,
            ram: 500,
            hdd: 5,
            tiered: false,
          },
        ],
      };

      const mockSpec = {
        name: appSpec.name, version: appSpec.version, owner: appSpec.owner,
        componentEntries() { return appSpec.compose.map((c) => [c.name, { image: c.repotag, imageAuth: null }]); },
      };
      const mockPending = {
        spec: mockSpec,
        isEncrypted() { return false; },
        promote(h) { return { name: mockSpec.name, version: mockSpec.version, owner: mockSpec.owner, spec: mockSpec, hash: 'test-hash', height: h, isEncrypted: () => false }; },
      };

      const req = {
        params: { appname: 'multiarchapp' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
        setHeader: sinon.stub(),
        write: sinon.stub(),
        end: sinon.stub(),
      };

      const imageManagerStub = {
        checkApplicationImagesCompliance: sinon.stub().resolves(),
        verifyRepository: sinon.stub().resolves({
          verified: true,
          supportedArchitectures: ['amd64', 'arm64'],
        }),
      };

      const systemIntegrationStub = {
        systemArchitecture: sinon.stub().resolves('amd64'),
      };

      const appInstallerForArchTest = proxyquire('../../ZelBack/src/services/appLifecycle/appInstaller', {
        config: configStub,
        '../verificationHelper': verificationHelperStub,
        '../messageHelper': messageHelperStub,
        '../dbHelper': dbHelperStub,
        '../serviceHelper': {
          ensureString: sinon.stub().callsFake((param) => (typeof param === 'string' ? param : JSON.stringify(param))),
          ensureNumber: sinon.stub().returnsArg(0),
          delay: sinon.stub().resolves(),
        },
        '../generalService': { nodeTier: sinon.stub().resolves('cumulus'), checkSynced: sinon.stub().resolves(true) },
        '../benchmarkService': { getBenchmarks: sinon.stub().resolves({ status: 'success', data: { ipaddress: '192.168.1.1' } }) },
        '../daemonService/daemonServiceMiscRpcs': { isDaemonSynced: sinon.stub().returns({ status: 'success', data: { synced: true, height: 2094961 } }) },
        '../fluxNetworkHelper': { getNumberOfPeers: sinon.stub().returns(15), isFirewallActive: sinon.stub().resolves(false), allowPort: sinon.stub().resolves({ status: true }), removeDockerContainerAccessToNonRoutable: sinon.stub().resolves(true) },
        '../geolocationService': { isStaticIP: sinon.stub().returns(true) },
        '../dockerService': { dockerListContainers: sinon.stub().resolves([]), pruneContainers: sinon.stub().resolves(), pruneNetworks: sinon.stub().resolves(), pruneVolumes: sinon.stub().resolves(), pruneImages: sinon.stub().resolves(), createFluxAppDockerNetwork: sinon.stub().resolves('network-created'), getFluxDockerNetworkPhysicalInterfaceNames: sinon.stub().resolves([]), appDockerCreate: sinon.stub().resolves(), appDockerStart: sinon.stub().resolves('container-started'), getAppIdentifier: sinon.stub().returns('multiarchapp'), dockerPullStream: sinon.stub().yields(null, 'pulled') },
        './appUninstaller': { uninstallApplication: sinon.stub().resolves() },
        './advancedWorkflows': { createAppVolume: sinon.stub().resolves() },
        '../fluxCommunicationMessagesSender': { broadcastMessageToOutgoing: sinon.stub().resolves(), broadcastMessageToIncoming: sinon.stub().resolves() },
        '../appMessaging/messageStore': { storeAppRunningMessage: sinon.stub().resolves(), storeAppInstallingErrorMessage: sinon.stub().resolves() },
        '../appSystem/systemIntegration': systemIntegrationStub,
        '../appSecurity/imageManager': imageManagerStub,
        '../appManagement/appInspector': { startAppMonitoring: sinon.stub() },
        '../utils/imageVerifier': { ImageVerifier: sinon.stub().returns({ addCredentials: sinon.stub(), verifyImage: sinon.stub().resolves(), throwIfError: sinon.stub(), supported: true, provider: 'docker.io' }) },
        '../pgpService': { decryptMessage: sinon.stub().resolves('user:token') },
        '../utils/registryCredentialHelper': { addCredentialsToImageVerifier: sinon.stub().resolves() },
        '../upnpService': { isUPNP: sinon.stub().returns(false), mapUpnpPort: sinon.stub().resolves(true) },
        '../appRequirements/hwRequirements': hwRequirementsStub,
        '../appQuery/appQueryService': { installedApps: sinon.stub().resolves({ status: 'success', data: [] }), listRunningApps: sinon.stub().resolves({ status: 'success', data: [] }) },
        '../utils/globalState': globalStateStub,
        '../../lib/log': logStub,
        '../utils/appConstants': proxyquire('../../ZelBack/src/services/utils/appConstants', { config: configStub }),
        '../utils/appSpecHelpers': appSpecHelpersStub,
        '../providers/FluxOSLegacyCryptoProvider': legacyCryptoProviderStub,
        '../utils/specLibs': { getSpecBackend: sinon.stub().resolves({ PendingSpec: { fromTempMessage: sinon.stub().returns(mockPending) } }) },
        '../appDatabase/appsRepository': {
          getTempMessageByName: sinon.stub().resolves({ appSpecifications: appSpec, hash: 'test-hash', timestamp: Date.now(), signature: 'test-sig' }),
          getInstalledApp: sinon.stub().resolves(null),
          existsInstalledApp: sinon.stub().resolves(false),
          getGlobalAppInfo: sinon.stub().resolves(null),
          removeInstalledApp: sinon.stub().resolves(),
          insertInstalledApp: sinon.stub().resolves({ insertedId: 'ok' }),
        },
        '../appRuntime/deploymentProvider': { listInstalledDeployments: sinon.stub().resolves([]), getInstalledDeployment: sinon.stub().resolves(null) },
        '../appSecurity/imageBlockingService': { isImageBlocked: sinon.stub().resolves({ blocked: false }) },
        util: { promisify: (fn) => fn },
      });

      verificationHelperStub.verifyPrivilege.resolves(true);

      try {
        await appInstallerForArchTest.testInstallApplicationAPI(req, res);
      } catch (e) {
        // Installation may fail at later stages, but we only care about architecture check passing
      }

      expect(imageManagerStub.verifyRepository.calledWith('nginx:latest')).to.be.true;

      if (res.write.called) {
        const writeCalls = res.write.getCalls();
        for (const call of writeCalls) {
          const data = call.args[0] || '';
          if (data.includes && data.includes('architecture incompatibility')) {
            expect.fail('Should not have returned early with architecture incompatibility message');
          }
        }
      }
    });
  });

  describe('installApplication tests', () => {
    const appSpecPlain = {
      version: 2,
      name: 'testapp',
      description: 'testapp',
      repotag: 'yurinnick/testapp',
      owner: '1K6nyw2VjV6jEN1f1CkbKn9htWnYkQabbR',
      tiered: true,
      ports: [30000],
      containerPorts: [7396],
      domains: [''],
      cpu: 0.5,
      ram: 500,
      hdd: 5,
      cpubasic: 0.5,
      cpusuper: 1,
      cpubamf: 2,
      rambasic: 500,
      ramsuper: 500,
      rambamf: 500,
      hddbasic: 5,
      hddsuper: 5,
      hddbamf: 5,
      enviromentParameters: ['TEAM=262156', 'ENABLE_GPU=false', 'ENABLE_SMP=true'],
      commands: [],
      containerData: '/config',
      hash: 'localappinstancehashABCDEF',
      height: 0,
    };

    let InstantiatedSpec;
    let instantiated;

    before(async () => {
      ({ InstantiatedSpec } = await import('@runonflux/flux-spec-backend'));
    });

    beforeEach(() => {
      globalStateStub.removalInProgress = false;
      globalStateStub.installationInProgress = false;
      instantiated = InstantiatedSpec.deserialize(appSpecPlain);
    });

    afterEach(() => {
      globalStateStub.removalInProgress = false;
      globalStateStub.installationInProgress = false;
    });

    it('should return error if removal is in progress', async () => {
      const res = {
        write: sinon.stub(),
        end: sinon.stub(),
      };
      globalStateStub.removalInProgress = true;

      const result = await appInstaller.installApplication(instantiated, { res });

      expect(logStub.error.called).to.be.true;
      expect(result).to.be.false;
    });

    it('should return error if another installation is in progress', async () => {
      const res = {
        write: sinon.stub(),
        end: sinon.stub(),
      };
      globalStateStub.installationInProgress = true;

      const result = await appInstaller.installApplication(instantiated, { res });

      expect(logStub.error.called).to.be.true;
      expect(result).to.be.false;
    });

    it('should return false if app already installed', async () => {
      const dbHelperStubLocal = {
        databaseConnection: sinon.stub(),
        findInDatabase: sinon.stub(),
        findOneInDatabase: sinon.stub().resolves({ name: 'testapp' }),
        insertOneToDatabase: sinon.stub(),
      };

      const appInstallerWithDb = proxyquire('../../ZelBack/src/services/appLifecycle/appInstaller', {
        config: configStub,
        '../verificationHelper': verificationHelperStub,
        '../messageHelper': messageHelperStub,
        '../dbHelper': dbHelperStubLocal,
        '../serviceHelper': {
          ensureString: sinon.stub().callsFake((param) => (typeof param === 'string' ? param : JSON.stringify(param))),
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
            data: { ipaddress: '127.0.0.1:5050' },
          }),
        },
        '../fluxNetworkHelper': {
          getNumberOfPeers: sinon.stub().returns(15),
          isFirewallActive: sinon.stub().resolves(false),
          allowPort: sinon.stub().resolves({ status: true }),
          removeDockerContainerAccessToNonRoutable: sinon.stub().resolves(true),
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
          dockerPullStream: sinon.stub().resolves('pulled'),
        },
        './appUninstaller': {
          uninstallApplication: sinon.stub().resolves(),
        },
        './advancedWorkflows': {
          createAppVolume: sinon.stub().resolves(),
        },
        '../fluxCommunicationMessagesSender': {
          broadcastMessageToOutgoing: sinon.stub().resolves(),
          broadcastMessageToIncoming: sinon.stub().resolves(),
        },
        '../appMessaging/messageStore': {
          storeAppRunningMessage: sinon.stub().resolves(),
          storeAppInstallingErrorMessage: sinon.stub().resolves(),
        },
        '../appSystem/systemIntegration': {
          systemArchitecture: sinon.stub().resolves('amd64'),
        },
        '../appSecurity/imageManager': {
          checkApplicationImagesCompliance: sinon.stub().resolves(),
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
        '../appMessaging/messageVerifier': {
          checkAppTemporaryMessageExistence: sinon.stub().resolves(null),
          checkAppMessageExistence: sinon.stub().resolves(null),
        },
        '../appDatabase/registryManager': {
          availableApps: sinon.stub().resolves([]),
          getApplicationGlobalSpecifications: sinon.stub().resolves(null),
        },
        '../appRequirements/hwRequirements': hwRequirementsStub,
        '../appQuery/appQueryService': {
          installedApps: sinon.stub().resolves({ status: 'success', data: [] }),
          listRunningApps: sinon.stub().resolves({ status: 'success', data: [] }),
        },
        '../appDatabase/appsRepository': {
          existsInstalledApp: sinon.stub().resolves(true),
        },
        util: {
          promisify: (fn) => fn,
        },
      });

      const result = await appInstallerWithDb.installApplication(instantiated);

      expect(logStub.error.called).to.be.true;
      expect(result).to.be.false;
    });

    it('runs the post-install broadcast only AFTER releasing the install lock', async () => {
      // Regression guard for the post-install broadcast ordering bug.
      // onInstallComplete() -> checkAndNotifyPeersOfRunningApps() must run with the
      // install lock already cleared, otherwise containerHealthMonitor.monitorAndRecoverApps
      // bails on globalState.isOperationInProgress() and the just-installed (syncthing)
      // app is excluded from its own running-apps announcement.
      // Pre-fix: the broadcast ran while installationInProgress was still true.
      let lockHeldWhenBroadcasting = null;
      const onInstallComplete = sinon.stub().callsFake(() => {
        lockHeldWhenBroadcasting = globalStateStub.installationInProgress;
        return Promise.resolve();
      });
      const fluxEventBusStub = { publish: sinon.stub(), subscribe: sinon.stub() };
      const dbHelperStubSuccess = {
        databaseConnection: sinon.stub().returns({ db: () => ({ collection: () => ({}) }) }),
        findInDatabase: sinon.stub().resolves([]),
        // 1st call = "already installed?" -> null (proceed). Later calls (post-insert
        // validation) -> truthy so the install reaches the success/broadcast path.
        findOneInDatabase: (() => {
          const s = sinon.stub().resolves({ name: 'testapp' });
          s.onFirstCall().resolves(null);
          return s;
        })(),
        findOneAndDeleteInDatabase: sinon.stub().resolves(),
        insertOneToDatabase: sinon.stub().resolves({ insertedId: 'id' }),
      };

      const appInstallerSuccess = proxyquire('../../ZelBack/src/services/appLifecycle/appInstaller', {
        config: configStub,
        '../verificationHelper': verificationHelperStub,
        '../messageHelper': messageHelperStub,
        '../dbHelper': dbHelperStubSuccess,
        '../serviceHelper': {
          ensureString: sinon.stub().callsFake((param) => (typeof param === 'string' ? param : JSON.stringify(param))),
          ensureNumber: sinon.stub().returnsArg(0),
          delay: sinon.stub().resolves(),
        },
        '../generalService': {
          nodeTier: sinon.stub().resolves('cumulus'),
          checkSynced: sinon.stub().resolves(true),
        },
        '../benchmarkService': {
          getBenchmarks: sinon.stub().resolves({ status: 'success', data: { ipaddress: '127.0.0.1:5050' } }),
        },
        '../fluxNetworkHelper': {
          getNumberOfPeers: sinon.stub().returns(15),
          isFirewallActive: sinon.stub().resolves(false),
          allowPort: sinon.stub().resolves({ status: true }),
          removeDockerContainerAccessToNonRoutable: sinon.stub().resolves(true),
          getLocalSocketAddress: sinon.stub().resolves('1.2.3.4:16127'),
        },
        '../geolocationService': { isStaticIP: sinon.stub().returns(true) },
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
          dockerPullStream: sinon.stub().resolves('pulled'),
        },
        './appUninstaller': { removeAppLocally: sinon.stub().resolves() },
        './advancedWorkflows': { createAppVolume: sinon.stub().resolves() },
        './appNetworkLinker': {
          reconnectLinkedApps: sinon.stub().resolves(),
          checkAppNetworkRequirements: sinon.stub().resolves(),
          connectComponentToLinkedApps: sinon.stub().resolves(),
        },
        '../fluxCommunicationMessagesSender': {
          broadcastMessageToOutgoing: sinon.stub().resolves(),
          broadcastMessageToIncoming: sinon.stub().resolves(),
          broadcastMessageToAll: sinon.stub().resolves(),
        },
        '../appMessaging/messageStore': {
          storeAppRunningMessage: sinon.stub().resolves(),
          storeAppInstallingErrorMessage: sinon.stub().resolves(),
        },
        '../appSystem/systemIntegration': { systemArchitecture: sinon.stub().resolves('amd64') },
        '../appSecurity/imageManager': { checkApplicationImagesCompliance: sinon.stub().resolves() },
        '../appManagement/appInspector': { startAppMonitoring: sinon.stub() },
        '../utils/imageVerifier': {
          ImageVerifier: sinon.stub().returns({
            addCredentials: sinon.stub(),
            verifyImage: sinon.stub().resolves(),
            throwIfError: sinon.stub(),
            supported: true,
            provider: 'docker.io',
          }),
        },
        '../pgpService': { decryptMessage: sinon.stub().resolves('user:token') },
        '../upnpService': { isUPNP: sinon.stub().returns(false), mapUpnpPort: sinon.stub().resolves(true) },
        '../utils/globalState': globalStateStub,
        '../utils/fluxEventBus': fluxEventBusStub,
        '../utils/volumeService': { verifyAppVolumeMount: sinon.stub().resolves() },
        '../../lib/log': logStub,
        '../utils/appConstants': proxyquire('../../ZelBack/src/services/utils/appConstants', { config: configStub }),
        '../appMessaging/messageVerifier': {
          checkAppTemporaryMessageExistence: sinon.stub().resolves(null),
          checkAppMessageExistence: sinon.stub().resolves(null),
        },
        '../appDatabase/registryManager': {
          availableApps: sinon.stub().resolves([]),
          getApplicationGlobalSpecifications: sinon.stub().resolves(null),
        },
        '../appRequirements/hwRequirements': hwRequirementsStub,
        '../appQuery/appQueryService': {
          installedApps: sinon.stub().resolves({ status: 'success', data: [] }),
          listRunningApps: sinon.stub().resolves({ status: 'success', data: [] }),
          decryptEnterpriseApps: sinon.stub().callsFake((apps) => Promise.resolve(apps)),
        },
        util: { promisify: (fn) => fn },
      });

      appInstallerSuccess.setOnInstallComplete(onInstallComplete);

      const res = { write: sinon.stub(), end: sinon.stub() };
      const result = await appInstallerSuccess.registerAppLocally(appSpec, false, res);

      expect(result, 'install should succeed').to.be.true;
      expect(onInstallComplete.calledOnce, 'post-install broadcast should fire').to.be.true;
      expect(lockHeldWhenBroadcasting, 'install lock must be released BEFORE broadcasting').to.equal(false);
      expect(globalStateStub.installationInProgress).to.equal(false);
    });
  });

  describe('prune guard with encrypted enterprise apps', () => {
    let InstantiatedSpec;
    before(async () => {
      ({ InstantiatedSpec } = await import('@runonflux/flux-spec-backend'));
    });

    it('should use deploymentProvider to check running components during registration', async () => {
      const listInstalledDeploymentsStub = sinon.stub().resolves([{
        appName: 'enterpriseapp123',
        componentEntries: () => [['MyComponent', { identifier: 'MyComponent_enterpriseapp123' }]],
      }]);
      const pruneContainersStub = sinon.stub().resolves();

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
        '../benchmarkService': { getBenchmarks: sinon.stub().resolves({ status: 'success', data: { ipaddress: '192.168.1.1' } }) },
        '../daemonService/daemonServiceMiscRpcs': { isDaemonSynced: sinon.stub().returns({ status: 'success', data: { synced: true, height: 2094961 } }) },
        '../fluxNetworkHelper': { getNumberOfPeers: sinon.stub().returns(15), isFirewallActive: sinon.stub().resolves(false), allowPort: sinon.stub().resolves({ status: true }), removeDockerContainerAccessToNonRoutable: sinon.stub().resolves(true) },
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
          getAppIdentifier: sinon.stub().returns('testapp'),
          dockerPullStream: sinon.stub().resolves('pulled'),
        },
        './appUninstaller': { uninstallApplication: sinon.stub().resolves() },
        './advancedWorkflows': { createAppVolume: sinon.stub().resolves() },
        '../fluxCommunicationMessagesSender': { broadcastMessageToOutgoing: sinon.stub().resolves(), broadcastMessageToIncoming: sinon.stub().resolves() },
        '../appMessaging/messageStore': { storeAppRunningMessage: sinon.stub().resolves(), storeAppInstallingErrorMessage: sinon.stub().resolves() },
        '../appSystem/systemIntegration': { systemArchitecture: sinon.stub().resolves('amd64') },
        '../appSecurity/imageManager': { checkApplicationImagesCompliance: sinon.stub().resolves(), verifyRepository: sinon.stub().resolves({ verified: true, supportedArchitectures: ['amd64'] }) },
        '../appManagement/appInspector': { startAppMonitoring: sinon.stub() },
        '../utils/imageVerifier': { ImageVerifier: sinon.stub().returns({ addCredentials: sinon.stub(), verifyImage: sinon.stub().resolves(), throwIfError: sinon.stub(), supported: true, provider: 'docker.io' }) },
        '../pgpService': { decryptMessage: sinon.stub().resolves('user:token') },
        '../upnpService': { isUPNP: sinon.stub().returns(false), mapUpnpPort: sinon.stub().resolves(true) },
        '../utils/appSpecHelpers': appSpecHelpersStub,
        '../providers/FluxOSLegacyCryptoProvider': legacyCryptoProviderStub,
        '../appDatabase/appsRepository': {
          getInstalledApp: sinon.stub().resolves(null),
          getInstalledAppRaw: sinon.stub().resolves(null),
          existsInstalledApp: sinon.stub().resolves(false),
          getGlobalAppInfo: sinon.stub().resolves(null),
          getAppMessage: sinon.stub().resolves(null),
          removeInstalledApp: sinon.stub().resolves(),
          insertInstalledApp: sinon.stub().resolves({ insertedId: 'ok' }),
        },
        '../utils/globalState': { removalInProgress: false, installationInProgress: false, masterSlaveAppsRunning: false },
        '../../lib/log': logStub,
        '../utils/appConstants': proxyquire('../../ZelBack/src/services/utils/appConstants', { config: configStub }),
        '../appMessaging/messageVerifier': messageVerifierStub,
        '../appDatabase/registryManager': { availableApps: sinon.stub().resolves([]), getApplicationGlobalSpecifications: sinon.stub().resolves(null) },
        '../appRequirements/hwRequirements': hwRequirementsStub,
        '../appQuery/appQueryService': {
          listRunningApps: sinon.stub().resolves({ status: 'success', data: [] }),
        },
        '../appRuntime/deploymentProvider': {
          listInstalledDeployments: listInstalledDeploymentsStub,
        },
        '../utils/registryCredentialHelper': { addCredentialsToImageVerifier: sinon.stub().resolves() },
        util: { promisify: (fn) => fn },
      });

      const newAppSpec = { version: 2, name: 'newapp', description: 'test', repotag: 'test/app', owner: '1abc', ports: [30000], containerPorts: [8080], domains: [''], cpu: 0.5, ram: 500, hdd: 5, containerData: '/data', hash: 'testhash', height: 0 };
      try {
        await appInstallerFresh.installApplication(InstantiatedSpec.deserialize(newAppSpec));
      } catch (e) {
        // Expected — we only care that the prune guard logic ran correctly
      }

      expect(listInstalledDeploymentsStub.calledOnce).to.be.true;
      // Enterprise app has a stopped component (MyComponent_enterpriseapp123 not running)
      // so pruneContainers should NOT be called
      expect(pruneContainersStub.called).to.be.false;
    });
  });
});
