'use strict';

// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const { load } = require('@runonflux/flux-spec-cjs');

const legacyRegime = require('../../ZelBack/src/services/pricing/legacyPricingRegime');
const { regimeFor } = require('../../ZelBack/src/services/pricing/pricingRegime');
const legacyPricingRegime = require('../../ZelBack/src/services/pricing/legacyPricingRegime');
const v9PricingRegime = require('../../ZelBack/src/services/pricing/v9PricingRegime');
const cacheManager = require('../../ZelBack/src/services/utils/cacheManager').default;
const { v8Spec } = require('./fixtures/fluxSpec');
const config = require('config');
const specLibs = require('../../ZelBack/src/services/utils/specLibs');

let PricingModel;
before(async () => {
  ({ PricingModel } = await load());
});

describe('pricingRegime', () => {
  afterEach(() => {
    sinon.restore();
  });

  // Where a declared pricing model meets its implementation. Nothing in the
  // pricing path reads a spec version; a spec states its model and this
  // resolves it.
  describe('regimeFor — a declared pricing model resolves to its implementation', () => {

    it('resolves the chain-floor model to the legacy regime', async () => {
      const regime = await regimeFor({ pricingModel: PricingModel.CHAIN_FLOOR });
      expect(regime).to.equal(legacyPricingRegime);
    });

    it('resolves the unified model to the v9 regime', async () => {
      const regime = await regimeFor({ pricingModel: PricingModel.UNIFIED });
      expect(regime).to.equal(v9PricingRegime);
    });

    // A generation whose economics nobody has implemented must stop, not be
    // priced under whichever model happens to be first or default. Falling back
    // would charge an app under rules it was never issued under.
    it('refuses a model no regime implements rather than falling back', async () => {
      let error;
      await regimeFor({ pricingModel: 'someFutureModel' }).catch((err) => { error = err; });
      expect(error).to.be.an('error');
      expect(error.message).to.include('someFutureModel');
    });

    it('refuses a spec that declares no model at all', async () => {
      let error;
      await regimeFor({ version: 9 }).catch((err) => { error = err; });
      expect(error).to.be.an('error');
    });

    it('implements every model flux-spec declares', async () => {
      for (const model of Object.values(PricingModel)) {
        // eslint-disable-next-line no-await-in-loop
        expect(await regimeFor({ pricingModel: model })).to.be.an('object');
      }
    });

    it('exposes the same seven operations on both regimes', () => {
      const ops = ['onChainDisplayPrice', 'fiatAndFluxDisplayPrice', 'pricedAt', 'registrationFee', 'termCost', 'updateFee', 'entitlementRefusal'];
      for (const op of ops) {
        expect(legacyPricingRegime[op], `legacy.${op}`).to.be.a('function');
        expect(v9PricingRegime[op], `v9.${op}`).to.be.a('function');
      }
    });
  });

  describe('v9 updateFee prices against its predecessor at the update\'s moment', () => {
    const HEIGHT = 2_000_000;
    const BLOCK_TIME = 1_750_000_000;
    const events = [{ hash: 'earlier', height: HEIGHT - 5, type: 'fluxappupdate' }];
    const spec = { name: 'myapp', ttl: 2_592_000, isEncrypted: false };

    function loadV9() {
      const priceUpdate = sinon.stub().resolves({ free: true });
      const buildPricingEngine = sinon.stub().resolves({ priceUpdate });
      const v9 = proxyquire('../../ZelBack/src/services/pricing/v9PricingRegime', {
        './buildPricingEngine': { buildPricingEngine },
      });
      return { v9, priceUpdate, buildPricingEngine };
    }

    async function contextHandedToTheRule({ extend = false } = {}) {
      const { v9, priceUpdate } = loadV9();
      const prevSpec = { termSeconds: sinon.stub().returns(7000), remainingSecondsAt: sinon.stub().returns(3000) };
      await v9.updateFee(spec, prevSpec, {
        at: { time: BLOCK_TIME, height: HEIGHT },
        prevAt: { time: BLOCK_TIME - 3700, height: HEIGHT - 5 },
        prevRegisteredAt: BLOCK_TIME - 3600,
        extend,
        recentEvents: async () => events,
        prevTermCost: { oldTermPriceFluxSats: 42 },
      });
      return { ctx: priceUpdate.firstCall.args[2], prevSpec };
    }

    it('hands the rule the update\'s signed time, not the clock of the node reading it', async () => {
      const { ctx } = await contextHandedToTheRule();
      expect(ctx.asOf).to.equal(BLOCK_TIME * 1000);
    });

    it('hands the rule the events its caller answers', async () => {
      const { ctx } = await contextHandedToTheRule();
      expect(ctx.recentEvents).to.equal(events);
    });

    it('reads the predecessor\'s term through its accessors, credited at the update\'s signed time', async () => {
      const { ctx, prevSpec } = await contextHandedToTheRule();
      const prevState = { height: HEIGHT - 5, registeredAt: BLOCK_TIME - 3600 };
      expect(ctx.oldTtl).to.equal(7000);
      expect(ctx.remainingSeconds).to.equal(3000);
      sinon.assert.calledWithExactly(prevSpec.termSeconds, prevState);
      sinon.assert.calledWithExactly(prevSpec.remainingSecondsAt, prevState, BLOCK_TIME);
    });

    it('credits the term cost its predecessor\'s regime gave, in that regime\'s unit', async () => {
      const { ctx } = await contextHandedToTheRule();
      expect(ctx.oldTermPriceFluxSats).to.equal(42);
      expect(ctx).to.not.have.property('oldScaledPriceMicrodollars');
    });

    it('prices with the engine in force at the update\'s moment, which carries the update discount', async () => {
      const { v9, priceUpdate, buildPricingEngine } = loadV9();
      const prevSpec = { termSeconds: () => 7000, remainingSecondsAt: () => 3000 };
      const at = { time: BLOCK_TIME, height: HEIGHT };
      await v9.updateFee(spec, prevSpec, {
        at, prevAt: { time: BLOCK_TIME - 3700, height: HEIGHT - 5 }, prevRegisteredAt: BLOCK_TIME - 3600, extend: false, recentEvents: async () => [], prevTermCost: {},
      });
      sinon.assert.calledWithExactly(buildPricingEngine, at);
      expect(priceUpdate.firstCall.args[2]).to.not.have.property('updateDiscountBp');
    });

    it('hands the rule the event\'s renewal flag', async () => {
      expect((await contextHandedToTheRule({ extend: true })).ctx.extend).to.equal(true);
      expect((await contextHandedToTheRule({ extend: false })).ctx.extend).to.equal(false);
    });
  });

  describe('v9 entitlementRefusal', () => {
    const OWNER = '1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm';

    function loadWith(entitlements) {
      return proxyquire('../../ZelBack/src/services/pricing/v9PricingRegime', {
        '../entitlementsState': { getFeatureEntitlements: () => entitlements },
      });
    }

    it('answers the check for the spec owner, at the height, with the spec encryption', async () => {
      const check = sinon.stub().returns({ allowed: false, reason: 'fluxid not entitled to use: mesh' });
      const spec = { owner: OWNER, isEncrypted: true };
      const reason = await loadWith({ check }).entitlementRefusal(spec, 1234);
      expect(reason).to.equal('fluxid not entitled to use: mesh');
      const [fluxid, checked, height, isEncrypted] = check.firstCall.args;
      expect(fluxid).to.be.instanceOf(Uint8Array);
      expect(checked).to.equal(spec);
      expect(height).to.equal(1234);
      expect(isEncrypted).to.equal(true);
    });

    it('answers null for an owner entitled to what the spec uses', async () => {
      const check = sinon.stub().returns({ allowed: true });
      expect(await loadWith({ check }).entitlementRefusal({ owner: OWNER, isEncrypted: false }, 1)).to.equal(null);
    });

    it('refuses an owner no policy group can name', async () => {
      const check = sinon.stub().returns({ allowed: true });
      const reason = await loadWith({ check }).entitlementRefusal({ owner: 'not-an-address', isEncrypted: false }, 1);
      expect(reason).to.match(/not a fluxid/);
      sinon.assert.notCalled(check);
    });

    it('cannot answer before the policy-group history is built', async () => {
      let thrown = null;
      try { await loadWith(null).entitlementRefusal({ owner: OWNER, isEncrypted: false }, 1); } catch (error) { thrown = error; }
      expect(thrown).to.be.an('error');
    });
  });

  describe('v9 pricedAt', () => {
    const MINED = 1000;
    const MINED_TIME = 1_750_000_000;

    async function loadWith(priceMessages) {
      const { PriceMessageHistory, PRICE_NOTICE_SECONDS } = await specLibs.getSpecPolicy();
      let history = null;
      if (priceMessages) {
        history = new PriceMessageHistory();
        priceMessages.forEach((fields, i) => history.add({ fields }, MINED, i, MINED_TIME));
      }
      const regime = proxyquire('../../ZelBack/src/services/pricing/v9PricingRegime', {
        './priceOracleState': { getPriceMessageHistory: () => history },
      });
      // Well past the depth: the hour decides.
      return { regime, inForce: { time: MINED_TIME + PRICE_NOTICE_SECONDS, height: MINED + 200 } };
    }

    it('is false at a moment no price message is in force at', async () => {
      const { regime, inForce } = await loadWith([]);
      expect(await regime.pricedAt(inForce)).to.equal(false);
    });

    it('is false before a mined price message counts, and true from then on', async () => {
      const { regime, inForce } = await loadWith([{ minPrice: 1_000_000 }]);
      expect(await regime.pricedAt({ ...inForce, time: inForce.time - 1 })).to.equal(false);
      expect(await regime.pricedAt(inForce)).to.equal(true);
    });

    it('cannot answer before the price message history is built', async () => {
      const { regime, inForce } = await loadWith(null);
      let thrown = null;
      try { await regime.pricedAt(inForce); } catch (error) { thrown = error; }
      expect(thrown).to.be.an('error');
    });
  });

  it('a v1-v8 spec is priced at every height', async () => {
    expect(await legacyRegime.pricedAt(0)).to.equal(true);
  });

  it('legacy owners are entitled to everything a v1-v8 spec can use', async () => {
    expect(await legacyRegime.entitlementRefusal({ owner: 'x' }, 1)).to.equal(null);
  });

  describe('messageQuote quotes only a message whose fee is fixed at its signed time', () => {
    async function load() {
      const legacy = { termCost: sinon.stub() };
      const v9 = { termCost: sinon.stub(), messageQuote: sinon.stub().resolves({ fee: 1n }) };
      const regime = proxyquire('../../ZelBack/src/services/pricing/pricingRegime', {
        './legacyPricingRegime': legacy,
        './v9PricingRegime': v9,
      });
      const { PricingModel } = await specLibs.getSpec();
      return { regime, v9, PricingModel };
    }

    it('asks the v9 regime, handing it how a predecessor\'s term cost is read', async () => {
      const { regime, v9, PricingModel } = await load();
      const spec = { pricingModel: PricingModel.UNIFIED, version: 9 };
      const message = { timestamp: 1, extend: false };
      expect(await regime.messageQuote(spec, message)).to.deep.equal({ fee: 1n });
      sinon.assert.calledOnceWithExactly(v9.messageQuote, spec, sinon.match({ termCost: regime.termCost }), message);
    });

    it('refuses a v1-v8 spec by name', async () => {
      const { regime, PricingModel } = await load();
      const error = await regime.messageQuote({ pricingModel: PricingModel.CHAIN_FLOOR, version: 8 }, {}).catch((e) => e);
      expect(error.name).to.equal('NotQuotable');
    });
  });

  describe('updateFee asks the predecessor\'s regime what its term cost', () => {
    it('hands the update\'s regime the cost the predecessor\'s regime answered', async () => {
      const cost = { oldTermPriceFluxSats: 123 };
      const legacy = { termCost: sinon.stub().resolves(cost), updateFee: sinon.stub() };
      const v9 = { termCost: sinon.stub(), updateFee: sinon.stub().resolves(5n) };
      const regime = proxyquire('../../ZelBack/src/services/pricing/pricingRegime', {
        './legacyPricingRegime': legacy,
        './v9PricingRegime': v9,
      });
      const { PricingModel } = await specLibs.getSpec();
      const prevSpec = { pricingModel: PricingModel.CHAIN_FLOOR };
      const spec = { pricingModel: PricingModel.UNIFIED };

      const ctx = { at: { time: 2000, height: 10 }, prevAt: { time: 1000, height: 4 } };
      const fee = await regime.updateFee(spec, prevSpec, ctx);

      expect(fee).to.equal(5n);
      sinon.assert.calledOnceWithExactly(legacy.termCost, prevSpec, ctx.prevAt);
      sinon.assert.notCalled(v9.termCost);
      sinon.assert.calledOnceWithExactly(v9.updateFee, spec, prevSpec, { ...ctx, prevTermCost: cost });
    });
  });

  // The marketplace list carries the per-template price multiplier, so a quote
  // taken without it undercharges a marketplace app and says nothing. The list
  // comes from the operator's stats server, which can be slow or unreachable.
  describe('the marketplace multiplier survives a stats server that stops answering', () => {
    const TEMPLATES = [{ name: 'myapp', multiplier: 2 }];
    const MARKETPLACE_NAME = 'myapp1735018430692';
    const HEIGHT = 1_800_000;
    const CACHE_KEY = 'list';


    let spec;
    let ordinarySpec;
    let marketplaceReply;

    before(async function loadFixtures() {
      this.timeout(30_000);
      spec = await v8Spec({ name: MARKETPLACE_NAME });
      ordinarySpec = await v8Spec();
    });

    beforeEach(() => {
      cacheManager.marketplaceAppsCache.clear();
      cacheManager.appPriceBlockedRepoCache.clear();
      cacheManager.fluxRatesCache.clear();
    });

    function succeeds() {
      return Promise.resolve({ data: { status: 'success', data: TEMPLATES } });
    }

    function fails() {
      return Promise.reject(new Error('stats server unreachable'));
    }

    /** The regime with only its outbound calls replaced. */
    function loadRegime() {
      const get = sinon.stub();
      get.withArgs(sinon.match('getappspecsusdprice')).resolves(
        { data: { status: 'success', data: config.get('fluxapps.usdprice') } },
      );
      get.withArgs(sinon.match('/rates')).resolves(
        { data: [[{ code: 'USD', rate: 1 }], { FLUX: 0.5 }] },
      );
      get.withArgs(sinon.match('/marketplace/listapps')).callsFake(
        function marketplaceCall() { return marketplaceReply(); },
      );

      const regime = proxyquire('../../ZelBack/src/services/pricing/legacyPricingRegime', {
        axios: { get },
        '../dbHelper': {
          databaseConnection: () => ({ db: () => ({}) }),
          findOneInDatabase: sinon.stub().resolves(null),
        },
        '../daemonService/daemonStatus': {
          daemonSyncState: () => ({ synced: true, height: HEIGHT }),
        },
        '../appDatabase/appRecords': { registry: () => ({ byName: sinon.stub().resolves(null) }) },
        '../appDatabase/appsRepository': {
          listAppMessagesByName: sinon.stub().resolves([]),
          getPreviousPermanentMessage: sinon.stub().resolves(null),
        },
        '../utils/chainUtilities': {
          getChainParamsPriceUpdates: sinon.stub().resolves(config.get('fluxapps.price')),
        },
        '../utils/specCutover': {
          resolveSpec: sinon.stub().resolves(null),
          resolveRegisteredSpec: sinon.stub().resolves(null),
        },
      });
      return { regime, get };
    }

    const quote = (regime, subject = spec) => regime.fiatAndFluxDisplayPrice(subject, {});
    const marketplaceCalls = (get) => get.args.filter(
      ([url]) => url.includes('/marketplace/listapps'),
    ).length;

    // The multiplier has to be visible in the quote before any of this means
    // anything: if the USD floor swallowed it, every assertion below would pass
    // on a number the multiplier never touched.
    it('prices a marketplace app above the same app without a template', async () => {
      marketplaceReply = succeeds;
      const withTemplate = await quote(loadRegime().regime);

      cacheManager.marketplaceAppsCache.clear();
      marketplaceReply = () => Promise.resolve({ data: { status: 'success', data: [] } });
      const withNone = await quote(loadRegime().regime);

      expect(withTemplate.usd).to.be.greaterThan(withNone.usd);
    });

    it('keeps the multiplier when the fetch fails, instead of quoting without it', async () => {
      const { regime } = loadRegime();
      marketplaceReply = succeeds;
      const fresh = await quote(regime);

      // The cached list has aged out; the stats server is now down.
      cacheManager.marketplaceAppsCache.delete(CACHE_KEY);
      marketplaceReply = fails;
      const afterFailure = await quote(regime);

      expect(afterFailure.usd).to.equal(fresh.usd);
    });

    // A node that has never read the list cannot tell what a marketplace app
    // costs. Answering anyway means charging the resource price for an app that
    // owes the multiplier, with nothing in the response to say so.
    it('refuses rather than quote a marketplace app it cannot price', async () => {
      const { regime } = loadRegime();
      marketplaceReply = fails;

      let error;
      await quote(regime).catch((err) => { error = err; });

      expect(error).to.be.an('error');
      expect(error.message).to.include('Marketplace pricing is unavailable');
    });

    it('prices normally once it has read the list, however the server behaves after', async () => {
      const { regime } = loadRegime();
      marketplaceReply = succeeds;
      const first = await quote(regime);

      cacheManager.marketplaceAppsCache.delete(CACHE_KEY);
      marketplaceReply = fails;

      expect((await quote(regime)).usd).to.equal(first.usd);
    });

    // An ordinary name cannot match a template, so the list has no bearing on
    // its price and a stats outage must not touch it.
    it('never reads the list for an app whose name carries no marketplace stamp', async () => {
      const { regime, get } = loadRegime();
      marketplaceReply = fails;

      const priced = await quote(regime, ordinarySpec);

      expect(marketplaceCalls(get)).to.equal(0);
      expect(priced.usd).to.be.a('number').and.be.greaterThan(0);
    });

    it('reads the list once for many quotes rather than once per quote', async () => {
      const { regime, get } = loadRegime();
      marketplaceReply = succeeds;

      await quote(regime);
      expect(marketplaceCalls(get), 'the first quote must actually fetch').to.equal(1);

      await quote(regime);
      await quote(regime);
      expect(marketplaceCalls(get)).to.equal(1);
    });

    // A failure holds the last good list briefly, so an outage costs one fetch
    // per hold rather than one — and one timeout — per quote.
    it('pauses before asking again once it has a list to serve', async () => {
      const { regime, get } = loadRegime();
      marketplaceReply = succeeds;
      await quote(regime);

      cacheManager.marketplaceAppsCache.delete(CACHE_KEY);
      marketplaceReply = fails;
      await quote(regime);
      await quote(regime);

      expect(marketplaceCalls(get)).to.equal(2);
    });

    // That pause is only affordable because the fallback is truthful. A node
    // that has never read the list is quoting marketplace apps without their
    // multiplier, so it must not stop asking while that is true.
    it('keeps asking while it has no list to fall back on', async () => {
      const { regime, get } = loadRegime();
      marketplaceReply = fails;

      await quote(regime).catch(() => {});
      await quote(regime).catch(() => {});

      expect(marketplaceCalls(get)).to.equal(2);
    });

    it('bounds the fetch with a timeout, so a stalled server cannot hold a quote open', async () => {
      const { regime, get } = loadRegime();
      marketplaceReply = succeeds;

      await quote(regime);

      const [, options] = get.args.find(([url]) => url.includes('/marketplace/listapps'));
      expect(options.timeout).to.be.a('number').and.be.greaterThan(0);
    });
  });
});
