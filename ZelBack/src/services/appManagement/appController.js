'use strict';

const serviceHelper = require('../serviceHelper');
// Removed verificationHelper to avoid circular dependency - will use dynamic require where needed
const messageHelper = require('../messageHelper');
const dockerService = require('../dockerService');
const appsRuntimeState = require('./appsRuntimeState');
const reconcilerQueue = require('../appMonitoring/reconcilerQueue');
const appReconciler = require('../appMonitoring/appReconciler');
const log = require('../../lib/log');
const { Privilege, authOf } = require('../utils/privileges');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const globalCommand = require('./globalCommand');
const mastershipGrantGate = require('../appLifecycle/mastershipGrantGate');
const fluxEventBus = require('../utils/fluxEventBus');
const { getSpecBackend } = require('../utils/specLibs');

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
async function driveOperatorCommand(ids, recordIntent, intent) {
  const { stopped, force = false, restartRequested = false } = intent;
  // Components come up in compose order and go down in the reverse of it, so a
  // dependency outlives what writes to it: the database stops after the server
  // it serves, not before it. Driving a stop forwards took the database down
  // first while the component writing to it was still running.
  //
  // Reversed on a COPY of the resolved ids. resolveRequestTargets builds that
  // array with flatMap so it is already fresh, but a caller reading `ids` after
  // this - which appStop and appKill both do, to probe them - must not find it
  // reordered underneath.
  const order = stopped ? [...ids].reverse() : ids;
  let allActuated = true;
  // eslint-disable-next-line no-restricted-syntax
  for (const id of order) {
    // Written through the reconciler's per-key slot rather than straight to the
    // store. A pass reads the run-state and acts on that answer once docker has
    // replied, so a write landing in between is not seen: the pass starts a
    // container the operator has just stopped, and the next pass stops it again.
    // applyIntent waits out any pass deciding for this id, holds the key while
    // the write lands, and enqueues on release - so the two cannot interleave.
    //
    // awaitPass holds each component's pass open before the next id is touched,
    // which is what makes the order above the order the containers move in
    // rather than merely the order the intents were written.
    // eslint-disable-next-line no-await-in-loop
    const actuated = await reconcilerQueue.applyIntent(id, async () => {
      await recordIntent(id);
      // The operator's intent is the one desired-state write in this flow that
      // announced nothing, so nothing could be ordered against it - and the
      // failure that hides is an actuation on the PREVIOUS intent arriving
      // after this one landed. Published from inside the slot: after the write,
      // so it can never claim an intent that did not persist, and before the
      // pass, which is what makes it the ordering point.
      //
      // The identifier is passed through as it arrives - already the bare form
      // the reconciler publishes reconciler:actuated under, which is the only
      // thing this event is for. It must NOT go through getBaseAppName: that is
      // the inverse of the flux- prefix and would eat four characters of a
      // component genuinely named `fluxproxy`.
      fluxEventBus.publish('app:operatorIntent', {
        identifier: id, stopped, force, restartRequested,
      });
    }, { awaitPass: true });
    if (!actuated) allActuated = false;
  }
  return allActuated;
}

/**
 * Whether the containers have actually stopped, once the reconciler has had its
 * pass.
 *
 * A pass that completed is not a container that stopped - docker being
 * unreachable completes by deferring. Probed rather than inferred, so a stop
 * that has not happened yet is never reported as one that has.
 *
 * @param {string[]} ids Component identifiers.
 * @returns {Promise<{settled: boolean, reason: string|null}>}
 */
async function containersReachedStopped(ids) {
  // eslint-disable-next-line no-restricted-syntax
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const actual = await appReconciler.observedContainerState(id);
    if (!actual.reachable) return { settled: false, reason: 'docker is not reachable' };
    // Nothing there is not the same as stopped: observedContainerState distinguishes the
    // two, and reading the pair as one answers "stopped" for something that was
    // never running.
    if (!actual.exists) return { settled: false, reason: 'it is not installed on this node' };
    if (actual.running) return { settled: false, reason: 'the reconciler has not stopped it yet' };
  }
  return { settled: true, reason: null };
}

