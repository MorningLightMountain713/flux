/**
 * Typed repository over the apps collections. Every read hydrates raw
 * Mongo documents into `FluxAppSpec*` class instances via the version
 * class's `deserialize` (or `fromCanonical` for v9+), so consumers never
 * reach into field names that only exist in one version's shape. Writes
 * still take the raw plain-object form — the submission path builds the
 * storage shape and passes it through.
 *
 * Collections in scope:
 *   globalAppsInformation   — current live spec per app (appsglobal)
 *   localAppsInformation    — apps currently installed on this node (appslocal)
 *   globalAppsMessages      — permanent message log (appsglobal)
 *
 * For META-only consumers (existence checks, name/hash/owner lookups,
 * location tracking) there are `*Raw` variants that skip hydration and
 * return the plain document — spec-shape fields aren't read.
 *
 * Enterprise decryption is NOT this module's concern. `getGlobalAppInfo`
 * on an encrypted v8 spec returns a `FluxAppSpecV8` with
 * `isEncrypted() === true`. Callers that need cleartext compose/env call
 * the enterprise decryption helpers separately.
 */

const config = require('config');
const log = require('../../lib/log');
const dbHelper = require('../dbHelper');
const { getSpec, getSpecBackend } = require('../utils/specLibs');
const {
  globalAppsInformation,
  localAppsInformation,
  globalAppsMessages,
} = require('../utils/appConstants');

/**
 * Case-insensitive exact-match regex for a name query.
 * @param {string} name
 * @returns {RegExp}
 */
function nameRegex(name) {
  return new RegExp(`^${name}$`, 'i');
}

/**
 * Hydrate a raw spec document into the appropriate `FluxAppSpec*`
 * instance. Returns null if the version class isn't registered.
 *
 * v1-v8: document is the spec itself (flat or compose) with `hash` and
 * `height` appended. `VersionClass.deserialize(doc)` captures those as
 * private metadata.
 *
 * v9+: not yet wired here. v9 documents are shaped differently
 * (`{appSpecifications, hash, height, ...}`) and the flux-spec base
 * class doesn't expose `deserialize`. When the big-bang v9 cutover
 * starts flowing v9 records into these collections, extend this
 * dispatch — for now throw loudly so it's caught early.
 *
 * @param {Object|null} doc - Raw Mongo document, or null from findOne miss.
 * @returns {Promise<import('@runonflux/flux-spec').FluxAppSpecBase|null>}
 */
async function hydrate(doc) {
  if (!doc) return null;

  await getSpec(); // ensure FluxAppSpecBase + v9 registration
  const { deserializeSpec } = await getSpecBackend(); // registers v1-v8 + brings dispatch

  if (doc.version === 9) {
    // v9 storage shape is nested under `appSpecifications` — hydration path
    // lands when the v9 ingestion cutover ships.
    throw new Error('appsRepository: v9 hydration not yet implemented');
  }

  // deserializeSpec dispatches on wire shape: encrypted v8 (non-empty
  // enterprise string) → EncryptedSpecV8, everything else → the cleartext
  // VersionClass.deserialize. Returns a FluxAppSpecBase or
  // EncryptedSpecBase instance. Callers branch with instanceof.
  try {
    return deserializeSpec(doc);
  } catch (err) {
    log.warn(`appsRepository.hydrate: ${err.message} (name=${doc.name}, version=${doc.version})`);
    return null;
  }
}

function globalDb() {
  return dbHelper.databaseConnection().db(config.database.appsglobal.database);
}

function localDb() {
  return dbHelper.databaseConnection().db(config.database.appslocal.database);
}

/**
 * Look up a single live app spec by name (case-insensitive), hydrated
 * into the appropriate class instance.
 *
 * @param {string} name
 * @returns {Promise<import('@runonflux/flux-spec').FluxAppSpecBase|null>}
 */
async function getGlobalAppInfo(name) {
  const doc = await dbHelper.findOneInDatabase(
    globalDb(),
    globalAppsInformation,
    { name: nameRegex(name) },
    { projection: { _id: 0 } },
  );
  return hydrate(doc);
}

/**
 * Look up a single live app spec by name, returning the raw document.
 * Use this when the caller only needs metadata (name, hash, height,
 * owner, expire) and doesn't read spec-shape fields — skips hydration.
 *
 * @param {string} name
 * @param {Object} [projection] - Mongo projection object, e.g. `{name:1, hash:1}`.
 * @returns {Promise<Object|null>}
 */
async function getGlobalAppInfoRaw(name, projection = {}) {
  const finalProjection = { _id: 0, ...projection };
  return dbHelper.findOneInDatabase(
    globalDb(),
    globalAppsInformation,
    { name: nameRegex(name) },
    { projection: finalProjection },
  );
}

/**
 * List live app specs matching the filter, returning hydrated
 * class instances. Documents whose version has no class registered
 * are logged and dropped.
 *
 * @param {Object} [options]
 * @param {Object} [options.filter] - Mongo filter. Defaults to all.
 * @param {Object} [options.sort]   - Mongo sort. Defaults to no sort.
 * @returns {Promise<import('@runonflux/flux-spec').FluxAppSpecBase[]>}
 */
