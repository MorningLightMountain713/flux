'use strict';

const log = require('../../lib/log');
const appRecords = require('../appDatabase/appRecords');
const pendingTeardownStore = require('./pendingTeardownStore');

/**
 * Whether a removal of an app is in progress on this node: an instance of the
 * name marked owed, or an owed-teardown record a release before the installed
 * ledger left. Fails CLOSED: a read that fails answers true, so an install
 * defers rather than races a teardown.
 * @param {string} name
 * @returns {Promise<boolean>}
 */
async function removalOwedFor(name) {
  try {
    if ((await appRecords.installed().owed(name)).length > 0) return true;
  } catch (error) {
    log.error(`owedRemovals - removalOwedFor(${name}) read failed, failing closed: ${error.message}`);
    return true;
  }
  return pendingTeardownStore.teardownOwedFor(name);
}

module.exports = { removalOwedFor };
