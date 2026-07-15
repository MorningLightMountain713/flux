// App Spawner - Handles automatic spawning of global applications
const config = require('config');
const serviceHelper = require('../serviceHelper');
const generalService = require('../generalService');
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
const imageManager = require('../appSecurity/imageManager');
const hwRequirements = require('../appRequirements/hwRequirements');
const portManager = require('../appNetwork/portManager');
const { getSpecBackend } = require('../utils/specLibs');
const { ensureProvidersRegistered } = require('../utils/specCutover');
const { appsFolder } = require('../utils/appConstants');
const globalState = require('../utils/globalState');
const enterpriseNetwork = require('../utils/enterpriseNetwork');
const { FluxCacheManager } = require('../utils/cacheManager');
const appInstaller = require('./appInstaller');
const appNetworkLinker = require('./appNetworkLinker');
const appUninstaller = require('./appUninstaller');
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
 * targets) - the v9 successor to the flat v8 `nodes` IP list. Summing the three
 * target arrays can over-count when one physical node is pinned by two identifiers
 * (e.g. IP and outpoint); that is conservative - it only ever demotes a true
 * sole-installer to "contended" (losing the fast path), never the reverse, so it
 * cannot cause an instance overshoot.
 * @param {object} placement - the spec's Placement
 * @returns {number}
 */
