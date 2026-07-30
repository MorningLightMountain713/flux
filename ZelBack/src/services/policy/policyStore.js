const config = require('config');
const fs = require('fs').promises;
const path = require('path');
const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');
const policyDocumentRepository = require('../appDatabase/policyDocumentRepository');

// The network's enforcement documents: which images may run, which owners may install on
// which enterprise nodes, which nodes are DOSed for tampering, and the image whitelist.
// They are edited without a FluxOS release, so every node fetches them at runtime.
//
// Each document has three layers, and only the middle one is written:
//
//   seed       the tracked helpers/<file> in this checkout. A release-time floor,
//              refreshed when the node pulls. NEVER written to — it is a tracked file
//              and a dirty one makes the next `git pull` conflict.
//   last-good  a zelfluxlocal collection, written after a fetch validates.
//   live       in memory, replaced only by a fetch that validates.
//
// The contract every consumer depends on: `get()` returns null ONLY when no layer
// produced a value. null means the question went unanswered; an empty array or object
// means it was answered and nothing is listed. Collapsing the two is how a failed fetch
// once cleared the DOS on a node the network had deliberately blocked.
//
// There is deliberately no expiry on last-good. An old blocklist beats no blocklist and
// an old allowlist beats an empty one, so no point exists at which discarding it improves
// the outcome — an expiry would only be a deadline on information the node cannot get.
// The refresh loop is the recovery mechanism.

// helpers/ lives at the repo root, four levels up from this file.
const HELPERS_DIR = path.join(__dirname, '..', '..', '..', '..', 'helpers');
const FETCH_TIMEOUT_MS = 10 * 1000; // bound the fetch so boot is never stuck on it

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * A valid node->owners map is a plain object whose every value is an array of strings.
 * Anything else is rejected wholesale rather than coerced — a single malformed value
 * would otherwise make a node host nothing and uninstall everything.
 */
function isValidNodeOwnerMap(value) {
  const isPlainObject = typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isPlainObject) return false;
  return Object.values(value).every(
    (owners) => Array.isArray(owners) && owners.every((owner) => typeof owner === 'string'),
  );
}

// No entry for repositories.json — the image whitelist. Nothing has enforced it since
// isWhitelisted() was written in July 2024 without a caller, and the document itself has not
// been edited since September 2024. Registering it here would have every node polling for a
// list that governs nothing.
const DOCUMENTS = {
  blockedRepositories: { file: 'blockedrepositories.json', validate: isStringArray, intervalMs: 6 * HOUR },
  tamperingBlocklist: { file: 'tamperingblockednodes.json', validate: isStringArray, intervalMs: 12 * HOUR },
  enterpriseNodes: { file: 'enterprisenodes.json', validate: isValidNodeOwnerMap, intervalMs: 6 * HOUR },
};

// name -> payload. Absent key means no layer has produced a value for it yet.
const live = new Map();
// name -> array of handlers fired after a refresh that replaced the payload.
const subscribers = new Map();
const intervals = new Map();
let started = false;

function documentUrl(name) {
  return `${config.policy.baseUrl}/${DOCUMENTS[name].file}`;
}

/**
 * The live payload for a policy document, or null when no layer has produced one.
 * @param {string} name Registry key.
 * @returns {any|null}
 */
function get(name) {
  return live.has(name) ? live.get(name) : null;
}

/**
 * Register a handler fired after a successful refresh that replaced `name`'s payload.
 * Lets consumers react to a membership change without this module knowing about them.
 * Handler errors are isolated.
 * @param {string} name Registry key.
 * @param {function} handler
 */
function onChange(name, handler) {
  if (!handler) return;
  if (!subscribers.has(name)) subscribers.set(name, []);
  subscribers.get(name).push(handler);
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
    if (DOCUMENTS[name].validate(cached.payload)) return cached.payload;
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
 * Fetch one document and, if it validates, make it live and persist it.
 * A failed or invalid fetch leaves the current value untouched.
 * @param {string} name Registry key.
 * @returns {Promise<boolean>} true when the live payload was replaced.
 */
async function refresh(name) {
  const url = documentUrl(name);
  try {
    const res = await serviceHelper.axiosGet(url, { timeout: FETCH_TIMEOUT_MS });
    if (!res || !DOCUMENTS[name].validate(res.data)) {
      log.error(`policyStore - invalid ${name} payload from ${url}, keeping current value`);
      return false;
    }
    live.set(name, res.data);
    const etag = (res.headers && (res.headers.etag ?? res.headers.ETag)) || null;
    await policyDocumentRepository.setPolicyDocument(name, res.data, etag)
      .catch((error) => log.warn(`policyStore - failed to cache ${name}: ${error.message}`));
    return true;
  } catch (error) {
    log.warn(`policyStore - failed to fetch ${name} from ${url}, keeping current value: ${error.message}`);
    return false;
  }
}

/**
 * Load every document from cache (falling back to its seed), then fetch each one and
 * schedule its refresh. Idempotent.
 *
 * Awaited callers get boot-time data without an unbounded wait: the cache read is local
 * and each fetch is capped at FETCH_TIMEOUT_MS. Must run after mongo is up, or the cache
 * layer is skipped and only the seed is available until the first successful fetch.
 */
async function startSync() {
  if (started) return;
  started = true;

  const names = Object.keys(DOCUMENTS);

  await Promise.all(names.map(async (name) => {
    const restored = await readFromCache(name) ?? await readFromSeed(name);
    if (restored !== null) live.set(name, restored);
  }));

  await Promise.all(names.map(async (name) => {
    if (await refresh(name)) notify(name);
  }));

  names.forEach((name) => {
    intervals.set(name, setInterval(async () => {
      const replaced = await refresh(name).catch((error) => {
        log.error(`policyStore - ${name} refresh error: ${error.message}`);
        return false;
      });
      if (replaced) notify(name);
    }, DOCUMENTS[name].intervalMs));
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
  subscribers.clear();
}

module.exports = {
  get,
  onChange,
  refresh,
  startSync,
  stopSync,
  reset,
  DOCUMENTS,
};
