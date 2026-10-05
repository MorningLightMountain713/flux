'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

describe('appIdentityMoveStore', () => {
  let dbHelper;
  let store;
  const db = { db: () => ({ collection: () => 'moves' }) };

  beforeEach(() => {
    dbHelper = {
      databaseConnection: () => db,
      ensureIndex: sinon.stub().resolves(),
      replaceOneInDatabase: sinon.stub().resolves(),
      findOneInDatabase: sinon.stub().resolves(null),
      findInDatabase: sinon.stub().resolves([]),
      removeDocumentsFromCollection: sinon.stub().resolves(),
    };
    store = proxyquire('../../ZelBack/src/services/appLifecycle/appIdentityMoveStore', { '../dbHelper': dbHelper });
  });

  it('keeps one record per instance', async () => {
    await store.prepareCollection();
    sinon.assert.calledOnceWithExactly(dbHelper.ensureIndex, 'moves', { name: 1, replica: 1 }, { unique: true, name: 'move per instance' });
  });

  it('records a move in progress by the instance, with the identity it moves onto and when it began', async () => {
    await store.begin('myapp', 'r1', 'idx', 123);
    const [, collection, filter, doc, options] = dbHelper.replaceOneInDatabase.firstCall.args;
    expect(collection).to.equal('zelappsidentitymoves');
    expect(filter).to.deep.equal({ name: 'myapp', replica: 'r1' });
    expect(doc).to.deep.equal({
      name: 'myapp', replica: 'r1', to: 'idx', since: 123,
    });
    expect(options).to.deep.equal({ upsert: true });

    await store.begin('loose', null, 'idy');
    expect(dbHelper.replaceOneInDatabase.secondCall.args[2]).to.deep.equal({ name: 'loose', replica: null });
    expect(dbHelper.replaceOneInDatabase.secondCall.args[3].since).to.be.a('number');
  });

  it('answers the move in progress for an instance, or null', async () => {
    dbHelper.findOneInDatabase.resolves({ name: 'myapp', replica: null, to: 'idx', since: 5 });
    expect(await store.inProgress('myapp', null)).to.deep.equal({ to: 'idx', since: 5 });
    expect(dbHelper.findOneInDatabase.firstCall.args[2]).to.deep.equal({ name: 'myapp', replica: null });
    dbHelper.findOneInDatabase.resolves(null);
    expect(await store.inProgress('other', 'r2')).to.equal(null);
  });

  it('lists every move in progress, and ends one by the instance', async () => {
    dbHelper.findInDatabase.resolves([{ name: 'a', to: 'ida', since: 1 }, { name: 'b', replica: 'r1', to: 'idb', since: 2 }]);
    expect(await store.all()).to.deep.equal([
      { name: 'a', replica: null, to: 'ida', since: 1 }, { name: 'b', replica: 'r1', to: 'idb', since: 2 },
    ]);
    await store.end('b', 'r1');
    expect(dbHelper.removeDocumentsFromCollection.firstCall.args[2]).to.deep.equal({ name: 'b', replica: 'r1' });
  });
});
