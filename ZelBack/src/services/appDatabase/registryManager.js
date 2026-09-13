'use strict';

const config = require('config');
const dbHelper = require('../dbHelper');
const appsMaintenance = require('./appsMaintenance');
const appsRepository = require('./appsRepository');
const foundingCommittee = require('../appMesh/foundingCommittee');
const log = require('../../lib/log');
const messageHelper = require('../messageHelper');
const serviceHelper = require('../serviceHelper');
const verificationHelper = require('../verificationHelper');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const { getSpec, getSpecBackend } = require('../utils/specLibs');
const specCutover = require('../utils/specCutover');
const legacyTransportProvider = require('../providers/FluxOSLegacyTransportProvider');
const transportCryptoProvider = require('../providers/FluxOSTransportProvider');
const { resolveStorageRefs } = require('../utils/fluxStorageRefs');
const fluxEventBus = require('../utils/fluxEventBus');
const contentSlotService = require('../appLifecycle/contentSlotService');
const {
  globalAppsInformation,
  localAppsInformation,
  globalAppsMessages,
  globalAppsInstallingLocations,
  globalAppsInstallingBroadcasts,
  globalAppsInstallingErrorsLocations,
  globalAppsInstallingErrorsBroadcasts,
  appsHashesCollection,
  scannedHeightCollection,
  INSTALLING_EXPIRY_MS,
} = require('../utils/appConstants');
const { Privilege, authOf } = require('../utils/privileges');

let reindexRunning = false;

// Control-plane hook fired after a global app spec is committed. Wired by
// serviceManager to the spawner so a spec this node must install can wake the
// spawn loop immediately instead of waiting for the next poll. Distinct from the
// fluxEventBus 'app:specStored' event (test-observability only, a no-op in prod).
let onSpecStored = null;

/**
 * Register the spec-stored control hook. Single-slot (last wins), matching the
 * setOn* idiom used by appInstaller/appReconciler/appUninstaller.
 * @param {(specDoc: object) => void} callback
 */
function setOnSpecStored(callback) {
  onSpecStored = callback;
}

/**
 * Fire the spec-stored hook with the committed spec doc. Best-effort: a throwing
 * hook is logged and swallowed so it can never break the spec-store path.
 * @param {object} specDoc - the spec doc just written to globalAppsInformation
 */
function emitSpecStored(specDoc) {
  if (!onSpecStored) return;
  try {
    onSpecStored(specDoc);
  } catch (error) {
    log.error(`emitSpecStored callback error: ${error.message}`);
  }
}

/**
 * The single funnel for every global app-spec write: persist through the registry,
 * then fire the spec-stored hook. Routing all four store paths through here keeps
 * the spawner-wake notification from being forgotten by any one of them, and keeps
 * the write going through appsRepository rather than raw dbHelper.
 * @param {object} specDoc - serialized spec doc to persist
 * @param {{upsert?: boolean}} [options] - upsert:false for update-only writes
 * @returns {Promise<void>}
 */
async function storeGlobalSpec(specDoc, options) {
  await appsRepository.upsertGlobalAppInfo(specDoc, options);
  // Referee-side founding state derives from public metadata alone (name,
  // height, version), so every node records the anchor, encrypted specs
  // included; the component mapping is host-side and follows below.
  await foundingCommittee.recordAnchor(specDoc);
  await materializeFoundingView(specDoc);
  emitSpecStored(specDoc);
}

/**
 * Maintain the host-side component mapping from the CLEARTEXT view of the
 * spec just stored. Decryption is local, with this node's own provider —
 * the same resolution every mesh consumer already performs — and a node
 * that cannot decrypt maintains no mapping, which is the component-blind
 * design and not a gap: only hosts answer founder asks, and only hosts
 * can. No-throw — a failed resolution never fails a spec store.
 */
async function materializeFoundingView(specDoc) {
  try {
    const instantiated = await appsRepository.getGlobalAppInfo(specDoc.name);
    if (!instantiated) return;
    const view = await specCutover.resolveInstantiatedSpec(instantiated);
    if (!view) return;
    await foundingCommittee.applyComponentView({
      name: specDoc.name,
      height: specDoc.height,
      network: view.network,
      components: view.components,
    });
  } catch (error) {
    log.warn(`materializeFoundingView - ${specDoc?.name}: ${error.message}`);
  }
}

/**
 * Get all app hashes from the blockchain
 * @param {object} _req - Request object (unused)
 * @param {import('express').Response} res
 * @returns {Promise<object>} List of app hashes
 */
async function getAppHashes(_req, res) {
  try {
    const dbopen = dbHelper.databaseConnection();
    const database = dbopen.db(config.get('database.daemon.database'));
    const query = {};
    const projection = {
      projection: {
        _id: 0,
        txid: 1,
        hash: 1,
        height: 1,
        value: 1,
        message: 1,
        messageNotFound: 1,
      },
    };
    const results = await dbHelper.findInDatabase(database, appsHashesCollection, query, projection);
    const resultsResponse = messageHelper.createDataMessage(results);
    return res ? res.json(resultsResponse) : resultsResponse;
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    return res ? res.json(errorResponse) : errorResponse;
  }
}

/**
 * Where an app is running, network-wide — or everything running, with no name.
 *
 * Derived from the app state event log rather than read from the materialized
 * appsLocations collection. That collection only ever gains and updates rows, so an
 * app a node quietly stopped between announcements kept a row until its TTL swept it,
 * and the network went on believing the app was there for up to the running TTL. The
 * derivation has no such gap: it reads each node's latest announcement, and an app
 * absent from that announcement is absent, immediately.
 *
 * @param {string} [appname] - optional app name filter
 * @returns {Promise<Array>} location rows
 */
async function appLocation(appname) {
  return appsRepository.appLocationFromEvents(appname ? { appname } : {});
}

/**
 * The explorer's scanned height — the height app expiry is evaluated against.
 * @returns {Promise<number>}
 * @throws {Error} when scanning has not initiated
 */
async function getScannedHeight() {
  const daemonDb = dbHelper.databaseConnection().db(config.get('database.daemon.database'));
  const result = await dbHelper.findOneInDatabase(
    daemonDb,
    scannedHeightCollection,
    { generalScannedHeight: { $gte: 0 } },
    { projection: { _id: 0, generalScannedHeight: 1 } },
  );
  if (!result) throw new Error('Scanning not initiated');
  return serviceHelper.ensureNumber(result.generalScannedHeight);
}

