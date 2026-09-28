'use strict';

const log = require('../../lib/log');
const nodeIdentityMigration = require('../appDatabase/nodeIdentityMigration');
const containerLabelBackfill = require('../appLifecycle/containerLabelBackfill');
const retiredSchema = require('./retiredSchema');
const paymentPositions = require('./paymentPositions');

// One-off work that brings a node up to date with a change FluxOS has already
// made. Each migration names the capability it must finish before: that
// capability's owner runs them, then raises it.
//
// It lives here rather than being called from wherever it happens to fit because
// that is what lets it LEAVE. A migration wired into serviceManager becomes part
// of serviceManager: retiring it means editing a file that does a hundred other
// things, so nobody does, and it runs forever. Here, retiring one is deleting its
// entry below and deleting its implementation — nothing else in the tree names it.
//
// The contract every migration keeps:
//
//   Idempotent by CONSTRUCTION, not by a marker. Ask the world whether the work is
//   still needed — is the field absent, does the container lack the label — rather
//   than recording that a previous run happened. A marker can be wrong (an
//   interrupted run, state arriving later from elsewhere); the world cannot. This
//   also means "did it run?" never has to be tracked, and a failed run simply
//   happens at the next opportunity.
//
//   Safe to fail. A migration moves a node from a state that already works to a
//   better one, so not running is never worse than the status quo — but a
//   migration that can stop a boot ships to the whole fleet at once. Failures are
//   logged and the boot continues.

const migrations = [
  {
    id: 'node-identity',
    // Node-local state, read by everything that uses the local database.
    before: 'localDbPrepared',
    description: 'adopt node runtime state that older versions kept in config/userconfig.js',
    run: () => nodeIdentityMigration.migrateNodeIdentity(),
  },
  {
    id: 'retired-schema',
    // Before the preparation asserts the current indexes, one of which shares a
    // name with a retired expiry index.
    before: 'localDbPrepared',
    description: 'drop collections and expiry indexes no version reads',
    run: () => retiredSchema.dropRetiredSchema(),
  },
  {
    id: 'payment-positions',
    // Needs the daemon's address index, so it runs once the daemon is synced and
    // before the scan first reaches the tip.
    before: 'explorerSynced',
    description: 'record the block position of app payments recorded without one',
    run: () => paymentPositions.backfillPaymentPositions(),
  },
  {
    id: 'container-labels',
    // The boot reconcile has not started any container yet, so on a host reboot
    // every container is still stopped.
    before: 'bootReconcileDecided',
    description: 'restamp containers created before the identity label carried one',
    run: () => containerLabelBackfill.backfillContainerLabels(),
  },
];

/**
 * Run every migration that must finish before a capability rises, in
 * declaration order. Called by the capability's owner just before it raises it.
 *
 * Sequential: two migrations before the same capability may touch the same
 * state, and the order they are declared in is the order they were reasoned
 * about. One failing does not stop the next - they do not depend on each other,
 * and a migration that could suppress another would make the registry an
 * ordering puzzle instead of a list.
 *
 * @param {string} capability a capability name
 * @returns {Promise<Array<{id: string, ok: boolean}>>}
 */
async function runBefore(capability) {
  const due = migrations.filter((migration) => migration.before === capability);
  if (due.length === 0) return [];

  log.info(`migrations - running ${due.length} before ${capability}`);
  const results = [];
  for (const migration of due) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await migration.run();
      results.push({ id: migration.id, ok: true });
    } catch (error) {
      log.error(`migrations - ${migration.id} failed before ${capability}: ${error.message}`);
      results.push({ id: migration.id, ok: false });
    }
  }
  return results;
}

module.exports = {
  runBefore,
  // exposed for tests
  migrations,
};
