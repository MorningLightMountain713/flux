const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('migrations tests', () => {
  let stubs;
  let migrations;

  beforeEach(() => {
    stubs = {
      log: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
      nodeIdentityMigration: { migrateNodeIdentity: sinon.stub().resolves({ migrated: [] }) },
      containerLabelBackfill: { backfillContainerLabels: sinon.stub().resolves({ covered: true }) },
    };
    migrations = proxyquire('../../ZelBack/src/services/migrations', {
      '../../lib/log': stubs.log,
      '../appDatabase/nodeIdentityMigration': stubs.nodeIdentityMigration,
      '../appLifecycle/containerLabelBackfill': stubs.containerLabelBackfill,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('the registry', () => {
    it('gives every migration an id, a hook and a description', () => {
      migrations.migrations.forEach((migration) => {
        expect(migration.id, 'id').to.be.a('string').and.not.empty;
        expect(migration.description, `${migration.id} description`).to.be.a('string').and.not.empty;
        expect(Object.values(migrations.HOOKS), `${migration.id} hook`).to.include(migration.hook);
        expect(migration.run, `${migration.id} run`).to.be.a('function');
      });
    });

    it('does not register the same id twice', () => {
      const ids = migrations.migrations.map((migration) => migration.id);
      expect(ids).to.deep.equal([...new Set(ids)]);
    });
  });

  describe('runMigrations', () => {
    it('runs only the migrations registered at the hook it was given', async () => {
      await migrations.runMigrations(migrations.HOOKS.DEPENDENCIES_READY);

      expect(stubs.nodeIdentityMigration.migrateNodeIdentity.calledOnce).to.be.true;
      expect(stubs.containerLabelBackfill.backfillContainerLabels.called).to.be.false;
    });

    it('runs the container work at apps-starting, where containers are still down', async () => {
      await migrations.runMigrations(migrations.HOOKS.APPS_STARTING);

      expect(stubs.containerLabelBackfill.backfillContainerLabels.calledOnce).to.be.true;
      expect(stubs.nodeIdentityMigration.migrateNodeIdentity.called).to.be.false;
    });

    it('does nothing for a hook nothing is registered at', async () => {
      const results = await migrations.runMigrations('no-such-hook');

      expect(results).to.deep.equal([]);
      expect(stubs.nodeIdentityMigration.migrateNodeIdentity.called).to.be.false;
      expect(stubs.containerLabelBackfill.backfillContainerLabels.called).to.be.false;
    });

    it('never throws when a migration does', async () => {
      // A migration that can stop a boot ships to the whole fleet at once. Not
      // running is never worse than the state the node is already in.
      stubs.nodeIdentityMigration.migrateNodeIdentity.rejects(new Error('mongo gone'));

      const results = await migrations.runMigrations(migrations.HOOKS.DEPENDENCIES_READY);

      expect(results).to.deep.equal([{ id: 'node-identity', ok: false }]);
      sinon.assert.calledWithMatch(stubs.log.error, /node-identity failed/);
    });

    it('reports a migration that succeeded', async () => {
      const results = await migrations.runMigrations(migrations.HOOKS.APPS_STARTING);

      expect(results).to.deep.equal([{ id: 'container-labels', ok: true }]);
    });

    it('runs the rest of a hook after one fails', async () => {
      // Rebuilt registry: the shipped one has a single migration per hook, and the
      // property under test is that a failure does not suppress a later entry.
      const order = [];
      const rebuilt = proxyquire('../../ZelBack/src/services/migrations', {
        '../../lib/log': stubs.log,
        '../appDatabase/nodeIdentityMigration': {
          migrateNodeIdentity: async () => { order.push('first'); throw new Error('boom'); },
        },
        '../appLifecycle/containerLabelBackfill': {
          backfillContainerLabels: async () => { order.push('second'); },
        },
      });
      rebuilt.migrations.forEach((migration) => {
        // eslint-disable-next-line no-param-reassign
        migration.hook = rebuilt.HOOKS.DEPENDENCIES_READY;
      });

      const results = await rebuilt.runMigrations(rebuilt.HOOKS.DEPENDENCIES_READY);

      expect(order).to.deep.equal(['first', 'second']);
      expect(results.map((r) => r.ok)).to.deep.equal([false, true]);
    });
  });
});
