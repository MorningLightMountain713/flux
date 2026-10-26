'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const config = require('config');

const dbHelper = require('../../ZelBack/src/services/dbHelper');
const { loadSpecLibrary } = require('./fixtures/fluxSpec');

chai.use(chaiAsPromised);
const { expect } = chai;

const PRICE_MESSAGES = config.get('database.chainparams.collections.priceMessages');
const RATE_MESSAGES = config.get('database.chainparams.collections.rateMessages');
const MODIFIER_MESSAGES = config.get('database.chainparams.collections.priceModifierMessages');

const HEIGHT = 2_000_000;
const BLOCK_TIME = 1_750_000_000;
const NOTICE = 3600;
// In force an hour after the block and well past the depth.
const AFTER = { time: BLOCK_TIME + NOTICE, height: HEIGHT + 200 };
const BEFORE = { time: BLOCK_TIME + NOTICE - 1, height: HEIGHT + 200 };

const rows = (blockTime) => ({
  [PRICE_MESSAGES]: [{
    txid: 'tx-price', vout: 1, height: HEIGHT, txIndex: 1, message: { fields: { cpuRate: 7 } }, ...blockTime,
  }],
  [RATE_MESSAGES]: [{
    txid: 'tx-rate', vout: 1, height: HEIGHT, txIndex: 2, message: { timestamp: 1, fluxUsdPriceE4: 700, bytesConsumed: 9 }, ...blockTime,
  }],
  [MODIFIER_MESSAGES]: [{
    txid: 'tx-mod', vout: 1, height: HEIGHT, txIndex: 3, message: { fields: { fiatMarkupBp: 70 }, unknown: new Map() }, ...blockTime,
  }],
});

function stateOver(stored, lookupBlockTime) {
  sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({}) });
  sinon.stub(dbHelper, 'findInDatabase').callsFake(async (database, collection) => stored[collection] ?? []);
  const update = sinon.stub(dbHelper, 'updateOneInDatabase').resolves();
  const state = proxyquire('../../ZelBack/src/services/pricing/priceOracleState', {
    '../daemonService/daemonServiceBlockchainRpcs': { lookupBlockTime },
  });
  return { state, update };
}

describe('the price, rate and modifier histories are built at their blocks\' times', () => {
  before(async function loadLibrary() {
    this.timeout(30_000);
    await loadSpecLibrary();
  });

  afterEach(() => sinon.restore());

  it('places each stored row by the block time it carries, without asking the daemon', async () => {
    const lookupBlockTime = sinon.stub().rejects(new Error('not asked'));
    const { state, update } = stateOver(rows({ blockTime: BLOCK_TIME }), lookupBlockTime);
    state.installPriceOracleState(await state.buildPriceOracleState());

    expect(state.getPriceMessageHistory().resolveAt(BEFORE)).to.deep.equal({});
    expect(state.getPriceMessageHistory().resolveAt(AFTER)).to.deep.equal({ cpuRate: 7 });
    expect(state.getRateMessageHistory().resolveAt(BEFORE)).to.equal(null);
    expect(state.getRateMessageHistory().resolveAt(AFTER).fluxUsdPriceE4).to.equal(700);
    expect(state.getPriceModifierHistory().resolveAt(BEFORE)).to.deep.equal({});
    expect(state.getPriceModifierHistory().resolveAt(AFTER)).to.deep.equal({ fiatMarkupBp: 70 });
    sinon.assert.notCalled(lookupBlockTime);
    sinon.assert.notCalled(update);
  });

  it('takes a row\'s missing block time from the daemon and keeps it on the row', async () => {
    const lookupBlockTime = sinon.stub().resolves(BLOCK_TIME);
    const { state, update } = stateOver(rows({}), lookupBlockTime);
    state.installPriceOracleState(await state.buildPriceOracleState());

    expect(state.getPriceMessageHistory().resolveAt(AFTER)).to.deep.equal({ cpuRate: 7 });
    expect(state.getRateMessageHistory().resolveAt(AFTER).fluxUsdPriceE4).to.equal(700);
    expect(state.getPriceModifierHistory().resolveAt(AFTER)).to.deep.equal({ fiatMarkupBp: 70 });
    sinon.assert.alwaysCalledWithExactly(lookupBlockTime, HEIGHT);
    for (const [collection, txid] of [[PRICE_MESSAGES, 'tx-price'], [RATE_MESSAGES, 'tx-rate'], [MODIFIER_MESSAGES, 'tx-mod']]) {
      sinon.assert.calledWithExactly(update, sinon.match.any, collection, { txid, vout: 1 }, { $set: { blockTime: BLOCK_TIME } });
    }
  });

  it('refuses to build when the daemon cannot say when a row\'s block was mined', async () => {
    const { state, update } = stateOver(rows({}), sinon.stub().resolves(null));

    await expect(state.buildPriceOracleState()).to.be.rejectedWith(/no block time for tx-price at height 2000000/);
    sinon.assert.notCalled(update);
  });
});
