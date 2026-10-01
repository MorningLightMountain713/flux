'use strict';

const config = require('config');

const log = require('../../lib/log');
const dbHelper = require('../dbHelper');
const chainState = require('../chainState');
const confirmedMessageStore = require('./confirmedMessageStore');
const { PAYMENT_WINDOW_MS } = require('../appDecisions/decisionRule');

/**
 * The temporary pool, swept by the chain.
 *
 * A pool row waits for the chain to pay its message, and the chain's clock is
 * the block stamp: a payment is the message's only in a block stamped within
 * the window after its signing (`payableUntil`, the decider's rule), so the
 * scan is what decides when a row has nothing left to wait for. On each block
 * the scan reports, under the chain-state lock:
 *
 *   1. a mark at or above the cursor was set on a branch the scan has left (a
 *      rewind moves the cursor below it; on one branch each block is swept once,
 *      in order) and is cleared before the block is judged;
 *   2. a row whose window this block's stamp has passed is marked with the
 *      height (`windowClosedAt`), once;
 *   3. a row marked MAX_REORG_LENGTH blocks ago leaves the pool. The daemon
 *      refuses a reorganisation deeper than that, so the marked block is on
 *      every branch this node can still accept, and stamps rise strictly along
 *      a chain, so every block that can still arrive is stamped past the window.
 *
 * A v9 message dropped with no payment recorded can never be applied: its only
 * possible payment is past the window, which the decider refuses. The drop
 * records it unpayable, by hash, for the decision route. A v1-v8 payment is
 * applied however late, so a dropped v1-v8 row leaves nothing: the node holds
 * nothing about the message, and a payment that comes fetches it again.
 */

/** The deepest reorganisation the daemon accepts (fluxd `MAX_REORG_LENGTH`). */
const MAX_REORG_LENGTH = 40;

/**
 * How long an unpayable record is kept. FluxDrive keeps an expired app's
 * content for 30 days, and a pending write still asking after that has
 * outlived everything it could have written.
 */
const UNPAYABLE_RECORD_MS = 30 * 24 * 60 * 60 * 1000;

const poolCollectionName = config.get('database.appsglobal.collections.appsTemporaryMessages');
const unpayableCollectionName = config.get('database.appsglobal.collections.appsUnpayableMessages');

let started = false;

function database() {
  return dbHelper.databaseConnection().db(config.get('database.appsglobal.database'));
}

function pool() {
  return database().collection(poolCollectionName);
}

function unpayable() {
  return database().collection(unpayableCollectionName);
}

/**
 * The last block stamp at which a payment is this message's.
 * @param {number} timestamp the message's signed timestamp, ms
 * @returns {Date}
 */
function payableUntil(timestamp) {
  return new Date(timestamp + PAYMENT_WINDOW_MS);
}

/** Asserts the pool's and the unpayable records' indexes; a no-op when they exist. */
async function prepareCollection() {
  // The sync serves the pool in arrival order from a peer's cursor.
  await dbHelper.ensureIndexes(pool(), [{ key: { receivedAt: 1 } }]);
  await dbHelper.ensureIndexes(unpayable(), [
    { key: { hash: 1 }, name: 'unpayable by hash', unique: true },
    { key: { expireAt: 1 }, name: 'unpayable record expiry', expireAfterSeconds: 0 },
  ]);
}

/**
 * The scan moved to a block, holding the chain-state lock.
 * @param {{height: number, time: number}} block the block the cursor now names
 *   and its stamp, in seconds
 */
async function blockScanned({ height, time }) {
  await pool().updateMany({ windowClosedAt: { $gte: height } }, { $unset: { windowClosedAt: '' } });
  await pool().updateMany(
    { windowClosedAt: { $exists: false }, payableUntil: { $lt: new Date(time * 1000) } },
    { $set: { windowClosedAt: height } },
  );
  const closed = await pool().find(
    { windowClosedAt: { $lte: height - MAX_REORG_LENGTH } },
    { projection: { _id: 0, hash: 1, 'appSpecifications.version': 1 } },
  ).toArray();
  if (closed.length === 0) return;

  const hashes = closed.map((row) => row.hash);
  const paid = await confirmedMessageStore.paymentRecords(hashes);
  const unpaidV9 = closed.filter((row) => !paid.has(row.hash) && row.appSpecifications?.version >= 9);
  if (unpaidV9.length) {
    const expireAt = new Date(Date.now() + UNPAYABLE_RECORD_MS);
    await unpayable().bulkWrite(unpaidV9.map((row) => ({
      updateOne: {
        filter: { hash: row.hash },
        update: { $set: { hash: row.hash, droppedAtHeight: height, expireAt } },
        upsert: true,
      },
    })), { ordered: false });
  }
  await pool().deleteMany({ hash: { $in: hashes } });
  log.info(`temporaryPoolSweep - ${hashes.length} message(s) left the pool at ${height}, their payment window closed ${MAX_REORG_LENGTH} blocks ago; ${unpaidV9.length} recorded unpayable`);
}

/**
 * The unpayable record of a message this node dropped unpaid.
 * @param {string} hash
 * @returns {Promise<?{hash: string, droppedAtHeight: number, expireAt: Date}>}
 */
async function unpayableRecord(hash) {
  return unpayable().findOne({ hash }, { projection: { _id: 0 } });
}

/**
 * Stamps `payableUntil` on the pool rows that lack it, written under the
 * wall-clock expiry they still carry, and drops that field. Idempotent: it
 * reads the rows that lack the stamp.
 * @returns {Promise<{stamped: number}>}
 */
async function stampDeadlines() {
  const rows = await pool().find(
    { payableUntil: { $exists: false } },
    { projection: { _id: 0, hash: 1, timestamp: 1 } },
  ).toArray();
  if (rows.length) {
    await pool().bulkWrite(rows.map((row) => ({
      updateOne: {
        filter: { hash: row.hash },
        update: { $set: { payableUntil: payableUntil(row.timestamp) }, $unset: { expireAt: '' } },
      },
    })), { ordered: false });
  }
  return { stamped: rows.length };
}

/** Sweeps the pool on every block the scan reports. */
function start() {
  if (started) return;
  started = true;
  chainState.onBlockScanned(blockScanned);
}

module.exports = {
  MAX_REORG_LENGTH,
  UNPAYABLE_RECORD_MS,
  blockScanned,
  payableUntil,
  prepareCollection,
  stampDeadlines,
  start,
  unpayableRecord,
};
