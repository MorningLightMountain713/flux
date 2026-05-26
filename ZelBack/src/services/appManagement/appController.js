const config = require('config');
const axios = require('axios');
const serviceHelper = require('../serviceHelper');
// Removed verificationHelper to avoid circular dependency - will use dynamic require where needed
const messageHelper = require('../messageHelper');
const dockerService = require('../dockerService');
const appInspector = require('./appInspector');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const log = require('../../lib/log');
const appsRepository = require('../appDatabase/appsRepository');
const { getSpecBackend } = require('../utils/specLibs');
const { appsFolder } = require('../utils/appConstants');
const { extractIp, extractPort } = require('../utils/socketAddressUtils');

const globalCmdDelayMs = config.fluxapps.globalCmdDelayMs;

/**
 * Get application locations from the global database
 * @param {string} appname - Application name
 * @returns {Promise<Array>} Application locations
 */
async function appLocation(appname) {
  if (appname) {
    return appsRepository.listLocationsByApp(appname);
  }
  return appsRepository.listLocations();
}

/**
 * Execute a global command on an application across the network
 * @param {string} appname - Application name
 * @param {string} command - Command to execute
 * @param {string} zelidauth - Authorization header
 * @param {string} [paramA] - Additional parameter to append to URL
 * @param {boolean} [bypassMyIp] - Whether to bypass own IP
 * @returns {Promise<void>}
 */
async function executeAppGlobalCommand(appname, command, zelidauth, paramA, bypassMyIp) {
  try {
    // get a list of the specific app locations
    const locations = await appLocation(appname);
    const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
    const localIp = extractIp(localSocketAddr);
    const localPort = extractPort(localSocketAddr);
    // eslint-disable-next-line no-restricted-syntax
    for (const appInstance of locations) {
      const instanceIp = extractIp(appInstance.ip);
      const instancePort = extractPort(appInstance.ip);
      if (bypassMyIp && localIp === instanceIp && localPort === instancePort) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const axiosConfig = {
        headers: {
          zelidauth,
        },
      };
      let url = `http://${instanceIp}:${instancePort}/apps/${command}/${appname}`;
      if (paramA) {
        url += `/${paramA}`;
      }
      axios.get(url, axiosConfig)
        .then((response) => {
          log.info(`Successfully sent command to ${url}: ${response.status}`);
        })
        .catch((error) => {
          log.error(`Axios request failed for ${url}`, error);
        });
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(globalCmdDelayMs);
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * Start an application
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @returns {object} Response message
 */
async function appStart(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;
    let { global } = req.params;
    global = global || req.query.global || false;
    global = serviceHelper.ensureBoolean(global);

    if (!appname) {
      throw new Error('No Flux App specified');
    }

    const mainAppName = appname.split('_')[1] || appname;

    // eslint-disable-next-line global-require
    // Use dynamic require to avoid circular dependency
    // eslint-disable-next-line global-require
    const verificationHelper = require('../verificationHelper');
    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, mainAppName);
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      return res ? res.json(errMessage) : errMessage;
    }

    if (global) {
      executeAppGlobalCommand(appname, 'appstart', req.headers.zelidauth); // do not wait
      const appResponse = messageHelper.createSuccessMessage(`${appname} queried for global start`);
      return res ? res.json(appResponse) : appResponse;
    }

    const isComponent = appname.includes('_');
    let appRes;

    const instantiated = await appsRepository.getGlobalAppInfo(mainAppName);
    if (!instantiated) {
      throw new Error('Application not found');
    }
    const { DeploymentSpec } = await getSpecBackend();
    const deployment = DeploymentSpec.fromSpec(instantiated.spec, appsFolder);

    if (isComponent) {
      const compName = appname.split('_')[0];
      const deployComp = deployment.getComponent(compName);
      if (deployComp && deployComp.hasActiveStandbySyncthing()) {
        try {
          const containers = await dockerService.dockerListContainers(false);
          const isRunning = containers.some((container) => container.Names[0] === dockerService.getAppDockerNameIdentifier(appname) || container.Id === appname);
          if (!isRunning) {
            log.info(`Skipping start for activeStandby syncthing component ${appname} - not currently running`);
            appRes = `Component ${appname} uses activeStandby syncthing and is not running - skipped start`;
            const appResponse = messageHelper.createDataMessage(appRes);
            return res ? res.json(appResponse) : appResponse;
          }
        } catch (error) {
          log.warn(`Could not check running status for ${appname}: ${error.message}`);
        }
      }
      appRes = await dockerService.appDockerStart(appname);
      appInspector.startAppMonitoring(appname);
    } else {
      for (const [, deployComp] of deployment.componentEntries()) {
        if (deployComp.hasActiveStandbySyncthing()) {
          try {
            // eslint-disable-next-line no-await-in-loop
            const containers = await dockerService.dockerListContainers(false);
            const isRunning = containers.some((container) => container.Names[0] === dockerService.getAppDockerNameIdentifier(deployComp.identifier) || container.Id === deployComp.identifier);
            if (!isRunning) {
              log.info(`Skipping start for activeStandby syncthing component ${deployComp.identifier} - not currently running`);
              // eslint-disable-next-line no-continue
              continue;
            }
          } catch (error) {
            log.warn(`Could not check running status for ${deployComp.identifier}: ${error.message}`);
          }
        }
        // eslint-disable-next-line no-await-in-loop
        await dockerService.appDockerStart(deployComp.identifier);
        appInspector.startAppMonitoring(deployComp.identifier);
      }
      appRes = `Application ${instantiated.name} started`;
    }

    const appResponse = messageHelper.createDataMessage(appRes);
    return res ? res.json(appResponse) : appResponse;
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    return res ? res.json(errorResponse) : errorResponse;
  }
}

