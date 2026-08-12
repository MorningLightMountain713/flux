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
const appsRepository = require('../appDatabase/appsRepository');
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

// app name -> in-flight drain promise: single-flight, so several components of one app
// (or repeated reconcile passes) never start a second drain for the same app.
const inFlight = new Map();
// Apps whose last daemon drain failed (unreachable/timeout). The next reconcile pass
// does ONE local stop (returns false) and clears the mark, so a transient daemon outage
// never wedges into a re-route loop, yet daemon routing resumes once it recovers.
const localFallback = new Set();

function baseAppName(identifier) {
  return identifier.includes('_') ? identifier.split('_')[1] : identifier;
}

/**
 * Request a graceful stop-but-keep via flux-shutdownd. Returns true when the daemon
 * owns the stop (the reconciler then takes NO docker action); false when the reconciler
 * should stop locally (non-Arcane, daemon unavailable/failed, or app unknown).
 *
 * @param {string} identifier component identifier (e.g. web_myapp)
 * @param {string} reconcilerReason the reconciler's desired-stopped reason
 * @returns {Promise<boolean>}
 */
async function requestGracefulStop(identifier, reconcilerReason) {
  if (!globalState.isArcane()) return false;
  const appName = baseAppName(identifier);

  // A drain just failed: do one local stop, then re-allow daemon routing next time.
  if (localFallback.has(appName)) {
    localFallback.delete(appName);
    return false;
  }
  // Already draining (another component, or an earlier pass): the LB gate holds it.
  if (inFlight.has(appName)) return true;

  const instantiated = await appsRepository.getInstalledApp(appName);
  if (!instantiated) return false;
  // This is a whole-app stop (operator stop / hold / condemned drains every local
  // replica together), so the deadline budgets for ALL of this node's deployments -
  // the daemon drains them sequentially within the app.
  let deployments;
  try {
    deployments = await deploymentProvider.buildDeployments(instantiated);
  } catch {
    return false;
  }
  if (deployments.length === 0) return false;

  const reason = RECONCILER_REASON_TO_SHUTDOWN[reconcilerReason] || SHUTDOWN_REASON.MANUAL;
  const budgetSeconds = deployments.reduce((sum, d) => sum + shutdownPlan.appShutdownBudgetSeconds(d), 0);
  const deadline = Math.floor(Date.now() / 1000) + budgetSeconds;

  // beginAppStop seeds the 'stopping' LB gate synchronously before its first await, so
  // the gate is set before we return and suppresses the reconciler's subsequent passes.
  const drain = fluxShutdowndClient
    .beginAppStop(instantiated.owner, appName, reason, { force: false, deadline })
    .then((res) => {
      inFlight.delete(appName);
      if (res.outcome === 'unreachable' || res.outcome === 'timeout') {
        // The daemon did not handle it: drop the gate and re-drive so the reconciler does
        // a local graceful stop, rather than waiting out the whole budget.
        log.warn(`appShutdownCoordinator: ${appName} daemon stop ${res.outcome}; falling back to local`);
        localFallback.add(appName);
        globalState.clearAppShutdownPipelineState(appName);
        appReconciler.enqueueComponent(identifier);
        return;
      }
      // rejected_pipeline_active: the node-wide pipeline owns the stop and the gate
      // stays up for it (its clear/expiry re-drives recovery).
      if (res.outcome === 'rejected_pipeline_active') return;
      // complete|deadline|superseded: the drain is OVER - the gate has nothing left
      // to protect. Clear it and re-drive: an operator start/restart issued during
      // the drain already ran its (suppressed) reconcile, and without this the app
      // sits wedged 'stopping' for the remainder of the budget window.
      globalState.clearAppShutdownPipelineState(appName);
      appReconciler.enqueueComponent(identifier);
    })
    .catch((e) => {
      inFlight.delete(appName);
      log.warn(`appShutdownCoordinator: ${appName} drain error: ${e.message}`);
    });
  inFlight.set(appName, drain);
  return true;
}

module.exports = {
  requestGracefulStop,
};
