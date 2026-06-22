const priceOracleState = require('./priceOracleState');

class FluxosSurcharger {
  async surcharges(spec, _partial, ctx) {
    const history = priceOracleState.getPriceModifierHistory();
    if (!history) return [];
    const params = history.resolveAt(ctx.height);
    if (!params) return [];

    const instances = typeof spec.instances === 'number' ? spec.instances : 1;
    const entries = [];

    // Targets commodity (not total): only resource cost scales with instances;
    // feature fees are flat per spec, so an instance-count surcharge skips them.
    if (params.instanceTier3Breakpoint && instances >= params.instanceTier3Breakpoint) {
      entries.push({ type: 'basisPoints', value: params.instanceTier3SurchargeBp, label: 'instance-tier-3', target: 'commodity' });
    } else if (params.instanceTier2Breakpoint && instances >= params.instanceTier2Breakpoint) {
      entries.push({ type: 'basisPoints', value: params.instanceTier2SurchargeBp, label: 'instance-tier-2', target: 'commodity' });
    } else if (params.instanceTier1Breakpoint && instances >= params.instanceTier1Breakpoint) {
      entries.push({ type: 'basisPoints', value: params.instanceTier1SurchargeBp, label: 'instance-tier-1', target: 'commodity' });
    }

    return entries;
  }
}

module.exports = { FluxosSurcharger };
