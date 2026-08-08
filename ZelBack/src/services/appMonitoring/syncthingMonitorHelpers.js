// Syncthing Monitor - Helper Functions
const axios = require('axios');
const fs = require('node:fs/promises');
const path = require('node:path');
const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');
const dockerService = require('../dockerService');
const syncthingService = require('../syncthingService');
const volumeService = require('../utils/volumeService');
const {
  DEVICE_ID_REQUEST_TIMEOUT_MS,
  SYNCTHING_RESCAN_INTERVAL_SECONDS,
  SYNCTHING_MAX_CONFLICTS,
} = require('./syncthingMonitorConstants');
const { normalizeSocketAddress, extractIp, extractPort, socketAddressesMatch } = require('../utils/socketAddressUtils');

/**
 * Helper function to get device ID from remote node with retry capability
 * @param {string} fluxIP - IP address of the remote node
 * @param {number} retries - Number of retries (default: 0)
 * @returns {Promise<string|null>} Device ID or null
 */
async function getDeviceID(fluxIP, retries = 0) {
  try {
    const axiosConfig = {
      timeout: DEVICE_ID_REQUEST_TIMEOUT_MS,
    };
    const response = await axios.get(`http://${fluxIP}/syncthing/deviceid`, axiosConfig);
    if (response.data.status === 'success') {
      return response.data.data;
    }
    throw new Error(`Unable to get deviceid from ${fluxIP}`);
  } catch (error) {
    if (retries > 0) {
      log.warn(`Failed to get device ID from ${fluxIP}, retrying... (${retries} attempts left)`);
      // eslint-disable-next-line no-promise-executor-return
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return getDeviceID(fluxIP, retries - 1);
    }
    log.error(`Failed to get device ID from ${fluxIP}: ${error.message}`);
    return null;
  }
}

/**
 * Get device ID with caching
 * @param {string} name - Device name (IP:port)
 * @param {Map} cache - Cache map
 * @returns {Promise<string|null>} Device ID or null
 */
async function getDeviceIDCached(name, cache) {
  if (cache.has(name)) {
    return cache.get(name);
  }

  const deviceID = await getDeviceID(name);
  if (deviceID) {
    cache.set(name, deviceID);
  }
  return deviceID;
}

/**
 * Sort and filter app locations
 * @param {Array} locations - App locations
 * @param {string} localSocketAddr - Current node IP
 * @returns {Array} Sorted and filtered locations (excluding current node)
 */
function sortAndFilterLocations(locations, localSocketAddr) {
  return locations
    .sort((a, b) => {
      const addrA = normalizeSocketAddress(a.ip);
      const addrB = normalizeSocketAddress(b.ip);
      if (addrA < addrB) return -1;
      if (addrA > addrB) return 1;
      return 0;
    })
    .filter((loc) => !socketAddressesMatch(loc.ip, localSocketAddr));
}

/**
 * Sort running app list for leader election
 * @param {Array} runningAppList - List of running apps
 * @returns {Array} Sorted list
 */
function sortRunningAppList(runningAppList) {
  return [...runningAppList].sort((a, b) => {
    if (!a.runningSince && b.runningSince) return -1;
    if (a.runningSince && !b.runningSince) return 1;
    if (a.runningSince < b.runningSince) return -1;
    if (a.runningSince > b.runningSince) return 1;
    if (a.broadcastedAt < b.broadcastedAt) return -1;
    if (a.broadcastedAt > b.broadcastedAt) return 1;
    if (a.ip < b.ip) return -1;
    if (a.ip > b.ip) return 1;
    return 0;
  });
}

/**
 * Build device configuration from locations
 * @param {Array} locations - App locations
 * @param {string} localSocketAddr - Current node IP
 * @param {string} myDeviceId - Current node device ID
 * @param {Map} deviceCache - Device ID cache
 * @param {Array} devicesConfiguration - Array to populate with devices
 * @param {Array} devicesIds - Array to populate with device IDs
 * @param {Array} allDevicesResp - Existing syncthing devices
 * @returns {Promise<Array>} Array of device objects for folder configuration
 */
