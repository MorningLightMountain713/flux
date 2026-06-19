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
      './appInstaller': { installComponent: sinon.stub().resolves() },
      '../utils/globalState': {},
      '../utils/appConstants': { localAppsInformation: 'test', globalAppsInformation: 'test', globalAppsInstallingErrorsLocations: 'test', globalAppsMessages: 'test', appsFolder: '/tmp/flux/apps/' },
      config: { fluxapps: { minimumInstances: 3, redeploy: { composedDelay: 30000 } }, database: { appsglobal: { database: 'globalapps', collections: { appsLocations: 'appsLocations' } } } },
    });
  });

  describe('stopApplication', () => {
    it('should stop a single component directly when name contains underscore', async () => {
      await appOperations.stopApplication('Component1_TestApp');

      sinon.assert.calledOnce(dockerServiceStub.appDockerStop);
      sinon.assert.calledWith(dockerServiceStub.appDockerStop, 'Component1_TestApp');
      sinon.assert.calledWith(appInspectorStub.stopAppMonitoring, 'Component1_TestApp', false);
    });

    it('should not look up specs when stopping a single component', async () => {
      await appOperations.stopApplication('Web_MyApp');

      sinon.assert.notCalled(appsRepositoryStub.getGlobalAppInfo);
    });

    it('should log error when app specs not found for whole app', async () => {
      appsRepositoryStub.getGlobalAppInfo.resolves(null);

      await appOperations.stopApplication('TestApp');

      sinon.assert.calledOnce(logStub.error);
      sinon.assert.notCalled(dockerServiceStub.appDockerStop);
    });

    it('should stop all components via DeploymentSpec for whole app', async () => {
      const fakeSpec = { name: 'TestApp', version: 4, components: { Web: {}, API: {} } };
      appsRepositoryStub.getGlobalAppInfo.resolves(mockInstantiatedSpec(fakeSpec));

      const mockDeployment = {
        componentEntries: sinon.stub().returns([
          ['API', { identifier: 'API_TestApp' }],
          ['Web', { identifier: 'Web_TestApp' }],
        ]),
      };
      buildDeploymentStub.resolves(mockDeployment);

      await appOperations.stopApplication('TestApp');

      expect(dockerServiceStub.appDockerStop.callCount).to.equal(2);
      expect(dockerServiceStub.appDockerStop.firstCall.args[0]).to.equal('API_TestApp');
      expect(dockerServiceStub.appDockerStop.secondCall.args[0]).to.equal('Web_TestApp');
      expect(appInspectorStub.stopAppMonitoring.callCount).to.equal(2);
    });

    it('should pass reverse option to componentEntries', async () => {
      appsRepositoryStub.getGlobalAppInfo.resolves(mockInstantiatedSpec({ name: 'TestApp' }));

      const componentEntriesStub = sinon.stub().returns([]);
      buildDeploymentStub.resolves({ componentEntries: componentEntriesStub });

      await appOperations.stopApplication('TestApp');

      sinon.assert.calledWith(componentEntriesStub, { reverse: true });
    });

    it('should handle docker stop errors gracefully', async () => {
      dockerServiceStub.appDockerStop.rejects(new Error('Docker stop failed'));

      await appOperations.stopApplication('Component1_TestApp');

      sinon.assert.calledOnce(logStub.error);
    });
  });

  describe('startApplication', () => {
    it('should start a single component directly when name contains underscore', async () => {
      await appOperations.startApplication('Component1_TestApp');

      sinon.assert.calledOnce(dockerServiceStub.appDockerStart);
      sinon.assert.calledWith(dockerServiceStub.appDockerStart, 'Component1_TestApp');
      sinon.assert.calledWith(appInspectorStub.startAppMonitoring, 'Component1_TestApp');
    });

    it('should start all components via DeploymentSpec for whole app', async () => {
      appsRepositoryStub.getGlobalAppInfo.resolves(mockInstantiatedSpec({ name: 'TestApp' }));

      const mockDeployment = {
        componentEntries: sinon.stub().returns([
          ['Web', { identifier: 'Web_TestApp' }],
          ['API', { identifier: 'API_TestApp' }],
        ]),
      };
      buildDeploymentStub.resolves(mockDeployment);

      await appOperations.startApplication('TestApp');

      expect(dockerServiceStub.appDockerStart.callCount).to.equal(2);
      expect(dockerServiceStub.appDockerStart.firstCall.args[0]).to.equal('Web_TestApp');
      expect(dockerServiceStub.appDockerStart.secondCall.args[0]).to.equal('API_TestApp');
      expect(appInspectorStub.startAppMonitoring.callCount).to.equal(2);
    });

    it('should log error when app not found', async () => {
      appsRepositoryStub.getGlobalAppInfo.resolves(null);

      await appOperations.startApplication('TestApp');

      sinon.assert.calledOnce(logStub.error);
      sinon.assert.notCalled(dockerServiceStub.appDockerStart);
    });
  });

  describe('restartApplication', () => {
    it('should restart a single component and ensure mounts exist', async () => {
      appsRepositoryStub.getGlobalAppInfo.resolves(mockInstantiatedSpec({ name: 'TestApp' }));

      const mockDeployComp = { identifier: 'Web_TestApp', mounts: [{ Source: '/tmp' }] };
      buildDeploymentStub.resolves({ getComponent: () => mockDeployComp });

      await appOperations.restartApplication('Web_TestApp');

      sinon.assert.calledOnce(appVolumeServiceStub.ensureMountSourcesExist);
      sinon.assert.calledWith(appVolumeServiceStub.ensureMountSourcesExist, mockDeployComp);
      sinon.assert.calledOnce(dockerServiceStub.appDockerRestart);
      sinon.assert.calledWith(dockerServiceStub.appDockerRestart, 'Web_TestApp');
      sinon.assert.calledWith(appInspectorStub.startAppMonitoring, 'Web_TestApp');
    });

    it('should skip ensureMountSourcesExist when component has no mounts', async () => {
      appsRepositoryStub.getGlobalAppInfo.resolves(mockInstantiatedSpec({ name: 'TestApp' }));

      const mockDeployComp = { identifier: 'Web_TestApp', mounts: [] };
      buildDeploymentStub.resolves({ getComponent: () => mockDeployComp });

      await appOperations.restartApplication('Web_TestApp');

      sinon.assert.notCalled(appVolumeServiceStub.ensureMountSourcesExist);
      sinon.assert.calledOnce(dockerServiceStub.appDockerRestart);
    });

    it('should restart all components for whole app', async () => {
      appsRepositoryStub.getGlobalAppInfo.resolves(mockInstantiatedSpec({ name: 'TestApp' }));

      const webComp = { identifier: 'Web_TestApp', mounts: [] };
      const apiComp = { identifier: 'API_TestApp', mounts: [] };
      const mockDeployment = {
        componentEntries: sinon.stub().returns([['Web', webComp], ['API', apiComp]]),
        getComponent: sinon.stub(),
      };
      mockDeployment.getComponent.withArgs('Web').returns(webComp);
      mockDeployment.getComponent.withArgs('API').returns(apiComp);
      buildDeploymentStub.resolves(mockDeployment);

      await appOperations.restartApplication('TestApp');

      expect(dockerServiceStub.appDockerRestart.callCount).to.equal(2);
      expect(dockerServiceStub.appDockerRestart.firstCall.args[0]).to.equal('Web_TestApp');
      expect(dockerServiceStub.appDockerRestart.secondCall.args[0]).to.equal('API_TestApp');
      expect(appInspectorStub.startAppMonitoring.callCount).to.equal(2);
    });

    it('should log error when app not found', async () => {
      appsRepositoryStub.getGlobalAppInfo.resolves(null);

      await appOperations.restartApplication('TestApp');

      sinon.assert.calledOnce(logStub.error);
      sinon.assert.notCalled(dockerServiceStub.appDockerRestart);
    });

    it('should handle docker restart errors gracefully', async () => {
      appsRepositoryStub.getGlobalAppInfo.resolves(mockInstantiatedSpec({ name: 'TestApp' }));
      buildDeploymentStub.resolves({
        getComponent: () => ({ identifier: 'Web_TestApp', mounts: [] }),
      });
      dockerServiceStub.appDockerRestart.rejects(new Error('Docker restart failed'));

      await appOperations.restartApplication('TestApp');

      sinon.assert.calledOnce(logStub.error);
    });
  });
});
