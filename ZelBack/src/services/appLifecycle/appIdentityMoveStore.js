'use strict';

const config = require('config');
const dbHelper = require('../dbHelper');

/**
 * The move of an installed instance onto its identity while it is in
 * progress: which identity it moves to and when it began. One record per
 * instance, written when the move starts and removed when the instance's
 * record names the identity.
 */

const database = () => dbHelper.databaseConnection().db(config.get('database.appslocal.database'));
const collection = config.get('database.appslocal.collections.appIdentityMoves');

function key(name, replica) {
  return { name, replica: replica ?? null };
}

async function prepareCollection() {
  await dbHelper.ensureIndex(database().collection(collection), { name: 1, replica: 1 }, { unique: true, name: 'move per instance' });
}

/**
 * Records that an instance's move onto an identity is in progress.
 * @param {string} name
 * @param {string|null} replica
 * @param {string} to - the identity the instance moves onto
 * @param {number} [since] - when the move began
 */
async function begin(name, replica, to, since = Date.now()) {
  await dbHelper.replaceOneInDatabase(database(), collection, key(name, replica), { ...key(name, replica), to, since }, { upsert: true });
}

/**
 * The move in progress for an instance, or null.
 * @param {string} name
 * @param {string|null} replica
 * @returns {Promise<{to: string, since: number}|null>}
 */
async function inProgress(name, replica) {
  const doc = await dbHelper.findOneInDatabase(database(), collection, key(name, replica), { projection: { _id: 0 } });
  return doc ? { to: doc.to, since: doc.since } : null;
}

/**
 * Every move in progress.
 * @returns {Promise<Array<{name: string, replica: string|null, to: string, since: number}>>}
 */
async function all() {
  const docs = await dbHelper.findInDatabase(database(), collection, {}, { projection: { _id: 0 } });
  return docs.map((doc) => ({
    name: doc.name, replica: doc.replica ?? null, to: doc.to, since: doc.since,
  }));
}

/**
 * Ends an instance's move record.
 * @param {string} name
 * @param {string|null} replica
 */
async function end(name, replica) {
  await dbHelper.removeDocumentsFromCollection(database(), collection, key(name, replica));
}

module.exports = {
  prepareCollection, begin, inProgress, all, end,
};
