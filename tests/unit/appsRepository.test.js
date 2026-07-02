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

  beforeEach(() => {
    mockDb = { db: sinon.stub().returns({ collection: sinon.stub() }) };

    dbHelperStub = {
      databaseConnection: sinon.stub().returns(mockDb),
      findOneInDatabase: sinon.stub(),
      findInDatabase: sinon.stub(),
      replaceOneInDatabase: sinon.stub(),
      removeDocumentsFromCollection: sinon.stub(),
      updateOneInDatabase: sinon.stub().resolves({ acknowledged: true }),
      aggregateInDatabase: sinon.stub().resolves([]),
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
            appsLocations: 'zelappslocation',
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

    it('should return empty array when no results', async () => {
      dbHelperStub.aggregateInDatabase.resolves([]);
      const result = await appsRepository.findUnderProvisionedApps(2555000, 1716000000);
      expect(result).to.deep.equal([]);
    });

    it('should hydrate pipeline results and return candidates', async () => {
      const doc = { version: 7, name: 'testApp', owner: 'owner1', hash: 'h1', height: 2550000, instances: 3 };
      dbHelperStub.aggregateInDatabase.resolves([{ actual: 1, required: 3, doc }]);
      const result = await appsRepository.findUnderProvisionedApps(2555000, 1716000000);
      expect(result).to.have.lengthOf(1);
      expect(result[0].instantiated.name).to.equal('testApp');
      expect(result[0].actual).to.equal(1);
      expect(result[0].required).to.equal(3);
    });

    it('should skip docs that fail hydration', async () => {
      const good = { version: 7, name: 'goodApp', owner: 'o1', hash: 'h1', height: 100, instances: 3 };
      const bad = { version: 99, name: 'badApp', owner: 'o2', hash: 'h2', height: 100, instances: 3 };
      dbHelperStub.aggregateInDatabase.resolves([
        { actual: 0, required: 3, doc: good },
        { actual: 0, required: 3, doc: bad },
      ]);
      const result = await appsRepository.findUnderProvisionedApps(2555000, 1716000000);
      expect(result).to.have.lengthOf(1);
      expect(result[0].instantiated.name).to.equal('goodApp');
    });

    it('strips its working fields before the doc leaves the pipeline (AAD safety)', async () => {
      // Encrypted specs bind cleartext metadata into the AAD; a doc decorated
      // with pipeline scratch fields fails decryption. The pipeline must
      // emit { actual, required, doc } with the doc byte-identical to storage.
      dbHelperStub.aggregateInDatabase.resolves([]);
      await appsRepository.findUnderProvisionedApps(2555000, 1716000000);
      const pipeline = dbHelperStub.aggregateInDatabase.firstCall.args[2];
      const replaceWith = pipeline.find((stage) => stage.$replaceWith);
      expect(replaceWith.$replaceWith).to.deep.equal({ actual: '$_actual', required: '$_required', doc: '$$ROOT' });
      const unsets = pipeline.filter((stage) => stage.$unset).map((stage) => stage.$unset);
      expect(unsets).to.deep.include('_isAlive');
      expect(unsets).to.deep.include('_locations');
      expect(unsets).to.deep.include(['doc._actual', 'doc._required']);
      // the final stage leaves nothing of the pipeline's own bookkeeping behind
      expect(pipeline[pipeline.length - 1]).to.deep.equal({ $unset: ['doc._actual', 'doc._required'] });
    });

    it('should pass currentHeight and nowSeconds into the pipeline', async () => {
      dbHelperStub.aggregateInDatabase.resolves([]);
      await appsRepository.findUnderProvisionedApps(2555000, 1716000000);
      expect(dbHelperStub.aggregateInDatabase.calledOnce).to.be.true;
      const pipeline = dbHelperStub.aggregateInDatabase.firstCall.args[2];
      expect(pipeline).to.be.an('array');
      expect(pipeline.length).to.be.gte(4);
    });

    it('should include v9 TTL branch in the expiry check', async () => {
      dbHelperStub.aggregateInDatabase.resolves([]);
      await appsRepository.findUnderProvisionedApps(2555000, 1716000000);
      const pipeline = dbHelperStub.aggregateInDatabase.firstCall.args[2];
      const addFieldsStage = pipeline[0];
      expect(addFieldsStage.$addFields._isAlive.$cond.if).to.deep.equal({ $gte: ['$version', 9] });
    });

    it('should sort results by name', async () => {
      dbHelperStub.aggregateInDatabase.resolves([]);
      await appsRepository.findUnderProvisionedApps(2555000, 1716000000);
      const pipeline = dbHelperStub.aggregateInDatabase.firstCall.args[2];
      const sortStage = pipeline.find((stage) => stage.$sort);
      expect(sortStage.$sort).to.deep.equal({ name: 1 });
    });
  });

  describe('content manifests', () => {
    it('upsert: a confirmed store advances a higher version OR promotes a same-version quarantined row', async () => {
      const row = { appName: 'app', version: 2, data: { d: 1 } };
      const ok = await appsRepository.upsertContentManifest(row, { confirmed: true, clearEnvelope: true });
      expect(ok).to.equal(true);
      const [, collection, filter, update, opts] = dbHelperStub.updateOneInDatabase.firstCall.args;
      expect(collection).to.equal('zelappcontentmanifests');
      expect(filter).to.deep.equal({ appName: 'app', $or: [{ version: { $lt: 2 } }, { version: 2, confirmed: false }] });
      expect(opts).to.deep.equal({ upsert: true });
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
      expect(query).to.deep.equal({ confirmed: true });
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
});
