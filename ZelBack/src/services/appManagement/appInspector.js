const serviceHelper = require('../serviceHelper');
const verificationHelper = require('../verificationHelper');
const messageHelper = require('../messageHelper');
const dockerService = require('../dockerService');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const hostStorageCapability = require('../utils/hostStorageCapability');
const cpuBurstHelper = require('../utils/cpuBurstHelper');
const operationRegistry = require('../utils/operationRegistry');
const log = require('../../lib/log');
const { getContainerStorage } = require('../utils/appUtilities');

// eslint-disable-next-line import/no-extraneous-dependencies
const util = require('util');


const dosState = 0;
const dosMessage = null;

// How long GET /apps/applog/:appname follows the log before closing the
// response. Long enough to carry what a container has said recently, short
// enough that a browser tab does not hold a follow open indefinitely.
const LOG_STREAM_WINDOW_MS = 2000;

const dockerStatsStreamPromise = util.promisify(dockerService.dockerContainerStatsStream);

/**
 * Get top processes running in an application container
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Response message
 */
async function appTop(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;

    if (!appname) {
      throw new Error('No Flux App specified');
    }

    const mainAppName = appname.split('_')[1] || appname;

    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, mainAppName);
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      return res ? res.json(errMessage) : errMessage;
    }

    const appRes = await dockerService.appDockerTop(appname);
    const appResponse = messageHelper.createDataMessage(appRes);
    return res ? res.json(appResponse) : appResponse;
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
 * Get application logs
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Response message
 */
