'use strict';

const util = require('util');
const path = require('path');
const systemcrontab = require('crontab');
const serviceHelper = require('../serviceHelper');
const verificationHelper = require('../verificationHelper');
const messageHelper = require('../messageHelper');
const dockerService = require('../dockerService');
const globalState = require('../utils/globalState');
const operationRegistry = require('../utils/operationRegistry');
const telemetrySinkCache = require('../telemetrySinkCache');
const appTamperingDetectionService = require('../appTamperingDetectionService');
const log = require('../../lib/log');
const config = require('config');
const upnpService = require('../upnpService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
const appRecords = require('../appDatabase/appRecords');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const generalService = require('../generalService');
const mastershipGrantGate = require('./mastershipGrantGate');
const relationshipResolver = require('./relationshipResolver');
const contentStore = require('./contentStore');
const appSwapPoolService = require('./appSwapPoolService');
const { stopAppMonitoring } = require('../appManagement/appInspector');
const appsRuntimeState = require('../appManagement/appsRuntimeState');
const globalCommand = require('../appManagement/globalCommand');
const volumeService = require('../utils/volumeService');
const fluxEventBus = require('../utils/fluxEventBus');
const { Privilege, authOf } = require('../utils/privileges');
const fluxShutdowndClient = require('../utils/fluxShutdowndClient');
const pendingTeardownStore = require('./pendingTeardownStore');
const installedLedger = require('./installedLedger');
const meshReconciler = require('../appMesh/meshReconciler');
const meshOrdinals = require('../appMesh/meshOrdinals');
const imageCacheRetention = require('./imageCacheRetention');
const shutdownPlan = require('./shutdownPlan');
const reconcilerQueue = require('../appMonitoring/reconcilerQueue');
const syncthingMonitorHelpers = require('../appMonitoring/syncthingMonitorHelpers');
const { withHostMutationLock } = require('../utils/hostMutationLock');
const { ANNOUNCE_CYCLE_WAIT_MS } = require('../utils/appConstants');

const fluxDirPath = process.env.FLUXOS_PATH || path.join(process.env.HOME, 'zelflux');
const appsFolderPath = process.env.FLUX_APPS_FOLDER || path.join(fluxDirPath, 'ZelApps');
const appsFolder = `${appsFolderPath}/`;
const crontabLoad = util.promisify(systemcrontab.load);

/**
 * Outcome of uninstallApplication. Lets a caller tell a real removal from a no-op or a
 * transient deferral, instead of the old "always undefined, errors swallowed" contract.
 */
const UninstallStatus = Object.freeze({
  REMOVED: 'removed', // app/component torn down
  SKIPPED: 'skipped', // nothing to remove - not installed / already gone
  DEFERRED: 'deferred', // another op in progress - removal not attempted, retry later
  FAILED: 'failed', // teardown started then errored
});

// Fired once per component identifier after a successful local removal, beside
// the durable runtime-state clear (mirrors appInstaller.setOnInstallComplete).
// serviceManager wires it to appReconciler.forgetDesiredState so every
// in-memory verdict about the component dies with it - a
// back-require of appReconciler here would capture a stale partial export
// (appReconciler already requires this module and both replace module.exports).
let onComponentRemoved = null;
function setOnComponentRemoved(callback) {
  onComponentRemoved = callback;
}

/**
 * Removes a component's syncthing folder by the id the ledger records for it
 * and clears what this node said about the folder.
 * @param {string|null} folderId - the component's syncthing folder id; null when
 *   the ledger records none, so no folder is removed
 * @param {string} appId - Application ID
 * @returns {Promise<void>}
 */
async function stopSyncthingAndCleanup(folderId, appId) {
  // Hard removal - the data is going, so what this node says about it goes first
  // and unconditionally. Stopping syncthing can fail; the volume is deleted either
  // way, and state describing it must not outlive it on the strength of that.
  const { receiveOnlySyncthingAppsCache } = globalState;
  if (receiveOnlySyncthingAppsCache && receiveOnlySyncthingAppsCache.has(appId)) {
    receiveOnlySyncthingAppsCache.delete(appId);
    log.info(`Deleted syncthing cache for ${appId} during hard removal`);
  }
  // The published claim goes with the data it describes. Peers rank a seed on it,
  // and one kept past the removal offers a volume this node no longer has -
  // outranking a node that still holds the app and seeding an empty folder in its
  // place.
  globalState.folderHoldings?.delete(appId);
  try {
    if (folderId) await syncthingMonitorHelpers.removeSyncthingFolder(folderId);

    // The folder and its data are going, so the cache entry must go with them:
    // a stale mark would make the next install of this name read as already-synced
    const { receiveOnlySyncthingAppsCache } = globalState;
    if (receiveOnlySyncthingAppsCache && receiveOnlySyncthingAppsCache.has(appId)) {
      receiveOnlySyncthingAppsCache.delete(appId);
      log.info(`Deleted syncthing cache for ${appId} during removal`);
    }
  } catch (error) {
    log.error(`Error stopping Syncthing app: ${error.message}`);
  }
}

/**
 * Unmount volume for application or component
 * @param {string} appId - Application ID
 * @param {object} [options]
 * @param {string} [options.entityName] - label for progress messages (defaults to appId)
 * @param {Function|null} [options.onStatus] - progress callback
 * @returns {Promise<void>}
 */
async function unmountVolume(appId, options = {}) {
  const { entityName = appId, onStatus = null } = options;
  const status = (msg) => {
    log.info(msg);
    if (onStatus) onStatus(msg);
  };

  // Nothing mounted, nothing to unmount: a stateless component never had a
  // volume, and a teardown can re-run after an earlier unmount succeeded.
  // Probing /proc/self/mountinfo is cheaper than forking umount and avoids
  // reporting a routine no-op as an error on every stateless uninstall.
  if (!await volumeService.isPathMounted(appsFolder + appId)) return;

  status(`Unmounting volume of ${entityName}...`);
  const result = await serviceHelper.runCommand('umount', { params: [appsFolder + appId], runAsRoot: true, logError: false });
  if (result.error) {
    log.error(result.error);
    status(`An error occured while unmounting ${entityName} storage. Continuing...`);
  } else {
    status(`Volume of ${entityName} unmounted`);
  }
}

/**
 * Clean up application data directory
 * @param {string} appId - Application ID
 * @param {object} [options]
 * @param {string} [options.entityName] - label for progress messages (defaults to appId)
 * @param {Function|null} [options.onStatus] - progress callback
 * @returns {Promise<boolean>} whether the data is gone: a removal that did not happen
 *   is residue, which the caller keeps the teardown owed for
 */
async function cleanupAppData(appId, options = {}) {
  const { entityName = appId, onStatus = null } = options;
  const status = (msg) => {
    log.info(msg);
    if (onStatus) onStatus(msg);
  };

  // the bare mountpoint is kept immutable while unmounted (set in createAppVolume,
  // re-established by the boot mount pass); clear the flag or the removal below fails
  await serviceHelper.runCommand('chattr', { runAsRoot: true, params: ['-i', appsFolder + appId], logError: false });

  status(`Cleaning up ${entityName} data...`);
  // The removal carries on either way - data left behind is not a reason to hold an
  // uninstall open - but only one of these two lines is true, and the stream is the
  // only account an operator gets of what is still on the disk.
  const result = await serviceHelper.runCommand('rm', { params: ['-rf', appsFolder + appId], runAsRoot: true, logError: false });
  if (result.error) {
    log.error(result.error);
    status(`An error occured while cleaning ${entityName} data. Continuing...`);
    return false;
  }
  status(`Data of ${entityName} cleaned`);
  return true;
}

/**
 * Remove the legacy @reboot mount crontab entry for an app, if any. FluxOS owns
 * mounting now (createAppVolume no longer creates these, and the boot pass in
 * crontabAndMountsCleanup removes surviving entries once the volume is mounted),
 * so this only cleans up an entry an older version left behind on uninstall.
 * @param {string} appId - Application ID
 * @param {object} [options]
 * @param {Function|null} [options.onStatus] - progress callback
 * @returns {Promise<void>}
 */
async function cleanupCrontab(appId, options = {}) {
  const { onStatus = null } = options;
  const status = (msg) => {
    log.info(msg);
    if (onStatus) onStatus(msg);
  };

  status('Adjusting crontab...');
  const crontab = await crontabLoad().catch((e) => {
    log.error(e);
    status('An error occured while loading crontab. Continuing...');
  });

  if (crontab) {
    const jobs = crontab.jobs();
    const jobToRemove = jobs.find((job) => job.comment() === appId);
    if (jobToRemove) {
      crontab.remove(jobToRemove);
      try {
        crontab.save();
      } catch (e) {
        log.error(e);
        status('An error occured while saving crontab. Continuing...');
      }
      status('Crontab Adjusted.');
    } else {
      status('Crontab not found.');
    }
  }
}

/**
 * Clean up volume path
 * @param {string} volumepath - Volume path to clean
 * @param {object} [options]
 * @param {string} [options.entityName] - label for progress messages (defaults to the volume path)
 * @param {Function|null} [options.onStatus] - progress callback
 * @param {boolean} [options.conclusive=true] - whether the search that produced the
 *   path covered everywhere an image may be. False with no path means an image may
 *   be on disk that nothing will account for again.
 * @returns {Promise<boolean>} whether nothing is left behind that this node could
 *   remove: false for a removal that did not happen, which is residue
 */
async function cleanupVolumePath(volumepath, options = {}) {
  const { entityName = volumepath, onStatus = null, conclusive = true } = options;
  const status = (msg) => {
    log.info(msg);
    if (onStatus) onStatus(msg);
  };
  if (!volumepath) {
    // Nothing to delete and nowhere left to look are different answers, and only
    // the first means the disk is clear. An image whose location could not be
    // established outlives the app's last record of itself, so this is the one
    // chance to say it is there.
    if (!conclusive) {
      log.warn(`Data volume of ${entityName} could not be located and is left on disk`);
      if (onStatus) onStatus(`Data volume of ${entityName} could not be located and is left on disk`);
    }
    return true;
  }

  status(`Cleaning up data volume of ${entityName}...`);
  // The removal carries on either way - an image left behind is not a reason to
  // hold an uninstall open - but only one of these two is true, and the stream is
  // the only account an operator gets of what is still on the disk.
  const result = await serviceHelper.runCommand('rm', { params: ['-rf', volumepath], runAsRoot: true, logError: false });
  if (result.error) {
    log.error(result.error);
    status(`An error occured while cleaning ${entityName} volume. Continuing...`);
    return false;
  }
  status(`Volume of ${entityName} cleaned`);
  return true;
}

/**
 * Deny host ports as the ledger says they were opened: on the firewall (ufw)
 * and the router (UPnP), each port by its own methods. Leaf host mutations on
 * the shared firewall ruleset / IGD session, so the deferred teardown calls
 * this from inside the node-wide hostMutationLock. Also used by a redeploy's
 * port-delta reconcile to close only the removed ports. Progress goes through
 * onStatus — the API handler owns the response stream.
 * @param {Array<{port: number, opened: Array<'ufw'|'upnp'>}>} ports
 * @param {string} appName - app name (the UPnP mapping description key)
 * @param {object} [options]
 * @param {string} [options.entityName] - label for progress messages (defaults to appName)
 * @param {Function|null} [options.onStatus] - progress callback
 */
async function denyPorts(ports, appName, options = {}) {
  const { entityName = appName, onStatus = null } = options;
  const status = (msg) => {
    log.info(msg);
    if (onStatus) onStatus(msg);
  };

  status(`Denying ${entityName} ports...`);
  // eslint-disable-next-line no-restricted-syntax
  for (const { port, opened } of (ports || [])) {
    if (opened.includes('ufw')) {
      // eslint-disable-next-line no-await-in-loop
      await fluxNetworkHelper.deleteAllowPortRule(port);
    }
    if (opened.includes('upnp')) {
      // eslint-disable-next-line no-await-in-loop
      await upnpService.removeMapUpnpPort(port, `Flux_App_${appName}`);
    }
  }
  status(`Ports of ${entityName} denied`);
}

/**
 * Reclaim app images after their containers are gone — deduplicated and
 * reference-gated. An image is removed only when no remaining container (a
 * sibling component, a re-spawn, or another app sharing a base image like
 * alpine:latest) still references it; a shared image is left in place silently
 * rather than attempting a removal Docker correctly refuses with a 409. Never
 * force-removes — forcing would break the referrer.
 *
 * @param {string[]} images - candidate image refs (deduplicated internally)
 * @param {Function} status - progress logger
 */
async function reclaimUnusedImages(images, status) {
  const distinct = [...new Set((images || []).filter(Boolean))];
  if (distinct.length === 0) return;
  let inUse;
  try {
    const containers = await dockerService.dockerListContainers(true);
    inUse = new Set();
    // eslint-disable-next-line no-restricted-syntax
    for (const c of containers) {
      if (c.Image) inUse.add(c.Image);
      if (c.ImageID) inUse.add(c.ImageID);
    }
  } catch (error) {
    log.warn(`Image reclaim skipped (could not list containers): ${error.message}`);
    return;
  }
  // eslint-disable-next-line no-restricted-syntax
  for (const image of distinct) {
    if (inUse.has(image)) {
      status(`Image ${image} still referenced by another container; leaving it`);
      // eslint-disable-next-line no-continue
      continue;
    }
    // An image pinned in the enterprise image cache survives its app's teardown
    // so a later reinstall is a local layer-cache hit instead of a full re-pull.
    // eslint-disable-next-line no-await-in-loop
    if (await imageCacheRetention.shouldRetainImage(image)) {
      status(`Image ${image} pinned in the enterprise image cache; leaving it`);
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await dockerService.appDockerImageRemove(image)
      .then(() => status(`Image ${image} removed`))
      .catch((error) => {
        // Backstop for an ID-vs-tag reference miss: Docker's own "must force" / 409
        // confirms the image is still in use, so treat it as benign, not an error.
        const msg = error.message || '';
        if (/in use|must force|409/i.test(msg)) {
          status(`Image ${image} still in use; leaving it`);
        } else {
          log.error(`Image remove failed for ${image}: ${msg}`);
        }
      });
  }
}

/**
 * The ONE per-component teardown core: every path that takes a component's
 * container down — true removal, storage recreate, rebuild-in-place — runs
 * through here. The grant release keys on the data: removeVolumes destroys
 * this instance's authority and releases the term; a volume-preserving
 * teardown holds it.
 *
 * `c` is a plain descriptor rather than a DeploymentComponent, so the owed
 * removal path and the live rebuild flows share it: what the ledger names for
 * the component - its ports with the methods they were opened by, its volume,
 * its sync folder - beside its identifier, app and label.
 *
 * Returns { removed }. When the container survives the remove (or a
 * transition never settles), destructive cleanup is SKIPPED — a volume rm
 * under a live container corrupts it — and the caller keeps the teardown
 * owed. A cleanup error after the container is confirmed gone still counts
 * as removed: the host residue is retried by the owed record, never by
 * holding the component hostage.
 *
 * @param {{identifier: string, appId: string, appName: string, identity: string|null, label: string,
 *   ports: Array<{port: number, opened: string[]}>, volume: object|null, syncFolder: {id: string, path: string}|null}} c
 * @param {object} [opts]
 * @param {boolean} [opts.forceKill=false] - docker kill + force-remove instead of stop + remove
 * @param {boolean} [opts.removeVolumes=false] - tear down volumes, syncthing, crontab (and release the grant)
 * @param {boolean} [opts.skipPorts=false] - leave ufw/UPnP rules in place
 * @param {boolean} [opts.stopHandled=false] - the stop already landed (flux-shutdownd, or the caller's own stop phase)
 * @param {Function|null} [opts.onStatus] - progress callback
 * @returns {Promise<{removed: boolean}>}
 */
async function teardownComponentCore(c, opts = {}) {
  const forceKill = opts.forceKill || false;
  const removeVolumes = opts.removeVolumes || false;
  const skipPorts = opts.skipPorts || false;
  const stopHandled = opts.stopHandled || false;
  const onStatus = opts.onStatus || null;
  const status = (msg) => { log.info(msg); if (onStatus) onStatus(msg); };

  stopAppMonitoring(c.identifier, removeVolumes);

  // Local stop is the fallback executor only: a component with a declared
  // graceful contract is stopped by flux-shutdownd (the caller passes
  // stopHandled), and docker's SIGTERM+grace IS the contract for the rest.
  if (!stopHandled) {
    status(`Stopping Flux App ${c.label}...`);
    if (forceKill) {
      await dockerService.appDockerKill(c.identifier).catch((error) => log.warn(`Failed to kill container ${c.appId}: ${error.message}`));
    } else {
      await dockerService.appDockerStop(c.identifier).catch((error) => log.warn(`Failed to stop container ${c.appId}: ${error.message}`));
    }
  }

  // The grant follows the data: a volume-preserving teardown is a
  // rebuild-in-place and the term holds through it — the master returns with
  // its data and its Holder never stopped renewing. Destroying the volume
  // ends this instance's authority, so release — after the stop, never
  // before: a grant released under a still-writing container is the overlap
  // the whole plane exists to prevent.
  if (removeVolumes) {
    await mastershipGrantGate.onComponentTeardown(c.identifier, c.identity);
  }

  // Hold the component's 'removing' lease across remove + host cleanup so a
  // reconcile start can't (re)create the container mid-teardown; wait bounded
  // for an in-flight start to settle rather than racing it.
  const removingToken = await acquireRemovingLease(c.appId, c.identifier);
  if (!removingToken) {
    log.error(`Teardown of ${c.identifier}: a container transition did not settle within ${REMOVING_LEASE_WAIT_MS}ms — deferring`);
    return { removed: false };
  }
  let removed = false;
  let cleanupFailed = false;
  try {
    status(`Removing Flux App ${c.label} container...`);
    if (forceKill) {
      await dockerService.appDockerForceRemove(c.identifier).catch((e) => log.warn(`force remove ${c.appId}: ${e.message}`));
    } else {
      await dockerService.appDockerRemove(c.identifier).catch((e) => log.warn(`remove ${c.appId}: ${e.message}`));
    }
    // NEVER reclaim a component's host storage while its container still exists.
    // Decide on the container's ACTUAL presence (getDockerContainer returns null
    // when gone), not on the remove error; a presence check that itself fails is
    // treated as "still there" (never delete on uncertainty).
    let stillPresent;
    try {
      stillPresent = Boolean(await dockerService.getDockerContainer(c.identifier));
    } catch (probeErr) {
      stillPresent = true;
      log.warn(`Teardown of ${c.identifier}: could not confirm the container was removed (${probeErr.message}); keeping it owed`);
    }
    // A non-force teardown found the container still present: a reconcile start
    // completed between the stop and our 'removing' lease, leaving it running.
    // We hold the lease now, so no further start can intervene — escalate to a
    // force remove (its graceful window already elapsed in the stop phase).
    if (stillPresent && !forceKill) {
      await dockerService.appDockerForceRemove(c.identifier).catch((e) => log.warn(`force remove (escalated) ${c.appId}: ${e.message}`));
      try {
        stillPresent = Boolean(await dockerService.getDockerContainer(c.identifier));
      } catch (probeErr) {
        stillPresent = true;
        log.warn(`Teardown of ${c.identifier}: could not confirm the escalated removal (${probeErr.message}); keeping it owed`);
      }
    }
    if (stillPresent) {
      log.error(`Teardown of ${c.identifier}: container still present after remove — skipping destructive cleanup, keeping the teardown owed`);
      return { removed: false, cleanupFailed: false };
    }
    removed = true;
    if (!skipPorts) {
      await denyPorts(c.ports, c.appName, { entityName: c.label, onStatus });
    }
    if (removeVolumes) {
      await stopSyncthingAndCleanup(c.syncFolder?.id ?? null, c.appId);
      // The folder has left syncthing with its data about to go: demoted and
      // reverted in full, which a master fencing this node waits for before it
      // re-admits the device.
      if (c.identity) mastershipGrantGate.noteFolderDemoted(c.identity);
      await unmountVolume(c.appId, { entityName: c.label, onStatus });
      const dataRemoved = await cleanupAppData(c.appId, { entityName: c.label, onStatus });
      await cleanupCrontab(c.appId, { onStatus });
      // The image file is where the ledger says the node put it, and nowhere
      // else is looked. A volume named with no file is one the node recorded
      // no file for, and the one chance to say an image may be on disk.
      const volumeRemoved = await cleanupVolumePath(c.volume?.file ?? null, {
        entityName: c.label, onStatus, conclusive: !c.volume || Boolean(c.volume.file),
      });
      // Residue that did not throw is still residue: the record stays owed and retries it.
      if (!dataRemoved || !volumeRemoved) cleanupFailed = true;
    }
  } catch (err) {
    // The container is gone but host residue may remain — a mount, an appdata
    // directory, a crontab entry, the volume file. Reported separately from
    // `removed` so the caller can keep the teardown record OWED (which is what
    // retries the residue) without holding the component hostage as if its
    // container had survived. Collapsing the two is how the residue used to be
    // abandoned: `removed` was already true, so the record was cleared.
    if (removed) cleanupFailed = true;
    log.error(`Host teardown of ${c.identifier} failed (continuing): ${err.message}`);
  } finally {
    operationRegistry.release(c.appId, removingToken);
  }
  return { removed, cleanupFailed };
}

/**
 * Uninstall a single component: the rebuild flows' entry to the shared
 * teardown core. Image cleanup is app-level and reference-gated (see
 * reclaimUnusedImages, called by uninstallApplication). Driven off the
 * normalized DeploymentSpec component.
 *
 * @param {import('@runonflux/flux-spec-backend').DeploymentComponent} component
 * @param {object} [options]
 * @param {boolean} [options.removeVolumes=false] - tear down volumes, syncthing, crontab
 * @param {boolean} [options.forceKill=false] - docker kill + force-remove instead of stop + remove
 * @param {boolean} [options.skipPorts=false] - leave ufw/UPnP rules in place (a redeploy reconciles the port delta itself)
 * @param {boolean} [options.stopHandled=false] - flux-shutdownd already drained and stopped this identity
 * @param {Function|null} [options.onStatus] - progress callback
 */
async function uninstallComponent(component, options = {}) {
  const removeVolumes = options.removeVolumes || false;
  const onStatus = options.onStatus || null;

  const { appName } = component;
  const componentName = component.name;
  // The physical name: the volume dir, the appdata path, the crontab comment
  // and the container's docker name, all the identifier. The syncthing folder
  // id is the component's own (syncFolderId), which differs for an app
  // registered before v9.
  const appId = dockerService.getAppIdentifier(component.identifier);
  const label = componentName === appName ? appName : `component ${componentName} of ${appName}`;

  // What the ledger names for the component is what goes: its ports by the
  // methods they were opened with, its folder by its id, its image file.
  const ledger = await appRecords.ledgers().byInstance(appName, component.replica ?? null);
  const block = ledger?.component(component.componentKey) ?? null;
  if (!block) log.warn(`uninstall ${component.identifier}: the ledger names no block for it; no port, folder or image file is removed`);
  const { removed } = await teardownComponentCore(
    {
      identifier: component.identifier,
      appId,
      appName,
      identity: component.identity,
      label,
      ports: block?.hostPorts ?? [],
      volume: block?.volume ?? null,
      syncFolder: block?.syncFolder ?? null,
    },
    {
      forceKill: options.forceKill || false,
      removeVolumes,
      skipPorts: options.skipPorts || false,
      stopHandled: options.stopHandled || false,
      onStatus,
    },
  );

  if (removed) {
    // A rebuild is an explicit "make it run", so neither the operator's stop lock nor
    // a stale controller verdict survives it. What the component has proven here does
    // (appsRuntimeState.removeControllerState).
    await appsRuntimeState.removeControllerState(component.identifier);
    if (onComponentRemoved) onComponentRemoved(component.identifier);
  }

  if (removed && removeVolumes) {
    // Reclaim now-unneeded app-swap pool capacity (idempotent; no-op without the
    // new-mechanism host config). The container is already gone, so its swap pages
    // are freed and an emptied chunk can be swapped off + removed.
    await appSwapPoolService.reconcile();
  }

  const status = (msg) => {
    log.info(msg);
    if (onStatus) onStatus(msg);
  };
  status(removed
    ? `Flux App ${label} was successfully removed`
    : `Flux App ${label} teardown finished, but container ${appId} is still present`);
}

/**
 * Clear an app's spawn-throttle cache entry on an operator removal so the spawner can
 * reinstall it promptly.
 *
 * A node-pinned app removed via the operator path (/apps/appremove, foreground non-force) stays
 * globally registered and still targets this node, so the spawner is obliged to reinstall it -
 * but trySpawningGlobalAppCache (set when it first spawned here, ~12h) is never cleared on the
 * spawner's success path and suppresses reselection, a silent outage for a single-instance pinned
 * app after a routine local removal. Clearing it lets the next scan reinstall.
 *
 * Gated to forceKill=false AND background=false, which is exactly that operator path. Force paths
 * (over-instance self-evict, redeploy, rollback) must NOT reinstall; and expiry/cancel - graceful
 * (force=false) on v9 but BACKGROUND - drain the app for good and must not reinstall either. The
 * `background` flag distinguishes them precisely without leaning on the spawner's expiry filter:
 * the operator REST removal is foreground/awaited, the expiry+cancel sweep is background. Placement
 * + hash are read through the registry domain object; the pin is matched by IP (the conservative
 * subset, as the wake gate does) - an outpoint/operator-only pin simply keeps the throttle.
 * @param {string} appName
 * @param {{forceKill: boolean, background: boolean}} opts - the removal's force/background flags
 * @returns {Promise<void>}
 */
async function clearSpawnThrottleForPinnedReinstall(appName, { forceKill, background }) {
  if (forceKill || background) return;
  const globalSpec = await appRecords.registry().byName(appName);
  const placement = globalSpec && globalSpec.placement;
  if (!placement || !placement.hasTargets()) return;
  const localSocketAddress = await fluxNetworkHelper.getLocalSocketAddress();
  if (!localSocketAddress || !placement.isPinnedTo({ ip: localSocketAddress })) return;
  const { trySpawningGlobalAppCache } = globalState;
  if (globalSpec.hash && trySpawningGlobalAppCache && trySpawningGlobalAppCache.has(globalSpec.hash)) {
    trySpawningGlobalAppCache.delete(globalSpec.hash);
    log.info(`Cleared spawn-throttle cache for node-pinned app ${appName} (hash ${globalSpec.hash}) so the spawner can reinstall it`);
  }
}

// Reentrancy latch for the orphaned-follower sweep: a sweep removal triggers the
// sweep again (deferred), which must not stack a second concurrent pass. A trigger
// arriving while a sweep runs sets the dirty flag so the running sweep re-runs once
// more before releasing - otherwise a trigger that fires during the terminal pass's
// DB read (before a concurrent removal's row delete) is lost, leaving a real orphan.
let dependencyCleanupInProgress = false;
let dependencyCleanupDirty = false;

// Keys with a destructive teardown currently executing. The single-flight guard for
// runTeardown: every teardown path (foreground, detached, boot recovery, the install
// catch's recovery) funnels through it, so this is where two concurrent teardowns of
// the same app - which would double-destroy and race the crash-recovery record - are
// refused. In-memory only: a crash clears it and boot recovery re-drives.
const teardownsInProgress = new Set();

// App name -> a callback that escalates its in-flight graceful drain to a force
// stop. A teardown draining via flux-shutdownd registers one for the drain window;
// an operator's explicit force-remove of the same app fires it to preempt the drain
// instead of starting a second teardown.
const teardownEscalations = new Map();

/**
 * Fire the escalation for an app whose graceful drain is in flight, preempting it
 * with a force stop. No-op (returns false) when nothing is draining.
 * @param {string} name
 * @returns {boolean} whether an in-flight drain was escalated
 */
function escalateTeardown(name) {
  const escalate = teardownEscalations.get(name);
  if (!escalate) return false;
  escalate();
  return true;
}

/**
 * onRemove cascade: before an app is removed, gracefully uninstall every
 * installed app whose declared edges say it must not outlive this one (a
 * cascade-edge chain to it — plus, transitionally, every workload of a
 * pure-follower target, the v8 model; relationshipResolver holds both
 * rules). No-op when nothing cascades. Each removal is foreground (its
 * teardown is awaited), so a consumer finishes its graceful drain while the
 * dependency it may still be flushing to is up.
 *
 * @param {string} appName - bare app name being removed
 * @returns {Promise<boolean>} true when the dependency's teardown may proceed; false
 *   when a requiring workload DEFERRED (it is mid-operation and will resume as a live
 *   consumer), so the dependency's teardown must be deferred rather than leave that
 *   consumer half-torn. A FAILED workload does not block: its teardown is already
 *   committed (record owed, retried by boot recovery), so the dependency may go.
 */
async function removeRequiringWorkloadsFirst(appName, { forceKill = false, operatorForce = false } = {}) {
  if (!appName) {
    return true;
  }
  const workloads = await relationshipResolver.findCascadeWorkloadsRequiring(appName);
  let allRemoved = true;
  // eslint-disable-next-line no-restricted-syntax
  for (const workload of workloads) {
    log.info(`Reverse dependency cascade: uninstalling workload ${workload.name} before its dependency ${appName}`);
    // The dependency removal's manner propagates: graceful honours each
    // consumer's drain; forced kills them - consumer-first either way, so the
    // ordering invariant holds. broadcastRemoval tells the network.
    // eslint-disable-next-line no-await-in-loop, no-use-before-define
    const result = await uninstallApplication(workload.name, { forceKill, operatorForce, broadcastRemoval: true });
    // A workload mid-operation (redeploy/backup/install) DEFERS - it will resume as a
    // live consumer, so its dependency must not be torn down under it (that leaves the
    // workload's post-teardown re-verify throwing with its own containers already gone).
    // Blocking is the GRACEFUL rule: under force the dependency is coming down
    // regardless, so a deferring consumer is noted and stepped past. A FAILED
    // workload has already committed its teardown (record owed) and won't
    // resume, so it does not block the dependency.
    if (result && result.status === UninstallStatus.DEFERRED) {
      if (forceKill) {
        log.warn(`Reverse dependency cascade: workload ${workload.name} is mid-operation; proceeding under force`);
      } else {
        log.warn(`Reverse dependency cascade: workload ${workload.name} is mid-operation (deferred); deferring teardown of ${appName}`);
        allRemoved = false;
      }
    }
  }
  return allRemoved;
}

/**
 * Removes locally-installed self-cleaning apps (activation.stopWhenUnneeded)
 * that nothing holds any more — no installed app depends on them, and (for a
 * standalone one) their own placement does not target this node. Triggered
 * after a workload is removed and at boot. Loops until the set is stable so a
 * chain unwinds fully: removing the consumer that linked to a collector then
 * orphans the collector. Each removal is a normal graceful uninstall, so the
 * collector's own drain window is honoured; by the time this runs the
 * workload that depended on it has already finished draining and been
 * removed.
 *
 * @returns {Promise<void>}
 */
async function removeUnrequiredDependencies() {
  if (dependencyCleanupInProgress) {
    // A trigger arrived mid-sweep: it may reflect state the running sweep already
    // read past, so mark it dirty to re-run rather than drop this trigger.
    dependencyCleanupDirty = true;
    return;
  }
  dependencyCleanupInProgress = true;
  try {
    // This node's identity, for the standalone self-hold: a
    // (standalone: true, stopWhenUnneeded: true) app deployed here by its own
    // placement holds itself; the same app pulled in purely as a dependency
    // does not. Best-effort per part — an identity that cannot be read is
    // simply not passed, and the resolver then fails toward keeping (a
    // standalone app is never reaped on incomplete identity).
    let nodeIdentity;
    try {
      const ip = await fluxNetworkHelper.getLocalSocketAddress();
      const collateral = await generalService.obtainNodeCollateralInformation();
      const operator = await fluxNetworkHelper.getFluxNodePublicKey();
      nodeIdentity = {
        ip: ip || undefined,
        outpoint: collateral ? `${collateral.txhash}:${collateral.txindex}` : undefined,
        operator: typeof operator === 'string' ? operator : undefined,
      };
    } catch (error) {
      log.warn(`Dependency cleanup: node identity unreadable (${error.message}); standalone self-holds treated as held`);
      nodeIdentity = undefined;
    }
    do {
      dependencyCleanupDirty = false;
      const attempted = new Set();
      let hitLimit = true;
      // Bounded: each pass either removes one app or stops. The cap is a backstop.
      for (let pass = 0; pass < 50; pass += 1) {
        // eslint-disable-next-line no-await-in-loop
        // Already ordered consumer-before-consumed by the resolver, which holds
        // the resolved views the ordering depends on.
        const orphans = await relationshipResolver.findUnrequiredInstalledDependencies({ nodeIdentity });
        const target = orphans.find((app) => !attempted.has(app.name.toLowerCase()));
        if (!target) {
          hitLimit = false;
          break;
        }
        attempted.add(target.name.toLowerCase());
        log.info(`Dependency cleanup: removing ${target.name} - no installed app requires it any more`);
        // forceKill=false honours the graceful drain; broadcastRemoval tells the
        // network this node dropped it. A DEFERRED/FAILED removal is retried on
        // the next trigger (the name stays in attempted for this run only).
        // eslint-disable-next-line no-await-in-loop, no-use-before-define
        await uninstallApplication(target.name, { forceKill: false, broadcastRemoval: true });
      }
      if (hitLimit) {
        log.warn('Dependency cleanup: reached pass limit, will retry on next trigger');
      }
      // Re-run if a trigger arrived while this sweep was executing.
    } while (dependencyCleanupDirty);
  } catch (error) {
    log.error(`Dependency cleanup failed: ${error.message}`);
  } finally {
    dependencyCleanupInProgress = false;
  }
}

/**
 * Wait for an announcement cycle already sending, and no longer than
 * ANNOUNCE_CYCLE_WAIT_MS: a wedged cycle must not hold up the node's removals.
 * A cycle that starts after the call reads the departing mark instead.
 * @returns {Promise<void>}
 */
async function waitForAnnouncementInFlight() {
  let timer = null;
  const bound = new Promise((resolve) => { timer = setTimeout(resolve, ANNOUNCE_CYCLE_WAIT_MS); });
  try {
    await Promise.race([globalState.announceCycle.waitReady({ waitAll: false }), bound]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Remove a whole application from the local node (a single component is removed via
 * uninstallComponent — this never takes a component identifier).
 * @param {string} appName - the app name.
 * @param {object} [options] - forceKill, skipGuard, broadcastRemoval, background, onStatus.
 * @returns {Promise<{status: string, reason: string|null}>} status is an UninstallStatus
 *   value: REMOVED (torn down), SKIPPED (not installed - nothing to remove), DEFERRED
 *   (another op in progress, retry later), FAILED (teardown started then errored).
 */
async function uninstallApplication(appName, options = {}) {
  const {
    forceKill = false,
    skipGuard = false,
    broadcastRemoval = false,
    background = false,
    onStatus = null,
    reason = null,
    operatorForce = false,
    // The reverse-dependency cascade is a correctness invariant (a consumer
    // never outlives its dependency) and fires by default on every whole-app
    // removal. Only a removal that does NOT end the app's presence here - the
    // installer's failed-install cleanups, which the spawner retries - may
    // state cascade:false.
    cascade = true,
  } = options;
  // The identity this removal targets: a replica name tears down ONLY that
  // replica's containers/volumes (the app row survives while a sibling
  // remains); omitted/null removes the whole app as today.
  const replica = 'replica' in options ? options.replica : undefined;

  const status = (msg) => {
    log.info(msg);
    if (onStatus) onStatus(msg);
  };

  // Hoisted so the finally releases ONLY a lease this call actually acquired — the
  // token stays null on the deferred early-return (an own-checked no-op), and two
  // same-app skipGuard removes that share one slot can never clobber a later lease.
  let removeToken = null;
  // Hoisted: the instances this call marked owed + whether the deferred teardown
  // has started — so the catch can drive a committed-but-interrupted teardown
  // in-process without re-driving one that already began.
  const marked = [];
  let teardownStarted = false;
  // What this call marked as departing, and nothing else, so the finally releases
  // only its own mark.
  let departing = null;
  try {
    // Log removal trigger with stack trace to identify caller
    const { stack } = new Error();
    const callerLine = stack.split('\n')[2]?.trim();
    log.warn(`APP REMOVAL TRIGGERED: ${appName} | forceKill=${forceKill} | skipGuard=${skipGuard} | broadcastRemoval=${broadcastRemoval} | caller: ${callerLine}`);

    // Per-app: defer if THIS app is already mid-operation. skipGuard is the emergency
    // bypass that lets a removal barge past a NON-remove lease (an install cleaning up
    // after itself, an operator force past a redeploy) - but it must NEVER let a second
    // teardown start while a 'remove' lease is already active: two concurrent teardowns
    // double-destroy and race each other's crash-recovery record. Removals of different
    // apps run concurrently - each removes only its own containers/volumes/network.
    const heldLease = operationRegistry.get(appName);
    if (heldLease) {
      // An operator's explicit force-remove of an app already tearing down does not
      // start a second teardown - it preempts the in-flight graceful drain, escalating
      // it to a force stop. If nothing is draining (the teardown is past the drain, or
      // already forceful), it simply defers.
      if (heldLease.type === 'remove' && operatorForce) {
        const escalated = escalateTeardown(appName);
        status(escalated
          ? `Operator force-remove: escalating the in-flight teardown of ${appName} to a force stop`
          : `A teardown of ${appName} is already in progress`);
        return escalated
          ? { status: UninstallStatus.REMOVED, reason: `Escalated the in-flight teardown of ${appName} to force` }
          : { status: UninstallStatus.DEFERRED, reason: `A teardown of ${appName} is already in progress` };
      }
      if (heldLease.type === 'remove' || !skipGuard) {
        status(`An operation is already in progress for ${appName}. Removal not possible.`);
        return { status: UninstallStatus.DEFERRED, reason: `An operation is already in progress for ${appName}` };
      }
    }

    // Acquire the per-app operation lease — the sole record that this app is
    // mid-removal. Released in the finally.
    removeToken = operationRegistry.acquire(appName, 'remove', 'appUninstaller', `remove ${appName}`);

    if (!appName) {
      throw new Error('No App specified');
    }

    // The node stops claiming what it is handing back here, at the decision, and not
    // when the row happens to go: an announcement reading the table in between would
    // claim it again. Only the identity this removal names.
    if (broadcastRemoval) {
      globalState.departingApps.enter(appName, replica ?? null);
      departing = { appName, replica: replica ?? null };
    }

    // The instances this removal targets, each with the ledger of what the node
    // created for it. A replica name targets that instance alone; omitted, the
    // whole app leaves this node.
    const instances = replica !== undefined
      ? [await appRecords.installed().byReplica(appName, replica, { includeOwed: true })].filter(Boolean)
      : await appRecords.installed().instancesOf(appName, { includeOwed: true });
    if (instances.length === 0) {
      status('Flux App not found');
      return { status: UninstallStatus.SKIPPED, reason: 'Flux App not found' };
    }
    const spec = instances[0].record;

    // onRemove cascade: before tearing this app down, uninstall every
    // installed app whose edges declare it must not outlive this one (cascade
    // chains; transitionally also every workload of a pure-follower target —
    // the v8 model). The cascade fires on every whole-app removal whatever
    // its urgency - the removal's MANNER propagates instead: a graceful
    // removal drains its consumers and defers on one mid-operation; a forced
    // removal kills them, consumer-first, and defers for nothing. A
    // replica-scoped removal leaves the app present, so there is nothing to
    // cascade. Runs before this app's teardown record exists, so each nested
    // removal is an ordinary standalone removal. Gated off in production: the
    // flux console owns the collector lifecycle.
    if (config.get('fluxapps.manageCollectorLifecycle') && cascade && replica === undefined) {
      const workloadsRemoved = await removeRequiringWorkloadsFirst(appName, { forceKill, operatorForce });
      if (!workloadsRemoved) {
        // A consumer that still requires this follower could not be removed yet
        // (it is mid-operation). Defer this teardown - it runs before the prelude,
        // so nothing is torn down - and retry on the next trigger.
        status(`Removal of ${appName} deferred: a workload still requiring it could not be removed yet`);
        return { status: UninstallStatus.DEFERRED, reason: `A workload requiring ${appName} could not be removed yet` };
      }
    }

    // What the teardown removes is what each instance's ledger names. The stop
    // budget the daemon is given comes from the deployment while the spec is
    // readable here; a spec that cannot be read gives the stop no budget.
    const targets = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const instance of instances) {
      // eslint-disable-next-line no-await-in-loop
      const ledger = await appRecords.ledgers().byInstance(appName, instance.replica);
      if (!ledger) log.error(`uninstall ${appName}${instance.replica ? ` (${instance.replica})` : ''}: the ledger is missing; the record goes and nothing it created is removed`);
      let budgetSeconds = 0;
      try {
        // eslint-disable-next-line no-await-in-loop
        const deployment = await deploymentProvider.buildDeployment(instance, { replica: instance.replica });
        if (deployment) budgetSeconds = shutdownPlan.appShutdownBudgetSeconds(deployment);
      } catch (err) {
        log.warn(`uninstall ${appName}: deployment build failed (${err.message}); the stop gets no budget`);
      }
      targets.push(teardownTarget(instance, ledger, {
        since: Date.now(), reason, force: forceKill, broadcast: broadcastRemoval, budgetSeconds, attempts: 0,
      }));
    }

    // The removal prelude — fast and durable, order load-bearing. Each instance
    // is marked owed FIRST, fail CLOSED: the record and its ledger stay until the
    // teardown finishes, so a mark that could not be written aborts the removal
    // (it throws to the catch) before anything is condemned.
    // eslint-disable-next-line no-restricted-syntax
    for (const target of targets) {
      // eslint-disable-next-line no-await-in-loop
      await appRecords.installed().markOwed(appName, target.replica, target.owed);
      marked.push(target);
    }
    // Condemn every component (durable): the reconciler stands it down and never restarts
    // it, boot recovery re-stamps it, and the teardown reads it as safe to destroy. The
    // runtime-state row (carrying the stamp) is dropped LAST, by the teardown itself.
    // eslint-disable-next-line no-restricted-syntax
    for (const target of targets) {
      // eslint-disable-next-line no-restricted-syntax
      for (const c of target.components) {
        // eslint-disable-next-line no-await-in-loop
        await appsRuntimeState.setCondemned(c.identifier, true, { force: forceKill });
      }
    }
    // A concurrent install of this same app may be mid-flight (its image pull). Abort it
    // now that the owed marks + condemned stamps are durable: the install's pull rejects,
    // its catch sees installAborted/removalOwedFor and classifies the unwind as a
    // deferral (not a 7-day-poisoning failure), and its own rollback converges
    // idempotently with this teardown. No-op when no install is in flight.
    globalState.abortInstall(appName);

    // On an operator (foreground non-force) removal of an app still pinned to this node, clear
    // its spawn-throttle so the spawner reinstalls promptly instead of waiting out the ~12h
    // throttle (see clearSpawnThrottleForPinnedReinstall for the gating rationale).
    await clearSpawnThrottleForPinnedReinstall(appName, { forceKill, background });

    fluxEventBus.publish('app:removed', { name: appName });
    // Tell the network it's gone NOW — fire-and-forget, never blocking the prelude on a
    // broadcast — and drop it from the local running-apps cache.
    // A sibling replica keeps the app alive on this node: its containers still
    // run, so the running-name cache must survive - only the last identity's
    // removal clears it. (An old peer receiving the replica-tagged appremoved
    // clears its whole collapsed row; the sibling's next presence broadcast
    // recreates it within a cycle.)
    // The instances still hosted are the ones not marked owed — read from the
    // store rather than probed from docker, where an unreachable daemon would
    // read as "no siblings" and clear a running sibling.
    const lastReplica = (await appRecords.installed().instancesOf(appName)).length === 0;
    if (broadcastRemoval) {
      // An announcement cycle that read the table before this removal's mark still
      // names the app. Waiting for the cycle in flight puts the two on the wire in the
      // order they happened, so the claim is applied first and this message clears it.
      await waitForAnnouncementInFlight();
      const ip = await fluxNetworkHelper.getLocalSocketAddress();
      if (ip) {
        const appRemovedMessage = {
          type: 'fluxappremoved', version: 1, appName, ip, broadcastedAt: Date.now(),
          ...(replica != null ? { replica } : {}),
        };
        log.info('Broadcasting appremoved message to the network');
        fluxCommunicationMessagesSender.broadcastMessageToAll(appRemovedMessage)
          .catch((e) => log.warn(`appremoved broadcast failed: ${e.message}`));
        if (lastReplica) {
          const { runningAppsCache } = globalState;
          if (runningAppsCache.has(appName)) runningAppsCache.delete(appName);
        }
      } else {
        log.warn(`${appName} removed without announcing it - this node's own address is unknown, so peers hold its location row until it expires`);
      }
    }

    // Drive the deferred destructive teardown. A background removal (cancel/expiry) fires
    // it and returns now; a foreground removal (redeploy/rollback/REST) awaits it.
    teardownStarted = true;
    if (background) {
      // Hand the per-app 'remove' lease to the detached teardown so a same-name install is
      // deferred (isHeld) through the destructive rm -rf — the serialization the old
      // synchronous remove gave. Null the token so the finally no-ops; the detached chain
      // releases when the teardown finishes.
      const heldToken = removeToken;
      removeToken = null;
      runTeardowns(targets)
        .catch((e) => log.error(`Deferred teardown of ${appName} failed: ${e.message}`))
        .finally(() => operationRegistry.release(appName, heldToken));
      status(`Removal queued: Flux App ${appName} condemned; teardown deferred`);
    } else {
      await runTeardowns(targets, { onStatus });
      status(`Removal step done. Result: Flux App ${appName} was successfully removed`);
    }

    // Removing a workload may orphan a follower (a shared collector) it
    // depended on; removing a dependency cascaded its consumers above, which
    // can orphan sibling collectors. Sweep orphans once this removal settles -
    // deferred direct call, not an event subscription (the event bus is
    // publish-only test observability). Gated off in production.
    if (config.get('fluxapps.manageCollectorLifecycle')
      && (!await relationshipResolver.isPureFollowerApp(spec) || !forceKill)) {
      setImmediate(() => {
        removeUnrequiredDependencies().catch((error) => log.error(`Dependency cleanup trigger failed: ${error.message}`));
      });
    }
    return { status: UninstallStatus.REMOVED, reason: null };
  } catch (error) {
    log.error(`Error removing app ${appName}: ${error.message}`);
    status(`Error: ${error.message}`);
    // If an instance was already marked owed (the removal is committed) and the teardown
    // never started, drive it in-process rather than leaving it until the next boot recovery.
    if (marked.length && !teardownStarted) {
      runTeardowns(marked).catch((e) => log.error(`Recovery teardown of ${appName} failed: ${e.message}`));
    }
    return { status: UninstallStatus.FAILED, reason: error.message };
  } finally {
    operationRegistry.release(appName, removeToken);
    if (departing) globalState.departingApps.leave(departing.appName, departing.replica);
  }
}

/**
 * What one instance's teardown removes, as a plain descriptor: the records it
 * belongs to, and every component block the ledger holds. Built from the
 * records at removal and whenever the reconciler re-drives an owed instance.
 * @param {object} instance - the InstalledSpec
 * @param {object|null} ledger - the InstalledLedger, or null when the node never wrote one
 * @param {object} owed - the owed mark
 */
function teardownTarget(instance, ledger, owed) {
  return {
    name: instance.name,
    replica: instance.replica,
    identity: instance.identity,
    networkName: ledger?.network?.name ?? null,
    components: ledger
      ? Object.entries(ledger.components).map(([componentKey, block]) => ({ componentKey, ...block }))
      : [],
    owed,
    source: 'record',
  };
}

/**
 * The same descriptor from an owed-teardown record a release before the
 * ledger left: its components as that release captured them, each volume
 * image found once as the adoption finds one, each port as the node opens
 * ports now.
 * @param {object} doc - a pendingAppTeardowns record
 */
async function legacyTarget(doc) {
  const opened = [
    ...(await fluxNetworkHelper.isFirewallActive() ? ['ufw'] : []),
    ...(upnpService.isUPNP() ? ['upnp'] : []),
  ];
  const components = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const c of doc.components || []) {
    // eslint-disable-next-line no-await-in-loop
    const image = await installedLedger.discoverVolumeImage(c.identifier, null);
    components.push({
      // A release before the ledger ran no v9 app: each component is keyed by its name.
      componentKey: c.componentName,
      identifier: c.identifier,
      image: { reference: c.image ?? null, digest: null },
      hostPorts: (c.ports || []).map((port) => ({ port, opened })),
      volume: image ? {
        file: image.path, disk: null, fsUuid: image.fsUuid, mountDir: appsFolder + c.identifier,
      } : null,
      syncFolder: { id: c.identifier, path: appsFolder + c.identifier },
      aliases: [],
      mesh: null,
      tls: null,
    });
  }
  return {
    name: doc.name,
    replica: doc.replica ?? null,
    identity: doc.identity ?? null,
    networkName: doc.networkName ?? null,
    components,
    owed: {
      since: doc.createdAt ?? 0,
      reason: doc.reason ?? null,
      force: Boolean(doc.forceKill),
      broadcast: Boolean(doc.broadcastRemoval),
      budgetSeconds: doc.shutdownBudgetSeconds || 0,
      attempts: doc.attempts || 0,
    },
    source: 'legacy',
    legacyKey: doc.key,
  };
}

const targetKey = (target) => (target.source === 'legacy' ? `legacy:${target.legacyKey}` : appRecords.instanceKey(target));

/**
 * The deferred destructive teardown of one instance, single-flight: a second
 * concurrent teardown of the same instance would double stop/remove/rm-rf and
 * race the owed mark, so it is skipped.
 * @param {object} target - from teardownTarget or legacyTarget
 * @param {object} [opts]
 * @param {Function|null} [opts.onStatus] - progress callback (the foreground REST path)
 */
async function runTeardown(target, opts = {}) {
  const key = targetKey(target);
  if (teardownsInProgress.has(key)) {
    log.warn(`runTeardown: a teardown of ${target.name} is already in progress; skipping the concurrent one`);
    return;
  }
  teardownsInProgress.add(key);
  try {
    await executeTeardown(target, opts);
  } finally {
    teardownsInProgress.delete(key);
  }
}

async function runTeardowns(targets, opts = {}) {
  // eslint-disable-next-line no-restricted-syntax
  for (const target of targets) {
    // eslint-disable-next-line no-await-in-loop
    await runTeardown(target, opts);
  }
}

/**
 * The teardown still owed for an instance, or an owed-teardown record a
 * release before the ledger left; null when none is owed.
 * @param {{name: string, replica: string|null}|{legacyKey: string}} ref
 */
async function owedTarget(ref) {
  if (ref.legacyKey) {
    const doc = await pendingTeardownStore.getTeardown(ref.legacyKey);
    return doc ? legacyTarget(doc) : null;
  }
  const instance = await appRecords.installed().byReplica(ref.name, ref.replica, { includeOwed: true });
  if (!instance?.owed) return null;
  const ledger = await appRecords.ledgers().byInstance(ref.name, ref.replica);
  return teardownTarget(instance, ledger, instance.owed);
}

/**
 * Drive an instance's OWED teardown one step toward completion — the reconciler's
 * converge-to-gone actuator. "Gone" is a durable desired state: the owed mark on the
 * record (written by every permanent removal before anything is condemned) says this
 * instance must be fully torn down. Rather than that mark only being re-driven at the
 * next boot, the reconciler calls this on every pass over a condemned component and
 * drives the (idempotent, single-flight) teardown until the records go. Returns a verdict:
 *   'none'     - nothing owed; the caller treats the component as genuinely uninstalled.
 *   'removed'  - the records went; the instance is fully gone (converged).
 *   'deferred' - a teardown is already in flight, or this pass left work owed; the caller
 *                retries with backoff (attempts drives the pacing).
 *
 * Takes the instance's name and replica, or the key of an owed-teardown record a
 * release before the ledger left. A caller holding a component resolves either
 * through the reconciler's appFor.
 * @param {{name: string, replica: string|null}|{legacyKey: string}} ref
 * @returns {Promise<{ status: 'none'|'removed'|'deferred', attempts: number }>}
 */
async function driveOwedTeardown(ref) {
  const target = await owedTarget(ref);
  if (!target) return { status: 'none', attempts: 0 };
  // A teardown of this instance is already running (the removal prelude's initial drive,
  // or a sibling reconcile pass). Let it finish; a quick retry observes its result.
  if (teardownsInProgress.has(targetKey(target))) return { status: 'deferred', attempts: target.owed.attempts };
  await runTeardown(target);
  // runTeardown takes the records ONLY when the instance is fully gone; a surviving mark
  // means this pass left work owed (a survivor, a host-cleanup blip) - pace the retry.
  const remaining = await owedTarget(ref);
  if (!remaining) return { status: 'removed', attempts: 0 };
  const attempts = remaining.owed.attempts + 1;
  if (remaining.source === 'legacy') await pendingTeardownStore.bumpAttempts(remaining.legacyKey);
  else await appRecords.installed().markOwed(remaining.name, remaining.replica, { ...remaining.owed, attempts });
  return { status: 'deferred', attempts };
}

// A component's destructive teardown (remove + host cleanup) holds the component
// 'removing' lease so a concurrent reconcile start ('actuating') defers instead of
// (re)creating the container mid-teardown. A start that beat us here holds the key, so
// the acquire fails while it runs. We do NOT race it (removing a container mid-create)
// nor drop it to boot recovery (an owed record only re-drives at restart, so the app
// would run un-condemned until then); instead we WAIT bounded for the lease to clear -
// the acquire succeeding is the concrete signal the start settled, never a fixed guess.
// Returns the lease token, or null if nothing settled within the budget (pathological:
// a leaked/stuck transition, force-released by its own TTL eventually).
const REMOVING_LEASE_WAIT_MS = 5000;
const REMOVING_LEASE_POLL_MS = 100;
async function acquireRemovingLease(dockerName, identifier) {
  const budgetNs = BigInt(REMOVING_LEASE_WAIT_MS) * 1_000_000n;
  const startNs = process.hrtime.bigint();
  for (;;) {
    const token = operationRegistry.acquire(dockerName, 'removing', 'appUninstaller', `teardown ${identifier}`);
    if (token) return token;
    if (process.hrtime.bigint() - startNs >= budgetNs) return null;
    // eslint-disable-next-line no-await-in-loop
    await serviceHelper.delay(REMOVING_LEASE_POLL_MS);
  }
}

/**
 * The instance is fully gone: its records go, or the owed-teardown record a
 * release before the ledger left is cleared. Once no instance of the app
 * remains, the app is gone for good: nothing reconciles an app with no record,
 * so its removal records have no reader left; a sibling keeps them.
 */
async function finishTeardown(target, status) {
  if (target.source === 'legacy') {
    await pendingTeardownStore.clearTeardown(target.legacyKey);
  } else {
    await appRecords.installed().remove(target.name, target.replica);
    await appRecords.ledgers().remove(target.name, target.replica);
  }
  const remaining = await appRecords.installed().keys(target.name, { includeOwed: true });
  if (remaining.length === 0) {
    dockerService.clearFluxRemovedContainers(target.components.map((c) => c.identifier));
    status('Database cleaned');
  }
}

/**
 * The deferred destructive teardown of one instance. Reads what its ledger names
 * (through the target built from it) and tears the instance down for good:
 * graceful stop OUTSIDE the node-wide lock (an unbounded wait must never serialize the
 * lock), then container removal + host cleanup + the cross-app network removal under
 * ONE hostMutationLock per app, then drops the condemned stamps and takes the records
 * LAST. Each component is isolated so one failure never abandons its siblings; the
 * records are taken only when every stamp dropped, so anything left is re-driven by
 * the reconciler and by boot recovery.
 *
 * @param {object} target - from teardownTarget or legacyTarget
 * @param {object} [opts]
 * @param {Function|null} [opts.onStatus] - progress callback (the foreground REST path)
 */
async function executeTeardown(target, { onStatus = null } = {}) {
  const {
    name, replica, identity, networkName, components: list, owed,
  } = target;
  // The identity the daemon knows the app by: its plan and its containers.
  const daemonIdentity = shutdownPlan.daemonIdentity(target);
  const forceKill = owed.force;
  const status = (msg) => { log.info(msg); if (onStatus) onStatus(msg); };

  // Route the stop through flux-shutdownd first: on Arcane it owns every app stop (a
  // graceful drain, or a zero-budget force), so the local stop below is skipped. On a
  // non-Arcane node, or when the daemon is unreachable, beginAppStop short-circuits and
  // the local stop does the work. A node-wide shutdown owning the node defers this
  // teardown to boot recovery (the node drain stops the app as it goes down).
  const stopReason = owed.reason || fluxShutdowndClient.SHUTDOWN_REASON.TTL_EXPIRED;
  const budgetSeconds = forceKill ? 0 : (owed.budgetSeconds || 0);
  const stopDeadline = Math.floor(Date.now() / 1000) + budgetSeconds;
  // While this graceful drain is in flight, let an operator's explicit force-remove
  // preempt it: the escalation force-stops the app via the daemon, resolving the
  // beginAppStop below with "forced" so the destructive cleanup proceeds at once. A
  // forceful teardown has nothing to escalate.
  if (!forceKill) {
    teardownEscalations.set(name, () => {
      fluxShutdowndClient.forceAppStop(daemonIdentity, replica).catch((e) => log.warn(`forceAppStop ${name}: ${e.message}`));
    });
  }
  const stop = await fluxShutdowndClient.beginAppStop(daemonIdentity, name, stopReason, {
    force: Boolean(forceKill),
    deadline: stopDeadline,
    replica,
  });
  teardownEscalations.delete(name);
  if (stop.outcome === 'rejected_pipeline_active') {
    status(`${name} teardown deferred: a node-wide shutdown owns the stop; boot recovery will re-drive`);
    return;
  }
  const daemonStopped = stop.outcome === 'complete' || stop.outcome === 'deadline'
    || stop.outcome === 'superseded' || stop.outcome === 'forced';

  // Stop OUTSIDE the lock (skipped when the daemon already did it): the container is
  // removed below, so stopping it first makes the remove a clean (non-SIGKILL) teardown
  // and releases its volume before the unmount.
  if (!daemonStopped) {
    status(`Stopping ${name} container(s)...`);
    // eslint-disable-next-line no-restricted-syntax
    for (const c of list) {
      if (forceKill) {
        // eslint-disable-next-line no-await-in-loop
        await dockerService.appDockerKill(c.identifier).catch((e) => log.warn(`kill ${c.identifier}: ${e.message}`));
      } else {
        // eslint-disable-next-line no-await-in-loop
        await dockerService.appDockerStop(c.identifier).catch((e) => log.warn(`stop ${c.identifier}: ${e.message}`));
      }
    }
  }

  // Destructive host teardown under ONE node-wide lock for the whole app, each
  // component through the shared teardown core (stopHandled: the stop landed
  // above, by the daemon or the local loop). The cross-app docker network
  // removal (networkWith consumers attach it) is serialized inside the same
  // lock. Only the lock's own resources (ufw / UPnP / image store / network)
  // run under it — the swap-pool reconcile runs after release.
  status(`Removing ${name} container(s) and host state...`);
  // The app's network, telemetry sink and content store are shared by every
  // replica of the app here, so they go only when this teardown takes the app
  // off the node: when no instance of it is still hosted (the ones being
  // removed are marked owed and do not count). A store that cannot answer
  // keeps them, and the janitor sweep removes a network no installed app owns.
  const appLeavesNode = await appRecords.installed().instancesOf(name)
    .then((hosted) => hosted.length === 0, (e) => {
      log.warn(`teardown ${name}: cannot read the hosted instances, keeping the app's shared state: ${e.message}`);
      return false;
    });
  // A component whose container is still present after the remove blocks taking the
  // records: destroying its volume under a live container would corrupt it, so the core
  // skips the cleanup and we leave the teardown owed (the reconciler re-checks the container is gone).
  let containerSurvived = false;
  let residueOwed = false;
  const survivedComponents = new Set();
  await withHostMutationLock(async () => {
    // eslint-disable-next-line no-restricted-syntax
    for (const c of list) {
      const label = c.componentKey === name ? name : `component ${c.componentKey} of ${name}`;
      // eslint-disable-next-line no-await-in-loop
      const { removed, cleanupFailed } = await teardownComponentCore(
        {
          identifier: c.identifier,
          appId: c.identifier,
          appName: name,
          identity,
          label,
          ports: c.hostPorts ?? [],
          volume: c.volume ?? null,
          syncFolder: c.syncFolder ?? null,
        },
        {
          forceKill, removeVolumes: true, stopHandled: true, onStatus,
        },
      );
      if (!removed) {
        containerSurvived = true;
        survivedComponents.add(c.identifier);
      } else if (cleanupFailed) {
        // The container went, so the component is NOT held hostage — but host
        // residue is still on disk and only the owed mark will retry it.
        residueOwed = true;
      }
    }
    // Reclaim the app's images (reference-gated) — an image-store mutation, so under the lock.
    await reclaimUnusedImages(list.map((c) => c.image?.reference), status);
    status('Cleaning up docker network...');
    // Force-disconnect any remaining endpoints before removing the network. The app's
    // own containers are already gone by here; the only endpoints left are foreign
    // consumers that linked to this app, and a plain removal fails on them ("active
    // endpoints"). A linked consumer stops desiring this departed network on its next
    // reconcile, so disconnecting it here is safe regardless of the teardown mode.
    if (appLeavesNode && networkName) {
      await dockerService.forceRemoveFluxAppDockerNetwork(null, { networkName }).catch((e) => log.error(`network removal ${networkName}: ${e.message}`));
    }
    // Mesh teardown: units, namespace, transport port, material. Keyed on the
    // registration identity and a no-op for apps with no mesh material; mesh
    // forbids co-location, so any removal of a mesh identity is the app
    // leaving this node.
    if (identity) {
      // The app leaves this node: its ordinal goes back to the register for
      // the next joiner. A restart is not a leave and keeps it.
      await meshOrdinals.releaseOrdinal(identity).catch((e) => log.error(`ordinal release ${identity}: ${e.message}`));
      await meshReconciler.removeAppMesh(identity).catch((e) => log.error(`mesh removal ${identity}: ${e.message}`));
    }
  });

  // Reclaim now-unneeded swap-pool capacity — self-serializing on its own chain and none
  // of the lock's resources, so it runs OUTSIDE the lock.
  await appSwapPoolService.reconcile().catch((e) => log.warn(`swap pool reconcile: ${e.message}`));

  // App-level, non-host cleanup.
  if (appLeavesNode) {
    appTamperingDetectionService.forgetApp(name);
    telemetrySinkCache.deleteSink(name);
  }
  // Scoped to the deployment this teardown owns: plans key identity[:replica],
  // so an untagged delete would look for a loose plan this app never had and
  // leave the departing replica's plan orphaned on the daemon.
  await fluxShutdowndClient.deleteAppPlanBestEffort(daemonIdentity, replica);
  // Drop the app's content-artifact store (the peer-served declared blobs). A
  // re-driven teardown just re-runs the no-op; a re-install refills it as
  // provisioning resolves the blobs.
  if (identity && appLeavesNode) await contentStore.removeApp(identity).catch((e) => log.warn(`content store removal ${name}: ${e.message}`));

  // FINISH — drop every component's runtime state (incl. the condemned stamp), then
  // take the records, but ONLY when every stamp dropped: a surviving stamp keeps the
  // owed mark so the teardown is re-driven (never orphan a condemned component).
  let allDropped = true;
  // eslint-disable-next-line no-restricted-syntax
  for (const c of list) {
    if (survivedComponents.has(c.identifier)) {
      // Its container still exists (or a transition never settled): keep the condemn
      // stamp + runtime state so the reconciler keeps refusing it and we never un-condemn
      // a live container. The owed mark re-drives it.
      allDropped = false;
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const dropped = await appsRuntimeState.remove(c.identifier);
    if (!dropped) allDropped = false;
    if (onComponentRemoved) onComponentRemoved(c.identifier);
  }
  if (allDropped && !containerSurvived && !residueOwed) {
    await finishTeardown(target, status);
  } else {
    // eslint-disable-next-line no-nested-ternary
    const why = containerSurvived ? 'a container survived removal'
      : (residueOwed ? 'host cleanup failed and its residue is still on disk'
        : 'a condemned stamp did not drop');
    log.warn(`Teardown of ${name}: ${why}; keeping the teardown owed`);
    // Hand the still-owed teardown back to the reconciler to CONVERGE (drive + retry with
    // backoff) instead of abandoning it until the next boot. Each component's owed
    // reconcile pass re-drives the teardown via driveOwedTeardown; single-flight and
    // the idempotent teardown make the fan-out safe.
    // eslint-disable-next-line no-restricted-syntax
    for (const c of list) {
      reconcilerQueue.enqueueComponent(c.identifier);
    }
  }
}

/**
 * Boot recovery: replay every owed teardown that survived a crash — each instance
 * marked owed, and each owed-teardown record a release before the ledger left. Runs
 * at boot BEFORE the reconciler starts: synchronously re-condemns every component (so
 * the reconciler refuses to start them from cycle 0), then hands them to the
 * reconciler to converge. An instance whose ledger names no component has nothing
 * for the reconciler to drive by, so its teardown runs here and takes the records. A
 * read that fails leaves the instances for the next boot rather than tearing down
 * on a guess.
 *
 * @returns {Promise<void>}
 */
async function recoverOwedTeardowns() {
  let owedInstances = [];
  try {
    owedInstances = await appRecords.installed().owed();
  } catch (err) {
    log.warn(`Boot recovery: the owed instances could not be read, deferring their teardowns: ${err.message}`);
  }
  const legacyDocs = await pendingTeardownStore.readAllTeardowns();
  if (!owedInstances.length && !legacyDocs.length) return;
  log.info(`Boot recovery: ${owedInstances.length + legacyDocs.length} owed teardown(s) to replay`);

  const toDrive = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const instance of owedInstances) {
    // eslint-disable-next-line no-await-in-loop
    const ledger = await appRecords.ledgers().byInstance(instance.name, instance.replica);
    const identifiers = ledger?.identifiers() ?? [];
    // eslint-disable-next-line no-restricted-syntax
    for (const identifier of identifiers) {
      // eslint-disable-next-line no-await-in-loop
      await appsRuntimeState.setCondemned(identifier, true, { force: instance.owed.force });
    }
    toDrive.push({ identifiers, target: identifiers.length ? null : teardownTarget(instance, ledger, instance.owed) });
  }
  // eslint-disable-next-line no-restricted-syntax
  for (const doc of legacyDocs) {
    const identifiers = (doc.components || []).map((c) => c.identifier);
    // eslint-disable-next-line no-restricted-syntax
    for (const identifier of identifiers) {
      // eslint-disable-next-line no-await-in-loop
      await appsRuntimeState.setCondemned(identifier, true, { force: doc.forceKill });
    }
    toDrive.push({ identifiers, target: null });
  }

  // Hand the owed teardowns to the reconciler to CONVERGE — it drives each to completion
  // and retries with backoff on a partial pass, instead of a one-shot boot drive that
  // abandons a partial failure until the NEXT boot. The synchronous re-condemn above keeps
  // the run-state path off these components until the boot gate opens and these enqueues
  // (held in bootPending until then) drain into the reconciler's owed-teardown path.
  toDrive.forEach(({ identifiers, target }) => {
    identifiers.forEach((identifier) => reconcilerQueue.enqueueComponent(identifier));
    if (target) runTeardown(target).catch((e) => log.error(`Boot recovery teardown of ${target.name} failed: ${e.message}`));
  });
}

/**
 * API endpoint for removing application locally
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
async function removeAppLocallyApi(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;

    if (!appname) {
      throw new Error('No Flux App specified');
    }

    if (appname.includes('_')) {
      throw new Error('Components cannot be removed manually');
    }

    let { global } = req.params;
    global = global || req.query.global || false;
    global = serviceHelper.ensureBoolean(global);

    let { force } = req.params;
    force = force || req.query.force || false;
    force = serviceHelper.ensureBoolean(force);

    // The node operator is deliberately NOT here. Hosting an app is not owning it:
    // an operator who can remove one can script the removal against every install
    // and keep a customer's app off their node indefinitely, which the customer
    // experiences as an app that will not stay deployed and cannot diagnose.
    // Ending an app is the owner's call, or the team's on their behalf.
    //
    // One gate, and vetted status does not narrow it further: appownerorfluxteam
    // admits exactly {owner, fluxTeam, fluxSupport}, which is who may uninstall a
    // vetted app too. A second check against the same set can only ever agree, and
    // asking it costs two database reads and a vetted lookup per uninstall.
    const authorized = await verificationHelper.verifyPrivilege(Privilege.APP_OWNER_OR_FLUX_TEAM, authOf(req), { appName: appname });
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      return res.json(errMessage);
    }

    if (global) {
      globalCommand.executeAppGlobalCommand(appname, 'appremove', authOf(req)); // do not wait
      const appResponse = messageHelper.createSuccessMessage(`${appname} queried for global reinstallation`);
      return res.json(appResponse);
    }

    res.setHeader('Content-Type', 'application/json');

    await uninstallApplication(appname, {
      forceKill: force,
      skipGuard: force,
      // The operator explicitly asked to force: this is the one caller allowed to
      // preempt an in-flight graceful drain (escalate it) rather than defer.
      operatorForce: force,
      broadcastRemoval: true,
      onStatus: (msg) => {
        res.write(serviceHelper.ensureString(msg));
        if (res.flush) res.flush();
      },
    });
    res.end();
    return undefined;
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    return res.json(errorResponse);
  }
}

module.exports = {
  UninstallStatus,
  uninstallApplication,
  uninstallComponent,
  denyPorts,
  removeAppLocallyApi,
  setOnComponentRemoved,
  runTeardown,
  driveOwedTeardown,
  recoverOwedTeardowns,
  clearSpawnThrottleForPinnedReinstall,
  removeUnrequiredDependencies,
  // exposed for tests
  reclaimUnusedImages,
};
