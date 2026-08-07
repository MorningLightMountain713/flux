module.exports = {
  testEventStream: true,
  logConsole: true,
  logLevel: 'debug',
  fluxTeamFluxID: '19J4Ef396goaQhrqgNLTFvtCXYqjFAx2Js',
  daemon: { host: '198.18.0.3' },
  benchmark: { host: '198.18.0.3' },
  upnp: { gatewayUrl: '', nodeIp: '' },
  // Empty disables analytics. The app default is the live cloudaudit endpoint and
  // the fleet network has egress, so without this a run reports suite activity -
  // generated app names, fixture identities, 198.18.x addresses - as real traffic.
  analytics: { url: '' },
  // compressed decider cadence: the syncthing readiness/stall loop runs every 3s
  // and a stall is declared after 4 no-progress cycles (~12s) instead of ~5min.
  syncthing: {
    ip: '198.18.0.4',
    port: 8384,
    monitorIntervalMs: 3000,
    // stall ladder compressed for suite time: first nudge ~6s after flat-idle,
    // removal after 2 failed nudges over >=30s with a CONNECTED synced peer
    stallNudgeAfterMs: 6000,
    stallNudgeMaxIntervalMs: 12000,
    stallRemoveMinWindowMs: 30000,
    stallRemoveMinNudges: 2,
  },
  system: {
    bootIdPath: '/tmp/flux-boot-config/boot-id',
    heartbeatIntervalMs: 10000,
    bootSyncTimeoutMs: 30000,
    bootDaemonTimeoutMs: 30000,
  },
  peers: {
    wsPingIntervalMs: 2000,
    wsMaxMissedPongs: 2,
  },
  confirmation: {
    pollIntervalMs: 5000,
    // The stale/expired verdicts remove every local app, so the fleet default
    // must ride out multi-second process stalls under parallel-gate load
    // (production is minutes-scale). Suites that exercise the stale/expiry
    // removal flows override these per-env to fast values.
    daemonStaleMs: 300000,
    // Expiry is a block count now. The stub confirms each node 10 blocks back, so a
    // limit above that leaves the fleet default unexpired; suites that exercise the
    // flow lower it until those 10 blocks are close to the limit and tune the block
    // interval, which is what turns the blocks still owed into a deadline.
    confirmExpirationBlocks: 640,
    blockIntervalMs: 30000,
  },
  github: {
    apiBaseUrl: 'http://198.18.0.6:3000',
  },
  policy: {
    baseUrl: 'http://198.18.0.6:3000/helpers',
  },
  geolocation: {
    ipApiBaseUrl: 'http://198.18.0.6:3000',
    statsApiBaseUrl: 'http://198.18.0.6:3000',
  },
  // v9 content-delivery blob/manifest backstop, served by the FluxDrive stub at
  // .8. The prod default.js (blobApiUrl: '') is not on the node config search
  // path, so this default is what default-base runs resolve; non-default bases
  // get the base-derived override from test-env infraOverride.
  fluxDrive: { blobApiUrl: 'http://198.18.0.8:16140' },
  // The network arcane-attestation pubkeys the node verifies against. Both
  // override production constants with the benchmark stub's deterministic test
  // keys (benchCrypto), so the gates stay real and exercised: attestationPubkey
  // for encrypted-app attestations (utils/arcaneAttestation.js),
  // meshAttestationPubkey for mesh membership vouchers (appMesh/meshVoucher.js,
  // the stub's purpose:mesh signer).
  arcane: {
    attestationPubkey: 'jSTlGDeXEhjvyuPgyKa8F37BwxiP4w2k6gbR2M3iKI0=',
    meshAttestationPubkey: 'GfsZ2SxMPGa4Tbwgku9KzOuHT8qfQA3uF16D3tYvYtg=',
  },
  fluxapps: {
    minOutgoing: 4,
    minIncoming: 2,
    minUniqueIpsOutgoing: 3,
    minUniqueIpsIncoming: 2,
    minHashSyncPeers: 1,
    minUpTime: 10,
    maxAppsPerNode: 200,
    blocksLasting: 22000,
    newMinBlocksAllowance: 100,
    daemonPONFork: 2020000,
    // Version-activation floors. The harness chain tip is INITIAL_HEIGHT
    // (2,100,000), so every version here resolves active; v9 is pulled below the
    // tip (prod is 2.6M+) so v9 specs are accepted under the harness.
    appSpecsEnforcementHeights: {
      1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 2000000,
    },
    hddFileSystemMinimum: 2,
    defaultSwap: 0,
    appSyncPeerThreshold: 2,
    appSyncDegradedThreshold: 1,
    appSyncMinPeerUptime: 0,
    appSyncMinCompletions: 1,
    syncTimeoutMs: 30000,
    hashSyncMaxRetries: 2,
    hashSyncRetryMs: 10000,
    hashSyncSettleMs: 2000,
    hashSyncResponseTimePerHashMs: 150,
    hashSyncBufferMs: 5000,
    hashSyncMaxRounds: 4,
    hashSyncPeersPerRound: 3,
    hashSyncEphemeralPeers: 3,
    hashSyncFallbackRecheckBlocks: 10,
    syncResponseThrottleMs: 10000,
    wsHandshakeTimeoutMs: 5000,
    discoveryConnectionDelayMs: 100,
    nodeMonitorRemovalDelayMs: 1000,
    nodeMonitorDosRecoveryDelayMs: 10000,
    nodeMonitorConfirmationLossDelayMs: 10000,
    nodeMonitorErrorRecoveryDelayMs: 5000,
    nodeMonitorCheckTimeoutMs: 5000,
    bootDelayMultiplier: 0.01,
    spawnDelayMs: 10000,
    removalSpacingMs: 1000,
    locationTtlS: 300,
    installingTtlS: 60,
    installingRenewalS: 45,
    installErrorTtlS: 300,
    tempMsgTtlS: 300,
    gossipValidityS: 300,
    sigtermTtlS: 420,
    hashSyncIntervalMs: 30000,
    peerNotifyIntervalMs: 30000,
    cpuCheckIntervalMs: 30000,
    portRestoreIntervalMs: 30000,
    imageComplianceIntervalMs: 60000,
    orphanSweepIntervalMs: 120000,
    dockerDebrisIntervalMs: 21600000,
    meshReconcileIntervalMs: 120000,
    backendTlsRenewalIntervalMs: 120000,
    installCollisionWaitMs: 5000,
    portTestPeerTimeoutMs: 3000,
    // the whole harness fleet shares one /24, so the mainnet /16-diversity rule
    // would always sample zero peers; distinct-IP is the honest harness equivalent
    portTestPrefixLength: 32,
    // address of the fixed harness authority key (AUTHORITY_PRIVKEY in
    // runner/framework/flux-chain-crypto.js) so bootstrapPricing's soft-fork
    // messages pass the recognized-signer gate; override per-suite to test
    // authority rotation / rejection paths
    messageAuthorityAddress: 't1ggL4azeDbBHwt4TJ6mAHZ88x3eBsn2vgh',
    spawnReconfirmDelayMs: 30000,
    // harness nodes look Arcane (FLUXOS_PATH set), so unencrypted spawns defer by this
    unencryptedSpawnDelayMs: 500,
    globalCmdDelayMs: 100,
    discoveryAutostart: false,
    discoveryRetryMs: 5000,
    discoveryFailRetryMs: 5000,
    connectionBackoffMs: [2000, 5000, 10000, 15000],
    nodeMonitorIntervalMs: 10000,
    spawnDeferrals: {
      targetedNodesMs: { encrypted: 150, standard: 300 },
      staticIpMs: { encrypted: 200, standard: 400 },
      datacenterMs: { encrypted: 250, standard: 500 },
      capacityGap: {
        largeMs: { encrypted: 350, standard: 700 },
        mediumMs: { encrypted: 400, standard: 800 },
        smallMs: { encrypted: 450, standard: 900 },
      },
    },
    spawnDelayMultiplier: 0.002,
    daemonInfoIntervalMs: 5000,
    explorerSyncRetryMs: 5000,
    explorerDeepRestoreBlocks: 0,
    imageUpdateCheckIntervalMs: 5000,
    imageUpdateInitialDelayMinMs: 1000,
    imageUpdateInitialDelayMaxMs: 2000,
    imageUpdateDelayBetweenAppsMs: 100,
    imageUpdateDelayAfterRedeployMs: 1000,
    imageUpdateDelayBetweenComponentsMs: 100,
    masterSlaveIntervalMs: 3000, // compressed g: FDM election cycle (prod 30s)
    installation: { probability: 100, delay: 5 },
    removal: { probability: 25, delay: 5 },
    redeploy: { probability: 2, delay: 1, composedDelay: 1 },
  },
};
