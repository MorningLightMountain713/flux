// Drives the mock flux-shutdownd (test-infra/shutdownd-stub) that runs inside each
// arcane node's container for the graceful-stop suites. The mock binds the daemon
// socket FluxOS's client calls and exposes an HTTP control port (default 16199) on
// the node's own IP, so the test can pick the begin_app_stop behaviour, refuse the
// socket, and read the call log it asserts against. `nodeNum` is the 1-based node
// index (as nodeClient uses).
import { getSubnetConfig } from './subnet-config.js';

const CONTROL_PORT = parseInt(process.env.SHUTDOWND_MOCK_CONTROL_PORT || '16199', 10);

export function shutdowndControl(nodeNum) {
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
    getState: () => get('/state'),
    getCalls: async () => (await get('/calls')).calls,
    // begin_app_stop behaviour for one app: complete | deadline | superseded | reject | hang
    setBehavior: (app, mode) => post(`/behavior/${encodeURIComponent(app)}`, { mode }),
    // begin_app_stop behaviour for every app that has no per-app override
    setDefaultBehavior: (mode) => post('/behavior', { mode }),
    // refuse the daemon socket entirely -> FluxOS's connect fails -> outcome unreachable
    refuse: (refused = true) => post('/refuse', { refused }),
    reset: () => post('/reset', {}),
  };
}

// The mock's call log is HTTP-polled (there is no FluxOS event for "routed to the
// daemon"), so waits on it poll rather than block on an event. Resolves the first
// call matching `predicate`, or throws with the log for a legible failure.
export async function waitForShutdowndCall(control, predicate, { timeout = 20000, interval = 300 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const calls = await control.getCalls();
    const match = calls.find(predicate);
    if (match) return match;
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for a matching shutdownd call; log=${JSON.stringify(calls)}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, interval); });
  }
}

// Assert a call matching `predicate` did NOT arrive within `window` ms (e.g. a
// non-operator removal must not escalate via force_app_stop).
export async function assertNoShutdowndCall(control, predicate, window = 4000) {
  const deadline = Date.now() + window;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const calls = await control.getCalls();
    const match = calls.find(predicate);
    if (match) throw new Error(`unexpected shutdownd call: ${JSON.stringify(match)}`);
    if (Date.now() > deadline) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 300); });
  }
}
