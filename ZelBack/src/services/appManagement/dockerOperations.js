'use strict';

const path = require('node:path');
const log = require('../../lib/log');

const serviceHelper = require('../serviceHelper');
const { appsFolder } = require('../utils/appConstants');
const appDataEntries = require('../utils/appDataEntries');

/**
 * Delete the app's data in a component's volume, leaving the platform's entries
 * @param {string} appId - Application ID
 * @returns {Promise<void>}
 */
async function appDeleteDataInMountPoint(appId, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  // Retry until the wipe SUCCEEDS rather than pre-sleeping a fixed "settle" window: a
  // just-stopped container can briefly still hold a bind mount, so the delete fails —
  // and the delete completing IS the proof the mount was released. Immediate first attempt
  // (0ms when already free — no fixed settle tax), a fine fixed poll, bounded by a timeout;
  // success is keyed on the operation completing, not on parsing an error. The mount
  // sources are recreated by appVolumeService.ensureMountSourcesExist before the next start.
  const volumeDir = path.join(appsFolder, appId);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const result = await appDataEntries.wipeAppData(volumeDir);
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