async function listGlobalAppInfo({ filter = {}, sort } = {}) {
  const options = { projection: { _id: 0 } };
  if (sort) options.sort = sort;
  const docs = await dbHelper.findInDatabase(
    globalDb(),
    globalAppsInformation,
    filter,
    options,
  );
  const specs = [];
  for (const doc of docs) {
    // eslint-disable-next-line no-await-in-loop
    const spec = await hydrate(doc);
    if (spec) specs.push(spec);
  }
  return specs;
}

/**
 * List live app specs matching the filter, returning raw documents.
 * Use this for bulk metadata scans (expiry sweep, owner lookups) that
 * don't care about spec shape.
 *
 * @param {Object} [options]
 * @param {Object} [options.filter]
 * @param {Object} [options.projection]
 * @param {Object} [options.sort]
 * @returns {Promise<Object[]>}
 */
async function listGlobalAppInfoRaw({ filter = {}, projection, sort } = {}) {
  const mongoOptions = { projection: { _id: 0, ...(projection || {}) } };
  if (sort) mongoOptions.sort = sort;
  return dbHelper.findInDatabase(
    globalDb(),
    globalAppsInformation,
    filter,
    mongoOptions,
  );
}

/**
 * Upsert a spec into globalAppsInformation. Uses replaceOne semantics
 * rather than $set so stale fields from a previous spec version don't
 * linger on the document (the ghost-field bug that bit v4+ upgrades).
 *
 * The caller supplies the storage-shape plain object — same shape the
 * spec was ingested as, plus `hash` and `height` appended. No hydration
 * here; this is the write side.
 *
 * @param {Object} specDoc - Storage-shape document with at least {name, version, hash, height}.
 * @returns {Promise<import('mongodb').UpdateResult>}
 */
async function upsertGlobalAppInfo(specDoc) {
  if (!specDoc || !specDoc.name) {
    throw new Error('appsRepository.upsertGlobalAppInfo: specDoc.name required');
  }
  return dbHelper.replaceOneInDatabase(
    globalDb(),
    globalAppsInformation,
    { name: specDoc.name },
    specDoc,
    { upsert: true },
  );
}

/**
 * Remove a spec by name (case-insensitive). Returns Mongo delete result.
 *
 * @param {string} name
 * @returns {Promise<import('mongodb').DeleteResult>}
 */
async function removeGlobalAppInfo(name) {
  return dbHelper.removeDocumentsFromCollection(
    globalDb(),
    globalAppsInformation,
    { name: nameRegex(name) },
  );
}

/**
 * Look up a single installed-on-this-node app spec by name,
 * hydrated into the appropriate class instance.
 *
 * @param {string} name
 * @returns {Promise<import('@runonflux/flux-spec').FluxAppSpecBase|null>}
 */
async function getInstalledApp(name) {
  const doc = await dbHelper.findOneInDatabase(
    localDb(),
    localAppsInformation,
    { name: nameRegex(name) },
    { projection: { _id: 0 } },
  );
  return hydrate(doc);
}

/**
 * List all installed apps on this node, hydrated.
 *
 * @returns {Promise<import('@runonflux/flux-spec').FluxAppSpecBase[]>}
 */
async function listInstalledApps() {
  const docs = await dbHelper.findInDatabase(
    localDb(),
    localAppsInformation,
    {},
    { projection: { _id: 0 } },
  );
  const specs = [];
  for (const doc of docs) {
    // eslint-disable-next-line no-await-in-loop
    const spec = await hydrate(doc);
    if (spec) specs.push(spec);
  }
  return specs;
}

/**
 * List installed apps as raw documents. Use when spec-shape fields
 * aren't read (e.g. `{ name, hash }` existence checks).
 *
 * @param {Object} [options]
 * @returns {Promise<Object[]>}
 */
async function listInstalledAppsRaw({ filter = {}, projection } = {}) {
  const mongoOptions = { projection: { _id: 0, ...(projection || {}) } };
  return dbHelper.findInDatabase(
    localDb(),
    localAppsInformation,
    filter,
    mongoOptions,
  );
}

/**
 * Look up a permanent app message by its hash. Messages are stored
 * with the spec nested under `appSpecifications`; hydrate that
 * nested shape for callers that want the class instance.
 *
 * @param {string} hash
 * @returns {Promise<Object|null>} `{ message: rawDoc, spec: FluxAppSpec*|null }`
 *   or null if the hash isn't found.
 */
async function getAppMessage(hash) {
  const doc = await dbHelper.findOneInDatabase(
    globalDb(),
    globalAppsMessages,
    { hash },
    { projection: { _id: 0 } },
  );
  if (!doc) return null;
  const specBlob = doc.appSpecifications || doc.zelAppSpecifications;
  if (!specBlob) return { message: doc, spec: null };
  // Message spec blobs have version but no hash/height on themselves;
  // copy the message's hash/height into the spec shape so the hydrated
  // class carries its own metadata.
  const docForHydrate = { ...specBlob, hash: doc.hash, height: doc.height };
  const spec = await hydrate(docForHydrate);
  return { message: doc, spec };
}

module.exports = {
  getGlobalAppInfo,
  getGlobalAppInfoRaw,
  listGlobalAppInfo,
  listGlobalAppInfoRaw,
  upsertGlobalAppInfo,
  removeGlobalAppInfo,
  getInstalledApp,
  listInstalledApps,
  listInstalledAppsRaw,
  getAppMessage,
};
