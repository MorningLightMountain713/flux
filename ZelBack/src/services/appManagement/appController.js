const config = require('config');
const axios = require('axios');
const serviceHelper = require('../serviceHelper');
// Removed verificationHelper to avoid circular dependency - will use dynamic require where needed
const messageHelper = require('../messageHelper');
const dockerService = require('../dockerService');
const appsRuntimeState = require('./appsRuntimeState');
const reconcilerQueue = require('../appMonitoring/reconcilerQueue');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const log = require('../../lib/log');
const { Privilege, authOf } = require('../utils/privileges');
const appsRepository = require('../appDatabase/appsRepository');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const { extractIp, extractPort } = require('../utils/socketAddressUtils');

const { globalCmdDelayMs } = config.fluxapps;
// Guaranteed a finite non-negative integer, so a missing or malformed config
// value can never spin the retry loop below forever.
const globalCmdBootRetries = (Number.isInteger(config.fluxapps.globalCmdBootRetries)
  && config.fluxapps.globalCmdBootRetries >= 0)
  ? config.fluxapps.globalCmdBootRetries
  : 8;

// A node still reconciling its apps after boot refuses these routes with 15s.
const BOOT_RETRY_AFTER_FALLBACK_S = 15;
// Caps a node's Retry-After so a hostile or absurd value cannot stall delivery.
const BOOT_RETRY_MAX_WAIT_MS = 60 * 1000;

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
 * Send one global command to one instance, retrying only a boot-gate refusal.
 *
 * A node that has not finished reconciling its apps after boot answers these
 * routes with 503 + Retry-After (see requireBootSettled), which is
 * self-resolving - it settles within its boot window. Retrying that a bounded
 * number of times keeps a global command from being dropped on the first
 * refusal: without it a global appremove aimed at a node mid-restart never
 * lands, the app stays installed and running, and the owner was already told
 * the removal was queried. ONLY a 503 is retried; any other status is the
 * node's real answer and is final, and a node still refusing after the bound is
 * warned about rather than hammered forever.
 *
 * Errors are handled internally, so this never rejects - callers fire it and
 * move on.
 *
 * @param {string} url
 * @param {object} axiosConfig
 */
async function deliverGlobalCommand(url, axiosConfig) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await axios.get(url, axiosConfig);
      log.info(`Successfully sent command to ${url}: ${response.status}`);
      return;
    } catch (error) {
      const status = error.response && error.response.status;
      if (status !== 503) {
        log.error(`Axios request failed for ${url}`, error);
        return;
      }
      if (attempt >= globalCmdBootRetries) {
        log.warn(`Node at ${url} still reconciling apps after boot; command not delivered after ${globalCmdBootRetries} retries`);
        return;
      }
      const headerRetryAfter = Number(error.response.headers && error.response.headers['retry-after']);
      const retryAfterS = headerRetryAfter > 0 ? headerRetryAfter : BOOT_RETRY_AFTER_FALLBACK_S;
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(Math.min(retryAfterS * 1000, BOOT_RETRY_MAX_WAIT_MS));
    }
  }
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
      // Fire-and-forget: each node's delivery, with its own bounded retry of a
      // boot-gate 503, runs on its own while the loop paces the sends.
      deliverGlobalCommand(url, axiosConfig);
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
/**
 * Apply an operator run-state command to every target component THROUGH the
 * reconciler (the sole actuator): record the durable intent, then enqueue so the
 * reconciler converges the container to it. A whole-app command (appname has no
 * '_') fans out across the deployment's components; a component command targets
 * just that component. Intent is recorded BEFORE the enqueue so a crash in between
 * still leaves the reconciler converging to the operator's recorded wish, never the
 * opposite. The reconciler honours election/dependency gates itself, so an operator
 * start of a non-elected activeStandby component is correctly held, not force-started.
 *
 * @param {string} appname app or component identifier
 * @param {object|null} deployment DeploymentSpec (null for a component command)
 * @param {(id: string) => Promise<void>} recordIntent records the durable intent for one component
 * @returns {Promise<void>}
 */
