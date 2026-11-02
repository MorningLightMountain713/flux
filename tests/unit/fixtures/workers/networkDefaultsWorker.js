const net = require('node:net');
const dns = require('node:dns');
const { parentPort } = require('worker_threads');

// Reports the outbound connection defaults in effect in this thread, in whichever reply shape
// the spawner expects: a verifyPool batch ({ id, items }) is answered with its id and one
// result per item, anything else with { ok, result }.
function seen() {
  return { attemptMs: net.getDefaultAutoSelectFamilyAttemptTimeout(), order: dns.getDefaultResultOrder() };
}

parentPort.on('message', (payload) => {
  if (payload && Array.isArray(payload.items)) {
    parentPort.postMessage({ id: payload.id, results: payload.items.map(seen) });
    return;
  }
  parentPort.postMessage({ ok: true, result: seen() });
});
