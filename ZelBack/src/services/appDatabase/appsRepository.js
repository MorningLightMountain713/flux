const config = require('config');
const log = require('../../lib/log');
const dbHelper = require('../dbHelper');
const { getSpec, getSpecBackend } = require('../utils/specLibs');
const fluxEventBus = require('../utils/fluxEventBus');
const {
  globalAppsInformation,
  localAppsInformation,
  globalAppsMessages,
  globalAppsTempMessages,
  globalAppsInstallingErrorsLocations,
  globalAppsInstallingErrorsBroadcasts,
  globalAppsInstallingLocations,
  globalAppsLocations,
  appsHashesCollection,
} = require('../utils/appConstants');

// One-row-per-app content-slot manifest register (latest-wins). Not in appConstants
// because only the content-manifest plane touches it.
const { appContentManifests } = config.database.appsglobal.collections;

let storageProviderInstance;

async function storageProvider() {
  if (!storageProviderInstance) {
    const MongoStorageProvider = require('../providers/MongoStorageProvider');
    storageProviderInstance = await MongoStorageProvider.create();
  }
  return storageProviderInstance;
}

function nameRegex(name) {
  return new RegExp(`^${name}$`, 'i');
}

async function hydrate(doc) {
  if (!doc) return null;

  await getSpec();
  const { InstantiatedSpec } = await getSpecBackend();

  try {
    return InstantiatedSpec.deserialize(doc);
  } catch (err) {
    log.warn(`appsRepository.hydrate: ${err.message} (name=${doc.name}, version=${doc.version})`);
    return null;
  }
}

function chainDb() {
  return dbHelper.databaseConnection().db(config.database.daemon.database);
}

function globalDb() {
  return dbHelper.databaseConnection().db(config.database.appsglobal.database);
}

function localDb() {
  return dbHelper.databaseConnection().db(config.database.appslocal.database);
}

// ── Spawner Queries ──────────────────────────────────────────────────

const { expireHeightExpr } = require('./appsMaintenance');

async function findUnderProvisionedApps(currentHeight, nowSeconds) {
  const minBlocksAllowance = config.fluxapps.newMinBlocksAllowance;
  const minTimeAllowance = minBlocksAllowance * 30;

  const pipeline = [
    {
      $addFields: {
        _isAlive: {
          $cond: {
            if: { $gte: ['$version', 9] },
            then: { $gt: [{ $add: ['$registeredAt', '$ttl'] }, nowSeconds + minTimeAllowance] },
            else: {
              $gt: [
                expireHeightExpr('$height', '$expire'),
                currentHeight + minBlocksAllowance,
              ],
            },
          },
        },
      },
    },
    { $match: { _isAlive: true } },
    { $unset: '_isAlive' },
    {
      $lookup: {
        from: config.database.appsglobal.collections.appsLocations,
        localField: 'name',
        foreignField: 'name',
        as: '_locations',
      },
    },
    {
      $addFields: {
        _actual: { $size: '$_locations' },
        _required: { $ifNull: ['$instances', 3] },
      },
    },
    { $unset: '_locations' },
    {
      $match: {
        $expr: { $lt: ['$_actual', '$_required'] },
      },
    },
    { $sort: { name: 1 } },
    // Emit { actual, required, doc } with doc byte-identical to storage: the
    // pipeline's working fields must never reach hydrate (encrypted specs
    // bind their cleartext metadata into the AAD, and deserialize rejects
    // foreign fields).
    { $replaceWith: { actual: '$_actual', required: '$_required', doc: '$$ROOT' } },
    { $unset: ['doc._actual', 'doc._required'] },
  ];

  const database = globalDb();
  const results = await dbHelper.aggregateInDatabase(database, globalAppsInformation, pipeline);

  const candidates = [];
  for (const { actual, required, doc } of results) {
    // eslint-disable-next-line no-await-in-loop
    const instantiated = await hydrate(doc);
    if (instantiated) {
      candidates.push({ instantiated, actual, required });
    }
  }
  return candidates;
}

