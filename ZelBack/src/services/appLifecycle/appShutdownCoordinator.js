'use strict';

/**
 * Drives the reconciler's stop-but-keep decisions through flux-shutdownd, off the
 * reconciler's hot path. The reconciler decides an app should be stopped; this asks
 * the daemon to drain it gracefully and returns immediately (the drain runs in the
 * background). On Arcane the daemon owns the stop — the reconciler takes no docker
 * action and the 'stopping' LB gate suppresses subsequent reconcile passes until the
 * drain finishes. Off Arcane, or when the daemon can't be reached, this returns false
 * so the reconciler does a local graceful appDockerStop instead.
 *
 * This is the run-state counterpart to appUninstaller.runTeardown (which routes the
 * REMOVAL stop): the reconciler decides, shutdownd executes, neither force-kills here.
 */

const log = require('../../lib/log');
const appRecords = require('../appDatabase/appRecords');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const globalState = require('../utils/globalState');
const fluxShutdowndClient = require('../utils/fluxShutdowndClient');
const shutdownPlan = require('./shutdownPlan');
const appReconciler = require('../appMonitoring/appReconciler');

const { SHUTDOWN_REASON } = fluxShutdowndClient;

// The reconciler's desired-stopped reason -> the wire reason FluxOS sends the daemon.
// Unmapped reasons fall back to a generic manual stop.
const RECONCILER_REASON_TO_SHUTDOWN = {
  condemned: SHUTDOWN_REASON.EVICTION,
  operatorStopped: SHUTDOWN_REASON.USER_CANCEL,
  operationHold: SHUTDOWN_REASON.MANUAL,
  controllerDesired: SHUTDOWN_REASON.MANUAL,
};

// drain key -> in-flight drain promise, keyed by app name for a whole-app drain and by
// component identifier for a component drain: single-flight, so several components of
// one app (or repeated reconcile passes) never start a second drain for the same scope.
const inFlight = new Map();
// Drain keys whose last daemon drain failed (unreachable/timeout). The next reconcile
// pass does ONE local stop (returns false) and clears the mark, so a transient daemon
// outage never wedges into a re-route loop, yet daemon routing resumes once it recovers.
const localFallback = new Set();

/**
 * Request a graceful stop-but-keep via flux-shutdownd. Returns true when the daemon
 * owns the stop (the reconciler then takes NO docker action); false when the reconciler
 * should stop locally (non-Arcane, daemon unavailable/failed, or app unknown).
 *
 * @param {string} identifier component identifier (e.g. web_<app identity>)
 * @param {string} reconcilerReason the reconciler's desired-stopped reason
 * @returns {Promise<boolean>}
 */
async function requestGracefulStop(identifier, reconcilerReason) {
  if (!globalState.isArcane()) return false;

  // The row that owns this component names the app - identifiers are built from
  // the minted identity and cannot be taken apart into a name. A row the boot
  // backfill has not resolved yet does not answer, and the local stop below is
  // exactly what such rows get today.
  const instantiated = (await appRecords.installedByIdentifier(identifier))?.record;
  if (!instantiated) return false;
  const appName = instantiated.name;

  // A whole-app drain in flight covers every component of the app.
  if (inFlight.has(appName)) return true;
  let deployments;
  try {
    deployments = await deploymentProvider.buildDeployments(instantiated);
  } catch {
    return false;
  }
  if (deployments.length === 0) return false;

  const scope = await drainScope(identifier, deployments);
  const key = scope ? identifier : appName;
  // A drain just failed: do one local stop, then re-allow daemon routing next time.
  if (localFallback.has(key)) {
    localFallback.delete(key);
    return false;
  }
  // Already draining (an earlier pass): the drain owns the stop.
  if (inFlight.has(key)) return true;

  const reason = RECONCILER_REASON_TO_SHUTDOWN[reconcilerReason] || SHUTDOWN_REASON.MANUAL;
  // A whole-app stop budgets for ALL of this node's deployments - the daemon drains
  // them sequentially within the app. A component stop budgets for that component.
  const budgetSeconds = scope
    ? scope.component.shutdownBudgetSeconds()
    : deployments.reduce((sum, d) => sum + shutdownPlan.appShutdownBudgetSeconds(d), 0);
  const deadline = Math.floor(Date.now() / 1000) + budgetSeconds;
  const options = scope
    ? {
      force: false, deadline, replica: scope.replica, component: scope.component.name,
    }
    : { force: false, deadline };

  // A whole-app beginAppStop seeds the 'stopping' LB gate synchronously before its
  // first await, so the gate is set before we return and suppresses the reconciler's
  // subsequent passes. A component stop seeds no gate: its siblings keep running.
  const drain = fluxShutdowndClient
    .beginAppStop(shutdownPlan.daemonIdentity(instantiated), appName, reason, options)
    .then((res) => {
      inFlight.delete(key);
      if (res.outcome === 'unreachable' || res.outcome === 'timeout') {
        // The daemon did not handle it (the client has already un-seeded any gate it
        // seeded): re-drive so the reconciler does a local graceful stop, rather than
        // waiting out the whole budget.
        log.warn(`appShutdownCoordinator: ${scope ? identifier : appName} daemon stop ${res.outcome}; falling back to local`);
        localFallback.add(key);
        appReconciler.enqueueComponent(identifier);
        return;
      }
      // component_busy: another component-scoped run holds this component; the re-drive
      // below asks the daemon again on the next pass.
      // rejected_pipeline_active: the node-wide pipeline owns the stop and the gate
      // stays up for it (its clear/expiry re-drives recovery).
      if (res.outcome === 'rejected_pipeline_active') return;
      // complete|deadline|superseded: the drain is OVER (the client has un-seeded the
      // gate it seeded). Re-drive: an operator start/restart issued during the drain
      // already ran its (suppressed) reconcile.
      appReconciler.enqueueComponent(identifier);
    })
    .catch((e) => {
      inFlight.delete(key);
      log.warn(`appShutdownCoordinator: ${scope ? identifier : appName} drain error: ${e.message}`);
    });
  inFlight.set(key, drain);
  return true;
}

/**
 * What a stop of this component drains: the whole app when every component this
 * node runs of it is desired stopped, otherwise this component alone - an operator
 * stop can name a single component, and draining the app for it stops the rest.
 * A sibling whose desired state cannot be read counts as running, so a read that
 * fails narrows the stop rather than widening it.
 *
 * @param {string} identifier component identifier being stopped
 * @param {object[]} deployments this node's DeploymentSpecs of the app
 * @returns {Promise<{replica: (string|null), component: object}|null>} null for the whole app
 */
async function drainScope(identifier, deployments) {
  let own = null;
  const siblings = [];
  for (const deployment of deployments) {
    for (const [, component] of deployment.componentEntries()) {
      if (component.identifier === identifier) own = { replica: deployment.replica, component };
      else siblings.push(component.identifier);
    }
  }
  if (!own) return null;
  const states = await Promise.all(siblings.map((id) => appReconciler.desiredRunState(id)
    .then((state) => state.desired === false, () => false)));
  return states.every(Boolean) ? null : own;
}

module.exports = {
  requestGracefulStop,
};
