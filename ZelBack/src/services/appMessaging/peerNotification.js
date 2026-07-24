const os = require('os');
const config = require('config');
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

let broadcastInterval = null;
let broadcastInProgress = false;
let rebroadcastNeeded = false;

function resetBroadcastInterval() {
  if (broadcastInterval) clearInterval(broadcastInterval);
  broadcastInterval = setInterval(() => {
    checkAndNotifyPeersOfRunningApps();
  }, config.fluxapps.peerNotifyIntervalMs ?? 3600000);
}

function stopBroadcastInterval() {
  if (broadcastInterval) {
    clearInterval(broadcastInterval);
    broadcastInterval = null;
  }
}

function initialize() {
  nodeConfirmationService.onMessageCapabilityChange((capable) => {
    if (capable && broadcastInterval) {
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
  try {
    if (!nodeConfirmationService.canSendMessages()) {
      log.info('checkAndNotifyPeersOfRunningApps - Node cannot send messages, skipping broadcast');
      return;
    }

    // Never snapshot before the reconciler's boot drain settles: a too-early
    // snapshot misses apps whose containers are still being started, and their
    // unrefreshed rows expire on the ~7min sigterm TTL (respawn elsewhere).
    // Resolves immediately in steady state; capped reconciler-side, so a wedged
    // reconcile cannot block the node's network presence.
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
        // What we last told the network about ourselves. runningSince originates
        // here and is echoed back by every peer, so it has to survive our own
        // restarts: we read it off our previous announcement rather than restamping
        // it, or an app would look freshly started on every broadcast.
        // eslint-disable-next-line no-await-in-loop
        const priorClaims = await appsRepository.appLocationFromEvents({ appname: appName, ip: localSocketAddr });
        // eslint-disable-next-line no-restricted-syntax
        for (const identity of identities) {
          const prior = priorClaims.find((claim) => (claim.replica ?? null) === identity);
          let runningOnMyNodeSince = new Date().toISOString();
          if (prior && prior.runningSince) {
            runningOnMyNodeSince = prior.runningSince;
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
      // An empty snapshot is NEVER broadcast: peers read an empty v2 message as
      // "this node holds nothing", which releases every seat it had reserved and
      // erases it from the derived running set. Every legitimate correction has a
      // targeted mechanism instead (fluxappremoved on uninstall, sigterm/TTL
      // expiry for wiped or dead nodes).
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
      await messageStore.releaseInstallingClaims(appRunningMessage);
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
    if (rebroadcastNeeded) {
      rebroadcastNeeded = false;
      setImmediate(() => checkAndNotifyPeersOfRunningApps());
    } else {
      resetBroadcastInterval();
    }
  }
}

module.exports = {
  initialize,
  checkAndNotifyPeersOfRunningApps,
  stopBroadcastInterval,
};
