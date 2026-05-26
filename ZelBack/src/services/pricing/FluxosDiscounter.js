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
      entries.push({ type: 'percent', value: params.durationBucket3DiscountPct, label: 'duration-365d', target: 'total' });
    } else if (params.durationBucket2MinSeconds && duration >= params.durationBucket2MinSeconds) {
      entries.push({ type: 'percent', value: params.durationBucket2DiscountPct, label: 'duration-180d', target: 'total' });
    } else if (params.durationBucket1MinSeconds && duration >= params.durationBucket1MinSeconds) {
      entries.push({ type: 'percent', value: params.durationBucket1DiscountPct, label: 'duration-90d', target: 'total' });
    }

    return entries;
  }

  async checkFreeUpdate(oldSpec, newSpec, ctx) {
    const { checkFreeUpdate } = await require('../utils/specLibs').getSpecPolicy();
    return checkFreeUpdate({
      oldSpec,
      newSpec,
      featureFees: ctx.featureFees || {},
      recentEvents: ctx.recentEvents || [],
      now: ctx.now || Date.now(),
    });
  }
}

module.exports = { FluxosDiscounter };
