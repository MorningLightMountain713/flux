'use strict';

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const config = require('config');
const sinon = require('sinon');

const chainState = require('../../ZelBack/src/services/chainState');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const { stubMessages } = require('./fixtures/appRecords');
const entitlementsState = require('../../ZelBack/src/services/entitlementsState');
const priceOracleState = require('../../ZelBack/src/services/pricing/priceOracleState');
const unclaimedPayments = require('../../ZelBack/src/services/appDecisions/unclaimedPayments');
const capabilities = require('../../ZelBack/src/services/utils/capabilities');

chai.use(chaiAsPromised);
const { expect } = chai;

const V9_SOFT_FORK_COLLECTIONS = [
  config.get('database.chainparams.collections.policyGroupMessages'),
  config.get('database.chainparams.collections.priceMessages'),
  config.get('database.chainparams.collections.rateMessages'),
  config.get('database.chainparams.collections.priceModifierMessages'),
  config.get('database.chainparams.collections.oracleKeyMessages'),
  config.get('database.chainparams.collections.unclaimedPaymentMessages'),
];

describe('chainState', () => {
  let cursor;
  let events;
  let removeStub;
  let messages;
  let updateStub;
  let builtPolicyGroups;
  let builtPrices;
  let builtVoids;

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
    messages = stubMessages();
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
    builtVoids = { unclaimedPaymentHistory: { tag: 'new voids' } };
    sinon.stub(unclaimedPayments, 'buildUnclaimedPaymentState').callsFake(async () => {
      events.push('build voids');
      return builtVoids;
    });
    sinon.stub(entitlementsState, 'installPolicyGroupState').callsFake(() => events.push('install groups'));
    sinon.stub(priceOracleState, 'installPriceOracleState').callsFake(() => events.push('install prices'));
    sinon.stub(unclaimedPayments, 'installUnclaimedPaymentState').callsFake(() => events.push('install voids'));
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
      expect(events.slice(-4)).to.deep.equal(['install groups', 'install prices', 'install voids', 'capability up']);
    });

    it('takes the app payments off, and deletes their decisions, legacy rows and every v9 soft-fork row above the height', async () => {
      await chainState.rewind('test', 900);

      const query = { height: { $gt: 900 } };
      sinon.assert.calledOnceWithExactly(messages.removePaymentsAbove, 900);
      for (const collection of ['appdecisions', 'chainmessages', ...V9_SOFT_FORK_COLLECTIONS]) {
        sinon.assert.calledWithMatch(removeStub, sinon.match.object, collection, query);
      }
      sinon.assert.neverCalledWithMatch(removeStub, sinon.match.object, 'zelappsinformation');
    });

    it('deletes every v9 soft-fork row on a reindex to height 0', async () => {
      const height = await chainState.rewind('reindex', 0);

      expect(height).to.equal(0);
      for (const collection of V9_SOFT_FORK_COLLECTIONS) {
        sinon.assert.calledWithMatch(removeStub, sinon.match.object, collection, { height: { $gt: 0 } });
      }
    });

    it('builds every history set before installing any', async () => {
      await chainState.rewind('test', 900);

      expect(events.indexOf('build prices')).to.be.below(events.indexOf('install groups'));
      expect(events.indexOf('build voids')).to.be.below(events.indexOf('install groups'));
      sinon.assert.calledOnceWithExactly(entitlementsState.installPolicyGroupState, builtPolicyGroups);
      sinon.assert.calledOnceWithExactly(priceOracleState.installPriceOracleState, builtPrices);
      sinon.assert.calledOnceWithExactly(unclaimedPayments.installUnclaimedPaymentState, builtVoids);
    });

    it('never rewinds above the durable cursor', async () => {
      cursor = 800;

      const height = await chainState.rewind('test', 900);

      expect(height).to.equal(800);
      sinon.assert.calledOnceWithExactly(messages.removePaymentsAbove, 800);
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

    it('waits for a rewind listener that returns a promise before building the histories', async () => {
      const unsubscribe = chainState.onRewind(() => new Promise((resolve) => {
        setImmediate(() => {
          events.push('listener done');
          resolve();
        });
      }));

      await chainState.rewind('test', 900);
      unsubscribe();

      expect(events.indexOf('listener done')).to.be.above(-1);
      expect(events.indexOf('listener done')).to.be.below(events.indexOf('build groups'));
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

  describe('blockScanned', () => {
    it('tells every listener the block, in the order they registered', async () => {
      const heard = [];
      const unsubscribe = [
        chainState.onBlockScanned(async (block) => heard.push(['first', block])),
        chainState.onBlockScanned(async (block) => heard.push(['second', block])),
      ];

      await chainState.blockScanned({ height: 1001, time: 1_700_000_000 });
      unsubscribe.forEach((fn) => fn());

      expect(heard).to.deep.equal([
        ['first', { height: 1001, time: 1_700_000_000 }],
        ['second', { height: 1001, time: 1_700_000_000 }],
      ]);
    });

    it('never fails the block when a listener throws, and still tells the rest', async () => {
      const later = sinon.stub().resolves();
      const unsubscribe = [
        chainState.onBlockScanned(async () => { throw new Error('boom'); }),
        chainState.onBlockScanned(later),
      ];

      await chainState.blockScanned({ height: 1001, time: 1 });
      unsubscribe.forEach((fn) => fn());

      sinon.assert.calledOnce(later);
    });

    it('stops telling a listener that unsubscribed', async () => {
      const listener = sinon.stub().resolves();
      chainState.onBlockScanned(listener)();

      await chainState.blockScanned({ height: 1001, time: 1 });

      sinon.assert.notCalled(listener);
    });
  });
});
