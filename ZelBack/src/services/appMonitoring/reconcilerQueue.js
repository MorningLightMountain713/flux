const log = require('../../lib/log');
const globalState = require('../utils/globalState');
const dockerService = require('../dockerService');
const { AsyncGate } = require('../utils/asyncGate');

// The reconciler's scheduling seam: a per-key single-flight, boot-gated workqueue.
// Producers (operator commands, mount/network repair, the deciders, the event
// bridge, install) push a component identifier here with enqueue(); the reconcile
// ENGINE (appReconciler) registers its reconcile function via setReconcile and is
// the consumer. Splitting this out keeps the producer-facing surface lightweight —
// a producer that only needs to enqueue does NOT pull the engine's heavy dependency
// tree (uninstaller, volume/query services, …), which is what turned the engine into
// an import hub and made every new producer a cycle risk.
//
// Dependencies are deliberately low-level only (log, globalState, dockerService for
// identifier canonicalization, asyncGate) — nothing in the app lifecycle/query layer.

// The reconciler's canonical id is the bare component identifier (`component_app`).
// Deciders disagree on the form they pass (masterSlave uses the bare identifier, the
// syncthing flow passes the flux-prefixed docker name), so normalise every inbound id
// here at the boundary, the same way dockerService normalises for docker calls.
const canonical = (id) => dockerService.getBaseAppName(id);

const inFlight = new Set(); // ids currently reconciling (per-key single-flight)
const dirty = new Set(); // ids re-requested while in flight -> reconcile again
const bootPending = new Set(); // ids enqueued before the boot gate opened
const backoffTimers = new Map(); // id -> scheduled retry timeout

// The boot-drain gate: opens once every boot-held component has completed ONE
// reconcile pass (started, backoff-deferred, awaiting-controller, or failed
// loudly) - NOT "all containers running". The first apprunning broadcast waits
// on it so the snapshot doesn't race the boot starts (rows the snapshot misses
// expire on the ~7min sigterm TTL and the app respawns elsewhere). Capped so a
// wedged reconcile can never suppress the node's network presence.
const BOOT_DRAIN_SETTLE_CAP_MS = 2 * 60 * 1000;
const bootDrainGate = new AsyncGate();
const bootDraining = new Set(); // boot-held ids still on their first pass
let bootDrainCapTimer = null;

// Injected by the engine (appReconciler) at module load.
let reconcileFn = null; // (identifier) => Promise<void>
let onSettledFn = null; // (identifier, { retryArmed }) => void — converge resolution

/**
 * The engine registers its reconcile function here so enqueue can drive it without
 * the queue ever importing the engine (one-way: engine -> queue).
 */
function setReconcile(fn) {
  reconcileFn = fn;
}

/**
 * The engine registers a hook called after each reconcile pass that armed no retry
 * and is not re-running (the final pass for that id) — used to resolve the install
 * converge-wait. Kept in the engine because the verdict reads engine/runtime state.
 */
function setOnSettled(fn) {
  onSettledFn = fn;
}

function settleBootDrain(reason) {
  if (bootDrainGate.ready) return;
  if (bootDrainCapTimer) {
    clearTimeout(bootDrainCapTimer);
    bootDrainCapTimer = null;
  }
  bootDraining.clear();
  bootDrainGate.open();
  log.info(`reconcilerQueue - boot drain settled (${reason})`);
}

/**
 * Arm a paced retry of one component (backoff ladder / managed-defer): re-enqueues
 * after delayMs. Called by the engine from its backoff/defer paths.
 */
function scheduleRetry(identifier, delayMs) {
  if (backoffTimers.has(identifier)) clearTimeout(backoffTimers.get(identifier));
  const timer = setTimeout(() => {
    backoffTimers.delete(identifier);
    enqueue(identifier);
  }, delayMs);
  if (timer.unref) timer.unref();
  backoffTimers.set(identifier, timer);
}

function runReconcile(identifier) {
  reconcileFn(identifier)
    .catch((err) => log.error(`reconcilerQueue - reconcile ${identifier} failed: ${err.message}`))
    .finally(() => {
      inFlight.delete(identifier);
      // one completed pass (actuated or deferred) is all the boot drain needs
      if (bootDraining.delete(identifier) && bootDraining.size === 0) {
        settleBootDrain('all boot reconciles completed a pass');
      }
      if (dirty.has(identifier)) {
        dirty.delete(identifier);
        setImmediate(() => enqueue(identifier));
        return;
      }
      // Final pass for this id (no retry armed): hand to the engine so it can
      // resolve a converging component to a settled verdict.
      if (onSettledFn) onSettledFn(identifier, { retryArmed: backoffTimers.has(identifier) });
    });
}

/**
 * Schedule a reconcile of one component. Coalesces: if a reconcile for the same
 * identifier is in flight, it re-runs once when that finishes. Held until the boot
 * gate opens so nothing actuates before daemon/DB are ready.
 */
function enqueue(rawIdentifier) {
  const identifier = canonical(rawIdentifier);
  if (!globalState.bootContainerStateSettled) {
    bootPending.add(identifier);
    return;
  }
  if (inFlight.has(identifier)) {
    dirty.add(identifier);
    return;
  }
  inFlight.add(identifier);
  runReconcile(identifier);
}

/**
 * Drain everything enqueued during boot, now that daemon/DB are ready. The engine
 * calls this after its boot warm-up. Tracks the boot-held ids so the boot-drain gate
 * opens once each has completed one pass, capped so a wedge can't suppress presence.
 */
function beginBootDrain() {
  const pending = [...bootPending];
  bootPending.clear();
  if (pending.length === 0) {
    settleBootDrain('nothing to drain');
    return;
  }
  pending.forEach((id) => bootDraining.add(id));
  bootDrainCapTimer = setTimeout(() => {
    log.warn(`reconcilerQueue - boot drain cap reached with ${bootDraining.size} reconcile(s) still in flight: ${[...bootDraining].join(', ')}`);
    settleBootDrain('cap reached');
  }, BOOT_DRAIN_SETTLE_CAP_MS);
  if (bootDrainCapTimer.unref) bootDrainCapTimer.unref();
  pending.forEach((id) => enqueue(id));
}

/**
 * Clear all queue state + timers (engine stop()). The converge waiters live in the
 * engine and are resolved there.
 */
function stopQueue() {
  backoffTimers.forEach((t) => clearTimeout(t));
  backoffTimers.clear();
  if (bootDrainCapTimer) {
    clearTimeout(bootDrainCapTimer);
    bootDrainCapTimer = null;
  }
  bootDraining.clear();
  inFlight.clear();
  dirty.clear();
  bootPending.clear();
}

module.exports = {
  canonical,
  enqueue,
  scheduleRetry,
  beginBootDrain,
  stopQueue,
  setReconcile,
  setOnSettled,
  waitForBootDrainSettled: () => bootDrainGate.wait(),
};
