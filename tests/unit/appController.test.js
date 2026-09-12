'use strict';

// Set NODE_CONFIG_DIR before any requires
if (!process.env.NODE_CONFIG_DIR) {
  process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;
}

const { expect } = require('chai');
const sinon = require('sinon');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const appController = require('../../ZelBack/src/services/appManagement/appController');
const globalCommand = require('../../ZelBack/src/services/appManagement/globalCommand');
const dockerService = require('../../ZelBack/src/services/dockerService');
const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');
const appsRuntimeState = require('../../ZelBack/src/services/appManagement/appsRuntimeState');
const reconcilerQueue = require('../../ZelBack/src/services/appMonitoring/reconcilerQueue');
const appReconciler = require('../../ZelBack/src/services/appMonitoring/appReconciler');
const deploymentProvider = require('../../ZelBack/src/services/appRuntime/deploymentProvider');
const mastershipGrantGate = require('../../ZelBack/src/services/appLifecycle/mastershipGrantGate');
const generalService = require('../../ZelBack/src/services/generalService');
const fluxEventBus = require('../../ZelBack/src/services/utils/fluxEventBus');

const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const { requireMongo } = require('./dbTestHelper');
const {
  loadSpecLibrary, V8_SUBMISSION, V9_SUBMISSION, v1Spec, v8Spec, v9Spec, instantiatedSpec,
} = require('./fixtures/fluxSpec');

// The spec library is REAL here, and so is the whole resolution chain beneath
// these handlers — see tests/unit/fixtures/fluxSpec.js for why. Every handler
// resolves its targets through deploymentProvider, which builds a real
// DeploymentSpec from a real InstantiatedSpec, so the container identifiers
// asserted below are MINTED by flux-spec rather than stated by the test.
//
// That is the whole point of this file: the bug it exists to catch is a handler
// driving the request string as if it were a container identifier, and a stubbed
// deployment can only ever answer with the identifier the test already wrote
// down. With the real class, the identifier follows the app's stored identity —
// so the two genuinely differ, and an assertion on one is not the other.
//
// What stays stubbed is I/O and durable state: the mongo read behind
// getGlobalAppInfo, the docker calls, this node's socket address and collateral
// outpoint (daemon/benchmark reads), and the runtime-state writes whose ORDER
// against the reconciler enqueue is what several of these tests assert.

// This node's identity, as the stubs below report it. A pinned v9 assignment
// keyed on this address is what puts a replica on "this" node.
const THIS_NODE = '192.168.1.3:16127';
const NODE_OUTPOINT_TXID = 'a'.repeat(64);

