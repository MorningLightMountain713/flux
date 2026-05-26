const log = require('../lib/log');

/**
 * @module Helper module used for all interactions with database
 */

const mongodb = require('mongodb');
const config = require('config');

const serviceHelper = require('./serviceHelper');

const { MongoClient } = mongodb;
const mongoUrl = `mongodb://${config.database.url}:${config.database.port}/`;

/**
 * @type {mongodb.MongoClient}
 */
let openDBConnection = null;

/**
 * Cached MongoDB server version, populated once per connection.
 * @type {string | null}
 */
let mongoDbVersion = null;

/**
 * Returns MongoDB connection, if it was initiated before, otherwise returns null.
 *
 * @returns {mongodb.MongoClient | null}
 */
function databaseConnection() {
  return openDBConnection;
}

/**
 * Initiates connection with the database.
 *
 * @param {string} [url]
 *
 * @returns {Promise<mongodb.MongoClient>}
 */
async function connectMongoDb(url) {
  const connectUrl = url || mongoUrl;
  const mongoSettings = {
    maxPoolSize: 100,
  };
  const client = await MongoClient.connect(connectUrl, mongoSettings);
  return client;
}

/**
 * Initiates default db connection.
 * @returns true
 */
async function initiateDB() {
  if (!openDBConnection) {
    openDBConnection = await connectMongoDb();
    // Read the server version once, on the initial connect. It is informational
    // and the getter swallows its own errors, so this cannot fail the connect.
    await getMongoDbVersion();
  }
  return true;
}

/**
 * Returns the connected MongoDB server version, fetching and caching it on
 * first use. The driver handshake only exposes the wire-protocol version, so
 * the human-readable version is read once via a buildInfo command and reused.
 * The version is informational: on any failure this resolves to null rather
 * than throwing, so a transient read never sinks its callers, and a later
 * call retries.
 *
 * @returns {Promise<string | null>} Server version, or null if unavailable.
 */
async function getMongoDbVersion() {
  if (mongoDbVersion) return mongoDbVersion;
  if (!openDBConnection) return null;
  try {
    const { version } = await openDBConnection.db('admin').command({ buildInfo: 1 });
    mongoDbVersion = version;
  } catch (error) {
    log.warn(`Unable to read MongoDB version: ${error.message}`);
  }
  return mongoDbVersion;
}

/**
 * Waits for MongoDB to become available, retrying indefinitely.
 * Logs on first attempt, then every ~60 seconds.
 * @returns {Promise<void>}
 */
async function waitForMongo() {
  const RETRY_DELAY_MS = 5000;
  const LOG_INTERVAL_MS = 60000;
  let lastLogAt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await initiateDB();
      log.info('MongoDB connected');
      return;
    } catch (error) {
      const now = Date.now();
      if (!lastLogAt || now - lastLogAt >= LOG_INTERVAL_MS) {
        log.info(`Waiting for MongoDB... (${error.message})`);
        lastLogAt = now;
      }
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(RETRY_DELAY_MS);
    }
  }
}

/**
 * Closes DB connection if exists.
 */
async function closeDbConnection() {
  if (openDBConnection) {
    await openDBConnection.close();
    openDBConnection = null;
    mongoDbVersion = null;
  }
}

/**
 * Returns an array of distinct values in a given collection.
 *
 * @param {string} database
 * @param {string} collection
 * @param {string} distinct - field name
 * @param {object} [query]
 *
 * @returns array
 */
async function distinctDatabase(database, collection, distinct, query) {
  const results = await database.collection(collection).distinct(distinct, query);
  return results;
}

/**
 * Returns array of documents from the DB based on the query and the projection.
 *
 * @param {mongodb.Db} database
 * @param {string} collection
 * @param {object} query
 * @param {object} options
 *
 * @returns {Promise<Arrray>}
 */
async function findInDatabase(database, collection, query = {}, options = {}) {
  const results = await database.collection(collection).find(query, options).toArray();
  return results;
}

