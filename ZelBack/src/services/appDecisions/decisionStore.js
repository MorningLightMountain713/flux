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
  appliedFor,
  decidedHashes,
  decisionsFor,
  deleteAbove,
  latestApplied,
  prepareCollection,
  undecide,
  write,
};
