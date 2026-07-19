// Monitoring Orchestrator - Functions to start/stop monitoring and handle API endpoints
const messageHelper = require('../messageHelper');
const appInspector = require('../appManagement/appInspector');
const log = require('../../lib/log');
const deploymentProvider = require('../appRuntime/deploymentProvider');

// Monitoring is started by the node whenever a container comes up and feeds the CPU
// throttling loop, so it is not a setting an operator turns on or off. The routes stay
// so callers are told that rather than silently succeeding against a control that is
// gone; they go at the next major version.
const DEPRECATION_MESSAGE = 'Application monitoring is managed by the node and runs for every app. This endpoint no longer has any effect and will be removed.';

/**
 * Start monitoring multiple applications
 * @param {Array} appSpecsToMonitor - Array of app specifications to monitor, or null for every installed app
 * @returns {Promise<void>}
 */
async function startMonitoringOfApps(appSpecsToMonitor) {
  let deployments;
  if (appSpecsToMonitor) {
    if (!Array.isArray(appSpecsToMonitor)) {
      throw new Error('appSpecsToMonitor must be an array of app specifications');
    }
    deployments = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const app of appSpecsToMonitor) {
      try {
        // One deployment per identity installed here - monitoring keys on the
        // container's identifier, and a co-located node runs one container per
        // replica. A replica-less view yields unqualified identifiers that match
        // no container, so neither sibling would be monitored. The provider
        // resolves encrypted specs on the way through, which is what the
        // retired resolveSpec step did here.
        // eslint-disable-next-line no-await-in-loop
        deployments.push(...await deploymentProvider.getInstalledDeployments(app.name));
      } catch (error) {
        log.error(`startMonitoringOfApps - could not read ${app?.name || '<unnamed app>'}: ${error.message}`);
      }
    }
  } else {
    deployments = await deploymentProvider.listInstalledDeployments();
  }

  // Monitoring drives CPU throttling, so one component that cannot be monitored
  // must not leave the rest of them unthrottled: every start is its own try.
  // eslint-disable-next-line no-restricted-syntax
  for (const deployment of deployments) {
    // eslint-disable-next-line no-restricted-syntax
    for (const [, component] of deployment.componentEntries()) {
      try {
        appInspector.startAppMonitoring(component.identifier);
      } catch (error) {
        log.error(`startMonitoringOfApps - could not start monitoring ${component.identifier}: ${error.message}`);
      }
    }
  }
}

/**
 * Start monitoring API endpoint
 * @param {object} req Request.
 * @param {object} res Response.
 * @returns {object} Message.
 */
async function startAppMonitoringAPI(req, res) {
  const errMessage = messageHelper.createErrorMessage(DEPRECATION_MESSAGE, 'Deprecated', 410);
  return res ? res.json(errMessage) : errMessage;
}

/**
 * Stop monitoring API endpoint
 * @param {object} req Request.
 * @param {object} res Response.
 * @returns {object} Message.
 */
async function stopAppMonitoringAPI(req, res) {
  const errMessage = messageHelper.createErrorMessage(DEPRECATION_MESSAGE, 'Deprecated', 410);
  return res ? res.json(errMessage) : errMessage;
}

// The stream's job is served by polling: /apps/appstats answers with a reading
// at most five seconds old, /apps/appmonitor with the collected series. The
// route stays so a caller is told that rather than getting an anonymous 404 -
// the same contract as the two controls above; it goes at the next major
// version.
const STREAM_DEPRECATION_MESSAGE = 'The stats stream has been removed. Poll /apps/appstats for a live reading or /apps/appmonitor for the collected series.';

/**
 * Stats stream API endpoint
 * @param {object} req Request.
 * @param {object} res Response.
 * @returns {object} Message.
 */
async function appMonitorStreamAPI(req, res) {
  const errMessage = messageHelper.createErrorMessage(STREAM_DEPRECATION_MESSAGE, 'Deprecated', 410);
  return res ? res.json(errMessage) : errMessage;
}

module.exports = {
  appMonitorStreamAPI,
  startMonitoringOfApps,
  startAppMonitoringAPI,
  stopAppMonitoringAPI,
};
