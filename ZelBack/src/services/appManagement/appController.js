'use strict';

const serviceHelper = require('../serviceHelper');
// Removed verificationHelper to avoid circular dependency - will use dynamic require where needed
const messageHelper = require('../messageHelper');
const dockerService = require('../dockerService');
const appsRuntimeState = require('./appsRuntimeState');
const reconcilerQueue = require('../appMonitoring/reconcilerQueue');
const log = require('../../lib/log');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const globalCommand = require('./globalCommand');
const mastershipGrantGate = require('../appLifecycle/mastershipGrantGate');

/**
 * Start an application
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @returns {object} Response message
 */
/**
 * Apply an operator run-state command to the target components THROUGH the
 * reconciler (the sole actuator): record the durable intent, then enqueue so the
 * reconciler converges the container to it. Intent is recorded BEFORE the enqueue
 * so a crash in between still leaves the reconciler converging to the operator's
 * recorded wish, never the opposite. The reconciler honours election/dependency
 * gates itself, so an operator start of a non-elected activeStandby component is
 * correctly held, not force-started.
 *
 * @param {string[]} ids component identifiers, resolved by the caller
 * @param {(id: string) => Promise<void>} recordIntent records the durable intent for one component
 * @returns {Promise<void>}
 */
async function driveOperatorCommand(ids, recordIntent) {
  // eslint-disable-next-line no-restricted-syntax
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    await recordIntent(id);
    reconcilerQueue.enqueueComponent(id);
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

    const mainAppName = deploymentProvider.appNameFromRequest(appname);

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
    let appRes;
    const { instantiated, ids } = await deploymentProvider.resolveRequestTargets(appname, { replica });
    if (isComponent) {
      appRes = `Component ${appname} started`;
    } else {
      appRes = replica != null
        ? `Replica ${replica} of ${instantiated.name} started`
        : `Application ${instantiated.name} started`;
    }
    // clear the operator stop lock; the reconciler then (re)starts each component,
    // honouring its own election/dependency gates (a non-elected activeStandby
    // component is held at awaitingController, never force-started).
    await driveOperatorCommand(ids, (id) => appsRuntimeState.setOperatorStopped(id, false));

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

    const mainAppName = deploymentProvider.appNameFromRequest(appname);

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
    let appRes;
    const { instantiated, ids } = await deploymentProvider.resolveRequestTargets(appname, { replica });
    if (isComponent) {
      appRes = `Component ${appname} stopped`;
    } else {
      appRes = replica != null
        ? `Replica ${replica} of ${instantiated.name} stopped`
        : `Application ${instantiated.name} stopped`;
    }
    // operator stop persists (the reconciler will not restart a stopped app); the
    // reconciler does the actual stop + stops monitoring on its stop branch.
    await driveOperatorCommand(ids, (id) => appsRuntimeState.setOperatorStopped(id, true));

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
 * Stop, yielding mastership: the operator's failover verb. `appstop` keeps
 * the grant (maintenance — no failover behind the operator's back); this
 * applies the same durable operator stop and then voluntarily releases the
 * grant, so a standby is seated with no lock-delay. THE ORDER IS
 * LOAD-BEARING, and the first fleet run proved it: release-then-lock leaves
 * a window where this node's own gate sees a running component with no
 * holder and re-acquires the freshly released term — a released grant has
 * no lock-delay for ANYONE, and the ex-master is fastest to its own
 * registers (measured: the yielded master re-held within one pass and the
 * standbys rested against it forever). Lock-then-release is race-free: a
 * pursuit in flight at lock time still sees the held key, and the gate is
 * unconsulted afterwards. Grants are app-scoped, so a component target
 * yields the app's mastership and stops the named component. On a
 * non-holder the yield is a no-op and the stop still applies — which keeps
 * the global fan-out idempotent: every instance stops, only the master
 * releases.
 *
 * @param {string} appname app or component name
 * @param {{replica?: string|null}} [options]
 * @returns {Promise<{name: string, held: boolean}>}
 */
async function appYield(appname, { replica = null } = {}) {
  if (!appname) {
    throw new Error('No Flux App specified');
  }
  const mainAppName = deploymentProvider.appNameFromRequest(appname);
  const { instantiated, ids } = await deploymentProvider.resolveRequestTargets(appname, { replica });

  await driveOperatorCommand(ids, (id) => appsRuntimeState.setOperatorStopped(id, true));
  const { held } = await mastershipGrantGate.yieldMastership(mainAppName);

  return { name: instantiated.name, held };
}

/**
 * Express wrapper for appYield: parse, authorize, fan out or run locally,
 * respond. The express objects never leave this function.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Response message
 */
async function appYieldApi(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;
    let { global } = req.params;
    global = global || req.query.global || false;
    global = serviceHelper.ensureBoolean(global);

    if (!appname) {
      throw new Error('No Flux App specified');
    }

    const mainAppName = deploymentProvider.appNameFromRequest(appname);

    // eslint-disable-next-line global-require
    const verificationHelper = require('../verificationHelper');
    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, mainAppName);
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      return res ? res.json(errMessage) : errMessage;
    }

    const replica = req.query.replica || null;

    if (global) {
      globalCommand.executeAppGlobalCommand(appname, 'appyield', req.headers.zelidauth, undefined, undefined, replica); // do not wait
      const appResponse = messageHelper.createSuccessMessage(`${appname} queried for global yield`);
      return res ? res.json(appResponse) : appResponse;
    }

    const { name, held } = await appYield(appname, { replica });
    const appResponse = messageHelper.createDataMessage(
      held ? `${name} yielded mastership and stopped` : `${name} stopped (held no mastership)`,
    );
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

    const mainAppName = deploymentProvider.appNameFromRequest(appname);

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
    let appRes;
    const { instantiated, ids } = await deploymentProvider.resolveRequestTargets(appname, { replica });
    if (isComponent) {
      appRes = `Component ${appname} restarted`;
    } else {
      appRes = replica != null
        ? `Replica ${replica} of ${instantiated.name} restarted`
        : `Application ${instantiated.name} restarted`;
    }
    // user-initiated restart = "make it run now": clear the operator stop lock AND
    // bump the durable restart generation, so the reconciler restarts a running
    // container (or starts a stopped one) and honours its election/dependency gates.
    await driveOperatorCommand(ids, async (id) => {
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

    const mainAppName = deploymentProvider.appNameFromRequest(appname);

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
    let appRes;
    const { instantiated, ids } = await deploymentProvider.resolveRequestTargets(appname, { replica });
    if (isComponent) {
      appRes = `Component ${appname} killed`;
    } else {
      appRes = replica != null
        ? `Replica ${replica} of ${instantiated.name} killed`
        : `Application ${instantiated.name} killed`;
    }
    // operator kill = force-stop now: durable operatorStopped carrying the force
    // mode (so a crash never downgrades it to the app's graceful window); the
    // reconciler's desired-stopped branch honours force with appDockerKill.
    await driveOperatorCommand(ids, (id) => appsRuntimeState.setOperatorStopped(id, true, { force: true }));

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

    const mainAppName = deploymentProvider.appNameFromRequest(appname);

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
      // the request names a component of an app; its container identifier is built
      // from the app's stored identity, so it is resolved rather than assumed
      const identifier = await deploymentProvider.resolveRequestContainer(appname, { replica });
      appRes = await dockerService.appDockerPause(identifier);
    } else {
      const resolved = await deploymentProvider.resolveRequestTargets(appname, { replica });
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

    const mainAppName = deploymentProvider.appNameFromRequest(appname);

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
      // the request names a component of an app; its container identifier is built
      // from the app's stored identity, so it is resolved rather than assumed
      const identifier = await deploymentProvider.resolveRequestContainer(appname, { replica });
      appRes = await dockerService.appDockerUnpause(identifier);
    } else {
      const resolved = await deploymentProvider.resolveRequestTargets(appname, { replica });
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
  const { ids } = await deploymentProvider.resolveRequestTargets(appname);
  await driveOperatorCommand(ids, (id) => appsRuntimeState.requestRestart(id));
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
  appYield,
  appYieldApi,
  appRestart,
  appKill,
  appPause,
  appUnpause,
  requestAppRestart,
  stopAllNonFluxRunningApps,
  createFluxNetworkAPI,
};
