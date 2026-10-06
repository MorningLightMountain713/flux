'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const { asConfig } = require('./fixtures/config');
const {
  loadSpecLibrary, v8Spec, v9Spec, sealedV8Spec, sealedV9Spec, instantiatedSpec,
} = require('./fixtures/fluxSpec');
const { installedRecord } = require('./fixtures/appRecords');
const setReconciler = require('../../ZelBack/src/services/appMessaging/setReconciler');

// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. This is the repository layer, so what the tests hand it are real STORED
// forms: an InstantiatedSpec's serialization, cleartext or node-sealed. What stays
// stubbed is I/O — mongo through dbHelper, and the event-log collection handle the
// running-set derivation reads directly.
let flux;

describe('appsRepository', () => {
  let appsRepository;
  let registryStub;
  let installedStub;
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
  });

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
        daemonPONFork: 2_020_000,
        blocksLasting: 22_000,
        newMinBlocksAllowance: 100,
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
        globalAppsMessages: 'zelappsmessages',
        globalAppsTempMessages: 'zelappstemporarymessages',
        globalAppsIngressAttestations: 'appingressattestations',
        globalAppsIngressAttestationDigests: 'appingressattestationdigests',
        globalAppsInstallingErrorsLocations: 'appsinstallingerrorslocations',
        globalAppsInstallingErrorsBroadcasts: 'appsinstallingerrorsbroadcasts',
      },
      './appRecords': { registry: () => registryStub, installed: () => installedStub },
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

    it('returns null when findOne misses', async () => {
      dbHelperStub.findOneInDatabase.resolves(null);
      expect(await appsRepository.getAppMessage('unknown')).to.be.null;
    });

    it('dispatches to the registered version class and wraps in InstantiatedSpec', async () => {
      const doc = await legacyDoc(await v8Spec({ name: 'example' }), { hash: 'h', height: 100 });
      const deserialize = sinon.spy(flux.FluxAppSpecV8, 'deserialize');
      dbHelperStub.findOneInDatabase.resolves(messageWith(doc));

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
      dbHelperStub.findOneInDatabase.resolves(messageWith({ name: 'phantom', version: 99, hash: 'h', height: 100 }));
      const { spec } = await appsRepository.getAppMessage('h');
      expect(spec).to.be.null;
      expect(logStub.warn.calledOnce).to.be.true;
      expect(logStub.warn.firstCall.args[0]).to.include('version 99');
    });

    it('hydrates v9 documents through InstantiatedSpec.deserialize', async () => {
      const doc = await modernDoc(await v9Spec({ name: 'modern' }), { hash: 'h', height: 100 });
      dbHelperStub.findOneInDatabase.resolves(messageWith(doc));
      const { spec: result } = await appsRepository.getAppMessage('h');
      expect(result).to.not.be.null;
      expect(result.spec).to.be.instanceOf(flux.FluxAppSpecV9);
      expect(result.name).to.equal('modern');
      // v9 is time-based, so the row carries the confirming block's timestamp
      expect(result.registeredAt).to.equal(1_751_628_800);
    });

    it('hydrates a node-sealed v9 document and reports it encrypted', async () => {
      const doc = await modernDoc(await sealedV9Spec({ name: 'sealed9' }), { hash: 'hs9', height: 900 });
      dbHelperStub.findOneInDatabase.resolves(messageWith(doc));

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
      dbHelperStub.findOneInDatabase.resolves(messageWith(doc));

      const { spec: result } = await appsRepository.getAppMessage('hs8');
      expect(result.spec).to.be.instanceOf(flux.EncryptedSpecV8);
      expect(result.isEncrypted).to.be.true;
      // v8's blob carries no cleartext summary at all: "I cannot tell from here".
      expect(result.resourceTotals()).to.be.null;
    });

    it('takes the document id off before a sealed spec sees it', async () => {
      const stored = await modernDoc(await sealedV9Spec({ name: 'sealed9' }), { hash: 'hs9', height: 900 });
      expect(
        () => flux.InstantiatedSpec.deserialize({ ...stored, _id: 'mongo-id' }),
        'the real class must refuse _id, or this test proves nothing',
      ).to.throw(/unexpected fields on doc: _id/);

      dbHelperStub.findOneInDatabase.resolves({ ...messageWith(stored), _id: 'mongo-id' });
      const { spec: result } = await appsRepository.getAppMessage('hs9');
      expect(result).to.not.be.null;
      expect(result.spec).to.be.instanceOf(flux.EncryptedSpecV9);
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
      dbHelperStub.findInDatabase.resolves([{ contentManifest: { version: 3, ownedFrom: 100 } }, { contentManifest: { version: 2, ownedFrom: 0 } }]);

      const ranks = await appsRepository.carriedManifestRanks('bident');

      expect(ranks).to.deep.equal([{ version: 3, ownedFrom: 100 }, { version: 2, ownedFrom: 0 }]);
      const [, collection, query, options] = dbHelperStub.findInDatabase.firstCall.args;
      expect(collection).to.equal('zelappstemporarymessages');
      expect(query).to.deep.equal({ 'contentManifest.identity': 'bident' });
      expect(options.projection).to.deep.equal({ _id: 0, 'contentManifest.version': 1, 'contentManifest.ownedFrom': 1 });
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

  describe('content manifests', () => {
    const HASH = 'h'.repeat(64);
    const row = () => ({
      identity: 'bapp', hash: HASH, version: 2, ownedFrom: 100, signer: '1own', data: { d: 1 },
    });

    it('putContentManifest inserts one row per identity and hash, resolved, and clears any expiry', async () => {
      dbHelperStub.updateOneInDatabase.resolves({ upsertedCount: 1 });
      const out = await appsRepository.putContentManifest(row(), { now: 5000 });
      expect(out).to.deep.equal({ inserted: true });
      const [, collection, filter, update, opts] = dbHelperStub.updateOneInDatabase.firstCall.args;
      expect(collection).to.equal('zelappcontentmanifests');
      expect(filter).to.deep.equal({ identity: 'bapp', hash: HASH });
      expect(opts).to.deep.equal({ upsert: true });
      expect(update.$setOnInsert).to.deep.equal({
        identity: 'bapp', hash: HASH, version: 2, ownedFrom: 100, applied: false, data: { d: 1 },
      });
      expect(update.$set).to.deep.equal({ receivedAt: new Date(5000), signer: '1own' });
      expect(update.$unset).to.deep.equal({ expireAt: '' });
    });

    it('putContentManifest holds a row with no signer under its expiry, and touches only the receipt on a second arrival', async () => {
      dbHelperStub.updateOneInDatabase.resolves({ upsertedCount: 0 });
      const expireAt = new Date(9000);
      const out = await appsRepository.putContentManifest({ ...row(), signer: null, expireAt });
      expect(out).to.deep.equal({ inserted: false });
      const [, , , update] = dbHelperStub.updateOneInDatabase.firstCall.args;
      expect(update.$setOnInsert).to.include({ signer: null, expireAt });
      expect(update.$set).to.have.all.keys('receivedAt');
      expect(update.$unset).to.equal(undefined);
    });

    it('putContentManifest sets the verbatim data beside an envelope it brings, and keeps the stored data otherwise', async () => {
      const envelope = { version: 1, timestamp: 7, pubKey: 'pk', signature: 'sig' };
      await appsRepository.putContentManifest({ ...row(), envelope });
      const [, , , withEnvelope] = dbHelperStub.updateOneInDatabase.firstCall.args;
      expect(withEnvelope.$set).to.include({ envelope });
      expect(withEnvelope.$set.data).to.deep.equal({ d: 1 });
      expect(withEnvelope.$setOnInsert).to.not.have.property('data');
    });

    it('resolveContentManifest sets the signer and clears the expiry of one row', async () => {
      await appsRepository.resolveContentManifest('bapp', HASH, '1own');
      const [, , filter, update] = dbHelperStub.updateOneInDatabase.firstCall.args;
      expect(filter).to.deep.equal({ identity: 'bapp', hash: HASH });
      expect(update).to.deep.equal({ $set: { signer: '1own' }, $unset: { expireAt: '' } });
    });

    it('getContentManifests reads every row of an identity; getContentManifest one by its hash', async () => {
      dbHelperStub.findInDatabase.resolves([row()]);
      expect(await appsRepository.getContentManifests('bapp')).to.deep.equal([row()]);
      expect(dbHelperStub.findInDatabase.firstCall.args[2]).to.deep.equal({ identity: 'bapp' });
      dbHelperStub.findOneInDatabase.resolves(row());
      expect(await appsRepository.getContentManifest('bapp', HASH)).to.deep.equal(row());
      expect(dbHelperStub.findOneInDatabase.firstCall.args[2]).to.deep.equal({ identity: 'bapp', hash: HASH });
    });

    it('markContentManifestApplied marks one row and clears the mark on the identity\'s others, never inserting', async () => {
      dbHelperStub.updateInDatabase = sinon.stub().resolves({ modifiedCount: 1 });
      await appsRepository.markContentManifestApplied('bapp', HASH);
      const [, , clearFilter, clearUpdate] = dbHelperStub.updateInDatabase.firstCall.args;
      expect(clearFilter).to.deep.equal({ identity: 'bapp', hash: { $ne: HASH }, applied: true });
      expect(clearUpdate).to.deep.equal({ $set: { applied: false } });
      const [, , filter, update, opts] = dbHelperStub.updateOneInDatabase.firstCall.args;
      expect(filter).to.deep.equal({ identity: 'bapp', hash: HASH });
      expect(update).to.deep.equal({ $set: { applied: true } });
      expect(opts).to.equal(undefined);
    });

    it('deleteContentManifest removes one row; removeContentManifests every row of an identity; removeContentManifestsWithoutHash the hashless ones', async () => {
      dbHelperStub.removeDocumentsFromCollection.resolves({ deletedCount: 3 });
      await appsRepository.deleteContentManifest('bapp', HASH);
      expect(dbHelperStub.removeDocumentsFromCollection.firstCall.args[2]).to.deep.equal({ identity: 'bapp', hash: HASH });
      expect(await appsRepository.removeContentManifests('bapp')).to.equal(3);
      expect(dbHelperStub.removeDocumentsFromCollection.secondCall.args[2]).to.deep.equal({ identity: 'bapp' });
      expect(await appsRepository.removeContentManifestsWithoutHash()).to.equal(3);
      expect(dbHelperStub.removeDocumentsFromCollection.thirdCall.args[2]).to.deep.equal({ hash: { $exists: false } });
    });

    it('listResolvedContentManifests lists the resolved rows with whether each carries a broadcast to serve', async () => {
      dbHelperStub.findInDatabase.resolves([{ ...row(), envelope: { v: 1 } }, { ...row(), hash: 'x', version: 3 }]);
      const out = await appsRepository.listResolvedContentManifests();
      expect(out).to.deep.equal([
        { identity: 'bapp', hash: HASH, version: 2, ownedFrom: 100, signer: '1own', servable: true },
        { identity: 'bapp', hash: 'x', version: 3, ownedFrom: 100, signer: '1own', servable: false },
      ]);
      expect(dbHelperStub.findInDatabase.firstCall.args[2]).to.deep.equal({ signer: { $ne: null } });
    });

    it('listContentManifestRanks returns the rank of every row held, unresolved included', async () => {
      dbHelperStub.findInDatabase.resolves([{ identity: 'a', version: 2, ownedFrom: 0 }, { identity: 'q', version: 1, ownedFrom: 5 }]);
      const out = await appsRepository.listContentManifestRanks();
      expect(out).to.deep.equal([{ identity: 'a', version: 2, ownedFrom: 0 }, { identity: 'q', version: 1, ownedFrom: 5 }]);
      const [, , query, options] = dbHelperStub.findInDatabase.firstCall.args;
      expect(query).to.deep.equal({});
      expect(options.projection).to.deep.equal({ _id: 0, identity: 1, version: 1, ownedFrom: 1 });
    });

    it('listContentManifestBroadcasts rebuilds {...envelope, data} for every resolved, servable row of the identities asked', async () => {
      const env = { version: 1, timestamp: 7, pubKey: 'pk', signature: 'sig' };
      dbHelperStub.findInDatabase.resolves([{ envelope: env, data: { m: 1 } }]);
      const out = await appsRepository.listContentManifestBroadcasts(['a']);
      expect(out).to.deep.equal([{ ...env, data: { m: 1 } }]);
      const [, , query] = dbHelperStub.findInDatabase.firstCall.args;
      expect(query).to.deep.equal({ identity: { $in: ['a'] }, signer: { $ne: null }, envelope: { $exists: true } });
      expect(await appsRepository.listContentManifestBroadcasts([])).to.deep.equal([]);
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

    it('listResolvedContentManifestIdentities answers each identity with a resolved row once, with the app name its rows name', async () => {
      dbHelperStub.findInDatabase.resolves([
        { identity: 'bapp', data: { appName: 'myapp' } },
        { identity: 'bapp', data: { appName: 'myapp' } },
        { identity: 'bold', data: { appName: 'myapp' } },
        { identity: 'bnoname' },
      ]);
      const out = await appsRepository.listResolvedContentManifestIdentities();
      expect(out).to.deep.equal([{ identity: 'bapp', appName: 'myapp' }, { identity: 'bold', appName: 'myapp' }]);
      const [, collection, query, options] = dbHelperStub.findInDatabase.firstCall.args;
      expect(collection).to.equal('zelappcontentmanifests');
      expect(query).to.deep.equal({ signer: { $ne: null } });
      expect(options.projection).to.deep.equal({ _id: 0, identity: 1, 'data.appName': 1 });
    });
  });

  // The row records the identifiers its containers are named by, so ownership is
  // a lookup rather than a decomposition of a container's own name.
});
