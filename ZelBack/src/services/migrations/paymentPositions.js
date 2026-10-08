'use strict';

const config = require('config');

const log = require('../../lib/log');
const appRecords = require('../appDatabase/appRecords');
const daemonServiceUtils = require('../daemonService/daemonServiceUtils');
const { appPaymentPositions } = require('../appPaymentPositions');

/**
 * Gives every app payment record without a position in its block the position
 * and the height the daemon's address index holds for its transaction: one call
 * over the payment addresses from the height the first of them is active from
 * to the chain tip, so a transaction the index does not hold is not on the
 * chain. Such a record is marked `notOnChain`, and is no payment.
 *
 * The height is the chain's, not the one recorded: a record written from a block
 * that later left the chain carries a height its transaction is not at, and the
 * decider reads a term's start, its fee and its activation from it. Both are set
 * in one write, and the decider decides no name while one of its records has no
 * position, so no decision is made from the recorded height.
 * @returns {Promise<{positioned: number, heightsCorrected: number, notOnChain: number}>}
 */
async function backfillPaymentPositions() {
  const messages = appRecords.messages();
  const missing = await messages.withoutPosition();
  if (missing.length === 0) return { positioned: 0, heightsCorrected: 0, notOnChain: 0 };
  const start = Math.min(...config.get('fluxapps.appPaymentAddresses').map(({ activeFromHeight }) => activeFromHeight));
  const tip = await daemonServiceUtils.executeCall('getBlockCount');
  if (tip.status !== 'success' || !Number.isInteger(tip.data)) {
    throw new Error(`getBlockCount failed: ${tip.data?.message ?? tip.data}`);
  }
  const positions = await appPaymentPositions(start, tip.data);
  let heightsCorrected = 0;
  let notOnChain = 0;
  for (const { hash, txid, height } of missing) {
    const position = positions.get(txid);
    if (position) {
      if (position.height !== height) heightsCorrected += 1;
      // eslint-disable-next-line no-await-in-loop
      await messages.setPosition(hash, { txIndex: position.txIndex, height: position.height });
    } else {
      notOnChain += 1;
      // eslint-disable-next-line no-await-in-loop
      await messages.markNotOnChain(hash);
    }
  }
  log.info(`migrations - payment positions: ${missing.length - notOnChain} positioned, ${heightsCorrected} of them at the chain's height rather than the recorded one, ${notOnChain} not on the chain`);
  return { positioned: missing.length - notOnChain, heightsCorrected, notOnChain };
}

module.exports = { backfillPaymentPositions };
