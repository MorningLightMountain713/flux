'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const config = require('config');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const { requireMongo } = require('./dbTestHelper');
const appRecords = require('../../ZelBack/src/services/appDatabase/appRecords');
const { migrateAppMessages } = require('../../ZelBack/src/services/migrations/appMessages');
const { loadSpecLibrary } = require('./fixtures/fluxSpec');

let PAYMENT_WINDOW_MS;

function db(name) {
  return dbHelper.databaseConnection().db(config.get(name));
}
const payments = () => db('database.daemon.database').collection(config.get('database.daemon.collections.appsHashes'));
const permanent = () => db('database.appsglobal.database').collection(config.get('database.appsglobal.collections.appsMessages'));
const pool = () => db('database.appsglobal.database').collection(config.get('database.appsglobal.collections.appsTemporaryMessages'));
const appMessages = () => db('database.appsglobal.database').collection(config.get('database.appsglobal.collections.appMessages'));

async function dropAll() {
  for (const c of [payments(), permanent(), pool(), appMessages()]) {
    // eslint-disable-next-line no-await-in-loop
    await c.drop().catch(() => {});
  }
}

const contents = (hash, extra = {}) => ({
  type: 'fluxappregister', version: 1, appSpecifications: { name: `app-${hash}`, version: 8 }, hash, timestamp: 1_700_000_000_000, signature: 'sig', ...extra,
});

