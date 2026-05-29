const config = require('config');
const axios = require('axios');
const serviceHelper = require('../serviceHelper');
const messageHelper = require('../messageHelper');
// eslint-disable-next-line no-unused-vars
const pgpService = require('../pgpService');
const registryCredentialHelper = require('../utils/registryCredentialHelper');
const imageVerifier = require('../utils/imageVerifier');
const dbHelper = require('../dbHelper');
const verificationHelper = require('../verificationHelper');
const appsRepository = require('../appDatabase/appsRepository');
const log = require('../../lib/log');
const { supportedArchitectures, globalAppsMessages, globalAppsInformation } = require('../utils/appConstants');
const fluxCaching = require('../utils/cacheManager').default;

// Cache for blocked repositories
let cacheUserBlockedRepos = null;

/**
 * Classify error type and determine appropriate cache TTL
 * Uses structured error metadata from imageVerifier when available
 * @param {Error} error - The error from image verification
 * @param {object} errorMeta - Error metadata from imageVerifier (httpStatus, errorCode, errorType)
 * @returns {{ttlMs: number, reason: string}}
 */
function classifyVerificationError(error, errorMeta) {
  // eslint-disable-next-line global-require
  const { FluxCacheManager } = require('../utils/cacheManager');

  // Use structured errorMeta if available (from imageVerifier)
  if (errorMeta && errorMeta.errorType) {
    switch (errorMeta.errorType) {
      case 'network':
        return { ttlMs: FluxCacheManager.oneHour, reason: 'Network/Connection error' };
      case 'rate_limit':
        return { ttlMs: 2 * FluxCacheManager.oneHour, reason: 'Rate limiting (429)' };
      case 'server_error':
        return { ttlMs: 3 * FluxCacheManager.oneHour, reason: 'Server error (5xx)' };
      case 'whitelist_fetch_error':
      case 'auth_unavailable':
        return { ttlMs: 2 * FluxCacheManager.oneHour, reason: 'Temporary service issue' };
      // Permanent errors - longer cache
      case 'not_whitelisted':
      case 'invalid_format':
      case 'unsupported_architecture':
      case 'unsupported_media_type':
      case 'unsupported_schema':
      case 'auth_rejected':
      case 'auth_failed':
      case 'size_limit':
        return { ttlMs: 6 * FluxCacheManager.oneHour, reason: `Permanent error: ${errorMeta.errorType}` };
      default:
        return { ttlMs: 4 * FluxCacheManager.oneHour, reason: 'Unknown error type' };
    }
  }

  // Fallback to message parsing if errorMeta not available (shouldn't happen with updated imageVerifier)
  const errorMessage = error.message.toLowerCase();
  if (errorMessage.includes('connection error') || errorMessage.includes('econnrefused')
    || errorMessage.includes('enetunreach')) {
    return { ttlMs: FluxCacheManager.oneHour, reason: 'Network error (fallback)' };
  }
  if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
    return { ttlMs: 2 * FluxCacheManager.oneHour, reason: 'Rate limit (fallback)' };
  }
  if (errorMessage.includes('bad http status 5')) {
    return { ttlMs: 3 * FluxCacheManager.oneHour, reason: 'Server error (fallback)' };
  }

  // Default permanent error
  return { ttlMs: 6 * FluxCacheManager.oneHour, reason: 'Permanent error (fallback)' };
}

/**
 * Verify repository and image compliance
 * @param {string} repotag - Repository tag to verify
 * @param {object} options - Verification options
 * @param {string} [options.repoauth] - Repository authentication credentials
 * @param {string} [options.architecture] - Specific architecture to validate support for
 * @param {string} [options.appName] - Application name (for logging)
 * @returns {Promise<{verified: boolean, supportedArchitectures: string[]}>} Verification result with supported architectures
 */
async function verifyRepository(repotag, options = {}) {
  const repoauth = options.repoauth || null;
  const architecture = options.architecture || null;
  const appName = options.appName || null;

  const cacheKey = `${repotag}:${architecture || 'any'}:${repoauth ? 'auth' : 'noauth'}`;
  const cached = fluxCaching.dockerHubVerificationCache.get(cacheKey);

  if (cached) {
    log.info('Docker Hub verification cache HIT for '
      + `${repotag} (${architecture || 'any'})`);

    // If cached verification failed, throw the cached error
    if (cached.error) {
      throw new Error(cached.error);
    }

    return cached.result;
  }

  const imgVerifier = new imageVerifier.ImageVerifier(repotag, {
    maxImageSize: config.fluxapps.maxImageSize,
    architecture,
    architectureSet: supportedArchitectures,
  });

  if (repoauth) {
    // Use credential helper to handle version-aware decryption and cloud providers
    const credentials = await registryCredentialHelper.getCredentials(
      repotag,
      repoauth,
      appName,
    );

    if (credentials) {
      // Pass credentials object directly - no need to convert to string
      imgVerifier.addCredentials(credentials);
    }
  }

  try {
    await imgVerifier.verifyImage();
    imgVerifier.throwIfError();

    if (architecture && !imgVerifier.supported) {
      throw new Error(`This Fluxnode's architecture ${architecture} not supported by ${repotag}`);
    }

    // Extract supported architectures from the verified image
    const supportedArchs = imgVerifier.supportedArchitectures;

    const result = {
      verified: true,
      supportedArchitectures: supportedArchs,
    };

    // Cache successful verification (uses default TTL from FluxCacheManager: 1 hour)
    fluxCaching.dockerHubVerificationCache.set(cacheKey, {
      result,
      error: null,
    });

    log.info(`Docker Hub verification cache MISS - cached for ${repotag} (${architecture || 'any'})`);

    return result;
  } catch (error) {
    // Use errorMeta from imageVerifier for intelligent classification
    const { errorMeta } = imgVerifier;
    const { ttlMs, reason } = classifyVerificationError(error, errorMeta);

    log.warn(`Docker Hub verification failed for ${repotag}: ${error.message}`);
    log.warn(`Error classified as: ${reason} (retry in ${ttlMs / 1000 / 60 / 60} hours)`);

    // Cache failure with custom TTL based on error type
    fluxCaching.dockerHubVerificationCache.set(cacheKey, {
      result: null,
      error: error.message,
    }, { ttl: ttlMs });

    throw error;
  }
}

