/**
 * FluxOSCryptoProvider — concrete CryptoProvider for fluxos.
 *
 * Delegates all cryptographic operations to fluxbenchd (SAS) via the
 * `seal` and `unseal` RPC endpoints. The AES key is derived inside SAS
 * via HKDF-SHA256 and never leaves the security boundary.
 *
 * Usage:
 *   const provider = await FluxOSCryptoProvider.create(appName, owner);
 *   const decrypted = await encryptedSpec.decrypt(provider);
 *
 * This module uses dynamic import() to load the ESM @megachips/flux-spec
 * package from CommonJS fluxos code.
 */

const benchmarkService = require('./benchmarkService');
const log = require('../lib/log');

// HKDF domain separator for v9 spec encryption. Passed to SAS as the
// `context` field so SAS uses it as the HKDF salt. Different HKDF
// use-cases (spec encryption vs. auth challenges vs. future features)
// each get their own context string for domain separation.
const SPEC_ENCRYPT_CONTEXT = 'FLUX_APP_ENCRYPT_v1';

// Lazy-loaded CryptoProvider base class (ESM module)
let CryptoProviderBase = null;

/**
 * Load the CryptoProvider base class from @megachips/flux-spec.
 * Cached after first load.
 */
async function getCryptoProviderBase() {
  if (!CryptoProviderBase) {
    const mod = await import('@megachips/flux-spec-backend');
    CryptoProviderBase = mod.CryptoProvider;
  }
  return CryptoProviderBase;
}

/**
 * Create a FluxOSCryptoProvider instance.
 *
 * The provider is scoped to a single app (appName + owner determine the
 * HKDF key derivation inputs). Create a new provider per app operation.
 *
 * @param {string} appName - App name (HKDF info input)
 * @param {string} owner   - fluxID / owner address (HKDF info input)
 * @returns {Promise<CryptoProvider>} A concrete CryptoProvider instance
 */
async function create(appName, owner) {
  const Base = await getCryptoProviderBase();

  // Dynamically create a class that extends the real CryptoProvider
  // so instanceof checks in EncryptedSpecV9 pass.
  class FluxOSCryptoProvider extends Base {
    #appName;
    #owner;

    constructor(app, own) {
      super();
      this.#appName = app;
      this.#owner = own;
    }

    /**
     * Encrypt plaintext via SAS seal endpoint.
     *
     * @param {Buffer} plaintext
     * @param {Buffer} [aad] - Additional Authenticated Data
     * @returns {Promise<{ algorithm: string, ciphertext: string, nonce: string, tag: string }>}
     */
    async encrypt(plaintext, aad) {
      const params = {
        appName: this.#appName,
        owner: this.#owner,
        context: SPEC_ENCRYPT_CONTEXT,
        plaintext: plaintext.toString('base64'),
      };
      if (aad) {
        params.aad = aad.toString('base64');
      }

      const result = await benchmarkService.seal(params);
      if (result.status !== 'success') {
        throw new Error(`seal RPC failed: ${result.status}`);
      }

      const data = typeof result.data === 'string' ? JSON.parse(result.data) : result.data;
      if (data.status !== 'ok') {
        throw new Error(`seal RPC rejected: ${data.status}`);
      }

      return {
        algorithm: data.algorithm,
        ciphertext: data.ciphertext,
        nonce: data.nonce,
        tag: data.tag,
      };
    }

    /**
     * Decrypt ciphertext via SAS unseal endpoint.
     *
     * @param {Object} encrypted - { algorithm, ciphertext, nonce, tag }
     * @param {Buffer} [aad] - Additional Authenticated Data (must match seal)
     * @returns {Promise<Buffer>} Decrypted plaintext
     */
    async decrypt(encrypted, aad) {
      const params = {
        appName: this.#appName,
        owner: this.#owner,
        context: SPEC_ENCRYPT_CONTEXT,
        algorithm: encrypted.algorithm,
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        tag: encrypted.tag,
      };
      if (aad) {
        params.aad = aad.toString('base64');
      }

      const result = await benchmarkService.unseal(params);
      if (result.status !== 'success') {
        throw new Error(`unseal RPC failed: ${result.status}`);
      }

      const data = typeof result.data === 'string' ? JSON.parse(result.data) : result.data;
      if (data.status !== 'ok') {
        throw new Error(`unseal RPC rejected: ${data.status}`);
      }

      return Buffer.from(data.plaintext, 'base64');
    }
  }

  return new FluxOSCryptoProvider(appName, owner);
}

module.exports = {
  create,
  // Exported for testing — allows injecting a mock base class
  _getCryptoProviderBase: getCryptoProviderBase,
};
