const log = require('../../lib/log');

// A slot held longer than this is a bug, not a slow dependency: the longest
// lawful hold in this codebase is a single registry request, itself capped at
// 20s by the verifier's axios timeout. Force-releasing keeps the node working
// while the leak is fixed; the error log is how the leak gets found.
const DEFAULT_MAX_HOLD_MS = 60_000;

/**
 * A counting semaphore. `acquire` resolves when a slot is free and hands back
 * the function that releases THAT slot.
 *
 * The release is bound to its own acquisition and is idempotent, which is what
 * makes the lock safe above maxConcurrent=1: a release can only ever return the
 * slot its caller holds, so calling it twice cannot hand back someone else's,
 * and forgetting to call it cannot shrink capacity for the life of the process.
 * Both of those are silent — the semaphore keeps reporting a limit it has
 * stopped enforcing — which is why the guarantee lives here rather than in
 * caller discipline.
 */
class AsyncLock {
  #maxConcurrent;

  #maxHoldMs;

  // Every acquisition in arrival order, holding and waiting alike. Waiters are
  // served strictly FIFO, and `waitReady` drains the whole array, so a caller
  // waiting for quiet also waits for work that is queued but not yet started.
  #records = [];

  #held = 0;

  /**
   * @param {number} [maxConcurrent] slots; 1 is a mutex
   * @param {{maxHoldMs?: number}} [options] 0 disables the max-hold watchdog
   */
  constructor(maxConcurrent = 1, options = {}) {
    this.#maxConcurrent = maxConcurrent;
    this.#maxHoldMs = options.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
  }

  get locked() {
    return this.#held > 0;
  }

  /** Acquisitions that are queued but have not been given a slot yet. */
  get waiterCount() {
    return this.#records.length - this.#held;
  }

  /**
   * Take a slot, waiting if all are busy.
   *
   * @param {object} [options]
   * @param {number|null} [options.timeoutMs] give up after this long instead of
   *   waiting indefinitely. The default (wait forever) suits background work,
   *   which has nowhere better to be; a caller holding an HTTP request open
   *   should pass one, or a busy provider becomes a hung request. The rejection
   *   carries `code: 'LOCK_TIMEOUT'` — it means the node was busy, never that
   *   the operation was invalid, so consumers must class it retryable.
   * @param {string} [options.label] named in the watchdog's log line
   * @returns {Promise<() => void>} releases this acquisition; safe to call twice
   */
  async acquire(options = {}) {
    const { timeoutMs = null, label = null } = options;

    const record = {
      state: 'waiting', label, released: false, watchdog: null,
    };
    record.done = new Promise((resolve) => { record.resolveDone = resolve; });
    record.granted = new Promise((resolve, reject) => {
      record.resolveGranted = resolve;
      record.rejectGranted = reject;
    });

    this.#records.push(record);

    if (this.#held < this.#maxConcurrent) {
      this.#start(record);
    } else if (timeoutMs === null) {
      await record.granted;
    } else {
      // The timer settles the same promise the grant does, so exactly one wins
      // and there is no window where a slot is handed out to a caller that has
      // already given up.
      const timer = setTimeout(() => {
        if (record.state !== 'waiting') return;
        this.#abandon(record);
        const error = new Error(`Timed out after ${timeoutMs}ms waiting for a lock slot`);
        error.code = 'LOCK_TIMEOUT';
        record.rejectGranted(error);
      }, timeoutMs);
      if (timer.unref) timer.unref();

      try {
        await record.granted;
      } finally {
        clearTimeout(timer);
      }
    }

    return () => this.#release(record);
  }

  /**
   * Resolve once nothing is outstanding. With `waitAll` (the default) work that
   * arrives while waiting is waited for too; without it, only the acquisitions
   * outstanding at the moment of the call.
   * @param {{waitAll?: boolean}} [options]
   */
  async waitReady(options = {}) {
    const waitAll = options.waitAll ?? true;

    while (this.#records.length) {
      const outstanding = this.#records.map((record) => record.done);
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(outstanding);

      if (!waitAll) break;
    }
  }

  #start(record) {
    record.state = 'held';
    this.#held += 1;

    if (this.#maxHoldMs > 0) {
      record.watchdog = setTimeout(() => this.#forceRelease(record), this.#maxHoldMs);
      // Never keep the process alive for a watchdog.
      if (record.watchdog.unref) record.watchdog.unref();
    }

    record.resolveGranted();
  }

  #release(record) {
    if (record.released) return;
    record.released = true;

    if (record.watchdog) clearTimeout(record.watchdog);

    const index = this.#records.indexOf(record);
    if (index !== -1) this.#records.splice(index, 1);
    if (record.state === 'held') this.#held -= 1;
    record.state = 'released';

    record.resolveDone();
    this.#startNext();
  }

  /** A waiter that gave up: it never held a slot, so only the queue changes. */
  #abandon(record) {
    if (record.released) return;
    record.released = true;

    const index = this.#records.indexOf(record);
    if (index !== -1) this.#records.splice(index, 1);
    record.state = 'abandoned';

    record.resolveDone();
  }

  /**
   * The holder never released. Take the slot back so the node keeps working,
   * and say so loudly — the force-release is a stopgap for a caller that must
   * be fixed, not a substitute for releasing.
   */
  #forceRelease(record) {
    // The timer firing IS the elapsed measurement, so no clock is read here or
    // on acquisition. That keeps the hot path free of a syscall per slot, and
    // the number worth reporting is the limit that was breached anyway.
    log.error(
      `AsyncLock: force-releasing a slot held over ${this.#maxHoldMs}ms by `
      + `${record.label ?? 'an unlabelled caller'}. `
      + 'The holder never released it - this is a leak and the caller needs fixing.',
    );
    this.#release(record);
  }

  #startNext() {
    while (this.#held < this.#maxConcurrent) {
      const next = this.#records.find((record) => record.state === 'waiting');
      if (!next) return;
      this.#start(next);
    }
  }
}

module.exports = { AsyncLock };
