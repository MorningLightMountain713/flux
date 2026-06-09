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

describe('shutdownPlan', () => {
  describe('componentShutdownLabels', () => {
    it('builds the full label set from a configured component', () => {
      const labels = shutdownPlan.componentShutdownLabels(webComponent(), '1owner');
      expect(labels).to.deep.equal({
        'runonflux.app': 'myapp',
        'runonflux.component': 'web',
        'runonflux.shutdown.drain-s': '180',
        'runonflux.shutdown.prestop-s': '30',
        'runonflux.shutdown.graceful-s': '60',
        'runonflux.owner': '1owner',
      });
    });

    it('uses defaults and omits owner when absent', () => {
      const labels = shutdownPlan.componentShutdownLabels(bareComponent(), null);
      expect(labels['runonflux.shutdown.drain-s']).to.equal('0');
      expect(labels['runonflux.shutdown.prestop-s']).to.equal('0');
      expect(labels['runonflux.shutdown.graceful-s']).to.equal('10');
      expect(labels).to.not.have.property('runonflux.owner');
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
    });
  });
});
