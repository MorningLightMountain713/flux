'use strict';

const log = require('../../lib/log');
const benchmarkService = require('../benchmarkService');
const globalState = require('./globalState');

// Poll cadence while waiting for the verdict to latch on an Arcane node. The latch
// settles ~1-12s after fluxbench boot, and is usually already settled by the time fluxos
// reaches the resolver (the systemd contract starts fluxbenchd first).
const PROBE_RETRY_MS = 1000;
// Surface a warning every N probes while still waiting, so an unusually slow latch is
// visible (it should always settle within fluxbench's <=3 attestation attempts).
const PROBE_WARN_EVERY = 15;

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

/**
 * Resolve the node-capability ("is-arcane") verdict once at boot, caching it onto
 * globalState.capabilityVerdict (boolean: true = arcane, false = legacy). Awaited at the
 * top of startFluxFunctions so every is-arcane consumer reads a settled value.
 *
 * Pre-gate: only the Arcane fluxos.service unit sets FLUX_ARCANE_NODE. Its absence is a
 * definitive legacy signal — a static fact baked into the locked Arcane image, never a
 * timeout — so legacy nodes (pm2, no unit) short-circuit without touching the benchmark
 * channel. Presence is only a trigger to run the real check; it is never the verdict itself.
 *
 * On an Arcane node the systemd boot contract guarantees fluxbenchd's RPC is answerable
 * (it signals readiness on RPC-listen before fluxos starts), so getnodetype always
 * responds; we poll until the verdict latches. We NEVER conclude legacy from a timeout —
 * a false legacy on a genuine Arcane node triggers legacy self-provisioning and can brick
 * it — only from a definitive latched signal (or an old daemon's -32601). If the latch
 * never settles (it always does within fluxbench's attestation attempts) we keep waiting
 * rather than guess: boot blocks fail-closed instead of proceeding on an unknown verdict.
 */
async function resolveNodeCapability() {
  if (!process.env.FLUX_ARCANE_NODE) {
    globalState.capabilityVerdict = false;
    log.info('nodeCapabilities - FLUX_ARCANE_NODE unset; node-capability verdict: legacy');
    return;
  }

  let attempts = 0;
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
      log.info('nodeCapabilities - node-capability verdict resolved: arcane');
      return;
    }
    if (state === 'legacy') {
      globalState.capabilityVerdict = false;
      log.info('nodeCapabilities - node-capability verdict resolved: legacy');
      return;
    }

    // pending / unreachable — not yet known. Keep polling; never conclude legacy from a
    // timeout. The latch settles fast in practice.
    attempts += 1;
    if (attempts % PROBE_WARN_EVERY === 0) {
      log.warn(`nodeCapabilities - verdict still ${state} after ${attempts} probes; waiting for the benchmark channel to latch`);
    }
    // eslint-disable-next-line no-await-in-loop
    await delay(PROBE_RETRY_MS);
  }
}

/**
 * @returns {boolean} the resolved verdict: true = arcane, false = legacy.
 */
function verdict() {
  return globalState.capabilityVerdict;
}

module.exports = {
  resolveNodeCapability,
  verdict,
  // exposed for tests
  probeOnce,
};
