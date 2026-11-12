'use strict';

const config = require('config');

// The components this node waits to take over: the primary it remembers cannot
// be shown gone yet. Kept apart from the election so the modules that answer
// "what does this node hold" read it without depending on the election.
// In-memory, and each wait lapses unless the election renews it.

// How long an election record is worth reading: ten election cycles, so one missed
// pass does not turn every verdict into "cannot say".
const ELECTION_RECORD_STALE_MS = config.get('fluxapps.masterSlaveIntervalMs') * 10;

const waits = new Map();

/**
 * Records, or renews, this node's wait to take a component over.
 * @param {string} identifier The component's election identifier.
 * @param {number} [now]
 */
function wait(identifier, now = Date.now()) {
  waits.set(identifier, now);
}

/**
 * Ends a wait.
 * @param {string} identifier
 */
function clear(identifier) {
  waits.delete(identifier);
}

/**
 * The components this node waits to take over, each renewed within
 * ELECTION_RECORD_STALE_MS.
 * @param {number} [now]
 * @returns {string[]}
 */
function waitingIdentifiers(now = Date.now()) {
  return [...waits].filter(([, at]) => now - at < ELECTION_RECORD_STALE_MS).map(([identifier]) => identifier);
}

function resetForTests() {
  waits.clear();
}

module.exports = {
  ELECTION_RECORD_STALE_MS,
  wait,
  clear,
  waitingIdentifiers,
  resetForTests,
};
