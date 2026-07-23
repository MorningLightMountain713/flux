const config = require('config');
const log = require('../../lib/log');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const operationRegistry = require('../utils/operationRegistry');
const fluxEventBus = require('../utils/fluxEventBus');
const { appSyncEvents, EVENTS: SYNC_EVENTS } = require('../utils/appSyncEvents');
const appsRepository = require('../appDatabase/appsRepository');
const registryManager = require('../appDatabase/registryManager');
const appQueryService = require('../appQuery/appQueryService');
const appDockerNetwork = require('../appNetwork/appDockerNetwork');
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
 * Reap the app networks this node holds for apps it does not have installed:
 * what an interrupted uninstall left behind, or what a restored node came back
 * with. Networks only — a container with no installed app is the orphan sweep's,
 * which removes it through the uninstaller with its volumes, ports and graceful
 * shutdown budget rather than pulling it out from under docker. Images belong to
 * the imageReaper, which is reference-gated and respects image-cache pins.
 *
 * Ownership decides, not docker's idea of "unused". Docker calls a network
 * unused the moment nothing is attached to it, which is true of every healthy
 * app whose container is briefly down (crash loop, restart, standby) — so a
 * prune keyed on that reaps live apps' networks and leaves them unable to start
 * at all. Asking who owns a network instead makes that unconstructable, and
 * removes the need for the old node-wide guard that skipped the sweep whenever
 * ANY installed component was stopped, which on a real node meant it never ran.
 *
 * Nothing unattributable is touched: leaked debris is recoverable, and the cost
 * of guessing wrong is someone's app.
 *
 * @returns {Promise<object>} sweep summary
 */
async function dockerDebrisSweep() {
  // Never race an install/remove/redeploy/reconcile/backup/restore anywhere on
  // the node: mid-operation state is not debris.
  if (operationRegistry.anyHeld()) {
    log.info('appJanitor - debris sweep skipped: an operation is in progress');
    return { skipped: 'operation in flight' };
  }

  const installedAppsRes = await appQueryService.installedApps();
  if (installedAppsRes.status !== 'success') {
    // Without the installed set every network on the node looks unowned.
    // Skipping is the only safe reading of an unavailable database.
    log.warn('appJanitor - debris sweep skipped: unable to list installed apps');
    return { skipped: 'installed list failed' };
  }
  const installedAppNames = new Set(installedAppsRes.data.map((app) => app.name));

  const { removed, unidentified } = await appDockerNetwork.removeUnownedAppNetworks(installedAppNames);

  if (unidentified > 0) {
    log.info(`appJanitor - debris sweep left ${unidentified} unattributable network(s) in place`);
  }
  log.info(`appJanitor - debris swept: ${removed.length} network(s) removed`);

  return { networksRemoved: removed.length, unidentified };
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
