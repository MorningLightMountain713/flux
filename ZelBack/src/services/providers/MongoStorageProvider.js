'use strict';

const dbHelper = require('../dbHelper');
const { getSpecBackend } = require('../utils/specLibs');

const DEFAULT_STORE_MAP = Object.freeze({
  appSpecs: { database: 'globalzelapps', collection: 'zelappsinformation' },
  appMessages: { database: 'globalzelapps', collection: 'zelappsmessages' },
  tempAppMessages: { database: 'globalzelapps', collection: 'zelappstemporarymessages' },
  appsInstallingLocations: { database: 'globalzelapps', collection: 'appsinstallinglocations' },
  appsInstallingErrorsLocations: { database: 'globalzelapps', collection: 'appsInstallingErrorsLocations' },
  localAppSpecs: { database: 'localzelapps', collection: 'zelappsinformation' },
  appsHashes: { database: 'zelcashdata', collection: 'zelappshashes' },
  chainMessages: { database: 'chainparams', collection: 'chainmessages' },
});

async function create(options = {}) {
  const { StorageProvider: Base } = await getSpecBackend();
  const storeMap = options.storeMap || DEFAULT_STORE_MAP;

  class MongoStorageProvider extends Base {
    #resolve(store) {
      const mapping = storeMap[store];
      if (!mapping) {
        throw new Error(`Unknown logical store: "${store}"`);
      }
      const client = dbHelper.databaseConnection();
      if (!client) {
        throw new Error('No MongoDB connection — call dbHelper.initiateDB() first');
      }
      return { db: client.db(mapping.database), collection: mapping.collection };
    }

    async get(store, key) {
      const { db, collection } = this.#resolve(store);
      return dbHelper.findOneInDatabase(db, collection, key);
    }

    async put(store, key, doc) {
      const { db, collection } = this.#resolve(store);
      await dbHelper.replaceOneInDatabase(db, collection, key, doc, { upsert: true });
    }

    async list(store, query = {}) {
      const { db, collection } = this.#resolve(store);
      return dbHelper.findInDatabase(db, collection, query);
    }

    async remove(store, key) {
      const { db, collection } = this.#resolve(store);
      await dbHelper.removeDocumentsFromCollection(db, collection, key);
    }
  }

  return new MongoStorageProvider();
}

module.exports = {
  create,
  DEFAULT_STORE_MAP,
};
