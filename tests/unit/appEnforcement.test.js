'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const { loadSpecLibrary, V9_SUBMISSION, v9Spec } = require('./fixtures/fluxSpec');

const APPS_FOLDER = '/tmp/apps';

describe('appEnforcement tests', () => {
  let flux;
  let logStub;

  before(async function loadLibrary() {
    // the first fromSubmission compiles the schemas
    this.timeout(60_000);
    flux = await loadSpecLibrary();
  });

  beforeEach(() => {
    logStub = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };
  });

  afterEach(() => {
    sinon.restore();
  });

  /**
   * A real DeploymentSpec - what deploymentProvider hands the sweeps in
   * production. Sizes and image come from the component, so `containerDiskGb()`
   * is rootFsGb + swapGb as the class derives it.
   */
  async function deploymentOf({
    name, componentName = 'web', image, rootFsGb = 2, swapGb = 0, cpu = 0.5, hostPort,
  }) {
    const components = JSON.parse(JSON.stringify(V9_SUBMISSION.components));
    const component = components.web;
    delete components.web;
    components[componentName] = component;
    component.name = componentName;
    component.rootFsGb = rootFsGb;
    component.swapGb = swapGb;
    component.cpu = cpu;
    if (image) component.image = image;
    if (hostPort) component.ports = { api: { containerPort: 8080, hostPort } };
    const spec = await v9Spec({ name, components });
    return flux.DeploymentSpec.fromSpec(spec, APPS_FOLDER, { replica: null });
  }

  // monitorSharedDBApps walks every installed deployment, asks a shared-db
  // component's own API for its operator status, and UNINSTALLS the customer's
  // app when it answers UNINSTALL. It finds that component by `comp.image`, so
  // the deployments here are real ones.
  describe('monitorSharedDBApps', () => {
    let listInstalledDeploymentsStub;
    let uninstallStub;
    let axiosGetStub;
    let isHeldStub;

    function load() {
      listInstalledDeploymentsStub = sinon.stub().resolves([]);
      uninstallStub = sinon.stub().resolves();
      axiosGetStub = sinon.stub().resolves(null);
      isHeldStub = sinon.stub().returns(false);
      return proxyquire('../../ZelBack/src/services/appManagement/appEnforcement', {
        '../appRuntime/deploymentProvider': { listInstalledDeployments: listInstalledDeploymentsStub },
        '../appLifecycle/appUninstaller': { uninstallApplication: uninstallStub },
        '../utils/operationRegistry': { isHeld: isHeldStub },
        '../../lib/log': logStub,
        // The pass RE-ARMS ITSELF: its finally awaits a five-minute delay and
        // then calls itself again. So the delay is what ends a run, not a return
        // - resolved, it recurses without bound, and the function's own promise
        // never settles either way. A delay that never resolves parks the
        // re-arm after exactly one pass, which is the pass under test.
        '../serviceHelper': {
          delay: sinon.stub().returns(new Promise(() => {})),
          axiosGet: axiosGetStub,
        },
        '../dockerService': {},
        '../utils/hostStorageCapability': { supportsManagedStorage: sinon.stub().resolves(false) },
        '../appLifecycle/appOperations': { redeployApplication: sinon.stub().resolves() },
      });
    }

    const sharedDb = (name) => deploymentOf({
      name, componentName: 'db', image: 'runonflux/shared-db:latest', hostPort: 31_001,
    });

    /** One pass: fired, then drained. It cannot be awaited - see load(). */
    const onePass = async (inspector) => {
      inspector.monitorSharedDBApps();
      for (let i = 0; i < 8; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setImmediate(resolve); });
      }
    };

    it('uninstalls the app when its operator answers UNINSTALL', async () => {
      const inspector = load();
      listInstalledDeploymentsStub.resolves([await sharedDb('shareddbapp')]);
      axiosGetStub.resolves({ data: { status: 'UNINSTALL' } });

      await onePass(inspector);

      // Asked the component's OWN api port, on localhost.
      expect(axiosGetStub.firstCall.args[0]).to.equal('http://localhost:31001/status');
      sinon.assert.calledOnce(uninstallStub);
      expect(uninstallStub.firstCall.args[0]).to.equal('shareddbapp');
    });

    it('leaves the app alone on any other status', async () => {
      const inspector = load();
      listInstalledDeploymentsStub.resolves([await sharedDb('shareddbapp')]);
      axiosGetStub.resolves({ data: { status: 'OK' } });

      await onePass(inspector);

      sinon.assert.notCalled(uninstallStub);
    });

    it('leaves the app alone when the operator cannot be reached', async () => {
      // An unreachable operator says nothing about whether the app should go.
      const inspector = load();
      listInstalledDeploymentsStub.resolves([await sharedDb('shareddbapp')]);
      axiosGetStub.rejects(new Error('connection refused'));

      await onePass(inspector);

      sinon.assert.notCalled(uninstallStub);
    });

    it('does not touch an app that is mid-operation', async () => {
      // The action here is a destructive uninstall; it must not race a lifecycle
      // operation holding that app's lease.
      const inspector = load();
      listInstalledDeploymentsStub.resolves([await sharedDb('shareddbapp')]);
      axiosGetStub.resolves({ data: { status: 'UNINSTALL' } });
      isHeldStub.returns(true);

      await onePass(inspector);

      sinon.assert.notCalled(axiosGetStub);
      sinon.assert.notCalled(uninstallStub);
    });

    it('asks nothing of an app that is not a shared-db app', async () => {
      const inspector = load();
      listInstalledDeploymentsStub.resolves([
        await deploymentOf({ name: 'ordinary', image: 'nginx:latest' }),
      ]);

      await onePass(inspector);

      sinon.assert.notCalled(axiosGetStub);
      sinon.assert.notCalled(uninstallStub);
    });
  });

  describe('enforceWritableLayerLimit', () => {
    let clock;
    let listInstalledDeploymentsStub;
    let supportsManagedStorageStub;
    let dockerGetUsageStub;
    let uninstallStub;
    let redeployStub;

    function load() {
      uninstallStub = sinon.stub().resolves();
      redeployStub = sinon.stub().resolves();
      listInstalledDeploymentsStub = sinon.stub().resolves([]);
      supportsManagedStorageStub = sinon.stub().resolves(false);
      dockerGetUsageStub = sinon.stub().resolves({ Containers: [] });
      return proxyquire('../../ZelBack/src/services/appManagement/appEnforcement', {
        '../dockerService': {
          dockerGetUsage: dockerGetUsageStub,
          getAppDockerNameIdentifier: (id) => `/${id}`,
        },
        '../appRuntime/deploymentProvider': { listInstalledDeployments: listInstalledDeploymentsStub },
        '../utils/hostStorageCapability': { supportsManagedStorage: supportsManagedStorageStub },
        '../utils/operationRegistry': { isHeld: sinon.stub().returns(false) },
        '../appLifecycle/appUninstaller': { uninstallApplication: uninstallStub },
        '../appLifecycle/appOperations': { redeployApplication: redeployStub },
        '../../lib/log': logStub,
        '../serviceHelper': { delay: sinon.stub().resolves() },
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
      // A real component, so the budget is rootFsGb + swapGb as the class derives
      // it - not a number this test asserted and the class might no longer agree
      // with.
      listInstalledDeploymentsStub.resolves([
        await deploymentOf({ name: 'big', rootFsGb: 2, swapGb: 1 }),
      ]);
      // budget = (2 + 1) * 1e9 = 3e9; the container reports 5e9 on disk → violation
      dockerGetUsageStub.resolves({ Containers: [{ Names: ['/web_big'], SizeRootFs: 5e9 }] });
      const violations = [];
      await inspector.enforceWritableLayerLimit(violations);
      expect(violations).to.include('big');
    });

    // budget (2 + 1) * 1e9 = 3e9 for the app these name
    async function overBudget(inspector, violations) {
      listInstalledDeploymentsStub.resolves([await deploymentOf({ name: 'big', rootFsGb: 2, swapGb: 1 })]);
      dockerGetUsageStub.resolves({ Containers: [{ Names: ['/web_big'], SizeRootFs: 5e9 }] });
      await inspector.enforceWritableLayerLimit(violations);
    }

    async function withinBudget(inspector, violations) {
      listInstalledDeploymentsStub.resolves([await deploymentOf({ name: 'big', rootFsGb: 2, swapGb: 1 })]);
      dockerGetUsageStub.resolves({ Containers: [{ Names: ['/web_big'], SizeRootFs: 1e9 }] });
      await inspector.enforceWritableLayerLimit(violations);
    }

    it('removes an app on its fourth violation in a row, and forgets its violations', async () => {
      const inspector = load();
      const violations = [];
      await overBudget(inspector, violations);
      await overBudget(inspector, violations);
      await overBudget(inspector, violations);
      expect(uninstallStub.called, 'three violations redeploy').to.equal(false);
      expect(redeployStub.callCount).to.equal(3);

      await overBudget(inspector, violations);

      sinon.assert.calledOnceWithExactly(uninstallStub, 'big', { forceKill: true, skipGuard: true, broadcastRemoval: true });
      expect(violations, 'a reinstalled app starts with none').to.deep.equal([]);
    });

    it('starts the count again after a pass within budget', async () => {
      const inspector = load();
      const violations = [];
      await overBudget(inspector, violations);
      await overBudget(inspector, violations);
      await overBudget(inspector, violations);
      await withinBudget(inspector, violations);
      expect(violations).to.deep.equal([]);

      await overBudget(inspector, violations);

      expect(uninstallStub.called, 'one violation since the clean pass').to.equal(false);
      expect(redeployStub.callCount).to.equal(4);
    });

    it('does not flag a non-managed app within its per-component budget', async () => {
      const inspector = load();
      listInstalledDeploymentsStub.resolves([
        await deploymentOf({ name: 'small', rootFsGb: 10, swapGb: 2 }),
      ]);
      // budget = (10 + 2) * 1e9 = 12e9; the container reports 4e9 on disk → fits
      dockerGetUsageStub.resolves({ Containers: [{ Names: ['/web_small'], SizeRootFs: 4e9 }] });
      const violations = [];
      await inspector.enforceWritableLayerLimit(violations);
      expect(violations).to.not.include('small');
    });
  });
});
