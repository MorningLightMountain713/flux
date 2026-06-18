const log = require('../../lib/log');

// In-memory per-app + per-component operation lease registry. The structural
// replacement for the global app-operation booleans (installationInProgress et
// al.), the backup/restore name arrays, and the stoppingContainers Set: one
// keyed, owner/TTL-bearing structure that records WHICH app/component is
// mid-operation instead of a node-wide "something is happening" bit.
//
// Two lease scopes, one uniform shape:
//   app-scoped (key = app name)            : install | remove | softRedeploy |
//                                            hardRedeploy | reconcile | backup | restore
//   component-scoped (key = component id)  : stopping  (the reconciler's own
//                                            stop/restart-in-flight marker, was stoppingContainers)
//
// In-memory + TTL only, NEVER DB-durable: an in-flight lease is transient intent;
// a crash between acquire and completion must not persist as "installing" (after a
// crash no operation is in progress — the boot drain re-derives truth). The TTL is
// the anti-wedge watchdog so a leaked lease can never permanently freeze an app's
// actuation. operatorStopped (durable user intent) is a separate axis and does NOT
// live here.

// Generous per-type max-hold. Operations release in finally, so the TTL is not
// load-bearing for correctness — it logs loudly and force-releases a leaked lease
// as a last resort.
const TTL_MS = {
  install: 30 * 60 * 1000,
  remove: 30 * 60 * 1000,
  softRedeploy: 30 * 60 * 1000,
  hardRedeploy: 30 * 60 * 1000,
  reconcile: 30 * 60 * 1000,
  backup: 60 * 60 * 1000,
  restore: 60 * 60 * 1000,
  stopping: 5 * 60 * 1000,
};
const DEFAULT_TTL_MS = 30 * 60 * 1000;

// key -> { type, owner, reason, sinceMs, ttlMs, timer }
const leases = new Map();

/**
 * Acquire an operation lease on a key (an app name for app-scoped operations, a
 * component identifier for the reconciler's stop/restart marker). Per-key mutual
 * exclusion: fails if a DIFFERENT operation already holds the key — the honest
 * version of the old cross-type REJECT ("cannot remove X while X is installing,"
 * not "while AN install runs"). Idempotent for the same owner+type (refreshes).
 *
 * @param {string} key
 * @param {string} type
 * @param {string} owner - acquiring call-site, for diagnostics
 * @param {string|null} [reason]
 * @param {number|null} [ttlMs] - override the per-type TTL
 * @returns {boolean} true if acquired (or already held by the same owner+type)
 */
function acquire(key, type, owner, reason = null, ttlMs = null) {
  const existing = leases.get(key);
  if (existing) {
    if (existing.type === type && existing.owner === owner) {
      existing.reason = reason;
      existing.sinceMs = Date.now();
      return true;
    }
    return false;
  }
  const ttl = ttlMs ?? TTL_MS[type] ?? DEFAULT_TTL_MS;
  const timer = setTimeout(() => {
    leases.delete(key);
    log.warn(`operationRegistry - lease '${key}' (${type}, owner=${owner}) exceeded ${Math.round(ttl / 1000)}s TTL; force-released (leak)`);
  }, ttl);
  if (timer.unref) timer.unref();
  leases.set(key, {
    type, owner, reason, sinceMs: Date.now(), ttlMs: ttl, timer,
  });
  return true;
}

/**
 * Release a key's lease. Idempotent. (Stage 4 will also enqueue the app's
 * components on the reconciler from here; for now it only drops the lease.)
 *
 * @param {string} key
 * @returns {boolean} whether a lease was released
 */
function release(key) {
  const lease = leases.get(key);
  if (!lease) return false;
  if (lease.timer) clearTimeout(lease.timer);
  leases.delete(key);
  return true;
}

/**
 * Whether any operation currently holds this key.
 * @param {string} key
 * @returns {boolean}
 */
function isHeld(key) {
  return leases.has(key);
}

/**
 * A snapshot of the lease on a key (without the internal timer), or null.
 * @param {string} key
 * @returns {object|null}
 */
function get(key) {
  const lease = leases.get(key);
  if (!lease) return null;
  return {
    key, type: lease.type, owner: lease.owner, reason: lease.reason, heldForMs: Date.now() - lease.sinceMs,
  };
}

/**
 * Every current lease (observability / an API endpoint can surface this).
 * @returns {object[]}
 */
function list() {
  return [...leases.entries()].map(([key, lease]) => ({
    key, type: lease.type, owner: lease.owner, reason: lease.reason, heldForMs: Date.now() - lease.sinceMs,
  }));
}

/**
 * Whether ANY lease is currently held — the node-wide "is anything in flight"
 * signal for the few genuinely node-wide consumers (the daemon-health mass-wipe,
 * the orphan sweep, the activeStandby coordinator). Counts EVERY lease, including
 * transient component 'stopping' markers: a node-wide destructive action must
 * never run while anything is mid-operation.
 * @returns {boolean}
 */
function anyHeld() {
  return leases.size > 0;
}

/**
 * The keys of every lease of a given type (e.g. every app currently in 'backup').
 * Lets a consumer recover a set it used to read off a flag array (which apps are
 * in backup/restore) without re-scanning globalState.
 * @param {string} type
 * @returns {string[]}
 */
function listByType(type) {
  return [...leases.entries()].filter(([, lease]) => lease.type === type).map(([key]) => key);
}

/**
 * Drop all leases and their timers. An in-memory registry never survives a crash,
 * so this is for the boot reset and tests, not normal operation.
 */
function clear() {
  leases.forEach((lease) => { if (lease.timer) clearTimeout(lease.timer); });
  leases.clear();
}

module.exports = {
  acquire, release, isHeld, get, list, anyHeld, listByType, clear, TTL_MS,
};
