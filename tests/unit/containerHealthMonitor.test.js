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

  describe('monitorAndRecoverApps', () => {
    it('should wait for bootComplete before proceeding', async () => {
      let monitorResolved = false;
      globalStateStub.waitForBootContainerStateSettled = sinon.stub().returns(
        new Promise((resolve) => { setTimeout(resolve, 50); }),
      );

      const promise = containerHealthMonitor.monitorAndRecoverApps('10.0.0.1', [], [], new Map())
        .then(() => { monitorResolved = true; });
      await new Promise((r) => setImmediate(r));
      expect(monitorResolved).to.be.false;
      await promise;
      expect(monitorResolved).to.be.true;
      expect(globalStateStub.waitForBootContainerStateSettled.calledOnce).to.be.true;
    });

    it('reads component/syncthing info from resolved views, not the encrypted wrapper', async () => {
      // An installed enterprise app: inst.spec is the EncryptedSpecV8 wrapper
      // with no componentNames(); the resolved view supplies it.
      const encryptedSpec = {
        componentNames() { throw new Error('must not call componentNames on the encrypted wrapper'); },
        hasSyncthing() { throw new Error('must not call hasSyncthing on the encrypted wrapper'); },
      };
      const inst = {
        name: 'encapp', version: 8, isEncrypted: true, hash: 'h1', spec: encryptedSpec,
      };
      const view = {
        componentNames: () => ['comp'],
        hasSyncthing: () => false,
        hasActiveStandbySyncthing: () => false,
      };
      const resolvedViews = new Map([['encapp', view]]);

      // comp_encapp not running → treated as stopped; getGlobalAppInfo returns
      // undefined so no recovery action runs. The point: no throw, view is used.
      const result = await containerHealthMonitor.monitorAndRecoverApps(
        '10.0.0.1', [inst], [], resolvedViews,
      );
      expect(result).to.have.property('masterSlaveAppsInstalled');
      expect(result).to.have.property('startedApps');
    });
  });
});