/**
 * Returns either a db cursor or array of documents based on pipeline aggregate.
 *
 * @param {mongodb.Db} database
 * @param {string} collection
 * @param {Array<Object>} pipeline
 * @param {{returnArray?: boolean}} options
 *
 * @returns {Promise<mongodb.AggregationCursor | Array>}
 */
async function aggregateInDatabase(database, collection, pipeline, options = {}) {
  const returnArray = options.returnArray ?? true;

  const dbCursor = database.collection(collection).aggregate(pipeline);

  const returnValue = returnArray ? await dbCursor.toArray() : dbCursor;

  return returnValue;
}

/**
 * Returns document from the DB based on the query and the projection.
 *
 * @param {mongodb.Db} database
 * @param {string} collection
 * @param {Object} query
 * @param {Object} projection
 * @returns {Object}
 */
async function findOneInDatabase(database, collection, query = {}, projection = {}) {
  const result = await database.collection(collection).findOne(query, projection);
  return result;
}

/**
 * Executes bulkwrite operations on database.
 *
 * @param {string} database
 * @param {string} collection
 * @param {object} operations
 * @returns void
 */
async function bulkWriteInDatabase(database, collection, operations) {
  if (!operations || operations.length === 0) {
    return {
      insertedCount: 0, matchedCount: 0, modifiedCount: 0, deletedCount: 0, upsertedCount: 0,
    };
  }
  const result = await database.collection(collection).bulkWrite(operations);
  return result;
}

/**
 * Updates document from the DB based on the query and update operators and returns it.
 *
 * @param {string} database
 * @param {string} collection
 * @param {object} query
 * @param {object} update - must contain only update operator expressions
 * @param {object} [options] - {
     projection: {document},
     sort: {document},
     maxTimeMS: {number},
     upsert: {boolean},
     returnNewDocument: {string} - 'before' / 'after',
     collation: {document},
     arrayFilters: [ {filterdocument1}, ... ]
   }
 *
 * @returns document
 */
async function findOneAndUpdateInDatabase(database, collection, query, update, options) {
  const passedOptions = options || {};
  const result = await database.collection(collection).findOneAndUpdate(query, update, passedOptions);
  return result;
}

/**
 * Counts document from the DB based on the query
 *
 * @param {string} database
 * @param {string} collection
 * @param {object} query
 *
 * @returns count of documents
 */
async function countInDatabase(database, collection, query) {
  const result = await database.collection(collection).countDocuments(query);
  return result;
}

/**
 * Inserts one document into the database, into a specific collection.
 *
 * @param {string} database
 * @param {string} collection
 * @param {object} value
 *
 * @returns document
 */
async function insertOneToDatabase(database, collection, value) {
  const result = await database.collection(collection).insertOne(value).catch((error) => {
    if (error.message && error.message.includes('duplicate key')) {
      // Log duplicate key errors for debugging instead of silently swallowing them
      // eslint-disable-next-line no-underscore-dangle
      const docIdentifier = value.name || value._id || JSON.stringify(value).slice(0, 100);
      log.error(`Duplicate key error inserting into ${collection}: ${docIdentifier}`);
      log.error(`Full error: ${error.message}`);
      // Still swallow the error to maintain backward compatibility, but now we can see it in logs
      return undefined;
    }
    throw error;
  });
  return result;
}

/**
 * Inserts array of documents into the database.
 *
 * @param {string} database
 * @param {string} collection
 * @param {array} values
 * @param {object} [options]
 *
 * @returns object
 */
async function insertManyToDatabase(database, collection, values, options = {}) {
  const result = await database.collection(collection).insertMany(values, options).catch((error) => {
    if (!(error.message && error.message.includes('duplicate key'))) {
      throw error;
    }
  });
  return result;
}

/**
 * Updates document from the DB based on the query and update operators.
 *
 * @param {string} database
 * @param {string} collection
 * @param {object} query
 * @param {object} update
 * @param {object} [options]
 *
 * @returns object
 */
