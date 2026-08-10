'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('appTamperingRepository tests', () => {
  let repository;
  let dbHelperStub;

  const TAMPERING_COLLECTION = 'apptamperingevents';

  function loadRepository() {
    return proxyquire('../../ZelBack/src/services/appDatabase/appTamperingRepository', {
      config: {
        database: {
          local: {
            database: 'zelfluxlocal',
            collections: { appTamperingEvents: TAMPERING_COLLECTION },
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
      aggregateInDatabase: sinon.stub().resolves([]),
      findOneAndUpdateInDatabase: sinon.stub().resolves(null),
      updateInDatabase: sinon.stub().resolves({ modifiedCount: 0 }),
      findInDatabase: sinon.stub().resolves([]),
      removeDocumentsFromCollection: sinon.stub().resolves(),
    };
    repository = loadRepository();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('sumIncidentSeverities', () => {
    it('scores only current-schema incident documents', async () => {
      await repository.sumIncidentSeverities();

      const pipeline = dbHelperStub.aggregateInDatabase.firstCall.args[2];
      expect(pipeline[0]).to.deep.equal({ $match: { schemaVersion: { $gte: 1 } } });
    });

    it('sums stored severities across incidents', async () => {
      dbHelperStub.aggregateInDatabase.resolves([
        { eventType: 'container_vanished', severity: 3 },
        { eventType: 'network_pruned', severity: 1 },
        { eventType: 'network_detached', severity: 1 },
        { eventType: 'recreation_failed', severity: 0 }, // operational
      ]);

      expect(await repository.sumIncidentSeverities()).to.equal(5);
    });

    it('scores full weight regardless of stored duringBootStorm flags', async () => {
      // Stored incidents may carry a duringBootStorm flag; it is inert —
      // severities always sum in full.
      dbHelperStub.aggregateInDatabase.resolves([
        { eventType: 'mount_vanished', severity: 1, duringBootStorm: true },
        { eventType: 'container_vanished', severity: 3, duringBootStorm: true },
      ]);

      expect(await repository.sumIncidentSeverities()).to.equal(4);
    });

    it('treats a missing severity as zero', async () => {
      dbHelperStub.aggregateInDatabase.resolves([{ eventType: 'mount_vanished' }]);

      expect(await repository.sumIncidentSeverities()).to.equal(0);
    });

    it('reports null when the DB is not up, so the caller can tell it apart from a zero score', async () => {
      dbHelperStub.databaseConnection.returns(null);

      expect(await repository.sumIncidentSeverities()).to.equal(null);
    });

    it('propagates mongo errors to the caller', async () => {
      dbHelperStub.aggregateInDatabase.rejects(new Error('mongo boom'));

      try {
        await repository.sumIncidentSeverities();
        expect.fail('expected the error to propagate');
      } catch (error) {
        expect(error.message).to.equal('mongo boom');
      }
    });
  });

  describe('upsertIncident', () => {
    const QUERY = { appName: 'MyApp', eventType: 'mount_vanished', incidentKey: 'boot:1' };
    const UPDATE = { $inc: { count: 1 } };

    it('upserts against the tampering collection', async () => {
      await repository.upsertIncident(QUERY, UPDATE);

      const { args } = dbHelperStub.findOneAndUpdateInDatabase.firstCall;
      expect(args[1]).to.equal(TAMPERING_COLLECTION);
      expect(args[2]).to.deep.equal(QUERY);
      expect(args[4]).to.deep.equal({ upsert: true });
    });

    it('retries once when two concurrent upserts race the unique index', async () => {
      const duplicate = Object.assign(new Error('duplicate key'), { code: 11000 });
      dbHelperStub.findOneAndUpdateInDatabase.onFirstCall().rejects(duplicate);
      dbHelperStub.findOneAndUpdateInDatabase.onSecondCall().resolves({ _id: 'existing' });

      const result = await repository.upsertIncident(QUERY, UPDATE);

      expect(result).to.deep.equal({ inserted: false });
      sinon.assert.calledTwice(dbHelperStub.findOneAndUpdateInDatabase);
    });

    it('reports inserted for the v6 null pre-image', async () => {
      dbHelperStub.findOneAndUpdateInDatabase.resolves(null);

      expect(await repository.upsertIncident(QUERY, UPDATE)).to.deep.equal({ inserted: true });
    });

    it('reports a rollup for the v6 pre-image document', async () => {
      dbHelperStub.findOneAndUpdateInDatabase.resolves({ _id: 'e', count: 1 });

      expect(await repository.upsertIncident(QUERY, UPDATE)).to.deep.equal({ inserted: false });
    });

    it('reads insert vs rollup from the legacy { value, lastErrorObject } shape', async () => {
      dbHelperStub.findOneAndUpdateInDatabase.resolves({ value: null, lastErrorObject: { updatedExisting: false } });
      expect(await repository.upsertIncident(QUERY, UPDATE)).to.deep.equal({ inserted: true });

      dbHelperStub.findOneAndUpdateInDatabase.resolves({ value: { _id: 'e' }, lastErrorObject: { updatedExisting: true } });
      expect(await repository.upsertIncident(QUERY, UPDATE)).to.deep.equal({ inserted: false });
    });

    it('reserves null for "the DB is not up", never for a fresh insert', async () => {
      dbHelperStub.databaseConnection.returns(null);

      expect(await repository.upsertIncident(QUERY, UPDATE)).to.equal(null);
    });

    it('does not retry a non-duplicate error', async () => {
      dbHelperStub.findOneAndUpdateInDatabase.rejects(new Error('mongo boom'));

      try {
        await repository.upsertIncident(QUERY, UPDATE);
        expect.fail('expected the error to propagate');
      } catch (error) {
        expect(error.message).to.equal('mongo boom');
      }
      sinon.assert.calledOnce(dbHelperStub.findOneAndUpdateInDatabase);
    });

    it('is a no-op when the DB is not up', async () => {
      dbHelperStub.databaseConnection.returns(null);

      expect(await repository.upsertIncident(QUERY, UPDATE)).to.equal(null);
      sinon.assert.notCalled(dbHelperStub.findOneAndUpdateInDatabase);
    });
  });

  describe('backfillIncidentIdentity', () => {
    const IDENTITY = {
      nodeTxid: 'tx', nodeOutidx: 0, nodeIp: '1.2.3.4', pubkey: 'pk', paymentAddress: 'addr',
    };

    it('only stamps current-schema incidents that still lack an identity', async () => {
      await repository.backfillIncidentIdentity(IDENTITY);

      const query = dbHelperStub.updateInDatabase.firstCall.args[2];
      expect(query).to.deep.equal({ schemaVersion: { $gte: 1 }, nodeTxid: null });
    });

    it('returns how many incidents gained an identity', async () => {
      dbHelperStub.updateInDatabase.resolves({ modifiedCount: 7 });

      expect(await repository.backfillIncidentIdentity(IDENTITY)).to.equal(7);
    });

    it('returns 0 when the driver reports no modifiedCount', async () => {
      dbHelperStub.updateInDatabase.resolves({});

      expect(await repository.backfillIncidentIdentity(IDENTITY)).to.equal(0);
    });

    it('returns 0 when the DB is not up', async () => {
      dbHelperStub.databaseConnection.returns(null);

      expect(await repository.backfillIncidentIdentity(IDENTITY)).to.equal(0);
    });
  });

  describe('listIncidents', () => {
    it('filters by app name and sorts most recent first', async () => {
      await repository.listIncidents('MyApp', 25);

      const [, collection, query, options] = dbHelperStub.findInDatabase.firstCall.args;
      expect(collection).to.equal(TAMPERING_COLLECTION);
      expect(query).to.deep.equal({ appName: 'MyApp' });
      expect(options).to.deep.equal({ sort: { lastSeen: -1, detectedAt: -1 }, limit: 25 });
    });

    it('queries every app when no name is given', async () => {
      await repository.listIncidents(null, 10);

      expect(dbHelperStub.findInDatabase.firstCall.args[2]).to.deep.equal({});
    });

    it('reports null when the DB is not up, so the public endpoint cannot answer "no incidents"', async () => {
      dbHelperStub.databaseConnection.returns(null);

      expect(await repository.listIncidents(null, 10)).to.equal(null);
    });
  });

  describe('purgePreSchemaIncidents', () => {
    it('removes only rows written before the incident schema', async () => {
      await repository.purgePreSchemaIncidents();

      const [, collection, query] = dbHelperStub.removeDocumentsFromCollection.firstCall.args;
      expect(collection).to.equal(TAMPERING_COLLECTION);
      expect(query).to.deep.equal({ schemaVersion: { $exists: false } });
    });

    it('is a no-op when the DB is not up', async () => {
      dbHelperStub.databaseConnection.returns(null);

      await repository.purgePreSchemaIncidents();

      sinon.assert.notCalled(dbHelperStub.removeDocumentsFromCollection);
    });
  });
});
