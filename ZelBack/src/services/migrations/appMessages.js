'use strict';

const config = require('config');
const log = require('../../lib/log');
const dbHelper = require('../dbHelper');
const appRecords = require('../appDatabase/appRecords');
const { PAYMENT_WINDOW_MS } = require('../appDecisions/decisionRule');

const BATCH = 5000;

// The collections a node kept before the app messages were one collection:
// the chain's payment index, the permanent messages and the temporary pool.
const OLD = Object.freeze({
  payments: { database: 'database.daemon.database', collection: 'database.daemon.collections.appsHashes' },
  permanent: { database: 'database.appsglobal.database', collection: 'database.appsglobal.collections.appsMessages' },
  pool: { database: 'database.appsglobal.database', collection: 'database.appsglobal.collections.appsTemporaryMessages' },
});

function collectionOf({ database, collection }) {
  return dbHelper.databaseConnection().db(config.get(database)).collection(config.get(collection));
}

async function exists({ database, collection }) {
  const names = await dbHelper.databaseConnection().db(config.get(database)).listCollections({ name: config.get(collection) }).toArray();
  return names.length > 0;
}

// The contents a stored message carries: everything but the chain facts and the
// pool's facts, which the record keeps on its own halves. A message stored under
// the specification's pre-2021 field name carries it as `appSpecifications`.
function contentsOf(doc) {
  const contents = { ...doc };
  for (const field of ['_id', 'txid', 'height', 'valueSat', 'registeredAt', 'receivedAt', 'payableUntil', 'windowClosedAt', 'expireAt']) {
    delete contents[field];
  }
  if (contents.appSpecifications === undefined && contents.zelAppSpecifications !== undefined) {
    contents.appSpecifications = contents.zelAppSpecifications;
  }
  delete contents.zelAppSpecifications;
  return contents;
}

/**
 * Moves every app message a node holds into the one app-messages collection,
 * once: each payment row becomes a payment half, each permanent message its
 * hash's contents, each pool row contents awaiting a payment, stamped with the
 * payment deadline the pool keeps; then the three collections are dropped. A
 * node with none of them has nothing to move.
 * @returns {Promise<{payments: number, permanent: number, pooled: number}>}
 */
async function migrateAppMessages() {
  const present = {
    payments: await exists(OLD.payments),
    permanent: await exists(OLD.permanent),
    pool: await exists(OLD.pool),
  };
  const moved = { payments: 0, permanent: 0, pooled: 0 };
  if (!present.payments && !present.permanent && !present.pool) return moved;
  const messages = appRecords.messages();

  if (present.payments) {
    const rows = await collectionOf(OLD.payments).find({}, { projection: { _id: 0 } }).toArray();
    for (let i = 0; i < rows.length; i += BATCH) {
      const payments = rows.slice(i, i + BATCH)
        .filter((row) => typeof row.hash === 'string' && typeof row.txid === 'string' && Number.isInteger(row.height) && Number.isFinite(row.value))
        .map((row) => ({
          hash: row.hash,
          txid: row.txid,
          height: row.height,
          ...(Number.isInteger(row.txIndex) ? { txIndex: row.txIndex } : {}),
          value: row.value,
          blockTime: row.blockTime ?? null,
          ...(row.voided === true ? { voided: true } : {}),
        }));
      // eslint-disable-next-line no-await-in-loop
      const { recorded } = await messages.recordPayments(payments);
      moved.payments += recorded.length;
      // The sync state and the chain's verdicts ride with the payment.
      for (const row of rows.slice(i, i + BATCH)) {
        if (!recorded.includes(row.hash)) continue;
        if (row.notOnChain === true) await messages.markNotOnChain(row.hash); // eslint-disable-line no-await-in-loop
        if (row.messageNotFound === true) await messages.markNotFound(row.hash); // eslint-disable-line no-await-in-loop
        if (Number.isInteger(row.syncAttempts) && Number.isInteger(row.nextRetryHeight)) {
          await messages.markSyncAttempt(row.hash, { syncAttempts: row.syncAttempts, nextRetryHeight: row.nextRetryHeight }); // eslint-disable-line no-await-in-loop
        }
      }
    }
  }

  if (present.permanent) {
    const cursor = collectionOf(OLD.permanent).find({}, { projection: { _id: 0 } });
    // eslint-disable-next-line no-await-in-loop
    for (let doc = await cursor.next(); doc !== null; doc = await cursor.next()) {
      if (typeof doc.hash !== 'string' || typeof doc.signature !== 'string') continue;
      // eslint-disable-next-line no-await-in-loop
      const { stored } = await messages.storeContents(contentsOf(doc));
      if (!stored) continue;
      moved.permanent += 1;
      // A payment recorded before the scan kept block times: the message
      // already carries the confirming block's time as its term start.
      if (Number.isFinite(doc.registeredAt) && doc.registeredAt > 0) {
        // eslint-disable-next-line no-await-in-loop
        const payment = await messages.payment(doc.hash);
        if (payment && payment.blockTime == null) await messages.setBlockTime(doc.hash, doc.registeredAt); // eslint-disable-line no-await-in-loop
      }
    }
  }

  if (present.pool) {
    const cursor = collectionOf(OLD.pool).find({}, { projection: { _id: 0 } });
    // eslint-disable-next-line no-await-in-loop
    for (let doc = await cursor.next(); doc !== null; doc = await cursor.next()) {
      if (typeof doc.hash !== 'string' || typeof doc.signature !== 'string') continue;
      const pool = {
        receivedAt: doc.receivedAt ?? new Date(),
        payableUntil: doc.payableUntil ?? new Date(doc.timestamp + PAYMENT_WINDOW_MS),
        ...(doc.windowClosedAt === undefined ? {} : { windowClosedAt: doc.windowClosedAt }),
      };
      // eslint-disable-next-line no-await-in-loop
      const { stored } = await messages.storeContents(contentsOf(doc), pool);
      if (stored) moved.pooled += 1;
    }
  }

  for (const key of ['payments', 'permanent', 'pool']) {
    // eslint-disable-next-line no-await-in-loop
    if (present[key]) await collectionOf(OLD[key]).drop();
  }
  log.info(`migrations - app messages: ${moved.payments} payment(s), ${moved.permanent} permanent message(s) and ${moved.pooled} pooled message(s) moved into the app messages; the old collections dropped`);
  return moved;
}

module.exports = { migrateAppMessages };
