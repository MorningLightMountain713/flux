'use strict';

const dbHelper = require('../dbHelper');
const specLibrary = require('../utils/specLibrary');

/**
 * flux-spec's StorageProvider over this node's MongoDB. Each logical store is a
 * collection of one of the node's databases, every query in the port's language
 * is one Mongo filter, and a record is returned without the document id.
 * Queries and changes are translated by flux-spec (`toMongoFilter`,
 * `toMongoUpdate`).
 */

function projectionFor(fields) {
  const projection = { _id: 0 };
  if (fields) for (const field of fields) projection[field] = 1;
  return projection;
}

let Provider = null;

function providerClass() {
  if (Provider) return Provider;
  const { StorageProvider, toMongoFilter: toFilter, toMongoUpdate: toUpdate } = specLibrary.loaded();

  Provider = class MongoStorageProvider extends StorageProvider {
    #stores;

    /**
     * @param {Object<string, {database: string, collection: string}>} stores
     *   each logical store's database and collection
     */
    constructor(stores) {
      super();
      this.#stores = stores;
    }

    #collection(store) {
      const mapping = this.#stores[store];
      if (!mapping) throw new Error(`MongoStorageProvider: unknown store "${store}"`);
      const client = dbHelper.databaseConnection();
      if (!client) throw new Error('MongoStorageProvider: no MongoDB connection');
      return client.db(mapping.database).collection(mapping.collection);
    }

    async find(store, query, { fields, sort, limit } = {}) {
      const options = { projection: projectionFor(fields) };
      if (sort) options.sort = sort;
      if (limit !== undefined) options.limit = limit;
      return this.#collection(store).find(toFilter(query), options).toArray();
    }

    async findOne(store, query, { fields, sort } = {}) {
      const options = { projection: projectionFor(fields) };
      if (sort) options.sort = sort;
      return this.#collection(store).findOne(toFilter(query), options);
    }

    async count(store, query) {
      return this.#collection(store).countDocuments(toFilter(query));
    }

    async insert(store, records) {
      if (!records.length) return;
      // The driver writes the id it assigns into the document it is given.
      await this.#collection(store).insertMany(records.map((record) => ({ ...record })));
    }

    async replace(store, query, record, { upsert = false } = {}) {
      await this.#collection(store).replaceOne(toFilter(query), { ...record }, { upsert });
    }

    async update(store, query, change) {
      const update = toUpdate(change);
      if (!update) return this.#collection(store).countDocuments(toFilter(query));
      const { matchedCount } = await this.#collection(store).updateMany(toFilter(query), update);
      return matchedCount;
    }

    async updateEach(store, changes) {
      if (changes.length === 0) return 0;
      // A change that sets and unsets nothing is no write: its records are counted.
      const writes = [];
      let counted = 0;
      for (const { query, change } of changes) {
        const update = toUpdate(change);
        if (update) {
          writes.push({ updateMany: { filter: toFilter(query), update } });
        } else {
          // eslint-disable-next-line no-await-in-loop
          counted += await this.#collection(store).countDocuments(toFilter(query));
        }
      }
      if (writes.length === 0) return counted;
      const { matchedCount } = await this.#collection(store).bulkWrite(writes, { ordered: true });
      return counted + matchedCount;
    }

    async remove(store, query) {
      const { deletedCount } = await this.#collection(store).deleteMany(toFilter(query));
      return deletedCount;
    }

    async ensureIndexes(store, indexes) {
      await dbHelper.ensureIndexes(
        this.#collection(store),
        indexes.map(({ fields, unique }) => ({
          key: Object.fromEntries(fields.map((field) => [field, 1])),
          ...(unique ? { unique: true } : {}),
        })),
      );
    }
  };
  return Provider;
}

/**
 * A provider over the given stores.
 * @param {Object<string, {database: string, collection: string}>} stores
 * @returns {import('@runonflux/flux-spec-backend').StorageProvider}
 */
function create(stores) {
  const ProviderClass = providerClass();
  return new ProviderClass(stores);
}

module.exports = { create };
