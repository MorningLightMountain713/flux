// Syncthing Monitor - Manages syncthing configuration for apps
const path = require('node:path');
const config = require('config');
const dbHelper = require('../dbHelper');
// eslint-disable-next-line no-unused-vars
const serviceHelper = require('../serviceHelper');
const dockerService = require('../dockerService');
const operationRegistry = require('../utils/operationRegistry');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const syncthingService = require('../syncthingService');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const log = require('../../lib/log');
const {
  MONITOR_INTERVAL_MS,
  // eslint-disable-next-line no-unused-vars
  ERROR_RETRY_DELAY_MS,
  SYNC_STATE_LOG_INTERVAL_MS,
  HEALTH_CHECK_INTERVAL_MS,
} = require('./syncthingMonitorConstants');
const {
  sortAndFilterLocations,
  buildDeviceConfiguration,
  createSyncthingFolderConfig,
  ensureStfolderExists,
  folderNeedsUpdate,
} = require('./syncthingMonitorHelpers');
const {
  manageFolderSyncState,
  verifyFolderMountSafety,
  isPathMounted,
} = require('./syncthingFolderStateMachine');
const {
  monitorFolderHealth,
} = require('./syncthingHealthMonitor');
const syncthingEventsConsumer = require('./syncthingEventsConsumer');

// Global collections
const globalAppsLocations = config.database.appsglobal.collections.appsLocations;

// Path constants
const fluxDirPath = process.env.FLUXOS_PATH || path.join(process.env.HOME, 'zelflux');
const appsFolderPath = process.env.FLUX_APPS_FOLDER || path.join(fluxDirPath, 'ZelApps');
const appsFolder = `${appsFolderPath}/`;

/**
 * Check if app folders are properly mounted
 * Returns list of apps whose folders are not mounted yet
 * Uses verifyFolderMountSafety to detect folders that exist but aren't properly mounted
 * @param {Array} deployments - Installed app deployments
 * @returns {Promise<Array>} List of apps with unmounted folders
 */
async function checkAppFolderMounts(deployments) {
  const unmountedApps = [];

  // eslint-disable-next-line no-restricted-syntax
  for (const deployment of deployments) {
    // eslint-disable-next-line no-restricted-syntax
    for (const [, deployComp] of deployment.componentEntries()) {
      // deployComp.identifier is the docker-style id - bare appName for flat
      // (v1-3) specs, comp_app for composed (v4+) - so no version branching here.
      const appId = dockerService.getAppIdentifier(deployComp.identifier);
      const appFolder = `${appsFolder}${appId}`;
      // eslint-disable-next-line no-await-in-loop
      const mountSafety = await verifyFolderMountSafety(appId, appFolder);
      if (!mountSafety.isSafe) {
        // Folder exists but mount is not safe (empty and not mounted - likely unmounted loop device)
        unmountedApps.push({ appId, appName: deployment.appName, reason: mountSafety.reason });
      }
    }
  }

  return unmountedApps;
}

// Helper function to get app locations
async function appLocation(appName) {
  try {
    const db = dbHelper.databaseConnection();
    const database = db.db(config.database.appsglobal.database);
    const query = { name: appName };
    const projection = { _id: 0 };
    const results = await dbHelper.findInDatabase(database, globalAppsLocations, query, projection);
    return results || [];
  } catch (error) {
    log.error(`Error getting app location for ${appName}: ${error.message}`);
    return [];
  }
}

/**
 * Process container data for an app component
 * This function handles both legacy apps (version <= 3) and newer apps (version > 3)
 *
 * @param {Object} params - Parameters object
 * @returns {Promise<void>}
 */
