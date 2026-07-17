// Mock flux-telemetryd for the integration harness.
//
// Stands in for the real Rust daemon at the FluxOS boundary — as a CLIENT: the
// real daemon connects to FluxOS's identity socket and consumes the pushed
// NDJSON stream (sync / started / stopped, each started carrying the app's
// sink). The mock speaks that client role so FluxOS's real server
// (ZelBack/src/services/telemetryIdentityService.js) is exercised unmodified.
// It is NOT the daemon — no cgroup sampling, no log tailing, no exporters. It
// exists solely so the FluxOS-side identity/sink pipeline can be observed.
//
// Mirrors the real client's semantics: persistent connection, reconnect on
// drop (the server replays a full sync on every connect), tolerate the socket
// not existing yet (the server appears only once fluxos boots and the Arcane
// write-probe passes). Reconnect delay is shortened for test speed.
//
// Runs as a second process INSIDE the FluxOS testcontainer (the socket is a
// node-local unix socket). Two surfaces:
//   - the identity socket (FLUX_TELEMETRY_IDENTITY_SOCKET, default
//     /run/flux/telemetry/identity.sock): connect + read only.
//   - an HTTP control port (TELEMETRYD_MOCK_CONTROL_PORT, default 16198) the
//     test drives to read the received events, reset the log, and force a
//     disconnect (proving reconnect + fresh sync).

const net = require('node:net');
const http = require('node:http');

const SOCKET_PATH = process.env.FLUX_TELEMETRY_IDENTITY_SOCKET || '/run/flux/telemetry/identity.sock';
const CONTROL_PORT = parseInt(process.env.TELEMETRYD_MOCK_CONTROL_PORT || '16198', 10);
const RECONNECT_DELAY_MS = 1000;

const events = []; // every parsed message: { ...msg, seq, conn, receivedAt }
let seq = 0;
let conn = 0; // connection generation, so a test can tell pre/post-reconnect syncs apart
let socket = null;
let connected = false;

function connect() {
  const generation = conn + 1;
  const sock = net.createConnection(SOCKET_PATH);
  let buffer = '';

  sock.on('connect', () => {
    conn = generation;
    connected = true;
    socket = sock;
    console.log(`telemetryd-stub: connected to ${SOCKET_PATH} (conn ${generation})`);
  });

  sock.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) {
        try {
          const msg = JSON.parse(line);
          events.push({
            ...msg, seq: seq += 1, conn: generation, receivedAt: Date.now(),
          });
        } catch (err) {
          console.error(`telemetryd-stub: unparseable line: ${err.message}: ${line.slice(0, 200)}`);
        }
      }
      idx = buffer.indexOf('\n');
    }
  });

  const scheduleReconnect = () => {
    if (socket === sock) {
      socket = null;
      connected = false;
    }
    setTimeout(connect, RECONNECT_DELAY_MS);
  };

  sock.on('error', () => { /* close follows; reconnect there */ });
  sock.on('close', scheduleReconnect);
}

const control = http.createServer((req, res) => {
  const respond = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'GET' && req.url === '/health') {
    respond(200, { ok: true, connected, conn, events: events.length });
    return;
  }
  if (req.method === 'GET' && req.url === '/events') {
    respond(200, { connected, conn, events });
    return;
  }
  if (req.method === 'POST' && req.url === '/reset') {
    events.length = 0;
    respond(200, { ok: true });
    return;
  }
  if (req.method === 'POST' && req.url === '/disconnect') {
    if (socket) socket.destroy();
    respond(200, { ok: true, wasConnected: connected });
    return;
  }
  respond(404, { error: 'unknown endpoint' });
});

control.listen(CONTROL_PORT, () => {
  console.log(`telemetryd-stub: control listening on ${CONTROL_PORT}`);
});

connect();
