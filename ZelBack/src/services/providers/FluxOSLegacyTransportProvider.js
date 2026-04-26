/**
 * FluxOSLegacyTransportProvider — transport CryptoProvider for v8 enterprise.
 *
 * Uses the frontend's RSA-wrapped AES-256 session key to decrypt and
 * re-encrypt spec payloads. The session key is unwrapped once via SAS
 * (fluxbenchd decryptRSAMessage) and cached for the provider's lifetime.
 *
 * Contrast with FluxOSLegacyCryptoProvider (backend encryption): that
 * provider has SAS generate a new AES key on each encrypt — the frontend
 * cannot decrypt those blobs. This provider uses the frontend's own key
 * so the frontend can decrypt the response.
 *
 * The encrypted blob format is preserved: [RSA-wrapped key (256 bytes)]
 * [nonce (12)] [ciphertext] [GCM tag (16)], base64-encoded. This matches
 * the v8 enterprise field layout so the frontend parses responses the same
 * way it parses its own submissions.
 *
 * Usage (validation endpoint — session key from enterprise blob):
 *   const provider = await createFromEncryptedSpec(wireSpec);
 *   const decrypted = await wireSpec.decrypt(provider);
 *   const reencrypted = await decrypted.reencrypt(provider);
 *   const response = reencrypted.serialize();
 *
 * Usage (view endpoint — session key from enterprise-key header):
 *   const provider = await create(appName, owner, wrappedKeyBase64);
 *   const reencrypted = await decrypted.reencrypt(provider);
 */

const crypto = require('crypto');
const benchmarkService = require('../benchmarkService');
const { getSpecBackend } = require('../utils/specLibs');

const RSA_WRAPPED_KEY_BYTES = 256;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;

/**
 * Create a transport CryptoProvider scoped to a frontend session key.
 *
 * @param {string} appName - App name (fluxbenchd key selection)
 * @param {string} owner   - fluxID / owner address
 * @param {string} wrappedKeyBase64 - Base64 RSA-wrapped AES session key (256 bytes decoded)
 * @returns {Promise<import('@runonflux/flux-spec-backend').CryptoProvider>}
 */
async function create(appName, owner, wrappedKeyBase64) {
  const { CryptoProvider: Base } = await getSpecBackend();
  const wrappedKeyBytes = Buffer.from(wrappedKeyBase64, 'base64');

  class FluxOSLegacyTransportProvider extends Base {
    #appName;
    #owner;
    #wrappedKeyBase64;
    #wrappedKeyBytes;
    #aesKey;

    constructor(app, own, keyB64, keyBuf) {
      super();
      this.#appName = app;
      this.#owner = own;
      this.#wrappedKeyBase64 = keyB64;
      this.#wrappedKeyBytes = keyBuf;
    }

    async #ensureKey() {
      if (this.#aesKey) return this.#aesKey;

      const inputData = JSON.stringify({
        fluxID: this.#owner,
        appName: this.#appName,
        message: this.#wrappedKeyBase64,
        blockHeight: 0,
      });

      const rpcResult = await benchmarkService.decryptRSAMessage(inputData);
      if (rpcResult.status !== 'success') {
        throw new Error(`decryptRSAMessage RPC failed: ${rpcResult.status}`);
      }

      const rpcData = typeof rpcResult.data === 'string'
        ? JSON.parse(rpcResult.data) : rpcResult.data;
      if (rpcData.status !== 'ok') {
        throw new Error(`decryptRSAMessage RPC rejected: ${rpcData.status}`);
      }

      this.#aesKey = Buffer.from(rpcData.message, 'base64');
      return this.#aesKey;
    }

    async encrypt(plaintext) {
      const aesKey = await this.#ensureKey();
      const nonce = crypto.randomBytes(GCM_NONCE_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, nonce);
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();

      const blob = Buffer.concat([this.#wrappedKeyBytes, nonce, encrypted, tag]);
      return {
        algorithm: 'AES-256-GCM',
        ciphertext: blob.toString('base64'),
      };
    }

    async decrypt(encrypted) {
      const aesKey = await this.#ensureKey();
      const blob = Buffer.from(encrypted.ciphertext, 'base64');
      if (blob.length < RSA_WRAPPED_KEY_BYTES + GCM_NONCE_BYTES + GCM_TAG_BYTES) {
        throw new Error('v8 enterprise blob shorter than minimum layout');
      }

      const nonce = blob.subarray(RSA_WRAPPED_KEY_BYTES, RSA_WRAPPED_KEY_BYTES + GCM_NONCE_BYTES);
      const ciphertext = blob.subarray(RSA_WRAPPED_KEY_BYTES + GCM_NONCE_BYTES, -GCM_TAG_BYTES);
      const tag = blob.subarray(-GCM_TAG_BYTES);

      const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    }
  }

  return new FluxOSLegacyTransportProvider(appName, owner, wrappedKeyBase64, wrappedKeyBytes);
}

/**
 * Create a transport provider from an EncryptedSpecV8 instance.
 * Extracts the RSA-wrapped session key from the first 256 bytes of the
 * enterprise blob.
 *
 * @param {import('@runonflux/flux-spec-backend').EncryptedSpecV8} encryptedSpec
 * @returns {Promise<import('@runonflux/flux-spec-backend').CryptoProvider>}
 */
async function createFromEncryptedSpec(encryptedSpec) {
  const blob = Buffer.from(encryptedSpec.encrypted.ciphertext, 'base64');
  const wrappedKeyBase64 = blob.subarray(0, RSA_WRAPPED_KEY_BYTES).toString('base64');
  return create(encryptedSpec.name, encryptedSpec.owner, wrappedKeyBase64);
}

module.exports = {
  create,
  createFromEncryptedSpec,
};
