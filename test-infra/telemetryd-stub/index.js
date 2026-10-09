// Mock flux-telemetryd for the integration harness.
//
// Stands in for the real Rust daemon at the FluxOS boundary — as the LISTENER:
// the real daemon owns the identity socket (systemd creates it) and FluxOS
// connects and pushes NDJSON (sync / track / untrack, each track carrying the
// app's sink). The mock listens on the same path so FluxOS's real client
// (ZelBack/src/services/telemetryIdentityService.js) is exercised unmodified.
// It is NOT the daemon — no cgroup sampling, no log tailing, no exporters. It
// exists solely so the FluxOS-side identity/sink pipeline can be observed.
//
// Mirrors the real daemon's semantics: one writer at a time (a new connection
// replaces the open one), every connection a new generation whose first line
// is FluxOS's sync.
//
// Runs as a second process INSIDE the FluxOS testcontainer, started before
// FluxOS (FluxOS feeds a daemon only if the socket exists when it starts). Two
// surfaces:
//   - the identity socket (FLUX_TELEMETRY_IDENTITY_SOCKET, default
//     /run/flux-telemetryd/identity.sock): accept + read only.
//   - an HTTP control port (TELEMETRYD_MOCK_CONTROL_PORT, default 16198) the
//     test drives to read the received events, reset the log, and drop
//     FluxOS's stream (proving FluxOS reconnects and re-syncs).

const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');

const SOCKET_PATH = process.env.FLUX_TELEMETRY_IDENTITY_SOCKET || '/run/flux-telemetryd/identity.sock';
const CONTROL_PORT = parseInt(process.env.TELEMETRYD_MOCK_CONTROL_PORT || '16198', 10);

const events = []; // every parsed message: { ...msg, seq, conn, receivedAt }
let seq = 0;
let conn = 0; // connection generation, so a test can tell pre/post-reconnect syncs apart
let socket = null;

function accept(sock) {
  conn += 1;
  const generation = conn;
  if (socket) socket.destroy();
  socket = sock;
  console.log(`telemetryd-stub: fluxos connected (conn ${generation})`);
  let buffer = '';

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

  sock.on('error', () => { /* close follows */ });
  sock.on('close', () => {
    if (socket === sock) socket = null;
  });
}

fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true });
fs.rmSync(SOCKET_PATH, { force: true });
const server = net.createServer(accept);
server.listen(SOCKET_PATH, () => {
  fs.chmodSync(SOCKET_PATH, 0o600);
  console.log(`telemetryd-stub: listening on ${SOCKET_PATH}`);
});

const control = http.createServer((req, res) => {
  const respond = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const connected = socket !== null;

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
