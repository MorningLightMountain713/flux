'use strict';

const log = require('../lib/log');

/**
 * @module Helper module used for all interactions with database
 */

const mongodb = require('mongodb');
const config = require('config');

const serviceHelper = require('./serviceHelper');

const { MongoClient } = mongodb;
const mongoUrl = `mongodb://${config.get('database.url')}:${config.get('database.port')}/`;

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
  const LOG_INTERVAL_MS = 60_000;
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
 * Remove rows that duplicate a would-be-unique key, keeping the newest of each.
 *
 * A recovery strategy for ensureIndex: when a unique build fails because the
 * collection already holds rows that violate it, this makes the data conform to
 * the invariant the index DECLARES - it deletes duplicates on the key the index
 * says must be unique, which is enforcing a contract rather than losing data.
 * Only safe where the key IS the row's identity, so it is passed in per build by
 * the caller that knows the collection, never applied by default. A rollup whose
 * duplicates must be summed rather than dropped (the tampering incident count)
 * belongs to its owning service instead - see the note on ensureIndex.
 *
 * Keeps the newest per group (rows sort by _id, which is time-ordered), honours
 * the index's partialFilterExpression so it only touches rows the index covers,
 * and returns how many it removed.
 *
 * @param {object} collection - a mongo collection handle
 * @param {object} spec - the index key, e.g. { hash: 1 }
 * @param {object} options - the index options (read for partialFilterExpression)
 * @returns {Promise<number>} rows removed
 */
async function dedupeByKey(collection, spec, options = {}) {
  const groupId = {};
  Object.keys(spec).forEach((key, i) => { groupId[`k${i}`] = `$${key}`; });
  // Held in memory deliberately, and measured rather than assumed: run against a
  // live node's collection unioned with itself until every key appeared 16 times
  // - 1,030,208 rows, the duplicate state this exists to repair - it finished in
  // under 2s without spilling. The $sort adds nothing on top while it stays an
  // index walk on _id, which it is for a spec with no partialFilterExpression;
  // the first partial index to use this wants re-measuring, because the $match
  // ahead of the sort is what would make the sort blocking. allowDiskUse is not
  // set: it would take a mongo below 6.0, where the cap errors instead of
  // spilling, and the network floor is moving past that.
  //
  // ids[0] rather than $max: $group does not document that it carries a
  // preceding sort into an accumulator, and that non-guarantee is about results
  // merged from several sources - this is one standalone mongod. Checked against
  // 64,388 real duplicate groups, ids[0] was the newest in all 64,388.
  const pipeline = [
    ...(options.partialFilterExpression ? [{ $match: options.partialFilterExpression }] : []),
    { $sort: { _id: -1 } },
    { $group: { _id: groupId, ids: { $push: '$_id' } } },
    { $match: { 'ids.1': { $exists: true } } },
  ];
  const groups = await collection.aggregate(pipeline).toArray();
  const toRemove = groups.flatMap((group) => group.ids.slice(1));
  if (!toRemove.length) return 0;
  await collection.deleteMany({ _id: { $in: toRemove } });
  return toRemove.length;
}

