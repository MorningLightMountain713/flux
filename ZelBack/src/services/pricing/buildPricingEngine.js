'use strict';

const { getSpecPolicy } = require('../utils/specLibs');
const priceOracleState = require('./priceOracleState');

/**
 * The v9 pricing engine at a price moment: the rates, the FLUX/USD rate and
 * the price modifiers in force there, from this node's chain histories.
 * @param {{time: number, height: number}} at - a message's signed time in
 *   seconds and the block that confirms its payment (see spec-backend priceMoment)
 * @returns {Promise<object>} a PricingEngine
 */
async function buildPricingEngine(at) {
  const { PricingEngine } = await getSpecPolicy();
  return PricingEngine.at({
    prices: priceOracleState.getPriceMessageHistory(),
    rates: priceOracleState.getRateMessageHistory(),
    modifiers: priceOracleState.getPriceModifierHistory(),
  }, at);
}

module.exports = { buildPricingEngine };
