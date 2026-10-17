'use strict';

// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const appOperations = require('../../ZelBack/src/services/appLifecycle/appOperations');
const appUninstaller = require('../../ZelBack/src/services/appLifecycle/appUninstaller');
const appReconciler = require('../../ZelBack/src/services/appMonitoring/appReconciler');
const componentProvisioner = require('../../ZelBack/src/services/appLifecycle/componentProvisioner');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const log = require('../../ZelBack/src/lib/log');
const deploymentProvider = require('../../ZelBack/src/services/appRuntime/deploymentProvider');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');
const fluxEventBus = require('../../ZelBack/src/services/utils/fluxEventBus');
const globalState = require('../../ZelBack/src/services/utils/globalState');
const appDataEntries = require('../../ZelBack/src/services/utils/appDataEntries');
const appCaches = require('../../ZelBack/src/services/utils/appCaches');
const contentBlobService = require('../../ZelBack/src/services/appLifecycle/contentBlobService');
const appsRuntimeState = require('../../ZelBack/src/services/appManagement/appsRuntimeState');
const dockerService = require('../../ZelBack/src/services/dockerService');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const nodeConfirmationService = require('../../ZelBack/src/services/nodeConfirmationService');
const registryManager = require('../../ZelBack/src/services/appDatabase/registryManager');
const appQueryService = require('../../ZelBack/src/services/appQuery/appQueryService');
const syncthingService = require('../../ZelBack/src/services/syncthingService');
const config = require('config');
const proxyquire = require('proxyquire');
const { appsFolder } = require('../../ZelBack/src/services/utils/appConstants');
const { Privilege } = require('../../ZelBack/src/services/utils/privileges');
const {
  loadSpecLibrary, V9_SUBMISSION, v9Spec, registeredSpec, assertAnswers,
} = require('./fixtures/fluxSpec');
const {
  stubRegistry, stubInstanceResources, inMemoryInstanceResources, stubHostedInstances, installedRecord,
} = require('./fixtures/appRecords');
const specLibrary = require('../../ZelBack/src/services/utils/specLibrary');
const domain = require('./fixtures/appDomain');
const relationshipResolver = require('../../ZelBack/src/services/appLifecycle/relationshipResolver');
const shutdownPlan = require('../../ZelBack/src/services/appLifecycle/shutdownPlan');
const componentProvisioner2 = require('../../ZelBack/src/services/appLifecycle/componentProvisioner');
const appGiveUp = require('../../ZelBack/src/services/appLifecycle/appGiveUp');
const owedRemovals = require('../../ZelBack/src/services/appLifecycle/owedRemovals');
const appHistory = require('../../ZelBack/src/services/appDecisions/appHistory');
const componentKeyMap = require('../../ZelBack/src/services/appLifecycle/componentKeyMap');
const globalCommand = require('../../ZelBack/src/services/appManagement/globalCommand');
const syncthingFolderStateMachine = require('../../ZelBack/src/services/appMonitoring/syncthingFolderStateMachine');
const hwRequirements = require('../../ZelBack/src/services/appRequirements/hwRequirements');
const fluxShutdowndClient = require('../../ZelBack/src/services/utils/fluxShutdowndClient');
const { resolveRegisteredSpec } = require('../../ZelBack/src/services/utils/specCutover');
const volumeService = require('../../ZelBack/src/services/utils/volumeService');
const IOUtils = require('../../ZelBack/src/services/IOUtils');
const syncthingMonitorHelpers = require('../../ZelBack/src/services/appMonitoring/syncthingMonitorHelpers');
const appVolumeService = require('../../ZelBack/src/services/appLifecycle/appVolumeService');
const contentSlotService = require('../../ZelBack/src/services/appLifecycle/contentSlotService');
const proxyquireStrict = require('proxyquire').noCallThru();
const verificationHelper = require('../../ZelBack/src/services/verificationHelper');

// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. What stays stubbed is I/O and FluxOS policy: the daemon socket, mongo,
// docker, the syncthing API, the resource gate.
let flux;

// An identity a registration minted: what the app's containers carry, and never
// the app's name.
const IDENTITY = `b${'a'.repeat(52)}`;

