const config = require('config');
const fs = require('fs').promises;
const path = require('path');
const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');
const policyDocumentRepository = require('../appDatabase/policyDocumentRepository');
const policyArtifactRepository = require('../appDatabase/policyArtifactRepository');

// The network's enforcement policy: which images may run, which owners may install on which
// enterprise nodes, which nodes are DOSed for tampering. Edited without a FluxOS release, so
// every node fetches it at runtime.
//
// The contract every consumer depends on: a document that could not be obtained reads as
// ABSENT, never as empty. null means the question went unanswered; an empty array or object
// means it was answered and nothing is listed. Collapsing the two is how a failed blocklist
// fetch once cleared the DOS on a node the network had deliberately blocked.
//
// There is deliberately no expiry on last-known-good. An old blocklist beats no blocklist and
// an old allowlist beats an empty one, so no point exists at which discarding it improves the
// outcome. The refresh loop is the recovery mechanism.
//
// Two kinds of entry:
//
//   document  small JSON. Seeded from the tracked helpers/ copy, cached inline in mongo, held
//             in memory, served by get(), shape-checked by its own validator.
//   artifact  too large for a mongo document (the 16 MiB BSON cap) and not read whole by
//             anything. No seed, bytes cached in GridFS, never retained here and never served
//             by get() — its receiver holds the only in-memory representation, and the
//             receiver IS the validator: it throws on anything malformed, which rejects the
//             fetch. That collapses validation to the single parse the receiver already does.
//
// Anything derived from those two words stays derived. A per-entry `seed: false` plus
// `cache: 'gridfs'` plus a retention flag would only ever be valid as one combination.

// helpers/ lives at the repo root, four levels up from this file.
const HELPERS_DIR = path.join(__dirname, '..', '..', '..', '..', 'helpers');

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * A valid node->owners map is a plain object whose every value is an array of strings.
 * Anything else is rejected wholesale rather than coerced — a single malformed value would
 * otherwise make a node host nothing and uninstall everything.
 */
function isValidNodeOwnerMap(value) {
  const isPlainObject = typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isPlainObject) return false;
  return Object.values(value).every(
    (owners) => Array.isArray(owners) && owners.every((owner) => typeof owner === 'string'),
  );
}

// Identity and shape. Refresh intervals and fetch timeouts are config.policy, keyed by these
// same names.
//
// No entry for repositories.json — the image whitelist. Nothing has enforced it since
// isWhitelisted() was written in July 2024 without a caller, and the document itself has not
// been edited since September 2024. An entry here means every node polls for it, so a document
// earns one only when something demonstrably reads it and acts on what it says.
const DOCUMENTS = {
  blockedRepositories: { kind: 'document', file: 'blockedrepositories.json', validate: isStringArray },
  tamperingBlocklist: { kind: 'document', file: 'tamperingblockednodes.json', validate: isStringArray },
  enterpriseNodes: { kind: 'document', file: 'enterprisenodes.json', validate: isValidNodeOwnerMap },
  // The IP -> (org, country) table placement uses to count fault domains. Inert until its
  // consumer registers a receiver, so the entry costs nothing before that lands.
  ipLocationTable: { kind: 'artifact', file: 'iplocation.json' },
};

// Documents only. Artifacts are never retained: an absent key here is what get() reports.
const live = new Map();
// name -> ETag the current copy was served with, for the next conditional request.
const etags = new Map();
// name -> handlers fired after a refresh replaced a document's payload.
const subscribers = new Map();
// name -> the single receiver for an artifact. Its throw rejects a fetch.
const receivers = new Map();
const intervals = new Map();
let started = false;

function isArtifact(name) {
  return DOCUMENTS[name].kind === 'artifact';
}

function documentUrl(name) {
  return `${config.policy.baseUrl}/${DOCUMENTS[name].file}`;
}

function timeoutFor(name) {
  return config.policy.fetchTimeoutMs[name] ?? config.policy.fetchTimeoutMs.default;
}

function intervalFor(name) {
  return config.policy.refreshIntervalMs[name];
}

/**
 * The live payload for a document, or null when no layer has produced one.
 *
 * Artifacts are never served here — they are not held in memory and get() reporting null for
 * one would read as "not obtained" when it may well be loaded in its receiver.
 * @param {string} name Registry key.
 * @returns {any|null}
 */
