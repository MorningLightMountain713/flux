// Mock flux-shutdownd for the integration harness.
//
// Stands in for the real Rust daemon at the FluxOS boundary: it binds the daemon's
// unix socket and speaks its JSON-RPC dialect so FluxOS's real client
// (ZelBack/src/services/utils/fluxShutdowndClient.js) talks to it unmodified. It is
// NOT the daemon — it has none of the sled store, dbus, drain state machine, or the
// outbound drain_app/stop_app/clear_app calls. It exists solely so the FluxOS-side
// per-app graceful-stop routing can be driven and observed.
//
// It runs as a second process INSIDE the FluxOS testcontainer (each node is DinD, so
// the app containers live in that node's inner dockerd and a sidecar could not reach
// them). On begin_app_stop it actually `docker stop`s the app's containers on the
// inner dockerd — otherwise FluxOS's subsequent non-force appDockerRemove would fail
// on a still-running container and the "daemon drained it" assertion would be a lie.
//
// Two surfaces:
//   - the daemon socket (FLUX_SHUTDOWND_SOCKET, default /run/flux-shutdownd/daemon.sock):
//     newline-delimited JSON-RPC 2.0, the contract FluxOS calls inbound.
//   - an HTTP control port (SHUTDOWND_MOCK_CONTROL_PORT, default 16199) the test drives
//     to set per-app begin_app_stop behaviour, read the call log, and refuse the socket.

const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SOCKET_PATH = process.env.FLUX_SHUTDOWND_SOCKET || '/run/flux-shutdownd/daemon.sock';
const CONTROL_PORT = parseInt(process.env.SHUTDOWND_MOCK_CONTROL_PORT || '16199', 10);

// The daemon's ReasonCode parser accepts this set; FluxOS only emits a subset. An
// unrecognised reason must produce -32602 so the reason-validation path is faithful.
const VALID_REASONS = new Set([
  'ttl-expired', 'user-cancel', 'redeploy', 'eviction', 'manual', 'system',
]);

const RPC_NODE_PIPELINE_ACTIVE = -32010;
const RPC_INVALID_PARAMS = -32602;

// begin_app_stop behaviours the test selects per app (or a global default):
//   complete   -> docker stop the app, reply { end_state: 'complete' }
//   deadline   -> docker stop the app, reply { end_state: 'deadline' } (grace elapsed)
//   superseded -> docker stop the app, reply { end_state: 'superseded' }
//   reject     -> reply error -32010 (node-pipeline-active); do NOT stop
//   hang       -> never reply; register as draining so force_app_stop can resolve it
const STOP_END_STATES = { complete: 'complete', deadline: 'deadline', superseded: 'superseded' };

const plans = new Map(); // `${identity}[:${replica}]` -> plan
const callLog = []; // { method, identity, app, replica, reason, force, deadline, ts, seq }
const draining = new Map(); // plan key -> { socket, id } for a hung begin_app_stop
const behavior = { default: 'complete', perApp: new Map() };
let seq = 0;
let refused = false;
let socketServer = null;

// A plan or a stop addresses one deployment of an app, as the daemon keys it:
// by the app's identity, with a named replica's name after it. Loose placement
// (null) keeps the bare identity. `:` cannot appear in an identity or a replica
// name, so the key is unambiguous.
const planKey = (identity, replica) => (replica == null ? identity : `${identity}:${replica}`);
const modeFor = (app) => behavior.perApp.get(app) || behavior.default;
const logCall = (entry) => { callLog.push({ ...entry, ts: Date.now(), seq: seq += 1 }); };

// Stop the app's containers on the inner dockerd, selected as the daemon selects
// them: by the identity FluxOS stamps on EVERY container it creates as
// io.runonflux.identity (graceful or not — the label schema is flux-spec's
// LABEL_KEYS, namespace included), which for an app with no identity minted is
// its name. A replica name narrows the set to that replica's containers via
// io.runonflux.replica — co-located siblings share the identity label, so
// stopping by identity alone would take the sibling down with it. A null replica
// means the whole app, which is what every whole-app path (expiry, cancel, node
// drain) wants. Best-effort: a missing docker CLI (e.g. local protocol tests) or
// an already-stopped container is not fatal — but say so, because a selector that
// silently matches nothing while replying 'complete' reads as a product mystery
// from the FluxOS side.
function dockerStopApp(identity, replica, component) {
  return new Promise((resolve) => {
    const filters = ['--filter', `label=io.runonflux.identity=${identity}`];
    if (replica != null) filters.push('--filter', `label=io.runonflux.replica=${replica}`);
    if (component != null) filters.push('--filter', `label=io.runonflux.component=${component}`);
    execFile('docker', ['ps', '-q', ...filters], (err, stdout) => {
      if (err) { resolve(0); return; }
      const ids = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      if (ids.length === 0) {
        console.log(`shutdownd-mock: stop ${identity}${replica == null ? '' : `/${replica}`}${component == null ? '' : ` component ${component}`} matched 0 running containers`);
        resolve(0);
        return;
      }
      let done = 0;
      ids.forEach((id) => {
        execFile('docker', ['stop', '-t', '3', id], () => {
          done += 1;
          if (done === ids.length) resolve(ids.length);
        });
      });
    });
  });
}

