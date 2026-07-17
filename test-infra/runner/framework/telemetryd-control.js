// Drives the mock flux-telemetryd (test-infra/telemetryd-stub) that runs inside a
// node's container for the telemetry suites. The mock is the CLIENT of FluxOS's
// identity socket — it records every pushed sync/started/stopped message — and
// exposes an HTTP control port (default 16198) on the node's own IP, so the test
// can read the received events, reset the log between scenarios, and force a
// disconnect (the server replays a full sync on reconnect). `nodeNum` is the
// 1-based node index (as nodeClient uses).
import { getSubnetConfig } from './subnet-config.js';

const CONTROL_PORT = parseInt(process.env.TELEMETRYD_MOCK_CONTROL_PORT || '16198', 10);

export function telemetrydControl(nodeNum) {
  const ip = getSubnetConfig().nodeIp(nodeNum);
  const base = `http://${ip}:${CONTROL_PORT}`;

  async function get(path) {
    const res = await fetch(`${base}${path}`);
    return res.json();
  }
  async function post(path, body) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    return res.json();
  }

  return {
    ip,
    health: () => get('/health'),
    getEvents: async () => (await get('/events')).events,
    reset: () => post('/reset', {}),
    // drop the current connection -> the stub reconnects and the server
    // replays a full sync (the real daemon's crash-recovery path)
    disconnect: () => post('/disconnect', {}),
  };
}

// The mock's event log is HTTP-polled (there is no FluxOS event for "pushed to
// the daemon"), so waits on it poll rather than block on an event. Resolves the
// first event matching `predicate`, or throws with the log for a legible failure.
export async function waitForTelemetryEvent(control, predicate, { timeout = 30000, interval = 300 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const events = await control.getEvents().catch(() => []);
    const match = events.find(predicate);
    if (match) return match;
    if (Date.now() > deadline) {
      throw new Error(`waitForTelemetryEvent: no matching event within ${timeout}ms; log: ${JSON.stringify(events).slice(0, 3000)}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, interval); });
  }
}

// Every identity a telemetry-app container is announced with, flattened across
// sync (batched containers) and started (single container) events — the
// daemon-side view of "what would I be tracking, with which sink".
export function announcedIdentities(events) {
  const out = [];
  for (const e of events) {
    if (e.op === 'started' && e.identity) out.push({ conn: e.conn, seq: e.seq, container_id: e.container_id, identity: e.identity });
    if (e.op === 'sync') {
      for (const c of e.containers || []) out.push({ conn: e.conn, seq: e.seq, container_id: c.container_id, identity: c.identity });
    }
  }
  return out;
}
