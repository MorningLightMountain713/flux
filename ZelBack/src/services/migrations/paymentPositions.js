'use strict';

const log = require('../../lib/log');
const appRecords = require('../appDatabase/appRecords');
const daemonServiceUtils = require('../daemonService/daemonServiceUtils');
const { appPaymentPositions } = require('../appPaymentPositions');
const chainUtilities = require('../utils/chainUtilities');
const decider = require('../appDecisions/decider');

// Records written per call: no single call carries every record the backfill
// writes.
const BACKFILL_BATCH = 5000;

/**
 * Gives every app payment record without a position in its block the position
 * and the height the daemon's address index holds for its transaction: one call
 * over the payment addresses from the height app payments count from to the
 * chain tip, so a transaction the index does not hold is not on the chain.
 * Such a record is marked `notOnChain`, is no payment, and is not read again. A
 * record above the daemon's tip is left for a later run: the daemon has not
 * reached its block.
 *
 * The height is the chain's, not the one recorded: a record written from a block
 * that later left the chain carries a height its transaction is not at. Position
 * and height are set in one write of the hash's record, which carries its
 * contents with it. A payment moved to another height or found not on the
 * chain has its name decided again. Records are written BACKFILL_BATCH to a
 * call; a run that stops part way leaves the rest without a position, and the
 * next run takes them.
 * @returns {Promise<{positioned: number, heightsCorrected: number, notOnChain: number, aboveTip: number}>}
 */
async function backfillPaymentPositions() {
  const messages = appRecords.messages();
  const missing = await messages.withoutPosition();
  if (missing.length === 0) return { positioned: 0, heightsCorrected: 0, notOnChain: 0, aboveTip: 0 };
  const start = chainUtilities.appPaymentsFrom();
  const tip = await daemonServiceUtils.executeCall('getBlockCount', [], { useCache: false });
  if (tip.status !== 'success' || !Number.isInteger(tip.data)) {
    throw new Error(`getBlockCount failed: ${tip.data?.message ?? tip.data}`);
  }
  const positions = await appPaymentPositions(start, tip.data);
  const placed = [];
  const unmined = [];
  const moved = [];
  let aboveTip = 0;
  for (const { hash, txid, height } of missing) {
    const position = positions.get(txid);
    if (!position && height > tip.data) {
      aboveTip += 1;
    } else if (position) {
      if (position.height !== height) moved.push(hash);
      placed.push({ hash, txIndex: position.txIndex, height: position.height });
    } else {
      unmined.push(hash);
    }
  }
  // Before the writes: a run that stops part way leaves the rest for the next
  // run, which no longer finds the payments already written.
  await decider.paymentsChanged([...moved, ...unmined]);
  for (let i = 0; i < placed.length; i += BACKFILL_BATCH) {
    // eslint-disable-next-line no-await-in-loop
    await messages.setPositions(placed.slice(i, i + BACKFILL_BATCH));
  }
  for (let i = 0; i < unmined.length; i += BACKFILL_BATCH) {
    // eslint-disable-next-line no-await-in-loop
    await messages.markAllNotOnChain(unmined.slice(i, i + BACKFILL_BATCH));
  }
  const positioned = placed.length;
  const heightsCorrected = moved.length;
  const notOnChain = unmined.length;
  log.info(`migrations - payment positions: ${positioned} positioned, ${heightsCorrected} of them at the chain's height rather than the recorded one, ${notOnChain} not on the chain, ${aboveTip} above the daemon's tip`);
  return {
    positioned, heightsCorrected, notOnChain, aboveTip,
  };
}

module.exports = { backfillPaymentPositions, BACKFILL_BATCH };
