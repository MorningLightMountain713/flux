const config = require('config');
const log = require('../../lib/log');
const dbHelper = require('../dbHelper');
const dockerService = require('../dockerService');
const appsRepository = require('../appDatabase/appsRepository');
const appInstaller = require('../appLifecycle/appInstaller');
const appUninstaller = require('../appLifecycle/appUninstaller');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const appInspector = require('../appManagement/appInspector');
const appTamperingDetectionService = require('../appTamperingDetectionService');
const globalState = require('../utils/globalState');
const cacheManager = require('../utils/cacheManager').default;
const { verifyAppVolumeMount } = require('../utils/volumeService');

const globalAppsLocations = config.database.appsglobal.collections.appsLocations;

async function recreateMissingContainers(componentIdentifier) {
  const mainAppName = componentIdentifier.split('_')[1] || componentIdentifier;
  const instantiated = await appsRepository.getInstalledApp(mainAppName);
  if (!instantiated) {
    throw new Error(`App ${mainAppName} not found in local database`);
  }

  const deployment = await deploymentProvider.buildDeployment(instantiated);
  const isComponent = componentIdentifier.includes('_');
  const componentName = isComponent ? componentIdentifier.split('_')[0] : null;
  const components = componentName
    ? [[componentName, deployment.getComponent(componentName)]]
    : deployment.componentEntries();

  for (const [, deployComp] of components) {
    if (!deployComp) {
      throw new Error(`Component ${componentName} not found in app ${mainAppName}`);
    }
    let volumeMounted = false;
    try {
      volumeMounted = await verifyAppVolumeMount(mainAppName, true, deployComp.name);
    } catch {
      // volume not mounted
    }
    await appInstaller.installComponent(deployComp, { createVolumes: !volumeMounted, owner: instantiated.owner });
  }

  log.info(`Successfully recreated missing containers for ${componentIdentifier}`);
}

async function handleMissingMasterSlaveContainer(stoppedApp, mainAppName) {
  const containerExists = await dockerService.getDockerContainer(stoppedApp);
  if (containerExists) return;

  log.warn(`Container for master/slave app ${stoppedApp} doesn't exist, recreating...`);
  try {
    await recreateMissingContainers(stoppedApp);
    log.info(`Successfully recreated master/slave app container ${stoppedApp}`);
    appInspector.startAppMonitoring(stoppedApp, globalState.appsMonitored);
  } catch (recreateErr) {
    const containerExistsNow = await dockerService.getDockerContainer(stoppedApp);
    if (containerExistsNow) {
      log.info(`Container for ${stoppedApp} was created by another process, skipping removal`);
      return;
    }
    log.error(`Failed to recreate master/slave app ${stoppedApp}: ${recreateErr.message}`);
    log.warn(`REMOVAL REASON: Master/slave container recreation failure - ${mainAppName} (containerHealthMonitor)`);
    await appTamperingDetectionService.recordEvent(mainAppName, 'recreation_failed', `Master/slave container recreation failure: ${recreateErr.message}`);
    if (appTamperingDetectionService.isNetworkMissingError(recreateErr.message)) {
      await appTamperingDetectionService.recordEvent(mainAppName, 'network_pruned', `Docker network missing during recreation: ${recreateErr.message}`);
    }
    await appUninstaller.uninstallApplication(mainAppName, { broadcastRemoval: true });
  }
}

