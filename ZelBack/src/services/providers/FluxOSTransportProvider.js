/**
 * FluxOSTransportProvider — transport CryptoProvider for v9.
 *
 * decrypt: calls SAS /v2/transportOpen via fluxbenchd to unseal an
 *   HPKE envelope (submission direction, frontend → backend).
 *
 * encrypt: HPKE-seals toward the frontend's ephemeral X25519 public key
 *   using @hpke/core (view direction, backend → frontend). No SAS call
 *   needed — the sender's ephemeral keypair is generated and discarded
 *   in scope.
 *
 * The two directions use different HPKE info strings:
 *   - Submission (decrypt): "FLUX_APP_TRANSPORT_v1" (hardcoded in SAS)
 *   - View (encrypt):       "FLUX_APP_SPEC_VIEW_v1"
 *
 * Usage (validation endpoint):
 *   const provider = await create(appName, owner, frontendPubkeyBase64);
 *   const decrypted = await encryptedSpec.decrypt(provider);
 *   const reencrypted = await decrypted.reencrypt(provider);
 *   const response = reencrypted.serialize();
 */

const benchmarkService = require('../benchmarkService');
const { getSpecBackend } = require('../utils/specLibs');

const VIEW_INFO = 'FLUX_APP_SPEC_VIEW_v1';
const ALGORITHM = 'HPKE-X25519-HKDF-SHA256-AES-256-GCM';

let hpkeCache;

async function getHpke() {
  if (hpkeCache) return hpkeCache;
  const {
    CipherSuite, DhkemX25519HkdfSha256, HkdfSha256, Aes256Gcm,
  } = await import('@hpke/core');
  const suite = new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm(),
  });
  hpkeCache = { suite, DhkemX25519HkdfSha256 };
  return hpkeCache;
}

/**
 * Create a v9 transport CryptoProvider.
 *
 * @param {string} appName - App name (SAS key derivation input)
 * @param {string} owner   - fluxID / owner address
 * @param {string} recipientPubkeyBase64 - Frontend's ephemeral X25519 pubkey (for encrypt/view direction)
 * @returns {Promise<import('@runonflux/flux-spec-backend').CryptoProvider>}
 */
async function create(appName, owner, recipientPubkeyBase64) {
  const { CryptoProvider: Base } = await getSpecBackend();

  class FluxOSTransportProvider extends Base {
    #appName;
    #owner;
    #recipientPubkeyBytes;

    constructor(app, own, pubkeyBytes) {
      super();
      this.#appName = app;
      this.#owner = own;
      this.#recipientPubkeyBytes = pubkeyBytes;
    }

    /**
     * HPKE-seal plaintext toward the frontend's ephemeral pubkey.
     * Used for the view/response direction.
     */
    async encrypt(plaintext, aad) {
      const { suite, DhkemX25519HkdfSha256: Kem } = await getHpke();
      const recipientPublicKey = await new Kem().deserializePublicKey(this.#recipientPubkeyBytes);
      const info = new TextEncoder().encode(VIEW_INFO);

      const sender = await suite.createSenderContext({
        recipientPublicKey,
        info,
      });

      const aadBytes = aad || new Uint8Array(0);
      const ct = await sender.seal(plaintext, aadBytes);

      return {
        algorithm: ALGORITHM,
        encapsulatedKey: Buffer.from(sender.enc).toString('base64'),
        ciphertext: Buffer.from(ct).toString('base64'),
      };
    }

    /**
     * Unseal an HPKE envelope via SAS /v2/transportOpen.
     * Used for the submission direction.
     */
    async decrypt(encrypted, aad) {
      const params = {
        appName: this.#appName,
        fluxID: this.#owner,
        encapsulatedKey: encrypted.encapsulatedKey,
        ciphertext: encrypted.ciphertext,
      };
      if (aad) {
        params.aad = Buffer.isBuffer(aad) ? aad.toString('base64') : aad;
      }

      const rpcResult = await benchmarkService.transportOpen(params);
      if (rpcResult.status !== 'success') {
        throw new Error(`transportOpen RPC failed: ${rpcResult.status}`);
      }

      const rpcData = typeof rpcResult.data === 'string'
        ? JSON.parse(rpcResult.data) : rpcResult.data;
      if (rpcData.status !== 'ok') {
        const code = rpcData.message || rpcData.status;
        const err = new Error(`transportOpen: ${code}`);
        err.code = code;
        throw err;
      }

      return Buffer.from(rpcData.message, 'utf8');
    }
  }

  const pubkeyBytes = Buffer.from(recipientPubkeyBase64, 'base64');
  return new FluxOSTransportProvider(appName, owner, pubkeyBytes);
}

module.exports = {
  create,
  VIEW_INFO,
  ALGORITHM,
};
