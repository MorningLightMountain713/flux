'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const config = require('config');

const dbHelper = require('../../ZelBack/src/services/dbHelper');
const capabilities = require('../../ZelBack/src/services/utils/capabilities');
const capabilityHistory = require('../../ZelBack/src/services/capabilityHistory');
const { requireMongo } = require('./dbTestHelper');

const COLLECTION = config.get('database.local.collections.capabilityTransitions');

function database() {
  return dbHelper.databaseConnection().db(config.get('database.local.database'));
}

// Lets the writes a transition starts finish.
const settle = () => new Promise((resolve) => { setImmediate(resolve); });

async function stored() {
  return database().collection(COLLECTION).find({}, { projection: { _id: 0 } }).sort({ $natural: 1 }).toArray();
}

// The rows once `done` holds of them, or the last rows read after two seconds.
async function storedOnce(done) {
  const deadline = Date.now() + 2000;
  let rows = await stored();
  while (!done(rows) && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    // eslint-disable-next-line no-await-in-loop
    rows = await stored();
  }
  return rows;
}

describe('capabilityHistory tests', () => {
  before(requireMongo);

  beforeEach(async () => {
    await database().collection(COLLECTION).drop().catch(() => {});
    capabilities.resetForTests();
    capabilityHistory.resetForTests();
  });

  afterEach(() => {
    sinon.restore();
    capabilities.resetForTests();
    capabilityHistory.resetForTests();
  });

  it('keeps the collection capped by row count', async () => {
    await capabilityHistory.prepareCollection();
    const options = await database().collection(COLLECTION).options();
    expect(options).to.include({ capped: true, max: capabilityHistory.MAX_ROWS });
    // A second boot finds it and leaves it.
    await capabilityHistory.prepareCollection();
    expect(await database().collection(COLLECTION).options()).to.include({ capped: true });
  });

  it('writes the transitions made before the database was prepared once it is, keyed by this process', async () => {
    await capabilityHistory.prepareCollection();
    capabilities.setForTests('apiListening', true);
    capabilityHistory.start();
    capabilities.setForTests('policyVerified', true);
    await settle();
    expect(await stored(), 'written before the database was prepared').to.deep.equal([]);

    capabilities.setForTests('localDbPrepared', true);
    const rows = await storedOnce((r) => r.length >= 4);
    expect(rows.map((row) => `${row.name}:${row.to}`)).to.deep.equal([
      'apiListening:up', 'policyVerified:up', 'mongoReachable:up', 'localDbPrepared:up',
    ]);
    rows.forEach((row) => expect(row.startedAt).to.equal(capabilityHistory.STARTED_AT));
  });

  it('holds what it could not write and writes it with the next transition', async () => {
    await capabilityHistory.prepareCollection();
    capabilities.setForTests('localDbPrepared', true);
    capabilityHistory.start();
    await settle();
    const insert = sinon.stub(dbHelper, 'insertManyToDatabase').rejects(new Error('write refused'));
    capabilities.setForTests('policyVerified', true);
    await settle();
    insert.restore();
    capabilities.setForTests('apiListening', true);
    const rows = await storedOnce((r) => r.some((row) => row.name === 'apiListening'));
    expect(rows.map((row) => row.name).slice(-2)).to.deep.equal(['policyVerified', 'apiListening']);
  });

  it('answers each process newest first, its transitions oldest first, with what is not yet written', async () => {
    await capabilityHistory.prepareCollection();
    const earlier = capabilityHistory.STARTED_AT - 60_000;
    await database().collection(COLLECTION).insertMany([
      {
        startedAt: earlier, name: 'mongoReachable', from: 'down', to: 'up', at: earlier + 10, reason: 'r', tookMs: 10, waitingOn: null,
      },
      {
        startedAt: earlier, name: 'mongoReachable', from: 'up', to: 'down', at: earlier + 20, reason: 'r', tookMs: 10, waitingOn: null,
      },
    ]);
    capabilities.setForTests('apiListening', true);
    capabilityHistory.start();
    await settle();

    const answer = await capabilityHistory.history();
    expect(answer.map((boot) => boot.startedAt)).to.deep.equal([capabilityHistory.STARTED_AT, earlier]);
    expect(answer[0].transitions.map((t) => t.name), 'the unwritten transition is missing').to.deep.equal(['apiListening']);
    expect(answer[1].transitions.map((t) => t.to)).to.deep.equal(['up', 'down']);
    expect(answer[1].transitions[0]).to.not.have.property('startedAt');
  });

  it('answers at most the last processes it is bounded to', async () => {
    await capabilityHistory.prepareCollection();
    const rows = Array.from({ length: capabilityHistory.BOOTS_ANSWERED + 2 }, (_, i) => ({
      startedAt: 1000 + i, name: 'apiListening', from: 'down', to: 'up', at: 2000 + i, reason: 'r', tookMs: 1, waitingOn: null,
    }));
    await database().collection(COLLECTION).insertMany(rows);
    const answer = await capabilityHistory.history();
    expect(answer).to.have.length(capabilityHistory.BOOTS_ANSWERED);
    expect(answer[0].startedAt).to.equal(1000 + capabilityHistory.BOOTS_ANSWERED + 1);
  });

  it('starts once', async () => {
    await capabilityHistory.prepareCollection();
    capabilities.setForTests('localDbPrepared', true);
    capabilityHistory.start();
    capabilityHistory.start();
    await settle();
    capabilities.setForTests('apiListening', true);
    const rows = await storedOnce((r) => r.some((row) => row.name === 'apiListening'));
    // Long enough for a second subscription's write to land after the first.
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    expect(rows.filter((row) => row.name === 'apiListening')).to.have.length(1);
    expect((await stored()).filter((row) => row.name === 'apiListening')).to.have.length(1);
  });
});
