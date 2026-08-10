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
const telemetryConfigService = require('../telemetryConfigService');
const log = require('../../lib/log');
const config = require('config');
const upnpService = require('../upnpService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
const { socketAddressesMatch } = require('../utils/socketAddressUtils');
const appsRepository = require('../appDatabase/appsRepository');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const generalService = require('../generalService');
const relationshipResolver = require('./relationshipResolver');
const contentStore = require('./contentStore');
const appSwapPoolService = require('./appSwapPoolService');
const { stopAppMonitoring } = require('../appManagement/appInspector');
const appsRuntimeState = require('../appManagement/appsRuntimeState');
const globalCommand = require('../appManagement/globalCommand');
const volumeService = require('../utils/volumeService');
const fluxEventBus = require('../utils/fluxEventBus');
const fluxShutdowndClient = require('../utils/fluxShutdowndClient');
const pendingTeardownStore = require('./pendingTeardownStore');
const meshReconciler = require('../appMesh/meshReconciler');
const imageCacheRetention = require('./imageCacheRetention');
const shutdownPlan = require('./shutdownPlan');
const reconcilerQueue = require('../appMonitoring/reconcilerQueue');
const syncthingMonitorHelpers = require('../appMonitoring/syncthingMonitorHelpers');
const { withHostMutationLock } = require('../utils/hostMutationLock');

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
// serviceManager wires it to appReconciler.clearControllerDesired so the
// reconciler's in-memory controller verdict dies with the component - a
// back-require of appReconciler here would capture a stale partial export
// (appReconciler already requires this module and both replace module.exports).
let onComponentRemoved = null;
function setOnComponentRemoved(callback) {
  onComponentRemoved = callback;
}

/**
 * Stop Syncthing app and clean up cache
 * @param {string} monitoredName - Monitored app name
 * @param {string} appId - Application ID
 * @returns {Promise<void>}
 */
async function stopSyncthingAndCleanup(monitoredName, appId) {
  try {
    await syncthingMonitorHelpers.removeSyncthingFolder(monitoredName);

    // The folder and its data are going, so the cache entry must go with them:
    // a stale mark would make the next install of this name read as already-synced
    // eslint-disable-next-line no-shadow, global-require
    const globalState = require('../utils/globalState');
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
 * @returns {Promise<void>}
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
  const result = await serviceHelper.runCommand('rm', { params: ['-rf', appsFolder + appId], runAsRoot: true, logError: false });
  if (result.error) {
    log.error(result.error);
    status(`An error occured while cleaning ${entityName} data. Continuing...`);
  }
  status(`Data of ${entityName} cleaned`);
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
 * @returns {Promise<void>}
 */
async function cleanupVolumePath(volumepath, options = {}) {
  if (!volumepath) return;
  const { entityName = volumepath, onStatus = null } = options;
  const status = (msg) => {
    log.info(msg);
    if (onStatus) onStatus(msg);
  };

  status(`Cleaning up data volume of ${entityName}...`);
  const result = await serviceHelper.runCommand('rm', { params: ['-rf', volumepath], runAsRoot: true, logError: false });
  if (result.error) {
    log.error(result.error);
    status(`An error occured while cleaning ${entityName} volume. Continuing...`);
  }
  status(`Volume of ${entityName} cleaned`);
}

/**
 * Deny a set of host ports on the firewall (ufw) and the router (UPnP) — leaf host
 * mutations on the shared firewall ruleset / IGD session, so the deferred teardown
 * worker calls this from inside the node-wide hostMutationLock; pass the bare port list
 * so the worker can deny ports off the durable teardown descriptor without a live
 * deployComp. Also used by a redeploy's port-delta reconcile to close only the removed
 * ports. Progress goes through onStatus — the API handler owns the response stream.
 * @param {number[]} ports - host ports to deny
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
  const firewallActive = await fluxNetworkHelper.isFirewallActive();
  const isUPNP = upnpService.isUPNP();
  // eslint-disable-next-line no-restricted-syntax
  for (const port of (ports || [])) {
    if (firewallActive) {
      // eslint-disable-next-line no-await-in-loop
      await fluxNetworkHelper.deleteAllowPortRule(port);
    }
    if (isUPNP) {
      // eslint-disable-next-line no-await-in-loop
      await upnpService.removeMapUpnpPort(port, `Flux_App_${appName}`);
    }
  }
  status(`Ports of ${entityName} denied`);
}

/**
 * Close a component's full host-port set — the normal teardown path.
 * @param {object} deployComp - DeploymentComponent (carries appName + hostPorts)
 * @param {object} [options]
 * @param {string} [options.entityName] - label for progress messages (defaults to the app name)
 * @param {Function|null} [options.onStatus] - progress callback
 */
async function cleanupDeploymentPorts(deployComp, options = {}) {
  const { entityName = deployComp.appName, onStatus = null } = options;
  await denyPorts(deployComp.hostPorts, deployComp.appName, { entityName, onStatus });
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
 * Uninstall a single component: stop (or kill) and remove its container, deny
 * its ports, optionally tear down volumes/syncthing/crontab. Image cleanup is
 * app-level and reference-gated (see reclaimUnusedImages, called by
 * uninstallApplication). Driven off the normalized DeploymentSpec component.
 *
 * @param {import('@runonflux/flux-spec-backend').DeploymentComponent} component
 * @param {object} [options]
 * @param {boolean} [options.removeVolumes=false] - tear down volumes, syncthing, crontab
 * @param {boolean} [options.forceKill=false] - docker kill + force-remove instead of stop + remove
 * @param {boolean} [options.skipPorts=false] - leave ufw/UPnP rules in place (a redeploy reconciles the port delta itself)
 * @param {Function|null} [options.onStatus] - progress callback
 */
async function uninstallComponent(component, options = {}) {
  const removeVolumes = options.removeVolumes || false;
  const forceKill = options.forceKill || false;
  // skipPorts: a redeploy keeps the app's ufw/UPnP rules and moves only the port delta
  // itself, so the teardown half must not deny this component's ports (an unchanged port
  // set would otherwise flap every rule, ~1s/port of UPnP router pacing). Normal removal
  // leaves it false and denies all ports as before.
  const skipPorts = options.skipPorts || false;
  const onStatus = options.onStatus || null;

  const { appName } = component;
  const componentName = component.name;
  const appId = dockerService.getAppIdentifier(component.identifier);
  const label = componentName === appName ? appName : `component ${componentName} of ${appName}`;

  const status = (msg) => {
    log.info(msg);
    if (onStatus) onStatus(msg);
  };

  status(`Stopping Flux App ${label}...`);
  stopAppMonitoring(component.identifier, removeVolumes);

  if (forceKill) {
    await dockerService.appDockerKill(appId).catch((error) => {
      log.warn(`Failed to kill container ${appId}: ${error.message}`);
    });
  } else {
    await dockerService.appDockerStop(appId).catch((error) => {
      log.warn(`Failed to stop container ${appId}: ${error.message}`);
    });
  }

  status(`Flux App ${label} stopped`);

  if (removeVolumes) {
    await stopSyncthingAndCleanup(component.identifier, appId);
  }

  status(`Removing Flux App ${label} container...`);

  let containerRemoved = false;
  if (forceKill) {
    await dockerService.appDockerForceRemove(appId).then(() => {
      containerRemoved = true;
    }).catch((error) => {
      log.error(`Force remove failed for ${appId}: ${error.message}`);
    });
  } else {
    await dockerService.appDockerRemove(appId).then(() => {
      containerRemoved = true;
    }).catch((error) => {
      log.error(`Container remove failed for ${appId}: ${error.message}`);
    });
  }

  if (containerRemoved) {
    status(`Flux App ${label} container removed`);
  } else {
    log.warn(`WARNING: Container ${appId} may not have been fully removed`);
  }

  if (!skipPorts) {
    await cleanupDeploymentPorts(component, { entityName: label, onStatus });
  }

  if (removeVolumes) {
    await unmountVolume(appId, { entityName: label, onStatus });
    await cleanupAppData(appId, { entityName: label, onStatus });
    await cleanupCrontab(appId, { onStatus });
    const volumepath = await volumeService.getVolumeFilePath(appId);
    await cleanupVolumePath(volumepath, { entityName: label, onStatus });
    // Reclaim now-unneeded app-swap pool capacity (idempotent; no-op without the
    // new-mechanism host config). The container is already gone, so its swap pages
    // are freed and an emptied chunk can be swapped off + removed.
    await appSwapPoolService.reconcile();
  }

  status(`Flux App ${label} was successfully removed`);
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
  const globalSpec = await appsRepository.getGlobalAppInfo(appName);
  const placement = globalSpec && globalSpec.placement;
  if (!placement || !placement.hasTargets()) return;
  const localSocketAddress = await fluxNetworkHelper.getLocalSocketAddress();
  if (!localSocketAddress || !placement.isPinnedTo({ ip: localSocketAddress, ipMatcher: socketAddressesMatch })) return;
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
async function removeRequiringWorkloadsFirst(appName) {
  if (!appName) {
    return true;
  }
  const workloads = await relationshipResolver.findCascadeWorkloadsRequiring(appName);
  let allRemoved = true;
  // eslint-disable-next-line no-restricted-syntax
  for (const workload of workloads) {
    log.info(`Reverse dependency cascade: uninstalling workload ${workload.name} before its dependency ${appName}`);
    // forceKill=false honours the graceful drain; broadcastRemoval tells the network.
    // eslint-disable-next-line no-await-in-loop, no-use-before-define
    const result = await uninstallApplication(workload.name, { forceKill: false, broadcastRemoval: true });
    // A workload mid-operation (redeploy/backup/install) DEFERS - it will resume as a
    // live consumer, so its dependency must not be torn down under it (that leaves the
    // workload's post-teardown re-verify throwing with its own containers already gone).
    // A FAILED workload has already committed its teardown (record owed) and won't
    // resume, so it does not block the dependency.
    if (result && result.status === UninstallStatus.DEFERRED) {
      log.warn(`Reverse dependency cascade: workload ${workload.name} is mid-operation (deferred); deferring teardown of ${appName}`);
      allRemoved = false;
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
  // Hoisted: the durable teardown record (set once the prelude persists it) + whether the
  // deferred teardown has started — so the catch can drive a committed-but-interrupted
  // teardown in-process without re-driving one that already began.
  let teardownDoc = null;
  let teardownStarted = false;
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

    let spec = await appsRepository.getInstalledApp(appName);
    if (!spec) {
      if (!skipGuard) {
        status('Flux App not found');
        return { status: UninstallStatus.SKIPPED, reason: 'Flux App not found' };
      }
      spec = await appsRepository.getGlobalAppInfo(appName);
      if (!spec) {
        const globalApps = await appsRepository.listGlobalAppInfo();
        const localApps = await appsRepository.listInstalledApps();
        spec = [...globalApps, ...localApps].find((a) => a.name === appName) || null;
        if (!spec) {
          const appMessages = await appsRepository.listAppMessagesByName(appName);
          let latest;
          appMessages.forEach((message) => {
            if (!latest || message.height > latest.height) latest = message;
          });
          if (latest && latest.height) {
            const result = await appsRepository.getAppMessage(latest.hash);
            if (result) ({ spec } = result);
          }
        }
      }
    }

    if (!spec) {
      status('Flux App not found');
      return { status: UninstallStatus.SKIPPED, reason: 'Flux App not found' };
    }

    // onRemove cascade: before tearing this app down, gracefully uninstall
    // every installed app whose edges declare it must not outlive this one
    // (cascade chains; transitionally also every workload of a pure-follower
    // target — the v8 model). Fires on graceful removals only, cancel/expiry
    // included; a plain force-kill is an emergency teardown and does not
    // cascade. Runs before this app's teardown record exists, so each nested
    // removal is an ordinary standalone removal. Gated off in production: the
    // flux console owns the collector lifecycle.
    if (config.fluxapps.manageCollectorLifecycle && !forceKill) {
      const workloadsRemoved = await removeRequiringWorkloadsFirst(appName);
      if (!workloadsRemoved) {
        // A consumer that still requires this follower could not be removed yet
        // (it is mid-operation). Defer this teardown - it runs before the prelude,
        // so nothing is torn down - and retry on the next trigger.
        status(`Removal of ${appName} deferred: a workload still requiring it could not be removed yet`);
        return { status: UninstallStatus.DEFERRED, reason: `A workload requiring ${appName} could not be removed yet` };
      }
    }

    // Capture each component's teardown descriptors off the normalized deployment. The
    // durable record below carries everything the deferred worker needs, so the local
    // install row can be deleted up front (every reader then sees the app as gone). An
    // app whose deployment can't be built falls back to one best-effort descriptor.
    // A replica-targeted removal captures THAT identity's view (qualified
    // identifiers), so the teardown touches only its containers and volumes. A
    // whole-app removal captures every identity this node owes
    // (deploymentProvider.localIdentities: assigned replicas, or the ones
    // actually present when the spec no longer targets this node).
    let deployments = [];
    try {
      const identities = replica !== undefined ? [replica] : await deploymentProvider.localIdentities(spec);
      // eslint-disable-next-line no-restricted-syntax
      for (const identity of identities) {
        // eslint-disable-next-line no-await-in-loop
        const deployment = await deploymentProvider.buildDeployment(spec, { replica: identity });
        if (deployment) deployments.push(deployment);
      }
    } catch (err) {
      log.warn(`uninstall ${appName}: deployment build failed (${err.message}); using best-effort descriptor`);
      deployments = [];
    }
    const components = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const deployment of deployments) {
      // eslint-disable-next-line no-restricted-syntax
      for (const [, c] of deployment.componentEntries({ reverse: true })) {
        components.push({
          identifier: c.identifier,
          appId: dockerService.getAppIdentifier(c.identifier),
          componentName: c.name,
          label: c.name === appName ? appName : `component ${c.name} of ${appName}`,
          ports: c.hostPorts || [],
          image: c.image || null,
        });
      }
    }
    if (components.length === 0) {
      components.push({
        identifier: appName, appId: dockerService.getAppIdentifier(appName), componentName: appName, label: appName, ports: [], image: null,
      });
    }

    // The durable owed-teardown record — the crash-safe handoff to the deferred worker.
    // A replica-targeted removal keys its own record so a sibling's teardown can
    // coexist; `name` stays the app for the owed-teardown install gate.
    teardownDoc = {
      key: replica != null ? `${appName}_${replica}` : appName,
      name: appName,
      replica: replica ?? null,
      networkName: appName,
      forceKill,
      broadcastRemoval,
      owner: spec.owner,
      // The registration identity, for mesh teardown (a mesh app's namespace,
      // units and material are keyed on it; null for pre-identity installs).
      identity: spec.identity ?? null,
      // The stop reason + budget the deferred teardown hands flux-shutdownd. Persisted
      // because the authoritative spec may be gone by teardown time.
      reason,
      shutdownBudgetSeconds: deployments[0] ? shutdownPlan.appShutdownBudgetSeconds(deployments[0]) : 0,
      createdAt: Date.now(),
      attempts: 0,
      components,
    };

    // The removal prelude — fast and durable, order load-bearing.
    // Persist the owed-teardown record FIRST and fail CLOSED: once the local install row
    // is gone (below) this record is the SOLE record of the cleanup owed, so a write
    // failure must abort the removal (it throws to the catch) before any row delete.
    await pendingTeardownStore.writeTeardown(teardownDoc);
    // Condemn every component (durable): the reconciler stands it down and never restarts
    // it, boot recovery re-stamps it, and the worker reads it as safe to destroy. The
    // runtime-state row (carrying the stamp) is dropped LAST, by the teardown itself.
    // eslint-disable-next-line no-restricted-syntax
    for (const c of components) {
      // eslint-disable-next-line no-await-in-loop
      await appsRuntimeState.setCondemned(c.identifier, true, { force: forceKill });
    }
    // A concurrent install of this same app may be mid-flight (its image pull). Abort it
    // now that the owed-teardown doc + condemned stamps are durable: the install's pull
    // rejects, its catch sees installAborted/teardownOwedFor and classifies the unwind as
    // a deferral (not a 7-day-poisoning failure), and its own rollback converges
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
    // This identity's row goes first, so what remains IS the sibling set — read
    // from the store rather than probed from docker, where an unreachable
    // daemon would read as "no siblings" and delete a running sibling's row.
    await appsRepository.removeInstalledIdentity(appName, replica ?? null);
    const lastReplica = await appsRepository.countInstalledIdentities(appName) === 0;
    if (broadcastRemoval) {
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
      }
    }
    if (lastReplica) {
      // Belt-and-braces: this identity's row is already gone, so this clears any
      // row a partially-failed earlier removal left behind, and every reader
      // sees the app as gone with zero filtering.
      await appsRepository.removeInstalledApp(appName);
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
      runTeardown(teardownDoc)
        .catch((e) => log.error(`Deferred teardown of ${appName} failed: ${e.message}`))
        .finally(() => operationRegistry.release(appName, heldToken));
      status(`Removal queued: Flux App ${appName} condemned; teardown deferred`);
    } else {
      await runTeardown(teardownDoc, { onStatus });
      status(`Removal step done. Result: Flux App ${appName} was successfully removed`);
    }

    // Removing a workload may orphan a follower (a shared collector) it
    // depended on; removing a dependency cascaded its consumers above, which
    // can orphan sibling collectors. Sweep orphans once this removal settles -
    // deferred direct call, not an event subscription (the event bus is
    // publish-only test observability). Gated off in production.
    if (config.fluxapps.manageCollectorLifecycle
      && (!await relationshipResolver.isPureFollowerApp(spec) || !forceKill)) {
      setImmediate(() => {
        removeUnrequiredDependencies().catch((error) => log.error(`Dependency cleanup trigger failed: ${error.message}`));
      });
    }
    return { status: UninstallStatus.REMOVED, reason: null };
  } catch (error) {
    log.error(`Error removing app ${appName}: ${error.message}`);
    status(`Error: ${error.message}`);
    // If the owed-teardown record was already persisted (the removal is committed — the
    // local row may already be gone) and the teardown never started, drive it in-process
    // rather than leaving an orphan until the next boot recovery.
    if (teardownDoc && !teardownStarted) {
      runTeardown(teardownDoc).catch((e) => log.error(`Recovery teardown of ${appName} failed: ${e.message}`));
    }
    return { status: UninstallStatus.FAILED, reason: error.message };
  } finally {
    operationRegistry.release(appName, removeToken);
  }
}

/**
 * The deferred destructive teardown. Reads a durable owed-teardown record (from the
 * removal prelude, or replayed by boot recovery) and tears the app down for good:
 * graceful stop OUTSIDE the node-wide lock (an unbounded wait must never serialize the
 * lock), then container removal + host cleanup + the cross-app network removal under
 * ONE hostMutationLock per app, then drops the condemned stamps and clears the record
 * LAST. Each component is isolated so one failure never abandons its siblings; the
 * record is cleared only when every stamp dropped, so anything left is re-driven by
 * boot recovery.
 *
 * @param {object} doc - a pendingAppTeardowns record
 * @param {object} [opts]
 * @param {Function|null} [opts.onStatus] - progress callback (the foreground REST path)
 */
async function runTeardown(doc, opts = {}) {
  const { key, name } = doc;
  // Single-flight per app: refuse a second concurrent destructive teardown of the
  // same app (it would double stop/remove/rm-rf and race the crash-recovery record).
  if (teardownsInProgress.has(key)) {
    log.warn(`runTeardown: a teardown of ${name} is already in progress; skipping the concurrent one`);
    return;
  }
  teardownsInProgress.add(key);
  try {
    await executeTeardown(doc, opts);
  } finally {
    teardownsInProgress.delete(key);
  }
}

/**
 * Drive an app's OWED teardown one step toward completion — the reconciler's
 * converge-to-gone actuator. "Gone" is a durable desired state: an owed-teardown record
 * (written by every permanent removal before it deletes the local row) says this app
 * must be fully torn down. Rather than that record only being re-driven at the next boot,
 * the reconciler calls this on every pass over a row-deleted component and drives the
 * (idempotent, single-flight) teardown until the record clears. Returns a verdict:
 *   'none'     - nothing owed; the caller treats the component as genuinely uninstalled.
 *   'removed'  - the owed record cleared; the app is fully gone (converged).
 *   'deferred' - a teardown is already in flight, or this pass left work owed; the caller
 *                retries with backoff (attempts drives the pacing).
 *
 * Takes the RECORD KEY, which is the app name only for a loose removal — a replica-targeted
 * one keys its own record `<app>_<replica>` so siblings can be torn down independently. A
 * caller holding a component rather than a key resolves it with
 * pendingTeardownStore.teardownForComponent.
 * @param {string} key
 * @returns {Promise<{ status: 'none'|'removed'|'deferred', attempts: number }>}
 */
async function driveOwedTeardown(key) {
  const doc = await pendingTeardownStore.getTeardown(key);
  if (!doc) return { status: 'none', attempts: 0 };
  // A teardown of this app is already running (the removal prelude's initial drive, or a
  // sibling reconcile pass). Let it finish; a quick retry observes its result.
  if (teardownsInProgress.has(key)) return { status: 'deferred', attempts: doc.attempts || 0 };
  await runTeardown(doc);
  // runTeardown clears the owed record ONLY when the app is fully gone; a surviving record
  // means this pass left work owed (a survivor, a host-cleanup blip) - pace the retry.
  const remaining = await pendingTeardownStore.getTeardown(key);
  if (!remaining) return { status: 'removed', attempts: 0 };
  await pendingTeardownStore.bumpAttempts(key);
  return { status: 'deferred', attempts: (remaining.attempts || 0) + 1 };
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
  const budgetNs = BigInt(REMOVING_LEASE_WAIT_MS) * 1000000n;
  const startNs = process.hrtime.bigint();
  for (;;) {
    const token = operationRegistry.acquire(dockerName, 'removing', 'appUninstaller', `teardown ${identifier}`);
    if (token) return token;
    if (process.hrtime.bigint() - startNs >= budgetNs) return null;
    // eslint-disable-next-line no-await-in-loop
    await serviceHelper.delay(REMOVING_LEASE_POLL_MS);
  }
}

async function executeTeardown(doc, { onStatus = null } = {}) {
  const {
    key, name, networkName, forceKill, owner, components, reason, shutdownBudgetSeconds, identity,
  } = doc;
  // The identity this teardown owns: a replica name scopes the daemon stop to
  // exactly its containers (a scale-down must not drain the sibling); null is
  // the whole-app stop (loose, and full removals of pre-qualification installs).
  const replica = doc.replica ?? null;
  const list = components || [];
  const status = (msg) => { log.info(msg); if (onStatus) onStatus(msg); };

  // Route the stop through flux-shutdownd first: on Arcane it owns every app stop (a
  // graceful drain, or a zero-budget force), so the local stop below is skipped. On a
  // non-Arcane node, or when the daemon is unreachable, beginAppStop short-circuits and
  // the local stop does the work. A node-wide shutdown owning the node defers this
  // teardown to boot recovery (the node drain stops the app as it goes down).
  const stopReason = reason || fluxShutdowndClient.SHUTDOWN_REASON.TTL_EXPIRED;
  const budgetSeconds = forceKill ? 0 : (shutdownBudgetSeconds || 0);
  const stopDeadline = Math.floor(Date.now() / 1000) + budgetSeconds;
  // While this graceful drain is in flight, let an operator's explicit force-remove
  // preempt it: the escalation force-stops the app via the daemon, resolving the
  // beginAppStop below with "forced" so the destructive cleanup proceeds at once. A
  // forceful teardown has nothing to escalate.
  if (!forceKill) {
    teardownEscalations.set(name, () => {
      fluxShutdowndClient.forceAppStop(owner, name, replica).catch((e) => log.warn(`forceAppStop ${name}: ${e.message}`));
    });
  }
  const stop = await fluxShutdowndClient.beginAppStop(owner, name, stopReason, {
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
  status(`Stopping ${name} container(s)...`);
  // eslint-disable-next-line no-restricted-syntax
  for (const c of list) {
    stopAppMonitoring(c.identifier, true);
    if (daemonStopped) continue; // flux-shutdownd already stopped it on Arcane
    if (forceKill) {
      // eslint-disable-next-line no-await-in-loop
      await dockerService.appDockerKill(c.appId).catch((e) => log.warn(`kill ${c.appId}: ${e.message}`));
    } else {
      // eslint-disable-next-line no-await-in-loop
      await dockerService.appDockerStop(c.appId).catch((e) => log.warn(`stop ${c.appId}: ${e.message}`));
    }
  }

  // Destructive host teardown under ONE node-wide lock for the whole app. Each component
  // is isolated (a throw in one never skips the others); the cross-app docker network
  // removal (networkWith consumers attach it) is serialized inside the same lock. Only the
  // lock's own resources (ufw / UPnP / image store / network) run under it — the swap-pool
  // reconcile runs after release.
  status(`Removing ${name} container(s) and host state...`);
  // A component whose container is still present after the remove blocks clearing the owed
  // record: destroying its volume under a live container would corrupt it, so we skip the
  // cleanup and leave the teardown for boot recovery (which re-checks the container is gone).
  let containerSurvived = false;
  const survivedComponents = new Set();
  await withHostMutationLock(async () => {
    // eslint-disable-next-line no-restricted-syntax
    for (const c of list) {
      // Hold the component's 'removing' lease across remove + host cleanup so a reconcile
      // start can't (re)create the container mid-teardown; wait bounded for an in-flight
      // start to settle rather than racing it.
      // eslint-disable-next-line no-await-in-loop
      const removingToken = await acquireRemovingLease(c.appId, c.identifier);
      if (!removingToken) {
        containerSurvived = true;
        survivedComponents.add(c.identifier);
        log.error(`Teardown of ${c.identifier}: a container transition did not settle within ${REMOVING_LEASE_WAIT_MS}ms — deferring, keeping it owed and condemned for boot recovery`);
        // eslint-disable-next-line no-continue
        continue;
      }
      try {
        if (forceKill) {
          // eslint-disable-next-line no-await-in-loop
          await dockerService.appDockerForceRemove(c.appId).catch((e) => log.warn(`force remove ${c.appId}: ${e.message}`));
        } else {
          // eslint-disable-next-line no-await-in-loop
          await dockerService.appDockerRemove(c.appId).catch((e) => log.warn(`remove ${c.appId}: ${e.message}`));
        }
        // NEVER reclaim a component's host storage while its container still exists — a
        // failed remove would otherwise strand a live container with its volume unmounted
        // and data deleted. Decide on the container's ACTUAL presence (getDockerContainer
        // returns null when gone), not on the remove error; a presence check that itself
        // fails is treated as "still there" (never delete on uncertainty).
        let stillPresent;
        try {
          // eslint-disable-next-line no-await-in-loop
          stillPresent = Boolean(await dockerService.getDockerContainer(c.appId));
        } catch (probeErr) {
          stillPresent = true;
          log.warn(`Teardown of ${c.identifier}: could not confirm the container was removed (${probeErr.message}); keeping it owed`);
        }
        // A non-force teardown found the container still present: a reconcile start
        // completed after our pre-lock stop and before we took the 'removing' lease,
        // leaving it running. We hold the lease now, so no further start can intervene —
        // escalate to a force remove (its graceful window already elapsed in the stop
        // phase) rather than 409-looping to boot recovery.
        if (stillPresent && !forceKill) {
          // eslint-disable-next-line no-await-in-loop
          await dockerService.appDockerForceRemove(c.appId).catch((e) => log.warn(`force remove (escalated) ${c.appId}: ${e.message}`));
          try {
            // eslint-disable-next-line no-await-in-loop
            stillPresent = Boolean(await dockerService.getDockerContainer(c.appId));
          } catch (probeErr) {
            stillPresent = true;
            log.warn(`Teardown of ${c.identifier}: could not confirm the escalated removal (${probeErr.message}); keeping it owed`);
          }
        }
        if (stillPresent) {
          containerSurvived = true;
          survivedComponents.add(c.identifier);
          log.error(`Teardown of ${c.identifier}: container still present after remove — skipping destructive cleanup, keeping the teardown owed and condemned for retry`);
          // eslint-disable-next-line no-continue
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        await denyPorts(c.ports, name, { entityName: c.label });
        // eslint-disable-next-line no-await-in-loop
        await unmountVolume(c.appId, { entityName: c.label });
        // eslint-disable-next-line no-await-in-loop
        await cleanupAppData(c.appId, { entityName: c.label });
        // eslint-disable-next-line no-await-in-loop
        await cleanupCrontab(c.appId);
        // eslint-disable-next-line no-await-in-loop
        const volumepath = await volumeService.getVolumeFilePath(c.appId);
        // eslint-disable-next-line no-await-in-loop
        await cleanupVolumePath(volumepath, { entityName: c.label });
      } catch (err) {
        log.error(`Host teardown of ${c.identifier} failed (continuing): ${err.message}`);
      } finally {
        operationRegistry.release(c.appId, removingToken);
      }
    }
    // Reclaim the app's images (reference-gated) — an image-store mutation, so under the lock.
    await reclaimUnusedImages(list.map((c) => c.image), status);
    status('Cleaning up docker network...');
    // Force-disconnect any remaining endpoints before removing the network. The app's
    // own containers are already gone by here; the only endpoints left are foreign
    // consumers that linked to this app, and a plain removal fails on them ("active
    // endpoints"). A linked consumer stops desiring this departed network on its next
    // reconcile, so disconnecting it here is safe regardless of the teardown mode.
    await dockerService.forceRemoveFluxAppDockerNetwork(networkName).catch((e) => log.error(`network removal ${networkName}: ${e.message}`));
    // Mesh teardown: units, namespace, transport port, material. Keyed on the
    // registration identity and a no-op for apps with no mesh material; mesh
    // forbids co-location, so any removal of a mesh identity is the app
    // leaving this node.
    if (identity) {
      await meshReconciler.removeAppMesh(identity).catch((e) => log.error(`mesh removal ${identity}: ${e.message}`));
    }
  });

  // Reclaim now-unneeded swap-pool capacity — self-serializing on its own chain and none
  // of the lock's resources, so it runs OUTSIDE the lock.
  await appSwapPoolService.reconcile().catch((e) => log.warn(`swap pool reconcile: ${e.message}`));

  // App-level, non-host cleanup.
  telemetrySinkCache.deleteSink(name);
  if (!telemetrySinkCache.hasAnyTelemetryApps()) {
    await telemetryConfigService.remove().catch((e) => log.warn(`telemetry config remove: ${e.message}`));
  }
  // Scoped to the identity this teardown owns: plans key owner:app[:replica],
  // so an untagged delete would look for a loose plan this app never had and
  // leave the departing replica's plan orphaned on the daemon.
  if (owner) await fluxShutdowndClient.deleteAppPlanBestEffort(name, owner, replica);
  // Drop the app's content-artifact store (the peer-served declared blobs). A
  // re-driven teardown just re-runs the no-op; a re-install refills it as
  // provisioning resolves the blobs.
  await contentStore.removeApp(name).catch((e) => log.warn(`content store removal ${name}: ${e.message}`));

  // FINISH — drop every component's runtime state (incl. the condemned stamp), then
  // clear the durable record, but ONLY when every stamp dropped: a surviving stamp
  // keeps the record so boot recovery re-drives (never orphan a condemned component).
  let allDropped = true;
  // eslint-disable-next-line no-restricted-syntax
  for (const c of list) {
    if (survivedComponents.has(c.identifier)) {
      // Its container still exists (or a transition never settled): keep the condemn
      // stamp + runtime state so the reconciler keeps refusing it and we never un-condemn
      // a live container. The owed record re-drives it at boot recovery.
      allDropped = false;
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const dropped = await appsRuntimeState.remove(c.identifier);
    if (!dropped) allDropped = false;
    if (onComponentRemoved) onComponentRemoved(c.identifier);
  }
  if (allDropped && !containerSurvived) {
    await pendingTeardownStore.clearTeardown(key);
  } else {
    log.warn(`Teardown of ${name}: ${containerSurvived ? 'a container survived removal' : 'a condemned stamp did not drop'}; keeping the teardown record owed`);
    // Hand the still-owed teardown back to the reconciler to CONVERGE (drive + retry with
    // backoff) instead of abandoning it until the next boot. Each component's null-spec
    // reconcile pass re-drives the owed record via driveOwedTeardown; single-flight and
    // the idempotent teardown make the fan-out safe.
    // eslint-disable-next-line no-restricted-syntax
    for (const c of list) {
      reconcilerQueue.enqueue(c.identifier);
    }
  }
}

/**
 * Boot recovery: replay every owed teardown that survived a crash. Runs at boot
 * BEFORE the reconciler starts — synchronously re-condemns every component (so the
 * reconciler refuses to start them from cycle 0), then drives the teardowns in the
 * background. Guards: if the app's local row is BACK (a re-install beat recovery) the
 * record is dropped and the components un-condemned with NO teardown (never rm -rf a
 * live re-install's volume); if the row read is UNREADABLE (transient) the record is
 * left for the next boot rather than tearing down on a guess.
 *
 * @returns {Promise<void>}
 */
async function recoverOwedTeardowns() {
  await pendingTeardownStore.prepareCollection();
  const owed = await pendingTeardownStore.readAllTeardowns();
  if (!owed.length) return;
  log.info(`Boot recovery: ${owed.length} owed teardown(s) to replay`);

  const toDrain = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const doc of owed) {
    let rowExists = false;
    let rowReadFailed = false;
    try {
      // eslint-disable-next-line no-await-in-loop
      // Per identity: an owed teardown names one replica, and a co-located
      // sibling being installed says nothing about whether THIS one came back.
      rowExists = await appsRepository.existsInstalledIdentity(doc.name, doc.replica ?? null);
    } catch (err) {
      rowReadFailed = true;
      log.warn(`Boot recovery: install-row read for ${doc.name} failed, deferring its teardown: ${err.message}`);
    }
    if (rowReadFailed) {
      // leave the record; never tear down on an unreadable row
      // eslint-disable-next-line no-continue
      continue;
    }
    if (rowExists) {
      // a re-install beat recovery: drop the record + un-condemn, do NOT tear down
      log.warn(`Boot recovery: ${doc.name} is re-installed; dropping its stale teardown record without teardown`);
      // eslint-disable-next-line no-restricted-syntax
      for (const c of (doc.components || [])) {
        // eslint-disable-next-line no-await-in-loop
        await appsRuntimeState.setCondemned(c.identifier, false);
      }
      // eslint-disable-next-line no-await-in-loop
      await pendingTeardownStore.clearTeardown(doc.key);
      // eslint-disable-next-line no-continue
      continue;
    }
    // re-condemn synchronously so the reconciler refuses these from cycle 0
    // eslint-disable-next-line no-restricted-syntax
    for (const c of (doc.components || [])) {
      // eslint-disable-next-line no-await-in-loop
      await appsRuntimeState.setCondemned(c.identifier, true, { force: doc.forceKill });
    }
    toDrain.push(doc);
  }

  // Hand the owed teardowns to the reconciler to CONVERGE — it drives each to completion
  // and retries with backoff on a partial pass, instead of a one-shot boot drive that
  // abandons a partial failure until the NEXT boot. The synchronous re-condemn above keeps
  // the run-state path off these components until the boot gate opens and these enqueues
  // (held in bootPending until then) drain into the reconciler's owed-teardown path.
  toDrain.forEach((doc) => {
    (doc.components || []).forEach((c) => reconcilerQueue.enqueue(c.identifier));
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
    let { global } = req.params;
    global = global || req.query.global || false;
    global = serviceHelper.ensureBoolean(global);

    if (appname.includes('_')) {
      throw new Error('Components cannot be removed manually');
    }

    let { force } = req.params;
    force = force || req.query.force || false;
    force = serviceHelper.ensureBoolean(force);

    if (!appname) {
      throw new Error('No Flux App specified');
    }

    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, appname);
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      return res.json(errMessage);
    }

    if (global) {
      globalCommand.executeAppGlobalCommand(appname, 'appremove', req.headers.zelidauth); // do not wait
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
  cleanupDeploymentPorts,
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
