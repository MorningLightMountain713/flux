'use strict';

const config = require('config');

const log = require('../../lib/log');
const dbHelper = require('../dbHelper');

// Collections no version of FluxOS reads any more.
const RETIRED_COLLECTIONS = [
  { database: 'database.local.database', name: 'activepaymentrequests' },
  { database: 'database.local.database', name: 'completedpayments' },
  { database: 'database.appsglobal.database', name: 'zelappslocation' },
];

// Expiry indexes replaced by an `expireAt` expiry. Matched by name AND expiry,
// because a plain index of the same name is part of the current schema.
const RETIRED_EXPIRY_INDEXES = [
  { collection: 'database.appsglobal.collections.appsInstallingErrorsLocations', name: 'cachedAt_1' },
  { collection: 'database.appsglobal.collections.appsInstallingErrorsLocations', name: 'broadcastedAt_1' },
  { collection: 'database.appsglobal.collections.appsInstallingErrorsBroadcasts', name: 'broadcastedAt_1' },
];

/**
 * Drops the retired collections and expiry indexes this node still holds. Reads
 * first and drops only what exists, so a node that has none does no schema work.
 * @returns {Promise<{collections: string[], indexes: string[]}>} what it dropped
 */
async function dropRetiredSchema() {
  const connection = dbHelper.databaseConnection();
  const dropped = { collections: [], indexes: [] };

  for (const { database, name } of RETIRED_COLLECTIONS) {
    const db = connection.db(config.get(database));
    // eslint-disable-next-line no-await-in-loop
    const present = await db.listCollections({ name }, { nameOnly: true }).toArray();
    if (present.length) {
      // eslint-disable-next-line no-await-in-loop
      await db.collection(name).drop();
      dropped.collections.push(name);
    }
  }

  const appsGlobal = connection.db(config.get('database.appsglobal.database'));
  for (const { collection, name } of RETIRED_EXPIRY_INDEXES) {
    const target = appsGlobal.collection(config.get(collection));
    // eslint-disable-next-line no-await-in-loop
    const indexes = await target.indexes().catch((error) => {
      if (error.codeName === 'NamespaceNotFound') return [];
      throw error;
    });
    const retired = indexes.find((index) => index.name === name && index.expireAfterSeconds !== undefined);
    if (retired) {
      // eslint-disable-next-line no-await-in-loop
      await target.dropIndex(name);
      dropped.indexes.push(`${target.collectionName}.${name}`);
    }
  }

  if (dropped.collections.length || dropped.indexes.length) {
    log.info(`migrations - retired schema dropped: collections [${dropped.collections.join(', ')}], indexes [${dropped.indexes.join(', ')}]`);
  }
  return dropped;
}

module.exports = { dropRetiredSchema };