/**
 * Stop an application
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @returns {object} Response message
 */
async function appStop(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;
    let { global } = req.params;
    global = global || req.query.global || false;
    global = serviceHelper.ensureBoolean(global);

    if (!appname) {
      throw new Error('No Flux App specified');
    }
    // eslint-disable-next-line global-require

    const mainAppName = appname.split('_')[1] || appname;

    // Use dynamic require to avoid circular dependency
    // eslint-disable-next-line global-require
    const verificationHelper = require('../verificationHelper');
    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, mainAppName);
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      return res ? res.json(errMessage) : errMessage;
    }

    if (global) {
      executeAppGlobalCommand(appname, 'appstop', req.headers.zelidauth); // do not wait
      const appResponse = messageHelper.createSuccessMessage(`${appname} queried for global stop`);
      return res ? res.json(appResponse) : appResponse;
    }

    const isComponent = appname.includes('_'); // it is a component stop
    let appRes;

    if (isComponent) {
      appInspector.stopAppMonitoring(appname, false);
      appRes = await dockerService.appDockerStop(appname);
    } else {
      const instantiated = await appsRepository.getGlobalAppInfo(mainAppName);
      if (!instantiated) {
        throw new Error('Application not found');
      }
      const { DeploymentSpec } = await getSpecBackend();
      const deployment = DeploymentSpec.fromSpec(instantiated.spec, appsFolder);
      for (const [, deployComp] of deployment.componentEntries({ reverse: true })) {
        appInspector.stopAppMonitoring(deployComp.identifier, false);
        // eslint-disable-next-line no-await-in-loop
        await dockerService.appDockerStop(deployComp.identifier);
      }
      appRes = `Application ${instantiated.name} stopped`;
    }

    const appResponse = messageHelper.createDataMessage(appRes);
    return res ? res.json(appResponse) : appResponse;
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    return res ? res.json(errorResponse) : errorResponse;
  }
}

/**
 * Restart an application
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @returns {object} Response message
 */
