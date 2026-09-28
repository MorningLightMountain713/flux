'use strict';

const secp256k1 = require('secp256k1');

/**
 * The secp256k1 recovery flux-spec's signer recovery runs on in FluxOS: the
 * native binding FluxOS ships, which loads in worker threads and answers as the
 * library's own curve does for every input, at a fraction of the cost.
 *
 * @type {{recoverPublicKey: (signature: Uint8Array, recovery: number,
 *   digest: Uint8Array, compressed: boolean) => Uint8Array}}
 */
const nativeRecoveryCurve = Object.freeze({
  recoverPublicKey(signature, recovery, digest, compressed) {
    return secp256k1.ecdsaRecover(signature, recovery, digest, compressed);
  },
});

module.exports = { nativeRecoveryCurve };
