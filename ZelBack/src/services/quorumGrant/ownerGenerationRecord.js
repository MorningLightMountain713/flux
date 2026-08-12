'use strict';

const verificationHelper = require('../verificationHelper');

// The owner generation record: one signed object that retires a grant key's
// current world and names the moment the next one is drawn from. It is the
// §8.3 re-found for founding (a new write-once round) and the tier-2 referee
// re-roll for dark committees (§7.1) — one record, both jobs, because both
// are the same statement: "for my app, generation N, as of block H."
//
// Signed by the APP OWNER's key — the ZelID that signs every registration
// and update — never a node key: nodes relay and verify it, no node may
// mint it. FluxOS never holds this key; the record arrives already signed
// from the owner's own tooling, exactly like an app registration does.
//
// Generations are monotonic per (app, role): replays and duplicates are
// no-ops, a lower generation can never un-seat a higher one, and the record
// is durable — a re-pinned committee months later must still find it.

const DOMAIN = 'fluxgrantgeneration';
const FIELD_SEPARATOR = '|';

/**
 * The exact string the owner signs, or null when a field would corrupt the
 * framing.
 *
 * @param {{appName: string, role: string, generation: number, height: number, at: number}} record
 * @returns {string|null}
 */
function canonical(record) {
  const parts = [record?.appName, record?.role, record?.generation, record?.height, record?.at];
  const texts = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (typeof part !== 'string' && typeof part !== 'number') return null;
    const text = String(part);
    if (text.includes(FIELD_SEPARATOR)) return null;
    texts.push(text);
  }
  return `${DOMAIN}:${texts.join(FIELD_SEPARATOR)}`;
}

/**
 * Whether the record is signed by the given owner. The owner is looked up by
 * the VERIFIER from its own copy of the app's spec — never taken from the
 * record, or anyone could name a friendly "owner".
 *
 * @param {object} record {appName, role, generation, height, at, signature}
 * @param {string} owner the app's registered owner (ZelID)
 * @returns {boolean}
 */
function verify(record, owner) {
  const payload = canonical(record);
  if (!payload || !owner || typeof record?.signature !== 'string' || !record.signature) {
    return false;
  }
  return verificationHelper.verifyMessage(payload, owner, record.signature) === true;
}

/**
 * Shape validation, shared by every intake: safe integers, sane role, a
 * generation that starts at 1 (generation 0 is the registration itself and
 * needs no record).
 */
function wellFormed(record) {
  return Boolean(
    record
    && typeof record.appName === 'string' && record.appName.length > 0
    && typeof record.role === 'string' && /^[a-z0-9-]{1,64}$/.test(record.role)
    && Number.isSafeInteger(record.generation) && record.generation >= 1
    && Number.isSafeInteger(record.height) && record.height >= 1
    && Number.isSafeInteger(record.at),
  );
}

module.exports = {
  DOMAIN,
  canonical,
  verify,
  wellFormed,
};