// Why the reconciler is not running a component, in the operator's terms. The
// election and dependency cases are not failures: a synced component runs on the
// node the election made the writer, so "not started" is the correct outcome
// elsewhere and saying so is more use than a generic wait.
//
// Every reason desiredRunState can return for a component that is NOT running is
// named. Development's map carried five and fell back to "has not started it
// yet" for the rest, which is a WRONG answer here rather than a vague one - this
// tree's reconciler answers condemned, operationHold, shutdownPipeline,
// boundToDependencyDown and awaitingAppDependency too, and each of those is a
// settled state that saying "not yet" misdescribes. It also carried `policy`,
// which nothing on this tree produces.
const NOT_RUNNING_REASONS = {
  awaitingController: 'waiting for the election',
  controllerDesired: 'the election has not made this node the writer',
  awaitingAppDependency: 'waiting for an app it depends on',
  boundToDependencyDown: 'the component it is bound to is not running',
  condemned: 'it is being removed from this node',
  operationHold: 'an operation on this app is holding it',
  operatorStopped: 'the operator stop lock is still set',
  shutdownPipeline: 'this node is going down',
  invalidSpec: 'its specification cannot be actuated',
  notInstalled: 'it is not installed on this node',
};

/**
 * Whether the containers are actually running, once the reconciler has had its
 * pass. The mirror of containersReachedStopped, with one asymmetry: a container
 * that is not running may be one the reconciler is RIGHT to leave alone, so the
 * reason comes from the reconciler's own verdict rather than from the absence.
 *
 * @param {string[]} ids Component identifiers.
 * @returns {Promise<{settled: boolean, reason: string|null}>}
 */
