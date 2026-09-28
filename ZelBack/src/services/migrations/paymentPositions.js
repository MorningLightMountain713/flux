'use strict';

const config = require('config');

const log = require('../../lib/log');
const dbHelper = require('../dbHelper');
const { appPaymentPositions } = require('../appPaymentPositions');

/**
 * Gives every app payment record without a position in its block the position
 * the daemon's address index holds for its transaction: one call over the
 * payment addresses for the heights the records span.
 * @returns {Promise<{positioned: number, unresolved: number}>}
 */
async function backfillPaymentPositions() {
  const database = dbHelper.databaseConnection().db(config.get('database.daemon.database'));
  const collection = config.get('database.daemon.collections.appsHashes');
  const missing = await dbHelper.findInDatabase(
    database, collection, { txIndex: { $exists: false } }, { projection: { _id: 0, txid: 1, height: 1 } },
  );
  if (missing.length === 0) return { positioned: 0, unresolved: 0 };

  let start = Infinity;
  let end = -Infinity;
  for (const { height } of missing) {
    if (height < start) start = height;
    if (height > end) end = height;
  }
  const positions = await appPaymentPositions(start, end);
  const operations = [];
  let unresolved = 0;
  for (const { txid } of missing) {
    const position = positions.get(txid);
    if (position) {
      operations.push({
        updateOne: { filter: { txid, txIndex: { $exists: false } }, update: { $set: { txIndex: position.txIndex } } },
      });
    } else {
      unresolved += 1;
    }
  }
  if (operations.length) await dbHelper.bulkWriteInDatabase(database, collection, operations);
  log.info(`migrations - payment positions: ${operations.length} positioned, ${unresolved} not in the address index`);
  return { positioned: operations.length, unresolved };
}

module.exports = { backfillPaymentPositions };
