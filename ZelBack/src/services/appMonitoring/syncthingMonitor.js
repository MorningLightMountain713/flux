'use strict';

// Syncthing Monitor - Manages syncthing configuration for apps
const path = require('node:path');
// eslint-disable-next-line no-unused-vars
const serviceHelper = require('../serviceHelper');
const dockerService = require('../dockerService');
const operationRegistry = require('../utils/operationRegistry');
const appCaches = require('../utils/appCaches');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const syncthingService = require('../syncthingService');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const log = require('../../lib/log');
const appsRepository = require('../appDatabase/appsRepository');
const {
  MONITOR_INTERVAL_MS,
  // eslint-disable-next-line no-unused-vars
  ERROR_RETRY_DELAY_MS,
  SYNC_STATE_LOG_INTERVAL_MS,
  HEALTH_CHECK_INTERVAL_MS,
  EARLY_EVAL_DEBOUNCE_MS,
  EARLY_EVAL_MIN_GAP_MS,
} = require('./syncthingMonitorConstants');
const { createMonitorAccelerator } = require('./syncthingMonitorAccelerator');
const {
  sortAndFilterLocations,
  buildDeviceConfiguration,
  createSyncthingFolderConfig,
  ensureStfolderExists,
  folderNeedsUpdate,
} = require('./syncthingMonitorHelpers');
const volumeService = require('../utils/volumeService');
const appReconciler = require('./appReconciler');
const {
  manageFolderSyncState,
  verifyFolderMountSafety,
  verifySendReceiveFolderSafety,
} = require('./syncthingFolderStateMachine');
const {
  monitorFolderHealth,
} = require('./syncthingHealthMonitor');
const syncthingEventsConsumer = require('./syncthingEventsConsumer');

// Global collections

// Path constants
const fluxDirPath = process.env.FLUXOS_PATH || path.join(process.env.HOME, 'zelflux');
const appsFolderPath = process.env.FLUX_APPS_FOLDER || path.join(fluxDirPath, 'ZelApps');
const appsFolder = `${appsFolderPath}/`;

/**
 * Verify one app folder's mount safety, repairing an unmounted volume on the
 * spot (FluxOS owns the mount - the backing image normally still exists, so
 * the actionable response is to mount it, not just to report it).
 * @param {string} appId - Docker app identifier
 * @param {string} appFolder - App folder path
 * @param {string} appName - the app this component belongs to
 * @returns {Promise<{isSafe: boolean, reason: string}>} Result after any repair
 */
async function verifyAppFolderMountWithRepair(appId, appFolder, appName) {
  let mountSafety = await verifyFolderMountSafety(appId, appFolder, appName);
  if (!mountSafety.isSafe && !mountSafety.isMounted) {
    const mountAttempt = await volumeService.ensureAppVolumeMounted(appId);
    if (mountAttempt.mounted) {
      log.info(`checkAppFolderMounts - ${appId} volume was not mounted; mounted it`);
      mountSafety = await verifyFolderMountSafety(appId, appFolder, appName);
    }
  }
  return mountSafety;
}

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
      const mountSafety = await verifyAppFolderMountWithRepair(appId, appFolder, deployment.appName);
      if (!mountSafety.isSafe) {
        // Folder exists but mount is not safe (empty and not mounted - likely unmounted loop device)
        // identifier travels alongside appId: the reconciler is keyed by the bare form
        // and this loop already holds it, so nothing downstream has to recover it.
        unmountedApps.push({
          appId, identifier: deployComp.identifier, appName: deployment.appName, reason: mountSafety.reason,
        });
      }
    }
  }

  return unmountedApps;
}

/**
 * Installed app deployments having at least one component whose docker app
 * identifier is in the given folder-id set (syncthing folder ids ARE the app
 * identifiers). componentEntries()/deployComp.identifier are polymorphic over
 * the spec version, so there is no v1-3-vs-v4+ branching here.
 * @param {Array} deployments - Installed app deployments
 * @param {Set<string>} folderIds - Syncthing folder ids that need verifying
 * @returns {Array} Matching deployments
 */
function deploymentsMatchingFolderIds(deployments, folderIds) {
  if (folderIds.size === 0) return [];
  return deployments.filter((deployment) => {
    // eslint-disable-next-line no-restricted-syntax
    for (const [, deployComp] of deployment.componentEntries()) {
      if (folderIds.has(dockerService.getAppIdentifier(deployComp.identifier))) return true;
    }
    return false;
  });
}

