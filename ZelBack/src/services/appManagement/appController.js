const serviceHelper = require('../serviceHelper');
// Removed verificationHelper to avoid circular dependency - will use dynamic require where needed
const messageHelper = require('../messageHelper');
const dockerService = require('../dockerService');
const appsRuntimeState = require('./appsRuntimeState');
const reconcilerQueue = require('../appMonitoring/reconcilerQueue');
const log = require('../../lib/log');
const appsRepository = require('../appDatabase/appsRepository');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const globalCommand = require('./globalCommand');

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
 * @param {object[]|null} deployments DeploymentSpec per targeted identity (null for a component command)
 * @param {(id: string) => Promise<void>} recordIntent records the durable intent for one component
 * @returns {Promise<void>}
 */
async function driveOperatorCommand(appname, deployments, recordIntent) {
  const ids = (!appname.includes('_') && deployments)
    ? deployments.flatMap((deployment) => deployment.componentEntries().map(([, c]) => c.identifier))
    : [appname];
  // eslint-disable-next-line no-restricted-syntax
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    await recordIntent(id);
    reconcilerQueue.enqueue(id);
  }
}

/**
 * The deployments a whole-app operator command targets on this node: every local
 * deployment, or exactly the named identity's when the command is replica-scoped
 * (?replica=). Throws when the app — or the named replica — is not deployed here.
 * @param {string} mainAppName
 * @param {string|null} replica
 * @returns {Promise<{instantiated: object, deployments: object[]}>}
 */
