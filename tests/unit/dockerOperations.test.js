process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('dockerOperations tests', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('appDeleteDataInMountPoint', () => {
    it('should execute rm -rf on app mount point', async () => {
      const execStub = sinon.stub().yields(null, '', '');
      const dockerOperations = proxyquire('../../ZelBack/src/services/appManagement/dockerOperations', {
        child_process: { exec: execStub },
        '../../lib/log': { info: sinon.stub(), error: sinon.stub() },
        '../utils/appConstants': { appsFolder: '/tmp/flux/apps/' },
      });

      await dockerOperations.appDeleteDataInMountPoint('testapp');

      expect(execStub.calledOnce).to.be.true;
      expect(execStub.firstCall.args[0]).to.equal('sudo rm -rf /tmp/flux/apps/testapp/appdata/*');
    });

    it('should log error when command fails', async () => {
      const execStub = sinon.stub().yields(new Error('Permission denied'), '', '');
      const logStub = { info: sinon.stub(), error: sinon.stub() };
      const dockerOperations = proxyquire('../../ZelBack/src/services/appManagement/dockerOperations', {
        child_process: { exec: execStub },
        '../../lib/log': logStub,
        '../utils/appConstants': { appsFolder: '/tmp/flux/apps/' },
      });

      await dockerOperations.appDeleteDataInMountPoint('testapp');

      expect(logStub.error.calledOnce).to.be.true;
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
  let appInspectorStub;
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

    appInspectorStub = {
      startAppMonitoring: sinon.stub(),
      stopAppMonitoring: sinon.stub(),
    };

    appVolumeServiceStub = {
      ensureMountSourcesExist: sinon.stub().resolves(),
    };

    appReconcilerStub = {
      drive: sinon.stub().resolves({ converged: true, failed: [] }),
      enqueue: sinon.stub(),
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
      '../utils/specLibs': { getSpec: sinon.stub() },
      '../appManagement/appInspector': appInspectorStub,
      './appVolumeService': appVolumeServiceStub,
      '../appMonitoring/appReconciler': appReconcilerStub,
      '../../lib/log': logStub,
      '../dbHelper': { databaseConnection: sinon.stub() },
      '../serviceHelper': { delay: sinon.stub().resolves(), ensureString: sinon.stub().returnsArg(0) },
      '../messageHelper': {},
      '../verificationHelper': {},
      '../daemonService/daemonServiceMiscRpcs': {},
      '../fluxNetworkHelper': { getLocalSocketAddress: sinon.stub().resolves('127.0.0.1:16127') },
      '../generalService': { nodeTier: sinon.stub().resolves('cumulus') },
      '../upnpService': {},
      '../appDatabase/appsRepository': appsRepositoryStub,
      '../appQuery/appQueryService': { listRunningContainers: sinon.stub().resolves([]), listAllApps: sinon.stub().resolves([]), installedApps: sinon.stub().resolves({ data: [] }) },
      '../appRuntime/deploymentProvider': { getInstalledDeployment: sinon.stub().resolves(null), buildDeployment: buildDeploymentStub },
      './appUninstaller': { uninstallApplication: sinon.stub().resolves() },
      './componentProvisioner': { installComponent: sinon.stub().resolves() },
      '../utils/globalState': {},
      '../utils/appConstants': { localAppsInformation: 'test', globalAppsInformation: 'test', globalAppsInstallingErrorsLocations: 'test', globalAppsMessages: 'test', appsFolder: '/tmp/flux/apps/' },
      config: { fluxapps: { minimumInstances: 3, redeploy: { composedDelay: 30000 } }, database: { appsglobal: { database: 'globalapps', collections: { appsLocations: 'appsLocations' } } } },
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
