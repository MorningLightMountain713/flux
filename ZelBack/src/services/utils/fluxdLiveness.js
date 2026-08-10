'use strict';

const log = require('../../lib/log');

// Blocks are ~30s. Three missed in a row is enough to be worth a question, and not so
// eager that an ordinary slow block costs an RPC.
const DEFAULT_SILENCE_THRESHOLD_MS = 90_000;
const DEFAULT_PROBE_INTERVAL_MS = 30_000;
const DEFAULT_CHECK_INTERVAL_MS = 10_000;

/**
 * Decides whether fluxd is alive, for consumers fed by a push socket.
 *
 * A ZMQ subscriber cannot answer this on its own. The socket reconnects silently, so
 * it reports itself connected to a daemon that has stopped producing; and a quiet
 * chain is indistinguishable from a dead publisher. Silence is therefore a reason to
 * ask a question, never an answer.
 *
 * The asymmetry drives the design: a wrong "alive" costs a few seconds of stale
 * height, while a wrong "dead" reaches nodeStatusMonitor and daemonHealthMonitor and
 * removes every app on the node. So only a failed RPC can produce a dead verdict.
 *
 * @param {object} options
 * @param {function} options.elapsedSinceMessageMs returns ms since the last push
 *   message, or null if none has arrived
 * @param {function} options.probe async, resolves truthy when the daemon answers
 * @param {function} [options.onChange] called with (alive) on transitions only
 * @param {number} [options.silenceThresholdMs] quiet period that triggers a probe
 * @param {number} [options.probeIntervalMs] minimum gap between probes
 * @param {number} [options.checkIntervalMs] how often the threshold is evaluated
 * @returns {object} start, stop, alive, lastProbeSucceeded, checkNow
 */
function createFluxdLiveness(options) {
  const {
    elapsedSinceMessageMs,
    probe,
    onChange = null,
    silenceThresholdMs = DEFAULT_SILENCE_THRESHOLD_MS,
    probeIntervalMs = DEFAULT_PROBE_INTERVAL_MS,
    checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
  } = options;

  if (typeof elapsedSinceMessageMs !== 'function') {
    throw new Error('An elapsedSinceMessageMs function is mandatory');
  }

  if (typeof probe !== 'function') {
    throw new Error('A probe function is mandatory');
  }

  let timer = null;
  let stopped = false;
  let probing = false;
  let isAlive = true;
  let lastProbeAt = null;
  let lastProbeSucceeded = null;

  function setAlive(next) {
    if (isAlive === next) return;
    isAlive = next;
    log.info(`fluxdLiveness - daemon considered ${next ? 'alive' : 'unreachable'}`);
    if (onChange) {
      try {
        onChange(next);
      } catch (err) {
        log.error(`fluxdLiveness - change handler error: ${err.message}`);
      }
    }
  }

  function sinceProbeMs() {
    if (lastProbeAt === null) return Infinity;
    return Number(process.hrtime.bigint() - lastProbeAt) / 1_000_000;
  }

  async function runProbe() {
    // Single-flight. A probe slower than the check interval must not stack.
    if (probing) return;
    probing = true;

    try {
      const answered = await probe();
      lastProbeAt = process.hrtime.bigint();
      lastProbeSucceeded = Boolean(answered);
      setAlive(Boolean(answered));
    } catch (err) {
      lastProbeAt = process.hrtime.bigint();
      lastProbeSucceeded = false;
      log.warn(`fluxdLiveness - probe failed: ${err.message}`);
      setAlive(false);
    } finally {
      probing = false;
    }
  }

  /**
   * Evaluates the silence threshold and probes if it has been crossed. Exposed so a
   * caller can force an evaluation rather than wait for the next tick.
   * @returns {Promise<void>} Resolves once any probe has completed.
   */
  async function checkNow() {
    const elapsed = elapsedSinceMessageMs();

    // Traffic is proof of life on its own; nothing to ask.
    if (elapsed !== null && elapsed < silenceThresholdMs) {
      setAlive(true);
      return;
    }

    // Quiet, or nothing has ever arrived. Rate-limit so a genuinely idle chain
    // costs one RPC per interval rather than one per tick.
    if (sinceProbeMs() < probeIntervalMs) return;

    await runProbe();
  }

  function scheduleNext() {
    if (stopped) return;
    timer = setTimeout(async () => {
      timer = null;
      await checkNow();
      scheduleNext();
    }, checkIntervalMs);
  }

  /**
   * Begins evaluating liveness on the check interval.
   * @returns {void}
   */
  function start() {
    if (timer || stopped) return;
    scheduleNext();
  }

  /**
   * Stops evaluating. Any in-flight probe is allowed to finish.
   * @returns {void}
   */
  function stop() {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    alive: () => isAlive,
    checkNow,
    lastProbeSucceeded: () => lastProbeSucceeded,
    start,
    stop,
  };
}

module.exports = {
  createFluxdLiveness,
  DEFAULT_CHECK_INTERVAL_MS,
  DEFAULT_PROBE_INTERVAL_MS,
  DEFAULT_SILENCE_THRESHOLD_MS,
};
