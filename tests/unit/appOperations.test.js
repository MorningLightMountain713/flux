// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const appOperations = require('../../ZelBack/src/services/appLifecycle/appOperations');
const appSpecHistory = require('../../ZelBack/src/services/appDatabase/appSpecHistory');
const appUninstaller = require('../../ZelBack/src/services/appLifecycle/appUninstaller');
const appReconciler = require('../../ZelBack/src/services/appMonitoring/appReconciler');
const componentProvisioner = require('../../ZelBack/src/services/appLifecycle/componentProvisioner');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const deviceHelper = require('../../ZelBack/src/services/deviceHelper');
const log = require('../../ZelBack/src/lib/log');
const deploymentProvider = require('../../ZelBack/src/services/appRuntime/deploymentProvider');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');
const fluxEventBus = require('../../ZelBack/src/services/utils/fluxEventBus');
const globalState = require('../../ZelBack/src/services/utils/globalState');
const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');
const contentBlobService = require('../../ZelBack/src/services/appLifecycle/contentBlobService');
const appsRuntimeState = require('../../ZelBack/src/services/appManagement/appsRuntimeState');
const dockerService = require('../../ZelBack/src/services/dockerService');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const registryManager = require('../../ZelBack/src/services/appDatabase/registryManager');
const appQueryService = require('../../ZelBack/src/services/appQuery/appQueryService');
const syncthingService = require('../../ZelBack/src/services/syncthingService');
const config = require('config');
const proxyquire = require('proxyquire');

