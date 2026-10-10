'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const config = require('config');

const dbHelper = require('../../ZelBack/src/services/dbHelper');
const { requireMongo } = require('./dbTestHelper');
const chainState = require('../../ZelBack/src/services/chainState');
const { PAYMENT_WINDOW_MS } = require('../../ZelBack/src/services/appDecisions/decisionRule');
const temporaryPoolSweep = require('../../ZelBack/src/services/appMessaging/temporaryPoolSweep');
const appRecords = require('../../ZelBack/src/services/appDatabase/appRecords');
const { loadSpecLibrary } = require('./fixtures/fluxSpec');

const { MAX_REORG_LENGTH, UNPAYABLE_RECORD_MS } = temporaryPoolSweep;

// Block stamps are seconds. A message signed at SIGNED can be paid by a block
// stamped up to SIGNED + WINDOW_S, and not by one stamped after.
const SIGNED = 1_700_000_000;
const WINDOW_S = PAYMENT_WINDOW_MS / 1000;

function appsGlobal() {
  return dbHelper.databaseConnection().db(config.get('database.appsglobal.database'));
}
function unpayable() {
  return appsGlobal().collection(config.get('database.appsglobal.collections.appsUnpayableMessages'));
}
// The app messages this node holds, over the unit database.
function messages() {
  return appRecords.messages();
}
function appMessages() {
  return appsGlobal().collection(config.get('database.appsglobal.collections.appMessages'));
}

// A pool record as the store writes it: contents, and the pool's facts.
function row({ hash, version = 9, signedAt = SIGNED }) {
  const timestamp = signedAt * 1000;
  return {
    contents: {
      type: 'fluxappregister', version: 1, appSpecifications: { name: 'app', version }, hash, timestamp, signature: 'sig',
    },
    pool: { receivedAt: new Date(timestamp), payableUntil: temporaryPoolSweep.payableUntil(timestamp) },
  };
}
async function pooled(...rows) {
  for (const { contents, pool } of rows) {
    // eslint-disable-next-line no-await-in-loop
    await messages().storeContents(contents, pool);
  }
}

// The pool's facts about a hash, or null when the pool holds nothing for it.
async function stored(hash) {
  const record = await messages().byHash(hash);
  return record && record.isHeld && !record.isPaid ? record.pool : null;
}

async function clear() {
  await Promise.all([appMessages().deleteMany({}), unpayable().deleteMany({})]);
}

