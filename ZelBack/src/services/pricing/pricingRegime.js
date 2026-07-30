const legacyPricingRegime = require('./legacyPricingRegime');
const v9PricingRegime = require('./v9PricingRegime');

/**
 * Pick the pricing regime a spec belongs to.
 *
 * Flux prices two generations of specs under deliberately different rules, and
 * this is the one place that decides which set applies:
 *
 * **v1-v8 — two numbers, on purpose.** The on-chain fee is a near-zero floor;
 * what an owner is actually charged is the display price, and whether that is
 * waived is answered locally by checkLegacyFreeUpdate.
 *
 * **v9 — one number.** The on-chain price was raised to equal the display
 * price, so the quote and consensus are the same figure reached through the
 * same PricingEngine call, which decides free-or-not itself.
 *
 * The split is permanent: history cannot be repriced, so v1-v8 specs keep
 * paying under the rules in force when they registered.
 *
 * Both regimes answer the same four questions — two for display, two for
 * consensus — so a caller states the question and never the version:
 *
 *   onChainDisplayPrice(spec)                  -> FLUX for display
 *   fiatAndFluxDisplayPrice(spec, rawDoc)      -> { usd, flux, fluxDiscount }
 *   registrationFee(spec, height)              -> bigint sats
 *   updateFee(spec, prevSpec, height, prevHeight, prevRegisteredAt, nowBlockTime)
 *                                              -> bigint sats
 *
 * @param {object} spec - a resolved spec instance
 * @returns {typeof legacyPricingRegime | typeof v9PricingRegime}
 */
function regimeFor(spec) {
  return spec.version >= 9 ? v9PricingRegime : legacyPricingRegime;
}

module.exports = { regimeFor };
