import { MongoClient } from 'mongodb';
import { REGISTRY_DERIVED_FIELDS } from '@runonflux/flux-spec-backend';
import { getSubnetConfig } from './subnet-config.js';

const MONGO_URL = process.env.MONGO_URL || `mongodb://${getSubnetConfig().mongo}:27017`;

let sharedClient = null;

async function getClient() {
  if (!sharedClient) {
    sharedClient = new MongoClient(MONGO_URL);
    await sharedClient.connect();
  }
  return sharedClient;
}

export async function closeDb() {
  if (sharedClient) {
    await sharedClient.close();
    sharedClient = null;
  }
}

// An address field naming the node at bareIp, with or without its port.
const atAddress = (bareIp) => ({ $regex: `^${bareIp.replace(/\./g, '\\.')}(:|$)` });

export function dbClient(nodeNum) {
  const prefix = `node${String(nodeNum).padStart(2, '0')}_`;

  const dbNames = {
    local: `${prefix}zelfluxlocal`,
    explorer: `${prefix}zelcashdata`,
    appsLocal: `${prefix}localzelapps`,
    appsGlobal: `${prefix}globalzelapps`,
    chainparams: `${prefix}chainparams`,
  };

  async function db(name) {
    const client = await getClient();
    return client.db(dbNames[name]);
  }

  return {
    prefix,
    dbNames,

    // The app messages this node holds: one record per hash, the chain's
    // payment and the contents as separate halves (`paid`, `held`).
    async messages() {
      const globalDb = await db('appsGlobal');
      return globalDb.collection('appmessages');
    },

    // An app's founding record on this node: its anchors (photos by height),
    // its component pins and the heights it last recorded and mapped.
    async foundingRecord(identity) {
      return (await db('local')).collection('foundingcommittees').findOne({ _id: identity });
    },

    // The payments the scan recorded: all of them, those whose contents the
    // node holds, those still to fetch, and those marked not found.
    async hashCounts() {
      const col = await this.messages();
      const [total, resolved, missing, notFound] = await Promise.all([
        col.countDocuments({ paid: true }),
        col.countDocuments({ paid: true, held: true }),
        col.countDocuments({ paid: true, held: false, messageNotFound: { $ne: true } }),
        col.countDocuments({ paid: true, messageNotFound: true }),
      ]);
      return { total, resolved, missing, notFound };
    },

    async explorerHeight() {
      const explorerDb = await db('explorer');
      const doc = await explorerDb.collection('scannedheight').findOne({});
      return doc?.generalScannedHeight ?? 0;
    },

    // Wipe one register cell's journal row — the wiped-journal referee: it
    // still ANSWERS asks (no_grant) but holds no accepted grant, which is
    // exactly the answering-empty shape the repair chore re-seats.
    async wipeQuorumGrantRegister(key) {
      const localDb = await db('local');
      const res = await localDb.collection('quorumgrants').deleteOne({ _id: key });
      return res.deletedCount;
    },

    // The identity of the app the registry lists under a name: what grant
    // keys, lease records and generation records are keyed by. Every
    // registration's is its uuid's, whatever version registered it.
    async identityOf(appName) {
      return (await this.getGlobalApp(appName))?.identity ?? null;
    },

    // The published masterlease record's roster, as THIS node has synced it.
    // The self-verifying heal proof (quorum-signed acceptances) rides here —
    // a register's own journaled chain is trusted and deliberately bare.
    async getMasterleaseRoster(identity, role) {
      const globalDb = await db('appsGlobal');
      const row = await globalDb.collection('appstateevents').findOne(
        { type: 'masterlease', dedupKey: `masterlease:${identity}/${role}` },
      );
      return row?.data?.roster ?? null;
    },

    // The whole published record as THIS node has synced it — how a suite
    // asserts a node CONVERGED on the change-driven record (published once;
    // a node that missed it must be backfilled by the app-state sync).
    async getMasterleaseRecord(identity, role) {
      const globalDb = await db('appsGlobal');
      const row = await globalDb.collection('appstateevents').findOne(
        { type: 'masterlease', dedupKey: `masterlease:${identity}/${role}` },
      );
      // the row holds the record as signed, with this node's verdict beside it
      return row?.data ? { ...row.data, proofRank: row.proofRank, verified: row.verified } : null;
    },

    // Delete this node's synced copy of the record — stages "the node missed
    // the one-time gossip" without any partition timing.
    async wipeMasterleaseRecord(identity, role) {
      const globalDb = await db('appsGlobal');
      const res = await globalDb.collection('appstateevents').deleteOne(
        { type: 'masterlease', dedupKey: `masterlease:${identity}/${role}` },
      );
      return res.deletedCount;
    },

    // This node's synced nodedown certificate rows for a subject (all incidents,
    // newest and lapsed alike — standing-ness is derived, never materialized).
    // RELEASED-FLEET COMPATIBILITY: delete with appMessaging/releasedFleetSigterm
    // (suite 3407 reads these two).
    // The app state events this node stored of a type for a node, by its bare IP
    // with or without the port: a released node stores a fluxnodesigterm it acted
    // on as type 'sigterm'.
    async appStateEvents(type, bareIp) {
      const globalDb = await db('appsGlobal');
      return globalDb.collection('appstateevents').find({ type, ip: atAddress(bareIp) }).toArray();
    },
    // The running-location rows a released node holds for a node, by its bare IP
    // with or without the port, with the expireAt a fluxnodesigterm shortens.
    async releasedLocationRows(bareIp) {
      const globalDb = await db('appsGlobal');
      return globalDb.collection('zelappslocation').find({ ip: atAddress(bareIp) }).toArray();
    },
    async getNodeDownRecords(subject) {
      const globalDb = await db('appsGlobal');
      return globalDb.collection('appstateevents')
        .find({ type: 'nodedown', subject }, { projection: { _id: 0 } }).toArray();
    },

    // Where the subject's latest record stands, derived as the store derives it
    // (nodeDownStore.recordStateFor): 'none' with no unexpired row, 'refuted'
    // when an app-running announcement from the subject was stored at or after
    // the newest row's broadcast, 'standing' otherwise. A standing record makes
    // the store refuse the next certificate as already_standing, so a suite
    // that stages a second death waits for the first's refutation everywhere.
    async getNodeDownRecordState(subject) {
      const globalDb = await db('appsGlobal');
      const events = globalDb.collection('appstateevents');
      const now = Date.now();
      const rows = (await events.find({ type: 'nodedown', subject }).toArray())
        .filter((row) => new Date(row.expireAt).getTime() > now);
      if (!rows.length) return 'none';
      const newest = rows.reduce((a, b) => (new Date(b.broadcastedAt) > new Date(a.broadcastedAt) ? b : a));
      // The node's own reading: an app announcement or the subject's alive record,
      // stamped at or after the certificate, refutes it.
      const refutation = await events.findOne({
        type: { $in: ['apprunning', 'nodealive'] }, outpoint: subject, broadcastedAt: { $gte: new Date(newest.broadcastedAt) },
      });
      return refutation ? 'refuted' : 'standing';
    },

    // Delete this node's synced copy of a subject's certificates — stages "the
    // node missed the one-flood gossip" so a boot must recover them over sync.
    async wipeNodeDownRecords(subject) {
      const globalDb = await db('appsGlobal');
      const res = await globalDb.collection('appstateevents')
        .deleteMany({ type: 'nodedown', subject });
      return res.deletedCount;
    },

    async permanentMessageCount() {
      return (await this.messages()).countDocuments({ paid: true, held: true });
    },

    // This node's permanent record of one app message. Promotion stores it
    // BEFORE deciding whether the message was paid for, so its arrival is the
    // signal that the pricing verdict has been reached — which is what lets a
    // test assert a message was refused without waiting out a timeout.
    async getPermanentMessage(hash) {
      return (await this.messages()).findOne({ hash, paid: true, held: true }, { projection: { _id: 0 } });
    },

    // This node's registry row for an app — the materialized global state, with
    // the fields the API projection drops. `registeredAt` is the app's current
    // term start, so it is what says whether an update renewed the app.
    async getGlobalApp(appName) {
      const globalDb = await db('appsGlobal');
      return globalDb.collection('zelappsinformation')
        .findOne({ name: appName }, { projection: { _id: 0 } });
    },

    // A component's key, as this node names it. The hosted instance keys each
    // component it holds; one stored before keys is keyed by its names. Before the
    // node installs the app, a component of an app whose spec is still v1-v8 is
    // keyed by its name, since only a v9 update continues a component under a new
    // one. Null otherwise, and while the node holds no row.
    async componentKey(appName, componentName) {
      const installed = await this.getLocalApp(appName);
      if (installed) return installed.componentKeys ? (installed.componentKeys[componentName] ?? null) : componentName;
      const app = await this.getGlobalApp(appName);
      if (!app) return null;
      if (!Number.isInteger(app.version)) {
        throw new Error(`componentKey(${appName}): the row states no spec version`);
      }
      return app.version < 9 ? componentName : null;
    },

    // The container identifier of one component, `<component key>_<identity>[_<replica>]`,
    // from this node's registration row and the component's key: the docker name, the
    // appdata directory under the apps folder and the backing image are all named by
    // it. Null while the node holds no row or the component has no key.
    async appContainerName(appName, componentName, replica = null) {
      if (typeof componentName !== 'string' || componentName === '') {
        throw new Error(`appContainerName(${appName}): name the component whose container it is`);
      }
      const app = await this.getGlobalApp(appName);
      if (!app) return null;
      if (typeof app.identity !== 'string') {
        throw new Error(`appContainerName(${appName}): the row states no identity`);
      }
      const key = await this.componentKey(appName, componentName);
      if (key === null) return null;
      const base = `${key}_${app.identity}`;
      return replica != null ? `${base}_${replica}` : base;
    },

    // Writes the app history a release before v9 keeps, in its collections,
    // shapes and indexes: the payment index, the permanent messages and the app
    // list (see app-corpus.js). For a node that has not booted yet.
    async seedLegacyAppStore({
      payments, messages, listed, indexes,
    }) {
      const explorerDb = await db('explorer');
      const globalDb = await db('appsGlobal');
      const batches = async (collection, rows) => {
        for (let i = 0; i < rows.length; i += 5000) {
          // eslint-disable-next-line no-await-in-loop
          await collection.insertMany(rows.slice(i, i + 5000).map((row) => ({ ...row })), { ordered: false });
        }
      };
      const collections = {
        payments: explorerDb.collection('zelappshashes'),
        messages: globalDb.collection('zelappsmessages'),
        listed: globalDb.collection('zelappsinformation'),
      };
      await batches(collections.payments, payments);
      await batches(collections.messages, messages);
      await batches(collections.listed, listed);
      for (const [store, specs] of Object.entries(indexes ?? {})) {
        // eslint-disable-next-line no-await-in-loop
        if (specs.length) await collections[store].createIndexes(specs);
      }
    },

    // This node's stored decision on a paid app message, or null when it holds
    // none: what the decider wrote, read where no route serves it.
    async decision(hash) {
      const globalDb = await db('appsGlobal');
      return globalDb.collection('appdecisions').findOne({ hash }, { projection: { _id: 0 } });
    },

    // The version the app on this node's registration row was registered with:
    // the spec version of the first message the decider applied for the row's
    // uuid, as the node reads it when it names the app's components.
    async registrationVersion(appName) {
      const app = await this.getGlobalApp(appName);
      if (!app) return null;
      const globalDb = await db('appsGlobal');
      const registration = await globalDb.collection('appdecisions')
        .find({ name: appName.toLowerCase(), decision: 'applied', uuid: app.uuid })
        .sort({ height: 1, txIndex: 1 }).limit(1).toArray();
      if (!registration.length) {
        throw new Error(`registrationVersion(${appName}): no applied decision registers the row's app`);
      }
      const message = await this.getPermanentMessage(registration[0].hash);
      const version = message?.appSpecifications?.version;
      if (!Number.isInteger(version)) {
        throw new Error(`registrationVersion(${appName}): the registration message states no spec version`);
      }
      return version;
    },

    // The syncthing folder id of one component, fixed by the version the app was
    // registered with and built from the component's key: an app registered before
    // v9 keeps its 8.x container name, `flux<key>_<name>[_<replica>]`, so that every
    // node running it names the folder alike; a v9 registration's is its container
    // identifier.
    async appFolderId(appName, componentName, replica = null) {
      if (typeof componentName !== 'string' || componentName === '') {
        throw new Error(`appFolderId(${appName}): name the component whose folder it is`);
      }
      const registrationVersion = await this.registrationVersion(appName);
      if (registrationVersion === null) return null;
      if (registrationVersion < 9) {
        const key = await this.componentKey(appName, componentName);
        if (key === null) return null;
        const base = `flux${key}_${appName}`;
        return replica != null ? `${base}_${replica}` : base;
      }
      return this.appContainerName(appName, componentName, replica);
    },

    async appSpecCount() {
      const globalDb = await db('appsGlobal');
      return globalDb.collection('zelappsinformation').countDocuments({});
    },

    async tempMessageCount() {
      return (await this.messages()).countDocuments({ held: true, paid: false });
    },

    async installingCount() {
      const globalDb = await db('appsGlobal');
      return globalDb.collection('appsinstallinglocations').countDocuments({});
    },

    // This node's view of who claims to be installing an app (the rows
    // fluxappinstalling messages upsert). Cleared claims and the winner's
    // running broadcast both delete rows here, so an empty result after
    // convergence means every seat was released, not TTL'd.
    async getAppInstallingLocations(appName) {
      const globalDb = await db('appsGlobal');
      return globalDb.collection('appsinstallinglocations').find({ name: appName }).toArray();
    },

    async installingErrorCount() {
      const globalDb = await db('appsGlobal');
      return globalDb.collection('appsInstallingErrorsLocations').countDocuments({});
    },

    async localAppCount() {
      const localDb = await db('appsLocal');
      return localDb.collection('zelappsinformation').countDocuments({});
    },

    // This node's installed-app row. Its `hash` is the spec message the node
    // actually runs — after an update confirms, the reconcile sweep rewrites the
    // row to the new spec, so hash catching up to the update hash IS adoption.
    async getLocalApp(appName) {
      const localDb = await db('appsLocal');
      return localDb.collection('zelappsinformation').findOne({ name: appName }, { projection: { _id: 0 } });
    },

    // Every installed row for the app on this node, one per deployed identity.
    // The single-row read above cannot say WHICH sibling it returned on a
    // co-located node, so per-identity assertions read these instead.
    // Every local app row, not one app's. The count says a row vanished; this says
    // WHICH — the difference between "an app is gone" and a name to grep the logs for.
    async listLocalApps() {
      const localDb = await db('appsLocal');
      return localDb.collection('zelappsinformation')
        .find({}, { projection: { _id: 0, name: 1, hash: 1 } }).toArray();
    },

    async getLocalApps(appName) {
      const localDb = await db('appsLocal');
      return localDb.collection('zelappsinformation')
        .find({ name: appName }, { projection: { _id: 0 } }).toArray();
    },

    async eventCounts() {
      const globalDb = await db('appsGlobal');
      const col = globalDb.collection('appstateevents');
      const hasCollection = await globalDb.listCollections({ name: 'appstateevents' }).hasNext();
      if (!hasCollection) return { total: 0 };
      const total = await col.countDocuments({});
      return { total };
    },

    async chainMessageCount() {
      const cpDb = await db('chainparams');
      const hasCollection = await cpDb.listCollections({ name: 'chainmessages' }).hasNext();
      if (!hasCollection) return 0;
      return cpDb.collection('chainmessages').countDocuments({});
    },

    async chainMessages() {
      const cpDb = await db('chainparams');
      const hasCollection = await cpDb.listCollections({ name: 'chainmessages' }).hasNext();
      if (!hasCollection) return [];
      return cpDb.collection('chainmessages').find({}).toArray();
    },

    // residentialNodeDosService's settling window. Persisted so that restarting
    // FluxOS cannot restart the clock; a suite reads it to tell "held" from
    // "evacuating", and writes it to put the window in the past.
    async residentialMarker() {
      const localDb = await db('local');
      return localDb.collection('nodestartuptracker').findOne({ _id: 'residentialDos' });
    },

    // Serve the settling window without waiting it out.
    //
    // The gate counts time the node OBSERVED the verdict, not time that passed,
    // so backdating residentialSince alone no longer serves it - that field is
    // kept for the operator reading the record. observedMs is what the node
    // compares against residentialSettleMs, and lastConfirmedAt is set to now so
    // the node's next tick credits nothing on top and the total stays put.
    async serveSettleWindow(observedMs = 48 * 60 * 60 * 1000) {
      const localDb = await db('local');
      const now = Date.now();
      await localDb.collection('nodestartuptracker').updateOne(
        { _id: 'residentialDos' },
        { $set: { residentialSince: now - observedMs, lastConfirmedAt: now, observedMs } },
        { upsert: true },
      );
    },

    async geolocation() {
      const localDb = await db('local');
      return localDb.collection('geolocation').findOne({ _id: 'nodeGeolocation' });
    },

    async clearExplorer() {
      const explorerDb = await db('explorer');
      const collections = await explorerDb.listCollections().toArray();
      for (const col of collections) {
        if (col.name !== 'scannedheight') {
          await explorerDb.collection(col.name).deleteMany({});
        }
      }
    },

    async clearAppsGlobal() {
      const globalDb = await db('appsGlobal');
      const collections = await globalDb.listCollections().toArray();
      for (const col of collections) {
        await globalDb.collection(col.name).deleteMany({});
      }
    },

    async clearAll() {
      await this.clearExplorer();
      await this.clearAppsGlobal();
      const localDb = await db('appsLocal');
      const localCols = await localDb.listCollections().toArray();
      for (const col of localCols) {
        await localDb.collection(col.name).deleteMany({});
      }
    },

    async seedScannedHeight(height) {
      const explorerDb = await db('explorer');
      await explorerDb.collection('scannedheight').updateOne(
        {},
        { $set: { generalScannedHeight: height } },
        { upsert: true },
      );
    },

    // This node's payment record for an app message hash, as the scan wrote it
    // and the voids and the sync have marked it, with `message` saying whether
    // the node holds the contents. Null while the node holds no payment.
    async getAppHash(hash) {
      const record = await (await this.messages()).findOne({ hash, paid: true }, { projection: { _id: 0 } });
      return record ? { ...record, message: record.held === true } : null;
    },

    // Takes the contents off a paid record, so the node must fetch them again.
    async deletePermanentMessage(hash) {
      await (await this.messages()).updateOne(
        { hash, paid: true },
        {
          $set: { held: false, messageNotFound: false },
          $unset: {
            type: '', version: '', appSpecifications: '', contentHash: '', timestamp: '', extend: '', signature: '', arcaneAttestation: '', contentManifest: '', nameKey: '',
          },
        },
      );
    },

    async markHashUnresolved(hash) {
      await this.deletePermanentMessage(hash);
    },

    async deleteAppHash(hash) {
      await (await this.messages()).deleteOne({ hash });
    },

    async deleteAppSpec(name) {
      const explorerDb = await db('explorer');
      await explorerDb.collection('zelappsinformation').deleteOne({ name });
    },

    async writeHeartbeat({ lastAlive, shutdownReason, machineBootId }) {
      const localDb = await db('local');
      const update = { lastAlive };
      if (shutdownReason !== undefined) update.shutdownReason = shutdownReason;
      if (machineBootId !== undefined) update.machineBootId = machineBootId;
      await localDb.collection('nodestartuptracker').updateOne(
        { _id: 'heartbeat' },
        { $set: update },
        { upsert: true },
      );
    },

    // The specification row this node holds for one app, as the record was
    // written. What a replayed message has to produce on a node that was never
    // given the message.
    async globalAppSpec(name) {
      const globalDb = await db('appsGlobal');
      const stored = await globalDb.collection('zelappsinformation').findOne({ nameKey: name.toLowerCase() }, { projection: { _id: 0 } });
      if (!stored) return null;
      for (const field of REGISTRY_DERIVED_FIELDS) delete stored[field];
      return stored;
    },

    // One deduplicated tampering incident, as appTamperingRepository.upsertIncident writes it.
    // The enforcer sums `severity` over rows with schemaVersion >= 1, so this is how a suite
    // puts a node over TAMPER_SCORE_THRESHOLD without having to actually tamper with it.
    // detectedAt/lastSeen are real Dates because both carry a 30-day TTL index.
    async seedTamperingIncident({ severity, appName = 'e2etamper', incidentKey } = {}) {
      const localDb = await db('local');
      const now = new Date();
      await localDb.collection('apptamperingevents').insertOne({
        schemaVersion: 1,
        severity,
        appName,
        incidentKey: incidentKey || `e2e-${appName}-${now.getTime()}`,
        detectedAt: now,
        lastSeen: now,
      });
    },

    // What policyStore cached: the payload for a document, or for an artifact the GridFS file
    // id its bytes live under. Lets a suite prove last-known-good is real storage rather than
    // a process-lifetime variable.
    async policyDocument(name) {
      const localDb = await db('local');
      return localDb.collection('policydocuments').findOne({ _id: name });
    },

    // Make a node look like it has never successfully fetched a document, so the next boot
    // falls through to the seed the release shipped.
    async deletePolicyDocument(name) {
      const localDb = await db('local');
      await localDb.collection('policydocuments').deleteOne({ _id: name });
    },

    // v9 content manifests: one row per manifest a node holds, keyed by the app
    // identity and the manifest's hash. The row shape is appsRepository.putContentManifest's:
    // { identity, hash, version, ownedFrom, signer, applied, data, envelope? }; a row held
    // for an app not yet listed has signer null and an expireAt.
    async contentManifestCount() {
      const globalDb = await db('appsGlobal');
      return globalDb.collection('appcontentmanifests').countDocuments({});
    },

    // Every manifest row held for the app the registry lists under a name.
    async getContentManifests(appName) {
      const identity = await this.identityOf(appName);
      if (!identity) return [];
      return this.getContentManifestsByIdentity(identity);
    },

    async getContentManifestsByIdentity(identity) {
      const globalDb = await db('appsGlobal');
      return globalDb.collection('appcontentmanifests').find({ identity }, { projection: { _id: 0 } }).toArray();
    },

    // The highest-ranked row held for the app listed under a name — resolved rows
    // first, by the ownership height then the version — or the one held row. What a
    // suite reads as "the manifest this node holds".
    async getContentManifest(appName) {
      const rows = await this.getContentManifests(appName);
      if (!rows.length) return null;
      const rank = (r) => [r.signer ? 1 : 0, Number(r.ownedFrom ?? 0), Number(r.version ?? 0)];
      return rows.reduce((best, r) => {
        const [bs, bo, bv] = rank(best);
        const [s, o, v] = rank(r);
        return s > bs || (s === bs && (o > bo || (o === bo && v > bv))) ? r : best;
      });
    },

    async getContentManifestByIdentity(identity) {
      const rows = await this.getContentManifestsByIdentity(identity);
      return rows.find((r) => r.signer) ?? rows[0] ?? null;
    },

    // The row marked as delivered to the running app, or null.
    async getAppliedContentManifest(appName) {
      const rows = await this.getContentManifests(appName);
      return rows.find((r) => r.applied === true) ?? null;
    },

    // Seed an appcontentmanifests row directly, in the stored shape, to stage a
    // stale, divergent or held manifest without the live path. For an encrypted app
    // the manifest slots must already be SEALED; an optional envelope enables
    // boot-sync re-serve. `hash` is the manifest's library hash (contentManifestHash
    // of the plaintext); a suite that only needs a distinct row may pass any string.
    async seedContentManifest({
      appName, version, manifest, hash, signer, envelope,
    }) {
      const globalDb = await db('appsGlobal');
      const identity = manifest.identity ?? await this.identityOf(appName);
      const row = {
        identity,
        hash: hash ?? `seed-${version}-${Date.now()}`,
        version,
        ownedFrom: manifest.ownedFrom ?? 0,
        signer: signer ?? null,
        applied: false,
        receivedAt: new Date(),
        data: { type: 'fluxappcontentmanifest', appName, manifest },
      };
      if (envelope) row.envelope = envelope;
      if (!row.signer) row.expireAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
      await globalDb.collection('appcontentmanifests').insertOne(row);
    },

    // Remove a global app spec behind the registry's back (appremove/expiry don't
    // clear the global row in a test).
    async deleteGlobalAppSpec(name) {
      const globalDb = await db('appsGlobal');
      await globalDb.collection('zelappsinformation').deleteOne({ name });
    },

    // Where an app runs is a derivation over the app state event log, so seeding a
    // location means asserting the apprunning event the derivation reads. There is no
    // materialized row to write; writing one would seed a shape nothing consults.
    // One v2 apprunning event per holder, as the wire carries it: a second app
    // seeded on the same holder joins that event's apps rather than becoming a
    // second event the unique index refuses.
    async seedAppLocation({ name, ip, hash, broadcastedAt, runningSince }) {
      const globalDb = await db('appsGlobal');
      const ts = broadcastedAt ?? Date.now();
      const entry = { name, hash, runningSince: runningSince ?? ts };
      const key = { type: 'apprunning', ip, dedupKey: 'v2' };
      const held = await globalDb.collection('appstateevents').findOne(key);
      if (held) {
        await globalDb.collection('appstateevents').updateOne(key, {
          $push: { 'data.apps': entry },
          $set: {
            broadcastedAt: new Date(ts),
            expireAt: new Date(ts + 125 * 60 * 1000),
            receivedAt: new Date(ts),
            'data.broadcastedAt': ts,
          },
        });
        return;
      }
      await globalDb.collection('appstateevents').insertOne({
        ...key,
        broadcastedAt: new Date(ts),
        expireAt: new Date(ts + 125 * 60 * 1000),
        receivedAt: new Date(ts),
        data: { apps: [entry], ip, broadcastedAt: ts },
      });
    },

    async seedAppStateEvent(event) {
      const globalDb = await db('appsGlobal');
      await globalDb.collection('appstateevents').insertOne(event);
    },

    /**
     * The same, for a whole set, in ONE round trip.
     *
     * These events carry `broadcastedAt`, and the window that accepts them is
     * real - messageStore refuses a broadcast older than locationTtlS, which the
     * harness compresses to 63s. Seeding a few hundred of them an insertOne at a
     * time costs more wall-clock than the window itself, so the events expire
     * during their own seeding and the suite reads an empty location list rather
     * than a rejected message. Ordered, because a suite that seeds two broadcasts
     * from one node is usually proving which of them wins.
     */
    async seedAppStateEvents(events) {
      if (!events.length) return;
      const globalDb = await db('appsGlobal');
      await globalDb.collection('appstateevents').insertMany(events, { ordered: true });
    },

    async seedLocalApp(spec) {
      const localDb = await db('appsLocal');
      await localDb.collection('zelappsinformation').insertOne(spec);
    },


    async seedInstallingLocation({ name, ip, broadcastedAt }) {
      const globalDb = await db('appsGlobal');
      const ts = broadcastedAt ?? Date.now();
      await globalDb.collection('appsinstallinglocations').insertOne({
        name,
        ip,
        broadcastedAt: new Date(ts),
        expireAt: new Date(ts + 15 * 60 * 1000),
      });
    },

    async seedInstallingError({ name, hash, ip, error, broadcastedAt }) {
      const globalDb = await db('appsGlobal');
      const ts = broadcastedAt ?? Date.now();
      await globalDb.collection('appsInstallingErrorsLocations').insertOne({
        name,
        hash,
        ip,
        error,
        broadcastedAt: new Date(ts),
        expireAt: new Date(ts + 24 * 60 * 60 * 1000),
      });
    },

    // The signed policy bundle this node last verified, as policyArtifactRepository wrote
    // it. Read from mongo rather than from an endpoint because it is the only surface that
    // is neither cached nor derived: /flux/enterpriseappowners answers through apicache and
    // remembers its first SUCCESSFUL answer for an hour, so a suite that changes policy and
    // reads it twice is reading the first answer both times.
    //
    // THE PERSISTED COPY, AND IT LAGS ADOPTION. policyStore.adopt() writes memory, announces
    // to peers and publishes policy:bundleChanged, then persists WITHOUT awaiting the write -
    // deliberately, since a node already running on a bundle only loses it at the next boot.
    // So this answers null for a node that has adopted and not yet stored. Poll it; a single
    // sample compared across nodes reports a level fleet as out of step.
    async policyBundle() {
      const localDb = await db('local');
      return localDb.collection('policydocuments').findOne({ _id: 'networkPolicy' });
    },

    // Forget the stored bundle, for the boot that has to resolve one from somewhere else.
    async deletePolicyBundle() {
      const localDb = await db('local');
      await localDb.collection('policydocuments').deleteOne({ _id: 'networkPolicy' });
    },

    async countInstallingErrors(hash = null) {
      const globalDb = await db('appsGlobal');
      return globalDb.collection('appsInstallingErrorsLocations').countDocuments(hash ? { hash } : {});
    },

    async dropAndReseed(ip, height) {
      const client = await getClient();
      for (const name of Object.values(dbNames)) {
        await client.db(name).dropDatabase();
      }
      await this.seedScannedHeight(height);
      await this.seedGeolocation(ip);
    },

    // failCommand is a single GLOBAL failpoint on the mongod, and all harness
    // nodes share one mongod: arming it for several nodes/namespaces just
    // overwrites the previous configuration. One namespace at a time only.
    async failpointFind(collection, { times = 1, always = false, errorCode = 50, db: dbKey = 'explorer' } = {}) {
      const client = await getClient();
      const namespace = `${dbNames[dbKey]}.${collection}`;
      await client.db('admin').command({
        configureFailPoint: 'failCommand',
        mode: always ? 'alwaysOn' : { times },
        data: { failCommands: ['find'], errorCode, namespace },
      });
    },

    async failpointClear() {
      const client = await getClient();
      await client.db('admin').command({
        configureFailPoint: 'failCommand',
        mode: 'off',
      });
    },
  };
}
