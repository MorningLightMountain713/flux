/**
 * Builds the FluxOS-side graceful-shutdown artifacts handed to flux-shutdownd:
 * the per-container `runonflux.*` labels and the per-app shutdown plan.
 *
 * These are FluxOS consumer concerns — they join provenance (InstantiatedSpec:
 * owner, message hash) with operational data (DeploymentComponent: shutdown,
 * preStop, loadBalancing, ports). They are deliberately built here, at the
 * deployment bridge, NOT on the domain types: DeploymentSpec stays purely
 * operational and InstantiatedSpec keeps the provenance. Everything is read
 * through domain-class getters — no raw `instantiated.spec.components[...]`
 * reach-ins.
 */

/** Longest drain timeout across a component's load-balanced ports (0 if none). */
function maxDrainTimeout(deployComp) {
  const lb = deployComp.loadBalancing;
  if (!lb) return 0;
  let max = 0;
  for (const provider of Object.values(lb)) {
    const timeout = provider && provider.drain ? provider.drain.timeout : undefined;
    if (typeof timeout === 'number' && timeout > max) max = timeout;
  }
  return max;
}

/**
 * The `runonflux.*` labels stamped on a container so flux-shutdownd can find it
 * and read its shutdown budget without consulting FluxOS at shutdown time.
 * `owner` is provenance supplied by the caller (it isn't on DeploymentComponent);
 * the rest comes from the component itself.
 *
 * @param {object} deployComp - a DeploymentComponent
 * @param {string} [owner] - the app owner's flux id
 * @returns {Object<string, string>}
 */
function componentShutdownLabels(deployComp, owner) {
  const labels = {
    'runonflux.app': deployComp.appName,
    'runonflux.component': deployComp.name,
    'runonflux.shutdown.drain-s': String(maxDrainTimeout(deployComp)),
    'runonflux.shutdown.prestop-s': String(deployComp.preStop ? deployComp.preStop.timeout : 0),
    'runonflux.shutdown.graceful-s': String(deployComp.shutdown ? deployComp.shutdown.gracefulTimeout : 10),
  };
  if (owner) labels['runonflux.owner'] = owner;
  return labels;
}

function buildPorts(deployComp) {
  const ports = deployComp.ports || {};
  const lb = deployComp.loadBalancing || {};
  const out = [];
  for (const [name, port] of Object.entries(ports)) {
    const drain = lb[name] ? lb[name].drain : null;
    out.push({
      name,
      host_port: port.hostPort,
      container_port: port.containerPort,
      drain: drain
        ? { timeout_s: drain.timeout, wait_for_connections: drain.waitForConnections }
        : null,
    });
  }
  return out;
}

/**
 * The full shutdown plan for an app, pushed to flux-shutdownd at deploy time.
 * `spec_hash` is the AppEvent message hash (provenance) used as the daemon's
 * idempotency / drift-detection key — recomputable cheaply at resync without
 * decryption.
 *
 * @param {object} instantiated - an InstantiatedSpec
 * @param {object} deployment - a DeploymentSpec
 * @returns {object}
 */
function buildShutdownPlan(instantiated, deployment) {
  const components = [];
  let budget = 0;
  for (const [, deployComp] of deployment.componentEntries()) {
    const drain = maxDrainTimeout(deployComp);
    const preStop = deployComp.preStop ? deployComp.preStop.timeout : 0;
    const graceful = deployComp.shutdown ? deployComp.shutdown.gracefulTimeout : 10;
    budget += drain + preStop + graceful;
    components.push({
      name: deployComp.name,
      shutdown: deployComp.shutdown
        ? { graceful_timeout_s: deployComp.shutdown.gracefulTimeout }
        : null,
      pre_stop: deployComp.preStop
        ? {
          type: deployComp.preStop.type,
          cmd: deployComp.preStop.cmd,
          timeout_s: deployComp.preStop.timeout,
        }
        : null,
      ports: buildPorts(deployComp),
    });
  }
  return {
    app_name: deployment.appName,
    owner_flux_id: instantiated.owner,
    spec_hash: instantiated.hash,
    shutdown_budget_app_wide_s: budget,
    startup_order: [...deployment.startupOrder],
    components,
  };
}

module.exports = {
  componentShutdownLabels,
  buildShutdownPlan,
};
