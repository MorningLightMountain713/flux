const config = require('config');
const dbHelper = require('../dbHelper');
const log = require('../../lib/log');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const benchmarkService = require('../benchmarkService');
const appsRepository = require('../appDatabase/appsRepository');
const appEventVerifier = require('./appEventVerifier');
const registryManager = require('../appDatabase/registryManager');
const { getSpec, validateGossipSpec } = require('../utils/specLibs');
const { getPreviousSpec } = require('../appDatabase/appSpecHistory');
const globalState = require('../utils/globalState');
const {
  globalAppsMessages,
  globalAppsTempMessages,
  globalAppsLocations,
  globalAppsInstallingLocations,
  globalAppsInstallingErrorsLocations,
  globalAppsInstallingErrorsBroadcasts,
  globalAppStateEvents,
  appsHashesCollection,
} = require('../utils/appConstants');
const appsInstallingBroadcasts = config.database.appsglobal.collections.appsInstallingBroadcasts;
const { appSyncEvents, EVENTS: SYNC_EVENTS } = require('../utils/appSyncEvents');

const {
  GOSSIP_VALIDITY_MS,
  RUNNING_EXPIRY_MS,
  INSTALLING_EXPIRY_MS,
  INSTALLING_ERRORS_EXPIRY_MS,
  EVICTED_EXPIRY_MS,
} = require('../utils/appConstants');

const APP_STATE_EVENT_TYPES = Object.freeze({
  APPRUNNING: 'apprunning',
  SIGTERM: 'sigterm',
  APPREMOVED: 'appremoved',
  EVICTED: 'evicted',
  IPCHANGED: 'ipchanged',
});

function buildConditionalUpsert(broadcastedAt, conditionalFields, options = {}) {
  const alwaysSetFields = options.alwaysSetFields ?? {};
  const incomingDate = new Date(broadcastedAt);
  const isNewer = { $gt: [incomingDate, { $ifNull: ['$broadcastedAt', new Date(0)] }] };
  const set = Object.fromEntries(
    Object.entries(conditionalFields).map(([k, v]) => [k, { $cond: [isNewer, v, { $ifNull: [`$${k}`, v] }] }]),
  );
  Object.assign(set, alwaysSetFields);
  return [{ $set: set }];
}

async function getPreviousOwner(appName, currentOwner) {
  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.appsglobal.database);
  const doc = await database.collection(globalAppsMessages)
    .findOne(
      { 'appSpecifications.name': appName, 'appSpecifications.owner': { $ne: currentOwner } },
      { projection: { _id: 0, 'appSpecifications.owner': 1 }, sort: { height: -1 } },
    );
  return doc?.appSpecifications?.owner ?? null;
}

/**
 * Store temporary app message
 * @param {object} message - Message to store
 * @param {object} [options] - Options
 * @param {boolean} [options.furtherVerification=true] - Whether further verification is needed
 * @returns {Promise<boolean|Error>} Whether message should be rebroadcast or Error if invalid
 */
