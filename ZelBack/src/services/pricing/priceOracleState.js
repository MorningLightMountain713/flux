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
 *   priceModifierHistory: object, oracleKeyHistory: object}>}
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

  log.info(`Price oracle state built: ${priceDocs.length} price, ${rateDocs.length} rate, ${modifierDocs.length} modifier, ${oracleKeyDocs.length} oracle-key`);
  return built;
}

/**
 * Make built histories the live ones. Synchronous, so no reader sees part of
 * the set.
 * @param {{priceMessageHistory: object, rateMessageHistory: object,
 *   priceModifierHistory: object, oracleKeyHistory: object}} built
 */
function installPriceOracleState(built) {
  ({
    priceMessageHistory, rateMessageHistory, priceModifierHistory, oracleKeyHistory,
  } = built);
}

function getPriceMessageHistory() { return priceMessageHistory; }
function getRateMessageHistory() { return rateMessageHistory; }
function getPriceModifierHistory() { return priceModifierHistory; }
function getOracleKeyHistory() { return oracleKeyHistory; }

module.exports = {
  buildPriceOracleState,
  installPriceOracleState,
  getPriceMessageHistory,
  getRateMessageHistory,
  getPriceModifierHistory,
  getOracleKeyHistory,
};
