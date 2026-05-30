const benchmarkService = require('../benchmarkService');
const { getSpec } = require('./specLibs');

/**
 * HPKE-open a v9 transport-encrypted submission to its cleartext spec.
 *
 * A submission spec carrying `transportEncrypted` keeps cleartext `name` and
 * `owner` alongside it (the per-app transport key is derived from those). The
 * sealed payload is the sparse submission spec — the same shape a non-encrypted
 * submission sends — so the opened result feeds the identical validation path.
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

  const resp = await benchmarkService.transportOpen({
    appName: name,
    fluxID: owner,
    encapsulatedKey: Buffer.from(envelope.encapsulatedKey).toString('base64'),
    ciphertext: Buffer.from(envelope.ciphertext).toString('base64'),
    aad: Buffer.from(aad).toString('base64'),
  });

  if (resp.status !== 'success') {
    const err = new Error('Transport open failed (benchmark unreachable)');
    err.code = 'INTERNAL_ERROR';
    throw err;
  }

  const opened = typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
  if (!opened || opened.status !== 'ok') {
    const code = (opened && opened.message) || 'INTERNAL_ERROR';
    const err = new Error(`Transport open failed: ${code}`);
    err.code = code;
    throw err;
  }

  return JSON.parse(opened.message);
}

module.exports = {
  openTransportEnvelope,
};
