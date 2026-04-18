/**
 * MongoStorageProvider — concrete StorageProvider for fluxos.
 *
 * Maps logical store names (used by @megachips/flux-spec-backend domain
 * classes) to MongoDB { database, collection } pairs. Wraps a single
 * MongoClient connection and dispatches CRUD operations through
 * dbHelper, which already handles the one-liners uniformly.
 *
 * The default store map reflects FluxOS's current collection layout from
 * ZelBack/config/default.js. Callers that need a different mapping (tests,
 * in-memory overrides) can pass their own map at create-time.
 *
 * Follows the same ghost-fields contract as PR #1712: put() uses
 * replaceOne with upsert, never $set. No partial-document merges.
 */

const dbHelper = require('../dbHelper');
const { getSpecBackend } = require('../utils/specLibs');

/**
 * Default logical → physical mapping. Mirrors
 * config.database.{appsglobal,appslocal}.collections + chainparams.
 */
const DEFAULT_STORE_MAP = Object.freeze({
  appSpecs:              { database: 'globalzelapps', collection: 'zelappsinformation' },
  appMessages:           { database: 'globalzelapps', collection: 'zelappsmessages' },
  tempAppMessages:       { database: 'globalzelapps', collection: 'zelappstemporarymessages' },
  appsLocations:         { database: 'globalzelapps', collection: 'zelappslocation' },
  appsInstallingLocations: { database: 'globalzelapps', collection: 'appsinstallinglocations' },
  appsInstallingErrorsLocations: { database: 'globalzelapps', collection: 'appsInstallingErrorsLocations' },
  localAppSpecs:         { database: 'localzelapps', collection: 'zelappsinformation' },
  appsHashes:            { database: 'zelcashdata', collection: 'zelappshashes' },
  chainMessages:         { database: 'chainparams', collection: 'chainmessages' },
});

/**
 * Create a MongoStorageProvider instance.
 *
 * @param {Object} [options]
 * @param {Object} [options.storeMap] - Override the default logical→physical map
 * @param {Object} [options.client]   - Inject a MongoClient for testing; defaults
 *                                      to dbHelper.databaseConnection()
 * @returns {Promise<StorageProvider>} Concrete StorageProvider instance
 */
async function create(options = {}) {
  const { StorageProvider: Base } = await getSpecBackend();
  const storeMap = options.storeMap || DEFAULT_STORE_MAP;

  class MongoStorageProvider extends Base {
    #client;

    constructor(client) {
      super();
      this.#client = client;
    }

    #resolve(store) {
      const mapping = storeMap[store];
      if (!mapping) {
        throw new Error(`Unknown logical store: "${store}"`);
      }
      const client = this.#client || dbHelper.databaseConnection();
      if (!client) {
        throw new Error('No MongoDB connection — call dbHelper.initiateDB() first');
      }
      const db = client.db(mapping.database);
      return { db, collection: mapping.collection };
    }

    async get(store, key) {
      const { db, collection } = this.#resolve(store);
      return dbHelper.findOneInDatabase(db, collection, key);
    }

    async put(store, key, doc) {
      const { db, collection } = this.#resolve(store);
      // replaceOne (not $set) — a full-document replace prevents legacy
      // fields from an earlier version leaking into the persisted record.
      // Matches PR #1712's ghost-fields fix on zelappsinformation.
      await db.collection(collection).replaceOne(key, doc, { upsert: true });
    }

    async list(store, query = {}) {
      const { db, collection } = this.#resolve(store);
      return dbHelper.findInDatabase(db, collection, query);
    }

    async remove(store, key) {
      const { db, collection } = this.#resolve(store);
      await db.collection(collection).deleteOne(key);
    }
  }

  return new MongoStorageProvider(options.client);
}

module.exports = {
  create,
  DEFAULT_STORE_MAP,
};
