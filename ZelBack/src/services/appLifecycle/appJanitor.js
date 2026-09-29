'use strict';

const config = require('config');
const log = require('../../lib/log');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const operationRegistry = require('../utils/operationRegistry');
const fluxEventBus = require('../utils/fluxEventBus');
const dockerService = require('../dockerService');
const appsRepository = require('../appDatabase/appsRepository');
const { getSpec, getSpecBackend } = require('../utils/specLibs');
const appQueryService = require('../appQuery/appQueryService');
const appDockerNetwork = require('../appNetwork/appDockerNetwork');
const playgroundRunner = require('../appPlayground/playgroundRunner');
const playgroundSessionRegistry = require('../appPlayground/playgroundSessionRegistry');
const appUninstaller = require('./appUninstaller');

// The janitor owns debris: things that exist on this node with no desired-state
// row referring to them. Anything a row DOES refer to belongs to the
// specReconciler ladder - the janitor never interprets desired state.


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

  // Playground containers are orphans by definition - a session deliberately has
  // no installed-app row - so they would match this sweep exactly, and it would
  // run a full app uninstall (ports, mounts, crontab, data) against an app that
  // was never installed. They are filtered out here, at the CONTAINER level
  // rather than by name, because a session runs under the spec's own app name
  // and nothing about that name marks it. playgroundService owns their lifecycle
  // and its own reaper collects the ones a restart or a failed teardown left.
  const { LABEL_KEYS } = await getSpecBackend();
  const dockerAppNames = [...new Set(
    dockerAppsReported.data
      .filter((container) => !(container.Labels && container.Labels[LABEL_KEYS.PLAYGROUND_SESSION]))
      .map((container) => dockerService.containerAppName(
        { labels: container.Labels, name: container.Names?.[0] }, LABEL_KEYS,
      )),
  )];

  const removed = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const appName of dockerAppNames) {
    const appInstalledExists = appsInstalled.find((app) => app.name === appName);
    // eslint-disable-next-line no-continue
    if (appInstalledExists) continue;

    let shouldBroadcast = false;
    try {
      // eslint-disable-next-line no-await-in-loop
      const claims = await appsRepository.appLocationFromEvents({ appname: appName, ip: localSocketAddr });
      if (claims.length) {
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
 * Reap the content manifests of apps the registry no longer lists.
 * @returns {Promise<object>} sweep summary
 */
async function contentManifestSweep() {
  const { reaped } = await appsRepository.reapOrphanedContentManifests();
  if (reaped > 0) log.info(`appJanitor - reaped ${reaped} content manifest(s) for removed apps`);
  return { manifestsReaped: reaped };
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
  // Session networks are outside the app namespace and carry the session's own
  // ownership label, so this sweep cannot see them and needs no exception for
  // them. playgroundRunner's own sweep collects the ones a restart or a failed
  // teardown left.
  const { appNetworkNameFor } = await getSpec();
  const ownedNetworks = new Set(installedAppsRes.data.map(
    (app) => appNetworkNameFor({ identity: app.identity ?? null, appName: app.name }),
  ));

  const { removed, unidentified } = await appDockerNetwork.removeUnownedAppNetworks(ownedNetworks);

  if (unidentified > 0) {
    log.info(`appJanitor - debris sweep left ${unidentified} unattributable network(s) in place`);
  }
  log.info(`appJanitor - debris swept: ${removed.length} network(s) removed`);

  return { networksRemoved: removed.length, unidentified };
}

/**
 * Collect playground containers no live session claims.
 *
 * Separate from the orphan sweep above rather than folded into it, because the
 * two answer different questions from different sources of truth. That one asks
 * the installed-apps database and removes a whole app; this one asks the
 * in-memory session registry and removes a container. It also deliberately does
 * NOT skip while an operation is in flight: a session holds no operation lease
 * between its start and its teardown, and the containers this collects are ones
 * nothing is coming back for.
 *
 * @returns {Promise<object>} sweep summary
 */
async function playgroundOrphanSweep() {
  return playgroundRunner.reapOrphans(playgroundSessionRegistry.liveIds());
}

const SWEEPS = {
  dockerOrphans: dockerOrphanSweep,
  contentManifests: contentManifestSweep,
  dockerDebris: dockerDebrisSweep,
  playgroundOrphans: playgroundOrphanSweep,
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

async function sweepContentManifests() {
  const result = await runSweep('contentManifests');
  return result;
}

async function sweepDockerDebris() {
  const result = await runSweep('dockerDebris');
  return result;
}

async function sweepPlaygroundOrphans() {
  const result = await runSweep('playgroundOrphans');
  return result;
}

let started = false;

/** Register the periodic sweeps. */
function start() {
  if (started) return;
  started = true;

  const bootDelay = (ms) => Math.round(ms * config.get('fluxapps.bootDelayMultiplier'));
  const schedule = (name, initialMs, intervalMs) => {
    setTimeout(() => {
      runSweep(name);
      setInterval(() => runSweep(name), intervalMs);
    }, bootDelay(initialMs));
  };

  schedule('dockerOrphans', 30 * 60 * 1000, config.get('fluxapps.orphanSweepIntervalMs'));
  schedule('dockerDebris', 45 * 60 * 1000, config.get('fluxapps.dockerDebrisIntervalMs'));
  schedule('contentManifests', 30 * 60 * 1000, config.get('fluxapps.orphanSweepIntervalMs'));
  // Much earlier than the other two: sessions live only in memory, so at this
  // point every playground container on the node belongs to a session that no
  // longer exists. Waiting half an hour to collect them would leave a restarted
  // node running strangers' containers with nothing watching them.
  schedule('playgroundOrphans', 2 * 60 * 1000, config.get('fluxapps.playgroundReapIntervalMs'));

}

module.exports = {
  start,
  sweepContentManifests,
  sweepDockerOrphans,
  sweepDockerDebris,
  sweepPlaygroundOrphans,
};
