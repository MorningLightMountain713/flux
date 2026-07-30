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

function uuidToBytes(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

/**
 * Resolve the effective marketplace pricing for a v9 spec at a height and
 * return the PricingEngine ctx fragment that applies it. The chain prices a
 * marketplace app either by a multiplier (per-tier -> per-template -> global
 * default cascade) or by a per-tier fixed USD price; the two are mutually
 * exclusive, so this sets at most one of marketplaceMultiplier /
 * marketplaceFixedPriceMicrodollars. configId (the deployed tier) selects the
 * most-specific entry. Non-marketplace specs return an empty fragment (pure
 * resource pricing, 1.0x) — which covers every v1-v8 spec, since marketplace is
 * a v9 field and the legacy classes all report it as undefined.
 *
 * @param {object} spec - spec instance (exposes .marketplace)
 * @param {number} height - chain height to resolve at
 * @returns {{marketplaceMultiplier?: number, marketplaceFixedPriceMicrodollars?: number}}
 */
function resolveMarketplacePricingCtx(spec, height) {
  if (!spec) return {};
  const { marketplace } = spec;
  if (!marketplace || !marketplace.templateId) return {};

  const mpHistory = priceOracleState.getMarketplacePricingHistory();
  if (!mpHistory) return {};

  const templateBytes = uuidToBytes(marketplace.templateId);
  const configBytes = marketplace.configId ? uuidToBytes(marketplace.configId) : null;
  const eff = mpHistory.resolveEffective(templateBytes, configBytes, height);
  if (!eff) return {};

  return eff.kind === 'fixed'
    ? { marketplaceFixedPriceMicrodollars: eff.microdollars }
    : { marketplaceMultiplier: eff.basisPoints };
}

module.exports = { buildPricingEngine, resolveMarketplacePricingCtx };
