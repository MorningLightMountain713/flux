'use strict';

const config = require('config');
const dbHelper = require('../dbHelper');
const log = require('../../lib/log');
const { getSpecPolicy } = require('../utils/specLibs');

let priceMessageHistory;
let rateMessageHistory;
let priceModifierHistory;
let oracleKeyHistory;
let marketplacePricingHistory;

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

async function rebuildPriceOracleState() {
  const {
    PriceMessageHistory,
    RateMessageHistory,
    PriceModifierHistory,
    OracleKeyHistory,
    MarketplacePricingHistory,
  } = await getSpecPolicy();

  priceMessageHistory = new PriceMessageHistory();
  rateMessageHistory = new RateMessageHistory();
  priceModifierHistory = new PriceModifierHistory();
  oracleKeyHistory = new OracleKeyHistory();
  marketplacePricingHistory = new MarketplacePricingHistory();

  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.chainparams.database);

  const projection = { projection: { _id: 0 } };

  // OracleKeyHistory must rebuild BEFORE RateMessageHistory
  // (future: rate validation may depend on oracle key resolution)
  const oracleKeyDocs = await dbHelper.findInDatabase(
    database, config.database.chainparams.collections.oracleKeyMessages,
    {}, projection,
  );
  oracleKeyDocs.sort((a, b) => a.height - b.height);
  for (const doc of oracleKeyDocs) {
    fixBinaryFields(doc, ['pubkey']);
    oracleKeyHistory.add(doc.message, doc.height);
  }

  const priceDocs = await dbHelper.findInDatabase(
    database, config.database.chainparams.collections.priceMessages,
    {}, projection,
  );
  priceDocs.sort((a, b) => a.height - b.height);
  for (const doc of priceDocs) {
    priceMessageHistory.add(doc.message, doc.height);
  }

  const rateDocs = await dbHelper.findInDatabase(
    database, config.database.chainparams.collections.rateMessages,
    {}, projection,
  );
  rateDocs.sort((a, b) => a.height - b.height);
  for (const doc of rateDocs) {
    rateMessageHistory.add(doc.message, doc.height);
  }

  const modifierDocs = await dbHelper.findInDatabase(
    database, config.database.chainparams.collections.priceModifierMessages,
    {}, projection,
  );
  modifierDocs.sort((a, b) => a.height - b.height);
  for (const doc of modifierDocs) {
    priceModifierHistory.add(doc.message, doc.height);
  }

  const marketplaceDocs = await dbHelper.findInDatabase(
    database, config.database.chainparams.collections.marketplacePricingMessages,
    {}, projection,
  );
  marketplaceDocs.sort((a, b) => a.height - b.height);
  for (const doc of marketplaceDocs) {
    fixBinaryFields(doc, ['templateUuid']);
    marketplacePricingHistory.add(doc.message, doc.height);
  }

  log.info(`Price oracle state rebuilt: ${priceDocs.length} price, ${rateDocs.length} rate, ${modifierDocs.length} modifier, ${oracleKeyDocs.length} oracle-key, ${marketplaceDocs.length} marketplace`);
}

function removeAtHeight(height) {
  if (priceMessageHistory) priceMessageHistory.removeAtHeight(height);
  if (rateMessageHistory) rateMessageHistory.removeAtHeight(height);
  if (priceModifierHistory) priceModifierHistory.removeAtHeight(height);
  if (oracleKeyHistory) oracleKeyHistory.removeAtHeight(height);
  if (marketplacePricingHistory) marketplacePricingHistory.removeAtHeight(height);
}

function getPriceMessageHistory() { return priceMessageHistory; }
function getRateMessageHistory() { return rateMessageHistory; }
function getPriceModifierHistory() { return priceModifierHistory; }
function getOracleKeyHistory() { return oracleKeyHistory; }
function getMarketplacePricingHistory() { return marketplacePricingHistory; }

module.exports = {
  rebuildPriceOracleState,
  removeAtHeight,
  getPriceMessageHistory,
  getRateMessageHistory,
  getPriceModifierHistory,
  getOracleKeyHistory,
  getMarketplacePricingHistory,
};
