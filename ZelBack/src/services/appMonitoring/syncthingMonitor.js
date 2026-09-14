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
const { ConfigMethod, ABSENT } = require('../utils/syncthingConstants');
const globalState = require('../utils/globalState');
const fluxEventBus = require('../utils/fluxEventBus');
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
const { createPeerFolderLiveness } = require('./peerFolderLiveness');
const {
  sortAndFilterLocations,
  buildDeviceConfiguration,
  createSyncthingFolderConfig,
  ensureStfolderExists,
  ensureStignoreCovers,
  folderNeedsUpdate,
} = require('./syncthingMonitorHelpers');
const volumeService = require('../utils/volumeService');
const appTamperingDetectionService = require('../appTamperingDetectionService');
const mastershipGrantGate = require('../appLifecycle/mastershipGrantGate');
const { extractIp, socketAddressesMatch } = require('../utils/socketAddressUtils');
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
 * Whether syncthing applied a configuration WRITE, and a loud line when it did not.
 *
 * syncthingService answers ONE WAY: rows, or a throw. The envelope is a wire
 * shape that an Api handler puts back on, and nothing above that line sees one.
 *
 * This is the report-and-continue reading, for a write whose failure must not
 * end the pass - a per-app safety action, or one folder of a parallel sweep.
 * A write whose failure invalidates everything below it is awaited directly and
 * leaves through the outer catch.
 *
 * @param {Promise<*>} write - an adjustConfig* call in flight
 * @param {string} what - what was being applied, for the log line
 * @returns {Promise<boolean>} true only when syncthing accepted it
 */
async function syncthingApplied(write, what) {
  try {
    await write;
    return true;
  } catch (error) {
    log.error(`syncthingAppsCore - ${what} FAILED: ${error.message || 'unknown error'}`);
    return false;
  }
}

/**
 * Verify one app folder's mount safety, repairing an unmounted volume on the
 * spot (FluxOS owns the mount - the backing image normally still exists, so
 * the actionable response is to mount it, not just to report it).
 *
 * A folder that is currently sendreceive is verified at the deeper level, which
 * also rejects a stale index over an empty volume: sendreceive is the only mode
 * that can broadcast the resulting deletions, so the check belongs exactly where
 * that is possible and nowhere else - it costs a syncthing round trip and a
 * scoped directory walk per folder. The repair runs first either way, so the
 * index is judged against a mounted volume rather than against the absence of
 * one.
 *
 * @param {string} appId - Docker app identifier
 * @param {string} appFolder - App folder path
 * @param {string} appName - the app this component belongs to
 * @param {boolean} [sending] - Whether syncthing currently holds this folder sendreceive
 * @returns {Promise<{isSafe: boolean, reason: string}>} Result after any repair
 */
async function verifyAppFolderMountWithRepair(appId, appFolder, appName, sending = false) {
  // appName reaches BOTH verifiers - the sendreceive one takes it through its
  // options and forwards it to the shallow check it starts with.
  const verify = () => (sending
    ? verifySendReceiveFolderSafety(appId, appFolder, { appName })
    : verifyFolderMountSafety(appId, appFolder, appName));
  let mountSafety = await verify();
  if (!mountSafety.isSafe && !mountSafety.isMounted) {
    const mountAttempt = await volumeService.ensureAppVolumeMounted(appId);
    if (mountAttempt.mounted) {
      // This pass replaces the record when it mounts from somewhere other than
      // where the record puts it, so a later one cannot re-derive the fact -
      // it has to be recorded by whichever pass mounted.
      if (mountAttempt.imageMoved) {
        await appTamperingDetectionService.recordEvent(
          appId,
          'volume_image_moved',
          `Volume image for ${appId} was found somewhere other than where this node recorded it`,
        );
      }
      log.info(`checkAppFolderMounts - ${appId} volume was not mounted; mounted it`);
      mountSafety = await verify();
    }
  }
  return mountSafety;
}