// ── Global App Specs (globalAppsInformation) ───────────────────────

async function getGlobalAppInfo(name) {
  const doc = await dbHelper.findOneInDatabase(
    globalDb(), globalAppsInformation,
    { name: nameRegex(name) },
    { projection: { _id: 0 } },
  );
  return hydrate(doc);
}

async function getGlobalAppOwner(name) {
  const doc = await dbHelper.findOneInDatabase(
    globalDb(), globalAppsInformation,
    { name: nameRegex(name) },
    { projection: { _id: 0, owner: 1 } },
  );
  return doc ? doc.owner : null;
}

async function getGlobalAppHeight(name) {
  const doc = await dbHelper.findOneInDatabase(
    globalDb(), globalAppsInformation,
    { name: nameRegex(name) },
    { projection: { _id: 0, height: 1 } },
  );
  return doc && typeof doc.height === 'number' ? doc.height : null;
}

async function existsGlobalApp(name) {
  const doc = await dbHelper.findOneInDatabase(
    globalDb(), globalAppsInformation,
    { name: nameRegex(name) },
    { projection: { _id: 0, name: 1 } },
  );
  return !!doc;
}

/**
 * Of the given candidate names, the ones that still exist in the global app set.
 * One projection read (name only). Names are matched exactly — v9 slot apps (the
 * only manifest holders) carry lowercase-canonical names, the same exact key the
 * manifest collection is indexed on — so the manifest reaper converges cleanly.
 * @param {string[]} names
 * @returns {Promise<string[]>}
 */
async function listExistingGlobalAppNames(names) {
  if (!Array.isArray(names) || names.length === 0) return [];
  const docs = await dbHelper.findInDatabase(
    globalDb(), globalAppsInformation,
    { name: { $in: names } },
    { projection: { _id: 0, name: 1 } },
  );
  return docs.map((doc) => doc.name);
}

async function listGlobalAppInfo({ filter = {}, sort } = {}) {
  const options = { projection: { _id: 0 } };
  if (sort) options.sort = sort;
  const docs = await dbHelper.findInDatabase(
    globalDb(), globalAppsInformation, filter, options,
  );
  const specs = [];
  for (const doc of docs) {
    // eslint-disable-next-line no-await-in-loop
    const spec = await hydrate(doc);
    if (spec) specs.push(spec);
  }
  return specs;
}

async function listGlobalAppNodes() {
  const docs = await dbHelper.findInDatabase(
    globalDb(), globalAppsInformation,
    { version: { $gte: 7 } },
    { projection: { _id: 0, name: 1, nodes: 1 } },
  );
  return docs.map((doc) => ({ name: doc.name, nodes: doc.nodes || [] }));
}

async function upsertGlobalAppInfo(specDoc, { upsert = true } = {}) {
  if (!specDoc || !specDoc.name) {
    throw new Error('appsRepository.upsertGlobalAppInfo: specDoc.name required');
  }
  return dbHelper.replaceOneInDatabase(
    globalDb(), globalAppsInformation,
    { name: specDoc.name }, specDoc, { upsert },
  );
}

async function removeGlobalAppInfo(name) {
  return dbHelper.removeDocumentsFromCollection(
    globalDb(), globalAppsInformation, { name: nameRegex(name) },
  );
}

// Both the location rows and the archived broadcasts: leaving the broadcasts
// would let message sync redistribute error records for an app that no longer
// exists in the registry.
async function removeAppInstallingErrorRecords(name) {
  await dbHelper.removeDocumentsFromCollection(
    globalDb(), globalAppsInstallingErrorsLocations, { name },
  );
  await dbHelper.removeDocumentsFromCollection(
    globalDb(), globalAppsInstallingErrorsBroadcasts, { 'data.name': name },
  );
}

// ── Content-Slot Manifests (appContentManifests) ───────────────────
// The content manifest is a permanent, latest-wins register: one row per app,
// ordered by a monotonic version. The content domain (contentSlotService) owns the
// verify/decrypt logic and the row shape; this registry owns every read/write.