/**
 * Get app installing locations
 * @param {string} appname - Optional app name filter
 * @returns {Promise<Array>} Array of installing locations
 */
async function appInstallingLocation(appname) {
  const dbopen = dbHelper.databaseConnection();
  const database = dbopen.db(config.get('database.appsglobal.database'));
  let query = {};
  if (appname) {
    query = { name: new RegExp(`^${appname}$`, 'i') }; // case insensitive
  }
  const projection = {
    projection: {
      _id: 0,
      name: 1,
      ip: 1,
      replica: 1,
      // The election key: contenders rank on announcedAt ?? broadcastedAt, and
      // broadcastedAt moves on every claim renewal - without announcedAt in this
      // read, a renewing node's election position would silently shift.
      announcedAt: 1,
      broadcastedAt: 1,
      expireAt: 1,
    },
  };
  const results = await dbHelper.findInDatabase(database, globalAppsInstallingLocations, query, projection);
  return results;
}

/**
 * How many nodes are claiming each app, counted in one grouped pass.
 *
 * The spawner needs this for every candidate at once, to decide which apps
 * still need a node before it picks one. Asking per app would be a read per
 * candidate; this is a single scan of a collection that holds only live claims,
 * since they expire on a TTL index.
 *
 * Names are lowercased because an app is addressed case-insensitively
 * everywhere else here, so a caller must not have to know which case the
 * claiming node happened to send.
 *
 * The per-app appInstallingLocation read at claim time stays the authority; this
 * only spares the draw candidates it would have turned away.
 * @returns {Promise<Map<string, number>>} Lowercased app name to claim count.
 */
