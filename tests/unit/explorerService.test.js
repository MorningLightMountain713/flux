const sinon = require('sinon');
const explorerService = require('../../ZelBack/src/services/explorerService');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const specReconciler = require('../../ZelBack/src/services/appLifecycle/specReconciler');
const appJanitor = require('../../ZelBack/src/services/appLifecycle/appJanitor');
const portManager = require('../../ZelBack/src/services/appNetwork/portManager');
const daemonServiceBlockchainRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceBlockchainRpcs');
const daemonServiceMiscRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceMiscRpcs');
const daemonServiceUtils = require('../../ZelBack/src/services/daemonService/daemonServiceUtils');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const globalState = require('../../ZelBack/src/services/utils/globalState');
const log = require('../../ZelBack/src/lib/log');
const { requireMongo } = require('./dbTestHelper');

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');

// 320-char OP_RETURN payload, hoisted so the call site stays inside max-len.
const longAsm = 'OP_RETURN 6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738394142434445464748494a4b4c4d4e4f505152535455565758595a3031';

chai.use(chaiAsPromised);
const { expect } = chai;

describe('explorerService tests', () => {
  before(requireMongo);

  describe('getVerboseBlock tests', () => {
    let daemonServiceBlockchainRpcsStub;
    const hash = '12345';

    beforeEach(() => {
      daemonServiceBlockchainRpcsStub = sinon.stub(daemonServiceBlockchainRpcs, 'getBlock');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should throw error if daemonService returns error', async () => {
      daemonServiceBlockchainRpcsStub.returns({
        status: 'error',
        data: 'there was an error',
      });

      await expect(explorerService.getVerboseBlock(hash)).to.eventually.be.rejectedWith('there was an error');
      sinon.assert.calledOnceWithExactly(daemonServiceBlockchainRpcsStub, { params: { hashheight: '12345', verbosity: 2 } });
    });

    it('should return data if daemonService returns data', async () => {
      daemonServiceBlockchainRpcsStub.returns({
        status: 'success',
        data: 'test data',
      });

      const result = await explorerService.getVerboseBlock(hash);
      expect(result).to.eql('test data');
      sinon.assert.calledOnceWithExactly(daemonServiceBlockchainRpcsStub, { params: { hashheight: '12345', verbosity: 2 } });
    });
  });

  describe('decodeMessage tests', () => {
    it('Should return a proper decoded message', () => {
      const encodedMessage = 'OP_RETURN 74657374';
      const expectedResult = 'test';
      const result = explorerService.decodeMessage(encodedMessage);

      expect(result).to.equal(expectedResult);
    });

    it('Should return a proper decoded message with only 2 words if there are 3', () => {
      const encodedMessage = 'OP_RETURN 74657374 74657374 74657374';
      const expectedResult = 'test\u0007FW7\u0004test';
      const result = explorerService.decodeMessage(encodedMessage);

      expect(result).to.eql(expectedResult);
    });

    it('Should return empty string if message is not in a proper format', () => {
      const encodedMessage = 'test123';
      const expectedResult = '';
      const result = explorerService.decodeMessage(encodedMessage);

      expect(result).to.equal(expectedResult);
    });
  });

  describe('processInsight tests', () => {
    let dbStubFind;
    let dbStubInsert;
    const database = {};

    beforeEach(async () => {
      dbStubFind = sinon.stub(dbHelper, 'findOneInDatabase');
      dbStubInsert = sinon.stub(dbHelper, 'insertManyToDatabase');
      await dbHelper.initiateDB();
      dbHelper.databaseConnection();
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should do nothing if version is >5', async () => {
      const blockVerbose = {
        tx: [
          {
            version: 6,
            txid: '12345',
            type: 'send',
            update_type: 'someType',
            ip: '192.168.1.1',
            benchmark_tier: 'stratus',
            txhash: 'hash1234',
            outidx: '1111',
          },
        ],
      };
      await explorerService.processInsight(blockVerbose, database);

      sinon.assert.notCalled(dbStubInsert);
    });

    it('should do nothing if version is 0', async () => {
      const blockVerbose = {
        tx: [
          {
            version: 0,
            txid: '12345',
            type: 'send',
            update_type: 'someType',
            ip: '192.168.1.1',
            benchmark_tier: 'stratus',
            txhash: 'hash1234',
            outidx: '1111',
          },
        ],
      };
      await explorerService.processInsight(blockVerbose, database);

      sinon.assert.notCalled(dbStubInsert);
    });

    it('log error and not call db if version is >0 and <5 and data is correct, but tx exists in db', async () => {
      dbStubFind.returns(true);
      const blockVerbose = {
        tx: [
          {
            version: 3,
            txid: '12345',
            type: 'send',
            update_type: 'someType',
            ip: '192.168.1.1',
            benchmark_tier: 'stratus',
            txhash: 'hash1234',
            outidx: '1111',
            vin: [],
            vout: [{
              n: 444,
              scriptPubKey:
              {
                addresses: ['t1LUs6quf7TB2zVZmexqPQdnqmrFMGZGjV6'],
                asm: 'OP_RETURN 5468697320737472696e672069732065786163746c792036342063686172616374657273206c6f6e672e20496e636c7564696e67207468697320737472696e67',
              },
              valueSat: 20000000,
            }],
          },
        ],
        height: 983000,
      };
      await explorerService.processInsight(blockVerbose, database);

      sinon.assert.notCalled(dbStubInsert);
    });

    it('log error and not call db if version is >0 and <5 and data is correct, but message value < priceSpecifications.minPrice', async () => {
      dbStubFind.returns(false);
      const blockVerbose = {
        tx: [
          {
            version: 3,
            txid: '12345',
            type: 'send',
            update_type: 'someType',
            ip: '192.168.1.1',
            benchmark_tier: 'stratus',
            txhash: 'hash1234',
            outidx: '1111',
            vin: [],
            vout: [{
              n: 444,
              scriptPubKey:
              {
                addresses: ['t1LUs6quf7TB2zVZmexqPQdnqmrFMGZGjV6'],
                asm: 'OP_RETURN 5468697320737472696e672069732065786163746c792036342063686172616374657273206c6f6e672e20496e636c7564696e67207468697320737472696e67',
              },
              valueSat: 1000,
            }],
          },
        ],
        height: 983000,
      };
      await explorerService.processInsight(blockVerbose, database);

      sinon.assert.notCalled(dbStubInsert);
    });

    it('log error and not call db if version is >0 and <5 and data is correct, but height < epoch start', async () => {
      dbStubFind.returns(false);
      const blockVerbose = {
        tx: [
          {
            version: 3,
            txid: '12345',
            type: 'send',
            update_type: 'someType',
            ip: '192.168.1.1',
            benchmark_tier: 'stratus',
            txhash: 'hash1234',
            outidx: '1111',
            vin: [],
            vout: [{
              n: 444,
              scriptPubKey:
              {
                addresses: ['t1LUs6quf7TB2zVZmexqPQdnqmrFMGZGjV6'],
                asm: 'OP_RETURN 5468697320737472696e672069732065786163746c792036342063686172616374657273206c6f6e672e20496e636c7564696e67207468697320737472696e67',
              },
              valueSat: 20000000,
            }],
          },
        ],
        height: 1,
      };
      await explorerService.processInsight(blockVerbose, database);

      sinon.assert.notCalled(dbStubInsert);
    });
  });

  describe('processBlock tests', () => {
    let dbStubUpdate;
    let dbStubCollectionStats;
    let logInfoSpy;
    let sweepRegistryExpiryStub;
    let reconcileInstalledAppsStub;
    let restorePortsSupportStub;
    let daemonServiceBlockchainRpcsStub;
    let daemonServiceMiscRpcsStub;

    beforeEach(async () => {
      sinon.stub(dbHelper, 'findOneInDatabase');
      sinon.stub(dbHelper, 'insertManyToDatabase');
      dbStubUpdate = sinon.stub(dbHelper, 'updateOneInDatabase');
      dbStubCollectionStats = sinon.stub(dbHelper, 'collectionStats');
      sweepRegistryExpiryStub = sinon.stub(appJanitor, 'sweepRegistryExpiry');
      reconcileInstalledAppsStub = sinon.stub(specReconciler, 'requestFullConvergence');
      restorePortsSupportStub = sinon.stub(portManager, 'restorePortsSupport');
      await dbHelper.initiateDB();
      dbHelper.databaseConnection();
      daemonServiceMiscRpcsStub = sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced');
      daemonServiceBlockchainRpcsStub = sinon.stub(daemonServiceBlockchainRpcs, 'getBlock');
      logInfoSpy = sinon.spy(log, 'info');
      globalState.dbReady = true;
    });

    afterEach(() => {
      globalState.dbReady = false;
      sinon.restore();
    });

    it('should return and retry function if daemon is not synced', async () => {
      const blockHeight = 100000;
      const isInsightExplorer = true;
      daemonServiceMiscRpcsStub.returns({
        data:
        {
          synced: false,
        },
      });

      const result = await explorerService.processBlock(blockHeight, isInsightExplorer);

      expect(result).to.be.undefined;
    });

    it('should update db if all parameters are passed correctly, block height == 695000', async () => {
      const blockHeight = 695000;
      const isInsightExplorer = true;
      dbStubUpdate.returns(true);
      sweepRegistryExpiryStub.returns(true);
      // prevent infinite func loop while testing
      explorerService.setBlockProccessingCanContinue(false);
      dbStubCollectionStats.returns({
        size: 10000,
        count: 15,
        avgObjSize: 1111,
      });
      daemonServiceMiscRpcsStub.returns({
        data:
        {
          synced: true,
        },
      });
      daemonServiceBlockchainRpcsStub.returns({
        status: 'success',
        data: {
          tx: [
            {
              version: 3,
              txid: '12345',
              type: 'send',
              update_type: 'someType',
              ip: '192.168.1.1',
              benchmark_tier: 'stratus',
              txhash: 'hash1234',
              outidx: '1111',
              vin: [],
              vout: [{
                n: 444,
                scriptPubKey:
                {
                  addresses: ['t1LUs6quf7TB2zVZmexqPQdnqmrFMGZGjV6'],
                  asm: 'OP_RETURN 5468697320737472696e672069732065786163746c792036342063686172616374657273206c6f6e672e20496e636c7564696e67207468697320737472696e67',
                },
                valueSat: 20000000,
              }],
            },
          ],
          height: 695000,
          confirmations: 1,
        },
      });

      await explorerService.processBlock(blockHeight, isInsightExplorer);

      sinon.assert.calledOnce(sweepRegistryExpiryStub);
      sinon.assert.notCalled(restorePortsSupportStub);
      sinon.assert.calledOnceWithMatch(
        dbStubUpdate,
        sinon.match.object,
        'scannedheight',
        { generalScannedHeight: { $gte: 0 } },
        { $set: { generalScannedHeight: 695000 } },
        { upsert: true },
      );
      sinon.assert.calledWith(logInfoSpy, 'Processing Explorer Block Height: 695000');
    });

    it('should update db if all parameters are passed correctly, height == 900009', async () => {
      const blockHeight = 900009;
      const isInsightExplorer = true;
      dbStubUpdate.returns(true);
      reconcileInstalledAppsStub.returns(true);
      // prevent infinite func loop while testing
      explorerService.setBlockProccessingCanContinue(false);
      dbStubCollectionStats.returns({
        size: 10000,
        count: 15,
        avgObjSize: 1111,
      });
      daemonServiceMiscRpcsStub.returns({
        data:
        {
          synced: true,
        },
      });
      daemonServiceBlockchainRpcsStub.returns({
        status: 'success',
        data: {
          tx: [
            {
              version: 3,
              txid: '12345',
              type: 'send',
              update_type: 'someType',
              ip: '192.168.1.1',
              benchmark_tier: 'stratus',
              txhash: 'hash1234',
              outidx: '1111',
              vin: [],
              vout: [{
                n: 444,
                scriptPubKey:
                {
                  addresses: ['t1LUs6quf7TB2zVZmexqPQdnqmrFMGZGjV6'],
                  asm: 'OP_RETURN 5468697320737472696e672069732065786163746c792036342063686172616374657273206c6f6e672e20496e636c7564696e67207468697320737472696e67',
                },
                valueSat: 20000000,
              }],
            },
          ],
          height: 900009,
          confirmations: 1,
        },
      });

      await explorerService.processBlock(blockHeight, isInsightExplorer);

      sinon.assert.notCalled(sweepRegistryExpiryStub);
      sinon.assert.notCalled(restorePortsSupportStub);
      sinon.assert.calledOnceWithMatch(
        dbStubUpdate,
        sinon.match.object,
        'scannedheight',
        { generalScannedHeight: { $gte: 0 } },
        { $set: { generalScannedHeight: 900009 } },
        { upsert: true },
      );
    });

    it('should update db if all parameters are passed correctly, height == 900025', async () => {
      const blockHeight = 900025;
      const isInsightExplorer = true;
      dbStubUpdate.returns(true);
      reconcileInstalledAppsStub.returns(true);
      // prevent infinite func loop while testing
      explorerService.setBlockProccessingCanContinue(false);
      dbStubCollectionStats.returns({
        size: 10000,
        count: 15,
        avgObjSize: 1111,
      });
      daemonServiceMiscRpcsStub.returns({
        data:
        {
          synced: true,
        },
      });
      daemonServiceBlockchainRpcsStub.returns({
        status: 'success',
        data: {
          tx: [
            {
              version: 3,
              txid: '12345',
              type: 'send',
              update_type: 'someType',
              ip: '192.168.1.1',
              benchmark_tier: 'stratus',
              txhash: 'hash1234',
              outidx: '1111',
              vin: [],
              vout: [{
                n: 444,
                scriptPubKey:
                {
                  addresses: ['t1LUs6quf7TB2zVZmexqPQdnqmrFMGZGjV6'],
                  asm: 'OP_RETURN 5468697320737472696e672069732065786163746c792036342063686172616374657273206c6f6e672e20496e636c7564696e67207468697320737472696e67',
                },
                valueSat: 20000000,
              }],
            },
          ],
          height: 900025,
          confirmations: 1,
        },
      });

      await explorerService.processBlock(blockHeight, isInsightExplorer);

      sinon.assert.notCalled(sweepRegistryExpiryStub);
      sinon.assert.calledOnceWithMatch(
        dbStubUpdate,
        sinon.match.object,
        'scannedheight',
        { generalScannedHeight: { $gte: 0 } },
        { $set: { generalScannedHeight: 900025 } },
        { upsert: true },
      );
    });
  });

  describe('initiateBlockProcessor tests', () => {
    let findInDatabaseStub;
    let getBlockCountStub;
    let dropCollectionStub;
    let logErrorSpy;
    let logInfoSpy;

    beforeEach(async () => {
      findInDatabaseStub = sinon.stub(dbHelper, 'findOneInDatabase');
      dropCollectionStub = sinon.stub(dbHelper, 'dropCollection');
      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({ data: { synced: true } });
      getBlockCountStub = sinon.stub(daemonServiceBlockchainRpcs, 'getBlockCount');
      sinon.stub(daemonServiceUtils, 'getConfigValue').returns('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ'); // Valid WIF private key
      await dbHelper.initiateDB();
      dbHelper.databaseConnection();
      logErrorSpy = sinon.spy(log, 'error');
      logInfoSpy = sinon.spy(log, 'info');
      sinon.stub(dbHelper, 'insertManyToDatabase').returns(true);
      sinon.stub(dbHelper, 'updateOneInDatabase').returns(true);
      sinon.stub(dbHelper, 'collectionStats').returns({
        size: 10000,
        count: 15,
        avgObjSize: 1111,
      });
      sinon.stub(appJanitor, 'sweepRegistryExpiry').returns(true);
      sinon.stub(specReconciler, 'requestFullConvergence').resolves();
      sinon.stub(daemonServiceBlockchainRpcs, 'getBlock').returns({
        status: 'success',
        data: {
          tx: [
            {
              version: 3,
              txid: '12345',
              type: 'send',
              update_type: 'someType',
              ip: '192.168.1.1',
              benchmark_tier: 'stratus',
              txhash: 'hash1234',
              outidx: '1111',
              vin: [],
              vout: [{
                n: 444,
                scriptPubKey:
                {
                  addresses: ['t1LUs6quf7TB2zVZmexqPQdnqmrFMGZGjV6'],
                  asm: 'OP_RETURN 5468697320737472696e672069732065786163746c792036342063686172616374657273206c6f6e672e20496e636c7564696e67207468697320737472696e67',
                },
                valueSat: 20000000,
              }],
            },
          ],
          height: 695000,
          confirmations: 1,
        },
      });
    });

    afterEach(() => {
      explorerService.setIsInInitiationOfBP(false);
      explorerService.setZelAppSpecsMigrationDone(false);
      sinon.restore();
    });

    it('should return right away if isInInitiationOfBP is true', async () => {
      explorerService.setIsInInitiationOfBP(true);

      const result = await explorerService.initiateBlockProcessor(true, true);

      expect(result).to.be.undefined;
      sinon.assert.notCalled(findInDatabaseStub);
    });

    it('should throw and log error if getBlockCount does not return success', async () => {
      explorerService.setZelAppSpecsMigrationDone(true);
      sinon.stub(dbHelper, 'countInDatabase').resolves(1);
      explorerService.setBlockProccessingCanContinue(false);
      getBlockCountStub.returns({
        status: 'error',
        data: {
          message: 'message',
        },
      });

      await explorerService.initiateBlockProcessor(false, false);
      await serviceHelper.delay(200);

      sinon.assert.calledOnce(logErrorSpy);
      sinon.assert.calledWithMatch(findInDatabaseStub, sinon.match.object, 'scannedheight', { generalScannedHeight: { $gte: 0 } }, { projection: { _id: 0, generalScannedHeight: 1 } });
    });

    it('should run the block processor, all params false', async () => {
      findInDatabaseStub.returns({ generalScannedHeight: 0 });
      dropCollectionStub.resolves(true);
      sinon.stub(dbHelper, 'findInDatabase').resolves([]);
      sinon.stub(dbHelper, 'countInDatabase').resolves(1);
      const createIndexFake = sinon.fake.resolves(true);
      const collectionFake = sinon.fake.returns({ createIndex: createIndexFake, updateMany: sinon.fake.resolves({ modifiedCount: 0 }), indexes: sinon.fake.resolves([]) });
      const dbFake = sinon.fake.returns({ collection: collectionFake });
      sinon.stub(dbHelper, 'databaseConnection').returns({ db: dbFake });
      getBlockCountStub.returns({
        status: 'success',
        data: 200000,
      });
      sinon.stub(daemonServiceMiscRpcs, 'isInsightExplorer').returns(true);
      sinon.stub(daemonServiceUtils, 'executeCall').resolves({ status: 'success', data: [] });
      sinon.stub(daemonServiceUtils, 'executeBatchCall').resolves({ status: 'success', data: [] });
      explorerService.setBlockProccessingCanContinue(false);

      await explorerService.initiateBlockProcessor(false, false, false);
      await serviceHelper.delay(200);

      sinon.assert.notCalled(logErrorSpy);
      sinon.assert.calledWithMatch(logInfoSpy, 'Bootstrap: Using address-index fast path');
      sinon.assert.calledWithMatch(logInfoSpy, 'Bootstrap complete');
      sinon.assert.calledWithMatch(logInfoSpy, 'Preparing apps collections');
      sinon.assert.calledWithMatch(logInfoSpy, 'Preparation done');
    });

    it('should fall back to block-by-block scan when bootstrap fails', async () => {
      findInDatabaseStub.returns({ generalScannedHeight: 0 });
      dropCollectionStub.resolves(true);
      sinon.stub(dbHelper, 'findInDatabase').resolves([]);
      sinon.stub(dbHelper, 'countInDatabase').resolves(1);
      const createIndexFake = sinon.fake.resolves(true);
      const collectionFake = sinon.fake.returns({ createIndex: createIndexFake, updateMany: sinon.fake.resolves({ modifiedCount: 0 }), indexes: sinon.fake.resolves([]) });
      const dbFake = sinon.fake.returns({ collection: collectionFake });
      sinon.stub(dbHelper, 'databaseConnection').returns({ db: dbFake });
      getBlockCountStub.returns({ status: 'success', data: 200000 });
      sinon.stub(daemonServiceMiscRpcs, 'isInsightExplorer').returns(true);
      sinon.stub(daemonServiceUtils, 'executeCall').resolves({ status: 'error', data: { message: 'RPC unavailable' } });
      explorerService.setBlockProccessingCanContinue(false);

      await explorerService.initiateBlockProcessor(false, false, false);
      await serviceHelper.delay(200);

      sinon.assert.calledWithMatch(logErrorSpy, 'Bootstrap failed, falling back to block-by-block scan');
      sinon.assert.calledWithMatch(logInfoSpy, 'Processing Explorer Block Height: 695000');
    });

    it('should run the block processor, restoreDatabase set to true, height > 0', async () => {
      sinon.stub(dbHelper, 'removeDocumentsFromCollection').resolves(true);
      sinon.stub(dbHelper, 'updateInDatabase').resolves(true);
      sinon.stub(dbHelper, 'findInDatabase').resolves([]);
      sinon.stub(dbHelper, 'countInDatabase').resolves(1);
      findInDatabaseStub.returns({ generalScannedHeight: 1000 });
      dropCollectionStub.resolves(true);
      const createIndexFake = sinon.fake.resolves(true);
      const collectionFake = sinon.fake.returns({ createIndex: createIndexFake, updateMany: sinon.fake.resolves({ modifiedCount: 0 }), indexes: sinon.fake.resolves([]) });
      const dbFake = sinon.fake.returns({ collection: collectionFake });
      sinon.stub(dbHelper, 'databaseConnection').returns({ db: dbFake });
      getBlockCountStub.returns({
        status: 'success',
        data: 200000,
      });
      sinon.stub(daemonServiceMiscRpcs, 'isInsightExplorer').returns(true);
      explorerService.setBlockProccessingCanContinue(false);

      await explorerService.initiateBlockProcessor(true, false, false);
      await serviceHelper.delay(200);

      sinon.assert.notCalled(logErrorSpy);
      sinon.assert.calledWithMatch(logInfoSpy, 'Processing Explorer Block Height: 695000');
      sinon.assert.calledWithMatch(logInfoSpy, 'Restoring database...');
      sinon.assert.calledWithMatch(logInfoSpy, 'Rescan completed');
      sinon.assert.calledWithMatch(logInfoSpy, 'Rescan completed');
      sinon.assert.calledWithMatch(logInfoSpy, 'Database restored OK');
    });

    it('should run the block processor, deepRestore, restoreDatabase set to true, height > 0', async () => {
      sinon.stub(dbHelper, 'removeDocumentsFromCollection').resolves(true);
      sinon.stub(dbHelper, 'updateInDatabase').resolves(true);
      sinon.stub(dbHelper, 'findInDatabase').resolves([]);
      sinon.stub(dbHelper, 'countInDatabase').resolves(1);
      findInDatabaseStub.returns({ generalScannedHeight: 1000 });
      dropCollectionStub.resolves(true);
      const createIndexFake = sinon.fake.resolves(true);
      const collectionFake = sinon.fake.returns({ createIndex: createIndexFake, updateMany: sinon.fake.resolves({ modifiedCount: 0 }), indexes: sinon.fake.resolves([]) });
      const dbFake = sinon.fake.returns({ collection: collectionFake });
      sinon.stub(dbHelper, 'databaseConnection').returns({ db: dbFake });
      getBlockCountStub.returns({
        status: 'success',
        data: 200000,
      });
      sinon.stub(daemonServiceMiscRpcs, 'isInsightExplorer').returns(true);
      explorerService.setBlockProccessingCanContinue(false);

      await explorerService.initiateBlockProcessor(true, true, false);
      await serviceHelper.delay(200);

      sinon.assert.notCalled(logErrorSpy);
      sinon.assert.calledWithMatch(logInfoSpy, 'Processing Explorer Block Height: 695000');
      sinon.assert.calledWithMatch(logInfoSpy, 'Deep restoring of database...');
      sinon.assert.calledWithMatch(logInfoSpy, 'Rescan completed');
      sinon.assert.calledWithMatch(logInfoSpy, 'Rescan completed');
      sinon.assert.calledWithMatch(logInfoSpy, 'Database restored OK');
    });

    it('should run the block processor, reindexOrRescanGlobalApps set to true, height == 0', async () => {
      sinon.stub(dbHelper, 'removeDocumentsFromCollection').resolves(true);
      sinon.stub(dbHelper, 'updateInDatabase').resolves(true);
      sinon.stub(dbHelper, 'findInDatabase').resolves([]);
      sinon.stub(dbHelper, 'countInDatabase').resolves(1);
      findInDatabaseStub.returns({ generalScannedHeight: 0 });
      dropCollectionStub.resolves(true);
      const createIndexFake = sinon.fake.resolves(true);
      const collectionFake = sinon.fake.returns({ createIndex: createIndexFake, updateMany: sinon.fake.resolves({ modifiedCount: 0 }), indexes: sinon.fake.resolves([]) });
      const dbFake = sinon.fake.returns({ collection: collectionFake });
      sinon.stub(dbHelper, 'databaseConnection').returns({ db: dbFake });
      getBlockCountStub.returns({
        status: 'success',
        data: 200000,
      });
      sinon.stub(daemonServiceMiscRpcs, 'isInsightExplorer').returns(true);
      sinon.stub(daemonServiceUtils, 'executeCall').resolves({ status: 'success', data: [] });
      sinon.stub(daemonServiceUtils, 'executeBatchCall').resolves({ status: 'success', data: [] });
      explorerService.setBlockProccessingCanContinue(false);

      await explorerService.initiateBlockProcessor(false, false, true);
      await serviceHelper.delay(200);

      sinon.assert.notCalled(logErrorSpy);
      sinon.assert.calledWithMatch(logInfoSpy, 'Bootstrap: Using address-index fast path');
      sinon.assert.calledWithMatch(logInfoSpy, 'Preparing apps collections');
      sinon.assert.calledWithMatch(logInfoSpy, 'Preparation done');
      sinon.assert.calledWithMatch(dropCollectionStub, sinon.match.object, 'zelappsmessages');
      sinon.assert.calledWithMatch(dropCollectionStub, sinon.match.object, 'zelappshashes');
    });
  });

  describe('getPriceSpecForHeight tests', () => {
    it('should return correct price spec via binary search', () => {
      const specs = [
        { height: -1, minPrice: 1 },
        { height: 983000, minPrice: 0.1 },
        { height: 1004000, minPrice: 0.01 },
      ];
      expect(explorerService.getPriceSpecForHeight(specs, 500000).minPrice).to.equal(1);
      expect(explorerService.getPriceSpecForHeight(specs, 983001).minPrice).to.equal(0.1);
      expect(explorerService.getPriceSpecForHeight(specs, 2000000).minPrice).to.equal(0.01);
    });
  });

  describe('processBootstrapTx tests', () => {
    const config = require('config');

    function makeTx(overrides = {}) {
      return {
        txid: 'abc123',
        version: 1,
        height: 700000,
        blocktime: 1750000000,
        vin: [{ address: 't1SenderAddr' }],
        vout: [{
          valueSat: 500000000,
          scriptPubKey: {
            addresses: [config.fluxapps.appPaymentAddresses[0].address],
            asm: longAsm,
          },
        }],
        ...overrides,
      };
    }

    it('should extract valid app hash', () => {
      const priceSpecs = [{ height: -1, minPrice: 0.01 }];
      const seenHashes = new Set();
      const hashBatch = [];
      explorerService.processBootstrapTx(makeTx(), priceSpecs, seenHashes, hashBatch);
      expect(hashBatch).to.have.length(1);
      expect(hashBatch[0].txid).to.equal('abc123');
      expect(hashBatch[0].hash).to.have.length(64);
      expect(hashBatch[0].message).to.equal(false);
      // the confirming block's timestamp rides the row — it becomes v9 registeredAt
      expect(hashBatch[0].blockTime).to.equal(1750000000);
    });

    it('should skip tx with version >= 5', () => {
      const hashBatch = [];
      explorerService.processBootstrapTx(makeTx({ version: 5 }), [{ height: -1, minPrice: 0.01 }], new Set(), hashBatch);
      expect(hashBatch).to.have.length(0);
    });

    it('should skip tx below minPrice', () => {
      const hashBatch = [];
      explorerService.processBootstrapTx(makeTx({ vout: [{ valueSat: 100, scriptPubKey: { addresses: [config.fluxapps.appPaymentAddresses[0].address], asm: longAsm } }] }), [{ height: -1, minPrice: 1 }], new Set(), hashBatch);
      expect(hashBatch).to.have.length(0);
    });

    it('should deduplicate by hash', () => {
      const priceSpecs = [{ height: -1, minPrice: 0.01 }];
      const seenHashes = new Set();
      const hashBatch = [];
      explorerService.processBootstrapTx(makeTx(), priceSpecs, seenHashes, hashBatch);
      explorerService.processBootstrapTx(makeTx({ txid: 'def456' }), priceSpecs, seenHashes, hashBatch);
      expect(hashBatch).to.have.length(1);
    });

    it('should not collect soft forks (handled by bootstrapSoftForks pre-pass)', () => {
      const hashBatch = [];
      const tx = makeTx({
        vin: [{ address: config.fluxapps.appPaymentAddresses[1].address }],
        vout: [{
          valueSat: 0,
          scriptPubKey: {
            addresses: [config.fluxapps.appPaymentAddresses[1].address],
            asm: 'OP_RETURN 705f302e30315f302e30315f302e3030345f302e30315f302e345f302e385f302e34',
          },
        }],
      });
      explorerService.processBootstrapTx(tx, [{ height: -1, minPrice: 0.01 }], new Set(), hashBatch);
      expect(hashBatch).to.have.length(0);
    });

    it('should not count multisig payment before enforcement height', () => {
      const hashBatch = [];
      const tx = makeTx({
        height: 1200000,
        vout: [{
          valueSat: 500000000,
          scriptPubKey: {
            addresses: [config.fluxapps.appPaymentAddresses[1].address],
            asm: 'OP_RETURN 6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738394142434445464748494a4b4c4d4e4f505152535455565758595a3031',
          },
        }],
      });
      explorerService.processBootstrapTx(tx, [{ height: -1, minPrice: 0.01 }], new Set(), hashBatch);
      expect(hashBatch).to.have.length(0);
    });
  });

  describe('bootstrapAppHashes tests', () => {
    const config = require('config');
    let executeCallStub;
    let executeBatchCallStub;
    let insertManyStub;
    let updateOneStub;

    const hashHex1 = '6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738394142434445464748494a4b4c4d4e4f505152535455565758595a3031';
    const hashHex2 = '30313233343536373839616263646566303132333435363738396162636465663031323334353637383961626364656630313233343536373839616263646566';

    function makeRpcTx(txid, height, address, valueSat, hashHex) {
      return {
        txid,
        version: 1,
        height,
        vin: [{ address: 't1Sender' }],
        vout: [{
          valueSat,
          scriptPubKey: { addresses: [address], asm: `OP_RETURN ${hashHex || hashHex1}` },
        }],
      };
    }

    beforeEach(async () => {
      await dbHelper.initiateDB();
      dbHelper.databaseConnection();
      executeCallStub = sinon.stub(daemonServiceUtils, 'executeCall');
      executeBatchCallStub = sinon.stub(daemonServiceUtils, 'executeBatchCall');
      insertManyStub = sinon.stub(dbHelper, 'insertManyToDatabase').resolves();
      updateOneStub = sinon.stub(dbHelper, 'updateOneInDatabase').resolves();
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should extract hashes and update scannedHeight', async () => {
      executeCallStub.resolves({ status: 'success', data: ['tx1', 'tx2'] });
      executeBatchCallStub.resolves({
        status: 'success',
        data: [
          { id: 0, result: makeRpcTx('tx1', 700000, config.fluxapps.appPaymentAddresses[0].address, 500000000, hashHex1), error: null },
          { id: 1, result: makeRpcTx('tx2', 700001, config.fluxapps.appPaymentAddresses[0].address, 500000000, hashHex2), error: null },
        ],
      });

      await explorerService.bootstrapAppHashes(2579000);

      sinon.assert.calledOnce(insertManyStub);
      const inserted = insertManyStub.getCall(0).args[2];
      expect(inserted).to.have.length(2);
      expect(inserted[0].hash).to.have.length(64);

      sinon.assert.called(updateOneStub);
      const updateCall = updateOneStub.getCalls().find((c) => c.args[1] === config.database.daemon.collections.scannedHeight);
      expect(updateCall.args[3].$set.generalScannedHeight).to.equal(2579000);
    });

    it('should throw on getaddresstxids failure', async () => {
      executeCallStub.resolves({ status: 'error', data: { message: 'RPC failed' } });
      await expect(explorerService.bootstrapAppHashes(2579000)).to.be.rejectedWith('getaddresstxids failed');
    });

    it('should throw on batch getrawtransaction failure', async () => {
      executeCallStub.resolves({ status: 'success', data: ['tx1'] });
      executeBatchCallStub.resolves({ status: 'error', data: { message: 'Batch failed' } });
      await expect(explorerService.bootstrapAppHashes(2579000)).to.be.rejectedWith('Batch getrawtransaction failed');
    });

    it('should tolerate individual tx errors in batch', async () => {
      executeCallStub.resolves({ status: 'success', data: ['tx1', 'tx2'] });
      executeBatchCallStub.resolves({
        status: 'success',
        data: [
          { id: 0, result: makeRpcTx('tx1', 700000, config.fluxapps.appPaymentAddresses[0].address, 500000000), error: null },
          { id: 1, result: null, error: { code: -5, message: 'Not found' } },
        ],
      });

      await explorerService.bootstrapAppHashes(2579000);
      const inserted = insertManyStub.getCall(0).args[2];
      expect(inserted).to.have.length(1);
    });

    it('should deduplicate txids from address overlap', async () => {
      executeCallStub.resolves({ status: 'success', data: ['tx1', 'tx1', 'tx2'] });
      executeBatchCallStub.resolves({
        status: 'success',
        data: [
          { id: 0, result: makeRpcTx('tx1', 700000, config.fluxapps.appPaymentAddresses[0].address, 500000000), error: null },
          { id: 1, result: makeRpcTx('tx2', 700001, config.fluxapps.appPaymentAddresses[0].address, 500000000), error: null },
        ],
      });

      await explorerService.bootstrapAppHashes(2579000);
      const batchCalls = executeBatchCallStub.getCall(0).args[0];
      expect(batchCalls).to.have.length(2);
    });

    it('should insert in chunks when exceeding threshold', async () => {
      const txids = Array.from({ length: 6000 }, (_, i) => `tx${i}`);
      executeCallStub.resolves({ status: 'success', data: txids });

      const batchResponses = [];
      for (let i = 0; i < 6000; i += 500) {
        const batch = [];
        for (let j = 0; j < 500 && i + j < 6000; j++) {
          const hexHash = Buffer.from(`hash${String(i + j).padStart(60, '0')}`).toString('hex');
          batch.push({
            id: j,
            result: {
              txid: `tx${i + j}`, version: 1, height: 700000 + i + j,
              vin: [{ address: 't1Sender' }],
              vout: [{ valueSat: 500000000, scriptPubKey: { addresses: [config.fluxapps.appPaymentAddresses[0].address], asm: `OP_RETURN ${hexHash}` } }],
            },
            error: null,
          });
        }
        batchResponses.push({ status: 'success', data: batch });
      }
      let callIdx = 0;
      executeBatchCallStub.callsFake(() => batchResponses[callIdx++]);

      await explorerService.bootstrapAppHashes(2579000);
      expect(insertManyStub.callCount).to.be.greaterThan(1);
    });
  });

  describe('bootstrapSoftForks tests', () => {
    const config = require('config');
    const multisigA = config.fluxapps.appPaymentAddresses[1].address;
    const multisigB = config.fluxapps.appPaymentAddresses[2].address;
    let executeCallStub;
    let executeBatchCallStub;
    let updateOneStub;

    // "p1_100000_200000_0.5_300_20_0.01_1_0" encoded as hex
    const priceForkMsg = 'p1_100000_200000_0.5_300_20_0.01_1_0';
    const priceForkHex = Buffer.from(priceForkMsg).toString('hex');

    function makeDelta(txid, address, satoshis) {
      return { txid, address, satoshis, index: 0, height: 1594832 };
    }

    function makeSoftForkTx(txid, height, msgHex) {
      return {
        txid,
        height,
        vin: [{ address: multisigA }],
        vout: [
          { valueSat: 100000, scriptPubKey: { addresses: [multisigA], asm: '' } },
          { valueSat: 0, scriptPubKey: { addresses: [], asm: `OP_RETURN ${msgHex}` } },
        ],
      };
    }

    beforeEach(async () => {
      await dbHelper.initiateDB();
      dbHelper.databaseConnection();
      executeCallStub = sinon.stub(daemonServiceUtils, 'executeCall');
      executeBatchCallStub = sinon.stub(daemonServiceUtils, 'executeBatchCall');
      updateOneStub = sinon.stub(dbHelper, 'updateOneInDatabase').resolves();
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should call getaddressdeltas for both multisig addresses', async () => {
      executeCallStub.resolves({ status: 'success', data: [] });

      await explorerService.bootstrapSoftForks(2579000);

      sinon.assert.calledOnce(executeCallStub);
      const { args } = executeCallStub.firstCall;
      expect(args[0]).to.equal('getaddressdeltas');
      expect(args[1][0].addresses).to.include(multisigA);
      expect(args[1][0].addresses).to.include(multisigB);
      expect(args[1][0].end).to.equal(2579000);
    });

    it('should identify self-send transactions and fetch them', async () => {
      executeCallStub.resolves({
        status: 'success',
        data: [
          makeDelta('selfTx1', multisigA, -500000),
          makeDelta('selfTx1', multisigA, 500000),
          makeDelta('onlySpend', multisigA, -100000),
          makeDelta('onlyReceive', multisigB, 200000),
        ],
      });
      executeBatchCallStub.resolves({
        status: 'success',
        data: [{ id: 0, result: makeSoftForkTx('selfTx1', 1594832, priceForkHex), error: null }],
      });

      await explorerService.bootstrapSoftForks(2579000);

      sinon.assert.calledOnce(executeBatchCallStub);
      const batch = executeBatchCallStub.firstCall.args[0];
      expect(batch).to.have.lengthOf(1);
      expect(batch[0].params[0]).to.equal('selfTx1');
    });

    it('should call processSoftFork for foundation-to-foundation tx with OP_RETURN', async () => {
      executeCallStub.resolves({
        status: 'success',
        data: [
          makeDelta('forkTx', multisigA, -500000),
          makeDelta('forkTx', multisigA, 500000),
        ],
      });
      executeBatchCallStub.resolves({
        status: 'success',
        data: [{ id: 0, result: makeSoftForkTx('forkTx', 1594832, priceForkHex), error: null }],
      });

      await explorerService.bootstrapSoftForks(2579000);

      const forkWrite = updateOneStub.getCalls().find(
        (c) => c.args[2]?.txid === 'forkTx',
      );
      expect(forkWrite).to.not.be.undefined;
      expect(forkWrite.args[3].$set.height).to.equal(1594832);
      expect(forkWrite.args[3].$set.message).to.equal(priceForkMsg);
    });

    it('should batch-fetch in chunks of 500', async () => {
      const deltas = [];
      for (let i = 0; i < 600; i++) {
        deltas.push(makeDelta(`tx${i}`, multisigA, -100));
        deltas.push(makeDelta(`tx${i}`, multisigA, 100));
      }
      executeCallStub.resolves({ status: 'success', data: deltas });
      executeBatchCallStub.resolves({ status: 'success', data: [] });

      await explorerService.bootstrapSoftForks(2579000);

      expect(executeBatchCallStub.callCount).to.equal(2);
      expect(executeBatchCallStub.firstCall.args[0]).to.have.lengthOf(500);
      expect(executeBatchCallStub.secondCall.args[0]).to.have.lengthOf(100);
    });

    it('should handle getaddressdeltas failure gracefully', async () => {
      const logWarnStub = sinon.stub(log, 'warn');
      executeCallStub.resolves({ status: 'error', data: { message: 'RPC unavailable' } });

      await explorerService.bootstrapSoftForks(2579000);

      expect(logWarnStub.calledWith(sinon.match(/getaddressdeltas failed/))).to.be.true;
      sinon.assert.notCalled(executeBatchCallStub);
      logWarnStub.restore();
    });

    it('should skip transactions without OP_RETURN message', async () => {
      executeCallStub.resolves({
        status: 'success',
        data: [
          makeDelta('noOpReturn', multisigA, -500000),
          makeDelta('noOpReturn', multisigA, 500000),
        ],
      });
      const txWithoutOpReturn = {
        txid: 'noOpReturn',
        height: 1594832,
        vin: [{ address: multisigA }],
        vout: [{ valueSat: 500000, scriptPubKey: { addresses: [multisigA], asm: '' } }],
      };
      executeBatchCallStub.resolves({
        status: 'success',
        data: [{ id: 0, result: txWithoutOpReturn, error: null }],
      });

      await explorerService.bootstrapSoftForks(2579000);

      sinon.assert.notCalled(updateOneStub);
    });
  });

  describe('soft-fork message authority', () => {
    const config = require('config');
    const priceOracleState = require('../../ZelBack/src/services/pricing/priceOracleState');
    afterEach(() => sinon.restore());

    // A real mainnet oracle RateMessage scriptSig: a P2PKH spend (72-byte signature
    // push tagged SIGHASH_ALL, then the 33-byte pubkey). The authority checks require
    // the input signature to commit to all outputs, so a valid scriptSig is needed.
    const ALL_SCRIPTSIG = '483045022100d8a57c5364a2eb062a6fdac519d665074a1a075dff2215eb15e17c4dfb170eef02203b96971b6a07f880a2d946de2155e3a296d3ebf02d1754cba1f4a648fc2e4591012103a9329557d633a7b261290f7c3b17506d460c3fcfd0cb8fd9339b27d4f583eca7';
    // Same signature re-tagged SIGHASH_NONE (hashtype byte 01 -> 02): binds inputs,
    // not outputs, so it must be rejected.
    const NONE_SCRIPTSIG = `${ALL_SCRIPTSIG.slice(0, 144)}02${ALL_SCRIPTSIG.slice(146)}`;
    const allSig = () => ({ scriptSig: { hex: ALL_SCRIPTSIG } });

    describe('isMessageAuthority', () => {
      it('accepts a tx whose authority input signs all outputs (SIGHASH_ALL)', () => {
        const addr = config.fluxapps.messageAuthorityAddress;
        const tx = { vin: [{ address: 'tSomeoneElse', ...allSig() }, { address: addr, ...allSig() }] };
        expect(explorerService.isMessageAuthority(tx)).to.equal(true);
      });
      it('rejects a tx with no input from the authority address', () => {
        const tx = { vin: [{ address: 'tSomeoneElse', ...allSig() }] };
        expect(explorerService.isMessageAuthority(tx)).to.equal(false);
      });
      it('rejects when the authority input does not sign all outputs (SIGHASH_NONE)', () => {
        const addr = config.fluxapps.messageAuthorityAddress;
        const tx = { vin: [{ address: addr, scriptSig: { hex: NONE_SCRIPTSIG } }] };
        expect(explorerService.isMessageAuthority(tx)).to.equal(false);
      });
      it('rejects when the authority input carries no signature', () => {
        const addr = config.fluxapps.messageAuthorityAddress;
        const tx = { vin: [{ address: addr }] };
        expect(explorerService.isMessageAuthority(tx)).to.equal(false);
      });
    });

    describe('isOracleSigner', () => {
      // pubKeyToAddr(pubkeyHex, '1cb8') === oracleAddr (Flux t1 P2PKH derivation)
      const pubkeyHex = '02c7f5b5e6e7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4';
      const oracleAddr = 't1NfrwmYygJYwm4krB9KkhnBNLRffuCqvw8';
      const oracleKeyInForce = () => sinon.stub(priceOracleState, 'getOracleKeyHistory').returns({
        resolveAt: () => ({ pubkey: Buffer.from(pubkeyHex, 'hex') }),
      });

      it('accepts a RateMessage tx signed by the on-chain oracle key with SIGHASH_ALL', () => {
        oracleKeyInForce();
        const tx = { vin: [{ address: oracleAddr, ...allSig() }] };
        expect(explorerService.isOracleSigner(tx, 100)).to.equal(true);
      });

      it('rejects when no oracle key is in force at the height', () => {
        sinon.stub(priceOracleState, 'getOracleKeyHistory').returns({ resolveAt: () => null });
        const tx = { vin: [{ address: oracleAddr, ...allSig() }] };
        expect(explorerService.isOracleSigner(tx, 100)).to.equal(false);
      });

      it('rejects a tx not signed by the oracle key', () => {
        oracleKeyInForce();
        const tx = { vin: [{ address: 't1SomeoneElse', ...allSig() }] };
        expect(explorerService.isOracleSigner(tx, 100)).to.equal(false);
      });

      it('rejects an oracle input that does not sign all outputs (SIGHASH_NONE)', () => {
        oracleKeyInForce();
        const tx = { vin: [{ address: oracleAddr, scriptSig: { hex: NONE_SCRIPTSIG } }] };
        expect(explorerService.isOracleSigner(tx, 100)).to.equal(false);
      });
    });
  });
});
