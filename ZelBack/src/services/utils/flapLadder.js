'use strict';

// The mild flap-quarantine tier: each juror's private count of the
// drop-and-return cycles it sees on the duty connections it holds. Nothing
// here is stored, gossiped or read by anyone else — the count is one node's
// uncorroborated opinion, and a subject must never be able to learn it is
// damped. Its only effect is dial ORDER: a damped duty is dialed lazily
// while the outbound floor is covered, and at worst once per window
// regardless, so a fixed node's coverage refills through its clean-out
// window instead of being pinned at zero.
//
// No timer anywhere: every observation is stamped with the chain height it
// was made at, and lifts, resets and the floor-dial are all read off those
// stamps when the plan is asked for.

// Trip on this many cycles inside the window. Measured on cindy (f300,
// 2026-08-20): a legitimate restart registers one or two cycles per
// observer, a bad machine four; four rather than three keeps a release wave
// — watchdog restart, kernel reboot, retry — on the near side of the line.
const FLAP_TRIP = 4;

// The window, in blocks: cycles are counted inside it, and a damped duty
// is dialed at least once per window.
const FLAP_WINDOW_BLOCKS = 90;

// Clean blocks required to lift damping, by re-offence: doubling to a cap
// under the 640-block list expiry. A still-flapping node never accumulates
// its clean period; a fixed one is fully restored within four hours even
// from the deepest rung.
const CLEAN_LADDER_BLOCKS = Object.freeze([30, 60, 120, 240, 480]);

// Clean blocks after which the rung memory is forgotten: the ladder starts
// from the bottom.
const FULL_RESET_BLOCKS = 640;

// A release drops and returns every node at once. When at least this many
// of my duties — and at least half of the duties I hold — drop inside the
// span, the drop is a release from my side of the wire, not a bad machine,
// and it counts for nothing. Proportional, so a node holding many duties is
// not fooled by a handful of unrelated deaths landing close together, and a
// node holding few still recognises its own side going. A watchdog-staggered
// rollout is not caught here — that is what the trip threshold absorbs.
const MASS_DROP_DUTIES = 3;
const MASS_DROP_SPAN_BLOCKS = 2;

const DIAL_PLAN = Object.freeze({
  // Not damped: dialed on every pass, as any duty.
  EAGER: 'eager',
  // Damped and contacted inside the window: dialed only while the floor is
  // covered without it.
  LAZY: 'lazy',
  // Damped and a window since the last contact: dialed now, floor or not.
  DUE: 'due',
});

class FlapLadder {
  /** @type {() => number|null} */
  #currentHeight;

  /** outpoint → {cycles, openDrop, rung, damped, lastCycle, lastContact} */
  #duties = new Map();

  /** Every drop seen lately, across duties, for the release exclusion, each
   *  with how many duties were held when it was seen. */
  #drops = [];

  /**
   * @param {object} deps
   * @param {() => number|null} deps.currentHeight the chain height, or null
   *   before the chain is known — an observation without a height is not one
   */
  constructor({ currentHeight }) {
    this.#currentHeight = currentHeight;
  }

