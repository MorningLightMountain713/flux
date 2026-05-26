const config = require('config');
const dbHelper = require('../dbHelper');
const appsMaintenance = require('./appsMaintenance');
const appsRepository = require('./appsRepository');
const log = require('../../lib/log');
const messageHelper = require('../messageHelper');
const serviceHelper = require('../serviceHelper');
const verificationHelper = require('../verificationHelper');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const appEventVerifier = require('../appMessaging/appEventVerifier');
const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
const appUninstaller = require('../appLifecycle/appUninstaller');
const legacyCryptoProvider = require('../providers/FluxOSLegacyCryptoProvider');
const { validateSubmissionSpec, getSpecBackend } = require('../utils/specLibs');
const { deserializeSpec } = require('../utils/specCutover');
const legacyTransportProvider = require('../providers/FluxOSLegacyTransportProvider');
const fluxEventBus = require('../utils/fluxEventBus');
const {
  SIGTERM_EXPIRY_MS,
  globalAppsInformation,
  localAppsInformation,
  globalAppsMessages,
  globalAppsLocations,
  globalAppStateEvents,
  globalAppsInstallingLocations,
  globalAppsInstallingErrorsLocations,
  globalAppsInstallingErrorsBroadcasts,
  appsHashesCollection,
  scannedHeightCollection,
} = require('../utils/appConstants');

let reindexRunning = false;

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

  if (message.version !== 1) {
    throw new Error(`Invalid Flux App Installing message for storing version ${message.version} not supported`);
  }

  const validTill = message.broadcastedAt + (5 * 60 * 1000); // 5 minutes
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
    broadcastedAt: new Date(message.broadcastedAt),
    expireAt: new Date(validTill),
  };

  // indexes over name, hash, ip. Then name + ip and name + ip + broadcastedAt.
  const queryFind = { name: newAppInstallingMessage.name, ip: newAppInstallingMessage.ip };
  const projection = { _id: 0 };
  // we already have the exact same data
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
  await dbHelper.updateOneInDatabase(database, globalAppsInstallingLocations, queryUpdate, update, options);

  // all stored, rebroadcast
  return true;
}

/**
 * To return the owner of a FluxOS application.
 * @param {string} appName Name of app.
 * @returns {string|null} Owner.
 */
