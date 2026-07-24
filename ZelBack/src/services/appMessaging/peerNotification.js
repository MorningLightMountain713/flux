const os = require('os');
const nodeConfirmationService = require('../nodeConfirmationService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const geolocationService = require('../geolocationService');
const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
const messageStore = require('./messageStore');
const log = require('../../lib/log');
const globalState = require('../utils/globalState');
const appsRepository = require('../appDatabase/appsRepository');
const appReconciler = require('../appMonitoring/appReconciler');
const { resolveInstantiatedSpec } = require('../utils/specCutover');

const fluxEventBus = require('../utils/fluxEventBus');
const { nodeSigner } = require('../utils/nodeSigner');
const { ANNOUNCE_INTERVAL_MS } = require('../utils/appConstants');


let broadcastTimer = null;
let broadcastInProgress = false;
let rebroadcastNeeded = false;
let overrunning = false;

// Whether this node announces at all, and the only thing that decides whether a
// cycle arms the next one. A cycle ends by scheduling its successor, so a stop
// that clears the pending timer alone is undone a moment later by the work it
// was trying to end - the announcement loop outlives every stop taken while it
// is running.
//
// Ours rather than an abort signal's: FluxController's `aborted` is reset the
// moment its lock frees, so which of the two resumes first decides whether the
// loop survives its own abort. Nothing resets this.
let broadcasting = false;

// Held for the whole of a cycle, so a stop can wait for the cycle in flight
// rather than returning while it is still running. A teardown that returns
// before the thing is torn down is the same lie as a stop that does not stop.
// A removal waits on it too, which is why it lives in globalState.
const cycleLock = globalState.announceCycle;

/**
 * Schedule the next announcement so that the PERIOD is fixed, rather than the
 * gap between one cycle ending and the next beginning.
 *
 * The cycle's own duration is subtracted, so the work does not sit inside the
 * thing it is timed against: a timer recreated after the cycle makes the real
 * period `interval + however long the cycle took`, and a node announcing every
 * 70s while its configuration says 30 keeps a row alive that expires at 63.
 *
 * Measured monotonically. A wall clock can step backwards over an NTP
 * correction, and a negative elapsed would push the next announcement away by
 * the size of the step.
 *
 * @param {bigint} startedAt process.hrtime.bigint() taken when the cycle began
 */
function scheduleNextBroadcast(startedAt) {
  if (broadcastTimer) clearTimeout(broadcastTimer);
  // Asked here rather than at the caller, because every path that ends a cycle
  // arrives here and a stop must be honoured by all of them.
  if (!broadcasting) {
    broadcastTimer = null;
    return;
  }

  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  // Said once on the transition and once when it clears, never per cycle. A
  // node whose cycle no longer fits its interval announces itself less often
  // than the row it keeps alive, and its presence on the network decays with
  // nothing anywhere saying so.
  if (elapsedMs > ANNOUNCE_INTERVAL_MS) {
    if (!overrunning) {
      overrunning = true;
      log.warn(`peerNotification - a broadcast cycle took ${Math.round(elapsedMs)}ms against a ${ANNOUNCE_INTERVAL_MS}ms interval; this node is announcing itself less often than the location row it refreshes`);
    }
  } else if (overrunning) {
    overrunning = false;
    log.info('peerNotification - broadcast cycles fit inside their interval again');
  }

  // Clamped at zero rather than scheduled into the past. A cycle that outran
  // its interval runs again immediately, which is the most the node can do.
  broadcastTimer = setTimeout(() => {
    checkAndNotifyPeersOfRunningApps();
  }, Math.max(0, ANNOUNCE_INTERVAL_MS - elapsedMs));
}

/**
 * Start announcing, and keep announcing.
 *
 * Idempotent: a second call while the loop is running is not a second loop.
 *
 * @returns {void}
 */
function startBroadcasting() {
  if (broadcasting) return;
  broadcasting = true;
  checkAndNotifyPeersOfRunningApps();
}

/**
 * Stop announcing, and return once the cycle in flight has finished.
 *
 * @returns {Promise<void>}
 */
async function stopBroadcasting() {
  broadcasting = false;
  if (broadcastTimer) {
    clearTimeout(broadcastTimer);
    broadcastTimer = null;
  }
  // The queued repeat goes with the stop. Left set, it is a cycle the next
  // start would run before the one it schedules for itself.
  rebroadcastNeeded = false;
  await cycleLock.waitReady();
}

function initialize() {
  nodeConfirmationService.onMessageCapabilityChange((capable) => {
    if (capable && broadcasting) {
      log.info('peerNotification - Message capability regained, triggering immediate broadcast');
      checkAndNotifyPeersOfRunningApps();
    }
  });
}

async function checkAndNotifyPeersOfRunningApps() {
  if (broadcastInProgress) {
    rebroadcastNeeded = true;
    log.info('Broadcast cycle already in progress, will rebroadcast when complete');
    return;
  }
  broadcastInProgress = true;
  // Taken before any work, so the schedule below subtracts the WHOLE cycle -
  // including the paths that give up early, which cost time too.
  const startedAt = process.hrtime.bigint();
  await cycleLock.enable();
  try {
    // Observation only. The lock above is what a caller waiting on a cycle in
    // flight actually waits for.
    fluxEventBus.publish('app:announcing', {});
    if (!nodeConfirmationService.canSendMessages()) {
      log.info('checkAndNotifyPeersOfRunningApps - Node cannot send messages, skipping broadcast');
      return;
    }

    // The snapshot waits for the reconciler's first pass over the apps held at
    // boot: a pass that cannot recreate a container uninstalls the app, and a
    // claim made before it would have to be taken back by a broadcast that is
    // best-effort. Resolves immediately in steady state; capped reconciler-side,
    // so a wedged reconcile cannot block the node's network presence.
    await appReconciler.waitForBootDrainSettled();

    const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
    if (!localSocketAddr) {
      throw new Error('Unable to detect Flux IP address');
    }

    const installedSpecs = await appsRepository.listInstalledApps();

    // Resolve each installed spec to its cleartext view for component/syncthing
    // introspection. Enterprise (encrypted) apps must be decrypted first — the
    // EncryptedSpecV8 wrapper has no componentNames()/hasSyncthing(). The node
    // installed these apps, so it can decrypt them. Skip + log any that fail to
    // resolve so one undecryptable app can't abort the whole broadcast cycle.
    const resolvedViews = new Map();
    // eslint-disable-next-line no-restricted-syntax
    for (const inst of installedSpecs) {
      // eslint-disable-next-line no-await-in-loop
      const view = await resolveInstantiatedSpec(inst);
      if (view) {
        resolvedViews.set(inst.name, view);
      } else {
        log.warn(`peerNotification - could not resolve spec for ${inst.name}; skipping from monitoring/broadcast this cycle`);
      }
    }

    // hourly resync trigger: let the reconciler bring any drifted containers
    // (crashed, orphaned, missed events) back to their desired state — a local
    // health concern; its result no longer gates what we broadcast.
    appReconciler.enqueueAll('hourly').catch((err) => log.error(`peerNotification - reconcile sweep failed: ${err.message}`));

    // Broadcast presence: every app installed on this node, irrespective of
    // container liveness. A fluxapprunning entry means "assigned here", not
    // "containers up" — a crashed container is recovered locally, not relocated,
    // and liveness is handled at the routing layer. Each entry's `state`
    // (active/draining/stopping) carries the LB lifecycle. Undecryptable specs
    // can't be introspected, so skip them this cycle.
    const applicationsToBroadcast = installedSpecs.filter((inst) => resolvedViews.has(inst.name));
    const apps = [];
    try {
      // eslint-disable-next-line no-restricted-syntax
      for (const application of applicationsToBroadcast) {
        const appName = application.name;
        // One entry per identity this node holds: a co-located app reports each
        // replica; loose and pre-qualification installs report the single untagged
        // entry. Read from the installed set, NOT from docker — this message states
        // what the node is assigned, and assignment does not change when a container
        // stops, dies or is rebuilt.
        // eslint-disable-next-line no-await-in-loop
        const replicas = await appsRepository.listInstalledIdentities(appName);
        const identities = replicas.length > 0 ? replicas : [null];
        // eslint-disable-next-line no-restricted-syntax
        for (const identity of identities) {
          // eslint-disable-next-line no-await-in-loop
          const result = await appsRepository.getAppLocation(appName, localSocketAddr, identity);
          let runningOnMyNodeSince = new Date().toISOString();
          if (result && result.runningSince) {
            runningOnMyNodeSince = result.runningSince;
          }
          apps.push({
            name: appName,
            hash: application.hash || '',
            runningSince: runningOnMyNodeSince,
            state: globalState.getAppShutdownPipelineState(appName) ?? 'active',
            ...(identity != null ? { replica: identity } : {}),
          });
        }
      }
      // An empty snapshot is NEVER broadcast: the receive side treats an empty
      // v2 message as "delete every appsLocations row for this IP" - and we
      // store our own message first, so it would erase our own presence. Every
      // legitimate correction has a targeted mechanism instead (fluxappremoved
      // on uninstall, sigterm/TTL row expiry for wiped or dead nodes).
      if (apps.length === 0) {
        return;
      }
      const appRunningMessage = {
        type: 'fluxapprunning',
        version: 2,
        apps,
        ip: localSocketAddr,
        broadcastedAt: Date.now(),
        osUptime: os.uptime(),
        staticIp: geolocationService.isStaticIP(),
      };
      // The announcement is one fact, recorded twice - the location table, and
      // the event log that peers sync from - and sent once. A node that cannot
      // sign as itself sends nothing a peer would accept, so it records nothing
      // either: its own view of where it runs stays the network's view. Asked
      // before the first write, for that reason.
      const signer = await nodeSigner();
      if (!signer) {
        log.warn('checkAndNotifyPeersOfRunningApps - this node cannot sign as itself; its running apps are not announced');
        return;
      }
      await messageStore.storeAppRunningMessage(appRunningMessage);
      const signed = await fluxCommunicationMessagesSender.broadcastMessageToAll(appRunningMessage);
      await messageStore.storeAppStateEvent(messageStore.APP_STATE_EVENT_TYPES.APPRUNNING, { signedBroadcast: signed });
      fluxEventBus.publish('app:running', { apps, ip: appRunningMessage.ip });
      log.info(`App Running Message broadcasted: ${apps.length} apps`);
    } catch (err) {
      log.error(err);
    }
    const { runningAppsCache } = globalState;
    runningAppsCache.clear();
    apps.forEach((app) => {
      runningAppsCache.add(app.name);
    });
    log.info(`Running Apps cache updated with ${runningAppsCache.size} apps`);
    log.info('Running Apps broadcasted');
  } catch (error) {
    log.error(error);
  } finally {
    broadcastInProgress = false;
    cycleLock.disable();
    if (rebroadcastNeeded) {
      rebroadcastNeeded = false;
      setImmediate(() => checkAndNotifyPeersOfRunningApps());
    } else {
      scheduleNextBroadcast(startedAt);
    }
  }
}

module.exports = {
  initialize,
  checkAndNotifyPeersOfRunningApps,
  startBroadcasting,
  stopBroadcasting,
};
