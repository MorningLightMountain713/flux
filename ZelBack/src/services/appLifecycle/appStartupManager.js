'use strict';

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
const appsRepository = require('../appDatabase/appsRepository');
const nodeDosState = require('../nodeDosState');
const migrations = require('../migrations');
const appUninstaller = require('./appUninstaller');
const appNetworkLinker = require('./appNetworkLinker');
const appSlice = require('./appSlice');
const appPlacements = require('../appManagement/appPlacements');
const portManager = require('../appNetwork/portManager');
const meshReconciler = require('../appMesh/meshReconciler');
const { getSpecBackend } = require('../utils/specLibs');
const contentSlotService = require('./contentSlotService');
const telemetrySinkCache = require('../telemetrySinkCache');
const telemetryConfigService = require('../telemetryConfigService');
const telemetryIdentityService = require('../telemetryIdentityService');
const globalState = require('../utils/globalState');
const capabilities = require('../utils/capabilities');
const fluxEventBus = require('../utils/fluxEventBus');
const nodeConfirmationService = require('../nodeConfirmationService');
const { localAppsInformation, NODE_DOWN_GRACE_MS } = require('../utils/appConstants');
const { parseContainerName } = require('../utils/appUtilities');
const { untilSucceeds, BOOT_STEP_RETRY_MS } = require('../utils/untilSucceeds');

const SYNC_TIMEOUT_MS = config.get('system.bootSyncTimeoutMs');

/**
 * Await a promise, giving up after a deadline. The timer is cleared however the
 * race ends, so work that finishes early leaves nothing pending behind it.
 * @param {Promise<any>} work What to wait for.
 * @param {number} timeoutMs How long to wait.
 * @param {string} reason Message of the error thrown when the deadline passes.
 * @returns {Promise<any>} Whatever `work` resolved to.
 */
async function awaitWithin(work, timeoutMs, reason) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(reason)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Names of the apps installed on this node. Rejects when the installed apps
 * cannot be read: an empty answer would read as "nothing installed" — a boot
 * sweep with nothing to do, and every placement record taken for a stray.
 * @returns {Promise<Array<string>>}
 */
async function getInstalledAppNamesFromDb() {
  return appsRepository.listInstalledAppNames();
}

/**
 * Get all installed apps from local database
 * @returns {Promise<Array>} Array of installed app specifications
 */
async function getInstalledAppsFromDb() {
  const dbopen = dbHelper.databaseConnection();
  const appsDatabase = dbopen.db(config.database.appslocal.database);
  const appsQuery = {};
  const appsProjection = {
    projection: { _id: 0 },
  };
  const apps = await dbHelper.findInDatabase(appsDatabase, localAppsInformation, appsQuery, appsProjection);
  return apps || [];
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

    // Ours by the identity label, not by the shape of the name. The name test
    // it replaces also matched only `flux`, walking past every legacy `zel`
    // container on the node.
    const { LABEL_KEYS } = await getSpecBackend();
    const stoppedContainers = containers.filter((container) => {
      const managed = dockerService.isManagedContainer(
        { labels: container.Labels, name: container.Names?.[0] }, LABEL_KEYS,
      );
      // Check if container is stopped (State is 'exited' or not 'running')
      const isStopped = container.State !== 'running';
      return managed && isStopped;
    });

    return stoppedContainers;
  } catch (error) {
    log.error(`appStartupManager - Error getting stopped containers: ${error.message}`);
    return [];
  }
}

/**
 * Opens every installed app's ports in the firewall, in one ufw batch, before
 * the apps start. ufw keeps the rules across restarts and skips one it already
 * holds, so this changes nothing unless the rules were lost, as a ufw reset
 * loses them. An app whose specification cannot be read is left out and
 * logged; a failure is logged and the apps still start.
 */
async function openInstalledAppPorts() {
  try {
    const { apps, unreadable } = await portManager.appsWithPorts(await getInstalledAppsFromDb());
    if (unreadable.length) log.warn(`appStartupManager - ports of ${unreadable.length} installed app(s) not opened in the firewall: specification unreadable`);
    const ports = apps.flatMap((app) => app.ports).map((port) => serviceHelper.ensureNumber(port));
    if (!ports.length) return;
    const { failed, locked } = await fluxNetworkHelper.allowAppPorts(ports);
    if (locked) log.warn('appStartupManager - app ports not opened in the firewall: ufw is locked by another ufw command');
    failed.forEach(({ rule, error }) => log.warn(`appStartupManager - app port not opened in the firewall: ufw ${rule}: ${error}`));
  } catch (error) {
    log.error(`appStartupManager - app ports not opened in the firewall: ${error.message}`);
  }
}


