const net = require('node:net');

const log = require('../../lib/log');

/**
 * Client for the flux-shutdownd plan-handoff socket.
 *
 * At deploy/update/uninstall time FluxOS pushes each enterprise app's shutdown
 * plan to flux-shutdownd so the daemon can drive a graceful, reason-aware
 * shutdown (drain, preStop, honored grace period) when the node goes down —
 * without having to consult FluxOS at shutdown time.
 *
 * Wire protocol matches the daemon's socket exactly: newline-delimited
 * JSON-RPC 2.0, one request per connection, no auth handshake (the socket is
 * root-only and SO_PEERCRED-checked by the daemon). This is deliberately NOT
 * the WebSocket framing fluxConfigdClient uses — a local unix socket needs none
 * of it.
 *
 * Every call is best-effort from the caller's perspective: connection failures
 * (daemon absent on non-Arcane nodes, or down) reject, and callers log-and-
 * continue. The daemon's resync-on-boot reconciles anything missed.
 */

const SOCKET_PATH = process.env.FLUX_SHUTDOWND_SOCKET || '/run/flux-shutdownd/daemon.sock';
const CALL_TIMEOUT_MS = 10000;

let currentId = 0;

/**
 * Issue one JSON-RPC call over a fresh connection to the daemon socket.
 * @param {string} method
 * @param {object} params
 * @returns {Promise<any>} the RPC result
 */
function callRpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    currentId += 1;
    const id = currentId;
    const request = `${JSON.stringify({
      jsonrpc: '2.0', method, params, id,
    })}\n`;

    const socket = net.createConnection(SOCKET_PATH);
    let buffer = '';
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn(arg);
    };

    const timer = setTimeout(
      () => finish(reject, new Error(`flux-shutdownd RPC ${method} timed out`)),
      CALL_TIMEOUT_MS,
    );

    socket.on('connect', () => socket.write(request));
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      let response;
      try {
        response = JSON.parse(buffer.slice(0, newline));
      } catch (err) {
        finish(reject, err);
        return;
      }
      if (response.error) {
        finish(reject, new Error(response.error.message || `flux-shutdownd RPC ${method} error`));
      } else {
        finish(resolve, response.result);
      }
    });
    socket.on('error', (err) => finish(reject, err));
  });
}

/**
 * Insert or replace an app's shutdown plan.
 * @param {object} plan the full AppPlan (see buildShutdownPlan)
 */
async function upsertAppPlan(plan) {
  return callRpc('upsert_app_plan', { plan });
}

/**
 * Remove an app's shutdown plan on uninstall.
 * @param {string} appName
 * @param {string} ownerFluxId
 */
async function deleteAppPlan(appName, ownerFluxId) {
  return callRpc('delete_app_plan', { app_name: appName, owner_flux_id: ownerFluxId });
}

/**
 * List the plan summaries the daemon currently holds, for resync-on-boot.
 * @returns {Promise<Array<{app_name: string, owner_flux_id: string, content_hash: string}>>}
 */
async function listAppPlans() {
  return callRpc('list_app_plans', {});
}

/**
 * Best-effort wrapper: push a plan, swallowing+logging any failure so an
 * unreachable daemon never breaks the install/update path.
 */
async function upsertAppPlanBestEffort(plan) {
  try {
    await upsertAppPlan(plan);
  } catch (error) {
    log.warn(`flux-shutdownd upsertAppPlan(${plan?.app_name}) failed: ${error.message}`);
  }
}

/**
 * Best-effort wrapper for uninstall.
 */
async function deleteAppPlanBestEffort(appName, ownerFluxId) {
  try {
    await deleteAppPlan(appName, ownerFluxId);
  } catch (error) {
    log.warn(`flux-shutdownd deleteAppPlan(${appName}) failed: ${error.message}`);
  }
}

module.exports = {
  callRpc,
  upsertAppPlan,
  deleteAppPlan,
  listAppPlans,
  upsertAppPlanBestEffort,
  deleteAppPlanBestEffort,
  SOCKET_PATH,
};
