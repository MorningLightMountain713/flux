'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const { loadSpecLibrary } = require('./fixtures/fluxSpec');

// The library is real: the history is flux-spec's own UnclaimedPaymentHistory
// and the window rule its voidsPayment, read through the real parser's output.
// What is stubbed is I/O - the payment records, the stored void rows, the
// decision store and the logger.
describe('unclaimedPayments', () => {
  let flux;
  let unclaimedPayments;
  let records;
  let voidRows;
  let updates;
  let undecided;
  let woken;
  let duringLibraryLoad;
  let OPENS;
  let FINAL;

  const HASH = 'ab'.repeat(32);
  const OTHER = 'cd'.repeat(32);
  const PAYMENT_HEIGHT = 2_000_000;

  before(async function loadLibrary() {
    this.timeout(30_000);
    flux = await loadSpecLibrary();
    ({
      VOID_WINDOW_OPENS_AFTER_BLOCKS: OPENS, PAYMENT_FINAL_AFTER_BLOCKS: FINAL,
    } = flux.UnclaimedPaymentMessage);
  });

  const parsedVoid = (hashHex) => flux.UnclaimedPaymentMessage.parse(
    flux.UnclaimedPaymentMessage.encode({ hash: hashHex }),
  );

  /** A stored void row, as the scan writes it. */
  const voidRow = (hashHex, height, txIndex = 0) => ({
    txid: `void-${height}-${txIndex}`, vout: 1, height, txIndex, message: parsedVoid(hashHex),
  });

  const wake = (hashes) => woken.push([...hashes]);

  beforeEach(() => {
    records = new Map();
    voidRows = [];
    updates = [];
    undecided = [];
    woken = [];
    duringLibraryLoad = null;
    unclaimedPayments = proxyquire('../../ZelBack/src/services/appDecisions/unclaimedPayments', {
      '../dbHelper': {
        databaseConnection: () => ({ db: (name) => name }),
        findInDatabase: async () => voidRows.map((row) => ({ ...row })),
        findOneInDatabase: async (_db, _collection, query) => {
          const record = records.get(query.hash);
          return record ? { ...record } : null;
        },
        updateOneInDatabase: async (_db, _collection, query, update) => {
          updates.push({ hash: query.hash, update });
          const record = records.get(query.hash);
          if (!record) return;
          if (update.$set) Object.assign(record, update.$set);
          if (update.$unset) Object.keys(update.$unset).forEach((key) => delete record[key]);
        },
      },
      './decisionStore': { undecide: async (hashes) => undecided.push(...hashes) },
      '../utils/specLibs': {
        getSpecPolicy: async () => {
          if (duringLibraryLoad) duringLibraryLoad();
          return flux;
        },
      },
      '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
    });
  });

  afterEach(() => sinon.restore());

  const pay = (hash, facts = {}) => records.set(hash, { hash, height: PAYMENT_HEIGHT, ...facts });

  async function install(rows) {
    voidRows = rows;
    unclaimedPayments.installUnclaimedPaymentState(await unclaimedPayments.buildUnclaimedPaymentState());
  }

  describe('the built state', () => {
    it('holds every stored void in chain order, whatever order the rows came back in', async () => {
      await install([
        voidRow(HASH, PAYMENT_HEIGHT + OPENS + 5),
        voidRow(OTHER, PAYMENT_HEIGHT + OPENS, 1),
        voidRow(HASH, PAYMENT_HEIGHT + OPENS, 0),
      ]);

      const entries = [...unclaimedPayments.getUnclaimedPaymentHistory().entries()];
      expect(entries.map((entry) => [entry.chainHeight, entry.txIndex, entry.message.hashHex])).to.deep.equal([
        [PAYMENT_HEIGHT + OPENS, 0, HASH],
        [PAYMENT_HEIGHT + OPENS, 1, OTHER],
        [PAYMENT_HEIGHT + OPENS + 5, 0, HASH],
      ]);
    });

    it('is not live until it is installed', async () => {
      voidRows = [voidRow(HASH, PAYMENT_HEIGHT + OPENS)];

      const built = await unclaimedPayments.buildUnclaimedPaymentState();

      expect(unclaimedPayments.isVoided(HASH, PAYMENT_HEIGHT)).to.equal(false);
      unclaimedPayments.installUnclaimedPaymentState(built);
      expect(unclaimedPayments.isVoided(HASH, PAYMENT_HEIGHT)).to.equal(true);
    });

    it('reaches a payment only inside its void window', async () => {
      const voidHeight = PAYMENT_HEIGHT + OPENS;
      await install([voidRow(HASH, voidHeight)]);

      // The void is at the window's first height for this payment ...
      expect(unclaimedPayments.isVoided(HASH, voidHeight - OPENS)).to.equal(true);
      // ... one block early for a payment one block later ...
      expect(unclaimedPayments.isVoided(HASH, voidHeight - OPENS + 1)).to.equal(false);
      // ... at the final height of a payment that far back, which stands ...
      expect(unclaimedPayments.isVoided(HASH, voidHeight - FINAL)).to.equal(false);
      // ... and inside the window of the payment one block after that.
      expect(unclaimedPayments.isVoided(HASH, voidHeight - FINAL + 1)).to.equal(true);
      expect(unclaimedPayments.isVoided(OTHER, voidHeight - OPENS)).to.equal(false);
    });
  });

  describe('applyVoid', () => {
    it('marks the payment voided, removes its decision and wakes the decider for it', async () => {
      pay(HASH);

      const voided = await unclaimedPayments.applyVoid(parsedVoid(HASH), PAYMENT_HEIGHT + OPENS, wake);

      expect(voided).to.equal(true);
      expect(updates).to.deep.equal([{ hash: HASH, update: { $set: { voided: true } } }]);
      expect(undecided).to.deep.equal([HASH]);
      expect(woken).to.deep.equal([[HASH]]);
    });

    it('changes nothing for a payment this node has no record of', async () => {
      const voided = await unclaimedPayments.applyVoid(parsedVoid(HASH), PAYMENT_HEIGHT + OPENS, wake);

      expect(voided).to.equal(false);
      expect(updates).to.deep.equal([]);
      expect(undecided).to.deep.equal([]);
      expect(woken).to.deep.equal([]);
    });

    it('takes effect at both edges of the window and nowhere outside it', async () => {
      const at = async (offset) => {
        records.clear();
        updates.length = 0;
        pay(HASH);
        return unclaimedPayments.applyVoid(parsedVoid(HASH), PAYMENT_HEIGHT + offset, wake);
      };

      expect(await at(OPENS - 1)).to.equal(false);
      expect(updates).to.deep.equal([]);
      expect(await at(OPENS)).to.equal(true);
      expect(await at(FINAL)).to.equal(false);
      expect(updates).to.deep.equal([]);
      expect(await at(FINAL - 1)).to.equal(true);
    });
  });

  describe('onRewind', () => {
    let VOID_HEIGHT;

    before(() => {
      VOID_HEIGHT = PAYMENT_HEIGHT + OPENS + 10;
    });

    it('gives back a hash whose only void the rewind dropped: unmarked, undecided and woken', async () => {
      await install([voidRow(HASH, VOID_HEIGHT)]);
      pay(HASH, { voided: true });

      const given = await unclaimedPayments.onRewind(VOID_HEIGHT, wake);

      expect(given).to.deep.equal([HASH]);
      expect(updates).to.deep.equal([{ hash: HASH, update: { $unset: { voided: '' } } }]);
      expect(records.get(HASH).voided).to.equal(undefined);
      expect(undecided).to.deep.equal([HASH]);
      expect(woken).to.deep.equal([[HASH]]);
    });

    it('keeps a hash that a void below the rewind still reaches', async () => {
      await install([voidRow(HASH, VOID_HEIGHT - 5), voidRow(HASH, VOID_HEIGHT)]);
      pay(HASH, { voided: true });

      const given = await unclaimedPayments.onRewind(VOID_HEIGHT, wake);

      expect(given).to.deep.equal([]);
      expect(updates).to.deep.equal([]);
      expect(undecided).to.deep.equal([]);
      expect(woken).to.deep.equal([]);
    });

    it('gives back a hash whose remaining void is outside the window', async () => {
      await install([voidRow(HASH, PAYMENT_HEIGHT + OPENS - 1), voidRow(HASH, VOID_HEIGHT)]);
      pay(HASH, { voided: true });

      const given = await unclaimedPayments.onRewind(VOID_HEIGHT, wake);

      expect(given).to.deep.equal([HASH]);
    });

    it('touches a dropped void\'s hash only when its payment is recorded and marked', async () => {
      await install([voidRow(HASH, VOID_HEIGHT), voidRow(OTHER, VOID_HEIGHT, 1)]);
      pay(HASH);

      const given = await unclaimedPayments.onRewind(VOID_HEIGHT, wake);

      expect(given).to.deep.equal([]);
      expect(updates).to.deep.equal([]);
      expect(woken).to.deep.equal([]);
    });

    it('leaves a void below the rewind alone', async () => {
      await install([voidRow(HASH, VOID_HEIGHT)]);
      pay(HASH, { voided: true });

      const given = await unclaimedPayments.onRewind(VOID_HEIGHT + 1, wake);

      expect(given).to.deep.equal([]);
      expect(updates).to.deep.equal([]);
    });

    it('reads the dropped voids before it first waits, so the rebuild that follows cannot hide them', async () => {
      await install([voidRow(HASH, VOID_HEIGHT)]);
      pay(HASH, { voided: true });
      duringLibraryLoad = () => unclaimedPayments.installUnclaimedPaymentState({
        unclaimedPaymentHistory: new flux.UnclaimedPaymentHistory(),
      });

      const given = await unclaimedPayments.onRewind(VOID_HEIGHT, wake);

      expect(given).to.deep.equal([HASH]);
    });

    it('does nothing before the state is built', async () => {
      const given = await unclaimedPayments.onRewind(VOID_HEIGHT, wake);

      expect(given).to.deep.equal([]);
      expect(woken).to.deep.equal([]);
    });
  });
});
