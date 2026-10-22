'use strict';

const crypto = require('node:crypto');

const log = require('../../lib/log');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const { serialiseAndSignFluxBroadcast } = require('./fluxBroadcastHelper');
const { STOP_STATEMENT_TYPE } = require('./stopStatements');

// This process's identity, and the one statement it signs when it stops.
//
// A juror honours a coded close only for a stop the subject signed. The stop
// statement is a signed network message
//   {type: 'fluxprocessstop', version: 1, ip, processId, reason}
// whose envelope timestamp is the stop's time on this node's clock. The
// processId is minted when the process starts and lives in memory only, so a
// restart or a reinstall is a new process and nothing is stored that could
// collide with its past.
//
// ONE STATEMENT PER PROCESS. Two statements carrying one processId are proof
// that the node lied, since one process stops once; jurors certify the node
// on that proof. So the statement is signed once and every later ask answers
// the same bytes.

const processId = crypto.randomBytes(16).toString('hex');

/** @type {Promise<string|null>|null} */
let signed = null;

/**
 * The signed stop statement of this process: signed on the first call, the
 * same string on every call after, whatever reason a later call names.
 * Null when this node cannot sign or does not know its address; it then
 * stops without one, and its jurors read the stop as unannounced.
 *
 * @param {string} reason DROP_REASON.RESTART or DROP_REASON.SHUTDOWN
 * @returns {Promise<string|null>} the message to put on the wire
 */
function stopStatement(reason) {
  if (!signed) {
    signed = (async () => {
      try {
        const ip = await fluxNetworkHelper.getLocalSocketAddress();
        if (!ip) {
          log.warn('processIdentity - no local address, the stop is not signed');
          return null;
        }
        return await serialiseAndSignFluxBroadcast({
          type: STOP_STATEMENT_TYPE, version: 1, ip, processId, reason,
        });
      } catch (error) {
        log.warn(`processIdentity - the stop is not signed: ${error.message}`);
        return null;
      }
    })();
  }
  return signed;
}

module.exports = {
  processId,
  stopStatement,
};
