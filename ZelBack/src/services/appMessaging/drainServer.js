const net = require('node:net');
const fs = require('node:fs');
const nodePath = require('node:path');

const log = require('../../lib/log');
const globalState = require('../utils/globalState');
const peerNotification = require('./peerNotification');

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

let server = null;

/**
 * Mark an app draining and trigger an immediate presence rebroadcast so peers
 * (and FDM) pull the backend from rotation well inside the drain budget. The
 * rebroadcast debounces internally, so the daemon's burst of per-component
 * calls collapses to a bounded number of broadcasts.
 */
function handleDrainApp(params) {
  const appName = params && params.app_name;
  if (!appName) throw new Error('drain_app: app_name required');
  globalState.drainingApps.set(appName, 'draining');
  peerNotification.checkAndNotifyPeersOfRunningApps();
  return { ok: true };
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
      return { jsonrpc: '2.0', id, result: handleDrainApp(params) };
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
  if (server) {
    server.close();
    server = null;
  }
}

module.exports = {
  start,
  stop,
  handleRequest,
  SOCKET_PATH,
};
