'use strict';

// App Spawner - Handles automatic spawning of global applications
const config = require('config');
const serviceHelper = require('../serviceHelper');
const generalService = require('../generalService');
const nodeConfirmationService = require('../nodeConfirmationService');
const benchmarkService = require('../benchmarkService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
const nodeDosState = require('../nodeDosState');
const geolocationService = require('../geolocationService');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const log = require('../../lib/log');
const { normalizeSocketAddress, extractIp, extractPort, socketAddressesMatch } = require('../utils/socketAddressUtils');
const { compareInstallingClaims, describeRanking } = require('../utils/instanceOrdering');

// Import modular services

// What this node last concluded about each app: the stage that removed it from
// the candidate list, or 'candidate' when it survived to the draw.
//
// Kept so the verdict can be published on CHANGE ONLY. "This pass passed over
// that app" is true every pass for every app the fleet already covers - it is a
// fact about the clock, and fluxEventBus says plainly that a cadence is a
// counter, not an event. What actually happens, rarely, is a verdict FLIPPING:
// an app this node was excluded from becoming one it may take again, which is
// the thing a caller wants to know and the thing no log line makes assertable.
const lastCandidacy = new Map();

/**
 * Which stage removed each app, from the survivor snapshots taken through the
 * filter chain, and publish only the ones whose answer changed since last pass.
 *
 * @param {Array<[string, Set<string>]>} stages Ordered [stageName, names still in].
 */
function publishCandidacyChanges(stages) {
  if (!stages.length) return;
  const [, initial] = stages[0];
  const verdicts = new Map();
  for (const name of initial) {
    let stage = 'candidate';
    for (let i = 1; i < stages.length; i += 1) {
      if (!stages[i][1].has(name)) { stage = stages[i][0]; break; }
    }
    verdicts.set(name, stage);
  }
  for (const [name, stage] of verdicts) {
    if (lastCandidacy.get(name) === stage) continue;
    lastCandidacy.set(name, stage);
    fluxEventBus.publish('spawner:candidacy', { name, stage, candidate: stage === 'candidate' });
  }
  for (const name of [...lastCandidacy.keys()]) {
    if (!verdicts.has(name)) lastCandidacy.delete(name);
  }
}
const resourceQueryService = require('../appQuery/resourceQueryService');
const messageStore = require('../appMessaging/messageStore');
const registryManager = require('../appDatabase/registryManager');
const appsRepository = require('../appDatabase/appsRepository');
const nodeDownStore = require('../appMessaging/nodeDownStore');
const imageManager = require('../appSecurity/imageManager');
const hwRequirements = require('../appRequirements/hwRequirements');
const portManager = require('../appNetwork/portManager');
const placementFeasibility = require('../appPlacement/placementFeasibility');
const { getSpecBackend } = require('../utils/specLibs');
const { ensureProvidersRegistered } = require('../utils/specCutover');
const { appsFolder, INSTALLING_RENEWAL_MS } = require('../utils/appConstants');
const globalState = require('../utils/globalState');
const operationRegistry = require('../utils/operationRegistry');

// The node-wide app operations the spawner gives way to - the same set
// appOperations and syncthingMonitor stand down for. Per-app leases like
// 'backup' and 'stopping' are not on it: they hold one app, not the node.
const NODE_WIDE_OPERATIONS = ['install', 'remove', 'redeploy', 'rebuild', 'reconcile'];
const enterpriseNetwork = require('../utils/enterpriseNetwork');
const { FluxCacheManager } = require('../utils/cacheManager');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const appInstaller = require('./appInstaller');
const specReconciler = require('./specReconciler');
const relationshipResolver = require('./relationshipResolver');
const { NodeCondition } = require('./nodeConditions');
const pendingTeardownStore = require('./pendingTeardownStore');
const { appSyncEvents, EVENTS: SYNC_EVENTS } = require('../utils/appSyncEvents');
const fluxEventBus = require('../utils/fluxEventBus');

let appsCountAvailableToInstallOnMyNode = 0;

const collisionWaitMs = config.fluxapps.installCollisionWaitMs;
const { spawnReconfirmDelayMs } = config.fluxapps;
const unencryptedSpawnDelayMs = config.fluxapps.unencryptedSpawnDelayMs ?? 2 * 60 * 1000;

let spawnLoopRunning = false;

// Last node socket address resolved by a spawn cycle. Cached at module scope so
// notifySpecStored - which runs outside a spawn cycle, from the spec-store path -
// can do the pinned-to-this-node check without re-querying benchmark.
let lastKnownLocalSocketAddr = null;

// One-shot resolver for the inter-cycle idle delay. Set only while the loop is
// parked in that delay; calling it ends the delay early. Null at every other time,
// so a wake outside the idle window is a harmless no-op.
let idleWakeResolve = null;

// One-bit latch for a wake that arrives while the loop is mid-cycle (idleWakeResolve
// null): wakeIdleLoop sets it instead of dropping the signal, and spawnLoop checks +
// clears it before the next idle delay so the wake is honored on the next park rather
// than lost. Single-threaded event loop, so no race.
let wakePending = false;

/**
 * Number of nodes a spec pins via the placement model (IP / outpoint / operator
 * targeting maps) - the v9 successor to the flat v8 `nodes` IP list. Summing the
 * three maps' entry counts can over-count when one physical node is pinned by two
 * identifiers (e.g. IP and outpoint); that is conservative - it only ever demotes
 * a true sole-installer to "contended" (losing the fast path), never the reverse,
 * so it cannot cause an instance overshoot.
 * @param {object} placement - the spec's Placement
 * @returns {number}
 */
// Election order for installing-claim rows: claim time first - announcedAt
// where present (immutable under v2 renewals), broadcastedAt for rows from v1
// peers (which never move either) - then row identity (ip, replica). Every
// contender reads its seat off this ranking, so it must be a total order
// every node computes identically regardless of its own row return order;
// wake-synchronized contenders make equal claim times the normal case.
function compareClaimRows(a, b) {
  const aClaimedAt = a.announcedAt ?? a.broadcastedAt;
  const bClaimedAt = b.announcedAt ?? b.broadcastedAt;
  if (aClaimedAt < bClaimedAt) {
    return -1;
  }
  if (aClaimedAt > bClaimedAt) {
    return 1;
  }
  const aIdentity = `${a.ip ?? ''}|${a.replica ?? ''}`;
  const bIdentity = `${b.ip ?? ''}|${b.replica ?? ''}`;
  if (aIdentity < bIdentity) {
    return -1;
  }
  if (aIdentity > bIdentity) {
    return 1;
  }
  return 0;
}

function placementPinCount(placement) {
  if (!placement) return 0;
  return placement.targetIps.length
    + placement.targetOutpoints.length
    + placement.targetOperators.length;
}

/**
 * A node-pinned app whose pin set is no larger than its required instance count has
 * no installation contention: every pinned node is a mandatory installer, so the
 * collision-avoidance election (and the two propagation waits that feed it - the
 * pre-install collision wait and the post-install over-instance self-evict) has
 * nothing to resolve. Owner- and flag-agnostic; provably safe because no overshoot
 * is possible when eligible installers do not exceed required instances.
 * @param {object} placement - the spec's Placement (carries the pin targets)
 * @param {number} minInstances - required instance count for the app
 * @returns {boolean}
 */
function isSoleRequiredInstaller(placement, minInstances) {
  const pinCount = placementPinCount(placement);
  return pinCount > 0 && pinCount <= minInstances;
}

/**
 * A node-pinned app whose pin set is LARGER than its required instance count has genuine multi-node
 * install contention: more nodes are eligible installers than instances are needed, so a collision-
 * avoidance election must pick the winner(s). Unlike a non-pinned app (open contention), the
 * eligible set is a known, bounded list - which lets such an app run its collision window OFF the
 * serial spawn loop (deferred) instead of via an inline wait that head-of-line-blocks every app
 * queued behind it.
 * @param {object} placement - the spec's Placement (carries the pin targets)
 * @param {number} minInstances - required instance count for the app
 * @returns {boolean}
 */
function isPinnedContended(placement, minInstances) {
  const pinCount = placementPinCount(placement);
  return pinCount > 0 && pinCount > minInstances;
}

function initialize() {
  appSyncEvents.on(SYNC_EVENTS.SPAWNER_READY, () => {
    log.info('AppSyncOrchestrator signals ready, starting spawn loop');
    globalState.spawnerPaused = false;
    fluxEventBus.publish('spawner:resumed', {});
    if (!spawnLoopRunning) {
      spawnLoop();
    }
  });
  appSyncEvents.on(SYNC_EVENTS.READINESS_LOST, () => {
    log.warn('AppSyncOrchestrator signals readiness lost, spawner will pause on next iteration');
    globalState.spawnerPaused = true;
    fluxEventBus.publish('spawner:paused', {});
  });
}

async function spawnLoop() {
  spawnLoopRunning = true;
  // Start each loop incarnation with a clean latch so a wake latched while paused never
  // skips the first cycle's delay after a SPAWNER_READY restart - the latch stays strictly
  // intra-run.
  wakePending = false;
  try {
    // Crypto providers are otherwise registered lazily by the first
    // specCutover call; the first spawn cycle can beat that and fail an
    // encrypted app's createProvider into the spawn caches.
    await ensureProvidersRegistered();
    while (!globalState.spawnerPaused) {
      const delayMs = await trySpawningGlobalApplication();
      // A wake that fired while we were mid-cycle (idleWakeResolve null) latched wakePending
      // instead of being dropped; honor it now by skipping this idle delay so a sibling
      // pinned-enterprise spec stored during the cycle is picked up immediately. Checked +
      // cleared in exactly this one place.
      if (wakePending) {
        wakePending = false;
        // eslint-disable-next-line no-continue
        continue;
      }
      // Race the inter-cycle delay against a one-shot wake so a spec this node must
      // install, landing mid-delay, is picked up now instead of on the next poll tick.
      // serviceHelper.delay still runs every idle iteration; the wake stays pending
      // (inert) unless notifySpecStored fires.
      if (delayMs > 0) {
        const wake = new Promise((resolve) => { idleWakeResolve = resolve; });
        try {
          await Promise.race([serviceHelper.delay(delayMs), wake]);
        } finally {
          idleWakeResolve = null;
        }
      }
    }
  } finally {
    spawnLoopRunning = false;
    log.info('Spawn loop exited (paused)');
  }
}

// Note: Docker Hub error classification and caching is now handled by imageManager.js
// which uses structured error metadata from imageVerifier.js for accurate classification
// This spawner cache serves as an additional layer to prevent repeated spawn attempts

/**
 * Periodically renew this node's fluxappinstalling claim while an install is in
 * flight, so a legitimately slow install (multi-component image pulls routinely
 * outlive INSTALLING_EXPIRY_MS) keeps its seat on the fleet. The renewal is the
 * same v2 message with a fresh broadcastedAt; announcedAt never moves, so election
 * ordering is unaffected. v2-capable peers refresh their row; v1 peers reject the
 * message and keep today's TTL behavior.
 * @param {string} name - app name
 * @param {string} ip - this node's socket address
 * @param {number} announcedAt - the claim's original announce timestamp (ms)
 * @param {Array<string|null>} replicas - the identities whose claims to renew:
 *   replica names for named placement, [null] for the single loose claim
 * @returns {NodeJS.Timeout} interval handle; caller must clearInterval it
 */
function startInstallingRenewal(name, ip, announcedAt, replicas) {
  const timer = setInterval(() => {
    for (const replica of replicas) {
      const renewal = {
        type: 'fluxappinstalling',
        version: 2,
        name,
        ip,
        ...(replica != null ? { replica } : {}),
        announcedAt,
        broadcastedAt: Date.now(),
      };
      registryManager.storeAppInstallingMessage(renewal)
        .then(() => fluxCommunicationMessagesSender.broadcastMessageToAll(renewal, { requireCapability: 'appInstallingClaims' }))
        .catch((e) => log.error(`installing renewal for ${name} failed: ${e.message}`));
    }
  }, INSTALLING_RENEWAL_MS);
  timer.unref();
  return timer;
}

/**
 * Retract this node's fluxappinstalling claim fleet-wide with no verdict on the app.
 * This is the counterpart of fluxappinstallingerror for the paths that deliberately
 * suppress it (concurrent cancel/removal, transient defer): peers must release the
 * seat immediately instead of counting a phantom install until the TTL, but must not
 * count an app failure. v1 peers reject the message and fall back to the TTL.
 *
 * Spelled `withdrawn`, not `cleared`, and sent to EVERY peer rather than only the
 * appInstallingClaims-capable ones. The capability gate belongs on the CLAIM, which
 * only a capable peer can interpret; a retraction has to reach everyone holding the
 * row, or an 8.18.0 peer keeps the seat reserved until the TTL - which is the exact
 * lingering-reservation this commit exists to end. `withdrawn` is development's
 * spelling and is what is already on the wire; the store accepts both.
 *
 * Stored locally first, so this node's own row goes with the broadcast.
 * @param {string} name - app name
 * @param {string} ip - this node's socket address
 * @param {string|null} [replica] - release exactly this identity's seat; null
 *   (loose) emits the untagged clear, which releases every (name, ip) row
 * @returns {Promise<void>}
 */
async function broadcastInstallingCleared(name, ip, replica = null) {
  const message = {
    type: 'fluxappinstalling',
    version: 2,
    name,
    ip,
    ...(replica != null ? { replica } : {}),
    // development's spelling of the retraction: it shipped in 8.18.0 and is what
    // is on the wire today (F15 / stop 153). The store accepts `cleared` too.
    withdrawn: true,
    broadcastedAt: Date.now(),
  };
  await messageStore.storeAppInstallingMessage(message);
  await fluxCommunicationMessagesSender.broadcastMessageToAll(message);
}

/**
 * Try spawning a global application that needs more instances
 * This is the main function that continuously checks for applications that need more instances
 * and attempts to spawn them on this node if it meets the requirements
 * @returns {Promise<void>}
 */
async function trySpawningGlobalApplication() {
  const installDelay = config.fluxapps.installation.delay * 1000;
  // Acquisition waits on the network policy the way it waits on the database. Until the
  // node->owners map has been obtained this node cannot tell "I am not an enterprise node"
  // from "I do not know yet", and the two demand opposite behaviour: the first may take
  // any app going, the second must take none. Guessing the first is how an enterprise node
  // fills with apps it must not host and has them removed from under it minutes later.
  if (!globalState.policyReady) {
    log.info('Network policy not yet obtained. Global applications will not be installed');
    fluxEventBus.publish('spawner:blocked', { reason: 'policy_not_ready' });
    return installDelay;
  }
  const isEnterpriseNode = enterpriseNetwork.getCachedEnterpriseIdentity();
  if (isEnterpriseNode === null) {
    log.info('Flux enterprise identity not yet resolved');
    fluxEventBus.publish('spawner:blocked', { reason: 'enterprise_unresolved' });
    return installDelay;
  }
  let { shortDelayTime, delayTime } = enterpriseNetwork.getSpawnDelays(isEnterpriseNode, 0);
  let appHash = null;
  // The spawn throttle and the node's own fluxappinstalling record are two "I'm
  // taking this app" marks. They must be unwound on any exit that neither
  // deliberately backed off (throttleIntended - a real retry-later delay) nor
  // actually installed (installSucceeded). The finally enforces that by
  // construction, so no bail path can strand the throttle (a 12h node-local
  // lockout) or leave a stale installing record that self-locks the next cycle.
  let throttleIntended = false;
  let installSucceeded = false;
  // { name, ip, replicas } once the installing record(s) are stored: one claim row
  // per assigned identity - replica names for named placement, [null] for loose.
  let installingRecordKey = null;
  // A pinned-contended first pass parks its attempt on appsToBeCheckedLater with the
  // claim deliberately left standing (the claim IS the election entry); the finally
  // must not retract or clear it. The second pass re-adopts the claim and drops this.
  let collisionClaimHeld = false;
  let renewalTimer = null;
  try {
    const synced = await generalService.checkSynced();
    if (synced !== true) {
      log.info('Flux not yet synced');
      fluxEventBus.publish('spawner:blocked', { reason: 'not_synced' });
      return installDelay;
    }

    if (!globalState.dbReady) {
      log.info('DB not yet ready, waiting for orchestrator');
      fluxEventBus.publish('spawner:blocked', { reason: 'db_not_ready' });
      return installDelay;
    }

    if (nodeDosState.isNodeDos()) {
      log.info('Node is in DOS state. Global applications will not be installed');
      fluxEventBus.publish('spawner:blocked', { reason: 'dos' });
      return installDelay;
    }

    if (fluxNetworkHelper.isPlacementHeld()) {
      log.info(`Node held back from new placements (${fluxNetworkHelper.getPlacementHold()}). Global applications will not be installed`);
      fluxEventBus.publish('spawner:blocked', { reason: 'placement_hold' });
      return installDelay;
    }

    if (!nodeConfirmationService.isConfirmed()) {
      log.info('Flux Node not Confirmed. Global applications will not be installed');
      fluxEventBus.publish('spawner:blocked', { reason: 'not_confirmed' });
      globalState.fluxNodeWasNotConfirmedOnLastCheck = true;
      return installDelay;
    }

    if (globalState.fluxNodeWasAlreadyConfirmed && globalState.fluxNodeWasNotConfirmedOnLastCheck) {
      globalState.fluxNodeWasNotConfirmedOnLastCheck = false;
      return spawnReconfirmDelayMs;
    }
    globalState.fluxNodeWasAlreadyConfirmed = true;

    const benchmarkResponse = await benchmarkService.getBenchmarks();
    if (benchmarkResponse.status === 'error') {
      log.info('FluxBench status Error. Global applications will not be installed');
      return installDelay;
    }
    // get my external IP and check that it is longer than 5 in length.
    let localSocketAddr = null;
    if (benchmarkResponse.data.ipaddress) {
      log.info(`Gathered IP ${benchmarkResponse.data.ipaddress}`);
      localSocketAddr = benchmarkResponse.data.ipaddress.length > 5 ? normalizeSocketAddress(benchmarkResponse.data.ipaddress) : null;
    }
    if (localSocketAddr === null) {
      throw new Error('Unable to detect Flux IP address');
    }
    lastKnownLocalSocketAddr = localSocketAddr;

    // Our address without the port, derived once. It was being recomputed in
    // four places under three different names, so nothing told a reader they
    // were the same value.
    const localIp = extractIp(localSocketAddr);

    // Under a placement freeze — two certifications standing — this node
    // places nothing until the rows age out. The flapper's operator pays, not
    // the fleet. Nothing else changes for it.
    const freeze = await nodeDownStore.placementFreezeForAddress(localSocketAddr);
    if (freeze.frozen) {
      log.info(`trySpawningGlobalApplication - Node is under placement freeze (${freeze.count} certifications standing). Global applications will not be installed`);
      fluxEventBus.publish('spawner:blocked', { reason: 'placementFrozen', count: freeze.count, liftsAt: freeze.liftsAt });
      return installDelay;
    }

    // Capacity + the already-present filter both count INSTALLED apps (the DB), not
    // running containers. Post-flip a just-installed app is briefly Docker 'created'
    // (not running), and an app is one-or-more containers, so "installed" is the clean
    // per-app unit: a running-container count over-counts multi-component apps and
    // miscounts during the install->settle window.
    const installedApps = await appsRepository.listInstalledApps();
    if (installedApps.length >= config.fluxapps.maxAppsPerNode) {
      log.info(`trySpawningGlobalApplication - Node at max apps capacity (${installedApps.length}/${config.fluxapps.maxAppsPerNode})`);
      return delayTime;
    }

    const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
    const currentHeight = syncStatus.data.height;
    const nowSeconds = Math.floor(Date.now() / 1000);

    log.info('trySpawningGlobalApplication - Checking for apps that are missing instances on the network.');
    let globalAppNamesLocation = await appsRepository.findUnderProvisionedApps(currentHeight, nowSeconds);
    const numberOfGlobalApps = globalAppNamesLocation.length;
    // A due deferred entry must be processed even when nothing is missing instances:
    // a parked contender's app can reach target while it waits, and only its second
    // pass (the over-instance election below) retracts + clears its standing claim.
    // Bailing here would strand that claim until the TTL - a phantom seat that
    // suppresses a legitimate respawn if a winner dies inside the window.
    const { appsToBeCheckedLater, appsSyncthingToBeCheckedLater } = globalState;
    const appIndex = appsToBeCheckedLater.findIndex((app) => app.timeToCheck <= Date.now());
    const appSyncthingIndex = appsSyncthingToBeCheckedLater.findIndex((app) => app.timeToCheck <= Date.now());
    if (!numberOfGlobalApps && appIndex < 0 && appSyncthingIndex < 0) {
      log.info('trySpawningGlobalApplication - No installable application found');
      return delayTime;
    }
    log.info(`trySpawningGlobalApplication - Found ${numberOfGlobalApps} apps that are missing instances on the network.`);

    let appToRun = null;
    let selectedCandidate = null;
    let minInstances = null;
    let appFromAppsToBeCheckedLater = false;
    let appFromAppsSyncthingToBeCheckedLater = false;
    // True when a contended app is pulled back off appsToBeCheckedLater after its collision window
    // elapsed off-loop: it already broadcast its installing message on the first pass, so it skips
    // the broadcast + collision wait and goes straight to the over-instance election + install.
    let collisionWindowElapsed = false;
    // The first pass's announce timestamp and claimed identities, carried through
    // the deferred entry so the second pass renews and retracts the claims that
    // actually exist, under their original election ordering.
    let deferredAnnouncedAt = null;
    let deferredReplicas = null;
    const collateral = await generalService.obtainNodeCollateralInformation();
    const nodeOutpoint = `${collateral.txhash}:${collateral.txindex}`;
    const nodeOperator = fluxNetworkHelper.getFluxNodePublicKey();
    const targetInfo = {
      ip: localSocketAddr,
      outpoint: nodeOutpoint,
      operator: typeof nodeOperator === 'string' ? nodeOperator : undefined,
      ipMatcher: socketAddressesMatch,
    };
    let runningAppList = [];
    let installingAppList = [];

    if (appIndex >= 0) {
      appToRun = appsToBeCheckedLater[appIndex].appName;
      appHash = appsToBeCheckedLater[appIndex].hash;
      minInstances = appsToBeCheckedLater[appIndex].required;
      collisionWindowElapsed = appsToBeCheckedLater[appIndex].collisionDeferred === true;
      deferredAnnouncedAt = appsToBeCheckedLater[appIndex].announcedAt ?? null;
      deferredReplicas = appsToBeCheckedLater[appIndex].replicas ?? null;
      appsToBeCheckedLater.splice(appIndex, 1);
      appFromAppsToBeCheckedLater = true;
      appsCountAvailableToInstallOnMyNode = Math.max(0, appsCountAvailableToInstallOnMyNode - 1);
      // A collision entry owns standing claims (announced on its first pass). Adopt
      // them at pop time, not after the announce block: from here on, EVERY exit that
      // does not install must retract + clear them via the finally, including throws -
      // the entry is already spliced, so a leak here would stand until the TTL.
      if (collisionWindowElapsed) {
        installingRecordKey = { name: appToRun, ip: localSocketAddr, replicas: deferredReplicas ?? [null] };
      }
    } else if (appSyncthingIndex >= 0) {
      appToRun = appsSyncthingToBeCheckedLater[appSyncthingIndex].appName;
      appHash = appsSyncthingToBeCheckedLater[appSyncthingIndex].hash;
      minInstances = appsSyncthingToBeCheckedLater[appSyncthingIndex].required;
      appsSyncthingToBeCheckedLater.splice(appSyncthingIndex, 1);
      appFromAppsSyncthingToBeCheckedLater = true;
      appsCountAvailableToInstallOnMyNode = Math.max(0, appsCountAvailableToInstallOnMyNode - 1);
    } else {
      const placementLocation = await geolocationService.getPlacementLocation();
      const nodeInfo = {
        hasStaticIp: geolocationService.isStaticIP(),
        isDataCenter: geolocationService.isDataCenter(),
        location: placementLocation ?? undefined,
      };
      // Where the candidates went. Every filter below removes apps for a
      // different and entirely reasonable reason, and none of them says so - the
      // pass ends with "No app currently to be processed" whether one filter
      // dropped everything or five each took a share. From outside the process
      // that is indistinguishable from an app nobody wanted, which is how a port
      // collision looked like a placement failure for a whole day.
      const survivors = { found: globalAppNamesLocation.length };
      const nameSet = () => new Set(globalAppNamesLocation.map((c) => c.instantiated.name));
      const stages = [['found', nameSet()]];

      // Being installed here does not mean this node owes nothing: a node
      // already running one replica can be assigned another, and dropping the
      // candidate by app name would refuse that seat forever — the spec would
      // keep naming an identity nothing ever provisions. Resolve identities only
      // for candidates that ARE installed; the rest never needed the question.
      const installedNames = new Set(installedApps.map((a) => a.name));
      const owesAnIdentity = new Map();
      for (const candidate of globalAppNamesLocation) {
        const { instantiated } = candidate;
        if (!installedNames.has(instantiated.name)) continue;
        // eslint-disable-next-line no-await-in-loop
        const assigned = await deploymentProvider.assignedIdentities(instantiated);
        // eslint-disable-next-line no-await-in-loop
        const installed = new Set(await appsRepository.listInstalledIdentities(instantiated.name));
        owesAnIdentity.set(instantiated.name, !assigned.every((identity) => installed.has(identity ?? null)));
      }
      globalAppNamesLocation = globalAppNamesLocation.filter((c) => (
        (!installedNames.has(c.instantiated.name) || owesAnIdentity.get(c.instantiated.name))
        && !globalState.spawnErrorsLongerAppCache.has(c.instantiated.hash)
        && !globalState.trySpawningGlobalAppCache.has(c.instantiated.hash)
        && !appsToBeCheckedLater.some((appAux) => appAux.appName === c.instantiated.name)));
      survivors.afterAlreadyHeldOrTried = globalAppNamesLocation.length;
      stages.push(['afterAlreadyHeldOrTried', nameSet()]);
      globalAppNamesLocation = globalAppNamesLocation.filter((c) => {
        try {
          return c.instantiated.spec.placement.matches(nodeInfo);
        } catch (error) {
          // Per app, not per pass. A legacy spec whose region name the location
          // table cannot resolve refuses the geo question rather than widening
          // the pin to its whole country, and an unguarded throw here would
          // leave the whole filter — and so this entire spawn cycle, for every
          // app — abandoned by one unreadable spec. Not spawning the app whose
          // placement cannot be decided is the answer; not spawning anything is
          // not. The node retries each cycle, and recovers by itself once the
          // table arrives.
          log.warn(`trySpawningGlobalApplication - cannot decide placement for ${c.instantiated.name}, skipping it this cycle: ${error.message}`);
          return false;
        }
      });
      survivors.afterGeolocation = globalAppNamesLocation.length;
      stages.push(['afterGeolocation', nameSet()]);
      globalAppNamesLocation = globalAppNamesLocation.filter((c) => {
        const { owner } = c.instantiated;
        const isEnterpriseOwner = enterpriseNetwork.isEnterpriseAppOwner(owner);
        const eligible = isEnterpriseNode ? isEnterpriseOwner : !isEnterpriseOwner;
        return eligible;
      });
      survivors.afterOwnership = globalAppNamesLocation.length;
      stages.push(['afterOwnership', nameSet()]);
      // Enterprise-owned apps that pin nodes (IP / outpoint / operator targets) are strict:
      // only a matching node may install them, regardless of version. Carries the legacy
      // app.nodes enforcement forward into the v9 placement model.
      globalAppNamesLocation = globalAppNamesLocation.filter((c) => {
        const { placement } = c.instantiated.spec;
        if (placement.hasTargets() && enterpriseNetwork.isEnterpriseAppOwner(c.instantiated.owner)) {
          return placement.matchesTarget({
            ip: localSocketAddr,
            ipMatcher: socketAddressesMatch,
            outpoint: nodeOutpoint,
            operator: nodeOperator,
          });
        }
        return true;
      });
      survivors.afterNodePin = globalAppNamesLocation.length;
      stages.push(['afterNodePin', nameSet()]);

      // Drop candidates whose remaining slots are already claimed, before one is
      // picked at random. The sieve counts running instances only, so an app that
      // other nodes are already installing still reads as short - and selection
      // is a lottery, so such a candidate does not merely waste its own cycle:
      // it can win the draw ahead of one this node could have installed, and the
      // node then spawns nothing for a whole pass. Counting every candidate's
      // claims costs one grouped read of a collection that holds only live
      // claims. The re-read before claiming still runs and is the authority;
      // this only spares the draw candidates it would have turned away.
      // An app kept above because this node still owes an assigned identity is
      // exempt: nobody else can fill that seat, whatever the global count says.
      const claimsByApp = await registryManager.installingCountsByApp();
      globalAppNamesLocation = globalAppNamesLocation.filter(
        (c) => owesAnIdentity.get(c.instantiated.name)
          || c.actual + (claimsByApp.get(c.instantiated.name.toLowerCase()) ?? 0) < c.required,
      );

      // Whether a candidate is PINNED to this node, decided from cleartext
      // placement metadata — readable on a sealed spec, so knowing this costs
      // nothing and can be established before deciding whether to decrypt
      // anything. The same three predicates build the selection tiers below, so
      // "pinned here" means exactly one thing in both places.
      const placementOf = (c) => c.instantiated.spec.placement;
      const targetsThisNodeByIp = (c) => placementOf(c).targetIps.length > 0
        && placementOf(c).matchesTarget({ ip: localSocketAddr, ipMatcher: socketAddressesMatch });
      const targetsThisNodeByOutpoint = (c) => placementOf(c).targetOutpoints.length > 0
        && placementOf(c).matchesTarget({ outpoint: nodeOutpoint });
      const targetsThisNodeByOperator = (c) => placementOf(c).targetOperators.length > 0
        && placementOf(c).matchesTarget({ operator: nodeOperator });
      const targetsThisNode = (c) => targetsThisNodeByIp(c)
        || targetsThisNodeByOutpoint(c)
        || targetsThisNodeByOperator(c);
      const pinnedHere = new Set(
        globalAppNamesLocation.filter(targetsThisNode).map((c) => c.instantiated.name),
      );

      // Suppress pure-follower apps (activation.standalone false — shared
      // collectors) that no app assigned to this node requires: they only
      // install while a workload here declares a dependency edge to them, and
      // must not be respawned after a teardown. Best-effort: on a
      // registry-read failure, fall back to not suppressing rather than
      // aborting. Gated off in production: the flux console owns the
      // collector lifecycle.
      if (config.fluxapps.manageCollectorLifecycle) {
        try {
          const requiredDependencyNames = await relationshipResolver.getRequiredDependencyNamesForNode({
            ip: localSocketAddr, outpoint: nodeOutpoint, operator: nodeOperator,
          });
          // Resolved in one pass up front: reading activation means resolving
          // each candidate's spec, which a synchronous filter cannot do. Only
          // the pinned candidates are decrypted — same rule as the readiness
          // filter below. Everything else is read sealed, which still answers
          // fully for a cleartext app; an encrypted app in the general pool
          // keeps its activation sealed and is treated as standalone.
          const followerNames = await relationshipResolver.pureFollowerNames(
            globalAppNamesLocation.map((c) => c.instantiated),
            (app) => pinnedHere.has(app.name),
          );
          globalAppNamesLocation = globalAppNamesLocation.filter((c) => !followerNames.has(c.instantiated.name)
            || requiredDependencyNames.has(c.instantiated.name));
        } catch (error) {
          log.error(`trySpawningGlobalApplication - could not compute required dependencies, not suppressing collectors this cycle: ${error.message}`);
        }
      }

      // Drop candidates this node has no room for, before one is picked at
      // random. Selection is a lottery over the surviving pool, so a candidate
      // that cannot fit does not merely waste its own cycle — it can win the
      // draw ahead of one that would have installed, and the node spawns
      // nothing. The capacity check at install time still runs; it is the
      // authority, and this only spares it candidates it would have rejected.
      //
      // Cleartext totals make this affordable for encrypted apps too: the
      // summary is exactly what a node reads to judge fitness while sealed, so
      // no candidate is decrypted to be screened. An app that cannot answer
      // (a v8 encrypted spec, whose format carries no summary) is kept — the
      // install-time gate decides it, which is the pre-existing behaviour.
      if (globalAppNamesLocation.length > 0) {
        try {
          // Read as though reclaimable reservations were not held, because this
          // screen decides what the install-time gate ever SEES. A candidate that
          // a playground session is the only obstacle to would be filtered out
          // here and never reach the one place that can ask for that capacity
          // back - the screen would quietly defeat the eviction it precedes.
          const capacity = await hwRequirements.nodeCapacity({ ignoreReclaimable: true });
          globalAppNamesLocation = globalAppNamesLocation.filter((c) => {
            let totals;
            try {
              totals = c.instantiated.resourceTotals();
            } catch (error) {
              // A spec whose resources cannot be computed at all (a malformed
              // legacy containerData reaches this) must not take down the sweep
              // for every other candidate.
              log.warn(`trySpawningGlobalApplication - could not size ${c.instantiated.name}, leaving it to the install-time check: ${error.message}`);
              return true;
            }
            if (!totals) return true;
            const shortfall = hwRequirements.capacityShortfall(capacity, totals)
              || hwRequirements.burstHeadroomShortfall(capacity, totals);
            if (shortfall) {
              log.info(`trySpawningGlobalApplication - Skipping ${c.instantiated.name} this cycle: ${shortfall}`);
              return false;
            }
            return true;
          });
        } catch (error) {
          // Capacity unreadable this cycle — screen nothing rather than
          // everything, and let the install-time check hold the line.
          log.warn(`trySpawningGlobalApplication - could not read node capacity, skipping the resource screen: ${error.message}`);
        }
      }

      // Readiness-ordered selection: drop candidates whose dependencies are
      // not ready, so a linked group installs root-first (a dependency before
      // its consumers) instead of a consumer being selected first and deferring
      // its install. A not-ready app is simply skipped this cycle and reconsidered
      // once its deps come up — no deferral-queue entry and no error cache, so it
      // installs the moment its dependency appears (even one registered later).
      if (globalAppNamesLocation.length > 0) {
        const readiness = await Promise.all(globalAppNamesLocation.map(async (c) => {
          // Never re-select an app that is mid-teardown: its containers/ports are
          // still draining, so re-selecting would race the removal (the port probe
          // hits the draining docker-proxy and reads the port as busy). Reconsidered
          // once the teardown clears.
          if (await pendingTeardownStore.teardownOwedFor(c.instantiated.name)) {
            return false;
          }
          try {
            // A pinned app WILL be installed by this node, so reading its links
            // through the decrypted view is the same decrypt the install performs
            // moments later, moved a few lines earlier — and it is what lets a
            // pinned consumer be held back until its dependency lands, instead of
            // monopolising its targeting tier while it defers.
            //
            // The general pool is the opposite case: many candidates, at most one
            // install, so its links stay sealed. That is what the cleartext
            // placement metadata is for. An encrypted app there reports no links
            // and is treated as ready; the install-time gate does the real check.
            await (targetsThisNode(c)
              ? relationshipResolver.checkAppDependencyRequirements(c.instantiated)
              : relationshipResolver.dependenciesReadyForSelection(c.instantiated));
            return true;
          } catch (error) {
            // Dependency not ready yet -> skip this cycle. Any other error (e.g.
            // owner mismatch) is a real misconfig handled at install.
            return error.code !== NodeCondition.NETWORK_DEPENDENCY_NOT_READY;
          }
        }));
        globalAppNamesLocation = globalAppNamesLocation.filter((_, index) => readiness[index]);
      }

      appsCountAvailableToInstallOnMyNode = globalAppNamesLocation.length + appsSyncthingToBeCheckedLater.length + appsToBeCheckedLater.length;
      ({ shortDelayTime, delayTime } = enterpriseNetwork.getSpawnDelays(isEnterpriseNode, appsCountAvailableToInstallOnMyNode));


      publishCandidacyChanges(stages);

      if (globalAppNamesLocation.length === 0) {
        log.info(`trySpawningGlobalApplication - No app currently to be processed (${JSON.stringify(survivors)})`);
        // A TALLY, not a stream. This is true on every pass of a fleet whose apps
        // are all at their instance count - roughly every 240ms per node under
        // the harness multiplier - and as an event it spent a ring every other
        // consumer shares, which is why nothing could afford to subscribe to it.
        // The breakdown stays in the log line above, and what CHANGED went out as
        // spawner:candidacy.
        fluxEventBus.count('spawner:noCandidates');
        return delayTime;
      }
      log.info(`trySpawningGlobalApplication - Found ${globalAppNamesLocation.length} apps that are missing instances on the network and can be selected to try to spawn on my node.`);

      const ipTargeted = globalAppNamesLocation.filter(targetsThisNodeByIp);
      const outpointTargeted = globalAppNamesLocation.filter(targetsThisNodeByOutpoint);
      const operatorTargeted = globalAppNamesLocation.filter(targetsThisNodeByOperator);

      const pool = ipTargeted.length > 0 ? ipTargeted
        : outpointTargeted.length > 0 ? outpointTargeted
        : operatorTargeted.length > 0 ? operatorTargeted
        : globalAppNamesLocation;

      selectedCandidate = pool[Math.floor(Math.random() * pool.length)];

      appToRun = selectedCandidate.instantiated.name;
      appHash = selectedCandidate.instantiated.hash;
      minInstances = selectedCandidate.required;

      log.info(`trySpawningGlobalApplication - Application ${appToRun} selected to try to spawn. Reported as been running in ${selectedCandidate.actual} instances and ${selectedCandidate.required} are required.`);
      runningAppList = await registryManager.appLocation(appToRun);
      installingAppList = await registryManager.appInstallingLocation(appToRun);
      if (runningAppList.length + installingAppList.length >= minInstances) {
        log.info(`trySpawningGlobalApplication - Application ${appToRun} is already spawned or being installed on ${runningAppList.length + installingAppList.length} instances.`);
        return shortDelayTime;
      }
      // Apps whose spec demands Arcane — an encrypted envelope, or any
      // Arcane-requiring feature (telemetry, content delivery, graceful
      // shutdown, preStop) — can only install on an attested ArcaneOS node.
      // The verdict is resolved before this runs, so a non-arcane verdict is
      // definitive: refuse and remember (long-error cache).
      if (selectedCandidate.instantiated.requiresArcane() && !globalState.isArcane()) {
        log.info(`trySpawningGlobalApplication - Application ${appToRun} requires ArcaneOS; refusing on this node`);
        globalState.spawnErrorsLongerAppCache.set(appHash, '');
        return shortDelayTime;
      }
    }

    log.info(`trySpawningGlobalApplication - App ${appToRun} hash: ${appHash}`);

    // Only permanent verdicts on the image are broadcast (transient registry
    // failures defer locally and never store an error), so five distinct nodes
    // reporting inside the 24h error expiry means the app itself is broken -
    // skip the install trial this cycle rather than burn one rediscovering it.
    // Self-healing: the error docs expire, and a respec clears them outright.
    const errorCount = await registryManager.countAppInstallingErrors(appHash);
    if (errorCount >= 5) {
      log.warn(`trySpawningGlobalApplication - App ${appToRun} hash ${appHash} has ${errorCount} network-wide install failures; skipping`);
      fluxEventBus.publish('spawner:networkErrorSkip', { appName: appToRun, hash: appHash, errorCount });
      return delayTime;
    }

    runningAppList = await registryManager.appLocation(appToRun);


    const instantiated = selectedCandidate
      ? selectedCandidate.instantiated
      : await appsRepository.getGlobalAppInfo(appToRun);
    if (!instantiated) {
      throw new Error(`trySpawningGlobalApplication - Specifications for application ${appToRun} were not found!`);
    }

    // Every gate below asks per identity rather than per app. A node already
    // running one replica can be assigned another, and an app-level "it's
    // already here" refuses that second seat forever — the spec keeps naming an
    // identity nothing ever provisions. Presence rows carry their replica, so
    // "already here" means every identity this node is assigned is accounted
    // for, not merely that one of them is.
    const assigned = await deploymentProvider.assignedIdentities(instantiated);
    // Only rows on this node's own IP count toward its identities.
    const everyAssignedIdentityPresentIn = (documents) => {
      const present = new Set(documents
        .filter((document) => document.ip.includes(localIp))
        .map((document) => document.replica ?? null));
      return assigned.every((identity) => present.has(identity ?? null));
    };

    // check if app not running on this device
    if (everyAssignedIdentityPresentIn(runningAppList)) {
      log.info(`trySpawningGlobalApplication - Application ${appToRun} is reported as already running on this Flux IP`);
      return delayTime;
    }
    if (everyAssignedIdentityPresentIn(installingAppList)) {
      log.info(`trySpawningGlobalApplication - Application ${appToRun} is reported as already being installed on this Flux IP`);
      return delayTime;
    }

    const installed = new Set(await appsRepository.listInstalledIdentities(instantiated.name));
    if (assigned.every((identity) => installed.has(identity ?? null))) {
      log.info(`trySpawningGlobalApplication - Application ${instantiated.name} is already installed`);
      return shortDelayTime;
    }

    // A pure-follower app (shared collector) installs only while an app
    // assigned to this node declares a dependency edge to it. Re-check here so
    // the deferred selection path is covered too, and clear the spawn throttle
    // set above so it is reconsidered promptly once a workload that needs it
    // arrives. Best-effort: a registry-read failure falls back to allowing the
    // spawn.
    if (config.fluxapps.manageCollectorLifecycle
      && await relationshipResolver.isPureFollowerApp(instantiated)) {
      let requiredDeps = null;
      try {
        requiredDeps = await relationshipResolver.getRequiredDependencyNamesForNode({
          ip: localSocketAddr, outpoint: nodeOutpoint, operator: nodeOperator,
        });
      } catch (error) {
        log.error(`trySpawningGlobalApplication - could not check dependency requirement for ${instantiated.name}: ${error.message}`);
      }
      if (requiredDeps && !requiredDeps.has(instantiated.name)) {
        log.info(`trySpawningGlobalApplication - ${instantiated.name} is a pure follower and nothing on this node requires it; skipping spawn`);
        return shortDelayTime;
      }
    }

    let { spec } = instantiated;
    if (instantiated.isEncrypted) {
      try {
        const provider = await spec.createProvider();
        ({ spec } = await spec.decrypt(provider));
      } catch (error) {
        // Decrypt failures are node-local state (provider registration, the
        // benchmark channel), never a verdict on the app — caching the hash
        // would suppress a healthy app for the cache TTL. Clear the
        // selection-time entry so the next cycle retries.
        log.warn(`trySpawningGlobalApplication - decrypt of ${appToRun} failed, will retry next cycle: ${error.message}`);
        return shortDelayTime;
      }
    }
    const { DeploymentSpec } = await getSpecBackend();
    // Check what this pass will actually install. A replica-less view carries the
    // component's base ports, which on a co-located node belong to a sibling that
    // is already running — the port checks below would then refuse the very
    // install they are gating, because the port is held by the app itself.
    // Identities already installed are excluded for the same reason.
    const identitiesToInstall = assigned.filter((identity) => !installed.has(identity ?? null));
    // The app identity comes from the row, exactly as deploymentProvider builds its
    // views: it is what names the containers, and what every ownership comparison
    // downstream reads. Built without it, a view reports the app's NAME as its
    // identity, and the port guard below then sees this app's own reserved port as
    // another application's and refuses the install.
    const deployments = (identitiesToInstall.length ? identitiesToInstall : [null])
      .map((replica) => DeploymentSpec.fromSpec(spec, appsFolder, {
        replica,
        identity: instantiated.identity ?? null,
      }));
    // Images are spec-level — identical across identities — so any view answers
    // for the blocklist.
    const deployment = deployments[0];
    const appSpecifications = spec.serialize();
    const appPorts = [...new Set(deployments.flatMap((d) => d.allHostPorts()))];

    // verify app compliance
    const blockResult = await imageManager.isImageBlocked(instantiated.name, deployment.allImages(), { owner: instantiated.owner, hash: instantiated.hash });
    if (blockResult.blocked) {
      log.info(`trySpawningGlobalApplication - App ${instantiated.name} image is blocked: ${blockResult.reason}. Adding to error cache.`);
      globalState.spawnErrorsLongerAppCache.set(appHash, '');
      return shortDelayTime;
    }
    if (blockResult.undetermined) {
      // Blocklist unreachable (transient) - don't admit something we couldn't check.
      // Defer to next cycle without the longer back-off so a brief outage can't lock it out.
      log.warn(`trySpawningGlobalApplication - image blocklist unreachable for ${instantiated.name}, deferring spawn to next cycle`);
      return shortDelayTime;
    }

    // Refused before taking on new work, and only here. An application this node
    // cannot read contributes nothing to the totals the check below subtracts
    // from its capacity, so the space it believes is free includes space already
    // spoken for and this node would over-commit. The same refusal on the
    // maintenance paths would be wrong: a redeploy of an app already counted adds
    // nothing, and one unreadable application would freeze every other one on the
    // node. Named, because a node that quietly stops accepting work is a long
    // afternoon for whoever has to find out why.
    const unaccounted = resourceQueryService.unaccountedApps(await resourceQueryService.appsResources());
    if (unaccounted.length) {
      log.error(`trySpawningGlobalApplication - cannot account for what this node has committed: ${unaccounted.join(', ')} could not be read. Not taking on more.`);
      return shortDelayTime;
    }

    // verify requirements
    // Per identity: each replica reserves its own resources, and the sequential
    // installs below re-check with the running reservation applied.
    //
    // Reclaimable reservations are ignored here for the same reason as the
    // pre-screen: this gate throws into a catch that benches the hash for SIX
    // HOURS, so refusing on capacity a playground session is holding would cost
    // a paid app most of a day over a fifteen-minute session. The install-time
    // gate is the authority and the only place that can reclaim; this one must
    // not decide the question before it is reached.
    // eslint-disable-next-line no-restricted-syntax
    for (const identityDeployment of deployments) {
      // eslint-disable-next-line no-await-in-loop
      await hwRequirements.checkNodeResources(identityDeployment, { ignoreReclaimable: true });
      if (isEnterpriseNode) {
        // eslint-disable-next-line no-await-in-loop
        await hwRequirements.checkCpuBurstHeadroom(identityDeployment);
      }
    }

    // ensure ports unused
    // Get apps running specifically on this IP
    const appsRunningAtOurIp = await registryManager.getRunningAppIpList(localIp);
    const runningAppsNames = appsRunningAtOurIp.map((app) => app.name);

    // eslint-disable-next-line no-restricted-syntax
    for (const identityDeployment of deployments) {
      // eslint-disable-next-line no-await-in-loop
      await portManager.ensureApplicationPortsNotUsed(identityDeployment, runningAppsNames);
    }

    // The check above reads a sibling's ports from the specifications the
    // network broadcasts, so it sees only what has been reported as RUNNING. A
    // sibling that has installed an application and not started it, or is still
    // installing it, appears nowhere in that list and holds the router's forward
    // regardless. Ask the other Flux nodes at this address directly, here rather
    // than during the port test, so a refusal costs no firewall rule and no port
    // mapping to unwind.
    //
    // Not because an enterprise application hides its ports. It seals them, and
    // a node running ArcaneOS opens them - assignedPortsGlobalApps decrypts. On
    // a node that is not running ArcaneOS it cannot, and there this ask is the
    // only thing that sees a sealed neighbour's ports at all.
    //
    // Answered rather than raised, and handled exactly as an unreachable port is
    // below: this node cannot host this app, which is an ordinary answer and not
    // a fault. What separates the two is how it is told, not what it costs the
    // app: raised, this is an error with a stack trace and no event; answered,
    // it is one line and a deferral the fleet can observe. The app holds the
    // entry every selection takes in the spawn cache either way - it was filed
    // at selection, and the catch below adds nothing for a hash already there -
    // so this node stops considering it until that expires, which is right,
    // because nothing changes here until the sibling gives the port up.
    const sibling = await portManager.siblingHoldingPort(appPorts, localSocketAddr);
    if (sibling) {
      log.error(`trySpawningGlobalApplication - ${appSpecifications.name} port ${sibling.port} is held by the Flux node at ${sibling.address}, which shares this public address. Installation aborted.`);
      // A deferral, published as one: this stands the node down and returns
      // shortDelayTime exactly as the seven reasons below it do, so it belongs
      // in that vocabulary rather than in an event of its own.
      fluxEventBus.publish('spawner:deferred', {
        appName: appSpecifications.name,
        reason: 'sibling_holds_port',
        delayMs: shortDelayTime,
        port: sibling.port,
        address: sibling.address,
      });
      return shortDelayTime;
    }

    // Note: User-blocked port check happens earlier (line ~353) before Docker Hub calls
    // Check if ports are publicly available - critical for proper Flux network operation
    const portVerdict = await portManager.checkInstallingAppPortAvailable(appPorts);
    if (portVerdict.ok === false) {
      log.error(`trySpawningGlobalApplication - Some of application ports of ${instantiated.name} are not available publicly. Installation aborted.`);
      // The cause lives in portManager, which says which port and which peers;
      // this says the spawner deferred, and on which of its verdicts.
      fluxEventBus.publish('spawner:deferred', {
        appName: instantiated.name,
        reason: 'ports_not_available',
        portVerdict: portVerdict.reason,
        delayMs: shortDelayTime,
      });
      return shortDelayTime;
    }

    // double check if app is installed on the number of instances requested
    runningAppList = await registryManager.appLocation(appToRun);
    installingAppList = await registryManager.appInstallingLocation(appToRun);
    // A pinned-contended app returning from its off-loop collision window must fall
    // through to the broadcastedAt election below (the only code that ranks the
    // contenders and installs the winner). This blunt over-instance return would
    // otherwise pre-empt it - installing counts every contender's record - and the
    // app would place nowhere for 12h. Fresh passes still bail early here.
    if (!collisionWindowElapsed && runningAppList.length + installingAppList.length >= minInstances) {
      // KEPT when the running copies alone meet the count, CLEARED when the
      // claims were needed to reach it.
      //
      // A running copy is a durable fact and caching it is the point of the
      // cache - the app is covered, and re-deciding that every pass is waste.
      // A claim is not: it is withdrawn as soon as its node finds the share
      // already filled, seconds later and by design, because the share is
      // checked after the claim goes out. Cached on a count that needed those
      // claims, this node remembers "covered" for the cache's twelve hours and
      // never reconsiders, so an app that falls back below its instance count
      // waits out the day on every node that glanced inside that window.
      //
      // Clearing unconditionally is the other way to be wrong: an app whose
      // count is genuinely met would re-enter the candidate pool on every pass
      // and be declined again forever, never cached because it was never
      // installed.
      if (runningAppList.length < minInstances) {
        globalState.trySpawningGlobalAppCache.delete(appHash);
      }
      log.info(`trySpawningGlobalApplication - Application ${appToRun} is already spawned or being installed on ${runningAppList.length + installingAppList.length} instances.`);
      return shortDelayTime;
    }

    const syncthingApp = spec.hasSyncthing();

    // An owner who names exactly as many nodes as instances has assigned the
    // placement, and the diversity share does not second-guess it. A longer
    // list is a candidate pool - `nodes` may carry up to 120 entries against
    // an instance count as low as one - so the share still governs, computed
    // over that pool (placementFeasibility restricts its candidate set to it).
    // The bypass applies only when THIS node is named: a v8+ app spawning on
    // an off-list node is subject to the share either way.
    let ownerNamedThisNode = false;
    if (syncthingApp) {
      // Asked of the spec object, not of its serialized form: `nodes` is the v8
      // spelling and a v9 document does not carry it, so reading the serialized
      // doc made this false for every v9 app and the bypass unreachable.
      const { placement } = spec;
      const namedCount = placement.targetIps.length
        + placement.targetOutpoints.length + placement.targetOperators.length;
      ownerNamedThisNode = namedCount > 0 && namedCount <= minInstances
        && await placementFeasibility.specNamesThisNode(spec, localSocketAddr);
    }

    // A synced app may only be refused when a better-placed candidate provably
    // exists: this domain is refused once it holds its share of the instances,
    // computed over the app's eligible candidate set - never refused outright.
    let placementShare = null;
    let placementDomainOf = null;
    let myDomain = null;
    if (syncthingApp && !ownerNamedThisNode) {
      // placementComputation refuses a geo-restricted question while the location
      // table is still loading, because answering it over the whole network would
      // advise on numbers that mean nothing. That refusal is addressed to the HTTP
      // caller; reaching the catch below instead would read as a pre-install error
      // and park this app for six hours over a table that is seconds from ready.
      let computation;
      try {
        computation = await placementFeasibility.placementComputation(spec, minInstances);
      } catch (error) {
        if (error.statusCode !== 503) throw error;
        log.info(`trySpawningGlobalApplication - ${appSpecifications.name} deferred: ${error.message}`);
        return shortDelayTime;
      }
      placementShare = computation.feasibility;
      placementDomainOf = computation.domainOf;
      myDomain = placementDomainOf(localIp);
      // No `placeable` gate here, deliberately. This node reached the placement
      // check having passed its own geolocation filter, so it is itself an
      // eligible candidate - a table that resolves zero candidates network-wide
      // is contradicting the node's own location rather than proving the app
      // unplaceable, and refusing on that would strand the app everywhere.
      // Install-time geolocation checks remain authoritative.
      const heldInMine = await placementFeasibility.countHeldInDomain(runningAppList, myDomain, placementDomainOf)
        + await placementFeasibility.countHeldInDomain(installingAppList, myDomain, placementDomainOf);
      if (heldInMine >= placementShare.maxPerDomain) {
        log.info(`trySpawningGlobalApplication - Application ${appToRun} uses syncthing and fault domain ${myDomain} already holds ${heldInMine} of its ${placementShare.maxPerDomain}-instance share (${placementShare.domainCount} eligible domains)`);
        return shortDelayTime;
      }
    }

    if (syncthingApp) {
      if (!appFromAppsToBeCheckedLater && !appFromAppsSyncthingToBeCheckedLater && runningAppList.length < 6) {
        // check if there are connectivity to all nodes
        // eslint-disable-next-line no-restricted-syntax
        for (const node of runningAppList) {
          const ip = extractIp(node.ip);
          const port = extractPort(node.ip);
          // eslint-disable-next-line no-await-in-loop
          const isOpen = await fluxNetworkHelper.isPortOpen(ip, port);
          if (!isOpen) {
            log.info(`trySpawningGlobalApplication - Application ${appToRun} uses syncthing and instance running on ${ip}:${port} is not reachable, possible conenctivity issue, will be installed in 27m if remaining missing instances`);
            const appToCheck = {
              timeToCheck: Date.now() + 0.45 * 60 * 60 * 1000,
              appName: appToRun,
              hash: appHash,
              required: minInstances,
            };
            globalState.appsSyncthingToBeCheckedLater.push(appToCheck);
            return shortDelayTime;
          }
        }
        // eslint-disable-next-line no-restricted-syntax
        for (const node of installingAppList) {
          const ip = extractIp(node.ip);
          const port = extractPort(node.ip);
          // eslint-disable-next-line no-await-in-loop
          const isOpen = await fluxNetworkHelper.isPortOpen(ip, port);
          if (!isOpen) {
            log.info(`trySpawningGlobalApplication - Application ${appToRun} uses syncthing and instance being installed on ${ip}:${port} is not reachable, possible conenctivity issue, will be installed in 27m if remaining missing instances`);
            const appToCheck = {
              timeToCheck: Date.now() + 0.45 * 60 * 60 * 1000,
              appName: appToRun,
              hash: appHash,
              required: minInstances,
            };
            globalState.appsSyncthingToBeCheckedLater.push(appToCheck);
            return shortDelayTime;
          }
        }
      }
    }

    const specPlacement = spec.placement;
    const isEncryptedApp = instantiated.isEncrypted;

    if (!appFromAppsToBeCheckedLater && !appFromAppsSyncthingToBeCheckedLater
      && specPlacement.hasTargets() && !specPlacement.matchesTarget(targetInfo)) {
      const deferral = config.fluxapps.spawnDeferrals.targetedNodesMs;
      const delayMs = isEncryptedApp ? deferral.encrypted : deferral.standard;
      const appToCheck = {
        timeToCheck: Date.now() + delayMs,
        appName: appToRun,
        hash: appHash,
        required: minInstances,
      };
      log.info(`trySpawningGlobalApplication - App ${appToRun} has targets that don't match this node, will check in around ${Math.round(delayMs / 60000)}m if instances are still missing`);
      globalState.appsToBeCheckedLater.push(appToCheck);
      fluxEventBus.publish('spawner:deferred', { appName: appToRun, reason: 'targeted_nodes', delayMs });
      return shortDelayTime;
    }

    if (!isEnterpriseNode && !appFromAppsToBeCheckedLater && !appFromAppsSyncthingToBeCheckedLater) {
      const tier = await generalService.nodeTier();
      const appHWrequirements = deployment.resourceTotals();
      let delay = false;
      if (specPlacement.isPinnedTo(targetInfo)) {
        // The spec pinned this node (IP/outpoint/operator target): there is
        // no other node to defer to, so the politeness deferrals below
        // (static IP, datacenter, capacity gap) must not delay it.
        log.info(`trySpawningGlobalApplication - App ${appToRun} targets this node`);
      } else if (!isEncryptedApp && globalState.isArcane()) {
        const appToCheck = {
          timeToCheck: Date.now() + unencryptedSpawnDelayMs,
          appName: appToRun,
          hash: appHash,
          required: minInstances,
        };
        log.info(`trySpawningGlobalApplication - App ${appToRun} not encrypted, will check in around ${Math.round(unencryptedSpawnDelayMs / 1000)}s if instances are still missing`);
        globalState.appsToBeCheckedLater.push(appToCheck);
        fluxEventBus.publish('spawner:deferred', { appName: appToRun, reason: 'unencrypted_on_arcane', delayMs: unencryptedSpawnDelayMs });
        delay = true;
      } else if (!specPlacement.staticIp && geolocationService.isStaticIP()) {
        const deferral = config.fluxapps.spawnDeferrals.staticIpMs;
        const delayMs = isEncryptedApp ? deferral.encrypted : deferral.standard;
        const appToCheck = {
          timeToCheck: Date.now() + delayMs,
          appName: appToRun,
          hash: appHash,
          required: minInstances,
        };
        log.info(`trySpawningGlobalApplication - App ${appToRun} does not require static IP but node has static IP, will check in around ${Math.round(delayMs / 60000)}m if instances are still missing`);
        globalState.appsToBeCheckedLater.push(appToCheck);
        fluxEventBus.publish('spawner:deferred', { appName: appToRun, reason: 'static_ip', delayMs });
        delay = true;
      } else if (!specPlacement.dataCenter && geolocationService.isDataCenter()) {
        const deferral = config.fluxapps.spawnDeferrals.datacenterMs;
        const delayMs = isEncryptedApp ? deferral.encrypted : deferral.standard;
        const appToCheck = {
          timeToCheck: Date.now() + delayMs,
          appName: appToRun,
          hash: appHash,
          required: minInstances,
        };
        log.info(`trySpawningGlobalApplication - App ${appToRun} does not require datacenter but node is datacenter, will check in around ${Math.round(delayMs / 60000)}m if instances are still missing`);
        globalState.appsToBeCheckedLater.push(appToCheck);
        fluxEventBus.publish('spawner:deferred', { appName: appToRun, reason: 'datacenter', delayMs });
        delay = true;
      } else if (!specPlacement.hasTargets() && tier === 'bamf' && appHWrequirements.cpu < 3 && appHWrequirements.memoryMb < 6000 && appHWrequirements.storageGb < 150) {
        const deferral = config.fluxapps.spawnDeferrals.capacityGap.largeMs;
        const delayMs = isEncryptedApp ? deferral.encrypted : deferral.standard;
        const appToCheck = {
          timeToCheck: Date.now() + delayMs,
          appName: appToRun,
          hash: appHash,
          required: minInstances,
        };
        log.info(`trySpawningGlobalApplication - App ${appToRun} specs are from cumulus, will check in around ${Math.round(delayMs / 60000)}m if instances are still missing`);
        globalState.appsToBeCheckedLater.push(appToCheck);
        fluxEventBus.publish('spawner:deferred', { appName: appToRun, reason: 'capacity_gap_large', delayMs });
        delay = true;
      } else if (!specPlacement.hasTargets() && tier === 'bamf' && appHWrequirements.cpu < 7 && appHWrequirements.memoryMb < 29000 && appHWrequirements.storageGb < 370) {
        const deferral = config.fluxapps.spawnDeferrals.capacityGap.mediumMs;
        const delayMs = isEncryptedApp ? deferral.encrypted : deferral.standard;
        const appToCheck = {
          timeToCheck: Date.now() + delayMs,
          appName: appToRun,
          hash: appHash,
          required: minInstances,
        };
        log.info(`trySpawningGlobalApplication - App ${appToRun} specs are from nimbus, will check in around ${Math.round(delayMs / 60000)}m if instances are still missing`);
        globalState.appsToBeCheckedLater.push(appToCheck);
        fluxEventBus.publish('spawner:deferred', { appName: appToRun, reason: 'capacity_gap_medium', delayMs });
        delay = true;
      } else if (!specPlacement.hasTargets() && tier === 'super' && appHWrequirements.cpu < 3 && appHWrequirements.memoryMb < 6000 && appHWrequirements.storageGb < 150) {
        const deferral = config.fluxapps.spawnDeferrals.capacityGap.smallMs;
        const delayMs = isEncryptedApp ? deferral.encrypted : deferral.standard;
        const appToCheck = {
          timeToCheck: Date.now() + delayMs,
          appName: appToRun,
          hash: appHash,
          required: minInstances,
        };
        log.info(`trySpawningGlobalApplication - App ${appToRun} specs are from cumulus, will check in around ${Math.round(delayMs / 60000)}m if instances are still missing`);
        globalState.appsToBeCheckedLater.push(appToCheck);
        fluxEventBus.publish('spawner:deferred', { appName: appToRun, reason: 'capacity_gap_small', delayMs });
        delay = true;
      }
      if (delay) {
        return shortDelayTime;
      }
    }

    // ToDo: Move this to global
    const architecture = await hwRequirements.systemArchitecture();

    for (const [, component] of spec.componentEntries()) {
      // eslint-disable-next-line no-await-in-loop
      await imageManager.verifyRepository(component.image, {
        repoauth: component.imageAuth,
        specVersion: instantiated.version,
        architecture,
        appName: instantiated.name,
      }).catch((error) => {
        // The verifier's class routes the back-off: a transient failure (registry
        // unreachable/rate-limited) is a could-not-ask answer - minutes, matching
        // the verification cache's transient TTL, so the app retries as soon as
        // the outage ends. A permanent verdict keeps the hour. Either way the
        // cache entry must exist before the rethrow, or the outer catch would
        // draw its 6h pre-install back-off instead.
        const transient = error.registryErrorClass === 'transient';
        const ttl = transient ? (config.fluxapps.registryTransientBackoffMs ?? 2 * 60 * 1000) : FluxCacheManager.oneHour;
        log.warn(`trySpawningGlobalApplication - Docker Hub verification failed for ${appToRun}: ${error.message}${transient ? ' (transient; retrying in minutes)' : ''}`);
        globalState.trySpawningGlobalAppCache.set(appHash, '', { ttl });
        throttleIntended = true; // a deliberate Docker-Hub back-off; keep it through the finally
        throw error;
      });
    }

    // triple check if app is installed on the number of instances requested
    runningAppList = await registryManager.appLocation(appToRun);
    installingAppList = await registryManager.appInstallingLocation(appToRun);
    // Same as the double check: the collision-window return pass must reach the
    // election below, not bail on the raw over-instance count.
    if (!collisionWindowElapsed && runningAppList.length + installingAppList.length >= minInstances) {
      // KEPT when the running copies alone meet the count, CLEARED when the
      // claims were needed to reach it.
      //
      // A running copy is a durable fact and caching it is the point of the
      // cache - the app is covered, and re-deciding that every pass is waste.
      // A claim is not: it is withdrawn as soon as its node finds the share
      // already filled, seconds later and by design, because the share is
      // checked after the claim goes out. Cached on a count that needed those
      // claims, this node remembers "covered" for the cache's twelve hours and
      // never reconsiders, so an app that falls back below its instance count
      // waits out the day on every node that glanced inside that window.
      //
      // Clearing unconditionally is the other way to be wrong: an app whose
      // count is genuinely met would re-enter the candidate pool on every pass
      // and be declined again forever, never cached because it was never
      // installed.
      if (runningAppList.length < minInstances) {
        globalState.trySpawningGlobalAppCache.delete(appHash);
      }
      log.info(`trySpawningGlobalApplication - Application ${appToRun} is already spawned or being installed on ${runningAppList.length + installingAppList.length} instances.`);
      return shortDelayTime;
    }

    // Retract this node's installing claim, network-wide. A silent back-out
    // leaves the fluxappinstalling broadcast alive for its full TTL, and that
    // ghost keeps counting against instance totals and domain shares - and can
    // even win the cold-start seed election - for up to 15 minutes. On a small
    // eligible pool (a pinned org or region) one collision round of ghosts
    // stalls the whole domain for that window, so every withdrawal must say so.
    //
    // The retraction is a version 2 fluxappinstalling: the claim's own message,
    // withdrawing the claim. NOT an installing error - that means an install was
    // attempted and failed, it is counted and acted on as such, and a node
    // standing aside has attempted nothing. Counting these would make the apps
    // most in demand, whose races have the most losers, look the most broken.
    //
    // A node that does not know version 2 rejects the message whole, so it
    // neither acts on it nor refreshes the claim's clock: the claim expires on
    // its own, exactly as it did before any of this existed.
    // Standing aside costs no eligibility. A node that reconsiders this app while
    // the winner is still installing is turned away by the guards above - they
    // count claims as well as running instances - so it never re-claims and
    // nothing loops. And when the app IS short again because a holder died, a
    // node that once lost the race is exactly the one that should take it.
    const withdrawInstallingClaim = async (reason) => {
      log.info(`trySpawningGlobalApplication - withdrawing installing claim for ${appToRun}: ${reason}`);
      try {
        const withdrawal = {
          type: 'fluxappinstalling',
          version: 2,
          name: appSpecifications.name,
          ip: localSocketAddr,
          broadcastedAt: Date.now(),
          withdrawn: true,
        };
        await messageStore.storeAppInstallingMessage(withdrawal);
        // eslint-disable-next-line global-require
        const fluxCommMessagesSenderLib = require('../fluxCommunicationMessagesSender');
        await fluxCommMessagesSenderLib.broadcastMessageToAll(withdrawal);
      } catch (error) {
        // best effort - the installing TTL remains the backstop
        log.warn(`trySpawningGlobalApplication - could not retract installing claim for ${appToRun}: ${error.message}`);
      }
    };

    // an application was selected and checked that it can run on this node. try to install and run it locally
    // A pinned app with no install contention (pins <= required) skips the propagation waits below
    // (see isSoleRequiredInstaller). A pinned app with MORE pins than required has genuine multi-node
    // contention (isPinnedContended) and runs the collision election OFF the loop. A non-pinned app
    // keeps the legacy inline election.
    const soleRequiredInstaller = isSoleRequiredInstaller(specPlacement, minInstances);
    const pinnedContended = isPinnedContended(specPlacement, minInstances);
    // The identities this node announces seats for: one claim per assigned replica
    // (named placement), or the single untagged claim (loose). Resolved through the
    // same provider helper the install fan-out uses, so announce/renew/clear and
    // installAssignedReplicas agree on the set by construction.
    const assignedReplicas = await deploymentProvider.assignedIdentities(instantiated);
    if (assignedReplicas.length === 0) {
      // Named placement that no longer targets this node - reachable when a parked
      // deferred entry outlives a spec change (fresh passes are placement-filtered).
      log.info(`trySpawningGlobalApplication - ${appToRun} names no replicas for this node; nothing to install`);
      return shortDelayTime;
    }
    const looseIdentity = assignedReplicas.length === 1 && assignedReplicas[0] === null;
    // lets broadcast to the network the app is going to be installed on this node, so we don't get lot's of intances installed when it's not needed
    let broadcastedAt = Date.now();
    const announcedAt = broadcastedAt;
    const newAppInstallingMessage = {
      type: 'fluxappinstalling',
      version: 1,
      name: instantiated.name,
      ip: localSocketAddr,
      broadcastedAt,
    };
    // The renewable v2 claims, for appInstallingClaims-capable peers: announcedAt is
    // the immutable election key (renewals move only broadcastedAt), and the +1 makes
    // a claim strictly newer than the v1 announce so a store that receives both
    // versions converges on the announcedAt-bearing row regardless of arrival order
    // (only the loose claim has a v1 sibling; the offset is kept uniform).
    const installingClaims = assignedReplicas.map((replica) => ({
      type: 'fluxappinstalling',
      version: 2,
      name: instantiated.name,
      ip: localSocketAddr,
      ...(replica != null ? { replica } : {}),
      announcedAt,
      broadcastedAt: broadcastedAt + 1,
    }));
    const storeOwnClaims = async () => {
      for (const claim of installingClaims) {
        // eslint-disable-next-line no-await-in-loop
        await registryManager.storeAppInstallingMessage(claim);
      }
    };
    const broadcastAnnounce = async () => {
      // The v1 announce is loose-only: named seats are assigned by the spec (no node
      // races them) and no pre-claims node can parse a named app - while an untagged
      // v1 row beside the per-replica claim rows would over-count this node's seats
      // on capable peers.
      if (looseIdentity) {
        await fluxCommunicationMessagesSender.broadcastMessageToAll(newAppInstallingMessage);
      }
      for (const claim of installingClaims) {
        // eslint-disable-next-line no-await-in-loop
        await fluxCommunicationMessagesSender.broadcastMessageToAll(claim, { requireCapability: 'appInstallingClaims' });
      }
    };

    if (soleRequiredInstaller) {
      // Contention-free pinned install: no propagation wait below depends on peers having seen the
      // installing message, so store it locally (the over-instance check reads this) and fire-and-forget
      // the ~500ms broadcast relay so the install starts sooner. Safe against reordering: the peer-side
      // installing store applies only a strictly-newer broadcastedAt, so a late/duplicate can never
      // clobber a newer state - the appremoved model.
      await storeOwnClaims();
      installingRecordKey = { name: instantiated.name, ip: localSocketAddr, replicas: assignedReplicas };
      renewalTimer = startInstallingRenewal(instantiated.name, localSocketAddr, announcedAt, assignedReplicas);
      broadcastAnnounce()
        .catch((e) => log.error(`installing broadcast for ${appToRun} failed: ${e.message}`));
    } else if (pinnedContended && !collisionWindowElapsed) {
      // Genuine multi-node contention on a pinned app (more pins than required): the collision
      // election needs peers' installing-broadcasts to propagate. Store + broadcast our intent, then
      // DEFER the propagation window onto appsToBeCheckedLater instead of sleeping on it inline - an
      // inline delay here freezes the single-threaded spawn loop for the whole window and
      // head-of-line-blocks every contention-free app queued behind it (e.g. a sole-installer app
      // pinned only to this node, which has nothing to wait for). It comes back off the queue once
      // the window has elapsed and proceeds straight to the over-instance election + install below.
      // The claims stay standing across the park (collisionClaimHeld keeps the finally off
      // them): they ARE this node's election entries, and elections order on the immutable
      // announcedAt.
      await storeOwnClaims();
      installingRecordKey = { name: instantiated.name, ip: localSocketAddr, replicas: assignedReplicas };
      await broadcastAnnounce();
      appsToBeCheckedLater.push({
        appName: appToRun,
        hash: appHash,
        required: minInstances,
        timeToCheck: Date.now() + collisionWaitMs,
        collisionDeferred: true,
        announcedAt,
        replicas: assignedReplicas,
      });
      collisionClaimHeld = true;
      log.info(`trySpawningGlobalApplication - ${appToRun} has multi-node install contention; deferring its ${collisionWaitMs}ms collision window off the spawn loop so contention-free apps queued behind it are not blocked`);
      return shortDelayTime;
    } else if (!collisionWindowElapsed) {
      // Non-pinned app (open contention - any node may install): keep the legacy inline election.
      // Store + broadcast, then wait inline for peers' broadcasts to propagate.
      await storeOwnClaims();
      installingRecordKey = { name: instantiated.name, ip: localSocketAddr, replicas: assignedReplicas };
      renewalTimer = startInstallingRenewal(instantiated.name, localSocketAddr, announcedAt, assignedReplicas);
      await broadcastAnnounce();
      await serviceHelper.delay(collisionWaitMs); // give it 1.5m so messages are propagated on the network
    }
    if (collisionWindowElapsed) {
      // A pinned-contended app back from the deferred queue: the first pass stored +
      // broadcast the claims, so skip the announce and re-adopt them instead - the failure
      // paths below must retract them, and a long install must renew them under their
      // original announce time so the election ordering never moves. The identities are
      // the first pass's (what actually exists as rows), not a re-resolve.
      installingRecordKey = { name: instantiated.name, ip: localSocketAddr, replicas: deferredReplicas ?? assignedReplicas };
      renewalTimer = startInstallingRenewal(instantiated.name, localSocketAddr, deferredAnnouncedAt ?? announcedAt, installingRecordKey.replicas);
    }

    // double check if app is installed in more of the instances requested
    runningAppList = await registryManager.appLocation(appToRun);
    installingAppList = await registryManager.appInstallingLocation(appToRun);
    if (runningAppList.length + installingAppList.length > minInstances) {
      installingAppList.sort(compareClaimRows);
      log.info(`trySpawningGlobalApplication - Application ${appToRun} contended: ${runningAppList.length} running, claims after wait: ${describeRanking(installingAppList, 'broadcastedAt')}`);
      broadcastedAt = Date.now();
      const index = installingAppList.findIndex((x) => socketAddressesMatch(x.ip, localSocketAddr));
      if (runningAppList.length + index + 1 > minInstances) {
        log.info(`trySpawningGlobalApplication - Application ${appToRun} is already spawned or being installed on ${runningAppList.length + installingAppList.length} instances, my instance is number ${runningAppList.length + index + 1}`);
        await withdrawInstallingClaim('instance count filled by earlier claimants');
        globalState.trySpawningGlobalAppCache.delete(appHash);
        return shortDelayTime;
      }
    }

    if (syncthingApp && !ownerNamedThisNode && placementShare) {
      // Re-check the domain share against the propagated lists, keyed by the
      // same computation that produced the share - a fresher view of the
      // network would move nodes between domains the share was never computed
      // for. Running instances consume the share outright; among simultaneous
      // installing claimants the earliest broadcasts win the remainder - the
      // generalisation of the old oldest-wins resolver to shares above one.
      const runningInMine = await placementFeasibility.countHeldInDomain(runningAppList, myDomain, placementDomainOf);
      const remainingShare = placementShare.maxPerDomain - runningInMine;
      if (remainingShare <= 0) {
        log.info(`trySpawningGlobalApplication - Application ${appToRun} uses syncthing and fault domain ${myDomain} already runs ${runningInMine} of its ${placementShare.maxPerDomain}-instance share`);
        await withdrawInstallingClaim('domain share held by running instances');
        globalState.trySpawningGlobalAppCache.delete(appHash);
        return shortDelayTime;
      }
      const claimantsInMine = installingAppList
        .filter((location) => placementDomainOf(location.ip) === myDomain)
        .sort(compareInstallingClaims);
      const myIndex = claimantsInMine.findIndex((location) => socketAddressesMatch(location.ip, localSocketAddr));
      const claimantsAhead = myIndex === -1 ? claimantsInMine.length : myIndex;
      if (claimantsAhead >= remainingShare) {
        log.info(`trySpawningGlobalApplication - Application ${appToRun} uses syncthing and ${claimantsAhead} earlier claimants in fault domain ${myDomain} fill its remaining share of ${remainingShare} (claims: ${describeRanking(claimantsInMine, 'broadcastedAt')})`);
        await withdrawInstallingClaim('domain share filled by earlier claimants');
        globalState.trySpawningGlobalAppCache.delete(appHash);
        return shortDelayTime;
      }
      if (claimantsInMine.length > 1) {
        log.info(`trySpawningGlobalApplication - Application ${appToRun} uses syncthing, this node is claim ${claimantsAhead + 1} of ${remainingShare} remaining in fault domain ${myDomain}, continuing (claims: ${describeRanking(claimantsInMine, 'broadcastedAt')})`);
      }
    }

    // The node is already doing something to an app, and the spawner is the one
    // that gives way: the periodic reinstall pass holds this flag across its own
    // teardown-and-rebuild, and an install started inside that window is refused
    // when the pass comes back for its node - leaving the app it tore down with
    // nothing to rebuild it. The claim is withdrawn rather than held, so another
    // node can take the placement now instead of waiting this one out.
    const held = operationRegistry.list().find((lease) => NODE_WIDE_OPERATIONS.includes(lease.type));
    if (held) {
      const heldBy = `${held.type} of ${held.key}`;
      log.info(`trySpawningGlobalApplication - Application ${appToRun} not installed, this node is undergoing ${heldBy}`);
      await withdrawInstallingClaim(`node is undergoing ${heldBy}`);
      globalState.trySpawningGlobalAppCache.delete(appHash);
      return shortDelayTime;
    }

    // install the app
    let installResult;
    // The installer still signals some failures by throwing, and only the reason
    // it throws with says WHICH check refused - a port already held by another
    // app is raised that way, and reporting the failure without it leaves a suite
    // unable to tell a refusal from an app that was simply never selected.
    let installError = null;
    try {
      installResult = await appInstaller.installAssignedReplicas(instantiated);
    } catch (error) {
      log.error(error);
      installError = error.message ?? String(error);
      installResult = { status: appInstaller.InstallStatus.FAILED, reason: error.message || String(error) };
    }
    if (installResult.status === appInstaller.InstallStatus.DEFERRED) {
      // Transient (blocklist unreachable, node busy) - retry next cycle without the
      // longer back-off, so a brief outage doesn't lock the app out for days.
      log.info(`trySpawningGlobalApplication - install deferred for ${appToRun}: ${installResult.reason}; retrying next cycle`);
      return shortDelayTime;
    }
    if (installResult.status !== appInstaller.InstallStatus.INSTALLED && installResult.status !== appInstaller.InstallStatus.SKIPPED) {
      // rejected (blocked image) or failed (install errored) - back off the longer cache.
      log.info(`trySpawningGlobalApplication - install ${installResult.status} for ${appToRun}: ${installResult.reason}; adding to local error cache`);
      globalState.spawnErrorsLongerAppCache.set(appHash, '');
      fluxEventBus.publish('spawner:installFailed', { appName: appToRun, hash: appHash, error: installError });
      return shortDelayTime;
    }
    // The app installed (or was already installed): the installing record now reflects
    // reality, so the finally must not retract it.
    installSucceeded = true;

    // Surplus trimming is the spec reconciler's decision: request a post-install
    // convergence after the propagation window (peers' running-broadcasts need
    // time to land), detached so the serial spawn loop never blocks on it. Sole
    // required installers cannot over-install (pin set <= required instances),
    // so they skip the request entirely.
    if (!soleRequiredInstaller) {
      specReconciler.requestAppConvergence(appToRun, { reason: 'postInstall', delayMs: 1 * 60 * 1000 })
        .catch((error) => log.error(error));
    }

    log.info('trySpawningGlobalApplication - Reinitiating possible app installation');
    const nextDelay = isEnterpriseNode ? 0 : delayTime;
    return nextDelay;
  } catch (error) {
    log.error(error);
    if (appHash && !globalState.spawnErrorsLongerAppCache.has(appHash) && !globalState.trySpawningGlobalAppCache.has(appHash)) {
      log.info(`trySpawningGlobalApplication - Adding app hash ${appHash} to trySpawningGlobalAppCache due to pre-install error`);
      globalState.trySpawningGlobalAppCache.set(appHash, '', { ttl: FluxCacheManager.oneHour * 6 });
      throttleIntended = true; // a deliberate pre-install-error back-off; keep it
    }
    return shortDelayTime || 5 * 60 * 1000;
  } finally {
    if (renewalTimer) clearInterval(renewalTimer);
    // Unwind the "I'm taking this app" marks unless a deliberate back-off was set
    // or the install succeeded. Clearing an unset throttle / retracting an unstored
    // record are no-ops, so this is safe on every early exit. A collision-parked
    // claim (collisionClaimHeld) is deliberately left standing: it is the node's
    // election entry until the second pass re-adopts it.
    if (appHash && !throttleIntended) {
      globalState.trySpawningGlobalAppCache.delete(appHash);
    }
    if (installingRecordKey && !installSucceeded && !collisionClaimHeld) {
      for (const replica of installingRecordKey.replicas) {
        // eslint-disable-next-line no-await-in-loop
        await registryManager.removeAppInstallingMessage(installingRecordKey.name, installingRecordKey.ip, replica)
          .catch((e) => log.error(`trySpawningGlobalApplication - removeAppInstallingMessage for ${installingRecordKey.name} failed: ${e.message}`));
        // Release the seat fleet-wide too. This says nothing about the app - genuine
        // failures separately broadcast fluxappinstallingerror, which peers count
        // against the hash; for those this clear is a harmless no-op delete.
        // eslint-disable-next-line no-await-in-loop
        await broadcastInstallingCleared(installingRecordKey.name, installingRecordKey.ip, replica)
          .catch((e) => log.error(`trySpawningGlobalApplication - installing clear broadcast for ${installingRecordKey.name} failed: ${e.message}`));
      }
    }
  }
}

/**
 * Wake the spawn loop if it is currently parked in its inter-cycle idle delay.
 * No-op when the loop is mid-cycle (no pending delay) or paused.
 */
function wakeIdleLoop() {
  if (idleWakeResolve) {
    const resolve = idleWakeResolve;
    idleWakeResolve = null;
    resolve();
  } else {
    // Loop is mid-cycle (no pending delay to interrupt): latch the wake so spawnLoop skips
    // its NEXT idle delay instead of dropping the signal.
    wakePending = true;
  }
}

/**
 * React to a freshly-stored global app spec by waking the spawn loop early - but ONLY
 * where this node is a mandatory installer, so reacting instantly cannot cause an
 * install race: any NAMED-placement spec pinned to this node (each replica name pins
 * exactly one node - contention-free by construction), or the contention-free
 * enterprise case (enterprise node, enterprise-owned app, pin set no larger than the
 * required instances). Every other spec is left to the normal poll cadence.
 * Best-effort: it only ever ends an idle wait early, never installs directly, and
 * never throws into the caller (the spec-store path). The raw stored doc is hydrated
 * into an InstantiatedSpec at the perimeter so the gate reads domain accessors +
 * Placement domain methods, never raw doc fields.
 * @param {object} specDoc - spec doc just committed to globalAppsInformation
 */
async function notifySpecStored(specDoc) {
  try {
    if (!specDoc || globalState.spawnerPaused) return;
    const { InstantiatedSpec } = await getSpecBackend();
    const instantiated = InstantiatedSpec.deserialize(specDoc);
    const { placement } = instantiated;
    // Pinned to THIS node (by IP - the conservative subset; an outpoint/operator-only
    // pin simply rides the normal cadence). lastKnownLocalSocketAddr is null until the
    // first spawn cycle resolves this node's address, before which isPinnedTo yields
    // false and the spec rides the normal cadence.
    if (!placement.isPinnedTo({ ip: lastKnownLocalSocketAddr, ipMatcher: socketAddressesMatch })) return;
    // Pinned placement is contention-free by construction (each name pins exactly
    // one node), so any pinned spec targeting this node wakes the loop. A candidate
    // spec races other candidates, so it wakes only for the contention-free
    // enterprise case: enterprise node, enterprise-owned app, pin set no larger
    // than required instances (the instances default mirrors the global
    // aggregation's $ifNull: ['$instances', 3]).
    if (placement.mode() !== 'pinned') {
      if (enterpriseNetwork.getCachedEnterpriseIdentity() !== true) return;
      if (!enterpriseNetwork.isEnterpriseAppOwner(instantiated.owner)) return;
      if (!isSoleRequiredInstaller(placement, instantiated.spec.instances ?? 3)) return;
    }
    log.info(`notifySpecStored - ${instantiated.name} is pinned to this node and contention-free; waking spawn loop`);
    wakeIdleLoop();
  } catch (error) {
    log.error(`notifySpecStored - ${error.message}`);
  }
}

module.exports = {
  initialize,
  trySpawningGlobalApplication,
  isSoleRequiredInstaller,
  isPinnedContended,
  compareClaimRows,
  notifySpecStored,
};
