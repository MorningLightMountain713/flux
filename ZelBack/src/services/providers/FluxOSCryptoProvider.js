'use strict';

const benchmarkService = require('../benchmarkService');
const { getSpecBackend } = require('../utils/specLibs');

/**
 * The AAD is what authenticates a v9 container's cleartext half — its name,
 * owner, ttl, placement and the resource summary every other node schedules on
 * without decrypting. Nothing else covers those: the owner's signature is over
 * the decrypted spec.
 *
 * This provider used to forward it only `if (aad)`, which made a caller's
 * omission indistinguishable from a spec that legitimately has none. v8 is the
 * one that legitimately has none, and v8 uses a different provider entirely.
 *
 * @param {Buffer} aad
 * @param {string} operation - named in the error, so the caller is the one blamed
 */
function assertAad(aad, operation) {
  if (!Buffer.isBuffer(aad) || aad.length === 0) {
    throw new Error(
      `FluxOSCryptoProvider.${operation}: a v9 container is sealed under an AAD; got ${
        aad === undefined ? 'nothing' : JSON.stringify(String(aad))}`,
    );
  }
}

async function create(appName, owner) {
  const { CryptoProvider: Base } = await getSpecBackend();

  class FluxOSCryptoProvider extends Base {
    #appName;
    #owner;

    constructor(app, own) {
      super();
      this.#appName = app;
      this.#owner = own;
    }

    async encrypt(plaintext, aad) {
      // A v9 container is sealed under an AAD and the benchmark channel refuses
      // a request without one. Refusing here as well is what names the caller: an
      // omission that reached the daemon comes back as MISSING_FIELD from a layer
      // that knows nothing about which call site produced it.
      assertAad(aad, 'encrypt');
      const params = {
        appName: this.#appName,
        fluxID: this.#owner,
        message: plaintext.toString('base64'),
        aad: aad.toString('base64'),
      };

      const result = await benchmarkService.seal(params);
      if (result.status !== 'success') {
        throw new Error(`seal RPC failed: ${result.status}`);
      }

      const data = typeof result.data === 'string' ? JSON.parse(result.data) : result.data;
      if (data.status !== 'ok') {
        // data.message distinguishes a real crypto reject from a benchmark
        // transport failure surfaced as status=error.
        throw new Error(`seal RPC rejected: ${data.status} (${data.message ?? 'no message'})`);
      }

      return {
        algorithm: data.algorithm,
        ciphertext: data.ciphertext,
        nonce: data.nonce,
        tag: data.tag,
      };
    }

    async decrypt(encrypted, aad) {
      assertAad(aad, 'decrypt');
      const params = {
        appName: this.#appName,
        fluxID: this.#owner,
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        tag: encrypted.tag,
        aad: aad.toString('base64'),
      };

      const result = await benchmarkService.unseal(params);
      if (result.status !== 'success') {
        throw new Error(`unseal RPC failed: ${result.status}`);
      }

      const data = typeof result.data === 'string' ? JSON.parse(result.data) : result.data;
      if (data.status !== 'ok') {
        // data.message distinguishes a real crypto reject from a benchmark
        // transport failure surfaced as status=error.
        throw new Error(`unseal RPC rejected: ${data.status} (${data.message ?? 'no message'})`);
      }

      return Buffer.from(data.message, 'base64');
    }
  }

  return new FluxOSCryptoProvider(appName, owner);
}

module.exports = {
  create,
};