/**
 * Check if app folders are properly mounted
 * Returns list of apps whose folders are not mounted yet
 * Uses verifyFolderMountSafety to detect folders that exist but aren't properly mounted
 * @param {Array} deployments - Installed app deployments
 * @param {Set<string>} knownFolderIds - Every folder id syncthing holds, in any mode
 * @param {Set<string>} sendingFolderIds - Folder ids syncthing currently holds
 *  sendreceive. The deeper verification belongs exactly there and nowhere else:
 *  sendreceive is the only mode that can BROADCAST a deletion, so it is the only
 *  mode where a stale index over an empty volume has to be refused rather than
 *  noted. Nothing passed this, so the deeper check never ran on any folder.
 * @param {Array<{appId: string, appName: string}>} [extraFolders] - Folder
 *  entries verified by id alone, for folders whose owning app's spec cannot be
 *  read this pass
 * Each unmounted entry carries `sending`, the folder's mode as this pass's own
 * folder read observed it, and `syncing`, whether the component declares sync at
 * all. The demotion reads both off the entry: A SAFETY ACTION MUST NOT DEPEND ON
 * A CALL THAT CAN FAIL, and a failed read of the folder list is
 * indistinguishable from "no such folder, nothing to protect".
 *
 * `known` is the third, and the one that keeps the other two honest: a folder
 * syncthing holds RECEIVEONLY is not sendreceive and needs nothing done, where a
 * folder syncthing does not hold AT ALL, declared by a component that syncs, is
 * a contradiction. Both are `sending` false and they are not the same case.
 *
 * @returns {Promise<{unmountedApps: Array, verifiedSafeIds: string[]}>}
 */
