const util = require('util');
const path = require('path');
const systemcrontab = require('crontab');
const serviceHelper = require('../serviceHelper');
const verificationHelper = require('../verificationHelper');
const messageHelper = require('../messageHelper');
const dockerService = require('../dockerService');
const dbHelper = require('../dbHelper');
const globalState = require('../utils/globalState');
const operationRegistry = require('../utils/operationRegistry');
const telemetrySinkCache = require('../telemetrySinkCache');
const telemetryConfigService = require('../telemetryConfigService');
const log = require('../../lib/log');
const {
  localAppsInformation, globalAppsMessages, scannedHeightCollection, globalAppsInstallingErrorsLocations,
} = require('../utils/appConstants');
const config = require('config');
const upnpService = require('../upnpService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
const appsRepository = require('../appDatabase/appsRepository');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const appVolumeService = require('./appVolumeService');
const appSwapPoolService = require('./appSwapPoolService');
const { stopAppMonitoring } = require('../appManagement/appInspector');
const appsRuntimeState = require('../appManagement/appsRuntimeState');
const volumeService = require('../utils/volumeService');
const fluxEventBus = require('../utils/fluxEventBus');
const { Privilege, authOf } = require('../utils/privileges');
const { RemovalOutcome } = require('../utils/removalOutcome');

/**
 * The node does not hold this application.
 *
 * WHAT MARKS IT IS THE TYPE, NOT THE WORDS. A caller that has to tell "it is not here"
 * from "the removal did not complete" reads the mark; the message is the body these
 * endpoints answer with, and belongs to whoever reads the response stream.
 *
 * `name` is left as Error's, because it is serialised into that same body.
 */
class AppNotFoundError extends Error {
  constructor() {
    super('Flux App not found');
  }
}
const fluxShutdowndClient = require('../utils/fluxShutdowndClient');
const pendingTeardownStore = require('./pendingTeardownStore');
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
// serviceManager wires it to appReconciler.forgetDesiredState so every
// in-memory verdict about the component dies with it - a
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
 * @param {object} res - Response object for streaming
 * @returns {Promise<void>}
 */
async function stopSyncthingAndCleanup(monitoredName, appId, res) {
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
    await appVolumeService.removeSyncthingFolder(monitoredName, res);

    // Hard removal - delete syncthing cache since data will be deleted
    // eslint-disable-next-line no-shadow, global-require
    const globalState = require('../utils/globalState');
    const { receiveOnlySyncthingAppsCache } = globalState;
    if (receiveOnlySyncthingAppsCache && receiveOnlySyncthingAppsCache.has(appId)) {
      receiveOnlySyncthingAppsCache.delete(appId);
      log.info(`Deleted syncthing cache for ${appId} during hard removal`);
    }
  } catch (error) {
    log.error(`Error stopping Syncthing app: ${error.message}`);
  }
}

/**
 * Unmount volume for application or component
 * @param {string} appId - Application ID
 * @param {string} entityName - Entity name for logging
 * @param {object} res - Response object for streaming
 * @returns {Promise<void>}
 */
async function unmountVolume(appId, entityName, res) {
  log.info(`Unmounting volume of ${entityName}...`);
  if (res) {
    res.write(serviceHelper.ensureString({ status: `Unmounting volume of ${entityName}...` }));
    if (res.flush) res.flush();
  }

  // The unmount carries on either way - a volume that will not unmount is not
  // a reason to hold an uninstall open - but only one of these two lines is
  // true, and the stream is the only account an operator gets of what is still
  // mounted.
  const unmount = await serviceHelper.runCommand('umount', {
    runAsRoot: true, params: [appsFolder + appId], logError: false,
  });
  if (unmount.error) {
    log.error(unmount.error);
    log.info(`An error occurred while unmounting ${entityName} storage. Continuing...`);
    if (res) {
      res.write(serviceHelper.ensureString({ status: `An error occured while unmounting ${entityName} storage. Continuing...` }));
      if (res.flush) res.flush();
    }
    return;
  }

  log.info(`Volume of ${entityName} unmounted`);
  if (res) {
    res.write(serviceHelper.ensureString({ status: `Volume of ${entityName} unmounted` }));
    if (res.flush) res.flush();
  }
}