  #entryFor(outpoint) {
    let entry = this.#duties.get(outpoint);
    if (!entry) {
      entry = {
        cycles: [], openDrop: null, rung: 0, damped: false, lastCycle: null, lastContact: null,
      };
      this.#duties.set(outpoint, entry);
    }
    return entry;
  }

  static #requiredClean(rung) {
    return rung === 0 ? null : CLEAN_LADDER_BLOCKS[Math.min(rung, CLEAN_LADDER_BLOCKS.length) - 1];
  }

  /** Lifts and the full reset, read off the last cycle's height. */
  static #settle(entry, height) {
    if (entry.lastCycle === null) return;
    const clean = height - entry.lastCycle;
    if (entry.damped && clean >= FlapLadder.#requiredClean(entry.rung)) entry.damped = false;
    if (!entry.damped && clean >= FULL_RESET_BLOCKS) entry.rung = 0;
    entry.cycles = entry.cycles.filter((at) => at > height - FLAP_WINDOW_BLOCKS);
  }

  /**
   * An unexpected loss of the duty's connection.
   * @param {string} outpoint
   * @param {number} dutiesHeld how many duties this juror holds now — the
   *   denominator of the release exclusion
   */
  noteDrop(outpoint, dutiesHeld = 0) {
    const height = this.#currentHeight();
    if (height === null) return;
    this.#entryFor(outpoint).openDrop = height;
    this.#drops = this.#drops.filter((drop) => drop.height > height - FLAP_WINDOW_BLOCKS);
    this.#drops.push({ outpoint, height, dutiesHeld });
  }

  /** The duty is held again: the open drop closes into one cycle. */
  noteReturn(outpoint) {
    const height = this.#currentHeight();
    if (height === null) return;
    const entry = this.#entryFor(outpoint);
    entry.lastContact = height;
    const droppedAt = entry.openDrop;
    if (droppedAt === null) return;
    entry.openDrop = null;

    const inSpan = this.#drops.filter((drop) => Math.abs(drop.height - droppedAt) <= MASS_DROP_SPAN_BLOCKS);
    const dropping = new Set(inSpan.map((drop) => drop.outpoint));
    const held = Math.max(...inSpan.map((drop) => drop.dutiesHeld), 0);
    if (dropping.size >= MASS_DROP_DUTIES && dropping.size * 2 >= held) return;

    FlapLadder.#settle(entry, height);
    entry.cycles.push(height);
    entry.lastCycle = height;
    if (!entry.damped && entry.cycles.length >= FLAP_TRIP) {
      entry.damped = true;
      entry.rung = Math.min(entry.rung + 1, CLEAN_LADDER_BLOCKS.length);
    }
  }

  /** The duty was dialed, or is held, now. */
  noteContact(outpoint) {
    const height = this.#currentHeight();
    if (height === null) return;
    this.#entryFor(outpoint).lastContact = height;
  }

  /**
   * How the reconciler should treat the duty's dial this pass.
   * @param {string} outpoint
   * @returns {string} a DIAL_PLAN
   */
  dialPlan(outpoint) {
    const entry = this.#duties.get(outpoint);
    const height = this.#currentHeight();
    if (!entry || height === null) return DIAL_PLAN.EAGER;
    FlapLadder.#settle(entry, height);
    if (!entry.damped) return DIAL_PLAN.EAGER;
    if (entry.lastContact === null || height - entry.lastContact >= FLAP_WINDOW_BLOCKS) {
      return DIAL_PLAN.DUE;
    }
    return DIAL_PLAN.LAZY;
  }

  /** The duty is no longer owed. */
  forget(outpoint) {
    this.#duties.delete(outpoint);
  }

  /**
   * Keep the memory of these duties only; the list has moved the rest away.
   * @param {Set<string>} outpoints the duties still owed
   */
  retain(outpoints) {
    [...this.#duties.keys()].forEach((outpoint) => {
      if (!outpoints.has(outpoint)) this.#duties.delete(outpoint);
    });
  }

  /** Observability. */
  snapshot(outpoint) {
    const entry = this.#duties.get(outpoint);
    const height = this.#currentHeight();
    if (!entry) {
      return {
        cycles: 0, rung: 0, damped: false, lastContact: null, requiredClean: null,
      };
    }
    if (height !== null) FlapLadder.#settle(entry, height);
    return {
      cycles: entry.cycles.length,
      rung: entry.rung,
      damped: entry.damped,
      lastContact: entry.lastContact,
      requiredClean: FlapLadder.#requiredClean(entry.rung),
    };
  }
}

module.exports = {
  FlapLadder,
  DIAL_PLAN,
  FLAP_TRIP,
  FLAP_WINDOW_BLOCKS,
  CLEAN_LADDER_BLOCKS,
  FULL_RESET_BLOCKS,
  MASS_DROP_DUTIES,
  MASS_DROP_SPAN_BLOCKS,
};