/**
 * Whether this node's own derived rows still place it: the one question a node
 * asks after its sync and before any announce. The rows a certificate negated
 * once its grace ran, rows that expired while the node was away, and rows that
 * never existed all answer no together. A locked-out node — four certifications
 * standing — is not placed whatever its rows say: the lockout's self-uninstall.
 * @param {string} localSocketAddr
 * @returns {Promise<{placed: boolean, why: string}>} `why` says what a no rests on
 * @throws {Error} When the rows cannot be read.
 */
async function readPlacement(localSocketAddr) {
  // eslint-disable-next-line global-require
  const nodeDownStore = require('../appMessaging/nodeDownStore');
  const [rows, lockout] = await Promise.all([
    appsRepository.appLocationFromEvents({ ip: localSocketAddr }),
    nodeDownStore.lockoutForAddress(localSocketAddr),
  ]);
  if (lockout.lockedOut) return { placed: false, why: `locked out (${lockout.count} certifications standing)` };
  if (rows.length > 0) return { placed: true, why: '' };
  return { placed: false, why: `no row places ${localSocketAddr} any more, the network has moved on` };
}

/**
 * Removes every installed app because the network has moved on from this node.
 * Nothing is broadcast: the removal event's only reader is the derivation,
 * whose rows are already gone.
 * @param {string[]} installedApps
 * @returns {Promise<{removed: string[], failed: Array<{app: string, error: string}>}>}
 */
async function removeUnplacedApps(installedApps) {
  const removed = [];
  const failed = [];
  for (const appName of installedApps) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await appUninstaller.uninstallApplication(appName, { forceKill: true, skipGuard: true, broadcastRemoval: false });
      removed.push(appName);
    } catch (error) {
      log.error(`appStartupManager - failed to remove ${appName}: ${error.message}`);
      failed.push({ app: appName, error: error.message });
    }
  }
  return { removed, failed };
}

/**
 * The one question, asked at boot, on the return from total unreachability
 * after the resync, and on hearing a certificate about this node. Placed: every
 * app is kept and the caller announces. Not placed: every installed app is
 * removed, whatever its containers are doing, and nothing is broadcast. There is
 * no per-app test and no middle ground. A locked-out node takes the not-placed
 * branch whatever its rows say.
 *
 * A database wobble or a missing address is never the reason an app is deleted:
 * no address keeps every app, and rows that cannot be read answer `placed: null`,
 * which removes nothing and decides nothing.
 *
 * @param {string} trigger 'boot' | 'return' | 'certificate', journal only
 * @returns {Promise<{placed: boolean|null, removed: string[], failed: Array<{app: string, error: string}>}>}
 */
async function enforceNodePlacement(trigger) {
  const installedApps = await getInstalledAppNamesFromDb();
  if (installedApps.length === 0) return { placed: true, removed: [], failed: [] };
  const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
  if (!localSocketAddr) {
    log.warn(`appStartupManager - placement check (${trigger}) skipped: no local address`);
    return { placed: true, removed: [], failed: [] };
  }
  let placement;
  try {
    placement = await readPlacement(localSocketAddr);
  } catch (error) {
    log.error(`appStartupManager - placement check (${trigger}) could not read the rows, deciding nothing: ${error.message}`);
    return { placed: null, removed: [], failed: [] };
  }
  if (placement.placed) return { placed: true, removed: [], failed: [] };

  log.warn(`appStartupManager - placement check (${trigger}): ${placement.why}; removing ${installedApps.length} app(s), no broadcast`);
  return { placed: false, ...await removeUnplacedApps(installedApps) };
}

/**
 * Decides the apps boot held in globalState.unconfirmedApps because the
 * placement question could not be answered, asking it every BOOT_STEP_RETRY_MS
 * until it can. Placed: each app still held is released and handed to the
 * reconciler. Not placed: every installed app is removed. An app whose hold has
 * ended by then - uninstalled meanwhile, perhaps installed again since - is not
 * this check's to decide, and it does nothing to it.
 * @param {Map<string, symbol>} holds app name -> the hold boot set for it
 * @param {string} localSocketAddr
 * @returns {Promise<void>}
 */