/**
 * Assert one index, healing the failures that are recoverable.
 *
 *   - a pre-existing index with conflicting OPTIONS (IndexOptionsConflict /
 *     IndexKeySpecsConflict) is dropped by its real name and recreated;
 *   - a unique build blocked by DUPLICATE ROWS runs the caller's `recover`
 *     strategy (see dedupeByKey) and rebuilds, so the node ends up WITH the
 *     index rather than running degraded without it;
 *   - anything else rethrows.
 *
 * The rethrow is deliberate and is NOT the blanket swallow it replaced. Index
 * setup runs before any service or interval starts, so the 15s startFluxFunctions
 * retry re-runs it safely: a TRANSIENT failure (mongo mid-election, a slow-disk
 * blip) heals on the next pass instead of being skipped until the next reboot,
 * and a genuinely UNRECOVERABLE database wedges loudly - which is correct, since
 * a node whose DB cannot hold its schema cannot serve apps and appremove would
 * not rescue it. The realistic wedge that finding motivated - a unique index
 * over rows that already violate it - is repaired above, not hidden.
 *
 * TRUE NORTH: eventually every collection owns its own schema-prepare - its
 * index spec plus whatever dedupe or merge its data needs - the way
 * appsRuntimeState.prepareCollection and appTamperingDetectionService already
 * do, and boot just invokes those prepare functions. That turns this ~40-call
 * imperative block into a set of owned, individually testable units. This
 * function is the increment toward it, not the destination; a full move of the
 * remaining builds is a separate refactor, out of scope for the PR that added it.
 *
 * @param {object} collection - a mongo collection handle
 * @param {object} spec - the index key
 * @param {object} [options] - the index options
 * @param {(collection: object, spec: object, options: object) => Promise<number>} [recover]
 *   run when a unique build is blocked by existing duplicate rows
 */
async function ensureIndex(collection, spec, options = {}, recover = null) {
  try {
    await collection.createIndex(spec, options);
  } catch (err) {
    const conflict = err && (err.codeName === 'IndexOptionsConflict' || err.codeName === 'IndexKeySpecsConflict');
    if (conflict) {
      const specKeys = JSON.stringify(spec);
      const indexes = await collection.listIndexes().toArray();
      const match = indexes.find((idx) => JSON.stringify(idx.key) === specKeys);
      if (match?.name) {
        log.warn(`ensureIndex - conflicting index '${match.name}' on ${collection.collectionName} (key: ${specKeys}), dropping and recreating`);
        await collection.dropIndex(match.name);
      }
      await collection.createIndex(spec, options);
      return;
    }
    const duplicate = err && (err.code === 11_000 || err.codeName === 'DuplicateKey');
    if (duplicate && recover) {
      const removed = await recover(collection, spec, options);
      log.warn(`ensureIndex - ${collection.collectionName} (key: ${JSON.stringify(spec)}) held ${removed} row(s) violating a unique index; removed and rebuilding`);
      await collection.createIndex(spec, options);
      return;
    }
    throw err;
  }
}

/**
 * Assert every index one collection needs, in a single command.
 *
 * mongo's index build protocol has a fixed cost per BUILD - register, start,
 * scan, wait for commit quorum, commit, log - and it does not care that the
 * collection is empty. A node asserting its schema one index at a time pays
 * that cost 34 times over 14 collections; createIndexes pays it once per
 * collection. A node boots faster for it, and the integration harness, where
 * ten nodes share one mongod and every database is new, feels it ten times over
 * (measured: 938 concurrent builds per ten-node fleet).
 *
 * The batch is the fast path, not the only one. ensureIndex heals two failures
 * that need to be attributed to a single index - an options conflict it drops
 * and rebuilds, and a unique build blocked by duplicate rows it repairs through
 * the caller's strategy - and a batch rejection does not say which member
 * failed. So any error falls back to asserting them one at a time, which is
 * exactly the behaviour that existed before this function.
 *
 * @param {object} collection - a mongo collection handle
 * @param {Array<object>} specs - `{ key, ...indexOptions, recover }` per index,
 *   where `recover` is ours and never reaches mongo
 */
async function ensureIndexes(collection, specs) {
  try {
    await collection.createIndexes(specs.map((spec) => {
      // `recover` is a FluxOS concern; mongo is handed the index model alone
      const model = { ...spec };
      delete model.recover;
      return model;
    }));
    return;
  } catch (error) {
    log.warn(`ensureIndexes - batch of ${specs.length} on ${collection.collectionName} failed (${error.codeName || error.message}); asserting one at a time`);
  }
  // eslint-disable-next-line no-restricted-syntax
  for (const { key, recover = null, ...options } of specs) {
    // eslint-disable-next-line no-await-in-loop
    await ensureIndex(collection, key, options, recover);
  }
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
  dedupeByKey,
  ensureIndex,
  ensureIndexes,
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
