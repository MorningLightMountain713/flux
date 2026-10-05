'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

// Whether a removal of an app is in progress on this node: an instance of the
// name marked owed, or an owed-teardown record a release before the installed
// ledger left.
describe('owedRemovals', () => {
  let owed;
  let teardownOwedFor;
  let logStub;
  let owedRemovals;

  beforeEach(() => {
    owed = sinon.stub().resolves([]);
    teardownOwedFor = sinon.stub().resolves(false);
    logStub = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };
    owedRemovals = proxyquire('../../ZelBack/src/services/appLifecycle/owedRemovals', {
      '../../lib/log': logStub,
      '../appDatabase/appRecords': { installed: () => ({ owed }) },
      './pendingTeardownStore': { teardownOwedFor },
    });
  });

  afterEach(() => sinon.restore());

  it('is owed while an instance of the name is marked owed, without asking the legacy records', async () => {
    owed.resolves([{ name: 'app', replica: null }]);
    expect(await owedRemovals.removalOwedFor('app')).to.equal(true);
    sinon.assert.calledOnceWithExactly(owed, 'app');
    sinon.assert.notCalled(teardownOwedFor);
  });

  it('is owed while an owed-teardown record a release before the ledger left names the app', async () => {
    teardownOwedFor.resolves(true);
    expect(await owedRemovals.removalOwedFor('app')).to.equal(true);
    sinon.assert.calledOnceWithExactly(teardownOwedFor, 'app');
  });

  it('is not owed when neither names the app', async () => {
    expect(await owedRemovals.removalOwedFor('app')).to.equal(false);
  });

  it('fails CLOSED: a read of the instances that fails answers owed', async () => {
    owed.rejects(new Error('db down'));
    expect(await owedRemovals.removalOwedFor('app')).to.equal(true);
    sinon.assert.notCalled(teardownOwedFor);
    sinon.assert.calledOnce(logStub.error);
  });
});
