'use strict';

// THE HARNESS CONFIG IS OVERRIDES, NOT A SECOND CONFIG.
//
// It used to be a standalone copy, and a copy of a 239-key object goes short:
// 80 fluxapps keys the service layer reads were absent from it, along with
// whole sections (registryAuth, marketplace, fluxDrive, analytics). Every one
// of those reads took its `?? literal` under test and the shipped value was
// never exercised - which is the exact opposite of what the harness is for, and
// is why a fallback that had drifted from config could sit here unnoticed.
//
// So production is the base and this file is what the harness changes about it.
// A key it does not mention is the one a node runs with, and it cannot be
// missing.
const production = require('../../../ZelBack/config/default');

/**
 * Overrides over production, deeply. An array replaces rather than merges - a
 * harness that wants three FDM regions means three, not three appended to
 * production's.
 * @param {*} base
 * @param {*} override
 * @returns {*}
 */
function merge(base, override) {
  if (Array.isArray(override) || override === null) return override;
  if (typeof override !== 'object') return override;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return override;
  const out = { ...base };
  Object.keys(override).forEach((key) => { out[key] = merge(base[key], override[key]); });
  return out;
}

// So you can set host.docker.internal (mac) or container name
const database = process.env.FLUX_DATABASE || '127.0.0.1';

