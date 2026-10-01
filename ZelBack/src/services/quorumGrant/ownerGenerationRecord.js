'use strict';

const verificationHelper = require('../verificationHelper');
const { getSpec } = require('../utils/specLibs');

// The owner generation record: one signed object that retires a grant key's
// current world and names the moment the next one is drawn from. It is the
// §8.3 re-found for founding (a new write-once round) and the tier-2 referee
// re-roll for dark committees (§7.1) — one record, both jobs, because both
// are the same statement: "for my app, this role, generation N, as of block
// H, as the owner from block F."
//
// Signed by the APP OWNER's key — the ZelID that signs every registration
// and update — never a node key: nodes relay and verify it, no node may
// mint it. FluxOS never holds this key; the record arrives already signed
// from the owner's own tooling, exactly like an app registration does.
//
// The signed text, its hash and its shape are flux-spec's
// (ownerGenerationRecord.js there): the frontend signs what the library
// says, and every node verifies the same string.

/**
 * The exact string the owner signs, or null when a field would corrupt the
 * framing.
 */
async function canonical(record) {
  const { generationRecordText } = await getSpec();
  return generationRecordText(record);
}

/** The hash a spec's grants block names the record by, or null. */
async function hash(record) {
  const { generationRecordHash } = await getSpec();
  return generationRecordHash(record);
}

/**
 * Whether the record is signed by the given owner. The owner is looked up by
 * the VERIFIER from its own copy of the app's history — never taken from the
 * record, or anyone could name a friendly "owner".
 *
 * @param {object} record {identity, role, generation, height, at, ownedFrom, signature}
 * @param {string} owner an owner of the app (ZelID)
 * @returns {Promise<boolean>}
 */
async function verify(record, owner) {
  const payload = await canonical(record);
  if (!payload || !owner || typeof record?.signature !== 'string' || !record.signature) {
    return false;
  }
  return verificationHelper.verifyMessage(payload, owner, record.signature) === true;
}

/** Shape validation, shared by every intake. */
async function wellFormed(record) {
  const { generationRecordWellFormed } = await getSpec();
  return generationRecordWellFormed(record);
}

module.exports = {
  canonical,
  hash,
  verify,
  wellFormed,
};
