'use strict';

/**
 * Builds the per-app shutdown plan handed to flux-shutdownd, joining provenance
 * (InstantiatedSpec: owner, message hash) with operational data
 * (DeploymentComponent: shutdown, preStop, loadBalancing, ports). Everything is
 * read through domain-class getters — no raw `instantiated.spec.components[...]`
 * reach-ins.
 *
 * The container LABELS are not built here. Their keys are a contract with
 * flux-shutdownd, which reads them off containers to know what to drain, so
 * they are defined once in flux-spec (`containerLabels`) alongside the forward
 * naming rather than spelled out at each end.
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

/** Per-component shutdown budget: drain + preStop + graceful (10s default). */
function componentBudgetSeconds(deployComp) {
  const drain = maxDrainTimeout(deployComp);
  const preStop = deployComp.preStop ? deployComp.preStop.timeout : 0;
  const graceful = deployComp.shutdown ? deployComp.shutdown.gracefulTimeout : 10;
  return drain + preStop + graceful;
}

/**
 * The app-wide graceful-shutdown budget (seconds): the sum of every component's
 * drain + preStop + graceful. Single source of truth shared with
 * `buildShutdownPlan`, so the daemon's deadline and the FluxOS-side budget agree.
 *
 * @param {object} deployment - a DeploymentSpec
 * @returns {number}
 */
function appShutdownBudgetSeconds(deployment) {
  let budget = 0;
  for (const [, deployComp] of deployment.componentEntries()) {
    budget += componentBudgetSeconds(deployComp);
  }
  return budget;
}

/**
 * Whether an app uses any graceful-shutdown feature (shutdown, preStop, or a port
 * drain) and therefore needs a flux-shutdownd plan + the `runonflux.shutdown.*`
 * budget labels. Keyed on FEATURE USAGE, not `isEncrypted`: a graceful-shutdown
 * app is necessarily encrypted (the spec forces it), but a secrets-only encrypted
 * app with no shutdown config must NOT get a plan, and a graceful app must always
 * get one. Reads the same getters `buildShutdownPlan` consumes, so they can't drift.
 *
 * @param {object} deployment - a DeploymentSpec
 * @returns {boolean}
 */
function appRequiresDaemonShutdown(deployment) {
  return deployment.componentEntries().some(([, deployComp]) => {
    if (deployComp.shutdown || deployComp.preStop) return true;
    return maxDrainTimeout(deployComp) > 0;
  });
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
 * The full shutdown plan for one deployment of an app, pushed to flux-shutdownd
 * at deploy time. `spec_hash` is the AppEvent message hash (provenance) used as
 * the daemon's idempotency / drift-detection key — recomputable cheaply at
 * resync without decryption. `replica` is required-and-nullable: always present,
 * null for loose placement — the daemon keys its plan store per identity, so a
 * co-located pair holds one plan per replica (their effective host ports
 * differ).
 *
 * @param {object} instantiated - an InstantiatedSpec
 * @param {object} deployment - a DeploymentSpec (one identity's view)
 * @returns {object}
 */
function buildShutdownPlan(instantiated, deployment) {
  const components = [];
  let budget = 0;
  for (const [, deployComp] of deployment.componentEntries()) {
    budget += componentBudgetSeconds(deployComp);
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
    replica: deployment.replica ?? null,
    spec_hash: instantiated.hash,
    shutdown_budget_app_wide_s: budget,
    startup_order: [...deployment.startupOrder],
    components,
  };
}

module.exports = {
  maxDrainTimeout,
  buildShutdownPlan,
  appShutdownBudgetSeconds,
  appRequiresDaemonShutdown,
};
