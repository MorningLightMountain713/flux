'use strict';

const crypto = require('node:crypto');
const config = require('config');

/**
 * Network arcane-attestation public key (base64, raw 32-byte Ed25519).
 *
 * Every genuine Arcane node derives the same attestation keypair from the
 * network-wide salt, so there is exactly one public key for the whole network.
 * Any node — with or without a local secure backend — can verify an attestation
 * locally with it, without an RPC.
 *
 * Resolved from config (`arcane.attestationPubkey`) with the network constant as
 * the default, so production always uses the constant while a controlled
 * environment can point verification at a different attestation keypair.
 *
 * Rotation: bump the attestation domain version (FLUX_ARCANE_ATTEST_v1 -> v2)
 * and ship the new public key in a release; retain old keys to verify history.
 */
const DEFAULT_ARCANE_ATTESTATION_PUBKEY = 'fYkJ9M6NBKnQxnr8HD3FrYakKr8JM8BRo/wF4MA9/Ss=';
const ARCANE_ATTESTATION_PUBKEY = (config.arcane && config.arcane.attestationPubkey)
  ?? DEFAULT_ARCANE_ATTESTATION_PUBKEY;

// DER SubjectPublicKeyInfo prefix for an Ed25519 public key. Prepended to the
// raw 32-byte key so node:crypto can import it as a KeyObject.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function publicKeyFromBase64(publicKeyB64) {
  const raw = Buffer.from(publicKeyB64, 'base64');
  if (raw.length !== 32) {
    throw new Error('Ed25519 public key must be 32 bytes');
  }
  const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/**
 * Verify an Ed25519 attestation signature over a message.
 *
 * Shaped as (message, publicKey, signature) so it can be passed directly as the
 * verifyFn to SignedAppEvent/ConfirmedAppEvent.verifyArcaneAttestation, which
 * builds the domain-separated message and supplies the public key. Any malformed
 * input (bad key length, bad base64) verifies as false rather than throwing — an
 * unverifiable attestation is simply invalid.
 *
 * @param {string} message - the exact bytes that were signed
 * @param {string} publicKeyB64 - base64 raw 32-byte Ed25519 public key
 * @param {string} signatureB64 - base64 Ed25519 signature
 * @returns {boolean}
 */
function verifyAttestationSignature(message, publicKeyB64, signatureB64) {
  try {
    const key = publicKeyFromBase64(publicKeyB64);
    return crypto.verify(null, Buffer.from(message), key, Buffer.from(signatureB64, 'base64'));
  } catch (error) {
    return false;
  }
}

module.exports = {
  ARCANE_ATTESTATION_PUBKEY,
  verifyAttestationSignature,
};
