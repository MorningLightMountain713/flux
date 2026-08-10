'use strict';

const crypto = require('crypto');
const benchmarkService = require('../benchmarkService');
const { getSpecBackend } = require('../utils/specLibs');

const RSA_WRAPPED_KEY_BYTES = 256;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;

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

    async encrypt(plaintext) {
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
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
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
