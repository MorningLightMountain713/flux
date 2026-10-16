'use strict';

const config = require('config');
const log = require('../../lib/log');
const dbHelper = require('../dbHelper');
const { getSpec, getSpecBackend } = require('../utils/specLibs');
const setReconciler = require('../appMessaging/setReconciler');
const appRecords = require('./appRecords');
const {
  globalAppsInstallingErrorsLocations,
  globalAppsInstallingErrorsBroadcasts,
  globalAppsInstallingLocations,
  globalAppsIngressAttestations,
  globalAppsIngressAttestationDigests,
  globalAppStateEvents,
  RUNNING_EXPIRY_MS,
  NODE_DOWN_GRACE_MS,
} = require('../utils/appConstants');
const { departures } = require('./offListDepartures');
const { nodeChain } = require('../utils/nodeChain');

// The content manifests a node holds, one row per manifest. Not in appConstants
// because only the content-manifest plane touches it.

async function hydrate(doc) {
  if (!doc) return null;

  await getSpec();
  const { InstantiatedSpec } = await getSpecBackend();

  try {
    return InstantiatedSpec.deserialize(doc, { chain: nodeChain() });
  } catch (err) {
    log.warn(`appsRepository.hydrate: ${err.message} (name=${doc.name}, version=${doc.version})`);
    return null;
  }
}

function globalDb() {
  return dbHelper.databaseConnection().db(config.get('database.appsglobal.database'));
}

/**
 * The owner of an app by name: the registry record's, else that of an app this
 * node has installed under the name (case-insensitive). Null when neither holds it.
 * @param {string} name
 * @returns {Promise<string|null>}
 */
async function getApplicationOwner(name) {
  const listed = await appRecords.registry().byName(name);
  if (listed) return listed.owner;
  const installed = await appRecords.installed().byName(name);
  return installed ? installed.owner : null;
}

/**
 * The owner of the app an identity names: the registry record's, else that of
 * the app this node has installed with the identity. Null when neither holds
 * it. The identity is the one a container carries as a label, so it is fixed
 * for the app's life, and the owner read here is the app's owner now.
 *
 * An app with no identity minted carries its name where an identity goes, and
 * a name is never in an identity's form: such a value is read as the name.
 * @param {string} identity
 * @returns {Promise<string|null>}
 */
async function getApplicationOwnerByIdentity(identity) {
  const listed = await appRecords.registry().byIdentity(identity);
  if (listed) return listed.owner;
  const installed = await appRecords.installed().byIdentity(identity);
  if (installed) return installed.owner;
  const { isAppIdentity } = await getSpecBackend();
  return isAppIdentity(identity) ? null : getApplicationOwner(identity);
}

/**
 * Deletes the install-error records nodes reported for a name: every one, or
 * with `keepHash` only those about the name's other specs, which leaves the
 * reports about the spec that hash names. Both the location rows and the
 * archived broadcasts: leaving the broadcasts would let message sync
 * redistribute error records for an app that no longer exists in the registry.
 * @param {string} name
 * @param {{keepHash?: ?string}} [options]
 */
async function removeAppInstallingErrorRecords(name, { keepHash = null } = {}) {
  await dbHelper.removeDocumentsFromCollection(
    globalDb(), globalAppsInstallingErrorsLocations, { name, ...(keepHash && { hash: { $ne: keepHash } }) },
  );
  await dbHelper.removeDocumentsFromCollection(
    globalDb(), globalAppsInstallingErrorsBroadcasts, { 'data.name': name, ...(keepHash && { 'data.hash': { $ne: keepHash } }) },
  );
}

// ── Permanent / Temporary Messages ─────────────────────────────────

/**
 * A confirmed message by hash, with the spec it carries hydrated, or null.
 * @param {string} hash
 * @returns {Promise<?{message: object, spec: object|null}>} the message in its permanent form
 */
