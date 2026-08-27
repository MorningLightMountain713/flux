'use strict';

const crypto = require('node:crypto');
const config = require('config');

/**
 * App-attestation public key (base64, raw 32-byte Ed25519) for the secure
 * backend's `app` purpose.
 *
 * Every genuine Arcane node derives the same keypair from the network-wide
 * salt, so there is exactly one public key for the whole network. Any node —
 * with or without a local secure backend — verifies an attestation locally with
 * it, without an RPC. That is the point: a node that cannot decrypt an
 * encrypted spec still has to decide whether to store and relay it.
 *
 * The `app` purpose has its OWN key, derived from the same salt under its own
 * HKDF info. An app attestation is therefore mathematically unable to verify
 * under the network-wide default-purpose key (which FluxDrive blob upload
 * pins), or the other way round, rather than merely unlikely to.
 *
 * Resolved from config (`arcane.appAttestationPubkey`) with the network
 * constant as the default, so production always uses the constant while a
 * controlled environment can point verification at a different keypair.
 *
 * Read out-of-band from a secure-backend build carrying the `app` purpose
 * (`GET /v2/attestationPublicKey?purpose=app`), the same way the network-wide
 * key was. Verified on cabbage 2026-08-27: distinct from both the default
 * attestation key and the mesh key, and a signature made under one does not
 * verify under another — see the pinned live signature in
 * tests/unit/arcaneAttestation.test.js.
 */
const DEFAULT_ARCANE_APP_ATTESTATION_PUBKEY = 'ERXxzVN8fg4sCjhIPp37XRu1ealmD4TA6tU7A3o6tQM=';
const ARCANE_APP_ATTESTATION_PUBKEY = (config.arcane && config.arcane.appAttestationPubkey)
  ?? DEFAULT_ARCANE_APP_ATTESTATION_PUBKEY;

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
  ARCANE_APP_ATTESTATION_PUBKEY,
  verifyAttestationSignature,
};
