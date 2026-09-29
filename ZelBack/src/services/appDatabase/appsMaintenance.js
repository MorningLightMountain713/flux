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
 * Returns an aggregation expression that computes the actual expiration block
 * for a given (height, expire) pair, applying the PON fork rate adjustment.
 *
 * Pre-fork the chain runs at 1x. Post-fork (height >= daemonPONFork) it runs
 * 4x faster. Apps registered before the fork whose original expiration straddles
 * the fork have their post-fork tail multiplied by 4 so they get the same
 * wall-clock lifetime they paid for.
 *
 * Mirrors the spec-side isExpired logic (consumed by the specReconciler's
 * expiry rung and appJanitor's registry-expiry sweep) so the count comparison
 * and the rebuild stay consistent.
 *
 * @param {string} heightField mongo field reference, e.g. '$height'
 * @param {string} expireField mongo field reference, e.g. '$expire'
 * @returns {object} mongo aggregation expression
 */
function expireHeightExpr(heightField, expireField) {
  const PON_FORK = config.get('fluxapps.daemonPONFork');
  const PRE_FORK_DEFAULT_EXPIRE = config.get('fluxapps.blocksLasting');
  const POST_FORK_DEFAULT_EXPIRE = PRE_FORK_DEFAULT_EXPIRE * 4;

  return {
    $let: {
      vars: {
        h: heightField,
        e: {
          $ifNull: [
            expireField,
            {
              $cond: {
                if: { $gte: [heightField, PON_FORK] },
                then: POST_FORK_DEFAULT_EXPIRE,
                else: PRE_FORK_DEFAULT_EXPIRE,
              },
            },
          ],
        },
      },
      in: {
        $cond: {
          if: { $gte: ['$$h', PON_FORK] },
          // post-fork registration: straightforward
          then: { $add: ['$$h', '$$e'] },
          // pre-fork registration: if expiration crosses the fork, multiply
          // the post-fork tail by 4 to preserve wall-clock lifetime
          else: {
            $cond: {
              if: { $gt: [{ $add: ['$$h', '$$e'] }, PON_FORK] },
              then: {
                $add: [
                  PON_FORK,
                  {
                    $multiply: [
                      { $subtract: [{ $add: ['$$h', '$$e'] }, PON_FORK] },
                      4,
                    ],
                  },
                ],
              },
              else: { $add: ['$$h', '$$e'] },
            },
          },
        },
      },
    },
  };
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
  expireHeightExpr,
  repairNanInAppsMessagesDb,
};
