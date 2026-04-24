const config = require('config');
const fs = require('node:fs/promises');
const util = require('util');
const df = require('node-df');
const path = require('node:path');
const nodecmd = require('node-cmd');
const systemcrontab = require('crontab');
const axios = require('axios');
const dbHelper = require('../dbHelper');
const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');
const messageHelper = require('../messageHelper');
const dockerService = require('../dockerService');
const verificationHelper = require('../verificationHelper');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const generalService = require('../generalService');
// eslint-disable-next-line no-unused-vars
const upnpService = require('../upnpService');
const {
  localAppsInformation,
  globalAppsInformation,
  globalAppsInstallingErrorsLocations,
  globalAppsMessages,
  globalAppsLocations,
  appsFolder,
} = require('../utils/appConstants');
const appsRepository = require('../appDatabase/appsRepository');
const {
  toCanonicalSpec,
  decryptToCleartextClass,
  deserializeSpec,
} = require('../utils/specCutover');
const { getSpec, getSpecBackend } = require('../utils/specLibs');
const { stopAppMonitoring } = require('../appManagement/appInspector');
const { decryptEnterpriseApps } = require('../appQuery/appQueryService');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const appVolumeService = require('./appVolumeService');
const appUninstaller = require('./appUninstaller');
const appInstaller = require('./appInstaller');
const globalState = require('../utils/globalState');

const isArcane = Boolean(process.env.FLUXOS_PATH);

// Legacy apps that use old gateway IP assignment method
const appsThatMightBeUsingOldGatewayIpAssignment = ['HNSDoH', 'dane', 'fdm', 'Jetpack2', 'fdmdedicated', 'isokosse', 'ChainBraryDApp', 'health', 'ethercalc'];

// Master/slave app tracking
const mastersRunningGSyncthingApps = new Map();
const timeTostartNewMasterApp = new Map();

// Promisified functions
const cmdAsync = util.promisify(nodecmd.run);
const crontabLoad = util.promisify(systemcrontab.load);
const fluxDirPath = process.env.FLUXOS_PATH || path.join(process.env.HOME, 'zelflux');

// We need to avoid circular dependency, so we'll implement getInstalledAppsForDocker locally
// eslint-disable-next-line no-unused-vars
function getInstalledAppsForDocker() {
  try {
    return dockerService.dockerListContainers({
      all: true,
      filters: { name: [config.fluxapps.appNamePrefix] },
    });
  } catch (error) {
    log.error('Error getting installed apps:', error);
    return [];
  }
}

async function getInstalledAppsFromDb(options = {}) {
  try {
    const { decryptApps = false } = options;
    const instantiatedSpecs = await appsRepository.listInstalledApps();
    let apps = instantiatedSpecs.map((is) => is.serialize());
    if (decryptApps) {
      apps = await decryptEnterpriseApps(apps);
    }
    return messageHelper.createDataMessage(apps);
  } catch (error) {
    log.error(error);
    return messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
  }
}



async function getStrictApplicationSpecifications(appName) {
  try {
    return await appsRepository.getGlobalAppInfo(appName);
  } catch (error) {
    log.error(`Error getting strict app specifications for ${appName}:`, error);
    return null;
  }
}

/**
 * Get the FDM index based on app name first letter (distributes across 4 servers)
 * @param {string} appName - Application name
 * @returns {number} FDM index (1-4)
 */
function getFdmIndex(appName) {
  const firstLetter = appName.substring(0, 1).toLowerCase();
  if (firstLetter.match(/[h-n]/)) {
    return 2;
  }
  if (firstLetter.match(/[o-u]/)) {
    return 3;
  }
  if (firstLetter.match(/[v-z]/)) {
    return 4;
  }
  return 1; // a-g or any other character
}

/**
 * Get master IP for an app from FDM using the /appips endpoint.
 * Tries EU, USA, and ASIA FDM servers in order until one succeeds.
 * @param {string} appName - Application name
 * @param {Object} axiosOptions - Axios request options
 * @returns {Promise<{ip: string|null, fdmOk: boolean}>} The master IP (without port) and success status
 */
async function getMasterIpFromFdm(appName, axiosOptions) {
  const fdmIndex = getFdmIndex(appName);
  const fdmRegions = [
    { name: 'EU', baseUrl: `http://fdm-fn-1-${fdmIndex}.runonflux.io:16130` },
    { name: 'USA', baseUrl: `http://fdm-usa-1-${fdmIndex}.runonflux.io:16130` },
    { name: 'ASIA', baseUrl: `http://fdm-sg-1-${fdmIndex}.runonflux.io:16130` },
  ];

  for (const region of fdmRegions) {
    try {
      const url = `${region.baseUrl}/appips/${appName}`;
      // eslint-disable-next-line no-await-in-loop
      const response = await serviceHelper.axiosGet(url, axiosOptions);

      if (response.data && response.data.status === 'success' && response.data.data) {
        const { ips } = response.data.data;
        if (ips && ips.length > 0) {
          // Return the first IP, stripping the port if present
          const ip = ips[0].split(':')[0];
          log.debug(`getMasterIpFromFdm: Got IP ${ip} for app ${appName} from ${region.name} FDM`);
          return { ip, fdmOk: true };
        }
      }
      // No IPs returned from this region, try next
      log.debug(`getMasterIpFromFdm: No IPs returned from ${region.name} FDM for app ${appName}`);
    } catch (error) {
      if (error.response && error.response.status === 404) {
        log.debug(`getMasterIpFromFdm: App ${appName} not found in ${region.name} FDM`);
      } else if (error.response && error.response.status === 503) {
        log.debug(`getMasterIpFromFdm: ${region.name} FDM service starting up for app ${appName}`);
      } else {
        log.error(`getMasterIpFromFdm: Failed to reach ${region.name} FDM for app ${appName}: ${error.message}`);
      }
      // Continue to next region
    }
  }

  // All regions failed or returned no IPs
  return { ip: null, fdmOk: true };
}

/**
 * Find and restore non-enterprise app specifications for proper removal.
 * When local DB has encrypted enterprise specs (compose: []), we need the last non-enterprise
 * version from permanent messages to get port/container info for proper cleanup.
 * @param {Object} installedApp - The installed app object from local database
 * @returns {Promise<Object|null>} App specifications to use for removal, or null if local specs are usable or no non-enterprise version found
 */
async function findAndRestoreNonEnterpriseSpecs(installedApp) {
  // If compose array has data, we can use the local specs directly
  if (!installedApp.compose || installedApp.compose.length > 0) {
    return installedApp;
  }

  log.info(`Local DB has encrypted specs for ${installedApp.name}, searching for last non-enterprise version in permanent messages`);

  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.appsglobal.database);

  const query = {
    'appSpecifications.name': installedApp.name,
    type: { $in: ['fluxappregister', 'fluxappupdate'] },
  };
  const projection = {
    projection: {
      _id: 0,
      appSpecifications: 1,
      hash: 1,
      height: 1,
    },
    sort: { height: -1 }, // Sort descending (newest first)
  };

  const permanentMessages = await dbHelper.findInDatabase(database, globalAppsMessages, query, projection);

  if (!permanentMessages || permanentMessages.length === 0) {
    log.error(`No permanent messages found for ${installedApp.name}`);
    return null;
  }

  // Find the first (most recent) message that is NOT enterprise
  let lastNonEnterpriseMessage = null;
  for (let i = 0; i < permanentMessages.length; i += 1) {
    const message = permanentMessages[i];
    const specs = message.appSpecifications;
    const msgIsEnterprise = Boolean(specs.version >= 8 && specs.enterprise);

    if (!msgIsEnterprise) {
      lastNonEnterpriseMessage = message;
      break;
    }
  }

  if (!lastNonEnterpriseMessage) {
    log.error(`No non-enterprise version found for ${installedApp.name} - cannot properly uninstall without port/container info. Skipping removal to avoid orphaned containers.`);
    return null;
  }

  log.info(`Found non-enterprise version for ${installedApp.name} at height ${lastNonEnterpriseMessage.height} - using for cleanup`);

  // Temporarily restore non-enterprise specs to local DB for proper cleanup
  const specsForRemoval = lastNonEnterpriseMessage.appSpecifications;
  const dbopen = dbHelper.databaseConnection();
  const appsDatabase = dbopen.db(config.database.appslocal.database);
  const appsQuery = { name: installedApp.name };
  const options = { upsert: true };
  await dbHelper.updateOneInDatabase(appsDatabase, localAppsInformation, appsQuery, { $set: specsForRemoval }, options);
  log.info(`Temporarily restored non-enterprise specs to local DB for ${installedApp.name} to enable proper port cleanup`);

  return specsForRemoval;
}

/**
 * Check and remove enterprise apps (v8+) running on non-arcaneOS nodes.
 * This function runs once at startup to clean up incompatible apps.
 * @returns {Promise<void>} Completion status
 */
async function checkAndRemoveEnterpriseAppsOnNonArcane() {
  try {
    // Skip if running on arcaneOS
    if (isArcane) {
      log.info('Running on arcaneOS - skipping enterprise app compatibility check');
      return;
    }

    log.info('Checking for enterprise apps on non-arcaneOS node...');

    // Get installed apps from local database
    const installedAppsRes = await getInstalledAppsFromDb();
    if (installedAppsRes.status !== 'success') {
      log.error('Failed to get installed apps for enterprise check');
      return;
    }

    const installedApps = installedAppsRes.data;
    if (!installedApps || installedApps.length === 0) {
      log.info('No apps installed - enterprise check complete');
      return;
    }

    // eslint-disable-next-line no-restricted-syntax
    for (const installedApp of installedApps) {
      try {
        // Get current global app specifications
        // eslint-disable-next-line no-await-in-loop
        const globalSpecs = await getStrictApplicationSpecifications(installedApp.name);

        if (!globalSpecs) {
          log.warn(`No global specifications found for ${installedApp.name}`);
          // eslint-disable-next-line no-continue
          continue;
        }

        const isEnterprise = globalSpecs.version >= 8 && globalSpecs.isEncrypted();

        if (isEnterprise) {
          log.warn(`Found enterprise app ${installedApp.name} (v${globalSpecs.version}) on non-arcaneOS node`);

          // Find and restore non-enterprise specs if needed
          // eslint-disable-next-line no-await-in-loop
          const specsForRemoval = await findAndRestoreNonEnterpriseSpecs(installedApp);

          if (!specsForRemoval) {
            log.error(`Cannot remove ${installedApp.name} - no non-enterprise specs available for proper cleanup`);
            // eslint-disable-next-line no-continue
            continue;
          }

          // Remove the app from the node with force and broadcast to peers
          log.warn(`REMOVAL REASON: Enterprise app v${globalSpecs.version} detected at startup on non-arcaneOS node - ${installedApp.name}`);

          // eslint-disable-next-line global-require
      

          // eslint-disable-next-line no-await-in-loop
          await appUninstaller.removeAppLocally(installedApp.name, null, true, true, true);

          log.info(`Successfully removed enterprise app ${installedApp.name} and notified peers`);
        }
      } catch (error) {
        log.error(`Error processing app ${installedApp.name} for enterprise check:`, error);
        // Continue with next app even if this one fails
      }
    }

    log.info('Enterprise app compatibility check completed');
  } catch (error) {
    log.error('Error in checkAndRemoveEnterpriseAppsOnNonArcane:', error);
  }
}
// Global state management - using globalState module instead of local variables
// These are now managed through the globalState module
// eslint-disable-next-line no-unused-vars
let dosMountMessage = '';


/**
 * To soft register an app locally (with data volume already in existence). Performs pre-installation checks - database in place, Flux Docker network in place and if app already installed. Then registers app in database and performs soft install. If registration fails, the app is removed locally.
 * @param {object} appSpecs App specifications.
 * @param {object} componentSpecs Component specifications.
 * @param {object} res Response.
 * @returns {void} Return statement is only used here to interrupt the function and nothing is returned.
 */