async function confirmHeldApps(holds, localSocketAddr) {
  const isHeld = (appName) => globalState.unconfirmedApps.get(appName) === holds.get(appName);
  await serviceHelper.delay(BOOT_STEP_RETRY_MS);
  const { placed, why } = await untilSucceeds('Placement check', () => readPlacement(localSocketAddr));
  // eslint-disable-next-line no-restricted-syntax
  for (const appName of holds.keys()) {
    // eslint-disable-next-line no-await-in-loop
    await fluxEventBus.checkpoint(fluxEventBus.Checkpoint.BOOT_BEFORE_LOCATION_DECISION, appName);
  }
  if (placed) {
    // eslint-disable-next-line no-restricted-syntax
    for (const appName of holds.keys()) {
      if (!isHeld(appName)) {
        log.info(`appStartupManager - App ${appName}: its hold ended before the placement check answered, nothing to decide`);
        fluxEventBus.publish('boot:appConfirmed', { name: appName, valid: true, released: true });
      } else {
        log.info(`appStartupManager - App ${appName}: this node is still placed, starting it`);
        globalState.unconfirmedApps.delete(appName);
        fluxEventBus.publish('boot:appConfirmed', { name: appName, valid: true });
        appReconciler.enqueueApp(appName);
      }
    }
    return;
  }
  log.warn(`appStartupManager - placement check (boot): ${why}; removing every app, no broadcast`);
  holds.forEach((hold, appName) => fluxEventBus.publish('boot:appConfirmed', { name: appName, valid: false }));
  try {
    await removeUnplacedApps(await getInstalledAppNamesFromDb());
  } finally {
    holds.forEach((hold, appName) => { if (isHeld(appName)) globalState.unconfirmedApps.delete(appName); });
  }
}

/**
 * Reconcile local app state against the network on boot, after the node-level
 * placement question (enforceNodePlacement):
 * - Placed: each app with a stopped container is handed to the reconciler,
 *   which expands it to per-component reconciles through the deployment layer
 *   (replicated components hold at awaitingController until a decider speaks).
 * - Not placed: every installed app was removed by the question itself.
 * - Unanswerable: each app with a stopped container is held stopped until the
 *   question can be answered, then decided as above (confirmHeldApps).
 * @returns {Promise<Object>} Results of the reconciliation
 */
