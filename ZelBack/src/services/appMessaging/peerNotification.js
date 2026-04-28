// Peer Notification Service - Manages broadcasting of running apps to network peers
const os = require('os');
const dockerService = require('../dockerService');
const generalService = require('../generalService');
const benchmarkService = require('../benchmarkService');
const geolocationService = require('../geolocationService');
const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
const messageStore = require('./messageStore');
const appInspector = require('../appManagement/appInspector');
const appUninstaller = require('../appLifecycle/appUninstaller');
const appInstaller = require('../appLifecycle/appInstaller');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const appsRepository = require('../appDatabase/appsRepository');
const { listRunningContainers } = require('../appQuery/appQueryService');
const log = require('../../lib/log');
const globalState = require('../utils/globalState');

// Module-level state variable
let checkAndNotifyPeersOfRunningAppsFirstRun = true;

async function recreateMissingContainers(componentIdentifier) {
  const mainAppName = componentIdentifier.split('_')[1] || componentIdentifier;
  const targetComponent = componentIdentifier.includes('_') ? componentIdentifier.split('_')[0] : null;

  const deployment = await deploymentProvider.getInstalledDeployment(mainAppName);
  if (!deployment) {
    throw new Error(`App ${mainAppName} not found in local database`);
  }

  const entries = targetComponent
    ? deployment.componentEntries().filter(([name]) => name === targetComponent)
    : deployment.componentEntries();

  if (entries.length === 0) {
    throw new Error(`Component ${targetComponent} not found in app ${mainAppName}`);
  }

  for (const [, component] of entries) {
    // eslint-disable-next-line no-await-in-loop
    await appInstaller.installComponent(component, { createVolumes: true });
  }

  log.info(`Successfully recreated missing containers for ${componentIdentifier}`);
}

async function handleMissingMasterSlaveContainer(stoppedApp, mainAppName) {
  const containerExists = await dockerService.getDockerContainerOnly(stoppedApp);
  if (containerExists) return;

  log.warn(`Container for master/slave app ${stoppedApp} doesn't exist, recreating...`);
  try {
    await recreateMissingContainers(stoppedApp);
    log.info(`Successfully recreated master/slave app container ${stoppedApp}`);
    appInspector.startAppMonitoring(stoppedApp, globalState.appsMonitored);
  } catch (recreateErr) {
    const containerExistsNow = await dockerService.getDockerContainerOnly(stoppedApp);
    if (containerExistsNow) {
      log.info(`Container for ${stoppedApp} was created by another process, skipping removal`);
      return;
    }
    log.error(`Failed to recreate master/slave app ${stoppedApp}: ${recreateErr.message}`);
    log.warn(`REMOVAL REASON: Master/slave container recreation failure - ${mainAppName} (peerNotification)`);
    await appUninstaller.uninstallApplication(mainAppName, { broadcastRemoval: true });
  }
}

function isOperationInProgress() {
  return globalState.removalInProgress
    || globalState.installationInProgress
    || globalState.softRedeployInProgress
    || globalState.hardRedeployInProgress
    || globalState.reconciliationInProgress;
}

function containerNameToIdentifier(name) {
  if (name.startsWith('/zel')) return name.slice(4);
  return name.slice(5);
}

