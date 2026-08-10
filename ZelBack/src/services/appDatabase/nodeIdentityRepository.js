'use strict';

const config = require('config');
const dbHelper = require('../dbHelper');

// Node runtime state that FluxOS generates or discovers about itself: the PGP
// keypair it creates on first boot, and the last external address it observed.
// Both are keyed by _id in nodeIdentity, the same singleton-document shape
// geolocation and benchmark use in this database.
//
// These used to live in config/userconfig.js, which is operator input owned by the
// installer — so every rewrite of that file by its owner destroyed them.
const nodeIdentityCollection = config.database.local.collections.nodeIdentity;

const PGP_IDENTITY_KEY = 'pgpIdentity';
const LAST_KNOWN_IP_KEY = 'lastKnownIp';
const PLAYGROUND_FINGERPRINT_KEY = 'playgroundFingerprintSecret';

function db() {
  const connection = dbHelper.databaseConnection();
  return connection ? connection.db(config.database.local.database) : null;
}

/**
 * The node's PGP keypair, or null when unset / the DB is not up.
 * @returns {Promise<{privateKey: string, publicKey: string}|null>}
 */
async function getPgpIdentity() {
  const database = db();
  if (!database) return null;
  const doc = await dbHelper.findOneInDatabase(
    database,
    nodeIdentityCollection,
    { _id: PGP_IDENTITY_KEY },
  );
  if (!doc || !doc.privateKey || !doc.publicKey) return null;
  return { privateKey: doc.privateKey, publicKey: doc.publicKey };
}

/**
 * Store the node's PGP keypair.
 * @param {{privateKey: string, publicKey: string}} keypair
 * @returns {Promise<boolean>} true when persisted
 */
async function setPgpIdentity(keypair) {
  const database = db();
  if (!database) return false;
  await dbHelper.findOneAndUpdateInDatabase(
    database,
    nodeIdentityCollection,
    { _id: PGP_IDENTITY_KEY },
    { $set: { privateKey: keypair.privateKey, publicKey: keypair.publicKey, updatedAt: Date.now() } },
    { upsert: true },
  );
  return true;
}

/**
 * The last external address this node observed, or null when unset.
 *
 * Read by the IP-change detector to decide whether the address moved since the
 * previous observation — the change is what gates the DOS counter and the removal
 * of apps that require a static IP, so an absent value must read as "unknown"
 * rather than as a change.
 * @returns {Promise<string|null>}
 */
async function getLastKnownIp() {
  const database = db();
  if (!database) return null;
  const doc = await dbHelper.findOneInDatabase(
    database,
    nodeIdentityCollection,
    { _id: LAST_KNOWN_IP_KEY },
  );
  return doc && doc.ip ? doc.ip : null;
}

/**
 * Record the external address this node is now reachable on.
 * @param {string} ip
 * @returns {Promise<boolean>} true when persisted
 */
async function setLastKnownIp(ip) {
  const database = db();
  if (!database) return false;
  await dbHelper.findOneAndUpdateInDatabase(
    database,
    nodeIdentityCollection,
    { _id: LAST_KNOWN_IP_KEY },
    { $set: { ip, updatedAt: Date.now() } },
    { upsert: true },
  );
  return true;
}

/**
 * The secret this node fingerprints playground callers with, minting one on
 * first use.
 *
 * Persisted rather than held in memory because it has to outlive a restart: the
 * fingerprints already written into audit records are only comparable against
 * the secret that produced them, so a fresh secret would silently void every
 * outstanding block rather than expiring it.
 *
 * Node-local and never shared. It exists so the node can recognise a caller it
 * refused earlier without keeping their identity in readable form — a fingerprint
 * is meaningless to anyone who does not hold this.
 *
 * @param {() => string} mint - generates a new secret when none is stored
 * @returns {Promise<string|null>} the secret, or null when the DB is not up
 */
async function getOrCreatePlaygroundFingerprintSecret(mint) {
  const database = db();
  if (!database) return null;

  const doc = await dbHelper.findOneInDatabase(
    database,
    nodeIdentityCollection,
    { _id: PLAYGROUND_FINGERPRINT_KEY },
  );
  if (doc && doc.secret) return doc.secret;

  const secret = mint();
  // upsert rather than insert: two callers racing on first use must converge on
  // one secret, or they would fingerprint the same person differently.
  await dbHelper.findOneAndUpdateInDatabase(
    database,
    nodeIdentityCollection,
    { _id: PLAYGROUND_FINGERPRINT_KEY },
    { $setOnInsert: { secret, createdAt: Date.now() } },
    { upsert: true },
  );

  const stored = await dbHelper.findOneInDatabase(
    database,
    nodeIdentityCollection,
    { _id: PLAYGROUND_FINGERPRINT_KEY },
  );
  return stored ? stored.secret : secret;
}

module.exports = {
  getOrCreatePlaygroundFingerprintSecret,
  getPgpIdentity,
  setPgpIdentity,
  getLastKnownIp,
  setLastKnownIp,
  PGP_IDENTITY_KEY,
  LAST_KNOWN_IP_KEY,
  PLAYGROUND_FINGERPRINT_KEY,
};
