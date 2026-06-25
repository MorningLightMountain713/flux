/**
 * FluxOSTransportProvider — transport CryptoProvider for v9 (both directions).
 *
 * encrypt: HPKE single-shot seal toward the frontend's ephemeral X25519 pubkey
 *   using @hpke/core (view/response direction, backend → frontend) under
 *   SPEC_VIEW_INFO. The ephemeral keypair is generated and discarded in scope.
 *   Fully local; the envelope carries no separate nonce.
 *
 * decrypt: opens a submission-direction envelope (frontend → backend) via
 *   split-HPKE — delegates to utils/transportHelper.decapAndOpen, which decaps +
 *   exports the per-submission key over the benchmark channel and AES-256-GCM-
 *   opens the spec locally. The export-mode envelope carries an explicit nonce.
 *
 * Usage (appConvert seals the converted spec toward the owner's frontend pubkey):
 *   const provider = await create(appName, owner, frontendPubkeyBase64);
 *   const envelope = await provider.encrypt(plaintext, aad);
 */

const transportHelper = require('../utils/transportHelper');
const { getSpec, getSpecBackend } = require('../utils/specLibs');

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
 * @param {string} appName - App name (key derivation input)
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
      const { TRANSPORT_ALGORITHM, SPEC_VIEW_INFO } = await getSpec();
      const recipientPublicKey = await new Kem().deserializePublicKey(this.#recipientPubkeyBytes);
      const info = new TextEncoder().encode(SPEC_VIEW_INFO);

      const sender = await suite.createSenderContext({
        recipientPublicKey,
        info,
      });

      const aadBytes = aad || new Uint8Array(0);
      const ct = await sender.seal(plaintext, aadBytes);

      return {
        algorithm: TRANSPORT_ALGORITHM,
        encapsulatedKey: Buffer.from(sender.enc).toString('base64'),
        ciphertext: Buffer.from(ct).toString('base64'),
      };
    }

    /**
     * Open a submission-direction envelope via split-HPKE. Delegates the decap +
     * local AES-256-GCM to the shared utils/transportHelper.decapAndOpen, so the
     * open path lives in exactly one place.
     */
    async decrypt(encrypted, aad) {
      const { TransportEnvelope } = await getSpec();
      const envelope = TransportEnvelope.fromJSON(encrypted);
      const aadBytes = aad
        ? (Buffer.isBuffer(aad) ? aad : Buffer.from(aad, 'base64'))
        : Buffer.alloc(0);
      return transportHelper.decapAndOpen({
        appName: this.#appName,
        fluxID: this.#owner,
        encapsulatedKey: envelope.encapsulatedKey,
        nonce: envelope.nonce,
        ciphertext: envelope.ciphertext,
        aad: aadBytes,
      });
    }
  }

  const pubkeyBytes = Buffer.from(recipientPubkeyBase64, 'base64');
  return new FluxOSTransportProvider(appName, owner, pubkeyBytes);
}

module.exports = {
  create,
};
