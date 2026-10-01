'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const config = require('config');

const dbHelper = require('../../ZelBack/src/services/dbHelper');
const chainState = require('../../ZelBack/src/services/chainState');
const { PAYMENT_WINDOW_MS } = require('../../ZelBack/src/services/appDecisions/decisionRule');
const temporaryPoolSweep = require('../../ZelBack/src/services/appMessaging/temporaryPoolSweep');

const { MAX_REORG_LENGTH, UNPAYABLE_RECORD_MS } = temporaryPoolSweep;

// Block stamps are seconds. A message signed at SIGNED can be paid by a block
// stamped up to SIGNED + WINDOW_S, and not by one stamped after.
const SIGNED = 1_700_000_000;
const WINDOW_S = PAYMENT_WINDOW_MS / 1000;

function appsGlobal() {
  return dbHelper.databaseConnection().db(config.get('database.appsglobal.database'));
}
function pool() {
  return appsGlobal().collection(config.get('database.appsglobal.collections.appsTemporaryMessages'));
}
function unpayable() {
  return appsGlobal().collection(config.get('database.appsglobal.collections.appsUnpayableMessages'));
}
function records() {
  return dbHelper.databaseConnection().db(config.get('database.daemon.database'))
    .collection(config.get('database.daemon.collections.appsHashes'));
}

// A pool row as the store writes it.
function row({ hash, version = 9, signedAt = SIGNED }) {
  const timestamp = signedAt * 1000;
  return {
    type: 'fluxappregister', version: 1, appSpecifications: { name: 'app', version }, hash, timestamp, signature: 'sig',
    receivedAt: new Date(timestamp), payableUntil: temporaryPoolSweep.payableUntil(timestamp),
  };
}

async function stored(hash) {
  return pool().findOne({ hash }, { projection: { _id: 0 } });
}

async function clear() {
  await Promise.all([pool().deleteMany({}), records().deleteMany({}), unpayable().deleteMany({})]);
}

