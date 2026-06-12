const benchmarkService = require('../benchmarkService');
const { getSpecBackend } = require('../utils/specLibs');

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
        fluxID: this.#owner,
        message: plaintext.toString('base64'),
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
      const params = {
        appName: this.#appName,
        fluxID: this.#owner,
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
