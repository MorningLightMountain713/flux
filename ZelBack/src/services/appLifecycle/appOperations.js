/*
 * appOperations — operations performed on an already-deployed app: redeploy,
 * global update broadcast, start/stop/restart, reconcile, force-removal,
 * active/standby coordination, backup/restore task append, test-app-mount, and
 * the installation/removal/restore in-progress state flags.
 *
 * WARNING: this is a grab-bag. It was inherited as "advancedWorkflows" and is a
 * dumping ground of loosely-related concerns that happen to sit above the
 * installer/uninstaller/docker primitives. It SHOULD be split along its real
 * seams — e.g. lifecycle commands (start/stop/restart/redeploy), the global
 * update intake, reconciliation, and the in-progress state tracker each belong
 * in their own module. Renaming it to appOperations is only a holding action;
 * do not keep adding to it.
 */
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
  appsFolder,
} = require('../utils/appConstants');
const {
  extractIp, extractPort, socketAddressesMatch, ipsMatch, DEFAULT_API_PORT,
} = require('../utils/socketAddressUtils');
const appsRepository = require('../appDatabase/appsRepository');
const registryManager = require('../appDatabase/registryManager');
const { isNewestInstance } = require('../utils/appUtilities');
const https = require('https');
const { deserializeSpec } = require('../utils/specCutover');
const { getSpec, assertUpdateInvariants } = require('../utils/specLibs');
const appEventVerifier = require('../appMessaging/appEventVerifier');
const messageVerifier = require('../appMessaging/messageVerifier');
const appQueryService = require('../appQuery/appQueryService');
const { listRunningContainers } = appQueryService;
const { startAppMonitoring, stopAppMonitoring } = require('../appManagement/appInspector');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const appReconciler = require('../appMonitoring/appReconciler');
const appsRuntimeState = require('../appManagement/appsRuntimeState');
const appVolumeService = require('./appVolumeService');
const appUninstaller = require('./appUninstaller');
const appInstaller = require('./appInstaller');
const shutdownPlan = require('./shutdownPlan');
const fluxShutdowndClient = require('../utils/fluxShutdowndClient');
const appNetworkLinker = require('./appNetworkLinker');
const telemetrySinkCache = require('../telemetrySinkCache');
const telemetryConfigService = require('../telemetryConfigService');
const telemetryIdentityService = require('../telemetryIdentityService');
const hwRequirements = require('../appRequirements/hwRequirements');
const { resolveSubmission, assertSecretsNotConflicting } = require('../appRequirements/appSubmission');
const globalState = require('../utils/globalState');

const isArcane = Boolean(process.env.FLUXOS_PATH);

// Legacy apps that use old gateway IP assignment method
const appsThatMightBeUsingOldGatewayIpAssignment = ['HNSDoH', 'dane', 'fdm', 'Jetpack2', 'fdmdedicated', 'isokosse', 'ChainBraryDApp', 'health', 'ethercalc'];

// Active-standby app tracking
const activePrimaryByIdentifier = new Map();
const scheduledPrimaryStart = new Map();

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
 * @returns {Promise<{ip: string|null, fdmOk: boolean}>} The master IP (FDM returns a bare IP;
 *   compare it with ipsMatch, which ignores the port) and success status
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
          const ip = extractIp(ips[0]);
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

// Global state management - using globalState module instead of local variables
// These are now managed through the globalState module
// eslint-disable-next-line no-unused-vars
let dosMountMessage = '';


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
/**
 * Redeploy a single component of an application.
 *
 * @param {string} appName
 * @param {string} componentName
 * @param {object} [options]
 * @param {boolean} [options.createVolumes=false] - true = recreate volumes, false = keep
 * @param {Function|null} [options.onStatus] - progress callback
 */
async function redeployComponent(appName, componentName, options = {}) {
  const createVolumes = options.createVolumes || false;
  const onStatus = options.onStatus || null;

  const stateFlag = createVolumes ? 'hardRedeployInProgress' : 'softRedeployInProgress';
  const label = createVolumes ? 'rebuild' : 'redeploy';

  const status = (msg) => {
    log.info(msg);
    if (onStatus) onStatus(msg);
  };

  if (globalState.removalInProgress
    || globalState.installationInProgress
    || globalState.softRedeployInProgress
    || globalState.hardRedeployInProgress) {
    status('Another operation is in progress');
    return;
  }

  globalState[stateFlag] = true;

  try {
    const deployment = await deploymentProvider.getInstalledDeployment(appName);
    if (!deployment) {
      throw new Error(`Application ${appName} not found`);
    }

    const deployComp = deployment.getComponent(componentName);
    if (!deployComp) {
      throw new Error(`Component ${componentName} not found in application ${appName}`);
    }

    if (createVolumes) {
      log.warn(`REMOVAL REASON: ${label} initiated - ${deployComp.identifier} (redeployComponent)`);
    }
    await appUninstaller.uninstallComponent(deployComp, {
      removeVolumes: createVolumes,
      onStatus,
    });

    status(`Component ${deployComp.identifier} removed. Awaiting installation...`);
    await serviceHelper.delay(config.fluxapps.redeploy.composedDelay * 1000);

    const instantiated = await appsRepository.getInstalledApp(appName);
    const freshDeployment = await deploymentProvider.buildDeployment(instantiated);
    await hwRequirements.checkNodeResources(freshDeployment);

    status(`Installing ${deployComp.identifier}...`);
    await appInstaller.installComponent(deployComp, {
      createVolumes,
      specVersion: instantiated.version,
      owner: instantiated.owner,
    });

    status(`Component ${deployComp.identifier} ${label} complete`);
    globalState[stateFlag] = false;
  } catch (error) {
    log.error(error);
    log.warn(`REMOVAL REASON: ${label} failure - ${appName}: ${error.message} (redeployComponent)`);
    globalState[stateFlag] = false;
    await appUninstaller.uninstallApplication(appName, { forceKill: true, skipGuard: true, broadcastRemoval: true });
  }
}