async function appRestart(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;
    let { global } = req.params;
    global = global || req.query.global || false;
    global = serviceHelper.ensureBoolean(global);

    // eslint-disable-next-line global-require
    if (!appname) {
      throw new Error('No Flux App specified');
    }

    const mainAppName = appname.split('_')[1] || appname;

    // Use dynamic require to avoid circular dependency
    // eslint-disable-next-line global-require
    const verificationHelper = require('../verificationHelper');
    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, mainAppName);
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      return res ? res.json(errMessage) : errMessage;
    }

    if (global) {
      executeAppGlobalCommand(appname, 'apprestart', req.headers.zelidauth); // do not wait
      const appResponse = messageHelper.createSuccessMessage(`${appname} queried for global restart`);
      return res ? res.json(appResponse) : appResponse;
    }

    const isComponent = appname.includes('_');
    let appRes;

    const instantiated = await appsRepository.getGlobalAppInfo(mainAppName);
    if (!instantiated) {
      throw new Error('Application not found');
    }
    const { DeploymentSpec } = await getSpecBackend();
    const deployment = DeploymentSpec.fromSpec(instantiated.spec, appsFolder);

    if (isComponent) {
      const compName = appname.split('_')[0];
      const deployComp = deployment.getComponent(compName);
      if (deployComp && deployComp.hasActiveStandbySyncthing()) {
        try {
          const containers = await dockerService.dockerListContainers(false);
          const isRunning = containers.some((container) => container.Names[0] === dockerService.getAppDockerNameIdentifier(appname) || container.Id === appname);
          if (!isRunning) {
            log.info(`Skipping restart for activeStandby syncthing component ${appname} - not currently running`);
            appRes = `Component ${appname} uses activeStandby syncthing and is not running - skipped restart`;
            const appResponse = messageHelper.createDataMessage(appRes);
            return res ? res.json(appResponse) : appResponse;
          }
        } catch (error) {
          log.warn(`Could not check running status for ${appname}: ${error.message}`);
        }
      }
      appRes = await dockerService.appDockerRestart(appname);
    } else {
      for (const [, deployComp] of deployment.componentEntries()) {
        if (deployComp.hasActiveStandbySyncthing()) {
          try {
            // eslint-disable-next-line no-await-in-loop
            const containers = await dockerService.dockerListContainers(false);
            const isRunning = containers.some((container) => container.Names[0] === dockerService.getAppDockerNameIdentifier(deployComp.identifier) || container.Id === deployComp.identifier);
            if (!isRunning) {
              log.info(`Skipping restart for activeStandby syncthing component ${deployComp.identifier} - not currently running`);
              // eslint-disable-next-line no-continue
              continue;
            }
          } catch (error) {
            log.warn(`Could not check running status for ${deployComp.identifier}: ${error.message}`);
          }
        }
        // eslint-disable-next-line no-await-in-loop
        await dockerService.appDockerRestart(deployComp.identifier);
      }
      appRes = `Application ${instantiated.name} restarted`;
    }

    const appResponse = messageHelper.createDataMessage(appRes);
    return res ? res.json(appResponse) : appResponse;
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    return res ? res.json(errorResponse) : errorResponse;
  }
}

/**
 * Kill an application
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @returns {object} Response message
 */
async function appKill(req, res) {
  try {
    let { appname } = req.params;
    // eslint-disable-next-line global-require
    appname = appname || req.query.appname;

    if (!appname) {
      throw new Error('No Flux App specified');
    }

    const mainAppName = appname.split('_')[1] || appname;

    // Use dynamic require to avoid circular dependency
    // eslint-disable-next-line global-require
    const verificationHelper = require('../verificationHelper');
    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, mainAppName);
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      return res ? res.json(errMessage) : errMessage;
    }

    const isComponent = appname.includes('_');
    let appRes;

    if (isComponent) {
      appRes = await dockerService.appDockerKill(appname);
    } else {
      const instantiated = await appsRepository.getGlobalAppInfo(mainAppName);
      if (!instantiated) {
        throw new Error('Application not found');
      }
      const { DeploymentSpec } = await getSpecBackend();
      const deployment = DeploymentSpec.fromSpec(instantiated.spec, appsFolder);
      for (const [, deployComp] of deployment.componentEntries({ reverse: true })) {
        // eslint-disable-next-line no-await-in-loop
        await dockerService.appDockerKill(deployComp.identifier);
      }
      appRes = `Application ${instantiated.name} killed`;
    }

    const appResponse = messageHelper.createDataMessage(appRes);
    return res ? res.json(appResponse) : appResponse;
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    return res ? res.json(errorResponse) : errorResponse;
  }
}

/**
 * Pause an application
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @returns {object} Response message
 */
async function appPause(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;
    // eslint-disable-next-line global-require
    let { global } = req.params;
    global = global || req.query.global || false;
    global = serviceHelper.ensureBoolean(global);

    if (!appname) {
      throw new Error('No Flux App specified');
    }

    const mainAppName = appname.split('_')[1] || appname;

    // Use dynamic require to avoid circular dependency
    // eslint-disable-next-line global-require
    const verificationHelper = require('../verificationHelper');
    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, mainAppName);
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      return res ? res.json(errMessage) : errMessage;
    }

    if (global) {
      executeAppGlobalCommand(appname, 'apppause', req.headers.zelidauth); // do not wait
      const appResponse = messageHelper.createSuccessMessage(`${appname} queried for global pause`);
      return res ? res.json(appResponse) : appResponse;
    }

    const isComponent = appname.includes('_');
    let appRes;

    if (isComponent) {
      appRes = await dockerService.appDockerPause(appname);
    } else {
      const instantiated = await appsRepository.getGlobalAppInfo(mainAppName);
      if (!instantiated) {
        throw new Error('Application not found');
      }
      const { DeploymentSpec } = await getSpecBackend();
      const deployment = DeploymentSpec.fromSpec(instantiated.spec, appsFolder);
      for (const [, deployComp] of deployment.componentEntries({ reverse: true })) {
        // eslint-disable-next-line no-await-in-loop
        await dockerService.appDockerPause(deployComp.identifier);
      }
      appRes = `Application ${instantiated.name} paused`;
    }

    const appResponse = messageHelper.createDataMessage(appRes);
    return res ? res.json(appResponse) : appResponse;
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    return res ? res.json(errorResponse) : errorResponse;
  }
}

