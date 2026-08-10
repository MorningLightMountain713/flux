// eslint-disable-next-line prefer-const
let userconfig = require('../../config/userconfig');

const isDevelopment = userconfig.initial.development || false;

const dbPrefix = '';

module.exports = {
  development: isDevelopment,
  loglevel: 'debug', // severity ordering specified by RFC5424
  testEventStream: false,
  system: {
    bootIdPath: '/proc/sys/kernel/random/boot_id',
    heartbeatIntervalMs: 30000,
    bootSyncTimeoutMs: 300000,
    bootDaemonTimeoutMs: 300000,
  },
  peers: {
    wsPingIntervalMs: 15000,
    wsMaxMissedPongs: 3,
  },
  confirmation: {
    pollIntervalMs: 30000,
    daemonStaleMs: 7500000,
    // Post-PON a node must re-confirm between 500 and 640 blocks after its last
    // confirmation — fluxd's FLUXNODE_CONFIRM_UPDATE_MIN_HEIGHT_V3 and
    // FLUXNODE_CONFIRM_UPDATE_EXPIRATION_HEIGHT_V4. Expiry is a height, not a
    // duration; the block interval only estimates it when the chain view is gone.
    confirmExpirationBlocks: 640,
    confirmWindowOpensBlocks: 500,
    blockIntervalMs: 30000,
  },
  server: {
    allowedPorts: [16127, 16137, 16147, 16157, 16167, 16177, 16187, 16197],
    apiport: 16127, // homeport is -1, ssl port is +1
    fluxNodeServiceAddress: '169.254.43.43',
    fluxDnsdServiceAddress: '169.254.43.53', // the mesh resolver (flux-dnsd), beside the node service on loopback

  },
  database: {
    url: '127.0.0.1',
    port: 27017,
    local: {
      database: `${dbPrefix}zelfluxlocal`,
      collections: {
        loggedUsers: 'loggedusers',
        activeLoginPhrases: 'activeloginphrases',
        activeSignatures: 'activesignatures',
        activePaymentRequests: 'activepaymentrequests',
        completedPayments: 'completedpayments',
        geolocation: 'geolocation',
        benchmark: 'benchmark',
        appTamperingEvents: 'apptamperingevents',
        nodeStartupTracker: 'nodestartuptracker',
        nodeIdentity: 'nodeidentity', // node runtime state generated/discovered by FluxOS: the PGP keypair and the last-known external IP
        policyDocuments: 'policydocuments', // last-known-good network policy documents, so an unreachable source does not drop enforcement
      },
    },
    daemon: {
      database: `${dbPrefix}zelcashdata`,
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
      database: `${dbPrefix}localzelapps`,
      collections: {
        appsInformation: 'zelappsinformation',
        appsRuntimeState: 'zelappsruntimestate', // node-local per-component controller state: desiredState, restartHistory (crash backoff), last exit
        pendingAppTeardowns: 'zelappspendingteardowns', // durable owed-teardown records: the crash-safe handoff between the removal prelude and the deferred destructive teardown
        cachedImages: 'cachedimages', // enterprise image cache: owner-pinned docker images (the durable pin the uninstall retention gate + per-fluxId quota consult)
        playgroundSessions: 'playgroundsessions', // node-local, never gossiped: one sealed+signed record per playground session, self-reaping on its retention TTL
      },
    },
    appsglobal: {
      database: `${dbPrefix}globalzelapps`,
      collections: {
        appsMessages: 'zelappsmessages', // storage for all flux apps messages done on flux network
        appsInformation: 'zelappsinformation', // stores actual state of flux app configuration info - initial state and its overwrites with update messages
        appsTemporaryMessages: 'zelappstemporarymessages', // storages for all flux apps messages that are not yet confirmed on the flux network
        appsInstallingLocations: 'appsinstallinglocations', // stores install location of flux apps as documents containing name, ip, obtainedAt
        limitCounterRecords: 'limitcounterrecords', // gossiped record of one caller's use of a limited feature, keyed by the counter's hash; self-reaping on its own endsAt
        appsInstallingErrorsLocations: 'appsInstallingErrorsLocations', // stores install errors location of flux apps as documents containing name, hash, ip, obtainedAt
        appStateEvents: 'appstateevents', // event log for running app state (apprunning, sigterm, appremoved, evicted)
        appsInstallingBroadcasts: 'fluxappinstallingbroadcasts', // stores signed appinstalling broadcasts for sync
        appsInstallingErrorsBroadcasts: 'fluxappinstallingerrorsbroadcasts', // stores signed appinstalling error broadcasts for sync
        appContentManifests: 'appcontentmanifests', // latest owner-signed content-slot manifest per app (one doc per app, version-monotonic)
        appsIngressAttestations: 'appingressattestations', // node-signed record of where a register/update entered the network (keyed by hash+node); fluxteam-only
        appsIngressAttestationDigests: 'appingressattestationdigests', // materialized per-bucket digests of the confirmed ingress set, for O(K) reconcile
      },
    },
    marketplace: {
      database: `${dbPrefix}marketplace`,
      collections: {
        templates: 'marketplacetemplates', // local cache of v9 marketplace templates (keyed by uuid+templateVersion), fetched from the marketplace v2 API
      },
    },
    chainparams: {
      database: `${dbPrefix}chainparams`,
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
    fluxshare: {
      database: `${dbPrefix}zelshare`,
      collections: {
        shared: 'shared',
      },
    },
  },
  // Log verbosity (pino level names: error/warn/info/debug). Where systemd
  // runs fluxos, stdout is the one sink and journald owns storage; elsewhere
  // a rolling fluxos.N.log is written beside the checkout, and logConsole
  // additionally mirrors NDJSON to stdout (dev + the test harness — humans
  // pipe through pino-pretty).
  logLevel: 'info',
  logConsole: false,
  upnp: {
    gatewayUrl: '',
    nodeIp: '',
  },
  benchmark: {
    host: '127.0.0.1',
    port: 16225,
    rpcport: 16224,
    porttestnet: 26225,
    rpcporttestnet: 26224,
    // Local socket to the benchmark daemon, used when one is present. Its file
    // permissions authorize the caller, so nothing is sent over it to prove who
    // we are. Installs whose daemon does not offer one simply never find it and
    // keep using the port above.
    socketPath: '/run/fluxbenchd/full.sock',
  },
  daemon: {
    host: '127.0.0.1',
    chainValidHeight: 1062000,
    port: 16125,
    rpcport: 16124,
    porttestnet: 26125,
    rpcporttestnet: 26124,
    zmqport: 16123,
    subscriptions: {
      // Shallow on purpose: falling behind becomes a sequence gap, and the gap
      // handlers resync from one RPC call. A deep queue would hide the stall.
      receiveHighWaterMark: 400,
      // fluxd answers ZMTP heartbeats but never initiates them, so this side decides
      // how quickly a socket that is open but dead gets noticed. Worst case is the
      // interval plus the timeout, because a peer can die immediately after the last
      // reply and nothing arms the timer until the next ping. 25s keeps that inside
      // one block, so a dead stream costs at most one delta, which the gap path
      // recovers. Lower still would start to be within reach of a badly loaded host,
      // and a teardown is not free: it resyncs from a full snapshot.
      heartbeatIntervalMs: 5000,
      heartbeatTimeoutMs: 20000,
      reconnectIntervalMs: 500,
      reconnectMaxIntervalMs: 15000,
      connectTimeoutMs: 3000,
      // Blocks are ~30s, so this is three missed in a row before we spend an RPC.
      silenceThresholdMs: 90000,
      probeIntervalMs: 30000,
      // Push carries the tip every block; this only keeps `headers` honest, which push
      // cannot supply — a post-IBD daemon still catching up publishes a block per
      // connection and would otherwise read as synced.
      headerRefreshIntervalMs: 300000,
      livenessCheckIntervalMs: 10000,
      // One aggregate line rather than one per block. Long enough that a healthy node is
      // quiet, short enough that the numbers still mean something when read after the fact.
      usageReportIntervalMs: 300000,
      // Ten blocks at ~30s. Past this nothing recent has arrived from either the
      // socket or RPC, so the tip we hold is no longer evidence about the chain.
      chainStaleAfterMs: 300000,
    },
  },
  minimumFluxBenchAllowedVersion: '6.2.0',
  minimumFluxOSAllowedVersion: '8.13.1',
  minimumSyncthingAllowedVersion: '2.0.10',
  minimumDockerAllowedVersion: '26.1.2',
  fluxTeamFluxID: '1hjy4bCYBJr4mny4zCE85J94RXa8W6q37',
  fluxSupportTeamFluxID: '16iJqiVbHptCx87q6XQwNpKdgEZnFtKcyP',
  deterministicNodesStart: 558000,
  messagesBroadcastRefactorStart: 1751250, // expected block at 13th Octobor 2024
  fluxapps: {
    latestSupportedSpecVersion: 8, // version changes on app updates must target this version
    // reconciler crash-recovery backoff: ladder of waits between restart attempts,
    // and the run length that counts as stable (resets the ladder)
    crashBackoffDelaysMs: [0, 30000, 300000, 900000, 1800000],
    crashBackoffStableRunMs: 600000,
    // network-detach heal windows: in-pass confirm settle, wall-clock persistence a
    // detach must show before the destructive heal, re-check pace while the app's
    // network is missing, and the post-start attachment verify
    networkHealConfirmMs: 3000,
    networkHealDetachedPersistMs: 60000,
    networkHealPrunedRetryMs: 300000,
    postStartVerifyMs: 30000,
    // install converge-wait (reconciler): roll an install back after this many
    // failed start attempts (a COUNT, not a clock); the backstop only stops the
    // caller hanging and never rolls back.
    convergeFailAttempts: 3,
    convergeBackstopMs: 300000, // 5 min
    // cap on a reconciler recreate's provisioning (registry verify + image pull): a
    // a pull whose progress stream goes silent this long is a dead transfer
    // (black-holed registry, half-open socket) - aborted and classed transient.
    // Total pull time is unbounded while progress keeps flowing.
    pullStallMs: 90000,
    // transient (could-not-ask) registry failures pace their re-ask on this;
    // the verification cache and the spawner's back-off both key on it, so the
    // worst-case stacked bench is 2x this value
    registryTransientBackoffMs: 120000,
    // absolute ceiling on a recreate's provision - the stall detector owns the
    // dead-registry case, so this only guards the residual non-pull steps (a
    // sick disk mid volume-create, a hung docker create) from wedging the
    // component's reconcile single-flight; generous so no live pull ever hits it
    recreateProvisionCapMs: 900000,
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
        height: 983000, // height from which price spec is valid. Counts from when app was registerd on blockchain!
        cpu: 0.3, // per 0.1 cpu core,
        ram: 0.1, // per 100mb,
        hdd: 0.05, // per 1gb,
        minPrice: 0.1, // minimum price that has to be paid for registration or update. Flux listens only to message above or equal this price
        port: 2, // additional price per enterprise port
        scope: 6, // additional price for application targetting specific nodes, private images
        staticip: 3, // additional price per application for targetting nodes that have static ip address
      },
      {
        height: 1004000, // height from which price spec is valid. Counts from when app was registerd on blockchain! 1004000
        cpu: 0.06, // per 0.1 cpu core,
        ram: 0.02, // per 100mb,
        hdd: 0.01, // per 1gb,
        minPrice: 0.01, // minimum price that has to be paid for registration or update. Flux listens only to message above or equal this price
        port: 2, // additional price per enterprise port
        scope: 6, // additional price for application targetting specific nodes, private images
        staticip: 3, // additional price per application for targetting nodes that have static ip address
      },
      {
        height: 1288000, // height from which price spec is valid. Counts from when app was registerd on blockchain! 1004000
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
        height: 1594832, // height from which price spec is valid. Counts from when app was registerd on blockchain! 1004000
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
        height: 1597156, // height from which price spec is valid. Counts from when app was registerd on blockchain! 1004000
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
      height: 1851659, // height from which address is valid
      address: '16iJqiVbHptCx87q6XQwNpKdgEZnFtKcyP',
    }],
    usersToExtend: ['1MCBJn6qsy3YRY2YasdYMYdJcdhy1ev8Rd'], // addresses that can extend applications on behalf of app owners (expire-only updates) addresses cannot be deleted over time, just adding new ones
    // restartAlwaysOwners removed — all containers use restart policy 'no', FluxOS manages startup
    appSpecsEnforcementHeights: {
      1: 0, // blockheight v1 is deprecated. Not possible to use api to update to its specs
      2: 0, // blockheight
      3: 983000, // blockheight. Since this blockheight specification of type 3 is active. User can still submit v1 or v2. UI allows only v2, v3
      4: 1004000, // v4 available, composition
      5: 1142000, // v5 available adding contacts, geolocation
      6: 1300000, // v6, expiration, app price, t3
      7: isDevelopment ? 1390000 : 1420000, // v7, nodes selection, secrets, private images (nodes selection allows secrets, private image - scope), staticip
      8: isDevelopment ? 1921500 : 1932380, // v8, brings enterprise apps using arcaneOS features to run these apps. // Around June 23th
      9: isDevelopment ? 2630000 : 2791000, // v9, Bedrock spec redesign: class hierarchy, contentHash signing, named ports, placement, time-based TTL
    },
    // App-payment collection addresses, in activation-height order. A payment
    // counts toward an app's fee when its receiver is one of these and the block
    // is at or past that entry's activeFromHeight; new deployments pay to the
    // latest active one. Entries flagged legacyMessageAuthority are also the
    // pre-v9 soft-fork message signer (the v6+ multisigs); the t1 base address
    // never was. The development-only receiver is present only on dev builds, so
    // it can never be a valid mainnet receiver.
    appPaymentAddresses: [
      { address: 't1LUs6quf7TB2zVZmexqPQdnqmrFMGZGjV6', activeFromHeight: 0 },
      { address: 't3aGJvdtd8NR6GrnqnRuVEzH6MbrXuJFLUX', activeFromHeight: 1300000, legacyMessageAuthority: true }, // v6
      { address: 't3NryfAQLGeFs9jEoeqsxmBN2QLRaRKFLUX', activeFromHeight: 1670000, legacyMessageAuthority: true },
      ...(isDevelopment ? [{ address: 't1Mzja9iJcEYeW5B4m4s1tJG8M42odFZ16A', activeFromHeight: 0 }] : []),
    ],
    // Authority for the v9 foundation soft-fork messages (PriceMessage,
    // PriceModifierMessage, OracleKeyMessage, MarketplacePricingMessage,
    // PolicyGroupMessage). Deliberately separate from the payment-collection
    // addresses above. Empty = fail-closed (those messages are rejected).
    // TEST VALUE (a key we control on the dev oracle server) — MUST be changed
    // to the production foundation authority address before mainnet.
    // See fluxModels PRICING_ORACLE / ROLLOUT docs.
    messageAuthorityAddress: 't1eW962yoqbfCYKzFYaZJVYzeopSmhaKL4f',
    epochstart: 694000,
    publicepochstart: 705000,
    portMinLegacy: 31000, // ports 30000 - 30999 are reserved for local applications
    portMaxLegacy: 39999,
    portBlockheightChange: isDevelopment ? 1390000 : 1420000,
    portMin: 1,
    portMax: 65535,
    bannedPorts: ['16100-16299', '26100-26299', '30000-30099', 8384, 27017, 22, 23, 25, 3389, 5900, 5800, 161, 512, 513, 5901, 3388, 4444, 123, 53],
    enterprisePorts: ['0-1023', 8080, 8081, 8443, 6667],
    upnpBannedPorts: [],
    maxImageSize: 5000000000, // 5000mb
    // Image preflight. The component count bounds what a single call can ask the
    // node to fetch from registries and the queue depth bounds how many callers
    // can commit it at once - together with running one job at a time, that is
    // what keeps an unauthenticated endpoint from becoming an amplifier. The
    // envelope window bounds how long a captured sealed request stays replayable;
    // the retention window is how long a finished job stays pollable.
    preflightMaxComponents: 10,
    preflightMaxQueuedJobs: 4,
    preflightEnvelopeMaxAgeMs: 300000,
    // Shared by every endpoint that answers 202: how long a finished operation
    // stays pollable, and the poll cadence handed to clients as Retry-After.
    operationRetentionMs: 3600000,
    operationRetryAfterSeconds: 2,
    // The playground: one unsigned spec, run once on this node, at the resources
    // it declares. The ceiling is an ADMISSION FILTER, never a degrade - a spec
    // above it is refused with the numbers, because running an app at resources
    // its owner did not ask for is the testappinstall lie this replaces.
    //
    // The duty cycle is the security wall, and it is identity-blind on purpose:
    // the per-caller limit below is fairness and attribution (FluxIDs are free to
    // mint), while one session at a time and two per hour bound what this node
    // donates to ~30 minutes and ~1 core-hour per hour however many identities
    // ask. That, times the 2-core ceiling, is what makes mining uneconomic rather
    // than merely inconvenient.
    playgroundSessionCpu: 2,
    playgroundSessionMemoryMb: 4096,
    playgroundSessionRootFsGb: 10,
    // Per image, and across the whole spec. There is deliberately no component
    // count here: a five-component app that fits in 2 cores and 4 GB costs this
    // node exactly what a one-component app using the same costs it, so counting
    // components would refuse ordinary apps (web + worker + database + cache is
    // already four) for no gain. What component count was really standing in for
    // is pull bandwidth, and that is what the aggregate budget bounds directly.
    // flux-spec caps a spec at 10 components anyway, which is what the session
    // subnet below is sized to hold.
    playgroundSessionImageMaxBytes: 2000000000,
    playgroundSessionImageTotalMaxBytes: 6000000000,
    // One reserved third octet, carved into /27s. A session needs at most ten
    // container addresses plus a gateway; a /27 has 29 usable, and eight of them
    // fit in the octet against a default of one concurrent session. Reserving
    // whole /24s instead would cost eight octets out of the 255 a node has to
    // share with up to maxAppsPerNode apps.
    playgroundNetworkOctet: 255,
    playgroundNetworkPrefix: 27,
    playgroundEgressKbit: 1000,
    // Mining looks like: pegged CPU against its own allocation, nothing ever
    // answering a probe, and running to the deadline instead of exiting. All
    // three together, because each alone describes something ordinary - a queue
    // worker also answers nothing and runs to the deadline, and a transcoder
    // also pegs a core. The block that follows is deliberately node-local and
    // keyed on a one-way fingerprint, so a node can refuse a returning caller
    // without holding anything that says who they are.
    playgroundMinerCpuBusyFraction: 0.9,
    playgroundMinerBlockMs: 86400000,
    // The RUNNING window: containers up, owner watching. Ends on whichever comes
    // first - this deadline, a cancel, or every container stopping on its own.
    // Pulls sit outside it, which is what makes the duty cycle's arithmetic hold:
    // two sessions of fifteen running minutes is the ~30 minutes and ~1 core-hour
    // per hour a node donates.
    playgroundSessionTtlMs: 900000,
    // Which nodes will serve a given caller this window, by rendezvous hash over
    // the deterministic node list. Every other control here is enforced from a
    // gossiped record and so has a window a simultaneous fan-out sits inside;
    // this one needs no message, so there is nothing for a burst to outrun.
    //
    // The size is the dial. Larger is friendlier to a caller whose nodes are
    // busy and permits a larger burst; smaller bounds harder. It is deliberately
    // well above the per-identity daily budget: places are spent on nodes that
    // are in the set but not Arcane (unknowable from chain data, so not filtered)
    // or simply busy.
    playgroundServingSetSize: 32,
    // A day. Its floor is the session TTL — a shorter window would move a
    // caller's set out from under a running session.
    playgroundServingSetWindowMs: 86400000,
    // Pin a caller's set on their resolved address rather than their FluxID.
    // The set bounds a simultaneous burst, so it keys on the thing a burster
    // cannot cheaply change: a FluxID is free to mint and each one would be a
    // fresh set, an address is the scarce resource. Requires the resolved
    // caller address — keying on the raw socket peer would map every caller
    // arriving through FDM onto one balancer and so onto one set, which is not
    // a weaker control but an outage.
    //
    // The cost is that a shared address — an office, a carrier-grade NAT —
    // shares one burst surface. Volume is not bounded here: the gossiped
    // budgets carry a limit per axis, and that is where an over-matching axis
    // is given the looser number while identity keeps the tight one.
    //
    // Changing it changes the key and never the set size, so a node with it off
    // still serves every caller and a fleet mid-rollout disagrees about which
    // 32, not about whether.
    playgroundServingSetAddressAxis: true,
    // Peak commitment, NOT total donation - the two knobs are independent. Two
    // sessions is 2 x the session ceiling held at once (4 cores, 8 GB); how much
    // a node gives away per hour is playgroundNodeSessionsPerHour below, and
    // raising this does not change it. Eight bridge slots and a /27 each were
    // sized for concurrency from the start; running one at a time was a duty
    // cycle decision rather than a limit. Their pulls are serialised node-wide,
    // because bandwidth is the one thing two sessions genuinely contend for.
    playgroundNodeConcurrentSessions: 2,
    playgroundNodeSessionsPerHour: 2,
    playgroundCallerSessionsPerHour: 3,
    playgroundWindowMs: 3600000,
    // Per-caller limits held by ONE node rather than by each node separately.
    // The per-node windows above cap what a single node gives away; they are
    // identity-blind across nodes, so they cap one caller across the fleet at
    // nothing. These are the fleet-wide numbers, and they are read by the node
    // holding the tally - never proposed by the node asking it.
    limitCounters: {
      playground: { maxConcurrent: 2, maxPerWindow: 5, windowMs: 86400000 },
      // What the DEPUTY may allow while the counter is unreachable. Deliberately
      // meaner than the real limit: a caller can work out which node holds their
      // tally, so if losing it bought a bigger allowance they would take it down
      // on purpose. Smaller means there is nothing to gain.
      'playground#deputy': { maxConcurrent: 1, maxPerWindow: 2, windowMs: 86400000 },
    },
    // A reservation must outlive the work it covers, or it expires under a running
    // session and a second is admitted beside it. Finite so a submitter that dies
    // after reserving cannot lock its caller out until the process restarts.
    limitCounterLeaseMs: 1800000,
    // How long to wait on the node holding a tally before treating it as silent.
    limitCounterAskTimeoutMs: 3000,
    limitCounterPeerAsksPerMinute: 600,
    // How long a container is given to reach a probe verdict, and how long a
    // "stayed up" pass has to stay up for. Both well inside the session TTL, so a
    // verdict is reached and reported rather than cut off by the teardown.
    playgroundProbeTimeoutMs: 180000,
    playgroundProbeStableMs: 30000,
    // A session learns what its containers are doing from docker's event
    // stream, so these are the two questions no event can answer. Nothing
    // reports that an app has bound its port, so the TCP rung knocks; and
    // nothing reports how busy a container is, so CPU is sampled. Mining
    // detection wants an average across the window rather than fine detail,
    // which is why the sampling is coarse.
    playgroundTcpRetryMs: 2000,
    playgroundCpuSampleMs: 15000,
    // Lines tailed when a follow attaches, and how many the session keeps for
    // the client. The log is FOLLOWED, so the poll returns numbered lines above
    // whatever cursor the client sends rather than re-reading and guessing.
    // Retention is bounded, and a client is told how many lines were dropped so
    // a truncated log never reads as a complete one.
    playgroundLogLines: 200,
    playgroundLogRetainedLines: 2000,
    // How long a session's sealed audit record is kept. Long enough to answer an
    // abuse report, short enough that an operator is not indefinitely holding
    // sealed records of strangers' sessions on their own hardware.
    playgroundAuditRetentionMs: 2592000000,
    // How often the node collects playground containers no live session claims.
    // Also runs once at startup, which is what cleans up after a restart: sessions
    // live in memory, so a restart abandons every container one owned.
    playgroundReapIntervalMs: 300000,
    minimumInstances: 3,
    minimumInstancesV8: 1,
    minimumInstancesV8Block: 2176519, // block height where v8+ apps can have 1 instance - expected around December 19th 2025
    maximumInstances: 100,
    maxAppsPerNode: 200,
    minOutgoing: 8,
    minUniqueIpsOutgoing: 7,
    minIncoming: 4,
    minUniqueIpsIncoming: 3,
    minHashSyncPeers: 12,
    minUpTime: 1800, // 30 mins
    appSyncPeerThreshold: 12, // peers needed before starting app sync / spawning
    appSyncDegradedThreshold: 4, // below this, pause spawner — gossip unreliable
    appSyncMinPeerUptime: 7500, // seconds a peer must have been running before we sync from it
    appSyncMinCompletions: 3, // sync responses needed per type before spawner can start
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
      delay: 30,
      composedDelay: 5,
    },
    blocksLasting: 22000, // by default registered app will live for 22000 of blocks 44000 minutes ~= 1 month
    minBlocksAllowance: 5000, // app can be registered for a minimum of this blocks ~ 1 week
    newMinBlocksAllowance: 100, // app can be registered for a minimum of this blocks ~ 3 hours - to allow users to cancel application subscription
    newMinBlocksAllowanceBlock: 1630040, // block where we will start looking at new min blocks allowance. block expected on 26th of April 2024
    cancel1BlockMinBlocksAllowance: 1, // app can be registered for a minimum of 1 block for cancellation purposes
    cancel1BlockMinBlocksAllowanceBlock: 1964447, // block where we will start allowing 1 block lifetime updates - Expected August 6th 2025
    maxBlocksAllowance: 264000, // app can be registered up for a maximum of this blocks ~ 1 year
    postPonMaxBlocksAllowance: 1056000, // after PON fork, chain works 4x faster, so max blocks is 4x higher ~ 1 year
    daemonPONFork: 2020000, // block height where PON (Proof of Node) fork activates - chain works 4x faster after this block
    blocksAllowanceInterval: 1000, // ap differences can be in 1000s - more than 1 day
    removeBlocksAllowanceIntervalBlock: 1625000, // after this block we can start having app updates without extending subscription - block expected in April 19th 2024
    ownerAppAllowance: 1000, // in case of node owner installing some app, the app will run for this amount of blocks
    temporaryAppAllowance: 200, // in case of any user installing some temporary app message for testing purposes, the app will run for this many blocks
    expireFluxAppsPeriod: 100, // every 100 blocks we run a check that deletes apps specifications and stops/removes the application from existence if it has been lastly updated more than 22k blocks ago
    updateFluxAppsPeriod: 9, // every 9 blocks we check for reinstalling of old application versions
    removeFluxAppsPeriod: 11, // every 11 blocks we check for more than maximum number of instances of an application
    reconstructAppMessagesHashPeriod: 3600, // every 5 days we ask for old messages
    benchUpnpPeriod: 6480, // every 9 days execute upnp bench
    hddFileSystemMinimum: 10, // right now 10, to be decreased to a minimum of 5GB of free space on hdd for docker with v8 specs activation
    defaultSwap: 2, // 2gb swap memory minimum, this is in gb
    applyMinimumPriceOn3Instances: 1691000, // after this block we use the min. usd price on prices per 3 instances.
    applyMinimumForExtraInstances: 1890000,
    latestAppSpecification: 8,
    bootDelayMultiplier: 1,
    spawnDelayMs: 0,
    removalSpacingMs: 60000,
    locationTtlS: 7500,
    installingTtlS: 900,
    installingRenewalS: 720, // in-flight install claim renewal cadence; undercuts installingTtlS with gossip slack
    installErrorTtlS: 86400,
    tempMsgTtlS: 3600,
    gossipValidityS: 300, // freshness window for accepting app gossip broadcasts
    clockSkewAllowanceMs: 120000, // how far a peer's self-reported timestamp may run AHEAD of ours before we distrust it. Bounds clock disagreement, NOT message usefulness, so it is deliberately not the 5-min staleness window in verifyTimestampInFluxBroadcast. Consumed by both the envelope guard in verifyFluxBroadcast and the broadcastedAt guard in messageStore; boundary tests in both suites are written relative to this value, so changing it moves the tested boundary with it rather than breaking them
    sigtermTtlS: 420, // grace window a sigterm-announced node's app rows stay alive before expiry
    hashSyncIntervalMs: 1800000,
    peerNotifyIntervalMs: 3600000,
    cpuCheckIntervalMs: 900000,
    portRestoreIntervalMs: 600000,
    imageComplianceIntervalMs: 3600000,
    tamperingCheckIntervalMs: 43200000, // 12h — how often a node re-checks whether it is on the tampering blocklist
    imageCacheEnabled: true, // master switch for the image-cache API + retention pin
    imageCachePerFluxIdQuotaGb: 20, // soft per-fluxId quota, accounted from real docker df() on-disk size
    imageCachePerImageBurstCapGb: 5, // per-image admission cap vs (compressed * 2); bounds the burst to ~one image
    imageCacheNodeMaxGb: 60, // node-wide cap across all owners (the only node-side guard until disk-fit integrates)
    imageCacheMaxConcurrentPulls: 3, // parallel pull bound (a congested registry link favours few-at-once)
    imageCacheMaxPullRetries: 3, // transient-failure retries before a pull is marked failed
    imageCacheJobTtlMs: 10800000, // in-memory download-job/progress retention (3h)
    imageReaperIntervalMs: 86400000, // cold-unused-image reaper cadence (daily; runs on ALL nodes, not gated on imageCacheEnabled)
    adoptionStaggerStepMs: 60000, // named-replica rolling-update step (floors at the app's graceful-shutdown budget)
    adoptionStaggerWindowMs: 300000, // loose-instance adoption spread window (bounds the fleet-wide restart stagger)
    orphanSweepIntervalMs: 7200000, // docker-orphan janitor cadence (containers with no installed-app row)
    dockerDebrisIntervalMs: 21600000, // docker prune cadence (stopped containers/unused networks/volumes; guarded)
    meshReconcileIntervalMs: 1800000, // mesh reconcile cadence (membership, certs incl. aged-replacement promotion, detector)
    backendTlsRenewalIntervalMs: 21600000, // managed backend-TLS renewal cadence (6h; the 30-day leaf is re-issued with ~10 days to spare, so the pace only bounds how fast a missing cert heals)
    installCollisionWaitMs: 90000,
    portTestPeerTimeoutMs: 5000, // per-peer reachability round-trip timeout
    portTestPeerQueryCount: 3, // peers queried concurrently per round - distinct prefix, excluding our own
    portTestMaxRounds: 3, // max retry rounds when a round is inconclusive (no peer answered)
    portTestPrefixLength: 16, // bits of IP prefix (whole octets) defining an "independent" peer for the reachability probe
    contentManifestReapGraceMs: 7200000, // manifests younger than this are never reaped - covers the register window where the manifest exists before the app tx confirms on-chain
    spawnReconfirmDelayMs: 7500000,
    unencryptedSpawnDelayMs: 120000,
    manageCollectorLifecycle: false, // node-managed lifecycle for shareWith dependency apps (collectors). Off: the flux console owns this lifecycle and a dependency is "ready" once installed; on: FluxOS also requires the dependency to be running before a consumer installs against it.
    globalCmdDelayMs: 500,
    discoveryAutostart: true,
    discoveryRetryMs: 60000,
    discoveryFailRetryMs: 120000,
    discoveryConnectionDelayMs: 500,
    connectionBackoffMs: [120000, 300000, 600000, 900000],
    nodeMonitorIntervalMs: 1200000,
    nodeMonitorRemovalDelayMs: 60000,
    nodeMonitorDosRecoveryDelayMs: 600000,
    nodeMonitorConfirmationLossDelayMs: 1200000,
    nodeMonitorErrorRecoveryDelayMs: 120000,
    nodeMonitorCheckTimeoutMs: 10000,
    spawnDeferrals: {
      targetedNodesMs: { encrypted: 1800000, standard: 3420000 },
      staticIpMs: { encrypted: 1620000, standard: 3420000 },
      datacenterMs: { encrypted: 1620000, standard: 3420000 },
      capacityGap: {
        largeMs: { encrypted: 1800000, standard: 7020000 },
        mediumMs: { encrypted: 1260000, standard: 5220000 },
        smallMs: { encrypted: 720000, standard: 3420000 },
      },
    },
    spawnDelayMultiplier: 1,
    daemonInfoIntervalMs: 30000,
    explorerSyncRetryMs: 120000,
    explorerDeepRestoreBlocks: 100,
    syncTimeoutMs: 120000,
    hashSyncMaxRetries: 3,
    hashSyncRetryMs: 300000,
    hashSyncSettleMs: 4000,
    hashSyncResponseTimePerHashMs: 150,
    hashSyncBufferMs: 5000,
    hashSyncMaxRounds: 4,
    hashSyncPeersPerRound: 3,
    hashSyncEphemeralPeers: 5,
    hashSyncFallbackRecheckBlocks: 100,
    manifestRefreshBlocks: 100, // steady-state content-manifest anti-entropy cadence (~50 min)
    manifestRefreshPeers: 3, // peers sampled per steady-state manifest refresh
    manifestRefreshMinPeerUptime: 30, // refresh sync-source uptime floor (s) - token, NOT the boot sync's 2h anti-flap gate
    networkStateMinFetchIntervalMs: 30000, // nodelist fetch throttle - block-driven refreshes inside this window serve the cache
    syncResponseThrottleMs: 300000,
    wsHandshakeTimeoutMs: 10000,
    imageUpdateCheckIntervalMs: 21600000,
    imageUpdateInitialDelayMinMs: 600000,
    imageUpdateInitialDelayMaxMs: 1800000,
    imageUpdateDelayBetweenAppsMs: 5000,
    imageUpdateDelayAfterRedeployMs: 120000,
    imageUpdateDelayBetweenComponentsMs: 1000,
    masterSlaveIntervalMs: 30000, // masterSlave (g:) FDM election cycle
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
      nimbus: 30000, // 28000 available for apps
      stratus: 61000, // available 59000 for apps
    },
    hdd: {
      cumulus: 220, // 180 for apps
      nimbus: 440, // 400 for apps
      stratus: 880, // 840 for apps
    },
    collateral: { // tbd during forks
      cumulusold: 10000,
      nimbusold: 25000,
      stratusold: 100000,
      cumulus: 1000,
      nimbus: 12500,
      stratus: 40000,
    },
  },
  syncthing: { // operates on apiPort + 2
    ip: '127.0.0.1',
    port: 8384,
    monitorIntervalMs: 30000, // syncthingApps reconfiguration/sync-readiness cycle
    // stall ladder (receive-only convergence): wait -> device pause/resume nudge with
    // doubling backoff -> removal only with a connected synced peer, repeated nudges
    // and zero progress over the minimum window
    stallNudgeAfterMs: 180000, // 3min idle with no byte progress before the first nudge
    stallNudgeMaxIntervalMs: 900000, // nudge backoff cap (15min)
    stallRemoveMinWindowMs: 1200000, // 20min minimum evidence window before removal
    stallRemoveMinNudges: 3, // nudges that must have failed before removal
  },
  // enterpriseAppOwners moved to helpers/enterprisenodes.json (synced from github every 6h, see enterpriseConfig)
  enterprisePublicKeys: [ // list of whitelisted nodes indentity public keys. Most trusted node operators that are publicly known, kyc. Eg Flux team members, Titan.
    '045bd4f81d7bda582141793463edb58e0f3228a873bd6b6680b78586db2969f51dfeda672eae65e64ca814316f77557012d02c73db7876764f5eddb6b6d9d02b5b',
    '042ebcb3a94fe66b9ded6e456871346d6984502bbadf14ed07644e0eb91f8cc0b1f07632c428e1e6793f372d9c303d680de80ae0499d51095676cabf68599e9591',
    '040a0f94fdbd670a4514a7366e8b5f7fbfb264c6ca6ea7d3f37147410b62a50525d1ed1ac83dac029de9203b9cabcf18a01b82e499ba36ea51594fd799999b2a26',
    '04092edca3ed2d2b744a1d93e504568e9d861f38232023835202c155afa9f74e3779c926745a4157a7897ca6dca30aa78aa26e4ee11101ce20db9fc79b686de5f0',
    '045964031bb8818521b99f16d2614f1bc8a9968184c9c38dc09cf95b744dae0f603ff3bbecc7845d952901ebabeb343cdcde3c4325274901768dfb102b9a34f5d6',
    '0459f5c058481d557fb63580bfbf21f3791a2f3a62a62c99b435fd8db1d59e21353bdae35cfe00adaf7c4f2f0d400afc698e9c58ee6a3894c20706b3db7da83750',
    '040ecac42ff4468fa8ae094e125fb8ae67c1a588e7b218ac0a9d270bba882c19db656b7b5d99b1af0fe96c34475545088a5bd87efb9a771174bcdd7fb499dd7ca3',
    '04a52af6e9688fcb9d47096f8a15db67131f9b0bbfb50c28fd22028d9fba18f4e9bd3293b43ed64634dbba11688b4e37f1f8e65629b6a204df352d3ecfb174b9f5',
    '04ce029f9d17da47809cbde46e0ea2eace185f79f98e5718cb4ddc3d84bfd742cd3e3951388fcd2771238ab323fe22d53c3dced2a30326ead0447b10f7db0a829b',
    '04dbbf2ba07d28b0010f4faa0537d963b3481b5d8e7ec0de29f311264a4ab074d4d579aca1c2aa3eb31e96f439a6d6bbf72393584049923f342ed4762f13fe7be4',
    '043c4fe1606c543ca28f107245166321fae026300747a608db94deecbcd2d945f86b29c52a33416464e7823a6c2e3e45c26733f6378be973959cbf9ee4bff79e66',
    '04a898a0bc768ad0b8456b4da7c1e653a715477926fefb47ef20d8bd841854ddf4e1f59c1c3d55f0088eaca53b850e6ab03d0bd00d0b5a70d17ffbc0554b6188d5',
    '0455a20efde6a0685fa15b020e694674170376bc7c23d203e96fb927717db38011b87c36b2f81c5cf68123c5567abf2b29788231966ea4c43c4f5cb759e4c5cdbb',
    '04c765d054bcded999c404145c7396725df81973fe803b3da5e9455173410743f43e20294e17bb41adff8b4ff1ab5540b8bcd98521b438840b6a38e904eb0b247f',
    '03cf1d8b708ca7f5979accb4d0dba35a90391e3dfc4422cf12670c929bb58d16ac',
    '03e29783936a36b396c28706494dbfd35f3d087f2addeb3df32e451f71bf9a53f3',
  ],
  // Pubkeys of nodes that opt into the enterprise network. A node whose own
  // fluxnode pubkey is in this list will only spawn/run apps owned by the
  // enterprise app owners and will uninstall any non-matching apps on boot.
  // Moved to helpers/enterprisenodes.json (synced from github every 6h, see enterpriseConfig)
  cpuBurst: {
    // Enables CFS CPU burst for enterprise app owners on cgroups-v2 + kernel >= 5.14 hosts.
    // The kernel rule (cgroup-v2: 0 <= cpu.max.burst <= cpu.max quota) lets a container
    // temporarily peak at up to 2x its base allocation in any single CFS period, drawing from
    // a bank that fills with unused idle quota from prior periods.
    //
    // reservedCores caps each container's peak so it cannot consume the entire host during a
    // burst window: peak <= (hostCpus - reservedCores) * period. This is a per-container cap,
    // not a host-aggregate budget — multiple burstable apps on the same host can collectively
    // oversubscribe during simultaneous spikes, which CFS handles by sharing fairly.
    enabled: true,
    periodUs: 100000, // CFS period in microseconds (100ms, Linux default)
    reservedCores: 1, // cores reserved for system services; bounds any single container's burst peak
  },
  registryAuth: {
    // Token refresh buffer in milliseconds
    // Tokens will be refreshed when they expire within this time window
    // Default: 15 minutes (15 * 60 * 1000 = 900000ms)
    tokenRefreshBufferMs: 15 * 60 * 1000,
  },
  github: {
    apiBaseUrl: 'https://api.github.com',
  },
  // The load balancers whose X-Forwarded-For this node will believe. A request
  // arriving from any other address has its forwarding headers ignored entirely:
  // every node is reachable directly on its public port, so a header from an
  // unknown peer is chosen by the caller and says nothing.
  //
  // These are the addresses a node OBSERVES as its socket peer - each balancer's
  // public egress - which is not the same as the address its hostname resolves to
  // and not the management address ansible targets it on. Confirmed two ways
  // (inventory plus DNS) before being listed, because a wrong entry here hands
  // that address the power to name any client it likes, while a missing one only
  // costs attribution on that path.
  //
  // Empty is safe and means "trust nothing", which is how this behaves for any
  // balancer not yet listed.
  fdmAddresses: [
    // apps, production
    '5.39.57.42', '5.39.57.43', '5.39.57.44', '5.39.57.45',
    '146.190.83.190', '146.190.103.145', '134.209.107.70', '146.190.105.10',
    '5.161.211.14', '5.161.178.20', '5.161.42.73', '5.161.81.155',
    // apps, staging
    '5.161.215.75', '5.161.109.34', '5.39.57.46', '5.39.57.47',
    // main
    '128.199.246.121', '5.161.44.226',
    // nodes - the per-node API hostnames the frontend pins to after login, and so
    // the path a playground submission takes. These two are the whole fleet; they
    // are absent from the ansible inventory and deployed by hand, so a change to
    // the balancers will not show up here on its own.
    '5.39.57.41', '5.161.198.150',
  ],
  policy: {
    // The directory holding the network's enforcement documents, fetched at runtime by
    // policyStore. A repo of its own, so a merge to the application cannot change fleet
    // policy as a side effect and a policy change is not a commit to the application's
    // default branch. Releases predating this still read RunOnFlux/flux helpers/, so both
    // copies are kept in step until minimumFluxOSAllowedVersion is above all of them.
    baseUrl: 'https://raw.githubusercontent.com/RunOnFlux/fluxos-network-policy/main',
    // Keyed by the names policyStore registers.
    refreshIntervalMs: {
      blockedRepositories: 21600000, // 6h
      tamperingBlocklist: 43200000, // 12h
      enterpriseNodes: 21600000, // 6h
      ipLocationTable: 86400000, // 24h
    },
    // The location table is megabytes where the rest are kilobytes, so ten seconds would
    // time out on any node without a fast link.
    fetchTimeoutMs: {
      default: 10000,
      ipLocationTable: 120000,
    },
  },
  stats: {
    // Flux stats service (module minimum versions, marketplace listapps, app USD pricing).
    apiBaseUrl: 'https://stats.runonflux.io',
  },
  fiatRates: {
    ratesUrl: 'https://viprates.runonflux.io/rates',
  },
  fdm: {
    // Per-region FDM API bases; %i is the app's deterministic server index
    // (getFdmIndex, by app-name first letter).
    regions: [
      { name: 'EU', baseUrlTemplate: 'http://fdm-fn-1-%i.runonflux.io:16130' },
      { name: 'USA', baseUrlTemplate: 'http://fdm-usa-1-%i.runonflux.io:16130' },
      { name: 'ASIA', baseUrlTemplate: 'http://fdm-sg-1-%i.runonflux.io:16130' },
    ],
  },
  geolocation: {
    ipApiBaseUrl: 'http://ip-api.com',
    statsApiBaseUrl: 'https://stats.runonflux.io',
  },
  analytics: {
    url: 'https://cloudaudit.runonflux.io', // analytics server URL (e.g. 'https://analytics.runonflux.io'). Empty = disabled.
  },
  marketplace: {
    // v2 marketplace API (versioned v9 templates). Dev/prod switched by the development flag.
    apiBaseUrl: isDevelopment ? 'https://api-dev.marketplace.runonflux.io' : 'https://api.marketplace.runonflux.io',
  },
  fluxDrive: {
    // FluxDrive blob API base for content delivery (upload + fetch-by-locator). Set
    // per environment; empty disables content uploads (the client fails loud).
    blobApiUrl: '',
  },
};
