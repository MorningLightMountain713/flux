const config = require('config');
const dbHelper = require('../dbHelper');
const appsMaintenance = require('./appsMaintenance');
const appsRepository = require('./appsRepository');
const log = require('../../lib/log');
const messageHelper = require('../messageHelper');
const serviceHelper = require('../serviceHelper');
const verificationHelper = require('../verificationHelper');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const { getSpec, getSpecBackend } = require('../utils/specLibs');
const legacyTransportProvider = require('../providers/FluxOSLegacyTransportProvider');
const transportCryptoProvider = require('../providers/FluxOSTransportProvider');
const { resolveStorageRefs } = require('../utils/fluxStorageRefs');
const fluxEventBus = require('../utils/fluxEventBus');
const contentSlotService = require('../appLifecycle/contentSlotService');
const {
  SIGTERM_EXPIRY_MS,
  globalAppsInformation,
  localAppsInformation,
  globalAppsMessages,
  globalAppsLocations,
  globalAppStateEvents,
  globalAppsInstallingLocations,
  globalAppsInstallingBroadcasts,
  globalAppsInstallingErrorsLocations,
  globalAppsInstallingErrorsBroadcasts,
  appsHashesCollection,
  scannedHeightCollection,
  INSTALLING_EXPIRY_MS,
} = require('../utils/appConstants');

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
  emitSpecStored(specDoc);
}

/**
 * Get all app hashes from the blockchain
 * @param {object} _req - Request object (unused)
 * @param {object} res - Response object
 * @returns {Promise<object>} List of app hashes
 */
