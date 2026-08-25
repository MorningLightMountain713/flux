'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('appsRepository', () => {
  let appsRepository;
  let dbHelperStub;
  let specLibsStub;
  let versionRegistry;
  let logStub;
  let mockDb;
  let eventCollection;
  let runningCounts;

  beforeEach(() => {
    // countRunningByApp reads the event log directly off the collection handle:
    // resolveAddressMoves does a find, the count pipeline an aggregate.
    runningCounts = [];
    eventCollection = {
      find: sinon.stub().returns({ toArray: async () => [] }),
      aggregate: sinon.stub().callsFake(() => ({ toArray: async () => runningCounts })),
    };
    mockDb = { db: sinon.stub().returns({ collection: sinon.stub().returns(eventCollection) }) };

    dbHelperStub = {
      databaseConnection: sinon.stub().returns(mockDb),
      findOneInDatabase: sinon.stub(),
      findInDatabase: sinon.stub(),
      replaceOneInDatabase: sinon.stub(),
      removeDocumentsFromCollection: sinon.stub(),
      updateOneInDatabase: sinon.stub().resolves({ acknowledged: true, matchedCount: 1 }),
      insertOneToDatabase: sinon.stub().resolves({}),
      aggregateInDatabase: sinon.stub().resolves([]),
      bulkWriteInDatabase: sinon.stub().resolves({ upsertedCount: 0 }),
    };

    // getSpec() returns { FluxAppSpecBase: { getVersionClass } }.
    // getSpecBackend() returns { InstantiatedSpec } — hydrate() calls
    // InstantiatedSpec.deserialize(doc) which wraps the spec with metadata.
    versionRegistry = new Map();

    function mockDeserializeSpec(doc) {
      if (doc.version === 8 && typeof doc.enterprise === 'string' && doc.enterprise !== '') {
        throw new Error('appsRepository test: no EncryptedSpecV8 stub registered');
      }
      const VersionClass = versionRegistry.get(doc.version);
      if (!VersionClass) {
        throw new Error(`no spec class registered for version ${doc.version}`);
      }
      return VersionClass.deserialize(doc);
    }

    const MockInstantiatedSpec = {
      deserialize: (doc) => {
        const spec = mockDeserializeSpec(doc);
        return {
          spec,
          hash: doc.hash,
          height: doc.height,
          registeredAt: doc.registeredAt ?? null,
          name: spec.name,
          version: spec.version,
          owner: spec.owner,
          isEncrypted: false,
        };
      },
    };

    specLibsStub = {
      getSpec: sinon.stub().resolves({
        FluxAppSpecBase: {
          getVersionClass: (v) => versionRegistry.get(v),
        },
      }),
      getSpecBackend: sinon.stub().resolves({
        InstantiatedSpec: MockInstantiatedSpec,
      }),
    };

    logStub = { warn: sinon.stub(), error: sinon.stub(), info: sinon.stub() };

    const configStub = {
      database: {
        appsglobal: {
          database: 'appsdb',
          collections: {
            appsInformation: 'zelappsinformation',
            appsMessages: 'zelappsmessages',
            appContentManifests: 'zelappcontentmanifests',
          },
        },
        appslocal: {
          database: 'localdb',
          collections: { appsInformation: 'zelappsinformation' },
        },
        daemon: {
          database: 'daemondb',
          collections: {
            scannedHeight: 'scannedheight',
            appsHashes: 'zelappshashes',
          },
        },
      },
      fluxapps: {
        daemonPONFork: 2020000,
        blocksLasting: 22000,
        newMinBlocksAllowance: 100,
        contentManifestReapGraceMs: 7200000,
      },
    };

    appsRepository = proxyquire('../../ZelBack/src/services/appDatabase/appsRepository', {
      config: configStub,
      '../../lib/log': logStub,
      '../dbHelper': dbHelperStub,
      '../utils/specLibs': specLibsStub,
      '../utils/appConstants': {
        globalAppsInformation: 'zelappsinformation',
        localAppsInformation: 'zelappsinformation',
        globalAppsMessages: 'zelappsmessages',
        globalAppsIngressAttestations: 'appingressattestations',
        globalAppsIngressAttestationDigests: 'appingressattestationdigests',
      },
      './appsMaintenance': {
        expireHeightExpr: sinon.stub().returns({ $add: ['$height', '$expire'] }),
      },
    });
  });

  afterEach(() => sinon.restore());

  describe('hydration', () => {
    it('returns null when findOne misses', async () => {
      dbHelperStub.findOneInDatabase.resolves(null);
      const result = await appsRepository.getGlobalAppInfo('unknown');
      expect(result).to.be.null;
    });

    it('dispatches to the registered version class and wraps in InstantiatedSpec', async () => {
      const v7Instance = { name: 'example', version: 7 };
      const V7 = { deserialize: sinon.stub().returns(v7Instance) };
      versionRegistry.set(7, V7);

      const doc = { name: 'example', version: 7, hash: 'h', height: 100, compose: [] };
      dbHelperStub.findOneInDatabase.resolves(doc);

      const result = await appsRepository.getGlobalAppInfo('example');
      expect(result.spec).to.equal(v7Instance);
      expect(result.hash).to.equal('h');
      expect(result.height).to.equal(100);
      expect(result.name).to.equal('example');
      expect(V7.deserialize.calledOnceWith(doc)).to.be.true;
    });

    it('returns null and logs when no version class is registered', async () => {
      const doc = { name: 'phantom', version: 99, hash: 'h', height: 100 };
      dbHelperStub.findOneInDatabase.resolves(doc);
      const result = await appsRepository.getGlobalAppInfo('phantom');
      expect(result).to.be.null;
      expect(logStub.warn.calledOnce).to.be.true;
    });

    it('hydrates v9 documents through InstantiatedSpec.deserialize', async () => {
      versionRegistry.set(9, { deserialize: sinon.stub().returns({ version: 9, name: 'modern' }) });
      const doc = { name: 'modern', version: 9, hash: 'h', height: 100 };
      dbHelperStub.findOneInDatabase.resolves(doc);
      const result = await appsRepository.getGlobalAppInfo('modern');
      expect(result).to.not.be.null;
      expect(result.name).to.equal('modern');
    });
  });

  describe('case-insensitive name matching', () => {
    it('uses case-insensitive anchored regex for name lookup', async () => {
      dbHelperStub.findOneInDatabase.resolves(null);
      await appsRepository.getGlobalAppInfo('MyApp');
      const arg = dbHelperStub.findOneInDatabase.firstCall.args[2];
      expect(arg.name).to.be.instanceOf(RegExp);
      expect('MYAPP').to.match(arg.name);
      expect('myapp').to.match(arg.name);
      expect('MyApp2').to.not.match(arg.name);
    });
  });

  describe('lean scalar accessors skip hydration', () => {
    it('getGlobalAppOwner returns just the owner via an owner projection', async () => {
      dbHelperStub.findOneInDatabase.resolves({ owner: 'ownerX' });
      const result = await appsRepository.getGlobalAppOwner('app');
      expect(result).to.equal('ownerX');
      const options = dbHelperStub.findOneInDatabase.firstCall.args[3];
      expect(options.projection).to.deep.equal({ _id: 0, owner: 1 });
      expect(specLibsStub.getSpec.called).to.be.false;
    });

    it('getGlobalAppOwner returns null when the app is absent', async () => {
      dbHelperStub.findOneInDatabase.resolves(null);
      expect(await appsRepository.getGlobalAppOwner('missing')).to.be.null;
    });

    it('getGlobalAppHeight returns the numeric height via a height projection', async () => {
      dbHelperStub.findOneInDatabase.resolves({ height: 1234 });
      const result = await appsRepository.getGlobalAppHeight('app');
      expect(result).to.equal(1234);
      const options = dbHelperStub.findOneInDatabase.firstCall.args[3];
      expect(options.projection).to.deep.equal({ _id: 0, height: 1 });
      expect(specLibsStub.getSpec.called).to.be.false;
    });

    it('getGlobalAppHeight returns null when the app is absent', async () => {
      dbHelperStub.findOneInDatabase.resolves(null);
      expect(await appsRepository.getGlobalAppHeight('missing')).to.be.null;
    });

    it('listInstalledAppNames reads names through a name projection', async () => {
      dbHelperStub.findInDatabase.resolves([{ name: 'AppA' }, { name: 'AppB' }]);
      const result = await appsRepository.listInstalledAppNames();
      expect(result).to.deep.equal(['AppA', 'AppB']);
      const options = dbHelperStub.findInDatabase.firstCall.args[3];
      expect(options.projection).to.deep.equal({ _id: 0, name: 1 });
      expect(specLibsStub.getSpecBackend.called).to.be.false;
    });

    it('listInstalledAppNames keeps an app whose spec would not hydrate', async () => {
      // The reason this exists rather than listInstalledApps: the boot sweep runs
      // before the spec-backend bridge is warm, and must not lose apps to it.
      dbHelperStub.findInDatabase.resolves([{ name: 'AppA', version: 42 }]);
      expect(await appsRepository.listInstalledAppNames()).to.deep.equal(['AppA']);
    });

    it('listInstalledAppNames returns one entry per app, not per identity', async () => {
      dbHelperStub.findInDatabase.resolves([
        { name: 'AppA' }, { name: 'appa' }, { name: 'AppB' },
      ]);
      expect(await appsRepository.listInstalledAppNames()).to.deep.equal(['AppA', 'AppB']);
    });
  });

  describe('writes', () => {
    it('upsertGlobalAppInfo uses replaceOne with upsert', async () => {
      dbHelperStub.replaceOneInDatabase.resolves({ matchedCount: 1 });
      await appsRepository.upsertGlobalAppInfo({ name: 'app', version: 7, hash: 'h', height: 1 });
      const [, , query, doc, options] = dbHelperStub.replaceOneInDatabase.firstCall.args;
      expect(query).to.deep.equal({ name: 'app' });
      expect(doc.name).to.equal('app');
      expect(options).to.deep.equal({ upsert: true });
    });

    // Both are minted once, from the transaction that carried the registration.
    // Every later write here is a REPLACE and an update carries neither, so
    // without the carry-forward the app's next deployment would be named from
    // something other than what its containers and volume already carry.
    it('upsertGlobalAppInfo carries a stored uuid and identity through an update', async () => {
      dbHelperStub.findOneInDatabase.resolves({ uuid: 'u'.repeat(64), identity: 'abc123def456' });
      dbHelperStub.replaceOneInDatabase.resolves({ matchedCount: 1 });

      await appsRepository.upsertGlobalAppInfo({ name: 'app', version: 7, hash: 'h2', height: 2 });

      const doc = dbHelperStub.replaceOneInDatabase.firstCall.args[3];
      expect(doc.uuid, 'an update must not clear the instance identity').to.equal('u'.repeat(64));
      expect(doc.identity, 'nor what the containers are named from').to.equal('abc123def456');
    });

    // A registration states its own, and it must win - this is the one write
    // that is allowed to set them.
    it('upsertGlobalAppInfo lets an incoming registration state its own identity', async () => {
      dbHelperStub.findOneInDatabase.resolves(null);
      dbHelperStub.replaceOneInDatabase.resolves({ matchedCount: 0 });

      await appsRepository.upsertGlobalAppInfo({
        name: 'app', version: 9, hash: 'h', height: 1, uuid: 'f'.repeat(64), identity: 'ffffffffffff',
      });

      const doc = dbHelperStub.replaceOneInDatabase.firstCall.args[3];
      expect(doc.uuid).to.equal('f'.repeat(64));
      expect(doc.identity).to.equal('ffffffffffff');
    });

    it('upsertGlobalAppInfo rejects specs without name', async () => {
      try {
        await appsRepository.upsertGlobalAppInfo({ version: 7 });
        expect.fail('should throw');
      } catch (err) {
        expect(err.message).to.match(/name required/);
      }
    });

    it('removeGlobalAppInfo issues case-insensitive delete', async () => {
      dbHelperStub.removeDocumentsFromCollection.resolves({ deletedCount: 1 });
      await appsRepository.removeGlobalAppInfo('ByeApp');
      const query = dbHelperStub.removeDocumentsFromCollection.firstCall.args[2];
      expect('BYEAPP').to.match(query.name);
      expect('byeapp').to.match(query.name);
    });

    it('upsertAppInstallingErrorLocations upserts each record on its identity', async () => {
      const records = [
        { name: 'AppA', hash: 'h1', ip: '1.1.1.1:16127', error: 'boom' },
        { name: 'AppB', hash: 'h2', ip: '2.2.2.2:16127', error: 'bang' },
      ];
      await appsRepository.upsertAppInstallingErrorLocations(records);
      const operations = dbHelperStub.bulkWriteInDatabase.firstCall.args[2];
      expect(operations).to.have.length(2);
      expect(operations[0].updateOne.filter).to.deep.equal({ name: 'AppA', hash: 'h1', ip: '1.1.1.1:16127' });
      expect(operations[0].updateOne.update).to.deep.equal({ $set: records[0] });
      expect(operations[0].updateOne.upsert).to.equal(true);
      expect(operations[1].updateOne.filter.name).to.equal('AppB');
    });

    it('upsertAppInstallingErrorLocations tolerates a peer reporting no errors', async () => {
      await appsRepository.upsertAppInstallingErrorLocations([]);
      expect(dbHelperStub.bulkWriteInDatabase.firstCall.args[2]).to.deep.equal([]);
    });
  });

  describe('list accessors', () => {
    it('listGlobalAppInfo hydrates every document into InstantiatedSpec', async () => {
      const inst1 = { name: 'a' };
      const inst2 = { name: 'b' };
      const V = { deserialize: sinon.stub() };
      V.deserialize.onFirstCall().returns(inst1);
      V.deserialize.onSecondCall().returns(inst2);
      versionRegistry.set(7, V);

      dbHelperStub.findInDatabase.resolves([
        { name: 'a', version: 7, hash: 'h1', height: 10 },
        { name: 'b', version: 7, hash: 'h2', height: 20 },
      ]);

      const result = await appsRepository.listGlobalAppInfo();
      expect(result).to.have.length(2);
      expect(result[0].spec).to.equal(inst1);
      expect(result[0].hash).to.equal('h1');
      expect(result[1].spec).to.equal(inst2);
      expect(result[1].hash).to.equal('h2');
    });

    it('listGlobalAppInfo drops docs whose version class is missing', async () => {
      const V = { deserialize: sinon.stub().returns({ name: 'a' }) };
      versionRegistry.set(7, V);

      dbHelperStub.findInDatabase.resolves([
        { name: 'a', version: 7, hash: 'h1', height: 10 },
        { name: 'b', version: 42, hash: 'h2', height: 20 }, // no class registered
      ]);

      const result = await appsRepository.listGlobalAppInfo();
      expect(result).to.have.length(1);
      expect(result[0].name).to.equal('a');
    });
  });

  describe('listRunningAddresses', () => {
    // The tail groups on the address, so the aggregate yields { _id: <address> }.
    it('returns one entry per address the derivation reports as running', async () => {
      runningCounts = [{ _id: '1.2.3.4:16127' }, { _id: '5.6.7.8:16127' }];
      const result = await appsRepository.listRunningAddresses();
      expect(result).to.deep.equal(['1.2.3.4:16127', '5.6.7.8:16127']);
    });

    it('returns nothing when the derivation reports nothing running', async () => {
      runningCounts = [];
      expect(await appsRepository.listRunningAddresses()).to.deep.equal([]);
    });

    it('reports a moved node at the address it moved TO', async () => {
      // One live move old -> new, where the node has NOT yet re-announced at the new
      // address: resolveAddressMoves translates rather than supersedes.
      const now = Date.now();
      eventCollection.find.returns({
        toArray: async () => [
          { ip: 'old:16127', broadcastedAt: new Date(now), data: { newIP: 'new:16127' } },
        ],
      });
      // First aggregate is resolveAddressMoves' timestamp lookup, second is the pipeline.
      eventCollection.aggregate
        .onFirstCall().returns({ toArray: async () => [{ _id: 'old:16127', latest: new Date(now - 1000) }] })
        .onSecondCall().returns({ toArray: async () => [{ _id: 'old:16127' }] });

      const result = await appsRepository.listRunningAddresses();
      expect(result).to.deep.equal(['new:16127']);
    });

    it('deduplicates when a translation collapses two rows onto one address', async () => {
      // The node announced at BOTH addresses, so the derivation yields two rows and
      // translating the pre-move one onto the new address would otherwise repeat it.
      const now = Date.now();
      eventCollection.find.returns({
        toArray: async () => [
          { ip: 'old:16127', broadcastedAt: new Date(now), data: { newIP: 'new:16127' } },
        ],
      });
      eventCollection.aggregate
        .onFirstCall().returns({
          toArray: async () => [
            { _id: 'old:16127', latest: new Date(now - 1000) },
            // not newer than the pre-move announcement, so this translates, not supersedes
            { _id: 'new:16127', latest: new Date(now - 2000) },
          ],
        })
        .onSecondCall().returns({ toArray: async () => [{ _id: 'old:16127' }, { _id: 'new:16127' }] });

      const result = await appsRepository.listRunningAddresses();
      expect(result).to.deep.equal(['new:16127']);
    });
  });

  describe('getAppMessage', () => {
    it('returns null when the hash is not found', async () => {
      dbHelperStub.findOneInDatabase.resolves(null);
      const result = await appsRepository.getAppMessage('nope');
      expect(result).to.be.null;
    });

    it('hydrates the nested appSpecifications into InstantiatedSpec', async () => {
      const specInstance = { name: 'x', version: 7 };
      const V = { deserialize: sinon.stub().returns(specInstance) };
      versionRegistry.set(7, V);

      const message = {
        hash: 'abc',
        height: 500,
        appSpecifications: { name: 'x', version: 7, compose: [] },
      };
      dbHelperStub.findOneInDatabase.resolves(message);

      const result = await appsRepository.getAppMessage('abc');
      expect(result.message).to.equal(message);
      expect(result.spec.spec).to.equal(specInstance);
      expect(result.spec.hash).to.equal('abc');
      expect(result.spec.height).to.equal(500);

      // The hydrate call should have received the spec blob with hash/height appended
      const docForHydrate = V.deserialize.firstCall.args[0];
      expect(docForHydrate.hash).to.equal('abc');
      expect(docForHydrate.height).to.equal(500);
    });
  });

  describe('getPermanentMessageBeforeHeight', () => {
    it('queries strictly below the confirming height, newest first', async () => {
      dbHelperStub.findOneInDatabase.resolves(null);

      await appsRepository.getPermanentMessageBeforeHeight('myapp', 2000);

      const [, collection, query, options] = dbHelperStub.findOneInDatabase.firstCall.args;
      expect(collection).to.equal('zelappsmessages');
      expect(query).to.deep.equal({ 'appSpecifications.name': 'myapp', height: { $lt: 2000 } });
      expect(options.sort).to.deep.equal({ height: -1, timestamp: -1 });
    });

    // The message being priced is already stored when this runs. A cutoff that
    // admits its own height selects it, and a spec priced against itself is
    // free under every rule in the free-update policy.
    it('excludes the confirming height itself', async () => {
      dbHelperStub.findOneInDatabase.resolves(null);

      await appsRepository.getPermanentMessageBeforeHeight('myapp', 2000);

      const [, , query] = dbHelperStub.findOneInDatabase.firstCall.args;
      expect(query.height.$lt).to.equal(2000);
      expect(query.height).to.not.have.property('$lte');
    });

    it('returns null when nothing precedes the height', async () => {
      dbHelperStub.findOneInDatabase.resolves(null);
      const result = await appsRepository.getPermanentMessageBeforeHeight('myapp', 2000);
      expect(result).to.be.null;
    });

  });

  describe('findUnderProvisionedApps', () => {
    beforeEach(() => {
      const V7 = {
        deserialize: (doc) => ({
          version: doc.version,
          name: doc.name,
          owner: doc.owner,
          instances: doc.instances,
          placement: { staticIp: false, dataCenter: false },
          enterprise: doc.enterprise,
          hasSyncthing: () => false,
        }),
      };
      versionRegistry.set(7, V7);
    });

    it('returns nothing when no app is alive', async () => {
      dbHelperStub.aggregateInDatabase.resolves([]);
      const result = await appsRepository.findUnderProvisionedApps(2555000, 1716000000);
      expect(result).to.deep.equal([]);
    });

    it('flags an app running fewer replicas than it wants', async () => {
      const doc = { version: 7, name: 'testApp', owner: 'owner1', hash: 'h1', height: 2550000, instances: 3 };
      dbHelperStub.aggregateInDatabase.resolves([doc]);
      runningCounts = [{ _id: 'testApp', count: 1 }];

      const result = await appsRepository.findUnderProvisionedApps(2555000, 1716000000);

      expect(result).to.have.lengthOf(1);
      expect(result[0].instantiated.name).to.equal('testApp');
      expect(result[0].actual).to.equal(1);
      expect(result[0].required).to.equal(3);
    });

    it('leaves an app alone once it is at target', async () => {
      const doc = { version: 7, name: 'testApp', owner: 'owner1', hash: 'h1', height: 2550000, instances: 3 };
      dbHelperStub.aggregateInDatabase.resolves([doc]);
      runningCounts = [{ _id: 'testApp', count: 3 }];

      expect(await appsRepository.findUnderProvisionedApps(2555000, 1716000000)).to.deep.equal([]);
    });

    // The count is keyed off the announced name; app names are matched
    // case-insensitively everywhere else, and a miss here reads as zero instances
    // and spawns a replica that is already running.
    it('matches the running count to the spec name case-insensitively', async () => {
      const doc = { version: 7, name: 'TestApp', owner: 'o', hash: 'h1', height: 2550000, instances: 3 };
      dbHelperStub.aggregateInDatabase.resolves([doc]);
      runningCounts = [{ _id: 'testapp', count: 3 }];

      expect(await appsRepository.findUnderProvisionedApps(2555000, 1716000000)).to.deep.equal([]);
    });

    it('treats an app with no running replicas as fully under-provisioned', async () => {
      const doc = { version: 7, name: 'ghost', owner: 'o', hash: 'h1', height: 2550000, instances: 2 };
      dbHelperStub.aggregateInDatabase.resolves([doc]);
      runningCounts = [];

      const result = await appsRepository.findUnderProvisionedApps(2555000, 1716000000);
      expect(result).to.have.lengthOf(1);
      expect(result[0].actual).to.equal(0);
      expect(result[0].required).to.equal(2);
    });

    it('defaults the target to 3 when the spec does not say', async () => {
      const doc = { version: 7, name: 'noInstances', owner: 'o', hash: 'h1', height: 2550000 };
      dbHelperStub.aggregateInDatabase.resolves([doc]);
      runningCounts = [{ _id: 'noinstances', count: 2 }];

      const result = await appsRepository.findUnderProvisionedApps(2555000, 1716000000);
      expect(result).to.have.lengthOf(1);
      expect(result[0].required).to.equal(3);
    });

    it('skips docs that fail hydration', async () => {
      const good = { version: 7, name: 'goodApp', owner: 'o1', hash: 'h1', height: 100, instances: 3 };
      const bad = { version: 99, name: 'badApp', owner: 'o2', hash: 'h2', height: 100, instances: 3 };
      dbHelperStub.aggregateInDatabase.resolves([good, bad]);
      runningCounts = [];

      const result = await appsRepository.findUnderProvisionedApps(2555000, 1716000000);
      expect(result).to.have.lengthOf(1);
      expect(result[0].instantiated.name).to.equal('goodApp');
    });

    // Encrypted specs bind their cleartext metadata into the AAD, so a doc decorated
    // with anything the query added fails to decrypt. Counting outside the pipeline
    // means the doc reaches hydrate exactly as stored.
    it('hands hydrate the stored doc, undecorated', async () => {
      const doc = { version: 7, name: 'testApp', owner: 'o', hash: 'h1', height: 2550000, instances: 3 };
      dbHelperStub.aggregateInDatabase.resolves([doc]);
      runningCounts = [];

      await appsRepository.findUnderProvisionedApps(2555000, 1716000000);

      const pipeline = dbHelperStub.aggregateInDatabase.firstCall.args[2];
      // no join, and nothing left of the aliveness check
      expect(pipeline.some((stage) => stage.$lookup)).to.be.false;
      expect(pipeline.filter((stage) => stage.$unset).map((stage) => stage.$unset)).to.deep.include('_isAlive');
      expect(Object.keys(doc).sort()).to.deep.equal(['hash', 'height', 'instances', 'name', 'owner', 'version']);
    });

    it('does not count instances inside the spec query', async () => {
      dbHelperStub.aggregateInDatabase.resolves([]);
      await appsRepository.findUnderProvisionedApps(2555000, 1716000000);
      const pipeline = dbHelperStub.aggregateInDatabase.firstCall.args[2];
      expect(pipeline.some((stage) => stage.$lookup)).to.be.false;
      expect(JSON.stringify(pipeline)).to.not.include('zelappslocation');
    });

    it('should pass currentHeight and nowSeconds into the pipeline', async () => {
      dbHelperStub.aggregateInDatabase.resolves([]);
      await appsRepository.findUnderProvisionedApps(2555000, 1716000000);
      expect(dbHelperStub.aggregateInDatabase.calledOnce).to.be.true;
      const pipeline = dbHelperStub.aggregateInDatabase.firstCall.args[2];
      expect(pipeline).to.be.an('array');
      expect(pipeline.length).to.be.gte(3);
    });
  });

  describe('content manifests', () => {
    // The index a node publishes is a promise to serve those bodies, and the bodies come
    // from listConfirmedContentManifestBroadcasts, which requires an envelope. A confirmed
    // row without one (a manifest pulled over HTTP from a running peer, or restored from
    // the FluxDrive backstop) cannot be served. Advertising it makes the asking node
    // request it every round, receive a well-formed EMPTY answer, and stay behind for as
    // long as that peer is its source — the two queries have to agree on what is servable.
    it('the served index offers only rows that can actually be served', async () => {
      dbHelperStub.findInDatabase.resolves([]);
      await appsRepository.listConfirmedContentManifestVersions();
      const filter = dbHelperStub.findInDatabase.firstCall.args[2];
      expect(filter).to.deep.equal({ confirmed: true, envelope: { $exists: true } });
    });

    it('upsert: a confirmed store advances a higher version OR promotes a same-version quarantined row', async () => {
      const row = { appName: 'app', version: 2, data: { d: 1 } };
      const ok = await appsRepository.upsertContentManifest(row, { confirmed: true, clearEnvelope: true });
      expect(ok).to.equal(true);
      const [, collection, filter, update, opts] = dbHelperStub.updateOneInDatabase.firstCall.args;
      expect(collection).to.equal('zelappcontentmanifests');
      expect(filter).to.deep.equal({ appName: 'app', $or: [{ version: { $lt: 2 } }, { version: 2, confirmed: false }] });
      // NO upsert: the guard refuses via its own read, never via the index.
      expect(opts).to.equal(undefined);
      expect(update.$set).to.include({ appName: 'app', version: 2, confirmed: true });
      expect(update.$set.data).to.deep.equal({ d: 1 });
      expect(update.$set.receivedAt).to.be.instanceOf(Date);
      expect(update.$unset).to.deep.equal({ expireAt: '', envelope: '' }); // catch-up clears both
    });

    it('upsert: a quarantine store holds a strictly-newer version and carries the TTL', async () => {
      const expireAt = new Date(123456);
      await appsRepository.upsertContentManifest(
        { appName: 'app', version: 3, data: {} }, { confirmed: false, expireAt, clearEnvelope: true },
      );
      const [, , filter, update] = dbHelperStub.updateOneInDatabase.firstCall.args;
      expect(filter).to.deep.equal({ appName: 'app', version: { $lt: 3 } });
      expect(update.$set.confirmed).to.equal(false);
      expect(update.$set.expireAt).to.equal(expireAt);
      expect(update.$unset).to.deep.equal({ envelope: '' });
    });

    it('upsert: a broadcast store keeps its envelope (clears only the TTL)', async () => {
      const envelope = { version: 1, timestamp: 7, pubKey: 'pk', signature: 'sig' };
      await appsRepository.upsertContentManifest(
        { appName: 'app', version: 2, data: { d: 1 }, envelope }, { confirmed: true, clearEnvelope: false },
      );
      const [, , , update] = dbHelperStub.updateOneInDatabase.firstCall.args;
      expect(update.$set.envelope).to.deep.equal(envelope);
      expect(update.$unset).to.deep.equal({ expireAt: '' });
    });

    it('upsert: maps a unique-index collision (a same/higher version already won) to false', async () => {
      const err = new Error('E11000 duplicate key');
      err.code = 11000;
      dbHelperStub.updateOneInDatabase.rejects(err);
      const ok = await appsRepository.upsertContentManifest({ appName: 'app', version: 2, data: {} });
      expect(ok).to.equal(false);
    });

    it('getContentManifest reads one row by appName', async () => {
      dbHelperStub.findOneInDatabase.resolves({ appName: 'app', version: 4 });
      const out = await appsRepository.getContentManifest('app');
      expect(out.version).to.equal(4);
      const [, collection, query] = dbHelperStub.findOneInDatabase.firstCall.args;
      expect(collection).to.equal('zelappcontentmanifests');
      expect(query).to.deep.equal({ appName: 'app' });
    });

    it('setContentManifestApplied advances appliedVersion monotonically, never upserting', async () => {
      await appsRepository.setContentManifestApplied('app', 5);
      const [, collection, filter, update, opts] = dbHelperStub.updateOneInDatabase.firstCall.args;
      expect(collection).to.equal('zelappcontentmanifests');
      expect(filter).to.deep.equal({ appName: 'app', $or: [{ appliedVersion: { $exists: false } }, { appliedVersion: { $lt: 5 } }] });
      expect(update).to.deep.equal({ $set: { appliedVersion: 5 } });
      expect(opts).to.equal(undefined); // the row must already exist — you can't apply what you never stored
    });

    it('deleteQuarantinedContentManifest removes only the confirmed:false row', async () => {
      await appsRepository.deleteQuarantinedContentManifest('app');
      const [, collection, query] = dbHelperStub.removeDocumentsFromCollection.firstCall.args;
      expect(collection).to.equal('zelappcontentmanifests');
      expect(query).to.deep.equal({ appName: 'app', confirmed: false });
    });

    it('listConfirmedContentManifestVersions returns the (appName, version) vector of confirmed rows', async () => {
      dbHelperStub.findInDatabase.resolves([{ appName: 'a', version: 2 }, { appName: 'b', version: 5 }]);
      const out = await appsRepository.listConfirmedContentManifestVersions();
      expect(out).to.deep.equal([{ appName: 'a', version: 2 }, { appName: 'b', version: 5 }]);
      const [, , query, options] = dbHelperStub.findInDatabase.firstCall.args;
      expect(query).to.deep.equal({ confirmed: true, envelope: { $exists: true } });
      expect(options.projection).to.deep.equal({ _id: 0, appName: 1, version: 1 });
    });

    it('listContentManifestVersions returns every held row, quarantined included', async () => {
      dbHelperStub.findInDatabase.resolves([{ appName: 'a', version: 2 }, { appName: 'q', version: 1 }]);
      const out = await appsRepository.listContentManifestVersions();
      expect(out).to.deep.equal([{ appName: 'a', version: 2 }, { appName: 'q', version: 1 }]);
      const [, , query, options] = dbHelperStub.findInDatabase.firstCall.args;
      expect(query).to.deep.equal({});
      expect(options.projection).to.deep.equal({ _id: 0, appName: 1, version: 1 });
    });

    it('listConfirmedContentManifestBroadcasts rebuilds {...envelope, data}, optionally scoped to appNames', async () => {
      const env = { version: 1, timestamp: 7, pubKey: 'pk', signature: 'sig' };
      dbHelperStub.findInDatabase.resolves([{ envelope: env, data: { m: 1 } }]);
      const out = await appsRepository.listConfirmedContentManifestBroadcasts(['a']);
      expect(out).to.deep.equal([{ ...env, data: { m: 1 } }]);
      const [, , query] = dbHelperStub.findInDatabase.firstCall.args;
      expect(query).to.deep.equal({ confirmed: true, envelope: { $exists: true }, appName: { $in: ['a'] } });
    });

    describe('listIngressAttestationsByApp', () => {
      it('groups attestations by the app message they attest to, omitting messages with none', async () => {
        dbHelperStub.findInDatabase.callsFake(async (_db, collection, query) => {
          if (collection === 'zelappsmessages') {
            return [
              { hash: 'h1', type: 'fluxappregister', timestamp: 1000 },
              { hash: 'h2', type: 'fluxappupdate', timestamp: 2000 },
              { hash: 'h3', type: 'fluxappupdate', timestamp: 3000 },
            ];
          }
          const byHash = {
            h1: [{ hash: 'h1', node: 'n1', sealed: { kid: 'k' } }],
            h2: [{ hash: 'h2', node: 'n1', sealed: { kid: 'k' } }, { hash: 'h2', node: 'n2', sealed: { kid: 'k' } }],
            h3: [],
          };
          return byHash[query.hash] || [];
        });

        const groups = await appsRepository.listIngressAttestationsByApp('myapp');

        // h3 (an update with no attestation) is omitted; order follows the message history.
        expect(groups).to.have.length(2);
        expect(groups[0]).to.deep.include({ hash: 'h1', type: 'fluxappregister', timestamp: 1000 });
        expect(groups[0].attestations).to.have.length(1);
        expect(groups[1]).to.deep.include({ hash: 'h2', type: 'fluxappupdate' });
        expect(groups[1].attestations).to.have.length(2);
      });

      it('resolves the app by name against the message store', async () => {
        dbHelperStub.findInDatabase.callsFake(async (_db, collection) => (collection === 'zelappsmessages' ? [] : []));
        expect(await appsRepository.listIngressAttestationsByApp('ghost')).to.deep.equal([]);
        const nameQuery = dbHelperStub.findInDatabase.getCalls().find((c) => c.args[1] === 'zelappsmessages').args[2];
        expect(nameQuery).to.deep.equal({ 'appSpecifications.name': 'ghost' });
      });
    });

    describe('materialized ingress digests', () => {
      const DIGEST_COLL = 'appingressattestationdigests';

      it('reads the digest doc for O(K) serving and rebuilds once when it is absent', async () => {
        dbHelperStub.findOneInDatabase.onFirstCall().resolves(null); // doc absent → rebuild
        dbHelperStub.findInDatabase.resolves([{ hash: 'h1', node: 'n1' }]); // members for the rebuild scan
        dbHelperStub.findOneInDatabase.onSecondCall().resolves({ _id: 'ingress', buckets: {} });

        const digests = await appsRepository.listIngressAttestationDigests();
        expect(digests).to.have.length(256);
        expect(digests.every((d) => typeof d === 'string' && d.length === 64)).to.equal(true);
        // the rebuild wrote the digest doc
        const wrote = dbHelperStub.updateOneInDatabase.getCalls().some((c) => c.args[1] === DIGEST_COLL);
        expect(wrote).to.equal(true);
      });

      it('serves purely from the doc when present — no scan', async () => {
        dbHelperStub.findOneInDatabase.resolves({ _id: 'ingress', buckets: { 5: 'a'.repeat(64) } });
        const digests = await appsRepository.listIngressAttestationDigests();
        expect(dbHelperStub.findInDatabase.called).to.equal(false); // no member scan
        expect(digests[5]).to.equal('a'.repeat(64));
        expect(digests[6]).to.equal('0'.repeat(64)); // absent bucket → zero digest
      });

      it('a store recomputes only its own bucket, counting every row held', async () => {
        const setReconciler = require('../../ZelBack/src/services/appMessaging/setReconciler'); // eslint-disable-line global-require
        dbHelperStub.insertOneToDatabase = sinon.stub().resolves({ insertedId: 'x' });
        dbHelperStub.findInDatabase.resolves([{ hash: 'h2', node: 'n2' }]); // the bucket's members

        await appsRepository.storeIngressAttestation({ hash: 'h2', node: 'n2' }, null);

        const bucket = setReconciler.bucketOf('h2|n2');
        // exactly one digest write, scoped to that bucket
        const digestWrites = dbHelperStub.updateOneInDatabase.getCalls().filter((c) => c.args[1] === DIGEST_COLL);
        expect(digestWrites).to.have.length(1);
        const memberQuery = dbHelperStub.findInDatabase.lastCall.args[2];
        expect(memberQuery).to.deep.equal({ bucket });
      });

      it('a quarantined store enters the digest too, so a served record converges', async () => {
        // The digest states what this node HOLDS. Leaving a quarantined row out would
        // make our index disagree with the peer that just served it to us, and the
        // record would be re-offered every round until its message confirmed locally.
        dbHelperStub.insertOneToDatabase = sinon.stub().resolves({ insertedId: 'x' });
        dbHelperStub.findInDatabase.resolves([{ hash: 'h3', node: 'n3' }]);

        await appsRepository.storeIngressAttestation({ hash: 'h3', node: 'n3' }, Date.now() + 1000);

        const digestWrites = dbHelperStub.updateOneInDatabase.getCalls().filter((c) => c.args[1] === DIGEST_COLL);
        expect(digestWrites).to.have.length(1);
      });

      it('deduplicates a re-seen (hash, node) with no insert and no digest write', async () => {
        dbHelperStub.findOneInDatabase.resolves({ _id: 'already-held' });
        dbHelperStub.insertOneToDatabase = sinon.stub().resolves({ insertedId: 'x' });
        const res = await appsRepository.storeIngressAttestation({ hash: 'h9', node: 'n9' }, null);
        expect(res).to.deep.equal({ inserted: false });
        expect(dbHelperStub.insertOneToDatabase.called).to.equal(false);
        const digestWrites = dbHelperStub.updateOneInDatabase.getCalls().filter((c) => c.args[1] === DIGEST_COLL);
        expect(digestWrites).to.have.length(0);
      });

      it('confirming a hash clears the TTL and leaves the digest untouched', async () => {
        // Promotion changes neither (hash, node) identity nor bucket, and the row was
        // already counted when it was stored — so there is nothing for the digest to do.
        dbHelperStub.updateInDatabase = sinon.stub().resolves({ modifiedCount: 2 });

        await appsRepository.confirmIngressAttestations('h1');

        const [, , filter, update] = dbHelperStub.updateInDatabase.firstCall.args;
        expect(filter).to.deep.equal({ hash: 'h1' });
        expect(update).to.deep.equal({ $unset: { expireAt: '' } });
        const digestWrites = dbHelperStub.updateOneInDatabase.getCalls().filter((c) => c.args[1] === DIGEST_COLL);
        expect(digestWrites).to.have.length(0);
      });
    });

    it('reapOrphanedContentManifests deletes confirmed manifests whose app left the global set, aged past the grace', async () => {
      const distinctStub = sinon.stub().resolves(['live', 'dead']);
      mockDb.db.returns({ collection: sinon.stub().returns({ distinct: distinctStub }) });
      dbHelperStub.findInDatabase.resolves([{ name: 'live' }]); // listExistingGlobalAppNames -> only 'live' survives
      dbHelperStub.removeDocumentsFromCollection.resolves({ deletedCount: 1 });

      const before = Date.now();
      const { reaped, orphans } = await appsRepository.reapOrphanedContentManifests();
      expect(orphans).to.deep.equal(['dead']);
      expect(reaped).to.equal(1);

      // Both the candidate scan and the delete carry the receivedAt cutoff (now - grace):
      // a manifest stored inside the register window is never a reap candidate, and a
      // name re-registered fresh between scan and delete survives the delete.
      const graceMs = 7200000; // the configStub's contentManifestReapGraceMs
      const [, scanQuery] = distinctStub.firstCall.args;
      expect(scanQuery.confirmed).to.equal(true);
      expect(scanQuery.receivedAt.$lte).to.be.instanceOf(Date);
      expect(scanQuery.receivedAt.$lte.getTime()).to.be.closeTo(before - graceMs, 5000);
      const [, collection, query] = dbHelperStub.removeDocumentsFromCollection.firstCall.args;
      expect(collection).to.equal('zelappcontentmanifests');
      expect(query.appName).to.deep.equal({ $in: ['dead'] });
      expect(query.confirmed).to.equal(true);
      expect(query.receivedAt.$lte.getTime()).to.be.closeTo(before - graceMs, 5000);
    });

    it('reapOrphanedContentManifests is a no-op when every manifest app is still live', async () => {
      const distinctStub = sinon.stub().resolves(['live']);
      mockDb.db.returns({ collection: sinon.stub().returns({ distinct: distinctStub }) });
      dbHelperStub.findInDatabase.resolves([{ name: 'live' }]);
      const { reaped } = await appsRepository.reapOrphanedContentManifests();
      expect(reaped).to.equal(0);
      sinon.assert.notCalled(dbHelperStub.removeDocumentsFromCollection);
    });

    it('reapOrphanedContentManifests reports zero when the age-gated delete matched nothing (re-registered mid-sweep)', async () => {
      const distinctStub = sinon.stub().resolves(['dead']);
      mockDb.db.returns({ collection: sinon.stub().returns({ distinct: distinctStub }) });
      dbHelperStub.findInDatabase.resolves([]); // no live apps -> 'dead' is an orphan
      dbHelperStub.removeDocumentsFromCollection.resolves({ deletedCount: 0 }); // its row is fresh again

      const { reaped, orphans } = await appsRepository.reapOrphanedContentManifests();
      expect(orphans).to.deep.equal(['dead']);
      expect(reaped).to.equal(0);
    });
  });

  // The row records the identifiers its containers are named by, so ownership is
  // a lookup rather than a decomposition of a container's own name.
  describe('upsertContentManifest', () => {
    // The floor is the write's own logic: with upsert, a non-matching guard
    // filter INSERTS, so refusal used to exist only while the unique index
    // did - a freshly-prepared collection turned refusals into regressions.
    it('refuses an older manifest without leaning on the unique index', async () => {
      dbHelperStub.updateOneInDatabase.resolves({ acknowledged: true, matchedCount: 0 });
      dbHelperStub.findOneInDatabase.resolves({ appName: 'app', version: 3, confirmed: true });
      dbHelperStub.insertOneToDatabase = sinon.stub();
      const stored = await appsRepository.upsertContentManifest(
        { appName: 'app', version: 1, data: {} }, { confirmed: true },
      );
      expect(stored).to.equal(false);
      sinon.assert.notCalled(dbHelperStub.insertOneToDatabase);
    });

    it('inserts fresh when no row exists at all', async () => {
      dbHelperStub.updateOneInDatabase.resolves({ acknowledged: true, matchedCount: 0 });
      dbHelperStub.findOneInDatabase.resolves(null);
      dbHelperStub.insertOneToDatabase = sinon.stub().resolves({});
      const stored = await appsRepository.upsertContentManifest(
        { appName: 'app', version: 1, data: {} }, { confirmed: true },
      );
      expect(stored).to.equal(true);
      sinon.assert.calledOnce(dbHelperStub.insertOneToDatabase);
    });
  });

  describe('backfillComponentIdentifiers', () => {
    it('records identifiers only for rows that lack them', async () => {
      dbHelperStub.findInDatabase.resolves([
        { name: 'alpha', replica: null },
        { name: 'beta', replica: 'r1' },
      ]);
      const identifiersFor = sinon.stub();
      identifiersFor.withArgs('alpha', null).resolves(['web_alpha']);
      identifiersFor.withArgs('beta', 'r1').resolves(['web_beta_r1', 'db_beta_r1']);

      const result = await appsRepository.backfillComponentIdentifiers(identifiersFor);

      expect(result).to.deep.equal({ backfilled: 2, unresolved: 0 });
      // Only rows without the field are looked at — that absence IS the
      // condition, which is what makes an interrupted pass resume safely.
      expect(dbHelperStub.findInDatabase.firstCall.args[2])
        .to.deep.equal({ componentIdentifiers: { $exists: false } });
      expect(dbHelperStub.updateOneInDatabase.firstCall.args[3])
        .to.deep.equal({ $set: { componentIdentifiers: ['web_alpha'] } });
    });

    it('leaves a row whose deployment cannot be built, rather than writing an empty list', async () => {
      dbHelperStub.findInDatabase.resolves([{ name: 'sealed', replica: null }]);
      // A spec this node cannot open. An empty list would read as "this app has
      // no components" and answer the index wrongly for ever.
      const result = await appsRepository.backfillComponentIdentifiers(
        sinon.stub().resolves([]),
      );

      expect(result).to.deep.equal({ backfilled: 0, unresolved: 1 });
      expect(dbHelperStub.updateOneInDatabase.called).to.equal(false);
    });

    it('survives a resolver that throws, and counts the row unresolved', async () => {
      dbHelperStub.findInDatabase.resolves([{ name: 'boom', replica: null }]);
      const result = await appsRepository.backfillComponentIdentifiers(
        sinon.stub().rejects(new Error('cannot decrypt')),
      );

      expect(result).to.deep.equal({ backfilled: 0, unresolved: 1 });
      expect(dbHelperStub.updateOneInDatabase.called).to.equal(false);
    });

    it('does nothing at all when every row already states them', async () => {
      dbHelperStub.findInDatabase.resolves([]);
      const identifiersFor = sinon.stub();

      const result = await appsRepository.backfillComponentIdentifiers(identifiersFor);

      expect(result).to.deep.equal({ backfilled: 0, unresolved: 0 });
      expect(identifiersFor.called).to.equal(false);
    });

    it('refuses to run without a resolver rather than clearing the field', async () => {
      let thrown = null;
      try {
        await appsRepository.backfillComponentIdentifiers();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).to.be.an('error');
      expect(thrown.message).to.match(/identifiersFor required/);
    });
  });
});