/**
 * The stored gossip-form manifest row for an app, or null. Carries the top-level
 * monotonic `version` floor alongside the signed `data` body and the broadcast
 * `envelope` (absent on a catch-up body).
 * @param {string} appName
 * @returns {Promise<object|null>}
 */
async function getContentManifest(appName) {
  return dbHelper.findOneInDatabase(
    globalDb(), appContentManifests, { appName }, { projection: { _id: 0 } },
  );
}

/**
 * Record the manifest version this node has actually delivered to the app's RUNNING
 * container, as a node-local annotation on the register row. Distinct from the row's
 * `version` (the latest KNOWN manifest): the gap `version > appliedVersion` is what tells
 * a returning/steady node its running content is behind, independent of the (mutable)
 * on-disk bytes. Advanced monotonically; never upserts (you cannot have applied a manifest
 * you never stored). Written on disjoint fields from upsertContentManifest, so the two
 * writers never clobber each other on the same row.
 *
 * @param {string} appName
 * @param {number} version
 * @returns {Promise<void>}
 */
async function setContentManifestApplied(appName, version) {
  await dbHelper.updateOneInDatabase(
    globalDb(), appContentManifests,
    { appName, $or: [{ appliedVersion: { $exists: false } }, { appliedVersion: { $lt: version } }] },
    { $set: { appliedVersion: version } },
  );
}

/**
 * Latest-wins upsert of a manifest row. A confirmed store advances a strictly-older
 * row OR promotes a same-version quarantined row in place (clearing its TTL); a
 * quarantine store holds only a strictly-newer version (TTL-reaped if its spec never
 * arrives). Returns false when a same/higher version already won the race (the unique
 * appName index throws 11000), true otherwise.
 *
 * @param {object} row - { appName, version, data, envelope? }
 * @param {object} opts - { confirmed=true, expireAt?, clearEnvelope? }
 * @returns {Promise<boolean>}
 */
async function upsertContentManifest(row, opts = {}) {
  const { appName, version, data, envelope } = row;
  const confirmed = opts.confirmed !== false;
  const base = { appName, version, confirmed, receivedAt: new Date(), data };
  if (envelope) base.envelope = envelope;
  // A store WITHOUT an envelope (a catch-up body) must carry none — clear any stale
  // one left by a row it promotes/advances over, else the kept envelope would sign the
  // OLD data and the row would be served-then-rejected over sync.
  const clearEnvelope = opts.clearEnvelope ?? !envelope;

  let filter;
  let update;
  if (confirmed) {
    filter = { appName, $or: [{ version: { $lt: version } }, { version, confirmed: false }] };
    update = { $set: base, $unset: clearEnvelope ? { expireAt: '', envelope: '' } : { expireAt: '' } };
  } else {
    filter = { appName, version: { $lt: version } };
    update = { $set: { ...base, expireAt: opts.expireAt } };
    if (clearEnvelope) update.$unset = { envelope: '' };
  }
  try {
    await dbHelper.updateOneInDatabase(globalDb(), appContentManifests, filter, update, { upsert: true });
    return true;
  } catch (error) {
    if (error && error.code === 11000) return false; // a same/higher version is already stored
    throw error;
  }
}

/** Delete a quarantined (confirmed:false) manifest row — used when it fails
 *  verification, so a real manifest at the same version isn't blocked by the floor. */
async function deleteQuarantinedContentManifest(appName) {
  return dbHelper.removeDocumentsFromCollection(
    globalDb(), appContentManifests, { appName, confirmed: false },
  );
}

/** The (appName, version) vector of every confirmed manifest — the version index
 *  SERVED to peers (only verified rows are authoritative to others). */
async function listConfirmedContentManifestVersions() {
  const docs = await dbHelper.findInDatabase(
    globalDb(), appContentManifests,
    { confirmed: true },
    { projection: { _id: 0, appName: 1, version: 1 } },
  );
  return docs.map((doc) => ({ appName: doc.appName, version: doc.version }));
}

