'use strict';

/**
 * FluxOSTransportProvider — the node-side TransportCryptoProvider (both
 * directions) for v9.
 *
 * seal: view/response direction (node -> frontend). HPKE single-shot seal toward
 *   the frontend's ephemeral X25519 pubkey via @hpke/core. Fully local; the
 *   returned TransportEnvelope carries no nonce (HPKE manages it internally).
 *
 * open: submission direction (frontend -> node). Split-HPKE — the asymmetric
 *   decap + per-submission key export run over the benchmark channel; the bulk
 *   AES-256-GCM open runs locally, so spec bytes never cross the channel. The
 *   appName/owner the transport key derives from are construction-time state.
 *
 * Usage (appConvert seals the converted spec toward the owner's frontend pubkey):
 *   const provider = await create(appName, owner);
 *   const envelope = await provider.seal({ plaintext, aad, peerPublicKey, info });
 *   const wire = envelope.toJSON();
 */

const benchmarkService = require('../benchmarkService');
const { aeadDecrypt } = require('../utils/aeadCrypto');
const { getSpec } = require('../utils/specLibs');

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
 * Create a v9 transport provider for one app.
 *
 * @param {string} appName - app name (transport key derivation input)
 * @param {string} owner   - fluxID / owner address
 * @returns {Promise<import('@runonflux/flux-spec').TransportCryptoProvider>}
 */
async function create(appName, owner) {
  const { TransportCryptoProvider, TransportEnvelope, TRANSPORT_ALGORITHM } = await getSpec();

  class FluxOSTransportProvider extends TransportCryptoProvider {
    #appName;
    #owner;

    constructor(app, own) {
      super();
      this.#appName = app;
      this.#owner = own;
    }

    /**
     * HPKE single-shot seal toward a recipient's ephemeral pubkey (view
     * direction). Returns a TransportEnvelope — no nonce, HPKE owns its own.
     */
    async seal({
      plaintext, aad, peerPublicKey, info,
    }) {
      const { suite, DhkemX25519HkdfSha256: Kem } = await getHpke();
      const recipientPublicKey = await new Kem().deserializePublicKey(peerPublicKey);
      const sender = await suite.createSenderContext({
        recipientPublicKey,
        info: new TextEncoder().encode(info),
      });
      const ct = await sender.seal(plaintext, aad || new Uint8Array(0));
      return new TransportEnvelope({
        algorithm: TRANSPORT_ALGORITHM,
        encapsulatedKey: new Uint8Array(sender.enc),
        ciphertext: new Uint8Array(ct),
      });
    }

    /**
     * Open a submission-direction envelope via split-HPKE: the benchmark channel
     * performs only the asymmetric decap + per-submission key export; the spec
     * ciphertext is opened locally with AES-256-GCM. Throws with a `.code`
     * (MISSING_FIELD | INTERNAL_ERROR | DECRYPT_FAILED | ...) for peer discipline.
     */
    async open({ envelope, aad }) {
      if (!envelope.nonce) {
        const err = new Error('Transport-encrypted payload missing nonce');
        err.code = 'MISSING_FIELD';
        throw err;
      }

      // Asymmetric step only: decap + export the 32-byte per-submission key.
      const resp = await benchmarkService.transportDecap({
        appName: this.#appName,
        fluxID: this.#owner,
        encapsulatedKey: Buffer.from(envelope.encapsulatedKey).toString('base64'),
      });
      if (!resp || resp.status !== 'success') {
        const err = new Error('Transport open failed (benchmark unreachable)');
        err.code = 'INTERNAL_ERROR';
        throw err;
      }

      const decap = typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
      if (!decap || decap.status !== 'ok' || !decap.key) {
        const code = (decap && decap.message) || 'INTERNAL_ERROR';
        const err = new Error(`Transport decap failed: ${code}`);
        err.code = code;
        throw err;
      }

      // The envelope ciphertext is ct‖tag and aeadCrypto frames as nonce‖ct‖tag,
      // so the nonce followed by the ciphertext is exactly the frame aeadDecrypt
      // expects — no byte re-ordering. A bad key/tag/aad throws.
      const key = Buffer.from(decap.key, 'base64');
      const frame = Buffer.concat([Buffer.from(envelope.nonce), Buffer.from(envelope.ciphertext)]);
      const aadBuf = aad ? Buffer.from(aad) : Buffer.alloc(0);
      try {
        return aeadDecrypt(key, frame, aadBuf);
      } catch (decryptError) {
        const err = new Error('Transport open failed: AEAD authentication failed');
        err.code = 'DECRYPT_FAILED';
        throw err;
      }
    }
  }

  return new FluxOSTransportProvider(appName, owner);
}

module.exports = {
  create,
};
