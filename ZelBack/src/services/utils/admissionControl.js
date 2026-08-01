const { AsyncLock } = require('./asyncLock');

// In-memory pending-admission accounting for the resource-admission race.
//
// resourceQueryService.appsResources() sums the resource footprint of only the
// apps already in the DB (listInstalledDeployments). An install resource-checks
// (hwRequirements.checkNodeResources) well before it lands in the DB
// (appsRepository.insertInstalledApp), so the check->insert window is unaccounted:
// two concurrent installs of DIFFERENT apps would each pass their check before
// either is counted, and the node double-admits cpu/ram/hdd. (Today this is masked
// because installationInProgress serializes installs node-wide; it appears the
// moment that guard becomes per-app.)
//
// This records an admitted-but-not-yet-installed app's footprint so every resource
// check sees in-flight admissions, and the mutex makes "check + reserve" one atomic
// critical section so two installs cannot both pass before either reserves. This is
// a RESOURCE concern, deliberately separate from the operation registry.

// Single slot => a mutex over the check-and-reserve critical section.
const admissionLock = new AsyncLock(1);

// appName -> { cpu, memory, hdd } (same units appsResources sums:
// cpu cores, memory MB, hdd GB)
const pending = new Map();

/**
 * Run the check-and-reserve critical section under the admission mutex. The
 * callback performs the resource check and, only if it passes, reserves — so a
 * concurrent install cannot read the resource total between this caller's check
 * and its reserve.
 * @param {Function} fn
 * @returns {Promise<*>} whatever fn returns
 */
async function withLock(fn) {
  const release = await admissionLock.acquire({ label: 'admissionControl' });
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Record an admitted-but-not-yet-installed app's resource footprint so subsequent
 * resource checks account for it. Idempotent per app (re-reserve overwrites).
 * @param {string} appName
 * @param {object} deployment - a DeploymentSpec
 */
function reserve(appName, deployment) {
  const { cpu, memoryMb: memory } = deployment.resourceTotals();
  const hdd = deployment.reservableHostDiskGb();
  pending.set(appName, { cpu, memory, hdd });
}

/**
 * Drop an app's pending reservation — once it is durably in the DB (and so counted
 * by appsResources) or its install failed. Idempotent.
 * @param {string} appName
 * @returns {boolean} whether a reservation was dropped
 */
function release(appName) {
  return pending.delete(appName);
}

/**
 * The summed footprint of all pending admissions, in the same units appsResources
 * reports. appsResources adds this to the installed total so every checkNodeResources
 * sees in-flight admissions.
 * @returns {{cpu: number, memory: number, hdd: number}}
 */
function pendingResources() {
  let cpu = 0;
  let memory = 0;
  let hdd = 0;
  pending.forEach((r) => { cpu += r.cpu; memory += r.memory; hdd += r.hdd; });
  return { cpu, memory, hdd };
}

/** Drop all pending reservations. In-memory only, so this is for boot reset and tests. */
function clear() {
  pending.clear();
}

module.exports = {
  withLock, reserve, release, pendingResources, clear,
};