async function monitorAndRecoverApps(localSocketAddr, appsInstalled, runningAppsNames, resolvedViews) {
  await globalState.waitForBootContainerStateSettled();
  const masterSlaveAppsInstalled = [];
  const startedApps = [];
  const installedAppComponentNames = [];
  // `resolvedViews` maps app name → its cleartext spec view (decrypted for
  // enterprise apps). Component names and syncthing predicates are spec-level
  // methods absent on the EncryptedSpecV8 wrapper, so read them from the view.
  for (const inst of appsInstalled) {
    const view = resolvedViews.get(inst.name);
    if (!view) continue;
    for (const compName of view.componentNames()) {
      installedAppComponentNames.push(`${compName}_${inst.name}`);
    }
  }
  const runningSet = new Set(runningAppsNames);
  const stoppedApps = installedAppComponentNames.filter((installedApp) => !runningSet.has(installedApp));

  const backupInProgress = globalState.backupInProgress || [];
  const restoreInProgress = globalState.restoreInProgress || [];
  const appsStoppedCache = cacheManager.stoppedAppsCache;

  if (globalState.isOperationInProgress()) {
    log.warn('Stopped application checks not running, some removal or installation is in progress');
    return { masterSlaveAppsInstalled, startedApps };
  }

  // eslint-disable-next-line no-restricted-syntax
  for (const stoppedApp of stoppedApps) {
    try {
      const mainAppName = stoppedApp.split('_')[1] || stoppedApp;
      // eslint-disable-next-line no-await-in-loop
      const appDetails = await appsRepository.getGlobalAppInfo(mainAppName);
      const inst = appsInstalled.find((app) => app.name === mainAppName);
      const view = inst && resolvedViews.get(inst.name);
      // App-level: an app with any syncthing component is included in the broadcast bucket even
      // when some of its components are stopped (stopped standbys are expected).
      const hasSyncthing = view?.hasSyncthing();
      // Per-component: classify the SPECIFIC stopped component (stoppedApp is `comp_app`) so a
      // non-syncthing sibling of a syncthing app auto-restarts instead of being routed to
      // active-standby election, and the 30-minute syncthing install grace applies only to the
      // syncthing component itself.
      const componentName = stoppedApp.split('_')[0];
      const stoppedComp = view?.getComponent?.(componentName);
      const stoppedCompIsActiveStandby = stoppedComp ? stoppedComp.hasActiveStandbySyncthing() : false;
      const stoppedCompHasSyncthing = stoppedComp ? stoppedComp.hasSyncthing() : false;
      if (hasSyncthing) {
        masterSlaveAppsInstalled.push(inst);
      }
      if (stoppedCompIsActiveStandby && appDetails) {
        const backupSkip = backupInProgress.some((backupItem) => stoppedApp === backupItem);
        const restoreSkip = restoreInProgress.some((backupItem) => stoppedApp === backupItem);
        if (!backupSkip && !restoreSkip) {
          // eslint-disable-next-line no-await-in-loop
          await handleMissingMasterSlaveContainer(stoppedApp, mainAppName);
        }
      } else if (appDetails) {
        log.warn(`${stoppedApp} is stopped but should be running. Starting...`);
        const backupSkip = backupInProgress.some((backupItem) => stoppedApp === backupItem);
        const restoreSkip = restoreInProgress.some((backupItem) => stoppedApp === backupItem);
        if (backupSkip || restoreSkip) {
          log.warn(`Application ${stoppedApp} backup/restore is in progress...`);
        }
        if (!globalState.isOperationInProgress() && !restoreSkip && !backupSkip) {
          // eslint-disable-next-line no-await-in-loop
          const containerExists = await dockerService.getDockerContainer(stoppedApp);

          if (containerExists && stoppedCompHasSyncthing) {
            const db = dbHelper.databaseConnection();
            const database = db.db(config.database.appsglobal.database);
            const queryFind = { name: mainAppName, ip: localSocketAddr };
            const projection = { _id: 0, runningSince: 1 };
            // eslint-disable-next-line no-await-in-loop
            const result = await dbHelper.findOneInDatabase(database, globalAppsLocations, queryFind, projection);
            if (!result || !result.runningSince || Date.parse(result.runningSince) + 30 * 60 * 1000 > Date.now()) {
              log.info(`Application ${stoppedApp} uses r syncthing and container exists but is stopped. Haven't started yet because was installed less than 30m ago.`);
              // eslint-disable-next-line no-continue
              continue;
            }
          }

          if (!containerExists) {
            log.warn(`Container for ${stoppedApp} doesn't exist, recreating immediately...`);
            // eslint-disable-next-line no-await-in-loop
            await appTamperingDetectionService.recordEvent(mainAppName, 'container_vanished', `Container ${stoppedApp} missing, not found in Docker`);
            try {
              // eslint-disable-next-line no-await-in-loop
              await recreateMissingContainers(stoppedApp);
              log.info(`Successfully recreated ${stoppedApp}`);
              appInspector.startAppMonitoring(stoppedApp, globalState.appsMonitored);
              startedApps.push(stoppedApp);
            } catch (recreateErr) {
              log.error(`Failed to recreate containers for ${stoppedApp}: ${recreateErr.message}`);
              log.warn(`REMOVAL REASON: Container recreation failure - ${mainAppName} failed to recreate with error: ${recreateErr.message} (containerHealthMonitor)`);
              // eslint-disable-next-line no-await-in-loop
              await appTamperingDetectionService.recordEvent(mainAppName, 'recreation_failed', `Container recreation failure: ${recreateErr.message}`);
              if (appTamperingDetectionService.isNetworkMissingError(recreateErr.message)) {
                // eslint-disable-next-line no-await-in-loop
                await appTamperingDetectionService.recordEvent(mainAppName, 'network_pruned', `Docker network missing during recreation: ${recreateErr.message}`);
              }
              // eslint-disable-next-line no-await-in-loop
              await appUninstaller.uninstallApplication(mainAppName, { broadcastRemoval: true });
            }
          } else {
            log.warn(`${stoppedApp} is stopped, starting`);
            if (!appsStoppedCache.has(stoppedApp)) {
              appsStoppedCache.set(stoppedApp, '');
            } else {
              // eslint-disable-next-line no-await-in-loop
              await dockerService.appDockerStart(stoppedApp);
              appInspector.startAppMonitoring(stoppedApp, globalState.appsMonitored);
              startedApps.push(stoppedApp);
            }
          }
        } else {
          log.warn(`Not starting ${stoppedApp} as application removal or installation or backup/restore is in progress`);
        }
      }
    } catch (err) {
      log.error(err);
      const mainAppName = stoppedApp.split('_')[1] || stoppedApp;
      if (!globalState.isOperationInProgress()) {
        log.warn(`REMOVAL REASON: App start failure - ${mainAppName} failed to start with error: ${err.message} (containerHealthMonitor)`);
        // eslint-disable-next-line no-await-in-loop
        await appUninstaller.uninstallApplication(mainAppName, { broadcastRemoval: true });
      }
    }
  }
  return { masterSlaveAppsInstalled, startedApps };
}

module.exports = {
  monitorAndRecoverApps,
  recreateMissingContainers,
  handleMissingMasterSlaveContainer,
};