/** The (appName, version) vector of every HELD manifest, quarantined included — the
 *  reconcile's local gap view. A body held pending spec-confirm is already fetched
 *  (transport done, promotion is the spec-gated lifecycle), so it is not a gap:
 *  re-fetching it from another peer would hit the same local spec gate. */
async function listContentManifestVersions() {
  const docs = await dbHelper.findInDatabase(
    globalDb(), appContentManifests,
    {},
    { projection: { _id: 0, appName: 1, version: 1 } },
  );
  return docs.map((doc) => ({ appName: doc.appName, version: doc.version }));
}

/**
 * The re-servable signed broadcasts for confirmed manifests, rebuilt as
 * `{ ...envelope, data }` so a requester verifies them with batchVerifyBroadcasts.
 * Only rows that carry an envelope are servable. Scope to `appNames` for the two-step
 * fetch (the specific rows a peer asked for); omit for the full confirmed set.
 * @param {string[]} [appNames]
 * @returns {Promise<object[]>}
 */
async function listConfirmedContentManifestBroadcasts(appNames) {
  const filter = { confirmed: true, envelope: { $exists: true } };
  if (Array.isArray(appNames) && appNames.length) filter.appName = { $in: appNames };
  const rows = await dbHelper.findInDatabase(
    globalDb(), appContentManifests, filter, { projection: { _id: 0, envelope: 1, data: 1 } },
  );
  return rows.map((row) => ({ ...row.envelope, data: row.data }));
}

/**
 * Reap confirmed manifests whose app has left the global set — the permanent
 * lifecycle: a manifest is authoritative until a higher version supersedes it OR its
 * app is removed/expires. Converges the manifest register to the live-app set, the
 * node-plane analogue of the FluxDrive blob GC. Quarantined (confirmed:false) rows are
 * left to the TTL index, so this never races a manifest that arrived just before its
 * spec. Rows younger than the reap grace are never touched: a manifest submitted with
 * a registration is stored confirmed BEFORE the app tx confirms on-chain, so absence
 * from the global set is not yet evidence of a dead app — the grace spans that
 * register window (and a lapsed never-confirmed registration reaps once it ages out).
 * The age re-check on the delete keeps a name re-registered mid-sweep safe. Returns
 * the reaped count.
 * @returns {Promise<{reaped: number, orphans: string[]}>}
 */
async function reapOrphanedContentManifests() {
  const cutoff = new Date(Date.now() - config.fluxapps.contentManifestReapGraceMs);
  const names = await globalDb().collection(appContentManifests)
    .distinct('appName', { confirmed: true, receivedAt: { $lte: cutoff } });
  if (!names.length) return { reaped: 0, orphans: [] };
  const live = new Set(await listExistingGlobalAppNames(names));
  const orphans = names.filter((name) => !live.has(name));
  if (!orphans.length) return { reaped: 0, orphans: [] };
  const result = await dbHelper.removeDocumentsFromCollection(
    globalDb(), appContentManifests,
    { appName: { $in: orphans }, confirmed: true, receivedAt: { $lte: cutoff } },
  );
  const reaped = result?.deletedCount ?? 0;
  if (reaped) fluxEventBus.publish('content:manifestReaped', { count: reaped });
  return { reaped, orphans };
}

// ── Installed Apps (localAppsInformation) ──────────────────────────

async function getInstalledApp(name) {
  const doc = await dbHelper.findOneInDatabase(
    localDb(), localAppsInformation,
    { name: nameRegex(name) },
    { projection: { _id: 0 } },
  );
  return hydrate(doc);
}

async function countInstalledApps() {
  return dbHelper.countInDatabase(localDb(), localAppsInformation, {});
}

async function existsInstalledApp(name) {
  const doc = await dbHelper.findOneInDatabase(
    localDb(), localAppsInformation,
    { name: nameRegex(name) },
    { projection: { _id: 0, name: 1 } },
  );
  return !!doc;
}