async function buildDeviceConfiguration(
  locations,
  localSocketAddr,
  myDeviceId,
  deviceCache,
  devicesConfiguration,
  devicesIds,
  allDevicesResp,
) {
  const devices = [{ deviceID: myDeviceId }];

  // Parallelize device ID fetching
  const devicePromises = locations.map(async (appInstance) => {
    const ip = extractIp(appInstance.ip);
    const port = extractPort(appInstance.ip);
    const addresses = [`tcp://${ip}:${port + 2}`, `quic://${ip}:${port + 2}`];
    const name = `${ip}:${port}`;

    const deviceID = await getDeviceIDCached(name, deviceCache);

    if (!deviceID) {
      return null;
    }

    return {
      deviceID,
      name,
      addresses,
      ip: appInstance.ip,
    };
  });

  const resolvedDevices = await Promise.all(devicePromises);

  // Process resolved devices
  // eslint-disable-next-line no-restricted-syntax
  for (const deviceInfo of resolvedDevices) {
    // eslint-disable-next-line no-continue
    if (!deviceInfo) continue;

    const { deviceID, name, addresses } = deviceInfo;

    // Add to folder devices if not already present and not my ID
    if (deviceID !== myDeviceId) {
      const folderDeviceExists = devices.find((device) => device.deviceID === deviceID);
      if (!folderDeviceExists) {
        devices.push({ deviceID });
      }
    }

    // Add to global devices configuration if not already configured
    const deviceExists = devicesConfiguration.find((device) => device.name === name);
    if (!deviceExists) {
      const newDevice = {
        deviceID,
        name,
        addresses,
        autoAcceptFolders: true,
      };
      devicesIds.push(deviceID);

      if (deviceID !== myDeviceId) {
        const syncthingDeviceExists = allDevicesResp.data.find((device) => device.name === name);
        if (!syncthingDeviceExists) {
          devicesConfiguration.push(newDevice);
        }
      }
    }
  }

  return devices;
}

/**
 * Create Syncthing folder configuration
 * @param {string} id - Folder ID
 * @param {string} label - Folder label
 * @param {string} path - Folder path
 * @param {Array} devices - Array of device objects
 * @param {string} type - Folder type (sendreceive, receiveonly)
 * @returns {Object} Syncthing folder configuration
 */
function createSyncthingFolderConfig(id, label, path, devices, type = 'sendreceive') {
  return {
    id,
    label,
    path,
    devices,
    paused: false,
    type,
    rescanIntervalS: SYNCTHING_RESCAN_INTERVAL_SECONDS,
    maxConflicts: SYNCTHING_MAX_CONFLICTS,
  };
}

/**
 * Ensure the .stfolder marker exists - ONLY inside the mounted volume. The
 * marker is syncthing's own guard against syncing a missing folder: creating
 * it on the bare mountpoint re-arms syncthing onto the host filesystem and
 * defeats that guard (this exact leak re-armed a sync onto the rootfs in the
 * 2026-07-01 data-loss incident).
 * @param {string} folder - Folder path
 * @returns {Promise<boolean>} True if the marker exists in a mounted volume
 */
async function ensureStfolderExists(folder) {
  const mounted = await volumeService.isPathMounted(folder);
  if (!mounted) {
    log.error(`ensureStfolderExists - ${folder} is not a mountpoint; refusing to create .stfolder on the bare directory`);
    return false;
  }
  // creation is a one-time setup act: when the marker is already present in
  // the mounted volume there is nothing to do (and nothing to log)
  const marker = path.join(folder, '.stfolder');
  const exists = await fs.stat(marker).then((stats) => stats.isDirectory()).catch(() => false);
  if (exists) return true;

  const mkdir = await serviceHelper.runCommand('mkdir', { runAsRoot: true, params: ['-p', marker] });
  if (mkdir.error) {
    log.error(`ensureStfolderExists - failed to create .stfolder in ${folder}: ${mkdir.error.message}`);
    return false;
  }
  log.info(`ensureStfolderExists - created .stfolder in ${folder}`);
  return true;
}

/**
 * Parse container data to extract folder path
 * Primary mount goes to /appdata, additional mounts are at same level as appdata
 * @param {Array} containersData - Container data array
 * @param {number} index - Current container index
 * @returns {string} Container folder path
 */
