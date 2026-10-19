'use strict';

const config = require('config');
const { inChainOrder } = require('../utils/softForkRows');
const dbHelper = require('../dbHelper');
const log = require('../../lib/log');
const { getSpecPolicy } = require('../utils/specLibs');

let priceMessageHistory;
let rateMessageHistory;
let priceModifierHistory;
let oracleKeyHistory;
let legacyPriceRows = null;
let legacyPriceSchedule = null;

/**
 * The v1-v8 price cards in force from each height: the configured cards and
 * every legacy `p_` price message, by height.
 * @param {Array<{height: number, message: string}>} rows - stored legacy price messages
 * @returns {ReadonlyArray<object>}
 */
function legacyPriceCards(rows) {
  const cards = [...config.get('fluxapps.price')];
  for (const { height, message } of rows) {
    const parts = message.split('_');
    if (parts[4]) {
      cards.push({
        height: +height,
        cpu: +parts[1],
        ram: +parts[2],
        hdd: +parts[3],
        minPrice: +parts[4],
        port: +parts[5] || 2,
        scope: +parts[6] || 6,
        staticip: +parts[7] || 3,
      });
    }
  }
  cards.sort((a, b) => a.height - b.height);
  return Object.freeze(cards.map((card) => Object.freeze({ ...card })));
}

/**
 * The stored legacy price messages.
 * @returns {Promise<Array<{txid: string, height: number, message: string}>>}
 */
async function readLegacyPriceRows() {
  const database = dbHelper.databaseConnection().db(config.get('database.chainparams.database'));
  return dbHelper.findInDatabase(
    database, config.get('database.chainparams.collections.chainMessages'), { version: 'p' }, { projection: { _id: 0 } },
  );
}

function ensureUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  if (value && value.buffer) return new Uint8Array(value.buffer);
  return value;
}

function fixBinaryFields(doc, fields) {
  const msg = doc.message;
  if (!msg || typeof msg !== 'object') return;
  for (const field of fields) {
    if (field in msg) {
      msg[field] = ensureUint8Array(msg[field]);
    }
  }
}

/**
 * Price, rate, modifier and oracle-key histories built from the stored rows,
 * beside the live ones. The live state is untouched until
 * `installPriceOracleState` swaps these in.
 * @returns {Promise<{priceMessageHistory: object, rateMessageHistory: object,
 *   priceModifierHistory: object, oracleKeyHistory: object, legacyPriceRows: object[]}>}
 */
async function buildPriceOracleState() {
  const {
    PriceMessageHistory,
    RateMessageHistory,
    PriceModifierHistory,
    OracleKeyHistory,
  } = await getSpecPolicy();

  const built = {
    priceMessageHistory: new PriceMessageHistory(),
    rateMessageHistory: new RateMessageHistory(),
    priceModifierHistory: new PriceModifierHistory(),
    oracleKeyHistory: new OracleKeyHistory(),
    legacyPriceRows: await readLegacyPriceRows(),
  };

  const db = dbHelper.databaseConnection();
  const database = db.db(config.get('database.chainparams.database'));

  const projection = { projection: { _id: 0 } };

  // OracleKeyHistory must rebuild BEFORE RateMessageHistory
  // (future: rate validation may depend on oracle key resolution)
  const oracleKeyDocs = await dbHelper.findInDatabase(
    database, config.get('database.chainparams.collections.oracleKeyMessages'),
    {}, projection,
  );
  inChainOrder(oracleKeyDocs, 'oracleKeyMessages');
  for (const doc of oracleKeyDocs) {
    fixBinaryFields(doc, ['pubkey']);
    // A row the history refuses is one written under a wire form the parser no
    // longer produces; it stays out of the history, and the scan records what
    // the chain holds under the current form.
    try {
      built.oracleKeyHistory.add(doc.message, doc.height, doc.txIndex);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      log.warn(`Price oracle state: oracle key row ${doc.txid} at ${doc.height} left out of the history: ${error.message}`);
    }
  }

  const priceDocs = await dbHelper.findInDatabase(
    database, config.get('database.chainparams.collections.priceMessages'),
    {}, projection,
  );
  inChainOrder(priceDocs, 'priceMessages');
  for (const doc of priceDocs) {
    built.priceMessageHistory.add(doc.message, doc.height, doc.txIndex);
  }

  const rateDocs = await dbHelper.findInDatabase(
    database, config.get('database.chainparams.collections.rateMessages'),
    {}, projection,
  );
  inChainOrder(rateDocs, 'rateMessages');
  for (const doc of rateDocs) {
    built.rateMessageHistory.add(doc.message, doc.height, doc.txIndex);
  }

  const modifierDocs = await dbHelper.findInDatabase(
    database, config.get('database.chainparams.collections.priceModifierMessages'),
    {}, projection,
  );
  inChainOrder(modifierDocs, 'priceModifierMessages');
  for (const doc of modifierDocs) {
    built.priceModifierHistory.add(doc.message, doc.height, doc.txIndex);
  }

  log.info(`Price oracle state built: ${priceDocs.length} price, ${rateDocs.length} rate, ${modifierDocs.length} modifier, ${oracleKeyDocs.length} oracle-key, ${built.legacyPriceRows.length} legacy price`);
  return built;
}

/**
 * Make built histories the live ones. Synchronous, so no reader sees part of
 * the set.
 * @param {{priceMessageHistory: object, rateMessageHistory: object,
 *   priceModifierHistory: object, oracleKeyHistory: object, legacyPriceRows: object[]}} built
 */
function installPriceOracleState(built) {
  ({
    priceMessageHistory, rateMessageHistory, priceModifierHistory, oracleKeyHistory, legacyPriceRows,
  } = built);
  legacyPriceSchedule = legacyPriceCards(legacyPriceRows);
}

/**
 * Adds a legacy price message the scan stored, replacing the row of its
 * transaction as the store does. Before the histories are installed there is
 * nothing to add to: the build reads the store.
 * @param {{txid: string, height: number, message: string, version: string}} row
 */
function recordLegacyPrice(row) {
  if (legacyPriceRows === null || row.version !== 'p') return;
  legacyPriceRows = [...legacyPriceRows.filter((stored) => stored.txid !== row.txid), row];
  legacyPriceSchedule = legacyPriceCards(legacyPriceRows);
}

function getPriceMessageHistory() { return priceMessageHistory; }
function getRateMessageHistory() { return rateMessageHistory; }
function getPriceModifierHistory() { return priceModifierHistory; }
function getOracleKeyHistory() { return oracleKeyHistory; }

/**
 * The legacy price cards: the installed ones, or the store's before the
 * histories are installed.
 * @returns {Promise<ReadonlyArray<object>>}
 */
async function getLegacyPriceSchedule() {
  return legacyPriceSchedule ?? legacyPriceCards(await readLegacyPriceRows());
}

module.exports = {
  buildPriceOracleState,
  installPriceOracleState,
  getPriceMessageHistory,
  getRateMessageHistory,
  getPriceModifierHistory,
  getOracleKeyHistory,
  getLegacyPriceSchedule,
  recordLegacyPrice,
};
