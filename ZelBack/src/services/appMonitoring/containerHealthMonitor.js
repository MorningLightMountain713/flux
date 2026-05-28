const config = require('config');
const log = require('../../lib/log');
const dbHelper = require('../dbHelper');
const dockerService = require('../dockerService');
const generalService = require('../generalService');
const appInstaller = require('../appLifecycle/appInstaller');
const appUninstaller = require('../appLifecycle/appUninstaller');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const appInspector = require('../appManagement/appInspector');
const appTamperingDetectionService = require('../appTamperingDetectionService');
const globalState = require('../utils/globalState');
const { decryptEnterpriseApps } = require('../appQuery/appQueryService');
const { localAppsInformation } = require('../utils/appConstants');
const { verifyAppVolumeMount } = require('../utils/volumeService');


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
    await appInstaller.installComponent(deployComp, { createVolumes: !volumeMounted });
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
    log.warn(`REMOVAL REASON: Master/slave container recreation failure - ${mainAppName} (containerHealthMonitor)`);
    await appTamperingDetectionService.recordEvent(mainAppName, 'recreation_failed', `Master/slave container recreation failure: ${recreateErr.message}`);
    if (appTamperingDetectionService.isNetworkMissingError(recreateErr.message)) {
      await appTamperingDetectionService.recordEvent(mainAppName, 'network_pruned', `Docker network missing during recreation: ${recreateErr.message}`);
    }
    await appUninstaller.uninstallApplication(mainAppName, { broadcastRemoval: true });
  }
}

module.exports = {
  recreateMissingContainers,
  handleMissingMasterSlaveContainer,
};
