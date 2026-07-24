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
const transportCryptoProvider = require('../../ZelBack/src/services/providers/FluxOSTransportProvider');
const legacyTransportProvider = require('../../ZelBack/src/services/providers/FluxOSLegacyTransportProvider');
const { requireMongo } = require('./dbTestHelper');

describe('registryManager tests', () => {
  before(requireMongo);

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

  describe('previous app specifications (appSpecHistory)', () => {
    it('should return null if no previous message found', async () => {
      // eslint-disable-next-line global-require
      const appSpecHistory = require('../../ZelBack/src/services/appDatabase/appSpecHistory');
      // eslint-disable-next-line global-require
      const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');
      sinon.stub(appsRepository, 'listAppMessagesByName').resolves([]);

      const result = await appSpecHistory.getPreviousSpec({ name: 'NewApp' }, Date.now());
      expect(result).to.be.null;
    });
  });

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

  describe('appLocation tests', () => {
    beforeEach(async () => {
      const collection = config.database.appsglobal.collections.appsLocations;
      const testLocation = {
        name: 'TestApp',
        hash: 'testhash123',
        ip: '192.168.1.1:16127',
        broadcastedAt: new Date(),
        expireAt: new Date(Date.now() + 3600000),
      };

      try {
        await database.collection(collection).drop();
      } catch (err) {
        // Collection doesn't exist
      }
      await dbHelper.insertOneToDatabase(database, collection, testLocation);
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

    describe('encrypted spec view channel negotiation', () => {
      let fakeDecrypted;
      let fakeInstantiated;

      const buildReq = (headers) => ({
        params: { appname: 'TestApp', decrypt: 'true' },
        query: {},
        headers,
      });

      beforeEach(() => {
        fakeDecrypted = {
          spec: {
            name: 'TestApp',
            owner: 'owner123',
            toCanonical: () => ({ name: 'TestApp', version: 9, owner: 'owner123' }),
          },
          reencrypt: sinon.fake.resolves({ serialize: () => ({ reencrypted: true }) }),
        };
        fakeInstantiated = {
          isEncrypted: true,
          version: 9,
          name: 'TestApp',
          owner: 'owner123',
          spec: {
            createProvider: sinon.fake.resolves({}),
            decrypt: sinon.fake.resolves(fakeDecrypted),
            serialize: () => ({ sparse: true }),
          },
        };
        sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(fakeInstantiated);
        sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      });

      it('should require a view credential when decrypt is requested', async () => {
        const res = { json: sinon.fake((param) => param) };

        await registryManager.getApplicationSpecificationAPI(buildReq({}), res);

        const result = res.json.firstCall.args[0];
        expect(result.status).to.equal('error');
        expect(result.data.message).to.include('flux-transport-pubkey or enterprise-key');
      });

      it('should seal a v9 encrypted spec toward the caller over the transport layer', async () => {
        const fakeEnvelope = { toJSON: () => ({ algorithm: 'HPKE', encapsulatedKey: 'enc', ciphertext: 'ct' }) };
        const seal = sinon.fake.resolves(fakeEnvelope);
        sinon.stub(transportCryptoProvider, 'create').resolves({ seal });
        const pubkey = Buffer.alloc(32, 7).toString('base64');
        const res = { json: sinon.fake((param) => param) };

        await registryManager.getApplicationSpecificationAPI(buildReq({ 'flux-transport-pubkey': pubkey }), res);

        const result = res.json.firstCall.args[0];
        expect(result.status).to.equal('success');
        expect(result.data.encrypted).to.equal(true);
        expect(result.data.appName).to.equal('TestApp');
        expect(result.data).to.have.property('timestamp');
        expect(result.data.transportEncrypted).to.deep.equal({ algorithm: 'HPKE', encapsulatedKey: 'enc', ciphertext: 'ct' });
        // the storage decrypt ran, and the transport seal — not the storage
        // reencrypt — produced the view payload
        sinon.assert.calledOnce(fakeInstantiated.spec.decrypt);
        sinon.assert.notCalled(fakeDecrypted.reencrypt);
        const sealArg = seal.firstCall.args[0];
        expect(sealArg.peerPublicKey).to.deep.equal(Buffer.from(pubkey, 'base64'));
        expect(sealArg.info).to.be.a('string').that.is.not.empty;
        expect(sealArg.aad).to.exist;
      });

      it('should reencrypt a v8 encrypted spec over the legacy enterprise channel', async () => {
        fakeInstantiated.version = 8;
        const legacyCreate = sinon.stub(legacyTransportProvider, 'create').resolves({ tag: 'legacy' });
        const res = { json: sinon.fake((param) => param) };

        await registryManager.getApplicationSpecificationAPI(buildReq({ 'enterprise-key': 'wrappedKeyBase64' }), res);

        const result = res.json.firstCall.args[0];
        expect(result.status).to.equal('success');
        expect(result.data).to.deep.equal({ reencrypted: true });
        sinon.assert.calledOnceWithExactly(legacyCreate, 'TestApp', 'owner123', 'wrappedKeyBase64');
        sinon.assert.calledOnce(fakeDecrypted.reencrypt);
      });

      it('should reject a v9 app that arrives on the legacy enterprise channel', async () => {
        fakeInstantiated.version = 9;
        const res = { json: sinon.fake((param) => param) };

        await registryManager.getApplicationSpecificationAPI(buildReq({ 'enterprise-key': 'wrappedKeyBase64' }), res);

        const result = res.json.firstCall.args[0];
        expect(result.status).to.equal('error');
        expect(result.data.message).to.include('flux-transport-pubkey channel');
        // rejected before any crypto work
        sinon.assert.notCalled(fakeInstantiated.spec.decrypt);
      });

      it('should return the sparse stored spec when no decrypt is requested', async () => {
        const req = { params: { appname: 'TestApp' }, query: {}, headers: {} };
        const res = { json: sinon.fake((param) => param) };

        await registryManager.getApplicationSpecificationAPI(req, res);

        const result = res.json.firstCall.args[0];
        expect(result.status).to.equal('success');
        expect(result.data).to.deep.equal({ sparse: true });
        sinon.assert.notCalled(fakeInstantiated.spec.decrypt);
      });
    });
  });

  describe('checkApplicationRegistrationNameConflicts tests', () => {
    beforeEach(async () => {
      const collection = config.database.appsglobal.collections.appsInformation;
      const existingApp = {
        name: 'ExistingApp',
        version: 3,
        description: 'Test app',
        owner: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
        repotag: 'test/image:latest',
        ports: ['30001'],
        containerPorts: ['8080'],
        domains: [''],
        containerData: '',
        cpu: 0.5,
        ram: 500,
        hdd: 5,
        instances: 3,
        height: 100,
        expire: 22000,
        hash: 'testhash123',
      };

      try {
        await database.collection(collection).drop();
      } catch (err) {
        // Collection doesn't exist
      }
      await dbHelper.insertOneToDatabase(database, collection, existingApp);
    });

    it('should throw error if app name already exists', async () => {
      const appSpec = {
        name: 'ExistingApp',
        owner: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
      };

      try {
        await registryManager.checkApplicationRegistrationNameConflicts(appSpec);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('already registered');
      }
    });

    it('should allow registration if app name is unique', async () => {
      const appSpec = {
        name: 'UniqueAppName',
        owner: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
      };

      const result = await registryManager.checkApplicationRegistrationNameConflicts(appSpec);

      expect(result).to.be.true;
    });

    it('should reject app named "share"', async () => {
      const appSpec = {
        name: 'share',
        owner: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
      };

      try {
        await registryManager.checkApplicationRegistrationNameConflicts(appSpec);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('already assigned to Flux main application');
      }
    });
  });

  describe('updateAppSpecifications tests', () => {
    it('should update app specifications', async () => {
      const initialSpecs = {
        name: 'UpdateTestApp',
        version: 3,
        owner: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
        height: 100,
        hash: 'oldhash',
      };
      await registryManager.insertAppSpecifications(initialSpecs);

      const updatedSpecs = {
        name: 'UpdateTestApp',
        version: 3,
        owner: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
        height: 200,
        hash: 'newhash',
      };
      await registryManager.updateAppSpecifications(updatedSpecs);

      const result = await dbHelper.findOneInDatabase(database, config.database.appsglobal.collections.appsInformation, { name: 'UpdateTestApp' });
      expect(result.name).to.equal('UpdateTestApp');
      expect(result.height).to.equal(200);
      expect(result.hash).to.equal('newhash');
    });

    it('should not update if height is lower than existing', async () => {
      const initialSpecs = {
        name: 'HeightTestApp',
        version: 3,
        owner: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
        height: 300,
        hash: 'hash1',
      };

      await registryManager.insertAppSpecifications(initialSpecs);

      const lowerHeightSpecs = {
        ...initialSpecs,
        height: 200,
        hash: 'hash2',
      };

      await registryManager.updateAppSpecifications(lowerHeightSpecs);

      const result = await dbHelper.findOneInDatabase(database, config.database.appsglobal.collections.appsInformation, { name: 'HeightTestApp' });
      expect(result.height).to.equal(300);
      expect(result.hash).to.equal('hash1');
    });

    it('should not accumulate ghost fields when spec version changes', async () => {
      // Simulate a v3 flat spec registration
      const v3Spec = {
        version: 3,
        name: 'GhostFieldTestApp',
        description: 'Test',
        owner: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
        repotag: 'test/image:latest',
        cpu: 0.5,
        ram: 500,
        hdd: 5,
        height: 100,
        hash: 'hash1',
      };
      await registryManager.insertAppSpecifications(v3Spec);

      // Simulate a v4 compose update (no flat fields)
      const v4Spec = {
        version: 4,
        name: 'GhostFieldTestApp',
        description: 'Test',
        owner: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
        compose: [{ name: 'main', cpu: 0.5, ram: 500, hdd: 5 }],
        instances: 3,
        height: 200,
        hash: 'hash2',
      };
      await registryManager.updateAppSpecifications(v4Spec);

      const result = await dbHelper.findOneInDatabase(database, config.database.appsglobal.collections.appsInformation, { name: 'GhostFieldTestApp' });
      expect(result.version).to.equal(4);
      expect(result.compose).to.exist;
      // Ghost flat fields from v3 should NOT exist
      expect(result.repotag).to.be.undefined;
      expect(result.cpu).to.be.undefined;
      expect(result.ram).to.be.undefined;
      expect(result.hdd).to.be.undefined;
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

  describe('getRunningAppIpList tests', () => {
    beforeEach(async () => {
      const collection = config.database.appsglobal.collections.appsLocations;
      const testLocations = [
        {
          name: 'App1',
          ip: '192.168.1.1:16127',
          hash: 'hash1',
        },
        {
          name: 'App2',
          ip: '192.168.1.1:16127',
          hash: 'hash2',
        },
        {
          name: 'App3',
          ip: '192.168.1.2:16127',
          hash: 'hash3',
        },
      ];

      try {
        await database.collection(collection).drop();
      } catch (err) {
        // Collection doesn't exist
      }
      await dbHelper.insertManyToDatabase(database, collection, testLocations);
    });

    it('should return apps running on specific IP', async () => {
      const result = await registryManager.getRunningAppIpList('192.168.1.1');

      expect(result).to.be.an('array');
      expect(result.length).to.equal(2);
      result.forEach((app) => {
        expect(app.ip).to.include('192.168.1.1');
      });
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

      const result = await registryManager.appLocationFromEvents();
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

      const result = await registryManager.appLocationFromEvents();
      expect(result).to.be.an('array').with.lengthOf(1);
      expect(result[0].name).to.equal('AppB');
    });

    it('should keep apps when appremoved is older than broadcast', async () => {
      await database.collection(eventsCollection).insertMany([
        makeAppRemovedEvent('1.2.3.4', 'AppA', now - 120000),
        makeV2Event('1.2.3.4', [{ name: 'AppA', hash: 'h1' }], now),
      ]);

      const result = await registryManager.appLocationFromEvents();
      expect(result).to.be.an('array').with.lengthOf(1);
      expect(result[0].name).to.equal('AppA');
    });

    it('should exclude apps when sigterm is newer and expired', async () => {
      const sigtermTime = now - 8 * 60 * 1000;
      await database.collection(eventsCollection).insertMany([
        makeV2Event('1.2.3.4', [{ name: 'AppA', hash: 'h1' }], now - 10 * 60 * 1000),
        makeSigtermEvent('1.2.3.4', sigtermTime),
      ]);

      const result = await registryManager.appLocationFromEvents();
      expect(result).to.be.an('array').with.lengthOf(0);
    });

    it('should keep apps when sigterm expiry has not passed', async () => {
      await database.collection(eventsCollection).insertMany([
        makeV2Event('1.2.3.4', [{ name: 'AppA', hash: 'h1' }], now - 60000),
        makeSigtermEvent('1.2.3.4', now),
      ]);

      const result = await registryManager.appLocationFromEvents();
      expect(result).to.be.an('array').with.lengthOf(1);
      expect(result[0].name).to.equal('AppA');
    });

    it('should exclude apps when sigterm is past grace period but still in event log', async () => {
      const sigtermTime = now - 30 * 60 * 1000; // 30 min ago — past 7-min grace, within 125-min TTL
      await database.collection(eventsCollection).insertMany([
        makeV2Event('1.2.3.4', [{ name: 'AppA', hash: 'h1' }], now - 60 * 60 * 1000),
        makeSigtermEvent('1.2.3.4', sigtermTime),
      ]);

      const result = await registryManager.appLocationFromEvents();
      expect(result).to.be.an('array').with.lengthOf(0);
    });

    it('should keep apps when broadcast is newer than sigterm', async () => {
      await database.collection(eventsCollection).insertMany([
        makeSigtermEvent('1.2.3.4', now - 120000),
        makeV2Event('1.2.3.4', [{ name: 'AppA', hash: 'h1' }], now),
      ]);

      const result = await registryManager.appLocationFromEvents();
      expect(result).to.be.an('array').with.lengthOf(1);
    });

    it('should exclude apps immediately when evicted (no grace period)', async () => {
      await database.collection(eventsCollection).insertMany([
        makeV2Event('1.2.3.4', [{ name: 'AppA', hash: 'h1' }], now - 60000),
        makeEvictedEvent('1.2.3.4', now),
      ]);

      const result = await registryManager.appLocationFromEvents();
      expect(result).to.be.an('array').with.lengthOf(0);
    });

    it('should exclude apps when evicted and expired', async () => {
      const evictedTime = now - 8 * 60 * 1000;
      await database.collection(eventsCollection).insertMany([
        makeV2Event('1.2.3.4', [{ name: 'AppA', hash: 'h1' }], now - 10 * 60 * 1000),
        makeEvictedEvent('1.2.3.4', evictedTime),
      ]);

      const result = await registryManager.appLocationFromEvents();
      expect(result).to.be.an('array').with.lengthOf(0);
    });

    it('should keep apps when broadcast is newer than eviction', async () => {
      await database.collection(eventsCollection).insertMany([
        makeEvictedEvent('1.2.3.4', now - 60000),
        makeV2Event('1.2.3.4', [{ name: 'AppA', hash: 'h1' }], now),
      ]);

      const result = await registryManager.appLocationFromEvents();
      expect(result).to.be.an('array').with.lengthOf(1);
    });

    it('should remap IP when ipchanged event is newer than broadcast', async () => {
      await database.collection(eventsCollection).insertMany([
        makeV2Event('1.1.1.1', [{ name: 'AppA', hash: 'h1' }, { name: 'AppB', hash: 'h2' }], now - 60000),
        makeIPChangedEvent('1.1.1.1', '2.2.2.2', now),
      ]);

      const result = await registryManager.appLocationFromEvents();
      expect(result).to.be.an('array').with.lengthOf(2);
      result.forEach((r) => expect(r.ip).to.equal('2.2.2.2'));
    });

    it('should not remap IP when ipchanged is older than broadcast', async () => {
      await database.collection(eventsCollection).insertMany([
        makeIPChangedEvent('1.1.1.1', '2.2.2.2', now - 120000),
        makeV2Event('1.1.1.1', [{ name: 'AppA', hash: 'h1' }], now),
      ]);

      const result = await registryManager.appLocationFromEvents();
      expect(result).to.be.an('array').with.lengthOf(1);
      expect(result[0].ip).to.equal('1.1.1.1');
    });

    it('should dedup remapped apps with fresh broadcast at new IP', async () => {
      await database.collection(eventsCollection).insertMany([
        makeV2Event('1.1.1.1', [{ name: 'AppA', hash: 'h1' }, { name: 'AppB', hash: 'h2' }], now - 120000),
        makeIPChangedEvent('1.1.1.1', '2.2.2.2', now - 60000),
        makeV2Event('2.2.2.2', [{ name: 'AppA', hash: 'h1' }, { name: 'AppB', hash: 'h2' }, { name: 'AppC', hash: 'h3' }], now),
      ]);

      const result = await registryManager.appLocationFromEvents();
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

      const all = await registryManager.appLocationFromEvents();
      expect(all.map((r) => `${r.name}@${r.ip}`)).to.deep.equal(['AppB@2.2.2.2']);

      const byName = await registryManager.appLocationFromEvents({ appname: 'AppA' });
      expect(byName).to.be.an('array').with.lengthOf(0);
    });

    it('re-addresses a node that moved but has not re-announced', async () => {
      await database.collection(eventsCollection).insertMany([
        makeV2Event('1.1.1.1', [{ name: 'AppA', hash: 'h1' }], now - 120000),
        makeIPChangedEvent('1.1.1.1', '2.2.2.2', now - 60000),
      ]);

      for (const result of [
        await registryManager.appLocationFromEvents(),
        await registryManager.appLocationFromEvents({ appname: 'AppA' }),
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

      const result = await registryManager.appLocationFromEvents();
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

      const result = await registryManager.appLocationFromEvents({ appname: 'AppA' });
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

      const result = await registryManager.appLocationFromEvents({ appname: 'AppA' });
      expect(result).to.have.lengthOf(2);
      result.forEach((r) => expect(r.ip).to.equal('2.2.2.2'));
      expect(result.map((r) => r.replica).sort()).to.deep.equal(['r0', 'r1']);
    });

    it('an untagged install reports a null replica and active state', async () => {
      await database.collection(eventsCollection).insertOne(
        makeV2Event('1.1.1.1', [{ name: 'AppA', hash: 'h1' }], now),
      );

      const result = await registryManager.appLocationFromEvents({ appname: 'AppA' });
      expect(result).to.have.lengthOf(1);
      expect(result[0].replica).to.equal(null);
      expect(result[0].state).to.equal('active');
    });

    it('should exclude expired events', async () => {
      const expired = now - 130 * 60 * 1000;
      await database.collection(eventsCollection).insertOne(
        makeV2Event('1.2.3.4', [{ name: 'AppA', hash: 'h1' }], expired),
      );

      const result = await registryManager.appLocationFromEvents();
      expect(result).to.be.an('array').with.lengthOf(0);
    });

    it('should filter by appname (case insensitive)', async () => {
      await database.collection(eventsCollection).insertOne(
        makeV2Event('1.2.3.4', [{ name: 'AppA', hash: 'h1' }, { name: 'AppB', hash: 'h2' }], now),
      );

      const result = await registryManager.appLocationFromEvents({ appname: 'appa' });
      expect(result).to.be.an('array').with.lengthOf(1);
      expect(result[0].name).to.equal('AppA');
    });

    it('should handle multiple IPs independently', async () => {
      await database.collection(eventsCollection).insertMany([
        makeV2Event('1.2.3.4', [{ name: 'AppA', hash: 'h1' }], now),
        makeV2Event('5.6.7.8', [{ name: 'AppB', hash: 'h2' }], now),
        makeAppRemovedEvent('5.6.7.8', 'AppB', now + 1000),
      ]);

      const result = await registryManager.appLocationFromEvents();
      expect(result).to.be.an('array').with.lengthOf(1);
      expect(result[0].name).to.equal('AppA');
      expect(result[0].ip).to.equal('1.2.3.4');
    });

    it('should filter by ip option', async () => {
      await database.collection(eventsCollection).insertMany([
        makeV2Event('1.2.3.4', [{ name: 'AppA', hash: 'h1' }], now),
        makeV2Event('5.6.7.8', [{ name: 'AppB', hash: 'h2' }], now),
      ]);

      const result = await registryManager.appLocationFromEvents({ ip: '5.6.7.8' });
      expect(result).to.be.an('array').with.lengthOf(1);
      expect(result[0].name).to.equal('AppB');
      expect(result[0].ip).to.equal('5.6.7.8');
    });

    it('should return empty when filtering by ip with no apps', async () => {
      await database.collection(eventsCollection).insertMany([
        makeV2Event('1.2.3.4', [{ name: 'AppA', hash: 'h1' }], now),
      ]);

      const result = await registryManager.appLocationFromEvents({ ip: '9.9.9.9' });
      expect(result).to.be.an('array').with.lengthOf(0);
    });
  });

  describe('spec-stored wake hook (setOnSpecStored)', () => {
    afterEach(() => {
      registryManager.setOnSpecStored(null);
    });

    it('fires the hook with the stored spec after a permanent store', async () => {
      const upsert = sinon.stub(appsRepository, 'upsertGlobalAppInfo').resolves();
      const hook = sinon.stub();
      registryManager.setOnSpecStored(hook);

      const spec = { name: 'HookApp', height: 100, hash: 'h1', owner: 'o' };
      const res = await registryManager.storeAppSpecificationInPermanentStorage(spec);

      expect(res.status).to.equal('success');
      sinon.assert.calledOnce(upsert);
      sinon.assert.calledWith(upsert, spec);
      sinon.assert.calledOnce(hook);
      sinon.assert.calledWith(hook, spec);
    });

    it('insert routes through the registry (not raw dbHelper) and fires the hook', async () => {
      sinon.stub(appsRepository, 'getGlobalAppHeight').resolves(null);
      const upsert = sinon.stub(appsRepository, 'upsertGlobalAppInfo').resolves();
      const replaceOne = sinon.stub(dbHelper, 'replaceOneInDatabase').resolves();
      sinon.stub(dbHelper, 'removeDocumentsFromCollection').resolves();
      const hook = sinon.stub();
      registryManager.setOnSpecStored(hook);

      const spec = { name: 'RouteApp', height: 10, hash: 'h2' };
      await registryManager.insertAppSpecifications(spec);

      sinon.assert.calledOnce(upsert); // went through the registry
      sinon.assert.calledWith(upsert, spec);
      sinon.assert.notCalled(replaceOne); // did NOT hand-roll the dbHelper spec write
      sinon.assert.calledOnce(hook);
      sinon.assert.calledWith(hook, spec);
    });

    it('update routes through the registry with upsert:false and fires the hook', async () => {
      sinon.stub(appsRepository, 'getGlobalAppHeight').resolves(50); // exists, older than the update
      const upsert = sinon.stub(appsRepository, 'upsertGlobalAppInfo').resolves();
      const replaceOne = sinon.stub(dbHelper, 'replaceOneInDatabase').resolves();
      sinon.stub(dbHelper, 'removeDocumentsFromCollection').resolves();
      const hook = sinon.stub();
      registryManager.setOnSpecStored(hook);

      const spec = { name: 'UpdRoute', height: 100, hash: 'h3' };
      await registryManager.updateAppSpecifications(spec);

      sinon.assert.calledWith(upsert, spec, { upsert: false });
      sinon.assert.notCalled(replaceOne);
      sinon.assert.calledOnce(hook);
    });

    it('a throwing hook does not break the store', async () => {
      sinon.stub(appsRepository, 'upsertGlobalAppInfo').resolves();
      registryManager.setOnSpecStored(() => { throw new Error('hook boom'); });

      const res = await registryManager.storeAppSpecificationInPermanentStorage({ name: 'SafeApp', height: 1, hash: 'h' });
      expect(res.status).to.equal('success'); // store succeeded despite the throwing hook
    });

    it('does not fire when no hook is registered', async () => {
      registryManager.setOnSpecStored(null);
      const upsert = sinon.stub(appsRepository, 'upsertGlobalAppInfo').resolves();

      await registryManager.storeAppSpecificationInPermanentStorage({ name: 'NoHook', height: 1, hash: 'h' });

      sinon.assert.calledOnce(upsert); // store still happened, just no hook
    });
  });
});
