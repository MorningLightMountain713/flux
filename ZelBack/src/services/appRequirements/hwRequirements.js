const os = require('os');
const config = require('config');
const generalService = require('../generalService');
const geolocationService = require('../geolocationService');
const benchmarkService = require('../benchmarkService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const { socketAddressesMatch } = require('../utils/socketAddressUtils');
const enterpriseNetwork = require('../utils/enterpriseNetwork');
const log = require('../../lib/log');

// Node specifications (shared state)
const nodeSpecs = {
  cpuCores: 0,
  ram: 0,
  ssdStorage: 0,
};

async function getNodeSpecs() {
  try {
    if (nodeSpecs.cpuCores === 0) {
      nodeSpecs.cpuCores = os.cpus().length;
    }
    if (nodeSpecs.ram === 0) {
      nodeSpecs.ram = os.totalmem() / 1024 / 1024;
    }
    if (nodeSpecs.ssdStorage === 0) {
      const benchmarkResponse = await benchmarkService.getBenchmarks();
      if (benchmarkResponse.status === 'success') {
        const benchmarkResponseData = benchmarkResponse.data;
        log.info(`Gathered ssdstorage ${benchmarkResponseData.ssd}`);
        nodeSpecs.ssdStorage = benchmarkResponseData.ssd;
      } else {
        throw new Error('Error getting ssdstorage from benchmarks');
      }
    }
  } catch (error) {
    log.error(error);
  }
  return nodeSpecs;
}

function setNodeSpecs(cores, ram, ssdStorage) {
  nodeSpecs.cpuCores = cores;
  nodeSpecs.ram = ram;
  nodeSpecs.ssdStorage = ssdStorage;
}

function returnNodeSpecs() {
  return nodeSpecs;
}

async function systemArchitecture() {
  const benchmarkBenchRes = await benchmarkService.getBenchmarks();
  if (benchmarkBenchRes.status === 'error') {
    throw benchmarkBenchRes.data;
  }
  return benchmarkBenchRes.data.architecture;
}

// ── Placement checks ────────────────────────────────────────────────
// Accept anything with .placement, .name, .version (InstantiatedSpec
// or a bare spec class instance after decrypt).

async function checkPlacement(spec) {
  checkStaticIp(spec);
  checkDataCenter(spec);
  await checkTargets(spec);
  await checkGeolocation(spec);
  return true;
}

function checkStaticIp(spec) {
  if (spec.placement.staticIp) {
    if (!geolocationService.isStaticIP()) {
      throw new Error(`Application ${spec.name} requires static IP address to run. Aborting.`);
    }
  }
  return true;
}

function checkDataCenter(spec) {
  if (spec.placement.dataCenter) {
    // Datacenter placement is restricted to enterprise app owners. Checked at runtime
    // (the owner allowlist is github-synced via enterpriseConfig and can change), not at
    // submission. Applies to v8 and v9 via the version-agnostic placement.dataCenter getter.
    if (!enterpriseNetwork.isEnterpriseAppOwner(spec.owner)) {
      throw new Error('Datacenter requirement is only available for enterprise app owners.');
    }
    if (!geolocationService.isDataCenter()) {
      throw new Error(`Application ${spec.name} requires data center node to run. Aborting.`);
    }
  }
  return true;
}

async function checkGeolocation(spec) {
  const { placement } = spec;
  if (!placement.hasGeoRestrictions()) return true;

  const location = await geolocationService.getPlacementLocation();
  if (!location) {
    throw new Error('Node Geolocation not set. Aborting.');
  }
  if (placement.isDeniedIn(location)) {
    throw new Error('App specs of geolocation set is forbidden to run on node geolocation. Aborting.');
  }
  if (!placement.isAllowedIn(location)) {
    throw new Error('App specs of geolocation set is not matching to run on node geolocation. Aborting.');
  }
  return true;
}

// v7 enforces node targeting at install time; v8 deliberately relaxed this.
// v9+ uses the Placement target API (IPs, outpoints, operators).
async function checkTargets(spec) {
  if (!spec.placement.hasTargets()) return true;

  // v8 has nodes in the schema but does not enforce at install time
  if (spec.version === 8) return true;

  const myCollateral = await generalService.obtainNodeCollateralInformation();
  const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
  if (!localSocketAddr) {
    throw new Error('Unable to detect Flux IP address');
  }
  const operatorPubKey = await fluxNetworkHelper.getFluxNodePublicKey();
  const outpoint = `${myCollateral.txhash}:${myCollateral.txindex}`;

  if (spec.placement.matchesTarget({
    ip: localSocketAddr,
    outpoint,
    operator: operatorPubKey,
    ipMatcher: socketAddressesMatch,
  })) {
    return true;
  }
  throw new Error(`Application ${spec.name} is not allowed to run on this node. Aborting.`);
}

// ── Resource checks ─────────────────────────────────────────────────
// Accept a DeploymentSpec. Use deployment.resourceTotals() for resource
// totals instead of reading legacy .compose fields.

async function appsResources() {
  // eslint-disable-next-line global-require
  const resourceQueryService = require('../appQuery/resourceQueryService');
  return resourceQueryService.appsResources();
}

/**
 * What this node currently has free, measured once.
 *
 * Separated from the fit decision because the two have different costs and
 * different callers. Reading capacity means querying locked resources and node
 * specs; deciding whether one app fits is arithmetic. The spawner screens a
 * whole candidate list per cycle, so it takes one reading and applies it many
 * times rather than re-reading per candidate.
 *
 * @returns {Promise<Object>} the node's free capacity
 */
async function nodeCapacity() {
  const resourcesLocked = await appsResources();
  if (resourcesLocked.status !== 'success') {
    throw new Error('Unable to obtain locked system resources by Flux Apps. Aborting.');
  }
  const specs = await getNodeSpecs();

  const totalSpaceOnNode = specs.ssdStorage;
  const useableSpaceOnNode = totalSpaceOnNode * 0.95
    - config.lockedSystemResources.hdd - config.lockedSystemResources.extrahdd;
  const useableCpu = (specs.cpuCores * 10) - config.lockedSystemResources.cpu;
  const useableRam = specs.ram - config.lockedSystemResources.ram;

  return {
    totalSpaceOnNode,
    availableSpace: useableSpaceOnNode - resourcesLocked.data.appsHddLocked,
    availableCpu: useableCpu - (resourcesLocked.data.appsCpusLocked * 10),
    availableRam: useableRam - resourcesLocked.data.appsRamLocked,
    freeCores: specs.cpuCores
      - (config.lockedSystemResources.cpu / 10)
      - resourcesLocked.data.appsCpusLocked,
  };
}

/**
 * Why an app of this size does not fit, or null if it does.
 *
 * Takes ResourceTotals rather than a spec, so it answers from either vantage:
 * a decrypted DeploymentSpec at install time, or an encrypted app's cleartext
 * summary during selection. That is the whole point of the shared shape — the
 * node applies one capacity rule regardless of whether it can read the app.
 *
 * @param {Object} capacity - from nodeCapacity()
 * @param {import('@runonflux/flux-spec').ResourceTotals} totals
 * @returns {string|null} the reason it does not fit, or null
 */
function capacityShortfall(capacity, totals) {
  if (capacity.totalSpaceOnNode === 0) {
    return 'Insufficient space on Flux Node to spawn an application';
  }
  // The full host-disk footprint (storage + rootFsGb + swapGb), so the node
  // won't admit an app whose image/swap overhead it can't actually hold.
  if (totals.hostDiskGb > capacity.availableSpace) {
    return 'Insufficient space on Flux Node to spawn an application';
  }
  if ((totals.cpu * 10) > capacity.availableCpu) {
    return 'Insufficient CPU power on Flux Node to spawn an application';
  }
  if (totals.memoryMb > capacity.availableRam) {
    return 'Insufficient RAM on Flux Node to spawn an application';
  }
  return null;
}

/**
 * Why installing an app of this size would leave too little burst headroom,
 * or null if it would not. Separate from capacityShortfall because a node can
 * have room for the app and still be left unable to absorb a spike.
 *
 * @param {Object} capacity - from nodeCapacity()
 * @param {import('@runonflux/flux-spec').ResourceTotals} totals
 * @returns {string|null}
 */
function burstHeadroomShortfall(capacity, totals) {
  if (capacity.freeCores - totals.cpu <= 4) {
    return 'Insufficient CPU burst headroom on Flux Node to spawn an application';
  }
  return null;
}

async function checkNodeResources(deployment) {
  const shortfall = capacityShortfall(await nodeCapacity(), deployment.resourceTotals());
  if (shortfall) throw new Error(shortfall);
  return true;
}

async function checkCpuBurstHeadroom(deployment) {
  const shortfall = burstHeadroomShortfall(await nodeCapacity(), deployment.resourceTotals());
  if (shortfall) throw new Error(shortfall);
  return true;
}

module.exports = {
  getNodeSpecs,
  setNodeSpecs,
  returnNodeSpecs,
  systemArchitecture,
  checkPlacement,
  checkNodeResources,
  checkCpuBurstHeadroom,
  nodeCapacity,
  capacityShortfall,
  burstHeadroomShortfall,
  appsResources,
};
