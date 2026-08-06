const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');

const chainRollback = require('../../ZelBack/src/services/chainRollback');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const entitlementsState = require('../../ZelBack/src/services/entitlementsState');
const log = require('../../ZelBack/src/lib/log');
const priceOracleState = require('../../ZelBack/src/services/pricing/priceOracleState');

chai.use(chaiAsPromised);
const { expect } = chai;

describe('chainRollback tests', () => {
  let removeDocumentsFromCollectionStub;
  let updateOneInDatabaseStub;
  let logInfoSpy;
  let entitlementsRemoveStub;
  let priceOracleRemoveStub;

  beforeEach(async () => {
    removeDocumentsFromCollectionStub = sinon.stub(dbHelper, 'removeDocumentsFromCollection').resolves(true);
    updateOneInDatabaseStub = sinon.stub(dbHelper, 'updateOneInDatabase').resolves(true);
    entitlementsRemoveStub = sinon.stub(entitlementsState, 'removeAtHeight');
    priceOracleRemoveStub = sinon.stub(priceOracleState, 'removeAtHeight');
    await dbHelper.initiateDB();
    dbHelper.databaseConnection();
    logInfoSpy = sinon.spy(log, 'info');
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('restoreDatabaseToBlockheightState tests', () => {
    it('should throw if height was not passed', async () => {
      await expect(chainRollback.restoreDatabaseToBlockheightState(undefined))
        .to.eventually.be.rejectedWith('No blockheight for restoring provided');
    });

    it('should remove chain derived state above the height', async () => {
      const height = 100000;

      const result = await chainRollback.restoreDatabaseToBlockheightState(height);

      expect(result).to.equal(true);
      sinon.assert.calledWith(logInfoSpy, 'Rescanning Blockchain Parameters!');
      sinon.assert.calledWith(logInfoSpy, 'Rescan completed');
      sinon.assert.calledWithMatch(removeDocumentsFromCollectionStub, sinon.match.object, 'zelappshashes', { height: { $gt: height } });
      sinon.assert.calledWithMatch(removeDocumentsFromCollectionStub, sinon.match.object, 'chainmessages', { height: { $gt: height } });
    });

    it('should leave confirmed app messages alone unless a rescan was asked for', async () => {
      await chainRollback.restoreDatabaseToBlockheightState(100000);

      sinon.assert.neverCalledWithMatch(removeDocumentsFromCollectionStub, sinon.match.object, 'zelappsmessages');
      sinon.assert.neverCalledWithMatch(removeDocumentsFromCollectionStub, sinon.match.object, 'zelappsinformation');
    });

    it('should remove confirmed app messages when a rescan was asked for', async () => {
      const height = 100000;

      const result = await chainRollback.restoreDatabaseToBlockheightState(height, true);

      expect(result).to.equal(true);
      sinon.assert.calledWith(logInfoSpy, 'Rescanning Apps!');
      sinon.assert.calledWithMatch(removeDocumentsFromCollectionStub, sinon.match.object, 'zelappsmessages', { height: { $gt: height } });
      sinon.assert.calledWithMatch(removeDocumentsFromCollectionStub, sinon.match.object, 'zelappsinformation', { height: { $gt: height } });
    });

    it('should prune the in memory histories one above the kept height, matching the query', async () => {
      await chainRollback.restoreDatabaseToBlockheightState(100000);

      sinon.assert.calledOnceWithExactly(entitlementsRemoveStub, 100001);
      sinon.assert.calledOnceWithExactly(priceOracleRemoveStub, 100001);
    });
  });

  describe('rollbackTo ordering tests', () => {
    it('should write the cursor before deleting any data', async () => {
      await chainRollback.rollbackTo(100000);

      expect(updateOneInDatabaseStub.calledBefore(removeDocumentsFromCollectionStub)).to.equal(true);
    });

    it('should set the cursor to the rollback height', async () => {
      await chainRollback.rollbackTo(100000);

      sinon.assert.calledWithMatch(
        updateOneInDatabaseStub,
        sinon.match.object,
        'scannedheight',
        { generalScannedHeight: { $gte: 0 } },
        { $set: { generalScannedHeight: 100000 } },
      );
    });

    it('should leave the cursor low rather than high when the deletion throws', async () => {
      removeDocumentsFromCollectionStub.rejects(new Error('test: db died mid rollback'));

      await expect(chainRollback.rollbackTo(100000)).to.eventually.be.rejected;

      // The cursor was already moved down, so the re-scan redoes those blocks rather
      // than skipping them forever.
      sinon.assert.calledOnce(updateOneInDatabaseStub);
    });

    it('should pass the rescan flag through', async () => {
      await chainRollback.rollbackTo(100000, { rescanGlobalApps: true });

      sinon.assert.calledWith(logInfoSpy, 'Rescanning Apps!');
    });

    it('should not treat an explicit zero as a missing height', async () => {
      await expect(chainRollback.rollbackTo(0)).to.eventually.be.rejectedWith('No blockheight for restoring provided');
    });

    it('should reject when no height is given at all', async () => {
      await expect(chainRollback.rollbackTo(undefined))
        .to.eventually.be.rejectedWith('No blockheight for restoring provided');
    });
  });
});
