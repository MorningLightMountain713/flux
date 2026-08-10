'use strict';

const config = require('config');
const dbHelper = require('../dbHelper');

// Last-known-good copies of the network policy documents policyStore fetches.
//
// These are a cache, not a source: the authority is the remote copy and the fallback
// floor is the tracked file in helpers/. They are persisted here rather than written
// back to helpers/ because those files are tracked in git and a node updates FluxOS by
// pulling — a dirty tracked file makes the pull conflict and the node stops updating.
//
// One singleton document per policy name, keyed by _id, the same shape geolocation,
// benchmark and nodeIdentity use in this database.
const policyDocumentsCollection = config.database.local.collections.policyDocuments;

function db() {
  const connection = dbHelper.databaseConnection();
  return connection ? connection.db(config.database.local.database) : null;
}

/**
 * The last-known-good copy of a policy document, or null when there is none / the DB
 * is not up. `payload` is returned as stored; validation is the caller's job, because
 * a document written by a newer FluxOS may not satisfy this version's validator.
 * @param {string} name Registry key, e.g. 'blockedRepositories'.
 * @returns {Promise<{payload: any, fetchedAt: number, etag: string|null}|null>}
 */
async function getPolicyDocument(name) {
  const database = db();
  if (!database) return null;
  const doc = await dbHelper.findOneInDatabase(
    database,
    policyDocumentsCollection,
    { _id: name },
  );
  if (!doc || doc.payload === undefined || doc.payload === null) return null;
  return { payload: doc.payload, fetchedAt: doc.fetchedAt ?? null, etag: doc.etag ?? null };
}

/**
 * Record a policy document that was fetched and validated.
 * @param {string} name Registry key.
 * @param {any} payload The validated document.
 * @param {string|null} [etag] Response ETag, stored for future conditional requests.
 * @returns {Promise<boolean>} true when persisted.
 */
async function setPolicyDocument(name, payload, etag = null) {
  const database = db();
  if (!database) return false;
  await dbHelper.findOneAndUpdateInDatabase(
    database,
    policyDocumentsCollection,
    { _id: name },
    { $set: { payload, etag, fetchedAt: Date.now() } },
    { upsert: true },
  );
  return true;
}

module.exports = {
  getPolicyDocument,
  setPolicyDocument,
};
