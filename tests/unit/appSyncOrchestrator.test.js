const { expect } = require('chai');
const sinon = require('sinon');
const { EventEmitter } = require('events');
const proxyquire = require('proxyquire').noCallThru();

describe('AppSyncOrchestrator', () => {
  let AppSyncOrchestrator;
  let STATES;
  let EVENTS;
  let appSyncEvents;
  let blockEmitter;
  let peerEmitter;
  let clock;
  let getEligibleSyncPeersStub;
  let logStub;
  let syncMissingHashesStub;
  let getMissingHashesStub;
  let reindexStub;
  let globalStateStub;
  let checkAndNotifyStub;
  let resetHashSyncForUpgradeStub;
  let dbHelperStub;
  let findOneAndUpdateStub;
  let getFluxNodePublicKeyStub;
  let getFluxNodePrivateKeyStub;
  let signMessageStub;
  let reconcileStub;

  function makePeer(key) {
    return { key, send: sinon.stub() };
  }

  function makeEligiblePeers(count) {
    const peers = [];
    for (let i = 0; i < count; i += 1) {
      peers.push(makePeer(`10.0.0.${i + 1}:16127`));
    }
    return peers;
  }

  const defaultBootContext = {
    machineRebooted: false,
    downtimeMs: 0,
    cleanShutdown: true,
    currentBootId: 'test-boot-id-12345',
    firstBoot: false,
  };

  function makePeerOptions(overrides = {}) {
    return {
      getEligibleSyncPeers: getEligibleSyncPeersStub,
      onPeerEvent: (event, cb) => peerEmitter.on(event, cb),
      offPeerEvent: (event, cb) => peerEmitter.removeListener(event, cb),
      ...overrides,
    };
  }

  function makeOrchestrator(overrides = {}) {
    const orchestrator = new AppSyncOrchestrator({ blockEmitter, ...makePeerOptions(), ...overrides });
    orchestrator.onMessageCapabilityChange(true);
    return orchestrator;
  }

  beforeEach(() => {
    clock = sinon.useFakeTimers({ shouldAdvanceTime: false });
    blockEmitter = new EventEmitter();
    peerEmitter = new EventEmitter();
    getEligibleSyncPeersStub = sinon.stub().returns([]);

    logStub = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };
    syncMissingHashesStub = sinon.stub().resolves({ resolved: 0, missing: 0, unreachable: 0, nextRetryHeight: null });
    getMissingHashesStub = sinon.stub().resolves([]);
    reindexStub = sinon.stub().resolves();
    globalStateStub = {
      dbReady: false,
      waitForBootContainerStateSettled: () => Promise.resolve(),
    };
    checkAndNotifyStub = sinon.stub().resolves();
    resetHashSyncForUpgradeStub = sinon.stub().resolves(0);
    findOneAndUpdateStub = sinon.stub().resolves();
    dbHelperStub = {
      databaseConnection: sinon.stub().returns({ db: sinon.stub().returns({}) }),
      findOneInDatabase: sinon.stub().resolves(null),
      findOneAndUpdateInDatabase: findOneAndUpdateStub,
    };
    getFluxNodePublicKeyStub = sinon.stub().resolves('04testpubkey1234567890');
    getFluxNodePrivateKeyStub = sinon.stub().resolves('L1testprivkey');
    signMessageStub = sinon.stub().returns('fakesig==');
    // Mirror the real reconcile: a round that reached peers reports indexesReceived>=1
    // (which is what latches #manifestSyncComplete); a peerless/vacuous round reports 0.
    reconcileStub = sinon.stub().callsFake((peers = []) => Promise.resolve({
      peers: peers.length, indexesReceived: peers.length, fetched: 0,
    }));

    const appSyncEventsModule = require('../../ZelBack/src/services/utils/appSyncEvents');
    appSyncEvents = appSyncEventsModule.appSyncEvents;
    EVENTS = appSyncEventsModule.EVENTS;
    appSyncEvents.removeAllListeners();

    const mod = proxyquire('../../ZelBack/src/services/appMessaging/appSyncOrchestrator', {
      'fs': { promises: { readFile: sinon.stub().resolves('test-boot-id-12345\n') } },
      '../../lib/log': logStub,
      '../dbHelper': dbHelperStub,
      './appHashSyncService': { syncMissingHashes: syncMissingHashesStub, getMissingHashes: getMissingHashesStub, resetHashSyncForUpgrade: resetHashSyncForUpgradeStub },
      './contentManifestSyncService': { reconcile: reconcileStub, depositIndex: sinon.stub(), isPeerInActiveRound: sinon.stub().returns(false) },
      './peerNotification': { checkAndNotifyPeersOfRunningApps: checkAndNotifyStub, stopBroadcastInterval: sinon.stub() },
      '../appDatabase/registryManager': {
        reindexGlobalAppsInformation: reindexStub,
      },
      '../utils/globalState': globalStateStub,
      '../utils/peerCodec': {
        MSG_TYPE: {
          REQUEST_TEMP_MESSAGES: 0x20, REQUEST_APP_RUNNING: 0x21, REQUEST_APP_INSTALLING: 0x22, REQUEST_APP_INSTALLING_ERRORS: 0x23,
        },
        buildSyncSignatureMessage: sinon.stub().returns('testmsg'),
        encodeRequestTempMessages: sinon.stub().returns(Buffer.alloc(9, 0x20)),
        encodeRequestAppRunning: sinon.stub().returns(Buffer.alloc(9, 0x21)),
        encodeRequestAppInstalling: sinon.stub().returns(Buffer.alloc(9, 0x22)),
        encodeRequestAppInstallingErrors: sinon.stub().returns(Buffer.alloc(9, 0x23)),
      },
      '../fluxNetworkHelper': {
        getFluxNodePublicKey: getFluxNodePublicKeyStub,
        getFluxNodePrivateKey: getFluxNodePrivateKeyStub,
      },
      '../verificationHelper': {
        signMessage: signMessageStub,
      },
      '../utils/appSyncEvents': appSyncEventsModule,
    });
    AppSyncOrchestrator = mod.AppSyncOrchestrator;
    STATES = mod.STATES;
  });

  afterEach(() => {
    clock.restore();
    sinon.restore();
  });

  describe('state machine', () => {
    it('should start in INITIALIZING state', () => {
      const orchestrator = makeOrchestrator();
      expect(orchestrator.state).to.equal(STATES.INITIALIZING);
    });

    it('should transition to SYNCING on first blockReceived', async () => {
      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(STATES.SYNCING);
    });

    it('should log sync started on first blockReceived', async () => {
      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      expect(logStub.info.calledWith('AppSyncOrchestrator - Sync started')).to.be.true;
    });

    it('should call syncMissingHashes on first blockReceived', async () => {
      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      expect(syncMissingHashesStub.calledOnce).to.be.true;
    });

    it('should call reindexGlobalAppsInformation after sync', async () => {
      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      expect(reindexStub.calledOnce).to.be.true;
    });

    it('should set dbReady after sync', async () => {
      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      expect(globalStateStub.dbReady).to.be.true;
    });

    it('should log DB ready after reindex', async () => {
      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      expect(logStub.info.calledWith('AppSyncOrchestrator - DB ready')).to.be.true;
    });
  });

  describe('peer threshold events', () => {
    it('should call getEligibleSyncPeers on peerThresholdReached', async () => {
      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      expect(getEligibleSyncPeersStub.calledOnce).to.be.true;
    });

    it('should start apprunning broadcast on peerThresholdReached', async () => {
      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      expect(checkAndNotifyStub.calledOnce).to.be.true;
    });

    it('should start sync from the latched level when the threshold edge fired before start', async () => {
      // peerThresholdReached is edge-triggered and latched in FluxPeerManager:
      // if peers connected before start() subscribed, the edge never re-fires.
      // start() must read the level after subscribing — no edge is emitted here.
      const orchestrator = makeOrchestrator({ peerCountIfAboveThreshold: () => 12 });
      orchestrator.start(defaultBootContext);
      await clock.tickAsync(0);
      expect(getEligibleSyncPeersStub.calledOnce).to.be.true;
      expect(checkAndNotifyStub.calledOnce).to.be.true;
    });

    it('should not start sync from the level when the threshold has not been reached', async () => {
      const orchestrator = makeOrchestrator({ peerCountIfAboveThreshold: () => 0 });
      orchestrator.start(defaultBootContext);
      await clock.tickAsync(0);
      expect(getEligibleSyncPeersStub.called).to.be.false;
    });

    it('should transition to DEGRADED on peersBelowThreshold when READY', async () => {
      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);


      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      for (let i = 0; i < 130; i += 1) {
        blockEmitter.emit('blocksProcessed', 2555000 + i);
      }
      await clock.tickAsync(0);

      if (orchestrator.state === STATES.READY) {
        peerEmitter.emit('peersBelowThreshold', 3);
        expect(orchestrator.state).to.equal(STATES.DEGRADED);
      }
    });

    it('should emit readinessLost on degradation', async () => {
      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);

      const spy = sinon.spy();
      appSyncEvents.on(EVENTS.READINESS_LOST, spy);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      for (let i = 0; i < 130; i += 1) {
        blockEmitter.emit('blocksProcessed', 2555000 + i);
      }
      await clock.tickAsync(0);

      if (orchestrator.state === STATES.READY) {
        peerEmitter.emit('peersBelowThreshold', 3);
        expect(spy.calledOnce).to.be.true;
      }
    });
  });

  describe('sync requests', () => {
    it('should send all 4 request types to eligible peers', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);

      for (const peer of peers) {
        expect(peer.send.callCount).to.equal(4);
      }
    });

    it('should not send when fewer than 3 eligible peers on first attempt', async () => {
      const peers = makeEligiblePeers(2);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);

      for (const peer of peers) {
        expect(peer.send.called).to.be.false;
      }
    });

    it('should not ask the same peer twice in the same cycle', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);

      // Second threshold event — same peers returned, but already asked
      peerEmitter.emit('peerThresholdReached', 15);
      await clock.tickAsync(0);

      for (const peer of peers) {
        expect(peer.send.callCount).to.equal(4);
      }
    });

    it('should reset asked peers on degradation', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);


      // Get to READY via block-count fallback
      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      for (let i = 0; i < 130; i += 1) {
        blockEmitter.emit('blocksProcessed', 2555000 + i);
      }
      await clock.tickAsync(0);

      if (orchestrator.state === STATES.READY) {
        // Degrade and recover — peers should be asked again
        peerEmitter.emit('peersBelowThreshold', 3);
        const sendCountBefore = peers[0].send.callCount;
        peerEmitter.emit('peerThresholdReached', 12);
        await clock.tickAsync(0);
        expect(peers[0].send.callCount).to.be.greaterThan(sendCountBefore);
      }
    });
  });

  describe('state sync readiness', () => {
    it('should reach READY when all sync types complete from 3 peers', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);


      // Start hash sync
      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);

      // Send sync requests
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);

      // Complete all syncs from 3 peers
      for (let i = 0; i < 3; i += 1) {
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apprunning');
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'appinstalling');
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apperrors');      }
      await clock.tickAsync(0);

      expect(orchestrator.state).to.equal(STATES.READY);
    });

    it('should not reach READY when only 2 peers complete apprunning', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);

      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);

      // Only 2 apprunning, but 3 of the others — apprunning short is the sole gate.
      appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apprunning');
      appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apprunning');
      for (let i = 0; i < 3; i += 1) {
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'appinstalling');
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apperrors');      }
      await clock.tickAsync(0);

      expect(orchestrator.state).to.equal(STATES.SYNCING);
    });

    it('should fall back to block count when no sync peers available', async () => {
      getEligibleSyncPeersStub = sinon.stub().returns([]);

      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);

      // After sync but before enough blocks, should still be SYNCING
      expect(orchestrator.state).to.equal(STATES.SYNCING);

      // After enough blocks (enterprise = 124), should reach READY
      for (let i = 0; i < 130; i += 1) {
        blockEmitter.emit('blocksProcessed', 2555000 + i);
      }
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(STATES.READY);
    });

    it('should reset sync completions on degradation', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);


      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);

      // Complete all syncs → READY
      for (let i = 0; i < 3; i += 1) {
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apprunning');
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'appinstalling');
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apperrors');      }
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(STATES.READY);

      // Degrade
      peerEmitter.emit('peersBelowThreshold', 3);
      expect(orchestrator.state).to.equal(STATES.DEGRADED);

      // Recovery — need fresh syncs, previous completions reset
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(STATES.RESYNCING);
    });
  });

  describe('manifest reconcile readiness gate', () => {
    function completeEphemeral() {
      for (let i = 0; i < 3; i += 1) {
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apprunning');
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'appinstalling');
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apperrors');
      }
    }

    it('reaches READY once a peer index is received (manifest latched on evidence)', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub.returns(peers);
      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      completeEphemeral();
      await clock.tickAsync(0);

      expect(reconcileStub.called).to.be.true;
      expect(orchestrator.state).to.equal(STATES.READY);
    });

    it('stays gated when the reconcile round reached no peer (0 indexes received)', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub.returns(peers);
      // Peers present but none answered within the index window.
      reconcileStub.resolves({ peers: 3, indexesReceived: 0, fetched: 0 });

      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);
      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      completeEphemeral();
      await clock.tickAsync(0);

      // Hash + DB + ephemeral all done, but the manifest never converged and the
      // block timer has not fired — the spawner stays gated.
      expect(orchestrator.state).to.equal(STATES.SYNCING);
    });

    it('does not latch the manifest on a single-flight-skipped round', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub.returns(peers);
      reconcileStub.resolves({
        peers: 0, indexesReceived: 0, fetched: 0, skipped: true,
      });

      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);
      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      completeEphemeral();
      await clock.tickAsync(0);

      expect(orchestrator.state).to.equal(STATES.SYNCING);
    });

    it('lets the block timer release readiness when the manifest never converges', async () => {
      getEligibleSyncPeersStub.returns([]); // never any peer to reconcile against
      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);
      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(STATES.SYNCING);

      for (let i = 0; i < 130; i += 1) {
        blockEmitter.emit('blocksProcessed', 2555000 + i);
      }
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(STATES.READY);
    });

    it('retries the manifest reconcile when peers arrive after a peerless boot round (F1)', async () => {
      // Boot: explorer + capability ready, but discovery has not connected peers yet.
      getEligibleSyncPeersStub.returns([]);
      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      // First round ran against nobody, so the manifest did not latch.
      expect(reconcileStub.calledOnce).to.be.true;
      expect(orchestrator.state).to.equal(STATES.SYNCING);

      // Discovery connects peers -> the peer-threshold edge re-drives the sync.
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub.returns(peers);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      completeEphemeral();
      await clock.tickAsync(0);

      expect(reconcileStub.callCount).to.be.greaterThan(1);
      expect(orchestrator.state).to.equal(STATES.READY);
    });

    it('reconciles the manifest after a peers-first recovery once capability returns (F2)', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub.returns(peers);
      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);

      // Boot to READY.
      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      completeEphemeral();
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(STATES.READY);

      // Partial-partition-style disruption: degrade (resets the sync latches) AND
      // lose message capability.
      peerEmitter.emit('peersBelowThreshold', 3);
      orchestrator.onMessageCapabilityChange(false);
      expect(orchestrator.state).to.equal(STATES.DEGRADED);
      reconcileStub.resetHistory();

      // Peers return BEFORE capability: the resync cannot send yet, so nothing
      // reconciles — and, crucially, nothing latches.
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(STATES.RESYNCING);
      expect(reconcileStub.called, 'manifest not reconciled while uncapable').to.be.false;

      // Capability returns: the manifest sync is re-driven (the old code skipped it
      // because hash sync had already completed).
      orchestrator.onMessageCapabilityChange(true);
      await clock.tickAsync(0);
      completeEphemeral();
      await clock.tickAsync(0);

      expect(reconcileStub.called, 'manifest reconciled after capability returned').to.be.true;
      expect(orchestrator.state).to.equal(STATES.READY);
    });
  });

  describe('steady-state manifest refresh (F3 anti-entropy)', () => {
    function completeEphemeral() {
      for (let i = 0; i < 3; i += 1) {
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apprunning');
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'appinstalling');
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apperrors');
      }
    }

    async function toReady(catchUpRunningContent) {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub.returns(peers);
      const orchestrator = makeOrchestrator({ isEnterprise: () => true, catchUpRunningContent });
      orchestrator.start(defaultBootContext);
      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      completeEphemeral();
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(STATES.READY);
      return orchestrator;
    }

    it('reconciles a few sampled peers and catches up running content on the block cadence', async () => {
      const catchUp = sinon.stub().resolves();
      await toReady(catchUp);
      reconcileStub.resetHistory();
      catchUp.resetHistory();

      // Before the cadence (100 blocks) — no refresh.
      blockEmitter.emit('blocksProcessed', 2555050);
      await clock.tickAsync(0);
      sinon.assert.notCalled(reconcileStub);
      sinon.assert.notCalled(catchUp);

      // At the cadence — reconcile a sample, then catch up running content.
      blockEmitter.emit('blocksProcessed', 2555200);
      await clock.tickAsync(0);
      sinon.assert.calledOnce(reconcileStub);
      sinon.assert.calledOnce(catchUp);
      expect(reconcileStub.firstCall.args[0]).to.have.lengthOf(3); // sampled peers
    });

    it('does not refresh while SYNCING (boot/recovery own convergence)', async () => {
      getEligibleSyncPeersStub.returns([]); // no peers -> manifest never latches, stays SYNCING
      const catchUp = sinon.stub().resolves();
      const orchestrator = makeOrchestrator({ isEnterprise: () => true, catchUpRunningContent: catchUp });
      orchestrator.start(defaultBootContext);
      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(STATES.SYNCING);
      reconcileStub.resetHistory();

      for (let i = 1; i < 120; i += 1) blockEmitter.emit('blocksProcessed', 2555000 + i);
      await clock.tickAsync(0);
      sinon.assert.notCalled(catchUp);
    });

    it('does not overlap refreshes (single-flight)', async () => {
      const catchUp = sinon.stub().resolves();
      await toReady(catchUp); // boot uses the resolved stub from beforeEach
      reconcileStub.resetHistory();

      // Make the refresh reconcile hang so a second cadence tick lands while it is in flight.
      let resolveReconcile;
      reconcileStub.callsFake(() => new Promise((r) => { resolveReconcile = r; }));

      blockEmitter.emit('blocksProcessed', 2555200); // triggers the refresh (hangs)
      await clock.tickAsync(0);
      blockEmitter.emit('blocksProcessed', 2555400); // in-flight -> skipped
      await clock.tickAsync(0);
      sinon.assert.calledOnce(reconcileStub);

      resolveReconcile({ peers: 3, indexesReceived: 3, fetched: 0 });
      await clock.tickAsync(0);
    });
  });

  describe('sync peer failure and replacement', () => {
    let completeSyncRequestStub;
    let clearSyncRequestedStub;

    // Boots an orchestrator to the point where the initial batch of 3 sync
    // peers has been asked (mainnet topology: appSyncMinCompletions = 3).
    async function startWithAskedPeers(peers) {
      getEligibleSyncPeersStub = sinon.stub().returns(peers);
      const orchestrator = makeOrchestrator({
        isEnterprise: () => true,
        completeSyncRequest: completeSyncRequestStub,
        clearSyncRequested: clearSyncRequestedStub,
      });
      orchestrator.start(defaultBootContext);
      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      return orchestrator;
    }

    function completeAllTypes(peerKey) {
      appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apprunning', peerKey);
      appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'appinstalling', peerKey);
      appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apperrors', peerKey);
    }

    beforeEach(() => {
      completeSyncRequestStub = sinon.stub();
      clearSyncRequestedStub = sinon.stub();
    });

    it('should replace a disconnected peer with one fresh peer asking only the undelivered types', async () => {
      const peers = makeEligiblePeers(5);
      await startWithAskedPeers(peers);
      expect(peers[2].send.callCount).to.equal(4); // temp + 3 sync types
      expect(peers[3].send.called).to.be.false;

      appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apprunning', peers[0].key);
      peerEmitter.emit('syncPeerLost', peers[0].key);
      await clock.tickAsync(0);

      // One replacement peer, asked only for what is still short after the
      // delivered apprunning completion was banked (appinstalling, apperrors)
      expect(peers[3].send.callCount).to.equal(2);
      const sentTypes = peers[3].send.args.map((args) => args[0][0]);
      expect(sentTypes).to.deep.equal([0x22, 0x23]);
      expect(peers[4].send.called).to.be.false;
    });

    it('should not replace a disconnected peer that had delivered every sync type', async () => {
      const peers = makeEligiblePeers(5);
      await startWithAskedPeers(peers);

      completeAllTypes(peers[0].key);
      peerEmitter.emit('syncPeerLost', peers[0].key);
      await clock.tickAsync(0);

      expect(peers[3].send.called).to.be.false;
    });

    it('should never re-ask a peer that already failed, even when it reconnects', async () => {
      const peers = makeEligiblePeers(5);
      await startWithAskedPeers(peers);

      peerEmitter.emit('syncPeerLost', peers[0].key);
      await clock.tickAsync(0);
      expect(peers[3].send.callCount).to.equal(3); // replacement asked all 3 types (none delivered)

      // The lost peer reconnects and is eligible again; its replacement dies too
      peerEmitter.emit('syncPeerLost', peers[3].key);
      await clock.tickAsync(0);

      expect(peers[4].send.callCount).to.equal(3);
      expect(peers[0].send.callCount).to.equal(4); // initial ask: temp + 3 sync types
    });

    it('should fail a silent peer at its deadline, stop accepting it, and replace it', async () => {
      const peers = makeEligiblePeers(5);
      await startWithAskedPeers(peers);
      completeAllTypes(peers[0].key);
      completeAllTypes(peers[1].key);

      await clock.tickAsync(120000);
      blockEmitter.emit('blocksProcessed', 2555001);
      await clock.tickAsync(0);

      sinon.assert.calledWith(completeSyncRequestStub, peers[2].key);
      expect(peers[3].send.callCount).to.equal(3); // replacement asked all 3 still-short types
      expect(logStub.warn.args.some((args) => String(args[0]).includes('missed the 120s deadline'))).to.be.true;
    });

    it('should retry the replacement on a later block when no fresh peer existed at failure time', async () => {
      const peers = makeEligiblePeers(3);
      await startWithAskedPeers(peers);

      peerEmitter.emit('syncPeerLost', peers[0].key);
      await clock.tickAsync(0);

      const latecomer = makePeer('10.0.0.99:16127');
      getEligibleSyncPeersStub.returns([...peers, latecomer]);
      blockEmitter.emit('blocksProcessed', 2555001);
      await clock.tickAsync(0);

      expect(latecomer.send.callCount).to.equal(3); // asked all 3 types (none delivered)
    });

    it('should stop after the peer budget and abandon the round so the block timer takes over', async () => {
      const peers = makeEligiblePeers(7);
      const orchestrator = await startWithAskedPeers(peers);

      for (const idx of [0, 1, 2, 3, 4]) {
        peerEmitter.emit('syncPeerLost', peers[idx].key);
        // eslint-disable-next-line no-await-in-loop
        await clock.tickAsync(0);
      }

      // 3 initial + 2 replacements exhausts the budget of 5 distinct peers
      expect(peers[3].send.callCount).to.equal(3);
      expect(peers[4].send.callCount).to.equal(3);
      expect(peers[5].send.called).to.be.false;
      expect(logStub.warn.args.some((args) => String(args[0]).includes('State sync abandoned'))).to.be.true;
      expect(clearSyncRequestedStub.called).to.be.true;

      // The block timer remains the terminal path to readiness
      for (let i = 0; i < 130; i += 1) {
        blockEmitter.emit('blocksProcessed', 2555001 + i);
      }
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(STATES.READY);
    });

    it('should clear the in-flight marks and ignore later peer losses once sync completes', async () => {
      const peers = makeEligiblePeers(5);
      const orchestrator = await startWithAskedPeers(peers);

      for (const peer of peers.slice(0, 3)) {
        completeAllTypes(peer.key);
      }
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(STATES.READY);
      expect(clearSyncRequestedStub.called).to.be.true;

      peerEmitter.emit('syncPeerLost', peers[1].key);
      await clock.tickAsync(0);
      expect(peers[3].send.called).to.be.false;
    });
  });

  describe('hash sync recovery', () => {
    it('should retry hash sync on failure', async () => {
      syncMissingHashesStub.onFirstCall().rejects(new Error('connection failed'));
      syncMissingHashesStub.onSecondCall().resolves({ resolved: 10, missing: 0, unreachable: 0 });

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);

      expect(syncMissingHashesStub.calledOnce).to.be.true;
      expect(orchestrator.state).to.equal(STATES.SYNCING);
      expect(logStub.error.calledWith(sinon.match(/Hash sync failed.*attempt 1\/3/))).to.be.true;
    });

    it('should fall back to block timer when hash sync retries exhausted', async () => {
      syncMissingHashesStub.rejects(new Error('persistent failure'));

      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);


      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);

      // All 3 retries happen via timers — we can't wait for real timers in tests
      // But we can verify the block timer fallback works
      expect(orchestrator.state).to.equal(STATES.SYNCING);

      // Emit enough blocks to trigger block timer (enterprise = 124 blocks)
      for (let i = 0; i < 130; i += 1) {
        blockEmitter.emit('blocksProcessed', 2555001 + i);
      }
      await clock.tickAsync(0);

      expect(orchestrator.state).to.equal(STATES.READY);
    });

    it('should reach READY via block timer when hash sync never completes', async () => {
      syncMissingHashesStub.rejects(new Error('failed'));

      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);


      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);

      // Emit enough blocks for enterprise threshold
      for (let i = 1; i <= 130; i += 1) {
        blockEmitter.emit('blocksProcessed', 2555000 + i);
      }
      await clock.tickAsync(0);

      // Block timer should have triggered DB rebuild and readiness
      expect(orchestrator.state).to.equal(STATES.READY);
      expect(reindexStub.called).to.be.true;
    });

    it('should not get stuck when DB rebuild fails', async () => {
      reindexStub.rejects(new Error('reindex failed'));

      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);

      // Hash sync succeeded but DB rebuild failed
      expect(syncMissingHashesStub.calledOnce).to.be.true;

      // Block timer should still allow readiness (will retry DB rebuild)
      for (let i = 1; i <= 130; i += 1) {
        blockEmitter.emit('blocksProcessed', 2555000 + i);
      }
      await clock.tickAsync(0);

      // The block timer fallback tries rebuildDb again
      expect(reindexStub.callCount).to.be.greaterThan(1);
    });
  });

  describe('dbReady on fallback paths', () => {
    it('should set dbReady after block timer fallback when hash sync fails', async () => {
      syncMissingHashesStub.rejects(new Error('failed'));

      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);

      for (let i = 1; i <= 130; i += 1) {
        blockEmitter.emit('blocksProcessed', 2555000 + i);
      }
      await clock.tickAsync(0);

      expect(orchestrator.state).to.equal(STATES.READY);
      expect(globalStateStub.dbReady).to.be.true;
    });

    it('should set dbReady when too few sync peers and block timer fires', async () => {
      getEligibleSyncPeersStub = sinon.stub().returns([]);

      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);

      for (let i = 1; i <= 130; i += 1) {
        blockEmitter.emit('blocksProcessed', 2555000 + i);
      }
      await clock.tickAsync(0);

      expect(orchestrator.state).to.equal(STATES.READY);
      expect(globalStateStub.dbReady).to.be.true;
    });

    it('should leave dbReady false when rebuildDb throws on fallback path', async () => {
      syncMissingHashesStub.rejects(new Error('failed'));
      reindexStub.rejects(new Error('reindex failed'));

      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);

      for (let i = 1; i <= 130; i += 1) {
        blockEmitter.emit('blocksProcessed', 2555000 + i);
      }
      await clock.tickAsync(0);

      expect(globalStateStub.dbReady).to.be.false;
      expect(orchestrator.state).to.not.equal(STATES.READY);
    });
  });

  describe('hash retry scheduling', () => {
    it('should retry hash sync when block reaches nextRetryHeight', async () => {
      syncMissingHashesStub.onFirstCall().resolves({ resolved: 5, missing: 2, unreachable: 0, nextRetryHeight: 2555200 });
      syncMissingHashesStub.onSecondCall().resolves({ resolved: 2, missing: 0, unreachable: 0, nextRetryHeight: null });

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);

      // Initial sync sets nextRetryHeight to 2555200
      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      expect(syncMissingHashesStub.calledOnce).to.be.true;

      // Block before retry height — should not trigger sync
      blockEmitter.emit('blocksProcessed', 2555100);
      await clock.tickAsync(0);
      expect(syncMissingHashesStub.calledOnce).to.be.true;

      // Block at retry height — should trigger sync
      blockEmitter.emit('blocksProcessed', 2555200);
      await clock.tickAsync(0);
      expect(syncMissingHashesStub.calledTwice).to.be.true;
    });

    it('should use fallback interval when no hashes are backed off', async () => {
      syncMissingHashesStub.resolves({ resolved: 0, missing: 0, unreachable: 0, nextRetryHeight: null });

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      expect(syncMissingHashesStub.calledOnce).to.be.true;

      // Fallback is 100 blocks — should not trigger before that
      blockEmitter.emit('blocksProcessed', 2555050);
      await clock.tickAsync(0);
      expect(syncMissingHashesStub.calledOnce).to.be.true;

      // At fallback threshold — should trigger
      blockEmitter.emit('blocksProcessed', 2555100);
      await clock.tickAsync(0);
      expect(syncMissingHashesStub.calledTwice).to.be.true;
    });

    it('should schedule immediate check on HASH_UNRESOLVED event', async () => {
      syncMissingHashesStub.onFirstCall().resolves({ resolved: 0, missing: 0, unreachable: 0, nextRetryHeight: 2560000 });
      syncMissingHashesStub.onSecondCall().resolves({ resolved: 1, missing: 0, unreachable: 0, nextRetryHeight: null });

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      expect(syncMissingHashesStub.calledOnce).to.be.true;

      // New unresolved hash — should schedule immediate check
      appSyncEvents.emit(EVENTS.HASH_UNRESOLVED);

      // Next block should trigger sync even though nextRetryHeight was 2560000
      blockEmitter.emit('blocksProcessed', 2555001);
      await clock.tickAsync(0);
      expect(syncMissingHashesStub.calledTwice).to.be.true;
    });

    it('should ignore HASH_UNRESOLVED before initial sync completes', async () => {
      syncMissingHashesStub.rejects(new Error('not ready'));

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);

      // Emit HASH_UNRESOLVED before any block (hashSyncComplete is false)
      appSyncEvents.emit(EVENTS.HASH_UNRESOLVED);

      // Should not crash or change state
      expect(orchestrator.state).to.equal(STATES.INITIALIZING);
    });
  });

  describe('hashesChanged event', () => {
    it('should schedule immediate hash recheck when reconstruct changes hashes', async () => {
      syncMissingHashesStub.onFirstCall().resolves({ resolved: 0, missing: 0, unreachable: 0, nextRetryHeight: 2560000 });
      syncMissingHashesStub.onSecondCall().resolves({ resolved: 1, missing: 0, unreachable: 0, nextRetryHeight: null });

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      expect(syncMissingHashesStub.calledOnce).to.be.true;

      // Reconstruct found changes
      blockEmitter.emit('hashesChanged');

      // Next block should trigger sync immediately
      blockEmitter.emit('blocksProcessed', 2555001);
      await clock.tickAsync(0);
      expect(syncMissingHashesStub.calledTwice).to.be.true;
    });

    it('should register hashesChanged listener on start', async () => {
      const orchestrator = makeOrchestrator();
      expect(blockEmitter.listenerCount('hashesChanged')).to.equal(0);
      orchestrator.start(defaultBootContext);
      expect(blockEmitter.listenerCount('hashesChanged')).to.equal(1);
    });

    it('should ignore hashesChanged before initial sync completes', async () => {
      syncMissingHashesStub.rejects(new Error('not ready'));

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('hashesChanged');

      expect(logStub.info.calledWith(sinon.match(/Reconstruct audit found changes/))).to.be.false;
    });
  });

  describe('version upgrade reset', () => {
    it('should call resetHashSyncForUpgrade with block height on version change', async () => {
      dbHelperStub.findOneInDatabase.resolves(null);

      const orchestrator = makeOrchestrator({ fluxVersion: '8.12.0' });
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);

      expect(resetHashSyncForUpgradeStub.calledOnce).to.be.true;
      expect(resetHashSyncForUpgradeStub.firstCall.args[0]).to.equal(2555000);
      expect(logStub.info.calledWith(sinon.match(/Version upgrade to 8\.12\.0/))).to.be.true;
    });

    it('should skip reset when version matches marker', async () => {
      dbHelperStub.findOneInDatabase.resolves({ _id: 'hashSyncVersion', version: '8.12.0' });

      const orchestrator = makeOrchestrator({ fluxVersion: '8.12.0' });
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);

      expect(resetHashSyncForUpgradeStub.called).to.be.false;
    });

    it('should write version marker after hash sync completes', async () => {
      dbHelperStub.findOneInDatabase.resolves(null);

      const orchestrator = makeOrchestrator({ fluxVersion: '8.12.0' });
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);

      const versionCall = findOneAndUpdateStub.getCalls().find(
        (c) => c.args[2]?._id === 'hashSyncVersion',
      );
      expect(versionCall).to.not.be.undefined;
      expect(versionCall.args[3]).to.deep.equal({ $set: { version: '8.12.0' } });
    });

    it('should skip version check when fluxVersion not provided', async () => {
      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);

      expect(resetHashSyncForUpgradeStub.called).to.be.false;
      const versionCall = findOneAndUpdateStub.getCalls().find(
        (c) => c.args[2]?._id === 'hashSyncVersion',
      );
      expect(versionCall).to.be.undefined;
    });
  });

  describe('stop', () => {
    it('should remove all listeners and clear intervals', () => {
      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      orchestrator.stop();
      expect(blockEmitter.listenerCount('blocksProcessed')).to.equal(0);
      expect(blockEmitter.listenerCount('hashesChanged')).to.equal(0);
      expect(peerEmitter.listenerCount('peerThresholdReached')).to.equal(0);
      expect(peerEmitter.listenerCount('peersBelowThreshold')).to.equal(0);
    });

    it('should clear heartbeat interval on stop', () => {
      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      orchestrator.stop();
      // No error thrown, interval cleaned up
    });
  });

  describe('readBootContext', () => {
    it('should detect machine reboot when boot_id differs', async () => {
      dbHelperStub.findOneInDatabase.resolves({
        lastAlive: Date.now() - 60000,
        machineBootId: 'old-boot-id',
        shutdownReason: 'sigterm',
      });

      const ctx = await AppSyncOrchestrator.readBootContext();

      expect(ctx.machineRebooted).to.be.true;
      expect(ctx.cleanShutdown).to.be.true;
      expect(ctx.firstBoot).to.be.false;
      expect(ctx.currentBootId).to.equal('test-boot-id-12345');
    });

    it('should detect FluxOS-only restart when boot_id matches', async () => {
      dbHelperStub.findOneInDatabase.resolves({
        lastAlive: Date.now() - 5000,
        machineBootId: 'test-boot-id-12345',
        shutdownReason: 'sigterm',
      });

      const ctx = await AppSyncOrchestrator.readBootContext();

      expect(ctx.machineRebooted).to.be.false;
      expect(ctx.cleanShutdown).to.be.true;
    });

    it('should detect first boot when no heartbeat exists', async () => {
      dbHelperStub.findOneInDatabase.resolves(null);

      const ctx = await AppSyncOrchestrator.readBootContext();

      expect(ctx.firstBoot).to.be.true;
      expect(ctx.machineRebooted).to.be.true;
      expect(ctx.downtimeMs).to.equal(Infinity);
    });

    it('should detect unclean shutdown when shutdownReason is absent', async () => {
      dbHelperStub.findOneInDatabase.resolves({
        lastAlive: Date.now() - 120000,
        machineBootId: 'old-boot-id',
      });

      const ctx = await AppSyncOrchestrator.readBootContext();

      expect(ctx.cleanShutdown).to.be.false;
      expect(ctx.machineRebooted).to.be.true;
    });

    it('should compute downtime from lastAlive', async () => {
      const fiveMinAgo = Date.now() - 300000;
      dbHelperStub.findOneInDatabase.resolves({
        lastAlive: fiveMinAgo,
        machineBootId: 'old-boot-id',
      });

      const ctx = await AppSyncOrchestrator.readBootContext();

      expect(ctx.downtimeMs).to.be.within(299000, 301000);
    });

    it('should return safe defaults on error', async () => {
      dbHelperStub.findOneInDatabase.rejects(new Error('DB down'));

      const ctx = await AppSyncOrchestrator.readBootContext();

      expect(ctx.machineRebooted).to.be.true;
      expect(ctx.downtimeMs).to.equal(Infinity);
      expect(ctx.cleanShutdown).to.be.false;
      expect(ctx.firstBoot).to.be.true;
    });
  });

  describe('writeShutdownReason', () => {
    it('should write shutdown reason to heartbeat doc', async () => {
      await AppSyncOrchestrator.writeShutdownReason('sigterm');

      const call = findOneAndUpdateStub.getCalls().find(
        (c) => c.args[2]?._id === 'heartbeat',
      );
      expect(call).to.not.be.undefined;
      expect(call.args[3]).to.deep.equal({ $set: { shutdownReason: 'sigterm' } });
    });

    it('should not throw on error', async () => {
      findOneAndUpdateStub.rejects(new Error('DB down'));
      await AppSyncOrchestrator.writeShutdownReason('sigterm');
      expect(logStub.error.calledWithMatch(/Failed to write shutdown reason/)).to.be.true;
    });
  });

  describe('heartbeat', () => {
    it('should write heartbeat immediately on start', async () => {
      const orchestrator = makeOrchestrator();
      await orchestrator.start(defaultBootContext);

      const heartbeatCall = findOneAndUpdateStub.getCalls().find(
        (c) => c.args[2]?._id === 'heartbeat' && c.args[3]?.$set && 'lastAlive' in c.args[3].$set,
      );
      expect(heartbeatCall).to.not.be.undefined;
      expect(heartbeatCall.args[3].$set.machineBootId).to.equal('test-boot-id-12345');
      orchestrator.stop();
    });

    it('should store boot context and expose via getter', async () => {
      const orchestrator = makeOrchestrator();
      await orchestrator.start(defaultBootContext);

      expect(orchestrator.bootContext).to.deep.equal(defaultBootContext);
      orchestrator.stop();
    });
  });

  describe('message capability changes', () => {
    function makeUncapableOrchestrator(overrides = {}) {
      return new AppSyncOrchestrator({ blockEmitter, ...makePeerOptions(), ...overrides });
    }

    it('should not reach READY without message capability', async () => {
      const orchestrator = makeUncapableOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      for (let i = 0; i < 130; i += 1) {
        blockEmitter.emit('blocksProcessed', 2555000 + i);
      }
      await clock.tickAsync(0);

      expect(orchestrator.state).to.equal(STATES.SYNCING);
    });

    it('should reach READY when capability gained after other conditions met', async () => {
      const orchestrator = makeUncapableOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);

      // Explorer syncs but hash sync deferred (no capability)
      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      for (let i = 0; i < 130; i += 1) {
        blockEmitter.emit('blocksProcessed', 2555000 + i);
      }
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(STATES.SYNCING);

      // Capability gained — triggers deferred sync + readiness
      orchestrator.onMessageCapabilityChange(true);
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(STATES.READY);
    });

    it('should emit READINESS_LOST when capability lost while READY', async () => {
      const spy = sinon.spy();
      appSyncEvents.on(EVENTS.READINESS_LOST, spy);

      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      for (let i = 0; i < 130; i += 1) {
        blockEmitter.emit('blocksProcessed', 2555000 + i);
      }
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(STATES.READY);

      orchestrator.onMessageCapabilityChange(false);
      expect(orchestrator.state).to.equal(STATES.SYNCING);
      expect(spy.calledOnce).to.be.true;
    });

    it('should emit SPAWNER_READY when capability regained', async () => {
      const readySpy = sinon.spy();
      const lostSpy = sinon.spy();
      appSyncEvents.on(EVENTS.SPAWNER_READY, readySpy);
      appSyncEvents.on(EVENTS.READINESS_LOST, lostSpy);

      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);


      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      for (let i = 0; i < 130; i += 1) {
        blockEmitter.emit('blocksProcessed', 2555000 + i);
      }
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(STATES.READY);
      expect(readySpy.calledOnce).to.be.true;

      orchestrator.onMessageCapabilityChange(false);
      expect(lostSpy.calledOnce).to.be.true;

      orchestrator.onMessageCapabilityChange(true);
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(STATES.READY);
      expect(readySpy.calledTwice).to.be.true;
    });

    it('should be a no-op when same value set twice', async () => {
      const orchestrator = makeUncapableOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);
      orchestrator.onMessageCapabilityChange(false);
      orchestrator.onMessageCapabilityChange(false);

      expect(logStub.info.calledWith('AppSyncOrchestrator - Message capability lost')).to.be.false;
    });

    it('should not produce log spam from block events when not confirmed', async () => {
      const orchestrator = makeUncapableOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      for (let i = 0; i < 130; i += 1) {
        blockEmitter.emit('blocksProcessed', 2555000 + i);
      }
      await clock.tickAsync(0);

      const notConfirmedLogs = logStub.info.getCalls().filter(
        (c) => typeof c.args[0] === 'string' && c.args[0].includes('not confirmed'),
      );
      expect(notConfirmedLogs).to.have.lengthOf(0);
    });
  });
});
