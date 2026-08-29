'use strict';

const { OUTBOUND_FLOOR, M_OWNERS } = require('./peerRings');

const log = require('../../lib/log');

// The rings maintenance loop: reconcile, do not discover.
// duties(me) is a pure function of the committed list, so there is nothing to
// search for — compare the set that should be held against the set that is,
// and repair the difference. Event-driven: a dropped connection or a list
// change schedules a pass; the periodic sweep is a backstop for a missed
// event, never the mechanism.
//
// Floor accounting: a duty counts
// toward the outbound floor while PENDING (dial in flight) or CONNECTED
// outbound; only a dial that RESOLVED with an error discounts it. No timer
// anywhere — the dial's own resolution is the event. A duty held as inbound
// (the far end won the race) costs no dial and clears no gate. Top-ups are
// ring successors, non-witness by construction, opened below the floor and
// released hysteretically — never the instant the count recovers.

const RELEASE_MARGIN = 2;

const DUTY_STATE = Object.freeze({
  PENDING: 'pending',
  CONNECTED: 'connected',
  FAILED: 'failed',
  // The network certified this duty down: not dialed, counts for nothing,
  // a substitute covers the slot until the subject returns.
  STOOD_DOWN: 'stood_down',
});

class RingReconciler {
  /** @type {object} */
  #deps;

  /** @type {Map<string, {state: string, socketAddress: string}>} outpoint → duty state */
  #duties = new Map();

  /** @type {Map<string, {state: string, socketAddress: string}>} outpoint → top-up state */
  #topups = new Map();

  #passRunning = false;

  #passQueued = false;

  #sweepTimer = null;

  #started = false;

  #floor;

  #releaseMargin;

  #askThreshold;

  /**
   * @param {object} deps every side effect, injected
   * @param {() => object|null} deps.topology the NodeDownTopology, or null before start
   * @param {() => string|null} deps.myOutpoint this node's collateral outpoint
   * @param {(outpoint: string) => string|null} deps.resolveOutpoint outpoint → dialable ip:port
   * @param {(socketAddress: string) => boolean} deps.isHeld a connection exists, either direction
   * @param {(socketAddress: string) => ('outbound'|'inbound'|null)} deps.heldDirection
   * @param {(socketAddress: string) => boolean} deps.mayDial per-target backoff gate
   * @param {(socketAddress: string, opts: {witness: boolean}) => Promise<boolean>} deps.dial
   *   resolves true on an established connection, false on a resolved failure
   * @param {(socketAddress: string, reason: string) => void} deps.drop close a held connection
   * @param {(socketAddress: string) => void} deps.ask request an inbound dial-back
   * @param {() => number} deps.inboundCount
   * @param {object} [options]
   * @param {number} [options.floor] outbound connection floor
   * @param {number} [options.releaseMargin] hysteresis above the floor
   * @param {number} [options.askThreshold] inbound below which the jury is asked
   * @param {number} [options.sweepIntervalMs] backstop sweep cadence
   */
  constructor(deps, options = {}) {
    this.#deps = deps;
    this.#floor = options.floor ?? OUTBOUND_FLOOR;
    this.#releaseMargin = options.releaseMargin ?? RELEASE_MARGIN;
    this.#askThreshold = options.askThreshold ?? M_OWNERS - 4;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 120_000;
  }

