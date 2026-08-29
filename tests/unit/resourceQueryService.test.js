'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const config = require('config');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const resourceQueryService = require('../../ZelBack/src/services/appQuery/resourceQueryService');
const messageHelper = require('../../ZelBack/src/services/messageHelper');
const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');
const hwRequirements = require('../../ZelBack/src/services/appRequirements/hwRequirements');
const appQueryService = require('../../ZelBack/src/services/appQuery/appQueryService');
const admissionControl = require('../../ZelBack/src/services/utils/admissionControl');
const { requireMongo } = require('./dbTestHelper');
const {
  loadSpecLibrary, V9_SUBMISSION, v9Spec, assertAnswers,
} = require('./fixtures/fluxSpec');

// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. appsResources is the module the resourceTotals SHAPE hurts most: it
// destructures `cpu` and `memoryMb` off a real DeploymentSpec and then asks
// separately for `reservableHostDiskGb()`, which is DERIVED (persistent storage
// + rootFs + swap across components) and is NOT the declared storage number. A
// hand-written double states one figure and cannot tell the two apart, so an
// admission reserved through it under-reports the node's real disk commitment
// by the whole root-filesystem and swap allowance.
//
// What stays stubbed is I/O and node-local facts: the benchmark-backed node
// specs, the running-app query and the message envelope. Mongo is real (the
// suite skips without it) and so is admissionControl, because the double being
// replaced was the object handed TO it.
let flux;

const APPS_FOLDER = '/tmp/apps';

// Every legacy (pre-v9) component reports a fixed root-filesystem and swap
// allowance, which is what the old flat `(hddFileSystemMinimum + defaultSwap) *
// componentCount` overhead was expressing. Read from config rather than written
// as 12, so the expectations below stay tied to the same numbers production uses.
const LEGACY_OVERHEAD_PER_COMPONENT = config.fluxapps.hddFileSystemMinimum + config.fluxapps.defaultSwap;

const OWNER = '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC';

/**
 * A real v9 components blob, resized. Sizes stay inside the schema's own caps
 * (cpu 0.1-14, memory 100-57000 in steps of 100, rootFsGb > 0, storage <= 780).
 */
function sizedComponents({
  cpu = 0.5, memory = 300, storageGb = 5, rootFsGb = 2, swapGb = 0,
} = {}) {
  const components = JSON.parse(JSON.stringify(V9_SUBMISSION.components));
  const { web } = components;
  web.cpu = cpu;
  web.memory = memory;
  web.rootFsGb = rootFsGb;
  web.swapGb = swapGb;
  web.persistentStorage.sizeGb = storageGb;
  if (storageGb === 0) delete web.persistentStorage.mounts;
  return components;
}

/** A real DeploymentSpec — the object admissionControl.reserve() is handed in
 * production, and the one appsResources sums. */
async function deploymentOfSize(size) {
  const spec = await v9Spec({ components: sizedComponents(size) });
  return flux.DeploymentSpec.fromSpec(spec, APPS_FOLDER, { replica: null });
}

/**
 * A stored legacy row, PRODUCED by the real version class rather than written
 * out by hand: `fromSubmission(...).serialize()` is the only construction that
 * cannot drift into a document the library would refuse.
 */
function legacyRow(submission) {
  return flux.FluxAppSpecBase.getVersionClass(submission.version)
    .fromSubmission(submission).serialize();
}

/**
 * A stored legacy row the submission path can no longer produce — the tiered
 * fields are refused on new submissions ("Deprecated fields no longer accepted")
 * but are still readable off rows registered before they were retired. Hand
 * written for that reason, and checked through the real deserializer here so a
 * row the library refuses fails LOUDLY at the fixture.
 */
function storedRow(doc) {
  flux.InstantiatedSpec.deserialize(doc);
  return doc;
}

