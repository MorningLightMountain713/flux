'use strict';

const config = require('config');

const log = require('../../lib/log');
const dbHelper = require('../dbHelper');
const chainState = require('../chainState');
const appRecords = require('../appDatabase/appRecords');
const specLibrary = require('../utils/specLibrary');

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

const unpayableCollectionName = config.get('database.appsglobal.collections.appsUnpayableMessages');

let started = false;

function database() {
  return dbHelper.databaseConnection().db(config.get('database.appsglobal.database'));
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
  return new Date(timestamp + specLibrary.loaded().PAYMENT_WINDOW_MS);
}

/** Asserts the unpayable records' indexes; a no-op when they exist. */
async function prepareCollection() {
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
  const messages = appRecords.messages();
  await messages.reopenWindows(height);
  await messages.closeWindows({ before: new Date(time * 1000), height });
  const closed = await messages.windowsClosedBy(height - MAX_REORG_LENGTH);
  if (closed.length === 0) return;
  const hashes = closed.map((record) => record.hash);
  const unpaidV9 = closed.filter((record) => record.contents.appSpecifications?.version >= 9);
  if (unpaidV9.length) {
    const expireAt = new Date(Date.now() + UNPAYABLE_RECORD_MS);
    await unpayable().bulkWrite(unpaidV9.map((record) => ({
      updateOne: {
        filter: { hash: record.hash },
        update: { $set: { hash: record.hash, droppedAtHeight: height, expireAt } },
        upsert: true,
      },
    })), { ordered: false });
  }
  await messages.dropUnpaid(hashes);
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
  start,
  unpayableRecord,
};
