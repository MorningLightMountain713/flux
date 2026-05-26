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