async function checkAppFolderMounts(deployments, sendingFolderIds, knownFolderIds, extraFolders = []) {
  const unmountedApps = [];
  // The verdict is two-sided and both sides are needed: an unsafe mount is a
  // fault to act on, and a SAFE one is the condition a standing mount-verify
  // flag exists for, now gone. Returning only the faults meant the caller had
  // to clear flags by reading them, which loses the retry on a pass that dies
  // between reading and acting.
  const verifiedSafeIds = [];

  // eslint-disable-next-line no-restricted-syntax
  for (const deployment of deployments) {
    // eslint-disable-next-line no-restricted-syntax
    for (const [, deployComp] of deployment.componentEntries()) {
      // A stateless component has no volume BY DESIGN, so it has no folder to
      // check and its absence is not a fault. appVolumeService returns early on
      // the same question and never creates the directory, so checking for it
      // reports base_directory_missing every pass — which returns before
      // syncthingInitializedSuccessfully is set, so syncthingAppsFirstRun never
      // clears and syncthing is never configured for ANY app on the node. It
      // also records a mount_vanished tampering event each time, for a volume
      // that was never supposed to exist.
      //
      // v9-only in practice: every v8 compose component has hdd >= 1, so
      // `storage > 0`. containerHealthMonitor, appReconciler (twice) and
      // appVolumeService all already gate on this; this loop was the one that
      // did not.
      if (deployComp.isStateless) continue;
      // deployComp.identifier is the docker-style id - bare appName for flat
      // (v1-3) specs, comp_app for composed (v4+) - so no version branching here.
      const appId = dockerService.getAppIdentifier(deployComp.identifier);
      const appFolder = `${appsFolder}${appId}`;
      // eslint-disable-next-line no-await-in-loop
      const mountSafety = await verifyAppFolderMountWithRepair(
        appId, appFolder, deployment.appName, sendingFolderIds.has(appId),
      );
      if (mountSafety.isSafe) verifiedSafeIds.push(appId);
      if (!mountSafety.isSafe) {
        // Folder exists but mount is not safe (empty and not mounted - likely unmounted loop device)
        // identifier travels alongside appId: the reconciler is keyed by the bare form
        // and this loop already holds it, so nothing downstream has to recover it.
        unmountedApps.push({
          appId,
          identifier: deployComp.identifier,
          appName: deployment.appName,
          reason: mountSafety.reason,
          sending: sendingFolderIds.has(appId),
          known: knownFolderIds.has(appId),
          syncing: deployComp.hasSyncthing(),
        });
      }
    }
  }

  // The verdict derives entirely from the folder id, so a folder whose owning
  // app cannot be read this pass is verified all the same - it is protected from
  // the SWEEP, not from the mount check. A folder held sendreceive over a
  // vanished mount broadcasts its emptiness whether or not this node can read
  // the spec that named it.
  // eslint-disable-next-line no-restricted-syntax
  for (const { appId, appName } of extraFolders) {
    const appFolder = `${appsFolder}${appId}`;
    // eslint-disable-next-line no-await-in-loop
    const mountSafety = await verifyAppFolderMountWithRepair(
      appId, appFolder, appName, sendingFolderIds.has(appId),
    );
    if (mountSafety.isSafe) verifiedSafeIds.push(appId);
    else {
      // These entries come from syncthing's own folder list, filtered to
      // sendreceive, so both are true by construction.
      unmountedApps.push({
        appId, identifier: appId, appName, reason: mountSafety.reason, sending: true, known: true, syncing: true,
      });
    }
  }

  return { unmountedApps, verifiedSafeIds };
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
/**
 * The apps holding at least one syncing folder still awaiting a promotion
 * decision. Only those folders ask a peer anything, so only their holders are
 * worth asking about: a node whose synced apps are all running probes nothing,
 * and must keep probing nothing.
 *
 * Asked of the deployment, not of a stored document. The version of this that
 * read `installedApp.compose` and `containerData` answered EMPTY for every v9
 * app without failing - those keys are the v8 spelling and a v9 spec carries
 * neither - so it would have prewarmed nothing on the fleet it was written for.
 *
 * An app mid-operation is skipped for the same reason the pass skips it: nothing
 * will promote its folders this cycle, so there is nothing to ask about.
 *
 * @param {Array} deployments - Installed app deployments
 * @param {Map} receiveOnlySyncthingAppsCache - Per-folder transition state
 * @returns {Set<string>} App names
 */
function deploymentsAwaitingPromotion(deployments, receiveOnlySyncthingAppsCache) {
  const names = new Set();
  // eslint-disable-next-line no-restricted-syntax
  for (const deployment of deployments) {
    if (operationRegistry.isHeld(deployment.appName)) continue;
    // eslint-disable-next-line no-restricted-syntax
    for (const [, deployComp] of deployment.componentEntries()) {
      // hasSyncthing() is exactly the old requiresSyncing() gate - the folder is
      // minted only for activeStandby (g:) and syncFirst (r:).
      if (!deployComp.hasSyncthing()) continue;
      const appId = dockerService.getAppIdentifier(deployComp.identifier);
      const cache = receiveOnlySyncthingAppsCache.get(appId);
      if (cache && !cache.restarted) names.add(deployment.appName);
    }
  }
  return names;
}

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
 * Hold a fenced device's autoAcceptFolders at false, and restore it once no
 * fence stands. Both directions are read-check-patch against what syncthing
 * actually holds, so the state self-heals whatever pass was missed: FluxOS
 * sets autoAcceptFolders true universally, which makes false unambiguously
 * a fence artifact, safe to restore the moment the app is unfenced.
 *
 * @param {string} appName
 * @param {Array} locations app locations (hosts the app's devices belong to)
 * @param {Array} allDevices syncthing's current device configs
 * @param {{host: string}|null} fence the standing fence, if any
 */
async function reconcileFenceAutoAccept(appName, locations, allDevices, fence) {
  const rows = Array.isArray(allDevices) ? allDevices : [];
  const appHosts = new Set((locations || []).map((row) => extractIp(row.ip)));
  const patches = [];
  rows.forEach((device) => {
    const host = extractIp(device.name);
    if (!appHosts.has(host)) return;
    if (fence && host === fence.host && device.autoAcceptFolders !== false) {
      patches.push({ deviceID: device.deviceID, autoAcceptFolders: false });
    } else if (!fence && device.autoAcceptFolders === false) {
      patches.push({ deviceID: device.deviceID, autoAcceptFolders: true });
    }
  });
  const applied = patches.map(async (patch) => {
    const ok = await syncthingApplied(
      syncthingService.adjustConfigDevices({
        method: ConfigMethod.PATCH,
        config: { autoAcceptFolders: patch.autoAcceptFolders },
        id: patch.deviceID,
      }),
      `${appName}: autoAcceptFolders ${patch.autoAcceptFolders} for device ${patch.deviceID.slice(0, 12)}`,
    );
    if (ok) {
      log.info(`syncthingMonitor - ${appName}: autoAcceptFolders ${patch.autoAcceptFolders} for device ${patch.deviceID.slice(0, 12)}`);
    }
  });
  await Promise.all(applied);
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
    liveness,
    localDeviceId,
    state,
    erroredFolderIds,
    allFolders,
    allDevices,
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

  // The peer fence, reconciled declaratively every pass: a deposed master
  // that has not attested demote-and-revert is kept OFF this folder's device
  // list, and its device entry's autoAcceptFolders is held false so
  // syncthing's auto-accept cannot silently re-share the folder when it
  // announces (the reversal trap the lease design found in the source).
  // Consulting the fence also advances its lift poll; when the fence drops,
  // the same reconciliation re-adds the device and restores auto-accept.
  const fence = deployComp.hasActiveStandbySyncthing()
    ? mastershipGrantGate.fenceFor(installedAppName)
    : null;
  await reconcileFenceAutoAccept(installedAppName, locations, allDevices, fence);

  // Build device configuration (parallelized internally)
  const devices = await buildDeviceConfiguration(
    locations,
    localSocketAddr,
    localDeviceId,
    state.syncthingDevicesIDCache,
    devicesConfiguration,
    devicesIds,
    allDevices,
    fence?.host ?? null,
  );

  // Create base folder configuration
  const syncthingFolder = createSyncthingFolderConfig(id, label, folder, devices);
  const syncFolder = allFolders.find((x) => x.id === id);

  // CONVERGE THE IGNORE POLICY, through syncthing's own API - it owns .stignore
  // and writes it atomically. Only once syncthing knows the folder: a brand-new
  // one had its .stignore seeded at volume creation, and an existing one was
  // configured in a prior pass and persists across restarts. So this reaches
  // every folder whose ignores predate a policy line, and skips the single pass
  // where a fresh install is not yet configured. A converged folder posts
  // nothing and triggers no rescan.
  //
  // Nothing called this. The policy is `/backup` and `/<staging>*`: without it
  // every byte a copy, extract or upload stages replicates to every peer only
  // to be deleted again on publish - and a peer's boot sweep can delete a
  // replicated staging directory that a live operation on another node still
  // needs.
  if (syncFolder) {
    await ensureStignoreCovers(id);
  }

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
      liveness,
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
      const answer = await syncthingService.getDbStatus(folder.id);
      // Syncthing holds no such folder. Destructuring the answer anyway would
      // read every field as undefined and log it as 100% synced.
      if (answer === ABSENT) return { id: folder.id, type: folder.type, error: 'no such folder' };

      const { globalBytes = 0, inSyncBytes = 0, state: syncState } = answer;
      const syncPercentage = globalBytes > 0 ? (inSyncBytes / globalBytes) * 100 : 100;

      return {
        id: folder.id,
        type: folder.type,
        syncPercentage,
        globalBytes,
        inSyncBytes,
        state: syncState,
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
    //
    // AN APP THIS NODE COULD NOT READ IS NOT AN APP THAT IS NOT INSTALLED, and
    // the deployment list alone cannot tell those apart. The pass acts on the
    // specification, and an app whose spec cannot be read tells us nothing about
    // which folders it owns - so its folders are protected from the sweep below
    // rather than swept as orphans. Everything that DID resolve is managed
    // normally: aborting the whole pass instead would stop folder registration,
    // mount safety, promotion and error draining for every app on the node, and
    // stop publishing the writable-folder answer its peers block on, for as long
    // as one app stayed unreadable.
    const {
      deployments, unreadableAppNames,
    } = await deploymentProvider.listInstalledDeploymentsDetailed();
    if (unreadableAppNames.size) {
      log.warn(`syncthingAppsCore - folders of unreadable apps are protected this pass: ${[...unreadableAppNames].join(', ')}`);
    }
    // A folder id is the component identifier, which ends in _<appName> - and an
    // app name cannot contain an underscore - so a folder always names the app
    // that owns it, even when that app's components cannot be read.
    const ownedByUnreadableApp = (folderId) => unreadableAppNames.has(
      folderId.slice(folderId.lastIndexOf('_') + 1),
    );

    // Drain the folders syncthing flagged with errors since the last cycle. Mount
    // safety is verified only at decision points - the first pass after start (the
    // reboot case: loop mounts may not be up yet) and folders syncthing itself
    // flagged - never as a steady-state sweep of every folder. A vanished mount
    // takes the folder's .stfolder marker with it and raises FolderErrors, so the
    // flagged set catches real mount loss without re-walking healthy folders.
    // Read only. The flag is cleared where the mount question is ANSWERED -
    // below, on the folders that verified safe - not here by the act of reading
    // it. The old drainErroredFolderIds() did both in one call, so a pass that
    // died between the read and the action forgot what it had been asked to
    // check and never retried it.
    const pendingFolderIds = syncthingEventsConsumer.mountVerifyPendingIds();
    const erroredFolderIds = new Set(pendingFolderIds);
    const deploymentsToVerify = state.syncthingAppsFirstRun
      ? deployments
      : deploymentsMatchingFolderIds(deployments, erroredFolderIds);

    // A FLAG NO INSTALLED COMPONENT CARRIES CAN NEVER BE ACTED ON. Nothing
    // downstream matches it - checkAppFolderMounts walks deployments - so it is
    // re-read every pass forever and the pending set only grows. The uninstall
    // that removed the component already removed whatever the flag protected,
    // so resolving it is the answer rather than a loss.
    //
    // AN APP THIS NODE COULD NOT READ IS NOT AN APP THAT CARRIES NOTHING. It
    // carries nothing HERE, for a reason that says nothing about the folder, so
    // resolving on that would drop a live protection over a mount nobody has
    // checked. Those flags stand and resolve through a completed outcome like
    // any other, once the spec can be read.
    if (!state.syncthingAppsFirstRun && pendingFolderIds.length > 0) {
      const carried = new Set();
      deployments.forEach((deployment) => {
        // eslint-disable-next-line no-restricted-syntax
        for (const [, deployComp] of deployment.componentEntries()) {
          carried.add(dockerService.getAppIdentifier(deployComp.identifier));
        }
      });
      pendingFolderIds
        .filter((id) => !carried.has(id) && !ownedByUnreadableApp(id))
        .forEach((id) => {
          log.info(`syncthingAppsCore - resolving mount-verify flag for ${id}: no installed component carries it`);
          syncthingEventsConsumer.resolveMountVerify(id);
        });
    }

    // Peer liveness, answered once for the whole pass: two folders must not reach
    // opposite conclusions about whether a silence is a peer's or this node's own.
    const liveness = createPeerFolderLiveness();

    // THE FOLDER CONFIGURATION IS READ BEFORE ANYTHING IS JUDGED BY IT. The
    // mount check below needs to know which folders syncthing currently holds
    // sendreceive, because that is the only mode that can broadcast a deletion -
    // so it is the only mode where a stale index over an empty volume has to be
    // rejected rather than merely noted.
    //
    // getConfigFolders answers the rows themselves, or throws. Caught here and
    // not shared with the device read below: a pass that cannot read devices
    // must not withhold a folder list it already has, or every peer asking is
    // told to wait for as long as the device read keeps failing.
    let allFolders;
    try {
      allFolders = await syncthingService.getConfigFolders();
    } catch (error) {
      if (state.syncthingAppsFirstRun) {
        log.warn('syncthingAppsCore - Syncthing configuration not ready yet on first run. Waiting for next cycle to avoid data loss.');
      } else {
        log.error(`syncthingAppsCore - Failed to get Syncthing folder configuration: ${error.message}`);
      }
      return;
    }

    // CRITICAL: Validate Syncthing configuration is loaded before proceeding
    // On system restart, Syncthing API might be available but config not fully loaded
    // This prevents data deletion during the race condition window
    if (!Array.isArray(allFolders)) {
      if (state.syncthingAppsFirstRun) {
        log.warn('syncthingAppsCore - Syncthing folder configuration not ready yet on first run. Waiting for next cycle to avoid data loss.');
      } else {
        log.error('syncthingAppsCore - Failed to get Syncthing folders configuration: malformed response');
      }
      return;
    }

    // Publish which folders this node holds WRITABLE, for the peers that ask
    // before promoting one of their own. Recorded here rather than read on
    // demand: the answer is a byproduct of a pass the monitor already makes, so
    // serving it costs nothing, where an endpoint calling syncthing per request
    // would be an unauthenticated amplifier into it.
    //
    // It had no writer at all, so it stayed null, /apps/promotedfolders answered
    // ready:false forever, and every folder with at least one peer was blocked
    // from promotion fleet-wide.
    //
    // Set only from a VALIDATED response - the guard above - so a failed read
    // leaves the last good answer standing rather than momentarily claiming this
    // node holds nothing writable. Published as a COPY: the reconciliation at the
    // end of the pass mutates the published set as writes land, while this stays
    // what the scan observed.
    const sendingFolderIds = new Set(
      allFolders.filter((folder) => folder.type === 'sendreceive').map((folder) => folder.id),
    );
    // Every folder syncthing holds, in any mode. Absence from this is the
    // 404 the demotion would otherwise have to ask for.
    const knownFolderIds = new Set(allFolders.map((folder) => folder.id));
    globalState.promotedFolderIds = new Set(sendingFolderIds);

    // An unreadable app's folders are protected from the SWEEP, not from the
    // mount check: the verdict derives entirely from the folder id, so a folder
    // whose owning app's spec cannot be read this pass is verified all the same.
    const unreadableFolderEntries = unreadableAppNames.size === 0 ? [] : allFolders
      .filter((folder) => folder.type === 'sendreceive' && ownedByUnreadableApp(folder.id))
      .map((folder) => ({
        appId: folder.id,
        appName: folder.id.slice(folder.id.lastIndexOf('_') + 1),
      }));

    // CRITICAL: Check if app folder mounts are ready before processing
    // This prevents syncthing operations when loop devices aren't mounted after reboot
    const { unmountedApps, verifiedSafeIds } = deploymentsToVerify.length > 0 || unreadableFolderEntries.length > 0
      ? await checkAppFolderMounts(deploymentsToVerify, sendingFolderIds, knownFolderIds, unreadableFolderEntries)
      : { unmountedApps: [], verifiedSafeIds: [] };
    // A safe mount is the condition the flag was raised for, resolved. Anything
    // else keeps its flag standing for the next pass - including a pass that
    // dies below this line, which is the whole point of not clearing on read.
    verifiedSafeIds.forEach((id) => syncthingEventsConsumer.resolveMountVerify(id));
    // AN UNSAFE MOUNT IS AN APP-LEVEL FAULT. The folders named here are held out
    // of this pass and every other app is processed normally. Ending the whole
    // pass instead strands the node: an app whose volume can never be mounted
    // keeps this set non-empty on every cycle, so nothing below ever runs - no
    // folder registration, no promotion, no error draining, and no writable-
    // folder answer for the peers that block on it - for any app on the node,
    // permanently. The first-run flag never clears either, so the full sweep and
    // the startup safety scan repeat every cycle. The flag set gates the g:
    // primary election node-wide, so one unmountable app stops every masterSlave
    // app on the node from electing.
    const unsafeFolderIds = new Set();
    if (unmountedApps.length > 0) {
      const unmountedList = unmountedApps.map((app) => app.appId).join(', ');
      log.warn(`syncthingAppsCore - Holding ${unmountedApps.length} app folders out of this pass, not mounted: ${unmountedList}`);

      // Never leave an unsafe-mount folder sendreceive while processing is
      // skipped: the syncthing daemon keeps running as configured, so an
      // un-demoted sendreceive folder over a bad mount can still broadcast its
      // (leaked or missing) disk state to the healthy peers. Demote those
      // folders and hold their containers before bailing - idempotent, and the
      // normal receiveonly machinery re-promotes once the mount is healthy.
      // Which folders are sendreceive is carried on the entry. The folder
      // configuration is read ONCE per pass, at the top, where a failure returns
      // before anything is judged by it.
      // eslint-disable-next-line no-restricted-syntax
      for (const {
        appId, identifier, reason, sending, known, syncing,
      } of unmountedApps) {
        unsafeFolderIds.add(appId);
        if (!sending) {
          // A folder syncthing holds RECEIVEONLY over a bad mount is already in
          // the state this block exists to put it in - nothing to demote, and
          // its container is left to the normal machinery.
          //
          // A folder syncthing does not hold AT ALL, declared by a component
          // that syncs, is a contradiction rather than an answer. Nothing is
          // recreated from here - the level loop rebuilds the folder once the
          // mount is healthy - but the mount is unsafe either way, so the
          // container is held now and the flag stands for the next pass.
          if (!known && syncing) {
            log.error(`syncthingAppsCore - SAFETY BLOCK: ${appId} is over an unsafe mount (${reason}) and syncthing holds no folder for it though the component syncs; holding the container, flag stands`);
            appReconciler.setControllerDesired(identifier, 'stopped', `mount safety block: ${reason}`);
          }
          // A component that declares no sync has no folder to be missing, and
          // syncthing holds none for it: there is nothing here for the mount
          // question to be answered ABOUT, this pass or any later one. Left
          // standing the flag is re-read forever, the pending set only grows,
          // and deploymentsMatchingFolderIds keeps handing this deployment back
          // - so the node never reaches steady state and sweeps every mount on
          // every cycle. The unsafe mount itself is still a fault; it is the
          // reconciler's, and holding a container this monitor has no folder
          // for is not this block's call.
          if (!known && !syncing) {
            log.info(`syncthingAppsCore - resolving mount-verify flag for ${appId}: the component declares no sync and syncthing holds no folder for it`);
            syncthingEventsConsumer.resolveMountVerify(appId);
          }
          // eslint-disable-next-line no-continue
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const demoted = await syncthingApplied(
          syncthingService.adjustConfigFolders({ method: ConfigMethod.PATCH, config: { type: 'receiveonly' }, id: appId }),
          `SAFETY BLOCK: demoting ${appId} to receiveonly over an unsafe mount (${reason})`,
        );
        if (demoted) {
          log.error(`syncthingAppsCore - SAFETY BLOCK: ${appId} folder was sendreceive over an unsafe mount (${reason}); switched to receiveonly and holding the container`);
          // A demoted folder re-enters the promotion machinery from the start:
          // left where it stood, a folder moments from promotion resumes there
          // once the mount returns, on a sync state established before the
          // volume went away. The mark is the one manageFolderSyncState writes
          // on this same condition, so both paths describe a blocked folder the
          // same way.
          // eslint-disable-next-line no-await-in-loop
          await appCaches.setSyncedMark(state.receiveOnlySyncthingAppsCache, appId, {
            numberOfExecutions: 0,
            mountSafetyBlocked: true,
            blockedReason: reason,
            blockedAt: Date.now(),
          });
        } else {
          // No mark: it describes a DEMOTED folder, and this one is still
          // sendreceive.
          log.error(`syncthingAppsCore - SAFETY BLOCK: ${appId} is STILL sendreceive over an unsafe mount (${reason}); holding the container and retrying the demotion next pass`);
        }
        // The container is held whether or not the demotion landed: the harm is
        // this node's copy writing to a bad mount, which a failed demotion does
        // not make less likely. The flag is untouched here - it resolves only
        // where the mount question is ANSWERED - so the next pass comes back to
        // this folder.
        appReconciler.setControllerDesired(identifier, 'stopped', `mount safety block: ${reason}`);
      }
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

    let allDevices;
    try {
      allDevices = await syncthingService.getConfigDevices();
    } catch (error) {
      if (state.syncthingAppsFirstRun) {
        log.warn('syncthingAppsCore - Syncthing device configuration not ready yet on first run. Waiting for next cycle to avoid data loss.');
      } else {
        log.error(`syncthingAppsCore - Failed to get Syncthing devices configuration: ${error.message}`);
      }
      return;
    }

    if (!Array.isArray(allDevices)) {
      if (state.syncthingAppsFirstRun) {
        log.warn('syncthingAppsCore - Syncthing device configuration not ready yet on first run. Waiting for next cycle to avoid data loss.');
      } else {
        log.error('syncthingAppsCore - Failed to get Syncthing devices configuration: malformed response');
      }
      return;
    }

    // Mark that Syncthing is properly initialized - safe to clear first run flag
    syncthingInitializedSuccessfully = true;

    // CRITICAL STARTUP SAFETY CHECK: Verify all sendreceive folders have safe mounts
    // This prevents data loss when loop mounts aren't ready after reboot
    if (state.syncthingAppsFirstRun && allFolders.length > 0) {
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
      for (const folder of allFolders) {
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
            await syncthingApplied(
              syncthingService.adjustConfigFolders({ method: ConfigMethod.PATCH, config: { type: 'receiveonly' }, id: folder.id }),
              `STARTUP SAFETY: demoting ${folder.id} to receiveonly`,
            );
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

    // ONE TIMEOUT FOR THE PASS, NOT ONE PER FOLDER. Both promotion decisions ask
    // the same peers the same question and the folder loop is sequential, so a
    // peer asked inside it costs its full timeout again for every folder that
    // elects it - and past a handful the pass outruns its own interval and the
    // next cycle is dropped for every folder on the node. Asking the whole set
    // at once costs one timeout however many folders wait on it.
    //
    // Nothing is probed unless a folder is actually awaiting promotion, so a
    // node whose synced apps are all running asks nobody anything. prewarm
    // existed on peerFolderLiveness with no caller, which is why the pass has
    // been paying per folder.
    const awaitingPromotion = deploymentsAwaitingPromotion(deployments, state.receiveOnlySyncthingAppsCache);
    if (awaitingPromotion.size) {
      const peerLists = await Promise.all([...awaitingPromotion].map((name) => appLocation(name)));
      await liveness.prewarm(
        peerLists.flat()
          .map((entry) => entry?.ip)
          .filter((ip) => ip && !socketAddressesMatch(ip, localSocketAddr)),
      );
    }

    // Shared parameters for processing
    const sharedParams = {
      localSocketAddr,
      liveness,
      localDeviceId,
      state,
      erroredFolderIds,
      allFolders,
      allDevices,
      devicesConfiguration,
      devicesIds,
      folderIds,
      foldersConfiguration,
      newFoldersConfiguration,
    };

    // Process every component of every installed app. componentEntries() and
    // deployComp.identifier are polymorphic over the spec version, so there is
    // no v1-3-vs-v4+ branching here.
    // Folder ids left untouched this cycle because their app is mid-operation.
    const heldForBusy = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const deployment of deployments) {
      const { appName } = deployment;
      // Skip this app if it holds any operation lease (per-app). An operation
      // owns its folders for its duration - a backup pauses them and gives them
      // back - so a pass that rewrote the folder config underneath it would
      // clear the pause mid-archive. Its folders are left untouched this cycle.
      if (operationRegistry.isHeld(appName)) {
        log.info(`syncthingAppsCore - operation in progress for ${appName}, syncthing skipped this cycle`);
        // Recorded so the pass can say what it held back as well as what it
        // wrote: "nothing was written for this app" and "this app was never
        // reached" are the same silence otherwise.
        for (const [, heldComp] of deployment.componentEntries()) {
          heldForBusy.push(dockerService.getAppIdentifier(heldComp.identifier));
        }
        // eslint-disable-next-line no-continue
        continue;
      }

      // eslint-disable-next-line no-restricted-syntax
      for (const [, deployComp] of deployment.componentEntries()) {
        // The component whose mount is unsafe is the one held out - its folder
        // has already been demoted and its container held above. Its siblings
        // and every other app are processed normally.
        if (unsafeFolderIds.has(dockerService.getAppIdentifier(deployComp.identifier))) {
          // eslint-disable-next-line no-continue
          continue;
        }
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
    const nonUsedFolders = allFolders.filter(
      (syncthingFolder) => !folderIds.includes(syncthingFolder.id)
        && !installedFolderIds.has(syncthingFolder.id)
        && !ownedByUnreadableApp(syncthingFolder.id),
    );
    // A peer device is attributed to an app by DOING that app's work, so while
    // anything is held out this pass's view of who is still needed is
    // incomplete - sweeping on it would drop a live peer of the very app whose
    // data is waiting to be healed. The folders survive on ownership, which is a
    // separate guarantee: never visited is not unused.
    const nonUsedDevices = unsafeFolderIds.size > 0 ? [] : allDevices.filter(
      (syncthingDevice) => !devicesIds.includes(syncthingDevice.deviceID) && syncthingDevice.deviceID !== localDeviceId,
    );

    // Parallelize cleanup operations
    const cleanupPromises = [
      ...nonUsedFolders.map((folder) => {
        log.info(`syncthingAppsCore - Removing unused Syncthing folder ${folder.id}`);
        return syncthingApplied(
          syncthingService.adjustConfigFolders({ method: ConfigMethod.DELETE, id: folder.id }),
          `removing unused folder ${folder.id}`,
        );
      }),
      ...nonUsedDevices.map((device) => {
        log.info(`syncthingAppsCore - Removing unused Syncthing device ${device.deviceID}`);
        return syncthingApplied(
          syncthingService.adjustConfigDevices({ method: ConfigMethod.DELETE, id: device.deviceID }),
          `removing unused device ${device.deviceID}`,
        );
      }),
    ];

    await Promise.all(cleanupPromises);

    // Apply new configuration
    // THE CONFIGURATION WRITES ABORT THE PASS. Everything below acts on the
    // configuration these apply - the folder-error scan reads the folders just
    // written, the restart check asks whether they need one, and the promoted
    // set is published from them. A refused write leaves all of it describing a
    // configuration syncthing does not hold, so it leaves through the outer
    // catch and the level loop reassembles next pass.
    if (devicesConfiguration.length > 0) {
      await syncthingService.adjustConfigDevices({ method: ConfigMethod.PUT, config: devicesConfiguration });
    }
    // Inert in production - the bus is a no-op unless the harness enables it -
    // and the only way anything outside can tell a pass that reached the folder
    // write from one that never ran. A pass with nothing to change writes
    // nothing and logs nothing, so the two silences are identical without this.
    fluxEventBus.publish('syncthing:passComplete', {
      wrote: newFoldersConfiguration.map((folder) => folder.id),
      heldForBusy,
    });

    if (newFoldersConfiguration.length > 0) {
      await syncthingService.adjustConfigFolders({ method: ConfigMethod.PUT, config: newFoldersConfiguration });
      // Reconciled in BOTH directions the moment the write lands, not left to
      // the next pass. The published set is what a peer reads before promoting a
      // folder of its own, and a promotion applied on the line above is absent
      // from it until syncthing is read again - so two nodes promoting in one
      // cycle would each advertise nothing, neither would block the other, and
      // that is the collision the check exists to catch.
      //
      // Reached only on a write that landed - the line above throws otherwise.
      // This is an ASSERTION about syncthing's state made without re-reading it,
      // and it is what peers act on: a folder named here that syncthing did not
      // accept advertises this node as holding it writable, and a peer stands
      // down from a promotion nothing serves.
      for (const folder of newFoldersConfiguration) {
        if (folder.type === 'sendreceive') globalState.promotedFolderIds.add(folder.id);
        else globalState.promotedFolderIds.delete(folder.id);
      }
    }

    // Check for folder errors in parallel
    const folderErrorChecks = await Promise.all(
      foldersConfiguration.map(async (folder) => {
        try {
          const folderError = await syncthingService.getFolderIdErrors(folder.id);
          if (folderError?.errors?.length > 0) {
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
