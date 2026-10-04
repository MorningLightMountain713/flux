'use strict';

const { expect } = require('chai');
const config = require('config');
const sinon = require('sinon');

const dbHelper = require('../../ZelBack/src/services/dbHelper');
const daemonServiceUtils = require('../../ZelBack/src/services/daemonService/daemonServiceUtils');
const paymentPositions = require('../../ZelBack/src/services/migrations/paymentPositions');

const RECORDS = config.get('database.daemon.collections.appsHashes');

describe('paymentPositions', () => {
  let rows;
  let bulkStub;
  let executeCallStub;

  beforeEach(() => {
    rows = { unpositionedRecords: [] };
    sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({}) });
    sinon.stub(dbHelper, 'findInDatabase').callsFake(async (_db, collection, query) => {
      if (collection === RECORDS && query.txIndex.$exists === false) return rows.unpositionedRecords;
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

    expect(result).to.deep.equal({ positioned: 0, heightsCorrected: 0, unresolved: 0 });
    sinon.assert.notCalled(executeCallStub);
    sinon.assert.notCalled(bulkStub);
  });

  function daemonAnswers(tip, deltas) {
    executeCallStub.withArgs('getBlockCount').resolves({ status: 'success', data: tip });
    executeCallStub.withArgs('getaddressdeltas').resolves({ status: 'success', data: deltas });
  }

  const written = () => bulkStub.firstCall.args[2].map((op) => [op.updateOne.filter.txid, op.updateOne.update.$set]);

  it('positions each record from one address-index call from the lowest recorded height to the tip', async () => {
    rows.unpositionedRecords = [{ txid: 'a', height: 900 }, { txid: 'b', height: 700 }, { txid: 'gone', height: 800 }];
    daemonAnswers(950, [
      { txid: 'a', height: 900, blockindex: 4, satoshis: 100 },
      { txid: 'b', height: 700, blockindex: 1, satoshis: 100 },
      { txid: 'b', height: 700, blockindex: 1, satoshis: -100 },
    ]);

    const result = await paymentPositions.backfillPaymentPositions();

    sinon.assert.calledOnce(executeCallStub.withArgs('getaddressdeltas'));
    expect(executeCallStub.withArgs('getaddressdeltas').firstCall.args[1][0]).to.include({ start: 700, end: 950 });
    expect(result).to.deep.equal({ positioned: 2, heightsCorrected: 0, unresolved: 1 });
    expect(written()).to.deep.equal([['a', { txIndex: 4, height: 900 }], ['b', { txIndex: 1, height: 700 }]]);
    expect(bulkStub.firstCall.args[2][0].updateOne.filter.txIndex).to.deep.equal({ $exists: false });
  });

  // A v8 node can hold a record written from a block that later left the chain:
  // its height is not where the transaction is. The decider reads a term's start
  // and its fee from that height, so the position comes with the chain's height.
  it('writes the chain\'s height over a recorded height the transaction is not at', async () => {
    rows.unpositionedRecords = [{ txid: 'a', height: 2_021_225 }, { txid: 'b', height: 2_020_000 }];
    // a's true height is above every recorded height, so only a search to the tip finds it
    daemonAnswers(2_030_000, [
      { txid: 'a', height: 2_021_557, blockindex: 3, satoshis: 100 },
      { txid: 'b', height: 2_020_000, blockindex: 2, satoshis: 100 },
    ]);

    const result = await paymentPositions.backfillPaymentPositions();

    expect(result).to.deep.equal({ positioned: 2, heightsCorrected: 1, unresolved: 0 });
    expect(written()).to.deep.equal([['a', { txIndex: 3, height: 2_021_557 }], ['b', { txIndex: 2, height: 2_020_000 }]]);
  });

  it('fails rather than searching a range it cannot bound when the daemon gives no tip', async () => {
    rows.unpositionedRecords = [{ txid: 'a', height: 900 }];
    executeCallStub.withArgs('getBlockCount').resolves({ status: 'error', data: { message: 'loading block index' } });

    let thrown = null;
    await paymentPositions.backfillPaymentPositions().catch((error) => { thrown = error; });

    expect(thrown?.message).to.include('loading block index');
    sinon.assert.notCalled(bulkStub);
  });
});