/**
 * Get blocked repositories from official source
 * @returns {Promise<Array|null>} List of blocked repositories
 */
async function getBlockedRepositories() {
  try {
    const cachedResponse = fluxCaching.blockedRepositoriesCache.get('blockedRepositories');
    if (cachedResponse) {
      return cachedResponse;
    }
    const resBlockedRepo = await serviceHelper.axiosGet(`${config.github.rawBaseUrl}/helpers/blockedrepositories.json`);
    if (resBlockedRepo.data) {
      fluxCaching.blockedRepositoriesCache.set('blockedRepositories', resBlockedRepo.data);
      return resBlockedRepo.data;
    }
    return null;
  } catch (error) {
    log.error(error);
    return null;
  }
}

/**
 * Get vetted repositories from official source
 * These apps bypass user-defined blocked repositories and ports
 * @returns {Promise<Array|null>} List of vetted repositories
 */
async function getVettedRepositories() {
  try {
    const cachedResponse = fluxCaching.blockedRepositoriesCache.get('vettedRepositories');
    if (cachedResponse) {
      return cachedResponse;
    }
    const resVettedRepo = await serviceHelper.axiosGet(`${config.github.rawBaseUrl}/helpers/vettedrepositories.json`);
    if (resVettedRepo.data) {
      fluxCaching.blockedRepositoriesCache.set('vettedRepositories', resVettedRepo.data);
      return resVettedRepo.data;
    }
    return null;
  } catch (error) {
    log.error(error);
    return null;
  }
}

// The repository name with any :tag / @digest removed, via the shared parser.
// Non-image entries (owner ids, hashes) don't parse and pass through unchanged.
function stripTag(imageRef) {
  const parsed = imageVerifier.ImageVerifier.parseImageReference(imageRef);
  return parsed.error ? imageRef : parsed.reference;
}

function extractNamespace(repository) {
  const lastSlash = repository.lastIndexOf('/');
  return lastSlash > -1 ? repository.substring(0, lastSlash) : repository;
}

async function isAppVetted(options = {}) {
  const { owner = null, hash = null, images = [] } = options;

  const vettedRepos = await getVettedRepositories();
  if (!vettedRepos || vettedRepos.length === 0) return false;

  const vetted = vettedRepos.map(stripTag);

  if (owner && vetted.includes(owner)) return true;
  if (hash && vetted.includes(hash)) return true;

  for (const imageRef of images) {
    const repo = stripTag(imageRef);
    if (vetted.includes(repo) || vetted.includes(repo.toLowerCase())) return true;
    const ns = extractNamespace(repo);
    if (vetted.includes(ns) || vetted.includes(ns.toLowerCase())) return true;
  }

  return false;
}

/**
 * Get user-defined blocked repositories from configuration
 * @returns {Promise<Array>} List of user blocked repositories
 */
async function getUserBlockedRepositories() {
  try {
    if (cacheUserBlockedRepos) {
      return cacheUserBlockedRepos;
    }

    const userconfig = globalThis.userconfig;
    // Normalise case up front: image references are lowercase, but operators
    // type blockedRepositories config in any case. Stored entries are the
    // tag/digest-stripped name, which is what isImageBlocked compares against.
    const userBlockedRepos = (userconfig.initial.blockedRepositories || []).map((repo) => repo.toLowerCase());
    if (userBlockedRepos.length === 0) {
      return userBlockedRepos;
    }
    const usableUserBlockedRepos = [];
    const marketPlaceUrl = 'https://stats.runonflux.io/marketplace/listapps';
    const response = await axios.get(marketPlaceUrl);
    if (response && response.data && response.data.status === 'success') {
      const visibleApps = response.data.data.filter((val) => val.visible);
      for (const userRepo of userBlockedRepos) {
        const userRepoName = stripTag(userRepo);
        const isMarketplaceImage = visibleApps.some(
          (app) => app.compose.some((component) => stripTag(component.repotag).toLowerCase() === userRepoName),
        );
        if (isMarketplaceImage) {
          log.info(`${userRepo} is part of a marketplace offer; despite being on blockedRepositories it will not be taken into consideration`);
        } else {
          usableUserBlockedRepos.push(userRepoName);
        }
      }
      cacheUserBlockedRepos = usableUserBlockedRepos;
      return cacheUserBlockedRepos;
    }
    return [];
  } catch (error) {
    log.error(error);
    return [];
  }
}

