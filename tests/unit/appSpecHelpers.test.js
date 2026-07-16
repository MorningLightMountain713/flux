// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const daemonServiceMiscRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceMiscRpcs');
const registryManager = require('../../ZelBack/src/services/appDatabase/registryManager');
const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');

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
  // Legacy-shaped fixtures carry nodes/targetIps as arrays; the Placement
  // contract is a map identity -> null | [replicaNames].
  const toMap = (value) => (Array.isArray(value)
    ? Object.fromEntries(value.map((key) => [key, null]))
    : (value || {}));
  return {
    staticIp: plain.staticip || false,
    dataCenter: plain.datacenter || false,
    geoAllow: [],
    geoDeny: [],
    targetIps: toMap(plain.nodes || plain.targetIps),
    targetOutpoints: toMap(plain.targetOutpoints),
    targetOperators: toMap(plain.targetOperators),
  };
}

function mockClassSpec(plain) {
  const comps = (plain.compose || []).map(mockComponent);
  const componentsObj = {};
  for (const c of comps) componentsObj[c.name] = c;
  return {
    name: plain.name,
    version: plain.version || 4,
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

describe('appSpecHelpers tests', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('checkFreeAppUpdate tests', () => {
    let appSpecHelpers;

    beforeEach(() => {
      appSpecHelpers = proxyquire('../../ZelBack/src/services/utils/appSpecHelpers', {
        './specCutover': {
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
      sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({}) });
      sinon.stub(dbHelper, 'findInDatabase').resolves([]);

      const result = await appSpecHelpers.checkFreeAppUpdate(spec, daemonHeight);
      expect(result).to.be.true;
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
      sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({}) });
      sinon.stub(dbHelper, 'findInDatabase').resolves([]);

      const result = await appSpecHelpers.checkFreeAppUpdate(spec, daemonHeight);
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

      const result = await appSpecHelpers.checkFreeAppUpdate(spec, daemonHeight);
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

      const result = await appSpecHelpers.checkFreeAppUpdate(spec, daemonHeight);
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

      const result = await appSpecHelpers.checkFreeAppUpdate(spec, daemonHeight);
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

      const result = await appSpecHelpers.checkFreeAppUpdate(spec, daemonHeight);
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

      const result = await appSpecHelpers.checkFreeAppUpdate(spec, daemonHeight);
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
      sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({}) });
      sinon.stub(dbHelper, 'findInDatabase').resolves([]);

      const result = await appSpecHelpers.checkFreeAppUpdate(spec, daemonHeight);
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
      sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({}) });
      sinon.stub(dbHelper, 'findInDatabase').resolves([]);

      const result = await appSpecHelpers.checkFreeAppUpdate(spec, daemonHeight);
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

      const result = await appSpecHelpers.checkFreeAppUpdate(spec, daemonHeight);
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

      const result = await appSpecHelpers.checkFreeAppUpdate(spec, daemonHeight);
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

      const result = await appSpecHelpers.checkFreeAppUpdate(spec, daemonHeight);
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
      sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({}) });
      sinon.stub(dbHelper, 'findInDatabase').resolves(recentMessages);

      const result = await appSpecHelpers.checkFreeAppUpdate(spec, daemonHeight);
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
      sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({}) });
      sinon.stub(dbHelper, 'findInDatabase').resolves([]);

      const result = await appSpecHelpers.checkFreeAppUpdate(spec, daemonHeight);
      expect(result).to.be.true;
    });

    it('should return true for v9-to-v9 free update with same TTL', async () => {
      const daemonHeight = 2700000;
      const nowSeconds = Math.floor(Date.now() / 1000);
      const ttl = 2592000; // 30 days
      const spec = mockClassSpec({
        name: 'TestApp',
        version: 9,
        ttl,
        instances: 3,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      });

      const appInfo = {
        name: 'TestApp',
        version: 9,
        ttl,
        instances: 3,
        registeredAt: nowSeconds - 100,
        height: daemonHeight - 3,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      };

      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(mockInstantiatedSpec(appInfo));
      sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({}) });
      sinon.stub(dbHelper, 'findInDatabase').resolves([]);

      const result = await appSpecHelpers.checkFreeAppUpdate(spec, daemonHeight);
      expect(result).to.be.true;
    });

    it('should return false for v9 update that significantly extends TTL', async () => {
      const daemonHeight = 2700000;
      const nowSeconds = Math.floor(Date.now() / 1000);
      const spec = mockClassSpec({
        name: 'TestApp',
        version: 9,
        ttl: 5184000, // 60 days
        instances: 3,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      });

      const appInfo = {
        name: 'TestApp',
        version: 9,
        ttl: 2592000, // 30 days
        instances: 3,
        registeredAt: nowSeconds - 100,
        height: daemonHeight - 3,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      };

      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(mockInstantiatedSpec(appInfo));

      const result = await appSpecHelpers.checkFreeAppUpdate(spec, daemonHeight);
      expect(result).to.be.false;
    });

    it('should return false for v9 update with no TTL', async () => {
      const spec = mockClassSpec({
        name: 'TestApp',
        version: 9,
        ttl: 0,
        instances: 3,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      });

      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(mockInstantiatedSpec({
        name: 'TestApp', version: 9, ttl: 2592000, instances: 3,
        registeredAt: Math.floor(Date.now() / 1000) - 100, height: 2700000,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      }));

      const result = await appSpecHelpers.checkFreeAppUpdate(spec, 2700000);
      expect(result).to.be.false;
    });

    it('should handle v8-to-v9 cross-version free update', async () => {
      const daemonHeight = 2700000;
      const spec = mockClassSpec({
        name: 'TestApp',
        version: 9,
        ttl: 2640000, // 30.5 days ≈ 88000 blocks × 30s
        instances: 3,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      });

      // v8 app with 88000 blocks remaining (~30.5 days)
      const appInfo = {
        name: 'TestApp',
        version: 8,
        expire: 88000,
        instances: 3,
        height: daemonHeight,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      };

      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(mockInstantiatedSpec(appInfo));
      sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({}) });
      sinon.stub(dbHelper, 'findInDatabase').resolves([]);

      const result = await appSpecHelpers.checkFreeAppUpdate(spec, daemonHeight);
      expect(result).to.be.true;
    });

    it('should return false for v7-to-v9 cross-version with TTL extension', async () => {
      const daemonHeight = 2700000;
      const spec = mockClassSpec({
        name: 'TestApp',
        version: 9,
        ttl: 5184000, // 60 days
        instances: 3,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      });

      // v7 app with ~30 days remaining
      const appInfo = {
        name: 'TestApp',
        version: 7,
        expire: 88000,
        instances: 3,
        height: daemonHeight,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      };

      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(mockInstantiatedSpec(appInfo));

      const result = await appSpecHelpers.checkFreeAppUpdate(spec, daemonHeight);
      expect(result).to.be.false;
    });

    it('should return false when v9 target arrays change', async () => {
      const daemonHeight = 2700000;
      const nowSeconds = Math.floor(Date.now() / 1000);
      const ttl = 2592000;
      const spec = mockClassSpec({
        name: 'TestApp',
        version: 9,
        ttl,
        instances: 3,
        targetOutpoints: ['abc:0', 'def:1'],
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      });

      const appInfo = {
        name: 'TestApp',
        version: 9,
        ttl,
        instances: 3,
        targetOutpoints: ['abc:0'],
        registeredAt: nowSeconds - 100,
        height: daemonHeight - 3,
        compose: [{ name: 'main', cpu: 1, ram: 2000, hdd: 50 }],
      };

      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(mockInstantiatedSpec(appInfo));

      const result = await appSpecHelpers.checkFreeAppUpdate(spec, daemonHeight);
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
      // No existing global app -> checkFreeAppUpdate returns false, so the markup path runs.
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

    it('should export checkFreeAppUpdate', () => {
      const appSpecHelpers = require('../../ZelBack/src/services/utils/appSpecHelpers');
      expect(appSpecHelpers.checkFreeAppUpdate).to.be.a('function');
    });
  });
});
