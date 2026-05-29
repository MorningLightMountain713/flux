// App Query Service - Query and information functions for installed apps
const config = require('config');
const dbHelper = require('../dbHelper');
const messageHelper = require('../messageHelper');
const dockerService = require('../dockerService');
const registryManager = require('../appDatabase/registryManager');
const appsRepository = require('../appDatabase/appsRepository');
const appConstants = require('../utils/appConstants');
// decryptEnterpriseApps survives this migration: the reconciler depends on it
// (throwOnError) until the decrypt path is re-routed through the domain provider
const { checkAndDecryptAppSpecs } = require('../utils/enterpriseHelper');
const { specificationFormatter } = require('../utils/appSpecHelpers');
const fluxCaching = require('../utils/cacheManager');
const log = require('../../lib/log');

// Database collections
const globalAppsMessages = config.database.appsglobal.collections.appsMessages;

/**
 * Decrypt enterprise apps from a list of apps
 * @param {Array} apps - Array of app specifications
 * @param {Object} options - Options for decryption
 * @param {boolean} options.formatSpecs - Whether to format specs (strips metadata like hash, height). Default: true
 * @returns {Promise<Array>} Array of decrypted app specifications
 */
async function decryptEnterpriseApps(apps, options = {}) {
  const { formatSpecs = true, throwOnError = false } = options;
  const decryptedApps = [];
  const cache = fluxCaching.default.enterpriseAppDecryptionCache;

  // eslint-disable-next-line no-restricted-syntax
  for (const spec of apps) {
    const isEnterprise = Boolean(
      spec.version >= 8 && spec.enterprise,
    );
    if (isEnterprise) {
      try {
        // Use app hash as cache key
        const cacheKey = spec.hash;

        // Check if decrypted app is in cache
        let decrypted = cache.get(cacheKey);
        if (decrypted) {
          log.info(`Using cached decrypted app for ${spec.name} (${cacheKey})`);
        } else {
          // Decrypt and cache the app (unformatted)
          // eslint-disable-next-line no-await-in-loop
          decrypted = await checkAndDecryptAppSpecs(spec);

          // Store unformatted in cache with 7-day TTL (configured in cacheManager)
          cache.set(cacheKey, decrypted);
          log.info(`Cached decrypted app for ${spec.name} (${cacheKey})`);
        }

        // Apply formatting if requested
        const result = formatSpecs ? specificationFormatter(decrypted) : decrypted;
        decryptedApps.push(result);
      } catch (error) {
        log.error(`Failed to decrypt enterprise app ${spec.name}: ${error.message}`);
        // Display/listing callers (default) keep the lenient behavior: include the
        // still-encrypted spec so the rest of the list isn't lost. Callers that act
        // on the spec (the reconciler) pass throwOnError so they can defer rather
        // than operate on undecrypted data (wrong containerData, mis-typed g:/r:).
        if (throwOnError) throw error;
        decryptedApps.push(spec);
      }
    } else {
      decryptedApps.push(spec);
    }
  }
  return decryptedApps;
}

/**
 * To list installed apps. Returns apps from local database.
 * @param {object} req Request.
 * @param {object} res Response.
 * @returns {object} Message.
 */
