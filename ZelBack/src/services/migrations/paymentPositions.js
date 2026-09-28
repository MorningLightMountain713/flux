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
async function positionPaymentRecords() {
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

/**
 * Gives every stored app message without a position the position of its hash's
 * payment record.
 * @returns {Promise<number>} messages positioned
 */
async function positionStoredMessages() {
  const connection = dbHelper.databaseConnection();
  const messagesDb = connection.db(config.get('database.appsglobal.database'));
  const messages = config.get('database.appsglobal.collections.appsMessages');
  const unpositioned = await dbHelper.findInDatabase(
    messagesDb, messages, { txIndex: { $exists: false } }, { projection: { _id: 0, hash: 1 } },
  );
  if (unpositioned.length === 0) return 0;

  const records = await dbHelper.findInDatabase(
    connection.db(config.get('database.daemon.database')),
    config.get('database.daemon.collections.appsHashes'),
    { txIndex: { $exists: true } },
    { projection: { _id: 0, hash: 1, txIndex: 1 } },
  );
  const positionOf = new Map(records.map((record) => [record.hash, record.txIndex]));
  const operations = unpositioned
    .filter(({ hash }) => positionOf.has(hash))
    .map(({ hash }) => ({
      updateOne: { filter: { hash, txIndex: { $exists: false } }, update: { $set: { txIndex: positionOf.get(hash) } } },
    }));
  if (operations.length) await dbHelper.bulkWriteInDatabase(messagesDb, messages, operations);
  log.info(`migrations - message positions: ${operations.length} of ${unpositioned.length} unpositioned messages positioned`);
  return operations.length;
}

/**
 * Positions the payment records, then the stored messages from them.
 * @returns {Promise<{positioned: number, unresolved: number, messages: number}>}
 */
async function backfillPaymentPositions() {
  const records = await positionPaymentRecords();
  const messages = await positionStoredMessages();
  return { ...records, messages };
}

module.exports = { backfillPaymentPositions };
