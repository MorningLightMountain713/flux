'use strict';

// The give-up-an-app pass: a node that must stop hosting hands its apps back,
// one at a time.
//
// Every part of this already existed and nothing ran them. residentialNodeDos
// decides WHEN a node should evacuate and paces which app's turn it is;
// appEvacuationSafety decides whether a given app may go; appUninstaller does the
// removing. serviceManager's own comment said "the single give-up-an-app pass in
// appOperations does that" - and there was no such pass, so a residential node
// logged "evacuation begins, N apps to hand back" and handed back none, forever.
//
// It lives in its own module rather than in appOperations, which is where
// development kept it, for two reasons: it has its own cadence and its own
// entry point, and the three events below are the only description anything
// outside gets of what it decided - one file makes their single source obvious.
//
// The pass is deliberately slow and refuses easily. Nothing here has a deadline,
// and the cost of waiting is a delay while the cost of being wrong is an
// unrecoverable rm -rf.

const config = require('config');
const log = require('../../lib/log');
const fluxEventBus = require('../utils/fluxEventBus');
const operationRegistry = require('../utils/operationRegistry');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const registryManager = require('../appDatabase/registryManager');
const appsRepository = require('../appDatabase/appsRepository');
const residentialNodeDosService = require('../residentialNodeDosService');
const appEvacuationSafety = require('./appEvacuationSafety');
const appUninstaller = require('./appUninstaller');
const appReconciler = require('../appMonitoring/appReconciler');
const dockerService = require('../dockerService');
const syncthingFolderStateMachine = require('../appMonitoring/syncthingFolderStateMachine');

// Reasons a node gives an app up. SURPLUS is NOT decided here - specReconciler
// owns the count-based trim as one rung of its convergence, and a second path
// deciding the same thing on a different cadence is how two nodes drop the same
// copy. Named so a consumer can tell this pass's decisions apart from that one's.
const GiveUpReason = Object.freeze({ EVACUATION: 'EVACUATION' });

/**
 * Whether this node is running a component right now, by container identifier.
 * A local fact, needing neither FDM nor the election.
 *
 * @param {string} identifier bare component identifier
 * @returns {Promise<boolean>}
 */
async function isComponentRunningLocally(identifier) {
  const containers = await dockerService.dockerListContainers(false);
  const name = dockerService.getAppIdentifier(identifier);
  return (containers || []).some(
    (container) => (container.Names || []).some((n) => n.replace(/^\//, '') === name),
  );
}

/**
 * One pass: consider each installed app for hand-back, and act on at most one.
 *
 * At most one, because removing takes the app to N-1 and every other draining
 * holder then sees it short and waits while the spawner fills the gap. Two
 * departures in a pass would take a second copy off an app that is already
 * mid-replacement.
 *
 * @param {object} [deps] injected for testing
 * @returns {Promise<{considered: number, gaveUp: string|null}>}
 */
async function checkAndGiveUpAnApp(deps = {}) {
  const {
    installedAppsFn,
    isElectedPrimary,
    runningLocally = isComponentRunningLocally,
  } = deps;

  // A folder-set-changing operation anywhere on the node means the picture this
  // pass reads is mid-change. Not per-app: an install elsewhere moves the same
  // syncthing configuration these decisions rest on.
  if (operationRegistry.anyHeldOfType('install', 'remove', 'redeploy', 'rebuild', 'reconcile')) {
    return { considered: 0, gaveUp: null };
  }
  if (!residentialNodeDosService.isEvacuating()) {
    return { considered: 0, gaveUp: null };
  }

  const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
  if (!localSocketAddr) {
    log.warn('giveUp - local socket address unknown, holding this pass');
    return { considered: 0, gaveUp: null };
  }

  const names = await residentialNodeDosService.listInstalledApps(installedAppsFn);
  if (!names || !names.length) return { considered: 0, gaveUp: null };

  let considered = 0;
  for (const appName of names) {
    // eslint-disable-next-line no-await-in-loop
    const locations = await registryManager.appLocation(appName);
    // eslint-disable-next-line no-await-in-loop
    const installed = await appsRepository.getInstalledApp(appName);
    const minInstances = installed?.instances ?? config.fluxapps.minimumInstances;

    // The PACING half: is it this app's turn, and has this node watched it whole
    // for long enough. Says nothing about safety.
    const ticket = residentialNodeDosService.mayEvacuateApp(
      appName, locations || [], localSocketAddr, minInstances,
    );
    considered += 1;
    // Emitted once per app per pass, whichever way it went, so a reader can tell
    // "the pass declined" from "the pass never ran" - which the logs cannot,
    // since a pass with nothing to give up says nothing at all.
    fluxEventBus.publish('giveUp:considered', {
      appName,
      giveUp: ticket.ok,
      reason: GiveUpReason.EVACUATION,
      code: ticket.code,
      detail: ticket.reason,
    });
    if (!ticket.ok) continue;

    // The SAFETY half, asked separately and independently: both must agree.
    // eslint-disable-next-line no-await-in-loop
    const safety = await appEvacuationSafety.canSafelyRemoveApp(appName, {
      appLocation: registryManager.appLocation,
      getApplicationGlobalSpecifications: async (name) => {
        const row = await appsRepository.getGlobalAppInfo(name);
        // The CLASS, not the stored document: syncedComponents reads a v9 spec
        // through it, and a document answers the v8 spelling only.
        return row ? row.spec : null;
      },
      findSyncedPeer: syncthingFolderStateMachine.findSyncedPeer,
      isElectedPrimary,
      isComponentRunningLocally: runningLocally,
    });
    fluxEventBus.publish('giveUp:safety', {
      appName,
      reason: GiveUpReason.EVACUATION,
      safe: safety.safe,
      code: safety.code,
      detail: safety.reason,
    });

    if (!safety.safe) {
      // Not a refusal to leave - an instruction to stop writing first. The
      // components are told to stand down and the app is asked again next pass,
      // by which time the election has given the role to a peer and the safety
      // check means something stronger.
      if (safety.code === 'STAND_DOWN_REQUIRED' && safety.standDown?.length) {
        fluxEventBus.publish('giveUp:standDown', {
          appName, identifiers: safety.standDown, reason: GiveUpReason.EVACUATION,
        });
        for (const identifier of safety.standDown) {
          // The CONTROLLER, not docker: a container stopped behind the
          // controller's back is restarted by the next reconcile pass, which is
          // the standby coming up against the election's intent.
          appReconciler.setControllerDesired(identifier, 'stopped', 'giveUp:standDown');
        }
        log.info(`giveUp - ${appName}: standing down ${safety.standDown.join(', ')} before handing it back`);
      } else {
        log.info(`giveUp - ${appName} not handed back yet: ${safety.reason}`);
      }
      continue;
    }

    log.warn(`REMOVAL REASON: evacuation - ${appName} (${safety.reason})`);
    // eslint-disable-next-line no-await-in-loop
    const result = await appUninstaller.uninstallApplication(appName, { broadcastRemoval: true });
    if (result.status !== appUninstaller.UninstallStatus.REMOVED) {
      log.warn(`giveUp - ${appName} was not removed (${result.status}): ${result.reason ?? 'no reason given'}`);
      continue;
    }
    // Paces the NEXT departure. Recorded only on a removal that happened.
    residentialNodeDosService.noteEvacuated(appName);
    return { considered, gaveUp: appName };
  }

  return { considered, gaveUp: null };
}

module.exports = { checkAndGiveUpAnApp, isComponentRunningLocally, GiveUpReason };
