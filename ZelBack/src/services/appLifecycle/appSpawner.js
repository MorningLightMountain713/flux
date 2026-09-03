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

// Import modular services
const registryManager = require('../appDatabase/registryManager');
const appsRepository = require('../appDatabase/appsRepository');
const nodeDownStore = require('../appMessaging/nodeDownStore');
const imageManager = require('../appSecurity/imageManager');
const hwRequirements = require('../appRequirements/hwRequirements');
const portManager = require('../appNetwork/portManager');
const { getSpecBackend } = require('../utils/specLibs');
const { ensureProvidersRegistered } = require('../utils/specCutover');
const { appsFolder, INSTALLING_RENEWAL_MS } = require('../utils/appConstants');
const globalState = require('../utils/globalState');
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
    cleared: true,
    broadcastedAt: Date.now(),
  };
  await fluxCommunicationMessagesSender.broadcastMessageToAll(message, { requireCapability: 'appInstallingClaims' });
}

/**
 * Try spawning a global application that needs more instances
 * This is the main function that continuously checks for applications that need more instances
 * and attempts to spawn them on this node if it meets the requirements
 * @returns {Promise<void>}
 */
async function trySpawningGlobalApplication() {
  const installDelay = config.fluxapps.installation.delay * 1000;
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
      globalAppNamesLocation = globalAppNamesLocation.filter((c) => c.instantiated.spec.placement.matches(nodeInfo));
      globalAppNamesLocation = globalAppNamesLocation.filter((c) => {
        const { owner } = c.instantiated;
        const isEnterpriseOwner = enterpriseNetwork.isEnterpriseAppOwner(owner);
        const eligible = isEnterpriseNode ? isEnterpriseOwner : !isEnterpriseOwner;
        return eligible;
      });
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

      if (globalAppNamesLocation.length === 0) {
        log.info('trySpawningGlobalApplication - No app currently to be processed');
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

    const adjustedIP = extractIp(localSocketAddr); // just IP address

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
        .filter((document) => document.ip.includes(adjustedIP))
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
    const localSocketAddrAddress = extractIp(localSocketAddr); // just IP address without port
    const runningAppsOnThisIP = await registryManager.getRunningAppIpList(localSocketAddrAddress);
    const runningAppsNames = runningAppsOnThisIP.map((app) => app.name);

    // eslint-disable-next-line no-restricted-syntax
    for (const identityDeployment of deployments) {
      // eslint-disable-next-line no-await-in-loop
      await portManager.ensureApplicationPortsNotUsed(identityDeployment, runningAppsNames);
    }

    // Note: User-blocked port check happens earlier (line ~353) before Docker Hub calls
    // Check if ports are publicly available - critical for proper Flux network operation
    const portsPubliclyAvailable = await portManager.checkInstallingAppPortAvailable(appPorts);
    if (portsPubliclyAvailable === false) {
      log.error(`trySpawningGlobalApplication - Some of application ports of ${instantiated.name} are not available publicly. Installation aborted.`);
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
      log.info(`trySpawningGlobalApplication - Application ${appToRun} is already spawned or being installed on ${runningAppList.length + installingAppList.length} instances.`);
      return shortDelayTime;
    }

    const syncthingApp = spec.hasSyncthing();

    const localIp = extractIp(localSocketAddr);
    const lastIndex = localIp.lastIndexOf('.');
    const secondLastIndex = localIp.substring(0, lastIndex).lastIndexOf('.');
    const ipPrefix = localIp.substring(0, secondLastIndex + 1); // includes the '.' e.g. "192.168."

    if (syncthingApp) {
      let sameIpRangeNode = runningAppList.find((location) => location.ip.startsWith(ipPrefix));
      if (sameIpRangeNode) {
        log.info(`trySpawningGlobalApplication - Application ${appToRun} uses syncthing and it is already spawned on Fluxnode with same ip range`);
        return shortDelayTime;
      }
      sameIpRangeNode = installingAppList.find((location) => location.ip.startsWith(ipPrefix));
      if (sameIpRangeNode) {
        log.info(`trySpawningGlobalApplication - Application ${appToRun} uses syncthing and it is already being installed on Fluxnode with same ip range`);
        return shortDelayTime;
      }
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
      log.info(`trySpawningGlobalApplication - Application ${appToRun} is already spawned or being installed on ${runningAppList.length + installingAppList.length} instances.`);
      return shortDelayTime;
    }

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
      broadcastedAt = Date.now();
      const index = installingAppList.findIndex((x) => socketAddressesMatch(x.ip, localSocketAddr));
      if (runningAppList.length + index + 1 > minInstances) {
        log.info(`trySpawningGlobalApplication - Application ${appToRun} is already spawned or being installed on ${runningAppList.length + installingAppList.length} instances, my instance is number ${runningAppList.length + index + 1}`);
        return shortDelayTime;
      }
    }

    if (syncthingApp) {
      const sameIpRangeNode = runningAppList.find((location) => location.ip.startsWith(ipPrefix));
      if (sameIpRangeNode) {
        log.info(`trySpawningGlobalApplication - Application ${appToRun} uses syncthing and it is already spawned on Fluxnode with same ip range`);
        return shortDelayTime;
      }
      const sameIpRangeInstallingNodes = installingAppList.filter((location) => location.ip.startsWith(ipPrefix));
      if (sameIpRangeInstallingNodes.length > 0) {
        // Find the node with the oldest claim (first to start installing); announcedAt
        // is the stable key under v2 renewals, broadcastedAt covers v1 rows.
        const oldestNode = sameIpRangeInstallingNodes.reduce((oldest, current) => {
          const oldestClaimedAt = oldest.announcedAt ?? oldest.broadcastedAt;
          const currentClaimedAt = current.announcedAt ?? current.broadcastedAt;
          if (!oldestClaimedAt) return current;
          if (!currentClaimedAt) return oldest;
          return currentClaimedAt < oldestClaimedAt ? current : oldest;
        });
        // If our node is not the oldest one, skip - let the first node continue
        if (!socketAddressesMatch(oldestNode.ip, localSocketAddr)) {
          log.info(`trySpawningGlobalApplication - Application ${appToRun} uses syncthing and it is already being installed on Fluxnode with same ip range`);
          return shortDelayTime;
        }
        // Our node is the oldest - we were first, continue with installation
        log.info(`trySpawningGlobalApplication - Application ${appToRun} uses syncthing, we are the first node in ip range to start installing, continuing`);
      }
    }

    // install the app
    let installResult;
    try {
      installResult = await appInstaller.installAssignedReplicas(instantiated);
    } catch (error) {
      log.error(error);
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
      fluxEventBus.publish('spawner:installFailed', { appName: appToRun, hash: appHash });
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