function placementPinCount(placement) {
  if (!placement) return 0;
  return placement.targetIps.length + placement.targetOutpoints.length + placement.targetOperators.length;
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

/**
 * Over-instance self-evict check: if more than the required instances are running and this node is
 * the surplus one (newest by runningSince), remove the local instance. Used both inline (a
 * non-pinned app, after its propagation wait) and detached after a wait (a contended app).
 */
async function overInstanceSelfEvictCheck(appToRun, appHash, minInstances, localSocketAddr) {
  const runningAppList = await registryManager.appLocation(appToRun);
  if (runningAppList.length > minInstances) {
    runningAppList.sort((a, b) => {
      if (!a.runningSince && b.runningSince) {
        return -1;
      }
      if (a.runningSince && !b.runningSince) {
        return 1;
      }
      if (a.runningSince < b.runningSince) {
        return -1;
      }
      if (a.runningSince > b.runningSince) {
        return 1;
      }
      return 0;
    });
    const index = runningAppList.findIndex((x) => socketAddressesMatch(x.ip, localSocketAddr));
    log.info(`trySpawningGlobalApplication - Application ${appToRun} is already spawned on ${runningAppList.length} instances, my instance is number ${index + 1}`);
    if (index + 1 > minInstances) {
      log.info(`trySpawningGlobalApplication - Application ${appToRun} is going to be removed as already passed the instances required.`);
      log.warn(`REMOVAL REASON: Exceeded required instances - ${appToRun} already has sufficient instances, removing local installation (appSpawner)`);
      globalState.trySpawningGlobalAppCache.delete(appHash);
      // No skipGuard: trimming a surplus instance is never an emergency, so it must
      // defer on any in-flight operation (esp. a graceful teardown already draining
      // this app) rather than barge past it and force-kill mid-drain.
      appUninstaller.uninstallApplication(appToRun, { forceKill: true, broadcastRemoval: true }).catch((error) => log.error(error));
    }
  }
}

/**
 * Detached wrapper for the over-instance self-evict of a contended (non-sole-installer) app. Run
 * fire-and-forget after the install so the post-install propagation wait never blocks the serial
 * spawn loop (an inline 60s sleep head-of-line-blocks every queued app). Errors are logged.
 */
async function scheduleOverInstanceSelfEvict(appToRun, appHash, minInstances, localSocketAddr) {
  try {
    await serviceHelper.delay(1 * 60 * 1000); // give peers' running-broadcasts time to propagate
    await overInstanceSelfEvictCheck(appToRun, appHash, minInstances, localSocketAddr);
  } catch (error) {
    log.error(error);
  }
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
  let installingRecordKey = null; // { name, ip } once the installing record is stored
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

    let isNodeConfirmed = false;
    isNodeConfirmed = await generalService.isNodeStatusConfirmed().catch(() => null);
    if (!isNodeConfirmed) {
      log.info('Flux Node not Confirmed. Global applications will not be installed');
      fluxEventBus.publish('spawner:blocked', { reason: 'not_confirmed' });
      globalState.fluxNodeWasNotConfirmedOnLastCheck = true;
      return installDelay;
    }

    if (globalState.firstExecutionAfterItsSynced === true) {
      log.info('Explorer Synced, checking for expired apps');
      await appUninstaller.expireGlobalApplications();
      globalState.firstExecutionAfterItsSynced = false;
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
    if (!numberOfGlobalApps) {
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
    const { appsToBeCheckedLater, appsSyncthingToBeCheckedLater } = globalState;

    const collateral = await generalService.obtainNodeCollateralInformation();
    const nodeOutpoint = `${collateral.txhash}:${collateral.txindex}`;
    const nodeOperator = fluxNetworkHelper.getFluxNodePublicKey();
    const targetInfo = {
      ip: localSocketAddr,
      outpoint: nodeOutpoint,
      operator: typeof nodeOperator === 'string' ? nodeOperator : undefined,
      ipMatcher: socketAddressesMatch,
    };
    const appIndex = appsToBeCheckedLater.findIndex((app) => app.timeToCheck <= Date.now());
    const appSyncthingIndex = appsSyncthingToBeCheckedLater.findIndex((app) => app.timeToCheck <= Date.now());
    let runningAppList = [];
    let installingAppList = [];

    if (appIndex >= 0) {
      appToRun = appsToBeCheckedLater[appIndex].appName;
      appHash = appsToBeCheckedLater[appIndex].hash;
      minInstances = appsToBeCheckedLater[appIndex].required;
      collisionWindowElapsed = appsToBeCheckedLater[appIndex].collisionDeferred === true;
      appsToBeCheckedLater.splice(appIndex, 1);
      appFromAppsToBeCheckedLater = true;
      appsCountAvailableToInstallOnMyNode = Math.max(0, appsCountAvailableToInstallOnMyNode - 1);
    } else if (appSyncthingIndex >= 0) {
      appToRun = appsSyncthingToBeCheckedLater[appSyncthingIndex].appName;
      appHash = appsSyncthingToBeCheckedLater[appSyncthingIndex].hash;
      minInstances = appsSyncthingToBeCheckedLater[appSyncthingIndex].required;
      appsSyncthingToBeCheckedLater.splice(appSyncthingIndex, 1);
      appFromAppsSyncthingToBeCheckedLater = true;
      appsCountAvailableToInstallOnMyNode = Math.max(0, appsCountAvailableToInstallOnMyNode - 1);
    } else {
      const nodeGeo = await geolocationService.getNodeGeolocation();
      const nodeInfo = {
        hasStaticIp: geolocationService.isStaticIP(),
        isDataCenter: geolocationService.isDataCenter(),
        location: nodeGeo ? {
          continent: nodeGeo.continentCode,
          country: nodeGeo.countryCode,
          region: nodeGeo.regionName,
        } : undefined,
      };
      globalAppNamesLocation = globalAppNamesLocation.filter((c) => !installedApps.find((a) => a.name === c.instantiated.name)
        && !globalState.spawnErrorsLongerAppCache.has(c.instantiated.hash)
        && !globalState.trySpawningGlobalAppCache.has(c.instantiated.hash)
        && !appsToBeCheckedLater.some((appAux) => appAux.appName === c.instantiated.name));
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

      // Suppress pure-follower apps (activation.standalone false — shared
      // collectors) that no app assigned to this node requires: they only
      // install while a workload here shareWith-links to them, and must not be
      // respawned after a teardown. Best-effort: on a registry-read failure,
      // fall back to not suppressing rather than aborting. Gated off in
      // production: the flux console owns the collector lifecycle.
      if (config.fluxapps.manageCollectorLifecycle) {
        try {
          const requiredDependencyNames = await appNetworkLinker.getRequiredDependencyNamesForNode({
            ip: localSocketAddr, outpoint: nodeOutpoint, operator: nodeOperator,
          });
          globalAppNamesLocation = globalAppNamesLocation.filter((c) => !appNetworkLinker.isPureFollower(c.instantiated)
            || requiredDependencyNames.has(c.instantiated.name));
        } catch (error) {
          log.error(`trySpawningGlobalApplication - could not compute required dependencies, not suppressing collectors this cycle: ${error.message}`);
        }
      }

      // Readiness-ordered selection: drop candidates whose shareWith dependencies
      // are not ready, so a linked group installs root-first (a dependency before
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
            await appNetworkLinker.checkAppNetworkRequirements(c.instantiated);
            return true;
          } catch (error) {
            // Dependency not ready yet -> skip this cycle. Any other error (e.g.
            // owner mismatch) is a real misconfig handled at install.
            return error.code !== 'NETWORK_DEPENDENCY_NOT_READY';
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

      const ipTargeted = globalAppNamesLocation.filter((c) => c.instantiated.spec.placement.targetIps.length > 0
        && c.instantiated.spec.placement.matchesTarget({ ip: localSocketAddr, ipMatcher: socketAddressesMatch }));
      const outpointTargeted = globalAppNamesLocation.filter((c) => c.instantiated.spec.placement.targetOutpoints.length > 0
        && c.instantiated.spec.placement.matchesTarget({ outpoint: nodeOutpoint }));
      const operatorTargeted = globalAppNamesLocation.filter((c) => c.instantiated.spec.placement.targetOperators.length > 0
        && c.instantiated.spec.placement.matchesTarget({ operator: nodeOperator }));

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
      if (runningAppList.length + installingAppList.length > minInstances) {
        log.info(`trySpawningGlobalApplication - Application ${appToRun} is already spawned or being installed on ${runningAppList.length + installingAppList.length} instances.`);
        return shortDelayTime;
      }
      // Encrypted apps can only install on an attested ArcaneOS node. The verdict is
      // resolved before this runs, so a non-arcane verdict is definitive: refuse and
      // remember (long-error cache).
      if (selectedCandidate.instantiated.isEncrypted && !globalState.isArcane()) {
        log.info(`trySpawningGlobalApplication - Application ${appToRun} is encrypted, can only install on ArcaneOS`);
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
    // check if app not running on this device
    if (runningAppList.find((document) => document.ip.includes(adjustedIP))) {
      log.info(`trySpawningGlobalApplication - Application ${appToRun} is reported as already running on this Flux IP`);
      return delayTime;
    }
    if (installingAppList.find((document) => document.ip.includes(adjustedIP))) {
      log.info(`trySpawningGlobalApplication - Application ${appToRun} is reported as already being installed on this Flux IP`);
      return delayTime;
    }

    const instantiated = selectedCandidate
      ? selectedCandidate.instantiated
      : await appsRepository.getGlobalAppInfo(appToRun);
    if (!instantiated) {
      throw new Error(`trySpawningGlobalApplication - Specifications for application ${appToRun} were not found!`);
    }

    if (await appsRepository.existsInstalledApp(instantiated.name)) {
      log.info(`trySpawningGlobalApplication - Application ${instantiated.name} is already installed`);
      return shortDelayTime;
    }

    // A pure-follower app (shared collector) installs only while an app assigned
    // to this node shareWith-links to it. Re-check here so the deferred selection
    // path is covered too, and clear the spawn throttle set above so it is
    // reconsidered promptly once a workload that needs it arrives. Best-effort: a
    // registry-read failure falls back to allowing the spawn.
    if (config.fluxapps.manageCollectorLifecycle && appNetworkLinker.isPureFollower(instantiated)) {
      let requiredDeps = null;
      try {
        requiredDeps = await appNetworkLinker.getRequiredDependencyNamesForNode({
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
    const deployment = DeploymentSpec.fromSpec(spec, appsFolder);
    const appPorts = deployment.allHostPorts();

    const appIsVetted = await imageManager.isAppVetted({ owner: instantiated.owner, hash: instantiated.hash, images: deployment.allImages() });
    if (!appIsVetted) {
      // eslint-disable-next-line no-restricted-syntax
      for (let i = 0; i < appPorts.length; i += 1) {
        const port = appPorts[i];
        const isUserBlocked = fluxNetworkHelper.isPortUserBlocked(port);
        if (isUserBlocked) {
          log.info(`trySpawningGlobalApplication - App ${instantiated.name} uses user-blocked port ${port}. Adding to error cache.`);
          globalState.spawnErrorsLongerAppCache.set(appHash, '');
          // eslint-disable-next-line no-await-in-loop
          return shortDelayTime;
        }
      }
    } else {
      log.info(`trySpawningGlobalApplication - App ${instantiated.name} is vetted. Bypassing user-blocked ports check.`);
    }

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

    await hwRequirements.checkNodeResources(deployment);
    if (isEnterpriseNode) {
      await hwRequirements.checkCpuBurstHeadroom(deployment);
    }

    // ensure ports unused
    // Get apps running specifically on this IP
    const localSocketAddrAddress = extractIp(localSocketAddr); // just IP address without port
    const runningAppsOnThisIP = await registryManager.getRunningAppIpList(localSocketAddrAddress);
    const runningAppsNames = runningAppsOnThisIP.map((app) => app.name);

    await portManager.ensureApplicationPortsNotUsed(deployment, runningAppsNames);

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
    if (!collisionWindowElapsed && runningAppList.length + installingAppList.length > minInstances) {
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
      const appHWrequirements = deployment.totalResources();
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
      } else if (!specPlacement.hasTargets() && tier === 'bamf' && appHWrequirements.cpu < 3 && appHWrequirements.memory < 6000 && appHWrequirements.storage < 150) {
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
      } else if (!specPlacement.hasTargets() && tier === 'bamf' && appHWrequirements.cpu < 7 && appHWrequirements.memory < 29000 && appHWrequirements.storage < 370) {
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
      } else if (!specPlacement.hasTargets() && tier === 'super' && appHWrequirements.cpu < 3 && appHWrequirements.memory < 6000 && appHWrequirements.storage < 150) {
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
    if (!collisionWindowElapsed && runningAppList.length + installingAppList.length > minInstances) {
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
    // lets broadcast to the network the app is going to be installed on this node, so we don't get lot's of intances installed when it's not needed
    let broadcastedAt = Date.now();
    const newAppInstallingMessage = {
      type: 'fluxappinstalling',
      version: 1,
      name: instantiated.name,
      ip: localSocketAddr,
      broadcastedAt,
    };

    if (soleRequiredInstaller) {
      // Contention-free pinned install: no propagation wait below depends on peers having seen the
      // installing message, so store it locally (the over-instance check reads this) and fire-and-forget
      // the ~500ms broadcast relay so the install starts sooner. Safe against reordering: the peer-side
      // installing store applies only a strictly-newer broadcastedAt, so a late/duplicate can never
      // clobber a newer state - the appremoved model.
      await registryManager.storeAppInstallingMessage(newAppInstallingMessage);
      installingRecordKey = { name: instantiated.name, ip: localSocketAddr };
      fluxCommunicationMessagesSender.broadcastMessageToAll(newAppInstallingMessage)
        .catch((e) => log.error(`installing broadcast for ${appToRun} failed: ${e.message}`));
    } else if (pinnedContended && !collisionWindowElapsed) {
      // Genuine multi-node contention on a pinned app (more pins than required): the collision
      // election needs peers' installing-broadcasts to propagate. Store + broadcast our intent, then
      // DEFER the propagation window onto appsToBeCheckedLater instead of sleeping on it inline - an
      // inline delay here freezes the single-threaded spawn loop for the whole window and
      // head-of-line-blocks every contention-free app queued behind it (e.g. a sole-installer app
      // pinned only to this node, which has nothing to wait for). It comes back off the queue once
      // the window has elapsed and proceeds straight to the over-instance election + install below.
      // The installing message persists in the local registry for installingTtlS (900s, >> the 90s
      // window), so it is NOT re-stored on the way back, and must not be re-broadcast (which would
      // reset broadcastedAt and skew the election ordering).
      await registryManager.storeAppInstallingMessage(newAppInstallingMessage);
      installingRecordKey = { name: instantiated.name, ip: localSocketAddr };
      await fluxCommunicationMessagesSender.broadcastMessageToAll(newAppInstallingMessage);
      appsToBeCheckedLater.push({
        appName: appToRun,
        hash: appHash,
        required: minInstances,
        timeToCheck: Date.now() + collisionWaitMs,
        collisionDeferred: true,
      });
      log.info(`trySpawningGlobalApplication - ${appToRun} has multi-node install contention; deferring its ${collisionWaitMs}ms collision window off the spawn loop so contention-free apps queued behind it are not blocked`);
      return shortDelayTime;
    } else if (!collisionWindowElapsed) {
      // Non-pinned app (open contention - any node may install): keep the legacy inline election.
      // Store + broadcast, then wait inline for peers' broadcasts to propagate.
      await registryManager.storeAppInstallingMessage(newAppInstallingMessage);
      installingRecordKey = { name: instantiated.name, ip: localSocketAddr };
      await fluxCommunicationMessagesSender.broadcastMessageToAll(newAppInstallingMessage);
      await serviceHelper.delay(collisionWaitMs); // give it 1.5m so messages are propagated on the network
    }
    // A pinned-contended app back from the deferred queue (collisionWindowElapsed) already stored +
    // broadcast its installing message on the first pass, so it falls straight through to the
    // over-instance election check below.

    // double check if app is installed in more of the instances requested
    runningAppList = await registryManager.appLocation(appToRun);
    installingAppList = await registryManager.appInstallingLocation(appToRun);
    if (runningAppList.length + installingAppList.length > minInstances) {
      installingAppList.sort((a, b) => {
        if (a.broadcastedAt < b.broadcastedAt) {
          return -1;
        }
        if (a.broadcastedAt > b.broadcastedAt) {
          return 1;
        }
        return 0;
      });
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
        // Find the node with the oldest broadcastedAt (first to start installing)
        const oldestNode = sameIpRangeInstallingNodes.reduce((oldest, current) => {
          if (!oldest.broadcastedAt) return current;
          if (!current.broadcastedAt) return oldest;
          return current.broadcastedAt < oldest.broadcastedAt ? current : oldest;
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
      installResult = await appInstaller.installApplication(instantiated);
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

    if (pinnedContended) {
      // Multi-node contention: the post-install over-instance self-evict needs peers' running-
      // broadcasts to propagate, but that wait must NOT block the serial spawn loop (an inline 60s
      // sleep head-of-line-blocks every queued app). Run it detached - the app is already installed,
      // so this only trims a surplus local instance if the election overshot.
      scheduleOverInstanceSelfEvict(appToRun, appHash, minInstances, localSocketAddr);
    } else {
      // Non-pinned apps keep the legacy inline propagation wait before the check; sole-installers can
      // never over-install (pin set <= required) so they need neither the wait nor a real check.
      if (!soleRequiredInstaller) {
        await serviceHelper.delay(1 * 60 * 1000); // give running-broadcasts time to propagate
      }
      await overInstanceSelfEvictCheck(appToRun, appHash, minInstances, localSocketAddr);
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
    // Unwind the "I'm taking this app" marks unless a deliberate back-off was set
    // or the install succeeded. Clearing an unset throttle / retracting an unstored
    // record are no-ops, so this is safe on every early exit.
    if (appHash && !throttleIntended) {
      globalState.trySpawningGlobalAppCache.delete(appHash);
    }
    if (installingRecordKey && !installSucceeded) {
      await registryManager.removeAppInstallingMessage(installingRecordKey.name, installingRecordKey.ip)
        .catch((e) => log.error(`trySpawningGlobalApplication - removeAppInstallingMessage for ${installingRecordKey.name} failed: ${e.message}`));
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
 * for the contention-free enterprise case where this node is a mandatory installer, so
 * reacting instantly cannot cause an install race:
 *   1. this is an enterprise node,
 *   2. the app is enterprise-owned,
 *   3. its pin set is no larger than its required instances (isSoleRequiredInstaller -
 *      no overshoot, so no install race), and
 *   4. it is pinned to THIS node.
 * Every other spec is left to the normal poll cadence. Best-effort: it only ever ends
 * an idle wait early, never installs directly, and never throws into the caller (the
 * spec-store path). The raw stored doc is hydrated into an InstantiatedSpec at the
 * perimeter so the gate reads domain accessors + Placement domain methods, never raw
 * doc fields.
 * @param {object} specDoc - spec doc just committed to globalAppsInformation
 */
async function notifySpecStored(specDoc) {
  try {
    if (!specDoc || globalState.spawnerPaused) return;
    // 1. enterprise node only (null = identity not yet resolved -> skip). Cheap sync
    //    gate first, so a non-enterprise node never pays to hydrate the spec.
    if (enterpriseNetwork.getCachedEnterpriseIdentity() !== true) return;
    const { InstantiatedSpec } = await getSpecBackend();
    const instantiated = InstantiatedSpec.deserialize(specDoc);
    // 2. enterprise-owned app only
    if (!enterpriseNetwork.isEnterpriseAppOwner(instantiated.owner)) return;
    const { placement } = instantiated;
    // 3. contention-free: pinned, with pin set <= required instances. The instances
    //    default mirrors the global aggregation's $ifNull: ['$instances', 3].
    if (!isSoleRequiredInstaller(placement, instantiated.spec.instances ?? 3)) return;
    // 4. pinned to THIS node (by IP - the conservative subset; an outpoint/operator-only
    //    pin simply rides the normal cadence). lastKnownLocalSocketAddr is null until the
    //    first spawn cycle resolves this node's address, before which isPinnedTo yields
    //    false and the spec rides the normal cadence.
    if (!placement.isPinnedTo({ ip: lastKnownLocalSocketAddr, ipMatcher: socketAddressesMatch })) return;
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
  notifySpecStored,
};