async function appLog(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;

    let { lines } = req.params;
    lines = lines || req.query.lines || 'all';

    if (!appname) {
      throw new Error('No Flux App specified');
    }

    const mainAppName = appname.split('_')[1] || appname;

    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, mainAppName);
    if (authorized === true) {
      let logs = await dockerService.dockerContainerLogs(appname, lines);
      logs = serviceHelper.dockerBufferToString(logs);
      const dataMessage = messageHelper.createDataMessage(logs);
      res.json(dataMessage);
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

/**
 * Stream application logs
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
async function appLogStream(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;

    if (!appname) {
      throw new Error('No Flux App specified');
    }

    const mainAppName = appname.split('_')[1] || appname;

    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, mainAppName);
    if (authorized === true) {
      res.setHeader('Content-Type', 'application/json');
      const { stream, stop } = await dockerService.dockerContainerLogsStream(appname);
      // A burst, not a subscription: this endpoint answers "what has it said
      // lately" and closes. The window is the caller's to choose, which is why
      // the docker layer no longer bakes it in.
      const window = setTimeout(stop, LOG_STREAM_WINDOW_MS);
      stream.on('data', (chunk) => {
        res.write(serviceHelper.ensureString(chunk.toString('utf8')));
        if (res.flush) res.flush();
      });
      stream.on('error', (error) => {
        clearTimeout(window);
        log.error(error);
        res.end();
      });
      stream.on('end', () => {
        clearTimeout(window);
        res.end();
      });
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

/**
 * Poll application logs with filtering
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Response message
 */
async function appLogPolling(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;
    let { lines } = req.params;
    lines = lines || req.query.lineCount || 'all';
    let { since } = req.params;
    since = since || req.query.since || '';

    if (!appname) {
      throw new Error('No Flux App specified');
    }

    const mainAppName = appname.split('_')[1] || appname;

    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, mainAppName);
    if (authorized === true) {
      let parsedLineCount;
      if (lines === 'all') {
        parsedLineCount = 'all';
      } else {
        parsedLineCount = parseInt(lines, 10) || 100;
      }

      const logs = [];
      await new Promise((resolve, reject) => {
        dockerService.dockerContainerLogsPolling(appname, parsedLineCount, since, (err, logLine) => {
          if (err) {
            reject(err);
          } else if (logLine === 'Stream ended') {
            resolve();
          } else if (logLine) {
            logs.push(logLine);
          }
        });
      });

      res.json({
        logs,
        lineCount: parsedLineCount,
        logCount: logs.length,
        sinceTimestamp: since,
        truncated: parsedLineCount === 'all' ? false : logs.length >= parsedLineCount,
        status: 'success',
      });
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

/**
 * Inspect application container
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
async function appInspect(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;

    if (!appname) {
      throw new Error('No Flux App specified');
    }

    const mainAppName = appname.split('_')[1] || appname;

    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, mainAppName);
    if (authorized === true) {
      const response = await dockerService.dockerContainerInspect(appname);
      const appResponse = messageHelper.createDataMessage(response);
      res.json(appResponse);
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(
      error.message,
      error.name,
      error.code,
    );
    res.json(errMessage);
  }
}

/**
 * Get application statistics
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
async function appStats(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;

    if (!appname) {
      throw new Error('No Flux App specified');
    }

    const mainAppName = appname.split('_')[1] || appname;

    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, mainAppName);
    if (authorized === true) {
      const response = await dockerService.dockerContainerStats(appname);
      const containerStorageInfo = await getContainerStorage(appname);
      response.disk_stats = containerStorageInfo;
      const inspect = await dockerService.dockerContainerInspect(appname);
      response.nanoCpus = inspect.HostConfig.NanoCpus;
      const appResponse = messageHelper.createDataMessage(response);
      res.json(appResponse);
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(
      error.message,
      error.name,
      error.code,
    );
    res.json(errMessage);
  }
}

/**
 * Get application monitoring data
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} appsMonitored - Apps monitoring data
 * @returns {Promise<void>}
 */
async function appMonitor(req, res, appsMonitored) {
  try {
    let { appname, range } = req.params;
    appname = appname || req.query.appname;
    range = range || req.query.range || null;

    if (!appname) {
      throw new Error('No Flux App specified');
    }

    if (range !== null) {
      range = parseInt(range, 10);
      if (!Number.isInteger(range) || range <= 0) {
        throw new Error('Invalid range value. It must be a positive integer or null.');
      }
    }

    const mainAppName = appname.split('_')[1] || appname;

    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, mainAppName);
    if (authorized === true) {
      if (appsMonitored[appname]) {
        let appStatsMonitoring = appsMonitored[appname].statsStore;
        if (range) {
          const now = Date.now();
          const cutoffTimestamp = now - range;
          const hoursInMs = 24 * 60 * 60 * 1000;
          appStatsMonitoring = appStatsMonitoring.filter((stats) => stats.timestamp >= cutoffTimestamp);
          if (range > hoursInMs) {
            appStatsMonitoring = appStatsMonitoring.filter((_, index, array) => index % 20 === 0 || index === array.length - 1);
          }
        }
        const appResponse = messageHelper.createDataMessage(appStatsMonitoring);
        res.json(appResponse);
      } else {
        throw new Error('No data available');
      }
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(
      error.message,
      error.name,
      error.code,
    );
    res.json(errMessage);
  }
}

/**
 * Stream application monitoring data
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
async function appMonitorStream(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;

    if (!appname) {
      throw new Error('No Flux App specified');
    }

    const mainAppName = appname.split('_')[1] || appname;

    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, mainAppName);
    if (authorized === true) {
      await dockerStatsStreamPromise(appname, req, res);
      res.end();
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(
      error.message,
      error.name,
      error.code,
    );
    res.json(errMessage);
  }
}

/**
 * Start monitoring an application
 * @param {string} appName - Application name
 * @param {object} [appsMonitored] - Apps monitoring data reference (optional, will get from appsService if not provided)
 * @returns {void}
 */
function startAppMonitoring(appName, appsMonitored) {
  if (!appName) {
    throw new Error('No App specified');
  }

  // eslint-disable-next-line global-require
  // Get appsMonitored from globalState if not provided (to avoid circular dependency)
  if (!appsMonitored) {
    // eslint-disable-next-line global-require
    const globalState = require('../utils/globalState');
    // eslint-disable-next-line prefer-destructuring, no-param-reassign
    appsMonitored = globalState.appsMonitored;
  }

  // Safety check: if appsMonitored is still undefined, throw a more descriptive error
  if (!appsMonitored) {
    // eslint-disable-next-line no-param-reassign
    throw new Error('Failed to initialize app monitoring: appsMonitored object is undefined');
  // eslint-disable-next-line no-param-reassign
  }

  // eslint-disable-next-line no-param-reassign
  log.info('Initialize Monitoring...');
  // Clear previous interval for this app to prevent multiple intervals
  if (appsMonitored[appName] && appsMonitored[appName].oneMinuteInterval) {
    clearInterval(appsMonitored[appName].oneMinuteInterval);
  }
  // eslint-disable-next-line no-param-reassign
  appsMonitored[appName] = {}; // Initialize the app's monitoring object
  if (!appsMonitored[appName].statsStore) {
    // eslint-disable-next-line no-param-reassign
    appsMonitored[appName].statsStore = [];
  }
  if (!appsMonitored[appName].lastHourstatsStore) {
    // eslint-disable-next-line no-param-reassign
    appsMonitored[appName].lastHourstatsStore = [];
  }
  // eslint-disable-next-line no-param-reassign
  appsMonitored[appName].run = 0;
  // eslint-disable-next-line no-param-reassign
  appsMonitored[appName].oneMinuteInterval = setInterval(async () => {
    try {
      if (!appsMonitored[appName]) {
        log.error(`Monitoring of ${appName} already stopped`);
        return;
      // eslint-disable-next-line no-param-reassign
      }
      const dockerContainer = await dockerService.getDockerContainer(appName);
      if (!dockerContainer) {
        log.error(`Monitoring of ${appName} not possible. App does not exist. Forcing stopping of monitoring`);
        // eslint-disable-next-line no-use-before-define
        stopAppMonitoring(appName, true, appsMonitored);
        return;
      }
      // eslint-disable-next-line no-param-reassign
      appsMonitored[appName].run += 1;
      const statsNow = await dockerService.dockerContainerStats(appName);
      const containerStorageInfo = await getContainerStorage(appName);
      // eslint-disable-next-line no-param-reassign
      statsNow.disk_stats = containerStorageInfo;
      const now = Date.now();
      if (appsMonitored[appName].run % 3 === 0) {
        const inspect = await dockerService.dockerContainerInspect(appName);
        // eslint-disable-next-line no-param-reassign
        statsNow.nanoCpus = inspect.HostConfig.NanoCpus;
        appsMonitored[appName].statsStore.push({ timestamp: now, data: statsNow });
        const statsStoreSizeInBytes = new TextEncoder().encode(JSON.stringify(appsMonitored[appName].statsStore)).length;
        const estimatedSizeInMB = statsStoreSizeInBytes / (1024 * 1024);
        log.info(`Size of stats for ${appName}: ${estimatedSizeInMB.toFixed(2)} MB`);
        // eslint-disable-next-line no-param-reassign
        appsMonitored[appName].statsStore = appsMonitored[appName].statsStore.filter(
          (stat) => now - stat.timestamp <= 7 * 24 * 60 * 60 * 1000,
        );
      }
      appsMonitored[appName].lastHourstatsStore.push({ timestamp: now, data: statsNow });
      // eslint-disable-next-line no-param-reassign
      appsMonitored[appName].lastHourstatsStore = appsMonitored[appName].lastHourstatsStore.filter(
        (stat) => now - stat.timestamp <= 60 * 60 * 1000,
      );
    } catch (error) {
      log.error(error);
    }
  }, 1 * 60 * 1000);
}
// eslint-disable-next-line global-require

/**
 * Stop monitoring an application
 * @param {string} appName - Application name
 * @param {boolean} deleteData - Whether to delete monitoring data
 * @param {object} [appsMonitored] - Apps monitoring data reference (optional, will get from appsService if not provided)
 * @returns {void}
 */
function stopAppMonitoring(appName, deleteData, appsMonitored) {
  // Get appsMonitored from globalState if not provided (to avoid circular dependency)
  if (!appsMonitored) {
    // eslint-disable-next-line global-require
    const globalState = require('../utils/globalState');
    // eslint-disable-next-line prefer-destructuring, no-param-reassign
    appsMonitored = globalState.appsMonitored;
  }

  // Safety check: if appsMonitored is still undefined, log warning and return early
  if (!appsMonitored) {
    log.warn(`Cannot stop monitoring for ${appName}: appsMonitored object is undefined`);
    return;
  }

  if (appsMonitored[appName]) {
    clearInterval(appsMonitored[appName].oneMinuteInterval);
    if (deleteData) {
      // eslint-disable-next-line no-param-reassign
      delete appsMonitored[appName];
    }
  }
}

/**
 * Execute command in application container
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
async function appExec(req, res) {
  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', async () => {
    try {
      const processedBody = serviceHelper.ensureObject(body);

      if (!processedBody.appname) {
        throw new Error('No Flux App specified');
      }

      if (!processedBody.cmd) {
        throw new Error('No command specified');
      }

      const mainAppName = processedBody.appname.split('_')[1] || processedBody.appname;

      const authorized = await verificationHelper.verifyPrivilege('appowner', req, mainAppName);
      if (authorized === true) {
        let cmd = processedBody.cmd || [];
        let env = processedBody.env || [];

        cmd = serviceHelper.ensureObject(cmd);
        env = serviceHelper.ensureObject(env);

        const containers = await dockerService.dockerListContainers(true);
        const myContainer = containers.find((container) => (container.Names[0] === dockerService.getAppDockerNameIdentifier(processedBody.appname) || container.Id === processedBody.appname));
        const dockerContainer = dockerService.getDockerContainerHandle(myContainer.Id);

        res.setHeader('Content-Type', 'application/json');

        dockerService.dockerContainerExec(dockerContainer, cmd, env, res, (error) => {
          if (error) {
            log.error(error);
            const errorResponse = messageHelper.createErrorMessage(
              error.message || error,
              error.name,
              error.code,
            );
            res.write(errorResponse);
            res.end();
          } else {
            res.end();
          }
        });
      } else {
        const errMessage = messageHelper.errUnauthorizedMessage();
        res.json(errMessage);
      }
    } catch (error) {
      log.error(error);
      const errorResponse = messageHelper.createErrorMessage(
        error.message || error,
        error.name,
        error.code,
      );
      res.json(errorResponse);
    }
  });
}

/**
 * Get application changes/diff
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
async function appChanges(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;

    if (!appname) {
      throw new Error('No Flux App specified');
    }

    const mainAppName = appname.split('_')[1] || appname;

    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, mainAppName);
    if (authorized === true) {
      const response = await dockerService.dockerContainerChanges(appname);
      const appResponse = messageHelper.createDataMessage(response);
      res.json(appResponse);
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

/**
 * List Docker images used by apps
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<object>} List of Docker images
 */
async function listAppsImages(req, res) {
  try {
    const apps = await dockerService.dockerListImages();
    const appsResponse = messageHelper.createDataMessage(apps);
    return res ? res.json(appsResponse) : appsResponse;
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
 * Get Apps DOS (Denial of Service) State
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} DOS state information
 */
function getAppsDOSState(req, res) {
  const data = {
    dosState,
    dosMessage,
  };
  const response = messageHelper.createDataMessage(data);
  return res ? res.json(response) : response;
}

/**
 * Check if applications are throttling CPU and adjust CPU limits
 * @param {object} appsMonitored - Applications monitoring data
 * @returns {Promise<void>}
 */
async function checkApplicationsCpuUSage(appsMonitored) {
  try {
    const deployments = await deploymentProvider.listInstalledDeployments();
    // eslint-disable-next-line no-restricted-syntax
    for (const deployment of deployments) {
      // eslint-disable-next-line no-restricted-syntax
      for (const [, comp] of deployment.componentEntries()) {
        const id = comp.identifier;
        const stats = appsMonitored[id]?.lastHourstatsStore;
        // eslint-disable-next-line no-await-in-loop
        const inspect = await dockerService.dockerContainerInspect(id);
        // eslint-disable-next-line no-await-in-loop
        if (inspect && await cpuBurstHelper.isBurstActive(inspect.State?.Pid)) {
          log.info(`checkApplicationsCpuUSage ${id} burst-active, skipping CPU throttling`);
          if (appsMonitored[id]) {
            // eslint-disable-next-line no-param-reassign
            appsMonitored[id].lastHourstatsStore = [];
          }
          // eslint-disable-next-line no-continue
          continue;
        }
        if (inspect && stats && stats.length > 4) {
          const nanoCpus = inspect.HostConfig.NanoCpus;
          let cpuThrottlingRuns = 0;
          let cpuThrottling = false;
          const cpuPercentage = nanoCpus / comp.cpu / 1e9;
          // eslint-disable-next-line no-restricted-syntax
          for (const stat of stats) {
            const cpuUsage = stat.data.cpu_stats.cpu_usage.total_usage - stat.data.precpu_stats.cpu_usage.total_usage;
            const systemCpuUsage = stat.data.cpu_stats.system_cpu_usage - stat.data.precpu_stats.system_cpu_usage;
            const cpu = ((cpuUsage / systemCpuUsage) * stat.data.cpu_stats.online_cpus * 100) / comp.cpu || 0;
            const realCpu = cpu / cpuPercentage;
            if (realCpu >= 92) {
              cpuThrottlingRuns += 1;
            }
          }
          if (cpuThrottlingRuns >= stats.length * 0.8) {
            cpuThrottling = true;
          }
          // eslint-disable-next-line no-param-reassign
          appsMonitored[id].lastHourstatsStore = [];
          log.info(`checkApplicationsCpuUSage ${id} cpu high load: ${cpuThrottling}`);
          log.info(`checkApplicationsCpuUSage ${cpuPercentage}`);
          if (cpuThrottling && comp.cpu > 1) {
            if (cpuPercentage === 1) {
              if (comp.cpu > 2) {
                // eslint-disable-next-line no-await-in-loop
                await dockerService.appDockerUpdateCpu(id, Math.round(comp.cpu * 1e9 * 0.8));
              } else {
                // eslint-disable-next-line no-await-in-loop
                await dockerService.appDockerUpdateCpu(id, Math.round(comp.cpu * 1e9 * 0.9));
              }
              log.info(`checkApplicationsCpuUSage ${id} lowering cpu.`);
            }
          } else if (cpuPercentage <= 0.8) {
            // eslint-disable-next-line no-await-in-loop
            await dockerService.appDockerUpdateCpu(id, Math.round(comp.cpu * 1e9 * 0.85));
            log.info(`checkApplicationsCpuUSage ${id} increasing cpu 85.`);
          } else if (cpuPercentage <= 0.85) {
            // eslint-disable-next-line no-await-in-loop
            await dockerService.appDockerUpdateCpu(id, Math.round(comp.cpu * 1e9 * 0.9));
            log.info(`checkApplicationsCpuUSage ${id} increasing cpu 90.`);
          } else if (cpuPercentage <= 0.9) {
            // eslint-disable-next-line no-await-in-loop
            await dockerService.appDockerUpdateCpu(id, Math.round(comp.cpu * 1e9 * 0.95));
            log.info(`checkApplicationsCpuUSage ${id} increasing cpu 95.`);
          } else if (cpuPercentage < 1) {
            // eslint-disable-next-line no-await-in-loop
            await dockerService.appDockerUpdateCpu(id, Math.round(comp.cpu * 1e9));
            log.info(`checkApplicationsCpuUSage ${id} increasing cpu 100.`);
          }
        }
      }
    }
  } catch (error) {
    log.error(error);
  }
}

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
              // eslint-disable-next-line global-require
              const appUninstaller = require('../appLifecycle/appUninstaller');
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
          // eslint-disable-next-line global-require
          const appUninstaller = require('../appLifecycle/appUninstaller');
          await appUninstaller.uninstallApplication(deployment.appName, { forceKill: true, skipGuard: true, broadcastRemoval: true }).catch((error) => {
            log.error(error);
          });
          const adjArray = appsStorageViolations.filter((appName) => (appName) !== deployment.appName);
          // eslint-disable-next-line no-param-reassign
          appsStorageViolations = adjArray;
        } else {
          log.warn(`Application ${deployment.appName} is using ${totalSize} space which is more than allowed ${maxAllowedSize}. Soft redeploying...`);
          // eslint-disable-next-line no-await-in-loop, global-require
          const { redeployApplication } = require('../../services/appLifecycle/appOperations');
          // eslint-disable-next-line no-await-in-loop
          await redeployApplication(deployment.appName, { createVolumes: false }).catch((error) => {
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
  appTop,
  appLog,
  appLogStream,
  appLogPolling,
  appInspect,
  appStats,
  appMonitor,
  appMonitorStream,
  appExec,
  appChanges,
  startAppMonitoring,
  stopAppMonitoring,
  listAppsImages,
  getAppsDOSState,
  checkApplicationsCpuUSage,
  monitorSharedDBApps,
  enforceWritableLayerLimit,
};
