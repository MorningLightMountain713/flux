const { AsyncGate } = require('./asyncGate');

// Global state variables for apps service
// These need to be shared across all modules to maintain the original business logic

let removalInProgress = false;
let installationInProgress = false;
let softRedeployInProgress = false;
let hardRedeployInProgress = false;
let reinstallationOfOldAppsInProgress = false;
let masterSlaveAppsRunning = false;
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
const backupInProgress = [];
const restoreInProgress = [];

// Apps monitored state
let appsMonitored = {};

// Additional state variables for trySpawningGlobalApplication
let fluxNodeWasNotConfirmedOnLastCheck = false;
let firstExecutionAfterItsSynced = true;
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

// Containers intentionally stopped by FluxOS — crash recovery skips die events for these
const stoppingContainers = new Set();

// Apps this node is draining/stopping for graceful shutdown — appName ->
// { state: 'draining'|'stopping', expiresAt: epoch ms }. Written by the
// flux-shutdownd drain socket; read when stamping the LB lifecycle state onto
// fluxapprunning entries and by container recovery (a draining/stopping app's
// containers are being taken down deliberately — don't restart them). Entries
// carry an expiry derived from the pipeline deadline so a failed shutdown
// can't wedge the node in a draining state.
const appLbStates = new Map();


// Cache references - these will be initialized from cacheManager
let spawnErrorsLongerAppCache = null;
let trySpawningGlobalAppCache = null;

// Initialize cache references - this must be called after cacheManager is ready
function initializeCaches(cacheManager) {
  if (cacheManager && cacheManager.appSpawnErrorCache && cacheManager.appSpawnCache) {
    spawnErrorsLongerAppCache = cacheManager.appSpawnErrorCache;
    trySpawningGlobalAppCache = cacheManager.appSpawnCache;
    pendingAppUpdatesCache = cacheManager.pendingAppUpdatesCache;
  }
}

module.exports = {
  // State getters/setters
  get removalInProgress() { return removalInProgress; },
  set removalInProgress(value) { removalInProgress = value; },

  get installationInProgress() { return installationInProgress; },
  set installationInProgress(value) { installationInProgress = value; },

  get softRedeployInProgress() { return softRedeployInProgress; },
  set softRedeployInProgress(value) { softRedeployInProgress = value; },

  get hardRedeployInProgress() { return hardRedeployInProgress; },
  set hardRedeployInProgress(value) { hardRedeployInProgress = value; },

  get reinstallationOfOldAppsInProgress() { return reinstallationOfOldAppsInProgress; },
  set reinstallationOfOldAppsInProgress(value) { reinstallationOfOldAppsInProgress = value; },

  isOperationInProgress() {
    return removalInProgress || installationInProgress || softRedeployInProgress || hardRedeployInProgress || reinstallationOfOldAppsInProgress;
  },

  get masterSlaveAppsRunning() { return masterSlaveAppsRunning; },
  set masterSlaveAppsRunning(value) { masterSlaveAppsRunning = value; },

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
  // run. Consumers read capabilityVerdict directly (cheap, no heavy imports).
  get capabilityVerdict() { return capabilityVerdict; },
  set capabilityVerdict(value) { capabilityVerdict = value; },

  get updateSyncthingRunning() { return updateSyncthingRunning; },
  set updateSyncthingRunning(value) { updateSyncthingRunning = value; },

  get syncthingAppsFirstRun() { return syncthingAppsFirstRun; },
  set syncthingAppsFirstRun(value) { syncthingAppsFirstRun = value; },

  get backupInProgress() { return backupInProgress; },
  get restoreInProgress() { return restoreInProgress; },

  get appsMonitored() { return appsMonitored; },
  set appsMonitored(value) { appsMonitored = value; },

  // Additional state getters/setters
  get fluxNodeWasNotConfirmedOnLastCheck() { return fluxNodeWasNotConfirmedOnLastCheck; },
  set fluxNodeWasNotConfirmedOnLastCheck(value) { fluxNodeWasNotConfirmedOnLastCheck = value; },

  get firstExecutionAfterItsSynced() { return firstExecutionAfterItsSynced; },
  set firstExecutionAfterItsSynced(value) { firstExecutionAfterItsSynced = value; },

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
  get stoppingContainers() { return stoppingContainers; },

  /**
   * Record an app's load-balancer lifecycle state with an expiry.
   * @param {string} appName
   * @param {'draining'|'stopping'} state
   * @param {number} expiresAt epoch ms after which the entry no longer applies
   */
  setAppLbState(appName, state, expiresAt) {
    appLbStates.set(appName, { state, expiresAt });
  },

  /**
   * The app's current LB lifecycle state, or null when none/expired.
   * Expired entries are removed on read.
   * @param {string} appName
   * @returns {'draining'|'stopping'|null}
   */
  getAppLbState(appName) {
    const entry = appLbStates.get(appName);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      appLbStates.delete(appName);
      return null;
    }
    return entry.state;
  },

  /**
   * Remove an app's LB state (drain cancelled / pipeline aborted).
   * @param {string} appName
   * @returns {boolean} whether an entry existed
   */
  clearAppLbState(appName) {
    return appLbStates.delete(appName);
  },

  /**
   * Drop every expired LB state entry.
   * @returns {string[]} the app names whose entries expired
   */
  sweepExpiredAppLbStates() {
    const now = Date.now();
    const expired = [];
    appLbStates.forEach((entry, appName) => {
      if (entry.expiresAt <= now) expired.push(appName);
    });
    expired.forEach((appName) => appLbStates.delete(appName));
    return expired;
  },

  hasAppLbStates() {
    return appLbStates.size > 0;
  },

  get spawnErrorsLongerAppCache() { return spawnErrorsLongerAppCache; },
  set spawnErrorsLongerAppCache(value) { spawnErrorsLongerAppCache = value; },

  get trySpawningGlobalAppCache() { return trySpawningGlobalAppCache; },
  set trySpawningGlobalAppCache(value) { trySpawningGlobalAppCache = value; },

  // Helper functions to match original API
  removalInProgressReset() { removalInProgress = false; },
  setRemovalInProgressToTrue() { removalInProgress = true; },
  installationInProgressReset() { installationInProgress = false; },
  setInstallationInProgressTrue() { installationInProgress = true; },
  softRedeployInProgressReset() { softRedeployInProgress = false; },
  setSoftRedeployInProgressTrue() { softRedeployInProgress = true; },
  hardRedeployInProgressReset() { hardRedeployInProgress = false; },
  setHardRedeployInProgressTrue() { hardRedeployInProgress = true; },

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