function get(name) {
  if (!DOCUMENTS[name] || isArtifact(name)) return null;
  return live.has(name) ? live.get(name) : null;
}

/**
 * Register a handler fired after a refresh that replaced `name`'s payload. Handler errors are
 * isolated and logged — one bad subscriber must not stop another document refreshing.
 * @param {string} name Registry key.
 * @param {function} handler
 */
function onChange(name, handler) {
  if (!handler) return;
  if (!subscribers.has(name)) subscribers.set(name, []);
  subscribers.get(name).push(handler);
}

/**
 * Register the receiver for an artifact. Deliberately not onChange: a receiver's throw is how
 * a malformed artifact is rejected, so its errors must NOT be isolated the way onChange's are,
 * or a bad artifact would be cached as good. One receiver per artifact; must be registered
 * before startSync, since an artifact with no receiver is not fetched at all.
 * @param {string} name Registry key.
 * @param {function(Buffer): void} receiver Throws on a malformed artifact.
 */
function onArtifact(name, receiver) {
  if (!receiver) return;
  if (receivers.has(name)) {
    log.error(`policyStore - ${name} already has a receiver; ignoring the second`);
    return;
  }
  receivers.set(name, receiver);
}

function notify(name) {
  (subscribers.get(name) || []).forEach((handler) => {
    try {
      handler();
    } catch (error) {
      log.error(`policyStore - ${name} change handler error: ${error.message}`);
    }
  });
}

async function readFromCache(name) {
  try {
    const cached = await policyDocumentRepository.getPolicyDocument(name);
    if (!cached) return null;
    if (DOCUMENTS[name].validate(cached.payload)) return cached;
    log.error(`policyStore - cached ${name} failed validation, ignoring`);
  } catch (error) {
    log.warn(`policyStore - failed to read cached ${name}: ${error.message}`);
  }
  return null;
}

async function readFromSeed(name) {
  const { file, validate } = DOCUMENTS[name];
  try {
    const raw = await fs.readFile(path.join(HELPERS_DIR, file), 'utf8');
    const parsed = JSON.parse(raw);
    if (validate(parsed)) return parsed;
    log.error(`policyStore - seed ${file} is not a valid ${name} document, ignoring`);
  } catch (error) {
    log.warn(`policyStore - failed to read seed ${file}: ${error.message}`);
  }
  return null;
}

/**
 * Fetch, sending the ETag we hold so an unchanged document costs a 304 rather than its full
 * body. Without this a large artifact re-downloads on every interval on every node.
 */
async function conditionalGet(name, options = {}) {
  const etag = etags.get(name);
  return serviceHelper.axiosGet(documentUrl(name), {
    timeout: timeoutFor(name),
    ...options,
    headers: etag ? { 'If-None-Match': etag } : {},
    // axios rejects anything outside 2xx by default, and 304 is the successful outcome here.
    validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
  });
}

function etagOf(res) {
  return (res.headers && (res.headers.etag ?? res.headers.ETag)) || null;
}

/**
 * Refresh a document: fetch, validate shape, replace the live value and the cache.
 * A failed or invalid fetch leaves the current value untouched.
 * @returns {Promise<boolean>} true when the live payload was replaced.
 */
async function refreshDocument(name) {
  const res = await conditionalGet(name);

  if (res.status === 304) return false;

  if (!DOCUMENTS[name].validate(res.data)) {
    log.error(`policyStore - invalid ${name} payload from ${documentUrl(name)}, keeping current value`);
    return false;
  }

  live.set(name, res.data);
  etags.set(name, etagOf(res));
  await policyDocumentRepository.setPolicyDocument(name, res.data, etagOf(res))
    .catch((error) => log.warn(`policyStore - failed to cache ${name}: ${error.message}`));
  return true;
}

/**
 * Refresh an artifact: fetch raw bytes, hand them to the receiver, and cache them only if the
 * receiver accepted. The receiver's throw is the validation — there is no separate pass over
 * the bytes, which for a multi-megabyte artifact would mean parsing it twice.
 * @returns {Promise<boolean>} true when the receiver accepted new bytes.
 */
async function refreshArtifact(name) {
  const receiver = receivers.get(name);
  if (!receiver) return false;

  const res = await conditionalGet(name, { responseType: 'arraybuffer' });

  if (res.status === 304) return false;

  const bytes = Buffer.from(res.data);

  // Before the cache write, so a malformed artifact never displaces a good stored copy.
  receiver(bytes);

  etags.set(name, etagOf(res));
  await policyArtifactRepository.writeArtifactBytes(name, bytes, etagOf(res))
    .catch((error) => log.warn(`policyStore - failed to cache artifact ${name}: ${error.message}`));
  return true;
}

