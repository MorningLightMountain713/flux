const util = require('util');
const systemcrontab = require('crontab');
const log = require('../lib/log');
const serviceHelper = require('./serviceHelper');
const dockerService = require('./dockerService');
const appsRepository = require('./appDatabase/appsRepository');
const { getSpecBackend } = require('./utils/specLibs');

const crontabLoad = util.promisify(systemcrontab.load);

/**
 * Check if a volume path contains the incorrect '/flux/' directory pattern
 * @param {string} volumePath - The volume path to check
 * @returns {boolean} - True if the path contains the incorrect pattern
 */
function hasIncorrectFluxPath(volumePath) {
  if (!volumePath || typeof volumePath !== 'string') {
    return false;
  }
  // Check if path contains /flux/ directory that should not be there
  return volumePath.includes('/flux/ZelApps');
}

/**
 * The app a legacy mount entry belongs to, or null when nothing here claims it.
 *
 * This ends in a redeploy that RECREATES the volume, so a wrong answer reformats
 * the wrong app's data. The crontab comment is the docker app id the entry was
 * written for — an exact value, not one recovered from a path — so this
 * de-prefixes it once and asks which installed row states that identifier as one
 * of its own components. No row, no answer, and the caller does nothing.
 *
 * Taking the identifier apart is the fallback for rows written before their
 * components were recorded; info.apps.componentIdentifiers counts how many still
 * need it, and that figure reaching zero fleet-wide is what licenses deleting it.
 *
 * @param {string} appId - the crontab comment, a docker app id
 * @returns {Promise<string|null>} the app name, or null when unresolvable
 */
async function resolveAppForMountEntry(appId) {
  if (!appId) return null;
  try {
    const identifier = dockerService.getBaseAppName(appId);
    const stated = await appsRepository.getInstalledAppByComponentIdentifier(identifier);
    if (stated) return stated.name;
    const { DeploymentSpec } = await getSpecBackend();
    const identity = DeploymentSpec.appNameFromIdentifier(identifier);
    const installed = await appsRepository.getInstalledAppByIdentity(identity);
    return installed ? installed.name : null;
  } catch (error) {
    log.error(`Could not resolve the app owning mount entry ${appId}: ${error.message}`);
    return null;
  }
}

/**
 * Get all apps with incorrect volume mounts from crontab
 * @returns {Promise<Array<{appName: string, volumePath: string, mountPoint: string}>>}
 */
async function getAppsWithIncorrectVolumeMounts() {
  const appsWithIncorrectMounts = [];

  try {
    log.info('Loading crontab to check for incorrect volume mounts...');
    const crontab = await crontabLoad().catch((error) => {
      log.error(`Error loading crontab: ${error.message}`);
      return null;
    });

    if (!crontab) {
      log.info('No crontab found or error loading it');
      return appsWithIncorrectMounts;
    }

    const jobs = crontab.jobs();
    log.info(`Found ${jobs.length} crontab jobs to check`);

    for (const job of jobs) {
      const comment = job.comment();
      const command = job.command();

      // Check if this is an app mount job (comments are app IDs)
      if (comment && command && command.includes('mount') && command.includes('ZelApps')) {
        const parts = command.split(' ');
        if (parts.length >= 6) {
          const volumePath = parts[4]; // The source volume path
          const mountPoint = parts[5]; // The mount point

          // Check if volume path has incorrect /flux/ pattern
          if (hasIncorrectFluxPath(mountPoint)) {
            // eslint-disable-next-line no-await-in-loop
            const appName = await resolveAppForMountEntry(comment);
            if (appName) {
              log.warn(`Found app with incorrect volume mount: ${appName}`);
              log.warn(`  Volume path: ${volumePath}`);
              log.warn(`  Mount point: ${mountPoint}`);
              appsWithIncorrectMounts.push({
                appName,
                volumePath,
                mountPoint,
                appId: comment,
              });
            } else {
              // The repair below redeploys with createVolumes, which REFORMATS the
              // volume. An entry whose app cannot be named is left exactly as it
              // is: a stale crontab line is harmless, and acting on a guess is not.
              log.warn(`Leaving legacy mount entry ${comment} alone - no installed app claims that identity`);
            }
          }
        }
      }
    }

    log.info(`Found ${appsWithIncorrectMounts.length} apps with incorrect volume mounts`);
  } catch (error) {
    log.error(`Error checking crontab for incorrect mounts: ${error.message}`);
  }

  return appsWithIncorrectMounts;
}

/**
 * Manually unmount the incorrect volume path
 * @param {string} mountPoint - The mount point to unmount
 * @returns {Promise<boolean>} - True if unmount was successful
 */
async function unmountIncorrectVolume(mountPoint) {
  log.info(`Attempting to unmount incorrect volume at: ${mountPoint}`);

  const { error } = await serviceHelper.runCommand('umount', {
    runAsRoot: true,
    logError: false,
    params: [mountPoint],
  });

  if (error) {
    log.warn(`Failed to unmount volume at ${mountPoint}: ${error.message}`);
    // Continue even if unmount fails - the volume might not be mounted
    return false;
  }

  log.info(`Successfully unmounted volume at: ${mountPoint}`);
  return true;
}

