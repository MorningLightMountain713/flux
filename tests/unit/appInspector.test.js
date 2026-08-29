'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const {
  loadSpecLibrary, V9_SUBMISSION, v9Spec, assertAnswers,
} = require('./fixtures/fluxSpec');

// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. Every installed app this module walks arrives as a DeploymentSpec whose
// components are DeploymentComponents, so those are the real classes here too: the
// budget the sweep enforces, the identifier it looks a container up by, the cpu it
// resizes to and the host port it polls all come off the real object rather than a
// literal a test invented. What stays stubbed is I/O — docker, the response, the log.
let flux;

// Where DeploymentSpec roots each container's host dir. Only path derivation reads
// it and nothing here touches the filesystem, so no directory has to exist.
const APPS_FOLDER = '/dat/var/lib/fluxos/flux-apps';

// The seam appInspector resolves a container through. Callers name an app, or one
// of its components as `<component>_<app>`; the container identifier is whatever
// the deployment states, which is NOT the request string for any app registered
// since identity minting. Tests that care about that difference override
// resolveRequestContainer; the default answers with the request so the endpoint
// tests below keep asserting their own behaviour.
function deploymentProviderStub(overrides = {}) {
  return {
    appNameFromRequest: (appname) => appname.split('_')[1] || appname,
    resolveRequestContainer: sinon.stub().callsFake(async (appname) => appname),
    listInstalledDeployments: sinon.stub().resolves([]),
    ...overrides,
  };
}