async function processContainerData(params) {
  const {
    deployComp,
    identifier,
    installedAppName,
    localSocketAddr,
    localDeviceId,
    state,
    allFoldersResp,
    allDevicesResp,
    devicesConfiguration,
    devicesIds,
    folderIds,
    foldersConfiguration,
    newFoldersConfiguration,
  } = params;

  // Only syncthing-enabled components need folder management. In v9 a sync mode
  // is minted only for activeStandby (g:) and syncFirst (r:), so hasSyncthing()
  // is exactly the old requiresSyncing() gate.
  if (!deployComp.hasSyncthing()) {
    return;
  }

  // Sync the entire appId folder (not individual mount points)
  // This ensures all subdirectories (appdata, logs, config, etc.) are synced together
  const appId = dockerService.getAppIdentifier(identifier);
  const folder = `${appsFolder}${appId}`;
  const id = appId;
  const label = appId;

  // Ensure .stfolder directory exists at appId level
  await ensureStfolderExists(folder);

  // Get and process app locations
  let locations = await appLocation(installedAppName);
  locations = sortAndFilterLocations(locations, localSocketAddr);

  // Build device configuration (parallelized internally)
  const devices = await buildDeviceConfiguration(
    locations,
    localSocketAddr,
    localDeviceId,
    state.syncthingDevicesIDCache,
    devicesConfiguration,
    devicesIds,
    allDevicesResp,
  );

  // Create base folder configuration
  const syncthingFolder = createSyncthingFolderConfig(id, label, folder, devices);
  const syncFolder = allFoldersResp.data.find((x) => x.id === id);

  // activeStandby (the election decides which instance runs) and syncFirst (the
  // sync-readiness decider starts it once data is complete) are the decider-owned
  // modes that drive the folder state machine.
  if (deployComp.requiresSyncBeforeStart() || deployComp.hasActiveStandbySyncthing()) {
    // Use state machine to manage folder sync transitions
    const { syncthingFolder: updatedFolder, cache, skipProcessing } = await manageFolderSyncState({
      appId,
      syncFolder,
      requiresSyncBeforeStart: deployComp.requiresSyncBeforeStart(),
      syncthingAppsFirstRun: state.syncthingAppsFirstRun,
      receiveOnlySyncthingAppsCache: state.receiveOnlySyncthingAppsCache,
      appLocation,
      localSocketAddr,
      syncthingFolder,
      installedAppName,
    });

    // Update cache if provided
    if (cache !== null) {
      state.receiveOnlySyncthingAppsCache.set(appId, cache);
    }

    // Skip processing if marked to skip
    if (skipProcessing) {
      return;
    }

    // Update folder with state machine result
    Object.assign(syncthingFolder, updatedFolder);
  }

  // Add to tracking arrays
  folderIds.push(id);
  foldersConfiguration.push(syncthingFolder);

  // Check if folder needs update
  if (folderNeedsUpdate(syncFolder, syncthingFolder)) {
    newFoldersConfiguration.push(syncthingFolder);
  }
}

/**
 * Log sync state for all folders
 * @param {Array} foldersConfiguration - Array of folder configurations
 * @returns {Promise<void>}
 */
async function logSyncState(foldersConfiguration) {
  if (!foldersConfiguration || foldersConfiguration.length === 0) {
    log.info('syncthingAppsCore - No folders to log sync state for');
    return;
  }

  log.info(`syncthingAppsCore - Logging sync state for ${foldersConfiguration.length} folders`);

  // Get sync status for all folders in parallel
  const syncStatusPromises = foldersConfiguration.map(async (folder) => {
    try {
      const statusResponse = await syncthingService.getDbStatus({
        query: { folder: folder.id },
      }, null);

      if (statusResponse && statusResponse.status === 'success') {
        const { globalBytes = 0, inSyncBytes = 0, state: syncState } = statusResponse.data;
        const syncPercentage = globalBytes > 0 ? (inSyncBytes / globalBytes) * 100 : 100;

        return {
          id: folder.id,
          type: folder.type,
          syncPercentage,
          globalBytes,
          inSyncBytes,
          state: syncState,
        };
      }

      return {
        id: folder.id,
        type: folder.type,
        error: 'Failed to get status',
      };
    } catch (error) {
      return {
        id: folder.id,
        type: folder.type,
        error: error.message,
      };
    }
  });

  const syncStatuses = await Promise.all(syncStatusPromises);

  // Log each folder's sync state
  syncStatuses.forEach((status) => {
    if (status.error) {
      log.warn(`syncthingAppsCore - Folder ${status.id} (${status.type}): Error - ${status.error}`);
    } else {
      const bytesInfo = status.globalBytes > 0
        ? ` (${status.inSyncBytes}/${status.globalBytes} bytes)`
        : '';
      log.info(
        `syncthingAppsCore - Folder ${status.id} (${status.type}): `
        + `${status.syncPercentage.toFixed(2)}% synced, state: ${status.state}${bytesInfo}`,
      );
    }
  });
}

/**
 * Core function to process all installed apps and configure Syncthing
 * @param {object} state - State object
 * @param {Function} getGlobalStateFn - Get global state function
 * @returns {Promise<void>}
 */
