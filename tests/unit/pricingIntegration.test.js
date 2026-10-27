'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

const priceOracleState = require('../../ZelBack/src/services/pricing/priceOracleState');
const specLibs = require('../../ZelBack/src/services/utils/specLibs');
const { buildPricingEngine } = require('../../ZelBack/src/services/pricing/buildPricingEngine');
const pricingRegime = require('../../ZelBack/src/services/pricing/pricingRegime');
const v9PricingRegime = require('../../ZelBack/src/services/pricing/v9PricingRegime');
const { nodeChain } = require('../../ZelBack/src/services/utils/nodeChain');

describe('pricing integration — chain messages through PricingEngine', () => {
  let PriceMessage, RateMessage, PriceModifierMessage, dispatch;
  let PriceMessageHistory, RateMessageHistory, PriceModifierHistory;
  let SOFT_FORK_EFFECTIVE_DEPTH;
  let PRICE_NOTICE_SECONDS;
  let convertMicrodollarsToSats;
  let meteredQuantities;
  let FluxAppSpecV9;

  before(async () => {
    ({
      PriceMessage, RateMessage, PriceModifierMessage, dispatch,
      PriceMessageHistory, RateMessageHistory, PriceModifierHistory,
      SOFT_FORK_EFFECTIVE_DEPTH,
      PRICE_NOTICE_SECONDS,
      convertMicrodollarsToSats,
      meteredQuantities,
      FluxAppSpecV9,
    } = await specLibs.getSpecPolicy());
  });

  afterEach(() => {
    sinon.restore();
  });

  // Realistic v9 spec shape (minimal canonical form)
  // A constructed spec, as the engine takes: one 0.5-core, 512 MB component with
  // 5 GB of storage, a 1 GB root filesystem and one standard port, on 3 instances.
  const testSubmission = {
    version: 9,
    name: 'testapp',
    description: 'pricing fixture',
    owner: '1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm',
    instances: 3,
    ttl: 2_592_000, // 30 days in seconds
    contacts: { email: ['test@example.com'] },
    components: {
      web: {
        name: 'web',
        image: 'nginx:latest',
        cpu: 0.5,
        memory: 512,
        rootFsGb: 1,
        persistentStorage: { sizeGb: 5, mounts: {} },
        ports: {
          http: { hostPort: 31_000, containerPort: 80 },
        },
      },
    },
  };

  function specOf(submission) {
    return FluxAppSpecV9.fromSubmission(structuredClone(submission));
  }

  let testSpec;
  before(() => {
    testSpec = specOf(testSubmission);
  });

  function buildTestHistories(opts = {}) {
    const chainHeight = opts.chainHeight || 100;
    const queryHeight = chainHeight + SOFT_FORK_EFFECTIVE_DEPTH;
    const blockTime = 1_700_000_000 + chainHeight * 30;
    // The first moment every message below counts at: an hour on, and deep enough.
    const at = { time: blockTime + PRICE_NOTICE_SECONDS, height: queryHeight };

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
    priceHistory.add(priceResult.message, chainHeight, 0, blockTime);

    // RateMessage: FLUX/USD oracle rate
    const fluxUsdPriceE4 = opts.fluxUsdPriceE4 || 577; // $0.0577
    const rateBytes = RateMessage.encode({ timestamp: Math.floor(Date.now() / 1000), fluxUsdPriceE4 });
    const rateResult = dispatch(rateBytes);

    const rateHistory = new RateMessageHistory();
    rateHistory.add(rateResult.message, chainHeight, 0, blockTime);

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
    modifierHistory.add(modifierResult.message, chainHeight, 0, blockTime);

    return {
      priceHistory, rateHistory, modifierHistory, queryHeight, at, priceFields,
    };
  }

  function stubHistories(histories) {
    sinon.stub(priceOracleState, 'getPriceMessageHistory').returns(histories.priceHistory);
    sinon.stub(priceOracleState, 'getRateMessageHistory').returns(histories.rateHistory);
    sinon.stub(priceOracleState, 'getPriceModifierHistory').returns(histories.modifierHistory);
    sinon.stub(priceOracleState, 'getOracleKeyHistory').returns(null);
  }

  describe('dispatch round-trip', () => {
    it('dispatches encoded PriceMessage to kind=price with parsed fields', () => {
      const bytes = PriceMessage.encode({ cpuRate: 150_000, memoryRate: 50_000 });
      const result = dispatch(bytes);
      expect(result.kind).to.equal('price');
      expect(result.message.fields.cpuRate).to.equal(150_000);
      expect(result.message.fields.memoryRate).to.equal(50_000);
    });

    it('dispatches encoded RateMessage to kind=rate with fluxUsdPriceE4', () => {
      const bytes = RateMessage.encode({ timestamp: 1_700_000_000, fluxUsdPriceE4: 577 });
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

      const engine = await buildPricingEngine(h.at);
      const breakdown = await engine.price(testSpec, { height: h.queryHeight, duration: testSpec.ttl, isEncrypted: false });

      // cpu: 0.5 core × 10 × 3 instances = 15 units × 150_000 = 2_250_000 microdollars
      expect(breakdown.commodity.cpu.units).to.equal(15);
      expect(breakdown.commodity.cpu.subtotal).to.equal(2_250_000);

      // memory: 512 MB × 3 instances = 1536 MB = 15.36 units of 100 MB × 50_000, pro rata
      expect(breakdown.commodity.memory.units).to.equal(15.36);
      expect(breakdown.commodity.memory.subtotal).to.equal(768_000);

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

      const engine = await buildPricingEngine(h.at);
      const breakdown = await engine.price(testSpec, { height: h.queryHeight, duration: testSpec.ttl, isEncrypted: false });

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

      const engine = await buildPricingEngine(h.at);
      const breakdown = await engine.price(testSpec, { height: h.queryHeight, duration: testSpec.ttl, isEncrypted: false });

      expect(breakdown.total).to.equal(100_000_000);
    });

    it('degrades gracefully when no oracle rate is available', async () => {
      const h = buildTestHistories();
      // Override: no rate history → fluxUsdPriceE4 will be null
      h.rateHistory = new RateMessageHistory();
      stubHistories(h);

      const engine = await buildPricingEngine(h.at);
      const breakdown = await engine.price(testSpec, { height: h.queryHeight, duration: testSpec.ttl, isEncrypted: false });

      expect(breakdown.fluxUsdPriceE4).to.be.null;
      expect(breakdown.total).to.equal(h.priceFields.minPriceFluxSats);
    });
  });

  describe('instance tier surcharges', () => {
    it('applies no surcharge for 3 instances (below tier 1 breakpoint of 10)', async () => {
      const h = buildTestHistories();
      stubHistories(h);

      const engine = await buildPricingEngine(h.at);
      const breakdown = await engine.price(testSpec, { height: h.queryHeight, duration: testSpec.ttl, isEncrypted: false });

      expect(breakdown.surcharges).to.have.lengthOf(0);
    });

    it('applies tier 1 surcharge for 10+ instances', async () => {
      const bigSpec = specOf({ ...testSubmission, instances: 12 });
      const h = buildTestHistories();
      stubHistories(h);

      const engine = await buildPricingEngine(h.at);
      const breakdown = await engine.price(bigSpec, { height: h.queryHeight, duration: bigSpec.ttl, isEncrypted: false });

      expect(breakdown.surcharges).to.have.lengthOf(1);
      expect(breakdown.surcharges[0].name).to.equal('instance-tier-1');
      expect(breakdown.adjustedMicrodollars).to.be.above(breakdown.grossMicrodollars);
    });
  });

  describe('duration bucket discounts', () => {
    it('applies no discount for 30-day duration (below 90-day bucket)', async () => {
      const h = buildTestHistories();
      stubHistories(h);

      const engine = await buildPricingEngine(h.at);
      const breakdown = await engine.price(testSpec, {
        height: h.queryHeight,
        duration: 2_592_000, // 30 days
        isEncrypted: false,
      });

      expect(breakdown.discounts).to.have.lengthOf(0);
    });

    it('applies 3% discount for 90-day duration', async () => {
      const h = buildTestHistories();
      stubHistories(h);

      const engine = await buildPricingEngine(h.at);
      const breakdown = await engine.price(testSpec, {
        height: h.queryHeight,
        duration: 7_776_000, // 90 days
        isEncrypted: false,
      });

      expect(breakdown.discounts).to.have.lengthOf(1);
      expect(breakdown.discounts[0].name).to.equal('duration-90d');
      expect(breakdown.discounts[0].value).to.equal(300);
    });

    it('applies 12% discount for 365-day duration', async () => {
      const h = buildTestHistories();
      stubHistories(h);

      const engine = await buildPricingEngine(h.at);
      const breakdown = await engine.price(testSpec, {
        height: h.queryHeight,
        duration: 31_536_000, // 365 days
        isEncrypted: false,
      });

      expect(breakdown.discounts).to.have.lengthOf(1);
      expect(breakdown.discounts[0].name).to.equal('duration-365d');
      expect(breakdown.discounts[0].value).to.equal(1200);
    });
  });

  describe('fiatMarkupBp', () => {
    it('resolves fiatMarkupBp from PriceModifierHistory', () => {
      const h = buildTestHistories();
      const resolved = h.modifierHistory.resolveAt(h.at);
      expect(resolved.fiatMarkupBp).to.equal(500);
    });

    it('defaults to 0 when no fiatMarkupBp is in the message', () => {
      const chainHeight = 100;
      const queryHeight = chainHeight + SOFT_FORK_EFFECTIVE_DEPTH;
      const bytes = PriceModifierMessage.encode({ durationBucket1DiscountBp: 300 });
      const result = dispatch(bytes);
      const history = new PriceModifierHistory();
      history.add(result.message, chainHeight, 0, 1_700_000_000);
      const resolved = history.resolveAt({ time: 1_700_000_000 + PRICE_NOTICE_SECONDS, height: queryHeight });
      expect(resolved.fiatMarkupBp || 0).to.equal(0);
    });
  });

  describe('end-to-end price sanity', () => {
    it('produces a price breakdown with all expected fields', async () => {
      const h = buildTestHistories();
      stubHistories(h);

      const engine = await buildPricingEngine(h.at);
      const breakdown = await engine.price(testSpec, { height: h.queryHeight, duration: testSpec.ttl, isEncrypted: false });

      expect(breakdown).to.have.all.keys(
        'commodity', 'features', 'surcharges', 'discounts',
        'grossMicrodollars', 'durationSeconds', 'standardPeriodSeconds',
        'scaledCommodityMicrodollars', 'scaledFeatureMicrodollars', 'scaledGrossMicrodollars',
        'preFloorMicrodollars',
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

      const stdSpec = testSpec;
      const premSubmission = structuredClone(testSubmission);
      premSubmission.components.web.ports = {
        https: { hostPort: 443, containerPort: 443 },
      };
      const premSpec = specOf(premSubmission);

      const engine = await buildPricingEngine(h.at);
      const stdBreakdown = await engine.price(stdSpec, { height: h.queryHeight, duration: stdSpec.ttl, isEncrypted: false });
      const premBreakdown = await engine.price(premSpec, { height: h.queryHeight, duration: premSpec.ttl, isEncrypted: false });

      expect(premBreakdown.commodity.ports.premium.count).to.equal(3);
      expect(premBreakdown.total).to.be.above(stdBreakdown.total);
    });
  });

  describe('duration scaling + update proration (new 0x02/0x04 tags)', () => {
    const ONE_PERIOD = 2_640_000;

    it('scales a registration by duration — a year costs more than a month', async () => {
      const h = buildTestHistories();
      stubHistories(h);
      const engine = await buildPricingEngine(h.at);
      const month = await engine.price(testSpec, { height: h.queryHeight, duration: ONE_PERIOD, isEncrypted: false });
      const year = await engine.price(testSpec, { height: h.queryHeight, duration: 31_536_000, isEncrypted: false });
      // Even with the 12% 365-day bucket discount, a year dwarfs a month.
      expect(year.total).to.be.above(month.total);
    });

    it('round-trips standardPeriodSeconds through the price message and scales by it', async () => {
      const h = buildTestHistories({ priceFields: { standardPeriodSeconds: ONE_PERIOD } });
      stubHistories(h);
      expect(h.priceHistory.resolveAt(h.at).standardPeriodSeconds).to.equal(ONE_PERIOD);

      const engine = await buildPricingEngine(h.at);
      const onePeriod = await engine.price(testSpec, { height: h.queryHeight, duration: ONE_PERIOD, isEncrypted: false });
      const twoPeriods = await engine.price(testSpec, { height: h.queryHeight, duration: ONE_PERIOD * 2, isEncrypted: false });
      expect(onePeriod.standardPeriodSeconds).to.equal(ONE_PERIOD);
      expect(onePeriod.scaledGrossMicrodollars).to.equal(onePeriod.grossMicrodollars);
      expect(twoPeriods.scaledGrossMicrodollars).to.equal(2 * onePeriod.scaledGrossMicrodollars);
    });

    it('round-trips updateDiscountBp through the modifier message (encode -> dispatch -> history)', async () => {
      // The proration math itself is covered exhaustively in spec-policy; here we
      // verify the new 0x04 tag survives the FluxOS chain-message pipeline so
      // computeUpdateFee can resolve it.
      const withDiscount = buildTestHistories({ modifierFields: { updateDiscountBp: 1000 } });
      expect(withDiscount.modifierHistory.resolveAt(withDiscount.at).updateDiscountBp).to.equal(1000);

      const without = buildTestHistories();
      expect(without.modifierHistory.resolveAt(without.at).updateDiscountBp).to.equal(undefined);
    });
  });

  describe('free-update feature delta through the FluxOS stack (became-encrypted)', () => {
    // The flux-spec rule is unit-tested with real specs; this exercises the
    // FluxOS wiring end-to-end through the real engine and the network's free-update rule:
    // priceUpdate derives the new feature set from the new breakdown, the caller
    // supplies the old set off the old breakdown, and turning encryption on
    // during an otherwise-identical update adds the encryptedSpec feature, so it
    // is no longer free.
    function realSpec() {
      return FluxAppSpecV9.fromSubmission({
        version: 9,
        name: 'encgapapp',
        description: 'fixture',
        owner: '1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm',
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
            ports: { tcp_80: { containerPort: 80, hostPort: 31_000, protocol: 'tcp' } },
          },
        },
      });
    }

    async function priceUpdateThroughStack(newIsEncrypted) {
      const h = buildTestHistories();
      stubHistories(h);
      const spec = realSpec();
      const engine = await buildPricingEngine(h.at);

      // Old breakdown priced with the old (cleartext) encryption bit, exactly as
      // computeUpdateFee does, to derive the metered quantities passed via ctx.
      const oldBreakdown = await engine.price(spec, {
        height: h.queryHeight, duration: spec.ttl, isEncrypted: false,
      });
      const oldMetered = meteredQuantities(oldBreakdown);

      return engine.priceUpdate(spec, spec, {
        height: h.queryHeight,
        duration: spec.ttl,
        asOf: Date.now(),
        recentEvents: [],
        oldScaledPriceMicrodollars: oldBreakdown.preFloorMicrodollars,
        oldMetered,
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
  describe('a v8 app updated to v9 is credited the unused share of its legacy term', () => {
    const CHAIN_HEIGHT = 3_000_000;

    function v9Spec() {
      return FluxAppSpecV9.fromSubmission({
        version: 9,
        name: 'upgradeapp',
        description: 'fixture',
        owner: '1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm',
        instances: 3,
        ttl: 2_592_000,
        contacts: { email: ['test@example.com'] },
        components: {
          web: {
            name: 'web',
            image: 'nginx:latest',
            cpu: 4,
            memory: 8000,
            swapGb: 2,
            rootFsGb: 2,
            persistentStorage: { sizeGb: 100, mounts: { '/data': { source: 'data', destination: '/data' } } },
            ports: { tcp_80: { containerPort: 80, hostPort: 31_000, protocol: 'tcp' } },
          },
        },
      });
    }

    async function v8Spec() {
      const { deserializeSpec } = await specLibs.getSpecBackend();
      return deserializeSpec({
        version: 8,
        name: 'upgradeapp',
        description: 'fixture',
        owner: '1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm',
        instances: 3,
        contacts: [],
        geolocation: [],
        expire: 88_000,
        nodes: [],
        staticip: false,
        compose: [{
          name: 'web',
          description: 'web',
          repotag: 'nginx:latest',
          ports: [31_000],
          domains: [''],
          environmentParameters: [],
          commands: [],
          containerPorts: [80],
          containerData: '/data',
          cpu: 4,
          ram: 8000,
          hdd: 100,
          tiered: false,
          secrets: '',
          repoauth: '',
        }],
      }, { chain: nodeChain() });
    }

    async function feeWithPredecessorAt(prevHeight) {
      const h = buildTestHistories({ chainHeight: CHAIN_HEIGHT });
      stubHistories(h);
      // The chain's legacy card (height 0, before any chain-params message).
      const card = {
        height: 0, cpu: 0.3, ram: 0.05, hdd: 0.01, port: 2, scope: 6, staticip: 3, minPrice: 0.01,
      };
      const legacyPricingRegime = proxyquire('../../ZelBack/src/services/pricing/legacyPricingRegime', {
        '../utils/chainUtilities': { getChainParamsPriceUpdates: async () => [card] },
      });
      const pricingRegime = proxyquire('../../ZelBack/src/services/pricing/pricingRegime', {
        './legacyPricingRegime': legacyPricingRegime,
      });
      // The v8 term started at its block's time, on the fixtures' 30-second blocks.
      const prevBlockTime = 1_700_000_000 + prevHeight * 30;
      return pricingRegime.updateFee(v9Spec(), await v8Spec(), {
        at: h.at,
        prevAt: { time: prevBlockTime, height: prevHeight },
        prevRegisteredAt: prevBlockTime,
        extend: false,
        recentEvents: async () => [],
      });
    }

    it('charges less while the v8 term has time left than once it is spent', async () => {
      const h = buildTestHistories({ chainHeight: CHAIN_HEIGHT });
      const spent = await feeWithPredecessorAt(h.queryHeight - 100_000);
      sinon.restore();
      const halfLeft = await feeWithPredecessorAt(h.queryHeight - 44_000);

      expect(spent).to.be.a('bigint');
      expect(halfLeft).to.be.a('bigint');
      expect(halfLeft > 0n, 'an upgrade is never free').to.equal(true);
      expect(halfLeft < spent, 'unused v8 time must reduce the fee').to.equal(true);
    });
  });

  describe('an update priced against itself cannot be charged', () => {
    function baseSpec(overrides = {}) {
      return FluxAppSpecV9.fromSubmission({
        version: 9,
        name: 'growapp',
        description: 'fixture',
        owner: '1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm',
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
            ports: { tcp_80: { containerPort: 80, hostPort: 31_000, protocol: 'tcp' } },
            ...overrides,
          },
        },
      });
    }

    // By default the predecessor's term is fully spent, so no unused-time
    // credit offsets the charge — the plainest case for the fee to be visible.
    async function priceGrowthAgainst(previous, { remainingSeconds = 0 } = {}) {
      const h = buildTestHistories();
      stubHistories(h);
      const grown = baseSpec({ cpu: 4 });
      const engine = await buildPricingEngine(h.at);
      const oldBreakdown = await engine.price(previous, {
        height: h.queryHeight, duration: previous.ttl, isEncrypted: false,
      });

      return engine.priceUpdate(previous, grown, {
        height: h.queryHeight,
        duration: grown.ttl,
        asOf: Date.now(),
        recentEvents: [],
        oldScaledPriceMicrodollars: oldBreakdown.preFloorMicrodollars,
        oldMetered: meteredQuantities(oldBreakdown),
        remainingSeconds,
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
      // with time left on the term: an update to an app whose term has ended
      // buys a new one and is never free
      const grown = baseSpec({ cpu: 4 });
      const result = await priceGrowthAgainst(grown, { remainingSeconds: grown.ttl });
      expect(result.free).to.equal(true);
      expect(result.total).to.be.undefined;
    });
  });

  // The guarantee a quote stands on: a v9 fee is fixed at its message's signed
  // time, so whichever block in the payment window confirms the payment charges
  // the same — even when a new FLUX/USD rate and a new price schedule are mined
  // inside that window.
  describe('every block in the payment window charges the fee quoted at the signed time', () => {
    const H0 = 2_000_000;
    const B0 = 1_760_000_000;
    const blockTime = (height) => B0 + (height - H0) * 30;
    const SIGNED = B0 + 2 * 3600; // two hours after the first messages' block
    const SIGNED_HEIGHT = H0 + 240;
    // Every block from the next one to an hour on.
    const windowHeights = Array.from({ length: 120 }, (_, i) => SIGNED_HEIGHT + 1 + i);

    function chainWithChangesInTheWindow() {
      const priceHistory = new PriceMessageHistory();
      const rateHistory = new RateMessageHistory();
      const modifierHistory = new PriceModifierHistory();
      const price = (fields) => dispatch(PriceMessage.encode(fields)).message;
      const rate = (fluxUsdPriceE4) => dispatch(RateMessage.encode({ timestamp: B0, fluxUsdPriceE4 })).message;
      priceHistory.add(price({
        cpuRate: 150_000, memoryRate: 50_000, storageRate: 20_000, minPrice: 990_000, minPriceFluxSats: 1_000_000,
      }), H0, 0, blockTime(H0));
      rateHistory.add(rate(577), H0, 1, blockTime(H0));
      modifierHistory.add(dispatch(PriceModifierMessage.encode({ updateDiscountBp: 1000 })).message, H0, 2, blockTime(H0));
      // Mined five and ten minutes after the signing: FLUX halves, and cpu doubles.
      rateHistory.add(rate(288), SIGNED_HEIGHT + 10, 0, blockTime(SIGNED_HEIGHT + 10));
      priceHistory.add(price({ cpuRate: 300_000 }), SIGNED_HEIGHT + 20, 0, blockTime(SIGNED_HEIGHT + 20));
      stubHistories({ priceHistory, rateHistory, modifierHistory });
    }

    const appSpec = (cpu) => specOf({
      ...testSubmission, components: { web: { ...testSubmission.components.web, cpu } },
    });

    it('charges one registration fee at every block of the window, and a later stamp the new rates', async () => {
      chainWithChangesInTheWindow();
      const spec = appSpec(0.5);

      const fees = await Promise.all(windowHeights.map(
        (height) => v9PricingRegime.registrationFee(spec, { time: SIGNED, height }),
      ));

      expect(new Set(fees.map(String)).size, 'one fee across the window').to.equal(1);
      expect(fees[0] > 0n).to.equal(true);
      // Canary: the changes do move the fee of a message stamped once they count.
      const later = await v9PricingRegime.registrationFee(spec, { time: blockTime(SIGNED_HEIGHT + 20) + 3600, height: SIGNED_HEIGHT + 200 });
      expect(later > fees[0], 'a message stamped after the changes count pays the new rates').to.equal(true);
    });

    it('charges one renewal fee at every block of the window, crediting the replaced term at the signed time', async () => {
      chainWithChangesInTheWindow();
      const spec = appSpec(0.5);
      const prevAt = { time: blockTime(H0 + 130), height: H0 + 130 };

      const fees = await Promise.all(windowHeights.map((height) => pricingRegime.updateFee(spec, spec, {
        at: { time: SIGNED, height },
        prevAt,
        prevRegisteredAt: prevAt.time,
        extend: true,
        recentEvents: async () => [],
      })));

      expect(new Set(fees.map(String)).size, 'one fee across the window').to.equal(1);
      expect(fees[0] > 0n, 'a renewal is never free').to.equal(true);
    });
  });
});