async function updateOneInDatabase(database, collection, query, update, options) {
  const passedOptions = options || {};
  const result = await database.collection(collection).updateOne(query, update, passedOptions);
  return result;
}

/**
 * Replaces a single document in the collection. Unlike updateOne with $set,
 * replaceOne completely replaces the document (except _id), preventing
 * accumulation of stale fields from prior updates.
 *
 * @param {mongodb.Db} database
 * @param {string} collection
 * @param {object} query
 * @param {object} replacement
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function replaceOneInDatabase(database, collection, query, replacement, options) {
  const passedOptions = options || {};
  const result = await database.collection(collection).replaceOne(query, replacement, passedOptions);
  return result;
}

/**
 * Updates many documents in the collection
 *
 * @param {string} database
 * @param {string} collection
 * @param {object} query
 * @param {object} updateFilter
 *
 * @returns object
 */
async function updateInDatabase(database, collection, query, updateFilter) {
  const result = await database.collection(collection).updateMany(query, updateFilter);
  return result;
}

/**
 * Deletes and returns a document based on query and projection
 *
 * @param {string} database
 * @param {string} collection
 * @param {object} query
 * @param {object} [projection]
 *
 * @returns object
 */
async function findOneAndDeleteInDatabase(database, collection, query, projection) {
  const result = await database.collection(collection).findOneAndDelete(query, projection);
  return result;
}

/**
 * Deletes many documents from the collection.
 * To remove all documents from a collection pass an empty object as a query.
 *
 * @param {string} database
 * @param {string} collection
 * @param {object} query
 *
 * @returns object
 */
async function removeDocumentsFromCollection(database, collection, query) {
  const result = await database.collection(collection).deleteMany(query);
  return result;
}

/**
 * Drops the whole collection.
 *
 * @param {string} database
 * @param {string} collection
 *
 * @returns object
 */
async function dropCollection(database, collection) {
  const result = await database.collection(collection).drop();
  return result;
}

/**
 * Returns collection statistics
 *
 * @param {string} database
 * @param {string} collection
 *
 * @returns object
 */
async function collectionStats(database, collection) {
  try {
    // In MongoDB v4+, use $collStats aggregation instead of .stats()
    const result = await database.collection(collection).aggregate([{ $collStats: { storageStats: {} } }]).toArray();
    if (result[0] && result[0].storageStats) {
      const stats = result[0].storageStats;
      // Add namespace manually for compatibility with old tests
      stats.ns = `${database.databaseName}.${collection}`;
      return stats;
    }
    // Return compatible empty structure for non-existent collections
    return {
      ns: `${database.databaseName}.${collection}`,
      count: 0,
      avgObjSize: undefined,
    };
  } catch (error) {
    // Fallback for older MongoDB versions or if collection doesn't exist
    return {
      ns: `${database.databaseName}.${collection}`,
      count: 0,
      avgObjSize: undefined,
    };
  }
}

// Apps-domain maintenance functions (repairNanInAppsMessagesDb, expireHeightExpr,
// isReindexAppsInformationRequired, syncAppsInformationCollection,
// reindexGlobalAppsInformation, validateAppsInformation, main) moved to
// appDatabase/appsMaintenance.js

module.exports = {
  aggregateInDatabase,
  bulkWriteInDatabase,
  closeDbConnection,
  collectionStats,
  connectMongoDb,
  countInDatabase,
  databaseConnection,
  distinctDatabase,
  dropCollection,
  findInDatabase,
  findOneAndDeleteInDatabase,
  findOneAndUpdateInDatabase,
  findOneInDatabase,
  getMongoDbVersion,
  initiateDB,
  insertManyToDatabase,
  insertOneToDatabase,
  removeDocumentsFromCollection,
  replaceOneInDatabase,
  updateInDatabase,
  updateOneInDatabase,
  waitForMongo,
};
