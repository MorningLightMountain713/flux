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
const { AppSyncOrchestrator } = require('./appMessaging/appSyncOrchestrator');
const crontabAndMountsCleanup = require('./appLifecycle/crontabAndMountsCleanup');
const appJanitor = require('./appLifecycle/appJanitor');
const backendTlsRenewal = require('./appLifecycle/backendTlsRenewal');
const containerMountRecovery = require('./appLifecycle/containerMountRecovery');
const appStartupManager = require('./appLifecycle/appStartupManager');
const contentSlotService = require('./appLifecycle/contentSlotService');
const hardwareValidationService = require('./appLifecycle/hardwareValidationService');
const globalState = require('./utils/globalState');
const nodeCapabilities = require('./utils/nodeCapabilities');
const { peerManager } = require('./utils/peerState');
const enterpriseNetwork = require('./utils/enterpriseNetwork');
const enterpriseConfig = require('./utils/enterpriseConfig');
const policyStore = require('./policy/policyStore');
const ipLocationTable = require('./appPlacement/ipLocationTable');
const appQueryService = require('./appQuery/appQueryService');
const daemonServiceMiscRpcs = require('./daemonService/daemonServiceMiscRpcs');
const daemonServiceUtils = require('./daemonService/daemonServiceUtils');
const fluxService = require('./fluxService');
const geolocationService = require('./geolocationService');
const upnpService = require('./upnpService');
const syncthingService = require('./syncthingService');
const pgpService = require('./pgpService');
const dockerService = require('./dockerService');
const backupRestoreService = require('./backupRestoreService');
const systemService = require('./systemService');
const fluxNodeService = require('./fluxNodeService');
const volumeValidationService = require('./volumeValidationService');
const watchdogService = require('./watchdogService');
const cloudUIUpdateService = require('./cloudUIUpdateService');
const appTamperingBlocklistService = require('./appTamperingBlocklistService');
const nodeConfirmationService = require('./nodeConfirmationService');
const appTamperingDetectionService = require('./appTamperingDetectionService');
const appsRuntimeState = require('./appManagement/appsRuntimeState');
const imageCacheStore = require('./appLifecycle/imageCacheStore');
const appsRepository = require('./appDatabase/appsRepository');
const deploymentProvider = require('./appRuntime/deploymentProvider');
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
  dosMountMessage: null,
  dosDuplicateAppMessage: null,
  get dosStateValue() { return nodeDosState.getDosStateValue(); },
  set dosStateValue(value) { nodeDosState.setDosStateValue(value); },
  testingPort: null,
  nextTestingPort: null,
  originalPortFailed: null,
  lastUPNPMapFailed: false,
};
const portsNotWorking = new Set();
const appsStorageViolations = [];

const { ensureIndex } = dbHelper;

/**
 * To start FluxOS. A series of checks are performed on port and UPnP (Universal Plug and Play) support and mapping. Database connections are established. The other relevant functions required to start FluxOS services are called.
 */
