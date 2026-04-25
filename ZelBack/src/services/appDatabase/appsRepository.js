/**
 * Typed repository over the apps collections. Every read hydrates raw
 * Mongo documents into `InstantiatedSpec` instances that carry the spec
 * class plus hash, height, registeredAt, and expiry logic. Writes
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
 * on an encrypted v8 app returns an `InstantiatedSpec` whose `.spec` is
 * an `EncryptedSpecBase` instance (`instantiated.isEncrypted()` is true).
 * Callers that need cleartext access the spec and decrypt explicitly.
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
 * Hydrate a raw Mongo document into an InstantiatedSpec — the domain
 * type that carries the spec class plus hash, height, registeredAt, and
 * expiry logic. Returns null if the version class isn't registered.
 *
 * v1-v8: document is the spec itself (flat or compose) with `hash` and
 * `height` as top-level fields.
 *
 * v9+: not yet wired here. v9 documents nest the spec under
 * `appSpecifications` — extend this dispatch when v9 records flow into
 * these collections.
 *
 * @param {Object|null} doc - Raw Mongo document, or null from findOne miss.
 * @returns {Promise<import('@runonflux/flux-spec-backend').InstantiatedSpec|null>}
 */
async function hydrate(doc) {
  if (!doc) return null;

  await getSpec(); // ensure FluxAppSpecBase + v9 registration
  const { InstantiatedSpec } = await getSpecBackend();

  if (doc.version === 9) {
    throw new Error('appsRepository: v9 hydration not yet implemented');
  }

  try {
    return InstantiatedSpec.deserialize(doc);
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
 * @returns {Promise<import('@runonflux/flux-spec-backend').InstantiatedSpec|null>}
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
 * @returns {Promise<import('@runonflux/flux-spec-backend').InstantiatedSpec[]>}
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
 * @returns {Promise<import('@runonflux/flux-spec-backend').InstantiatedSpec|null>}
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
 * @returns {Promise<import('@runonflux/flux-spec-backend').InstantiatedSpec[]>}
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
 * Look up a single installed-on-this-node app spec by name, returning
 * the raw document. Use when spec-shape fields aren't read.
 *
 * @param {string} name
 * @param {Object} [projection]
 * @returns {Promise<Object|null>}
 */
async function getInstalledAppRaw(name, projection = {}) {
  const finalProjection = { _id: 0, ...projection };
  return dbHelper.findOneInDatabase(
    localDb(),
    localAppsInformation,
    { name: nameRegex(name) },
    { projection: finalProjection },
  );
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
 * Remove an installed app by name (case-insensitive).
 *
 * @param {string} name
 * @returns {Promise<import('mongodb').DeleteResult>}
 */
async function removeInstalledApp(name) {
  return dbHelper.findOneAndDeleteInDatabase(
    localDb(),
    localAppsInformation,
    { name: nameRegex(name) },
    {},
  );
}

/**
 * Insert a spec into localAppsInformation. The caller supplies the
 * storage-shape plain object.
 *
 * @param {Object} specDoc
 * @returns {Promise<import('mongodb').InsertOneResult>}
 */
async function insertInstalledApp(specDoc) {
  return dbHelper.insertOneToDatabase(
    localDb(),
    localAppsInformation,
    specDoc,
  );
}

/**
 * Replace (or insert) a spec in localAppsInformation by name.
 *
 * @param {string} name
 * @param {Object} specDoc
 * @returns {Promise<import('mongodb').UpdateResult>}
 */
async function upsertInstalledApp(name, specDoc) {
  if (!name) {
    throw new Error('appsRepository.upsertInstalledApp: name required');
  }
  if (!specDoc) {
    throw new Error('appsRepository.upsertInstalledApp: specDoc required');
  }
  return dbHelper.replaceOneInDatabase(
    localDb(),
    localAppsInformation,
    { name: nameRegex(name) },
    specDoc,
    { upsert: true },
  );
}

/**
 * Look up a permanent app message by its hash. Messages are stored
 * with the spec nested under `appSpecifications`; hydrate that
 * nested shape for callers that want the class instance.
 *
 * @param {string} hash
 * @returns {Promise<Object|null>} `{ message: rawDoc, spec: InstantiatedSpec|null }`
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

async function listAppMessagesByName(name) {
  const projection = { projection: { _id: 0 } };
  const query1 = { 'appSpecifications.name': name };
  const query2 = { 'zelAppSpecifications.name': name };
  const results1 = await dbHelper.findInDatabase(globalDb(), globalAppsMessages, query1, projection);
  const results2 = await dbHelper.findInDatabase(globalDb(), globalAppsMessages, query2, projection);
  return [...results1, ...results2];
}

async function listLiveV7Secrets() {
  const docs = await dbHelper.findInDatabase(
    globalDb(),
    globalAppsInformation,
    { version: 7, nodes: { $exists: true, $ne: [] } },
    { projection: { _id: 0, name: 1, owner: 1, compose: 1 } },
  );
  const results = [];
  for (const doc of docs) {
    if (!doc.compose) continue;
    for (const comp of doc.compose) {
      if (comp.secrets) {
        results.push({
          appName: doc.name,
          owner: doc.owner,
          componentName: comp.name,
          secrets: comp.secrets,
        });
      }
    }
  }
  return results;
}

async function listHistoricalV7Secrets() {
  const docs = await dbHelper.findInDatabase(
    globalDb(),
    globalAppsMessages,
    {
      'appSpecifications.version': 7,
      'appSpecifications.nodes': { $exists: true, $ne: [] },
    },
    { projection: { _id: 0, 'appSpecifications.owner': 1, 'appSpecifications.compose': 1 } },
  );
  const results = [];
  for (const doc of docs) {
    const spec = doc.appSpecifications;
    if (!spec || !spec.compose) continue;
    for (const comp of spec.compose) {
      if (comp.secrets) {
        results.push({
          owner: spec.owner,
          componentName: comp.name,
          secrets: comp.secrets,
        });
      }
    }
  }
  return results;
}

module.exports = {
  getGlobalAppInfo,
  getGlobalAppInfoRaw,
  listGlobalAppInfo,
  listGlobalAppInfoRaw,
  upsertGlobalAppInfo,
  removeGlobalAppInfo,
  getInstalledApp,
  getInstalledAppRaw,
  listInstalledApps,
  listInstalledAppsRaw,
  removeInstalledApp,
  insertInstalledApp,
  upsertInstalledApp,
  getAppMessage,
  listAppMessagesByName,
};