async function driveOperatorCommand(appname, deployment, recordIntent) {
  const ids = (!appname.includes('_') && deployment)
    ? deployment.componentEntries().map(([, c]) => c.identifier)
    : [appname];
  // eslint-disable-next-line no-restricted-syntax
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    await recordIntent(id);
    reconcilerQueue.enqueue(id);
  }
}

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
    const authorized = await verificationHelper.verifyPrivilege(Privilege.APP_OWNER_OR_FLUX_TEAM, authOf(req), { appName: mainAppName });
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
    let deployment = null;
    let appRes;
    if (isComponent) {
      appRes = `Component ${appname} started`;
    } else {
      const instantiated = await appsRepository.getGlobalAppInfo(mainAppName);
      if (!instantiated) {
        throw new Error('Application not found');
      }
      deployment = await deploymentProvider.buildDeployment(instantiated);
      appRes = `Application ${instantiated.name} started`;
    }
    // clear the operator stop lock; the reconciler then (re)starts each component,
    // honouring its own election/dependency gates (a non-elected activeStandby
    // component is held at awaitingController, never force-started).
    await driveOperatorCommand(appname, deployment, (id) => appsRuntimeState.setOperatorStopped(id, false));

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
    const authorized = await verificationHelper.verifyPrivilege(Privilege.APP_OWNER_OR_FLUX_TEAM, authOf(req), { appName: mainAppName });
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
    let deployment = null;
    let appRes;
    if (isComponent) {
      appRes = `Component ${appname} stopped`;
    } else {
      const instantiated = await appsRepository.getGlobalAppInfo(mainAppName);
      if (!instantiated) {
        throw new Error('Application not found');
      }
      deployment = await deploymentProvider.buildDeployment(instantiated);
      appRes = `Application ${instantiated.name} stopped`;
    }
    // operator stop persists (the reconciler will not restart a stopped app); the
    // reconciler does the actual stop + stops monitoring on its stop branch.
    await driveOperatorCommand(appname, deployment, (id) => appsRuntimeState.setOperatorStopped(id, true));

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
    const authorized = await verificationHelper.verifyPrivilege(Privilege.APP_OWNER_OR_FLUX_TEAM, authOf(req), { appName: mainAppName });
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
    let deployment = null;
    let appRes;
    if (isComponent) {
      appRes = `Component ${appname} restarted`;
    } else {
      const instantiated = await appsRepository.getGlobalAppInfo(mainAppName);
      if (!instantiated) {
        throw new Error('Application not found');
      }
      deployment = await deploymentProvider.buildDeployment(instantiated);
      appRes = `Application ${instantiated.name} restarted`;
    }
    // user-initiated restart = "make it run now": clear the operator stop lock AND
    // bump the durable restart generation, so the reconciler restarts a running
    // container (or starts a stopped one) and honours its election/dependency gates.
    await driveOperatorCommand(appname, deployment, async (id) => {
      await appsRuntimeState.setOperatorStopped(id, false);
      await appsRuntimeState.requestRestart(id);
    });

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
    const authorized = await verificationHelper.verifyPrivilege(Privilege.APP_OWNER_OR_FLUX_TEAM, authOf(req), { appName: mainAppName });
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      return res ? res.json(errMessage) : errMessage;
    }

    const isComponent = appname.includes('_');
    let deployment = null;
    let appRes;
    if (isComponent) {
      appRes = `Component ${appname} killed`;
    } else {
      const instantiated = await appsRepository.getGlobalAppInfo(mainAppName);
      if (!instantiated) {
        throw new Error('Application not found');
      }
      deployment = await deploymentProvider.buildDeployment(instantiated);
      appRes = `Application ${instantiated.name} killed`;
    }
    // operator kill = force-stop now: durable operatorStopped carrying the force
    // mode (so a crash never downgrades it to the app's graceful window); the
    // reconciler's desired-stopped branch honours force with appDockerKill.
    await driveOperatorCommand(appname, deployment, (id) => appsRuntimeState.setOperatorStopped(id, true, { force: true }));

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
    const authorized = await verificationHelper.verifyPrivilege(Privilege.APP_OWNER_OR_FLUX_TEAM, authOf(req), { appName: mainAppName });
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
      const deployment = await deploymentProvider.buildDeployment(instantiated);
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
    const authorized = await verificationHelper.verifyPrivilege(Privilege.APP_OWNER_OR_FLUX_TEAM, authOf(req), { appName: mainAppName });
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
      const deployment = await deploymentProvider.buildDeployment(instantiated);
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
 *
 * What is kept is everything FluxOS owns, not everything that is an app: the
 * node runs short-lived containers of its own - a file operation is one - and
 * those are unnamed, so docker gives them a random name that no prefix test can
 * tell from a tenant's. Selecting on the ownership label instead means a long
 * copy is not stopped out from under its caller by a sweep that runs every two
 * hours.
 */
async function stopAllNonFluxRunningApps() {
  try {
    log.info('Running non Flux apps check...');
    let apps = await dockerService.dockerListContainers(false);
    apps = apps.filter((app) => !dockerService.isFluxOwnedContainer(app));
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

async function createFluxNetworkAPI(req, res) {
  try {
    // eslint-disable-next-line global-require
    const verificationHelper = require('../verificationHelper');
    const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      return res.json(errMessage);
    }
    const dockerRes = await dockerService.createFluxDockerNetwork();
    const response = messageHelper.createDataMessage(dockerRes);
    return res.json(response);
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
  executeAppGlobalCommand,
  deliverGlobalCommand,
  appStart,
  appStop,
  appRestart,
  appKill,
  appPause,
  appUnpause,
  appDockerRestart,
  stopAllNonFluxRunningApps,
  createFluxNetworkAPI,
};