async function softRegisterAppLocally(appSpecs, componentSpecs, res) {
  // cpu, ram, hdd were assigned to correct tiered specs.
  // get applications specifics from app messages database
  // check if hash is in blockchain
  // register and launch according to specifications in message
  // throw without catching
  try {
    if (globalState.removalInProgress) {
      const rStatus = messageHelper.createErrorMessage('Another application is undergoing removal');
      log.error(rStatus);
      if (res) {
        res.write(serviceHelper.ensureString(rStatus));
        res.end();
      }
      return;
    }
    if (globalState.installationInProgress) {
      const rStatus = messageHelper.createErrorMessage('Another application is undergoing installation');
      log.error(rStatus);
      if (res) {
        res.write(serviceHelper.ensureString(rStatus));
        res.end();
      }
      return;
    }
    globalState.installationInProgress = true;
    const appSpecifications = appSpecs;
    const appComponent = componentSpecs;
    const appName = appSpecifications.name;
    let isComponent = !!appComponent;
    const precheckForInstallation = {
      status: 'Running initial checks for Flux App...',
    };
    log.info(precheckForInstallation);
    if (res) {
      res.write(serviceHelper.ensureString(precheckForInstallation));
      if (res.flush) res.flush();
    }
    // connect to mongodb
    const dbOpenTest = {
      status: 'Connecting to database...',
    };
    log.info(dbOpenTest);
    if (res) {
      res.write(serviceHelper.ensureString(dbOpenTest));
      if (res.flush) res.flush();
    }
    const dbopen = dbHelper.databaseConnection();

    const appsDatabase = dbopen.db(config.database.appslocal.database);
    const appsQuery = { name: appName };
    const appsProjection = {
      projection: {
        _id: 0,
        name: 1,
      },
    };

    // check if app is already installed
    const checkDb = {
      status: 'Checking database...',
    };
    log.info(checkDb);
    if (res) {
      res.write(serviceHelper.ensureString(checkDb));
      if (res.flush) res.flush();
    }
    const appResult = await appsRepository.getInstalledAppRaw(appName, { name: 1 });
    if (appResult && !isComponent) {
      globalState.installationInProgress = false;
      const rStatus = messageHelper.createErrorMessage(`Flux App ${appName} already installed`);
      log.error(rStatus);
      if (res) {
        res.write(serviceHelper.ensureString(rStatus));
        res.end();
      }
      return;
    }

    if (!isComponent) {
      let dockerNetworkAddrValue = Math.floor(Math.random() * 256);
      if (appsThatMightBeUsingOldGatewayIpAssignment.includes(appName)) {
        dockerNetworkAddrValue = appName.charCodeAt(appName.length - 1);
      }
      const fluxNetworkStatus = {
        status: `Checking Flux App network of ${appName}...`,
      };
      log.info(fluxNetworkStatus);
      if (res) {
        res.write(serviceHelper.ensureString(fluxNetworkStatus));
        if (res.flush) res.flush();
      }
      let fluxNet = null;
      for (let i = 0; i <= 20; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        fluxNet = await dockerService.createFluxAppDockerNetwork(appName, dockerNetworkAddrValue).catch((error) => log.error(error));
        if (fluxNet || appsThatMightBeUsingOldGatewayIpAssignment.includes(appName)) {
          break;
        }
        dockerNetworkAddrValue = Math.floor(Math.random() * 256);
      }
      if (!fluxNet) {
        throw new Error(`Flux App network of ${appName} failed to initiate. Not possible to create docker application network.`);
      }
      log.info(serviceHelper.ensureString(fluxNet));
      const fluxNetworkInterfaces = await dockerService.getFluxDockerNetworkPhysicalInterfaceNames();
      const accessRemoved = await fluxNetworkHelper.removeDockerContainerAccessToNonRoutable(fluxNetworkInterfaces);
      const accessRemovedRes = {
        status: accessRemoved ? `Private network access removed for ${appName}` : `Error removing private network access for ${appName}`,
      };
      if (res) {
        res.write(serviceHelper.ensureString(accessRemovedRes));
        if (res.flush) res.flush();
      }
      const fluxNetResponse = {
        status: `Docker network of ${appName} initiated.`,
      };
      if (res) {
        res.write(serviceHelper.ensureString(fluxNetResponse));
        if (res.flush) res.flush();
      }
    }

    const appInstallation = {
      status: isComponent ? `Initiating Flux App component ${appComponent.name} installation...` : `Initiating Flux App ${appName} installation...`,
    };
    log.info(appInstallation);
    if (res) {
      res.write(serviceHelper.ensureString(appInstallation));
      if (res.flush) res.flush();
    }
    if (!isComponent) {
      // register the app

      const isEnterprise = Boolean(
        appSpecifications.version >= 8 && appSpecifications.enterprise,
      );

      const dbSpecs = JSON.parse(JSON.stringify(appSpecifications));

      if (isEnterprise) {
        dbSpecs.compose = [];
        dbSpecs.contacts = [];
      }

      const insertResult = await dbHelper.insertOneToDatabase(appsDatabase, localAppsInformation, dbSpecs);
      if (!insertResult) {
        throw new Error(`CRITICAL: Failed to create database entry for ${appSpecifications.name} in soft registration. Database insert returned undefined - likely duplicate key error or database failure. Aborting soft registration to prevent orphaned Docker containers.`);
      }
      log.info(`Database entry created for ${appSpecifications.name} BEFORE Docker container creation (soft registration)`);
    }


    const deployment = await deploymentProvider.getInstalledDeployment(appName);
    if (!deployment) throw new Error(`Failed to build deployment for ${appName}`);

    const owner = appSpecifications.owner || null;
    const cpuBurstHelper = require('../utils/cpuBurstHelper');
    const burstEligible = owner
      && cpuBurstHelper.isEnterpriseOwner(owner)
      && await cpuBurstHelper.isCpuBurstSupported();
    const onStatus = res ? (msg) => {
      const payload = typeof msg === 'string' ? { status: msg } : msg;
      res.write(serviceHelper.ensureString(payload));
      if (res.flush) res.flush();
    } : null;
    const syslogCollector = deployment.componentEntries()
      .find(([, c]) => c.toDockerEnv().some((e) => e.startsWith('LOG=COLLECT')));
    const syslogTarget = syslogCollector ? syslogCollector[0] : null;

    // eslint-disable-next-line no-restricted-syntax
    for (const [, component] of deployment.componentEntries()) {
      // eslint-disable-next-line no-await-in-loop
      await appInstaller.installComponent(component, {
        onStatus,
        createVolumes: false,
        burstEligible,
        specVersion: appSpecifications.version || null,
        syslogTarget,
      });

      if (component.hasSyncthing()) {
        const appId = dockerService.getAppIdentifier(component.identifier);
        globalState.receiveOnlySyncthingAppsCache.set(appId, {
          restarted: true,
          numberOfExecutionsRequired: 4,
          numberOfExecutions: 10,
        });
        log.info(`Restored syncthing cache for ${appId} during soft redeploy`);
      }
    }
    // all done message
    const successStatus = messageHelper.createSuccessMessage(`Flux App ${appName} successfully installed and launched`);
    log.info(successStatus);
    if (res) {
      res.write(serviceHelper.ensureString(successStatus));
      res.end();
    }
    globalState.installationInProgress = false;
  } catch (error) {
    globalState.installationInProgress = false;
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    log.error(errorResponse);
    if (res) {
      res.write(serviceHelper.ensureString(errorResponse));
      if (res.flush) res.flush();
    }
    const removeStatus = messageHelper.createErrorMessage(`Error occured. Initiating Flux App ${appSpecs.name} removal`);
    log.info(removeStatus);
    log.warn(`REMOVAL REASON: Soft registration failure - ${appSpecs.name} failed during soft registration: ${error.message} (softRegisterAppLocally)`);
    if (res) {
      res.write(serviceHelper.ensureString(removeStatus));
      if (res.flush) res.flush();
    }
    // eslint-disable-next-line global-require

    appUninstaller.removeAppLocally(appSpecs.name, res, true);
  }
}

/**
 * Clean up database after app removal
 * @param {object} appsDatabase - Database connection
 * @param {string} appName - Application name
 * @param {object} res - Response object for streaming
 * @returns {Promise<void>}
 */
async function cleanupAppDatabase(appsDatabase, appName, res) {
  const databaseStatus = {
    status: 'Cleaning up database...',
  };
  log.info(databaseStatus);
  if (res) {
    res.write(serviceHelper.ensureString(databaseStatus));
    if (res.flush) res.flush();
  }

  const appsQuery = { name: appName };
  const appsProjection = {};
  await dbHelper.findOneAndDeleteInDatabase(appsDatabase, localAppsInformation, appsQuery, appsProjection);

  const databaseStatus2 = {
    status: 'Database cleaned',
  };
  log.info(databaseStatus2);
  if (res) {
    res.write(serviceHelper.ensureString(databaseStatus2));
    if (res.flush) res.flush();
  }

  const appRemovalResponseDone = messageHelper.createSuccessMessage(`Removal step done. Result: Flux App ${appName} was partially removed`);
  log.info(appRemovalResponseDone);
  if (res) {
    res.write(serviceHelper.ensureString(appRemovalResponseDone));
    if (res.flush) res.flush();
  }
}

/**
 * To remove an app locally (including any components) without storage and cache deletion (keeps mounted volumes and cron job). First finds app specifications in database and then deletes the app from database. For app reload. Only for internal usage. We are throwing in functions using this.
 * @param {string} app App name.
 * @param {object} res Response.
 */
async function softRemoveAppLocally(app, res) {
  // Validate state
  if (globalState.removalInProgress) {
    throw new Error('Another application is undergoing removal');
  }
  if (globalState.installationInProgress) {
    throw new Error('Another application is undergoing installation');
  }
  if (!app) {
    throw new Error('No Flux App specified');
  }

  globalState.removalInProgress = true;

  try {
    const isComponent = app.includes('_');
    const appName = isComponent ? app.split('_')[1] : app;
    const targetComponent = isComponent ? app.split('_')[0] : null;

    const deployment = await deploymentProvider.getInstalledDeployment(appName);
    if (!deployment) {
      throw new Error('Flux App not found');
    }

    // eslint-disable-next-line global-require


    const entries = isComponent
      ? deployment.componentEntries().filter(([name]) => name === targetComponent)
      : deployment.componentEntries({ reverse: true });

    // eslint-disable-next-line no-restricted-syntax
    for (const [, deployComp] of entries) {
      const appId = dockerService.getAppIdentifier(deployComp.identifier);
      // eslint-disable-next-line no-await-in-loop
      await appUninstaller.softUninstallComponent(appName, appId, deployComp, res, stopAppMonitoring);
    }

    if (!isComponent) {
      await cleanupAppDatabase(appsDatabase, appName, res);
    }
  } finally {
    globalState.removalInProgress = false;
  }
}

/**
 * Soft redeploy - removes and reinstalls app locally (soft)
 * @param {object} appSpecs - App specifications
 * @param {object} res - Response object
 */
async function softRedeploy(appSpecs, res) {
  try {
    if (globalState.removalInProgress) {
      log.warn('Another application is undergoing removal');
      const appRedeployResponse = messageHelper.createWarningMessage('Another application is undergoing removal');
      if (res) {
        res.write(serviceHelper.ensureString(appRedeployResponse));
        if (res.flush) res.flush();
      }
      return;
    }
    if (globalState.installationInProgress) {
      log.warn('Another application is undergoing installation');
      const appRedeployResponse = messageHelper.createWarningMessage('Another application is undergoing installation');
      if (res) {
        res.write(serviceHelper.ensureString(appRedeployResponse));
        if (res.flush) res.flush();
      }
      return;
    }
    if (globalState.softRedeployInProgress) {
      log.warn('Another application is undergoing soft redeploy');
      const appRedeployResponse = messageHelper.createWarningMessage('Another application is undergoing soft redeploy');
      if (res) {
        res.write(serviceHelper.ensureString(appRedeployResponse));
        if (res.flush) res.flush();
      }
      return;
    }
    if (globalState.hardRedeployInProgress) {
      log.warn('Another application is undergoing hard redeploy');
      const appRedeployResponse = messageHelper.createWarningMessage('Another application is undergoing hard redeploy');
      if (res) {
        res.write(serviceHelper.ensureString(appRedeployResponse));
        if (res.flush) res.flush();
      }
      return;
    }

    if (appSpecs.version >= 8) {
      const installedAppsRes = await getInstalledAppsFromDb({ decryptApps: true });
      if (installedAppsRes.status === 'success') {
        const installedApp = installedAppsRes.data.find((app) => app.name === appSpecs.name);
        if (installedApp && installedApp.version >= 8) {
          const newSpec = await deserializeSpec(appSpecs);
          const oldSpec = await deserializeSpec(installedApp);
          if (newSpec && oldSpec && !newSpec.hasSameComponents(oldSpec)) {
            const oldCount = oldSpec.componentCount;
            const newCount = newSpec.componentCount;
            log.warn(`Soft redeploy requested for ${appSpecs.name}, but component structure changed.`);
            log.warn(`Component count: ${oldCount} -> ${newCount}`);
            log.warn('Automatically escalating to hard redeploy for component structure safety.');
            const escalationMessage = messageHelper.createWarningMessage(
              `Component structure changed for v${appSpecs.version} app. Escalating to hard redeploy for safety.`,
            );
            if (res) {
              res.write(serviceHelper.ensureString(escalationMessage));
              if (res.flush) res.flush();
            }
            // eslint-disable-next-line no-use-before-define
            await hardRedeploy(appSpecs, res);
            return;
          }
        }
      }
    }

    globalState.softRedeployInProgress = true;
    log.info('Starting softRedeploy');
    try {
      await softRemoveAppLocally(appSpecs.name, res);
    } catch (error) {
      log.error(error);
      globalState.softRedeployInProgress = false;
      throw error;
    }
    const appRedeployResponse = messageHelper.createSuccessMessage('Application softly removed. Awaiting installation...');
    log.info(appRedeployResponse);
    if (res) {
      res.write(serviceHelper.ensureString(appRedeployResponse));
      if (res.flush) res.flush();
    }
    await serviceHelper.delay(config.fluxapps.redeploy.delay * 1000); // wait for delay mins
    // verify requirements

    await appInstaller.checkAppRequirements(appSpecs);
    // register
    await softRegisterAppLocally(appSpecs, undefined, res);
    log.info('Application softly redeployed');
    globalState.softRedeployInProgress = false;
  } catch (error) {
    log.info('Error on softRedeploy');
    log.error(error);
    log.warn(`REMOVAL REASON: Soft redeploy failure - ${appSpecs.name} failed during soft redeploy: ${error.message} (softRedeploy)`);
    globalState.softRedeployInProgress = false;
    // eslint-disable-next-line global-require

    await appUninstaller.removeAppLocally(appSpecs.name, res, true, true, true);
    log.info(`Cleanup completed for ${appSpecs.name} after soft redeploy failure`);
  }
}

/**
 * Hard redeploy - removes and reinstalls app locally (hard)
 * @param {object} appSpecs - App specifications
 * @param {object} res - Response object
 */
async function hardRedeploy(appSpecs, res) {

  try {
    if (globalState.removalInProgress) {
      log.warn('Another application is undergoing removal');
      const appRedeployResponse = messageHelper.createWarningMessage('Another application is undergoing removal');
      if (res) {
        res.write(serviceHelper.ensureString(appRedeployResponse));
        if (res.flush) res.flush();
      }
      return;
    }
    if (globalState.installationInProgress) {
      log.warn('Another application is undergoing installation');
      const appRedeployResponse = messageHelper.createWarningMessage('Another application is undergoing installation');
      if (res) {
        res.write(serviceHelper.ensureString(appRedeployResponse));
        if (res.flush) res.flush();
      }
      return;
    }
    if (globalState.softRedeployInProgress) {
      log.warn('Another application is undergoing soft redeploy');
      const appRedeployResponse = messageHelper.createWarningMessage('Another application is undergoing soft redeploy');
      if (res) {
        res.write(serviceHelper.ensureString(appRedeployResponse));
        if (res.flush) res.flush();
      }
      return;
    }
    if (globalState.hardRedeployInProgress) {
      log.warn('Another application is undergoing hard redeploy');
      const appRedeployResponse = messageHelper.createWarningMessage('Another application is undergoing hard redeploy');
      if (res) {
        res.write(serviceHelper.ensureString(appRedeployResponse));
        if (res.flush) res.flush();
      }
      return;
    }
    globalState.hardRedeployInProgress = true;
    log.warn(`REMOVAL REASON: Hard redeploy initiated - ${appSpecs.name} being removed as part of hard redeploy process (hardRedeploy)`);
    await appUninstaller.removeAppLocally(appSpecs.name, res, false, false);
    const appRedeployResponse = messageHelper.createSuccessMessage('Application removed. Awaiting installation...');
    log.info(appRedeployResponse);
    if (res) {
      res.write(serviceHelper.ensureString(appRedeployResponse));
      if (res.flush) res.flush();
    }
    await serviceHelper.delay(config.fluxapps.redeploy.delay * 1000); // wait for delay mins
    // verify requirements

    await appInstaller.checkAppRequirements(appSpecs);
    // register
    await appInstaller.registerAppLocally(appSpecs, undefined, res, false, true); // can throw
    log.info('Application redeployed');
    globalState.hardRedeployInProgress = false;
  } catch (error) {
    log.error(error);
    log.warn(`REMOVAL REASON: Hard redeploy failure - ${appSpecs.name} failed during hard redeploy: ${error.message} (hardRedeploy)`);
    globalState.hardRedeployInProgress = false;
    await appUninstaller.removeAppLocally(appSpecs.name, res, true, true, true);
    log.info(`Cleanup completed for ${appSpecs.name} after hard redeploy failure`);
  }
}

/**
 * Soft redeploy a single component - removes and reinstalls component locally (soft)
 * @param {string} appName - Application name
 * @param {string} componentName - Component name
 * @param {object} res - Response object
 */
