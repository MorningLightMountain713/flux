/**
 * App Startup Manager
 *
 * Owns all boot-time app lifecycle decisions. Uses boot context (machine reboot
 * detection, downtime, shutdown reason) to determine whether to start, remove,
 * or wait before managing containers.
 */

const config = require('config');
const log = require('../../lib/log');
const dbHelper = require('../dbHelper');
const dockerService = require('../dockerService');
const serviceHelper = require('../serviceHelper');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const appReconciler = require('../appMonitoring/appReconciler');
const nodeDosState = require('../nodeDosState');
const appUninstaller = require('./appUninstaller');
const appNetworkLinker = require('./appNetworkLinker');
const contentSlotService = require('./contentSlotService');
const telemetrySinkCache = require('../telemetrySinkCache');
const telemetryConfigService = require('../telemetryConfigService');
const telemetryIdentityService = require('../telemetryIdentityService');
const globalState = require('../utils/globalState');
const fluxEventBus = require('../utils/fluxEventBus');
const nodeConfirmationService = require('../nodeConfirmationService');
const { localAppsInformation, SIGTERM_EXPIRY_MS, RUNNING_EXPIRY_MS } = require('../utils/appConstants');
const { parseContainerName, appHasValidLocationOnNode } = require('../utils/appUtilities');

const SYNC_TIMEOUT_MS = config.system.bootSyncTimeoutMs ?? 300000;

/**
 * Get all installed apps from local database
 * @returns {Promise<Array>} Array of installed app specifications
 */
async function getInstalledAppsFromDb() {
  try {
    const dbopen = dbHelper.databaseConnection();
    const appsDatabase = dbopen.db(config.database.appslocal.database);
    const appsQuery = {};
    const appsProjection = {
      projection: { _id: 0 },
    };
    const apps = await dbHelper.findInDatabase(appsDatabase, localAppsInformation, appsQuery, appsProjection);
    return apps || [];
  } catch (error) {
    log.error(`appStartupManager - Error getting installed apps: ${error.message}`);
    return [];
  }
}

/**
 * Get all stopped Flux containers
 * @returns {Promise<Array>} Array of stopped container info
 */
async function getStoppedFluxContainers() {
  try {
    // Get all containers including stopped ones
    const containers = await dockerService.dockerListContainers(true);

    if (!containers || containers.length === 0) {
      return [];
    }

    // Filter for Flux app containers that are stopped (not running)
    const stoppedContainers = containers.filter((container) => {
      const name = container.Names && container.Names[0] ? container.Names[0] : '';
      const isFluxContainer = name.startsWith('/flux');
      // Check if container is stopped (State is 'exited' or not 'running')
      const isStopped = container.State !== 'running';
      return isFluxContainer && isStopped;
    });

    return stoppedContainers;
  } catch (error) {
    log.error(`appStartupManager - Error getting stopped containers: ${error.message}`);
    return [];
  }
}

/**
 * Reconcile local app state against the network on boot. For each stopped
 * container, checks whether this node still has a valid location record.
 * - Valid location: the app is handed to the reconciler, which expands it to
 *   per-component reconciles through the deployment layer (replicated
 *   components hold at awaitingController until a decider speaks).
 * - Expired/missing location: app removed locally (node was reassigned).
 * @returns {Promise<Object>} Results of the reconciliation
 */
