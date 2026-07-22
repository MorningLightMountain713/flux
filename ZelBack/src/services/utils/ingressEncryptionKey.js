const config = require('config');

/**
 * Ingress-attestation encryption public key (base64, raw 32-byte x25519).
 *
 * Ingress nodes seal the observed source address and asserted headers to this
 * key before the attestation ever leaves the node, so the sensitive fields
 * travel and rest as ciphertext that only fluxteam — holding the matching
 * private key offline — can read. Baked into the source (like the arcane
 * attestation key) so every node seals to the same key without an RPC.
 *
 * Resolved from config (`ingress.encryptionPubkey` / `ingress.encryptionKid`)
 * with the constants as defaults, so production always uses the constants while
 * a controlled environment can point sealing at a different keypair.
 *
 * Rotation is reactive — on a suspected key compromise, generate a new keypair
 * with a new `kid`, ship the new public key in a release, and the old records
 * stay readable via the retained private key their stamped `kid` names.
 */
const DEFAULT_INGRESS_ENCRYPTION_KID = 'ft-2026a';
const DEFAULT_INGRESS_ENCRYPTION_PUBKEY = 'O01u/HX30SEtJFDqPOLhoReQCKEpbKNSqOP9cQo0txk=';

const X25519_KEY_LEN = 32;

/**
 * The encryption key ingress nodes currently seal to.
 *
 * @returns {{ kid: string, publicKey: Uint8Array }}
 * @throws {Error} if the configured public key is not a 32-byte x25519 key
 */
function current() {
  const kid = (config.ingress && config.ingress.encryptionKid) ?? DEFAULT_INGRESS_ENCRYPTION_KID;
  const publicKeyB64 = (config.ingress && config.ingress.encryptionPubkey)
    ?? DEFAULT_INGRESS_ENCRYPTION_PUBKEY;

  const raw = Buffer.from(publicKeyB64, 'base64');
  if (raw.length !== X25519_KEY_LEN) {
    throw new Error(`ingress encryption public key must be ${X25519_KEY_LEN} bytes`);
  }
  return { kid, publicKey: new Uint8Array(raw) };
}

module.exports = {
  current,
  DEFAULT_INGRESS_ENCRYPTION_KID,
  DEFAULT_INGRESS_ENCRYPTION_PUBKEY,
};
