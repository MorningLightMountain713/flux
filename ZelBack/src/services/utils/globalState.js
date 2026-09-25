'use strict';

const { AsyncGate } = require('./asyncGate');
const { AsyncLock } = require('./asyncLock');

// Global state variables for apps service
// These need to be shared across all modules to maintain the original business logic

const daemonReadyGate = new AsyncGate();
const bootContainerStateSettledGate = new AsyncGate();
const dbReadyGate = new AsyncGate();
const policyReadyGate = new AsyncGate();
let appStateAuthoritative = false;
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

// Apps, and replicas of apps, this node is handing back with a removal that tells the
// network. An announcement states which identities the node holds, and one whose
// removal has been decided is no longer one of them.
//
// Membership spans the removal, from the decision to the message: an announcement
// that reads the installed table inside that window still finds the row and would
// claim the placement again, and peers apply the two messages in arrival order.
//
// BY IDENTITY. The announcement is a whole snapshot, so an identity missing from it
// releases that seat at every peer: a removal of one replica hands back that replica
// and nothing beside it, while a removal of the whole app hands back every identity.
//
// Only a removal that tells the network belongs here. A removal whose containers
// are coming straight back - a redeploy - keeps announcing, or its row lapses and
// the app is placed a second time.
//
// In-memory deliberately: a restart ends the removal that entered it, and an entry
// that survived would silence an app nothing is removing any more.
//
// Counted, not a set. A forced removal skips the single-removal guard, so two of
// them can run against one app at once - a surplus trim and an expiry removal, or
// an app and one of its components, which share the name the message carries. The
// first to finish would clear a set outright and hand the announcement back to the
// removal still running.
const departingCounts = new Map();
const departingKey = (appName, replica) => (replica == null ? appName : `${appName}\u0000${replica}`);

// Held for the whole of an announcement cycle. It lives here rather than inside
// peerNotification because a removal has to wait on it too, and peerNotification
// already reaches appUninstaller through the reconciler - so the uninstaller
// cannot reach back without a require cycle.
// maxHoldMs: 0 - an announce cycle has no 60s bound; peerNotification measures each
// cycle against its interval and reports an overrun there.
const announceCycle = new AsyncLock(1, { maxHoldMs: 0 });

const departingApps = {
  /**
   * Record that a broadcast removal has begun.
   * @param {string} appName Name the removal message carries.
   * @param {string|null} [replica] The replica it removes; null for the whole app.
   * @returns {void}
   */
  enter(appName, replica = null) {
    const key = departingKey(appName, replica);
    departingCounts.set(key, (departingCounts.get(key) || 0) + 1);
  },

  /**
   * Record that one broadcast removal has finished.
   * @param {string} appName Name the removal message carries.
   * @param {string|null} [replica] The replica it removed; null for the whole app.
   * @returns {void}
   */
  leave(appName, replica = null) {
    const key = departingKey(appName, replica);
    const held = departingCounts.get(key);
    if (!held) return;
    if (held === 1) departingCounts.delete(key);
    else departingCounts.set(key, held - 1);
  },

  /**
   * Whether an identity is being handed back: the whole app, or this replica of it.
   * @param {string} appName Name the removal message carries.
   * @param {string|null} [replica] The replica asked about; null asks about the app.
   * @returns {boolean}
   */
  has(appName, replica = null) {
    if (departingCounts.has(departingKey(appName, null))) return true;
    return replica != null && departingCounts.has(departingKey(appName, replica));
  },

  /**
   * How many identities have a broadcast removal in flight.
   * @returns {number}
   */
  get size() {
    return departingCounts.size;
  },

  /** Forget every removal in flight. */
  clear() {
    departingCounts.clear();
  },
};
// Containers FluxOS removed and has not created again — who removed the container,
// which is the only thing the tampering decision turns on. Docker names, keyed as
// stoppingContainers is.
//
// An absent container is the strongest local evidence of host-side interference the
// node has, and the reconciler records it as `container_vanished`, the
// heaviest-weighted tampering event there is. That reading holds only for a
// container FluxOS did not remove: a teardown that fails part way leaves an absence
// FluxOS caused with the app's row intact, and the app keeps being reconciled, so
// membership here is what stops a node scoring its own removal against the app it
// is hosting.
//
// Written by dockerService's removal funnels, dropped by its creation funnel, and
// dropped for a whole app when the app's local row goes (nothing reconciles it
// after that, so there is no absence left to attribute). FluxOS removed it ->
// present; FluxOS created it -> absent; anything missing without an entry here is
// what the tampering event is for.
//
// In-memory deliberately: across a restart the node genuinely cannot tell its own
// removal from anyone else's, and an entry that survived would suppress a real
// signal.
const fluxRemovedContainers = new Set();

