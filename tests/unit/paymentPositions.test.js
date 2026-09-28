'use strict';

const { expect } = require('chai');
const config = require('config');
const sinon = require('sinon');

const dbHelper = require('../../ZelBack/src/services/dbHelper');
const daemonServiceUtils = require('../../ZelBack/src/services/daemonService/daemonServiceUtils');
const paymentPositions = require('../../ZelBack/src/services/migrations/paymentPositions');

const RECORDS = config.get('database.daemon.collections.appsHashes');
const MESSAGES = config.get('database.appsglobal.collections.appsMessages');

describe('paymentPositions', () => {
  let rows;
  let bulkStub;
  let executeCallStub;

  beforeEach(() => {
    rows = { unpositionedRecords: [], positionedRecords: [], unpositionedMessages: [] };
    sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({}) });
    sinon.stub(dbHelper, 'findInDatabase').callsFake(async (_db, collection, query) => {
      if (collection === MESSAGES) return rows.unpositionedMessages;
      if (collection === RECORDS && query.txIndex.$exists === false) return rows.unpositionedRecords;
      if (collection === RECORDS) return rows.positionedRecords;
      throw new Error(`unexpected collection ${collection}`);
    });
    bulkStub = sinon.stub(dbHelper, 'bulkWriteInDatabase').resolves();
    executeCallStub = sinon.stub(daemonServiceUtils, 'executeCall');
  });

  afterEach(() => {
    sinon.restore();
  });

  it('asks the daemon nothing and writes nothing when everything has a position', async () => {
    const result = await paymentPositions.backfillPaymentPositions();

    expect(result).to.deep.equal({ positioned: 0, unresolved: 0, messages: 0 });
    sinon.assert.notCalled(executeCallStub);
    sinon.assert.notCalled(bulkStub);
  });

  it('positions each record from one address-index call over the heights they span', async () => {
    rows.unpositionedRecords = [{ txid: 'a', height: 900 }, { txid: 'b', height: 700 }, { txid: 'gone', height: 800 }];
    executeCallStub.resolves({
      status: 'success',
      data: [
        { txid: 'a', height: 900, blockindex: 4, satoshis: 100 },
        { txid: 'b', height: 700, blockindex: 1, satoshis: 100 },
        { txid: 'b', height: 700, blockindex: 1, satoshis: -100 },
      ],
    });

    const result = await paymentPositions.backfillPaymentPositions();

    sinon.assert.calledOnce(executeCallStub);
    expect(executeCallStub.firstCall.args[1][0]).to.include({ start: 700, end: 900 });
    expect(result).to.include({ positioned: 2, unresolved: 1 });
    const ops = bulkStub.firstCall.args[2].map((op) => [op.updateOne.filter.txid, op.updateOne.update.$set.txIndex]);
    expect(ops).to.deep.equal([['a', 4], ['b', 1]]);
    expect(bulkStub.firstCall.args[2][0].updateOne.filter.txIndex).to.deep.equal({ $exists: false });
  });

  it('gives each stored message its payment record position', async () => {
    rows.unpositionedMessages = [{ hash: 'h1' }, { hash: 'unpaid' }];
    rows.positionedRecords = [{ hash: 'h1', txIndex: 5 }, { hash: 'h2', txIndex: 0 }];

    const result = await paymentPositions.backfillPaymentPositions();

    expect(result.messages).to.equal(1);
    sinon.assert.calledOnce(bulkStub);
    expect(bulkStub.firstCall.args[1]).to.equal(MESSAGES);
    expect(bulkStub.firstCall.args[2]).to.deep.equal([
      { updateOne: { filter: { hash: 'h1', txIndex: { $exists: false } }, update: { $set: { txIndex: 5 } } } },
    ]);
  });
});
