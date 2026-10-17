'use strict';

const config = require('config');
const log = require('../../lib/log');
const dbHelper = require('../dbHelper');

// The owed-teardown records a release before instance resources wrote: the
// removal prelude of that release wrote one before it deleted the local row,
// and boot recovery and the reconciler re-drive each until its teardown
// finishes and clears it. Nothing writes one; the collection is dropped once
// it is empty.

const appsLocalDatabase = config.get('database.appslocal.database');
const { pendingAppTeardowns } = config.get('database.appslocal.collections');

function collection() {
  const db = dbHelper.databaseConnection();
  return db.db(appsLocalDatabase);
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
 * Whether one of these records names an app. Fails CLOSED: a read error returns
 * true, deferring an install rather than racing the teardown.
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

module.exports = {
  getTeardown,
  teardownForComponent,
  readAllTeardowns,
  clearTeardown,
  bumpAttempts,
  teardownOwedFor,
};
