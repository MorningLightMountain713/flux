'use strict';

const config = require('config');
const log = require('../../lib/log');
const dbHelper = require('../dbHelper');

// The record of an in-flight file operation: which container is doing it, which
// staging directory it owns, and which job the caller is polling.
//
// A file operation runs in its OWN container, so a FluxOS restart does not stop
// it - the copy carries on and publishes itself. What the restart destroys is
// the process's memory of which containers are legitimate, and boot recovery
// reaps every file-operation container it does not recognise. Without this
// record it recognises none of them, so a restart kills work that was minutes
// from finishing and tells the caller the job never existed.
//
// Node-local and never gossiped: it is about this node's own containers.
//
// FAIL-OPEN, and that is the difference from pendingTeardownStore. A teardown
// record is the SOLE record that cleanup is owed, so failing to write it must
// stop the removal. Failing to write this one costs the adoption and nothing
// else - the operation still runs, and boot recovery reaps it exactly as it
// does today. A file operation must never be refused because mongo would not
// take a row.

const localDatabase = config.get('database.local.database');
const { fileOperations } = config.get('database.local.collections');

function collection() {
  const db = dbHelper.databaseConnection();
  return db.db(localDatabase);
}

/**
 * Record an operation that is now running, keyed by its container.
 *
 * @param {object} doc - { containerId, jobId, stagingRoot, identifier, kind }
 * @returns {Promise<void>}
 */
async function recordOperation(doc) {
  try {
    await dbHelper.updateOneInDatabase(
      collection(),
      fileOperations,
      { containerId: doc.containerId },
      { $set: { ...doc, startedAt: doc.startedAt ?? Date.now() } },
      { upsert: true },
    );
  } catch (error) {
    log.error(`fileOperationStore - could not record ${doc.containerId}: ${error.message}`);
  }
}

/**
 * Drop the record for a container whose operation has settled.
 *
 * @param {string} containerId
 * @returns {Promise<void>}
 */
async function forgetOperation(containerId) {
  try {
    await dbHelper.removeDocumentsFromCollection(collection(), fileOperations, { containerId });
  } catch (error) {
    log.error(`fileOperationStore - could not forget ${containerId}: ${error.message}`);
  }
}

/**
 * Every operation this node believes is in flight.
 *
 * Read at boot, where an empty answer and an unreadable collection must lead to
 * the same place: recover nothing, and let the reaper clear what it finds. That
 * is what this node did before the record existed.
 *
 * @returns {Promise<Array<object>>}
 */
async function listOperations() {
  try {
    return await dbHelper.findInDatabase(collection(), fileOperations, {}, { projection: { _id: 0 } });
  } catch (error) {
    log.error(`fileOperationStore - could not read in-flight operations: ${error.message}`);
    return [];
  }
}

module.exports = { recordOperation, forgetOperation, listOperations };