async function listInstalledApps({ filter = {} } = {}) {
  const docs = await dbHelper.findInDatabase(
    localDb(), localAppsInformation, filter, { projection: { _id: 0 } },
  );
  const specs = [];
  for (const doc of docs) {
    // eslint-disable-next-line no-await-in-loop
    const spec = await hydrate(doc);
    if (spec) specs.push(spec);
  }
  return specs;
}

async function removeInstalledApp(name) {
  return dbHelper.findOneAndDeleteInDatabase(
    localDb(), localAppsInformation, { name: nameRegex(name) }, {},
  );
}

async function insertInstalledApp(specDoc) {
  return dbHelper.insertOneToDatabase(
    localDb(), localAppsInformation, specDoc,
  );
}

async function upsertInstalledApp(name, specDoc) {
  if (!name) throw new Error('appsRepository.upsertInstalledApp: name required');
  if (!specDoc) throw new Error('appsRepository.upsertInstalledApp: specDoc required');
  return dbHelper.replaceOneInDatabase(
    localDb(), localAppsInformation,
    { name: nameRegex(name) }, specDoc, { upsert: true },
  );
}

// ── Permanent / Temporary Messages ─────────────────────────────────

async function getAppMessage(hash) {
  const doc = await dbHelper.findOneInDatabase(
    globalDb(), globalAppsMessages, { hash }, { projection: { _id: 0 } },
  );
  if (!doc) return null;
  const specBlob = doc.appSpecifications;
  if (!specBlob) return { message: doc, spec: null };
  const docForHydrate = { ...specBlob, hash: doc.hash, height: doc.height };
  const spec = await hydrate(docForHydrate);
  return { message: doc, spec };
}

async function getPermanentMessage(hash) {
  return dbHelper.findOneInDatabase(
    globalDb(), globalAppsMessages, { hash }, { projection: { _id: 0 } },
  );
}

async function getTempMessage(hash) {
  return dbHelper.findOneInDatabase(
    globalDb(), globalAppsTempMessages, { hash }, { projection: { _id: 0 } },
  );
}

async function getTempMessageByName(name) {
  return dbHelper.findOneInDatabase(
    globalDb(), globalAppsTempMessages,
    { 'appSpecifications.name': nameRegex(name) },
    { projection: { _id: 0 }, sort: { timestamp: -1 } },
  );
}

async function storePermanentMessage(doc) {
  await dbHelper.insertOneToDatabase(globalDb(), globalAppsMessages, doc);
}

async function listAppMessagesByName(name) {
  const projection = { projection: { _id: 0 } };
  return dbHelper.findInDatabase(
    globalDb(), globalAppsMessages, { 'appSpecifications.name': name }, projection,
  );
}

/**
 * The most recent on-chain owner of an app that differs from currentOwner.
 * Used to replay pre-v8.10.0 owner-change races: a confirmed update whose
 * signature was made by an owner older than the immediate previous one.
 * @returns {Promise<string|null>}
 */
async function getPreviousOwner(appName, currentOwner) {
  const doc = await dbHelper.findOneInDatabase(
    globalDb(), globalAppsMessages,
    { 'appSpecifications.name': appName, 'appSpecifications.owner': { $ne: currentOwner } },
    { projection: { _id: 0, 'appSpecifications.owner': 1 }, sort: { height: -1 } },
  );
  return doc?.appSpecifications?.owner ?? null;
}

async function getPreviousPermanentMessage(name, beforeTimestamp) {
  const projection = { projection: { _id: 0 } };
  const docs = await dbHelper.findInDatabase(
    globalDb(), globalAppsMessages, { 'appSpecifications.name': name }, projection,
  );
  let latest = null;
  for (const doc of docs) {
    if (doc.timestamp > beforeTimestamp) continue;
    if (!latest || doc.height > latest.height
      || (doc.height === latest.height && doc.timestamp > latest.timestamp)) {
      latest = doc;
    }
  }
  return latest;
}

// ── Upsert-if-newer + Installing Errors ────────────────────────────

async function upsertIfNewer(instantiated) {
  const existingHeight = await getGlobalAppHeight(instantiated.name);
  if (existingHeight !== null && existingHeight >= instantiated.height) return false;
  await upsertGlobalAppInfo(instantiated.serialize());
  return true;
}