async function containersReachedRunning(ids) {
  // eslint-disable-next-line no-restricted-syntax
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const actual = await appReconciler.observedContainerState(id);
    if (!actual.reachable) return { settled: false, reason: 'docker is not reachable' };
    // eslint-disable-next-line no-continue
    if (actual.running) continue;
    let verdict;
    try {
      // eslint-disable-next-line no-await-in-loop
      verdict = await appReconciler.desiredRunState(id);
    } catch (err) {
      return { settled: false, reason: `its state could not be read: ${err.message}` };
    }
    return {
      settled: false,
      reason: NOT_RUNNING_REASONS[verdict.reason] || 'the reconciler has not started it yet',
    };
  }
  return { settled: true, reason: null };
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
    const authorized = await verificationHelper.verifyPrivilege(Privilege.APP_OWNER_OR_FLUX_TEAM, authOf(req), { appName: mainAppName });
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
    //
    // A decider verdict recorded BEFORE the stop is withdrawn with the lock: an
    // operator stop is an interregnum, and the verdict's safety checks (sync
    // position, sibling state, location order) were made against a world that
    // kept moving while the component sat stopped. Absent-verdict is the state
    // a FluxOS restart already produces — running containers are left as-is,
    // stopped decider-owned ones wait for their decider to rule again.
    const actuated = await driveOperatorCommand(ids, async (id) => {
      await appsRuntimeState.setOperatorStopped(id, false);
      appReconciler.clearControllerDesired(id);
    }, { stopped: false });

    // Accepted, not applied. The intent is durable and the reconciler will
    // converge, so an error here would be false - but so is reporting a start
    // that has not happened, which is what answering unconditionally did.
    const outcome = actuated
      ? await containersReachedRunning(ids)
      : { settled: false, reason: 'no reconcile has run yet' };
    if (!outcome.settled) {
      const pending = messageHelper.createDataMessage(`${appRes.replace(/ started$/, '')} will be started: ${outcome.reason}`);
      return res ? res.json(pending) : pending;
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
    const authorized = await verificationHelper.verifyPrivilege(Privilege.APP_OWNER_OR_FLUX_TEAM, authOf(req), { appName: mainAppName });
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
    const actuated = await driveOperatorCommand(
      ids, (id) => appsRuntimeState.setOperatorStopped(id, true), { stopped: true },
    );

    const outcome = actuated
      ? await containersReachedStopped(ids)
      : { settled: false, reason: 'no reconcile has run yet' };
    if (!outcome.settled) {
      const pending = messageHelper.createDataMessage(`${appRes.replace(/ stopped$/, '')} will be stopped: ${outcome.reason}`);
      return res ? res.json(pending) : pending;
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

  // A yield IS a stop, so it goes down in the reverse of the order it came up,
  // exactly like appstop. THE ORDER AGAINST THE RELEASE IS SEPARATE and stated
  // above: stop first, then release.
  await driveOperatorCommand(ids, (id) => appsRuntimeState.setOperatorStopped(id, true), { stopped: true });
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
    const authorized = await verificationHelper.verifyPrivilege(Privilege.APP_OWNER_OR_FLUX_TEAM, authOf(req), { appName: mainAppName });
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
    const authorized = await verificationHelper.verifyPrivilege(Privilege.APP_OWNER_OR_FLUX_TEAM, authOf(req), { appName: mainAppName });
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
    // The pre-stop decider verdict is withdrawn for the same reason as appStart:
    // deciders re-assert live verdicts within a pass, stale ones must not stand.
    const actuated = await driveOperatorCommand(ids, async (id) => {
      await appsRuntimeState.setOperatorStopped(id, false);
      appReconciler.clearControllerDesired(id);
      await appsRuntimeState.requestRestart(id);
    }, { stopped: false, restartRequested: true });

    const outcome = actuated
      ? await containersReachedRunning(ids)
      : { settled: false, reason: 'no reconcile has run yet' };
    if (!outcome.settled) {
      const pending = messageHelper.createDataMessage(`${appRes.replace(/ restarted$/, '')} will be restarted: ${outcome.reason}`);
      return res ? res.json(pending) : pending;
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
    const authorized = await verificationHelper.verifyPrivilege(Privilege.APP_OWNER_OR_FLUX_TEAM, authOf(req), { appName: mainAppName });
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
    const actuated = await driveOperatorCommand(
      ids,
      (id) => appsRuntimeState.setOperatorStopped(id, true, { force: true }),
      { stopped: true, force: true },
    );

    const outcome = actuated
      ? await containersReachedStopped(ids)
      : { settled: false, reason: 'no reconcile has run yet' };
    if (!outcome.settled) {
      const pending = messageHelper.createDataMessage(`${appRes.replace(/ killed$/, '')} will be killed: ${outcome.reason}`);
      return res ? res.json(pending) : pending;
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
 * Pause and unpause were removed, and the routes answer 410 rather than 404 so a
 * caller learns WHY instead of thinking it mistyped the path.
 *
 * The reason is docker's: it reports a paused container as running. The
 * reconciler and the load balancer both read that as healthy and keep routing
 * to it, while nothing in FluxOS can see that it is frozen - so a pause looks
 * like a working app that answers nothing. On this tree the reconciler is the
 * SOLE starter and owns container state outright, which makes an out-of-band
 * freeze it cannot observe worse, not better.
 *
 * It answers an ERROR rather than a success, deliberately: a caller must not be
 * told the container stopped when it has not. appstop is the supported verb.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Response message
 */
async function deprecatedPauseResponse(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;

    if (appname) {
      // Validated before anything is done with it. Express's default extended
      // query parser turns ?appname=a&appname=b into an ARRAY and ?appname[x]=1
      // into an object, neither of which has .split - and this runs ahead of
      // verifyPrivilege because the app name is what the privilege is scoped to,
      // so it is reachable unauthenticated from the open internet.
      if (typeof appname !== 'string') {
        throw new Error('Invalid Flux App name specified');
      }
      const mainAppName = deploymentProvider.appNameFromRequest(appname);
      // Use dynamic require to avoid circular dependency
      // eslint-disable-next-line global-require
      const verificationHelper = require('../verificationHelper');
      const authorized = await verificationHelper.verifyPrivilege(
        Privilege.APP_OWNER_OR_FLUX_TEAM, authOf(req), { appName: mainAppName },
      );
      if (!authorized) {
        const errMessage = messageHelper.errUnauthorizedMessage();
        return res ? res.json(errMessage) : errMessage;
      }
    }

    const errorResponse = messageHelper.createErrorMessage(
      'Pausing applications is no longer supported. Use appstop to stop an application.',
      'Deprecated',
      410,
    );
    return res ? res.json(errorResponse) : errorResponse;
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
 * Pause an application - deprecated, see deprecatedPauseResponse.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Response message
 */
async function appPause(req, res) {
  return deprecatedPauseResponse(req, res);
}

/**
 * Unpause an application - deprecated, see deprecatedPauseResponse.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Response message
 */
async function appUnpause(req, res) {
  return deprecatedPauseResponse(req, res);
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
  // Not a stop: a repair-restart leaves the operator lock alone and brings the
  // components back in startup order.
  await driveOperatorCommand(ids, (id) => appsRuntimeState.requestRestart(id), { stopped: false, restartRequested: true });
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
    const { LABEL_KEYS } = await getSpecBackend();
    let apps = await dockerService.dockerListContainers(false);
    apps = apps.filter(
      (app) => !dockerService.isFluxOwnedContainer({ labels: app.Labels, name: app.Names?.[0] }, LABEL_KEYS),
    );
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
    const authorized = await verificationHelper.verifyPrivilege(Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));
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
