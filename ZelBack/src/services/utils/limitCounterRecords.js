const config = require('config');
const dbHelper = require('../dbHelper');
const limitCounterStore = require('./limitCounterStore');
const log = require('../../lib/log');

// The durable half of a limit.
//
// The tally a counter holds is exact but fragile: it lives in memory, so a
// restart forgets it, and the node holding it can leave the network entirely - at
// which point the key moves to another node that has never heard of the caller.
// Either would hand everyone a fresh allowance, making "wait for a restart" the
// way to reset your quota.
//
// So every start is also broadcast. Any node can hold the record; only the one
// that is currently the counter reads it back. That is the division: the tally
// answers "right now" in the moment, and the record is what makes the answer
// survive the tally moving or being lost.
//
// The record carries the same HASH the counter is keyed on, never the caller. It
// travels to every node on the network, so putting an identity in it would
// broadcast who is using what, fleet-wide, forever.
//
// Gossip is too slow to bound a burst - that is what the counter is for - and
// this is not trying to. It only has to arrive before the next restart.

const { database } = config.database.appsglobal;
const collection = config.database.appsglobal.collections.limitCounterRecords;

function db() {
  const connection = dbHelper.databaseConnection();
  return connection ? connection.db(database) : null;
}

/**
 * Indexes. The TTL is on `endsAt`, which the record carries itself, so a record
 * describes its own lifetime and expires correctly even if nothing further ever
 * arrives about it. Nothing depends on a second message being delivered.
 */
async function prepareCollection() {
  const dbi = db();
  if (!dbi) return;
  const coll = dbi.collection(collection);
  // One row per (key, session): a re-broadcast of the same start updates rather
  // than counting twice.
  await coll.createIndex({ purpose: 1, key: 1, sessionId: 1 }, { unique: true, name: 'limit counter record identity' });
  await coll.createIndex({ purpose: 1, key: 1, startedAt: 1 }, { name: 'limit counter records by key and time' });
  await coll.createIndex({ endsAt: 1 }, { expireAfterSeconds: 0, name: 'limit counter records self-reap' });
}

/**
 * Store one record. Idempotent by its identity index — the same start arriving
 * twice, from two peers or from a re-broadcast, is one row.
 */
async function store(record) {
  const dbi = db();
  if (!dbi) return false;
  const { purpose, key, sessionId } = record;
  if (!purpose || !key || !sessionId) return false;
  try {
    await dbi.collection(collection).updateOne(
      { purpose, key, sessionId },
      { $set: { ...record, endsAt: new Date(record.endsAt) } },
      { upsert: true },
    );
    return true;
  } catch (error) {
    log.warn(`limitCounterRecords - could not store a record: ${error.message}`);
    return false;
  }
}

/**
 * How much of a caller's window the records account for.
 *
 * Counts starts within the window rather than live sessions: a session that ran
 * and ended still spent its share, and the window is what it spent.
 */
async function windowUsage(purpose, key, windowMs, nowMs = Date.now()) {
  const dbi = db();
  if (!dbi) return 0;
  const windowStart = Math.floor(nowMs / windowMs) * windowMs;
  try {
    return await dbi.collection(collection).countDocuments({
      purpose, key, startedAt: { $gte: windowStart },
    });
  } catch (error) {
    log.warn(`limitCounterRecords - could not read the window for a key: ${error.message}`);
    return 0;
  }
}

/**
 * Bring the in-memory tally up to what the records already know.
 *
 * Called before a key is answered for, so a counter that just restarted - or has
 * just taken the key over from a node that left - does not start the caller's day
 * again. Raises only: the records can show that MORE has been used than this node
 * saw, never less.
 */
async function reconcile(purpose, key) {
  const { windowMs } = limitCounterStore.limitsFor(purpose);
  const used = await windowUsage(purpose, key, windowMs);
  if (used > 0) limitCounterStore.adoptWindowUsage(purpose, key, used);
  return used;
}

module.exports = {
  prepareCollection,
  store,
  windowUsage,
  reconcile,
};