/**
 * Clean up application data directory
 * @param {string} appId - Application ID
 * @param {string} entityName - Entity name for logging
 * @param {object} res - Response object for streaming
 * @returns {Promise<void>}
 */
async function cleanupAppData(appId, entityName, res) {
  log.info(`Cleaning up ${entityName} data...`);
  if (res) {
    res.write(serviceHelper.ensureString({ status: `Cleaning up ${entityName} data...` }));
    if (res.flush) res.flush();
  }

  // the bare mountpoint is kept immutable while unmounted (set at volume
  // creation); clear the flag or the removal below fails
  await serviceHelper.runCommand('chattr', { runAsRoot: true, params: ['-i', appsFolder + appId], logError: false });

  // The removal carries on either way - data left behind is not a reason to
  // hold an uninstall open - but only one of these two lines is true, and the
  // stream is the only account an operator gets of what is still on the disk.
  const removal = await serviceHelper.runCommand('rm', {
    runAsRoot: true, params: ['-rf', appsFolder + appId], logError: false,
  });
  if (removal.error) {
    log.error(removal.error);
    log.info(`An error occured while cleaning ${entityName} data. Continuing...`);
    if (res) {
      res.write(serviceHelper.ensureString({ status: `An error occured while cleaning ${entityName} data. Continuing...` }));
      if (res.flush) res.flush();
    }
    return;
  }

  log.info(`Data of ${entityName} cleaned`);
  if (res) {
    res.write(serviceHelper.ensureString({ status: `Data of ${entityName} cleaned` }));
    if (res.flush) res.flush();
  }
}

/**
 * Clean up crontab entry for application
 * @param {string} appId - Application ID
 * @param {object} res - Response object for streaming
 * @returns {Promise<string|null>} Volume path if found, null otherwise
 */
async function cleanupCrontab(appId, res) {
  let volumepath = null;

  log.info('Adjusting crontab...');
  if (res) {
    res.write(serviceHelper.ensureString({ status: 'Adjusting crontab...' }));
    if (res.flush) res.flush();
  }

  const crontab = await crontabLoad().catch((e) => {
    log.error(e);
    log.info('An error occured while loading crontab. Continuing...');
    if (res) {
      res.write(serviceHelper.ensureString({ status: 'An error occured while loading crontab. Continuing...' }));
      if (res.flush) res.flush();
    }
  });

  if (crontab) {
    const jobs = crontab.jobs();
    let jobToRemove;
    jobs.forEach((job) => {
      if (job.comment() === appId) {
        jobToRemove = job;
        // find the command that tells us where the actual fsvol is;
        const command = job.command();
        const cmdsplit = command.split(' ');
        // eslint-disable-next-line prefer-destructuring
        volumepath = cmdsplit[4]; // sudo mount -o loop /home/abcapp2TEMP /root/flux/ZelApps/abcapp2 is an example
        if (!job || !job.isValid()) {
          // remove the job as its invalid anyway
          crontab.remove(job);
        }
      }
    });

    if (jobToRemove) {
      crontab.remove(jobToRemove);
      try {
        crontab.save();
      } catch (e) {
        log.error(e);
        log.info('An error occured while saving crontab. Continuing...');
        if (res) {
          res.write(serviceHelper.ensureString({ status: 'An error occured while saving crontab. Continuing...' }));
          if (res.flush) res.flush();
        }
      }
      log.info('Crontab Adjusted.');
      if (res) {
        res.write(serviceHelper.ensureString({ status: 'Crontab Adjusted.' }));
        if (res.flush) res.flush();
      }
    } else {
      log.info('Crontab not found.');
      if (res) {
        res.write(serviceHelper.ensureString({ status: 'Crontab not found.' }));
        if (res.flush) res.flush();
      }
    }
  }

  return volumepath;
}

