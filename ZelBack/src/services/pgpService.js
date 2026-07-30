const openpgp = require('openpgp');
const generalService = require('./generalService');
const nodeIdentityRepository = require('./appDatabase/nodeIdentityRepository');
const log = require('../lib/log');

/**
 * To check if correct pgp identity exists
 */
async function identityExists() {
  try {
    // only generate new identity if the keypair is missing, or does not match
    const stored = await nodeIdentityRepository.getPgpIdentity();
    if (stored) {
      // check if public key belongs to our private key
      const privateKey = await openpgp.readPrivateKey({ armoredKey: stored.privateKey });
      const publicKey = privateKey.toPublic().armor();
      if (publicKey !== stored.publicKey) {
        log.warn('Existing PGP identity is corrupted. Generating new identity');
        return false;
      }
      return true;
    }
    log.info('PGP identity does not exist. Proceeding with generation');
    return false;
  } catch (error) {
    log.error(error);
    log.info('PGP identity error. Generating new identity');
    return false;
  }
}

/**
 * The keypair still held in config/userconfig.js, when it is intact.
 *
 * Nodes upgrading from a FluxOS that kept the keypair in that file can reach identity
 * generation before the migration has adopted it: the migration only logs its failures,
 * and the config it read may have been the fallback configManager publishes when
 * config/userconfig.js is unreadable, which carries no keypair. Generating over the
 * operator's keypair is unrecoverable — it is the key their apps' registry credentials
 * are encrypted to — so the file is consulted before generating, and only when the
 * database holds nothing.
 *
 * The halves are matched on fingerprint rather than armored text, which is not a stable
 * encoding of a key.
 * @returns {Promise<{privateKey: string, publicKey: string}|null>}
 */
async function configFileIdentity() {
  const initial = globalThis.userconfig ? globalThis.userconfig.initial : null;
  if (!initial || !initial.pgpPrivateKey || !initial.pgpPublicKey) return null;

  try {
    const privateKey = await openpgp.readPrivateKey({ armoredKey: initial.pgpPrivateKey });
    const publicKey = await openpgp.readKey({ armoredKey: initial.pgpPublicKey });
    if (privateKey.toPublic().getFingerprint() !== publicKey.getFingerprint()) {
      log.warn('PGP keypair in the config file does not match itself. Ignoring it');
      return null;
    }
    return { privateKey: initial.pgpPrivateKey, publicKey: initial.pgpPublicKey };
  } catch (error) {
    log.warn(`PGP keypair in the config file is unreadable. Ignoring it: ${error.message}`);
    return null;
  }
}

/**
 * To generate and store new identity
 */
async function generateIdentity() {
  try {
    const currentIdentityExists = await identityExists();
    if (currentIdentityExists) {
      return;
    }
    const fromConfigFile = await configFileIdentity();
    if (fromConfigFile) {
      const adopted = await nodeIdentityRepository.setPgpIdentity(fromConfigFile);
      if (!adopted) {
        log.error('PGP identity found in the config file but could not be stored - database unavailable');
        return;
      }
      log.info('Adopted the PGP keypair from the config file');
      return;
    }
    const collateralInfo = await generalService.obtainNodeCollateralInformation();
    // userId name is our txid:outputid
    // userId email is our zelid@runonflux.io
    const email = `${userconfig.initial.zelid}@runonflux.io`; // 1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC@runonflux.io
    const name = `${collateralInfo.txhash}:${collateralInfo.txindex}`; // '0000000567ad22d02e3fc7631d94eb0dac5f1d5eb4adbd63349766f2665640c6:0'
    const keypair = await openpgp.generateKey({
      type: 'ecc', // Type of the key, defaults to ECC
      curve: 'curve25519', // ECC curve name, defaults to curve25519
      userIDs: [{ name, email }], // you can pass multiple user IDs
      passphrase: '', // no password
      format: 'armored', // output key format, defaults to 'armored' (other options: 'binary' or 'object')
    });
    // Fail loudly rather than leave the node believing it has an identity it never
    // persisted: the next boot would generate a different keypair, and anything
    // encrypted to the first one in between becomes undecryptable.
    const persisted = await nodeIdentityRepository.setPgpIdentity({
      privateKey: keypair.privateKey,
      publicKey: keypair.publicKey,
    });
    if (!persisted) {
      log.error('PGP identity generated but could not be stored - database unavailable');
      return;
    }
    log.info('PGP identity generated');
  } catch (error) {
    log.error('Identity generation error');
    log.error(error);
  }
}

/**
 * To encrypt a message with an array of encryption public keys
 * @param {string} message Message to encrypt
 * @param {array} encryptionKeys Armored version of array of public key
 * @returns {string} Return armored version of encrypted message
 */
async function encryptMessage(message, encryptionKeys) {
  try {
    const publicKeys = await Promise.all(encryptionKeys.map((armoredKey) => openpgp.readKey({ armoredKey })));

    const pgpMessage = await openpgp.createMessage({ text: message });
    const encryptedMessage = await openpgp.encrypt({
      message: pgpMessage, // input as Message object
      encryptionKeys: publicKeys,
    });
    // '-----BEGIN PGP MESSAGE ... END PGP MESSAGE-----'
    return encryptedMessage;
  } catch (error) {
    log.error(error);
    return null;
  }
}

/**
 * To decrypt a message with an armored private key
 * @param {string} encryptedMessage Message to encrypt
 * @param {string} [decryptionKey] Armored private key; defaults to this node's own
 * @returns {Promise<string>} Return plain text message
 */
async function decryptMessage(encryptedMessage, decryptionKey = null) {
  try {
    // Resolved per call rather than as a default parameter: the node's own key
    // comes from the database, which a default expression cannot await.
    const armoredKey = decryptionKey
      ?? (await nodeIdentityRepository.getPgpIdentity())?.privateKey;
    if (!armoredKey) {
      log.error('No PGP private key available to decrypt with');
      return null;
    }
    const messageEncrypted = await openpgp.readMessage({
      armoredMessage: encryptedMessage, // parse armored message
    });
    const privateKey = await openpgp.readPrivateKey({ armoredKey });
    const decryptedMessage = await openpgp.decrypt({
      message: messageEncrypted,
      decryptionKeys: privateKey,
    });
    return decryptedMessage.data;
  } catch (error) {
    log.error(error);
    return null;
  }
}

module.exports = {
  generateIdentity,
  encryptMessage,
  decryptMessage,
};