describe('appController tests', () => {
  let observedStateStub;
  before(requireMongo);

  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30_000);
    await loadSpecLibrary();
  });

  let verificationHelperStub;

  /**
   * A real flat app (v1): one container, identified by the bare app name. v1 is
   * the only stored version with no `instances` field, and the flat versions are
   * the ones whose single component takes the app's own name — neither is
   * something a literal can be trusted to reproduce.
   */
  async function flatApp(name = 'TestApp', state = {}) {
    return instantiatedSpec(await v1Spec({ name }), state);
  }

  /**
   * A real composed app (v8): one container per component, identified
   * `<component>_<identity>` — where the identity falls back to the app NAME only
   * for a row minted before identities existed. Pass `state.identity` for a
   * modern row, which is exactly where request string and identifier diverge.
   */
  async function composedApp(name, componentNames, state = {}) {
    const spec = await v8Spec({
      name,
      compose: componentNames.map((component, index) => ({
        ...V8_SUBMISSION.compose[0],
        name: component,
        ports: [31_000 + index],
        containerPorts: [80 + index],
      })),
    });
    return instantiatedSpec(spec, state);
  }

  /**
   * A real co-located app (v9): named replicas PINNED to this node by IP. The
   * replica names live in the assignment and everything else — pinned mode,
   * `instances`, the per-replica identifiers — is derived from it by the real
   * class. Co-located replicas must not collide on a host port, so every replica
   * after the first carries a hostPort override; the library refuses the spec
   * otherwise, which a hand-written deployment double cannot express.
   */
  async function colocatedApp(name, replicas) {
    const base = V9_SUBMISSION.components.web;
    const replicaOverrides = {};
    replicas.slice(1).forEach((replica, index) => {
      replicaOverrides[replica] = { ports: { http: { hostPort: 31_001 + index } } };
    });
    const spec = await v9Spec({
      name,
      instances: replicas.length,
      assignment: { targetIps: { [THIS_NODE]: replicas } },
      components: { web: { ...base, replicaOverrides } },
    });
    return instantiatedSpec(spec);
  }

  /** A real v9 app whose single component replicates active/standby. */
  async function activeStandbyApp(name, component) {
    const base = V9_SUBMISSION.components.web;
    const spec = await v9Spec({
      name,
      components: {
        [component]: {
          ...base,
          name: component,
          persistentStorage: { ...base.persistentStorage, sync: { mode: 'activeStandby' } },
        },
      },
    });
    return instantiatedSpec(spec);
  }

  /** The one mongo read these handlers make, on the way into the real resolver. */
  function registryHolds(instantiated) {
    return sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(instantiated);
  }

  /**
   * The handlers drive intent through reconcilerQueue.applyIntent, which holds
   * the component's slot across the write and enqueues on release. Stubbed with
   * a fake that RUNS the mutate - the lock assertions are about what the mutate
   * writes - and records the identifier, so "enqueues the reconciler" keeps
   * asserting the same thing through the function that now does it.
   *
   * Stubbing reconcilerQueue.enqueueComponent no longer sees these: the real
   * applyIntent calls its own module-local binding, not the exported property.
   */
  function stubApplyIntent() {
    const enqueued = sinon.stub();
    sinon.stub(reconcilerQueue, 'applyIntent').callsFake(async (id, mutate) => {
      await mutate();
      enqueued(id);
      return true;
    });
    return enqueued;
  }

  /** What the settle probe reads. Running by default; the stop and kill blocks say otherwise. */
  function containersAre({ running }) {
    observedStateStub.resolves({
      reachable: true, exists: true, running, exitCode: null, health: null,
    });
  }

  beforeEach(async () => {
    await dbHelper.initiateDB();

    // The four run-state handlers probe what actually happened before they
    // answer, so this is reached on every one of them. Unstubbed it inspects
    // real containers.
    observedStateStub = sinon.stub(appReconciler, 'observedContainerState').resolves({
      reachable: true, exists: true, running: true, exitCode: null, health: null,
    });

    // Setup common stubs
    // eslint-disable-next-line global-require
    const verificationHelper = require('../../ZelBack/src/services/verificationHelper');
    verificationHelperStub = sinon.stub(verificationHelper, 'verifyPrivilege');

    // This node's identity, as a PINNED placement matches it against. Unstubbed
    // these reach the benchmark daemon and the local node's collateral over the
    // network; the matching itself is the real Placement/Assignment machinery.
    sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves(THIS_NODE);
    sinon.stub(generalService, 'obtainNodeCollateralInformation').resolves({
      txhash: NODE_OUTPOINT_TXID, txindex: 0,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('appStart tests', () => {
    let enqueueComponent;
    let setOperatorStopped;
    beforeEach(() => {
      enqueueComponent = stubApplyIntent();
      setOperatorStopped = sinon.stub(appsRuntimeState, 'setOperatorStopped').resolves();
    });

    it('clears the operator lock and enqueues the reconciler (no direct docker start)', async () => {
      verificationHelperStub.resolves(true);
      registryHolds(await flatApp('TestApp'));

      const req = { params: { appname: 'TestApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };

      await appController.appStart(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('success');
      sinon.assert.calledOnceWithExactly(setOperatorStopped, 'TestApp', false);
      sinon.assert.calledOnceWithExactly(enqueueComponent, 'TestApp');
      sinon.assert.callOrder(setOperatorStopped, enqueueComponent);
    });

    it('withdraws a decider verdict recorded before the stop, so the decider rules again', async () => {
      verificationHelperStub.resolves(true);
      const clearControllerDesired = sinon.stub(appReconciler, 'clearControllerDesired');
      registryHolds(await flatApp('TestApp'));

      const req = { params: { appname: 'TestApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };

      await appController.appStart(req, res);

      expect(res.json.firstCall.args[0].status).to.equal('success');
      sinon.assert.calledOnceWithExactly(clearControllerDesired, 'TestApp');
      sinon.assert.callOrder(clearControllerDesired, enqueueComponent);
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
      const held = await composedApp('TestApp', ['Component'], { identity: 'a1b2c3d4e5f6' });
      registryHolds(held);

      const req = { params: { appname: 'Component_TestApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };

      await appController.appStart(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('success');
      // Minted by the real DeploymentSpec off the row's identity — the request
      // string 'Component_TestApp' is a different string, and that is the point.
      expect(held.identity).to.equal('a1b2c3d4e5f6');
      sinon.assert.calledOnceWithExactly(setOperatorStopped, 'Component_a1b2c3d4e5f6', false);
      sinon.assert.calledOnceWithExactly(enqueueComponent, 'Component_a1b2c3d4e5f6');
    });

    it('refuses a component this node does not hold instead of reporting success', async () => {
      verificationHelperStub.resolves(true);
      registryHolds(await composedApp('TestApp', ['Component']));

      const req = { params: { appname: 'Ghost_TestApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };

      await appController.appStart(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('error');
      expect(result.data.message).to.include('Component Ghost of TestApp is not deployed');
      sinon.assert.notCalled(enqueueComponent);
      sinon.assert.notCalled(setOperatorStopped);
    });

    it('enqueues every component for a version 4+ app', async () => {
      verificationHelperStub.resolves(true);
      registryHolds(await composedApp('ComposedApp', ['Component1', 'Component2']));

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
      enqueueComponent = stubApplyIntent();
      setOperatorStopped = sinon.stub(appsRuntimeState, 'setOperatorStopped').resolves();
    });

    it('sets the operator stop lock and enqueues the reconciler (no direct docker stop)', async () => {
      verificationHelperStub.resolves(true);
      registryHolds(await flatApp('TestApp'));

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
      registryHolds(await composedApp('ComposedApp', ['Component1', 'Component2']));

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
      registryHolds(await composedApp('TestApp', ['Component'], { identity: 'a1b2c3d4e5f6' }));

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
      registryHolds(await composedApp('TestApp', ['Component']));

      const req = { params: { appname: 'Component_TestApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };
      await appController.appStop(req, res);

      sinon.assert.calledOnceWithExactly(setOperatorStopped, 'Component_TestApp', true);
      sinon.assert.callOrder(setOperatorStopped, enqueueComponent);
    });
  });

  describe('appYield tests', () => {
    let enqueueComponent;
    let setOperatorStopped;
    let yieldMastership;
    beforeEach(() => {
      enqueueComponent = stubApplyIntent();
      setOperatorStopped = sinon.stub(appsRuntimeState, 'setOperatorStopped').resolves();
      yieldMastership = sinon.stub(mastershipGrantGate, 'yieldMastership').resolves({ held: true });
    });

    // The logic function takes plain arguments — express objects never leave
    // the Api wrapper.
    it('locks the operator stop BEFORE releasing — the gate must never re-acquire its own yield', async () => {
      // Fleet-proven ordering: release-then-lock left a window where this
      // node's own gate re-acquired the freshly released term (no lock-delay
      // on a released grant, and the ex-master is fastest to its registers).
      // With the lock first, an in-flight pursuit still sees the held key
      // and the gate is unconsulted afterwards.
      registryHolds(await flatApp('TestApp'));

      const outcome = await appController.appYield('TestApp');

      expect(outcome.held).to.equal(true);
      sinon.assert.calledOnceWithExactly(yieldMastership, 'TestApp');
      sinon.assert.calledOnceWithExactly(setOperatorStopped, 'TestApp', true);
      sinon.assert.callOrder(setOperatorStopped, yieldMastership);
      sinon.assert.calledOnceWithExactly(enqueueComponent, 'TestApp');
    });

    it('still stops when this node holds nothing — the global fan-out stays idempotent', async () => {
      yieldMastership.resolves({ held: false });
      registryHolds(await flatApp('TestApp'));

      const outcome = await appController.appYield('TestApp');

      expect(outcome.held).to.equal(false);
      sinon.assert.calledOnceWithExactly(setOperatorStopped, 'TestApp', true);
    });

    it('yields the APP mastership even when a component is named — grants are app-scoped', async () => {
      registryHolds(await composedApp('TestApp', ['Component']));

      await appController.appYield('Component_TestApp');

      sinon.assert.calledOnceWithExactly(yieldMastership, 'TestApp');
      sinon.assert.calledOnceWithExactly(setOperatorStopped, 'Component_TestApp', true);
    });

    it('Api wrapper: refuses the unauthorized and never touches the logic', async () => {
      verificationHelperStub.resolves(false);

      const req = { params: { appname: 'TestApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };
      await appController.appYieldApi(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('error');
      sinon.assert.notCalled(yieldMastership);
      sinon.assert.notCalled(setOperatorStopped);
    });

    it('Api wrapper: global fans out the appyield verb and does not run locally', async () => {
      verificationHelperStub.resolves(true);
      const fanout = sinon.stub(globalCommand, 'executeAppGlobalCommand');

      const req = { params: { appname: 'TestApp', global: 'true' }, query: {}, headers: { zelidauth: 'auth' } };
      const res = { json: sinon.fake((param) => param) };
      await appController.appYieldApi(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('success');
      sinon.assert.calledOnce(fanout);
      expect(fanout.firstCall.args[1]).to.equal('appyield');
      sinon.assert.notCalled(yieldMastership);
    });
  });

  describe('appRestart tests', () => {
    let enqueueComponent;
    let setOperatorStopped;
    let requestRestart;
    beforeEach(() => {
      enqueueComponent = stubApplyIntent();
      setOperatorStopped = sinon.stub(appsRuntimeState, 'setOperatorStopped').resolves();
      requestRestart = sinon.stub(appsRuntimeState, 'requestRestart').resolves();
    });

    it('clears the lock, bumps the restart generation and enqueues (no direct docker restart)', async () => {
      verificationHelperStub.resolves(true);
      // a flat (v1-3) app: its single component is identified by the bare app name
      registryHolds(await flatApp('TestApp'));

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

    it('withdraws a decider verdict recorded before the stop, so the decider rules again', async () => {
      verificationHelperStub.resolves(true);
      const clearControllerDesired = sinon.stub(appReconciler, 'clearControllerDesired');
      registryHolds(await flatApp('TestApp'));

      const req = { params: { appname: 'TestApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };
      await appController.appRestart(req, res);

      expect(res.json.firstCall.args[0].status).to.equal('success');
      sinon.assert.calledOnceWithExactly(clearControllerDesired, 'TestApp');
      sinon.assert.callOrder(clearControllerDesired, enqueueComponent);
    });

    it('restarts every component of a composed app through the reconciler', async () => {
      verificationHelperStub.resolves(true);
      registryHolds(await composedApp('ComposedApp', ['Component1', 'Component2']));

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
      const held = await colocatedApp('coloapp', ['s1', 's2']);
      registryHolds(held);
      // The two identities are real: pinned placement derived from the assignment
      // map, matched against this node's socket address by flux-spec.
      const deployments = await deploymentProvider.buildDeployments(held);
      expect(deployments.map((d) => d.replica)).to.deep.equal(['s1', 's2']);

      const req = { params: { appname: 'coloapp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };
      await appController.appRestart(req, res);

      expect(res.json.firstCall.args[0].status).to.equal('success');
      sinon.assert.calledWithExactly(requestRestart, 'web_coloapp_s1');
      sinon.assert.calledWithExactly(requestRestart, 'web_coloapp_s2');
    });

    it('a replica-scoped restart (?replica=) targets exactly that identity, sibling untouched', async () => {
      verificationHelperStub.resolves(true);
      registryHolds(await colocatedApp('coloapp', ['s1', 's2']));

      const req = { params: { appname: 'coloapp' }, query: { replica: 's2' } };
      const res = { json: sinon.fake((param) => param) };
      await appController.appRestart(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('success');
      expect(result.data).to.include('Replica s2');
      sinon.assert.calledOnceWithExactly(requestRestart, 'web_coloapp_s2');
      sinon.assert.calledOnceWithExactly(setOperatorStopped, 'web_coloapp_s2', false);
    });

    it('a replica-scoped restart of an absent replica errors instead of touching anything', async () => {
      verificationHelperStub.resolves(true);
      registryHolds(await colocatedApp('coloapp', ['s1']));

      const req = { params: { appname: 'coloapp' }, query: { replica: 's9' } };
      const res = { json: sinon.fake((param) => param) };
      await appController.appRestart(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('error');
      expect(result.data.message).to.include('Replica s9 of coloapp is not deployed');
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
      registryHolds(await composedApp('ComposedApp', ['Component1', 'Component2'], { identity: 'a1b2c3d4e5f6' }));

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
      const held = await activeStandbyApp('composedapp', 'gcomp');
      registryHolds(held);
      const dockerStop = sinon.stub(dockerService, 'appDockerStop');
      // Really active/standby, by the real component's own reading of the spec —
      // otherwise this test proves nothing about the branch it names.
      const [deployment] = await deploymentProvider.buildDeployments(held);
      expect(deployment.getComponent('gcomp').hasActiveStandbySyncthing()).to.equal(true);

      const req = { params: { appname: 'gcomp_composedapp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };
      await appController.appRestart(req, res);

      sinon.assert.calledOnceWithExactly(setOperatorStopped, 'gcomp_composedapp', false);
      sinon.assert.calledOnceWithExactly(requestRestart, 'gcomp_composedapp');
      sinon.assert.calledOnceWithExactly(enqueueComponent, 'gcomp_composedapp');
      sinon.assert.notCalled(dockerStop);
    });
  });

  describe('appKill tests', () => {
    let enqueueComponent;
    let setOperatorStopped;
    beforeEach(() => {
      enqueueComponent = stubApplyIntent();
      setOperatorStopped = sinon.stub(appsRuntimeState, 'setOperatorStopped').resolves();
    });

    it('sets the durable force-stop lock and enqueues (no direct docker kill)', async () => {
      verificationHelperStub.resolves(true);
      registryHolds(await composedApp('TestApp', ['Component']));

      const req = { params: { appname: 'Component_TestApp' }, query: {} };
      const res = { json: sinon.fake((param) => param) };
      await appController.appKill(req, res);

      sinon.assert.calledOnceWithExactly(setOperatorStopped, 'Component_TestApp', true, { force: true });
      sinon.assert.calledOnceWithExactly(enqueueComponent, 'Component_TestApp');
      sinon.assert.callOrder(setOperatorStopped, enqueueComponent);
    });

    it('should kill app and return success message', async () => {
      verificationHelperStub.resolves(true);
      registryHolds(await flatApp('TestApp'));

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
      registryHolds(await composedApp('ComposedApp', ['Component1', 'Component2']));

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
      registryHolds(null);

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

  describe('the order a composed app moves in, and what the operator is told', () => {
    let setOperatorStopped;
    let enqueued;
    let published;

    beforeEach(() => {
      enqueued = stubApplyIntent();
      setOperatorStopped = sinon.stub(appsRuntimeState, 'setOperatorStopped').resolves();
      sinon.stub(appsRuntimeState, 'requestRestart').resolves();
      sinon.stub(appReconciler, 'clearControllerDesired');
      published = sinon.stub(fluxEventBus, 'publish');
      verificationHelperStub.resolves(true);
    });

    const reqFor = (appname) => ({ params: { appname }, query: {} });
    const res = () => ({ json: sinon.fake((param) => param) });
    // Pinned by INDEX, never by calledWith: calledWith holds whichever way round
    // the components are addressed, so an order assertion written that way stays
    // green under its own title while the order is wrong.
    const orderOf = (stub) => stub.getCalls().map((c) => c.args[0]);

    it('takes a composed app down in the reverse of the order it comes up', async () => {
      registryHolds(await composedApp('ComposedApp', ['Component1', 'Component2']));
      containersAre({ running: false });

      await appController.appStop(reqFor('ComposedApp'), res());

      // The database stops after the server it serves, not before it.
      expect(orderOf(enqueued)).to.deep.equal(['Component2_ComposedApp', 'Component1_ComposedApp']);
      expect(orderOf(setOperatorStopped)).to.deep.equal(['Component2_ComposedApp', 'Component1_ComposedApp']);
    });

    it('kills in the same reverse order', async () => {
      registryHolds(await composedApp('ComposedApp', ['Component1', 'Component2']));
      containersAre({ running: false });

      await appController.appKill(reqFor('ComposedApp'), res());

      expect(orderOf(enqueued)).to.deep.equal(['Component2_ComposedApp', 'Component1_ComposedApp']);
    });

    // The control. A blanket reverse would satisfy both cases above while
    // inverting startup, so the forward direction is pinned too.
    it('brings it back up in compose order', async () => {
      registryHolds(await composedApp('ComposedApp', ['Component1', 'Component2']));

      await appController.appStart(reqFor('ComposedApp'), res());

      expect(orderOf(enqueued)).to.deep.equal(['Component1_ComposedApp', 'Component2_ComposedApp']);
    });

    it('restarts in compose order too', async () => {
      registryHolds(await composedApp('ComposedApp', ['Component1', 'Component2']));

      await appController.appRestart(reqFor('ComposedApp'), res());

      expect(orderOf(enqueued)).to.deep.equal(['Component1_ComposedApp', 'Component2_ComposedApp']);
    });

    it('does not reorder the caller\'s id array, which it goes on to probe', async () => {
      registryHolds(await composedApp('ComposedApp', ['Component1', 'Component2']));
      containersAre({ running: false });
      const probed = [];
      observedStateStub.callsFake(async (id) => {
        probed.push(id);
        return { reachable: true, exists: true, running: false };
      });

      await appController.appStop(reqFor('ComposedApp'), res());

      // Reversed on a copy: the probe still walks the resolved order.
      expect(probed).to.deep.equal(['Component1_ComposedApp', 'Component2_ComposedApp']);
    });

    describe('app:operatorIntent', () => {
      const intentsOf = () => published.getCalls()
        .filter((c) => c.args[0] === 'app:operatorIntent')
        .map((c) => c.args[1]);

      it('announces a stop, carrying the force mode and the bare identifier', async () => {
        registryHolds(await flatApp('TestApp'));
        containersAre({ running: false });

        await appController.appKill(reqFor('TestApp'), res());

        expect(intentsOf()).to.deep.equal([{
          // The bare form the reconciler publishes reconciler:actuated under -
          // an event carrying a different spelling of the same component cannot
          // be ordered against them, which is the only thing this is for.
          identifier: 'TestApp', stopped: true, force: true, restartRequested: false,
        }]);
      });

      it('announces a start, and a restart as a start that asked for one', async () => {
        registryHolds(await flatApp('TestApp'));

        await appController.appStart(reqFor('TestApp'), res());
        await appController.appRestart(reqFor('TestApp'), res());

        expect(intentsOf()).to.deep.equal([
          { identifier: 'TestApp', stopped: false, force: false, restartRequested: false },
          { identifier: 'TestApp', stopped: false, force: false, restartRequested: true },
        ]);
      });

      it('is published AFTER the write, so it cannot claim an intent that did not persist', async () => {
        registryHolds(await flatApp('TestApp'));
        containersAre({ running: false });

        await appController.appStop(reqFor('TestApp'), res());

        sinon.assert.callOrder(setOperatorStopped, published);
      });
    });

    describe('accepted, not applied', () => {
      it('does not report a stop that has not happened', async () => {
        registryHolds(await flatApp('TestApp'));
        containersAre({ running: true }); // the reconciler has not got to it

        const response = res();
        await appController.appStop(reqFor('TestApp'), response);

        expect(response.json.firstCall.args[0].data)
          .to.contain('will be stopped: the reconciler has not stopped it yet');
      });

      it('names an election as the reason a start did not run it, not a failure', async () => {
        registryHolds(await flatApp('TestApp'));
        containersAre({ running: false });
        sinon.stub(appReconciler, 'desiredRunState').resolves({ desired: null, reason: 'awaitingController' });

        const response = res();
        await appController.appStart(reqFor('TestApp'), response);

        expect(response.json.firstCall.args[0].data)
          .to.contain('will be started: waiting for the election');
      });

      // This tree's reconciler answers eight reasons development's map never
      // carried, and each is a settled state that "not yet" misdescribes.
      it('names this tree\'s own reasons rather than falling back', async () => {
        registryHolds(await flatApp('TestApp'));
        containersAre({ running: false });
        const desired = sinon.stub(appReconciler, 'desiredRunState');

        const cases = {
          condemned: 'it is being removed from this node',
          operationHold: 'an operation on this app is holding it',
          shutdownPipeline: 'this node is going down',
          boundToDependencyDown: 'the component it is bound to is not running',
          awaitingAppDependency: 'waiting for an app it depends on',
        };
        for (const [reason, phrase] of Object.entries(cases)) {
          desired.resolves({ desired: false, reason });
          const response = res();
          // eslint-disable-next-line no-await-in-loop
          await appController.appStart(reqFor('TestApp'), response);
          expect(response.json.firstCall.args[0].data, reason).to.contain(phrase);
        }
      });

      it('reports a stop that did happen plainly', async () => {
        registryHolds(await flatApp('TestApp'));
        containersAre({ running: false });

        const response = res();
        await appController.appStop(reqFor('TestApp'), response);

        expect(response.json.firstCall.args[0].data).to.equal('Application TestApp stopped');
      });
    });
  });

  describe('pause and unpause are retired', () => {
    // The reason they are gone is docker's: a paused container still reports as
    // running, so the reconciler and the load balancer keep routing to it while
    // nothing in FluxOS can see it is frozen. An ERROR, not a success - a caller
    // must not be told the container stopped when it has not.
    ['appPause', 'appUnpause'].forEach((verb) => {
      it(`${verb} answers 410 and names the supported verb instead`, async () => {
        verificationHelperStub.resolves(true);
        const res = { json: sinon.fake((param) => param) };

        await appController[verb]({ params: { appname: 'TestApp' }, query: {} }, res);

        const result = res.json.firstCall.args[0];
        expect(result.status).to.equal('error');
        expect(result.data.code).to.equal(410);
        expect(result.data.name).to.equal('Deprecated');
        expect(result.data.message).to.contain('appstop');
      });

      it(`${verb} refuses a caller the privilege refuses, before saying anything else`, async () => {
        verificationHelperStub.resolves(false);
        const res = { json: sinon.fake((param) => param) };

        await appController[verb]({ params: { appname: 'TestApp' }, query: {} }, res);

        expect(res.json.firstCall.args[0].data.message).to.contain('Unauthorized');
      });

      // Express's extended query parser turns ?appname=a&appname=b into an ARRAY,
      // which has no .split. This runs ahead of the privilege check because the
      // app name is what the privilege is scoped to, so it is reachable
      // unauthenticated - and unguarded the rejection was dropped and the socket
      // left open with nothing to answer it.
      it(`${verb} refuses an appname that is not a string`, async () => {
        verificationHelperStub.resolves(true);
        const res = { json: sinon.fake((param) => param) };

        await appController[verb]({ params: {}, query: { appname: ['a', 'b'] } }, res);

        const result = res.json.firstCall.args[0];
        expect(result.status).to.equal('error');
        expect(result.data.message).to.contain('Invalid Flux App name');
      });
    });

    it('drives no container, and asks docker for nothing', async () => {
      verificationHelperStub.resolves(true);
      const res = { json: sinon.fake((param) => param) };

      await appController.appPause({ params: { appname: 'TestApp' }, query: {} }, res);
      await appController.appUnpause({ params: { appname: 'TestApp' }, query: {} }, res);

      // The old handlers called dockerService.appDockerPause/Unpause, which this
      // tree retired with the rest of pause - so they threw on every request and
      // the global path answered SUCCESS after broadcasting to every host.
      expect(dockerService.appDockerPause).to.equal(undefined);
      expect(dockerService.appDockerUnpause).to.equal(undefined);
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
