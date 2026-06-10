const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('containerHealthMonitor tests', () => {
  let containerHealthMonitor;
  let globalStateStub;

  beforeEach(() => {
    globalStateStub = {
      waitForBootContainerStateSettled: sinon.stub().resolves(),
      isOperationInProgress: sinon.stub().returns(false),
      backupInProgress: [],
      restoreInProgress: [],
      appsMonitored: new Map(),
      getAppLbState: sinon.stub().returns(null),
    };

    containerHealthMonitor = proxyquire('../../ZelBack/src/services/appMonitoring/containerHealthMonitor', {
      '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
      '../dbHelper': { databaseConnection: sinon.stub(), findInDatabase: sinon.stub(), findOneInDatabase: sinon.stub() },
      '../dockerService': { getDockerContainer: sinon.stub().resolves(null), appDockerStart: sinon.stub(), dockerListContainers: sinon.stub() },
      '../appDatabase/appsRepository': { getGlobalAppInfo: sinon.stub() },
      '../appLifecycle/appInstaller': { installComponent: sinon.stub().resolves() },
      '../appLifecycle/appUninstaller': { uninstallApplication: sinon.stub().resolves() },
      '../appRuntime/deploymentProvider': { buildDeployment: sinon.stub() },
      '../appManagement/appInspector': { startAppMonitoring: sinon.stub() },
      '../appTamperingDetectionService': { recordEvent: sinon.stub().resolves(), isNetworkMissingError: sinon.stub().returns(false) },
      '../utils/globalState': globalStateStub,
      '../utils/cacheManager': { default: { stoppedAppsCache: new Map() } },
      '../utils/volumeService': { verifyAppVolumeMount: sinon.stub().resolves(true) },
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('module surface', () => {
    it('no longer exposes monitorAndRecoverApps - the reconciler owns runtime recovery', () => {
      expect(containerHealthMonitor.monitorAndRecoverApps).to.be.undefined;
      expect(containerHealthMonitor.recreateMissingContainers).to.be.a('function');
    });
  });
});
