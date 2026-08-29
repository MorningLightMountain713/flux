'use strict';

// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const daemonServiceMiscRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceMiscRpcs');
const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');
const {
  loadSpecLibrary, V8_SUBMISSION, v1Spec, v8Spec, v9Spec, instantiatedSpec,
} = require('./fixtures/fluxSpec');

// The spec library is real here — see tests/unit/fixtures/fluxSpec.js for why.
// Every spec, component, placement and registration below is a real class
// instance; what stays stubbed is I/O (mongo, the daemon RPC, the repository)
// and the two specCutover seams that stand in for "decrypt the row we hold".
//
// The doubles this replaced stated their own answers. mockClassSpec declared
// `pricingModel` from a version number, so the regime split was decided by the
// fixture rather than by the spec; mockPlacement returned bare arrays, so the
// free-update placement comparison never met a real Placement; and mockComponent
// accepted sizes no schema allows (512 MB of memory is not a multiple of 100).
let flux;

// ── Real spec builders ──────────────────────────────────────────────

/**
 * Real v8 compose entries, derived from V8_SUBMISSION's own so the shape stays
 * in step with the fixture. Ports are assigned per index because two components
 * of one app may not share a host port; the free-update rule compares port
 * COUNTS per component, so the specific numbers do not matter.
 */
function legacyCompose(entries) {
  const [base] = V8_SUBMISSION.compose;
  return entries.map((entry, index) => ({
    ...base,
    name: entry.name,
    description: entry.name,
    cpu: entry.cpu,
    ram: entry.ram,
    hdd: entry.hdd,
    ports: [31443 + index],
    containerPorts: [8080 + index],
  }));
}

/** A real FluxAppSpecV8 — the class checkLegacyFreeUpdate is handed. */
async function legacySpec({
  name = 'TestApp', instances = 5, staticip = false, nodes = [], expire = 44000, compose,
}) {
  return v8Spec({
    name, instances, staticip, nodes, expire, compose: legacyCompose(compose),
  });
}

/**
 * A real InstantiatedSpec — the app's current registration. `expiresAtHeight`
 * is the library's own, PON-fork adjustment included, so the free-update
 * extension bar is measured against the real expiry rather than a copy of the
 * arithmetic kept in the test file.
 */
async function registered(spec, height, registeredAt) {
  return instantiatedSpec(spec, { height, registeredAt });
}

// appSpecHelpers reads resolveSpec; the regimes read it one module deeper under
// a different request path. Wiring them explicitly keeps every other module a
// singleton — proxyquire's @global reloads the whole tree, which silently gives
// the code under test its own daemonServiceMiscRpcs that no stub can reach.
function buildAppSpecHelpers(cutover) {
  const P = '../../ZelBack/src/services';
  const legacy = proxyquire(`${P}/pricing/legacyPricingRegime`, { '../utils/specCutover': cutover });
  const v9 = proxyquire(`${P}/pricing/v9PricingRegime`, { '../utils/specCutover': cutover });
  const regime = proxyquire(`${P}/pricing/pricingRegime`, {
    './legacyPricingRegime': legacy,
    './v9PricingRegime': v9,
  });
  return proxyquire(`${P}/utils/appSpecHelpers`, {
    './specCutover': cutover,
    '../pricing/pricingRegime': regime,
  });
}

