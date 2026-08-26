'use strict';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The harness's coupled cadences, derived once instead of restated per suite.
//
// Several of the fleet's timings are not independent: shaping the wire raises the
// floor under peer liveness, partitioning lowers the ceiling over it, and expiring
// a confirmation depends on an offset that lives in the node-list fixture. Each of
// those implications used to be carried in a comment beside a hand-picked number,
// which fails in the two ways comments fail. A suite changes one number and leaves
// the others (210 raised its wire to a 8.4s round trip against a 4s liveness
// budget, so every link died two pings in and the suite never reached its first
// test). Or the prose drifts from the config (511 and 701 both describe a ~9s
// budget and both run 6s, and 511 asserts wsMaxMissedPongs "stays at 3" against a
// fleet default of 2, while 1205 partitions on the uncompressed 4s and says
// nothing at all).
//
// So a suite declares the physics it needs and this module computes what follows.
// The derived values are merged UNDER the suite's own configOverrides, so an
// explicit override still wins — but the merged result is validated, so an
// override that breaks a coupling fails at authoring time with both numbers named
// rather than as a dead socket twenty minutes into a gate.

const fixturesDir = process.env.FIXTURES_DIR || join(process.cwd(), '..', 'fixtures');

// A healthy link must survive well more than one round trip before it is called
// dead: the budget is a deadline for a pong that has to cross the shaped wire
// twice, and a loaded box adds scheduling delay on top. Three round trips of slack
// is the floor this enforces, not a target — a suite is free to ask for more.
const LIVENESS_RTT_FACTOR = 3;

// Three consecutive misses, never two: on a loaded box a single slow round trip is
// a far weaker signal than three in a row, and the harness runs six fleets at once.
// 511's comment had this reasoning right even though its arithmetic did not.
const MISSED_PONGS = 3;

// partitionGroups holds until the cross-group sockets are actually gone, and that
// wait IS the liveness budget. 6s keeps it an order of magnitude inside the 60s
// severTimeoutMs the framework allows, which is the inequality that matters.
const PARTITION_PING_MS = 2000;
const PARTITION_SEVER_BUDGET_MS = PARTITION_PING_MS * MISSED_PONGS;

// A node whose confirmation must age out needs the limit brought down near the
// offset the stub was seeded with. One block's worth of time is what the estimate
// path then has to run, so it also has to be a duration a test can wait out.
const OWED_BLOCK_MS = 10000;

// The fixture read is cached; the offset is NOT. Caching the computed offset keys a
// derived answer on nothing — the second caller gets the first caller's height back
// and the guard below becomes unreachable after one call.
let cachedSeededHeight = null;

/**
 * How many blocks back the harness's own node list confirms every node — the number
 * a confirmation-expiry suite is really choosing its limit against. Read from the
 * fixture the runner renders its list from, so it cannot drift from what the fleet
 * is actually told.
 *
 * @param {number} initialHeight The chain height the daemon stub starts at.
 * @returns {number} Blocks between the seeded confirmation and the starting tip.
 */
export function confirmationOffsetBlocks(initialHeight) {
  if (cachedSeededHeight === null) {
    const list = JSON.parse(readFileSync(join(fixturesDir, 'deterministic-list.json'), 'utf-8'));
    const seeded = list[0]?.last_confirmed_height;
    if (!Number.isFinite(seeded)) {
      throw new Error('timing: deterministic-list.json carries no last_confirmed_height to derive the confirmation offset from');
    }
    cachedSeededHeight = seeded;
  }
  const offset = initialHeight - cachedSeededHeight;
  if (offset <= 0) {
    throw new Error(`timing: the fixture confirms nodes ${-offset} blocks AHEAD of the starting tip; a confirmation window cannot be derived`);
  }
  return offset;
}

/**
 * The round trip a netem delay spec produces, jitter included. Egress shaping is
 * applied on both ends, so a one-way spec costs its full value twice.
 *
 * @param {string} spec A netem delay spec, e.g. '4000ms 200ms' (mean, jitter).
 * @returns {number} Worst-case round trip in milliseconds.
 */
export function wireRttMs(spec) {
  const parts = String(spec).trim().split(/\s+/).map((p) => {
    const ms = /^(\d+(?:\.\d+)?)ms$/.exec(p);
    if (!ms) throw new Error(`timing: cannot read a delay from netem spec '${spec}' — expected milliseconds, e.g. '80ms 20ms'`);
    return Number(ms[1]);
  });
  const [mean, jitter = 0] = parts;
  return 2 * (mean + jitter);
}

/**
 * Turn a suite's timing declaration into the config layer it implies.
 *
 * @param {object|null} timing The suite's `timing` declaration.
 * @param {object} ctx
 * @param {number} ctx.initialHeight The daemon stub's starting height.
 * @returns {{ overrides: object, wire: object|null }} Config to merge beneath the
 *   suite's own overrides, and the wire the suite declared (for setLatency).
 */
