'use strict';

const config = require('config');
const serviceHelper = require('../serviceHelper');
const messageHelper = require('../messageHelper');
const registryCredentialHelper = require('../utils/registryCredentialHelper');
const imageVerifier = require('../utils/imageVerifier');
const verificationHelper = require('../verificationHelper');
const log = require('../../lib/log');
const { supportedArchitectures } = require('../utils/appConstants');
const fluxCaching = require('../utils/cacheManager').default;
const policyStore = require('../policy/policyStore');
const { Privilege, authOf } = require('../utils/privileges');

/**
 * Classify error type and determine appropriate cache TTL
 * Uses structured error metadata from imageVerifier when available
 * @param {Error} error - The error from image verification
 * @param {object} errorMeta - Error metadata from imageVerifier (httpStatus, errorCode, errorType)
 * @returns {{ttlMs: number, reason: string}}
 */
// The transient re-ask pace, shared with the spawner's spawn-cache back-off so
// the two layers stack to a bounded, config-visible ceiling (2x this value).
function registryTransientBackoffMs() {
  return config.get('fluxapps.registryTransientBackoffMs');
}

function classifyVerificationError(error, errorMeta) {
  // eslint-disable-next-line global-require
  const { FluxCacheManager } = require('../utils/cacheManager');

  // The class rides the thrown error itself and SURVIVES the verifier's error
  // reset - throwIfError wipes errorMeta before any catch can read it, so meta
  // is usually absent here and only refines the pacing when it is present.
  // Without this branch every real verifier throw fell through to the
  // message-parsing fallback and its hour-scale TTLs.
  if (error.registryErrorClass === 'transient') {
    const errorType = errorMeta && errorMeta.errorType;
    if (errorType === 'rate_limit') return { ttlMs: 5 * registryTransientBackoffMs(), reason: 'Rate limiting (429)' };
    if (errorType === 'server_error') return { ttlMs: 2.5 * registryTransientBackoffMs(), reason: 'Server error (5xx)' };
    return { ttlMs: registryTransientBackoffMs(), reason: 'Transient registry failure (could-not-ask)' };
  }

  // Use structured errorMeta if available (from imageVerifier)
  if (errorMeta && errorMeta.errorType) {
    switch (errorMeta.errorType) {
      // Transient classes are could-not-ask answers, not verdicts on the image:
      // cache only long enough to pace the re-ask. Hours-scale TTLs here outlive
      // the outage itself - a registry that heals in a minute must not cost the
      // app an hour of placement on every node that asked during the blip.
      case 'network':
        return { ttlMs: registryTransientBackoffMs(), reason: 'Network/Connection error' };
      case 'rate_limit':
        return { ttlMs: 5 * registryTransientBackoffMs(), reason: 'Rate limiting (429)' };
      case 'server_error':
        return { ttlMs: 2.5 * registryTransientBackoffMs(), reason: 'Server error (5xx)' };
      case 'auth_unavailable':
        return { ttlMs: 2 * FluxCacheManager.oneHour, reason: 'Temporary service issue' };
      // Permanent errors - longer cache
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
 * @returns {Promise<{verified: boolean, supportedArchitectures: string[], provider: string,
 *   imageSizeBytes: number, decompressedSizeBytes: number,
 *   decompressedSizeClearanceBytes: number}>} Verification result
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

    // If cached verification failed, throw the cached error - re-tagged with its
    // class, or a cached transient failure would read permanent downstream
    if (cached.error) {
      const cachedError = new Error(cached.error);
      if (cached.errorClass) cachedError.registryErrorClass = cached.errorClass;
      throw cachedError;
    }

    return cached.result;
  }

  const imgVerifier = new imageVerifier.ImageVerifier(repotag, {
    maxImageSize: config.get('fluxapps.maxImageSize'),
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
      // The registry host the reference resolved to. Derived purely from the
      // repotag, which is part of the cache key, so a cached answer names the
      // same host a fresh one would. The pull path needs it and used to run a
      // second full verification just to learn it.
      provider: imgVerifier.provider,
      // Compressed manifest size (lower bound on decompressed) for an early
      // rootFs-fit reject at ingestion; the install-time inspect is authoritative.
      imageSizeBytes: imgVerifier.imageSizeBytes,
      // Decompressed on-disk size read from the layers' own size records - the
      // figure rootFsGb budgets. 0 when a layer could not be read, and the
      // clearance figure is what a declaration must cover when a gzip trailer
      // wrapped with more than one plausible answer.
      decompressedSizeBytes: imgVerifier.decompressedSizeBytes,
      decompressedSizeClearanceBytes: imgVerifier.decompressedSizeClearanceBytes,
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

    // Cache failure with custom TTL based on error type; the class travels with
    // it so a cache-served failure routes the same as a fresh one
    fluxCaching.dockerHubVerificationCache.set(cacheKey, {
      result: null,
      error: error.message,
      errorClass: error.registryErrorClass ?? null,
    }, { ttl: ttlMs });

    throw error;
  }
}

/**
 * The official blocked-repository list, or null when no copy could be obtained.
 *
 * policyStore owns fetching, validating, caching and holding last-known-good, so null
 * here means it has nothing from any layer — not that the most recent fetch failed.
 * @returns {Array|null} List of blocked repositories
 */
function getBlockedRepositories() {
  return policyStore.get('blockedRepositories');
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

async function isImageBlocked(appName, images, options = {}) {
  const { owner = null, hash = null } = options;

  const repos = getBlockedRepositories();

  // A null list means no copy could be obtained from any layer — not "nothing is
  // blocked" — so install gates defer rather than admit an image they could not check.
  // An empty list ([]) is a real "obtained, nothing blocked".
  const undetermined = repos === null;

  if (!repos) {
    return { blocked: false, reason: null, undetermined };
  }

  const blocked = repos.map(stripTag);

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

  return { blocked: false, reason: null, undetermined };
}

/**
 * A repository reference with any tag or digest removed. Entries are compared
 * against this form, never against the raw repotag.
 * @param {string} repotag
 * @returns {string}
 */
function repositoryOf(repotag) {
  const separator = repotag.lastIndexOf(':');
  return separator > -1 ? repotag.substring(0, separator) : repotag;
}

/**
 * The namespace an image is published under. An image with no namespace is its
 * own, which is how a bare entry reaches an official library image.
 * @param {string} repository
 * @returns {string}
 */
function namespaceOf(repository) {
  const separator = repository.lastIndexOf('/');
  return separator > -1 ? repository.substring(0, separator) : repository;
}

/**
 * The blocklist, as typed entries.
 *
 * `blocklist.json` states what each entry refuses - an application hash, an
 * application name, an owner, an image or a namespace - so an entry is compared
 * against exactly one field. `blockedrepositories.json` cannot: there an entry is
 * a bare string tested against all of them, so `grafana` refuses both the
 * application called grafana and every image under the grafana namespace, and
 * whoever wrote it had no way to say which was meant.
 *
 * The flat document is the fallback, and its entries keep that older meaning -
 * they are marked `legacy` rather than guessed at, because guessing a kind is the
 * ambiguity this reader exists to remove.
 *
 * Null means the list could not be obtained from either document. That is not
 * "nothing is blocked": callers refuse or defer on it.
 * @returns {Promise<Array<{kind: string, value: string}>|null>}
 */
async function getBlocklist() {
  const cachedResponse = fluxCaching.blockedRepositoriesCache.get('blocklist');
  if (cachedResponse) {
    return cachedResponse;
  }
  try {
    const response = await serviceHelper.axiosGet(`${config.get('policy.baseUrl')}/blocklist.json`);
    // Every element must be a typed entry, and there must be at least one. A
    // response that is merely array-shaped is the flat document or an error page,
    // and taking it would answer "nothing is blocked" from something that never
    // said so - discarding entries and reading as success. An empty answer falls
    // through to the flat document, which is generated from this one and so
    // carries the same verdict.
    const { data } = response;
    const typed = Array.isArray(data) && data.length
      && data.every((entry) => entry && typeof entry.kind === 'string' && typeof entry.value === 'string');
    if (typed) {
      fluxCaching.blockedRepositoriesCache.set('blocklist', data);
      return data;
    }
  } catch (error) {
    // An absent or unreachable typed document is not a failure while releases
    // that predate it are still being served the flat one.
    log.info(`Typed blocklist unavailable (${error.message}); falling back to blockedrepositories.json`);
  }
  // Anything that is not a list is "could not ask", not "nothing is blocked". The flat
  // document is fetched and cached on whether the response was truthy, so an error page
  // served as 200 is held for six hours - and mapping over it throws a TypeError that no
  // caller recognises, which in the spawner reads as a permanently unspawnable application
  // rather than as a policy source that could not be read.
  const repos = await getBlockedRepositories();
  if (!Array.isArray(repos)) return null;
  return repos.map((value) => ({ kind: 'legacy', value }));
}

/**
 * Why this application is blocked, or null.
 *
 * `images` may be null, which asks only the questions that need no components:
 * an application's name, owner and hash are plaintext on the stored record, so
 * they can be answered for an application whose specification cannot be read.
 * @param {Array<{kind: string, value: string}>} entries From getBlocklist
 * @param {{name: string, owner: string, hash: string, images: string[]|null}} subject
 * @returns {string|null}
 */
function blockedReasonFor(entries, subject) {
  const repositories = (subject.images ?? []).map(repositoryOf);
  const namespaces = repositories.map(namespaceOf);

  const matchedImage = (value) => repositories.find((repository) => repository === value);
  const matchedNamespace = (value) => namespaces.find((namespace) => namespace === value);

  // One entry's verdict. Named rather than inlined so the loop below can stop at
  // the first refusal: a subject is refused for ONE stated reason, and the entries
  // after it decide nothing.
  const reasonFor = (entry) => {
    const { value } = entry;
    switch (entry.kind) {
      case 'hash':
        return subject.hash && value === subject.hash ? `${value} is not allowed to be spawned` : null;
      case 'name':
        return subject.name && value === subject.name ? `Application ${value} is not allowed to run` : null;
      case 'owner':
        return subject.owner && value === subject.owner ? `${value} is not allowed to run applications` : null;
      case 'image':
        return matchedImage(value) ? `Image ${value} is blocked. Application ${subject.name} cannot be spawned.` : null;
      case 'org':
        return matchedNamespace(value) ? `Organisation ${value} is blocked. Application ${subject.name} cannot be spawned.` : null;
      case 'legacy': {
        // One string against four fields, which is what the flat document means
        // and the reason the typed one exists. Order follows the reader it
        // replaces, so a legacy entry refuses for the same stated reason it
        // always did.
        const pure = repositoryOf(value);
        if (subject.hash && pure === subject.hash) return `${pure} is not allowed to be spawned`;
        if (subject.owner && pure === subject.owner) return `${pure} is not allowed to run applications`;
        if (matchedImage(pure)) return `Image ${pure} is blocked. Application ${subject.name} cannot be spawned.`;
        if (matchedNamespace(pure)) return `Organisation ${pure} is blocked. Application ${subject.name} cannot be spawned.`;
        return null;
      }
      default:
        // A kind this release does not know refuses nothing. A newer document can
        // then ship before the reader that understands it, which is how the
        // signed bundle is designed to roll out.
        return null;
    }
  };

  // eslint-disable-next-line no-restricted-syntax
  for (const entry of entries) {
    const reason = reasonFor(entry);
    if (reason) return reason;
  }
  return null;
}

/**
 * The repositories an application's components run, or null when they cannot be
 * read - an enterprise specification carries them inside its encrypted blob.
 * @param {object} appSpecs
 * @returns {string[]|null}
 */
function imagesOf(appSpecs) {
  if (appSpecs.version <= 3) {
    return appSpecs.repotag ? [appSpecs.repotag] : null;
  }
  if (!Array.isArray(appSpecs.compose) || !appSpecs.compose.length) return null;
  return appSpecs.compose.map((component) => component.repotag).filter((repotag) => repotag);
}


/**
 * Check Docker accessibility for repository
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>} Docker accessibility result
 */
async function checkDockerAccessibility(req, res) {
  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', async () => {
    try {
      const authorized = await verificationHelper.verifyPrivilege(Privilege.USER, authOf(req));
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

module.exports = {
  classifyVerificationError,
  verifyRepository,
  getBlockedRepositories,
  getBlocklist,
  blockedReasonFor,
  imagesOf,
  isImageBlocked,
  checkDockerAccessibility,
};
