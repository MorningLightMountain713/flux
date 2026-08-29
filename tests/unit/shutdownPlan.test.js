'use strict';

// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');

const shutdownPlan = require('../../ZelBack/src/services/appLifecycle/shutdownPlan');
const { appsFolder } = require('../../ZelBack/src/services/utils/appConstants');
const {
  loadSpecLibrary, V9_SUBMISSION, v9Spec, decryptedV9Spec, instantiatedSpec, assertAnswers,
} = require('./fixtures/fluxSpec');

// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. shutdownPlan is pure: no daemon socket, no mongo, no docker, so nothing
// in this file is stubbed at all. Every object it reads is the real class the
// runtime hands it — DeploymentSpec, DeploymentComponent, InstantiatedSpec — and
// the shutdown fields are declared in a real v9 submission the schema accepted,
// not asserted onto a literal.
let flux;

// ── Component roles ───────────────────────────────────────────────────
// Each role is a sparse override merged over the fixture's real v9 component.
// The values are the schema's: drain.timeout has a 120s floor (FDM's polling
// cadence), preStop.timeout is 1-600, shutdown.gracefulTimeout is 1-21600.

/** Drains a load-balanced port, runs a preStop hook, and raises the stop window:
 *  180 + 30 + 60 = 270s of budget. */
const GRACEFUL = Object.freeze({
  loadBalancing: {
    http: {
      provider: 'haproxy', mode: 'http', drain: { timeout: 180, waitForConnections: true },
    },
  },
  preStop: { type: 'exec', cmd: ['sh', '-c', 'flush'], timeout: 30 },
  shutdown: { gracefulTimeout: 60 },
});

/** No shutdown feature and no port to drain — docker's own 10s window. */
const PLAIN = Object.freeze({ ports: {}, loadBalancing: null });

/** Exactly one graceful-shutdown trigger each, so the three limbs of
 *  `appRequiresDaemonShutdown` are exercised one at a time. */
const SHUTDOWN_ONLY = Object.freeze({ ...PLAIN, shutdown: { gracefulTimeout: 30 } });
const PRESTOP_ONLY = Object.freeze({
  ...PLAIN, preStop: { type: 'exec', cmd: ['sh', '-c', 'checkpoint'], timeout: 20 },
});
const DRAIN_ONLY = Object.freeze({
  loadBalancing: {
    http: {
      provider: 'haproxy', mode: 'http', drain: { timeout: 120, waitForConnections: false },
    },
  },
});

