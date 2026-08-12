'use strict';

// Set NODE_CONFIG_DIR before any requires
if (!process.env.NODE_CONFIG_DIR) {
  process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;
}

const { expect } = require('chai');
const sinon = require('sinon');
const config = require('config');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const appController = require('../../ZelBack/src/services/appManagement/appController');
const globalCommand = require('../../ZelBack/src/services/appManagement/globalCommand');
const dockerService = require('../../ZelBack/src/services/dockerService');
const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');
const appsRuntimeState = require('../../ZelBack/src/services/appManagement/appsRuntimeState');
const reconcilerQueue = require('../../ZelBack/src/services/appMonitoring/reconcilerQueue');
const deploymentProvider = require('../../ZelBack/src/services/appRuntime/deploymentProvider');
const { deserializeSpec } = require('../../ZelBack/src/services/utils/specCutover');

const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const { requireMongo } = require('./dbTestHelper');

describe('appController tests', () => {
  before(requireMongo);

  let verificationHelperStub;
  let db;
  // eslint-disable-next-line no-unused-vars
  let database;

  /**
   * Build an instantiated wrapper around a REAL spec class instance (via the
   * production deserializeSpec dispatch), so deployment builds exercise the
   * actual spec interface — placement, effectiveForReplica, linkedAppNames —
   * instead of a hand-mock that must shadow it. v1-v3 = flat single-container;
   * v4+ = compose.
   * @param {object} opts - { name, version, compose }
   * compose entries: [{ name: 'Component1' }, ...]
   */
  async function mockInstantiated(opts) {
    const doc = opts.version >= 4
      ? {
        version: opts.version,
        name: opts.name,
        description: 't',
        owner: 'testOwner',
        instances: 3,
        contacts: [],
        geolocation: [],
        expire: 88000,
        compose: (opts.compose || []).map((c, index) => ({
          name: c.name,
          description: 'x',
          repotag: c.image || 'test/image:latest',
          ports: [String(31000 + index)],
          domains: [''],
          environmentParameters: [],
          commands: [],
          containerPorts: ['80'],
          containerData: '/data',
          cpu: 0.5,
          ram: 300,
          hdd: 5,
          tiered: false,
        })),
      }
      : {
        version: opts.version,
        name: opts.name,
        description: 't',
        owner: 'testOwner',
        repotag: 'test/image:latest',
        ports: ['31000'],
        domains: [''],
        enviromentParameters: [],
        commands: [],
        containerPorts: ['80'],
        containerData: '/data',
        cpu: 0.5,
        ram: 300,
        hdd: 5,
        instances: 3,
        contacts: [],
        tiered: false,
        expire: 88000,
      };
    const spec = await deserializeSpec(doc);
    if (!spec) throw new Error(`mockInstantiated: deserializeSpec rejected the v${opts.version} fixture`);
    return { name: opts.name, spec };
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

    // Every handler that fans a command across the app's instances resolves
    // this node's address first, and unstubbed it reaches the real benchmark
    // daemon over the network.
    sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.3:16127');

    // Delegates at call time so per-test stubs of buildDeployment flow through
    // the plural entry the handlers use; replica-scoped tests restore this and
    // stub buildDeployments directly.
    sinon.stub(deploymentProvider, 'buildDeployments').callsFake(async (instantiated) => {
      const deployment = await deploymentProvider.buildDeployment(instantiated, { replica: null });
      return deployment ? [deployment] : [];
    });

    // The seam the handlers resolve through. It MIRRORS the real rule - look the
    // app up, then the component by NAME, and answer with the identifier the
    // deployment states - because a stub that just echoed the request string back
    // would make every assertion below pass while testing the bug this replaced.
    // The rule itself is covered against real specs in deploymentProvider.test.js.
    sinon.stub(deploymentProvider, 'resolveRequestTargets').callsFake(async (appname, opts = {}) => {
      const instantiated = await appsRepository.getGlobalAppInfo(appname.split('_')[1] || appname);
      if (!instantiated) throw new Error('Application not found');
      let deployments = await deploymentProvider.buildDeployments(instantiated);
      const { replica = null } = opts;
      if (replica != null) {
        deployments = deployments.filter((d) => d.replica === replica);
        if (deployments.length === 0) {
          throw new Error(`Replica ${replica} of ${instantiated.name} is not deployed on this node`);
        }
      }
      const separator = appname.indexOf('_');
      if (separator === -1) {
        return {
          instantiated,
          deployments,
          ids: deployments.flatMap((d) => d.componentEntries().map(([, c]) => c.identifier)),
        };
      }
      const componentName = appname.slice(0, separator);
      const ids = deployments
        .map((d) => d.getComponent(componentName))
        .filter(Boolean)
        .map((c) => c.identifier);
      if (ids.length === 0) {
        throw new Error(`Component ${componentName} of ${instantiated.name} is not deployed on this node`);
      }
      return { instantiated, deployments, ids };
    });

    sinon.stub(deploymentProvider, 'resolveRequestContainer').callsFake(async (appname, opts = {}) => {
      const { ids } = await deploymentProvider.resolveRequestTargets(appname, opts);
      if (ids.length > 1) throw new Error(`${appname} names ${ids.length} containers on this node`);
      return ids[0];
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('appStart tests', () => {
    let enqueueComponent;
    let setOperatorStopped;
    beforeEach(() => {
      enqueueComponent = sinon.stub(reconcilerQueue, 'enqueueComponent');
      setOperatorStopped = sinon.stub(appsRuntimeState, 'setOperatorStopped').resolves();
    });

    it('clears the operator lock and enqueues the reconciler (no direct docker start)', async () => {
      verificationHelperStub.resolves(true);
      const instantiated = await mockInstantiated({
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
      sinon.assert.calledOnceWithExactly(enqueueComponent, 'TestApp');
      sinon.assert.callOrder(setOperatorStopped, enqueueComponent);
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

    it('drives the identifier the deployment states, not the request string', async () => {
      // The request names a COMPONENT of an app, by the app's name — which is what
      // the UI holds. The container identifier is built from the app's minted
      // identity instead, so the request string is not an identifier and driving it
      // as one keys a component that does not exist.
      verificationHelperStub.resolves(true);
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves({ name: 'TestApp' });
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(stubDeployment([
        { name: 'Component', identifier: 'Component_a1b2c3d4e5f6' },
      ]));

      const req = { params: { appname: 'Component_TestApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };

      await appController.appStart(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('success');
      sinon.assert.calledOnceWithExactly(setOperatorStopped, 'Component_a1b2c3d4e5f6', false);
      sinon.assert.calledOnceWithExactly(enqueueComponent, 'Component_a1b2c3d4e5f6');
    });

    it('refuses a component this node does not hold instead of reporting success', async () => {
      verificationHelperStub.resolves(true);
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves({ name: 'TestApp' });
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(stubDeployment([
        { name: 'Component', identifier: 'Component_TestApp' },
      ]));

      const req = { params: { appname: 'Ghost_TestApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };

      await appController.appStart(req, res);

      expect(res.json.firstCall.args[0].status).to.equal('error');
      sinon.assert.notCalled(enqueueComponent);
      sinon.assert.notCalled(setOperatorStopped);
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
      sinon.assert.calledWithExactly(enqueueComponent, 'Component1_ComposedApp');
      sinon.assert.calledWithExactly(enqueueComponent, 'Component2_ComposedApp');
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

      sinon.stub(globalCommand, 'executeAppGlobalCommand');

      await appController.appStart(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('success');
      expect(result.data.message).to.include('global start');
    });
  });

  describe('appStop tests', () => {
    let enqueueComponent;
    let setOperatorStopped;
    beforeEach(() => {
      enqueueComponent = sinon.stub(reconcilerQueue, 'enqueueComponent');
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
      sinon.assert.calledOnceWithExactly(enqueueComponent, 'TestApp');
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
      sinon.assert.calledTwice(enqueueComponent);
    });

    it('locks the identifier the deployment states, not the request string', async () => {
      verificationHelperStub.resolves(true);
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves({ name: 'TestApp' });
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(stubDeployment([
        { name: 'Component', identifier: 'Component_a1b2c3d4e5f6' },
      ]));

      const req = { params: { appname: 'Component_TestApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };

      await appController.appStop(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('success');
      // the operator lock is durable and nothing ever clears it, so locking a key
      // no component answers to is a lock that can never be lifted
      sinon.assert.calledOnceWithExactly(setOperatorStopped, 'Component_a1b2c3d4e5f6', true);
      sinon.assert.calledOnceWithExactly(enqueueComponent, 'Component_a1b2c3d4e5f6');
    });

    it('records the operator lock BEFORE enqueueing (crash-safe ordering)', async () => {
      // lock-after would let a crash between enqueue and the lock write leave a
      // running container the reconciler keeps running against the operator's intent
      verificationHelperStub.resolves(true);

      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves({ name: 'TestApp' });
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(stubDeployment([
        { name: 'Component', identifier: 'Component_TestApp' },
      ]));

      const req = { params: { appname: 'Component_TestApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };
      await appController.appStop(req, res);

      sinon.assert.calledOnceWithExactly(setOperatorStopped, 'Component_TestApp', true);
      sinon.assert.callOrder(setOperatorStopped, enqueueComponent);
    });
  });

  describe('appRestart tests', () => {
    let enqueueComponent;
    let setOperatorStopped;
    let requestRestart;
    beforeEach(() => {
      enqueueComponent = sinon.stub(reconcilerQueue, 'enqueueComponent');
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
      sinon.assert.calledOnceWithExactly(enqueueComponent, 'TestApp');
      sinon.assert.callOrder(setOperatorStopped, enqueueComponent);
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
      sinon.assert.calledTwice(enqueueComponent);
    });

    it('a whole-app restart of a co-located app covers every local identity', async () => {
      verificationHelperStub.resolves(true);
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves({ name: 'ColoApp' });
      deploymentProvider.buildDeployments.restore();
      sinon.stub(deploymentProvider, 'buildDeployments').resolves([
        { ...stubDeployment([{ name: 'web', identifier: 'web_ColoApp_s1' }]), replica: 's1' },
        { ...stubDeployment([{ name: 'web', identifier: 'web_ColoApp_s2' }]), replica: 's2' },
      ]);

      const req = { params: { appname: 'ColoApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };
      await appController.appRestart(req, res);

      expect(res.json.firstCall.args[0].status).to.equal('success');
      sinon.assert.calledWithExactly(requestRestart, 'web_ColoApp_s1');
      sinon.assert.calledWithExactly(requestRestart, 'web_ColoApp_s2');
    });

    it('a replica-scoped restart (?replica=) targets exactly that identity, sibling untouched', async () => {
      verificationHelperStub.resolves(true);
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves({ name: 'ColoApp' });
      deploymentProvider.buildDeployments.restore();
      sinon.stub(deploymentProvider, 'buildDeployments').resolves([
        { ...stubDeployment([{ name: 'web', identifier: 'web_ColoApp_s1' }]), replica: 's1' },
        { ...stubDeployment([{ name: 'web', identifier: 'web_ColoApp_s2' }]), replica: 's2' },
      ]);

      const req = { params: { appname: 'ColoApp' }, query: { replica: 's2' } };
      const res = { json: sinon.fake((param) => param) };
      await appController.appRestart(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('success');
      expect(result.data).to.include('Replica s2');
      sinon.assert.calledOnceWithExactly(requestRestart, 'web_ColoApp_s2');
      sinon.assert.calledOnceWithExactly(setOperatorStopped, 'web_ColoApp_s2', false);
    });

    it('a replica-scoped restart of an absent replica errors instead of touching anything', async () => {
      verificationHelperStub.resolves(true);
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves({ name: 'ColoApp' });
      deploymentProvider.buildDeployments.restore();
      sinon.stub(deploymentProvider, 'buildDeployments').resolves([
        { ...stubDeployment([{ name: 'web', identifier: 'web_ColoApp_s1' }]), replica: 's1' },
      ]);

      const req = { params: { appname: 'ColoApp' }, query: { replica: 's9' } };
      const res = { json: sinon.fake((param) => param) };
      await appController.appRestart(req, res);

      expect(res.json.firstCall.args[0].status).to.equal('error');
      sinon.assert.notCalled(requestRestart);
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

    it('restarts only the named component, by the identifier it states', async () => {
      verificationHelperStub.resolves(true);
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves({ name: 'ComposedApp' });
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(stubDeployment([
        { name: 'Component1', identifier: 'Component1_a1b2c3d4e5f6' },
        { name: 'Component2', identifier: 'Component2_a1b2c3d4e5f6' },
      ]));

      const req = { params: { appname: 'Component1_ComposedApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };
      await appController.appRestart(req, res);

      sinon.assert.calledOnceWithExactly(setOperatorStopped, 'Component1_a1b2c3d4e5f6', false);
      sinon.assert.calledOnceWithExactly(requestRestart, 'Component1_a1b2c3d4e5f6');
      sinon.assert.calledOnceWithExactly(enqueueComponent, 'Component1_a1b2c3d4e5f6');
    });

    // An activeStandby component restart now routes through the reconciler like any
    // other: the lock is lifted and a reconcile enqueued; the reconciler's election
    // gate decides whether it actually runs (no caller-side skip, no docker call).
    it('routes an activeStandby component restart through the reconciler (no caller-side skip)', async () => {
      verificationHelperStub.resolves(true);

      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves({ name: 'ComposedApp' });
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(stubDeployment([
        { name: 'Gcomp', identifier: 'Gcomp_ComposedApp', activeStandby: true },
      ]));

      const req = { params: { appname: 'Gcomp_ComposedApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };
      await appController.appRestart(req, res);

      sinon.assert.calledOnceWithExactly(setOperatorStopped, 'Gcomp_ComposedApp', false);
      sinon.assert.calledOnceWithExactly(requestRestart, 'Gcomp_ComposedApp');
      sinon.assert.calledOnceWithExactly(enqueueComponent, 'Gcomp_ComposedApp');
    });
  });

  describe('appKill tests', () => {
    let enqueueComponent;
    let setOperatorStopped;
    beforeEach(() => {
      enqueueComponent = sinon.stub(reconcilerQueue, 'enqueueComponent');
      setOperatorStopped = sinon.stub(appsRuntimeState, 'setOperatorStopped').resolves();
    });

    it('sets the durable force-stop lock and enqueues (no direct docker kill)', async () => {
      verificationHelperStub.resolves(true);

      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves({ name: 'TestApp' });
      sinon.stub(deploymentProvider, 'buildDeployment').resolves(stubDeployment([
        { name: 'Component', identifier: 'Component_TestApp' },
      ]));

      const req = { params: { appname: 'Component_TestApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };
      await appController.appKill(req, res);

      sinon.assert.calledOnceWithExactly(setOperatorStopped, 'Component_TestApp', true, { force: true });
      sinon.assert.calledOnceWithExactly(enqueueComponent, 'Component_TestApp');
      sinon.assert.callOrder(setOperatorStopped, enqueueComponent);
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
      sinon.assert.calledOnceWithExactly(enqueueComponent, 'TestApp');
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
      sinon.assert.calledTwice(enqueueComponent);
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
      sinon.assert.notCalled(enqueueComponent);
    });
  });

  describe('appPause tests', () => {
    beforeEach(() => {
      sinon.stub(dockerService, 'appDockerPause').resolves('Flux App TestApp successfully paused.');
    });

    it('should pause app and return success message', async () => {
      verificationHelperStub.resolves(true);
      const instantiated = await mockInstantiated({
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
      const instantiated = await mockInstantiated({
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
      const instantiated = await mockInstantiated({
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
      const instantiated = await mockInstantiated({
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
});
