'use strict';

const config = require('config');

const log = require('../../lib/log');
const dbHelper = require('../dbHelper');
const daemonServiceUtils = require('../daemonService/daemonServiceUtils');
const { appPaymentPositions } = require('../appPaymentPositions');

/**
 * Gives every app payment record without a position in its block the position
 * and the height the daemon's address index holds for its transaction: one call
 * over the payment addresses from the lowest recorded height to the chain tip.
 *
 * The height is the chain's, not the one recorded: a record written from a block
 * that later left the chain carries a height its transaction is not at, and the
 * decider reads a term's start, its fee and its activation from it. Both are set
 * in one write, and the decider decides no name while one of its records has no
 * position, so no decision is made from the recorded height.
 * @returns {Promise<{positioned: number, heightsCorrected: number, unresolved: number}>}
 */
async function backfillPaymentPositions() {
  const database = dbHelper.databaseConnection().db(config.get('database.daemon.database'));
  const collection = config.get('database.daemon.collections.appsHashes');
  const missing = await dbHelper.findInDatabase(
    database, collection, { txIndex: { $exists: false } }, { projection: { _id: 0, txid: 1, height: 1 } },
  );
  if (missing.length === 0) return { positioned: 0, heightsCorrected: 0, unresolved: 0 };

  const start = Math.min(...missing.map(({ height }) => height));
  // To the tip rather than the highest recorded height: a transaction recorded
  // below where it is can sit above every recorded height.
  const tip = await daemonServiceUtils.executeCall('getBlockCount');
  if (tip.status !== 'success' || !Number.isInteger(tip.data)) {
    throw new Error(`getBlockCount failed: ${tip.data?.message ?? tip.data}`);
  }
  const positions = await appPaymentPositions(start, tip.data);
  const operations = [];
  let heightsCorrected = 0;
  let unresolved = 0;
  for (const { txid, height } of missing) {
    const position = positions.get(txid);
    if (position) {
      if (position.height !== height) heightsCorrected += 1;
      operations.push({
        updateOne: {
          filter: { txid, txIndex: { $exists: false } },
          update: { $set: { txIndex: position.txIndex, height: position.height } },
        },
      });
    } else {
      unresolved += 1;
    }
  }
  if (operations.length) await dbHelper.bulkWriteInDatabase(database, collection, operations);
  log.info(`migrations - payment positions: ${operations.length} positioned, ${heightsCorrected} of them at the chain's height rather than the recorded one, ${unresolved} not in the address index`);
  return { positioned: operations.length, heightsCorrected, unresolved };
}

module.exports = { backfillPaymentPositions };
