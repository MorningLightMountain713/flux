'use strict';

const config = require('config');
const dbHelper = require('../dbHelper');
const log = require('../../lib/log');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const benchmarkService = require('../benchmarkService');
const appsRepository = require('../appDatabase/appsRepository');
const appEventVerifier = require('./appEventVerifier');
const registryManager = require('../appDatabase/registryManager');
const { getSpec, validateGossipSpec, assertVersionActivated } = require('../utils/specLibs');
const { getStateBeforeHeight } = require('../appDatabase/appSpecHistory');
const globalState = require('../utils/globalState');
const {
  globalAppsMessages,
  globalAppsTempMessages,
  globalAppsInstallingLocations,
  globalAppsInstallingBroadcasts: appsInstallingBroadcasts,
  globalAppsInstallingErrorsLocations,
  globalAppsInstallingErrorsBroadcasts,
  globalAppStateEvents,
  appsHashesCollection,
} = require('../utils/appConstants');
const { appSyncEvents, EVENTS: SYNC_EVENTS } = require('../utils/appSyncEvents');

const {
  GOSSIP_VALIDITY_MS,
  RUNNING_EXPIRY_MS,
  INSTALLING_EXPIRY_MS,
  INSTALLING_ERRORS_EXPIRY_MS,
  EVICTED_EXPIRY_MS,
  CLOCK_SKEW_ALLOWANCE_MS,
} = require('../utils/appConstants');

const APP_STATE_EVENT_TYPES = Object.freeze({
  APPRUNNING: 'apprunning',
  SIGTERM: 'sigterm',
  APPREMOVED: 'appremoved',
  EVICTED: 'evicted',
  IPCHANGED: 'ipchanged',
});

/**
 * The announcing node's chain identity, as resolved by the verification layer that
 * had already looked the node up. Stored beside data, never inside it: data is the
 * exact byte string the originator signed and is re-served verbatim over sync, so
 * writing into it would invalidate the signature for every peer downstream.
 * Null when unresolved, which readers take as unknown rather than unclaimed.
 */
function outpointOf(announcer) {
  if (!announcer || !announcer.txhash) return null;
  return `${announcer.txhash}:${announcer.outidx}`;
}

/**
 * Whether a self-reported broadcastedAt is usable as an ordering key.
 *
 * broadcastedAt drives newer-wins across every app-state event AND is what expireAt is
 * derived from, so an unbounded future value both wins every comparison forever and
 * sets a TTL that never fires. The staleness checks throughout this module are
 * one-sided and do not catch it, and the envelope's own future guard covers a different
 * field. validityMs is a staleness window and varies by path (5 min live, the row TTL on
 * sync); the forward bound is clock disagreement and is the same everywhere.
 *
 * @param {number} broadcastedAt ms epoch claimed by the announcer.
 * @param {number} validityMs how far in the past the value may sit.
 * @returns {boolean}
 */
