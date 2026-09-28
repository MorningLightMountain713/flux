'use strict';

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const config = require('config');
const sinon = require('sinon');

const chainState = require('../../ZelBack/src/services/chainState');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const entitlementsState = require('../../ZelBack/src/services/entitlementsState');
const priceOracleState = require('../../ZelBack/src/services/pricing/priceOracleState');
const capabilities = require('../../ZelBack/src/services/utils/capabilities');

chai.use(chaiAsPromised);
const { expect } = chai;

const V9_SOFT_FORK_COLLECTIONS = [
  config.get('database.chainparams.collections.policyGroupMessages'),
  config.get('database.chainparams.collections.priceMessages'),
  config.get('database.chainparams.collections.rateMessages'),
  config.get('database.chainparams.collections.priceModifierMessages'),
  config.get('database.chainparams.collections.oracleKeyMessages'),
];

describe('chainState', () => {
  let cursor;
  let events;
  let removeStub;
  let updateStub;
  let builtPolicyGroups;
  let builtPrices;

  beforeEach(() => {
    capabilities.resetForTests();
    cursor = 1000;
    events = [];
    capabilities.onTransition('chainStateConsistent', (record) => events.push(`capability ${record.to}`));

    const db = { collection: () => ({}) };
    sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => db });
    sinon.stub(dbHelper, 'findOneInDatabase').callsFake(async () => ({ generalScannedHeight: cursor }));
    updateStub = sinon.stub(dbHelper, 'updateOneInDatabase').callsFake(async (_db, _collection, _query, update) => {
      events.push(`cursor ${update.$set.generalScannedHeight}`);
    });
    removeStub = sinon.stub(dbHelper, 'removeDocumentsFromCollection').callsFake(async (_db, collection) => {
      events.push(`delete ${collection}`);
    });

    builtPolicyGroups = { policyGroupHistory: { tag: 'new groups' }, featureEntitlements: {} };
    builtPrices = {
      priceMessageHistory: { tag: 'new prices' }, rateMessageHistory: {}, priceModifierHistory: {}, oracleKeyHistory: {},
    };
    sinon.stub(entitlementsState, 'buildPolicyGroupState').callsFake(async () => {
      events.push('build groups');
      return builtPolicyGroups;
    });
    sinon.stub(priceOracleState, 'buildPriceOracleState').callsFake(async () => {
      events.push('build prices');
      return builtPrices;
    });
    sinon.stub(entitlementsState, 'installPolicyGroupState').callsFake(() => events.push('install groups'));
    sinon.stub(priceOracleState, 'installPriceOracleState').callsFake(() => events.push('install prices'));
  });

  afterEach(() => {
    sinon.restore();
    capabilities.resetForTests();
  });

  describe('rewind', () => {
    it('lowers chain state, writes the cursor, deletes, builds, installs, then raises', async () => {
      capabilities.claim('chainStateConsistent', 'chainState').raise('test');
      events.length = 0;

      const height = await chainState.rewind('test', 900);

      expect(height).to.equal(900);
      expect(events[0]).to.equal('capability down');
      expect(events[1]).to.equal('cursor 900');
      const lastDelete = events.map((e) => e.startsWith('delete')).lastIndexOf(true);
      expect(events.indexOf('build groups')).to.be.above(lastDelete);
      expect(events.slice(-3)).to.deep.equal(['install groups', 'install prices', 'capability up']);
    });

    it('deletes app payment records, their decisions, legacy rows and every v9 soft-fork row above the height', async () => {
      await chainState.rewind('test', 900);

      const query = { height: { $gt: 900 } };
      for (const collection of ['zelappshashes', 'appdecisions', 'chainmessages', ...V9_SOFT_FORK_COLLECTIONS]) {
        sinon.assert.calledWithMatch(removeStub, sinon.match.object, collection, query);
      }
      sinon.assert.neverCalledWithMatch(removeStub, sinon.match.object, 'zelappsmessages');
      sinon.assert.neverCalledWithMatch(removeStub, sinon.match.object, 'zelappsinformation');
    });

    it('deletes every v9 soft-fork row on a reindex to height 0', async () => {
      const height = await chainState.rewind('reindex', 0);

      expect(height).to.equal(0);
      for (const collection of V9_SOFT_FORK_COLLECTIONS) {
        sinon.assert.calledWithMatch(removeStub, sinon.match.object, collection, { height: { $gt: 0 } });
      }
    });

    it('deletes stored app messages and registry rows when asked to rescan apps', async () => {
      await chainState.rewind('test', 900, { rescanGlobalApps: true });

      sinon.assert.calledWithMatch(removeStub, sinon.match.object, 'zelappsmessages', { height: { $gt: 900 } });
      sinon.assert.calledWithMatch(removeStub, sinon.match.object, 'zelappsinformation', { height: { $gt: 900 } });
    });

    it('builds both history sets before installing either', async () => {
      await chainState.rewind('test', 900);

      expect(events.indexOf('build prices')).to.be.below(events.indexOf('install groups'));
      sinon.assert.calledOnceWithExactly(entitlementsState.installPolicyGroupState, builtPolicyGroups);
      sinon.assert.calledOnceWithExactly(priceOracleState.installPriceOracleState, builtPrices);
    });

    it('never rewinds above the durable cursor', async () => {
      cursor = 800;

      const height = await chainState.rewind('test', 900);

      expect(height).to.equal(800);
      sinon.assert.calledWithMatch(removeStub, sinon.match.object, 'zelappshashes', { height: { $gt: 800 } });
    });

    it('asks a target function with the cursor it read under the lock', async () => {
      const target = sinon.stub().returns(950);

      const height = await chainState.rewind('test', target);

      sinon.assert.calledOnceWithExactly(target, { cursor: 1000 });
      expect(height).to.equal(950);
    });

    it('does nothing when the target answers null', async () => {
      capabilities.claim('chainStateConsistent', 'chainState').raise('test');
      const before = chainState.rewindCount();
      events.length = 0;

      const height = await chainState.rewind('test', () => null);

      expect(height).to.equal(null);
      expect(events).to.deep.equal([]);
      expect(chainState.rewindCount()).to.equal(before);
    });

    it('refuses a target that is not a height, writing nothing', async () => {
      await expect(chainState.rewind('test', -1)).to.be.rejectedWith('is not a height');
      await expect(chainState.rewind('test', 12.5)).to.be.rejectedWith('is not a height');
      sinon.assert.notCalled(updateStub);
      sinon.assert.notCalled(removeStub);
    });

    it('counts every rewind that starts', async () => {
      const before = chainState.rewindCount();

      await chainState.rewind('test', 900);

      expect(chainState.rewindCount()).to.equal(before + 1);
    });

    it('tells rewind listeners the height after deleting and before building', async () => {
      const heard = [];
      const unsubscribe = chainState.onRewind((height) => {
        heard.push(height);
        events.push('listener');
      });

      await chainState.rewind('test', 900);
      unsubscribe();

      expect(heard).to.deep.equal([900]);
      const lastDelete = events.map((e) => e.startsWith('delete')).lastIndexOf(true);
      expect(events.indexOf('listener')).to.be.above(lastDelete);
      expect(events.indexOf('listener')).to.be.below(events.indexOf('build groups'));
    });

    it('leaves chain state down and the cursor low when the deletion throws', async () => {
      capabilities.claim('chainStateConsistent', 'chainState').raise('test');
      removeStub.rejects(new Error('test: db died mid rewind'));

      await expect(chainState.rewind('test', 900)).to.be.rejectedWith('db died');

      expect(capabilities.isUp('chainStateConsistent')).to.equal(false);
      sinon.assert.calledOnce(updateStub);
      sinon.assert.notCalled(entitlementsState.installPolicyGroupState);
    });

    it('releases the lock after a rewind that throws', async () => {
      removeStub.onFirstCall().rejects(new Error('test: db died mid rewind'));
      await expect(chainState.rewind('test', 900)).to.be.rejected;

      await expect(chainState.exclusive(async () => 'ran')).to.eventually.equal('ran');
    });
  });

  describe('exclusive', () => {
    it('runs a rewind only after the holder in front of it finishes', async () => {
      let release;
      const held = chainState.exclusive(() => new Promise((resolve) => {
        events.push('block start');
        release = () => {
          events.push('block end');
          resolve();
        };
      }));
      const rewound = chainState.rewind('test', 900);
      await new Promise((resolve) => { setImmediate(resolve); });

      expect(events).to.deep.equal(['block start']);
      release();
      await held;
      await rewound;
      expect(events[1]).to.equal('block end');
      expect(events[2]).to.equal('cursor 900');
    });

    it('starts a block only after a rewind in front of it finishes', async () => {
      const rewound = chainState.rewind('test', 900);
      const block = chainState.exclusive(async () => events.push('block'));

      await Promise.all([rewound, block]);

      expect(events[events.length - 1]).to.equal('block');
      expect(events.indexOf('block')).to.be.above(events.indexOf('capability up'));
    });
  });
});
