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

  describe('hash-sync version marker', () => {
    it('reads the marker under its own key', async () => {
      dbHelperStub.findOneInDatabase.resolves({ _id: 'hashSyncVersion', version: '8.12.0' });

      const marker = await repository.getHashSyncVersionMarker();

      expect(dbHelperStub.findOneInDatabase.firstCall.args[2]).to.deep.equal({ _id: 'hashSyncVersion' });
      expect(marker.version).to.equal('8.12.0');
    });

    it('upserts the version without disturbing sibling documents', async () => {
      await repository.setHashSyncVersionMarker('8.13.0');

      const [, , query, update, options] = dbHelperStub.findOneAndUpdateInDatabase.firstCall.args;
      expect(query).to.deep.equal({ _id: 'hashSyncVersion' });
      expect(update).to.deep.equal({ $set: { version: '8.13.0' } });
      expect(options).to.deep.equal({ upsert: true });
    });

    it('no-ops when the DB is not up', async () => {
      dbHelperStub.databaseConnection.returns(null);

      expect(await repository.getHashSyncVersionMarker()).to.equal(null);
      await repository.setHashSyncVersionMarker('8.13.0');

      sinon.assert.notCalled(dbHelperStub.findOneAndUpdateInDatabase);
    });
  });

  describe('heartbeat', () => {
    it('reads the heartbeat document', async () => {
      dbHelperStub.findOneInDatabase.resolves({ _id: 'heartbeat', lastAlive: 42 });

      const beat = await repository.getHeartbeat();

      expect(dbHelperStub.findOneInDatabase.firstCall.args[2]).to.deep.equal({ _id: 'heartbeat' });
      expect(beat.lastAlive).to.equal(42);
    });

    it('stamps liveness with the boot id when the caller knows it', async () => {
      await repository.writeHeartbeat({ lastAlive: 1000, machineBootId: 'boot-x' });

      const update = dbHelperStub.findOneAndUpdateInDatabase.firstCall.args[3];
      expect(update).to.deep.equal({ $set: { lastAlive: 1000, machineBootId: 'boot-x' } });
    });

    it('never overwrites a known boot id with an absent one', async () => {
      await repository.writeHeartbeat({ lastAlive: 1000 });

      const update = dbHelperStub.findOneAndUpdateInDatabase.firstCall.args[3];
      expect(update).to.deep.equal({ $set: { lastAlive: 1000 } });
    });

    it('records a shutdown reason', async () => {
      await repository.setShutdownReason('sigterm');

      const [, , query, update, options] = dbHelperStub.findOneAndUpdateInDatabase.firstCall.args;
      expect(query).to.deep.equal({ _id: 'heartbeat' });
      expect(update).to.deep.equal({ $set: { shutdownReason: 'sigterm' } });
      expect(options).to.deep.equal({ upsert: true });
    });

    it('gives up on a shutdown write that would hold up the stop', async () => {
      dbHelperStub.findOneAndUpdateInDatabase.returns(new Promise(() => {})); // never settles

      try {
        await repository.setShutdownReason('sigterm', 5);
        expect.fail('expected the bounded write to reject');
      } catch (error) {
        expect(error.message).to.equal('shutdown write timeout');
      }
    });

    it('clears the previous stop reason', async () => {
      await repository.clearShutdownReason();

      const [, , query, update] = dbHelperStub.findOneAndUpdateInDatabase.firstCall.args;
      expect(query).to.deep.equal({ _id: 'heartbeat' });
      expect(update).to.deep.equal({ $unset: { shutdownReason: '' } });
    });

    it('no-ops across every accessor when the DB is not up', async () => {
      dbHelperStub.databaseConnection.returns(null);

      expect(await repository.getHeartbeat()).to.equal(null);
      await repository.writeHeartbeat({ lastAlive: 1 });
      await repository.setShutdownReason('sigterm');
      await repository.clearShutdownReason();

      sinon.assert.notCalled(dbHelperStub.findOneAndUpdateInDatabase);
      sinon.assert.notCalled(dbHelperStub.findOneInDatabase);
    });
  });
});
