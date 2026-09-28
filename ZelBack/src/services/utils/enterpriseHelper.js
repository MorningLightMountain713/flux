'use strict';

const crypto = require('crypto');
const benchmarkService = require('../benchmarkService');
const log = require('../../lib/log');

const isArcane = Boolean(process.env.FLUXOS_PATH);

/**
 * Decrypts AES key with RSA key
 * @param {string} appName - Application name
 * @param {number} daemonHeight - Daemon block height
 * @param {string} enterpriseKey - Base64 RSA encrypted AES key
 * @param {string} owner - the fluxID the key was sealed for
 * @returns {Promise<string>} Base64 AES key
 */
async function decryptAesKeyWithRsaKey(appName, daemonHeight, enterpriseKey, owner) {
  if (!isArcane) {
    throw new Error('Application Specifications can only be validated on a node running Arcane OS.');
  }
  if (!enterpriseKey) {
    throw new Error('enterpriseKey is mandatory for enterprise Apps.');
  }
  if (!owner) {
    throw new Error('the fluxID the key was sealed for is mandatory for enterprise Apps.');
  }

  const inputData = JSON.stringify({
    fluxID: owner,
    appName,
    message: enterpriseKey,
    blockHeight: daemonHeight,
  });

  const dataReturned = await benchmarkService.decryptRSAMessage(inputData);
  const { status, data } = dataReturned;
  if (status === 'success') {
    const dataParsed = JSON.parse(data);
    const base64AesKey = dataParsed.status === 'ok' ? dataParsed.message : null;
    if (base64AesKey) return base64AesKey;

    throw new Error('Error decrypting AES key.');
  } else {
    throw new Error('Error getting decrypted AES key.');
  }
}

/**
 * Decrypts content with AES session key
 * @param {string} appName - Application name
 * @param {string} base64NonceCiphertextTag - Base64 encoded nonce, ciphertext and auth tag
 * @param {string} base64AesKey - Base64 encoded AES key
 * @returns {string} Decrypted content
 */
function decryptWithAesSession(appName, base64NonceCiphertextTag, base64AesKey) {
  if (!isArcane) {
    throw new Error('Application Specifications can only be validated on a node running Arcane OS.');
  }

  try {
    const key = Buffer.from(base64AesKey, 'base64');
    const nonceCiphertextTag = Buffer.from(base64NonceCiphertextTag, 'base64');

    const nonce = nonceCiphertextTag.subarray(0, 12);
    const ciphertext = nonceCiphertextTag.subarray(12, -16);
    const tag = nonceCiphertextTag.subarray(-16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);

    const decrypted = decipher.update(ciphertext, '', 'utf8') + decipher.final('utf8');

    return decrypted;
  } catch (error) {
    log.error(`Error decrypting ${appName}`);
    throw error;
  }
}

/**
 * Decrypts enterprise specifications from session
 * @param {string} base64Encrypted - Base64 encrypted enterprise content
 * @param {string} appName - Application name
 * @param {number} daemonHeight - Daemon block height
 * @param {string} owner - the fluxID the key was sealed for
 * @returns {Promise<object>} Decrypted enterprise object
 */
async function decryptEnterpriseFromSession(base64Encrypted, appName, daemonHeight, owner) {
  if (!isArcane) {
    throw new Error('Application Specifications can only be validated on a node running Arcane OS.');
  }

  const enterpriseBuf = Buffer.from(base64Encrypted, 'base64');
  const aesKeyEncrypted = enterpriseBuf.subarray(0, 256);
  const nonceCiphertextTag = enterpriseBuf.subarray(256);

  // we encode this as we are passing it as an api call
  const base64EncryptedAesKey = aesKeyEncrypted.toString('base64');

  const base64AesKey = await decryptAesKeyWithRsaKey(
    appName,
    daemonHeight,
    base64EncryptedAesKey,
    owner,
  );

  const jsonEnterprise = decryptWithAesSession(
    appName,
    nonceCiphertextTag.toString('base64'),
    base64AesKey,
  );

  const decryptedEnterprise = JSON.parse(jsonEnterprise);

  if (decryptedEnterprise) {
    return decryptedEnterprise;
  }
  throw new Error('Error decrypting enterprise object.');
}

module.exports = {
  decryptEnterpriseFromSession,
  decryptAesKeyWithRsaKey,
  decryptWithAesSession,
};
