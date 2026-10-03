'use strict';

// Syncthing Monitor - Helper Functions
const axios = require('axios');
const fs = require('node:fs/promises');
const path = require('node:path');
const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');
const dockerService = require('../dockerService');
const syncthingService = require('../syncthingService');
const { ConfigMethod } = require('../utils/syncthingConstants');
const volumeService = require('../utils/volumeService');
const peerIdentityService = require('../peerIdentityService');
const fluxEventBus = require('../utils/fluxEventBus');
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
 * The syncthing device of the node at `name`.
 *
 * A peer that proves it is the node listed at `name` is believed about its
 * device, and what it signs replaces whatever was held for the address. So is a
 * peer that proved it by calling in - its introduction - which is how a node
 * whose own calls are redirected learns its partners: their connections to it
 * arrive intact, and syncthing needs only one direction to sync. A call to
 * `name` that another node answered, with no introduction to go on, yields no
 * device: configuring the answering node's device under this name leaves the
 * folder syncing with a device that holds no copy of it. A peer that cannot
 * prove either way is asked the unsigned way.
 *
 * A node listed at `name` that gives no device - its FluxOS does not answer, or
 * its syncthing has not answered it - keeps the device syncthing has configured
 * under `name`, so a holder stays in its folders for as long as it is listed.
 *
 * Every call counts where its answer came from under `syncthing:deviceSource`,
 * keyed by `name`: verified, verifiedNoDevice, introduced, withheld, held,
 * unsigned or configured.
 *
 * @param {string} name - Device name (IP:port)
 * @param {Map} cache - Cache map
 * @param {string|null} [configured] - The device syncthing has configured under
 *   `name`, when exactly one is
 * @returns {Promise<string|null>} Device ID or null
 */