// Where an app is running, for syncthing peer selection and leader election.
// Soft-fails to an empty list: a read failure must leave the folder alone rather
// than reshape its peers off a partial answer.
async function appLocation(appName) {
  try {
    return await appsRepository.appLocationFromEvents({ appname: appName });
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
    erroredFolderIds,
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

  // Ensure .stfolder directory exists at appId level - refused on an
  // unmounted dir (the marker may only ever live inside the volume)
  const markerReady = await ensureStfolderExists(folder);
  if (!markerReady) {
    log.warn(`processContainerData - ${appId} volume not mounted; skipping syncthing configuration this cycle`);
    return;
  }

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
      identifier,
      syncFolder,
      requiresSyncBeforeStart: deployComp.requiresSyncBeforeStart(),
      isActiveStandby: deployComp.hasActiveStandbySyncthing(),
      syncthingAppsFirstRun: state.syncthingAppsFirstRun,
      receiveOnlySyncthingAppsCache: state.receiveOnlySyncthingAppsCache,
      appLocation,
      localSocketAddr,
      syncthingFolder,
      installedAppName,
      mountVerifyNeeded: state.syncthingAppsFirstRun || erroredFolderIds.has(appId),
      // Injected content is written by content delivery on every node and
      // .stignore'd, so the disk-emptiness walks must not count it as synced
      // payload (a fresh volume holding only delivered files is still empty).
      injectedExcludePaths: deployComp.injectedSyncExcludes(),
    });

    // Update cache if provided
    if (cache !== null) {
      await appCaches.setSyncedMark(state.receiveOnlySyncthingAppsCache, appId, cache);
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
  if (operationRegistry.anyHeldOfType('install', 'remove', 'redeploy', 'rebuild', 'reconcile') || state.updateSyncthingRunning) {
    return;
  }

  state.updateSyncthingRunning = true;
  let syncthingInitializedSuccessfully = false;

  try {
    // Installed app deployments, resolved (and decrypted for enterprise apps)
    // through the domain provider - no version branching, no separate decrypt.
    const deployments = await deploymentProvider.listInstalledDeployments();

    // Drain the folders syncthing flagged with errors since the last cycle. Mount
    // safety is verified only at decision points - the first pass after start (the
    // reboot case: loop mounts may not be up yet) and folders syncthing itself
    // flagged - never as a steady-state sweep of every folder. A vanished mount
    // takes the folder's .stfolder marker with it and raises FolderErrors, so the
    // flagged set catches real mount loss without re-walking healthy folders.
    const erroredFolderIds = new Set(syncthingEventsConsumer.drainErroredFolderIds());
    const deploymentsToVerify = state.syncthingAppsFirstRun
      ? deployments
      : deploymentsMatchingFolderIds(deployments, erroredFolderIds);

    // CRITICAL: Check if app folder mounts are ready before processing
    // This prevents syncthing operations when loop devices aren't mounted after reboot
    const unmountedApps = deploymentsToVerify.length > 0
      ? await checkAppFolderMounts(deploymentsToVerify)
      : [];
    if (unmountedApps.length > 0) {
      const unmountedList = unmountedApps.map((app) => app.appId).join(', ');
      log.warn(`syncthingAppsCore - Skipping processing: ${unmountedApps.length} app folders not mounted yet: ${unmountedList}`);
      log.warn('syncthingAppsCore - Waiting for app folders to be mounted before syncthing processing');

      // Never leave an unsafe-mount folder sendreceive while processing is
      // skipped: the syncthing daemon keeps running as configured, so an
      // un-demoted sendreceive folder over a bad mount can still broadcast its
      // (leaked or missing) disk state to the healthy peers. Demote those
      // folders and hold their containers before bailing - idempotent, and the
      // normal receiveonly machinery re-promotes once the mount is healthy.
      const foldersResp = await syncthingService.getConfigFolders();
      const folders = Array.isArray(foldersResp?.data) ? foldersResp.data : [];
      // eslint-disable-next-line no-restricted-syntax
      for (const { appId, identifier, reason } of unmountedApps) {
        const folder = folders.find((f) => f.id === appId);
        if (folder && folder.type === 'sendreceive') {
          log.error(`syncthingAppsCore - SAFETY BLOCK: ${appId} folder is sendreceive over an unsafe mount (${reason}); switching to receiveonly and holding the container`);
          // eslint-disable-next-line no-await-in-loop
          await syncthingService.adjustConfigFolders('patch', { type: 'receiveonly' }, appId).catch((err) => {
            log.error(`syncthingAppsCore - Failed to switch ${appId} to receiveonly: ${err.message}`);
          });
          appReconciler.setControllerDesired(identifier, 'stopped', `mount safety block: ${reason}`);
        }
      }
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

      // This scan walks syncthing's folders, so a folder id is all it starts with.
      // Index the installed components by that id up front: injected-content paths
      // (content delivery rewrites these on every node and .stignore excludes them,
      // so the emptiness walk must skip them too - a content+sync app always has its
      // delivered files on disk right after a reboot, which would otherwise mask a
      // wiped dataset) and the owning app name, which tampering incidents roll up
      // under. A folder no installed component claims stays unresolved rather than
      // being attributed to a guess.
      const componentsByAppId = new Map();
      // eslint-disable-next-line no-restricted-syntax
      for (const deployment of deployments) {
        for (const [, comp] of deployment.componentEntries()) {
          componentsByAppId.set(dockerService.getAppIdentifier(comp.identifier), {
            injectedExcludePaths: comp.injectedSyncExcludes(),
            appName: deployment.appName,
          });
        }
      }

      // eslint-disable-next-line no-restricted-syntax
      for (const folder of allFoldersResp.data) {
        if (folder.type === 'sendreceive') {
          const appId = folder.id;
          const folderPath = folder.path;
          const component = componentsByAppId.get(appId);

          // eslint-disable-next-line no-await-in-loop
          const mountSafety = await verifySendReceiveFolderSafety(appId, folderPath, {
            injectedExcludePaths: component?.injectedExcludePaths ?? [],
            appName: component?.appName,
          });

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
      erroredFolderIds,
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

    // Remove unused folders and devices (parallelized for better performance).
    // "Unused" means no installed app owns the folder - not merely "not processed
    // this cycle". A folder whose app is still installed but was skipped this pass
    // (volume transiently unmounted, or an operation lease held) is absent from
    // folderIds; deleting it would race the mount-safety demotion that flips it to
    // receiveonly and holds the container, leaving the app running over a bad
    // mount. Gate on ownership so only genuinely orphaned folders are removed.
    const installedFolderIds = new Set();
    // eslint-disable-next-line no-restricted-syntax
    for (const deployment of deployments) {
      // eslint-disable-next-line no-restricted-syntax
      for (const [, deployComp] of deployment.componentEntries()) {
        if (deployComp.hasSyncthing()) {
          installedFolderIds.add(dockerService.getAppIdentifier(deployComp.identifier));
        }
      }
    }
    const nonUsedFolders = allFoldersResp.data.filter(
      (syncthingFolder) => !folderIds.includes(syncthingFolder.id)
        && !installedFolderIds.has(syncthingFolder.id),
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
  let accelerator; // assigned below; runMonitoring only executes after assignment

  const runMonitoring = async () => {
    if (isRunning) {
      log.warn('syncthingApps - Previous execution still running, skipping this iteration');
      return;
    }

    isRunning = true;
    accelerator.notePassStarted();
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
      accelerator.notePassEnded();
    }
  };

  // Edge accelerator: folder events for folders the state machine is actively
  // transitioning (plus FolderErrors and resync requests) trigger an early run
  // of the SAME monitoring pass the interval drives - events never carry
  // decisions, and steady-state folder activity never accelerates anything.
  accelerator = createMonitorAccelerator({
    run: runMonitoring,
    isFolderInTransition: (folderId) => {
      const entry = state.receiveOnlySyncthingAppsCache.get(folderId);
      return Boolean(entry && !entry.restarted);
    },
    debounceMs: EARLY_EVAL_DEBOUNCE_MS,
    minGapMs: EARLY_EVAL_MIN_GAP_MS,
  });

  // Run immediately on start
  runMonitoring();

  // Then run at regular intervals (the LEVEL: ground truth, self-healing)
  intervalId = setInterval(runMonitoring, MONITOR_INTERVAL_MS);

  syncthingEventsConsumer.start({
    onFolderActivity: (folder, eventType) => accelerator.onFolderActivity(folder, eventType),
    onResync: () => accelerator.onResync(),
  });

  // Return control object for graceful shutdown
  return {
    stop: () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
        accelerator.stop();
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
