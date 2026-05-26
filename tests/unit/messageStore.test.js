const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

// Round-trip stub for the specCutover seam: deserializeSubmission echoes
// the input as a minimal class-like object; serialize/decrypt round-trip
// back to the same blob. Enough to satisfy messageStore without pulling
// real flux-spec into the unit tests.
function buildCutoverStubs() {
  const makeWireSpec = (blob) => ({
    version: blob.version,
    name: blob.name,
    owner: blob.owner,
    enterprise: blob.enterprise,
    serialize: () => blob,
    toEncryptedSpec: () => ({
      decrypt: async () => ({ spec: { serialize: () => blob } }),
    }),
  });
  return {
    deserializeSpec: sinon.stub().callsFake(async (blob) => makeWireSpec(blob)),
    decryptIfEnterprise: sinon.stub().callsFake(async (blob) => blob),
    decryptStoredSpec: sinon.stub().callsFake(async (blob) => blob),
  };
}

describe('messageStore tests', () => {
  let messageStore;
  let dbHelperStub;
  let serviceHelperStub;

  let logStub;
  let configStub;
  let appsRepositoryStub;

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

    serviceHelperStub = {
      ensureNumber: sinon.stub().returnsArg(0),
    };

    logStub = {
      error: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
    };

    appsRepositoryStub = {
      getPermanentMessage: sinon.stub(),
      getTempMessage: sinon.stub(),
      getAppLocation: sinon.stub().resolves(null),
      upsertLocation: sinon.stub().resolves(),
      listAppNamesOnIp: sinon.stub().resolves([]),
      removeLocationsByIp: sinon.stub().resolves(),
      removeInstallingLocation: sinon.stub().resolves(),
      removeLocation: sinon.stub().resolves(),
      updateLocationIp: sinon.stub().resolves(),
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
          },
        },
      },
    };

    // Proxy require
    const cutoverStubs = buildCutoverStubs();
    messageStore = proxyquire('../../ZelBack/src/services/appMessaging/messageStore', {
      config: configStub,
      '../dbHelper': dbHelperStub,
      '../serviceHelper': serviceHelperStub,
      '../appDatabase/appsRepository': appsRepositoryStub,
      './appEventVerifier': {
        deserializeMessage: sinon.stub().resolves({}),
        instantiatePreviousSpec: sinon.stub().resolves(null),
        authorize: sinon.stub().resolves({ valid: true, signer: 'owner1' }),
      },
      '../utils/specLibs': {
        validateSubmissionSpec: sinon.stub().resolves(true),
        getSpec: sinon.stub().resolves({ UpdatePolicy: { assertCompatible: sinon.stub() } }),
        getSpecBackend: sinon.stub().resolves({ EncryptedSpecBase: class EncryptedSpecBase {} }),
      },
      '../utils/specCutover': cutoverStubs,
      '../providers/FluxOSLegacyCryptoProvider': {
        create: sinon.stub().resolves({
          decrypt: sinon.stub().resolves(Buffer.from('{}')),
        }),
      },
      '../../lib/log': logStub,
      '../daemonService/daemonServiceMiscRpcs': {
        isDaemonSynced: sinon.stub().returns({ data: { height: 1000 } }),
      },
      '../appDatabase/registryManager': {
        checkApplicationRegistrationNameConflicts: sinon.stub().resolves(),
      },
      '../appLifecycle/advancedWorkflows': {
        validateApplicationUpdateCompatibility: sinon.stub().resolves(),
        getPreviousAppSpecifications: sinon.stub().resolves({ owner: 'owner1' }),
      },
      '../utils/appConstants': {
        globalAppsMessages: 'appsMessages',
        globalAppsTempMessages: 'appsTempMessages',
        globalAppsLocations: 'appsLocations',
        globalAppsInstallingLocations: 'appsInstallingLocations',
        globalAppsInstallingErrorsLocations: 'appsInstallingErrorsLocations',
        appsHashesCollection: 'appsHashes',
      },
      '../appDatabase/appsRepository': appsRepositoryStub,
    });
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
        appSpecifications: { name: 'test', version: 1 },
        hash: 'hash123',
        timestamp: Date.now(),
        signature: 'sig123',
      };

      appsRepositoryStub.getPermanentMessage.resolves({ hash: 'hash123' });
      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves(null);

      const result = await messageStore.storeAppTemporaryMessage(message);

      expect(result).to.be.false;
      expect(dbHelperStub.insertOneToDatabase.called).to.be.false;
    });

    it('should return false if message already exists in temporary storage', async () => {
      const message = {
        type: 'fluxappregister',
        version: 1,
        appSpecifications: { name: 'test', version: 1 },
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

      expect(result).to.be.false;
      expect(dbHelperStub.insertOneToDatabase.called).to.be.false;
    });

    it('should store new temporary message and return true', async () => {
      const message = {
        type: 'fluxappregister',
        version: 1,
        appSpecifications: { name: 'test', version: 1 },
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

      expect(result).to.be.true;
      expect(dbHelperStub.insertOneToDatabase.calledOnce).to.be.true;
    });

    it('should handle database errors gracefully', async () => {
      const message = {
        type: 'fluxappregister',
        version: 1,
        appSpecifications: { name: 'test', version: 1 },
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

      const localCutoverStubs = buildCutoverStubs();
      messageStore = proxyquire('../../ZelBack/src/services/appMessaging/messageStore', {
        config: configStub,
        '../dbHelper': dbHelperStub,
        '../serviceHelper': serviceHelperStub,
        '../appDatabase/appsRepository': appsRepositoryStub,
        './appEventVerifier': {
          deserializeMessage: sinon.stub().resolves({}),
          instantiatePreviousSpec: sinon.stub().resolves(null),
          authorize: sinon.stub().resolves({ valid: true, signer: 'owner1' }),
        },
        '../utils/specLibs': {
          validateSubmissionSpec: sinon.stub().resolves(true),
          getSpec: sinon.stub().resolves({ UpdatePolicy: { assertCompatible: sinon.stub() } }),
          getSpecBackend: sinon.stub().resolves({ EncryptedSpecBase: class EncryptedSpecBase {} }),
        },
        '../utils/specCutover': localCutoverStubs,
        '../providers/FluxOSLegacyCryptoProvider': {
          create: sinon.stub().resolves({
            decrypt: sinon.stub().resolves(Buffer.from('{}')),
          }),
        },
        '../../lib/log': logStub,
        '../daemonService/daemonServiceMiscRpcs': {
          isDaemonSynced: sinon.stub().returns({ data: { height: 1000 } }),
        },
        '../appDatabase/registryManager': {
          checkApplicationRegistrationNameConflicts: sinon.stub().resolves(),
        },
        '../appDatabase/appSpecHistory': {
          getPreviousAppSpecifications: sinon.stub().resolves({ owner: 'owner1', version: 5 }),
        },
        '../utils/globalState': {
          queuePendingUpdate: sinon.stub(),
        },
        '../utils/appConstants': {
          globalAppsMessages: 'appsMessages',
          globalAppsTempMessages: 'appsTempMessages',
          globalAppsLocations: 'appsLocations',
          globalAppsInstallingLocations: 'appsInstallingLocations',
          globalAppsInstallingErrorsLocations: 'appsInstallingErrorsLocations',
          appsHashesCollection: 'appsHashes',
        },
      });

      // v5→v6 update should be accepted — version policy is enforced at API layer, not here
      const result = await messageStore.storeAppTemporaryMessage(message);

      expect(result).to.be.true;
      expect(dbHelperStub.insertOneToDatabase.calledOnce).to.be.true;
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
        appSpecifications: { name: 'test', version: 1 },
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

      expect(result).to.be.false;
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

      const result = await messageStore.storeAppRunningMessage(message);

      expect(result).to.be.true;
      expect(appsRepositoryStub.upsertLocation.calledOnce).to.be.true;
      expect(appsRepositoryStub.removeInstallingLocation.calledOnce).to.be.true;
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

      const result = await messageStore.storeAppRunningMessage(message);

      expect(result).to.be.true;
      expect(appsRepositoryStub.upsertLocation.callCount).to.equal(2);
    });

    it('should handle version 2 message with empty apps array', async () => {
      const message = {
        type: 'fluxapprunning',
        version: 2,
        apps: [],
        broadcastedAt: Date.now(),
        ip: '192.168.1.1',
      };

      appsRepositoryStub.listAppNamesOnIp.resolves(['app1']);

      const result = await messageStore.storeAppRunningMessage(message);

      expect(result).to.be.true;
      expect(appsRepositoryStub.removeLocationsByIp.calledOnce).to.be.true;
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
        version: 2,
        name: 'testapp',
        broadcastedAt: Date.now(),
        ip: '192.168.1.1',
      };

      const result = await messageStore.storeAppInstallingMessage(message);

      expect(result).to.be.instanceOf(Error);
      expect(result.message).to.include('version 2 not supported');
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

    it('should store valid removed message', async () => {
      const message = {
        type: 'fluxappremoved',
        version: 1,
        appName: 'testapp',
        broadcastedAt: Date.now(),
        ip: '192.168.1.1',
      };

      const result = await messageStore.storeAppRemovedMessage(message);

      expect(result).to.be.true;
      expect(appsRepositoryStub.removeLocation.calledOnce).to.be.true;
      expect(appsRepositoryStub.removeLocation.firstCall.args[0]).to.equal('testapp');
      expect(appsRepositoryStub.removeLocation.firstCall.args[1]).to.equal('192.168.1.1');
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
      // Should clean up installing record since installation failed
      expect(dbHelperStub.removeDocumentsFromCollection.calledOnce).to.be.true;
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
      expect(dbHelperStub.updateInDatabase.calledOnce).to.be.true;
      expect(dbHelperStub.removeDocumentsFromCollection.calledOnce).to.be.true;
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

      const result = await messageStore.storeIPChangedMessage(message);

      expect(result).to.be.true;
      expect(appsRepositoryStub.updateLocationIp.calledOnce).to.be.true;
      expect(appsRepositoryStub.updateLocationIp.firstCall.args[0]).to.equal('192.168.1.1');
      expect(appsRepositoryStub.updateLocationIp.firstCall.args[1]).to.equal('192.168.1.2');
    });
  });
});
