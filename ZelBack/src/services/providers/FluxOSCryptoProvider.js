const benchmarkService = require('../benchmarkService');
const { getSpecBackend } = require('../utils/specLibs');

const SPEC_ENCRYPT_CONTEXT = 'FLUX_APP_ENCRYPT_v1';

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
  SPEC_ENCRYPT_CONTEXT,
};
