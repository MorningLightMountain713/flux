'use strict';

/**
 * Apps-domain maintenance operations. These are the heavy, schema-aware
 * tasks that used to live in dbHelper.js — reindex, validate, repair —
 * split out so dbHelper.js stays a generic mongo wrapper.
 *
 * Everything here knows the shape of the apps collections (appsMessages,
 * appsInformation, appsHashes, etc.) and encodes operational policy
 * (PON fork rate adjustment, ghost-field detection, valueSat NaN repair).
 * Generic find/insert/update primitives stay in dbHelper.
 */

const config = require('config');
const dbHelper = require('../dbHelper');
const { parseArgs } = require('node:util');

async function findValueSatNanInAppsMessages() {
  const dbName = config.get('database.appsglobal.database');
  const collectionName = config.get('database.appsglobal.collections.appsMessages');

  const client = dbHelper.databaseConnection();
  const db = client.db(dbName);
  const query = { valueSat: NaN };
  const options = { projection: { _id: 0, hash: 1 } };

  const result = await dbHelper.findInDatabase(db, collectionName, query, options);

  // ToDo: Fix the db helper so this is configurable
  const brokenMessageHashes = result.map((item) => item.hash);

  return brokenMessageHashes;
}

async function findValueSatInAppsHashes() {
  const dbName = config.get('database.daemon.database');
  const collectionName = config.get('database.daemon.collections.appsHashes');

  const client = dbHelper.databaseConnection();
  const db = client.db(dbName);
  const query = {};
  const options = { projection: { _id: 0, hash: 1, value: 1 } };

  const results = await dbHelper.findInDatabase(db, collectionName, query, options);

  const hashToValueMap = new Map();

  results.forEach((result) => {
    hashToValueMap.set(result.hash, result.value);
  });

  return hashToValueMap;
}

async function updateValueSatInAppsMessages(brokenHashes, hashMap) {
  const dbName = config.get('database.appsglobal.database');
  const collectionName = config.get('database.appsglobal.collections.appsMessages');

  const client = dbHelper.databaseConnection();
  const db = client.db(dbName);

  const updateChunk = async (hashes) => {
    const operations = [];

    hashes.forEach((hash) => {
      const valueSat = hashMap.get(hash);

      if (valueSat) {
        const operation = {
          updateOne: {
            filter: { hash },
            update: { $set: { valueSat } },
            upsert: true,
          },
        };

        operations.push(operation);
      }
    });

    await dbHelper.bulkWriteInDatabase(db, collectionName, operations);
  };

  const hashCount = brokenHashes.length;
  const chunkSize = 5000;
  let startIndex = 0;
  let endIndex = Math.min(chunkSize, hashCount);

  while (startIndex < hashCount) {
    const chunk = brokenHashes.slice(startIndex, endIndex);
    // eslint-disable-next-line no-await-in-loop
    await updateChunk(chunk);

    startIndex = endIndex;
    endIndex += chunk.length;
  }
}

async function repairNanInAppsMessagesDb() {
  const brokenHashes = await findValueSatNanInAppsMessages();

  if (!brokenHashes.length) return;

  const hashMap = await findValueSatInAppsHashes();

  await updateValueSatInAppsMessages(brokenHashes, hashMap);
}

/**
 *
 * @param {string} command
 * @returns {Promise<void>}
 */
async function main(command) {
  const initiated = await dbHelper.initiateDB().catch(() => false);

  if (!initiated) return;

  if (command === 'repairMessagesCol') {
    await repairNanInAppsMessagesDb();
  }

  const client = dbHelper.databaseConnection();

  await client.close();
}

if (require.main === module) {
  const { positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
  });

  const validCommands = ['repairMessagesCol'];
  const command = positionals[0];

  if (!command || !validCommands.includes(command)) {
    console.error(`Error: Invalid command. Expected one of: ${validCommands.join(', ')}`);
    process.exit(1);
  }

  main(command);
}

module.exports = {
  repairNanInAppsMessagesDb,
};