describe('appOperations tests', () => {
  beforeEach(() => {
    // Delegate the plural provider entries to the singular stubs each test
    // installs, at call time, so per-test failure injection flows through.
    sinon.stub(deploymentProvider, 'getInstalledDeployments').callsFake(async (name) => {
      const deployment = await deploymentProvider.getInstalledDeployment(name);
      return deployment ? [deployment] : [];
    });
    sinon.stub(deploymentProvider, 'buildDeployments').callsFake(async (inst) => {
      const deployment = await deploymentProvider.buildDeployment(inst, { replica: null });
      return deployment ? [deployment] : [];
    });
  });

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

  describe('contentBlobServeApi tests', () => {
    function makeRes() {
      const res = {};
      res.status = sinon.stub().returns(res);
      res.set = sinon.stub().returns(res);
      res.send = sinon.stub().returns(res);
      res.end = sinon.stub().returns(res);
      return res;
    }

    it('rejects with 503 when the node is not arcane', async () => {
      sinon.stub(globalState, 'isArcane').returns(false);
      const res = makeRes();
      await appOperations.contentBlobServeApi({ params: { appName: 'myapp', locator: 'loc' } }, res);
      sinon.assert.calledWith(res.status, 503);
    });

    it('serves the blob using the installed app owner as the fluxID', async () => {
      sinon.stub(globalState, 'isArcane').returns(true);
      sinon.stub(appsRepository, 'getInstalledApp').resolves({ owner: 'owner1' });
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves({ marker: 'deployment' });
      const framed = Buffer.from('cipher');
      const serveBlob = sinon.stub(contentBlobService, 'serveBlob').resolves(framed);
      const res = makeRes();

      await appOperations.contentBlobServeApi({ params: { appName: 'myapp', locator: 'loc-1' } }, res);

      // the locator is owner-keyed: fluxID must be the installed app's owner
      const [reqArg] = serveBlob.firstCall.args;
      expect(reqArg).to.include({ appName: 'myapp', fluxID: 'owner1', locator: 'loc-1' });
      sinon.assert.calledWith(res.send, framed);
    });

    it('returns 404 when the app is not installed on this node', async () => {
      sinon.stub(globalState, 'isArcane').returns(true);
      sinon.stub(appsRepository, 'getInstalledApp').resolves(null);
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(null);
      const res = makeRes();
      await appOperations.contentBlobServeApi({ params: { appName: 'ghost', locator: 'loc' } }, res);
      sinon.assert.calledWith(res.status, 404);
    });

    it('returns 404 when no local mount matches the requested locator', async () => {
      sinon.stub(globalState, 'isArcane').returns(true);
      sinon.stub(appsRepository, 'getInstalledApp').resolves({ owner: 'owner1' });
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves({ marker: 'd' });
      sinon.stub(contentBlobService, 'serveBlob').resolves(null);
      const res = makeRes();
      await appOperations.contentBlobServeApi({ params: { appName: 'myapp', locator: 'nope' } }, res);
      sinon.assert.calledWith(res.status, 404);
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
      // runs, then return null so the catch path releases it (and hands off to the reconciler).
      sinon.stub(deploymentProvider, 'getInstalledDeployment').callsFake(async () => {
        leaseTypeDuring = operationRegistry.get('myapp')?.type ?? null;
        return null;
      });
      sinon.stub(appReconciler, 'enqueue');

      await appOperations.redeployComponent('myapp', 'frontend', { onStatus: () => {} });

      expect(leaseTypeDuring, 'a softRedeploy lease must be held while the redeploy runs').to.equal('softRedeploy');
      expect(operationRegistry.isHeld('myapp'), 'the redeploy lease must release when the operation settles').to.be.false;
    });

    it('hands recovery to the reconciler (no destroy) when application not found', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(null);
      const uninstall = sinon.stub(appUninstaller, 'uninstallApplication').resolves();
      const enqueue = sinon.stub(appReconciler, 'enqueue');

      await appOperations.redeployComponent('myapp', 'frontend', { onStatus: () => {} });

      expect(operationRegistry.isHeld('myapp'), 'the redeploy lease must release on error').to.be.false;
      expect(uninstall.called, 'a redeploy failure must NOT destroy the app').to.be.false;
      expect(enqueue.calledOnceWith('myapp')).to.be.true;
    });

    it('hands recovery to the reconciler (no destroy) when component not found in app', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves({
        getComponent: () => null,
      });
      const uninstall = sinon.stub(appUninstaller, 'uninstallApplication').resolves();
      const enqueue = sinon.stub(appReconciler, 'enqueue');

      await appOperations.redeployComponent('myapp', 'frontend', { onStatus: () => {} });

      expect(operationRegistry.isHeld('myapp'), 'the redeploy lease must release on error').to.be.false;
      expect(uninstall.called, 'must not destroy an intact app over a bad component name').to.be.false;
      expect(enqueue.calledOnceWith('myapp')).to.be.true;
    });

    // Prong A: a broken new image is rejected by the pre-flight BEFORE the old version
    // is torn down, so the running app is never disturbed by a bad redeploy.
    it('aborts without tearing down the old version when the new image fails pre-flight verify', async () => {
      const deployComp = { identifier: 'frontend_myapp', image: 'myrepo/app:deleted-tag' };
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves({ getComponent: () => deployComp });
      sinon.stub(componentProvisioner, 'verifyComponentImage').rejects(new Error('image not found in registry'));
      const uninstallComponent = sinon.stub(appUninstaller, 'uninstallComponent').resolves();
      const uninstallApplication = sinon.stub(appUninstaller, 'uninstallApplication').resolves();
      const enqueue = sinon.stub(appReconciler, 'enqueue');

      await appOperations.redeployComponent('myapp', 'frontend', { onStatus: () => {} });

      expect(uninstallComponent.called, 'must NOT tear down the old version when the new image fails pre-flight').to.be.false;
      expect(uninstallApplication.called, 'and must NOT destroy the app').to.be.false;
      expect(enqueue.calledOnceWith('myapp')).to.be.true;
      expect(operationRegistry.isHeld('myapp')).to.be.false;
    });


    // A same-spec redeploy reinstalls the identical component, so its port set never
    // changes. Both the teardown and the reinstall must leave the app's ufw/UPnP rules
    // in place (skipPorts) — no firewall flap, no UPnP re-map churn.
    it('leaves ufw/UPnP untouched: teardown and reinstall both run with skipPorts', async () => {
      // eslint-disable-next-line global-require
      const hwRequirements = require('../../ZelBack/src/services/appRequirements/hwRequirements');
      const deployComp = { identifier: 'frontend_myapp', image: 'myrepo/app:v1' };
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves({ getComponent: () => deployComp });
      sinon.stub(componentProvisioner, 'verifyComponentImage').resolves();
      sinon.stub(serviceHelper, 'delay').resolves();
      sinon.stub(appsRepository, 'getInstalledApp').resolves({ version: 8, owner: 'owner1' });
      sinon.stub(deploymentProvider, 'buildDeployment').resolves({ marker: 'fresh', componentEntries: () => [] });
      sinon.stub(hwRequirements, 'checkNodeResources').resolves();
      // The redeploy/update path uses the reclaiming variant: these run AFTER
      // the containers are gone, so a shortfall leaves a paid app destroyed and
      // free session capacity must never be what causes one.
      sinon.stub(hwRequirements, 'checkNodeResourcesReclaiming').resolves();
      const uninstallComponent = sinon.stub(appUninstaller, 'uninstallComponent').resolves();
      const installComponent = sinon.stub(componentProvisioner, 'installComponent').resolves();
      sinon.stub(appReconciler, 'enqueue');

      await appOperations.redeployComponent('myapp', 'frontend', { onStatus: () => {} });

      expect(uninstallComponent.calledOnceWith(deployComp, sinon.match({ skipPorts: true })), 'teardown must skip ports').to.be.true;
      expect(installComponent.calledOnceWith(deployComp, sinon.match({ skipPorts: true })), 'reinstall must skip ports').to.be.true;
    });
  });

  describe('redeployApplication pre-teardown dependency check', () => {
    // eslint-disable-next-line global-require
    const appNetworkLinker = require('../../ZelBack/src/services/appLifecycle/appNetworkLinker');

    beforeEach(() => {
      operationRegistry.clear();
    });

    // Same contract as the image pre-flight: a redeploy that cannot complete must be
    // rejected BEFORE the old version is torn down, never after.
    it('aborts without tearing down the old version when a shareWith dependency is missing', async () => {
      const deployComp = { identifier: 'frontend_myapp', image: 'myrepo/app:v1' };
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves({ componentEntries: () => [['frontend', deployComp]] });
      sinon.stub(componentProvisioner, 'verifyComponentImage').resolves();
      sinon.stub(serviceHelper, 'delay').resolves();
      sinon.stub(appsRepository, 'getInstalledApp').resolves({ name: 'myapp', owner: 'owner1' });
      sinon.stub(appNetworkLinker, 'checkAppNetworkRequirements').rejects(
        Object.assign(new Error("App 'collector' that 'myapp' must be networked with is not installed on this node. Installation aborted."), { code: 'NETWORK_DEPENDENCY_NOT_READY' }),
      );
      const uninstallComponent = sinon.stub(appUninstaller, 'uninstallComponent').resolves();
      const uninstallApplication = sinon.stub(appUninstaller, 'uninstallApplication').resolves();
      const enqueue = sinon.stub(appReconciler, 'enqueue');

      await appOperations.redeployApplication('myapp', { onStatus: () => {} });

      expect(uninstallComponent.called, 'must NOT tear down the old version when a dependency is missing').to.be.false;
      expect(uninstallApplication.called, 'and must NOT destroy the app').to.be.false;
      expect(enqueue.calledOnceWith('myapp')).to.be.true;
      expect(operationRegistry.isHeld('myapp')).to.be.false;
    });

    it('proceeds to teardown when every shareWith dependency is satisfied', async () => {
      const deployComp = { identifier: 'frontend_myapp', image: 'myrepo/app:v1' };
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves({ componentEntries: () => [['frontend', deployComp]] });
      sinon.stub(componentProvisioner, 'verifyComponentImage').resolves();
      sinon.stub(serviceHelper, 'delay').resolves();
      // First read feeds the pre-teardown check; the post-teardown read returns null so
      // the run settles through the catch without exercising the full reinstall path.
      const getInstalledApp = sinon.stub(appsRepository, 'getInstalledApp');
      getInstalledApp.onFirstCall().resolves({ name: 'myapp', owner: 'owner1' });
      getInstalledApp.onSecondCall().resolves(null);
      sinon.stub(appNetworkLinker, 'checkAppNetworkRequirements').resolves(true);
      const uninstallComponent = sinon.stub(appUninstaller, 'uninstallComponent').resolves();
      sinon.stub(appReconciler, 'enqueue');

      await appOperations.redeployApplication('myapp', { onStatus: () => {} });

      expect(uninstallComponent.called, 'a satisfied dependency check must not block the redeploy').to.be.true;
      expect(operationRegistry.isHeld('myapp')).to.be.false;
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
      sinon.stub(appReconciler, 'enqueue');

      await appOperations.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: () => {} });

      expect(leaseTypeDuring, 'a hardRedeploy lease must be held while the rebuild runs').to.equal('hardRedeploy');
      expect(operationRegistry.isHeld('myapp'), 'the rebuild lease must release when the operation settles').to.be.false;
    });


    it('hands recovery to the reconciler (no destroy) when application not found', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(null);
      const uninstall = sinon.stub(appUninstaller, 'uninstallApplication').resolves();
      const enqueue = sinon.stub(appReconciler, 'enqueue');

      await appOperations.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: () => {} });

      expect(operationRegistry.isHeld('myapp'), 'the rebuild lease must release on error').to.be.false;
      expect(uninstall.called).to.be.false;
      expect(enqueue.calledOnceWith('myapp')).to.be.true;
    });

    it('hands recovery to the reconciler (no destroy) when component not found in app', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves({
        getComponent: () => null,
      });
      const uninstall = sinon.stub(appUninstaller, 'uninstallApplication').resolves();
      const enqueue = sinon.stub(appReconciler, 'enqueue');

      await appOperations.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: () => {} });

      expect(operationRegistry.isHeld('myapp'), 'the rebuild lease must release on error').to.be.false;
      expect(uninstall.called).to.be.false;
      expect(enqueue.calledOnceWith('myapp')).to.be.true;
    });

    it('should release the rebuild lease on error', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(null);
      sinon.stub(appReconciler, 'enqueue');

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

  // A pass is one call: the cadence lives in startActiveStandbyCoordinator's interval,
  // so a test drives passes by calling coordinateActiveStandbyApps directly.
  describe('coordinateActiveStandbyApps tests', () => {
    let globalStateRef;
    let deploymentProviderStub;

    beforeEach(() => {
      globalStateRef = globalState;
      operationRegistry.clear();
      // the first-run mount-safety gate blocks election until the syncthing
      // monitor's first cycle completes; these tests model a settled node
      globalStateRef.syncthingAppsFirstRun = false;
      sinon.stub(appsRuntimeState, 'isOperatorStopped').resolves(false);
      sinon.stub(serviceHelper, 'delay').resolves();

      sinon.stub(syncthingService, 'getHealth').resolves({
        status: 'success',
        data: { status: 'OK' },
      });

      deploymentProviderStub = sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves([]);

      sinon.stub(appQueryService, 'listRunningContainers').resolves([]);

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

    // The election's decisions are otherwise only observable as side effects on docker and
    // syncthing, so these assert the bus events the loop publishes for each decision.
    const decisionsFor = (publish, identifier, action) => publish.getCalls().filter(
      (c) => c.args[0] === 'activeStandby:decided'
        && c.args[1].identifier === identifier
        && c.args[1].action === action,
    );

    const gDeployment = (appName, identifier) => ({
      appName,
      componentEntries: () => [[identifier.split('_')[0], {
        identifier,
        hasActiveStandbySyncthing: () => true,
        hasSyncthing: () => true,
      }]],
    });

    it('announces an operator-stopped component once, not on every pass', async () => {
      const identifier = 'opstopa_appa';
      deploymentProviderStub.resolves([gDeployment('appa', identifier)]);

      appsRuntimeState.isOperatorStopped.resetBehavior();
      appsRuntimeState.isOperatorStopped.resolves(true);

      sinon.stub(dockerService, 'getAppIdentifier').returns(`flux${identifier}`);
      const publish = sinon.stub(fluxEventBus, 'publish');

      await appOperations.coordinateActiveStandbyApps();
      await appOperations.coordinateActiveStandbyApps();

      // silence here is indistinguishable from a dead loop, but a line every 30s is noise
      expect(decisionsFor(publish, identifier, 'operatorStopExcluded')).to.have.lengthOf(1);
    });

    it('announces again after the operator lock is lifted and re-applied', async () => {
      const identifier = 'opstopb_appb';
      deploymentProviderStub.resolves([gDeployment('appb', identifier)]);

      appsRuntimeState.isOperatorStopped.resetBehavior();
      appsRuntimeState.isOperatorStopped.resolves(true);

      sinon.stub(dockerService, 'getAppIdentifier').returns(`flux${identifier}`);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.5:16137');
      sinon.stub(serviceHelper, 'axiosGet').resolves({ data: { status: 'success', data: { ips: [] } } });
      const publish = sinon.stub(fluxEventBus, 'publish');

      await appOperations.coordinateActiveStandbyApps();

      appsRuntimeState.isOperatorStopped.resetBehavior();
      appsRuntimeState.isOperatorStopped.resolves(false);
      await appOperations.coordinateActiveStandbyApps();

      appsRuntimeState.isOperatorStopped.resetBehavior();
      appsRuntimeState.isOperatorStopped.resolves(true);
      await appOperations.coordinateActiveStandbyApps();

      expect(decisionsFor(publish, identifier, 'operatorStopCleared')).to.have.lengthOf(1);
      expect(decisionsFor(publish, identifier, 'operatorStopExcluded')).to.have.lengthOf(2);
    });

    it('is driven by an interval at the configured cadence, not by re-arming itself', async () => {
      // The loop used to re-arm only from its own finally, so a pass that never settled
      // stopped election on the node permanently until FluxOS restarted.
      const setIntervalStub = sinon.stub(global, 'setInterval').returns('handle');

      const handle = appOperations.startActiveStandbyCoordinator();

      expect(handle).to.equal('handle');
      expect(setIntervalStub.calledOnce).to.be.true;
      expect(setIntervalStub.firstCall.args[1]).to.equal(config.fluxapps.masterSlaveIntervalMs);
    });

    it('never runs two passes at once', async () => {
      // The cadence is fixed, so a pass that outruns it would otherwise have a second one
      // racing its own promotions.
      let releaseFirstPass;
      deploymentProviderStub.onFirstCall().returns(new Promise((resolve) => {
        releaseFirstPass = () => resolve([]);
      }));
      deploymentProviderStub.resolves([]);
      const setIntervalStub = sinon.stub(global, 'setInterval');

      appOperations.startActiveStandbyCoordinator();
      const tick = setIntervalStub.firstCall.args[0];

      const firstPass = tick(); // starts and blocks in the middle of its work
      await Promise.resolve();
      await tick(); // must find the pass in flight and stand down
      expect(deploymentProviderStub.callCount, 'a tick during a pass must not start another').to.equal(1);

      releaseFirstPass();
      await firstPass; // the callback settles only once the pass has finished

      await tick();
      expect(deploymentProviderStub.callCount, 'the next tick after a pass settles must run').to.equal(2);
    });

    it('clears its own stale primary record so a stopped last primary can be elected again', async () => {
      // The node remembers itself as primary but is not running the component - the state
      // two production apps were stuck in for 12 and 25 hours, recoverable only by
      // restarting FluxOS. Without the eviction every start branch is closed to it.
      const identifier = 'staleprim_appc';
      const appId = `flux${identifier}`;
      deploymentProviderStub.resolves([gDeployment('appc', identifier)]);

      sinon.stub(dockerService, 'getAppIdentifier').returns(appId);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.5:16137');

      // Pass 1 records this node as primary (FDM names it, and it is running here, so the
      // loop takes no action beyond the record). Pass 2 is the wedge: FDM has forgotten the
      // app and the container is gone, leaving the record naming a node that isn't running it.
      const listRunningContainers = sinon.stub();
      listRunningContainers.onFirstCall().resolves([{ Names: [`/${appId}`] }]);
      listRunningContainers.resolves([]);
      const appOps = proxyquire('../../ZelBack/src/services/appLifecycle/appOperations', {
        '../appQuery/appQueryService': { ...appQueryService, listRunningContainers },
      });

      const axiosGet = sinon.stub(serviceHelper, 'axiosGet');
      axiosGet.onFirstCall().resolves({ data: { status: 'success', data: { ips: ['192.168.1.5'] } } });
      axiosGet.resolves({ data: { status: 'success', data: { ips: [] } } });

      // this node is index 0 and its data is ready
      sinon.stub(registryManager, 'appLocation').resolves([{ ip: '192.168.1.5:16137' }]);
      globalStateRef.receiveOnlySyncthingAppsCache.set(appId, { restarted: true });

      const publish = sinon.stub(fluxEventBus, 'publish');

      await appOps.coordinateActiveStandbyApps(); // records this node as primary
      await appOps.coordinateActiveStandbyApps(); // gone from FDM, and not running here

      expect(decisionsFor(publish, identifier, 'stalePrimaryEvicted')).to.have.lengthOf(1);
      globalStateRef.receiveOnlySyncthingAppsCache.delete(appId);
    });
  });

  describe('shutdownPlanResync tests', () => {
    let proxyquire;

    beforeEach(() => {
      proxyquire = require('proxyquire');
    });

    function loadWith({
      arcane = true, installed = [], plans = [], deployment = {}, deployments = null,
      buildThrows = false, requires = true,
    } = {}) {
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
      const providerStub = {
        buildDeployment: sinon.stub().resolves(deployment),
        // Delegates at call time so per-test overrides of buildDeployment flow
        // through the plural entry the resync uses; `deployments`/`buildThrows`
        // exercise the multi-identity and build-failure paths directly.
        get buildDeployments() {
          if (buildThrows) return async () => { throw new Error('resolve failed'); };
          if (deployments) return async () => deployments;
          const single = this.buildDeployment;
          return async (inst) => {
            const built = await single(inst);
            return built ? [built] : [];
          };
        },
      };
      const mod = proxyquire('../../ZelBack/src/services/appLifecycle/appOperations', {
        'node:fs/promises': fsPromises,
        '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
        '../appDatabase/appsRepository': { listInstalledApps: sinon.stub().resolves(installed) },
        '../appRuntime/deploymentProvider': providerStub,
        './shutdownPlan': {
          buildShutdownPlan: sinon.stub().callsFake((inst, dep) => ({ app_name: inst.name, replica: dep.replica ?? null })),
          appRequiresDaemonShutdown: sinon.stub().returns(requires),
        },
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

    it('orphan-deletes the plan of an installed app that no longer needs daemon shutdown', async () => {
      // The app dropped its graceful-shutdown features (spec hash drifted), so the
      // predicate is now false: it must be excluded from `live` and its stale plan
      // removed, never re-pushed.
      const { mod, client } = loadWith({
        installed: [{ name: 'app1', owner: '1own', hash: 'hashNEW' }],
        plans: [{ app_name: 'app1', owner_flux_id: '1own', spec_hash: 'hashOLD' }],
        requires: false,
      });
      await mod.shutdownPlanResync();
      expect(client.upsertAppPlanBestEffort.called).to.be.false;
      expect(client.deleteAppPlanBestEffort.calledOnceWith('app1', '1own')).to.be.true;
    });

    it('pushes no plan for a non-requiring installed app with no stored plan', async () => {
      const { mod, client } = loadWith({
        installed: [{ name: 'plain', owner: '1own', hash: 'h' }],
        plans: [],
        requires: false,
      });
      await mod.shutdownPlanResync();
      expect(client.upsertAppPlanBestEffort.called).to.be.false;
      expect(client.deleteAppPlanBestEffort.called).to.be.false;
    });

    it('keys per replica: re-pushes each assigned identity and orphan-deletes a de-assigned one', async () => {
      const { mod, client } = loadWith({
        installed: [{ name: 'app1', owner: '1own', hash: 'hashNEW' }],
        plans: [
          { app_name: 'app1', owner_flux_id: '1own', replica: 's1', spec_hash: 'hashOLD' },
          { app_name: 'app1', owner_flux_id: '1own', replica: 's2', spec_hash: 'hashOLD' },
        ],
        deployments: [{ replica: 's1' }],
      });
      await mod.shutdownPlanResync();
      expect(client.upsertAppPlanBestEffort.calledOnce).to.be.true;
      expect(client.upsertAppPlanBestEffort.firstCall.args[0].replica).to.equal('s1');
      // s2 is no longer assigned here: its plan is an orphan, deleted by identity.
      expect(client.deleteAppPlanBestEffort.calledOnceWith('app1', '1own', 's2')).to.be.true;
    });

    it('a matching hash keeps each replica plan without a re-push', async () => {
      const { mod, client } = loadWith({
        installed: [{ name: 'app1', owner: '1own', hash: 'h' }],
        plans: [
          { app_name: 'app1', owner_flux_id: '1own', replica: 's1', spec_hash: 'h' },
          { app_name: 'app1', owner_flux_id: '1own', replica: 's2', spec_hash: 'h' },
        ],
        deployments: [{ replica: 's1' }, { replica: 's2' }],
      });
      await mod.shutdownPlanResync();
      expect(client.upsertAppPlanBestEffort.called).to.be.false;
      expect(client.deleteAppPlanBestEffort.called).to.be.false;
    });

    it('keeps every stored plan of an app whose deployments cannot be built', async () => {
      const { mod, client } = loadWith({
        installed: [{ name: 'app1', owner: '1own', hash: 'hashNEW' }],
        plans: [
          { app_name: 'app1', owner_flux_id: '1own', replica: 's1', spec_hash: 'hashOLD' },
          { app_name: 'app1', owner_flux_id: '1own', replica: 's2', spec_hash: 'hashOLD' },
        ],
        buildThrows: true,
      });
      await mod.shutdownPlanResync();
      // Couldn't evaluate the app: keeping a possibly stale plan beats orphaning
      // a live one.
      expect(client.deleteAppPlanBestEffort.called).to.be.false;
      expect(client.upsertAppPlanBestEffort.called).to.be.false;
    });
  });

  describe('reconcileComponents port-delta tests', () => {
    // A spec-change reconcile must move only the ufw/UPnP rules that changed: close the
    // dropped ports (old−new), open the added ports (new−old), leave the kept ports'
    // mappings in place. The per-component teardown/reinstall run with skipPorts.
    const makeComp = (hostPorts, storage) => ({
      hostPorts,
      storage,
      identifier: `web_myapp`,
      image: 'nginx:latest',
      equals: () => false, // changed component
    });
    const makeDeployment = (components) => ({
      components,
      componentEntries: () => Object.entries(components),
      getComponent: (n) => components[n] || null,
    });

    let uninstallComponentStub;
    let denyPortsStub;
    let openHostPortsStub;
    let teardownOwedForStub;

    function setup({ teardownOwed = false } = {}) {
      // eslint-disable-next-line global-require
      const hwRequirements = require('../../ZelBack/src/services/appRequirements/hwRequirements');
      // eslint-disable-next-line global-require
      const pendingTeardownStore = require('../../ZelBack/src/services/appLifecycle/pendingTeardownStore');
      sinon.stub(componentProvisioner, 'verifyComponentImage').resolves();
      sinon.stub(serviceHelper, 'delay').resolves();
      sinon.stub(appsRepository, 'upsertInstalledApp').resolves();
      // freshDeployment = null short-circuits the install loop, telemetry and shutdown-plan
      // blocks, leaving the port close + gated open as the only port effects under test.
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(null);
      sinon.stub(hwRequirements, 'checkNodeResources').resolves();
      // The redeploy/update path uses the reclaiming variant: these run AFTER
      // the containers are gone, so a shortfall leaves a paid app destroyed and
      // free session capacity must never be what causes one.
      sinon.stub(hwRequirements, 'checkNodeResourcesReclaiming').resolves();
      sinon.stub(appUninstaller, 'reclaimUnusedImages').resolves();
      uninstallComponentStub = sinon.stub(appUninstaller, 'uninstallComponent').resolves();
      denyPortsStub = sinon.stub(appUninstaller, 'denyPorts').resolves();
      openHostPortsStub = sinon.stub(componentProvisioner, 'openHostPorts').resolves();
      teardownOwedForStub = sinon.stub(pendingTeardownStore, 'teardownOwedFor').resolves(teardownOwed);
    }

    const registrySpec = { serialize: () => ({}), version: 8, owner: 'owner1' };

    it('closes only the dropped ports, opens only the added ones, and skips ports in the loops', async () => {
      setup();
      // old: 80,443 ; new: 443,8080 -> drop 80, add 8080, keep 443.
      const oldDeployment = makeDeployment({ web: makeComp([80, 443], 5) });
      const newDeployment = makeDeployment({ web: makeComp([443, 8080], 10) });

      await appOperations.reconcileComponents('myapp', oldDeployment, newDeployment, registrySpec);

      expect(uninstallComponentStub.calledWith(sinon.match.any, sinon.match({ skipPorts: true })), 'teardown skips ports').to.be.true;
      expect(denyPortsStub.calledOnceWith([80], 'myapp'), 'closes only the dropped port').to.be.true;
      expect(openHostPortsStub.calledOnceWith([8080], 'myapp'), 'opens only the added port').to.be.true;
    });

    it('skips the port-open (but still closes) when a cancel teardown is owed', async () => {
      setup({ teardownOwed: true });
      const oldDeployment = makeDeployment({ web: makeComp([80, 443], 5) });
      const newDeployment = makeDeployment({ web: makeComp([443, 8080], 10) });

      await appOperations.reconcileComponents('myapp', oldDeployment, newDeployment, registrySpec);

      expect(teardownOwedForStub.calledWith('myapp')).to.be.true;
      expect(openHostPortsStub.called, 'a raced cancel must skip the port-open (no orphaned rules)').to.be.false;
      expect(denyPortsStub.calledOnceWith([80], 'myapp'), 'closing removed ports is always safe and still runs').to.be.true;
    });
  });

  describe('testAppMount tests', () => {
    let runCommandStub;
    let mountForTargetStub;

    beforeEach(() => {
      runCommandStub = sinon.stub(serviceHelper, 'runCommand').resolves({ error: null, stdout: '', stderr: '' });
      mountForTargetStub = sinon.stub(deviceHelper, 'mountForTarget');
      sinon.stub(log, 'info');
      sinon.stub(log, 'warn');
      sinon.stub(log, 'error');
    });

    // The trailing cleanup (removeTestAppMount) is fire-and-forget; flush the
    // microtask queue so its stubbed runCommand calls land before sinon.restore,
    // never against the real host.
    const flush = () => new Promise((resolve) => { setImmediate(resolve); });

    const fallocateCall = () => runCommandStub.getCalls().find((c) => c.args[0] === 'fallocate');

    const oneGb = 1024 ** 3;

    it('builds the test volume on the apps-folder disk that findmnt resolved, never a scanned disk', async () => {
      mountForTargetStub.resolves({ target: '/dat', availableBytes: 500 * oneGb });

      await appOperations.testAppMount();
      await flush();

      // findmnt --target the apps folder decided the disk — no node-df-style scan.
      sinon.assert.calledOnce(mountForTargetStub);
      const fallocate = fallocateCall();
      expect(fallocate, 'fallocate must run when space is sufficient').to.not.equal(undefined);
      expect(fallocate.args[1]).to.eql({ params: ['-l', '1G', '/dat/flux_fluxTestVolFLUXFSVOL'], runAsRoot: true });
      sinon.assert.calledWith(runCommandStub, 'mke2fs', sinon.match({ params: ['-t', 'ext4', '/dat/flux_fluxTestVolFLUXFSVOL'], runAsRoot: true }));
    });

    it('skips the build when the apps-folder disk lacks room', async () => {
      mountForTargetStub.resolves({ target: '/dat', availableBytes: 1 * oneGb });

      await appOperations.testAppMount();
      await flush();

      expect(fallocateCall(), 'no allocation when space is insufficient').to.equal(undefined);
    });

    it('places the loop file under the flux dir when the apps folder is on the root mount (legacy)', async () => {
      mountForTargetStub.resolves({ target: '/', availableBytes: 500 * oneGb });

      await appOperations.testAppMount();
      await flush();

      const fallocate = fallocateCall();
      expect(fallocate, 'fallocate must run when space is sufficient').to.not.equal(undefined);
      expect(fallocate.args[1].params[2]).to.include('appvolumes/flux_fluxTestVolFLUXFSVOL');
      expect(fallocate.args[1].params[2]).to.not.equal('//flux_fluxTestVolFLUXFSVOL');
    });
  });

  // A backup/restore stops the app through the reconciler's transient operation
  // hold (drive 'stopped'). The hold is in-memory run-state the operation OWES
  // BACK: an error after the stop (ENOSPC on the archive is the classic) that only
  // releases the registry lease leaves operationDesired='stopped' for the life of
  // the process - the app is stranded down and no decider can outrank the hold.
  describe('appendBackupTask hold unwind', () => {
    // eslint-disable-next-line global-require
    const verificationHelper = require('../../ZelBack/src/services/verificationHelper');
    // eslint-disable-next-line global-require
    const IOUtils = require('../../ZelBack/src/services/IOUtils');
    // eslint-disable-next-line global-require
    const volumeService = require('../../ZelBack/src/services/utils/volumeService');
    // eslint-disable-next-line global-require
    const syncthingMonitorHelpers = require('../../ZelBack/src/services/appMonitoring/syncthingMonitorHelpers');

    const makeRes = () => ({ write: sinon.stub(), end: sinon.stub() });

    it('removes the syncthing folder per synced component identifier, never by bare app name', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      // Composed app: folders are registered as flux<component>_<app>, so the
      // removal must target component identifiers - flux<app> matches nothing.
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves({
        componentEntries: () => [
          ['web', { identifier: 'web_bkapp', hasSyncthing: () => true }],
          ['worker', { identifier: 'worker_bkapp', hasSyncthing: () => false }],
        ],
      });
      const removeFolder = sinon.stub(syncthingMonitorHelpers, 'removeSyncthingFolder').resolves();
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves({ name: 'bkapp' });
      sinon.stub(deploymentProvider, 'buildDeployment').resolves({
        componentEntries: () => [['web', { identifier: 'web_bkapp' }]],
      });
      sinon.stub(appReconciler, 'drive').resolves({ converged: true, failed: [] });
      sinon.stub(volumeService, 'listComponentVolumeMounts').resolves([{ replica: null, mount: '/vol' }]);
      sinon.stub(IOUtils, 'checkFileExists').resolves(false);
      sinon.stub(IOUtils, 'removeFile').resolves();
      sinon.stub(IOUtils, 'createTarGz').resolves({ status: false, error: 'No space left on device' });

      const req = { body: { appname: 'bkapp', backup: [{ component: 'web', backup: true }] } };
      const pending = appOperations.appendBackupTask(req, makeRes());
      await clock.tickAsync(120000);
      await pending;
      clock.restore();

      expect(removeFolder.calledWith('web_bkapp'), 'the synced component folder must be removed').to.be.true;
      expect(removeFolder.calledWith('worker_bkapp'), 'unsynced components must be untouched').to.be.false;
      expect(removeFolder.calledWith('bkapp'), 'the bare app name matches no composed folder').to.be.false;
    });

    it('drives the app back to running when the archive fails after the stop', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves({ componentEntries: () => [] });
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves({ name: 'bkapp' });
      sinon.stub(deploymentProvider, 'buildDeployment').resolves({
        componentEntries: () => [['comp1', { identifier: 'comp1_bkapp' }]],
      });
      const drive = sinon.stub(appReconciler, 'drive').resolves({ converged: true, failed: [] });
      sinon.stub(volumeService, 'listComponentVolumeMounts').resolves([{ replica: null, mount: '/vol' }]);
      sinon.stub(IOUtils, 'checkFileExists').resolves(false);
      sinon.stub(IOUtils, 'removeFile').resolves();
      sinon.stub(IOUtils, 'createTarGz').resolves({ status: false, error: 'No space left on device' });

      const req = { body: { appname: 'bkapp', backup: [{ component: 'comp1', backup: true }] } };
      const pending = appOperations.appendBackupTask(req, makeRes());
      await clock.tickAsync(120000); // flush sendChunk's per-chunk timers + delays
      const result = await pending;
      clock.restore();

      expect(result).to.be.false;
      expect(drive.calledWith(['comp1_bkapp'], 'stopped'), 'the backup must stop through the reconciler hold').to.be.true;
      expect(drive.calledWith(['comp1_bkapp'], 'running'), 'the failed backup must give the hold back - the app must not stay stranded stopped').to.be.true;
      expect(operationRegistry.isHeld('bkapp'), 'the backup lease must release on failure').to.be.false;
    });

    it('never drives run-state when a foreign operation already holds the app', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
      const drive = sinon.stub(appReconciler, 'drive').resolves({ converged: true, failed: [] });
      operationRegistry.acquire('bkapp', 'install', 'test', 'concurrent install');

      const req = { body: { appname: 'bkapp', backup: [{ component: 'comp1', backup: true }] } };
      const pending = appOperations.appendBackupTask(req, makeRes());
      await clock.tickAsync(120000);
      const result = await pending;
      clock.restore();

      expect(result).to.be.false;
      expect(drive.called, 'an error before owning the operation must not touch a foreign hold').to.be.false;
      expect(operationRegistry.isHeld('bkapp'), 'the foreign lease must survive').to.be.true;
    });

    // A co-located node holds one volume per replica. These used to take [0] of
    // the matching mounts, so a backup archived an arbitrary sibling.
    describe('co-located identities', () => {
      const coLocated = [
        { replica: 's1', mount: '/vol/s1' },
        { replica: 's2', mount: '/vol/s2' },
      ];

      function setupBackup(volumes) {
        sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
        sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves({
          componentEntries: () => [['web', { identifier: 'web_bkapp', hasSyncthing: () => false }]],
        });
        sinon.stub(appsRepository, 'getGlobalAppInfo').resolves({ name: 'bkapp' });
        sinon.stub(appReconciler, 'drive').resolves({ converged: true, failed: [] });
        sinon.stub(volumeService, 'listComponentVolumeMounts').resolves(volumes);
        sinon.stub(IOUtils, 'checkFileExists').resolves(false);
        sinon.stub(IOUtils, 'removeFile').resolves();
        return sinon.stub(IOUtils, 'createTarGz').resolves({ status: true });
      }

      it('archives every identity when the task names no replica', async () => {
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
        const createTarGz = setupBackup(coLocated);

        const req = { body: { appname: 'bkapp', backup: [{ component: 'web', backup: true }] } };
        const pending = appOperations.appendBackupTask(req, makeRes());
        await clock.tickAsync(120000);
        await pending;
        clock.restore();

        expect(createTarGz.callCount, 'one archive per replica').to.equal(2);
        expect(createTarGz.getCall(0).args[0]).to.equal('/vol/s1/appdata');
        expect(createTarGz.getCall(1).args[0]).to.equal('/vol/s2/appdata');
      });

      it('archives exactly the replica the task names', async () => {
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
        const createTarGz = setupBackup(coLocated);

        const req = { body: { appname: 'bkapp', backup: [{ component: 'web', backup: true, replica: 's2' }] } };
        const pending = appOperations.appendBackupTask(req, makeRes());
        await clock.tickAsync(120000);
        await pending;
        clock.restore();

        expect(createTarGz.callCount).to.equal(1);
        expect(createTarGz.getCall(0).args[0], 'the sibling must be untouched').to.equal('/vol/s2/appdata');
      });

      it('fails rather than archive a sibling when the named replica is absent', async () => {
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
        const createTarGz = setupBackup(coLocated);

        const req = { body: { appname: 'bkapp', backup: [{ component: 'web', backup: true, replica: 's9' }] } };
        const pending = appOperations.appendBackupTask(req, makeRes());
        await clock.tickAsync(120000);
        const result = await pending;
        clock.restore();

        expect(result).to.be.false;
        expect(createTarGz.called, 'no archive may be written for an identity that is not here').to.be.false;
      });
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
