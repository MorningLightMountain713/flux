'use strict';

const config = require('config');

// we import this first so the caches are instantiated before any other modules
// are imported
const cacheManager = require('./utils/cacheManager').default;
const log = require('../lib/log');
const dbHelper = require('./dbHelper');
const explorerService = require('./explorerService');
const fluxCommunication = require('./fluxCommunication');
const networkStateService = require('./networkStateService');
const fluxNetworkHelper = require('./fluxNetworkHelper');
const fluxNetworkMonitor = require('./fluxNetworkMonitor');
const nodeDosState = require('./nodeDosState');
// App modular services - replacing appsService
const appInstaller = require('./appLifecycle/appInstaller');
const appUninstaller = require('./appLifecycle/appUninstaller');
const appController = require('./appManagement/appController');
const monitoringOrchestrator = require('./appMonitoring/monitoringOrchestrator');
const portManager = require('./appNetwork/portManager');
const appInspector = require('./appManagement/appInspector');
const availabilityChecker = require('./appMonitoring/availabilityChecker');
const nodeStatusMonitor = require('./appMonitoring/nodeStatusMonitor');
const peerNotification = require('./appMessaging/peerNotification');
const drainServer = require('./appMessaging/drainServer');
const syncthingMonitor = require('./appMonitoring/syncthingMonitor');
const daemonHealthMonitor = require('./appMonitoring/daemonHealthMonitor');
const containerEventBridge = require('./appMonitoring/containerEventBridge');
const appReconciler = require('./appMonitoring/appReconciler');
const appOperations = require('./appLifecycle/appOperations');
const specReconciler = require('./appLifecycle/specReconciler');
const appShutdownCoordinator = require('./appLifecycle/appShutdownCoordinator');
const appSpawner = require('./appLifecycle/appSpawner');
const registryManager = require('./appDatabase/registryManager');
const { AppSyncOrchestrator, STATES: APP_SYNC_STATES } = require('./appMessaging/appSyncOrchestrator');
const grantorController = require('./quorumGrant/grantorController');
const grantClient = require('./quorumGrant/grantClient');
const ordinalRegister = require('./quorumGrant/ordinalRegister');
const ordinalRegisterSeam = require('./appMesh/ordinalRegisterSeam');
const meshOrdinals = require('./appMesh/meshOrdinals');
const messageStore = require('./appMessaging/messageStore');
const crontabAndMountsCleanup = require('./appLifecycle/crontabAndMountsCleanup');
const appJanitor = require('./appLifecycle/appJanitor');
const meshReconciler = require('./appMesh/meshReconciler');
const foundingCommittee = require('./appMesh/foundingCommittee');
const backendTlsRenewal = require('./appLifecycle/backendTlsRenewal');
const containerMountRecovery = require('./appLifecycle/containerMountRecovery');
const fileOperationRecovery = require('./appSystem/fileOperationRecovery');
const networkRecovery = require('./appSystem/networkRecovery');
const volumeExecutor = require('./appSystem/volumeExecutor');
const appStartupManager = require('./appLifecycle/appStartupManager');
const contentSlotService = require('./appLifecycle/contentSlotService');
const hardwareValidationService = require('./appLifecycle/hardwareValidationService');
const globalState = require('./utils/globalState');
const nodeCapabilities = require('./utils/nodeCapabilities');
const { peerManager } = require('./utils/peerState');
const enterpriseNetwork = require('./utils/enterpriseNetwork');
const enterpriseConfig = require('./utils/enterpriseConfig');
const policyStore = require('./policy/policyStore');
const fluxCommunicationMessagesSender = require('./fluxCommunicationMessagesSender');
const appQueryService = require('./appQuery/appQueryService');
const chainTipSource = require('./daemonService/chainTipSource');
const daemonServiceMiscRpcs = require('./daemonService/daemonServiceMiscRpcs');
const daemonSubscriptionService = require('./daemonService/daemonSubscriptionService');
const fluxnodeStatusSource = require('./daemonService/fluxnodeStatusSource');
const daemonUsageReporter = require('./daemonService/daemonUsageReporter');
const reorgSource = require('./daemonService/reorgSource');
const daemonServiceUtils = require('./daemonService/daemonServiceUtils');
const fluxService = require('./fluxService');
const geolocationService = require('./geolocationService');
const ipLocationSync = require('./appPlacement/ipLocationSync');
const upnpService = require('./upnpService');
const syncthingService = require('./syncthingService');
const pgpService = require('./pgpService');
const dockerService = require('./dockerService');
const componentIdentifierResolver = require('./appLifecycle/componentIdentifierResolver');
const backupRestoreService = require('./backupRestoreService');
const systemService = require('./systemService');
const fluxNodeService = require('./fluxNodeService');
const volumeValidationService = require('./volumeValidationService');
const watchdogService = require('./watchdogService');
const cloudUIUpdateService = require('./cloudUIUpdateService');
const appTamperingBlocklistService = require('./appTamperingBlocklistService');
const residentialNodeDosService = require('./residentialNodeDosService');
const peerSetStabilityService = require('./peerSetStabilityService');
const nodeConfirmationService = require('./nodeConfirmationService');
const appTamperingDetectionService = require('./appTamperingDetectionService');
const appsRuntimeState = require('./appManagement/appsRuntimeState');
const imageCacheStore = require('./appLifecycle/imageCacheStore');
const appsRepository = require('./appDatabase/appsRepository');
const playgroundAudit = require('./appPlayground/playgroundAudit');
const playgroundService = require('./appPlayground/playgroundService');
const admissionControl = require('./utils/admissionControl');
const migrations = require('./migrations');
const limitCounterRecords = require('./utils/limitCounterRecords');
const imageCacheMaintenance = require('./appLifecycle/imageCacheMaintenance');
const imageReaper = require('./appLifecycle/imageReaper');
const imageUpdateService = require('./imageUpdateService');
const appsMaintenance = require('./appDatabase/appsMaintenance');
const marketplaceTemplateCache = require('./marketplace/marketplaceTemplateCache');
const telemetryIdentityService = require('./telemetryIdentityService');
const { version: fluxVersion } = require('../../../package.json');
// const throughputLogger = require('./utils/throughputLogger');

// Initialize globalState caches with cacheManager
globalState.initializeCaches(cacheManager);

const apiPort = userconfig.initial.apiport || config.server.apiport;
const development = userconfig.initial.development || false;
const fluxTransactionCollection = config.database.daemon.collections.fluxTransactions;

const { bootDelayMultiplier } = config.fluxapps;
function bootDelay(ms) { return Math.round(ms * bootDelayMultiplier); }

const {
  portRestoreIntervalMs, cpuCheckIntervalMs, imageComplianceIntervalMs, tempMsgTtlS,
  imageReaperIntervalMs, imageCacheEnabled,
} = config.fluxapps;

// State objects for monitoring services
const dosState = {
  dosMessage: null,
  get dosStateValue() { return nodeDosState.getDosStateValue(); },
  set dosStateValue(value) { nodeDosState.setDosStateValue(value); },
  testingPort: null,
  nextTestingPort: null,
  originalPortFailed: null,
  lastUPNPMapFailed: false,
};
const portsNotWorking = new Set();
const appsStorageViolations = [];

