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
const telemetrySinkCache = require('../telemetrySinkCache');
const telemetryConfigService = require('../telemetryConfigService');
const log = require('../../lib/log');
const { localAppsInformation, globalAppsInformation, globalAppsMessages } = require('../utils/appConstants');
const config = require('config');
const upnpService = require('../upnpService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
const appsRepository = require('../appDatabase/appsRepository');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const appVolumeService = require('./appVolumeService');
const { stopAppMonitoring } = require('../appManagement/appInspector');
const appsRuntimeState = require('../appManagement/appsRuntimeState');
const volumeService = require('../utils/volumeService');
const imageManager = require('../appSecurity/imageManager');
const fluxEventBus = require('../utils/fluxEventBus');
const fluxShutdowndClient = require('../utils/fluxShutdowndClient');

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
async function cleanupDeploymentPorts(deployComp, appName, res, entityName) {
  const portStatus = { status: `Denying ${entityName} ports...` };
  log.info(portStatus);
  if (res) {
    res.write(serviceHelper.ensureString(portStatus));
    if (res.flush) res.flush();
  }

  const firewallActive = await fluxNetworkHelper.isFirewallActive();
  const isUPNP = upnpService.isUPNP();
  // eslint-disable-next-line no-restricted-syntax
  for (const port of deployComp.hostPorts) {
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

/**
 * Uninstall a single component: stop (or kill) and remove its container, deny
 * its ports, optionally tear down volumes/syncthing/crontab, then remove the
 * image. Driven off the normalized DeploymentSpec component.
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

  const appName = component.appName;
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
  }

  if (containerRemoved) {
    status(`Removing Flux App ${label} image...`);
    await dockerService.appDockerImageRemove(component.image).catch((error) => {
      log.error(`Image remove failed for ${component.image}: ${error.message}`);
    });
    status(`Flux App ${label} image operations done`);
  } else {
    log.warn(`Skipping image removal for ${appId} because container removal failed`);
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
    onStatus = null,
  } = options;

  const status = (msg) => {
    log.info(msg);
    if (onStatus) onStatus(msg);
  };

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

    if (!skipGuard) {
      if (globalState.removalInProgress) {
        status('Another application is undergoing removal. Removal not possible.');
        return { status: UninstallStatus.DEFERRED, reason: 'Another application is undergoing removal' };
      }
      if (globalState.installationInProgress) {
        status('Another application is undergoing installation. Removal not possible.');
        return { status: UninstallStatus.DEFERRED, reason: 'Another application is undergoing installation' };
      }
    }

    globalState.removalInProgress = true;

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
            if (result) spec = result.spec;
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
    const deployment = await deploymentProvider.getInstalledDeployment(resolvedAppName);

    // clear node-local runtime state (operator stop lock, crash backoff) for the
    // removed component(s) so a later reinstall starts from a clean slate
    const removedIdentifiers = (deployment && !isComponent)
      ? deployment.componentEntries().map(([, c]) => c.identifier)
      : [appName];
    // eslint-disable-next-line no-restricted-syntax
    for (const identifier of removedIdentifiers) {
      // eslint-disable-next-line no-await-in-loop
      await appsRuntimeState.remove(identifier);
      if (onComponentRemoved) onComponentRemoved(identifier);
    }
    if (deployment && isComponent) {
      const component = deployment.getComponent(appComponent);
      if (!component) {
        throw new Error(`Flux App component ${appComponent} not found in ${resolvedAppName}`);
      }
      await uninstallComponent(component, { removeVolumes: true, forceKill, onStatus });
    } else if (deployment) {
      for (const [, component] of deployment.componentEntries({ reverse: true })) {
        // eslint-disable-next-line no-await-in-loop
        await uninstallComponent(component, { removeVolumes: true, forceKill, onStatus });
      }
    } else {
      status(`No deployment for ${resolvedAppName}; best-effort container removal`);
      const appId = dockerService.getAppIdentifier(appName);
      if (forceKill) {
        await dockerService.appDockerForceRemove(appId).catch((e) => log.warn(`force remove ${appId}: ${e.message}`));
      } else {
        await dockerService.appDockerStop(appId).catch(() => {});
        await dockerService.appDockerRemove(appId).catch((e) => log.warn(`remove ${appId}: ${e.message}`));
      }
    }

    fluxEventBus.publish('app:removed', { name: resolvedAppName });

    if (broadcastRemoval) {
      const ip = await fluxNetworkHelper.getLocalSocketAddress();
      if (ip) {
        const appRemovedMessage = {
          type: 'fluxappremoved',
          version: 1,
          appName: resolvedAppName,
          ip,
          broadcastedAt: Date.now(),
        };
        log.info('Broadcasting appremoved message to the network');
        await fluxCommunicationMessagesSender.broadcastMessageToAll(appRemovedMessage);
        const { runningAppsCache } = globalState;
        if (runningAppsCache.has(resolvedAppName)) {
          runningAppsCache.delete(resolvedAppName);
          log.info(`Removed ${resolvedAppName} from running apps cache`);
        }
      }
    }

    if (!isComponent) {
      // Drop telemetry routing for the whole app; its containers' die events
      // separately evict the daemon-side exporter. Stop the daemon when the
      // last telemetry app is gone.
      telemetrySinkCache.deleteSink(resolvedAppName);
      if (!telemetrySinkCache.hasAnyTelemetryApps()) {
        await telemetryConfigService.remove();
      }

      status('Cleaning up docker network...');

      let networkRemoved = false;
      let networkError = null;

      if (forceKill) {
        await serviceHelper.delay(2000);
        log.info(`Attempting force removal of network for ${resolvedAppName}...`);
        await dockerService.forceRemoveFluxAppDockerNetwork(resolvedAppName).then(() => {
          networkRemoved = true;
          log.info(`Network ${resolvedAppName} force removed successfully`);
        }).catch((error) => {
          networkError = error;
          log.error(`Force network removal failed: ${error.message}`);
          log.warn(`Retrying force network removal for ${resolvedAppName} after delay...`);
        });

        if (!networkRemoved && networkError) {
          await serviceHelper.delay(3000);
          await dockerService.forceRemoveFluxAppDockerNetwork(resolvedAppName).then(() => {
            networkRemoved = true;
            log.info(`Network ${resolvedAppName} removed on retry`);
          }).catch((error) => {
            log.error(`Network removal retry failed: ${error.message}`);
          });
        }
      } else {
        await dockerService.removeFluxAppDockerNetwork(resolvedAppName).then(() => {
          networkRemoved = true;
        }).catch((error) => {
          networkError = error;
          log.error(`Network removal failed: ${error.message}`);
        });
      }

      if (networkRemoved) {
        status('Docker network cleaned');
      } else {
        status(`WARNING: Docker network for ${resolvedAppName} may not have been fully removed`);
      }

      status('Cleaning up database...');
      const appsDatabase = dbHelper.databaseConnection().db(config.database.appslocal.database);
      await dbHelper.findOneAndDeleteInDatabase(
        appsDatabase, localAppsInformation, { name: resolvedAppName }, {},
      );
      status('Database cleaned');

      // Drop the app's shutdown plan from flux-shutdownd (best-effort).
      await fluxShutdowndClient.deleteAppPlanBestEffort(resolvedAppName, spec.owner);
    }

    status(`Removal step done. Result: Flux App ${resolvedAppName} was successfully removed`);
    return { status: UninstallStatus.REMOVED, reason: null };
  } catch (error) {
    log.error(`Error removing app ${appName}: ${error.message}`);
    status(`Error: ${error.message}`);
    return { status: UninstallStatus.FAILED, reason: error.message };
  } finally {
    globalState.removalInProgress = false;
  }
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

module.exports = {
  UninstallStatus,
  uninstallApplication,
  uninstallComponent,
  cleanupDeploymentPorts,
  removeAppLocallyApi,
  setOnComponentRemoved,
};
