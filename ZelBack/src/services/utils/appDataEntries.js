'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');
const IOUtils = require('../IOUtils');
const { getSpecBackend } = require('./specLibs');

/**
 * The app's data in a component volume is everything at the volume root except
 * the platform's own entries, which the spec library names: staged backups,
 * syncthing's marker and ignore file, the filesystem's recovery directory,
 * file-operation staging in both its shapes, and platform-provisioned content.
 * A legacy app's `appdata` is the one directory such an app happens to have; a
 * v9 app's mount sources are whatever the owner named them. Nothing here knows
 * a data directory by name.
 *
 * Every walk and every delete runs as root, in one `find`: enumerating
 * host-side as the FluxOS user fails on a data directory the image chmods to
 * 700 (postgres does), and a caller reads that as a failed wipe and retries it
 * forever.
 */

/**
 * An archive of the app's data. Format 2 is the volume root minus the
 * platform's entries, with the manifest as its first member so the format is
 * read from one entry. Format 1, which every archive written before this
 * carries, is the contents of the legacy primary's directory and nothing
 * else, with no manifest.
 */
const ARCHIVE_FORMAT = 2;
const MANIFEST_MEMBER = 'backup/manifest.json';

/**
 * find(1) predicates that leave the platform's entries out of a
 * -mindepth 1 -maxdepth 1 walk of a volume root.
 * @returns {Promise<string[]>}
 */
async function platformEntryPredicates() {
  const { PLATFORM_VOLUME_ENTRIES, LEGACY_STAGING_ENTRY_PATTERN } = await getSpecBackend();
  const byName = PLATFORM_VOLUME_ENTRIES.flatMap((name) => ['-not', '-name', name]);
  // -regex matches the whole path; the library's pattern is over one name.
  const legacyStaging = `.*/${LEGACY_STAGING_ENTRY_PATTERN.slice(1, -1)}`;
  return ['-regextype', 'posix-extended', ...byName, '-not', '-regex', legacyStaging];
}

/**
 * The names of the app's entries at a volume root.
 * @param {string} volumeDir
 * @returns {Promise<string[]>}
 */
async function listAppDataEntries(volumeDir) {
  const result = await serviceHelper.runCommand('find', {
    runAsRoot: true,
    params: [volumeDir, '-mindepth', '1', '-maxdepth', '1', ...(await platformEntryPredicates()), '-printf', '%f\\n'],
  });
  if (result.error) {
    throw new Error(`could not list ${volumeDir}: ${result.stderr || result.error.message}`);
  }
  return result.stdout.split('\n').filter(Boolean);
}

/**
 * Delete the app's entries at a volume root, leaving the platform's and the
 * volume itself. Resolves runCommand's result rather than throwing, so a
 * caller can retry while a just-stopped container still holds a bind mount.
 * @param {string} volumeDir
 * @returns {Promise<{error: (Error|null), stdout: string, stderr: string}>}
 */
async function wipeAppData(volumeDir) {
  return serviceHelper.runCommand('find', {
    runAsRoot: true,
    logError: false,
    params: [volumeDir, '-mindepth', '1', '-maxdepth', '1', ...(await platformEntryPredicates()), '-exec', 'rm', '-rf', '{}', '+'],
  });
}

/**
 * Archive the app's data in a volume.
 * @param {string} volumeDir
 * @param {string} archivePath
 * @param {{component: string, replica: (string|null)}} about - recorded in the manifest
 * @returns {Promise<{status: boolean, error?: string}>}
 */
async function archiveAppData(volumeDir, archivePath, { component, replica }) {
  const entries = await listAppDataEntries(volumeDir);
  const manifestPath = path.join(volumeDir, MANIFEST_MEMBER);
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify({
    format: ARCHIVE_FORMAT, component, replica: replica ?? null, entries, createdAt: new Date().toISOString(),
  }));
  try {
    return await IOUtils.createTarGz(volumeDir, archivePath, [MANIFEST_MEMBER, ...entries]);
  } finally {
    await fs.rm(manifestPath, { force: true });
  }
}

/**
 * Which format an archive carries, read from its first member.
 * @param {string} archivePath
 * @returns {Promise<number>}
 */
async function archiveFormat(archivePath) {
  const listed = await serviceHelper.runCommand('tar', {
    runAsRoot: true,
    logError: false,
    params: ['-tzf', archivePath, '--occurrence=1', MANIFEST_MEMBER],
  });
  return (listed.stdout || '').split('\n').includes(MANIFEST_MEMBER) ? ARCHIVE_FORMAT : 1;
}

/**
 * Replace the app's data in a volume with an archive's.
 *
 * A format 1 archive is the contents of the legacy primary's directory, so it
 * replaces that directory alone and is refused for a component that has no
 * such mount: unpacking it anywhere else would put the data where nothing
 * reads it.
 *
 * @param {string} volumeDir
 * @param {string} archivePath
 * @param {object} deployComp - the DeploymentComponent whose volume this is
 * @returns {Promise<{status: boolean, error?: string}>}
 */
async function restoreAppData(volumeDir, archivePath, deployComp) {
  if (await archiveFormat(archivePath) === ARCHIVE_FORMAT) {
    const wiped = await wipeAppData(volumeDir);
    if (wiped.error) {
      return { status: false, error: `could not clear ${volumeDir} before unpacking: ${wiped.stderr || wiped.error.message}` };
    }
    const unpacked = await IOUtils.untarFile(volumeDir, archivePath);
    await fs.rm(path.join(volumeDir, MANIFEST_MEMBER), { force: true });
    return unpacked;
  }
  const { LEGACY_PRIMARY_SOURCE } = await getSpecBackend();
  const primaryDir = path.join(volumeDir, LEGACY_PRIMARY_SOURCE);
  if (!deployComp.mounts.some((mount) => mount.Source === primaryDir)) {
    return { status: false, error: `the archive holds a legacy ${LEGACY_PRIMARY_SOURCE} directory and this component has no such mount` };
  }
  const cleared = await IOUtils.removeDirectory(primaryDir, true);
  if (cleared !== true) {
    return { status: false, error: `could not clear ${primaryDir} before unpacking` };
  }
  log.info(`restoring a format 1 archive into ${primaryDir}`);
  return IOUtils.untarFile(primaryDir, archivePath);
}

module.exports = {
  ARCHIVE_FORMAT,
  MANIFEST_MEMBER,
  listAppDataEntries,
  wipeAppData,
  archiveAppData,
  archiveFormat,
  restoreAppData,
};