/**
 * Unpause an application
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @returns {object} Response message
 */
async function appUnpause(req, res) {
  try {
    // eslint-disable-next-line global-require
    let { appname } = req.params;
    appname = appname || req.query.appname;
    let { global } = req.params;
    global = global || req.query.global || false;
    global = serviceHelper.ensureBoolean(global);

    if (!appname) {
      throw new Error('No Flux App specified');
    }

    const mainAppName = appname.split('_')[1] || appname;

    // Use dynamic require to avoid circular dependency
    // eslint-disable-next-line global-require
    const verificationHelper = require('../verificationHelper');
    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, mainAppName);
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      return res ? res.json(errMessage) : errMessage;
    }

    if (global) {
      executeAppGlobalCommand(appname, 'appunpause', req.headers.zelidauth); // do not wait
      const appResponse = messageHelper.createSuccessMessage(`${appname} queried for global unpase`);
      return res ? res.json(appResponse) : appResponse;
    }

    const isComponent = appname.includes('_');
    let appRes;

    if (isComponent) {
      appRes = await dockerService.appDockerUnpause(appname);
    } else {
      const instantiated = await appsRepository.getGlobalAppInfo(mainAppName);
      if (!instantiated) {
        throw new Error('Application not found');
      }
      const { DeploymentSpec } = await getSpecBackend();
      const deployment = DeploymentSpec.fromSpec(instantiated.spec, appsFolder);
      for (const [, deployComp] of deployment.componentEntries()) {
        // eslint-disable-next-line no-await-in-loop
        await dockerService.appDockerUnpause(deployComp.identifier);
      }
      appRes = `Application ${instantiated.name} unpaused`;
    }

    const appResponse = messageHelper.createDataMessage(appRes);
    return res ? res.json(appResponse) : appResponse;
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    return res ? res.json(errorResponse) : errorResponse;
  }
}

/**
 * Docker restart app (internal function)
 * @param {string} appname - Application name
 * @returns {Promise<void>}
 */
async function appDockerRestart(appname) {
  try {
    // mainAppName extracted for potential future use
    // eslint-disable-next-line no-unused-vars
    const mainAppName = appname.split('_')[1] || appname;
    const isComponent = appname.includes('_'); // it is a component restart. Proceed with restarting just component
    if (isComponent) {
      await dockerService.appDockerRestart(appname);
      // Note: startAppMonitoring would need to be injected or called separately
      log.info(`Component ${appname} restarted successfully`);
    } else {
      log.info(`Restarting entire application ${appname}`);
      await dockerService.appDockerRestart(appname);
    }
  } catch (error) {
    log.error(`Docker restart failed for ${appname}: ${error.message}`);
    throw error;
  }
}

/**
 * To stop all non Flux running apps. Executes continuously at regular intervals.
 */
async function stopAllNonFluxRunningApps() {
  try {
    log.info('Running non Flux apps check...');
    let apps = await dockerService.dockerListContainers(false);
    apps = apps.filter((app) => (app.Names[0].slice(1, 4) !== 'zel' && app.Names[0].slice(1, 5) !== 'flux'));
    if (apps.length > 0) {
      log.info(`Found ${apps.length} apps to be stopped...`);
      // eslint-disable-next-line no-restricted-syntax
      for (const app of apps) {
        try {
          log.info(`Stopping non Flux app ${app.Names[0]}`);
          // eslint-disable-next-line no-await-in-loop
          await dockerService.appDockerStop(app.Id); // continue if failed to stop one app
          log.info(`Non Flux app ${app.Names[0]} stopped.`);
        } catch (error) {
          log.error(`Failed to stop non Flux app ${app.Names[0]}.`);
        }
      }
    } else {
      log.info('Only Flux apps are running.');
    }
    setTimeout(() => {
      stopAllNonFluxRunningApps();
    }, 2 * 60 * 60 * 1000); // execute every 2h
  } catch (error) {
    log.error(error);
    setTimeout(() => {
      stopAllNonFluxRunningApps();
    }, 30 * 60 * 1000); // In case of an error execute after 30m
  }
}

module.exports = {
  executeAppGlobalCommand,
  appStart,
  appStop,
  appRestart,
  appKill,
  appPause,
  appUnpause,
  appDockerRestart,
  stopAllNonFluxRunningApps,
};