async function reconcileAppsOnBoot() {
  const results = {
    appsChecked: 0,
    appsEnqueued: [],
    appsSkippedNotInstalled: [],
    appsRemoved: [],
    appsUnconfirmed: [], // location unreadable: held stopped until it can be read
    appsFailed: [],
  };

  try {
    log.info('appStartupManager - Starting boot reconciliation check');

    const installedApps = await getInstalledAppNamesFromDb();
    if (installedApps.length === 0) {
      log.info('appStartupManager - No installed apps found');
      return results;
    }

    // Create a set for quick lookup of installed app names
    const installedAppNames = new Set(installedApps);

    // Get all stopped Flux containers + the apps they belong to. The app label
    // is the name's source of truth: a container's NAME embeds the app's minted
    // identity, which is not the app name and matches no installed row. Name
    // parsing remains only for pre-label legacy containers.
    const { LABEL_KEYS } = await getSpecBackend();
    const stoppedContainers = await getStoppedFluxContainers();
    const appsWithStoppedContainers = new Set();
    for (const container of stoppedContainers) {
      const appName = container.Labels?.[LABEL_KEYS.APP]
        ?? parseContainerName(container.Names[0]).appName;
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
    for (const installedAppName of installedApps) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await contentSlotService.reconcileBootContent(installedAppName, { restarting: appsWithStoppedContainers.has(installedAppName) });
      } catch (contentError) {
        log.warn(`appStartupManager - boot content recovery for ${installedAppName} failed (starting on on-disk content) - ${contentError.message ?? contentError}`);
      }
    }

    // Reap follower apps (shared collectors) that no installed workload requires
    // any more — e.g. the workload was removed while the node was down. Runs on
    // every boot with installed apps (an orphan's containers are usually auto-
    // restarted, so the stopped-container early-return below must not skip it).
    // Detached and best-effort; boot recovery must not block on removals. Gated
    // off in production: the flux console owns the collector lifecycle.
    if (config.get('fluxapps.manageCollectorLifecycle')) {
      appUninstaller.removeUnrequiredDependencies()
        .catch((error) => log.error(`appStartupManager - boot dependency cleanup failed: ${error.message}`));
    }

    // The node-level question, for every installed app whatever its
    // containers are doing — a FluxOS restart with nothing stopped included:
    // a node the network moved on from starts nothing and keeps nothing.
    const placement = await enforceNodePlacement('boot');
    if (placement.placed === false) {
      results.appsRemoved.push(...placement.removed);
      results.appsFailed.push(...placement.failed);
      return results;
    }

    if (stoppedContainers.length === 0) {
      log.info('appStartupManager - No stopped containers found');
      return results;
    }

    log.info(`appStartupManager - Found ${stoppedContainers.length} stopped Flux containers, belonging to ${appsWithStoppedContainers.size} app(s)`);

    // Whether the network still places this node is not known, so no stopped app
    // is started or removed until it is.
    const holds = new Map();

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

      if (placement.placed === null) {
        log.warn(`appStartupManager - App ${appName}: the placement check could not be answered, held stopped until it can be`);
        const hold = Symbol(appName);
        globalState.unconfirmedApps.set(appName, hold);
        holds.set(appName, hold);
        fluxEventBus.publish('boot:appUnconfirmed', { name: appName });
        results.appsUnconfirmed.push(appName);
        // eslint-disable-next-line no-continue
        continue;
      }

      // App has valid location - hand it to the reconciler, which expands it
      // to per-component reconciles through the deployment layer (component
      // names for encrypted v9 specs only exist behind decryption, which the
      // reconciler defer-retries until fluxbenchd serves it). It actuates once
      // the boot gate opens and applies desired-state + restart policy;
      // replicated components hold at awaitingController until a decider
      // speaks.
      log.info(`appStartupManager - App ${appName} has valid location, queued for reconcile`);
      appReconciler.enqueueApp(appName);
      results.appsEnqueued.push(appName);
    }

    if (holds.size) {
      const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
      confirmHeldApps(holds, localSocketAddr)
        .catch((error) => log.error(`appStartupManager - the placement check of the held apps stopped: ${error.message}`));
    }

    log.info(
      'appStartupManager - Recovery complete. '
      + `Apps checked: ${results.appsChecked}, `
      + `Apps enqueued for reconcile: ${results.appsEnqueued.length}, `
      + `Apps removed (expired location): ${results.appsRemoved.length}, `
      + `Apps held (location unreadable): ${results.appsUnconfirmed.length}, `
      + `Apps skipped (not installed): ${results.appsSkippedNotInstalled.length}, `
      + `Apps failed: ${results.appsFailed.length}`,
    );

    // Re-apply app-to-app network links (the network.shareWith spec field).
    // Idempotent and best-effort — defensive in case docker did not restore a
    // secondary network membership across the reboot.
    await appNetworkLinker.reconcileAllAppNetworkLinks();

    // Rebuild every mesh app's runtime — namespaces, veths, units, chains and
    // the resolver snapshot are all boot-volatile (/run is tmpfs, iptables is
    // not persisted). Level-based and best-effort like the link pass; the
    // periodic sweep re-drives anything that could not converge here.
    await meshReconciler.reconcileAllMeshApps().catch((e) => {
      log.error(`appStartupManager - mesh boot reconcile failed: ${e.message}`);
    });

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
      // One removal that never returns must not hold boot, or every app after it.
      // eslint-disable-next-line no-await-in-loop
      await appUninstaller.uninstallApplication(app.name, { forceKill: true, broadcastRemoval: true });
    }
  }
}

/**
 * Remove the placement records of apps not installed here, on every boot
 * whichever way it goes on. Run again until it succeeds.
 * @returns {Promise<void>}
 */
async function tidyPlacementsOnBoot() {
  await untilSucceeds('Removing stray placement records', async () => {
    await appPlacements.removeStrayPlacements(await getInstalledAppNamesFromDb());
  });
}

