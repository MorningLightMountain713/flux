// Resource Query Service - Query functions for app and node resource usage
const config = require('config');
const dbHelper = require('../dbHelper');
const messageHelper = require('../messageHelper');
const appsRepository = require('../appDatabase/appsRepository');
const hwRequirements = require('../appRequirements/hwRequirements');
const deploymentProvider = require('../appRuntime/deploymentProvider');
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
      const { cpu, memory, storage } = deployment.totalResources();
      const componentCount = deployment.componentCount();
      appsCpusLocked += cpu;
      appsRamLocked += memory;
      appsHddLocked += storage + (config.fluxapps.hddFileSystemMinimum + config.fluxapps.defaultSwap) * componentCount;
    }
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
