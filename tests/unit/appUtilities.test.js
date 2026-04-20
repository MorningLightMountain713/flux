// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const appUtilities = require('../../ZelBack/src/services/utils/appUtilities');
const geolocationService = require('../../ZelBack/src/services/geolocationService');
const dockerService = require('../../ZelBack/src/services/dockerService');
const log = require('../../ZelBack/src/lib/log');

describe('appUtilities tests', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('nodeFullGeolocation tests', () => {
    it('should return formatted geolocation string', async () => {
      sinon.stub(geolocationService, 'getNodeGeolocation').resolves({
        continentCode: 'NA',
        countryCode: 'US',
        regionName: 'California',
      });

      const result = await appUtilities.nodeFullGeolocation();

      expect(result).to.equal('NA_US_California');
    });

    it('should throw error when geolocation not set', async () => {
      sinon.stub(geolocationService, 'getNodeGeolocation').resolves(null);

      try {
        await appUtilities.nodeFullGeolocation();
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Node Geolocation not set');
      }
    });

    it('should handle different continent codes', async () => {
      sinon.stub(geolocationService, 'getNodeGeolocation').resolves({
        continentCode: 'EU',
        countryCode: 'DE',
        regionName: 'Bavaria',
      });

      const result = await appUtilities.nodeFullGeolocation();

      expect(result).to.equal('EU_DE_Bavaria');
    });

    it('should format with underscores', async () => {
      sinon.stub(geolocationService, 'getNodeGeolocation').resolves({
        continentCode: 'AS',
        countryCode: 'JP',
        regionName: 'Tokyo',
      });

      const result = await appUtilities.nodeFullGeolocation();

      expect(result).to.match(/^[A-Z]{2}_[A-Z]{2}_\w+$/);
      expect(result.split('_')).to.have.lengthOf(3);
    });
  });

  // getAppFolderSize tests removed - they execute actual sudo commands
  // which require proper system access. These should be tested in integration tests.

  describe('getContainerStorage tests', () => {
    it('should handle containers with no mounts', async () => {
      sinon.stub(dockerService, 'dockerContainerInspect').resolves({
        SizeRootFs: 1000000,
        Mounts: [],
      });

      const result = await appUtilities.getContainerStorage('testapp');

      expect(result.bind).to.equal(0);
      expect(result.volume).to.equal(0);
      expect(result.rootfs).to.equal(1000000);
      expect(result.used).to.equal(1000000);
      expect(result.status).to.equal('success');
    });

    it('should return error status on failure', async () => {
      sinon.stub(dockerService, 'dockerContainerInspect').rejects(new Error('Container not found'));
      sinon.stub(log, 'error');

      const result = await appUtilities.getContainerStorage('missingapp');

      expect(result.status).to.equal('error');
      expect(result.message).to.include('Container not found');
      expect(result.used).to.equal(0);
    });

    // Tests that require sudo access removed - should be in integration tests
  });

  describe('getAppPorts tests', () => {
    it('should extract port from version 1 app', () => {
      const appSpecs = {
        version: 1,
        port: 8080,
      };

      const ports = appUtilities.getAppPorts(appSpecs);

      expect(ports).to.deep.equal([8080]);
    });

    it('should extract ports from version 2 app', () => {
      const appSpecs = {
        version: 2,
        ports: [8080, 8081, 8082],
      };

      const ports = appUtilities.getAppPorts(appSpecs);

      expect(ports).to.deep.equal([8080, 8081, 8082]);
    });

    it('should extract ports from version 3 app', () => {
      const appSpecs = {
        version: 3,
        ports: [3000, 3001],
      };

      const ports = appUtilities.getAppPorts(appSpecs);

      expect(ports).to.deep.equal([3000, 3001]);
    });

    it('should extract ports from version 4+ composed app', () => {
      const appSpecs = {
        version: 4,
        compose: [
          { name: 'Frontend', ports: [80, 443] },
          { name: 'Backend', ports: [3000] },
          { name: 'Database', ports: [5432] },
        ],
      };

      const ports = appUtilities.getAppPorts(appSpecs);

      expect(ports).to.deep.equal([80, 443, 3000, 5432]);
    });

    it('should convert string ports to numbers for version 1', () => {
      const appSpecs = {
        version: 1,
        port: '8080',
      };

      const ports = appUtilities.getAppPorts(appSpecs);

      expect(ports[0]).to.be.a('number');
      expect(ports[0]).to.equal(8080);
    });

    it('should handle compose with no ports', () => {
      const appSpecs = {
        version: 4,
        compose: [
          { name: 'Worker', ports: [] },
        ],
      };

      const ports = appUtilities.getAppPorts(appSpecs);

      expect(ports).to.be.an('array').that.is.empty;
    });

    it('should handle multiple components with varying ports', () => {
      const appSpecs = {
        version: 5,
        compose: [
          { name: 'Web', ports: [80] },
          { name: 'API', ports: [3000, 3001, 3002] },
          { name: 'Cache', ports: [] },
        ],
      };

      const ports = appUtilities.getAppPorts(appSpecs);

      expect(ports).to.have.lengthOf(4);
      expect(ports).to.include(80);
      expect(ports).to.include(3000);
    });
  });

  describe('module exports tests', () => {
    it('should export all required functions', () => {
      expect(appUtilities.appPricePerMonth).to.be.a('function');
      expect(appUtilities.nodeFullGeolocation).to.be.a('function');
      expect(appUtilities.getAppFolderSize).to.be.a('function');
      expect(appUtilities.getContainerStorage).to.be.a('function');
      expect(appUtilities.getAppPorts).to.be.a('function');
      expect(appUtilities.findCommonArchitectures).to.be.a('function');
    });
  });
});
