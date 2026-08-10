'use strict';

const path = require('node:path');
const log = require('../../lib/log');

const serviceHelper = require('../serviceHelper');
const { appsFolder } = require('../utils/appConstants');

/**
 * Delete all data in the mount point for a specific app
 * @param {string} appId - Application ID
 * @returns {Promise<void>}
 */
async function appDeleteDataInMountPoint(appId, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  // Retry until the wipe SUCCEEDS rather than pre-sleeping a fixed "settle" window: a
  // just-stopped container can briefly still hold its appdata mount, so the delete fails —
  // and the delete completing IS the proof the mount was released. Immediate first attempt
  // (0ms when already free — no fixed settle tax), a fine fixed poll, bounded by a timeout;
  // success is keyed on the operation completing, not on parsing an error. The bare appdata
  // dir is recreated by appVolumeService.ensureMountSourcesExist before the next start.
  const appDataDir = path.join(appsFolder, appId, 'appdata');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const result = await serviceHelper.runCommand('rm', { params: ['-rf', appDataDir], runAsRoot: true, logError: false });
    if (!result.error) {
      log.info(`Deleted data for app ${appId}`);
      return;
    }
    if (Date.now() >= deadline) {
      log.error(`Error deleting data for app ${appId} after ${timeoutMs}ms: ${result.error.message}`);
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await serviceHelper.delay(intervalMs);
  }
}

module.exports = {
  appDeleteDataInMountPoint,
};
