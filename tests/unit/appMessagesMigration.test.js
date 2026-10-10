'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const config = require('config');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const { requireMongo } = require('./dbTestHelper');
const appRecords = require('../../ZelBack/src/services/appDatabase/appRecords');
const { migrateAppMessages } = require('../../ZelBack/src/services/migrations/appMessages');
const { PAYMENT_WINDOW_MS } = require('../../ZelBack/src/services/appDecisions/decisionRule');
const { loadSpecLibrary } = require('./fixtures/fluxSpec');

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
    await loadSpecLibrary();
    await requireMongo.call(this);
    await dropAll();
  });
  beforeEach(dropAll);
  after(dropAll);

  it('moves nothing on a node that never kept the old collections', async () => {
    expect(await migrateAppMessages()).to.deep.equal({ payments: 0, permanent: 0, pooled: 0 });
    expect(await appMessages().countDocuments({})).to.equal(0);
  });

  it('moves the payment index, the permanent messages and the pool into one collection, then drops them', async () => {
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
    expect(await appMessages().countDocuments({})).to.equal(8);
  });

  it('carries a message stored under the specification\'s pre-2021 field name', async () => {
    const { appSpecifications, ...rest } = contents('renamed');
    await payments().insertOne({ hash: 'renamed', txid: 't7', height: 700, value: 70, blockTime: 1_700_000_700, message: true });
    await permanent().insertOne({ ...rest, zelAppSpecifications: appSpecifications, txid: 't7', height: 700, valueSat: 70 });

    expect(await migrateAppMessages()).to.deep.equal({ payments: 1, permanent: 1, pooled: 0 });

    const renamed = await appRecords.messages().byHash('renamed');
    expect(renamed.isConfirmed).to.equal(true);
    expect(renamed.contents.appSpecifications).to.deep.equal(appSpecifications);
    expect(renamed.contents).to.not.have.property('zelAppSpecifications');
  });
});
