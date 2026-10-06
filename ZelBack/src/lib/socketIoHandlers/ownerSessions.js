'use strict';

const verificationHelper = require('../../services/verificationHelper');
const { Privilege } = require('../../services/utils/privileges');
const log = require('../log');

/**
 * The sessions open on the containers of each app, by the app's identity: a
 * terminal, a log stream. Each was opened for a caller who owned the app or was
 * on the Flux team at that moment, and the answer can change while it is open:
 * a sale names another owner and restarts nothing.
 *
 * @type {Map<string, Set<{zelidauth: string, close: () => void}>>}
 */
const open = new Map();

/**
 * Records a session from the moment its caller passed the owner check.
 *
 * @param {string} identity - the app's identity, off the container's label
 * @param {string} zelidauth - the caller's zelidauth header value
 * @param {() => void} close - ends the session and tells its client why
 * @returns {() => void} forgets the session; safe to call twice
 */
function track(identity, zelidauth, close) {
  const entry = { zelidauth, close };
  if (!open.has(identity)) open.set(identity, new Set());
  open.get(identity).add(entry);
  return () => {
    const sessions = open.get(identity);
    if (!sessions) return;
    sessions.delete(entry);
    if (!sessions.size) open.delete(identity);
  };
}

/**
 * An app's owner changed: every session open on its containers is put to the
 * check it passed when it opened, and one whose caller no longer passes is
 * closed. The incoming owner's and the Flux team's stay open.
 *
 * @param {string} identity - the app's identity
 * @returns {Promise<number>} how many sessions were closed
 */
async function recheck(identity) {
  let closed = 0;
  // eslint-disable-next-line no-restricted-syntax
  for (const entry of [...(open.get(identity) ?? [])]) {
    const { zelidauth } = entry;
    // eslint-disable-next-line no-await-in-loop
    const authorized = await verificationHelper.verifyPrivilege(Privilege.APP_OWNER_OR_FLUX_TEAM, zelidauth, { identity });
    if (authorized === true) continue;
    try {
      entry.close();
      closed += 1;
    } catch (error) {
      log.error(`ownerSessions: closing a session on ${identity} failed: ${error.message}`);
    }
  }
  if (closed) log.info(`ownerSessions: closed ${closed} session(s) on ${identity} whose caller no longer owns the app`);
  return closed;
}

module.exports = { track, recheck, open };
