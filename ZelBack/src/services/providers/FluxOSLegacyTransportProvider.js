'use strict';

const crypto = require('crypto');
const benchmarkService = require('../benchmarkService');
const { getSpecBackend } = require('../utils/specLibs');

const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;

/**
 * The v8 owner view channel. The viewer generates an AES-256 session key,
 * wraps it with the app's RSA public key and presents the wrapped key; this
 * provider has fluxbenchd unwrap it and seals the opened spec under that key.
 *
 * The wire form is `nonce(12) || ciphertext || tag(16)`, base64, and nothing
 * else: the viewer holds the key it sent, so the key does not travel with the
 * bytes. The on-chain blob carries a wrapped key in front because the node
 * reading it holds only the RSA half; that framing is the storage provider's.
 *
 * @param {string} appName
 * @param {string} owner
 * @param {string} wrappedKeyBase64 - the AES key, RSA-OAEP-wrapped, base64
 */
async function create(appName, owner, wrappedKeyBase64) {
  const { CryptoProvider: Base } = await getSpecBackend();

  class FluxOSLegacyTransportProvider extends Base {
    #appName;
    #owner;
    #wrappedKeyBase64;
    #aesKey;

    constructor(app, own, keyB64) {
      super();
      this.#appName = app;
      this.#owner = own;
      this.#wrappedKeyBase64 = keyB64;
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

      return {
        algorithm: 'AES-256-GCM',
        ciphertext: Buffer.concat([nonce, encrypted, tag]).toString('base64'),
      };
    }

    async decrypt(encrypted) {
      const aesKey = await this.#ensureKey();
      const blob = Buffer.from(encrypted.ciphertext, 'base64');
      if (blob.length < GCM_NONCE_BYTES + GCM_TAG_BYTES) {
        throw new Error('v8 enterprise view blob shorter than minimum layout');
      }

      const nonce = blob.subarray(0, GCM_NONCE_BYTES);
      const ciphertext = blob.subarray(GCM_NONCE_BYTES, -GCM_TAG_BYTES);
      const tag = blob.subarray(-GCM_TAG_BYTES);

      const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    }
  }

  return new FluxOSLegacyTransportProvider(appName, owner, wrappedKeyBase64);
}

module.exports = {
  create,
};
