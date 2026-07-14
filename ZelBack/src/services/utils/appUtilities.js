const path = require('path');
const util = require('util');
const nodecmd = require('node-cmd');
const config = require('config');
const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');
const dockerService = require('../dockerService');
const dbHelper = require('../dbHelper');
const { getChainParamsPriceUpdates } = require('./chainUtilities');
const { getSpecBackend, getSpecPolicy } = require('./specLibs');
const { appsFolder } = require('./appConstants');

const globalAppsLocations = config.database.appsglobal.collections.appsLocations;

const cmdAsync = util.promisify(nodecmd.run);
const fluxDirPath = process.env.FLUXOS_PATH || path.join(process.env.HOME, 'zelflux');

/**
 * Calculate app price per month.
 *
 * Accepts whatever `specCutover.resolveSpec()` returns: a cleartext
 * FluxAppSpecBase instance, or a DecryptedCanonicalSpec for an encrypted app
 * (read through its delegates — DeploymentSpec.fromSpec projects readable
 * views without extracting the inner spec). The class owns aggregation via
 * DeploymentSpec.totalResources() + allHostPorts(); this function reduces to
 * the version-specific pricing formula, nothing else.
 *
 * @param {import('@runonflux/flux-spec').FluxAppSpecBase} spec - Class instance (or DecryptedCanonicalSpec)
 * @param {number} height - Block height
 * @param {Array} [suppliedPrices] - Optional pre-fetched price schedule
 * @returns {Promise<number>} Monthly price
 */
async function appPricePerMonth(spec, height, suppliedPrices) {
  if (!spec) throw new Error('Application specification not provided');
  const { classifyPort, PORT_TIER } = await getSpecPolicy();
  const { DeploymentSpec } = await getSpecBackend();

  const appPrices = suppliedPrices || await getChainParamsPriceUpdates();
  const priceSpecifications = appPrices.filter((i) => i.height < height).at(-1);

  const deployment = DeploymentSpec.fromSpec(spec, appsFolder);
  const { cpu, memory, storage } = deployment.totalResources();
  const premPortCount = deployment.allHostPorts()
    .filter((p) => classifyPort(p) === PORT_TIER.PREMIUM).length;

  const cpuPrice = cpu * priceSpecifications.cpu * 10;
  const ramPrice = (memory * priceSpecifications.ram) / 100;
  const hddPrice = storage * priceSpecifications.hdd;
  const portPrice = premPortCount * priceSpecifications.port;

  // v1-v3: flat per-app pricing, no scope/staticip/instance multiplier
  if (spec.version <= 3) {
    let totalPrice = cpuPrice + ramPrice + hddPrice + portPrice;
    if (priceSpecifications.minUSDPrice
      && height >= config.fluxapps.applyMinimumPriceOn3Instances
      && totalPrice < priceSpecifications.minUSDPrice) {
      totalPrice = Number(priceSpecifications.minUSDPrice).toFixed(2);
    }
    let appPrice = Number(Math.ceil(totalPrice * 100) / 100);
    if (appPrice < priceSpecifications.minPrice) appPrice = priceSpecifications.minPrice;
    return appPrice;
  }

  // v4+: scope fee (nodes/enterprise), staticip fee, per-3-instances pricing
  let totalPrice = cpuPrice + ramPrice + hddPrice + portPrice;
  const nodes = spec.nodes;
  if ((nodes && nodes.length) || spec.enterprise) totalPrice += priceSpecifications.scope;
  if (spec.staticip) totalPrice += priceSpecifications.staticip;

  const pricePerInstance = totalPrice / 3;
  let appPrice = Number(Math.ceil(pricePerInstance * 100) / 100);
  const instancesAdditional = spec.instances - 1;
  if (instancesAdditional > 0 && height >= config.fluxapps.applyMinimumForExtraInstances) {
    if (appPrice < 0.50 && instancesAdditional > 2) {
      appPrice += (instancesAdditional * 0.50);
    } else {
      const additionalPrice = appPrice * instancesAdditional;
      appPrice = (Math.ceil(additionalPrice * 100) + Math.ceil(appPrice * 100)) / 100;
    }
  }

  if (priceSpecifications.minUSDPrice
    && height >= config.fluxapps.applyMinimumPriceOn3Instances
    && appPrice < priceSpecifications.minUSDPrice) {
    appPrice = Number(priceSpecifications.minUSDPrice).toFixed(2);
  }

  return appPrice;
}


/**
 * Get app folder size
 * @param {string} appName - Application name
 * @returns {Promise<number>} Folder size in bytes
 */
async function getAppFolderSize(appName) {
  try {
    const appsDirPath = process.env.FLUX_APPS_FOLDER || path.join(fluxDirPath, 'ZelApps');
    const directoryPath = path.join(appsDirPath, appName);
    const exec = `sudo du -s --block-size=1 ${directoryPath}`;
    const cmdres = await cmdAsync(exec);
    const size = serviceHelper.ensureString(cmdres).split('\t')[0] || 0;
    return size;
  } catch (error) {
    log.error(`Error getting app folder size: ${error.message}`);
    return 0;
  }
}

/**
 * Get container storage usage
 * @param {string} appName - Application name
 * @returns {Promise<object>} Storage usage information
 */
