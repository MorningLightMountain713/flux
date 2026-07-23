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

// ── Hash-sync version marker ─────────────────────────────────────────
//
// Records the FluxOS version the hash-sync state was last built by, so an
// upgrade can reset stale entries exactly once.

const HASH_SYNC_VERSION_KEY = 'hashSyncVersion';

/**
 * @returns {Promise<object|null>} the marker, or null when unset / the DB is not up
 */
async function getHashSyncVersionMarker() {
  const database = db();
  if (!database) return null;
  return dbHelper.findOneInDatabase(database, nodeStartupTrackerCollection, { _id: HASH_SYNC_VERSION_KEY });
}

/**
 * @param {string} version - the FluxOS version hash sync was built by
 */
async function setHashSyncVersionMarker(version) {
  const database = db();
  if (!database) return;
  await dbHelper.findOneAndUpdateInDatabase(
    database,
    nodeStartupTrackerCollection,
    { _id: HASH_SYNC_VERSION_KEY },
    { $set: { version } },
    { upsert: true },
  );
}

// ── Liveness heartbeat ───────────────────────────────────────────────
//
// A single document carrying lastAlive, the machine boot id it was written
// under, and — when FluxOS stops deliberately — a shutdownReason. Together they
// let the next boot tell a clean stop from a crash and a process restart from a
// machine reboot.

const HEARTBEAT_KEY = 'heartbeat';

/**
 * @returns {Promise<object|null>} the heartbeat, or null on first boot / when the DB is not up
 */
async function getHeartbeat() {
  const database = db();
  if (!database) return null;
  return dbHelper.findOneInDatabase(database, nodeStartupTrackerCollection, { _id: HEARTBEAT_KEY });
}

/**
 * Stamp liveness. `machineBootId` is written only when the caller knows it, so
 * a heartbeat can never overwrite a known boot id with an absent one.
 * @param {{lastAlive: number, machineBootId?: string}} beat
 */
async function writeHeartbeat(beat) {
  const database = db();
  if (!database) return;
  const update = { $set: { lastAlive: beat.lastAlive } };
  if (beat.machineBootId) update.$set.machineBootId = beat.machineBootId;
  await dbHelper.findOneAndUpdateInDatabase(
    database, nodeStartupTrackerCollection, { _id: HEARTBEAT_KEY }, update, { upsert: true },
  );
}

/**
 * Record why FluxOS is stopping, so the next boot reads a clean shutdown rather
 * than inferring a crash. Bounded: this runs on the shutdown path, where a
 * blocked write would hold up the stop.
 * @param {string} reason
 * @param {number} [timeoutMs]
 */
async function setShutdownReason(reason, timeoutMs = 3000) {
  const database = db();
  if (!database) return;
  await Promise.race([
    dbHelper.findOneAndUpdateInDatabase(
      database,
      nodeStartupTrackerCollection,
      { _id: HEARTBEAT_KEY },
      { $set: { shutdownReason: reason } },
      { upsert: true },
    ),
    new Promise((_, reject) => { setTimeout(() => reject(new Error('shutdown write timeout')), timeoutMs); }),
  ]);
}

/**
 * Drop the previous stop's reason once this boot is running, so a later crash
 * cannot be misread as the last clean shutdown.
 */
async function clearShutdownReason() {
  const database = db();
  if (!database) return;
  await dbHelper.findOneAndUpdateInDatabase(
    database, nodeStartupTrackerCollection, { _id: HEARTBEAT_KEY }, { $unset: { shutdownReason: '' } },
  );
}

module.exports = {
  getStartupMarker,
  setStartupMarker,
  appendBootHistory,
  getHashSyncVersionMarker,
  setHashSyncVersionMarker,
  getHeartbeat,
  writeHeartbeat,
  setShutdownReason,
  clearShutdownReason,
};
