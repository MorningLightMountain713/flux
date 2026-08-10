'use strict';

const { pubKeyToAddr } = require('./utils/fluxCryptoUtils');
const bitcoinMessage = require('bitcoinjs-message');
const { getSpecBackend } = require('./utils/specLibs');
const ethereumHelper = require('./ethereumHelper');
const log = require('../lib/log');

/**
 * Verifies signature of application owner on bitcoin or ethereum networks
 *
 * A signature must also be in CANONICAL form. The network identifies a message
 * by a hash over its payload AND its signature bytes, so a signature that can
 * be re-encoded while still verifying gives one signed message several
 * identities — each accepted as genuinely signed, none deduplicated against
 * the others, and all mintable by anyone who observed the first without the
 * owner's key. `bitcoinjs-message` accepts the high-S twin; nano-ethereum-signer
 * accepts that and the bare 0/1 spelling of `v`.
 *
 * The rule itself lives in flux-spec (`signature/canonical.js`) and is reached
 * through the CJS bridge, so this verifier and the library's enforce identical
 * code. Do not reimplement it here — a consensus rule written twice is one that
 * eventually disagrees with itself.
 *
 * @param {object} message
 * @param {string} address
 * @param {string} signature
 *
 * @returns {Promise<bool>} isValid
 */
async function verifySignature(message, address, signature) {
  let isValid = false;
  let signingAddress = address;
  try {
    if (!address || !message || !signature) {
      throw new Error('Missing parameters for message verification');
    }

    const { isCanonicalSignature } = await getSpecBackend();
    if (!isCanonicalSignature(signature, address.startsWith('0x') ? 'eth' : 'btc')) {
      throw new Error('Signature is not in canonical form');
    }

    if (address.startsWith('0x')) {
      const messageSigner = ethereumHelper.recoverSigner(message, signature);
      if (messageSigner.toLowerCase() === address.toLowerCase()) {
        isValid = true;
      }
    } else {
      if (address.length > 36) {
        // bitcoin
        const btcPubKeyHash = '00';
        const sigAddress = pubKeyToAddr(address, btcPubKeyHash);
        signingAddress = sigAddress;
      }
      isValid = bitcoinMessage.verify(message, signingAddress, signature);
    }
  } catch (e) {
    log.error(e);
  }
  return isValid;
}

module.exports = {
  verifySignature,
};
