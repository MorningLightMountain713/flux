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
const appQueryService = require('../appQuery/appQueryService');
const appReconciler = require('../appMonitoring/appReconciler');
const { resolveSpec } = require('../utils/specCutover');

const fluxEventBus = require('../utils/fluxEventBus');

let checkAndNotifyPeersOfRunningAppsFirstRun = true;
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
      const view = inst.isEncrypted ? await resolveSpec(inst.serialize()) : inst.spec;
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
        // eslint-disable-next-line no-await-in-loop
        const result = await appsRepository.getAppLocation(appName, localSocketAddr);
        let runningOnMyNodeSince = new Date().toISOString();
        if (result && result.runningSince) {
          runningOnMyNodeSince = result.runningSince;
        }
        apps.push({
          name: appName,
          hash: application.hash || '',
          runningSince: runningOnMyNodeSince,
          state: globalState.getAppLbState(appName) ?? 'active',
        });
      }
      if (apps.length === 0 && !checkAndNotifyPeersOfRunningAppsFirstRun) {
        return;
      }
      checkAndNotifyPeersOfRunningAppsFirstRun = false;
      const appRunningMessage = {
        type: 'fluxapprunning',
        version: 2,
        apps,
        ip: localSocketAddr,
        broadcastedAt: Date.now(),
        osUptime: os.uptime(),
        staticIp: geolocationService.isStaticIP(),
      };
      await messageStore.storeAppRunningMessage(appRunningMessage);
      const signed = await fluxCommunicationMessagesSender.broadcastMessageToAll(appRunningMessage);
      await messageStore.storeAppStateEvent(messageStore.APP_STATE_EVENT_TYPES.APPRUNNING, { signedBroadcast: signed });
      fluxEventBus.publish('app:running', { apps, ip: appRunningMessage.ip });
      log.info(`App Running Message broadcasted: ${apps.length} apps`);
    } catch (err) {
      log.error(err);
    }
    const runningAppsCache = globalState.runningAppsCache;
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
