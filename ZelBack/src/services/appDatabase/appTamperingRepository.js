const config = require('config');
const dbHelper = require('../dbHelper');

// Incident rollups (schemaVersion >= 1): one document per
// (appName, eventType, incidentKey), carrying a severity stamped at write time.
// Pre-schema rows are row-per-observation noise with no severity or dedup; every
// read here excludes them and purgePreSchemaIncidents removes them at startup.
const tamperingEventsCollection = config.database.local.collections.appTamperingEvents;

// The tampering collections live in the `local` database, NOT `appslocal` —
// appsRepository's localDb() is a different database entirely.
function db() {
  const connection = dbHelper.databaseConnection();
  return connection ? connection.db(config.database.local.database) : null;
}

/**
 * Weighted tamper score: the sum of stored severities over current-schema
 * incidents. Each document already IS one deduplicated incident, so scoring is
 * a plain sum rather than a row count — a raw count of pre-schema rows is what
 * once pushed honest nodes over the enforcement gate.
 * @returns {Promise<number|null>} the score, or null when the DB is not up
 */
async function sumIncidentSeverities() {
  const database = db();
  if (!database) return null;
  const pipeline = [
    { $match: { schemaVersion: { $gte: 1 } } },
    { $project: { _id: 0, severity: 1 } },
  ];
  const incidents = await dbHelper.aggregateInDatabase(database, tamperingEventsCollection, pipeline);
  return incidents.reduce((score, incident) => score + (incident.severity ?? 0), 0);
}

/**
 * Record one observation of an incident, creating it on first sight and
 * incrementing its tally thereafter.
 *
 * The duplicate-key retry is a storage concern, not a caller's: two concurrent
 * upserts racing on a brand-new incident key trip the unique index, and the
 * loser simply retries once to land as the increment it always was.
 * Returns whether this observation created the incident or rolled up into an
 * existing one. Reading that from the driver's result is a storage detail —
 * mongodb v6 returns the pre-image document (or null on insert) while older
 * shapes return { value, lastErrorObject } — so it is decided here rather than
 * leaking two driver vintages into the caller. `null` is reserved for "the DB
 * is not up", which callers must not confuse with a fresh insert.
 * @param {object} query - the incident key (appName, eventType, incidentKey)
 * @param {object} update - $setOnInsert / $set / $inc document
 * @returns {Promise<{inserted: boolean}|null>} null when the DB is not up
 */
async function upsertIncident(query, update) {
  const database = db();
  if (!database) return null;
  let result;
  try {
    result = await dbHelper.findOneAndUpdateInDatabase(
      database, tamperingEventsCollection, query, update, { upsert: true },
    );
  } catch (error) {
    if (error && error.code === 11000) {
      result = await dbHelper.findOneAndUpdateInDatabase(
        database, tamperingEventsCollection, query, update, { upsert: true },
      );
    } else {
      throw error;
    }
  }
  const inserted = !result || result.value === null || result?.lastErrorObject?.updatedExisting === false;
  return { inserted };
}

/**
 * Stamp node identity onto current-schema incidents that were written before
 * fluxd's RPC was up (boot-time detection runs ahead of it).
 * @param {object} identity - { nodeTxid, nodeOutidx, nodeIp, pubkey, paymentAddress }
 * @returns {Promise<number>} how many incidents gained an identity
 */
async function backfillIncidentIdentity(identity) {
  const database = db();
  if (!database) return 0;
  const result = await dbHelper.updateInDatabase(
    database,
    tamperingEventsCollection,
    { schemaVersion: { $gte: 1 }, nodeTxid: null },
    {
      $set: {
        nodeTxid: identity.nodeTxid,
        nodeOutidx: identity.nodeOutidx,
        nodeIp: identity.nodeIp,
        pubkey: identity.pubkey,
        paymentAddress: identity.paymentAddress,
      },
    },
  );
  return result?.modifiedCount ?? 0;
}

/**
 * Incidents most recent first, for the public API. The caller supplies an
 * already-clamped limit — the route is public, so an uncapped query would dump
 * the collection to anyone.
 * Returns null when the DB is not up, never [] — the endpoint is publicly reachable
 * before mongo is (the HTTP listeners bind ahead of serviceManager), and answering
 * "success, no incidents" to an operator whose database is simply down is a lie.
 * @param {string|null} appName - filter to one app, or null for all
 * @param {number} limit
 * @returns {Promise<Array<object>|null>} null when the DB is not up
 */
async function listIncidents(appName, limit) {
  const database = db();
  if (!database) return null;
  const query = appName ? { appName } : {};
  const options = { sort: { lastSeen: -1, detectedAt: -1 }, limit };
  return dbHelper.findInDatabase(database, tamperingEventsCollection, query, options);
}

/**
 * Drop pre-incident-schema rows. Nothing consumes them, but the public API
 * would keep serving them for up to 30 days of TTL, so an upgraded node sweeps
 * them once at startup and reads honestly from its first boot.
 */
async function purgePreSchemaIncidents() {
  const database = db();
  if (!database) return;
  await dbHelper.removeDocumentsFromCollection(
    database, tamperingEventsCollection, { schemaVersion: { $exists: false } },
  );
}

module.exports = {
  sumIncidentSeverities,
  upsertIncident,
  backfillIncidentIdentity,
  listIncidents,
  purgePreSchemaIncidents,
};
