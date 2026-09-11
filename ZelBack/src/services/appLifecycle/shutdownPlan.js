'use strict';

/**
 * Builds the per-app shutdown plan handed to flux-shutdownd, joining provenance
 * (InstantiatedSpec: owner, message hash) with operational data
 * (DeploymentComponent: shutdown, preStop, loadBalancing, ports). Everything is
 * read through domain-class getters — no raw `instantiated.spec.components[...]`
 * reach-ins.
 *
 * The shutdown ARITHMETIC is not done here either. Drain, budget and whether a
 * component needs the daemon at all are declared by the spec, so they are the
 * component's own answers — `maxDrainTimeoutSeconds`, `shutdownBudgetSeconds`,
 * `requiresDaemonShutdown`. What is FluxOS's is the fold across an app's
 * components and the plan's wire shape.
 *
 * The container LABELS are not built here. Their keys are a contract with
 * flux-shutdownd, which reads them off containers to know what to drain, so
 * they are defined once in flux-spec (`containerLabels`) alongside the forward
 * naming rather than spelled out at each end.
 */

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
    budget += deployComp.shutdownBudgetSeconds();
  }
  return budget;
}

/**
 * Whether an app uses any graceful-shutdown feature (shutdown, preStop, or a port
 * drain) and therefore needs a flux-shutdownd plan + the `runonflux.shutdown.*`
 * budget labels. Keyed on FEATURE USAGE, not `isEncrypted`, and the reason is
 * narrower than this comment used to claim.
 *
 * `shutdown` and `preStop` do NOT force encryption. flux-spec keeps two separate
 * sets: ENCRYPTION_FORCING_FIELDS is imageAuth, secretEnvironment, telemetry and
 * content, while shutdown/preStop/backendTls/mesh sit in ARCANE_REQUIRING_FIELDS,
 * which constrains PLACEMENT. A cleartext v9 spec carrying a graceful shutdown
 * builds perfectly well, so "necessarily encrypted" was never true.
 *
 * Feature usage is still the right key, for the reason that always held: a
 * secrets-only encrypted app with no shutdown config must NOT get a plan, and a
 * graceful app must always get one, encrypted or not. Reads the same getters
 * `buildShutdownPlan` consumes, so they can't drift.
 *
 * @param {object} deployment - a DeploymentSpec
 * @returns {boolean}
 */
function appRequiresDaemonShutdown(deployment) {
  return deployment.componentEntries().some(([, deployComp]) => deployComp.requiresDaemonShutdown());
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
    budget += deployComp.shutdownBudgetSeconds();
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
  buildShutdownPlan,
  appShutdownBudgetSeconds,
  appRequiresDaemonShutdown,
};
