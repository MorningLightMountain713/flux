const fs = require('fs/promises');
const config = require('config');
const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');
const dockerService = require('../dockerService');
const dbHelper = require('../dbHelper');
const { getChainParamsPriceUpdates } = require('./chainUtilities');
const appConstants = require('./appConstants');
const { appsFolder } = appConstants;
const fluxCaching = require('./cacheManager');
const { getSpecBackend, getSpecPolicy } = require('./specLibs');

const globalAppsLocations = config.database.appsglobal.collections.appsLocations;


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
 * Bytes used on the filesystem a mount source sits on, when that filesystem belongs to
 * the app. Each app volume is its own mounted image, so the filesystem's own accounting
 * answers this without walking the tree. An unmounted volume falls through to the node's
 * filesystem, where the same reading would report the whole node as the app's usage, so
 * identify the volume by device and leave anything sharing the apps folder's device to
 * the caller.
 * @param {string} source - Mount source path
 * @param {number} sharedDevice - Device of the filesystem the node shares, resolved by the caller
 * on a mount's first need; undefined for a source outside the apps folder, which returns before reading it
 * @returns {Promise<{device: number, used: number}|null>} Usage, or null when not a dedicated volume
 */
async function dedicatedVolumeUsage(source, sharedDevice) {
  // The whole-filesystem shortcut is only sound when the filesystem belongs to
  // THIS APP, and a differing device number does not establish that on its own.
  // It holds for an app's FLUXFSVOL image, which is mounted under the apps
  // folder and is the case this exists for. It does not hold for a mount docker
  // manages: an image that declares VOLUME on a path the spec does not bind gets
  // an anonymous volume under docker's data root, and where that root is a
  // separate filesystem from the apps folder, this would charge the app the
  // whole of it - every image and every other app's container included.
  //
  // Verified reachable: an image declaring two VOLUMEs with only one bound
  // reports the other as Type: 'volume' with a Source under
  // /var/lib/docker/volumes/<id>/_data. mongo declares /data/db AND
  // /data/configdb, so a spec that maps the data dir and not the config dir is
  // enough. On the node layouts checked (arcane with docker root on /dat,
  // legacy with everything on one disk) the two share a device and this returns
  // null anyway - but that is the layout being kind, not the test being right.
  //
  // So identify the app's own volume by WHERE IT IS, and leave everything else
  // to be walked, which is what the base did for every mount and was correct on
  // every layout.
  if (!source.startsWith(appConstants.appsFolder)) return null;

  const sourceStat = await fs.stat(source);

  if (sourceStat.dev === sharedDevice) return null;

  const { blocks, bfree, bsize } = await fs.statfs(source);
  return { device: sourceStat.dev, used: (blocks - bfree) * bsize };
}

/**
 * Bytes used beneath a path, counted by walking it.
 * @param {string} source - Mount source path
 * @returns {Promise<number>} Size in bytes
 */
async function walkedUsage(source) {
  // argv, never a shell string: the source is a path docker reports, and
  // interpolating it into `sudo du -sb ${source}` makes any metacharacter in it
  // part of the command.
  const { error, stdout } = await serviceHelper.runCommand('du', {
    runAsRoot: true,
    logError: false,
    params: ['-sb', source],
  });

  // du exits 1 at the first entry it cannot read - on a busy app that is an
  // ordinary temp file vanishing mid-walk, not an exceptional state - and still
  // prints the total for everything it did walk. Measured on Linux: over a
  // directory with one unreadable child it prints the running total AND exits 1.
  //
  // So a non-zero exit is not the same as no answer, and runCommand keeps stdout
  // on a failed exit precisely so the number survives. Treating the exit code
  // alone as failure would throw away a figure we already have, once a minute,
  // on exactly the apps that write the most.
  const reported = stdout ? serviceHelper.ensureNumber(stdout.split('\t')[0]) : NaN;
  if (Number.isNaN(reported)) {
    // Nothing usable came back. This is the genuine failure, and the caller has
    // to know the total it builds is short rather than serve it as complete.
    throw error || new Error(`du reported no size for ${source}`);
  }
  if (error) {
    log.warn(`Partial size for ${source}: du could not read every entry (${error.message.split('\n')[0]})`);
  }
  return reported;
}

/**
 * Get container storage usage
 * @param {string} appName - Application name
 * @returns {Promise<object>} Storage usage information
 */