async function redeployComponent(appName, componentName, options = {}) {
  const createVolumes = options.createVolumes || false;
  const res = options.res || null;

  const stateFlag = createVolumes ? 'hardRedeployInProgress' : 'softRedeployInProgress';
  const label = createVolumes ? 'rebuild' : 'redeploy';

  try {
    if (globalState.removalInProgress
      || globalState.installationInProgress
      || globalState.softRedeployInProgress
      || globalState.hardRedeployInProgress) {
      const reason = 'Another operation is in progress';
      log.warn(reason);
      if (res) {
        res.write(serviceHelper.ensureString(messageHelper.createWarningMessage(reason)));
        if (res.flush) res.flush();
      }
      return;
    }

    globalState[stateFlag] = true;
    log.info(`Starting ${label} of component ${componentName} from app ${appName}`);

    const deployment = await deploymentProvider.getInstalledDeployment(appName);
    if (!deployment) {
      throw new Error(`Application ${appName} not found`);
    }

    const deployComp = deployment.getComponent(componentName);
    if (!deployComp) {
      throw new Error(`Component ${componentName} not found in application ${appName}`);
    }

    try {
      log.warn(`Beginning ${label} of component ${deployComp.identifier}...`);
      if (createVolumes) {
        log.warn(`REMOVAL REASON: Rebuild initiated - ${deployComp.identifier} (redeployComponent)`);
        await appUninstaller.hardUninstallComponent(appName, dockerService.getAppIdentifier(deployComp.identifier), deployComp, res, stopAppMonitoring, false);
      } else {
        const appId = dockerService.getAppIdentifier(deployComp.identifier);
        await appUninstaller.softUninstallComponent(appName, appId, deployComp, res, stopAppMonitoring);
      }

      log.info(`Component ${deployComp.identifier} removed. Awaiting installation...`);
      if (res) {
        res.write(serviceHelper.ensureString(messageHelper.createSuccessMessage(`Component ${deployComp.identifier} removed. Awaiting installation...`)));
        if (res.flush) res.flush();
      }

      await serviceHelper.delay(config.fluxapps.redeploy.composedDelay * 1000);

      const rawSpec = await appsRepository.getInstalledAppRaw(appName);
      await appInstaller.checkAppRequirements(rawSpec);

      log.warn(`Continuing ${label} of component ${deployComp.identifier}...`);
      await appInstaller.installComponent(deployComp, {
        createVolumes,
        specVersion: rawSpec?.version || null,
      });

      log.info(`Component ${deployComp.identifier} ${label} complete`);
      globalState[stateFlag] = false;
    } catch (error) {
      log.error(error);
      log.warn(`REMOVAL REASON: ${label} failure - ${appName} component ${deployComp.identifier}: ${error.message} (redeployComponent)`);
      globalState[stateFlag] = false;
      await appUninstaller.removeAppLocally(appName, res, true, true, true);
      throw error;
    }
  } catch (error) {
    log.error(`Error on redeployComponent (${label})`);
    log.error(error);
    globalState[stateFlag] = false;
    throw error;
  }
}

/**
 * Redeploy component via API
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
async function redeployComponentAPI(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;
    let { component } = req.params;
    component = component || req.query.component;

    if (!appname) {
      throw new Error('No Flux App specified');
    }

    if (!component) {
      throw new Error('No component specified');
    }

    // Validate that appname does not contain underscore (it should be the app name, not component_app format)
    if (appname.includes('_')) {
      throw new Error('Invalid app name format. Please provide the app name and component name separately');
    }

    const redeploySkip = globalState.restoreInProgress.some((backupItem) => appname === backupItem);
    if (redeploySkip) {
      log.info(`Restore is running for ${appname}, component redeploy skipped...`);
      const skipResponse = messageHelper.createWarningMessage(`Restore is running for ${appname}, component redeploy skipped...`);
      res.json(skipResponse);
      return;
    }

    let { force } = req.params;
    force = force || req.query.force || false;
    force = serviceHelper.ensureBoolean(force);

    // Authorization check - must be app owner or above
    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, appname);
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
      return;
    }

    res.setHeader('Content-Type', 'application/json');

    await redeployComponent(appname, component, { createVolumes: force, res });

    const successMessage = messageHelper.createSuccessMessage(`Component ${component} of ${appname} redeployed successfully`);
    res.json(successMessage);
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
 * Redeploy app via API
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
async function redeployAPI(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;
    let { global } = req.params;
    global = global || req.query.global || false;
    global = serviceHelper.ensureBoolean(global);

    if (!appname) {
      throw new Error('No Flux App specified');
    }

    if (appname.includes('_')) {
      throw new Error('Component cannot be redeployed manually');
    }

    const redeploySkip = globalState.restoreInProgress.some((backupItem) => appname === backupItem);
    if (redeploySkip) {
      log.info(`Restore is running for ${appname}, redeploy skipped...`);
      return;
    }

    let { force } = req.params;
    force = force || req.query.force || false;
    force = serviceHelper.ensureBoolean(force);

    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, appname);
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
      return;
    }
    if (global) {
      // Dynamic require to avoid circular dependency
      // eslint-disable-next-line global-require
      const appController = require('../appManagement/appController');
      appController.executeAppGlobalCommand(appname, 'redeploy', req.headers.zelidauth, force); // do not wait
      const hardOrSoft = force ? 'hard' : 'soft';
      const appResponse = messageHelper.createSuccessMessage(`${appname} queried for global ${hardOrSoft} redeploy`);
      res.json(appResponse);
      return;
    }

    // Dynamic require to avoid circular dependency
    // eslint-disable-next-line global-require
    const registryManager = require('../appDatabase/registryManager');
    const specifications = await registryManager.getApplicationSpecifications(appname);
    if (!specifications) {
      throw new Error('Application not found');
    }

    res.setHeader('Content-Type', 'application/json');

    if (force) {
      await hardRedeploy(specifications, res);
    } else {
      await softRedeploy(specifications, res);
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
 * Helper function to send chunk of data to response stream with delay
 * @param {object} res - Response object
 * @param {string} chunk - Data chunk to send
 * @returns {Promise<void>}
 */
async function sendChunk(res, chunk) {
  return new Promise((resolve) => {
    setTimeout(() => {
      res.write(`${chunk}\n`);
      if (res.flush) res.flush();
      resolve();
    }, 3000); // Adjust the delay as needed
  });
}

/**
 * Helper function to change syncthing folder type
 * @param {string} folderId - Syncthing folder ID (e.g., appId)
 * @param {string} folderType - 'receiveonly' or 'sendreceive'
 * @returns {Promise<boolean>} - true if successful, false otherwise
 */
async function changeSyncthingFolderType(folderId, folderType) {
  try {
    // eslint-disable-next-line global-require
    const syncthingService = require('../syncthingService');

    log.info(`Changing syncthing folder ${folderId} to ${folderType} mode`);

    // Get current folder configuration
    const foldersResponse = await syncthingService.getConfigFolders();
    if (foldersResponse.status !== 'success') {
      log.error(`Failed to get syncthing folders: ${JSON.stringify(foldersResponse)}`);
      return false;
    }

    // Find the folder by path
    // Syncthing syncs the entire appId folder (includes all subdirectories)
    const folderPath = `${appsFolder}${folderId}`;
    const folder = foldersResponse.data.find((f) => f.path === folderPath);

    if (!folder) {
      log.error(`Syncthing folder not found for path: ${folderPath}`);
      return false;
    }

    // Check if already in desired mode
    if (folder.type === folderType) {
      log.info(`Syncthing folder ${folderId} is already in ${folderType} mode`);
      return true;
    }

    // Update folder type using PATCH
    const patchData = { type: folderType };
    const updateResponse = await syncthingService.adjustConfigFolders('patch', patchData, folder.id);

    if (updateResponse.status === 'success') {
      log.info(`Successfully changed syncthing folder ${folderId} to ${folderType} mode`);
      return true;
    }
    log.error(`Failed to change syncthing folder type: ${JSON.stringify(updateResponse)}`);
    return false;
  } catch (error) {
    log.error(`Error changing syncthing folder type for ${folderId}: ${error.message}`);
    return false;
  }
}

/**
 * Helper function to apply permissions fix on persistent container data
 * Fixes permissions on appdata and all additional mount points
 * @param {string} appId - Application ID
 * @returns {Promise<boolean>} - true if successful, false otherwise
 */
async function applyPermissionsFix(appId) {
  try {
    // Fix permissions on entire app directory to cover appdata and all additional mounts
    const appPath = `${appsFolder}${appId}`;

    log.info(`Applying permissions fix for app: ${appId}`);

    // Apply 777 permissions to entire app directory recursively
    // This covers both appdata (primary mount) and all additional mounts at the same level
    const execPERM = `sudo chmod -R 777 ${appPath}`;
    await cmdAsync(execPERM);

    log.info(`Successfully applied permissions fix for app: ${appId} (includes appdata and all mount points)`);
    return true;
  } catch (error) {
    log.error(`Error applying permissions fix for ${appId}: ${error.message}`);
    return false;
  }
}

/**
 * Helper function to start app docker containers
 * @param {string} appname - App name
 * @returns {Promise<void>}
 */
