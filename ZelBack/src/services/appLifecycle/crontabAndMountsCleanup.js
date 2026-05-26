const util = require('util');
const systemcrontab = require('crontab');
const log = require('../../lib/log');
const appsRepository = require('../appDatabase/appsRepository');
const { resolveSpec } = require('../utils/specCutover');
const { getSpecBackend } = require('../utils/specLibs');
const { appsFolder } = require('../utils/appConstants');
const dockerService = require('../dockerService');
const volumeService = require('../utils/volumeService');
const appTamperingDetectionService = require('../appTamperingDetectionService');

const crontabLoad = util.promisify(systemcrontab.load);

/**
 * Get all locally installed app IDs. Enterprise apps are stored locally with
 * `compose` deliberately emptied (the components only exist inside the
 * encrypted `enterprise` blob), so they are decrypted the same way the rest
 * of the runtime reads them; when decryption is unavailable the component ids
 * are derived from the app's FLUXFSVOL images on disk instead. A database
 * failure throws: "could not enumerate" must surface as unknown to callers,
 * never as "nothing is installed".
 * @returns {Promise<Set<string>>} Set of installed app IDs
 */
async function getInstalledAppIds() {
  const installedAppIds = new Set();

  // A DB read failure MUST throw: "cannot enumerate" surfaces as unknown to
  // callers, never as "nothing installed" (which would reap live app mounts).
  const apps = await appsRepository.listInstalledAppsRaw();

  if (!apps || !Array.isArray(apps)) {
    return installedAppIds;
  }

  const { DeploymentSpec } = await getSpecBackend();

  // eslint-disable-next-line no-restricted-syntax
  for (const app of apps) {
    // resolveSpec decrypts enterprise apps (components live in the encrypted
    // blob, compose emptied on disk); null => decryption unavailable.
    // eslint-disable-next-line no-await-in-loop
    const spec = await resolveSpec(app);
    if (spec) {
      const deployment = DeploymentSpec.fromSpec(spec, appsFolder);
      // eslint-disable-next-line no-restricted-syntax
      for (const [, deployComp] of deployment.componentEntries()) {
        installedAppIds.add(dockerService.getAppIdentifier(deployComp.identifier));
      }
      // eslint-disable-next-line no-continue
      continue;
    }
    if (app.enterprise) {
      // decryption unavailable - derive component ids from FLUXFSVOL images on disk
      // eslint-disable-next-line no-await-in-loop
      const diskAppIds = await volumeService.getComponentAppIdsFromVolumeFiles(app.name);
      diskAppIds.forEach((appId) => installedAppIds.add(appId));
    }
  }

  return installedAppIds;
}

/**
 * Whether a crontab job is a legacy FLUXFSVOL remount entry.
 * @param {string} command - The crontab command
 * @returns {boolean} True if it is a volume mount job
 */
function isVolumeMountJob(command) {
  return command.includes('mount -o loop') && command.includes('FLUXFSVOL');
}

/**
 * Extract the mountpoint from a legacy FLUXFSVOL mount command.
 * @param {string} command - The crontab command
 * @returns {string|null} Mountpoint path, or null when unparseable
 */
function extractMountPoint(command) {
  const match = command.match(/sudo mount -o loop\s+\S+FLUXFSVOL\s+(\S+)/);
  return match ? match[1] : null;
}

/**
 * Mounts the data volume of every locally installed app component. Derived
 * from the installed-apps database and deterministic image discovery only -
 * deliberately independent of the crontab, whose silent loss is exactly how
 * volumes stayed unmounted after a reboot.
 * @returns {Promise<{mounted: string[], alreadyMounted: string[], failed: Array<{appId: string, reason: string}>}>}
 */
async function ensureInstalledAppVolumesMounted() {
  const results = {
    mounted: [],
    alreadyMounted: [],
    failed: [],
  };

  const installedAppIds = await getInstalledAppIds();
  log.info(`ensureInstalledAppVolumesMounted - Ensuring volumes of ${installedAppIds.size} installed app component(s) are mounted`);

  // eslint-disable-next-line no-restricted-syntax
  for (const appId of installedAppIds) {
    // eslint-disable-next-line no-await-in-loop
    const mountResult = await volumeService.ensureAppVolumeMounted(appId);
    if (!mountResult.mounted) {
      log.error(`ensureInstalledAppVolumesMounted - ${appId} volume could not be mounted: ${mountResult.reason}`);
      results.failed.push({ appId, reason: mountResult.reason });
      // eslint-disable-next-line no-await-in-loop
      await appTamperingDetectionService.recordEvent(appId, 'mount_vanished', `Volume not mountable at startup: ${mountResult.reason}`);
    } else if (mountResult.alreadyMounted) {
      results.alreadyMounted.push(appId);
    } else {
      log.info(`ensureInstalledAppVolumesMounted - mounted volume of ${appId}`);
      results.mounted.push(appId);
    }
  }

  return results;
}

