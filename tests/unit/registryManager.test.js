'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const config = require('config');
const { ObjectId } = require('mongodb');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const registryManager = require('../../ZelBack/src/services/appDatabase/registryManager');
// eslint-disable-next-line no-unused-vars
const messageHelper = require('../../ZelBack/src/services/messageHelper');
const daemonServiceMiscRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceMiscRpcs');
const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');
const verificationHelper = require('../../ZelBack/src/services/verificationHelper');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const fluxCommunicationMessagesSender = require('../../ZelBack/src/services/fluxCommunicationMessagesSender');
const transportCryptoProvider = require('../../ZelBack/src/services/providers/FluxOSTransportProvider');
const legacyTransportProvider = require('../../ZelBack/src/services/providers/FluxOSLegacyTransportProvider');
const specCutover = require('../../ZelBack/src/services/utils/specCutover');
const foundingCommittee = require('../../ZelBack/src/services/appMesh/foundingCommittee');
const { RUNNING_EXPIRY_MS } = require('../../ZelBack/src/services/utils/appConstants');
const { requireMongo } = require('./dbTestHelper');
const {
  loadSpecLibrary, V8_SUBMISSION, V9_SUBMISSION,
  v8Spec, v9Spec, sealedV8Spec, sealedV9Spec, instantiatedSpec, assertAnswers,
} = require('./fixtures/fluxSpec');

// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. This module owns the registry and the app-spec view API, so what it is
// handed are real STORED forms (an InstantiatedSpec's serialization, cleartext or
// node-sealed) and what it hands back is produced by the real classes. What stays
// stubbed is I/O and FluxOS policy: the daemon sync RPC, the privilege check, and
// the two transport providers that talk to the benchmark channel.
let flux;

