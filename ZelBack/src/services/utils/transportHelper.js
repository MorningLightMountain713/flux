const benchmarkService = require('../benchmarkService');
const { aeadDecrypt } = require('./aeadCrypto');
const { getSpec } = require('./specLibs');

/**
 * Split-HPKE open core: the benchmark channel performs only the asymmetric decap
 * + export of the per-submission symmetric key; the spec ciphertext is opened
 * locally with AES-256-GCM, so bulk bytes never cross the channel. Inputs are the
 * envelope's raw bytes (ciphertext is ct‖tag); returns the plaintext Buffer.
 * Throws with a `.code` (MISSING_FIELD | INTERNAL_ERROR | DECRYPT_FAILED | ...)
 * for peer discipline. Shared by openTransportEnvelope and the transport
 * CryptoProvider so the open path lives in exactly one place.
 *
 * @param {object} args - { appName, fluxID, encapsulatedKey, nonce, ciphertext, aad }
 * @returns {Promise<Buffer>} plaintext
 */
async function decapAndOpen({
  appName, fluxID, encapsulatedKey, nonce, ciphertext, aad,
}) {
  if (!nonce) {
    const err = new Error('Transport-encrypted payload missing nonce');
    err.code = 'MISSING_FIELD';
    throw err;
  }

  // Asymmetric step only: decap + export the 32-byte per-submission key.
  const resp = await benchmarkService.transportDecap({
    appName,
    fluxID,
    encapsulatedKey: Buffer.from(encapsulatedKey).toString('base64'),
  });
  if (!resp || resp.status !== 'success') {
    const err = new Error('Transport open failed (benchmark unreachable)');
    err.code = 'INTERNAL_ERROR';
    throw err;
  }

  const decap = typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
  if (!decap || decap.status !== 'ok' || !decap.key) {
    const code = (decap && decap.message) || 'INTERNAL_ERROR';
    const err = new Error(`Transport decap failed: ${code}`);
    err.code = code;
    throw err;
  }

  // Open the spec locally. The envelope ciphertext is ct‖tag and aeadCrypto
  // frames as nonce‖ct‖tag, so the nonce followed by the ciphertext is exactly
  // the frame aeadDecrypt expects — no byte re-ordering. A bad key/tag/aad throws.
  const key = Buffer.from(decap.key, 'base64');
  const frame = Buffer.concat([Buffer.from(nonce), Buffer.from(ciphertext)]);
  try {
    return aeadDecrypt(key, frame, Buffer.from(aad));
  } catch (decryptError) {
    const err = new Error('Transport open failed: AEAD authentication failed');
    err.code = 'DECRYPT_FAILED';
    throw err;
  }
}

/**
 * Open a v9 transport-encrypted submission to its cleartext spec (split-HPKE).
 *
 * A submission spec carrying `transportEncrypted` keeps cleartext `name` and
 * `owner` alongside it (the per-app transport key is derived from those). The
 * encrypted payload is the sparse submission spec — the same shape a
 * non-encrypted submission sends — so the opened result feeds the identical
 * validation path.
 *
 * Returns the input unchanged when there is no `transportEncrypted` envelope.
 *
 * @param {object} appSpec - submission spec blob (may carry transportEncrypted)
 * @param {object} meta - { contentHash, timestamp, type } from the signed envelope, for AAD
 * @returns {Promise<object>} cleartext sparse submission spec blob
 * @throws {Error} with `.code` (DECRYPT_FAILED | MISSING_FIELD | INTERNAL_ERROR | ...) for peer discipline
 */
async function openTransportEnvelope(appSpec, meta) {
  if (!appSpec || !appSpec.transportEncrypted) return appSpec;

  const { name, owner } = appSpec;
  if (!name || !owner) {
    throw new Error('Transport-encrypted submission missing cleartext name/owner');
  }

  const { TransportEnvelope, buildTransportAad } = await getSpec();
  // fromJSON validates algorithm + byte lengths; a malformed envelope throws
  // here (bad message — caller penalizes the peer).
  const envelope = TransportEnvelope.fromJSON(appSpec.transportEncrypted);
  const aad = buildTransportAad({
    contentHash: meta.contentHash,
    timestamp: meta.timestamp,
    type: meta.type,
  });

  const plaintext = await decapAndOpen({
    appName: name,
    fluxID: owner,
    encapsulatedKey: envelope.encapsulatedKey,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
    aad,
  });

  return JSON.parse(plaintext.toString('utf8'));
}

module.exports = {
  openTransportEnvelope,
  decapAndOpen,
};
