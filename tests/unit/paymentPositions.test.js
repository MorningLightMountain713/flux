// App payment positions: where each payment's transaction sits in its block,
// from the daemon's address index, and the boot backfill that gives every
// payment record recorded without one its position.

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');

const daemonServiceUtils = require('../../ZelBack/src/services/daemonService/daemonServiceUtils');
const chainUtilities = require('../../ZelBack/src/services/utils/chainUtilities');
const { appPaymentPositions } = require('../../ZelBack/src/services/appPaymentPositions');
const { backfillPaymentPositions, BACKFILL_BATCH } = require('../../ZelBack/src/services/migrations/paymentPositions');
const { stubMessages } = require('./fixtures/appRecords');

chai.use(chaiAsPromised);
const { expect } = chai;

const delta = (txid, height, blockindex, satoshis = 500_000_000) => ({
  txid, height, blockindex, satoshis, index: 0, address: chainUtilities.appPaymentAddresses(200)[0],
});

describe('app payment positions', () => {
  let executeCall;

  beforeEach(() => {
    executeCall = sinon.stub(daemonServiceUtils, 'executeCall');
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('appPaymentPositions', () => {
    it('places each paying transaction at its height and position, once, from one uncached call', async () => {
      executeCall.resolves({
        status: 'success',
        data: [delta('a', 100, 3), delta('a', 100, 3), delta('b', 101, 0)],
      });

      const positions = await appPaymentPositions(90, 200);

      expect([...positions]).to.deep.equal([['a', { height: 100, txIndex: 3 }], ['b', { height: 101, txIndex: 0 }]]);
      sinon.assert.calledOnce(executeCall);
      const [rpc, params, options] = executeCall.firstCall.args;
      expect(rpc).to.equal('getaddressdeltas');
      expect(params).to.deep.equal([{ addresses: chainUtilities.appPaymentAddresses(200), start: 90, end: 200 }]);
      expect(options).to.deep.equal({ useCache: false });
    });

    it('ignores a transaction that only spends from a payment address', async () => {
      executeCall.resolves({ status: 'success', data: [delta('spend', 100, 2, -500_000_000)] });
      expect((await appPaymentPositions(90, 200)).size).to.equal(0);
    });

    it('refuses an answer without positions rather than guess one', async () => {
      executeCall.resolves({ status: 'success', data: [{ ...delta('a', 100, 0), blockindex: undefined }] });
      await expect(appPaymentPositions(90, 200)).to.be.rejectedWith('no blockindex for a');
    });

    it('fails when the daemon cannot answer', async () => {
      executeCall.resolves({ status: 'error', data: { message: 'Address index not enabled' } });
      await expect(appPaymentPositions(90, 200)).to.be.rejectedWith('Address index not enabled');
    });
  });

  describe('backfillPaymentPositions', () => {
    let messages;

    beforeEach(() => {
      messages = stubMessages();
    });

    function daemonAnswers(tip, deltas) {
      executeCall.withArgs('getBlockCount').resolves({ status: 'success', data: tip });
      executeCall.withArgs('getaddressdeltas').resolves({ status: 'success', data: deltas });
    }

    // What the migration wrote, by hash: a position, or the not-on-chain mark.
    const written = () => [
      ...messages.setPositions.getCalls().flatMap((call) => call.args[0].map(({ hash, ...position }) => [hash, position])),
      ...messages.markAllNotOnChain.getCalls().flatMap((call) => call.args[0].map((hash) => [hash, { notOnChain: true }])),
    ];

    it('asks the daemon nothing and writes nothing when everything has a position', async () => {
      const result = await backfillPaymentPositions();
      expect(result).to.deep.equal({
        positioned: 0, heightsCorrected: 0, notOnChain: 0, aboveTip: 0,
      });
      sinon.assert.notCalled(executeCall);
      sinon.assert.notCalled(messages.setPositions);
      sinon.assert.notCalled(messages.markAllNotOnChain);
    });

    it('writes the records in batches, each of at most BACKFILL_BATCH', async () => {
      const count = (2 * BACKFILL_BATCH) + 1;
      const records = Array.from({ length: count }, (_, i) => ({ hash: `h${i}`, txid: `t${i}`, height: 694_900 }));
      messages.withoutPosition.resolves([...records, { hash: 'hgone', txid: 'gone', height: 694_900 }]);
      daemonAnswers(694_950, records.map(({ txid }, i) => delta(txid, 694_900, i)));

      const outcome = await backfillPaymentPositions();

      expect(messages.setPositions.getCalls().map((call) => call.args[0].length)).to.deep.equal([BACKFILL_BATCH, BACKFILL_BATCH, 1]);
      expect(messages.markAllNotOnChain.getCalls().map((call) => call.args[0])).to.deep.equal([['hgone']]);
      expect(outcome).to.include({ positioned: count, notOnChain: 1 });
    });

    it('positions each record from one address-index call from the first payment height to the tip, and marks one the chain does not hold', async () => {
      messages.withoutPosition.resolves([
        { hash: 'ha', txid: 'a', height: 694_900 }, { hash: 'hb', txid: 'b', height: 694_700 }, { hash: 'hgone', txid: 'gone', height: 694_800 },
      ]);
      daemonAnswers(694_950, [delta('a', 694_900, 4), delta('b', 694_700, 1), delta('b', 694_700, 1, -500_000_000)]);
      const result = await backfillPaymentPositions();
      sinon.assert.calledOnce(executeCall.withArgs('getaddressdeltas'));
      expect(executeCall.withArgs('getaddressdeltas').firstCall.args[1][0]).to.include({ start: chainUtilities.appPaymentsFrom(), end: 694_950 });
      expect(executeCall.withArgs('getBlockCount').firstCall.args.slice(1)).to.deep.equal([[], { useCache: false }]);
      expect(result).to.deep.equal({
        positioned: 2, heightsCorrected: 0, notOnChain: 1, aboveTip: 0,
      });
      expect(written()).to.deep.equal([
        ['ha', { txIndex: 4, height: 694_900 }], ['hb', { txIndex: 1, height: 694_700 }], ['hgone', { notOnChain: true }],
      ]);
    });

    // A v8 node can hold a record written from a block that later left the chain:
    // its height is not where the transaction is. The decider reads a term's start
    // and its fee from that height, so the position comes with the chain's height.
    it('writes the chain\'s height over a recorded height the transaction is not at', async () => {
      messages.withoutPosition.resolves([{ hash: 'ha', txid: 'a', height: 2_021_225 }, { hash: 'hb', txid: 'b', height: 2_020_000 }]);
      // a's true height is above every recorded height, so only a search to the tip finds it
      daemonAnswers(2_030_000, [delta('a', 2_021_557, 3), delta('b', 2_020_000, 2)]);
      const result = await backfillPaymentPositions();
      expect(result).to.deep.equal({
        positioned: 2, heightsCorrected: 1, notOnChain: 0, aboveTip: 0,
      });
      expect(written()).to.deep.equal([['ha', { txIndex: 3, height: 2_021_557 }], ['hb', { txIndex: 2, height: 2_020_000 }]]);
    });

    it('leaves a record above the daemon\'s tip for a later run', async () => {
      messages.withoutPosition.resolves([{ hash: 'hahead', txid: 'ahead', height: 694_951 }]);
      daemonAnswers(694_950, []);
      const result = await backfillPaymentPositions();
      expect(result).to.deep.equal({
        positioned: 0, heightsCorrected: 0, notOnChain: 0, aboveTip: 1,
      });
      expect(written()).to.deep.equal([]);
    });

    it('fails rather than searching a range it cannot bound when the daemon gives no tip', async () => {
      messages.withoutPosition.resolves([{ hash: 'ha', txid: 'a', height: 694_900 }]);
      executeCall.withArgs('getBlockCount').resolves({ status: 'error', data: { message: 'loading block index' } });
      await expect(backfillPaymentPositions()).to.be.rejectedWith('loading block index');
      sinon.assert.notCalled(messages.setPositions);
      sinon.assert.notCalled(messages.markAllNotOnChain);
    });
  });
});
