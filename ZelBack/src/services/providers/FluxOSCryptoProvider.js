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

/**
 * A provider sealing under one of the benchmark channel's two app keys. The key
 * is named by the fields it is derived from, and the channel refuses a request
 * naming both:
 *  - `{ appName, fluxID }`: the app-secret key, for an encrypted spec, which is
 *    sealed for the owner it names;
 *  - `{ identity }`: the content key, for a manifest's sealed slots, which stay
 *    the app's across an ownership transfer.
 *
 * @param {object} keyFields
 * @returns {Promise<import('@runonflux/flux-spec-backend').CryptoProvider>}
 */
async function build(keyFields) {
  const { CryptoProvider: Base } = await getSpecBackend();

  class FluxOSCryptoProvider extends Base {
    #keyFields;

    constructor(fields) {
      super();
      this.#keyFields = fields;
    }

    async encrypt(plaintext, aad) {
      // A v9 container is sealed under an AAD and the benchmark channel refuses
      // a request without one. Refusing here as well is what names the caller: an
      // omission that reached the daemon comes back as MISSING_FIELD from a layer
      // that knows nothing about which call site produced it.
      assertAad(aad, 'encrypt');
      const params = {
        ...this.#keyFields,
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
        ...this.#keyFields,
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

  return new FluxOSCryptoProvider(keyFields);
}

/** The provider for an app's encrypted spec, sealed for the owner it names. */
async function create(appName, owner) {
  return build({ appName, fluxID: owner });
}

/** The provider for an app's content, keyed by its identity alone. */
async function forIdentity(identity) {
  if (typeof identity !== 'string' || !identity) {
    throw new Error('FluxOSCryptoProvider.forIdentity: content is sealed under the app identity, which is missing');
  }
  return build({ identity });
}

module.exports = {
  create,
  forIdentity,
};
