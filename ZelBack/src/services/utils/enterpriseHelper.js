const crypto = require('crypto');
const config = require('config');
const dbHelper = require('../dbHelper');
const benchmarkService = require('../benchmarkService');
const legacyCryptoProvider = require('../providers/FluxOSLegacyCryptoProvider');
const log = require('../../lib/log');

const isArcane = Boolean(process.env.FLUXOS_PATH);

/**
 * Decrypts AES key with RSA key
 * @param {string} appName - Application name
 * @param {number} daemonHeight - Daemon block height
 * @param {string} enterpriseKey - Base64 RSA encrypted AES key
 * @param {string} owner - Application owner (optional)
 * @returns {Promise<string>} Base64 AES key
 */
async function decryptAesKeyWithRsaKey(appName, daemonHeight, enterpriseKey, owner = null) {
  const block = daemonHeight;
  let appOwner = owner;

  if (!isArcane) {
    throw new Error('Application Specifications can only be validated on a node running Arcane OS.');
  }
  if (!enterpriseKey) {
    throw new Error('enterpriseKey is mandatory for enterprise Apps.');
  }

  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.appsglobal.database);
  const globalAppsMessages = config.database.appsglobal.collections.appsMessages;
  const projection = {
    projection: {
      _id: 0,
    },
  };

  let appsQuery = null;
  if (!appOwner) {
    log.info(`Searching register permanent messages for ${appName} to get registration message`);
    appsQuery = {
      'appSpecifications.name': appName,
      type: 'fluxappregister',
    };
    const permanentAppMessage = await dbHelper.findInDatabase(database, globalAppsMessages, appsQuery, projection);
    const lastAppRegistration = permanentAppMessage[permanentAppMessage.length - 1];
    appOwner = lastAppRegistration.appSpecifications.owner;
  }

  const inputData = JSON.stringify({
    fluxID: appOwner,
    appName,
    message: enterpriseKey,
    blockHeight: block,
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
 * Check and decrypt app specifications if enterprise.
 *
 * Facade retained for the ~15 legacy callsites that still work in
 * plain-object mode. New class-instance consumers should talk to
 * FluxOSLegacyCryptoProvider + EncryptedSpecV8.decrypt() directly.
 *
 * @param {object} appSpec - Application specifications
 * @param {object} options - Options object with daemonHeight and owner
 * @returns {Promise<object>} Decrypted specifications
 */
async function checkAndDecryptAppSpecs(appSpec, options = {}) {
  if (!appSpec || appSpec.version < 8 || !appSpec.enterprise) {
    return appSpec;
  }

  if (!isArcane) {
    throw new Error('Application Specifications can only be validated on a node running Arcane OS.');
  }

  // Deep clone the specifications
  const appSpecs = JSON.parse(JSON.stringify(appSpec));

  let daemonHeight = options.daemonHeight || null;

  if (!daemonHeight) {
    log.info(`Searching register permanent messages for ${appSpecs.name} to get latest update`);
    const heightQuery = { 'appSpecifications.name': appSpecs.name };
    const allPermanentAppMessage = await dbHelper.findInDatabase(
      dbHelper.databaseConnection().db(config.database.appsglobal.database),
      config.database.appsglobal.collections.appsMessages,
      heightQuery,
      { projection: { _id: 0 } },
    );
    const lastUpdate = allPermanentAppMessage[allPermanentAppMessage.length - 1];

    if (!lastUpdate) {
      log.info(`App ${appSpecs.name} not found in permanent messages, using height 0 for decryption`);
      daemonHeight = 0;
    } else {
      daemonHeight = lastUpdate.height;
    }
  }

  const provider = await legacyCryptoProvider.create(appSpecs.name, appSpecs.owner, daemonHeight);
  const plaintext = await provider.decrypt({
    algorithm: 'AES-256-GCM',
    ciphertext: appSpecs.enterprise,
  });
  const enterprise = JSON.parse(plaintext.toString('utf8'));

  appSpecs.contacts = enterprise.contacts;
  appSpecs.compose = enterprise.compose;

  return appSpecs;
}

/**
 * Encrypts content with AES session key
 * @param {string} base64Encrypted - Base64 encrypted enterprise content
 * @param {string} dataToEncrypt - Data to encrypt
 * @param {string} base64AesKey - Base64 encoded AES key
 * @returns {string} Base64 encoded encrypted content
 */
function encryptWithAesSession(base64Encrypted, dataToEncrypt, base64AesKey) {
  if (!isArcane) {
    throw new Error('Application Specifications can only be validated on a node running Arcane OS.');
  }
  try {
    const key = Buffer.from(base64AesKey, 'base64');
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);

    const encryptedStart = cipher.update(dataToEncrypt, 'utf8');
    const encryptedEnd = cipher.final();

    const nonceCyphertextTag = Buffer.concat([
      nonce,
      encryptedStart,
      encryptedEnd,
      cipher.getAuthTag(),
    ]);

    const base64NonceCyphertextTag = nonceCyphertextTag.toString('base64');
    return base64NonceCyphertextTag;
  } catch (error) {
    log.error('Error encrypting data');
    throw error;
  }
}

/**
 * Encrypts enterprise specifications from session
 * @param {object} appSpec - Application specifications
 * @param {number} daemonHeight - Daemon block height
 * @param {string} enterpriseKey - Encrypted enterprise key
 * @returns {Promise<string>} Encrypted enterprise content
 */
async function encryptEnterpriseFromSession(appSpec, daemonHeight, enterpriseKey) {
  if (!isArcane) {
    throw new Error('Application Specifications can only be validated on a node running Arcane OS.');
  }
  if (!enterpriseKey) {
    throw new Error('enterpriseKey is mandatory for enterprise Apps.');
  }

  const appName = appSpec.name;

  const enterpriseSpec = {
    contacts: appSpec.contacts,
    compose: appSpec.compose,
  };

  const encoded = JSON.stringify(enterpriseSpec);

  const base64AesKey = await decryptAesKeyWithRsaKey(appName, daemonHeight, enterpriseKey);
  const encryptedEnterprise = encryptWithAesSession(appSpec.enterprise, encoded, base64AesKey);
  if (encryptedEnterprise) {
    return encryptedEnterprise;
  }
  throw new Error('Error encrypting enterprise object.');
}

/**
 * Encrypts enterprise content with AES
 * @param {object} enterprise - Content to be encrypted
 * @param {string} appName - Application name
 * @param {number} daemonHeight - Daemon block height (optional)
 * @param {string} owner - Application owner (optional)
 * @returns {Promise<string>} Encrypted enterprise content
 */
async function encryptEnterpriseWithAes(enterprise, appName, daemonHeight = null, owner = null) {
  let block = daemonHeight;
  let appOwner = owner;

  if (!isArcane) {
    throw new Error('Application Specifications can only be validated on a node running Arcane OS.');
  }

  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.appsglobal.database);
  const globalAppsMessages = config.database.appsglobal.collections.appsMessages;
  const projection = {
    projection: {
      _id: 0,
    },
  };
  let appsQuery = null;

  if (!appOwner) {
    log.info(`Searching register permanent messages for ${appName} to get registration message`);
    appsQuery = {
      'appSpecifications.name': appName,
      type: 'fluxappregister',
    };
    const permanentAppMessage = await dbHelper.findInDatabase(database, globalAppsMessages, appsQuery, projection);
    const lastAppRegistration = permanentAppMessage[permanentAppMessage.length - 1];
    appOwner = lastAppRegistration.owner;
  }

  if (!block) {
    log.info(`Searching register permanent messages for ${appName} to get latest update`);
    appsQuery = {
      'appSpecifications.name': appName,
    };
    const allPermanentAppMessage = await dbHelper.findInDatabase(database, globalAppsMessages, appsQuery, projection);
    const lastUpdate = allPermanentAppMessage[allPermanentAppMessage.length - 1];
    block = lastUpdate.height;
  }

  const jsonEnterprise = JSON.stringify(enterprise);
  const base64JsonEnterprise = Buffer.from(jsonEnterprise).toString('base64');

  const inputData = JSON.stringify({
    fluxID: appOwner,
    appName,
    message: base64JsonEnterprise,
    blockHeight: block,
  });

  const dataReturned = await benchmarkService.encryptMessage(inputData);
  const { status, data } = dataReturned;
  if (status === 'success') {
    const dataParsed = JSON.parse(data);
    const newEnterprise = status === 'success' && dataParsed.status === 'ok' ? dataParsed.message : null;
    if (newEnterprise) {
      return newEnterprise;
    }
    throw new Error('Error encrypting application specifications.');
  } else {
    throw new Error('Error getting encrypted specifications.');
  }
}

module.exports = {
  checkAndDecryptAppSpecs,
  encryptEnterpriseWithAes,
  encryptEnterpriseFromSession,
  encryptWithAesSession,
};
