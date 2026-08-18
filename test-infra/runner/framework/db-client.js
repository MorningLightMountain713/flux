import { MongoClient } from 'mongodb';
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

    async hashCounts() {
      const explorerDb = await db('explorer');
      const col = explorerDb.collection('zelappshashes');
      const [total, resolved, missing, notFound] = await Promise.all([
        col.countDocuments({}),
        col.countDocuments({ message: true }),
        col.countDocuments({ message: false, messageNotFound: { $ne: true } }),
        col.countDocuments({ messageNotFound: true }),
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

    // The published masterlease record's roster, as THIS node has synced it.
    // The self-verifying heal proof (quorum-signed acceptances) rides here —
    // a register's own journaled chain is trusted and deliberately bare.
    async getMasterleaseRoster(appName, role) {
      const globalDb = await db('appsGlobal');
      const row = await globalDb.collection('appstateevents').findOne(
        { type: 'masterlease', dedupKey: `masterlease:${appName}/${role}` },
      );
      return row?.data?.roster ?? null;
    },

    async permanentMessageCount() {
      const globalDb = await db('appsGlobal');
      return globalDb.collection('zelappsmessages').countDocuments({});
    },

    // This node's permanent record of one app message. Promotion stores it
    // BEFORE deciding whether the message was paid for, so its arrival is the
    // signal that the pricing verdict has been reached — which is what lets a
    // test assert a message was refused without waiting out a timeout.
    async getPermanentMessage(hash) {
      const globalDb = await db('appsGlobal');
      return globalDb.collection('zelappsmessages').findOne({ hash }, { projection: { _id: 0 } });
    },

    // This node's registry row for an app — the materialized global state, with
    // the fields the API projection drops. `registeredAt` is the app's current
    // term start, so it is what says whether an update renewed the app.
    async getGlobalApp(appName) {
      const globalDb = await db('appsGlobal');
      return globalDb.collection('zelappsinformation')
        .findOne({ name: appName }, { projection: { _id: 0 } });
    },

    // The syncthing folder id / appdata dir for one component: `flux<identifier>`,
    // where the identifier is `<component>_<identity>[_<replica>]`. Read from the
    // registration row, so it answers BEFORE the app is installed — which is when the
    // cold-start suites need it, and when no container exists to read a label from.
    async appFolderId(appName, componentName, replica = null) {
      const app = await this.getGlobalApp(appName);
      if (!app) return null;
      const segment = app.identity ?? appName;
      const base = `flux${componentName}_${segment}`;
      return replica != null ? `${base}_${replica}` : base;
    },

    async appSpecCount() {
      const globalDb = await db('appsGlobal');
      return globalDb.collection('zelappsinformation').countDocuments({});
    },

    async tempMessageCount() {
      const globalDb = await db('appsGlobal');
      return globalDb.collection('zelappstemporarymessages').countDocuments({});
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

    async seedGeolocation(ip) {
      const localDb = await db('local');
      await localDb.collection('geolocation').updateOne(
        { _id: 'nodeGeolocation' },
        {
          $set: {
            geolocation: {
              ip,
              continent: 'Europe',
              continentCode: 'EU',
              country: 'Germany',
              countryCode: 'DE',
              region: 'HE',
              regionName: 'Hesse',
              lat: 50.1109,
              lon: 8.6821,
              org: 'Test Network',
              static: true,
              dataCenter: true,
            },
            staticIp: true,
            dataCenter: true,
            lastIpChangeDate: null,
            updatedAt: Date.now(),
          },
        },
        { upsert: true },
      );
    },

    async seedAppHash(hash, height, resolved = false) {
      const explorerDb = await db('explorer');
      await explorerDb.collection('zelappshashes').insertOne({
        hash,
        height,
        txid: hash,
        value: 200000000,
        message: resolved,
        messageNotFound: false,
        createdAt: new Date(),
      });
    },

    async markHashUnresolved(hash) {
      const explorerDb = await db('explorer');
      await explorerDb.collection('zelappshashes').updateOne(
        { hash },
        { $set: { message: false, messageNotFound: false } },
      );
    },

    async deletePermanentMessage(hash) {
      const explorerDb = await db('explorer');
      await explorerDb.collection('zelappsmessages').deleteOne({ hash });
    },

    async deleteAppHash(hash) {
      const explorerDb = await db('explorer');
      await explorerDb.collection('zelappshashes').deleteOne({ hash });
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

    async seedGlobalAppSpec(spec) {
      const globalDb = await db('appsGlobal');
      await globalDb.collection('zelappsinformation').insertOne(spec);
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

    // v9 content-slot manifest register (one row per app, version-monotonic). The
    // row shape is contentSlotService.storeManifest's: { appName, version, data, confirmed }.
    async contentManifestCount() {
      const globalDb = await db('appsGlobal');
      return globalDb.collection('appcontentmanifests').countDocuments({});
    },

    async getContentManifest(appName) {
      const globalDb = await db('appsGlobal');
      return globalDb.collection('appcontentmanifests').findOne({ appName }, { projection: { _id: 0 } });
    },

    // Seed an appcontentmanifests row directly, mirroring contentSlotService.storeManifest's
    // stored shape, to stage a stale/divergent/quarantined manifest without the live path.
    // For an encrypted app the manifest slots must already be SEALED (seed confirmed:true to
    // skip re-verify on serve); an optional envelope enables boot-sync re-serve.
    async seedContentManifest({
      appName, version, manifest, confirmed = true, envelope,
    }) {
      const globalDb = await db('appsGlobal');
      const row = {
        appName,
        version,
        confirmed,
        receivedAt: new Date(),
        data: { type: 'fluxappcontentmanifest', appName, manifest },
      };
      if (envelope) row.envelope = envelope;
      if (!confirmed) row.expireAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
      await globalDb.collection('appcontentmanifests').insertOne(row);
    },

    // Remove a global app spec so the dead-app manifest reaper has an orphaned
    // confirmed manifest to drop (appremove/expiry don't clear the global row in a test).
    async deleteGlobalAppSpec(name) {
      const globalDb = await db('appsGlobal');
      await globalDb.collection('zelappsinformation').deleteOne({ name });
    },

    async seedPermanentMessage(msg) {
      const globalDb = await db('appsGlobal');
      await globalDb.collection('zelappsmessages').insertOne(msg);
    },

    // Where an app runs is a derivation over the app state event log, so seeding a
    // location means asserting the apprunning event the derivation reads. There is no
    // materialized row to write; writing one would seed a shape nothing consults.
    async seedAppLocation({ name, ip, hash, broadcastedAt, runningSince }) {
      const globalDb = await db('appsGlobal');
      const ts = broadcastedAt ?? Date.now();
      await globalDb.collection('appstateevents').insertOne({
        type: 'apprunning',
        ip,
        dedupKey: 'v2',
        broadcastedAt: new Date(ts),
        expireAt: new Date(ts + 125 * 60 * 1000),
        receivedAt: new Date(ts),
        data: {
          apps: [{ name, hash, runningSince: runningSince ?? ts }],
          ip,
          broadcastedAt: ts,
        },
      });
    },

    async seedAppStateEvent(event) {
      const globalDb = await db('appsGlobal');
      await globalDb.collection('appstateevents').insertOne(event);
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
