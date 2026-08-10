'use strict';

const log = require('../../lib/log');
const globalState = require('../utils/globalState');
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
// Dependencies are deliberately low-level only (log, globalState, asyncGate) — nothing
// in the app lifecycle/query layer.

// The queue's key is the bare component identifier (`component_app`, or the app name
// for v1-3), and every producer must pass that form. This layer deliberately does NOT
// normalise: a producer holding a docker name knows it holds one, and this queue
// cannot know — `fluxproxy_myapp` is both a valid docker name (component `proxy`) and
// a valid bare identifier (component `fluxproxy`), so stripping here was a guess that
// silently keyed a different component. Producers holding a docker name read the
// identity label; producers in the syncthing flow carry the identifier alongside the
// folder id.

const inFlight = new Set(); // ids currently reconciling (per-key single-flight)
const dirty = new Set(); // ids re-requested while in flight -> reconcile again
const bootPending = new Set(); // ids enqueued before the boot gate opened
const backoffTimers = new Map(); // id -> scheduled retry timeout
// ids whose armed timer is a surveillance glance (post-start attachment verify),
// not outstanding work: it must not hold a converge open (see scheduleRetry)
const nonSettleHolding = new Set();

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
 *
 * holdsSettle (default true): whether the armed timer counts as outstanding work
 * for the settle verdict. A retry that defers real work (backoff, managed hold,
 * heal pacing) must hold a converging component open. A surveillance glance — the
 * post-start attachment verify, which re-checks a container that is already
 * running and settled — must NOT: it would add its whole delay to every install/
 * redeploy convergence, and "settled" never promised more than the level-based
 * reconciler's standing watch. One timer per id: a later real retry replaces a
 * glance (and its classification), and vice versa.
 */
function scheduleRetry(identifier, delayMs, { holdsSettle = true } = {}) {
  if (backoffTimers.has(identifier)) clearTimeout(backoffTimers.get(identifier));
  if (holdsSettle) nonSettleHolding.delete(identifier);
  else nonSettleHolding.add(identifier);
  const timer = setTimeout(() => {
    backoffTimers.delete(identifier);
    nonSettleHolding.delete(identifier);
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
      // Final pass for this id (no work-holding retry armed): hand to the engine so
      // it can resolve a converging component to a settled verdict. An armed
      // surveillance glance does not block the verdict.
      if (onSettledFn) {
        const retryArmed = backoffTimers.has(identifier) && !nonSettleHolding.has(identifier);
        onSettledFn(identifier, { retryArmed });
      }
    });
}

/**
 * Schedule a reconcile of one component. Coalesces: if a reconcile for the same
 * identifier is in flight, it re-runs once when that finishes. Held until the boot
 * gate opens so nothing actuates before daemon/DB are ready.
 */
function enqueue(identifier) {
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
  nonSettleHolding.clear();
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
  enqueue,
  scheduleRetry,
  beginBootDrain,
  stopQueue,
  setReconcile,
  setOnSettled,
  waitForBootDrainSettled: () => bootDrainGate.wait(),
};
