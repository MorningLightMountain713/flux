'use strict';

const sinon = require('sinon');
const config = require('config');
const daemonSubscriptionService = require('../../ZelBack/src/services/daemonService/daemonSubscriptionService');
const proxyquire = require('proxyquire');
const explorerService = require('../../ZelBack/src/services/explorerService');
const chainState = require('../../ZelBack/src/services/chainState');
const specLibs = require('../../ZelBack/src/services/utils/specLibs');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const specReconciler = require('../../ZelBack/src/services/appLifecycle/specReconciler');
const appGiveUp = require('../../ZelBack/src/services/appLifecycle/appGiveUp');
const appOperations = require('../../ZelBack/src/services/appLifecycle/appOperations');
const appQueryService = require('../../ZelBack/src/services/appQuery/appQueryService');
const portManager = require('../../ZelBack/src/services/appNetwork/portManager');
const daemonServiceBlockchainRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceBlockchainRpcs');
const daemonStatus = require('../../ZelBack/src/services/daemonService/daemonStatus');
const capabilities = require('../../ZelBack/src/services/utils/capabilities');
const daemonServiceUtils = require('../../ZelBack/src/services/daemonService/daemonServiceUtils');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const { stubMessages } = require('./fixtures/appRecords');
const log = require('../../ZelBack/src/lib/log');
const { requireMongo } = require('./dbTestHelper');

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const priceOracleState = require('../../ZelBack/src/services/pricing/priceOracleState');
const unclaimedPayments = require('../../ZelBack/src/services/appDecisions/unclaimedPayments');
const decider = require('../../ZelBack/src/services/appDecisions/decider');
const fluxSpecCjs = require('@runonflux/flux-spec-cjs');
const specLibrary = require('../../ZelBack/src/services/utils/specLibrary');

// 320-char OP_RETURN payload, hoisted so the call site stays inside max-len.
// A standard P2PKH output's script, as the daemon reports it. Every payment output
// carries one, so a soft-fork fixture's payment output does too.
const PAY_ASM = 'OP_DUP OP_HASH160 8f1c27f0e5d0b0a8fdcb5a8e6e1fbb7f0c6b2a31 OP_EQUALVERIFY OP_CHECKSIG';
const longAsm = 'OP_RETURN 6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738394142434445464748494a4b4c4d4e4f505152535455565758595a3031';

chai.use(chaiAsPromised);
const { expect } = chai;

