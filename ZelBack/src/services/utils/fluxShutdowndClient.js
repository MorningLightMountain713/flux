const net = require('node:net');

const log = require('../../lib/log');
const globalState = require('./globalState');

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
// Slack added on top of an app stop's budget: covers the daemon's reply latency
// after the drain, and bounds how long the `stopping` LB gate is held.
const COMPLETION_SLACK_MS = 120000;
// JSON-RPC error code the daemon returns from begin_app_stop when a node-wide
// pipeline owns the node (mirrors shutdownd's socket reject).
const RPC_NODE_PIPELINE_ACTIVE = -32010;

/**
 * The reasons FluxOS emits for a PER-APP stop, as kebab wire strings the daemon's
 * ReasonCode parser accepts. Each maps to a concrete FluxOS trigger; callers MUST
 * use these exact values (the daemon rejects an unrecognised reason). Deliberately
 * a subset of the daemon's full ReasonCode set — node-wide-only reasons like
 * 'system' (the begin_pipeline default) never originate a per-app stop.
 */
const SHUTDOWN_REASON = Object.freeze({
  TTL_EXPIRED: 'ttl-expired', // subscription/TTL expiry sweep
  USER_CANCEL: 'user-cancel', // owner cancel, or reconciler operator-stop
  REDEPLOY: 'redeploy', // redeploy/reinstall of the same app
  EVICTION: 'eviction', // reconciler condemned the app
  MANUAL: 'manual', // operation/controller hold
});

let currentId = 0;

/**
 * Issue one JSON-RPC call over a fresh connection to the daemon socket.
 * @param {string} method
 * @param {object} params
 * @returns {Promise<any>} the RPC result
 */
function callRpc(method, params = {}, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
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
      () => {
        const err = new Error(`flux-shutdownd RPC ${method} timed out`);
        err.isTimeout = true;
        finish(reject, err);
      },
      timeoutMs,
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
        // Preserve the JSON-RPC code so callers can discriminate (e.g. a
        // node-pipeline-active reject) without string-matching the message.
        const err = new Error(response.error.message || `flux-shutdownd RPC ${method} error`);
        err.rpcCode = response.error.code;
        finish(reject, err);
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
 * @returns {Promise<Array<{app_name: string, owner_flux_id: string, spec_hash: string}>>}
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

function isNodePipelineActive(err) {
  return Boolean(err) && err.rpcCode === RPC_NODE_PIPELINE_ACTIVE;
}

function isTimeout(err) {
  return Boolean(err) && err.isTimeout === true;
}

/**
 * Ask flux-shutdownd to gracefully stop ONE app and await its terminal outcome.
 *
 * Never throws — returns a discriminated `{ outcome }`:
 *   complete | deadline | superseded  — the daemon's end-state;
 *   rejected_pipeline_active          — a node-wide shutdown owns the node;
 *   unreachable | timeout             — daemon absent/down, or no reply in time;
 *   not_arcane                        — no daemon here (short-circuit, no socket).
 *
 * Seeds the `stopping` LB gate synchronously BEFORE the first await, so even a
 * fire-and-don't-await caller suppresses container recovery for the whole drain.
 *
 * @param {string} ownerFluxId
 * @param {string} appName
 * @param {string} reason one of SHUTDOWN_REASON
 * @param {{force?: boolean, deadline: number}} opts deadline is an absolute unix time (s)
 * @returns {Promise<{outcome: string}>}
 */
async function beginAppStop(ownerFluxId, appName, reason, { force = false, deadline } = {}) {
  // Non-Arcane nodes have no daemon socket: short-circuit before opening anything
  // or arming a timeout, and without touching the LB gate.
  if (!globalState.isArcane()) return { outcome: 'not_arcane' };

  // epoch ms, matching the gate's Date.now() expiry; deadline is absolute unix-seconds.
  const expiresAt = (deadline * 1000) + COMPLETION_SLACK_MS;
  globalState.setAppLbState(appName, 'stopping', expiresAt);

  const timeoutMs = Math.max((deadline * 1000) - Date.now(), 0) + COMPLETION_SLACK_MS;
  try {
    const res = await callRpc(
      'begin_app_stop',
      {
        owner_flux_id: ownerFluxId, app_name: appName, reason, force, deadline,
      },
      { timeoutMs },
    );
    return { outcome: res.end_state };
  } catch (error) {
    if (isNodePipelineActive(error)) return { outcome: 'rejected_pipeline_active' };
    if (isTimeout(error)) return { outcome: 'timeout' };
    return { outcome: 'unreachable' };
  }
}

/**
 * Escalate an in-flight per-app graceful drain to an immediate force-kill — an
 * operator's explicit force-remove preempting the drain. Never throws; returns a
 * discriminated `{ outcome }`:
 *   forced | no_run   — the daemon's end-state (escalated, or nothing was draining);
 *   unreachable       — daemon absent/down;
 *   not_arcane        — no daemon here (short-circuit).
 *
 * @param {string} ownerFluxId
 * @param {string} appName
 * @returns {Promise<{outcome: string}>}
 */
async function forceAppStop(ownerFluxId, appName) {
  if (!globalState.isArcane()) return { outcome: 'not_arcane' };
  try {
    const res = await callRpc('force_app_stop', { owner_flux_id: ownerFluxId, app_name: appName });
    return { outcome: res.end_state };
  } catch {
    return { outcome: 'unreachable' };
  }
}

module.exports = {
  callRpc,
  upsertAppPlan,
  deleteAppPlan,
  listAppPlans,
  upsertAppPlanBestEffort,
  deleteAppPlanBestEffort,
  beginAppStop,
  forceAppStop,
  SHUTDOWN_REASON,
  SOCKET_PATH,
};
