const { getSpecPolicy } = require('../utils/specLibs');
const priceOracleState = require('./priceOracleState');
const { FluxosDiscounter } = require('./FluxosDiscounter');
const { FluxosSurcharger } = require('./FluxosSurcharger');

async function buildPricingEngine(height) {
  const { PricingEngine } = await getSpecPolicy();

  const priceHistory = priceOracleState.getPriceMessageHistory();
  const rateHistory = priceOracleState.getRateMessageHistory();

  const rates = priceHistory ? priceHistory.resolveAt(height) : {};
  const rateMsg = rateHistory ? rateHistory.resolveAt(height) : null;

  return new PricingEngine({
    commodityRates: rates,
    featureFees: rates,
    fluxUsdPriceE4: rateMsg?.fluxUsdPriceE4 ?? null,
    surcharger: new FluxosSurcharger(),
    discounter: new FluxosDiscounter(),
  });
}

module.exports = { buildPricingEngine };
