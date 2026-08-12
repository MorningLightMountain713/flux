'use strict';

// The monotonic clock, once. Wall clocks step — NTP corrections, leap
// seconds, an operator's hand — and a stepped clock turns every interval
// into a lie in whichever direction hurts. Durations and deadlines between
// two moments on THIS machine belong on the monotonic clock; wall time is
// for facts that must survive a restart or name a shared coordinate, and
// for nothing else.

/**
 * Milliseconds from the process's monotonic clock. Comparable only against
 * other readings of this function in this process — never against wall
 * time, never against another machine's.
 * @returns {number}
 */
function nowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/**
 * A deadline on the monotonic clock.
 */
class Deadline {
  #atMs;

  /**
   * @param {number} inMs how far from now the deadline sits
   * @param {number} [fromMs] reading to count from, injectable for tests
   */
  constructor(inMs, fromMs = nowMs()) {
    this.#atMs = fromMs + inMs;
  }

  /** @param {number} [atMs] @returns {boolean} */
  expired(atMs = nowMs()) {
    return atMs > this.#atMs;
  }

  /** @param {number} [atMs] @returns {number} 0 once expired */
  remainingMs(atMs = nowMs()) {
    return Math.max(0, this.#atMs - atMs);
  }

  /** The raw monotonic instant, for callers doing their own arithmetic. */
  get atMs() {
    return this.#atMs;
  }
}

module.exports = {
  nowMs,
  Deadline,
};
