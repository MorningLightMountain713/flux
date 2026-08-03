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

// key -> { cpu, memory, hdd, reclaimable } (same units appsResources sums:
// cpu cores, memory MB, hdd GB)
const pending = new Map();

// Called to give reclaimable capacity back, registered by whoever holds it.
// A registration rather than an import so this module - which every resource
// check already depends on - does not acquire a dependency on the feature that
// happens to hold reclaimable reservations today.
let reclaimer = null;

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
 * resource checks account for it. Idempotent per key (re-reserve overwrites).
 * @param {string} key - unique per admission; an app's name for an install, the
 *   session id for a playground session
 * @param {object} deployment - a DeploymentSpec
 * @param {object} [options]
 * @param {boolean} [options.reclaimable] - this reservation can be given back on
 *   demand, because the work behind it is free and interruptible. Paid work that
 *   cannot otherwise fit asks for it back rather than being refused.
 */
function reserve(key, deployment, options = {}) {
  const { cpu, memoryMb: memory } = deployment.resourceTotals();
  const hdd = deployment.reservableHostDiskGb();
  pending.set(key, {
    cpu, memory, hdd, reclaimable: options.reclaimable === true,
  });
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

/**
 * The summed footprint of the pending admissions that can be given back.
 *
 * A subset of pendingResources, never a separate total: it is what a capacity
 * reading ADDS BACK to answer "would this fit if the reclaimable work were not
 * here", which is a different question from "does this fit".
 * @returns {{cpu: number, memory: number, hdd: number}}
 */
function reclaimableResources() {
  let cpu = 0;
  let memory = 0;
  let hdd = 0;
  pending.forEach((r) => {
    if (!r.reclaimable) return;
    cpu += r.cpu;
    memory += r.memory;
    hdd += r.hdd;
  });
  return { cpu, memory, hdd };
}

/**
 * Register the handler that gives reclaimable capacity back.
 *
 * @param {(totals: object) => Promise<void>} fn - asked to free at least this
 *   much; it decides what to give up and how
 */
function setReclaimer(fn) {
  reclaimer = fn;
}

/**
 * Ask for reclaimable capacity back, for work that cannot otherwise fit.
 *
 * MUST NOT be called while holding the admission lock. Reclaiming tears down
 * containers, and AsyncLock force-releases a slot held past its watchdog - so a
 * caller that reclaimed under the lock would silently lose the check-and-reserve
 * atomicity this module exists to provide. Ask outside it, and re-check on the
 * next attempt rather than assuming the capacity is now yours: nothing promises
 * another admission did not take it first.
 *
 * @param {object} totals - ResourceTotals the caller could not fit
 * @returns {Promise<boolean>} whether anything was asked to yield
 */
async function requestReclaim(totals) {
  if (!reclaimer) return false;
  await reclaimer(totals);
  return true;
}

/** Drop all pending reservations. In-memory only, so this is for boot reset and tests. */
function clear() {
  pending.clear();
}

module.exports = {
  withLock,
  reserve,
  release,
  pendingResources,
  reclaimableResources,
  setReclaimer,
  requestReclaim,
  clear,
};