async function getContainerStorage(appName) {
  try {
    const containerInfo = await dockerService.dockerContainerInspect(appName, { size: true });
    let bindMountsSize = 0;
    let volumeMountsSize = 0;
    const containerRootFsSize = serviceHelper.ensureNumber(containerInfo.SizeRootFs) || 0;
    if (containerInfo?.Mounts?.length) {
      // Collect all mount sources and filter out nested mounts to avoid double-counting
      const allMounts = containerInfo.Mounts.filter((m) => m?.Source);
      const mountsToCount = [];

      // For each mount, check if it's a child of another mount
      // eslint-disable-next-line no-restricted-syntax
      for (const mount of allMounts) {
        const source = mount.Source;
        const isNested = allMounts.some((otherMount) => {
          if (otherMount === mount) return false; // Skip self
          const otherSource = otherMount.Source;
          // Check if this mount is a child of another mount
          return source.startsWith(`${otherSource}/`);
        });

        if (!isNested) {
          mountsToCount.push(mount);
        }
      }

      await Promise.all(mountsToCount.map(async (mount) => {
        const source = mount.Source;
        const mountType = mount.Type;
        if (mountType === 'bind') {
          const exec = `sudo du -sb ${source}`;
          try {
            const mountInfo = await cmdAsync(exec);
            if (mountInfo) {
              const sizeNum = serviceHelper.ensureNumber(mountInfo.split('\t')[0]) || 0;
              bindMountsSize += sizeNum;
            } else {
              log.warn(`No mount info returned for source: ${source}`);
            }
          } catch (error) {
            log.warn(`Failed to get size for bind mount ${source}: ${error.message}`);
          }
        } else if (mountType === 'volume') {
          const exec = `sudo du -sb ${source}`;
          try {
            const mountInfo = await cmdAsync(exec);
            if (mountInfo) {
              const sizeNum = serviceHelper.ensureNumber(mountInfo.split('\t')[0]) || 0;
              volumeMountsSize += sizeNum;
            } else {
              log.warn(`No mount info returned for source: ${source}`);
            }
          } catch (error) {
            log.warn(`Failed to get size for volume mount ${source}: ${error.message}`);
          }
        } else {
          log.warn(`Unsupported mount type or source: Type: ${mountType}, Source: ${source}`);
        }
      }));
    }
    const usedSize = bindMountsSize + volumeMountsSize + containerRootFsSize;
    return {
      bind: bindMountsSize,
      volume: volumeMountsSize,
      rootfs: containerRootFsSize,
      used: usedSize,
      status: 'success',
    };
  } catch (error) {
    log.error(`Error fetching container storage: ${error.message}`);
    return {
      bind: 0,
      volume: 0,
      rootfs: 0,
      used: 0,
      status: 'error',
      message: error.message,
    };
  }
}

/**
 * Find common architectures across all app components
 * @param {Array<{name: string, architectures: string[]}>} componentArchitectures - Array of component architecture info
 * @returns {string[]} Array of architecture strings common to all components
 */
function findCommonArchitectures(componentArchitectures) {
  if (componentArchitectures.length === 0) return [];
  if (componentArchitectures.length === 1) return componentArchitectures[0].architectures;

  return componentArchitectures[0].architectures.filter((arch) =>
    componentArchitectures.every((comp) => comp.architectures.includes(arch)),
  );
}

function isNewer(a, b) {
  if (a.runningSince && !b.runningSince) return true;
  if (!a.runningSince && b.runningSince) return false;
  if (a.runningSince !== b.runningSince) return a.runningSince > b.runningSince;
  return a.ip > b.ip;
}

function isNewestInstance(locations, myIP) {
  if (locations.length === 0) return false;
  let newest = locations[0];
  for (let i = 1; i < locations.length; i += 1) {
    if (isNewer(locations[i], newest)) newest = locations[i];
  }
  return newest.ip === myIP;
}

function parseContainerName(containerName) {
  const name = containerName.replace(/^\//, '');
  let cleanName = name;
  if (name.startsWith('flux')) {
    cleanName = name.substring(4);
  }
  const underscoreIndex = cleanName.indexOf('_');
  if (underscoreIndex > 0) {
    return {
      componentName: cleanName.substring(0, underscoreIndex),
      appName: cleanName.substring(underscoreIndex + 1),
    };
  }
  return {
    componentName: cleanName,
    appName: cleanName,
  };
}

async function appHasValidLocationOnNode(appName, localSocketAddr) {
  try {
    const db = dbHelper.databaseConnection();
    const database = db.db(config.database.appsglobal.database);
    const query = { name: appName, ip: localSocketAddr };
    const projection = { _id: 0, expireAt: 1 };
    const records = await dbHelper.findInDatabase(database, globalAppsLocations, query, projection);
    if (!records || records.length === 0) {
      return false;
    }
    const now = Date.now();
    return records.some((record) => {
      if (!record.expireAt) return false;
      return new Date(record.expireAt).getTime() > now;
    });
  } catch (error) {
    log.error(`Error checking app location for ${appName}: ${error.message}`);
    return true;
  }
}

module.exports = {
  appHasValidLocationOnNode,
  appPricePerMonth,
  findCommonArchitectures,
  getAppFolderSize,
  getContainerStorage,
  parseContainerName,
  isNewestInstance,
};