/**
 * Fetch one entry and apply it if it is good. Never throws: a refresh failure is a
 * could-not-ask, and the caller's current value stands.
 * @param {string} name Registry key.
 * @returns {Promise<boolean>} true when something was replaced.
 */
async function refresh(name) {
  try {
    return isArtifact(name) ? await refreshArtifact(name) : await refreshDocument(name);
  } catch (error) {
    log.warn(`policyStore - failed to refresh ${name} from ${documentUrl(name)}, keeping current value: ${error.message}`);
    return false;
  }
}

async function restoreDocument(name) {
  const cached = await readFromCache(name);
  if (cached) {
    live.set(name, cached.payload);
    if (cached.etag) etags.set(name, cached.etag);
    return;
  }
  const seeded = await readFromSeed(name);
  if (seeded !== null) live.set(name, seeded);
}

async function restoreArtifact(name) {
  if (!receivers.get(name)) return;
  await policyArtifactRepository.sweepOrphanedArtifacts(name);

  const record = await policyArtifactRepository.getArtifactRecord(name);
  if (!record) return;

  const bytes = await policyArtifactRepository.readArtifactBytes(record.fileId);
  if (!bytes) return;

  try {
    receivers.get(name)(bytes);
    if (record.etag) etags.set(name, record.etag);
  } catch (error) {
    // Stored bytes this build cannot read: a downgrade, or a corrupt write. Not fatal — the
    // refresh below replaces them — but the etag must not be kept, or the 304 that follows
    // would leave the receiver holding nothing.
    log.error(`policyStore - stored ${name} rejected by its receiver, discarding: ${error.message}`);
    etags.delete(name);
  }
}

/**
 * Load everything from its last-known-good, then refresh.
 *
 * Documents are awaited: they are small, and consumers (identity resolution, the spawn loop,
 * spec validation) need them before they run. Artifacts restore from local storage awaited but
 * refresh DETACHED — a multi-megabyte fetch with a minutes-long timeout must never gate boot.
 * Idempotent.
 */
async function startSync() {
  if (started) return;
  started = true;

  const names = Object.keys(DOCUMENTS);
  const documents = names.filter((name) => !isArtifact(name));
  const artifacts = names.filter(isArtifact);

  // An artifact with no receiver is inert by design — it costs nothing before its consumer
  // exists. But if bytes are already cached for one, something WAS consuming it and no longer
  // is, which is a wiring mistake rather than a state we ever reach on purpose. It fails
  // quietly otherwise: the stored copy is kept forever (there is no expiry) and its consumer
  // runs on data that silently stops being refreshed.
  await Promise.all(artifacts.filter((name) => !receivers.has(name)).map(async (name) => {
    const stranded = await policyArtifactRepository.getArtifactRecord(name).catch(() => null);
    if (stranded) {
      log.error(`policyStore - ${name} has cached bytes but no receiver: its consumer is not wired up, so the stored copy will never be refreshed`);
    } else {
      log.info(`policyStore - ${name} has no receiver, not fetching it`);
    }
  }));

  await Promise.all(documents.map(restoreDocument));
  await Promise.all(artifacts.map(restoreArtifact));

  await Promise.all(documents.map(async (name) => {
    if (await refresh(name)) notify(name);
  }));

  artifacts.filter((name) => receivers.has(name)).forEach((name) => {
    refresh(name).then((replaced) => { if (replaced) notify(name); });
  });

  names.filter((name) => !isArtifact(name) || receivers.has(name)).forEach((name) => {
    intervals.set(name, setInterval(async () => {
      if (await refresh(name)) notify(name);
    }, intervalFor(name)));
  });
}

function stopSync() {
  intervals.forEach((handle) => clearInterval(handle));
  intervals.clear();
  started = false;
}

/** Drop all in-memory state. Tests only — production has one store for the process. */
function reset() {
  stopSync();
  live.clear();
  etags.clear();
  subscribers.clear();
  receivers.clear();
}

module.exports = {
  get,
  onChange,
  onArtifact,
  refresh,
  startSync,
  stopSync,
  reset,
  DOCUMENTS,
};