async function clearInstallingErrors(name) {
  await dbHelper.removeDocumentsFromCollection(
    globalDb(), globalAppsInstallingErrorsLocations, { name },
  );
}

// ── App Locations (globalAppsLocations) ────────────────────────────

const locationProjection = {
  projection: {
    _id: 0, name: 1, hash: 1, ip: 1, replica: 1,
    broadcastedAt: 1, expireAt: 1, runningSince: 1,
    osUptime: 1, staticIp: 1, state: 1,
  },
};

async function getAppLocation(appName, ip, replica) {
  const query = { name: appName, ip };
  // null matches loose/legacy rows (field absent); omitted matches any row
  // for the (name, ip) - the legacy single-row read.
  if (replica !== undefined) query.replica = replica;
  return dbHelper.findOneInDatabase(
    globalDb(), globalAppsLocations, query, locationProjection,
  );
}

async function isAppRunningOnIp(appName, ip) {
  const locations = await listLocationsByApp(appName);
  return locations.some((loc) => loc.ip.split(':')[0] === ip);
}

async function listLocations() {
  return dbHelper.findInDatabase(
    globalDb(), globalAppsLocations, {}, { projection: { _id: 0 } },
  );
}

async function listLocationsByApp(appName) {
  return dbHelper.findInDatabase(
    globalDb(), globalAppsLocations,
    { name: nameRegex(appName) }, locationProjection,
  );
}

async function listLocationsByIp(ipPrefix) {
  return dbHelper.findInDatabase(
    globalDb(), globalAppsLocations,
    { ip: new RegExp(`^${ipPrefix}`) }, locationProjection,
  );
}

async function listAppNamesOnIp(ip) {
  return dbHelper.findInDatabase(
    globalDb(), globalAppsLocations,
    { ip }, { projection: { _id: 0, name: 1 } },
  );
}

async function upsertLocation(record) {
  return dbHelper.updateOneInDatabase(
    globalDb(), globalAppsLocations,
    { name: record.name, ip: record.ip },
    { $set: record }, { upsert: true },
  );
}

async function removeLocation(appName, ip) {
  return dbHelper.findOneAndDeleteInDatabase(
    globalDb(), globalAppsLocations, { ip, name: appName }, {},
  );
}

async function removeLocationsByIp(ip) {
  await dbHelper.removeDocumentsFromCollection(
    globalDb(), globalAppsLocations, { ip },
  );
  await dbHelper.removeDocumentsFromCollection(
    globalDb(), globalAppsInstallingLocations, { ip },
  );
}

async function removeInstallingLocation(appName, ip) {
  return dbHelper.removeDocumentsFromCollection(
    globalDb(), globalAppsInstallingLocations, { name: appName, ip },
  );
}

async function updateLocationIp(oldIp, newIp, broadcastedAt) {
  return dbHelper.updateInDatabase(
    globalDb(), globalAppsLocations,
    { ip: oldIp },
    { $set: { ip: newIp, broadcastedAt: new Date(broadcastedAt) } },
  );
}

async function updateLocationExpiry(ip, broadcastedAt, expireAt) {
  return dbHelper.updateInDatabase(
    globalDb(), globalAppsLocations,
    { ip },
    { $set: { broadcastedAt, expireAt } },
  );
}

// ── Name Conflict Check ────────────────────────────────────────────