describe('temporaryPoolSweep', () => {
  before(async function loadLibrary() {
    this.timeout(30_000);
    await loadSpecLibrary();
    await requireMongo.call(this);
    await clear();
  });

  beforeEach(clear);

  afterEach(() => sinon.restore());

  after(clear);

  it('stamps the deadline as the decider\'s window after the signing', () => {
    expect(temporaryPoolSweep.payableUntil(SIGNED * 1000)).to.deep.equal(new Date(SIGNED * 1000 + PAYMENT_WINDOW_MS));
  });

  it('prepares the unpayable records\' indexes', async () => {
    await temporaryPoolSweep.prepareCollection();

    const byName = new Map((await unpayable().indexes()).map((index) => [index.name, index]));
    expect(byName.get('unpayable by hash').unique).to.equal(true);
    expect(byName.get('unpayable record expiry').expireAfterSeconds).to.equal(0);
  });

  describe('marking the block that closes a window', () => {
    it('marks a row at the first scanned block stamped past its window, and leaves one still inside it', async () => {
      await pooled(row({ hash: 'a' }), row({ hash: 'b', signedAt: SIGNED + 7200 }));

      // The last stamp at which a payment is a's.
      await temporaryPoolSweep.blockScanned({ height: 100, time: SIGNED + WINDOW_S });
      expect((await stored('a')).windowClosedAt).to.equal(undefined);

      await temporaryPoolSweep.blockScanned({ height: 101, time: SIGNED + WINDOW_S + 1 });
      expect((await stored('a')).windowClosedAt).to.equal(101);
      expect((await stored('b')).windowClosedAt).to.equal(undefined);
    });

    it('keeps the first mark as later blocks pass', async () => {
      await pooled(row({ hash: 'a' }));
      await temporaryPoolSweep.blockScanned({ height: 101, time: SIGNED + WINDOW_S + 1 });

      await temporaryPoolSweep.blockScanned({ height: 102, time: SIGNED + WINDOW_S + 31 });

      expect((await stored('a')).windowClosedAt).to.equal(101);
    });

    it('clears a mark at the cursor and judges the block anew: the branch that set it is gone', async () => {
      await pooled(row({ hash: 'a' }));
      await temporaryPoolSweep.blockScanned({ height: 101, time: SIGNED + WINDOW_S + 1 });

      // After a rewind to 100, the new branch's block 101 is stamped inside the window.
      await temporaryPoolSweep.blockScanned({ height: 101, time: SIGNED + WINDOW_S - 10 });
      expect((await stored('a')).windowClosedAt).to.equal(undefined);

      await temporaryPoolSweep.blockScanned({ height: 102, time: SIGNED + WINDOW_S + 20 });
      expect((await stored('a')).windowClosedAt).to.equal(102);
    });

    it('clears a mark above the cursor', async () => {
      await pooled(row({ hash: 'a' }));
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
      await pooled(row({ hash: 'a' }));
      await closeAt(101);

      await temporaryPoolSweep.blockScanned({ height: 101 + MAX_REORG_LENGTH - 1, time: SIGNED + WINDOW_S + 2 });
      expect(await stored('a')).to.not.equal(null);

      await temporaryPoolSweep.blockScanned({ height: 101 + MAX_REORG_LENGTH, time: SIGNED + WINDOW_S + 3 });
      expect(await stored('a')).to.equal(null);
    });

    it('records an unpaid v9 message unpayable, with the height it left at, for 30 days', async () => {
      await pooled(row({ hash: 'a' }));
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
      await pooled(row({ hash: 'in' }), row({ hash: 'late' }));
      await messages().recordPayments([
        { hash: 'in', txid: 'tx-in', height: 90, value: 1 },
        { hash: 'late', txid: 'tx-late', height: 120, value: 1 },
      ]);
      await closeAt(101);

      await temporaryPoolSweep.blockScanned({ height: 141, time: SIGNED + WINDOW_S + 3 });

      expect(await stored('in')).to.equal(null);
      expect(await stored('late')).to.equal(null);
      expect(await temporaryPoolSweep.unpayableRecord('in')).to.equal(null);
      expect(await temporaryPoolSweep.unpayableRecord('late')).to.equal(null);
    });

    it('records nothing for a dropped v1-v8 message: its payment is applied however late', async () => {
      await pooled(row({ hash: 'v8', version: 8 }));
      await closeAt(101);

      await temporaryPoolSweep.blockScanned({ height: 141, time: SIGNED + WINDOW_S + 3 });

      expect(await stored('v8')).to.equal(null);
      expect(await temporaryPoolSweep.unpayableRecord('v8')).to.equal(null);
    });

    it('drops only the rows whose closing block is deep enough', async () => {
      await pooled(row({ hash: 'a' }), row({ hash: 'b', signedAt: SIGNED + 600 }));
      await temporaryPoolSweep.blockScanned({ height: 101, time: SIGNED + WINDOW_S + 1 });
      await temporaryPoolSweep.blockScanned({ height: 121, time: SIGNED + WINDOW_S + 601 });

      await temporaryPoolSweep.blockScanned({ height: 141, time: SIGNED + WINDOW_S + 1201 });

      expect(await stored('a')).to.equal(null);
      expect((await stored('b')).windowClosedAt).to.equal(121);
    });

    it('records a message dropped a second time at the later height', async () => {
      await pooled(row({ hash: 'a' }));
      await closeAt(101);
      await temporaryPoolSweep.blockScanned({ height: 141, time: SIGNED + WINDOW_S + 3 });
      await pooled(row({ hash: 'a' }));
      await closeAt(142);

      await temporaryPoolSweep.blockScanned({ height: 182, time: SIGNED + WINDOW_S + 4 });

      expect((await temporaryPoolSweep.unpayableRecord('a')).droppedAtHeight).to.equal(182);
      expect(await unpayable().countDocuments({ hash: 'a' })).to.equal(1);
    });
  });

  it('answers null for a hash it never dropped', async () => {
    expect(await temporaryPoolSweep.unpayableRecord('nothing')).to.equal(null);
  });

  it('sweeps on every block the scan reports, once started', () => {
    const onBlockScanned = sinon.stub(chainState, 'onBlockScanned');

    temporaryPoolSweep.start();
    temporaryPoolSweep.start();

    sinon.assert.calledOnceWithExactly(onBlockScanned, temporaryPoolSweep.blockScanned);
  });
});