async function getAppMessage(hash) {
  const doc = await getPermanentMessage(hash);
  if (!doc) return null;
  const specBlob = doc.appSpecifications;
  if (!specBlob) return { message: doc, spec: null };
  const docForHydrate = { ...specBlob, hash: doc.hash, height: doc.height };
  const spec = await hydrate(docForHydrate);
  return { message: doc, spec };
}

/**
 * A confirmed message by hash in its permanent form, or null.
 * @param {string} hash
 * @returns {Promise<object|null>}
 */
async function getPermanentMessage(hash) {
  const record = await appRecords.messages().byHash(hash);
  return record && record.isConfirmed ? record.permanentForm() : null;
}

/**
 * The contents the pool holds for a hash, in their temporary form, or null.
 * @param {string} hash
 * @returns {Promise<object|null>}
 */
async function getTempMessage(hash) {
  const record = await appRecords.messages().byHash(hash);
  return record && record.isHeld && !record.isPaid ? record.temporaryForm() : null;
}

/**
 * The latest contents the pool holds under a name, in any letter case, or null.
 * @param {string} name
 * @returns {Promise<object|null>}
 */
async function getTempMessageByName(name) {
  const record = await appRecords.messages().signedByName(name);
  return record ? record.temporaryForm() : null;
}

/**
 * The ranks of the manifests held in the pool with an app's waiting updates: a
 * manifest a submission carries takes the number after the highest of these
 * within its ownership and the stored ones.
 * @param {string} identity
 * @returns {Promise<Array<{version: number, ownedFrom: number}>>}
 */
