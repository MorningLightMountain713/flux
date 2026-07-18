const config = require('config');
const log = require('../../lib/log');
const dockerService = require('../dockerService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const operationRegistry = require('../utils/operationRegistry');
const fluxEventBus = require('../utils/fluxEventBus');
const { appSyncEvents, EVENTS: SYNC_EVENTS } = require('../utils/appSyncEvents');
const appsRepository = require('../appDatabase/appsRepository');
const registryManager = require('../appDatabase/registryManager');
const appQueryService = require('../appQuery/appQueryService');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const appUninstaller = require('./appUninstaller');

// The janitor owns debris: things that exist on this node with no desired-state
// row referring to them. Anything a row DOES refer to belongs to the
// specReconciler ladder - the janitor never interprets desired state. Its one
// registry write (dropping expired global rows) executes the chain's verdict.

// Containers that are flux-adjacent but deliberately unlabelled and unowned.
const EXEMPT_APP_NAMES = ['watchtower'];

/**
 * Resolve which app a container belongs to. Labelled containers carry the app
 * name stamped at the create chokepoint; pre-label containers (created before
 * identity labels shipped and never recreated) fall back to the historical
 * name convention (strip '/flux', app name at segment [1]).
 * @param {object} container - docker list entry (Names, Labels)
 * @returns {string} app name
 */
function containerAppName(container) {
  const labelled = container.Labels && container.Labels['runonflux.app'];
  if (labelled) return labelled;
  const bare = container.Names[0].slice(5);
  const name = bare.split('_')[1] || bare;
  return name;
}

/**
 * Remove docker containers whose app has no installed-app row: crash debris,
 * failed removals, out-of-band leftovers. Removal is graceful - the stop rides
 * the container's own stamped shutdown-budget labels (or docker's default
 * SIGTERM grace), so a torn write can never sync to an app's other replicas -
 * and backgrounded, so the host-mutation lock serializes teardowns without
 * this sweep pacing itself.
 * @returns {Promise<object>} sweep summary
 */
async function dockerOrphanSweep() {
  // Never race an install/remove/redeploy/reconcile/backup/restore anywhere on
  // the node: mid-operation container state is not debris.
  if (operationRegistry.anyHeld()) {
    log.info('appJanitor - orphan sweep skipped: an operation is in progress');
    return { skipped: 'operation in flight' };
  }

  const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
  if (!localSocketAddr) {
    log.warn('appJanitor - orphan sweep skipped: unable to get node IP');
    return { skipped: 'no ip' };
  }

  const dockerAppsReported = await appQueryService.listAllApps();
  if (dockerAppsReported.status !== 'success') {
    log.warn('appJanitor - orphan sweep skipped: unable to list docker apps');
    return { skipped: 'docker list failed' };
  }
  const installedAppsRes = await appQueryService.installedApps();
  if (installedAppsRes.status !== 'success') {
    log.warn('appJanitor - orphan sweep skipped: unable to list installed apps');
    return { skipped: 'installed list failed' };
  }
  const appsInstalled = installedAppsRes.data;

  const dockerAppNames = [...new Set(dockerAppsReported.data.map(containerAppName))]
    .filter((appName) => !EXEMPT_APP_NAMES.includes(appName));

  const removed = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const appName of dockerAppNames) {
    const appInstalledExists = appsInstalled.find((app) => app.name === appName);
    // eslint-disable-next-line no-continue
    if (appInstalledExists) continue;

    let shouldBroadcast = false;
    try {
      // eslint-disable-next-line no-await-in-loop
      const location = await appsRepository.getAppLocation(appName, localSocketAddr);
      if (location) {
        shouldBroadcast = true;
        log.info(`appJanitor - ${appName} found in locations for this IP (${localSocketAddr}), will broadcast removal`);
      }
    } catch (locationError) {
      log.error(`appJanitor - error checking app location for ${appName}: ${locationError.message}`);
    }

    log.warn(`REMOVAL REASON: Orphan app cleanup - ${appName} running in Docker but not in installed apps database (appJanitor)`);
    // eslint-disable-next-line no-await-in-loop
    await appUninstaller.uninstallApplication(appName, {
      forceKill: false, skipGuard: true, broadcastRemoval: shouldBroadcast, background: true,
    }).catch((error) => log.error(error));
    removed.push(appName);
  }

  return { removed: removed.length, apps: removed };
}

/**
 * Registry hygiene: drop expired registrations from the global app registry,
 * their install-error records (locations AND archived broadcasts, so message
 * sync cannot redistribute errors for a dead app - the respec path removes
 * both for the same reason), and orphaned content manifests. This sweep never
 * uninstalls anything - removing an expired LOCAL install is the
 * specReconciler's job (its per-app ladder, per block).
 * @returns {Promise<object>} sweep summary
 */
