'use strict';

const { getSpecPolicy } = require('../utils/specLibs');
const priceOracleState = require('./priceOracleState');

/** This node's price, rate and modifier histories, as PricingEngine takes them. */
function histories() {
  return {
    prices: priceOracleState.getPriceMessageHistory(),
    rates: priceOracleState.getRateMessageHistory(),
    modifiers: priceOracleState.getPriceModifierHistory(),
  };
}

/**
 * The v9 pricing engine at a price moment: the rates, the FLUX/USD rate and
 * the price modifiers in force there, from this node's chain histories.
 * @param {{time: number, height: number}} at - a message's signed time in
 *   seconds and the block that confirms its payment (see spec-backend priceMoment)
 * @returns {Promise<object>} a PricingEngine
 */
async function buildPricingEngine(at) {
  const { PricingEngine } = await getSpecPolicy();
  return PricingEngine.at(histories(), at);
}

/**
 * The prices in force at a price moment, from this node's chain histories:
 * what buildPricingEngine builds the engine from, as plain data
 * (PricingEngine.inForceAt).
 * @param {{time: number, height: number}} at - as buildPricingEngine
 * @returns {Promise<{prices: object, fluxUsdPriceE4: ?number, modifiers: object}>}
 */
async function pricesInForceAt(at) {
  const { PricingEngine } = await getSpecPolicy();
  return PricingEngine.inForceAt(histories(), at);
}

module.exports = { buildPricingEngine, pricesInForceAt };
