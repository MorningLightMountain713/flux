'use strict';

const config = require('config');
const generalService = require('../generalService');
const geolocationService = require('../geolocationService');
const benchmarkService = require('../benchmarkService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const { collateralOutpoint } = require('../utils/nodePinning');
const enterpriseNetwork = require('../utils/enterpriseNetwork');
const admissionControl = require('../utils/admissionControl');
const log = require('../../lib/log');
const nodeSpecs = require('./nodeSpecs');
const resourceQueryService = require('../appQuery/resourceQueryService');

async function systemArchitecture() {
  const benchmarkBenchRes = await benchmarkService.getBenchmarks();
  if (benchmarkBenchRes.status === 'error') {
    throw benchmarkBenchRes.data;
  }
  return benchmarkBenchRes.data.architecture;
}

// ── Placement checks ────────────────────────────────────────────────
// Accept anything with .placement, .name, .version (RegisteredSpec
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

// A TARGETED SPEC RUNS ON THE NODES IT NAMES AND NOWHERE ELSE, for every version:
// v7 and v8 `nodes` convert to the same typed targets v9 declares (IPs, outpoints,
// operators).
//
// ADDRESS FIRST, and without the daemon: a pin naming this node by address needs
// nothing else, so a node that cannot reach its daemon still honours it. A
// collateral that cannot be read narrows the rest of the match to the operator key.
async function checkTargets(spec) {
  if (!spec.placement.hasTargets()) return true;

  if (!await fluxNetworkHelper.getLocalSocketAddress()) {
    throw new Error('Unable to detect Flux IP address');
  }
  if (await targetsNameThisNode(spec)) return true;
  throw new Error(`Application ${spec.name} is not allowed to run on this node. Aborting.`);
}

/**
 * Whether a spec's targets name this node: true, false, or null when this node
 * cannot establish the identity the answer turns on.
 *
 * A POSITIVE MATCH STANDS ON WHICHEVER IDENTIFIER MADE IT; A NEGATIVE ONE NEEDS
 * EVERY FORM THE TARGETS USE. A target names a node by address, collateral
 * outpoint or operator key, so an identifier this node cannot read removes its
 * ability to recognise that whole form. Read as "not named", a node whose daemon
 * is unreachable would give up an app its spec names.
 *
 * @param {object} spec - a hydrated spec (its placement is cleartext)
 * @returns {Promise<boolean|null>}
 */
async function targetsNameThisNode(spec) {
  const { placement } = spec;
  if (!placement.hasTargets()) return true;

  const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
  if (localSocketAddr && placement.matchesTarget({ ip: localSocketAddr })) {
    return true;
  }

  const myCollateral = await generalService.obtainNodeCollateralInformation().catch((error) => {
    log.warn(`targetsNameThisNode - could not resolve node collateral, targets naming this node by collateral will not match: ${error.message}`);
    return null;
  });
  const outpoint = collateralOutpoint(myCollateral) ?? undefined;
  const operatorPubKey = await fluxNetworkHelper.getFluxNodePublicKey();
  const operator = typeof operatorPubKey === 'string' ? operatorPubKey : undefined;
  if (placement.matchesTarget({ outpoint, operator })) return true;

  const unread = (placement.targetIps.length > 0 && !localSocketAddr)
    || (placement.targetOutpoints.length > 0 && !outpoint)
    || (placement.targetOperators.length > 0 && !operator);
  return unread ? null : false;
}

// ── Resource checks ─────────────────────────────────────────────────
// Accept a DeploymentSpec. Use deployment.resourceTotals() for resource
// totals instead of reading legacy .compose fields.

/**
 * What this node currently has free, measured once.
 *
 * Separated from the fit decision because the two have different costs and
 * different callers. Reading capacity means querying locked resources and node
 * specs; deciding whether one app fits is arithmetic. The spawner screens a
 * whole candidate list per cycle, so it takes one reading and applies it many
 * times rather than re-reading per candidate.
 *
 * @param {object} [options]
 * @param {boolean} [options.ignoreReclaimable] - read as though the reclaimable
 *   reservations were not held. A DIFFERENT question from the default: not "does
 *   this fit", but "is free, interruptible work the only reason it does not".
 *   Paid work asks it before giving up, because the honest answer to a shortfall
 *   a playground session is causing is to reclaim rather than to refuse.
 * @returns {Promise<Object>} the node's free capacity
 */
async function nodeCapacity(options = {}) {
  const resourcesLocked = await resourceQueryService.appsResources();
  if (resourcesLocked.status !== 'success') {
    throw new Error('Unable to obtain locked system resources by Flux Apps. Aborting.');
  }
  const specs = await nodeSpecs.getNodeSpecs();

  const totalSpaceOnNode = specs.ssdStorage;
  const useableSpaceOnNode = totalSpaceOnNode * 0.95
    - config.get('lockedSystemResources.hdd') - config.get('lockedSystemResources.extrahdd');
  const useableCpu = (specs.cpuCores * 10) - config.get('lockedSystemResources.cpu');
  const useableRam = specs.ram - config.get('lockedSystemResources.ram');

  // Added back rather than measured separately: appsResources already counted
  // every pending admission, reclaimable or not, so this undoes that half. One
  // code path means the two readings cannot drift.
  const reclaimed = options.ignoreReclaimable
    ? admissionControl.reclaimableResources()
    : { cpu: 0, memory: 0, hdd: 0 };
  const cpusLocked = resourcesLocked.data.appsCpusLocked - reclaimed.cpu;

  return {
    totalSpaceOnNode,
    availableSpace: useableSpaceOnNode - resourcesLocked.data.appsHddLocked + reclaimed.hdd,
    availableCpu: useableCpu - (cpusLocked * 10),
    availableRam: useableRam - resourcesLocked.data.appsRamLocked + reclaimed.memory,
    freeCores: specs.cpuCores
      - (config.get('lockedSystemResources.cpu') / 10)
      - cpusLocked,
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

async function checkNodeResources(deployment, options = {}) {
  const shortfall = capacityShortfall(await nodeCapacity(options), deployment.resourceTotals());
  if (shortfall) throw new Error(shortfall);
  return true;
}

async function checkCpuBurstHeadroom(deployment, options = {}) {
  const shortfall = burstHeadroomShortfall(await nodeCapacity(options), deployment.resourceTotals());
  if (shortfall) throw new Error(shortfall);
  return true;
}

/**
 * The capacity check for an app that is ALREADY INSTALLED and mid-operation.
 *
 * A redeploy and an update both remove containers before this runs, so a throw
 * here leaves a paid app destroyed rather than merely not started - there is no
 * "defer" available, because the thing that would be deferred has already
 * happened. Free, interruptible work must therefore never be what fails it.
 *
 * So the verdict ignores reclaimable reservations, and the reclaim is requested
 * for real rather than assumed: the app is about to use that capacity, and a
 * session holding it would otherwise overcommit the node until its deadline.
 *
 * Not for admitting NEW work - that is the install path's gate, which can and
 * does defer.
 */
async function checkNodeResourcesReclaiming(deployment) {
  const totals = deployment.resourceTotals();
  await checkNodeResources(deployment, { ignoreReclaimable: true });

  const shortfallIfHeld = capacityShortfall(await nodeCapacity(), totals);
  if (shortfallIfHeld) await admissionControl.requestReclaim(totals);
  return true;
}

module.exports = {
  systemArchitecture,
  checkPlacement,
  targetsNameThisNode,
  checkNodeResources,
  checkNodeResourcesReclaiming,
  checkCpuBurstHeadroom,
  nodeCapacity,
  capacityShortfall,
  burstHeadroomShortfall,
};
