'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const { asConfig } = require('./fixtures/config');
const {
  loadSpecLibrary, v8Spec, v9Spec, sealedV8Spec, sealedV9Spec, instantiatedSpec,
} = require('./fixtures/fluxSpec');
const { installedRecord } = require('./fixtures/appRecords');
const moduleLoader = require('../../ZelBack/src/lib/moduleLoader');

// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. This is the repository layer, so what the tests hand it are real STORED
// forms: an InstantiatedSpec's serialization, cleartext or node-sealed. What stays
// stubbed is I/O — mongo through dbHelper, and the event-log collection handle the
// running-set derivation reads directly. The app messages are a real collection
// over the library's in-memory store.
let flux;
let InMemoryStorageProvider;

describe('appsRepository', () => {
  let appsRepository;
  let registryStub;
  let installedStub;
  let messages;
  let dbHelperStub;
  let specLibsStub;
  let decisionStoreStub;
  let logStub;
  let mockDb;
  let eventCollection;
  let runningCounts;
  let moveStamps;

  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30_000);
    flux = await loadSpecLibrary();
    ({ InMemoryStorageProvider } = await moduleLoader.importModule('@runonflux/flux-spec-backend/testing'));
  });

  // A message the chain paid for and this node holds.
  async function confirm({ hash, height, ...contents }) {
    await messages.recordPayment({
      hash, txid: `tx-${hash}`, height, value: 100,
    });
    await messages.storeContents({
      type: 'fluxappregister', version: 1, timestamp: height * 1000, signature: 'sig', ...contents, hash,
    });
  }

  // Contents the pool holds, unpaid.
  async function pool({ hash, ...contents }) {
    await messages.storeContents({
      type: 'fluxappregister', version: 1, timestamp: 1000, signature: 'sig', ...contents, hash,
    }, { receivedAt: new Date(1000), payableUntil: new Date(2000) });
  }

  /**
   * The stored form of a legacy (v1–v8) app: the spec's wire form plus the chain
   * state InstantiatedSpec appends. `registeredAt` is dropped because a legacy row
   * carries none — it anchors v9's time-based TTL, and InstantiatedSpec.serialize
   * omits it when it is null.
   */
  async function legacyDoc(spec, { hash = 'h1', height = 2_550_000 } = {}) {
    const doc = (await instantiatedSpec(spec, { hash, height })).serialize();
    delete doc.registeredAt;
    return doc;
  }

  /** The stored form of a v9 app, cleartext or node-sealed. */
  async function modernDoc(spec, { hash = 'h9', height = 2_550_000, registeredAt = 1_751_628_800 } = {}) {
    return (await instantiatedSpec(spec, { hash, height, registeredAt })).serialize();
  }

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

    // The app registry: nothing listed, nothing pinned, unless a test says so.
    registryStub = { byName: sinon.stub().resolves(null), byIdentity: sinon.stub().resolves(null), pinned: sinon.stub().resolves([]) };
    installedStub = { byName: sinon.stub().resolves(null), byIdentity: sinon.stub().resolves(null) };
    messages = new flux.AppMessages(new InMemoryStorageProvider());

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
      },
    };

    // The applied specs of earlier apps of a name: none unless a test says so.
    decisionStoreStub = { earlierAppsHashes: sinon.stub().resolves([]) };

    appsRepository = proxyquire('../../ZelBack/src/services/appDatabase/appsRepository', {
      config: asConfig(configStub),
      '../appDecisions/decisionStore': decisionStoreStub,
      '../../lib/log': logStub,
      '../dbHelper': dbHelperStub,
      '../utils/specLibs': specLibsStub,
      '../utils/appConstants': {
        globalAppsInformation: 'zelappsinformation',
        localAppsInformation: 'zelappsinformation',
        globalAppsIngressAttestations: 'appingressattestations',
        globalAppsIngressAttestationDigests: 'appingressattestationdigests',
        globalAppsInstallingErrorsLocations: 'appsinstallingerrorslocations',
        globalAppsInstallingErrorsBroadcasts: 'appsinstallingerrorsbroadcasts',
      },
      './appRecords': { registry: () => registryStub, installed: () => installedStub, messages: () => messages },
    });
  });

  afterEach(() => sinon.restore());

  // hydrate is the one door from a stored message's spec document to an
  // InstantiatedSpec; getAppMessage is the read that goes through it.
  describe('hydration', () => {
    const messageWith = (doc) => {
      const { hash, height, ...appSpecifications } = doc;
      return { hash, height, appSpecifications };
    };

    it('returns null for a hash it does not hold', async () => {
      expect(await appsRepository.getAppMessage('unknown')).to.be.null;
    });

    it('dispatches to the registered version class and wraps in InstantiatedSpec', async () => {
      const doc = await legacyDoc(await v8Spec({ name: 'example' }), { hash: 'h', height: 100 });
      const deserialize = sinon.spy(flux.FluxAppSpecV8, 'deserialize');
      await confirm(messageWith(doc));

      const { spec: result } = await appsRepository.getAppMessage('h');
      expect(result).to.be.instanceOf(flux.InstantiatedSpec);
      expect(result.spec).to.be.instanceOf(flux.FluxAppSpecV8);
      expect(result.hash).to.equal('h');
      expect(result.height).to.equal(100);
      expect(result.name).to.equal('example');
      expect(result.isEncrypted, 'a cleartext row is not encrypted').to.be.false;
      sinon.assert.calledOnce(deserialize);
      // The record takes its own fields off: the spec class sees the spec's only.
      const specFields = { ...doc };
      delete specFields.hash;
      delete specFields.height;
      expect(deserialize.firstCall.args[0]).to.deep.equal(specFields);
      // Only the real class derives the second: a legacy app's expiry is
      // height + expire over the fork.
      expect(result.expiresAtHeight).to.be.a('number').and.be.greaterThan(100);
    });

    it('returns no spec and logs when no version class is registered', async () => {
      await confirm(messageWith({ name: 'phantom', version: 99, hash: 'h', height: 100 }));
      const { spec } = await appsRepository.getAppMessage('h');
      expect(spec).to.be.null;
      expect(logStub.warn.calledOnce).to.be.true;
      expect(logStub.warn.firstCall.args[0]).to.include('version 99');
    });

    it('hydrates v9 documents through InstantiatedSpec.deserialize', async () => {
      const doc = await modernDoc(await v9Spec({ name: 'modern' }), { hash: 'h', height: 100 });
      await confirm(messageWith(doc));
      const { spec: result } = await appsRepository.getAppMessage('h');
      expect(result).to.not.be.null;
      expect(result.spec).to.be.instanceOf(flux.FluxAppSpecV9);
      expect(result.name).to.equal('modern');
      // v9 is time-based, so the row carries the confirming block's timestamp
      expect(result.registeredAt).to.equal(1_751_628_800);
    });

    it('hydrates a node-sealed v9 document and reports it encrypted', async () => {
      const doc = await modernDoc(await sealedV9Spec({ name: 'sealed9' }), { hash: 'hs9', height: 900 });
      await confirm(messageWith(doc));

      const { spec: result } = await appsRepository.getAppMessage('hs9');
      expect(result.spec).to.be.instanceOf(flux.EncryptedSpecV9);
      expect(result.isEncrypted).to.be.true;
      expect(result.requiresArcane(), 'only an Arcane node can unseal it').to.be.true;
      // Judging fitness without unsealing is what the cleartext summary is for, and
      // it survives the trip through storage.
      expect(result.resourceTotals()).to.include({ cpu: 0.5, memoryMb: 300 });
    });

    it('hydrates a v8 enterprise document', async () => {
      const doc = await legacyDoc(await sealedV8Spec({ name: 'sealed8' }), { hash: 'hs8', height: 800 });
      await confirm(messageWith(doc));

      const { spec: result } = await appsRepository.getAppMessage('hs8');
      expect(result.spec).to.be.instanceOf(flux.EncryptedSpecV8);
      expect(result.isEncrypted).to.be.true;
      // v8's blob carries no cleartext summary at all: "I cannot tell from here".
      expect(result.resourceTotals()).to.be.null;
    });
  });

  describe('getApplicationOwner', () => {
    it('answers the registry record\'s owner without reading the installed list', async () => {
      registryStub.byName.resolves({ owner: 'ownerX' });
      expect(await appsRepository.getApplicationOwner('app')).to.equal('ownerX');
      sinon.assert.calledOnceWithExactly(registryStub.byName, 'app');
      sinon.assert.notCalled(dbHelperStub.findInDatabase);
    });

    it('falls back to an app this node has installed under the name', async () => {
      const installed = await instantiatedSpec(await v8Spec({ name: 'LocalOnly' }), { hash: 'hl', height: 100 });
      installedStub.byName.withArgs('localonly').resolves(installedRecord(installed));
      expect(await appsRepository.getApplicationOwner('localonly')).to.equal(installed.owner);
    });

    it('answers null when neither the registry nor this node holds the name', async () => {
      expect(await appsRepository.getApplicationOwner('nothing')).to.equal(null);
    });
  });

  describe('removeAppInstallingErrorRecords', () => {
    const deletions = () => dbHelperStub.removeDocumentsFromCollection.getCalls().map((call) => call.args.slice(1));

    it('deletes every report about the name, the location rows and the archived broadcasts', async () => {
      await appsRepository.removeAppInstallingErrorRecords('myapp');

      expect(deletions()).to.deep.equal([
        ['appsinstallingerrorslocations', { name: 'myapp' }],
        ['appsinstallingerrorsbroadcasts', { 'data.name': 'myapp' }],
      ]);
    });

    it('with a hash to keep, deletes only the reports about the name\'s other specs', async () => {
      await appsRepository.removeAppInstallingErrorRecords('myapp', { keepHash: 'h2' });

      expect(deletions()).to.deep.equal([
        ['appsinstallingerrorslocations', { name: 'myapp', hash: { $ne: 'h2' } }],
        ['appsinstallingerrorsbroadcasts', { 'data.name': 'myapp', 'data.hash': { $ne: 'h2' } }],
      ]);
    });
  });

  describe('getApplicationOwnerByIdentity', () => {
    let IDENTITY;

    before(() => { IDENTITY = flux.appIdentityFromUuid('ab'.repeat(32)); });

    it('answers the registry record\'s owner without reading the installed list', async () => {
      registryStub.byIdentity.resolves({ owner: 'ownerX' });
      expect(await appsRepository.getApplicationOwnerByIdentity(IDENTITY)).to.equal('ownerX');
      sinon.assert.calledOnceWithExactly(registryStub.byIdentity, IDENTITY);
      sinon.assert.notCalled(installedStub.byIdentity);
    });

    it('falls back to the app this node has installed with the identity', async () => {
      const installed = await instantiatedSpec(await v8Spec({ name: 'LocalOnly' }), { hash: 'hl', height: 100, identity: IDENTITY });
      installedStub.byIdentity.withArgs(IDENTITY).resolves(installedRecord(installed));
      expect(await appsRepository.getApplicationOwnerByIdentity(IDENTITY)).to.equal(installed.owner);
    });

    it('answers null for an identity neither holds, and reads no app by name', async () => {
      registryStub.byName.resolves({ owner: 'ownerOfTheName' });
      expect(await appsRepository.getApplicationOwnerByIdentity(IDENTITY)).to.equal(null);
      sinon.assert.notCalled(registryStub.byName);
    });

    it('reads a value that is not in an identity\'s form as the name of an app with no identity minted', async () => {
      registryStub.byName.withArgs('legacyapp').resolves({ owner: 'ownerOfTheName' });
      expect(await appsRepository.getApplicationOwnerByIdentity('legacyapp')).to.equal('ownerOfTheName');
    });
  });

  describe('writes', () => {
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

  describe('carriedManifestRanks', () => {
    it('reads the rank of each manifest held in the pool for an identity', async () => {
      await pool({ hash: 'm3', contentManifest: { identity: 'bident', version: 3, ownedFrom: 100 } });
      await pool({ hash: 'm2', contentManifest: { identity: 'bident', version: 2, ownedFrom: 0 } });
      await pool({ hash: 'other', contentManifest: { identity: 'cident', version: 9, ownedFrom: 0 } });

      const ranks = await appsRepository.carriedManifestRanks('bident');

      expect(ranks).to.have.deep.members([{ version: 3, ownedFrom: 100 }, { version: 2, ownedFrom: 0 }]);
    });
  });

  describe('getAppMessage', () => {
    it('returns null when the hash is not found', async () => {
      const result = await appsRepository.getAppMessage('nope');
      expect(result).to.be.null;
    });

    it('hydrates the nested appSpecifications into InstantiatedSpec', async () => {
      // A permanent message stores the spec's own wire form and nothing else: the
      // chain state lives on the message, and hydrate is what puts the two together.
      const spec = await v8Spec({ name: 'legacyapp' });
      const deserialize = sinon.spy(flux.FluxAppSpecV8, 'deserialize');
      await confirm({ hash: 'abc', height: 500, appSpecifications: spec.serialize() });

      const result = await appsRepository.getAppMessage('abc');
      expect(result.message).to.deep.include({ hash: 'abc', height: 500, appSpecifications: spec.serialize() });
      expect(result.spec.spec).to.be.instanceOf(flux.FluxAppSpecV8);
      expect(result.spec.spec.name).to.equal('legacyapp');
      expect(result.spec.hash).to.equal('abc');
      expect(result.spec.height).to.equal(500);

      // The record carries the message's chain state; the spec class sees the
      // spec's own wire form and nothing else.
      expect(deserialize.firstCall.args[0]).to.deep.equal(spec.serialize());
    });
  });

  describe('countRunningByApp', () => {
    it('counts the running instances of each app by lower-cased name, leaving out those running an earlier app of the name', async () => {
      runningCounts = [{ _id: 'TestApp', count: 2 }];
      decisionStoreStub.earlierAppsHashes.resolves(['earlierhash']);

      const counts = await appsRepository.countRunningByApp();

      expect([...counts]).to.deep.equal([['testapp', 2]]);
      const countPipeline = eventCollection.aggregate.getCalls()
        .map((call) => call.args[0])
        .find((pipeline) => pipeline.some((stage) => stage.$group && stage.$group._id === '$_v2Filtered.apps.name'));
      expect(countPipeline.some((stage) => stage.$match?.['_v2Filtered.apps.hash']?.$nin?.includes('earlierhash'))).to.equal(true);
    });
  });

  describe('listLiveV7Secrets', () => {
    it('reads the v7 apps among those the registry says are pinned, and their component secrets', async () => {
      const v7 = {
        name: 'SevenApp', owner: 'owner7', version: 7, spec: { getComponentSecrets: () => [{ componentName: 'web', secrets: 'pgp-blob' }] },
      };
      const v8 = {
        name: 'EightApp', owner: 'owner8', version: 8, spec: { getComponentSecrets: () => { throw new Error('never read'); } },
      };
      registryStub.pinned.resolves([v8, v7]);

      expect(await appsRepository.listLiveV7Secrets()).to.deep.equal([{
        appName: 'SevenApp', owner: 'owner7', componentName: 'web', secrets: 'pgp-blob',
      }]);
    });
  });

  // The row records the identifiers its containers are named by, so ownership is
  // a lookup rather than a decomposition of a container's own name.
});