/**
 * Remove rows that duplicate a would-be-unique key, keeping the newest of each.
 *
 * A recovery strategy for ensureIndex: when a unique build fails because the
 * collection already holds rows that violate it, this makes the data conform to
 * the invariant the index DECLARES - it deletes duplicates on the key the index
 * says must be unique, which is enforcing a contract rather than losing data.
 * Only safe where the key IS the row's identity, so it is passed in per build by
 * the caller that knows the collection, never applied by default. A rollup whose
 * duplicates must be summed rather than dropped (the tampering incident count)
 * belongs to its owning service instead - see the note on ensureIndex.
 *
 * Keeps the newest per group (rows sort by _id, which is time-ordered), honours
 * the index's partialFilterExpression so it only touches rows the index covers,
 * and returns how many it removed.
 *
 * @param {object} collection - a mongo collection handle
 * @param {object} spec - the index key, e.g. { hash: 1 }
 * @param {object} options - the index options (read for partialFilterExpression)
 * @returns {Promise<number>} rows removed
 */
async function dedupeByKey(collection, spec, options = {}) {
  const groupId = {};
  Object.keys(spec).forEach((key, i) => { groupId[`k${i}`] = `$${key}`; });
  // Held in memory deliberately, and measured rather than assumed: run against a
  // live node's collection unioned with itself until every key appeared 16 times
  // - 1,030,208 rows, the duplicate state this exists to repair - it finished in
  // under 2s without spilling. The $sort adds nothing on top while it stays an
  // index walk on _id, which it is for a spec with no partialFilterExpression;
  // the first partial index to use this wants re-measuring, because the $match
  // ahead of the sort is what would make the sort blocking. allowDiskUse is not
  // set: it would take a mongo below 6.0, where the cap errors instead of
  // spilling, and the network floor is moving past that.
  //
  // ids[0] rather than $max: $group does not document that it carries a
  // preceding sort into an accumulator, and that non-guarantee is about results
  // merged from several sources - this is one standalone mongod. Checked against
  // 64,388 real duplicate groups, ids[0] was the newest in all 64,388.
  const pipeline = [
    ...(options.partialFilterExpression ? [{ $match: options.partialFilterExpression }] : []),
    { $sort: { _id: -1 } },
    { $group: { _id: groupId, ids: { $push: '$_id' } } },
    { $match: { 'ids.1': { $exists: true } } },
  ];
  const groups = await collection.aggregate(pipeline).toArray();
  const toRemove = groups.flatMap((group) => group.ids.slice(1));
  if (!toRemove.length) return 0;
  await collection.deleteMany({ _id: { $in: toRemove } });
  return toRemove.length;
}

/**
 * Assert one index, healing the failures that are recoverable.
 *
 *   - a pre-existing index with conflicting OPTIONS (IndexOptionsConflict /
 *     IndexKeySpecsConflict) is dropped by its real name and recreated;
 *   - a unique build blocked by DUPLICATE ROWS runs the caller's `recover`
 *     strategy (see dedupeByKey) and rebuilds, so the node ends up WITH the
 *     index rather than running degraded without it;
 *   - anything else rethrows.
 *
 * The rethrow is deliberate and is NOT the blanket swallow it replaced. Index
 * setup runs before any service or interval starts, so the 15s startFluxFunctions
 * retry re-runs it safely: a TRANSIENT failure (mongo mid-election, a slow-disk
 * blip) heals on the next pass instead of being skipped until the next reboot,
 * and a genuinely UNRECOVERABLE database wedges loudly - which is correct, since
 * a node whose DB cannot hold its schema cannot serve apps and appremove would
 * not rescue it. The realistic wedge that finding motivated - a unique index
 * over rows that already violate it - is repaired above, not hidden.
 *
 * TRUE NORTH: eventually every collection owns its own schema-prepare - its
 * index spec plus whatever dedupe or merge its data needs - the way
 * appsRuntimeState.prepareCollection and appTamperingDetectionService already
 * do, and boot just invokes those prepare functions. That turns this ~40-call
 * imperative block into a set of owned, individually testable units. This
 * function is the increment toward it, not the destination; a full move of the
 * remaining builds is a separate refactor, out of scope for the PR that added it.
 *
 * @param {object} collection - a mongo collection handle
 * @param {object} spec - the index key
 * @param {object} [options] - the index options
 * @param {(collection: object, spec: object, options: object) => Promise<number>} [recover]
 *   run when a unique build is blocked by existing duplicate rows
 */
async function ensureIndex(collection, spec, options = {}, recover = null) {
  try {
    await collection.createIndex(spec, options);
  } catch (err) {
    const conflict = err && (err.codeName === 'IndexOptionsConflict' || err.codeName === 'IndexKeySpecsConflict');
    if (conflict) {
      const specKeys = JSON.stringify(spec);
      const indexes = await collection.listIndexes().toArray();
      const match = indexes.find((idx) => JSON.stringify(idx.key) === specKeys);
      if (match?.name) {
        log.warn(`ensureIndex - conflicting index '${match.name}' on ${collection.collectionName} (key: ${specKeys}), dropping and recreating`);
        await collection.dropIndex(match.name);
      }
      await collection.createIndex(spec, options);
      return;
    }
    const duplicate = err && (err.code === 11000 || err.codeName === 'DuplicateKey');
    if (duplicate && recover) {
      const removed = await recover(collection, spec, options);
      log.warn(`ensureIndex - ${collection.collectionName} (key: ${JSON.stringify(spec)}) held ${removed} row(s) violating a unique index; removed and rebuilding`);
      await collection.createIndex(spec, options);
      return;
    }
    throw err;
  }
}

/**
 * Assert every index one collection needs, in a single command.
 *
 * mongo's index build protocol has a fixed cost per BUILD - register, start,
 * scan, wait for commit quorum, commit, log - and it does not care that the
 * collection is empty. A node asserting its schema one index at a time pays
 * that cost 34 times over 14 collections; createIndexes pays it once per
 * collection. A node boots faster for it, and the integration harness, where
 * ten nodes share one mongod and every database is new, feels it ten times over
 * (measured: 938 concurrent builds per ten-node fleet).
 *
 * The batch is the fast path, not the only one. ensureIndex heals two failures
 * that need to be attributed to a single index - an options conflict it drops
 * and rebuilds, and a unique build blocked by duplicate rows it repairs through
 * the caller's strategy - and a batch rejection does not say which member
 * failed. So any error falls back to asserting them one at a time, which is
 * exactly the behaviour that existed before this function.
 *
 * @param {object} collection - a mongo collection handle
 * @param {Array<object>} specs - `{ key, ...indexOptions, recover }` per index,
 *   where `recover` is ours and never reaches mongo
 */
async function ensureIndexes(collection, specs) {
  try {
    await collection.createIndexes(specs.map((spec) => {
      // `recover` is a FluxOS concern; mongo is handed the index model alone
      const model = { ...spec };
      delete model.recover;
      return model;
    }));
    return;
  } catch (error) {
    log.warn(`ensureIndexes - batch of ${specs.length} on ${collection.collectionName} failed (${error.codeName || error.message}); asserting one at a time`);
  }
  // eslint-disable-next-line no-restricted-syntax
  for (const { key, recover = null, ...options } of specs) {
    // eslint-disable-next-line no-await-in-loop
    await ensureIndex(collection, key, options, recover);
  }
}

/**
 * To start FluxOS. A series of checks are performed on port and UPnP (Universal Plug and Play) support and mapping. Database connections are established. The other relevant functions required to start FluxOS services are called.
 */
