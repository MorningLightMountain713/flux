const crypto = require('node:crypto');

// Local AES-256-GCM for content blobs and transport specs. The symmetric key is
// obtained from the benchmark channel (contentKey / transportDecap); the bulk
// encryption happens here so plaintext bytes never leave the node. Framed output
// is nonce || ciphertext || tag — the WebCrypto/hpke-js convention (tag
// appended), so a frontend-produced transport envelope (nonce + ciphertext‖tag)
// reconstructs this frame with a plain concat, no byte re-ordering on either end.
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * AES-256-GCM seal. Returns nonce || ciphertext || tag.
 * @param {Buffer} key 32-byte key
 * @param {Buffer} plaintext
 * @param {Buffer} [aad] additional authenticated data (bound, not encrypted)
 * @returns {Buffer}
 */
function aeadEncrypt(key, plaintext, aad) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error('aeadEncrypt: key must be a 32-byte Buffer');
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  if (aad != null) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, tag]);
}

/**
 * AES-256-GCM open of a nonce || ciphertext || tag frame. Throws on auth failure
 * (wrong key, tampered nonce/ciphertext, or tampered aad) — never returns garbage.
 * @param {Buffer} key 32-byte key
 * @param {Buffer} framed nonce || ciphertext || tag
 * @param {Buffer} [aad]
 * @returns {Buffer} plaintext
 */
function aeadDecrypt(key, framed, aad) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error('aeadDecrypt: key must be a 32-byte Buffer');
  if (!Buffer.isBuffer(framed) || framed.length < NONCE_BYTES + TAG_BYTES) throw new Error('aeadDecrypt: framed input too short');
  const nonce = framed.subarray(0, NONCE_BYTES);
  const ciphertext = framed.subarray(NONCE_BYTES, framed.length - TAG_BYTES);
  const tag = framed.subarray(framed.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  if (aad != null) decipher.setAAD(aad);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

module.exports = {
  aeadEncrypt,
  aeadDecrypt,
  NONCE_BYTES,
  TAG_BYTES,
  KEY_BYTES,
};
