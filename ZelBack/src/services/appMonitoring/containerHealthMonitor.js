const log = require('../../lib/log');
const appInstaller = require('../appLifecycle/appInstaller');
const appsRepository = require('../appDatabase/appsRepository');
const deploymentProvider = require('../appRuntime/deploymentProvider');
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
    await appInstaller.installComponent(deployComp, { createVolumes: !volumeMounted, owner: instantiated.owner });
  }

  log.info(`Successfully recreated missing containers for ${componentIdentifier}`);
}

module.exports = {
  recreateMissingContainers,
};
