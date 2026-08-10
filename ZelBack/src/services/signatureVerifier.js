'use strict';

const bs58check = require('bs58check');
const { pubKeyToAddr } = require('./utils/fluxCryptoUtils');
const bitcoinMessage = require('bitcoinjs-message');
const { getSpecBackend } = require('./utils/specLibs');
const ethereumHelper = require('./ethereumHelper');
const log = require('../lib/log');

const base58Chars = /^[1-9a-km-zA-HJ-NP-Z]+$/;
const ethAddress = /^0x[a-fA-F0-9]{40}$/;

/**
 * Whether an identity is one a signature can be verified against - a Flux ID
 * (base58check P2PKH) or an Ethereum address.
 *
 * Login identities and app owners are both held to this. An app owner that is
 * neither can never be signed for, which leaves the app unmanageable by anyone.
 *
 * @param {string} identity
 *
 * @returns {bool} isValid
 */
function isValidSigningIdentity(identity) {
  if (!identity || typeof identity !== 'string') {
    return false;
  }

  if (identity.startsWith('0x')) {
    return ethAddress.test(identity);
  }

  if (identity[0] !== '1' || identity.length < 25 || identity.length > 34) {
    return false;
  }

  if (!base58Chars.test(identity)) {
    return false;
  }

  try {
    // version byte + hash160. A bad checksum throws, and would fail signature
    // verification just as surely as the wrong shape.
    return bs58check.decode(identity).length === 21;
  } catch {
    return false;
  }
}

/**
 * Whether two identities are the same signer.
 *
 * Case is part of a Flux ID, which is base58. It is not part of an Ethereum address:
 * the capitalisation there is an EIP-55 checksum over an address that is really 20
 * bytes, which is why verifySignature below compares the recovered address
 * case-insensitively. Two specs whose owners differ only in that capitalisation name
 * the same key, and anything that treats them as different owners locks that owner
 * out of their own app.
 *
 * @param {string} a
 * @param {string} b
 *
 * @returns {bool} isSame
 */
function sameSigningIdentity(a, b) {
  if (!a || !b || typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.startsWith('0x') && b.startsWith('0x')) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/**
 * Whether a list of identities holds this signer.
 *
 * Membership, on the same terms as sameSigningIdentity above: a list is a set of signers,
 * and the question every caller of it asks is whether this signer is one of them. Asked
 * with an exact match instead, an owner writing their own address in the other valid
 * capitalisation is a stranger to every list while still signing as themselves - refused
 * their own privileges, and swept off a node as an app that does not belong there.
 *
 * @param {string[]} identities
 * @param {string} identity
 *
 * @returns {bool} isMember
 */
function includesSigningIdentity(identities, identity) {
  if (!Array.isArray(identities)) return false;
  return identities.some((candidate) => sameSigningIdentity(candidate, identity));
}

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
  includesSigningIdentity,
  isValidSigningIdentity,
  sameSigningIdentity,
  verifySignature,
};