async function appDockerStart(appname) {
  try {
    // eslint-disable-next-line global-require
    const { startAppMonitoring } = require('../appManagement/appInspector');
    // eslint-disable-next-line global-require
    const registryManager = require('../appDatabase/registryManager');

    const mainAppName = appname.split('_')[1] || appname;
    const isComponent = appname.includes('_');
    if (isComponent) {
      await dockerService.appDockerStart(appname);
      startAppMonitoring(appname);
    } else {
      const appSpecs = await registryManager.getApplicationSpecifications(mainAppName);
      if (!appSpecs) {
        throw new Error('Application not found');
      }
      const startSpec = await deserializeSpec(appSpecs);
      if (!startSpec) throw new Error('Application not found');
      const { DeploymentSpec } = await getSpecBackend();
      const deployment = DeploymentSpec.fromSpec(startSpec, appsFolder);
      for (const [, deployComp] of deployment.componentEntries()) {
        // eslint-disable-next-line no-await-in-loop
        await dockerService.appDockerStart(deployComp.identifier);
        startAppMonitoring(deployComp.identifier);
      }
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * Helper function to stop app docker containers
 * @param {string} appname - App name
 * @returns {Promise<void>}
 */
async function appDockerStop(appname) {
  try {
    // eslint-disable-next-line global-require
    const registryManager = require('../appDatabase/registryManager');

    const mainAppName = appname.split('_')[1] || appname;
    const isComponent = appname.includes('_');
    if (isComponent) {
      await dockerService.appDockerStop(appname);
      stopAppMonitoring(appname, false);
    } else {
      const appSpecs = await registryManager.getApplicationSpecifications(mainAppName);
      if (!appSpecs) {
        throw new Error('Application not found');
      }
      const stopSpec = await deserializeSpec(appSpecs);
      if (!stopSpec) throw new Error('Application not found');
      const { DeploymentSpec } = await getSpecBackend();
      const deployment = DeploymentSpec.fromSpec(stopSpec, appsFolder);
      for (const [, deployComp] of deployment.componentEntries({ reverse: true })) {
        // eslint-disable-next-line no-await-in-loop
        await dockerService.appDockerStop(deployComp.identifier);
        stopAppMonitoring(deployComp.identifier, false);
      }
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * Helper function to restart app docker containers
 * Ensures mount paths exist before restarting (important after Syncthing cleanup)
 * @param {string} appname - App name
 * @returns {Promise<void>}
 */
async function appDockerRestart(appname) {
  // eslint-disable-next-line global-require
  try {
    // eslint-disable-next-line global-require
    const { startAppMonitoring } = require('../appManagement/appInspector');
    // eslint-disable-next-line global-require
    const registryManager = require('../appDatabase/registryManager');

    const mainAppName = appname.split('_')[1] || appname;
    const appSpecs = await registryManager.getApplicationSpecifications(mainAppName);
    if (!appSpecs) {
      throw new Error('Application not found');
    }
    const spec = await deserializeSpec(appSpecs);
    const { DeploymentSpec } = await getSpecBackend();
    const deployment = DeploymentSpec.fromSpec(spec, appsFolder);
    const isComponent = appname.includes('_');
    if (isComponent) {
      const componentName = appname.split('_')[0];
      const deployComp = deployment.getComponent(componentName);
      if (deployComp?.mounts?.length) {
        await appVolumeService.ensureMountSourcesExist(deployComp);
      }
      await dockerService.appDockerRestart(appname);
      startAppMonitoring(appname);
    } else {
      for (const [compName] of spec?.componentEntries?.() || []) {
        const deployComp = deployment.getComponent(compName);
        if (deployComp?.mounts?.length) {
          // eslint-disable-next-line no-await-in-loop
          await appVolumeService.ensureMountSourcesExist(deployComp);
        }
        // eslint-disable-next-line no-await-in-loop
        await dockerService.appDockerRestart(deployComp.identifier);
        startAppMonitoring(deployComp.identifier);
      }
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * Helper function to restart app with permissions fix workflow for new primary
 * This is specifically for g: mode apps becoming primary
 * @param {string} appname - App name
 * @param {string} appId - Application ID for syncthing folder
 * @returns {Promise<void>}
 */
async function appDockerRestartWithPermissionsFix(appname, appId) {
  try {
    log.info(`Starting app ${appname} with permissions fix workflow (new primary)`);

    // Step 1: Move syncthing folder to receiveonly
    log.info(`Step 1: Moving syncthing folder to receiveonly for ${appname}`);
    const toReceiveOnly = await changeSyncthingFolderType(appId, 'receiveonly');
    if (!toReceiveOnly) {
      log.warn(`Failed to change syncthing folder to receiveonly for ${appname}, continuing anyway...`);
    }

    // Step 2: Apply permissions fix on persistent container data
    log.info(`Step 2: Applying permissions fix for ${appname}`);
    const permissionsApplied = await applyPermissionsFix(appId);
    if (!permissionsApplied) {
      log.error(`Failed to apply permissions fix for ${appname}, aborting container start`);
      return;
    }

    // Step 3: Move syncthing folder back to sendreceive
    log.info(`Step 3: Moving syncthing folder to sendreceive for ${appname}`);
    const toSendReceive = await changeSyncthingFolderType(appId, 'sendreceive');
    if (!toSendReceive) {
      log.error(`Failed to change syncthing folder to sendreceive for ${appname}, aborting container start - cannot become primary without sendreceive mode`);
      return;
    }

    // Step 4: Start the container
    log.info(`Step 4: Starting container for ${appname}`);
    await appDockerRestart(appname);

    log.info(`Successfully completed permissions fix workflow for ${appname}`);
  } catch (error) {
    log.error(`Error in appDockerRestartWithPermissionsFix for ${appname}: ${error.message}`);
    // Do not start the app if there was an error in the workflow
  }
}

/**
 * Append backup task to queue
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
async function appendBackupTask(req, res) {
  let appname;
  let backup;
  try {
    const processedBody = serviceHelper.ensureObject(req.body);
    log.info(processedBody);
    // eslint-disable-next-line prefer-destructuring
    appname = processedBody.appname;
    // eslint-disable-next-line prefer-destructuring
    backup = processedBody.backup;
    if (!appname || !backup) {
      throw new Error('appname and backup parameters are mandatory');
    }
    const indexBackup = globalState.backupInProgress.indexOf(appname);
    if (indexBackup !== -1) {
      throw new Error('Backup in progress...');
    }
    const hasTrueBackup = backup.some((backupitem) => backupitem.backup);
    if (hasTrueBackup === false) {
      throw new Error('No backup jobs...');
    }
  } catch (error) {
    log.error(error);
    await sendChunk(res, `${error?.message}\n`);
    res.end();
    return false;
  }
  try {
    const authorized = res ? await verificationHelper.verifyPrivilege('appownerabove', req, appname) : true;
    if (authorized === true) {
      globalState.backupInProgress.push(appname);
      // Check if app using syncthing, stop syncthing for all component that using it
      // eslint-disable-next-line global-require
      const registryManager = require('../appDatabase/registryManager');
      const appDetails = await registryManager.getApplicationGlobalSpecifications(appname);
      const appSpec = await deserializeSpec(appDetails);
      const hasSyncthing = appSpec && appSpec.hasSyncthing();
      if (hasSyncthing) {
        await sendChunk(res, `Stopping syncthing for ${appname}\n`);
        await appVolumeService.removeSyncthingFolder(appname, res);
      }

      await sendChunk(res, 'Stopping application...\n');
      await appDockerStop(appname);
      await serviceHelper.delay(5 * 1000);
      // eslint-disable-next-line global-require
      const IOUtils = require('../IOUtils');
      // eslint-disable-next-line no-restricted-syntax
      for (const component of backup) {
        if (component.backup) {
          // eslint-disable-next-line no-await-in-loop
          const componentPath = await IOUtils.getVolumeInfo(appname, component.component, 'B', 0, 'mount');
          const targetPath = `${componentPath[0].mount}/appdata`;
          const tarGzPath = `${componentPath[0].mount}/backup/local/backup_${component.component.toLowerCase()}.tar.gz`;
          // eslint-disable-next-line no-await-in-loop
          const existStatus = await IOUtils.checkFileExists(`${componentPath[0].mount}/backup/local/backup_${component.component.toLowerCase()}.tar.gz`);
          if (existStatus === true) {
            // eslint-disable-next-line no-await-in-loop
            await sendChunk(res, `Removing exists backup archive for ${component.component.toLowerCase()}...\n`);
            // eslint-disable-next-line no-await-in-loop
            await IOUtils.removeFile(`${componentPath[0].mount}/backup/local/backup_${component.component.toLowerCase()}.tar.gz`);
          }
          // eslint-disable-next-line no-await-in-loop
          await sendChunk(res, `Creating backup archive for ${component.component.toLowerCase()}...\n`);
          // eslint-disable-next-line no-await-in-loop
          const tarStatus = await IOUtils.createTarGz(targetPath, tarGzPath);
          if (tarStatus.status === false) {
            // eslint-disable-next-line no-await-in-loop
            await IOUtils.removeFile(`${componentPath[0].mount}/backup/local/backup_${component.component.toLowerCase()}.tar.gz`);
            throw new Error(`Error: Failed to create backup archive for ${component.component.toLowerCase()}, ${tarStatus.error}`);
          }
        }
      }
      await serviceHelper.delay(5 * 1000);
      await sendChunk(res, 'Starting application...\n');
      if (!hasSyncthing) {
        await appDockerStart(appname);
      } else {
        for (const [compName, comp] of appSpec.componentEntries()) {
          if (comp.persistentStorage?.sync?.mode !== 'activeStandby') {
            // eslint-disable-next-line no-await-in-loop
            await appDockerStart(`${compName}_${appname}`);
          }
        }
      }
      await sendChunk(res, 'Finalizing...\n');
      await serviceHelper.delay(5 * 1000);
      const indexToRemove = globalState.backupInProgress.indexOf(appname);
      globalState.backupInProgress.splice(indexToRemove, 1);
      res.end();
      return true;
      // eslint-disable-next-line no-else-return
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      return res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const indexToRemove = globalState.backupInProgress.indexOf(appname);
    if (indexToRemove >= 0) {
      globalState.backupInProgress.splice(indexToRemove, 1);
    }
    await sendChunk(res, `${error?.message}\n`);
    res.end();
    return false;
  }
}

/**
 * Append a restore task based on the provided parameters.
 * @async
 * @param {object} req - Request object.
 * @param {object} res - Response object.
 * @returns {boolean} - True if the restore task is successfully appended, otherwise false.
 * @throws {object} - JSON error response if an error occurs.
 */
async function appendRestoreTask(req, res) {
  let appname;
  let restore;
  let type;
  try {
    const processedBody = serviceHelper.ensureObject(req.body);
    log.info(processedBody);
    // eslint-disable-next-line prefer-destructuring
    appname = processedBody.appname;
    // eslint-disable-next-line prefer-destructuring
    restore = processedBody.restore;
    // eslint-disable-next-line prefer-destructuring
    type = processedBody.type;
    if (!appname || !restore || !type) {
      throw new Error('appname, restore and type parameters are mandatory');
    }
    const indexRestore = globalState.restoreInProgress.indexOf(appname);
    if (indexRestore !== -1) {
      throw new Error(`Restore for app ${appname} is running...`);
    }
    const hasTrueRestore = restore.some((restoreitem) => restoreitem.restore);
    if (hasTrueRestore === false) {
      throw new Error('No restore jobs...');
    }
  } catch (error) {
    log.error(error);
    await sendChunk(res, `${error?.message}\n`);
    res.end();
    return false;
  }
  try {
    const authorized = res ? await verificationHelper.verifyPrivilege('appownerabove', req, appname) : true;
    if (authorized === true) {
      const componentItem = restore.map((restoreItem) => restoreItem);
      globalState.restoreInProgress.push(appname);
      // eslint-disable-next-line global-require
      const registryManager = require('../appDatabase/registryManager');
      const appDetails = await registryManager.getApplicationGlobalSpecifications(appname);
      const restoreSpec = await deserializeSpec(appDetails);
      const restoreHasSyncthing = restoreSpec && restoreSpec.hasSyncthing();
      if (restoreHasSyncthing) {
        await sendChunk(res, `Stopping syncthing for ${appname}\n`);
        await appVolumeService.removeSyncthingFolder(appname, res);
      }
      await sendChunk(res, 'Stopping application...\n');
      await appDockerStop(appname);
      await serviceHelper.delay(5 * 1000);
      // eslint-disable-next-line global-require
      const IOUtils = require('../IOUtils');
      // eslint-disable-next-line no-restricted-syntax
      for (const component of restore) {
        if (component.restore) {
          // eslint-disable-next-line no-await-in-loop
          const componentVolumeInfo = await IOUtils.getVolumeInfo(appname, component.component, 'B', 0, 'mount');
          const appDataPath = `${componentVolumeInfo[0].mount}/appdata`;
          // eslint-disable-next-line no-await-in-loop
          await sendChunk(res, `Removing ${component.component} component data...\n`);
          // eslint-disable-next-line no-await-in-loop
          await serviceHelper.delay(2 * 1000);
          // eslint-disable-next-line no-await-in-loop
          await IOUtils.removeDirectory(appDataPath, true);
        }
      }

      if (type === 'remote') {
        // eslint-disable-next-line no-restricted-syntax
        for (const restoreItem of componentItem) {
          if (restoreItem?.url !== '') {
            // eslint-disable-next-line no-await-in-loop
            const componentPath = await IOUtils.getVolumeInfo(appname, restoreItem.component, 'B', 0, 'mount');
            // eslint-disable-next-line no-await-in-loop
            await IOUtils.removeDirectory(`${componentPath[0].mount}/backup/remote`, true);
            // eslint-disable-next-line no-await-in-loop
            await sendChunk(res, `Downloading ${restoreItem.url}...\n`);
            // eslint-disable-next-line no-await-in-loop
            const downloadStatus = await IOUtils.downloadFileFromUrl(restoreItem.url, `${componentPath[0].mount}/backup/remote`, restoreItem.component, true);
            if (downloadStatus !== true) {
              throw new Error(`Error: Failed to download ${restoreItem.url}...`);
            }
          }
        }
      }

      // eslint-disable-next-line no-restricted-syntax
      for (const component of restore) {
        if (component.restore) {
          // eslint-disable-next-line no-await-in-loop
          const componentPath = await IOUtils.getVolumeInfo(appname, component.component, 'B', 0, 'mount');
          const targetPath = `${componentPath[0].mount}/appdata`;
          const tarGzPath = `${componentPath[0].mount}/backup/${type}/backup_${component.component.toLowerCase()}.tar.gz`;
          // eslint-disable-next-line no-await-in-loop
          await sendChunk(res, `Unpacking backup archive for ${component.component.toLowerCase()}...\n`);
          // eslint-disable-next-line no-await-in-loop
          const tarStatus = await IOUtils.untarFile(targetPath, tarGzPath);
          if (tarStatus.status === false) {
            throw new Error(`Error: Failed to unpack archive file for ${component.component.toLowerCase()}, ${tarStatus.error}`);
          } else {
            // eslint-disable-next-line no-await-in-loop
            await sendChunk(res, `Removing backup file for ${component.component.toLowerCase()}...\n`);
            // eslint-disable-next-line no-await-in-loop
            await IOUtils.removeFile(tarGzPath);
          }
          const restoreComp = restoreSpec?.components?.[component.component];
          const syncthingAux = restoreComp?.hasSyncthing();
          if (syncthingAux) {
            // eslint-disable-next-line global-require
            const identifier = `${component.component}_${appname}`;
            const appId = dockerService.getAppIdentifier(identifier);
            // eslint-disable-next-line global-require
            const { receiveOnlySyncthingAppsCache } = require('../utils/appCaches');
            const cache = {
              restarted: true,
              numberOfExecutionsRequired: 4,
              numberOfExecutions: 10,
            };
            receiveOnlySyncthingAppsCache.set(appId, cache);
          }
        }
      }
      await serviceHelper.delay(1 * 5 * 1000);
      await sendChunk(res, 'Starting application...\n');
      await appDockerStart(appname);
      if (syncthing) {
        await sendChunk(res, 'Redeploying other instances...\n');
        // eslint-disable-next-line global-require
        const appController = require('../appManagement/appController');
        appController.executeAppGlobalCommand(appname, 'redeploy', req.headers.zelidauth, true);
        await serviceHelper.delay(1 * 60 * 1000);
      }
      await sendChunk(res, 'Finalizing...\n');
      await serviceHelper.delay(5 * 1000);
      const indexToRemove = globalState.restoreInProgress.indexOf(appname);
      globalState.restoreInProgress.splice(indexToRemove, 1);
      res.end();
      return true;
      // eslint-disable-next-line no-else-return
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      return res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const indexToRemove = globalState.restoreInProgress.indexOf(appname);
    if (indexToRemove >= 0) {
      globalState.restoreInProgress.splice(indexToRemove, 1);
    }
    await sendChunk(res, `${error?.message}\n`);
    res.end();
    return false;
  }
}

/**
 * Remove test app mount
 * @param {string} specifiedVolume - Volume to remove
 * @returns {Promise<void>}
 */
async function removeTestAppMount(specifiedVolume) {
  try {
    const appId = 'flux_fluxTestVol';
    log.info('Mount Test: Unmounting volume');
    const execUnmount = `sudo umount ${appsFolder + appId}`;
    await cmdAsync(execUnmount).then(() => {
      log.info('Mount Test: Volume unmounted');
    }).catch((e) => {
      log.error(e);
      log.error('Mount Test: An error occured while unmounting volume. Continuing. Most likely false positive.');
    });

    log.info('Mount Test: Cleaning up data');
    const execDelete = `sudo rm -rf ${appsFolder + appId}`;
    await cmdAsync(execDelete).catch((e) => {
      log.error(e);
      log.error('Mount Test: An error occured while cleaning up data. Continuing. Most likely false positive.');
    });
    log.info('Mount Test: Data cleaned');
    log.info('Mount Test: Cleaning up data volume');
    const volumeToRemove = specifiedVolume || `${fluxDirPath}appvolumes/${appId}FLUXFSVOL`;
    const execVolumeDelete = `sudo rm -rf ${volumeToRemove}`;
    await cmdAsync(execVolumeDelete).catch((e) => {
      log.error(e);
      log.error('Mount Test: An error occured while cleaning up volume. Continuing. Most likely false positive.');
    });
    log.info('Mount Test: Volume cleaned');
  } catch (error) {
    log.error('Mount Test Removal: Error');
    log.error(error);
  }
}

/**
 * Test application mounting capability
 * @returns {Promise<void>}
 */
async function testAppMount() {
  try {
    // before running, try to remove first
    await removeTestAppMount();
    const appSize = 1;
    const overHeadRequired = 2;
    const dfAsync = util.promisify(df);
    const appId = 'flux_fluxTestVol';

    log.info('Mount Test: started');
    log.info('Mount Test: Searching available space...');

    // we want whole numbers in GB
    const options = {
      prefixMultiplier: 'GB',
      isDisplayPrefixMultiplier: false,
      precision: 0,
    };

    const dfres = await dfAsync(options);
    const okVolumes = [];
    dfres.forEach((volume) => {
      if (volume.filesystem.includes('/dev/') && !volume.filesystem.includes('loop') && !volume.mount.includes('boot')) {
        okVolumes.push(volume);
      } else if (volume.filesystem.includes('loop') && volume.mount === '/') {
        okVolumes.push(volume);
      }
    });

    // check if space is not sharded in some bad way. Always count the fluxSystemReserve
    let useThisVolume = null;
    const totalVolumes = okVolumes.length;
    for (let i = 0; i < totalVolumes; i += 1) {
      // check available volumes one by one. If a sufficient is found. Use this one.
      if (okVolumes[i].available > appSize + overHeadRequired) {
        useThisVolume = okVolumes[i];
        break;
      }
    }
    if (!useThisVolume) {
      // no useable volume has such a big space for the app
      log.warn('Mount Test: Insufficient space on Flux Node. No useable volume found.');
      // node marked OK
      dosMountMessage = ''; // No Space Found actually
      return;
    }

    // now we know there is a space and we have a volume we can operate with. Let's do volume magic
    log.info('Mount Test: Space found');
    log.info('Mount Test: Allocating space...');

    let volumePath = `${useThisVolume.mount}/${appId}FLUXFSVOL`; // eg /mnt/sthMounted/
    if (useThisVolume.mount === '/') {
      const execMkdir = `sudo mkdir -p ${fluxDirPath}appvolumes`;
      await cmdAsync(execMkdir);
      volumePath = `${fluxDirPath}appvolumes/${appId}FLUXFSVOL`;// if root mount then temp file is in flux folder/appvolumes
    }

    const execDD = `sudo fallocate -l ${appSize}G ${volumePath}`;

    await cmdAsync(execDD);

    log.info('Mount Test: Space allocated');
    log.info('Mount Test: Creating filesystem...');

    const execFS = `sudo mke2fs -t ext4 ${volumePath}`;
    await cmdAsync(execFS);
    log.info('Mount Test: Filesystem created');
    log.info('Mount Test: Making directory...');

    const execDIR = `sudo mkdir -p ${appsFolder + appId}`;
    await cmdAsync(execDIR);
    log.info('Mount Test: Directory made');
    log.info('Mount Test: Mounting volume...');

    const execMount = `sudo mount -o loop ${volumePath} ${appsFolder + appId}`;
    await cmdAsync(execMount);
    log.info('Mount Test: Volume mounted. Test completed.');
    dosMountMessage = '';
    // run removal
    removeTestAppMount(volumePath);
  } catch (error) {
    log.error('Mount Test: Error...');
    log.error(error);
    // node marked OK
    dosMountMessage = 'Unavailability to mount applications volumes. Impossible to run applications.';
    // run removal
    removeTestAppMount();
  }
}

/**
 * Validates that an application update is compatible with the previous version.
 * Enforces structural consistency rules based on app specification version:
 * - v1-3: Repository tags (repotag) cannot be changed
 * - v4+: Component names and count must remain constant (repotag changes allowed)
 * - Version downgrades from v4+ to v1-3 are forbidden
 * Note: Version upgrade policy (e.g. "must upgrade to v8") is enforced in
 * storeAppTemporaryMessage, not here. This function only validates structural
 * compatibility so it can be safely used during hash sync replay of historical messages.
 *
 * @param {object} specifications - The new/updated application specifications to validate
 * @param {string} specifications.name - Application name
 * @param {number} specifications.version - Specification version (1-4+)
 * @param {string} [specifications.repotag] - Docker image repository:tag (v1-3)
 * @param {Array} [specifications.compose] - Component definitions (v4+)
 * @param {object} previousAppSpecs - Previous app specifications (from getPreviousAppSpecifications)
 * @returns {Promise<boolean>} Returns true if update is compatible
 * @throws {Error} When update violates version-specific compatibility rules:
 *   - Component count mismatch (v4+)
 *   - Component name changes (v4+)
 *   - Repository tag changes (v1-3)
 *   - Version downgrade from v4+ to v1-3
 */

/**
 * Set installation progress state
 * @param {boolean} state - Installation progress state
 */
function setInstallationInProgress(state) {
  globalState.installationInProgress = state;
}

/**
 * Set removal progress state
 * @param {boolean} state - Removal progress state
 */
function setRemovalInProgress(state) {
  globalState.removalInProgress = state;
}

/**
 * Get installation progress state
 * @returns {boolean} Current installation state
 */
function getInstallationInProgress() {
  return globalState.installationInProgress;
}

/**
 * Get removal progress state
 * @returns {boolean} Current removal state
 */
function getRemovalInProgress() {
  return globalState.removalInProgress;
}

/**
 * Add app to restore progress
 * @param {string} appname - App name
 */
function addToRestoreProgress(appname) {
  if (!globalState.restoreInProgress.includes(appname)) {
    globalState.restoreInProgress.push(appname);
  }
}

/**
 * Remove app from restore progress
 * @param {string} appname - App name
 */
function removeFromRestoreProgress(appname) {
  const index = globalState.restoreInProgress.indexOf(appname);
  if (index > -1) {
    globalState.restoreInProgress.splice(index, 1);
  }
}

/**
 * Reset removal progress state
 */
function removalInProgressReset() {
  globalState.removalInProgress = false;
}

/**
 * Set removal in progress to true
 */
function setRemovalInProgressToTrue() {
  globalState.removalInProgress = true;
}

/**
 * Reset installation progress state
 */
function installationInProgressReset() {
  globalState.installationInProgress = false;
}

/**
 * Set installation in progress to true
 */
function setInstallationInProgressTrue() {
  globalState.installationInProgress = true;
}

/**
 * Validate and broadcast an app update to the network.
 * Business logic only — no HTTP concerns.
 * @param {object} params - Update parameters
 * @param {object} params.appSpecification - The app specification
 * @param {number} params.timestamp - Message timestamp
 * @param {string} params.signature - Message signature
 * @param {string} params.type - Message type (fluxappupdate/zelappupdate)
 * @param {number} params.version - Message version
 * @returns {Promise<string>} The message hash
 */
async function updateAppGlobaly(params) {
  const {
    appSpecification, timestamp, signature, type: messageType, version: typeVersion,
  } = params;

  if (!appSpecification || !timestamp || !signature || !messageType || !typeVersion) {
    throw new Error('Incomplete message received. Check if appSpecification, timestamp, type, version and signature are provided.');
  }
  if (messageType !== 'zelappupdate' && messageType !== 'fluxappupdate') {
    throw new Error('Invalid type of message');
  }
  if (typeVersion !== 1) {
    throw new Error('Invalid version of message');
  }

  const cleanTimestamp = serviceHelper.ensureNumber(timestamp);
  const cleanSignature = serviceHelper.ensureString(signature);
  const cleanMessageType = serviceHelper.ensureString(messageType);
  const cleanTypeVersion = serviceHelper.ensureNumber(typeVersion);

  const timestampNow = Date.now();
  if (cleanTimestamp < timestampNow - 1000 * 3600) {
    throw new Error('Message timestamp is over 1 hour old, not valid. Check if your computer clock is synced and restart the registration process.');
  } else if (cleanTimestamp > timestampNow + 1000 * 60 * 5) {
    throw new Error('Message timestamp from future, not valid. Check if your computer clock is synced and restart the registration process.');
  }

  const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
  if (!syncStatus.data.synced) {
    throw new Error('Daemon not yet synced.');
  }
  const daemonHeight = syncStatus.data.height;

  const appSpecObj = serviceHelper.ensureObject(appSpecification);
  const wireSpec = await deserializeSpec(appSpecObj);
  if (!wireSpec) throw new Error('Could not deserialize app specifications');

  let spec = wireSpec;
  if (wireSpec.isEncrypted) {
    const provider = await legacyCryptoProvider.create(wireSpec.name, wireSpec.owner);
    const decrypted = await wireSpec.decrypt(provider);
    spec = decrypted;
  }

  // eslint-disable-next-line global-require
  const { validateSubmissionSpec } = require('../utils/specLibs');
  // eslint-disable-next-line global-require
  const { verifyImageRegistryAndArchitectures } = require('../appSecurity/imageArchitectureValidator');
  await validateSubmissionSpec(appSpecObj, { height: daemonHeight });
  await verifyImageRegistryAndArchitectures(appSpecObj);

  if (spec.version === 7 && spec.components) {
    // eslint-disable-next-line global-require
    const appSecurity = require('../appSecurity/imageManager');
    for (const [, comp] of spec.componentEntries()) {
      if (comp.secrets) {
        // eslint-disable-next-line no-await-in-loop
        await appSecurity.checkAppSecrets(spec.name, comp, spec.owner, false);
      }
    }
  }

  const appInfo = await appsRepository.getGlobalAppInfoRaw(spec.name);
  if (!appInfo) {
    throw new Error('Flux App update received but application to update does not exist!');
  }
  const appOwner = appInfo.owner;

  const wireForm = await toCanonicalSpec(appSpecObj);

  // eslint-disable-next-line global-require
  const appMessaging = require('../appMessaging/messageVerifier');
  await appMessaging.verifyAppMessageUpdateSignature(cleanMessageType, cleanTypeVersion, wireForm, cleanTimestamp, cleanSignature, appOwner, daemonHeight, appInfo);

  const { latestSupportedSpecVersion } = config.fluxapps;
  if (appInfo.version !== spec.version && spec.version !== latestSupportedSpecVersion) {
    throw new Error(
      `Application update rejected: Version changes are only allowed when updating to version ${latestSupportedSpecVersion} (current latest supported version). `
      + `Current version: ${appInfo.version}, Attempted version: ${spec.version}. `
      + `To update this application, please use version ${latestSupportedSpecVersion} specifications.`,
    );
  }

  const { UpdatePolicy } = await getSpec();
  const oldSpec = await deserializeSpec(appInfo);
  if (oldSpec) UpdatePolicy.assertCompatible(oldSpec, spec);

  const message = cleanMessageType + cleanTypeVersion + JSON.stringify(wireForm) + cleanTimestamp + cleanSignature;
  const messageHASH = await generalService.messageHash(message);

  const temporaryAppMessage = {
    type: cleanMessageType,
    version: cleanTypeVersion,
    appSpecifications: wireForm,
    hash: messageHASH,
    timestamp: cleanTimestamp,
    signature: cleanSignature,
    arcaneSender: isArcane,
  };

  // eslint-disable-next-line global-require
  const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
  await fluxCommunicationMessagesSender.broadcastTemporaryAppMessage(temporaryAppMessage);
  await serviceHelper.delay(1200);
  await appMessaging.requestAppMessage(messageHASH);
  await serviceHelper.delay(1200);

  let tempMessage = await appMessaging.checkAppTemporaryMessageExistence(messageHASH);
  for (let i = 0; i < 20; i += 1) {
    if (!tempMessage) {
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(500);
      // eslint-disable-next-line no-await-in-loop
      tempMessage = await appMessaging.checkAppTemporaryMessageExistence(messageHASH);
    }
  }
  if (tempMessage && typeof tempMessage === 'object' && !Array.isArray(tempMessage)) {
    return tempMessage.hash;
  }
  throw new Error('Unable to update application on the network. Try again later.');
}

/**
 * API endpoint to update application globally
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @returns {Promise<void>} Update result
 */
async function updateAppGlobalyApi(req, res) {
  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', async () => {
    try {
      const authorized = await verificationHelper.verifyPrivilege('user', req);
      if (!authorized) {
        const errMessage = messageHelper.errUnauthorizedMessage();
        res.json(errMessage);
        return;
      }
      // eslint-disable-next-line global-require
      const { peerManager } = require('../utils/peerState');
      if (peerManager.outboundCount < config.fluxapps.minOutgoing) {
        throw new Error('Sorry, This Flux does not have enough outgoing peers for safe application update');
      }
      if (peerManager.inboundCount < config.fluxapps.minIncoming) {
        throw new Error('Sorry, This Flux does not have enough incoming peers for safe application update');
      }

      const processedBody = serviceHelper.ensureObject(body);
      const hash = await updateAppGlobaly({
        appSpecification: processedBody.appSpecification,
        timestamp: processedBody.timestamp,
        signature: processedBody.signature,
        type: processedBody.type,
        version: processedBody.version,
      });

      const responseHash = messageHelper.createDataMessage(hash);
      res.json(responseHash);
    } catch (error) {
      log.warn(error);
      const errorResponse = messageHelper.createErrorMessage(
        error.message || error,
        error.name,
        error.code,
      );
      res.json(errorResponse);
    }
  });
}

/**
 * To find and remove apps that are spawned more than maximum number of instances allowed locally.
 * @returns {void} Return statement is only used here to interrupt the function and nothing is returned.
 */
async function checkAndRemoveApplicationInstance() {
  // To check if more than allowed instances of application are running
  // check if synced
  try {
    const synced = await generalService.checkSynced();
    if (synced !== true) {
      log.info('Application duplication removal paused. Not yet synced');
      return;
    }

    // get list of locally installed apps.
    const installedAppsRes = await getInstalledAppsFromDb();
    if (installedAppsRes.status !== 'success') {
      throw new Error('Failed to get installed Apps');
    }
    const appsInstalled = installedAppsRes.data;
    // lazy load to avoid circular dependency
    // eslint-disable-next-line global-require

    // eslint-disable-next-line global-require
    const registryManager = require('../appDatabase/registryManager');
    // eslint-disable-next-line no-restricted-syntax
    for (const installedApp of appsInstalled) {
      // eslint-disable-next-line no-await-in-loop
      const runningAppList = await registryManager.appLocation(installedApp.name);
      const minInstances = installedApp.instances || config.fluxapps.minimumInstances; // introduced in v3 of apps specs
      if (runningAppList.length > minInstances) {
        // eslint-disable-next-line no-await-in-loop
        const appDetails = await registryManager.getApplicationGlobalSpecifications(installedApp.name);
        if (appDetails) {
          log.info(`Application ${installedApp.name} is already spawned on ${runningAppList.length} instances. Checking if should be unninstalled from the FluxNode..`);
          runningAppList.sort((a, b) => {
            if (!a.runningSince && b.runningSince) {
              return 1;
            }
            if (a.runningSince && !b.runningSince) {
              return -1;
            }
            if (a.runningSince < b.runningSince) {
              return 1;
            }
            if (a.runningSince > b.runningSince) {
              return -1;
            }
            if (a.ip < b.ip) {
              return 1;
            }
            if (a.ip > b.ip) {
              return -1;
            }
            return 0;
          });
          // eslint-disable-next-line no-await-in-loop
          const myIP = await fluxNetworkHelper.getMyFluxIPandPort();
          if (myIP) {
            const index = runningAppList.findIndex((x) => x.ip === myIP);
            if (index === 0) {
              log.info(`Application ${installedApp.name} going to be removed from node as it was the latest one running it to install it..`);
              log.warn(`REMOVAL REASON: Too many instances - ${installedApp.name} running on ${runningAppList.length} instances (max: ${minInstances}) - This node is the newest instance`);
              log.warn(`Removing application ${installedApp.name} locally`);
              // eslint-disable-next-line no-await-in-loop
              await appUninstaller.removeAppLocally(installedApp.name, null, false, true, true);
              log.warn(`Application ${installedApp.name} locally removed`);
              // eslint-disable-next-line no-await-in-loop
              await serviceHelper.delay(config.fluxapps.removal.delay * 1000); // wait for 6 mins so we don't have more removals at the same time
            }
          }
        }
      }
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * Check for outdated app versions and reinstall them with newer specifications
 * @returns {Promise<void>} Completion status
 */
async function reinstallOldApplications() {
  try {
    const synced = await generalService.checkSynced();
    if (synced !== true) {
      log.info('Checking application status paused. Not yet synced');
      return;
    }
    // first get installed apps
    const installedAppsRes = await getInstalledAppsFromDb({ decryptApps: true });
    if (installedAppsRes.status !== 'success') {
      throw new Error('Failed to get installed Apps');
    }
    const appsInstalled = installedAppsRes.data;
    // eslint-disable-next-line no-restricted-syntax
    for (const installedApp of appsInstalled) {
      // get current app specifications for the app name
      // if match found. Check if hash found.
      // if same, do nothing. if different remove and install.

      // eslint-disable-next-line no-await-in-loop
      const instantiated = await getStrictApplicationSpecifications(installedApp.name);

      let appSpecifications;
      if (instantiated) {
        let spec;
        if (isArcane && instantiated.isEncrypted()) {
          // eslint-disable-next-line no-await-in-loop
          spec = await decryptToCleartextClass(instantiated.serialize());
        } else {
          spec = instantiated.spec;
        }
        if (spec) appSpecifications = spec.serialize();
      }

      const randomNumber = Math.floor((Math.random() * config.fluxapps.redeploy.probability)); // 50%
      if (instantiated && instantiated.hash !== installedApp.hash) {
        // eslint-disable-next-line no-await-in-loop
        log.warn(`Application ${installedApp.name} version is obsolete.`);
        if (randomNumber === 0) {
          globalState.reinstallationOfOldAppsInProgress = true;

          // Check if this is an enterprise app on non-arcane node FIRST
          // CRITICAL: Must check BEFORE updating local database or attempting redeployment
          // If we update the local DB with enterprise specs, we lose the container/port info needed for cleanup
          if (instantiated.version >= 8
              && instantiated.isEncrypted()
              && !isArcane) {
            log.warn(`Application ${instantiated.name} is enterprise version >= 8 but system is not running arcaneOS.`);
            log.warn(`REMOVAL REASON: Enterprise app v${instantiated.version} requires arcaneOS - ${instantiated.name}`);

            // Find and restore non-enterprise specs if needed for proper cleanup
            // eslint-disable-next-line no-await-in-loop
            const specsForRemoval = await findAndRestoreNonEnterpriseSpecs(installedApp);

            if (!specsForRemoval) {
              // eslint-disable-next-line no-continue
              continue;
            }

            // Remove the entire app with force and BROADCAST to peers
            // This is a permanent removal (not a redeploy), so we need to broadcast
            // eslint-disable-next-line global-require
        
            // eslint-disable-next-line no-await-in-loop
            await appUninstaller.removeAppLocally(installedApp.name, null, true, true, true);
            log.info(`Successfully removed enterprise app ${installedApp.name} and notified peers`);

            // Skip to next app
            // eslint-disable-next-line no-continue
            continue;
          }

          // check if the app spec was changed
          const auxAppSpecifications = JSON.parse(JSON.stringify(appSpecifications));
          const auxInstalledApp = JSON.parse(JSON.stringify(installedApp));
          delete auxAppSpecifications.description;
          delete auxAppSpecifications.expire;
          delete auxAppSpecifications.hash;
          delete auxAppSpecifications.height;
          delete auxAppSpecifications.instances;
          delete auxAppSpecifications.owner;

          delete auxInstalledApp.description;
          delete auxInstalledApp.expire;
          delete auxInstalledApp.hash;
          delete auxInstalledApp.height;
          delete auxInstalledApp.instances;
          delete auxInstalledApp.owner;

          if (JSON.stringify(auxAppSpecifications) === JSON.stringify(auxInstalledApp)) {
            log.info(`Application ${installedApp.name} was updated without any change on the specifications, updating localAppsInformation db information.`);
            // connect to mongodb
            const dbopen = dbHelper.databaseConnection();
            const appsDatabase = dbopen.db(config.database.appslocal.database);
            const appsQuery = { name: appSpecifications.name };
            const options = {
              upsert: true,
            };
            // eslint-disable-next-line no-await-in-loop
            await dbHelper.updateOneInDatabase(appsDatabase, localAppsInformation, appsQuery, { $set: appSpecifications }, options);
            log.info(`Application ${installedApp.name} Database updated`);
            // eslint-disable-next-line no-continue
            continue;
          }
          // Specs differ - log for debugging purposes
          log.info(`Application ${installedApp.name} has actual specification changes, proceeding with redeployment.`);


          // check if node is capable to run it according to specifications
          if (appSpecifications.version >= 4 && installedApp.version <= 3) {
            if (globalState.removalInProgress) {
              log.warn(`Another application is undergoing removal. Skipping ${installedApp.name} for this cycle.`);
              // eslint-disable-next-line no-continue
              continue;
            }
            if (globalState.installationInProgress) {
              log.warn(`Another application is undergoing installation. Skipping ${installedApp.name} for this cycle.`);
              // eslint-disable-next-line no-continue
              continue;
            }
            if (globalState.softRedeployInProgress) {
              log.warn(`Another application is undergoing soft redeploy. Skipping ${installedApp.name} for this cycle.`);
              // eslint-disable-next-line no-continue
              continue;
            }
            if (globalState.hardRedeployInProgress) {
              log.warn(`Another application is undergoing hard redeploy. Skipping ${installedApp.name} for this cycle.`);
              // eslint-disable-next-line no-continue
              continue;
            }
            log.warn('Updating from old application version, doing hard redeploy...');
            log.warn(`REMOVAL REASON: App version upgrade - ${appSpecifications.name} upgrading from v${installedApp.version} to v${appSpecifications.version}`);
            // eslint-disable-next-line global-require
        

            // eslint-disable-next-line no-await-in-loop
            await appUninstaller.removeAppLocally(appSpecifications.name, null, true, false);
            // connect to mongodb
            const dbopen = dbHelper.databaseConnection();
            const appsDatabase = dbopen.db(config.database.appslocal.database);
            const appsQuery = { name: appSpecifications.name };
            const appsProjection = {};
            log.warn('Cleaning up database...');
            // eslint-disable-next-line no-await-in-loop
            await dbHelper.findOneAndDeleteInDatabase(appsDatabase, localAppsInformation, appsQuery, appsProjection);
            const databaseStatus2 = {
              status: 'Database cleaned',
            };
            log.warn('Database cleaned');
            log.warn(databaseStatus2);
            log.warn(`Compositions of application ${appSpecifications.name} uninstalled. Continuing with installation...`);
            // composition removal done. Remove from installed apps and being installation
            // eslint-disable-next-line no-await-in-loop
            await appInstaller.checkAppRequirements(appSpecifications); // entire app

            // Register the app in database BEFORE creating Docker containers to prevent race condition
            const isEnterprise = instantiated.version >= 8 && instantiated.isEncrypted();

            const dbSpecs = JSON.parse(JSON.stringify(appSpecifications));

            if (isEnterprise) {
              dbSpecs.compose = [];
              dbSpecs.contacts = [];
            }

            // eslint-disable-next-line no-await-in-loop
            const insertResult = await dbHelper.insertOneToDatabase(appsDatabase, localAppsInformation, dbSpecs);
            if (!insertResult) {
              throw new Error(`CRITICAL: Failed to create database entry for ${instantiated.name} during version upgrade reinstallation. Database insert returned undefined - likely duplicate key error or database failure. Aborting reinstallation to prevent orphaned Docker containers.`);
            }
            log.info(`Database entry created for ${instantiated.name} BEFORE component Docker container creation (version upgrade path)`);

            const upgradeSpec = !instantiated.isEncrypted() ? instantiated.spec : await deserializeSpec(appSpecifications);
            // eslint-disable-next-line no-restricted-syntax
            for (const [, comp] of upgradeSpec?.componentEntries?.() || []) {
              const compCanonical = comp.toCanonical();
              log.warn(`Continuing Hard Redeployment of component ${compCanonical.name}_${instantiated.name}...`);
              // eslint-disable-next-line no-await-in-loop
              await serviceHelper.delay(config.fluxapps.redeploy.composedDelay * 1000);
              // eslint-disable-next-line no-await-in-loop
              await appInstaller.registerAppLocally(appSpecifications, compCanonical);
            }
            log.warn(`Composed application ${instantiated.name} updated.`);
            log.warn(`Restarting application ${instantiated.name}`);
            // eslint-disable-next-line no-await-in-loop, no-use-before-define
            await appDockerRestart(appSpecifications.name);
          } else if (appSpecifications.version <= 3) {
            if (globalState.removalInProgress) {
              log.warn(`Another application is undergoing removal. Skipping ${installedApp.name} for this cycle.`);
              // eslint-disable-next-line no-continue
              continue;
            }
            if (globalState.installationInProgress) {
              log.warn(`Another application is undergoing installation. Skipping ${installedApp.name} for this cycle.`);
              // eslint-disable-next-line no-continue
              continue;
            }
            if (globalState.softRedeployInProgress) {
              log.warn(`Another application is undergoing soft redeploy. Skipping ${installedApp.name} for this cycle.`);
              // eslint-disable-next-line no-continue
              continue;
            }
            if (globalState.hardRedeployInProgress) {
              log.warn(`Another application is undergoing hard redeploy. Skipping ${installedApp.name} for this cycle.`);
              // eslint-disable-next-line no-continue
              continue;
            }

            // Dynamic require to avoid circular dependency
            // eslint-disable-next-line global-require
        


            if (appSpecifications.hdd === installedApp.hdd) {
              log.warn(`Beginning Soft Redeployment of ${appSpecifications.name}...`);
              // eslint-disable-next-line no-await-in-loop
              const installedDeployment = await deploymentProvider.getInstalledDeployment(appSpecifications.name);
              if (installedDeployment) {
                // eslint-disable-next-line no-restricted-syntax
                for (const [, deployComp] of installedDeployment.componentEntries({ reverse: true })) {
                  const compAppId = dockerService.getAppIdentifier(deployComp.identifier);
                  // eslint-disable-next-line no-await-in-loop
                  await appUninstaller.softUninstallComponent(appSpecifications.name, compAppId, deployComp, null, true);
                }
              }
              // eslint-disable-next-line no-await-in-loop
              const deployment = await deploymentProvider.getInstalledDeployment(appSpecifications.name);
              if (deployment) {
                // eslint-disable-next-line no-restricted-syntax
                for (const [, comp] of deployment.componentEntries()) {
                  // eslint-disable-next-line no-await-in-loop
                  await appInstaller.installComponent(comp, { createVolumes: false, specVersion: appSpecifications.version });
                }
              }
            } else {
              log.warn(`Beginning Hard Redeployment of ${appSpecifications.name}...`);
              log.warn(`REMOVAL REASON: Hard redeployment - ${appSpecifications.name} HDD changed from ${installedApp.hdd} to ${appSpecifications.hdd}`);
              // eslint-disable-next-line no-await-in-loop
              await appUninstaller.hardUninstallApplication(appSpecifications.name, null, appSpecifications, null, true);
              // eslint-disable-next-line no-await-in-loop
              const deployment = await deploymentProvider.getInstalledDeployment(appSpecifications.name);
              if (deployment) {
                // eslint-disable-next-line no-restricted-syntax
                for (const [, comp] of deployment.componentEntries()) {
                  // eslint-disable-next-line no-await-in-loop
                  await appInstaller.installComponent(comp, { createVolumes: true, specVersion: appSpecifications.version });
                }
              }
            }
          } else {
            // composed application
            log.warn(`Beginning Redeployment of ${appSpecifications.name}...`);
            if (globalState.removalInProgress) {
              log.warn(`Another application is undergoing removal. Skipping ${installedApp.name} for this cycle.`);
              // eslint-disable-next-line no-continue
              continue;
            }
            if (globalState.installationInProgress) {
              log.warn(`Another application is undergoing installation. Skipping ${installedApp.name} for this cycle.`);
              // eslint-disable-next-line no-continue
              continue;
            }
            if (globalState.softRedeployInProgress) {
              log.warn(`Another application is undergoing soft redeploy. Skipping ${installedApp.name} for this cycle.`);
              // eslint-disable-next-line no-continue
              continue;
            }
            if (globalState.hardRedeployInProgress) {
              log.warn(`Another application is undergoing hard redeploy. Skipping ${installedApp.name} for this cycle.`);
              // eslint-disable-next-line no-continue
              continue;
            }

            // Dynamic require to avoid circular dependency
            // eslint-disable-next-line global-require
        


            const newSpec = !instantiated.isEncrypted() ? instantiated.spec : await deserializeSpec(appSpecifications);
            // eslint-disable-next-line no-await-in-loop
            const oldSpec = await deserializeSpec(installedApp);
            const structureChanged = Boolean(
              newSpec && oldSpec && instantiated.version >= 8 && installedApp.version >= 8
              && !newSpec.hasSameComponents(oldSpec),
            );

            if (structureChanged) {
              const oldCount = oldSpec.componentCount;
              const newCount = newSpec.componentCount;
              log.warn(`Application ${instantiated.name} (v${instantiated.version}) has component structure changes.`);
              log.warn(`Component count: ${oldCount} -> ${newCount}`);
              log.warn('Performing full hard redeploy to handle component changes...');
              log.warn(`REMOVAL REASON: Component structure change (v8+) - ${instantiated.name} component count/names changed`);

              // eslint-disable-next-line no-await-in-loop
              await appUninstaller.removeAppLocally(instantiated.name, null, false, false);
              const appRedeployResponse = messageHelper.createSuccessMessage('Application removed. Awaiting installation...');
              log.info(appRedeployResponse);

              // eslint-disable-next-line no-await-in-loop
              await serviceHelper.delay(config.fluxapps.redeploy.delay * 1000);

              // eslint-disable-next-line no-await-in-loop
              await appInstaller.checkAppRequirements(appSpecifications);

              // eslint-disable-next-line no-await-in-loop
              await appInstaller.registerAppLocally(appSpecifications, undefined, null, false, true);
              log.info(`Application ${instantiated.name} redeployed with new component structure`);

              // eslint-disable-next-line no-continue
              continue;
            }

            try {
              const installedDeployment = await deploymentProvider.getInstalledDeployment(instantiated.name);
              const compNames = newSpec.componentNames().reverse();
              // eslint-disable-next-line no-restricted-syntax
              for (const compName of compNames) {
                const newComp = newSpec.getComponent(compName);
                const oldComp = oldSpec?.getComponent?.(compName);
                const newCanonical = newComp.toCanonical();
                const oldCanonical = oldComp?.toCanonical();
                const deployComp = installedDeployment?.getComponent(compName);

                if (oldCanonical && JSON.stringify(oldCanonical) === JSON.stringify(newCanonical)) {
                  log.warn(`Component ${compName}_${instantiated.name} specs were not changed, skipping.`);
                } else if (deployComp && oldComp && newComp.persistentStorage?.sizeGb === oldComp.persistentStorage?.sizeGb) {
                  log.warn(`Beginning Soft Redeployment of component ${deployComp.identifier}...`);
                  const appId = dockerService.getAppIdentifier(deployComp.identifier);
                  // eslint-disable-next-line no-await-in-loop
                  await appUninstaller.softUninstallComponent(instantiated.name, appId, deployComp, null, stopAppMonitoring);
                  log.warn(`Application component ${deployComp.identifier} softly removed. Awaiting installation...`);
                  // eslint-disable-next-line no-await-in-loop
                  await serviceHelper.delay(config.fluxapps.redeploy.composedDelay * 1000);
                } else if (deployComp) {
                  log.warn(`Beginning Hard Redeployment of component ${deployComp.identifier}...`);
                  log.warn(`REMOVAL REASON: Hard redeployment (component) - ${deployComp.identifier} storage changed`);
                  const appId = dockerService.getAppIdentifier(deployComp.identifier);
                  // eslint-disable-next-line no-await-in-loop
                  await appUninstaller.hardUninstallComponent(instantiated.name, appId, newCanonical, null, stopAppMonitoring);
                  log.warn(`Application component ${deployComp.identifier} removed. Awaiting installation...`);
                  // eslint-disable-next-line no-await-in-loop
                  await serviceHelper.delay(config.fluxapps.redeploy.composedDelay * 1000);
                }
              }
              // connect to mongodb
              const dbopen = dbHelper.databaseConnection();
              const appsDatabase = dbopen.db(config.database.appslocal.database);
              const appsQuery = { name: appSpecifications.name };
              const appsProjection = {};
              log.warn('Cleaning up database...');
              // eslint-disable-next-line no-await-in-loop
              await dbHelper.findOneAndDeleteInDatabase(appsDatabase, localAppsInformation, appsQuery, appsProjection);
              const databaseStatus2 = {
                status: 'Database cleaned',
              };
              log.warn('Database cleaned');
              log.warn(databaseStatus2);
              log.warn(`Compositions of application ${appSpecifications.name} uninstalled. Continuing with installation...`);
              // composition removal done. Remove from installed apps and being installation
              // eslint-disable-next-line no-await-in-loop
              await appInstaller.checkAppRequirements(appSpecifications); // entire app

              // Register the app in database BEFORE creating Docker containers to prevent race condition
              const isEnterprise = instantiated.version >= 8 && instantiated.isEncrypted();

              const dbSpecs = JSON.parse(JSON.stringify(appSpecifications));

              if (isEnterprise) {
                dbSpecs.compose = [];
                dbSpecs.contacts = [];
              }

              // eslint-disable-next-line no-await-in-loop
              const insertResult = await dbHelper.insertOneToDatabase(appsDatabase, localAppsInformation, dbSpecs);
              if (!insertResult) {
                throw new Error(`CRITICAL: Failed to create database entry for ${instantiated.name} during composed app redeployment. Database insert returned undefined - likely duplicate key error or database failure. Aborting redeployment to prevent orphaned Docker containers.`);
              }
              log.info(`Database entry created for ${instantiated.name} BEFORE component Docker container creation (composed redeployment path)`);

              // eslint-disable-next-line no-restricted-syntax
              for (const compName of newSpec.componentNames()) {
                const identifier = `${compName}_${instantiated.name}`;
                const newComp = newSpec.getComponent(compName);
                const oldComp = oldSpec?.components?.[compName];
                const newCanonical = newComp.toCanonical();
                const oldCanonical = oldComp?.toCanonical();

                if (oldCanonical && JSON.stringify(oldCanonical) === JSON.stringify(newCanonical)) {
                  log.warn(`Component ${identifier} specs were not changed, skipping.`);
                } else if (oldComp && newComp.persistentStorage?.sizeGb === oldComp.persistentStorage?.sizeGb) {
                  log.warn(`Continuing Soft Redeployment of component ${identifier}...`);
                  // eslint-disable-next-line no-await-in-loop
                  await serviceHelper.delay(config.fluxapps.redeploy.composedDelay * 1000);
                  // eslint-disable-next-line no-await-in-loop
                  await softRegisterAppLocally(appSpecifications, newCanonical);
                } else {
                  log.warn(`Continuing Hard Redeployment of component ${identifier}...`);
                  // eslint-disable-next-line no-await-in-loop
                  await serviceHelper.delay(config.fluxapps.redeploy.composedDelay * 1000);
                  // eslint-disable-next-line no-await-in-loop
                  await appInstaller.registerAppLocally(appSpecifications, newCanonical);
                }
              }
              log.warn(`Composed application ${instantiated.name} updated.`);
              log.warn(`Restarting application ${instantiated.name}`);
              // eslint-disable-next-line no-await-in-loop, no-use-before-define
              await appDockerRestart(instantiated.name);
            } catch (error) {
              log.error(error);
              log.warn(`REMOVAL REASON: Redeployment error - ${instantiated.name} failed during redeployment: ${error.message}`);
              // eslint-disable-next-line no-await-in-loop
              await appUninstaller.removeAppLocally(instantiated.name, null, true, true, true); // remove entire app
              log.info(`Cleanup completed for ${instantiated.name} after redeployment failure`);
            }
          }
        }
      }
    }
    globalState.reinstallationOfOldAppsInProgress = false;
  } catch (error) {
    globalState.reinstallationOfOldAppsInProgress = false;
    log.error(error);
  }
}

/**
 * Force cleanup of applications that are not in the installed apps list
 * @returns {Promise<void>}
 */
async function forceAppRemovals() {
  try {
    log.info('Executing forceAppRemovals.');

    // Skip if any installation or removal operations are in progress
    if (globalState.removalInProgress) {
      log.info('Skipping forceAppRemovals: Another application removal is in progress');
      return;
    }
    if (globalState.installationInProgress) {
      log.info('Skipping forceAppRemovals: Another application installation is in progress');
      return;
    }
    if (globalState.softRedeployInProgress) {
      log.info('Skipping forceAppRemovals: Soft redeploy is in progress');
      return;
    }
    if (globalState.hardRedeployInProgress) {
      log.info('Skipping forceAppRemovals: Hard redeploy is in progress');
      return;
    }
    if (globalState.reinstallationOfOldAppsInProgress) {
      log.info('Skipping forceAppRemovals: Reinstallation of old apps is in progress');
      return;
    }

    // Import services to match original business logic where everything was in the same file
    // eslint-disable-next-line global-require
    const appQueryService = require('../appQuery/appQueryService');
    // eslint-disable-next-line global-require
    const registryManager = require('../appDatabase/registryManager');
    // eslint-disable-next-line global-require


    // Get current node's IP for checking app locations
    const myIP = await fluxNetworkHelper.getMyFluxIPandPort();
    if (!myIP) {
      log.warn('Unable to get node IP, skipping forceAppRemovals');
      return;
    }

    const dockerAppsReported = await appQueryService.listAllApps();
    const dockerApps = dockerAppsReported.data;
    const installedAppsRes = await appQueryService.installedApps();
    const appsInstalled = installedAppsRes.data;
    const dockerAppsNames = dockerApps.map((app) => {
      if (app.Names[0].startsWith('/zel')) {
        return app.Names[0].slice(4);
      }
      return app.Names[0].slice(5);
    });
    const dockerAppsTrueNames = [];
    dockerAppsNames.forEach((appName) => {
      const name = appName.split('_')[1] || appName;
      dockerAppsTrueNames.push(name);
    });

    // array of unique main app names
    let dockerAppsTrueNameB = [...new Set(dockerAppsTrueNames)];
    dockerAppsTrueNameB = dockerAppsTrueNameB.filter((appName) => appName !== 'watchtower');

    // Connect to database for checking app locations
    const dbopen = dbHelper.databaseConnection();
    const database = dbopen.db(config.database.appsglobal.database);

    // eslint-disable-next-line no-restricted-syntax
    for (const dApp of dockerAppsTrueNameB) {
      // check if app is in installedApps
      const appInstalledExists = appsInstalled.find((app) => app.name === dApp);
      if (!appInstalledExists) {
        // Check if this app is registered in locations for this node's IP
        let shouldBroadcast = false;
        try {
          const locationQuery = { name: dApp, ip: myIP };
          const locationProjection = { projection: { _id: 0 } };
          // eslint-disable-next-line no-await-in-loop
          const appLocation = await dbHelper.findOneInDatabase(database, globalAppsLocations, locationQuery, locationProjection);
          if (appLocation) {
            shouldBroadcast = true;
            log.info(`${dApp} found in locations for this IP (${myIP}), will broadcast removal`);
          } else {
            log.info(`${dApp} not found in locations for this IP (${myIP}), skipping broadcast`);
          }
        } catch (locationError) {
          log.error(`Error checking app location for ${dApp}: ${locationError.message}`);
          // Default to not broadcasting on error to avoid false positives
        }

        // eslint-disable-next-line no-await-in-loop
        const appDetails = await registryManager.getApplicationGlobalSpecifications(dApp);
        if (appDetails) {
          // it is global app
          // do removal
          log.warn(`${dApp} does not exist in installed app. Forcing removal.`);
          log.warn(`REMOVAL REASON: Orphan app cleanup - ${dApp} running in Docker but not in installed apps database (forceAppRemovals)`);
          // eslint-disable-next-line no-await-in-loop
          await appUninstaller.removeAppLocally(dApp, null, true, true, shouldBroadcast).catch((error) => log.error(error)); // remove entire app, only broadcast if in locations
          // eslint-disable-next-line no-await-in-loop
          await serviceHelper.delay(3 * 60 * 1000); // 3 mins
        } else {
          log.warn(`${dApp} does not exist in installed apps and global application specifications are missing. Forcing removal.`);
          log.warn(`REMOVAL REASON: Orphan app cleanup - ${dApp} running in Docker but missing from both installed apps DB and global specs (forceAppRemovals)`);
          // eslint-disable-next-line no-await-in-loop
          await appUninstaller.removeAppLocally(dApp, null, true, true, shouldBroadcast).catch((error) => log.error(error)); // remove entire app, only broadcast if in locations
          // eslint-disable-next-line no-await-in-loop
          await serviceHelper.delay(3 * 60 * 1000); // 3 mins
        }
      }
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * Manages syncthing master/slave application coordination using FDM services
 * @param {object} globalState - Global state object containing masterSlaveAppsRunning, etc.
 * @param {Function} installedApps - Function to get installed apps
 * @param {Function} listRunningApps - Function to get running apps
 * @param {Map} receiveOnlySyncthingAppsCache - Cache for receive-only syncthing apps
 * @param {Array} backupInProgress - Array of apps with backup in progress
 * @param {Array} restoreInProgress - Array of apps with restore in progress
 * @param {object} https - HTTPS module
 * @returns {Promise<void>}
 */
async function masterSlaveApps(globalStateParam, installedApps, listRunningApps, receiveOnlySyncthingAppsCache, backupInProgressParam, restoreInProgressParam, https) {
  try {
    // eslint-disable-next-line no-param-reassign
    globalStateParam.masterSlaveAppsRunning = true;
    // do not run if installationInProgress or removalInProgress or softRedeployInProgress or hardRedeployInProgress
    if (globalStateParam.installationInProgress || globalStateParam.removalInProgress || globalStateParam.softRedeployInProgress || globalStateParam.hardRedeployInProgress) {
      return;
    }

    // Check if syncthing is loaded and working before processing
    try {
      // eslint-disable-next-line global-require
      const syncthingService = require('../syncthingService');
      const syncthingHealth = await syncthingService.getHealth();
      if (syncthingHealth.status !== 'success' || !syncthingHealth.data || syncthingHealth.data.status !== 'OK') {
        log.warn('masterSlaveApps: Syncthing is not available or not healthy, skipping this cycle');
        return;
      }
    } catch (syncthingError) {
      log.warn(`masterSlaveApps: Failed to check syncthing health: ${syncthingError.message}, skipping this cycle`);
      return;
    }
    // get list of all installed apps
    const appsInstalled = await installedApps();
    // eslint-disable-next-line no-await-in-loop
    const runningAppsRes = await listRunningApps();
    if (runningAppsRes.status !== 'success') {
      throw new Error('Unable to check running Apps');
    }
    const runningApps = runningAppsRes.data;
    if (appsInstalled.status === 'error') {
      return;
    }

    // Decrypt enterprise apps (version 8 with encrypted content)
    appsInstalled.data = await decryptEnterpriseApps(appsInstalled.data);
    const runningAppsNames = runningApps.map((app) => {
      if (app.Names[0].startsWith('/zel')) {
        return app.Names[0].slice(4);
      }
      return app.Names[0].slice(5);
    });
    const agent = new https.Agent({
      rejectUnauthorized: false,
    });
    const axiosOptions = {
      timeout: 10000,
      httpsAgent: agent,
    };

    const validIdentifiers = new Set();
    const { DeploymentSpec } = await getSpecBackend();
    // eslint-disable-next-line no-restricted-syntax
    for (const app of appsInstalled.data) {
      // eslint-disable-next-line no-await-in-loop
      const spec = await deserializeSpec(app);
      if (!spec) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const deployment = DeploymentSpec.fromSpec(spec, appsFolder);
      for (const [, deployComp] of deployment.componentEntries()) {
        if (deployComp.hasActiveStandbySyncthing()) {
          validIdentifiers.add(deployComp.identifier);
        }
      }
    }

    // Remove stale entries from mastersRunningGSyncthingApps
    // eslint-disable-next-line no-restricted-syntax
    for (const identifier of mastersRunningGSyncthingApps.keys()) {
      if (!validIdentifiers.has(identifier)) {
        mastersRunningGSyncthingApps.delete(identifier);
        log.info(`masterSlaveApps: Cleaned up stale entry from mastersRunningGSyncthingApps: ${identifier}`);
      }
    }

    // Remove stale entries from timeTostartNewMasterApp
    // eslint-disable-next-line no-restricted-syntax
    for (const identifier of timeTostartNewMasterApp.keys()) {
      if (!validIdentifiers.has(identifier)) {
        timeTostartNewMasterApp.delete(identifier);
        log.info(`masterSlaveApps: Cleaned up stale entry from timeTostartNewMasterApp: ${identifier}`);
      }
    }

    // eslint-disable-next-line no-restricted-syntax
    for (const installedApp of appsInstalled.data) {
      let fdmOk = true;
      let identifier;
      let needsToBeChecked = false;
      let appId;
      const backupSkip = backupInProgressParam.some((backupItem) => installedApp.name === backupItem);
      const restoreSkip = restoreInProgressParam.some((backupItem) => installedApp.name === backupItem);
      if (backupSkip || restoreSkip) {
        log.info(`masterSlaveApps: Backup/Restore is running for ${installedApp.name}, syncthing masterSlave check is disabled for that app`);
        // eslint-disable-next-line no-continue
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const installedSpec = await deserializeSpec(installedApp);
      if (installedSpec) {
        const instDeploy = DeploymentSpec.fromSpec(installedSpec, appsFolder);
        for (const [, deployComp] of instDeploy.componentEntries()) {
          if (deployComp.hasActiveStandbySyncthing()) {
            identifier = deployComp.identifier;
            appId = dockerService.getAppIdentifier(identifier);
            needsToBeChecked = true;
            break;
          }
        }
      }
      if (needsToBeChecked) {
        // Get master IP from FDM using the new /appips endpoint
        // eslint-disable-next-line no-await-in-loop
        const fdmResult = await getMasterIpFromFdm(installedApp.name, axiosOptions);
        const { ip } = fdmResult;
        fdmOk = fdmResult.fdmOk;

        if (!fdmOk) {
          log.warn(`masterSlaveApps: All FDM services failed for app:${installedApp.name}, skipping primary selection for this cycle`);
          // eslint-disable-next-line no-continue
          continue;
        }
        if (fdmOk) {
          // no ip means there was no row with ip on fdm
          // down means there was a row ip with status down
          // eslint-disable-next-line no-await-in-loop
          let myIP;
          try {
            // eslint-disable-next-line no-await-in-loop
            myIP = await fluxNetworkHelper.getMyFluxIPandPort();
          } catch (error) {
            log.error(`masterSlaveApps: Failed to get my IP for app:${installedApp.name}, error: ${error.message}`);
            // eslint-disable-next-line no-continue
            continue;
          }
          if (myIP) {
            if (myIP.indexOf(':') < 0) {
              myIP += ':16127';
            }
            // Validate ip is a string if it exists
            if (ip && typeof ip !== 'string') {
              log.error(`masterSlaveApps: Invalid IP type from FDM for app:${installedApp.name}, got: ${typeof ip}`);
              // eslint-disable-next-line no-continue
              continue;
            }
            if ((!ip)) {
              log.info(`masterSlaveApps: app:${installedApp.name} has currently no primary set`);
              if (!runningAppsNames.includes(identifier)) {
                // Check if app is ready (syncthing data is synced) before allowing it to become primary
                let isReady = receiveOnlySyncthingAppsCache.has(appId) && receiveOnlySyncthingAppsCache.get(appId).restarted;

                // Fallback: If not in cache or not ready, check if syncthing folder is already in sendreceive mode
                // This handles the case where folder is synced but cache was cleared/lost
                if (!isReady) {
                  try {
                    // eslint-disable-next-line global-require
                    const syncthingService = require('../syncthingService');
                    // eslint-disable-next-line no-await-in-loop
                    const allSyncthingFolders = await syncthingService.getConfigFolders();
                    if (allSyncthingFolders.status === 'success') {
                      // Syncthing syncs the entire appId folder (includes all subdirectories)
                      const folder = `${appsFolder}${appId}`;
                      // eslint-disable-next-line no-restricted-syntax
                      for (const syncthingFolder of allSyncthingFolders.data) {
                        if (syncthingFolder.path === folder && syncthingFolder.type === 'sendreceive') {
                          log.info(`masterSlaveApps: app:${installedApp.name} folder is already in sendreceive mode, treating as ready`);
                          isReady = true;
                          break;
                        }
                      }
                    }
                  } catch (error) {
                    log.error(`masterSlaveApps: Failed to check syncthing folder status for ${installedApp.name}: ${error.message}`);
                  }
                }

                if (!isReady) {
                  log.info(`masterSlaveApps: app:${installedApp.name} is not ready yet (syncthing not synced), skipping primary selection for this cycle`);
                  // eslint-disable-next-line global-require
                  // eslint-disable-next-line no-continue
                  continue;
                }
                // eslint-disable-next-line no-await-in-loop
                // eslint-disable-next-line global-require
                const registryManager = require('../appDatabase/registryManager');
                // eslint-disable-next-line no-await-in-loop
                const runningAppList = await registryManager.appLocation(installedApp.name);
                runningAppList.sort((a, b) => {
                  if (!a.runningSince && b.runningSince) {
                    return -1;
                  }
                  if (a.runningSince && !b.runningSince) {
                    return 1;
                  }
                  if (a.runningSince < b.runningSince) {
                    return -1;
                  }
                  if (a.runningSince > b.runningSince) {
                    return 1;
                  }
                  if (a.ip < b.ip) {
                    return -1;
                  }
                  if (a.ip > b.ip) {
                    return 1;
                  }
                  return 0;
                });
                const index = runningAppList.findIndex((x) => x.ip.split(':')[0] === myIP.split(':')[0]);

                // Helper function to check if any lower-index nodes are running the app
                const checkLowerIndexNodesRunning = async () => {
                  if (index <= 0) return false; // Index 0 or not found, no lower nodes to check

                  const { CancelToken } = axios;
                  const timeout = 10 * 1000;

                  // Check all nodes with lower index
                  for (let i = 0; i < index; i += 1) {
                    const nodeToCheck = runningAppList[i];
                    if (!nodeToCheck) continue;

                    const ipToCheck = nodeToCheck.ip.split(':')[0];
                    const portToCheck = nodeToCheck.ip.split(':')[1] || '16127';
                    const source = CancelToken.source();
                    let isResolved = false;

                    setTimeout(() => {
                      if (!isResolved) {
                        source.cancel('Operation canceled by timeout.');
                      }
                    }, timeout);

                    try {
                      // eslint-disable-next-line no-await-in-loop
                      const response = await axios.get(`http://${ipToCheck}:${portToCheck}/apps/listrunningapps`, { timeout, cancelToken: source.token });
                      isResolved = true;
                      const appsRunning = response.data.data;
                      if (appsRunning.find((app) => app.Names[0].includes(installedApp.name))) {
                        log.info(`masterSlaveApps: app:${installedApp.name} is running on lower-index node (index ${i}) at ${ipToCheck}, will not start`);
                        return true;
                      }
                    } catch (error) {
                      isResolved = true;
                      log.info(`masterSlaveApps: Failed to check lower-index node ${i} at ${ipToCheck} for app:${installedApp.name}, error: ${error.message}`);
                      // Continue checking other nodes
                    }
                  }
                  return false;
                };

                if (index === 0 && !mastersRunningGSyncthingApps.has(identifier)) {
                  // Index 0: Start immediately if no history
                  appDockerRestartWithPermissionsFix(installedApp.name, appId);
                  log.info(`masterSlaveApps: starting docker app:${installedApp.name} index: ${index}`);
                } else if (!timeTostartNewMasterApp.has(identifier) && mastersRunningGSyncthingApps.has(identifier) && mastersRunningGSyncthingApps.get(identifier) !== myIP) {
                  // There was a previous master (not me), and it's no longer on FDM
                  const { CancelToken } = axios;
                  const source = CancelToken.source();
                  let isResolved = false;
                  const timeout = 10 * 1000; // 10 seconds
                  setTimeout(() => {
                    if (!isResolved) {
                      source.cancel('Operation canceled by the user.');
                    }
                  }, timeout * 2);
                  const previousMasterIp = mastersRunningGSyncthingApps.get(identifier);
                  // Look up the correct port from runningAppList since FDM API returns IP without port
                  const previousMasterNode = runningAppList.find((x) => x.ip.split(':')[0] === previousMasterIp.split(':')[0]);
                  const ipToCheckAppRunning = previousMasterIp.split(':')[0];
                  const portToCheckAppRunning = previousMasterNode ? (previousMasterNode.ip.split(':')[1] || '16127') : '16127';
                  let previousMasterStillRunning = false;
                  try {
                    // eslint-disable-next-line no-await-in-loop
                    const response = await axios.get(`http://${ipToCheckAppRunning}:${portToCheckAppRunning}/apps/listrunningapps`, { timeout, cancelToken: source.token });
                    isResolved = true;
                    const appsRunning = response.data.data;
                    if (appsRunning.find((app) => app.Names[0].includes(installedApp.name))) {
                      log.info(`masterSlaveApps: app:${installedApp.name} is not on fdm but previous master is running it at: ${ipToCheckAppRunning}:${portToCheckAppRunning}`);
                      previousMasterStillRunning = true;
                    }
                  } catch (error) {
                    log.info(`masterSlaveApps: Failed to reach previous master at ${ipToCheckAppRunning}:${portToCheckAppRunning} for app:${installedApp.name}, will proceed with primary selection. Error: ${error.message}`);
                    isResolved = true;
                  }
                  if (previousMasterStillRunning) {
                    return;
                  }
                  // Previous master is not running, determine next primary
                  if (index === 0) {
                    appDockerRestartWithPermissionsFix(installedApp.name, appId);
                    log.info(`masterSlaveApps: starting docker app:${installedApp.name} index: ${index}`);
                  } else {
                    const previousMasterIndex = runningAppList.findIndex((x) => x.ip.split(':')[0] === mastersRunningGSyncthingApps.get(identifier).split(':')[0]);
                    let timetoStartApp = Date.now();
                    if (previousMasterIndex >= 0) {
                      log.info(`masterSlaveApps: app:${installedApp.name} had primary running at index: ${previousMasterIndex}`);
                      if (index > previousMasterIndex) {
                        timetoStartApp += (index - 1) * 3 * 60 * 1000;
                      } else {
                        timetoStartApp += index * 3 * 60 * 1000;
                      }
                    } else {
                      timetoStartApp += index * 3 * 60 * 1000;
                    }
                    if (timetoStartApp <= Date.now()) {
                      // Time to start, but check if lower-index nodes are running
                      // eslint-disable-next-line no-await-in-loop
                      const lowerNodeRunning = await checkLowerIndexNodesRunning();
                      if (!lowerNodeRunning) {
                        appDockerRestartWithPermissionsFix(installedApp.name, appId);
                        log.info(`masterSlaveApps: starting docker app:${installedApp.name} index: ${index}`);
                      }
                    } else {
                      log.info(`masterSlaveApps: will start docker app:${installedApp.name} at ${timetoStartApp.toString()}`);
                      timeTostartNewMasterApp.set(identifier, timetoStartApp);
                    }
                  }
                } else if (timeTostartNewMasterApp.has(identifier) && timeTostartNewMasterApp.get(identifier) <= Date.now()) {
                  // Scheduled start time has arrived, check if lower-index nodes are running
                  // eslint-disable-next-line no-await-in-loop
                  const lowerNodeRunning = await checkLowerIndexNodesRunning();
                  if (!lowerNodeRunning) {
                    appDockerRestartWithPermissionsFix(installedApp.name, appId);
                    log.info(`masterSlaveApps: starting docker app:${installedApp.name} index: ${index} that was scheduled to start at ${timeTostartNewMasterApp.get(identifier).toString()}`);
                    timeTostartNewMasterApp.delete(identifier);
                  } else {
                    log.info(`masterSlaveApps: not starting app:${installedApp.name} index: ${index} - lower-index node is already running`);
                    timeTostartNewMasterApp.delete(identifier);
                  }
                } else if (index > 0 && !mastersRunningGSyncthingApps.has(identifier) && !timeTostartNewMasterApp.has(identifier)) {
                  // Non-primary node with no history - schedule start based on index
                  const timetoStartApp = Date.now() + (index * 3 * 60 * 1000);
                  log.info(`masterSlaveApps: scheduling app:${installedApp.name} index: ${index} to start at ${timetoStartApp.toString()}`);
                  timeTostartNewMasterApp.set(identifier, timetoStartApp);
                } else {
                  // All other cases: don't start
                  log.info(`masterSlaveApps: not starting app:${installedApp.name} index: ${index} - conditions not met for primary selection`);
                }
              }
            } else {
              mastersRunningGSyncthingApps.set(identifier, ip);
              if (timeTostartNewMasterApp.has(identifier)) {
                log.info(`masterSlaveApps: app:${installedApp.name} removed from timeTostartNewMasterApp cache, already started on another standby node`);
                timeTostartNewMasterApp.delete(identifier);
              }
              if (myIP.split(':')[0] !== ip.split(':')[0] && runningAppsNames.includes(identifier)) {
                appDockerStop(installedApp.name);
                log.info(`masterSlaveApps: stopping docker app:${installedApp.name} it's running on ip:${ip} and myIP is: ${myIP}`);
              } else if (myIP.split(':')[0] === ip.split(':')[0] && !runningAppsNames.includes(identifier)) {
                // Check if app is ready (syncthing data is synced) before starting
                let isReady = receiveOnlySyncthingAppsCache.has(appId) && receiveOnlySyncthingAppsCache.get(appId).restarted;

                // Fallback: If not in cache or not ready, check if syncthing folder is already in sendreceive mode
                if (!isReady) {
                  try {
                    // eslint-disable-next-line global-require
                    const syncthingService = require('../syncthingService');
                    // eslint-disable-next-line no-await-in-loop
                    const allSyncthingFolders = await syncthingService.getConfigFolders();
                    if (allSyncthingFolders.status === 'success') {
                      // Syncthing syncs the entire appId folder (includes all subdirectories)
                      const folder = `${appsFolder}${appId}`;
                      // eslint-disable-next-line no-restricted-syntax
                      for (const syncthingFolder of allSyncthingFolders.data) {
                        if (syncthingFolder.path === folder && syncthingFolder.type === 'sendreceive') {
                          log.info(`masterSlaveApps: app:${installedApp.name} folder is already in sendreceive mode, treating as ready`);
                          isReady = true;
                          break;
                        }
                      }
                    }
                  } catch (error) {
                    log.error(`masterSlaveApps: Failed to check syncthing folder status for ${installedApp.name}: ${error.message}`);
                  }
                }

                if (isReady) {
                  appDockerRestartWithPermissionsFix(installedApp.name, appId);
                  log.info(`masterSlaveApps: starting docker app:${installedApp.name}`);
                } else {
                  log.info(`masterSlaveApps: app:${installedApp.name} is registered as primary on FDM but not ready yet (syncthing not synced), skipping start for this cycle`);
                }
              }
            }
          }
        }
      }
    }
  } catch (error) {
    log.error(`masterSlaveApps: ${error}`);
  } finally {
    // eslint-disable-next-line no-param-reassign
    globalStateParam.masterSlaveAppsRunning = false;
    await serviceHelper.delay(30 * 1000);
    masterSlaveApps(globalStateParam, installedApps, listRunningApps, receiveOnlySyncthingAppsCache, backupInProgressParam, restoreInProgressParam, https);
  }
}

/**
 * Get from another peer the list of apps installing errors or just for a specific application name
 // eslint-disable-next-line global-require
 * @returns {Promise<void>}
 */
async function getPeerAppsInstallingErrorMessages() {
  try {
    // Import peerManager dynamically to avoid circular dependency
    // eslint-disable-next-line global-require
    const { peerManager } = require('../utils/peerState');

    if (peerManager.outboundCount === 0) {
      log.info('getPeerAppsInstallingErrorMessages - No outgoing peers available');
      return;
    }

    let finished = false;
    let i = 0;
    while (!finished && i <= 10) {
      i += 1;
      const peer = peerManager.getRandomPeer('outbound');
      if (!peer) break;
      const client = peer.toPeerInfo();
      let axiosConfig = {
        timeout: 5000,
      };
      log.info(`getPeerAppsInstallingErrorMessages - Getting fluxos uptime from ${client.ip}:${client.port}`);
      // eslint-disable-next-line no-await-in-loop
      const response = await serviceHelper.axiosGet(`http://${client.ip}:${client.port}/flux/uptime`, axiosConfig).catch((error) => log.error(error));
      if (!response || !response.data || response.data.status !== 'success' || !response.data.data) {
        log.info(`getPeerAppsInstallingErrorMessages - Failed to get fluxos uptime from ${client.ip}:${client.port}`);
        // eslint-disable-next-line no-continue
        continue;
      }
      const ut = process.uptime();
      const measureUptime = Math.floor(ut);
      // let's get information from a node that have higher fluxos uptime than me for at least one hour.
      if (response.data.data < measureUptime + 3600) {
        log.info(`getPeerAppsInstallingErrorMessages - Connected peer ${client.ip}:${client.port} doesn't have FluxOS uptime to be used`);
        // eslint-disable-next-line no-continue
        continue;
      }
      log.info(`getPeerAppsInstallingErrorMessages - FluxOS uptime is ok on ${client.ip}:${client.port}`);
      axiosConfig = {
        timeout: 30000,
      };
      log.info(`getPeerAppsInstallingErrorMessages - Getting app installing errors from ${client.ip}:${client.port}`);
      const url = `http://${client.ip}:${client.port}/apps/installingerrorslocations`;
      // eslint-disable-next-line no-await-in-loop
      const appsResponse = await serviceHelper.axiosGet(url, axiosConfig).catch((error) => log.error(error));
      if (!appsResponse || !appsResponse.data || appsResponse.data.status !== 'success' || !appsResponse.data.data) {
        log.info(`getPeerAppsInstallingErrorMessages - Failed to get app installing error locations from ${client.ip}:${client.port}`);
        // eslint-disable-next-line no-continue
        continue;
      }
      const apps = appsResponse.data.data;
      log.info(`getPeerAppsInstallingErrorMessages - Will process ${apps.length} apps installing errors locations messages`);
      const operations = apps.map((message) => ({
        updateOne: {
          filter: { name: message.name, hash: message.hash, ip: message.ip },
          update: { $set: message },
          upsert: true,
        },
      }));
      const dbopen = dbHelper.databaseConnection();
      const database = dbopen.db(config.database.appsglobal.database);
      // eslint-disable-next-line no-await-in-loop
      await dbHelper.bulkWriteInDatabase(database, globalAppsInstallingErrorsLocations, operations);
      finished = true;
    }
  } catch (error) {
    log.error(error);
  }
}

module.exports = {
  softRegisterAppLocally,
  softRemoveAppLocally,
  hardRedeploy,
  softRedeploy,
  redeployComponent,
  redeployAPI,
  redeployComponentAPI,
  updateAppGlobaly,
  updateAppGlobalyApi,
  appendBackupTask,
  appendRestoreTask,
  removeTestAppMount,
  testAppMount,
  setInstallationInProgress,
  setRemovalInProgress,
  getInstallationInProgress,
  getRemovalInProgress,
  addToRestoreProgress,
  removeFromRestoreProgress,
  removalInProgressReset,
  setRemovalInProgressToTrue,
  installationInProgressReset,
  setInstallationInProgressTrue,
  checkAndRemoveApplicationInstance,
  reinstallOldApplications,
  checkAndRemoveEnterpriseAppsOnNonArcane,
  forceAppRemovals,
  masterSlaveApps,
  getPeerAppsInstallingErrorMessages,
  appDockerStart,
};
