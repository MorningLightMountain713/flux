'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const { asConfig } = require('./fixtures/config');

// The records a release before instance resources left: read until each is
// cleared by its teardown, written by nothing.
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
      databaseConnection: () => ({ db: () => ({}) }),
      findOneInDatabase: async (_db, _coll, query) => {
        guard();
        if (query.key !== undefined) return store.get(query.key) || null;
        if (query.name !== undefined) return [...store.values()].find((d) => d.name === query.name) || null;
        if (query['components.identifier'] !== undefined) {
          return [...store.values()].find((d) => (d.components || []).some((c) => c.identifier === query['components.identifier'])) || null;
        }
        return null;
      },
      findInDatabase: async () => { guard(); return [...store.values()]; },
      updateOneInDatabase: async (_db, _coll, query, update) => {
        guard();
        const doc = store.get(query.key);
        if (doc && update.$inc) doc.attempts = (doc.attempts || 0) + update.$inc.attempts;
      },
      removeDocumentsFromCollection: async (_db, _coll, query) => { guard(); store.delete(query.key); },
    };
    pendingTeardownStore = proxyquire('../../ZelBack/src/services/appLifecycle/pendingTeardownStore', {
      config: asConfig({ database: { appslocal: { database: 'localapps', collections: { pendingAppTeardowns: 'zelappspendingteardowns' } } } }),
      '../../lib/log': logStub,
      '../dbHelper': dbHelperStub,
    });
  });

  afterEach(() => sinon.restore());

  const left = (doc) => store.set(doc.key, doc);

  it('reads a record by key, by the component it names, and all of them', async () => {
    left({ key: 'app', name: 'app', components: [{ identifier: 'c_app' }] });
    left({ key: 'other_r1', name: 'other', components: [{ identifier: 'c_other_r1' }] });
    expect((await pendingTeardownStore.getTeardown('app')).name).to.equal('app');
    expect(await pendingTeardownStore.getTeardown('nobody')).to.equal(null);
    expect((await pendingTeardownStore.teardownForComponent('c_other_r1')).key).to.equal('other_r1');
    expect(await pendingTeardownStore.teardownForComponent('nothing')).to.equal(null);
    expect((await pendingTeardownStore.readAllTeardowns()).map((d) => d.key).sort()).to.deep.equal(['app', 'other_r1']);
  });

  it('clears a record once its teardown finished, and counts the passes that left work owed', async () => {
    left({ key: 'app', name: 'app', attempts: 0 });
    await pendingTeardownStore.bumpAttempts('app');
    expect((await pendingTeardownStore.getTeardown('app')).attempts).to.equal(1);
    await pendingTeardownStore.clearTeardown('app');
    expect(await pendingTeardownStore.getTeardown('app')).to.equal(null);
  });

  it('teardownOwedFor is true while a record names the app, false otherwise', async () => {
    expect(await pendingTeardownStore.teardownOwedFor('app')).to.equal(false);
    left({ key: 'app', name: 'app' });
    expect(await pendingTeardownStore.teardownOwedFor('app')).to.equal(true);
  });

  it('teardownOwedFor FAILS CLOSED (true) on a DB read error, and the other reads answer nothing', async () => {
    dbThrows = true;
    expect(await pendingTeardownStore.teardownOwedFor('app')).to.equal(true);
    expect(await pendingTeardownStore.getTeardown('app')).to.equal(null);
    expect(await pendingTeardownStore.readAllTeardowns()).to.deep.equal([]);
    expect(await pendingTeardownStore.teardownForComponent('c')).to.equal(null);
  });

  it('writes nothing: the store has no writer', () => {
    expect(pendingTeardownStore.writeTeardown).to.equal(undefined);
    expect(pendingTeardownStore.prepareCollection).to.equal(undefined);
  });
});
