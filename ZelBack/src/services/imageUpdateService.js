'use strict';

/**
 * Image Update Service
 *
 * Native FluxOS service that monitors installed apps for image updates
 * and triggers redeploys when newer images are available.
 * Replaces the external containrrr/watchtower Docker container.
 */

const config = require('config');
const log = require('../lib/log');
const dockerService = require('./dockerService');
const appOperations = require('./appLifecycle/appOperations');
const registryCredentialHelper = require('./utils/registryCredentialHelper');
const { ImageVerifier } = require('./utils/imageVerifier');
const serviceHelper = require('./serviceHelper');
const deploymentProvider = require('./appRuntime/deploymentProvider');
const imageCacheService = require('./appLifecycle/imageCacheService');
const imageReaper = require('./appLifecycle/imageReaper');
const operationRegistry = require('./utils/operationRegistry');
const fluxEventBus = require('./utils/fluxEventBus');

const CHECK_INTERVAL = config.fluxapps.imageUpdateCheckIntervalMs || 6 * 60 * 60 * 1000;
const DELAY_BETWEEN_APPS = config.fluxapps.imageUpdateDelayBetweenAppsMs || 5000;
const DELAY_AFTER_REDEPLOY = config.fluxapps.imageUpdateDelayAfterRedeployMs || 2 * 60 * 1000;
const INITIAL_DELAY_MIN = config.fluxapps.imageUpdateInitialDelayMinMs || 10 * 60 * 1000;
const INITIAL_DELAY_MAX = config.fluxapps.imageUpdateInitialDelayMaxMs || 30 * 60 * 1000;
const DELAY_BETWEEN_COMPONENTS = config.fluxapps.imageUpdateDelayBetweenComponentsMs || 1000;

// Track the timers
let checkIntervalTimer = null;
let initialDelayTimer = null;

/**
 * Removes the existing flux_watchtower container if it exists.
 * Called during startup to clean up the old Watchtower approach.
 * @returns {Promise<boolean>} True if container was found and removed, false otherwise
 */
async function removeWatchtowerContainer() {
  try {
    const containers = await dockerService.dockerListContainers(true);
    const watchtowerContainer = containers.find(
      (container) => container.Names.some((name) => name === '/flux_watchtower'),
    );

    if (!watchtowerContainer) {
      log.info('No flux_watchtower container found to remove');
      return false;
    }

    log.info('Found flux_watchtower container, stopping and removing...');

    try {
      // Get the container object and stop it
      const container = dockerService.getDockerContainerHandle(watchtowerContainer.Id);
      if (watchtowerContainer.State === 'running') {
        await container.stop();
        log.info('flux_watchtower container stopped');
      }
      await container.remove();
      log.info('flux_watchtower container removed');
    } catch (stopError) {
      // Container might already be stopped, try to remove directly
      log.warn(`Error stopping watchtower container: ${stopError.message}, attempting remove`);
      try {
        const container = dockerService.getDockerContainerHandle(watchtowerContainer.Id);
        await container.remove({ force: true });
        log.info('flux_watchtower container force removed');
      } catch (removeError) {
        log.error(`Failed to remove flux_watchtower container: ${removeError.message}`);
        return false;
      }
    }

    // Optionally remove the watchtower image
    try {
      const images = await dockerService.dockerListImages();
      const watchtowerImage = images.find(
        (img) => img.RepoTags && img.RepoTags.some((tag) => tag.startsWith('containrrr/watchtower')),
      );
      if (watchtowerImage) {
        await dockerService.appDockerImageRemove(watchtowerImage.Id);
        log.info('containrrr/watchtower image removed');
      }
    } catch (imageError) {
      // Image removal is optional, don't fail if it doesn't work
      log.warn(`Could not remove watchtower image: ${imageError.message}`);
    }

    return true;
  } catch (error) {
    log.error(`Error in removeWatchtowerContainer: ${error.message}`);
    return false;
  }
}

/**
 * Gets the local image digest for a container.
 * @param {string} containerName Full container name (e.g., 'fluxMyApp' or 'fluxweb_MyApp')
 * @returns {Promise<string|null>} The image digest (sha256:xxx) or null if not found
 */
async function getLocalImageDigest(containerName) {
  try {
    // Inspect the container to get the image ID
    const containerInfo = await dockerService.dockerContainerInspect(containerName);
    if (!containerInfo || !containerInfo.Image) {
      log.warn(`Container ${containerName} not found or has no image`);
      return null;
    }

    // Get the image digest from RepoDigests
    const images = await dockerService.dockerListImages();
    const containerImage = images.find((img) => img.Id === containerInfo.Image);

    if (!containerImage) {
      log.warn(`Image for container ${containerName} not found in local images`);
      return null;
    }

    // RepoDigests contains entries like "repo@sha256:xxx"
    if (containerImage.RepoDigests && containerImage.RepoDigests.length > 0) {
      // Extract digest from format "repo@sha256:xxx"
      const repoDigest = containerImage.RepoDigests[0];
      const digestMatch = repoDigest.match(/@(sha256:[a-f0-9]+)$/);
      if (digestMatch) {
        return digestMatch[1];
      }
    }

    log.warn(`No RepoDigests found for container ${containerName}`);
    return null;
  } catch (error) {
    log.warn(`Error getting local image digest for ${containerName}: ${error.message}`);
    return null;
  }
}

