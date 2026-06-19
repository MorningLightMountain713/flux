// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const appOperations = require('../../ZelBack/src/services/appLifecycle/appOperations');
const appSpecHistory = require('../../ZelBack/src/services/appDatabase/appSpecHistory');
const appVolumeService = require('../../ZelBack/src/services/appLifecycle/appVolumeService');
const appInstaller = require('../../ZelBack/src/services/appLifecycle/appInstaller');
const appUninstaller = require('../../ZelBack/src/services/appLifecycle/appUninstaller');
const deploymentProvider = require('../../ZelBack/src/services/appRuntime/deploymentProvider');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');

describe('appOperations tests', () => {
  afterEach(() => {
    sinon.restore();
    operationRegistry.clear();
  });

  describe('previous spec lookup', () => {
    it('should return null if no previous message found', async () => {
      const specifications = { name: 'NewApp' };
      const verificationTimestamp = Date.now();

      sinon.stub(dbHelper, 'databaseConnection').returns({
        db: () => ({}),
      });
      sinon.stub(dbHelper, 'findInDatabase').resolves([]);

      const result = await appSpecHistory.getPreviousSpec(specifications, verificationTimestamp);
      expect(result).to.be.null;
    });
  });

  describe('redeployComponentAPI tests', () => {
    let req;
    let res;
    let verificationHelper;

    beforeEach(() => {
      // eslint-disable-next-line global-require
      verificationHelper = require('../../ZelBack/src/services/verificationHelper');

      req = {
        params: {},
        query: {},
        headers: {},
      };
      res = {
        json: sinon.stub(),
        write: sinon.stub(),
        flush: sinon.stub(),
        setHeader: sinon.stub(),
      };
    });

    it('should return error if appname is not provided', async () => {
      req.params.component = 'frontend';

      await appOperations.redeployComponentAPI(req, res);

      expect(res.json.calledOnce).to.be.true;
      const response = res.json.firstCall.args[0];
      expect(response.status).to.equal('error');
      expect(response.data.message).to.include('No Flux App specified');
    });

    it('should return error if component is not provided', async () => {
      req.params.appname = 'myapp';

      await appOperations.redeployComponentAPI(req, res);

      expect(res.json.calledOnce).to.be.true;
      const response = res.json.firstCall.args[0];
      expect(response.status).to.equal('error');
      expect(response.data.message).to.include('No component specified');
    });

    it('should return error if appname contains underscore', async () => {
      req.params.appname = 'frontend_myapp';
      req.params.component = 'frontend';

      await appOperations.redeployComponentAPI(req, res);

      expect(res.json.calledOnce).to.be.true;
      const response = res.json.firstCall.args[0];
      expect(response.status).to.equal('error');
      expect(response.data.message).to.include('Invalid app name format');
    });

    it('should skip redeploy if the app holds an operation lease', async () => {
      req.params.appname = 'myapp';
      req.params.component = 'frontend';

      // A restore (or any operation) holding the app lease must skip the redeploy.
      operationRegistry.acquire('myapp', 'restore', 'test', 'restore myapp');

      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);

      await appOperations.redeployComponentAPI(req, res);

      expect(res.json.calledOnce).to.be.true;
      const response = res.json.firstCall.args[0];
      expect(response.status).to.equal('warning');
      expect(response.data.message).to.include('Operation in progress');
    });

    it('should return unauthorized error if not authorized', async () => {
      req.params.appname = 'myapp';
      req.params.component = 'frontend';

      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(false);

      await appOperations.redeployComponentAPI(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(verificationHelper.verifyPrivilege.calledWith('appownerabove', req, 'myapp')).to.be.true;
    });

    it('should handle force parameter from query string', async () => {
      req.params.appname = 'myapp';
      req.params.component = 'frontend';
      req.query.force = 'true';

      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      sinon.stub(dbHelper, 'databaseConnection').returns({
        db: () => ({}),
      });
      sinon.stub(dbHelper, 'findOneInDatabase').resolves(null);

      await appOperations.redeployComponentAPI(req, res);

      // Should attempt to call hardRedeployComponent but will fail because app not found
      expect(res.json.calledOnce).to.be.true;
    });
  });

  describe('redeployComponent (redeploy) tests', () => {
    beforeEach(() => {
      operationRegistry.clear();
    });

    it('should return early if the app holds an operation lease', async () => {
      operationRegistry.acquire('myapp', 'install', 'test');
      const messages = [];
      await appOperations.redeployComponent('myapp', 'frontend', { onStatus: (msg) => messages.push(msg) });
      expect(messages).to.have.lengthOf(1);
      expect(messages[0]).to.include('Another operation is in progress');
    });

    it('holds a softRedeploy lease during the redeploy and releases it', async () => {
      let leaseTypeDuring = null;
      // The lease is acquired before the first await; observe it as getInstalledDeployment
      // runs, then return null so the catch path releases it (and calls uninstallApplication).
      sinon.stub(deploymentProvider, 'getInstalledDeployment').callsFake(async () => {
        leaseTypeDuring = operationRegistry.get('myapp')?.type ?? null;
        return null;
      });
      sinon.stub(appUninstaller, 'uninstallApplication').resolves();

      await appOperations.redeployComponent('myapp', 'frontend', { onStatus: () => {} });

      expect(leaseTypeDuring, 'a softRedeploy lease must be held while the redeploy runs').to.equal('softRedeploy');
      expect(operationRegistry.isHeld('myapp'), 'the redeploy lease must release when the operation settles').to.be.false;
    });

    it('should call uninstallApplication when application not found', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(null);
      sinon.stub(appUninstaller, 'uninstallApplication').resolves();

      await appOperations.redeployComponent('myapp', 'frontend', { onStatus: () => {} });

      expect(operationRegistry.isHeld('myapp'), 'the redeploy lease must release on error').to.be.false;
      expect(appUninstaller.uninstallApplication.calledOnce).to.be.true;
    });

    it('should call uninstallApplication when component not found in app', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves({
        getComponent: () => null,
      });
      sinon.stub(appUninstaller, 'uninstallApplication').resolves();

      await appOperations.redeployComponent('myapp', 'frontend', { onStatus: () => {} });

      expect(operationRegistry.isHeld('myapp'), 'the redeploy lease must release on error').to.be.false;
      expect(appUninstaller.uninstallApplication.calledOnce).to.be.true;
    });
  });

  describe('redeployComponent (rebuild) tests', () => {
    beforeEach(() => {
      operationRegistry.clear();
    });

    it('should return early if the app holds an operation lease', async () => {
      operationRegistry.acquire('myapp', 'install', 'test');
      const messages = [];
      await appOperations.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: (msg) => messages.push(msg) });
      expect(messages).to.have.lengthOf(1);
      expect(messages[0]).to.include('Another operation is in progress');
    });

    it('holds a hardRedeploy lease during the rebuild and releases it', async () => {
      let leaseTypeDuring = null;
      sinon.stub(deploymentProvider, 'getInstalledDeployment').callsFake(async () => {
        leaseTypeDuring = operationRegistry.get('myapp')?.type ?? null;
        return null;
      });
      sinon.stub(appUninstaller, 'uninstallApplication').resolves();

      await appOperations.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: () => {} });

      expect(leaseTypeDuring, 'a hardRedeploy lease must be held while the rebuild runs').to.equal('hardRedeploy');
      expect(operationRegistry.isHeld('myapp'), 'the rebuild lease must release when the operation settles').to.be.false;
    });


    it('should call uninstallApplication when application not found', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(null);
      sinon.stub(appUninstaller, 'uninstallApplication').resolves();

      await appOperations.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: () => {} });

      expect(operationRegistry.isHeld('myapp'), 'the rebuild lease must release on error').to.be.false;
      expect(appUninstaller.uninstallApplication.calledOnce).to.be.true;
    });

    it('should call uninstallApplication when component not found in app', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves({
        getComponent: () => null,
      });
      sinon.stub(appUninstaller, 'uninstallApplication').resolves();

      await appOperations.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: () => {} });

      expect(operationRegistry.isHeld('myapp'), 'the rebuild lease must release on error').to.be.false;
      expect(appUninstaller.uninstallApplication.calledOnce).to.be.true;
    });

    it('should release the rebuild lease on error', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(null);
      sinon.stub(appUninstaller, 'uninstallApplication').resolves();

      await appOperations.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: () => {} });

      expect(operationRegistry.isHeld('myapp'), 'the rebuild lease must release on error').to.be.false;
    });
  });

  describe('ensureMountSourcesExist tests', () => {
    let serviceHelperStub;
    let logStub;
    let proxyquire;

    beforeEach(() => {
      // eslint-disable-next-line global-require
      proxyquire = require('proxyquire').noCallThru();

      serviceHelperStub = {
        runCommand: sinon.stub().resolves({ error: null }),
      };

      logStub = {
        info: sinon.stub(),
        warn: sinon.stub(),
        error: sinon.stub(),
      };
    });

    afterEach(() => {
      sinon.restore();
    });

    function buildDeployComp(mounts) {
      return { mounts };
    }

    function loadModule() {
      return proxyquire('../../ZelBack/src/services/appLifecycle/appVolumeService', {
        '../serviceHelper': serviceHelperStub,
        '../../lib/log': logStub,
      });
    }

    it('creates a file source with touch and chmod', async () => {
      const mod = loadModule();
      const deployComp = buildDeployComp([
        { Source: '/apps/fluxweb_test/config.yaml', sourceType: 'file' },
      ]);

      await mod.ensureMountSourcesExist(deployComp);

      expect(serviceHelperStub.runCommand.calledWith('touch', sinon.match({ params: ['/apps/fluxweb_test/config.yaml'], runAsRoot: true }))).to.be.true;
      expect(serviceHelperStub.runCommand.calledWith('chmod', sinon.match({ params: ['777', '/apps/fluxweb_test/config.yaml'], runAsRoot: true }))).to.be.true;
    });

    it('creates a directory source with mkdir -p', async () => {
      const mod = loadModule();
      const deployComp = buildDeployComp([
        { Source: '/apps/fluxweb_test/logs', sourceType: 'directory' },
      ]);

      await mod.ensureMountSourcesExist(deployComp);

      expect(serviceHelperStub.runCommand.calledWith('mkdir', sinon.match({ params: ['-p', '/apps/fluxweb_test/logs'], runAsRoot: true }))).to.be.true;
    });

    it('materialises every source unconditionally, with no prior existence check (idempotent, no TOCTOU)', async () => {
      const mod = loadModule();
      const deployComp = buildDeployComp([
        { Source: '/apps/fluxweb_test/html', sourceType: 'directory' },
        { Source: '/apps/fluxweb_test/logs', sourceType: 'directory' },
        { Source: '/apps/fluxweb_test/config.yaml', sourceType: 'file' },
      ]);

      await mod.ensureMountSourcesExist(deployComp);

      // mkdir -p / touch run for every source, not gated on a prior stat — mkdir -p
      // and touch are themselves idempotent, so there is no check-then-act window.
      expect(serviceHelperStub.runCommand.calledWith('mkdir', sinon.match({ params: ['-p', '/apps/fluxweb_test/html'] }))).to.be.true;
      expect(serviceHelperStub.runCommand.calledWith('mkdir', sinon.match({ params: ['-p', '/apps/fluxweb_test/logs'] }))).to.be.true;
      expect(serviceHelperStub.runCommand.calledWith('touch', sinon.match({ params: ['/apps/fluxweb_test/config.yaml'] }))).to.be.true;
      expect(serviceHelperStub.runCommand.calledWith('chmod', sinon.match({ params: ['777', '/apps/fluxweb_test/config.yaml'] }))).to.be.true;
    });

    it('handles empty mounts array', async () => {
      const mod = loadModule();
      const deployComp = buildDeployComp([]);

      await mod.ensureMountSourcesExist(deployComp);

      expect(serviceHelperStub.runCommand.called).to.be.false;
    });
  });

  // coordinateActiveStandbyApps is a recursive function that continuously runs in production.
  // These tests use a counter to prevent infinite recursion after the first iteration.
  describe('coordinateActiveStandbyApps tests', () => {
    let globalStateRef;
    let serviceHelperDelayStub;
    let deploymentProviderStub;
    let listRunningContainersStub;

    beforeEach(() => {
      let recursionCounter = 0;
      globalStateRef = require('../../ZelBack/src/services/utils/globalState');
      globalStateRef.activeStandbyCoordinationRunning = false;
      // the first-run mount-safety gate blocks election until the syncthing
      // monitor's first cycle completes; these tests model a settled node
      globalStateRef.syncthingAppsFirstRun = false;
      const appsRuntimeState = require('../../ZelBack/src/services/appManagement/appsRuntimeState');
      sinon.stub(appsRuntimeState, 'isOperatorStopped').resolves(false);

      const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
      serviceHelperDelayStub = sinon.stub(serviceHelper, 'delay').callsFake(async () => {
        recursionCounter += 1;
        if (recursionCounter > 1) {
          return new Promise(() => {});
        }
        return Promise.resolve();
      });

      const syncthingService = require('../../ZelBack/src/services/syncthingService');
      sinon.stub(syncthingService, 'getHealth').resolves({
        status: 'success',
        data: { status: 'OK' },
      });

      const dp = require('../../ZelBack/src/services/appRuntime/deploymentProvider');
      deploymentProviderStub = sinon.stub(dp, 'listInstalledDeployments').resolves([]);

      const appQueryService = require('../../ZelBack/src/services/appQuery/appQueryService');
      listRunningContainersStub = sinon.stub(appQueryService, 'listRunningContainers').resolves([]);

      sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({}) });
      sinon.stub(dbHelper, 'findOneInDatabase').resolves(null);
    });

    it('should skip execution while a folder-set-changing operation is in flight', async () => {
      operationRegistry.acquire('someapp', 'install', 'test');

      await appOperations.coordinateActiveStandbyApps();

      expect(deploymentProviderStub.called).to.be.false;
    });

    it('should skip apps in backup progress', async () => {
      const appName = 'testapp';
      const mockDeployment = {
        appName,
        componentEntries: () => [[appName, {
          identifier: appName,
          hasActiveStandbySyncthing: () => true,
          hasSyncthing: () => true,
        }]],
      };
      deploymentProviderStub.resolves([mockDeployment]);
      operationRegistry.acquire(appName, 'backup', 'test');

      const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
      const axiosGetStub = sinon.stub(serviceHelper, 'axiosGet');

      await appOperations.coordinateActiveStandbyApps();

      // The cycle runs (backup is not a folder-set-changing op) but skips the
      // backed-up app per-app, so it never probes that app's operator status.
      expect(deploymentProviderStub.called).to.be.true;
      expect(axiosGetStub.called).to.be.false;
    });

    it('stops only the active-standby component identifier on a standby node when FDM names a different primary', async () => {
      // Mixed app: 'n8n' is the active-standby component; the coordinator must act on the
      // component identifier (n8n_n8napp), never the app name or a sibling component.
      const identifier = 'n8n_n8napp';
      // coordinateActiveStandbyApps destructures listRunningContainers at module load, so it
      // can't be sinon-stubbed on the module object; proxyquire (callThru) overrides just that
      // one dependency while every other dep (delay, axiosGet, getLocalSocketAddress, docker,
      // deploymentProvider) is object-accessed and so is controlled by the sinon stubs below.
      const proxyquire = require('proxyquire');
      const appQueryService = require('../../ZelBack/src/services/appQuery/appQueryService');
      // The active-standby component is currently running on THIS node.
      const listRunningContainers = sinon.stub().resolves([{ Names: [`/flux${identifier}`] }]);
      const appOps = proxyquire('../../ZelBack/src/services/appLifecycle/appOperations', {
        '../appQuery/appQueryService': { ...appQueryService, listRunningContainers },
      });

      const mockDeployment = {
        appName: 'n8napp',
        componentEntries: () => [['n8n', {
          identifier,
          hasActiveStandbySyncthing: () => true,
          hasSyncthing: () => true,
        }]],
      };
      deploymentProviderStub.resolves([mockDeployment]);

      const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
      // FDM reports the primary lives on a DIFFERENT node -> this node is a standby.
      sinon.stub(serviceHelper, 'axiosGet').resolves({ data: { status: 'success', data: { ips: ['203.0.113.99'] } } });

      const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.5:16137');

      const dockerService = require('../../ZelBack/src/services/dockerService');
      sinon.stub(dockerService, 'getAppIdentifier').returns('appid');
      const appReconciler = require('../../ZelBack/src/services/appMonitoring/appReconciler');
      const setDesiredStub = sinon.stub(appReconciler, 'setControllerDesired');

      await appOps.coordinateActiveStandbyApps();
      await new Promise((r) => { setImmediate(r); }); // flush the fire-and-forget hand-off

      // IP-granular standby stop hands the active-standby component identifier
      // to the reconciler (the single actuator) - never the app name or a sibling.
      expect(setDesiredStub.calledWith(identifier, 'stopped', 'masterSlave standby'), 'active-standby component handed to the reconciler as stopped').to.be.true;
      expect(setDesiredStub.neverCalledWith('n8napp'), 'never acts by app name').to.be.true;
    });

    it('does not stop its own container when it is the primary on a non-default (UPnP) port', async () => {
      // FDM returns a bare IP (no port); this node's socket has a non-default UPnP port. The
      // IP-granular ipsMatch must still recognise this node as the primary, so it must NOT stop
      // its own running container. (Port-sensitive matching would wrongly stop it.)
      const identifier = 'n8n_n8napp';
      const proxyquire = require('proxyquire');
      const appQueryService = require('../../ZelBack/src/services/appQuery/appQueryService');
      const listRunningContainers = sinon.stub().resolves([{ Names: [`/flux${identifier}`] }]);
      const appOps = proxyquire('../../ZelBack/src/services/appLifecycle/appOperations', {
        '../appQuery/appQueryService': { ...appQueryService, listRunningContainers },
      });

      const mockDeployment = {
        appName: 'n8napp',
        componentEntries: () => [['n8n', {
          identifier,
          hasActiveStandbySyncthing: () => true,
          hasSyncthing: () => true,
        }]],
      };
      deploymentProviderStub.resolves([mockDeployment]);

      const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
      // FDM names THIS node as primary, returned as a bare IP (production format).
      sinon.stub(serviceHelper, 'axiosGet').resolves({ data: { status: 'success', data: { ips: ['192.168.1.5'] } } });

      const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
      // Same IP but a non-default (UPnP) port — ipsMatch ignores the port.
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.5:16137');

      const dockerService = require('../../ZelBack/src/services/dockerService');
      sinon.stub(dockerService, 'getAppIdentifier').returns('appid');
      const appDockerStopStub = sinon.stub(dockerService, 'appDockerStop').resolves();

      await appOps.coordinateActiveStandbyApps();
      await new Promise((r) => { setImmediate(r); });

      expect(appDockerStopStub.called, 'primary node must not stop its own container').to.be.false;
    });

  });

  describe('shutdownPlanResync tests', () => {
    let proxyquire;

    beforeEach(() => {
      proxyquire = require('proxyquire');
    });

    function loadWith({ arcane = true, installed = [], plans = [], deployment = {} } = {}) {
      const client = {
        SOCKET_PATH: '/run/flux-shutdownd/daemon.sock',
        listAppPlans: sinon.stub().resolves(plans),
        upsertAppPlanBestEffort: sinon.stub().resolves(),
        deleteAppPlanBestEffort: sinon.stub().resolves(),
      };
      // arcane => the shutdownd socket exists (fs.access resolves); else it's absent.
      const fsPromises = {
        access: arcane ? sinon.stub().resolves() : sinon.stub().rejects(new Error('ENOENT')),
      };
      const mod = proxyquire('../../ZelBack/src/services/appLifecycle/appOperations', {
        'node:fs/promises': fsPromises,
        '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
        '../appDatabase/appsRepository': { listInstalledApps: sinon.stub().resolves(installed) },
        '../appRuntime/deploymentProvider': { buildDeployment: sinon.stub().resolves(deployment) },
        './shutdownPlan': { buildShutdownPlan: sinon.stub().returns({ app_name: 'plan' }) },
        '../utils/fluxShutdowndClient': client,
      });
      return { mod, client };
    }

    it('re-pushes a drifted plan and removes an orphan', async () => {
      const { mod, client } = loadWith({
        installed: [{ name: 'app1', owner: '1own', hash: 'hashNEW' }],
        plans: [
          { app_name: 'app1', owner_flux_id: '1own', spec_hash: 'hashOLD' },
          { app_name: 'gone', owner_flux_id: '1own', spec_hash: 'x' },
        ],
      });
      await mod.shutdownPlanResync();
      expect(client.upsertAppPlanBestEffort.calledOnce).to.be.true;
      expect(client.deleteAppPlanBestEffort.calledOnceWith('gone', '1own')).to.be.true;
    });

    it('leaves a plan untouched when its hash already matches', async () => {
      const { mod, client } = loadWith({
        installed: [{ name: 'app1', owner: '1own', hash: 'h' }],
        plans: [{ app_name: 'app1', owner_flux_id: '1own', spec_hash: 'h' }],
      });
      await mod.shutdownPlanResync();
      expect(client.upsertAppPlanBestEffort.called).to.be.false;
      expect(client.deleteAppPlanBestEffort.called).to.be.false;
    });

    it('does nothing when the shutdownd socket is absent', async () => {
      const { mod, client } = loadWith({ arcane: false });
      await mod.shutdownPlanResync();
      expect(client.listAppPlans.called).to.be.false;
    });
  });

  // Note: verifyAppUpdateParameters, createAppVolume,
  // getPeerAppsInstallingErrorMessages, and stopSyncthingApp are
  // complex integration functions or HTTP request handlers that require extensive
  // mocking of database connections, HTTP requests, and external services.
  // These should be tested in integration tests rather than unit tests.
  // masterSlaveApps is included above with basic tests, but full integration testing
  // is recommended for comprehensive coverage of the master-slave coordination logic.
});
