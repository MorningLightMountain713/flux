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
const { compareInstanceSeniority } = require('../utils/instanceOrdering');
const { socketAddressesMatch } = require('../utils/socketAddressUtils');

// Two reasons, one answer. SURPLUS: the app runs on more nodes than it needs and
// this node holds the junior instance. EVACUATION: the node is shedding what it
// holds because it is no longer fit to serve, and this app's turn has come.
// NONE: neither applies.
//
// Both are decided HERE, in one place, and both then go through the same safety
// gate. The count-based trim that used to live in specReconciler is this
// function's SURPLUS branch now - a count has never been able to tell a
// redundant copy from the last one holding the data, and that trim asked
// nothing else.
const GiveUpReason = Object.freeze({ SURPLUS: 'SURPLUS', EVACUATION: 'EVACUATION', NONE: 'NONE' });

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
 * The identifier of an app's `g:` component, or null when it has none. The one
 * component that runs on a single node at a time and writes to the volume.
 *
 * Asked of the spec class through appEvacuationSafety, which already derives
 * exactly this and answers for v8 and v9 alike.
 *
 * @param {object} spec a spec class
 * @returns {string|null}
 */
function writerIdentifier(spec) {
  const g = appEvacuationSafety.syncedComponents(spec).find((c) => c.syncMode === 'g');
  return g ? g.identifier : null;
}

/**
 * Whether this node holds a SURPLUS copy of an app, and should trim it.
 *
 * Only the reason is decided here. Whether it is SAFE to act on is
 * appEvacuationSafety's question, and both must agree - a count has never been
 * able to tell a redundant copy from the last one that holds the data.
 *
 * Called by specReconciler, which owns the trim as a rung of its convergence.
 * The rule is development's; the cadence and the place are v9's.
 *
 * @param {{name: string, spec: object, instances: number}} app
 * @param {object[]} locations instance locations for the app
 * @param {string} localSocketAddr
 * @param {{runningLocally: Function, liveness: object}} deps
 * @returns {Promise<{giveUp: boolean, code: string|null, detail: string}>}
 */
async function surplusVerdict(app, locations, localSocketAddr, deps) {
  const { runningLocally, liveness } = deps;
  const minInstances = app.instances || config.fluxapps.minimumInstances;
  if (locations.length <= minInstances) {
    return { giveUp: false, code: null, detail: '' };
  }

  // Junior end first: the newest instance stands aside, ties broken by the
  // shared ordering so every node names the same surplus.
  const ordered = [...locations].sort((a, b) => compareInstanceSeniority(b, a));
  const index = ordered.findIndex((x) => socketAddressesMatch(x.ip, localSocketAddr));
  const writer = writerIdentifier(app.spec);
  const detail = `running on ${locations.length} instances (max: ${minInstances}) and this node is the newest`;

  // "THE NEWEST STANDS ASIDE" IS A STAND-IN FOR "THE LEAST VALUABLE COPY STANDS
  // ASIDE", and when the newest copy is the one WRITING the stand-in is
  // backwards - that is the most valuable copy on the network, not the least.
  // The election may seat the writer anywhere in the order: it skips instances
  // whose data has not finished syncing, and the designated-leader branch leaves
  // the order outright. So the two rules can land on the same node.
  //
  // The node stays and the next copy trims instead. What it does NOT do is stop
  // the writer to make the ordering come true: an app is over-served, not down,
  // and interrupting the one node serving it to tidy up the count is a worse
  // outcome than the count being wrong for another pass.
  if (index === 0) {
    const runsWriter = Boolean(writer) && await runningLocally(writer);
    if (!runsWriter) return { giveUp: true, code: 'NEWEST', detail };
    return {
      giveUp: false,
      code: 'NEWEST_HOLDS_WRITER',
      detail: `this node is the newest but holds ${writer}; the next copy trims instead`,
    };
  }

  // The next copy, and it steps in ONLY on a positive confirmation that the
  // newest is running the writer. Every node ranks the same shared order, but
  // "who is writing" is each node's own reading and FDM's registration lags it
  // by ~110s - so a second node acting on a guess is how two copies leave at
  // once, which is the failure the shared order exists to prevent.
  //
  // Silence, a timeout, a refusal, "not running": all mean this node does
  // nothing. The rule can only ever fail towards no trim, never towards two.
  if (index === 1 && writer && liveness) {
    // eslint-disable-next-line global-require
    const appOperations = require('./appOperations');
    const newestState = await appOperations.peerComponentState({
      appId: dockerService.getAppIdentifier(writer),
      identifier: writer,
      appName: app.name,
      peerSocketAddr: ordered[0].ip,
      label: 'the newest copy',
      liveness,
    });
    if (newestState === appOperations.PeerComponent.RUNNING) {
      return {
        giveUp: true,
        code: 'NEWEST_CONFIRMED_WRITER',
        detail: detail.replace('this node is the newest', `the newest copy holds ${writer}, so this node trims`),
      };
    }
    // DECLINING IS A DECISION, and it is reported as one. Falling through
    // silently would make "there is a surplus and I will not act on a guess"
    // read exactly like "there is nothing here to trim" - and that difference is
    // the single observation that catches this rule failing open.
    return {
      giveUp: false,
      code: 'WRITER_UNCONFIRMED',
      detail: `${detail} but the newest copy could not be confirmed to hold ${writer} (${newestState}); nothing is trimmed`,
    };
  }

  return { giveUp: false, code: null, detail: '' };
}

