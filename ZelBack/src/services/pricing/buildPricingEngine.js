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

/**
 * Resolve the effective marketplace per-template multiplier (basis points,
 * 10000 = 1.0x) for a spec at a given height, to pass via the PricingEngine
 * ctx. Resolution order: per-template MarketplacePricingMessage -> the
 * PriceModifierMessage marketplaceMultiplierBase default -> 1.0x. Non-v9 or
 * non-marketplace specs always resolve to 1.0x (no effect).
 *
 * @param {object} spec - v9 spec instance (exposes .version and .marketplace)
 * @param {number} height - chain height to resolve at
 * @returns {number} basis points (10000 = 1.0x)
 */
function resolveMarketplaceMultiplier(spec, height) {
  if (!spec || spec.version < 9) return 10000;
  const { marketplace } = spec;
  if (!marketplace || !marketplace.templateId) return 10000;

  const uuidBytes = Buffer.from(marketplace.templateId.replace(/-/g, ''), 'hex');
  const mpHistory = priceOracleState.getMarketplacePricingHistory();
  const perTemplate = mpHistory ? mpHistory.resolveAt(uuidBytes, height) : null;
  if (perTemplate != null) return perTemplate;

  const modifierHistory = priceOracleState.getPriceModifierHistory();
  const params = modifierHistory ? modifierHistory.resolveAt(height) : null;
  return params?.marketplaceMultiplierBase ?? 10000;
}

module.exports = { buildPricingEngine, resolveMarketplaceMultiplier };