/**
 * Redeploy all components of an application.
 *
 * @param {string} appName
 * @param {object} [options]
 * @param {boolean} [options.createVolumes=false] - true = recreate volumes, false = keep
 * @param {Function|null} [options.onStatus] - progress callback
 * @param {boolean} [options.broadcastRemoval=false] - broadcast fluxappremoved on cleanup failure
 */
async function redeployApplication(appName, options = {}) {
  const createVolumes = options.createVolumes || false;
  const onStatus = options.onStatus || null;
  const broadcastRemoval = options.broadcastRemoval || false;

  const label = createVolumes ? 'rebuild' : 'redeploy';

  const status = (msg) => {
    log.info(msg);
    if (onStatus) onStatus(msg);
  };

  if (globalState.removalInProgress
    || globalState.installationInProgress
    || globalState.softRedeployInProgress
    || globalState.hardRedeployInProgress) {
    status('Another operation is in progress');
    return;
  }

  const stateFlag = createVolumes ? 'hardRedeployInProgress' : 'softRedeployInProgress';
  globalState[stateFlag] = true;

  try {
    const deployment = await deploymentProvider.getInstalledDeployment(appName);
    if (!deployment) {
      throw new Error(`Application ${appName} not found`);
    }

    status(`Beginning ${label} of ${appName}...`);

    for (const [, deployComp] of deployment.componentEntries({ reverse: true })) {
      if (createVolumes) {
        log.warn(`REMOVAL REASON: ${label} initiated - ${deployComp.identifier} (redeployApplication)`);
      }
      // eslint-disable-next-line no-await-in-loop
      await appUninstaller.uninstallComponent(deployComp, {
        removeVolumes: createVolumes,
        onStatus,
      });
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(config.fluxapps.redeploy.composedDelay * 1000);
    }

    status(`Application ${appName} removed. Awaiting installation...`);
    await serviceHelper.delay(config.fluxapps.redeploy.delay * 1000);

    const instantiated = await appsRepository.getInstalledApp(appName);
    if (!instantiated) {
      throw new Error(`Application ${appName} not found in database after removal`);
    }
    const freshDeployment = await deploymentProvider.buildDeployment(instantiated);
    if (!freshDeployment) {
      throw new Error(`Application ${appName} deployment not found after requirement check`);
    }
    await hwRequirements.checkNodeResources(freshDeployment);

    // Re-seed telemetry routing before recreating containers, in case the
    // redeploy carries a rotated sink (or dropped telemetry entirely).
    telemetrySinkCache.setSink(appName, telemetrySinkCache.extractSink(freshDeployment));

    // Re-verify shared-network links before recreating containers.
    await appNetworkLinker.checkAppNetworkRequirements(instantiated);

    for (const [, deployComp] of freshDeployment.componentEntries()) {
      status(`Installing ${deployComp.identifier}...`);
      // eslint-disable-next-line no-await-in-loop
      await appInstaller.installComponent(deployComp, {
        createVolumes,
        specVersion: instantiated.version,
        owner: instantiated.owner,
      });
      // Re-attach the recreated container to every linked app's network.
      // eslint-disable-next-line no-await-in-loop
      await appNetworkLinker.connectComponentToLinkedApps(deployComp.identifier, instantiated);
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(config.fluxapps.redeploy.composedDelay * 1000);
    }

    // Refresh the shutdown plan: a redeploy may carry an updated spec (new
    // hash, components, or timeouts). Guarded — the handoff must never break
    // a redeploy. Per-container labels were already restamped at docker-create.
    try {
      await fluxShutdowndClient.upsertAppPlanBestEffort(
        shutdownPlan.buildShutdownPlan(instantiated, freshDeployment),
      );
    } catch (error) {
      log.warn(`flux-shutdownd plan handoff skipped: ${error.message}`);
    }

    status(`Application ${appName} ${label} complete`);
    globalState[stateFlag] = false;
  } catch (error) {
    log.error(error);
    log.warn(`REMOVAL REASON: ${label} failure - ${appName}: ${error.message} (redeployApplication)`);
    globalState[stateFlag] = false;
    await appUninstaller.uninstallApplication(appName, { forceKill: true, skipGuard: true, broadcastRemoval });
    log.info(`Cleanup completed for ${appName} after ${label} failure`);
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

    await redeployComponent(appname, component, {
      createVolumes: force,
      onStatus: (msg) => {
        res.write(serviceHelper.ensureString(msg));
        if (res.flush) res.flush();
      },
    });

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
 * Redeploy application via API
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
async function redeployApplicationAPI(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;

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

    let isGlobal = req.params.global || req.query.global || false;
    isGlobal = serviceHelper.ensureBoolean(isGlobal);

    if (isGlobal) {
      // eslint-disable-next-line global-require
      const appController = require('../appManagement/appController');
      appController.executeAppGlobalCommand(appname, 'redeploy', req.headers.zelidauth, force);
      const label = force ? 'hard' : 'soft';
      res.json(messageHelper.createSuccessMessage(`${appname} queried for global ${label} redeploy`));
      return;
    }

    res.setHeader('Content-Type', 'application/json');

    await redeployApplication(appname, {
      createVolumes: force,
      onStatus: (msg) => {
        res.write(serviceHelper.ensureString(msg));
        if (res.flush) res.flush();
      },
      broadcastRemoval: true,
    });
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
async function startApplication(appname) {
  try {
    const mainAppName = appname.split('_')[1] || appname;
    const isComponent = appname.includes('_');
    if (isComponent) {
      await dockerService.appDockerStart(appname);
      startAppMonitoring(appname);
    } else {
      const instantiated = await appsRepository.getGlobalAppInfo(mainAppName);
      if (!instantiated) {
        throw new Error('Application not found');
      }
      const deployment = await deploymentProvider.buildDeployment(instantiated);
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
async function stopApplication(appname) {
  try {
    const mainAppName = appname.split('_')[1] || appname;
    const isComponent = appname.includes('_');
    if (isComponent) {
      await dockerService.appDockerStop(appname);
      stopAppMonitoring(appname, false);
    } else {
      const instantiated = await appsRepository.getGlobalAppInfo(mainAppName);
      if (!instantiated) {
        throw new Error('Application not found');
      }
      const deployment = await deploymentProvider.buildDeployment(instantiated);
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
async function restartApplication(appname) {
  try {
    const mainAppName = appname.split('_')[1] || appname;
    const instantiated = await appsRepository.getGlobalAppInfo(mainAppName);
    if (!instantiated) {
      throw new Error('Application not found');
    }
    const deployment = await deploymentProvider.buildDeployment(instantiated);
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
      for (const [compName] of deployment.componentEntries()) {
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
async function promoteApplicationToPrimary(appname, appId) {
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

    // Step 4: hand the run-state decision to the reconciler (the single
    // container actuator); permissions are already fixed at this point
    appReconciler.setControllerDesired(appname, 'running', 'masterSlave primary (synced)');

    log.info(`Successfully completed permissions fix workflow for ${appname}`);
  } catch (error) {
    log.error(`Error in promoteApplicationToPrimary for ${appname}: ${error.message}`);
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
      const backupDeployment = await deploymentProvider.getInstalledDeployment(appname);
      const hasSyncthing = backupDeployment && backupDeployment.componentEntries().some(([, comp]) => comp.hasSyncthing());
      if (hasSyncthing) {
        await sendChunk(res, `Stopping syncthing for ${appname}\n`);
        await appVolumeService.removeSyncthingFolder(appname, res);
      }

      await sendChunk(res, 'Stopping application...\n');
      await stopApplication(appname);
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
        await startApplication(appname);
      } else {
        for (const [compName, comp] of appSpec.componentEntries()) {
          if (comp.persistentStorage?.sync?.mode !== 'activeStandby') {
            // eslint-disable-next-line no-await-in-loop
            await startApplication(`${compName}_${appname}`);
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
      const restoreDeployment = await deploymentProvider.getInstalledDeployment(appname);
      const restoreHasSyncthing = restoreDeployment && restoreDeployment.componentEntries().some(([, comp]) => comp.hasSyncthing());
      if (restoreHasSyncthing) {
        await sendChunk(res, `Stopping syncthing for ${appname}\n`);
        await appVolumeService.removeSyncthingFolder(appname, res);
      }
      await sendChunk(res, 'Stopping application...\n');
      await stopApplication(appname);
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
      await startApplication(appname);
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
 * @param {object} previousAppSpecs - Previous app specifications (from appSpecHistory.getPreviousAppSpecifications)
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
  // envelope version 1 = legacy v1-v8, 2 = v9 (AppEventV2 / contentHash signing)
  if (typeVersion !== 1 && typeVersion !== 2) {
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
  const cleanContentHash = params.contentHash;
  const cleanExtend = params.extend;

  const { spec, broadcastBlob } = await resolveSubmission(appSpecObj, {
    contentHash: cleanContentHash, timestamp: cleanTimestamp, type: cleanMessageType, daemonHeight,
  });

  for (const { componentName, secrets } of spec.getComponentSecrets()) {
    // eslint-disable-next-line no-await-in-loop
    await assertSecretsNotConflicting(spec.name, componentName, secrets, spec.owner);
  }

  const appInfo = await appsRepository.getGlobalAppInfo(spec.name);
  if (!appInfo) {
    throw new Error('Flux App update received but application to update does not exist!');
  }
  const previousSpec = appInfo.spec;

  // Registration-locked invariants (e.g. referral). Both specs must be
  // cleartext; the stored prior spec may be encrypted, so decrypt it first.
  const priorCleartext = previousSpec.isEncrypted
    ? await previousSpec.decrypt(await previousSpec.createProvider())
    : previousSpec;
  await assertUpdateInvariants(priorCleartext, spec);

  const appEvent = await appEventVerifier.deserializeTempMessage({
    type: cleanMessageType,
    version: cleanTypeVersion,
    appSpecifications: broadcastBlob,
    contentHash: cleanContentHash,
    timestamp: cleanTimestamp,
    extend: cleanExtend,
    signature: cleanSignature,
  });
  await appEventVerifier.authorize({ appEvent, previousSpec, daemonHeight, verifyHash: false });

  const { latestSupportedSpecVersion } = config.fluxapps;
  if (appInfo.version !== spec.version && spec.version !== latestSupportedSpecVersion) {
    throw new Error(
      `Application update rejected: Version changes are only allowed when updating to version ${latestSupportedSpecVersion} (current latest supported version). `
      + `Current version: ${appInfo.version}, Attempted version: ${spec.version}. `
      + `To update this application, please use version ${latestSupportedSpecVersion} specifications.`,
    );
  }

  const { UpdatePolicy } = await getSpec();
  UpdatePolicy.assertCompatible(previousSpec, spec);

  const messageHASH = await appEventVerifier.computeOutboundHash({
    type: cleanMessageType,
    envelopeVersion: cleanTypeVersion,
    specBlob: broadcastBlob,
    contentHash: cleanContentHash,
    timestamp: cleanTimestamp,
    extend: cleanExtend,
    signature: cleanSignature,
  });

  // v9 only (envelope version 2). v8 enterprise messages are envelope version 1,
  // which old nodes still parse — they must not carry an unknown arcaneAttestation
  // key. v9 messages are rejected by old nodes before parsing.
  let arcaneAttestation;
  if (cleanTypeVersion === 2 && appEvent.isEncrypted) {
    arcaneAttestation = await appEventVerifier.requestAttestation(cleanContentHash);
  }

  const temporaryAppMessage = {
    type: cleanMessageType,
    version: cleanTypeVersion,
    appSpecifications: broadcastBlob,
    hash: messageHASH,
    contentHash: cleanContentHash,
    timestamp: cleanTimestamp,
    extend: cleanExtend,
    signature: cleanSignature,
    arcaneAttestation,
  };

  // fluxCommunicationMessagesSender stays a lazy require: it forms a load-time
  // cycle back to this module (via dockerService -> ... -> appInspector).
  // eslint-disable-next-line global-require
  const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
  await fluxCommunicationMessagesSender.broadcastTemporaryAppMessage(temporaryAppMessage);
  await serviceHelper.delay(1200);
  await messageVerifier.requestAppMessage(messageHASH);
  await serviceHelper.delay(1200);

  let tempMessage = await appsRepository.getTempMessage(messageHASH);
  for (let i = 0; i < 20; i += 1) {
    if (!tempMessage) {
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(500);
      // eslint-disable-next-line no-await-in-loop
      tempMessage = await appsRepository.getTempMessage(messageHASH);
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
        // v9 (envelope version 2) signs over contentHash and carries the extend
        // flag; both are required to reconstruct the signed message and verify it.
        contentHash: processedBody.contentHash,
        extend: processedBody.extend,
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

function isOperationInProgress() {
  return globalState.removalInProgress
    || globalState.installationInProgress
    || globalState.softRedeployInProgress
    || globalState.hardRedeployInProgress
    || globalState.reconciliationInProgress;
}


async function reconcileComponents(appName, oldDeployment, newDeployment, registrySpec) {
  const oldNames = new Set(Object.keys(oldDeployment.components));
  const newNames = new Set(Object.keys(newDeployment.components));

  const removed = [...oldNames].filter((n) => !newNames.has(n));
  const added = [...newNames].filter((n) => !oldNames.has(n));
  const kept = [...oldNames].filter((n) => newNames.has(n));

  const soft = [];
  const hard = [];
  for (const name of kept) {
    const oldComp = oldDeployment.getComponent(name);
    const newComp = newDeployment.getComponent(name);
    if (oldComp.equals(newComp)) {
      log.info(`Component ${name} of ${appName} unchanged, skipping`);
    } else if (oldComp.storage === newComp.storage) {
      soft.push(name);
    } else {
      hard.push(name);
    }
  }

  const toUninstall = [...removed, ...hard, ...soft];
  if (toUninstall.length > 0) {
    for (const name of toUninstall.reverse()) {
      const deployComp = oldDeployment.getComponent(name);
      if (!deployComp) continue;
      const removeVolumes = removed.includes(name) || hard.includes(name);
      if (removeVolumes) {
        log.warn(`REMOVAL REASON: Reconciliation - ${deployComp.identifier} ${removed.includes(name) ? 'removed from spec' : 'storage changed'}`);
      }
      // eslint-disable-next-line no-await-in-loop
      await appUninstaller.uninstallComponent(deployComp, { removeVolumes });
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(config.fluxapps.redeploy.composedDelay * 1000);
    }
  }

  const wireSpec = registrySpec.serialize();
  await appsRepository.upsertInstalledApp(appName, wireSpec);
  log.info(`Database updated for ${appName}`);

  const freshDeployment = await deploymentProvider.buildDeployment(registrySpec);
  await hwRequirements.checkNodeResources(freshDeployment);

  // Re-seed telemetry routing from the updated spec. A sink change (key
  // rotation, added/dropped telemetry) can arrive with no component diff,
  // so this cannot ride on component reinstalls — re-announce the running
  // containers so connected daemons rebuild their exporters.
  if (freshDeployment) {
    const telemetrySink = telemetrySinkCache.extractSink(freshDeployment);
    telemetrySinkCache.setSink(appName, telemetrySink);
    if (telemetrySink) await telemetryConfigService.ensureNode();
    telemetryIdentityService.resyncAll();
  }

  const toInstall = [...soft, ...hard, ...added];
  if (freshDeployment && toInstall.length > 0) {
    for (const name of toInstall) {
      const deployComp = freshDeployment.getComponent(name);
      if (!deployComp) continue;
      const createVolumes = hard.includes(name) || added.includes(name);
      log.info(`Installing ${deployComp.identifier} (${createVolumes ? 'with' : 'without'} volumes)...`);
      // eslint-disable-next-line no-await-in-loop
      await appInstaller.installComponent(deployComp, {
        createVolumes,
        specVersion: registrySpec.version,
        owner: registrySpec.owner,
      });
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(config.fluxapps.redeploy.composedDelay * 1000);
    }
  }

  // The applied spec changed, so the app-wide shutdown plan (hash, components,
  // timeouts) may differ. Push the full refreshed plan. Guarded — must never
  // break the update.
  if (freshDeployment) {
    try {
      await fluxShutdowndClient.upsertAppPlanBestEffort(
        shutdownPlan.buildShutdownPlan(registrySpec, freshDeployment),
      );
    } catch (error) {
      log.warn(`flux-shutdownd plan handoff skipped: ${error.message}`);
    }
  }
}

async function reconcileApp(installed, registrySpec) {
  const oldDeployment = await deploymentProvider.getInstalledDeployment(installed.name);
  const newDeployment = await deploymentProvider.buildDeployment(registrySpec);
  if (!oldDeployment || !newDeployment) return;

  if (isOperationInProgress()) {
    log.warn(`Skipping ${installed.name} — another operation in progress`);
    return;
  }

  globalState.reconciliationInProgress = true;
  try {
    log.info(`Application ${installed.name} version is obsolete, reconciling...`);
    await reconcileComponents(installed.name, oldDeployment, newDeployment, registrySpec);
    log.info(`Application ${installed.name} reconciliation complete`);
  } catch (error) {
    log.error(error);
    log.warn(`REMOVAL REASON: Reconciliation failure - ${installed.name}: ${error.message}`);
    await appUninstaller.uninstallApplication(installed.name, { forceKill: true, skipGuard: true, broadcastRemoval: true });
    log.info(`Cleanup completed for ${installed.name} after reconciliation failure`);
  } finally {
    globalState.reconciliationInProgress = false;
  }
}

/**
 * Reconcile flux-shutdownd's plan store against the installed apps on boot.
 * The self-healing backstop for any plan upsert/delete missed while fluxos was
 * down: re-push plans whose spec_hash drifted (or are absent) and delete
 * orphans for apps no longer installed. Best-effort and Arcane-only — the
 * daemon socket is absent elsewhere, so a list failure just ends the resync.
 */
async function shutdownPlanResync() {
  if (!isArcane) return;

  let summaries;
  try {
    summaries = await fluxShutdowndClient.listAppPlans();
  } catch (error) {
    log.warn(`shutdown plan resync skipped: ${error.message}`);
    return;
  }

  try {
    const installedApps = await appsRepository.listInstalledApps();
    const planKey = (owner, name) => `${owner}:${name}`;
    const stored = new Map(summaries.map((s) => [planKey(s.owner_flux_id, s.app_name), s]));
    const live = new Set();
    let pushed = 0;
    let deleted = 0;

    for (const installed of installedApps) {
      const key = planKey(installed.owner, installed.name);
      live.add(key);
      const summary = stored.get(key);
      if (summary && summary.spec_hash === installed.hash) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const deployment = await deploymentProvider.buildDeployment(installed);
        if (!deployment) continue;
        // eslint-disable-next-line no-await-in-loop
        await fluxShutdowndClient.upsertAppPlanBestEffort(
          shutdownPlan.buildShutdownPlan(installed, deployment),
        );
        pushed += 1;
      } catch (error) {
        log.warn(`shutdown plan resync upsert failed for ${installed.name}: ${error.message}`);
      }
    }

    for (const [key, summary] of stored) {
      if (live.has(key)) continue;
      // eslint-disable-next-line no-await-in-loop
      await fluxShutdowndClient.deleteAppPlanBestEffort(summary.app_name, summary.owner_flux_id);
      deleted += 1;
    }

    if (pushed || deleted) log.info(`shutdown plan resync: ${pushed} re-pushed, ${deleted} orphans removed`);
  } catch (error) {
    log.error(`shutdown plan resync failed: ${error.message}`);
  }
}

async function reconcileInstalledApps() {
  try {
    const synced = await generalService.checkSynced();
    if (synced !== true) {
      log.info('Reconciliation paused. Not yet synced');
      return;
    }

    const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
    const installedApps = await appsRepository.listInstalledApps();

    for (const installed of installedApps) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const registrySpec = await appsRepository.getGlobalAppInfo(installed.name);
        if (!registrySpec) continue;

        // eslint-disable-next-line no-await-in-loop
        const runningAppList = await registryManager.appLocation(installed.name);
        const minInstances = installed.spec.instances || config.fluxapps.minimumInstances;
        if (localSocketAddr && runningAppList.length > minInstances && isNewestInstance(runningAppList, localSocketAddr)) {
          log.warn(`REMOVAL REASON: Too many instances - ${installed.name} running on ${runningAppList.length} instances (max: ${minInstances}) - This node is the newest instance`);
          // eslint-disable-next-line no-await-in-loop
          await appUninstaller.uninstallApplication(installed.name, { broadcastRemoval: true });
          // eslint-disable-next-line no-await-in-loop
          await serviceHelper.delay(config.fluxapps.removal.delay * 1000);
          continue;
        }

        if (registrySpec.hash === installed.hash) continue;

        if (registrySpec.isEncrypted && !isArcane) {
          log.warn(`REMOVAL REASON: Enterprise app requires arcaneOS - ${installed.name}`);
          // eslint-disable-next-line no-await-in-loop
          await appUninstaller.uninstallApplication(installed.name, { forceKill: true, skipGuard: true, broadcastRemoval: true });
          continue;
        }

        // eslint-disable-next-line no-await-in-loop
        await reconcileApp(installed, registrySpec);
      } catch (error) {
        log.error(`Reconciliation failed for ${installed.name}: ${error.message}`);
      }
    }
  } catch (error) {
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

    // Get current node's IP for checking app locations
    const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
    if (!localSocketAddr) {
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

    // eslint-disable-next-line no-restricted-syntax
    for (const dApp of dockerAppsTrueNameB) {
      // check if app is in installedApps
      const appInstalledExists = appsInstalled.find((app) => app.name === dApp);
      if (!appInstalledExists) {
        let shouldBroadcast = false;
        try {
          // eslint-disable-next-line no-await-in-loop
          const location = await appsRepository.getAppLocation(dApp, localSocketAddr);
          if (location) {
            shouldBroadcast = true;
            log.info(`${dApp} found in locations for this IP (${localSocketAddr}), will broadcast removal`);
          } else {
            log.info(`${dApp} not found in locations for this IP (${localSocketAddr}), skipping broadcast`);
          }
        } catch (locationError) {
          log.error(`Error checking app location for ${dApp}: ${locationError.message}`);
        }

        // eslint-disable-next-line no-await-in-loop
        const appExists = await appsRepository.existsGlobalApp(dApp);
        if (appExists) {
          // it is global app
          // do removal
          log.warn(`${dApp} does not exist in installed app. Forcing removal.`);
          log.warn(`REMOVAL REASON: Orphan app cleanup - ${dApp} running in Docker but not in installed apps database (forceAppRemovals)`);
          // eslint-disable-next-line no-await-in-loop
          await appUninstaller.uninstallApplication(dApp, { forceKill: true, skipGuard: true, broadcastRemoval: shouldBroadcast }).catch((error) => log.error(error)); // remove entire app, only broadcast if in locations
          // eslint-disable-next-line no-await-in-loop
          await serviceHelper.delay(3 * 60 * 1000); // 3 mins
        } else {
          log.warn(`${dApp} does not exist in installed apps and global application specifications are missing. Forcing removal.`);
          log.warn(`REMOVAL REASON: Orphan app cleanup - ${dApp} running in Docker but missing from both installed apps DB and global specs (forceAppRemovals)`);
          // eslint-disable-next-line no-await-in-loop
          await appUninstaller.uninstallApplication(dApp, { forceKill: true, skipGuard: true, broadcastRemoval: shouldBroadcast }).catch((error) => log.error(error)); // remove entire app, only broadcast if in locations
          // eslint-disable-next-line no-await-in-loop
          await serviceHelper.delay(3 * 60 * 1000); // 3 mins
        }
      }
    }
  } catch (error) {
    log.error(error);
  }
}

async function coordinateActiveStandbyApps() {
  try {
    globalState.activeStandbyCoordinationRunning = true;
    if (isOperationInProgress()) {
      return;
    }

    // Wait for the syncthing monitor's first run before electing any primary:
    // that run performs the startup mount-safety check (switching unsafe
    // sendreceive folders to receiveonly). Electing earlier could start a
    // master on a sendreceive-but-unmounted folder and lose data. The monitor
    // clears the flag only after a fully successful cycle.
    if (globalState.syncthingAppsFirstRun) {
      log.info('activeStandby: syncthing first-run mount-safety not complete yet, skipping this cycle');
      return;
    }

    try {
      // eslint-disable-next-line global-require
      const syncthingService = require('../syncthingService');
      const syncthingHealth = await syncthingService.getHealth();
      if (syncthingHealth.status !== 'success' || !syncthingHealth.data || syncthingHealth.data.status !== 'OK') {
        log.warn('activeStandby: Syncthing is not available or not healthy, skipping this cycle');
        return;
      }
    } catch (syncthingError) {
      log.warn(`activeStandby: Failed to check syncthing health: ${syncthingError.message}, skipping this cycle`);
      return;
    }

    const deployments = await deploymentProvider.listInstalledDeployments();
    const runningContainers = await listRunningContainers();

    const runningAppsNames = runningContainers.map((app) => {
      if (app.Names[0].startsWith('/zel')) return app.Names[0].slice(4);
      return app.Names[0].slice(5);
    });
    const agent = new https.Agent({ rejectUnauthorized: false });
    const axiosOptions = { timeout: 10000, httpsAgent: agent };

    const validIdentifiers = new Set();
    for (const deployment of deployments) {
      for (const [, deployComp] of deployment.componentEntries()) {
        if (deployComp.hasActiveStandbySyncthing()) {
          validIdentifiers.add(deployComp.identifier);
        }
      }
    }

    for (const identifier of activePrimaryByIdentifier.keys()) {
      if (!validIdentifiers.has(identifier)) {
        activePrimaryByIdentifier.delete(identifier);
        log.info(`activeStandby: Cleaned up stale entry from activePrimaryByIdentifier: ${identifier}`);
      }
    }

    for (const identifier of scheduledPrimaryStart.keys()) {
      if (!validIdentifiers.has(identifier)) {
        scheduledPrimaryStart.delete(identifier);
        log.info(`activeStandby: Cleaned up stale entry from scheduledPrimaryStart: ${identifier}`);
      }
    }

    const backupInProgress = globalState.backupInProgress || [];
    const restoreInProgress = globalState.restoreInProgress || [];
    const receiveOnlySyncthingAppsCache = globalState.receiveOnlySyncthingAppsCache;

    for (const deployment of deployments) {
      const appName = deployment.appName;
      let fdmOk = true;
      let identifier;
      let needsToBeChecked = false;
      let appId;
      const backupSkip = backupInProgress.some((item) => appName === item);
      const restoreSkip = restoreInProgress.some((item) => appName === item);
      if (backupSkip || restoreSkip) {
        log.info(`activeStandby: Backup/Restore is running for ${appName}, skipping`);
        // eslint-disable-next-line no-continue
        continue;
      }
      for (const [, deployComp] of deployment.componentEntries()) {
        if (deployComp.hasActiveStandbySyncthing()) {
          identifier = deployComp.identifier;
          appId = dockerService.getAppIdentifier(identifier);
          needsToBeChecked = true;
          break;
        }
      }
      if (needsToBeChecked) {
        // operator explicitly stopped this g: component; don't elect or act on it
        // eslint-disable-next-line no-await-in-loop
        if (await appsRuntimeState.isOperatorStopped(identifier)) {
          // eslint-disable-next-line no-continue
          continue;
        }
        // Get master IP from FDM using the new /appips endpoint
        // eslint-disable-next-line no-await-in-loop
        const fdmResult = await getMasterIpFromFdm(appName, axiosOptions);
        const { ip } = fdmResult;
        fdmOk = fdmResult.fdmOk;

        if (!fdmOk) {
          log.warn(`activeStandby: All FDM services failed for app:${appName}, skipping primary selection for this cycle`);
          // eslint-disable-next-line no-continue
          continue;
        }
        if (fdmOk) {
          // no ip means there was no row with ip on fdm
          // down means there was a row ip with status down
          // eslint-disable-next-line no-await-in-loop
          let localSocketAddr;
          try {
            // eslint-disable-next-line no-await-in-loop
            localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
          } catch (error) {
            log.error(`activeStandby: Failed to get my IP for app:${appName}, error: ${error.message}`);
            // eslint-disable-next-line no-continue
            continue;
          }
          if (localSocketAddr) {
            // Validate ip is a string if it exists
            if (ip && typeof ip !== 'string') {
              log.error(`activeStandby: Invalid IP type from FDM for app:${appName}, got: ${typeof ip}`);
              // eslint-disable-next-line no-continue
              continue;
            }
            if ((!ip)) {
              log.info(`activeStandby: app:${appName} has currently no primary set`);
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
                          log.info(`activeStandby: app:${appName} folder is already in sendreceive mode, treating as ready`);
                          isReady = true;
                          break;
                        }
                      }
                    }
                  } catch (error) {
                    log.error(`activeStandby: Failed to check syncthing folder status for ${appName}: ${error.message}`);
                  }
                }

                if (!isReady) {
                  log.info(`activeStandby: app:${appName} is not ready yet (syncthing not synced), skipping primary selection for this cycle`);
                  // eslint-disable-next-line global-require
                  // eslint-disable-next-line no-continue
                  continue;
                }
                // eslint-disable-next-line no-await-in-loop
                const runningAppList = await registryManager.appLocation(appName);
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
                const index = runningAppList.findIndex((x) => ipsMatch(x.ip, localSocketAddr));

                // Helper function to check if any lower-index nodes are running the app
                const checkLowerIndexNodesRunning = async () => {
                  if (index <= 0) return false; // Index 0 or not found, no lower nodes to check

                  const { CancelToken } = axios;
                  const timeout = 10 * 1000;

                  // Check all nodes with lower index
                  for (let i = 0; i < index; i += 1) {
                    const nodeToCheck = runningAppList[i];
                    if (!nodeToCheck) continue;

                    const ipToCheck = extractIp(nodeToCheck.ip);
                    const portToCheck = extractPort(nodeToCheck.ip);
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
                      // Match on the active-standby component identifier, not the app name: sibling
                      // components (e.g. a DB cluster component) run on every node and must not be
                      // mistaken for the active-standby component being active there.
                      if (appsRunning.find((app) => app.Names[0].includes(identifier))) {
                        log.info(`activeStandby: component:${identifier} is running on lower-index node (index ${i}) at ${ipToCheck}, will not start`);
                        return true;
                      }
                    } catch (error) {
                      isResolved = true;
                      log.info(`activeStandby: Failed to check lower-index node ${i} at ${ipToCheck} for app:${appName}, error: ${error.message}`);
                      // Continue checking other nodes
                    }
                  }
                  return false;
                };

                if (index === 0 && !activePrimaryByIdentifier.has(identifier)) {
                  // Index 0: Start immediately if no history
                  promoteApplicationToPrimary(identifier, appId);
                  log.info(`activeStandby: starting docker component:${identifier} index: ${index}`);
                } else if (!scheduledPrimaryStart.has(identifier) && activePrimaryByIdentifier.has(identifier) && !ipsMatch(activePrimaryByIdentifier.get(identifier), localSocketAddr)) {
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
                  const previousMasterIp = activePrimaryByIdentifier.get(identifier);
                  // Look up the correct port from runningAppList since FDM API returns IP without port
                  const previousMasterNode = runningAppList.find((x) => ipsMatch(x.ip, previousMasterIp));
                  const ipToCheckAppRunning = extractIp(previousMasterIp);
                  const portToCheckAppRunning = previousMasterNode ? extractPort(previousMasterNode.ip) : DEFAULT_API_PORT;
                  let previousMasterStillRunning = false;
                  try {
                    // eslint-disable-next-line no-await-in-loop
                    const response = await axios.get(`http://${ipToCheckAppRunning}:${portToCheckAppRunning}/apps/listrunningapps`, { timeout, cancelToken: source.token });
                    isResolved = true;
                    const appsRunning = response.data.data;
                    // Match on the active-standby component identifier, not the app name: sibling
                    // components running on the previous primary must not be mistaken for the
                    // active-standby component still being active there.
                    if (appsRunning.find((app) => app.Names[0].includes(identifier))) {
                      log.info(`activeStandby: component:${identifier} is not on fdm but previous master is running it at: ${ipToCheckAppRunning}:${portToCheckAppRunning}`);
                      previousMasterStillRunning = true;
                    }
                  } catch (error) {
                    log.info(`activeStandby: Failed to reach previous master at ${ipToCheckAppRunning}:${portToCheckAppRunning} for app:${appName}, will proceed with primary selection. Error: ${error.message}`);
                    isResolved = true;
                  }
                  if (previousMasterStillRunning) {
                    return;
                  }
                  // Previous master is not running, determine next primary
                  if (index === 0) {
                    promoteApplicationToPrimary(identifier, appId);
                    log.info(`activeStandby: starting docker component:${identifier} index: ${index}`);
                  } else {
                    const previousMasterIndex = runningAppList.findIndex((x) => ipsMatch(x.ip, activePrimaryByIdentifier.get(identifier)));
                    let timetoStartApp = Date.now();
                    if (previousMasterIndex >= 0) {
                      log.info(`activeStandby: app:${appName} had primary running at index: ${previousMasterIndex}`);
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
                        promoteApplicationToPrimary(identifier, appId);
                        log.info(`activeStandby: starting docker component:${identifier} index: ${index}`);
                      }
                    } else {
                      log.info(`activeStandby: will start docker app:${appName} at ${timetoStartApp.toString()}`);
                      scheduledPrimaryStart.set(identifier, timetoStartApp);
                    }
                  }
                } else if (scheduledPrimaryStart.has(identifier) && scheduledPrimaryStart.get(identifier) <= Date.now()) {
                  // Scheduled start time has arrived, check if lower-index nodes are running
                  // eslint-disable-next-line no-await-in-loop
                  const lowerNodeRunning = await checkLowerIndexNodesRunning();
                  if (!lowerNodeRunning) {
                    promoteApplicationToPrimary(identifier, appId);
                    log.info(`activeStandby: starting docker component:${identifier} index: ${index} that was scheduled to start at ${scheduledPrimaryStart.get(identifier).toString()}`);
                    scheduledPrimaryStart.delete(identifier);
                  } else {
                    log.info(`activeStandby: not starting app:${appName} index: ${index} - lower-index node is already running`);
                    scheduledPrimaryStart.delete(identifier);
                  }
                } else if (index > 0 && !activePrimaryByIdentifier.has(identifier) && !scheduledPrimaryStart.has(identifier)) {
                  // Non-primary node with no history - schedule start based on index
                  const timetoStartApp = Date.now() + (index * 3 * 60 * 1000);
                  log.info(`activeStandby: scheduling app:${appName} index: ${index} to start at ${timetoStartApp.toString()}`);
                  scheduledPrimaryStart.set(identifier, timetoStartApp);
                } else {
                  // All other cases: don't start
                  log.info(`activeStandby: not starting app:${appName} index: ${index} - conditions not met for primary selection`);
                }
              }
            } else {
              activePrimaryByIdentifier.set(identifier, ip);
              if (scheduledPrimaryStart.has(identifier)) {
                log.info(`activeStandby: app:${appName} removed from scheduledPrimaryStart cache, already started on another standby node`);
                scheduledPrimaryStart.delete(identifier);
              }
              if (!ipsMatch(localSocketAddr, ip) && runningAppsNames.includes(identifier)) {
                // Stop only the active-standby component on this standby node. Sibling components
                // (e.g. a DB cluster component that needs all instances running) must keep running.
                appReconciler.setControllerDesired(identifier, 'stopped', 'masterSlave standby');
                log.info(`activeStandby: stopping docker component:${identifier} it's running on ip:${ip} and localSocketAddr is: ${localSocketAddr}`);
              } else if (ipsMatch(localSocketAddr, ip) && !runningAppsNames.includes(identifier)) {
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
                          log.info(`activeStandby: app:${appName} folder is already in sendreceive mode, treating as ready`);
                          isReady = true;
                          break;
                        }
                      }
                    }
                  } catch (error) {
                    log.error(`activeStandby: Failed to check syncthing folder status for ${appName}: ${error.message}`);
                  }
                }

                if (isReady) {
                  promoteApplicationToPrimary(identifier, appId);
                  log.info(`activeStandby: starting docker component:${identifier}`);
                } else {
                  log.info(`activeStandby: app:${appName} is registered as primary on FDM but not ready yet (syncthing not synced), skipping start for this cycle`);
                }
              }
            }
          }
        }
      }
    }
  } catch (error) {
    log.error(`activeStandby: ${error}`);
  } finally {
    globalState.activeStandbyCoordinationRunning = false;
    await serviceHelper.delay(config.fluxapps.masterSlaveIntervalMs ?? 30 * 1000);
    coordinateActiveStandbyApps();
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
  redeployComponent,
  redeployApplication,
  redeployApplicationAPI,
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
  reconcileInstalledApps,
  shutdownPlanResync,
  forceAppRemovals,
  coordinateActiveStandbyApps,
  getPeerAppsInstallingErrorMessages,
  startApplication,
  stopApplication,
  restartApplication,
};