async function storeAppTemporaryMessage(message, options = {}) {
  const furtherVerification = options.furtherVerification ?? true;

  if (!message || typeof message !== 'object' || typeof message.type !== 'string' || typeof message.version !== 'number' || typeof message.signature !== 'string' || typeof message.timestamp !== 'number' || typeof message.hash !== 'string') {
    return new Error('Invalid Flux App message for storing');
  }
  if (typeof message.appSpecifications !== 'object' && typeof message.zelAppSpecifications !== 'object') {
    return new Error('Invalid Flux App message for storing');
  }

  let appEvent;
  try {
    appEvent = await appEventVerifier.deserializeTempMessage(message);
  } catch (err) {
    return new Error(`Invalid Flux App message: ${err.message}`);
  }

  const appMessage = await appsRepository.getPermanentMessage(appEvent.hash);
  if (appMessage) {
    return false;
  }
  const tempMessage = await appsRepository.getTempMessage(appEvent.hash);
  if (tempMessage && typeof tempMessage === 'object' && !Array.isArray(tempMessage)) {
    return false;
  }

  let isAppRequested = false;
  const db = dbHelper.databaseConnection();
  const query = { hash: appEvent.hash };
  const projection = {
    projection: {
      _id: 0,
      message: 1,
      height: 1,
      txid: 1,
      value: 1,
    },
  };
  let database = db.db(config.database.daemon.database);
  const result = await dbHelper.findOneInDatabase(database, appsHashesCollection, query, projection);
  const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
  const daemonHeight = syncStatus.data.height;
  let block = daemonHeight;
  if (result && !result.message) {
    isAppRequested = true;
    block = result.height;
    appSyncEvents.emit(SYNC_EVENTS.HASH_RESPONSE_RECEIVED, appEvent.hash);
  }

  if (furtherVerification) {
    // A v9 encrypted spec must carry a valid arcane attestation (an Arcane
    // node's signed receipt that a genuine SAS validated it), verified locally
    // against the hardcoded network key so non-Arcane nodes reject too. Drop
    // (do not relay) on a missing/invalid attestation.
    //
    // v9 only. v8 encrypted apps are intentionally never gated: they predate
    // attestation and aren't born attested, so rejecting would partition legacy
    // apps off the network — v8 stays accepted as-is, being phased out.
    if (appEvent.version === 2 && appEvent.isEncrypted && !appEventVerifier.verifyAttestation(appEvent)) {
      return new Error('Invalid or missing arcane attestation on encrypted Flux App message');
    }

    let validationBlob;
    if (appEvent.isEncrypted) {
      if (await benchmarkService.isSystemSecure()) {
        const provider = await appEvent.spec.createProvider();
        const decrypted = await appEvent.spec.decrypt(provider);
        validationBlob = decrypted.spec.serialize();
      }
    } else {
      validationBlob = message.appSpecifications || message.zelAppSpecifications;
    }

    if (validationBlob) {
      await validateGossipSpec(validationBlob, { height: block });
    }

    let previousSpec = null;
    if (!appEvent.isRegistration) {
      previousSpec = await getPreviousSpec(appEvent.spec, appEvent.timestamp);
      if (!previousSpec) {
        log.info(`Queueing update for ${appEvent.spec.name} - registration not yet stored`);
        globalState.queuePendingUpdate(appEvent.spec.name, message, block);
        return false;
      }
    }

    if (validationBlob) {
      if (appEvent.isRegistration) {
        await registryManager.checkApplicationRegistrationNameConflicts(appEvent.spec, appEvent.hash);
      } else if (previousSpec) {
        const { UpdatePolicy } = await getSpec();
        UpdatePolicy.assertCompatible(previousSpec, appEvent.spec);
      }
    }

    await appEventVerifier.authorize({
      appEvent,
      previousSpec,
      daemonHeight: block,
    });
  }

  const receivedAt = Date.now();
  const validTill = receivedAt + (60 * 60 * 1000);

  const serialized = appEvent.serialize();
  const value = {
    type: serialized.type,
    version: serialized.version,
    appSpecifications: serialized.appSpecifications,
    hash: serialized.hash,
    timestamp: serialized.timestamp,
    signature: serialized.signature,
    receivedAt: new Date(receivedAt),
    expireAt: new Date(validTill),
    arcaneAttestation: serialized.arcaneAttestation,
  };
  if (serialized.contentHash !== undefined) {
    value.contentHash = serialized.contentHash;
    value.extend = serialized.extend;
  }

  database = db.db(config.database.appsglobal.database);
  await dbHelper.insertOneToDatabase(database, globalAppsTempMessages, value).catch((error) => {
    log.error(error);
    throw error;
  });
  if (isAppRequested) {
    const promotion = (result && result.txid && result.height)
      ? { hash: appEvent.hash, txid: result.txid, height: result.height, value: result.value }
      : null;
    return { rebroadcast: false, promotion };
  }
  return { rebroadcast: true };
}

/**
 * Store permanent app message
 * @param {object} message - Message to store
 * @returns {Promise<boolean>} Whether message was stored successfully
 */
async function storeAppPermanentMessage(message) {
  /* message object
  * @param type string
  * @param version number
  * @param appSpecifications object
  * @param hash string
  * @param timestamp number
  * @param signature string
  * @param txid string
  * @param height number
  * @param valueSat number
  */
  if (!message || !message.appSpecifications || typeof message !== 'object' || typeof message.type !== 'string' || typeof message.version !== 'number' || typeof message.appSpecifications !== 'object' || typeof message.signature !== 'string'
    || typeof message.timestamp !== 'number' || typeof message.hash !== 'string' || typeof message.txid !== 'string' || typeof message.height !== 'number' || typeof message.valueSat !== 'number') {
    throw new Error('Invalid Flux App message for storing');
  }

  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.appsglobal.database);
  await dbHelper.insertOneToDatabase(database, globalAppsMessages, message).catch((error) => {
    log.error(error);
    throw error;
  });
  return true;
}

/**
 * Store app running message
 * @param {object} message - Message to store
 * @returns {Promise<boolean|Error>} Whether message should be rebroadcast or Error if invalid
 */