async function manageAppsOnBoot(bootContext) {
  capabilities.claim('bootReconcileDecided', 'appStartupManager').starting('deciding what this node keeps');
  try {
    await tidyPlacementsOnBoot();
    // ahead of every container start, so no slice in use can be empty here
    await appSlice.stopEmptySlices();
    if (bootContext.firstBoot) {
      log.info('appStartupManager - First boot (no heartbeat history), waiting for sync');
    } else if (bootContext.unreadable) {
      log.warn('appStartupManager - Boot context unreadable: whether locations expired is decided app by app');
    } else {
      // Every stop gets the same grace, announced or not: a node down longer
      // was replaced by the fleet at since + the grace, and the same constant
      // decides here before the sync. This is the fast path of the check the
      // sync then makes for real against the derived rows.
      const locationsExpired = bootContext.downtimeMs > NODE_DOWN_GRACE_MS;

      if (locationsExpired) {
        log.info(`appStartupManager - Locations expired (downtime ${Math.round(bootContext.downtimeMs / 1000)}s, cleanShutdown=${bootContext.cleanShutdown}), removing all apps`);
        await removeAllApps('Locations expired');
        return;
      }
    }

    // Locations still valid — wait for daemon + sync then reconcile.
    const DAEMON_TIMEOUT_MS = config.get('system.bootDaemonTimeoutMs');
    try {
      await awaitWithin(capabilities.whenUp('daemonReachable'), DAEMON_TIMEOUT_MS, 'daemon_timeout');
    } catch (error) {
      if (error.message === 'daemon_timeout') {
        log.error(`appStartupManager - Daemon not ready after ${DAEMON_TIMEOUT_MS / 1000}s, removing all apps`);
        await removeAllApps('Daemon unavailable');
        return;
      }
      throw error;
    }

    await capabilities.whenUp('confirmationStatusKnown');
    if (!nodeConfirmationService.isConfirmed()) {
      log.info('appStartupManager - Node not confirmed, removing all apps');
      await removeAllApps('Node not confirmed');
      return;
    }

    if (nodeDosState.isStickyDosHeldBy(nodeDosState.StickyDosOwner.HOST_STALL)) {
      log.error('appStartupManager - Node is out of service for a host stall; its own removal unloads the apps');
      return;
    }

    if (nodeDosState.isNodeDos()) {
      log.error('appStartupManager - Node is in DOS state, removing all apps');
      await removeAllApps('Node DOS');
      return;
    }

    try {
      await awaitWithin(capabilities.whenUp('appRegistryConsistent'), SYNC_TIMEOUT_MS, 'sync_timeout');
    } catch (error) {
      if (error.message === 'sync_timeout') {
        log.error(`appStartupManager - DB not ready after ${SYNC_TIMEOUT_MS / 1000}s, removing all apps`);
        await removeAllApps('Sync timeout');
        return;
      }
      throw error;
    }

    // The off-list register starts empty on every boot: sweep the row
    // addresses the current list does not carry so their grace runs from now.
    // Best effort — a sweep that fails is logged, and the apps still start.
    try {
      const swept = await appsRepository.sweepOffListRows();
      log.info(`appStartupManager - off-list boot sweep covered ${swept} row address(es)`);
    } catch (error) {
      log.warn(`appStartupManager - off-list boot sweep failed, the register starts empty: ${error.message}`);
    }

    // Anything that would rather act on a container while it is down runs here:
    // FluxOS keeps every container on RestartPolicy 'no', so after a host reboot
    // nothing is running until the reconcile below starts it. Never allowed to stop
    // that reconcile - a node that cannot migrate must still start its apps.
    await migrations.runBefore('bootReconcileDecided');

    log.info('appStartupManager - Daemon, DB, and node confirmed, reconciling apps');
    await openInstalledAppPorts();
    await reconcileAppsOnBoot();
  } finally {
    capabilities.claim('bootReconcileDecided', 'appStartupManager').raise('boot reconcile has decided what this node keeps');
    fluxEventBus.publish('boot:settled', {});
    log.info('appStartupManager - Boot container state settled');
  }
}

module.exports = {
  manageAppsOnBoot,
  openInstalledAppPorts,
  reconcileAppsOnBoot,
  enforceNodePlacement,
  getStoppedFluxContainers,
  getInstalledAppNamesFromDb,
};