function getContainerFolderPath(containersData, index) {
  if (index === 0) {
    return '/appdata';
  }
  const container = containersData[index];
  return container.split(':')[1].replace(containersData[0], '');
}

/**
 * Check if folder configuration needs update
 * @param {Object} existingFolder - Existing folder config
 * @param {Object} newFolder - New folder config
 * @returns {boolean} True if update is needed
 */
function folderNeedsUpdate(existingFolder, newFolder) {
  if (!existingFolder) {
    return true;
  }

  return (
    existingFolder.maxConflicts !== SYNCTHING_MAX_CONFLICTS
    || existingFolder.paused
    || existingFolder.type !== newFolder.type
    || JSON.stringify(existingFolder.devices) !== JSON.stringify(newFolder.devices)
  );
}

const fluxDirPath = process.env.FLUXOS_PATH || path.join(process.env.HOME, 'zelflux');
const appsFolderPath = process.env.FLUX_APPS_FOLDER || path.join(fluxDirPath, 'ZelApps');
const appsFolder = `${appsFolderPath}/`;

function emitFolderStatus(res, status) {
  // the human text goes to the journal; the object shape is the stream's contract
  log.info(typeof status === 'string' ? status : status.status);
  if (res) {
    res.write(serviceHelper.ensureString(status));
    if (res.flush) res.flush();
  }
}

/**
 * Remove a component's syncthing folder registration (config-plane only — the
 * on-disk volume is untouched; the monitor re-adds the folder while the spec
 * still declares sync). Folders are registered per component as
 * flux<identifier>, so composed apps must be removed component by component —
 * the bare app name matches nothing for them.
 *
 * @param {string} appComponentName - component identifier (flat app name for v1-3 specs)
 * @param {object} [res] - optional response stream for status lines
 */
async function removeSyncthingFolder(appComponentName, res) {
  try {
    const identifier = appComponentName;
    const appId = dockerService.getAppIdentifier(identifier);
    const folder = `${appsFolder + appId}`;
    const allSyncthingFolders = await syncthingService.getConfigFolders();
    if (allSyncthingFolders.status === 'error') {
      return;
    }
    let folderId = null;
    for (const syncthingFolder of allSyncthingFolders.data) {
      if (syncthingFolder.path === folder || syncthingFolder.path.includes(`${folder}/`)) {
        folderId = syncthingFolder.id;
      }
      if (folderId) {
        // eslint-disable-next-line no-await-in-loop
        await syncthingService.adjustConfigFolders('delete', undefined, folderId);
        // eslint-disable-next-line no-await-in-loop
        const restartRequired = await syncthingService.getConfigRestartRequired();
        if (restartRequired.status === 'success' && restartRequired.data.requiresRestart === true) {
          log.info('Syncthing restart required, restarting...');
          // eslint-disable-next-line no-await-in-loop
          await syncthingService.systemRestart();
        }
        emitFolderStatus(res, { status: `Stopping syncthing on folder ${syncthingFolder.path}...` });
        emitFolderStatus(res, { status: 'Syncthing adjusted' });
      }
      folderId = null;
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * Best-effort request for an immediate scan of a component's syncthing folder.
 * Syncthing reloads .stignore before each scan, so this makes a changed ignore
 * set enforce right away instead of waiting for the watcher delay or the
 * rescan interval. Never throws — the watcher/rescan remains the fallback.
 *
 * @param {string} appComponentName - component identifier
 */
async function requestFolderScan(appComponentName) {
  try {
    await syncthingService.dbScan(dockerService.getAppIdentifier(appComponentName));
  } catch (error) {
    log.warn(`requestFolderScan: syncthing scan request for ${appComponentName} failed - ${error.message ?? error}`);
  }
}

module.exports = {
  getDeviceID,
  getDeviceIDCached,
  sortAndFilterLocations,
  sortRunningAppList,
  buildDeviceConfiguration,
  createSyncthingFolderConfig,
  ensureStfolderExists,
  getContainerFolderPath,
  folderNeedsUpdate,
  removeSyncthingFolder,
  requestFolderScan,
};