/**
 * Whether this node is shedding what it holds, and this app's turn has come.
 * The pacing half of the drain; says nothing about safety.
 *
 * @param {{name: string, instances: number}} app
 * @param {object[]} locations
 * @param {string} localSocketAddr
 * @returns {{giveUp: boolean, code: string|null, detail: string}}
 */
function evacuationVerdict(app, locations, localSocketAddr) {
  if (!residentialNodeDosService.isEvacuating()) {
    return { giveUp: false, code: null, detail: '' };
  }
  const minInstances = app.instances || config.fluxapps.minimumInstances;
  const verdict = residentialNodeDosService.mayEvacuateApp(
    app.name, locations, localSocketAddr, minInstances,
  );
  if (verdict.ok) {
    return {
      giveUp: true, code: verdict.code, detail: 'node is not fit to serve and is handing its apps back',
    };
  }
  return { giveUp: false, code: verdict.code, detail: verdict.reason };
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

  // One peer view for the pass. A peer's liveness must not be carried into the
  // next one: held over, it reports a recovered holder as dead or a dead one as
  // serving, which is the judgement this path exists to make.
  let considered = 0;
  for (const appName of names) {
    // eslint-disable-next-line no-await-in-loop
    const locations = await registryManager.appLocation(appName);
    // eslint-disable-next-line no-await-in-loop
    const installed = await appsRepository.getInstalledApp(appName);
    if (!installed) continue;

    const decision = {
      reason: GiveUpReason.EVACUATION,
      ...evacuationVerdict(
        { name: appName, instances: installed.instances }, locations || [], localSocketAddr,
      ),
    };
    considered += 1;
    // Emitted once per app per pass, whichever way it went, so a reader can tell
    // "the pass declined" from "the pass never ran" - which the logs cannot,
    // since a pass with nothing to give up says nothing at all.
    fluxEventBus.publish('giveUp:considered', {
      appName,
      giveUp: decision.giveUp,
      reason: decision.reason,
      code: decision.code,
      detail: decision.detail,
    });
    if (!decision.giveUp) continue;

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
      reason: decision.reason,
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
          appName, identifiers: safety.standDown, reason: decision.reason,
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

    log.warn(`REMOVAL REASON: ${decision.reason} - ${appName} (${decision.detail}; ${safety.reason})`);
    // eslint-disable-next-line no-await-in-loop
    const result = await appUninstaller.uninstallApplication(appName, { broadcastRemoval: true });
    if (result.status !== appUninstaller.UninstallStatus.REMOVED) {
      log.warn(`giveUp - ${appName} was not removed (${result.status}): ${result.reason ?? 'no reason given'}`);
      continue;
    }
    // Paces the NEXT departure, and only an EVACUATION departure: the pacing is
    // the residential drain's, and a surplus trim is not part of it.
    if (decision.reason === GiveUpReason.EVACUATION) residentialNodeDosService.noteEvacuated(appName);
    return { considered, gaveUp: appName };
  }

  return { considered, gaveUp: null };
}

module.exports = {
  checkAndGiveUpAnApp, surplusVerdict, evacuationVerdict, writerIdentifier,
  isComponentRunningLocally, GiveUpReason,
};