async function reconcileAppsOnBoot() {
  const results = {
    appsChecked: 0,
    appsEnqueued: [],
    appsSkippedNotInstalled: [],
    appsRemoved: [],
    appsFailed: [],
  };

  try {
    log.info('appStartupManager - Starting boot reconciliation check');

    // Get all installed apps from database (just to get the list of app names)
    const installedApps = await getInstalledAppsFromDb();
    if (installedApps.length === 0) {
      log.info('appStartupManager - No installed apps found');
      return results;
    }

    // Create a set for quick lookup of installed app names
    const installedAppNames = new Set(installedApps.map((app) => app.name));

    // Get all stopped Flux containers + the apps they belong to.
    const stoppedContainers = await getStoppedFluxContainers();
    const appsWithStoppedContainers = new Set();
    for (const container of stoppedContainers) {
      const { appName } = parseContainerName(container.Names[0]);
      appsWithStoppedContainers.add(appName);
    }

    // Boot content recovery for EVERY installed app, BEFORE any container (re)starts (the
    // boot gate opens only after this function returns, so content writes land before any
    // start). Re-arms a pending future-dated rollout whose in-memory timer died with the
    // process — for a surviving container (a FluxOS process restart) as well as a stopped
    // one (a machine reboot) — and stages current content before start for a container that
    // is actually restarting. Runs even when nothing is stopped (the re-arm still matters).
    // Best-effort per app: a content failure must never block the app from starting on its
    // persisted on-disk content.
    for (const app of installedApps) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await contentSlotService.reconcileBootContent(app.name, { restarting: appsWithStoppedContainers.has(app.name) });
      } catch (contentError) {
        log.warn(`appStartupManager - boot content recovery for ${app.name} failed (starting on on-disk content) - ${contentError.message ?? contentError}`);
      }
    }

    // Reap follower apps (shared collectors) that no installed workload requires
    // any more — e.g. the workload was removed while the node was down. Runs on
    // every boot with installed apps (an orphan's containers are usually auto-
    // restarted, so the stopped-container early-return below must not skip it).
    // Detached and best-effort; boot recovery must not block on removals. Gated
    // off in production: the flux console owns the collector lifecycle.
    if (config.fluxapps.manageCollectorLifecycle) {
      appUninstaller.removeUnrequiredDependencies()
        .catch((error) => log.error(`appStartupManager - boot dependency cleanup failed: ${error.message}`));
    }

    if (stoppedContainers.length === 0) {
      log.info('appStartupManager - No stopped containers found');
      return results;
    }

    log.info(`appStartupManager - Found ${stoppedContainers.length} stopped Flux containers, belonging to ${appsWithStoppedContainers.size} app(s)`);

    // Get this node's IP for location checks
    const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();

    // Process each app
    // eslint-disable-next-line no-restricted-syntax
    for (const appName of appsWithStoppedContainers) {
      results.appsChecked += 1;

      log.info(`appStartupManager - Checking app ${appName}`);

      // Check if app is installed
      if (!installedAppNames.has(appName)) {
        log.warn(`appStartupManager - App ${appName} not in installed apps list, skipping all its containers`);
        results.appsSkippedNotInstalled.push(appName);
        // eslint-disable-next-line no-continue
        continue;
      }

      // Check if the app still has a valid location record for this node
      // If the node was offline longer than the TTL (~7 minutes after sigterm),
      // the location record expired and the app was respawned elsewhere
      if (localSocketAddr) {
        // eslint-disable-next-line no-await-in-loop
        const hasValidLocation = await appHasValidLocationOnNode(appName, localSocketAddr);
        if (!hasValidLocation) {
          log.warn(`appStartupManager - App ${appName} no longer has a valid location record for this node (${localSocketAddr}), removing locally`);
          try {
            // eslint-disable-next-line no-await-in-loop
            await appUninstaller.uninstallApplication(appName, { forceKill: true, skipGuard: true });
            results.appsRemoved.push(appName);
            log.info(`appStartupManager - App ${appName} removed locally (was reassigned to another node)`);
          } catch (removeError) {
            log.error(`appStartupManager - Failed to remove app ${appName}: ${removeError.message}`);
            results.appsFailed.push({ app: appName, error: removeError.message });
          }
          // eslint-disable-next-line no-await-in-loop
          await serviceHelper.delay(2000);
          // eslint-disable-next-line no-continue
          continue;
        }
      }

      // App has valid location - hand it to the reconciler, which expands it
      // to per-component reconciles through the deployment layer (component
      // names for encrypted v9 specs only exist behind decryption, which the
      // reconciler defer-retries until fluxbenchd serves it). It actuates once
      // the boot gate opens and applies desired-state + restart policy;
      // replicated components hold at awaitingController until a decider
      // speaks.
      log.info(`appStartupManager - App ${appName} has valid location, queued for reconcile`);
      appReconciler.enqueue(appName);
      results.appsEnqueued.push(appName);
    }

    log.info(
      'appStartupManager - Recovery complete. '
      + `Apps checked: ${results.appsChecked}, `
      + `Apps enqueued for reconcile: ${results.appsEnqueued.length}, `
      + `Apps removed (expired location): ${results.appsRemoved.length}, `
      + `Apps skipped (not installed): ${results.appsSkippedNotInstalled.length}, `
      + `Apps failed: ${results.appsFailed.length}`,
    );

    // Re-apply app-to-app network links (the network.shareWith spec field).
    // Idempotent and best-effort — defensive in case docker did not restore a
    // secondary network membership across the reboot.
    await appNetworkLinker.reconcileAllAppNetworkLinks();

    // Rebuild per-app telemetry routing from installed apps, (re)start the
    // daemon if any telemetry apps exist, and re-sync connected daemons.
    // Arcane-only; a no-op elsewhere.
    await telemetrySinkCache.reconcileFromInstalled();
    if (telemetrySinkCache.hasAnyTelemetryApps()) {
      await telemetryConfigService.ensureNode();
    }
    telemetryIdentityService.resyncAll();

    return results;
  } catch (error) {
    log.error(`appStartupManager - Critical error during recovery: ${error.message}`);
  }
}