// Syncthing folders this node holds writable (sendreceive), refreshed by the
// syncthing monitor each pass and served to peers that ask before promoting a
// folder of their own. Kept here rather than read from syncthing per request:
// the route is unauthenticated, and an on-demand read would be an amplifier into
// syncthing on a node any peer can reach.
//
// null until the monitor's first validated read, and a Set from then on. "I hold
// nothing writable" and "I have not looked yet" are the same empty set but
// opposite answers to a peer deciding whether to promote, so they must not be the
// same value: a node that IS holding a folder would otherwise read as free, and
// the peer would promote alongside it. On a booting node that pass is not
// immediate, and a fleet-wide restart puts every holder of an app in the state at
// once. Same null-is-no-opinion convention appReconciler's controllerDesired uses.
let promotedFolderIds = null;

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
// appName -> the newest per-app stop id seen on the drain socket. Outlives the
// app's pipeline entry on purpose: once a stop's done has lifted the entry, a
// late message from that same stop must still read as old, and the entry it
// would compare against is gone.
const appLastStopIds = new Map();

// What each receive-only folder on this node holds that the cluster's index does not:
// folderId -> { bytes, newestModified }. Peers ask for it before promoting one of their
// own, so that the node with the data wins rather than the node with the lowest address.
// Null until the first monitor pass, for the same reason promotedFolderIds is: "I hold
// nothing" and "I have not looked" are opposite answers to a peer about to seed.
let folderHoldings = null;

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

  // Whether this node may act on the network policy: it holds a verified bundle AND has
  // established that no peer it can reach is ahead of it. Written only by policyStore,
  // which derives it from that pair.
  //
  // The distinction is the point: an unread policy and an empty one give every lookup the
  // same answer, and acting on it is how a node fills itself with apps it must not host
  // and then has them uninstalled from under it. Holding a bundle is not enough on its
  // own - one off disk is whatever this node last had, and the documents in it decide who
  // may host what.
  //
  // What waits on it is anything that would JUDGE an app - whether it may be hosted, run
  // or pulled here - and anything that would destroy one it then has to rebuild. A node
  // that cannot judge is not refusing a particular app; it is not yet in a position to
  // answer about any of them, which is a fact about the node and is what the caller needs
  // told. Nothing else waits: serving the API, keeping containers running and removing an
  // app outright all work without it.
  get policyReady() { return policyReadyGate.ready; },
  set policyReady(value) { if (value) policyReadyGate.open(); else policyReadyGate.close(); },
  waitForPolicyReady() { return policyReadyGate.wait(); },

  // Whether this node's ephemeral app-state store is worth another node's
  // survey: its own state sync completed, or it has spent the block timer
  // taking live broadcasts. NOT dbReady, which is about globalAppsInformation
  // and a different set of collections entirely.
  //
  // It lives here rather than being read off the orchestrator because the only
  // caller is the sync responder, and fluxCommunicationMessagesSender reaching
  // back into appSyncOrchestrator is a cycle. The orchestrator owns the value
  // and mirrors it; nothing else writes it.
  get appStateAuthoritative() { return appStateAuthoritative; },
  set appStateAuthoritative(value) { appStateAuthoritative = Boolean(value); },

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
  get promotedFolderIds() { return promotedFolderIds; },
  set promotedFolderIds(ids) { promotedFolderIds = ids; },
  get folderHoldings() { return folderHoldings; },
  set folderHoldings(map) { folderHoldings = map; },
  get syncthingDevicesIDCache() { return syncthingDevicesIDCache; },
  get folderHealthCache() { return folderHealthCache; },
  get runningAppsCache() { return runningAppsCache; },
  get departingApps() { return departingApps; },
  get announceCycle() { return announceCycle; },
  get fluxRemovedContainers() { return fluxRemovedContainers; },

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
   * Record an app's shutdown-pipeline state with an expiry. `stopId` names the
   * daemon's per-app stop the state belongs to; an entry without one (the
   * client's seed, made before the daemon answers; a node-wide pipeline's
   * message) keeps whatever id the app already carries.
   * @param {string} appName
   * @param {'draining'|'stopping'} state
   * @param {number} expiresAt epoch ms after which the entry no longer applies
   * @param {number|null} [stopId]
   */
  setAppShutdownPipelineState(appName, state, expiresAt, stopId = null) {
    const existing = appShutdownPipelineStates.get(appName);
    appShutdownPipelineStates.set(appName, { state, expiresAt, stopId: stopId ?? existing?.stopId ?? null });
  },

  /**
   * The stop id the app's current shutdown-pipeline entry carries, or null when
   * none, expired, or never named.
   * @param {string} appName
   * @returns {number|null}
   */
  getAppShutdownPipelineStopId(appName) {
    const entry = appShutdownPipelineStates.get(appName);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry.stopId ?? null;
  },

  /**
   * Remember the newest per-app stop id seen for an app; ids only ever rise.
   * @param {string} appName
   * @param {number} stopId
   */
  noteAppStopId(appName, stopId) {
    const last = appLastStopIds.get(appName);
    if (last === undefined || stopId > last) appLastStopIds.set(appName, stopId);
  },

  /**
   * The newest per-app stop id ever seen for an app, or null.
   * @param {string} appName
   * @returns {number|null}
   */
  getAppLastStopId(appName) {
    return appLastStopIds.get(appName) ?? null;
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
