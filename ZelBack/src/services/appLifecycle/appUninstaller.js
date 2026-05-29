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
const log = require('../../lib/log');
const { localAppsInformation, globalAppsInformation, globalAppsMessages } = require('../utils/appConstants');
const config = require('config');
// const advancedWorkflows = require('./advancedWorkflows'); // Moved to dynamic require to avoid circular dependency
const upnpService = require('../upnpService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
const appsRepository = require('../appDatabase/appsRepository');
const legacyCryptoProvider = require('../providers/FluxOSLegacyCryptoProvider');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const appVolumeService = require('./appVolumeService');
const { getSpecBackend } = require('../utils/specLibs');
const { stopAppMonitoring } = require('../appManagement/appInspector');
const appsRuntimeState = require('../appManagement/appsRuntimeState');
const imageManager = require('../appSecurity/imageManager');
const fluxEventBus = require('../utils/fluxEventBus');

const fluxDirPath = process.env.FLUXOS_PATH || path.join(process.env.HOME, 'zelflux');
const appsFolderPath = process.env.FLUX_APPS_FOLDER || path.join(fluxDirPath, 'ZelApps');
const appsFolder = `${appsFolderPath}/`;
const cmdAsync = util.promisify(nodecmd.run);
const crontabLoad = util.promisify(systemcrontab.load);

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

/**
 * Hard uninstall a component (complete removal including data)
 * @param {string} appName - Parent application name
 * @param {string} appId - Component ID
 * @param {object} componentSpecifications - Component specifications
 * @param {object} res - Response object for streaming
 * @param {function} stopAppMonitoring - Function to stop monitoring
 * @param {boolean} force - Use aggressive removal (kill + force remove) for stuck containers
 * @returns {Promise<void>}
 */
// eslint-disable-next-line no-shadow
async function hardUninstallComponent(appName, appId, componentSpecifications, res, stopAppMonitoring, force = false) {
  const componentName = componentSpecifications.name;

  // Stop monitoring and container
  log.info(`Stopping Flux App Component ${componentName}...`);
  if (res) {
    res.write(serviceHelper.ensureString({ status: `Stopping Flux App Component ${componentName}...` }));
    if (res.flush) res.flush();
  }

  const monitoredName = `${componentName}_${appName}`;
  if (stopAppMonitoring) {
    stopAppMonitoring(monitoredName, true);
  }

  // Use kill instead of stop for forced removals
  if (force) {
    await dockerService.appDockerKill(appId).catch((error) => {
      log.warn(`Failed to kill container ${appId}: ${error.message}`);
      const errorResponse = messageHelper.createErrorMessage(error.message || error, error.name, error.code);
      if (res) {
        res.write(serviceHelper.ensureString(errorResponse));
        if (res.flush) res.flush();
      }
    });
  } else {
    await dockerService.appDockerStop(appId).catch((error) => {
      const errorResponse = messageHelper.createErrorMessage(error.message || error, error.name, error.code);
      if (res) {
        res.write(serviceHelper.ensureString(errorResponse));
        if (res.flush) res.flush();
      }
    });
  }

  log.info(`Flux App Component ${componentName} stopped`);
  if (res) {
    res.write(serviceHelper.ensureString({ status: `Flux App Component ${componentName} stopped` }));
    if (res.flush) res.flush();
  }

  // Stop Syncthing
  await stopSyncthingAndCleanup(monitoredName, appId, res);

  // Remove container
  log.info(`Removing Flux App component ${componentName} container...`);
  if (res) {
    res.write(serviceHelper.ensureString({ status: `Removing Flux App component ${componentName} container...` }));
    if (res.flush) res.flush();
  }

  let containerRemoved = false;
  if (force) {
    await dockerService.appDockerForceRemove(appId).then(() => {
      containerRemoved = true;
    }).catch((error) => {
      log.error(`Force remove failed for ${appId}: ${error.message}`);
      const errorResponse = messageHelper.createErrorMessage(error.message || error, error.name, error.code);
      if (res) {
        res.write(serviceHelper.ensureString(errorResponse));
        if (res.flush) res.flush();
      }
    });
  } else {
    await dockerService.appDockerRemove(appId).then(() => {
      containerRemoved = true;
    }).catch((error) => {
      log.error(`Container remove failed for ${appId}: ${error.message}`);
      const errorResponse = messageHelper.createErrorMessage(error.message || error, error.name, error.code);
      if (res) {
        res.write(serviceHelper.ensureString(errorResponse));
        if (res.flush) res.flush();
      }
    });
  }

  if (containerRemoved) {
    log.info(`Flux App component ${componentName} container removed`);
    if (res) {
      res.write(serviceHelper.ensureString({ status: `Flux App component ${componentName} container removed` }));
      if (res.flush) res.flush();
    }
  } else {
    log.warn(`WARNING: Container ${appId} may not have been fully removed. Network cleanup may fail.`);
    if (res) {
      res.write(serviceHelper.ensureString({ status: `WARNING: Container ${appId} may not have been fully removed. Network cleanup may fail.` }));
      if (res.flush) res.flush();
    }
  }

  // Cleanup ports
  // eslint-disable-next-line no-use-before-define
  await cleanupPorts(componentSpecifications, appName, res, `component ${componentName}`);

  // Unmount volume
  await unmountVolume(appId, `component ${componentName}`, res);

  // Clean up data
  await cleanupAppData(appId, `component ${componentName}`, res);

  // Clean up crontab and get volume path
  const volumepath = await cleanupCrontab(appId, res);

  // Clean up volume path
  await cleanupVolumePath(volumepath, `component ${componentName}`, res);

  // Remove image (only if container was successfully removed)
  if (containerRemoved) {
    log.info(`Removing Flux App component ${componentName} image...`);
    if (res) {
      res.write(serviceHelper.ensureString({ status: `Removing Flux App component ${componentName} image...` }));
      if (res.flush) res.flush();
    }

    await dockerService.appDockerImageRemove(componentSpecifications.repotag).catch((error) => {
      const errorResponse = messageHelper.createErrorMessage(error.message || error, error.name, error.code);
      log.error(errorResponse);
      if (res) {
        res.write(serviceHelper.ensureString(errorResponse));
        if (res.flush) res.flush();
      }
    });

    log.info(`Flux App component ${componentName} image operations done`);
    if (res) {
      res.write(serviceHelper.ensureString({ status: `Flux App component ${componentName} image operations done` }));
      if (res.flush) res.flush();
    }
  } else {
    log.warn(`Skipping image removal for ${appId} because container removal failed`);
  }

  log.info(`Flux App component ${componentName} of ${appName} was successfully removed`);
  if (res) {
    res.write(serviceHelper.ensureString({ status: `Flux App component ${componentName} of ${appName} was successfully removed` }));
    if (res.flush) res.flush();
  }
}

/**
 * Hard uninstall an application (complete removal including data)
 * @param {string} appName - Application name
 * @param {string} appId - Application ID
 * @param {object} appSpecifications - App specifications
 * @param {object} res - Response object for streaming
 * @param {function} stopAppMonitoring - Function to stop monitoring
 * @param {boolean} force - Use aggressive removal (kill + force remove) for stuck containers
 * @returns {Promise<void>}
 // eslint-disable-next-line no-shadow
 */
// eslint-disable-next-line no-shadow
async function hardUninstallApplication(appName, appId, appSpecifications, res, stopAppMonitoring, force = false) {
  // Stop monitoring and container
  log.info(`Stopping Flux App ${appName}...`);
  if (res) {
    res.write(serviceHelper.ensureString({ status: `Stopping Flux App ${appName}...` }));
    if (res.flush) res.flush();
  }

  if (stopAppMonitoring) {
    stopAppMonitoring(appName, true);
  }

  // Use kill instead of stop for forced removals
  if (force) {
    await dockerService.appDockerKill(appId).catch((error) => {
      log.warn(`Failed to kill container ${appId}: ${error.message}`);
      const errorResponse = messageHelper.createErrorMessage(error.message || error, error.name, error.code);
      if (res) {
        res.write(serviceHelper.ensureString(errorResponse));
        if (res.flush) res.flush();
      }
    });
  } else {
    await dockerService.appDockerStop(appId).catch((error) => {
      const errorResponse = messageHelper.createErrorMessage(error.message || error, error.name, error.code);
      if (res) {
        res.write(serviceHelper.ensureString(errorResponse));
        if (res.flush) res.flush();
      }
    });
  }

  log.info(`Flux App ${appName} stopped`);
  if (res) {
    res.write(serviceHelper.ensureString({ status: `Flux App ${appName} stopped` }));
    if (res.flush) res.flush();
  }

  // Stop Syncthing
  await stopSyncthingAndCleanup(appName, appId, res);

  // Remove container
  log.info(`Removing Flux App ${appName} container...`);
  if (res) {
    res.write(serviceHelper.ensureString({ status: `Removing Flux App ${appName} container...` }));
    if (res.flush) res.flush();
  }

  let containerRemoved = false;
  if (force) {
    await dockerService.appDockerForceRemove(appId).then(() => {
      containerRemoved = true;
    }).catch((error) => {
      log.error(`Force remove failed for ${appId}: ${error.message}`);
      const errorResponse = messageHelper.createErrorMessage(error.message || error, error.name, error.code);
      if (res) {
        res.write(serviceHelper.ensureString(errorResponse));
        if (res.flush) res.flush();
      }
    });
  } else {
    await dockerService.appDockerRemove(appId).then(() => {
      containerRemoved = true;
    }).catch((error) => {
      log.error(`Container remove failed for ${appId}: ${error.message}`);
      const errorResponse = messageHelper.createErrorMessage(error.message || error, error.name, error.code);
      if (res) {
        res.write(serviceHelper.ensureString(errorResponse));
        if (res.flush) res.flush();
      }
    });
  }

  if (containerRemoved) {
    log.info(`Flux App ${appName} container removed`);
    if (res) {
      res.write(serviceHelper.ensureString({ status: `Flux App ${appName} container removed` }));
      if (res.flush) res.flush();
    }
  } else {
    log.warn(`WARNING: Container ${appId} may not have been fully removed. Network cleanup may fail.`);
    if (res) {
      res.write(serviceHelper.ensureString({ status: `WARNING: Container ${appId} may not have been fully removed. Network cleanup may fail.` }));
      if (res.flush) res.flush();
    }
  }

  // Cleanup ports
  // eslint-disable-next-line no-use-before-define
  await cleanupPorts(appSpecifications, appName, res, appName);

  // Unmount volume
  await unmountVolume(appId, appName, res);

  // Clean up data
  await cleanupAppData(appId, appName, res);

  // Clean up crontab and get volume path
  const volumepath = await cleanupCrontab(appId, res);

  // Clean up volume path
  await cleanupVolumePath(volumepath, appName, res);

  // Remove image (only if container was successfully removed)
  if (containerRemoved) {
    log.info(`Removing Flux App ${appName} image...`);
    if (res) {
      res.write(serviceHelper.ensureString({ status: `Removing Flux App ${appName} image...` }));
      if (res.flush) res.flush();
    }

    await dockerService.appDockerImageRemove(appSpecifications.repotag).catch((error) => {
      const errorResponse = messageHelper.createErrorMessage(error.message || error, error.name, error.code);
      log.error(errorResponse);
      if (res) {
        res.write(serviceHelper.ensureString(errorResponse));
        if (res.flush) res.flush();
      }
    });

    log.info(`Flux App ${appName} image operations done`);
    if (res) {
      res.write(serviceHelper.ensureString({ status: `Flux App ${appName} image operations done` }));
      if (res.flush) res.flush();
    }
  } else {
    log.warn(`Skipping image removal for ${appId} because container removal failed`);
  }

  log.info(`Flux App ${appName} was successfully removed`);
  if (res) {
    res.write(serviceHelper.ensureString({ status: `Flux App ${appName} was successfuly removed` }));
    if (res.flush) res.flush();
  }
}

/**
 * Helper function to cleanup ports (firewall and UPnP)
 * @param {object} appSpecifications - App specifications
 * @param {string} appName - Application name
 * @param {object} res - Response object for streaming
 * @param {string} entityName - Name of entity for logging (app or component name)
 * @returns {Promise<void>}
 */
async function cleanupPorts(appSpecifications, appName, res, entityName) {
  const portStatus = {
    status: `Denying ${entityName} ports...`,
  };
  log.info(portStatus);
  if (res) {
    res.write(serviceHelper.ensureString(portStatus));
    if (res.flush) res.flush();
  }

  if (appSpecifications.ports) {
    const firewallActive = await fluxNetworkHelper.isFirewallActive();
    if (firewallActive) {
      // eslint-disable-next-line no-restricted-syntax
      for (const port of appSpecifications.ports) {
        // eslint-disable-next-line no-await-in-loop
        await fluxNetworkHelper.deleteAllowPortRule(serviceHelper.ensureNumber(port));
      }
    }
    const isUPNP = upnpService.isUPNP();
    if (isUPNP) {
      // eslint-disable-next-line no-restricted-syntax
      for (const port of appSpecifications.ports) {
        // eslint-disable-next-line no-await-in-loop
        await upnpService.removeMapUpnpPort(serviceHelper.ensureNumber(port), `Flux_App_${appName}`);
      }
    }
  } else if (appSpecifications.port) {
    // v1 compatibility
    const firewallActive = await fluxNetworkHelper.isFirewallActive();
    if (firewallActive) {
      await fluxNetworkHelper.deleteAllowPortRule(serviceHelper.ensureNumber(appSpecifications.port));
    }
    const isUPNP = upnpService.isUPNP();
    if (isUPNP) {
      await upnpService.removeMapUpnpPort(serviceHelper.ensureNumber(appSpecifications.port), `Flux_App_${appName}`);
    }
  }

  const portStatus2 = {
    status: `Ports of ${entityName} denied`,
  };
  log.info(portStatus2);
  if (res) {
    res.write(serviceHelper.ensureString(portStatus2));
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
 * Uninstall a single component. Unified replacement for softUninstallComponent
 * and hardUninstallComponent.
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

// eslint-disable-next-line no-shadow
async function softUninstallComponent(appName, appId, deployComp, res, stopAppMonitoring) {
  const label = deployComp.name === appName ? appName : `component ${deployComp.name} of ${appName}`;

  log.info(`Stopping Flux App ${label}...`);
  if (res) {
    res.write(serviceHelper.ensureString({ status: `Stopping Flux App ${label}...` }));
    if (res.flush) res.flush();
  }

  if (stopAppMonitoring) {
    stopAppMonitoring(deployComp.identifier, false);
  }

  await dockerService.appDockerStop(appId).catch((error) => {
    const errorResponse = messageHelper.createErrorMessage(error.message || error, error.name, error.code);
    if (res) {
      res.write(serviceHelper.ensureString(errorResponse));
      if (res.flush) res.flush();
    }
  });

  log.info(`Flux App ${label} stopped`);
  if (res) {
    res.write(serviceHelper.ensureString({ status: `Flux App ${label} stopped` }));
    if (res.flush) res.flush();
  }

  log.info(`Removing Flux App ${label} container...`);
  if (res) {
    res.write(serviceHelper.ensureString({ status: `Removing Flux App ${label} container...` }));
    if (res.flush) res.flush();
  }

  await dockerService.appDockerRemove(appId);

  log.info(`Flux App ${label} container removed`);
  if (res) {
    res.write(serviceHelper.ensureString({ status: `Flux App ${label} container removed` }));
    if (res.flush) res.flush();
  }

  log.info(`Removing Flux App ${label} image...`);
  if (res) {
    res.write(serviceHelper.ensureString({ status: `Removing Flux App ${label} image...` }));
    if (res.flush) res.flush();
  }

  await dockerService.appDockerImageRemove(deployComp.image).catch((error) => {
    const errorResponse = messageHelper.createErrorMessage(error.message || error, error.name, error.code);
    log.error(errorResponse);
    if (res) {
      res.write(serviceHelper.ensureString(errorResponse));
      if (res.flush) res.flush();
    }
  });

  log.info(`Flux App ${label} image operations done`);
  if (res) {
    res.write(serviceHelper.ensureString({ status: `Flux App ${label} image operations done` }));
    if (res.flush) res.flush();
  }

  // eslint-disable-next-line no-use-before-define
  await cleanupDeploymentPorts(deployComp, appName, res, label);

  log.info(`Flux App ${label} was successfully removed`);
  if (res) {
    res.write(serviceHelper.ensureString({ status: `Flux App ${label} was successfully removed` }));
    if (res.flush) res.flush();
  }
}


/**
 * Remove application completely from local node
 * @param {string} app - Application name
 * @param {object} res - Response object for streaming
 * @param {boolean} force - Force removal
 * @param {boolean} endResponse - Whether to end response
 * @param {boolean} sendMessage - Whether to send message to network
 * @returns {Promise<void>}
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
        return;
      }
      if (globalState.installationInProgress) {
        status('Another application is undergoing installation. Removal not possible.');
        return;
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
        throw new Error('Flux App not found');
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
            const s = message.appSpecifications || message.zelAppSpecifications;
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
      throw new Error('Flux App not found');
    }

    const { InstantiatedSpec } = await getSpecBackend();
    if (spec instanceof InstantiatedSpec) {
      spec = spec.spec;
    }

    if (spec.isEncrypted) {
      const provider = await legacyCryptoProvider.create(spec.name, spec.owner);
      spec = (await spec.decrypt(provider)).spec;
    }

    // clear node-local runtime state (operator stop lock, crash backoff) for the
    // removed component(s) so a later reinstall starts from a clean slate
    let removedIdentifiers;
    if (spec.version >= 4) {
      removedIdentifiers = isComponent
        ? [`${appComponent}_${spec.name}`]
        : spec.componentEntries().map(([, c]) => `${c.name}_${spec.name}`);
    } else {
      removedIdentifiers = [appName];
    }
    // eslint-disable-next-line no-restricted-syntax
    for (const identifier of removedIdentifiers) {
      // eslint-disable-next-line no-await-in-loop
      await appsRuntimeState.remove(identifier);
    }

    fluxEventBus.publish('app:removed', { name: appName });

    let appId = dockerService.getAppIdentifier(appName);

    if (spec.version >= 4 && !isComponent) {
      const componentsReversed = spec.componentEntries().map(([, c]) => c).reverse();
      for (const component of componentsReversed) {
        appId = dockerService.getAppIdentifier(`${component.name}_${spec.name}`);
        // eslint-disable-next-line no-await-in-loop
        await hardUninstallComponent(resolvedAppName, appId, component.toCanonical(), null, stopAppMonitoring, forceKill);
      }
    } else if (isComponent) {
      const component = spec.getComponent(appComponent);
      if (!component) {
        throw new Error(`Flux App component ${appComponent} not found in ${resolvedAppName}`);
      }
      appId = dockerService.getAppIdentifier(`${component.name}_${spec.name}`);
      await hardUninstallComponent(resolvedAppName, appId, component.toCanonical(), null, stopAppMonitoring, forceKill);
    } else {
      await hardUninstallApplication(resolvedAppName, appId, spec.serialize(), null, stopAppMonitoring, forceKill);
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
    }

    status(`Removal step done. Result: Flux App ${resolvedAppName} was successfully removed`);
  } catch (error) {
    log.error(`Error removing app ${appName}: ${error.message}`);
    status(`Error: ${error.message}`);
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
  uninstallApplication,
  uninstallComponent,
  hardUninstallComponent,
  hardUninstallApplication,
  softUninstallComponent,
  cleanupPorts,
  cleanupDeploymentPorts,
  removeAppLocallyApi,
};
