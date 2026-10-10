'use strict';

const net = require('net');
const config = require('config');
const dbHelper = require('../../ZelBack/src/services/dbHelper');

const mongoHost = config.database.url || '127.0.0.1';
const mongoPort = config.database.port || 27_017;

let mongoAvailable = null; // null = not checked yet

/**
 * Fast TCP check — resolves in <200ms if MongoDB isn't listening.
 * @returns {Promise<boolean>}
 */
function isMongoReachable() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(200);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(mongoPort, mongoHost);
  });
}

/** The test file whose suite opened the connection now open, or null. */
let openedBy = null;

/**
 * The connection a unit test reads, opened for the suite that asks and closed
 * when that suite ends. Call it from a `before` hook, with a regular `function`
 * (not an arrow) so `this.skip()` works:
 *
 *   before(requireMongo);
 *   // or inside an existing before:
 *   before(async function setup() {
 *     await requireMongo.call(this);
 *     // ... other setup
 *   });
 *
 * The close is added to the suite when the connection opens, so it runs after
 * the suite's own `after` hooks, which may still write. A connection left open
 * past its file keeps the driver's timers running under every later test, and
 * a test that fakes the clock then runs them; tests/init.js fails the next
 * file's first test when one is.
 */
async function requireMongo() {
  if (mongoAvailable === null) {
    mongoAvailable = await isMongoReachable();
  }
  if (!mongoAvailable) {
    this.skip();
    return;
  }
  if (dbHelper.databaseConnection()) return;
  await dbHelper.initiateDB();
  const suite = this.test.parent;
  openedBy = suite.file;
  suite.afterAll('closes the database connection this suite opened', async () => {
    await dbHelper.closeDbConnection();
    openedBy = null;
  });
}

/** @returns {string|null} the test file whose suite opened the open connection */
function connectionOpenedBy() {
  return openedBy;
}

module.exports = { requireMongo, isMongoReachable, connectionOpenedBy };
