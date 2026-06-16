const config = require('config');
const log = require('../../lib/log');
const benchmarkService = require('../benchmarkService');
const globalState = require('./globalState');

// Boot budget to first-conclude the verdict — shares the boot daemon/sync timeout
// so an unreachable benchmark channel is treated like the other boot dependencies.
const RESOLVE_BUDGET_MS = config.system.bootDaemonTimeoutMs ?? 300000;
// Fast retry while resolving within the boot window (catches the ~10s latch settle
// quickly); slow recheck afterwards, only to pick up a late channel recovery.
const PROBE_RETRY_MS = 3000;
const PROBE_RECHECK_MS = 60000;

let started = false;

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer.unref) timer.unref();
  });
}

/**
 * One probe round over the benchmark channel. Two steps so a definitive
 * method-not-found (older daemon = legacy) is separable from a transient transport
 * failure: first a reachability call both old and new daemons answer, then
 * getnodetype.
 * @returns {Promise<'arcane'|'legacy'|'pending'|'unreachable'>}
 */
async function probeOnce() {
  const reachable = await benchmarkService.getStatus();
  if (!reachable || reachable.status !== 'success') return 'unreachable';

  const response = await benchmarkService.getNodeType();
  if (response && response.status === 'success' && response.data && typeof response.data.nodetype === 'string') {
    const { nodetype } = response.data;
    if (nodetype === 'arcane' || nodetype === 'legacy') return nodetype;
    return 'pending'; // 'pending' or any unexpected value — keep waiting
  }
  // Channel is up (getStatus succeeded) but getnodetype errored. A registered-but-
  // unimplemented method on an older daemon comes back JSON-RPC -32601 / "Method not
  // found" => definitively legacy; anything else is treated as transient => retry.
  const code = response && response.data && response.data.code;
  const message = (response && response.data && response.data.message) || '';
  if (code === -32601 || /method not found/i.test(message) || /invalid method/i.test(message)) {
    return 'legacy';
  }
  return 'unreachable';
}

async function resolveLoop() {
  const deadline = Date.now() + RESOLVE_BUDGET_MS;
  for (;;) {
    let state;
    try {
      // eslint-disable-next-line no-await-in-loop
      state = await probeOnce();
    } catch (error) {
      log.warn(`nodeCapabilities - probe error: ${error.message}`);
      state = 'unreachable';
    }

    if (state === 'arcane') {
      globalState.capabilityVerdict = true;
      globalState.markCapabilityResolved();
      log.info('nodeCapabilities - node-capability verdict resolved: arcane');
      return;
    }
    if (state === 'legacy') {
      globalState.capabilityVerdict = false;
      globalState.markCapabilityResolved();
      log.info('nodeCapabilities - node-capability verdict resolved: legacy');
      return;
    }

    // pending / unreachable — not yet known.
    if (!globalState.capabilityResolved && Date.now() >= deadline) {
      // Boot-bounded conclusion: still unknown at the boot budget. Conclude
      // not-attested so consumers stop blocking; keep probing so a late channel
      // recovery can still flip the verdict up to attested (never the reverse).
      globalState.capabilityVerdict = false;
      globalState.markCapabilityResolved();
      log.warn('nodeCapabilities - benchmark channel unresolved within boot budget; concluding legacy (still probing for recovery)');
    }
    // eslint-disable-next-line no-await-in-loop
    await delay(globalState.capabilityResolved ? PROBE_RECHECK_MS : PROBE_RETRY_MS);
  }
}

/**
 * Seed the node-capability probe (fire-once). Resolves onto
 * globalState.capabilityVerdict + capabilityResolvedGate. Safe to seed before the
 * daemon is ready — it depends only on the benchmark channel, not the flux daemon.
 */
function start() {
  if (started) return;
  started = true;
  resolveLoop().catch((error) => {
    log.error(`nodeCapabilities - resolve loop terminated: ${error.message}`);
  });
}

/**
 * @returns {boolean|null} tri-state verdict: true attested, false not-attested, null unknown.
 */
function verdict() {
  return globalState.capabilityVerdict;
}

module.exports = {
  start,
  verdict,
  // exposed for tests
  probeOnce,
};
