'use strict';

const verificationHelper = require('../verificationHelper');

// The signing discipline for every quorum-grant rpc, in one place.
//
// Every message is signed with the NODE OPERATOR key — the key the node list
// registers as `pubkey` — on the existing secp256k1 path. One scheme, one
// verify path, no new crypto: the same decision the node-down certificates
// design reached (§6.3), inherited whole. The vote belongs to the owner, so an
// owner-key signature proves exactly what the quorum arithmetic asks.
//
// Payloads are canonical and domain-separated: a fixed field order under a
// per-type prefix, so a signature over a prepare can never be replayed as an
// accept, and a signature over one field split can never be re-read as
// another. No field may contain the separator — checked, not assumed, because
// a payload is composed by whoever sends it, and a value carrying the
// separator would shift the meaning of every field after it.

const DOMAIN_PREFIX = 'fluxquorumgrant';
const FIELD_SEPARATOR = '|';

/**
 * The rpc types with a signature over them. Renewals are signed so they can be
 * carried by ANY holder — the messenger is irrelevant precisely because the
 * envelope is end-to-end (§7's relay rule); the re-found record is owner-signed
 * at the consumer layer and is not one of these.
 *
 * `roster` is the holder's single-seat committee-change proposal, and
 * `rosteraccept` is a grantor's signed acceptance of one — the one place a
 * GRANTOR signs anything. A quorum of rosteraccept signatures over identical
 * fields is what makes a roster entry a self-verifying object any third party
 * can check against the membership the fingerprint names.
 */
const TYPES = Object.freeze([
  'prepare',
  'accept',
  'renew',
  'release',
  'probe',
  'roster',
  'rosteraccept',
]);

/**
 * The exact string a sender signs, or null when any field would corrupt the
 * encoding. Numbers are welcome; objects are the caller holding it wrong.
 *
 * @param {string} type one of TYPES
 * @param {Array<string|number>} fields fixed-order rpc fields
 * @returns {string|null}
 */
function canonical(type, fields) {
  if (!TYPES.includes(type)) return null;
  if (!Array.isArray(fields) || fields.length === 0) return null;
  const parts = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (typeof field !== 'string' && typeof field !== 'number') return null;
    const text = String(field);
    if (text.includes(FIELD_SEPARATOR)) return null;
    parts.push(text);
  }
  return `${DOMAIN_PREFIX}-${type}:${parts.join(FIELD_SEPARATOR)}`;
}

/**
 * Sign one rpc.
 *
 * @param {string} type one of TYPES
 * @param {Array<string|number>} fields fixed-order rpc fields
 * @param {string} wifPrivateKey the node operator key, WIF form
 * @returns {{payload: string, signature: string}|null} null when the payload
 *   cannot be canonically encoded or signing fails
 */
function sign(type, fields, wifPrivateKey) {
  const payload = canonical(type, fields);
  if (!payload) return null;
  const signature = verificationHelper.signMessage(payload, wifPrivateKey);
  if (!signature || typeof signature !== 'string') return null;
  return { payload, signature };
}

/**
 * Whether a signature stands for these exact fields under this exact type.
 *
 * The verifier reconstructs the payload from the fields IT parsed rather than
 * trusting a payload string off the wire — a signature over "whatever the
 * sender said the fields were" verifies the sender's framing, not the
 * request being served.
 *
 * @param {string} type one of TYPES
 * @param {Array<string|number>} fields fixed-order rpc fields as the VERIFIER read them
 * @param {string} signature base64 signature
 * @param {string} pubkey the sender's registered node key (from the verifier's
 *   own list view, never from the request)
 * @returns {boolean}
 */
function verify(type, fields, signature, pubkey) {
  const payload = canonical(type, fields);
  if (!payload || !signature || !pubkey) return false;
  const outcome = verificationHelper.verifyMessage(payload, pubkey, signature);
  return outcome === true;
}

/**
 * The one field-order contract for every rpc type. Signer and verifier both
 * derive the ordered fields from a parsed ask THROUGH THIS FUNCTION — the
 * order lives here or the signature stops meaning what the verifier checks.
 *
 * `candidate` is the asker's collateral outpoint (`txhash:outidx`) in every
 * type: the proposer in prepare/probe, the grantee in accept/renew/release.
 * `fingerprint` is the membership fingerprint the ask's committee was
 * computed against — every type carries it, because every type is answered
 * by a committee and a committee without an agreed basis is not one set.
 *
 * @param {string} type one of TYPES
 * @param {object} ask parsed ask fields
 * @returns {Array<string|number>|null}
 */
function fieldsFor(type, ask) {
  switch (type) {
    case 'probe':
    case 'prepare':
      return [ask.key, ask.mode, ask.epoch, ask.candidate, ask.fingerprint, ask.at];
    case 'accept':
      return [ask.key, ask.mode, ask.epoch, ask.candidate, ask.ttlMs ?? 0, ask.fingerprint, ask.at];
    case 'renew':
      return [ask.key, ask.epoch, ask.candidate, ask.ttlMs, ask.fingerprint, ask.at];
    case 'release':
      return [ask.key, ask.epoch, ask.candidate, ask.fingerprint, ask.at];
    case 'roster':
      // the proposal: candidate is the proposing grantee; seq pins where in
      // the chain this entry lands. The carried chain rides OUTSIDE these
      // fields — it is self-verifying on its own signatures, and binding it
      // here would stop one signature serving every member.
      return [ask.key, ask.epoch, ask.candidate, ask.remove, ask.add, ask.seq, ask.fingerprint, ask.at];
    case 'rosteraccept':
      // the acceptance a grantor signs: no epoch and no timestamp, because
      // the entry outlives the term that proposed it (the roster belongs to
      // the COMMITTEE, not the grant) and replaying an identical entry is a
      // no-op by construction.
      return [ask.key, ask.fingerprint, ask.seq, ask.remove, ask.add];
    default:
      return null;
  }
}

module.exports = {
  DOMAIN_PREFIX,
  FIELD_SEPARATOR,
  TYPES,
  canonical,
  fieldsFor,
  sign,
  verify,
};
