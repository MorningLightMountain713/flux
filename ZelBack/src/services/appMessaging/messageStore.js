'use strict';

const config = require('config');
const dbHelper = require('../dbHelper');
const log = require('../../lib/log');
const daemonStatus = require('../daemonService/daemonStatus');
const benchmarkService = require('../benchmarkService');
const appsRepository = require('../appDatabase/appsRepository');
const appRecords = require('../appDatabase/appRecords');
const appEventVerifier = require('./appEventVerifier');
const registryManager = require('../appDatabase/registryManager');
const foundingCommittee = require('../appMesh/foundingCommittee');
const fluxEventBus = require('../utils/fluxEventBus');
const ownerGenerationRecord = require('../quorumGrant/ownerGenerationRecord');
const rosterOverlay = require('../quorumGrant/rosterOverlay');
const networkStateService = require('../networkStateService');
const { getSpec, assertVersionActivated } = require('../utils/specLibs');
const { ensureProvidersRegistered } = require('../utils/specCutover');
const { getStateBeforeHeight, latestAppliedState } = require('../appDatabase/appSpecHistory');
const appHistory = require('../appDecisions/appHistory');
const temporaryPoolSweep = require('./temporaryPoolSweep');
const serviceHelper = require('../serviceHelper');
const { extractIp, extractPort } = require('../utils/socketAddressUtils');
const globalState = require('../utils/globalState');
const {
  globalAppsTempMessages,
  globalAppsInstallingLocations,
  globalAppsInstallingBroadcasts: appsInstallingBroadcasts,
  globalAppsInstallingErrorsLocations,
  globalAppsInstallingErrorsBroadcasts,
  globalAppStateEvents,
  appsHashesCollection,
} = require('../utils/appConstants');
const { appSyncEvents, EVENTS: SYNC_EVENTS } = require('../utils/appSyncEvents');
const { RECORD_LIFETIME_MS } = require('../utils/nodeDownCertificates');

const {
  GOSSIP_VALIDITY_MS,
  RUNNING_EXPIRY_MS,
  INSTALLING_EXPIRY_MS,
  INSTALLING_ERRORS_EXPIRY_MS,
  CLOCK_SKEW_ALLOWANCE_MS,
} = require('../utils/appConstants');

