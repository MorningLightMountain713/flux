const util = require('util');
const log = require('../../lib/log');

const cmdAsync = util.promisify(require('child_process').exec);

const { appsFolder } = require('../utils/appConstants');

/**
 * Delete all data in the mount point for a specific app
 * @param {string} appId - Application ID
 * @returns {Promise<void>}
 */
async function appDeleteDataInMountPoint(appId) {
  try {
    const execDelete = `sudo rm -rf ${appsFolder}${appId}/appdata/*`;
    await cmdAsync(execDelete);
    log.info(`Deleted data for app ${appId}`);
  } catch (error) {
    log.error(`Error deleting data for app ${appId}: ${error.message}`);
  }
}

module.exports = {
  appDeleteDataInMountPoint,
};
