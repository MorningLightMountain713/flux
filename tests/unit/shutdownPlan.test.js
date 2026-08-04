const { expect } = require('chai');

const shutdownPlan = require('../../ZelBack/src/services/appLifecycle/shutdownPlan');

// Mock DeploymentComponent / DeploymentSpec / InstantiatedSpec via plain objects
// exposing the same getters the helper reads — the helper only ever touches the
// domain-class API, never raw spec internals.
function webComponent() {
  return {
    appName: 'myapp',
    name: 'web',
    loadBalancing: { http: { drain: { timeout: 180, waitForConnections: true } } },
    preStop: { type: 'exec', cmd: ['sh', '-c', 'flush'], timeout: 30 },
    shutdown: { gracefulTimeout: 60 },
    ports: { http: { hostPort: 31000, containerPort: 80 } },
  };
}

function bareComponent() {
  return {
    appName: 'myapp', name: 'worker', loadBalancing: null, preStop: null, shutdown: null, ports: {},
  };
}

// Single-feature components: each exercises exactly one graceful-shutdown trigger.
function shutdownOnlyComponent() {
  return {
    appName: 'myapp', name: 'api', loadBalancing: null, preStop: null, ports: {}, shutdown: { gracefulTimeout: 30 },
  };
}

function preStopOnlyComponent() {
  return {
    appName: 'myapp', name: 'db', loadBalancing: null, shutdown: null, ports: {}, preStop: { type: 'exec', cmd: ['sh', '-c', 'flush'], timeout: 20 },
  };
}

function drainOnlyComponent() {
  return {
    appName: 'myapp', name: 'lb', preStop: null, shutdown: null, ports: {}, loadBalancing: { http: { drain: { timeout: 45, waitForConnections: false } } },
  };
}

function deploymentOf(...comps) {
  return {
    appName: 'myapp',
    startupOrder: comps.map((c) => c.name),
    componentEntries: () => comps.map((c) => [c.name, c]),
  };
}

describe('shutdownPlan', () => {
  // The label BUILDERS live in flux-spec, where the keys are defined and tested
  // (containerLabels). What stays here is the arithmetic over a component's
  // load-balanced ports that feeds them.
  describe('maxDrainTimeout', () => {
    it('takes the longest drain across a component load-balanced ports', () => {
      expect(shutdownPlan.maxDrainTimeout(webComponent())).to.equal(180);
    });

    it('is zero for a component with no load balancing at all', () => {
      expect(shutdownPlan.maxDrainTimeout(bareComponent())).to.equal(0);
    });
  });

  describe('buildShutdownPlan', () => {
    it('builds the plan from instantiated + deployment via domain getters', () => {
      const web = webComponent();
      const worker = bareComponent();
      const instantiated = { owner: '1owner', hash: 'msg-hash-1' };
      const deployment = {
        appName: 'myapp',
        startupOrder: ['worker', 'web'],
        componentEntries: () => [['worker', worker], ['web', web]],
      };

      const plan = shutdownPlan.buildShutdownPlan(instantiated, deployment);

      expect(plan.app_name).to.equal('myapp');
      expect(plan.owner_flux_id).to.equal('1owner');
      expect(plan.spec_hash).to.equal('msg-hash-1');
      expect(plan.startup_order).to.deep.equal(['worker', 'web']);
      // worker: 0+0+10, web: 180+30+60 → 280
      expect(plan.shutdown_budget_app_wide_s).to.equal(280);
      expect(plan.components).to.have.lengthOf(2);

      const webPlan = plan.components.find((c) => c.name === 'web');
      expect(webPlan.shutdown).to.deep.equal({ graceful_timeout_s: 60 });
      expect(webPlan.pre_stop).to.deep.equal({ type: 'exec', cmd: ['sh', '-c', 'flush'], timeout_s: 30 });
      expect(webPlan.ports).to.deep.equal([{
        name: 'http', host_port: 31000, container_port: 80,
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

    it('carries the deployment identity: a named replica keys its own plan', () => {
      const instantiated = { owner: '1owner', hash: 'msg-hash-1' };
      const deployment = {
        appName: 'myapp',
        replica: 's1',
        startupOrder: ['web'],
        componentEntries: () => [['web', webComponent()]],
      };

      const plan = shutdownPlan.buildShutdownPlan(instantiated, deployment);

      expect(plan.replica).to.equal('s1');
    });
  });

  describe('appRequiresDaemonShutdown', () => {
    it('is true when a component sets shutdown', () => {
      expect(shutdownPlan.appRequiresDaemonShutdown(deploymentOf(shutdownOnlyComponent()))).to.equal(true);
    });

    it('is true when a component sets preStop', () => {
      expect(shutdownPlan.appRequiresDaemonShutdown(deploymentOf(preStopOnlyComponent()))).to.equal(true);
    });

    it('is true when a component has a port drain', () => {
      expect(shutdownPlan.appRequiresDaemonShutdown(deploymentOf(drainOnlyComponent()))).to.equal(true);
    });

    it('is false for a plain app (no shutdown/preStop/drain)', () => {
      expect(shutdownPlan.appRequiresDaemonShutdown(deploymentOf(bareComponent()))).to.equal(false);
    });

    it('is true when any one of several components is graceful', () => {
      const dep = deploymentOf(bareComponent(), bareComponent(), shutdownOnlyComponent());
      expect(shutdownPlan.appRequiresDaemonShutdown(dep)).to.equal(true);
    });
  });

  describe('appShutdownBudgetSeconds', () => {
    it('equals buildShutdownPlan.shutdown_budget_app_wide_s (guards drift)', () => {
      const dep = deploymentOf(bareComponent(), webComponent());
      const instantiated = { owner: '1owner', hash: 'msg-hash-1' };
      expect(shutdownPlan.appShutdownBudgetSeconds(dep))
        .to.equal(shutdownPlan.buildShutdownPlan(instantiated, dep).shutdown_budget_app_wide_s);
    });

    it('sums drain + preStop + graceful per component (10s default)', () => {
      // bare: 0+0+10, web: 180+30+60 → 280
      expect(shutdownPlan.appShutdownBudgetSeconds(deploymentOf(bareComponent(), webComponent()))).to.equal(280);
    });
  });
});
