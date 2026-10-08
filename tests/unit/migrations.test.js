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
      appIdentityMove: { moveInstalledAppsOntoIdentity: sinon.stub().resolves({ moved: [], skipped: [], failed: [] }) },
      installedLedger: { adoptInstalledLedgers: sinon.stub().resolves({ adopted: [], skipped: [] }) },
      retiredSchema: { dropRetiredSchema: sinon.stub().resolves({ collections: [], indexes: [] }) },
      appMessagesMigration: { migrateAppMessages: sinon.stub().resolves({ payments: 0, permanent: 0, pooled: 0 }) },
      appsRepository: { removeContentManifestsWithoutHash: sinon.stub().resolves(0) },
      paymentPositions: { backfillPaymentPositions: sinon.stub().resolves({ positioned: 0, unresolved: 0 }) },
    };
    migrations = proxyquire('../../ZelBack/src/services/migrations', {
      '../../lib/log': stubs.log,
      '../appDatabase/nodeIdentityMigration': stubs.nodeIdentityMigration,
      '../appLifecycle/containerLabelBackfill': stubs.containerLabelBackfill,
      '../appLifecycle/appIdentityMove': stubs.appIdentityMove,
      '../appLifecycle/installedLedger': stubs.installedLedger,
      './retiredSchema': stubs.retiredSchema,
      './appMessages': stubs.appMessagesMigration,
      '../appDatabase/appsRepository': stubs.appsRepository,
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
      expect(stubs.appMessagesMigration.migrateAppMessages.calledOnce).to.be.true;
      expect(stubs.containerLabelBackfill.backfillContainerLabels.called).to.be.false;
    });

    it('moves the app messages after the retired schema is dropped', async () => {
      await migrations.runBefore('localDbPrepared');

      sinon.assert.callOrder(stubs.retiredSchema.dropRetiredSchema, stubs.appMessagesMigration.migrateAppMessages);
    });

    it('runs the container work before the boot reconcile decides, while containers are still down', async () => {
      await migrations.runBefore('bootReconcileDecided');

      expect(stubs.containerLabelBackfill.backfillContainerLabels.calledOnce).to.be.true;
      expect(stubs.nodeIdentityMigration.migrateNodeIdentity.called).to.be.false;
    });

    it('adopts the installed ledger, then moves apps onto their identity, then restamps the containers', async () => {
      const results = await migrations.runBefore('bootReconcileDecided');

      expect(results.map((r) => r.id)).to.deep.equal(['installed-ledger', 'app-identity', 'container-labels']);
      sinon.assert.callOrder(
        stubs.installedLedger.adoptInstalledLedgers,
        stubs.appIdentityMove.moveInstalledAppsOntoIdentity,
        stubs.containerLabelBackfill.backfillContainerLabels,
      );
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

      expect(results).to.deep.equal([
        { id: 'node-identity', ok: false }, { id: 'retired-schema', ok: true }, { id: 'app-messages', ok: true }, { id: 'content-manifest-rows', ok: true },
      ]);
      sinon.assert.calledWithMatch(stubs.log.error, /node-identity failed/);
    });

    it('reports a migration that succeeded', async () => {
      const results = await migrations.runBefore('bootReconcileDecided');

      expect(results).to.deep.equal([{ id: 'installed-ledger', ok: true }, { id: 'app-identity', ok: true }, { id: 'container-labels', ok: true }]);
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
        '../appLifecycle/installedLedger': {
          adoptInstalledLedgers: async () => { order.push('sixth'); },
        },
        '../appLifecycle/appIdentityMove': {
          moveInstalledAppsOntoIdentity: async () => { order.push('seventh'); },
        },
        '../appLifecycle/containerLabelBackfill': {
          backfillContainerLabels: async () => { order.push('eighth'); },
        },
        './retiredSchema': {
          dropRetiredSchema: async () => { order.push('second'); },
        },
        './appMessages': {
          migrateAppMessages: async () => { order.push('third'); },
        },
        '../appDatabase/appsRepository': {
          removeContentManifestsWithoutHash: async () => { order.push('fourth'); },
        },
        './paymentPositions': {
          backfillPaymentPositions: async () => { order.push('fifth'); },
        },
      });
      rebuilt.migrations.forEach((migration) => {
        // eslint-disable-next-line no-param-reassign
        migration.before = 'localDbPrepared';
      });

      const results = await rebuilt.runBefore('localDbPrepared');

      expect(order).to.deep.equal(['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth']);
      expect(results.map((r) => r.ok)).to.deep.equal([false, true, true, true, true, true, true, true]);
    });
  });
});
