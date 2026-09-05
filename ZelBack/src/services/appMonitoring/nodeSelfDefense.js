'use strict';

// Node self-defence: this node removes every app it runs the moment it is no
// longer a member. Membership is a chain fact every node reads the same way,
// so the node's own reading is the authority and nothing is corroborated:
//   - its daemon says it is not confirmed (the status topic publishes on
//     change, so this arrives with the block that dropped it);
//   - its daemon has gone stale (nodeConfirmationService, DAEMON_STALE_MS);
//   - its own DOS score has crossed the limit (nodeDosState.onNodeDos).
// Each is an event; there is no loop. The boot path makes the same three
// checks before it starts anything (appStartupManager.manageAppsOnBoot).
//
// The network's view of OTHER nodes is not this module's business: a listed
// node that dies is certified by its jurors (nodeDownService); an address
// that leaves the node list is negated by every node's own derivation
// (offListDepartures). Neither needs a probe or an event from here.
const config = require('config');
const serviceHelper = require('../serviceHelper');
const nodeDosState = require('../nodeDosState');
const nodeConfirmationService = require('../nodeConfirmationService');
const log = require('../../lib/log');
const appUninstaller = require('../appLifecycle/appUninstaller');
const appQueryService = require('../appQuery/appQueryService');

let removalInProgress = false;

/**
 * Removes every installed app.
 *
 * Re-lists after each pass: an app installed while the sweep ran, or one the
 * uninstaller deferred, is not in the first list. Stops when a pass finds
 * nothing, or removes nothing — what stayed is returned and logged by name
 * with the uninstaller's own answer, so a stuck app is a fact in the log and
 * not a "removed" that never happened. A second trigger during a sweep is
 * folded into it: the running sweep re-lists until nothing is left, so it sees
 * whatever the second trigger saw.
 *
 * @param {string} reason why this node is no longer a member
 * @returns {Promise<{removed: number, remaining: Array<{name: string, status: string, reason: string|null}>, folded?: boolean}>}
 */
async function removeAllAppsLocally(reason) {
  if (removalInProgress) return { removed: 0, remaining: [], folded: true };
  removalInProgress = true;
  const canBroadcast = nodeConfirmationService.canSendMessages();
  let removed = 0;
  let remaining = [];
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const installedAppsRes = await appQueryService.installedApps();
      if (installedAppsRes.status !== 'success') {
        throw new Error(`failed to list installed apps: ${installedAppsRes.data?.message ?? installedAppsRes.data}`);
      }
      const apps = installedAppsRes.data;
      if (apps.length === 0) break;

      let removedThisPass = 0;
      remaining = [];
      for (const app of apps) {
        log.warn(`nodeSelfDefense - removing ${app.name}: ${reason}`);
        // eslint-disable-next-line no-await-in-loop
        const result = await appUninstaller.uninstallApplication(app.name, { forceKill: true, broadcastRemoval: canBroadcast });
        if (result.status === appUninstaller.UninstallStatus.REMOVED) {
          removedThisPass += 1;
          log.warn(`nodeSelfDefense - ${app.name} removed`);
        } else if (result.status !== appUninstaller.UninstallStatus.SKIPPED) {
          remaining.push({ name: app.name, status: result.status, reason: result.reason ?? null });
        }
        // eslint-disable-next-line no-await-in-loop
        await serviceHelper.delay(config.fluxapps.nodeMonitorRemovalDelayMs ?? 60000);
      }
      removed += removedThisPass;
      if (removedThisPass === 0) break;
    }
  } finally {
    removalInProgress = false;
  }

  if (remaining.length) {
    const named = remaining.map((app) => `${app.name}=${app.status}${app.reason ? ` (${app.reason})` : ''}`).join(', ');
    log.error(`nodeSelfDefense - ${remaining.length} app(s) stayed after the sweep (${reason}): ${named}`);
  } else {
    log.info(`nodeSelfDefense - every app removed (${reason}): ${removed}`);
  }
  return { removed, remaining };
}

function sweep(reason) {
  return removeAllAppsLocally(reason).catch((error) => {
    log.error(`nodeSelfDefense - sweep failed (${reason}): ${error.message}`);
  });
}

function initialize() {
  nodeConfirmationService.onConfirmationChange((confirmed) => {
    if (confirmed) return undefined;
    log.info('nodeSelfDefense - confirmation lost, removing every app');
    return sweep('node lost confirmation');
  });
  nodeConfirmationService.onDaemonStale(() => {
    log.info('nodeSelfDefense - daemon stale, removing every app');
    return sweep('daemon unreachable');
  });
  nodeDosState.onNodeDos(() => {
    log.info('nodeSelfDefense - DOS state reached the limit, removing every app');
    return sweep('DOS state >= 100');
  });
}

module.exports = {
  initialize,
  removeAllAppsLocally,
};
