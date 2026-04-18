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
const log = require('../../lib/log');
const dbHelper = require('../dbHelper');

async function findValueSatNanInAppsMessages() {
  const {
    database: {
      appsglobal: {
        database: dbName, collections: { appsMessages: collectionName },
      },
    },
  } = config;

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
  const {
    database: {
      daemon: {
        database: dbName, collections: { appsHashes: collectionName },
      },
    },
  } = config;

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
  const {
    database: {
      appsglobal: {
        database: dbName, collections: { appsMessages: collectionName },
      },
    },
  } = config;

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
 * Mirrors the JS logic in registryManager.expireGlobalApplications so the
 * count comparison and the rebuild stay consistent.
 *
 * @param {string} heightField mongo field reference, e.g. '$height'
 * @param {string} expireField mongo field reference, e.g. '$expire'
 * @returns {object} mongo aggregation expression
 */
function expireHeightExpr(heightField, expireField) {
  const PON_FORK = config.fluxapps.daemonPONFork;
  const PRE_FORK_DEFAULT_EXPIRE = config.fluxapps.blocksLasting;
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
 * @param {mongodb.Db} appsGlobalDb
 * @param {string} appsMessagesCol mongo collection name
 * @param {string} appsInformationCol mongo collection name
 * @param {number} scannedHeight
 * @returns {Promise<boolean>}
 */
async function isReindexAppsInformationRequired(
  appsGlobalDb,
  appsMessagesCol,
  appsInformationCol,
  scannedHeight,
) {
  const appsMessagesPipeline = [
    { $sort: { 'appSpecifications.name': 1, height: -1 } },
    {
      $group: {
        _id: '$appSpecifications.name',
        maxHeightMsg: { $first: '$$ROOT' },
      },
    },
    {
      $match: {
        $expr: {
          $gt: [
            expireHeightExpr(
              '$maxHeightMsg.height',
              '$maxHeightMsg.appSpecifications.expire',
            ),
            scannedHeight,
          ],
        },
      },
    },
    {
      $count: 'count',
    },
  ];

  const appsInformationPipeline = [
    {
      $set: {
        expireHeight: expireHeightExpr('$height', '$expire'),
      },
    },
    {
      $match: {
        expireHeight: { $gt: scannedHeight },
      },
    },
    {
      $count: 'count',
    },
  ];

  try {
    await appsGlobalDb
      .collection(appsMessagesCol)
      .createIndex(
        {
          'appSpecifications.name': 1,
          height: -1,
        },
        { name: 'sortAppMessagesForGroupBy' },
      );

    const messagesCursor = await dbHelper.aggregateInDatabase(
      appsGlobalDb,
      appsMessagesCol,
      appsMessagesPipeline,
      { returnArray: false },
    );
    const informationCursor = await dbHelper.aggregateInDatabase(
      appsGlobalDb,
      appsInformationCol,
      appsInformationPipeline,
      { returnArray: false },
    );

    const appsFromMessages = await messagesCursor.next();
    const appsFromInformation = await informationCursor.next();

    if (!appsFromMessages) {
      log.warn('No apps from apps messages found, unable to validate apps information');
      return false;
    }

    if (!appsFromInformation) {
      log.info('No apps information apps found, reindexing colleciton');
      return true;
    }

    log.info(
      `Apps reindex validation. Found ${appsFromMessages.count} apps from appsMessages.`
      + ` Found ${appsFromInformation.count} apps from appsInformation`,
    );

    if (appsFromMessages.count !== appsFromInformation.count) {
      return true;
    }

    // Detect ghost flat fields on v4+ specs caused by $set accumulating
    // fields from prior spec versions. Fixed by replaceOne in registryManager.
    const ghostCount = await dbHelper.countInDatabase(appsGlobalDb, appsInformationCol, {
      version: { $gte: 4 },
      repotag: { $exists: true },
    });
    if (ghostCount > 0) {
      log.info(`Found ${ghostCount} v4+ specs with ghost fields from prior versions, reindex required`);
      return true;
    }

    return false;
  } catch (err) {
    log.error(`isReindexAppsInformationRequired - Mongodb Error: ${err}`);
    return false;
  }
}

/**
 * Rebuilds the appsInformation collection from a dbCursor containing the appropriate
 * preformed records.
 * @param {mongodb.AggregationCursor} appsDbCursor
 * @param {mongodb.Db} globalDb
 * @param {mongodb.Db} localDb
 * @param {string} globalAppsInformationCol mongo collection name
 * @param {string} localAppsInformationCol mongo collection name
 * @returns {Promise<Array<string>} Any installed app (by name) that need to be removed
 */
async function syncAppsInformationCollection(
  appsDbCursor,
  globalDb,
  localDb,
  globalAppsInformationCol,
  localAppsInformationCol,
) {
  const installedAppsArray = await dbHelper.findInDatabase(
    localDb,
    localAppsInformationCol,
  );
  const installedApps = new Set(installedAppsArray.map((app) => app.name));

  const insertChunk = async (appInfos) => {
    await dbHelper.insertManyToDatabase(
      globalDb,
      globalAppsInformationCol,
      appInfos,
    );
  };

  const chunkSize = 500;
  const appInfoChunk = [];

  // eslint-disable-next-line no-restricted-syntax
  for await (const appInfo of appsDbCursor) {
    appInfoChunk.push(appInfo);

    if (installedApps.has(appInfo.name)) installedApps.delete(appInfo.name);

    if (appInfoChunk.length >= chunkSize) {
      await insertChunk(appInfoChunk);
      appInfoChunk.length = 0;
    }
  }

  if (appInfoChunk.length) await insertChunk(appInfoChunk);

  return Array.from(installedApps);
}

/**
 * Drops the appsInformation collection and rebuilds it from appsMessages in a
 * single mongo aggregation + chunked bulk inserts. Also clears the install
 * errors collection (1-hour TTL anyway, no useful state to preserve through
 * a full rebuild).
 *
 * Filtering for currently-alive apps happens inside the aggregation via
 * expireHeightExpr (full PON fork rate adjustment), so there is no separate
 * expire pass.
 *
 * @param {mongodb.Db} appsGlobalDb
 * @param {mongodb.Db} appsLocalDb
 * @param {string} globalAppsMessagesCol
 * @param {string} globalAppsInformationCol
 * @param {string} globalAppsInstallingErrorsLocationsCol
 * @param {string} localAppsInformationCol
 * @param {number} scannedHeight
 * @returns {Promise<Array<string>>} installed app names that are no longer in
 *   the live spec set (caller is responsible for removing them locally)
 */
async function reindexGlobalAppsInformation(
  appsGlobalDb,
  appsLocalDb,
  globalAppsMessagesCol,
  globalAppsInformationCol,
  globalAppsInstallingErrorsLocationsCol,
  localAppsInformationCol,
  scannedHeight,
) {
  const dropped = await dbHelper.dropCollection(appsGlobalDb, globalAppsInformationCol)
    .catch((error) => {
      if (error.message !== 'ns not found') {
        log.error('reindexGlobalAppsInformation - Unable to drop db. '
          + `Error: ${error}`);
        return false;
      }
      return true;
    });

  if (!dropped) return [];

  const infoCol = appsGlobalDb.collection(globalAppsInformationCol);
  await infoCol.createIndex(
    { name: 1 },
    { name: 'query for getting zelapp based on zelapp specs name' },
  );
  await infoCol.createIndex(
    { owner: 1 },
    { name: 'query for getting zelapp based on zelapp specs owner' },
  );
  await infoCol.createIndex(
    { repotag: 1 },
    { name: 'query for getting zelapp based on image' },
  );
  await infoCol.createIndex(
    { height: 1 },
    { name: 'query for getting zelapp based on last height update' },
  );
  await infoCol.createIndex(
    { hash: 1 },
    { name: 'query for getting zelapp based on last hash' },
  );

  const pipeline = [
    { $sort: { 'appSpecifications.name': 1, height: -1 } },
    {
      $group: {
        _id: '$appSpecifications.name',
        maxHeightMsg: { $first: '$$ROOT' },
      },
    },
    {
      $match: {
        $expr: {
          $gt: [
            expireHeightExpr(
              '$maxHeightMsg.height',
              '$maxHeightMsg.appSpecifications.expire',
            ),
            scannedHeight,
          ],
        },
      },
    },
    {
      $replaceWith: {
        $mergeObjects: [
          '$maxHeightMsg.appSpecifications',
          {
            hash: '$maxHeightMsg.hash',
            height: '$maxHeightMsg.height',
          },
        ],
      },
    },
  ];

  const resultCursor = await dbHelper.aggregateInDatabase(
    appsGlobalDb,
    globalAppsMessagesCol,
    pipeline,
    { returnArray: false },
  );

  const appsToRemove = await syncAppsInformationCollection(
    resultCursor,
    appsGlobalDb,
    appsLocalDb,
    globalAppsInformationCol,
    localAppsInformationCol,
  );

  // Drop all install errors. Collection has a 1-hour TTL anyway and any
  // surviving errors would be tied to specs that may have just changed.
  await dbHelper.removeDocumentsFromCollection(
    appsGlobalDb,
    globalAppsInstallingErrorsLocationsCol,
    {},
  );

  log.info(
    `Reindexing of global applications finished. Local apps to be removed: ${JSON.stringify(appsToRemove)}`,
  );

  return appsToRemove;
}

/**
 * Verifies the app count based on an aggregation from appsmessages and compares it to the
 * app count in appsinformation. If they differ - the appsinformation collection is dropped and
 * rebuilt from the appsmessages. The entire process takes about 500-700ms.
 * @returns {Promise<{validated: boolean, reindexed: boolean, appsToRemove: Array<string>}>}
 */
async function validateAppsInformation() {
  const response = { validated: false, reindexed: false, appsToRemove: [] };

  const {
    database: {
      appsglobal: {
        database: appsGlobalDbName,
        collections: {
          appsInformation: globalAppsInformationCol,
          appsMessages: globalAppsMessagesCol,
          appsInstallingErrorsLocations: globalAppsInstallingErrorsLocationsCol,
        },
      },
      appslocal: {
        database: appsLocalDbName,
        collections: {
          appsInformation: localAppsInformationCol,
        },
      },
      daemon: {
        database: daemonDbName,
        collections: { scannedHeight: scannedHeightCol },
      },
    },
  } = config;

  const client = dbHelper.databaseConnection();

  if (!client) {
    log.warn('Unable to validate apps information collection, no client');
    return response;
  }

  try {
    const appsGlobalDb = client.db(appsGlobalDbName);
    const appsLocalDb = client.db(appsLocalDbName);
    const daemonDb = client.db(daemonDbName);

    const scannedHeightResult = await dbHelper.findOneInDatabase(
      daemonDb,
      scannedHeightCol,
    );
    const { generalScannedHeight: scannedHeight = null } = scannedHeightResult;

    if (!scannedHeight) return response;

    const reindexRequired = await isReindexAppsInformationRequired(
      appsGlobalDb,
      globalAppsMessagesCol,
      globalAppsInformationCol,
      scannedHeight,
    );

    log.info(`validateAppsInformation reindexRequired: ${reindexRequired}`);

    if (!reindexRequired) {
      response.validated = true;
      return response;
    }

    const appsToRemove = await reindexGlobalAppsInformation(
      appsGlobalDb,
      appsLocalDb,
      globalAppsMessagesCol,
      globalAppsInformationCol,
      globalAppsInstallingErrorsLocationsCol,
      localAppsInformationCol,
      scannedHeight,
    );

    response.reindexed = true;
    response.appsToRemove = appsToRemove;
  } catch (err) {
    log.error(`Unable to validate apps information. Error: ${err}`);
  }
  return response;
}

/**
 *
 * @param {string} command
 * @returns {Promise<void>}
 */
async function main(command) {
  const initiated = await dbHelper.initiateDB().catch(() => false);

  if (!initiated) return;

  if (command === 'validateInfoCol') {
    await validateAppsInformation();
  } else if (command === 'repairMessagesCol') {
    await repairNanInAppsMessagesDb();
  }

  const client = dbHelper.databaseConnection();

  await client.close();
}

if (require.main === module) {
  // eslint-disable-next-line global-require
  const { parseArgs } = require('node:util');

  const { positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
  });

  const validCommands = ['validateInfoCol', 'repairMessagesCol'];
  const command = positionals[0];

  if (!command || !validCommands.includes(command)) {
    console.error(`Error: Invalid command. Expected one of: ${validCommands.join(', ')}`);
    process.exit(1);
  }

  main(command);
}

module.exports = {
  expireHeightExpr,
  reindexGlobalAppsInformation,
  repairNanInAppsMessagesDb,
  validateAppsInformation,
};
