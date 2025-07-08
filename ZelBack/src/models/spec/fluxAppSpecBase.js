const crypto = require("node:crypto");
const path = require("node:path");

const config = require("config");

const { FluxBase } = require("../fluxBase");

const fluxosBasePath = process.env.FLUXOS_PATH;
const fluxosServicePath = path.join(fluxosBasePath, "ZelBack/src/services");

const dbHelper = require(path.join(fluxosServicePath, "dbHelper"));
const benchmarkService = require(path.join(
  fluxosServicePath,
  "benchmarkService"
));
// const daemonServiceBlockchainRpcs = require(path.join(
//   fluxosServicePath,
//   "daemonService/daemonServiceBlockchainRpcs"
// ));

/**
 * @typedef {import("mongodb").MongoClient} MongoClient
 */

class FluxAppSpecBase extends FluxBase {
  #raw = "";

  #decrypted = false;

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

  get decrypted() {
    return this.#decrypted;
  }

  get viable() {
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

    for (const prop in this.mandatoryProperties) {
      if (this[prop] === null) {
        missing.push(prop);
      }
    }

    return missing;
  }

  get coersedProps() {
    if (!this.#raw) return {};

    const formatted = this.formatted;
    const original = FluxAppSpecBase.parseJson(this.#raw);
    const coersed = {};

    for (const key of Object.keys(formatted)) {
      const isEqual = FluxAppSpecBase.isEqual(formatted[key], original[key]);

      if (!isEqual) coersed[key] = { from: original[key], to: formatted[key] };
    }

    return coersed;
  }

  get coersed() {
    return this.#raw ? this.serialized !== this.#raw : false;
  }

  get coersedProps() {
    if (!this.#raw) return {};

    const formatted = this.formatted;
    const original = FluxAppSpecBase.parseJson(this.#raw);
    const coersed = {};

    for (const key of Object.keys(formatted)) {
      const isEqual = FluxAppSpecBase.isEqual(formatted[key], original[key]);

      if (!isEqual) coersed[key] = { from: original[key], to: formatted[key] };
    }

    return coersed;
  }

  /**
   * Makes sure the keys are the correct order. This does not check values.
   */
  get reordered() {
    if (!this.#raw) return false;

    const formatted = this.formatted;
    const original = FluxAppSpecBase.parseJson(this.#raw);

    const formattedKeys = Object.keys(formatted);
    const originalKeys = Object.keys(original);

    for (let i = 0; (l = formattedKeys.length); i < l, i++) {
      if (formattedKeys[i] !== originalKeys[i]) return true;
    }

    return false;
  }

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
    config.database.appsglobal.collections.appsMessages;
    const {
      database: {
        appsGlobal: {
          database: globalAppsDatabase,
          collections: { appsMessages: appMessagesCollection },
        },
      },
    } = config;
    this.#globalAppsDatabase = globalAppsDatabase;
    this.#appMessagesCollection = appMessagesCollection;
  }

  decrypt() {
    throw FluxAppSpecBase.notImplemented;
  }

  verify(_blob) {
    throw FluxAppSpecBase.notImplemented;
  }

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
      "appSpecifications.name": appName,
      type: "fluxappregister",
    };

    const permanentAppMessage = await dbHelper.findInDatabase(
      db,
      this.#appMessagesCollection,
      query
    );

    const lastAppRegistration = permanentAppMessage.at(-1);
    const { owner } = lastAppRegistration;

    return owner | null;
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
  async decryptAesKeyWithRsaKey(appName, blockHeight, encryptedKey, appOwner) {
    // const appOwner = fluxId || (await this.getAppOwnerFromDb(appName));

    const payload = FluxBase.serializeJson({
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

    if (fluxbenchdStatus !== "success") {
      // log
      return null;
    }

    const parsed = FluxBase.parseJson(rawData);

    if (!parsed) {
      // log
      return null;
    }

    const { status: remoteStatus, message: base64AesKey } = parsed;

    if (remoteStatus !== "ok") return null;

    return base64AesKey;
  }

  /**
   * Decrypts content with aes key
   * @param {String} base64EncodedData AES256-GCM. Nonce, Ciphertext, Tag
   * @param {Buffer} aesKey AES key bytes
   * @returns {any} decrypted data
   */
  decryptAes256Gcm(base64EncodedData, aesKey, options = {}) {
    const outputEncoding = options.outputEncoding || "utf-8";

    const nonceCiphertextTag = Buffer.from(base64EncodedData, "base64");

    const nonce = nonceCiphertextTag.subarray(0, 12);
    const ciphertext = nonceCiphertextTag.subarray(12, -16);
    const tag = nonceCiphertextTag.subarray(-16);

    const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, nonce);
    decipher.setAuthTag(tag);

    const decrypted =
      decipher.update(ciphertext, null, outputEncoding) +
      decipher.final(outputEncoding);

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
  async decryptProperties(base64Encrypted, appName, daemonHeight, owner) {
    const enterpriseBuf = Buffer.from(base64Encrypted, "base64");
    const aesKeyEncrypted = enterpriseBuf.subarray(0, 256);
    const nonceCiphertextTag = enterpriseBuf.subarray(256);

    // we encode this as we are passing it as an api call
    const base64EncryptedAesKey = aesKeyEncrypted.toString("base64");

    const base64AesKey = await this.decryptAesKeyWithRsaKey(
      appName,
      daemonHeight,
      base64EncryptedAesKey,
      owner
    );

    if (!base64AesKey) {
      // log
      return null;
    }

    const decrypted = this.decryptAes256Gcm(nonceCiphertextTag, base64AesKey);

    if (!decrypted) {
      // log
      return null;
    }

    const parsed = FluxBase.parseJson(decrypted);

    // this is the components and contacts. However, the components are still
    // stringified from the frontend

    return parsed;
  }
}

module.exports = { FluxAppSpecBase };