const APP_STATE_EVENT_TYPES = Object.freeze({
  APPRUNNING: 'apprunning',
  APPREMOVED: 'appremoved',
  IPCHANGED: 'ipchanged',
  MASTERLEASE: 'masterlease',
  GRANTGENERATION: 'grantgeneration',
  NODEDOWN: 'nodedown',
  NODEALIVE: 'nodealive',
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

// This node storing a record it published itself. A network intake always
// carries the resolved list entry of the node whose key signed the envelope;
// the local publish carries this instead, so the two can never be confused
// and a missing announcer fails closed rather than reading as "mine".
const LOCAL_ANNOUNCER = Object.freeze({ local: true });

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

  // A message is the contents that hash to the hash it states: nothing is
  // read, opened or judged for anything else.
  if (!appEvent.verifyHash().valid) {
    return new Error('Invalid Flux App hash received');
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
  let database = db.db(config.get('database.daemon.database'));
  const result = await dbHelper.findOneInDatabase(database, appsHashesCollection, query, projection);
  const syncStatus = daemonStatus.isDaemonSynced();
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
    // Awaited: verifyAttestation answers with a Promise, and a Promise is truthy,
    // so dropping the await turns this into a gate that never fires and relays
    // every encrypted message including an unattested one.
    if (appEvent.requiresArcaneAttestation() && !await appEventVerifier.verifyAttestation(appEvent)) {
      return new Error('Invalid or missing arcane attestation on encrypted Flux App message');
    }

    // The activation gate needs only the version, and a sealed spec states it in
    // the clear (decrypting takes it from there too), so every message meets the
    // gate whether or not this node can open it.
    assertVersionActivated(appEvent.spec.version, block);

    // False for a sealed spec this node cannot open — the checks below need to
    // read it.
    let specReadable = false;
    if (appEvent.isEncrypted) {
      if (await benchmarkService.isSystemSecure()) {
        try {
          // The providers are registered by the first local spec resolution; a
          // sealed message can arrive before one has happened.
          await ensureProvidersRegistered();
          const provider = await appEvent.spec.createProvider();
          // A v9 signature commits to a contentHash, so opening the envelope
          // says nothing about whether what came out is what the owner signed
          // for: decryptAndVerify opens and reconciles in one call. A legacy
          // signature commits to the ciphertext itself, so opening it is the
          // whole check.
          const decrypted = message.version === 2
            ? await appEvent.decryptAndVerify(provider)
            : await appEvent.spec.decrypt(provider);
          // Validated through the wrapper: a decrypted spec has no wire form, so
          // there is no blob to hand a validator. Same rules, no plaintext bytes.
          decrypted.validateContents({ purpose: 'gossip' });
        } catch (err) {
          // A bad message is a rejection, and the caller logs a RETURNED Error
          // with the hash and sender IP where a throw reaches a bare log.error.
          // But a TypeError here is our bug, not a bad message: returning it
          // would bury a defect under a stream of peer rejections, so it stays
          // loud.
          if (err instanceof TypeError || err instanceof ReferenceError) throw err;
          return new Error(`Invalid encrypted Flux App message: ${err.message}`);
        }
      }
    } else {
      // deserializeTempMessage already validated this spec by constructing it.
      specReadable = true;
    }

    let previousState = null;
    if (!appEvent.isRegistration) {
      // Who this update has to be signed by. A live message is judged against
      // the app that holds the name NOW — its active registry row, or, when the
      // list carries none, the app that last held the name, so a renewal of an
      // expired app is taken and relayed. A message already on chain is a
      // replay: the node is catching up on something the network accepted at a
      // past height, so it is judged against the state at that height
      // (isAppRequested is set from the confirming block, so `block` is that
      // height rather than the tip).
      previousState = isAppRequested
        ? await getStateBeforeHeight(appEvent.spec.name, block)
        : (await appRecords.registry().byName(appEvent.spec.name)) ?? (await latestAppliedState(appEvent.spec.name));
      if (!previousState) {
        log.info(`Queueing update for ${appEvent.spec.name} - no app of that name is listed or was applied`);
        globalState.queuePendingUpdate(appEvent.spec.name, message, block);
        return false;
      }
    }

    if (specReadable) {
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
      verifyHash: false,
      // The same flag that decides which state this is judged against decides
      // which door it came in by: requested means the node is catching up on
      // something the network already accepted, anything else is live traffic
      // the node is being asked to relay.
      allowLegacyEncoding: isAppRequested,
    });
  }

  const serialized = appEvent.serialize();
  const value = {
    type: serialized.type,
    version: serialized.version,
    appSpecifications: serialized.appSpecifications,
    hash: serialized.hash,
    timestamp: serialized.timestamp,
    signature: serialized.signature,
    receivedAt: new Date(),
    payableUntil: temporaryPoolSweep.payableUntil(serialized.timestamp),
    arcaneAttestation: serialized.arcaneAttestation,
  };
  if (serialized.contentHash !== undefined) {
    value.contentHash = serialized.contentHash;
    value.extend = serialized.extend;
  }
  if (serialized.contentManifest !== undefined) value.contentManifest = serialized.contentManifest;

  database = db.db(config.get('database.appsglobal.database'));
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
    if (message.apps.length > config.get('fluxapps.maxAppsPerNode')) {
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
  const database = db.db(config.get('database.appsglobal.database'));

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
 * Store app installing message, or apply a version 2 withdrawal of one.
 *
 * A node claims an app before it knows whether it is needed - the claim is what
 * lets every contender see the contention - so losing that race is ordinary and
 * has to be retractable. Version 2 carries that retraction as `withdrawn: true`,
 * which is what 8.18.0 already puts on the wire, and it removes the sender's claim
 * instead of recording one.
 *
 * v9 also uses version 2 for a RENEWABLE claim (announcedAt + periodic
 * re-broadcast), announced only to appInstallingClaims-capable peers, so a
 * long install keeps its seat instead of ageing out mid-pull. A node that does
 * not know the version never receives that form.
 *
 * A claim stays at version 1 for everyone else on purpose. Moving all claims to 2
 * would have nodes that do not know the version reject them, and they would stop
 * seeing contention at all - so the retraction is what carries the new version, and a
 * node that rejects it simply lets the claim expire as it does today.
 *
 * Never an installing ERROR. That message means an install was attempted and
 * failed, it is counted as such, and a node standing aside has attempted
 * nothing - counting it would turn the apps most in demand, whose races have
 * the most losers, into the apps that look most broken.
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
  * @param withdrawn boolean (optional) - retract the claim with no verdict on the app,
  *   unlike fluxappinstallingerror which also feeds peers' error counting; tagged
  *   withdrawals release exactly their replica's seat, untagged release every
  *   (name, ip) row. A retraction carries no
  *   announcedAt because it asserts no claim.
  */
  if (!message || typeof message !== 'object' || typeof message.type !== 'string' || typeof message.version !== 'number'
    || typeof message.broadcastedAt !== 'number' || typeof message.ip !== 'string' || typeof message.name !== 'string') {
    return new Error('Invalid Flux App Installing message for storing');
  }

  if (message.version !== 1 && message.version !== 2) {
    return new Error(`Invalid Flux App Installing message for storing version ${message.version} not supported`);
  }

  // A v2 message is either a CLAIM (announcedAt required - it is the election key) or a
  // RETRACTION, spelled `withdrawn` - 8.18.0's spelling, and the only one, so that the
  // two halves of this file cannot disagree about which is which. Neither carries
  // announcedAt.
  const withdrawn = message.version === 2 && message.withdrawn === true;

  if (message.version === 2 && !withdrawn && typeof message.announcedAt !== 'number') {
    return new Error('Invalid Flux App Installing message for storing announcedAt required for version 2');
  }

  if (!broadcastedAtUsable(message.broadcastedAt, GOSSIP_VALIDITY_MS)) {
    log.warn(`Rejecting old/future/not valid fluxappinstalling message, message:${JSON.stringify(message)}`);
    return false;
  }

  const db = dbHelper.databaseConnection();
  const database = db.db(config.get('database.appsglobal.database'));

  // Peer input: normalize the identity tag tolerantly (a malformed tag degrades to
  // the untagged row) - the local writer's store (registryManager) is the strict one.
  const replica = message.version === 2 && typeof message.replica === 'string' ? message.replica : null;

  if (withdrawn) {
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
    // Carried on both deletes rather than rested on the read above. The read proves
    // the stored claim was not newer a moment ago; the guard proves it at the moment
    // of deletion, which is what the batch path does and what closes the window where
    // a newer claim lands in between. The broadcast row needs it in its own right too
    // - it is a separate collection written by a separate path, so a claim newer than
    // this clear can exist there while the location the read consulted is still old.
    // `$lte`, not `$lt`: the read lets an equal timestamp clear win (the emitter
    // sequences the clear after its own announce), so the equal row must go too.
    const notNewerThanClear = { broadcastedAt: { $lte: clearedAt } };
    await dbHelper.removeDocumentsFromCollection(
      database, globalAppsInstallingLocations, { ...clearQuery, ...notNewerThanClear },
    );
    await dbHelper.removeDocumentsFromCollection(
      database, appsInstallingBroadcasts, { ...broadcastQuery, ...notNewerThanClear },
    );
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
  const database = db.db(config.get('database.appsglobal.database'));

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
    const database = db.db(config.get('database.appsglobal.database'));

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

async function handleAppRemovedStateEvent({ message, envelope }) {
  if (!message || !message.ip || !message.appName || !message.broadcastedAt) return;
  try {
    const db = dbHelper.databaseConnection();
    const database = db.db(config.get('database.appsglobal.database'));
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

async function handleIPChangedEvent({ message, envelope }) {
  if (!message || !message.oldIP || !message.newIP || !message.broadcastedAt) return;
  try {
    const db = dbHelper.databaseConnection();
    const database = db.db(config.get('database.appsglobal.database'));
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

/**
 * A node's own statement that it is alive: the refutation of any node-down
 * certificate about it stamped at or before it, whether or not the node runs
 * an app. One row per node, newest wins, kept as long as a certificate it can
 * refute stands. Keyed on the announcer's outpoint, so an unresolved announcer
 * refutes nobody.
 */
async function handleNodeAliveEvent({ message, envelope, announcer }) {
  const outpoint = outpointOf(announcer);
  if (!message || !message.ip || !outpoint) return { isNewer: false };
  if (!broadcastedAtUsable(message.broadcastedAt, RECORD_LIFETIME_MS)) return { isNewer: false };
  try {
    const db = dbHelper.databaseConnection();
    const database = db.db(config.get('database.appsglobal.database'));
    const dedupKey = `nodealive:${outpoint}`;
    const prior = await dbHelper.findOneAndUpdateInDatabase(
      database, globalAppStateEvents,
      { type: APP_STATE_EVENT_TYPES.NODEALIVE, dedupKey },
      buildConditionalUpsert(message.broadcastedAt, {
        ip: message.ip, outpoint, type: APP_STATE_EVENT_TYPES.NODEALIVE, dedupKey,
        broadcastedAt: new Date(message.broadcastedAt),
        expireAt: new Date(message.broadcastedAt + RECORD_LIFETIME_MS),
        data: message, envelope: envelope ?? null,
      }, { alwaysSetFields: { receivedAt: new Date() } }),
      { upsert: true, returnDocument: 'before', projection: { _id: 0, broadcastedAt: 1 } },
    );
    const priorAt = prior && prior.broadcastedAt ? new Date(prior.broadcastedAt).getTime() : 0;
    return { isNewer: message.broadcastedAt > priorAt };
  } catch (err) {
    log.error(`storeAppStateEvent(nodealive): ${err.message}`);
    return { isNewer: false };
  }
}

/**
 * Newer-wins on ORDINAL FIELDS, most significant first, with the broadcast
 * time only breaking full ties. The record's authority is its ordinals — a
 * masterlease's (generation, epoch), a generation record's generation — so
 * a successor that is ahead on any ordinal (with everything above it equal)
 * replaces the old record however their clocks compare, and a republish of
 * the SAME ordinals (later broadcast) refreshes the row without ever
 * letting a stale clock un-seat a successor. Each ordinal names what an
 * ABSENT stored value counts as, so a field added later compares against
 * old rows as the value they implicitly carried.
 *
 * @param {Array<{field: string, value: number, absent: number, path?: string}>} ordinals
 *   each compared against the stored `data.<field>`, or against `path` on the
 *   row itself for an ordinal the node derives rather than one the record carries
 */
function buildOrdinalConditionalUpsert(ordinals, broadcastedAt, conditionalFields, options = {}) {
  const alwaysSetFields = options.alwaysSetFields ?? {};
  const incomingDate = new Date(broadcastedAt);
  const stored = ordinals.map(({ field, absent, path }) => ({ $ifNull: [`$${path ?? `data.${field}`}`, absent] }));
  const equalThrough = (count) => ordinals
    .slice(0, count)
    .map(({ value }, i) => ({ $eq: [value, stored[i]] }));
  const branches = ordinals.map(({ value }, i) => ({
    $and: [...equalThrough(i), { $gt: [value, stored[i]] }],
  }));
  branches.push({
    $and: [
      ...equalThrough(ordinals.length),
      { $gt: [incomingDate, { $ifNull: ['$broadcastedAt', new Date(0)] }] },
    ],
  });
  const isNewer = { $or: branches };
  const set = Object.fromEntries(
    Object.entries(conditionalFields).map(([k, v]) => [k, { $cond: [isNewer, v, { $ifNull: [`$${k}`, v] }] }]),
  );
  Object.assign(set, alwaysSetFields);
  return [{ $set: set }];
}

async function handleMasterleaseEvent({ message, envelope, announcer }) {
  if (!message || !message.ip || !message.identity || !message.role || !message.grantee) return;
  if (!Number.isSafeInteger(message.epoch) || message.epoch < 1) return;
  if (message.mode !== 'held' && message.mode !== 'oneshot') return;
  if (!Number.isSafeInteger(message.broadcastedAt)) return;
  if (message.mode === 'held' && (!Number.isSafeInteger(message.ttlMs) || message.ttlMs < 1)) return;
  if (message.generation !== undefined
    && (!Number.isSafeInteger(message.generation) || message.generation < 0)) return;
  // A released record is an ordinal given back (uninstall) or reclaimed (a
  // node-down certificate): same row, same epoch, a newer broadcast, and the
  // flag is what readers of the ordinal- prefix skip. Boolean or absent;
  // anything else is a malformed record and is dropped whole.
  if (message.released !== undefined && typeof message.released !== 'boolean') return;
  // The roster is optional and shape-gated only: its signatures verify at
  // read time against the membership the fingerprint names, which a late
  // reader may resolve when this node cannot. A record wearing a malformed
  // roster is dropped whole — a half-trusted record is worse than none.
  if (message.roster !== undefined
    && (!message.roster || !rosterOverlay.chainWellFormed(message.roster.chain))) return;
  // The grantee is a CLAIM; the signer is the FACT. The envelope binds the
  // signer to the node listed at the record's ip and verifies nothing else,
  // and every reader acts on the grantee — the reconciler's veto, the
  // coordinator's primary intent, the re-rolled seat's exemption — so a
  // record that names anyone but its own announcer is dropped whole. A
  // released row is the one exception: a vacate is published by whichever
  // node holds the certificate, about the node it removed. The local publish
  // is this node's own grant and not a network record.
  const local = announcer === LOCAL_ANNOUNCER;
  const announced = local ? null : outpointOf(announcer);
  if (!local && message.released !== true && announced !== message.grantee) {
    fluxEventBus.publish('quorumGrant:masterleaseDropped', {
      identity: message.identity,
      role: message.role,
      grantee: message.grantee,
      announcer: announced,
      reason: announced ? 'record names a grantee other than its announcer' : 'no resolved announcer',
    });
    return;
  }
  // The grantee is a claim; the granting committee's signed term acceptances
  // are the proof. A held record carries a quorum of them, verified against
  // the membership its fingerprint names, and a record that fails is dropped
  // whole. A membership this node cannot rebuild — before its boot, or past
  // its window — stores the record UNVERIFIED, ranked below any verified one
  // of its generation. Released rows and founding records carry no term.
  const proving = message.mode === 'held' && message.released !== true;
  let verified = false;
  if (proving) {
    const carried = {
      fingerprint: message.fingerprint,
      generation: message.generation ?? 0,
      epoch: message.epoch,
      roster: message.roster ?? null,
      acceptances: message.acceptances,
    };
    const dropped = (reason) => fluxEventBus.publish('quorumGrant:masterleaseDropped', {
      identity: message.identity, role: message.role, grantee: message.grantee, announcer: announced, reason,
    });
    if (!rosterOverlay.credentialWellFormed(carried)) {
      dropped('malformed acceptances');
      return;
    }
    const membership = networkStateService.membershipAt(message.fingerprint);
    if (membership) {
      const proved = rosterOverlay.verifyTermCredential(membership, `${message.identity}/${message.role}`, carried, {
        committeeSize: config.get('fluxapps.quorumGrantHeldCommitteeSize'),
        candidate: message.grantee,
        expectedGeneration: carried.generation,
      });
      if (!proved) {
        dropped('acceptances do not verify against the granting committee');
        return;
      }
      verified = true;
    } else {
      fluxEventBus.publish('quorumGrant:masterleaseUnverified', {
        identity: message.identity, role: message.role, grantee: message.grantee, fingerprint: message.fingerprint,
      });
    }
  }
  try {
    const db = dbHelper.databaseConnection();
    const database = db.db(config.get('database.appsglobal.database'));
    const dedupKey = `masterlease:${message.identity}/${message.role}`;
    // One row per app/role — the record names the MASTER, not a node, so the
    // query carries no ip: a successor's record replaces the deposed
    // master's rather than accumulating beside it. Durable until superseded,
    // held and founding alike: the record says WHO holds the term, never
    // whether they still stand — liveness is asked of the referees, so the
    // row carries no expiry and nothing depends on a sweeper reaping it.
    // Generation orders ahead of epoch: a re-rolled world's first grant
    // replaces the retired world's record however high its epoch climbed.
    // Within a generation a verified record outranks an unverified one; a
    // released row or a founding record carries no term to prove and ranks
    // as verified, so a release still supersedes the term it ends. The
    // comparator's field is the numeric proofRank — the database orders a
    // number against a boolean by type, never by value. Both it and the
    // verdict sit on the row beside `data`, never inside it: `data` is the
    // signed payload exactly, which is what a peer re-verifies when this row
    // is served to it in a sync.
    const proofRank = proving && !verified ? 0 : 1;
    await database.collection(globalAppStateEvents).updateOne(
      { type: APP_STATE_EVENT_TYPES.MASTERLEASE, dedupKey },
      buildOrdinalConditionalUpsert([
        { field: 'generation', value: message.generation ?? 0, absent: 0 },
        { field: 'proofRank', path: 'proofRank', value: proofRank, absent: 0 },
        { field: 'epoch', value: message.epoch, absent: -1 },
      ], message.broadcastedAt, {
        ip: message.ip,
        outpoint: announced,
        type: APP_STATE_EVENT_TYPES.MASTERLEASE,
        dedupKey,
        broadcastedAt: new Date(message.broadcastedAt),
        envelope: envelope ?? null,
        data: message,
        proofRank,
        verified: proving ? verified : null,
        // In alwaysSetFields, never a conditional field: a conditional slot
        // keeps the stored value on a losing touch, so a row carrying a Date
        // here would keep being reaped by the collection's TTL index until a
        // strictly newer record happened to arrive. Cleared on EVERY touch —
        // boot sync re-delivers these records, so every row is touched. The
        // TTL monitor skips non-date values.
      }, { alwaysSetFields: { receivedAt: new Date(), expireAt: null } }),
      { upsert: true },
    );
  } catch (err) {
    log.error(`storeAppStateEvent(masterlease): ${err.message}`);
  }
}

// Product-side listeners for a generation record standing for its key —
// how a holder hears that the world its term was granted in has ended,
// registered by the service wiring. The bus event beside the write is
// harness observability only and carries nothing in production.
const grantGenerationListeners = new Set();

/**
 * Register a listener for `{identity, role, generation}`, called whenever a
 * written generation record is the standing one for its key afterwards — a
 * fresh arrival and a re-delivery alike, so listeners must be idempotent.
 * Returns the unregister function.
 */
function onGrantGenerationRecord(listener) {
  grantGenerationListeners.add(listener);
  return () => grantGenerationListeners.delete(listener);
}

function notifyGrantGenerationListeners(event) {
  grantGenerationListeners.forEach((listener) => {
    try {
      Promise.resolve(listener(event)).catch((error) => {
        log.warn(`grantgeneration listener failed: ${error.message}`);
      });
    } catch (error) {
      log.warn(`grantgeneration listener failed: ${error.message}`);
    }
  });
}

async function handleGrantGenerationEvent({ message, envelope }) {
  if (!(await ownerGenerationRecord.wellFormed(message))) return;
  if (!Number.isSafeInteger(message.broadcastedAt)) return;
  try {
    // The signer is an OWNER of the app, and the owners come from this node's
    // own applied history — never from the record, or anyone could name a
    // friendly "owner". No app here means nothing to verify against: drop,
    // and sync delivers the spec before the record matters. Say WHICH drop
    // this was — a record that never arrived and one dropped for a missing
    // spec are indistinguishable from outside, and the ambiguity cost two
    // fleet runs. publish() is a no-op outside the harness.
    const app = await appRecords.registry().byIdentity(message.identity);
    const owners = app ? await appHistory.ownerships(app.name) : [];
    const dropped = (reason) => fluxEventBus.publish('quorumGrant:generationRecordDropped', {
      identity: message.identity, role: message.role, generation: message.generation, reason,
    });
    if (!app || owners.length === 0) { dropped('no spec to resolve the owner against'); return; }
    let signer = null;
    for (const { owner } of owners) {
      // eslint-disable-next-line no-await-in-loop
      if (await ownerGenerationRecord.verify(message, owner)) { signer = owner; break; }
    }
    if (!signer) { dropped('no owner of the app signed it'); return; }
    // The ownership height inside the signed text is a height at which the
    // signer took the app, never trusted from the record alone.
    if (!owners.some((o) => o.owner === signer && o.from === message.ownedFrom)) {
      dropped('ownedFrom is not a height at which the signer took the app');
      return;
    }

    // Every record the node takes is kept: one row per record, keyed by its
    // hash, so a record the listed row stops validating is set aside and
    // stands again should the row return to its signer. Which one the node
    // stands on is derived at read (standingGeneration), never chosen here.
    const hash = await ownerGenerationRecord.hash(message);
    const db = dbHelper.databaseConnection();
    const database = db.db(config.get('database.appsglobal.database'));
    const dedupKey = `grantgeneration:${message.identity}/${message.role}/${hash}`;
    await dbHelper.updateOneInDatabase(
      database, globalAppStateEvents,
      { type: APP_STATE_EVENT_TYPES.GRANTGENERATION, dedupKey },
      {
        $setOnInsert: {
          type: APP_STATE_EVENT_TYPES.GRANTGENERATION,
          dedupKey,
          identity: message.identity,
          role: message.role,
          hash,
          signer,
          broadcastedAt: new Date(message.broadcastedAt),
          envelope: envelope ?? null,
          data: message,
        },
        // Cleared on EVERY touch, never only on insert: a row carrying a Date
        // here would be reaped by the collection's TTL index, and boot sync
        // re-delivers these records, so every row is touched.
        $set: { receivedAt: new Date(), expireAt: null },
      },
      { upsert: true },
    );

    fluxEventBus.publish('quorumGrant:generationRecord', {
      identity: message.identity, role: message.role, generation: message.generation,
    });

    // Whether THIS record is the one the node now stands on.
    const { record: standing } = await standingGeneration(message.identity, message.role);
    if (standing && standing.hash === hash) {
      notifyGrantGenerationListeners({
        identity: message.identity, role: message.role, generation: message.generation,
      });
      // In-window processors re-materialize the founding committee at the
      // record's named height; late ones store the record and answer honestly
      // until they can.
      if (message.role === 'founder') {
        await foundingCommittee.materializeGeneration(message);
      }
    }
  } catch (err) {
    log.error(`storeAppStateEvent(grantgeneration): ${err.message}`);
  }
}

/**
 * The record a node stands on for one app role, derived from what it holds
 * and what the chain says: the highest-ranked record (ownership height, then
 * generation) the listed row validates, which is one the listed owner signed
 * or the one the listed spec's grants block names. `record` is null and
 * `aside` false when the app stands on its registration (generation 0, no
 * record); `aside` is true when the spec names a record this node lacks, and
 * the node serves nothing for the role until it arrives.
 *
 * `ownership` is who holds the app and from which height, and whether the app
 * has changed hands: what the named committee's drain is read from.
 *
 * @returns {Promise<{record: ?object, aside: boolean, ownership: ?{owner: string, from: number, transferred: boolean}}>}
 */
async function standingGeneration(identity, role) {
  const app = await appRecords.registry().byIdentity(identity);
  if (!app) return { record: null, aside: false, ownership: null };
  const owners = await appHistory.ownerships(app.name);
  const listed = owners.length ? owners[owners.length - 1] : null;
  const ownership = listed ? { owner: listed.owner, from: listed.from, transferred: owners.length > 1 } : null;
  const grants = app.grants ?? app.spec?.grants ?? null;
  const namedHash = grants && typeof grants[role] === 'string' ? grants[role] : null;
  const db = dbHelper.databaseConnection();
  const database = db.db(config.get('database.appsglobal.database'));
  const rows = await dbHelper.findInDatabase(
    database, globalAppStateEvents,
    { type: APP_STATE_EVENT_TYPES.GRANTGENERATION, identity, role },
    { projection: { _id: 0 } },
  );
  const { ownerSignedIsValid, generationRecordRank, outranks } = await getSpec();
  const valid = rows.filter((row) => ownerSignedIsValid(
    { identity, hash: row.hash },
    { appIdentity: identity, listedOwnerSigned: row.signer === app.owner, namedHash },
  ));
  if (valid.length === 0) return { record: null, aside: namedHash !== null, ownership };
  let record = valid[0];
  for (const row of valid.slice(1)) {
    if (outranks(generationRecordRank(row.data), generationRecordRank(record.data))) record = row;
  }
  return { record, aside: false, ownership };
}

/** Every generation record this node holds for one app role. */
async function heldGenerationRecords(identity, role) {
  const db = dbHelper.databaseConnection();
  const database = db.db(config.get('database.appsglobal.database'));
  return dbHelper.findInDatabase(
    database, globalAppStateEvents,
    { type: APP_STATE_EVENT_TYPES.GRANTGENERATION, identity, role },
    { projection: { _id: 0 } },
  );
}

const GENERATION_ROLES = ['master', 'founder'];

/**
 * The row of an app was written with a new owner: what this node stands on
 * for each role follows from what it holds and the new row. It asks a sample
 * of nodes for every record they hold for the app, keeps what it lacked, and
 * tells the holder's listeners the standing generation of each role, so a
 * running primary steps across to the named committee as it does at a
 * re-roll.
 */
async function rejudgeGenerationRecords(identity) {
  await askPeersForGenerationRecords(identity);
  for (const role of GENERATION_ROLES) {
    // eslint-disable-next-line no-await-in-loop
    const { record } = await standingGeneration(identity, role);
    notifyGrantGenerationListeners({ identity, role, generation: record?.data?.generation ?? 0 });
  }
}

const RECORD_ASK_PEERS = 8;
const RECORD_ASK_TIMEOUT_MS = 5000;

/**
 * Ask a sample of listed nodes for every generation record they hold for an
 * app, and keep each one this node can validate. A peer answers with its
 * history, not only its standing record, so a peer behind the chain still
 * serves the one the new row names.
 */
async function askPeersForGenerationRecords(identity) {
  const peers = await networkStateService.getRandomSocketAddressSample(RECORD_ASK_PEERS, {});
  await Promise.all((peers || []).map(async (peer) => {
    for (const role of GENERATION_ROLES) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const response = await serviceHelper.axiosGet(
          `http://${extractIp(peer)}:${extractPort(peer)}/apps/grantgeneration/${encodeURIComponent(identity)}/${role}`,
          { timeout: RECORD_ASK_TIMEOUT_MS },
        );
        const records = response?.data?.data?.records;
        if (!Array.isArray(records)) continue;
        for (const record of records) {
          // eslint-disable-next-line no-await-in-loop
          await handleGrantGenerationEvent({ message: record, envelope: null });
        }
      } catch (error) {
        log.warn(`grantgeneration ask: ${peer} ${role} - ${error.message ?? error}`);
      }
    }
  }));
}

/**
 * The owner generation record one app role stands on, or null.
 */
async function getGrantGenerationRecord(identity, role) {
  return (await standingGeneration(identity, role)).record;
}

/**
 * The published grant record for one app role, or null. What standbys, FDM
 * and re-pinned committees consult — public fact, one row, newest epoch.
 */
async function getMasterleaseRecord(identity, role) {
  const db = dbHelper.databaseConnection();
  const database = db.db(config.get('database.appsglobal.database'));
  return database.collection(globalAppStateEvents).findOne(
    { type: APP_STATE_EVENT_TYPES.MASTERLEASE, dedupKey: `masterlease:${identity}/${role}` },
    { projection: { _id: 0 } },
  );
}

/**
 * Every published record whose role starts with a prefix — the founder
 * plane's world scan: `founder-<token>@` collects one world's record at
 * EVERY rung, including rungs this node's own ladder never minted. A
 * rejoining pocket learns a flip from the RECORD, not from its own
 * evaluator (post-heal its old committee stands again, so its evaluator
 * rightly never mints the rung); the world scan is what makes
 * newest-decided-wins knowledge-driven rather than ladder-driven.
 */
/**
 * Every published record of one role prefix naming one grantee, across every
 * app — what the ordinal plane reads when a certificate about a node lands:
 * the ordinals that node holds, each of which is to be vacated. The prefix is
 * matched inside the dedup key after the app segment.
 *
 * @param {string} rolePrefix e.g. `ordinal-`
 * @param {string} grantee collateral outpoint
 * @returns {Promise<object[]>}
 */
async function getMasterleaseRecordsByGrantee(rolePrefix, grantee) {
  const db = dbHelper.databaseConnection();
  const database = db.db(config.get('database.appsglobal.database'));
  const escaped = rolePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return database.collection(globalAppStateEvents)
    .find(
      {
        type: APP_STATE_EVENT_TYPES.MASTERLEASE,
        dedupKey: { $regex: `^masterlease:[^/]+/${escaped}` },
        'data.grantee': grantee,
      },
      { projection: { _id: 0 } },
    )
    .toArray();
}

async function getMasterleaseRecordsByRolePrefix(identity, rolePrefix) {
  const db = dbHelper.databaseConnection();
  const database = db.db(config.get('database.appsglobal.database'));
  const escaped = `masterlease:${identity}/${rolePrefix}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return database.collection(globalAppStateEvents)
    .find(
      { type: APP_STATE_EVENT_TYPES.MASTERLEASE, dedupKey: { $regex: `^${escaped}` } },
      { projection: { _id: 0 } },
    )
    .toArray();
}

function storeAppStateEvent(type, payload) {
  switch (type) {
    case APP_STATE_EVENT_TYPES.APPRUNNING: return handleAppRunningEvent(payload);
    case APP_STATE_EVENT_TYPES.APPREMOVED: return handleAppRemovedStateEvent(payload);
    case APP_STATE_EVENT_TYPES.IPCHANGED: return handleIPChangedEvent(payload);
    case APP_STATE_EVENT_TYPES.MASTERLEASE: return handleMasterleaseEvent(payload);
    case APP_STATE_EVENT_TYPES.GRANTGENERATION: return handleGrantGenerationEvent(payload);
    case APP_STATE_EVENT_TYPES.NODEALIVE: return handleNodeAliveEvent(payload);
    default: log.error(`storeAppStateEvent: unknown type ${type}`); return undefined;
  }
}

async function storeBatchAppRunningEvents(verifiedBroadcasts, announcers = new Map()) {
  if (verifiedBroadcasts.length === 0) return { stored: 0 };
  const db = dbHelper.databaseConnection();
  const database = db.db(config.get('database.appsglobal.database'));

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

/**
 * This node's own latest running announcement as it was broadcast, the
 * envelope around the payload, for a holder to carry on its grant asks
 * (grantClient.holdingEvidence); null before the first announcement.
 * @param {string} ip this node's socket address as it announces it
 * @returns {Promise<object|null>} a verifiable fluxapprunning broadcast
 */
async function appRunningBroadcastOf(ip) {
  const db = dbHelper.databaseConnection();
  const database = db.db(config.get('database.appsglobal.database'));
  const event = await database.collection(globalAppStateEvents).findOne(
    { ip, type: APP_STATE_EVENT_TYPES.APPRUNNING, dedupKey: 'v2' },
    { projection: { _id: 0, envelope: 1, data: 1 } },
  );
  if (!event?.envelope || !event.data) return null;
  return { ...event.envelope, data: event.data };
}

function storeSignedAppInstallingBroadcast(signedBroadcast) {
  const { data } = signedBroadcast;
  if (!data || !data.ip || !data.name || !data.broadcastedAt) return;
  // A retraction: storeAppInstallingMessage already deleted the archived announce,
  // and archiving the withdrawal would re-serve a dead claim over sync.
  if (data.withdrawn === true) return;
  if (data.broadcastedAt + INSTALLING_EXPIRY_MS < Date.now()) return;
  const db = dbHelper.databaseConnection();
  const database = db.db(config.get('database.appsglobal.database'));
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
  const database = db.db(config.get('database.appsglobal.database'));

  const signedOps = [];
  const locationOps = [];

  const withdrawalOps = [];

  for (const broadcast of verifiedBroadcasts) {
    const { data } = broadcast;
    if (!broadcastedAtUsable(data.broadcastedAt, INSTALLING_EXPIRY_MS)) continue;
    const validTill = data.broadcastedAt + INSTALLING_EXPIRY_MS;

    // The claim identity: one archived announce and one location row per replica;
    // null (loose / v1) matches legacy docs stored without the field.
    const replica = typeof data.replica === 'string' ? data.replica : null;

    // A v2 RETRACTION. Reaching the claim path with one would archive the very claim
    // it retracts, so it is deleted here instead - and only where the stored claim is
    // older, so a retraction arriving after the sender has claimed again cannot erase
    // the newer claim. Anything else at v2 is a CLAIM and is stored below.
    //
    // There used to be a `data.cleared === true` skip ABOVE this, from the side of the
    // merge that had no retraction handling at all. It shadowed this branch for one of
    // the two spellings: a `withdrawn` retraction deleted the claim here, a `cleared`
    // one was skipped and silently dropped, while the comment called the pair
    // symmetric. One spelling makes that unconstructible, which is the argument for
    // the rename rather than a patch.
    if (data.version === 2 && data.withdrawn === true) {
      withdrawalOps.push({
        // deleteMANY: a tagged retraction releases exactly its replica's seat, an
        // untagged one releases every (name, ip) row - the v1/loose whole-app
        // semantics, which under per-replica keying is more than one document.
        deleteMany: {
          filter: {
            name: data.name,
            ip: data.ip,
            ...(replica !== null ? { replica } : {}),
            broadcastedAt: { $lt: new Date(data.broadcastedAt) },
          },
        },
      });
      continue;
    }

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
  // after the claims, so a claim and its withdrawal arriving in one batch settle
  // in the order they were sent rather than the order they were read
  if (withdrawalOps.length > 0) {
    await database.collection(globalAppsInstallingLocations).bulkWrite(withdrawalOps, { ordered: false })
      .catch((err) => log.error(`storeBatchAppInstallingMessages withdrawals: ${err.message}`));
    await database.collection(appsInstallingBroadcasts).bulkWrite(
      // The location's own guard, carried over rather than restated: the
      // broadcast is what proves the location, so deleting one without the
      // other leaves a claim nothing can serve during sync. Same object, so
      // the two cannot come apart.
      withdrawalOps.map((op) => ({
        deleteMany: {
          filter: {
            'data.name': op.deleteMany.filter.name,
            'data.ip': op.deleteMany.filter.ip,
            ...('replica' in op.deleteMany.filter
              ? { 'data.replica': op.deleteMany.filter.replica } : {}),
            broadcastedAt: op.deleteMany.filter.broadcastedAt,
          },
        },
      })),
      { ordered: false },
    ).catch((err) => log.error(`storeBatchAppInstallingMessages withdrawal broadcasts: ${err.message}`));
  }
  return { stored: signedOps.length + withdrawalOps.length };
}

function storeSignedAppInstallingErrorBroadcast(signedBroadcast) {
  const { data } = signedBroadcast;
  if (!data || !data.ip || !data.name || !data.hash || !data.broadcastedAt) return;
  if (data.broadcastedAt + INSTALLING_ERRORS_EXPIRY_MS < Date.now()) return;
  const db = dbHelper.databaseConnection();
  const database = db.db(config.get('database.appsglobal.database'));
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
  const database = db.db(config.get('database.appsglobal.database'));

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
  processPendingUpdates,
  releaseInstallingClaims,
  storeAppStateEvent,
  storeBatchAppRunningEvents,
  appRunningBroadcastOf,
  APP_STATE_EVENT_TYPES,
  storeAppInstallingMessage,
  storeSignedAppInstallingBroadcast,
  storeBatchAppInstallingMessages,
  storeAppRemovedMessage,
  storeAppInstallingErrorMessage,
  storeSignedAppInstallingErrorBroadcast,
  storeBatchAppInstallingErrorMessages,
  storeIPChangedMessage,
  getMasterleaseRecord,
  getMasterleaseRecordsByRolePrefix,
  getMasterleaseRecordsByGrantee,
  getGrantGenerationRecord,
  standingGeneration,
  heldGenerationRecords,
  rejudgeGenerationRecords,
  askPeersForGenerationRecords,
  onGrantGenerationRecord,
  LOCAL_ANNOUNCER,
};
