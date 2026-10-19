'use strict';

const config = require('config');
const log = require('../../lib/log');
const dbHelper = require('../dbHelper');
const appRecords = require('../appDatabase/appRecords');
const specLibrary = require('../utils/specLibrary');

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

// A payment row as the payment index holds it, or null for a row naming no
// hash, transaction, integer height or finite value.
function paymentOf(row) {
  if (typeof row.hash !== 'string' || typeof row.txid !== 'string' || !Number.isInteger(row.height) || !Number.isFinite(row.value)) return null;
  return {
    hash: row.hash,
    txid: row.txid,
    height: row.height,
    ...(Number.isInteger(row.txIndex) ? { txIndex: row.txIndex } : {}),
    value: row.value,
    blockTime: row.blockTime ?? null,
    ...(row.voided === true ? { voided: true } : {}),
  };
}

// The block time a payment recorded before the scan kept block times takes
// from the message's term start.
function termStartOf(doc) {
  return Number.isFinite(doc.registeredAt) && doc.registeredAt > 0 ? doc.registeredAt : null;
}

/**
 * Records one hash a cut-short move already left a record for, by the store's
 * own rule for a hash it may hold: what the per-record writes would make of it.
 * @returns {Promise<{payment: boolean, contents: boolean}>} what was recorded
 */
async function recordOne(messages, { hash, payment, contents, termStart }) {
  let paid = false;
  if (payment) {
    const { recorded } = await messages.recordPayments([paymentOf(payment)]);
    paid = recorded.includes(hash);
    if (paid) {
      if (payment.notOnChain === true) await messages.markNotOnChain(hash);
      if (payment.messageNotFound === true) await messages.markNotFound(hash);
      if (Number.isInteger(payment.syncAttempts) && Number.isInteger(payment.nextRetryHeight)) {
        await messages.markSyncAttempt(hash, { syncAttempts: payment.syncAttempts, nextRetryHeight: payment.nextRetryHeight });
      }
    }
  }
  let held = false;
  if (contents) {
    ({ stored: held } = await messages.storeContents(contents));
    if (held && termStart) {
      const recordedPayment = await messages.payment(hash);
      if (recordedPayment && recordedPayment.blockTime == null) await messages.setBlockTime(hash, termStart);
    }
  }
  return { payment: paid, contents: held };
}

/**
 * Moves the payments and the permanent messages: the payment rows held in
 * memory by hash (each hash's first), each permanent message joined to its
 * payment, then the payments no message carries, a batch at a time. A batch's
 * hashes the store holds none of are written whole in one write; a hash a
 * cut-short move left a record for is recorded on its own. An empty store,
 * which is every node at its first start of this code, is indexed once the
 * batches are in; one holding records first, for the reads of what it holds.
 */
async function movePaymentsAndMessages(present, moved) {
  const messages = appRecords.messages();
  const empty = await messages.isEmpty();
  if (!empty) await messages.ensureIndexes();

  const payments = new Map();
  if (present.payments) {
    const rows = await collectionOf(OLD.payments).find({}, { projection: { _id: 0 } }).toArray();
    for (const row of rows) {
      const payment = paymentOf(row);
      if (payment && !payments.has(payment.hash)) {
        payments.set(payment.hash, {
          ...payment,
          ...(row.notOnChain === true ? { notOnChain: true } : {}),
          ...(row.messageNotFound === true ? { messageNotFound: true } : {}),
          ...(Number.isInteger(row.syncAttempts) && Number.isInteger(row.nextRetryHeight)
            ? { syncAttempts: row.syncAttempts, nextRetryHeight: row.nextRetryHeight } : {}),
        });
      }
    }
  }

  async function write(batch) {
    if (batch.length === 0) return;
    const held = empty ? new Set() : new Set((await messages.byHashes(batch.map(({ hash }) => hash))).map((record) => record.hash));
    const whole = batch.filter(({ hash }) => !held.has(hash));
    if (whole.length) {
      await messages.insertWhole(whole.map(({ hash, payment, contents, termStart }) => ({
        hash,
        ...(contents ? { contents } : {}),
        ...(payment ? { payment: payment.blockTime == null && termStart ? { ...payment, blockTime: termStart } : payment } : {}),
      })));
      moved.payments += whole.filter(({ payment }) => payment).length;
      moved.permanent += whole.filter(({ contents }) => contents).length;
    }
    for (const entry of batch.filter(({ hash }) => held.has(hash))) {
      // eslint-disable-next-line no-await-in-loop
      const recorded = await recordOne(messages, entry);
      if (recorded.payment) moved.payments += 1;
      if (recorded.contents) moved.permanent += 1;
    }
  }

  if (present.permanent) {
    // Each hash once: the first permanent message stored under it, as
    // storeContents keeps the first.
    const taken = new Set();
    const cursor = collectionOf(OLD.permanent).find({}, { projection: { _id: 0 } });
    let batch = [];
    // eslint-disable-next-line no-await-in-loop
    for (let doc = await cursor.next(); doc !== null; doc = await cursor.next()) {
      if (typeof doc.hash !== 'string' || typeof doc.signature !== 'string' || taken.has(doc.hash)) continue;
      taken.add(doc.hash);
      const payment = payments.get(doc.hash) ?? null;
      payments.delete(doc.hash);
      batch.push({
        hash: doc.hash, payment, contents: contentsOf(doc), termStart: termStartOf(doc),
      });
      if (batch.length === BATCH) {
        // eslint-disable-next-line no-await-in-loop
        await write(batch);
        batch = [];
      }
    }
    await write(batch);
  }

  const bare = [...payments.values()].map((payment) => ({ hash: payment.hash, payment }));
  for (let i = 0; i < bare.length; i += BATCH) {
    // eslint-disable-next-line no-await-in-loop
    await write(bare.slice(i, i + BATCH));
  }
  if (empty) await messages.ensureIndexes();
}

/**
 * Moves every app message a node holds into the one app-messages collection,
 * once: each payment row becomes a payment half, each permanent message its
 * hash's contents, each pool row contents awaiting a payment, stamped with the
 * payment deadline the pool keeps; then the three collections are dropped. A
 * node with none of them has nothing to move.
 *
 * The payments and the permanent messages are written whole, a batch per
 * write (movePaymentsAndMessages); the pool, a few rows, one at a time.
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

  await movePaymentsAndMessages(present, moved);

  if (present.pool) {
    const cursor = collectionOf(OLD.pool).find({}, { projection: { _id: 0 } });
    // eslint-disable-next-line no-await-in-loop
    for (let doc = await cursor.next(); doc !== null; doc = await cursor.next()) {
      if (typeof doc.hash !== 'string' || typeof doc.signature !== 'string') continue;
      const pool = {
        receivedAt: doc.receivedAt ?? new Date(),
        payableUntil: doc.payableUntil ?? new Date(doc.timestamp + specLibrary.loaded().PAYMENT_WINDOW_MS),
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