// The node's drain socket (fluxos-side): the daemon's messages about a stop's
// lifecycle travel it, and so do this mock's — stop_app before the stop, and
// app_stop_done after it, each stamped with the stop's id — because fluxos lifts
// an app's stopping state on app_stop_done, in order with the stop_app it
// follows, never on the begin_app_stop reply (another channel). Best-effort like
// the daemon's client: a missing socket is logged and the stop proceeds.
const DRAIN_SOCKET = process.env.FLUX_DRAIN_SOCKET || '/run/fluxos/drain.sock';
let stopSeq = 0;
function drainCall(method, params) {
  return new Promise((resolve) => {
    const sock = net.createConnection(DRAIN_SOCKET);
    const done = (why) => { if (why) console.error(`drain ${method} ${params.app_name}: ${why}`); sock.destroy(); resolve(); };
    const timer = setTimeout(() => done('timed out'), 2000);
    sock.once('connect', () => sock.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`));
    sock.once('data', () => { clearTimeout(timer); done(); });
    sock.once('error', (e) => { clearTimeout(timer); done(e.message); });
  });
}

function reply(socket, id, result) {
  if (socket.destroyed) return;
  socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function replyError(socket, id, code, message) {
  if (socket.destroyed) return;
  socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

async function handleBeginAppStop(socket, id, params) {
  // The identity selects the containers and the plan; the name is what FluxOS
  // keys the app's stopping state by, and the drain messages below carry it.
  const {
    identity, app_name: app, replica = null, component = null, reason, force, deadline,
  } = params || {};
  logCall({
    method: 'begin_app_stop', identity, app, replica, component, reason, force: Boolean(force), deadline,
  });
  if (!identity || !app) { replyError(socket, id, RPC_INVALID_PARAMS, 'invalid params: missing identity/app_name'); return; }
  if (!VALID_REASONS.has(reason)) { replyError(socket, id, RPC_INVALID_PARAMS, `invalid reason: ${reason}`); return; }

  stopSeq += 1;
  const stopId = stopSeq;
  const stateParams = {
    app_name: app, component_name: component ?? '', identity, reason, deadline, stop_id: stopId,
  };
  // A forceful stop (operator force teardown) is a zero-budget kill: always stop and
  // report complete, regardless of the configured drain behaviour.
  if (force) {
    if (component == null) await drainCall('stop_app', stateParams);
    await dockerStopApp(identity, replica, component);
    if (component == null) await drainCall('app_stop_done', { app_name: app, stop_id: stopId, end_state: 'complete' });
    reply(socket, id, { end_state: 'complete', stop_id: stopId });
    return;
  }

  const mode = modeFor(app);
  if (mode === 'reject') { replyError(socket, id, RPC_NODE_PIPELINE_ACTIVE, 'node-pipeline-active'); return; }
  if (mode === 'hang') {
    // Genuine in-flight drain: hold the reply open so an operator force-remove can
    // preempt it via force_app_stop (which resolves this same connection). Keyed per
    // deployment, so a force aimed at one replica cannot resolve its sibling's run.
    draining.set(planKey(identity, replica), { socket, id });
    return;
  }
  const endState = STOP_END_STATES[mode] || 'complete';
  if (component == null) await drainCall('stop_app', stateParams);
  await dockerStopApp(identity, replica, component);
  // superseded: the node-wide pipeline owns the app from here and re-drains it —
  // no done, exactly as the daemon sends none.
  if (component == null && endState !== 'superseded') {
    await drainCall('app_stop_done', { app_name: app, stop_id: stopId, end_state: endState });
  }
  reply(socket, id, { end_state: endState, stop_id: stopId });
}

async function handleForceAppStop(socket, id, params) {
  const { identity, replica = null } = params || {};
  logCall({ method: 'force_app_stop', identity, replica });
  if (!identity) { replyError(socket, id, RPC_INVALID_PARAMS, 'invalid params: missing identity'); return; }

  const key = planKey(identity, replica);
  const pending = draining.get(key);
  if (!pending) { reply(socket, id, { end_state: 'no_run' }); return; }

  // Escalate the in-flight drain: force-stop the containers, then resolve BOTH the
  // hung begin_app_stop connection and this force_app_stop with 'forced' — mirroring
  // the daemon's shared done-watch where both awaiters see the same end-state.
  await dockerStopApp(identity, replica);
  draining.delete(key);
  reply(pending.socket, pending.id, { end_state: 'forced' });
  reply(socket, id, { end_state: 'forced' });
}

function dispatch(socket, line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    replyError(socket, null, -32700, 'parse error');
    return;
  }
  const { id, method, params } = msg;
  switch (method) {
    case 'upsert_app_plan': {
      const plan = params && params.plan;
      if (!plan || !plan.app_name || !plan.identity) { replyError(socket, id, RPC_INVALID_PARAMS, 'invalid params: bad plan'); break; }
      const replica = plan.replica == null ? null : plan.replica;
      const k = planKey(plan.identity, replica);
      const replaced = plans.has(k);
      plans.set(k, plan);
      logCall({ method, identity: plan.identity, app: plan.app_name, replica });
      reply(socket, id, { ok: true, replaced_existing: replaced });
      break;
    }
    case 'delete_app_plan': {
      const { identity, replica = null } = params || {};
      const k = planKey(identity, replica);
      const existed = plans.delete(k);
      logCall({ method, identity, replica });
      reply(socket, id, { ok: true, existed });
      break;
    }
    case 'list_app_plans': {
      // The real daemon returns a bare array of summaries (not wrapped). `replica`
      // is required-and-nullable on the summary: the resync side reconciles per
      // deployment and cannot tell siblings apart without it.
      const summaries = [...plans.values()].map((p) => ({
        app_name: p.app_name,
        identity: p.identity,
        replica: p.replica == null ? null : p.replica,
        spec_hash: p.spec_hash,
      }));
      reply(socket, id, summaries);
      break;
    }
    case 'begin_app_stop':
      handleBeginAppStop(socket, id, params);
      break;
    case 'force_app_stop':
      handleForceAppStop(socket, id, params);
      break;
    default:
      replyError(socket, id, -32601, `method not found: ${method}`);
  }
}

function onConnection(socket) {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const rawLine = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (rawLine.trim()) dispatch(socket, rawLine);
      nl = buffer.indexOf('\n');
    }
  });
  socket.on('error', () => {});
  // If the client times out a hung drain and drops the connection, forget it so a
  // later force_app_stop correctly reports no_run instead of writing to a dead socket.
  socket.on('close', () => {
    for (const [k, pending] of draining) {
      if (pending.socket === socket) draining.delete(k);
    }
  });
}

function startSocket() {
  try { fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true }); } catch { /* exists */ }
  try { fs.unlinkSync(SOCKET_PATH); } catch { /* absent */ }
  socketServer = net.createServer(onConnection);
  socketServer.on('error', (err) => console.error(`shutdownd-mock socket error: ${err.message}`));
  socketServer.listen(SOCKET_PATH, () => console.log(`shutdownd-mock listening on ${SOCKET_PATH}`));
}

// Refuse the socket entirely: unlink + stop accepting so FluxOS's connect fails and
// beginAppStop returns { outcome: 'unreachable' } — the daemon-unreachable fallback.
function setRefused(value) {
  if (value && !refused) {
    refused = true;
    if (socketServer) socketServer.close();
    try { fs.unlinkSync(SOCKET_PATH); } catch { /* absent */ }
  } else if (!value && refused) {
    refused = false;
    startSocket();
  }
}

function startControl() {
  const server = http.createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const { pathname } = new URL(req.url, 'http://localhost');

    if (req.method === 'GET') {
      if (pathname === '/health') { send(200, { status: 'ok', socket: SOCKET_PATH, refused }); return; }
      if (pathname === '/state') {
        send(200, {
          refused,
          plans: [...plans.keys()],
          draining: [...draining.keys()],
          behavior: { default: behavior.default, perApp: Object.fromEntries(behavior.perApp) },
          calls: callLog.length,
        });
        return;
      }
      if (pathname === '/calls') { send(200, { calls: callLog }); return; }
      send(404, { error: 'not found' });
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = {}; }
        if (pathname === '/behavior') { behavior.default = parsed.mode || 'complete'; send(200, { ok: true, default: behavior.default }); return; }
        const m = pathname.match(/^\/behavior\/(.+)$/);
        if (m) { behavior.perApp.set(decodeURIComponent(m[1]), parsed.mode); send(200, { ok: true, app: decodeURIComponent(m[1]), mode: parsed.mode }); return; }
        if (pathname === '/refuse') { setRefused(Boolean(parsed.refused)); send(200, { ok: true, refused }); return; }
        if (pathname === '/reset') {
          callLog.length = 0;
          behavior.perApp.clear();
          behavior.default = 'complete';
          send(200, { ok: true });
          return;
        }
        send(404, { error: 'not found' });
      });
      return;
    }
    send(405, { error: 'method not allowed' });
  });
  server.listen(CONTROL_PORT, () => console.log(`shutdownd-mock control API on port ${CONTROL_PORT}`));
}

startSocket();
startControl();
