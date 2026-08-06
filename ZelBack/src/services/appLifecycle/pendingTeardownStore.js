const config = require('config');
const log = require('../../lib/log');
const dbHelper = require('../dbHelper');

// Durable record of an app's OWED teardown — the crash-safe handoff between the
// removal prelude (stamp condemned + delete the local row) and the deferred
// destructive teardown (container remove + host cleanup). Once
// the local row is gone this doc is the SOLE record that cleanup is owed, so it is
// written (fail-CLOSED) BEFORE any row delete and cleared only when the teardown
// has fully finished (every condemned stamp dropped). Boot recovery re-drives any
// doc that survives a crash, so a teardown interrupted by a reboot always completes.

const appsLocalDatabase = config.database.appslocal.database;
const { pendingAppTeardowns } = config.database.appslocal.collections;

function collection() {
  const db = dbHelper.databaseConnection();
  return db.db(appsLocalDatabase);
}

/**
 * Persist an owed-teardown record (upsert by key). Does NOT catch: the removal
 * prelude must fail CLOSED — never delete the local row (after which this doc is
 * the sole record of owed cleanup) if the record could not be persisted.
 *
 * @param {object} doc - { key, name, networkName, forceKill, broadcastRemoval,
 *   createdAt, attempts, components: [{ identifier, appId, componentName, label,
 *   ports, image }] }
 */
async function writeTeardown(doc) {
  const database = collection();
  await dbHelper.updateOneInDatabase(
    database,
    pendingAppTeardowns,
    { key: doc.key },
    { $set: { ...doc, updatedAt: Date.now() } },
    { upsert: true },
  );
}

/**
 * The owed-teardown record for a key, or null.
 * @param {string} key
 * @returns {Promise<object|null>}
 */
async function getTeardown(key) {
  try {
    const database = collection();
    return await dbHelper.findOneInDatabase(database, pendingAppTeardowns, { key }, { projection: { _id: 0 } });
  } catch (err) {
    log.error(`pendingTeardownStore - failed to read teardown ${key}: ${err.message}`);
    return null;
  }
}

/**
 * The owed-teardown record covering one component, found by the identifier the
 * record itself stored for it.
 *
 * The reconciler reaches a row-deleted component holding nothing but that
 * identifier, and the record's KEY is not derivable from it: a loose removal
 * keys on the app name, a replica-targeted one on `<app>_<replica>`. Asking by
 * identifier sidesteps the key shape entirely, and asks the only store that
 * still knows anything about the app — the record outlives the row precisely
 * because the row was deleted.
 *
 * @param {string} identifier - bare component identifier
 * @returns {Promise<object|null>}
 */
async function teardownForComponent(identifier) {
  if (!identifier) return null;
  try {
    const database = collection();
    return await dbHelper.findOneInDatabase(
      database, pendingAppTeardowns,
      { 'components.identifier': identifier },
      { projection: { _id: 0 } },
    );
  } catch (err) {
    log.error(`pendingTeardownStore - failed to read teardown for ${identifier}: ${err.message}`);
    return null;
  }
}

/**
 * Every owed-teardown record — boot recovery re-drives each one.
 * @returns {Promise<object[]>}
 */
async function readAllTeardowns() {
  try {
    const database = collection();
    return await dbHelper.findInDatabase(database, pendingAppTeardowns, {}, { projection: { _id: 0 } });
  } catch (err) {
    log.error(`pendingTeardownStore - failed to read teardowns: ${err.message}`);
    return [];
  }
}

/**
 * Drop an owed-teardown record once its teardown has fully completed (every
 * condemned stamp dropped). Cleared LAST: while it exists, boot recovery will
 * re-drive the teardown, so clearing it prematurely would orphan a half-torn-down
 * app.
 * @param {string} key
 */
async function clearTeardown(key) {
  try {
    const database = collection();
    await dbHelper.removeDocumentsFromCollection(database, pendingAppTeardowns, { key });
  } catch (err) {
    log.error(`pendingTeardownStore - failed to clear teardown ${key}: ${err.message}`);
  }
}

/**
 * Bump the durable attempt counter for an owed teardown that didn't converge in one
 * pass. Keyed by the teardown key; drives the reconciler's removal backoff so a
 * persistently-failing teardown paces itself instead of hot-looping, and the pacing
 * survives a crash (it lives in the same durable record). Best-effort.
 * @param {string} key
 */
async function bumpAttempts(key) {
  try {
    const database = collection();
    await dbHelper.updateOneInDatabase(database, pendingAppTeardowns, { key }, { $inc: { attempts: 1 } }, {});
  } catch (err) {
    log.error(`pendingTeardownStore - failed to bump attempts for ${key}: ${err.message}`);
  }
}

/**
 * Whether a teardown is owed for an app NAME — the install-side interlock: an
 * install must not adopt an app whose prior teardown has not finished (its volume
 * may still be mid-umount/rm-rf). Fails CLOSED: a read error returns true, deferring
 * the install rather than racing the teardown.
 * @param {string} name
 * @returns {Promise<boolean>}
 */
async function teardownOwedFor(name) {
  try {
    const database = collection();
    const doc = await dbHelper.findOneInDatabase(database, pendingAppTeardowns, { name }, { projection: { _id: 0, key: 1 } });
    return !!doc;
  } catch (err) {
    log.error(`pendingTeardownStore - teardownOwedFor(${name}) read failed, failing closed: ${err.message}`);
    return true;
  }
}

/**
 * Create the unique index on key (one doc per teardown target) + a name index for
 * teardownOwedFor. Idempotent; runs at boot before recovery reads the collection.
 */
async function prepareCollection() {
  try {
    const database = collection();
    await database.collection(pendingAppTeardowns).createIndex({ key: 1 }, { unique: true, name: 'key_unique' });
    await database.collection(pendingAppTeardowns).createIndex({ name: 1 }, { name: 'name_idx' });
  } catch (err) {
    log.error(`pendingTeardownStore - failed to prepare collection: ${err.message}`);
  }
}

module.exports = {
  writeTeardown,
  getTeardown,
  teardownForComponent,
  readAllTeardowns,
  clearTeardown,
  bumpAttempts,
  teardownOwedFor,
  prepareCollection,
};
