process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');

const priceOracleState = require('../../ZelBack/src/services/pricing/priceOracleState');

describe('pricing integration — chain messages through PricingEngine', () => {
  let PriceMessage, RateMessage, PriceModifierMessage, dispatch;
  let PriceMessageHistory, RateMessageHistory, PriceModifierHistory;
  let MarketplacePricingMessage, MarketplacePricingHistory;
  let SOFT_FORK_EFFECTIVE_DEPTH;
  let buildPricingEngine, resolveMarketplacePricingCtx;
  let convertMicrodollarsToSats;
  let usedFeatureKeys;
  let FluxAppSpecV9;

  before(async () => {
    ({
      PriceMessage, RateMessage, PriceModifierMessage, dispatch,
      PriceMessageHistory, RateMessageHistory, PriceModifierHistory,
      MarketplacePricingMessage, MarketplacePricingHistory,
      SOFT_FORK_EFFECTIVE_DEPTH,
      convertMicrodollarsToSats,
      usedFeatureKeys,
    } = await import('@runonflux/flux-spec-policy'));
    ({ FluxAppSpecV9 } = await import('@runonflux/flux-spec'));
    ({ buildPricingEngine, resolveMarketplacePricingCtx } = require('../../ZelBack/src/services/pricing/buildPricingEngine'));
  });

  afterEach(() => {
    sinon.restore();
  });

  // Realistic v9 spec shape (minimal canonical form)
  const testSpec = {
    version: 9,
    name: 'testapp',
    instances: 3,
    ttl: 2592000, // 30 days in seconds
    placement: { staticIp: false, dataCenter: false, geoAllow: null, geoDeny: null },
    network: { mesh: false },
    telemetry: null,
    components: {
      web: {
        cpu: 0.5,
        memory: 512,
        rootFsGb: 1,
        swapGb: 0,
        persistentStorage: { sizeGb: 5, sync: null, mounts: {} },
        ports: {
          http: { hostPort: 31000, containerPort: 80, protocol: 'tcp' },
        },
        loadBalancing: null,
        shutdown: null,
        preStop: null,
        imageAuth: null,
      },
    },
  };

  function buildTestHistories(opts = {}) {
    const chainHeight = opts.chainHeight || 100;
    const queryHeight = chainHeight + SOFT_FORK_EFFECTIVE_DEPTH;

    // PriceMessage: commodity rates + feature fees (USD microdollars)
    const priceFields = {
      cpuRate: 150_000,          // $0.15 per 0.1 core per month
      memoryRate: 50_000,        // $0.05 per 100 MB per month
      storageRate: 20_000,       // $0.02 per GB per month
      stdPortRate: 0,
      premPortRate: 2_000_000,   // $2.00 per premium port per month
      staticIpRate: 2_000_000,   // $2.00 per static IP per month
      minPrice: 990_000,         // $0.99 USD floor (microdollars)
      minPriceFluxSats: 1_000_000, // 0.01 FLUX backstop (satoshis)
      ...(opts.priceFields || {}),
    };
    const priceBytes = PriceMessage.encode(priceFields);
    const priceResult = dispatch(priceBytes);

    const priceHistory = new PriceMessageHistory();
    priceHistory.add(priceResult.message, chainHeight);

    // RateMessage: FLUX/USD oracle rate
    const fluxUsdPriceE4 = opts.fluxUsdPriceE4 || 577; // $0.0577
    const rateBytes = RateMessage.encode({ timestamp: Math.floor(Date.now() / 1000), fluxUsdPriceE4 });
    const rateResult = dispatch(rateBytes);

    const rateHistory = new RateMessageHistory();
    rateHistory.add(rateResult.message, chainHeight);

    // PriceModifierMessage: duration discounts + instance surcharges
    const modifierFields = {
      durationBucket1MinSeconds: 7_776_000,  // 90 days
      durationBucket1DiscountBp: 300,
      durationBucket2MinSeconds: 15_552_000, // 180 days
      durationBucket2DiscountBp: 600,
      durationBucket3MinSeconds: 31_536_000, // 365 days
      durationBucket3DiscountBp: 1200,
      instanceTier1Breakpoint: 10,
      instanceTier1SurchargeBp: 500,  // 5% surcharge
      instanceTier2Breakpoint: 25,
      instanceTier2SurchargeBp: 1000,
      instanceTier3Breakpoint: 50,
      instanceTier3SurchargeBp: 1500,
      fiatMarkupBp: 500,
      ...(opts.modifierFields || {}),
    };
    const modifierBytes = PriceModifierMessage.encode(modifierFields);
    const modifierResult = dispatch(modifierBytes);

    const modifierHistory = new PriceModifierHistory();
    modifierHistory.add(modifierResult.message, chainHeight);

    return { priceHistory, rateHistory, modifierHistory, queryHeight, priceFields };
  }

  function stubHistories(histories) {
    sinon.stub(priceOracleState, 'getPriceMessageHistory').returns(histories.priceHistory);
    sinon.stub(priceOracleState, 'getRateMessageHistory').returns(histories.rateHistory);
    sinon.stub(priceOracleState, 'getPriceModifierHistory').returns(histories.modifierHistory);
    sinon.stub(priceOracleState, 'getOracleKeyHistory').returns(null);
    sinon.stub(priceOracleState, 'getMarketplacePricingHistory').returns(null);
  }

  describe('marketplace per-template multiplier (FluxOS resolver)', () => {
    const TEMPLATE_UUID = 'e96eccbb-6cf3-4631-aac4-4edfcacedcda';
    const templateUuidBytes = () => Buffer.from(TEMPLATE_UUID.replace(/-/g, ''), 'hex');

    function buildMarketplaceHistory(chainHeight, multiplier) {
      const bytes = MarketplacePricingMessage.encode({ templateUuid: templateUuidBytes(), multiplier });
      const result = dispatch(bytes);
      const history = new MarketplacePricingHistory();
      history.add(result.message, chainHeight);
      return history;
    }

    function buildGlobalDefaultHistory(chainHeight, multiplier) {
      const bytes = MarketplacePricingMessage.encode({ multiplier });
      const result = dispatch(bytes);
      const history = new MarketplacePricingHistory();
      history.add(result.message, chainHeight);
      return history;
    }

    it('resolves the per-template multiplier from MarketplacePricingHistory', () => {
      const chainHeight = 100;
      const queryHeight = chainHeight + SOFT_FORK_EFFECTIVE_DEPTH;
      sinon.stub(priceOracleState, 'getMarketplacePricingHistory').returns(buildMarketplaceHistory(chainHeight, 12000));

      const spec = { ...testSpec, marketplace: { templateId: TEMPLATE_UUID, templateVersion: 1, configId: null } };
      expect(resolveMarketplacePricingCtx(spec, queryHeight)).to.deep.equal({ marketplaceMultiplier: 12000 });
    });

    it('cascades to the global-default entry when no per-template message exists', () => {
      const chainHeight = 100;
      const queryHeight = chainHeight + SOFT_FORK_EFFECTIVE_DEPTH;
      sinon.stub(priceOracleState, 'getMarketplacePricingHistory').returns(buildGlobalDefaultHistory(chainHeight, 8000));

      const spec = { ...testSpec, marketplace: { templateId: TEMPLATE_UUID, templateVersion: 1, configId: null } };
      expect(resolveMarketplacePricingCtx(spec, queryHeight)).to.deep.equal({ marketplaceMultiplier: 8000 });
    });

    it('returns an empty fragment for a non-marketplace spec', () => {
      sinon.stub(priceOracleState, 'getMarketplacePricingHistory').returns(new MarketplacePricingHistory());
      const spec = { ...testSpec, marketplace: null };
      expect(resolveMarketplacePricingCtx(spec, 200)).to.deep.equal({});
    });

    it('returns an empty fragment when no entry matches the marketplace spec', () => {
      sinon.stub(priceOracleState, 'getMarketplacePricingHistory').returns(new MarketplacePricingHistory());
      const spec = { ...testSpec, marketplace: { templateId: TEMPLATE_UUID, templateVersion: 1, configId: null } };
      expect(resolveMarketplacePricingCtx(spec, 200)).to.deep.equal({});
    });
  });

  describe('dispatch round-trip', () => {
    it('dispatches encoded PriceMessage to kind=price with parsed fields', () => {
      const bytes = PriceMessage.encode({ cpuRate: 150_000, memoryRate: 50_000 });
      const result = dispatch(bytes);
      expect(result.kind).to.equal('price');
      expect(result.message.fields.cpuRate).to.equal(150_000);
      expect(result.message.fields.memoryRate).to.equal(50_000);
    });

    it('dispatches encoded RateMessage to kind=rate with fluxUsdPriceE4', () => {
      const bytes = RateMessage.encode({ timestamp: 1700000000, fluxUsdPriceE4: 577 });
      const result = dispatch(bytes);
      expect(result.kind).to.equal('rate');
      expect(result.message.fluxUsdPriceE4).to.equal(577);
    });

    it('dispatches encoded PriceModifierMessage to kind=price-modifier', () => {
      const bytes = PriceModifierMessage.encode({ durationBucket1MinSeconds: 7_776_000, durationBucket1DiscountBp: 300 });
      const result = dispatch(bytes);
      expect(result.kind).to.equal('price-modifier');
      expect(result.message.fields.durationBucket1MinSeconds).to.equal(7_776_000);
    });
  });

  describe('history → PricingEngine → price breakdown', () => {
    it('prices a minimal v9 spec with known commodity rates', async () => {
      const h = buildTestHistories();
      stubHistories(h);

      const engine = await buildPricingEngine(h.queryHeight);
      const breakdown = await engine.price(testSpec, { height: h.queryHeight, duration: testSpec.ttl });

      // cpu: 0.5 core × 10 × 3 instances = 15 units × 150_000 = 2_250_000 microdollars
      expect(breakdown.commodity.cpu.units).to.equal(15);
      expect(breakdown.commodity.cpu.subtotal).to.equal(2_250_000);

      // memory: 512 MB → Math.round(512/100) = 5 per instance × 3 = 15 units × 50_000
      expect(breakdown.commodity.memory.units).to.equal(15);
      expect(breakdown.commodity.memory.subtotal).to.equal(750_000);

      // storage: (sizeGb=5 + rootFsGb=1 + swapGb=0) × 3 instances = 18 units × 20_000
      expect(breakdown.commodity.storage.units).to.equal(18);
      expect(breakdown.commodity.storage.subtotal).to.equal(360_000);

      // port 31000 is standard (not premium), so no port fee
      expect(breakdown.commodity.ports.standard.count).to.equal(3);
      expect(breakdown.commodity.ports.premium.count).to.equal(0);

      // no features enabled on this spec
      expect(breakdown.features.subtotal).to.equal(0);

      expect(breakdown.total).to.be.a('number');
      expect(breakdown.total).to.be.above(0);
    });

    it('applies the minPrice microdollar floor to a cheap spec', async () => {
      // Set a high USD floor so it exceeds the commodity total.
      const h = buildTestHistories({ priceFields: { minPrice: 50_000_000 } }); // $50 floor
      stubHistories(h);

      const engine = await buildPricingEngine(h.queryHeight);
      const breakdown = await engine.price(testSpec, { height: h.queryHeight, duration: testSpec.ttl });

      expect(breakdown.adjustedMicrodollars).to.equal(50_000_000);
      expect(breakdown.adjustedMicrodollars).to.be.above(breakdown.grossMicrodollars);
      expect(breakdown.total).to.equal(
        convertMicrodollarsToSats(50_000_000, 577),
      );
    });

    it('applies the FLUX backstop when oracle produces too few sats', async () => {
      // FLUX at $1000 → commodity microdollars convert to very few sats.
      const h = buildTestHistories({
        priceFields: { minPriceFluxSats: 100_000_000 }, // 1 FLUX backstop
        fluxUsdPriceE4: 10_000_000, // $1000/FLUX
      });
      stubHistories(h);

      const engine = await buildPricingEngine(h.queryHeight);
      const breakdown = await engine.price(testSpec, { height: h.queryHeight, duration: testSpec.ttl });

      expect(breakdown.total).to.equal(100_000_000);
    });

    it('degrades gracefully when no oracle rate is available', async () => {
      const h = buildTestHistories();
      // Override: no rate history → fluxUsdPriceE4 will be null
      h.rateHistory = new RateMessageHistory();
      stubHistories(h);

      const engine = await buildPricingEngine(h.queryHeight);
      const breakdown = await engine.price(testSpec, { height: h.queryHeight, duration: testSpec.ttl });

      expect(breakdown.fluxUsdPriceE4).to.be.null;
      expect(breakdown.total).to.equal(h.priceFields.minPriceFluxSats);
    });
  });

  describe('FluxosSurcharger — instance tier surcharges', () => {
    it('applies no surcharge for 3 instances (below tier 1 breakpoint of 10)', async () => {
      const h = buildTestHistories();
      stubHistories(h);

      const engine = await buildPricingEngine(h.queryHeight);
      const breakdown = await engine.price(testSpec, { height: h.queryHeight, duration: testSpec.ttl });

      expect(breakdown.surcharges).to.have.lengthOf(0);
    });

    it('applies tier 1 surcharge for 10+ instances', async () => {
      const bigSpec = { ...testSpec, instances: 12 };
      const h = buildTestHistories();
      stubHistories(h);

      const engine = await buildPricingEngine(h.queryHeight);
      const breakdown = await engine.price(bigSpec, { height: h.queryHeight, duration: bigSpec.ttl });

      expect(breakdown.surcharges).to.have.lengthOf(1);
      expect(breakdown.surcharges[0].label).to.equal('instance-tier-1');
      expect(breakdown.adjustedMicrodollars).to.be.above(breakdown.grossMicrodollars);
    });
  });

  describe('FluxosDiscounter — duration bucket discounts', () => {
    it('applies no discount for 30-day duration (below 90-day bucket)', async () => {
      const h = buildTestHistories();
      stubHistories(h);

      const engine = await buildPricingEngine(h.queryHeight);
      const breakdown = await engine.price(testSpec, {
        height: h.queryHeight,
        duration: 2_592_000, // 30 days
      });

      expect(breakdown.discounts).to.have.lengthOf(0);
    });

    it('applies 3% discount for 90-day duration', async () => {
      const h = buildTestHistories();
      stubHistories(h);

      const engine = await buildPricingEngine(h.queryHeight);
      const breakdown = await engine.price(testSpec, {
        height: h.queryHeight,
        duration: 7_776_000, // 90 days
      });

      expect(breakdown.discounts).to.have.lengthOf(1);
      expect(breakdown.discounts[0].label).to.equal('duration-90d');
      expect(breakdown.discounts[0].value).to.equal(300);
    });

    it('applies 12% discount for 365-day duration', async () => {
      const h = buildTestHistories();
      stubHistories(h);

      const engine = await buildPricingEngine(h.queryHeight);
      const breakdown = await engine.price(testSpec, {
        height: h.queryHeight,
        duration: 31_536_000, // 365 days
      });

      expect(breakdown.discounts).to.have.lengthOf(1);
      expect(breakdown.discounts[0].label).to.equal('duration-365d');
      expect(breakdown.discounts[0].value).to.equal(1200);
    });
  });

  describe('fiatMarkupBp', () => {
    it('resolves fiatMarkupBp from PriceModifierHistory', () => {
      const h = buildTestHistories();
      const resolved = h.modifierHistory.resolveAt(h.queryHeight);
      expect(resolved.fiatMarkupBp).to.equal(500);
    });

    it('defaults to 0 when no fiatMarkupBp is in the message', () => {
      const chainHeight = 100;
      const queryHeight = chainHeight + SOFT_FORK_EFFECTIVE_DEPTH;
      const bytes = PriceModifierMessage.encode({ durationBucket1DiscountBp: 300 });
      const result = dispatch(bytes);
      const history = new PriceModifierHistory();
      history.add(result.message, chainHeight);
      const resolved = history.resolveAt(queryHeight);
      expect(resolved.fiatMarkupBp || 0).to.equal(0);
    });
  });

  describe('end-to-end price sanity', () => {
    it('produces a price breakdown with all expected fields', async () => {
      const h = buildTestHistories();
      stubHistories(h);

      const engine = await buildPricingEngine(h.queryHeight);
      const breakdown = await engine.price(testSpec, { height: h.queryHeight, duration: testSpec.ttl });

      expect(breakdown).to.have.all.keys(
        'commodity', 'features', 'surcharges', 'discounts',
        'grossMicrodollars', 'durationSeconds', 'standardPeriodSeconds',
        'scaledCommodityMicrodollars', 'scaledFeatureMicrodollars', 'scaledGrossMicrodollars',
        'marketplaceMultiplier', 'marketplaceFixedPriceMicrodollars',
        'marketplaceAdjustedMicrodollars',
        'adjustedMicrodollars', 'minPriceMicrodollars',
        'total', 'minPriceFluxSats',
        'fluxUsdPriceE4', 'ratesHeight',
      );

      expect(breakdown.grossMicrodollars).to.equal(breakdown.commodity.subtotal + breakdown.features.subtotal);
      expect(breakdown.total).to.be.above(0);
      expect(breakdown.fluxUsdPriceE4).to.equal(577);
      expect(breakdown.ratesHeight).to.equal(h.queryHeight);
    });

    it('prices a premium-port spec higher than a standard-port spec', async () => {
      const h = buildTestHistories();
      stubHistories(h);

      const stdSpec = { ...testSpec };
      const premSpec = JSON.parse(JSON.stringify(testSpec));
      premSpec.components.web.ports = {
        https: { hostPort: 443, containerPort: 443, protocol: 'tcp' },
      };

      const engine = await buildPricingEngine(h.queryHeight);
      const stdBreakdown = await engine.price(stdSpec, { height: h.queryHeight, duration: stdSpec.ttl });
      const premBreakdown = await engine.price(premSpec, { height: h.queryHeight, duration: premSpec.ttl });

      expect(premBreakdown.commodity.ports.premium.count).to.equal(3);
      expect(premBreakdown.total).to.be.above(stdBreakdown.total);
    });
  });

  describe('duration scaling + update proration (new 0x02/0x04 tags)', () => {
    const ONE_PERIOD = 2_640_000;

    it('scales a registration by duration — a year costs more than a month', async () => {
      const h = buildTestHistories();
      stubHistories(h);
      const engine = await buildPricingEngine(h.queryHeight);
      const month = await engine.price(testSpec, { height: h.queryHeight, duration: ONE_PERIOD });
      const year = await engine.price(testSpec, { height: h.queryHeight, duration: 31_536_000 });
      // Even with the 12% 365-day bucket discount, a year dwarfs a month.
      expect(year.total).to.be.above(month.total);
    });

    it('round-trips standardPeriodSeconds through the price message and scales by it', async () => {
      const h = buildTestHistories({ priceFields: { standardPeriodSeconds: ONE_PERIOD } });
      stubHistories(h);
      expect(h.priceHistory.resolveAt(h.queryHeight).standardPeriodSeconds).to.equal(ONE_PERIOD);

      const engine = await buildPricingEngine(h.queryHeight);
      const onePeriod = await engine.price(testSpec, { height: h.queryHeight, duration: ONE_PERIOD });
      const twoPeriods = await engine.price(testSpec, { height: h.queryHeight, duration: ONE_PERIOD * 2 });
      expect(onePeriod.standardPeriodSeconds).to.equal(ONE_PERIOD);
      expect(onePeriod.scaledGrossMicrodollars).to.equal(onePeriod.grossMicrodollars);
      expect(twoPeriods.scaledGrossMicrodollars).to.equal(2 * onePeriod.scaledGrossMicrodollars);
    });

    it('round-trips updateDiscountBp through the modifier message (encode -> dispatch -> history)', async () => {
      // The proration math itself is covered exhaustively in spec-policy; here we
      // verify the new 0x04 tag survives the FluxOS chain-message pipeline so
      // computeUpdateFee can resolve it.
      const withDiscount = buildTestHistories({ modifierFields: { updateDiscountBp: 1000 } });
      expect(withDiscount.modifierHistory.resolveAt(withDiscount.queryHeight).updateDiscountBp).to.equal(1000);

      const without = buildTestHistories();
      expect(without.modifierHistory.resolveAt(without.queryHeight).updateDiscountBp).to.equal(undefined);
    });
  });

  describe('free-update feature delta through the FluxOS stack (became-encrypted)', () => {
    // The flux-spec rule is unit-tested with real specs; this exercises the
    // FluxOS wiring end-to-end through the real engine + FluxosDiscounter:
    // priceUpdate derives the new feature set from the new breakdown, the caller
    // supplies the old set off the old breakdown, and turning encryption on
    // during an otherwise-identical update adds the encryptedSpec feature, so it
    // is no longer free.
    function realSpec() {
      return FluxAppSpecV9.fromSubmission({
        version: 9,
        name: 'encgapapp',
        description: 'fixture',
        owner: '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1',
        instances: 3,
        ttl: 2_592_000,
        contacts: { email: ['test@example.com'] },
        components: {
          web: {
            name: 'web',
            image: 'nginx:latest',
            cpu: 1,
            memory: 1000,
            swapGb: 2,
            rootFsGb: 2,
            persistentStorage: { sizeGb: 10, mounts: { '/data': { source: 'data', destination: '/data' } } },
            ports: { tcp_80: { containerPort: 80, hostPort: 31000, protocol: 'tcp' } },
          },
        },
      });
    }

    async function priceUpdateThroughStack(newIsEncrypted) {
      const h = buildTestHistories();
      stubHistories(h);
      const spec = realSpec();
      const engine = await buildPricingEngine(h.queryHeight);

      // Old breakdown priced with the old (cleartext) encryption bit, exactly as
      // computeUpdateFee does, to derive the old feature set passed via ctx.
      const oldBreakdown = await engine.price(spec, {
        height: h.queryHeight, duration: spec.ttl, isEncrypted: false,
      });
      const oldFeatures = usedFeatureKeys(oldBreakdown.features);

      return engine.priceUpdate(spec, spec, {
        height: h.queryHeight,
        duration: spec.ttl,
        now: Date.now(),
        recentEvents: [],
        oldScaledPriceMicrodollars: oldBreakdown.marketplaceAdjustedMicrodollars,
        oldFeatures,
        remainingSeconds: spec.ttl,
        oldTtl: spec.ttl,
        isEncrypted: newIsEncrypted,
      });
    }

    it('keeps an identical cleartext update free', async () => {
      const result = await priceUpdateThroughStack(false);
      expect(result.free).to.equal(true);
    });

    it('charges when the update turns encryption on (encryptedSpec added)', async () => {
      const result = await priceUpdateThroughStack(true);
      expect(result.free).to.not.equal(true);
      expect(result.total).to.be.above(0);
    });
  });

  // Every rule in the free-update policy compares the old spec against the new
  // one, so handing it one spec twice answers "nothing changed" by
  // construction. The promotion path did exactly that — it resolved the
  // superseded message after storing the message being promoted, and got that
  // message back — which made every v9 update free, however much it grew.
  //
  // These price the same growth both ways. The contrast is the point: what the
  // fee is computed against decides whether there is a fee at all.
  describe('an update priced against itself cannot be charged', () => {
    function baseSpec(overrides = {}) {
      return FluxAppSpecV9.fromSubmission({
        version: 9,
        name: 'growapp',
        description: 'fixture',
        owner: '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1',
        instances: 3,
        ttl: 2_592_000,
        contacts: { email: ['test@example.com'] },
        components: {
          web: {
            name: 'web',
            image: 'nginx:latest',
            cpu: 1,
            memory: 1000,
            swapGb: 2,
            rootFsGb: 2,
            persistentStorage: { sizeGb: 10, mounts: { '/data': { source: 'data', destination: '/data' } } },
            ports: { tcp_80: { containerPort: 80, hostPort: 31000, protocol: 'tcp' } },
            ...overrides,
          },
        },
      });
    }

    // The predecessor's term is fully spent, so no unused-time credit offsets
    // the charge — the plainest case for the fee to be visible.
    async function priceGrowthAgainst(previous) {
      const h = buildTestHistories();
      stubHistories(h);
      const grown = baseSpec({ cpu: 4 });
      const engine = await buildPricingEngine(h.queryHeight);
      const oldBreakdown = await engine.price(previous, {
        height: h.queryHeight, duration: previous.ttl, isEncrypted: false,
      });

      return engine.priceUpdate(previous, grown, {
        height: h.queryHeight,
        duration: grown.ttl,
        now: Date.now(),
        recentEvents: [],
        oldScaledPriceMicrodollars: oldBreakdown.marketplaceAdjustedMicrodollars,
        oldFeatures: usedFeatureKeys(oldBreakdown.features),
        remainingSeconds: 0,
        oldTtl: previous.ttl,
        isEncrypted: false,
      });
    }

    it('charges a quadrupled cpu when priced against the spec it supersedes', async () => {
      const result = await priceGrowthAgainst(baseSpec());
      expect(result.free).to.not.equal(true);
      expect(result.total).to.be.above(0);
    });

    it('rules that same growth free when the predecessor is the update itself', async () => {
      const grown = baseSpec({ cpu: 4 });
      const result = await priceGrowthAgainst(grown);
      expect(result.free).to.equal(true);
      expect(result.total).to.be.undefined;
    });
  });
});
