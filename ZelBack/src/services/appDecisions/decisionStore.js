'use strict';

const config = require('config');

const dbHelper = require('../dbHelper');
const { compareChainOrder } = require('../utils/chainOrder');

/**
 * The stored decisions: one row per decided app message, applied or refused
 * with its reason, made under a rule version. A cache of the decision rule over
 * the stored messages and this node's chain facts, so it can always be derived
 * again: a message with a payment record and no decision under the current
 * rule version is undecided.
 */

const decisionsCollection = config.get('database.appsglobal.collections.appDecisions');

function database() {
  return dbHelper.databaseConnection().db(config.get('database.appsglobal.database'));
}

function collection() {
  return database().collection(decisionsCollection);
}

/** Asserts the collection's indexes; a no-op when they exist. */
async function prepareCollection() {
  await dbHelper.ensureIndexes(collection(), [
    { key: { hash: 1 }, name: 'decision by hash', unique: true },
    { key: { name: 1 }, name: 'decisions by name' },
    { key: { height: 1 }, name: 'decisions by height' },
    { key: { identity: 1 }, name: 'decisions by app identity' },
  ]);
}

/**
 * The decisions for some hashes.
 * @param {string[]} hashes
 * @returns {Promise<Map<string, object>>} by hash
 */
async function decisionsFor(hashes) {
  if (hashes.length === 0) return new Map();
  const rows = await collection().find({ hash: { $in: hashes } }, { projection: { _id: 0 } }).toArray();
  return new Map(rows.map((row) => [row.hash, row]));
}

/**
 * Every hash decided under a rule version.
 * @param {number} ruleVersion
 * @returns {Promise<Set<string>>}
 */
async function decidedHashes(ruleVersion) {
  const rows = await collection().find({ ruleVersion }, { projection: { _id: 0, hash: 1 } }).toArray();
  return new Set(rows.map((row) => row.hash));
}

/**
 * Each name's latest applied decision in chain order: the message its registry
 * row stands on.
 * @param {string[]} [names] - lower-cased; every name when omitted
 * @returns {Promise<Map<string, object>>} by name
 */
async function latestApplied(names) {
  const query = { decision: 'applied' };
  if (names) query.name = { $in: names };
  const rows = await collection().find(query, { projection: { _id: 0 } }).toArray();
  const latest = new Map();
  for (const row of rows) {
    const held = latest.get(row.name);
    if (!held || compareChainOrder(held, row) < 0) latest.set(row.name, row);
  }
  return latest;
}

/**
 * Every applied decision for a name.
 * @param {string} name - lower-cased
 * @returns {Promise<object[]>}
 */
async function appliedFor(name) {
  return collection().find({ name, decision: 'applied' }, { projection: { _id: 0 } }).toArray();
}

/**
 * The app with an identity: the name it was applied under and the uuid of its
 * latest applied message. A v1-v8 app's identity is its name, which every
 * registration of the name shares, so the latest registration's app answers.
 * Only an applied decision carries an identity.
 * @param {string} identity
 * @returns {Promise<?{name: string, uuid: string}>} the lower-cased name; null
 *   with no applied message
 */
async function appOf(identity) {
  const rows = await collection().find(
    { identity },
    {
      projection: {
        _id: 0, name: 1, uuid: 1, height: 1, txIndex: 1, vout: 1,
      },
    },
  ).toArray();
  if (rows.length === 0) return null;
  const latest = rows.reduce((held, row) => (compareChainOrder(held, row) < 0 ? row : held));
  return { name: latest.name, uuid: latest.uuid };
}

/**
 * The applied messages of a name that belong to another app than `uuid`.
 * @param {string} name - lower-cased
 * @param {string} uuid
 * @returns {Promise<string[]>} hashes
 */
async function otherAppsHashes(name, uuid) {
  const rows = await collection().find(
    { name, decision: 'applied', uuid: { $ne: uuid } },
    { projection: { _id: 0, hash: 1 } },
  ).toArray();
  return rows.map((row) => row.hash);
}

/**
 * The applied messages of earlier apps of each name: every applied message
 * whose app is not the app of the name's latest applied message. A name
 * registered again after expiry is another app.
 * @param {string[]} [names] - lower-cased; every name when omitted
 * @returns {Promise<string[]>} hashes
 */
async function earlierAppsHashes(names) {
  const match = { decision: 'applied' };
  if (names) match.name = { $in: names };
  const reused = await collection().aggregate([
    { $match: match },
    { $group: { _id: '$name', uuids: { $addToSet: '$uuid' } } },
    { $match: { 'uuids.1': { $exists: true } } },
  ]).toArray();
  if (reused.length === 0) return [];
  const rows = await collection().find(
    { decision: 'applied', name: { $in: reused.map((group) => group._id) } },
    {
      projection: {
        _id: 0, name: 1, hash: 1, uuid: 1, height: 1, txIndex: 1, vout: 1,
      },
    },
  ).toArray();
  const byName = new Map();
  for (const row of rows) {
    if (!byName.has(row.name)) byName.set(row.name, []);
    byName.get(row.name).push(row);
  }
  const hashes = [];
  for (const applied of byName.values()) {
    const { uuid } = applied.reduce((held, row) => (compareChainOrder(held, row) < 0 ? row : held));
    for (const row of applied) if (row.uuid !== uuid) hashes.push(row.hash);
  }
  return hashes;
}

/**
 * Removes decisions, leaving their messages undecided.
 * @param {string[]} hashes
 */
async function undecide(hashes) {
  if (hashes.length === 0) return;
  await collection().deleteMany({ hash: { $in: hashes } });
}

/**
 * Writes decisions, each replacing any earlier decision of its message.
 * @param {object[]} decisions
 */
async function write(decisions) {
  if (decisions.length === 0) return;
  await collection().bulkWrite(decisions.map((decision) => ({
    replaceOne: { filter: { hash: decision.hash }, replacement: decision, upsert: true },
  })), { ordered: true });
}

/**
 * Removes every decision of a message mined above a height: those messages are
 * undecided until the scan records their payments again.
 * @param {number} height
 */
async function deleteAbove(height) {
  await dbHelper.removeDocumentsFromCollection(database(), decisionsCollection, { height: { $gt: height } });
}

module.exports = {
  appOf,
  appliedFor,
  decidedHashes,
  decisionsFor,
  deleteAbove,
  earlierAppsHashes,
  latestApplied,
  otherAppsHashes,
  prepareCollection,
  undecide,
  write,
};