describe('shutdownPlan', () => {
  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30000);
    flux = await loadSpecLibrary();
  });

  /**
   * Real v9 submission components from the fixture's component, one per role.
   * Host ports are handed out per component: co-resident components cannot both
   * claim 31000, and the real schema is the thing that says so.
   */
  function componentsFor(roles) {
    const components = {};
    Object.entries(roles).forEach(([name, role], index) => {
      components[name] = {
        ...V9_SUBMISSION.components.web,
        name,
        ports: { http: { containerPort: 80, hostPort: 31000 + index } },
        ...role,
      };
    });
    return components;
  }

  /**
   * A real DecryptedCanonicalSpec — the readable form a node holds after opening
   * a sealed v9 app, and the spec DeploymentSpec.fromSpec is fed in production.
   */
  function specFor(roles, overrides = {}) {
    return decryptedV9Spec({ components: componentsFor(roles), ...overrides });
  }

  /** A real DeploymentSpec — the class deploymentProvider hands every caller. */
  function deploymentFor(spec, opts = {}) {
    return flux.DeploymentSpec.fromSpec(spec, appsFolder, { replica: null, ...opts });
  }

  /** A real DeploymentSpec straight from a set of roles. */
  async function deploymentOf(roles, overrides = {}, opts = {}) {
    return deploymentFor(await specFor(roles, overrides), opts);
  }

  /** The one real DeploymentComponent of a single-component app. */
  async function componentOf(role) {
    const deployment = await deploymentOf({ web: role });
    return deployment.getComponent('web');
  }

  // The label BUILDERS live in flux-spec, where the keys are defined and tested
  // (containerLabels). What stays here is the arithmetic over a component's
  // load-balanced ports that feeds them.
  describe('maxDrainTimeout', () => {
    it('takes the longest drain across a component load-balanced ports', async () => {
      // Two genuinely load-balanced ports, so "longest across ports" is a real
      // maximum rather than the only value present.
      const component = await componentOf({
        ports: {
          http: { containerPort: 80, hostPort: 31000 },
          admin: { containerPort: 8080, hostPort: 31001 },
        },
        loadBalancing: {
          http: {
            provider: 'haproxy', mode: 'http', drain: { timeout: 180, waitForConnections: true },
          },
          admin: {
            provider: 'haproxy', mode: 'http', drain: { timeout: 120, waitForConnections: false },
          },
        },
      });

      expect(shutdownPlan.maxDrainTimeout(component)).to.equal(180);
    });

    it('is zero for a component with no load balancing at all', async () => {
      expect(shutdownPlan.maxDrainTimeout(await componentOf(PLAIN))).to.equal(0);
    });

    it('agrees with the component own maxDrainTimeoutSeconds (guards drift)', async () => {
      // flux-spec carries the same arithmetic on DeploymentComponent. Two copies
      // of one rule can only be held together by comparing them on a real object.
      for (const role of [GRACEFUL, PLAIN, DRAIN_ONLY]) {
        const component = await componentOf(role);
        expect(shutdownPlan.maxDrainTimeout(component))
          .to.equal(component.maxDrainTimeoutSeconds());
      }
    });
  });

  describe('buildShutdownPlan', () => {
    it('builds the plan from instantiated + deployment via domain getters', async () => {
      // web depends on worker, so startup_order is the real topological order the
      // deployment derived — not a list handed to it.
      const spec = await specFor({
        worker: PLAIN,
        web: { ...GRACEFUL, dependsOn: { worker: { condition: 'started' } } },
      });
      const deployment = deploymentFor(spec);
      const instantiated = await instantiatedSpec(spec);

      const plan = shutdownPlan.buildShutdownPlan(instantiated, deployment);

      expect(plan.app_name).to.equal('myapp');
      expect(plan.owner_flux_id).to.equal(V9_SUBMISSION.owner);
      expect(plan.spec_hash).to.equal(instantiated.hash);
      expect(plan.startup_order).to.deep.equal(['worker', 'web']);
      // worker: 0+0+10, web: 180+30+60 → 280
      expect(plan.shutdown_budget_app_wide_s).to.equal(280);
      expect(plan.components).to.have.lengthOf(2);

      const webPlan = plan.components.find((c) => c.name === 'web');
      expect(webPlan.shutdown).to.deep.equal({ graceful_timeout_s: 60 });
      expect(webPlan.pre_stop).to.deep.equal({ type: 'exec', cmd: ['sh', '-c', 'flush'], timeout_s: 30 });
      // the host port is the one the deployment resolved, not a number retyped here
      const { hostPort } = deployment.getComponent('web').ports.http;
      expect(webPlan.ports).to.deep.equal([{
        name: 'http', host_port: hostPort, container_port: 80,
        drain: { timeout_s: 180, wait_for_connections: true },
      }]);

      const workerPlan = plan.components.find((c) => c.name === 'worker');
      expect(workerPlan.shutdown).to.equal(null);
      expect(workerPlan.pre_stop).to.equal(null);
      expect(workerPlan.ports).to.deep.equal([]);
      // replica is required-and-nullable on the wire: always present, null for
      // a loose deployment (no replica on the deployment view).
      expect(plan.replica).to.equal(null);
    });

    it('carries the deployment identity: a named replica keys its own plan', async () => {
      // A named replica exists because the app is PINNED — the assignment map is
      // where replica names live, and the deployment view is resolved for one of
      // them. Asking for a replica of a loose app would be a fiction.
      const spec = await specFor({ web: GRACEFUL }, {
        instances: 2,
        assignment: { targetIps: { '1.2.3.4': ['s1'], '5.6.7.8': ['s2'] } },
      });
      const deployment = deploymentFor(spec, { replica: 's1' });
      const instantiated = await instantiatedSpec(spec);

      const plan = shutdownPlan.buildShutdownPlan(instantiated, deployment);

      expect(plan.replica).to.equal('s1');
      // the replica really is bound: its container identifier is qualified
      expect(deployment.getComponent('web').identifier).to.equal('web_myapp_s1');
    });

    it('reads the deployment and the instantiated spec through the domain API alone', async () => {
      // Real objects are not sufficient on their own: a getter can be dropped from
      // flux-spec with a test still green if nothing reads it back. These are the
      // members buildShutdownPlan actually calls on what it is handed.
      const spec = await specFor({ web: GRACEFUL, worker: PLAIN });
      const deployment = deploymentFor(spec);
      const instantiated = await instantiatedSpec(spec);

      assertAnswers(deployment, ['componentEntries']);
      expect(deployment.appName, 'buildShutdownPlan reads deployment.appName').to.be.a('string');
      expect(deployment.startupOrder, 'buildShutdownPlan spreads deployment.startupOrder').to.be.an('array');
      expect(deployment, 'replica is required-and-nullable, so it must be present').to.have.property('replica');
      expect(instantiated.owner, 'buildShutdownPlan reads instantiated.owner').to.be.a('string');
      expect(instantiated.hash, 'buildShutdownPlan reads instantiated.hash').to.be.a('string');

      // and per component, the four fields the plan is assembled from
      for (const [, component] of deployment.componentEntries()) {
        expect(component.name).to.be.a('string');
        expect(component, 'componentBudgetSeconds reads comp.shutdown').to.have.property('shutdown');
        expect(component, 'componentBudgetSeconds reads comp.preStop').to.have.property('preStop');
        expect(component, 'maxDrainTimeout reads comp.loadBalancing').to.have.property('loadBalancing');
        expect(component.ports, 'buildPorts iterates comp.ports').to.be.an('object');
      }
    });
  });

  describe('appRequiresDaemonShutdown', () => {
    it('is true when a component sets shutdown', async () => {
      expect(shutdownPlan.appRequiresDaemonShutdown(await deploymentOf({ api: SHUTDOWN_ONLY }))).to.equal(true);
    });

    it('is true when a component sets preStop', async () => {
      expect(shutdownPlan.appRequiresDaemonShutdown(await deploymentOf({ db: PRESTOP_ONLY }))).to.equal(true);
    });

    it('is true when a component has a port drain', async () => {
      expect(shutdownPlan.appRequiresDaemonShutdown(await deploymentOf({ edge: DRAIN_ONLY }))).to.equal(true);
    });

    it('is false for a plain app (no shutdown/preStop/drain)', async () => {
      expect(shutdownPlan.appRequiresDaemonShutdown(await deploymentOf({ worker: PLAIN }))).to.equal(false);
    });

    it('is true when any one of several components is graceful', async () => {
      const deployment = await deploymentOf({
        'worker-a': PLAIN, 'worker-b': PLAIN, api: SHUTDOWN_ONLY,
      });
      expect(shutdownPlan.appRequiresDaemonShutdown(deployment)).to.equal(true);
    });

    it('is false for an encrypted app that declares no shutdown feature', async () => {
      // The documented rule: keyed on FEATURE USAGE, not isEncrypted. secretEnvironment
      // is genuinely encryption-forcing — the same app submitted as cleartext is
      // refused — so the app really is encrypted and still gets no plan.
      const secretsOnly = { ...PLAIN, secretEnvironment: { API_KEY: 'shh' } };
      const asCleartext = await v9Spec({ components: componentsFor({ web: secretsOnly }) });
      const refusals = asCleartext.validateSemantics({ encrypted: false });
      expect(refusals.map((e) => e.code), 'secretEnvironment must force encryption')
        .to.include('ENCRYPTION_REQUIRED');

      const spec = await specFor({ web: secretsOnly });
      expect(spec.isEncrypted, 'the app under test must really be encrypted').to.equal(true);
      expect(shutdownPlan.appRequiresDaemonShutdown(deploymentFor(spec))).to.equal(false);
    });
  });

  describe('appShutdownBudgetSeconds', () => {
    it('equals buildShutdownPlan.shutdown_budget_app_wide_s (guards drift)', async () => {
      const spec = await specFor({ worker: PLAIN, web: GRACEFUL });
      const deployment = deploymentFor(spec);
      const instantiated = await instantiatedSpec(spec);

      expect(shutdownPlan.appShutdownBudgetSeconds(deployment))
        .to.equal(shutdownPlan.buildShutdownPlan(instantiated, deployment).shutdown_budget_app_wide_s);
    });

    it('sums drain + preStop + graceful per component (10s default)', async () => {
      // worker: 0+0+10, web: 180+30+60 → 280
      const deployment = await deploymentOf({ worker: PLAIN, web: GRACEFUL });
      expect(shutdownPlan.appShutdownBudgetSeconds(deployment)).to.equal(280);
    });

    it('agrees with the components own shutdownBudgetSeconds (guards drift)', async () => {
      // Same duplicated rule as maxDrainTimeout: flux-spec's DeploymentComponent
      // budgets a component too, and the daemon deadline is only trustworthy while
      // the two agree.
      const deployment = await deploymentOf({ worker: PLAIN, web: GRACEFUL, edge: DRAIN_ONLY });
      const fromLibrary = deployment.componentEntries()
        .reduce((sum, [, component]) => sum + component.shutdownBudgetSeconds(), 0);

      expect(shutdownPlan.appShutdownBudgetSeconds(deployment)).to.equal(fromLibrary);
    });
  });
});
