'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const { asConfig } = require('./fixtures/config');

describe('fileOperationStore tests', () => {
  let rows; // containerId -> doc
  let fileOperationStore;
  let logStub;
  let dbThrows;

  beforeEach(() => {
    rows = new Map();
    dbThrows = false;
    logStub = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };
    const guard = () => { if (dbThrows) throw new Error('db down'); };
    const dbHelperStub = {
      databaseConnection: () => ({ db: () => ({}) }),
      findInDatabase: async () => { guard(); return [...rows.values()]; },
      updateOneInDatabase: async (_db, _coll, query, update) => {
        guard();
        rows.set(query.containerId, { ...(rows.get(query.containerId) || {}), ...update.$set });
      },
      removeDocumentsFromCollection: async (_db, _coll, query) => { guard(); rows.delete(query.containerId); },
    };
    fileOperationStore = proxyquire('../../ZelBack/src/services/appSystem/fileOperationStore', {
      config: asConfig({ database: { local: { database: 'fluxlocal', collections: { fileOperations: 'fileoperations' } } } }),
      '../../lib/log': logStub,
      '../dbHelper': dbHelperStub,
    });
  });

  afterEach(() => sinon.restore());

  it('records an operation and reads it back', async () => {
    await fileOperationStore.recordOperation({
      containerId: 'c0ffee', jobId: 'op_1', stagingRoot: '/apps/a/.flux-op-1', identifier: 'a', kind: 'Copying...',
    });

    const [doc] = await fileOperationStore.listOperations();
    expect(doc.containerId).to.equal('c0ffee');
    expect(doc.jobId, 'the job a caller is polling').to.equal('op_1');
    expect(doc.stagingRoot, 'so the sweep skips what this operation is writing into').to.equal('/apps/a/.flux-op-1');
    expect(doc.startedAt).to.be.a('number');
  });

  it('keys on the container, so re-recording one replaces it', async () => {
    await fileOperationStore.recordOperation({ containerId: 'c0ffee', kind: 'Copying...' });
    await fileOperationStore.recordOperation({ containerId: 'c0ffee', kind: 'Extracting...' });

    const all = await fileOperationStore.listOperations();
    expect(all).to.have.lengthOf(1);
    expect(all[0].kind).to.equal('Extracting...');
  });

  it('forgets a settled operation', async () => {
    await fileOperationStore.recordOperation({ containerId: 'c0ffee' });
    await fileOperationStore.forgetOperation('c0ffee');

    expect(await fileOperationStore.listOperations()).to.deep.equal([]);
  });

  // FAIL-OPEN, and this is the difference from pendingTeardownStore. A teardown
  // record is the only record that cleanup is owed, so it must fail closed.
  // Losing this one costs the adoption and nothing else - the operation still
  // runs, and boot recovery reaps it exactly as it did before the record
  // existed. A file operation must never be refused because mongo said no.
  it('does not throw when the record cannot be written', async () => {
    dbThrows = true;

    await fileOperationStore.recordOperation({ containerId: 'c0ffee' });

    sinon.assert.calledOnce(logStub.error);
  });

  it('does not throw when the record cannot be dropped', async () => {
    dbThrows = true;

    await fileOperationStore.forgetOperation('c0ffee');

    sinon.assert.calledOnce(logStub.error);
  });

  // An unreadable collection has to lead where an empty one leads: adopt
  // nothing, and let the reaper clear what it finds.
  it('answers no operations when the collection cannot be read', async () => {
    dbThrows = true;

    expect(await fileOperationStore.listOperations()).to.deep.equal([]);
    sinon.assert.calledOnce(logStub.error);
  });
});