async function startFluxFunctions() {
  try {
    if (!config.server.allowedPorts.includes(+apiPort)) {
      log.error(`Flux port ${apiPort} is not supported. Shutting down.`);
      process.exit();
    }
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

    // The iplocation artifact's receiver, registered before startSync so the
    // store's restore of the cached copy has somewhere to go. A malformed
    // artifact must throw out of setArtifact so the store rejects it and keeps
    // the previous copy - no try/catch.
    policyStore.onArtifact('ipLocationTable', (bytes) => ipLocationTable.setArtifact(bytes));
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
    await ensureIndex(database.collection(config.database.local.collections.loggedUsers), { createdAt: 1 }, { expireAfterSeconds: 14 * 24 * 60 * 60 });
    await ensureIndex(database.collection(config.database.local.collections.activeLoginPhrases), { createdAt: 1 }, { expireAfterSeconds: 900 });
    await ensureIndex(database.collection(config.database.local.collections.activeSignatures), { createdAt: 1 }, { expireAfterSeconds: 900 });
    await ensureIndex(database.collection(config.database.local.collections.activePaymentRequests), { createdAt: 1 }, { expireAfterSeconds: 3600 });
    await ensureIndex(database.collection(config.database.local.collections.completedPayments), { paymentId: 1 });
    await ensureIndex(database.collection(config.database.local.collections.completedPayments), { createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });
    // legacy pre-incident-schema rows expire via detectedAt; current incident
    // documents expire via lastSeen. The tamper service purges pre-schema
    // rows at startup, so the detectedAt pair only matters where old code
    // still writes; drop it once the fleet is past the incident schema.
    await ensureIndex(
      database.collection(config.database.local.collections.appTamperingEvents),
      { detectedAt: 1 },
      { expireAfterSeconds: 30 * 24 * 60 * 60, name: 'detectedAt_ttl' }, // 30 days
    );
    await ensureIndex(
      database.collection(config.database.local.collections.appTamperingEvents),
      { appName: 1, detectedAt: -1 },
      { name: 'appName_detectedAt' },
    );
    await ensureIndex(
      database.collection(config.database.local.collections.appTamperingEvents),
      { lastSeen: 1 },
      { expireAfterSeconds: 30 * 24 * 60 * 60, name: 'lastSeen_ttl' }, // 30 days
    );
    // upsert key of the incident rollup; unique so concurrent recorders
    // cannot double-insert an incident. Partial: legacy rows lack incidentKey
    // and would otherwise collide on null.
    await ensureIndex(
      database.collection(config.database.local.collections.appTamperingEvents),
      { appName: 1, eventType: 1, incidentKey: 1 },
      { unique: true, partialFilterExpression: { incidentKey: { $exists: true } }, name: 'incident_upsert' },
    );
    await ensureIndex(
      database.collection(config.database.local.collections.appTamperingEvents),
      { appName: 1, eventType: 1, lastSeen: -1 },
      { name: 'appName_eventType_lastSeen' },
    );
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
    await appsRepository.backfillComponentIdentifiers(async (name, replica) => {
      const installed = await appsRepository.getInstalledApp(name);
      if (!installed) return null;
      const deployment = await deploymentProvider.buildDeployment(installed, { replica });
      return deployment ? deployment.componentEntries().map(([, comp]) => comp.identifier) : null;
    }).catch((error) => {
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
    await ensureIndex(databaseTemp.collection(config.database.appsglobal.collections.appsTemporaryMessages), { receivedAt: 1 }, { expireAfterSeconds: tempMsgTtlS });
    log.info('Temporary database prepared');
    log.info('Preparing Flux Apps locations');

    // ToDo: Fix all these broken database drops / index creations / removals all over the place. The prior dropIndex was removing the
    // index entirely so there was no index at all!

    // The below index is created in the Explorer Service. We need to remove all the database indexing from the Explorer Service.
    // It's not the explorer service's responsibility, and other services need these indexes before Explorer Service creates them.

    // It should be the dbService's responsibility that the db is in a state fit for use.

    // we have to create this index again here, as we need it to repair the db. As we were deleting this on every reboot (and it was only created when scannedHeight was 0)
    // Creating an index that already exists is a no-op
    await ensureIndex(databaseTemp.collection(config.database.appsglobal.collections.appsMessages), { hash: 1 }, { name: 'query for getting zelapp message based on hash', unique: true });
    await ensureIndex(databaseTemp.collection(config.database.appsglobal.collections.appsMessages), { 'appSpecifications.version': 1 }, { name: 'query for getting app message based on version' });
    await ensureIndex(databaseTemp.collection(config.database.appsglobal.collections.appsMessages), { 'appSpecifications.nodes': 1 }, { name: 'query for getting app message based on nodes' });
    // The running set is derived from the app state event log on read; the materialized
    // location collection it replaced is no longer written or read. Dropped rather than
    // left to its TTL so an upgraded node does not carry a dead collection - and its
    // per-minute TTL sweep - indefinitely. Named literally: the config key is gone, and
    // a drop of a collection that is not there is a no-op, so this self-retires.
    await databaseTemp.collection('zelappslocation').drop().catch(() => {});
    await ensureIndex(databaseTemp.collection(config.database.appsglobal.collections.appStateEvents), { expireAt: 1 }, { expireAfterSeconds: 0 });
    await ensureIndex(databaseTemp.collection(config.database.appsglobal.collections.appStateEvents), { ip: 1, type: 1, dedupKey: 1 }, { unique: true });
    await ensureIndex(databaseTemp.collection(config.database.appsglobal.collections.appStateEvents), { broadcastedAt: 1 });
    await ensureIndex(databaseTemp.collection(config.database.appsglobal.collections.appStateEvents), { createdAt: 1 });
    log.info('App state events collection prepared');
    await registryManager.prepareInstallingClaimsCollections();
    await databaseTemp.collection(config.database.appsglobal.collections.appsInstallingErrorsLocations).dropIndex('cachedAt_1').catch(() => {});
    await databaseTemp.collection(config.database.appsglobal.collections.appsInstallingErrorsLocations).dropIndex('broadcastedAt_1').catch(() => {});
    await ensureIndex(databaseTemp.collection(config.database.appsglobal.collections.appsInstallingErrorsLocations), { expireAt: 1 }, { expireAfterSeconds: 0 });
    await ensureIndex(databaseTemp.collection(config.database.appsglobal.collections.appsInstallingErrorsLocations), { name: 1 }, { name: 'query for getting flux app install errors location based on specs name' });
    await ensureIndex(databaseTemp.collection(config.database.appsglobal.collections.appsInstallingErrorsLocations), { name: 1, hash: 1 }, { name: 'query for getting flux app install errors location based on specs name and hash' });
    await ensureIndex(databaseTemp.collection(config.database.appsglobal.collections.appsInstallingErrorsLocations), { name: 1, hash: 1, ip: 1 }, { name: 'query for getting flux app install errors location based on specs name and hash and node ip' });
    log.info('App installing errors locations prepared');
    await databaseTemp.collection(config.database.appsglobal.collections.appsInstallingErrorsBroadcasts).dropIndex('broadcastedAt_1').catch(() => {});
    await ensureIndex(databaseTemp.collection(config.database.appsglobal.collections.appsInstallingErrorsBroadcasts), { expireAt: 1 }, { expireAfterSeconds: 0 });
    await ensureIndex(databaseTemp.collection(config.database.appsglobal.collections.appsInstallingErrorsBroadcasts), { broadcastedAt: 1 });
    await ensureIndex(databaseTemp.collection(config.database.appsglobal.collections.appsInstallingErrorsBroadcasts), { 'data.name': 1, 'data.hash': 1, 'data.ip': 1 }, { unique: true });
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

    // Check for apps with incorrect volume mounts (containing /flux/ path)
    log.info('Checking for apps with incorrect volume mounts...');
    setTimeout(() => {
      volumeValidationService.checkAndFixIncorrectVolumeMounts().catch((error) => {
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

    // Wait for daemon RPC — manageAppsOnBoot (above) is fire-and-forget and gates
    // on waitForDaemonReady() internally with a 5-min timeout. It must be running
    // before daemonReady is set so its timeout/removal logic can trigger.
    await daemonServiceUtils.buildFluxdClient();
    await daemonServiceMiscRpcs.waitForDaemonRpc();
    // awaited so isDaemonSynced cache is populated before hash sync reads it
    await daemonServiceMiscRpcs.daemonBlockchainInfoService();
    globalState.daemonReady = true;

    // Initialize app sync orchestrator and spawner
    const orchestrator = new AppSyncOrchestrator({
      blockEmitter: explorerService.getBlockEmitter(),
      getEligibleSyncPeers: (minUptime) => peerManager.getEligibleSyncPeers(minUptime)
        .map((p) => ({ key: p.key, send: (msg) => p.send(msg) })),
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
    nodeConfirmationService.onMessageCapabilityChange((capable) => orchestrator.onMessageCapabilityChange(capable));
    peerNotification.initialize();
    // Serve the flux-shutdownd drain socket (Arcane-only, best-effort).
    drainServer.start();
    appSpawner.initialize();
    appInstaller.setOnInstallComplete(() => peerNotification.checkAndNotifyPeersOfRunningApps());
    // a removed component's in-memory controller verdict dies with it - a
    // reinstalled g:/r: app must await a fresh election, not inherit a stale one
    appUninstaller.setOnComponentRemoved((id) => appReconciler.clearControllerDesired(id));
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
    setTimeout(() => {
      imageUpdateService.startImageUpdateService();
      log.info('Native image update service started');
    }, bootDelay(10 * 60 * 1000)); // 10 minutes after startup
    fluxNetworkMonitor.checkDeterministicNodesCollisions();
    appTamperingBlocklistService.start().catch((err) => {
      log.error(`appTamperingBlocklist start error: ${err.message}`);
    });
    log.info('Flux checks operational');
    fluxCommunication.initializeDiscovery();
    await nodeConfirmationService.start();
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
    syncthingService.startSyncthingSentinel();
    log.info('Syncthing service started');
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
      appOperations.testAppMount(); // test if our node can mount a volume
    }, bootDelay(30 * 1000));
    setTimeout(() => {
      appController.stopAllNonFluxRunningApps();
      monitoringOrchestrator.startMonitoringOfApps(null, globalState.appsMonitored, appQueryService.installedApps);
      portManager.restoreAppsPortsSupport();
    }, bootDelay(1 * 60 * 1000));
    // Resolve this node's enterprise identity once, up front. Self-reschedules
    // every 5 minutes until the pubkey resolves (daemon/benchmark may still be
    // coming up). Once cached, hot paths (spawn loop) read it synchronously
    // via getCachedEnterpriseIdentity() with no network call and no throws.
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
    explorerService.initiateBlockProcessor(true, true);
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
    // Re-issue managed backend-TLS leaves before their 30-day life runs out
    // (dormant on a node running no verify:required app).
    backendTlsRenewal.start();
    setTimeout(() => {
      daemonHealthMonitor.checkDaemonHealthAndCleanup();
      setInterval(() => {
        daemonHealthMonitor.checkDaemonHealthAndCleanup();
      }, bootDelay(15 * 60 * 1000));
    }, bootDelay(5 * 60 * 1000));
    setTimeout(() => {
      appInspector.enforceWritableLayerLimit(appsStorageViolations);
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
};