async function carriedManifestRanks(identity) {
  return appRecords.messages().carriedManifestRanks(identity);
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

/**
 * Every confirmed message under a name, in its permanent form.
 * @param {string} name
 * @returns {Promise<object[]>}
 */
async function listAppMessagesByName(name) {
  const records = await appRecords.messages().confirmedNamed([name]);
  return records.map((record) => record.permanentForm());
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

// ── Installing Errors ──────────────────────────────────────────────

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
 * @param {Array<string>} opts.excludeHashes specs that belong to another app than the
 *   one asked about (an earlier app registered under the same name); a node running
 *   one does not run this app.
 * @param {string|null} opts.ip
 * @param {Array<string>} opts.supersededIps addresses whose announcement the node has
 *   already replaced from a new address; excluded outright so they cannot yield a row.
 * @param {Array<string>} opts.offListIps addresses no longer on the deterministic node
 *   list past the off-list grace (offListDepartures): every row of theirs is negated
 *   here, locally, the same on every node that holds the same list.
 * @param {Array<{keys: string[], before: number}>} opts.offListReturned addresses back
 *   on the list after a departure past the grace: the rows they announced before the
 *   return are negated — a node that left the list removed its apps, so only what it
 *   announces after it is back counts.
 */
function buildAppLocationPipeline({
  now, appname = null, excludeHashes = [], ip = null, host = null, supersededIps = [], offListIps = [], offListReturned = [],
}) {
  const escapedName = appname ? appname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : null;
  const nameMatch = escapedName ? new RegExp(`^${escapedName}$`, 'i') : null;
  const removalNameFilter = nameMatch ? [{ $match: { 'data.appName': nameMatch } }] : [];

  const base = {
    $or: [
      { type: { $in: ['apprunning', 'appremoved'] }, expireAt: { $gt: now } },
      { type: 'nodedown' },
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
  if (offListIps.length) {
    clauses.push({ ip: { $nin: offListIps } });
  }
  if (offListReturned.length) {
    clauses.push({
      $nor: offListReturned.map(({ keys, before }) => ({ ip: { $in: keys }, broadcastedAt: { $lt: before } })),
    });
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
          { $project: { _id: 0, ip: '$data.ip', outpoint: 1, broadcastedAt: 1, apps: '$data.apps', osUptime: '$data.osUptime', staticIp: '$data.staticIp', runningSince: '$data.runningSince', meshAnchor: '$data.meshAnchor' } },
        ],
        // $max, not $first: these must not depend on an upstream sort that no longer exists.
        removals: [
          { $match: { type: 'appremoved' } },
          ...removalNameFilter,
          { $group: { _id: { ip: '$ip', name: '$data.appName' }, removedAt: { $max: '$broadcastedAt' } } },
        ],
        shutdowns: [
          // nodedown rides the same override as the others: an announcement
          // at or after the event wins. Its rows fall only once the grace has
          // run from the drop the jury saw: `since` on the record, the same
          // constant every node applies, so the fleet negates one node's rows
          // at one instant.
          { $match: { type: 'nodedown' } },
          { $addFields: { _eventAt: '$broadcastedAt' } },
          { $sort: { _eventAt: -1 } },
          {
            $group: {
              _id: '$ip',
              eventAt: { $first: '$_eventAt' },
              since: { $first: { $ifNull: ['$since', '$_eventAt'] } },
              expireAt: { $first: '$expireAt' },
              type: { $first: '$type' },
            },
          },
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
                    { $and: [{ $eq: ['$$sd.type', 'nodedown'] }, { $gt: [{ $add: ['$$sd.since', NODE_DOWN_GRACE_MS] }, now] }] },
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
    ...(excludeHashes.length ? [{ $match: { '_v2Filtered.apps.hash': { $nin: excludeHashes } } }] : []),
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
      // Mesh membership fields, null-defaulted to one shape: the entry's
      // authority bundle, its voucher, its transport port, its node's measured
      // link MTU, and the broadcast's anchor block. Absent on non-mesh entries
      // and on announcements that predate mesh.
      meshCa: { $ifNull: ['$_v2Filtered.apps.meshCa', null] },
      meshVoucher: { $ifNull: ['$_v2Filtered.apps.meshVoucher', null] },
      meshPort: { $ifNull: ['$_v2Filtered.apps.meshPort', null] },
      meshMtu: { $ifNull: ['$_v2Filtered.apps.meshMtu', null] },
      meshAnchor: { $ifNull: ['$_v2Filtered.meshAnchor', null] },
      shutdowns: 1,
    },
  },
  // When this row stops being believable. Derived rather than stored, to the rule
  // the materialized collection wrote it by: an announcement is good for the
  // running TTL, and a node certified down after it keeps its rows only until
  // the grace runs from the drop. Callers read this field off /apps/locations,
  // so it has to mean what it has always meant.
  {
    $addFields: {
      expireAt: {
        $let: {
          vars: { sd: { $first: { $filter: { input: '$shutdowns', as: 's', cond: { $eq: ['$$s._id', '$ip'] } } } } },
          in: {
            $cond: [
              { $and: [{ $ne: ['$$sd', null] }, { $eq: ['$$sd.type', 'nodedown'] }, { $gt: ['$$sd.eventAt', '$broadcastedAt'] }] },
              { $add: ['$$sd.since', NODE_DOWN_GRACE_MS] },
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

/**
 * The boot sweep of the off-list register: a rebooted node's register is
 * empty, so the row addresses the current list does not carry start their
 * grace from this observation — that is what stops the node believing a
 * node that left while it was down. Once, at boot, after the database is
 * ready; the reads then consult the register alone.
 *
 * @returns {Promise<number>} how many row addresses were swept
 */
async function sweepOffListRows() {
  const dbopen = dbHelper.databaseConnection();
  const database = dbopen.db(config.get('database.appsglobal.database'));
  const collection = database.collection(globalAppStateEvents);
  const now = new Date();
  const addresses = await collection.distinct('ip', { type: 'apprunning', expireAt: { $gt: now } });
  departures.seedFromRows(addresses, now.getTime());
  return addresses.length;
}

/**
 * Where apps run: the running rows the location events derive.
 *
 * Asked where an app runs (by name, or for every app), a node running a spec of
 * an earlier app registered under the same name is not counted: that is another
 * app. Asked what one node or host announces (`ip`, `host`), every row it
 * announces is answered, since a node reads its own claims to clean them up.
 *
 * @param {{appname?: string, ip?: string, host?: string, excludeHashes?: string[]}} [options]
 *   `excludeHashes` names the other apps' specs outright (appLocationOf)
 * @returns {Promise<Array>} location rows
 */
async function appLocationFromEvents(options = {}) {
  const {
    appname = null, ip = null, host = null,
  } = options;
  let { excludeHashes } = options;
  if (!excludeHashes) {
    excludeHashes = ip || host ? [] : await appRecords.decisions().earlierAppsHashes(appname ? [appname.toLowerCase()] : undefined);
  }
  const dbopen = dbHelper.databaseConnection();
  const database = dbopen.db(config.get('database.appsglobal.database'));
  const collection = database.collection(globalAppStateEvents);
  const now = new Date();

  const { supersededIps, translate } = await resolveAddressMoves(collection, now);
  const { absent: offListIps, returned: offListReturned } = departures.denySet(now.getTime());
  const rows = await collection.aggregate([
    ...buildAppLocationPipeline({
      now, appname, excludeHashes, ip, host, supersededIps, offListIps, offListReturned,
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
 * away. A node running an earlier app registered under the same name is not a replica
 * of this one. Address moves need only the supersede exclusion here, not the re-addressing:
 * moving a row to a different address does not change how many there are.
 *
 * @returns {Promise<Map<string, number>>}
 */
async function countRunningByApp() {
  const dbopen = dbHelper.databaseConnection();
  const database = dbopen.db(config.get('database.appsglobal.database'));
  const collection = database.collection(globalAppStateEvents);
  const now = new Date();

  const [{ supersededIps }, excludeHashes] = await Promise.all([
    resolveAddressMoves(collection, now), appRecords.decisions().earlierAppsHashes(),
  ]);
  const { absent: offListIps, returned: offListReturned } = departures.denySet(now.getTime());
  const counts = await collection.aggregate([
    ...buildAppLocationPipeline({
      now, excludeHashes, supersededIps, offListIps, offListReturned,
    }),
    ...RUNNING_COUNT_TAIL,
  ]).toArray();
  return new Map(counts.map((row) => [String(row._id).toLowerCase(), row.count]));
}

// ── Installing Locations ───────────────────────────────────────────

async function removeInstallingLocation(appName, ip) {
  return dbHelper.removeDocumentsFromCollection(
    globalDb(), globalAppsInstallingLocations, { name: appName, ip },
  );
}

// ── V7 Secrets Queries ─────────────────────────────────────────────

async function listLiveV7Secrets() {
  const apps = (await appRecords.registry().pinned()).filter((inst) => inst.version === 7);
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

async function listHistoricalV7Secrets(before = null) {
  await getSpec();
  const { deserializeSpec } = await getSpecBackend();
  // Mined before a chain position: what the decider reads, so that a message
  // decided late on one node and early on another meets the same uses.
  const records = await appRecords.messages().confirmedOfSpecVersion(7, { before });
  const results = [];
  for (const record of records) {
    const specBlob = record.contents.appSpecifications;
    if (!Array.isArray(specBlob.nodes) || specBlob.nodes.length === 0) continue;
    let spec;
    try {
      spec = deserializeSpec(specBlob, { chain: nodeChain(), height: record.payment?.height });
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
  sweepOffListRows,
  hydrate,
  getApplicationOwner,
  getApplicationOwnerByIdentity,
  removeAppInstallingErrorRecords,
  // installed apps
  // messages
  getAppMessage,
  getPermanentMessage,
  getTempMessage,
  getTempMessageByName,
  carriedManifestRanks,
  listAppMessagesByName,
  // ingress attestations
  storeIngressAttestation,
  confirmIngressAttestations,
  listIngressAttestations,
  listIngressAttestationsByApp,
  listIngressAttestationDigests,
  listIngressAttestationsForBuckets,
  // upsert + errors
  upsertAppInstallingErrorLocations,
  // the running set, derived from the app state event log
  appLocationFromEvents,
  countRunningByApp,
  removeInstallingLocation,
  // conflict checks
  // secrets
  listLiveV7Secrets,
  listHistoricalV7Secrets,
  listHistoricalV7SecretsBefore: (position) => listHistoricalV7Secrets(position),
};
