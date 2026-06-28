const util = require('util');
const path = require('path');
const nodecmd = require('node-cmd');
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
const imageManager = require('../appSecurity/imageManager');
const fluxEventBus = require('../utils/fluxEventBus');
const fluxShutdowndClient = require('../utils/fluxShutdowndClient');
const pendingTeardownStore = require('./pendingTeardownStore');
const { withHostMutationLock } = require('../utils/hostMutationLock');

const fluxDirPath = process.env.FLUXOS_PATH || path.join(process.env.HOME, 'zelflux');
const appsFolderPath = process.env.FLUX_APPS_FOLDER || path.join(fluxDirPath, 'ZelApps');
const appsFolder = `${appsFolderPath}/`;
const cmdAsync = util.promisify(nodecmd.run);
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
 * @param {object} res - Response object for streaming
 * @returns {Promise<void>}
 */
async function stopSyncthingAndCleanup(monitoredName, appId, res) {
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

  const execUnmount = `sudo umount ${appsFolder + appId}`;
  const execSuccess = await cmdAsync(execUnmount).catch((e) => {
    log.error(e);
    log.info(`An error occurred while unmounting ${entityName} storage. Continuing...`);
    if (res) {
      res.write(serviceHelper.ensureString({ status: `An error occured while unmounting ${entityName} storage. Continuing...` }));
      if (res.flush) res.flush();
    }
  });

  if (execSuccess) {
    log.info(`Volume of ${entityName} unmounted`);
    if (res) {
      res.write(serviceHelper.ensureString({ status: `Volume of ${entityName} unmounted` }));
      if (res.flush) res.flush();
    }
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

  const execDelete = `sudo rm -rf ${appsFolder + appId}`;
  await cmdAsync(execDelete).catch((e) => {
    log.error(e);
    log.info(`An error occured while cleaning ${entityName} data. Continuing...`);
    if (res) {
      res.write(serviceHelper.ensureString({ status: `An error occured while cleaning ${entityName} data. Continuing...` }));
      if (res.flush) res.flush();
    }
  });

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
 * @returns {Promise<void>}
 */
async function cleanupVolumePath(volumepath, entityName, res) {
  if (!volumepath) return;

  log.info(`Cleaning up data volume of ${entityName}...`);
  if (res) {
    res.write(serviceHelper.ensureString({ status: `Cleaning up data volume of ${entityName}...` }));
    if (res.flush) res.flush();
  }

  const execVolumeDelete = `sudo rm -rf ${volumepath}`;
  await cmdAsync(execVolumeDelete).catch((e) => {
    log.error(e);
    log.info(`An error occured while cleaning ${entityName} volume. Continuing...`);
    if (res) {
      res.write(serviceHelper.ensureString({ status: `An error occured while cleaning ${entityName} volume. Continuing...` }));
      if (res.flush) res.flush();
    }
  });

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
  } = options;

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
    // Normalise to the bare app name this function reasons about: a caller may pass a
    // flux-prefixed docker name (e.g. the syncthing flow); strip the prefix.
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
          const dbopen = dbHelper.databaseConnection();
          const database = dbopen.db(config.database.appsglobal.database);
          const messages = await dbHelper.findInDatabase(
            database, globalAppsMessages, {}, { projection: { _id: 0 } },
          );
          const appMessages = messages.filter((message) => {
            const s = message.appSpecifications;
            return s && s.name === appName;
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

    // Capture each component's teardown descriptors off the normalized deployment. The
    // durable record below carries everything the deferred worker needs, so the local
    // install row can be deleted up front (every reader then sees the app as gone). An
    // app whose deployment can't be built falls back to one best-effort descriptor.
    const deployment = await deploymentProvider.getInstalledDeployment(appName);
    const components = [];
    if (deployment) {
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
    teardownDoc = {
      key: appName,
      name: appName,
      networkName: appName,
      forceKill,
      broadcastRemoval,
      owner: spec.owner,
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
    fluxEventBus.publish('app:removed', { name: appName });
    // Tell the network it's gone NOW — fire-and-forget, never blocking the prelude on a
    // broadcast — and drop it from the local running-apps cache.
    if (broadcastRemoval) {
      const ip = await fluxNetworkHelper.getLocalSocketAddress();
      if (ip) {
        const appRemovedMessage = {
          type: 'fluxappremoved', version: 1, appName, ip, broadcastedAt: Date.now(),
        };
        log.info('Broadcasting appremoved message to the network');
        fluxCommunicationMessagesSender.broadcastMessageToAll(appRemovedMessage)
          .catch((e) => log.warn(`appremoved broadcast failed: ${e.message}`));
        const { runningAppsCache } = globalState;
        if (runningAppsCache.has(appName)) runningAppsCache.delete(appName);
      }
    }
    // Delete the local install row so every reader sees the app as gone with zero filtering.
    const appsDatabase = dbHelper.databaseConnection().db(config.database.appslocal.database);
    await dbHelper.findOneAndDeleteInDatabase(appsDatabase, localAppsInformation, { name: appName }, {});

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
async function runTeardown(doc, { onStatus = null } = {}) {
  const {
    key, name, networkName, forceKill, owner, components,
  } = doc;
  const list = components || [];
  const status = (msg) => { log.info(msg); if (onStatus) onStatus(msg); };

  // Graceful stop, OUTSIDE the lock. The container is removed below; stopping it first
  // makes the remove a clean (non-SIGKILL) teardown and releases its volume before the
  // unmount. appUninstaller is the run-authority's terminal-teardown exception.
  status(`Stopping ${name} container(s)...`);
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

  // Destructive host teardown under ONE node-wide lock for the whole app. Each component
  // is isolated (a throw in one never skips the others); the cross-app docker network
  // removal (networkWith consumers attach it) is serialized inside the same lock. Only the
  // lock's own resources (ufw / UPnP / image store / network) run under it — the swap-pool
  // reconcile runs after release.
  status(`Removing ${name} container(s) and host state...`);
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
    // Reclaim the app's images (reference-gated) — an image-store mutation, so under the lock.
    await reclaimUnusedImages(list.map((c) => c.image), status);
    status('Cleaning up docker network...');
    if (forceKill) {
      await dockerService.forceRemoveFluxAppDockerNetwork(networkName).catch((e) => log.error(`force network removal ${networkName}: ${e.message}`));
    } else {
      await dockerService.removeFluxAppDockerNetwork(networkName).catch((e) => log.error(`network removal ${networkName}: ${e.message}`));
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
  if (owner) await fluxShutdowndClient.deleteAppPlanBestEffort(name, owner);

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

    const instForVettedCheck = await appsRepository.getInstalledApp(appname)
      || await appsRepository.getGlobalAppInfo(appname);

    if (instForVettedCheck) {
      const deployment = await deploymentProvider.getInstalledDeployment(appname);
      const images = deployment ? deployment.allImages() : [];
      const appIsVetted = await imageManager.isAppVetted({ owner: instForVettedCheck.owner, hash: instForVettedCheck.hash, images });
      if (appIsVetted) {
        // Check if user is specifically the app owner or Flux Team
        const isAppOwner = await verificationHelper.verifyPrivilege('appowner', req, appname);
        const isFluxTeam = await verificationHelper.verifyPrivilege('fluxteam', req);

        if (!isAppOwner && !isFluxTeam) {
          const errMessage = messageHelper.createErrorMessage('This is a vetted application. Only the app owner or InFlux Support Team are allowed to uninstall it.');
          return res.json(errMessage);
        }
      }
    }

    if (global) {
      // eslint-disable-next-line global-require
      const appController = require('../appManagement/appController');
      appController.executeAppGlobalCommand(appname, 'appremove', req.headers.zelidauth); // do not wait
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