async function syncthingAppsCore(state, getGlobalStateFn) {
  // Sync global state before checking
  getGlobalStateFn();

  // The cycle rebuilds the global folder set and prunes folders no longer backing
  // an installed app, so it must not run while any app's folder set is changing.
  // Node-wide for those operation classes (NOT backup/restore - those are handled
  // per-app below so one app's backup never freezes the whole sweep). The
  // updateSyncthingRunning re-entrancy guard is unchanged.
  if (operationRegistry.anyHeldOfType('install', 'remove', 'softRedeploy', 'hardRedeploy', 'reconcile') || state.updateSyncthingRunning) {
    return;
  }

  state.updateSyncthingRunning = true;
  let syncthingInitializedSuccessfully = false;

  try {
    // Installed app deployments, resolved (and decrypted for enterprise apps)
    // through the domain provider - no version branching, no separate decrypt.
    const deployments = await deploymentProvider.listInstalledDeployments();

    // CRITICAL: Check if app folder mounts are ready before processing
    // This prevents syncthing operations when loop devices aren't mounted after reboot
    const unmountedApps = await checkAppFolderMounts(deployments);
    if (unmountedApps.length > 0) {
      const unmountedList = unmountedApps.map((app) => app.appId).join(', ');
      log.warn(`syncthingAppsCore - Skipping processing: ${unmountedApps.length} app folders not mounted yet: ${unmountedList}`);
      log.warn('syncthingAppsCore - Waiting for app folders to be mounted before syncthing processing');
      return;
    }

    // Get required IDs and configurations
    const localDeviceId = await syncthingService.getDeviceId();
    if (!localDeviceId) {
      log.error('syncthingAppsCore - Failed to get localDeviceId');
      return;
    }

    const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
    if (!localSocketAddr) {
      log.error('syncthingAppsCore - Failed to get localSocketAddr');
      return;
    }

    // Get current Syncthing configuration
    const allFoldersResp = await syncthingService.getConfigFolders();
    const allDevicesResp = await syncthingService.getConfigDevices();

    // CRITICAL: Validate Syncthing configuration is loaded before proceeding
    // On system restart, Syncthing API might be available but config not fully loaded
    // This prevents data deletion during the race condition window
    if (!allFoldersResp || !allFoldersResp.data || !Array.isArray(allFoldersResp.data)) {
      if (state.syncthingAppsFirstRun) {
        log.warn('syncthingAppsCore - Syncthing folder configuration not ready yet on first run. Waiting for next cycle to avoid data loss.');
      } else {
        log.error('syncthingAppsCore - Failed to get Syncthing folders configuration');
      }
      return;
    }

    if (!allDevicesResp || !allDevicesResp.data || !Array.isArray(allDevicesResp.data)) {
      if (state.syncthingAppsFirstRun) {
        log.warn('syncthingAppsCore - Syncthing device configuration not ready yet on first run. Waiting for next cycle to avoid data loss.');
      } else {
        log.error('syncthingAppsCore - Failed to get Syncthing devices configuration');
      }
      return;
    }

    // Mark that Syncthing is properly initialized - safe to clear first run flag
    syncthingInitializedSuccessfully = true;

    // CRITICAL STARTUP SAFETY CHECK: Verify all sendreceive folders have safe mounts
    // This prevents data loss when loop mounts aren't ready after reboot
    if (state.syncthingAppsFirstRun && allFoldersResp.data.length > 0) {
      log.info('syncthingAppsCore - First run detected, performing mount safety verification on existing folders');
      let unsafeFoldersCount = 0;

      // eslint-disable-next-line no-restricted-syntax
      for (const folder of allFoldersResp.data) {
        if (folder.type === 'sendreceive') {
          // Extract appId from folder.id (e.g., fluxwp_myapp -> fluxwp_myapp)
          const appId = folder.id;
          const folderPath = folder.path;

          // eslint-disable-next-line no-await-in-loop
          const mountSafety = await verifyFolderMountSafety(appId, folderPath);

          if (!mountSafety.isSafe) {
            unsafeFoldersCount += 1;
            log.error(`syncthingAppsCore - STARTUP SAFETY: Folder ${appId} has unsafe mount (${mountSafety.reason}). Switching to receiveonly to prevent data loss.`);

            // Immediately switch to receiveonly mode
            // eslint-disable-next-line no-await-in-loop
            await syncthingService.adjustConfigFolders('patch', { type: 'receiveonly' }, folder.id).catch((err) => {
              log.error(`syncthingAppsCore - Failed to switch ${folder.id} to receiveonly: ${err.message}`);
            });
          } else {
            log.info(`syncthingAppsCore - Folder ${appId} mount is safe (mounted=${mountSafety.isMounted}, files=${mountSafety.fileCount})`);
          }
        }
      }

      if (unsafeFoldersCount > 0) {
        // The receiveonly PATCH applies live (no restart needed on syncthing v2) -
        // a process restart here would drop every folder's transfers node-wide.
        log.error(`syncthingAppsCore - STARTUP WARNING: ${unsafeFoldersCount} folders had unsafe mounts and were switched to receiveonly mode. Check loop mounts!`);
      }
    }

    // Initialize tracking arrays
    const devicesIds = [];
    const devicesConfiguration = [];
    const folderIds = [];
    const foldersConfiguration = [];
    const newFoldersConfiguration = [];

    // Shared parameters for processing
    const sharedParams = {
      localSocketAddr,
      localDeviceId,
      state,
      allFoldersResp,
      allDevicesResp,
      devicesConfiguration,
      devicesIds,
      folderIds,
      foldersConfiguration,
      newFoldersConfiguration,
    };

    // Process every component of every installed app. componentEntries() and
    // deployComp.identifier are polymorphic over the spec version, so there is
    // no v1-3-vs-v4+ branching here.
    // eslint-disable-next-line no-restricted-syntax
    for (const deployment of deployments) {
      const { appName } = deployment;
      // Skip this app if it holds any operation lease (per-app). A backup/restore
      // already removed its syncthing folder, so processing it would wrongly
      // re-add it; folding in the other lease types defers it during any operation
      // on it. Its folders are simply left untouched this cycle.
      if (operationRegistry.isHeld(appName)) {
        log.info(`syncthingAppsCore - operation in progress for ${appName}, syncthing skipped this cycle`);
        // eslint-disable-next-line no-continue
        continue;
      }

      // eslint-disable-next-line no-restricted-syntax
      for (const [, deployComp] of deployment.componentEntries()) {
        // eslint-disable-next-line no-await-in-loop
        await processContainerData({
          ...sharedParams,
          deployComp,
          identifier: deployComp.identifier,
          installedAppName: appName,
        });
      }
    }

    // Remove unused folders and devices (parallelized for better performance)
    const nonUsedFolders = allFoldersResp.data.filter(
      (syncthingFolder) => !folderIds.includes(syncthingFolder.id),
    );
    const nonUsedDevices = allDevicesResp.data.filter(
      (syncthingDevice) => !devicesIds.includes(syncthingDevice.deviceID) && syncthingDevice.deviceID !== localDeviceId,
    );

    // Parallelize cleanup operations
    const cleanupPromises = [
      ...nonUsedFolders.map((folder) => {
        log.info(`syncthingAppsCore - Removing unused Syncthing folder ${folder.id}`);
        return syncthingService.adjustConfigFolders('delete', undefined, folder.id).catch((err) => {
          log.error(`Failed to remove folder ${folder.id}: ${err.message}`);
        });
      }),
      ...nonUsedDevices.map((device) => {
        log.info(`syncthingAppsCore - Removing unused Syncthing device ${device.deviceID}`);
        return syncthingService.adjustConfigDevices('delete', undefined, device.deviceID).catch((err) => {
          log.error(`Failed to remove device ${device.deviceID}: ${err.message}`);
        });
      }),
    ];

    await Promise.all(cleanupPromises);

    // Apply new configuration
    if (devicesConfiguration.length > 0) {
      await syncthingService.adjustConfigDevices('put', devicesConfiguration);
    }
    if (newFoldersConfiguration.length > 0) {
      await syncthingService.adjustConfigFolders('put', newFoldersConfiguration);
    }

    // Check for folder errors in parallel
    const folderErrorChecks = await Promise.all(
      foldersConfiguration.map(async (folder) => {
        try {
          const folderError = await syncthingService.getFolderIdErrors(folder.id);
          if (folderError?.status === 'success' && folderError.data.errors?.length > 0) {
            return { folder, error: folderError };
          }
        } catch (error) {
          log.warn(`Failed to check errors for folder ${folder.id}: ${error.message}`);
        }
        return null;
      }),
    );

    // Process folder errors sequentially (app removal requires sequential processing)
    // eslint-disable-next-line no-restricted-syntax
    for (const errorInfo of folderErrorChecks) {
      // eslint-disable-next-line no-continue
      if (!errorInfo) continue;

      const { folder, error } = errorInfo;
      log.error(`syncthingAppsCore - Errors detected on syncthing folderId:${folder.id}`);
      log.error(error);
    }

    // Log sync state every 5 minutes
    const now = Date.now();
    if (!state.lastSyncStateLogTime || (now - state.lastSyncStateLogTime >= SYNC_STATE_LOG_INTERVAL_MS)) {
      await logSyncState(foldersConfiguration);
      state.lastSyncStateLogTime = now;
    }

    // Run health monitoring every HEALTH_CHECK_INTERVAL_MS
    // This checks for isolated nodes, connectivity issues, and takes corrective actions
    if (!state.lastHealthCheckTime || (now - state.lastHealthCheckTime >= HEALTH_CHECK_INTERVAL_MS)) {
      log.info('syncthingAppsCore - Running periodic health check');
      try {
        // The health monitor is a watchdog only: it alerts and nudges folder
        // devices - it takes no container or app-lifecycle actions
        const healthResults = await monitorFolderHealth({
          foldersConfiguration,
          folderHealthCache: state.folderHealthCache,
          receiveOnlySyncthingAppsCache: state.receiveOnlySyncthingAppsCache,
        });

        if (healthResults.actions.length > 0) {
          log.warn(`syncthingAppsCore - Health monitoring took ${healthResults.actions.length} corrective action(s)`);
          healthResults.actions.forEach((action) => {
            log.warn(`  - ${action.action.toUpperCase()} ${action.folderId}: ${action.reason} (${action.durationMinutes.toFixed(0)} min)`);
          });
        }

        state.lastHealthCheckTime = now;
      } catch (healthError) {
        log.error(`syncthingAppsCore - Health monitoring error: ${healthError.message}`);
      }
    }

    // Check if Syncthing restart is needed
    const restartRequired = await syncthingService.getConfigRestartRequired();
    if (restartRequired?.status === 'success' && restartRequired.data.requiresRestart === true) {
      log.info('syncthingAppsCore - New configuration applied. Syncthing restart required, restarting...');
      await syncthingService.systemRestart();
    }
  } catch (error) {
    log.error(`syncthingAppsCore - Error in sync monitoring: ${error.message}`);
    log.error(error.stack);
  } finally {
    state.updateSyncthingRunning = false;
    // Only clear first run flag if Syncthing was successfully initialized
    // This ensures we don't proceed with app processing until Syncthing is fully ready
    if (syncthingInitializedSuccessfully) {
      state.syncthingAppsFirstRun = false;
    }
  }
}

