const { getSpec } = require('../utils/specLibs');
const legacyPricingRegime = require('./legacyPricingRegime');
const v9PricingRegime = require('./v9PricingRegime');

/**
 * The implementation of each pricing model Flux has issued specs under. A spec
 * states its model (`spec.pricingModel`); this is where those names meet code.
 *
 * **CHAIN_FLOOR — two numbers, on purpose.** The on-chain fee is a near-zero
 * floor; what an owner is actually charged is the display price, and whether
 * that is waived is answered locally by checkLegacyFreeUpdate.
 *
 * **UNIFIED — one number.** The on-chain price was raised to equal the display
 * price, so the quote and consensus are the same figure reached through the
 * same PricingEngine call, which decides free-or-not itself.
 *
 * A model is permanent: history cannot be repriced, so a spec keeps the
 * economics it registered under. A new generation adds a model here rather than
 * changing what an existing one means.
 */
let regimes;

async function regimeRegistry() {
  if (!regimes) {
    const { PricingModel } = await getSpec();
    regimes = Object.freeze({
      [PricingModel.CHAIN_FLOOR]: legacyPricingRegime,
      [PricingModel.UNIFIED]: v9PricingRegime,
    });
  }
  return regimes;
}

/**
 * The regime that prices a spec.
 *
 * Every regime answers the same five questions — two for display, three for
 * consensus — so a caller states the question and never the generation:
 *
 *   onChainDisplayPrice(spec)                  -> FLUX for display
 *   fiatAndFluxDisplayPrice(spec, rawDoc)      -> { usd, flux, fluxDiscount }
 *   registrationFee(spec, height)              -> bigint sats
 *   supersededMessage(name, confirming)        -> the permanent message an
 *                                              update replaces, resolved by
 *                                              each regime's own rule
 *   updateFee(spec, prevSpec, height, prevHeight, prevRegisteredAt, nowBlockTime)
 *                                              -> bigint sats
 *
 * A spec declaring a model with no implementation throws rather than falling
 * back: pricing an app under economics it was not issued under is worse than
 * refusing to price it.
 *
 * @param {object} spec - a resolved spec instance
 * @returns {Promise<typeof legacyPricingRegime | typeof v9PricingRegime>}
 */
async function regimeFor(spec) {
  const regime = (await regimeRegistry())[spec.pricingModel];
  if (!regime) {
    throw new Error(`No pricing regime implements model "${spec.pricingModel}"`);
  }
  return regime;
}

module.exports = { regimeFor };
