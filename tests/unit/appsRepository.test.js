'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const {
  loadSpecLibrary, v1Spec, v8Spec, v9Spec, sealedV8Spec, sealedV9Spec,
  instantiatedSpec, assertAnswers,
} = require('./fixtures/fluxSpec');

// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. This is the repository layer, so what the tests hand it are real STORED
// forms: an InstantiatedSpec's serialization, cleartext or node-sealed. What stays
// stubbed is I/O — mongo through dbHelper, and the event-log collection handle the
// running-set derivation reads directly.
let flux;

describe('appsRepository', () => {
  let appsRepository;
  let dbHelperStub;
  let specLibsStub;
  let logStub;
  let mockDb;
  let eventCollection;
  let runningCounts;
  let moveStamps;

  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30000);
    flux = await loadSpecLibrary();
  });

  /**
   * The stored form of a legacy (v1–v8) app: the spec's wire form plus the chain
   * state InstantiatedSpec appends. `registeredAt` is dropped because a legacy row
   * carries none — it anchors v9's time-based TTL, and InstantiatedSpec.serialize
   * omits it when it is null.
   */
  async function legacyDoc(spec, { hash = 'h1', height = 2550000 } = {}) {
    const doc = (await instantiatedSpec(spec, { hash, height })).serialize();
    delete doc.registeredAt;
    return doc;
  }

  /** The stored form of a v9 app, cleartext or node-sealed. */
  async function modernDoc(spec, { hash = 'h9', height = 2550000, registeredAt = 1751628800 } = {}) {
    return (await instantiatedSpec(spec, { hash, height, registeredAt })).serialize();
  }

  /**
   * A real FluxAppSpecV1 — the only stored form that carries no `instances` at
   * all (v1 predates the field and the class hardcodes 3), which is the row
   * findUnderProvisionedApps' `?? 3` default exists for. Built from the shared v8
   * fixture's own single component, so it is the same app in the flat v1 shape.
   */

  beforeEach(() => {
    // countRunningByApp reads the event log directly off the collection handle:
    // resolveAddressMoves does a find, the count pipeline an aggregate.
    runningCounts = [];
    moveStamps = [];
    // The collection answers by query, as the real one does: the apprunning
    // timestamps the address-move resolver asks for, and the location
    // pipeline itself.
    eventCollection = {
      find: sinon.stub().returns({ toArray: async () => [] }),
      aggregate: sinon.stub().callsFake((pipeline) => {
        const match = pipeline[0]?.$match ?? {};
        if (match.type === 'apprunning') return { toArray: async () => moveStamps };
        return { toArray: async () => runningCounts };
      }),
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

    // specLibs is FluxOS's own bridge to the spec library, and both accessors
    // return the same flattened namespace (ZelBack/src/services/utils/specLibs.js),
    // so the stub hands back the real one. hydrate() then runs the real
    // InstantiatedSpec.deserialize over the real version registry — which is the
    // whole of this module's read path.
    specLibsStub = {
      getSpec: sinon.stub().callsFake(async () => flux),
      getSpecBackend: sinon.stub().callsFake(async () => flux),
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
      const doc = await legacyDoc(await v8Spec({ name: 'example' }), { hash: 'h', height: 100 });
      const deserialize = sinon.spy(flux.FluxAppSpecV8, 'deserialize');
      dbHelperStub.findOneInDatabase.resolves(doc);

      const result = await appsRepository.getGlobalAppInfo('example');
      expect(result).to.be.instanceOf(flux.InstantiatedSpec);
      expect(result.spec).to.be.instanceOf(flux.FluxAppSpecV8);
      expect(result.hash).to.equal('h');
      expect(result.height).to.equal(100);
      expect(result.name).to.equal('example');
      expect(result.isEncrypted, 'a cleartext row is not encrypted').to.be.false;
      sinon.assert.calledOnce(deserialize);
      expect(deserialize.firstCall.args[0]).to.deep.equal(doc);
      // assertNoNameConflicts reads both off this object, and only the real class
      // derives the second — a legacy app's expiry is height + expire over the fork.
      expect(result.expiresAtHeight).to.be.a('number').and.be.greaterThan(100);
    });

    it('returns null and logs when no version class is registered', async () => {
      const doc = { name: 'phantom', version: 99, hash: 'h', height: 100 };
      dbHelperStub.findOneInDatabase.resolves(doc);
      const result = await appsRepository.getGlobalAppInfo('phantom');
      expect(result).to.be.null;
      expect(logStub.warn.calledOnce).to.be.true;
      expect(logStub.warn.firstCall.args[0]).to.include('version 99');
    });

    it('hydrates v9 documents through InstantiatedSpec.deserialize', async () => {
      const doc = await modernDoc(await v9Spec({ name: 'modern' }), { hash: 'h', height: 100 });
      dbHelperStub.findOneInDatabase.resolves(doc);
      const result = await appsRepository.getGlobalAppInfo('modern');
      expect(result).to.not.be.null;
      expect(result.spec).to.be.instanceOf(flux.FluxAppSpecV9);
      expect(result.name).to.equal('modern');
      // v9 is time-based, so the row carries the confirming block's timestamp
      expect(result.registeredAt).to.equal(1751628800);
    });

    // The double this replaced could not hydrate a sealed row at all: it hardcoded
    // isEncrypted:false and threw outright on a v8 enterprise doc. Both forms are
    // ordinary stored rows, and encryption is the fact every consumer branches on.
    it('hydrates a node-sealed v9 row and reports it encrypted', async () => {
      const doc = await modernDoc(await sealedV9Spec({ name: 'sealed9' }), { hash: 'hs9', height: 900 });
      dbHelperStub.findOneInDatabase.resolves(doc);

      const result = await appsRepository.getGlobalAppInfo('sealed9');
      expect(result.spec).to.be.instanceOf(flux.EncryptedSpecV9);
      expect(result.isEncrypted).to.be.true;
      expect(result.requiresArcane(), 'only an Arcane node can unseal it').to.be.true;
      // Judging fitness without unsealing is what the cleartext summary is for, and
      // it survives the trip through storage.
      expect(result.resourceTotals()).to.include({ cpu: 0.5, memoryMb: 300 });
    });

    it('hydrates a v8 enterprise row', async () => {
      const doc = await legacyDoc(await sealedV8Spec({ name: 'sealed8' }), { hash: 'hs8', height: 800 });
      dbHelperStub.findOneInDatabase.resolves(doc);

      const result = await appsRepository.getGlobalAppInfo('sealed8');
      expect(result.spec).to.be.instanceOf(flux.EncryptedSpecV8);
      expect(result.isEncrypted).to.be.true;
      // v8's blob carries no cleartext summary at all: "I cannot tell from here".
      expect(result.resourceTotals()).to.be.null;
    });

    it('strips the storage-only fields a sealed spec would refuse', async () => {
      // `replica` and `componentIdentifiers` are this collection's own key and
      // index, not part of any spec wire form. hydrate strips them because the
      // encrypted deserializers reject an unknown field outright rather than
      // letting it into the AAD and failing later as an opaque GCM error.
      const stored = await modernDoc(await sealedV9Spec({ name: 'sealed9' }));
      expect(
        () => flux.InstantiatedSpec.deserialize({ ...stored, replica: 'r1' }),
        'the real class must refuse a decorated doc, or this test proves nothing',
      ).to.throw(/unexpected fields/);

      dbHelperStub.findOneInDatabase.resolves({
        ...stored, replica: 'r1', componentIdentifiers: ['web_sealed9_r1'],
      });
      const result = await appsRepository.getInstalledIdentity('sealed9', 'r1');
      expect(result).to.not.be.null;
      expect(result.spec).to.be.instanceOf(flux.EncryptedSpecV9);
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

    // upsertIfNewer is the one write that takes a spec OBJECT rather than a
    // document, and dbHelper is stubbed here — so nothing in this suite reads the
    // row back. hydrate will, on the next boot, which makes "the real deserializer
    // accepts what we wrote" the assertion that stands in for it.
    it('upsertIfNewer stores a form hydrate can read back', async () => {
      const instantiated = await instantiatedSpec(
        await v9Spec({ name: 'newerapp' }), { hash: 'h2', height: 200 },
      );
      dbHelperStub.findOneInDatabase.resolves({ height: 100 });
      dbHelperStub.replaceOneInDatabase.resolves({ matchedCount: 1 });

      expect(await appsRepository.upsertIfNewer(instantiated)).to.be.true;

      const doc = dbHelperStub.replaceOneInDatabase.firstCall.args[3];
      const rehydrated = flux.InstantiatedSpec.deserialize(doc);
      expect(rehydrated.name).to.equal('newerapp');
      expect(rehydrated.hash).to.equal('h2');
      expect(rehydrated.height).to.equal(200);
      expect(rehydrated.spec).to.be.instanceOf(flux.FluxAppSpecV9);
    });

    it('upsertIfNewer refuses a spec no newer than the stored height', async () => {
      const instantiated = await instantiatedSpec(
        await v9Spec({ name: 'newerapp' }), { hash: 'h2', height: 100 },
      );
      dbHelperStub.findOneInDatabase.resolves({ height: 100 });

      expect(await appsRepository.upsertIfNewer(instantiated)).to.be.false;
      sinon.assert.notCalled(dbHelperStub.replaceOneInDatabase);
    });
  });

  describe('list accessors', () => {
    it('listGlobalAppInfo hydrates every document into InstantiatedSpec', async () => {
      // Two rows of different vintages, because the list is version-mixed in
      // production and one deserializer standing in for both would hide it.
      dbHelperStub.findInDatabase.resolves([
        await legacyDoc(await v8Spec({ name: 'appa' }), { hash: 'h1', height: 10 }),
        await modernDoc(await v9Spec({ name: 'appb' }), { hash: 'h2', height: 20 }),
      ]);

      const result = await appsRepository.listGlobalAppInfo();
      expect(result).to.have.length(2);
      expect(result[0].spec).to.be.instanceOf(flux.FluxAppSpecV8);
      expect(result[0].name).to.equal('appa');
      expect(result[0].hash).to.equal('h1');
      expect(result[1].spec).to.be.instanceOf(flux.FluxAppSpecV9);
      expect(result[1].name).to.equal('appb');
      expect(result[1].hash).to.equal('h2');
    });

    it('listGlobalAppInfo drops docs whose version class is missing', async () => {
      dbHelperStub.findInDatabase.resolves([
        await legacyDoc(await v8Spec({ name: 'appa' }), { hash: 'h1', height: 10 }),
        { name: 'appb', version: 42, hash: 'h2', height: 20 }, // no class registered
      ]);

      const result = await appsRepository.listGlobalAppInfo();
      expect(result).to.have.length(1);
      expect(result[0].name).to.equal('appa');
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
      moveStamps = [{ _id: 'old:16127', latest: new Date(now - 1000) }];
      runningCounts = [{ _id: 'old:16127' }];

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
      moveStamps = [
        { _id: 'old:16127', latest: new Date(now - 1000) },
        // not newer than the pre-move announcement, so this translates, not supersedes
        { _id: 'new:16127', latest: new Date(now - 2000) },
      ];
      runningCounts = [{ _id: 'old:16127' }, { _id: 'new:16127' }];

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
      // A permanent message stores the spec's own wire form and nothing else: the
      // chain state lives on the message, and hydrate is what puts the two together.
      const spec = await v8Spec({ name: 'legacyapp' });
      const message = { hash: 'abc', height: 500, appSpecifications: spec.serialize() };
      const deserialize = sinon.spy(flux.FluxAppSpecV8, 'deserialize');
      dbHelperStub.findOneInDatabase.resolves(message);

      const result = await appsRepository.getAppMessage('abc');
      expect(result.message).to.equal(message);
      expect(result.spec.spec).to.be.instanceOf(flux.FluxAppSpecV8);
      expect(result.spec.spec.name).to.equal('legacyapp');
      expect(result.spec.hash).to.equal('abc');
      expect(result.spec.height).to.equal(500);

      // The hydrate call should have received the spec blob with hash/height appended
      const docForHydrate = deserialize.firstCall.args[0];
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
    it('returns nothing when no app is alive', async () => {
      dbHelperStub.aggregateInDatabase.resolves([]);
      const result = await appsRepository.findUnderProvisionedApps(2555000, 1716000000);
      expect(result).to.deep.equal([]);
    });

    it('flags an app running fewer replicas than it wants', async () => {
      const doc = await legacyDoc(await v8Spec({ name: 'testApp', instances: 3 }));
      dbHelperStub.aggregateInDatabase.resolves([doc]);
      runningCounts = [{ _id: 'testApp', count: 1 }];

      const result = await appsRepository.findUnderProvisionedApps(2555000, 1716000000);

      expect(result).to.have.lengthOf(1);
      expect(result[0].instantiated.name).to.equal('testApp');
      expect(result[0].actual).to.equal(1);
      expect(result[0].required).to.equal(3);

      // The spawner is this query's only consumer, and it is not in this suite —
      // so nothing else here exercises what it does with a candidate. It sizes
      // one, screens it for Arcane, reads its dependency edges and filters on its
      // placement, so assert the object can answer all of that. The double this
      // replaced answered none of it, and the suite was green regardless.
      assertAnswers(result[0].instantiated, ['resourceTotals', 'requiresArcane', 'linkedAppNames', 'serialize']);
      expect(result[0].instantiated.spec.placement, 'the spawner filters candidates on it').to.exist;
      expect(result[0].instantiated.hash, 'and caches its spawn attempts by it').to.equal('h1');
    });

    it('leaves an app alone once it is at target', async () => {
      dbHelperStub.aggregateInDatabase.resolves([await legacyDoc(await v8Spec({ name: 'testApp', instances: 3 }))]);
      runningCounts = [{ _id: 'testApp', count: 3 }];

      expect(await appsRepository.findUnderProvisionedApps(2555000, 1716000000)).to.deep.equal([]);
    });

    // The count is keyed off the announced name; app names are matched
    // case-insensitively everywhere else, and a miss here reads as zero instances
    // and spawns a replica that is already running.
    it('matches the running count to the spec name case-insensitively', async () => {
      dbHelperStub.aggregateInDatabase.resolves([await legacyDoc(await v8Spec({ name: 'TestApp', instances: 3 }))]);
      runningCounts = [{ _id: 'testapp', count: 3 }];

      expect(await appsRepository.findUnderProvisionedApps(2555000, 1716000000)).to.deep.equal([]);
    });

    it('treats an app with no running replicas as fully under-provisioned', async () => {
      dbHelperStub.aggregateInDatabase.resolves([await legacyDoc(await v8Spec({ name: 'ghost', instances: 2 }))]);
      runningCounts = [];

      const result = await appsRepository.findUnderProvisionedApps(2555000, 1716000000);
      expect(result).to.have.lengthOf(1);
      expect(result[0].actual).to.equal(0);
      expect(result[0].required).to.equal(2);
    });

    it('defaults the target to 3 when the spec does not say', async () => {
      // A real v1 row, the only stored form with no `instances` at all — the
      // reason the default exists. Every later version states one, and the real
      // library refuses a v2+ row that omits it.
      const doc = await legacyDoc(await v1Spec({ name: 'noinstances' }));
      expect(doc, 'a v1 row carries no instances').to.not.have.property('instances');
      dbHelperStub.aggregateInDatabase.resolves([doc]);
      runningCounts = [{ _id: 'noinstances', count: 2 }];

      const result = await appsRepository.findUnderProvisionedApps(2555000, 1716000000);
      expect(result).to.have.lengthOf(1);
      expect(result[0].required).to.equal(3);
    });

    it('skips docs that fail hydration', async () => {
      const good = await legacyDoc(await v8Spec({ name: 'goodApp', instances: 3 }), { hash: 'h1', height: 100 });
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
      const doc = await modernDoc(await sealedV9Spec({ name: 'testapp' }), { hash: 'h1', height: 2550000 });
      const storedKeys = Object.keys(doc).sort();
      expect(
        () => flux.InstantiatedSpec.deserialize({ ...doc, _isAlive: true }),
        'a decorated sealed doc must be refused, or this test proves nothing',
      ).to.throw(/unexpected fields/);
      dbHelperStub.aggregateInDatabase.resolves([doc]);
      runningCounts = [];

      const result = await appsRepository.findUnderProvisionedApps(2555000, 1716000000);

      const pipeline = dbHelperStub.aggregateInDatabase.firstCall.args[2];
      // no join, and nothing left of the aliveness check
      expect(pipeline.some((stage) => stage.$lookup)).to.be.false;
      expect(pipeline.filter((stage) => stage.$unset).map((stage) => stage.$unset)).to.deep.include('_isAlive');
      expect(Object.keys(doc).sort(), 'nothing above hydrate may decorate the stored doc').to.deep.equal(storedKeys);
      // and the proof that matters: the real deserializer accepted it. A decorated
      // doc would have been refused and the app would simply have vanished here.
      expect(result).to.have.lengthOf(1);
      expect(result[0].instantiated.isEncrypted).to.be.true;
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