/**
 * Gets the remote manifest digest from a registry.
 * @param {string} repotag Image tag (e.g., 'nginx:latest')
 * @param {string|null} repoauth Authentication string (encrypted for v7, plain for v8+)
 * @param {string} appName Application name (for credential caching)
 * @returns {Promise<{error: string|null, digest: string|null}>} Result object with error and digest
 */
async function getRemoteManifestDigest(repotag, repoauth, appName) {
  try {
    const verifierOptions = {};

    if (repoauth) {
      try {
        const credentials = await registryCredentialHelper.getCredentials(
          repotag,
          repoauth,
          appName,
        );
        if (credentials) {
          verifierOptions.credentials = credentials;
        }
      } catch (credError) {
        log.warn(`Failed to get credentials for ${appName}/${repotag}: ${credError.message}`);
        return { error: 'credentials_failed', digest: null };
      }
    }

    const verifier = new ImageVerifier(repotag, verifierOptions);

    if (verifier.parseError) {
      log.warn(`Failed to parse image tag ${repotag}: ${verifier.errorDetail}`);
      return { error: 'parse_error', digest: null };
    }

    const digest = await verifier.fetchManifestDigestOnly();

    if (verifier.error) {
      const { errorMeta } = verifier;
      if (errorMeta && errorMeta.errorType === 'rate_limit') {
        log.warn(`Rate limited while checking ${repotag}`);
        return { error: 'rate_limited', digest: null };
      }
      log.warn(`Failed to fetch manifest digest for ${repotag}: ${verifier.errorDetail}`);
      return { error: 'fetch_failed', digest: null };
    }

    return { error: null, digest };
  } catch (error) {
    log.warn(`Error getting remote manifest digest for ${repotag}: ${error.message}`);
    return { error: 'exception', digest: null };
  }
}

/**
 * Checks if a specific app needs an update.
 * @param {object} appSpec Application specification
 * @returns {Promise<{needsUpdate: boolean, components: Array, rateLimited: boolean}>} Update status and components that need updates
 */