async function getContainerStorage(appName) {
  const cache = fluxCaching.default.containerStorageCache;
  const cached = cache.get(appName);
  if (cached) return cached;

  try {
    const containerInfo = await dockerService.dockerContainerInspect(appName, { size: true });
    let bindMountsSize = 0;
    let volumeMountsSize = 0;
    // Mount sources that could not be measured at all. Empty is the ordinary case
    // and the only one that may be called a success.
    const unmeasured = [];
    const containerRootFsSize = serviceHelper.ensureNumber(containerInfo.SizeRootFs) || 0;
    if (containerInfo?.Mounts?.length) {
      // Which filesystem the node shares is one fact about this call rather than
      // a step in the loop, so it is resolved once and remembered - but only
      // when a mount under the apps folder actually asks. Only those mounts are
      // classified against it, so only they can be failed by it: a container
      // whose mounts all live elsewhere never depends on this fact at all.
      let sharedDevicePromise = null;
      const sharedDevice = () => {
        sharedDevicePromise = sharedDevicePromise
          ?? fs.stat(appConstants.appsFolderPath).then((folder) => folder.dev);
        return sharedDevicePromise;
      };

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

      // Sibling mounts of the same app share one volume, so a whole-filesystem reading
      // counts for all of them together.
      const countedDevices = new Set();

      // eslint-disable-next-line no-restricted-syntax
      for (const mount of mountsToCount) {
        const source = mount.Source;
        const mountType = mount.Type;
        if (mountType !== 'bind' && mountType !== 'volume') {
          log.warn(`Unsupported mount type or source: Type: ${mountType}, Source: ${source}`);
          // eslint-disable-next-line no-continue
          continue;
        }
        // Resolved OUTSIDE the try, and only on need: a mount under the apps
        // folder that cannot be classified must fail the whole reading -
        // sizing it at zero would report a working node as using almost no
        // disk, and nothing under the apps folder can do better - while a
        // mount living anywhere else never asks and is simply walked.
        // eslint-disable-next-line no-await-in-loop
        const shared = source.startsWith(appConstants.appsFolder) ? await sharedDevice() : undefined;
        let size = 0;
        try {
          // eslint-disable-next-line no-await-in-loop
          const volume = await dedicatedVolumeUsage(source, shared);
          if (volume) {
            if (countedDevices.has(volume.device)) {
              // eslint-disable-next-line no-continue
              continue;
            }
            countedDevices.add(volume.device);
            size = volume.used;
          } else {
            // eslint-disable-next-line no-await-in-loop
            size = await walkedUsage(source);
          }
        } catch (error) {
          // The mount contributes nothing, so the total below is SHORT. Recorded
          // rather than swallowed: the reading is still worth serving - a disk bar
          // showing most of the truth beats one showing none of it - but it must
          // not go out labelled as a complete measurement, and it must not be
          // cached, or one transient failure is served as fact for the whole
          // window.
          log.warn(`Failed to get size for ${mountType} mount ${source}: ${error.message}`);
          unmeasured.push(source);
          // eslint-disable-next-line no-continue
          continue;
        }
        if (mountType === 'bind') {
          bindMountsSize += size;
        } else {
          volumeMountsSize += size;
        }
      }
    }
    const usedSize = bindMountsSize + volumeMountsSize + containerRootFsSize;
    const storage = {
      bind: bindMountsSize,
      volume: volumeMountsSize,
      rootfs: containerRootFsSize,
      used: usedSize,
      status: unmeasured.length ? 'partial' : 'success',
    };
    if (unmeasured.length) storage.unmeasured = unmeasured;
    // Only a complete reading is cached. A short one is recomputed next tick,
    // which is where it gets the chance to come good.
    if (!unmeasured.length) cache.set(appName, storage);
    return storage;
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
 * The host ports an application specification declares, across every version.
 *
 * The one place this is derived. A second extraction living somewhere else is
 * two answers to one question that nothing keeps in agreement, and whichever is
 * fixed the other stays wrong.
 *
 * A field the shape does not have yields nothing rather than throwing or a NaN.
 * A missing `ports` used to throw and a version-1 spec with no `port` used to
 * produce `[NaN]` - and NaN is worse than an exception here, because it is a
 * number that compares unequal to everything and fails a long way from home.
 *
 * @param {object} appSpecs - Application specifications
 * @returns {Array<number>} Array of port numbers
 */
function getAppPorts(appSpecs) {
  if (!appSpecs) return [];

  if (appSpecs.version === 1) {
    return appSpecs.port ? [Number(appSpecs.port)] : [];
  }

  if (appSpecs.version <= 3) {
    return (appSpecs.ports || []).map(Number);
  }

  return (appSpecs.compose || [])
    .flatMap((component) => (component.ports || []).map(Number));
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
  getAppPorts,
  getContainerStorage,
  parseContainerName,
  isNewestInstance,
};