/**
 * Clean up volume path
 * @param {string} volumepath - Volume path to clean
 * @param {string} entityName - Entity name for logging
 * @param {object} res - Response object for streaming
 * @param {boolean} [conclusive=true] - Whether the search that produced
 *   `volumepath` covered everywhere it should have. False with no path means
 *   an image may be on disk that nothing will account for again, which is
 *   said rather than passed over; the default suits a caller that did not
 *   search.
 * @returns {Promise<void>}
 */
async function cleanupVolumePath(volumepath, entityName, res, conclusive = true) {
  if (!volumepath) {
    // Nothing to delete and nowhere left to look are different answers, and
    // only the first of them means the disk is clear. An image whose location
    // could not be established outlives the app's last record of itself, so
    // the one chance to say it is here.
    if (!conclusive) {
      log.warn(`Data volume of ${entityName} could not be located and is left on disk`);
      if (res) {
        res.write(serviceHelper.ensureString({ status: `Data volume of ${entityName} could not be located and is left on disk` }));
        if (res.flush) res.flush();
      }
    }
    return;
  }

  log.info(`Cleaning up data volume of ${entityName}...`);
  if (res) {
    res.write(serviceHelper.ensureString({ status: `Cleaning up data volume of ${entityName}...` }));
    if (res.flush) res.flush();
  }

  // Passed as an argument rather than interpolated into a command string. The
  // path can come from the recorded image now, which reached this node as a
  // kernel string and went through the database - so whitespace in it would
  // turn one removal into several, and `rm -rf` is not a thing to be wrong
  // about.
  const removal = await serviceHelper.runCommand('rm', { runAsRoot: true, params: ['-rf', volumepath], logError: false });
  // The removal carries on either way - an image left behind is not a reason
  // to hold an uninstall open - but only one of these two is true, and the
  // stream is the only account an operator gets of what is still on the disk.
  if (removal.error) {
    log.error(removal.error);
    log.info(`An error occured while cleaning ${entityName} volume. Continuing...`);
    if (res) {
      res.write(serviceHelper.ensureString({ status: `An error occured while cleaning ${entityName} volume. Continuing...` }));
      if (res.flush) res.flush();
    }
    return;
  }

  log.info(`Volume of ${entityName} cleaned`);
  if (res) {
    res.write(serviceHelper.ensureString({ status: `Volume of ${entityName} cleaned` }));
    if (res.flush) res.flush();
  }
}
// Deny a component's host ports (ufw + UPnP). These are leaf host mutations on the
// shared firewall ruleset / IGD session, so the deferred teardown worker calls this
// from inside the node-wide hostMutationLock; pass the bare port list so the worker
// can deny ports off the durable teardown descriptor without a live deployComp.
async function denyPorts(ports, appName, entityName, res) {
  const portStatus = { status: `Denying ${entityName} ports...` };
  log.info(portStatus);
  if (res) {
    res.write(serviceHelper.ensureString(portStatus));
    if (res.flush) res.flush();
  }

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

  const portStatus2 = { status: `Ports of ${entityName} denied` };
  log.info(portStatus2);
  if (res) {
    res.write(serviceHelper.ensureString(portStatus2));
    if (res.flush) res.flush();
  }
}