async function checkAppForUpdates(deployment) {
  const result = { needsUpdate: false, components: [], rateLimited: false };

  try {
    for (const [name, deployComp] of deployment.componentEntries()) {
      // A component pinned with autoUpdate:false is neither polled nor redeployed.
      // Default is true, so only an explicit opt-out skips.
      if (deployComp.autoUpdate === false) {
        // eslint-disable-next-line no-continue
        continue;
      }

      // dockerContainerInspect prefixes its argument itself - pass the bare identifier.
      // eslint-disable-next-line no-await-in-loop
      const localDigest = await getLocalImageDigest(deployComp.identifier);

      if (!localDigest) {
        log.debug(`Could not get local digest for ${deployment.appName}/${name}, skipping component`);
        // eslint-disable-next-line no-continue
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const remoteResult = await getRemoteManifestDigest(
        deployComp.image,
        deployComp.imageAuth || null,
        deployment.appName,
      );

      if (remoteResult.error === 'rate_limited') {
        result.rateLimited = true;
        return result;
      }

      if (!remoteResult.digest) {
        log.warn(`Could not get remote digest for ${deployment.appName}/${name}, skipping component`);
        // eslint-disable-next-line no-continue
        continue;
      }

      if (localDigest !== remoteResult.digest) {
        log.info(`Update available for ${deployment.appName}/${name}: ${localDigest} -> ${remoteResult.digest}`);
        result.needsUpdate = true;
        result.components.push({
          name,
          repotag: deployComp.image,
          localDigest,
          remoteDigest: remoteResult.digest,
        });
      }

      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(DELAY_BETWEEN_COMPONENTS);
    }

    return result;
  } catch (error) {
    log.warn(`Error checking updates for ${deployment.appName}: ${error.message}`);
    return result;
  }
}

/**
 * Triggers a redeploy for an app.
 * @param {object} appSpec Application specification
 * @returns {Promise<boolean>} True if redeploy was triggered, false otherwise
 */
async function triggerAppUpdate(appName) {
  try {
    if (operationRegistry.isHeld(appName)) {
      log.warn(`Skipping redeploy for ${appName}: an operation is already in progress for it`);
      return false;
    }

    log.info(`Triggering redeploy for ${appName}`);
    fluxEventBus.publish('imageUpdate:redeployTriggered', { appName });

    await appOperations.redeployApplication(appName, { createVolumes: false });

    fluxEventBus.publish('imageUpdate:redeployComplete', { appName });

    // The redeploy moves an updated image's tag onto a newer digest. If any of
    // this app's images are pinned in the enterprise image cache, re-reconcile
    // their records so the pin tracks the live image (otherwise the quota
    // under-counts the new image and inspect reports the superseded snapshot).
    // Best-effort — a cache reconcile must never fail the update.
    const deployment = await deploymentProvider.getInstalledDeployment(appName);
    // eslint-disable-next-line no-restricted-syntax
    for (const repotag of (deployment ? deployment.allImages() : [])) {
      // eslint-disable-next-line no-await-in-loop
      await imageCacheService.reconcilePinnedImage(repotag)
        .catch((err) => log.warn(`imageCache reconcile after update for ${repotag}: ${err.message}`));
    }

    // The redeploy orphaned the superseded digest's layers. Reap cold images now
    // so a soft-update doesn't leak them until the daily run. Best-effort and
    // all-nodes; the reaper protects pinned/in-use images itself.
    await imageReaper.pruneUnusedImages()
      .catch((err) => log.warn(`imageReaper after update for ${appName}: ${err.message}`));

    return true;
  } catch (error) {
    log.error(`Error triggering redeploy for ${appName}: ${error.message}`);
    return false;
  }
}

/**
 * Main function that checks all installed apps for updates.
 * Called periodically by the interval timer.
 */
async function checkForImageUpdates() {
  log.info('Starting image update check cycle');

  // No node-wide freeze: the cycle always runs. A busy app is skipped per-app in
  // triggerAppUpdate (isHeld(appName)) - an operation on one app no longer stalls
  // image checks for every other app.
  try {
    const deployments = await deploymentProvider.listInstalledDeployments();

    log.info(`Checking ${deployments.length} installed apps for image updates`);

    let updatesTriggered = 0;
    let appsChecked = 0;

    for (const deployment of deployments) {
      try {
        appsChecked += 1;

        // eslint-disable-next-line no-await-in-loop
        const updateStatus = await checkAppForUpdates(deployment);

        if (updateStatus.rateLimited) {
          log.warn('Rate limited by registry, aborting remaining checks this cycle');
          break;
        }

        if (updateStatus.needsUpdate) {
          // eslint-disable-next-line no-await-in-loop
          const redeployTriggered = await triggerAppUpdate(deployment.appName);
          if (redeployTriggered) {
            updatesTriggered += 1;
            // Wait longer after triggering a redeploy
            // eslint-disable-next-line no-await-in-loop
            await serviceHelper.delay(DELAY_AFTER_REDEPLOY);
          }
        }

        // Add delay between apps for rate limiting
        // eslint-disable-next-line no-await-in-loop
        await serviceHelper.delay(DELAY_BETWEEN_APPS);
      } catch (error) {
        log.warn(`Error checking app ${deployment.appName}: ${error.message}`);
      }
    }

    log.info(`Image update check cycle complete: checked ${appsChecked} apps, triggered ${updatesTriggered} updates`);
    fluxEventBus.publish('imageUpdate:checked', { appsChecked, updatesTriggered });
  } catch (error) {
    log.error(`Error in image update check cycle: ${error.message}`);
  }
}

/**
 * Starts the image update service.
 * Sets up the periodic check interval with staggered startup to prevent
 * synchronized checks across nodes.
 */
function startImageUpdateService() {
  log.info('Starting native image update service');

  // Clear any existing interval
  if (checkIntervalTimer) {
    clearInterval(checkIntervalTimer);
  }

  // Calculate random initial delay between 10-30 minutes
  // This prevents all nodes from hitting registries at the same time
  const initialDelay = INITIAL_DELAY_MIN + Math.floor(Math.random() * (INITIAL_DELAY_MAX - INITIAL_DELAY_MIN));
  const initialDelayMinutes = Math.round(initialDelay / 1000 / 60);

  log.info(`Image update service will run first check in ${initialDelayMinutes} minutes`);

  // Run initial check after random delay, then start the regular interval
  initialDelayTimer = setTimeout(async () => {
    initialDelayTimer = null;
    log.info('Running initial image update check');
    await checkForImageUpdates();

    // Start the regular interval after the first check completes
    checkIntervalTimer = setInterval(checkForImageUpdates, CHECK_INTERVAL);
    log.info(`Image update service interval started. Check interval: ${CHECK_INTERVAL / 1000 / 60 / 60} hours`);
  }, initialDelay);

  log.info('Image update service started');
}

/**
 * Stops the image update service.
 * Clears the periodic check interval.
 */
function stopImageUpdateService() {
  if (initialDelayTimer) {
    clearTimeout(initialDelayTimer);
    initialDelayTimer = null;
  }
  if (checkIntervalTimer) {
    clearInterval(checkIntervalTimer);
    checkIntervalTimer = null;
  }
  log.info('Image update service stopped');
}

module.exports = {
  removeWatchtowerContainer,
  startImageUpdateService,
  stopImageUpdateService,
  checkForImageUpdates,
  // Exported for testing
  getLocalImageDigest,
  getRemoteManifestDigest,
  checkAppForUpdates,
  triggerAppUpdate,
};