async function resolveCommandDeployments(mainAppName, replica) {
  const instantiated = await appsRepository.getGlobalAppInfo(mainAppName);
  if (!instantiated) {
    throw new Error('Application not found');
  }
  let deployments = await deploymentProvider.buildDeployments(instantiated);
  if (replica != null) {
    deployments = deployments.filter((deployment) => deployment.replica === replica);
    if (deployments.length === 0) {
      throw new Error(`Replica ${replica} of ${instantiated.name} is not deployed on this node`);
    }
  }
  return { instantiated, deployments };
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
    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, mainAppName);
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      return res ? res.json(errMessage) : errMessage;
    }

    const replica = req.query.replica || null;

    if (global) {
      globalCommand.executeAppGlobalCommand(appname, 'appstart', req.headers.zelidauth, undefined, undefined, replica); // do not wait
      const appResponse = messageHelper.createSuccessMessage(`${appname} queried for global start`);
      return res ? res.json(appResponse) : appResponse;
    }

    const isComponent = appname.includes('_');
    let deployments = null;
    let appRes;
    if (isComponent) {
      appRes = `Component ${appname} started`;
    } else {
      const resolved = await resolveCommandDeployments(mainAppName, replica);
      ({ deployments } = resolved);
      appRes = replica != null
        ? `Replica ${replica} of ${resolved.instantiated.name} started`
        : `Application ${resolved.instantiated.name} started`;
    }
    // clear the operator stop lock; the reconciler then (re)starts each component,
    // honouring its own election/dependency gates (a non-elected activeStandby
    // component is held at awaitingController, never force-started).
    await driveOperatorCommand(appname, deployments, (id) => appsRuntimeState.setOperatorStopped(id, false));

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
 * @param {import('express').Request} req
 * @param {import('express').Response} res
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

    const replica = req.query.replica || null;

    if (global) {
      globalCommand.executeAppGlobalCommand(appname, 'appstop', req.headers.zelidauth, undefined, undefined, replica); // do not wait
      const appResponse = messageHelper.createSuccessMessage(`${appname} queried for global stop`);
      return res ? res.json(appResponse) : appResponse;
    }

    const isComponent = appname.includes('_'); // it is a component stop
    let deployments = null;
    let appRes;
    if (isComponent) {
      appRes = `Component ${appname} stopped`;
    } else {
      const resolved = await resolveCommandDeployments(mainAppName, replica);
      ({ deployments } = resolved);
      appRes = replica != null
        ? `Replica ${replica} of ${resolved.instantiated.name} stopped`
        : `Application ${resolved.instantiated.name} stopped`;
    }
    // operator stop persists (the reconciler will not restart a stopped app); the
    // reconciler does the actual stop + stops monitoring on its stop branch.
    await driveOperatorCommand(appname, deployments, (id) => appsRuntimeState.setOperatorStopped(id, true));

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
 * @param {import('express').Request} req
 * @param {import('express').Response} res
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

    const replica = req.query.replica || null;

    if (global) {
      globalCommand.executeAppGlobalCommand(appname, 'apprestart', req.headers.zelidauth, undefined, undefined, replica); // do not wait
      const appResponse = messageHelper.createSuccessMessage(`${appname} queried for global restart`);
      return res ? res.json(appResponse) : appResponse;
    }

    const isComponent = appname.includes('_');
    let deployments = null;
    let appRes;
    if (isComponent) {
      appRes = `Component ${appname} restarted`;
    } else {
      const resolved = await resolveCommandDeployments(mainAppName, replica);
      ({ deployments } = resolved);
      appRes = replica != null
        ? `Replica ${replica} of ${resolved.instantiated.name} restarted`
        : `Application ${resolved.instantiated.name} restarted`;
    }
    // user-initiated restart = "make it run now": clear the operator stop lock AND
    // bump the durable restart generation, so the reconciler restarts a running
    // container (or starts a stopped one) and honours its election/dependency gates.
    await driveOperatorCommand(appname, deployments, async (id) => {
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
 * @param {import('express').Request} req
 * @param {import('express').Response} res
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

    const replica = req.query.replica || null;
    const isComponent = appname.includes('_');
    let deployments = null;
    let appRes;
    if (isComponent) {
      appRes = `Component ${appname} killed`;
    } else {
      const resolved = await resolveCommandDeployments(mainAppName, replica);
      ({ deployments } = resolved);
      appRes = replica != null
        ? `Replica ${replica} of ${resolved.instantiated.name} killed`
        : `Application ${resolved.instantiated.name} killed`;
    }
    // operator kill = force-stop now: durable operatorStopped carrying the force
    // mode (so a crash never downgrades it to the app's graceful window); the
    // reconciler's desired-stopped branch honours force with appDockerKill.
    await driveOperatorCommand(appname, deployments, (id) => appsRuntimeState.setOperatorStopped(id, true, { force: true }));

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
 * @param {import('express').Request} req
 * @param {import('express').Response} res
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

    const replica = req.query.replica || null;

    if (global) {
      globalCommand.executeAppGlobalCommand(appname, 'apppause', req.headers.zelidauth, undefined, undefined, replica); // do not wait
      const appResponse = messageHelper.createSuccessMessage(`${appname} queried for global pause`);
      return res ? res.json(appResponse) : appResponse;
    }

    const isComponent = appname.includes('_');
    let appRes;

    if (isComponent) {
      appRes = await dockerService.appDockerPause(appname);
    } else {
      const resolved = await resolveCommandDeployments(mainAppName, replica);
      for (const deployment of resolved.deployments) {
        for (const [, deployComp] of deployment.componentEntries({ reverse: true })) {
          // eslint-disable-next-line no-await-in-loop
          await dockerService.appDockerPause(deployComp.identifier);
        }
      }
      appRes = replica != null
        ? `Replica ${replica} of ${resolved.instantiated.name} paused`
        : `Application ${resolved.instantiated.name} paused`;
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
 * @param {import('express').Request} req
 * @param {import('express').Response} res
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

    const replica = req.query.replica || null;

    if (global) {
      globalCommand.executeAppGlobalCommand(appname, 'appunpause', req.headers.zelidauth, undefined, undefined, replica); // do not wait
      const appResponse = messageHelper.createSuccessMessage(`${appname} queried for global unpase`);
      return res ? res.json(appResponse) : appResponse;
    }

    const isComponent = appname.includes('_');
    let appRes;

    if (isComponent) {
      appRes = await dockerService.appDockerUnpause(appname);
    } else {
      const resolved = await resolveCommandDeployments(mainAppName, replica);
      for (const deployment of resolved.deployments) {
        for (const [, deployComp] of deployment.componentEntries()) {
          // eslint-disable-next-line no-await-in-loop
          await dockerService.appDockerUnpause(deployComp.identifier);
        }
      }
      appRes = replica != null
        ? `Replica ${replica} of ${resolved.instantiated.name} unpaused`
        : `Application ${resolved.instantiated.name} unpaused`;
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
 * Repair-restart an app (or single component) THROUGH the reconciler: bump the
 * durable restart generation per component and enqueue, so the reconciler bounces
 * the running container(s) to pick up an out-of-band change (a node IP change,
 * recreated mounts). Unlike an operator restart it does NOT touch the operator stop
 * lock — a deliberately-stopped app stays stopped. Used by fluxNetworkMonitor on
 * IP change.
 * @param {string} appname - App or component name
 * @returns {Promise<void>}
 */
async function requestAppRestart(appname) {
  let deployments = null;
  if (!appname.includes('_')) {
    const resolved = await resolveCommandDeployments(appname, null);
    ({ deployments } = resolved);
  }
  await driveOperatorCommand(appname, deployments, (id) => appsRuntimeState.requestRestart(id));
}

/**
 * To stop all non Flux running apps. Executes continuously at regular intervals.
 */
async function stopAllNonFluxRunningApps() {
  try {
    log.info('Running non Flux apps check...');
    let apps = await dockerService.dockerListContainers(false);
    apps = apps.filter((app) => app.Names[0].slice(1, 5) !== 'flux');
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
  appStart,
  appStop,
  appRestart,
  appKill,
  appPause,
  appUnpause,
  requestAppRestart,
  stopAllNonFluxRunningApps,
  createFluxNetworkAPI,
};
