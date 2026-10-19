'use strict';

const config = require('config');
const log = require('../lib/log');
const dbHelper = require('./dbHelper');
const capabilities = require('./utils/capabilities');

/**
 * Every capability transition, this process's and earlier ones', kept in a
 * local collection bounded by row count: a capped collection, so the oldest
 * rows leave as new ones arrive and nothing has to prune it.
 *
 * Each row is a transition as the registry records it plus `startedAt`, the
 * start of the process that made it. A transition made while the local
 * database is not prepared waits in memory and is written once it is; that
 * queue holds at most as many as the registry keeps, oldest dropped first.
 */

const COLLECTION = config.get('database.local.collections.capabilityTransitions');
const MAX_ROWS = 5000;
// Above what MAX_ROWS rows take, so the row count is what bounds it.
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_QUEUED = 2000;
const BOOTS_ANSWERED = 10;

/** The start of this process, ms since the epoch: the key of its rows. */
const STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);

let queue = [];
let started = false;
let flushing = false;
let dirty = false;

function db() {
  return dbHelper.databaseConnection().db(config.get('database.local.database'));
}

/**
 * Creates the capped collection when it does not exist.
 * @returns {Promise<void>}
 */
async function prepareCollection() {
  const database = db();
  const present = await database.listCollections({ name: COLLECTION }, { nameOnly: true }).toArray();
  if (present.length > 0) return;
  await database.createCollection(COLLECTION, { capped: true, size: MAX_BYTES, max: MAX_ROWS });
}

function enqueue(record) {
  queue.push({ startedAt: STARTED_AT, ...record });
  if (queue.length > MAX_QUEUED) queue.shift();
}

/**
 * Writes what is queued while the local database is prepared. One write runs
 * at a time; a transition arriving during it is written by the next.
 * @returns {Promise<void>}
 */
async function flush() {
  if (flushing) { dirty = true; return; }
  flushing = true;
  try {
    do {
      dirty = false;
      if (!capabilities.isUp('localDbPrepared') || queue.length === 0) return;
      const batch = queue;
      queue = [];
      try {
        // eslint-disable-next-line no-await-in-loop
        await dbHelper.insertManyToDatabase(db(), COLLECTION, batch.map((row) => ({ ...row })));
      } catch (error) {
        queue = [...batch, ...queue].slice(-MAX_QUEUED);
        log.warn(`capabilityHistory: ${batch.length} transitions not written: ${error.message}`);
        return;
      }
    } while (dirty);
  } finally {
    flushing = false;
  }
}

function onTransition(record) {
  enqueue(record);
  flush().catch((error) => log.error(error));
}

/**
 * Records every transition from now on, with every one this process made
 * before, and writes them whenever the local database is prepared. A repeat
 * call does nothing.
 */
function start() {
  if (started) return;
  started = true;
  capabilities.transitions().forEach(enqueue);
  capabilities.DEFINITIONS.forEach(({ name }) => capabilities.onTransition(name, onTransition));
  flush().catch((error) => log.error(error));
}

/**
 * The transitions of this process and the processes before it, newest process
 * first, each process's oldest first; up to the last BOOTS_ANSWERED processes.
 * This process's transitions not yet written are included.
 * @returns {Promise<Array<{startedAt: number, transitions: object[]}>>}
 */
async function history() {
  const rows = await dbHelper.findInDatabase(db(), COLLECTION, {}, {
    projection: { _id: 0 },
    sort: { $natural: -1 },
  });
  // Newest first throughout: the queue holds what came after every written row.
  const boots = new Map();
  [...[...queue].reverse(), ...rows].forEach(({ startedAt, ...transition }) => {
    if (!boots.has(startedAt)) boots.set(startedAt, []);
    boots.get(startedAt).push(transition);
  });
  return [...boots]
    .sort(([a], [b]) => b - a)
    .slice(0, BOOTS_ANSWERED)
    .map(([startedAt, transitions]) => ({ startedAt, transitions: transitions.reverse() }));
}

/** Forgets what was queued and that it started. Unit tests only. */
function resetForTests() {
  queue = [];
  started = false;
  flushing = false;
  dirty = false;
}

module.exports = {
  BOOTS_ANSWERED,
  MAX_ROWS,
  STARTED_AT,
  history,
  prepareCollection,
  resetForTests,
  start,
};