async function isImageBlocked(appName, images, options = {}) {
  const { owner = null, hash = null } = options;

  const repos = await getBlockedRepositories();
  const userBlockedRepos = await getUserBlockedRepositories();

  if (!repos && !userBlockedRepos) {
    return { blocked: false, reason: null };
  }

  const blocked = repos ? repos.map(stripTag) : [];

  if (owner && blocked.includes(owner)) {
    return { blocked: true, reason: `${owner} is not allowed to run applications` };
  }
  if (hash && blocked.includes(hash)) {
    return { blocked: true, reason: `${hash} is not allowed to be spawned` };
  }

  for (const imageRef of images) {
    const repo = stripTag(imageRef);
    if (blocked.includes(repo)) {
      return { blocked: true, reason: `Image ${repo} is blocked. Application ${appName} cannot be spawned.` };
    }
    const ns = extractNamespace(repo);
    if (blocked.includes(ns)) {
      return { blocked: true, reason: `Organisation ${ns} is blocked. Application ${appName} cannot be spawned.` };
    }
  }

  const vetted = await isAppVetted({ owner, hash, images });
  if (vetted) {
    log.info(`Application ${appName} is vetted. Bypassing user-blocked repositories check.`);
    return { blocked: false, reason: null };
  }

  if (userBlockedRepos) {
    for (const imageRef of images) {
      const repo = stripTag(imageRef);
      const ns = extractNamespace(repo);
      if (userBlockedRepos.includes(ns.toLowerCase())) {
        return { blocked: true, reason: `Organisation ${ns} is user blocked. Application ${appName} cannot be spawned.` };
      }
      if (userBlockedRepos.includes(repo.toLowerCase())) {
        return { blocked: true, reason: `Image ${repo} is user blocked. Application ${appName} cannot be spawned.` };
      }
    }
  }

  return { blocked: false, reason: null };
}

/**
 * Check Docker accessibility for repository
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @returns {Promise<void>} Docker accessibility result
 */
async function checkDockerAccessibility(req, res) {
  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', async () => {
    try {
      const authorized = await verificationHelper.verifyPrivilege('user', req);
      if (!authorized) {
        const errMessage = messageHelper.errUnauthorizedMessage();
        return res.json(errMessage);
      }
      // check repotag if available for download
      const processedBody = serviceHelper.ensureObject(body);

      if (!processedBody.repotag) {
        throw new Error('No repotag specified');
      }

      const message = messageHelper.createSuccessMessage('deprecated');
      // await verifyRepository(processedBody.repotag);
      // const message = messageHelper.createSuccessMessage('Repotag is accessible');
      return res.json(message);
    } catch (error) {
      log.warn(error);
      const errorResponse = messageHelper.createErrorMessage(
        error.message || error,
        error.name,
        error.code,
      );
      return res.json(errorResponse);
    }
  });
}

async function checkApplicationsCompliance() {
  // eslint-disable-next-line global-require
  const deploymentProvider = require('../appRuntime/deploymentProvider');
  // eslint-disable-next-line global-require
  const appUninstaller = require('../appLifecycle/appUninstaller');

  try {
    const installedSpecs = await appsRepository.listInstalledApps();
    const deployments = await deploymentProvider.listInstalledDeployments();
    const deploymentByName = new Map();
    for (const d of deployments) {
      deploymentByName.set(d.appName, d);
    }

    const appsToRemoveNames = [];
    for (const inst of installedSpecs) {
      const deployment = deploymentByName.get(inst.name);
      const images = deployment ? deployment.allImages() : [];
      // eslint-disable-next-line no-await-in-loop
      const result = await isImageBlocked(inst.name, images, { owner: inst.owner, hash: inst.hash });
      if (result.blocked) {
        if (!appsToRemoveNames.includes(inst.name)) {
          appsToRemoveNames.push(inst.name);
        }
      }
    }
    for (const appName of appsToRemoveNames) {
      log.warn(`Application ${appName} is blacklisted, removing`);
      log.warn(`REMOVAL REASON: Blacklisted image - ${appName} uses a blacklisted Docker image (imageManager)`);
      // eslint-disable-next-line no-await-in-loop
      await appUninstaller.uninstallApplication(appName, { broadcastRemoval: true });
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(3 * 60 * 1000);
    }
  } catch (error) {
    log.error(error);
  }
}

module.exports = {
  verifyRepository,
  getBlockedRepositories,
  getUserBlockedRepositories,
  getVettedRepositories,
  isAppVetted,
  isImageBlocked,
  checkDockerAccessibility,
  checkApplicationsCompliance,
};