async function checkAndNotifyPeersOfRunningApps() {
  try {
    let isNodeConfirmed = false;
    isNodeConfirmed = await generalService.isNodeStatusConfirmed();
    if (!isNodeConfirmed) {
      log.info('checkAndNotifyPeersOfRunningApps - FluxNode is not Confirmed');
      return;
    }

    const benchmarkResponse = await benchmarkService.getBenchmarks();
    let myIP = null;
    if (benchmarkResponse.status === 'success') {
      const benchmarkResponseData = benchmarkResponse.data;
      if (benchmarkResponseData.ipaddress) {
        log.info(`Gathered IP ${benchmarkResponseData.ipaddress}`);
        myIP = benchmarkResponseData.ipaddress.length > 5 ? benchmarkResponseData.ipaddress : null;
      }
    }
    if (myIP === null) {
      throw new Error('Unable to detect Flux IP address');
    }

    const deployments = await deploymentProvider.listInstalledDeployments();
    const installedSpecs = await appsRepository.listInstalledApps();
    const runningContainers = await listRunningContainers();

    // Build name → hash map from installed specs for broadcast messages
    const specByName = new Map();
    for (const inst of installedSpecs) {
      specByName.set(inst.name, inst);
    }

    // Build component identifier list from deployments
    const installedAppComponentNames = [];
    const deploymentByName = new Map();
    for (const deployment of deployments) {
      deploymentByName.set(deployment.appName, deployment);
      for (const [, deployComp] of deployment.componentEntries()) {
        installedAppComponentNames.push(deployComp.identifier);
      }
    }

    const runningAppsNames = runningContainers.map((app) => containerNameToIdentifier(app.Names[0]));
    const runningSet = new Set(runningAppsNames);
    const stoppedApps = installedAppComponentNames.filter((id) => !runningSet.has(id));
    const masterSlaveAppNames = new Set();

    const backupInProgress = globalState.backupInProgress || [];
    const restoreInProgress = globalState.restoreInProgress || [];
    const appsStopedCache = require('../utils/cacheManager').default.stoppedAppsCache;

    if (!isOperationInProgress()) {
      for (const stoppedApp of stoppedApps) {
        try {
          const mainAppName = stoppedApp.split('_')[1] || stoppedApp;
          // eslint-disable-next-line no-await-in-loop
          const appExists = await appsRepository.existsGlobalApp(mainAppName);
          const deployment = deploymentByName.get(mainAppName);
          if (!deployment) continue;

          let appHasSyncthing = false;
          let appHasActiveStandby = false;
          for (const [, deployComp] of deployment.componentEntries()) {
            if (deployComp.hasSyncthing()) appHasSyncthing = true;
            if (deployComp.hasActiveStandbySyncthing()) appHasActiveStandby = true;
          }

          if (appHasSyncthing) {
            masterSlaveAppNames.add(mainAppName);
          }
          if (appHasActiveStandby && appExists) {
            const backupSkip = backupInProgress.some((item) => stoppedApp === item);
            const restoreSkip = restoreInProgress.some((item) => stoppedApp === item);
            if (!backupSkip && !restoreSkip) {
              // eslint-disable-next-line no-await-in-loop
              await handleMissingMasterSlaveContainer(stoppedApp, mainAppName);
            }
          } else if (appExists) {
            log.warn(`${stoppedApp} is stopped but should be running. Starting...`);
            const backupSkip = backupInProgress.some((item) => stoppedApp === item);
            const restoreSkip = restoreInProgress.some((item) => stoppedApp === item);
            if (backupSkip || restoreSkip) {
              log.warn(`Application ${stoppedApp} backup/restore is in progress...`);
            }
            if (!isOperationInProgress() && !restoreSkip && !backupSkip) {
              // eslint-disable-next-line no-await-in-loop
              const containerExists = await dockerService.getDockerContainerOnly(stoppedApp);

              if (containerExists && appHasSyncthing) {
                // eslint-disable-next-line no-await-in-loop
                const result = await appsRepository.getAppLocation(mainAppName, myIP);
                if (!result || !result.runningSince || Date.parse(result.runningSince) + 30 * 60 * 1000 > Date.now()) {
                  log.info(`Application ${stoppedApp} uses r syncthing and container exists but is stopped. Haven't started yet because was installed less than 30m ago.`);
                  // eslint-disable-next-line no-continue
                  continue;
                }
              }

              if (!containerExists) {
                log.warn(`Container for ${stoppedApp} doesn't exist, recreating immediately...`);
                try {
                  // eslint-disable-next-line no-await-in-loop
                  await recreateMissingContainers(stoppedApp);
                  log.info(`Successfully recreated ${stoppedApp}`);
                  appInspector.startAppMonitoring(stoppedApp, globalState.appsMonitored);
                } catch (recreateErr) {
                  log.error(`Failed to recreate containers for ${stoppedApp}: ${recreateErr.message}`);
                  log.warn(`REMOVAL REASON: Container recreation failure - ${mainAppName} failed to recreate with error: ${recreateErr.message} (peerNotification)`);
                  // eslint-disable-next-line no-await-in-loop
                  await appUninstaller.uninstallApplication(mainAppName, { broadcastRemoval: true });
                }
              } else {
                log.warn(`${stoppedApp} is stopped, starting`);
                if (!appsStopedCache.has(stoppedApp)) {
                  appsStopedCache.set(stoppedApp, '');
                } else {
                  // eslint-disable-next-line no-await-in-loop
                  await dockerService.appDockerStart(stoppedApp);
                  appInspector.startAppMonitoring(stoppedApp, globalState.appsMonitored);
                }
              }
            } else {
              log.warn(`Not starting ${stoppedApp} as application removal or installation or backup/restore is in progress`);
            }
          }
        } catch (err) {
          log.error(err);
          const mainAppName = stoppedApp.split('_')[1] || stoppedApp;
          if (!isOperationInProgress()) {
            log.warn(`REMOVAL REASON: App start failure - ${mainAppName} failed to start with error: ${err.message} (peerNotification)`);
            // eslint-disable-next-line no-await-in-loop
            await appUninstaller.uninstallApplication(mainAppName, { broadcastRemoval: true });
          }
        }
      }
    } else {
      log.warn('Stopped application checks not running, some removal or installation is in progress');
    }

    // Determine which apps are fully running (all components up)
    const installedAndRunning = [];
    for (const deployment of deployments) {
      const entries = deployment.componentEntries();
      const allRunning = entries.every(([, comp]) => runningAppsNames.includes(comp.identifier));
      if (allRunning) {
        const spec = specByName.get(deployment.appName);
        if (spec) installedAndRunning.push(spec);
      }
    }
    // Include syncthing apps that are stopped (master/slave coordination)
    for (const name of masterSlaveAppNames) {
      const spec = specByName.get(name);
      if (spec && !installedAndRunning.includes(spec)) {
        installedAndRunning.push(spec);
      }
    }

    const apps = [];
    try {
      for (const inst of installedAndRunning) {
        let runningOnMyNodeSince = new Date().toISOString();
        // eslint-disable-next-line no-await-in-loop
        const result = await appsRepository.getAppLocation(inst.name, myIP);
        if (result && result.runningSince) {
          runningOnMyNodeSince = result.runningSince;
        }
        log.info(`${inst.name} is running/installed properly. Broadcasting status.`);
        const newAppRunningMessage = {
          type: 'fluxapprunning',
          version: 1,
          name: inst.name,
          hash: inst.hash,
          ip: myIP,
          broadcastedAt: Date.now(),
          runningSince: runningOnMyNodeSince,
          osUptime: os.uptime(),
          staticIp: geolocationService.isStaticIP(),
        };
        const app = {
          name: inst.name,
          hash: inst.hash,
          runningSince: runningOnMyNodeSince,
        };
        apps.push(app);
        // eslint-disable-next-line no-await-in-loop
        await messageStore.storeAppRunningMessage(newAppRunningMessage);
        if (installedAndRunning.length === 1) {
          // eslint-disable-next-line no-await-in-loop
          await fluxCommunicationMessagesSender.broadcastMessageToAll(newAppRunningMessage);
          log.info(`App Running Message broadcasted ${JSON.stringify(newAppRunningMessage)}`);
        }
      }
      if (installedAndRunning.length > 1) {
        const newAppRunningMessageV2 = {
          type: 'fluxapprunning',
          version: 2,
          apps,
          ip: myIP,
          broadcastedAt: Date.now(),
          osUptime: os.uptime(),
          staticIp: geolocationService.isStaticIP(),
        };
        await fluxCommunicationMessagesSender.broadcastMessageToAll(newAppRunningMessageV2);
        log.info(`App Running Message broadcasted ${JSON.stringify(newAppRunningMessageV2)}`);
      } else if (installedAndRunning.length === 0 && checkAndNotifyPeersOfRunningAppsFirstRun) {
        checkAndNotifyPeersOfRunningAppsFirstRun = false;
        const newAppRunningMessageV2 = {
          type: 'fluxapprunning',
          version: 2,
          apps,
          ip: myIP,
          broadcastedAt: Date.now(),
          osUptime: os.uptime(),
          staticIp: geolocationService.isStaticIP(),
        };
        await fluxCommunicationMessagesSender.broadcastMessageToAll(newAppRunningMessageV2);
        log.info(`No Apps Running Message broadcasted ${JSON.stringify(newAppRunningMessageV2)}`);
      }
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
  }
}

module.exports = {
  checkAndNotifyPeersOfRunningApps,
  handleMissingMasterSlaveContainer,
};
