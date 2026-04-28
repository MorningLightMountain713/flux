// Resource Query Service - Query functions for app and node resource usage
const config = require('config');
const dbHelper = require('../dbHelper');
const messageHelper = require('../messageHelper');
const appsRepository = require('../appDatabase/appsRepository');
const hwRequirements = require('../appRequirements/hwRequirements');
const appConstants = require('../utils/appConstants');
const { resolveSpec } = require('../utils/specCutover');
const { getSpecBackend } = require('../utils/specLibs');
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
    const appsResult = await appsRepository.listInstalledAppsRaw();
    let appsCpusLocked = 0;
    let appsRamLocked = 0;
    let appsHddLocked = 0;

    const { DeploymentSpec } = await getSpecBackend();
    const apps = Array.isArray(appsResult) ? appsResult : [];
    // eslint-disable-next-line no-restricted-syntax
    for (const app of apps) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const spec = await resolveSpec(app);
        const deployment = DeploymentSpec.fromSpec(spec, appConstants.appsFolder);
        const { cpu, memory, storage } = deployment.totalResources();
        const componentCount = deployment.componentCount();
        appsCpusLocked += cpu;
        appsRamLocked += memory;
        appsHddLocked += storage + (config.fluxapps.hddFileSystemMinimum + config.fluxapps.defaultSwap) * componentCount;
      } catch (err) {
        log.error(`Failed to compute resources for ${app.name}: ${err.message}`);
      }
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
