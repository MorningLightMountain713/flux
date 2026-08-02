// eslint-disable-next-line prefer-const
let userconfig = require('../../config/userconfig');
const volumeToolsImage = require('./volumeToolsImage.json');

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
    daemonExpiredMs: 19200000,
  },
  server: {
    allowedPorts: [16127, 16137, 16147, 16157, 16167, 16177, 16187, 16197],
    apiport: 16127, // homeport is -1, ssl port is +1
    fluxNodeServiceAddress: '169.254.43.43',
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
        geolocation: 'geolocation',
        benchmark: 'benchmark',
        appTamperingEvents: 'apptamperingevents',
        nodeStartupTracker: 'nodestartuptracker',
        nodeIdentity: 'nodeidentity', // node runtime state generated/discovered by FluxOS: the PGP keypair and the last-known external IP
        policyDocuments: 'policydocuments', // last-known-good network policy documents, so an unreachable source does not drop enforcement
        ipRanges: 'ipranges', // the IP location baseline, one document per allocated range, rebuilt and swapped in whole
        nodeLocations: 'nodelocations', // per-node view derived from the baseline, invalidated when a new baseline lands
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
  },
  minimumFluxBenchAllowedVersion: '6.2.0',
  minimumFluxOSAllowedVersion: '8.18.0',
  // The NodeJS this process runs on. Below the floor a node fails whichever
  // paths need what the runtime lacks, one at a time and silently, instead of
  // reporting itself unfit. Unset allows: the check runs bare in
  // startFluxFunctions, whose catch re-enters it.
  minimumNodeJsAllowedVersion: '20.8.0',
  minimumSyncthingAllowedVersion: '2.0.10',
  minimumDockerAllowedVersion: '26.1.2',
  fluxTeamFluxID: '1hjy4bCYBJr4mny4zCE85J94RXa8W6q37',
  // A list, so support can be granted to (or revoked from) an identity without
  // touching every privilege check. A bare string is still read as a one entry
  // list, so a node carrying an older local override keeps working.
  fluxSupportTeamFluxID: [
    '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1',
    '15c3aH6y9Koq1Dg1rGXE9Ypn5nL2AbSJCu',
    '1NGqYirE4T9wzd1ZcGrw3HjETiuCkt6Sgy',
    '13BBPcpHxwCaC61vjQgK6qeDcprFJEGVkP',
  ],
  deterministicNodesStart: 558000,
  fluxapps: {
    latestSupportedSpecVersion: 8, // version changes on app updates must target this version
    // reconciler crash-recovery backoff: ladder of waits between restart attempts,
    // and the run length that counts as stable (resets the ladder)
    crashBackoffDelaysMs: [0, 30000, 300000, 900000, 1800000],
    crashBackoffStableRunMs: 600000,
    // Backstop for images whose entrypoint discards the payload's exit status.
    // A clean exit proves nothing, so for those images restart RATE is the only
    // fault evidence left and this is the only thing that ever paces them.
    // This many automatic restarts inside the window is treated as a crash and
    // enters the ladder above, which reaches anything restarting closer together
    // than window/count - 60s apart at these values. Slower is deliberately left
    // alone: Palworld's segfault-restart cycle is ~77s at its worst, and coming
    // straight back is better for the customer than being paced.
    // Keep the window wider than the reconciler's retry interval times this
    // count. A container that fails to START never ran, so it is never a fault
    // and never walks the ladder directly - it reaches it only by filling this
    // window, and a window narrower than that retries forever.
    // Counted as restarts ALREADY RECORDED, so at 5 the sixth restart is the one
    // that earns a rung and the seventh is the first one held back.
    restartBurstCount: 5,
    restartBurstWindowMs: 300000,
    // How long a finished operation stays readable at /apps/operations/:jobId,
    // and how long a client is told to wait between polls while one runs. A
    // RUNNING job never expires - only terminal ones are retained on a clock.
    operationRetentionMs: 60 * 60 * 1000,
    operationRetryAfterSeconds: 2,
    // File operations on an app's volume, each run in a throwaway container.
    volumeOperations: {
      // The tag is the NAME and the id is the PROOF, and they rotate together.
      //
      // In their own file because the harness reads them too, and reads them
      // from here rather than repeating them: a rebuilt image must not leave
      // the harness testing something the fleet does not run. It cannot
      // `require` this config to get at them - line 2 pulls in userconfig.js,
      // which is gitignored and absent from a fresh checkout - so it used to
      // match them out of this source with a regular expression, and changing
      // the shape of a pin broke the runner rather than the thing under test.
      //
      // A tag alone decides nothing: it is mutable at the registry, and one
      // inside an image a peer hands over is whatever that peer wrote in it. So
      // what a node runs is decided by the image id - the digest of the image's
      // own config - which is checked on every path, whether the image arrived
      // from the registry, from a peer, or was already here. An id is per
      // architecture, hence one for each.
      //
      // ROTATING THIS MEANS CHANGING BOTH, which is why they sit together. An
      // id belongs to a specific build: the same commit rebuilt under a new tag
      // carries different labels and therefore a different id. Read them from
      // the release that published the tag, never from a previous one. A tag
      // moved without its ids is refused by every node, loudly, which is the
      // right direction to fail in but is not something to discover during a
      // rollout.
      //
      // It also means rotating the image needs a FluxOS release, which is
      // deliberate rather than a limitation to work around. What the image does
      // is coupled to the code that drives it - the staging names it creates are the
      // ones swept here, so a change to one is a change to both - and the
      // alternative,
      // publishing the pin where the fleet reads policy, would let a merge
      // choose the program every node runs as root over an app's volume, with
      // no staged rollout. The urgency that would buy is small: the container
      // has no network, a read-only rootfs, every capability dropped but three,
      // and one volume mounted, so a CVE in what it packages is not reachable
      // the way one in a network-facing service is.
      //
      // What the image DOES is proven in its own repository, not here: the
      // ceiling, the link refusal, discarding staging, the atomic exchange the
      // publish is made of, and the signal handling all have tests there
      // that run in a container configured exactly as this one configures it,
      // on both architectures. Nothing in this repository can exercise them,
      // and a reviewer looking only here should not conclude they are
      // unexercised.
      ...volumeToolsImage,
      // One per app stops a single owner monopolising a node; the node-wide cap
      // stops the disk being saturated by several at once. A reached limit is
      // refused rather than queued - a queued request waits silently behind
      // someone else's long copy until an intermediate proxy kills it.
      // How widely the fleet's registry fetch is spread. Only the registry is
      // spread: it is the one place every node reaches at once, where asking
      // peers costs the fleet nothing it does not already have. Configurable so
      // a test fleet can watch a window it would otherwise sit inside of.
      prefetchWindowMs: 6 * 60 * 60 * 1000,
      maxConcurrentPerApp: 1,
      maxConcurrentPerNode: 4,
      // How long an operation may make NO progress before it is stopped. Not a
      // limit on how long it may run: moving a hundred gigabytes legitimately
      // outruns any wall clock short enough to be useful, and a fixed ceiling
      // cannot tell that from a wedged container. The volume's own usage is
      // read every tick anyway, so "has this written or deleted anything at
      // all recently" is free and is the question actually worth asking.
      // Generous, because a slow disk under load is not a stuck one.
      stallTimeoutMs: 10 * 60 * 1000,
      // The floor an upload has to keep to count as still sending. Bytes from
      // the caller are the only evidence a slow upload is alive - it moves no
      // whole filesystem block for minutes, so the volume reads as idle - but
      // the evidence has to be a RATE. Treating any byte at all as progress
      // lets one byte per window hold a slot until the request itself times
      // out two hours later, and four of those block every file operation on
      // the node for every app on it.
      //
      // Set where a caller below it could not finish anyway: 64 kbit/s carries
      // ~58MB in the two hours server.requestTimeout allows, so this mostly
      // writes down a limit that already exists. It clears the worst usable
      // mobile link by a wide margin and sits thousands of times above the
      // trickle it is here to stop.
      minUploadBitsPerSecond: 64 * 1000,
      // Bounds a runaway archive. How much can be WRITTEN is already capped by
      // the size of the volume itself.
      memoryBytes: 512 * 1024 * 1024,
      pidsLimit: 256,
      // One core per operation. tar and zip are single-threaded, so this mostly
      // writes down what they already use - what it bounds is the tool that is
      // not: anything in the image that spawns workers has pidsLimit's worth of
      // processes to do it with, and without a quota one operation takes every
      // core the node has. The worst case across the pool is
      // maxConcurrentPerNode cores, and contention inside it is settled by
      // CpuShares in the executor's HostConfig: file operations yield to the
      // applications, which are the tenants the node is for.
      cpuCores: 1,
      // How long a cancelled operation is given to stop of its own accord. The
      // container is sent SIGTERM, which flux-op traps to stop the command and
      // reclaim its staging directory; only after this does docker escalate to
      // SIGKILL, which reaches neither - the executor's own deferred reclaim
      // then removes what was staged. Long enough to remove a large staging
      // tree, short enough that a cancel still feels like one.
      cancelGraceSeconds: 15,
      // How often a running operation is looked at: one tick reports that it is
      // alive, notices a cancellation, and reads how far it has got. Nothing is
      // holding a request open to receive any of it - the endpoints answered 202
      // before the work began - so this is the resolution of a poll, not a
      // keepalive.
      progressIntervalMs: 2000,
      // The free space an operation writing into staging leaves the
      // application. Below it the operation is stopped and its staging
      // reclaimed. It is read every progressIntervalMs, so it has to cover what
      // the operation and the application can write between two reads: 64 MiB
      // is 32 MB/s from each over one 2 s tick.
      minFreeBytes: 64 * 1024 * 1024,
    },
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
    // Who the support team is, from which height. Only the latest fork at or below
    // a message's own block is consulted, so entries are only ever appended: an
    // edit to one below the tip changes which signatures the past accepts.
    teamSupportAddress: [{
      height: 1851659, // height from which address is valid
      address: '16iJqiVbHptCx87q6XQwNpKdgEZnFtKcyP',
    }, {
      // From here a fork names a list rather than one address. The address above
      // is carried forward - a fork replaces its predecessor rather than adding
      // to it, so leaving it out would stop it signing.
      //
      // Dated about a week ahead of the tip it was written at (2931010, 7th
      // September 2026, ~30s blocks) rather than at it: a node on an older FluxOS
      // reads only the fork at 1851659 and rejects a message signed by any of the
      // new addresses, so the fork has to fall after the network has had time to
      // update.
      height: 2951000, // ~14th September 2026
      addresses: [
        '16iJqiVbHptCx87q6XQwNpKdgEZnFtKcyP',
        '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1',
        '15c3aH6y9Koq1Dg1rGXE9Ypn5nL2AbSJCu',
        '1NGqYirE4T9wzd1ZcGrw3HjETiuCkt6Sgy',
        '13BBPcpHxwCaC61vjQgK6qeDcprFJEGVkP',
      ],
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
    // Flux storage is the only host a storage link may address. The node
    // dereferences F_S_ENV and F_S_CMD with its own signed identity before it
    // starts a container, so the target is not the specification author's to
    // choose. The harness reaches a stand-in under this same name - the stub
    // carries it as a docker network alias and its certificate as a SAN - so
    // the value is not overridden anywhere and a config that changed it would
    // fail TLS against that certificate.
    storageHost: 'storage.runonflux.io',
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
    playgroundSessionTtlMs: 900000,
    playgroundNodeConcurrentSessions: 1,
    playgroundNodeSessionsPerHour: 2,
    playgroundCallerSessionsPerHour: 3,
    playgroundWindowMs: 3600000,
    // How long a container is given to reach a probe verdict, and how long a
    // "stayed up" pass has to stay up for. Both well inside the session TTL, so a
    // verdict is reached and reported rather than cut off by the teardown.
    playgroundProbeTimeoutMs: 180000,
    playgroundProbeStableMs: 30000,
    playgroundLogLines: 50,
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
    appSyncMinCompletions: 3, // sync responses needed per type before spawner can start
    // Applies ONLY to peers whose build cannot refuse a sync request - one that
    // can is asked whatever its uptime, because it answers for itself. Retires
    // with the last such build.
    appSyncMinPeerUptime: 7500,
    // How long a node waits for a state sync before deciding that what it has
    // is what it gets. Both roads to readiness, and to answering another node's
    // sync request, so a node with a 0 here is authoritative from the moment it
    // starts - which is how a fleet gets a peer that can answer at all.
    //
    // 125 minutes is locationTtlS below, in minutes: one full lifetime of a
    // running-app location record, so every holder has had to announce itself
    // at least once. That is what makes waiting it out equivalent to a view,
    // and it is why there is no shorter variant of it for anyone.
    appSyncFallbackMinutes: 125,
    // A NODE WHOSE PEER SET KEEPS COLLAPSING SHOULD BE TAKEN OUT OF SERVICE.
    //
    // A "dip" is the fall edge of the same hysteretic pair the rest of this
    // block uses: the peer count crossing below appSyncDegradedThreshold having
    // been above appSyncPeerThreshold. That is not a wobble. Measured over a
    // random sample of 228 fleet nodes and ~20,700 node-hours (2026-09-12), a
    // node carries 26 peers at the tenth percentile and 36 at the median, and
    // the lowest count seen at any of 890 connectivity diagnoses was 7 - not one
    // observation at or below 4. Reaching the floor means losing roughly ninety
    // per cent of the peer set, so one dip is already an outage rather than a
    // bad minute, and the tally is a count of outages.
    //
    // Five, not the three that "keeps dipping in and out" would justify on its
    // own, because a regional network outage can take the whole set and a node
    // must not lose its customers' apps over one of those. Deliberately loose
    // to begin with: the rule is inert on the healthy fleet at any of these
    // values, and it is easier to tighten a threshold that never fires than to
    // give an operator their volumes back.
    //
    // NOT the 5-in-2-hours of UNSTABLE_DISCONNECT_THRESHOLD in FluxPeerManager,
    // which they happen to match. That one counts disconnects of INDIVIDUAL
    // peers, where there are three dozen candidates and five events is cheap.
    // This counts the node's own set, which is one thing. Same numbers, and
    // they are not the same number.
    peerSetDipDosThreshold: 5,
    peerSetDipWindowMinutes: 120,
    // Only the RELEASE needs a clock. A dip is judged as it arrives; a node that
    // has stabilised produces no events at all, so without a tick it would hold
    // the DOS until something unrelated happened to it.
    //
    // Coupled to the window, not chosen: it is the granularity of a two-hour
    // decision, so the pair compresses together. 120:1 is the ratio a harness
    // has to keep when it shortens the window, or the suite is measuring the
    // tick instead of the rule.
    peerSetDipEvaluateMs: 60 * 1000,
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
    ownerAppAllowance: 1000, // a by-name local install (fluxteam only) runs for this amount of blocks before the expiry sweep removes it
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
    // Per-document expiry for the ephemeral app collections, in seconds, read by
    // appConstants.js. Each record carries its own deadline and the collection
    // index is expireAt/expireAfterSeconds:0, so changing one of these takes
    // effect on records written after it, not on the ones already stored.
    // A running-app location record: 125 minutes. It also SETS how often a node
    // announces - appConstants derives the interval from it, two announcements
    // to a lifetime with slack, so the pair cannot drift. There is no separate
    // announce interval to keep in step with this number.
    locationTtlS: 7500,
    // Grace after a node announces its own shutdown, before peers drop its
    // locations. MUST stay below locationTtlS: appStartupManager expires on
    // `(cleanShutdown && downtime > sigterm) || downtime > running`, so a value
    // above the running expiry makes this window unreachable and a clean
    // shutdown gets no grace at all.
    sigtermExpiryS: 420,
    installingTtlS: 900, // an in-progress install: 15 minutes
    // Renewal cadence for an in-flight install's fluxappinstalling claim. MUST
    // undercut installingTtlS with slack for gossip propagation, or a live install
    // loses the seat it is still using. Absent, appConstants derives 80% of the TTL.
    installingRenewalS: 720,
    // Freshness window for accepting an app gossip broadcast. Compressed with the
    // TTLs above by the harness; a window that does not move with them makes peers
    // refuse each other's current messages.
    gossipValidityS: 300, // freshness window for accepting app gossip broadcasts
    // 24 hours. This was 3600 while a collection-level TTL index on `cachedAt`
    // drove it; that index was dropped when expiry moved per-document, and the
    // key kept the old mechanism's number for three months while nothing read
    // it. The 24h the code has actually run since is the value.
    installErrorTtlS: 86400,
    tempMsgTtlS: 3600, // collection-level index, serviceManager.js
    clockSkewAllowanceMs: 120000, // how far a peer's self-reported timestamp may run AHEAD of ours before we distrust it. Bounds clock disagreement, NOT message usefulness, so it is deliberately not the 5-min staleness window in verifyTimestampInFluxBroadcast. Consumed by both the envelope guard in verifyFluxBroadcast and the broadcastedAt guard in messageStore; boundary tests in both suites are written relative to this value, so changing it moves the tested boundary with it rather than breaking them
    hashSyncIntervalMs: 1800000,
    cpuCheckIntervalMs: 900000,
    statsSampleIntervalMs: 60000,
    portRestoreIntervalMs: 600000,
    // How long a node waits, at most, before acting on a blocklist change. Adoption
    // reaches the fleet within seconds of itself, so a pass taken on arrival would put
    // every node's removals - and the broadcast of each one - into the same moment.
    // Each node picks a point in this window instead.
    complianceSweepStaggerMs: 120000,
    // Between one removal and the next on a node. The stagger above spreads the fleet;
    // this spreads one node's own.
    complianceRemovalSpacingMs: 180000,
    // An application the sweep could not finish with is asked again on this, doubling
    // to the ceiling. It covers what has no event to wait on: an enterprise
    // specification that did not decrypt, and a removal that threw.
    complianceRetryBaseMs: 60000,
    complianceRetryMaxMs: 3600000,
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
    backendTlsRenewalIntervalMs: 21600000, // managed backend-TLS renewal cadence (6h; the 30-day leaf is re-issued with ~10 days to spare, so the pace only bounds how fast a missing cert heals)
    installCollisionWaitMs: 90000,
    portTestPeerTimeoutMs: 5000, // per-peer reachability round-trip timeout
    portTestBindDelayMs: 5000,
    portTestPropagationDelayMs: 10000,
    portTestMaxAttempts: 5,
    // Asking the other Flux nodes at our own public address which ports they
    // hold. Short: they are one hop away, and a sibling that does not answer
    // promptly is left unasked rather than delaying an install - the port test
    // that follows is what decides.
    siblingPortsTimeoutMs: 5000,
    // How long a signed sibling ask stays good for. The exchange itself is
    // bounded by siblingPortsTimeoutMs; the rest is allowance for two nodes
    // that were never required to agree on the time.
    siblingAskValidityMs: 60000,
    portTestPeerQueryCount: 3, // peers queried concurrently per round - distinct /16, excluding our own
    portTestMaxRounds: 3, // max retry rounds when a round is inconclusive (no peer answered)
    portTestPrefixLength: 16, // bits of IP prefix (whole octets) defining an "independent" peer for the reachability probe
    contentManifestReapGraceMs: 7200000, // manifests younger than this are never reaped - covers the register window where the manifest exists before the app tx confirms on-chain
    spawnReconfirmDelayMs: 7500000,
    unencryptedSpawnDelayMs: 120000,
    manageCollectorLifecycle: false, // node-managed lifecycle for shareWith dependency apps (collectors). Off: the flux console owns this lifecycle and a dependency is "ready" once installed; on: FluxOS also requires the dependency to be running before a consumer installs against it.
    globalCmdDelayMs: 500,
    // How many times a global command retries a node that answers 503 while it
    // is still reconciling its apps after boot. The refusal carries a 15s
    // Retry-After, so this is ~2 minutes of coverage - long enough for a
    // booting node to settle, bounded so a genuinely wedged one is not hammered.
    globalCmdBootRetries: 8,
    discoveryAutostart: true,
    discoveryRetryMs: 60000,
    discoveryFailRetryMs: 120000,
    discoveryConnectionDelayMs: 500,
    connectionBackoffMs: [120000, 300000, 600000, 900000],
    nodeMonitorIntervalMs: 1200000,
    nodeMonitorRemovalDelayMs: 60000,
    // Residential-node staging. The placement hold is immediate and is not
    // tunable; these pace only the part that moves customer data.
    residentialCheckIntervalMs: 6 * 60 * 60 * 1000, // re-evaluate the verdict
    residentialSettleMs: 24 * 60 * 60 * 1000, // verdict must hold before any app moves
    residentialEvacuationIntervalMs: 6 * 60 * 60 * 1000, // minimum gap between departures
    residentialQueueBaseMs: 30 * 60 * 1000, // every node waits at least this
    // Per position in the instance order, and it MUST stay longer than the pass
    // that reads it. mayEvacuateApp is reached only from the give-up pass at
    // explorerService.js:651, which runs every removeFluxAppsPeriod (11) x
    // speedMultiplier (4 post-PON) = 44 blocks = 22 minutes at 30s blocks, and
    // wholeSince is stamped inside that pass - so maturity is quantised to a
    // 22-minute grid and a shorter step cannot separate two points on it.
    // Adjacent positions would mature on the same pass, and the pass is keyed on
    // block height so every node evaluates in the same instant. Both holders
    // then read the app at full strength, because fluxappremoved is broadcast
    // after the volume is already deleted. 40 minutes is 1.8x the pass, so the
    // chain would have to slow to ~55s blocks before adjacent positions could
    // meet. Asserted against production's own config in the unit tests.
    residentialQueueStepMs: 40 * 60 * 1000,
    nodeMonitorDosRecoveryDelayMs: 600000,
    nodeMonitorConfirmationLossDelayMs: 1200000,
    nodeMonitorErrorRecoveryDelayMs: 120000,
    nodeMonitorCheckIntervalMs: 120000,
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
    // NOT how often the chain is asked. pollForNewBlocks reads a height cached
    // by daemonServiceMiscRpcs and refreshed on the daemonInfoIntervalMs timer
    // above, so this is the rate at which the node works THROUGH blocks once it
    // knows it is behind. Its share of that refresh window - 5000/30000, 16.7% -
    // is what decides whether a block is still the tip when it is processed,
    // and everything hung off block processing inherits that.
    explorerPollIntervalMs: 5000,
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
    masterSlaveStaggerMs: 180000, // per-place wait before an instance may take an empty g: primary
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
    // How long a node goes without a successful health probe before it reports
    // syncthing down. Four missed passes of the 60s sentinel loop: wide enough
    // that a slow adjustSyncthing or a couple of blips cannot mark the node
    // down, short enough that a real outage is reported within minutes. It is
    // also the grace the sentinel gets to land its FIRST probe, after which
    // silence is a fault rather than an absence.
    healthWindowMs: 300000,
    // The sentinel's own cadence. The window above is four missed passes of
    // this, so a suite that shortens one must shorten the other - shorten the
    // window alone and a healthy node goes stale between two good probes.
    sentinelIntervalMs: 60000,
    // stall ladder (receive-only convergence): wait -> device pause/resume nudge with
    // doubling backoff -> removal only with a connected synced peer, repeated nudges
    // and zero progress over the minimum window
    stallNudgeAfterMs: 180000, // 3min idle with no byte progress before the first nudge
    stallNudgeMaxIntervalMs: 900000, // nudge backoff cap (15min)
    stallRemoveMinWindowMs: 1200000, // 20min minimum evidence window before removal
    stallRemoveMinNudges: 3, // nudges that must have failed before removal
    // Where a legacy node installs syncthing from. Arcane nodes ship it in the image and
    // never reach either of these.
    aptSourceUrl: 'https://apt.syncthing.net/',
    releaseKeyUrl: 'https://syncthing.net/release-key.gpg',
  },
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
    // main - one geo-steered name over three regional balancers, so resolving
    // it from a single location returns that region's alone. The eu box is in
    // the ansible inventory by its private address only.
    '5.39.57.40', '128.199.246.121', '5.161.44.226',
    // nodes - the per-node API hostnames the frontend pins to after login, and so
    // the path a playground submission takes. These two are the whole fleet; they
    // are absent from the ansible inventory and deployed by hand, so a change to
    // the balancers will not show up here on its own.
    '5.39.57.41', '5.161.198.150',
  ],
  github: {
    // The REST API only. Nothing here reads files from github: the policy documents are
    // served from config.policy.baseUrl.
    apiBaseUrl: 'https://api.github.com',
  },
  policy: {
    // The directory holding the network's enforcement documents. A repo of its own, so a
    // merge to the application cannot change fleet policy as a side effect and a policy
    // change is not a commit to the application's default branch.
    //
    // `main` is what people edit. `signed` is what nodes read: the same documents, bundled
    // under one signature with a sequence number. baseUrl stays for the releases that fetch
    // the plain documents directly and for the artifact they name.
    baseUrl: 'https://raw.githubusercontent.com/RunOnFlux/fluxos-network-policy/main',
    signedBaseUrl: 'https://raw.githubusercontent.com/RunOnFlux/fluxos-network-policy/signed',
    // Raw ed25519 public keys. A bundle signed by ANY of them is accepted, so the cold key
    // can take over signing without every node needing a release first -- which is the only
    // thing a second key buys. Removing a compromised key from this list IS a release.
    // Kept in step with SIGNING.md in fluxos-network-policy.
    publicKeys: [
      'c31930ec386a49f31321851766d93bcb90bf269cd15bec7a329155a4d79ea380',
      '739ca41408f66c75d6cb4bc1d5c044ca5a118de190081da68e5a7d6839fb69f8',
    ],
    // The backstop poll. Long, because it is not how a change reaches a node: adoption
    // is announced to peers and spreads outwards in seconds. This covers the node that
    // missed the announcement -- offline at the time, or with no peers holding it yet --
    // and the cold start where there is nothing to miss.
    //
    // CONFIG, not a constant, so the harness can compress it. A 24-hour tick is
    // unobservable in a test, and a suite that cannot watch the backstop fire has to
    // restart a node to approximate it - which tests the boot path instead, and leaves
    // the periodic one with no coverage at all.
    refreshIntervalMs: {
      blockedRepositories: 21600000, // 6h
      tamperingBlocklist: 43200000, // 12h
      enterpriseNodes: 21600000, // 6h
      ipLocationTable: 86400000, // 24h
    },
    // How long a refresh waits for a peer to answer before falling through to the
    // source. Peers are on the local network and answer in milliseconds; this bounds how
    // long a refresh is prepared to sit doing nothing, so it is an ABSOLUTE latency
    // bound and does not compress with the clocks.
    peerWindowMs: 3 * 1000,
    // Bound on a single backstop fetch, so a boot is never stuck on one source. Absolute,
    // for the same reason as above.
    fetchTimeoutMs: {
      default: 10000,
      ipLocationTable: 120000,
    },
    // How long a FAILED backstop fetch stands as the answer before the source is asked
    // again. The decision to ask is derived from the peer picture and re-evaluated
    // whenever it changes, which is right - but a peer connecting says nothing about
    // whether the source is reachable, so without this every connect and disconnect
    // re-asks a source that just refused. Worst in the first rollout wave: peers that
    // predate the protocol are never asked, so nothing is ever outstanding and every peer
    // event reaches the source, across the whole fleet, against one rate-limited host.
    //
    // A floor, not a backoff: it does not grow, it caps no number of attempts, and the
    // next peer event after it passes tries again. A minute costs an inert node a minute.
    //
    // CONFIG, not a constant, for the reason refreshIntervalMs is: a suite that cannot
    // compress it cannot watch the second attempt be refused.
    backstopRetryIntervalMs: 60 * 1000,
    // How many capable peers must answer "not ahead of you" before their agreement stands as
    // confirmation. A sequence is a claim the asker cannot check, so one peer is not
    // evidence: a single stale or lying neighbour would otherwise open the acquisition gate
    // on policy the network has moved past. A peer that is genuinely ahead sends the signed
    // bundle instead, which stands on its own, and a node whose capable peers cannot reach
    // this many asks the publisher, whose answer is signed.
    minConfirmingPeers: 4,
  },
  geolocation: {
    ipApiBaseUrl: 'http://ip-api.com',
  },
  // The network's statistics service. One host, several paths: node location,
  // marketplace listings, app USD pricing, and the minimum module versions a node
  // checks its syncthing against at boot.
  stats: {
    baseUrl: 'https://stats.runonflux.io',
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
  pricing: {
    fluxRatesBaseUrl: 'https://viprates.runonflux.io',
    // Consulted only when the rates service above is unreachable.
    coingeckoBaseUrl: 'https://api.coingecko.com',
  },
  mongodb: {
    // Where a replacement server signing key is fetched from when the installed one
    // has expired. The version is appended: /server-<major.minor>.asc
    signingKeyBaseUrl: 'https://pgp.mongodb.com',
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
