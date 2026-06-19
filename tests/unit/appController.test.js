// Set NODE_CONFIG_DIR before any requires
if (!process.env.NODE_CONFIG_DIR) {
  process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;
}

const { expect } = require('chai');
const sinon = require('sinon');
const config = require('config');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const appController = require('../../ZelBack/src/services/appManagement/appController');
const dockerService = require('../../ZelBack/src/services/dockerService');
const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');
const appInspector = require('../../ZelBack/src/services/appManagement/appInspector');
const appsRuntimeState = require('../../ZelBack/src/services/appManagement/appsRuntimeState');
const reconcilerQueue = require('../../ZelBack/src/services/appMonitoring/reconcilerQueue');
const deploymentProvider = require('../../ZelBack/src/services/appRuntime/deploymentProvider');

function mockInstantiatedSpec(spec) {
  if (!spec) return null;
  return {
    spec,
    name: spec.name,
    version: spec.version || 4,
    hash: 'testhash',
    height: 1000,
    isEncrypted: () => false,
    serialize: () => ({ ...spec }),
  };
}
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const { requireMongo } = require('./dbTestHelper');

describe('appController tests', () => {
  before(requireMongo);

  let verificationHelperStub;
  let db;
  // eslint-disable-next-line no-unused-vars
  let database;

  /**
   * Build a mock InstantiatedSpec for appController tests.
   * The spec must have .components (object) so the real DeploymentSpec.fromSpec works.
   * @param {object} opts - { name, version, compose }
   * compose entries: [{ name: 'Component1' }, ...]
   */
  function mockInstantiated(opts) {
    const compose = opts.compose || [];
    // Build components object keyed by component name, each with minimal fields
    // that DeploymentSpec.fromSpec needs
    const components = {};
    for (const c of compose) {
      components[c.name] = {
        image: c.image || 'test/image:latest',
        ports: {},
        loadBalancing: {},
        persistentStorage: null,
        environment: {},
        commands: [],
        secrets: [],
        containerData: '',
        // mirrors AppComponentBase.containerIdentifier for compose components
        containerIdentifier: (appName) => `${c.name}_${appName}`,
      };
    }
    const spec = {
      version: opts.version,
      name: opts.name,
      components,
    };
    return {
      name: opts.name,
      spec,
    };
  }

  // The deployment view that deploymentProvider.buildDeployment returns, with
  // explicit component identifiers as scenario inputs. The flat-vs-`name_app`
  // identifier RULE is the domain's (flux-spec) concern, tested on
  // AppComponentFlat/AppComponentV9 - this stub just states what the resolved
  // deployment exposes so appController's own behavior can be asserted.
  function stubDeployment(comps) {
    const byName = {};
    comps.forEach((c) => {
      byName[c.name] = { identifier: c.identifier, hasActiveStandbySyncthing: () => !!c.activeStandby };
    });
    return {
      componentEntries: () => comps.map((c) => [c.name, byName[c.name]]),
      getComponent: (n) => byName[n],
    };
  }

  beforeEach(async () => {
    await dbHelper.initiateDB();
    db = dbHelper.databaseConnection();
    database = db.db(config.database.appsglobal.database);

    // Setup common stubs
    // eslint-disable-next-line global-require
    const verificationHelper = require('../../ZelBack/src/services/verificationHelper');
    verificationHelperStub = sinon.stub(verificationHelper, 'verifyPrivilege');
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('appStart tests', () => {
    let enqueue;
    let setOperatorStopped;
    beforeEach(() => {
      enqueue = sinon.stub(reconcilerQueue, 'enqueue');
      setOperatorStopped = sinon.stub(appsRuntimeState, 'setOperatorStopped').resolves();
    });

    it('clears the operator lock and enqueues the reconciler (no direct docker start)', async () => {
      verificationHelperStub.resolves(true);
      const instantiated = mockInstantiated({
        name: 'TestApp', version: 3, compose: [{ name: 'TestApp' }],
      });
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(instantiated);
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(stubDeployment([
        { name: 'TestApp', identifier: 'TestApp' },
      ]));

      const req = { params: { appname: 'TestApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };

      await appController.appStart(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('success');
      sinon.assert.calledOnceWithExactly(setOperatorStopped, 'TestApp', false);
      sinon.assert.calledOnceWithExactly(enqueue, 'TestApp');
      sinon.assert.callOrder(setOperatorStopped, enqueue);
    });

    it('should return error if no app name provided', async () => {
      verificationHelperStub.resolves(true);

      const req = {
        params: {},
        query: {},
      };
      const res = {
        json: sinon.fake((param) => param),
      };

      await appController.appStart(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('error');
      expect(result.data.message).to.include('No Flux App specified');
    });

    it('should return unauthorized if user not authorized', async () => {
      verificationHelperStub.resolves(false);

      const req = {
        params: { appname: 'TestApp' },
        query: {},
      };
      const res = {
        json: sinon.fake((param) => param),
      };

      await appController.appStart(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('error');
      expect(result.data.code).to.equal(401);
    });

    it('enqueues a single component without a spec lookup', async () => {
      verificationHelperStub.resolves(true);
      const getInfo = sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(null);

      const req = { params: { appname: 'Component_TestApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };

      await appController.appStart(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('success');
      sinon.assert.calledOnceWithExactly(setOperatorStopped, 'Component_TestApp', false);
      sinon.assert.calledOnceWithExactly(enqueue, 'Component_TestApp');
      sinon.assert.notCalled(getInfo);
    });

    it('enqueues every component for a version 4+ app', async () => {
      verificationHelperStub.resolves(true);
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves({ name: 'ComposedApp' });
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(stubDeployment([
        { name: 'Component1', identifier: 'Component1_ComposedApp' },
        { name: 'Component2', identifier: 'Component2_ComposedApp' },
      ]));

      const req = { params: { appname: 'ComposedApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };

      await appController.appStart(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('success');
      sinon.assert.calledWithExactly(enqueue, 'Component1_ComposedApp');
      sinon.assert.calledWithExactly(enqueue, 'Component2_ComposedApp');
      sinon.assert.calledWithExactly(setOperatorStopped, 'Component1_ComposedApp', false);
      sinon.assert.calledWithExactly(setOperatorStopped, 'Component2_ComposedApp', false);
    });

    it('should handle global start parameter', async () => {
      verificationHelperStub.resolves(true);

      const req = {
        params: { appname: 'TestApp', global: 'true' },
        query: {},
        headers: { zelidauth: 'test-auth' },
      };
      const res = {
        json: sinon.fake((param) => param),
      };

      sinon.stub(appController, 'executeAppGlobalCommand');

      await appController.appStart(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('success');
      expect(result.data.message).to.include('global start');
    });
  });

  describe('appStop tests', () => {
    let enqueue;
    let setOperatorStopped;
    beforeEach(() => {
      enqueue = sinon.stub(reconcilerQueue, 'enqueue');
      setOperatorStopped = sinon.stub(appsRuntimeState, 'setOperatorStopped').resolves();
    });

    it('sets the operator stop lock and enqueues the reconciler (no direct docker stop)', async () => {
      verificationHelperStub.resolves(true);
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves({ name: 'TestApp' });
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(stubDeployment([
        { name: 'TestApp', identifier: 'TestApp' },
      ]));

      const req = { params: { appname: 'TestApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };

      await appController.appStop(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('success');
      sinon.assert.calledOnceWithExactly(setOperatorStopped, 'TestApp', true);
      sinon.assert.calledOnceWithExactly(enqueue, 'TestApp');
    });

    it('locks and enqueues every component for a version 4+ app', async () => {
      verificationHelperStub.resolves(true);
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves({ name: 'ComposedApp' });
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(stubDeployment([
        { name: 'Component1', identifier: 'Component1_ComposedApp' },
        { name: 'Component2', identifier: 'Component2_ComposedApp' },
      ]));

      const req = { params: { appname: 'ComposedApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };

      await appController.appStop(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('success');
      sinon.assert.calledWithExactly(setOperatorStopped, 'Component1_ComposedApp', true);
      sinon.assert.calledWithExactly(setOperatorStopped, 'Component2_ComposedApp', true);
      sinon.assert.calledTwice(enqueue);
    });

    it('locks and enqueues a single component without a spec lookup', async () => {
      verificationHelperStub.resolves(true);
      const getInfo = sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(null);

      const req = { params: { appname: 'Component_TestApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };

      await appController.appStop(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('success');
      sinon.assert.calledOnceWithExactly(setOperatorStopped, 'Component_TestApp', true);
      sinon.assert.calledOnceWithExactly(enqueue, 'Component_TestApp');
      sinon.assert.notCalled(getInfo);
    });

    it('records the operator lock BEFORE enqueueing (crash-safe ordering)', async () => {
      // lock-after would let a crash between enqueue and the lock write leave a
      // running container the reconciler keeps running against the operator's intent
      verificationHelperStub.resolves(true);

      const req = { params: { appname: 'Component_TestApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };
      await appController.appStop(req, res);

      sinon.assert.calledOnceWithExactly(setOperatorStopped, 'Component_TestApp', true);
      sinon.assert.callOrder(setOperatorStopped, enqueue);
    });
  });

  describe('appRestart tests', () => {
    let enqueue;
    let setOperatorStopped;
    let requestRestart;
    beforeEach(() => {
      enqueue = sinon.stub(reconcilerQueue, 'enqueue');
      setOperatorStopped = sinon.stub(appsRuntimeState, 'setOperatorStopped').resolves();
      requestRestart = sinon.stub(appsRuntimeState, 'requestRestart').resolves();
    });

    it('clears the lock, bumps the restart generation and enqueues (no direct docker restart)', async () => {
      verificationHelperStub.resolves(true);
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves({ name: 'TestApp' });
      // a flat (v1-3) app: its single component is identified by the bare app name
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(stubDeployment([
        { name: 'TestApp', identifier: 'TestApp' },
      ]));

      const req = { params: { appname: 'TestApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };
      await appController.appRestart(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('success');
      sinon.assert.calledOnceWithExactly(setOperatorStopped, 'TestApp', false);
      sinon.assert.calledOnceWithExactly(requestRestart, 'TestApp');
      sinon.assert.calledOnceWithExactly(enqueue, 'TestApp');
      sinon.assert.callOrder(setOperatorStopped, enqueue);
    });

    it('restarts every component of a composed app through the reconciler', async () => {
      verificationHelperStub.resolves(true);
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves({ name: 'ComposedApp' });
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(stubDeployment([
        { name: 'Component1', identifier: 'Component1_ComposedApp' },
        { name: 'Component2', identifier: 'Component2_ComposedApp' },
      ]));

      const req = { params: { appname: 'ComposedApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };
      await appController.appRestart(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('success');
      sinon.assert.calledWithExactly(requestRestart, 'Component1_ComposedApp');
      sinon.assert.calledWithExactly(requestRestart, 'Component2_ComposedApp');
      sinon.assert.calledTwice(enqueue);
    });

    it('should return unauthorized if user not authorized', async () => {
      verificationHelperStub.resolves(false);

      const req = {
        params: { appname: 'TestApp' },
        query: {},
      };
      const res = {
        json: sinon.fake((param) => param),
      };

      await appController.appRestart(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('error');
      expect(result.data.code).to.equal(401);
    });

    it('restarts only the named component on a component restart (no spec lookup)', async () => {
      verificationHelperStub.resolves(true);
      const getInfo = sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(null);

      const req = { params: { appname: 'Component1_ComposedApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };
      await appController.appRestart(req, res);

      sinon.assert.calledOnceWithExactly(setOperatorStopped, 'Component1_ComposedApp', false);
      sinon.assert.calledOnceWithExactly(requestRestart, 'Component1_ComposedApp');
      sinon.assert.calledOnceWithExactly(enqueue, 'Component1_ComposedApp');
      sinon.assert.notCalled(getInfo);
    });

    // An activeStandby component restart now routes through the reconciler like any
    // other: the lock is lifted and a reconcile enqueued; the reconciler's election
    // gate decides whether it actually runs (no caller-side skip, no docker call).
    it('routes an activeStandby component restart through the reconciler (no caller-side skip)', async () => {
      verificationHelperStub.resolves(true);

      const req = { params: { appname: 'Gcomp_ComposedApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };
      await appController.appRestart(req, res);

      sinon.assert.calledOnceWithExactly(setOperatorStopped, 'Gcomp_ComposedApp', false);
      sinon.assert.calledOnceWithExactly(requestRestart, 'Gcomp_ComposedApp');
      sinon.assert.calledOnceWithExactly(enqueue, 'Gcomp_ComposedApp');
    });
  });

  describe('appKill tests', () => {
    let enqueue;
    let setOperatorStopped;
    beforeEach(() => {
      enqueue = sinon.stub(reconcilerQueue, 'enqueue');
      setOperatorStopped = sinon.stub(appsRuntimeState, 'setOperatorStopped').resolves();
    });

    it('sets the durable force-stop lock and enqueues (no direct docker kill)', async () => {
      verificationHelperStub.resolves(true);

      const req = { params: { appname: 'Component_TestApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };
      await appController.appKill(req, res);

      sinon.assert.calledOnceWithExactly(setOperatorStopped, 'Component_TestApp', true, { force: true });
      sinon.assert.calledOnceWithExactly(enqueue, 'Component_TestApp');
      sinon.assert.callOrder(setOperatorStopped, enqueue);
    });

    it('should kill app and return success message', async () => {
      verificationHelperStub.resolves(true);
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves({ name: 'TestApp' });
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(stubDeployment([
        { name: 'TestApp', identifier: 'TestApp' },
      ]));

      const req = { params: { appname: 'TestApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };

      await appController.appKill(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('success');
      sinon.assert.calledOnceWithExactly(setOperatorStopped, 'TestApp', true, { force: true });
      sinon.assert.calledOnceWithExactly(enqueue, 'TestApp');
    });

    it('force-stops every component for a version 4+ app', async () => {
      verificationHelperStub.resolves(true);
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves({ name: 'ComposedApp' });
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(stubDeployment([
        { name: 'Component1', identifier: 'Component1_ComposedApp' },
        { name: 'Component2', identifier: 'Component2_ComposedApp' },
      ]));

      const req = { params: { appname: 'ComposedApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };

      await appController.appKill(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('success');
      sinon.assert.calledWithExactly(setOperatorStopped, 'Component1_ComposedApp', true, { force: true });
      sinon.assert.calledWithExactly(setOperatorStopped, 'Component2_ComposedApp', true, { force: true });
      sinon.assert.calledTwice(enqueue);
    });

    it('should return error if app not found', async () => {
      verificationHelperStub.resolves(true);
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(null);

      const req = {
        params: { appname: 'NonExistentApp' },
        query: {},
      };
      const res = {
        json: sinon.fake((param) => param),
      };

      await appController.appKill(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('error');
      expect(result.data.message).to.include('Application not found');
      sinon.assert.notCalled(enqueue);
    });
  });

  describe('appPause tests', () => {
    beforeEach(() => {
      sinon.stub(dockerService, 'appDockerPause').resolves('Flux App TestApp successfully paused.');
    });

    it('should pause app and return success message', async () => {
      verificationHelperStub.resolves(true);
      const instantiated = mockInstantiated({
        name: 'TestApp', version: 3, compose: [{ name: 'TestApp' }],
      });
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(instantiated);


      const req = {
        params: { appname: 'TestApp' },
        query: {},
      };
      const res = {
        json: sinon.fake((param) => param),
      };

      await appController.appPause(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('success');
      sinon.assert.calledOnce(dockerService.appDockerPause);
    });

    it('should pause all components for version 4+ apps', async () => {
      verificationHelperStub.resolves(true);
      const instantiated = mockInstantiated({
        name: 'ComposedApp', version: 4, compose: [{ name: 'Component1' }, { name: 'Component2' }],
      });
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(instantiated);


      const req = {
        params: { appname: 'ComposedApp' },
        query: {},
      };
      const res = {
        json: sinon.fake((param) => param),
      };

      await appController.appPause(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('success');
      sinon.assert.calledTwice(dockerService.appDockerPause);
    });
  });

  describe('appUnpause tests', () => {
    beforeEach(() => {
      sinon.stub(dockerService, 'appDockerUnpause').resolves('Flux App TestApp successfully unpaused.');
    });

    it('should unpause app and return success message', async () => {
      verificationHelperStub.resolves(true);
      const instantiated = mockInstantiated({
        name: 'TestApp', version: 3, compose: [{ name: 'TestApp' }],
      });
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(instantiated);


      const req = {
        params: { appname: 'TestApp' },
        query: {},
      };
      const res = {
        json: sinon.fake((param) => param),
      };

      await appController.appUnpause(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('success');
      sinon.assert.calledOnce(dockerService.appDockerUnpause);
    });

    it('should unpause all components for version 4+ apps', async () => {
      verificationHelperStub.resolves(true);
      const instantiated = mockInstantiated({
        name: 'ComposedApp', version: 4, compose: [{ name: 'Component1' }, { name: 'Component2' }],
      });
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(instantiated);


      const req = {
        params: { appname: 'ComposedApp' },
        query: {},
      };
      const res = {
        json: sinon.fake((param) => param),
      };

      await appController.appUnpause(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('success');
      sinon.assert.calledTwice(dockerService.appDockerUnpause);
    });
  });

  describe('stopAllNonFluxRunningApps tests', () => {
    it('should stop all non-Flux apps', async () => {
      const nonFluxApps = [
        { Id: 'container1', Names: ['/testapp1'] },
        { Id: 'container2', Names: ['/testapp2'] },
      ];
      const fluxApps = [
        { Id: 'container3', Names: ['/fluxapp1'] },
      ];

      sinon.stub(dockerService, 'dockerListContainers').resolves([...nonFluxApps, ...fluxApps]);
      const stopStub = sinon.stub(dockerService, 'appDockerStop').resolves();
      const clock = sinon.useFakeTimers();

      // Start the function (it will call itself recursively)
      appController.stopAllNonFluxRunningApps();

      // Wait for first iteration to complete
      await clock.tickAsync(100);

      // Verify only non-Flux apps were stopped
      sinon.assert.calledTwice(stopStub);
      sinon.assert.calledWith(stopStub.firstCall, 'container1');
      sinon.assert.calledWith(stopStub.secondCall, 'container2');

      clock.restore();
    });
  });

  describe('executeAppGlobalCommand tests', () => {
    beforeEach(() => {
      const locations = [
        { ip: '192.168.1.1:16127', name: 'TestApp' },
        { ip: '192.168.1.2:16127', name: 'TestApp' },
      ];
      sinon.stub(appsRepository, 'listLocationsByApp').resolves(locations);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.3:16127');
    });

    it('should execute command on all app instances', async () => {
      // eslint-disable-next-line global-require
      const axios = require('axios');
      const axiosStub = sinon.stub(axios, 'get').resolves({ status: 200 });

      await appController.executeAppGlobalCommand('TestApp', 'appstart', 'test-auth');

      sinon.assert.calledTwice(axiosStub);
    });

    it('should skip own IP when bypassMyIp is true', async () => {
      sinon.restore();
      const locations = [
        { ip: '192.168.1.3:16127', name: 'TestApp' },
        { ip: '192.168.1.2:16127', name: 'TestApp' },
      ];
      sinon.stub(appsRepository, 'listLocationsByApp').resolves(locations);
      // eslint-disable-next-line global-require, no-shadow
      const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.3:16127');

      // eslint-disable-next-line global-require
      const axios = require('axios');
      const axiosStub = sinon.stub(axios, 'get').resolves({ status: 200 });

      await appController.executeAppGlobalCommand('TestApp', 'appstart', 'test-auth', null, true);

      // Should only call once, skipping own IP
      sinon.assert.calledOnce(axiosStub);
    });
  });
});
