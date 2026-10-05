'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const config = require('config');

const dbHelper = require('../../ZelBack/src/services/dbHelper');
const specLibrary = require('../../ZelBack/src/services/utils/specLibrary');
const MongoStorageProvider = require('../../ZelBack/src/services/providers/MongoStorageProvider');
const { requireMongo } = require('./dbTestHelper');

chai.use(chaiAsPromised);
const { expect } = chai;

// The adapter is held to the port's own meaning of a query, queryMatches, over
// the same records: the value shapes the record collections hold - scalars,
// arrays of scalars, nested objects, null, absent - under every operator.
describe('MongoStorageProvider', () => {
  const STORE = 'records';
  const stores = {
    [STORE]: { database: config.get('database.appsglobal.database'), collection: 'storageprovidertest' },
  };

  const records = [
    {
      k: 'a', n: 1, s: 'x', tags: ['x', 'y'], nested: { k: 'v', n: 2 }, nul: null,
    },
    {
      k: 'b', n: 5, s: 'y', tags: [], nested: { k: 'w' },
    },
    {
      k: 'c', n: 10, s: 'z', tags: ['z'], nul: 'set',
    },
    { k: 'd', tags: ['x'], nested: { n: 7 } },
    { k: 'e', n: null, s: 'x' },
  ];

  const queries = [
    {},
    { k: 'a' }, { k: 'none' }, { n: 5 }, { s: 'x' },
    { tags: 'x' }, { tags: 'y' }, { tags: 'none' }, { tags: ['x', 'y'] }, { tags: [] },
    { 'nested.k': 'v' }, { 'nested.n': 7 }, { 'nested.missing': 'v' }, { 'k.deeper': 'v' },
    { nul: null }, { n: null }, { missing: null },
    { k: { in: ['a', 'c'] } }, { k: { in: [] } }, { tags: { in: ['z', 'y'] } }, { n: { in: [1, 10] } },
    { nul: { in: [null] } }, { n: { in: [5, null] } }, { missing: { in: [null] } },
    { k: { ne: 'a' } }, { tags: { ne: 'x' } }, { n: { ne: 5 } }, { nul: { ne: null } }, { n: { ne: null } }, { missing: { ne: 1 } },
    { nul: { exists: true } }, { nul: { exists: false } }, { n: { exists: true } }, { n: { exists: false } },
    { 'nested.k': { exists: true } }, { 'nested.n': { exists: false } }, { missing: { exists: false } },
    { n: { gt: 1 } }, { n: { gte: 5 } }, { n: { lt: 10 } }, { n: { lte: 1 } }, { n: { gt: 1, lt: 10 } }, { n: { gte: 10, lte: 10 } },
    { s: { gt: 'x' } }, { s: { lte: 'x' } }, { 'nested.n': { gt: 2 } }, { missing: { lt: 10 } },
    { n: { in: [1, 5], ne: 5 } }, { n: { exists: true, gt: 1 } },
    { or: [{ k: 'a' }, { n: 5 }] }, { or: [{ k: 'none' }, { n: 99 }] }, { or: [] }, { or: [{ tags: 'x' }, { 'nested.k': 'w' }], n: { gt: 1 } },
    { k: 'a', or: [{ n: 1 }] }, { k: 'b', or: [{ n: 1 }] },
  ];

  let provider;
  let queryMatches;

  before(async function setUp() {
    await requireMongo.call(this);
    ({ queryMatches } = specLibrary.loaded());
    provider = MongoStorageProvider.create(stores);
  });

  beforeEach(async () => {
    await provider.remove(STORE, {});
    await provider.insert(STORE, records);
  });

  const keys = (found) => found.map((r) => r.k).sort();

  it('answers every query as queryMatches does over the same records', async () => {
    const answers = [];
    for (const query of queries) {
      const expected = keys(records.filter((r) => queryMatches(r, query)));
      // eslint-disable-next-line no-await-in-loop
      const found = await provider.find(STORE, query);
      expect(keys(found), JSON.stringify(query)).to.deep.equal(expected);
      // eslint-disable-next-line no-await-in-loop
      expect(await provider.count(STORE, query), `count ${JSON.stringify(query)}`).to.equal(expected.length);
      answers.push(expected.length);
    }
    // The queries tell the records apart: some match all, some none, some a part.
    expect(answers).to.include(records.length);
    expect(answers).to.include(0);
    expect(answers.some((n) => n > 0 && n < records.length)).to.equal(true);
  });

  it('returns a record without the document id, and leaves the caller\'s records without one', async () => {
    for (const record of records) expect(record).to.not.have.property('_id');
    const [found] = await provider.find(STORE, { k: 'a' });
    expect(found).to.deep.equal(records[0]);
    expect(await provider.findOne(STORE, { k: 'a' })).to.deep.equal(records[0]);
    expect(await provider.findOne(STORE, { k: 'none' })).to.equal(null);
  });

  it('returns only the fields asked for, those the record has', async () => {
    const found = await provider.find(STORE, {}, { fields: ['k', 'n'], sort: { k: 1 } });
    expect(found).to.deep.equal([
      { k: 'a', n: 1 }, { k: 'b', n: 5 }, { k: 'c', n: 10 }, { k: 'd' }, { k: 'e', n: null },
    ]);
  });

  it('sorts and limits', async () => {
    expect(keys(await provider.find(STORE, {}, { sort: { k: -1 }, limit: 2 }))).to.deep.equal(['d', 'e']);
    expect((await provider.find(STORE, {}, { sort: { k: -1 } })).map((r) => r.k)).to.deep.equal(['e', 'd', 'c', 'b', 'a']);
    expect((await provider.findOne(STORE, { s: 'x' }, { sort: { k: -1 } })).k).to.equal('e');
  });

  it('refuses a condition that mixes an operator with another key', async () => {
    expect(() => MongoStorageProvider.toFilter({ n: { gt: 1, regex: 'x' } })).to.throw(/mixes operators/);
  });

  it('replaces the record a query names, adding it on upsert alone', async () => {
    await provider.replace(STORE, { k: 'a' }, { k: 'a', n: 100 });
    expect(await provider.findOne(STORE, { k: 'a' })).to.deep.equal({ k: 'a', n: 100 });
    await provider.replace(STORE, { k: 'new' }, { k: 'new', n: 1 });
    expect(await provider.findOne(STORE, { k: 'new' })).to.equal(null);
    await provider.replace(STORE, { k: 'new' }, { k: 'new', n: 1 }, { upsert: true });
    expect(await provider.findOne(STORE, { k: 'new' })).to.deep.equal({ k: 'new', n: 1 });
    expect(await provider.count(STORE, {})).to.equal(records.length + 1);
  });

  it('sets and unsets fields on every record a query names', async () => {
    await provider.update(STORE, { tags: 'x' }, { set: { marked: true }, unset: ['nested'] });
    expect(keys(await provider.find(STORE, { marked: true }))).to.deep.equal(['a', 'd']);
    expect(keys(await provider.find(STORE, { nested: { exists: true } }))).to.deep.equal(['b']);
    await provider.update(STORE, { k: 'b' }, { unset: ['nested'] });
    expect(keys(await provider.find(STORE, { nested: { exists: true } }))).to.deep.equal([]);
    await provider.update(STORE, { k: 'b' }, {});
    expect(await provider.count(STORE, {})).to.equal(records.length);
  });

  it('removes every record a query names', async () => {
    await provider.remove(STORE, { s: 'x' });
    expect(keys(await provider.find(STORE, {}))).to.deep.equal(['b', 'c', 'd']);
  });

  it('creates an index for each declared set of fields, and again without complaint', async () => {
    const collection = dbHelper.databaseConnection().db(stores[STORE].database).collection(stores[STORE].collection);
    await collection.dropIndexes();
    await provider.ensureIndexes(STORE, [{ fields: ['k'] }, { fields: ['tags'] }, { fields: ['nested.k', 'n'] }]);
    await provider.ensureIndexes(STORE, [{ fields: ['k'] }, { fields: ['tags'] }, { fields: ['nested.k', 'n'] }]);
    const indexed = (await collection.listIndexes().toArray()).map((index) => JSON.stringify(index.key));
    expect(indexed).to.include.members([JSON.stringify({ k: 1 }), JSON.stringify({ tags: 1 }), JSON.stringify({ 'nested.k': 1, n: 1 })]);
  });

  it('makes a declared unique set of fields refuse a second record with the same values', async () => {
    const collection = dbHelper.databaseConnection().db(stores[STORE].database).collection(stores[STORE].collection);
    await collection.dropIndexes();
    await provider.ensureIndexes(STORE, [{ fields: ['k', 's'], unique: true }]);
    const unique = (await collection.listIndexes().toArray()).find((index) => JSON.stringify(index.key) === JSON.stringify({ k: 1, s: 1 }));
    expect(unique.unique).to.equal(true);
    await expect(provider.insert(STORE, [{ k: 'a', s: 'x' }])).to.be.rejectedWith(/duplicate key/);
    await provider.insert(STORE, [{ k: 'a', s: 'other' }]);
    await collection.dropIndexes();
  });

  it('refuses a store it was not given', async () => {
    await expect(provider.find('nonsense', {})).to.be.rejectedWith(/unknown store/);
  });
});
