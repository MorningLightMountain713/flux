'use strict';

const config = require('config');

const log = require('../lib/log');
const dbHelper = require('./dbHelper');
const capabilities = require('./utils/capabilities');
const entitlementsState = require('./entitlementsState');
const priceOracleState = require('./pricing/priceOracleState');
const decisionStore = require('./appDecisions/decisionStore');

/**
 * Chain-derived state: the scan cursor, the app payment records and soft-fork
 * rows the scan writes, and the in-memory histories built from those rows.
 *
 * Every rewind goes through `rewind`, and the scan writes each block through
 * `exclusive`, so a rewind never runs while a block is being written and a
 * block never lands in the middle of a rewind.
 *
 * Owns `chainStateConsistent`: up while the histories hold exactly the stored
 * soft-fork rows. A rewind lowers it, deletes every row above its height,
 * builds the histories from what remains beside the live ones, installs them
 * whole and raises it again. A rewind that throws leaves it down; the next
 * rewind (the scan's error recovery, or the boot restore) completes the work.
 */

const appsHashesCollection = config.get('database.daemon.collections.appsHashes');
const scannedHeightCollection = config.get('database.daemon.collections.scannedHeight');
const chainParamsMessagesCollection = config.get('database.chainparams.collections.chainMessages');
const softForkCollections = [
  config.get('database.chainparams.collections.policyGroupMessages'),
  config.get('database.chainparams.collections.priceMessages'),
  config.get('database.chainparams.collections.rateMessages'),
  config.get('database.chainparams.collections.priceModifierMessages'),
  config.get('database.chainparams.collections.oracleKeyMessages'),
];

let lockTail = Promise.resolve();
let rewinds = 0;
const rewindListeners = [];

function daemonDatabase() {
  return dbHelper.databaseConnection().db(config.get('database.daemon.database'));
}

/**
 * Runs `fn` holding the chain-state lock: after every earlier holder has
 * finished, and before any later one starts. Not reentrant: `fn` must not call
 * `rewind` or `exclusive`.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>} what `fn` returns, or its rejection
 */
function exclusive(fn) {
  const run = lockTail.then(() => fn());
  lockTail = run.catch(() => {});
  return run;
}

/**
 * How many rewinds have started in this process. A holder of the lock that
 * read the cursor before releasing it compares this to know whether a rewind
 * has moved the cursor since.
 * @returns {number}
 */
function rewindCount() {
  return rewinds;
}

/**
 * Registers `fn(height)`, called under the lock by every rewind after its rows
 * are deleted: for state outside the database that describes blocks above the
 * height.
 * @param {(height: number) => void} fn
 * @returns {() => void} unsubscribe
 */
function onRewind(fn) {
  rewindListeners.push(fn);
  return () => {
    const index = rewindListeners.indexOf(fn);
    if (index !== -1) rewindListeners.splice(index, 1);
  };
}

/**
 * The durable scan cursor: the last block whose rows are all written.
 * @param {object} [database] The daemon database handle.
 * @returns {Promise<number>}
 */
async function getScannedHeight(database = daemonDatabase()) {
  const query = { generalScannedHeight: { $gte: 0 } };
  const projection = { projection: { _id: 0, generalScannedHeight: 1 } };
  const current = await dbHelper.findOneInDatabase(database, scannedHeightCollection, query, projection);
  return current?.generalScannedHeight ?? 0;
}

/**
 * Moves the durable scan cursor.
 * @param {object} database The daemon database handle.
 * @param {number} height Height to set the cursor to.
 * @returns {Promise<void>} Resolves once written.
 */
async function setScannedHeight(database, height) {
  const query = { generalScannedHeight: { $gte: 0 } };
  const update = { $set: { generalScannedHeight: height } };
  const options = { upsert: true };

  await dbHelper.updateOneInDatabase(database, scannedHeightCollection, query, update, options);
}

