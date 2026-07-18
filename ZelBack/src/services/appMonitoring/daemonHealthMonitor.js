const operationRegistry = require('../utils/operationRegistry');
const log = require('../../lib/log');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const appsRepository = require('../appDatabase/appsRepository');
const appUninstaller = require('../appLifecycle/appUninstaller');

// Module-level state tracking
let daemonUnsyncedSince = null;  // Timestamp when daemon became unsynced, or null if synced
let allAppsRemoved = false;

// Thresholds
const RUNTIME_THRESHOLD = 2 * 60 * 60 * 1000;  // 2 hours

/**
 * Removes all installed applications due to daemon failure
 * @param {string} reason - Reason for removal (for logging)
 */
async function removeAllApps(reason) {
  try {
    allAppsRemoved = true;  // Set flag to prevent repeated attempts

    const installedApps = await appsRepository.listInstalledApps();

    if (!installedApps || installedApps.length === 0) {
      log.info('No apps installed, nothing to remove');
      return;
    }

    log.warn(`Removing ${installedApps.length} applications due to daemon failure`);

    // Backgrounded removals: the host-mutation lock serializes the destructive
    // teardowns, so the wipe needs no self-pacing between apps.
    for (const app of installedApps) {
      log.warn(`REMOVAL REASON: Daemon failure - removing ${app.name} (${reason})`);
      try {
        // we probably won't have peers - but broadcast anyway
        await appUninstaller.uninstallApplication(app.name, {
          forceKill: true, skipGuard: true, broadcastRemoval: true, background: true,
        });
      } catch (error) {
        log.error(`Failed to remove ${app.name}: ${error.message}`);
        // Continue with next app even if one fails
      }
    }

    log.info('All applications removed due to daemon failure');
  } catch (error) {
    log.error(`Failed to remove apps during daemon failure cleanup: ${error.message}`);
  }
}

/**
 * Checks daemon health and removes all apps if daemon unsynced beyond threshold
 * Called periodically (every 15 minutes) from serviceManager
 */
async function checkDaemonHealthAndCleanup() {
  try {
    // Skip while ANY operation is in flight: the cleanup this watchdog can trigger
    // is a node-wide mass-removal of every installed app, so it must never run
    // concurrently with any install/remove/redeploy/reconcile/backup/restore.
    if (operationRegistry.anyHeld()) {
      return;
    }

    // Check daemon sync status (updated every 30 seconds by daemonServiceMiscRpcs)
    const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();

    if (syncStatus.data.synced) {
      // Daemon is synced - reset tracking
      if (daemonUnsyncedSince !== null) {
        log.info('Daemon sync recovered, resetting health monitor state');
      }
      daemonUnsyncedSince = null;
      allAppsRemoved = false;
      return;
    }

    // Daemon NOT synced
    if (daemonUnsyncedSince === null) {
      // Just became unsynced, start tracking
      log.warn('Daemon detected as unsynced, starting health monitoring');
      daemonUnsyncedSince = Date.now();
      return;
    }

    // Calculate how long daemon has been unsynced
    const unsyncedDuration = Date.now() - daemonUnsyncedSince;

    // Check if threshold exceeded
    if (unsyncedDuration >= RUNTIME_THRESHOLD && !allAppsRemoved) {
      const reason = 'Daemon not synced for 2+ hours';
      log.error(`CRITICAL: ${reason}. Removing all applications.`);
      await removeAllApps(reason);
    }
  } catch (error) {
    log.error(`Error in daemon health check: ${error.message}`);
  }
}

module.exports = {
  checkDaemonHealthAndCleanup,
};