/**
 * Starts the Syncthing monitoring service with interval-based scheduling
 * Replaces the old recursive approach with a proper interval
 *
 * @param {object} state - State object
 * @param {Function} getGlobalStateFn - Get global state function
 * @returns {Object} Control object with stop() method
 */
function syncthingApps(state, getGlobalStateFn) {
  let intervalId = null;
  let isRunning = false;

  const runMonitoring = async () => {
    if (isRunning) {
      log.warn('syncthingApps - Previous execution still running, skipping this iteration');
      return;
    }

    isRunning = true;
    try {
      await syncthingAppsCore(
        state,
        getGlobalStateFn,
      );
    } catch (error) {
      log.error(`syncthingApps - Unexpected error in monitoring loop: ${error.message}`);
      log.error(error.stack);
    } finally {
      isRunning = false;
    }
  };

  // Run immediately on start
  runMonitoring();

  // Then run at regular intervals (the LEVEL: ground truth, self-healing)
  intervalId = setInterval(runMonitoring, MONITOR_INTERVAL_MS);

  // Edge accelerator: syncthing folder events trigger an early run of the SAME
  // monitoring pass the interval drives - events never carry decisions. Debounced
  // so an event burst coalesces into one evaluation; if the stream dies, behavior
  // degrades to the interval cadence (latency, never correctness).
  let earlyEvaluationTimer = null;
  const requestEarlyEvaluation = () => {
    if (earlyEvaluationTimer) return;
    earlyEvaluationTimer = setTimeout(() => {
      earlyEvaluationTimer = null;
      runMonitoring();
    }, 2000);
  };
  syncthingEventsConsumer.start({
    onFolderActivity: () => requestEarlyEvaluation(),
    onResync: () => requestEarlyEvaluation(),
  });

  // Return control object for graceful shutdown
  return {
    stop: () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
        if (earlyEvaluationTimer) {
          clearTimeout(earlyEvaluationTimer);
          earlyEvaluationTimer = null;
        }
        syncthingEventsConsumer.stop();
        log.info('syncthingApps - Monitoring service stopped');
      }
    },
    isActive: () => intervalId !== null,
  };
}

module.exports = {
  syncthingApps,
};