async function cleanupDeploymentPorts(deployComp, appName, res, entityName) {
  await denyPorts(deployComp.hostPorts, appName, entityName, res);
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
 * @param {Function|null} [options.onStatus] - progress callback
 */
async function uninstallComponent(component, options = {}) {
  const removeVolumes = options.removeVolumes || false;
  const forceKill = options.forceKill || false;
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
    await stopSyncthingAndCleanup(component.identifier, appId, null);
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

  await cleanupDeploymentPorts(component, appName, null, label);

  if (removeVolumes) {
    await unmountVolume(appId, label, null);
    await cleanupAppData(appId, label, null);
    const volumepath = await cleanupCrontab(appId, null);
    await cleanupVolumePath(volumepath, label, null);
    // Reclaim now-unneeded app-swap pool capacity (idempotent; no-op without the
    // new-mechanism host config). The container is already gone, so its swap pages
    // are freed and an emptied chunk can be swapped off + removed.
    await appSwapPoolService.reconcile();
  }

  status(`Flux App ${label} was successfully removed`);
}

/**
 * Remove an application (or one component) from the local node.
 * @param {string} appName - App name, or a component identifier (component_app).
 * @param {object} [options] - forceKill, skipGuard, broadcastRemoval, onStatus.
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
  } = options;

  const status = (msg) => {
    log.info(msg);
    if (onStatus) onStatus(msg);
  };

  // Hoisted so the finally releases ONLY a lease this call actually acquired — the
  // token stays null on the deferred early-return (an own-checked no-op), and two
  // same-app skipGuard removes that share one slot can never clobber a later lease.
  let removeToken = null;
  try {
    // Normalise to the bare identifier this function reasons about: a caller may
    // pass the flux-prefixed docker name (e.g. the syncthing flow), which would
    // otherwise mis-derive the component as `flux{component}` below.
    // eslint-disable-next-line no-param-reassign
    appName = appName ? dockerService.getBaseAppName(appName) : appName;

    // Log removal trigger with stack trace to identify caller
    const { stack } = new Error();
    const callerLine = stack.split('\n')[2]?.trim();
    log.warn(`APP REMOVAL TRIGGERED: ${appName} | forceKill=${forceKill} | skipGuard=${skipGuard} | broadcastRemoval=${broadcastRemoval} | caller: ${callerLine}`);

    // Per-app: defer only if THIS app is already mid-operation (skipGuard is the
    // documented emergency-removal bypass). Removals of different apps run
    // concurrently - each removes only its own containers/volumes/network.
    if (!skipGuard && operationRegistry.isHeld(appName)) {
      status(`An operation is already in progress for ${appName}. Removal not possible.`);
      return { status: UninstallStatus.DEFERRED, reason: `An operation is already in progress for ${appName}` };
    }

    // Acquire the per-app operation lease — the sole record that this app is
    // mid-removal. Released in the finally.
    removeToken = operationRegistry.acquire(appName, 'remove', 'appUninstaller', `remove ${appName}`);

    if (!appName) {
      throw new Error('No App specified');
    }

    const isComponent = appName.includes('_');
    const resolvedAppName = isComponent ? appName.split('_')[1] : appName;
    const appComponent = appName.split('_')[0];

    let spec = await appsRepository.getInstalledApp(resolvedAppName);
    if (!spec) {
      if (!skipGuard) {
        status('Flux App not found');
        return { status: UninstallStatus.SKIPPED, reason: 'Flux App not found' };
      }
      spec = await appsRepository.getGlobalAppInfo(resolvedAppName);
      if (!spec) {
        const globalApps = await appsRepository.listGlobalAppInfo();
        const localApps = await appsRepository.listInstalledApps();
        spec = [...globalApps, ...localApps].find((a) => a.name === resolvedAppName) || null;
        if (!spec) {
          const dbopen = dbHelper.databaseConnection();
          const database = dbopen.db(config.database.appsglobal.database);
          const messages = await dbHelper.findInDatabase(
            database, globalAppsMessages, {}, { projection: { _id: 0 } },
          );
          const appMessages = messages.filter((message) => {
            const s = message.appSpecifications;
            return s && s.name === resolvedAppName;
          });
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

    // Tear down components via the normalized DeploymentSpec (mirrors
    // installApplication -> installComponent; the deployment resolves images
    // and host ports across spec versions). Fall back to best-effort container
    // removal if the deployment can't be built (orphaned app / missing record).
    // Resolve the deployment to capture per-component teardown descriptors. The
    // durable record below carries everything the deferred worker needs, so the local
    // row can be deleted in the prelude (every reader then sees the app as gone).
    const deployment = await deploymentProvider.getInstalledDeployment(resolvedAppName);

    const teardownComponents = [];
    if (deployment && isComponent) {
      const component = deployment.getComponent(appComponent);
      if (!component) {
        throw new Error(`Flux App component ${appComponent} not found in ${resolvedAppName}`);
      }
      teardownComponents.push(component);
    } else if (deployment) {
      // eslint-disable-next-line no-restricted-syntax
      for (const [, component] of deployment.componentEntries({ reverse: true })) {
        teardownComponents.push(component);
      }
    }

    const components = teardownComponents.map((c) => ({
      identifier: c.identifier,
      appId: dockerService.getAppIdentifier(c.identifier),
      componentName: c.name,
      label: c.name === resolvedAppName ? resolvedAppName : `component ${c.name} of ${resolvedAppName}`,
      ports: c.hostPorts || [],
      image: c.image || null,
    }));
    // Orphaned app / unresolvable deployment: a single best-effort descriptor off the
    // bare identifier so the worker still removes whatever container/network exists.
    if (components.length === 0) {
      components.push({
        identifier: appName,
        appId: dockerService.getAppIdentifier(appName),
        componentName: resolvedAppName,
        label: resolvedAppName,
        ports: [],
        image: null,
      });
    }

    // The durable owed-teardown record — the crash-safe handoff to the deferred worker.
    const teardownDoc = {
      key: appName, // app name (whole-app) or component identifier (component-scoped)
      name: resolvedAppName,
      networkName: resolvedAppName,
      isComponent,
      forceKill,
      broadcastRemoval,
      owner: spec.owner,
      createdAt: Date.now(),
      attempts: 0,
      components,
    };

    // PHASE A — the fast, durable prelude. Order is load-bearing.
    // (1) Persist the owed-teardown record FIRST and fail CLOSED: once the local row is
    //     gone (step 4) this doc is the SOLE record of the cleanup owed, so a write
    //     failure must abort the removal (it throws to the catch) before any row delete.
    await pendingTeardownStore.writeTeardown(teardownDoc);
    // (2) Condemn every component (durable): the reconciler stands it down and never
    //     restarts it, boot recovery re-stamps it, and the worker reads it as safe to
    //     destroy. NOT appsRuntimeState.remove yet — that is the LAST teardown step.
    // eslint-disable-next-line no-restricted-syntax
    for (const c of components) {
      // eslint-disable-next-line no-await-in-loop
      await appsRuntimeState.setCondemned(c.identifier, true, { force: forceKill });
    }
    fluxEventBus.publish('app:removed', { name: resolvedAppName });
    // (3) Tell the network it's gone NOW — fire-and-forget, never block the prelude on a
    //     broadcast — and drop it from the local running-apps cache.
    if (broadcastRemoval) {
      const ip = await fluxNetworkHelper.getLocalSocketAddress();
      if (ip) {
        const appRemovedMessage = {
          type: 'fluxappremoved', version: 1, appName: resolvedAppName, ip, broadcastedAt: Date.now(),
        };
        log.info('Broadcasting appremoved message to the network');
        fluxCommunicationMessagesSender.broadcastMessageToAll(appRemovedMessage)
          .catch((e) => log.warn(`appremoved broadcast failed: ${e.message}`));
        const { runningAppsCache } = globalState;
        if (runningAppsCache.has(resolvedAppName)) runningAppsCache.delete(resolvedAppName);
      } else {
        log.warn(`${appName} removed without announcing it - this node's own address is unknown, so peers hold its location row until it expires`);
      }
    }
    // (4) Delete the local install row so every reader sees the app as gone with zero
    //     filtering (whole-app only; a component-scoped teardown leaves the app row).
    if (!isComponent) {
      const appsDatabase = dbHelper.databaseConnection().db(config.database.appslocal.database);
      await dbHelper.findOneAndDeleteInDatabase(
        appsDatabase, localAppsInformation, { name: resolvedAppName }, {},
      );
      // The app is gone for good: nothing reconciles an app with no row, so its
      // removal records have no reader left. Only this full-uninstall path clears
      // them - a soft removal deletes the row too, but as one step of a redeploy
      // whose containers are coming straight back, and its records are exactly
      // what stops a teardown that fails part way being read as tampering.
      dockerService.clearFluxRemovedContainers(resolvedAppName);
      status('Database cleaned');
    }

    // PHASE B — the deferred destructive teardown. background (cancel/expiry) fires it
    // and returns now; foreground (redeploy/rollback/REST) awaits it to completion.
    if (background) {
      runTeardown(teardownDoc).catch((e) => log.error(`Deferred teardown of ${resolvedAppName} failed: ${e.message}`));
      status(`Removal queued: Flux App ${resolvedAppName} condemned; teardown deferred`);
    } else {
      await runTeardown(teardownDoc);
      status(`Removal step done. Result: Flux App ${resolvedAppName} was successfully removed`);
    }
    return { status: UninstallStatus.REMOVED, reason: null };
  } catch (error) {
    log.error(`Error removing app ${appName}: ${error.message}`);
    status(`Error: ${error.message}`);
    return { status: UninstallStatus.FAILED, reason: error.message };
  } finally {
    operationRegistry.release(appName, removeToken);
  }
}

/**
 * Phase B — the deferred destructive teardown. Reads a durable owed-teardown record
 * (from the prelude, or replayed by boot recovery) and tears the app down for good:
 * graceful stop OUTSIDE the node-wide lock (an unbounded wait must never serialize the
 * lock), then container removal + host cleanup + the cross-app network removal under
 * ONE hostMutationLock per app, then drops the condemned stamps and clears the record
 * LAST. Each component is isolated so one failure never abandons its siblings; the
 * record is cleared only when every stamp dropped, so anything left is re-driven by
 * boot recovery.
 *
 * @param {object} doc - a pendingAppTeardowns record
 */
async function runTeardown(doc) {
  const {
    key, name, networkName, isComponent, forceKill, owner, components,
  } = doc;
  const list = components || [];

  // Graceful stop, OUTSIDE the lock. The container is removed below; stopping it first
  // makes the remove a clean (non-SIGKILL) teardown and releases its volume before the
  // unmount. appUninstaller is the run-authority's terminal-teardown exception.
  // eslint-disable-next-line no-restricted-syntax
  for (const c of list) {
    stopAppMonitoring(c.identifier, true);
    if (forceKill) {
      // eslint-disable-next-line no-await-in-loop
      await dockerService.appDockerKill(c.appId).catch((e) => log.warn(`kill ${c.appId}: ${e.message}`));
    } else {
      // eslint-disable-next-line no-await-in-loop
      await dockerService.appDockerStop(c.appId).catch((e) => log.warn(`stop ${c.appId}: ${e.message}`));
    }
  }

  // Destructive host teardown under ONE node-wide lock for the whole app. Each
  // component is isolated (a throw in one never skips the others); the cross-app docker
  // network removal is serialized inside the same lock.
  await withHostMutationLock(async () => {
    // eslint-disable-next-line no-restricted-syntax
    for (const c of list) {
      try {
        if (forceKill) {
          // eslint-disable-next-line no-await-in-loop
          await dockerService.appDockerForceRemove(c.appId).catch((e) => log.warn(`force remove ${c.appId}: ${e.message}`));
        } else {
          // eslint-disable-next-line no-await-in-loop
          await dockerService.appDockerRemove(c.appId).catch((e) => log.warn(`remove ${c.appId}: ${e.message}`));
        }
        // eslint-disable-next-line no-await-in-loop
        await denyPorts(c.ports, name, c.label, null);
        // eslint-disable-next-line no-await-in-loop
        await unmountVolume(c.appId, c.label, null);
        // eslint-disable-next-line no-await-in-loop
        await cleanupAppData(c.appId, c.label, null);
        // eslint-disable-next-line no-await-in-loop
        const volumepath = await cleanupCrontab(c.appId, null);
        // eslint-disable-next-line no-await-in-loop
        await cleanupVolumePath(volumepath, c.label, null);
      } catch (err) {
        log.error(`Host teardown of ${c.identifier} failed (continuing): ${err.message}`);
      }
    }
    // Reclaim now-unneeded swap-pool capacity + the app's images (reference-gated).
    await appSwapPoolService.reconcile().catch((e) => log.warn(`swap pool reconcile: ${e.message}`));
    await reclaimUnusedImages(list.map((c) => c.image), (m) => log.info(m));
    // Whole-app docker network — cross-app (networkWith consumers attach it), so its
    // removal is serialized here inside the lock.
    if (!isComponent) {
      if (forceKill) {
        await dockerService.forceRemoveFluxAppDockerNetwork(networkName).catch((e) => log.error(`force network removal ${networkName}: ${e.message}`));
      } else {
        await dockerService.removeFluxAppDockerNetwork(networkName).catch((e) => log.error(`network removal ${networkName}: ${e.message}`));
      }
    }
  });

  // App-level, non-host cleanup.
  if (!isComponent) {
    telemetrySinkCache.deleteSink(name);
    if (!telemetrySinkCache.hasAnyTelemetryApps()) {
      await telemetryConfigService.remove().catch((e) => log.warn(`telemetry config remove: ${e.message}`));
    }
    if (owner) await fluxShutdowndClient.deleteAppPlanBestEffort(name, owner);
  }

  // FINISH — drop every component's runtime state (incl. the condemned stamp), then
  // clear the durable record, but ONLY when every stamp dropped: a surviving stamp
  // keeps the record so boot recovery re-drives (never orphan a condemned component).
  let allDropped = true;
  // eslint-disable-next-line no-restricted-syntax
  for (const c of list) {
    // eslint-disable-next-line no-await-in-loop
    const dropped = await appsRuntimeState.remove(c.identifier);
    if (!dropped) allDropped = false;
    if (onComponentRemoved) onComponentRemoved(c.identifier);
  }
  if (allDropped) {
    await pendingTeardownStore.clearTeardown(key);
  } else {
    log.warn(`Teardown of ${name}: a condemned stamp did not drop; keeping the teardown record for boot recovery`);
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
      rowExists = await appsRepository.existsInstalledApp(doc.name);
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

  // Drive the destructive teardowns in the background — the synchronous re-condemn
  // above already protects them from the reconciler.
  toDrain.forEach((doc) => {
    runTeardown(doc).catch((e) => log.error(`Boot-recovered teardown of ${doc.name} failed: ${e.message}`));
  });
}

/**
 * API endpoint for removing application locally
 * @param {object} req - Request object
 * @param {object} res - Response object
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
      // eslint-disable-next-line global-require
      const appController = require('../appManagement/appController');
      appController.executeAppGlobalCommand(appname, 'appremove', authOf(req)); // do not wait
      const appResponse = messageHelper.createSuccessMessage(`${appname} queried for global reinstallation`);
      return res.json(appResponse);
    }

    res.setHeader('Content-Type', 'application/json');

    await uninstallApplication(appname, {
      forceKill: force,
      skipGuard: force,
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

/**
 * Remove expired applications from the global database and local installations.
 * A lifecycle maintenance sweep: it reads the explorer height, finds apps past
 * their expiration, drops their global records, and uninstalls any local install.
 * Lives here (not in the data-access registry) because removing an app is a
 * lifecycle action — the data layer must not orchestrate teardown.
 * @returns {Promise<void>}
 */
async function expireGlobalApplications() {
  // check if synced
  try {
    // get current height
    const dbopen = dbHelper.databaseConnection();
    const database = dbopen.db(config.database.daemon.database);
    const query = { generalScannedHeight: { $gte: 0 } };
    const projection = {
      projection: {
        _id: 0,
        generalScannedHeight: 1,
      },
    };
    const result = await dbHelper.findOneInDatabase(database, scannedHeightCollection, query, projection);
    if (!result) {
      throw new Error('Scanning not initiated');
    }
    const explorerHeight = serviceHelper.ensureNumber(result.generalScannedHeight);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const candidates = await appsRepository.listGlobalAppInfo();
    const appsToExpire = candidates.filter(
      (is) => is.isExpired(nowSeconds, explorerHeight),
    );
    const appNamesToExpire = appsToExpire.map((is) => is.name);
    // remove appNamesToExpire apps from global database
    const databaseApps = dbopen.db(config.database.appsglobal.database);
    // eslint-disable-next-line no-restricted-syntax
    for (const app of appsToExpire) {
      log.info(`Expiring application ${app.name}`);
      // eslint-disable-next-line no-await-in-loop
      await appsRepository.removeGlobalAppInfo(app.name);
      // eslint-disable-next-line no-await-in-loop
      await dbHelper.removeDocumentsFromCollection(databaseApps, globalAppsInstallingErrorsLocations, { name: app.name });
    }

    const installedApps = await appsRepository.listInstalledApps();
    // Expiry is a property of the network-confirmed spec, so evaluate each installed
    // app against the AUTHORITATIVE global row, not the lazily-refreshed local install
    // row: a stale shorter local expire would wrongly remove a renewed, still-paid app
    // (a stale longer one would skip a cancelled one). The local rows only scope WHICH
    // apps this node runs. Scope the global read to those names so a renewed app
    // excluded from the height-filtered `candidates` above is still re-evaluated here.
    const installedNames = installedApps.map((app) => app.name);
    const globalRows = installedNames.length
      ? await appsRepository.listGlobalAppInfo({ filter: { name: { $in: installedNames } } })
      : [];
    const globalByName = new Map(globalRows.map((spec) => [spec.name, spec]));
    const appsToRemoveNames = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const app of installedApps) {
      // Prefer the authoritative global spec; fall back to the local row only when the
      // app has no global registration (forever/manual installs, or one a prior sweep
      // already removed from global — the appNamesToExpire branch still reaps those).
      const authoritative = globalByName.get(app.name) || app;
      if (appNamesToExpire.includes(app.name)) {
        appsToRemoveNames.push(app.name);
      } else if (authoritative.height === 0) {
        // forever-lasting app — never expires. Checked BEFORE !height so a height-0
        // app is not swallowed by the !height branch (which would force-expire it).
      } else if (!authoritative.height) {
        appsToRemoveNames.push(app.name);
      } else if (authoritative.isExpired(nowSeconds, explorerHeight)) {
        appsToRemoveNames.push(app.name);
      }
    }

    // eslint-disable-next-line no-restricted-syntax
    for (const appName of appsToRemoveNames) {
      log.warn(`Application ${appName} is expired, removing`);
      log.warn(`REMOVAL REASON: App expired - ${appName} reached expiration date (appUninstaller)`);
      // background: the prelude condemns + records + deletes the row fast, then the
      // destructive teardown runs deferred (serialized by the host-mutation lock), so
      // the at-tip sweep enforces every expiry promptly instead of blocking ~1 min/app.
      // eslint-disable-next-line no-await-in-loop
      await uninstallApplication(appName, {
        forceKill: true, skipGuard: true, broadcastRemoval: true, background: true,
      });
    }
  } catch (error) {
    log.error(error);
  }
}

module.exports = {
  UninstallStatus,
  uninstallApplication,
  uninstallComponent,
  cleanupDeploymentPorts,
  removeAppLocallyApi,
  setOnComponentRemoved,
  expireGlobalApplications,
  runTeardown,
  recoverOwedTeardowns,
  // exposed for tests
  reclaimUnusedImages,
};