function broadcastedAtUsable(broadcastedAt, validityMs) {
  if (!Number.isFinite(broadcastedAt) || !Number.isFinite(validityMs)) return false;
  const skew = Number.isFinite(CLOCK_SKEW_ALLOWANCE_MS) ? CLOCK_SKEW_ALLOWANCE_MS : 0;
  const now = Date.now();
  if (broadcastedAt > now + skew) return false;
  return broadcastedAt + validityMs >= now;
}

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
  if (typeof message.appSpecifications !== 'object') {
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
      blockTime: 1,
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
    // node's signed receipt that a genuine secure backend validated it), verified locally
    // against the hardcoded network key so non-Arcane nodes reject too. Drop
    // (do not relay) on a missing/invalid attestation.
    //
    // v9 only. v8 encrypted apps are intentionally never gated: they predate
    // attestation and aren't born attested, so rejecting would partition legacy
    // apps off the network — v8 stays accepted as-is, being phased out.
    if (appEvent.requiresArcaneAttestation() && !appEventVerifier.verifyAttestation(appEvent)) {
      return new Error('Invalid or missing arcane attestation on encrypted Flux App message');
    }

    let validationBlob;
    if (appEvent.isEncrypted) {
      if (await benchmarkService.isSystemSecure()) {
        const provider = await appEvent.spec.createProvider();
        const decrypted = await appEvent.spec.decrypt(provider);
        // Validated through the wrapper: a decrypted spec has no wire form, so
        // there is no blob to hand a validator. Same rules, no plaintext bytes.
        assertVersionActivated(decrypted.version, block);
        decrypted.validateContents({ purpose: 'gossip' });
      }
    } else {
      validationBlob = message.appSpecifications;
    }

    if (validationBlob) {
      await validateGossipSpec(validationBlob, { height: block });
    }

    let previousState = null;
    if (!appEvent.isRegistration) {
      // Who this update has to be signed by. A live message is judged against
      // the app that holds the name NOW — its active registry row. A message
      // already on chain is a replay: the node is catching up on something the
      // network accepted at a past height, so it is judged against the state at
      // that height (isAppRequested is set from the confirming block, so `block`
      // is that height rather than the tip).
      previousState = isAppRequested
        ? await getStateBeforeHeight(appEvent.spec.name, block)
        : await appsRepository.getGlobalAppInfo(appEvent.spec.name);
      if (!previousState) {
        log.info(`Queueing update for ${appEvent.spec.name} - registration not yet stored`);
        globalState.queuePendingUpdate(appEvent.spec.name, message, block);
        return false;
      }
    }

    if (validationBlob) {
      if (appEvent.isRegistration) {
        await registryManager.checkApplicationRegistrationNameConflicts(appEvent.spec, appEvent.hash);
      } else if (previousState) {
        const { UpdatePolicy } = await getSpec();
        UpdatePolicy.assertCompatible(previousState.spec, appEvent.spec);
      }
    }

    await appEventVerifier.authorize({
      appEvent,
      previousState,
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
      ? {
        hash: appEvent.hash, txid: result.txid, height: result.height, value: result.value, blockTime: result.blockTime ?? null,
      }
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
 * Release the installing claims an apprunning announcement supersedes.
 *
 * A node announcing an app as running has finished installing it, so the seat it
 * reserved while installing is spent — both the claim row and its archived announce,
 * or message sync would hand the seat back. A v2 announcement carrying no apps says
 * the node holds nothing at all, and releases everything it had.
 *
 * Stores nothing: the announcement itself is recorded by storeAppStateEvent, which
 * owns whether it is news and therefore whether it travels further.
 *
 * @param {object} message - the apprunning message
 * @returns {Promise<Error|{released: number}>} Error when the message is malformed
 */
async function releaseInstallingClaims(message) {
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

  if (!broadcastedAtUsable(message.broadcastedAt, GOSSIP_VALIDITY_MS)) {
    log.warn(`Rejecting old/future/not valid Fluxapprunning message, message:${JSON.stringify(message)}`);
    return { released: 0 };
  }

  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.appsglobal.database);

  // A v2 announcement with no apps says the node holds nothing: every seat it
  // reserved is released, not just the ones it named.
  if (message.version === 2 && appsMessages.length === 0) {
    await dbHelper.removeDocumentsFromCollection(database, globalAppsInstallingLocations, { ip: message.ip });
    await dbHelper.removeDocumentsFromCollection(database, appsInstallingBroadcasts, { 'data.ip': message.ip });
    return { released: 0 };
  }

  for (const app of appsMessages) {
    // A replica-tagged entry releases exactly its own claim (location row AND
    // archived announce - a sibling still mid-install must keep both, or message
    // sync would strip its seat); untagged releases every claim for the
    // (name, ip) - the v1 whole-app semantics.
    const tagged = typeof app.replica === 'string';
    const queryFind = tagged
      ? { name: app.name, ip: message.ip, replica: app.replica }
      : { name: app.name, ip: message.ip };
    const broadcastQuery = tagged
      ? { 'data.name': app.name, 'data.ip': message.ip, 'data.replica': app.replica }
      : { 'data.name': app.name, 'data.ip': message.ip };
    // eslint-disable-next-line no-await-in-loop
    await dbHelper.removeDocumentsFromCollection(database, globalAppsInstallingLocations, queryFind);
    // eslint-disable-next-line no-await-in-loop
    await dbHelper.removeDocumentsFromCollection(database, appsInstallingBroadcasts, broadcastQuery);
  }

  return { released: appsMessages.length };
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
  * v2 additions:
  * @param announcedAt number - immutable first-announce time; broadcastedAt moves on
  *   renewals, so elections must order contenders by announcedAt
  * @param replica string (optional) - the claimed identity for named placement; rows
  *   key on (name, ip, replica ?? null), one seat per replica
  * @param cleared boolean (optional) - retract the claim with no verdict on the app,
  *   unlike fluxappinstallingerror which also feeds peers' error counting; tagged
  *   clears release exactly their replica's seat, untagged release every (name, ip) row
  */
  if (!message || typeof message !== 'object' || typeof message.type !== 'string' || typeof message.version !== 'number'
    || typeof message.broadcastedAt !== 'number' || typeof message.ip !== 'string' || typeof message.name !== 'string') {
    return new Error('Invalid Flux App Installing message for storing');
  }

  if (message.version !== 1 && message.version !== 2) {
    return new Error(`Invalid Flux App Installing message for storing version ${message.version} not supported`);
  }

  const cleared = message.version === 2 && message.cleared === true;

  if (message.version === 2 && !cleared && typeof message.announcedAt !== 'number') {
    return new Error('Invalid Flux App Installing message for storing announcedAt required for version 2');
  }

  if (!broadcastedAtUsable(message.broadcastedAt, GOSSIP_VALIDITY_MS)) {
    log.warn(`Rejecting old/future/not valid fluxappinstalling message, message:${JSON.stringify(message)}`);
    return false;
  }

  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.appsglobal.database);

  // Peer input: normalize the identity tag tolerantly (a malformed tag degrades to
  // the untagged row) - the local writer's store (registryManager) is the strict one.
  const replica = message.version === 2 && typeof message.replica === 'string' ? message.replica : null;
  // The intended ordinal slot (meshSlots.js), normalized the same tolerant way.
  // Bounded loosely here (the instance cap is 100); the semantic cap — the
  // app's own instance count — is enforced where slots are consumed.
  const meshSlot = message.version === 2 && Number.isInteger(message.meshSlot)
    && message.meshSlot >= 0 && message.meshSlot < 1000 ? message.meshSlot : null;

  if (cleared) {
    // A replica-tagged clear releases exactly its own claim; untagged releases
    // every (name, ip) claim - the v1/loose whole-app semantics.
    const clearQuery = replica !== null
      ? { name: message.name, ip: message.ip, replica }
      : { name: message.name, ip: message.ip };
    // A strictly-newer announce supersedes a late-arriving clear from an older
    // attempt; on an equal timestamp the clear wins - the emitter sequences the
    // clear after its own announce, so same-millisecond means announce-then-clear.
    const rows = await dbHelper.findInDatabase(database, globalAppsInstallingLocations, clearQuery, { projection: { _id: 0, broadcastedAt: 1 } });
    const clearedAt = new Date(message.broadcastedAt);
    if (rows.some((row) => row.broadcastedAt && row.broadcastedAt > clearedAt)) {
      return false;
    }
    // Delete the archived broadcast(s) too so message sync cannot resurrect the claim.
    const broadcastQuery = replica !== null
      ? { 'data.name': message.name, 'data.ip': message.ip, 'data.replica': replica }
      : { 'data.name': message.name, 'data.ip': message.ip };
    await dbHelper.removeDocumentsFromCollection(database, globalAppsInstallingLocations, clearQuery);
    await dbHelper.removeDocumentsFromCollection(database, appsInstallingBroadcasts, broadcastQuery);
    return true;
  }

  const newAppInstallingMessage = {
    name: message.name,
    ip: message.ip,
    // One claim row per identity: a replica name for named placement, null
    // (loose / v1 senders) - null also matches legacy rows without the field.
    replica,
    broadcastedAt: new Date(message.broadcastedAt),
    expireAt: new Date(message.broadcastedAt + INSTALLING_EXPIRY_MS),
  };
  if (message.version === 2) {
    newAppInstallingMessage.announcedAt = new Date(message.announcedAt);
  }
  // $set only when carried: the spawner's slotless renewals must not strip a
  // slot the mesh provision path published onto the standing claim.
  if (meshSlot !== null) {
    newAppInstallingMessage.meshSlot = meshSlot;
  }

  const queryFind = { name: message.name, ip: message.ip, replica };
  const projection = { _id: 0 };
  const result = await dbHelper.findOneInDatabase(database, globalAppsInstallingLocations, queryFind, projection);
  // we already have the exact same data (or newer - e.g. a renewal already landed)
  if (result && result.broadcastedAt && result.broadcastedAt >= newAppInstallingMessage.broadcastedAt) {
    return false;
  }

  const queryUpdate = queryFind;
  const update = { $set: newAppInstallingMessage };
  const options = {
    upsert: true,
  };
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

  log.info(`New Flux App Removed message received for ${message.appName} at ${message.ip}`);

  const messageValidityMs = 65 * 60 * 1000; // 3900 seconds
  if (!broadcastedAtUsable(message.broadcastedAt, messageValidityMs)) {
    // reject old or future-dated message
    return false;
  }

  // Nothing to delete: the removal is recorded in the app state event log by
  // storeAppStateEvent, and the derivation excludes the app from the node's running
  // set from that moment.
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

  if (!broadcastedAtUsable(message.broadcastedAt, GOSSIP_VALIDITY_MS)) {
    log.warn(`Rejecting old/future/not valid fluxappinstallingerror message, message:${JSON.stringify(message)}`);
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

  log.info(`New Flux IP Changed message received: ${message.oldIP} -> ${message.newIP}`);

  const messageValidityMs = 65 * 60 * 1000; // 3900 seconds
  if (!broadcastedAtUsable(message.broadcastedAt, messageValidityMs)) {
    // reject old or future-dated message
    return false;
  }

  // Nothing to rewrite: the move is recorded in the event log, and the derivation
  // re-addresses the node's announcements off it.

  // all stored, rebroadcast
  return true;
}

// --- Event Log Functions ---

/**
 * Record a node's running-apps announcement.
 *
 * Reports `isNewer` — whether this told us something we did not already hold — which
 * is what damps the gossip: a message that advances nothing is not passed on, so it
 * dies here instead of circulating. The seen-message cache in fluxCommunication has
 * already dropped exact duplicates by hash; what reaches this is an unseen message,
 * which may still be a node's OLDER announcement arriving late behind a newer one.
 *
 * Deliberately compares the stored broadcast timestamp rather than asking whether the
 * write modified anything: `receivedAt` is written unconditionally, so a modified
 * count is true even for a stale message and would have every node relaying every
 * echo forever.
 *
 * @returns {Promise<{isNewer: boolean}>}
 */
async function handleAppRunningEvent({ signedBroadcast, announcer = null }) {
  try {
    const { data } = signedBroadcast;
    if (!data || !data.ip || !data.broadcastedAt) return { isNewer: false };
    if (!broadcastedAtUsable(data.broadcastedAt, GOSSIP_VALIDITY_MS)) return { isNewer: false };

    const db = dbHelper.databaseConnection();
    const database = db.db(config.database.appsglobal.database);

    if (data.version === 2 && (!data.apps || data.apps.length === 0)) {
      const existing = await database.collection(globalAppStateEvents).findOne({ ip: data.ip, type: APP_STATE_EVENT_TYPES.APPRUNNING });
      if (!existing) return { isNewer: false };
    }

    const dedupKey = data.apps ? 'v2' : `v1:${data.name}`;
    const envelope = { version: signedBroadcast.version, timestamp: signedBroadcast.timestamp, pubKey: signedBroadcast.pubKey, signature: signedBroadcast.signature };

    const prior = await dbHelper.findOneAndUpdateInDatabase(
      database, globalAppStateEvents,
      { ip: data.ip, type: APP_STATE_EVENT_TYPES.APPRUNNING, dedupKey },
      buildConditionalUpsert(data.broadcastedAt, {
        ip: data.ip, outpoint: outpointOf(announcer),
        type: APP_STATE_EVENT_TYPES.APPRUNNING, dedupKey,
        broadcastedAt: new Date(data.broadcastedAt),
        expireAt: new Date(data.broadcastedAt + RUNNING_EXPIRY_MS),
        data, envelope,
      }, { alwaysSetFields: { receivedAt: new Date() } }),
      { upsert: true, returnDocument: 'before', projection: { _id: 0, broadcastedAt: 1 } },
    );

    // No prior document means we had nothing for this node: everything is news.
    const priorAt = prior && prior.broadcastedAt ? new Date(prior.broadcastedAt).getTime() : 0;
    return { isNewer: data.broadcastedAt > priorAt };
  } catch (err) {
    log.error(`storeAppStateEvent(apprunning): ${err.message}`);
    return { isNewer: false };
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

async function storeBatchAppRunningEvents(verifiedBroadcasts, announcers = new Map()) {
  if (verifiedBroadcasts.length === 0) return { stored: 0 };
  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.appsglobal.database);

  const ops = [];

  for (const broadcast of verifiedBroadcasts) {
    const { data } = broadcast;
    if (!data || !data.ip || !data.broadcastedAt) continue;
    if (!broadcastedAtUsable(data.broadcastedAt, RUNNING_EXPIRY_MS)) continue;
    const validTill = data.broadcastedAt + RUNNING_EXPIRY_MS;

    const dedupKey = data.apps ? 'v2' : `v1:${data.name}`;
    const envelope = { version: broadcast.version, timestamp: broadcast.timestamp, pubKey: broadcast.pubKey, signature: broadcast.signature };

    ops.push({
      updateOne: {
        filter: { ip: data.ip, type: 'apprunning', dedupKey },
        update: buildConditionalUpsert(data.broadcastedAt, {
          ip: data.ip, outpoint: outpointOf(announcers.get(broadcast)),
          type: 'apprunning', dedupKey,
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
  // A cleared message is a retraction: storeAppInstallingMessage already deleted the
  // archived announce, and archiving the clear would re-serve a dead claim over sync.
  if (data.cleared === true) return;
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
    // One archived announce per claim identity; null matches legacy docs
    // archived without the field.
    { 'data.name': data.name, 'data.ip': data.ip, 'data.replica': data.replica ?? null },
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
    if (data.cleared === true) continue;
    if (!broadcastedAtUsable(data.broadcastedAt, INSTALLING_EXPIRY_MS)) continue;
    const validTill = data.broadcastedAt + INSTALLING_EXPIRY_MS;

    // The claim identity: one archived announce and one location row per replica;
    // null (loose / v1) matches legacy docs stored without the field.
    const replica = typeof data.replica === 'string' ? data.replica : null;

    signedOps.push({
      updateOne: {
        filter: { 'data.name': data.name, 'data.ip': data.ip, 'data.replica': replica },
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

    const locationFields = {
      broadcastedAt: new Date(data.broadcastedAt),
      expireAt: new Date(validTill),
    };
    // announcedAt is the claim's ORIGINAL announce time and must not drift on a
    // renewal - the renewal carries the original value, so taking the incoming one
    // when it is newer preserves it.
    if (typeof data.announcedAt === 'number') {
      locationFields.announcedAt = new Date(data.announcedAt);
    }
    locationOps.push({
      updateOne: {
        filter: { name: data.name, ip: data.ip, replica },
        // The identity is what the filter matched on, so it is never conditional on
        // recency - only the claim's timestamps and expiry are.
        update: buildConditionalUpsert(data.broadcastedAt, locationFields, {
          alwaysSetFields: { name: data.name, ip: data.ip, replica },
        }),
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
    if (!broadcastedAtUsable(data.broadcastedAt, INSTALLING_ERRORS_EXPIRY_MS)) continue;
    const validTill = data.broadcastedAt + INSTALLING_ERRORS_EXPIRY_MS;

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

    locationOps.push({
      updateOne: {
        filter: { name: data.name, hash: data.hash, ip: data.ip },
        update: buildConditionalUpsert(data.broadcastedAt, {
          error: data.error,
          broadcastedAt: incomingDate,
          expireAt: incomingExpiry,
        }, {
          alwaysSetFields: { name: data.name, hash: data.hash, ip: data.ip },
        }),
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
  releaseInstallingClaims,
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
