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
      const view = inst.isEncrypted ? await resolveSpec(inst.serialize()) : inst.spec;
      if (view) {
        resolvedViews.set(inst.name, view);
      } else {
        log.warn(`peerNotification - could not resolve spec for ${inst.name}; skipping from monitoring/broadcast this cycle`);
      }
    }

    const runningAppsRes = await appQueryService.listRunningApps();
    if (runningAppsRes.status !== 'success') {
      throw new Error('Unable to check running Apps');
    }
    const runningApps = runningAppsRes.data;
    const runningAppsNames = runningApps.map((app) => {
      if (app.Names[0].startsWith('/zel')) {
        return app.Names[0].slice(4);
      }
      return app.Names[0].slice(5);
    });

    // hourly resync trigger: let the reconciler bring any drifted containers
    // (crashed, orphaned, missed events) back to their desired state
    appReconciler.enqueueAll('hourly').catch((err) => log.error(`peerNotification - reconcile sweep failed: ${err.message}`));

    // apps using g:/r: syncthing are advertised as installed-and-running even when
    // some components are intentionally stopped (e.g. slaves), so derive them
    // directly from the specs rather than from container run-state. Encrypted
    // specs answer through their resolved (decrypted) view; unresolvable specs
    // were already excluded from this cycle above.
    const masterSlaveAppsInstalled = installedSpecs.filter((inst) => {
      const view = resolvedViews.get(inst.name);
      if (!view) return false;
      const comps = view.componentEntries().map(([, c]) => c);
      return comps.some((c) => c.hasSyncthing());
    });

    const installedAndRunning = [];
    installedSpecs.forEach((inst) => {
      const view = resolvedViews.get(inst.name);
      if (!view) return; // unresolved (decrypt failure) — skip this cycle
      if (inst.version >= 4) {
        const allRunning = view.componentNames().every(
          (compName) => runningAppsNames.includes(`${compName}_${inst.name}`),
        );
        if (allRunning) {
          installedAndRunning.push(inst);
        }
      } else if (runningAppsNames.includes(inst.name)) {
        installedAndRunning.push(inst);
      }
    });
    installedAndRunning.push(...masterSlaveAppsInstalled);
    const applicationsToBroadcast = [...new Set(installedAndRunning)];
    const apps = [];
    try {
      // eslint-disable-next-line no-restricted-syntax
      for (const application of applicationsToBroadcast) {
        const appName = application.name || application;
        // eslint-disable-next-line no-await-in-loop
        const result = await appsRepository.getAppLocation(appName, localSocketAddr);
        let runningOnMyNodeSince = new Date().toISOString();
        if (result && result.runningSince) {
          runningOnMyNodeSince = result.runningSince;
        }
        const appHash = application.hash || '';
        log.info(`${appName} is running/installed properly. Broadcasting status.`);
        apps.push({
          name: appName,
          hash: appHash,
          runningSince: runningOnMyNodeSince,
        });
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