describe('resourceQueryService tests', () => {
  before(requireMongo);

  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(60000);
    flux = await loadSpecLibrary();
  });

  afterEach(() => {
    sinon.restore();
    admissionControl.clear();
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
    let collection;

    beforeEach(async () => {
      await dbHelper.initiateDB();
      db = dbHelper.databaseConnection();
      database = db.db(config.database.appslocal.database);
      collection = config.database.appslocal.collections.appsInformation;
      try {
        await database.collection(collection).drop();
      } catch (err) {
        // Collection doesn't exist
      }
    });

    /**
     * Insert stored rows and assert the real library hydrates every one of
     * them.
     *
     * This guard is the whole reason the file needed migrating. appsRepository
     * .hydrate() swallows a deserialize failure — it logs a warning and returns
     * null — so a fixture row the library refuses simply vanishes, and a test
     * asserting "0 locked" then passes because the app was never counted rather
     * than because it counted as zero. One test in this file was doing exactly
     * that.
     */
    async function insertApps(rows) {
      await dbHelper.insertManyToDatabase(database, collection, rows);
      const installed = await appsRepository.listInstalledApps();
      expect(
        installed.length,
        'every fixture row must survive the real deserializer - hydrate() drops a refused row silently',
      ).to.equal(rows.length);
      return installed;
    }

    it('should calculate resources for version 3 non-tiered apps', async () => {
      const req = {};
      const res = {
        json: sinon.stub(),
      };

      const testApps = [
        legacyRow({
          version: 3,
          name: 'App1',
          description: 'Test app 1',
          owner: OWNER,
          repotag: 'test/app1:latest',
          ports: [30001],
          containerPorts: [8080],
          domains: [''],
          enviromentParameters: [],
          commands: [],
          containerData: '',
          cpu: 2,
          ram: 4000,
          hdd: 50,
          instances: 3,
        }),
        legacyRow({
          version: 3,
          name: 'App2',
          description: 'Test app 2',
          owner: OWNER,
          repotag: 'test/app2:latest',
          ports: [30002],
          containerPorts: [8081],
          domains: [''],
          enviromentParameters: [],
          commands: [],
          containerData: '',
          cpu: 1,
          ram: 2000,
          hdd: 25,
          instances: 3,
        }),
      ];

      await insertApps(testApps);

      sinon.stub(messageHelper, 'createDataMessage').callsFake((data) => ({ status: 'success', data }));

      await resourceQueryService.appsResources(req, res);

      sinon.assert.calledOnce(res.json);
      const response = res.json.firstCall.args[0];
      expect(response.data.appsCpusLocked).to.equal(3);
      expect(response.data.appsRamLocked).to.equal(6000);
      // Exact, not "greater than the declared hdd": the declared 50 + 25 is the
      // PERSISTENT storage only, and what a node actually commits is that plus
      // each component's root filesystem and swap.
      expect(response.data.appsHddLocked)
        .to.equal(50 + 25 + (2 * LEGACY_OVERHEAD_PER_COMPONENT));
    });

    it('adds pending (in-flight) admissions to the locked totals', async () => {
      // An app that passed resource admission but is not yet in the DB - a concurrent
      // install must see its footprint or the node double-admits.
      const pending = await deploymentOfSize({
        cpu: 2, memory: 4000, storageGb: 49, rootFsGb: 1,
      });

      // admissionControl.reserve() reads resourceTotals() and
      // reservableHostDiskGb() off whatever it is handed, and appsResources sums
      // what it recorded. Both are asserted on the object itself so a delegation
      // that disappears from flux-spec cannot leave this green.
      assertAnswers(pending, ['resourceTotals', 'reservableHostDiskGb']);

      const totals = pending.resourceTotals();
      // The full shape a real DeploymentSpec answers with. A double supplying
      // only `cpu` and `memoryMb` makes every comparison against the other five
      // terms false, which is how the reclaim path came to compare against
      // undefined.
      expect(totals).to.have.all.keys(
        'cpu', 'memoryMb', 'storageGb', 'rootFsGb', 'swapGb', 'hostDiskGb', 'componentCount',
      );
      // hostDiskGb is DERIVED, and is not the declared storage figure.
      expect(totals.hostDiskGb).to.equal(totals.storageGb + totals.rootFsGb + totals.swapGb);
      expect(totals.hostDiskGb, 'a fixture cannot claim a footprint its own parts do not add up to')
        .to.not.equal(totals.storageGb);
      expect(totals).to.include({ cpu: 2, memoryMb: 4000, hostDiskGb: 50 });
      expect(pending.reservableHostDiskGb()).to.equal(50);

      admissionControl.reserve('PendingApp', pending);

      const response = await resourceQueryService.appsResources(null, null);

      expect(response.data.appsCpusLocked).to.equal(2);
      expect(response.data.appsRamLocked).to.equal(4000);
      expect(response.data.appsHddLocked).to.equal(50);
    });

    it('should calculate resources for version 3 tiered apps using base values', async () => {
      const req = {};
      const res = {
        json: sinon.stub(),
      };

      const testApps = [
        storedRow({
          name: 'App1',
          version: 3,
          description: 'Test tiered app',
          owner: OWNER,
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
        }),
      ];

      await insertApps(testApps);

      sinon.stub(messageHelper, 'createDataMessage').callsFake((data) => ({ status: 'success', data }));

      await resourceQueryService.appsResources(req, res);

      sinon.assert.calledOnce(res.json);
      const response = res.json.firstCall.args[0];
      // DeploymentSpec uses the base cpu/ram/hdd values, not the tiered variants
      expect(response.data.appsCpusLocked).to.equal(1);
      expect(response.data.appsRamLocked).to.equal(2000);
      expect(response.data.appsHddLocked).to.equal(25 + LEGACY_OVERHEAD_PER_COMPONENT);
    });

    it('should calculate resources for version 4+ compose apps', async () => {
      const req = {};
      const res = {
        json: sinon.stub(),
      };

      const testApps = [
        legacyRow({
          version: 4,
          name: 'App1',
          description: 'Test compose app',
          owner: OWNER,
          instances: 3,
          compose: [
            {
              name: 'Component1',
              description: 'c1',
              repotag: 'test/c1:latest',
              cpu: 1,
              ram: 2000,
              hdd: 20,
              ports: [30001],
              containerPorts: [8080],
              domains: [''],
              environmentParameters: [],
              commands: [],
              containerData: '',
            },
            {
              name: 'Component2',
              description: 'c2',
              repotag: 'test/c2:latest',
              cpu: 2,
              ram: 4000,
              hdd: 30,
              ports: [30002],
              containerPorts: [8081],
              domains: [''],
              environmentParameters: [],
              commands: [],
              containerData: '',
            },
          ],
        }),
      ];

      await insertApps(testApps);

      sinon.stub(messageHelper, 'createDataMessage').callsFake((data) => ({ status: 'success', data }));

      await resourceQueryService.appsResources(req, res);

      sinon.assert.calledOnce(res.json);
      const response = res.json.firstCall.args[0];
      expect(response.data.appsCpusLocked).to.equal(3);
      expect(response.data.appsRamLocked).to.equal(6000);
      expect(response.data.appsHddLocked)
        .to.equal(20 + 30 + (2 * LEGACY_OVERHEAD_PER_COMPONENT));
    });

    it('should calculate resources for tiered compose apps using base values', async () => {
      const req = {};
      const res = {
        json: sinon.stub(),
      };

      const testApps = [
        storedRow({
          name: 'App1',
          version: 4,
          description: 'Test tiered compose app',
          owner: OWNER,
          instances: 3,
          compose: [
            {
              name: 'Component1',
              description: 'c1',
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
              description: 'c2',
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
        }),
      ];

      await insertApps(testApps);

      sinon.stub(messageHelper, 'createDataMessage').callsFake((data) => ({ status: 'success', data }));

      await resourceQueryService.appsResources(req, res);

      sinon.assert.calledOnce(res.json);
      const response = res.json.firstCall.args[0];
      // DeploymentSpec uses the base cpu/ram/hdd values, not the tiered variants
      expect(response.data.appsCpusLocked).to.equal(2);
      expect(response.data.appsRamLocked).to.equal(4000);
      expect(response.data.appsHddLocked)
        .to.equal(20 + 20 + (2 * LEGACY_OVERHEAD_PER_COMPONENT));
    });

    it('should work without response object', async () => {
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

      const testApps = [
        legacyRow({
          version: 4,
          name: 'App1',
          description: 'Test overhead app',
          owner: OWNER,
          instances: 3,
          compose: [
            {
              name: 'Component1',
              description: 'c1',
              repotag: 'test/c1:latest',
              cpu: 1,
              ram: 2000,
              hdd: 10,
              ports: [30001],
              containerPorts: [8080],
              domains: [''],
              environmentParameters: [],
              commands: [],
              containerData: '',
            },
            {
              name: 'Component2',
              description: 'c2',
              repotag: 'test/c2:latest',
              cpu: 1,
              ram: 2000,
              hdd: 10,
              ports: [30002],
              containerPorts: [8081],
              domains: [''],
              environmentParameters: [],
              commands: [],
              containerData: '',
            },
          ],
        }),
      ];

      await insertApps(testApps);

      sinon.stub(messageHelper, 'createDataMessage').callsFake((data) => ({ status: 'success', data }));

      await resourceQueryService.appsResources(req, res);

      sinon.assert.calledOnce(res.json);
      const response = res.json.firstCall.args[0];

      // Declared HDD (10 + 10) + one root-filesystem and swap allowance per component.
      const expectedHdd = 20 + (2 * LEGACY_OVERHEAD_PER_COMPONENT);
      expect(response.data.appsHddLocked).to.equal(expectedHdd);
    });

    it('counts a zero-sized legacy app at its DERIVED host-disk footprint, not its declared 0', async () => {
      // A stored row may legitimately declare cpu/ram/hdd as 0 - the library
      // accepts it - and this is where the declared figure and the reserved
      // figure part company: the app locks no CPU and no RAM, but it still
      // costs a root filesystem and swap on this node's disk. The double this
      // file used to carry stated ONE disk number and could not express that.
      const testApps = [
        storedRow({
          name: 'ZeroApp',
          version: 3,
          description: 'declares nothing',
          owner: OWNER,
          repotag: 'test/zero:latest',
          ports: ['30009'],
          containerPorts: ['8080'],
          domains: [''],
          containerData: '',
          tiered: false,
          cpu: 0,
          ram: 0,
          hdd: 0,
          instances: 3,
        }),
      ];

      await insertApps(testApps);

      sinon.stub(messageHelper, 'createDataMessage').callsFake((data) => ({ status: 'success', data }));

      const response = await resourceQueryService.appsResources(null, null);

      expect(response.data.appsCpusLocked).to.equal(0);
      expect(response.data.appsRamLocked).to.equal(0);
      expect(response.data.appsHddLocked, 'zero declared storage is not a zero footprint')
        .to.equal(LEGACY_OVERHEAD_PER_COMPONENT);
    });

    it('drops a stored row the real library refuses, and still counts the rest', async () => {
      // The case this replaces asserted "0 locked" for a row with cpu, ram, hdd,
      // description, owner and repotag all missing, and read that 0 as "missing
      // values default to zero". They do not: InstantiatedSpec.deserialize
      // refuses the row outright ("cpu: Missing cpu"), hydrate() logs and returns
      // null, and the app never becomes a deployment at all. The 0 was the app
      // disappearing.
      const malformed = {
        name: 'BrokenApp',
        version: 3,
        tiered: false,
        // Missing description, owner, repotag, cpu, ram, hdd.
      };
      let threw = null;
      try {
        flux.InstantiatedSpec.deserialize(malformed);
      } catch (err) {
        threw = err;
      }
      expect(threw, 'the real library refuses this row').to.be.an('error');

      const good = legacyRow({
        version: 3,
        name: 'GoodApp',
        description: 'well formed',
        owner: OWNER,
        repotag: 'test/good:latest',
        ports: [30011],
        containerPorts: [8080],
        domains: [''],
        enviromentParameters: [],
        commands: [],
        containerData: '',
        cpu: 1,
        ram: 1000,
        hdd: 5,
        instances: 3,
      });

      await dbHelper.insertManyToDatabase(database, collection, [good, malformed]);
      const installed = await appsRepository.listInstalledApps();
      expect(installed.map((spec) => spec.name), 'only the well-formed row hydrates')
        .to.deep.equal(['GoodApp']);

      sinon.stub(messageHelper, 'createDataMessage').callsFake((data) => ({ status: 'success', data }));

      const response = await resourceQueryService.appsResources(null, null);

      // The totals are the surviving app's, exactly - so a 0 here could not be
      // mistaken for "the malformed row counted as nothing".
      expect(response.data.appsCpusLocked).to.equal(1);
      expect(response.data.appsRamLocked).to.equal(1000);
      expect(response.data.appsHddLocked).to.equal(5 + LEGACY_OVERHEAD_PER_COMPONENT);
    });
  });
});