describe('the app-messages migration', function () {
  this.timeout(30_000);

  before(async function setup() {
    ({ PAYMENT_WINDOW_MS } = await loadSpecLibrary());
    await requireMongo.call(this);
    await dropAll();
  });
  beforeEach(dropAll);
  after(dropAll);

  it('moves nothing on a node that never kept the old collections', async () => {
    expect(await migrateAppMessages()).to.deep.equal({ payments: 0, permanent: 0, pooled: 0 });
    expect(await appMessages().countDocuments({})).to.equal(0);
  });

  // A store a cut-short move left a record in is moved into record by record; an
  // empty one, whole. Both leave the same records.
  const STRANGER = { hash: 'left-by-a-cut-short-move', txid: 't0', height: 1, value: 1 };
  const stores = [
    ['an empty store', async () => {}],
    ['a store a cut-short move left a record in', async () => { await appRecords.messages().recordPayments([STRANGER]); }],
  ];

  stores.forEach(([store, prepare]) => describe(`into ${store}`, () => {
    it('moves the payment index, the permanent messages and the pool into one collection, then drops them', async () => {
      await prepare();
      await payments().insertMany([
        {
          hash: 'confirmed', txid: 't1', height: 100, txIndex: 2, value: 10, blockTime: 1_700_000_100, message: true, syncAttempts: 0, nextRetryHeight: 100, retryFromHeight: 100,
        },
        {
          hash: 'awaiting', txid: 't2', height: 200, value: 20, blockTime: null, message: false, syncAttempts: 3, nextRetryHeight: 900, retryFromHeight: 200, messageNotFound: true,
        },
        {
          hash: 'gone', txid: 't3', height: 300, value: 30, message: false, notOnChain: true,
        },
        {
          hash: 'voided', txid: 't4', height: 400, txIndex: 0, value: 40, blockTime: 1_700_000_400, message: false, voided: true,
        },
        { hash: 'broken-row', txid: 't5' },
      ]);
      await permanent().insertMany([
        { ...contents('confirmed'), txid: 't1', height: 100, valueSat: 10 },
        { ...contents('orphan'), txid: 'peer', height: 5, valueSat: 1 },
        { ...contents('notime', { version: 2 }), txid: 't6', height: 600, valueSat: 60, registeredAt: 1_700_000_600 },
      ]);
      await payments().insertOne({ hash: 'notime', txid: 't6', height: 600, value: 60, blockTime: null, message: true });
      await pool().insertMany([
        { ...contents('pooled'), receivedAt: new Date(1_700_000_000_000), payableUntil: new Date(1_700_000_000_000 + PAYMENT_WINDOW_MS), windowClosedAt: 150 },
        { ...contents('unstamped'), receivedAt: new Date(1_700_000_000_000), expireAt: new Date() },
      ]);

      const moved = await migrateAppMessages();
      expect(moved).to.deep.equal({ payments: 5, permanent: 3, pooled: 2 });

      const messages = appRecords.messages();
      const confirmed = await messages.byHash('confirmed');
      expect(confirmed.isConfirmed).to.equal(true);
      expect(confirmed.payment).to.include({ txid: 't1', height: 100, txIndex: 2, value: 10, blockTime: 1_700_000_100 });
      expect(confirmed.permanentForm()).to.include({ txid: 't1', height: 100, valueSat: 10 });

      const awaiting = await messages.byHash('awaiting');
      expect(awaiting.isPaid).to.equal(true);
      expect(awaiting.isHeld).to.equal(false);
      expect(awaiting.payment).to.include({ syncAttempts: 3, nextRetryHeight: 900, messageNotFound: true });

      expect((await messages.byHash('gone')).isPaid, 'a payment the chain does not hold is no payment').to.equal(false);
      expect((await messages.payment('voided')).voided).to.equal(true);
      expect(await messages.byHash('broken-row')).to.equal(null);

      const orphan = await messages.byHash('orphan');
      expect(orphan.isHeld).to.equal(true);
      expect(orphan.isPaid, 'a message without a payment row waits as the pool\'s').to.equal(false);

      const notime = await messages.byHash('notime');
      expect(notime.payment.blockTime, 'the block time comes from the message\'s term start').to.equal(1_700_000_600);

      const pooled = await messages.byHash('pooled');
      expect(pooled.pool).to.deep.equal({ receivedAt: new Date(1_700_000_000_000), payableUntil: new Date(1_700_000_000_000 + PAYMENT_WINDOW_MS), windowClosedAt: 150 });
      const unstamped = await messages.byHash('unstamped');
      expect(unstamped.pool.payableUntil).to.deep.equal(new Date(1_700_000_000_000 + PAYMENT_WINDOW_MS));
      expect(unstamped.contents).to.not.have.property('expireAt');

      const left = await db('database.daemon.database').listCollections({ name: config.get('database.daemon.collections.appsHashes') }).toArray();
      expect(left).to.deep.equal([]);
      expect((await db('database.appsglobal.database').listCollections().toArray()).map((c) => c.name))
        .to.not.include.members([config.get('database.appsglobal.collections.appsMessages'), config.get('database.appsglobal.collections.appsTemporaryMessages')]);

      expect(await migrateAppMessages(), 'a second run finds nothing to move').to.deep.equal({ payments: 0, permanent: 0, pooled: 0 });
      expect(await appMessages().countDocuments({ hash: { $ne: STRANGER.hash } })).to.equal(8);
    });

    it('carries a message stored under the specification\'s pre-2021 field name', async () => {
      await prepare();
      const { appSpecifications, ...rest } = contents('renamed');
      await payments().insertOne({ hash: 'renamed', txid: 't7', height: 700, value: 70, blockTime: 1_700_000_700, message: true });
      await permanent().insertOne({ ...rest, zelAppSpecifications: appSpecifications, txid: 't7', height: 700, valueSat: 70 });

      expect(await migrateAppMessages()).to.deep.equal({ payments: 1, permanent: 1, pooled: 0 });

      const renamed = await appRecords.messages().byHash('renamed');
      expect(renamed.isConfirmed).to.equal(true);
      expect(renamed.contents.appSpecifications).to.deep.equal(appSpecifications);
      expect(renamed.contents).to.not.have.property('zelAppSpecifications');
    });

    it('keeps the first payment row stored under a hash', async () => {
      await prepare();
      await payments().insertMany([
        { hash: 'paidtwice', txid: 'first', height: 900, value: 90, message: false },
        { hash: 'paidtwice', txid: 'second', height: 950, value: 95, message: false },
      ]);
      expect(await migrateAppMessages()).to.deep.equal({ payments: 1, permanent: 0, pooled: 0 });
      expect(await appRecords.messages().payment('paidtwice')).to.include({ txid: 'first', height: 900 });
    });

    it('keeps the first permanent message stored under a hash', async () => {
      await prepare();
      await payments().insertOne({ hash: 'twice', txid: 't8', height: 800, value: 80, blockTime: 1_700_000_800, message: true });
      await permanent().insertMany([
        { ...contents('twice'), txid: 't8', height: 800, valueSat: 80 },
        { ...contents('twice', { timestamp: 1_700_000_000_001 }), txid: 't8', height: 800, valueSat: 80 },
      ]);
      expect(await migrateAppMessages()).to.deep.equal({ payments: 1, permanent: 1, pooled: 0 });
      expect((await appRecords.messages().byHash('twice')).contents.timestamp).to.equal(1_700_000_000_000);
    });
  }));

  afterEach(() => sinon.restore());

  // Writing whole is what makes a full history move in seconds: storing a
  // record at a time reads each hash back, three round trips a message.
  it('writes into an empty store a batch at a time, and indexes it once the batches are in', async () => {
    const messages = appRecords.messages();
    const calls = [];
    for (const method of ['insertWhole', 'storeContents', 'recordPayments', 'ensureIndexes']) {
      const original = messages[method].bind(messages);
      sinon.stub(messages, method).callsFake(async (...args) => { calls.push(method); return original(...args); });
    }
    await payments().insertMany([{ hash: 'w1', txid: 't1', height: 100, value: 10, message: true }, { hash: 'w2', txid: 't2', height: 200, value: 20, message: false }]);
    await permanent().insertOne({ ...contents('w1'), txid: 't1', height: 100, valueSat: 10 });

    await migrateAppMessages();
    expect(calls).to.deep.equal(['insertWhole', 'insertWhole', 'ensureIndexes']);
    const indexed = (await appMessages().indexes()).map((index) => Object.keys(index.key).join(','));
    expect(indexed, 'the store carries its indexes').to.include('hash');
  });

  it('indexes a store a cut-short move left records in, writes what it holds none of whole, and records what it holds on its own', async () => {
    await appRecords.messages().recordPayments([STRANGER]);
    const messages = appRecords.messages();
    const calls = [];
    for (const method of ['insertWhole', 'recordPayments', 'storeContents', 'ensureIndexes']) {
      const original = messages[method].bind(messages);
      sinon.stub(messages, method).callsFake(async (...args) => { calls.push(method); return original(...args); });
    }
    await payments().insertMany([
      { hash: 'r1', txid: 't1', height: 100, value: 10, message: true },
      { ...STRANGER, message: true },
    ]);
    await permanent().insertMany([
      { ...contents('r1'), txid: 't1', height: 100, valueSat: 10 },
      { ...contents(STRANGER.hash), txid: STRANGER.txid, height: STRANGER.height, valueSat: STRANGER.value },
    ]);

    expect(await migrateAppMessages()).to.deep.equal({ payments: 1, permanent: 2, pooled: 0 });
    expect(calls).to.deep.equal(['ensureIndexes', 'insertWhole', 'recordPayments', 'storeContents']);
    expect((await messages.byHash('r1')).isConfirmed).to.equal(true);
    expect((await messages.byHash(STRANGER.hash)).isConfirmed, 'the record the cut-short move left gains its contents').to.equal(true);
  });

  // What a move cut short leaves: contents held without their payment, and a
  // payment recorded before its contents. The move finishes each by the store's
  // per-record rules, the state each payment carries included.
  it('finishes the records a cut-short move left, with the state their payments carry', async () => {
    const messages = appRecords.messages();
    await messages.storeContents(contents('held-awaiting'));
    await messages.storeContents(contents('held-gone'));
    await messages.recordPayments([{ hash: 'paid-untimed', txid: 'tu', height: 500, value: 50, blockTime: null }]);
    await payments().insertMany([
      {
        hash: 'held-awaiting', txid: 'ta', height: 600, value: 60, message: true, syncAttempts: 4, nextRetryHeight: 950, messageNotFound: true,
      },
      { hash: 'held-gone', txid: 'tg', height: 700, value: 70, message: true, notOnChain: true },
      { hash: 'paid-untimed', txid: 'tu', height: 500, value: 50, message: true },
    ]);
    await permanent().insertMany([
      { ...contents('held-awaiting'), txid: 'ta', height: 600, valueSat: 60 },
      { ...contents('held-gone'), txid: 'tg', height: 700, valueSat: 70 },
      { ...contents('paid-untimed'), txid: 'tu', height: 500, valueSat: 50, registeredAt: 1_700_000_500 },
    ]);

    await migrateAppMessages();
    expect(await messages.payment('held-awaiting')).to.include({ txid: 'ta', syncAttempts: 4, nextRetryHeight: 950, messageNotFound: true });
    const gone = await messages.byHash('held-gone');
    expect(gone.isPaid, 'a payment the chain does not hold is no payment').to.equal(false);
    expect(gone.payment.notOnChain).to.equal(true);
    const untimed = await messages.byHash('paid-untimed');
    expect(untimed.isConfirmed).to.equal(true);
    expect(untimed.payment.blockTime, 'the block time comes from the message\'s term start').to.equal(1_700_000_500);
  });

  // The records each path leaves for the same history, field for field.
  it('leaves the same records whichever store it moves into', async () => {
    async function seed() {
      await payments().insertMany([
        {
          hash: 'p1', txid: 't1', height: 100, txIndex: 2, value: 10, blockTime: null, message: true, syncAttempts: 0, nextRetryHeight: 100, retryFromHeight: 100,
        },
        {
          hash: 'p2', txid: 't2', height: 200, value: 20, blockTime: null, message: false, syncAttempts: 3, nextRetryHeight: 900, retryFromHeight: 200, messageNotFound: true,
        },
        { hash: 'p3', txid: 't3', height: 300, value: 30, message: false, notOnChain: true },
        {
          hash: 'p4', txid: 't4', height: 400, txIndex: 0, value: 40, blockTime: 1_700_000_400, message: false, voided: true,
        },
      ]);
      await permanent().insertMany([
        { ...contents('p1'), txid: 't1', height: 100, valueSat: 10, registeredAt: 1_700_000_100 },
        { ...contents('m1'), txid: 'peer', height: 5, valueSat: 1 },
      ]);
    }
    const records = async () => (await appMessages().find({ hash: { $ne: STRANGER.hash } }, { projection: { _id: 0 } }).sort({ hash: 1 }).toArray())
      .map((doc) => Object.fromEntries(Object.entries(doc).sort(([a], [b]) => a.localeCompare(b))));

    await seed();
    await migrateAppMessages();
    const whole = await records();
    await dropAll();
    await appRecords.messages().recordPayments([STRANGER]);
    await seed();
    await migrateAppMessages();
    expect(await records()).to.deep.equal(whole);
    expect(whole.map((doc) => doc.hash)).to.deep.equal(['m1', 'p1', 'p2', 'p3', 'p4']);
  });
});