async function installingCountsByApp() {
  const dbopen = dbHelper.databaseConnection();
  const database = dbopen.db(config.get('database.appsglobal.database'));
  const rows = await dbHelper.aggregateInDatabase(database, globalAppsInstallingLocations, [
    { $group: { _id: { $toLower: '$name' }, count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [row._id, row.count]));
}

/**
 * Get app installing errors locations for a specific app or all apps
 * @param {string} appname - Application name (optional)
 * @returns {Promise<Array>} Array of app installing error locations
 */
async function appInstallingErrorsLocation(appname) {
  const dbopen = dbHelper.databaseConnection();
  const database = dbopen.db(config.get('database.appsglobal.database'));
  let query = {};
  if (appname) {
    query = { name: new RegExp(`^${appname}$`, 'i') }; // case insensitive
  }
  const projection = {
    projection: {
      _id: 0,
      name: 1,
      hash: 1,
      ip: 1,
      error: 1,
      broadcastedAt: 1,
      cachedAt: 1,
      expireAt: 1,
    },
  };
  const results = await dbHelper.findInDatabase(database, globalAppsInstallingErrorsLocations, query, projection);
  return results;
}

/**
 * Get app installing errors locations API endpoint
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getAppsInstallingErrorsLocations(req, res) {
  try {
    const results = await appInstallingErrorsLocation();
    const resultsResponse = messageHelper.createDataMessage(results);
    res.json(resultsResponse);
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

/**
 * Get a specific app's installing error locations API endpoint
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getAppInstallingErrorsLocation(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;
    if (!appname) {
      throw new Error('No Flux App name specified');
    }
    const results = await appInstallingErrorsLocation(appname);
    const resultsResponse = messageHelper.createDataMessage(results);
    res.json(resultsResponse);
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

/**
 * Store an app installing message in the database
 * @param {object} message - App installing message
 * @returns {Promise<boolean>} True if stored successfully, false if message is old/duplicate
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
    throw new Error('Invalid Flux App Installing message for storing');
  }

  if (message.version !== 1 && message.version !== 2) {
    throw new Error(`Invalid Flux App Installing message for storing version ${message.version} not supported`);
  }

  if (message.version === 2 && typeof message.announcedAt !== 'number') {
    throw new Error('Invalid Flux App Installing message for storing announcedAt required for version 2');
  }

  // Local-writer strictness (this is the node's OWN claim): a malformed replica tag
  // is an emission bug, not something to tolerantly normalize away like peer input.
  if (message.replica !== undefined && typeof message.replica !== 'string') {
    throw new Error('Invalid Flux App Installing message for storing replica must be a string when present');
  }

  // Same row lifetime peers grant the broadcast copy: the node must not forget its
  // own claim before the fleet does.
  const validTill = message.broadcastedAt + INSTALLING_EXPIRY_MS;
  if (validTill < Date.now()) {
    log.warn(`Rejecting old/not valid fluxappinstalling message, message:${JSON.stringify(message)}`);
    // reject old message
    return false;
  }

  const db = dbHelper.databaseConnection();
  const database = db.db(config.get('database.appsglobal.database'));

  const newAppInstallingMessage = {
    name: message.name,
    ip: message.ip,
    // One claim row per identity: a replica name for named placement, null for
    // loose - null also matches legacy rows stored without the field.
    replica: message.replica ?? null,
    broadcastedAt: new Date(message.broadcastedAt),
    expireAt: new Date(validTill),
  };
  if (message.version === 2) {
    newAppInstallingMessage.announcedAt = new Date(message.announcedAt);
  }

  // indexes over name, hash, ip. Then name + ip and name + ip + broadcastedAt.
  const queryFind = { name: newAppInstallingMessage.name, ip: newAppInstallingMessage.ip, replica: newAppInstallingMessage.replica };
  const projection = { _id: 0 };
  // we already have the exact same data
  const result = await dbHelper.findOneInDatabase(database, globalAppsInstallingLocations, queryFind, projection);
  if (result && result.broadcastedAt && result.broadcastedAt >= newAppInstallingMessage.broadcastedAt) {
    // found a message that was already stored/probably from duplicated message processsed
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
 * Retract this node's own fluxappinstalling record for one identity of an app
 * (delete by the same name+ip+replica key storeAppInstallingMessage upserts on).
 * Used when a spawn attempt that stored the record does not go on to install
 * (deferred, failed, or an early bail): a lingering record would make the next
 * spawn cycle read its own stale "installing" state and self-lock the app.
 * Idempotent - a no-op when absent.
 *
 * @param {string} name - app name
 * @param {string} ip - this node's socket address
 * @param {string|null} [replica] - the identity to retract; null (loose) also
 *   matches legacy rows stored without the field
 * @returns {Promise<void>}
 */
async function removeAppInstallingMessage(name, ip, replica = null) {
  const db = dbHelper.databaseConnection();
  const database = db.db(config.get('database.appsglobal.database'));
  await dbHelper.findOneAndDeleteInDatabase(database, globalAppsInstallingLocations, { name, ip, replica }, {});
}

/**
 * Ensure the installing-claims collections (location rows + archived signed
 * broadcasts) carry their indexes: TTL on expireAt, the query indexes, and the
 * per-identity uniqueness of archived announces. Owned here with the rest of
 * the claims row logic; serviceManager calls this during db preparation.
 * @returns {Promise<void>}
 */
async function prepareInstallingClaimsCollections() {
  const db = dbHelper.databaseConnection();
  const database = db.db(config.get('database.appsglobal.database'));

  const broadcasts = database.collection(globalAppsInstallingBroadcasts);
  // TTL migrated from broadcastedAt to the per-document expireAt.
  await broadcasts.dropIndex('broadcastedAt_1').catch(() => {});
  await dbHelper.ensureIndex(broadcasts, { expireAt: 1 }, { expireAfterSeconds: 0 });
  await dbHelper.ensureIndex(broadcasts, { broadcastedAt: 1 });
  // One archived announce per claim identity: a co-located node holds one doc
  // per replica under the same (name, ip); the two-field unique index would
  // reject the sibling's announce.
  await broadcasts.dropIndex('data.name_1_data.ip_1').catch(() => {});
  await dbHelper.ensureIndex(broadcasts, { 'data.name': 1, 'data.ip': 1, 'data.replica': 1 }, { unique: true });

  const locations = database.collection(globalAppsInstallingLocations);
  await locations.dropIndex('broadcastedAt_1').catch(() => {});
  await dbHelper.ensureIndex(locations, { expireAt: 1 }, { expireAfterSeconds: 0 });
  await dbHelper.ensureIndex(locations, { name: 1 }, { name: 'query for getting flux app install location based on specs name' });
  await dbHelper.ensureIndex(locations, { name: 1, ip: 1 }, { name: 'query for getting flux app install location based on specs name and node ip' });
  log.info('Installing-claims collections prepared');
}

/**
 * To return the owner of a FluxOS application.
 * @param {string} appName Name of app.
 * @returns {string|null} Owner.
 */
async function getApplicationOwner(appName) {
  const owner = await appsRepository.getGlobalAppOwner(appName);
  if (owner) {
    return owner;
  }
  // eslint-disable-next-line no-use-before-define
  const allApps = await availableApps();
  const appInfo = allApps.find((app) => app.name.toLowerCase() === appName.toLowerCase());
  if (appInfo) {
    return appInfo.owner;
  }
  return null;
}

/**
 * Get all app locations via API
 * @param {object} _req - Request object (unused)
 * @param {import('express').Response} res
 */
async function getAppsLocations(_req, res) {
  try {
    const results = await appLocation();
    const resultsResponse = messageHelper.createDataMessage(results);
    res.json(resultsResponse);
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

/**
 * Get specific app location via API
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getAppsLocation(req, res) {
  try {
    let { appname } = req?.params || {};
    appname = appname || req?.query?.appname;
    if (!appname) {
      throw new Error('No Flux App name specified');
    }
    const results = await appLocation(appname);
    const resultsResponse = messageHelper.createDataMessage(results);
    res.json(resultsResponse);
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

/**
 * Get specific app installing location via API
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getAppInstallingLocation(req, res) {
  try {
    let { appname } = req?.params || {};
    appname = appname || req?.query?.appname;
    if (!appname) {
      throw new Error('No Flux App name specified');
    }
    const results = await appInstallingLocation(appname);
    const resultsResponse = messageHelper.createDataMessage(results);
    res.json(resultsResponse);
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

/**
 * Resolve an application's stored spec for a caller.
 *
 * A cleartext app, or a request with no view credential, returns the sparse
 * stored spec untouched. An encrypted app is decrypted node-side through its
 * own storage provider (polymorphic across versions) and re-protected toward
 * the caller over the channel the client asked for — not by spec version:
 *   - flux-transport-pubkey -> v9 transport layer: HPKE-seal the canonical
 *     cleartext toward the caller's ephemeral pubkey, directly through the
 *     transport provider. Never reencrypt() here — that is the storage layer.
 *   - enterprise-key        -> v8's single shared encryption (RSA-wrapped AES)
 *     reapplied toward the caller. Isolated; removed when v8 is retired.
 *
 * @param {string} appname
 * @param {{ recipientPubkeyBase64?: string, enterpriseKey?: string }} [opts]
 * @returns {Promise<object>} sparse stored spec, a v9 sealed view
 *   ({ encrypted, appName, timestamp, transportEncrypted }), or a v8 reencrypted spec
 */
async function getApplicationSpecification(appname, opts = {}) {
  const { recipientPubkeyBase64, enterpriseKey } = opts;

  const instantiated = await appsRepository.getGlobalAppInfo(appname);
  if (!instantiated) {
    throw new Error(`Application: ${appname} not found`);
  }

  if ((!recipientPubkeyBase64 && !enterpriseKey) || !instantiated.isEncrypted) {
    return instantiated.spec.serialize();
  }

  // A v9 owner always presents flux-transport-pubkey; reject a v9 app on the
  // legacy enterprise-key channel before doing any crypto work.
  if (!recipientPubkeyBase64 && instantiated.version >= 9) {
    throw new Error('A version 9 application must be viewed via the flux-transport-pubkey channel.');
  }

  // Storage decrypt is polymorphic — the spec's own provider matches its version.
  const backendProvider = await instantiated.spec.createProvider();
  const decrypted = await instantiated.spec.decrypt(backendProvider);

  if (recipientPubkeyBase64) {
    // v9 transport layer: seal the canonical cleartext toward the caller's
    // ephemeral pubkey so the owner's frontend gets the full form to re-sign.
    const { buildSpecViewAad, SPEC_VIEW_INFO, canonicalJson } = await getSpec();
    const viewSpec = decrypted;
    const timestamp = Date.now();
    const aad = buildSpecViewAad({ appName: viewSpec.name, timestamp });
    const provider = await transportCryptoProvider.create(viewSpec.name, viewSpec.owner);
    const plaintext = Buffer.from(canonicalJson(viewSpec.toCanonical()), 'utf8');
    const peerPublicKey = Buffer.from(recipientPubkeyBase64, 'base64');
    const envelope = await provider.seal({
      plaintext, aad, peerPublicKey, info: SPEC_VIEW_INFO,
    });
    return {
      encrypted: true, appName: viewSpec.name, timestamp, transportEncrypted: envelope.toJSON(),
    };
  }

  // Legacy v8 channel: v8's single shared encryption form, reapplied toward the
  // caller. Removed when v8 is retired.
  const transportProvider = await legacyTransportProvider.create(
    instantiated.name, instantiated.owner, enterpriseKey,
  );
  const reencrypted = await decrypted.reencrypt(transportProvider);
  return reencrypted.serialize();
}

async function getApplicationSpecificationAPI(req, res) {
  try {
    const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
    if (!syncStatus.data.synced) {
      throw new Error('Daemon not yet synced.');
    }

    let { appname, decrypt } = req.params;
    appname = appname || req.query.appname;

    if (!appname) {
      throw new Error('No Application Name specified');
    }

    decrypt = req.query.decrypt || decrypt;

    let viewOpts = {};
    if (decrypt) {
      // Channel negotiated by which credential the client presents:
      // flux-transport-pubkey -> v9 HPKE view; enterprise-key -> legacy v8.
      const recipientPubkeyBase64 = req.headers['flux-transport-pubkey'];
      const enterpriseKey = req.headers['enterprise-key'];
      if (!recipientPubkeyBase64 && !enterpriseKey) {
        throw new Error('Header flux-transport-pubkey or enterprise-key is mandatory to view an encrypted application.');
      }

      const mainAppName = appname.split('_')[1] || appname;
      // Decrypting a spec is the owner's alone. A partly-redacted one would be
      // neither usable nor safe, and everything left in it is still theirs; the
      // flux team decrypts out of band, as a deliberate act by a named person.
      const authorized = await verificationHelper.verifyPrivilege(
        Privilege.APP_OWNER,
        authOf(req),
        { appName: mainAppName },
      );

      if (authorized !== true) {
        res.json(messageHelper.errUnauthorizedMessage());
        return null;
      }

      viewOpts = { recipientPubkeyBase64, enterpriseKey };
    }

    const spec = await getApplicationSpecification(appname, viewOpts);
    res.json(messageHelper.createDataMessage(spec));
  } catch (error) {
    log.error(error);

    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );

    res.json(errorResponse);
  }

  return null;
}

/**
 * Convert an existing on-chain v1-v8 app spec to v9.
 *
 * Loads the stored spec (decrypting an enterprise spec node-side first),
 * resolves and inlines any F_S_ENV/F_S_CMD storage references — fail-hard, v9
 * has no storage-ref convention — then runs fromLegacy. When the source was
 * encrypted, or any sensitive value was inlined, the v9 spec is sealed toward
 * the frontend's ephemeral pubkey (view direction) so cleartext never crosses
 * the wire. The owner reviews the returned draft (completing any missing
 * required fields), signs it, then submits it as a normal v9 update (priced as
 * a free version-only upgrade).
 *
 * @param {string} appname
 * @param {{ recipientPubkeyBase64?: string }} opts
 * @returns {Promise<object>} A draft for owner review: cleartext
 *   { encrypted:false, spec, complete, errors, warnings } or sealed
 *   { encrypted:true, appName, timestamp, transportEncrypted, complete, errors, warnings }.
 *   complete:false means the draft is missing required fields, or carries a
 *   region name this node's location table cannot resolve (both listed in errors)
 *   that the owner must fill before it can be signed.
 */
async function convertApplicationSpecification(appname, opts = {}) {
  const { recipientPubkeyBase64 } = opts;

  const instantiated = await appsRepository.getGlobalAppInfo(appname);
  if (!instantiated) {
    throw new Error(`Application: ${appname} not found`);
  }
  if (instantiated.version >= 9) {
    throw new Error(`Application ${appname} is already on spec version 9`);
  }

  // The node can decrypt a stored enterprise spec via its own provider; the
  // cleartext legacy instance is what fromLegacy converts.
  let legacySpec = instantiated.spec;
  if (instantiated.isEncrypted) {
    const backendProvider = await instantiated.spec.createProvider();
    const decrypted = await instantiated.spec.decrypt(backendProvider);
    legacySpec = decrypted;
  }

  const { fromLegacy } = await getSpecBackend();
  const { FluxAppSpecV9, buildSpecViewAad, SPEC_VIEW_INFO } = await getSpec();

  const { spec: v9Blob, warnings, unresolvedRegions } = fromLegacy(legacySpec, { confirmationHeight: instantiated.height });

  const inlinedSensitive = await resolveStorageRefs(v9Blob.components, instantiated.name);

  // Convert is a draft generator, so validate without throwing: a fixable gap
  // (e.g. a contacts-less v8 app) returns a fillable draft with inline errors
  // for the owner to complete, not a hard failure. Strict fromSubmission stays
  // at sign-time submission, which requires a valid canonical form anyway.
  const { valid, errors } = FluxAppSpecV9.validateSchema(v9Blob);

  // A region name the location table cannot spell is a gap of exactly the kind
  // this endpoint exists to hand back: the owner is the only party who knows
  // which region they meant, and they can pick it here. It is not in the draft
  // — converting it to the whole country would be the draft agreeing with a
  // warning about itself, on the document they are about to sign — so it is an
  // error that blocks completion rather than a warning beside a value. The
  // schema cannot catch it: the entry is simply absent, and a placement with
  // one fewer geoAllow entry is perfectly valid.
  const regionErrors = (unresolvedRegions || []).map((u) => ({
    path: ['placement', 'geoAllow'],
    code: 'region_unresolved',
    message: `Region '${u.region}' in ${u.country} could not be resolved to an ISO 3166-2 code`
      + `${u.supplied ? '' : ' (no region vocabulary is loaded on this node yet)'}`
      + '. Choose the region again before signing — it is not carried into this draft.',
    value: u.region,
  }));
  const allErrors = [...errors, ...regionErrors];
  const complete = valid && regionErrors.length === 0;
  const draft = valid ? FluxAppSpecV9.fromSubmission(v9Blob).toCanonical() : v9Blob;
  const { name, owner } = v9Blob;

  const mustEncrypt = instantiated.isEncrypted || inlinedSensitive;
  if (!mustEncrypt) {
    return {
      encrypted: false, spec: draft, complete, errors: allErrors, warnings,
    };
  }

  if (!recipientPubkeyBase64) {
    throw new Error('Header flux-transport-pubkey is mandatory to convert an encrypted application.');
  }
  const timestamp = Date.now();
  const aad = buildSpecViewAad({ appName: name, timestamp });
  const provider = await transportCryptoProvider.create(name, owner);
  const plaintext = Buffer.from(JSON.stringify(draft), 'utf8');
  const peerPublicKey = Buffer.from(recipientPubkeyBase64, 'base64');
  const envelope = await provider.seal({
    plaintext, aad, peerPublicKey, info: SPEC_VIEW_INFO,
  });
  const transportEncrypted = envelope.toJSON();
  return {
    encrypted: true, appName: name, timestamp, transportEncrypted, complete, errors: allErrors, warnings,
  };
}

/**
 * API endpoint: convert an existing app's spec to v9 for owner review.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function appConvertApi(req, res) {
  try {
    const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
    if (!syncStatus.data.synced) {
      throw new Error('Daemon not yet synced.');
    }

    let { appname } = req.params;
    appname = appname || req.query.appname;
    if (!appname) {
      throw new Error('No Application Name specified');
    }

    // The owner alone, as for the decrypt path in getApplicationSpecificationAPI.
    // This upgrades the stored spec and hands it back whole - a decrypted
    // enterprise spec, environmentParameters and repoauth included, or inlined
    // storage-ref values - which is the spec its owner is about to re-sign, and
    // nobody else's business. The flux team decrypts out of band instead, which
    // keeps a decryption a deliberate act by a named person rather than a side
    // effect of opening a page.
    const mainAppName = appname.split('_')[1] || appname;
    const authorized = await verificationHelper.verifyPrivilege(
      Privilege.APP_OWNER,
      authOf(req),
      { appName: mainAppName },
    );
    if (authorized !== true) {
      res.json(messageHelper.errUnauthorizedMessage());
      return null;
    }

    const recipientPubkeyBase64 = req.headers['flux-transport-pubkey'];
    const result = await convertApplicationSpecification(appname, { recipientPubkeyBase64 });
    res.json(messageHelper.createDataMessage(result));
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }

  return null;
}

/**
 * The component names of an app, and their election mode, for the flux team.
 *
 * Two different claims, which is why they are two fields:
 *
 * `resources` is public information that happens to be sealed on a v8 app. v9
 * keeps the totals OUTSIDE the encrypted envelope on purpose — a node has to
 * judge whether it can host an app without being able to read it — and binds
 * them into the AAD so a relayer cannot understate them. Returning them here is
 * that same decision, extended to the versions that have not shipped it.
 *
 * `components` is not. v9 seals the component list and publishes only a count,
 * so handing over the names is a deliberate exception rather than a claim they
 * are harmless: the container tools address a component as `<component>_<app>`,
 * so logs, terminal, monitoring and file changes cannot function without them.
 * The exception is granted to an authenticated flux team caller, on a node that
 * can read the plaintext, and to nobody else.
 *
 * Both answers are asked of the spec CLASS rather than read off the stored
 * document. A v9 document carries no `compose`, no `containerData` and no
 * `ram`/`hdd`, so a reader written to the v8 spelling does not fail on one — it
 * answers `masterSlave: false` for every component of every v9 app and sums
 * nothing, which is the shape of defect `28023e1fc` fixed in placement.
 *
 * `resources` is `resourceTotals()`, which is the spec library's one shape for
 * "how big is this app" and is what a sealed v9 container publishes in the
 * clear. It is deliberately NOT development's `{cpu, ram, hdd}`: those names do
 * not say their units, which the spec library refuses for this exact sum, and
 * the triple omits the container root filesystem and swap — so it understates
 * what the node must actually reserve.
 *
 * Withheld either way: environment parameters, repository credentials, secrets,
 * commands, image tags, ports and domains. Nothing is stripped to achieve that
 * — the response is BUILT from the two fields above, so a field added to a spec
 * in future is withheld by default rather than by being remembered here.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getApplicationComponentNamesAPI(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;

    if (!appname) {
      throw new Error('No Application Name specified');
    }

    const mainAppName = appname.split('_')[1] || appname;

    // fluxteam, not appownerorfluxteam: an owner reads the specification itself
    // and has no use for this, and the node operator is not a party to a
    // customer's app at all.
    const authorized = await verificationHelper.verifyPrivilege(Privilege.FLUX_TEAM, authOf(req));
    if (!authorized) {
      return res.json(messageHelper.errUnauthorizedMessage());
    }

    const instantiated = await appsRepository.getGlobalAppInfo(mainAppName);
    if (!instantiated) {
      throw new Error(`Application: ${mainAppName} not found`);
    }

    let { spec } = instantiated;
    if (instantiated.isEncrypted) {
      // Node-side, with the node's own key. A node that cannot read the spec
      // cannot name its components, and says so rather than answering an empty
      // list that reads as "this app has none".
      const provider = await spec.createProvider();
      spec = await spec.decrypt(provider);
    }

    const response = messageHelper.createDataMessage({
      components: Object.values(spec.components || {}).map((component) => ({
        name: component.name,
        // The classifier the election itself uses, asked of the component. A
        // sync flag counts only on the primary mount, so this agrees with what
        // decides the component's fate rather than with anywhere the letters
        // happen to appear.
        masterSlave: component.hasActiveStandbySyncthing(),
      })),
      resources: spec.resourceTotals(),
    });

    return res.json(response);
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    return res.json(errorResponse);
  }
}

/**
 * Get application owner via API
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getApplicationOwnerAPI(req, res) {
  try {
    let { appname } = req?.params || {};
    appname = appname || req?.query?.appname;
    if (!appname) {
      throw new Error('No Application Name specified');
    }
    const owner = await getApplicationOwner(appname);
    if (!owner) {
      throw new Error('Application not found');
    }
    const ownerResponse = messageHelper.createDataMessage(owner);
    res.json(ownerResponse);
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}


/**
 * Get global apps specifications via API
 * @param {import('express').Request} req - Request object with optional params/query for hash, owner, appname
 * @param {import('express').Response} res
 */
async function getGlobalAppsSpecifications(req, res) {
  try {
    const filter = {};
    let { hash } = req.params;
    hash = hash || req.query.hash;
    let { owner } = req.params;
    owner = owner || req.query.owner;
    let { appname } = req.params;
    appname = appname || req.query.appname;
    if (hash) {
      filter.hash = hash;
    }
    if (owner) {
      filter.owner = owner;
    }
    if (appname) {
      filter.name = appname;
    }
    const apps = await appsRepository.listGlobalAppInfo({ filter });
    const results = apps.map((app) => app.serialize());
    const resultsResponse = messageHelper.createDataMessage(results);
    res.json(resultsResponse);
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

/**
 * Get available apps (both global and local)
 * @param {object} _req - Request object (unused)
 * @param {import('express').Response} res
 */
async function availableApps(_req, res) {
  try {
    const globalApps = await appsRepository.listGlobalAppInfo();
    const localApps = await appsRepository.listInstalledApps();
    const allApps = [...globalApps, ...localApps].map((app) => app.serialize());

    if (res) {
      const resultsResponse = messageHelper.createDataMessage(allApps);
      return res.json(resultsResponse);
    }
    return allApps;
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    return res ? res.json(errorResponse) : errorResponse;
  }
}

/**
 * Check for registration name conflicts
 * @param {object} appSpecFormatted - Application specifications
 * @param {string} hash - Application hash
 * @returns {Promise<boolean>} True if no conflicts found
 */
async function checkApplicationRegistrationNameConflicts(appSpecFormatted, hash) {
  const dbopen = dbHelper.databaseConnection();
  const existingApp = await appsRepository.getGlobalAppInfo(appSpecFormatted.name);

  if (existingApp) {
    if (hash) {
      const query = { hash };
      const projection = {
        projection: {
          _id: 0,
          txid: 1,
          hash: 1,
          height: 1,
        },
      };
      const database = dbopen.db(config.get('database.daemon.database'));
      const result = await dbHelper.findOneInDatabase(database, appsHashesCollection, query, projection);
      if (!result) {
        throw new Error(`Flux App ${appSpecFormatted.name} already registered. Flux App has to be registered under different name. Hash not found in collection.`);
      }
      if (existingApp.height <= result.height) {
        log.debug(existingApp.serialize());
        log.debug(result);

        if (existingApp.expiresAtHeight >= result.height) {
          throw new Error(`Flux App ${appSpecFormatted.name} already registered. Flux App has to be registered under different name. Hash is not older than our current app.`);
        } else {
          log.warn(`Flux App ${appSpecFormatted.name} active specifications are outdated. Will be cleaned on next expiration`);
        }
      } else {
        throw new Error(`Flux App ${appSpecFormatted.name} already registered. Flux App has to be registered under different name. Hash is older than our current app.`);
      }
    } else {
      throw new Error(`Flux App ${appSpecFormatted.name} already registered. Flux App has to be registered under different name.`);
    }
  }

  const localApps = await availableApps();
  const appExists = localApps.find((localApp) => localApp.name.toLowerCase() === appSpecFormatted.name.toLowerCase());
  if (appExists) {
    throw new Error(`Flux App ${appSpecFormatted.name} already assigned to local application. Flux App has to be registered under different name.`);
  }
  if (appSpecFormatted.name.toLowerCase() === 'share') {
    throw new Error(`Flux App ${appSpecFormatted.name} already assigned to Flux main application. Flux App has to be registered under different name.`);
  }
  return true;
}

/**
 * Update app specifications for rescan/reindex
 * @param {object} appSpecs - Application specifications
 * @returns {Promise<boolean>} Update result
 */
async function updateAppSpecsForRescanReindex(appSpecs) {
  const existingHeight = await appsRepository.getGlobalAppHeight(appSpecs.name);
  if (existingHeight === null || existingHeight < appSpecs.height) {
    await storeGlobalSpec(appSpecs);
  }
  return true;
}

/**
 * Store app specification in permanent storage
 * @param {object} appSpec - Application specification
 * @returns {Promise<object>} Storage result
 */
async function storeAppSpecificationInPermanentStorage(appSpec) {
  try {
    await storeGlobalSpec(appSpec);
    log.info(`App specification stored permanently for ${appSpec.name}`);
    return { status: 'success', message: 'App specification stored' };
  } catch (error) {
    log.error(`Error storing app specification: ${error.message}`);
    throw error;
  }
}


/**
 * Get all apps information (both global and local)
 * @returns {Promise<Array>} Array of all app information
 */
async function getAllAppsInformation() {
  try {
    const allApps = await availableApps();
    return allApps;
  } catch (error) {
    log.error(`Error getting all apps information: ${error.message}`);
    return [];
  }
}

/**
 * Get running apps information
 * @returns {Promise<Array>} Array of running apps
 */
async function getRunningApps() {
  try {
    return await appsRepository.appLocationFromEvents();
  } catch (error) {
    log.error(`Error getting running apps: ${error.message}`);
    return [];
  }
}

/**
 * Every app running on one machine, whatever apiport its nodes use — the port
 * conflict question, which is per-host rather than per-node.
 * @param {string} ip bare IP address, no port
 * @returns {Promise<Array>} apps running on that host
 */
async function getRunningAppIpList(ip) {
  return appsRepository.appLocationFromEvents({ host: ip });
}

/**
 * Rebuild the global apps information collection from messages collection.
 *
 * Thin wrapper around appsMaintenance.reindexGlobalAppsInformation, which
 * does the heavy lifting in a single mongo aggregation + chunked bulk
 * inserts. That version filters expired apps inside the aggregation (full
 * PON fork rate adjustment), so no separate expire pass is needed here.
 *
 * @returns {Promise<boolean>} True on success
 */
async function reindexGlobalAppsInformation() {
  try {
    if (reindexRunning) {
      return 'Previous app reindex not yet finished. Skipping.';
    }
    reindexRunning = true;
    log.info('Reindexing global application list');

    const db = dbHelper.databaseConnection();
    const appsGlobalDb = db.db(config.get('database.appsglobal.database'));
    const appsLocalDb = db.db(config.get('database.appslocal.database'));
    const daemonDb = db.db(config.get('database.daemon.database'));

    const scannedHeightResult = await dbHelper.findOneInDatabase(
      daemonDb,
      scannedHeightCollection,
      { generalScannedHeight: { $gte: 0 } },
      { projection: { _id: 0, generalScannedHeight: 1 } },
    );
    if (!scannedHeightResult) {
      throw new Error('Scanning not initiated');
    }
    const scannedHeight = serviceHelper.ensureNumber(
      scannedHeightResult.generalScannedHeight,
    );

    await appsMaintenance.reindexGlobalAppsInformation(
      appsGlobalDb,
      appsLocalDb,
      globalAppsMessages,
      globalAppsInformation,
      globalAppsInstallingErrorsLocations,
      localAppsInformation,
      scannedHeight,
    );

    log.info('Reindexing of global application list finished.');
    return true;
  } catch (error) {
    log.error(error);
    throw error;
  } finally {
    reindexRunning = false;
  }
}

/**
 * Reconstruct app messages hash collection by validating hash records against
 * actual messages.
 *
 * A REPAIRED HASH IS RE-SOUGHT, not merely re-labelled. Marking a row
 * `message: false` says this node does not hold the message; leaving the retry
 * fields alone leaves it scheduled at whatever height it last failed at, so the
 * audit that found the gap does not cause anyone to go and close it. Resetting
 * `syncAttempts` and pointing `nextRetryHeight` back at the row's own origin is
 * what makes the next sync pass pick it up.
 *
 * Only rows whose state is WRONG are written, so the count is a count of
 * corrections rather than of documents examined - which is what the caller
 * decides whether to announce on.
 *
 * @returns {Promise<{changed: number}>} how many rows were corrected
 */
async function reconstructAppMessagesHashCollection() {
  try {
    const db = dbHelper.databaseConnection();
    const databaseApps = db.db(config.get('database.appsglobal.database'));
    const databaseDaemon = db.db(config.get('database.daemon.database'));
    const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
    const currentHeight = syncStatus.data.height || 0;
    const query = {};
    const projection = { projection: { _id: 0 } };

    const permanentMessages = await dbHelper.findInDatabase(databaseApps, globalAppsMessages, query, projection);
    const appHashes = await dbHelper.findInDatabase(databaseDaemon, appsHashesCollection, query, projection);
    // A set, not a find() per row: the scan was quadratic in the number of
    // hashes, and both collections are whole-chain.
    const permanentHashes = new Set(permanentMessages.map((message) => message.hash));

    const ops = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const appHash of appHashes) {
      const filter = { hash: appHash.hash, txid: appHash.txid };
      const hasPermanent = permanentHashes.has(appHash.hash);
      // Back to where the row itself began, so a re-sought hash is asked for
      // from its own origin rather than from wherever the chain is now.
      const retryFrom = appHash.retryFromHeight ?? appHash.height;

      if (hasPermanent && (!appHash.message || appHash.messageNotFound)) {
        ops.push({
          updateOne: {
            filter,
            update: {
              $set: {
                message: true, messageNotFound: false, syncAttempts: 0, nextRetryHeight: retryFrom, retryFromHeight: retryFrom,
              },
            },
          },
        });
      } else if (!hasPermanent && appHash.message) {
        // The row claims a message this node does not hold. Sought again from
        // the current height: the message is missing NOW, whatever the row's
        // own origin says.
        ops.push({
          updateOne: {
            filter,
            update: {
              $set: {
                message: false, messageNotFound: false, syncAttempts: 0, nextRetryHeight: currentHeight, retryFromHeight: currentHeight,
              },
            },
          },
        });
      }
    }

    let changed = 0;
    if (ops.length > 0) {
      const result = await databaseDaemon.collection(appsHashesCollection).bulkWrite(ops, { ordered: false });
      changed += result.modifiedCount;
    }

    return { changed };
  } catch (error) {
    log.error(error);
    throw error;
  }
}

/**
 * API endpoint to reconstruct app messages hash collection
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<object>} Reconstruction result message
 */
async function reconstructAppMessagesHashCollectionAPI(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege(Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));
    if (authorized) {
      const result = await reconstructAppMessagesHashCollection();
      const message = messageHelper.createSuccessMessage(result);
      res.json(message);
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}


/**
 * DEPRECATED — no-op. Only accessible by admins and Flux team members.
 *
 * This rebuilt the materialized appsLocations collection, which no longer exists:
 * the running set is derived from the app state event log on read, so it is always
 * current and there is nothing to reindex. The route and its response envelope are
 * kept so existing operator tooling neither breaks nor has to special-case a
 * version, and the privilege check still applies.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function reindexGlobalAppsLocationAPI(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege(Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));
    if (authorized === true) {
      res.json(messageHelper.createSuccessMessage('Deprecated: app locations are derived from the app state event log, there is nothing to reindex'));
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

/**
 * To reindex global apps information via API. Only accessible by admins and Flux team members.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function reindexGlobalAppsInformationAPI(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege(Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));
    if (authorized === true) {
      await reindexGlobalAppsInformation();
      const message = messageHelper.createSuccessMessage('Reindex successfull');
      res.json(message);
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

/**
 * Rescans global apps information from messages collection starting from a specific height
 * @param {number} height - Starting block height for rescan (default 0)
 * @param {boolean} removeLastInformation - Whether to remove existing information before rescanning (default false)
 * @returns {Promise<boolean>} True if successful
 */
async function rescanGlobalAppsInformation(height = 0, removeLastInformation = false) {
  try {
    const db = dbHelper.databaseConnection();
    const database = db.db(config.get('database.appsglobal.database'));

    await dbHelper.dropCollection(database, globalAppsInformation).catch((error) => {
      if (error.message !== 'ns not found') {
        throw error;
      }
    });

    const query = { height: { $gte: height } };
    const projection = { projection: { _id: 0 } };
    const results = await dbHelper.findInDatabase(database, globalAppsMessages, query, projection);

    if (removeLastInformation === true) {
      await dbHelper.removeDocumentsFromCollection(database, globalAppsInformation, query);
    }

    // eslint-disable-next-line no-restricted-syntax
    for (const message of results) {
      const updateForSpecifications = message.appSpecifications;
      updateForSpecifications.hash = message.hash;
      updateForSpecifications.height = message.height;
      // eslint-disable-next-line no-await-in-loop
      await updateAppSpecsForRescanReindex(updateForSpecifications);
    }
    return true;
  } catch (error) {
    log.error(error);
    throw error;
  }
}

/**
 * To rescan global apps information via API. Only accessible by admins and Flux team members.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function rescanGlobalAppsInformationAPI(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege(Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));
    if (authorized === true) {
      let { blockheight } = req.params; // we accept both help/command and help?command=getinfo
      blockheight = blockheight || req.query.blockheight;
      if (!blockheight) {
        const errMessage = messageHelper.createErrorMessage('No blockheight provided');
        res.json(errMessage);
        return;
      }
      blockheight = serviceHelper.ensureNumber(blockheight);
      const dbopen = dbHelper.databaseConnection();
      const database = dbopen.db(config.get('database.daemon.database'));
      const query = { generalScannedHeight: { $gte: 0 } };
      const projection = {
        projection: {
          _id: 0,
          generalScannedHeight: 1,
        },
      };
      const currentHeight = await dbHelper.findOneInDatabase(database, scannedHeightCollection, query, projection);
      if (!currentHeight) {
        throw new Error('No scanned height found');
      }
      if (currentHeight.generalScannedHeight <= blockheight) {
        throw new Error('Block height shall be lower than currently scanned');
      }
      if (blockheight < 0) {
        throw new Error('BlockHeight lower than 0');
      }
      let { removelastinformation } = req.params;
      removelastinformation = removelastinformation || req.query.removelastinformation || false;
      removelastinformation = serviceHelper.ensureBoolean(removelastinformation);

      await rescanGlobalAppsInformation(blockheight, removelastinformation);
      const message = messageHelper.createSuccessMessage('Rescan successfull');
      res.json(message);
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

async function countAppInstallingErrors(hash) {
  const dbopen = dbHelper.databaseConnection();
  const database = dbopen.db(config.get('database.appsglobal.database'));
  return dbHelper.countInDatabase(database, globalAppsInstallingErrorsLocations, { hash });
}

async function insertAppSpecifications(appSpecs) {
  try {
    const db = dbHelper.databaseConnection();
    const database = db.db(config.get('database.appsglobal.database'));
    const existingHeight = await appsRepository.getGlobalAppHeight(appSpecs.name);
    if (existingHeight !== null && existingHeight >= appSpecs.height) return true;
    await storeGlobalSpec(appSpecs);
    fluxEventBus.publish('app:specStored', { name: appSpecs.name, hash: appSpecs.hash });
    // Best-effort, decoupled from the hot path: now that this app's spec is known,
    // promote any manifest we were holding quarantined for it (the non-running-node
    // case, §9.2c). setImmediate isolates the benchmark-channel unseal from app-message
    // processing; a failure is logged, never blocks or fails the spec store.
    setImmediate(() => contentSlotService.promoteQuarantinedManifest(appSpecs.name).catch((e) => log.warn(`contentSlot: promote-on-confirm for ${appSpecs.name} failed - ${e.message ?? e}`)));
    await dbHelper.removeDocumentsFromCollection(database, globalAppsInstallingErrorsLocations, { name: appSpecs.name });
    await dbHelper.removeDocumentsFromCollection(database, globalAppsInstallingErrorsBroadcasts, { 'data.name': appSpecs.name });
    return true;
  } catch (error) {
    log.error(`insertAppSpecifications failed for ${appSpecs.name}: ${error.message}`);
    return false;
  }
}

async function updateAppSpecifications(appSpecs) {
  try {
    const db = dbHelper.databaseConnection();
    const database = db.db(config.get('database.appsglobal.database'));
    const existingHeight = await appsRepository.getGlobalAppHeight(appSpecs.name);
    if (existingHeight === null || existingHeight >= appSpecs.height) return true;
    await storeGlobalSpec(appSpecs, { upsert: false });
    fluxEventBus.publish('app:specStored', { name: appSpecs.name, hash: appSpecs.hash });
    // Best-effort, decoupled from the hot path: now that this app's spec is known,
    // promote any manifest we were holding quarantined for it (the non-running-node
    // case, §9.2c). setImmediate isolates the benchmark-channel unseal from app-message
    // processing; a failure is logged, never blocks or fails the spec store.
    setImmediate(() => contentSlotService.promoteQuarantinedManifest(appSpecs.name).catch((e) => log.warn(`contentSlot: promote-on-confirm for ${appSpecs.name} failed - ${e.message ?? e}`)));
    await dbHelper.removeDocumentsFromCollection(database, globalAppsInstallingErrorsLocations, { name: appSpecs.name });
    await dbHelper.removeDocumentsFromCollection(database, globalAppsInstallingErrorsBroadcasts, { 'data.name': appSpecs.name });
    return true;
  } catch (error) {
    log.error(`updateAppSpecifications failed for ${appSpecs.name}: ${error.message}`);
    return false;
  }
}

module.exports = {
  getScannedHeight,
  setOnSpecStored,
  getAppHashes,
  appLocation,
  appInstallingLocation,
  installingCountsByApp,
  appInstallingErrorsLocation,
  storeAppInstallingMessage,
  removeAppInstallingMessage,
  prepareInstallingClaimsCollections,
  getAppsLocations,
  getAppsLocation,
  getAppInstallingLocation,
  getAppInstallingErrorsLocation,
  getAppsInstallingErrorsLocations,
  getApplicationSpecificationAPI,
  convertApplicationSpecification,
  appConvertApi,
  getApplicationComponentNamesAPI,
  getApplicationOwner,
  getApplicationOwnerAPI,
  getGlobalAppsSpecifications,
  availableApps,
  checkApplicationRegistrationNameConflicts,
  updateAppSpecsForRescanReindex,
  storeAppSpecificationInPermanentStorage,
  getAllAppsInformation,
  getRunningApps,
  getRunningAppIpList,
  reindexGlobalAppsInformation,
  rescanGlobalAppsInformation,
  reconstructAppMessagesHashCollection,
  reconstructAppMessagesHashCollectionAPI,
  reindexGlobalAppsLocationAPI,
  reindexGlobalAppsInformationAPI,
  rescanGlobalAppsInformationAPI,
  countAppInstallingErrors,
  insertAppSpecifications,
  updateAppSpecifications,
};
