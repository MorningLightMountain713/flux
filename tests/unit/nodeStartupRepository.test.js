const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('nodeStartupRepository tests', () => {
  let repository;
  let dbHelperStub;

  const STARTUP_COLLECTION = 'nodestartuptracker';

  function loadRepository() {
    return proxyquire('../../ZelBack/src/services/appDatabase/nodeStartupRepository', {
      config: {
        database: {
          local: {
            database: 'zelfluxlocal',
            collections: { nodeStartupTracker: STARTUP_COLLECTION },
          },
        },
      },
      '../dbHelper': dbHelperStub,
    });
  }

  beforeEach(() => {
    dbHelperStub = {
      databaseConnection: sinon.stub().returns({
        db: sinon.stub().returns({ name: 'mockdb' }),
      }),
      findOneInDatabase: sinon.stub().resolves(null),
      findOneAndUpdateInDatabase: sinon.stub().resolves(null),
    };
    repository = loadRepository();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('getStartupMarker', () => {
    it('reads the marker by its key', async () => {
      dbHelperStub.findOneInDatabase.resolves({ _id: 'lastStartup', bootId: 'boot-a' });

      const marker = await repository.getStartupMarker('lastStartup');

      const [, collection, query] = dbHelperStub.findOneInDatabase.firstCall.args;
      expect(collection).to.equal(STARTUP_COLLECTION);
      expect(query).to.deep.equal({ _id: 'lastStartup' });
      expect(marker.bootId).to.equal('boot-a');
    });

    it('returns null when the DB is not up', async () => {
      dbHelperStub.databaseConnection.returns(null);

      expect(await repository.getStartupMarker('lastStartup')).to.equal(null);
      sinon.assert.notCalled(dbHelperStub.findOneInDatabase);
    });
  });

  describe('setStartupMarker', () => {
    it('upserts the marker, keyed so it cannot touch a sibling document', async () => {
      const at = new Date('2026-07-23T00:00:00Z');

      await repository.setStartupMarker('lastStartup', { at, bootId: 'boot-b' });

      const [, collection, query, update, options] = dbHelperStub.findOneAndUpdateInDatabase.firstCall.args;
      expect(collection).to.equal(STARTUP_COLLECTION);
      expect(query).to.deep.equal({ _id: 'lastStartup' });
      expect(update).to.deep.equal({ $set: { at, bootId: 'boot-b' } });
      expect(options).to.deep.equal({ upsert: true });
    });

    it('is a no-op when the DB is not up', async () => {
      dbHelperStub.databaseConnection.returns(null);

      await repository.setStartupMarker('lastStartup', { at: new Date(), bootId: 'b' });

      sinon.assert.notCalled(dbHelperStub.findOneAndUpdateInDatabase);
    });
  });

  describe('appendBootHistory', () => {
    it('pushes the boot and keeps only the newest max entries', async () => {
      const boot = { bootId: 'boot-c', bootedAt: new Date(), at: new Date() };

      await repository.appendBootHistory('bootHistory', boot, 50);

      const [, collection, query, update, options] = dbHelperStub.findOneAndUpdateInDatabase.firstCall.args;
      expect(collection).to.equal(STARTUP_COLLECTION);
      expect(query).to.deep.equal({ _id: 'bootHistory' });
      expect(update).to.deep.equal({ $push: { boots: { $each: [boot], $slice: -50 } } });
      expect(options).to.deep.equal({ upsert: true });
    });

    it('is a no-op when the DB is not up', async () => {
      dbHelperStub.databaseConnection.returns(null);

      await repository.appendBootHistory('bootHistory', {}, 50);

      sinon.assert.notCalled(dbHelperStub.findOneAndUpdateInDatabase);
    });
  });
});