async function storeAppRunningMessage(message) {
  /* message object
  * @param type string
  * @param version number
  * @param hash string
  * @param broadcastedAt number
  * @param name string
  * @param ip string
  * @param osUptime number (optional)
  * @param staticIp string (optional)
  * @param runningSince number (optional)
  * @param apps array (for version 2)
  */
  const appsMessages = [];
  if (!message || typeof message !== 'object' || typeof message.type !== 'string' || typeof message.version !== 'number'
    || typeof message.broadcastedAt !== 'number' || typeof message.ip !== 'string') {
    return new Error('Invalid Flux App Running message for storing');
  }

  if (message.version !== 1 && message.version !== 2) {
    return new Error(`Invalid Flux App Running message for storing version ${message.version} not supported`);
  }

  if (message.version === 1) {
    if (typeof message.hash !== 'string' || typeof message.name !== 'string') {
      return new Error('Invalid Flux App Running message for storing');
    }
    const app = {
      name: message.name,
      hash: message.hash,
    };
    appsMessages.push(app);
  }

  if (message.version === 2) {
    if (!message.apps || !Array.isArray(message.apps)) {
      return new Error('Invalid Flux App Running message for storing');
    }
    if (message.apps.length > config.fluxapps.maxAppsPerNode) {
      return new Error('Invalid Flux App Running message: apps array exceeds maxAppsPerNode');
    }
    for (let i = 0; i < message.apps.length; i += 1) {
      const app = message.apps[i];
      appsMessages.push(app);
      if (typeof app.hash !== 'string' || typeof app.name !== 'string') {
        return new Error('Invalid Flux App Running v2 message for storing');
      }
    }
  }

  if (message.broadcastedAt + GOSSIP_VALIDITY_MS < Date.now()) {
    log.warn(`Rejecting old/not valid Fluxapprunning message, message:${JSON.stringify(message)}`);
    return { stored: false, rebroadcast: false };
  }

  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.appsglobal.database);
  const expireAt = new Date(message.broadcastedAt + RUNNING_EXPIRY_MS);

  let anyStored = false;
  const incomingDate = new Date(message.broadcastedAt);
  const isNewer = { $gt: [incomingDate, { $ifNull: ['$broadcastedAt', new Date(0)] }] };

  for (let i = 0; i < appsMessages.length; i += 1) {
    const app = appsMessages[i];
    const runningSince = new Date(message.runningSince ?? app.runningSince ?? message.broadcastedAt);
    const incoming = {
      name: app.name,
      hash: app.hash,
      ip: message.ip,
      broadcastedAt: incomingDate,
      expireAt,
      osUptime: message.osUptime,
      staticIp: message.staticIp,
      runningSince,
    };
    const conditionalSet = Object.fromEntries(
      Object.entries(incoming).map(([k, v]) => [k, { $cond: [isNewer, v, { $ifNull: [`$${k}`, v] }] }]),
    );

    // eslint-disable-next-line no-await-in-loop
    const result = await dbHelper.updateOneInDatabase(
      database, globalAppsLocations,
      { name: app.name, ip: message.ip },
      [{ $set: conditionalSet }],
      { upsert: true },
    );
    if (result.modifiedCount > 0 || result.upsertedCount > 0) {
      anyStored = true;
    }
  }

  if (message.version === 2 && appsMessages.length === 0) {
    const result = await dbHelper.findInDatabase(database, globalAppsLocations, { ip: message.ip }, { projection: { _id: 0, runningSince: 1 } });
    if (result.length > 0) {
      const broadcastDate = new Date(message.broadcastedAt);
      const olderThanBroadcast = { ip: message.ip, broadcastedAt: { $lte: broadcastDate } };
      await dbHelper.removeDocumentsFromCollection(database, globalAppsLocations, olderThanBroadcast);
      await dbHelper.removeDocumentsFromCollection(database, globalAppsInstallingLocations, { ip: message.ip });
      await dbHelper.removeDocumentsFromCollection(database, appsInstallingBroadcasts, { 'data.ip': message.ip });
      anyStored = true;
    } else {
      return { stored: false, rebroadcast: false };
    }
  }

  for (const app of appsMessages) {
    const queryFind = { name: app.name, ip: message.ip };
    // eslint-disable-next-line no-await-in-loop
    await dbHelper.removeDocumentsFromCollection(database, globalAppsInstallingLocations, queryFind);
    // eslint-disable-next-line no-await-in-loop
    await dbHelper.removeDocumentsFromCollection(database, appsInstallingBroadcasts, { 'data.name': app.name, 'data.ip': message.ip });
  }

  return { stored: anyStored, rebroadcast: anyStored };
}

/**
 * Store app installing message
 * @param {object} message - Message to store
 * @returns {Promise<boolean|Error>} Whether message should be rebroadcast or Error if invalid
 */
async function storeAppInstallingMessage(message) {
  /* message object
  * @param type string
  * @param version number
  * @param broadcastedAt number
  * @param name string
  * @param ip string
  */
  if (!message || typeof message !== 'object' || typeof message.type !== 'string' || typeof message.version !== 'number'
    || typeof message.broadcastedAt !== 'number' || typeof message.ip !== 'string' || typeof message.name !== 'string') {
    return new Error('Invalid Flux App Installing message for storing');
  }

  if (message.version !== 1) {
    return new Error(`Invalid Flux App Installing message for storing version ${message.version} not supported`);
  }

  if (message.broadcastedAt + GOSSIP_VALIDITY_MS < Date.now()) {
    log.warn(`Rejecting old/not valid fluxappinstalling message, message:${JSON.stringify(message)}`);
    return false;
  }

  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.appsglobal.database);

  const newAppInstallingMessage = {
    name: message.name,
    ip: message.ip,
    broadcastedAt: new Date(message.broadcastedAt),
    expireAt: new Date(message.broadcastedAt + INSTALLING_EXPIRY_MS),
  };

  // indexes over name, hash, ip. Then name + ip and name + ip + broadcastedAt.
  const queryFind = { name: newAppInstallingMessage.name, ip: newAppInstallingMessage.ip };
  const projection = { _id: 0 };
  // we already have the exact same data
  // eslint-disable-next-line no-await-in-loop
  const result = await dbHelper.findOneInDatabase(database, globalAppsInstallingLocations, queryFind, projection);
  if (result && result.broadcastedAt && result.broadcastedAt >= newAppInstallingMessage.broadcastedAt) {
    // found a message that was already stored/probably from duplicated message processsed
    return false;
  }

  const queryUpdate = { name: newAppInstallingMessage.name, ip: newAppInstallingMessage.ip };
  const update = { $set: newAppInstallingMessage };
  const options = {
    upsert: true,
  };
  // eslint-disable-next-line no-await-in-loop
  await dbHelper.updateOneInDatabase(database, globalAppsInstallingLocations, queryUpdate, update, options);

  // all stored, rebroadcast
  return true;
}

