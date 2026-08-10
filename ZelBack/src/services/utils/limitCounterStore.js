'use strict';

const config = require('config');
const crypto = require('crypto');
const log = require('../../lib/log');

// The tally a counter node holds for the keys it is responsible for.
//
// Reservations, not counts. A caller asking "may I" and then being told a number
// is two steps, and two simultaneous askers both read the same number before
// either acts. Here the ask AND the increment are one synchronous call, so the
// second asker sees the first's reservation. Node's single thread is what makes
// that atomic - there is no lock because there is no interleaving to protect
// against.
//
// The limits come from THIS node's config, never from the asking node. A caller's
// own node proposing the limit it should be held to is not a limit.
//
// Reservations live in memory and are lost if the process restarts. That is
// deliberate rather than overlooked: they are short-lived by construction (a
// lease outlives the work it covers and no more), so a restart costs at most one
// lease-length of over-admission. The durable half - what a caller has used over
// a day - is the gossiped record, which a counter reads back after a restart.

const DEFAULTS = Object.freeze({ maxConcurrent: 1, maxPerWindow: 5, windowMs: 24 * 60 * 60 * 1000 });

// A lease must outlive the work it covers, or it expires under a running session
// and a second one is admitted beside it. It must also be finite, or a submitter
// that dies after reserving locks its caller out until the process restarts. The
// released-on-completion path is the normal one; this is only the backstop.
const LEASE_MS = config.fluxapps.limitCounterLeaseMs ?? 30 * 60 * 1000;

// The caller is a HASH by the time it reaches here - a tally has to recognise the
// same caller twice and never has to know who they are, so the identity does not
// travel between nodes and is not held on this one either.
// key -> { purpose, leases: Map<token, expiresNs>, window: {index, used} }
const tallies = new Map();

function limitsFor(purpose) {
  const configured = (config.fluxapps.limitCounters ?? {})[purpose] ?? {};
  return { ...DEFAULTS, ...configured };
}

/**
 * Which window a moment falls in.
 *
 * Wall clock, deliberately. A window is a coordinate shared with the gossiped
 * record and with every other node that might later hold this tally, and a
 * monotonic reading measures elapsed time on one machine so by construction
 * cannot agree with another's. Lease expiry below is the opposite case and uses
 * the monotonic clock.
 */
function windowIndex(windowMs, nowMs = Date.now()) {
  return Math.floor(nowMs / windowMs);
}

function pruneLeases(tally) {
  const now = process.hrtime.bigint();
  for (const [token, expiresNs] of tally.leases) {
    if (now >= expiresNs) tally.leases.delete(token);
  }
}

function tallyFor(purpose, key, limits) {
  let tally = tallies.get(key);
  if (!tally) {
    tally = { purpose, leases: new Map(), window: { index: windowIndex(limits.windowMs), used: 0 } };
    tallies.set(key, tally);
  }
  pruneLeases(tally);

  const current = windowIndex(limits.windowMs);
  if (tally.window.index !== current) {
    tally.window = { index: current, used: 0 };
  }
  return tally;
}

/**
 * Take a slot for one limit key, or refuse.
 *
 * The whole decision is one synchronous pass: read, test, and record before
 * returning. A version that answered "you have N left" and let the caller act on
 * it would admit two callers who both read the same N.
 *
 * @param {string} purpose what is being limited — decides the numbers applied
 * @param {string} key the hashed caller, from limitCounter.keyHash
 * @returns {{allowed: boolean, token: string|null, reason: string|null, concurrent: number, used: number}}
 */
function reserve(purpose, key) {
  const limits = limitsFor(purpose);
  const tally = tallyFor(purpose, key, limits);

  if (tally.leases.size >= limits.maxConcurrent) {
    return {
      allowed: false, token: null, reason: 'concurrent', concurrent: tally.leases.size, used: tally.window.used,
    };
  }
  if (tally.window.used >= limits.maxPerWindow) {
    return {
      allowed: false, token: null, reason: 'window', concurrent: tally.leases.size, used: tally.window.used,
    };
  }

  const token = crypto.randomBytes(16).toString('hex');
  tally.leases.set(token, process.hrtime.bigint() + BigInt(LEASE_MS) * 1_000_000n);
  tally.window.used += 1;

  return {
    allowed: true, token, reason: null, concurrent: tally.leases.size, used: tally.window.used,
  };
}

/**
 * Give a slot back when the work it covered has finished.
 *
 * Only the concurrency slot returns. The window count does NOT decrease - a
 * session that ran and ended still happened, and a window that un-counted
 * completed work would let a caller cycle through it indefinitely.
 *
 * @returns {boolean} whether a lease was actually held
 */
function release(purpose, key, token) {
  const tally = tallies.get(key);
  if (!tally || !token) return false;
  return tally.leases.delete(token);
}

/**
 * Adopt a window count this node did not observe - what a counter does after a
 * restart, or when a key moves to it because the previous counter left the
 * network. Takes the higher of the two: a tally arriving from the record can only
 * ever mean MORE has been used than this node knows about.
 */
function adoptWindowUsage(purpose, key, used) {
  const limits = limitsFor(purpose);
  const tally = tallyFor(purpose, key, limits);
  if (used > tally.window.used) tally.window.used = used;
  return tally.window.used;
}

/** Drop keys holding nothing, so an idle node does not grow a map forever. */
function sweep() {
  let dropped = 0;
  for (const [key, tally] of tallies) {
    pruneLeases(tally);
    const stale = tally.window.index !== windowIndex(limitsFor(tally.purpose).windowMs);
    if (tally.leases.size === 0 && (stale || tally.window.used === 0)) {
      tallies.delete(key);
      dropped += 1;
    }
  }
  if (dropped) log.debug(`limitCounterStore - swept ${dropped} idle key(s)`);
  return dropped;
}

/** Test seam: drop every tally. */
function reset() {
  tallies.clear();
}

module.exports = {
  reserve,
  release,
  adoptWindowUsage,
  sweep,
  reset,
  limitsFor,
  LEASE_MS,
};
