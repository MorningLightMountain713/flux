const { getSpec } = require('./specLibs');
const transportCryptoProvider = require('../providers/FluxOSTransportProvider');

/**
 * Open a v9 transport-encrypted submission to its cleartext spec (split-HPKE),
 * routing through the node transport provider's open() so submission and view
 * directions share one provider seam.
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

  const provider = await transportCryptoProvider.create(name, owner);
  const plaintext = await provider.open({ envelope, aad });

  return JSON.parse(plaintext.toString('utf8'));
}

module.exports = {
  openTransportEnvelope,
};