/**
 * Store app removed message
 * @param {object} message - Message to store
 * @returns {Promise<boolean|Error>} Whether message should be rebroadcast or Error if invalid
 */
async function storeAppRemovedMessage(message) {
  /* message object
  * @param type string
  * @param version number
  * @param ip string
  * @param appName string
  * @param broadcastedAt number
  */
  if (!message || typeof message !== 'object' || typeof message.type !== 'string' || typeof message.version !== 'number'
    || typeof message.broadcastedAt !== 'number' || typeof message.ip !== 'string' || typeof message.appName !== 'string') {
    return new Error('Invalid Flux App Removed message for storing');
  }

  if (message.version !== 1) {
    return new Error(`Invalid Flux App Removed message for storing version ${message.version} not supported`);
  }

  if (!message.ip) {
    return new Error('Invalid Flux App Removed message ip cannot be empty');
  }

  if (!message.appName) {
    return new Error('Invalid Flux App Removed message appName cannot be empty');
  }

  log.info('New Flux App Removed message received.');
  log.info(message);

  const validTill = message.broadcastedAt + (65 * 60 * 1000); // 3900 seconds
  if (validTill < Date.now()) {
    // reject old message
    return false;
  }

  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.appsglobal.database);
  const query = { ip: message.ip, name: message.appName };
  const projection = {};
  await dbHelper.findOneAndDeleteInDatabase(database, globalAppsLocations, query, projection);

  // all stored, rebroadcast
  return true;
}

/**
 * Store app installing error message
 * @param {object} message - Error message to store
 * @returns {Promise<boolean>} Whether message should be rebroadcast
 */
async function storeAppInstallingErrorMessage(message) {
  /* message object
  * @param type string
  * @param version number
  * @param name string
  * @param hash string
  * @param ip string
  * @param error string
  * @param broadcastedAt number
  */
  if (!message || typeof message !== 'object' || typeof message.type !== 'string' || typeof message.version !== 'number'
    || typeof message.broadcastedAt !== 'number' || typeof message.ip !== 'string' || typeof message.name !== 'string'
    || typeof message.hash !== 'string' || typeof message.error !== 'string') {
    return new Error('Invalid Flux App Installing Error message for storing');
  }

  if (message.version !== 1) {
    return new Error(`Invalid Flux App Installing Error message for storing version ${message.version} not supported`);
  }

  if (message.broadcastedAt + GOSSIP_VALIDITY_MS < Date.now()) {
    log.warn(`Rejecting old/not valid fluxappinstallingerror message, message:${JSON.stringify(message)}`);
    return false;
  }

  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.appsglobal.database);

  const newAppInstallingErrorMessage = {
    name: message.name,
    hash: message.hash,
    ip: message.ip,
    error: message.error,
    broadcastedAt: new Date(message.broadcastedAt),
    expireAt: new Date(message.broadcastedAt + INSTALLING_ERRORS_EXPIRY_MS),
  };

  const queryFind = { name: newAppInstallingErrorMessage.name, hash: newAppInstallingErrorMessage.hash, ip: newAppInstallingErrorMessage.ip };
  const projection = { _id: 0, broadcastedAt: 1 };
  const result = await dbHelper.findOneInDatabase(database, globalAppsInstallingErrorsLocations, queryFind, projection);
  if (result && result.broadcastedAt && result.broadcastedAt >= newAppInstallingErrorMessage.broadcastedAt) {
    return false;
  }

  const update = { $set: newAppInstallingErrorMessage };
  await dbHelper.updateOneInDatabase(database, globalAppsInstallingErrorsLocations, queryFind, update, { upsert: true });

  const installingQuery = { name: newAppInstallingErrorMessage.name, ip: newAppInstallingErrorMessage.ip };
  await dbHelper.removeDocumentsFromCollection(database, globalAppsInstallingLocations, installingQuery);
  await dbHelper.removeDocumentsFromCollection(database, appsInstallingBroadcasts, { 'data.name': newAppInstallingErrorMessage.name, 'data.ip': newAppInstallingErrorMessage.ip });

  return true;
}

