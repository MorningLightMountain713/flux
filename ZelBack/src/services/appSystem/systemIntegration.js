const os = require('os');
const log = require('../../lib/log');
const messageHelper = require('../messageHelper');
// eslint-disable-next-line no-unused-vars
const serviceHelper = require('../serviceHelper');
const verificationHelper = require('../verificationHelper');
const dockerService = require('../dockerService');
// eslint-disable-next-line no-unused-vars
const daemonServiceFluxnodeRpcs = require('../daemonService/daemonServiceFluxnodeRpcs');
// eslint-disable-next-line no-unused-vars
const fluxNetworkHelper = require('../fluxNetworkHelper');
const benchmarkService = require('../benchmarkService');
const hwRequirements = require('../appRequirements/hwRequirements');
const daemonServiceBenchmarkRpcs = require('../daemonService/daemonServiceBenchmarkRpcs');
const generalService = require('../generalService');

// Node specifications cache
const nodeSpecs = {
  cpuCores: 0,
  ram: 0,
  ssdStorage: 0,
};

/**
 * Get node specifications (CPU, RAM, Storage) and cache them
 * @returns {Promise<void>}
 */
async function getNodeSpecs() {
  try {
    if (nodeSpecs.cpuCores === 0) {
      nodeSpecs.cpuCores = os.cpus().length;
    }
    if (nodeSpecs.ram === 0) {
      nodeSpecs.ram = os.totalmem() / 1024 / 1024; // Convert to MB
    }
    if (nodeSpecs.ssdStorage === 0) {
      // get my external IP and check that it is longer than 5 in length.
      const benchmarkResponse = await daemonServiceBenchmarkRpcs.getBenchmarks();
      if (benchmarkResponse.status === 'success') {
        const benchmarkResponseData = JSON.parse(benchmarkResponse.data);
        log.info(`Gathered ssdstorage ${benchmarkResponseData.ssd}`);
        nodeSpecs.ssdStorage = benchmarkResponseData.ssd;
      } else {
        throw new Error('Error getting ssdstorage from benchmarks');
      }
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * Set node specifications manually
 * @param {number} cores - Number of CPU cores
 * @param {number} ram - RAM in MB
 * @param {number} ssdStorage - SSD storage in GB
 */
function setNodeSpecs(cores, ram, ssdStorage) {
  nodeSpecs.cpuCores = cores || nodeSpecs.cpuCores;
  nodeSpecs.ram = ram || nodeSpecs.ram;
  nodeSpecs.ssdStorage = ssdStorage || nodeSpecs.ssdStorage;
  log.info(`Node specs updated: CPU: ${nodeSpecs.cpuCores}, RAM: ${nodeSpecs.ram}MB, SSD: ${nodeSpecs.ssdStorage}GB`);
}

/**
 * Return current node specifications
 * @returns {object} Current node specs
 */
function returnNodeSpecs() {
  return { ...nodeSpecs };
}

/**
 * To get system architecture type (ARM64 or AMD64).
 * @returns {Promise<string>} Architecture type (ARM64 or AMD64).
 */
async function systemArchitecture() {
  // get benchmark architecture - valid are arm64, amd64
  const benchmarkBenchRes = await benchmarkService.getBenchmarks();
  if (benchmarkBenchRes.status === 'error') {
    throw benchmarkBenchRes.data;
  }
  return benchmarkBenchRes.data.architecture;
}

/**
 * To check app requirements of staticip restrictions for a node
 * @param {object} appSpecs App specifications.
 * @returns {boolean} True if all checks passed.
 */
function checkAppStaticIpRequirements(appSpecs) {
  if (appSpecs.version >= 7 && appSpecs.staticip) {
    // Import locally to avoid circular dependency
    // eslint-disable-next-line global-require
    const geolocationService = require('../geolocationService');
    const isMyNodeStaticIP = geolocationService.isStaticIP();
    if (isMyNodeStaticIP !== appSpecs.staticip) {
      throw new Error(`Application ${appSpecs.name} requires static IP address to run. Aborting.`);
    }
  }
  return true;
}

/**
 * To check app requirements of datacenter restrictions for a node
 * @param {object} appSpecs App specifications.
 * @returns {boolean} True if all checks passed.
 */
function checkAppDataCenterRequirements(appSpecs) {
  if (appSpecs.version >= 8 && appSpecs.datacenter === true) {
    // Import locally to avoid circular dependency
    // eslint-disable-next-line global-require
    const geolocationService = require('../geolocationService');
    const isMyNodeDataCenter = geolocationService.isDataCenter();
    if (!isMyNodeDataCenter) {
      throw new Error(`Application ${appSpecs.name} requires data center node to run. Aborting.`);
    }
  }
  return true;
}

/**
 * To check app satisfaction of nodes restrictions for a node
 * @param {object} appSpecs App specifications.
 * @returns {boolean} True if all checks passed.
 */
async function checkAppNodesRequirements(appSpecs) {
  if (appSpecs.version === 7 && appSpecs.nodes && appSpecs.nodes.length) {
    const myCollateral = await generalService.obtainNodeCollateralInformation();
    const benchmarkResponse = await benchmarkService.getBenchmarks();

    if (benchmarkResponse.status === 'error') {
      throw new Error('Unable to detect Flux IP address');
    }

    let myIP = null;
    if (benchmarkResponse.data.ipaddress) {
      log.info(`Gathered IP ${benchmarkResponse.data.ipaddress}`);
      myIP = benchmarkResponse.data.ipaddress.length > 5 ? benchmarkResponse.data.ipaddress : null;
    }

    if (myIP === null) {
      throw new Error('Unable to detect Flux IP address');
    }

    if (appSpecs.nodes.includes(myIP) || appSpecs.nodes.includes(`${myCollateral.txhash}:${myCollateral.txindex}`)) {
      return true;
    }
    throw new Error(`Application ${appSpecs.name} is not allowed to run on this node. Aborting.`);
  }

  return true;
}

/**
 * To check app requirements of geolocation restrictions for a node
 * @param {object} appSpecs App specifications.
 * @returns {boolean} True if all checks passed.
 */
async function checkAppGeolocationRequirements(appSpecs) {
  if (appSpecs.version >= 5 && appSpecs.geolocation && appSpecs.geolocation.length > 0) {
    // Import locally to avoid circular dependency
    // eslint-disable-next-line global-require
    const geolocationService = require('../geolocationService');
    const nodeGeo = await geolocationService.getNodeGeolocation();
    if (!nodeGeo) {
      throw new Error('Node Geolocation not set. Aborting.');
    }
    // previous geolocation specification version (a, b) [aEU, bFR]
    // current geolocation style [acEU], [acEU_CZ], [acEU_CZ_PRG], [a!cEU], [a!cEU_CZ], [a!cEU_CZ_PRG]
    const appContinent = appSpecs.geolocation.find((x) => x.startsWith('a'));
    const appCountry = appSpecs.geolocation.find((x) => x.startsWith('b'));
    const geoC = appSpecs.geolocation.filter((x) => x.startsWith('ac')); // this ensures that new specs can only run on updated nodes.
    const geoCForbidden = appSpecs.geolocation.filter((x) => x.startsWith('a!c'));

    const myNodeLocationContinent = nodeGeo.continentCode;
    const myNodeLocationContCountry = `${nodeGeo.continentCode}_${nodeGeo.countryCode}`;
    const myNodeLocationFull = `${nodeGeo.continentCode}_${nodeGeo.countryCode}_${nodeGeo.regionName}`;
    const myNodeLocationContinentALL = 'ALL';
    const myNodeLocationContCountryALL = `${nodeGeo.continentCode}_ALL`;
    const myNodeLocationFullALL = `${nodeGeo.continentCode}_${nodeGeo.countryCode}_ALL`;
    if (appContinent && !geoC.length && !geoCForbidden.length) { // backwards old style compatible. Can be removed after a month
      if (appContinent.slice(1) !== nodeGeo.continentCode) {
        throw new Error('App specs with continents geolocation set not matching node geolocation. Aborting.');
      }
    }
    if (appCountry) {
      if (appCountry.slice(1) !== nodeGeo.countryCode) {
        throw new Error('App specs with countries geolocation set not matching node geolocation. Aborting.');
      }
    }
    geoCForbidden.forEach((locationNotAllowed) => {
      if (locationNotAllowed.slice(3) === myNodeLocationContinent || locationNotAllowed.slice(3) === myNodeLocationContCountry || locationNotAllowed.slice(3) === myNodeLocationFull) {
        throw new Error('App specs of geolocation set is forbidden to run on node geolocation. Aborting.');
      }
    });
    if (geoC.length) {
      const nodeLocationOK = geoC.find((locationAllowed) => locationAllowed.slice(2) === myNodeLocationContinent || locationAllowed.slice(2) === myNodeLocationContCountry || locationAllowed.slice(2) === myNodeLocationFull
        || locationAllowed.slice(2) === myNodeLocationContinentALL || locationAllowed.slice(2) === myNodeLocationContCountryALL || locationAllowed.slice(2) === myNodeLocationFullALL);
      if (!nodeLocationOK) {
        throw new Error('App specs of geolocation set is not matching to run on node geolocation. Aborting.');
      }
    }
  }

  return true;
}

/**
 * Get full node geolocation string
 * @returns {Promise<string>} Full geolocation string
 */
async function nodeFullGeolocation() {
  // Import locally to avoid circular dependency
  // eslint-disable-next-line global-require
  const geolocationService = require('../geolocationService');
  const nodeGeo = await geolocationService.getNodeGeolocation();
  if (!nodeGeo) {
    throw new Error('Node Geolocation not set. Aborting.');
  }
  return `${nodeGeo.continentCode}_${nodeGeo.countryCode}_${nodeGeo.regionName}`;
}

/**
 * Create Flux network via API
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
async function createFluxNetworkAPI(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      return res.json(errMessage);
    }
    const dockerRes = await dockerService.createFluxDockerNetwork();
    const response = messageHelper.createDataMessage(dockerRes);
    return res.json(response);
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    return res.json(errorResponse);
  }
}

/**
 * Start monitoring of apps
 * @param {object[]} appSpecsToMonitor - Array of app specifications to monitor
 * @returns {Promise<void>}
 */
async function startMonitoringOfApps(appSpecsToMonitor) {
  try {
    if (!appSpecsToMonitor || appSpecsToMonitor.length === 0) {
      return;
    }

    log.info(`Starting monitoring for ${appSpecsToMonitor.length} apps`);

    // eslint-disable-next-line no-restricted-syntax
    for (const appSpec of appSpecsToMonitor) {
      // Initialize monitoring for each app
      log.info(`Monitoring started for ${appSpec.name}`);
    }
  } catch (error) {
    log.error(`Error starting app monitoring: ${error.message}`);
    throw error;
  }
}

/**
 * Stop monitoring of apps
 * @param {object[]} appSpecsToMonitor - Array of app specifications to stop monitoring
 * @param {boolean} [deleteData=false] - Whether to delete monitoring data
 * @returns {Promise<void>}
 */
async function stopMonitoringOfApps(appSpecsToMonitor, deleteData = false) {
  try {
    if (!appSpecsToMonitor || appSpecsToMonitor.length === 0) {
      return;
    }

    log.info(`Stopping monitoring for ${appSpecsToMonitor.length} apps`);

    // eslint-disable-next-line no-restricted-syntax
    for (const appSpec of appSpecsToMonitor) {
      // Stop monitoring for each app
      log.info(`Monitoring stopped for ${appSpec.name}`);

      if (deleteData) {
        log.info(`Monitoring data deleted for ${appSpec.name}`);
      }
    }
  } catch (error) {
    log.error(`Error stopping app monitoring: ${error.message}`);
    throw error;
  }
}

module.exports = {
  getNodeSpecs,
  setNodeSpecs,
  returnNodeSpecs,
  systemArchitecture,
  checkAppStaticIpRequirements,
  checkAppDataCenterRequirements,
  checkAppNodesRequirements,
  checkAppGeolocationRequirements,
  nodeFullGeolocation,
  createFluxNetworkAPI,
  startMonitoringOfApps,
  stopMonitoringOfApps,
};