/**
 * Remove crontab entry with incorrect volume information
 * @param {string} appId - The app ID (crontab comment)
 * @param {string} incorrectVolumePath - The incorrect volume path to match
 * @returns {Promise<boolean>} - True if crontab entry was removed
 */
async function removeCrontabEntry(appId, incorrectVolumePath) {
  try {
    log.info(`Attempting to remove crontab entry for app ID: ${appId}`);

    const crontab = await crontabLoad().catch((error) => {
      log.error(`Error loading crontab: ${error.message}`);
      return null;
    });

    if (!crontab) {
      log.warn('No crontab found, skipping crontab cleanup');
      return false;
    }

    const jobs = crontab.jobs();
    let jobRemoved = false;

    jobs.forEach((job) => {
      if (job.comment() === appId) {
        const command = job.command();
        // Check if this job contains the incorrect volume path
        if (command.includes(incorrectVolumePath)) {
          log.info(`Found crontab job with incorrect path: ${command}`);
          crontab.remove(job);
          jobRemoved = true;
        }
      }
    });

    if (jobRemoved) {
      try {
        await crontab.save();
        log.info(`Successfully removed crontab entry for ${appId}`);
        return true;
      } catch (error) {
        log.error(`Error saving crontab: ${error.message}`);
        return false;
      }
    }

    log.info(`No crontab entry found for ${appId} with incorrect path`);
    return false;
  } catch (error) {
    log.error(`Error removing crontab entry: ${error.message}`);
    return false;
  }
}

/**
 * Get app specifications for redeployment
 * @param {string} appName - The app name
 * @returns {Promise<object|null>} - App specifications or null
 */
/**
 * Rebuild an app with an incorrect volume mount
 * This removes the app completely and reinstalls it with correct volume paths
 * @param {string} appName - The app name to redeploy
 * @returns {Promise<boolean>} - True if redeploy was successful
 */
async function rebuildApp(appName) {
  try {
    log.info(`Attempting to rebuild app ${appName} due to incorrect volume mount`);

    // eslint-disable-next-line global-require
    const { redeployApplication } = require('./appLifecycle/appOperations');
    await redeployApplication(appName, { createVolumes: true });

    log.info(`Successfully redeployed app ${appName} with correct volume paths`);
    return true;
  } catch (error) {
    log.error(`Error redeploying app ${appName}: ${error.message}`);
    return false;
  }
}

/**
 * Check and fix apps with incorrect volume mounts
 * This function runs on FluxOS startup
 * @returns {Promise<void>}
 */
async function checkAndFixIncorrectVolumeMounts() {
  try {
    log.info('=== Volume Validation Service: Starting check for incorrect volume mounts ===');

    const appsWithIncorrectMounts = await getAppsWithIncorrectVolumeMounts();

    if (appsWithIncorrectMounts.length === 0) {
      log.info('=== Volume Validation Service: No apps with incorrect volume mounts found ===');
      return;
    }

    log.warn(`=== Volume Validation Service: Found ${appsWithIncorrectMounts.length} apps with incorrect mounts ===`);

    // Track unique app names for redeployment
    const uniqueAppNames = new Set();

    // Process each app with incorrect mount sequentially
    // eslint-disable-next-line no-restricted-syntax
    for (const app of appsWithIncorrectMounts) {
      log.warn(`Processing app: ${app.appName}`);
      log.warn(`  App ID: ${app.appId}`);
      log.warn(`  Incorrect volume path: ${app.volumePath}`);
      log.warn(`  Mount point: ${app.mountPoint}`);

      // Step 1: Manually unmount the incorrect volume
      log.info(`Step 1: Unmounting incorrect volume for ${app.appName}...`);
      // eslint-disable-next-line no-await-in-loop
      await unmountIncorrectVolume(app.mountPoint);

      // Step 2: Remove the crontab entry with incorrect volume information
      log.info(`Step 2: Removing crontab entry for ${app.appName}...`);
      // eslint-disable-next-line no-await-in-loop
      await removeCrontabEntry(app.appId, app.volumePath);

      // Already the app's own name, resolved from its row rather than cut out
      // of a path.
      uniqueAppNames.add(app.appName);
    }

    // Step 3: Rebuild each unique app (removes and reinstalls with correct volume paths)
    log.info(`Found ${uniqueAppNames.size} unique apps to redeploy`);
    // eslint-disable-next-line no-restricted-syntax
    for (const appName of uniqueAppNames) {
      log.info(`Rebuilding app ${appName} with correct volume paths...`);
      // eslint-disable-next-line no-await-in-loop
      await rebuildApp(appName);
    }

    log.info('=== Volume Validation Service: Completed fixing incorrect volume mounts ===');
  } catch (error) {
    log.error(`Volume Validation Service error: ${error.message}`);
  }
}

module.exports = {
  checkAndFixIncorrectVolumeMounts,
  hasIncorrectFluxPath,
  resolveAppForMountEntry,
  getAppsWithIncorrectVolumeMounts,
  unmountIncorrectVolume,
  removeCrontabEntry,
  rebuildApp,
};