async function getAppHashes(_req, res) {
  try {
    const dbopen = dbHelper.databaseConnection();
    const database = dbopen.db(config.database.daemon.database);
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
 * Get app location information
 * @param {string} appname - Optional app name filter
 * @returns {Promise<Array>} Array of app locations
 */
async function appLocation(appname) {
  if (appname) {
    return appsRepository.listLocationsByApp(appname);
  }
  return appsRepository.listLocations();
}

/**
 * The explorer's scanned height — the height app expiry is evaluated against.
 * @returns {Promise<number>}
 * @throws {Error} when scanning has not initiated
 */
async function getScannedHeight() {
  const daemonDb = dbHelper.databaseConnection().db(config.database.daemon.database);
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
  const database = dbopen.db(config.database.appsglobal.database);
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
 * Get app installing errors locations for a specific app or all apps
 * @param {string} appname - Application name (optional)
 * @returns {Promise<Array>} Array of app installing error locations
 */
async function appInstallingErrorsLocation(appname) {
  const dbopen = dbHelper.databaseConnection();
  const database = dbopen.db(config.database.appsglobal.database);
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
 * @param {object} req - Request object
 * @param {object} res - Response object
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
 * @param {object} req - Request object
 * @param {object} res - Response object
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
  const database = db.db(config.database.appsglobal.database);

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
  const database = db.db(config.database.appsglobal.database);
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
  const database = db.db(config.database.appsglobal.database);

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
 * @param {object} res - Response object
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
 * @param {object} req - Request object
 * @param {object} res - Response object
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
 * @param {object} req - Request object
 * @param {object} res - Response object
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
    const { buildSpecViewAad, SPEC_VIEW_INFO } = await getSpec();
    const viewSpec = decrypted.spec;
    const timestamp = Date.now();
    const aad = buildSpecViewAad({ appName: viewSpec.name, timestamp });
    const provider = await transportCryptoProvider.create(viewSpec.name, viewSpec.owner);
    const plaintext = Buffer.from(JSON.stringify(viewSpec.toCanonical()), 'utf8');
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
      const ownerAuthorized = await verificationHelper.verifyPrivilege(
        'appowner',
        req,
        mainAppName,
      );

      const fluxTeamAuthorized = ownerAuthorized === true
        ? false
        : await verificationHelper.verifyPrivilege(
          'appownerabove',
          req,
          mainAppName,
        );

      if (ownerAuthorized !== true && fluxTeamAuthorized !== true) {
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
 *   complete:false means the draft is missing required fields (listed in errors)
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
    legacySpec = decrypted.spec;
  }

  const { fromLegacy } = await getSpecBackend();
  const { FluxAppSpecV9, buildSpecViewAad, SPEC_VIEW_INFO } = await getSpec();

  const { spec: v9Blob, warnings } = fromLegacy(legacySpec, { confirmationHeight: instantiated.height });

  const inlinedSensitive = await resolveStorageRefs(v9Blob.components, instantiated.name);

  // Convert is a draft generator, so validate without throwing: a fixable gap
  // (e.g. a contacts-less v8 app) returns a fillable draft with inline errors
  // for the owner to complete, not a hard failure. Strict fromSubmission stays
  // at sign-time submission, which requires a valid canonical form anyway.
  const { valid, errors } = FluxAppSpecV9.validateSchema(v9Blob);
  const draft = valid ? FluxAppSpecV9.fromSubmission(v9Blob).toCanonical() : v9Blob;
  const { name, owner } = v9Blob;

  const mustEncrypt = instantiated.isEncrypted || inlinedSensitive;
  if (!mustEncrypt) {
    return {
      encrypted: false, spec: draft, complete: valid, errors, warnings,
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
    encrypted: true, appName: name, timestamp, transportEncrypted, complete: valid, errors, warnings,
  };
}

/**
 * API endpoint: convert an existing app's spec to v9 for owner review.
 * @param {object} req - Request object
 * @param {object} res - Response object
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

    // Conversion can expose secrets (a decrypted enterprise spec or inlined
    // storage-ref values), so gate it to the app owner / flux team, mirroring
    // the encrypted spec-view endpoint.
    const mainAppName = appname.split('_')[1] || appname;
    const ownerAuthorized = await verificationHelper.verifyPrivilege('appowner', req, mainAppName);
    const fluxTeamAuthorized = ownerAuthorized === true
      ? false
      : await verificationHelper.verifyPrivilege('appownerabove', req, mainAppName);
    if (ownerAuthorized !== true && fluxTeamAuthorized !== true) {
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
 * Get application owner via API
 * @param {object} req - Request object
 * @param {object} res - Response object
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
 * @param {object} req - Request object with optional params/query for hash, owner, appname
 * @param {object} res - Response object
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
 * @param {object} res - Response object
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
      const database = dbopen.db(config.database.daemon.database);
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
    return await appsRepository.listLocations();
  } catch (error) {
    log.error(`Error getting running apps: ${error.message}`);
    return [];
  }
}

/**
 * To get all apps running on a specific IP address. Returns all apps running on this ip
 * @param {string} ip IP address to check
 * @returns {Promise<Array>} Array of apps running on the specified IP
 */
async function getRunningAppIpList(ip) {
  return appsRepository.listLocationsByIp(ip);
}

/**
 * Get registration information for Flux apps
 * @param {object} _req - Request object (unused)
 * @param {object} res - Response object
 * @returns {void} Registration information
 */
function registrationInformation(_req, res) {
  try {
    const data = config.fluxapps;
    const response = messageHelper.createDataMessage(data);
    res.json(response);
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
    const appsGlobalDb = db.db(config.database.appsglobal.database);
    const appsLocalDb = db.db(config.database.appslocal.database);
    const daemonDb = db.db(config.database.daemon.database);

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
 * Reconstruct app messages hash collection by validating hash records against actual messages
 * @returns {Promise<string>} Success message
 */
async function reconstructAppMessagesHashCollection() {
  try {
    const db = dbHelper.databaseConnection();
    const databaseApps = db.db(config.database.appsglobal.database);
    const databaseDaemon = db.db(config.database.daemon.database);
    const query = {};
    const projection = { projection: { _id: 0 } };

    const permanentMessages = await dbHelper.findInDatabase(databaseApps, globalAppsMessages, query, projection);
    const appHashes = await dbHelper.findInDatabase(databaseDaemon, appsHashesCollection, query, projection);

    // eslint-disable-next-line no-restricted-syntax
    for (const appHash of appHashes) {
      const options = {};
      const queryUpdate = {
        hash: appHash.hash,
        txid: appHash.txid,
      };

      const permanentMessageFound = permanentMessages.find((message) => message.hash === appHash.hash);

      const update = { $set: { message: !!permanentMessageFound, messageNotFound: false } };
      // eslint-disable-next-line no-await-in-loop
      await dbHelper.updateOneInDatabase(databaseDaemon, appsHashesCollection, queryUpdate, update, options);
    }

    return 'Reconstruct success';
  } catch (error) {
    log.error(error);
    throw error;
  }
}

/**
 * API endpoint to reconstruct app messages hash collection
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @returns {Promise<object>} Reconstruction result message
 */
async function reconstructAppMessagesHashCollectionAPI(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
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
 * Drops and recreates global apps locations collection with indexes
 * @returns {Promise<boolean>} True if successful
 */
async function reindexGlobalAppsLocation() {
  try {
    const db = dbHelper.databaseConnection();
    const database = db.db(config.database.appsglobal.database);
    await dbHelper.dropCollection(database, globalAppsLocations).catch((error) => {
      if (error.message !== 'ns not found') {
        throw error;
      }
    });
    await database.collection(globalAppsLocations).createIndex({ name: 1 }, { name: 'query for getting app location based on app specs name' });
    await database.collection(globalAppsLocations).createIndex({ hash: 1 }, { name: 'query for getting app location based on app hash' });
    await database.collection(globalAppsLocations).createIndex({ ip: 1 }, { name: 'query for getting app location based on ip' });
    await database.collection(globalAppsLocations).createIndex({ name: 1, ip: 1 }, { name: 'query for getting app based on ip and name' });
    await database.collection(globalAppsLocations).createIndex({ name: 1, ip: 1, broadcastedAt: 1 }, { name: 'query for getting app to ensure we possess a message' });
    return true;
  } catch (error) {
    log.error(error);
    throw error;
  }
}

/**
 * To reindex global apps location via API. Only accessible by admins and Flux team members.
 * @param {object} req Request.
 * @param {object} res Response.
 */
async function reindexGlobalAppsLocationAPI(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
    if (authorized === true) {
      await reindexGlobalAppsLocation();
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
 * To reindex global apps information via API. Only accessible by admins and Flux team members.
 * @param {object} req Request.
 * @param {object} res Response.
 */
async function reindexGlobalAppsInformationAPI(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
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
    const database = db.db(config.database.appsglobal.database);

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
 * @param {object} req Request.
 * @param {object} res Response.
 */
async function rescanGlobalAppsInformationAPI(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
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
      const database = dbopen.db(config.database.daemon.database);
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

async function appLocationFromEvents(options = {}) {
  const { appname, ip } = options;
  const dbopen = dbHelper.databaseConnection();
  const database = dbopen.db(config.database.appsglobal.database);
  const collection = database.collection(globalAppStateEvents);

  const escapedName = appname ? appname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : null;
  const nameMatch = escapedName ? new RegExp(`^${escapedName}$`, 'i') : null;
  const now = new Date();

  const v1NameFilter = nameMatch ? [{ $match: { 'data.name': nameMatch } }] : [];
  const removalNameFilter = nameMatch ? [{ $match: { 'data.appName': nameMatch } }] : [];

  const initialMatch = {
    $or: [
      { type: { $in: ['apprunning', 'appremoved', 'ipchanged'] }, expireAt: { $gt: now } },
      { type: { $in: ['sigterm', 'evicted'] } },
    ],
  };
  if (ip) initialMatch.ip = ip;

  const pipeline = [
    { $match: initialMatch },
    { $sort: { broadcastedAt: -1 } },
    {
      $facet: {
        v2: [
          { $match: { type: 'apprunning', 'data.apps': { $exists: true } } },
          { $group: { _id: '$ip', doc: { $first: '$$ROOT' } } },
          { $replaceRoot: { newRoot: '$doc' } },
          { $project: { _id: 0, ip: '$data.ip', broadcastedAt: 1, apps: '$data.apps', osUptime: '$data.osUptime', staticIp: '$data.staticIp', runningSince: '$data.runningSince' } },
        ],
        v1: [
          ...v1NameFilter,
          { $match: { type: 'apprunning', 'data.name': { $exists: true } } },
          { $group: { _id: { ip: '$ip', name: '$data.name' }, doc: { $first: '$$ROOT' } } },
          { $replaceRoot: { newRoot: '$doc' } },
          { $project: { _id: 0, name: '$data.name', hash: '$data.hash', ip: '$data.ip', broadcastedAt: 1, runningSince: '$data.runningSince', osUptime: '$data.osUptime', staticIp: '$data.staticIp' } },
        ],
        v2Timestamps: [
          { $match: { type: 'apprunning', 'data.apps': { $exists: true } } },
          { $group: { _id: '$ip', latestV2: { $first: '$broadcastedAt' } } },
        ],
        removals: [
          { $match: { type: 'appremoved' } },
          ...removalNameFilter,
          { $group: { _id: { ip: '$ip', name: '$data.appName' }, removedAt: { $first: '$broadcastedAt' } } },
        ],
        shutdowns: [
          { $match: { type: { $in: ['sigterm', 'evicted'] } } },
          { $addFields: { _eventAt: { $ifNull: ['$broadcastedAt', '$createdAt'] } } },
          { $sort: { _eventAt: -1 } },
          { $group: { _id: '$ip', eventAt: { $first: '$_eventAt' }, expireAt: { $first: '$expireAt' }, type: { $first: '$type' } } },
        ],
        ipChanges: [
          { $match: { type: 'ipchanged' } },
          { $group: { _id: '$ip', newIP: { $first: '$data.newIP' }, changedAt: { $first: '$broadcastedAt' } } },
        ],
      },
    },
    {
      $addFields: {
        _v2Filtered: {
          $filter: {
            input: '$v2', as: 'entry',
            cond: {
              $let: {
                vars: { sd: { $first: { $filter: { input: '$shutdowns', as: 's', cond: { $eq: ['$$s._id', '$$entry.ip'] } } } } },
                in: { $or: [{ $eq: ['$$sd', null] }, { $gte: ['$$entry.broadcastedAt', '$$sd.eventAt'] }, { $and: [{ $eq: ['$$sd.type', 'sigterm'] }, { $gt: [{ $add: ['$$sd.eventAt', SIGTERM_EXPIRY_MS] }, now] }] }] },
              },
            },
          },
        },
      },
    },
    {
      $addFields: {
        _v1Filtered: {
          $filter: {
            input: '$v1', as: 'entry',
            cond: {
              $and: [
                { $let: { vars: { v2Ts: { $first: { $filter: { input: '$v2Timestamps', as: 't', cond: { $eq: ['$$t._id', '$$entry.ip'] } } } } }, in: { $or: [{ $eq: ['$$v2Ts', null] }, { $gt: ['$$entry.broadcastedAt', '$$v2Ts.latestV2'] }] } } },
                {
                  $let: {
                    vars: { sd: { $first: { $filter: { input: '$shutdowns', as: 's', cond: { $eq: ['$$s._id', '$$entry.ip'] } } } } },
                    in: { $or: [{ $eq: ['$$sd', null] }, { $gte: ['$$entry.broadcastedAt', '$$sd.eventAt'] }, { $and: [{ $eq: ['$$sd.type', 'sigterm'] }, { $gt: [{ $add: ['$$sd.eventAt', SIGTERM_EXPIRY_MS] }, now] }] }] },
                  },
                },
              ],
            },
          },
        },
      },
    },
    {
      $facet: {
        fromV2: [
          { $unwind: '$_v2Filtered' }, { $unwind: '$_v2Filtered.apps' },
          ...(nameMatch ? [{ $match: { '_v2Filtered.apps.name': nameMatch } }] : []),
          {
            $project: {
              _id: 0,
              name: '$_v2Filtered.apps.name',
              hash: '$_v2Filtered.apps.hash',
              ip: '$_v2Filtered.ip',
              broadcastedAt: '$_v2Filtered.broadcastedAt',
              runningSince: { $ifNull: ['$_v2Filtered.apps.runningSince', '$_v2Filtered.runningSince'] },
              osUptime: '$_v2Filtered.osUptime',
              staticIp: '$_v2Filtered.staticIp',
              // LB lifecycle state + replica identity, per-replica off the v2 apps entry.
              // Normalized to match the stored-collection ingest (storeBatchAppRunningMessages):
              // only explicit draining/stopping survive, everything else is active.
              state: { $cond: [{ $in: ['$_v2Filtered.apps.state', ['draining', 'stopping']] }, '$_v2Filtered.apps.state', 'active'] },
              replica: { $ifNull: ['$_v2Filtered.apps.replica', null] },
              removals: 1,
              ipChanges: 1,
            },
          },
          { $addFields: { _removedAt: { $ifNull: [{ $let: { vars: { r: { $first: { $filter: { input: '$removals', as: 'r', cond: { $and: [{ $eq: ['$$r._id.ip', '$ip'] }, { $eq: ['$$r._id.name', '$name'] }] } } } } }, in: '$$r.removedAt' } }, new Date(0)] } } },
          { $match: { $expr: { $gt: ['$broadcastedAt', '$_removedAt'] } } },
          { $addFields: { _ipChange: { $first: { $filter: { input: '$ipChanges', as: 'c', cond: { $eq: ['$$c._id', '$ip'] } } } } } },
          { $addFields: { ip: { $cond: [{ $and: [{ $ne: ['$_ipChange', null] }, { $gt: ['$_ipChange.changedAt', '$broadcastedAt'] }] }, '$_ipChange.newIP', '$ip'] } } },
          { $project: { removals: 0, ipChanges: 0, _removedAt: 0, _ipChange: 0 } },
        ],
        fromV1: [
          { $unwind: '$_v1Filtered' },
          { $project: { _id: 0, name: '$_v1Filtered.name', hash: '$_v1Filtered.hash', ip: '$_v1Filtered.ip', broadcastedAt: '$_v1Filtered.broadcastedAt', runningSince: '$_v1Filtered.runningSince', osUptime: '$_v1Filtered.osUptime', staticIp: '$_v1Filtered.staticIp', removals: 1, ipChanges: 1 } },
          { $addFields: { _removedAt: { $ifNull: [{ $let: { vars: { r: { $first: { $filter: { input: '$removals', as: 'r', cond: { $and: [{ $eq: ['$$r._id.ip', '$ip'] }, { $eq: ['$$r._id.name', '$name'] }] } } } } }, in: '$$r.removedAt' } }, new Date(0)] } } },
          { $match: { $expr: { $gt: ['$broadcastedAt', '$_removedAt'] } } },
          { $addFields: { _ipChange: { $first: { $filter: { input: '$ipChanges', as: 'c', cond: { $eq: ['$$c._id', '$ip'] } } } } } },
          { $addFields: { ip: { $cond: [{ $and: [{ $ne: ['$_ipChange', null] }, { $gt: ['$_ipChange.changedAt', '$broadcastedAt'] }] }, '$_ipChange.newIP', '$ip'] } } },
          { $project: { removals: 0, ipChanges: 0, _removedAt: 0, _ipChange: 0 } },
        ],
      },
    },
    { $project: { all: { $concatArrays: ['$fromV2', '$fromV1'] } } },
    { $unwind: '$all' },
    { $replaceRoot: { newRoot: '$all' } },
    { $sort: { broadcastedAt: -1 } },
    { $group: { _id: { name: '$name', ip: '$ip' }, name: { $first: '$name' }, hash: { $first: '$hash' }, ip: { $first: '$ip' }, broadcastedAt: { $first: '$broadcastedAt' }, runningSince: { $first: '$runningSince' }, osUptime: { $first: '$osUptime' }, staticIp: { $first: '$staticIp' } } },
    { $project: { _id: 0 } },
  ];

  return collection.aggregate(pipeline).toArray();
}

async function countAppInstallingErrors(hash) {
  const dbopen = dbHelper.databaseConnection();
  const database = dbopen.db(config.database.appsglobal.database);
  return dbHelper.countInDatabase(database, globalAppsInstallingErrorsLocations, { hash });
}

async function insertAppSpecifications(appSpecs) {
  try {
    const db = dbHelper.databaseConnection();
    const database = db.db(config.database.appsglobal.database);
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
    const database = db.db(config.database.appsglobal.database);
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
  registrationInformation,
  reindexGlobalAppsInformation,
  reindexGlobalAppsLocation,
  rescanGlobalAppsInformation,
  reconstructAppMessagesHashCollection,
  reconstructAppMessagesHashCollectionAPI,
  reindexGlobalAppsLocationAPI,
  reindexGlobalAppsInformationAPI,
  rescanGlobalAppsInformationAPI,
  appLocationFromEvents,
  countAppInstallingErrors,
  insertAppSpecifications,
  updateAppSpecifications,
};
