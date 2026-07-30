const config = require('config');
const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');
const dockerService = require('../dockerService');
const appsRepository = require('../appDatabase/appsRepository');
const { getChainParamsPriceUpdates } = require('./chainUtilities');
const { getSpecBackend, getSpecPolicy } = require('./specLibs');
const { appsFolder } = require('./appConstants');


/**
 * Calculate app price per month.
 *
 * Accepts whatever `specCutover.resolveSpec()` returns: a cleartext
 * FluxAppSpecBase instance, or a DecryptedCanonicalSpec for an encrypted app
 * (read through its delegates — DeploymentSpec.fromSpec projects readable
 * views without extracting the inner spec). The class owns aggregation via
 * DeploymentSpec.resourceTotals() + allHostPorts(); this function reduces to
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

  // Declared view deliberately: price is a property of the submitted spec that
  // every node must agree on, never one node's replica view.
  const deployment = DeploymentSpec.fromSpec(spec, appsFolder, { replica: null });
  const { cpu, memoryMb: memory, storageGb: storage } = deployment.resourceTotals();
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
  const { nodes } = spec;
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
          const { error, stdout } = await serviceHelper.runCommand('du', {
            runAsRoot: true,
            logError: false,
            params: ['-sb', source],
          });
          if (error) {
            log.warn(`Failed to get size for bind mount ${source}: ${error.message}`);
          } else if (stdout) {
            const sizeNum = serviceHelper.ensureNumber(stdout.split('\t')[0]) || 0;
            bindMountsSize += sizeNum;
          } else {
            log.warn(`No mount info returned for source: ${source}`);
          }
        } else if (mountType === 'volume') {
          const { error, stdout } = await serviceHelper.runCommand('du', {
            runAsRoot: true,
            logError: false,
            params: ['-sb', source],
          });
          if (error) {
            log.warn(`Failed to get size for volume mount ${source}: ${error.message}`);
          } else if (stdout) {
            const sizeNum = serviceHelper.ensureNumber(stdout.split('\t')[0]) || 0;
            volumeMountsSize += sizeNum;
          } else {
            log.warn(`No mount info returned for source: ${source}`);
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
  // <component>_<app>[_<replica>] - no segment may contain '_', so the app is
  // always [1] and a third segment is the replica name.
  const parts = cleanName.split('_');
  if (parts.length >= 2 && parts[0]) {
    return {
      componentName: parts[0],
      appName: parts[1],
      replica: parts[2] ?? null,
    };
  }
  return {
    componentName: cleanName,
    appName: cleanName,
    replica: null,
  };
}

/**
 * Does the network still consider this app ours?
 *
 * Membership is the whole answer: the derivation only returns live claims — an
 * announcement past its TTL, a node past its shutdown grace, and an evicted node are
 * all already excluded — so a row existing IS the claim being valid. Reading an
 * expiry field back would only re-check what the query enforced.
 *
 * Fails OPEN. The caller uninstalls on a false answer, and a database wobble must
 * never be the reason an app is deleted.
 */
async function appHasValidLocationOnNode(appName, localSocketAddr) {
  try {
    const claims = await appsRepository.appLocationFromEvents({ appname: appName, ip: localSocketAddr });
    return claims.length > 0;
  } catch (error) {
    log.error(`Error checking app location for ${appName}: ${error.message}`);
    return true;
  }
}

module.exports = {
  appHasValidLocationOnNode,
  appPricePerMonth,
  findCommonArchitectures,
  getContainerStorage,
  parseContainerName,
  isNewestInstance,
};