/**
 * Deletes every chain-derived row above a height: app payment records, the
 * decisions of the messages they paid for, legacy and v9 soft-fork rows, and
 * with `rescanGlobalApps` the stored app messages. The registry follows the
 * decisions at the next full pass.
 * @param {number} height
 * @param {boolean} rescanGlobalApps
 */
async function deleteAbove(height, rescanGlobalApps) {
  const dbopen = dbHelper.databaseConnection();
  const database = dbopen.db(config.get('database.daemon.database'));
  const databaseUpdates = dbopen.db(config.get('database.chainparams.database'));
  const query = { height: { $gt: height } };

  await dbHelper.removeDocumentsFromCollection(database, appsHashesCollection, query);
  await decisionStore.deleteAbove(height);
  await dbHelper.removeDocumentsFromCollection(databaseUpdates, chainParamsMessagesCollection, query);
  for (const collection of softForkCollections) {
    // eslint-disable-next-line no-await-in-loop
    await dbHelper.removeDocumentsFromCollection(databaseUpdates, collection, query);
  }
  if (rescanGlobalApps) {
    log.info('Rescanning Apps!');
    const databaseGlobal = dbopen.db(config.get('database.appsglobal.database'));
    await dbHelper.removeDocumentsFromCollection(databaseGlobal, config.get('database.appsglobal.collections.appsMessages'), query);
  }
}

/**
 * Builds every history from the stored rows, then installs them together in
 * one synchronous step: a reader sees the old set or the new one, never an
 * empty, partial or mixed one.
 */
async function buildHistories() {
  const policyGroups = await entitlementsState.buildPolicyGroupState();
  const prices = await priceOracleState.buildPriceOracleState();
  entitlementsState.installPolicyGroupState(policyGroups);
  priceOracleState.installPriceOracleState(prices);
}

/**
 * Rewinds chain-derived state to a height, holding the lock.
 *
 * `target` is a height, or a function of the durable cursor answering one or
 * null for nothing to do; it is evaluated under the lock, so it sees a cursor
 * no scan can move meanwhile. The height is never above the cursor: blocks
 * above it may have rows written and payment records still buffered, and
 * scanning them again is what makes both whole.
 *
 * In order: lowers `chainStateConsistent`; writes the cursor (before any
 * deletion, so a crash leaves the cursor low and the blocks are scanned again,
 * never skipped); deletes the rows above the height; calls the `onRewind`
 * listeners; builds and installs the histories; raises `chainStateConsistent`.
 *
 * @param {string} reason Why, for the capability and the log.
 * @param {number|((state: {cursor: number}) => (number|null))} target
 * @param {{rescanGlobalApps?: boolean}} [options]
 * @returns {Promise<number|null>} the height rewound to, or null when there was
 *   nothing to do
 */
function rewind(reason, target, options = {}) {
  return exclusive(async () => {
    const database = daemonDatabase();
    const cursor = await getScannedHeight(database);
    const wanted = typeof target === 'function' ? target({ cursor }) : target;
    if (wanted === null || wanted === undefined) return null;
    if (!Number.isInteger(wanted) || wanted < 0) {
      throw new Error(`chainState: '${wanted}' is not a height to rewind to (${reason})`);
    }
    const height = Math.min(wanted, cursor);

    rewinds += 1;
    const handle = capabilities.claim('chainStateConsistent', 'chainState');
    handle.lower(`rewinding to ${height}: ${reason}`);
    log.info(`Chain state - rewinding from ${cursor} to ${height}: ${reason}`);

    await setScannedHeight(database, height);
    await deleteAbove(height, options.rescanGlobalApps === true);
    rewindListeners.forEach((fn) => fn(height));
    await buildHistories();

    handle.raise(`histories built, scan cursor at ${height}`);
    return height;
  });
}

module.exports = {
  exclusive,
  getScannedHeight,
  onRewind,
  rewind,
  rewindCount,
  setScannedHeight,
};
