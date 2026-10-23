'use strict';

const crypto = require('node:crypto');

// DER SubjectPublicKeyInfo prefix for an Ed25519 public key. Prepended to the
// raw 32-byte key so node:crypto can import it as a KeyObject.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * OpenSSL's Ed25519 verification, in flux-spec's verifier shape.
 *
 * flux-spec states the network's Ed25519 rule (`verifyEd25519`) and holds each
 * chain's attestation keys (`Chain.attestationKey`). A node verifies every
 * encrypted message it relays, so it verifies through OpenSSL, about fifteen
 * times faster than flux-spec's default; tests/unit/arcaneAttestation.test.js
 * holds this function to `assertEd25519Agrees`, which is what lets it stand in
 * for the rule.
 *
 * Any malformed input verifies as false rather than throwing: an unverifiable
 * attestation is simply invalid.
 *
 * @param {Uint8Array} signature - 64 bytes
 * @param {Uint8Array} message - the exact bytes that were signed
 * @param {Uint8Array} publicKey - the raw 32-byte Ed25519 public key
 * @returns {boolean}
 */
function verifyEd25519OpenSsl(signature, message, publicKey) {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey)]), format: 'der', type: 'spki',
    });
    return crypto.verify(null, Buffer.from(message), key, Buffer.from(signature));
  } catch (error) {
    return false;
  }
}

module.exports = {
  verifyEd25519OpenSsl,
};
