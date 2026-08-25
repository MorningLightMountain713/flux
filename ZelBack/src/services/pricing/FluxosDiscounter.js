'use strict';

const priceOracleState = require('./priceOracleState');

class FluxosDiscounter {
  async discounts(spec, _partial, ctx) {
    const history = priceOracleState.getPriceModifierHistory();
    if (!history) return [];
    const params = history.resolveAt(ctx.height);
    if (!params) return [];

    const entries = [];
    const duration = ctx.duration || 0;

    if (params.durationBucket3MinSeconds && duration >= params.durationBucket3MinSeconds) {
      entries.push({ type: 'basisPoints', value: params.durationBucket3DiscountBp, label: 'duration-365d', target: 'total' });
    } else if (params.durationBucket2MinSeconds && duration >= params.durationBucket2MinSeconds) {
      entries.push({ type: 'basisPoints', value: params.durationBucket2DiscountBp, label: 'duration-180d', target: 'total' });
    } else if (params.durationBucket1MinSeconds && duration >= params.durationBucket1MinSeconds) {
      entries.push({ type: 'basisPoints', value: params.durationBucket1DiscountBp, label: 'duration-90d', target: 'total' });
    }

    return entries;
  }

  async checkFreeUpdate(oldSpec, newSpec, ctx) {
    const { checkFreeUpdate } = await require('../utils/specLibs').getSpecPolicy();
    const result = checkFreeUpdate({
      oldSpec,
      newSpec,
      // Feature sets are computed once by the pricer with each spec's real
      // encryption flag — newFeatures is injected by PricingEngine.priceUpdate
      // from the new breakdown; oldFeatures comes from the caller, derived from
      // the old breakdown it prices for the unused-time credit.
      oldFeatures: ctx.oldFeatures,
      newFeatures: ctx.newFeatures,
      recentEvents: ctx.recentEvents || [],
      now: ctx.now || Date.now(),
    });
    // The helper returns a rich result on EVERY outcome; the Discounter
    // contract is "result on free, refusal result on free-shaped-but-refused,
    // null on not-free". A plain shape rejection must collapse to null or its
    // truthy {free:false} would short-circuit the price computation - but a
    // refusal (every spec rule passed, allowance spent) must travel, so the
    // engine can decline to price what the spec never asked to buy.
    return (result.free || result.refused) ? result : null;
  }
}

module.exports = { FluxosDiscounter };
