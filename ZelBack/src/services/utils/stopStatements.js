'use strict';

const serviceHelper = require('../serviceHelper');
const verificationHelper = require('../verificationHelper');
const fluxCommunicationUtils = require('../fluxCommunicationUtils');
const { normalizeSocketAddress } = require('./socketAddressUtils');
const { DROP_REASON } = require('./nodeDownCertificates');

// Reading a node's signed stop statement (utils/processIdentity): the parsed
// network message {version, timestamp, pubKey, signature, data}, with data
// {type: 'fluxprocessstop', version: 1, ip, processId, reason}. The signature
// binds the statement to the node listed at `ip`, so whoever presents it,
// the subject's own connection or another juror, only the subject made it.
//
// A PROVEN LIE IS A CERTIFIED STOP. Two statements of one process that say
// different things are proof the node signed a stop that did not happen.
// The proof travels as a node-down certificate whose evidence is the pair
// in place of jury verdicts, {subject, reason: 'lie', since, proof: [a, b]},
// so it is stored, gossiped, synced and counted by the rungs like any other.
// Its `since` is the later statement's time: the store bounds a
// certificate's since against its broadcast, which keeps an old proof from
// being raised again later.

const STOP_STATEMENT_TYPE = 'fluxprocessstop';
const LIE_REASON = 'lie';
const PROCESS_ID = /^[0-9a-f]{32}$/;
const STOP_REASONS = new Set([DROP_REASON.RESTART, DROP_REASON.SHUTDOWN]);

/**
 * Whether a statement has the stop statement's shape.
 * @param {object} statement
 * @returns {boolean}
 */
function wellFormed(statement) {
  const data = statement?.data;
  return Boolean(data)
    && statement.version === 1
    && typeof statement.pubKey === 'string'
    && typeof statement.signature === 'string'
    && data.type === STOP_STATEMENT_TYPE
    && data.version === 1
    && typeof data.ip === 'string'
    && typeof data.processId === 'string'
    && PROCESS_ID.test(data.processId)
    && STOP_REASONS.has(data.reason)
    && Number.isFinite(statement.timestamp);
}

/**
 * Whether the statement's signature is good under its own key.
 * @param {object} statement well-formed
 * @returns {boolean}
 */
function signatureHolds(statement) {
  return verificationHelper.verifyMessage(
    `${statement.version}${serviceHelper.ensureString(statement.data)}${statement.timestamp}`,
    statement.pubKey,
    statement.signature,
  ) === true;
}

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
  if (!wellFormed(statement)) return { ok: false, why: 'malformed' };
  const { data } = statement;
  const ip = normalizeSocketAddress(data.ip);
  if (socketAddress !== null && ip !== socketAddress) return { ok: false, why: 'other_node' };
  if (reason !== null && data.reason !== reason) return { ok: false, why: 'other_reason' };
  // The age rule is this one, the same either side of now: the broadcast
  // envelope's own future bound is narrower, and a juror whose clock is
  // behind another's would refuse a forward of a stop the other accepted.
  if (Math.abs(now - statement.timestamp) > maxAgeMs) return { ok: false, why: 'age' };
  const { result } = await fluxCommunicationUtils.resolveBroadcastAnnouncer(data, statement.pubKey);
  if (result !== fluxCommunicationUtils.VerifyResult.OK) return { ok: false, why: result };
  if (!signatureHolds(statement)) return { ok: false, why: 'badSignature' };
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

/**
 * The certificate a proven lie makes.
 * @param {string} subject the liar's outpoint
 * @param {object} a one statement
 * @param {object} b another of the same process, saying something else
 * @returns {{subject: string, reason: string, since: number, proof: object[]}}
 */
function lieCertificate(subject, a, b) {
  return {
    subject, reason: LIE_REASON, since: Math.max(a.timestamp, b.timestamp), proof: [a, b],
  };
}

/**
 * Cold verification of a lie certificate, synchronous and CPU-only like the
 * jury certificate's: both statements well formed and signed by the listed
 * subject's key at its listed address, one process saying two things, and
 * `since` the later of the two.
 *
 * @param {object} certificate
 * @param {{ip: string, pubkey: string}|null} listed the subject's list entry
 * @returns {{valid: boolean, reason: string}}
 */
function verifyLieCertificate(certificate, listed) {
  const proof = certificate?.proof;
  if (!Array.isArray(proof) || proof.length !== 2 || !proof.every(wellFormed)) {
    return { valid: false, reason: 'malformed' };
  }
  if (!listed) return { valid: false, reason: 'not_listed' };
  const address = normalizeSocketAddress(listed.ip);
  if (!proof.every((statement) => statement.pubKey === listed.pubkey && normalizeSocketAddress(statement.data.ip) === address)) {
    return { valid: false, reason: 'not_the_subject' };
  }
  if (!isLie(proof[0], proof[1])) return { valid: false, reason: 'no_lie' };
  if (certificate.since !== Math.max(proof[0].timestamp, proof[1].timestamp)) {
    return { valid: false, reason: 'since' };
  }
  if (!proof.every(signatureHolds)) return { valid: false, reason: 'bad_signature' };
  return { valid: true, reason: 'accepted' };
}

module.exports = {
  STOP_STATEMENT_TYPE,
  LIE_REASON,
  verifyStop,
  isLie,
  lieCertificate,
  verifyLieCertificate,
};
