'use strict';

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
 * Every regime answers the same questions for its own model, and never for
 * another's — so a caller states the question and never the generation:
 *
 *   onChainDisplayPrice(spec, pricing)         -> FLUX for display
 *   fiatAndFluxDisplayPrice(spec, rawDoc, pricing) -> { usd, flux, fluxDiscount }
 *   registrationFee(spec, height)              -> bigint sats
 *   supersededMessage(name, confirming)        -> the permanent message an
 *                                              update replaces, resolved by
 *                                              each regime's own rule
 *   termCost(spec, height)                     -> what a term bought at that
 *                                              height cost, in the regime's
 *                                              own unit
 *   updateFee(spec, prevSpec, ctx)             -> bigint sats (null: refused)
 *
 * An update's predecessor can be of another model (a v8 app updated to v9), so
 * the predecessor's cost is asked of the predecessor's own regime and handed to
 * the update's: the composing functions below, which are how every caller
 * prices an update or a quote.
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

/**
 * What a term of `spec` bought at `height` cost, from the spec's own regime.
 * @param {object} spec
 * @param {number} height
 * @returns {Promise<object>} the regime's cost fields, for priceUpdate's context
 */
async function termCost(spec, height) {
  return (await regimeFor(spec)).termCost(spec, height);
}

/** What every regime's display functions read of the others. */
const pricing = Object.freeze({ termCost });

/**
 * The consensus fee for an update, from the update's regime, with the
 * predecessor's term cost from the predecessor's.
 *
 * @param {object} spec - resolved new spec
 * @param {object} prevSpec - resolved previous spec
 * @param {{height: number, prevHeight: number, prevRegisteredAt: ?number,
 *   nowBlockTime: number, recentEvents: object[]}} ctx
 * @returns {Promise<bigint|null>}
 */
async function updateFee(spec, prevSpec, ctx) {
  const prevTermCost = await termCost(prevSpec, ctx.prevHeight);
  return (await regimeFor(spec)).updateFee(spec, prevSpec, { ...ctx, prevTermCost });
}

/**
 * The on-chain price of a spec for display, from its regime.
 * @param {object} spec
 * @returns {Promise<number|string>}
 */
async function onChainDisplayPrice(spec) {
  return (await regimeFor(spec)).onChainDisplayPrice(spec, pricing);
}

/**
 * The USD and FLUX quote for a spec, from its regime.
 * @param {object} spec
 * @param {object} appSpecification - the raw submitted document
 * @returns {Promise<object>}
 */
async function fiatAndFluxDisplayPrice(spec, appSpecification) {
  return (await regimeFor(spec)).fiatAndFluxDisplayPrice(spec, appSpecification, pricing);
}

module.exports = {
  fiatAndFluxDisplayPrice,
  onChainDisplayPrice,
  regimeFor,
  termCost,
  updateFee,
};