describe('explorerService tests', () => {
  // The app messages every block of tests reads and writes: a stub per test.
  let messages;
  beforeEach(() => { messages = stubMessages(); });

  // The daemon is synced and the local database prepared unless a test says otherwise.
  beforeEach(() => {
    capabilities.resetForTests();
    capabilities.setForTests(['daemonSynced', 'localDbPrepared'], true);
  });
  after(() => capabilities.resetForTests());

  describe('explorerSynced', () => {
    it('rises within two blocks of the tip and falls only beyond ten', () => {
      capabilities.setForTests('chainStateConsistent', true);
      explorerService.publishExplorerSynced(98, 100);
      expect(capabilities.isUp('explorerSynced')).to.equal(true);
      explorerService.publishExplorerSynced(90, 100);
      expect(capabilities.isUp('explorerSynced'), 'ten behind is inside the band').to.equal(true);
      explorerService.publishExplorerSynced(89, 100);
      expect(capabilities.isUp('explorerSynced')).to.equal(false);
      explorerService.publishExplorerSynced(95, 100);
      expect(capabilities.isUp('explorerSynced'), 'five behind does not bring it back').to.equal(false);
    });

    it('falls with chain state', () => {
      capabilities.setForTests('chainStateConsistent', true);
      explorerService.publishExplorerSynced(100, 100);
      capabilities.setForTests('chainStateConsistent', false);
      expect(capabilities.isUp('explorerSynced')).to.equal(false);
    });
  });

  before(requireMongo);

  // initiateBlockProcessor ends by starting the scan loop. Stop it between tests so a
  // loop from one test cannot still be advancing during the next one's assertions.
  afterEach(async () => {
    await explorerService.stopScanning();
  });

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
      sinon.assert.calledOnceWithExactly(daemonServiceBlockchainRpcsStub, { hashheight: '12345', verbosity: 2 });
    });

    it('should return data if daemonService returns data', async () => {
      daemonServiceBlockchainRpcsStub.returns({
        status: 'success',
        data: 'test data',
      });

      const result = await explorerService.getVerboseBlock(hash);
      expect(result).to.eql('test data');
      sinon.assert.calledOnceWithExactly(daemonServiceBlockchainRpcsStub, { hashheight: '12345', verbosity: 2 });
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
              valueSat: 20_000_000,
            }],
          },
        ],
        height: 983_000,
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
        height: 983_000,
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
              valueSat: 20_000_000,
            }],
          },
        ],
        height: 1,
      };
      await explorerService.processInsight(blockVerbose, database);

      sinon.assert.notCalled(dbStubInsert);
    });
  });

  describe('processOneBlock tests', () => {
    let dbStubUpdate;
    let dbStubCollectionStats;
    let logInfoSpy;
    let blockScannedStub;
    let reconcileInstalledAppsStub;
    let restorePortsSupportStub;
    let daemonServiceBlockchainRpcsStub;
    let daemonStatusStub;

    beforeEach(async () => {
      // An unsynced daemon makes processBlock retry itself in two minutes. Left
      // real, that timer outlives this file and re-enters block processing
      // against restored stubs.
      sinon.useFakeTimers({ toFake: ['setTimeout'], shouldAdvanceTime: true });
      sinon.stub(dbHelper, 'findOneInDatabase');
      sinon.stub(dbHelper, 'insertManyToDatabase');
      dbStubUpdate = sinon.stub(dbHelper, 'updateOneInDatabase');
      dbStubCollectionStats = sinon.stub(dbHelper, 'collectionStats');
      blockScannedStub = sinon.stub(chainState, 'blockScanned').resolves();
      reconcileInstalledAppsStub = sinon.stub(specReconciler, 'requestFullConvergence');
      restorePortsSupportStub = sinon.stub(portManager, 'restorePortsSupport');
      await dbHelper.initiateDB();
      dbHelper.databaseConnection();
      daemonStatusStub = sinon.stub(daemonStatus, 'isDaemonSynced');
      daemonServiceBlockchainRpcsStub = sinon.stub(daemonServiceBlockchainRpcs, 'getBlock');
      logInfoSpy = sinon.spy(log, 'info');
      capabilities.setForTests('appRegistryConsistent', true);
    });

    afterEach(() => {
      capabilities.setForTests('appRegistryConsistent', false);
      sinon.restore();
    });

    it('should update db if all parameters are passed correctly, block height == 695000', async () => {
      const blockHeight = 695_000;
      const isInsightExplorer = true;
      dbStubUpdate.returns(true);
      // prevent infinite func loop while testing
      dbStubCollectionStats.returns({
        size: 10_000,
        count: 15,
        avgObjSize: 1111,
      });
      daemonStatusStub.returns({
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
                valueSat: 20_000_000,
              }],
            },
          ],
          height: 695_000,
          time: 1_700_000_000,
          confirmations: 1,
        },
      });

      await explorerService.processOneBlock(blockHeight, isInsightExplorer, { atTip: true });

      sinon.assert.calledOnceWithExactly(blockScannedStub, { height: 695_000, time: 1_700_000_000 });
      sinon.assert.notCalled(restorePortsSupportStub);
      sinon.assert.calledOnceWithMatch(
        dbStubUpdate,
        sinon.match.object,
        'scannedheight',
        { generalScannedHeight: { $gte: 0 } },
        { $set: { generalScannedHeight: 695_000 } },
        { upsert: true },
      );
      sinon.assert.calledWith(logInfoSpy, 'Processing Explorer Block Height: 695000');
    });

    it('hands the give-up pass the installed apps and the elected-primary check at a removal-period tip block', async () => {
      // 695,002 is a multiple of removeFluxAppsPeriod (11) below the PON fork, and of
      // neither the hash-rebuild nor the benchmark period.
      const blockHeight = 695_002;
      const giveUpStub = sinon.stub(appGiveUp, 'checkAndGiveUpAnApp').resolves();
      dbStubUpdate.returns(true);
      dbStubCollectionStats.returns({ size: 10_000, count: 15, avgObjSize: 1111 });
      daemonStatusStub.returns({ data: { synced: true } });
      daemonServiceBlockchainRpcsStub.returns({
        status: 'success',
        data: {
          tx: [], height: blockHeight, time: 1_700_000_000, confirmations: 1,
        },
      });

      await explorerService.processOneBlock(blockHeight, true, { atTip: true });

      sinon.assert.calledOnce(giveUpStub);
      const [deps] = giveUpStub.firstCall.args;
      expect(deps.installedAppsFn).to.equal(appQueryService.installedApps);
      expect(deps.isElectedPrimary).to.equal(appOperations.isElectedPrimary);
    });

    it('past the Proof of Node height the removal period counts four blocks for each of the chain\'s first', async () => {
      // 2,020,007 is a multiple of removeFluxAppsPeriod (11) and not of 44;
      // 2,020,040 is a multiple of 44.
      const giveUpStub = sinon.stub(appGiveUp, 'checkAndGiveUpAnApp').resolves();
      dbStubUpdate.returns(true);
      dbStubCollectionStats.returns({ size: 10_000, count: 15, avgObjSize: 1111 });
      daemonStatusStub.returns({ data: { synced: true } });
      for (const blockHeight of [2_020_007, 2_020_040]) {
        daemonServiceBlockchainRpcsStub.returns({
          status: 'success',
          data: {
            tx: [], height: blockHeight, time: 1_700_000_000, confirmations: 1,
          },
        });
        // eslint-disable-next-line no-await-in-loop
        await explorerService.processOneBlock(blockHeight, true, { atTip: true });
      }

      sinon.assert.calledOnce(giveUpStub);
    });

    it('should update db if all parameters are passed correctly, height == 900009', async () => {
      const blockHeight = 900_009;
      const isInsightExplorer = true;
      dbStubUpdate.returns(true);
      reconcileInstalledAppsStub.returns(true);
      // prevent infinite func loop while testing
      dbStubCollectionStats.returns({
        size: 10_000,
        count: 15,
        avgObjSize: 1111,
      });
      daemonStatusStub.returns({
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
                valueSat: 20_000_000,
              }],
            },
          ],
          height: 900_009,
          confirmations: 1,
        },
      });

      await explorerService.processOneBlock(blockHeight, isInsightExplorer, { atTip: true });

      sinon.assert.calledOnceWithMatch(blockScannedStub, { height: 900_009 });
      sinon.assert.notCalled(restorePortsSupportStub);
      sinon.assert.calledOnceWithMatch(
        dbStubUpdate,
        sinon.match.object,
        'scannedheight',
        { generalScannedHeight: { $gte: 0 } },
        { $set: { generalScannedHeight: 900_009 } },
        { upsert: true },
      );
    });

    // Catching up, the cursor is written every explorerCursorBatchSize blocks
    // (500 here), and each write names the block the registry's clock moves to.
    it('reports a block the scan catches up past only when it writes the cursor', async () => {
      dbStubCollectionStats.returns({ size: 10_000, count: 15, avgObjSize: 1111 });
      daemonStatusStub.returns({ data: { synced: false } });
      const block = (height) => ({
        status: 'success', data: { tx: [], height, time: 1_700_000_000, confirmations: 10 },
      });

      daemonServiceBlockchainRpcsStub.returns(block(900_499));
      await explorerService.processOneBlock(900_499, true, { atTip: false });
      sinon.assert.notCalled(blockScannedStub);

      daemonServiceBlockchainRpcsStub.returns(block(900_500));
      await explorerService.processOneBlock(900_500, true, { atTip: false });
      sinon.assert.calledOnceWithExactly(blockScannedStub, { height: 900_500, time: 1_700_000_000 });
    });

    it('should update db if all parameters are passed correctly, height == 900025', async () => {
      const blockHeight = 900_025;
      const isInsightExplorer = true;
      dbStubUpdate.returns(true);
      reconcileInstalledAppsStub.returns(true);
      // prevent infinite func loop while testing
      dbStubCollectionStats.returns({
        size: 10_000,
        count: 15,
        avgObjSize: 1111,
      });
      daemonStatusStub.returns({
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
                valueSat: 20_000_000,
              }],
            },
          ],
          height: 900_025,
          confirmations: 1,
        },
      });

      await explorerService.processOneBlock(blockHeight, isInsightExplorer, { atTip: true });

      sinon.assert.calledOnceWithMatch(blockScannedStub, { height: 900_025 });
      sinon.assert.calledOnceWithMatch(
        dbStubUpdate,
        sinon.match.object,
        'scannedheight',
        { generalScannedHeight: { $gte: 0 } },
        { $set: { generalScannedHeight: 900_025 } },
        { upsert: true },
      );
    });
  });

  // THE PRODUCER. appSyncOrchestrator subscribes to hashesChanged and brings its
  // next hash retry forward to the current block. Without the emit the audit
  // repaired rows that nothing then went looking for until their own scheduled
  // height came round again - a listener with no producer, which is how it was.
  describe('initiateBlockProcessor tests', () => {
    let findInDatabaseStub;
    let getBlockCountStub;
    let dropCollectionStub;
    let logErrorSpy;
    let logInfoSpy;

    beforeEach(async () => {
      findInDatabaseStub = sinon.stub(dbHelper, 'findOneInDatabase');
      dropCollectionStub = sinon.stub(dbHelper, 'dropCollection');
      sinon.stub(daemonStatus, 'isDaemonSynced').returns({ data: { synced: true } });
      getBlockCountStub = sinon.stub(daemonServiceBlockchainRpcs, 'getBlockCount');
      sinon.stub(daemonServiceUtils, 'getConfigValue').returns('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ'); // Valid WIF private key
      await dbHelper.initiateDB();
      dbHelper.databaseConnection();
      logErrorSpy = sinon.spy(log, 'error');
      logInfoSpy = sinon.spy(log, 'info');
      sinon.stub(dbHelper, 'insertManyToDatabase').returns(true);
      sinon.stub(dbHelper, 'updateOneInDatabase').returns(true);
      sinon.stub(dbHelper, 'collectionStats').returns({
        size: 10_000,
        count: 15,
        avgObjSize: 1111,
      });
      sinon.stub(chainState, 'blockScanned').resolves();
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
                valueSat: 20_000_000,
              }],
            },
          ],
          height: 695_000,
          confirmations: 1,
        },
      });
    });

    afterEach(() => {
      explorerService.setIsInInitiationOfBP(false);
      sinon.restore();
    });

    it('should return right away if isInInitiationOfBP is true', async () => {
      explorerService.setIsInInitiationOfBP(true);

      const result = await explorerService.initiateBlockProcessor({ deepRestore: true });

      expect(result).to.be.undefined;
      sinon.assert.notCalled(findInDatabaseStub);
    });

    it('should throw and log error if getBlockCount does not return success', async () => {
      sinon.stub(dbHelper, 'countInDatabase').resolves(1);
      getBlockCountStub.returns({
        status: 'error',
        data: {
          message: 'message',
        },
      });

      await explorerService.initiateBlockProcessor({});
      await serviceHelper.delay(200);

      sinon.assert.calledOnce(logErrorSpy);
      sinon.assert.calledWithMatch(findInDatabaseStub, sinon.match.object, 'scannedheight', { generalScannedHeight: { $gte: 0 } }, { projection: { _id: 0, generalScannedHeight: 1 } });
    });

    it('should run the block processor, all params false', async () => {
      sinon.stub(dbHelper, 'removeDocumentsFromCollection').resolves(true);
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
        data: 200_000,
      });
      sinon.stub(daemonStatus, 'isInsightExplorer').returns(true);
      sinon.stub(daemonServiceUtils, 'executeCall').resolves({ status: 'success', data: [] });
      sinon.stub(daemonServiceUtils, 'executeBatchCall').resolves({ status: 'success', data: [] });

      await explorerService.initiateBlockProcessor({});
      await serviceHelper.delay(200);

      sinon.assert.notCalled(logErrorSpy);
      sinon.assert.calledWithMatch(logInfoSpy, 'Bootstrap: Using address-index fast path');
      sinon.assert.calledWithMatch(logInfoSpy, 'Bootstrap complete');
      sinon.assert.calledWithMatch(logInfoSpy, 'Preparing apps collections');
      sinon.assert.calledWithMatch(logInfoSpy, 'Preparation done');
    });

    it('should fall back to block-by-block scan when bootstrap fails', async () => {
      sinon.stub(dbHelper, 'removeDocumentsFromCollection').resolves(true);
      findInDatabaseStub.returns({ generalScannedHeight: 0 });
      dropCollectionStub.resolves(true);
      sinon.stub(dbHelper, 'findInDatabase').resolves([]);
      sinon.stub(dbHelper, 'countInDatabase').resolves(1);
      const createIndexFake = sinon.fake.resolves(true);
      const collectionFake = sinon.fake.returns({ createIndex: createIndexFake, updateMany: sinon.fake.resolves({ modifiedCount: 0 }), indexes: sinon.fake.resolves([]) });
      const dbFake = sinon.fake.returns({ collection: collectionFake });
      sinon.stub(dbHelper, 'databaseConnection').returns({ db: dbFake });
      getBlockCountStub.returns({ status: 'success', data: 200_000 });
      sinon.stub(daemonStatus, 'isInsightExplorer').returns(true);
      sinon.stub(daemonServiceUtils, 'executeCall').resolves({ status: 'error', data: { message: 'RPC unavailable' } });

      await explorerService.initiateBlockProcessor({});
      await serviceHelper.delay(200);

      sinon.assert.calledWithMatch(logErrorSpy, 'Bootstrap failed, falling back to block-by-block scan');
      // initiateBlockProcessor now leaves the cursor where scanning should resume and
      // enables scanning; which block gets written next is the drain's business.
      expect(explorerService.scanning()).to.equal(true);
    });

    it('should rewind to the cursor and scan, height > 0', async () => {
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
        data: 200_000,
      });
      sinon.stub(daemonStatus, 'isInsightExplorer').returns(true);

      await explorerService.initiateBlockProcessor();
      await serviceHelper.delay(200);

      sinon.assert.notCalled(logErrorSpy);
      expect(explorerService.scanning()).to.equal(true);
      sinon.assert.calledWithMatch(logInfoSpy, 'Chain state - rewinding from 1000 to 1000: restore at start');
      expect(capabilities.isUp('chainStateConsistent')).to.equal(true);
    });

    it('builds chain state before the daemon is synced, and scans only once it is', async () => {
      capabilities.setForTests('daemonSynced', false);
      sinon.stub(dbHelper, 'removeDocumentsFromCollection').resolves(true);
      sinon.stub(dbHelper, 'findInDatabase').resolves([]);
      sinon.stub(dbHelper, 'countInDatabase').resolves(1);
      findInDatabaseStub.returns({ generalScannedHeight: 1000 });
      const dbFake = sinon.fake.returns({ collection: sinon.fake.returns({ indexes: sinon.fake.resolves([]) }) });
      sinon.stub(dbHelper, 'databaseConnection').returns({ db: dbFake });
      getBlockCountStub.returns({ status: 'success', data: 1000 });
      sinon.stub(daemonStatus, 'isInsightExplorer').returns(false);

      const started = explorerService.initiateBlockProcessor();
      await serviceHelper.delay(100);

      expect(capabilities.isUp('chainStateConsistent')).to.equal(true);
      sinon.assert.notCalled(getBlockCountStub);
      expect(explorerService.scanning()).to.equal(false);

      capabilities.setForTests('daemonSynced', true);
      await started;
      expect(explorerService.scanning()).to.equal(true);
    });

    it('scans only once the local database is prepared', async () => {
      capabilities.setForTests('localDbPrepared', false);
      sinon.stub(dbHelper, 'removeDocumentsFromCollection').resolves(true);
      sinon.stub(dbHelper, 'findInDatabase').resolves([]);
      sinon.stub(dbHelper, 'countInDatabase').resolves(1);
      findInDatabaseStub.returns({ generalScannedHeight: 1000 });
      const dbFake = sinon.fake.returns({ collection: sinon.fake.returns({ indexes: sinon.fake.resolves([]) }) });
      sinon.stub(dbHelper, 'databaseConnection').returns({ db: dbFake });
      getBlockCountStub.returns({ status: 'success', data: 1000 });
      sinon.stub(daemonStatus, 'isInsightExplorer').returns(false);

      const started = explorerService.initiateBlockProcessor();
      await serviceHelper.delay(100);

      expect(capabilities.isUp('chainStateConsistent')).to.equal(true);
      sinon.assert.notCalled(getBlockCountStub);

      capabilities.setForTests('localDbPrepared', true);
      await started;
      expect(explorerService.scanning()).to.equal(true);
    });

    it('leaves chain state alone when an initiation is already running', async () => {
      capabilities.setForTests('chainStateConsistent', true);
      const moves = [];
      capabilities.onTransition('chainStateConsistent', (record) => moves.push(record.to));
      explorerService.setIsInInitiationOfBP(true);

      await explorerService.initiateBlockProcessor({ deepRestore: true });

      expect(moves).to.deep.equal([]);
    });

    it('should rewind below the cursor with deepRestore and scan, height > 0', async () => {
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
        data: 200_000,
      });
      sinon.stub(daemonStatus, 'isInsightExplorer').returns(true);

      await explorerService.initiateBlockProcessor({ deepRestore: true });
      await serviceHelper.delay(200);

      sinon.assert.notCalled(logErrorSpy);
      expect(explorerService.scanning()).to.equal(true);
      const deepRestoreBlocks = config.get('fluxapps.explorerDeepRestoreBlocks');
      sinon.assert.calledWithMatch(logInfoSpy, `Chain state - rewinding from 1000 to ${1000 - deepRestoreBlocks}: deep restore at start`);
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
        data: 200_000,
      });
      sinon.stub(daemonStatus, 'isInsightExplorer').returns(true);
      sinon.stub(daemonServiceUtils, 'executeCall').resolves({ status: 'success', data: [] });
      sinon.stub(daemonServiceUtils, 'executeBatchCall').resolves({ status: 'success', data: [] });

      await explorerService.initiateBlockProcessor({ rescanGlobalApps: true });
      await serviceHelper.delay(200);

      sinon.assert.notCalled(logErrorSpy);
      sinon.assert.calledWithMatch(logInfoSpy, 'Bootstrap: Using address-index fast path');
      sinon.assert.calledWithMatch(logInfoSpy, 'Preparing apps collections');
      sinon.assert.calledWithMatch(logInfoSpy, 'Preparation done');
      sinon.assert.calledOnce(messages.clearPayments);
    });
  });

  describe('getPriceSpecForHeight tests', () => {
    it('should return correct price spec via binary search', () => {
      const specs = [
        { height: -1, minPrice: 1 },
        { height: 983_000, minPrice: 0.1 },
        { height: 1_004_000, minPrice: 0.01 },
      ];
      expect(explorerService.getPriceSpecForHeight(specs, 500_000).minPrice).to.equal(1);
      expect(explorerService.getPriceSpecForHeight(specs, 983_001).minPrice).to.equal(0.1);
      expect(explorerService.getPriceSpecForHeight(specs, 2_000_000).minPrice).to.equal(0.01);
    });
  });

  describe('processBootstrapTx tests', () => {
    const priceSpecs = [{ height: -1, minPrice: 0.01 }];

    function makeTx(overrides = {}) {
      return {
        txid: 'abc123',
        version: 1,
        height: 700_000,
        blocktime: 1_750_000_000,
        vin: [{ address: 't1SenderAddr' }],
        vout: [{
          valueSat: 500_000_000,
          scriptPubKey: {
            addresses: [config.fluxapps.appPaymentAddresses[0].address],
            asm: longAsm,
          },
        }],
        ...overrides,
      };
    }

    it('makes a payment record with the transaction position and block time', () => {
      const record = explorerService.processBootstrapTx(makeTx(), priceSpecs, 7);
      expect(record.txid).to.equal('abc123');
      expect(record.txIndex).to.equal(7);
      expect(record.hash).to.have.length(64);
      // the confirming block's timestamp rides the row — it becomes v9 registeredAt
      expect(record.blockTime).to.equal(1_750_000_000);
    });

    it('makes no record for a tx with version >= 5', () => {
      expect(explorerService.processBootstrapTx(makeTx({ version: 5 }), priceSpecs, 0)).to.equal(null);
    });

    it('makes no record for a payment below minPrice', () => {
      const tx = makeTx({ vout: [{ valueSat: 100, scriptPubKey: { addresses: [config.fluxapps.appPaymentAddresses[0].address], asm: longAsm } }] });
      expect(explorerService.processBootstrapTx(tx, [{ height: -1, minPrice: 1 }], 0)).to.equal(null);
    });

    it('makes no record for a soft fork (handled by bootstrapSoftForks pre-pass)', () => {
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
      expect(explorerService.processBootstrapTx(tx, priceSpecs, 0)).to.equal(null);
    });

    it('does not count a multisig payment before enforcement height', () => {
      const tx = makeTx({
        height: 1_200_000,
        vout: [{
          valueSat: 500_000_000,
          scriptPubKey: {
            addresses: [config.fluxapps.appPaymentAddresses[1].address],
            asm: 'OP_RETURN 6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435363738394142434445464748494a4b4c4d4e4f505152535455565758595a3031',
          },
        }],
      });
      expect(explorerService.processBootstrapTx(tx, priceSpecs, 0)).to.equal(null);
    });
  });

  describe('bootstrapAppHashes tests', () => {
    const PAY = config.fluxapps.appPaymentAddresses[0].address;
    let executeCallStub;
    let executeBatchCallStub;
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

    // The address index answers the payment addresses with `deltas`, and every
    // other address set (the soft-fork signers) with nothing.
    function addressIndex(deltas) {
      const paymentAddresses = config.fluxapps.appPaymentAddresses.map((entry) => entry.address);
      executeCallStub.callsFake(async (method, [{ addresses }]) => {
        if (method === 'getaddressdeltas' && addresses.every((address) => paymentAddresses.includes(address))) {
          return { status: 'success', data: deltas };
        }
        return { status: 'success', data: [] };
      });
    }
    const delta = (txid, height, blockindex, satoshis = 500_000_000) => ({
      txid, height, blockindex, satoshis, address: PAY,
    });
    const answer = (...txs) => ({ status: 'success', data: txs.map((tx, id) => ({ id, result: tx, error: null })) });

    beforeEach(async () => {
      await dbHelper.initiateDB();
      dbHelper.databaseConnection();
      executeCallStub = sinon.stub(daemonServiceUtils, 'executeCall');
      executeBatchCallStub = sinon.stub(daemonServiceUtils, 'executeBatchCall');
      sinon.stub(dbHelper, 'insertManyToDatabase').resolves();
      updateOneStub = sinon.stub(dbHelper, 'updateOneInDatabase').resolves();
    });

    afterEach(() => {
      sinon.restore();
    });

    it('records each payment with its position and moves the cursor', async () => {
      addressIndex([delta('tx1', 700_000, 3), delta('tx2', 700_001, 1)]);
      executeBatchCallStub.resolves(answer(makeRpcTx('tx1', 700_000, PAY, 500_000_000, hashHex1), makeRpcTx('tx2', 700_001, PAY, 500_000_000, hashHex2)));

      await explorerService.bootstrapAppHashes(2_579_000);

      sinon.assert.calledOnce(messages.recordPayments);
      const inserted = messages.recordPayments.getCall(0).args[0];
      expect(inserted.map((record) => [record.txid, record.txIndex])).to.deep.equal([['tx1', 3], ['tx2', 1]]);

      const updateCall = updateOneStub.getCalls().find((c) => c.args[1] === config.database.daemon.collections.scannedHeight);
      expect(updateCall.args[3].$set.generalScannedHeight).to.equal(2_579_000);
    });

    it('keeps the first payment of a hash paid twice in one block, whatever order the daemon answers in', async () => {
      addressIndex([delta('later', 700_000, 9), delta('earlier', 700_000, 2)]);
      executeBatchCallStub.resolves(answer(makeRpcTx('later', 700_000, PAY, 500_000_000, hashHex1), makeRpcTx('earlier', 700_000, PAY, 500_000_000, hashHex1)));

      await explorerService.bootstrapAppHashes(2_579_000);

      const inserted = messages.recordPayments.getCall(0).args[0];
      expect(inserted.map((record) => record.txid)).to.deep.equal(['earlier']);
    });

    it('does not fetch a transaction that only spends from a payment address', async () => {
      addressIndex([delta('pay', 700_000, 0), delta('spend', 700_002, 0, -500_000_000)]);
      executeBatchCallStub.resolves(answer(makeRpcTx('pay', 700_000, PAY, 500_000_000)));

      await explorerService.bootstrapAppHashes(2_579_000);
      expect(executeBatchCallStub.getCall(0).args[0].map((call) => call.params[0])).to.deep.equal(['pay']);
    });

    it('throws when the address index fails', async () => {
      executeCallStub.resolves({ status: 'error', data: { message: 'RPC failed' } });
      await expect(explorerService.bootstrapAppHashes(2_579_000)).to.be.rejectedWith('getaddressdeltas failed');
    });

    it('throws when the address index gives no position', async () => {
      addressIndex([{ txid: 'tx1', height: 700_000, satoshis: 500_000_000, address: PAY }]);
      await expect(explorerService.bootstrapAppHashes(2_579_000)).to.be.rejectedWith('no blockindex for tx1');
    });

    it('throws on batch getrawtransaction failure', async () => {
      addressIndex([delta('tx1', 700_000, 0)]);
      executeBatchCallStub.resolves({ status: 'error', data: { message: 'Batch failed' } });
      await expect(explorerService.bootstrapAppHashes(2_579_000)).to.be.rejectedWith('Batch getrawtransaction failed');
    });

    it('tolerates individual tx errors in batch', async () => {
      addressIndex([delta('tx1', 700_000, 0), delta('tx2', 700_001, 0)]);
      executeBatchCallStub.resolves({
        status: 'success',
        data: [
          { id: 0, result: makeRpcTx('tx1', 700_000, PAY, 500_000_000), error: null },
          { id: 1, result: null, error: { code: -5, message: 'Not found' } },
        ],
      });

      await explorerService.bootstrapAppHashes(2_579_000);
      expect(messages.recordPayments.getCall(0).args[0]).to.have.length(1);
    });

    it('fetches a transaction once when several of its outputs pay', async () => {
      addressIndex([delta('tx1', 700_000, 0), delta('tx1', 700_000, 0), delta('tx2', 700_001, 0)]);
      executeBatchCallStub.resolves(answer(makeRpcTx('tx1', 700_000, PAY, 500_000_000), makeRpcTx('tx2', 700_001, PAY, 500_000_000, hashHex2)));

      await explorerService.bootstrapAppHashes(2_579_000);
      expect(executeBatchCallStub.getCall(0).args[0]).to.have.length(2);
    });

    it('inserts in chunks', async () => {
      const count = 6000;
      addressIndex(Array.from({ length: count }, (_, i) => delta(`tx${i}`, 700_000 + i, 0)));
      executeBatchCallStub.callsFake(async (calls) => ({
        status: 'success',
        data: calls.map(({ params: [txid] }, id) => ({
          id,
          result: makeRpcTx(txid, 700_000 + Number(txid.slice(2)), PAY, 500_000_000, Buffer.from(`hash${txid.padStart(60, '0')}`).toString('hex')),
          error: null,
        })),
      }));

      await explorerService.bootstrapAppHashes(2_579_000);
      expect(messages.recordPayments.callCount).to.equal(2);
      expect(messages.recordPayments.getCalls().reduce((sum, call) => sum + call.args[0].length, 0)).to.equal(count);
    });
  });

  describe('bootstrapSoftForks tests', () => {
    const multisigA = config.fluxapps.appPaymentAddresses[1].address;
    const multisigB = config.fluxapps.appPaymentAddresses[2].address;
    let executeCallStub;
    let executeBatchCallStub;
    let updateOneStub;

    // "p1_100000_200000_0.5_300_20_0.01_1_0" encoded as hex
    const priceForkMsg = 'p1_100000_200000_0.5_300_20_0.01_1_0';
    const priceForkHex = Buffer.from(priceForkMsg).toString('hex');

    function makeDelta(txid, address, satoshis) {
      // blockindex is the transaction's position in its block, which is what a
      // soft-fork message is ordered by; index is the input/output index within
      // the transaction, and is not it.
      return { txid, address, satoshis, blockindex: 0, index: 0, height: 1_594_832 };
    }

    function makeSoftForkTx(txid, height, msgHex, { opReturnFirst = false } = {}) {
      const payment = { valueSat: 100_000, scriptPubKey: { addresses: [multisigA], asm: PAY_ASM } };
      const data = { valueSat: 0, scriptPubKey: { addresses: [], asm: `OP_RETURN ${msgHex}` } };
      return {
        txid,
        height,
        vin: [{ address: multisigA }],
        vout: opReturnFirst ? [data, payment] : [payment, data],
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

      await explorerService.bootstrapSoftForks(2_579_000);

      sinon.assert.calledOnce(executeCallStub);
      const { args } = executeCallStub.firstCall;
      expect(args[0]).to.equal('getaddressdeltas');
      expect(args[1][0].addresses).to.include(multisigA);
      expect(args[1][0].addresses).to.include(multisigB);
      expect(args[1][0].end).to.equal(2_579_000);
    });

    it('should identify self-send transactions and fetch them', async () => {
      executeCallStub.resolves({
        status: 'success',
        data: [
          makeDelta('selfTx1', multisigA, -500_000),
          makeDelta('selfTx1', multisigA, 500_000),
          makeDelta('onlySpend', multisigA, -100_000),
          makeDelta('onlyReceive', multisigB, 200_000),
        ],
      });
      executeBatchCallStub.resolves({
        status: 'success',
        data: [{ id: 0, result: makeSoftForkTx('selfTx1', 1_594_832, priceForkHex), error: null }],
      });

      await explorerService.bootstrapSoftForks(2_579_000);

      sinon.assert.calledOnce(executeBatchCallStub);
      const batch = executeBatchCallStub.firstCall.args[0];
      expect(batch).to.have.lengthOf(1);
      expect(batch[0].params[0]).to.equal('selfTx1');
    });

    it('should call processSoftFork for foundation-to-foundation tx with OP_RETURN', async () => {
      executeCallStub.resolves({
        status: 'success',
        data: [
          makeDelta('forkTx', multisigA, -500_000),
          makeDelta('forkTx', multisigA, 500_000),
        ],
      });
      executeBatchCallStub.resolves({
        status: 'success',
        data: [{ id: 0, result: makeSoftForkTx('forkTx', 1_594_832, priceForkHex), error: null }],
      });

      await explorerService.bootstrapSoftForks(2_579_000);

      const forkWrite = updateOneStub.getCalls().find(
        (c) => c.args[2]?.txid === 'forkTx',
      );
      expect(forkWrite).to.not.be.undefined;
      expect(forkWrite.args[3].$set.height).to.equal(1_594_832);
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

      await explorerService.bootstrapSoftForks(2_579_000);

      expect(executeBatchCallStub.callCount).to.equal(2);
      expect(executeBatchCallStub.firstCall.args[0]).to.have.lengthOf(500);
      expect(executeBatchCallStub.secondCall.args[0]).to.have.lengthOf(100);
    });

    it('should handle getaddressdeltas failure gracefully', async () => {
      const logWarnStub = sinon.stub(log, 'warn');
      executeCallStub.resolves({ status: 'error', data: { message: 'RPC unavailable' } });

      await explorerService.bootstrapSoftForks(2_579_000);

      expect(logWarnStub.calledWith(sinon.match(/getaddressdeltas failed/))).to.be.true;
      sinon.assert.notCalled(executeBatchCallStub);
      logWarnStub.restore();
    });

    it('should skip transactions without OP_RETURN message', async () => {
      executeCallStub.resolves({
        status: 'success',
        data: [
          makeDelta('noOpReturn', multisigA, -500_000),
          makeDelta('noOpReturn', multisigA, 500_000),
        ],
      });
      const txWithoutOpReturn = {
        txid: 'noOpReturn',
        height: 1_594_832,
        vin: [{ address: multisigA }],
        vout: [{ valueSat: 500_000, scriptPubKey: { addresses: [multisigA], asm: PAY_ASM } }],
      };
      executeBatchCallStub.resolves({
        status: 'success',
        data: [{ id: 0, result: txWithoutOpReturn, error: null }],
      });

      await explorerService.bootstrapSoftForks(2_579_000);

      sinon.assert.notCalled(updateOneStub);
    });

    it('applies a legacy price message only from the last output, as a released node does', async () => {
      executeCallStub.resolves({
        status: 'success',
        data: [
          makeDelta('lastTx', multisigA, -500_000),
          makeDelta('lastTx', multisigA, 500_000),
          makeDelta('firstTx', multisigA, -500_000),
          makeDelta('firstTx', multisigA, 500_000),
        ],
      });
      executeBatchCallStub.resolves({
        status: 'success',
        data: [
          { id: 0, result: makeSoftForkTx('lastTx', 1_594_832, priceForkHex), error: null },
          { id: 1, result: makeSoftForkTx('firstTx', 1_594_832, priceForkHex, { opReturnFirst: true }), error: null },
        ],
      });

      await explorerService.bootstrapSoftForks(2_579_000);

      const written = updateOneStub.getCalls().map((c) => c.args[2]?.txid);
      expect(written).to.include('lastTx');
      expect(written).to.not.include('firstTx');
    });
  });

  // ── Phase 2: the oracle's own addresses ──────────────────────────────
  //
  // A catching-up node does not reread every block; it jumps to known signer
  // addresses through the address index. RateMessages are not published from any
  // of those — they come from the oracle's own address, which is not configuration
  // but whatever the foundation named in an OracleKeyMessage, and it rotates. So
  // they are reachable only by a second query, built from what the first one read.
  //
  // Without it a re-synced node rebuilds every other message and no rate history,
  // has no FLUX/USD rate, resolves a v9 fee to zero — and zero is fail-closed at
  // the registration gate, so it refuses registrations a node running at the time
  // accepted.
  describe('bootstrapSoftForks — the oracle addresses phase 1 discovers', () => {
    const authority = config.fluxapps.messageAuthorityAddress;

    // Independent literals, not derived by the code under test: this pubkey names
    // this address under the Flux t1 P2PKH derivation. If the derivation moves,
    // this says so rather than moving with it.
    const ORACLE_PUBKEY_HEX = '02c7f5b5e6e7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4';
    const ORACLE_ADDR = 't1NfrwmYygJYwm4krB9KkhnBNLRffuCqvw8';
    // A real P2PKH scriptSig: 72-byte signature push tagged SIGHASH_ALL, then the
    // pubkey. Both authority checks require the input to commit to all outputs.
    const ALL_SCRIPTSIG = '483045022100d8a57c5364a2eb062a6fdac519d665074a1a075dff2215eb15e17c4dfb170eef02203b96971b6a07f880a2d946de2155e3a296d3ebf02d1754cba1f4a648fc2e4591012103a9329557d633a7b261290f7c3b17506d460c3fcfd0cb8fd9339b27d4f583eca7';

    const KEY_HEIGHT = 2_000_000;
    // SOFT_FORK_EFFECTIVE_DEPTH is 40: a rate below its key's effective height can
    // never validate, so the rate sits comfortably past it.
    const RATE_HEIGHT = KEY_HEIGHT + 100;
    const TIP = 2_579_000;

    let executeCallStub;
    let executeBatchCallStub;
    let policy;

    const delta = (txid, address, satoshis, height) => ({
      txid, address, satoshis, blockindex: 0, index: 0, height,
    });

    // `layout` lists the outputs in order: 'pay' a payment back to the sender, and
    // each hex string an OP_RETURN carrying it.
    const signedTx = (txid, height, from, msgHex, layout = ['pay', msgHex]) => ({
      txid,
      height,
      vin: [{ address: from, scriptSig: { hex: ALL_SCRIPTSIG } }],
      vout: layout.map((out) => (out === 'pay'
        ? { valueSat: 100_000, scriptPubKey: { addresses: [from], asm: PAY_ASM } }
        : { valueSat: 0, scriptPubKey: { addresses: [], asm: `OP_RETURN ${out}` } })),
    });

    const selfSend = (txid, address, height) => [
      delta(txid, address, -500_000, height),
      delta(txid, address, 500_000, height),
    ];

    before(async () => {
      policy = await fluxSpecCjs.load();
    });

    beforeEach(async () => {
      await dbHelper.initiateDB();
      dbHelper.databaseConnection();
      executeCallStub = sinon.stub(daemonServiceUtils, 'executeCall');
      executeBatchCallStub = sinon.stub(daemonServiceUtils, 'executeBatchCall');
      sinon.stub(dbHelper, 'updateOneInDatabase').resolves();
      // The real histories, emptied — a hand-written double would answer whatever
      // this file expected rather than what the class does.
      priceOracleState.getOracleKeyHistory().removeAtHeight(0);
      priceOracleState.getRateMessageHistory().removeAtHeight(0);
    });

    afterEach(() => {
      sinon.restore();
      priceOracleState.getOracleKeyHistory().removeAtHeight(0);
      priceOracleState.getRateMessageHistory().removeAtHeight(0);
    });

    const oracleKeyHex = () => Buffer.from(
      policy.OracleKeyMessage.encode({ role: policy.OracleKeyMessage.ROLE.ORACLE, pubkey: Buffer.from(ORACLE_PUBKEY_HEX, 'hex') }),
    ).toString('hex');

    const rateHex = () => Buffer.from(
      policy.RateMessage.encode({ timestamp: 1_780_000_000, fluxUsdPriceE4: 691 }),
    ).toString('hex');

    it('asks only once while no oracle key has been published', async () => {
      // Mainnet today. No OracleKeyMessage exists, so no rate message is authorised
      // and there is nothing for a second query to find.
      executeCallStub.resolves({ status: 'success', data: [] });

      await explorerService.bootstrapSoftForks(TIP);

      sinon.assert.calledOnce(executeCallStub);
    });

    it('queries the oracle address a published key names, from that key\'s height', async () => {
      priceOracleState.getOracleKeyHistory().add(
        { role: policy.OracleKeyMessage.ROLE.ORACLE, pubkey: Buffer.from(ORACLE_PUBKEY_HEX, 'hex') }, KEY_HEIGHT, 0,
      );
      executeCallStub.resolves({ status: 'success', data: [] });

      await explorerService.bootstrapSoftForks(TIP);

      sinon.assert.calledTwice(executeCallStub);
      const second = executeCallStub.secondCall.args[1][0];
      expect(second.addresses).to.deep.equal([ORACLE_ADDR]);
      // Not epochstart: a rate below its own key can never validate, so starting
      // earlier would only fetch transactions guaranteed to be refused.
      expect(second.start).to.equal(KEY_HEIGHT);
      expect(second.end).to.equal(TIP);
    });

    it('asks the foundation first — the oracle address is only knowable after', async () => {
      priceOracleState.getOracleKeyHistory().add(
        { role: policy.OracleKeyMessage.ROLE.ORACLE, pubkey: Buffer.from(ORACLE_PUBKEY_HEX, 'hex') }, KEY_HEIGHT, 0,
      );
      executeCallStub.resolves({ status: 'success', data: [] });

      await explorerService.bootstrapSoftForks(TIP);

      const first = executeCallStub.firstCall.args[1][0];
      expect(first.addresses).to.include(authority);
      expect(first.addresses).to.not.include(ORACLE_ADDR);
      expect(executeCallStub.secondCall.calledAfter(executeCallStub.firstCall)).to.equal(true);
    });

    it('scans every address the key has ever had, and each one once', async () => {
      const OTHER_PUBKEY_HEX = '03a9329557d633a7b261290f7c3b17506d460c3fcfd0cb8fd9339b27d4f583eca7';
      priceOracleState.getOracleKeyHistory().add(
        { role: policy.OracleKeyMessage.ROLE.ORACLE, pubkey: Buffer.from(ORACLE_PUBKEY_HEX, 'hex') }, KEY_HEIGHT, 0,
      );
      priceOracleState.getOracleKeyHistory().add(
        { role: policy.OracleKeyMessage.ROLE.ORACLE, pubkey: Buffer.from(OTHER_PUBKEY_HEX, 'hex') }, KEY_HEIGHT + 5000, 0,
      );
      // The same key again: a rotation back, or a re-publication. One address.
      priceOracleState.getOracleKeyHistory().add(
        { role: policy.OracleKeyMessage.ROLE.ORACLE, pubkey: Buffer.from(ORACLE_PUBKEY_HEX, 'hex') }, KEY_HEIGHT + 9000, 0,
      );
      executeCallStub.resolves({ status: 'success', data: [] });

      await explorerService.bootstrapSoftForks(TIP);

      const { addresses } = executeCallStub.secondCall.args[1][0];
      expect(addresses).to.have.lengthOf(2);
      expect(addresses).to.include(ORACLE_ADDR);
      // The earliest key still sets the lower bound, not the latest.
      expect(executeCallStub.secondCall.args[1][0].start).to.equal(KEY_HEIGHT);
    });

    it('scans the availability key\'s address in the second query too, from its own height', async () => {
      const AVAILABILITY_PUBKEY_HEX = '03a9329557d633a7b261290f7c3b17506d460c3fcfd0cb8fd9339b27d4f583eca7';
      const AVAILABILITY_ADDR = 't1KRvTTXmaYZmjpgEVbk7cAfu83uYJDoAn4';
      priceOracleState.getOracleKeyHistory().add(
        { role: policy.OracleKeyMessage.ROLE.AVAILABILITY, pubkey: Buffer.from(AVAILABILITY_PUBKEY_HEX, 'hex') }, KEY_HEIGHT, 0,
      );
      priceOracleState.getOracleKeyHistory().add(
        { role: policy.OracleKeyMessage.ROLE.ORACLE, pubkey: Buffer.from(ORACLE_PUBKEY_HEX, 'hex') }, KEY_HEIGHT + 5000, 0,
      );
      executeCallStub.resolves({ status: 'success', data: [] });

      await explorerService.bootstrapSoftForks(TIP);

      const { addresses, start } = executeCallStub.secondCall.args[1][0];
      expect(addresses).to.have.members([AVAILABILITY_ADDR, ORACLE_ADDR]);
      expect(start).to.equal(KEY_HEIGHT);
    });

    it('rebuilds a rate message that only the second query can reach', async () => {
      // The whole point, end to end: the foundation's message names the key, and
      // the rate that key signed is at an address the first query never asks about.
      executeCallStub
        .onFirstCall().resolves({ status: 'success', data: selfSend('keyTx', authority, KEY_HEIGHT) })
        .onSecondCall().resolves({ status: 'success', data: selfSend('rateTx', ORACLE_ADDR, RATE_HEIGHT) });
      executeBatchCallStub
        .onFirstCall().resolves({
          status: 'success',
          data: [{ id: 0, result: signedTx('keyTx', KEY_HEIGHT, authority, oracleKeyHex()), error: null }],
        })
        .onSecondCall().resolves({
          status: 'success',
          data: [{ id: 0, result: signedTx('rateTx', RATE_HEIGHT, ORACLE_ADDR, rateHex()), error: null }],
        });

      await explorerService.bootstrapSoftForks(TIP);

      // The key was read from the chain, not seeded by this test.
      expect([...priceOracleState.getOracleKeyHistory().entries()]).to.have.lengthOf(1);
      // And the rate it authorised is in the history a v9 fee reads.
      const rates = [...priceOracleState.getRateMessageHistory().entries()];
      expect(rates, 'no rate message was rebuilt — phase 2 did not reach it').to.have.lengthOf(1);
      expect(rates[0].chainHeight).to.equal(RATE_HEIGHT);
    });

    describe('an UnclaimedPaymentMessage in the block walk', () => {
      const AVAILABILITY_PUBKEY_HEX = '03a9329557d633a7b261290f7c3b17506d460c3fcfd0cb8fd9339b27d4f583eca7';
      const AVAILABILITY_ADDR = 't1KRvTTXmaYZmjpgEVbk7cAfu83uYJDoAn4';
      const VOID_HEIGHT = KEY_HEIGHT + 100;
      const HASH_HEX = 'ab'.repeat(32);
      const voidHex = () => Buffer.from(policy.UnclaimedPaymentMessage.encode({ hash: HASH_HEX })).toString('hex');
      const keyInForce = (role, pubkeyHex) => priceOracleState.getOracleKeyHistory().add(
        { role, pubkey: Buffer.from(pubkeyHex, 'hex') }, KEY_HEIGHT, 0,
      );
      const voidRows = () => dbHelper.updateOneInDatabase.getCalls().filter((call) => call.args[2]?.txid === 'voidTx');
      let voids;
      let applyVoidStub;

      beforeEach(() => {
        voids = new policy.UnclaimedPaymentHistory();
        unclaimedPayments.installUnclaimedPaymentState({ unclaimedPaymentHistory: voids });
        applyVoidStub = sinon.stub(unclaimedPayments, 'applyVoid').resolves(true);
      });

      afterEach(() => {
        unclaimedPayments.installUnclaimedPaymentState({ unclaimedPaymentHistory: null });
      });

      const walk = (from) => explorerService.processInsight(
        { height: VOID_HEIGHT, tx: [{ ...signedTx('voidTx', VOID_HEIGHT, from, voidHex()), version: 1 }] }, {},
      );

      it('is recorded, kept in the history and applied with the decider\'s wake when the availability key signs it', async () => {
        keyInForce(policy.OracleKeyMessage.ROLE.AVAILABILITY, AVAILABILITY_PUBKEY_HEX);

        await walk(AVAILABILITY_ADDR);

        expect([...voids.entries()].map((entry) => entry.message.hashHex)).to.deep.equal([HASH_HEX]);
        expect(voidRows()).to.have.lengthOf(1);
        expect(voidRows()[0].args[1]).to.equal(config.database.chainparams.collections.unclaimedPaymentMessages);
        sinon.assert.calledOnce(applyVoidStub);
        const [message, height, wake] = applyVoidStub.firstCall.args;
        expect(message.hashHex).to.equal(HASH_HEX);
        expect(height).to.equal(VOID_HEIGHT);
        expect(wake).to.equal(decider.wake);
      });

      it('is refused from the oracle key, whose role is the rate', async () => {
        keyInForce(policy.OracleKeyMessage.ROLE.ORACLE, AVAILABILITY_PUBKEY_HEX);

        await walk(AVAILABILITY_ADDR);

        expect([...voids.entries()]).to.have.lengthOf(0);
        expect(voidRows()).to.have.lengthOf(0);
        sinon.assert.notCalled(applyVoidStub);
      });

      it('is refused from the foundation, and from the availability address while no availability key is in force', async () => {
        await walk(authority);
        await walk(AVAILABILITY_ADDR);

        expect([...voids.entries()]).to.have.lengthOf(0);
        expect(voidRows()).to.have.lengthOf(0);
        sinon.assert.notCalled(applyVoidStub);
      });
    });

    describe('where a transaction carries its messages', () => {
      const OTHER_PUBKEY_HEX = '03a9329557d633a7b261290f7c3b17506d460c3fcfd0cb8fd9339b27d4f583eca7';
      const keyHex = (pubkeyHex) => Buffer.from(
        policy.OracleKeyMessage.encode({ role: policy.OracleKeyMessage.ROLE.ORACLE, pubkey: Buffer.from(pubkeyHex, 'hex') }),
      ).toString('hex');
      const pubkeysHeld = () => [...priceOracleState.getOracleKeyHistory().entries()]
        .map((entry) => Buffer.from(entry.message.pubkey).toString('hex'));
      const rowKeys = (txid) => dbHelper.updateOneInDatabase.getCalls()
        .filter((call) => call.args[2]?.txid === txid)
        .map((call) => call.args[2]);

      // The two paths a message reaches a node by: the block walk, and the
      // address-index bootstrap of a node catching up.
      const paths = {
        'the live block walk': async (tx) => {
          await explorerService.processInsight({ height: KEY_HEIGHT, tx: [{ ...tx, version: 1 }] }, {});
        },
        'the bootstrap': async (tx) => {
          executeCallStub
            .onFirstCall().resolves({ status: 'success', data: selfSend(tx.txid, authority, KEY_HEIGHT) })
            .onSecondCall().resolves({ status: 'success', data: [] });
          executeBatchCallStub.resolves({ status: 'success', data: [{ id: 0, result: tx, error: null }] });
          await explorerService.bootstrapSoftForks(TIP);
        },
      };

      Object.entries(paths).forEach(([path, ingest]) => {
        describe(path, () => {
          const layouts = {
            first: (m) => [m, 'pay', 'pay'],
            'between two payments': (m) => ['pay', m, 'pay'],
            last: (m) => ['pay', 'pay', m],
          };
          Object.entries(layouts).forEach(([where, layout]) => {
            it(`applies a message whose OP_RETURN is ${where}`, async () => {
              await ingest(signedTx('keyTx', KEY_HEIGHT, authority, null, layout(keyHex(ORACLE_PUBKEY_HEX))));

              expect(pubkeysHeld()).to.deep.equal([ORACLE_PUBKEY_HEX]);
            });
          });

          it('applies every message one transaction carries, in output order, each stored under its own output', async () => {
            await ingest(signedTx('twoTx', KEY_HEIGHT, authority, null, [
              'pay', keyHex(ORACLE_PUBKEY_HEX), keyHex(OTHER_PUBKEY_HEX),
            ]));

            expect(pubkeysHeld()).to.deep.equal([ORACLE_PUBKEY_HEX, OTHER_PUBKEY_HEX]);
            expect(rowKeys('twoTx')).to.deep.equal([{ txid: 'twoTx', vout: 1 }, { txid: 'twoTx', vout: 2 }]);
          });
        });
      });
    });
  });

  describe('soft-fork message authority', () => {
    let ROLE;

    before(async () => {
      ({ OracleKeyMessage: { ROLE } } = await explorerService.loadSpecPolicy());
    });

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

      it('rejects when the key in force is the availability role\'s, not the oracle\'s', () => {
        sinon.stub(priceOracleState, 'getOracleKeyHistory').returns({
          resolveAt: (height, role) => (role === ROLE.AVAILABILITY ? { pubkey: Buffer.from(pubkeyHex, 'hex') } : null),
        });
        const tx = { vin: [{ address: oracleAddr, ...allSig() }] };
        expect(explorerService.isOracleSigner(tx, 100)).to.equal(false);
      });
    });

    describe('isAvailabilitySigner', () => {
      const pubkeyHex = '02c7f5b5e6e7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4';
      const availabilityAddr = 't1NfrwmYygJYwm4krB9KkhnBNLRffuCqvw8';
      const keyInForceFor = (held) => sinon.stub(priceOracleState, 'getOracleKeyHistory').returns({
        resolveAt: (height, role) => (role === held ? { pubkey: Buffer.from(pubkeyHex, 'hex') } : null),
      });

      it('accepts a tx signed by the key in force for the availability role with SIGHASH_ALL', () => {
        keyInForceFor(ROLE.AVAILABILITY);
        const tx = { vin: [{ address: availabilityAddr, ...allSig() }] };
        expect(explorerService.isAvailabilitySigner(tx, 100)).to.equal(true);
      });

      it('rejects when the key in force is the oracle\'s: each role rotates on its own', () => {
        keyInForceFor(ROLE.ORACLE);
        const tx = { vin: [{ address: availabilityAddr, ...allSig() }] };
        expect(explorerService.isAvailabilitySigner(tx, 100)).to.equal(false);
      });

      it('rejects when no key is in force at the height', () => {
        sinon.stub(priceOracleState, 'getOracleKeyHistory').returns({ resolveAt: () => null });
        const tx = { vin: [{ address: availabilityAddr, ...allSig() }] };
        expect(explorerService.isAvailabilitySigner(tx, 100)).to.equal(false);
      });

      it('rejects a tx not signed by the availability key', () => {
        keyInForceFor(ROLE.AVAILABILITY);
        const tx = { vin: [{ address: 't1SomeoneElse', ...allSig() }] };
        expect(explorerService.isAvailabilitySigner(tx, 100)).to.equal(false);
      });

      it('rejects an availability input that does not sign all outputs (SIGHASH_NONE)', () => {
        keyInForceFor(ROLE.AVAILABILITY);
        const tx = { vin: [{ address: availabilityAddr, scriptSig: { hex: NONE_SCRIPTSIG } }] };
        expect(explorerService.isAvailabilitySigner(tx, 100)).to.equal(false);
      });
    });
  });

  describe('processSoftFork failure handling', () => {

    // Same real mainnet P2PKH scriptSig the authority tests use: SIGHASH_ALL, so the
    // input commits to the OP_RETURN and isMessageAuthority accepts the transaction.
    const ALL_SCRIPTSIG = '483045022100d8a57c5364a2eb062a6fdac519d665074a1a075dff2215eb15e17c4dfb170eef02203b96971b6a07f880a2d946de2155e3a296d3ebf02d1754cba1f4a648fc2e4591012103a9329557d633a7b261290f7c3b17506d460c3fcfd0cb8fd9339b27d4f583eca7';
    const authorityTx = () => ({
      vin: [{ address: config.fluxapps.messageAuthorityAddress, scriptSig: { hex: ALL_SCRIPTSIG } }],
    });

    const PAYLOAD = { vout: 1, bytes: new Uint8Array([0x02, 0x00]), legacyPosition: true };
    const PARSED_PRICE = { fields: { cpu: 1n }, unknownTags: [] };

    let realPolicy;
    let ValidationError;

    before(async () => {
      realPolicy = await specLibs.getSpecPolicy();
      ({ ValidationError } = realPolicy);
    });

    afterEach(() => sinon.restore());

    // explorerService loaded with spec-policy's dispatch under the test's control.
    // The CJS bridge freezes the namespace it hands out, so `dispatch` cannot be
    // stubbed on it — the accessor is the only seam.
    function explorerWith(dispatch) {
      const policy = { ...realPolicy, dispatch };
      return proxyquire('../../ZelBack/src/services/explorerService', {
        './utils/specLibs': { ...specLibs, getSpecPolicy: async () => policy },
      });
    }

    describe('telling a bad message from a broken parser', () => {
      it('skips a message the parser rejects, and reports it against the sender', async () => {
        const warnSpy = sinon.spy(log, 'warn');
        const errorSpy = sinon.spy(log, 'error');
        const svc = explorerWith(() => {
          throw new ValidationError([
            { path: [], code: 'MALFORMED_ENCODING', message: 'trailing bytes' },
          ]);
        });

        await svc.processSoftFork('badTx', 1_594_832, 4, PAYLOAD, false, authorityTx());

        expect(warnSpy.calledWithMatch(/Rejected soft-fork message badTx/)).to.equal(true);
        expect(errorSpy.calledWithMatch(/defect/)).to.equal(false);
      });

      it('surfaces a broken parser instead of blaming the sender', async () => {
        const warnSpy = sinon.spy(log, 'warn');
        const errorSpy = sinon.spy(log, 'error');
        const svc = explorerWith(() => {
          // Not a ValidationError: a coding fault inside spec-policy. Swallowed as
          // "rejected message", one of these skips every price message on every node
          // while the log accuses the foundation of publishing garbage.
          throw new TypeError('PRICE_TAGS.get is not a function');
        });

        await expect(svc.processSoftFork('goodTx', 1_594_832, 4, PAYLOAD, false, authorityTx()))
          .to.eventually.be.rejectedWith('PRICE_TAGS.get is not a function');

        expect(errorSpy.calledWithMatch(/FluxOS\/spec-policy.*defect, not a bad message/)).to.equal(true);
        expect(warnSpy.calledWithMatch(/Rejected soft-fork message/)).to.equal(false);
      });
    });

    describe('the stored row and the in-memory history move together', () => {
      it('does not write the row when the in-memory apply refuses the message', async () => {
        const updateStub = sinon.stub(dbHelper, 'updateOneInDatabase').resolves();
        sinon.stub(priceOracleState, 'getPriceMessageHistory').returns({
          add: sinon.stub().throws(new TypeError('PriceMessageHistory.add: chainHeight must be a non-negative integer')),
        });
        const svc = explorerWith(() => ({ kind: 'price', message: PARSED_PRICE, firstByte: 0x02 }));

        await expect(svc.processSoftFork('priceTx', 1_594_832, 4, PAYLOAD, false, authorityTx()))
          .to.eventually.be.rejectedWith(/chainHeight must be a non-negative integer/);

        // A row the history refuses is a poison pill: every rewind builds the history
        // from the stored rows through the same add(), unguarded.
        expect(updateStub.called).to.equal(false);
      });

      it('writes the row and applies the message when both succeed', async () => {
        const updateStub = sinon.stub(dbHelper, 'updateOneInDatabase').resolves();
        const addStub = sinon.stub();
        sinon.stub(priceOracleState, 'getPriceMessageHistory').returns({ add: addStub });
        const svc = explorerWith(() => ({ kind: 'price', message: PARSED_PRICE, firstByte: 0x02 }));

        await svc.processSoftFork('priceTx', 1_594_832, 4, PAYLOAD, false, authorityTx());

        sinon.assert.calledOnceWithExactly(addStub, PARSED_PRICE, 1_594_832, 4);
        const write = updateStub.getCalls().find((c) => c.args[2]?.txid === 'priceTx');
        expect(write, 'the price row must be stored').to.not.be.undefined;
        expect(write.args[2]).to.deep.equal({ txid: 'priceTx', vout: 1 });
        expect(write.args[3].$set.message).to.equal(PARSED_PRICE);
        expect(write.args[3].$set.vout).to.equal(1);
      });
    });
  });

  describe('the scan and every rewind share one lock', () => {
    let cursor;
    let fetched;
    let onFetch;
    let removeStub;
    let blockAt;

    beforeEach(() => {
      capabilities.setForTests('chainStateConsistent', true);
      cursor = 1000;
      fetched = [];
      onFetch = null;
      blockAt = (height) => ({ height, tx: [] });
      const db = { collection: () => ({}) };
      sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => db });
      sinon.stub(dbHelper, 'findOneInDatabase').callsFake(async (_db, collection) => (
        collection === 'scannedheight' ? { generalScannedHeight: cursor } : null));
      sinon.stub(dbHelper, 'updateOneInDatabase').callsFake(async (_db, _collection, _query, update) => {
        if (update.$set && 'generalScannedHeight' in update.$set) cursor = update.$set.generalScannedHeight;
      });
      removeStub = sinon.stub(dbHelper, 'removeDocumentsFromCollection').resolves();
      sinon.stub(dbHelper, 'findInDatabase').resolves([]);
      sinon.stub(dbHelper, 'insertManyToDatabase').resolves();
      sinon.stub(daemonStatus, 'isDaemonSynced').returns({ data: { synced: true, height: 1005 } });
      sinon.stub(daemonStatus, 'isInsightExplorer').returns(false);
      sinon.stub(daemonSubscriptionService, 'isTopicAvailable').returns(true);
      sinon.stub(daemonServiceBlockchainRpcs, 'getBlock').callsFake(async ({ hashheight }) => {
        fetched.push(hashheight);
        if (onFetch) onFetch(hashheight);
        return { status: 'success', data: blockAt(hashheight) };
      });
    });

    afterEach(() => {
      sinon.restore();
    });

    it('starts the drain again from the rewound cursor when a rewind lands between blocks', async () => {
      let rewound = null;
      onFetch = (height) => {
        if (height === 1002 && !rewound) rewound = chainState.rewind('test', 1000);
      };

      await explorerService.startScanning();
      await rewound;

      expect(fetched).to.deep.equal([1001, 1002, 1001, 1002, 1003, 1004, 1005]);
    });

    it('drops the payment records it buffered for blocks a rewind takes away', async () => {
      const PAYMENT_HEIGHT = 983_001;
      cursor = PAYMENT_HEIGHT - 1;
      daemonStatus.isDaemonSynced.returns({ data: { synced: true, height: PAYMENT_HEIGHT + 3 } });
      blockAt = (height) => ({
        height,
        time: 1_700_000_000,
        tx: height !== PAYMENT_HEIGHT ? [] : [{
          version: 3,
          txid: 'payment',
          vin: [],
          vout: [{
            n: 0,
            scriptPubKey: {
              addresses: ['t1LUs6quf7TB2zVZmexqPQdnqmrFMGZGjV6'],
              asm: 'OP_RETURN 5468697320737472696e672069732065786163746c792036342063686172616374657273206c6f6e672e20496e636c7564696e67207468697320737472696e67',
            },
            valueSat: 20_000_000,
          }],
        }],
      });
      let rewound = null;
      onFetch = (height) => {
        if (height === PAYMENT_HEIGHT + 1 && !rewound) rewound = chainState.rewind('test', PAYMENT_HEIGHT - 1);
      };

      await explorerService.startScanning();
      await rewound;

      const inserted = messages.recordPayments.getCalls().flatMap((call) => call.args[0]);
      expect(inserted.map((record) => record.txid)).to.deep.equal(['payment']);
    });

    function paymentTx(txid, valueSat = 20_000_000) {
      return {
        version: 3,
        txid,
        vin: [],
        vout: [{
          n: 0,
          scriptPubKey: {
            addresses: ['t1LUs6quf7TB2zVZmexqPQdnqmrFMGZGjV6'],
            asm: 'OP_RETURN 5468697320737472696e672069732065786163746c792036342063686172616374657273206c6f6e672e20496e636c7564696e67207468697320737472696e67',
          },
          valueSat,
        }],
      };
    }

    it('records a hash paid twice as its first payment only, in one block and across blocks', async () => {
      const PAYMENT_HEIGHT = 983_001;
      cursor = PAYMENT_HEIGHT - 1;
      daemonStatus.isDaemonSynced.returns({ data: { synced: true, height: PAYMENT_HEIGHT + 1 } });
      blockAt = (height) => ({
        height,
        time: 1_700_000_000,
        tx: height === PAYMENT_HEIGHT ? [paymentTx('coinbase', 0), paymentTx('first'), paymentTx('second')] : [paymentTx('third')],
      });

      await explorerService.startScanning();

      const inserted = messages.recordPayments.getCalls().flatMap((call) => call.args[0]);
      expect(inserted.map((record) => [record.txid, record.txIndex])).to.deep.equal([['first', 1]]);
    });

    it('fails the block, rather than dropping the payment, when the record lookup fails', async () => {
      const PAYMENT_HEIGHT = 983_001;
      cursor = PAYMENT_HEIGHT - 1;
      daemonStatus.isDaemonSynced.returns({ data: { synced: true, height: PAYMENT_HEIGHT } });
      blockAt = (height) => ({ height, time: 1_700_000_000, tx: [paymentTx('only')] });
      messages.byHash.rejects(new Error('test: mongo read failed'));
      const errorSpy = sinon.spy(log, 'error');

      await explorerService.startScanning();

      expect(messages.recordPayments.called).to.equal(false);
      expect(errorSpy.calledWithMatch(sinon.match.has('message', 'test: mongo read failed'))).to.equal(true);
    });

    it('writes no block while chain state is down, and its recovery rewinds', async () => {
      capabilities.claim('chainStateConsistent', 'chainState').lower('test: a rewind that threw');
      const errorSpy = sinon.spy(log, 'error');

      await explorerService.startScanning();

      expect(fetched).to.deep.equal([]);
      expect(errorSpy.calledWithMatch(sinon.match.has('message', sinon.match(/Chain state is not consistent/)))).to.equal(true);
      expect(capabilities.isUp('chainStateConsistent')).to.equal(true);
    });

    it('rolls back a reorg below the blocks the scan has written, though the cursor is below the fork', async () => {
      onFetch = (height) => {
        if (height === 1002) explorerService.stopScanning();
      };
      await explorerService.startScanning();
      expect(cursor, 'blocks before the tip leave the cursor where it was').to.equal(1000);

      await explorerService.handleChainReorg({ fork: { height: 1001 }, depth: 1 });

      sinon.assert.calledWith(messages.removePaymentsAbove, 1000);
    });

    it('leaves the chain alone for a reorg above every block the scan has written', async () => {
      onFetch = (height) => {
        if (height === 1002) explorerService.stopScanning();
      };
      await explorerService.startScanning();

      await explorerService.handleChainReorg({ fork: { height: 1002 }, depth: 1 });

      sinon.assert.notCalled(removeStub);
    });

    it('forgets the blocks a rewind took away when judging the next reorg', async () => {
      onFetch = (height) => {
        if (height === 1002) explorerService.stopScanning();
      };
      await explorerService.startScanning();
      await chainState.rewind('test', 1000);
      removeStub.resetHistory();

      await explorerService.handleChainReorg({ fork: { height: 1001 }, depth: 1 });

      sinon.assert.notCalled(removeStub);
    });

    it('lowers explorerSynced on a rewind, whatever the scan last published', async () => {
      explorerService.publishExplorerSynced(1005, 1005);
      expect(capabilities.isUp('explorerSynced')).to.equal(true);

      await chainState.rewind('test', 900);

      expect(capabilities.isUp('chainStateConsistent')).to.equal(true);
      expect(capabilities.isUp('explorerSynced')).to.equal(false);
    });
  });

  describe('reindex and rescan rewind through the start path', () => {
    let rewindStub;

    beforeEach(() => {
      rewindStub = sinon.stub(chainState, 'rewind').resolves(0);
      sinon.stub(dbHelper, 'countInDatabase').resolves(1);
      sinon.stub(daemonServiceBlockchainRpcs, 'getBlockCount').returns({ status: 'error', data: { message: 'test: stop here' } });
    });

    afterEach(() => {
      explorerService.setIsInInitiationOfBP(false);
      sinon.restore();
    });

    it('reindex rewinds to height 0', async () => {
      await explorerService.reindexExplorer({ rescanGlobalApps: true });
      await serviceHelper.delay(50);

      sinon.assert.calledWith(rewindStub.firstCall, 'reindex', 0);
    });

    it('rescan rewinds to the height asked for', async () => {
      sinon.stub(dbHelper, 'findOneInDatabase').resolves({ generalScannedHeight: 2000 });

      await explorerService.rescanExplorer({ blockheight: 1500 });
      await serviceHelper.delay(50);

      sinon.assert.calledWith(rewindStub.firstCall, 'rescan from 1500', 1500);
    });
  });

  describe('initiateBlockProcessor never rejects', () => {
    beforeEach(async () => {
      sinon.stub(daemonStatus, 'isDaemonSynced').returns({ data: { synced: true } });
      await dbHelper.initiateDB();
      dbHelper.databaseConnection();
      sinon.stub(dbHelper, 'countInDatabase').resolves(1);
    });

    afterEach(() => {
      explorerService.setIsInInitiationOfBP(false);
      sinon.restore();
    });

    // Every caller starts this as a fire-and-forget promise — boot, and the
    // /explorer/restart|reindex|rescan routes. There is no process-level
    // unhandledRejection handler, so anything escaping here ends fluxos: the failure
    // path is the one that must not be able to fail.
    it('swallows a failure in its own recovery rather than taking the process down', async () => {
      const errorSpy = sinon.spy(log, 'error');
      sinon.stub(dbHelper, 'findOneInDatabase').resolves({ generalScannedHeight: 700_000 });
      // The body fails...
      sinon.stub(daemonServiceBlockchainRpcs, 'getBlockCount').returns({
        status: 'error', data: { message: 'daemon is down' },
      });
      // ...and so does the recovery it triggers.
      const rewind = sinon.stub(chainState, 'rewind');
      rewind.onFirstCall().resolves(700_000);
      rewind.rejects(new Error('rewind hit a dead database'));

      await expect(explorerService.initiateBlockProcessor({})).to.eventually.be.fulfilled;

      expect(errorSpy.calledWithMatch(/Block processor recovery failed/)).to.equal(true);
    });
  });
  describe('the hashblockheight subscriber', () => {
    it('carries the pushed height into the scan request, so the drain never trusts the cache alone', async () => {
      // The push handler chain is synchronous and ordered by registration:
      // the explorer's drain reads isDaemonSynced() before chainTipSource's
      // sibling handler records the new height, so the drain sees the
      // pre-block tip and returns without scanning — and nothing re-arms in
      // push mode. The message itself carries the freshest fact; the
      // subscriber records it before asking for the scan.
      const captured = new Map();
      const fresh = proxyquire('../../ZelBack/src/services/explorerService', {
        './daemonService/daemonSubscriptionService': {
          ...daemonSubscriptionService,
          subscribe: (topic, handler) => captured.set(topic, handler),
        },
      });
      const handler = captured.get(daemonSubscriptionService.TOPICS.hashBlockHeight);
      expect(handler, 'explorer subscribes to hashblockheight').to.exist;
      // The record is synchronous at requestScan entry - assert before any
      // microtask can run the drain (which consumes the target per round).
      handler.onMessage({ height: 2_100_777 });
      expect(fresh.pushedTip(), 'the drain floors on the height the push carried').to.equal(2_100_777);
      await fresh.stopScanning();
    });
  });

  describe('speedMultiplierAt', () => {
    it('scales the block loop\'s periods by how many blocks span one of the chain\'s first', () => {
      expect(explorerService.speedMultiplierAt(2_019_999)).to.equal(1);
      expect(explorerService.speedMultiplierAt(2_020_000)).to.equal(4);
    });

    it('on labnet, from height 2', () => {
      const { Chain } = specLibrary.loaded();
      const onLabnet = proxyquire('../../ZelBack/src/services/explorerService', {
        './utils/nodeChain': { nodeChain: () => Chain.LABNET },
      });
      expect(onLabnet.speedMultiplierAt(1)).to.equal(1);
      expect(onLabnet.speedMultiplierAt(2)).to.equal(4);
    });
  });
});
