'use strict';

// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const daemonServiceMiscRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceMiscRpcs');
const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');
const { load } = require('@runonflux/flux-spec-cjs');

// The spec doubles below stand in for real version classes, so they must
// declare a pricing model the way a real one does — read from flux-spec rather
// than spelled out here, or a renamed model would leave the doubles agreeing
// with nothing.
let PricingModel;
before(async () => {
  ({ PricingModel } = await load());
});

function mockComponent(plain) {
  return {
    name: plain.name || 'component',
    cpu: plain.cpu || 0,
    memory: plain.ram || 0,
    persistentStorage: { sizeGb: plain.hdd || 0, hasSyncthing: () => false },
    ports: {},
  };
}

function mockPlacement(plain) {
  // The targeting fields are arrays of node identity strings; the free-update
  // bar compares their lengths (the identity SET size). Legacy fixtures name
  // the IP set via `nodes`/`targetIps`.
  const toArray = (value) => (Array.isArray(value) ? value : []);
  return {
    staticIp: plain.staticip || false,
    dataCenter: plain.datacenter || false,
    geoAllow: [],
    geoDeny: [],
    targetIps: toArray(plain.nodes || plain.targetIps),
    targetOutpoints: toArray(plain.targetOutpoints),
    targetOperators: toArray(plain.targetOperators),
  };
}

function mockClassSpec(plain) {
  const comps = (plain.compose || []).map(mockComponent);
  const componentsObj = {};
  for (const c of comps) componentsObj[c.name] = c;
  const version = plain.version || 4;
  return {
    name: plain.name,
    version,
    pricingModel: version >= 9 ? PricingModel.UNIFIED : PricingModel.CHAIN_FLOOR,
    expire: plain.expire,
    ttl: plain.ttl,
    instances: plain.instances,
    placement: mockPlacement(plain),
    components: componentsObj,
    componentCount: comps.length,
    getComponent(name) { return componentsObj[name]; },
    componentNames() { return Object.keys(componentsObj); },
    componentEntries() { return Object.entries(componentsObj); },
    firstComponent() { return comps[0]; },
  };
}

