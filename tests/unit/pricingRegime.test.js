'use strict';

// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const { load } = require('@runonflux/flux-spec-cjs');

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
    const { regimeFor } = require('../../ZelBack/src/services/pricing/pricingRegime');
    const legacyPricingRegime = require('../../ZelBack/src/services/pricing/legacyPricingRegime');
    const v9PricingRegime = require('../../ZelBack/src/services/pricing/v9PricingRegime');

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

    it('exposes the same five operations on both regimes', () => {
      const ops = ['onChainDisplayPrice', 'fiatAndFluxDisplayPrice', 'registrationFee', 'supersededMessage', 'updateFee'];
      for (const op of ops) {
        expect(legacyPricingRegime[op], `legacy.${op}`).to.be.a('function');
        expect(v9PricingRegime[op], `v9.${op}`).to.be.a('function');
      }
    });
  });

  // What an update is priced against. Each regime answers for its own
  // economics; the promotion path asks and never chooses.
  describe('supersededMessage', () => {
    const CONFIRMING = { height: 2_000_000, timestamp: 1_750_000_000_000 };

    function loadRegimes() {
      const appsRepositoryStub = {
        getPreviousPermanentMessage: sinon.stub().resolves({ hash: 'byTimestamp' }),
        getPermanentMessageBeforeHeight: sinon.stub().resolves({ hash: 'byHeight' }),
        listAppMessagesByName: sinon.stub().resolves([]),
      };
      const P = '../../ZelBack/src/services/pricing';
      return {
        appsRepositoryStub,
        legacy: proxyquire(`${P}/legacyPricingRegime`, {
          '../appDatabase/appsRepository': appsRepositoryStub,
        }),
        v9: proxyquire(`${P}/v9PricingRegime`, {
          '../appDatabase/appsRepository': appsRepositoryStub,
        }),
      };
    }

    // The update is already stored as a permanent message by the time this is
    // asked. A height cutoff is the only one that excludes it: the message
    // cannot precede its own height, however its timestamp is written.
    it('v9 resolves by confirming height, which cannot select the update itself', async () => {
      const { v9, appsRepositoryStub } = loadRegimes();

      const result = await v9.supersededMessage('myapp', CONFIRMING);

      expect(result.hash).to.equal('byHeight');
      sinon.assert.calledOnceWithExactly(
        appsRepositoryStub.getPermanentMessageBeforeHeight, 'myapp', CONFIRMING.height,
      );
      sinon.assert.notCalled(appsRepositoryStub.getPreviousPermanentMessage);
    });

    it('v9 never uses the message timestamp, which its sender writes', async () => {
      const { v9, appsRepositoryStub } = loadRegimes();

      await v9.supersededMessage('myapp', { height: 2_000_000, timestamp: 1 });

      const [, cutoff] = appsRepositoryStub.getPermanentMessageBeforeHeight.firstCall.args;
      expect(cutoff).to.equal(2_000_000);
    });

    // Legacy is bug-compatible on purpose: its resolution selects the update
    // itself, which floors every legacy update at minPrice. That is what the
    // network has enforced since height 1004000, and a node resolving it any
    // other way would reject updates every other node accepts.
    it('legacy keeps the timestamp resolution the network has always used', async () => {
      const { legacy, appsRepositoryStub } = loadRegimes();

      const result = await legacy.supersededMessage('myapp', CONFIRMING);

      expect(result.hash).to.equal('byTimestamp');
      sinon.assert.calledOnceWithExactly(
        appsRepositoryStub.getPreviousPermanentMessage, 'myapp', CONFIRMING.timestamp,
      );
      sinon.assert.notCalled(appsRepositoryStub.getPermanentMessageBeforeHeight);
    });

    it('reports nothing to supersede rather than inventing a predecessor', async () => {
      const { v9, appsRepositoryStub } = loadRegimes();
      appsRepositoryStub.getPermanentMessageBeforeHeight.resolves(null);

      expect(await v9.supersededMessage('myapp', CONFIRMING)).to.be.null;
    });
  });

  // The free-update rate limit is decided inside priceUpdate from the history
  // and the clock the regime hands it. Both come from the chain: the confirming
  // block's time, and only the messages confirmed below its height. A node's
  // own clock would give every node its own window, and a replaying node an
  // empty one; a cutoff at the confirming height would count the update itself.
  describe('v9 updateFee counts the free-update allowance from the confirming block', () => {
    const HEIGHT = 2_000_000;
    const BLOCK_TIME = 1_750_000_000;
    const history = [
      { hash: 'earlier', height: HEIGHT - 5, timestamp: BLOCK_TIME * 1000 - 3_600_000, type: 'fluxappupdate' },
      { hash: 'this', height: HEIGHT, timestamp: BLOCK_TIME * 1000 - 60_000, type: 'fluxappupdate' },
      { hash: 'later', height: HEIGHT + 1, timestamp: BLOCK_TIME * 1000 + 60_000, type: 'fluxappupdate' },
    ];
    const spec = { name: 'myapp', ttl: 2_592_000, isEncrypted: false };

    function loadV9() {
      const priceUpdate = sinon.stub().resolves({ free: true });
      const engine = {
        price: sinon.stub().resolves({ marketplaceAdjustedMicrodollars: 0 }),
        priceUpdate,
      };
      const v9 = proxyquire('../../ZelBack/src/services/pricing/v9PricingRegime', {
        '../appDatabase/appsRepository': { listAppMessagesByName: sinon.stub().resolves(history) },
        './buildPricingEngine': {
          buildPricingEngine: sinon.stub().resolves(engine),
          resolveMarketplacePricingCtx: sinon.stub().returns({}),
        },
        './priceOracleState': { getPriceModifierHistory: () => null },
        '../utils/specLibs': { getSpecPolicy: sinon.stub().resolves({ meteredQuantities: () => new Map() }) },
      });
      return { v9, priceUpdate };
    }

    async function contextHandedToTheRule() {
      const { v9, priceUpdate } = loadV9();
      await v9.updateFee(spec, spec, HEIGHT, HEIGHT - 5, BLOCK_TIME - 3600, BLOCK_TIME);
      return priceUpdate.firstCall.args[2];
    }

    it('hands the rule the block time, not the clock of the node reading it', async () => {
      const ctx = await contextHandedToTheRule();
      expect(ctx.asOf).to.equal(BLOCK_TIME * 1000);
    });

    it('counts only the messages confirmed below the update, never the update itself', async () => {
      const ctx = await contextHandedToTheRule();
      expect(ctx.recentEvents.map((message) => message.hash)).to.deep.equal(['earlier']);
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

    const cacheManager = require('../../ZelBack/src/services/utils/cacheManager').default;
    const { v8Spec } = require('./fixtures/fluxSpec');
    const config = require('config');

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
        '../daemonService/daemonServiceMiscRpcs': {
          isDaemonSynced: () => ({ data: { synced: true, height: HEIGHT } }),
        },
        '../appDatabase/appsRepository': {
          getGlobalAppInfo: sinon.stub().resolves(null),
          listAppMessagesByName: sinon.stub().resolves([]),
          getPreviousPermanentMessage: sinon.stub().resolves(null),
        },
        '../utils/chainUtilities': {
          getChainParamsPriceUpdates: sinon.stub().resolves(config.get('fluxapps.price')),
        },
        '../utils/specCutover': {
          resolveSpec: sinon.stub().resolves(null),
          resolveInstantiatedSpec: sinon.stub().resolves(null),
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