describe('appSpecHelpers tests', () => {
  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30000);
    flux = await loadSpecLibrary();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('checkLegacyFreeUpdate tests', () => {
    let legacyRegime;
    let resolveInstantiatedSpecStub;

    beforeEach(() => {
      // The seam that decrypts the held registration. Cleartext resolves to the
      // row's own spec, which is what the real one returns for a cleartext app.
      resolveInstantiatedSpecStub = sinon.stub().callsFake(async (inst) => inst.spec);
      legacyRegime = proxyquire('../../ZelBack/src/services/pricing/legacyPricingRegime', {
        '../utils/specCutover': { resolveInstantiatedSpec: resolveInstantiatedSpecStub },
      });
    });

    /** The one component every single-component case below uses. */
    const oneComponent = (cpu = 1, ram = 2000, hdd = 50) => [{
      name: 'main', cpu, ram, hdd,
    }];

    it('should return true for free update with no resource changes', async () => {
      const daemonHeight = 100000;
      const spec = await legacySpec({ compose: oneComponent() });
      const prev = await legacySpec({ compose: oneComponent() });

      sinon.stub(appsRepository, 'getGlobalAppInfo')
        .resolves(await registered(prev, daemonHeight + 44000 - spec.expire));
      sinon.stub(appsRepository, 'listAppMessagesByName').resolves([]);

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.true;
    });

    // The registration is handed to the decrypt seam, and the rule reads
    // `expiresAtHeight` straight off it. Both are properties of a real
    // InstantiatedSpec, and an absent expiresAtHeight makes blocksToExtend NaN —
    // which compares false against the 8-block bar and quietly calls every
    // update paid. So read the argument back and assert the properties the real
    // collaborators read.
    it('hands the decrypt seam a registration answering what the rule reads', async () => {
      const daemonHeight = 100000;
      const spec = await legacySpec({ compose: oneComponent() });
      const prev = await legacySpec({ compose: oneComponent() });

      sinon.stub(appsRepository, 'getGlobalAppInfo')
        .resolves(await registered(prev, daemonHeight + 44000 - spec.expire));
      sinon.stub(appsRepository, 'listAppMessagesByName').resolves([]);

      await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);

      const [handed] = resolveInstantiatedSpecStub.firstCall.args;
      expect(handed, 'nothing reached the decrypt seam').to.be.an('object');
      expect(handed.expiresAtHeight, 'the rule measures the extension against this')
        .to.be.a('number');
      expect(handed.isEncrypted, 'the real seam branches on this').to.be.a('boolean');
      expect(handed.spec, 'and returns this for a cleartext row').to.be.an('object');
      expect(handed.expiresAtHeight).to.equal(daemonHeight + spec.expire);
    });

    // The caps are durations (5 in 24h, 8 in 48h, 10 in 120h) — the same the v9
    // rule applies. They are measured in blocks, so at the current 30-second
    // block time 24h is 2880 blocks, 48h is 5760 and 120h is 14400. Written out
    // as literals they were 720/1440/3600, which are those durations only at
    // the pre-PON 120-second block time; these pin the durations so the counts
    // cannot silently drift again.
    describe('rate-limit windows are the durations they claim', () => {
      const daemonHeight = 3000000;
      const BLOCKS_PER_HOUR = 3600 / 30;

      async function setup(updates) {
        const spec = await legacySpec({ name: 'RateApp', compose: oneComponent() });
        const prev = await legacySpec({ name: 'RateApp', compose: oneComponent() });
        sinon.stub(appsRepository, 'getGlobalAppInfo')
          .resolves(await registered(prev, daemonHeight + 44000 - spec.expire));
        sinon.stub(appsRepository, 'listAppMessagesByName').resolves(updates);
        return spec;
      }

      // `hoursAgo` back from the tip, in blocks.
      const updatesAgo = (count, hoursAgo) => Array.from({ length: count }, () => ({
        type: 'fluxappupdate',
        height: daemonHeight - Math.round(hoursAgo * BLOCKS_PER_HOUR),
      }));

      it('allows 5 updates inside 24 hours but not 6', async () => {
        expect(await legacyRegime.checkLegacyFreeUpdate(await setup(updatesAgo(5, 12)), daemonHeight)).to.equal(true);
        sinon.restore();
        expect(await legacyRegime.checkLegacyFreeUpdate(await setup(updatesAgo(6, 12)), daemonHeight)).to.equal(false);
      });

      // 6 updates would breach the 24h cap, so placing them 30h back proves the
      // 24h window really ends at 24h and not at the old 6h.
      it('counts a 30-hour-old update as outside the 24-hour window', async () => {
        expect(await legacyRegime.checkLegacyFreeUpdate(await setup(updatesAgo(6, 30)), daemonHeight)).to.equal(true);
      });

      it('allows 8 updates inside 48 hours but not 9', async () => {
        expect(await legacyRegime.checkLegacyFreeUpdate(await setup(updatesAgo(8, 36)), daemonHeight)).to.equal(true);
        sinon.restore();
        expect(await legacyRegime.checkLegacyFreeUpdate(await setup(updatesAgo(9, 36)), daemonHeight)).to.equal(false);
      });

      it('allows 10 updates inside 120 hours but not 11', async () => {
        expect(await legacyRegime.checkLegacyFreeUpdate(await setup(updatesAgo(10, 100)), daemonHeight)).to.equal(true);
        sinon.restore();
        expect(await legacyRegime.checkLegacyFreeUpdate(await setup(updatesAgo(11, 100)), daemonHeight)).to.equal(false);
      });

      it('ignores updates older than the widest window', async () => {
        expect(await legacyRegime.checkLegacyFreeUpdate(await setup(updatesAgo(50, 200)), daemonHeight)).to.equal(true);
      });

      it('counts only update messages, not the original registration', async () => {
        const registrations = Array.from({ length: 20 }, () => ({
          type: 'fluxappregister', height: daemonHeight - 10,
        }));
        expect(await legacyRegime.checkLegacyFreeUpdate(await setup(registrations), daemonHeight)).to.equal(true);
      });
    });

    it('should allow free update when components are reordered', async () => {
      const daemonHeight = 100000;
      const spec = await legacySpec({
        compose: [
          { name: 'B', cpu: 2, ram: 4000, hdd: 100 },
          { name: 'A', cpu: 1, ram: 2000, hdd: 50 },
        ],
      });
      const prev = await legacySpec({
        compose: [
          { name: 'A', cpu: 1, ram: 2000, hdd: 50 },
          { name: 'B', cpu: 2, ram: 4000, hdd: 100 },
        ],
      });

      sinon.stub(appsRepository, 'getGlobalAppInfo')
        .resolves(await registered(prev, daemonHeight + 44000 - spec.expire));
      sinon.stub(appsRepository, 'listAppMessagesByName').resolves([]);

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.true;
    });

    // Each of the four cases below registers at a height that leaves the
    // subscription unextended, so the named change is the ONLY reason the answer
    // is false. Registered further back, the extension bar rejects them first
    // and the assertion passes without the growth check ever running.
    it('should return false when CPU increased', async () => {
      const daemonHeight = 100000;
      const spec = await legacySpec({ compose: oneComponent(2, 2000, 50) });
      const prev = await legacySpec({ compose: oneComponent(1, 2000, 50) });

      sinon.stub(appsRepository, 'getGlobalAppInfo')
        .resolves(await registered(prev, daemonHeight + 44000 - spec.expire));
      sinon.stub(appsRepository, 'listAppMessagesByName').resolves([]);

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.false;
    });

    it('should return false when RAM increased', async () => {
      const daemonHeight = 100000;
      const spec = await legacySpec({ compose: oneComponent(1, 4000, 50) });
      const prev = await legacySpec({ compose: oneComponent(1, 2000, 50) });

      sinon.stub(appsRepository, 'getGlobalAppInfo')
        .resolves(await registered(prev, daemonHeight + 44000 - spec.expire));
      sinon.stub(appsRepository, 'listAppMessagesByName').resolves([]);

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.false;
    });

    it('should return false when HDD increased', async () => {
      const daemonHeight = 100000;
      const spec = await legacySpec({ compose: oneComponent(1, 2000, 100) });
      const prev = await legacySpec({ compose: oneComponent(1, 2000, 50) });

      sinon.stub(appsRepository, 'getGlobalAppInfo')
        .resolves(await registered(prev, daemonHeight + 44000 - spec.expire));
      sinon.stub(appsRepository, 'listAppMessagesByName').resolves([]);

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.false;
    });

    it('should return false when instances changed', async () => {
      const daemonHeight = 100000;
      const spec = await legacySpec({ instances: 10, compose: oneComponent() });
      const prev = await legacySpec({ instances: 5, compose: oneComponent() });

      sinon.stub(appsRepository, 'getGlobalAppInfo')
        .resolves(await registered(prev, daemonHeight + 44000 - spec.expire));
      sinon.stub(appsRepository, 'listAppMessagesByName').resolves([]);

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.false;
    });

    it('should return false when staticip changed', async () => {
      const daemonHeight = 100000;
      const spec = await legacySpec({ staticip: true, compose: oneComponent() });
      const prev = await legacySpec({ staticip: false, compose: oneComponent() });

      sinon.stub(appsRepository, 'getGlobalAppInfo')
        .resolves(await registered(prev, daemonHeight + 44000 - spec.expire));
      sinon.stub(appsRepository, 'listAppMessagesByName').resolves([]);

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.false;
    });

    // The rule compares `spec.placement.staticIp === prevSpec.placement.staticIp`.
    // A record stored before staticip existed still answers that comparison: v1
    // predates the field entirely and its Placement reports false, not undefined.
    // v7 and v8 REQUIRE the field, so an "undefined staticip" row at those
    // versions is not something the library will build.
    it('should treat undefined staticip as false (legacy DB records)', async () => {
      const daemonHeight = 100000;
      const preStaticIpRow = await v1Spec();
      expect(preStaticIpRow.placement.staticIp, 'a record predating the field').to.equal(false);

      const spec = await legacySpec({ staticip: false, compose: oneComponent() });
      expect(spec.placement.staticIp).to.equal(preStaticIpRow.placement.staticIp);

      const prev = await legacySpec({ staticip: false, compose: oneComponent() });
      sinon.stub(appsRepository, 'getGlobalAppInfo')
        .resolves(await registered(prev, daemonHeight + 44000 - spec.expire));
      sinon.stub(appsRepository, 'listAppMessagesByName').resolves([]);

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.true;
    });

    it('should handle PON fork adjustment for pre-fork apps (free update)', async () => {
      const daemonHeight = 2256730;
      const spec = await legacySpec({
        name: 'PresearchNode',
        instances: 12,
        expire: 100,
        compose: [{ name: 'node', cpu: 0.3, ram: 300, hdd: 2 }],
      });
      const prev = await legacySpec({
        name: 'PresearchNode',
        instances: 12,
        expire: 244085,
        compose: [{ name: 'node', cpu: 0.3, ram: 300, hdd: 2 }],
      });
      const row = await registered(prev, 1837757);
      // The term was bought when blocks were four times slower, so the library
      // stretches the post-fork remainder — without that the update reads as
      // buying another 10,000 blocks and is charged.
      expect(row.expiresAtHeight).to.be.greaterThan(1837757 + 244085);

      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(row);
      sinon.stub(appsRepository, 'listAppMessagesByName').resolves([]);

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.true;
    });

    it('should return false when component count changed', async () => {
      const daemonHeight = 100000;
      const spec = await legacySpec({
        compose: [
          { name: 'a', cpu: 1, ram: 2000, hdd: 50 },
          { name: 'b', cpu: 1, ram: 2000, hdd: 50 },
        ],
      });
      const prev = await legacySpec({ compose: [{ name: 'a', cpu: 1, ram: 2000, hdd: 50 }] });

      sinon.stub(appsRepository, 'getGlobalAppInfo')
        .resolves(await registered(prev, daemonHeight + 44000 - spec.expire));
      sinon.stub(appsRepository, 'listAppMessagesByName').resolves([]);

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.false;
    });

    it('should return false when app does not exist', async () => {
      const spec = await legacySpec({ name: 'NewApp', compose: oneComponent() });
      const daemonHeight = 100000;

      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(null);

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.false;
    });

    it('should return false when blocksToExtend > 8', async () => {
      const daemonHeight = 100000;
      const spec = await legacySpec({ expire: 50000, compose: oneComponent() });
      const prev = await legacySpec({ expire: 44003, compose: oneComponent() });

      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(await registered(prev, 94003));
      sinon.stub(appsRepository, 'listAppMessagesByName').resolves([]);

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.false;
    });

    it('should return false when too many updates in recent period', async () => {
      const daemonHeight = 100000;
      const spec = await legacySpec({ compose: oneComponent() });
      const prev = await legacySpec({ compose: oneComponent() });

      const recentMessages = Array(11).fill({
        type: 'fluxappupdate',
        height: 99000,
      });

      sinon.stub(appsRepository, 'getGlobalAppInfo')
        .resolves(await registered(prev, daemonHeight + 44000 - spec.expire));
      sinon.stub(appsRepository, 'listAppMessagesByName').resolves(recentMessages);

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.false;
    });

    it('should allow resources to decrease for free update', async () => {
      const daemonHeight = 100000;
      const spec = await legacySpec({ compose: oneComponent(0.5, 1000, 25) });
      const prev = await legacySpec({ compose: oneComponent(1, 2000, 50) });

      sinon.stub(appsRepository, 'getGlobalAppInfo')
        .resolves(await registered(prev, daemonHeight + 44000 - spec.expire));
      sinon.stub(appsRepository, 'listAppMessagesByName').resolves([]);

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.true;
    });

    // The quote endpoint accepts whatever spec the caller posts, so a legacy
    // spec can arrive for an app that is already registered at v9. Consensus
    // can never accept that update (UpdatePolicy.assertVersionTransition), so
    // the legacy rule must not offer it for free.
    it('should return false when the registered app is v9', async () => {
      const daemonHeight = 2700000;
      // Lowercase because the app is registered at v9, whose name pattern is
      // ^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$ — 'TestApp' is not a name a v9
      // registration can ever have had.
      const spec = await legacySpec({
        name: 'testapp', expire: 88000, instances: 3, compose: oneComponent(),
      });
      const prev = await v9Spec({ name: 'testapp', instances: 3 });
      expect(prev.version, 'the registered app really is v9').to.equal(9);

      sinon.stub(appsRepository, 'getGlobalAppInfo')
        .resolves(await registered(prev, daemonHeight - 3, Math.floor(Date.now() / 1000) - 100));
      sinon.stub(appsRepository, 'listAppMessagesByName').resolves([]);

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.false;
    });
  });

  describe('getAppFluxOnChainPrice tests', () => {
    // The one test here drives the REAL specCutover.resolveSpec, which is what
    // makes it worth having: a stored document is parsed back into its class
    // before the regime is asked anything. The cost is that resolveSpec also
    // registers FluxOS's own crypto providers on the encrypted spec classes,
    // and latches that for the process. loadSpecLibrary() is memoised, so a
    // later file asking for the library is handed the cached namespace and
    // never re-registers the test providers — its sealed specs would then reach
    // for the benchmark channel over the network. Put the test providers back.
    after(async () => {
      const {
        InsecureTestCryptoProvider, InsecureLegacyTestCryptoProvider,
      } = await import('@runonflux/flux-spec-backend/testing');
      flux.EncryptedSpecV8.registerProvider(() => new InsecureLegacyTestCryptoProvider());
      flux.EncryptedSpecV9.registerProvider(() => new InsecureTestCryptoProvider());
    });

    it('should throw error when daemon not synced', async () => {
      // The stored document a quote arrives as: a real v8 spec's own wire form,
      // which the real resolveSpec parses back into the class.
      const appSpec = (await v8Spec()).serialize();

      sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({}) });
      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: false },
      });

      const appSpecHelpers = require('../../ZelBack/src/services/utils/appSpecHelpers');
      try {
        await appSpecHelpers.getAppFluxOnChainPrice(appSpec);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Daemon not yet synced');
      }
    });
  });

  describe('getAppFiatAndFluxPrice — v9 fiat markup (basis points)', () => {
    const priceOracleState = require('../../ZelBack/src/services/pricing/priceOracleState');
    let appSpecHelpers;
    let markupSpec;

    before(async () => {
      markupSpec = await v9Spec({ name: 'markuptest' });
    });

    // PriceMessage rates so the engine prices the spec to a non-zero FLUX figure.
    const priceFields = {
      cpuRate: 150000, memoryRate: 50000, storageRate: 20000,
      stdPortRate: 0, premPortRate: 2000000, staticIpRate: 2000000,
      minPrice: 990000, minPriceFluxSats: 1000000,
    };

    beforeEach(() => {
      appSpecHelpers = proxyquire('../../ZelBack/src/services/utils/appSpecHelpers', {
        './specCutover': { resolveSpec: sinon.stub().resolves(markupSpec) },
      });
      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({ data: { synced: true, height: 200 } });
      // No existing global app -> the registration path runs, so the markup is visible.
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(null);
      sinon.stub(priceOracleState, 'getPriceMessageHistory').returns({ resolveAt: () => priceFields });
      // fluxUsdPriceE4 = 10000 -> $1.00 / FLUX, so usd/flux isolates the markup factor.
      sinon.stub(priceOracleState, 'getRateMessageHistory').returns({ resolveAt: () => ({ fluxUsdPriceE4: 10000 }) });
      sinon.stub(priceOracleState, 'getPriceModifierHistory').returns({ resolveAt: () => ({ fiatMarkupBp: 500 }) });
      sinon.stub(priceOracleState, 'getMarketplacePricingHistory').returns(null);
    });

    it('applies fiatMarkupBp as a basis-points markup (500 -> +5%) and returns fluxDiscount as a percent', async () => {
      const result = await appSpecHelpers.getAppFiatAndFluxPrice(markupSpec);
      expect(result.fiatMarkupBp).to.equal(500);
      expect(result.fluxDiscount).to.equal(5); // 500 / 100, display percent
      expect(result.flux).to.be.greaterThan(0);
      expect(result.usd / result.flux).to.be.closeTo(1.05, 0.01); // 1 + 500/10000
    });

    it('applies no markup when fiatMarkupBp is absent (usd == flux at $1/FLUX)', async () => {
      priceOracleState.getPriceModifierHistory.restore();
      sinon.stub(priceOracleState, 'getPriceModifierHistory').returns({ resolveAt: () => ({}) });
      const result = await appSpecHelpers.getAppFiatAndFluxPrice(markupSpec);
      expect(result.fiatMarkupBp).to.equal(0);
      expect(result.fluxDiscount).to.equal(0);
      expect(result.usd / result.flux).to.be.closeTo(1.0, 0.01);
    });
  });

  // The two pricing regimes, pinned.
  //
  //   v1-v8: the on-chain fee is a near-zero floor, so the DISPLAY price is what
  //          an owner actually pays and checkLegacyFreeUpdate decides whether it
  //          is waived. Two numbers, deliberately.
  //   v9:    the on-chain price was raised to equal the display price, so there
  //          is one number. Free-or-not is decided once inside
  //          PricingEngine.priceUpdate, which both the quote and consensus reach
  //          through the same call.
  //
  // These tests exist because a second, older free-update opinion used to sit in
  // front of the v9 path and answer first. The regime split is now decided by
  // the spec's OWN pricingModel — chainFloor for a real v8, unified for a real
  // v9 — rather than by a fixture that declared one.
  describe('pricing regimes — legacy quotes locally, v9 quotes what consensus charges', () => {
    const priceOracleState = require('../../ZelBack/src/services/pricing/priceOracleState');

    const priceFields = {
      cpuRate: 150000, memoryRate: 50000, storageRate: 20000,
      stdPortRate: 0, premPortRate: 2000000, staticIpRate: 2000000,
      minPrice: 990000, minPriceFluxSats: 1000000,
      // A non-zero fee on a feature, so "feature added" is observable in the price.
      meshFee: 500000,
    };

    /** A real FluxAppSpecV9 for the app under quote. */
    const v9SpecWith = (over = {}) => v9Spec({ name: 'regimetest', ...over });

    /**
     * The existing registration, so the quote takes the UPDATE path
     * (priceUpdate) rather than the registration path. registeredAt is "just
     * now" on purpose: it leaves the subscription unextended, which is what the
     * free-update rule requires before it will call an update free. A stale
     * value makes the rule reject on time alone, and the feature test below
     * would then pass without proving anything.
     */
    async function registrationOf(prevSpec) {
      return registered(prevSpec, 100, Math.floor(Date.now() / 1000));
    }

    // `messages` becomes the free-update rate-limit input.
    async function buildHelpers({ newSpec, prevSpec, messages = [] }) {
      const existing = await registrationOf(prevSpec);
      const resolveInstantiatedSpec = sinon.stub().resolves(prevSpec);
      const helpers = buildAppSpecHelpers({
        resolveSpec: sinon.stub().resolves(newSpec),
        resolveInstantiatedSpec,
      });
      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({ data: { synced: true, height: 200 } });
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(existing);
      sinon.stub(appsRepository, 'listAppMessagesByName').resolves(messages);
      sinon.stub(priceOracleState, 'getPriceMessageHistory').returns({ resolveAt: () => priceFields });
      sinon.stub(priceOracleState, 'getRateMessageHistory').returns({ resolveAt: () => ({ fluxUsdPriceE4: 10000 }) });
      sinon.stub(priceOracleState, 'getPriceModifierHistory').returns({ resolveAt: () => ({}) });
      sinon.stub(priceOracleState, 'getMarketplacePricingHistory').returns(null);
      return { helpers, existing, resolveInstantiatedSpec };
    }

    const updatesAt = (count, msAgo) => Array.from({ length: count }, () => ({
      type: 'fluxappupdate', timestamp: Date.now() - msAgo,
    }));

    it('v9: an unchanged update quotes zero — priceUpdate decided it was free', async () => {
      const { helpers } = await buildHelpers({
        newSpec: await v9SpecWith(), prevSpec: await v9SpecWith(),
      });
      const result = await helpers.getAppFiatAndFluxPrice(await v9SpecWith());
      expect(result.flux).to.equal(0);
      expect(result.usd).to.equal(0);
    });

    // The registration is handed to the decrypt seam, and the regime reads three
    // fields straight off it: height (the rates the old spec is priced at),
    // registeredAt (the unused-time credit) and isEncrypted. registeredAt absent
    // makes remainingSeconds NaN and the credit vanishes silently, so read the
    // argument back and assert the properties the regime reads.
    it('v9: hands the decrypt seam a registration answering what the regime reads', async () => {
      const prevSpec = await v9SpecWith();
      const { helpers, resolveInstantiatedSpec } = await buildHelpers({
        newSpec: await v9SpecWith(), prevSpec,
      });

      await helpers.getAppFiatAndFluxPrice(await v9SpecWith());

      const [handed] = resolveInstantiatedSpec.firstCall.args;
      expect(handed, 'nothing reached the decrypt seam').to.be.an('object');
      expect(handed.height, 'the old spec is priced at this height').to.be.a('number');
      expect(handed.registeredAt, 'the unused-time credit is measured from this').to.be.a('number');
      expect(handed.isEncrypted, 'and this drives the encryptedSpec fee').to.be.a('boolean');
      expect(handed.spec, 'the real seam returns this for a cleartext row').to.equal(prevSpec);
    });

    // The decisive one. The legacy rule does not look at features at all, so it
    // would call this free. The v9 rule rejects any added feature. A non-zero
    // quote proves the v9 path is answering with the v9 rule.
    it('v9: adding a feature is charged, though the legacy rule would call it free', async () => {
      const { helpers } = await buildHelpers({
        newSpec: await v9SpecWith({ network: { mesh: true } }),
        prevSpec: await v9SpecWith(),
      });
      const result = await helpers.getAppFiatAndFluxPrice(await v9SpecWith({ network: { mesh: true } }));
      expect(result.flux).to.be.greaterThan(0);
    });

    // The free-update cap is 5 in 24h. Without a populated event list it can
    // never fire, and every free update is granted forever.
    //
    // Hitting the cap REFUSES the update; it does not charge for it. That is the
    // engine's deliberate answer and updateFee's comment says why: the update is
    // free-shaped, so pricing it would let the mandatory floor payment buy nothing
    // while restarting a term the owner never asked to restart. There is no payable
    // figure to quote, so the quote reports the refusal - by throwing, which is how
    // this function already answers 'no price, and here is why' for an unsynced
    // daemon and an invalid spec.
    it('v9: the free-update rate limit refuses, rather than quoting a price', async () => {
      const { helpers } = await buildHelpers({
        newSpec: await v9SpecWith(),
        prevSpec: await v9SpecWith(),
        messages: updatesAt(5, 60 * 60 * 1000),
      });
      try {
        const result = await helpers.getAppFiatAndFluxPrice(await v9SpecWith());
        expect.fail(`Should have refused, got ${JSON.stringify(result)}`);
      } catch (error) {
        expect(error.name, 'a UI must branch on this without matching English').to.equal('UpdateRefused');
        expect(error.message, 'and still show the engine reason').to.include('rate limit');
        expect(String(error.message)).to.not.include('NaN');
      }
    });

    // The witness for "Display == consensus". Both sides must reach the same
    // figure; a comment saying so proves nothing, so price the same update
    // through each and compare. Consensus returns satoshis, the quote FLUX.
    it('v9: the quote equals the fee consensus charges', async () => {
      const newSpec = await v9SpecWith({ network: { mesh: true } });
      const prevSpec = await v9SpecWith();
      const { helpers, existing } = await buildHelpers({ newSpec, prevSpec });

      const quote = await helpers.getAppFiatAndFluxPrice(newSpec);

      // eslint-disable-next-line global-require
      const messageVerifier = require('../../ZelBack/src/services/appMessaging/messageVerifier');
      const consensusSats = await messageVerifier.computeUpdateFee(
        newSpec,
        prevSpec,
        200,
        existing.height,
        existing.registeredAt,
        Math.floor(Date.now() / 1000),
      );

      expect(quote.flux).to.be.greaterThan(0);
      expect(Number(consensusSats) / 1e8).to.equal(quote.flux);
    });

    it('v9: a free update is free on both sides, not just on the quote', async () => {
      const newSpec = await v9SpecWith();
      const prevSpec = await v9SpecWith();
      const { helpers, existing } = await buildHelpers({ newSpec, prevSpec });

      const quote = await helpers.getAppFiatAndFluxPrice(newSpec);

      // eslint-disable-next-line global-require
      const messageVerifier = require('../../ZelBack/src/services/appMessaging/messageVerifier');
      const consensusSats = await messageVerifier.computeUpdateFee(
        newSpec,
        prevSpec,
        200,
        existing.height,
        existing.registeredAt,
        Math.floor(Date.now() / 1000),
      );

      expect(quote.flux).to.equal(0);
      expect(consensusSats).to.equal(0n);
    });

    it('v9: the quote reads the real message history rather than an empty list', async () => {
      const { helpers } = await buildHelpers({
        newSpec: await v9SpecWith(), prevSpec: await v9SpecWith(),
      });
      await helpers.getAppFiatAndFluxPrice(await v9SpecWith());
      expect(appsRepository.listAppMessagesByName.calledWith('regimetest')).to.equal(true);
    });

    // Legacy keeps its own rule: its on-chain floor is near zero, so the
    // display price is the real price and this is what waives it. Driven end to
    // end through the quote entry point, so it also pins that a legacy spec is
    // routed to the legacy regime — by its own pricingModel, which a real
    // FluxAppSpecV8 reports as chainFloor.
    it('v1-v8: the legacy free-update rule still decides the quote', async () => {
      const daemonHeight = 100000;
      const legacyApp = await legacySpec({
        name: 'legacyapp',
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      });
      expect(legacyApp.pricingModel).to.equal(flux.PricingModel.CHAIN_FLOOR);
      const prev = await legacySpec({
        name: 'legacyapp',
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      });

      const helpers = buildAppSpecHelpers({
        resolveSpec: sinon.stub().resolves(legacyApp),
        resolveInstantiatedSpec: sinon.stub().callsFake(async (inst) => inst.spec),
      });
      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({ data: { synced: true, height: daemonHeight } });
      sinon.stub(appsRepository, 'getGlobalAppInfo')
        .resolves(await registered(prev, daemonHeight + 44000 - legacyApp.expire));
      sinon.stub(appsRepository, 'listAppMessagesByName').resolves([]);

      // The subscription is unextended and nothing grew, so the legacy rule
      // waives the price outright. Reaching a real quote instead would mean the
      // rule never ran.
      const result = await helpers.getAppFiatAndFluxPrice(legacyApp);
      expect(result).to.deep.equal({ usd: 0, flux: 0, fluxDiscount: 0 });
    });
  });

  describe('module exports tests', () => {
    it('should export getAppFiatAndFluxPrice', () => {
      const appSpecHelpers = require('../../ZelBack/src/services/utils/appSpecHelpers');
      expect(appSpecHelpers.getAppFiatAndFluxPrice).to.be.a('function');
    });

    it('should export getAppFiatAndFluxPriceApi', () => {
      const appSpecHelpers = require('../../ZelBack/src/services/utils/appSpecHelpers');
      expect(appSpecHelpers.getAppFiatAndFluxPriceApi).to.be.a('function');
    });

    it('should export getAppPriceApi', () => {
      const appSpecHelpers = require('../../ZelBack/src/services/utils/appSpecHelpers');
      expect(appSpecHelpers.getAppPriceApi).to.be.a('function');
    });

    it('should export getAppFluxOnChainPrice', () => {
      const appSpecHelpers = require('../../ZelBack/src/services/utils/appSpecHelpers');
      expect(appSpecHelpers.getAppFluxOnChainPrice).to.be.a('function');
    });

    it('should export checkLegacyFreeUpdate from the legacy regime', () => {
      const legacyPricingRegime = require('../../ZelBack/src/services/pricing/legacyPricingRegime');
      expect(legacyPricingRegime.checkLegacyFreeUpdate).to.be.a('function');
    });
  });
});
