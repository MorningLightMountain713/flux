// Syncthing Monitor - Manages syncthing configuration for apps
const config = require('config');
const dbHelper = require('../dbHelper');
// eslint-disable-next-line no-unused-vars
const serviceHelper = require('../serviceHelper');
const dockerService = require('../dockerService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const syncthingService = require('../syncthingService');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const { appsFolder } = require('../utils/appConstants');
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

// Global collections
const globalAppsLocations = config.database.appsglobal.collections.appsLocations;

/**
 * Check if app folders are properly mounted
 * Returns list of apps whose folders are not mounted yet
 * Uses verifyFolderMountSafety to detect folders that exist but aren't properly mounted
 * @param {Array} appsInstalled - List of installed apps
 * @returns {Promise<Array>} List of apps with unmounted folders
 */
async function checkAppFolderMounts(deployments) {
  const unmountedApps = [];

  // eslint-disable-next-line no-restricted-syntax
  for (const deployment of deployments) {
    for (const [, deployComp] of deployment.componentEntries()) {
      const appId = dockerService.getAppIdentifier(deployComp.identifier);
      const appFolder = `${appsFolder}${appId}`;
      // eslint-disable-next-line no-await-in-loop
      const mountSafety = await verifyFolderMountSafety(appId, appFolder);
      if (!mountSafety.isSafe) {
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
async function processComponentSync(params) {
  const {
    syncMode,
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
    appDockerStopFn,
    appDockerRestartFn,
    appDeleteDataInMountPointFn,
  } = params;

  if (!syncMode) {
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

  if (syncMode === 'receiveOnly' || syncMode === 'activeStandby') {
    const { syncthingFolder: updatedFolder, cache, skipProcessing } = await manageFolderSyncState({
      appId,
      syncFolder,
      syncMode,
      syncthingAppsFirstRun: state.syncthingAppsFirstRun,
      receiveOnlySyncthingAppsCache: state.receiveOnlySyncthingAppsCache,
      appLocation,
      localSocketAddr,
      appDockerStopFn,
      appDockerRestartFn,
      appDeleteDataInMountPointFn,
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
 * @param {Function} installedAppsFn - Get installed apps function
 * @param {Function} getGlobalStateFn - Get global state function
 * @param {Function} appDockerStopFn - Stop docker function
 * @param {Function} appDockerRestartFn - Restart docker function
 * @param {Function} appDeleteDataInMountPointFn - Delete data function
 * @returns {Promise<void>}
 */
async function syncthingAppsCore(state, getGlobalStateFn, appDockerStopFn, appDockerRestartFn, appDeleteDataInMountPointFn) {
  // Sync global state before checking
  getGlobalStateFn();

  // Early return if operations in progress
  if (state.installationInProgress || state.removalInProgress || state.softRedeployInProgress || state.hardRedeployInProgress || state.updateSyncthingRunning) {
    return;
  }

  state.updateSyncthingRunning = true;
  let syncthingInitializedSuccessfully = false;

  try {
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
        log.error(`syncthingAppsCore - STARTUP WARNING: ${unsafeFoldersCount} folders had unsafe mounts and were switched to receiveonly mode. Check loop mounts!`);
        // Restart Syncthing to apply the receiveonly changes immediately
        await syncthingService.systemRestart().catch((err) => {
          log.error(`syncthingAppsCore - Failed to restart Syncthing after safety switch: ${err.message}`);
        });
        // Wait for Syncthing to restart before continuing
        await serviceHelper.delay(5000);
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
      appDockerStopFn,
      appDockerRestartFn,
      appDeleteDataInMountPointFn,
    };

    // Process all installed apps
    // eslint-disable-next-line no-restricted-syntax
    for (const deployment of deployments) {
      const backupSkip = state.backupInProgress.some((item) => deployment.appName === item);
      const restoreSkip = state.restoreInProgress.some((item) => deployment.appName === item);

      if (backupSkip || restoreSkip) {
        log.info(`syncthingAppsCore - Backup/restore in progress for ${deployment.appName}, syncthing disabled`);
        // eslint-disable-next-line no-continue
        continue;
      }

      for (const [, deployComp] of deployment.componentEntries()) {
        // eslint-disable-next-line no-await-in-loop
        await processComponentSync({
          ...sharedParams,
          syncMode: deployComp.sync?.mode || null,
          identifier: deployComp.identifier,
          installedAppName: deployment.appName,
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
        const healthResults = await monitorFolderHealth({
          foldersConfiguration,
          folderHealthCache: state.folderHealthCache,
          appDockerStopFn,
          // route health-monitor starts through the reconciler too (the injected
          // appDockerRestartFn is the reconciler-backed start wrapper)
          appDockerStartFn: appDockerRestartFn,
          state,
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
 * @param {Function} installedAppsFn - Get installed apps function
 * @param {Function} getGlobalStateFn - Get global state function
 * @param {Function} appDockerStopFn - Stop docker function
 * @param {Function} appDockerRestartFn - Restart docker function
 * @param {Function} appDeleteDataInMountPointFn - Delete data function
 * @returns {Object} Control object with stop() method
 */
function syncthingApps(state, getGlobalStateFn, appDockerStopFn, appDockerRestartFn, appDeleteDataInMountPointFn) {
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
        appDockerStopFn,
        appDockerRestartFn,
        appDeleteDataInMountPointFn,
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

  // Then run at regular intervals
  intervalId = setInterval(runMonitoring, MONITOR_INTERVAL_MS);

  // Return control object for graceful shutdown
  return {
    stop: () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
        log.info('syncthingApps - Monitoring service stopped');
      }
    },
    isActive: () => intervalId !== null,
  };
}

module.exports = {
  syncthingApps,
};
