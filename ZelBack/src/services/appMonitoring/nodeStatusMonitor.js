'use strict';

// Node Status Monitor - removes every local app when this node is no longer a
// member: its daemon says it is not confirmed, its daemon has gone stale, or it
// is in DOS state. Membership is a chain fact every node reads the same way, so
// the node's own reading is the authority and nothing is corroborated.
//
// The network's view of OTHER nodes is not this module's business. A listed
// node that dies is certified by its jurors (nodeDownService); an address that
// leaves the node list is negated by every node's own derivation
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
 * Method responsible to monitor node status and uninstall apps if node is not confirmed
 * @param {string} reason - Why all local apps are being removed
 * @returns {Promise<void>}
 */
// eslint-disable-next-line consistent-return
async function removeAllAppsLocally(reason) {
  if (removalInProgress) return;
  removalInProgress = true;
  try {
    const installedAppsRes = await appQueryService.installedApps();
    if (installedAppsRes.status !== 'success') {
      throw new Error('monitorNodeStatus - Failed to get installed Apps');
    }
    const appsInstalled = installedAppsRes.data;
    const canBroadcast = nodeConfirmationService.canSendMessages();
    for (const installedApp of appsInstalled) {
      log.info(`monitorNodeStatus - Application ${installedApp.name} going to be removed: ${reason}`);
      log.warn(`monitorNodeStatus - Removing application ${installedApp.name} locally`);
      // eslint-disable-next-line no-await-in-loop
      await appUninstaller.uninstallApplication(installedApp.name, { forceKill: true, broadcastRemoval: canBroadcast });
      log.warn(`monitorNodeStatus - Application ${installedApp.name} locally removed`);
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(config.fluxapps.nodeMonitorRemovalDelayMs ?? 60000);
    }
  } finally {
    removalInProgress = false;
  }
}

function initialize() {
  nodeConfirmationService.onConfirmationChange((confirmed) => {
    if (!confirmed) {
      log.info('monitorNodeStatus - Confirmation lost, triggering immediate app removal');
      removeAllAppsLocally( 'node lost confirmation');
    }
  });
  nodeConfirmationService.onDaemonStale(() => {
    log.info('monitorNodeStatus - Daemon stale, triggering app removal');
    removeAllAppsLocally( 'daemon unreachable');
  });
}

async function monitorNodeStatus() {
  try {
    if (nodeDosState.isNodeDos()) {
      await removeAllAppsLocally( 'DOS state >= 100');
      await serviceHelper.delay(config.fluxapps.nodeMonitorDosRecoveryDelayMs ?? 600000);
      return monitorNodeStatus();
    }
    if (nodeConfirmationService.isDaemonStale()) {
      await removeAllAppsLocally( 'daemon unreachable (backstop)');
      await serviceHelper.delay(config.fluxapps.nodeMonitorConfirmationLossDelayMs ?? 1200000);
      return monitorNodeStatus();
    }
    if (!nodeConfirmationService.isConfirmed()) {
      await removeAllAppsLocally( 'node not confirmed');
      await serviceHelper.delay(config.fluxapps.nodeMonitorConfirmationLossDelayMs ?? 1200000);
      return monitorNodeStatus();
    }
    await serviceHelper.delay(config.fluxapps.nodeMonitorIntervalMs ?? 1200000);
    monitorNodeStatus();
  } catch (error) {
    log.error(error);
    await serviceHelper.delay(config.fluxapps.nodeMonitorErrorRecoveryDelayMs ?? 120000);
    monitorNodeStatus();
  }
}

module.exports = {
  initialize,
  monitorNodeStatus,
};
