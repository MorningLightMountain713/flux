const crypto = require('node:crypto');

const config = require('config');

const { FluxBase } = require('../fluxBase');

const dbHelper = require('../../services/dbHelper');
const benchmarkService = require('../../services/benchmarkService');

/**
 * @typedef {import("mongodb").MongoClient} MongoClient
 */

class FluxAppSpecBase extends FluxBase {
  #raw = '';

  /**
   * @type {MongoClient?}
   */
  #dbClient = null;

  /**
   * @type {string}
   */
  #globalAppsDatabase;

  /**
   * @type {string}
   */
  #appMessagesCollection;

  get viable() {
    // eslint-disable-next-line no-restricted-syntax
    for (const prop in this.mandatoryProperties) {
      if (this[prop] === null) {
        return false;
      }
    }

    return true;
  }

  get serialized() {
    // in the future just change this to sort recursively

    const { ...asObject } = this.formatted;

    return FluxAppSpecBase.serializeJson(asObject);
  }

  get missingProperties() {
    const missing = [];

    // eslint-disable-next-line no-restricted-syntax
    for (const prop in this.mandatoryProperties) {
      if (this[prop] === null) {
        missing.push(prop);
      }
    }

    return missing;
  }

  get coersedProps() {
    if (!this.#raw) return {};

    const { formatted } = this;
    const original = FluxAppSpecBase.parseJson(this.#raw);
    const coersed = {};

    // eslint-disable-next-line no-restricted-syntax
    for (const key of Object.keys(formatted)) {
      const isEqual = FluxAppSpecBase.isEqual(formatted[key], original[key]);

      if (!isEqual) coersed[key] = { from: original[key], to: formatted[key] };
    }

    return coersed;
  }

  get coersed() {
    return this.#raw ? this.serialized !== this.#raw : false;
  }

  /**
   * Makes sure the keys are the correct order. This does not check values.
   */
  get reordered() {
    if (!this.#raw) return false;

    const { formatted } = this;
    const original = FluxAppSpecBase.parseJson(this.#raw);

    const formattedKeys = Object.keys(formatted);
    const originalKeys = Object.keys(original);
    const keysLength = formattedKeys.length;

    for (let i = 0; i < keysLength; i += 1) {
      if (formattedKeys[i] !== originalKeys[i]) return true;
    }

    return false;
  }

  // eslint-disable-next-line class-methods-use-this
  get formatted() {
    throw FluxAppSpecBase.notImplemented;
  }

  /**
   *
   * @param {string} raw The stringified object
   */
  constructor(raw) {
    super();

    this.#raw = raw;
    const {
      database: {
        appsglobal: {
          database: globalAppsDatabase,
          collections: { appsMessages: appMessagesCollection },
        },
      },
    } = config;
    this.#globalAppsDatabase = globalAppsDatabase;
    this.#appMessagesCollection = appMessagesCollection;
  }

  // eslint-disable-next-line class-methods-use-this
  decrypt() {
    throw FluxAppSpecBase.notImplemented;
  }

  // eslint-disable-next-line class-methods-use-this
  verify() {
    throw FluxAppSpecBase.notImplemented;
  }

  // eslint-disable-next-line class-methods-use-this
  equal(other) {
    if (this.constructor !== other.constructor) return false;

    return this.serialized === other.serialized;
  }

  /**
   * We don't ever disconnect here. (Also no error handling)
   * @returns {Promise<void>}
   */
  async #ensureDbConnected() {
    if (this.#dbClient) return;

    this.#dbClient = dbHelper.databaseConnection();

    if (!this.#dbClient) {
      this.#dbClient = await dbHelper.connectMongoDb();
    }
  }

  /**
   *
   * @param {string} appName
   * @returns {Promise<string | null>}
   */
  async #getAppOwnerFromDb(appName) {
    // Shouldn't this also search the fluxappupdate type?

    await this.#ensureDbConnected();

    const db = this.#dbClient.db(this.#globalAppsDatabase);

    const query = {
      'appSpecifications.name': appName,
      type: 'fluxappregister',
    };

    const permanentAppMessage = await dbHelper.findInDatabase(
      db,
      this.#appMessagesCollection,
      query,
    );

    const lastAppRegistration = permanentAppMessage.at(-1);
    const { owner } = lastAppRegistration;

    return owner || null;
  }

  // /**
  //  *
  //  * @returns {Promise<number | null>}
  //  */
  // async getBlockHeight() {
  //   const { status, data: blockCount } =
  //     await daemonServiceBlockchainRpcs.getBlockCount();

  //   if (!status === "success") return null;

  //   return blockCount;
  // }

  /**
   * @param {string} appName application name.
   * @param {integer} blockHeight daemon block height
   * @param {string} encryptedKey base64 RSA encrypted AES key used to encrypt the contacts / components.
   * @param {string} appOwner Owner of the application
   * @returns {Promise<Object | null>} Returns decrypted object, or null on failure
   */
  static async #decryptAesKeyWithRsaKey(
    appName,
    blockHeight,
    encryptedKey,
    appOwner,
  ) {
    // const appOwner = fluxId || (await this.getAppOwnerFromDb(appName));

    const payload = FluxAppSpecBase.serializeJson({
      fluxID: appOwner,
      appName,
      message: encryptedKey,
      blockHeight,
    });

    if (!payload) {
      // log
      return null;
    }

    // this is cooked. Multiple layers of json responses. Fluxbenchd should
    // repackage the response, and the benchmark service should at least return an object
    const response = await benchmarkService.decryptRSAMessage(payload);

    const { status: fluxbenchdStatus, data: rawData } = response;

    if (fluxbenchdStatus !== 'success') {
      // log
      return null;
    }

    const parsed = FluxAppSpecBase.parseJson(rawData);

    if (!parsed) {
      // log
      return null;
    }

    const { status: remoteStatus, message: base64AesKey } = parsed;

    if (remoteStatus !== 'ok') return null;

    return base64AesKey;
  }

  /**
   * Decrypts content with aes key
   * @param {String} base64EncodedData AES256-GCM. Nonce, Ciphertext, Tag
   * @param {Buffer} aesKey AES key bytes
   * @returns {any} decrypted data
   */
  static #decryptAes256Gcm(nonceCiphertextTag, aesKey, options = {}) {
    const outputEncoding = options.outputEncoding || 'utf-8';

    const nonce = nonceCiphertextTag.subarray(0, 12);
    const ciphertext = nonceCiphertextTag.subarray(12, -16);
    const tag = nonceCiphertextTag.subarray(-16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce);
    decipher.setAuthTag(tag);

    const decrypted = decipher.update(ciphertext, null, outputEncoding)
      + decipher.final(outputEncoding);

    return decrypted;
  }

  /**
   * Decrypts app specs from api request. It is expected that the caller of this
   * endpoint has aes-256-gcm encrypted the app specs with a random aes key,
   * encrypted with the RSA public key received via prior api call.
   *
   * The enterpise field is in this format:
   * base64(rsa encrypted aes key + nonce + aes-256-gcm(base64(json(enterprise specs))) + authTag)
   *
   * We do this so that we don't have to double JSON encode, and we have the
   * nonce + cyphertext + tag all in one entry
   *
   * The enterpriseKey is in this format:
   * base64(rsa(base64(aes key bytes))))
   *
   * We base64 encode the key so that were not passing around raw bytes
   *
   * @param {string} base64Encrypted enterprise encrypted content (decrypted is a JSON string)
   * @param {string} appName application name
   * @param {integer} daemonHeight daemon block height
   * @param {string} owner App owner
   * @returns {Promise<Object | null>} Returns contacts / components decrypted
   */
  static async decryptProperties(
    base64Encrypted,
    appName,
    daemonHeight,
    owner,
  ) {
    const enterpriseBuf = Buffer.from(base64Encrypted, 'base64');
    const aesKeyEncrypted = enterpriseBuf.subarray(0, 256);
    const nonceCiphertextTag = enterpriseBuf.subarray(256);

    // we encode this as we are passing it as an api call
    const base64EncryptedAesKey = aesKeyEncrypted.toString('base64');

    const base64AesKey = await FluxAppSpecBase.#decryptAesKeyWithRsaKey(
      appName,
      daemonHeight,
      base64EncryptedAesKey,
      owner,
    );

    if (!base64AesKey) {
      // log
      return null;
    }

    const aesKey = Buffer.from(base64AesKey, 'base64');

    const decrypted = FluxAppSpecBase.#decryptAes256Gcm(
      nonceCiphertextTag,
      aesKey,
    );

    if (!decrypted) {
      // log
      return null;
    }

    const parsed = FluxAppSpecBase.parseJson(decrypted);

    // this is the components and contacts. However, they are still
    // stringified from the frontend

    return parsed;
  }
}

module.exports = { FluxAppSpecBase };