/**
 * Store IP changed message
 * @param {object} message - Message to store
 * @returns {Promise<boolean>} Whether message should be rebroadcast
 */
async function storeIPChangedMessage(message) {
  /* message object
  * @param type string
  * @param version number
  * @param oldIP string
  * @param newIP string
  * @param broadcastedAt number
  */
  if (!message || typeof message !== 'object' || typeof message.type !== 'string' || typeof message.version !== 'number'
    || typeof message.broadcastedAt !== 'number' || typeof message.oldIP !== 'string' || typeof message.newIP !== 'string') {
    return new Error('Invalid Flux IP Changed message for storing');
  }

  if (message.version !== 1) {
    return new Error(`Invalid Flux IP Changed message for storing version ${message.version} not supported`);
  }

  if (!message.oldIP || !message.newIP) {
    return new Error('Invalid Flux IP Changed message oldIP and newIP cannot be empty');
  }

  if (message.oldIP === message.newIP) {
    return new Error(`Invalid Flux IP Changed message oldIP and newIP are the same ${message.newIP}`);
  }

  log.info('New Flux IP Changed message received.');
  log.info(message);

  const validTill = message.broadcastedAt + (65 * 60 * 1000); // 3900 seconds
  if (validTill < Date.now()) {
    // reject old message
    return false;
  }

  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.appsglobal.database);
  const query = { ip: message.oldIP };
  const update = { $set: { ip: message.newIP, broadcastedAt: new Date(message.broadcastedAt) } };
  await dbHelper.updateInDatabase(database, globalAppsLocations, query, update);

  // all stored, rebroadcast
  return true;
}

async function storeBatchAppRunningMessages(verifiedBroadcasts) {
  if (verifiedBroadcasts.length === 0) return { stored: 0 };
  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.appsglobal.database);

  const { stored } = await storeBatchAppRunningEvents(verifiedBroadcasts);

  const locationOps = [];
  const v2AppsByIp = new Map();

  for (const broadcast of verifiedBroadcasts) {
    const { data } = broadcast;
    const validTill = data.broadcastedAt + RUNNING_EXPIRY_MS;
    if (validTill < Date.now()) continue;

    const apps = data.version === 2 ? (data.apps || []) : [{ name: data.name, hash: data.hash }];
    if (data.version === 2 && apps.length > 0) {
      const existing = v2AppsByIp.get(data.ip);
      if (!existing || data.broadcastedAt > existing.broadcastedAt) {
        v2AppsByIp.set(data.ip, { names: apps.map((a) => a.name), broadcastedAt: data.broadcastedAt });
      }
    }
    const incomingDate = new Date(data.broadcastedAt);
    const incomingExpiry = new Date(validTill);
    const isNewer = { $gt: [incomingDate, { $ifNull: ['$broadcastedAt', new Date(0)] }] };
    for (const app of apps) {
      const setFields = {
        name: app.name,
        ip: data.ip,
        hash: { $cond: [isNewer, app.hash, { $ifNull: ['$hash', app.hash] }] },
        broadcastedAt: { $cond: [isNewer, incomingDate, '$broadcastedAt'] },
        expireAt: { $cond: [isNewer, incomingExpiry, '$expireAt'] },
        osUptime: { $cond: [isNewer, data.osUptime, { $ifNull: ['$osUptime', data.osUptime] }] },
        staticIp: { $cond: [isNewer, data.staticIp ?? null, { $ifNull: ['$staticIp', data.staticIp ?? null] }] },
      };
      const runningSince = data.runningSince ? new Date(data.runningSince) : (app.runningSince ? new Date(app.runningSince) : null);
      if (runningSince) {
        setFields.runningSince = { $cond: [isNewer, runningSince, { $ifNull: ['$runningSince', runningSince] }] };
      }
      locationOps.push({
        updateOne: {
          filter: { name: app.name, ip: data.ip },
          update: [{ $set: setFields }],
          upsert: true,
        },
      });
    }
  }

  for (const [ip, { names, broadcastedAt }] of v2AppsByIp) {
    const cutoff = new Date(broadcastedAt);
    locationOps.push({
      deleteMany: {
        filter: { ip, name: { $nin: names }, broadcastedAt: { $lte: cutoff } },
      },
    });
  }

  if (locationOps.length > 0) {
    await database.collection(globalAppsLocations).bulkWrite(locationOps, { ordered: false })
      .catch((err) => log.error(`storeBatchAppRunningMessages locations: ${err.message}`));
  }

  return { stored };
}

// --- Event Log Functions ---

