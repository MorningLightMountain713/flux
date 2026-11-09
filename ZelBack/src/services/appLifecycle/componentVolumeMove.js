'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const appRecords = require('../appDatabase/appRecords');
const instanceResourceObserver = require('./instanceResourceObserver');
const volumeService = require('../utils/volumeService');
const appsRuntimeState = require('../appManagement/appsRuntimeState');
const syncthingService = require('../syncthingService');
const syncthingFolderWrites = require('../appMonitoring/syncthingFolderWrites');
const serviceHelper = require('../serviceHelper');
const { appsFolder } = require('../utils/appConstants');
const log = require('../../lib/log');

// Moves a component's volume from the names one container identifier gives it
// to the names another gives it: the move onto an app's identity, and an update
// that keeps a component whose identifier the new specification names
// differently (a version 3 app's one component, whose identifier is the bare
// identity, kept as a component named `<key>_<identity>`).
//
// Data is renamed, never copied: syncthing compares a file's mtime, and a copy
// would make every file of the folder look changed to every peer.

// The docker names a component carried before a move: the 8.x prefixed forms,
// and the bare identifier of a container created under the name since.
const FORMER_NAME_PREFIXES = ['flux', 'zel', ''];

function formerContainerNames(identifier) {
  return FORMER_NAME_PREFIXES.map((prefix) => `${prefix}${identifier}`);
}

async function exists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

async function run(command, params) {
  const result = await serviceHelper.runCommand(command, { runAsRoot: true, params, logError: false });
  if (result.error) throw new Error(`${command} ${params.join(' ')}: ${result.error.message}`);
  return result;
}

/**
 * The directory a component's volume had under a former identifier, under the
 * same names its container carried: the 8.x prefixed forms, then the bare
 * identifier. The first that exists, else the 8.x form.
 * @param {string} identifier
 * @returns {Promise<string>}
 */
async function formerDirectory(identifier) {
  const candidates = formerContainerNames(identifier).map((name) => `${appsFolder}${name}`);
  // eslint-disable-next-line no-restricted-syntax
  for (const dir of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await exists(dir)) return dir;
  }
  return candidates[0];
}

/**
 * The image a component's volume had under a former identifier, from the
 * resources' record, the kernel or the disks.
 * @param {string} formerIdentifier
 * @param {string} formerDir
 * @returns {Promise<{path: string, fsUuid: string|null}|null>}
 */
async function formerImage(formerIdentifier, formerDir) {
  const recorded = await volumeService.recordedVolumeImage(formerIdentifier);
  return instanceResourceObserver.discoverVolumeImage(formerIdentifier, recorded, [formerDir]);
}

/**
 * Moves a component's volume to the names its new identifier gives it: the
 * former directory is unmounted, the image is renamed beside itself, and the
 * directory is renamed. An image already in place is left where it is. The
 * volume is mounted once the resources name it.
 *
 * @param {object} formerComp - the component as its former identifier names it
 * @param {object} comp - the same component under its new identifier
 * @returns {Promise<{path: string, fsUuid: string|null}|null>} the image under the
 *   new identifier, with the stamp it carries, or null when none is there
 */
async function moveVolume(formerComp, comp) {
  const formerDir = await formerDirectory(formerComp.identifier);
  const dir = `${appsFolder}${comp.identifier}`;

  let image = await formerImage(formerComp.identifier, formerDir);
  if (await volumeService.isPathMounted(formerDir)) await run('umount', [formerDir]);

  if (!image) {
    const placed = await volumeService.getVolumeFilePath(comp.identifier);
    if (placed.path) image = { path: placed.path, fsUuid: (await volumeService.imageFsUuid(placed.path)) || null };
  }
  if (image) {
    const target = path.join(path.dirname(image.path), `${comp.identifier}FLUXFSVOL`);
    if (image.path !== target) await run('mv', [image.path, target]);
    image = { path: target, fsUuid: image.fsUuid || (await volumeService.imageFsUuid(target)) || null };
  }

  if (await exists(formerDir) && !await exists(dir)) {
    await serviceHelper.runCommand('chattr', { runAsRoot: true, params: ['-i', formerDir], logError: false });
    await run('mv', [formerDir, dir]);
  }

  return image;
}

/**
 * Points a component's syncthing folder, by its kept id, at the directory its
 * identifier names. The monitor writes the same path on its first pass, so a
 * syncthing that cannot answer now costs the move nothing.
 *
 * @param {object} comp - the component under its new identifier
 * @returns {Promise<boolean>} whether the folder was re-pointed
 */
async function repointFolder(comp) {
  const id = comp.syncFolderId;
  const target = `${appsFolder}${comp.identifier}`;
  try {
    const folder = await syncthingService.getConfigFolders(id);
    if (!folder || !folder.id || folder.path === target) return false;
    const response = await syncthingFolderWrites.patchFolder(id, { path: target });
    if (response.status === 'success') return true;
    if (response.data?.httpStatus === 404) return false;
    log.warn(`componentVolumeMove - folder ${id} keeps its path for now: ${response.data?.message}`);
    return false;
  } catch (error) {
    if (error.httpStatus === 404) return false;
    log.warn(`componentVolumeMove - folder ${id} keeps its path for now: ${error.message}`);
    return false;
  }
}

/**
 * Re-homes one kept component of an instance under the identifier the new
 * specification names it by: its runtime state, its volume and its syncthing
 * folder move, its resources block is written under the new identifier with
 * the moved volume, and the volume is mounted. Its former container is gone
 * before this runs.
 *
 * @param {string} appName
 * @param {string|null} replica
 * @param {string} key - the component's key
 * @param {object} formerComp - the component as the installed specification names it
 * @param {object} comp - the same component as the new specification names it
 * @throws when the moved volume does not mount
 */
async function moveComponentVolume(appName, replica, key, formerComp, comp) {
  await appsRuntimeState.rekey(formerComp.identifier, comp.identifier);
  const image = comp.isStateless ? null : await moveVolume(formerComp, comp);
  if (comp.hasSyncthing()) await repointFolder(comp);

  const resources = appRecords.instanceResources();
  const dir = path.join(appsFolder, comp.identifier);
  await resources.removeComponent(appName, replica, key);
  await resources.addComponent(appName, replica, key, {
    identifier: comp.identifier,
    image: comp.image,
    syncFolder: comp.hasSyncthing() ? { id: comp.syncFolderId, path: dir } : null,
    aliases: comp.networkAliases ?? [],
  });
  if (!image) return;
  await resources.setComponent(appName, replica, key, 'volume', {
    file: image.path, disk: instanceResourceObserver.diskOf(image.path), fsUuid: image.fsUuid, mountDir: dir,
  });
  const mounted = await volumeService.ensureAppVolumeMounted(comp.identifier);
  if (!mounted.mounted) throw new Error(`the volume of ${comp.identifier} did not mount: ${mounted.reason}`);
}

module.exports = {
  formerContainerNames, moveVolume, repointFolder, moveComponentVolume,
};
