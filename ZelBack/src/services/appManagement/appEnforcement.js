'use strict';

// What this node does to an installed app that breaks a rule it enforces locally:
// a shared-db operator asking for removal, a writable layer over its budget.

const serviceHelper = require('../serviceHelper');
const dockerService = require('../dockerService');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const hostStorageCapability = require('../utils/hostStorageCapability');
const operationRegistry = require('../utils/operationRegistry');
const appUninstaller = require('../appLifecycle/appUninstaller');
const appOperations = require('../appLifecycle/appOperations');
const log = require('../../lib/log');

/**
 * Monitor shared database applications and handle uninstall signals
 * @returns {Promise<void>}
 */
async function monitorSharedDBApps() {
  try {
    const deployments = await deploymentProvider.listInstalledDeployments();

    // eslint-disable-next-line no-restricted-syntax
    for (const deployment of deployments) {
      // Skip an app mid-operation: this monitor's action is a destructive uninstall,
      // which must not race a lifecycle operation on that app. Per-app (any lease
      // type) - a busy app no longer blocks monitoring every other app.
      if (operationRegistry.isHeld(deployment.appName)) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const sharedDbEntry = deployment.componentEntries().find(([, comp]) => comp.image.includes('runonflux/shared-db'));
      if (sharedDbEntry) {
        const [, sharedDbComp] = sharedDbEntry;
        log.info(`monitorSharedDBApps: Found app ${deployment.appName} using sharedDB`);
        if (sharedDbComp.hostPorts.length > 0) {
          const apiPort = sharedDbComp.hostPorts[sharedDbComp.hostPorts.length - 1];
          // eslint-disable-next-line no-await-in-loop
          const url = `http://localhost:${apiPort}/status`;
          log.info(`monitorSharedDBApps: ${deployment.appName} going to check operator status on url ${url}`);
          // eslint-disable-next-line no-await-in-loop
          const operatorStatus = await serviceHelper.axiosGet(url).catch((error) => log.error(`monitorSharedDBApps: ${deployment.appName} operatorStatus error: ${error}`));
          if (operatorStatus && operatorStatus.data) {
            if (operatorStatus.data.status === 'UNINSTALL') {
              log.info(`monitorSharedDBApps: ${deployment.appName} operatorStatus is UNINSTALL, going to uninstall the app`);
              log.warn(`REMOVAL REASON: Operator uninstall request - ${deployment.appName} operator status set to UNINSTALL (sharedDB monitoring)`);
              // eslint-disable-next-line no-await-in-loop
              await appUninstaller.uninstallApplication(deployment.appName, { forceKill: true, skipGuard: true, broadcastRemoval: true });
            } else {
              log.info(`monitorSharedDBApps: ${deployment.appName} operatorStatus is ${operatorStatus.data.status}`);
            }
          } else {
            log.info(`monitorSharedDBApps: ${deployment.appName} operatorStatus is not set`);
          }
        }
      }
    }
  } catch (error) {
    log.error(`monitorSharedDBApps: ${error}`);
  } finally {
    await serviceHelper.delay(5 * 60 * 1000);
    monitorSharedDBApps();
  }
}

/**
 * Enforce the per-app writable-layer + swap budget on legacy (non-managed) nodes.
 * Managed nodes hard-cap the writable layer in the kernel via the XFS StorageOpt
 * project quota, so the software sweep only runs where there is no quota.
 * Reschedules every 30 minutes.
 * @param {Array} appsStorageViolations - Array tracking storage violations
 * @returns {Promise<void>}
 */
async function enforceWritableLayerLimit(appsStorageViolations) {
  try {
    // Managed nodes cap the writable layer via the XFS project quota (StorageOpt),
    // so this sweep is only needed where there is no kernel-level enforcement.
    if (await hostStorageCapability.supportsManagedStorage()) {
      setTimeout(() => {
        enforceWritableLayerLimit(appsStorageViolations);
      }, 30 * 60 * 1000);
      return;
    }
    const deployments = await deploymentProvider.listInstalledDeployments();
    const dockerSystemDF = await dockerService.dockerGetUsage();
    const GB = 1e9; // decimal GB — matches rootFsGb and docker SizeRootFs
    // eslint-disable-next-line no-restricted-syntax
    for (const deployment of deployments) {
      let totalSize = 0;
      let maxAllowedSize = 0;
      // eslint-disable-next-line no-restricted-syntax
      for (const [, comp] of deployment.componentEntries()) {
        maxAllowedSize += comp.containerDiskGb() * GB;
        const contId = dockerService.getAppDockerNameIdentifier(comp.identifier);
        const contExists = dockerSystemDF.Containers.find((cont) => cont.Names[0] === contId);
        if (contExists) {
          totalSize += contExists.SizeRootFs;
        }
      }
      if (totalSize > maxAllowedSize) {
        appsStorageViolations.push(deployment.appName);
        const occurancies = appsStorageViolations.filter((appName) => (appName) === deployment.appName).length;
        if (occurancies > 3) {
          log.warn(`Application ${deployment.appName} is using ${totalSize} space which is more than allowed ${maxAllowedSize}. Removing...`);
          log.warn(`REMOVAL REASON: Storage violation - ${deployment.appName} using ${totalSize} bytes (max: ${maxAllowedSize}) - ${occurancies} violations (storage monitoring)`);
          // eslint-disable-next-line no-await-in-loop
          await appUninstaller.uninstallApplication(deployment.appName, { forceKill: true, skipGuard: true, broadcastRemoval: true }).catch((error) => {
            log.error(error);
          });
          const adjArray = appsStorageViolations.filter((appName) => (appName) !== deployment.appName);
          // eslint-disable-next-line no-param-reassign
          appsStorageViolations = adjArray;
        } else {
          log.warn(`Application ${deployment.appName} is using ${totalSize} space which is more than allowed ${maxAllowedSize}. Redeploying...`);
          // eslint-disable-next-line no-await-in-loop
          await appOperations.redeployApplication(deployment.appName, { createVolumes: false }).catch((error) => {
            log.error(error);
          });
        }
        // eslint-disable-next-line no-await-in-loop
        await serviceHelper.delay(2 * 60 * 1000);
      }
    }
    setTimeout(() => {
      enforceWritableLayerLimit(appsStorageViolations);
    }, 30 * 60 * 1000);
  } catch (error) {
    log.error(error);
    setTimeout(() => {
      enforceWritableLayerLimit(appsStorageViolations);
    }, 30 * 60 * 1000);
  }
}

module.exports = {
  enforceWritableLayerLimit,
  monitorSharedDBApps,
};
