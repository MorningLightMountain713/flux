// Monitoring Orchestrator - Functions to start/stop monitoring and handle API endpoints
const messageHelper = require('../messageHelper');
const serviceHelper = require('../serviceHelper');
const verificationHelper = require('../verificationHelper');
const appInspector = require('../appManagement/appInspector');
const log = require('../../lib/log');
const deploymentProvider = require('../appRuntime/deploymentProvider');

/**
 * Start monitoring multiple applications
 * @param {Array} appSpecsToMonitor - Array of app specifications to monitor
 * @param {object} appsMonitored - Apps monitored structure from appsService
 * @param {Function} installedAppsFn - Function to get installed apps
 * @returns {Promise<object>} Result of monitoring start
 */
async function startMonitoringOfApps(appSpecsToMonitor, appsMonitored, installedAppsFn) {
  try {
    let apps = appSpecsToMonitor;
    if (!apps) {
      const installedAppsRes = await installedAppsFn();
      if (installedAppsRes.status !== 'success') {
        throw new Error('Failed to get installed Apps');
      }
      apps = installedAppsRes.data;
    }

    for (const app of apps) {
      // One deployment per identity installed here — monitoring keys on the
      // container's identifier, and a co-located node runs one container per
      // replica. A replica-less view yields unqualified identifiers that match
      // no container, so neither sibling would be monitored. The provider
      // resolves encrypted specs on the way through.
      // eslint-disable-next-line no-await-in-loop
      const deployments = await deploymentProvider.getInstalledDeployments(app.name);
      for (const deployment of deployments) {
        for (const [, deployComp] of deployment.componentEntries()) {
          appInspector.startAppMonitoring(deployComp.identifier, appsMonitored);
        }
      }
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * Stop monitoring multiple applications
 * @param {Array} appSpecsToMonitor - Array of app specifications to stop monitoring
 * @param {boolean} deleteData - Whether to delete monitoring data
 * @param {object} appsMonitored - Apps monitored structure from appsService
 * @param {Function} installedAppsFn - Function to get installed apps
 * @returns {Promise<object>} Result of monitoring stop
 */
// eslint-disable-next-line default-param-last
async function stopMonitoringOfApps(appSpecsToMonitor, deleteData = false, appsMonitored, installedAppsFn) {
  try {
    let apps = appSpecsToMonitor;
    if (!apps) {
      const installedAppsRes = await installedAppsFn();
      if (installedAppsRes.status !== 'success') {
        throw new Error('Failed to get installed Apps');
      }
      apps = installedAppsRes.data;
    }

    for (const app of apps) {
      // Per identity, for the same reason as the start side: an unqualified
      // identifier stops nothing, because nothing was ever monitored under it.
      // eslint-disable-next-line no-await-in-loop
      const deployments = await deploymentProvider.getInstalledDeployments(app.name);
      for (const deployment of deployments) {
        for (const [, deployComp] of deployment.componentEntries({ reverse: true })) {
          appInspector.stopAppMonitoring(deployComp.identifier, deleteData, appsMonitored);
        }
      }
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * Start monitoring API endpoint
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} appsMonitored - Apps monitored structure from appsService
 * @param {Function} installedAppsFn - Function to get installed apps
 * @returns {object} Message.
 */
async function startAppMonitoringAPI(req, res, appsMonitored, installedAppsFn) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;

    if (!appname) {
      // Only flux team and node owner can monitor all apps
      const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
      if (!authorized) {
        const errMessage = messageHelper.errUnauthorizedMessage();
        return res ? res.json(errMessage) : errMessage;
      }
      await stopMonitoringOfApps(null, false, appsMonitored, installedAppsFn);
      await startMonitoringOfApps(null, appsMonitored, installedAppsFn);
      const monitoringResponse = messageHelper.createSuccessMessage('Application monitoring started for all apps');
      return res ? res.json(monitoringResponse) : monitoringResponse;
    }
    const mainAppName = appname.split('_')[1] || appname;
    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, mainAppName);
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      return res ? res.json(errMessage) : errMessage;
    }
    const installedAppsRes = await installedAppsFn(mainAppName);
    if (installedAppsRes.status !== 'success') {
      throw new Error('Failed to get installed Apps');
    }
    const apps = installedAppsRes.data;
    const appSpecs = apps[0];
    if (!appSpecs) {
      throw new Error(`Application ${mainAppName} is not installed`);
    }
    if (mainAppName === appname) {
      await stopMonitoringOfApps(null, false, appsMonitored, installedAppsFn);
      await startMonitoringOfApps([appSpecs], appsMonitored, installedAppsFn);
    } else { // component based or <= 3
      appInspector.stopAppMonitoring(appname, false, appsMonitored);
      appInspector.startAppMonitoring(appname, appsMonitored);
    }
    const monitoringResponse = messageHelper.createSuccessMessage(`Application monitoring started for ${appSpecs.name}`);
    return res ? res.json(monitoringResponse) : monitoringResponse;
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
 * Stop monitoring API endpoint
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} appsMonitored - Apps monitored structure from appsService
 * @param {Function} installedAppsFn - Function to get installed apps
 * @returns {object} Message.
 */
async function stopAppMonitoringAPI(req, res, appsMonitored, installedAppsFn) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;
    let { deletedata } = req.params;
    deletedata = deletedata || req.query.deletedata || false;
    deletedata = serviceHelper.ensureBoolean(deletedata);

    if (!appname) {
      // Only flux team and node owner can stop monitoring for all apps
      const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
      if (!authorized) {
        const errMessage = messageHelper.errUnauthorizedMessage();
        return res ? res.json(errMessage) : errMessage;
      }
      await stopMonitoringOfApps(null, deletedata, appsMonitored, installedAppsFn);
      let successMessage = '';
      if (!deletedata) {
        successMessage = 'Application monitoring stopped for all apps. Existing monitoring data maintained.';
      } else {
        successMessage = 'Application monitoring stopped for all apps. Monitoring data deleted for all apps.';
      }
      const monitoringResponse = messageHelper.createSuccessMessage(successMessage);
      return res ? res.json(monitoringResponse) : monitoringResponse;
    }
    const mainAppName = appname.split('_')[1] || appname;
    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, mainAppName);
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      return res ? res.json(errMessage) : errMessage;
    }
    let successMessage = '';
    if (mainAppName === appname) {
      // get appSpecs
      const installedAppsRes = await installedAppsFn(mainAppName);
      if (installedAppsRes.status !== 'success') {
        throw new Error('Failed to get installed Apps');
      }
      const apps = installedAppsRes.data;
      const appSpecs = apps[0];
      if (!appSpecs) {
        throw new Error(`Application ${mainAppName} is not installed`);
      }
      await stopMonitoringOfApps([appSpecs], deletedata, appsMonitored, installedAppsFn);
    } else { // component based or <= 3
      appInspector.stopAppMonitoring(appname, deletedata, appsMonitored);
    }
    if (deletedata) {
      successMessage = `Application monitoring stopped and monitoring data deleted for ${appname}.`;
    } else {
      successMessage = `Application monitoring stopped for ${appname}. Existing monitoring data maintained.`;
    }
    const monitoringResponse = messageHelper.createSuccessMessage(successMessage);
    return res ? res.json(monitoringResponse) : monitoringResponse;
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
 * Enhanced appMonitor function that uses the inspector module but adds the monitored data
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} appsMonitored - Apps monitored structure from appsService
 * @returns {object} Monitoring data.
 */
async function appMonitor(req, res, appsMonitored) {
  return appInspector.appMonitor(req, res, appsMonitored);
}

module.exports = {
  startMonitoringOfApps,
  stopMonitoringOfApps,
  startAppMonitoringAPI,
  stopAppMonitoringAPI,
  appMonitor,
};