async function handleAppRunningEvent({ signedBroadcast }) {
  try {
    const { data } = signedBroadcast;
    if (!data || !data.ip || !data.broadcastedAt) return;
    if (data.broadcastedAt + GOSSIP_VALIDITY_MS < Date.now()) return;

    const db = dbHelper.databaseConnection();
    const database = db.db(config.database.appsglobal.database);

    if (data.version === 2 && (!data.apps || data.apps.length === 0)) {
      const existing = await database.collection(globalAppStateEvents).findOne({ ip: data.ip, type: APP_STATE_EVENT_TYPES.APPRUNNING });
      if (!existing) return;
    }

    const dedupKey = data.apps ? 'v2' : `v1:${data.name}`;
    const envelope = { version: signedBroadcast.version, timestamp: signedBroadcast.timestamp, pubKey: signedBroadcast.pubKey, signature: signedBroadcast.signature };

    await database.collection(globalAppStateEvents).updateOne(
      { ip: data.ip, type: APP_STATE_EVENT_TYPES.APPRUNNING, dedupKey },
      buildConditionalUpsert(data.broadcastedAt, {
        ip: data.ip, type: APP_STATE_EVENT_TYPES.APPRUNNING, dedupKey,
        broadcastedAt: new Date(data.broadcastedAt),
        expireAt: new Date(data.broadcastedAt + RUNNING_EXPIRY_MS),
        data, envelope,
      }, { alwaysSetFields: { receivedAt: new Date() } }),
      { upsert: true },
    );
  } catch (err) {
    log.error(`storeAppStateEvent(apprunning): ${err.message}`);
  }
}

async function handleSigtermEvent({ message, envelope }) {
  if (!message || !message.ip || !message.broadcastedAt) return;
  try {
    const { ip } = message;
    const db = dbHelper.databaseConnection();
    const database = db.db(config.database.appsglobal.database);
    await database.collection(globalAppStateEvents).updateOne(
      { ip, type: APP_STATE_EVENT_TYPES.SIGTERM, dedupKey: 'sigterm' },
      buildConditionalUpsert(message.broadcastedAt, {
        ip, type: APP_STATE_EVENT_TYPES.SIGTERM, dedupKey: 'sigterm',
        broadcastedAt: new Date(message.broadcastedAt),
        expireAt: new Date(message.broadcastedAt + RUNNING_EXPIRY_MS),
        envelope, data: message,
      }, { alwaysSetFields: { receivedAt: new Date() } }),
      { upsert: true },
    );
  } catch (err) {
    log.error(`storeAppStateEvent(sigterm): ${err.message}`);
  }
}

async function handleAppRemovedStateEvent({ message, envelope }) {
  if (!message || !message.ip || !message.appName || !message.broadcastedAt) return;
  try {
    const db = dbHelper.databaseConnection();
    const database = db.db(config.database.appsglobal.database);
    await database.collection(globalAppStateEvents).updateOne(
      { ip: message.ip, type: APP_STATE_EVENT_TYPES.APPREMOVED, dedupKey: `appremoved:${message.appName}` },
      buildConditionalUpsert(message.broadcastedAt, {
        ip: message.ip, type: APP_STATE_EVENT_TYPES.APPREMOVED, dedupKey: `appremoved:${message.appName}`,
        broadcastedAt: new Date(message.broadcastedAt),
        expireAt: new Date(message.broadcastedAt + RUNNING_EXPIRY_MS),
        envelope, data: message,
      }, { alwaysSetFields: { receivedAt: new Date() } }),
      { upsert: true },
    );
  } catch (err) {
    log.error(`storeAppStateEvent(appremoved): ${err.message}`);
  }
}

async function handleEvictedEvent({ ip }) {
  if (!ip) return;
  try {
    const now = new Date();
    const db = dbHelper.databaseConnection();
    const database = db.db(config.database.appsglobal.database);
    await database.collection(globalAppStateEvents).updateOne(
      { ip, type: APP_STATE_EVENT_TYPES.EVICTED, dedupKey: 'evicted' },
      { $set: { ip, type: APP_STATE_EVENT_TYPES.EVICTED, dedupKey: 'evicted', createdAt: now, expireAt: new Date(now.getTime() + EVICTED_EXPIRY_MS), receivedAt: now } },
      { upsert: true },
    );
  } catch (err) {
    log.error(`storeAppStateEvent(evicted): ${err.message}`);
  }
}

async function handleIPChangedEvent({ message, envelope }) {
  if (!message || !message.oldIP || !message.newIP || !message.broadcastedAt) return;
  try {
    const db = dbHelper.databaseConnection();
    const database = db.db(config.database.appsglobal.database);
    await database.collection(globalAppStateEvents).updateOne(
      { ip: message.oldIP, type: APP_STATE_EVENT_TYPES.IPCHANGED, dedupKey: 'ipchanged' },
      buildConditionalUpsert(message.broadcastedAt, {
        ip: message.oldIP, type: APP_STATE_EVENT_TYPES.IPCHANGED, dedupKey: 'ipchanged',
        broadcastedAt: new Date(message.broadcastedAt),
        expireAt: new Date(message.broadcastedAt + RUNNING_EXPIRY_MS),
        data: message, envelope: envelope ?? null,
      }, { alwaysSetFields: { receivedAt: new Date() } }),
      { upsert: true },
    );
  } catch (err) {
    log.error(`storeAppStateEvent(ipchanged): ${err.message}`);
  }
}