async function installedApps(req, res) {
  try {
    let filter = {};
    if (req && req.params && req.query) {
      let { appname } = req.params;
      appname = appname || req.query.appname;
      if (appname) {
        filter = { name: appname };
      }
    } else if (req && typeof req === 'string') {
      filter = { name: req };
    }

    const installed = await appsRepository.listInstalledApps({ filter });
    const apps = installed.map((app) => app.serialize());
    const dataResponse = messageHelper.createDataMessage(apps);
    return res ? res.json(dataResponse) : dataResponse;
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

async function listRunningContainers() {
  const globalState = require('../utils/globalState');

  let apps = await dockerService.dockerListContainers(false);
  if (apps.length > 0) {
    apps = apps.filter((app) => (app.Names[0].slice(1, 4) === 'zel' || app.Names[0].slice(1, 5) === 'flux'));
  }

  const backupInProgress = globalState.backupInProgress || [];
  const restoreInProgress = globalState.restoreInProgress || [];
  const appsInBackupRestore = [...backupInProgress, ...restoreInProgress];

  if (appsInBackupRestore.length > 0) {
    const allContainers = await dockerService.dockerListContainers(true);
    const fluxContainers = allContainers.filter((app) => (app.Names[0].slice(1, 4) === 'zel' || app.Names[0].slice(1, 5) === 'flux'));

    fluxContainers.forEach((container) => {
      const containerName = container.Names[0].slice(1);
      const appName = containerName.replace(/^(zel|flux)/, '');

      if (appsInBackupRestore.includes(appName)) {
        const alreadyIncluded = apps.some((app) => app.Names[0] === container.Names[0]);
        if (!alreadyIncluded) {
          apps.push({ ...container });
        }
      }
    });
  }

  return apps;
}

async function listRunningApps(req, res) {
  try {
    const apps = await listRunningContainers();

    const modifiedApps = apps.map((app) => {
      const copy = { ...app };
      delete copy.HostConfig;
      delete copy.NetworkSettings;
      delete copy.Mounts;
      return copy;
    });
    const appsResponse = messageHelper.createDataMessage(modifiedApps);
    return res ? res.json(appsResponse) : appsResponse;
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
 * List all apps (both running and installed)
 * @param {object} req Request.
 * @param {object} res Response.
 * @returns {object} Message.
 */
async function listAllApps(req, res) {
  try {
    let apps = await dockerService.dockerListContainers(true);
    if (apps.length > 0) {
      apps = apps.filter((app) => (app.Names[0].slice(1, 4) === 'zel' || app.Names[0].slice(1, 5) === 'flux'));
    }
    const modifiedApps = [];
    apps.forEach((app) => {
      // eslint-disable-next-line no-param-reassign
      delete app.HostConfig;
      // eslint-disable-next-line no-param-reassign
      delete app.NetworkSettings;
      // eslint-disable-next-line no-param-reassign
      delete app.Mounts;
      modifiedApps.push(app);
    });
    const appsResponse = messageHelper.createDataMessage(modifiedApps);
    return res ? res.json(appsResponse) : appsResponse;
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
 * To get latest application specification API version.
 * @param {object} req Request.
 * @param {object} res Response.
 */
async function getlatestApplicationSpecificationAPI(req, res) {
  const latestSpec = config.fluxapps.latestAppSpecification || 1;

  const message = messageHelper.createDataMessage(latestSpec);

  res.json(message);
}

/**
 * To get application original owner.
 * @param {object} req Request.
 * @param {object} res Response.
 */
async function getApplicationOriginalOwner(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;
    if (!appname) {
      throw new Error('No Application Name specified');
    }
    const db = dbHelper.databaseConnection();
    const database = db.db(config.database.appsglobal.database);
    const projection = {
      projection: {
        _id: 0,
      },
    };
    log.info(`Searching register permanent messages for ${appname}`);
    const appsQuery = {
      'appSpecifications.name': appname,
      type: 'fluxappregister',
    };
    const permanentAppMessage = await dbHelper.findInDatabase(database, globalAppsMessages, appsQuery, projection);
    const lastAppRegistration = permanentAppMessage[permanentAppMessage.length - 1];
    const ownerResponse = messageHelper.createDataMessage(lastAppRegistration.appSpecifications.owner);
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
 * To get apps installing locations.
 * @param {object} req Request.
 * @param {object} res Response.
 */
async function getAppsInstallingLocations(req, res) {
  try {
    const results = await registryManager.appInstallingLocation();
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
 * To get count of app messages by owner.
 * @param {object} req Request.
 * @param {object} res Response.
 */
async function getAppsMessagesCount(req, res) {
  try {
    let { appowner } = req.params;
    appowner = appowner || req.query.appowner;
    if (!appowner) {
      throw new Error('No Application Owner specified');
    }
    const db = dbHelper.databaseConnection();
    const database = db.db(config.database.appsglobal.database);

    // Query for both appSpecifications.owner and zelAppSpecifications.owner (legacy)
    const query = {
      $or: [
        { 'appSpecifications.owner': appowner },
        { 'zelAppSpecifications.owner': appowner },
      ],
    };

    const count = await dbHelper.countInDatabase(database, globalAppsMessages, query);
    const countResponse = messageHelper.createDataMessage(count);
    res.json(countResponse);
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

module.exports = {
  decryptEnterpriseApps,
  installedApps,
  listRunningContainers,
  listRunningApps,
  listAllApps,
  getlatestApplicationSpecificationAPI,
  getApplicationOriginalOwner,
  getAppsInstallingLocations,
  getAppsMessagesCount,
};
