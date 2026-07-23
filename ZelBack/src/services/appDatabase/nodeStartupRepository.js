const config = require('config');
const dbHelper = require('../dbHelper');

// The node's own boot bookkeeping: a single startup marker plus a rolling boot
// history, both keyed by _id in nodeStartupTracker. The collection is shared —
// appSyncOrchestrator keeps its heartbeat document here too — so every accessor
// is explicitly keyed rather than collection-wide.
const nodeStartupTrackerCollection = config.database.local.collections.nodeStartupTracker;

function db() {
  const connection = dbHelper.databaseConnection();
  return connection ? connection.db(config.database.local.database) : null;
}

/**
 * The last recorded startup marker, or null when unset / the DB is not up.
 * @param {string} key - marker _id
 * @returns {Promise<object|null>}
 */
async function getStartupMarker(key) {
  const database = db();
  if (!database) return null;
  return dbHelper.findOneInDatabase(database, nodeStartupTrackerCollection, { _id: key });
}

/**
 * Record that FluxOS has seen this boot.
 * @param {string} key - marker _id
 * @param {{at: Date, bootId: string}} marker
 */
async function setStartupMarker(key, marker) {
  const database = db();
  if (!database) return;
  await dbHelper.findOneAndUpdateInDatabase(
    database,
    nodeStartupTrackerCollection,
    { _id: key },
    { $set: { at: marker.at, bootId: marker.bootId } },
    { upsert: true },
  );
}

/**
 * Append one machine boot to the rolling history, keeping the newest `max`.
 * Only genuine boots land here — a same-boot_id process restart is not a boot —
 * so the history stays a record of machine boots rather than FluxOS restarts.
 * @param {string} key - history _id
 * @param {object} boot - { bootId, bootedAt, at }
 * @param {number} max - history length to retain
 */
async function appendBootHistory(key, boot, max) {
  const database = db();
  if (!database) return;
  await dbHelper.findOneAndUpdateInDatabase(
    database,
    nodeStartupTrackerCollection,
    { _id: key },
    { $push: { boots: { $each: [boot], $slice: -max } } },
    { upsert: true },
  );
}

module.exports = {
  getStartupMarker,
  setStartupMarker,
  appendBootHistory,
};
