'use strict';

const { getSpecPolicy } = require('../utils/specLibs');
const priceOracleState = require('./priceOracleState');
const { FluxosDiscounter } = require('./FluxosDiscounter');
const { FluxosSurcharger } = require('./FluxosSurcharger');

/**
 * The v9 pricing engine at a price moment: the rates, the FLUX/USD rate and
 * the modifiers in force there.
 * @param {{time: number, height: number}} at - a message's signed time in
 *   seconds and the block that confirms its payment (see spec-backend priceMoment)
 * @returns {Promise<object>} a PricingEngine
 */
async function buildPricingEngine(at) {
  const { PricingEngine } = await getSpecPolicy();

  const priceHistory = priceOracleState.getPriceMessageHistory();
  const rateHistory = priceOracleState.getRateMessageHistory();
  const modifierHistory = priceOracleState.getPriceModifierHistory();

  const rates = priceHistory ? priceHistory.resolveAt(at) : {};
  const rateMsg = rateHistory ? rateHistory.resolveAt(at) : null;
  const modifiers = modifierHistory ? modifierHistory.resolveAt(at) : {};

  return new PricingEngine({
    commodityRates: rates,
    featureFees: rates,
    fluxUsdPriceE4: rateMsg?.fluxUsdPriceE4 ?? null,
    surcharger: new FluxosSurcharger(modifiers),
    discounter: new FluxosDiscounter(modifiers),
  });
}

module.exports = { buildPricingEngine };