function storeAppStateEvent(type, payload) {
  switch (type) {
    case APP_STATE_EVENT_TYPES.APPRUNNING: return handleAppRunningEvent(payload);
    case APP_STATE_EVENT_TYPES.SIGTERM: return handleSigtermEvent(payload);
    case APP_STATE_EVENT_TYPES.APPREMOVED: return handleAppRemovedStateEvent(payload);
    case APP_STATE_EVENT_TYPES.EVICTED: return handleEvictedEvent(payload);
    case APP_STATE_EVENT_TYPES.IPCHANGED: return handleIPChangedEvent(payload);
    default: log.error(`storeAppStateEvent: unknown type ${type}`); return undefined;
  }
}

async function storeBatchAppRunningEvents(verifiedBroadcasts) {
  if (verifiedBroadcasts.length === 0) return { stored: 0 };
  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.appsglobal.database);

  const ops = [];

  for (const broadcast of verifiedBroadcasts) {
    const { data } = broadcast;
    if (!data || !data.ip || !data.broadcastedAt) continue;
    const validTill = data.broadcastedAt + RUNNING_EXPIRY_MS;
    if (validTill < Date.now()) continue;

    const dedupKey = data.apps ? 'v2' : `v1:${data.name}`;
    const envelope = { version: broadcast.version, timestamp: broadcast.timestamp, pubKey: broadcast.pubKey, signature: broadcast.signature };

    ops.push({
      updateOne: {
        filter: { ip: data.ip, type: 'apprunning', dedupKey },
        update: buildConditionalUpsert(data.broadcastedAt, {
          ip: data.ip, type: 'apprunning', dedupKey,
          broadcastedAt: new Date(data.broadcastedAt),
          expireAt: new Date(validTill),
          data, envelope,
        }),
        upsert: true,
      },
    });

  }

  if (ops.length > 0) {
    await database.collection(globalAppStateEvents).bulkWrite(ops, { ordered: false })
      .catch((err) => log.error(`storeBatchAppRunningEvents: ${err.message}`));
  }

  return { stored: ops.length };
}

function storeSignedAppInstallingBroadcast(signedBroadcast) {
  const { data } = signedBroadcast;
  if (!data || !data.ip || !data.name || !data.broadcastedAt) return;
  if (data.broadcastedAt + INSTALLING_EXPIRY_MS < Date.now()) return;
  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.appsglobal.database);
  const doc = {
    version: signedBroadcast.version,
    timestamp: signedBroadcast.timestamp,
    pubKey: signedBroadcast.pubKey,
    signature: signedBroadcast.signature,
    data,
    broadcastedAt: new Date(data.broadcastedAt),
    expireAt: new Date(data.broadcastedAt + INSTALLING_EXPIRY_MS),
    receivedAt: new Date(),
  };
  return dbHelper.updateOneInDatabase(
    database, appsInstallingBroadcasts,
    { 'data.name': data.name, 'data.ip': data.ip },
    { $set: doc },
    { upsert: true },
  ).catch((err) => log.error(`storeSignedAppInstallingBroadcast: ${err.message}`));
}

async function storeBatchAppInstallingMessages(verifiedBroadcasts) {
  if (verifiedBroadcasts.length === 0) return { stored: 0 };
  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.appsglobal.database);

  const signedOps = [];
  const locationOps = [];

  for (const broadcast of verifiedBroadcasts) {
    const { data } = broadcast;
    const validTill = data.broadcastedAt + INSTALLING_EXPIRY_MS;
    if (validTill < Date.now()) continue;

    signedOps.push({
      updateOne: {
        filter: { 'data.name': data.name, 'data.ip': data.ip },
        update: {
          $set: {
            version: broadcast.version,
            timestamp: broadcast.timestamp,
            pubKey: broadcast.pubKey,
            signature: broadcast.signature,
            data,
            broadcastedAt: new Date(data.broadcastedAt),
            expireAt: new Date(validTill),
            receivedAt: new Date(broadcast.receivedAt),
          },
        },
        upsert: true,
      },
    });

    const incomingDate = new Date(data.broadcastedAt);
    const incomingExpiry = new Date(validTill);
    const isNewer = { $gt: [incomingDate, { $ifNull: ['$broadcastedAt', new Date(0)] }] };
    locationOps.push({
      updateOne: {
        filter: { name: data.name, ip: data.ip },
        update: [{ $set: {
          name: data.name,
          ip: data.ip,
          broadcastedAt: { $cond: [isNewer, incomingDate, '$broadcastedAt'] },
          expireAt: { $cond: [isNewer, incomingExpiry, '$expireAt'] },
        } }],
        upsert: true,
      },
    });
  }

  if (signedOps.length > 0) {
    await database.collection(appsInstallingBroadcasts).bulkWrite(signedOps, { ordered: false })
      .catch((err) => log.error(`storeBatchAppInstallingMessages signed: ${err.message}`));
  }
  if (locationOps.length > 0) {
    await database.collection(globalAppsInstallingLocations).bulkWrite(locationOps, { ordered: false })
      .catch((err) => log.error(`storeBatchAppInstallingMessages locations: ${err.message}`));
  }
  return { stored: signedOps.length };
}

