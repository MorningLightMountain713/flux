const config = require('config');
const log = require('../../lib/log');
const dbHelper = require('../dbHelper');
const { getSpec, getSpecBackend } = require('../utils/specLibs');
const fluxEventBus = require('../utils/fluxEventBus');
const setReconciler = require('../appMessaging/setReconciler');
const MongoStorageProvider = require('../providers/MongoStorageProvider');
const { expireHeightExpr } = require('./appsMaintenance');
const { mintAppUuid } = require('../utils/appIdentity');
const {
  globalAppsInformation,
  localAppsInformation,
  globalAppsMessages,
  globalAppsTempMessages,
  globalAppsInstallingErrorsLocations,
  globalAppsInstallingErrorsBroadcasts,
  globalAppsInstallingLocations,
  globalAppsIngressAttestations,
  globalAppsIngressAttestationDigests,
  globalAppStateEvents,
  appsHashesCollection,
  SIGTERM_EXPIRY_MS,
  RUNNING_EXPIRY_MS,
} = require('../utils/appConstants');

// One-row-per-app content-slot manifest register (latest-wins). Not in appConstants
// because only the content-manifest plane touches it.
const { appContentManifests } = config.database.appsglobal.collections;

let storageProviderInstance;

async function storageProvider() {
  if (!storageProviderInstance) {
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

  // `replica` is this collection's own key field and `componentIdentifiers` is
  // this collection's own index, neither part of the spec's wire form. The
  // encrypted deserializers reject unknown fields outright, so storage fields
  // are stripped here rather than leaking into the spec layer.
  // eslint-disable-next-line no-unused-vars
  const { replica, componentIdentifiers, ...specDoc } = doc;

  try {
    return InstantiatedSpec.deserialize(specDoc);
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
    { $sort: { name: 1 } },
  ];

  const database = globalDb();
  // The instance count comes from the event log, not from a join against the
  // materialized locations collection. That collection only gained and updated rows,
  // so an app a node quietly stopped kept counting toward its target for up to the
  // running TTL and the spawner would not replace it — measured live on three apps.
  const [alive, runningByApp] = await Promise.all([
    dbHelper.aggregateInDatabase(database, globalAppsInformation, pipeline),
    countRunningByApp(),
  ]);

  const candidates = [];
  for (const doc of alive) {
    const actual = runningByApp.get(String(doc.name).toLowerCase()) || 0;
    const required = doc.instances ?? 3;
    if (actual >= required) continue;
    // hydrate only the shortfall: the doc must reach hydrate byte-identical to
    // storage (encrypted specs bind their cleartext metadata into the AAD, and
    // deserialize rejects foreign fields), so nothing above may decorate it.
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
  // `uuid` and `identity` are minted ONCE, from the transaction that carried the
  // registration. Every later write here is a REPLACE, and an update arrives in a
  // different transaction carrying neither — so without this it would clear both,
  // and the app's next deployment would be named from something other than what
  // its containers, volume and syncthing folder already carry.
  const existing = await dbHelper.findOneInDatabase(
    globalDb(), globalAppsInformation,
    { name: specDoc.name },
    { projection: { _id: 0, uuid: 1, identity: 1 } },
  );
  const doc = { ...specDoc };
  if (doc.uuid == null && existing?.uuid != null) doc.uuid = existing.uuid;
  if (doc.identity == null && existing?.identity != null) doc.identity = existing.identity;
  return dbHelper.replaceOneInDatabase(
    globalDb(), globalAppsInformation,
    { name: specDoc.name }, doc, { upsert },
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
//
// A row is one DEPLOYED IDENTITY: keyed `(name, replica)`, with `replica: null`
// for loose placement. A co-located pair therefore holds two rows for one app.
// `replica` rides as a sidecar beside the serialized spec — the spec
// deserializer ignores it and never re-emits it, so the canonical spec form is
// untouched.
//
// The functions below come in two flavours, and callers must pick deliberately:
//   - APP-level (`...InstalledApp(s)`) answer "this app, on this node" and
//     aggregate over identities. Most readers want these.
//   - IDENTITY-level (`...InstalledIdentity/Identities`) answer "this replica,
//     on this node" — the question a spawner asks before provisioning and a
//     reconciler asks before actuating. Nothing may start a replica that has
//     no row here.
//
// A query for `{ replica: null }` also matches rows written before the field
// existed, so legacy loose installs read back unchanged.

const replicaKey = (replica) => (replica == null ? null : replica);

/**
 * Index prep, owned by this module rather than the boot block: the rows are
 * this module's. Unique on `(name, replica)` — before it, one-row-per-app was
 * enforced only by a racy exists-then-insert, so a concurrent install could
 * duplicate a row silently. Note name matching at the query layer stays
 * case-insensitive (nameRegex), which a plain index cannot express; the
 * constraint here is exact-case, which is strictly more than existed before.
 */
async function prepareInstalledAppsCollection() {
  const collection = localDb().collection(localAppsInformation);
  // Rows written before the identity field carry no `replica`. Every one of
  // them is a loose install — named placement arrives with v9, which is
  // unreleased — so they backfill to null, which is exactly what a loose row
  // stores. Runs before the unique index so the index is built over a complete
  // key.
  await collection.updateMany({ replica: { $exists: false } }, { $set: { replica: null } });
  // Every row states the app identity its containers, volumes and syncthing
  // folder are named from. Rows predating the field state it as their own name,
  // which is the segment those artifacts already carry — so this pass is a
  // no-op on disk and the value can then be READ everywhere instead of being
  // recomputed from a name that a later owner of that name could change under
  // it. Idempotent by construction: only rows without the field are touched.
  await collection.updateMany({ identity: { $exists: false } }, [{ $set: { identity: '$name' } }]);
  await dbHelper.ensureIndex(collection, { name: 1, replica: 1 }, { unique: true, name: 'installed app identity' });
  await dbHelper.ensureIndex(collection, { name: 1 }, { name: 'installed apps by name' });
  // NOT unique: a co-located app holds one row per replica, all sharing the
  // app's single identity.
  await dbHelper.ensureIndex(collection, { identity: 1 }, { name: 'installed apps by app identity' });
  // The container identifiers each row's components are named by. Sparse in
  // effect: rows written before the field carry none and simply do not answer,
  // which costs their caller a fallback rather than a wrong answer. Cannot be
  // backfilled here — an identifier is built from a RESOLVED deployment, which
  // can need decryption, so it is not something an update pipeline can compute.
  await dbHelper.ensureIndex(collection, { componentIdentifiers: 1 }, { name: 'installed apps by component identifier' });
}

/**
 * Give every global app row the instance identity it was always entitled to.
 *
 * An app registered before identities existed has one available retroactively:
 * its uuid is a pure function of its name and the txid of the transaction that
 * registered it, both of which are on chain and unchanged. So this is a read of
 * history, not an assignment — every node computes the same values from the same
 * messages, and a node that runs this twice gets the same answer.
 *
 * It deliberately does NOT set `identity`. The uuid records WHICH app this is;
 * `identity` decides what its containers, volume directory and syncthing folder
 * are NAMED. Those artifacts already exist under the app's name, and writing a
 * uuid-derived identity onto an existing row would rename them out from under a
 * running app. Only a registration arriving from here on states one.
 *
 * Idempotent by construction rather than by a marker: it only ever looks at rows
 * that have no uuid, so an interrupted pass simply resumes.
 */
async function backfillGlobalAppUuids() {
  const rows = await dbHelper.findInDatabase(
    globalDb(), globalAppsInformation,
    { uuid: { $exists: false } },
    { projection: { _id: 0, name: 1 } },
  );
  if (rows.length === 0) return { backfilled: 0, unresolved: 0 };

  let backfilled = 0;
  let unresolved = 0;
  for (const row of rows) {
    // The FIRST registration of this name. A name can have been held by several
    // apps over time, and it is the one that minted the CURRENT holder we want -
    // so this takes the most recent registration, not the oldest message.
    // eslint-disable-next-line no-await-in-loop
    const registration = await dbHelper.findOneInDatabase(
      globalDb(), globalAppsMessages,
      { 'appSpecifications.name': nameRegex(row.name), type: { $in: ['fluxappregister', 'zelappregister'] } },
      { projection: { _id: 0, txid: 1, height: 1 }, sort: { height: -1 } },
    );
    if (!registration || !registration.txid) {
      // Its registration message was never obtained by this node. Nothing to
      // derive from, and inventing one would give this node a different answer
      // from every other - leave it, and a later pass picks it up if the message
      // arrives.
      unresolved += 1;
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await dbHelper.updateOneInDatabase(
      globalDb(), globalAppsInformation,
      { name: row.name },
      { $set: { uuid: mintAppUuid(row.name, registration.txid) } },
      {},
    );
    backfilled += 1;
  }
  if (unresolved > 0) {
    log.warn(`appsRepository - ${unresolved} app(s) have no registration message here, so no instance identity could be derived for them yet`);
  }
  log.info(`appsRepository - instance identity derived for ${backfilled} app(s)`);
  return { backfilled, unresolved };
}

async function getInstalledApp(name) {
  const doc = await dbHelper.findOneInDatabase(
    localDb(), localAppsInformation,
    { name: nameRegex(name) },
    { projection: { _id: 0 } },
  );
  return hydrate(doc);
}

/**
 * The installed app a container identifier belongs to, found by the APP-identity
 * segment that identifier is built from.
 *
 * This is the inverse every runtime lookup wants and no string rule can supply.
 * Splitting `component_identity[_replica]` recovers the identity SEGMENT
 * reliably — every segment forbids `_` — but a segment is not a name, and once
 * identities stop being minted from names it stops resembling one. Only the row
 * that stated the identity can say which app holds it.
 *
 * Exact match, not `nameRegex`: an identity is machine-minted and is compared
 * against the same stored string the containers were named from, so case can
 * neither drift nor be typed in by a user here.
 *
 * @param {string} identity
 * @returns {Promise<object|null>} InstantiatedSpec, or null when nothing here
 *   claims that identity
 */
/**
 * The installed app one of this node's containers belongs to, found by the
 * identifier the container is named by rather than by taking that name apart.
 *
 * Answers only for rows that recorded their components. A caller that gets null
 * has not learnt the container is unknown — only that this index cannot answer.
 */
async function getInstalledAppByComponentIdentifier(identifier) {
  if (!identifier) return null;
  const doc = await dbHelper.findOneInDatabase(
    localDb(), localAppsInformation,
    { componentIdentifiers: identifier },
    { projection: { _id: 0 } },
  );
  return hydrate(doc);
}

async function getInstalledAppByIdentity(identity) {
  if (!identity) return null;
  const doc = await dbHelper.findOneInDatabase(
    localDb(), localAppsInformation,
    { identity },
    { projection: { _id: 0 } },
  );
  return hydrate(doc);
}

/**
 * Owner and hash of an installed app, read WITHOUT hydrating the spec.
 * Deliberately not getInstalledApp: hydration goes through the spec-backend
 * bridge, which only resolves once something else has warmed it. Callers here
 * (tampering attribution during the boot sweep) run ahead of that and need two
 * scalars, not a domain object — so this stays a plain projection.
 * @param {string} name
 * @returns {Promise<{owner: string|null, hash: string|null}|null>} null when not installed
 */
async function getInstalledAppAttribution(name) {
  const doc = await dbHelper.findOneInDatabase(
    localDb(), localAppsInformation,
    { name: nameRegex(name) },
    { projection: { _id: 0, owner: 1, hash: 1 } },
  );
  if (!doc) return null;
  return { owner: doc.owner ?? null, hash: doc.hash ?? null };
}

/**
 * One identity's installed row, or null. This is the provisioning question:
 * a null answer means this replica is NOT installed here, however many
 * siblings are.
 * @param {string} name
 * @param {string|null} replica
 */
async function getInstalledIdentity(name, replica) {
  const doc = await dbHelper.findOneInDatabase(
    localDb(), localAppsInformation,
    { name: nameRegex(name), replica: replicaKey(replica) },
    { projection: { _id: 0 } },
  );
  return hydrate(doc);
}

/**
 * Whether THIS identity is installed here.
 * @param {string} name
 * @param {string|null} replica
 */
async function existsInstalledIdentity(name, replica) {
  const doc = await dbHelper.findOneInDatabase(
    localDb(), localAppsInformation,
    { name: nameRegex(name), replica: replicaKey(replica) },
    { projection: { _id: 0, name: 1 } },
  );
  return !!doc;
}

/**
 * The replica names this node has installed for an app, `null` entries for
 * loose. The actual-state counterpart to the spec's assigned identities.
 * @param {string} name
 * @returns {Promise<Array<string|null>>}
 */
async function listInstalledIdentities(name) {
  const docs = await dbHelper.findInDatabase(
    localDb(), localAppsInformation,
    { name: nameRegex(name) },
    { projection: { _id: 0, replica: 1 } },
  );
  return docs.map((d) => d.replica ?? null);
}

/**
 * How many distinct APPS are installed here. Counts apps, not identities, so a
 * co-located pair is one app — this feeds capacity and usage reporting, whose
 * unit has always been the app.
 */
async function countInstalledApps() {
  const names = await localDb().collection(localAppsInformation).distinct('name', {});
  return names.length;
}

/** How many identities of an app are installed here. */
async function countInstalledIdentities(name) {
  return dbHelper.countInDatabase(
    localDb(), localAppsInformation, { name: nameRegex(name) },
  );
}

async function existsInstalledApp(name) {
  const doc = await dbHelper.findOneInDatabase(
    localDb(), localAppsInformation,
    { name: nameRegex(name) },
    { projection: { _id: 0, name: 1 } },
  );
  return !!doc;
}

/**
 * The apps installed here, ONE entry per app. Co-located identities share a
 * spec, so the extra rows would otherwise surface as duplicate apps to every
 * caller that means "the apps I host" — including presence broadcasts and the
 * capacity gate. Callers needing per-identity views go through the deployment
 * layer, which fans an app's spec out across its identities.
 */
async function listInstalledApps({ filter = {} } = {}) {
  const docs = await dbHelper.findInDatabase(
    localDb(), localAppsInformation, filter, { projection: { _id: 0 } },
  );
  const specs = [];
  const seen = new Set();
  for (const doc of docs) {
    const key = String(doc.name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // eslint-disable-next-line no-await-in-loop
    const spec = await hydrate(doc);
    if (spec) specs.push(spec);
  }
  return specs;
}

/**
 * The NAMES of the apps installed here, read WITHOUT hydrating the specs.
 * Deliberately not listInstalledApps: hydration goes through the spec-backend
 * bridge, so a caller running before that bridge is warm — the boot recovery
 * sweep — would silently lose every app whose spec did not resolve. One entry
 * per app, matching listInstalledApps.
 * @returns {Promise<Array<string>>}
 */
async function listInstalledAppNames() {
  const docs = await dbHelper.findInDatabase(
    localDb(), localAppsInformation, {}, { projection: { _id: 0, name: 1 } },
  );
  const names = [];
  const seen = new Set();
  for (const doc of docs) {
    const key = String(doc.name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(doc.name);
  }
  return names;
}

/**
 * Remove EVERY identity's row for an app — the whole app leaves this node.
 * A single replica's departure uses removeInstalledIdentity instead.
 */
async function removeInstalledApp(name) {
  return dbHelper.removeDocumentsFromCollection(
    localDb(), localAppsInformation, { name: nameRegex(name) },
  );
}

/**
 * Remove one identity's row, leaving co-located siblings installed.
 * @param {string} name
 * @param {string|null} replica
 */
async function removeInstalledIdentity(name, replica) {
  return dbHelper.findOneAndDeleteInDatabase(
    localDb(), localAppsInformation,
    { name: nameRegex(name), replica: replicaKey(replica) }, {},
  );
}

/**
 * Write one identity's row. The identity rides beside the serialized spec;
 * the spec deserializer ignores the field, so the stored spec form is
 * unchanged from a loose install's.
 * @param {string|null} replica
 */
async function insertInstalledApp(specDoc, replica = null, componentIdentifiers = null) {
  return dbHelper.insertOneToDatabase(
    localDb(), localAppsInformation,
    withComponentIdentifiers({ ...specDoc, replica: replicaKey(replica) }, componentIdentifiers),
  );
}

/**
 * The `(replica, identity)` pair of every row an app holds here. `identity` is
 * the APP-identity segment (the thing container names are built from), not this
 * collection's replica key — the two senses of the word meet in this module, so
 * they are named apart wherever both are in scope.
 */
async function listInstalledRowKeys(name) {
  const docs = await dbHelper.findInDatabase(
    localDb(), localAppsInformation,
    { name: nameRegex(name) },
    { projection: { _id: 0, replica: 1, identity: 1 } },
  );
  return docs.map((d) => ({ replica: d.replica ?? null, identity: d.identity ?? null }));
}

/**
 * An app's identity is minted once and never changes: every container name,
 * volume path and syncthing folder id on this node is built from it, and that
 * folder id is shared with every OTHER node running the app. The writes below
 * are replaces, so a spec update whose document does not state an identity
 * would clear it — and the next deployment build would fall back to deriving
 * one from the name, renaming a live app's containers and stranding its folder
 * from its peers. A stored identity therefore always beats an absent one.
 */
function withStoredIdentity(doc, stored) {
  if (doc.identity != null || stored == null) return doc;
  return { ...doc, identity: stored };
}

/**
 * The container identifiers this row's components are named by, recorded so that
 * "which app owns this container?" is a lookup rather than a decomposition of
 * the container's own name. A name states the segment its containers were built
 * from, which is only incidentally the app's name and stops resembling one once
 * identities are minted rather than borrowed.
 *
 * Deliberately NOT carried across a replace the way `identity` is. An identity
 * is minted once and never changes; a spec update can add, drop or rename
 * components, so a carried list goes stale. Written fresh or not at all: a row
 * without them costs a caller its fallback, a row with stale ones would hand a
 * container to the wrong app.
 */
function withComponentIdentifiers(doc, identifiers) {
  if (!Array.isArray(identifiers) || identifiers.length === 0) return doc;
  return { ...doc, componentIdentifiers: [...identifiers] };
}

/**
 * Refresh the stored spec for EVERY identity of an app, preserving each row's
 * replica — a spec update applies to every replica this node runs, and one
 * replica's update must not erase a sibling's row. Inserts a loose row when the
 * app is not installed at all.
 */
async function upsertInstalledApp(name, specDoc, identifiersFor = null) {
  if (!name) throw new Error('appsRepository.upsertInstalledApp: name required');
  if (!specDoc) throw new Error('appsRepository.upsertInstalledApp: specDoc required');
  const rows = await listInstalledRowKeys(name);
  if (rows.length === 0) {
    // eslint-disable-next-line no-return-await
    return insertInstalledApp(specDoc, null, identifiersFor ? await identifiersFor(null) : null);
  }
  const results = [];
  for (const row of rows) {
    // Per row, because each replica names its containers differently — one
    // list applied to every row would give a sibling's identifiers away.
    // eslint-disable-next-line no-await-in-loop
    const identifiers = identifiersFor ? await identifiersFor(row.replica) : null;
    // eslint-disable-next-line no-await-in-loop
    const result = await dbHelper.replaceOneInDatabase(
      localDb(), localAppsInformation,
      { name: nameRegex(name), replica: replicaKey(row.replica) },
      withComponentIdentifiers(
        withStoredIdentity({ ...specDoc, replica: replicaKey(row.replica) }, row.identity),
        identifiers,
      ),
      { upsert: true },
    );
    results.push(result);
  }
  return results[0];
}

/**
 * Write one identity's row, creating or replacing exactly that row.
 * @param {string} name
 * @param {string|null} replica
 */
async function upsertInstalledIdentity(name, replica, specDoc, componentIdentifiers = null) {
  if (!name) throw new Error('appsRepository.upsertInstalledIdentity: name required');
  if (!specDoc) throw new Error('appsRepository.upsertInstalledIdentity: specDoc required');
  const existing = await dbHelper.findOneInDatabase(
    localDb(), localAppsInformation,
    { name: nameRegex(name), replica: replicaKey(replica) },
    { projection: { _id: 0, identity: 1 } },
  );
  return dbHelper.replaceOneInDatabase(
    localDb(), localAppsInformation,
    { name: nameRegex(name), replica: replicaKey(replica) },
    withComponentIdentifiers(
      withStoredIdentity({ ...specDoc, replica: replicaKey(replica) }, existing?.identity ?? null),
      componentIdentifiers,
    ),
    { upsert: true },
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

// ── Ingress attestations ───────────────────────────────────────────
// One node-signed record per (hash, node): where a register/update entered the
// network. Keyed uniquely so records from different ingress nodes never collide.
// Unconfirmed records carry expireAt and self-reap; confirmation clears it.

// Reconcile keys on EVERY row this node holds, quarantined included — the same split the
// content-manifest plane uses: what you count is what you hold, what you serve is only what
// you have verified. Counting only confirmed rows would drop a quarantined record off this
// node's index while the peer that served it still lists it, so the two would never agree
// and the record would be re-fetched every round. Confirmation does not change a row's
// identity, so promoting one leaves the digest untouched.
// Identity = `${hash}|${node}`; each row carries its precomputed bucket so a bucket's
// members are an indexed lookup, not a scan.
const ingressIdentityOf = (row) => `${row.hash}|${row.node}`;
const INGRESS_DIGEST_DOC = 'ingress';

// The K bucket digests of the held set are MATERIALIZED in a single doc and kept in step
// incrementally: a store touches only its own bucket, and a reconcile reads the doc — both
// O(K), never a full scan. The only O(N) work is a one-time rebuild if the doc is missing
// (fresh node / first deploy). Digest writes are serialized so two stores in the same
// bucket can't race to a stale value; each recompute derives from the current DB state, so
// it is idempotent and self-correcting.
let ingressDigestChain = Promise.resolve();
function serializeIngressDigest(fn) {
  ingressDigestChain = ingressDigestChain.then(fn, fn);
  return ingressDigestChain;
}

/** Recompute one bucket's digest from its current members and store it. */
async function recomputeIngressBucket(bucket) {
  const members = await dbHelper.findInDatabase(
    globalDb(), globalAppsIngressAttestations,
    { bucket },
    { projection: { _id: 0, hash: 1, node: 1 } },
  );
  const digest = setReconciler.combineDigest(members, { identityOf: ingressIdentityOf });
  await dbHelper.updateOneInDatabase(
    globalDb(), globalAppsIngressAttestationDigests,
    { _id: INGRESS_DIGEST_DOC },
    digest === setReconciler.ZERO_DIGEST
      ? { $unset: { [`buckets.${bucket}`]: '' } }
      : { $set: { [`buckets.${bucket}`]: digest } },
    { upsert: true },
  );
}

/** Rebuild every bucket digest from scratch — the one-time O(N) path when the doc is absent. */
async function rebuildIngressDigests() {
  const rows = await dbHelper.findInDatabase(
    globalDb(), globalAppsIngressAttestations, {}, { projection: { _id: 0, hash: 1, node: 1 } },
  );
  const buckets = {};
  const byBucket = new Map();
  for (const row of rows) {
    const b = setReconciler.bucketOf(ingressIdentityOf(row));
    if (!byBucket.has(b)) byBucket.set(b, []);
    byBucket.get(b).push(row);
  }
  for (const [b, members] of byBucket) {
    buckets[b] = setReconciler.combineDigest(members, { identityOf: ingressIdentityOf });
  }
  await dbHelper.updateOneInDatabase(
    globalDb(), globalAppsIngressAttestationDigests,
    { _id: INGRESS_DIGEST_DOC }, { $set: { buckets } }, { upsert: true },
  );
}

/**
 * Insert an attestation, deduplicated by (hash, node). `inserted` distinguishes the first
 * store (flood onward) from a re-seen record (stop). Confirmed inserts update the
 * materialized digest for their bucket.
 *
 * The gossip flood re-delivers the same record to every node several times, so a
 * check-then-insert fast-paths the common re-seen case — otherwise every echo would hit
 * the unique index and log an E11000 at error level, spamming error.log with expected
 * behaviour. The unique index stays the backstop for the rare concurrent first-store race.
 * @returns {Promise<{ inserted: boolean }>}
 */
async function storeIngressAttestation(doc, expireAt = null) {
  const existing = await dbHelper.findOneInDatabase(
    globalDb(), globalAppsIngressAttestations, { hash: doc.hash, node: doc.node }, { projection: { _id: 1 } },
  );
  if (existing) return { inserted: false };

  const bucket = setReconciler.bucketOf(ingressIdentityOf(doc));
  const value = { ...doc, bucket };
  // A confirmed message's attestation carries no TTL and persists; an unconfirmed
  // one gets the orphan expireAt and self-reaps if the message never confirms.
  if (expireAt != null) value.expireAt = new Date(expireAt);
  const result = await dbHelper.insertOneToDatabase(globalDb(), globalAppsIngressAttestations, value);
  const inserted = Boolean(result && result.insertedId);
  // Every newly-stored attestation enters the reconcile digest, quarantined or not: the
  // digest states what this node holds, so a peer that served us a record sees us holding it.
  if (inserted) await serializeIngressDigest(() => recomputeIngressBucket(bucket));
  return { inserted };
}

/**
 * Clear the quarantine TTL on every attestation for a hash, so a confirmed
 * registration/update's attribution persists as long as its permanent message.
 *
 * No digest work: a row was already counted when it was stored, and promoting it changes
 * neither its `(hash, node)` identity nor its bucket.
 */
async function confirmIngressAttestations(hash) {
  await dbHelper.updateInDatabase(
    globalDb(), globalAppsIngressAttestations, { hash }, { $unset: { expireAt: '' } },
  );
}

/** All attestations recorded for a hash (fluxteam-only; storage bookkeeping stripped). */
async function listIngressAttestations(hash) {
  return dbHelper.findInDatabase(
    globalDb(), globalAppsIngressAttestations, { hash }, { projection: { _id: 0, expireAt: 0, bucket: 0 } },
  );
}

/**
 * The sync INDEX: the K materialized bucket digests of every attestation this node holds,
 * quarantined included. A fixed small read (one doc) — never a scan — except the one-time
 * rebuild when the doc is absent.
 * @returns {Promise<string[]>}
 */
async function listIngressAttestationDigests() {
  let doc = await dbHelper.findOneInDatabase(
    globalDb(), globalAppsIngressAttestationDigests, { _id: INGRESS_DIGEST_DOC }, {},
  );
  if (!doc) {
    await serializeIngressDigest(() => rebuildIngressDigests());
    doc = await dbHelper.findOneInDatabase(
      globalDb(), globalAppsIngressAttestationDigests, { _id: INGRESS_DIGEST_DOC }, {},
    );
  }
  const buckets = (doc && doc.buckets) || {};
  const digests = new Array(setReconciler.DEFAULT_BUCKETS);
  for (let b = 0; b < digests.length; b += 1) digests[b] = buckets[b] || setReconciler.ZERO_DIGEST;
  return digests;
}

/**
 * The sync FETCH: full attestation records in the requested buckets (indexed), CONFIRMED
 * only. We count what we hold but serve only what we have verified, so a quarantined record
 * is never relayed onward as though it were established.
 */
async function listIngressAttestationsForBuckets(bucketIds) {
  return dbHelper.findInDatabase(
    globalDb(), globalAppsIngressAttestations,
    { bucket: { $in: bucketIds }, expireAt: { $exists: false } },
    { projection: { _id: 0, expireAt: 0, bucket: 0 } },
  );
}

async function listAppMessagesByName(name) {
  const projection = { projection: { _id: 0 } };
  return dbHelper.findInDatabase(
    globalDb(), globalAppsMessages, { 'appSpecifications.name': name }, projection,
  );
}

/**
 * All ingress attestations for an app, grouped by the register/update message
 * they attest to. Composes the app's message history (name -> hashes) with the
 * per-hash attestation lookup. Records stay sealed — decryption is fluxteam's,
 * offline. Messages with no attestation are omitted.
 */
async function listIngressAttestationsByApp(name) {
  const messages = await listAppMessagesByName(name);
  const groups = await Promise.all(messages.map(async (message) => ({
    hash: message.hash,
    type: message.type,
    timestamp: message.timestamp,
    attestations: await listIngressAttestations(message.hash),
  })));
  return groups.filter((group) => group.attestations.length > 0);
}

/**
 * The newest permanent message for a name, cut off at a timestamp.
 *
 * v1-v8 update pricing only. The cutoff is the message's own timestamp and the
 * message is already stored when this runs, so it selects that same message —
 * which is what makes a legacy update's fee its minPrice floor. That is the
 * network's settled behaviour and is reproduced deliberately; see the update
 * branch of checkAndRequestApp. Do not reach for this anywhere else.
 */
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

/**
 * The permanent message an app held immediately before a block height — the
 * state a message confirmed at that height supersedes.
 *
 * The cutoff is the height, which the chain fixes: it excludes the confirming
 * message itself however its timestamp is written, and a backdated message
 * cannot reach behind a later one.
 *
 * @param {string} name - App name
 * @param {number} height - Confirming height of the message being judged
 * @returns {Promise<object|null>}
 */
async function getPermanentMessageBeforeHeight(name, height) {
  return dbHelper.findOneInDatabase(
    globalDb(), globalAppsMessages,
    { 'appSpecifications.name': name, height: { $lt: height } },
    { projection: { _id: 0 }, sort: { height: -1, timestamp: -1 } },
  );
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

/**
 * Adopt a peer's installing-error location records wholesale, keyed by the
 * record's identity. This is boot catch-up from a peer with more uptime than
 * us, so its copy is taken as given — the newer-wins merge lives on the live
 * broadcast path, which is the only one carrying a broadcast timestamp to
 * compare.
 * @param {Array<object>} records
 */
async function upsertAppInstallingErrorLocations(records) {
  const operations = records.map((record) => ({
    updateOne: {
      filter: { name: record.name, hash: record.hash, ip: record.ip },
      update: { $set: record },
      upsert: true,
    },
  }));
  await dbHelper.bulkWriteInDatabase(
    globalDb(), globalAppsInstallingErrorsLocations, operations,
  );
}

// ── The Running Set, derived from the app state event log ──────────

/**
 * The running set derived from the event log, one row per running replica.
 *
 * A node's announcement is a COMPLETE list of what it runs, so the latest one is the
 * whole truth about that node and nothing older survives it. Scoping to one app is
 * therefore pushed into the initial $match — an announcement that does not name the
 * app has nothing to say about it, and skipping those is what makes a per-app read
 * cheap. Address moves are the one case that breaks the "one announcement per node"
 * rule, and they are resolved by appLocationFromEvents before this runs.
 *
 * @param {object} opts
 * @param {Date} opts.now
 * @param {string|null} opts.appname
 * @param {string|null} opts.ip
 * @param {Array<string>} opts.supersededIps addresses whose announcement the node has
 *   already replaced from a new address; excluded outright so they cannot yield a row.
 */
function buildAppLocationPipeline({
  now, appname = null, ip = null, host = null, supersededIps = [],
}) {
  const escapedName = appname ? appname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : null;
  const nameMatch = escapedName ? new RegExp(`^${escapedName}$`, 'i') : null;
  const removalNameFilter = nameMatch ? [{ $match: { 'data.appName': nameMatch } }] : [];

  const base = {
    $or: [
      { type: { $in: ['apprunning', 'appremoved'] }, expireAt: { $gt: now } },
      { type: { $in: ['sigterm', 'evicted'] } },
    ],
  };
  if (ip) base.ip = ip;
  // Every app on one machine, whatever apiport each node there runs on. Anchored on
  // the port separator and with the address escaped, so 1.2.3.4 cannot also select
  // 1.2.3.45 - the ports being checked belong to the host, not to a prefix of it.
  if (host) base.ip = new RegExp(`^${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(:|$)`);

  const clauses = [base];
  // Shutdown and removal events are always kept: they are the reason an announcement
  // gets overruled, and they never name the app in the announcement's own shape.
  if (nameMatch) {
    clauses.push({ $or: [{ 'data.apps.name': nameMatch }, { type: { $ne: 'apprunning' } }] });
  }
  if (supersededIps.length) {
    clauses.push({ $nor: [{ type: 'apprunning', ip: { $in: supersededIps } }] });
  }

  return [
    { $match: clauses.length === 1 ? base : { $and: clauses } },
    // Deliberately no global $sort: {ip, type, dedupKey} is unique and every running
    // announcement shares dedupKey 'v2', so a node has exactly one, and each facet
    // below either groups by node or sorts for itself.
    {
      $facet: {
        v2: [
          { $match: { type: 'apprunning', 'data.apps': { $exists: true } } },
          { $group: { _id: '$ip', doc: { $first: '$$ROOT' } } },
          { $replaceRoot: { newRoot: '$doc' } },
          // outpoint is row-level, not from data: data holds the exact bytes the
          // originator signed and is re-served verbatim on the sync path, so it is
          // never written to. The outpoint is resolved locally at ingest.
          { $project: { _id: 0, ip: '$data.ip', outpoint: 1, broadcastedAt: 1, apps: '$data.apps', osUptime: '$data.osUptime', staticIp: '$data.staticIp', runningSince: '$data.runningSince' } },
        ],
        // $max, not $first: these must not depend on an upstream sort that no longer exists.
        removals: [
          { $match: { type: 'appremoved' } },
          ...removalNameFilter,
          { $group: { _id: { ip: '$ip', name: '$data.appName' }, removedAt: { $max: '$broadcastedAt' } } },
        ],
        shutdowns: [
          { $match: { type: { $in: ['sigterm', 'evicted'] } } },
          { $addFields: { _eventAt: { $ifNull: ['$broadcastedAt', '$createdAt'] } } },
          { $sort: { _eventAt: -1 } },
          { $group: { _id: '$ip', eventAt: { $first: '$_eventAt' }, expireAt: { $first: '$expireAt' }, type: { $first: '$type' } } },
        ],
      },
    },
    {
      $addFields: {
        _v2Filtered: {
          $filter: {
            input: '$v2',
            as: 'entry',
            cond: {
              $let: {
                vars: { sd: { $first: { $filter: { input: '$shutdowns', as: 's', cond: { $eq: ['$$s._id', '$$entry.ip'] } } } } },
                in: {
                  $or: [
                    { $eq: ['$$sd', null] },
                    { $gte: ['$$entry.broadcastedAt', '$$sd.eventAt'] },
                    { $and: [{ $eq: ['$$sd.type', 'sigterm'] }, { $gt: [{ $add: ['$$sd.eventAt', SIGTERM_EXPIRY_MS] }, now] }] },
                  ],
                },
              },
            },
          },
        },
      },
    },
    { $unwind: '$_v2Filtered' },
    { $unwind: '$_v2Filtered.apps' },
    ...(nameMatch ? [{ $match: { '_v2Filtered.apps.name': nameMatch } }] : []),
    // An app the node has since reported removed is gone even though its announcement
    // still names it. Compared against the unwound fields so this stays a shared rule
    // rather than something each tail has to re-apply after projecting.
    { $addFields: { _removedAt: { $ifNull: [{ $let: { vars: { r: { $first: { $filter: { input: '$removals', as: 'r', cond: { $and: [{ $eq: ['$$r._id.ip', '$_v2Filtered.ip'] }, { $eq: ['$$r._id.name', '$_v2Filtered.apps.name'] }] } } } } }, in: '$$r.removedAt' } }, new Date(0)] } } },
    { $match: { $expr: { $gt: ['$_v2Filtered.broadcastedAt', '$_removedAt'] } } },
  ];
}

// One row per running replica: the full location payload every reader of the running
// set expects. Appended to the shared stages by appLocationFromEvents.
const RUNNING_ROW_TAIL = [
  {
    $project: {
      _id: 0,
      name: '$_v2Filtered.apps.name',
      hash: '$_v2Filtered.apps.hash',
      ip: '$_v2Filtered.ip',
      // Null rather than absent on announcements that predate the field, so readers
      // get one shape and can tell "not claimed" from "not projected".
      outpoint: { $ifNull: ['$_v2Filtered.outpoint', null] },
      broadcastedAt: '$_v2Filtered.broadcastedAt',
      runningSince: { $ifNull: ['$_v2Filtered.apps.runningSince', '$_v2Filtered.runningSince'] },
      osUptime: '$_v2Filtered.osUptime',
      staticIp: '$_v2Filtered.staticIp',
      // LB lifecycle state + replica identity, per-replica off the v2 apps entry.
      // Normalized at ingest, so no reader has to branch on absence:
      // only explicit draining/stopping survive, everything else is active.
      state: { $cond: [{ $in: ['$_v2Filtered.apps.state', ['draining', 'stopping']] }, '$_v2Filtered.apps.state', 'active'] },
      replica: { $ifNull: ['$_v2Filtered.apps.replica', null] },
      shutdowns: 1,
    },
  },
  // When this row stops being believable. Derived rather than stored, but to the same
  // rule the materialized collection wrote it by: an announcement is good for the
  // running TTL, and a node that announced a clean shutdown only keeps its rows for
  // the sigterm grace. Callers read this field off /apps/locations, so it has to mean
  // what it has always meant.
  {
    $addFields: {
      expireAt: {
        $let: {
          vars: { sd: { $first: { $filter: { input: '$shutdowns', as: 's', cond: { $eq: ['$$s._id', '$ip'] } } } } },
          in: {
            $cond: [
              { $and: [{ $ne: ['$$sd', null] }, { $eq: ['$$sd.type', 'sigterm'] }, { $gt: ['$$sd.eventAt', '$broadcastedAt'] }] },
              { $add: ['$$sd.eventAt', SIGTERM_EXPIRY_MS] },
              { $add: ['$broadcastedAt', RUNNING_EXPIRY_MS] },
            ],
          },
        },
      },
    },
  },
  // No trailing $group: a node announces each replica once, so nothing remains to
  // deduplicate, and grouping on {name, ip} would merge co-located replicas and
  // discard the per-replica state and identity above.
  { $project: { shutdowns: 0 } },
];

// How many replicas of each app are running network-wide. Same rules, none of the row
// payload — the wide projection and the expireAt lookup are what make the row tail
// cost roughly half again as much, and a count needs neither.
const RUNNING_COUNT_TAIL = [
  { $group: { _id: '$_v2Filtered.apps.name', count: { $sum: 1 } } },
];

// Which addresses currently run anything. Same rules again, grouping on the address
// instead of the app - so an address that only ever appears on announcements the
// shared stages exclude (shut down, or every app since removed) is not reported as
// running something.
const RUNNING_ADDRESS_TAIL = [
  { $group: { _id: '$_v2Filtered.ip' } },
];

/**
 * Which pre-move announcements are dead, and which addresses still need translating.
 *
 * An address change is the only thing that can give one node two live announcements —
 * one at each address — and a per-app read cannot see that on its own, because the
 * announcement that retires an app is precisely the one that stops naming it. So the
 * decision is made here, over the handful of moved nodes, rather than in the query:
 * a pre-move announcement the node has already replaced is dropped before the query
 * runs, and one it has not replaced yet is kept and re-addressed afterwards.
 *
 * Deliberately not done inside the pipeline. Matching an address against the move set
 * there means a linear scan of that set for every event ‒ O(events x moves), which
 * measured 1.4s at 3455 moves against 62ms at none. A keyed lookup would need
 * $getField with a computed field name, which requires MongoDB 7.2+ (SERVER-74371);
 * this codebase targets 7.0. Revisit once the floor moves: the whole
 * supersede/translate step could then collapse into the v2 facet's existing $group.
 */
async function resolveAddressMoves(collection, now) {
  const moves = await collection.find(
    { type: 'ipchanged', expireAt: { $gt: now } },
    { projection: { _id: 0, ip: 1, broadcastedAt: 1, 'data.newIP': 1 } },
  ).toArray();
  if (moves.length === 0) return { supersededIps: [], translate: new Map() };

  const involved = [...new Set(moves.flatMap((m) => [m.ip, m.data.newIP]))];
  const stamps = await collection.aggregate([
    { $match: { type: 'apprunning', ip: { $in: involved }, expireAt: { $gt: now } } },
    { $group: { _id: '$ip', latest: { $max: '$broadcastedAt' } } },
  ]).toArray();
  const latestAt = new Map(stamps.map((s) => [s._id, s.latest.getTime()]));

  const supersededIps = [];
  const translate = new Map();
  for (const move of moves) {
    const from = move.ip;
    const to = move.data.newIP;
    const announcedFrom = latestAt.get(from);
    // a move only speaks for announcements older than itself
    if (announcedFrom === undefined || announcedFrom >= move.broadcastedAt.getTime()) continue;
    const announcedTo = latestAt.get(to);
    if (announcedTo !== undefined && announcedTo > announcedFrom) supersededIps.push(from);
    else translate.set(from, to);
  }
  return { supersededIps, translate };
}

async function appLocationFromEvents(options = {}) {
  const { appname = null, ip = null, host = null } = options;
  const dbopen = dbHelper.databaseConnection();
  const database = dbopen.db(config.database.appsglobal.database);
  const collection = database.collection(globalAppStateEvents);
  const now = new Date();

  const { supersededIps, translate } = await resolveAddressMoves(collection, now);
  const rows = await collection.aggregate([
    ...buildAppLocationPipeline({
      now, appname, ip, host, supersededIps,
    }),
    ...RUNNING_ROW_TAIL,
  ]).toArray();

  if (translate.size === 0) return rows;
  return rows.map((row) => (translate.has(row.ip) ? { ...row, ip: translate.get(row.ip) } : row));
}

/**
 * How many replicas of each app are running network-wide, keyed by lowercased name.
 *
 * The same derivation as appLocationFromEvents — one shared set of rules, so the two
 * can never disagree about what counts as running — stopping before the row payload
 * it does not need. A replica announced as draining or stopping still counts: it IS
 * running, and the spawner should not replace a node that has merely said it is going
 * away. Address moves need only the supersede exclusion here, not the re-addressing:
 * moving a row to a different address does not change how many there are.
 *
 * @returns {Promise<Map<string, number>>}
 */
async function countRunningByApp() {
  const dbopen = dbHelper.databaseConnection();
  const database = dbopen.db(config.database.appsglobal.database);
  const collection = database.collection(globalAppStateEvents);
  const now = new Date();

  const { supersededIps } = await resolveAddressMoves(collection, now);
  const counts = await collection.aggregate([
    ...buildAppLocationPipeline({ now, supersededIps }),
    ...RUNNING_COUNT_TAIL,
  ]).toArray();
  return new Map(counts.map((row) => [String(row._id).toLowerCase(), row.count]));
}

/**
 * Every address the network currently believes is running at least one app.
 *
 * The same derivation as appLocationFromEvents and countRunningByApp, so the three
 * cannot disagree about what counts as running. Address moves need the full
 * treatment here, not just the supersede exclusion the count uses: the caller acts
 * ON the address (it probes it, and evicts what does not answer), so a node that
 * has moved must be reported at the address it moved TO.
 *
 * @returns {Promise<Array<string>>} socket addresses, deduplicated
 */
async function listRunningAddresses() {
  const dbopen = dbHelper.databaseConnection();
  const database = dbopen.db(config.database.appsglobal.database);
  const collection = database.collection(globalAppStateEvents);
  const now = new Date();

  const { supersededIps, translate } = await resolveAddressMoves(collection, now);
  const rows = await collection.aggregate([
    ...buildAppLocationPipeline({ now, supersededIps }),
    ...RUNNING_ADDRESS_TAIL,
  ]).toArray();

  if (translate.size === 0) return rows.map((row) => row._id);
  // Translating can collapse two rows onto one address, so dedupe after mapping.
  return [...new Set(rows.map((row) => translate.get(row._id) ?? row._id))];
}

// ── Installing Locations ───────────────────────────────────────────

async function removeInstallingLocation(appName, ip) {
  return dbHelper.removeDocumentsFromCollection(
    globalDb(), globalAppsInstallingLocations, { name: appName, ip },
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
  prepareInstalledAppsCollection,
  backfillGlobalAppUuids,
  getInstalledApp,
  getInstalledAppByIdentity,
  getInstalledAppByComponentIdentifier,
  getInstalledAppAttribution,
  countInstalledApps,
  existsInstalledApp,
  listInstalledApps,
  listInstalledAppNames,
  removeInstalledApp,
  insertInstalledApp,
  upsertInstalledApp,
  getInstalledIdentity,
  existsInstalledIdentity,
  listInstalledIdentities,
  countInstalledIdentities,
  removeInstalledIdentity,
  upsertInstalledIdentity,
  // messages
  getAppMessage,
  getPermanentMessage,
  getTempMessage,
  getTempMessageByName,
  storePermanentMessage,
  listAppMessagesByName,
  getPreviousPermanentMessage,
  getPermanentMessageBeforeHeight,
  // ingress attestations
  storeIngressAttestation,
  confirmIngressAttestations,
  listIngressAttestations,
  listIngressAttestationsByApp,
  listIngressAttestationDigests,
  listIngressAttestationsForBuckets,
  // upsert + errors
  upsertIfNewer,
  clearInstallingErrors,
  upsertAppInstallingErrorLocations,
  // the running set, derived from the app state event log
  appLocationFromEvents,
  countRunningByApp,
  listRunningAddresses,
  removeInstallingLocation,
  // conflict checks
  assertNoNameConflicts,
  // secrets
  listLiveV7Secrets,
  listHistoricalV7Secrets,
};