describe('temporaryPoolSweep', () => {
  before(async () => {
    await dbHelper.initiateDB();
    await clear();
  });

  beforeEach(clear);

  afterEach(() => sinon.restore());

  after(clear);

  it('stamps the deadline as the decider\'s window after the signing', () => {
    expect(temporaryPoolSweep.payableUntil(SIGNED * 1000)).to.deep.equal(new Date(SIGNED * 1000 + PAYMENT_WINDOW_MS));
  });

  it('prepares a plain arrival index on the pool and the unpayable records\' indexes', async () => {
    await temporaryPoolSweep.prepareCollection();

    const arrival = (await pool().indexes()).find((index) => index.name === 'receivedAt_1');
    expect(arrival.key).to.deep.equal({ receivedAt: 1 });
    expect(arrival.expireAfterSeconds).to.equal(undefined);
    const byName = new Map((await unpayable().indexes()).map((index) => [index.name, index]));
    expect(byName.get('unpayable by hash').unique).to.equal(true);
    expect(byName.get('unpayable record expiry').expireAfterSeconds).to.equal(0);
  });

  describe('marking the block that closes a window', () => {
    it('marks a row at the first scanned block stamped past its window, and leaves one still inside it', async () => {
      await pool().insertMany([row({ hash: 'a' }), row({ hash: 'b', signedAt: SIGNED + 7200 })]);

      // The last stamp at which a payment is a's.
      await temporaryPoolSweep.blockScanned({ height: 100, time: SIGNED + WINDOW_S });
      expect((await stored('a')).windowClosedAt).to.equal(undefined);

      await temporaryPoolSweep.blockScanned({ height: 101, time: SIGNED + WINDOW_S + 1 });
      expect((await stored('a')).windowClosedAt).to.equal(101);
      expect((await stored('b')).windowClosedAt).to.equal(undefined);
    });

    it('keeps the first mark as later blocks pass', async () => {
      await pool().insertOne(row({ hash: 'a' }));
      await temporaryPoolSweep.blockScanned({ height: 101, time: SIGNED + WINDOW_S + 1 });

      await temporaryPoolSweep.blockScanned({ height: 102, time: SIGNED + WINDOW_S + 31 });

      expect((await stored('a')).windowClosedAt).to.equal(101);
    });

    it('clears a mark at the cursor and judges the block anew: the branch that set it is gone', async () => {
      await pool().insertOne(row({ hash: 'a' }));
      await temporaryPoolSweep.blockScanned({ height: 101, time: SIGNED + WINDOW_S + 1 });

      // After a rewind to 100, the new branch's block 101 is stamped inside the window.
      await temporaryPoolSweep.blockScanned({ height: 101, time: SIGNED + WINDOW_S - 10 });
      expect((await stored('a')).windowClosedAt).to.equal(undefined);

      await temporaryPoolSweep.blockScanned({ height: 102, time: SIGNED + WINDOW_S + 20 });
      expect((await stored('a')).windowClosedAt).to.equal(102);
    });

    it('clears a mark above the cursor', async () => {
      await pool().insertOne(row({ hash: 'a' }));
      await temporaryPoolSweep.blockScanned({ height: 103, time: SIGNED + WINDOW_S + 1 });

      // After a rewind to 100, the new branch passes the window at 101.
      await temporaryPoolSweep.blockScanned({ height: 101, time: SIGNED + WINDOW_S + 5 });

      expect((await stored('a')).windowClosedAt).to.equal(101);
    });
  });

  describe('leaving the pool', () => {
    // Every row signed at SIGNED has its window closed by this block.
    const closeAt = (height) => temporaryPoolSweep.blockScanned({ height, time: SIGNED + WINDOW_S + 1 });

    it('keeps a row until the block that closed its window is MAX_REORG_LENGTH deep', async () => {
      await pool().insertOne(row({ hash: 'a' }));
      await closeAt(101);

      await temporaryPoolSweep.blockScanned({ height: 101 + MAX_REORG_LENGTH - 1, time: SIGNED + WINDOW_S + 2 });
      expect(await stored('a')).to.not.equal(null);

      await temporaryPoolSweep.blockScanned({ height: 101 + MAX_REORG_LENGTH, time: SIGNED + WINDOW_S + 3 });
      expect(await stored('a')).to.equal(null);
    });

    it('records an unpaid v9 message unpayable, with the height it left at, for 30 days', async () => {
      await pool().insertOne(row({ hash: 'a' }));
      await closeAt(101);
      const before = Date.now();

      await temporaryPoolSweep.blockScanned({ height: 141, time: SIGNED + WINDOW_S + 3 });

      const record = await temporaryPoolSweep.unpayableRecord('a');
      expect(record.hash).to.equal('a');
      expect(record.droppedAtHeight).to.equal(141);
      expect(record.expireAt.getTime()).to.be.within(before + UNPAYABLE_RECORD_MS, Date.now() + UNPAYABLE_RECORD_MS);
      expect(UNPAYABLE_RECORD_MS).to.equal(30 * 24 * 60 * 60 * 1000);
    });

    it('records nothing for a dropped message the chain paid, inside its window or past it', async () => {
      await pool().insertMany([row({ hash: 'in' }), row({ hash: 'late' })]);
      await records().insertMany([
        { hash: 'in', txid: 'tx-in', height: 90, message: true },
        { hash: 'late', txid: 'tx-late', height: 120, message: true },
      ]);
      await closeAt(101);

      await temporaryPoolSweep.blockScanned({ height: 141, time: SIGNED + WINDOW_S + 3 });

      expect(await stored('in')).to.equal(null);
      expect(await stored('late')).to.equal(null);
      expect(await temporaryPoolSweep.unpayableRecord('in')).to.equal(null);
      expect(await temporaryPoolSweep.unpayableRecord('late')).to.equal(null);
    });

    it('records nothing for a dropped v1-v8 message: its payment is applied however late', async () => {
      await pool().insertOne(row({ hash: 'v8', version: 8 }));
      await closeAt(101);

      await temporaryPoolSweep.blockScanned({ height: 141, time: SIGNED + WINDOW_S + 3 });

      expect(await stored('v8')).to.equal(null);
      expect(await temporaryPoolSweep.unpayableRecord('v8')).to.equal(null);
    });

    it('drops only the rows whose closing block is deep enough', async () => {
      await pool().insertMany([row({ hash: 'a' }), row({ hash: 'b', signedAt: SIGNED + 600 })]);
      await temporaryPoolSweep.blockScanned({ height: 101, time: SIGNED + WINDOW_S + 1 });
      await temporaryPoolSweep.blockScanned({ height: 121, time: SIGNED + WINDOW_S + 601 });

      await temporaryPoolSweep.blockScanned({ height: 141, time: SIGNED + WINDOW_S + 1201 });

      expect(await stored('a')).to.equal(null);
      expect((await stored('b')).windowClosedAt).to.equal(121);
    });

    it('records a message dropped a second time at the later height', async () => {
      await pool().insertOne(row({ hash: 'a' }));
      await closeAt(101);
      await temporaryPoolSweep.blockScanned({ height: 141, time: SIGNED + WINDOW_S + 3 });
      await pool().insertOne(row({ hash: 'a' }));
      await closeAt(142);

      await temporaryPoolSweep.blockScanned({ height: 182, time: SIGNED + WINDOW_S + 4 });

      expect((await temporaryPoolSweep.unpayableRecord('a')).droppedAtHeight).to.equal(182);
      expect(await unpayable().countDocuments({ hash: 'a' })).to.equal(1);
    });
  });

  it('answers null for a hash it never dropped', async () => {
    expect(await temporaryPoolSweep.unpayableRecord('nothing')).to.equal(null);
  });

  describe('stampDeadlines', () => {
    it('stamps the deadline on a row written under the wall-clock expiry and drops that field, once', async () => {
      const timestamp = SIGNED * 1000;
      await pool().insertOne({
        type: 'fluxappregister', version: 1, appSpecifications: { name: 'app', version: 8 }, hash: 'old', timestamp, signature: 'sig',
        receivedAt: new Date(), expireAt: new Date(Date.now() + 3_600_000),
      });
      await pool().insertOne(row({ hash: 'new' }));

      expect(await temporaryPoolSweep.stampDeadlines()).to.deep.equal({ stamped: 1 });

      const old = await stored('old');
      expect(old.payableUntil).to.deep.equal(new Date(timestamp + PAYMENT_WINDOW_MS));
      expect(old).to.not.have.property('expireAt');
      expect(await temporaryPoolSweep.stampDeadlines()).to.deep.equal({ stamped: 0 });
    });
  });

  it('sweeps on every block the scan reports, once started', () => {
    const onBlockScanned = sinon.stub(chainState, 'onBlockScanned');

    temporaryPoolSweep.start();
    temporaryPoolSweep.start();

    sinon.assert.calledOnceWithExactly(onBlockScanned, temporaryPoolSweep.blockScanned);
  });
});
