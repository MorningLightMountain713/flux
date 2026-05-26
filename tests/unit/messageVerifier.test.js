const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('messageVerifier tests', () => {
  let logStub;
  let configStub;

  beforeEach(() => {
    configStub = {
      database: {
        url: 'mongodb://localhost:27017',
        appsglobal: {
          database: 'globalapps',
          collections: {
            appsMessages: 'appsMessages',
            appsTemporaryMessages: 'appsTempMessages',
          },
        },
        daemon: { database: 'daemondb' },
      },
      fluxapps: {
        epochstart: 694000,
        daemonPONFork: 2020000,
        blocksLasting: 22000,
      },
    };

    logStub = {
      error: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('checkAndRequestApp', () => {
    let appsRepositoryStub;
    let storeAppPermanentMessageStub;
    let getPreviousAppSpecsStub;
    let isDaemonSyncedStub;
    let appEventVerifierStub;
    let updateOneInDatabaseStub;
    let verifierWithStubs;

    const mockTempMessage = {
      type: 'fluxappupdate',
      version: 1,
      appSpecifications: { name: 'testapp', version: 8, owner: 'newOwner' },
      hash: 'hash123',
      timestamp: Date.now(),
      signature: 'sig123',
    };

    const mockAppEventLegacy = {
      spec: { name: 'testapp', version: 8, owner: 'newOwner', expire: 22000 },
      isUpdate: true,
      isRegistration: false,
      hash: 'hash123',
      height: 2000000,
      timestamp: mockTempMessage.timestamp,
      toInstantiatedSpec() {
        return { spec: this.spec, hash: this.hash, height: this.height };
      },
      serialize() {
        return {
          type: 'fluxappupdate', version: 1,
          appSpecifications: this.spec,
          hash: this.hash, timestamp: this.timestamp,
          signature: 'sig123', txid: 'txid123',
          height: 2000000, valueSat: 200000000,
        };
      },
    };

    const mockInstantiatedSpec = {
      spec: mockAppEventLegacy.spec,
      name: 'testapp',
      height: 2000000,
      isExpired: sinon.stub().returns(false),
      serialize() {
        return { ...this.spec, hash: 'hash123', height: this.height };
      },
    };

    beforeEach(() => {
      getPreviousAppSpecsStub = sinon.stub();
      storeAppPermanentMessageStub = sinon.stub().resolves();
      updateOneInDatabaseStub = sinon.stub().resolves();
      isDaemonSyncedStub = sinon.stub().returns({ data: { height: 2000000, synced: true } });

      appEventVerifierStub = {
        authorize: sinon.stub().resolves({ valid: true, signer: 'correctOwner' }),
      };

      appsRepositoryStub = {
        getPermanentMessage: sinon.stub().resolves(null),
        getTempMessage: sinon.stub().resolves(mockTempMessage),
        storePermanentMessage: storeAppPermanentMessageStub,
        getGlobalAppInfo: sinon.stub().resolves(mockInstantiatedSpec),
        upsertIfNewer: sinon.stub().resolves(true),
        clearInstallingErrors: sinon.stub().resolves(),
        getPreviousPermanentMessage: sinon.stub().resolves({
          appSpecifications: { name: 'testapp', version: 8, owner: 'correctOwner', expire: 22000 },
          height: 1990000,
        }),
        getGlobalAppInfoRaw: sinon.stub().resolves(null),
        getInstalledAppRaw: sinon.stub().resolves(null),
        removeGlobalAppInfo: sinon.stub().resolves(),
      };

      const mockSpecBackend = {
        AppEventLegacy: {
          deserialize: sinon.stub().returns(mockAppEventLegacy),
        },
        ConfirmedAppEvent: {
          deserialize: sinon.stub().returns(mockAppEventLegacy),
        },
        InstantiatedSpec: {
          fromEvent: sinon.stub().returns(mockInstantiatedSpec),
        },
        deserializeSpec: sinon.stub().returns(mockAppEventLegacy.spec),
      };

      verifierWithStubs = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', {
        config: configStub,
        '../dbHelper': {
          databaseConnection: sinon.stub().returns({ db: sinon.stub().returns('database') }),
          findOneInDatabase: sinon.stub().resolves(null),
          findInDatabase: sinon.stub().resolves([]),
          updateOneInDatabase: updateOneInDatabaseStub,
          insertOneToDatabase: sinon.stub().resolves(),
        },
        '../serviceHelper': {
          ensureNumber: sinon.stub().returnsArg(0),
          ensureString: sinon.stub().returnsArg(0),
          delay: sinon.stub().resolves(),
        },
        '../../lib/log': logStub,
        '../utils/appConstants': {
          globalAppsMessages: 'appsMessages',
          globalAppsTempMessages: 'appsTempMessages',
          appsHashesCollection: 'appsHashes',
          scannedHeightCollection: 'scannedHeight',
        },
        '../daemonService/daemonServiceMiscRpcs': {
          isDaemonSynced: isDaemonSyncedStub,
        },
        '../appDatabase/appsRepository': appsRepositoryStub,
        '../appDatabase/appSpecHistory': {
          getPreviousAppSpecifications: getPreviousAppSpecsStub,
        },
        '../utils/specLibs': {
          getSpec: sinon.stub().resolves({}),
          getSpecBackend: sinon.stub().resolves(mockSpecBackend),
        },
        '../utils/appUtilities': {
          appPricePerMonth: sinon.stub().returns(1000),
        },
        '../utils/chainUtilities': {
          getChainParamsPriceUpdates: sinon.stub().resolves([{ height: 0, minPrice: 1 }]),
        },
        '../pricing/buildPricingEngine': {
          buildPricingEngine: sinon.stub().resolves(null),
        },
        '../messageHelper': {
          createDataMessage: sinon.stub(),
          createErrorMessage: sinon.stub(),
        },
        '../verificationHelper': {
          verifyPrivilege: sinon.stub().resolves(true),
        },
        '../generalService': {
          checkSynced: sinon.stub().resolves(true),
        },
        '../fluxCommunicationMessagesSender': {
          broadcastMessageToAll: sinon.stub().resolves(),
          broadcastMessageToRandomIncoming: sinon.stub().resolves(),
          broadcastMessageToRandomOutgoing: sinon.stub().resolves(),
        },
        '../fluxNetworkHelper': {
          getNumberOfPeers: sinon.stub().returns(20),
        },
        '../invalidMessages': {
          invalidMessages: [],
        },
        '../utils/globalState': {
          getPendingUpdates: sinon.stub().returns([]),
          clearPendingUpdates: sinon.stub(),
        },
        './appEventVerifier': appEventVerifierStub,
      });
    });

    it('returns false for blocks before epoch start', async () => {
      const result = await verifierWithStubs.checkAndRequestApp('hash123', 'txid123', 100, 200000000);
      expect(result).to.be.false;
    });

    it('returns true and skips processing if permanent message already exists', async () => {
      appsRepositoryStub.getPermanentMessage.resolves({ hash: 'hash123' });
      const result = await verifierWithStubs.checkAndRequestApp('hash123', 'txid123', 2000000, 200000000);
      expect(result).to.be.true;
      expect(storeAppPermanentMessageStub.called).to.be.false;
    });

    it('refuses promotion when signature re-verification fails', async () => {
      getPreviousAppSpecsStub.resolves({ owner: 'newOwner', version: 8 });
      appEventVerifierStub.authorize.rejects(new Error('Received signature does not correspond'));

      const result = await verifierWithStubs.checkAndRequestApp('hash123', 'txid123', 2000000, 200000000);

      expect(result).to.be.false;
      expect(storeAppPermanentMessageStub.called).to.be.false;
      expect(logStub.warn.called).to.be.false;
      expect(logStub.error.called).to.be.true;
    });

    it('promotes temp to permanent when verification passes', async () => {
      getPreviousAppSpecsStub.resolves({ owner: 'correctOwner', version: 8 });

      const result = await verifierWithStubs.checkAndRequestApp('hash123', 'txid123', 2000000, 200000000);

      expect(result).to.be.true;
      expect(storeAppPermanentMessageStub.calledOnce).to.be.true;
    });

    it('stores via appsRepository.upsertIfNewer after fee check passes', async () => {
      getPreviousAppSpecsStub.resolves({ owner: 'correctOwner', version: 8 });

      await verifierWithStubs.checkAndRequestApp('hash123', 'txid123', 2000000, 99999999999);

      expect(appsRepositoryStub.upsertIfNewer.called).to.be.true;
      expect(appsRepositoryStub.clearInstallingErrors.called).to.be.true;
    });

    it('uses appsRepository for message lookups, not raw dbHelper', async () => {
      await verifierWithStubs.checkAndRequestApp('hash123', 'txid123', 2000000, 200000000);

      expect(appsRepositoryStub.getPermanentMessage.calledWith('hash123')).to.be.true;
      expect(appsRepositoryStub.getTempMessage.calledWith('hash123')).to.be.true;
    });
  });

  describe('exported functions', () => {
    it('exports the expected API surface', () => {
      const messageVerifier = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', {
        config: configStub,
        '../dbHelper': { databaseConnection: sinon.stub().returns({ db: sinon.stub() }), findOneInDatabase: sinon.stub(), findInDatabase: sinon.stub(), updateOneInDatabase: sinon.stub() },
        '../serviceHelper': { ensureNumber: sinon.stub(), ensureString: sinon.stub(), delay: sinon.stub() },
        '../../lib/log': logStub,
        '../utils/appConstants': { globalAppsMessages: 'a', globalAppsTempMessages: 'b', appsHashesCollection: 'c', scannedHeightCollection: 'd' },
        '../daemonService/daemonServiceMiscRpcs': { isDaemonSynced: sinon.stub() },
        '../appDatabase/appsRepository': { getPermanentMessage: sinon.stub(), getTempMessage: sinon.stub() },
        '../appDatabase/appSpecHistory': { getPreviousAppSpecifications: sinon.stub() },
        '../utils/specLibs': { getSpec: sinon.stub(), getSpecBackend: sinon.stub() },
        '../utils/appUtilities': { appPricePerMonth: sinon.stub() },
        '../utils/chainUtilities': { getChainParamsPriceUpdates: sinon.stub() },
        '../pricing/buildPricingEngine': { buildPricingEngine: sinon.stub() },
        '../messageHelper': { createDataMessage: sinon.stub(), createErrorMessage: sinon.stub() },
        '../verificationHelper': { verifyPrivilege: sinon.stub() },
        '../generalService': { checkSynced: sinon.stub() },
        '../fluxCommunicationMessagesSender': { broadcastMessageToAll: sinon.stub(), broadcastMessageToRandomIncoming: sinon.stub(), broadcastMessageToRandomOutgoing: sinon.stub() },
        '../fluxNetworkHelper': { getNumberOfPeers: sinon.stub() },
        '../invalidMessages': { invalidMessages: [] },
        '../utils/globalState': { getPendingUpdates: sinon.stub(), clearPendingUpdates: sinon.stub() },
        './appEventVerifier': { authorize: sinon.stub() },
      });

      expect(messageVerifier.requestAppMessage).to.be.a('function');
      expect(messageVerifier.checkAndRequestApp).to.be.a('function');
      expect(messageVerifier.appHashHasMessage).to.be.a('function');
      expect(messageVerifier.getAppsTemporaryMessages).to.be.a('function');
      expect(messageVerifier.getAppsPermanentMessages).to.be.a('function');
    });
  });
});
