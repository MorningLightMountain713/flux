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
          isEncrypted: () => false,
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

  describe('raw accessors skip hydration', () => {
    it('getGlobalAppInfoRaw returns the raw doc without version dispatch', async () => {
      const doc = { name: 'raw', version: 7, hash: 'h' };
      dbHelperStub.findOneInDatabase.resolves(doc);

      const result = await appsRepository.getGlobalAppInfoRaw('raw');
      expect(result).to.equal(doc);
      expect(specLibsStub.getSpec.called).to.be.false;
    });

    it('getGlobalAppInfoRaw merges caller projection with _id:0 default', async () => {
      dbHelperStub.findOneInDatabase.resolves(null);
      await appsRepository.getGlobalAppInfoRaw('x', { name: 1, hash: 1 });
      const options = dbHelperStub.findOneInDatabase.firstCall.args[3];
      expect(options.projection).to.deep.equal({ _id: 0, name: 1, hash: 1 });
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

    it('tolerates legacy zelAppSpecifications field name', async () => {
      const V = { deserialize: sinon.stub().returns({ name: 'y' }) };
      versionRegistry.set(7, V);

      dbHelperStub.findOneInDatabase.resolves({
        hash: 'legacy',
        height: 1,
        zelAppSpecifications: { name: 'y', version: 7 },
      });

      const result = await appsRepository.getAppMessage('legacy');
      expect(result.spec).to.not.be.null;
      expect(result.spec.spec.name).to.equal('y');
    });
  });
});