async function getDeviceIDCached(name, cache, configured = null) {
  const { IdentityVerdict } = peerIdentityService;
  const from = (source, deviceID) => {
    fluxEventBus.count('syncthing:deviceSource', name, source);
    return deviceID;
  };
  const result = await peerIdentityService.verifyPeer(name);

  if (result.verdict === IdentityVerdict.VERIFIED) {
    const signedDeviceID = result.identity.deviceId;
    // Verified with no device: that node's syncthing has not answered it yet.
    // What was held stands until it has.
    if (!signedDeviceID) {
      if (cache.has(name)) return from('verifiedNoDevice', cache.get(name));
      return configured ? from('configured', configured) : from('verifiedNoDevice', null);
    }
    cache.set(name, signedDeviceID);
    return from('verified', signedDeviceID);
  }

  const introduced = peerIdentityService.introducedPeer(name);
  if (introduced?.deviceId) {
    cache.set(name, introduced.deviceId);
    return from('introduced', introduced.deviceId);
  }

  if (result.verdict === IdentityVerdict.MISROUTED) {
    cache.delete(name);
    log.warn(`getDeviceIDCached - ${name} was answered by ${result.answeredAs}; configuring no device for it`);
    return from('withheld', null);
  }

  if (cache.has(name)) {
    return from('held', cache.get(name));
  }

  const deviceID = await getDeviceID(name);
  if (deviceID) {
    cache.set(name, deviceID);
    return from('unsigned', deviceID);
  }
  return configured ? from('configured', configured) : from('unsigned', null);
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
 * The addresses a peer's syncthing is reached at: TCP alone. Every node
 * publishes its syncthing port for TCP, and the network's check of a node
 * requires it. Over QUIC, syncthing learns that the peer which dialled a
 * connection has stopped only at QUIC's idle timeout, 30 s, and until then
 * this node reads the peer as running and its own turn as not yet due.
 * @param {string} ip Peer IP
 * @param {number} port Peer API port
 * @returns {string[]}
 */
function peerSyncthingAddresses(ip, port) {
  return [`tcp://${ip}:${port + 2}`];
}

/**
 * Build device configuration from locations
 * @param {Array} locations - App locations
 * @param {string} localSocketAddr - Current node IP
 * @param {string} myDeviceId - Current node device ID
 * @param {Map} deviceCache - Device ID cache
 * @param {Array} devicesConfiguration - Array to populate with devices
 * @param {Array} devicesIds - Array to populate with device IDs
 * @param {Array} allDevices - Existing syncthing devices
 * @param {string|null} [fencedHost] - Bare IP struck off the folder until its own
 *   attestation re-admits it; null leaves every device in place.
 * @returns {Promise<Array>} Array of device objects for folder configuration
 */
async function buildDeviceConfiguration(
  locations,
  localSocketAddr,
  myDeviceId,
  deviceCache,
  devicesConfiguration,
  devicesIds,
  allDevices,
  fencedHost = null,
) {
  const devices = [{ deviceID: myDeviceId }];

  // Parallelize device ID fetching
  const devicePromises = locations.map(async (appInstance) => {
    const ip = extractIp(appInstance.ip);
    const port = extractPort(appInstance.ip);
    const addresses = peerSyncthingAddresses(ip, port);
    const name = `${ip}:${port}`;

    const underName = allDevices.filter((device) => device.name === name);
    const configured = underName.length === 1 ? underName[0].deviceID : null;
    const deviceID = await getDeviceIDCached(name, deviceCache, configured);

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

    // Add to folder devices if not already present and not my ID. A FENCED
    // device is deliberately left off the folder's list: it belongs to a
    // deposed master that has not yet attested demote-and-revert, and a
    // folder that still names it would keep accepting its writes. Its global
    // device entry stays — the fence is per-folder, never per-device.
    const fenced = fencedHost && extractIp(deviceInfo.ip) === fencedHost;
    if (deviceID !== myDeviceId && !fenced) {
      const folderDeviceExists = devices.find((device) => device.deviceID === deviceID);
      if (!folderDeviceExists) {
        devices.push({ deviceID });
      }
    }

    // Add to global devices configuration if not already configured
    const deviceExists = devicesConfiguration.find((device) => device.name === name);
    if (!deviceExists) {
      // Folders are never auto-accepted: FluxOS creates every folder itself,
      // with its type and its peers. A folder a peer offers before then waits as
      // pending. Accepted, syncthing would create it with its default type,
      // sendreceive, and a new standby's empty copy - wiped clean for the
      // install - would go out as newer than the primary's data, which the
      // primary would then delete.
      const newDevice = {
        deviceID,
        name,
        addresses,
        autoAcceptFolders: false,
      };
      devicesIds.push(deviceID);

      // Matched on the id as well as the name: an entry under this name that
      // holds a different device is not this device. Once this one replaces it
      // no folder uses it, and it falls to the sweep of unused devices.
      if (deviceID !== myDeviceId) {
        const syncthingDeviceExists = allDevices.find((device) => device.name === name && device.deviceID === deviceID);
        if (!syncthingDeviceExists) {
          devicesConfiguration.push(newDevice);
        }
      }
    }
  }

  return devices;
}

/**
 * The settings every folder FluxOS owns carries, on creation and on every write
 * that changes its type. syncthing re-applies its own defaults to the fields a
 * type or ownership change leaves out of the body, and its default of ten
 * conflict copies puts renamed losers into a single-writer app's data.
 * syncOwnership makes a synced file arrive owned by the uid that wrote it on
 * the primary, so the same image writes it there without a permissions sweep.
 */
const OWNED_FOLDER_SETTINGS = Object.freeze({
  rescanIntervalS: SYNCTHING_RESCAN_INTERVAL_SECONDS,
  maxConflicts: SYNCTHING_MAX_CONFLICTS,
  syncOwnership: true,
});

/**
 * The fields of a folder's syncthing configuration the monitor owns. Its type
 * is decided separately: by the monitor for an r: folder, by the primary role
 * for a g: folder.
 * @param {string} id - Folder ID
 * @param {string} label - Folder label
 * @param {string} path - Folder path
 * @param {Array} devices - Array of device objects
 * @returns {Object} Syncthing folder configuration, without a type
 */
function createSyncthingFolderConfig(id, label, path, devices) {
  return {
    id,
    label,
    path,
    devices,
    paused: false,
    ...OWNED_FOLDER_SETTINGS,
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
 * Whether two folder device lists name the same devices. Syncthing returns a
 * folder's devices sorted, once each, with fields FluxOS never sets; the device
 * IDs are what the monitor writes.
 * @param {Array<{deviceID: string}>} [held]
 * @param {Array<{deviceID: string}>} [wanted]
 * @returns {boolean}
 */
function sameDevices(held = [], wanted = []) {
  const heldIds = new Set(held.map((device) => device.deviceID));
  const wantedIds = new Set(wanted.map((device) => device.deviceID));
  return heldIds.size === wantedIds.size && [...wantedIds].every((id) => heldIds.has(id));
}

/**
 * Whether syncthing holds a folder differently from the config the monitor
 * built for it: any field of that config that differs, its devices compared as
 * the devices they name and every other field by value. A field the config
 * leaves out - a g: folder's type - is not the monitor's to compare.
 * @param {Object} existingFolder - The folder as syncthing holds it
 * @param {Object} newFolder - The config the monitor built for it
 * @returns {boolean} True if update is needed
 */
function folderNeedsUpdate(existingFolder, newFolder) {
  if (!existingFolder) {
    return true;
  }
  return Object.entries(newFolder).some(([field, value]) => (field === 'devices'
    ? !sameDevices(existingFolder.devices, value)
    : existingFolder[field] !== value));
}

const fluxDirPath = process.env.FLUXOS_PATH || path.join(process.env.HOME, 'zelflux');
const appsFolderPath = process.env.FLUX_APPS_FOLDER || path.join(fluxDirPath, 'ZelApps');
const appsFolder = `${appsFolderPath}/`;

/**
 * @param {function(string): void} [report] - told what the removal is doing
 * @param {string|object} status
 */
function emitFolderStatus(report, status) {
  const text = typeof status === 'string' ? status : status.status;
  log.info(text);
  if (report) report(text);
}

/**
 * Freeze or unfreeze one component's syncthing folder.
 *
 * Pausing stops that folder's runner, and so every write into its directory,
 * while leaving the folder's configuration in place. That is what an operation
 * taking a consistent copy needs, and it is REVERSIBLE: removing the folder
 * instead discards the config, and the only thing that ever rebuilds it is the
 * monitor's per-app pass - so on a node where that pass cannot complete, the app
 * keeps running and silently stops being replicated.
 *
 * Scoped to the one folder: the daemon and every other folder keep running, and
 * a paused folder never sets syncthing's restart-required latch, so no process
 * restart is involved.
 *
 * Reports rather than throws. A caller pausing is about to do the work anyway
 * and needs to know it is unprotected; a caller resuming is usually in a catch,
 * where throwing would replace the error that brought it there.
 *
 * @param {string} appComponentName - component identifier (flat app name for v1-3 specs)
 * @param {boolean} paused - the state to leave the folder in
 * @param {function(string): void} [report] - told what happened
 * @returns {Promise<'held'|'resumed'|'absent'|'failed'>} 'held' or 'resumed' when
 *   syncthing accepted it; 'absent' when no folder is configured, so there is
 *   nothing replicating to hold still; 'failed' when the folder may be live and
 *   unheld
 */
async function setSyncthingFolderPaused(appComponentName, paused, report) {
  const verb = paused ? 'pause' : 'resume';
  try {
    const appId = dockerService.getAppIdentifier(appComponentName);
    const folder = `${appsFolder + appId}`;
    const allSyncthingFolders = await syncthingService.getConfigFolders();
    if (!Array.isArray(allSyncthingFolders)) return 'failed';

    const match = allSyncthingFolders.find(
      (f) => f.path === folder || f.path.includes(`${folder}/`),
    );
    if (!match) {
      // Nothing configured is not a failure to pause - there is no sync to
      // stop - but a resume that finds nothing means the folder went while the
      // operation held it, which the caller cannot fix and should see.
      if (!paused) emitFolderStatus(report, { status: `Syncthing folder for ${appComponentName} is gone; nothing to resume` });
      return 'absent';
    }

    await syncthingService.adjustConfigFolders({
      method: ConfigMethod.PATCH, config: { paused }, id: match.id,
    });
    emitFolderStatus(report, { status: `Syncthing ${paused ? 'paused' : 'resumed'} for ${appComponentName}` });
    return paused ? 'held' : 'resumed';
  } catch (error) {
    log.error(`setSyncthingFolderPaused - could not ${verb} ${appComponentName}: ${error.message}`);
    emitFolderStatus(report, { status: `Syncthing could not be ${paused ? 'paused' : 'resumed'} for ${appComponentName}` });
    return 'failed';
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
 * @param {function(string): void} [report] - told what the removal is doing
 */
async function removeSyncthingFolder(appComponentName, report) {
  try {
    const identifier = appComponentName;
    const appId = dockerService.getAppIdentifier(identifier);
    const folder = `${appsFolder + appId}`;
    // getConfigFolders answers the rows, or throws; a failed read leaves through
    // the catch below.
    const allSyncthingFolders = await syncthingService.getConfigFolders();
    if (!Array.isArray(allSyncthingFolders)) {
      return;
    }
    let folderId = null;
    for (const syncthingFolder of allSyncthingFolders) {
      if (syncthingFolder.path === folder || syncthingFolder.path.includes(`${folder}/`)) {
        folderId = syncthingFolder.id;
      }
      if (folderId) {
        // Only a removal syncthing accepted is reported as one. A delete is
        // idempotent, so a folder already gone answers rather than throws.
        let removed = true;
        try {
          // eslint-disable-next-line no-await-in-loop
          await syncthingService.adjustConfigFolders({ method: ConfigMethod.DELETE, id: folderId });
        } catch (error) {
          log.error(`removeSyncthingFolder - failed to remove folder ${folderId}: ${error.message}`);
          emitFolderStatus(report, { status: `Syncthing folder ${syncthingFolder.path} could not be removed` });
          removed = false;
        }
        if (!removed) {
          folderId = null;
          // eslint-disable-next-line no-continue
          continue;
        }
        emitFolderStatus(report, { status: `Stopping syncthing on folder ${syncthingFolder.path}...` });
        emitFolderStatus(report, { status: 'Syncthing adjusted' });
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
 * @param {string} folderId - the component's syncthing folder id
 */
async function requestFolderScan(folderId) {
  try {
    await syncthingService.scanFolder(folderId);
  } catch (error) {
    log.warn(`requestFolderScan: syncthing scan request for ${folderId} failed - ${error.message ?? error}`);
  }
}

module.exports = {
  OWNED_FOLDER_SETTINGS,
  getDeviceID,
  getDeviceIDCached,
  sortAndFilterLocations,
  sortRunningAppList,
  buildDeviceConfiguration,
  createSyncthingFolderConfig,
  ensureStfolderExists,
  folderNeedsUpdate,
  removeSyncthingFolder,
  setSyncthingFolderPaused,
  requestFolderScan,
};