export function deriveTiming(timing, { initialHeight }) {
  if (!timing) return { overrides: {}, wire: null };

  const { wireLatency = null, partitions = false, confirmation = null } = timing;

  if (wireLatency && partitions) {
    throw new Error(
      'timing: a suite cannot declare both wireLatency and partitions — a shaped wire needs a '
      + 'liveness budget above its round trip, a partition needs one far below the sever timeout, '
      + 'and one budget cannot be both. Shape the wire and drop packets in separate phases.',
    );
  }

  const overrides = {};

  if (wireLatency) {
    const rtt = wireRttMs(wireLatency.delay);
    const needed = LIVENESS_RTT_FACTOR * rtt;
    // Round the interval up to a whole half-second so the number in a log reads as
    // a decision rather than an artefact of the arithmetic.
    const ping = Math.ceil(needed / MISSED_PONGS / 500) * 500;
    overrides.peers = { wsPingIntervalMs: ping, wsMaxMissedPongs: MISSED_PONGS };
  }

  if (partitions) {
    overrides.peers = { wsPingIntervalMs: PARTITION_PING_MS, wsMaxMissedPongs: MISSED_PONGS };
  }

  if (confirmation) {
    const { blocksOwed } = confirmation;
    if (!Number.isInteger(blocksOwed) || blocksOwed < 1) {
      throw new Error(`timing: confirmation.blocksOwed must be a positive integer, got ${blocksOwed}`);
    }
    const offset = confirmationOffsetBlocks(initialHeight);
    overrides.confirmation = {
      confirmExpirationBlocks: offset + blocksOwed,
      blockIntervalMs: OWED_BLOCK_MS,
    };
  }

  return { overrides, wire: wireLatency };
}

/**
 * Check the couplings against the config the fleet will actually run, after the
 * suite's own overrides have been merged on top of the derived layer. Only a
 * declared dimension is policed: a suite that never asked for a wire is not held
 * to a wire's rules, and a declared one always derives its own values, so the
 * merged layer carries every number read here without needing the fleet defaults
 * underneath it. Fleet-wide scope — a per-node override is not examined.
 *
 * @param {object|null} timing The suite's `timing` declaration.
 * @param {object} effective The merged config the nodes will boot with.
 * @param {object} ctx
 * @param {number} ctx.initialHeight The daemon stub's starting height.
 * @returns {void}
 */
export function validateTiming(timing, effective, { initialHeight }) {
  if (!timing) return;

  const peers = effective?.peers ?? {};
  const ping = peers.wsPingIntervalMs;
  const pongs = peers.wsMaxMissedPongs;
  const budget = Number.isFinite(ping) && Number.isFinite(pongs) ? ping * pongs : null;

  if (timing.wireLatency) {
    const rtt = wireRttMs(timing.wireLatency.delay);
    if (budget === null) {
      throw new Error('timing: a declared wire needs peers.wsPingIntervalMs and peers.wsMaxMissedPongs resolvable in the merged config');
    }
    if (budget < LIVENESS_RTT_FACTOR * rtt) {
      throw new Error(
        `timing: peer liveness budget ${budget}ms (${ping} x ${pongs}) is below the ${LIVENESS_RTT_FACTOR}x floor `
        + `over this suite's ${rtt}ms round trip (${LIVENESS_RTT_FACTOR * rtt}ms). Every healthy link would be `
        + 'declared dead while the wire is shaped. Raise peers.wsPingIntervalMs or shorten the delay.',
      );
    }
  }

  if (timing.partitions) {
    if (budget === null) {
      throw new Error('timing: a partitioning suite needs peers.wsPingIntervalMs and peers.wsMaxMissedPongs resolvable in the merged config');
    }
    if (budget > PARTITION_SEVER_BUDGET_MS * 2) {
      throw new Error(
        `timing: peer liveness budget ${budget}ms (${ping} x ${pongs}) is more than twice the ${PARTITION_SEVER_BUDGET_MS}ms `
        + 'this suite partitions against, so partitionGroups would spend the difference waiting for sockets to '
        + 'notice. Lower peers.wsPingIntervalMs or raise severTimeoutMs deliberately.',
      );
    }
  }

  if (timing.confirmation) {
    const offset = confirmationOffsetBlocks(initialHeight);
    const limit = effective?.confirmation?.confirmExpirationBlocks;
    if (!Number.isFinite(limit)) {
      throw new Error('timing: a declared confirmation window needs confirmation.confirmExpirationBlocks resolvable in the merged config');
    }
    if (limit <= offset) {
      throw new Error(
        `timing: confirmExpirationBlocks ${limit} is at or below the ${offset}-block offset the node list is seeded `
        + 'with, so every node boots already expired and nothing in the suite can be attributed to the flow under test.',
      );
    }
  }
}
