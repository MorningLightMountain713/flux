// App Query Service - Query and information functions for installed apps
const config = require('config');
const dbHelper = require('../dbHelper');
const messageHelper = require('../messageHelper');
const dockerService = require('../dockerService');
const registryManager = require('../appDatabase/registryManager');
const appsRepository = require('../appDatabase/appsRepository');
const operationRegistry = require('../utils/operationRegistry');
const log = require('../../lib/log');

// Database collections
const globalAppsMessages = config.database.appsglobal.collections.appsMessages;

/**
 * To list installed apps. Returns apps from local database.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
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
  let apps = await dockerService.dockerListContainers(false);
  if (apps.length > 0) {
    apps = apps.filter((app) => app.Names[0].slice(1, 5) === 'flux');
  }

  // Apps mid backup/restore appear stopped but must still be surfaced as present.
  // Derive the set from the registry's backup/restore leases (the same app-name
  // keys the flag arrays held).
  const appsInBackupRestore = [...operationRegistry.listByType('backup'), ...operationRegistry.listByType('restore')];

  if (appsInBackupRestore.length > 0) {
    const allContainers = await dockerService.dockerListContainers(true);
    const fluxContainers = allContainers.filter((app) => app.Names[0].slice(1, 5) === 'flux');

    fluxContainers.forEach((container) => {
      const containerName = container.Names[0].slice(1);
      const appName = containerName.replace(/^flux/, '');

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

    // Include apps that are in backup or restore as "running" even if container is stopped
    const appsInBackupRestore = [...operationRegistry.listByType('backup'), ...operationRegistry.listByType('restore')];

    if (appsInBackupRestore.length > 0) {
      // Get all containers including stopped ones
      const allContainers = await dockerService.dockerListContainers(true);
      const fluxContainers = allContainers.filter((app) => (app.Names[0].slice(1, 4) === 'zel' || app.Names[0].slice(1, 5) === 'flux'));

      // Find stopped containers that are in backup/restore and add them to running list
      fluxContainers.forEach((container) => {
        const containerName = container.Names[0].slice(1); // Remove leading '/'
        const appName = containerName.replace(/^(zel|flux)/, ''); // Remove zel/flux prefix
        // backup/restore hold the bare MAIN app name; composed containers are
        // component_app, so compare on the main name
        const mainAppName = appName.split('_')[1] || appName;

        // If this app is in backup/restore and not already in running list, add it
        if (appsInBackupRestore.includes(mainAppName)) {
          const alreadyIncluded = apps.some((app) => app.Names[0] === container.Names[0]);
          if (!alreadyIncluded) {
            // Keep original state - FDM treats any container in list as active
            const containerCopy = { ...container };
            apps.push(containerCopy);
          }
        }
      });
    }

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
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Message.
 */
async function listAllApps(req, res) {
  try {
    let apps = await dockerService.dockerListContainers(true);
    if (apps.length > 0) {
      apps = apps.filter((app) => app.Names[0].slice(1, 5) === 'flux');
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
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getlatestApplicationSpecificationAPI(req, res) {
  const latestSpec = config.fluxapps.latestAppSpecification || 1;

  const message = messageHelper.createDataMessage(latestSpec);

  res.json(message);
}

/**
 * To get application original owner.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
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
    // An app nobody has registered is an ordinary answer, not a fault. Reading through the
    // empty result threw "Cannot read properties of undefined", which reached the caller as
    // the error message and said nothing about the app it was asked for.
    if (!lastAppRegistration) {
      throw new Error(`No registration message found for ${appname}`);
    }
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
 * @param {import('express').Request} req
 * @param {import('express').Response} res
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
 * @param {import('express').Request} req
 * @param {import('express').Response} res
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

    const query = { 'appSpecifications.owner': appowner };

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
  installedApps,
  listRunningContainers,
  listRunningApps,
  listAllApps,
  getlatestApplicationSpecificationAPI,
  getApplicationOriginalOwner,
  getAppsInstallingLocations,
  getAppsMessagesCount,
};
