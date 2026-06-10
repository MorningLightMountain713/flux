const net = require('node:net');
const fs = require('node:fs');
const nodePath = require('node:path');

const log = require('../../lib/log');
const globalState = require('../utils/globalState');
const peerNotification = require('./peerNotification');
const appReconciler = require('../appMonitoring/appReconciler');

/**
 * Inbound counterpart to utils/fluxShutdowndClient.js: the UNIX socket fluxos
 * serves so flux-shutdownd can ask it to drain an app's load-balanced traffic
 * before the node shuts down. Newline-delimited JSON-RPC, matching the daemon's
 * fluxos_client.rs contract.
 *
 * Deliberately a local UNIX socket, NOT the public HTTP API: the API binds all
 * interfaces and is UPnP-forwarded, so a network-reachable drain endpoint would
 * be a remote DoS. Caller authorization is by filesystem permissions -- the
 * socket is group flux-daemon-access, mode 0660; ownership/group are a
 * deployment concern (fluxos runs with that group on Arcane).
 */

const SOCKET_PATH = process.env.FLUX_DRAIN_SOCKET || '/run/fluxos/drain.sock';
const isArcane = Boolean(process.env.FLUXOS_PATH);

// An entry outlives the pipeline deadline by this much before self-expiring:
// the post-deadline tail (SIGKILL sweep, fs sync, unit ordering) is alive-but-
// going-down, and reverting to active during it would flap the network state.
const DEADLINE_SLACK_MS = 120 * 1000;
// Expiry for a call with a missing/invalid deadline (test tooling, buggy
// caller): the schema's max per-port drain timeout, so a botched deadline
// field alone can never cut a legitimate drain short.
const FALLBACK_TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

let server = null;
let sweepTimer = null;

/**
 * Entries must self-expire rather than wait on an explicit clear: the one case
 * that wedges the node is the daemon dying mid-pipeline, and a dead daemon
 * clears nothing. Past deadline+slack the shutdown demonstrably failed, so the
 * sweep reverts the app to active, rebroadcasts, and enqueues a reconcile —
 * the reconciler restarts whatever the pipeline stopped, immediately.
 */
function expiryFromDeadline(deadlineUnixSeconds) {
  const now = Date.now();
  const deadlineMs = Number(deadlineUnixSeconds) * 1000;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= now) return now + FALLBACK_TTL_MS;
  return deadlineMs + DEADLINE_SLACK_MS;
}

function stopSweepTimer() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

function sweepExpiredStates() {
  const expired = globalState.sweepExpiredAppLbStates();
  if (expired.length) {
    log.warn(`drain state expired for ${expired.join(', ')} - shutdown pipeline did not complete, reverting to active`);
    peerNotification.checkAndNotifyPeersOfRunningApps();
    appReconciler.enqueueAll('drain-expired').catch((err) => log.error(`drain expiry reconcile failed: ${err.message}`));
  }
  if (!globalState.hasAppLbStates()) stopSweepTimer();
  return expired;
}

function ensureSweepTimer() {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepExpiredStates, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

/**
 * Mark an app draining/stopping and trigger an immediate presence rebroadcast
 * so peers (and FDM) pull the backend from rotation well inside the drain
 * budget. The rebroadcast debounces internally, so the daemon's burst of
 * per-component calls collapses to a bounded number of broadcasts.
 */
function handleSetState(method, state, params) {
  const appName = params && params.app_name;
  if (!appName) throw new Error(`${method}: app_name required`);
  globalState.setAppLbState(appName, state, expiryFromDeadline(params.deadline));
  ensureSweepTimer();
  peerNotification.checkAndNotifyPeersOfRunningApps();
  return { ok: true };
}

/**
 * Drop an app's drain/stop state (pipeline aborted): the app reverts to
 * active on the next broadcast, and a reconcile sweep restarts whatever the
 * pipeline stopped.
 */
function handleClearApp(params) {
  const appName = params && params.app_name;
  if (!appName) throw new Error('clear_app: app_name required');
  const existed = globalState.clearAppLbState(appName);
  if (!globalState.hasAppLbStates()) stopSweepTimer();
  if (existed) {
    peerNotification.checkAndNotifyPeersOfRunningApps();
    appReconciler.enqueueAll('drain-cleared').catch((err) => log.error(`drain clear reconcile failed: ${err.message}`));
  }
  return { ok: true, existed };
}

/**
 * Dispatch one JSON-RPC request line to a response object. Exported for tests.
 */
function handleRequest(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } };
  }
  const { id = null, method, params } = req;
  try {
    if (method === 'drain_app') {
      return { jsonrpc: '2.0', id, result: handleSetState(method, 'draining', params) };
    }
    if (method === 'stop_app') {
      return { jsonrpc: '2.0', id, result: handleSetState(method, 'stopping', params) };
    }
    if (method === 'clear_app') {
      return { jsonrpc: '2.0', id, result: handleClearApp(params) };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } };
  } catch (error) {
    return { jsonrpc: '2.0', id, error: { code: -32000, message: error.message } };
  }
}

function onConnection(socket) {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) socket.write(`${JSON.stringify(handleRequest(line))}\n`);
      newline = buffer.indexOf('\n');
    }
  });
  socket.on('error', (err) => log.warn(`drain socket connection error: ${err.message}`));
}

/**
 * Start the drain socket server. Arcane-only -- only the local flux-shutdownd
 * connects, so non-Arcane nodes create no socket. Best-effort: a bind failure
 * is logged, never fatal to startup.
 */
async function start() {
  if (server || !isArcane) return;
  try {
    fs.mkdirSync(nodePath.dirname(SOCKET_PATH), { recursive: true });
    try { fs.chmodSync(nodePath.dirname(SOCKET_PATH), 0o750); } catch { /* dir owned elsewhere */ }
    try { fs.unlinkSync(SOCKET_PATH); } catch { /* no stale socket */ }

    const srv = net.createServer(onConnection);
    await new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(SOCKET_PATH, resolve);
    });
    fs.chmodSync(SOCKET_PATH, 0o660);
    server = srv;
    log.info(`drain socket listening at ${SOCKET_PATH}`);
  } catch (error) {
    log.warn(`drain socket server failed to start: ${error.message}`);
  }
}

function stop() {
  stopSweepTimer();
  if (server) {
    server.close();
    server = null;
  }
}

module.exports = {
  start,
  stop,
  handleRequest,
  sweepExpiredStates,
  SOCKET_PATH,
};
