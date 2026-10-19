'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const config = require('config');

const dbHelper = require('../../ZelBack/src/services/dbHelper');
const { loadSpecLibrary } = require('./fixtures/fluxSpec');

const CHAIN_MESSAGES = config.get('database.chainparams.collections.chainMessages');
const PRICE_ROW = {
  txid: 'tx-p', height: 2_000_000, message: 'p_0.06_0.02_0.008_0.02_0.8_1.6_0.8', version: 'p',
};

// A fresh copy of the module: its installed state is per process.
function freshState() {
  return proxyquire('../../ZelBack/src/services/pricing/priceOracleState', {});
}

function storeHolds(rows) {
  sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({}) });
  return sinon.stub(dbHelper, 'findInDatabase').callsFake(async (database, collection) => (collection === CHAIN_MESSAGES ? rows : []));
}

const heights = (cards) => cards.map((card) => card.height);

describe('the legacy price cards are chain state, held in memory', () => {
  before(async function loadLibrary() {
    this.timeout(30_000);
    await loadSpecLibrary();
  });

  afterEach(() => sinon.restore());

  it('reads the store until the histories are installed', async () => {
    const find = storeHolds([PRICE_ROW]);
    const state = freshState();

    const cards = await state.getLegacyPriceSchedule();

    sinon.assert.calledWithMatch(find, sinon.match.any, CHAIN_MESSAGES, { version: 'p' });
    expect(heights(cards)).to.deep.equal([...config.get('fluxapps.price').map((card) => card.height), 2_000_000].sort((a, b) => a - b));
    expect(cards.at(-1)).to.include({ cpu: 0.06, minPrice: 0.02, staticip: 0.8 });
  });

  it('is built with the other histories and answered from memory once installed', async () => {
    const find = storeHolds([PRICE_ROW]);
    const state = freshState();
    state.installPriceOracleState(await state.buildPriceOracleState());
    find.resetHistory();

    const cards = await state.getLegacyPriceSchedule();

    sinon.assert.notCalled(find);
    expect(heights(cards)).to.include(2_000_000);
  });

  it('takes a legacy price message the scan stores, replacing its transaction\'s row, and nothing else', async () => {
    storeHolds([]);
    const state = freshState();
    state.installPriceOracleState(await state.buildPriceOracleState());

    state.recordLegacyPrice(PRICE_ROW);
    state.recordLegacyPrice({ ...PRICE_ROW, message: 'p_0.07_0.02_0.008_0.03' });
    state.recordLegacyPrice({ ...PRICE_ROW, txid: 'tx-other', version: 'x' });

    const added = (await state.getLegacyPriceSchedule()).filter((card) => card.height === 2_000_000);
    expect(added).to.have.lengthOf(1);
    expect(added[0]).to.include({ cpu: 0.07, minPrice: 0.03 });
  });

  it('leaves a message stored before the histories are installed to the build', async () => {
    storeHolds([]);
    const state = freshState();

    state.recordLegacyPrice(PRICE_ROW);

    expect(heights(await state.getLegacyPriceSchedule())).to.not.include(2_000_000);
  });
});
