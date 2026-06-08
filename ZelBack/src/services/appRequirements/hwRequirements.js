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

  const nodeGeo = await geolocationService.getNodeGeolocation();
  if (!nodeGeo) {
    throw new Error('Node Geolocation not set. Aborting.');
  }
  const location = {
    continent: nodeGeo.continentCode,
    country: nodeGeo.countryCode,
    region: nodeGeo.regionName,
  };
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
// Accept a DeploymentSpec. Use deployment.totalResources() for resource
// totals instead of reading legacy .compose fields.

async function appsResources() {
  // eslint-disable-next-line global-require
  const resourceQueryService = require('../appQuery/resourceQueryService');
  return resourceQueryService.appsResources();
}

async function checkNodeResources(deployment) {
  const resourcesLocked = await appsResources();
  if (resourcesLocked.status !== 'success') {
    throw new Error('Unable to obtain locked system resources by Flux Apps. Aborting.');
  }

  const { cpu, memory, storage } = deployment.totalResources();
  const specs = await getNodeSpecs();

  const totalSpaceOnNode = specs.ssdStorage;
  if (totalSpaceOnNode === 0) {
    throw new Error('Insufficient space on Flux Node to spawn an application');
  }
  const useableSpaceOnNode = totalSpaceOnNode * 0.95 - config.lockedSystemResources.hdd - config.lockedSystemResources.extrahdd;
  const availableSpace = useableSpaceOnNode - resourcesLocked.data.appsHddLocked;
  if (storage > availableSpace) {
    throw new Error('Insufficient space on Flux Node to spawn an application');
  }

  const totalCpuOnNode = specs.cpuCores * 10;
  const useableCpu = totalCpuOnNode - config.lockedSystemResources.cpu;
  const availableCpu = useableCpu - (resourcesLocked.data.appsCpusLocked * 10);
  if ((cpu * 10) > availableCpu) {
    throw new Error('Insufficient CPU power on Flux Node to spawn an application');
  }

  const useableRam = specs.ram - config.lockedSystemResources.ram;
  const availableRam = useableRam - resourcesLocked.data.appsRamLocked;
  if (memory > availableRam) {
    throw new Error('Insufficient RAM on Flux Node to spawn an application');
  }

  return true;
}

async function checkCpuBurstHeadroom(deployment) {
  const resourcesLocked = await appsResources();
  if (resourcesLocked.status !== 'success') {
    throw new Error('Unable to obtain locked system resources by Flux Apps. Aborting.');
  }
  const { cpu } = deployment.totalResources();
  const specs = await getNodeSpecs();
  const systemReservedCores = config.lockedSystemResources.cpu / 10;
  const freeCoresAfterInstall = specs.cpuCores
    - systemReservedCores
    - resourcesLocked.data.appsCpusLocked
    - cpu;
  if (freeCoresAfterInstall <= 4) {
    throw new Error('Insufficient CPU burst headroom on Flux Node to spawn an application');
  }
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
  appsResources,
};
