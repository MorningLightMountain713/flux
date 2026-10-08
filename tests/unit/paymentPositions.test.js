'use strict';

const { expect } = require('chai');
const config = require('config');
const sinon = require('sinon');
const daemonServiceUtils = require('../../ZelBack/src/services/daemonService/daemonServiceUtils');
const paymentPositions = require('../../ZelBack/src/services/migrations/paymentPositions');
const { stubMessages } = require('./fixtures/appRecords');

describe('paymentPositions', () => {
  let messages;
  let executeCallStub;

  beforeEach(() => {
    messages = stubMessages();
    executeCallStub = sinon.stub(daemonServiceUtils, 'executeCall');
  });

  afterEach(() => {
    sinon.restore();
  });

  it('asks the daemon nothing and writes nothing when everything has a position', async () => {
    const result = await paymentPositions.backfillPaymentPositions();
    expect(result).to.deep.equal({ positioned: 0, heightsCorrected: 0, notOnChain: 0 });
    sinon.assert.notCalled(executeCallStub);
    sinon.assert.notCalled(messages.setPosition);
    sinon.assert.notCalled(messages.markNotOnChain);
  });

  function daemonAnswers(tip, deltas) {
    executeCallStub.withArgs('getBlockCount').resolves({ status: 'success', data: tip });
    executeCallStub.withArgs('getaddressdeltas').resolves({ status: 'success', data: deltas });
  }

  // What the migration wrote, by hash: a position, or the not-on-chain mark.
  const written = () => [
    ...messages.setPosition.getCalls().map((call) => [call.args[0], call.args[1]]),
    ...messages.markNotOnChain.getCalls().map((call) => [call.args[0], { notOnChain: true }]),
  ];

  // The first height any app payment address is active from: where a search that
  // can prove a transaction absent from the chain has to begin.
  const FIRST_PAYMENT_HEIGHT = Math.min(...config.get('fluxapps.appPaymentAddresses').map((a) => a.activeFromHeight));

  it('positions each record from one address-index call over every height a payment can be at, and marks one the chain does not hold', async () => {
    messages.withoutPosition.resolves([
      { hash: 'ha', txid: 'a', height: 900 }, { hash: 'hb', txid: 'b', height: 700 }, { hash: 'hgone', txid: 'gone', height: 800 },
    ]);
    daemonAnswers(950, [
      { txid: 'a', height: 900, blockindex: 4, satoshis: 100 },
      { txid: 'b', height: 700, blockindex: 1, satoshis: 100 },
      { txid: 'b', height: 700, blockindex: 1, satoshis: -100 },
    ]);
    const result = await paymentPositions.backfillPaymentPositions();
    sinon.assert.calledOnce(executeCallStub.withArgs('getaddressdeltas'));
    expect(executeCallStub.withArgs('getaddressdeltas').firstCall.args[1][0]).to.include({ start: FIRST_PAYMENT_HEIGHT, end: 950 });
    expect(result).to.deep.equal({ positioned: 2, heightsCorrected: 0, notOnChain: 1 });
    expect(written()).to.deep.equal([
      ['ha', { txIndex: 4, height: 900 }], ['hb', { txIndex: 1, height: 700 }], ['hgone', { notOnChain: true }],
    ]);
  });

  // A v8 node can hold a record written from a block that later left the chain:
  // its height is not where the transaction is. The decider reads a term's start
  // and its fee from that height, so the position comes with the chain's height.
  it('writes the chain\'s height over a recorded height the transaction is not at', async () => {
    messages.withoutPosition.resolves([{ hash: 'ha', txid: 'a', height: 2_021_225 }, { hash: 'hb', txid: 'b', height: 2_020_000 }]);
    // a's true height is above every recorded height, so only a search to the tip finds it
    daemonAnswers(2_030_000, [
      { txid: 'a', height: 2_021_557, blockindex: 3, satoshis: 100 },
      { txid: 'b', height: 2_020_000, blockindex: 2, satoshis: 100 },
    ]);
    const result = await paymentPositions.backfillPaymentPositions();
    expect(result).to.deep.equal({ positioned: 2, heightsCorrected: 1, notOnChain: 0 });
    expect(written()).to.deep.equal([['ha', { txIndex: 3, height: 2_021_557 }], ['hb', { txIndex: 2, height: 2_020_000 }]]);
  });

  it('fails rather than searching a range it cannot bound when the daemon gives no tip', async () => {
    messages.withoutPosition.resolves([{ hash: 'ha', txid: 'a', height: 900 }]);
    executeCallStub.withArgs('getBlockCount').resolves({ status: 'error', data: { message: 'loading block index' } });
    let thrown = null;
    await paymentPositions.backfillPaymentPositions().catch((error) => { thrown = error; });
    expect(thrown?.message).to.include('loading block index');
    sinon.assert.notCalled(messages.setPosition);
  });
});
