'use strict';

const log = require('../../lib/log');
const capabilities = require('../utils/capabilities');
const appRecords = require('../appDatabase/appRecords');
const appUninstaller = require('../appLifecycle/appUninstaller');

// A node whose daemon has not been synced for this long removes every app.
const UNSYNCED_REMOVAL_MS = 2 * 60 * 60 * 1000;

let deadline = null;
let started = false;

/**
 * Removes all installed applications due to daemon failure.
 *
 * Each removal is the uninstaller's emergency removal (skipGuard): it cancels an
 * install of that app in flight, goes past any other operation on it, and never
 * starts a second teardown of an app already being removed.
 *
 * @param {string} reason - Reason for removal (for logging)
 */
async function removeAllApps(reason) {
  try {
    const installedApps = (await appRecords.hostedInstances().apps()).map((record) => record.record);

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
        // eslint-disable-next-line no-await-in-loop
        await appUninstaller.uninstallApplication(app.name, {
          forceKill: true, skipGuard: true, broadcastRemoval: true, background: true,
        });
      } catch (error) {
        log.error(`Failed to remove ${app.name}: ${error.message}`);
      }
    }

    log.info('All applications removed due to daemon failure');
  } catch (error) {
    log.error(`Failed to remove apps during daemon failure cleanup: ${error.message}`);
  }
}

async function onDeadline() {
  deadline = null;
  const reason = 'Daemon not synced for 2+ hours';
  log.error(`CRITICAL: ${reason}. Removing all applications.`);
  await removeAllApps(reason);
}

function armDeadline() {
  log.warn('Daemon not synced, apps are removed if it stays unsynced for 2 hours');
  deadline = setTimeout(() => {
    onDeadline().catch((error) => log.error(`Daemon health removal error: ${error.message}`));
  }, UNSYNCED_REMOVAL_MS);
}

function cancelDeadline() {
  if (!deadline) return;
  clearTimeout(deadline);
  deadline = null;
  log.info('Daemon synced again, app removal cancelled');
}

/**
 * Follows `daemonSynced`: each time it goes down a 2 hour deadline is armed, each
 * time it comes up the deadline is cancelled, and a deadline that fires removes
 * every app. Armed at once when the daemon is not synced as this starts.
 */
function start() {
  if (started) return;
  started = true;
  capabilities.onDown('daemonSynced', armDeadline);
  capabilities.onUp('daemonSynced', cancelDeadline);
  if (!capabilities.isUp('daemonSynced')) armDeadline();
}

module.exports = {
  start,
};
