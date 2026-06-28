const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('pendingTeardownStore tests', () => {
  let store; // key -> doc
  let pendingTeardownStore;
  let logStub;
  let dbThrows;

  beforeEach(() => {
    store = new Map();
    dbThrows = false;
    logStub = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };
    const guard = () => { if (dbThrows) throw new Error('db down'); };
    const dbHelperStub = {
      databaseConnection: () => ({ db: () => ({ collection: () => ({ createIndex: sinon.stub().resolves() }) }) }),
      findOneInDatabase: async (_db, _coll, query) => {
        guard();
        if (query.key !== undefined) return store.get(query.key) || null;
        if (query.name !== undefined) return [...store.values()].find((d) => d.name === query.name) || null;
        return null;
      },
      findInDatabase: async () => { guard(); return [...store.values()]; },
      updateOneInDatabase: async (_db, _coll, query, update) => {
        guard();
        store.set(query.key, { ...(store.get(query.key) || {}), ...update.$set });
      },
      removeDocumentsFromCollection: async (_db, _coll, query) => { guard(); store.delete(query.key); },
    };
    pendingTeardownStore = proxyquire('../../ZelBack/src/services/appLifecycle/pendingTeardownStore', {
      config: { database: { appslocal: { database: 'localapps', collections: { pendingAppTeardowns: 'zelappspendingteardowns' } } } },
      '../../lib/log': logStub,
      '../dbHelper': dbHelperStub,
    });
  });

  afterEach(() => sinon.restore());

  it('persists an owed-teardown record and reads it back', async () => {
    await pendingTeardownStore.writeTeardown({ key: 'app', name: 'app', components: [{ identifier: 'c_app' }] });
    const doc = await pendingTeardownStore.getTeardown('app');
    expect(doc.name).to.equal('app');
    expect(doc.components).to.have.lengthOf(1);
  });

  it('readAllTeardowns returns every record (boot recovery)', async () => {
    await pendingTeardownStore.writeTeardown({ key: 'a', name: 'a' });
    await pendingTeardownStore.writeTeardown({ key: 'b', name: 'b' });
    const all = await pendingTeardownStore.readAllTeardowns();
    expect(all.map((d) => d.key).sort()).to.deep.equal(['a', 'b']);
  });

  it('clearTeardown drops the record', async () => {
    await pendingTeardownStore.writeTeardown({ key: 'app', name: 'app' });
    await pendingTeardownStore.clearTeardown('app');
    expect(await pendingTeardownStore.getTeardown('app')).to.equal(null);
  });

  it('teardownOwedFor is true while a teardown is owed for the name, false otherwise', async () => {
    expect(await pendingTeardownStore.teardownOwedFor('app')).to.equal(false);
    await pendingTeardownStore.writeTeardown({ key: 'app', name: 'app' });
    expect(await pendingTeardownStore.teardownOwedFor('app')).to.equal(true);
  });

  it('teardownOwedFor FAILS CLOSED (true) on a DB read error', async () => {
    dbThrows = true;
    expect(await pendingTeardownStore.teardownOwedFor('app')).to.equal(true);
  });

  it('writeTeardown does NOT swallow a persist failure (the prelude must fail closed)', async () => {
    dbThrows = true;
    let threw = false;
    await pendingTeardownStore.writeTeardown({ key: 'app', name: 'app' }).catch(() => { threw = true; });
    expect(threw).to.equal(true);
  });
});
