'use strict';

const log = require('../../lib/log');
const capabilities = require('../utils/capabilities');
const fluxEventBus = require('../utils/fluxEventBus');

// The reconciler's scheduling seam: a per-key single-flight, boot-gated workqueue.
// Producers (operator commands, mount/network repair, the deciders, the event
// bridge, install) push a component identifier here with enqueueComponent(); the reconcile
// ENGINE (appReconciler) registers its reconcile function via setReconcile and is
// the consumer. Splitting this out keeps the producer-facing surface lightweight —
// a producer that only needs to enqueue does NOT pull the engine's heavy dependency
// tree (uninstaller, volume/query services, …), which is what turned the engine into
// an import hub and made every new producer a cycle risk.
//
// Dependencies are deliberately low-level only (log, globalState, asyncGate) — nothing
// in the app lifecycle/query layer.

// The queue's key is ALWAYS a bare component identifier (`component_identity[_replica]`,
// or the app name for a flat v1-3 app), because a component is the only thing the
// reconciler actuates. A producer holding an app name does not enqueue it here — it calls
// appReconciler.enqueueApp(), which resolves the app's component identifiers and enqueues
// each. Keeping app names out of this keyspace is what stops the two being confused: they
// are not reliably distinguishable as strings once identities are minted rather than
// borrowed from app names.
//
// This layer deliberately does NOT normalise: a producer holding a docker name knows it
// holds one, and this queue cannot know — `fluxproxy_myapp` is both a valid docker name
// (component `proxy`) and a valid bare identifier (component `fluxproxy`), so stripping
// here was a guess that silently keyed a different component. Producers holding a docker
// name read the identity label; producers in the syncthing flow carry the identifier
// alongside the folder id.

// id -> promise of the pass (or intent write) currently holding this key. A Map
// rather than a Set so a caller can WAIT for the holder: applyIntent below needs
// to know when a pass has finished, not merely that one is running.
const inFlight = new Map(); // per-key single-flight
const unhandledFailures = new Map(); // id -> consecutive passes that threw

// A pass that throws is retried a bounded number of times before it is left to
// the hourly sweep; the delay is the same one the engine paces its own retries on.
const MANAGED_RETRY_MS = 5000;
const UNHANDLED_FAILURE_RETRIES = 3;
const dirty = new Set(); // ids re-requested while in flight -> reconcile again
const bootPending = new Set(); // ids enqueued before the boot gate opened
const backoffTimers = new Map(); // id -> scheduled retry timeout
// ids whose armed timer is a surveillance glance (post-start attachment verify),
// not outstanding work: it must not hold a converge open (see scheduleRetry)
const nonSettleHolding = new Set();

// `bootReconcilePassed`: every boot-held component has completed ONE reconcile
// pass (started, backoff-deferred, awaiting-controller, or failed loudly) - NOT
// "all containers running". A pass completes because every docker request it
// makes is bounded (dockerService); a pass that awaits something unbounded
// holds this capability down for as long as that wait lasts.
const bootDraining = new Set(); // boot-held ids still on their first pass

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
  bootDraining.clear();
  capabilities.claim('bootReconcilePassed', 'reconcilerQueue').raise(reason);
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
    enqueueComponent(identifier);
  }, delayMs);
  if (timer.unref) timer.unref();
  backoffTimers.set(identifier, timer);
}