async function assertNoNameConflicts(appName, options = {}) {
  const { hash = null } = options;

  const existingApp = await getGlobalAppInfo(appName);
  if (existingApp) {
    if (hash) {
      const result = await dbHelper.findOneInDatabase(
        chainDb(), appsHashesCollection,
        { hash },
        { projection: { _id: 0, txid: 1, hash: 1, height: 1 } },
      );
      if (!result) {
        throw new Error(`Flux App ${appName} already registered. Flux App has to be registered under different name. Hash not found in collection.`);
      }
      if (existingApp.height <= result.height) {
        if (existingApp.expiresAtHeight >= result.height) {
          throw new Error(`Flux App ${appName} already registered. Flux App has to be registered under different name. Hash is not older than our current app.`);
        } else {
          log.warn(`Flux App ${appName} active specifications are outdated. Will be cleaned on next expiration`);
        }
      }
    } else {
      throw new Error(`Flux App ${appName} already registered. Flux App has to be registered under different name.`);
    }
  }

  const appExists = (await existsGlobalApp(appName)) || (await existsInstalledApp(appName));
  if (appExists) {
    throw new Error(`Flux App ${appName} already assigned to local application. Flux App has to be registered under different name.`);
  }
  if (appName.toLowerCase() === 'share') {
    throw new Error(`Flux App ${appName} already assigned to Flux main application. Flux App has to be registered under different name.`);
  }
  return true;
}

// ── V7 Secrets Queries ─────────────────────────────────────────────

async function listLiveV7Secrets() {
  const apps = await listGlobalAppInfo({
    filter: { version: 7, nodes: { $exists: true, $ne: [] } },
  });
  const results = [];
  for (const inst of apps) {
    for (const { componentName, secrets } of inst.spec.getComponentSecrets()) {
      results.push({
        appName: inst.name,
        owner: inst.owner,
        componentName,
        secrets,
      });
    }
  }
  return results;
}

async function listHistoricalV7Secrets() {
  await getSpec();
  const { deserializeSpec } = await getSpecBackend();
  const docs = await dbHelper.findInDatabase(
    globalDb(), globalAppsMessages,
    {
      'appSpecifications.version': 7,
      'appSpecifications.nodes': { $exists: true, $ne: [] },
    },
    { projection: { _id: 0, appSpecifications: 1 } },
  );
  const results = [];
  for (const doc of docs) {
    const specBlob = doc.appSpecifications;
    if (!specBlob) continue;
    let spec;
    try {
      spec = deserializeSpec(specBlob);
    } catch (err) {
      log.warn(`listHistoricalV7Secrets: ${err.message} (name=${specBlob.name})`);
      continue;
    }
    for (const { componentName, secrets } of spec.getComponentSecrets()) {
      results.push({ owner: spec.owner, componentName, secrets });
    }
  }
  return results;
}

module.exports = {
  hydrate,
  storageProvider,
  // spawner
  findUnderProvisionedApps,
  // global specs
  getGlobalAppInfo,
  getGlobalAppOwner,
  getGlobalAppHeight,
  existsGlobalApp,
  listExistingGlobalAppNames,
  listGlobalAppInfo,
  getContentManifest,
  setContentManifestApplied,
  upsertContentManifest,
  deleteQuarantinedContentManifest,
  listConfirmedContentManifestVersions,
  listContentManifestVersions,
  listConfirmedContentManifestBroadcasts,
  reapOrphanedContentManifests,
  listGlobalAppNodes,
  upsertGlobalAppInfo,
  removeGlobalAppInfo,
  removeAppInstallingErrorRecords,
  // installed apps
  getInstalledApp,
  countInstalledApps,
  existsInstalledApp,
  listInstalledApps,
  removeInstalledApp,
  insertInstalledApp,
  upsertInstalledApp,
  // messages
  getAppMessage,
  getPermanentMessage,
  getTempMessage,
  getTempMessageByName,
  storePermanentMessage,
  listAppMessagesByName,
  getPreviousOwner,
  getPreviousPermanentMessage,
  // upsert + errors
  upsertIfNewer,
  clearInstallingErrors,
  // locations
  getAppLocation,
  isAppRunningOnIp,
  listLocations,
  listLocationsByApp,
  listLocationsByIp,
  listAppNamesOnIp,
  upsertLocation,
  removeLocation,
  removeLocationsByIp,
  removeInstallingLocation,
  updateLocationIp,
  updateLocationExpiry,
  // conflict checks
  assertNoNameConflicts,
  // secrets
  listLiveV7Secrets,
  listHistoricalV7Secrets,
};