  /** Runs the first pass immediately: a starting node's whole set is missing
   *  at once, and the ask must fire on start, not on a timer. */
  start() {
    if (this.#started) return;
    this.#started = true;
    this.#sweepTimer = setInterval(() => this.schedule('sweep'), this.sweepIntervalMs);
    if (this.#sweepTimer.unref) this.#sweepTimer.unref();
    this.schedule('start');
  }

  stop() {
    this.#started = false;
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#sweepTimer = null;
  }

  /**
   * Request a reconcile pass. Coalesces: a pass already running marks a rerun
   * rather than stacking, so event bursts (a fleet restart, a list change)
   * cost one extra pass, not one per event.
   *
   * @param {string} reason for the journal only
   * @returns {Promise<void>}
   */
  async schedule(reason) {
    if (!this.#started) return;
    if (this.#passRunning) {
      this.#passQueued = true;
      return;
    }
    this.#passRunning = true;
    try {
      await this.#pass(reason);
    } catch (error) {
      log.error(`ringReconciler pass failed: ${error.message}`);
    } finally {
      this.#passRunning = false;
      if (this.#passQueued) {
        this.#passQueued = false;
        setImmediate(() => this.schedule('rerun'));
      }
    }
  }

  /** Pending dials and outbound-labelled connections, duties and top-ups
   *  alike. A written-off target (last dial resolved failed) counts for
   *  nothing even while a retry is in flight — only a success reinstates it,
   *  or a corpse's retries hold the shortfall shut. */
  #outboundStanding() {
    let count = 0;
    const tally = (entry) => {
      if (entry.writtenOff) return;
      if (entry.state === DUTY_STATE.PENDING) count += 1;
      else if (
        entry.state === DUTY_STATE.CONNECTED
        && this.#deps.heldDirection(entry.socketAddress) === 'outbound'
      ) count += 1;
    };
    this.#duties.forEach(tally);
    this.#topups.forEach(tally);
    return count;
  }

  #dialTracked(map, outpoint, socketAddress, witness, writtenOff = false) {
    map.set(outpoint, { state: DUTY_STATE.PENDING, socketAddress, writtenOff });
    const settle = (connected) => {
      const entry = map.get(outpoint);
      if (!entry || entry.socketAddress !== socketAddress) return;
      entry.state = connected ? DUTY_STATE.CONNECTED : DUTY_STATE.FAILED;
      // null = indeterminate (a dial was already in flight): retry next
      // pass; only a resolved dial moves the write-off.
      if (connected !== null) entry.writtenOff = !connected;
      if (!connected) this.schedule('dial-failed');
    };
    this.#deps.dial(socketAddress, { witness }).then(settle).catch(() => settle(false));
  }

  async #pass(reason) {
    const topology = this.#deps.topology();
    const myOutpoint = this.#deps.myOutpoint();
    if (!topology || !myOutpoint) return;

    const duties = topology.duties(myOutpoint);
    if (duties === null) return; // not on the list — nothing is owed by or to us

    // --- duties: reconcile against held PEERS, either direction ---
    const current = new Map();
    const standings = await Promise.all(duties.map(async (duty) => ({
      duty,
      stoodDown: this.#deps.stoodDown ? await this.#deps.stoodDown(duty.outpoint) : false,
    })));
    standings.forEach(({ duty, stoodDown }) => {
      const socketAddress = this.#deps.resolveOutpoint(duty.outpoint);
      if (!socketAddress) return;
      const known = this.#duties.get(duty.outpoint);

      if (stoodDown) {
        current.set(duty.outpoint, { state: DUTY_STATE.STOOD_DOWN, socketAddress, writtenOff: true });
        return;
      }
      if (this.#deps.isHeld(socketAddress)) {
        current.set(duty.outpoint, { state: DUTY_STATE.CONNECTED, socketAddress, writtenOff: false });
        return;
      }
      if (known && known.socketAddress === socketAddress && known.state === DUTY_STATE.PENDING) {
        current.set(duty.outpoint, known); // dial in flight — its resolution is the event
        return;
      }
      // Owed to a named node until the list says otherwise: dial whenever the
      // per-target backoff allows. A retry after a resolved failure carries
      // its write-off with it — the floor counts on it again only on success.
      if (this.#deps.mayDial(socketAddress)) {
        this.#dialTracked(
          current,
          duty.outpoint,
          socketAddress,
          true,
          known ? known.writtenOff === true : false,
        );
      } else {
        current.set(duty.outpoint, { state: DUTY_STATE.FAILED, socketAddress, writtenOff: true });
      }
    });
    this.#duties = current;

    // --- top-ups: refresh state, then open or release against the band ---
    this.#topups.forEach((entry, outpoint) => {
      if (entry.state === DUTY_STATE.PENDING) return;
      if (!this.#deps.isHeld(entry.socketAddress)) this.#topups.delete(outpoint);
    });

    const shortfall = this.#floor - this.#outboundStanding();
    if (shortfall > 0) {
      // A duty is never a top-up candidate; the walk looks past failures
      // to successors.
      const exclude = new Set([myOutpoint]);
      this.#duties.forEach((entry, outpoint) => exclude.add(outpoint));
      this.#topups.forEach((entry, outpoint) => exclude.add(outpoint));

      topology.ringSuccessors(myOutpoint, shortfall, exclude).forEach((candidate) => {
        const socketAddress = this.#deps.resolveOutpoint(candidate.outpoint);
        if (!socketAddress || !this.#deps.mayDial(socketAddress)) return;
        this.#dialTracked(this.#topups, candidate.outpoint, socketAddress, false);
      });
    } else {
      // Hysteretic release: a substitute is not torn down the instant
      // the ideal returns — only what stands above floor + margin goes, so a
      // flapping duty costs one idle connection, not two swaps per cycle.
      let excess = this.#outboundStanding() - (this.#floor + this.#releaseMargin);
      for (const [outpoint, entry] of this.#topups) {
        if (excess <= 0) break;
        if (entry.state === DUTY_STATE.CONNECTED) {
          this.#deps.drop(entry.socketAddress, 'topup released above floor');
          this.#topups.delete(outpoint);
          excess -= 1;
        }
      }
    }

    // --- inbound: ask the jury when short, with margin above the DOS fuse ---
    if (this.#deps.inboundCount() < this.#askThreshold) {
      const jury = topology.jury(myOutpoint) || [];
      jury.forEach((juror) => {
        const socketAddress = this.#deps.resolveOutpoint(juror.outpoint);
        if (socketAddress && !this.#deps.isHeld(socketAddress)) {
          this.#deps.ask(socketAddress);
        }
      });
    }

    log.debug(`ringReconciler pass (${reason}): ${this.#duties.size} duties, ${this.#topups.size} topups, outbound standing ${this.#outboundStanding()}`);
  }

  /** Observability: duty and top-up states by outpoint. */
  snapshot() {
    const dump = (map) => Object.fromEntries(
      [...map.entries()].map(([outpoint, entry]) => [outpoint, entry.state]),
    );
    return {
      duties: dump(this.#duties),
      topups: dump(this.#topups),
      outboundStanding: this.#outboundStanding(),
    };
  }
}

module.exports = {
  RingReconciler,
  DUTY_STATE,
};
