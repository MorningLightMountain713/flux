'use strict';

const { AsyncGate } = require('./asyncGate');

// Global state variables for apps service
// These need to be shared across all modules to maintain the original business logic

const daemonReadyGate = new AsyncGate();
const bootContainerStateSettledGate = new AsyncGate();
const dbReadyGate = new AsyncGate();
// Node-capability ("is-arcane") verdict, resolved once at boot by the awaited
// resolveNodeCapability() (nodeCapabilities.js) before any is-arcane consumer runs.
// true = arcane, false = legacy. null only before the resolver has run — never observed
// by a consumer, since the resolver is awaited at the top of startFluxFunctions.
let capabilityVerdict = null;
let updateSyncthingRunning = false;
let syncthingAppsFirstRun = true;

// Apps monitored state
let appsMonitored = {};

// Additional state variables for trySpawningGlobalApplication
let fluxNodeWasNotConfirmedOnLastCheck = false;
let fluxNodeWasAlreadyConfirmed = false;
let spawnerPaused = false;

// Cache and delay lists
const appsToBeCheckedLater = [];
const appsSyncthingToBeCheckedLater = [];
const receiveOnlySyncthingAppsCache = new Map();
const syncthingDevicesIDCache = new Map();
const folderHealthCache = new Map(); // Tracks health status for sync folders (isolation, connectivity issues)

// Pending app updates cache reference - initialized from cacheManager
let pendingAppUpdatesCache = null;

// Running apps cache - tracks app names that have been broadcasted as running
const runningAppsCache = new Set();

// In-flight installs keyed by bare app name -> AbortController. The install registers
// its controller right after acquiring its operation lease and clears it in its own
// finally; a concurrent cancel/removal of the app aborts the in-flight image pull via
// installingApps.get(name).abort() (the removal prelude). The AbortSignal latches
// `aborted` permanently, so it is the one cancel-vs-install signal a fast detached
// teardown cannot out-race clear.
const installingApps = new Map();

// Apps this node is draining/stopping for graceful shutdown — appName ->
// { state: 'draining'|'stopping', expiresAt: epoch ms }. Written by the
// flux-shutdownd drain socket.
//
// TWO consumers, which is why this is not named for the load balancer: it is
// stamped onto fluxapprunning entries (so FDM pulls the backend), AND the
// reconciler stands down entirely while it is set — a draining app's
// containers must keep serving, a stopped one must not be restarted into the
// daemon's signal stage. The second is local actuation control, and calling
// this "LB state" hid that.
//
// Entries carry an expiry derived from the pipeline deadline so a failed
// shutdown can't wedge the node in a draining state.
const appShutdownPipelineStates = new Map();

// Cache references - these will be initialized from cacheManager
let spawnErrorsLongerAppCache = null;
let trySpawningGlobalAppCache = null;

// Initialize cache references - this must be called after cacheManager is ready
function initializeCaches(cacheManager) {
  if (cacheManager && cacheManager.appSpawnErrorCache && cacheManager.appSpawnCache) {
    spawnErrorsLongerAppCache = cacheManager.appSpawnErrorCache;
    trySpawningGlobalAppCache = cacheManager.appSpawnCache;
    ({ pendingAppUpdatesCache } = cacheManager);
  }
}