async function registryExpirySweep() {
  let explorerHeight = null;
  try {
    explorerHeight = await registryManager.getScannedHeight();
  } catch (error) {
    log.info('appJanitor - registry expiry skipped: scanning not initiated');
    return { skipped: 'scanning not initiated' };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const candidates = await appsRepository.listGlobalAppInfo();
  const appsToExpire = candidates.filter(
    (spec) => spec.isExpired(nowSeconds, explorerHeight),
  );

  // eslint-disable-next-line no-restricted-syntax
  for (const app of appsToExpire) {
    log.info(`appJanitor - expiring global registration of ${app.name}`);
    // eslint-disable-next-line no-await-in-loop
    await appsRepository.removeGlobalAppInfo(app.name);
    // eslint-disable-next-line no-await-in-loop
    await appsRepository.removeAppInstallingErrorRecords(app.name);
  }

  const { reaped } = await appsRepository.reapOrphanedContentManifests();
  if (reaped > 0) log.info(`appJanitor - reaped ${reaped} content manifest(s) for removed apps`);

  return { expired: appsToExpire.length, manifestsReaped: reaped };
}

/**
 * Prune docker debris nothing owns: stopped containers, unused networks,
 * unused volumes. Images are deliberately not touched - reclamation belongs to
 * the imageReaper, which is reference-gated and respects image-cache pins.
 * Guards: a docker prune deletes ANY stopped container and its anonymous
 * volumes, so the sweep must not run while an installed app is merely stopped
 * (operator-stopped, standby, run-once done). anyHeld() additionally covers
 * in-flight operations and the active-standby election, both of which stop and
 * start containers the prune could otherwise eat mid-transition.
 * @returns {Promise<object>} sweep summary
 */
async function dockerDebrisSweep() {
  if (operationRegistry.anyHeld()) {
    log.info('appJanitor - debris sweep skipped: an operation is in progress');
    return { skipped: 'operation in flight' };
  }

  const deployments = await deploymentProvider.listInstalledDeployments();
  const runningAppsRes = await appQueryService.listRunningApps();
  if (runningAppsRes.status !== 'success') {
    throw new Error('Unable to check running Apps');
  }
  const runningSet = new Set(runningAppsRes.data.map((app) => app.Names[0].slice(5)));
  const stoppedComponents = [];
  deployments.forEach((deployment) => {
    deployment.componentEntries().forEach(([, comp]) => {
      if (!runningSet.has(comp.identifier)) stoppedComponents.push(comp.identifier);
    });
  });
  if (stoppedComponents.length > 0) {
    log.info(`appJanitor - debris sweep skipped: ${stoppedComponents.length} installed component(s) not running`);
    return { skipped: 'stopped apps present' };
  }

  await dockerService.pruneContainers();
  await dockerService.pruneNetworks();
  await dockerService.pruneVolumes();
  log.info('appJanitor - docker debris pruned (containers, networks, volumes)');

  return { pruned: true };
}

const SWEEPS = {
  dockerOrphans: dockerOrphanSweep,
  registryExpiry: registryExpirySweep,
  dockerDebris: dockerDebrisSweep,
};

const sweepsRunning = new Set();

/**
 * Run a sweep single-flight: a sweep still in progress absorbs the new request.
 * Never throws - a janitor failure is logged and retried on the next cadence.
 * @param {string} name - key in SWEEPS
 * @returns {Promise<object|null>} sweep summary, or null (in flight / failed)
 */
async function runSweep(name) {
  if (sweepsRunning.has(name)) return null;
  sweepsRunning.add(name);
  try {
    const result = await SWEEPS[name]();
    fluxEventBus.publish('janitor:sweep', { sweep: name, ...result });
    return result;
  } catch (error) {
    log.error(`appJanitor - ${name} sweep failed: ${error.message}`);
    return null;
  } finally {
    sweepsRunning.delete(name);
  }
}

async function sweepDockerOrphans() {
  const result = await runSweep('dockerOrphans');
  return result;
}

async function sweepRegistryExpiry() {
  const result = await runSweep('registryExpiry');
  return result;
}

async function sweepDockerDebris() {
  const result = await runSweep('dockerDebris');
  return result;
}

let started = false;

/**
 * Register the periodic sweeps and the sync-transition trigger. Registry
 * expiry additionally runs on the explorer's at-tip cadence (explorerService
 * calls sweepRegistryExpiry directly - block-driven work cannot self-schedule).
 */
function start() {
  if (started) return;
  started = true;

  const bootDelay = (ms) => Math.round(ms * config.fluxapps.bootDelayMultiplier);
  const schedule = (name, initialMs, intervalMs) => {
    setTimeout(() => {
      runSweep(name);
      setInterval(() => runSweep(name), intervalMs);
    }, bootDelay(initialMs));
  };

  schedule('dockerOrphans', 30 * 60 * 1000, config.fluxapps.orphanSweepIntervalMs);
  schedule('dockerDebris', 45 * 60 * 1000, config.fluxapps.dockerDebrisIntervalMs);

  // Every entry into READY (first sync and every resync recovery): the node
  // just (re)gained an authoritative view, so clear what the registry says is
  // dead before the spawner starts choosing apps from it.
  appSyncEvents.on(SYNC_EVENTS.SPAWNER_READY, () => {
    runSweep('registryExpiry');
  });
}

module.exports = {
  start,
  sweepDockerOrphans,
  sweepRegistryExpiry,
  sweepDockerDebris,
};
