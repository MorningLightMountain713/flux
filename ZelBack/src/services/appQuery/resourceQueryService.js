// Resource Query Service - Query functions for app and node resource usage
const messageHelper = require('../messageHelper');
const appsRepository = require('../appDatabase/appsRepository');
const hwRequirements = require('../appRequirements/hwRequirements');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const admissionControl = require('../utils/admissionControl');
const log = require('../../lib/log');

// Import appQueryService to avoid circular dependency (will be cleaned up later)
const appQueryService = require('./appQueryService');

/**
 * Get application usage statistics
 * @param {object} req Request.
 * @param {object} res Response.
 * @returns {object} Message.
 */
async function fluxUsage(req, res) {
  try {
    const totalApps = await appsRepository.countInstalledApps();
    const runningApps = await appQueryService.listRunningApps();
    const totalRunning = runningApps.data ? runningApps.data.length : 0;

    // Ensure node specs are loaded before accessing them
    const nodeSpecs = await hwRequirements.getNodeSpecs();

    const usage = {
      totalApps,
      runningApps: totalRunning,
      stoppedApps: totalApps - totalRunning,
      nodeSpecs,
    };

    const dataResponse = messageHelper.createDataMessage(usage);
    return res ? res.json(dataResponse) : dataResponse;
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    return res ? res.json(errorResponse) : errorResponse;
  }
}

/**
 * Get apps resource usage
 * @param {object} req Request.
 * @param {object} res Response.
 * @returns {object} Message.
 */
async function appsResources(req, res) {
  log.info('Checking appsResources');
  try {
    const deployments = await deploymentProvider.listInstalledDeployments();
    let appsCpusLocked = 0;
    let appsRamLocked = 0;
    let appsHddLocked = 0;

    // eslint-disable-next-line no-restricted-syntax
    for (const deployment of deployments) {
      const { cpu, memory } = deployment.totalResources();
      appsCpusLocked += cpu;
      appsRamLocked += memory;
      // Full host-disk footprint per app: persistent storage + rootFsGb + swapGb
      // across components. Legacy specs report 10/2 per component, matching the old
      // flat (hddFileSystemMinimum + defaultSwap) * componentCount overhead.
      appsHddLocked += deployment.reservableHostDiskGb();
    }
    // Add in-flight admissions: apps that passed resource admission but have not yet
    // landed in the DB (the check->insertInstalledApp window). Without this a
    // concurrent install of a different app would not see them and could double-admit.
    const inflight = admissionControl.pendingResources();
    appsCpusLocked += inflight.cpu;
    appsRamLocked += inflight.memory;
    appsHddLocked += inflight.hdd;
    const appsUsage = {
      appsCpusLocked,
      appsRamLocked,
      appsHddLocked,
    };
    const response = messageHelper.createDataMessage(appsUsage);
    return res ? res.json(response) : response;
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    return res ? res.json(errorResponse) : errorResponse;
  }
}

module.exports = {
  fluxUsage,
  appsResources,
};