module.exports = {
  // State getters/setters
  get daemonReady() { return daemonReadyGate.ready; },
  set daemonReady(value) { if (value) daemonReadyGate.open(); else daemonReadyGate.close(); },
  waitForDaemonReady() { return daemonReadyGate.wait(); },

  get bootContainerStateSettled() { return bootContainerStateSettledGate.ready; },
  set bootContainerStateSettled(value) { if (value) bootContainerStateSettledGate.open(); else bootContainerStateSettledGate.close(); },
  waitForBootContainerStateSettled() { return bootContainerStateSettledGate.wait(); },

  get dbReady() { return dbReadyGate.ready; },
  set dbReady(value) { if (value) dbReadyGate.open(); else dbReadyGate.close(); },
  waitForDbReady() { return dbReadyGate.wait(); },

  // Node-capability verdict (true = arcane, false = legacy), resolved before consumers
  // run. Consumers read it via isArcane() (a use-time read, never a module-load capture).
  get capabilityVerdict() { return capabilityVerdict; },
  set capabilityVerdict(value) { capabilityVerdict = value; },
  // Is this an attested Arcane node? The single is-arcane read for every consumer.
  // Resolved before consumers run, so an unresolved null reads as not-arcane (the safe
  // direction for the security gates).
  isArcane() { return capabilityVerdict === true; },

  get updateSyncthingRunning() { return updateSyncthingRunning; },
  set updateSyncthingRunning(value) { updateSyncthingRunning = value; },

  get syncthingAppsFirstRun() { return syncthingAppsFirstRun; },
  set syncthingAppsFirstRun(value) { syncthingAppsFirstRun = value; },

  get appsMonitored() { return appsMonitored; },
  set appsMonitored(value) { appsMonitored = value; },

  // Additional state getters/setters
  get fluxNodeWasNotConfirmedOnLastCheck() { return fluxNodeWasNotConfirmedOnLastCheck; },
  set fluxNodeWasNotConfirmedOnLastCheck(value) { fluxNodeWasNotConfirmedOnLastCheck = value; },

  get fluxNodeWasAlreadyConfirmed() { return fluxNodeWasAlreadyConfirmed; },
  set fluxNodeWasAlreadyConfirmed(value) { fluxNodeWasAlreadyConfirmed = value; },

  get spawnerPaused() { return spawnerPaused; },
  set spawnerPaused(value) { spawnerPaused = value; },

  get appsToBeCheckedLater() { return appsToBeCheckedLater; },
  get appsSyncthingToBeCheckedLater() { return appsSyncthingToBeCheckedLater; },
  get receiveOnlySyncthingAppsCache() { return receiveOnlySyncthingAppsCache; },
  get syncthingDevicesIDCache() { return syncthingDevicesIDCache; },
  get folderHealthCache() { return folderHealthCache; },
  get runningAppsCache() { return runningAppsCache; },
  get installingApps() { return installingApps; },

  /**
   * Did a concurrent cancel/removal abort THIS app's in-flight install? A cancel calls
   * abortInstall(name) -> installingApps.get(name).abort(); the AbortSignal latches
   * `aborted` permanently, so this is the one cancel-vs-install signal that cannot be
   * out-raced by a fast detached teardown clearing the durable owed-teardown doc. The
   * controller lives in the map until the install's own finally, so it is observable
   * from the install's catch when classifying a thrown install as deferred (cancel) vs
   * failed.
   * @param {string} name bare app name
   * @returns {boolean}
   */
  installAborted(name) {
    const controller = installingApps.get(name);
    return Boolean(controller && controller.signal && controller.signal.aborted);
  },

  /**
   * Abort an app's in-flight install if one is registered (the removal prelude calls
   * this so a cancel ends a racing install's image pull). No-op when nothing is in
   * flight. The install's own finally drops the controller.
   * @param {string} name bare app name
   * @returns {boolean} whether an in-flight install was aborted
   */
  abortInstall(name) {
    const controller = installingApps.get(name);
    if (!controller) return false;
    controller.abort();
    return true;
  },

  /**
   * Record an app's shutdown-pipeline state with an expiry.
   * @param {string} appName
   * @param {'draining'|'stopping'} state
   * @param {number} expiresAt epoch ms after which the entry no longer applies
   */
  setAppShutdownPipelineState(appName, state, expiresAt) {
    appShutdownPipelineStates.set(appName, { state, expiresAt });
  },

  /**
   * The app's current shutdown-pipeline state, or null when none/expired.
   * Expired entries are removed on read.
   * @param {string} appName
   * @returns {'draining'|'stopping'|null}
   */
  getAppShutdownPipelineState(appName) {
    const entry = appShutdownPipelineStates.get(appName);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      appShutdownPipelineStates.delete(appName);
      return null;
    }
    return entry.state;
  },

  /**
   * Remove an app's shutdown-pipeline state (drain cancelled / aborted).
   * @param {string} appName
   * @returns {boolean} whether an entry existed
   */
  clearAppShutdownPipelineState(appName) {
    return appShutdownPipelineStates.delete(appName);
  },

  /**
   * Drop every expired shutdown-pipeline state entry.
   * @returns {string[]} the app names whose entries expired
   */
  sweepExpiredAppShutdownPipelineStates() {
    const now = Date.now();
    const expired = [];
    appShutdownPipelineStates.forEach((entry, appName) => {
      if (entry.expiresAt <= now) expired.push(appName);
    });
    expired.forEach((appName) => appShutdownPipelineStates.delete(appName));
    return expired;
  },

  hasAppShutdownPipelineStates() {
    return appShutdownPipelineStates.size > 0;
  },

  get spawnErrorsLongerAppCache() { return spawnErrorsLongerAppCache; },
  set spawnErrorsLongerAppCache(value) { spawnErrorsLongerAppCache = value; },

  get trySpawningGlobalAppCache() { return trySpawningGlobalAppCache; },
  set trySpawningGlobalAppCache(value) { trySpawningGlobalAppCache = value; },

  // Clear functions
  clearAppsMonitored() { appsMonitored = {}; },
  setAppsMonitored(value) { appsMonitored = value; },

  // Cache initialization
  initializeCaches,

  // Pending app updates cache
  get pendingAppUpdatesCache() { return pendingAppUpdatesCache; },

  /**
   * Queue an update message that arrived before registration was stored.
   * Uses TTL cache - entries automatically expire after 30 minutes.
   * @param {string} appName - The app name
   * @param {object} message - The raw update message to queue
   * @param {number} height - The blockchain height of the update
   */
  queuePendingUpdate(appName, message, height) {
    if (!pendingAppUpdatesCache) return;
    const updates = pendingAppUpdatesCache.get(appName) || [];
    updates.push({ message, height });
    // Keep sorted by height ascending
    updates.sort((a, b) => a.height - b.height);
    pendingAppUpdatesCache.set(appName, updates);
  },

  /**
   * Get pending updates for an app and remove them from the cache.
   * @param {string} appName - The app name
   * @returns {Array<{ message, height }>} The pending updates sorted by height
   */
  getPendingUpdates(appName) {
    if (!pendingAppUpdatesCache) return [];
    const pending = pendingAppUpdatesCache.get(appName);
    if (!pending || pending.length === 0) {
      return [];
    }
    // Remove from cache - they will be processed
    pendingAppUpdatesCache.delete(appName);
    return pending;
  },

  /**
   * Clear all pending updates for an app (e.g., after a failed update).
   * @param {string} appName - The app name
   */
  clearPendingUpdates(appName) {
    if (!pendingAppUpdatesCache) return;
    pendingAppUpdatesCache.delete(appName);
  },
};
