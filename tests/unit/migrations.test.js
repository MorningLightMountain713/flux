'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const capabilities = require('../../ZelBack/src/services/utils/capabilities');

describe('migrations tests', () => {
  let stubs;
  let migrations;

  beforeEach(() => {
    stubs = {
      log: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
      nodeIdentityMigration: { migrateNodeIdentity: sinon.stub().resolves({ migrated: [] }) },
      containerLabelBackfill: { backfillContainerLabels: sinon.stub().resolves({ covered: true }) },
      retiredSchema: { dropRetiredSchema: sinon.stub().resolves({ collections: [], indexes: [] }) },
      temporaryPoolSweep: { stampDeadlines: sinon.stub().resolves({ stamped: 0 }) },
      paymentPositions: { backfillPaymentPositions: sinon.stub().resolves({ positioned: 0, unresolved: 0 }) },
    };
    migrations = proxyquire('../../ZelBack/src/services/migrations', {
      '../../lib/log': stubs.log,
      '../appDatabase/nodeIdentityMigration': stubs.nodeIdentityMigration,
      '../appLifecycle/containerLabelBackfill': stubs.containerLabelBackfill,
      './retiredSchema': stubs.retiredSchema,
      '../appMessaging/temporaryPoolSweep': stubs.temporaryPoolSweep,
      './paymentPositions': stubs.paymentPositions,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('the registry', () => {
    it('gives every migration an id, the capability it finishes before, and a description', () => {
      const names = capabilities.DEFINITIONS.map((d) => d.name);
      migrations.migrations.forEach((migration) => {
        expect(migration.id, 'id').to.be.a('string').and.not.empty;
        expect(migration.description, `${migration.id} description`).to.be.a('string').and.not.empty;
        expect(names, `${migration.id} before`).to.include(migration.before);
        expect(migration.run, `${migration.id} run`).to.be.a('function');
      });
    });

    it('does not register the same id twice', () => {
      const ids = migrations.migrations.map((migration) => migration.id);
      expect(ids).to.deep.equal([...new Set(ids)]);
    });
  });

  describe('runBefore', () => {
    it('runs only the migrations that finish before the capability it was given', async () => {
      await migrations.runBefore('localDbPrepared');

      expect(stubs.nodeIdentityMigration.migrateNodeIdentity.calledOnce).to.be.true;
      expect(stubs.retiredSchema.dropRetiredSchema.calledOnce).to.be.true;
      expect(stubs.temporaryPoolSweep.stampDeadlines.calledOnce).to.be.true;
      expect(stubs.containerLabelBackfill.backfillContainerLabels.called).to.be.false;
    });

    it('stamps the pool\'s deadlines after the retired expiry index is dropped', async () => {
      await migrations.runBefore('localDbPrepared');

      sinon.assert.callOrder(stubs.retiredSchema.dropRetiredSchema, stubs.temporaryPoolSweep.stampDeadlines);
    });

    it('runs the container work before the boot reconcile decides, while containers are still down', async () => {
      await migrations.runBefore('bootReconcileDecided');

      expect(stubs.containerLabelBackfill.backfillContainerLabels.calledOnce).to.be.true;
      expect(stubs.nodeIdentityMigration.migrateNodeIdentity.called).to.be.false;
    });

    it('backfills payment positions before the scan first reaches the tip', async () => {
      const results = await migrations.runBefore('explorerSynced');

      expect(results).to.deep.equal([{ id: 'payment-positions', ok: true }]);
    });

    it('does nothing for a capability no migration finishes before', async () => {
      const results = await migrations.runBefore('apiListening');

      expect(results).to.deep.equal([]);
      expect(stubs.nodeIdentityMigration.migrateNodeIdentity.called).to.be.false;
      expect(stubs.containerLabelBackfill.backfillContainerLabels.called).to.be.false;
    });

    it('never throws when a migration does', async () => {
      // A migration that can stop a boot ships to the whole fleet at once. Not
      // running is never worse than the state the node is already in.
      stubs.nodeIdentityMigration.migrateNodeIdentity.rejects(new Error('mongo gone'));

      const results = await migrations.runBefore('localDbPrepared');

      expect(results).to.deep.equal([{ id: 'node-identity', ok: false }, { id: 'retired-schema', ok: true }, { id: 'temporary-pool-deadlines', ok: true }]);
      sinon.assert.calledWithMatch(stubs.log.error, /node-identity failed/);
    });

    it('reports a migration that succeeded', async () => {
      const results = await migrations.runBefore('bootReconcileDecided');

      expect(results).to.deep.equal([{ id: 'container-labels', ok: true }]);
    });

    it('runs the rest after one fails', async () => {
      // Rebuilt registry, so the property under test is independent of which
      // migrations ship: a failure does not suppress a later entry.
      const order = [];
      const rebuilt = proxyquire('../../ZelBack/src/services/migrations', {
        '../../lib/log': stubs.log,
        '../appDatabase/nodeIdentityMigration': {
          migrateNodeIdentity: async () => { order.push('first'); throw new Error('boom'); },
        },
        '../appLifecycle/containerLabelBackfill': {
          backfillContainerLabels: async () => { order.push('fifth'); },
        },
        './retiredSchema': {
          dropRetiredSchema: async () => { order.push('second'); },
        },
        '../appMessaging/temporaryPoolSweep': {
          stampDeadlines: async () => { order.push('third'); },
        },
        './paymentPositions': {
          backfillPaymentPositions: async () => { order.push('fourth'); },
        },
      });
      rebuilt.migrations.forEach((migration) => {
        // eslint-disable-next-line no-param-reassign
        migration.before = 'localDbPrepared';
      });

      const results = await rebuilt.runBefore('localDbPrepared');

      expect(order).to.deep.equal(['first', 'second', 'third', 'fourth', 'fifth']);
      expect(results.map((r) => r.ok)).to.deep.equal([false, true, true, true, true]);
    });
  });
});
