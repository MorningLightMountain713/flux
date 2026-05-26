const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

chai.use(chaiAsPromised);
const { expect } = chai;

describe('MongoStorageProvider', () => {
  let dbHelperStub;
  let specLibsStub;
  let mongoStorageProvider;
  let fakeClient;
  let fakeDb;
  let fakeCollection;

  class MockStorageProviderBase {
    constructor() {
      if (new.target === MockStorageProviderBase) {
        throw new Error('abstract');
      }
    }
  }

  beforeEach(() => {
    fakeCollection = {
      replaceOne: sinon.stub().resolves({}),
      deleteOne: sinon.stub().resolves({}),
    };
    fakeDb = { collection: sinon.stub().returns(fakeCollection) };
    fakeClient = { db: sinon.stub().returns(fakeDb) };

    dbHelperStub = {
      databaseConnection: sinon.stub().returns(fakeClient),
      findInDatabase: sinon.stub().resolves([{ name: 'a' }, { name: 'b' }]),
      findOneInDatabase: sinon.stub().resolves({ name: 'one' }),
      replaceOneInDatabase: sinon.stub().resolves({}),
      removeDocumentsFromCollection: sinon.stub().resolves({}),
    };

    specLibsStub = {
      getSpecBackend: sinon.stub().resolves({ StorageProvider: MockStorageProviderBase }),
    };

    mongoStorageProvider = proxyquire(
      '../../ZelBack/src/services/providers/MongoStorageProvider',
      {
        '../dbHelper': dbHelperStub,
        '../utils/specLibs': specLibsStub,
      },
    );
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('create()', () => {
    it('returns an instance of the StorageProvider base', async () => {
      const provider = await mongoStorageProvider.create();
      expect(provider).to.be.instanceOf(MockStorageProviderBase);
    });

    it('loads the base class lazily via specLibs', async () => {
      expect(specLibsStub.getSpecBackend.called).to.be.false;
      await mongoStorageProvider.create();
      expect(specLibsStub.getSpecBackend.calledOnce).to.be.true;
    });
  });

  describe('default store map', () => {
    it('maps appSpecs to globalzelapps.zelappsinformation', () => {
      expect(mongoStorageProvider.DEFAULT_STORE_MAP.appSpecs).to.deep.equal({
        database: 'globalzelapps',
        collection: 'zelappsinformation',
      });
    });

    it('maps tempAppMessages to globalzelapps.zelappstemporarymessages', () => {
      expect(mongoStorageProvider.DEFAULT_STORE_MAP.tempAppMessages).to.deep.equal({
        database: 'globalzelapps',
        collection: 'zelappstemporarymessages',
      });
    });

    it('maps chainMessages to chainparams.chainmessages', () => {
      expect(mongoStorageProvider.DEFAULT_STORE_MAP.chainMessages).to.deep.equal({
        database: 'chainparams',
        collection: 'chainmessages',
      });
    });

    it('is frozen', () => {
      expect(Object.isFrozen(mongoStorageProvider.DEFAULT_STORE_MAP)).to.be.true;
    });
  });

  describe('get()', () => {
    it('resolves the store map and delegates to dbHelper.findOneInDatabase', async () => {
      const provider = await mongoStorageProvider.create();
      const result = await provider.get('appSpecs', { name: 'foo' });

      expect(fakeClient.db.calledOnceWith('globalzelapps')).to.be.true;
      expect(dbHelperStub.findOneInDatabase.calledOnceWith(
        fakeDb, 'zelappsinformation', { name: 'foo' },
      )).to.be.true;
      expect(result).to.deep.equal({ name: 'one' });
    });

    it('throws on unknown logical store', async () => {
      const provider = await mongoStorageProvider.create();
      await expect(provider.get('nonsense', {})).to.be.rejectedWith(/Unknown logical store/);
    });

    it('throws when no MongoDB connection is available', async () => {
      dbHelperStub.databaseConnection.returns(null);
      const provider = await mongoStorageProvider.create();
      await expect(provider.get('appSpecs', { name: 'x' }))
        .to.be.rejectedWith(/No MongoDB connection/);
    });
  });

  describe('put()', () => {
    it('uses replaceOneInDatabase with upsert to prevent ghost fields', async () => {
      const provider = await mongoStorageProvider.create();
      await provider.put('appSpecs', { name: 'foo' }, { name: 'foo', value: 42 });

      expect(dbHelperStub.replaceOneInDatabase.calledOnce).to.be.true;
      const [db, collection, filter, doc, options] = dbHelperStub.replaceOneInDatabase.firstCall.args;
      expect(db).to.equal(fakeDb);
      expect(collection).to.equal('zelappsinformation');
      expect(filter).to.deep.equal({ name: 'foo' });
      expect(doc).to.deep.equal({ name: 'foo', value: 42 });
      expect(options).to.deep.equal({ upsert: true });
    });
  });

  describe('list()', () => {
    it('delegates to dbHelper.findInDatabase with the resolved collection', async () => {
      const provider = await mongoStorageProvider.create();
      const result = await provider.list('appMessages', { hash: 'abc' });

      expect(dbHelperStub.findInDatabase.calledOnceWith(
        fakeDb, 'zelappsmessages', { hash: 'abc' },
      )).to.be.true;
      expect(result).to.deep.equal([{ name: 'a' }, { name: 'b' }]);
    });

    it('passes an empty query when none is provided', async () => {
      const provider = await mongoStorageProvider.create();
      await provider.list('appMessages');
      const [, , query] = dbHelperStub.findInDatabase.firstCall.args;
      expect(query).to.deep.equal({});
    });
  });

  describe('remove()', () => {
    it('delegates to dbHelper.removeDocumentsFromCollection with the key', async () => {
      const provider = await mongoStorageProvider.create();
      await provider.remove('appSpecs', { name: 'gone' });

      expect(dbHelperStub.removeDocumentsFromCollection.calledOnce).to.be.true;
      const [db, collection, key] = dbHelperStub.removeDocumentsFromCollection.firstCall.args;
      expect(db).to.equal(fakeDb);
      expect(collection).to.equal('zelappsinformation');
      expect(key).to.deep.equal({ name: 'gone' });
    });
  });

  describe('options', () => {
    it('always uses dbHelper.databaseConnection for the client', async () => {
      const provider = await mongoStorageProvider.create();
      await provider.get('appSpecs', { name: 'x' });

      expect(fakeClient.db.calledWith('globalzelapps')).to.be.true;
      expect(dbHelperStub.databaseConnection.called).to.be.true;
    });

    it('accepts a custom store map override', async () => {
      const customMap = {
        testStore: { database: 'testdb', collection: 'testcol' },
      };
      const provider = await mongoStorageProvider.create({ storeMap: customMap });
      await provider.get('testStore', { id: 1 });

      expect(fakeClient.db.calledOnceWith('testdb')).to.be.true;
      expect(dbHelperStub.findOneInDatabase.calledOnceWith(fakeDb, 'testcol', { id: 1 })).to.be.true;
    });

    it('rejects logical stores not in the custom map', async () => {
      const customMap = { onlyStore: { database: 'x', collection: 'y' } };
      const provider = await mongoStorageProvider.create({ storeMap: customMap });

      await expect(provider.get('appSpecs', {}))
        .to.be.rejectedWith(/Unknown logical store: "appSpecs"/);
    });
  });
});