describe('registryManager tests', () => {
  before(requireMongo);

  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30000);
    flux = await loadSpecLibrary();
  });

  let db;
  let database;

  beforeEach(async () => {
    await dbHelper.initiateDB();
    db = dbHelper.databaseConnection();
    database = db.db(config.database.appsglobal.database);
  });

  afterEach(() => {
    sinon.restore();
  });

  /**
   * What `appsRepository.getGlobalAppInfo` hands the module: a real
   * InstantiatedSpec. Only the mongo read is stubbed.
   *
   * It is built through the STORED doc, so the object under test is what a node
   * would rebuild from its own row rather than one this file kept a reference to.
   * `registeredAt` is dropped for a legacy app because a v1-v8 row carries none.
   *
   * One form cannot make that trip: a v8 ENTERPRISE spec. v8's wire slot for the
   * ciphertext is a single opaque `enterprise` string, so `EncryptedSpecV8.
   * deserialize` rebuilds `{ algorithm, ciphertext }` and nothing else.
   * Production is fine — FluxOSLegacyCryptoProvider packs the wrapped key, nonce
   * and tag *inside* that string and unpacks them on the way back — but the spec
   * library's own test provider carries nonce and tag as separate fields, which
   * v8 has nowhere to put, so a fixture-sealed v8 would come back undecryptable.
   * It is therefore handed over unstored. v9 keeps its whole `encrypted` object
   * on the wire and round-trips intact.
   */
  async function registryHolds(spec, { hash = 'storedhash', height = 1700000 } = {}) {
    const instantiated = await instantiatedSpec(spec, { hash, height });
    let stored = instantiated;
    if (!(spec instanceof flux.EncryptedSpecV8)) {
      const doc = instantiated.serialize();
      if (spec.version < 9) delete doc.registeredAt;
      stored = flux.InstantiatedSpec.deserialize(doc);
    }
    sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(stored);
    return stored;
  }

  describe('getApplicationOwner tests', () => {
    beforeEach(async () => {
      const collection = config.database.appsglobal.collections.appsInformation;
      const insertApp = {
        _id: new ObjectId('6147045cd774409b374d253d'),
        name: 'TestApp',
        description: 'Test application',
        owner: '196GJWyLxzAw3MirTT7Bqs2iGpUQio29GH',
      };

      try {
        await database.collection(collection).drop();
      } catch (err) {
        // Collection doesn't exist
      }
      await dbHelper.insertOneToDatabase(database, collection, insertApp);
    });

    it('should return application owner if app exists in database', async () => {
      const appOwner = '196GJWyLxzAw3MirTT7Bqs2iGpUQio29GH';
      const getOwnerResult = await registryManager.getApplicationOwner('TestApp');

      expect(getOwnerResult).to.equal(appOwner);
    });

    it('should return null if the app does not exist', async () => {
      const getOwnerResult = await registryManager.getApplicationOwner('NonExistentApp');

      expect(getOwnerResult).to.be.null;
    });

    it('should be case insensitive', async () => {
      const appOwner = '196GJWyLxzAw3MirTT7Bqs2iGpUQio29GH';
      const getOwnerResult = await registryManager.getApplicationOwner('testapp');

      expect(getOwnerResult).to.equal(appOwner);
    });
  });

  describe('getAppHashes tests', () => {
    it('should return app hashes without requiring parameters', async () => {
      const res = {
        json: sinon.fake((param) => param),
      };

      const result = await registryManager.getAppHashes(undefined, res);

      sinon.assert.calledOnce(res.json);
      expect(result.status).to.equal('success');
      expect(result.data).to.be.an('array');
    });

    it('should handle errors gracefully', async () => {
      const res = {
        json: sinon.fake((param) => param),
      };

      sinon.stub(dbHelper, 'databaseConnection').throws(new Error('Database error'));

      const result = await registryManager.getAppHashes(undefined, res);

      expect(result.status).to.equal('error');
      expect(result.data.message).to.include('Database error');
    });
  });

  // appLocation reads the app state event log, not the materialized locations
  // collection - so these seed a node's running-announcement.
  describe('appLocation tests', () => {
    beforeEach(async () => {
      const collection = config.database.appsglobal.collections.appStateEvents;
      const broadcastedAt = Date.now();
      const announcement = {
        ip: '192.168.1.1:16127',
        type: 'apprunning',
        dedupKey: 'v2',
        broadcastedAt: new Date(broadcastedAt),
        expireAt: new Date(broadcastedAt + 125 * 60 * 1000),
        data: {
          ip: '192.168.1.1:16127',
          version: 2,
          apps: [{ name: 'TestApp', hash: 'testhash123' }],
          broadcastedAt,
          osUptime: 1000,
          staticIp: true,
        },
      };

      try {
        await database.collection(collection).drop();
      } catch (err) {
        // Collection doesn't exist
      }
      await dbHelper.insertOneToDatabase(database, collection, announcement);
    });

    it('should return app location for specific app', async () => {
      const result = await registryManager.appLocation('TestApp');

      expect(result).to.be.an('array');
      expect(result.length).to.be.greaterThan(0);
      expect(result[0].name).to.equal('TestApp');
      expect(result[0].ip).to.equal('192.168.1.1:16127');
    });

    it('should return all locations when no appname provided', async () => {
      const result = await registryManager.appLocation();

      expect(result).to.be.an('array');
    });

    it('should be case insensitive', async () => {
      const result = await registryManager.appLocation('testapp');

      expect(result).to.be.an('array');
      expect(result.length).to.be.greaterThan(0);
    });
  });

  describe('appInstallingLocation tests', () => {
    beforeEach(async () => {
      const collection = config.database.appsglobal.collections.appsInstallingLocations;
      const testLocation = {
        name: 'InstallingApp',
        ip: '192.168.1.2:16127',
        broadcastedAt: new Date(),
        expireAt: new Date(Date.now() + 300000),
      };

      try {
        await database.collection(collection).drop();
      } catch (err) {
        // Collection doesn't exist
      }
      await dbHelper.insertOneToDatabase(database, collection, testLocation);
    });

    it('should return installing location for specific app', async () => {
      const result = await registryManager.appInstallingLocation('InstallingApp');

      expect(result).to.be.an('array');
      expect(result.length).to.be.greaterThan(0);
      expect(result[0].name).to.equal('InstallingApp');
    });

    it('should return all installing locations when no appname provided', async () => {
      const result = await registryManager.appInstallingLocation();

      expect(result).to.be.an('array');
    });

    it('carries announcedAt and replica through the read (the election key and seat identity)', async () => {
      const collection = config.database.appsglobal.collections.appsInstallingLocations;
      const announcedAt = new Date(Date.now() - 60 * 1000);
      await dbHelper.insertOneToDatabase(database, collection, {
        name: 'ClaimedApp',
        ip: '192.168.1.3:16127',
        replica: 's1',
        announcedAt,
        broadcastedAt: new Date(),
        expireAt: new Date(Date.now() + 300000),
      });

      const result = await registryManager.appInstallingLocation('ClaimedApp');

      // Elections rank on announcedAt ?? broadcastedAt; broadcastedAt moves on
      // renewals, so stripping announcedAt here would shift a renewing node's
      // election position.
      expect(result[0].announcedAt).to.deep.equal(announcedAt);
      expect(result[0].replica).to.equal('s1');
    });
  });

  describe('installingCountsByApp tests', () => {
    beforeEach(async () => {
      const collection = config.database.appsglobal.collections.appsInstallingLocations;
      try {
        await database.collection(collection).drop();
      } catch (err) {
        // Collection doesn't exist
      }
    });

    it('groups live claims by lowercased app name', async () => {
      const collection = config.database.appsglobal.collections.appsInstallingLocations;
      const row = (name, ip) => ({
        name, ip, broadcastedAt: new Date(), expireAt: new Date(Date.now() + 300000),
      });
      await dbHelper.insertOneToDatabase(database, collection, row('ClaimedApp', '192.168.1.2:16127'));
      await dbHelper.insertOneToDatabase(database, collection, row('claimedapp', '192.168.1.3:16127'));
      await dbHelper.insertOneToDatabase(database, collection, row('OtherApp', '192.168.1.4:16127'));

      const counts = await registryManager.installingCountsByApp();

      expect(counts.get('claimedapp')).to.equal(2);
      expect(counts.get('otherapp')).to.equal(1);
    });

    it('returns an empty map when nothing is installing', async () => {
      const counts = await registryManager.installingCountsByApp();

      expect(counts.size).to.equal(0);
    });
  });

  describe('storeAppInstallingMessage tests', () => {
    const validMessage = {
      type: 'fluxappinstalling',
      version: 1,
      broadcastedAt: Date.now(),
      name: 'TestApp',
      ip: '192.168.1.1:16127',
    };

    it('should store a valid app installing message', async () => {
      const result = await registryManager.storeAppInstallingMessage(validMessage);

      expect(result).to.be.true;
    });

    it('should reject invalid message without required fields', async () => {
      const invalidMessage = {
        type: 'fluxappinstalling',
        version: 1,
      };

      try {
        await registryManager.storeAppInstallingMessage(invalidMessage);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('Invalid Flux App Installing message');
      }
    });

    it('should reject message with wrong type', async () => {
      const wrongTypeMessage = {
        ...validMessage,
        type: 123,
      };

      try {
        await registryManager.storeAppInstallingMessage(wrongTypeMessage);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('Invalid Flux App Installing message');
      }
    });

    it('should reject message with unsupported version', async () => {
      const wrongVersionMessage = {
        ...validMessage,
        version: 3,
      };

      try {
        await registryManager.storeAppInstallingMessage(wrongVersionMessage);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('version 3 not supported');
      }
    });

    it('should reject version 2 message without announcedAt', async () => {
      const missingAnnouncedAt = {
        ...validMessage,
        version: 2,
      };

      try {
        await registryManager.storeAppInstallingMessage(missingAnnouncedAt);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('announcedAt required for version 2');
      }
    });

    it('should store a version 2 message with announcedAt on the row', async () => {
      const announcedAt = Date.now() - 60 * 1000;
      const v2Message = {
        ...validMessage,
        version: 2,
        name: 'TestAppV2',
        announcedAt,
        broadcastedAt: Date.now(),
      };

      const result = await registryManager.storeAppInstallingMessage(v2Message);

      expect(result).to.be.true;
      const collection = config.database.appsglobal.collections.appsInstallingLocations;
      const row = await database.collection(collection).findOne({ name: 'TestAppV2' });
      expect(row.announcedAt).to.deep.equal(new Date(announcedAt));
      expect(row.expireAt).to.deep.equal(new Date(v2Message.broadcastedAt + 15 * 60 * 1000));
    });

    it('should reject old messages past valid time', async () => {
      const oldMessage = {
        ...validMessage,
        broadcastedAt: Date.now() - (20 * 60 * 1000), // past the 15-minute row lifetime
      };

      const result = await registryManager.storeAppInstallingMessage(oldMessage);

      expect(result).to.be.false;
    });

    it('should not store duplicate message', async () => {
      await registryManager.storeAppInstallingMessage(validMessage);
      const result = await registryManager.storeAppInstallingMessage(validMessage);

      expect(result).to.be.false;
    });

    it('keys one claim row per replica: co-located claims coexist under one (name, ip)', async () => {
      const broadcastedAt = Date.now();
      const base = {
        type: 'fluxappinstalling',
        version: 2,
        name: 'ColocatedApp',
        ip: '192.168.1.1:16127',
        announcedAt: broadcastedAt,
        broadcastedAt,
      };

      await registryManager.storeAppInstallingMessage({ ...base, replica: 's1' });
      const result = await registryManager.storeAppInstallingMessage({ ...base, replica: 's2' });

      expect(result).to.be.true;
      const collection = config.database.appsglobal.collections.appsInstallingLocations;
      const rows = await database.collection(collection).find({ name: 'ColocatedApp' }).toArray();
      expect(rows).to.have.length(2);
      expect(rows.map((r) => r.replica).sort()).to.deep.equal(['s1', 's2']);
    });

    it('rejects a non-string replica (local-writer strictness catches emission bugs)', async () => {
      const badReplica = {
        ...validMessage,
        version: 2,
        name: 'BadReplicaApp',
        announcedAt: Date.now(),
        broadcastedAt: Date.now(),
        replica: 123,
      };

      try {
        await registryManager.storeAppInstallingMessage(badReplica);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('replica must be a string');
      }
    });
  });

  describe('removeAppInstallingMessage tests', () => {
    it('retracts exactly the named identity; siblings and the loose row survive', async () => {
      const broadcastedAt = Date.now();
      const base = {
        type: 'fluxappinstalling',
        version: 2,
        name: 'RetractApp',
        ip: '192.168.1.1:16127',
        announcedAt: broadcastedAt,
        broadcastedAt,
      };
      await registryManager.storeAppInstallingMessage({ ...base, replica: 's1' });
      await registryManager.storeAppInstallingMessage({ ...base, replica: 's2' });

      await registryManager.removeAppInstallingMessage('RetractApp', '192.168.1.1:16127', 's1');

      const collection = config.database.appsglobal.collections.appsInstallingLocations;
      const rows = await database.collection(collection).find({ name: 'RetractApp' }).toArray();
      expect(rows.map((r) => r.replica)).to.deep.equal(['s2']);
    });

    it('prepareInstallingClaimsCollections: archived announces are unique per identity, not per (name, ip)', async () => {
      const collection = config.database.appsglobal.collections.appsInstallingBroadcasts;
      try {
        await database.collection(collection).drop();
      } catch (err) {
        // collection doesn't exist
      }
      await registryManager.prepareInstallingClaimsCollections();

      const doc = (replica) => ({
        data: {
          name: 'ColoApp', ip: '192.168.1.1:16127', replica, broadcastedAt: Date.now(),
        },
        broadcastedAt: new Date(),
        expireAt: new Date(Date.now() + 300000),
      });
      await database.collection(collection).insertOne(doc('s1'));
      // The co-located sibling's announce must coexist under the same (name, ip).
      await database.collection(collection).insertOne(doc('s2'));

      let duplicateError = null;
      await database.collection(collection).insertOne(doc('s1')).catch((err) => { duplicateError = err; });
      expect(duplicateError, 'same identity must still be unique').to.exist;
      expect(duplicateError.code).to.equal(11000);
    });

    it('a null retract matches a legacy row stored without the replica field', async () => {
      const collection = config.database.appsglobal.collections.appsInstallingLocations;
      await dbHelper.insertOneToDatabase(database, collection, {
        name: 'LegacyRowApp',
        ip: '192.168.1.1:16127',
        broadcastedAt: new Date(),
        expireAt: new Date(Date.now() + 300000),
      });

      await registryManager.removeAppInstallingMessage('LegacyRowApp', '192.168.1.1:16127');

      const rows = await database.collection(collection).find({ name: 'LegacyRowApp' }).toArray();
      expect(rows).to.have.length(0);
    });
  });

  describe('getApplicationSpecificationAPI tests', () => {
    beforeEach(() => {
      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: {
          synced: true,
          height: 1000,
        },
      });
    });

    it('should return error if no app name provided', async () => {
      const req = { params: {}, query: {} };
      const res = {
        json: sinon.fake((param) => param),
      };

      await registryManager.getApplicationSpecificationAPI(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('error');
      expect(result.data.message).to.include('No Application Name specified');
    });

    it('should return error if daemon not synced', async () => {
      daemonServiceMiscRpcs.isDaemonSynced.returns({
        data: {
          synced: false,
          height: 0,
        },
      });

      const req = { params: { appname: 'TestApp' }, query: {} };
      const res = {
        json: sinon.fake((param) => param),
      };

      await registryManager.getApplicationSpecificationAPI(req, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('error');
      expect(result.data.message).to.include('Daemon not yet synced');
    });

    // The doubles these replaced carried `version` and `isEncrypted` as writable
    // literals, so a "v8 test" and a "v9 test" differed by an assignment rather
    // than by the class that actually arrives. A real InstantiatedSpec derives
    // both from the spec it wraps, so the branch under test is now chosen by the
    // object — an EncryptedSpecV9 or an EncryptedSpecV8 — and cannot be faked
    // into the wrong one. The old double also could not answer `serialize()`
    // with anything but `{ sparse: true }`, which is not a shape any stored spec
    // has ever had.
    describe('encrypted spec view channel negotiation', () => {
      let decryptV9;
      let decryptV8;
      let reencrypt;

      const buildReq = (headers) => ({
        params: { appname: 'myapp', decrypt: 'true' },
        query: {},
        headers,
      });

      beforeEach(() => {
        sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
        // The instances are Object.freeze'd, so the call counters go on the
        // prototypes; sinon.restore() in the outer afterEach puts them back.
        decryptV9 = sinon.spy(flux.EncryptedSpecV9.prototype, 'decrypt');
        decryptV8 = sinon.spy(flux.EncryptedSpecV8.prototype, 'decrypt');
        reencrypt = sinon.spy(flux.DecryptedCanonicalSpec.prototype, 'reencrypt');
      });

      it('should require a view credential when decrypt is requested', async () => {
        await registryHolds(await sealedV9Spec());
        const res = { json: sinon.fake((param) => param) };

        await registryManager.getApplicationSpecificationAPI(buildReq({}), res);

        const result = res.json.firstCall.args[0];
        expect(result.status).to.equal('error');
        expect(result.data.message).to.include('flux-transport-pubkey or enterprise-key');
        sinon.assert.notCalled(decryptV9);
      });

      it('should seal a v9 encrypted spec toward the caller over the transport layer', async () => {
        await registryHolds(await sealedV9Spec());
        const fakeEnvelope = { toJSON: () => ({ algorithm: 'HPKE', encapsulatedKey: 'enc', ciphertext: 'ct' }) };
        const seal = sinon.fake.resolves(fakeEnvelope);
        const create = sinon.stub(transportCryptoProvider, 'create').resolves({ seal });
        const pubkey = Buffer.alloc(32, 7).toString('base64');
        const res = { json: sinon.fake((param) => param) };

        await registryManager.getApplicationSpecificationAPI(buildReq({ 'flux-transport-pubkey': pubkey }), res);

        const result = res.json.firstCall.args[0];
        expect(result.status).to.equal('success');
        expect(result.data.encrypted).to.equal(true);
        expect(result.data.appName).to.equal('myapp');
        expect(result.data).to.have.property('timestamp');
        expect(result.data.transportEncrypted).to.deep.equal({ algorithm: 'HPKE', encapsulatedKey: 'enc', ciphertext: 'ct' });
        // the storage decrypt ran, and the transport seal — not the storage
        // reencrypt — produced the view payload
        sinon.assert.calledOnce(decryptV9);
        sinon.assert.notCalled(reencrypt);

        // The transport provider is stubbed and never sees the spec object: it is
        // asked to seal FOR an app, and both arguments are read off the INNER
        // cleartext spec the wrapper hands out (`decrypted.spec`), not off the
        // wrapper itself. Assert they are the real app's, so a lost delegation
        // seals toward `undefined` here instead of on a node.
        sinon.assert.calledOnceWithExactly(create, 'myapp', V9_SUBMISSION.owner);

        const sealArg = seal.firstCall.args[0];
        expect(sealArg.peerPublicKey).to.deep.equal(Buffer.from(pubkey, 'base64'));
        expect(sealArg.info).to.be.a('string').that.is.not.empty;
        expect(sealArg.aad).to.exist;
        // And what it was handed is the real canonical cleartext the owner needs
        // in order to re-sign — the decrypt actually opened the blob, rather than
        // a literal standing in for it.
        const canonical = JSON.parse(sealArg.plaintext.toString('utf8'));
        expect(canonical.version).to.equal(9);
        expect(canonical.components.web.image).to.equal('nginx:latest');
        expect(canonical.owner).to.equal(V9_SUBMISSION.owner);
      });

      it('should reencrypt a v8 encrypted spec over the legacy enterprise channel', async () => {
        const sealed = await sealedV8Spec();
        await registryHolds(sealed);
        // The legacy transport provider wraps an AES key under the caller's RSA
        // key off the benchmark channel, so it stays stubbed — but it must hand
        // back a real CryptoProvider, because EncryptedSpecV8.reencryptFrom
        // refuses anything else. The library's own registered test factory is it.
        const provider = await flux.EncryptedSpecV8.createProviderFor(sealed.name, sealed.owner);
        const legacyCreate = sinon.stub(legacyTransportProvider, 'create').resolves(provider);
        const res = { json: sinon.fake((param) => param) };

        await registryManager.getApplicationSpecificationAPI(buildReq({ 'enterprise-key': 'wrappedKeyBase64' }), res);

        const result = res.json.firstCall.args[0];
        expect(result.status).to.equal('success');
        // Same property guard as the v9 channel: the stubbed provider is told
        // which app and owner to wrap for, off the InstantiatedSpec's accessors.
        sinon.assert.calledOnceWithExactly(legacyCreate, 'myapp', V8_SUBMISSION.owner, 'wrappedKeyBase64');
        sinon.assert.calledOnce(decryptV8);
        sinon.assert.calledOnce(reencrypt);
        // v8's own enterprise wire form came back, not a passthrough of the
        // stored row and not a literal: ciphertext present, cleartext absent.
        expect(result.data.version).to.equal(8);
        expect(flux.EncryptedSpecV8.matchesWire(result.data)).to.be.true;
        expect(result.data.enterprise).to.be.a('string').and.not.equal('');
        expect(result.data.compose, 'cleartext components never reach the caller').to.deep.equal([]);
        expect(result.data.contacts).to.deep.equal([]);
        expect(await reencrypt.firstCall.returnValue).to.be.instanceOf(flux.EncryptedSpecV8);
      });

      it('should reject a v9 app that arrives on the legacy enterprise channel', async () => {
        await registryHolds(await sealedV9Spec());
        const res = { json: sinon.fake((param) => param) };

        await registryManager.getApplicationSpecificationAPI(buildReq({ 'enterprise-key': 'wrappedKeyBase64' }), res);

        const result = res.json.firstCall.args[0];
        expect(result.status).to.equal('error');
        expect(result.data.message).to.include('flux-transport-pubkey channel');
        // rejected before any crypto work
        sinon.assert.notCalled(decryptV9);
      });

      it('should return the sparse stored spec when no decrypt is requested', async () => {
        const sealed = await sealedV9Spec();
        await registryHolds(sealed);
        const req = { params: { appname: 'myapp' }, query: {}, headers: {} };
        const res = { json: sinon.fake((param) => param) };

        await registryManager.getApplicationSpecificationAPI(req, res);

        const result = res.json.firstCall.args[0];
        expect(result.status).to.equal('success');
        expect(result.data).to.deep.equal(sealed.serialize());
        // "sparse" is a real shape, not a marker: cleartext metadata plus the
        // resource summary a node screens on, and the ciphertext — never the
        // components.
        expect(result.data.encrypted.ciphertext).to.be.a('string').and.not.equal('');
        expect(result.data.resources).to.include({ cpu: 0.5, memoryMb: 300 });
        expect(result.data).to.not.have.property('components');
        sinon.assert.notCalled(decryptV9);
      });

      // The double hardcoded isEncrypted:true, so the branch that returns a
      // cleartext app's stored spec untouched — credential or no credential —
      // was unreachable and untested.
      it('returns a cleartext app untouched even when a view credential is presented', async () => {
        const cleartext = await v9Spec();
        await registryHolds(cleartext);
        const create = sinon.stub(transportCryptoProvider, 'create');
        const res = { json: sinon.fake((param) => param) };

        await registryManager.getApplicationSpecificationAPI(
          buildReq({ 'flux-transport-pubkey': Buffer.alloc(32, 7).toString('base64') }), res,
        );

        const result = res.json.firstCall.args[0];
        expect(result.status).to.equal('success');
        expect(result.data).to.deep.equal(cleartext.serialize());
        expect(result.data.components.web.image).to.equal('nginx:latest');
        sinon.assert.notCalled(create); // nothing to protect, so nothing sealed
      });
    });
  });

  // The v8->v9 conversion endpoint had no tests at all. It is the other half of
  // this module's spec-view surface: it decrypts an enterprise spec node-side,
  // runs the real fromLegacy, and seals the draft back toward the owner — so the
  // sealed shape and the decrypted shape both matter, and neither is expressible
  // with a literal.
  describe('convertApplicationSpecification (appconvert)', () => {
    let decryptV8;

    beforeEach(() => {
      decryptV8 = sinon.spy(flux.EncryptedSpecV8.prototype, 'decrypt');
    });

    it('converts a cleartext legacy app into a signable v9 draft', async () => {
      await registryHolds(await v8Spec({ name: 'convertme', contacts: ['ops@example.com'] }));

      const result = await registryManager.convertApplicationSpecification('convertme');

      expect(result.encrypted).to.be.false;
      expect(result.complete, 'a v8 app with contacts converts cleanly').to.be.true;
      expect(result.errors).to.deep.equal([]);
      // The draft is the real class's canonical form, so it carries the v9-only
      // sections a legacy row has never had.
      expect(result.spec.version).to.equal(9);
      expect(result.spec.name).to.equal('convertme');
      expect(result.spec.owner).to.equal(V8_SUBMISSION.owner);
      expect(result.spec.components.web.image).to.equal('nginx:latest');
      expect(result.spec).to.have.all.keys(
        'version', 'name', 'description', 'owner', 'instances', 'ttl', 'network',
        'placement', 'assignment', 'components', 'contacts', 'marketplace',
        'telemetry', 'referral', 'activation', 'dependencies',
      );
      // Warnings are the owner's review list, not errors.
      expect(result.warnings.join(' ')).to.include('TCP only');
    });

    it('returns a fillable draft when the legacy app is missing a v9-required field', async () => {
      // The shared v8 fixture carries no contacts, which v9 requires — the exact
      // "fixable gap" the endpoint is documented to return rather than reject.
      await registryHolds(await v8Spec({ name: 'convertme' }));

      const result = await registryManager.convertApplicationSpecification('convertme');

      expect(result.complete).to.be.false;
      expect(result.errors.map((e) => e.field)).to.deep.equal(['contacts']);
      // Incomplete means the raw converted blob, not a validated canonical form.
      expect(result.spec.components.web.image).to.equal('nginx:latest');
      expect(result.spec).to.not.have.property('contacts');
    });

    it('refuses an app already on spec version 9', async () => {
      await registryHolds(await v9Spec());

      let err;
      try { await registryManager.convertApplicationSpecification('myapp'); } catch (e) { err = e; }

      expect(err, 'should have thrown').to.exist;
      expect(err.message).to.include('already on spec version 9');
    });

    it('decrypts an enterprise app node-side and seals the draft toward the caller', async () => {
      const sealed = await sealedV8Spec({ name: 'convertme', contacts: ['ops@example.com'] });
      await registryHolds(sealed);
      const fakeEnvelope = { toJSON: () => ({ algorithm: 'HPKE', encapsulatedKey: 'enc', ciphertext: 'ct' }) };
      const seal = sinon.fake.resolves(fakeEnvelope);
      const create = sinon.stub(transportCryptoProvider, 'create').resolves({ seal });
      const pubkey = Buffer.alloc(32, 3).toString('base64');

      const result = await registryManager.convertApplicationSpecification('convertme', {
        recipientPubkeyBase64: pubkey,
      });

      expect(result.encrypted).to.be.true;
      expect(result.complete).to.be.true;
      expect(result.appName).to.equal('convertme');
      expect(result.transportEncrypted).to.deep.equal({ algorithm: 'HPKE', encapsulatedKey: 'enc', ciphertext: 'ct' });
      expect(result).to.not.have.property('spec'); // cleartext never crosses the wire
      sinon.assert.calledOnce(decryptV8);
      // The stubbed transport provider is told which app and owner to seal for,
      // and both come out of the converted blob — which fromLegacy built from the
      // DECRYPTED spec. Sealing toward `undefined` would pass without this.
      sinon.assert.calledOnceWithExactly(create, 'convertme', V8_SUBMISSION.owner);
      const sealArg = seal.firstCall.args[0];
      expect(sealArg.peerPublicKey).to.deep.equal(Buffer.from(pubkey, 'base64'));
      expect(sealArg.aad).to.exist;
      const draft = JSON.parse(sealArg.plaintext.toString('utf8'));
      expect(draft.version).to.equal(9);
      expect(draft.components.web.image, 'the sealed blob really was opened').to.equal('nginx:latest');
    });

    it('refuses to convert an encrypted app with no transport pubkey to seal toward', async () => {
      await registryHolds(await sealedV8Spec({ name: 'convertme', contacts: ['ops@example.com'] }));

      let err;
      try { await registryManager.convertApplicationSpecification('convertme'); } catch (e) { err = e; }

      expect(err, 'should have thrown').to.exist;
      expect(err.message).to.include('flux-transport-pubkey is mandatory');
      // it got far enough to decrypt: the refusal is about the return channel,
      // not about reading the app
      sinon.assert.calledOnce(decryptV8);
    });

    // A CLEARTEXT source can still produce a secret draft: v9 has no storage-ref
    // convention, so an F_S_ENV reference is fetched and inlined, and the values
    // were externalised precisely because they are sensitive.
    it('seals the draft when a storage reference is inlined, even from a cleartext app', async () => {
      await registryHolds(await v8Spec({
        name: 'convertme',
        contacts: ['ops@example.com'],
        compose: [{
          ...V8_SUBMISSION.compose[0],
          environmentParameters: ['F_S_ENV=https://storage.example.com/env.json'],
        }],
      }));
      // Flux Storage is a signed HTTP fetch — I/O, so stubbed at the http seam.
      sinon.stub(serviceHelper, 'axiosGet').resolves({ data: ['SECRET=hunter2'] });
      sinon.stub(fluxCommunicationMessagesSender, 'getFluxMessageSignature').resolves('sig');
      const seal = sinon.fake.resolves({ toJSON: () => ({ algorithm: 'HPKE' }) });
      sinon.stub(transportCryptoProvider, 'create').resolves({ seal });

      const result = await registryManager.convertApplicationSpecification('convertme', {
        recipientPubkeyBase64: Buffer.alloc(32, 5).toString('base64'),
      });

      expect(result.encrypted, 'an inlined secret forces the sealed channel').to.be.true;
      const draft = JSON.parse(seal.firstCall.args[0].plaintext.toString('utf8'));
      expect(draft.components.web.env).to.deep.equal({ SECRET: 'hunter2' });
      expect(draft.components.web.env).to.not.have.property('F_S_ENV');
    });

    it('appConvertApi refuses an unprivileged caller before reading the app', async () => {
      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({ data: { synced: true, height: 1000 } });
      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(false);
      const getInfo = sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(null);
      const res = { json: sinon.fake((param) => param) };

      await registryManager.appConvertApi({ params: { appname: 'convertme' }, query: {}, headers: {} }, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('error');
      expect(result.data.code).to.equal(401);
      sinon.assert.notCalled(getInfo);
    });
  });

  // The row seeded here is a real STORED spec, not a hand-assembled document:
  // this check reads the live registry entry back through hydrate, and the hash
  // branch below then asks that entry two questions (`expiresAtHeight` and
  // `serialize`) that only the real InstantiatedSpec can answer.
  describe('checkApplicationRegistrationNameConflicts tests', () => {
    const EXISTING_HEIGHT = 1700000;
    // v8's `expire` of 88000 blocks from EXISTING_HEIGHT, as the real class
    // computes it across the PON fork — read off the object, never assumed.
    let existingExpiresAt;

    beforeEach(async () => {
      const collection = config.database.appsglobal.collections.appsInformation;
      const stored = await instantiatedSpec(
        await v8Spec({ name: 'existingapp' }),
        { hash: 'testhash123', height: EXISTING_HEIGHT },
      );
      existingExpiresAt = stored.expiresAtHeight;
      const doc = stored.serialize();
      delete doc.registeredAt; // a v1-v8 row carries none

      try {
        await database.collection(collection).drop();
      } catch (err) {
        // Collection doesn't exist
      }
      await dbHelper.insertOneToDatabase(database, collection, doc);
    });

    it('should throw error if app name already exists', async () => {
      const appSpec = await v8Spec({ name: 'existingapp' });

      try {
        await registryManager.checkApplicationRegistrationNameConflicts(appSpec);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('already registered');
      }
    });

    it('should allow registration if app name is unique', async () => {
      const appSpec = await v9Spec({ name: 'uniqueappname' });

      const result = await registryManager.checkApplicationRegistrationNameConflicts(appSpec);

      expect(result).to.be.true;
    });

    it('should reject app named "share"', async () => {
      const appSpec = await v9Spec({ name: 'share' });

      try {
        await registryManager.checkApplicationRegistrationNameConflicts(appSpec);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('already assigned to Flux main application');
      }
    });

    // The hash branch decides whether an incoming registration is allowed to
    // take a name the registry already holds, and it decides it by asking the
    // STORED entry when its lease runs out. Nothing exercised it before.
    describe('re-registration by hash', () => {
      const hashesCollection = config.database.daemon.collections.appsHashes;

      beforeEach(async () => {
        try {
          await db.db(config.database.daemon.database).collection(hashesCollection).drop();
        } catch (err) {
          // Collection doesn't exist
        }
      });

      it('refuses a hash the chain never carried', async () => {
        const appSpec = await v8Spec({ name: 'existingapp' });

        try {
          await registryManager.checkApplicationRegistrationNameConflicts(appSpec, 'unknownhash');
          expect.fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.include('Hash not found in collection');
        }
      });

      it('refuses a hash confirmed while the held name is still leased', async () => {
        // Confirmed after the stored spec but before its lease runs out, so the
        // name is not free. `expiresAtHeight` is the question being asked, and a
        // hand-written double cannot answer it — the previous literal here had
        // no such accessor at all.
        const confirmedAt = EXISTING_HEIGHT + 1000;
        expect(confirmedAt, 'the incoming hash must land inside the lease').to.be.below(existingExpiresAt);
        await dbHelper.insertOneToDatabase(
          db.db(config.database.daemon.database), hashesCollection,
          { hash: 'incominghash', height: confirmedAt, txid: 'tx1' },
        );
        const appSpec = await v8Spec({ name: 'existingapp' });

        try {
          await registryManager.checkApplicationRegistrationNameConflicts(appSpec, 'incominghash');
          expect.fail('Should have thrown an error');
        } catch (error) {
          expect(error.message).to.include('Hash is not older than our current app');
        }
      });
    });
  });

  // These write and read the real globalAppsInformation rows, so the docs are
  // real stored forms: what a confirmed spec actually leaves in mongo, produced
  // by InstantiatedSpec.serialize rather than assembled by hand.
  describe('updateAppSpecifications tests', () => {
    // These assert on what a FIRST registration leaves behind, so the collection
    // has to start empty: mongo outlives the run, and a row left at the higher
    // height by the previous one makes both writes no-ops.
    beforeEach(async () => {
      try {
        await database.collection(config.database.appsglobal.collections.appsInformation).drop();
      } catch (err) {
        // Collection doesn't exist
      }
    });

    /** The stored document for an app at a given chain position. */
    async function storedDoc(spec, { hash, height }) {
      const doc = (await instantiatedSpec(spec, { hash, height })).serialize();
      if (spec.version < 9) delete doc.registeredAt;
      return doc;
    }

    /** The stored row, without mongo's own key. */
    async function readBack(name) {
      const row = await dbHelper.findOneInDatabase(
        database, config.database.appsglobal.collections.appsInformation, { name },
      );
      if (!row) return row;
      // eslint-disable-next-line no-unused-vars
      const { _id, ...doc } = row;
      return doc;
    }

    it('should update app specifications', async () => {
      const spec = await v9Spec({ name: 'updatetestapp' });
      await registryManager.insertAppSpecifications(await storedDoc(spec, { hash: 'oldhash', height: 100 }));

      await registryManager.updateAppSpecifications(await storedDoc(spec, { hash: 'newhash', height: 200 }));

      const result = await readBack('updatetestapp');
      expect(result.name).to.equal('updatetestapp');
      expect(result.height).to.equal(200);
      expect(result.hash).to.equal('newhash');
      // and the row is still one the real deserializer will accept on next boot
      expect(flux.InstantiatedSpec.deserialize(result).height).to.equal(200);
    });

    it('should not update if height is lower than existing', async () => {
      const spec = await v9Spec({ name: 'heighttestapp' });
      await registryManager.insertAppSpecifications(await storedDoc(spec, { hash: 'hash1', height: 300 }));

      await registryManager.updateAppSpecifications(await storedDoc(spec, { hash: 'hash2', height: 200 }));

      const result = await readBack('heighttestapp');
      expect(result.height).to.equal(300);
      expect(result.hash).to.equal('hash1');
    });

    it('should not accumulate ghost fields when spec version changes', async () => {
      // A real version change, v8 -> v9: the two shapes share almost no field
      // names, so every v8-only key is a candidate ghost. The literals this
      // replaced invented a v3 and a v4 blob; the real classes make the same
      // point with the transition the network is actually about to make.
      const legacy = await v8Spec({ name: 'ghostfieldapp' });
      await registryManager.insertAppSpecifications(await storedDoc(legacy, { hash: 'hash1', height: 100 }));
      const seeded = await readBack('ghostfieldapp');
      expect(seeded.compose, 'the legacy row really did carry the v8 shape').to.be.an('array');

      const modern = await v9Spec({ name: 'ghostfieldapp' });
      await registryManager.updateAppSpecifications(await storedDoc(modern, { hash: 'hash2', height: 200 }));

      const result = await readBack('ghostfieldapp');
      expect(result.version).to.equal(9);
      expect(result.components).to.exist;
      // Ghost v8 fields must NOT survive the replace — a v9 row carrying `compose`
      // or `expire` would be rejected outright by the v9 deserializer.
      for (const ghost of ['compose', 'expire', 'geolocation', 'nodes', 'staticip']) {
        expect(result[ghost], `${ghost} is a v8-only field and must not survive`).to.be.undefined;
      }
      expect(() => flux.InstantiatedSpec.deserialize(result)).to.not.throw();
    });
  });

  describe('registrationInformation tests', () => {
    it('should return registration information from config', () => {
      const res = {
        json: sinon.fake((param) => param),
      };

      registryManager.registrationInformation(undefined, res);

      const result = res.json.firstCall.args[0];
      expect(result.status).to.equal('success');
      expect(result.data).to.exist;
    });
  });

  describe('getRunningApps tests', () => {
    it('should return running apps from global locations', async () => {
      const result = await registryManager.getRunningApps();

      expect(result).to.be.an('array');
    });
  });

  // Port conflicts are a property of the machine, so this selects every node at an
  // address regardless of apiport - and must not spill onto a neighbouring address.
  describe('reindexGlobalAppsLocationAPI (deprecated no-op)', () => {
    afterEach(() => sinon.restore());

    it('reports success without touching any collection', async () => {
      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      const dropSpy = sinon.spy(dbHelper, 'dropCollection');
      const res = { json: sinon.stub() };

      await registryManager.reindexGlobalAppsLocationAPI({}, res);

      expect(res.json.firstCall.args[0].status).to.equal('success');
      expect(dropSpy.called).to.equal(false);
    });

    it('still refuses an unprivileged caller', async () => {
      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(false);
      const res = { json: sinon.stub() };

      await registryManager.reindexGlobalAppsLocationAPI({}, res);

      expect(res.json.firstCall.args[0].status).to.equal('error');
    });
  });

  describe('getRunningAppIpList tests', () => {
    const announcement = (ip, apps) => {
      const broadcastedAt = Date.now();
      return {
        ip,
        type: 'apprunning',
        dedupKey: 'v2',
        broadcastedAt: new Date(broadcastedAt),
        expireAt: new Date(broadcastedAt + 125 * 60 * 1000),
        data: {
          ip, version: 2, apps, broadcastedAt, osUptime: 1000, staticIp: true,
        },
      };
    };

    beforeEach(async () => {
      const collection = config.database.appsglobal.collections.appStateEvents;
      try {
        await database.collection(collection).drop();
      } catch (err) {
        // Collection doesn't exist
      }
      await dbHelper.insertManyToDatabase(database, collection, [
        announcement('192.168.1.1:16127', [{ name: 'App1', hash: 'hash1' }, { name: 'App2', hash: 'hash2' }]),
        announcement('192.168.1.2:16127', [{ name: 'App3', hash: 'hash3' }]),
        // a second node on the SAME machine, different apiport - must be included
        announcement('192.168.1.1:16137', [{ name: 'App4', hash: 'hash4' }]),
        // a neighbouring address that shares a textual prefix - must NOT be included
        announcement('192.168.1.10:16127', [{ name: 'App5', hash: 'hash5' }]),
      ]);
    });

    it('returns every app on the machine, across apiports', async () => {
      const result = await registryManager.getRunningAppIpList('192.168.1.1');

      expect(result.map((app) => app.name).sort()).to.deep.equal(['App1', 'App2', 'App4']);
    });

    it('does not spill onto an address that merely shares a prefix', async () => {
      const result = await registryManager.getRunningAppIpList('192.168.1.1');

      expect(result.map((app) => app.name)).to.not.include('App5');
    });

    it('should return empty array for IP with no apps', async () => {
      const result = await registryManager.getRunningAppIpList('10.0.0.1');

      expect(result).to.be.an('array');
      expect(result).to.be.empty;
    });
  });

  describe('appLocationFromEvents tests', () => {
    const eventsCollection = config.database.appsglobal.collections.appStateEvents;
    const now = Date.now();

    beforeEach(async () => {
      try {
        await database.collection(eventsCollection).drop();
      } catch (err) {
        // Collection doesn't exist
      }
    });

    function makeV2Event(ip, apps, broadcastedAt, opts = {}) {
      return {
        ip,
        type: 'apprunning',
        dedupKey: 'v2',
        broadcastedAt: new Date(broadcastedAt),
        expireAt: new Date(broadcastedAt + 125 * 60 * 1000),
        data: {
          ip, version: 2, apps, broadcastedAt, osUptime: 1000, staticIp: true,
        },
        envelope: { version: 1, timestamp: broadcastedAt, pubKey: '04abc', signature: 'sig' },
        ...opts,
      };
    }

    function makeAppRemovedEvent(ip, appName, broadcastedAt) {
      return {
        ip,
        type: 'appremoved',
        dedupKey: `appremoved:${appName}`,
        broadcastedAt: new Date(broadcastedAt),
        expireAt: new Date(broadcastedAt + 125 * 60 * 1000),
        data: { ip, appName, broadcastedAt },
        envelope: { version: 1, timestamp: broadcastedAt, pubKey: '04abc', signature: 'sig' },
      };
    }

    function makeSigtermEvent(ip, broadcastedAt) {
      return {
        ip,
        type: 'sigterm',
        dedupKey: 'sigterm',
        broadcastedAt: new Date(broadcastedAt),
        expireAt: new Date(broadcastedAt + 7 * 60 * 1000),
        envelope: { version: 1, timestamp: broadcastedAt, pubKey: '04abc', signature: 'sig' },
      };
    }

    function makeNodeDownEvent(ip, broadcastedAt, since = broadcastedAt, reason = 'unannounced') {
      return {
        ip,
        type: 'nodedown',
        subject: 'subj:0',
        dedupKey: `nodedown:subj:0:${broadcastedAt}`,
        broadcastedAt: new Date(broadcastedAt),
        since: new Date(since),
        reason,
        expireAt: new Date(broadcastedAt + 6 * 60 * 60 * 1000),
        data: { certificate: { subject: 'subj:0', since, reason } },
      };
    }

    function makeEvictedEvent(ip, createdAt) {
      return {
        ip,
        type: 'evicted',
        dedupKey: 'evicted',
        createdAt: new Date(createdAt),
        expireAt: new Date(createdAt + 125 * 60 * 1000),
      };
    }

    function makeIPChangedEvent(oldIP, newIP, broadcastedAt) {
      return {
        ip: oldIP,
        type: 'ipchanged',
        dedupKey: 'ipchanged',
        broadcastedAt: new Date(broadcastedAt),
        expireAt: new Date(broadcastedAt + 125 * 60 * 1000),
        data: { oldIP, newIP, broadcastedAt },
      };
    }

    it('should derive locations from v2 events', async () => {
      await database.collection(eventsCollection).insertOne(
        makeV2Event('1.2.3.4', [{ name: 'AppA', hash: 'h1' }, { name: 'AppB', hash: 'h2' }], now),
      );

      const result = await appsRepository.appLocationFromEvents();
      expect(result).to.be.an('array').with.lengthOf(2);
      const names = result.map((r) => r.name).sort();
      expect(names).to.deep.equal(['AppA', 'AppB']);
      expect(result[0].ip).to.equal('1.2.3.4');
    });

    it('should exclude apps with newer appremoved event', async () => {
      await database.collection(eventsCollection).insertMany([
        makeV2Event('1.2.3.4', [{ name: 'AppA', hash: 'h1' }, { name: 'AppB', hash: 'h2' }], now - 60000),
        makeAppRemovedEvent('1.2.3.4', 'AppA', now),
      ]);

      const result = await appsRepository.appLocationFromEvents();
      expect(result).to.be.an('array').with.lengthOf(1);
      expect(result[0].name).to.equal('AppB');
    });

    it('should keep apps when appremoved is older than broadcast', async () => {
      await database.collection(eventsCollection).insertMany([
        makeAppRemovedEvent('1.2.3.4', 'AppA', now - 120000),
        makeV2Event('1.2.3.4', [{ name: 'AppA', hash: 'h1' }], now),
      ]);

      const result = await appsRepository.appLocationFromEvents();
      expect(result).to.be.an('array').with.lengthOf(1);
      expect(result[0].name).to.equal('AppA');
    });

    it('a sigterm row left by an older release is inert: it neither keeps nor negates an announcement', async () => {
      // The sigterm broadcast is gone; the certificate's since + grace does its
      // job. A row of the old type in a log that survived the upgrade must not
      // negate (it was never a jury's word) and must not extend anything.
      await database.collection(eventsCollection).insertMany([
        makeV2Event('1.2.3.4', [{ name: 'AppA', hash: 'h1' }], now - 10 * 60 * 1000),
        makeSigtermEvent('1.2.3.4', now - 8 * 60 * 1000),
        makeV2Event('1.2.3.5', [{ name: 'AppB', hash: 'h2' }], now - 60 * 60 * 1000),
        makeSigtermEvent('1.2.3.5', now - 30 * 60 * 1000),
      ]);

      const result = await appsRepository.appLocationFromEvents();
      expect(result.map((row) => row.name).sort()).to.deep.equal(['AppA', 'AppB']);
    });

    it('should exclude apps immediately when evicted (no grace period)', async () => {
      await database.collection(eventsCollection).insertMany([
        makeV2Event('1.2.3.4', [{ name: 'AppA', hash: 'h1' }], now - 60000),
        makeEvictedEvent('1.2.3.4', now),
      ]);

      const result = await appsRepository.appLocationFromEvents();
      expect(result).to.be.an('array').with.lengthOf(0);
    });

    it('should exclude apps when evicted and expired', async () => {
      const evictedTime = now - 8 * 60 * 1000;
      await database.collection(eventsCollection).insertMany([
        makeV2Event('1.2.3.4', [{ name: 'AppA', hash: 'h1' }], now - 10 * 60 * 1000),
        makeEvictedEvent('1.2.3.4', evictedTime),
      ]);

      const result = await appsRepository.appLocationFromEvents();
      expect(result).to.be.an('array').with.lengthOf(0);
    });

    it('should keep apps when broadcast is newer than eviction', async () => {
      await database.collection(eventsCollection).insertMany([
        makeEvictedEvent('1.2.3.4', now - 60000),
        makeV2Event('1.2.3.4', [{ name: 'AppA', hash: 'h1' }], now),
      ]);

      const result = await appsRepository.appLocationFromEvents();
      expect(result).to.be.an('array').with.lengthOf(1);
    });

    it('should remap IP when ipchanged event is newer than broadcast', async () => {
      await database.collection(eventsCollection).insertMany([
        makeV2Event('1.1.1.1', [{ name: 'AppA', hash: 'h1' }, { name: 'AppB', hash: 'h2' }], now - 60000),
        makeIPChangedEvent('1.1.1.1', '2.2.2.2', now),
      ]);

      const result = await appsRepository.appLocationFromEvents();
      expect(result).to.be.an('array').with.lengthOf(2);
      result.forEach((r) => expect(r.ip).to.equal('2.2.2.2'));
    });

    it('should not remap IP when ipchanged is older than broadcast', async () => {
      await database.collection(eventsCollection).insertMany([
        makeIPChangedEvent('1.1.1.1', '2.2.2.2', now - 120000),
        makeV2Event('1.1.1.1', [{ name: 'AppA', hash: 'h1' }], now),
      ]);

      const result = await appsRepository.appLocationFromEvents();
      expect(result).to.be.an('array').with.lengthOf(1);
      expect(result[0].ip).to.equal('1.1.1.1');
    });

    it('should dedup remapped apps with fresh broadcast at new IP', async () => {
      await database.collection(eventsCollection).insertMany([
        makeV2Event('1.1.1.1', [{ name: 'AppA', hash: 'h1' }, { name: 'AppB', hash: 'h2' }], now - 120000),
        makeIPChangedEvent('1.1.1.1', '2.2.2.2', now - 60000),
        makeV2Event('2.2.2.2', [{ name: 'AppA', hash: 'h1' }, { name: 'AppB', hash: 'h2' }, { name: 'AppC', hash: 'h3' }], now),
      ]);

      const result = await appsRepository.appLocationFromEvents();
      expect(result).to.be.an('array').with.lengthOf(3);
      const names = result.map((r) => r.name).sort();
      expect(names).to.deep.equal(['AppA', 'AppB', 'AppC']);
      result.forEach((r) => expect(r.ip).to.equal('2.2.2.2'));
    });

    // A node's announcement is the COMPLETE list of what it runs, so an app missing
    // from the post-move announcement has stopped. Asking by name is the sharp case:
    // the announcement that retires the app is the one that no longer names it, so a
    // name-scoped read cannot see it and the superseded announcement has to be
    // excluded before the query runs.
    it('drops an app the post-move announcement no longer lists', async () => {
      await database.collection(eventsCollection).insertMany([
        makeV2Event('1.1.1.1', [{ name: 'AppA', hash: 'h1' }, { name: 'AppB', hash: 'h2' }], now - 120000),
        makeIPChangedEvent('1.1.1.1', '2.2.2.2', now - 60000),
        makeV2Event('2.2.2.2', [{ name: 'AppB', hash: 'h2' }], now),
      ]);

      const all = await appsRepository.appLocationFromEvents();
      expect(all.map((r) => `${r.name}@${r.ip}`)).to.deep.equal(['AppB@2.2.2.2']);

      const byName = await appsRepository.appLocationFromEvents({ appname: 'AppA' });
      expect(byName).to.be.an('array').with.lengthOf(0);
    });

    it('re-addresses a node that moved but has not re-announced', async () => {
      await database.collection(eventsCollection).insertMany([
        makeV2Event('1.1.1.1', [{ name: 'AppA', hash: 'h1' }], now - 120000),
        makeIPChangedEvent('1.1.1.1', '2.2.2.2', now - 60000),
      ]);

      for (const result of [
        await appsRepository.appLocationFromEvents(),
        await appsRepository.appLocationFromEvents({ appname: 'AppA' }),
      ]) {
        expect(result).to.be.an('array').with.lengthOf(1);
        expect(result[0].ip).to.equal('2.2.2.2');
      }
    });

    it('ignores a move that predates the announcement', async () => {
      await database.collection(eventsCollection).insertMany([
        makeIPChangedEvent('1.1.1.1', '2.2.2.2', now - 120000),
        makeV2Event('1.1.1.1', [{ name: 'AppA', hash: 'h1' }], now - 60000),
      ]);

      const result = await appsRepository.appLocationFromEvents();
      expect(result).to.be.an('array').with.lengthOf(1);
      expect(result[0].ip).to.equal('1.1.1.1');
    });

    // Co-located replicas of one app share a name and an address, so they are only
    // distinguishable by replica - the reason the derivation carries replica and
    // state per row rather than collapsing on {name, ip}.
    it('reports co-located replicas separately, with their own LB state', async () => {
      await database.collection(eventsCollection).insertOne(
        makeV2Event('1.1.1.1', [
          { name: 'AppA', hash: 'h1', replica: 'r0', state: 'active' },
          { name: 'AppA', hash: 'h1', replica: 'r1', state: 'draining' },
        ], now),
      );

      const result = await appsRepository.appLocationFromEvents({ appname: 'AppA' });
      expect(result).to.have.lengthOf(2);
      const byReplica = Object.fromEntries(result.map((r) => [r.replica, r.state]));
      expect(byReplica).to.deep.equal({ r0: 'active', r1: 'draining' });
    });

    it('keeps co-located replicas distinct across a move', async () => {
      await database.collection(eventsCollection).insertMany([
        makeV2Event('1.1.1.1', [
          { name: 'AppA', hash: 'h1', replica: 'r0', state: 'active' },
          { name: 'AppA', hash: 'h1', replica: 'r1', state: 'draining' },
        ], now - 120000),
        makeIPChangedEvent('1.1.1.1', '2.2.2.2', now - 60000),
      ]);

      const result = await appsRepository.appLocationFromEvents({ appname: 'AppA' });
      expect(result).to.have.lengthOf(2);
      result.forEach((r) => expect(r.ip).to.equal('2.2.2.2'));
      expect(result.map((r) => r.replica).sort()).to.deep.equal(['r0', 'r1']);
    });

    it('an untagged install reports a null replica and active state', async () => {
      await database.collection(eventsCollection).insertOne(
        makeV2Event('1.1.1.1', [{ name: 'AppA', hash: 'h1' }], now),
      );

      const result = await appsRepository.appLocationFromEvents({ appname: 'AppA' });
      expect(result).to.have.lengthOf(1);
      expect(result[0].replica).to.equal(null);
      expect(result[0].state).to.equal('active');
    });

    // expireAt is read off /apps/locations by callers outside this codebase, so it is
    // derived to the same rule the materialized collection wrote it by.
    it('derives expireAt from the announcement and the running TTL', async () => {
      const at = now - 60000;
      await database.collection(eventsCollection).insertOne(
        makeV2Event('1.1.1.1', [{ name: 'AppA', hash: 'h1' }], at),
      );

      const result = await appsRepository.appLocationFromEvents({ appname: 'AppA' });
      expect(result).to.have.lengthOf(1);
      expect(new Date(result[0].expireAt).getTime()).to.equal(at + RUNNING_EXPIRY_MS);
    });

    it('a certified node keeps its rows until since + the grace, then loses them; an announcement at or after the certificate restores them', async () => {
      const { NODE_DOWN_GRACE_MS } = require('../../ZelBack/src/services/utils/appConstants');
      await database.collection(eventsCollection).insertMany([
        // inside the grace: the drop was 60 s ago, certified 50 s ago
        makeV2Event('1.2.3.4', [{ name: 'AppA', hash: 'h1' }], now - 10 * 60 * 1000),
        makeNodeDownEvent('1.2.3.4', now - 50 * 1000, now - 60 * 1000),
        // past the grace: the drop was 8 minutes ago, certified at once
        makeV2Event('1.2.3.5', [{ name: 'AppB', hash: 'h2' }], now - 10 * 60 * 1000),
        makeNodeDownEvent('1.2.3.5', now - 8 * 60 * 1000 + 5000, now - 8 * 60 * 1000),
        // an announced shutdown that overran: certified at the grace end, since = the drop 7 min ago -> gone on arrival
        makeV2Event('1.2.3.6', [{ name: 'AppC', hash: 'h3' }], now - 10 * 60 * 1000),
        makeNodeDownEvent('1.2.3.6', now - 1000, now - NODE_DOWN_GRACE_MS - 1000, 'shutdown'),
        // past the grace but the node announced after the certificate: back
        makeV2Event('1.2.3.7', [{ name: 'AppD', hash: 'h4' }], now - 1000),
        makeNodeDownEvent('1.2.3.7', now - 8 * 60 * 1000, now - 8 * 60 * 1000),
      ]);

      const result = await appsRepository.appLocationFromEvents();
      expect(result.map((row) => row.name).sort()).to.deep.equal(['AppA', 'AppD']);
    });

    it('a certified node\'s rows expire at since + the grace while the certificate stands newer than the announcement', async () => {
      const { NODE_DOWN_GRACE_MS } = require('../../ZelBack/src/services/utils/appConstants');
      const announcedAt = now - 60000;
      const since = now - 30000;
      await database.collection(eventsCollection).insertMany([
        makeV2Event('1.1.1.1', [{ name: 'AppA', hash: 'h1' }], announcedAt),
        makeNodeDownEvent('1.1.1.1', now - 20000, since),
      ]);

      const result = await appsRepository.appLocationFromEvents({ appname: 'AppA' });
      expect(result).to.have.lengthOf(1);
      expect(new Date(result[0].expireAt).getTime()).to.equal(since + NODE_DOWN_GRACE_MS);
    });

    it('rows of an address gone from the node list past the off-list grace are negated on every read; inside the grace they stand; back on the list they return', async () => {
      const { departures, OFF_LIST_GRACE_MS } = require('../../ZelBack/src/services/appDatabase/offListDepartures');
      departures.resetForTests();
      const listed = Array.from({ length: 20 }, (_, i) => `10.7.0.${i + 1}:16127`);
      await database.collection(eventsCollection).insertMany([
        makeV2Event('10.7.0.20:16127', [{ name: 'AppA', hash: 'h1' }], now - 60_000),
        makeV2Event('10.7.0.19:16127', [{ name: 'AppB', hash: 'h2' }], now - 60_000),
      ]);
      // the register is read against the wall clock at read time, so its
      // times come from the clock now, not the file's load-time `now`
      const clock = Date.now();
      departures.noteList(listed, clock - 10 * 60_000);
      // 10.7.0.20 left the list inside the grace: its row stands
      departures.noteList(listed.slice(0, 19), clock - OFF_LIST_GRACE_MS + 60_000);
      let result = await appsRepository.appLocationFromEvents();
      expect(result.map((row) => row.name).sort()).to.deep.equal(['AppA', 'AppB']);
      // past the grace: negated, on the row read and on the count alike
      departures.resetForTests();
      departures.noteList(listed, clock - 10 * 60_000);
      departures.noteList(listed.slice(0, 19), clock - OFF_LIST_GRACE_MS - 1000);
      result = await appsRepository.appLocationFromEvents();
      expect(result.map((row) => row.name)).to.deep.equal(['AppB']);
      const counts = await appsRepository.countRunningByApp();
      expect(counts.has('appa')).to.equal(false);
      // back on the list: forgiven at once
      departures.noteList(listed, Date.now());
      result = await appsRepository.appLocationFromEvents();
      expect(result.map((row) => row.name).sort()).to.deep.equal(['AppA', 'AppB']);
      departures.resetForTests();
    });

    it('the boot sweep: a row address the current list does not carry starts its grace from the sweep, and nothing is negated before it', async () => {
      const { departures, OFF_LIST_GRACE_MS } = require('../../ZelBack/src/services/appDatabase/offListDepartures');
      departures.resetForTests();
      const listed = Array.from({ length: 20 }, (_, i) => `10.7.0.${i + 1}:16127`);
      await database.collection(eventsCollection).insertMany([
        makeV2Event('10.7.0.99:16127', [{ name: 'AppGone', hash: 'h1' }], now - 60_000),
        makeV2Event('10.7.0.1:16127', [{ name: 'AppHere', hash: 'h2' }], now - 60_000),
      ]);
      departures.noteList(listed, now);
      const clock = sinon.useFakeTimers({ now, toFake: ['Date'] });
      try {
        // no sweep yet: the register knows nothing of the rows
        clock.tick(OFF_LIST_GRACE_MS + 1);
        let result = await appsRepository.appLocationFromEvents();
        expect(result.map((row) => row.name).sort()).to.deep.equal(['AppGone', 'AppHere']);
        // the sweep, then the grace
        expect(await appsRepository.sweepOffListRows()).to.equal(2);
        result = await appsRepository.appLocationFromEvents();
        expect(result.map((row) => row.name).sort()).to.deep.equal(['AppGone', 'AppHere']);
        clock.tick(OFF_LIST_GRACE_MS + 1);
        result = await appsRepository.appLocationFromEvents();
        expect(result.map((row) => row.name)).to.deep.equal(['AppHere']);
      } finally {
        clock.restore();
        departures.resetForTests();
      }
    });

    it('a legacy sigterm row does not shorten expireAt', async () => {
      const announcedAt = now - 60000;
      await database.collection(eventsCollection).insertMany([
        makeV2Event('1.1.1.1', [{ name: 'AppA', hash: 'h1' }], announcedAt),
        makeSigtermEvent('1.1.1.1', now - 30000),
      ]);

      const result = await appsRepository.appLocationFromEvents({ appname: 'AppA' });
      expect(result).to.have.lengthOf(1);
      expect(new Date(result[0].expireAt).getTime()).to.equal(announcedAt + RUNNING_EXPIRY_MS);
    });

    it('should exclude expired events', async () => {
      const expired = now - 130 * 60 * 1000;
      await database.collection(eventsCollection).insertOne(
        makeV2Event('1.2.3.4', [{ name: 'AppA', hash: 'h1' }], expired),
      );

      const result = await appsRepository.appLocationFromEvents();
      expect(result).to.be.an('array').with.lengthOf(0);
    });

    it('should filter by appname (case insensitive)', async () => {
      await database.collection(eventsCollection).insertOne(
        makeV2Event('1.2.3.4', [{ name: 'AppA', hash: 'h1' }, { name: 'AppB', hash: 'h2' }], now),
      );

      const result = await appsRepository.appLocationFromEvents({ appname: 'appa' });
      expect(result).to.be.an('array').with.lengthOf(1);
      expect(result[0].name).to.equal('AppA');
    });

    it('should handle multiple IPs independently', async () => {
      await database.collection(eventsCollection).insertMany([
        makeV2Event('1.2.3.4', [{ name: 'AppA', hash: 'h1' }], now),
        makeV2Event('5.6.7.8', [{ name: 'AppB', hash: 'h2' }], now),
        makeAppRemovedEvent('5.6.7.8', 'AppB', now + 1000),
      ]);

      const result = await appsRepository.appLocationFromEvents();
      expect(result).to.be.an('array').with.lengthOf(1);
      expect(result[0].name).to.equal('AppA');
      expect(result[0].ip).to.equal('1.2.3.4');
    });

    it('should filter by ip option', async () => {
      await database.collection(eventsCollection).insertMany([
        makeV2Event('1.2.3.4', [{ name: 'AppA', hash: 'h1' }], now),
        makeV2Event('5.6.7.8', [{ name: 'AppB', hash: 'h2' }], now),
      ]);

      const result = await appsRepository.appLocationFromEvents({ ip: '5.6.7.8' });
      expect(result).to.be.an('array').with.lengthOf(1);
      expect(result[0].name).to.equal('AppB');
      expect(result[0].ip).to.equal('5.6.7.8');
    });

    it('should return empty when filtering by ip with no apps', async () => {
      await database.collection(eventsCollection).insertMany([
        makeV2Event('1.2.3.4', [{ name: 'AppA', hash: 'h1' }], now),
      ]);

      const result = await appsRepository.appLocationFromEvents({ ip: '9.9.9.9' });
      expect(result).to.be.an('array').with.lengthOf(0);
    });
  });

  describe('spec-stored wake hook (setOnSpecStored)', () => {
    afterEach(() => {
      registryManager.setOnSpecStored(null);
    });

    /** The stored document for an app at a given chain position. */
    async function storedDoc(name, { hash, height }) {
      return (await instantiatedSpec(await v9Spec({ name }), { hash, height })).serialize();
    }

    /**
     * `upsertGlobalAppInfo` is stubbed here — it is the mongo write — so nothing
     * in this suite reads the row back. What the real one does with the document
     * is key it by `name` and store it verbatim; what reads it back is hydrate,
     * on the next boot, through InstantiatedSpec.deserialize. So assert the
     * property the repository reads and that the deserializer accepts the doc:
     * that pair is what the stub would otherwise be hiding.
     */
    function assertStorable(doc, name) {
      expect(doc.name, 'the repository keys the row on name').to.equal(name);
      const rehydrated = flux.InstantiatedSpec.deserialize(doc);
      expect(rehydrated.spec).to.be.instanceOf(flux.FluxAppSpecV9);
      expect(rehydrated.name).to.equal(name);
      return rehydrated;
    }

    it('fires the hook with the stored spec after a permanent store', async () => {
      const upsert = sinon.stub(appsRepository, 'upsertGlobalAppInfo').resolves();
      const hook = sinon.stub();
      registryManager.setOnSpecStored(hook);

      const spec = await storedDoc('hookapp', { hash: 'h1', height: 100 });
      const res = await registryManager.storeAppSpecificationInPermanentStorage(spec);

      expect(res.status).to.equal('success');
      sinon.assert.calledOnce(upsert);
      sinon.assert.calledWith(upsert, spec);
      sinon.assert.calledOnce(hook);
      sinon.assert.calledWith(hook, spec);

      assertStorable(upsert.firstCall.args[0], 'hookapp');
      // The hook is the spawner wake, and the spawner is not in this suite. It
      // keys its work off the app's name and the message hash, so assert the
      // object it was handed still carries both.
      const [woken] = hook.firstCall.args;
      expect(woken.name).to.equal('hookapp');
      expect(woken.hash).to.equal('h1');
      expect(woken.height).to.equal(100);
    });

    it('insert routes through the registry (not raw dbHelper) and fires the hook', async () => {
      sinon.stub(appsRepository, 'getGlobalAppHeight').resolves(null);
      const upsert = sinon.stub(appsRepository, 'upsertGlobalAppInfo').resolves();
      const replaceOne = sinon.stub(dbHelper, 'replaceOneInDatabase').resolves();
      sinon.stub(dbHelper, 'removeDocumentsFromCollection').resolves();
      const hook = sinon.stub();
      registryManager.setOnSpecStored(hook);

      const spec = await storedDoc('routeapp', { hash: 'h2', height: 10 });
      await registryManager.insertAppSpecifications(spec);

      sinon.assert.calledOnce(upsert); // went through the registry
      sinon.assert.calledWith(upsert, spec);
      sinon.assert.notCalled(replaceOne); // did NOT hand-roll the dbHelper spec write
      sinon.assert.calledOnce(hook);
      sinon.assert.calledWith(hook, spec);
      assertStorable(upsert.firstCall.args[0], 'routeapp');
    });

    it('update routes through the registry with upsert:false and fires the hook', async () => {
      sinon.stub(appsRepository, 'getGlobalAppHeight').resolves(50); // exists, older than the update
      const upsert = sinon.stub(appsRepository, 'upsertGlobalAppInfo').resolves();
      const replaceOne = sinon.stub(dbHelper, 'replaceOneInDatabase').resolves();
      sinon.stub(dbHelper, 'removeDocumentsFromCollection').resolves();
      const hook = sinon.stub();
      registryManager.setOnSpecStored(hook);

      const spec = await storedDoc('updroute', { hash: 'h3', height: 100 });
      await registryManager.updateAppSpecifications(spec);

      sinon.assert.calledWith(upsert, spec, { upsert: false });
      sinon.assert.notCalled(replaceOne);
      sinon.assert.calledOnce(hook);
      assertStorable(upsert.firstCall.args[0], 'updroute');
    });

    it('a throwing hook does not break the store', async () => {
      sinon.stub(appsRepository, 'upsertGlobalAppInfo').resolves();
      registryManager.setOnSpecStored(() => { throw new Error('hook boom'); });

      const res = await registryManager.storeAppSpecificationInPermanentStorage(
        await storedDoc('safeapp', { hash: 'h', height: 1 }),
      );
      expect(res.status).to.equal('success'); // store succeeded despite the throwing hook
    });

    it('does not fire when no hook is registered', async () => {
      registryManager.setOnSpecStored(null);
      const upsert = sinon.stub(appsRepository, 'upsertGlobalAppInfo').resolves();

      await registryManager.storeAppSpecificationInPermanentStorage(
        await storedDoc('nohook', { hash: 'h', height: 1 }),
      );

      sinon.assert.calledOnce(upsert); // store still happened, just no hook
    });
  });

  // Every spec write also maintains the host-side component mapping, from the
  // CLEARTEXT view of what was just stored. Nothing covered it.
  describe('founding view materialization', () => {
    it('resolves the entry it just stored and maps the components off the cleartext view', async () => {
      const sealed = await sealedV9Spec({ name: 'meshapp' });
      const stored = await registryHolds(sealed, { hash: 'hm', height: 2500000 });
      const doc = stored.serialize();
      sinon.stub(appsRepository, 'upsertGlobalAppInfo').resolves();
      // The resolver decrypts through the benchmark channel, so it stays
      // stubbed — and it hands back what the real one hands back for a sealed
      // app: a DecryptedCanonicalSpec, never a raw serializable spec.
      const view = await sealed.decrypt(await sealed.createProvider());
      const resolve = sinon.stub(specCutover, 'resolveInstantiatedSpec').resolves(view);
      const applyComponentView = sinon.stub(foundingCommittee, 'applyComponentView').resolves();

      await registryManager.storeAppSpecificationInPermanentStorage(doc);

      // Stubbing the resolver hides whether the entry we hand it is usable. The
      // real one branches on `isEncrypted`, then calls `createProvider()` on the
      // inner spec before decrypting it — so assert the entry can answer that,
      // or the delegation could vanish from flux-spec with this suite green.
      sinon.assert.calledOnce(resolve);
      const [handed] = resolve.firstCall.args;
      expect(handed.isEncrypted, 'the real resolver branches on it').to.be.true;
      expect(handed.name, 'and logs a failed decrypt against it').to.equal('meshapp');
      assertAnswers(handed.spec, ['createProvider']);

      // And the mapping is taken off the cleartext view, not off the sealed row —
      // the sealed row has no components at all.
      sinon.assert.calledOnce(applyComponentView);
      const [mapped] = applyComponentView.firstCall.args;
      expect(mapped.name).to.equal('meshapp');
      expect(mapped.height).to.equal(2500000);
      expect(Object.keys(mapped.components)).to.deep.equal(['web']);
      expect(doc, 'the stored row itself carries none').to.not.have.property('components');
    });
  });
});
