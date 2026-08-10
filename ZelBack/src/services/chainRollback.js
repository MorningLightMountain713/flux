'use strict';

const config = require('config');

const log = require('../lib/log');
const dbHelper = require('./dbHelper');
const entitlementsState = require('./entitlementsState');
const priceOracleState = require('./pricing/priceOracleState');

/**
 * Undoing chain-derived state, for a reorg or a rescan.
 *
 * Separated from the block processor because it is driven from several places — a
 * reorg, a crash recovery, a rescan request — and because the ordering it depends on
 * is easy to get wrong when it lives inside the loop that also advances the cursor.
 */

const appsHashesCollection = config.database.daemon.collections.appsHashes;
const scannedHeightCollection = config.database.daemon.collections.scannedHeight;
const chainParamsMessagesCollection = config.database.chainparams.collections.chainMessages;
const policyGroupMessagesCollection = config.database.chainparams.collections.policyGroupMessages;
const priceMessagesCollection = config.database.chainparams.collections.priceMessages;
const rateMessagesCollection = config.database.chainparams.collections.rateMessages;
const priceModifierMessagesCollection = config.database.chainparams.collections.priceModifierMessages;
const oracleKeyMessagesCollection = config.database.chainparams.collections.oracleKeyMessages;
const marketplacePricingMessagesCollection = config.database.chainparams.collections.marketplacePricingMessages;

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
 * Deletes chain-derived state above a height.
 *
 * In-memory histories are pruned in step with their collections: the query keeps
 * `height <= h`, the history drops `>= h + 1`, so the two agree.
 *
 * @param {number} height Height to restore to.
 * @param {boolean} rescanGlobalApps Also drop confirmed app messages and information.
 * @returns {Promise<boolean>} True on completion.
 */
async function restoreDatabaseToBlockheightState(height, rescanGlobalApps = false) {
  if (!height) {
    throw new Error('No blockheight for restoring provided');
  }
  const dbopen = dbHelper.databaseConnection();
  const database = dbopen.db(config.database.daemon.database);

  const query = { height: { $gt: height } };

  await dbHelper.removeDocumentsFromCollection(database, appsHashesCollection, query);
  log.info('Rescanning Blockchain Parameters!');
  const databaseGlobal = dbopen.db(config.database.appsglobal.database);
  const databaseUpdates = dbopen.db(config.database.chainparams.database);
  await dbHelper.removeDocumentsFromCollection(databaseUpdates, chainParamsMessagesCollection, query);
  await dbHelper.removeDocumentsFromCollection(databaseUpdates, policyGroupMessagesCollection, query);
  entitlementsState.removeAtHeight(height + 1);
  await dbHelper.removeDocumentsFromCollection(databaseUpdates, priceMessagesCollection, query);
  await dbHelper.removeDocumentsFromCollection(databaseUpdates, rateMessagesCollection, query);
  await dbHelper.removeDocumentsFromCollection(databaseUpdates, priceModifierMessagesCollection, query);
  await dbHelper.removeDocumentsFromCollection(databaseUpdates, oracleKeyMessagesCollection, query);
  await dbHelper.removeDocumentsFromCollection(databaseUpdates, marketplacePricingMessagesCollection, query);
  priceOracleState.removeAtHeight(height + 1);
  if (rescanGlobalApps === true) {
    log.info('Rescanning Apps!');
    await dbHelper.removeDocumentsFromCollection(databaseGlobal, config.database.appsglobal.collections.appsMessages, query);
    await dbHelper.removeDocumentsFromCollection(databaseGlobal, config.database.appsglobal.collections.appsInformation, query);
  }
  log.info('Rescan completed');
  return true;
}

/**
 * Rolls the chain-derived state back to a height and moves the cursor with it.
 *
 * **The cursor is written first, before any data is deleted.** There is no
 * transaction spanning these collections, so one of the two orderings has to be
 * chosen for what a crash in the middle leaves behind:
 *
 * Deleting first and moving the cursor after — which is what this used to do — leaves
 * a crash with the data rolled back and the cursor still high. Those blocks are then
 * never rescanned, and the loss is silent and permanent.
 *
 * Writing the cursor first leaves a crash with the cursor low and the deletion partly
 * done. The re-scan simply redoes those blocks, and redoing them is safe: app hashes
 * carry a unique index and duplicate inserts are swallowed, and chain parameter
 * messages are upserts keyed on txid.
 *
 * @param {number} height Height to roll back to.
 * @param {{rescanGlobalApps?: boolean}} options
 * @returns {Promise<boolean>} True on completion.
 */
async function rollbackTo(height, options = {}) {
  if (!height && height !== 0) {
    throw new Error('No blockheight for restoring provided');
  }

  const dbopen = dbHelper.databaseConnection();
  const database = dbopen.db(config.database.daemon.database);

  log.info(`Rolling chain state back to ${height}`);

  await setScannedHeight(database, height);
  await restoreDatabaseToBlockheightState(height, options.rescanGlobalApps === true);

  return true;
}

module.exports = {
  restoreDatabaseToBlockheightState,
  rollbackTo,
  setScannedHeight,
};
