module.exports = {
  testEventStream: true,
  logConsole: true,
  fluxTeamFluxID: '19J4Ef396goaQhrqgNLTFvtCXYqjFAx2Js',
  daemon: { host: '198.18.0.3' },
  benchmark: { host: '198.18.0.3' },
  upnp: { gatewayUrl: '', nodeIp: '' },
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
    daemonStaleMs: 10000,
    daemonExpiredMs: 20000,
  },
  github: {
    rawBaseUrl: 'http://198.18.0.6:3000',
    apiBaseUrl: 'http://198.18.0.6:3000',
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
  // The network arcane-attestation pubkey the node verifies encrypted-app
  // attestations against. Overrides the production constant in
  // utils/arcaneAttestation.js with the benchmark stub's deterministic test key
  // (benchCrypto attestation key), so the gate stays real and exercised.
  arcane: { attestationPubkey: 'jSTlGDeXEhjvyuPgyKa8F37BwxiP4w2k6gbR2M3iKI0=' },
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
    installErrorTtlS: 300,
    tempMsgTtlS: 300,
    hashSyncIntervalMs: 30000,
    peerNotifyIntervalMs: 30000,
    cpuCheckIntervalMs: 30000,
    portRestoreIntervalMs: 30000,
    imageComplianceIntervalMs: 60000,
    forceRemovalIntervalMs: 120000,
    installCollisionWaitMs: 5000,
    portTestBindDelayMs: 100,
    portTestPropagationDelayMs: 100,
    portTestPeerTimeoutMs: 3000,
    portTestMaxAttempts: 2,
    // the whole harness fleet shares one /24, so the mainnet /16-diversity rule
    // would always sample zero peers; distinct-IP is the honest harness equivalent
    portTestPrefixLength: 32,
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