function storeSignedAppInstallingErrorBroadcast(signedBroadcast) {
  const { data } = signedBroadcast;
  if (!data || !data.ip || !data.name || !data.hash || !data.broadcastedAt) return;
  if (data.broadcastedAt + INSTALLING_ERRORS_EXPIRY_MS < Date.now()) return;
  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.appsglobal.database);
  const doc = {
    version: signedBroadcast.version,
    timestamp: signedBroadcast.timestamp,
    pubKey: signedBroadcast.pubKey,
    signature: signedBroadcast.signature,
    data,
    broadcastedAt: new Date(data.broadcastedAt),
    expireAt: new Date(data.broadcastedAt + INSTALLING_ERRORS_EXPIRY_MS),
    receivedAt: new Date(),
  };
  return dbHelper.updateOneInDatabase(
    database, globalAppsInstallingErrorsBroadcasts,
    { 'data.name': data.name, 'data.hash': data.hash, 'data.ip': data.ip },
    { $set: doc },
    { upsert: true },
  ).catch((err) => log.error(`storeSignedAppInstallingErrorBroadcast: ${err.message}`));
}

async function storeBatchAppInstallingErrorMessages(verifiedBroadcasts) {
  if (verifiedBroadcasts.length === 0) return { stored: 0 };
  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.appsglobal.database);

  const signedOps = [];
  const locationOps = [];

  for (const broadcast of verifiedBroadcasts) {
    const { data } = broadcast;
    const validTill = data.broadcastedAt + INSTALLING_ERRORS_EXPIRY_MS;
    if (validTill < Date.now()) continue;

    const incomingDate = new Date(data.broadcastedAt);
    const incomingExpiry = new Date(validTill);

    signedOps.push({
      updateOne: {
        filter: { 'data.name': data.name, 'data.hash': data.hash, 'data.ip': data.ip },
        update: {
          $set: {
            version: broadcast.version,
            timestamp: broadcast.timestamp,
            pubKey: broadcast.pubKey,
            signature: broadcast.signature,
            data,
            broadcastedAt: incomingDate,
            expireAt: incomingExpiry,
            receivedAt: new Date(broadcast.receivedAt),
          },
        },
        upsert: true,
      },
    });

    const isNewer = { $gt: [incomingDate, { $ifNull: ['$broadcastedAt', new Date(0)] }] };
    locationOps.push({
      updateOne: {
        filter: { name: data.name, hash: data.hash, ip: data.ip },
        update: [{ $set: {
          name: data.name,
          hash: data.hash,
          ip: data.ip,
          error: { $cond: [isNewer, data.error, { $ifNull: ['$error', data.error] }] },
          broadcastedAt: { $cond: [isNewer, incomingDate, '$broadcastedAt'] },
          expireAt: { $cond: [isNewer, incomingExpiry, '$expireAt'] },
        } }],
        upsert: true,
      },
    });
  }

  if (signedOps.length > 0) {
    await database.collection(globalAppsInstallingErrorsBroadcasts).bulkWrite(signedOps, { ordered: false })
      .catch((err) => log.error(`storeBatchAppInstallingErrorMessages signed: ${err.message}`));
  }
  if (locationOps.length > 0) {
    await database.collection(globalAppsInstallingErrorsLocations).bulkWrite(locationOps, { ordered: false })
      .catch((err) => log.error(`storeBatchAppInstallingErrorMessages locations: ${err.message}`));
  }
  return { stored: signedOps.length };
}

async function processPendingUpdates(appName) {
  const pendingUpdates = globalState.getPendingUpdates(appName);
  if (pendingUpdates.length === 0) return;
  log.info(`Processing ${pendingUpdates.length} pending updates for ${appName}`);
  for (let idx = 0; idx < pendingUpdates.length; idx += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await storeAppTemporaryMessage(pendingUpdates[idx].message);
      log.info(`Processed pending update ${idx + 1}/${pendingUpdates.length} for ${appName}`);
    } catch (error) {
      log.warn(`Pending update for ${appName} failed: ${error.message}. Clearing ${pendingUpdates.length - idx} remaining updates.`);
      globalState.clearPendingUpdates(appName);
      break;
    }
  }
}

module.exports = {
  storeAppTemporaryMessage,
  storeAppPermanentMessage,
  processPendingUpdates,
  storeAppRunningMessage,
  storeBatchAppRunningMessages,
  storeAppStateEvent,
  storeBatchAppRunningEvents,
  APP_STATE_EVENT_TYPES,
  storeAppInstallingMessage,
  storeSignedAppInstallingBroadcast,
  storeBatchAppInstallingMessages,
  storeAppRemovedMessage,
  storeAppInstallingErrorMessage,
  storeSignedAppInstallingErrorBroadcast,
  storeBatchAppInstallingErrorMessages,
  storeIPChangedMessage,
};