function mockInstantiatedSpec(appInfo) {
  if (!appInfo) return null;
  const classSpec = mockClassSpec(appInfo);
  const PON_FORK = 2020000;
  const defaultExpire = appInfo.height >= PON_FORK ? 88000 : 22000;
  const expire = appInfo.expire || defaultExpire;
  let expiresAtHeight = appInfo.height + expire;
  if (appInfo.height < PON_FORK) {
    const naive = appInfo.height + expire;
    if (naive > PON_FORK) {
      expiresAtHeight = PON_FORK + ((naive - PON_FORK) * 4);
    }
  }
  return {
    spec: classSpec,
    height: appInfo.height,
    registeredAt: appInfo.registeredAt || null,
    name: appInfo.name,
    version: appInfo.version || 4,
    hash: appInfo.hash || 'testhash',
    expiresAtHeight,
    isEncrypted: false,
    serialize: () => ({ ...appInfo }),
  };
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
  afterEach(() => {
    sinon.restore();
  });

  describe('checkLegacyFreeUpdate tests', () => {
    let legacyRegime;

    beforeEach(() => {
      legacyRegime = proxyquire('../../ZelBack/src/services/pricing/legacyPricingRegime', {
        '../utils/specCutover': {
          resolveSpec: sinon.stub().callsFake(async (doc) => mockClassSpec(doc)),
          // seam decrypts the held instance; cleartext resolves to its own spec
          resolveInstantiatedSpec: sinon.stub().callsFake(async (inst) => inst.spec),
        },
      });
    });

    it('should return true for free update with no resource changes', async () => {
      const daemonHeight = 100000;
      const spec = mockClassSpec({
        name: 'TestApp',
        instances: 5,
        staticip: false,
        nodes: [],
        expire: 44000,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      });

      const appInfo = {
        name: 'TestApp',
        version: 4,
        instances: 5,
        staticip: false,
        nodes: [],
        expire: 44000,
        height: daemonHeight + 44000 - spec.expire,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      };

      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(mockInstantiatedSpec(appInfo));
      sinon.stub(appsRepository, 'listAppMessagesByName').resolves([]);

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.true;
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

      function setup(updates) {
        const spec = mockClassSpec({
          name: 'RateApp', instances: 5, staticip: false, nodes: [], expire: 44000,
          compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
        });
        const appInfo = {
          name: 'RateApp', version: 4, instances: 5, staticip: false, nodes: [],
          expire: 44000, height: daemonHeight + 44000 - spec.expire,
          compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
        };
        sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(mockInstantiatedSpec(appInfo));
        sinon.stub(appsRepository, 'listAppMessagesByName').resolves(updates);
        return spec;
      }

      // `hoursAgo` back from the tip, in blocks.
      const updatesAgo = (count, hoursAgo) => Array.from({ length: count }, () => ({
        type: 'fluxappupdate',
        height: daemonHeight - Math.round(hoursAgo * BLOCKS_PER_HOUR),
      }));

      it('allows 5 updates inside 24 hours but not 6', async () => {
        expect(await legacyRegime.checkLegacyFreeUpdate(setup(updatesAgo(5, 12)), daemonHeight)).to.equal(true);
        sinon.restore();
        expect(await legacyRegime.checkLegacyFreeUpdate(setup(updatesAgo(6, 12)), daemonHeight)).to.equal(false);
      });

      // 6 updates would breach the 24h cap, so placing them 30h back proves the
      // 24h window really ends at 24h and not at the old 6h.
      it('counts a 30-hour-old update as outside the 24-hour window', async () => {
        expect(await legacyRegime.checkLegacyFreeUpdate(setup(updatesAgo(6, 30)), daemonHeight)).to.equal(true);
      });

      it('allows 8 updates inside 48 hours but not 9', async () => {
        expect(await legacyRegime.checkLegacyFreeUpdate(setup(updatesAgo(8, 36)), daemonHeight)).to.equal(true);
        sinon.restore();
        expect(await legacyRegime.checkLegacyFreeUpdate(setup(updatesAgo(9, 36)), daemonHeight)).to.equal(false);
      });

      it('allows 10 updates inside 120 hours but not 11', async () => {
        expect(await legacyRegime.checkLegacyFreeUpdate(setup(updatesAgo(10, 100)), daemonHeight)).to.equal(true);
        sinon.restore();
        expect(await legacyRegime.checkLegacyFreeUpdate(setup(updatesAgo(11, 100)), daemonHeight)).to.equal(false);
      });

      it('ignores updates older than the widest window', async () => {
        expect(await legacyRegime.checkLegacyFreeUpdate(setup(updatesAgo(50, 200)), daemonHeight)).to.equal(true);
      });

      it('counts only update messages, not the original registration', async () => {
        const registrations = Array.from({ length: 20 }, () => ({
          type: 'fluxappregister', height: daemonHeight - 10,
        }));
        expect(await legacyRegime.checkLegacyFreeUpdate(setup(registrations), daemonHeight)).to.equal(true);
      });
    });

    it('should allow free update when components are reordered', async () => {
      const daemonHeight = 100000;
      const spec = mockClassSpec({
        name: 'TestApp',
        instances: 5,
        staticip: false,
        nodes: [],
        expire: 44000,
        compose: [
          { name: 'B', cpu: 2, ram: 4000, hdd: 100 },
          { name: 'A', cpu: 1, ram: 2000, hdd: 50 },
        ],
      });

      const appInfo = {
        name: 'TestApp',
        version: 4,
        instances: 5,
        staticip: false,
        nodes: [],
        expire: 44000,
        height: daemonHeight + 44000 - spec.expire,
        compose: [
          { name: 'A', cpu: 1, ram: 2000, hdd: 50 },
          { name: 'B', cpu: 2, ram: 4000, hdd: 100 },
        ],
      };

      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(mockInstantiatedSpec(appInfo));
      sinon.stub(appsRepository, 'listAppMessagesByName').resolves([]);

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.true;
    });

    it('should return false when CPU increased', async () => {
      const daemonHeight = 100000;
      const spec = mockClassSpec({
        name: 'TestApp',
        instances: 5,
        staticip: false,
        expire: 44000,
        compose: [{ name: 'main', cpu: 2, ram: 2000, hdd: 50 }],
      });

      const appInfo = {
        name: 'TestApp',
        version: 4,
        instances: 5,
        staticip: false,
        expire: 44000,
        height: 56000,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      };

      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(mockInstantiatedSpec(appInfo));

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.false;
    });

    it('should return false when RAM increased', async () => {
      const daemonHeight = 100000;
      const spec = mockClassSpec({
        name: 'TestApp',
        instances: 5,
        staticip: false,
        expire: 44000,
        compose: [{ name: 'main', cpu: 1, ram: 4000, hdd: 50 }],
      });

      const appInfo = {
        name: 'TestApp',
        version: 4,
        instances: 5,
        staticip: false,
        expire: 44000,
        height: 56000,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      };

      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(mockInstantiatedSpec(appInfo));

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.false;
    });

    it('should return false when HDD increased', async () => {
      const daemonHeight = 100000;
      const spec = mockClassSpec({
        name: 'TestApp',
        instances: 5,
        staticip: false,
        expire: 44000,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 100 }],
      });

      const appInfo = {
        name: 'TestApp',
        version: 4,
        instances: 5,
        staticip: false,
        expire: 44000,
        height: 56000,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      };

      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(mockInstantiatedSpec(appInfo));

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.false;
    });

    it('should return false when instances changed', async () => {
      const daemonHeight = 100000;
      const spec = mockClassSpec({
        name: 'TestApp',
        instances: 10,
        staticip: false,
        expire: 44000,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      });

      const appInfo = {
        name: 'TestApp',
        version: 4,
        instances: 5,
        staticip: false,
        expire: 44000,
        height: 56000,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      };

      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(mockInstantiatedSpec(appInfo));

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.false;
    });

    it('should return false when staticip changed', async () => {
      const daemonHeight = 100000;
      const spec = mockClassSpec({
        name: 'TestApp',
        instances: 5,
        staticip: true,
        expire: 44000,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      });

      const appInfo = {
        name: 'TestApp',
        version: 4,
        instances: 5,
        staticip: false,
        expire: 44000,
        height: 56000,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      };

      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(mockInstantiatedSpec(appInfo));

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.false;
    });

    it('should treat undefined staticip as false (legacy DB records)', async () => {
      const daemonHeight = 100000;
      const spec = mockClassSpec({
        name: 'TestApp',
        instances: 5,
        staticip: false,
        nodes: [],
        expire: 44000,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      });

      const appInfo = {
        name: 'TestApp',
        version: 4,
        instances: 5,
        nodes: [],
        expire: 44000,
        height: daemonHeight + 44000 - spec.expire,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      };

      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(mockInstantiatedSpec(appInfo));
      sinon.stub(appsRepository, 'listAppMessagesByName').resolves([]);

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.true;
    });

    it('should handle PON fork adjustment for pre-fork apps (free update)', async () => {
      const daemonHeight = 2256730;
      const spec = mockClassSpec({
        name: 'PresearchNode',
        instances: 12,
        staticip: false,
        nodes: [],
        expire: 100,
        compose: [{ name: 'node', cpu: 0.3, ram: 300, hdd: 2 }],
      });

      const appInfo = {
        name: 'PresearchNode',
        version: 4,
        instances: 12,
        staticip: false,
        nodes: [],
        expire: 244085,
        height: 1837757,
        compose: [{ name: 'node', cpu: 0.3, ram: 300, hdd: 2 }],
      };

      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(mockInstantiatedSpec(appInfo));
      sinon.stub(appsRepository, 'listAppMessagesByName').resolves([]);

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.true;
    });

    it('should return false when component count changed', async () => {
      const daemonHeight = 100000;
      const spec = mockClassSpec({
        name: 'TestApp',
        instances: 5,
        staticip: false,
        expire: 44000,
        compose: [
          { name: 'a', cpu: 1, ram: 2000, hdd: 50 },
          { name: 'b', cpu: 1, ram: 2000, hdd: 50 },
        ],
      });

      const appInfo = {
        name: 'TestApp',
        version: 4,
        instances: 5,
        staticip: false,
        expire: 44000,
        height: 56000,
        compose: [{ name: 'a', cpu: 1, ram: 2000, hdd: 50 }],
      };

      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(mockInstantiatedSpec(appInfo));

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.false;
    });

    it('should return false when app does not exist', async () => {
      const spec = mockClassSpec({
        name: 'NewApp',
        expire: 44000,
        compose: [],
      });
      const daemonHeight = 100000;

      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(null);

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.false;
    });

    it('should return false when blocksToExtend > 8', async () => {
      const daemonHeight = 100000;
      const spec = mockClassSpec({
        name: 'TestApp',
        instances: 5,
        staticip: false,
        expire: 50000,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      });

      const appInfo = {
        name: 'TestApp',
        version: 4,
        instances: 5,
        staticip: false,
        expire: 44003,
        height: 94003,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      };

      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(mockInstantiatedSpec(appInfo));

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.false;
    });

    it('should return false when too many updates in recent period', async () => {
      const daemonHeight = 100000;
      const spec = mockClassSpec({
        name: 'TestApp',
        instances: 5,
        staticip: false,
        expire: 44000,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      });

      const appInfo = {
        name: 'TestApp',
        version: 4,
        instances: 5,
        staticip: false,
        expire: 44000,
        height: 56000,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      };

      const recentMessages = Array(11).fill({
        type: 'fluxappupdate',
        height: 99000,
      });

      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(mockInstantiatedSpec(appInfo));
      sinon.stub(appsRepository, 'listAppMessagesByName').resolves(recentMessages);

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.false;
    });

    it('should allow resources to decrease for free update', async () => {
      const daemonHeight = 100000;
      const spec = mockClassSpec({
        name: 'TestApp',
        instances: 5,
        staticip: false,
        nodes: [],
        expire: 44000,
        compose: [{ name: 'main', cpu: 0.5, ram: 1000, hdd: 25 }],
      });

      const appInfo = {
        name: 'TestApp',
        version: 4,
        instances: 5,
        staticip: false,
        nodes: [],
        expire: 44000,
        height: daemonHeight + 44000 - spec.expire,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      };

      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(mockInstantiatedSpec(appInfo));
      sinon.stub(appsRepository, 'listAppMessagesByName').resolves([]);

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.true;
    });

    // The quote endpoint accepts whatever spec the caller posts, so a legacy
    // spec can arrive for an app that is already registered at v9. Consensus
    // can never accept that update (UpdatePolicy.assertVersionTransition), so
    // the legacy rule must not offer it for free. Every other condition here
    // passes, and the terms match to within the 8-block bar once the v9 ttl is
    // read as seconds — so this returns true unless the regime boundary holds.
    it('should return false when the registered app is v9', async () => {
      const daemonHeight = 2700000;
      const spec = mockClassSpec({
        name: 'TestApp',
        version: 8,
        expire: 88000,
        instances: 3,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      });

      const appInfo = {
        name: 'TestApp',
        version: 9,
        ttl: 2640000,
        instances: 3,
        registeredAt: Math.floor(Date.now() / 1000) - 100,
        height: daemonHeight - 3,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      };

      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(mockInstantiatedSpec(appInfo));
      sinon.stub(appsRepository, 'listAppMessagesByName').resolves([]);

      const result = await legacyRegime.checkLegacyFreeUpdate(spec, daemonHeight);
      expect(result).to.be.false;
    });
  });

  describe('getAppFluxOnChainPrice tests', () => {
    it('should throw error when daemon not synced', async () => {
      const appSpec = {
        version: 8,
        name: 'TestApp',
        description: 'Test app',
        owner: 'owner123',
        instances: 3,
        contacts: [],
        geolocation: [],
        expire: 22000,
        nodes: [],
        staticip: false,
        enterprise: '',
        compose: [{
          name: 'TestApp',
          description: 'Main component',
          repotag: 'test/app:v1',
          ports: [3000],
          domains: [],
          environmentParameters: [],
          commands: [],
          containerPorts: [3000],
          containerData: '/data',
          cpu: 1,
          ram: 2000,
          hdd: 50,
          repoauth: '',
        }],
      };

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

    const v9Spec = {
      version: 9,
      // a getter: the model is read from flux-spec in a before hook, after this
      // literal is built
      get pricingModel() { return PricingModel.UNIFIED; },
      name: 'markuptest',
      instances: 3,
      ttl: 2592000,
      placement: { staticIp: false, dataCenter: false, geoAllow: null, geoDeny: null },
      network: { mesh: false },
      telemetry: null,
      components: {
        web: {
          cpu: 0.5, memory: 512, rootFsGb: 1, swapGb: 0,
          persistentStorage: { sizeGb: 5, sync: null, mounts: {} },
          ports: { http: { hostPort: 31000, containerPort: 80, protocol: 'tcp' } },
          loadBalancing: null, shutdown: null, preStop: null, imageAuth: null,
        },
      },
    };

    // PriceMessage rates so the engine prices the spec to a non-zero FLUX figure.
    const priceFields = {
      cpuRate: 150000, memoryRate: 50000, storageRate: 20000,
      stdPortRate: 0, premPortRate: 2000000, staticIpRate: 2000000,
      minPrice: 990000, minPriceFluxSats: 1000000,
    };

    beforeEach(() => {
      appSpecHelpers = proxyquire('../../ZelBack/src/services/utils/appSpecHelpers', {
        './specCutover': { resolveSpec: sinon.stub().resolves(v9Spec) },
      });
      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({ data: { synced: true, height: 200 } });
      // No existing global app -> checkLegacyFreeUpdate returns false, so the markup path runs.
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(null);
      sinon.stub(priceOracleState, 'getPriceMessageHistory').returns({ resolveAt: () => priceFields });
      // fluxUsdPriceE4 = 10000 -> $1.00 / FLUX, so usd/flux isolates the markup factor.
      sinon.stub(priceOracleState, 'getRateMessageHistory').returns({ resolveAt: () => ({ fluxUsdPriceE4: 10000 }) });
      sinon.stub(priceOracleState, 'getPriceModifierHistory').returns({ resolveAt: () => ({ fiatMarkupBp: 500 }) });
      sinon.stub(priceOracleState, 'getMarketplacePricingHistory').returns(null);
    });

    it('applies fiatMarkupBp as a basis-points markup (500 -> +5%) and returns fluxDiscount as a percent', async () => {
      const result = await appSpecHelpers.getAppFiatAndFluxPrice(v9Spec);
      expect(result.fiatMarkupBp).to.equal(500);
      expect(result.fluxDiscount).to.equal(5); // 500 / 100, display percent
      expect(result.flux).to.be.greaterThan(0);
      expect(result.usd / result.flux).to.be.closeTo(1.05, 0.01); // 1 + 500/10000
    });

    it('applies no markup when fiatMarkupBp is absent (usd == flux at $1/FLUX)', async () => {
      priceOracleState.getPriceModifierHistory.restore();
      sinon.stub(priceOracleState, 'getPriceModifierHistory').returns({ resolveAt: () => ({}) });
      const result = await appSpecHelpers.getAppFiatAndFluxPrice(v9Spec);
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
  // front of the v9 path and answer first.
  describe('pricing regimes — legacy quotes locally, v9 quotes what consensus charges', () => {
    const priceOracleState = require('../../ZelBack/src/services/pricing/priceOracleState');

    const priceFields = {
      cpuRate: 150000, memoryRate: 50000, storageRate: 20000,
      stdPortRate: 0, premPortRate: 2000000, staticIpRate: 2000000,
      minPrice: 990000, minPriceFluxSats: 1000000,
      // A non-zero fee on a feature, so "feature added" is observable in the price.
      meshFee: 500000,
    };

    const v9Component = () => ({
      name: 'web',
      cpu: 0.5, memory: 512, rootFsGb: 1, swapGb: 0,
      persistentStorage: { sizeGb: 5, sync: null, mounts: {} },
      ports: { http: { hostPort: 31000, containerPort: 80, protocol: 'tcp' } },
      loadBalancing: null, shutdown: null, preStop: null, imageAuth: null,
    });

    // Shaped like a resolved spec instance, not just the canonical body — the
    // legacy rule reads componentEntries()/getComponent(), so a plain object
    // would fail there rather than exercising the rule under test.
    const v9SpecWith = (over = {}) => ({
      version: 9,
      pricingModel: PricingModel.UNIFIED,
      name: 'regimetest',
      instances: 3,
      ttl: 2592000,
      componentEntries() { return Object.entries(this.components); },
      componentNames() { return Object.keys(this.components); },
      getComponent(name) { return this.components[name]; },
      placement: {
        staticIp: false,
        dataCenter: false,
        geoAllow: null,
        geoDeny: null,
        targetIps: [],
        targetOutpoints: [],
        targetOperators: [],
        equals(other) {
          return this.staticIp === other.staticIp && this.dataCenter === other.dataCenter;
        },
      },
      network: { mesh: false },
      telemetry: null,
      isEncrypted: false,
      components: { web: v9Component() },
      ...over,
    });

    // An existing registration of the same app, so the quote takes the UPDATE
    // path (priceUpdate) rather than the registration path. registeredAt is
    // "just now" on purpose: it leaves the subscription unextended, which is
    // what the legacy rule requires before it will call an update free. A stale
    // value makes the legacy rule reject on time alone, and the feature test
    // below would then pass without proving anything.
    const existingRegistration = {
      name: 'regimetest',
      height: 100,
      registeredAt: Math.floor(Date.now() / 1000),
      isEncrypted: false,
    };

    // `messages` becomes the free-update rate-limit input.
    function buildHelpers({ newSpec, prevSpec, messages = [] }) {
      const helpers = buildAppSpecHelpers({
        resolveSpec: sinon.stub().resolves(newSpec),
        resolveInstantiatedSpec: sinon.stub().resolves(prevSpec),
      });
      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({ data: { synced: true, height: 200 } });
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(existingRegistration);
      sinon.stub(appsRepository, 'listAppMessagesByName').resolves(messages);
      sinon.stub(priceOracleState, 'getPriceMessageHistory').returns({ resolveAt: () => priceFields });
      sinon.stub(priceOracleState, 'getRateMessageHistory').returns({ resolveAt: () => ({ fluxUsdPriceE4: 10000 }) });
      sinon.stub(priceOracleState, 'getPriceModifierHistory').returns({ resolveAt: () => ({}) });
      sinon.stub(priceOracleState, 'getMarketplacePricingHistory').returns(null);
      return helpers;
    }

    const updatesAt = (count, msAgo) => Array.from({ length: count }, () => ({
      type: 'fluxappupdate', timestamp: Date.now() - msAgo,
    }));

    it('v9: an unchanged update quotes zero — priceUpdate decided it was free', async () => {
      const helpers = buildHelpers({ newSpec: v9SpecWith(), prevSpec: v9SpecWith() });
      const result = await helpers.getAppFiatAndFluxPrice(v9SpecWith());
      expect(result.flux).to.equal(0);
      expect(result.usd).to.equal(0);
    });

    // The decisive one. The legacy rule does not look at features at all, so it
    // would call this free. The v9 rule rejects any added feature. A non-zero
    // quote proves the v9 path is answering with the v9 rule.
    it('v9: adding a feature is charged, though the legacy rule would call it free', async () => {
      const helpers = buildHelpers({
        newSpec: v9SpecWith({ network: { mesh: true } }),
        prevSpec: v9SpecWith(),
      });
      const result = await helpers.getAppFiatAndFluxPrice(v9SpecWith({ network: { mesh: true } }));
      expect(result.flux).to.be.greaterThan(0);
    });

    // The free-update cap is 5 in 24h. Without a populated event list it can
    // never fire, and every free update is granted forever.
    it('v9: the free-update rate limit fires once the history is fed to it', async () => {
      const helpers = buildHelpers({
        newSpec: v9SpecWith(),
        prevSpec: v9SpecWith(),
        messages: updatesAt(5, 60 * 60 * 1000),
      });
      const result = await helpers.getAppFiatAndFluxPrice(v9SpecWith());
      expect(result.flux).to.be.greaterThan(0);
    });

    // The witness for "Display == consensus". Both sides must reach the same
    // figure; a comment saying so proves nothing, so price the same update
    // through each and compare. Consensus returns satoshis, the quote FLUX.
    it('v9: the quote equals the fee consensus charges', async () => {
      const newSpec = v9SpecWith({ network: { mesh: true } });
      const prevSpec = v9SpecWith();
      const helpers = buildHelpers({ newSpec, prevSpec });

      const quote = await helpers.getAppFiatAndFluxPrice(newSpec);

      // eslint-disable-next-line global-require
      const messageVerifier = require('../../ZelBack/src/services/appMessaging/messageVerifier');
      const consensusSats = await messageVerifier.computeUpdateFee(
        newSpec,
        prevSpec,
        200,
        existingRegistration.height,
        existingRegistration.registeredAt,
        Math.floor(Date.now() / 1000),
      );

      expect(quote.flux).to.be.greaterThan(0);
      expect(Number(consensusSats) / 1e8).to.equal(quote.flux);
    });

    it('v9: a free update is free on both sides, not just on the quote', async () => {
      const newSpec = v9SpecWith();
      const prevSpec = v9SpecWith();
      const helpers = buildHelpers({ newSpec, prevSpec });

      const quote = await helpers.getAppFiatAndFluxPrice(newSpec);

      // eslint-disable-next-line global-require
      const messageVerifier = require('../../ZelBack/src/services/appMessaging/messageVerifier');
      const consensusSats = await messageVerifier.computeUpdateFee(
        newSpec,
        prevSpec,
        200,
        existingRegistration.height,
        existingRegistration.registeredAt,
        Math.floor(Date.now() / 1000),
      );

      expect(quote.flux).to.equal(0);
      expect(consensusSats).to.equal(0n);
    });

    it('v9: the quote reads the real message history rather than an empty list', async () => {
      const helpers = buildHelpers({ newSpec: v9SpecWith(), prevSpec: v9SpecWith() });
      await helpers.getAppFiatAndFluxPrice(v9SpecWith());
      expect(appsRepository.listAppMessagesByName.calledWith('regimetest')).to.equal(true);
    });

    // Legacy keeps its own rule: its on-chain floor is near zero, so the
    // display price is the real price and this is what waives it. Driven end to
    // end through the quote entry point, so it also pins that a legacy spec is
    // routed to the legacy regime.
    it('v1-v8: the legacy free-update rule still decides the quote', async () => {
      const legacySpec = mockClassSpec({
        name: 'legacyapp',
        version: 8,
        instances: 5,
        expire: 44000,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      });
      const daemonHeight = 100000;
      const appInfo = {
        name: 'legacyapp',
        version: 8,
        instances: 5,
        expire: 44000,
        height: daemonHeight,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      };

      const helpers = buildAppSpecHelpers({
        resolveSpec: sinon.stub().resolves(legacySpec),
        resolveInstantiatedSpec: sinon.stub().callsFake(async (inst) => inst.spec),
      });
      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({ data: { synced: true, height: daemonHeight } });
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(mockInstantiatedSpec(appInfo));
      sinon.stub(appsRepository, 'listAppMessagesByName').resolves([]);

      // The subscription is unextended and nothing grew, so the legacy rule
      // waives the price outright. Reaching a real quote instead would mean the
      // rule never ran.
      const result = await helpers.getAppFiatAndFluxPrice(legacySpec);
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
