'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const log = require('../../lib/log');

const serviceHelper = require('../serviceHelper');
const { appsFolder } = require('../utils/appConstants');
const appDataEntries = require('../utils/appDataEntries');

/**
 * Delete the app's data in a component's volume, leaving the platform's entries
 * @param {string} appId - Application ID
 * @returns {Promise<void>}
 * @throws when the data could not be deleted before the timeout
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
      // Nothing to clear is not a failed clear, asked of the kernel: ENOENT and
      // ENOTDIR say there was nothing here to wipe. Anything else is this node
      // unable to ask, and an unanswered question is not an empty directory.
      // eslint-disable-next-line no-await-in-loop
      const absent = await fs.stat(volumeDir)
        .then(() => false)
        .catch((error) => error.code === 'ENOENT' || error.code === 'ENOTDIR');
      if (absent) {
        log.info(`No data to delete for app ${appId}`);
        return;
      }
      // Thrown, so the caller holds the clear and retries: a start must never
      // proceed onto data it was asked to remove.
      throw new Error(`Failed to delete data for app ${appId} after ${timeoutMs}ms: ${result.stderr || result.error.message}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await serviceHelper.delay(intervalMs);
  }
}

module.exports = {
  appDeleteDataInMountPoint,
};