describe('appInspector tests', () => {
  let appInspector;
  let dockerServiceStub;
  let messageHelperStub;
  let logStub;

  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(60000);
    flux = await loadSpecLibrary();
  });

  /**
   * A real DeploymentSpec — the class deploymentProvider hands this module for
   * every installed app. `replica` is stated, never defaulted, exactly as
   * DeploymentSpec.fromSpec demands.
   */
  function deploymentFor(spec, opts = {}) {
    return flux.DeploymentSpec.fromSpec(spec, APPS_FOLDER, { replica: null, ...opts });
  }

  /** A real FluxAppSpecV9 whose components are named variants of the fixture's. */
  function specWithComponents(appName, components) {
    const built = {};
    for (const [compName, overrides] of Object.entries(components)) {
      built[compName] = { ...V9_SUBMISSION.components.web, name: compName, ...overrides };
    }
    return v9Spec({ name: appName, components: built });
  }

  /** A real DeploymentSpec over a real v9 spec with the named components. */
  async function deploymentWith(appName, components) {
    return deploymentFor(await specWithComponents(appName, components));
  }

  beforeEach(() => {

    // Only the methods appInspector actually calls. `appDockerStats` used to sit
    // here and nothing called it: the two appStats tests set it up, appStats asked
    // for `dockerContainerStats` instead, and the resulting TypeError answered from
    // the catch block — which `res.json.called` was happy with.
    dockerServiceStub = {
      dockerContainerInspect: sinon.stub(),
      dockerContainerStats: sinon.stub(),
      dockerContainerStatsStream: (containerId, callback) => callback(null, {}),
    };

    messageHelperStub = {
      createDataMessage: sinon.stub(),
      createErrorMessage: sinon.stub(),
    };

    logStub = {
      error: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
    };

    appInspector = proxyquire('../../ZelBack/src/services/appManagement/appInspector', {
      '../appRuntime/deploymentProvider': deploymentProviderStub(),
      '../dockerService': dockerServiceStub,
      '../messageHelper': messageHelperStub,
      '../../lib/log': logStub,
      '../serviceHelper': {
        ensureString: sinon.stub().returnsArg(0),
        runCommand: sinon.stub().resolves({ error: null, stdout: 'data', stderr: '' }),
      },
      '../verificationHelper': {
        verifyPrivilege: sinon.stub().resolves(true),
      },
      '../utils/appUtilities': {
        getContainerStorage: sinon.stub().returns(0),
      },
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('enforceWritableLayerLimit', () => {
    let clock;
    let listInstalledDeploymentsStub;
    let supportsManagedStorageStub;
    let dockerGetUsageStub;
    // Real deployments, built once and BEFORE the fake clock is installed —
    // useFakeTimers replaces the timer functions process-wide, and the library
    // build is not the thing under test here.
    let overBudget;
    let withinBudget;

    before(async function buildDeployments() {
      this.timeout(60000);
      // containerDiskGb() = rootFsGb + swapGb. The budget is the real class's
      // arithmetic, not a number a double was told to return.
      overBudget = await deploymentWith('big', { web: { rootFsGb: 2, swapGb: 1 } });
      withinBudget = await deploymentWith('small', { web: { rootFsGb: 10, swapGb: 2 } });
    });

    function load() {
      listInstalledDeploymentsStub = sinon.stub().resolves([]);
      supportsManagedStorageStub = sinon.stub().resolves(false);
      dockerGetUsageStub = sinon.stub().resolves({ Containers: [] });
      return proxyquire('../../ZelBack/src/services/appManagement/appInspector', {
        '../dockerService': {
          dockerGetUsage: dockerGetUsageStub,
          getAppDockerNameIdentifier: (id) => `/${id}`,
          dockerContainerStatsStream: (containerId, callback) => callback(null, {}),
        },
        '../appRuntime/deploymentProvider': { listInstalledDeployments: listInstalledDeploymentsStub },
        '../utils/hostStorageCapability': { supportsManagedStorage: supportsManagedStorageStub },
        '../appLifecycle/appUninstaller': { uninstallApplication: sinon.stub().resolves() },
        '../../services/appLifecycle/appOperations': { redeployApplication: sinon.stub().resolves() },
        '../messageHelper': messageHelperStub,
        '../../lib/log': logStub,
        '../serviceHelper': { ensureString: sinon.stub().returnsArg(0), delay: sinon.stub().resolves() },
        '../verificationHelper': { verifyPrivilege: sinon.stub().resolves(true) },
        '../utils/appUtilities': { getContainerStorage: sinon.stub().returns(0) },
      });
    }

    beforeEach(() => { clock = sinon.useFakeTimers(); });
    afterEach(() => { clock.restore(); });

    it('skips the sweep on a managed node — the kernel XFS quota enforces the cap', async () => {
      const inspector = load();
      supportsManagedStorageStub.resolves(true);
      await inspector.enforceWritableLayerLimit([]);
      expect(listInstalledDeploymentsStub.called).to.be.false;
    });

    it('flags a non-managed app whose container exceeds its per-component budget', async () => {
      const inspector = load();
      listInstalledDeploymentsStub.resolves([overBudget]);
      // budget = (2 + 1) * 1e9 = 3e9; the container reports 5e9 on disk → violation
      dockerGetUsageStub.resolves({ Containers: [{ Names: ['/web_big'], SizeRootFs: 5e9 }] });
      const violations = [];
      await inspector.enforceWritableLayerLimit(violations);
      expect(violations).to.include('big');
    });

    it('does not flag a non-managed app within its per-component budget', async () => {
      const inspector = load();
      listInstalledDeploymentsStub.resolves([withinBudget]);
      // budget = (10 + 2) * 1e9 = 12e9; the container reports 4e9 on disk → fits
      dockerGetUsageStub.resolves({ Containers: [{ Names: ['/web_small'], SizeRootFs: 4e9 }] });
      const violations = [];
      await inspector.enforceWritableLayerLimit(violations);
      expect(violations).to.not.include('small');
    });

    it('reads the budget and the container name off the real deployment', async () => {
      // The sweep is the only thing that decides whether an app is over budget,
      // so the guard is on the object it was handed: if DeploymentSpec stops
      // answering componentEntries(), or DeploymentComponent stops answering
      // containerDiskGb(), the two tests above go quietly green on an app that
      // was never measured. Read the deployment back off the supplier stub and
      // ask it what the sweep asks it.
      const inspector = load();
      listInstalledDeploymentsStub.resolves([overBudget]);
      dockerGetUsageStub.resolves({ Containers: [] });
      await inspector.enforceWritableLayerLimit([]);

      const [handed] = await listInstalledDeploymentsStub.firstCall.returnValue;
      assertAnswers(handed, ['componentEntries']);
      expect(handed.appName).to.equal('big');
      const [[compName, comp]] = handed.componentEntries();
      expect(compName).to.equal('web');
      assertAnswers(comp, ['containerDiskGb']);
      // The identifier is the deployment's, and it is what the sweep matches
      // docker's container name against — `<component>_<app>`, not the app name.
      expect(comp.identifier).to.equal('web_big');
      expect(comp.containerDiskGb()).to.equal(3);
    });
  });

  describe('appInspect', () => {
    // The container the endpoint inspects, as the real deployment describes it.
    let inspected;

    before(async function buildDeployment() {
      this.timeout(60000);
      inspected = await deploymentWith('testapp', {
        web: { env: { APP_MODE: 'production', UPSTREAM: 'https://example.invalid' } },
      });
    });

    it('should inspect app and return data', async () => {
      const [[, comp]] = inspected.componentEntries();
      const req = {
        params: { appname: 'testapp' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      // Docker's own inspect payload, keyed on the real component: the container
      // name, the env docker was actually given, the cpu quota it was created with.
      const mockInspectData = {
        Id: 'c0ffee'.repeat(10),
        Name: `/${comp.identifier}`,
        State: { Running: true, Pid: 4242 },
        Config: { Env: comp.toDockerEnv() },
        HostConfig: { NanoCpus: comp.cpu * 1e9 },
      };
      dockerServiceStub.dockerContainerInspect.resolves(mockInspectData);
      messageHelperStub.createDataMessage.callsFake((data) => ({ status: 'success', data }));

      await appInspector.appInspect(req, res);

      expect(dockerServiceStub.dockerContainerInspect.called).to.be.true;
      expect(res.json.calledOnce).to.be.true;

      // What the endpoint answers with is docker's payload as it came back — the
      // handler builds no view of its own and drops nothing from it, the container
      // environment included. Asserted against the env the real component projects
      // so this stays a statement about the response, not about a literal invented
      // here that could quietly stop resembling a container.
      const [sent] = res.json.firstCall.args;
      expect(sent.data).to.equal(mockInspectData);
      expect(comp.toDockerEnv()).to.not.be.empty;
      expect(sent.data.Config.Env).to.deep.equal(comp.toDockerEnv());
    });

    it('should handle missing appname', async () => {
      const req = {
        params: {},
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      messageHelperStub.createErrorMessage.returns({ status: 'error' });

      await appInspector.appInspect(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(logStub.error.called).to.be.true;
    });
  });

  describe('appTop tests', () => {
    it('should return error if no params were passed, response passed', async () => {
      const req = {
        params: {
          test: 'test',
        },
        query: {
          test2: 'test2',
        },
      };
      const res = {
        json: sinon.stub(),
      };

      messageHelperStub.createErrorMessage.returns({
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'No Flux App specified',
        },
      });

      await appInspector.appTop(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(logStub.error.called).to.be.true;
    });

    it('should return error if no params were passed, no response passed', async () => {
      const req = {
        params: {
          test: 'test',
        },
        query: {
          test2: 'test2',
        },
      };

      messageHelperStub.createErrorMessage.returns({
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'No Flux App specified',
        },
      });

      const result = await appInspector.appTop(req);

      expect(result).to.have.property('status', 'error');
      expect(logStub.error.called).to.be.true;
    });

    it('should return error if user has no appowner privileges, response passed', async () => {
      const appInspectorWithAuth = proxyquire('../../ZelBack/src/services/appManagement/appInspector', {
      '../appRuntime/deploymentProvider': deploymentProviderStub(),
        '../dockerService': dockerServiceStub,
        '../messageHelper': messageHelperStub,
        '../../lib/log': logStub,
        '../serviceHelper': {
          ensureString: sinon.stub().returnsArg(0),
        },
        '../verificationHelper': {
          verifyPrivilege: sinon.stub().resolves(false),
        },
        '../utils/appUtilities': {
          getContainerStorage: sinon.stub().returns(0),
        },
      });

      const req = {
        params: {
          appname: 'test_myappname',
        },
        query: {
          test2: 'test2',
        },
      };
      const res = {
        json: sinon.stub(),
      };

      messageHelperStub.createErrorMessage.returns({
        status: 'error',
        data: {
          code: 401,
          name: 'Unauthorized',
          message: 'Unauthorized. Access denied.',
        },
      });

      await appInspectorWithAuth.appTop(req, res);

      expect(res.json.calledOnce).to.be.true;
    });

    it('should return error if user has no appowner privileges, no response passed', async () => {
      const appInspectorWithAuth = proxyquire('../../ZelBack/src/services/appManagement/appInspector', {
      '../appRuntime/deploymentProvider': deploymentProviderStub(),
        '../dockerService': dockerServiceStub,
        '../messageHelper': messageHelperStub,
        '../../lib/log': logStub,
        '../serviceHelper': {
          ensureString: sinon.stub().returnsArg(0),
        },
        '../verificationHelper': {
          verifyPrivilege: sinon.stub().resolves(false),
        },
        '../utils/appUtilities': {
          getContainerStorage: sinon.stub().returns(0),
        },
      });

      const req = {
        params: {
          appname: 'test_myappname',
        },
        query: {
          test2: 'test2',
        },
      };

      messageHelperStub.createErrorMessage.returns({
        status: 'error',
        data: {
          code: 401,
          name: 'Unauthorized',
          message: 'Unauthorized. Access denied.',
        },
      });

      const result = await appInspectorWithAuth.appTop(req);

      expect(result).to.have.property('status', 'error');
    });

    it('should top app, underscore in the name', async () => {
      const req = {
        params: {
          appname: 'test_myappname',
        },
        query: {
          test2: 'test2',
        },
      };

      dockerServiceStub.appDockerTop = sinon.stub().resolves('some data');
      messageHelperStub.createDataMessage.returns({
        status: 'success',
        data: 'some data',
      });

      const result = await appInspector.appTop(req);

      expect(result).to.have.property('status', 'success');
      expect(dockerServiceStub.appDockerTop.calledWith('test_myappname')).to.be.true;
    });

    it('tops the container the deployment names, not the request string', async () => {
      // `test_myappname` names component `test` of app `myappname`. Its container
      // identifier is built from the app's minted identity, so the request string
      // is not one — driving it would inspect a container that does not exist.
      const resolveRequestContainer = sinon.stub().resolves('test_a1b2c3d4e5f6');
      const appInspectorResolving = proxyquire('../../ZelBack/src/services/appManagement/appInspector', {
        '../dockerService': dockerServiceStub,
        '../appRuntime/deploymentProvider': deploymentProviderStub({ resolveRequestContainer }),
        '../messageHelper': messageHelperStub,
        '../../lib/log': logStub,
        '../serviceHelper': { ensureString: sinon.stub().returnsArg(0) },
        '../verificationHelper': { verifyPrivilege: sinon.stub().resolves(true) },
        '../utils/appUtilities': { getContainerStorage: sinon.stub().returns(0) },
      });

      dockerServiceStub.appDockerTop = sinon.stub().resolves('some data');
      messageHelperStub.createDataMessage.returns({ status: 'success', data: 'some data' });

      const req = { params: { appname: 'test_myappname' }, query: {} };
      const result = await appInspectorResolving.appTop(req);

      expect(result).to.have.property('status', 'success');
      sinon.assert.calledWith(resolveRequestContainer, 'test_myappname');
      expect(dockerServiceStub.appDockerTop.calledWith('test_a1b2c3d4e5f6')).to.be.true;
      expect(dockerServiceStub.appDockerTop.calledWith('test_myappname')).to.be.false;
    });

    it('should top app, no underscore in the name', async () => {
      const req = {
        params: {
          appname: 'myappname',
        },
        query: {
          test2: 'test2',
        },
      };

      dockerServiceStub.appDockerTop = sinon.stub().resolves('some data');
      messageHelperStub.createDataMessage.returns({
        status: 'success',
        data: 'some data',
      });

      const result = await appInspector.appTop(req);

      expect(result).to.have.property('status', 'success');
      expect(dockerServiceStub.appDockerTop.calledWith('myappname')).to.be.true;
    });
  });

  describe('appLog tests', () => {
    it('should return error if no app name was passed', async () => {
      const req = {
        params: {
          test: 'test',
        },
        query: {
          test2: 'test2',
        },
      };
      const res = {
        json: sinon.stub(),
      };

      messageHelperStub.createErrorMessage.returns({
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'No Flux App specified',
        },
      });

      await appInspector.appLog(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(logStub.error.called).to.be.true;
    });

    it('should return error if user has no appowner privileges', async () => {
      const appInspectorWithAuth = proxyquire('../../ZelBack/src/services/appManagement/appInspector', {
      '../appRuntime/deploymentProvider': deploymentProviderStub(),
        '../dockerService': dockerServiceStub,
        '../messageHelper': messageHelperStub,
        '../../lib/log': logStub,
        '../serviceHelper': {
          ensureString: sinon.stub().returnsArg(0),
          dockerBufferToString: sinon.stub().returnsArg(0),
        },
        '../verificationHelper': {
          verifyPrivilege: sinon.stub().resolves(false),
        },
        '../utils/appUtilities': {
          getContainerStorage: sinon.stub().returns(0),
        },
      });

      const req = {
        params: {
          appname: 'test_myappname',
        },
        query: {
          test2: 'test2',
        },
      };
      const res = {
        json: sinon.stub(),
      };

      messageHelperStub.createErrorMessage.returns({
        status: 'error',
        data: {
          code: 401,
          name: 'Unauthorized',
          message: 'Unauthorized. Access denied.',
        },
      });

      await appInspectorWithAuth.appLog(req, res);

      expect(res.json.calledOnce).to.be.true;
    });

    it('should log app, underscore in the name', async () => {
      const appInspectorWithHelper = proxyquire('../../ZelBack/src/services/appManagement/appInspector', {
      '../appRuntime/deploymentProvider': deploymentProviderStub(),
        '../dockerService': {
          ...dockerServiceStub,
          dockerContainerLogs: sinon.stub().resolves('some data'),
        },
        '../messageHelper': messageHelperStub,
        '../../lib/log': logStub,
        '../serviceHelper': {
          ensureString: sinon.stub().returnsArg(0),
          dockerBufferToString: sinon.stub().returns('some data'),
        },
        '../verificationHelper': {
          verifyPrivilege: sinon.stub().resolves(true),
        },
        '../utils/appUtilities': {
          getContainerStorage: sinon.stub().returns(0),
        },
      });

      const req = {
        params: {
          appname: 'test_myappname',
          lines: '10',
        },
        query: {
          test2: 'test2',
        },
      };
      const res = {
        json: sinon.stub(),
      };

      messageHelperStub.createDataMessage.returns({
        status: 'success',
        data: 'some data',
      });

      await appInspectorWithHelper.appLog(req, res);

      expect(res.json.calledOnce).to.be.true;
    });

    it('should log app, no underscore in the name', async () => {
      const appInspectorWithHelper = proxyquire('../../ZelBack/src/services/appManagement/appInspector', {
      '../appRuntime/deploymentProvider': deploymentProviderStub(),
        '../dockerService': {
          ...dockerServiceStub,
          dockerContainerLogs: sinon.stub().resolves('some data'),
        },
        '../messageHelper': messageHelperStub,
        '../../lib/log': logStub,
        '../serviceHelper': {
          ensureString: sinon.stub().returnsArg(0),
          dockerBufferToString: sinon.stub().returns('some data'),
        },
        '../verificationHelper': {
          verifyPrivilege: sinon.stub().resolves(true),
        },
        '../utils/appUtilities': {
          getContainerStorage: sinon.stub().returns(0),
        },
      });

      const req = {
        params: {
          appname: 'myappname',
          lines: '10',
        },
        query: {
          test2: 'test2',
        },
      };
      const res = {
        json: sinon.stub(),
      };

      messageHelperStub.createDataMessage.returns({
        status: 'success',
        data: 'some data',
      });

      await appInspectorWithHelper.appLog(req, res);

      expect(res.json.calledOnce).to.be.true;
    });

    it('should log app, no underscore in the name, no lines param', async () => {
      const appInspectorWithHelper = proxyquire('../../ZelBack/src/services/appManagement/appInspector', {
      '../appRuntime/deploymentProvider': deploymentProviderStub(),
        '../dockerService': {
          ...dockerServiceStub,
          dockerContainerLogs: sinon.stub().resolves('some data'),
        },
        '../messageHelper': messageHelperStub,
        '../../lib/log': logStub,
        '../serviceHelper': {
          ensureString: sinon.stub().returnsArg(0),
          dockerBufferToString: sinon.stub().returns('some data'),
        },
        '../verificationHelper': {
          verifyPrivilege: sinon.stub().resolves(true),
        },
        '../utils/appUtilities': {
          getContainerStorage: sinon.stub().returns(0),
        },
      });

      const req = {
        params: {
          appname: 'myappname',
        },
        query: {
          test2: 'test2',
        },
      };
      const res = {
        json: sinon.stub(),
      };

      messageHelperStub.createDataMessage.returns({
        status: 'success',
        data: 'some data',
      });

      await appInspectorWithHelper.appLog(req, res);

      expect(res.json.calledOnce).to.be.true;
    });
  });

  describe('appStats tests', () => {
    // A real deployment for the app these requests name. Component `test` of app
    // `myappname` has identifier `test_myappname` — which is the request string the
    // first test sends, so that one names a container the deployment really has.
    let statsDeployment;

    before(async function buildDeployment() {
      this.timeout(60000);
      statsDeployment = await deploymentWith('myappname', { test: {} });
    });

    it('should return error if no app name was passed', async () => {
      const req = {
        params: {
          test: 'test',
        },
        query: {
          test2: 'test2',
        },
      };
      const res = {
        json: sinon.stub(),
      };

      messageHelperStub.createErrorMessage.returns({
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'No Flux App specified',
        },
      });

      await appInspector.appStats(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(logStub.error.called).to.be.true;
    });

    it('should return error if user has no appowner privileges', async () => {
      const appInspectorWithAuth = proxyquire('../../ZelBack/src/services/appManagement/appInspector', {
      '../appRuntime/deploymentProvider': deploymentProviderStub(),
        '../dockerService': dockerServiceStub,
        '../messageHelper': messageHelperStub,
        '../../lib/log': logStub,
        '../serviceHelper': {
          ensureString: sinon.stub().returnsArg(0),
        },
        '../verificationHelper': {
          verifyPrivilege: sinon.stub().resolves(false),
        },
        '../utils/appUtilities': {
          getContainerStorage: sinon.stub().returns(0),
        },
      });

      const req = {
        params: {
          appname: 'test_myappname',
        },
        query: {
          test2: 'test2',
        },
      };
      const res = {
        json: sinon.stub(),
      };

      messageHelperStub.createErrorMessage.returns({
        status: 'error',
        data: {
          code: 401,
          name: 'Unauthorized',
          message: 'Unauthorized. Access denied.',
        },
      });

      await appInspectorWithAuth.appStats(req, res);

      expect(res.json.calledOnce).to.be.true;
    });

    it('should return app stats, underscore in the name', async () => {
      const [[, comp]] = statsDeployment.componentEntries();
      expect(comp.identifier).to.equal('test_myappname');
      const req = {
        params: {
          appname: comp.identifier,
        },
        query: {
          test2: 'test2',
        },
      };
      const res = {
        json: sinon.stub(),
      };

      const mockStats = { data: 1000 };
      dockerServiceStub.dockerContainerStats.resolves(mockStats);
      dockerServiceStub.dockerContainerInspect.resolves({ HostConfig: { NanoCpus: comp.cpu * 1e9 } });
      messageHelperStub.createDataMessage.callsFake((data) => ({ status: 'success', data }));

      await appInspector.appStats(req, res);

      // The endpoint's own work is the two fields it adds to docker's stats. Assert
      // them, and assert it did not answer from the catch block: the only assertion
      // this test used to make — that res.json was called — is satisfied by the
      // error response too, so it passed while dockerContainerStats was missing
      // from the stub entirely and the handler never reached its success path.
      expect(logStub.error.called, 'appStats answered from its catch block').to.be.false;
      const [sent] = res.json.firstCall.args;
      expect(sent.data.disk_stats).to.equal(0);
      expect(sent.data.nanoCpus).to.equal(comp.cpu * 1e9);
    });

    it('should return app stats, no underscore in the name', async () => {
      const [[, comp]] = statsDeployment.componentEntries();
      const req = {
        params: {
          appname: 'myappname',
        },
        query: {
          test2: 'test2',
        },
      };
      const res = {
        json: sinon.stub(),
      };

      const mockStats = { data: 1000 };
      dockerServiceStub.dockerContainerStats.resolves(mockStats);
      dockerServiceStub.dockerContainerInspect.resolves({ HostConfig: { NanoCpus: comp.cpu * 1e9 } });
      messageHelperStub.createDataMessage.callsFake((data) => ({ status: 'success', data }));

      await appInspector.appStats(req, res);

      expect(logStub.error.called, 'appStats answered from its catch block').to.be.false;
      const [sent] = res.json.firstCall.args;
      expect(sent.data.disk_stats).to.equal(0);
      expect(sent.data.nanoCpus).to.equal(comp.cpu * 1e9);
    });
  });

  describe('appMonitor tests', () => {
    // The monitoring store is keyed by container identifier, so the key comes off
    // the real component rather than being spelled out here.
    let monitorDeployment;

    before(async function buildDeployment() {
      this.timeout(60000);
      monitorDeployment = await deploymentWith('myappname', { test: {} });
    });

    it('should return error if no app name was passed', async () => {
      const req = {
        params: {
          test: 'test',
        },
        query: {
          test2: 'test2',
        },
      };
      const res = {
        json: sinon.stub(),
      };

      messageHelperStub.createErrorMessage.returns({
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'No Flux App specified',
        },
      });

      await appInspector.appMonitor(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(logStub.error.called).to.be.true;
    });

    it('should return error if user has no appowner privileges', async () => {
      const appInspectorWithAuth = proxyquire('../../ZelBack/src/services/appManagement/appInspector', {
      '../appRuntime/deploymentProvider': deploymentProviderStub(),
        '../dockerService': dockerServiceStub,
        '../messageHelper': messageHelperStub,
        '../../lib/log': logStub,
        '../serviceHelper': {
          ensureString: sinon.stub().returnsArg(0),
        },
        '../verificationHelper': {
          verifyPrivilege: sinon.stub().resolves(false),
        },
        '../utils/appUtilities': {
          getContainerStorage: sinon.stub().returns(0),
        },
      });

      const req = {
        params: {
          appname: 'test_myappname',
        },
        query: {
          test2: 'test2',
        },
      };
      const res = {
        json: sinon.stub(),
      };

      messageHelperStub.createErrorMessage.returns({
        status: 'error',
        data: {
          code: 401,
          name: 'Unauthorized',
          message: 'Unauthorized. Access denied.',
        },
      });

      await appInspectorWithAuth.appMonitor(req, res);

      expect(res.json.calledOnce).to.be.true;
    });

    it('should return app monitor data, underscore in the name', async () => {
      const [[, comp]] = monitorDeployment.componentEntries();
      expect(comp.identifier).to.equal('test_myappname');
      const samples = [{ timestamp: 1, data: 1000 }];
      const appsMonitored = { [comp.identifier]: { statsStore: samples } };
      const req = {
        params: {
          appname: comp.identifier,
        },
        query: {
          test2: 'test2',
        },
      };
      const res = {
        json: sinon.stub(),
      };

      messageHelperStub.createDataMessage.callsFake((data) => ({ status: 'success', data }));

      // appsMonitored is a required argument. Omitting it — which this test used
      // to do — throws on the first lookup and answers from the catch block, and
      // `res.json.called` cannot tell the two responses apart.
      await appInspector.appMonitor(req, res, appsMonitored);

      expect(logStub.error.called, 'appMonitor answered from its catch block').to.be.false;
      const [sent] = res.json.firstCall.args;
      expect(sent.data).to.equal(samples);
    });

    it('should return app monitor data, no underscore in the name', async () => {
      const samples = [{ timestamp: 1, data: 1000 }];
      const appsMonitored = { myappname: { statsStore: samples } };
      const req = {
        params: {
          appname: 'myappname',
        },
        query: {
          test2: 'test2',
        },
      };
      const res = {
        json: sinon.stub(),
      };

      messageHelperStub.createDataMessage.callsFake((data) => ({ status: 'success', data }));

      await appInspector.appMonitor(req, res, appsMonitored);

      expect(logStub.error.called, 'appMonitor answered from its catch block').to.be.false;
      const [sent] = res.json.firstCall.args;
      expect(sent.data).to.equal(samples);
    });

    it('should return error if app is not monitored', async () => {
      const req = {
        params: {
          appname: 'test_nonexistent',
        },
        query: {
          test2: 'test2',
        },
      };
      const res = {
        json: sinon.stub(),
      };

      messageHelperStub.createErrorMessage.callsFake((message) => ({ status: 'error', data: { message } }));

      // A populated store that simply has no entry for this container — the
      // 'No data available' path, rather than a throw on an absent store.
      const [[, comp]] = monitorDeployment.componentEntries();
      await appInspector.appMonitor(req, res, { [comp.identifier]: { statsStore: [] } });

      expect(res.json.called).to.be.true;
      sinon.assert.calledWith(messageHelperStub.createErrorMessage, 'No data available');
    });
  });

  describe('appMonitorStream tests', () => {
    it('should return error if no app name was passed', async () => {
      const req = {
        params: {
          test: 'test',
        },
        query: {
          test2: 'test2',
        },
      };
      const res = {
        json: sinon.stub(),
        end: sinon.stub(),
      };

      messageHelperStub.createErrorMessage.returns({
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'No Flux App specified',
        },
      });

      await appInspector.appMonitorStream(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(logStub.error.called).to.be.true;
    });

    it('should return error if user has no appowner privileges', async () => {
      const appInspectorWithAuth = proxyquire('../../ZelBack/src/services/appManagement/appInspector', {
      '../appRuntime/deploymentProvider': deploymentProviderStub(),
        '../dockerService': dockerServiceStub,
        '../messageHelper': messageHelperStub,
        '../../lib/log': logStub,
        '../serviceHelper': {
          ensureString: sinon.stub().returnsArg(0),
        },
        '../verificationHelper': {
          verifyPrivilege: sinon.stub().resolves(false),
        },
        '../utils/appUtilities': {
          getContainerStorage: sinon.stub().returns(0),
        },
      });

      const req = {
        params: {
          appname: 'test_myappname',
        },
        query: {
          test2: 'test2',
        },
      };
      const res = {
        json: sinon.stub(),
        end: sinon.stub(),
      };

      messageHelperStub.createErrorMessage.returns({
        status: 'error',
        data: {
          code: 401,
          name: 'Unauthorized',
          message: 'Unauthorized. Access denied.',
        },
      });

      await appInspectorWithAuth.appMonitorStream(req, res);

      expect(res.json.calledOnce).to.be.true;
    });

    it('should return app monitor stream, underscore in the name', async () => {
      const dockerServiceWithStream = {
        ...dockerServiceStub,
        dockerContainerStatsStream: (appname, req, res, callback) => {
          res.write('data');
          if (callback) callback(null);
        },
      };

      const appInspectorWithStream = proxyquire('../../ZelBack/src/services/appManagement/appInspector', {
      '../appRuntime/deploymentProvider': deploymentProviderStub(),
        '../dockerService': dockerServiceWithStream,
        '../messageHelper': messageHelperStub,
        '../../lib/log': logStub,
        '../serviceHelper': {
          ensureString: sinon.stub().returnsArg(0),
        },
        '../verificationHelper': {
          verifyPrivilege: sinon.stub().resolves(true),
        },
        '../utils/appUtilities': {
          getContainerStorage: sinon.stub().returns(0),
        },
      });

      const req = {
        params: {
          appname: 'test_myappname',
        },
        query: {
          test2: 'test2',
        },
      };
      const res = {
        json: sinon.stub(),
        write: sinon.stub(),
        setHeader: sinon.stub(),
        end: sinon.stub(),
      };

      await appInspectorWithStream.appMonitorStream(req, res);

      expect(res.end.called || res.write.called).to.be.true;
    });

    it('should return app monitor stream, no underscore in the name', async () => {
      const dockerServiceWithStream = {
        ...dockerServiceStub,
        dockerContainerStatsStream: (appname, req, res, callback) => {
          res.write('data');
          if (callback) callback(null);
        },
      };

      const appInspectorWithStream = proxyquire('../../ZelBack/src/services/appManagement/appInspector', {
      '../appRuntime/deploymentProvider': deploymentProviderStub(),
        '../dockerService': dockerServiceWithStream,
        '../messageHelper': messageHelperStub,
        '../../lib/log': logStub,
        '../serviceHelper': {
          ensureString: sinon.stub().returnsArg(0),
        },
        '../verificationHelper': {
          verifyPrivilege: sinon.stub().resolves(true),
        },
        '../utils/appUtilities': {
          getContainerStorage: sinon.stub().returns(0),
        },
      });

      const req = {
        params: {
          appname: 'myappname',
        },
        query: {
          test2: 'test2',
        },
      };
      const res = {
        json: sinon.stub(),
        write: sinon.stub(),
        setHeader: sinon.stub(),
        end: sinon.stub(),
      };

      await appInspectorWithStream.appMonitorStream(req, res);

      expect(res.end.called || res.write.called).to.be.true;
    });
  });

  describe('appChanges tests', () => {
    it('should return error if no app name was passed', async () => {
      const req = {
        params: {
          test: 'test',
        },
        query: {
          test2: 'test2',
        },
      };
      const res = {
        json: sinon.stub(),
      };

      messageHelperStub.createErrorMessage.returns({
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'No Flux App specified',
        },
      });

      await appInspector.appChanges(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(logStub.error.called).to.be.true;
    });

    it('should return error if user has no appowner privileges', async () => {
      const appInspectorWithAuth = proxyquire('../../ZelBack/src/services/appManagement/appInspector', {
      '../appRuntime/deploymentProvider': deploymentProviderStub(),
        '../dockerService': dockerServiceStub,
        '../messageHelper': messageHelperStub,
        '../../lib/log': logStub,
        '../serviceHelper': {
          ensureString: sinon.stub().returnsArg(0),
        },
        '../verificationHelper': {
          verifyPrivilege: sinon.stub().resolves(false),
        },
        '../utils/appUtilities': {
          getContainerStorage: sinon.stub().returns(0),
        },
      });

      const req = {
        params: {
          appname: 'test_myappname',
        },
        query: {
          test2: 'test2',
        },
      };
      const res = {
        json: sinon.stub(),
      };

      messageHelperStub.createErrorMessage.returns({
        status: 'error',
        data: {
          code: 401,
          name: 'Unauthorized',
          message: 'Unauthorized. Access denied.',
        },
      });

      await appInspectorWithAuth.appChanges(req, res);

      expect(res.json.calledOnce).to.be.true;
    });

    it('should return app changes, underscore in the name', async () => {
      const req = {
        params: {
          appname: 'test_myappname',
        },
        query: {
          test2: 'test2',
        },
      };
      const res = {
        json: sinon.stub(),
      };

      dockerServiceStub.dockerContainerChanges = sinon.stub().resolves('some data');
      messageHelperStub.createDataMessage.returns({
        status: 'success',
        data: 'some data',
      });

      await appInspector.appChanges(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(dockerServiceStub.dockerContainerChanges.calledWith('test_myappname')).to.be.true;
    });

    it('should return app changes, no underscore in the name', async () => {
      const req = {
        params: {
          appname: 'myappname',
        },
        query: {
          test2: 'test2',
        },
      };
      const res = {
        json: sinon.stub(),
      };

      dockerServiceStub.dockerContainerChanges = sinon.stub().resolves('some data');
      messageHelperStub.createDataMessage.returns({
        status: 'success',
        data: 'some data',
      });

      await appInspector.appChanges(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(dockerServiceStub.dockerContainerChanges.calledWith('myappname')).to.be.true;
    });

    it('should return error if docker throws', async () => {
      const req = {
        params: {
          appname: 'myappname',
        },
        query: {
          test2: 'test2',
        },
      };
      const res = {
        json: sinon.stub(),
      };

      dockerServiceStub.dockerContainerChanges = sinon.stub().rejects(new Error('Docker error'));
      messageHelperStub.createErrorMessage.returns({
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'Docker error',
        },
      });

      await appInspector.appChanges(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(logStub.error.called).to.be.true;
    });
  });

  describe('listAppsImages tests', () => {
    it('should return error if dockerService throws, no response passed', async () => {
      dockerServiceStub.dockerListImages = sinon.stub().rejects(new Error('Error'));
      messageHelperStub.createErrorMessage.returns({
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'Error',
        },
      });

      const result = await appInspector.listAppsImages();

      expect(result).to.have.property('status', 'error');
      expect(logStub.error.called).to.be.true;
    });

    it('should return error if dockerService throws, response passed', async () => {
      const res = {
        json: sinon.stub(),
      };
      dockerServiceStub.dockerListImages = sinon.stub().rejects(new Error('Error'));
      messageHelperStub.createErrorMessage.returns({
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'Error',
        },
      });

      await appInspector.listAppsImages(undefined, res);

      expect(res.json.calledOnce).to.be.true;
      expect(logStub.error.called).to.be.true;
    });

    it('should return running apps, no response passed', async () => {
      const mockImages = [{ RepoTags: ['image1:latest'] }, { RepoTags: ['image2:latest'] }];
      dockerServiceStub.dockerListImages = sinon.stub().resolves(mockImages);
      messageHelperStub.createDataMessage.returns({
        status: 'success',
        data: mockImages,
      });

      const result = await appInspector.listAppsImages();

      expect(result).to.have.property('status', 'success');
    });

    it('should return running apps, response passed', async () => {
      const mockImages = [{ RepoTags: ['image1:latest'] }, { RepoTags: ['image2:latest'] }];
      const res = {
        json: sinon.stub(),
      };
      dockerServiceStub.dockerListImages = sinon.stub().resolves(mockImages);
      messageHelperStub.createDataMessage.returns({
        status: 'success',
        data: mockImages,
      });

      await appInspector.listAppsImages(undefined, res);

      expect(res.json.calledOnce).to.be.true;
    });
  });

  describe('checkApplicationsCpuUSage', () => {
    let listInstalledDeploymentsStub;
    let dockerContainerInspectStub;
    let appDockerUpdateCpuStub;
    let isBurstActiveStub;
    // A real deployment whose one component asks for 2 cores.
    let saturated;

    before(async function buildDeployment() {
      this.timeout(60000);
      saturated = await deploymentWith('cpuapp', { web: { cpu: 2 } });
    });

    function load() {
      listInstalledDeploymentsStub = sinon.stub().resolves([]);
      dockerContainerInspectStub = sinon.stub().resolves(null);
      appDockerUpdateCpuStub = sinon.stub().resolves();
      isBurstActiveStub = sinon.stub().resolves(false);
      return proxyquire('../../ZelBack/src/services/appManagement/appInspector', {
        '../dockerService': {
          dockerContainerInspect: dockerContainerInspectStub,
          appDockerUpdateCpu: appDockerUpdateCpuStub,
          dockerContainerStatsStream: (containerId, callback) => callback(null, {}),
        },
        '../appRuntime/deploymentProvider': { listInstalledDeployments: listInstalledDeploymentsStub },
        '../utils/cpuBurstHelper': { isBurstActive: isBurstActiveStub },
        '../messageHelper': messageHelperStub,
        '../../lib/log': logStub,
        '../serviceHelper': { ensureString: sinon.stub().returnsArg(0) },
        '../verificationHelper': { verifyPrivilege: sinon.stub().resolves(true) },
        '../utils/appUtilities': { getContainerStorage: sinon.stub().returns(0) },
      });
    }

    /**
     * More than four samples (the minimum the check requires), each showing the
     * container using ~95% of the quota the component asked for.
     */
    function saturatedStats(samples = 5) {
      return Array.from({ length: samples }, () => ({
        timestamp: 0,
        data: {
          cpu_stats: { cpu_usage: { total_usage: 195 }, system_cpu_usage: 200, online_cpus: 2 },
          precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 100 },
        },
      }));
    }

    it('sizes the new cpu quota from the component the deployment declares', async () => {
      const inspector = load();
      listInstalledDeploymentsStub.resolves([saturated]);
      dockerContainerInspectStub.resolves({ State: { Pid: 4242 }, HostConfig: { NanoCpus: 2e9 } });
      // Keyed by the real component's identifier: monitoring that arrived under
      // any other key is monitoring for a container this app does not own.
      const appsMonitored = { web_cpuapp: { lastHourstatsStore: saturatedStats() } };

      await inspector.checkApplicationsCpuUSage(appsMonitored);

      // comp.cpu is 2, so the throttled quota is round(2 * 1e9 * 0.9).
      sinon.assert.calledWithExactly(appDockerUpdateCpuStub, 'web_cpuapp', 1.8e9);
      expect(appsMonitored.web_cpuapp.lastHourstatsStore).to.be.empty;
    });

    it('leaves a burst-active container alone', async () => {
      const inspector = load();
      listInstalledDeploymentsStub.resolves([saturated]);
      dockerContainerInspectStub.resolves({ State: { Pid: 4242 }, HostConfig: { NanoCpus: 2e9 } });
      isBurstActiveStub.resolves(true);
      const appsMonitored = { web_cpuapp: { lastHourstatsStore: saturatedStats() } };

      await inspector.checkApplicationsCpuUSage(appsMonitored);

      sinon.assert.calledWith(isBurstActiveStub, 4242);
      expect(appDockerUpdateCpuStub.called).to.be.false;
      expect(appsMonitored.web_cpuapp.lastHourstatsStore).to.be.empty;
    });
  });

  describe('monitorSharedDBApps', () => {
    let listInstalledDeploymentsStub;
    let axiosGetStub;
    // A two-component app: only the second runs the shared-db operator, and it
    // publishes two host ports. The monitor polls the LAST one.
    let sharedDb;
    let plain;

    before(async function buildDeployments() {
      this.timeout(60000);
      sharedDb = await deploymentWith('dbapp', {
        web: { ports: { http: { containerPort: 80, hostPort: 31000 } } },
        operator: {
          image: 'runonflux/shared-db:latest',
          ports: {
            peer: { containerPort: 7000, hostPort: 31002 },
            api: { containerPort: 8080, hostPort: 31001 },
          },
        },
      });
      plain = await deploymentWith('plainapp', { web: {} });
    });

    /**
     * The monitor tail-calls itself after a five-minute delay. `delay` resolves
     * the pass-complete promise and then never settles, so one pass is
     * observable and the recursion stops with it.
     */
    function load() {
      let signalPassComplete;
      const passComplete = new Promise((resolve) => { signalPassComplete = resolve; });
      listInstalledDeploymentsStub = sinon.stub().resolves([]);
      axiosGetStub = sinon.stub().resolves({ data: { status: 'OK' } });
      const inspector = proxyquire('../../ZelBack/src/services/appManagement/appInspector', {
        '../dockerService': dockerServiceStub,
        '../appRuntime/deploymentProvider': { listInstalledDeployments: listInstalledDeploymentsStub },
        '../messageHelper': messageHelperStub,
        '../../lib/log': logStub,
        '../serviceHelper': {
          ensureString: sinon.stub().returnsArg(0),
          axiosGet: axiosGetStub,
          delay: () => { signalPassComplete(); return new Promise(() => {}); },
        },
        '../verificationHelper': { verifyPrivilege: sinon.stub().resolves(true) },
        '../utils/appUtilities': { getContainerStorage: sinon.stub().returns(0) },
      });
      return { inspector, passComplete };
    }

    it('polls the operator on the shared-db component last host port', async () => {
      const { inspector, passComplete } = load();
      listInstalledDeploymentsStub.resolves([sharedDb]);

      inspector.monitorSharedDBApps();
      await passComplete;

      // hostPorts is the real component's — deduplicated and sorted ascending —
      // so the API port is 31002 even though the spec lists it second.
      sinon.assert.calledOnceWithExactly(axiosGetStub, 'http://localhost:31002/status');

      const [handed] = await listInstalledDeploymentsStub.firstCall.returnValue;
      assertAnswers(handed, ['componentEntries']);
      const operator = handed.componentEntries().find(([name]) => name === 'operator')[1];
      expect(operator.image).to.equal('runonflux/shared-db:latest');
      expect(operator.hostPorts).to.deep.equal([31001, 31002]);
    });

    it('polls nothing for an app with no shared-db component', async () => {
      const { inspector, passComplete } = load();
      listInstalledDeploymentsStub.resolves([plain]);

      inspector.monitorSharedDBApps();
      await passComplete;

      expect(axiosGetStub.called).to.be.false;
    });
  });

  describe('exported functions', () => {
    it('should export monitoring functions', () => {
      expect(appInspector.startAppMonitoring).to.be.a('function');
      expect(appInspector.stopAppMonitoring).to.be.a('function');
      expect(appInspector.appInspect).to.be.a('function');
      expect(appInspector.appTop).to.be.a('function');
      expect(appInspector.appLog).to.be.a('function');
      expect(appInspector.appStats).to.be.a('function');
      expect(appInspector.appMonitor).to.be.a('function');
      expect(appInspector.appMonitorStream).to.be.a('function');
      expect(appInspector.appChanges).to.be.a('function');
      expect(appInspector.listAppsImages).to.be.a('function');
    });
  });
});