function runReconcile(identifier) {
  const pass = reconcileFn(identifier)
    .then(() => {
      // A pass that got through is the only evidence the fault has cleared.
      unhandledFailures.delete(identifier);
    })
    .catch((err) => {
      const attempt = (unhandledFailures.get(identifier) || 0) + 1;
      unhandledFailures.set(identifier, attempt);
      const retrying = attempt <= UNHANDLED_FAILURE_RETRIES;
      log.error(
        `reconcilerQueue - reconcile ${identifier} failed: ${err.message}`
        + (retrying
          ? `; retrying (${attempt}/${UNHANDLED_FAILURE_RETRIES})`
          : `; ${attempt} consecutive failures, leaving it to the hourly sweep`),
      );
      // Published for every unhandled failure rather than at each throw site: the
      // sites that can throw are the ones nobody thought to guard, so an event
      // added per site would miss exactly the same ones the retry did.
      fluxEventBus.publish('reconciler:actuated', {
        identifier, action: 'reconcileFailed', reason: err.message, attempt, retrying,
      });
      if (retrying) scheduleRetry(identifier, MANAGED_RETRY_MS);
    })
    .finally(() => {
      inFlight.delete(identifier);
      // one completed pass (actuated or deferred) is all the boot drain needs
      if (bootDraining.delete(identifier) && bootDraining.size === 0) {
        settleBootDrain('all boot reconciles completed a pass');
      }
      if (dirty.has(identifier)) {
        dirty.delete(identifier);
        setImmediate(() => enqueueComponent(identifier));
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
  // Registered synchronously: promise callbacks are microtasks, so the finally
  // above cannot run before this line and clear an entry that is not there yet.
  inFlight.set(identifier, pass);
  return pass;
}

/**
 * Schedule a reconcile of one COMPONENT, by its bare container identifier. Coalesces:
 * if a reconcile for the same identifier is in flight, it re-runs once when that
 * finishes. Held until the boot gate opens so nothing actuates before daemon/DB are
 * ready. Callers holding an app name use appReconciler.enqueueApp instead.
 */
function enqueueComponent(identifier) {
  if (!capabilities.isUp('bootReconcileDecided')) {
    bootPending.add(identifier);
    return null;
  }
  if (inFlight.has(identifier)) {
    dirty.add(identifier);
    // The pass already running was started against state older than whatever
    // just changed, so it is NOT the pass a caller wanting actuation should
    // wait on. The re-run this marks dirty is, and it has no promise yet.
    return null;
  }
  return runReconcile(identifier);
}

/**
 * Write an intent for a component under its reconcile single-flight, then enqueue a
 * pass to act on it. The key is held across the write so a pass cannot start against
 * state this is about to replace.
 *
 * @param {string} identifier The bare component identifier, as enqueueComponent() takes it.
 * @param {Function} mutate Writes the intent.
 * @param {{awaitPass?: boolean}} [opts] awaitPass waits for the pass that follows.
 * @returns {Promise<boolean>} whether a pass was scheduled (and, with awaitPass, ran).
 */
async function applyIntent(identifier, mutate, { awaitPass = false } = {}) {

  // A loop, not a single await: releasing the key lets a queued pass start
  // before this continues, and that pass would be reading the state we are
  // about to replace.
  // eslint-disable-next-line no-await-in-loop
  while (inFlight.has(identifier)) await inFlight.get(identifier).catch(() => {});

  let release;
  const held = new Promise((resolve) => { release = resolve; });
  inFlight.set(identifier, held);
  try {
    await mutate();
  } finally {
    inFlight.delete(identifier);
    release();
  }

  const pass = enqueueComponent(identifier);
  if (!awaitPass) return Boolean(pass);
  if (!pass) return false;
  await pass;
  return true;
}

/**
 * Drop a component's consecutive-failure count. The map is keyed by identifier, so a
 * reinstall under the same name would otherwise start part-way up the count and reach
 * the hourly sweep sooner than a first failure should.
 *
 * @param {string} identifier
 */
function forgetFailures(identifier) {
  unhandledFailures.delete(identifier);
}

/**
 * Drain everything enqueued during boot, now that daemon/DB are ready. The engine
 * calls this after its boot warm-up. Tracks the boot-held ids so the boot-drain gate
 * opens once each has completed one pass.
 */
function beginBootDrain() {
  const pending = [...bootPending];
  bootPending.clear();
  if (pending.length === 0) {
    settleBootDrain('nothing to drain');
    return;
  }
  pending.forEach((id) => bootDraining.add(id));
  capabilities.claim('bootReconcilePassed', 'reconcilerQueue').starting(`${pending.length} boot-held component(s) on their first pass`);
  pending.forEach((id) => enqueueComponent(id));
}

/**
 * Clear all queue state + timers (engine stop()). The converge waiters live in the
 * engine and are resolved there.
 */
function stopQueue() {
  backoffTimers.forEach((t) => clearTimeout(t));
  backoffTimers.clear();
  unhandledFailures.clear();
  nonSettleHolding.clear();
  bootDraining.clear();
  inFlight.clear();
  dirty.clear();
  bootPending.clear();
}

module.exports = {
  enqueueComponent,
  applyIntent,
  forgetFailures,
  MANAGED_RETRY_MS,
  scheduleRetry,
  beginBootDrain,
  stopQueue,
  setReconcile,
  setOnSettled,
  // what is still on its first pass, for a reader whose deadline passed
  bootDrainingIds: () => [...bootDraining],
};
