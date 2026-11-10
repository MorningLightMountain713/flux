'use strict';

const crypto = require('node:crypto');

// The availability check's source test. This node hands the observer it asks a
// nonce; the observer's call to this node's /flux/version carries it, and the
// source address that call arrived from is recorded. A call from an address other
// than the observer's listed IP says something rewrites the sources of this
// node's inbound connections: FluxOS must see its peers' public addresses.
//
// An observer whose own egress leaves from another address reads the same, so one
// mismatch is not a verdict: the availability check counts it as a failed ask and
// asks another observer.

const NONCE_PATTERN = /^[0-9a-f]{32}$/;

// Asks in flight at once are one per check and its retries; anything beyond this
// is an ask whose answer never came back, and the oldest goes.
const MAX_PENDING = 32;

/** @type {Map<string, {observerIp: string, seenFrom: ?string}>} */
const pending = new Map();

function sourceIp(address) {
  return String(address || '').replace(/^::ffff:/i, '');
}

/**
 * A nonce for an ask of the observer at `observerIp`.
 * @param {string} observerIp
 * @returns {string}
 */
function open(observerIp) {
  const nonce = crypto.randomBytes(16).toString('hex');
  pending.set(nonce, { observerIp, seenFrom: null });
  while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
  return nonce;
}

/**
 * Records where a call carrying `nonce` came from; the first call counts.
 * @param {string} nonce
 * @param {string} sourceAddress - the connection's remote address
 */
function record(nonce, sourceAddress) {
  const entry = pending.get(nonce);
  if (entry && entry.seenFrom === null) entry.seenFrom = sourceIp(sourceAddress);
}

/**
 * Ends the ask: 'match' when the observer's call came from its listed IP,
 * 'mismatch' when from another address, 'unseen' when no call carried the nonce
 * (an observer on a release that does not send it).
 * @param {string} nonce
 * @returns {{verdict: 'match'|'mismatch'|'unseen', seenFrom: ?string}}
 */
function close(nonce) {
  const entry = pending.get(nonce);
  pending.delete(nonce);
  if (!entry || entry.seenFrom === null) return { verdict: 'unseen', seenFrom: null };
  return { verdict: entry.seenFrom === entry.observerIp ? 'match' : 'mismatch', seenFrom: entry.seenFrom };
}

/**
 * Whether `value` is a nonce this test hands out.
 * @param {*} value
 * @returns {boolean}
 */
function isNonce(value) {
  return typeof value === 'string' && NONCE_PATTERN.test(value);
}

module.exports = {
  open, record, close, isNonce,
};