describe('appOperations tests', () => {
  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30_000);
    flux = await loadSpecLibrary();
  });

  /**
   * A real DeploymentSpec — the class deploymentProvider hands every caller in
   * this module (it builds them with the same appsFolder). `replica` is stated,
   * never defaulted, exactly as DeploymentSpec.fromSpec demands.
   */
  function deploymentFor(spec, opts = {}) {
    return flux.DeploymentSpec.fromSpec(spec, appsFolder, { replica: null, registrationVersion: 9, ...opts });
  }

  /** A real FluxAppSpecV9 with one component, named. */
  function specWithComponents(appName, components) {
    const built = {};
    for (const [compName, overrides] of Object.entries(components)) {
      built[compName] = { ...V9_SUBMISSION.components.web, name: compName, ...overrides };
    }
    return v9Spec({ name: appName, components: built });
  }

  /** A real DeploymentSpec for a one-component app. */
  async function oneComponentDeployment(appName, compName, overrides = {}, depOpts = {}) {
    return deploymentFor(await specWithComponents(appName, { [compName]: overrides }), depOpts);
  }

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
    sinon.stub(deploymentProvider, 'planDeployments').callsFake(async (registered, opts) => {
      const deployment = await deploymentProvider.planDeployment(registered, { ...opts, replica: null });
      return deployment ? [deployment] : [];
    });
  });

  afterEach(() => {
    sinon.restore();
    operationRegistry.clear();
  });

  describe('updateAppGlobaly message type', () => {
    const params = (type) => ({
      appSpecification: {}, timestamp: 1, signature: 's', type, version: 1,
    });

    it('refuses an update under any type but fluxappupdate', async () => {
      for (const type of ['zelappupdate', 'fluxappregister']) {
        // eslint-disable-next-line no-await-in-loop
        const error = await appOperations.updateAppGlobaly(params(type)).catch((e) => e);
        expect(error.message, type).to.equal('Invalid type of message');
      }
    });

    it('passes the type check under fluxappupdate', async () => {
      const error = await appOperations.updateAppGlobaly(params('fluxappupdate')).catch((e) => e);
      expect(error && error.message).to.not.equal('Invalid type of message');
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

    it('serves the blob from the installed app store, by the installed app\'s identity', async () => {
      sinon.stub(globalState, 'isArcane').returns(true);
      // The installed row hydrates to an RegisteredSpec; its identity is what
      // the locator was derived for and what keys the artifact store.
      const installed = await registeredSpec(await v9Spec(), { identity: `b${'a'.repeat(52)}` });
      stubHostedInstances().byName.resolves(installedRecord(installed));
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(await oneComponentDeployment('myapp', 'web'));
      const framed = Buffer.from('cipher');
      const serveBlob = sinon.stub(contentBlobService, 'serveBlob').resolves(framed);
      const res = makeRes();

      await appOperations.contentBlobServeApi({ params: { appName: 'myapp', locator: 'loc-1' } }, res);

      const [reqArg] = serveBlob.firstCall.args;
      expect(reqArg).to.deep.equal({ appName: 'myapp', identity: installed.identity, locator: 'loc-1' });
      sinon.assert.calledWith(res.send, framed);
    });

    it('returns 404 when the app is not installed on this node', async () => {
      sinon.stub(globalState, 'isArcane').returns(true);
      stubHostedInstances().byName.resolves(installedRecord(null));
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(null);
      const res = makeRes();
      await appOperations.contentBlobServeApi({ params: { appName: 'ghost', locator: 'loc' } }, res);
      sinon.assert.calledWith(res.status, 404);
    });

    it('returns 404 when no local mount matches the requested locator', async () => {
      sinon.stub(globalState, 'isArcane').returns(true);
      stubHostedInstances().byName.resolves(installedRecord(await registeredSpec(await v9Spec())));
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(await oneComponentDeployment('myapp', 'web'));
      sinon.stub(contentBlobService, 'serveBlob').resolves(null);
      const res = makeRes();
      await appOperations.contentBlobServeApi({ params: { appName: 'myapp', locator: 'nope' } }, res);
      sinon.assert.calledWith(res.status, 404);
    });
  });

  describe('redeployComponentAPI tests', () => {
    let req;
    let res;

    beforeEach(() => {
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
        end: sinon.stub(),
        // The endpoints stream, so they read both before writing and before
        // closing. A double without them reports every response as already
        // finished and no assertion below could see a write.
        writableEnded: false,
        headersSent: false,
      };
      // express returns the response from status() so the call chains
      res.status = sinon.stub().returns(res);
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
      expect(
        verificationHelper.verifyPrivilege.calledWith(Privilege.APP_OWNER_OR_FLUX_TEAM, null, { appName: 'myapp' }),
        'the privilege member, the auth the request carries, and the app name as { appName }',
      ).to.be.true;
    });

    it('should handle force parameter from query string', async () => {
      req.params.appname = 'myapp';
      req.params.component = 'frontend';
      req.query.force = 'true';

      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.5:16137');
      sinon.stub(dbHelper, 'databaseConnection').returns({
        db: () => ({}),
      });
      sinon.stub(dbHelper, 'findOneInDatabase').resolves(null);

      const acquire = sinon.spy(operationRegistry, 'acquire');

      await appOperations.redeployComponentAPI(req, res);

      // force is what separates a rebuild from a redeploy, and the lease is
      // where that word first has an effect.
      sinon.assert.calledWith(acquire, 'myapp', 'rebuild');
    });

    // The caller holds the connection open and reads progress off it, so the
    // stream declares what it carries and something always closes it.
    it('streams the redeploy and closes the response', async () => {
      req.params.appname = 'myapp';
      req.params.component = 'frontend';

      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.5:16137');
      sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({}) });
      sinon.stub(dbHelper, 'findOneInDatabase').resolves(null);

      await appOperations.redeployComponentAPI(req, res);

      expect(res.setHeader.calledWith('Content-Type', 'application/json')).to.be.true;
      expect(res.end.calledOnce, 'the redeploy writes progress, the endpoint closes').to.be.true;
    });

    // Every chunk on the stream is an envelope, so a reader that splits the
    // stream on `}{` reads how the redeploy ended off the last one.
    it('streams every progress line as a success envelope, and the last one says it finished', async () => {
      req.params.appname = 'myapp';
      req.params.component = 'frontend';
      const deployment = await oneComponentDeployment('myapp', 'frontend', { image: 'myrepo/app:v1' });
      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(deployment);
      sinon.stub(componentProvisioner, 'verifyComponentImage').resolves();
      sinon.stub(serviceHelper, 'delay').resolves();
      stubHostedInstances().byName.resolves(installedRecord(await registeredSpec(await v9Spec())));
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(await oneComponentDeployment('myapp', 'frontend', { image: 'myrepo/app:v1' }));
      sinon.stub(hwRequirements, 'checkNodeResourcesReclaiming').resolves();
      sinon.stub(appUninstaller, 'uninstallComponent').resolves();
      sinon.stub(componentProvisioner, 'installComponent').resolves();
      sinon.stub(appReconciler, 'enqueueApp');

      await appOperations.redeployComponentAPI(req, res);

      expect(res.write.called, 'the redeploy wrote progress').to.be.true;
      const chunks = res.write.args.map(([chunk]) => JSON.parse(chunk));
      expect(chunks.every((chunk) => typeof chunk.status === 'string'), 'every chunk is an envelope').to.be.true;
      expect(chunks[chunks.length - 1].status).to.equal('success');
      expect(chunks[chunks.length - 1].data.message).to.include('redeploy complete');
    });

    // A refusal is an answer, and it arrives before the stream starts, so it is
    // a body rather than a chunk. Returning without writing left the caller on
    // an open connection until server.requestTimeout.
    it('answers a refusal as a body, not as a chunk', async () => {
      req.params.appname = 'myapp';
      req.params.component = 'frontend';
      operationRegistry.acquire('myapp', 'install', 'test');

      await appOperations.redeployComponentAPI(req, res);

      expect(res.json.calledOnce, 'the refusal is answered').to.be.true;
      expect(res.json.firstCall.args[0].status).to.equal('warning');
      expect(res.write.called, 'nothing was streamed').to.be.false;
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

    // Development's c721c79f1 fixed this and the replay reverted the reporting
    // half of it: the failure reached the log and nothing else, so the stream
    // closed on the last progress line and a redeploy that did not happen
    // answered 200 and read as one that did.
    it('tells the caller when the redeploy fails, not only the log', async () => {
      deploymentProvider.getInstalledDeployments.resolves([]);
      sinon.stub(appReconciler, 'enqueueApp');
      const messages = [];

      await appOperations.redeployComponent('myapp', 'frontend', { onStatus: (msg) => messages.push(msg) });

      const failure = messages.find((msg) => msg && msg.status === 'error');
      expect(failure, 'the failure reached the caller').to.not.equal(undefined);
      expect(failure.data.message).to.include('myapp');
      expect(failure.data.message).to.include('No forced uninstall');
    });

    it('holds a redeploy lease during the redeploy and releases it', async () => {
      let leaseTypeDuring = null;
      // The lease is acquired before the first await; observe it as getInstalledDeployment
      // runs, then return null so the catch path releases it (and hands off to the reconciler).
      sinon.stub(deploymentProvider, 'getInstalledDeployment').callsFake(async () => {
        leaseTypeDuring = operationRegistry.get('myapp')?.type ?? null;
        return null;
      });
      sinon.stub(appReconciler, 'enqueueApp');

      await appOperations.redeployComponent('myapp', 'frontend', { onStatus: () => {} });

      expect(leaseTypeDuring, 'a redeploy lease must be held while the redeploy runs').to.equal('redeploy');
      expect(operationRegistry.isHeld('myapp'), 'the redeploy lease must release when the operation settles').to.be.false;
    });

    it('hands recovery to the reconciler (no destroy) when application not found', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(null);
      const uninstall = sinon.stub(appUninstaller, 'uninstallApplication').resolves();
      const enqueue = sinon.stub(appReconciler, 'enqueueApp');

      await appOperations.redeployComponent('myapp', 'frontend', { onStatus: () => {} });

      expect(operationRegistry.isHeld('myapp'), 'the redeploy lease must release on error').to.be.false;
      expect(uninstall.called, 'a redeploy failure must NOT destroy the app').to.be.false;
      expect(enqueue.calledOnceWith('myapp')).to.be.true;
    });

    it('hands recovery to the reconciler (no destroy) when component not found in app', async () => {
      // A real deployment of an intact app that simply has no 'frontend' component:
      // getComponent answers for what the spec declares and nothing else.
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(await oneComponentDeployment('myapp', 'web'));
      const uninstall = sinon.stub(appUninstaller, 'uninstallApplication').resolves();
      const enqueue = sinon.stub(appReconciler, 'enqueueApp');

      await appOperations.redeployComponent('myapp', 'frontend', { onStatus: () => {} });

      expect(operationRegistry.isHeld('myapp'), 'the redeploy lease must release on error').to.be.false;
      expect(uninstall.called, 'must not destroy an intact app over a bad component name').to.be.false;
      expect(enqueue.calledOnceWith('myapp')).to.be.true;
    });

    // Prong A: a broken new image is rejected by the pre-flight BEFORE the old version
    // is torn down, so the running app is never disturbed by a bad redeploy.
    it('aborts without tearing down the old version when the new image fails pre-flight verify', async () => {
      const deployment = await oneComponentDeployment('myapp', 'frontend', { image: 'myrepo/app:deleted-tag' });
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(deployment);
      const verifyImage = sinon.stub(componentProvisioner, 'verifyComponentImage').rejects(new Error('image not found in registry'));
      const uninstallComponent = sinon.stub(appUninstaller, 'uninstallComponent').resolves();
      const uninstallApplication = sinon.stub(appUninstaller, 'uninstallApplication').resolves();
      const enqueue = sinon.stub(appReconciler, 'enqueueApp');

      await appOperations.redeployComponent('myapp', 'frontend', { onStatus: () => {} });

      // The image validator stays stubbed, so nothing else proves the object it was
      // handed can answer what the real one reads off it.
      const [handedComp] = verifyImage.firstCall.args;
      expect(handedComp.image, 'verifyComponentImage pulls component.image').to.equal('myrepo/app:deleted-tag');
      expect(handedComp.appName, 'and component.appName, for the registry credential lookup').to.equal('myapp');
      // '' on the real class, not null — falsy either way, so the credential lookup is skipped
      expect(handedComp.imageAuth, 'and component.imageAuth, which gates the credential lookup').to.equal('');

      expect(uninstallComponent.called, 'must NOT tear down the old version when the new image fails pre-flight').to.be.false;
      expect(uninstallApplication.called, 'and must NOT destroy the app').to.be.false;
      expect(enqueue.calledOnceWith('myapp')).to.be.true;
      expect(operationRegistry.isHeld('myapp')).to.be.false;
    });

    // The content pre-flight sits beside the image one: the create step writes
    // the component's content, so a file that cannot be had refuses the redeploy
    // with the old version running.
    it('brings the component\'s content into the store before tearing anything down', async () => {
      const deployment = await oneComponentDeployment('myapp', 'frontend', { image: 'myrepo/app:v1' });
      const deployComp = deployment.getComponent('frontend');
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(deployment);
      sinon.stub(componentProvisioner, 'verifyComponentImage').resolves();
      const stage = sinon.stub(contentSlotService, 'stageComponentContent').resolves(1);
      sinon.stub(serviceHelper, 'delay').resolves();
      stubHostedInstances().byName.resolves(installedRecord(await registeredSpec(await v9Spec())));
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(await oneComponentDeployment('myapp', 'frontend', { image: 'myrepo/app:v1' }));
      sinon.stub(hwRequirements, 'checkNodeResourcesReclaiming').resolves();
      const uninstallComponent = sinon.stub(appUninstaller, 'uninstallComponent').resolves();
      sinon.stub(componentProvisioner, 'installComponent').resolves();
      sinon.stub(appReconciler, 'enqueueApp');

      await appOperations.redeployComponent('myapp', 'frontend', { onStatus: () => {} });

      sinon.assert.calledOnceWithExactly(stage, deployComp, { appName: 'myapp' });
      sinon.assert.calledOnce(uninstallComponent);
      expect(stage.calledBefore(uninstallComponent), 'staged before the teardown').to.be.true;
    });

    it('tears nothing down when a file cannot be had, and tells the caller', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(await oneComponentDeployment('myapp', 'frontend', { image: 'myrepo/app:v1' }));
      sinon.stub(componentProvisioner, 'verifyComponentImage').resolves();
      sinon.stub(contentSlotService, 'stageComponentContent').rejects(new Error('contentBlob: no source for sha256:x'));
      const uninstallComponent = sinon.stub(appUninstaller, 'uninstallComponent').resolves();
      const installComponent = sinon.stub(componentProvisioner, 'installComponent').resolves();
      const enqueue = sinon.stub(appReconciler, 'enqueueApp');
      const messages = [];

      await appOperations.redeployComponent('myapp', 'frontend', { onStatus: (msg) => messages.push(msg) });

      sinon.assert.notCalled(uninstallComponent);
      sinon.assert.notCalled(installComponent);
      const failure = messages.find((msg) => msg && msg.status === 'error');
      expect(failure?.data?.message).to.include('no source');
      expect(enqueue.calledOnceWith('myapp')).to.be.true;
      expect(operationRegistry.isHeld('myapp')).to.be.false;
    });

    // A same-spec redeploy reinstalls the identical component, so its port set never
    // changes. Both the teardown and the reinstall must leave the app's ufw/UPnP rules
    // in place (skipPorts) — no firewall flap, no UPnP re-map churn.
    it('leaves ufw/UPnP untouched: teardown and reinstall both run with skipPorts', async () => {
      // A real component with no shutdown/preStop/drain: requiresDaemonShutdown()
      // is false and shutdownBudgetSeconds() is docker's own 10s window.
      const deployment = await oneComponentDeployment('myapp', 'frontend', { image: 'myrepo/app:v1' });
      const deployComp = deployment.getComponent('frontend');
      expect(deployComp.requiresDaemonShutdown()).to.be.false;
      expect(deployComp.shutdownBudgetSeconds()).to.equal(10);
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(deployment);
      sinon.stub(componentProvisioner, 'verifyComponentImage').resolves();
      sinon.stub(serviceHelper, 'delay').resolves();
      stubHostedInstances().byName.resolves(installedRecord(await registeredSpec(await v9Spec())));
      const freshDeployment = await oneComponentDeployment('myapp', 'frontend', { image: 'myrepo/app:v1' });
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(freshDeployment);
      sinon.stub(hwRequirements, 'checkNodeResources').resolves();
      // The redeploy/update path uses the reclaiming variant: these run AFTER
      // the containers are gone, so a shortfall leaves a paid app destroyed and
      // free session capacity must never be what causes one.
      const reclaiming = sinon.stub(hwRequirements, 'checkNodeResourcesReclaiming').resolves();
      const uninstallComponent = sinon.stub(appUninstaller, 'uninstallComponent').resolves();
      const installComponent = sinon.stub(componentProvisioner, 'installComponent').resolves();
      sinon.stub(appReconciler, 'enqueueApp');

      await appOperations.redeployComponent('myapp', 'frontend', { onStatus: () => {} });

      expect(uninstallComponent.calledOnceWith(deployComp, sinon.match({ skipPorts: true })), 'teardown must skip ports').to.be.true;
      expect(installComponent.calledOnceWith(deployComp, sinon.match({ skipPorts: true })), 'reinstall must skip ports').to.be.true;

      // Both gates stay stubbed, so assert the objects they were handed can answer
      // what the real ones ask: the resource gate sums the deployment's totals, and
      // the provisioner asks the component whether it takes a managed cert.
      assertAnswers(reclaiming.firstCall.args[0], ['resourceTotals']);
      assertAnswers(installComponent.firstCall.args[0], ['requiresBackendTls', 'toDockerEnv', 'toDockerPortBindings']);
    });

    it('routes a graceful component redeploy through flux-shutdownd, component-scoped', async () => {
      // A declared graceful contract on the real class: shutdown.gracefulTimeout is
      // what makes requiresDaemonShutdown() true and sets the budget.
      const deployment = await oneComponentDeployment('myapp', 'frontend', {
        image: 'myrepo/app:v1',
        shutdown: { gracefulTimeout: 290 },
      }, { identity: IDENTITY });
      const deployComp = deployment.getComponent('frontend');
      expect(deployComp.requiresDaemonShutdown(), 'a declared shutdown IS the graceful contract').to.be.true;
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(deployment);
      sinon.stub(componentProvisioner, 'verifyComponentImage').resolves();
      sinon.stub(serviceHelper, 'delay').resolves();
      stubHostedInstances().byName.resolves(installedRecord(await registeredSpec(await v9Spec())));
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(
        await oneComponentDeployment('myapp', 'frontend', { image: 'myrepo/app:v1', shutdown: { gracefulTimeout: 290 } }),
      );
      sinon.stub(hwRequirements, 'checkNodeResources').resolves();
      sinon.stub(hwRequirements, 'checkNodeResourcesReclaiming').resolves();
      const beginAppStop = sinon.stub(fluxShutdowndClient, 'beginAppStop').resolves({ outcome: 'complete' });
      const uninstallComponent = sinon.stub(appUninstaller, 'uninstallComponent').resolves();
      sinon.stub(componentProvisioner, 'installComponent').resolves();
      sinon.stub(appReconciler, 'enqueueApp');

      await appOperations.redeployComponent('myapp', 'frontend', { onStatus: () => {} });

      expect(beginAppStop.calledOnce, 'the daemon owns the graceful stop').to.be.true;
      const [identity, name, , opts] = beginAppStop.firstCall.args;
      expect(identity, 'the daemon is asked by the identity the component\'s container carries').to.equal(IDENTITY);
      expect(name).to.equal('myapp');
      expect(opts.component).to.equal('frontend');
      expect(uninstallComponent.calledWith(deployComp, sinon.match({ stopHandled: true })), 'the teardown must not stop again').to.be.true;
    });

    it('asks the daemon by the app\'s name for a component of an app with no identity minted', async () => {
      const deployment = await oneComponentDeployment('myapp', 'frontend', {
        image: 'myrepo/app:v1',
        shutdown: { gracefulTimeout: 290 },
      });
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(deployment);
      sinon.stub(componentProvisioner, 'verifyComponentImage').resolves();
      sinon.stub(serviceHelper, 'delay').resolves();
      stubHostedInstances().byName.resolves(installedRecord(await registeredSpec(await v9Spec())));
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(deployment);
      sinon.stub(hwRequirements, 'checkNodeResourcesReclaiming').resolves();
      const beginAppStop = sinon.stub(fluxShutdowndClient, 'beginAppStop').resolves({ outcome: 'complete' });
      sinon.stub(appUninstaller, 'uninstallComponent').resolves();
      sinon.stub(componentProvisioner, 'installComponent').resolves();
      sinon.stub(appReconciler, 'enqueueApp');

      await appOperations.redeployComponent('myapp', 'frontend', { onStatus: () => {} });

      sinon.assert.calledOnce(beginAppStop);
      expect(beginAppStop.firstCall.args[0], 'its containers carry the name where an identity goes').to.equal('myapp');
    });
  });

  describe('redeployApplication pre-teardown dependency check', () => {

    beforeEach(() => {
      operationRegistry.clear();
    });

    // Same contract as the image pre-flight: a redeploy that cannot complete must be
    // rejected BEFORE the old version is torn down, never after.
    it('aborts without tearing down the old version when a dependency is missing', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(
        await oneComponentDeployment('myapp', 'frontend', { image: 'myrepo/app:v1' }),
      );
      sinon.stub(componentProvisioner, 'verifyComponentImage').resolves();
      sinon.stub(serviceHelper, 'delay').resolves();
      stubHostedInstances().byName.resolves(installedRecord(await registeredSpec(await v9Spec())));
      const checkDeps = sinon.stub(relationshipResolver, 'checkAppDependencyRequirements').rejects(
        Object.assign(new Error("App 'collector' that 'myapp' depends on is not installed on this node. Installation aborted."), { code: 'NETWORK_DEPENDENCY_NOT_READY' }),
      );
      const uninstallComponent = sinon.stub(appUninstaller, 'uninstallComponent').resolves();
      const uninstallApplication = sinon.stub(appUninstaller, 'uninstallApplication').resolves();
      const enqueue = sinon.stub(appReconciler, 'enqueueApp');

      await appOperations.redeployApplication('myapp', { onStatus: () => {} });

      // The dependency gate stays stubbed. The real one resolves the registered
      // spec to its readable view and reads the edges off that, so both steps have
      // to work on the object it was actually handed.
      const [handedSpec] = checkDeps.firstCall.args;
      assertAnswers(await resolveRegisteredSpec(handedSpec), ['dependencyEntries']);

      expect(uninstallComponent.called, 'must NOT tear down the old version when a dependency is missing').to.be.false;
      expect(uninstallApplication.called, 'and must NOT destroy the app').to.be.false;
      expect(enqueue.calledOnceWith('myapp')).to.be.true;
      expect(operationRegistry.isHeld('myapp')).to.be.false;
    });

    describe('a node the spec does not name', () => {
      let uninstallComponent;
      let uninstallApplication;
      beforeEach(async () => {
        sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(await oneComponentDeployment('myapp', 'web'));
        sinon.stub(componentProvisioner, 'verifyComponentImage').resolves();
        sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('10.0.0.1:16127');
        sinon.stub(fluxNetworkHelper, 'getFluxNodePublicKey').resolves('operatorkey');
        uninstallComponent = sinon.stub(appUninstaller, 'uninstallComponent').resolves();
        uninstallApplication = sinon.stub(appUninstaller, 'uninstallApplication').resolves();
      });

      it('hands the app back instead of tearing it down to rebuild', async () => {
        sinon.stub(nodeConfirmationService, 'ownCollateral').resolves({ txhash: 'b'.repeat(64), txindex: 0 });
        stubHostedInstances().byName.resolves(installedRecord(
          await registeredSpec(await v9Spec({ placement: { targetIps: ['9.9.9.9'] } })),
        ));

        await appOperations.redeployApplication('myapp', { onStatus: () => {} });

        expect(uninstallApplication.calledOnceWith('myapp', sinon.match({ broadcastRemoval: true }))).to.be.true;
        expect(uninstallComponent.called, 'nothing is torn down to be rebuilt').to.be.false;
        expect(operationRegistry.isHeld('myapp')).to.be.false;
      });

      it('leaves the app as it is when it cannot read the collateral the spec names nodes by', async () => {
        sinon.stub(nodeConfirmationService, 'ownCollateral').rejects(new Error('daemon down'));
        stubHostedInstances().byName.resolves(installedRecord(
          await registeredSpec(await v9Spec({ placement: { targetIps: ['9.9.9.9'], targetOutpoints: [`${'c'.repeat(64)}:0`] } })),
        ));

        await appOperations.redeployApplication('myapp', { onStatus: () => {} });

        expect(uninstallApplication.called).to.be.false;
        expect(uninstallComponent.called).to.be.false;
      });
    });

    it('routes the identity stop through flux-shutdownd before teardown (reason: redeploy)', async () => {
      const deployment = await oneComponentDeployment('myapp', 'frontend', { image: 'myrepo/app:v1' }, { identity: IDENTITY });
      const deployComp = deployment.getComponent('frontend');
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(deployment);
      sinon.stub(componentProvisioner, 'verifyComponentImage').resolves();
      sinon.stub(serviceHelper, 'delay').resolves();
      const installed = await registeredSpec(await v9Spec(), { identity: IDENTITY });
      const getInstalledApp = stubHostedInstances().byName;
      getInstalledApp.onFirstCall().resolves(installedRecord(installed));
      getInstalledApp.onSecondCall().resolves(null);
      sinon.stub(relationshipResolver, 'checkAppDependencyRequirements').resolves(true);
      const beginAppStop = sinon.stub(fluxShutdowndClient, 'beginAppStop').resolves({ outcome: 'complete' });
      const budgetSeconds = sinon.stub(shutdownPlan, 'appShutdownBudgetSeconds').returns(30);
      const uninstallComponent = sinon.stub(appUninstaller, 'uninstallComponent').resolves();
      sinon.stub(appReconciler, 'enqueueApp');

      await appOperations.redeployApplication('myapp', { onStatus: () => {} });

      expect(beginAppStop.calledOnce, 'the daemon owns the stop').to.be.true;
      const [identity, name, reason, opts] = beginAppStop.firstCall.args;
      expect(identity, 'the daemon is asked by the identity the app\'s containers carry').to.equal(IDENTITY);
      expect(name).to.equal('myapp');
      expect(reason).to.equal(fluxShutdowndClient.SHUTDOWN_REASON.REDEPLOY);
      expect(opts.replica).to.equal(null);
      expect(uninstallComponent.calledWith(deployComp, sinon.match({ stopHandled: true })), 'the component teardown must not stop again').to.be.true;
      // The budget calculator stays stubbed; the real one walks the deployment's
      // components, so the view it was handed has to be able to hand them back.
      assertAnswers(budgetSeconds.firstCall.args[0], ['componentEntries']);
    });

    it('brings every content file the app declares into the store before tearing anything down', async () => {
      const deployment = await oneComponentDeployment('myapp', 'frontend', { image: 'myrepo/app:v1' });
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(deployment);
      sinon.stub(componentProvisioner, 'verifyComponentImage').resolves();
      const stage = sinon.stub(contentSlotService, 'stageContent').resolves(2);
      sinon.stub(serviceHelper, 'delay').resolves();
      const getInstalledApp = stubHostedInstances().byName;
      getInstalledApp.onFirstCall().resolves(installedRecord(await registeredSpec(await v9Spec())));
      getInstalledApp.onSecondCall().resolves(null);
      sinon.stub(relationshipResolver, 'checkAppDependencyRequirements').resolves(true);
      const uninstallComponent = sinon.stub(appUninstaller, 'uninstallComponent').resolves();
      sinon.stub(appReconciler, 'enqueueApp');

      await appOperations.redeployApplication('myapp', { onStatus: () => {} });

      sinon.assert.calledOnceWithExactly(stage, deployment, { appName: 'myapp' });
      sinon.assert.calledOnce(uninstallComponent);
      expect(stage.calledBefore(uninstallComponent), 'staged before the teardown').to.be.true;
    });

    it('tears nothing down when a content file cannot be had, and tells the caller', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(await oneComponentDeployment('myapp', 'frontend', { image: 'myrepo/app:v1' }));
      sinon.stub(componentProvisioner, 'verifyComponentImage').resolves();
      sinon.stub(contentSlotService, 'stageContent').rejects(new Error('contentBlob: no source for sha256:x'));
      const uninstallComponent = sinon.stub(appUninstaller, 'uninstallComponent').resolves();
      const uninstallApplication = sinon.stub(appUninstaller, 'uninstallApplication').resolves();
      const enqueue = sinon.stub(appReconciler, 'enqueueApp');
      const messages = [];

      await appOperations.redeployApplication('myapp', { onStatus: (msg) => messages.push(msg) });

      sinon.assert.notCalled(uninstallComponent);
      sinon.assert.notCalled(uninstallApplication);
      expect(messages.find((msg) => msg && msg.status === 'error')?.data?.message).to.include('no source');
      expect(enqueue.calledOnceWith('myapp')).to.be.true;
      expect(operationRegistry.isHeld('myapp')).to.be.false;
    });

    it('proceeds to teardown when every dependency is satisfied', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(
        await oneComponentDeployment('myapp', 'frontend', { image: 'myrepo/app:v1' }),
      );
      sinon.stub(componentProvisioner, 'verifyComponentImage').resolves();
      sinon.stub(serviceHelper, 'delay').resolves();
      // First read feeds the pre-teardown check; the post-teardown read returns null so
      // the run settles through the catch without exercising the full reinstall path.
      const getInstalledApp = stubHostedInstances().byName;
      getInstalledApp.onFirstCall().resolves(installedRecord(await registeredSpec(await v9Spec())));
      getInstalledApp.onSecondCall().resolves(null);
      sinon.stub(relationshipResolver, 'checkAppDependencyRequirements').resolves(true);
      const uninstallComponent = sinon.stub(appUninstaller, 'uninstallComponent').resolves();
      sinon.stub(appReconciler, 'enqueueApp');

      await appOperations.redeployApplication('myapp', { onStatus: () => {} });

      expect(uninstallComponent.called, 'a satisfied dependency check must not block the redeploy').to.be.true;
      expect(operationRegistry.isHeld('myapp')).to.be.false;
    });

    it('reads the app back for reinstall as soon as its teardown returns', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(
        await oneComponentDeployment('myapp', 'frontend', { image: 'myrepo/app:v1' }),
      );
      sinon.stub(componentProvisioner, 'verifyComponentImage').resolves();
      const delay = sinon.stub(serviceHelper, 'delay').resolves();
      const getInstalledApp = stubHostedInstances().byName;
      getInstalledApp.onFirstCall().resolves(installedRecord(await registeredSpec(await v9Spec())));
      getInstalledApp.onSecondCall().resolves(null);
      sinon.stub(relationshipResolver, 'checkAppDependencyRequirements').resolves(true);
      sinon.stub(appUninstaller, 'uninstallComponent').resolves();
      sinon.stub(appReconciler, 'enqueueApp');

      await appOperations.redeployApplication('myapp', { onStatus: () => {} });

      expect(getInstalledApp.calledTwice, 'the reinstall reads the app back after the teardown').to.be.true;
      // The only wait is the one between a component's teardown and the next.
      expect(delay.args).to.deep.equal([[config.get('fluxapps.redeploy.composedDelay') * 1000]]);
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

    it('holds a rebuild lease during the rebuild and releases it', async () => {
      let leaseTypeDuring = null;
      sinon.stub(deploymentProvider, 'getInstalledDeployment').callsFake(async () => {
        leaseTypeDuring = operationRegistry.get('myapp')?.type ?? null;
        return null;
      });
      sinon.stub(appReconciler, 'enqueueApp');

      await appOperations.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: () => {} });

      expect(leaseTypeDuring, 'a rebuild lease must be held while the rebuild runs').to.equal('rebuild');
      expect(operationRegistry.isHeld('myapp'), 'the rebuild lease must release when the operation settles').to.be.false;
    });


    it('hands recovery to the reconciler (no destroy) when application not found', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(null);
      const uninstall = sinon.stub(appUninstaller, 'uninstallApplication').resolves();
      const enqueue = sinon.stub(appReconciler, 'enqueueApp');

      await appOperations.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: () => {} });

      expect(operationRegistry.isHeld('myapp'), 'the rebuild lease must release on error').to.be.false;
      expect(uninstall.called).to.be.false;
      expect(enqueue.calledOnceWith('myapp')).to.be.true;
    });

    it('hands recovery to the reconciler (no destroy) when component not found in app', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(await oneComponentDeployment('myapp', 'web'));
      const uninstall = sinon.stub(appUninstaller, 'uninstallApplication').resolves();
      const enqueue = sinon.stub(appReconciler, 'enqueueApp');

      await appOperations.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: () => {} });

      expect(operationRegistry.isHeld('myapp'), 'the rebuild lease must release on error').to.be.false;
      expect(uninstall.called).to.be.false;
      expect(enqueue.calledOnceWith('myapp')).to.be.true;
    });

    it('should release the rebuild lease on error', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(null);
      sinon.stub(appReconciler, 'enqueueApp');

      await appOperations.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: () => {} });

      expect(operationRegistry.isHeld('myapp'), 'the rebuild lease must release on error').to.be.false;
    });

    it('brings the component\'s content into the store before its volume is destroyed', async () => {
      const deployment = await oneComponentDeployment('myapp', 'frontend', { image: 'myrepo/app:v1' });
      const deployComp = deployment.getComponent('frontend');
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(deployment);
      sinon.stub(componentProvisioner, 'verifyComponentImage').resolves();
      const stage = sinon.stub(contentSlotService, 'stageComponentContent').resolves(1);
      sinon.stub(serviceHelper, 'delay').resolves();
      stubHostedInstances().byName.resolves(installedRecord(await registeredSpec(await v9Spec())));
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(await oneComponentDeployment('myapp', 'frontend', { image: 'myrepo/app:v1' }));
      sinon.stub(hwRequirements, 'checkNodeResourcesReclaiming').resolves();
      const uninstallComponent = sinon.stub(appUninstaller, 'uninstallComponent').resolves();
      const installComponent = sinon.stub(componentProvisioner, 'installComponent').resolves();
      sinon.stub(appReconciler, 'enqueueApp');

      await appOperations.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: () => {} });

      sinon.assert.calledOnceWithExactly(stage, deployComp, { appName: 'myapp' });
      expect(uninstallComponent.calledOnceWith(deployComp, sinon.match({ removeVolumes: true }))).to.be.true;
      expect(stage.calledBefore(uninstallComponent), 'staged before the volume goes').to.be.true;
      expect(installComponent.calledOnceWith(deployComp, sinon.match({ createVolumes: true }))).to.be.true;
    });

    it('destroys no volume when a file cannot be had', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(await oneComponentDeployment('myapp', 'frontend', { image: 'myrepo/app:v1' }));
      sinon.stub(componentProvisioner, 'verifyComponentImage').resolves();
      sinon.stub(contentSlotService, 'stageComponentContent').rejects(new Error('contentBlob: no source for sha256:x'));
      const uninstallComponent = sinon.stub(appUninstaller, 'uninstallComponent').resolves();
      sinon.stub(appReconciler, 'enqueueApp');
      const messages = [];

      await appOperations.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: (msg) => messages.push(msg) });

      sinon.assert.notCalled(uninstallComponent);
      expect(messages.find((msg) => msg && msg.status === 'error')?.data?.message).to.include('no source');
      expect(operationRegistry.isHeld('myapp')).to.be.false;
    });
  });

  describe('the redeploy announces itself', () => {
    beforeEach(() => {
      operationRegistry.clear();
    });

    /**
     * A redeploy that runs all the way to reinstall. Nothing observing the node
     * could otherwise tell one from its never having been asked for - the app's
     * own state is the same either way, which is how this endpoint failing on
     * every call went unnoticed.
     */
    async function runRedeploy({ createVolumes }) {
      const deployment = await oneComponentDeployment('myapp', 'frontend', { image: 'myrepo/app:v1' });
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(deployment);
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(deployment);
      sinon.stub(componentProvisioner, 'verifyComponentImage').resolves();
      sinon.stub(componentProvisioner2, 'installComponent').resolves();
      sinon.stub(hwRequirements, 'checkNodeResourcesReclaiming').resolves();
      sinon.stub(serviceHelper, 'delay').resolves();
      stubHostedInstances().byName.resolves(installedRecord(await registeredSpec(await v9Spec())));
      sinon.stub(appUninstaller, 'uninstallComponent').resolves();
      sinon.stub(appReconciler, 'enqueueApp');
      const publish = sinon.stub(fluxEventBus, 'publish');

      await appOperations.redeployComponent('myapp', 'frontend', { createVolumes, onStatus: () => {} });

      return {
        deployment,
        redeployed: publish.getCalls()
          .filter((c) => c.args[0] === 'app:componentRedeployed')
          .map((c) => c.args[1]),
      };
    }

    it('says which component was replaced, and that the data survived', async () => {
      const { deployment, redeployed } = await runRedeploy({ createVolumes: false });

      expect(redeployed).to.deep.equal([{
        name: 'myapp',
        component: 'frontend',
        identifier: deployment.getComponent('frontend').identifier,
        hard: false,
      }]);
    });

    // `hard` is the consequence that differs: a rebuild recreated the volume, so
    // the component's data on this node is gone. An observer that cannot tell
    // the two apart cannot tell a redeploy from a data loss.
    it('marks a rebuild hard, because its volume was recreated', async () => {
      const { redeployed } = await runRedeploy({ createVolumes: true });

      expect(redeployed).to.have.lengthOf(1);
      expect(redeployed[0].hard).to.equal(true);
    });

    it('says nothing when the redeploy never got past its checks', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(null);
      sinon.stub(appReconciler, 'enqueueApp');
      const publish = sinon.stub(fluxEventBus, 'publish');

      await appOperations.redeployComponent('myapp', 'frontend', { onStatus: () => {} });

      expect(publish.getCalls().filter((c) => c.args[0] === 'app:componentRedeployed')).to.have.lengthOf(0);
    });
  });

  // The active-standby component of an installed app registered before v9, as
  // the deployment view built over its resources names it: its directory by its
  // identifier, its syncthing folder by the 8.x container name.
  const STANDBY_IDENTIFIER = `web_${IDENTITY}`;
  const STANDBY_FOLDER_ID = 'fluxweb_primaryapp';
  async function standbyComponent() {
    const spec = await specWithComponents('primaryapp', {
      web: { persistentStorage: { sizeGb: 5, mounts: { '/data': { source: 'data', destination: '/data' } }, sync: { mode: 'activeStandby' } } },
    });
    const comp = deploymentFor(spec, { identity: IDENTITY, names: { web: { syncFolderId: STANDBY_FOLDER_ID, aliases: [] } } }).getComponent('web');
    expect([comp.identifier, comp.syncFolderId], 'the fixture names the directory and the folder apart').to.deep.equal([STANDBY_IDENTIFIER, STANDBY_FOLDER_ID]);
    return comp;
  }

  describe('promoteApplicationToPrimary announces the decision', () => {
    it('publishes the decision and counts it, once this node is committing to it', async () => {
      sinon.stub(appReconciler, 'getControllerDesired').returns(null);
      // Fails the permissions fix straight after, so the workflow stops there:
      // the event is about the DECISION, which is already made by then.
      sinon.stub(serviceHelper, 'runCommand').resolves({ error: new Error('nope') });
      const publish = sinon.stub(fluxEventBus, 'publish');
      const count = sinon.stub(fluxEventBus, 'count');

      await appOperations.promoteApplicationToPrimary(await standbyComponent());

      expect(publish.getCalls().filter((c) => c.args[0] === 'masterSlave:started').map((c) => c.args[1]))
        .to.deep.equal([{ identifier: STANDBY_IDENTIFIER }]);
      // The cadence around the decision is a TALLY, not a stream.
      sinon.assert.calledWithExactly(count, 'masterSlave:decision', STANDBY_IDENTIFIER, 'started');
    });

    // Development publishes at the top of the function; this tree has an
    // idempotence backstop above it, and announcing ahead of that would claim a
    // promotion that then returns having done nothing.
    it('says nothing when the promotion is already in effect', async () => {
      sinon.stub(appReconciler, 'getControllerDesired').returns('running');
      const publish = sinon.stub(fluxEventBus, 'publish');
      const count = sinon.stub(fluxEventBus, 'count');

      await appOperations.promoteApplicationToPrimary(await standbyComponent());

      expect(publish.getCalls().filter((c) => c.args[0] === 'masterSlave:started')).to.have.lengthOf(0);
      expect(count.called).to.equal(false);
    });
  });

  // The component's directory and its syncthing folder are two names: for an
  // app registered before v9 the folder's id is the 8.x container name.
  describe('promoteApplicationToPrimary cycles the component\'s syncthing folder', () => {
    const DIRECTORY = STANDBY_IDENTIFIER;
    const FOLDER_ID = STANDBY_FOLDER_ID;
    let adjust;
    let desired;

    // Syncthing's folders, the type of each as the last change left it.
    function syncthingHolds(folders) {
      const held = folders.map((folder) => ({ ...folder }));
      sinon.stub(syncthingService, 'getConfigFolders').callsFake(async () => held.map((folder) => ({ ...folder })));
      adjust = sinon.stub(syncthingService, 'adjustConfigFolders').callsFake(async ({ id, config }) => {
        Object.assign(held.find((folder) => folder.id === id), config);
      });
    }

    beforeEach(() => {
      sinon.stub(appReconciler, 'getControllerDesired').returns(null);
      desired = sinon.stub(appReconciler, 'setControllerDesired');
      sinon.stub(fluxEventBus, 'publish');
      sinon.stub(fluxEventBus, 'count');
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(null);
      sinon.stub(serviceHelper, 'runCommand').resolves({ error: null });
    });

    it('takes the folder to receiveonly and back to sendreceive by its id, fixes the directory between, and hands the start to the reconciler', async () => {
      syncthingHolds([
        { id: FOLDER_ID, path: `${appsFolder}${DIRECTORY}`, type: 'sendreceive' },
        // Another folder whose directory is named as the first one's id is.
        { id: 'other', path: `${appsFolder}${FOLDER_ID}`, type: 'sendreceive' },
      ]);

      await appOperations.promoteApplicationToPrimary(await standbyComponent());

      expect(adjust.getCalls().map((call) => call.args[0])).to.deep.equal([
        { method: 'patch', config: { type: 'receiveonly' }, id: FOLDER_ID },
        { method: 'patch', config: { type: 'sendreceive' }, id: FOLDER_ID },
      ]);
      sinon.assert.calledWith(serviceHelper.runCommand, 'chmod', sinon.match({ params: ['-R', '777', `${appsFolder}${DIRECTORY}`] }));
      expect(adjust.firstCall.calledBefore(serviceHelper.runCommand.firstCall), 'quiesced before the fix').to.equal(true);
      sinon.assert.calledOnceWithExactly(desired, STANDBY_IDENTIFIER, 'running', sinon.match.string);
    });

    it('leaves a folder already of the type asked for as it is', async () => {
      syncthingHolds([{ id: FOLDER_ID, path: `${appsFolder}${DIRECTORY}`, type: 'receiveonly' }]);

      await appOperations.promoteApplicationToPrimary(await standbyComponent());

      expect(adjust.getCalls().map((call) => call.args[0])).to.deep.equal([
        { method: 'patch', config: { type: 'sendreceive' }, id: FOLDER_ID },
      ]);
    });

    it('does not become primary on a folder syncthing does not hold under that id, whatever its directories are called', async () => {
      syncthingHolds([{ id: 'other', path: `${appsFolder}${FOLDER_ID}`, type: 'receiveonly' }]);

      await appOperations.promoteApplicationToPrimary(await standbyComponent());

      sinon.assert.notCalled(adjust);
      sinon.assert.notCalled(desired);
    });
  });

  describe('ensureMountSourcesExist tests', () => {
    let serviceHelperStub;
    let logStub;
    let fsStub;

    beforeEach(() => {
      serviceHelperStub = {
        runCommand: sinon.stub().resolves({ error: null }),
      };

      logStub = {
        info: sinon.stub(),
        warn: sinon.stub(),
        error: sinon.stub(),
      };

      // Real components carry a real `dir`, so the trailing writeStignore would
      // touch the host filesystem. That is I/O and stays stubbed.
      fsStub = {
        rm: sinon.stub().resolves(),
        readFile: sinon.stub().resolves(null),
        writeFile: sinon.stub().resolves(),
      };
    });

    afterEach(() => {
      sinon.restore();
    });

    /**
     * A real DeploymentComponent whose mounts are the ones the spec declares.
     * `mounts` (Source + sourceType + perms) is derived by the spec library from
     * the persistentStorage block — the shape ensureMountSourcesExist consumes.
     * Content delivery is refused on a cleartext spec, so a mount that carries a
     * content slot needs `encrypted`.
     */
    async function buildDeployComp(mounts, { encrypted = false } = {}) {
      const persistentStorage = Object.keys(mounts).length
        ? { sizeGb: 5, mounts }
        : { sizeGb: 0, mounts: {} };
      const spec = await v9Spec({
        name: 'webapp',
        components: { test: { ...V9_SUBMISSION.components.web, name: 'test', persistentStorage } },
      }, { encrypted });
      return (await deploymentFor(spec)).getComponent('test');
    }

    const dirMount = (destination, source) => [destination, { source, destination, type: 'directory' }];
    const fileMount = (destination, source) => [destination, { source, destination, type: 'file' }];
    // A mount whose owner and mode the spec declares: injected content, as the library resolves it.
    const ownedFileMount = (destination, source, mode) => [destination, {
      source, destination, type: 'file', uid: 0, gid: 0, mode,
    }];
    // An atomic content slot: the library binds the slot's parent directory, under
    // the platform's namespace, root-owned 0555.
    const atomicSlot = (destination, source) => [destination, {
      source, destination, type: 'file', contentSlot: 'cfg', atomic: true,
    }];

    function loadModule() {
      return proxyquireStrict('../../ZelBack/src/services/appLifecycle/appVolumeService', {
        '../serviceHelper': serviceHelperStub,
        '../../lib/log': logStub,
        'node:fs/promises': fsStub,
      });
    }

    /** The calls made under one command, in order. */
    const callsFor = (cmd) => serviceHelperStub.runCommand.getCalls().filter((c) => c.args[0] === cmd);
    /** `cmd` reports its failure in the result, as runCommand does. */
    const failing = (cmd) => serviceHelperStub.runCommand.withArgs(cmd).resolves({ error: new Error(`${cmd} failed`) });
    /** `test` answers as if `source` were there as `kind`: a directory or a file. */
    function present(source, kind) {
      serviceHelperStub.runCommand.withArgs('test').callsFake(async (cmd, { params: [flag, path] }) => {
        const there = path === source && (flag === '-e' || (flag === '-d' && kind === 'directory') || (flag === '-f' && kind === 'file'));
        return { error: there ? null : new Error('test failed') };
      });
    }

    // A source that could not be made, or whose mode could not be set, leaves a
    // container that starts over a mount its user cannot use. The command's failure
    // is the caller's to hear, not a result to pass over.
    describe('a step that fails', () => {
      it('throws the make\'s failure when an owner directory is neither made nor there', async () => {
        failing('mkdir');
        failing('test');
        const mod = loadModule();
        const deployComp = await buildDeployComp(Object.fromEntries([dirMount('/var/log/app', 'logs')]));

        let thrown = null;
        await mod.ensureMountSourcesExist(deployComp).catch((e) => { thrown = e; });

        expect(thrown && thrown.message).to.include('mkdir failed');
      });

      it('throws the make\'s failure when an owner file is neither made nor there', async () => {
        failing('sh');
        failing('test');
        const mod = loadModule();
        const deployComp = await buildDeployComp(Object.fromEntries([fileMount('/etc/app/config.yaml', 'config.yaml')]));

        let thrown = null;
        await mod.ensureMountSourcesExist(deployComp).catch((e) => { thrown = e; });

        expect(thrown && thrown.message).to.include('sh failed');
      });

      it('throws when a source\'s mode cannot be set', async () => {
        failing('chmod');
        const mod = loadModule();
        const deployComp = await buildDeployComp(Object.fromEntries([dirMount('/var/log/app', 'logs')]));

        let thrown = null;
        await mod.ensureMountSourcesExist(deployComp).catch((e) => { thrown = e; });

        expect(thrown && thrown.message).to.include('chmod failed');
      });

      it('throws when a declared owner cannot be applied', async () => {
        failing('chown');
        const mod = loadModule();

        let thrown = null;
        await mod.applyMountPerms({ Source: '/vol/content', perms: { uid: 0, gid: 0, mode: '0644' } }).catch((e) => { thrown = e; });

        expect(thrown && thrown.message).to.include('chown failed');
        expect(serviceHelperStub.runCommand.calledWith('chmod'), 'a mode was set on a source whose owner is wrong').to.equal(false);
      });
    });

    // A spec update that adds a local directory on a replicated volume reaches it here,
    // and syncthing's watcher indexes what appears in a registered folder within
    // seconds. An ignore does not withdraw what already replicated, so the set that
    // covers the directory is written before the directory exists.
    it('writes the ignore set before it makes any source', async () => {
      const mod = loadModule();
      const deployment = await oneComponentDeployment('webapp', 'test', {
        persistentStorage: {
          sizeGb: 5,
          mounts: Object.fromEntries([dirMount('/data', 'data'), dirMount('/cache', 'cache')]),
          sync: { mode: 'syncFirst', exclude: ['cache'] },
        },
      });
      const deployComp = deployment.getComponent('test');
      expect(deployComp.sync, 'the premise: a replicated volume').to.be.ok;

      await mod.ensureMountSourcesExist(deployComp);

      const stignoreWrite = fsStub.writeFile.getCalls().find((c) => String(c.args[0]).endsWith('/.stignore'));
      const firstMkdir = serviceHelperStub.runCommand.getCalls().find((c) => c.args[0] === 'mkdir');
      expect(stignoreWrite, 'no ignore set was written').to.exist;
      expect(firstMkdir, 'no source was made').to.exist;
      expect(stignoreWrite.calledBefore(firstMkdir), 'a directory existed before the set that covers it').to.equal(true);
    });

    // An owner data source is opened to every container user when this pass made
    // it. One that is already there keeps the mode its application gave it: a
    // database refuses a data directory the world can read, and a key file the
    // world can read is refused by what holds it.
    describe('an owner data source', () => {
      it('makes a directory as one name under the volume root and opens it to every container user', async () => {
        const mod = loadModule();
        const deployComp = await buildDeployComp(Object.fromEntries([dirMount('/var/log/app', 'logs')]));
        const logs = `${deployComp.dir}/logs`;

        await mod.ensureMountSourcesExist(deployComp);

        const [mkdir] = callsFor('mkdir');
        expect(mkdir.args[1]).to.deep.include({ params: [logs], runAsRoot: true });
        const [chmod] = callsFor('chmod');
        expect(chmod.args[1]).to.deep.include({ params: ['777', logs], runAsRoot: true });
        expect(chmod.calledAfter(mkdir), 'opened before it was made').to.equal(true);
        expect(callsFor('test'), 'a source this pass made was asked about').to.have.lengthOf(0);
      });

      it('makes a file exclusively, the path an argument and never shell text, and opens it to every container user', async () => {
        const mod = loadModule();
        const deployComp = await buildDeployComp(Object.fromEntries([fileMount('/etc/app/config.yaml', 'config.yaml')]));
        const configYaml = `${deployComp.dir}/config.yaml`;

        await mod.ensureMountSourcesExist(deployComp);

        const [create] = callsFor('sh');
        expect(create, 'no exclusive create ran').to.exist;
        expect(create.args[1]).to.deep.include({ runAsRoot: true });
        const [dashC, script, ...positional] = create.args[1].params;
        expect(dashC).to.equal('-c');
        expect(script, 'the redirection does not refuse an existing file').to.include('set -C');
        expect(script, 'the path is shell text').to.not.include(configYaml);
        expect(positional).to.deep.equal(['sh', configYaml]);
        expect(callsFor('touch'), 'touch makes an existing file look made').to.have.lengthOf(0);
        const [chmod] = callsFor('chmod');
        expect(chmod.args[1]).to.deep.include({ params: ['777', configYaml], runAsRoot: true });
        expect(chmod.calledAfter(create), 'opened before it was made').to.equal(true);
      });

      it('leaves the mode of a directory that is already there', async () => {
        const mod = loadModule();
        const deployComp = await buildDeployComp(Object.fromEntries([dirMount('/var/log/app', 'logs')]));
        const logs = `${deployComp.dir}/logs`;
        failing('mkdir');
        present(logs, 'directory');

        await mod.ensureMountSourcesExist(deployComp);

        expect(callsFor('chmod'), 'an existing directory was widened').to.have.lengthOf(0);
        const [asked] = callsFor('test');
        expect(asked.args[1]).to.deep.include({ params: ['-d', logs], runAsRoot: true });
        expect(asked.calledAfter(callsFor('mkdir')[0]), 'asked before the make').to.equal(true);
      });

      it('leaves the mode of a file that is already there', async () => {
        const mod = loadModule();
        const deployComp = await buildDeployComp(Object.fromEntries([fileMount('/etc/app/config.yaml', 'config.yaml')]));
        const configYaml = `${deployComp.dir}/config.yaml`;
        failing('sh');
        present(configYaml, 'file');

        await mod.ensureMountSourcesExist(deployComp);

        expect(callsFor('chmod'), 'an existing file was widened').to.have.lengthOf(0);
        const [asked] = callsFor('test');
        expect(asked.args[1]).to.deep.include({ params: ['-f', configYaml], runAsRoot: true });
        expect(asked.calledAfter(callsFor('sh')[0]), 'asked before the make').to.equal(true);
      });

      it('reports the make\'s failure when a directory holds the name an owner file needs', async () => {
        const mod = loadModule();
        const deployComp = await buildDeployComp(Object.fromEntries([fileMount('/etc/app/config.yaml', 'config.yaml')]));
        failing('sh');
        present(`${deployComp.dir}/config.yaml`, 'directory');

        let thrown = null;
        await mod.ensureMountSourcesExist(deployComp).catch((e) => { thrown = e; });

        expect(thrown && thrown.message, 'a directory passed as the file').to.include('sh failed');
      });
    });

    // Platform content is never left world-writable: whatever a pass finds, it
    // holds the source at the owner and mode the spec declares.
    describe('injected content', () => {
      it('is held at its declared owner and mode on every pass', async () => {
        const mod = loadModule();
        const deployComp = await buildDeployComp(Object.fromEntries([ownedFileMount('/etc/app/owned.txt', 'owned.txt', '0640')]));
        const owned = `${deployComp.dir}/owned.txt`;

        await mod.ensureMountSourcesExist(deployComp);
        await mod.ensureMountSourcesExist(deployComp);

        expect(callsFor('touch').map((c) => c.args[1].params)).to.deep.equal([[owned], [owned]]);
        expect(callsFor('chown').map((c) => c.args[1].params)).to.deep.equal([['0:0', owned], ['0:0', owned]]);
        expect(callsFor('chmod').map((c) => c.args[1].params)).to.deep.equal([['0640', owned], ['0640', owned]]);
        expect(callsFor('test'), 'whether it was there decides nothing').to.have.lengthOf(0);
        expect(callsFor('sh')).to.have.lengthOf(0);
      });

      it('has its directory made inside the platform\'s namespace, parents included, and held at its mode', async () => {
        const mod = loadModule();
        const deployComp = await buildDeployComp(Object.fromEntries([
          dirMount('/data', 'data'),
          atomicSlot('/io.runonflux/conf/app.yaml', 'app.yaml'),
        ]), { encrypted: true });
        const slotDir = `${deployComp.dir}/io.runonflux/conf`;
        const slot = deployComp.mounts.find((m) => m.Source === slotDir);
        expect(slot && slot.perms, 'the premise: a platform-owned directory').to.deep.equal({ uid: 0, gid: 0, mode: '0555' });

        await mod.ensureMountSourcesExist(deployComp);

        const made = callsFor('mkdir').map((c) => c.args[1].params);
        expect(made).to.deep.include(['-p', slotDir]);
        expect(made, 'an owner directory needs no parent step').to.deep.include([`${deployComp.dir}/data`]);
        expect(callsFor('chown').map((c) => c.args[1].params)).to.deep.include(['0:0', slotDir]);
        expect(callsFor('chmod').map((c) => c.args[1].params)).to.deep.include(['0555', slotDir]);
      });
    });

    it('makes every source before asking whether it was there', async () => {
      const mod = loadModule();
      const deployComp = await buildDeployComp(Object.fromEntries([
        dirMount('/usr/share/nginx/html', 'html'),
        dirMount('/var/log/app', 'logs'),
        fileMount('/etc/app/config.yaml', 'config.yaml'),
      ]));
      const { dir } = deployComp;

      await mod.ensureMountSourcesExist(deployComp);

      expect(callsFor('mkdir').map((c) => c.args[1].params)).to.deep.equal([[`${dir}/html`], [`${dir}/logs`]]);
      expect(callsFor('sh').map((c) => c.args[1].params.at(-1))).to.deep.equal([`${dir}/config.yaml`]);
      expect(callsFor('test'), 'a source was asked about before it was made').to.have.lengthOf(0);
      expect(callsFor('chmod').map((c) => c.args[1].params)).to.deep.equal([
        ['777', `${dir}/html`], ['777', `${dir}/logs`], ['777', `${dir}/config.yaml`],
      ]);
    });

    it('handles empty mounts array', async () => {
      const mod = loadModule();
      // A stateless component: the spec gives it no volume, so it has no mounts.
      const deployComp = await buildDeployComp({});
      expect(deployComp.mounts).to.eql([]);

      await mod.ensureMountSourcesExist(deployComp);

      expect(serviceHelperStub.runCommand.called).to.be.false;
    });
  });

  // A pass is one call: the cadence lives in startActiveStandbyCoordinator's interval,
  // so a test drives passes by calling coordinateActiveStandbyApps directly.
  describe('coordinateActiveStandbyApps tests', () => {
    let globalStateRef;
    let deploymentProviderStub;

    // What makes a component a g:/masterSlave component on the real class:
    // persistentStorage.sync.mode === activeStandby. hasActiveStandbySyncthing()
    // and hasSyncthing() are derived from it, never set independently.
    const AS_STORAGE = {
      sizeGb: 5,
      mounts: { '/data': { source: 'data', destination: '/data' } },
      sync: { mode: 'activeStandby' },
    };

    /** A real DeploymentSpec for a single-component activeStandby app. */
    const gDeployment = (appName, identifier) => oneComponentDeployment(
      appName, identifier.split('_')[0], { persistentStorage: AS_STORAGE },
    );

    /**
     * A real MIXED app: a plain component declared first, then the activeStandby
     * one. The coordinator must walk past the sibling and act on the g: component.
     */
    async function mixedGDeployment(appName, asComponent) {
      const spec = await specWithComponents(appName, {
        db: { ports: { pg: { containerPort: 5432, hostPort: 31_001 } } },
        [asComponent]: { persistentStorage: AS_STORAGE },
      });
      return deploymentFor(spec);
    }

    /**
     * A running container as the node creates it: named by its component's
     * identifier and stamped with the identity labels the library makes.
     */
    async function runningContainerOf(deployComp) {
      const { identityLabels } = await loadSpecLibrary();
      return { Names: [`/${deployComp.identifier}`], Labels: identityLabels(deployComp) };
    }

    beforeEach(() => {
      globalStateRef = globalState;
      operationRegistry.clear();
      // the first-run mount-safety gate blocks election until the syncthing
      // monitor's first cycle completes; these tests model a settled node
      globalStateRef.syncthingAppsFirstRun = false;
      sinon.stub(appsRuntimeState, 'isOperatorStopped').resolves(false);
      sinon.stub(serviceHelper, 'delay').resolves();

      sinon.stub(syncthingService, 'getHealth').resolves({ status: 'OK' });

      deploymentProviderStub = sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves([]);

      sinon.stub(appQueryService, 'listRunningContainers').resolves([]);

      sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({}) });
      sinon.stub(dbHelper, 'findOneInDatabase').resolves(null);
    });

    it('skips the cycle while syncthing does not answer its health check with OK', async () => {
      syncthingService.getHealth.resolves({ status: 'starting' });

      await appOperations.coordinateActiveStandbyApps();

      expect(deploymentProviderStub.called).to.be.false;
    });

    it('should skip execution while a folder-set-changing operation is in flight', async () => {
      operationRegistry.acquire('someapp', 'install', 'test');

      await appOperations.coordinateActiveStandbyApps();

      expect(deploymentProviderStub.called).to.be.false;
    });

    it('should skip apps in backup progress', async () => {
      const appName = 'testapp';
      deploymentProviderStub.resolves([await gDeployment(appName, `web_${appName}`)]);
      operationRegistry.acquire(appName, 'backup', 'test');

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
      const mixed = await mixedGDeployment('n8napp', 'n8n');
      expect(mixed.componentEntries()[0][0], 'the plain sibling comes first, so the walk must pass it').to.equal('db');
      expect(mixed.getComponent('n8n').identifier).to.equal(identifier);
      deploymentProviderStub.resolves([mixed]);

      // The active-standby component is currently running on THIS node.
      const listRunningContainers = sinon.stub().resolves([await runningContainerOf(mixed.getComponent('n8n'))]);
      const appOps = proxyquire('../../ZelBack/src/services/appLifecycle/appOperations', {
        '../appQuery/appQueryService': { ...appQueryService, listRunningContainers },
      });

      // FDM reports the primary lives on a DIFFERENT node -> this node is a standby.
      sinon.stub(serviceHelper, 'axiosGet').resolves({ data: { status: 'success', data: { ips: ['203.0.113.99'] } } });

      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.5:16137');

      sinon.stub(dockerService, 'getAppIdentifier').returns('appid');
      const setDesiredStub = sinon.stub(appReconciler, 'setControllerDesired');
      const count = sinon.stub(fluxEventBus, 'count');

      await appOps.coordinateActiveStandbyApps();
      await new Promise((r) => { setImmediate(r); }); // flush the fire-and-forget hand-off

      // a pass that read a primary off FDM is tallied, whichever node it names
      sinon.assert.calledWithExactly(count, 'masterSlave:decision', identifier, 'primaryObserved');

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
      const deployment = await gDeployment('n8napp', identifier);
      const listRunningContainers = sinon.stub().resolves([await runningContainerOf(deployment.getComponent('n8n'))]);
      const appOps = proxyquire('../../ZelBack/src/services/appLifecycle/appOperations', {
        '../appQuery/appQueryService': { ...appQueryService, listRunningContainers },
      });

      deploymentProviderStub.resolves([deployment]);

      // FDM names THIS node as primary, returned as a bare IP (production format).
      sinon.stub(serviceHelper, 'axiosGet').resolves({ data: { status: 'success', data: { ips: ['192.168.1.5'] } } });

      // Same IP but a non-default (UPnP) port — ipsMatch ignores the port.
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.5:16137');

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

    it('announces an operator-stopped component once, not on every pass', async () => {
      const identifier = 'opstopa_appa';
      deploymentProviderStub.resolves([await gDeployment('appa', identifier)]);

      appsRuntimeState.isOperatorStopped.resetBehavior();
      appsRuntimeState.isOperatorStopped.resolves(true);

      sinon.stub(dockerService, 'getAppIdentifier').returns(`flux${identifier}`);
      const publish = sinon.stub(fluxEventBus, 'publish');

      const count = sinon.stub(fluxEventBus, 'count');

      await appOperations.coordinateActiveStandbyApps();
      await appOperations.coordinateActiveStandbyApps();

      // silence here is indistinguishable from a dead loop, but a line every 30s is noise
      expect(decisionsFor(publish, identifier, 'operatorStopExcluded')).to.have.lengthOf(1);
      // the tally reports every pass that honoured the stop
      expect(count.getCalls().filter((c) => c.args[1] === identifier && c.args[2] === 'operatorStopped'),
        'each pass that left the stopped component alone is counted').to.have.lengthOf(2);
    });

    it('leaves a component alone while the give-up pass has it standing down', async () => {
      // A node handing an app back stops writing first. The election would
      // otherwise see the component not running here and start it again.
      const identifier = 'stood_appc';
      deploymentProviderStub.resolves([await gDeployment('appc', identifier)]);
      sinon.stub(appGiveUp, 'isStandingDown').callsFake((id) => id === identifier);

      sinon.stub(dockerService, 'getAppIdentifier').returns(`flux${identifier}`);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.5:16137');
      const fdm = sinon.stub(serviceHelper, 'axiosGet').resolves({ data: { status: 'success', data: { ips: ['192.168.1.5'] } } });
      const publish = sinon.stub(fluxEventBus, 'publish');
      const count = sinon.stub(fluxEventBus, 'count');

      await appOperations.coordinateActiveStandbyApps();
      await appOperations.coordinateActiveStandbyApps();

      expect(fdm.called, 'a stood-down component is not a candidate, so nobody is asked who the primary is').to.be.false;
      expect(decisionsFor(publish, identifier, 'standDownExcluded')).to.have.lengthOf(1);
      expect(count.getCalls().filter((c) => c.args[1] === identifier && c.args[2] === 'standingDown'),
        'each pass that left the stood-down component alone is counted').to.have.lengthOf(2);
    });

    it('announces again after the operator lock is lifted and re-applied', async () => {
      const identifier = 'opstopb_appb';
      deploymentProviderStub.resolves([await gDeployment('appb', identifier)]);

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

    // An app under an operation (backup, restore, install...) is left alone for
    // the cycle, and the skip is tallied so an observer can tell a pass that
    // considered the busy app from one that never ran.
    it('leaves a held app alone for the cycle and tallies the skip', async () => {
      const identifier = 'held_appq';
      deploymentProviderStub.resolves([await gDeployment('appq', identifier)]);
      operationRegistry.acquire('appq', 'backup', 'test', 'backup appq');
      const publish = sinon.stub(fluxEventBus, 'publish');
      const count = sinon.stub(fluxEventBus, 'count');

      await appOperations.coordinateActiveStandbyApps();

      sinon.assert.calledWithExactly(count, 'masterSlave:decision', 'appq', 'skippedBusy');
      const decisions = publish.getCalls().filter((c) => c.args[0] === 'masterSlave:decision' && c.args[1]?.identifier === identifier);
      expect(decisions, 'an election decision was made on a held app').to.deep.equal([]);
    });

    // FDM's silence is not FDM saying there is no primary. A node that heard
    // nothing from any region must not read the silence as an invitation.
    it('skips primary selection for the cycle when no FDM region answers', async () => {
      const identifier = 'fdmsilent_appq';
      deploymentProviderStub.resolves([await gDeployment('appq', identifier)]);
      sinon.stub(dockerService, 'getAppIdentifier').returns(`flux${identifier}`);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.5:16137');
      sinon.stub(serviceHelper, 'axiosGet').rejects(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      const publish = sinon.stub(fluxEventBus, 'publish');
      const warn = sinon.stub(log, 'warn');

      await appOperations.coordinateActiveStandbyApps();

      expect(warn.args.some(([message]) => String(message).includes('All FDM services failed')), 'the silence was named').to.equal(true);
      const decisions = publish.getCalls().filter((c) => c.args[0] === 'masterSlave:decision' && c.args[1]?.identifier === identifier);
      expect(decisions, 'an election decision was made on silence').to.deep.equal([]);
    });

    // Readiness without a synced mark is read off syncthing's folder list by the
    // id the resources record, never by the directory a name would build.
    describe('the readiness fallback when no synced mark is held', () => {
      // An app registered before v9: the folder id is its 8.x name, the
      // directory the component's identifier, so a match by one cannot pass
      // for a match by the other.
      const APP = 'appr';
      const identifier = 'web_appr';
      const FOLDER_ID = 'fluxweb_appr';
      let appLocation;
      let appOps;

      beforeEach(async () => {
        const deployment = deploymentFor(await specWithComponents(APP, { web: { persistentStorage: AS_STORAGE } }), { registrationVersion: 8 });
        expect(deployment.getComponent('web').syncFolderId, 'the premise').to.equal(FOLDER_ID);
        deploymentProviderStub.resolves([deployment]);
        sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.5:16137');
        // FDM names no primary and the component is not running here: the pass
        // reaches the election, whose first act after readiness is to ask where
        // the app runs. That ask is the observation point, and it ends the pass.
        sinon.stub(serviceHelper, 'axiosGet').resolves({ data: { status: 'success', data: { ips: [] } } });
        appLocation = sinon.stub(registryManager, 'appLocation').rejects(new Error('observed: readiness passed'));
        sinon.stub(log, 'error');
        appOps = proxyquire('../../ZelBack/src/services/appLifecycle/appOperations', {
          '../appQuery/appQueryService': { ...appQueryService, listRunningContainers: sinon.stub().resolves([]) },
        });
      });

      it('treats a folder syncthing lists as sendreceive under the recorded id as ready', async () => {
        sinon.stub(syncthingService, 'getConfigFolders').resolves([
          { id: FOLDER_ID, path: `${appsFolder}${identifier}`, type: 'sendreceive' },
        ]);

        await appOps.coordinateActiveStandbyApps();

        sinon.assert.calledOnceWithExactly(appLocation, APP);
      });

      it('does not treat a sendreceive folder at the component\'s directory as ready when its id is not the recorded one', async () => {
        sinon.stub(syncthingService, 'getConfigFolders').resolves([
          { id: identifier, path: `${appsFolder}${identifier}`, type: 'sendreceive' },
        ]);

        await appOps.coordinateActiveStandbyApps();

        sinon.assert.notCalled(appLocation);
      });

      it('does not treat the recorded folder as ready while it is still receiveonly', async () => {
        sinon.stub(syncthingService, 'getConfigFolders').resolves([
          { id: FOLDER_ID, path: `${appsFolder}${identifier}`, type: 'receiveonly' },
        ]);

        await appOps.coordinateActiveStandbyApps();

        sinon.assert.notCalled(appLocation);
      });

      // FDM already names this node as the primary and the component is not
      // running here: the same readiness decides whether the promotion starts,
      // whose first act is to announce itself.
      describe('when FDM names this node as the primary', () => {
        let publish;

        beforeEach(() => {
          serviceHelper.axiosGet.resolves({ data: { status: 'success', data: { ips: ['192.168.1.5'] } } });
          publish = sinon.stub(fluxEventBus, 'publish');
          // The promotion's later steps touch syncthing, the volume and the
          // reconciler; none of them is the subject here.
          sinon.stub(syncthingService, 'adjustConfigFolders').resolves({ status: 'success', data: {} });
          sinon.stub(serviceHelper, 'runCommand').resolves({ error: null, stdout: '', stderr: '' });
          sinon.stub(appReconciler, 'setControllerDesired').resolves();
        });

        const started = () => publish.getCalls().filter((c) => c.args[0] === 'masterSlave:started' && c.args[1]?.identifier === identifier);

        it('starts the promotion when syncthing lists the recorded folder as sendreceive', async () => {
          sinon.stub(syncthingService, 'getConfigFolders').resolves([
            { id: FOLDER_ID, path: `${appsFolder}${identifier}`, type: 'sendreceive' },
          ]);

          await appOps.coordinateActiveStandbyApps();

          expect(started()).to.have.lengthOf(1);
        });

        it('starts nothing when only a folder at the component\'s directory is sendreceive, under another id', async () => {
          sinon.stub(syncthingService, 'getConfigFolders').resolves([
            { id: identifier, path: `${appsFolder}${identifier}`, type: 'sendreceive' },
          ]);

          await appOps.coordinateActiveStandbyApps();

          expect(started()).to.have.lengthOf(0);
        });

        it('starts nothing while the recorded folder is still receiveonly', async () => {
          sinon.stub(syncthingService, 'getConfigFolders').resolves([
            { id: FOLDER_ID, path: `${appsFolder}${identifier}`, type: 'receiveonly' },
          ]);

          await appOps.coordinateActiveStandbyApps();

          expect(started()).to.have.lengthOf(0);
        });
      });
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
      deploymentProviderStub.resolves([await gDeployment('appc', identifier)]);

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

    // Real spec hashes: 64 hex characters, the form the registry and the daemon's
    // stored plans both carry.
    const HASH_OLD = 'a'.repeat(64);
    const HASH_NEW = 'b'.repeat(64);
    // The identity of an app whose plan the daemon holds and this node no longer runs.
    const GONE = `b${'c'.repeat(52)}`;

    /** A real RegisteredSpec — what listInstalledApps hydrates each row into. */
    async function installedRow(name, hash, identity = IDENTITY) {
      return registeredSpec(await v9Spec({ name }), { hash, identity });
    }

    async function loadWith({
      arcane = true, installed = [], plans = [], deployment, deployments = null,
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
      const built = deployment ?? await oneComponentDeployment('app1', 'web', {}, { identity: IDENTITY });
      // Records what the resync hands the (stubbed) provider, so a test can prove
      // the real provider could have built a deployment from it.
      const buildDeploymentsSpy = sinon.stub();
      const providerStub = {
        buildDeployment: sinon.stub().resolves(built),
        // Delegates at call time so per-test overrides of buildDeployment flow
        // through the plural entry the resync uses; `deployments`/`buildThrows`
        // exercise the multi-identity and build-failure paths directly.
        get buildDeployments() {
          const single = this.buildDeployment;
          return async (inst) => {
            buildDeploymentsSpy(inst);
            if (buildThrows) throw new Error('resolve failed');
            if (deployments) return deployments;
            const one = await single(inst);
            return one ? [one] : [];
          };
        },
      };
      const shutdownPlanStub = {
        buildShutdownPlan: sinon.stub().callsFake((inst, dep) => ({ app_name: inst.name, replica: dep.replica ?? null })),
        appRequiresDaemonShutdown: sinon.stub().returns(requires),
        daemonIdentity: shutdownPlan.daemonIdentity,
      };
      const mod = proxyquire('../../ZelBack/src/services/appLifecycle/appOperations', {
        'node:fs/promises': fsPromises,
        '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
        '../appDatabase/appRecords': { hostedInstances: () => ({ apps: async () => installed.map((record) => installedRecord(record)) }) },
        '../appRuntime/deploymentProvider': providerStub,
        './shutdownPlan': shutdownPlanStub,
        '../utils/fluxShutdowndClient': client,
      });
      return {
        mod, client, shutdownPlanStub, buildDeploymentsSpy,
      };
    }

    it('re-pushes a drifted plan and removes an orphan', async () => {
      const {
        mod, client, shutdownPlanStub, buildDeploymentsSpy,
      } = await loadWith({
        installed: [await installedRow('app1', HASH_NEW)],
        plans: [
          { app_name: 'app1', identity: IDENTITY, spec_hash: HASH_OLD },
          { app_name: 'gone', identity: GONE, spec_hash: 'c'.repeat(64) },
        ],
      });
      await mod.shutdownPlanResync();
      expect(client.upsertAppPlanBestEffort.calledOnce).to.be.true;
      sinon.assert.calledOnceWithExactly(client.deleteAppPlanBestEffort, GONE, null);

      // The provider is stubbed, so nothing else proves the installed row it was
      // handed is one the real provider could resolve and build a deployment from.
      const [handedRow] = buildDeploymentsSpy.firstCall.args;
      const rebuilt = deploymentFor(await resolveRegisteredSpec(handedRow));
      expect(rebuilt.appName).to.equal('app1');

      // shutdownPlan is stubbed too; both of its entry points walk the deployment's
      // components, and buildShutdownPlan reads the hash off the installed row and
      // the identity off the deployment.
      assertAnswers(shutdownPlanStub.appRequiresDaemonShutdown.firstCall.args[0], ['componentEntries']);
      const [planRow, planDeployment] = shutdownPlanStub.buildShutdownPlan.firstCall.args;
      assertAnswers(planDeployment, ['componentEntries']);
      expect(planRow.hash).to.equal(HASH_NEW);
      expect(planDeployment.identity).to.equal(IDENTITY);
    });

    it('leaves a plan untouched when its hash already matches', async () => {
      const { mod, client } = await loadWith({
        installed: [await installedRow('app1', HASH_NEW)],
        plans: [{ app_name: 'app1', identity: IDENTITY, spec_hash: HASH_NEW }],
      });
      await mod.shutdownPlanResync();
      expect(client.upsertAppPlanBestEffort.called).to.be.false;
      expect(client.deleteAppPlanBestEffort.called).to.be.false;
    });

    it('matches a stored plan by the app\'s identity, not by its name', async () => {
      // The daemon holds a plan for an earlier app of the same name: this node's
      // app is another identity, so its own plan is pushed and that one goes.
      const { mod, client } = await loadWith({
        installed: [await installedRow('app1', HASH_NEW)],
        plans: [{ app_name: 'app1', identity: GONE, spec_hash: HASH_NEW }],
      });
      await mod.shutdownPlanResync();
      expect(client.upsertAppPlanBestEffort.calledOnce).to.be.true;
      sinon.assert.calledOnceWithExactly(client.deleteAppPlanBestEffort, GONE, null);
    });

    it('keeps the plan of an app with no identity minted under its name', async () => {
      const { mod, client } = await loadWith({
        installed: [await installedRow('app1', HASH_NEW, null)],
        plans: [{ app_name: 'app1', identity: 'app1', spec_hash: HASH_NEW }],
        deployment: await oneComponentDeployment('app1', 'web'),
      });
      await mod.shutdownPlanResync();
      expect(client.upsertAppPlanBestEffort.called).to.be.false;
      expect(client.deleteAppPlanBestEffort.called).to.be.false;
    });

    it('does nothing when the shutdownd socket is absent', async () => {
      const { mod, client } = await loadWith({ arcane: false });
      await mod.shutdownPlanResync();
      expect(client.listAppPlans.called).to.be.false;
    });

    it('orphan-deletes the plan of an installed app that no longer needs daemon shutdown', async () => {
      // The app dropped its graceful-shutdown features (spec hash drifted), so the
      // predicate is now false: it must be excluded from `live` and its stale plan
      // removed, never re-pushed.
      const { mod, client } = await loadWith({
        installed: [await installedRow('app1', HASH_NEW)],
        plans: [{ app_name: 'app1', identity: IDENTITY, spec_hash: HASH_OLD }],
        requires: false,
      });
      await mod.shutdownPlanResync();
      expect(client.upsertAppPlanBestEffort.called).to.be.false;
      sinon.assert.calledOnceWithExactly(client.deleteAppPlanBestEffort, IDENTITY, null);
    });

    it('pushes no plan for a non-requiring installed app with no stored plan', async () => {
      const { mod, client } = await loadWith({
        installed: [await installedRow('plain', HASH_NEW)],
        plans: [],
        requires: false,
      });
      await mod.shutdownPlanResync();
      expect(client.upsertAppPlanBestEffort.called).to.be.false;
      expect(client.deleteAppPlanBestEffort.called).to.be.false;
    });

    it('keys per replica: re-pushes each assigned identity and orphan-deletes a de-assigned one', async () => {
      const { mod, client } = await loadWith({
        installed: [await installedRow('app1', HASH_NEW)],
        plans: [
          {
            app_name: 'app1', identity: IDENTITY, replica: 's1', spec_hash: HASH_OLD,
          },
          {
            app_name: 'app1', identity: IDENTITY, replica: 's2', spec_hash: HASH_OLD,
          },
        ],
        deployments: [await oneComponentDeployment('app1', 'web', {}, { replica: 's1', identity: IDENTITY })],
      });
      await mod.shutdownPlanResync();
      expect(client.upsertAppPlanBestEffort.calledOnce).to.be.true;
      expect(client.upsertAppPlanBestEffort.firstCall.args[0].replica).to.equal('s1');
      // s2 is no longer assigned here: its plan is an orphan, deleted by its key.
      sinon.assert.calledOnceWithExactly(client.deleteAppPlanBestEffort, IDENTITY, 's2');
    });

    it('a matching hash keeps each replica plan without a re-push', async () => {
      const { mod, client } = await loadWith({
        installed: [await installedRow('app1', HASH_NEW)],
        plans: [
          {
            app_name: 'app1', identity: IDENTITY, replica: 's1', spec_hash: HASH_NEW,
          },
          {
            app_name: 'app1', identity: IDENTITY, replica: 's2', spec_hash: HASH_NEW,
          },
        ],
        deployments: [
          await oneComponentDeployment('app1', 'web', {}, { replica: 's1', identity: IDENTITY }),
          await oneComponentDeployment('app1', 'web', {}, { replica: 's2', identity: IDENTITY }),
        ],
      });
      await mod.shutdownPlanResync();
      expect(client.upsertAppPlanBestEffort.called).to.be.false;
      expect(client.deleteAppPlanBestEffort.called).to.be.false;
    });

    it('keeps every stored plan of an app whose deployments cannot be built', async () => {
      const { mod, client } = await loadWith({
        installed: [await installedRow('app1', HASH_NEW)],
        plans: [
          {
            app_name: 'app1', identity: IDENTITY, replica: 's1', spec_hash: HASH_OLD,
          },
          {
            app_name: 'app1', identity: IDENTITY, replica: 's2', spec_hash: HASH_OLD,
          },
        ],
        buildThrows: true,
      });
      await mod.shutdownPlanResync();
      // Couldn't evaluate the app: keeping a possibly stale plan beats orphaning
      // a live one.
      expect(client.deleteAppPlanBestEffort.called).to.be.false;
      expect(client.upsertAppPlanBestEffort.called).to.be.false;
    });

    it('keeps them by the app\'s identity: a plan held for another app of the same name still goes', async () => {
      const { mod, client } = await loadWith({
        installed: [await installedRow('app1', HASH_NEW)],
        plans: [
          { app_name: 'app1', identity: IDENTITY, spec_hash: HASH_OLD },
          { app_name: 'app1', identity: GONE, spec_hash: HASH_OLD },
        ],
        buildThrows: true,
      });
      await mod.shutdownPlanResync();
      sinon.assert.calledOnceWithExactly(client.deleteAppPlanBestEffort, GONE, null);
    });

    it('keeps the stored plans of an unbuildable app with no identity minted, held under its name', async () => {
      const { mod, client } = await loadWith({
        installed: [await installedRow('app1', HASH_NEW, null)],
        plans: [{ app_name: 'app1', identity: 'app1', spec_hash: HASH_OLD }],
        buildThrows: true,
      });
      await mod.shutdownPlanResync();
      expect(client.deleteAppPlanBestEffort.called).to.be.false;
    });
  });

  describe('the containers an app-wide start drives', () => {
    it('are this node\'s, named by its hosted instance whatever version the registry lists', async () => {
      const KEY = `c${'k'.repeat(52)}`;
      const install = installedRecord(await registeredSpec(await v9Spec({ name: 'myapp' }), { identity: IDENTITY }), {
        componentKeys: new Map([['web', KEY]]),
      });
      stubHostedInstances().byName.resolves(install);
      stubRegistry().byName.resolves(await registeredSpec(await v9Spec({ name: 'myapp' }), { identity: `b${'f'.repeat(52)}` }));
      sinon.stub(deploymentProvider, 'buildDeployment').callsFake(async (record) => deploymentFor(record.spec, {
        identity: record.identity, componentKeys: record.componentKeys,
      }));
      const drive = sinon.stub(appReconciler, 'drive').resolves({ converged: true, failed: [] });

      await appOperations.startApplication('myapp');

      expect(deploymentProvider.buildDeployment.firstCall.args[0]).to.equal(install);
      sinon.assert.calledOnceWithExactly(drive, [`${KEY}_${IDENTITY}`], 'running');
    });
  });

  describe('reconcileComponents port-delta tests', () => {
    // A spec-change reconcile must move only the ufw/UPnP rules that changed: close the
    // dropped ports (old−new), open the added ports (new−old), leave the kept ports'
    // mappings in place. The per-component teardown/reinstall run with skipPorts.

    /**
     * A real DeploymentSpec for a one-component app, parameterised on exactly the
     * fields this suite varies. `cpu` is the "same volume, changed component" lever:
     * DeploymentComponent.equals is a deep field compare, so two views that differ
     * only in cpu land in keepVolume rather than being skipped as unchanged.
     */
    async function makeDeployment({
      hostPorts, storage, graceful = false, cpu = 0.5,
    }, depOpts = {}) {
      const ports = {};
      for (const hostPort of hostPorts) ports[`p${hostPort}`] = { containerPort: hostPort, hostPort };
      const overrides = {
        cpu,
        ports,
        persistentStorage: { sizeGb: storage, mounts: { '/data': { source: 'data', destination: '/data' } } },
      };
      // A declared shutdown IS the graceful contract; without one the component's
      // contract is docker's own SIGTERM + 10s window.
      if (graceful) overrides.shutdown = { gracefulTimeout: 290 };
      return oneComponentDeployment('myapp', 'web', overrides, depOpts);
    }

    let uninstallComponentStub;
    let denyPortsStub;
    let openHostPortsStub;
    let teardownOwedForStub;
    let instanceResources;
    let stageContentStub;
    let provisionContentSlotsStub;
    let ensureSourcesStub;

    function setup({ teardownOwed = false } = {}) {
      instanceResources = stubInstanceResources();
      // The content service and the host's filesystem: every file is to be had,
      // and every mount source can be made.
      stageContentStub = sinon.stub(contentSlotService, 'stageContent').resolves(0);
      provisionContentSlotsStub = sinon.stub(contentSlotService, 'provisionContentSlots').resolves();
      ensureSourcesStub = sinon.stub(appVolumeService, 'ensureMountSourcesExist').resolves(false);
      sinon.stub(componentProvisioner, 'portOpenMethods').resolves(['ufw']);
      sinon.stub(componentProvisioner, 'verifyComponentImage').resolves();
      sinon.stub(serviceHelper, 'delay').resolves();
      stubHostedInstances();
      // freshDeployment = null short-circuits the install loop, telemetry and shutdown-plan
      // blocks, leaving the port close + gated open as the only port effects under test.
      sinon.stub(deploymentProvider, 'planDeployment').resolves(null);
      sinon.stub(hwRequirements, 'checkNodeResources').resolves();
      // The redeploy/update path uses the reclaiming variant: these run AFTER
      // the containers are gone, so a shortfall leaves a paid app destroyed and
      // free session capacity must never be what causes one.
      sinon.stub(hwRequirements, 'checkNodeResourcesReclaiming').resolves();
      sinon.stub(appUninstaller, 'reclaimUnusedImages').resolves();
      uninstallComponentStub = sinon.stub(appUninstaller, 'uninstallComponent').resolves();
      denyPortsStub = sinon.stub(appUninstaller, 'denyPorts').resolves();
      openHostPortsStub = sinon.stub(componentProvisioner, 'openHostPorts').resolves();
      teardownOwedForStub = sinon.stub(owedRemovals, 'removalOwedFor').resolves(teardownOwed);
      // The version the app was registered with, as its registration message states it.
      sinon.stub(appHistory, 'registrationVersionOf').resolves(9);
    }

    /** The resources naming the component's ports, each opened by both methods. */
    const resourcesNaming = (ports) => {
      const { InstanceResources } = specLibrary.loaded();
      return new InstanceResources({
        name: 'myapp',
        components: {
          web: {
            ...InstanceResources.newBlock({ identifier: 'web_myapp', image: 'img' }),
            hostPorts: ports.map((port) => ({ port, opened: ['ufw', 'upnp'] })),
          },
        },
      });
    };

    /** Each component's key in a deployment, by name: what the update carries. */
    const keysOf = (deployment) => new Map(deployment.componentEntries().map(([, comp]) => [comp.name, comp.componentKey]));
    const namingOf = (deployment, formerNames = new Map()) => ({ componentKeys: keysOf(deployment), formerNames });

    /** The registry side of a reconcile is an RegisteredSpec (a hydrated row). */
    let registrySpec;

    beforeEach(async () => {
      registrySpec = await registeredSpec(await v9Spec());
    });

    it('closes only the dropped ports, opens only the added ones, and skips ports in the loops', async () => {
      setup();
      instanceResources.byInstance.resolves(resourcesNaming([80, 443]));
      // old: 80,443 ; new: 443,8080 -> drop 80, add 8080, keep 443.
      const oldDeployment = await makeDeployment({ hostPorts: [80, 443], storage: 5 });
      const newDeployment = await makeDeployment({ hostPorts: [443, 8080], storage: 10 });

      const formerNames = new Map([['web', ['site']]]);
      await appOperations.reconcileComponents('myapp', oldDeployment, newDeployment, registrySpec, namingOf(newDeployment, formerNames));

      expect(uninstallComponentStub.calledWith(sinon.match.any, sinon.match({ skipPorts: true })), 'teardown skips ports').to.be.true;
      expect(denyPortsStub.calledOnceWith([{ port: 80, opened: ['ufw', 'upnp'] }], 'myapp'), 'closes only the dropped port, by the methods it was opened with').to.be.true;
      expect(openHostPortsStub.calledOnceWith([8080], 'myapp'), 'opens only the added port').to.be.true;
      // The registry record is what every instance's record becomes, with the
      // component keys and former names the update carries.
      sinon.assert.calledOnceWithExactly(stubHostedInstances().updateRecord, registrySpec, { componentKeys: keysOf(newDeployment), formerNames });

      // The uninstaller stays stubbed: assert the component it was handed carries
      // the two fields the real teardown reads off it (container name, port set).
      const [handedComp] = uninstallComponentStub.firstCall.args;
      expect(handedComp.identifier).to.equal('web_myapp');
      expect(handedComp.hostPorts).to.eql([80, 443]);

      // The deployment provider stays stubbed too, and this is the seam the update
      // path hands the registry spec through — it has to be one the real provider
      // could resolve and build from. The view is named by the version the
      // registration message states, so a component the update adds is named right.
      const [handedRegistrySpec, buildOpts] = deploymentProvider.planDeployment.firstCall.args;
      expect(deploymentFor(await resolveRegisteredSpec(handedRegistrySpec)).appName).to.equal('myapp');
      sinon.assert.calledOnceWithExactly(appHistory.registrationVersionOf, 'myapp', registrySpec.uuid);
      expect(buildOpts).to.have.property('registrationVersion', 9);
      expect(buildOpts.componentKeys).to.deep.equal(keysOf(newDeployment));
    });

    // The update's new views, one per identity, are named by the registration
    // too: a component the update adds takes its folder id from it.
    it('builds the update\'s new views by the version the registration message states', async () => {
      setup();
      deploymentProvider.getInstalledDeployments.resolves([]);
      deploymentProvider.planDeployments.resolves([]);
      const keys = new Map([['web', `c${'k'.repeat(52)}`]]);
      sinon.stub(componentKeyMap, 'namingForUpdate').resolves({ componentKeys: keys, formerNames: new Map() });
      const installed = { name: 'myapp', uuid: 'u-myapp', identity: 'idmyapp' };

      await appOperations.reconcileApp(installed, registrySpec);

      sinon.assert.calledOnceWithExactly(appHistory.registrationVersionOf, 'myapp', 'u-myapp');
      sinon.assert.calledOnceWithExactly(componentKeyMap.namingForUpdate, installed, registrySpec);
      sinon.assert.calledOnceWithExactly(deploymentProvider.planDeployments, registrySpec, { identity: 'idmyapp', registrationVersion: 9, componentKeys: keys });
    });

    it('routes a graceful component teardown through flux-shutdownd, component-scoped', async () => {
      setup();
      const beginAppStop = sinon.stub(fluxShutdowndClient, 'beginAppStop').resolves({ outcome: 'complete' });
      // Same volume size, changed component -> keepVolume, and a declared shutdown
      // contract on both sides.
      const oldDeployment = await makeDeployment({ hostPorts: [80], storage: 5, graceful: true }, { identity: IDENTITY });
      const newDeployment = await makeDeployment({
        hostPorts: [80], storage: 5, graceful: true, cpu: 0.7,
      }, { identity: IDENTITY });
      expect(oldDeployment.getComponent('web').requiresDaemonShutdown()).to.be.true;
      expect(oldDeployment.getComponent('web').equals(newDeployment.getComponent('web')), 'the component must read as changed').to.be.false;

      await appOperations.reconcileComponents('myapp', oldDeployment, newDeployment, registrySpec, namingOf(newDeployment));

      expect(beginAppStop.calledOnce, 'the daemon owns the graceful stop').to.be.true;
      const [identity, app, reason, opts] = beginAppStop.firstCall.args;
      expect(identity, 'the daemon is asked by the identity the old container carries').to.equal(IDENTITY);
      expect(app).to.equal('myapp');
      expect(reason).to.equal(fluxShutdowndClient.SHUTDOWN_REASON.REDEPLOY);
      expect(opts.component).to.equal('web');
      expect(opts.replica).to.equal(null);
      expect(uninstallComponentStub.calledWith(sinon.match.any, sinon.match({ stopHandled: true })), 'the teardown must not stop again').to.be.true;
    });

    it('a component with no declared contract keeps the local stop', async () => {
      setup();
      const beginAppStop = sinon.stub(fluxShutdowndClient, 'beginAppStop').resolves({ outcome: 'complete' });
      const oldDeployment = await makeDeployment({ hostPorts: [80], storage: 5 });
      const newDeployment = await makeDeployment({ hostPorts: [80], storage: 5, cpu: 0.7 });
      expect(oldDeployment.getComponent('web').requiresDaemonShutdown(), 'no shutdown/preStop/drain declared').to.be.false;

      await appOperations.reconcileComponents('myapp', oldDeployment, newDeployment, registrySpec, namingOf(newDeployment));

      expect(beginAppStop.called, 'docker SIGTERM+grace IS this component contract').to.be.false;
      expect(uninstallComponentStub.calledWith(sinon.match.any, sinon.match({ stopHandled: true }))).to.be.false;
    });

    it('leaves an unchanged component alone entirely', async () => {
      // The equality check is the real deep field compare now, so two identical
      // views must produce no teardown at all — the case a hard-coded
      // `equals: () => false` could never reach.
      setup();
      const oldDeployment = await makeDeployment({ hostPorts: [80], storage: 5 });
      const newDeployment = await makeDeployment({ hostPorts: [80], storage: 5 });

      await appOperations.reconcileComponents('myapp', oldDeployment, newDeployment, registrySpec, namingOf(newDeployment));

      expect(uninstallComponentStub.called, 'an unchanged component must not be torn down').to.be.false;
      expect(denyPortsStub.called, 'and its ports must not move').to.be.false;
      expect(openHostPortsStub.called).to.be.false;
    });

    // An update that changes what content the app declares. The files reach the
    // node's store before anything is torn down, and its containers before
    // anything is started.
    describe('the content the listed spec declares', () => {
      let installComponent;

      async function update(oldShape, newShape) {
        const oldDeployment = await makeDeployment({ hostPorts: [80], storage: 5, ...oldShape }, { identity: IDENTITY });
        const newDeployment = await makeDeployment({ hostPorts: [80], storage: 5, ...newShape }, { identity: IDENTITY });
        deploymentProvider.planDeployment.resolves(newDeployment);
        installComponent = sinon.stub(componentProvisioner, 'installComponent').resolves();
        return { oldDeployment, newDeployment };
      }

      it('is staged into the store before any component is torn down', async () => {
        setup();
        const { oldDeployment, newDeployment } = await update({}, { cpu: 0.7 });

        await appOperations.reconcileComponents('myapp', oldDeployment, newDeployment, registrySpec, namingOf(newDeployment));

        sinon.assert.calledOnceWithExactly(stageContentStub, newDeployment, { appName: 'myapp' });
        sinon.assert.calledOnce(uninstallComponentStub);
        expect(stageContentStub.calledBefore(uninstallComponentStub)).to.equal(true);
      });

      it('leaves the old version as it is when a file cannot be had: nothing torn down, the hosted instance unchanged', async () => {
        setup();
        const { oldDeployment, newDeployment } = await update({}, { cpu: 0.7 });
        stageContentStub.rejects(new Error('contentBlob: no source for sha256:x'));

        const failure = await appOperations.reconcileComponents('myapp', oldDeployment, newDeployment, registrySpec, namingOf(newDeployment)).then(() => null, (error) => error);

        expect(failure?.message).to.match(/no source/);
        sinon.assert.notCalled(uninstallComponentStub);
        sinon.assert.notCalled(stubHostedInstances().updateRecord);
        sinon.assert.notCalled(installComponent);
        sinon.assert.notCalled(provisionContentSlotsStub);
      });

      it('is delivered to the fresh deployment once its containers are created, naming the component this pass created', async () => {
        setup();
        const { oldDeployment, newDeployment } = await update({}, { cpu: 0.7 });

        await appOperations.reconcileComponents('myapp', oldDeployment, newDeployment, registrySpec, namingOf(newDeployment));

        sinon.assert.calledOnceWithExactly(provisionContentSlotsStub, newDeployment, { appName: 'myapp', created: ['web'] });
        expect(provisionContentSlotsStub.calledAfter(installComponent)).to.equal(true);
      });

      it('is delivered to the component an update that recreates nothing leaves running', async () => {
        setup();
        const { oldDeployment, newDeployment } = await update({}, {});

        await appOperations.reconcileComponents('myapp', oldDeployment, newDeployment, registrySpec, namingOf(newDeployment));

        sinon.assert.notCalled(installComponent);
        sinon.assert.calledOnceWithExactly(provisionContentSlotsStub, newDeployment, { appName: 'myapp', created: [] });
      });

      it('fails the adoption when it cannot be written', async () => {
        setup();
        const { oldDeployment, newDeployment } = await update({}, { cpu: 0.7 });
        provisionContentSlotsStub.rejects(new Error('contentSlot: no manifest covering every declared slot'));

        const failure = await appOperations.reconcileComponents('myapp', oldDeployment, newDeployment, registrySpec, namingOf(newDeployment)).then(() => null, (error) => error);

        expect(failure?.message).to.match(/covering every declared slot/);
      });
    });

    // A kept volume holds the sources the old spec's mounts had: one a mount
    // the update adds has to be made before docker is asked to bind it.
    describe('a component reinstalled on the volume it had', () => {
      let installComponent;

      async function update(oldShape, newShape) {
        const oldDeployment = await makeDeployment({ hostPorts: [80], ...oldShape }, { identity: IDENTITY });
        const newDeployment = await makeDeployment({ hostPorts: [80], ...newShape }, { identity: IDENTITY });
        deploymentProvider.planDeployment.resolves(newDeployment);
        installComponent = sinon.stub(componentProvisioner, 'installComponent').resolves();
        await appOperations.reconcileComponents('myapp', oldDeployment, newDeployment, registrySpec, namingOf(newDeployment));
        return newDeployment.getComponent('web');
      }

      it('has its mount sources made before its container is created', async () => {
        setup();
        const scan = sinon.stub(syncthingMonitorHelpers, 'requestFolderScan').resolves();

        const comp = await update({ storage: 5 }, { storage: 5, cpu: 0.7 });

        sinon.assert.calledOnceWithExactly(ensureSourcesStub, comp);
        expect(ensureSourcesStub.calledBefore(installComponent)).to.equal(true);
        expect(installComponent.firstCall.args[1].createVolumes, 'the fixture keeps the volume').to.equal(false);
        sinon.assert.notCalled(scan);
      });

      it('has its syncthing folder scanned when making them changed its ignore set', async () => {
        setup();
        ensureSourcesStub.resolves(true);
        const scan = sinon.stub(syncthingMonitorHelpers, 'requestFolderScan').resolves();

        const comp = await update({ storage: 5 }, { storage: 5, cpu: 0.7 });

        sinon.assert.calledOnceWithExactly(scan, comp.syncFolderId);
      });

      it('makes none for a component whose volume is rebuilt: the fresh volume makes its own', async () => {
        setup();

        await update({ storage: 5 }, { storage: 10 });

        expect(installComponent.firstCall.args[1].createVolumes, 'the fixture rebuilds the volume').to.equal(true);
        sinon.assert.notCalled(ensureSourcesStub);
      });

      it('makes none for a component that has no volume', async () => {
        setup();
        const stateless = (cpu) => oneComponentDeployment('myapp', 'web', {
          cpu, ports: { p80: { containerPort: 80, hostPort: 80 } }, persistentStorage: { sizeGb: 0 },
        }, { identity: IDENTITY });
        const oldDeployment = await stateless(0.5);
        const newDeployment = await stateless(0.7);
        expect(newDeployment.getComponent('web').isStateless, 'the fixture is stateless').to.equal(true);
        deploymentProvider.planDeployment.resolves(newDeployment);
        installComponent = sinon.stub(componentProvisioner, 'installComponent').resolves();

        await appOperations.reconcileComponents('myapp', oldDeployment, newDeployment, registrySpec, namingOf(newDeployment));

        sinon.assert.calledOnce(installComponent);
        sinon.assert.notCalled(ensureSourcesStub);
      });
    });

    describe('the shutdown daemon\'s plan after an update', () => {
      async function reconcile(oldShape, newShape, depOpts = {}) {
        setup();
        sinon.stub(fluxShutdowndClient, 'beginAppStop').resolves({ outcome: 'complete' });
        sinon.stub(fluxShutdowndClient, 'upsertAppPlanBestEffort').resolves();
        sinon.stub(fluxShutdowndClient, 'deleteAppPlanBestEffort').resolves();
        sinon.stub(componentProvisioner, 'installComponent').resolves();
        const oldDeployment = await makeDeployment({ hostPorts: [80], storage: 5, ...oldShape }, { identity: IDENTITY, ...depOpts });
        const newDeployment = await makeDeployment({ hostPorts: [80], storage: 5, ...newShape }, { identity: IDENTITY, ...depOpts });
        deploymentProvider.planDeployment.resolves(newDeployment);

        await appOperations.reconcileComponents('myapp', oldDeployment, newDeployment, registrySpec, namingOf(newDeployment));
      }

      it('is pushed under the app\'s identity for an app that stops through the daemon, and none is deleted', async () => {
        await reconcile({ graceful: true }, { graceful: true, cpu: 0.7 });

        sinon.assert.calledOnce(fluxShutdowndClient.upsertAppPlanBestEffort);
        expect(fluxShutdowndClient.upsertAppPlanBestEffort.firstCall.args[0]).to.include({ identity: IDENTITY, replica: null });
        sinon.assert.notCalled(fluxShutdowndClient.deleteAppPlanBestEffort);
      });

      it('is deleted by the app\'s identity when the update drops every graceful feature', async () => {
        await reconcile({ graceful: true }, {});

        sinon.assert.notCalled(fluxShutdowndClient.upsertAppPlanBestEffort);
        sinon.assert.calledOnceWithExactly(fluxShutdowndClient.deleteAppPlanBestEffort, IDENTITY, null);
      });

      it('is deleted for the named replica the update reconciled, and no other', async () => {
        await reconcile({ graceful: true }, {}, { replica: 's1' });

        sinon.assert.calledOnceWithExactly(fluxShutdowndClient.deleteAppPlanBestEffort, IDENTITY, 's1');
      });
    });

    // Nothing on a container says who owns its app, and the shutdown daemon
    // knows the app by its identity: a sale changes no component, so it
    // restarts nothing.
    describe('an update that only names another owner', () => {
      const SELLER = '1SellerOfTheAppxxxxxxxxxxxxxxxxxxxx';
      let installComponent;

      // The adoption of the update on a node that installed the app under the seller.
      async function adoptSale({ graceful = false } = {}) {
        setup();
        const oldDeployment = await makeDeployment({ hostPorts: [80], storage: 5, graceful }, { identity: IDENTITY });
        const newDeployment = await makeDeployment({ hostPorts: [80], storage: 5, graceful }, { identity: IDENTITY });
        deploymentProvider.planDeployment.resolves(newDeployment);
        deploymentProvider.getInstalledDeployments.resolves([oldDeployment]);
        deploymentProvider.planDeployments.resolves([newDeployment]);
        installComponent = sinon.stub(componentProvisioner, 'installComponent').resolves();
        sinon.stub(fluxShutdowndClient, 'beginAppStop').resolves({ outcome: 'complete' });
        sinon.stub(fluxShutdowndClient, 'upsertAppPlanBestEffort').resolves();
        sinon.stub(fluxShutdowndClient, 'deleteAppPlanBestEffort').resolves();
        sinon.stub(appReconciler, 'enqueueApp');
        sinon.stub(componentKeyMap, 'namingForUpdate').resolves(namingOf(newDeployment));
        expect(registrySpec.owner, 'the fixture names two owners').to.not.equal(SELLER);

        await appOperations.reconcileApp({
          name: 'myapp', uuid: 'u-myapp', identity: IDENTITY, owner: SELLER,
        }, registrySpec);
      }

      it('recreates no container, and the hosted instance takes the buyer', async () => {
        await adoptSale();

        sinon.assert.calledOnceWithExactly(stubHostedInstances().updateRecord, registrySpec, { componentKeys: new Map([['web', 'web']]), formerNames: new Map() });
        sinon.assert.notCalled(uninstallComponentStub);
        sinon.assert.notCalled(installComponent);
        expect(denyPortsStub.called, 'its ports do not move').to.be.false;
        expect(openHostPortsStub.called).to.be.false;
      });

      it('stops nothing through the daemon, whose plan stays under the app\'s identity', async () => {
        await adoptSale({ graceful: true });

        sinon.assert.notCalled(fluxShutdowndClient.beginAppStop);
        sinon.assert.notCalled(uninstallComponentStub);
        sinon.assert.calledOnce(fluxShutdowndClient.upsertAppPlanBestEffort);
        const [plan] = fluxShutdowndClient.upsertAppPlanBestEffort.firstCall.args;
        expect(plan).to.include({ identity: IDENTITY, replica: null });
        expect(plan, 'the plan names no owner').to.not.have.property('owner_flux_id');
        sinon.assert.notCalled(fluxShutdowndClient.deleteAppPlanBestEffort);
      });
    });

    // The resources name each component's ports before any is opened: a kept
    // port keeps the methods it was opened by, an added one takes the methods
    // the node opens ports by now.
    it('records each component\'s ports with their methods before opening the added ones', async () => {
      setup();
      instanceResources.byInstance.resolves(resourcesNaming([80, 443]));
      const oldDeployment = await makeDeployment({ hostPorts: [80, 443], storage: 5 });
      const newDeployment = await makeDeployment({ hostPorts: [443, 8080], storage: 10 });

      await appOperations.reconcileComponents('myapp', oldDeployment, newDeployment, registrySpec, namingOf(newDeployment));

      sinon.assert.calledOnceWithExactly(instanceResources.byInstance, 'myapp', null);
      sinon.assert.calledOnceWithExactly(instanceResources.setComponent, 'myapp', null, 'web', 'hostPorts', [
        { port: 443, opened: ['ufw', 'upnp'] }, { port: 8080, opened: ['ufw'] },
      ]);
      expect(instanceResources.setComponent.calledBefore(openHostPortsStub), 'recorded before opened').to.equal(true);
      sinon.assert.calledOnceWithExactly(openHostPortsStub, [8080], 'myapp', ['ufw']);
      sinon.assert.notCalled(instanceResources.removeComponent);
    });

    it('records an instance\'s ports as newly opened when it has no resources to carry them from', async () => {
      setup();
      const oldDeployment = await makeDeployment({ hostPorts: [80], storage: 5 });
      const newDeployment = await makeDeployment({ hostPorts: [80, 81], storage: 5 });

      await appOperations.reconcileComponents('myapp', oldDeployment, newDeployment, registrySpec, namingOf(newDeployment));

      sinon.assert.calledOnceWithExactly(instanceResources.setComponent, 'myapp', null, 'web', 'hostPorts', [
        { port: 80, opened: ['ufw'] }, { port: 81, opened: ['ufw'] },
      ]);
    });

    it('drops the block of a component the new spec removes, once it is torn down', async () => {
      setup();
      const both = deploymentFor(await specWithComponents('myapp', {
        web: { ports: { p80: { containerPort: 80, hostPort: 80 } } },
        db: { ports: { p81: { containerPort: 81, hostPort: 81 } } },
      }));
      const webOnly = deploymentFor(await specWithComponents('myapp', {
        web: { ports: { p80: { containerPort: 80, hostPort: 80 } } },
      }));

      await appOperations.reconcileComponents('myapp', both, webOnly, registrySpec, namingOf(webOnly));

      sinon.assert.calledOnceWithExactly(instanceResources.removeComponent, 'myapp', null, 'db');
      const dbTeardown = uninstallComponentStub.getCalls().find((c) => c.args[0].name === 'db');
      expect(dbTeardown, 'the leaving component was torn down').to.not.equal(undefined);
      expect(instanceResources.removeComponent.firstCall.calledAfter(dbTeardown), 'the block goes once the component has').to.equal(true);
      expect(instanceResources.setComponent.getCalls().map((c) => c.args[2]), 'only the components that remain have ports recorded').to.deep.equal(['web']);
    });

    it('skips the port-open (but still closes) when a cancel teardown is owed', async () => {
      setup({ teardownOwed: true });
      instanceResources.byInstance.resolves(resourcesNaming([80, 443]));
      const oldDeployment = await makeDeployment({ hostPorts: [80, 443], storage: 5 });
      const newDeployment = await makeDeployment({ hostPorts: [443, 8080], storage: 10 });

      await appOperations.reconcileComponents('myapp', oldDeployment, newDeployment, registrySpec, namingOf(newDeployment));

      expect(teardownOwedForStub.calledWith('myapp')).to.be.true;
      expect(openHostPortsStub.called, 'a raced cancel must skip the port-open (no orphaned rules)').to.be.false;
      expect(denyPortsStub.calledOnceWith([{ port: 80, opened: ['ufw', 'upnp'] }], 'myapp'), 'closing removed ports is always safe and still runs').to.be.true;
    });

    // Components are matched by their keys: a component keeps its key across a
    // rename, and a name dropped and declared again is a new component.
    describe('components matched by key', () => {
      const KEY = `c${'k'.repeat(52)}`;
      const OTHER_KEY = `c${'q'.repeat(52)}`;
      let installComponent;

      const keyed = (name, key, overrides = {}) => oneComponentDeployment('myapp', name, { ports: { p80: { containerPort: 80, hostPort: 80 } }, ...overrides }, {
        identity: IDENTITY, componentKeys: new Map([[name, key]]),
      });

      beforeEach(() => {
        setup();
        installComponent = sinon.stub(componentProvisioner, 'installComponent').resolves();
        const { InstanceResources } = specLibrary.loaded();
        instanceResources.byInstance.resolves(new InstanceResources({
          name: 'myapp',
          components: {
            [KEY]: {
              ...InstanceResources.newBlock({ identifier: `${KEY}_${IDENTITY}`, image: 'img' }),
              hostPorts: [{ port: 80, opened: ['ufw', 'upnp'] }],
            },
          },
        }));
      });

      it('recreates a renamed component under its new name on the volume it had, its resources block kept', async () => {
        const oldDeployment = await keyed('web', KEY);
        const newDeployment = await keyed('site', KEY);
        deploymentProvider.planDeployment.resolves(newDeployment);

        await appOperations.reconcileComponents('myapp', oldDeployment, newDeployment, registrySpec, namingOf(newDeployment));

        sinon.assert.calledOnce(uninstallComponentStub);
        const [torn, tornOpts] = uninstallComponentStub.firstCall.args;
        expect(torn.name).to.equal('web');
        expect(tornOpts.removeVolumes, 'a rename keeps the volume').to.equal(false);
        sinon.assert.notCalled(instanceResources.removeComponent);

        sinon.assert.calledOnce(installComponent);
        const [made, madeOpts] = installComponent.firstCall.args;
        expect(made.name).to.equal('site');
        expect(made.identifier).to.equal(`${KEY}_${IDENTITY}`);
        expect(madeOpts.createVolumes).to.equal(false);

        // Its ports carry the methods they were opened with, by its key.
        sinon.assert.calledWithExactly(instanceResources.setComponent, 'myapp', null, KEY, 'hostPorts', [{ port: 80, opened: ['ufw', 'upnp'] }]);
        expect(denyPortsStub.called, 'a rename moves no port').to.be.false;
        expect(openHostPortsStub.called).to.be.false;
      });

      it('records the new name\'s aliases for a renamed component before its container is made', async () => {
        const oldDeployment = await keyed('web', KEY);
        const newDeployment = await keyed('site', KEY);
        deploymentProvider.planDeployment.resolves(newDeployment);

        await appOperations.reconcileComponents('myapp', oldDeployment, newDeployment, registrySpec, namingOf(newDeployment));

        const derived = deploymentProvider.planDeployment.getCalls().find((call) => call.args[1].recordedNames === false);
        expect(derived, 'the new name\'s aliases are derived, not read from the resources').to.not.equal(undefined);
        expect(derived.args[1].componentKeys).to.deep.equal(keysOf(newDeployment));
        const aliases = instanceResources.setComponent.getCalls().find((call) => call.args[3] === 'aliases');
        expect(aliases.args).to.deep.equal(['myapp', null, KEY, 'aliases', newDeployment.getComponent('site').networkAliases]);
        expect(aliases.calledBefore(installComponent.firstCall)).to.equal(true);
        expect(newDeployment.getComponent('site').networkAliases).to.include('site');
      });

      it('writes no aliases when nothing is renamed', async () => {
        const oldDeployment = await keyed('web', KEY);
        const newDeployment = await keyed('web', KEY, { cpu: 0.7 });
        deploymentProvider.planDeployment.resolves(newDeployment);

        await appOperations.reconcileComponents('myapp', oldDeployment, newDeployment, registrySpec, namingOf(newDeployment));

        sinon.assert.calledOnce(installComponent);
        expect(instanceResources.setComponent.getCalls().some((call) => call.args[3] === 'aliases')).to.equal(false);
        sinon.assert.alwaysCalledWith(deploymentProvider.planDeployment, registrySpec, sinon.match((opts) => opts.recordedNames === undefined));
      });

      it('removes a component whose name is declared again under a new key, with its volume and block, and installs the new one empty', async () => {
        const oldDeployment = await keyed('web', KEY);
        const newDeployment = await keyed('web', OTHER_KEY);
        deploymentProvider.planDeployment.resolves(newDeployment);

        await appOperations.reconcileComponents('myapp', oldDeployment, newDeployment, registrySpec, namingOf(newDeployment));

        sinon.assert.calledOnce(uninstallComponentStub);
        const [torn, tornOpts] = uninstallComponentStub.firstCall.args;
        expect(torn.identifier).to.equal(`${KEY}_${IDENTITY}`);
        expect(tornOpts.removeVolumes).to.equal(true);
        sinon.assert.calledOnceWithExactly(instanceResources.removeComponent, 'myapp', null, KEY);

        sinon.assert.calledOnce(installComponent);
        const [made, madeOpts] = installComponent.firstCall.args;
        expect(made.identifier).to.equal(`${OTHER_KEY}_${IDENTITY}`);
        expect(madeOpts.createVolumes).to.equal(true);
      });
    });
  });

  describe('isElectedPrimaryHere', () => {
    const NOW = 1_800_000_000_000;
    const LOCAL = '10.0.0.1:16127';
    const records = (entries) => ({
      primaries: new Map(entries.map(([identifier, ip]) => [identifier, ip])),
      checkedAt: new Map(entries.map(([identifier, , at = NOW]) => [identifier, at])),
    });

    it('answers by the identifiers it is given, whatever the app is named', () => {
      const held = records([['web_bcccccccccccccccccccccccccccccccccccccccccccccccccccc', '10.0.0.1:16127'], ['web_other', '10.0.0.9:16127']]);

      expect(appOperations.isElectedPrimaryHere(['web_bcccccccccccccccccccccccccccccccccccccccccccccccccccc'], LOCAL, NOW, held)).to.equal(true);
      expect(appOperations.isElectedPrimaryHere(['web_other'], LOCAL, NOW, held)).to.equal(false);
    });

    it('matches a replica\'s identifier exactly', () => {
      const held = records([['web_bcccccccccccccccccccccccccccccccccccccccccccccccccccc_s1', '10.0.0.1:16127']]);

      expect(appOperations.isElectedPrimaryHere(['web_bcccccccccccccccccccccccccccccccccccccccccccccccccccc_s1'], LOCAL, NOW, held)).to.equal(true);
      expect(appOperations.isElectedPrimaryHere(['web_bcccccccccccccccccccccccccccccccccccccccccccccccccccc'], LOCAL, NOW, held)).to.equal(null);
    });

    it('cannot say when no record of the identifiers is recent', () => {
      const held = records([['web_bcccccccccccccccccccccccccccccccccccccccccccccccccccc', '10.0.0.1:16127', NOW - 60 * 60 * 1000]]);

      expect(appOperations.isElectedPrimaryHere(['web_bcccccccccccccccccccccccccccccccccccccccccccccccccccc'], LOCAL, NOW, held)).to.equal(null);
      expect(appOperations.isElectedPrimaryHere([], LOCAL, NOW, held)).to.equal(null);
    });
  });

  describe('runRestoreTask rules', () => {

    let reported;
    let InstanceResources;
    beforeEach(() => {
      reported = [];
      ({ InstanceResources } = specLibrary.loaded());
    });
    const runRestore = (appName, restore, type, opts) => appOperations
      .runRestoreTask(appName, restore, type, 'auth', (line) => reported.push(String(line)), opts)
      .then(() => null, (error) => error);

    /** Everything a restore reads and drives, with a whole readable archive on every volume. */
    async function restoreStubs(appName, deployment) {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(deployment);
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(deployment);
      stubHostedInstances().byName.resolves(installedRecord(await registeredSpec(await v9Spec({ name: appName }))));
      const drive = sinon.stub(appReconciler, 'drive').resolves({ converged: true, failed: [] });
      sinon.stub(appReconciler, 'observedContainerState').resolves({
        reachable: true, exists: true, running: false, indeterminate: false,
      });
      sinon.stub(serviceHelper, 'delay').resolves();
      sinon.stub(volumeService, 'listComponentVolumeMounts').callsFake(async (app, comp) => [
        { replica: null, mount: `/vol/${comp}`, identifier: `${comp}_${app}` },
      ]);
      const restoreAppData = sinon.stub(appDataEntries, 'restoreAppData').resolves({ status: true });
      const inspect = sinon.stub(IOUtils, 'inspectTarGz').resolves({ status: true, entries: 3, bytes: 300 });
      const removeFile = sinon.stub(IOUtils, 'removeFile').resolves();
      const pause = sinon.stub(syncthingMonitorHelpers, 'setSyncthingFolderPaused').resolves('held');
      const peers = sinon.stub(globalCommand, 'executeAppGlobalCommand').resolves();
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('10.0.0.1:16127');
      // What the node recorded when it installed the app: a block per component,
      // a synced one with the folder its data is shared under.
      const { instanceResources } = await inMemoryInstanceResources();
      await instanceResources.put(new InstanceResources({
        name: appName,
        components: Object.fromEntries(deployment.componentEntries().map(([name, comp]) => [name, InstanceResources.newBlock({
          identifier: `${name}_${appName}`,
          image: 'img',
          syncFolder: comp.hasSyncthing() ? { id: comp.syncFolderId, path: `/apps/${name}_${appName}` } : null,
        })])),
      }));
      return {
        drive, restoreAppData, inspect, removeFile, pause, peers, instanceResources,
      };
    }

    /** The resources of an instance whose one synced component shares its data under a folder id. */
    const resourcesSharing = (appName, replica, identifier, folderId) => new InstanceResources({
      name: appName,
      replica,
      components: { web: InstanceResources.newBlock({ identifier, image: 'img', syncFolder: { id: folderId, path: `/apps/${identifier}` } }) },
    });
    // Each component on its own host port, as the spec requires of siblings.
    const syncedApp = async (appName, modes, depOpts = {}) => deploymentFor(await specWithComponents(appName, Object.fromEntries(
      Object.entries(modes).map(([name, mode], i) => [name, {
        ports: { http: { containerPort: 8080, hostPort: 31_000 + i } },
        persistentStorage: {
          sizeGb: 5,
          mounts: { '/data': { source: 'data', destination: '/data' } },
          sync: { mode },
        },
      }]),
    )), depOpts);

    it('refuses a component the app does not have before holding or stopping anything', async () => {
      const { drive, pause } = await restoreStubs('myapp', await oneComponentDeployment('myapp', 'web'));

      const failure = await runRestore('myapp', [{ component: 'nope', restore: true }], 'local');

      expect(failure?.message).to.match(/Refused: nope is not a component of myapp/);
      sinon.assert.notCalled(pause);
      sinon.assert.notCalled(drive);
    });

    // The v1 API addresses a flat app's one component as 'null', and the archive
    // backup wrote for it is named so.
    it("restores a legacy app's one component addressed as 'null'", async () => {
      const { inspect } = await restoreStubs('legacyapp', deploymentFor(await domain.v3Spec()));

      const failure = await runRestore('legacyapp', [{ component: 'null', restore: true }], 'local');

      expect(failure, `the restore must complete: ${failure?.message}`).to.equal(null);
      expect(inspect.firstCall.args[0]).to.equal('/vol/null/backup/local/backup_null.tar.gz');
    });

    it("restores a component named 'null' as itself", async () => {
      await restoreStubs('myapp', await oneComponentDeployment('myapp', 'null'));

      const failure = await runRestore('myapp', [{ component: 'null', restore: true }], 'local');

      expect(failure, `the restore must complete: ${failure?.message}`).to.equal(null);
    });

    describe('the local archive of a renamed component', () => {
      const KEY = `c${'k'.repeat(51)}a`;
      const archive = (name) => `/vol/site/backup/local/backup_${name}.tar.gz`;

      /** A restore of `site`, which held `formerNames` before, with archives on its volume under `present`. */
      async function restoreSite(formerNames, present, type = 'local') {
        const stubs = await restoreStubs('myapp', await oneComponentDeployment('myapp', 'site'));
        stubHostedInstances().byReplica.resolves(installedRecord(await registeredSpec(await v9Spec({ name: 'myapp' })), {
          componentKeys: new Map([['site', KEY]]),
          formerNames: formerNames.length ? new Map([[KEY, formerNames]]) : new Map(),
        }));
        sinon.stub(IOUtils, 'checkFileExists').callsFake(async (file) => present.map(archive).includes(file));
        const failure = await runRestore('myapp', [{ component: 'site', restore: true }], type);
        expect(failure, `the restore must complete: ${failure?.message}`).to.equal(null);
        return stubs;
      }

      it('restores from the archive taken under its former name', async () => {
        const { inspect, restoreAppData } = await restoreSite(['web'], ['web']);
        expect(inspect.firstCall.args[0]).to.equal(archive('web'));
        expect(restoreAppData.firstCall.args[1]).to.equal(archive('web'));
      });

      it('prefers the archive under its current name', async () => {
        const { inspect } = await restoreSite(['web'], ['web', 'site']);
        expect(inspect.firstCall.args[0]).to.equal(archive('site'));
      });

      it('takes the most recent former name that has an archive', async () => {
        expect((await restoreSite(['web', 'www'], ['web', 'www'])).inspect.firstCall.args[0]).to.equal(archive('www'));
        sinon.restore();
        expect((await restoreSite(['web', 'www'], ['web'])).inspect.firstCall.args[0]).to.equal(archive('web'));
      });

      it('reads no archive under a name the component never held', async () => {
        const { inspect } = await restoreSite([], ['web']);
        expect(inspect.firstCall.args[0]).to.equal(archive('site'));
      });

      it('reads an uploaded archive under the current name only', async () => {
        const { inspect } = await restoreSite(['web'], ['web'], 'upload');
        expect(inspect.firstCall.args[0]).to.equal('/vol/site/backup/upload/backup_site.tar.gz');
      });
    });

    it('refuses a restore on a node that is not the live copy of an active-standby component', async () => {
      const { drive, pause } = await restoreStubs('bkapp', await syncedApp('bkapp', { web: 'activeStandby' }));
      sinon.stub(serviceHelper, 'axiosGet').resolves({ data: { status: 'success', data: { ips: ['203.0.113.9'] } } });

      const failure = await runRestore('bkapp', [{ component: 'web', restore: true }], 'local');

      expect(failure?.message).to.match(/Refused: restore on 203\.0\.113\.9, it holds the live copy/);
      sinon.assert.notCalled(pause);
      sinon.assert.notCalled(drive);
    });

    it('proceeds when the election cannot answer, as an election does', async () => {
      const { drive } = await restoreStubs('bkapp', await syncedApp('bkapp', { web: 'activeStandby' }));
      sinon.stub(serviceHelper, 'axiosGet').rejects(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));

      const failure = await runRestore('bkapp', [{ component: 'web', restore: true }], 'local');

      expect(failure, `the restore must proceed: ${failure?.message}`).to.equal(null);
      expect(drive.calledWith(['web_bkapp'], 'stopped')).to.be.true;
    });

    it('reads every archive before clearing any appdata, and refuses an unreadable one with the data intact', async () => {
      const { drive, inspect, restoreAppData } = await restoreStubs('myapp', await oneComponentDeployment('myapp', 'web'));
      inspect.resolves({ status: false, error: 'not in gzip format' });

      const failure = await runRestore('myapp', [{ component: 'web', restore: true }], 'local');

      expect(failure?.message).to.match(/archive for web is unreadable, not in gzip format/);
      sinon.assert.notCalled(restoreAppData);
      expect(drive.calledWith(['web_myapp'], 'running'), 'the untouched app is started again').to.be.true;
    });

    it('holds still only the folders of the components named', async () => {
      const { pause } = await restoreStubs('bkapp', await syncedApp('bkapp', { web: 'syncFirst', worker: 'syncFirst' }));

      const failure = await runRestore('bkapp', [{ component: 'web', restore: true }, { component: 'worker', restore: false }], 'local');

      expect(failure, `the restore must complete: ${failure?.message}`).to.equal(null);
      const held = pause.getCalls().filter((call) => call.args[1] === true).map((call) => call.args[0]);
      expect(held).to.deep.equal(['web_bkapp']);
    });

    // The folder a restored volume is shared under is the one the installed
    // resources record for the volume's component, replica by replica.
    it('marks the restored synced folder of a named replica by the folder id the resources record for it', async () => {
      const { instanceResources } = await restoreStubs('bkapp', await syncedApp('bkapp', { web: 'syncFirst' }));
      volumeService.listComponentVolumeMounts.callsFake(async (app, comp) => [
        { replica: 's1', mount: `/vol/${comp}`, identifier: `${comp}_bident_s1` },
      ]);
      await instanceResources.put(resourcesSharing('bkapp', 's1', 'web_bident_s1', 'web_bident_s1'));
      const setSyncedMark = sinon.stub(appCaches, 'setSyncedMark').resolves();

      const failure = await runRestore('bkapp', [{ component: 'web', restore: true }], 'local');

      expect(failure, `the restore must complete: ${failure?.message}`).to.equal(null);
      const marked = setSyncedMark.getCalls().filter((call) => call.args[2]?.restarted === true).map((call) => call.args[1]);
      expect(marked).to.deep.equal(['web_bident_s1']);
    });

    it('holds and marks the restored synced folder of an app registered before v9 by its 8.x folder id, not by its directory\'s name', async () => {
      const { instanceResources, pause } = await restoreStubs('bkapp', await syncedApp('bkapp', { web: 'syncFirst' }, { registrationVersion: 8 }));
      volumeService.listComponentVolumeMounts.callsFake(async (app, comp) => [
        { replica: null, mount: `/vol/${comp}`, identifier: `${comp}_bident` },
      ]);
      await instanceResources.put(resourcesSharing('bkapp', null, 'web_bident', 'fluxweb_bkapp'));
      const setSyncedMark = sinon.stub(appCaches, 'setSyncedMark').resolves();

      const failure = await runRestore('bkapp', [{ component: 'web', restore: true }], 'local');

      expect(failure, `the restore must complete: ${failure?.message}`).to.equal(null);
      expect(pause.getCalls().map((call) => call.args.slice(0, 2))).to.deep.equal([['fluxweb_bkapp', true], ['fluxweb_bkapp', false]]);
      const marked = setSyncedMark.getCalls().filter((call) => call.args[2]?.restarted === true).map((call) => call.args[1]);
      expect(marked).to.deep.equal(['fluxweb_bkapp']);
    });

    it('refuses to clear a synced volume whose folder the resources do not record, with its data intact', async () => {
      const { instanceResources, restoreAppData } = await restoreStubs('bkapp', await syncedApp('bkapp', { web: 'syncFirst' }));
      await instanceResources.remove('bkapp', null);

      const failure = await runRestore('bkapp', [{ component: 'web', restore: true }], 'local');

      expect(failure?.message).to.match(/Refused: no syncthing folder is recorded for web_bkapp/);
      sinon.assert.notCalled(restoreAppData);
    });

    // A clear that fails on a synced component leaves a directory that is
    // neither copy, shared with every peer: its folder is demoted so the peers
    // are never offered it. For an app registered before v9 the folder's id is
    // the 8.x name and its directory is named by the identifier.
    it('demotes the folder of a half-cleared synced component by the id the resources record, and holds it stopped', async () => {
      const { instanceResources, restoreAppData } = await restoreStubs('bkapp', await syncedApp('bkapp', { web: 'syncFirst' }));
      volumeService.listComponentVolumeMounts.callsFake(async (app, comp) => [
        { replica: null, mount: `/vol/${comp}`, identifier: `${comp}_bident` },
      ]);
      await instanceResources.put(resourcesSharing('bkapp', null, 'web_bident', 'fluxweb_bkapp'));
      restoreAppData.resolves({ status: false, error: 'could not clear /vol/web before unpacking' });
      sinon.stub(syncthingService, 'getConfigFolders').resolves([
        { id: 'fluxweb_bkapp', path: `${appsFolder}web_bident`, type: 'sendreceive' },
        // Another folder whose directory is named as the first one's id is.
        { id: 'other', path: `${appsFolder}fluxweb_bkapp`, type: 'sendreceive' },
      ]);
      const adjust = sinon.stub(syncthingService, 'adjustConfigFolders').resolves();
      const setSyncedMark = sinon.stub(appCaches, 'setSyncedMark').resolves();
      const hold = sinon.stub(appReconciler, 'setControllerDesired');

      const failure = await runRestore('bkapp', [{ component: 'web', restore: true }], 'local');

      expect(failure?.message).to.match(/could not clear/);
      sinon.assert.calledOnceWithExactly(adjust, { method: 'patch', config: { type: 'receiveonly' }, id: 'fluxweb_bkapp' });
      sinon.assert.calledOnceWithExactly(setSyncedMark, sinon.match.any, 'fluxweb_bkapp', { restarted: false, numberOfExecutions: 0 });
      sinon.assert.calledWith(hold, 'web_bident', 'stopped');
    });

    it('restarts the peers of a component every instance runs, and never redeploys them', async () => {
      const { peers } = await restoreStubs('bkapp', await syncedApp('bkapp', { web: 'syncFirst' }));

      const failure = await runRestore('bkapp', [{ component: 'web', restore: true }], 'local');

      expect(failure, `the restore must complete: ${failure?.message}`).to.equal(null);
      sinon.assert.calledOnce(peers);
      expect(peers.firstCall.args[1]).to.equal('apprestart');
      expect(peers.getCalls().some((call) => call.args[1] === 'redeploy')).to.equal(false);
    });

    it('disturbs no peer for an active-standby component', async () => {
      const { peers } = await restoreStubs('bkapp', await syncedApp('bkapp', { web: 'activeStandby' }));

      const failure = await runRestore('bkapp', [{ component: 'web', restore: true }], 'local', { force: true });

      expect(failure, `the restore must complete: ${failure?.message}`).to.equal(null);
      sinon.assert.notCalled(peers);
    });

    it('refuses a download that stops short of what was promised, before clearing appdata', async () => {
      const { drive, restoreAppData } = await restoreStubs('myapp', await oneComponentDeployment('myapp', 'web'));
      sinon.stub(IOUtils, 'removeDirectory').resolves(true);
      sinon.stub(IOUtils, 'downloadFileFromUrl').resolves(true);
      sinon.stub(IOUtils, 'getRemoteFileSize').resolves(1000);
      sinon.stub(IOUtils, 'getFileSize').resolves(400);

      const failure = await runRestore('myapp', [{ component: 'web', restore: true, url: 'https://example.test/a.tar.gz' }], 'remote');

      expect(failure?.message).to.match(/download incomplete, got 400 of 1000 bytes/);
      sinon.assert.notCalled(restoreAppData);
      expect(drive.calledWith(['web_myapp'], 'running'), 'the untouched app is started again').to.be.true;
    });

    it('keeps a local archive, and removes only the copy it downloaded', async () => {
      const { removeFile } = await restoreStubs('myapp', await oneComponentDeployment('myapp', 'web'));
      const kept = await runRestore('myapp', [{ component: 'web', restore: true }], 'local');
      expect(kept, `the restore must complete: ${kept?.message}`).to.equal(null);
      sinon.assert.notCalled(removeFile);

      sinon.stub(IOUtils, 'removeDirectory').resolves(true);
      sinon.stub(IOUtils, 'downloadFileFromUrl').resolves(true);
      sinon.stub(IOUtils, 'getRemoteFileSize').resolves(1000);
      sinon.stub(IOUtils, 'getFileSize').resolves(1000);
      const fetched = await runRestore('myapp', [{ component: 'web', restore: true, url: 'https://example.test/a.tar.gz' }], 'remote');
      expect(fetched, `the restore must complete: ${fetched?.message}`).to.equal(null);
      expect(removeFile.calledOnceWith('/vol/web/backup/remote/backup_web.tar.gz')).to.be.true;
    });
  });

  describe('runRestoreTask hold on a failed clear', () => {

    // A clear that fails leaves the directory neither copy: the component is
    // held stopped rather than started on it, and the caller is told why.
    it('holds the component whose data could not be cleared, in those words', async () => {
      const deployment = await oneComponentDeployment('myapp', 'web');
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(deployment);
      stubHostedInstances().byName.resolves(installedRecord(await registeredSpec(await v9Spec({ name: 'myapp' }))));
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(deployment);
      const drive = sinon.stub(appReconciler, 'drive').resolves({ converged: true, failed: [] });
      sinon.stub(appReconciler, 'observedContainerState').resolves({
        reachable: true, exists: true, running: false, indeterminate: false,
      });
      const hold = sinon.stub(appReconciler, 'setControllerDesired');
      sinon.stub(serviceHelper, 'delay').resolves();
      sinon.stub(volumeService, 'listComponentVolumeMounts').resolves([{ replica: null, mount: '/vol', identifier: 'web_myapp' }]);
      sinon.stub(IOUtils, 'inspectTarGz').resolves({ status: true, entries: 3, bytes: 300 });
      sinon.stub(appDataEntries, 'restoreAppData').resolves({ status: false, error: 'could not clear /vol before unpacking: Device or resource busy' });
      const reported = [];

      let failure = null;
      try {
        await appOperations.runRestoreTask('myapp', [{ component: 'web', restore: true }], 'local', 'auth', (line) => reported.push(String(line)));
      } catch (error) {
        failure = error;
      }

      expect(failure?.message, 'the caller is told the clear failed').to.match(/could not clear/i);
      expect(hold.calledWith('web_myapp', 'stopped'), 'the half-cleared component is held stopped').to.be.true;
      const startedAgain = drive.getCalls().some((c) => c.args[1] === 'running' && c.args[0].includes('web_myapp'));
      expect(startedAgain, 'a component whose appdata is neither copy was started').to.equal(false);
    });
  });

  describe('appendBackupTask validation', () => {
    it('refuses a backup that is not a list of components, in those words', async () => {
      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      const req = { body: { appname: 'myapp', backup: 'web' }, headers: {} };
      const res = { json: sinon.stub(), status: sinon.stub().returnsThis(), setHeader: sinon.stub() };

      await appOperations.appendBackupTask(req, res);

      expect(res.json.calledOnce).to.be.true;
      const response = res.json.firstCall.args[0];
      expect(response.status).to.equal('error');
      expect(response.data.message).to.equal('backup must be a list of components');
    });
  });

  describe('appendBackupTask hold unwind', () => {
    // The archive itself, which is what these assert. The endpoint's half is the
    // validation, the privilege check and the 202; the work runs past both.
    let reported = [];
    const runBackup = (request) => appOperations.runBackupTask(
      request.body.appname,
      request.body.backup,
      request.body.force === true || request.body.force === 'true',
      (line) => reported.push(String(line)),
    ).then(() => true, (error) => {
      reported.push(String(error.message));
      return false;
    });
    beforeEach(() => { reported = []; });

    /**
     * What the completeness gate reads. A backup is refused unless this instance
     * holds a whole copy, so any synced-component case has to say which it is.
     */
    const copyIs = (complete) => sinon.stub(syncthingFolderStateMachine, 'probeFolderSyncCompletion').resolves(
      complete
        ? { status: { isSynced: true, globalBytes: 100, inSyncBytes: 100, syncPercentage: 100 }, reason: 'ok' }
        : { status: { isSynced: false, globalBytes: 100, inSyncBytes: 40, syncPercentage: 40 }, reason: 'ok' },
    );

    it('holds and gives back the synced component\'s folder by the id the resources record, never by its directory\'s name', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      // An app registered before v9: the folder id is the 8.x name while the
      // directory is the component's identifier, so the two cannot be confused.
      // Real components: `web` declares sync, `worker` does not — hasSyncthing()
      // is derived from persistentStorage.sync, never set independently.
      const composed = deploymentFor(await specWithComponents('bkapp', {
        web: {
          persistentStorage: {
            sizeGb: 5,
            mounts: { '/data': { source: 'data', destination: '/data' } },
            sync: { mode: 'sync' },
          },
        },
        worker: { ports: { rpc: { containerPort: 9000, hostPort: 31_001 } } },
      }), { registrationVersion: 8 });
      expect(composed.getComponent('web').hasSyncthing()).to.be.true;
      expect(composed.getComponent('web').syncFolderId, 'the premise: an id that is not the directory').to.equal('fluxweb_bkapp');
      expect(composed.getComponent('worker').hasSyncthing()).to.be.false;
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(composed);
      copyIs(true);
      const pauseFolder = sinon.stub(syncthingMonitorHelpers, 'setSyncthingFolderPaused').resolves('held');
      stubHostedInstances().byName.resolves(installedRecord(await registeredSpec(await v9Spec({ name: 'bkapp' }))));
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(composed);
      sinon.stub(appReconciler, 'drive').resolves({ converged: true, failed: [] });
      // The stop is proved against docker, not against the drive's verdict: the
      // converge backstop answers 'provisional' and that is not counted, so
      // `converged` is true of a container nobody has looked at.
      sinon.stub(appReconciler, 'observedContainerState').resolves({
        reachable: true, exists: true, running: false, indeterminate: false,
      });
      sinon.stub(volumeService, 'listComponentVolumeMounts').resolves([{ replica: null, mount: '/vol' }]);
      sinon.stub(IOUtils, 'checkFileExists').resolves(false);
      sinon.stub(IOUtils, 'removeFile').resolves();
      sinon.stub(appDataEntries, 'archiveAppData').resolves({ status: false, error: 'No space left on device' });

      const req = { body: { appname: 'bkapp', backup: [{ component: 'web', backup: true }] } };
      const pending = runBackup(req);
      await clock.tickAsync(120_000);
      await pending;
      clock.restore();

      expect(pauseFolder.calledWith('fluxweb_bkapp', true), 'the synced component folder must be paused by its id').to.be.true;
      expect(pauseFolder.calledWith('web_bkapp', true), 'never by its directory\'s name').to.be.false;
      expect(pauseFolder.calledWith('fluxworker_bkapp', true), 'unsynced components must be untouched').to.be.false;
      // This backup FAILED - archiveAppData answers ENOSPC above - and the folder is
      // still given back. Pausing without this would be worse than the removal it
      // replaced, because nothing else would ever resume it.
      expect(pauseFolder.calledWith('fluxweb_bkapp', false), 'a failed backup must resume what it paused').to.be.true;
    });

    // The completeness gate reads the deployment's synced components. The
    // provider answers null both for an app that is not installed and for one
    // whose deployment could not be BUILT, and reading either as "no synced
    // components" is what turned the gate off without saying so - archiving
    // whatever was on disk in the one case where least is known about the app.
    // On Arcane the reconciler hands the stop to flux-shutdownd and its drive
    // settles at the hand-off, while the daemon is still draining the app. The
    // backup reads the containers only once the app's stopping gate has lifted.
    it('waits out a flux-shutdownd drain before reading the containers', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      const deployment = await oneComponentDeployment('bkapp', 'comp1');
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(deployment);
      stubHostedInstances().byName.resolves(installedRecord(await registeredSpec(await v9Spec({ name: 'bkapp' }))));
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(deployment);
      const drive = sinon.stub(appReconciler, 'drive').resolves({ converged: true, failed: [] });
      // The gate stands for two reads, and the container is up for exactly as long.
      const gate = sinon.stub(globalState, 'getAppShutdownPipelineState');
      gate.onCall(0).returns('stopping');
      gate.onCall(1).returns('stopping');
      gate.returns(null);
      const observed = sinon.stub(appReconciler, 'observedContainerState');
      observed.callsFake(async () => ({
        reachable: true, exists: true, running: gate.callCount < 3, indeterminate: false,
      }));
      sinon.stub(volumeService, 'listComponentVolumeMounts').resolves([{ replica: null, mount: '/vol' }]);
      sinon.stub(IOUtils, 'checkFileExists').resolves(false);
      sinon.stub(IOUtils, 'removeFile').resolves();
      const archiveAppData = sinon.stub(appDataEntries, 'archiveAppData').resolves({ status: true });

      const req = { body: { appname: 'bkapp', backup: [{ component: 'comp1', backup: true }] } };
      const pending = runBackup(req);
      await clock.tickAsync(120_000);
      const result = await pending;
      clock.restore();

      expect(result, 'the backup must run once the drain has finished').to.be.true;
      sinon.assert.calledOnce(archiveAppData);
      expect(drive.calledWith(['comp1_bkapp'], 'stopped')).to.be.true;
      expect(drive.calledWith(['comp1_bkapp'], 'running'), 'the hold is given back after the archive').to.be.true;
    });

    it('refuses a backup it cannot resolve a deployment for, before stopping anything', async () => {
      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      const stopped = sinon.stub(appReconciler, 'setControllerDesired').resolves();
      // What a failed BUILD looks like from here: indistinguishable from absent.
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(null);
      const pauseFolder = sinon.stub(syncthingMonitorHelpers, 'setSyncthingFolderPaused').resolves('held');
      const tar = sinon.stub(appDataEntries, 'archiveAppData').resolves({ status: true });

      const req = { body: { appname: 'bkapp', backup: [{ component: 'web', backup: true }] } };
      const ok = await runBackup(req);

      expect(ok, 'the backup must refuse').to.be.false;
      expect(reported.join(' ')).to.include('no deployment could be resolved');
      // A refusal must not cost a healthy app an outage, and must not archive.
      sinon.assert.notCalled(tar);
      sinon.assert.notCalled(pauseFolder);
      sinon.assert.notCalled(stopped);
    });

    describe('an incomplete copy is not archived', () => {
      /**
       * A synced app whose whole path to the archive is clear, so the ONLY thing
       * that can refuse is the completeness gate.
       */
      async function backupSyncedApp({ probe, force }) {
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
        sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
        const composed = deploymentFor(await specWithComponents('bkapp', {
          web: {
            persistentStorage: {
              sizeGb: 5,
              mounts: { '/data': { source: 'data', destination: '/data' } },
              sync: { mode: 'sync' },
            },
          },
        }));
        sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(composed);
        stubHostedInstances().byName.resolves(installedRecord(await registeredSpec(await v9Spec({ name: 'bkapp' }))));
        sinon.stub(deploymentProvider, 'buildDeployment').resolves(composed);
        sinon.stub(syncthingFolderStateMachine, 'probeFolderSyncCompletion').resolves(probe);
        sinon.stub(syncthingMonitorHelpers, 'setSyncthingFolderPaused').resolves('held');
        sinon.stub(appReconciler, 'drive').resolves({ converged: true, failed: [] });
        // The stop is proved against docker, not against the drive's verdict: the
        // converge backstop answers 'provisional' and that is not counted, so
        // `converged` is true of a container nobody has looked at.
        sinon.stub(appReconciler, 'observedContainerState').resolves({
          reachable: true, exists: true, running: false, indeterminate: false,
        });
        sinon.stub(volumeService, 'listComponentVolumeMounts').resolves([{ replica: null, mount: '/vol' }]);
        sinon.stub(IOUtils, 'checkFileExists').resolves(false);
        sinon.stub(IOUtils, 'removeFile').resolves();
        const archiveAppData = sinon.stub(appDataEntries, 'archiveAppData').resolves({ status: true });

        const req = { body: { appname: 'bkapp', backup: [{ component: 'web', backup: true }], ...(force ? { force: true } : {}) } };
        const pending = runBackup(req);
        await clock.tickAsync(120_000);
        const result = await pending;
        clock.restore();
        const said = reported.join('');
        return { result, archiveAppData, said, drive: appReconciler.drive };
      }

      const behind = { status: { isSynced: false, globalBytes: 1000, inSyncBytes: 400, syncPercentage: 40 }, reason: 'ok' };

      it('refuses a copy that is behind, and says by how much', async () => {
        const { result, archiveAppData, said } = await backupSyncedApp({ probe: behind });

        expect(result).to.be.false;
        expect(archiveAppData.called, 'a short archive must never be written').to.be.false;
        expect(said).to.contain('40.00% synced (400/1000 bytes)');
      });

      // The refusal must not cost a healthy app an outage: it is checked before
      // anything is stopped.
      it('refuses before stopping the app', async () => {
        const { drive } = await backupSyncedApp({ probe: behind });

        // Asserted on the STOP specifically: the catch hands the app back with a
        // 'running' drive, which is correct and would mask a bare .called check.
        const stops = drive.getCalls().filter((c) => c.args[1] === 'stopped');
        expect(stops, 'nothing may be stopped for a backup that is going to be refused').to.have.lengthOf(0);
      });

      it('reports a folder that was never configured as never synced', async () => {
        const { said, archiveAppData } = await backupSyncedApp({ probe: { status: null, reason: 'absent' } });

        expect(archiveAppData.called).to.be.false;
        expect(said).to.contain('never synced');
      });

      // Syncthing not answering says nothing about the data. Refusing is still
      // right, but the reason has to be the one that actually happened - telling
      // an operator their instance has never synced, when a daemon was merely
      // restarting, is a false statement about their data.
      it('tells a silent syncthing apart from a folder that is absent', async () => {
        const { said } = await backupSyncedApp({ probe: { status: null, reason: 'unknown' } });

        expect(said).to.contain('syncthing did not answer');
        expect(said).to.not.contain('never synced');
      });

      // With nothing in the global index there is nothing to be a fraction of and
      // the percentage defaults to 100 - which would call the copy complete in the
      // same breath as refusing it.
      it('does not call an empty index a complete copy', async () => {
        const { said } = await backupSyncedApp({
          probe: { status: { isSynced: false, globalBytes: 0, inSyncBytes: 0, syncPercentage: 100 }, reason: 'ok' },
        });

        expect(said).to.contain('nothing in the sync index yet');
        expect(said).to.not.contain('100.00% synced');
      });

      it('archives a complete copy without comment', async () => {
        const { result, archiveAppData, said } = await backupSyncedApp({
          probe: { status: { isSynced: true, globalBytes: 1000, inSyncBytes: 1000, syncPercentage: 100 }, reason: 'ok' },
        });

        expect(result).to.be.true;
        expect(archiveAppData.called).to.be.true;
        expect(said).to.not.contain('incomplete');
      });

      it('archives an incomplete copy when the caller says force, and warns', async () => {
        const { result, archiveAppData, said } = await backupSyncedApp({ probe: behind, force: true });

        expect(result).to.be.true;
        expect(archiveAppData.called, 'force means archive what is on disk anyway').to.be.true;
        expect(said).to.contain('WARNING: backing up an incomplete copy');
      });
    });

    it('refuses to archive when a container did not actually stop', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      const deployment = await oneComponentDeployment('bkapp', 'comp1');
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(deployment);
      stubHostedInstances().byName.resolves(installedRecord(await registeredSpec(await v9Spec({ name: 'bkapp' }))));
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(deployment);
      // drive() awaits convergence but ANSWERS whether it happened. A component
      // that ran out the converge backstop comes back unconverged, and archiving
      // then reads a volume the app is still writing to.
      const drive = sinon.stub(appReconciler, 'drive');
      drive.withArgs(['comp1_bkapp'], 'stopped').resolves({ converged: false, failed: ['comp1_bkapp'] });
      drive.withArgs(['comp1_bkapp'], 'running').resolves({ converged: true, failed: [] });
      sinon.stub(volumeService, 'listComponentVolumeMounts').resolves([{ replica: null, mount: '/vol' }]);
      const archiveAppData = sinon.stub(appDataEntries, 'archiveAppData').resolves({ status: true });
      sinon.stub(IOUtils, 'checkFileExists').resolves(false);
      sinon.stub(IOUtils, 'removeFile').resolves();

      const req = { body: { appname: 'bkapp', backup: [{ component: 'comp1', backup: true }] } };
      const pending = runBackup(req);
      await clock.tickAsync(120_000);
      const result = await pending;
      clock.restore();

      expect(result).to.be.false;
      expect(archiveAppData.called, 'nothing may be archived from a volume still being written').to.be.false;
      expect(drive.calledWith(['comp1_bkapp'], 'running'), 'and the app is given back').to.be.true;
      expect(operationRegistry.isHeld('bkapp')).to.be.false;
    });

    // The isHeld check at the top runs BEFORE the awaited privilege call, so two
    // requests for one app both cleared it. acquire is the synchronous
    // test-and-set only one can win; its answer was being dropped.
    it('refuses the loser of a concurrent claim instead of archiving alongside it', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
      // THE RACE, reproduced where it actually happens. The endpoint's isHeld
      // check passes, then it answers 202 and the archive starts - so the lease
      // can be taken in between, and the claim inside the archive is the only
      // thing left that can refuse.
      operationRegistry.acquire('bkapp', 'backup', 'someoneElse', 'the winner');
      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      // Everything downstream is made to SUCCEED, so the claim check is the only
      // thing that can stop the archive - otherwise the case passes by failing
      // somewhere else, which is what it did on the first attempt.
      const deployment = await oneComponentDeployment('bkapp', 'comp1');
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(deployment);
      stubHostedInstances().byName.resolves(installedRecord(await registeredSpec(await v9Spec({ name: 'bkapp' }))));
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(deployment);
      sinon.stub(volumeService, 'listComponentVolumeMounts').resolves([{ replica: null, mount: '/vol' }]);
      sinon.stub(IOUtils, 'checkFileExists').resolves(false);
      sinon.stub(IOUtils, 'removeFile').resolves();
      const archiveAppData = sinon.stub(appDataEntries, 'archiveAppData').resolves({ status: true });
      sinon.stub(appReconciler, 'drive').resolves({ converged: true, failed: [] });
      // The stop is proved against docker, not against the drive's verdict: the
      // converge backstop answers 'provisional' and that is not counted, so
      // `converged` is true of a container nobody has looked at.
      sinon.stub(appReconciler, 'observedContainerState').resolves({
        reachable: true, exists: true, running: false, indeterminate: false,
      });

      const req = { body: { appname: 'bkapp', backup: [{ component: 'comp1', backup: true }] } };
      const pending = runBackup(req);
      await clock.tickAsync(120_000);
      const result = await pending;
      clock.restore();

      expect(result).to.be.false;
      expect(archiveAppData.called, 'the loser must not archive the same volume').to.be.false;
      // The winner still holds it: a refused claim must never release a lease it
      // does not own.
      expect(operationRegistry.get('bkapp')?.owner).to.equal('someoneElse');
      operationRegistry.clear();
    });

    it('drives the app back to running when the archive fails after the stop', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      // No component declares sync, so the backup takes the plain app-wide stop.
      const deployment = await oneComponentDeployment('bkapp', 'comp1');
      expect(deployment.getComponent('comp1').hasSyncthing()).to.be.false;
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(deployment);
      stubHostedInstances().byName.resolves(installedRecord(await registeredSpec(await v9Spec({ name: 'bkapp' }))));
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(deployment);
      const drive = sinon.stub(appReconciler, 'drive').resolves({ converged: true, failed: [] });
      // The stop is proved against docker, not against the drive's verdict: the
      // converge backstop answers 'provisional' and that is not counted, so
      // `converged` is true of a container nobody has looked at.
      sinon.stub(appReconciler, 'observedContainerState').resolves({
        reachable: true, exists: true, running: false, indeterminate: false,
      });
      sinon.stub(volumeService, 'listComponentVolumeMounts').resolves([{ replica: null, mount: '/vol' }]);
      sinon.stub(IOUtils, 'checkFileExists').resolves(false);
      sinon.stub(IOUtils, 'removeFile').resolves();
      sinon.stub(appDataEntries, 'archiveAppData').resolves({ status: false, error: 'No space left on device' });

      const req = { body: { appname: 'bkapp', backup: [{ component: 'comp1', backup: true }] } };
      const pending = runBackup(req);
      await clock.tickAsync(120_000); // flush sendChunk's per-chunk timers + delays
      const result = await pending;
      clock.restore();

      expect(result).to.be.false;
      expect(drive.calledWith(['comp1_bkapp'], 'stopped'), 'the backup must stop through the reconciler hold').to.be.true;
      expect(drive.calledWith(['comp1_bkapp'], 'running'), 'the failed backup must give the hold back - the app must not stay stranded stopped').to.be.true;
      expect(operationRegistry.isHeld('bkapp'), 'the backup lease must release on failure').to.be.false;
    });

    // The stop hold is given back for an activeStandby component like any other.
    // Which side runs is the election's verdict, enforced by the reconciler: a
    // standby whose controller state is stopped settles stopped under a running
    // drive, and a hold left in place would keep the elected primary down.
    it('gives the reconciler hold back for an activeStandby component after a synced backup', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      copyIs(true);
      const composed = deploymentFor(await specWithComponents('bkapp', {
        web: {
          persistentStorage: {
            sizeGb: 5,
            mounts: { '/data': { source: 'data', destination: '/data' } },
            sync: { mode: 'activeStandby' },
          },
        },
        worker: { ports: { rpc: { containerPort: 9000, hostPort: 31_001 } } },
      }));
      expect(composed.getComponent('web').hasActiveStandbySyncthing(), 'fixture must be activeStandby').to.be.true;
      expect(composed.getComponent('worker').hasActiveStandbySyncthing()).to.be.false;
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(composed);
      stubHostedInstances().byName.resolves(installedRecord(await registeredSpec(await v9Spec({ name: 'bkapp' }))));
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(composed);
      const drive = sinon.stub(appReconciler, 'drive').resolves({ converged: true, failed: [] });
      // The stop is proved against docker, not against the drive's verdict: the
      // converge backstop answers 'provisional' and that is not counted, so
      // `converged` is true of a container nobody has looked at.
      sinon.stub(appReconciler, 'observedContainerState').resolves({
        reachable: true, exists: true, running: false, indeterminate: false,
      });
      sinon.stub(volumeService, 'listComponentVolumeMounts').resolves([{ replica: null, mount: '/vol' }]);
      sinon.stub(syncthingMonitorHelpers, 'setSyncthingFolderPaused').resolves('held');
      sinon.stub(IOUtils, 'checkFileExists').resolves(false);
      sinon.stub(IOUtils, 'removeFile').resolves();
      sinon.stub(appDataEntries, 'archiveAppData').resolves({ status: true });

      const req = { body: { appname: 'bkapp', backup: [{ component: 'web', backup: true }] } };
      const pending = runBackup(req);
      await clock.tickAsync(120_000);
      await pending;
      clock.restore();

      const started = drive.getCalls()
        .filter((call) => call.args[1] === 'running')
        .flatMap((call) => call.args[0]);
      expect(started, 'the synced component must get its hold back through the reconciler')
        .to.include('web_bkapp');
      expect(started, 'and so must its sibling').to.include('worker_bkapp');
    });

    it('never drives run-state when a foreign operation already holds the app', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
      const drive = sinon.stub(appReconciler, 'drive').resolves({ converged: true, failed: [] });
      // The stop is proved against docker, not against the drive's verdict: the
      // converge backstop answers 'provisional' and that is not counted, so
      // `converged` is true of a container nobody has looked at.
      sinon.stub(appReconciler, 'observedContainerState').resolves({
        reachable: true, exists: true, running: false, indeterminate: false,
      });
      operationRegistry.acquire('bkapp', 'install', 'test', 'concurrent install');

      const req = { body: { appname: 'bkapp', backup: [{ component: 'comp1', backup: true }] } };
      const pending = runBackup(req);
      await clock.tickAsync(120_000);
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

      async function setupBackup(volumes) {
        sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
        sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(await oneComponentDeployment('bkapp', 'web'));
        // A real RegisteredSpec: the (unstubbed) buildDeployment behind
        // componentIdentifiersFor resolves and builds from it for real, with no
        // resources, so the registration names its components.
        stubHostedInstances().byName.resolves(installedRecord(await registeredSpec(await v9Spec({ name: 'bkapp' }))));
        stubInstanceResources();
        sinon.stub(appReconciler, 'drive').resolves({ converged: true, failed: [] });
        // The stop is proved against docker, not against the drive's verdict: the
        // converge backstop answers 'provisional' and that is not counted, so
        // `converged` is true of a container nobody has looked at.
        sinon.stub(appReconciler, 'observedContainerState').resolves({
          reachable: true, exists: true, running: false, indeterminate: false,
        });
        sinon.stub(volumeService, 'listComponentVolumeMounts').resolves(volumes);
        sinon.stub(IOUtils, 'checkFileExists').resolves(false);
        sinon.stub(IOUtils, 'removeFile').resolves();
        return sinon.stub(appDataEntries, 'archiveAppData').resolves({ status: true });
      }

      it('archives every identity when the task names no replica', async () => {
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
        const archiveAppData = await setupBackup(coLocated);

        const req = { body: { appname: 'bkapp', backup: [{ component: 'web', backup: true }] } };
        const pending = runBackup(req);
        await clock.tickAsync(120_000);
        await pending;
        clock.restore();

        expect(archiveAppData.callCount, 'one archive per replica').to.equal(2);
        expect(archiveAppData.getCall(0).args[0]).to.equal('/vol/s1');
        expect(archiveAppData.getCall(1).args[0]).to.equal('/vol/s2');
      });

      it('archives exactly the replica the task names', async () => {
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
        const archiveAppData = await setupBackup(coLocated);

        const req = { body: { appname: 'bkapp', backup: [{ component: 'web', backup: true, replica: 's2' }] } };
        const pending = runBackup(req);
        await clock.tickAsync(120_000);
        await pending;
        clock.restore();

        expect(archiveAppData.callCount).to.equal(1);
        expect(archiveAppData.getCall(0).args[0], 'the sibling must be untouched').to.equal('/vol/s2');
      });

      it('fails rather than archive a sibling when the named replica is absent', async () => {
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
        const archiveAppData = await setupBackup(coLocated);

        const req = { body: { appname: 'bkapp', backup: [{ component: 'web', backup: true, replica: 's9' }] } };
        const pending = runBackup(req);
        await clock.tickAsync(120_000);
        const result = await pending;
        clock.restore();

        expect(result).to.be.false;
        expect(archiveAppData.called, 'no archive may be written for an identity that is not here').to.be.false;
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