async function getApplicationOwner(appName) {
  const appSpecs = await appsRepository.getGlobalAppInfoRaw(appName, { owner: 1 });
  if (appSpecs) {
    return appSpecs.owner;
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
 * Get application specification via API
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
async function getApplicationSpecification(appname, encryptedEnterpriseKey) {
  const instantiated = await appsRepository.getGlobalAppInfo(appname);
  if (!instantiated) {
    throw new Error(`Application: ${appname} not found`);
  }

  if (!encryptedEnterpriseKey || !instantiated.isEncrypted()) {
    return instantiated.spec.serialize();
  }

  const backendProvider = await legacyCryptoProvider.create(
    instantiated.name, instantiated.owner,
  );
  const decrypted = await instantiated.spec.decrypt(backendProvider);
  const transportProvider = await legacyTransportProvider.create(
    instantiated.name, instantiated.owner, encryptedEnterpriseKey,
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

    let encryptedEnterpriseKey;
    if (decrypt) {
      encryptedEnterpriseKey = req.headers['enterprise-key'];
      if (!encryptedEnterpriseKey) {
        throw new Error('Header with enterpriseKey is mandatory for enterprise Apps.');
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
    }

    const spec = await getApplicationSpecification(appname, encryptedEnterpriseKey);
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
    const results = await appsRepository.listGlobalAppInfoRaw({ filter });
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
    const globalApps = await appsRepository.listGlobalAppInfoRaw();
    const localApps = await appsRepository.listInstalledAppsRaw();
    const allApps = [...globalApps, ...localApps];

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
  const existing = await appsRepository.getGlobalAppInfoRaw(appSpecs.name);
  if (!existing || existing.height < appSpecs.height) {
    await appsRepository.upsertGlobalAppInfo(appSpecs);
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
    await appsRepository.upsertGlobalAppInfo(appSpec);
    log.info(`App specification stored permanently for ${appSpec.name}`);
    return { status: 'success', message: 'App specification stored' };
  } catch (error) {
    log.error(`Error storing app specification: ${error.message}`);
    throw error;
  }
}

/**
 * Get app specification from database
 * @param {string} appName - Application name
 * @returns {Promise<object|null>} App specification
 */
async function getAppSpecificationFromDb(appName) {
  try {
    return await appsRepository.getGlobalAppInfoRaw(appName);
  } catch (error) {
    log.error(`Error getting app specification from database: ${error.message}`);
    return null;
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
 * Get all global applications from database
 * @param {string[]} proj - Optional projection fields
 * @returns {Promise<object[]>} Array of global applications
 */
async function getAllGlobalApplications(proj = []) {
  try {
    const projection = {};
    proj.forEach((field) => {
      projection[field] = 1;
    });
    return await appsRepository.listGlobalAppInfoRaw({
      projection: Object.keys(projection).length > 0 ? projection : undefined,
      sort: { height: 1 },
    });
  } catch (error) {
    log.error(error);
    return [];
  }
}

/**
 * Remove expired applications from global database and local installations
 * @returns {Promise<void>} Completion status
 */
async function expireGlobalApplications() {
  // check if synced
  try {
    // get current height
    const dbopen = dbHelper.databaseConnection();
    const database = dbopen.db(config.database.daemon.database);
    const query = { generalScannedHeight: { $gte: 0 } };
    const projection = {
      projection: {
        _id: 0,
        generalScannedHeight: 1,
      },
    };
    const result = await dbHelper.findOneInDatabase(database, scannedHeightCollection, query, projection);
    if (!result) {
      throw new Error('Scanning not initiated');
    }
    const explorerHeight = serviceHelper.ensureNumber(result.generalScannedHeight);
    let minExpirationHeight = explorerHeight - config.fluxapps.newMinBlocksAllowance; // do a pre search in db as every app has to live for at least newMinBlocksAllowance
    if (explorerHeight < config.fluxapps.newMinBlocksAllowanceBlock) {
      minExpirationHeight = explorerHeight - config.fluxapps.minBlocksAllowance; // do a pre search in db as every app has to live for at least minBlocksAllowance
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    const candidates = await appsRepository.listGlobalAppInfo({
      filter: {
        $or: [
          { height: { $lt: minExpirationHeight }, version: { $lt: 9 } },
          { version: { $gte: 9 } },
        ],
      },
    });
    const appsToExpire = candidates.filter(
      (is) => is.isExpired(nowSeconds, explorerHeight),
    );
    const appNamesToExpire = appsToExpire.map((is) => is.name);
    // remove appNamesToExpire apps from global database
    // eslint-disable-next-line no-restricted-syntax
    const databaseApps = dbopen.db(config.database.appsglobal.database);
    for (const app of appsToExpire) {
      log.info(`Expiring application ${app.name}`);
      // eslint-disable-next-line no-await-in-loop
      await appsRepository.removeGlobalAppInfo(app.name);
      // eslint-disable-next-line no-await-in-loop
      await dbHelper.removeDocumentsFromCollection(databaseApps, globalAppsInstallingErrorsLocations, { name: app.name });
    }

    const installedDocs = await appsRepository.listInstalledAppsRaw({});
    const { InstantiatedSpec } = await getSpecBackend();
    const appsToRemoveNames = [];
    for (const app of installedDocs) {
      if (appNamesToExpire.includes(app.name)) {
        appsToRemoveNames.push(app.name);
      } else if (!app.height) {
        appsToRemoveNames.push(app.name);
      } else if (app.height === 0) {
        // forever lasting local app — skip
      } else {
        try {
          const is = InstantiatedSpec.deserialize(app);
          if (is.isExpired(nowSeconds, explorerHeight)) {
            appsToRemoveNames.push(app.name);
          }
        } catch (err) {
          log.warn(`expireGlobalApplications: failed to hydrate local app ${app.name}: ${err.message}`);
          appsToRemoveNames.push(app.name);
        }
      }
    }

    // eslint-disable-next-line no-restricted-syntax
    for (const appName of appsToRemoveNames) {
      log.warn(`Application ${appName} is expired, removing`);
      log.warn(`REMOVAL REASON: App expired - ${appName} reached expiration date (registryManager)`);
      // eslint-disable-next-line no-await-in-loop
      await appUninstaller.uninstallApplication(appName, { forceKill: true, skipGuard: true, broadcastRemoval: true });
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(1 * 60 * 1000); // wait for 1 min
    }
  } catch (error) {
    log.error(error);
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
      const updateForSpecifications = message.appSpecifications || message.zelAppSpecifications;
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

/**
 * To get previous app specifications from the permanent message log. Used when
 * verifying an app update message: the prior registration/update spec may no
 * longer be in global apps (e.g. the app expired), so the message log is the
 * accurate source. Lives here (not in advancedWorkflows) so message verification
 * does not depend on the lifecycle layer — that was a require cycle.
 * @param {object} specifications App specifications.
 * @param {object} verificationTimestamp Message timestamp.
 * @returns {object|null} App specifications or null if not found.
 */
async function getPreviousAppSpecifications(specifications, verificationTimestamp) {
  // we may not have the application in global apps. This can happen when we receive the message
  // after the app has already expired AND we need to get message right before our message.
  // Thus using messages system that is accurate
  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.appsglobal.database);
  const projection = {
    projection: {
      _id: 0,
    },
  };
  const appsQuery = {
    'appSpecifications.name': specifications.name,
  };
  const permanentAppMessage = await dbHelper.findInDatabase(database, globalAppsMessages, appsQuery, projection);
  let latestPermanentRegistrationMessage;
  permanentAppMessage.forEach((foundMessage) => {
    // has to be registration message
    const validTypes = ['zelappregister', 'fluxappregister', 'zelappupdate', 'fluxappupdate'];
    if (validTypes.includes(foundMessage.type)) {
      if (!latestPermanentRegistrationMessage && foundMessage.timestamp <= verificationTimestamp) {
        // no message and found message is not newer than our message
        latestPermanentRegistrationMessage = foundMessage;
      } else if (latestPermanentRegistrationMessage && latestPermanentRegistrationMessage.height <= foundMessage.height) {
        // we have some message and the message is quite new
        if (latestPermanentRegistrationMessage.timestamp < foundMessage.timestamp
          && foundMessage.timestamp <= verificationTimestamp) {
          // but our message is newer. foundMessage has to have lower timestamp than our new message
          latestPermanentRegistrationMessage = foundMessage;
        }
      }
    }
  });
  // some early app have zelAppSepcifications
  const appsQueryB = {
    'zelAppSpecifications.name': specifications.name,
  };
  const permanentAppMessageB = await dbHelper.findInDatabase(database, globalAppsMessages, appsQueryB, projection);
  permanentAppMessageB.forEach((foundMessage) => {
    // has to be registration message
    const validTypes = ['zelappregister', 'fluxappregister', 'zelappupdate', 'fluxappupdate'];
    if (validTypes.includes(foundMessage.type)) {
      if (!latestPermanentRegistrationMessage && foundMessage.timestamp <= verificationTimestamp) {
        // no message and found message is not newer than our message
        latestPermanentRegistrationMessage = foundMessage;
      } else if (latestPermanentRegistrationMessage && latestPermanentRegistrationMessage.height <= foundMessage.height) {
        // we have some message and the message is quite new
        if (latestPermanentRegistrationMessage.timestamp < foundMessage.timestamp
          && foundMessage.timestamp <= verificationTimestamp) {
          // but our message is newer. foundMessage has to have lower timestamp than our new message
          latestPermanentRegistrationMessage = foundMessage;
        }
      }
    }
  });
  if (!latestPermanentRegistrationMessage) {
    return null;
  }
  const appSpecs = latestPermanentRegistrationMessage.appSpecifications
    || latestPermanentRegistrationMessage.zelAppSpecifications;
  if (!appSpecs) {
    throw new Error(`Previous specifications for ${specifications.name} update message does not exists! This should not happen.`);
  }
  if (appSpecs.version >= 8 && appSpecs.enterprise) {
    try {
      const heightForDecrypt = latestPermanentRegistrationMessage.height;
      const decryptedPrev = await checkAndDecryptAppSpecs(appSpecs, { daemonHeight: heightForDecrypt });
      return specificationFormatter(decryptedPrev);
    } catch {
      return specificationFormatter(appSpecs);
    }
  }
  return specificationFormatter(appSpecs);
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
                { $let: { vars: { sd: { $first: { $filter: { input: '$shutdowns', as: 's', cond: { $eq: ['$$s._id', '$$entry.ip'] } } } } }, in: { $or: [{ $eq: ['$$sd', null] }, { $gte: ['$$entry.broadcastedAt', '$$sd.eventAt'] }, { $and: [{ $eq: ['$$sd.type', 'sigterm'] }, { $gt: [{ $add: ['$$sd.eventAt', SIGTERM_EXPIRY_MS] }, now] }] }] } } },
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
          { $project: { _id: 0, name: '$_v2Filtered.apps.name', hash: '$_v2Filtered.apps.hash', ip: '$_v2Filtered.ip', broadcastedAt: '$_v2Filtered.broadcastedAt', runningSince: { $ifNull: ['$_v2Filtered.apps.runningSince', '$_v2Filtered.runningSince'] }, osUptime: '$_v2Filtered.osUptime', staticIp: '$_v2Filtered.staticIp', removals: 1, ipChanges: 1 } },
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
    const query = { name: appSpecs.name };
    const existing = await dbHelper.findOneInDatabase(database, globalAppsInformation, query, { projection: { _id: 0, height: 1 } });
    if (existing && existing.height >= appSpecs.height) return true;
    await dbHelper.replaceOneInDatabase(database, globalAppsInformation, query, appSpecs, { upsert: true });
    fluxEventBus.publish('app:specStored', { name: appSpecs.name, hash: appSpecs.hash });
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
    const query = { name: appSpecs.name };
    const projection = { projection: { _id: 0 } };
    const appInfo = await dbHelper.findOneInDatabase(database, globalAppsInformation, query, projection);
    if (!appInfo || appInfo.height >= appSpecs.height) return true;
    await dbHelper.replaceOneInDatabase(database, globalAppsInformation, query, appSpecs, { upsert: false });
    fluxEventBus.publish('app:specStored', { name: appSpecs.name, hash: appSpecs.hash });
    await dbHelper.removeDocumentsFromCollection(database, globalAppsInstallingErrorsLocations, { name: appSpecs.name });
    await dbHelper.removeDocumentsFromCollection(database, globalAppsInstallingErrorsBroadcasts, { 'data.name': appSpecs.name });
    return true;
  } catch (error) {
    log.error(`updateAppSpecifications failed for ${appSpecs.name}: ${error.message}`);
    return false;
  }
}

module.exports = {
  getAppHashes,
  getPreviousAppSpecifications,
  appLocation,
  appInstallingLocation,
  appInstallingErrorsLocation,
  storeAppInstallingMessage,
  getAppsLocations,
  getAppsLocation,
  getAppInstallingLocation,
  getAppInstallingErrorsLocation,
  getAppsInstallingErrorsLocations,
  getApplicationSpecificationAPI,
  getApplicationOwner,
  getApplicationOwnerAPI,
  getGlobalAppsSpecifications,
  availableApps,
  checkApplicationRegistrationNameConflicts,
  updateAppSpecsForRescanReindex,
  storeAppSpecificationInPermanentStorage,
  getAppSpecificationFromDb,
  getAllAppsInformation,
  getRunningApps,
  getRunningAppIpList,
  registrationInformation,
  getAllGlobalApplications,
  expireGlobalApplications,
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
