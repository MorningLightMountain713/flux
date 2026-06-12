const config = require('config');
const log = require('../../lib/log');
const dbHelper = require('../dbHelper');
const { getSpec, getSpecBackend } = require('../utils/specLibs');
const {
  globalAppsInformation,
  localAppsInformation,
  globalAppsMessages,
  globalAppsTempMessages,
  globalAppsInstallingErrorsLocations,
  globalAppsInstallingLocations,
  globalAppsLocations,
  appsHashesCollection,
} = require('../utils/appConstants');

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
  const ponFork = config.fluxapps.daemonPONFork;
  const blocksLasting = config.fluxapps.blocksLasting;
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

async function upsertGlobalAppInfo(specDoc) {
  if (!specDoc || !specDoc.name) {
    throw new Error('appsRepository.upsertGlobalAppInfo: specDoc.name required');
  }
  return dbHelper.replaceOneInDatabase(
    globalDb(), globalAppsInformation,
    { name: specDoc.name }, specDoc, { upsert: true },
  );
}

async function removeGlobalAppInfo(name) {
  return dbHelper.removeDocumentsFromCollection(
    globalDb(), globalAppsInformation, { name: nameRegex(name) },
  );
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
  const specBlob = doc.appSpecifications || doc.zelAppSpecifications;
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
  const results1 = await dbHelper.findInDatabase(
    globalDb(), globalAppsMessages, { 'appSpecifications.name': name }, projection,
  );
  const results2 = await dbHelper.findInDatabase(
    globalDb(), globalAppsMessages, { 'zelAppSpecifications.name': name }, projection,
  );
  return [...results1, ...results2];
}

async function getPreviousPermanentMessage(name, beforeTimestamp) {
  const projection = { projection: { _id: 0 } };
  const queries = [
    { 'appSpecifications.name': name },
    { 'zelAppSpecifications.name': name },
  ];
  let latest = null;
  for (const query of queries) {
    // eslint-disable-next-line no-await-in-loop
    const docs = await dbHelper.findInDatabase(globalDb(), globalAppsMessages, query, projection);
    for (const doc of docs) {
      if (doc.timestamp > beforeTimestamp) continue;
      if (!latest || doc.height > latest.height
        || (doc.height === latest.height && doc.timestamp > latest.timestamp)) {
        latest = doc;
      }
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
    _id: 0, name: 1, hash: 1, ip: 1,
    broadcastedAt: 1, expireAt: 1, runningSince: 1,
    osUptime: 1, staticIp: 1, state: 1,
  },
};

async function getAppLocation(appName, ip) {
  return dbHelper.findOneInDatabase(
    globalDb(), globalAppsLocations, { name: appName, ip }, locationProjection,
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
  listGlobalAppInfo,
  listGlobalAppNodes,
  upsertGlobalAppInfo,
  removeGlobalAppInfo,
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
