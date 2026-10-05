'use strict';

const dbHelper = require('../dbHelper');
const specLibrary = require('../utils/specLibrary');

/**
 * flux-spec's StorageProvider over this node's MongoDB. Each logical store is a
 * collection of one of the node's databases, every query in the port's language
 * is one Mongo filter, and a record is returned without the document id.
 *
 * The port compares an absent field with nothing: `{ f: null }` holds only for
 * a field present and null, `{ f: { ne: null } }` for a field absent or not
 * null, `{ f: { in: [null, ...] } }` for one present and listed. Mongo reads an
 * absent field as null in each of those, so they are translated to filters that
 * answer as the port does. A path through an array of objects is not a port
 * query: the port reads no further than the array.
 */

const OPERATORS = new Set(['in', 'ne', 'exists', 'gt', 'gte', 'lt', 'lte']);

const PRESENT_AND_NULL = { $type: 'null' };

// A filter no stored document satisfies: every stored document has an id.
const NOTHING = { _id: { $exists: false } };

function isOperatorObject(condition) {
  if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) return false;
  const keys = Object.keys(condition);
  const operators = keys.filter((key) => OPERATORS.has(key));
  if (operators.length && operators.length !== keys.length) {
    throw new Error(`MongoStorageProvider: a condition mixes operators with ${keys.filter((k) => !OPERATORS.has(k)).join(', ')}`);
  }
  return operators.length > 0;
}

function clausesFor(field, condition) {
  if (!isOperatorObject(condition)) {
    return [{ [field]: condition === null ? PRESENT_AND_NULL : condition }];
  }
  return Object.entries(condition).map(([op, operand]) => {
    switch (op) {
      case 'in': {
        const values = operand.filter((value) => value !== null);
        if (values.length === operand.length) return { [field]: { $in: values } };
        return { $or: [{ [field]: { $in: values } }, { [field]: PRESENT_AND_NULL }] };
      }
      case 'ne':
        return { [field]: operand === null ? { $not: PRESENT_AND_NULL } : { $ne: operand } };
      case 'exists':
        return { [field]: { $exists: operand } };
      default:
        return { [field]: { [`$${op}`]: operand } };
    }
  });
}

/**
 * The Mongo filter a port query states.
 * @param {Object} [query]
 * @returns {Object}
 */
function toFilter(query = {}) {
  const clauses = [];
  for (const [field, condition] of Object.entries(query)) {
    if (field === 'or') clauses.push(condition.length ? { $or: condition.map(toFilter) } : NOTHING);
    else clauses.push(...clausesFor(field, condition));
  }
  if (clauses.length === 0) return {};
  if (clauses.length === 1) return clauses[0];
  return { $and: clauses };
}

function projectionFor(fields) {
  const projection = { _id: 0 };
  if (fields) for (const field of fields) projection[field] = 1;
  return projection;
}

let Provider = null;

function providerClass() {
  if (Provider) return Provider;
  const { StorageProvider } = specLibrary.loaded();

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

    async update(store, query, { set = {}, unset = [] }) {
      const change = {};
      if (Object.keys(set).length) change.$set = set;
      if (unset.length) change.$unset = Object.fromEntries(unset.map((field) => [field, '']));
      if (!Object.keys(change).length) return;
      await this.#collection(store).updateMany(toFilter(query), change);
    }

    async remove(store, query) {
      await this.#collection(store).deleteMany(toFilter(query));
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

module.exports = { create, toFilter };