async function removeAllApps(reason) {
  const appQueryService = require('../appQuery/appQueryService');
  const installedAppsRes = await appQueryService.installedApps();
  if (installedAppsRes.status === 'success') {
    for (const app of installedAppsRes.data) {
      log.warn(`REMOVAL REASON: ${reason} - removing ${app.name}`);
      // eslint-disable-next-line no-await-in-loop
      await appUninstaller.uninstallApplication(app.name, { forceKill: true, broadcastRemoval: true });
    }
  }
}

async function manageAppsOnBoot(bootContext) {
  try {
    if (bootContext.firstBoot) {
      log.info('appStartupManager - First boot (no heartbeat history), waiting for sync');
    } else {
      const locationsExpired = (bootContext.cleanShutdown && bootContext.downtimeMs > SIGTERM_EXPIRY_MS)
        || bootContext.downtimeMs > RUNNING_EXPIRY_MS;

      if (locationsExpired) {
        log.info(`appStartupManager - Locations expired (downtime ${Math.round(bootContext.downtimeMs / 1000)}s, cleanShutdown=${bootContext.cleanShutdown}), removing all apps`);
        await removeAllApps('Locations expired');
        return;
      }
    }

    // Locations still valid — wait for daemon + sync then reconcile.
    const DAEMON_TIMEOUT_MS = config.system.bootDaemonTimeoutMs ?? 300000;
    try {
      await Promise.race([
        globalState.waitForDaemonReady(),
        new Promise((_, reject) => { setTimeout(() => reject(new Error('daemon_timeout')), DAEMON_TIMEOUT_MS); }),
      ]);
    } catch (error) {
      if (error.message === 'daemon_timeout') {
        log.error(`appStartupManager - Daemon not ready after ${DAEMON_TIMEOUT_MS / 1000}s, removing all apps`);
        await removeAllApps('Daemon unavailable');
        return;
      }
      throw error;
    }

    await nodeConfirmationService.waitForConfirmationStatus();
    if (!nodeConfirmationService.isConfirmed()) {
      log.info('appStartupManager - Node not confirmed, removing all apps');
      await removeAllApps('Node not confirmed');
      return;
    }

    if (nodeDosState.isNodeDos()) {
      log.error('appStartupManager - Node is in DOS state, removing all apps');
      await removeAllApps('Node DOS');
      return;
    }

    try {
      await Promise.race([
        globalState.waitForDbReady(),
        new Promise((_, reject) => { setTimeout(() => reject(new Error('sync_timeout')), SYNC_TIMEOUT_MS); }),
      ]);
    } catch (error) {
      if (error.message === 'sync_timeout') {
        log.error(`appStartupManager - DB not ready after ${SYNC_TIMEOUT_MS / 1000}s, removing all apps`);
        await removeAllApps('Sync timeout');
        return;
      }
      throw error;
    }

    log.info('appStartupManager - Daemon, DB, and node confirmed, reconciling apps');
    await reconcileAppsOnBoot();
  } finally {
    globalState.bootContainerStateSettled = true;
    fluxEventBus.publish('boot:settled', {});
    log.info('appStartupManager - Boot container state settled');
  }
}

module.exports = {
  manageAppsOnBoot,
  reconcileAppsOnBoot,
  getStoppedFluxContainers,
  getInstalledAppsFromDb,
};
