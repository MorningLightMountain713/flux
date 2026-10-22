'use strict';

const serviceHelper = require('../serviceHelper');
const verificationHelper = require('../verificationHelper');
const fluxCommunicationUtils = require('../fluxCommunicationUtils');
const { normalizeSocketAddress } = require('./socketAddressUtils');
const { DROP_REASON } = require('./nodeDownCertificates');
const { STOP_STATEMENT_TYPE } = require('./processIdentity');

// Reading a node's signed stop statement (utils/processIdentity): the parsed
// network message {version, timestamp, pubKey, signature, data}, with data
// {type: 'fluxprocessstop', version: 1, ip, processId, reason}. The signature
// binds the statement to the node listed at `ip`, so whoever presents it,
// the subject's own connection or another juror, only the subject made it.

const PROCESS_ID = /^[0-9a-f]{32}$/;
const STOP_REASONS = new Set([DROP_REASON.RESTART, DROP_REASON.SHUTDOWN]);

/**
 * Whether a statement is a well-formed, correctly signed stop of the node at
 * its `ip`, signed within `maxAgeMs` of `now` either way.
 *
 * @param {object} statement the parsed message
 * @param {object} expect
 * @param {number} expect.now this node's clock
 * @param {number} expect.maxAgeMs the most |now − its timestamp| may be
 * @param {string} [expect.socketAddress] the address it must name
 * @param {string} [expect.reason] the reason it must name
 * @returns {Promise<{ok: true, ip: string, processId: string, reason: string, stoppedAt: number}
 *   |{ok: false, why: string}>}
 */
async function verifyStop(statement, {
  now, maxAgeMs, socketAddress = null, reason = null,
}) {
  const data = statement?.data;
  if (
    !data
    || statement.version !== 1
    || typeof statement.pubKey !== 'string'
    || typeof statement.signature !== 'string'
    || data.type !== STOP_STATEMENT_TYPE
    || data.version !== 1
    || typeof data.ip !== 'string'
    || typeof data.processId !== 'string'
    || !PROCESS_ID.test(data.processId)
    || !STOP_REASONS.has(data.reason)
    || !Number.isFinite(statement.timestamp)
  ) {
    return { ok: false, why: 'malformed' };
  }
  const ip = normalizeSocketAddress(data.ip);
  if (socketAddress !== null && ip !== socketAddress) return { ok: false, why: 'other_node' };
  if (reason !== null && data.reason !== reason) return { ok: false, why: 'other_reason' };
  // The age rule is this one, the same either side of now: the broadcast
  // envelope's own future bound is narrower, and a juror whose clock is
  // behind another's would refuse a forward of a stop the other accepted.
  if (Math.abs(now - statement.timestamp) > maxAgeMs) return { ok: false, why: 'age' };
  const { result } = await fluxCommunicationUtils.resolveBroadcastAnnouncer(data, statement.pubKey);
  if (result !== fluxCommunicationUtils.VerifyResult.OK) return { ok: false, why: result };
  const signed = verificationHelper.verifyMessage(
    `${statement.version}${serviceHelper.ensureString(data)}${statement.timestamp}`,
    statement.pubKey,
    statement.signature,
  );
  if (signed !== true) return { ok: false, why: 'badSignature' };
  return {
    ok: true, ip, processId: data.processId, reason: data.reason, stoppedAt: statement.timestamp,
  };
}

/**
 * Two statements of one node and one process that say different things:
 * one process stops once, so the pair proves the node signed a stop that
 * did not happen. Both are checked by verifyStop before this is asked.
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function isLie(a, b) {
  if (normalizeSocketAddress(a.data.ip) !== normalizeSocketAddress(b.data.ip)) return false;
  if (a.data.processId !== b.data.processId) return false;
  const said = (statement) => `${serviceHelper.ensureString(statement.data)}|${statement.timestamp}`;
  return said(a) !== said(b);
}

module.exports = { verifyStop, isLie };
