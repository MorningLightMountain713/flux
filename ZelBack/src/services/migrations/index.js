'use strict';

const log = require('../../lib/log');
const nodeIdentityMigration = require('../appDatabase/nodeIdentityMigration');
const containerLabelBackfill = require('../appLifecycle/containerLabelBackfill');

// One-off work that brings a node up to date with a change FluxOS has already
// made, run at a named point in the boot sequence.
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

const HOOKS = Object.freeze({
  // Mongo and Docker are up; nothing else has started. Node-local state only.
  DEPENDENCIES_READY: 'dependencies-ready',
  // Daemon, database and node confirmation are all ready, and the reconciler has
  // not opened its boot gate — so on a host reboot every container is still
  // stopped. Anything that would rather act on a container while it is down
  // belongs here.
  APPS_STARTING: 'apps-starting',
});

const migrations = [
  {
    id: 'node-identity',
    hook: HOOKS.DEPENDENCIES_READY,
    description: 'adopt node runtime state that older versions kept in config/userconfig.js',
    run: () => nodeIdentityMigration.migrateNodeIdentity(),
  },
  {
    id: 'container-labels',
    hook: HOOKS.APPS_STARTING,
    description: 'restamp containers created before the identity label carried one',
    run: () => containerLabelBackfill.backfillContainerLabels(),
  },
];

/**
 * Run every migration registered at one hook, in declaration order.
 *
 * Sequential: two migrations at the same hook may touch the same state, and the
 * order they are declared in is the order they were reasoned about. One failing
 * does not stop the next — they do not depend on each other, and a migration that
 * could suppress another would make the registry an ordering puzzle instead of a
 * list.
 *
 * @param {string} hook one of HOOKS
 * @returns {Promise<Array<{id: string, ok: boolean}>>}
 */
async function runMigrations(hook) {
  const due = migrations.filter((migration) => migration.hook === hook);
  if (due.length === 0) return [];

  log.info(`migrations - running ${due.length} at ${hook}`);
  const results = [];
  for (const migration of due) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await migration.run();
      results.push({ id: migration.id, ok: true });
    } catch (error) {
      log.error(`migrations - ${migration.id} failed at ${hook}: ${error.message}`);
      results.push({ id: migration.id, ok: false });
    }
  }
  return results;
}

module.exports = {
  HOOKS,
  runMigrations,
  // exposed for tests
  migrations,
};