async function startFluxFunctions() {
  try {
    if (!config.server.allowedPorts.includes(+apiPort)) {
      log.error(`Flux port ${apiPort} is not supported. Shutting down.`);
      process.exit();
    }
    // Ahead of anything that might call a runtime API this NodeJS lacks. A
    // below-floor node stays up holding a sticky DOS, so /flux/info names the
    // version found and the version required.
    fluxNetworkHelper.checkNodeJsVersionAllowed();
    // Resolve the node-capability ("is-arcane") verdict up front, before any consumer
    // reads it. Awaited: on legacy the FLUX_ARCANE_NODE pre-gate returns instantly; on
    // Arcane the systemd contract guarantees fluxbenchd's RPC is up, so this settles in
    // the latch window (usually already latched by now). Depends only on the benchmark
    // channel, not the daemon/db.
    await nodeCapabilities.resolveNodeCapability();
    // De-auth hook: after each refresh that changes the enterprise owner map, drop
    // image-cache pins owned by a FluxId no longer allowed on this node. Tied to the
    // refresh (not a blind timer) because the owner list is the only input and it changes
    // only there. Enterprise-only via imageCacheEnabled; a no-op elsewhere. Registered
    // before the store starts so the boot refresh is not missed.
    if (imageCacheEnabled) {
      enterpriseConfig.onOwnerMapChange(() => imageCacheMaintenance.cleanupDeauthorizedOwners()
        .catch((err) => log.error(`imageCache - de-auth cleanup error: ${err.message}`)));
    }
    // Hard dependencies — nothing starts until these are confirmed.
    await dbHelper.waitForMongo();
    await dockerService.waitForDocker();

    // The network's enforcement documents: blocked repositories, the enterprise
    // node->owners map, the tampering blocklist and the image whitelist. Awaited so
    // consumers (identity resolution, the spawn loop, app-spec validation, image
    // verification) have data before they run; the cache read is local and each fetch is
    // capped at 10s, so boot is never stuck on this. Placed after waitForMongo because
    // last-known-good lives in the database — started earlier, a node that boots while the
    // source is unreachable would fall all the way back to the release-time seed.
    await policyStore.startSync().catch((err) => log.error(`policyStore start error: ${err.message}`));

    // Node-local state migrations, before anything reads it. pgpService and the IP
    // monitor both read what these adopt; pgpService guards itself (it reads the
    // config file directly when the database holds no identity), so this is the
    // tidy path rather than the only one.
    await migrations.runMigrations(migrations.HOOKS.DEPENDENCIES_READY);

    // Check and update CloudUI if needed (for legacy nodes without watchdog; Arcane
    // delegates to the watchdog). Detached: a UI-asset download must never gate boot —
    // nothing downstream reads it, and a slow/unreachable GitHub would stall the node.
    log.info('Checking CloudUI installation...');
    cloudUIUpdateService.checkAndUpdateCloudUI().catch((err) => log.error(`CloudUI update check failed: ${err.message}`));
    // Gated on the declared UPnP setting, not on routerIP being populated: the
    // installer records a router address on non-UPnP nodes too (the default gateway),
    // so its presence never meant the operator wanted UPnP.
    if (upnpService.isUPNP()) {
      setInterval(() => {
        // this is only used as a protection against node operators removing rules
        // on legacy nodes.
        upnpService.adjustFirewallForUPNP();
      }, (60 * 60 * 1000) + 1000); // every 60m.
      setTimeout(() => {
        portManager.callOtherNodeToKeepUpnpPortsOpen();
        setInterval(() => {
          portManager.callOtherNodeToKeepUpnpPortsOpen();
        }, 8 * 60 * 1000);
      }, 1 * 60 * 1000);
    }
    await fluxNetworkHelper.addFluxNodeServiceIpToLoopback();
    await fluxNetworkHelper.allowOnlyDockerNetworksToFluxNodeService();
    await fluxNetworkHelper.allowDockerNetworksToFluxDnsd();
    fluxNodeService.start();
    log.info('Checking docker log for corruption...');
    await dockerService.dockerLogsFix();
    await systemService.mongodGpgKeyVeryfity();
    await systemService.mongoDBConfig();
    systemService.monitorSystem();
    log.info('System service initiated');
    log.info('Preparing local database...');
    const db = dbHelper.databaseConnection();
    const database = db.db(config.database.local.database);
    await dbHelper.dropCollection(database, config.database.local.collections.loggedUsers).catch((error) => { // drop currently logged users
      if (error.message !== 'ns not found') {
        log.error(error);
      }
    });
    await dbHelper.dropCollection(database, config.database.local.collections.activeLoginPhrases).catch((error) => {
      if (error.message !== 'ns not found') {
        log.error(error);
      }
    });
    await dbHelper.dropCollection(database, config.database.local.collections.activeSignatures).catch((error) => {
      if (error.message !== 'ns not found') {
        log.error(error);
      }
    });
    // Named literally because they are no longer part of the schema: the payment
    // request and receipt collections outlived the endpoint that wrote them, and
    // a node's word was never the payment record - the chain is. Dropping is
    // idempotent, so this costs one 'ns not found' per boot once they are gone.
    await Promise.all(['activepaymentrequests', 'completedpayments'].map((orphan) => dbHelper
      .dropCollection(database, orphan).catch((error) => {
        if (error.message !== 'ns not found') {
          log.error(error);
        }
      })));
    await ensureIndexes(database.collection(config.database.local.collections.loggedUsers), [
      { key: { createdAt: 1 }, expireAfterSeconds: 14 * 24 * 60 * 60 },
    ]);
    await ensureIndexes(database.collection(config.database.local.collections.activeLoginPhrases), [
      { key: { createdAt: 1 }, expireAfterSeconds: 900 },
    ]);
    await ensureIndexes(database.collection(config.database.local.collections.activeSignatures), [
      { key: { createdAt: 1 }, expireAfterSeconds: 900 },
    ]);
    // legacy pre-incident-schema rows expire via detectedAt; current incident
    // documents expire via lastSeen. The tamper service purges pre-schema
    // rows at startup, so the detectedAt pair only matters where old code
    // still writes; drop it once the fleet is past the incident schema.
    await ensureIndexes(database.collection(config.database.local.collections.appTamperingEvents), [
      { key: { detectedAt: 1 }, expireAfterSeconds: 30 * 24 * 60 * 60, name: 'detectedAt_ttl' }, // 30 days
      { key: { appName: 1, detectedAt: -1 }, name: 'appName_detectedAt' },
      { key: { lastSeen: 1 }, expireAfterSeconds: 30 * 24 * 60 * 60, name: 'lastSeen_ttl' }, // 30 days
      { key: { appName: 1, eventType: 1, lastSeen: -1 }, name: 'appName_eventType_lastSeen' },
    ]);
    // The unique incident-rollup index lives with its owner: duplicate rollups
    // must have their counts SUMMED, not one dropped, so the merge needs the
    // collection's own knowledge rather than a generic dedupe. See
    // prepareIncidentRollup.
    await appTamperingDetectionService.prepareIncidentRollup();
    await appTamperingDetectionService.checkNodeReboot();
    // appsRuntimeState (localzelapps): merge any pre-unique-index duplicate docs,
    // then enforce one doc per component identifier
    await appsRuntimeState.prepareCollection();
    // cachedImages (localzelapps): unique index on (fluxId, repotag) so a re-submit
    // can't fork an owner's pin record, plus a repotag lookup for the retention gate
    await imageCacheStore.prepareCollection();
    // zelappsinformation (localzelapps): one row per deployed identity, unique on
    // (name, replica). The collection carried no index at all, so one-row-per-app
    // rested on a racy exists-then-insert; co-located replicas need the key anyway.
    await appsRepository.prepareInstalledAppsCollection();
    await appsRepository.backfillGlobalAppUuids().catch((error) => {
      log.error(`Deriving instance identities failed: ${error.message}`);
    });
    // Rows written before the identifier index existed. The resolver lives here
    // rather than in the repository because building a deployment needs the
    // resolved spec, and the repository must not depend on what resolves it.
    await appsRepository.backfillComponentIdentifiers(
      componentIdentifierResolver.resolveComponentIdentifiers,
    ).catch((error) => {
      log.error(`Recording component identifiers failed: ${error.message}`);
    });
    // playgroundsessions (localzelapps): the retention TTL the collection's own
    // comment promises, plus the (callerFingerprint, flagged, observedAt) index
    // the admission-path miner check reads
    await playgroundAudit.prepareCollection();
    await limitCounterRecords.prepareCollection();
    // Who gives capacity back when paid work cannot otherwise fit. Registered
    // rather than imported: admissionControl is depended on by every resource
    // check, and it must not in turn depend on whichever feature happens to hold
    // reclaimable reservations.
    admissionControl.setReclaimer(playgroundService.reclaimFor);
    // Replay any owed teardowns that survived a crash: re-condemn their components
    // (synchronously, before the reconciler starts) then drain them in the background,
    // so an interrupted removal always completes and a being-torn-down app is never
    // restarted from reconcile cycle 0.
    await appUninstaller.recoverOwedTeardowns();
    log.info('Local database prepared');
    log.info('Preparing temporary database...');
    // no need to drop temporary messages
    const databaseTemp = db.db(config.database.appsglobal.database);
    await ensureIndexes(databaseTemp.collection(config.database.appsglobal.collections.appsTemporaryMessages), [
      { key: { receivedAt: 1 }, expireAfterSeconds: tempMsgTtlS },
    ]);
    log.info('Temporary database prepared');
    log.info('Preparing Flux Apps locations');

    // ToDo: Fix all these broken database drops / index creations / removals all over the place. The prior dropIndex was removing the
    // index entirely so there was no index at all!

    // The below index is created in the Explorer Service. We need to remove all the database indexing from the Explorer Service.
    // It's not the explorer service's responsibility, and other services need these indexes before Explorer Service creates them.

    // It should be the dbService's responsibility that the db is in a state fit for use.

    // we have to create this index again here, as we need it to repair the db. As we were deleting this on every reboot (and it was only created when scannedHeight was 0)
    // Creating an index that already exists is a no-op
    await ensureIndexes(databaseTemp.collection(config.database.appsglobal.collections.appsMessages), [
      { key: { hash: 1 }, name: 'query for getting zelapp message based on hash', unique: true, recover: dedupeByKey },
      { key: { 'appSpecifications.version': 1 }, name: 'query for getting app message based on version' },
      { key: { 'appSpecifications.nodes': 1 }, name: 'query for getting app message based on nodes' },
    ]);
    // The running set is derived from the app state event log on read; the materialized
    // location collection it replaced is no longer written or read. Dropped rather than
    // left to its TTL so an upgraded node does not carry a dead collection - and its
    // per-minute TTL sweep - indefinitely. Named literally: the config key is gone, and
    // a drop of a collection that is not there is a no-op, so this self-retires.
    await databaseTemp.collection('zelappslocation').drop().catch(() => {});
    await ensureIndexes(databaseTemp.collection(config.database.appsglobal.collections.appStateEvents), [
      { key: { expireAt: 1 }, expireAfterSeconds: 0 },
      { key: { ip: 1, type: 1, dedupKey: 1 }, unique: true, recover: dedupeByKey },
      { key: { broadcastedAt: 1 } },
      { key: { createdAt: 1 } },
    ]);
    log.info('App state events collection prepared');
    await registryManager.prepareInstallingClaimsCollections();
    await databaseTemp.collection(config.database.appsglobal.collections.appsInstallingErrorsLocations).dropIndex('cachedAt_1').catch(() => {});
    await databaseTemp.collection(config.database.appsglobal.collections.appsInstallingErrorsLocations).dropIndex('broadcastedAt_1').catch(() => {});
    await ensureIndexes(databaseTemp.collection(config.database.appsglobal.collections.appsInstallingErrorsLocations), [
      { key: { expireAt: 1 }, expireAfterSeconds: 0 },
      { key: { name: 1 }, name: 'query for getting flux app install errors location based on specs name' },
      { key: { name: 1, hash: 1 }, name: 'query for getting flux app install errors location based on specs name and hash' },
      { key: { name: 1, hash: 1, ip: 1 }, name: 'query for getting flux app install errors location based on specs name and hash and node ip' },
    ]);
    log.info('App installing errors locations prepared');
    await databaseTemp.collection(config.database.appsglobal.collections.appsInstallingErrorsBroadcasts).dropIndex('broadcastedAt_1').catch(() => {});
    await ensureIndexes(databaseTemp.collection(config.database.appsglobal.collections.appsInstallingErrorsBroadcasts), [
      { key: { expireAt: 1 }, expireAfterSeconds: 0 },
      { key: { broadcastedAt: 1 } },
      { key: { 'data.name': 1, 'data.hash': 1, 'data.ip': 1 }, unique: true, recover: dedupeByKey },
    ]);
    log.info('Signed app installing errors broadcasts collection prepared');

    // Content-slot manifests: one row per app (unique appName — the atomic
    // compare-and-set guard storeManifest relies on), plus a PARTIAL TTL that
    // auto-reaps quarantined (unverified, confirmed:false) rows by their expireAt;
    // confirmed rows carry no expireAt and persist.
    await ensureIndex(databaseTemp.collection(config.database.appsglobal.collections.appContentManifests), { appName: 1 }, { name: 'appName', unique: true });
    await ensureIndex(databaseTemp.collection(config.database.appsglobal.collections.appContentManifests), { expireAt: 1 }, { expireAfterSeconds: 0, partialFilterExpression: { confirmed: false }, name: 'manifest_quarantine_ttl' });
    log.info('App content manifests collection prepared');

    // Ingress attestations: one node-signed record per (hash, node) — where a
    // register/update entered the network. The unique key makes records from
    // different ingress nodes coexist without collision or merge. The TTL reaps
    // attestations whose message never confirmed (those still carry expireAt);
    // confirmation unsets expireAt so real attributions persist.
    await ensureIndex(databaseTemp.collection(config.database.appsglobal.collections.appsIngressAttestations), { hash: 1, node: 1 }, { unique: true, name: 'ingress attestation identity' });
    await ensureIndex(databaseTemp.collection(config.database.appsglobal.collections.appsIngressAttestations), { hash: 1 }, { name: 'query ingress attestations by hash' });
    // Serves the reconcile bucket fetch and per-bucket digest recompute (confirmed members of a bucket) as an indexed lookup.
    await ensureIndex(databaseTemp.collection(config.database.appsglobal.collections.appsIngressAttestations), { bucket: 1, expireAt: 1 }, { name: 'ingress attestations by bucket' });
    await ensureIndex(databaseTemp.collection(config.database.appsglobal.collections.appsIngressAttestations), { expireAt: 1 }, { expireAfterSeconds: 0, name: 'ingress_attestation_orphan_ttl' });
    log.info('App ingress attestations collection prepared');

    // This fixes an issue where the appsMessage db has NaN for valueSat. Once db is repaired on all nodes,
    // we can remove this.
    await appsMaintenance.repairNanInAppsMessagesDb();

    // The location table this node already holds, brought back as soon as the
    // database is up. Detached and best-effort - every consumer degrades safely
    // without it. On a node that has run before this is a single marker read
    // against rows already in mongo, so the residential verdict and placement's
    // fault domains hold their table within milliseconds of boot rather than
    // behind the app-database rebuild, which neither depends on. Fetching a NEW
    // baseline is the expensive half and stays in startDbDependentServices,
    // where its two-million-row ingest cannot land on top of that rebuild.
    ipLocationSync.restoreCachedTable().catch((err) => log.error(`ipLocationSync restore error: ${err.message}`));

    // Check for apps with incorrect volume mounts (containing /flux/ path)
    log.info('Checking for apps with incorrect volume mounts...');
    // BOTH CONDITIONS, because neither implies the other. The delay is for the host
    // settling - docker, mounts, crontab - and the gate is for the policy the hard
    // redeploy it performs needs to pull an image again. This pass runs ONCE per
    // boot and has nothing that retries it, so firing it into a closed gate loses
    // the fix until the node next restarts.
    setTimeout(() => {
      globalState.waitForPolicyReady().then(() => volumeValidationService.checkAndFixIncorrectVolumeMounts()).catch((error) => {
        log.error(`Volume validation service error: ${error.message}`);
      });
    }, bootDelay(45 * 1000)); // Run after 45 seconds to allow system to stabilize

    // Validate hardware requirements and remove non-compliant apps FIRST
    log.info('Scheduling hardware validation check...');
    setTimeout(() => {
      hardwareValidationService.performBootTimeHardwareValidation().catch((error) => {
        log.error(`Hardware validation service error: ${error.message}`);
      });
    }, bootDelay(50 * 1000)); // Run at 50 seconds - BEFORE boot reconciliation

    // Migrate existing containers from 'unless-stopped'/'always' to 'no' restart policy.
    // Non-destructive — doesn't stop containers, just prevents Docker from auto-starting
    // them on future daemon restarts. FluxOS manages container startup after dbReady.
    dockerService.migrateContainerRestartPolicies();

    // Start the reconcile workqueue (the single container actuator) and the
    // Docker container event bridge that feeds it (die / start / health_status).
    // The workqueue holds all triggers until bootContainerStateSettled, then
    // drains once daemon/DB are ready.
    appReconciler.start().catch((error) => {
      log.error(`App reconciler error: ${error.message}`);
    });
    containerEventBridge.start();

    // Telemetry identity socket for flux-telemetryd (Arcane-only; self-skips
    // elsewhere). The boot reconcile in appStartupManager repopulates routing.
    telemetryIdentityService.start().catch((error) => {
      log.error(`telemetry identity service failed to start: ${error.message}`);
    });

    // Read boot context early — determines startup behavior for container management.
    const bootContext = await AppSyncOrchestrator.readBootContext();

    // App startup manager owns all boot-time container lifecycle decisions:
    // Locations expired → remove all. Otherwise wait for daemon/DB, then reconcile.
    appStartupManager.manageAppsOnBoot(bootContext).catch((error) => {
      log.error(`App startup manager error: ${error.message}`);
    });

    // Above the daemon wait, because syncthing has nothing to do with the
    // daemon: the sentinel talks to syncthing's own API and reads userconfig,
    // and the webserver is already answering. Below it, a node whose fluxd is
    // slow or dead never starts measuring syncthing at all, and a check nobody
    // is making cannot report a fault - see syncthingService's health stamps.
    syncthingService.startSyncthingSentinel();
    log.info('Syncthing service started');

    // Wait for daemon RPC — manageAppsOnBoot (above) is fire-and-forget and gates
    // on waitForDaemonReady() internally with a 5-min timeout. It must be running
    // before daemonReady is set so its timeout/removal logic can trigger.
    await daemonServiceUtils.buildFluxdClient();
    await daemonServiceMiscRpcs.waitForDaemonRpc();

    // After buildFluxdClient, which parses flux.conf — capability detection reads it
    // to decide which topics this daemon actually publishes. Consumers registered
    // their interest at require time, so the socket opens with them already attached.
    daemonSubscriptionService.start();
    reorgSource.start();

    // awaited so isDaemonSynced is populated before hash sync reads it. Takes the push
    // path where the daemon offers it, and the old 30s poll where it does not.
    await chainTipSource.start();
    globalState.daemonReady = true;

    // Initialize app sync orchestrator and spawner
    const orchestrator = new AppSyncOrchestrator({
      blockEmitter: explorerService.getBlockEmitter(),
      getEligibleSyncPeers: () => peerManager.getEligibleSyncPeers()
        .map((p) => ({ key: p.key, connectionId: p.connectionId, send: (msg) => p.send(msg) })),
      // By key, unfiltered: the reconnect pull addresses a specific peer that
      // may not be a sync candidate yet (no reported uptime at add() time).
      getPeerByKey: (key) => {
        const p = peerManager.get(key);
        return p ? { key: p.key, send: (msg) => p.send(msg) } : null;
      },
      onPeerEvent: (event, cb) => peerManager.on(event, cb),
      offPeerEvent: (event, cb) => peerManager.removeListener(event, cb),
      peerCountIfAboveThreshold: () => peerManager.peerCountIfAboveThreshold(),
      markSyncRequested: (key) => peerManager.markSyncRequested(key),
      clearSyncRequested: () => peerManager.clearSyncRequested(),
      completeSyncRequest: (key) => peerManager.completeSyncRequest(key),
      isEnterprise: () => enterpriseNetwork.getCachedEnterpriseIdentity(),
      networkStateReady: () => networkStateService.waitStarted(),
      // The steady-state manifest refresh's apply half: catch up any running container whose
      // register advanced (a silently-missed update) to what it should be serving.
      catchUpRunningContent: () => contentSlotService.applyBehindContentApps(),
      fluxVersion,
    });
    // Whether an arriving sync response is still wanted. The record of what this
    // node asked for is the peer manager's own asked-peers ledger, written by the
    // orchestrator through markSyncRequested and cleared by completeSyncRequest, so
    // that is what the question is answered from.
    //
    // REBASE-ADAPTER (D12): development answers this from the orchestrator, per
    // CONNECTION - a peer that reconnects keeps its ip:port while becoming a
    // different connection, and nothing arriving on the new one answers a request
    // written into the old one. That rule belongs to #1797's orchestrator, which is
    // not the one this branch runs; until D12 ports it, the answer is keyed by
    // ip:port like every other v9 caller of the ledger. Replace this line when D12
    // lands, not before.
    peerManager.syncResponseWanted = (peerSocket) => peerManager.isSyncRequested(peerSocket.key);

    // The other half of the peer-gated fallback. The orchestrator stops a node
    // whose peer set keeps collapsing from ever reaching READY, which is silent;
    // this says so, and puts a node that does it repeatedly out of service. Same
    // two edges, read for a different purpose, so it subscribes for itself
    // rather than being another of the orchestrator's jobs.
    peerSetStabilityService.start({
      onPeerEvent: (event, cb) => peerManager.on(event, cb),
      offPeerEvent: (event, cb) => peerManager.removeListener(event, cb),
      isAboveThreshold: () => peerManager.isAboveThreshold(),
    });

    // Network policy, started here rather than at the top of boot because it needs both of
    // the things that only exist by now: mongo, to restore and re-verify the bundle this
    // node last held, and peers, to ask for anything newer. Its old position could reach
    // neither, which is why it could only ever fetch from github.
    //
    // Not awaited. Boot does not wait on policy and never did: the node comes up, serves its
    // API and keeps its containers running regardless. What waits is acquisition, through
    // globalState.policyReady, which is the one decision that must not be made on a guess.
    policyStore.setPeerTransport({
      // The peers worth asking. One that does not advertise the capability has no handler
      // for the ask, so including it would buy a deadline's wait and an unrecognised-type
      // warning in its log.
      capableKeys: () => peerManager.getPolicyCapablePeers().map((peer) => peer.key),
      // The only ask. A key that no longer resolves is a peer that left between connecting
      // and being asked, which is not an error.
      requestFrom: (key, seq, correlationId) => {
        const peer = peerManager.get(key);
        if (!peer) return Promise.resolve();
        return fluxCommunicationMessagesSender.requestPolicyFromPeer(peer, seq, correlationId);
      },
      announce: (seq) => fluxCommunicationMessagesSender.announcePolicySeq(seq),
      // The latched level: peerManager already defines "enough peers to gossip with" with
      // hysteresis (appSyncPeerThreshold 12 up, appSyncDegradedThreshold 4 down). A late
      // subscriber cannot see the edge it missed, which is what this accessor exists for -
      // and reading the level rather than keeping an edge of our own is why nothing here
      // needs re-arming when a peer set collapses and rebuilds.
      aboveThreshold: () => peerManager.isAboveThreshold(),
    });
    // Discovery has not started yet - it is fifty lines below - so the peer set is empty at
    // this point on every node, always. Nothing here asks peers or the source; both are
    // driven by the two subscriptions that follow, which is what makes peers-first true at
    // boot rather than only at the 24-hour tick. It is the whole difference between a node
    // that boots while github is down getting policy from the neighbour beside it and
    // getting none for a day.
    //
    // PER JOIN for the ASK. peerThresholdReached fires when the count first crosses
    // appSyncPeerThreshold and then never again unless the set has since fallen below
    // appSyncDegradedThreshold, so as a prompt to ask peers it is the wrong signal: a node
    // asks once, its peers have nothing either, and when one of them later obtains a bundle
    // nothing tells this node to ask again - its peer set never collapsed, so the edge never
    // re-arms. Measured on a three-node fleet: node 1 asked at 08:16:09, node 0 adopted at
    // 08:16:54, and node 1 held nothing thereafter. Every join re-arms the ask, and the join
    // that crosses the threshold is one of them.
    //
    // The key is the whole point: notePeerAvailable asks THAT peer and never the source.
    // A broadcast would have to be rationed, and a rationed ask cannot serve a node that is
    // merely behind.
    //
    // The orchestrator next door draws the same distinction for its sync pool, and for the
    // same reason: a latched edge says nothing about a pool that has changed since it fired.
    peerManager.on('peerConnected', (key) => policyStore.notePeerAvailable(key));
    // Both edges, because the store's decision is about the peer SET. A peer leaving takes
    // its answer with it, and a node waiting on one that has gone waits out a deadline for an
    // answer that cannot come.
    peerManager.on('peerDisconnected', (key) => policyStore.notePeerGone(key));
    // AND the threshold itself, which is written one line after the arrival that crosses it.
    // Without this the crossing arrival decides while the level still reads false, and a set
    // that stops exactly at the threshold has nothing left to re-trigger the decision.
    peerManager.on('peerThresholdReached', () => policyStore.noteThresholdReached());
    policyStore.start().catch((err) => log.error(`policyStore start error: ${err.message}`));
    nodeConfirmationService.onMessageCapabilityChange((capable) => orchestrator.onMessageCapabilityChange(capable));
    // A grantor referees from the records this orchestrator's sync delivers,
    // so it refuses to referee until the orchestrator is READY — the live
    // level, read per ask; fail-closed until this line runs.
    grantorController.registerSyncReadyProvider(() => orchestrator.state === APP_SYNC_STATES.READY);
    // A standing generation record ends the world a held term was granted
    // in; the holder hears it from the store the moment the record lands.
    messageStore.onGrantGenerationRecord(grantClient.noteGenerationRecord);
    // The mesh's ordinals are write-once grants on the founding committee;
    // the plane registers into the mesh's seam here, and until it does every
    // ordinal answer is the closed one.
    ordinalRegisterSeam.registerProvider(ordinalRegister.provider());
    // A delisted holder resolves to nobody: the seats this cell records whose
    // holders are not on the current list start their grace now (a reboot
    // must not read a long-gone holder as present), and a node back on the
    // list re-probes its own seats before trusting them — another node may
    // have founded on them while it was off the list. The confirmation
    // service's direct listener is the production hook; the bus is the
    // harness's.
    grantorController.seedDelistedHolders().catch((error) => log.warn(`delisted-holder sweep failed: ${error.message}`));
    nodeConfirmationService.onMessageCapabilityChange((capable) => {
      if (capable) meshOrdinals.noteReturnFromUnreachability();
    });
    peerNotification.initialize();
    // Serve the flux-shutdownd drain socket (Arcane-only, best-effort).
    drainServer.start();
    appSpawner.initialize();
    appInstaller.setOnInstallComplete(() => peerNotification.checkAndNotifyPeersOfRunningApps());
    // a removed component's in-memory controller verdict dies with it - a
    // reinstalled g:/r: app must await a fresh election, not inherit a stale one
    appUninstaller.setOnComponentRemoved((id) => appReconciler.forgetDesiredState(id));
    // the node's address moved, so every app that survived it has to come up on
    // the new one - asked for durably here rather than driven from the network
    // layer, which sits underneath the reconciler and cannot require it
    fluxNetworkMonitor.setOnAddressChanged((apps, reason) => appReconciler.requestRestartOf(apps, reason));
    // route the reconciler's graceful stop-but-keep through flux-shutdownd on Arcane;
    // returns false off Arcane (or when the daemon is unavailable) so it stops locally
    appReconciler.setRequestGracefulStop((id, reason) => appShutdownCoordinator.requestGracefulStop(id, reason));
    // A committed spec fans out to both reactors: the spawner wakes when the
    // spec is one this node must INSTALL (self-gated to contention-free pinned
    // cases), and the spec reconciler converges an app this node already RUNS
    // (adoption is staggered inside it, removal acts promptly). Everything else
    // rides the per-block convergence pass.
    registryManager.setOnSpecStored((specDoc) => {
      appSpawner.notifySpecStored(specDoc);
      specReconciler.notifySpecStored(specDoc);
    });
    log.info('App Spawner initialized');

    fluxNetworkHelper.adjustFirewall();
    log.info('Firewalls checked');
    fluxNetworkHelper.allowNodeToBindPrivilegedPorts();
    log.info('Node allowed to bind privileged ports');
    fluxCommunication.keepConnectionsAlive();
    log.info('Connections polling prepared');
    fluxNetworkHelper.initClockOffsetCache();
    log.info('Clock offset cache initialized');
    // Remove existing watchtower container (replaced by native image update service)
    imageUpdateService.removeWatchtowerContainer();
    // Start native image update service (delayed start)
    // A check that lands before the policy gate opens refuses, and the next one is
    // six hours away - so the app runs on the image it has for that long over a
    // window measured in minutes. The interval is the fallback; the gate is when
    // the first check is actually able to do its work.
    setTimeout(() => {
      globalState.waitForPolicyReady().then(() => {
        imageUpdateService.startImageUpdateService();
        log.info('Native image update service started');
      }).catch((error) => log.error(`Image update service start error: ${error.message}`));
    }, bootDelay(10 * 60 * 1000)); // 10 minutes after startup
    fluxNetworkMonitor.checkDeterministicNodesCollisions();
    // STARTED ON THE POLICY, NOT ON BOOT. The blocklist this enforces is a document in the
    // signed bundle, and the bundle is not resolved by the time this line runs. Started
    // here, its first tick reads nothing - and reading nothing is correctly refused rather
    // than taken for an empty list, because an unreadable blocklist releasing a node the
    // network deliberately DOSed is the failure that contract was written for. What it
    // costs is the interval: the next tick is twelve hours away and nothing brings it
    // forward, so a node on the blocklist goes unenforced for twelve hours per restart.
    globalState.waitForPolicyReady()
      .then(() => appTamperingBlocklistService.start({ blockEmitter: explorerService.getBlockEmitter() }))
      .catch((err) => log.error(`appTamperingBlocklist start error: ${err.message}`));
    // Not awaited, and started ahead of setNodeGeolocation below on purpose: the
    // first tick reads geolocation from the db when there is one, and otherwise
    // decides nothing and retries until the lookup this boot has landed.
    //
    // Injected the same way nodeStatusMonitor is, and for the same reason: the
    // app list is read from a query service deep enough in the lifecycle graph
    // that requiring it here would put geolocation and the network helper on
    // that load path. Removing the app is not this service's job - the single
    // give-up-an-app pass in appOperations does that.
    residentialNodeDosService.start({
      installedAppsFn: appQueryService.installedApps,
    }).catch((err) => {
      log.error(`residentialNodeDos start error: ${err.message}`);
    });
    log.info('Flux checks operational');
    fluxCommunication.initializeDiscovery();
    await fluxnodeStatusSource.start();
    daemonUsageReporter.start();
    if (config.fluxapps.discoveryAutostart !== false) {
      fluxCommunication.startDiscovery();
      log.info('Flux Discovery started');
    }
    // Mount every installed app's data volume (derived from the installed-apps
    // DB) and drop the superseded legacy @reboot remount crontab entries
    log.info('crontab and mounts cleanup...');
    await crontabAndMountsCleanup.cleanupCrontabAndMounts().catch((error) => {
      log.error(`Crontab and mounts cleanup service error: ${error.message}`);
    });
    // Perform container mount recovery - restart containers that started before their mounts were created
    log.info('Container mount recovery check...');
    await containerMountRecovery.performContainerMountRecovery().catch((error) => {
      log.error(`Container mount recovery service error: ${error.message}`);
    });
    // A file operation's container is detached from the process that started
    // it, so a FluxOS restart leaves one running with nobody waiting for its
    // result, and its staging directory on the volume. The recovery below
    // reclaims both, after the volumes above are mounted, since it reads them.
    //
    // The fetch starts early so the image is in hand before the first file
    // operation arrives, rather than being pulled while an owner waits on a
    // request. The recovery does not depend on it: that is a host rm over names
    // readdir returned, and runs on a node that can reach nothing.
    //
    // Not awaited: the node takes the image at its own place in a window, so
    // the fleet ends up holding it without every node fetching at the same
    // moment. A node that cannot reach the registry takes it from one that did,
    // which only works if they have it.
    volumeExecutor.startImagePrefetch();

    log.info('Reclaiming interrupted file operations...');
    await fileOperationRecovery.recoverInterruptedFileOperations().catch((error) => {
      log.error(`File operation recovery error: ${error.message}`);
    });

    // At boot, before anything installs: an app network is created per app and
    // removed only by the uninstaller, so an uninstall interrupted between the
    // container going and the network going leaves one behind for ever. Each
    // holds an octet that getFreeFluxAppNetworkOctet cannot hand out again, and
    // when the last of 255 is gone nothing can be installed on the node.
    //
    // Here rather than on a schedule because a sweep must not meet an install
    // in progress: at boot the expected names are simply what the database
    // holds, with no window in which an app has a network and no record yet.
    await networkRecovery.reclaimOrphanedAppNetworks();
    // Awaited: generating an identity rewrites config/userconfig.js, and that
    // write is not atomic - a reload landing inside it leaves the process with
    // no userconfig.initial at all. A node that already has an identity returns
    // from here immediately, so this costs the fleet nothing.
    await pgpService.generateIdentity();
    log.info('PGP service initiated');
    // Ensure watchdog is installed and running on legacy OS (non-ArcaneOS) nodes
    watchdogService.ensureWatchdogRunning().catch((error) => {
      log.error(`Watchdog service error: ${error.message}`);
    });
    log.info('Watchdog service check initiated');
    const explorerDatabase = db.db(config.database.daemon.database);
    await dbHelper.dropCollection(explorerDatabase, fluxTransactionCollection).catch((error) => {
      if (error.message !== 'ns not found') {
        log.error(error);
      }
    });
    log.info('Mongodb zelnodetransactions dropped');

    networkStateService.start(
      { stateEmitter: explorerService.getBlockEmitter() },
    );
    cacheManager.logCacheSizesEvery(600_000);
    fluxCommunication.logSocketsEvery(600_000);

    // Uncomment for network interface debug traffic stats. Will move this
    // to part of the 'debug' setting in a future pull (and auto fetch the interface)

    // const throughput = new throughputLogger.ThroughputLogger(
    //   (result) => console.log(result),
    //   { intervalMs: 60_000, matchInterfaces: ['ens18'] },
    // );

    // await throughput.start();

    setTimeout(async () => {
      const fluxNetworkInterfaces = await dockerService.getFluxDockerNetworkPhysicalInterfaceNames();
      await fluxNetworkHelper.removeDockerContainerAccessToNonRoutable(fluxNetworkInterfaces);
      log.info('Rechecking firewall app rules');
      await fluxNetworkHelper.purgeUFW();
    }, bootDelay(30 * 1000));
    setTimeout(() => {
      appController.stopAllNonFluxRunningApps();
      // Best effort during boot — the reconciler starts monitoring per app as it settles.
      monitoringOrchestrator.startMonitoringOfApps(null).catch((error) => log.error(error));
      portManager.restoreAppsPortsSupport();
    }, bootDelay(1 * 60 * 1000));
    // Resolve this node's enterprise identity once, up front. The key comes off disk and
    // policy arrives on an event, so this settles at boot rather than on a timer; the
    // interval is the fallback for a config that cannot be read at all. Once cached, hot
    // paths (spawn loop) read it synchronously via getCachedEnterpriseIdentity() with no
    // network call and no throws.
    const identityReady = enterpriseNetwork.scheduleIdentityResolution();

    // Image-cache boot bookkeeping needs the DB rebuilt (records live in
    // localzelapps) and the identity resolved (cleanupDeauthorizedOwners reads
    // the allowed-owner list, null until then). A separate block (not nested in
    // startDbDependentServices) so this pure DB-record bookkeeping runs
    // concurrently with — not behind — that function's heavy app work.
    const runImageCacheBootMaintenance = async () => {
      await globalState.waitForDbReady();
      await identityReady;
      await imageCacheMaintenance.runBootReconcile();
    };
    if (imageCacheEnabled) {
      runImageCacheBootMaintenance().catch((err) => log.error(`imageCache - boot maintenance error: ${err.message}`));
    }

    // Services that read from zelappsinformation wait for the orchestrator
    // to finish rebuilding it rather than guessing a setTimeout delay.
    const startDbDependentServices = async () => {
      await globalState.waitForDbReady();
      log.info('DB ready - starting db-dependent services');
      // Interim until policyStore supersedes it at the userconfig rebase (see the
      // module header): keep the iplocation table fresh. The cached copy is
      // already back - restoreCachedTable ran with the schema prep above - so
      // what starts here is the fetch loop, whose ingest is the half worth
      // keeping clear of the rebuild that just finished. Detached; placement
      // degrades to /16 arithmetic without a table.
      ipLocationSync.startSync().catch((err) => log.error(`ipLocationSync start error: ${err.message}`));
      // Warm the marketplace template cache (best-effort; cache-miss fetch covers any gaps).
      marketplaceTemplateCache.bootstrapCache().catch((error) => log.error(error));
      specReconciler.requestFullConvergence({ reason: 'boot', includeCompliance: true });
      // Backstop the flux-shutdownd plan store against anything missed while
      // fluxos was down (Arcane-only, best-effort).
      appOperations.shutdownPlanResync().catch((error) => log.error(error));
      await identityReady;
      try {
        await enterpriseNetwork.cleanupOwnershipViolations();
        log.info('Enterprise network cleanup completed');
      } catch (error) {
        log.error(`Enterprise network cleanup failed: ${error.message || error}`);
      }
      setInterval(() => {
        portManager.restorePortsSupport();
      }, portRestoreIntervalMs);
    };
    startDbDependentServices();
    log.info('Starting setting Node Geolocation');
    geolocationService.setNodeGeolocation();
    setTimeout(() => {
      const { daemon: { zmqport } } = config;
      log.info(`Ensuring zmq is enabled for fluxd on port: ${zmqport}`);
      try {
        systemService.enableFluxdZmq(`tcp://127.0.0.1:${zmqport}`);
      } catch (err) {
        log.error(err);
      }
    }, bootDelay(20 * 60 * 1000));
    // Deliberately not awaited — boot carries on while the chain scan starts.
    // Safe to leave unhandled: initiateBlockProcessor does not reject.
    explorerService.initiateBlockProcessor({ restoreDatabase: true, deepRestore: true });
    log.info('Flux Block Processing Service started');
    setTimeout(() => {
      appInspector.checkApplicationsCpuUSage(globalState.appsMonitored, appQueryService.installedApps);
      setInterval(() => {
        appInspector.checkApplicationsCpuUSage(globalState.appsMonitored, appQueryService.installedApps);
      }, cpuCheckIntervalMs);
    }, bootDelay(cpuCheckIntervalMs));
    setTimeout(() => {
      // appsService.checkForNonAllowedAppsOnLocalNetwork();
      availabilityChecker.checkMyAppsAvailability(
        dosState,
        portsNotWorking,
        portManager.failedNodesTestPortsCache,
      );
    }, bootDelay(3 * 60 * 1000));
    nodeStatusMonitor.initialize(appQueryService.installedApps);
    setTimeout(() => {
      nodeStatusMonitor.monitorNodeStatus(appQueryService.installedApps);
    }, bootDelay(1.5 * 60 * 1000));
    // Start the syncthing/masterSlave deciders once boot container state has settled
    // (the same AsyncGate the reconciler starts on), not after a fixed delay. Each
    // decider self-gates per cycle on its own prerequisites (mounts, syncthing health,
    // own-IP, FDM), so an early start is safe - it skips and retries until ready.
    globalState.waitForBootContainerStateSettled().then(() => {
      // The syncthing decider is declare-only: it writes desired run-state and
      // data-state (via appReconciler) and enqueues; the reconciler is the sole
      // actuator that stops, starts, and wipes - inside its per-key single-flight,
      // so a start can never race a data wipe.
      syncthingMonitor.syncthingApps(
        globalState,
        () => globalState,
      ); // rechecks syncthing configuration each cycle
      appOperations.startActiveStandbyCoordinator();
      setTimeout(() => {
        appInspector.monitorSharedDBApps();
      }, 60 * 1000);
    });
    // Hash sync and spawner startup are now managed by the AppSyncOrchestrator (event-driven)
    orchestrator.start(bootContext);
    log.info('AppSyncOrchestrator started');
    setInterval(async () => {
      // A deep convergence pass carries the image-compliance step (it needs
      // full deployment views, so the per-block pass skips it).
      await specReconciler.requestFullConvergence({ reason: 'blocklist', includeCompliance: true });
      // Orphan hook: the compliance step is the main out-of-band remover of a pinned image
      // (a blacklisted one), so reconcile cache records against docker right after it runs.
      if (imageCacheEnabled) {
        await imageCacheMaintenance.reconcileOrphanedRecords()
          .catch((err) => log.error(`imageCache - orphan reconcile error: ${err.message}`));
      }
    }, imageComplianceIntervalMs);
    // Cold-image reaper (ALL nodes — deliberately NOT gated on imageCacheEnabled): reclaim
    // unused tagged images. Delayed first run so docker has loaded its container objects, then
    // daily. Also triggered at the end of every image update (imageUpdateService).
    setTimeout(() => {
      imageReaper.pruneUnusedImages().catch((err) => log.error(`imageReaper boot run error: ${err.message}`));
      setInterval(() => {
        imageReaper.pruneUnusedImages().catch((err) => log.error(`imageReaper error: ${err.message}`));
      }, imageReaperIntervalMs);
    }, bootDelay(10 * 60 * 1000));
    appJanitor.start();
    // The mesh sweep: membership, certificates (aged-replacement promotion
    // rides it), the impersonation detector. Dormant on a node running no
    // mesh app.
    meshReconciler.start();
    // The founder flip evaluator: tracks sustained committee rot per world
    // and photographs the new basis at its grid height (8.5). Dormant on a
    // fleet with standing committees.
    foundingCommittee.startFlipEvaluator();
    // Re-issue managed backend-TLS leaves before their 30-day life runs out
    // (dormant on a node running no verify:required app).
    backendTlsRenewal.start();
    setTimeout(() => {
      daemonHealthMonitor.checkDaemonHealthAndCleanup();
      setInterval(() => {
        daemonHealthMonitor.checkDaemonHealthAndCleanup();
      }, bootDelay(15 * 60 * 1000));
    }, bootDelay(5 * 60 * 1000));
    // Gated for the same reason as the image updater: this pass redeploys on a
    // storage violation, and one that runs before policy refuses and re-arms
    // thirty minutes out. It re-arms itself from then on, so only the first run
    // needs the gate.
    setTimeout(() => {
      globalState.waitForPolicyReady().then(() => appInspector.enforceWritableLayerLimit(
        appsStorageViolations,
      )).catch((error) => log.error(`Storage space check error: ${error.message}`));
    }, bootDelay(20 * 60 * 1000));
    setInterval(() => {
      backupRestoreService.cleanLocalBackup();
    }, bootDelay(25 * 60 * 1000));
    if (development) { // just on development branch
      setInterval(async () => {
        await fluxService.enterDevelopment().catch((error) => log.error(error));
        if (development === true || development === 'true' || development === 1 || development === '1') { // in other cases pause git pull
          setTimeout(async () => {
            await fluxService.softUpdateFlux().catch((error) => log.error(error));
          }, 15 * 1000);
        }
      }, 20 * 60 * 1000); // every 20 minutes
    }
  } catch (e) {
    log.error(e);
    setTimeout(() => {
      startFluxFunctions();
    }, 15000);
  }
}

module.exports = {
  startFluxFunctions,
  ensureIndex,
  ensureIndexes,
  dedupeByKey,
};