/**
 * Removes legacy FLUXFSVOL @reboot remount entries from the root crontab, but
 * only those whose volume is currently mounted - proof the FluxOS-owned mount
 * (boot pass above + reconciler) has demonstrably replaced the entry. An entry
 * whose volume is NOT mounted is kept: it is the remaining safety net for the
 * next boot, and removing it on the strength of a possibly-blind inventory is
 * exactly how remount entries used to vanish. A surviving entry on a mounted
 * volume would double-mount on the next boot, hence the cleanup.
 * @returns {Promise<{removed: string[], kept: string[], errors: Array<{appId: string, error: string}>}>}
 */
async function removeLegacyMountCrontabEntries() {
  const results = {
    removed: [],
    kept: [],
    errors: [],
  };

  const crontab = await crontabLoad().catch((error) => {
    // mounting no longer depends on the crontab, so a load failure only delays
    // this cleanup until the next start
    log.warn(`removeLegacyMountCrontabEntries - could not load crontab: ${error.message}`);
    return null;
  });
  if (!crontab) return results;

  const jobs = crontab.jobs() || [];
  // eslint-disable-next-line no-restricted-syntax
  for (const job of jobs) {
    let command = '';
    let comment = '';
    try {
      command = job && job.command ? job.command() : '';
      comment = job && job.comment ? job.comment() : '';
    } catch (error) {
      // eslint-disable-next-line no-continue
      continue;
    }
    if (!isVolumeMountJob(command)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const mountPoint = extractMountPoint(command);
    // eslint-disable-next-line no-await-in-loop
    const mounted = mountPoint ? await volumeService.isPathMounted(mountPoint) : false;
    if (!mounted) {
      log.warn(`removeLegacyMountCrontabEntries - keeping legacy entry for ${comment || command}: its volume is not currently mounted`);
      results.kept.push(comment || command);
      // eslint-disable-next-line no-continue
      continue;
    }
    try {
      crontab.remove(job);
      results.removed.push(comment || command);
    } catch (error) {
      log.error(`removeLegacyMountCrontabEntries - failed to remove entry for ${comment}: ${error.message}`);
      results.errors.push({ appId: comment, error: error.message });
    }
  }

  if (results.removed.length > 0) {
    try {
      crontab.save();
      log.info(`removeLegacyMountCrontabEntries - removed ${results.removed.length} legacy remount entr(ies): ${results.removed.join(', ')}`);
    } catch (error) {
      log.error(`removeLegacyMountCrontabEntries - failed to save crontab: ${error.message}`);
      results.errors.push({ appId: 'global', error: error.message });
    }
  }

  return results;
}

/**
 * Startup pass: mount every installed app's data volume, then drop the
 * superseded legacy @reboot remount entries.
 * @returns {Promise<Object>} Cleanup results
 */
async function cleanupCrontabAndMounts() {
  const results = {
    crontab: { removed: [], kept: [], errors: [] },
    mounts: { mounted: [], alreadyMounted: [], failed: [] },
  };

  try {
    // mounts first - they must never depend on the crontab step in any way
    results.mounts = await ensureInstalledAppVolumesMounted();
    results.crontab = await removeLegacyMountCrontabEntries();

    log.info(
      'cleanupCrontabAndMounts - Done. '
      + `Mounts: mounted ${results.mounts.mounted.length}, already mounted ${results.mounts.alreadyMounted.length}, failed ${results.mounts.failed.length}. `
      + `Crontab: removed ${results.crontab.removed.length} legacy entr(ies), kept ${results.crontab.kept.length}, errors ${results.crontab.errors.length}`,
    );

    return results;
  } catch (error) {
    log.error(`cleanupCrontabAndMounts - Critical error: ${error.message}`);
    return results;
  }
}

module.exports = {
  cleanupCrontabAndMounts,
  getInstalledAppIds,
  ensureInstalledAppVolumesMounted,
  removeLegacyMountCrontabEntries,
  isVolumeMountJob,
  extractMountPoint,
};
