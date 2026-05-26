const { expect } = require('chai');
const sinon = require('sinon');
const config = require('config');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const resourceQueryService = require('../../ZelBack/src/services/appQuery/resourceQueryService');
const messageHelper = require('../../ZelBack/src/services/messageHelper');
const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');
const hwRequirements = require('../../ZelBack/src/services/appRequirements/hwRequirements');
const appQueryService = require('../../ZelBack/src/services/appQuery/appQueryService');
const { requireMongo } = require('./dbTestHelper');

describe('resourceQueryService tests', () => {
  before(requireMongo);

  afterEach(() => {
    sinon.restore();
  });

  describe('fluxUsage tests', () => {
    it('should return flux usage statistics', async () => {
      const req = {};
      const res = {
        json: sinon.stub(),
      };

      sinon.stub(appsRepository, 'countInstalledApps').resolves(3);
      sinon.stub(appQueryService, 'listRunningApps').resolves({
        status: 'success',
        data: [
          { name: 'App1' },
          { name: 'App2' },
        ],
      });
      sinon.stub(hwRequirements, 'getNodeSpecs').resolves({
        cpuCores: 8,
        ram: 16000,
        ssdStorage: 500,
      });
      sinon.stub(messageHelper, 'createDataMessage').callsFake((data) => ({ status: 'success', data }));

      await resourceQueryService.fluxUsage(req, res);

      sinon.assert.calledOnce(res.json);
      const response = res.json.firstCall.args[0];
      expect(response.data.totalApps).to.equal(3);
      expect(response.data.runningApps).to.equal(2);
      expect(response.data.stoppedApps).to.equal(1);
      expect(response.data.nodeSpecs.cpuCores).to.equal(8);
    });

    it('should work without response object', async () => {
      sinon.stub(appsRepository, 'countInstalledApps').resolves(0);
      sinon.stub(appQueryService, 'listRunningApps').resolves({
        status: 'success',
        data: [],
      });
      sinon.stub(hwRequirements, 'getNodeSpecs').resolves({
        cpuCores: 8,
        ram: 16000,
        ssdStorage: 500,
      });
      sinon.stub(messageHelper, 'createDataMessage').callsFake((data) => ({ status: 'success', data }));

      const result = await resourceQueryService.fluxUsage(null, null);

      expect(result.status).to.equal('success');
      expect(result.data.totalApps).to.equal(0);
    });

    it('should handle error gracefully', async () => {
      const req = {};
      const res = {
        json: sinon.stub(),
      };

      sinon.stub(appsRepository, 'countInstalledApps').rejects(new Error('Database error'));
      sinon.stub(messageHelper, 'createErrorMessage').returns({ status: 'error' });

      await resourceQueryService.fluxUsage(req, res);

      sinon.assert.calledOnce(res.json);
      expect(res.json.firstCall.args[0].status).to.equal('error');
    });

    it('should handle missing running apps data', async () => {
      const req = {};
      const res = {
        json: sinon.stub(),
      };

      sinon.stub(appsRepository, 'countInstalledApps').resolves(1);
      sinon.stub(appQueryService, 'listRunningApps').resolves({
        status: 'error',
      });
      sinon.stub(hwRequirements, 'getNodeSpecs').resolves({
        cpuCores: 8,
        ram: 16000,
        ssdStorage: 500,
      });
      sinon.stub(messageHelper, 'createDataMessage').callsFake((data) => ({ status: 'success', data }));

      await resourceQueryService.fluxUsage(req, res);

      sinon.assert.calledOnce(res.json);
      const response = res.json.firstCall.args[0];
      expect(response.data.runningApps).to.equal(0);
    });
  });

  describe('appsResources tests', () => {
    let db;
    let database;

    beforeEach(async () => {
      await dbHelper.initiateDB();
      db = dbHelper.databaseConnection();
      database = db.db(config.database.appslocal.database);
    });

    it('should calculate resources for version 3 non-tiered apps', async () => {
      const req = {};
      const res = {
        json: sinon.stub(),
      };

      const collection = config.database.appslocal.collections.appsInformation;
      const testApps = [
        {
          name: 'App1',
          version: 3,
          description: 'Test app 1',
          owner: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
          repotag: 'test/app1:latest',
          ports: ['30001'],
          containerPorts: ['8080'],
          domains: [''],
          containerData: '',
          tiered: false,
          cpu: 2,
          ram: 4000,
          hdd: 50,
          instances: 3,
        },
        {
          name: 'App2',
          version: 3,
          description: 'Test app 2',
          owner: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
          repotag: 'test/app2:latest',
          ports: ['30002'],
          containerPorts: ['8081'],
          domains: [''],
          containerData: '',
          tiered: false,
          cpu: 1,
          ram: 2000,
          hdd: 25,
          instances: 3,
        },
      ];

      try {
        await database.collection(collection).drop();
      } catch (err) {
        // Collection doesn't exist
      }
      await dbHelper.insertManyToDatabase(database, collection, testApps);

      sinon.stub(messageHelper, 'createDataMessage').callsFake((data) => ({ status: 'success', data }));

      await resourceQueryService.appsResources(req, res);

      sinon.assert.calledOnce(res.json);
      const response = res.json.firstCall.args[0];
      expect(response.data.appsCpusLocked).to.equal(3);
      expect(response.data.appsRamLocked).to.equal(6000);
      expect(response.data.appsHddLocked).to.be.greaterThan(75); // Base HDD + filesystem overhead
    });

    it('should calculate resources for version 3 tiered apps using base values', async () => {
      const req = {};
      const res = {
        json: sinon.stub(),
      };

      const collection = config.database.appslocal.collections.appsInformation;
      const testApps = [
        {
          name: 'App1',
          version: 3,
          description: 'Test tiered app',
          owner: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
          repotag: 'test/app1:latest',
          ports: ['30001'],
          containerPorts: ['8080'],
          domains: [''],
          containerData: '',
          tiered: true,
          cpu: 1,
          ram: 2000,
          hdd: 25,
          cpubasic: 0.5,
          cpusuper: 2,
          cpubamf: 4,
          rambasic: 1000,
          ramsuper: 4000,
          rambamf: 8000,
          hddbasic: 10,
          hddsuper: 50,
          hddbamf: 100,
          instances: 3,
        },
      ];

      try {
        await database.collection(collection).drop();
      } catch (err) {
        // Collection doesn't exist
      }
      await dbHelper.insertManyToDatabase(database, collection, testApps);

      sinon.stub(messageHelper, 'createDataMessage').callsFake((data) => ({ status: 'success', data }));

      await resourceQueryService.appsResources(req, res);

      sinon.assert.calledOnce(res.json);
      const response = res.json.firstCall.args[0];
      // DeploymentSpec uses the base cpu/ram/hdd values, not the tiered variants
      expect(response.data.appsCpusLocked).to.equal(1);
      expect(response.data.appsRamLocked).to.equal(2000);
      expect(response.data.appsHddLocked).to.be.greaterThan(25);
    });

    it('should calculate resources for version 4+ compose apps', async () => {
      const req = {};
      const res = {
        json: sinon.stub(),
      };

      const collection = config.database.appslocal.collections.appsInformation;
      const testApps = [
        {
          name: 'App1',
          version: 4,
          description: 'Test compose app',
          owner: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
          instances: 3,
          compose: [
            {
              name: 'Component1', repotag: 'test/c1:latest', cpu: 1, ram: 2000, hdd: 20,
              ports: ['30001'], containerPorts: ['8080'], domains: [''], containerData: '',
            },
            {
              name: 'Component2', repotag: 'test/c2:latest', cpu: 2, ram: 4000, hdd: 30,
              ports: ['30002'], containerPorts: ['8081'], domains: [''], containerData: '',
            },
          ],
        },
      ];

      try {
        await database.collection(collection).drop();
      } catch (err) {
        // Collection doesn't exist
      }
      await dbHelper.insertManyToDatabase(database, collection, testApps);

      sinon.stub(messageHelper, 'createDataMessage').callsFake((data) => ({ status: 'success', data }));

      await resourceQueryService.appsResources(req, res);

      sinon.assert.calledOnce(res.json);
      const response = res.json.firstCall.args[0];
      expect(response.data.appsCpusLocked).to.equal(3);
      expect(response.data.appsRamLocked).to.equal(6000);
      expect(response.data.appsHddLocked).to.be.greaterThan(50);
    });

    it('should calculate resources for tiered compose apps using base values', async () => {
      const req = {};
      const res = {
        json: sinon.stub(),
      };

      const collection = config.database.appslocal.collections.appsInformation;
      const testApps = [
        {
          name: 'App1',
          version: 4,
          description: 'Test tiered compose app',
          owner: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
          instances: 3,
          compose: [
            {
              name: 'Component1',
              repotag: 'test/c1:latest',
              tiered: true,
              cpu: 1,
              ram: 2000,
              hdd: 20,
              cpubasic: 0.5,
              cpusuper: 1.5,
              cpubamf: 2,
              rambasic: 1000,
              ramsuper: 3000,
              rambamf: 4000,
              hddbasic: 10,
              hddsuper: 30,
              hddbamf: 40,
              ports: ['30001'],
              containerPorts: ['8080'],
              domains: [''],
              containerData: '',
            },
            {
              name: 'Component2',
              repotag: 'test/c2:latest',
              tiered: false,
              cpu: 1,
              ram: 2000,
              hdd: 20,
              ports: ['30002'],
              containerPorts: ['8081'],
              domains: [''],
              containerData: '',
            },
          ],
        },
      ];

      try {
        await database.collection(collection).drop();
      } catch (err) {
        // Collection doesn't exist
      }
      await dbHelper.insertManyToDatabase(database, collection, testApps);

      sinon.stub(messageHelper, 'createDataMessage').callsFake((data) => ({ status: 'success', data }));

      await resourceQueryService.appsResources(req, res);

      sinon.assert.calledOnce(res.json);
      const response = res.json.firstCall.args[0];
      // DeploymentSpec uses the base cpu/ram/hdd values, not the tiered variants
      expect(response.data.appsCpusLocked).to.equal(2);
      expect(response.data.appsRamLocked).to.equal(4000);
      expect(response.data.appsHddLocked).to.be.greaterThan(40);
    });

    it('should work without response object', async () => {
      const collection = config.database.appslocal.collections.appsInformation;

      try {
        await database.collection(collection).drop();
      } catch (err) {
        // Collection doesn't exist
      }

      sinon.stub(messageHelper, 'createDataMessage').callsFake((data) => ({ status: 'success', data }));

      const result = await resourceQueryService.appsResources(null, null);

      expect(result.status).to.equal('success');
      expect(result.data.appsCpusLocked).to.equal(0);
      expect(result.data.appsRamLocked).to.equal(0);
    });

    it('should handle empty database gracefully', async () => {
      const req = {};
      const res = {
        json: sinon.stub(),
      };

      const collection = config.database.appslocal.collections.appsInformation;

      try {
        await database.collection(collection).drop();
      } catch (err) {
        // Collection doesn't exist
      }

      sinon.stub(messageHelper, 'createDataMessage').callsFake((data) => ({ status: 'success', data }));

      await resourceQueryService.appsResources(req, res);

      sinon.assert.calledOnce(res.json);
      const response = res.json.firstCall.args[0];
      expect(response.data.appsCpusLocked).to.equal(0);
    });

    it('should handle database errors', async () => {
      const req = {};
      const res = {
        json: sinon.stub(),
      };

      sinon.stub(dbHelper, 'databaseConnection').throws(new Error('Database connection error'));
      sinon.stub(messageHelper, 'createErrorMessage').returns({ status: 'error' });

      await resourceQueryService.appsResources(req, res);

      sinon.assert.calledOnce(res.json);
      expect(res.json.firstCall.args[0].status).to.equal('error');
    });

    it('should include filesystem overhead for each app/component', async () => {
      const req = {};
      const res = {
        json: sinon.stub(),
      };

      const collection = config.database.appslocal.collections.appsInformation;
      const testApps = [
        {
          name: 'App1',
          version: 4,
          description: 'Test overhead app',
          owner: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
          instances: 3,
          compose: [
            {
              name: 'Component1', repotag: 'test/c1:latest', cpu: 1, ram: 2000, hdd: 10,
              ports: ['30001'], containerPorts: ['8080'], domains: [''], containerData: '',
            },
            {
              name: 'Component2', repotag: 'test/c2:latest', cpu: 1, ram: 2000, hdd: 10,
              ports: ['30002'], containerPorts: ['8081'], domains: [''], containerData: '',
            },
          ],
        },
      ];

      try {
        await database.collection(collection).drop();
      } catch (err) {
        // Collection doesn't exist
      }
      await dbHelper.insertManyToDatabase(database, collection, testApps);

      sinon.stub(messageHelper, 'createDataMessage').callsFake((data) => ({ status: 'success', data }));

      await resourceQueryService.appsResources(req, res);

      sinon.assert.calledOnce(res.json);
      const response = res.json.firstCall.args[0];

      // Base HDD (20) + 2 * (filesystem overhead + swap) = 20 + 2*7 = 34
      const expectedMinHdd = 20 + (2 * (config.fluxapps.hddFileSystemMinimum + config.fluxapps.defaultSwap));
      expect(response.data.appsHddLocked).to.equal(expectedMinHdd);
    });

    it('should handle missing cpu/ram/hdd values', async () => {
      const req = {};
      const res = {
        json: sinon.stub(),
      };

      const collection = config.database.appslocal.collections.appsInformation;
      const testApps = [
        {
          name: 'App1',
          version: 3,
          tiered: false,
          // Missing cpu, ram, hdd
        },
      ];

      try {
        await database.collection(collection).drop();
      } catch (err) {
        // Collection doesn't exist
      }
      await dbHelper.insertManyToDatabase(database, collection, testApps);

      sinon.stub(messageHelper, 'createDataMessage').callsFake((data) => ({ status: 'success', data }));

      await resourceQueryService.appsResources(req, res);

      sinon.assert.calledOnce(res.json);
      const response = res.json.firstCall.args[0];
      expect(response.data.appsCpusLocked).to.equal(0);
      expect(response.data.appsRamLocked).to.equal(0);
    });
  });
});
