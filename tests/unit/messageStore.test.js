const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('messageStore tests', () => {
  let messageStore;
  let dbHelperStub;
  let appsRepositoryStub;
  let appEventVerifierStub;
  let logStub;
  let configStub;

  function makeMockAppEvent(message) {
    const specs = message.appSpecifications || {};
    return {
      hash: message.hash,
      timestamp: message.timestamp,
      spec: {
        name: specs.name,
        owner: specs.owner,
        version: specs.version || 1,
        serialize: () => specs,
      },
      isRegistration: message.type === 'fluxappregister' || message.type === 'zelappregister',
      isUpdate: message.type === 'fluxappupdate' || message.type === 'zelappupdate',
      isEncrypted: false,
      requiresArcaneAttestation: () => false,
      serialize: () => ({
        type: message.type,
        version: message.version,
        appSpecifications: specs,
        hash: message.hash,
        timestamp: message.timestamp,
        signature: message.signature,
      }),
    };
  }

  function buildProxyquireStubs(overrides = {}) {
    return {
      config: configStub,
      '../dbHelper': dbHelperStub,
      '../appDatabase/appsRepository': appsRepositoryStub,
      './appEventVerifier': appEventVerifierStub,
      './messageVerifier': { checkAndRequestApp: sinon.stub().resolves() },
      '../../lib/log': logStub,
      '../fluxService': { isSystemSecure: sinon.stub().resolves(false) },
      '../daemonService/daemonServiceMiscRpcs': {
        isDaemonSynced: sinon.stub().returns({ data: { height: 1000 } }),
      },
      '../appDatabase/registryManager': {
        checkApplicationRegistrationNameConflicts: sinon.stub().resolves(),
      },
      '../appDatabase/appSpecHistory': {
        getPreviousState: sinon.stub().resolves({ spec: { owner: 'owner1' }, contentHash: null }),
      },
      '../utils/specLibs': {
        validateGossipSpec: sinon.stub().resolves(),
        getSpec: sinon.stub().resolves({ UpdatePolicy: { assertCompatible: sinon.stub() } }),
      },
      '../utils/globalState': {
        queuePendingUpdate: sinon.stub(),
      },
      '../utils/appSyncEvents': {
        appSyncEvents: { emit: sinon.stub(), on: sinon.stub(), removeListener: sinon.stub() },
        EVENTS: { HASH_RESPONSE_RECEIVED: 'hashResponseReceived' },
      },
      '../utils/appConstants': {
        globalAppsMessages: 'appsMessages',
        globalAppsTempMessages: 'appsTempMessages',
        globalAppsLocations: 'appsLocations',
        globalAppsInstallingLocations: 'appsInstallingLocations',
        globalAppsInstallingErrorsLocations: 'appsInstallingErrorsLocations',
        globalAppsInstallingErrorsBroadcasts: 'appsInstallingErrorsBroadcasts',
        globalAppStateEvents: 'appStateEvents',
        appsHashesCollection: 'appsHashes',
        GOSSIP_VALIDITY_MS: 5 * 60 * 1000,
        RUNNING_EXPIRY_MS: 125 * 60 * 1000,
        INSTALLING_EXPIRY_MS: 15 * 60 * 1000,
        INSTALLING_ERRORS_EXPIRY_MS: 24 * 60 * 60 * 1000,
        SIGTERM_EXPIRY_MS: 420 * 1000,
        EVICTED_EXPIRY_MS: 125 * 60 * 1000,
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    // Stubs
    dbHelperStub = {
      databaseConnection: sinon.stub(),
      findInDatabase: sinon.stub(),
      findOneInDatabase: sinon.stub(),
      insertOneToDatabase: sinon.stub(),
      updateOneInDatabase: sinon.stub(),
      updateInDatabase: sinon.stub(),
      removeDocumentsFromCollection: sinon.stub(),
      findOneAndDeleteInDatabase: sinon.stub(),
      countInDatabase: sinon.stub(),
    };

    appsRepositoryStub = {
      getPermanentMessage: sinon.stub(),
      getTempMessage: sinon.stub(),
    };

    appEventVerifierStub = {
      deserializeTempMessage: sinon.stub().callsFake((msg) => Promise.resolve(makeMockAppEvent(msg))),
      deserializeMessage: sinon.stub().resolves({}),
      authorize: sinon.stub().resolves(),
      authorizeWithReplayFallback: sinon.stub().resolves(),
      verifyAttestation: sinon.stub().returns(true),
    };

    logStub = {
      error: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
    };

    configStub = {
      database: {
        daemon: {
          database: 'daemondb',
        },
        appsglobal: {
          database: 'appsdb',
          collections: {
            appsLocations: 'appsLocations',
            appStateEvents: 'appStateEvents',
            appsInstallingBroadcasts: 'appsInstallingBroadcasts',
            appsInstallingErrorsBroadcasts: 'appsInstallingErrorsBroadcasts',
          },
        },
      },
      fluxapps: {
        maxAppsPerNode: 200,
        appSpecsEnforcementHeights: {},
      },
    };

    // Proxy require
    messageStore = proxyquire('../../ZelBack/src/services/appMessaging/messageStore', buildProxyquireStubs());
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('storeAppTemporaryMessage', () => {
    it('should return error for invalid message structure', async () => {
      const invalidMessage = { type: 'test' };

      const result = await messageStore.storeAppTemporaryMessage(invalidMessage);

      expect(result).to.be.instanceOf(Error);
      expect(result.message).to.include('Invalid Flux App message');
    });

    it('should return false if message already exists in permanent storage', async () => {
      const message = {
        type: 'fluxappregister',
        version: 1,
        appSpecifications: { name: 'test' },
        hash: 'hash123',
        timestamp: Date.now(),
        signature: 'sig123',
      };

      appsRepositoryStub.getPermanentMessage.resolves({ hash: 'hash123' });
      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves(null);

      const result = await messageStore.storeAppTemporaryMessage(message);

      expect(result).to.equal(false);
      expect(dbHelperStub.insertOneToDatabase.called).to.be.false;
    });

    it('should return false if message already exists in temporary storage', async () => {
      const message = {
        type: 'fluxappregister',
        version: 1,
        appSpecifications: { name: 'test' },
        hash: 'hash123',
        timestamp: Date.now(),
        signature: 'sig123',
      };

      appsRepositoryStub.getPermanentMessage.resolves(null);
      appsRepositoryStub.getTempMessage.resolves({ hash: 'hash123' });
      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves(null);

      const result = await messageStore.storeAppTemporaryMessage(message);

      expect(result).to.equal(false);
      expect(dbHelperStub.insertOneToDatabase.called).to.be.false;
    });

    it('should store new temporary message and return rebroadcast true', async () => {
      const message = {
        type: 'fluxappregister',
        version: 1,
        appSpecifications: { name: 'test' },
        hash: 'hash123',
        timestamp: Date.now(),
        signature: 'sig123',
      };

      appsRepositoryStub.getPermanentMessage.resolves(null);
      appsRepositoryStub.getTempMessage.resolves(null);
      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves(null);
      dbHelperStub.insertOneToDatabase.resolves();

      const result = await messageStore.storeAppTemporaryMessage(message, { furtherVerification: false });

      expect(result).to.deep.equal({ rebroadcast: true });
      expect(dbHelperStub.insertOneToDatabase.calledOnce).to.be.true;
    });

    it('should return promotion info when hash is already on chain', async () => {
      const message = {
        type: 'fluxappregister',
        version: 1,
        appSpecifications: { name: 'test' },
        hash: 'hash123',
        timestamp: Date.now(),
        signature: 'sig123',
      };

      appsRepositoryStub.getPermanentMessage.resolves(null);
      appsRepositoryStub.getTempMessage.resolves(null);
      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves({
        height: 500, txid: 'txid123', value: 10000, blockTime: 1750000000,
      });
      dbHelperStub.insertOneToDatabase.resolves();

      const result = await messageStore.storeAppTemporaryMessage(message, { furtherVerification: false });

      expect(result.rebroadcast).to.equal(false);
      expect(result.promotion).to.deep.equal({
        hash: 'hash123',
        txid: 'txid123',
        height: 500,
        value: 10000,
        blockTime: 1750000000,
      });
    });

    it('should handle database errors gracefully', async () => {
      const message = {
        type: 'fluxappregister',
        version: 1,
        appSpecifications: { name: 'test' },
        hash: 'hash123',
        timestamp: Date.now(),
        signature: 'sig123',
      };
      const error = new Error('Database error');

      appsRepositoryStub.getPermanentMessage.resolves(null);
      appsRepositoryStub.getTempMessage.resolves(null);
      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves(null);
      dbHelperStub.insertOneToDatabase.rejects(error);

      try {
        await messageStore.storeAppTemporaryMessage(message, { furtherVerification: false });
        expect.fail('Should have thrown error');
      } catch (err) {
        expect(err).to.equal(error);
        expect(logStub.error.calledWith(error)).to.be.true;
      }
    });

    it('should not enforce version upgrade policy (enforced at API layer)', async () => {
      const message = {
        type: 'fluxappupdate',
        version: 1,
        appSpecifications: { name: 'test', version: 6 },
        hash: 'hash123',
        timestamp: Date.now(),
        signature: 'sig123',
      };

      appsRepositoryStub.getPermanentMessage.resolves(null);
      appsRepositoryStub.getTempMessage.resolves(null);
      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves(null);
      dbHelperStub.insertOneToDatabase.resolves();

      messageStore = proxyquire('../../ZelBack/src/services/appMessaging/messageStore', buildProxyquireStubs());

      const result = await messageStore.storeAppTemporaryMessage(message);

      expect(result).to.deep.equal({ rebroadcast: true });
      expect(dbHelperStub.insertOneToDatabase.calledOnce).to.be.true;
    });

    describe('arcane attestation gate', () => {
      // A v9 (envelope version 2) encrypted event. isEncrypted true drives the
      // gate; the decrypt branch downstream is short-circuited by isSystemSecure
      // resolving false, so these tests isolate the gate itself.
      function makeEncryptedV9Event({ version = 2, attestation = 'att-sig' } = {}) {
        const specs = { name: 'enc-app', owner: 'owner1', version: 9 };
        return {
          hash: 'enchash',
          timestamp: Date.now(),
          version,
          isEncrypted: true,
          requiresArcaneAttestation: () => version === 2,
          isRegistration: true,
          isUpdate: false,
          spec: { ...specs, serialize: () => specs },
          serialize: () => ({
            type: 'fluxappregister',
            version,
            appSpecifications: specs,
            hash: 'enchash',
            timestamp: Date.now(),
            signature: 'sig',
            contentHash: 'deadbeef',
            extend: false,
            arcaneAttestation: attestation,
          }),
        };
      }

      const encryptedMessage = {
        type: 'fluxappregister',
        version: 2,
        appSpecifications: { name: 'enc-app', cipher: 'xxx' },
        hash: 'enchash',
        timestamp: Date.now(),
        signature: 'sig',
      };

      function buildWithSystemSecure(secure) {
        return proxyquire(
          '../../ZelBack/src/services/appMessaging/messageStore',
          buildProxyquireStubs({
            '../benchmarkService': { isSystemSecure: sinon.stub().resolves(secure) },
          }),
        );
      }

      beforeEach(() => {
        appsRepositoryStub.getPermanentMessage.resolves(null);
        appsRepositoryStub.getTempMessage.resolves(null);
        const mockDb = { db: sinon.stub().returns('database') };
        dbHelperStub.databaseConnection.returns(mockDb);
        dbHelperStub.findOneInDatabase.resolves(null);
        dbHelperStub.insertOneToDatabase.resolves();
      });

      it('rejects an encrypted v9 message with a missing or invalid attestation', async () => {
        appEventVerifierStub.deserializeTempMessage.resolves(makeEncryptedV9Event());
        appEventVerifierStub.verifyAttestation.returns(false);
        messageStore = buildWithSystemSecure(false);

        const result = await messageStore.storeAppTemporaryMessage(encryptedMessage);

        expect(result).to.be.instanceOf(Error);
        expect(result.message).to.include('arcane attestation');
        expect(dbHelperStub.insertOneToDatabase.called).to.be.false;
      });

      it('stores an encrypted v9 message carrying a valid attestation', async () => {
        appEventVerifierStub.deserializeTempMessage.resolves(makeEncryptedV9Event());
        appEventVerifierStub.verifyAttestation.returns(true);
        messageStore = buildWithSystemSecure(false);

        const result = await messageStore.storeAppTemporaryMessage(encryptedMessage);

        expect(result).to.deep.equal({ rebroadcast: true });
        expect(appEventVerifierStub.verifyAttestation.calledOnce).to.be.true;
        const stored = dbHelperStub.insertOneToDatabase.firstCall.args[2];
        expect(stored.arcaneAttestation).to.equal('att-sig');
      });

      it('does not subject a v8 (envelope version 1) encrypted message to the gate', async () => {
        // Legacy enterprise apps predate attestation and aren't born attested;
        // AppEventLegacy has no verifyArcaneAttestation, so the gate must skip them.
        appEventVerifierStub.deserializeTempMessage.resolves(makeEncryptedV9Event({ version: 1, attestation: undefined }));
        appEventVerifierStub.verifyAttestation.returns(false);
        messageStore = buildWithSystemSecure(false);

        const result = await messageStore.storeAppTemporaryMessage({ ...encryptedMessage, version: 1 });

        expect(result).to.deep.equal({ rebroadcast: true });
        expect(appEventVerifierStub.verifyAttestation.called).to.be.false;
        expect(dbHelperStub.insertOneToDatabase.calledOnce).to.be.true;
      });
    });
  });

  describe('storeAppPermanentMessage', () => {
    it('should throw error for invalid message structure', async () => {
      const invalidMessage = { type: 'test' };

      try {
        await messageStore.storeAppPermanentMessage(invalidMessage);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Invalid Flux App message');
      }
    });

    it('should store valid permanent message', async () => {
      const message = {
        type: 'fluxappregister',
        version: 1,
        appSpecifications: { name: 'test' },
        hash: 'hash123',
        timestamp: Date.now(),
        signature: 'sig123',
        txid: 'txid123',
        height: 1000,
        valueSat: 10000,
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.insertOneToDatabase.resolves();

      const result = await messageStore.storeAppPermanentMessage(message);

      expect(result).to.be.true;
      expect(dbHelperStub.insertOneToDatabase.calledOnce).to.be.true;
    });
  });

  describe('storeAppRunningMessage', () => {
    it('should return error for invalid message structure', async () => {
      const invalidMessage = { type: 'fluxapprunning' };

      const result = await messageStore.storeAppRunningMessage(invalidMessage);

      expect(result).to.be.instanceOf(Error);
      expect(result.message).to.include('Invalid Flux App Running message');
    });

    it('should return error for unsupported version', async () => {
      const message = {
        type: 'fluxapprunning',
        version: 99,
        broadcastedAt: Date.now(),
        ip: '192.168.1.1',
      };

      const result = await messageStore.storeAppRunningMessage(message);

      expect(result).to.be.instanceOf(Error);
      expect(result.message).to.include('version 99 not supported');
    });

    it('should return false for expired message', async () => {
      const message = {
        type: 'fluxapprunning',
        version: 1,
        name: 'testapp',
        hash: 'hash123',
        broadcastedAt: Date.now() - (200 * 60 * 1000), // 200 minutes ago
        ip: '192.168.1.1',
      };

      const result = await messageStore.storeAppRunningMessage(message);

      expect(result).to.deep.equal({ stored: false, rebroadcast: false });
      expect(logStub.warn.called).to.be.true;
    });

    it('should store valid version 1 running message', async () => {
      const message = {
        type: 'fluxapprunning',
        version: 1,
        name: 'testapp',
        hash: 'hash123',
        broadcastedAt: Date.now(),
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.updateOneInDatabase.resolves({ modifiedCount: 0, upsertedCount: 1 });
      dbHelperStub.removeDocumentsFromCollection.resolves();

      const result = await messageStore.storeAppRunningMessage(message);

      expect(result).to.deep.equal({ stored: true, rebroadcast: true });
      expect(dbHelperStub.updateOneInDatabase.calledOnce).to.be.true;
    });

    it('should store valid version 2 running message with multiple apps', async () => {
      const message = {
        type: 'fluxapprunning',
        version: 2,
        apps: [
          { name: 'app1', hash: 'hash1' },
          { name: 'app2', hash: 'hash2' },
        ],
        broadcastedAt: Date.now(),
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.updateOneInDatabase.resolves({ modifiedCount: 0, upsertedCount: 1 });
      dbHelperStub.removeDocumentsFromCollection.resolves();

      const result = await messageStore.storeAppRunningMessage(message);

      expect(result).to.deep.equal({ stored: true, rebroadcast: true });
      expect(dbHelperStub.updateOneInDatabase.callCount).to.equal(2);
      // Should clean up installing records for each app (location + broadcast per app)
      expect(dbHelperStub.removeDocumentsFromCollection.callCount).to.equal(4);
    });

    it('a replica-tagged running entry releases only its own claim row and archived announce', async () => {
      const message = {
        type: 'fluxapprunning',
        version: 2,
        apps: [{ name: 'app1', hash: 'hash1', replica: 's1' }],
        broadcastedAt: Date.now(),
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.updateOneInDatabase.resolves({ modifiedCount: 0, upsertedCount: 1 });
      dbHelperStub.removeDocumentsFromCollection.resolves();

      const result = await messageStore.storeAppRunningMessage(message);

      expect(result).to.deep.equal({ stored: true, rebroadcast: true });
      // The sibling replica's claim (location row AND archived announce) must survive
      // s1 starting to run, or message sync would strip its seat mid-install.
      expect(dbHelperStub.removeDocumentsFromCollection.firstCall.args[2]).to.deep.equal({
        name: 'app1', ip: '192.168.1.1', replica: 's1',
      });
      expect(dbHelperStub.removeDocumentsFromCollection.secondCall.args[2]).to.deep.equal({
        'data.name': 'app1', 'data.ip': '192.168.1.1', 'data.replica': 's1',
      });
    });

    it('should handle version 2 message with empty apps array', async () => {
      const message = {
        type: 'fluxapprunning',
        version: 2,
        apps: [],
        broadcastedAt: Date.now(),
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findInDatabase.resolves([{ name: 'app1' }]);
      dbHelperStub.removeDocumentsFromCollection.resolves();

      const result = await messageStore.storeAppRunningMessage(message);

      expect(result).to.deep.equal({ stored: true, rebroadcast: true });
      // Called three times: locations, installing locations, installing broadcasts
      expect(dbHelperStub.removeDocumentsFromCollection.callCount).to.equal(3);
    });
  });

  describe('storeAppInstallingMessage', () => {
    it('should return error for invalid message structure', async () => {
      const invalidMessage = { type: 'fluxappinstalling' };

      const result = await messageStore.storeAppInstallingMessage(invalidMessage);

      expect(result).to.be.instanceOf(Error);
      expect(result.message).to.include('Invalid Flux App Installing message');
    });

    it('should return error for unsupported version', async () => {
      const message = {
        type: 'fluxappinstalling',
        version: 3,
        name: 'testapp',
        broadcastedAt: Date.now(),
        ip: '192.168.1.1',
      };

      const result = await messageStore.storeAppInstallingMessage(message);

      expect(result).to.be.instanceOf(Error);
      expect(result.message).to.include('version 3 not supported');
    });

    it('should return error for version 2 without announcedAt', async () => {
      const message = {
        type: 'fluxappinstalling',
        version: 2,
        name: 'testapp',
        broadcastedAt: Date.now(),
        ip: '192.168.1.1',
      };

      const result = await messageStore.storeAppInstallingMessage(message);

      expect(result).to.be.instanceOf(Error);
      expect(result.message).to.include('announcedAt required for version 2');
    });

    it('should store valid installing message', async () => {
      const message = {
        type: 'fluxappinstalling',
        version: 1,
        name: 'testapp',
        broadcastedAt: Date.now(),
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves(null);
      dbHelperStub.updateOneInDatabase.resolves();

      const result = await messageStore.storeAppInstallingMessage(message);

      expect(result).to.be.true;
      expect(dbHelperStub.updateOneInDatabase.calledOnce).to.be.true;
    });

    it('should store version 2 message with announcedAt on the row', async () => {
      const broadcastedAt = Date.now();
      const announcedAt = broadcastedAt - 1000;
      const message = {
        type: 'fluxappinstalling',
        version: 2,
        name: 'testapp',
        announcedAt,
        broadcastedAt,
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves(null);
      dbHelperStub.updateOneInDatabase.resolves();

      const result = await messageStore.storeAppInstallingMessage(message);

      expect(result).to.be.true;
      const setDoc = dbHelperStub.updateOneInDatabase.firstCall.args[3].$set;
      expect(setDoc.announcedAt).to.deep.equal(new Date(announcedAt));
      expect(setDoc.broadcastedAt).to.deep.equal(new Date(broadcastedAt));
      expect(setDoc.expireAt).to.deep.equal(new Date(broadcastedAt + 15 * 60 * 1000));
    });

    it('keys the claim row by replica: a tagged claim upserts (name, ip, replica)', async () => {
      const broadcastedAt = Date.now();
      const message = {
        type: 'fluxappinstalling',
        version: 2,
        name: 'testapp',
        replica: 's1',
        announcedAt: broadcastedAt,
        broadcastedAt,
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves(null);
      dbHelperStub.updateOneInDatabase.resolves();

      const result = await messageStore.storeAppInstallingMessage(message);

      expect(result).to.be.true;
      expect(dbHelperStub.findOneInDatabase.firstCall.args[2]).to.deep.equal({ name: 'testapp', ip: '192.168.1.1', replica: 's1' });
      expect(dbHelperStub.updateOneInDatabase.firstCall.args[2]).to.deep.equal({ name: 'testapp', ip: '192.168.1.1', replica: 's1' });
      expect(dbHelperStub.updateOneInDatabase.firstCall.args[3].$set.replica).to.equal('s1');
    });

    it('an untagged claim keys replica null (matches legacy rows without the field)', async () => {
      const broadcastedAt = Date.now();
      const message = {
        type: 'fluxappinstalling',
        version: 2,
        name: 'testapp',
        announcedAt: broadcastedAt,
        broadcastedAt,
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves(null);
      dbHelperStub.updateOneInDatabase.resolves();

      const result = await messageStore.storeAppInstallingMessage(message);

      expect(result).to.be.true;
      expect(dbHelperStub.updateOneInDatabase.firstCall.args[2]).to.deep.equal({ name: 'testapp', ip: '192.168.1.1', replica: null });
      expect(dbHelperStub.updateOneInDatabase.firstCall.args[3].$set.replica).to.equal(null);
    });

    it('should refresh the row on a renewal (newer broadcastedAt, same announcedAt)', async () => {
      const announcedAt = Date.now() - 10 * 60 * 1000;
      const broadcastedAt = Date.now();
      const message = {
        type: 'fluxappinstalling',
        version: 2,
        name: 'testapp',
        announcedAt,
        broadcastedAt,
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves({
        name: 'testapp', ip: '192.168.1.1', announcedAt: new Date(announcedAt), broadcastedAt: new Date(announcedAt),
      });
      dbHelperStub.updateOneInDatabase.resolves();

      const result = await messageStore.storeAppInstallingMessage(message);

      expect(result).to.be.true;
      const setDoc = dbHelperStub.updateOneInDatabase.firstCall.args[3].$set;
      expect(setDoc.announcedAt).to.deep.equal(new Date(announcedAt));
      expect(setDoc.expireAt).to.deep.equal(new Date(broadcastedAt + 15 * 60 * 1000));
    });

    it('should reject a duplicate or older message than the stored row', async () => {
      const broadcastedAt = Date.now();
      const message = {
        type: 'fluxappinstalling',
        version: 2,
        name: 'testapp',
        announcedAt: broadcastedAt,
        broadcastedAt,
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves({
        name: 'testapp', ip: '192.168.1.1', broadcastedAt: new Date(broadcastedAt + 5000),
      });

      const result = await messageStore.storeAppInstallingMessage(message);

      expect(result).to.be.false;
      expect(dbHelperStub.updateOneInDatabase.called).to.be.false;
    });

    it('should delete the row and archived broadcast on cleared', async () => {
      const broadcastedAt = Date.now();
      const message = {
        type: 'fluxappinstalling',
        version: 2,
        name: 'testapp',
        cleared: true,
        broadcastedAt,
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findInDatabase.resolves([{ broadcastedAt: new Date(broadcastedAt - 60 * 1000) }]);
      dbHelperStub.removeDocumentsFromCollection.resolves();

      const result = await messageStore.storeAppInstallingMessage(message);

      expect(result).to.be.true;
      expect(dbHelperStub.updateOneInDatabase.called).to.be.false;
      expect(dbHelperStub.removeDocumentsFromCollection.calledTwice).to.be.true;
      expect(dbHelperStub.removeDocumentsFromCollection.firstCall.args[1]).to.equal('appsInstallingLocations');
      // An untagged clear releases EVERY (name, ip) row - the v1/loose whole-app semantics.
      expect(dbHelperStub.removeDocumentsFromCollection.firstCall.args[2]).to.deep.equal({ name: 'testapp', ip: '192.168.1.1' });
      expect(dbHelperStub.removeDocumentsFromCollection.secondCall.args[2]).to.deep.equal({ 'data.name': 'testapp', 'data.ip': '192.168.1.1' });
    });

    it('a tagged clear releases exactly its replica row and archived announce', async () => {
      const broadcastedAt = Date.now();
      const message = {
        type: 'fluxappinstalling',
        version: 2,
        name: 'testapp',
        replica: 's1',
        cleared: true,
        broadcastedAt,
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findInDatabase.resolves([]);
      dbHelperStub.removeDocumentsFromCollection.resolves();

      const result = await messageStore.storeAppInstallingMessage(message);

      expect(result).to.be.true;
      expect(dbHelperStub.removeDocumentsFromCollection.firstCall.args[2]).to.deep.equal({ name: 'testapp', ip: '192.168.1.1', replica: 's1' });
      expect(dbHelperStub.removeDocumentsFromCollection.secondCall.args[2]).to.deep.equal({ 'data.name': 'testapp', 'data.ip': '192.168.1.1', 'data.replica': 's1' });
    });

    it('should ignore a stale cleared that arrives after a newer announce', async () => {
      const broadcastedAt = Date.now() - 60 * 1000;
      const message = {
        type: 'fluxappinstalling',
        version: 2,
        name: 'testapp',
        cleared: true,
        broadcastedAt,
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findInDatabase.resolves([{ broadcastedAt: new Date(broadcastedAt + 30 * 1000) }]);

      const result = await messageStore.storeAppInstallingMessage(message);

      expect(result).to.be.false;
      expect(dbHelperStub.removeDocumentsFromCollection.called).to.be.false;
    });

    it('should relay a cleared with no stored row (peers may still hold one)', async () => {
      const message = {
        type: 'fluxappinstalling',
        version: 2,
        name: 'testapp',
        cleared: true,
        broadcastedAt: Date.now(),
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findInDatabase.resolves([]);
      dbHelperStub.removeDocumentsFromCollection.resolves();

      const result = await messageStore.storeAppInstallingMessage(message);

      expect(result).to.be.true;
      expect(dbHelperStub.removeDocumentsFromCollection.calledTwice).to.be.true;
    });
  });

  describe('storeSignedAppInstallingBroadcast', () => {
    it('should archive a normal installing broadcast', async () => {
      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.updateOneInDatabase.resolves();

      await messageStore.storeSignedAppInstallingBroadcast({
        version: 1,
        timestamp: Date.now(),
        pubKey: 'pub',
        signature: 'sig',
        data: { name: 'testapp', ip: '192.168.1.1', broadcastedAt: Date.now() },
      });

      expect(dbHelperStub.updateOneInDatabase.calledOnce).to.be.true;
      expect(dbHelperStub.updateOneInDatabase.firstCall.args[2]).to.deep.equal({
        'data.name': 'testapp', 'data.ip': '192.168.1.1', 'data.replica': null,
      });
    });

    it('archives one announce per claim identity (data.replica in the key)', async () => {
      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.updateOneInDatabase.resolves();

      await messageStore.storeSignedAppInstallingBroadcast({
        version: 1,
        timestamp: Date.now(),
        pubKey: 'pub',
        signature: 'sig',
        data: { name: 'testapp', ip: '192.168.1.1', replica: 's2', broadcastedAt: Date.now() },
      });

      expect(dbHelperStub.updateOneInDatabase.firstCall.args[2]).to.deep.equal({
        'data.name': 'testapp', 'data.ip': '192.168.1.1', 'data.replica': 's2',
      });
    });

    it('should not archive a cleared broadcast', async () => {
      await messageStore.storeSignedAppInstallingBroadcast({
        version: 1,
        timestamp: Date.now(),
        pubKey: 'pub',
        signature: 'sig',
        data: { name: 'testapp', ip: '192.168.1.1', broadcastedAt: Date.now(), cleared: true },
      });

      expect(dbHelperStub.updateOneInDatabase.called).to.be.false;
    });
  });

  describe('storeBatchAppInstallingMessages', () => {
    it('hash-sync intake keys archive and location rows per claim identity', async () => {
      const broadcastedAt = Date.now();
      const bulkWriteStub = sinon.stub().resolves();
      const mockDatabase = { collection: sinon.stub().returns({ bulkWrite: bulkWriteStub }) };
      const mockDb = { db: sinon.stub().returns(mockDatabase) };
      dbHelperStub.databaseConnection.returns(mockDb);

      const result = await messageStore.storeBatchAppInstallingMessages([{
        version: 1,
        timestamp: broadcastedAt,
        pubKey: 'pub',
        signature: 'sig',
        receivedAt: broadcastedAt,
        data: {
          name: 'testapp', ip: '192.168.1.1', replica: 's1', announcedAt: broadcastedAt, broadcastedAt,
        },
      }]);

      expect(result).to.deep.equal({ stored: 1 });
      const signedOps = bulkWriteStub.firstCall.args[0];
      expect(signedOps[0].updateOne.filter).to.deep.equal({
        'data.name': 'testapp', 'data.ip': '192.168.1.1', 'data.replica': 's1',
      });
      const locationOps = bulkWriteStub.secondCall.args[0];
      expect(locationOps[0].updateOne.filter).to.deep.equal({
        name: 'testapp', ip: '192.168.1.1', replica: 's1',
      });
      expect(locationOps[0].updateOne.update[0].$set.replica).to.equal('s1');
      // Elections rank on announcedAt; a sync intake that dropped it would
      // silently reorder contenders on freshly synced nodes.
      expect(locationOps[0].updateOne.update[0].$set.announcedAt).to.exist;
    });
  });

  describe('storeAppRemovedMessage', () => {
    it('should return error for invalid message structure', async () => {
      const invalidMessage = { type: 'fluxappremoved' };

      const result = await messageStore.storeAppRemovedMessage(invalidMessage);

      expect(result).to.be.instanceOf(Error);
      expect(result.message).to.include('Invalid Flux App Removed message');
    });

    it('should return error for empty appName', async () => {
      const message = {
        type: 'fluxappremoved',
        version: 1,
        appName: '',
        broadcastedAt: Date.now(),
        ip: '192.168.1.1',
      };

      const result = await messageStore.storeAppRemovedMessage(message);

      expect(result).to.be.instanceOf(Error);
      expect(result.message).to.include('appName cannot be empty');
    });

    it('should store valid removed message and delete location', async () => {
      const message = {
        type: 'fluxappremoved',
        version: 1,
        appName: 'testapp',
        broadcastedAt: Date.now(),
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneAndDeleteInDatabase.resolves();

      const result = await messageStore.storeAppRemovedMessage(message);

      expect(result).to.be.true;
      // An untagged removal clears EVERY row the node held for the app (a
      // co-located pair has one row per replica).
      expect(dbHelperStub.removeDocumentsFromCollection.calledOnce).to.be.true;
      expect(dbHelperStub.removeDocumentsFromCollection.firstCall.args[2]).to.deep.equal({
        ip: '192.168.1.1', name: 'testapp',
      });
    });
  });

  describe('storeAppInstallingErrorMessage', () => {
    it('should return error for invalid message structure', async () => {
      const invalidMessage = { type: 'fluxappinstallingerror' };

      const result = await messageStore.storeAppInstallingErrorMessage(invalidMessage);

      expect(result).to.be.instanceOf(Error);
      expect(result.message).to.include('Invalid Flux App Installing Error message');
    });

    it('should store valid error message and clean up installing record', async () => {
      const message = {
        type: 'fluxappinstallingerror',
        version: 1,
        name: 'testapp',
        hash: 'hash123',
        ip: '192.168.1.1',
        error: 'Installation failed',
        broadcastedAt: Date.now(),
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves(null);
      dbHelperStub.updateOneInDatabase.resolves();
      dbHelperStub.removeDocumentsFromCollection.resolves();
      dbHelperStub.countInDatabase.resolves(1);

      const result = await messageStore.storeAppInstallingErrorMessage(message);

      expect(result).to.be.true;
      expect(dbHelperStub.updateOneInDatabase.calledOnce).to.be.true;
      // Should clean up installing record since installation failed (location + broadcast)
      expect(dbHelperStub.removeDocumentsFromCollection.callCount).to.equal(2);
      expect(dbHelperStub.removeDocumentsFromCollection.calledWith(
        'database',
        'appsInstallingLocations',
        { name: 'testapp', ip: '192.168.1.1' },
      )).to.be.true;
    });

    it('should update cache settings when error count reaches threshold', async () => {
      const message = {
        type: 'fluxappinstallingerror',
        version: 1,
        name: 'testapp',
        hash: 'hash123',
        ip: '192.168.1.1',
        error: 'Installation failed',
        broadcastedAt: Date.now(),
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves(null);
      dbHelperStub.updateOneInDatabase.resolves();
      dbHelperStub.removeDocumentsFromCollection.resolves();
      dbHelperStub.countInDatabase.resolves(5);
      dbHelperStub.updateInDatabase.resolves();

      const result = await messageStore.storeAppInstallingErrorMessage(message);

      expect(result).to.be.true;
      expect(dbHelperStub.removeDocumentsFromCollection.callCount).to.equal(2);
    });
  });

  describe('storeIPChangedMessage', () => {
    it('should return error for invalid message structure', async () => {
      const invalidMessage = { type: 'fluxipchanged' };

      const result = await messageStore.storeIPChangedMessage(invalidMessage);

      expect(result).to.be.instanceOf(Error);
      expect(result.message).to.include('Invalid Flux IP Changed message');
    });

    it('should return error for empty IPs', async () => {
      const message = {
        type: 'fluxipchanged',
        version: 1,
        oldIP: '',
        newIP: '',
        broadcastedAt: Date.now(),
      };

      const result = await messageStore.storeIPChangedMessage(message);

      expect(result).to.be.instanceOf(Error);
      expect(result.message).to.include('oldIP and newIP cannot be empty');
    });

    it('should return error when oldIP equals newIP', async () => {
      const message = {
        type: 'fluxipchanged',
        version: 1,
        oldIP: '192.168.1.1',
        newIP: '192.168.1.1',
        broadcastedAt: Date.now(),
      };

      const result = await messageStore.storeIPChangedMessage(message);

      expect(result).to.be.instanceOf(Error);
      expect(result.message).to.include('oldIP and newIP are the same');
    });

    it('should store valid IP changed message', async () => {
      const message = {
        type: 'fluxipchanged',
        version: 1,
        oldIP: '192.168.1.1',
        newIP: '192.168.1.2',
        broadcastedAt: Date.now(),
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.updateInDatabase.resolves();

      const result = await messageStore.storeIPChangedMessage(message);

      expect(result).to.be.true;
      expect(dbHelperStub.updateInDatabase.calledOnce).to.be.true;
    });
  });

  describe('storeAppStateEvent', () => {
    let collectionStub;

    beforeEach(() => {
      collectionStub = { updateOne: sinon.stub().resolves({ modifiedCount: 1 }) };
      const mockDb = { db: sinon.stub().returns({ collection: sinon.stub().returns(collectionStub) }) };
      dbHelperStub.databaseConnection.returns(mockDb);
    });

    it('should store apprunning v2 event with correct dedupKey', async () => {
      const payload = {
        signedBroadcast: {
          version: 1, timestamp: Date.now(), pubKey: 'pk', signature: 'sig',
          data: { ip: '1.2.3.4', broadcastedAt: Date.now(), apps: [{ name: 'a', hash: 'h' }] },
        },
      };
      await messageStore.storeAppStateEvent(messageStore.APP_STATE_EVENT_TYPES.APPRUNNING, payload);
      expect(collectionStub.updateOne.calledOnce).to.be.true;
      const filter = collectionStub.updateOne.firstCall.args[0];
      expect(filter.ip).to.equal('1.2.3.4');
      expect(filter.type).to.equal('apprunning');
      expect(filter.dedupKey).to.equal('v2');
    });

    it('should store apprunning v1 event with name in dedupKey', async () => {
      const payload = {
        signedBroadcast: {
          version: 1, timestamp: Date.now(), pubKey: 'pk', signature: 'sig',
          data: { ip: '1.2.3.4', broadcastedAt: Date.now(), name: 'myapp', hash: 'h' },
        },
      };
      await messageStore.storeAppStateEvent(messageStore.APP_STATE_EVENT_TYPES.APPRUNNING, payload);
      expect(collectionStub.updateOne.calledOnce).to.be.true;
      const filter = collectionStub.updateOne.firstCall.args[0];
      expect(filter.dedupKey).to.equal('v1:myapp');
    });

    it('should store sigterm event', async () => {
      await messageStore.storeAppStateEvent(messageStore.APP_STATE_EVENT_TYPES.SIGTERM, {
        message: { type: 'fluxnodesigterm', version: 1, ip: '1.2.3.4', broadcastedAt: Date.now() },
        envelope: { version: 1, timestamp: Date.now(), pubKey: 'pk', signature: 'sig' },
      });
      expect(collectionStub.updateOne.calledOnce).to.be.true;
      const filter = collectionStub.updateOne.firstCall.args[0];
      expect(filter.type).to.equal('sigterm');
      expect(filter.dedupKey).to.equal('sigterm');
    });

    it('should store appremoved event', async () => {
      await messageStore.storeAppStateEvent(messageStore.APP_STATE_EVENT_TYPES.APPREMOVED, {
        message: { ip: '1.2.3.4', appName: 'myapp', broadcastedAt: Date.now() },
        envelope: { version: 1, timestamp: Date.now(), pubKey: 'pk', signature: 'sig' },
      });
      expect(collectionStub.updateOne.calledOnce).to.be.true;
      const filter = collectionStub.updateOne.firstCall.args[0];
      expect(filter.type).to.equal('appremoved');
      expect(filter.dedupKey).to.equal('appremoved:myapp');
    });

    it('should store evicted event with createdAt', async () => {
      await messageStore.storeAppStateEvent(messageStore.APP_STATE_EVENT_TYPES.EVICTED, { ip: '1.2.3.4' });
      expect(collectionStub.updateOne.calledOnce).to.be.true;
      const filter = collectionStub.updateOne.firstCall.args[0];
      expect(filter.type).to.equal('evicted');
      expect(filter.dedupKey).to.equal('evicted');
      const update = collectionStub.updateOne.firstCall.args[1];
      expect(update.$set.createdAt).to.be.instanceOf(Date);
    });

    it('should reject expired apprunning events', async () => {
      const payload = {
        signedBroadcast: {
          version: 1, timestamp: Date.now(), pubKey: 'pk', signature: 'sig',
          data: { ip: '1.2.3.4', broadcastedAt: Date.now() - (130 * 60 * 1000), apps: [{ name: 'a', hash: 'h' }] },
        },
      };
      await messageStore.storeAppStateEvent(messageStore.APP_STATE_EVENT_TYPES.APPRUNNING, payload);
      expect(collectionStub.updateOne.called).to.be.false;
    });
  });
});
