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
const containerHealthMonitor = require('../appMonitoring/containerHealthMonitor');

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

    // Raw specs for containerHealthMonitor (expects .compose[] format)
    const rawAppsInstalled = await appsRepository.listInstalledAppsRaw();
    // Hydrated specs for class-based component iteration
    const installedSpecs = await appsRepository.listInstalledApps();

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

    const { masterSlaveAppsInstalled, startedApps } = await containerHealthMonitor.monitorAndRecoverApps(localSocketAddr, rawAppsInstalled, runningAppsNames);
    runningAppsNames.push(...startedApps);

    const installedAndRunning = [];
    installedSpecs.forEach((inst) => {
      if (inst.version >= 4) {
        const allRunning = inst.spec.componentNames().every(
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
