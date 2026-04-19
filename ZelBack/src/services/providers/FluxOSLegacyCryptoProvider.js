/**
 * FluxOSLegacyCryptoProvider — concrete CryptoProvider for v8 enterprise blobs.
 *
 * v8 enterprise uses a fixed on-chain layout: 256 bytes of RSA-OAEP-wrapped
 * AES-256-GCM session key, followed by a 12-byte GCM nonce, the ciphertext,
 * and a 16-byte GCM auth tag — all concatenated and base64-encoded as the
 * `enterprise` field. This provider pulls the wrapped key out, asks
 * fluxbenchd to RSA-unwrap it via `decryptRSAMessage` (keys live behind the
 * SAS boundary), then does the AES-GCM decrypt locally.
 *
 * Symmetrical `encrypt()` goes the other way through fluxbenchd's
 * `encryptMessage` — used when re-sealing for storage after a mutation.
 *
 * This is v8-only. v9 uses a different envelope (FluxOSCryptoProvider with
 * the `seal`/`unseal` RPCs + HKDF context); the two providers don't share
 * algorithms or key derivation.
 *
 * Usage:
 *   const provider = await FluxOSLegacyCryptoProvider.create(name, owner, h);
 *   const decrypted = await encryptedSpec.decrypt(provider);
 */

const crypto = require('crypto');
const benchmarkService = require('../benchmarkService');
const { getSpecBackend } = require('../utils/specLibs');

const RSA_WRAPPED_KEY_BYTES = 256;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;

/**
 * Create a FluxOSLegacyCryptoProvider instance scoped to a single app
 * operation.
 *
 * @param {string} appName - App name (fluxbenchd RSA key selection input)
 * @param {string} owner   - fluxID / owner address
 * @returns {Promise<import('@megachips/flux-spec-backend').CryptoProvider>}
 */
async function create(appName, owner) {
  const { CryptoProvider: Base } = await getSpecBackend();

  class FluxOSLegacyCryptoProvider extends Base {
    #appName;
    #owner;

    constructor(app, own) {
      super();
      this.#appName = app;
      this.#owner = own;
    }

    /**
     * Encrypt a plaintext buffer to the v8 on-chain enterprise layout.
     * Routes through fluxbenchd's `encryptMessage`, which generates the
     * AES session key, RSA-wraps it, and emits the full concatenated blob.
     *
     * @param {Buffer} plaintext
     * @returns {Promise<{ algorithm: string, ciphertext: string }>}
     */
    async encrypt(plaintext) {
      // blockHeight is part of the fluxbenchd RPC contract but is not used
      // for v8 key selection. Pass 0 to satisfy the wire shape.
      const inputData = JSON.stringify({
        fluxID: this.#owner,
        appName: this.#appName,
        message: plaintext.toString('base64'),
        blockHeight: 0,
      });

      const result = await benchmarkService.encryptMessage(inputData);
      if (result.status !== 'success') {
        throw new Error(`encryptMessage RPC failed: ${result.status}`);
      }

      const data = typeof result.data === 'string' ? JSON.parse(result.data) : result.data;
      if (data.status !== 'ok') {
        throw new Error(`encryptMessage RPC rejected: ${data.status}`);
      }

      return {
        algorithm: 'AES-256-GCM',
        ciphertext: data.message,
      };
    }

    /**
     * Decrypt an encrypted v8 enterprise payload to a Buffer of plaintext.
     *
     * @param {{ algorithm: string, ciphertext: string }} encrypted - The
     *   on-chain enterprise blob. `ciphertext` is the full concatenated
     *   base64 string (RSA-wrapped key prefix + nonce + ciphertext + tag).
     * @returns {Promise<Buffer>} Decrypted plaintext bytes
     */
    async decrypt(encrypted) {
      const blob = Buffer.from(encrypted.ciphertext, 'base64');
      if (blob.length < RSA_WRAPPED_KEY_BYTES + GCM_NONCE_BYTES + GCM_TAG_BYTES) {
        throw new Error('v8 enterprise blob shorter than minimum layout');
      }

      const wrappedKey = blob.subarray(0, RSA_WRAPPED_KEY_BYTES);
      const nonceCtTag = blob.subarray(RSA_WRAPPED_KEY_BYTES);
      const nonce = nonceCtTag.subarray(0, GCM_NONCE_BYTES);
      const ciphertext = nonceCtTag.subarray(GCM_NONCE_BYTES, -GCM_TAG_BYTES);
      const tag = nonceCtTag.subarray(-GCM_TAG_BYTES);

      // blockHeight is part of the fluxbenchd RPC contract but is not used
      // for v8 key selection. Pass 0 to satisfy the wire shape.
      const inputData = JSON.stringify({
        fluxID: this.#owner,
        appName: this.#appName,
        message: wrappedKey.toString('base64'),
        blockHeight: 0,
      });

      const rpcResult = await benchmarkService.decryptRSAMessage(inputData);
      if (rpcResult.status !== 'success') {
        throw new Error(`decryptRSAMessage RPC failed: ${rpcResult.status}`);
      }

      const rpcData = typeof rpcResult.data === 'string' ? JSON.parse(rpcResult.data) : rpcResult.data;
      if (rpcData.status !== 'ok') {
        throw new Error(`decryptRSAMessage RPC rejected: ${rpcData.status}`);
      }

      const aesKey = Buffer.from(rpcData.message, 'base64');

      const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plaintext;
    }
  }

  return new FluxOSLegacyCryptoProvider(appName, owner);
}

module.exports = {
  create,
  RSA_WRAPPED_KEY_BYTES,
  GCM_NONCE_BYTES,
  GCM_TAG_BYTES,
};
