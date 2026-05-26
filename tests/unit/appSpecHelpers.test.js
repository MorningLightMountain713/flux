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

function mockClassSpec(plain) {
  const comps = (plain.compose || []).map(mockComponent);
  const componentsObj = {};
  for (const c of comps) componentsObj[c.name] = c;
  return {
    name: plain.name,
    version: plain.version || 4,
    expire: plain.expire,
    staticip: plain.staticip,
    instances: plain.instances,
    nodes: plain.nodes || [],
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
    name: appInfo.name,
    version: appInfo.version || 4,
    hash: appInfo.hash || 'testhash',
    expiresAtHeight,
    isEncrypted: () => false,
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

  describe('roundUpToCharmPrice tests', () => {
    it('should round up to .49 when cents are at most 49', () => {
      expect(appSpecHelpers.roundUpToCharmPrice(1.12)).to.equal('1.49');
      expect(appSpecHelpers.roundUpToCharmPrice(7.01)).to.equal('7.49');
      expect(appSpecHelpers.roundUpToCharmPrice(16.00)).to.equal('16.49');
    });

    it('should round up to .99 when cents are above 49', () => {
      expect(appSpecHelpers.roundUpToCharmPrice(1.50)).to.equal('1.99');
      expect(appSpecHelpers.roundUpToCharmPrice(4.81)).to.equal('4.99');
      expect(appSpecHelpers.roundUpToCharmPrice(20.98)).to.equal('20.99');
    });

    it('should keep a price that already ends in .49 or .99', () => {
      expect(appSpecHelpers.roundUpToCharmPrice(0.99)).to.equal('0.99');
      expect(appSpecHelpers.roundUpToCharmPrice(4.49)).to.equal('4.49');
      expect(appSpecHelpers.roundUpToCharmPrice(2.99)).to.equal('2.99');
    });

    it('should accept the two-decimal strings the price pipeline passes around', () => {
      expect(appSpecHelpers.roundUpToCharmPrice('5.47')).to.equal('5.49');
      expect(appSpecHelpers.roundUpToCharmPrice('10.69')).to.equal('10.99');
    });
  });

  describe('getAppFiatAndFluxPrice tests', () => {
    // 2 vCPU, 5 GB, 30 GB on 3 instances (the test config's minimum): $6.12 at the rates below,
    // and small enough for the Cumulus hardware discount (x0.8), so $4.90 before the rounding.
    const buildSpec = (containerData, extra = {}) => ({
      version: 4,
      name: 'PriceTestApp',
      description: 'price test',
      owner: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
      instances: 3,
      compose: [{
        name: 'server',
        description: 'server',
        repotag: 'runonflux/test:latest',
        ports: [31000],
        domains: [''],
        environmentParameters: [],
        commands: [],
        containerPorts: [8211],
        containerData,
        cpu: 2,
        ram: 5000,
        hdd: 30,
        tiered: false,
      }],
      ...extra,
    });

    const quote = (spec) => new Promise((resolve) => {
      // eslint-disable-next-line global-require
      const { EventEmitter } = require('events');
      const req = new EventEmitter();
      const res = { json: (body) => resolve(body) };
      appSpecHelpers.getAppFiatAndFluxPrice(req, res);
      req.emit('data', JSON.stringify(spec));
      req.emit('end');
    });

    beforeEach(() => {
      // eslint-disable-next-line global-require
      require('../../ZelBack/src/services/utils/cacheManager').default.resetCaches();
      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({ data: { synced: true, height: 2500000 } });
      sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({}) });
      sinon.stub(dbHelper, 'findOneInDatabase').resolves(null);
      sinon.stub(dbHelper, 'findInDatabase').resolves([]);
      sinon.stub(registryManager, 'getApplicationGlobalSpecifications').resolves(null);
      // eslint-disable-next-line global-require
      const axios = require('axios');
      sinon.stub(axios, 'get').callsFake(async (url) => {
        if (url.includes('getappspecsusdprice')) {
          return {
            data: {
              status: 'success',
              data: {
                height: -1, cpu: 0.15, ram: 0.05, hdd: 0.02, minPrice: 0.01, port: 2, scope: 4, staticip: 2, fluxmultiplier: 0.95, multiplier: 1, minUSDPrice: 0.99,
              },
            },
          };
        }
        if (url.includes('listapps')) return { data: { status: 'success', data: [] } };
        // 1 FLUX = 50000 USD/BTC x 0.0000002 BTC = $0.01, so the fiat-derived Flux price is well
        // above the on-chain floor and is the one returned.
        if (url.includes('/rates')) return { data: [[{ code: 'USD', rate: 50000 }], { FLUX: 0.0000002 }] };
        throw new Error(`unexpected url ${url}`);
      });
    });

    it('should quote a g: app the same as the same app without g:', async () => {
      const synced = await quote(buildSpec('g:/data'));
      const plain = await quote(buildSpec('/data'));
      expect(synced.status).to.equal('success');
      expect(plain.status).to.equal('success');
      expect(synced.data.usd).to.equal(plain.data.usd);
    });

    it('should round the final usd price up to .49 or .99', async () => {
      const response = await quote(buildSpec('g:/data'));
      expect(response.data.usd).to.equal(4.99);
    });

    it('should derive the flux price from the rounded usd price', async () => {
      const response = await quote(buildSpec('g:/data'));
      // $4.99 / $0.01 per FLUX x 0.95 fluxmultiplier
      expect(response.data.flux).to.equal(474.05);
    });

    it('should return a caller priceUSD as sent, without rounding it', async () => {
      const response = await quote(buildSpec('g:/data', { priceUSD: 5.1 }));
      expect(response.data.usd).to.equal(5.1);
    });
  });

  describe('module exports tests', () => {
    it('should export getAppFiatAndFluxPrice', () => {
      const appSpecHelpers = require('../../ZelBack/src/services/utils/appSpecHelpers');
      expect(appSpecHelpers.getAppFiatAndFluxPrice).to.be.a('function');
    });

    it('should export getAppPrice', () => {
      const appSpecHelpers = require('../../ZelBack/src/services/utils/appSpecHelpers');
      expect(appSpecHelpers.getAppPrice).to.be.a('function');
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
