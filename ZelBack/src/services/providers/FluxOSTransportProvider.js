'use strict';

/**
 * FluxOSTransportProvider — the node-side TransportCryptoProvider (both
 * directions) for v9, on flux-spec-crypto's node functions, so a node and a
 * client run one implementation of the channel.
 *
 * seal: view/response direction (node -> frontend). flux-spec's sealView, HPKE
 *   single-shot toward the frontend's ephemeral X25519 pubkey. Fully local; the
 *   returned TransportEnvelope carries no nonce.
 *
 * open: submission direction (frontend -> node). Split-HPKE — the asymmetric
 *   decap + per-submission key export run over the benchmark channel; the bulk
 *   AES-256-GCM open (flux-spec's openSubmission) runs locally, so spec bytes
 *   never cross the channel. The appName/owner the transport key derives from
 *   are construction-time state.
 *
 * Usage (a private spec or draft sealed toward the viewer key the owner signed):
 *   const provider = await create(appName, owner);
 *   const envelope = await opened.sealForView({ provider, recipient, timestamp }); // an OwnerAuthorizedViewerKey
 *   const wire = envelope.toJSON();
 */

const benchmarkService = require('../benchmarkService');
const { getSpec } = require('../utils/specLibs');

/**
 * Create a v9 transport provider for one app.
 *
 * @param {string} appName - app name (transport key derivation input)
 * @param {string} owner   - fluxID / owner address
 * @returns {Promise<import('@runonflux/flux-spec').TransportCryptoProvider>}
 */
async function create(appName, owner) {
  const { TransportCryptoProvider, sealView, openSubmission } = await getSpec();

  class FluxOSTransportProvider extends TransportCryptoProvider {
    #appName;
    #owner;

    constructor(app, own) {
      super();
      this.#appName = app;
      this.#owner = own;
    }

    /**
     * HPKE single-shot seal toward a viewer's key (view direction). Reached only
     * through the base class's seal, which admits an owner-authorized recipient.
     * Returns a TransportEnvelope — no nonce, HPKE owns its own.
     */
    async sealToKey({
      plaintext, aad, publicKey, info,
    }) {
      return sealView({
        plaintext, aad: aad || new Uint8Array(0), publicKey, info,
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

      // A bad key/tag/aad throws.
      try {
        return Buffer.from(openSubmission({
          envelope,
          aad: aad ? new Uint8Array(aad) : new Uint8Array(0),
          key: new Uint8Array(Buffer.from(decap.key, 'base64')),
        }));
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
