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
const policyStore = require('../policyStore');
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
 * The official blocked-repository list, from the signed bundle, or null when this node
 * holds no verified bundle. Null is not an empty list: callers refuse or defer on it.
 * @returns {Array|null} List of blocked repositories
 */
function getBlockedRepositories() {
  return policyStore.getDocument('blockedrepositories');
}

// The repository name with any :tag / @digest removed, via the shared parser.
// Non-image entries (owner ids, hashes) don't parse and pass through unchanged.
function stripTag(imageRef) {
  const parsed = imageVerifier.ImageVerifier.parseImageReference(imageRef);
  return parsed.error ? imageRef : parsed.reference;
}

async function isImageBlocked(appName, images, options = {}) {
  const { owner = null, hash = null } = options;

  const entries = getBlocklist();
  if (!entries) {
    return { blocked: false, reason: null, undetermined: true };
  }
  const reason = blockedReasonFor(entries, {
    name: appName, owner, hash, images,
  });
  return reason
    ? { blocked: true, reason }
    : { blocked: false, reason: null, undetermined: false };
}

/**
 * A repository reference with any tag or digest removed. Entries are compared
 * against this form, never against the raw repotag.
 * @param {string} repotag
 * @returns {string}
 */
function repositoryOf(repotag) {
  return stripTag(repotag);
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
 * application called grafana and every image under the grafana namespace.
 *
 * The flat document is read only when the bundle carries no typed one, and its
 * entries keep their broader meaning, marked `legacy` rather than guessed at. Null
 * means this node holds no verified bundle, or holds one whose typed document is
 * malformed. That is not "nothing is blocked": callers refuse or defer on it.
 * @returns {Array<{kind: string, value: string}>|null}
 */
function getBlocklist() {
  // PRECEDENCE, NOT A COMBINE. The typed document decides outright whenever the bundle
  // carries one, and the flat one is then never read.
  //
  // An EMPTY typed document is published policy saying nothing is blocked, and returns [].
  // A typed document of the wrong shape inside a validly signed bundle makes the bundle
  // internally inconsistent, and refusing beats guessing: it answers null. Suite 1501
  // asserts the same rule from the other end.
  const typed = policyStore.getDocument('blocklist');
  if (typed !== null && typed !== undefined) {
    if (!Array.isArray(typed)) return null;
    if (typed.every((entry) => entry && typeof entry.kind === 'string' && typeof entry.value === 'string')) {
      return typed;
    }
    return null;
  }

  const repos = getBlockedRepositories();
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
 * What a removal answered, as the sweep reads it: whether the application is settled,
 * and when it is not, why it is still owed.
 *
 * DEFERRED says nothing about the application - the node was doing something else -
 * and FAILED says it may still be here. Neither is a removal, and reading either as
 * one leaves a blocked application running with nothing coming back for it.
 * @param {{status: string}} outcome From appUninstaller.uninstallApplication
 * @returns {string|null} null when settled, otherwise the reason it is owed
 */
function owedAfterRemoval(outcome) {
  const status = outcome && outcome.status;
  if (status === 'removed' || status === 'skipped') return null;
  return status === 'deferred' ? 'busy' : 'failed';
}

/**
 * A compliance sweeper: judges what the node holds against the blocklist and removes
 * what the network refuses, driven by the policy rather than a clock.
 *
 * One object that owns its state, so the boot path and the paths that ask for a scoped
 * pass reach the same sweeper rather than two that disagree about what is owed.
 *
 * WHAT IT DEPENDS ON IS PASSED IN, including the clock and the knobs. A pass is
 * entirely about timing - when it starts, how long it holds itself open, when it asks
 * again - so a test that cannot control time can only assert the parts that are not
 * the point.
 *
 * @param {object} deps
 * @param {Function} deps.listInstalled Answers {specs, unreadable}: the installed
 *   specifications, and the names of rows that could not be read. Rejects when the
 *   table cannot be read at all.
 * @param {Function} deps.readInstalled One installed specification by name, null when
 *   the node does not hold it. Rejects when the record cannot be read.
 * @param {Function} deps.imagesOf The images a specification runs, or null when its
 *   components cannot be read (an enterprise specification that did not decrypt)
 * @param {Function} deps.uninstall Removes an application, answering {status} with an
 *   appUninstaller UninstallStatus value
 * @param {Function} [deps.blocklist] The typed blocklist, or null when it cannot be read
 * @param {object} [deps.policy] Carries policyReady and waitForPolicyReady
 * @param {object} [deps.bundle] Carries onBundleChanged
 * @param {object} [deps.knobs] Read once: the sweeper's timings do not change under it
 * @param {object} [deps.timers] set and clear, for a test that owns time
 * @param {Function} [deps.wait] Holds the pass open between removals
 * @returns {{runPass: Function, request: Function, start: Function, stop: Function}}
 */
function createComplianceSweeper({
  listInstalled,
  readInstalled,
  imagesOf,
  uninstall,
  blocklist = getBlocklist,
  // eslint-disable-next-line global-require
  policy = require('../utils/globalState'),
  bundle = policyStore,
  knobs = {
    complianceSweepStaggerMs: config.get('fluxapps.complianceSweepStaggerMs'),
    complianceRemovalSpacingMs: config.get('fluxapps.complianceRemovalSpacingMs'),
    complianceRetryBaseMs: config.get('fluxapps.complianceRetryBaseMs'),
    complianceRetryMaxMs: config.get('fluxapps.complianceRetryMaxMs'),
  },
  timers = { set: setTimeout, clear: clearTimeout },
  wait = serviceHelper.delay,
} = {}) {
  const {
    complianceSweepStaggerMs: staggerMs,
    complianceRemovalSpacingMs: spacingMs,
    complianceRetryBaseMs: retryBaseMs,
    complianceRetryMaxMs: retryMaxMs,
  } = knobs;

  // Applications this node still owes a pass, by name, and why it owes them.
  //
  //   deferred    a specification whose components could not be read, so its images
  //               were never judged. Nothing announces that it has become readable.
  //   busy        the node was installing or removing something else, so the removal
  //               was refused. It says nothing about the application.
  //   failed      the removal was attempted and did not complete.
  //   unread      the stored record could not be read, so nothing was established
  //               about the application either way.
  //   unexamined  a pass stopped before reaching it.
  //
  // None of these has an event to wait on. Everything else this acts on does: the
  // bundle changing, the gate opening, and the install and adoption paths.
  const owed = new Map();
  // Whether what is owed is the whole node rather than named applications. A pass that
  // stopped before it classified anything knows no names to owe, and the applications
  // it never looked at are owed a pass all the same.
  let owedWholeNode = false;

  let inFlight = null;
  let again = false;
  let staggerTimer = null;
  let retryTimer = null;
  let retryDelayMs = retryBaseMs;
  // What was owed the last time a wait was set, to compare the next one against. The
  // whole node is not a list of names and never compares equal to one.
  const EVERYTHING = Symbol('every installed application');
  let owedWhenLastArmed = null;

  const hold = (appName, reason) => { owed.set(appName, reason); };
  const holdEverything = () => { owedWholeNode = true; };

  /** What is owed, in a form two passes can be compared by. Null when nothing is. */
  function owedNow() {
    if (owedWholeNode) return EVERYTHING;
    return owed.size ? [...owed.keys()].sort().join(' ') : null;
  }

  /**
   * Set the wait for what is owed now, replacing one armed for anything else.
   *
   * SELF-CANCELLING: the timer exists for what is owed and ends with it, so a node
   * owing nothing runs no timer. Decided once a pass is over, never while one runs - a
   * pass spaces its removals over minutes and holds applications as it goes, so a timer
   * armed at the moment of holding fires inside the pass that armed it.
   *
   * THE WAIT BELONGS TO A DEBT, and every pass decides it against the debt it ends
   * with. It doubles for as long as the same thing is owed and starts again when that
   * changes - a node that resolved something has shown it can, and what is left of a
   * debt that is moving is worth asking about sooner than one that is not. A debt
   * discharged and owed again changed twice, so it is asked about at the base rate.
   */
  function armRetry() {
    const owing = owedNow();
    if (retryTimer && owing === owedWhenLastArmed) return;
    if (retryTimer) timers.clear(retryTimer);
    retryTimer = null;
    const unchanged = owing !== null && owing === owedWhenLastArmed;
    owedWhenLastArmed = owing;
    if (owing === null) {
      retryDelayMs = retryBaseMs;
      return;
    }
    retryDelayMs = unchanged ? Math.min(retryDelayMs * 2, retryMaxMs) : retryBaseMs;
    retryTimer = timers.set(() => {
      retryTimer = null;
      const wholeNode = owedWholeNode;
      owedWholeNode = false;
      const scope = wholeNode ? null : new Set(owed.keys());
      if (!wholeNode && !scope.size) return undefined;
      log.info(`Asking again about ${wholeNode ? 'every installed application' : [...owed].map(([name, why]) => `${name} (${why})`).join(', ')}`);
      // Returned, not discarded: setTimeout ignores it, and a scheduler that drives this
      // deliberately - a test owning the clock - can wait for the pass it just started.
      // eslint-disable-next-line no-use-before-define
      return request(scope);
    }, retryDelayMs);
    if (retryTimer && retryTimer.unref) retryTimer.unref();
  }

  /**
   * The application as the node holds it NOW.
   *
   * A pass spaces its removals, so minutes separate the decision from the act. The
   * record can move in between - an adoption onto a different image, an owner transfer -
   * and a verdict reached against the old one is a verdict about an application this
   * node is no longer running. The images already read are carried forward only while
   * the record they came from is unchanged.
   *
   * TWO FACTS, TWO FIELDS. A record that could not be read and a record that says the
   * node does not hold it are different answers, and only the second ends a blocked
   * application's claim on this pass.
   *
   * @returns {Promise<{answered: boolean, subject: object|null}>}
   */
  async function subjectNow(appName, decided) {
    let spec;
    try {
      spec = await readInstalled(appName);
    } catch (error) {
      return { answered: false, subject: null };
    }
    if (!spec) return { answered: true, subject: null };
    const images = spec.hash === decided.hash ? decided.images : await imagesOf(spec).catch(() => null);
    return {
      answered: true,
      subject: {
        name: spec.name, owner: spec.owner, hash: spec.hash, images,
      },
    };
  }

  /**
   * One pass: judge what the node holds and remove what the network refuses.
   * @param {Set<string>} [scope] Only these applications. Every installed one when absent.
   * @returns {Promise<void>}
   */
  async function runPass(scope = null) {
    try {
      // THE LIST THIS ACTS ON HAS TO BE THE NETWORK'S, not whatever this node last held.
      // A bundle restored from disk answers the blocklist without anything having
      // established that it is still current, so a ban lifted while this node was down
      // still reads as a ban - and what follows is an uninstall, broadcast to the
      // network, of an application that is now permitted.
      if (!policy.policyReady) {
        log.info('Network policy not confirmed; leaving installed applications as they are this pass');
        holdEverything();
        return;
      }
      const { specs, unreadable } = await listInstalled();
      const entries = blocklist();
      if (!entries) {
        // Removing on this would tear down every application on the node the first time
        // the document was unreadable.
        log.warn('Blocklist unavailable; leaving installed applications as they are this pass');
        holdEverything();
        return;
      }

      // AN APPLICATION THE NODE NO LONGER HOLDS HAS NOTHING LEFT TO ANSWER FOR, whether
      // this pass is about it or not. Asked of the whole table, which every pass reads.
      const installed = new Set([...specs.map((spec) => spec.name), ...unreadable]);
      [...owed.keys()].forEach((name) => { if (!installed.has(name)) owed.delete(name); });

      const inScope = (name) => !scope || scope.has(name);
      const toRemove = new Map();

      // A row that could not be read still has its name, and a ban on the name is
      // answered for it. Anything else about it is owed.
      unreadable.filter(inScope).forEach((name) => {
        const subject = {
          name, owner: null, hash: null, images: null,
        };
        const reason = blockedReasonFor(entries, subject);
        if (reason) toRemove.set(name, { reason, subject });
        else hold(name, 'unread');
      });

      // eslint-disable-next-line no-restricted-syntax
      for (const spec of specs.filter((candidate) => inScope(candidate.name))) {
        // Name, owner and hash are plaintext on the stored record, so a ban on any of
        // them is answered before the components are read - including for an
        // application whose components cannot be.
        const plain = {
          name: spec.name, owner: spec.owner, hash: spec.hash, images: null,
        };
        const plainReason = blockedReasonFor(entries, plain);
        if (plainReason) {
          toRemove.set(spec.name, { reason: plainReason, subject: plain });
          // eslint-disable-next-line no-continue
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const images = await imagesOf(spec);
        if (images === null) {
          log.warn(`Cannot check blocked images for ${spec.name}: its components could not be read`);
          hold(spec.name, 'deferred');
          // eslint-disable-next-line no-continue
          continue;
        }
        const subject = { ...plain, images };
        const reason = blockedReasonFor(entries, subject);
        if (reason) toRemove.set(spec.name, { reason, subject });
        // Read, and answered on every field, with nothing owed. An application that IS
        // blocked is answered for by its removal and not before.
        else owed.delete(spec.name);
      }

      const removals = [...toRemove.entries()];
      // eslint-disable-next-line no-restricted-syntax
      for (const [index, [appName, decided]] of removals.entries()) {
        // ASKED AGAIN FOR EACH ONE, against the list as it stands now and the record as
        // it stands now. Spacing holds a pass open for minutes and neither half of what
        // it decided at the top survives that.
        //
        // WHAT IT COULD NOT ASK IS OWED, never assumed either way. A pass that stops
        // here leaves the applications after this one unexamined.
        if (!policy.policyReady) {
          log.warn('Network policy no longer confirmed; ending this pass');
          removals.slice(index).forEach(([name]) => hold(name, 'unexamined'));
          return;
        }
        const current = blocklist();
        if (!current) {
          log.warn('Blocklist no longer available; ending this pass');
          removals.slice(index).forEach(([name]) => hold(name, 'unexamined'));
          return;
        }
        // eslint-disable-next-line no-await-in-loop
        const { answered, subject } = decided.subject.hash === null
          ? { answered: true, subject: decided.subject }
          : await subjectNow(appName, decided.subject);
        if (!answered) {
          log.warn(`Could not read the record for ${appName}; asking again`);
          hold(appName, 'unread');
          // eslint-disable-next-line no-continue
          continue;
        }
        if (!subject) {
          owed.delete(appName);
          // eslint-disable-next-line no-continue
          continue;
        }
        const reason = blockedReasonFor(current, subject);
        if (!reason) {
          log.info(`Application ${appName} is no longer blocked, leaving it installed`);
          owed.delete(appName);
          // eslint-disable-next-line no-continue
          continue;
        }
        log.warn(`REMOVAL REASON: Blocked by network policy - ${reason} (imageManager)`);
        // eslint-disable-next-line no-await-in-loop
        const outcome = await uninstall(appName);
        const stillOwed = owedAfterRemoval(outcome);
        if (stillOwed) {
          log.warn(`Application ${appName} was not removed (${outcome?.status}); asking again`);
          hold(appName, stillOwed);
        } else {
          owed.delete(appName);
        }
        if (index < removals.length - 1) {
          // eslint-disable-next-line no-await-in-loop
          await wait(spacingMs);
        }
      }
    } catch (error) {
      // EVERY WAY OUT OF A PASS OWES WHAT IT DID NOT JUDGE, this one included. What
      // threw is not known to have been reached, let alone answered for.
      holdEverything();
      log.error(error);
    }
  }

  /**
   * Run a pass, and once more if anything asked for one while it ran.
   *
   * COALESCED RATHER THAN QUEUED. A pass is a function of the blocklist this node holds
   * now, so requests arriving during one are all answered by a single further pass. A
   * scoped request coalesces into a full pass rather than narrowing it: the full pass
   * answers everything the scoped one would have.
   *
   * @param {Set<string>} [scope] Only these applications. Every installed one when absent.
   * @returns {Promise<void>} The run in progress, so a caller can wait for it.
   */
  function request(scope = null) {
    if (inFlight) {
      again = true;
      return inFlight;
    }
    let mine = null;
    mine = (async () => {
      let next = scope;
      do {
        // Cleared BEFORE the pass, so a request arriving during it is not read as one
        // this pass already accounted for.
        again = false;
        // eslint-disable-next-line no-await-in-loop
        await runPass(next);
        next = null;
      } while (again);
      armRetry();
    })().finally(() => { if (inFlight === mine) inFlight = null; });
    inFlight = mine;
    return mine;
  }

  /**
   * Sweep whenever the policy this node enforces changes.
   *
   * TWO TRIGGERS, BECAUSE NEITHER COVERS THE OTHER. The gate opening is what makes the
   * blocklist safe to act on at all, and it opens without the bundle changing. A bundle
   * changing is what makes an already-safe blocklist say something different.
   *
   * BOTH ARE STAGGERED, because adopting a bundle fires both - the gate drains its
   * waiters synchronously, so an unstaggered trigger would put the whole fleet's
   * removals, and the broadcast of each one, into the same instant.
   *
   * @returns {Function} Ends the subscription.
   */
  function start() {
    const stagger = () => {
      // One is enough: a pass that has not started yet already reads whatever arrives
      // before it does.
      if (staggerTimer) return;
      staggerTimer = timers.set(() => {
        staggerTimer = null;
        return request();
      }, Math.floor(Math.random() * staggerMs));
      if (staggerTimer && staggerTimer.unref) staggerTimer.unref();
    };
    const unsubscribe = bundle.onBundleChanged(() => {
      // A bundle this node may not act on yet changes nothing it may do. The gate
      // opening carries its own trigger.
      if (!policy.policyReady) return;
      stagger();
    });
    policy.waitForPolicyReady().then(stagger);
    return unsubscribe;
  }

  /**
   * Drop the timers and everything owed. A pass already running is disowned rather
   * than stopped: it can no longer clear the handle of whatever starts next.
   */
  function stop() {
    if (staggerTimer) timers.clear(staggerTimer);
    if (retryTimer) timers.clear(retryTimer);
    staggerTimer = null;
    retryTimer = null;
    retryDelayMs = retryBaseMs;
    owedWhenLastArmed = null;
    owedWholeNode = false;
    inFlight = null;
    again = false;
    owed.clear();
  }

  return {
    runPass, request, start, stop,
  };
}

/**
 * What the sweeper reads and acts on for this node: the installed table, the images
 * its deployment views run, and the uninstaller.
 *
 * Required when called, not when this module loads: the installer and the spawner
 * load this module, and the uninstaller and the deployment layer load theirs.
 * @returns {{listInstalled: Function, readInstalled: Function, imagesOf: Function, uninstall: Function}}
 */
function nodeComplianceDeps() {
  /* eslint-disable global-require */
  const appsRepository = require('../appDatabase/appsRepository');
  const deploymentProvider = require('../appRuntime/deploymentProvider');
  const appUninstaller = require('../appLifecycle/appUninstaller');
  /* eslint-enable global-require */
  return {
    listInstalled: () => appsRepository.listInstalledAppsAndUnreadable(),
    // A row this node holds and cannot read is not a row it does not hold.
    readInstalled: async (name) => {
      const { specs, unreadable } = await appsRepository.listInstalledAppsAndUnreadable({ filter: { name } });
      if (specs.length) return specs[0];
      if (unreadable.length) throw new Error(`the installed record of ${name} could not be read`);
      return null;
    },
    // Images are spec-level, so every identity's deployment view carries the same set.
    imagesOf: async (spec) => {
      try {
        const deployments = await deploymentProvider.buildDeployments(spec);
        return [...new Set(deployments.flatMap((deployment) => deployment.allImages()))];
      } catch (error) {
        return null;
      }
    },
    uninstall: (name) => appUninstaller.uninstallApplication(name, { broadcastRemoval: true }),
  };
}

// The sweeper this node is running: one object, created at boot, that the adoption path
// can ask for a scoped pass without building a second one over the same node.
let activeSweeper = null;

/**
 * Start the node's compliance sweeper. Called once, at boot.
 * @param {object} [deps] What it reads and acts on; this node's, when absent
 * @returns {Function} Ends the subscription.
 */
function startComplianceSweeps(deps = nodeComplianceDeps()) {
  activeSweeper = createComplianceSweeper(deps);
  return activeSweeper.start();
}

/**
 * Ask the running sweeper for a pass. Does nothing before boot has started one - there
 * is no node state to act on, and building a sweeper here would make a second one.
 * @param {Set<string>} [scope] Only these applications
 * @returns {Promise<void>}
 */
function requestComplianceSweep(scope = null) {
  if (!activeSweeper) return Promise.resolve();
  return activeSweeper.request(scope);
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
  isImageBlocked,
  checkDockerAccessibility,
  createComplianceSweeper,
  nodeComplianceDeps,
  startComplianceSweeps,
  requestComplianceSweep,
};