const harnessOverrides = {
  testEventStream: false,
  system: {
    bootIdPath: '/proc/sys/kernel/random/boot_id',
    heartbeatIntervalMs: 30_000,
    bootSyncTimeoutMs: 300_000,
    bootDaemonTimeoutMs: 300_000,
  },
  peers: {
    wsPingIntervalMs: 15_000,
    wsMaxMissedPongs: 3,
  },
  confirmation: {
    pollIntervalMs: 30_000,
    daemonStaleMs: 7_500_000,
    // Post-PON a node must re-confirm between 500 and 640 blocks after its last
    // confirmation — fluxd's FLUXNODE_CONFIRM_UPDATE_MIN_HEIGHT_V3 and
    // FLUXNODE_CONFIRM_UPDATE_EXPIRATION_HEIGHT_V4. Expiry is a height, not a
    // duration; the block interval only estimates it when the chain view is gone.
    confirmExpirationBlocks: 640,
    confirmWindowOpensBlocks: 500,
    blockIntervalMs: 30_000,
  },
  server: {
    allowedPorts: [11, 13, 16_127, 16_137, 16_147, 16_157, 16_167, 16_177, 16_187, 16_197],
    apiport: 16_127, // homeport is -1, ssl port is +1
    fluxNodeServiceAddress: '169.254.43.43',
    fluxDnsdServiceAddress: '169.254.43.53',
  },
  database: {
    url: database,
    port: 27_017,
    local: {
      database: 'zelfluxlocaltest',
      collections: {
        loggedUsers: 'loggedusers',
        activeLoginPhrases: 'activeloginphrases',
        activeSignatures: 'activesignatures',
        geolocation: 'geolocation',
        policyDocuments: 'policydocuments', // last-known-good network policy documents, so an unreachable source does not drop enforcement
        benchmark: 'benchmark',
        nodeIdentity: 'nodeidentity',
        quorumGrants: 'quorumgrants',
        foundingCommittees: 'foundingcommittees',
      },
    },
    daemon: {
      database: 'zelcashdatatest',
      collections: {
        // addreesIndex contains a) balance, b) list of all transacitons, c) list of utxos
        scannedHeight: 'scannedheight',
        utxoIndex: 'utxoindex',
        addressTransactionIndex: 'addresstransactionindex',
        fluxTransactions: 'zelnodetransactions',
        appsHashes: 'zelappshashes',
        coinbaseFusionIndex: 'coinbasefusionindex',
      },
    },
    appslocal: {
      database: 'localzelappstest',
      collections: {
        appsInformation: 'zelappsinformation',
        appsRuntimeState: 'zelappsruntimestate',
        cachedImages: 'cachedimages',
      },
    },
    appsglobal: {
      database: 'globalzelappstest',
      collections: {
        appsMessages: 'zelappsmessages', // storage for all flux apps messages done on flux network
        appsInformation: 'zelappsinformation', // stores actual state of flux app configuration info - initial state and its overwrites with update messages
        appsTemporaryMessages: 'zelappstemporarymessages', // storages for all flux apps messages that are not yet confirmed on the flux network
        appsInstallingLocations: 'appsInstallingLocations',
        appsInstallingErrorsLocations: 'appsInstallingErrorsLocations', // stores install errors location of flux apps as documents containing name, hash, ip, obtainedAt
        appStateEvents: 'appstateevents',
        appsInstallingBroadcasts: 'fluxappinstallingbroadcasts',
        appsInstallingErrorsBroadcasts: 'fluxappinstallingerrorsbroadcasts',
      },
    },
    chainparams: {
      database: 'chainparamstest',
      collections: {
        chainMessages: 'chainmessages',
        priceMessages: 'pricemessages',
        rateMessages: 'ratemessages',
        priceModifierMessages: 'pricemodifiermessages',
        oracleKeyMessages: 'oraclekeymessages',
        marketplacePricingMessages: 'marketplacepricingmessages',
        policyGroupMessages: 'policygroupmessages',
      },
    },
  },
  logConsole: false,
  logLevel: 'debug',
  upnp: {
    gatewayUrl: '',
    nodeIp: '',
  },
  benchmark: {
    host: '127.0.0.1',
    port: 16_225,
    rpcport: 16_224,
    porttestnet: 26_225,
    rpcporttestnet: 26_224,
  },
  daemon: {
    host: '127.0.0.1',
    chainValidHeight: 1_062_000,
    port: 16_125,
    rpcport: 16_124,
    porttestnet: 26_125,
    rpcporttestnet: 26_124,
    zmqport: 16_123,
    subscriptions: {
      receiveHighWaterMark: 400,
      // fluxd answers ZMTP heartbeats but never initiates them, so this side decides
      // how quickly a socket that is open but dead gets noticed. Worst case is the
      // interval plus the timeout, because a peer can die immediately after the last
      // reply and nothing arms the timer until the next ping. 25s keeps that inside
      // one block, so a dead stream costs at most one delta, which the gap path
      // recovers. Lower still would start to be within reach of a badly loaded host,
      // and a teardown is not free: it resyncs from a full snapshot.
      heartbeatIntervalMs: 5000,
      heartbeatTimeoutMs: 20_000,
      reconnectIntervalMs: 500,
      reconnectMaxIntervalMs: 15_000,
      connectTimeoutMs: 3000,
      silenceThresholdMs: 90_000,
      probeIntervalMs: 30_000,
      // Push carries the tip every block; this only keeps `headers` honest, which push
      // cannot supply — a post-IBD daemon still catching up publishes a block per
      // connection and would otherwise read as synced.
      headerRefreshIntervalMs: 300_000,
      livenessCheckIntervalMs: 10_000,
      // One aggregate line rather than one per block. Long enough that a healthy node is
      // quiet, short enough that the numbers still mean something when read after the fact.
      usageReportIntervalMs: 300_000,
      // Ten blocks at ~30s. Past this nothing recent has arrived from either the
      // socket or RPC, so the tip we hold is no longer evidence about the chain.
      chainStaleAfterMs: 300_000,
      // Shortest gap between two rebuilds caused by reconnecting. A rebuild is a full
      // snapshot, and libzmq reconnects from half a second, so a flapping link would
      // otherwise pay for one per flap. Safe to skip: a delta against a stale view
      // does not chain, and one that does not chain forces the rebuild anyway.
      reconnectResyncMinIntervalMs: 30_000,
    },
  },
  minimumFluxBenchAllowedVersion: '6.2.0',
  minimumFluxOSAllowedVersion: '8.0.0',
  minimumNodeJsAllowedVersion: '20.8.0',
  minimumSyncthingAllowedVersion: '1.27.6',
  minimumDockerAllowedVersion: '26.1.2',
  fluxTeamFluxID: '1NH9BP155Rp3HSf5ef6NpUbE8JcyLRruAM',
  fluxSupportTeamFluxID: ['16iJqiVbHptCx87q6XQwNpKdgEZnFtKcyP'],
  deterministicNodesStart: 558_000,
  fluxapps: {
    storageHost: 'storage.runonflux.io',
    crashBackoffDelaysMs: [0, 30_000, 300_000, 900_000, 1_800_000],
    crashBackoffStableRunMs: 600_000,
    restartBurstCount: 5,
    restartBurstWindowMs: 300_000,
    networkHealConfirmMs: 3000,
    networkHealDetachedPersistMs: 60_000,
    networkHealPrunedRetryMs: 300_000,
    postStartVerifyMs: 30_000,
    convergeFailAttempts: 3,
    convergeBackstopMs: 300_000,
    convergeRetryMs: 10_000,
    firstRunProofMs: 60_000,
    // small so the hung-provision cap test observes the cap without a long wait;
    // only ever reached by a provision stub that deliberately never resolves
    recreateProvisionCapMs: 250,
    // pull-stall watchdog window; unit pull tests pass stallMs per-call, this
    // mirrors the prod key so config reads never fall through to the fallback
    pullStallMs: 90_000,
    // transient registry back-off mirror (prod value, so TTL tests assert prod math)
    registryTransientBackoffMs: 120_000,
    // in flux main chain per month (blocksLasting)
    price: [
      { // any price fork can be done by adjusting object similarily.
        height: -1, // height from which price spec is valid
        cpu: 3, // per 0.1 cpu core,
        ram: 1, // per 100mb,
        hdd: 0.5, // per 1gb,
        minPrice: 1, // minimum price that has to be paid for registration or update. Flux listens only to message above or equal this price
        port: 2, // additional price per enterprise port
        scope: 6, // additional price for application targetting specific nodes, private images
        staticip: 3, // additional price per application for targetting nodes that have static ip address
      },
      {
        height: 983_000, // height from which price spec is valid. Counts from when app was registerd on blockchain!
        cpu: 0.3, // per 0.1 cpu core,
        ram: 0.1, // per 100mb,
        hdd: 0.05, // per 1gb,
        minPrice: 0.1, // minimum price that has to be paid for registration or update. Flux listens only to message above or equal this price
        port: 2, // additional price per enterprise port
        scope: 6, // additional price for application targetting specific nodes, private images
        staticip: 3, // additional price per application for targetting nodes that have static ip address
      },
      {
        height: 1_004_000, // height from which price spec is valid. Counts from when app was registerd on blockchain! 1004000
        cpu: 0.06, // per 0.1 cpu core,
        ram: 0.02, // per 100mb,
        hdd: 0.01, // per 1gb,
        minPrice: 0.01, // minimum price that has to be paid for registration or update. Flux listens only to message above or equal this price
        port: 2, // additional price per enterprise port
        scope: 6, // additional price for application targetting specific nodes, private images
        staticip: 3, // additional price per application for targetting nodes that have static ip address
      },
      {
        height: 1_288_000, // height from which price spec is valid. Counts from when app was registerd on blockchain! 1004000
        cpu: 0.15, // per 0.1 cpu core,
        ram: 0.05, // per 100mb,
        hdd: 0.02, // per 1gb,
        minPrice: 0.01, // minimum price that has to be paid for registration or update. Flux listens only to message above or equal this price
        port: 2, // additional price per enterprise port
        scope: 6, // additional price for application targetting specific nodes, private images
        staticip: 3, // additional price per application for targetting nodes that have static ip address
      },
      // soft fork 1
      {
        height: 1_594_832, // height from which price spec is valid. Counts from when app was registerd on blockchain! 1004000
        cpu: 0.15, // per 0.1 cpu core,
        ram: 0.05, // per 100mb,
        hdd: 0.02, // per 1gb,
        minPrice: 0.01, // minimum price that has to be paid for registration or update. Flux listens only to message above or equal this price
        port: 1.5, // additional price per enterprise port
        scope: 6, // additional price for application targetting specific nodes, private images
        staticip: 3, // additional price per application for targetting nodes that have static ip address
      },
      // soft fork 2
      {
        height: 1_597_156, // height from which price spec is valid. Counts from when app was registerd on blockchain! 1004000
        cpu: 0.03, // per 0.1 cpu core,
        ram: 0.01, // per 100mb,
        hdd: 0.004, // per 1gb,
        minPrice: 0.01, // minimum price that has to be paid for registration or update. Flux listens only to message above or equal this price
        port: 0.4, // additional price per enterprise port
        scope: 0.8, // additional price for application targetting specific nodes, private images
        staticip: 0.4, // additional price per application for targetting nodes that have static ip address
      },
    ],
    fluxUSDRate: 0.6,
    usdprice: {
      height: -1, // height from which price spec is valid
      cpu: 0.15, // per 0.1 cpu core,
      ram: 0.05, // per 100mb,
      hdd: 0.02, // per 1gb,
      minPrice: 0.01, // minimum price that has to be paid for registration or update. Flux listens only to message above or equal this price
      port: 2, // additional price per enterprise port
      scope: 4, // additional price for application targetting specific nodes, private images
      staticip: 2, // additional price per application for targetting nodes that have static ip address
      fluxmultiplier: 0.95, // discount given if payed with flux 1 would be 0%
      multiplier: 1, // multiplier in case we want to increase prices globaly
      minUSDPrice: 0.99, // min. usd price that can be paid with stripe/paypal.
    },
    teamSupportAddress: [{
      height: 1_851_659, // height from which address is valid
      address: '16iJqiVbHptCx87q6XQwNpKdgEZnFtKcyP',
    }],
    usersToExtend: ['1MCBJn6qsy3YRY2YasdYMYdJcdhy1ev8Rd'], // addresses that can extend applications on behalf of app owners (expire-only updates) addresses cannot be deleted over time, just adding new ones
    restartAlwaysOwners: ['16mzUh6byiQr7rnYQxKraDbeBPsEHYpSTW'], // app owners whose containers should have restart policy 'always' instead of 'unless-stopped'
    appSpecsEnforcementHeights: {
      1: 0, // blockheight v1 is deprecated. Not possible to use api to update to its specs
      2: 0, // blockheight
      3: 983_000, // blockheight. Since this blockheight specification of type 3 is active. User can still submit v1 or v2. UI allows only v2, v3
      4: 1_004_000, // v4 available, composition
      5: 1_142_000, // v5 available adding contacts, geolocation
      6: 1_300_000, // v6, expiration, app price, t3
      7: 1_420_000, // v7, nodes selection, secrets, private images (nodes selection allows secrets, private image - scope), staticip
      8: 1_932_380, // v8, brings enterprise apps using arcaneOS features to run these apps. // Around June 23th
      9: 2_791_000, // v9, Bedrock spec redesign: class hierarchy, contentHash signing, named ports, placement, time-based TTL
    },
    appPaymentAddresses: [
      { address: 't1LUs6quf7TB2zVZmexqPQdnqmrFMGZGjV6', activeFromHeight: 0 },
      { address: 't3aGJvdtd8NR6GrnqnRuVEzH6MbrXuJFLUX', activeFromHeight: 1_300_000, legacyMessageAuthority: true },
      { address: 't3NryfAQLGeFs9jEoeqsxmBN2QLRaRKFLUX', activeFromHeight: 1_670_000, legacyMessageAuthority: true },
    ],
    messageAuthorityAddress: 't1eW962yoqbfCYKzFYaZJVYzeopSmhaKL4f',
    epochstart: 694_000,
    publicepochstart: 705_000,
    portMinLegacy: 31_000, // ports 30000 - 30999 are reserved for local applications
    portMaxLegacy: 39_999,
    portBlockheightChange: 1_420_000,
    portMin: 1,
    portMax: 65_535,
    bannedPorts: ['16100-16299', '26100-26299', '30000-30099', 8384, 27_017, 22, 23, 25, 3389, 5900, 5800, 161, 512, 513, 5901, 3388, 4444, 123, 53],
    upnpBannedPorts: ['81-442', 2189],
    enterprisePorts: ['0-1023', 8080, 8081, 8443, 6667],
    maxImageSize: 5_000_000_000, // 5000mb
    minimumInstances: 3,
    minimumInstancesV8: 1,
    minimumInstancesV8Block: 2_176_519, // block height where v8+ apps can have 1 instance - expected around December 19th 2025
    maximumInstances: 100,
    maxAppsPerNode: 200,
    minOutgoing: 8,
    minUniqueIpsOutgoing: 7,
    minIncoming: 4,
    minUniqueIpsIncoming: 3,
    minUpTime: 1800, // 30 mins
    appSyncPeerThreshold: 12,
    appSyncDegradedThreshold: 4,
    appSyncMinCompletions: 3,
    appSyncMinPeerUptime: 7500,
    appSyncFallbackMinutes: 125,
    installation: {
      probability: 100, // 1%
      delay: 120, // in seconds
    },
    removal: {
      probability: 25, // 4%
      delay: 300,
    },
    redeploy: {
      probability: 2, // 50%
      composedDelay: 5,
    },
    blocksLasting: 22_000, // by default registered app will live for 22000 of blocks 44000 minutes ~= 1 month
    minBlocksAllowance: 5000, // app can be registered for a minimum of this blocks ~ 1 week
    newMinBlocksAllowance: 100, // app can be registered for a minimum of this blocks ~ 3 hours - to allow users to cancel application subscription
    newMinBlocksAllowanceBlock: 1_630_040, // block where we will start looking at new min blocks allowance. block expected on 26th of April 2024
    cancel1BlockMinBlocksAllowance: 1, // app can be registered for a minimum of 1 block for cancellation purposes
    cancel1BlockMinBlocksAllowanceBlock: 1_964_447, // block where we will start allowing 1 block lifetime updates - Expected August 6th 2025
    maxBlocksAllowance: 264_000, // app can be registered up for a maximum of this blocks ~ 1 year
    postPonMaxBlocksAllowance: 1_056_000, // after PON fork, chain works 4x faster, so max blocks is 4x higher ~ 1 year
    daemonPONFork: 2_020_000, // block height where PON (Proof of Node) fork activates - chain works 4x faster after this block
    blocksAllowanceInterval: 1000, // ap differences can be in 1000s - more than 1 day
    removeBlocksAllowanceIntervalBlock: 1_625_000, // after this block we can start having app updates without extending subscription - block expected in April 19th 2024
    ownerAppAllowance: 1000, // in case of node owner installing some app, the app will run for this amount of blocks
    temporaryAppAllowance: 200, // in case of any user installing some temporary app message for testing purposes, the app will run for this many blocks
    expireFluxAppsPeriod: 100, // every 100 blocks we run a check that deletes apps specifications and stops/removes the application from existence if it has been lastly updated more than 22k blocks ago
    updateFluxAppsPeriod: 9, // every 9 blocks we check for reinstalling of old application versions
    removeFluxAppsPeriod: 11, // every 11 blocks we check for more than maximum number of instances of an application
    peerSetDipDosThreshold: 5,
    peerSetDipWindowMinutes: 120,
    peerSetDipEvaluateMs: 60 * 1000,
    reconstructAppMessagesHashPeriod: 3600, // every 5 days we ask for old messages
    benchUpnpPeriod: 6480, // every 9 days execute upnp bench
    hddFileSystemMinimum: 10, // right now 10, to be decreased to a minimum of 5GB of free space on hdd for docker with v8 specs activation
    defaultSwap: 2, // 2gb swap memory minimum, this is in gb
    applyMinimumPriceOn3Instances: 1_691_000, // after this block we use the min. usd price on prices per 3 instances.
    applyMinimumForExtraInstances: 1_890_000,
    minHashSyncPeers: 12,
    bootDelayMultiplier: 1,
    spawnDelayMs: 0,
    removalSpacingMs: 60_000,
    locationTtlS: 7500,
    installingTtlS: 900,
    installingRenewalS: 720,
    installErrorTtlS: 86_400,
    tempMsgTtlS: 3600,
    gossipValidityS: 300,
    clockSkewAllowanceMs: 120_000,
    hashSyncIntervalMs: 1_800_000,
    cpuCheckIntervalMs: 900_000,
    statsSampleIntervalMs: 60_000,
    portRestoreIntervalMs: 600_000,
    complianceSweepStaggerMs: 120_000,
    complianceRemovalSpacingMs: 180_000,
    complianceRetryBaseMs: 60_000,
    complianceRetryMaxMs: 3_600_000,
    imageComplianceIntervalMs: 3_600_000,
    tamperingCheckIntervalMs: 43_200_000, // 12h — how often a node re-checks whether it is on the tampering blocklist
    imageCacheEnabled: true,
    imageCachePerFluxIdQuotaGb: 20,
    imageCachePerImageBurstCapGb: 5,
    imageCacheNodeMaxGb: 60,
    imageCacheMaxConcurrentPulls: 3,
    imageCacheMaxPullRetries: 3,
    imageCacheJobTtlMs: 10_800_000,
    imageReaperIntervalMs: 86_400_000,
    adoptionStaggerStepMs: 60_000,
    adoptionStaggerWindowMs: 300_000,
    orphanSweepIntervalMs: 7_200_000,
    dockerDebrisIntervalMs: 21_600_000,
    meshReconcileIntervalMs: 1_800_000,
    backendTlsRenewalIntervalMs: 21_600_000,
    installCollisionWaitMs: 90_000,
    portTestPeerTimeoutMs: 5000, // per-peer reachability round-trip timeout
    portTestBindDelayMs: 5000,
    portTestPropagationDelayMs: 10_000,
    portTestMaxAttempts: 5,
    siblingPortsTimeoutMs: 5000,
    // How long a signed sibling ask stays good for. The exchange itself is
    // bounded by siblingPortsTimeoutMs; the rest is allowance for two nodes
    // that were never required to agree on the time.
    siblingAskValidityMs: 60_000,
    portTestPeerQueryCount: 3, // peers queried concurrently per round - distinct /16, excluding our own
    portTestMaxRounds: 3, // max retry rounds when a round is inconclusive (no peer answered)
    portTestPrefixLength: 16, // bits of IP prefix (whole octets) defining an "independent" peer for the reachability probe
    contentManifestReapGraceMs: 7_200_000, // manifests younger than this are never reaped - covers the register window where the manifest exists before the app tx confirms on-chain
    spawnReconfirmDelayMs: 7_500_000,
    unencryptedSpawnDelayMs: 120_000,
    manageCollectorLifecycle: false, // node-managed lifecycle for shareWith dependency apps (collectors). Off: the flux console owns this lifecycle and a dependency is "ready" once installed; on: FluxOS also requires the dependency to be running before a consumer installs against it.
    globalCmdDelayMs: 500,
    discoveryAutostart: true,
    discoveryRetryMs: 60_000,
    discoveryFailRetryMs: 120_000,
    connectionBackoffMs: [120_000, 300_000, 600_000, 900_000],
    spawnDeferrals: {
      targetedNodesMs: { encrypted: 1_800_000, standard: 3_420_000 },
      staticIpMs: { encrypted: 1_620_000, standard: 3_420_000 },
      datacenterMs: { encrypted: 1_620_000, standard: 3_420_000 },
      capacityGap: {
        largeMs: { encrypted: 1_800_000, standard: 7_020_000 },
        mediumMs: { encrypted: 1_260_000, standard: 5_220_000 },
        smallMs: { encrypted: 720_000, standard: 3_420_000 },
      },
    },
    spawnDelayMultiplier: 1,
    daemonInfoIntervalMs: 30_000,
    explorerSyncRetryMs: 120_000,
    explorerDeepRestoreBlocks: 100,
    syncTimeoutMs: 120_000,
    hashSyncMaxRetries: 3,
    hashSyncRetryMs: 300_000,
    hashSyncSettleMs: 4000,
    hashSyncResponseTimePerHashMs: 150,
    hashSyncBufferMs: 5000,
    hashSyncMaxRounds: 4,
    hashSyncPeersPerRound: 3,
    hashSyncEphemeralPeers: 5,
    hashSyncFallbackRecheckBlocks: 100,
    syncResponseThrottleMs: 300_000,
    wsHandshakeTimeoutMs: 10_000,
    discoveryConnectionDelayMs: 500,
    nodeMonitorRemovalDelayMs: 60_000,
    residentialCheckIntervalMs: 21_600_000,
    residentialSettleMs: 86_400_000,
    residentialEvacuationIntervalMs: 21_600_000,
    residentialQueueBaseMs: 1_800_000,
    residentialQueueStepMs: 2_400_000, // 40m - must exceed the 22m give-up pass, see ZelBack/config/default.js
    imageUpdateCheckIntervalMs: 21_600_000,
    imageUpdateInitialDelayMinMs: 600_000,
    imageUpdateInitialDelayMaxMs: 1_800_000,
    imageUpdateDelayBetweenAppsMs: 5000,
    imageUpdateDelayAfterRedeployMs: 120_000,
    imageUpdateDelayBetweenComponentsMs: 1000,
    masterSlaveIntervalMs: 30_000,
    // Deliberately NOT the production 180000. The code falls back to 3 minutes
    // when the key is missing, so a config value equal to the fallback cannot
    // tell "read from config" from "key misspelled and silently defaulted" -
    // which is exactly how statsSampleIntervalMs came to read undefined.
    masterSlaveStaggerMs: 30_000,
  },
  lockedSystemResources: {
    cpu: 10, // 1 cpu core
    ram: 2000, // 2000mb
    hdd: 60, // 60gb // this value is likely to raise
    extrahdd: 20, // extra 20gb to be left on a node // this value is likely to raise
  },
  fluxSpecifics: { // tbd during forks
    cpu: {
      cumulus: 40, // 30 available for apps
      nimbus: 80, // 70 available for apps
      stratus: 160, // 150 available for apps
    },
    ram: {
      cumulus: 7000, // 5000 available for apps
      nimbus: 30_000, // 28000 available for apps
      stratus: 61_000, // available 59000 for apps
    },
    hdd: {
      cumulus: 220, // 180 for apps
      nimbus: 440, // 400 for apps
      stratus: 880, // 840 for apps
    },
    collateral: { // tbd during forks
      cumulusold: 10_000,
      nimbusold: 25_000,
      stratusold: 100_000,
      cumulus: 1000,
      nimbus: 12_500,
      stratus: 40_000,
    },
  },
  syncthing: { // operates on apiPort + 2
    ip: '127.0.0.1', // local
    port: 8384, // local
    monitorIntervalMs: 30_000,
    healthWindowMs: 300_000,
    sentinelIntervalMs: 60_000,
    stallNudgeAfterMs: 180_000,
    stallNudgeMaxIntervalMs: 900_000,
    stallRemoveMinWindowMs: 1_200_000,
    stallRemoveMinNudges: 3,
    aptSourceUrl: 'https://apt.syncthing.net/',
    releaseKeyUrl: 'https://syncthing.net/release-key.gpg',
  },
  cpuBurst: {
    enabled: true,
    periodUs: 100_000,
    reservedCores: 1,
  },
  enterprisePublicKeys: [ // list of whitelisted nodes indentity public keys. Most trusted node operators that are publicly known, kyc. Eg Flux team members, Titan.
    '042ebcb3a94fe66b9ded6e456871346d6984502bbadf14ed07644e0eb91f8cc0b1f07632c428e1e6793f372d9c303d680de80ae0499d51095676cabf68599e9591',
  ],
  // The load balancers whose X-Forwarded-For this node will believe. A stand-in:
  // the tests need one address the code trusts, not the fleet's real ones, so
  // adding a balancer in production does not mean editing this file too.
  fdmAddresses: ['1.2.3.4'],
  github: {
    apiBaseUrl: 'https://api.github.com',
  },
  policy: {
    baseUrl: 'https://raw.githubusercontent.com/RunOnFlux/fluxos-network-policy/main',
    signedBaseUrl: 'https://raw.githubusercontent.com/RunOnFlux/fluxos-network-policy/signed',
    publicKeys: [
      'c31930ec386a49f31321851766d93bcb90bf269cd15bec7a329155a4d79ea380',
      '739ca41408f66c75d6cb4bc1d5c044ca5a118de190081da68e5a7d6839fb69f8',
    ],
    refreshIntervalMs: {
      blockedRepositories: 21_600_000,
      tamperingBlocklist: 43_200_000,
      enterpriseNodes: 21_600_000,
      ipLocationTable: 86_400_000,
    },
    peerWindowMs: 3 * 1000,
    fetchTimeoutMs: {
      default: 10_000,
      ipLocationTable: 120_000,
    },
    minConfirmingPeers: 4,
    backstopRetryIntervalMs: 60 * 1000,
  },
  geolocation: {
    ipApiBaseUrl: 'http://ip-api.com',
  },
  stats: {
    baseUrl: 'https://stats.runonflux.io',
  },
  pricing: {
    fluxRatesBaseUrl: 'https://viprates.runonflux.io',
    coingeckoBaseUrl: 'https://api.coingecko.com',
  },
  mongodb: {
    signingKeyBaseUrl: 'https://pgp.mongodb.com',
  },
  fdm: {
    regions: [
      { name: 'EU', baseUrlTemplate: 'http://fdm-fn-1-%i.runonflux.io:16130' },
      { name: 'USA', baseUrlTemplate: 'http://fdm-usa-1-%i.runonflux.io:16130' },
      { name: 'ASIA', baseUrlTemplate: 'http://fdm-sg-1-%i.runonflux.io:16130' },
    ],
  },
};

module.exports = merge(production, harnessOverrides);
