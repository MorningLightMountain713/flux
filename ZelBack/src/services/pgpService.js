'use strict';

const generalService = require('./generalService');
const workerRunner = require('./utils/workerRunner');
const nodeIdentityRepository = require('./appDatabase/nodeIdentityRepository');
const log = require('../lib/log');

// Every openpgp call goes through a worker that is spawned per operation and
// terminated after it: the library holds ~19MB, largely WASM linear memory, from the
// moment it is required, and a node needs it for one identity check at boot plus the
// secrets of the handful of v7 apps still carrying PGP-encrypted fields. Requiring it
// in this process would put that back into every FluxOS isolate permanently.
const runPgp = (operation, params) => workerRunner.runInWorker('pgpWorker', { operation, params });

/**
 * To check if correct pgp identity exists
 */
async function identityExists() {
  try {
    // only generate new identity if the keypair is missing, or does not match
    const stored = await nodeIdentityRepository.getPgpIdentity();
    if (stored) {
      // check if public key belongs to our private key
      const publicKey = await runPgp('derivePublicKey', { armoredPrivateKey: stored.privateKey });
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
    const matches = await runPgp('keypairMatches', {
      armoredPrivateKey: initial.pgpPrivateKey,
      armoredPublicKey: initial.pgpPublicKey,
    });
    if (!matches) {
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
    const keypair = await runPgp('generateKey', { name, email });
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
    // '-----BEGIN PGP MESSAGE ... END PGP MESSAGE-----'
    return await runPgp('encrypt', { message, encryptionKeys });
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
    return await runPgp('decrypt', { encryptedMessage, decryptionKey: armoredKey });
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
