'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const { resetGlobalState } = require('./fixtures/globalState');
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
  let proxyquireMap;
  let loadWithConfig;
  let connections;
  let nextConnectionId;
  let removed;
  let logStub;
  let syncMissingHashesStub;
  let getMissingHashesStub;
  let reindexStub;
  let globalStateStub;
  let checkAndNotifyStub;
  let startBroadcastingStub;
  let resetHashSyncForUpgradeStub;
  let nodeStartupRepositoryStub;
  let findOneAndUpdateStub;
  let getFluxNodePublicKeyStub;
  let getFluxNodePrivateKeyStub;
  let signMessageStub;
  let reconcileStub;
  let buildSyncSigStub;
  let encodeAppRunningStub;

  // A peer is a CONNECTION, not an address. FluxPeerSocket stamps each one
  // with an id so a request written into one socket can be told from whatever
  // dials in next under the same ip:port.
  function makePeer(key) {
    nextConnectionId += 1;
    connections.set(key, nextConnectionId);
    return { key, connectionId: nextConnectionId, send: sinon.stub() };
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

  // Which peers have been asked is the orchestrator's own record now, so the
  // manager side of the seam is only what FluxPeerManager actually offers:
  // the peers worth asking, and which connection is currently held to each.
  function makePeerOptions(overrides = {}) {
    return {
      getEligibleSyncPeers: getEligibleSyncPeersStub,
      getPeerByKey: (key) => getEligibleSyncPeersStub(0).find((p) => p.key === key) ?? null,
      onPeerEvent: (event, cb) => peerEmitter.on(event, cb),
      offPeerEvent: (event, cb) => peerEmitter.removeListener(event, cb),
      ...overrides,
    };
  }

  // What FluxPeerManager.remove() does: the peer goes and the removal is
  // ANNOUNCED. The announcement is the half that matters to anything waiting
  // on that peer for an answer - without it the wait can only end at a
  // deadline, which is the whole point of saying so.
  function removePeer(key) {
    const connectionId = connections.get(key) ?? null;
    connections.delete(key);
    // It leaves the peer map, so getEligibleSyncPeers stops offering it - a
    // fake that goes on returning a peer whose socket closed lets the code
    // re-ask a peer production could not have offered.
    removed.add(key);
    peerEmitter.emit('peerDisconnected', key, connectionId);
  }

  // What FluxPeerManager.add() does when a peer is already there: the old
  // socket is dropped and a NEW one takes the same key. The address does not
  // move and the count does not change, so the only thing that says anything
  // happened is the connection ending - which the manager now announces.
  function reconnectPeer(key) {
    const previous = connections.get(key) ?? null;
    const peer = makePeer(key);
    peerEmitter.emit('peerDisconnected', key, previous);
    peerEmitter.emit('peerConnected', key, peer.connectionId);
    return peer;
  }

  // A completion carries the peer it came from, exactly as the response
  // handlers emit it - they have had the key all along. Distinct peers here, so
  // a test that means "three peers answered" says so rather than relying on a
  // count that three answers from one peer would also satisfy.
  function completeAllTypes(count, types = ['apprunning', 'appinstalling', 'apperrors', 'apptemp']) {
    for (let i = 0; i < count; i += 1) {
      for (const type of types) {
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, type, `10.0.0.${i + 1}:16127`);
      }
    }
  }

  // THE BLOCK FALLBACK ONLY RUNS WITH PEERS, so a test whose subject is the
  // fallback has to say the peer set is up or it is asserting on a timer that
  // cannot advance. The eligible list is left alone - usually empty - because
  // connected peers and peers eligible to answer a state sync are different
  // sets: a node can hold twelve of the first and none of the second, which is
  // exactly the "no sync peers available" case several of these tests mean.
  function peersUp(count = 12) {
    peerEmitter.emit('peerThresholdReached', count);
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
    connections = new Map();
    nextConnectionId = 0;
    removed = new Set();

    logStub = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };
    syncMissingHashesStub = sinon.stub().resolves({ resolved: 0, missing: 0, unreachable: 0, nextRetryHeight: null });
    getMissingHashesStub = sinon.stub().resolves([]);
    reindexStub = sinon.stub().resolves();
    // The real module. dbReady stays closed - the assertions below are about the
    // orchestrator opening it - and only the boot-settled wait is spied, so a
    // test does not sit on a gate nothing here opens.
    globalStateStub = resetGlobalState();
    sinon.stub(globalStateStub, 'waitForBootContainerStateSettled').resolves();
    checkAndNotifyStub = sinon.stub().resolves();
    startBroadcastingStub = sinon.stub();
    resetHashSyncForUpgradeStub = sinon.stub().resolves(0);
    findOneAndUpdateStub = sinon.stub().resolves();
    // The orchestrator talks to the startup repository, not to mongo.
    nodeStartupRepositoryStub = {
      getHashSyncVersionMarker: sinon.stub().resolves(null),
      setHashSyncVersionMarker: sinon.stub().resolves(),
      getHeartbeat: sinon.stub().resolves(null),
      writeHeartbeat: sinon.stub().resolves(),
      setShutdownReason: sinon.stub().resolves(),
      clearShutdownReason: sinon.stub().resolves(),
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
    ({ appSyncEvents, EVENTS } = appSyncEventsModule);
    appSyncEvents.removeAllListeners();

    // Kept so a test that needs a different config can reload the module with
    // the same doubles - the module reads its constants once, at require time.
    proxyquireMap = {
      'fs': { promises: { readFile: sinon.stub().resolves('test-boot-id-12345\n') } },
      '../../lib/log': logStub,
      '../appDatabase/nodeStartupRepository': nodeStartupRepositoryStub,
      './appHashSyncService': { syncMissingHashes: syncMissingHashesStub, getMissingHashes: getMissingHashesStub, resetHashSyncForUpgrade: resetHashSyncForUpgradeStub },
      './contentManifestSyncService': { reconcile: reconcileStub, depositIndex: sinon.stub(), isPeerInActiveRound: sinon.stub().returns(false) },
      './ingressAttestationSyncService': { reconcile: sinon.stub().resolves({ peers: 0, indexesReceived: 0, fetched: 0 }), depositDigests: sinon.stub(), isPeerInActiveRound: sinon.stub().returns(false) },
      './peerNotification': {
        checkAndNotifyPeersOfRunningApps: checkAndNotifyStub,
        startBroadcasting: startBroadcastingStub,
        stopBroadcasting: sinon.stub().resolves(),
      },
      '../appDatabase/registryManager': {
        reindexGlobalAppsInformation: reindexStub,
      },
      '../utils/globalState': globalStateStub,
      '../utils/peerCodec': {
        MSG_TYPE: {
          REQUEST_TEMP_MESSAGES: 0x20, REQUEST_APP_RUNNING: 0x21, REQUEST_APP_INSTALLING: 0x22, REQUEST_APP_INSTALLING_ERRORS: 0x23,
        },
        buildSyncSignatureMessage: (buildSyncSigStub = sinon.stub().returns('testmsg')),
        encodeRequestTempMessages: sinon.stub().returns(Buffer.alloc(9, 0x20)),
        encodeRequestAppRunning: (encodeAppRunningStub = sinon.stub().returns(Buffer.alloc(9, 0x21))),
        encodeRequestAppInstalling: sinon.stub().returns(Buffer.alloc(9, 0x22)),
        encodeRequestAppInstallingErrors: sinon.stub().returns(Buffer.alloc(9, 0x23)),
      },
      '../utils/nodeSigner': {
        nodeSigner: async () => {
          const pubKey = await getFluxNodePublicKeyStub();
          const privKey = await getFluxNodePrivateKeyStub();
          if (!pubKey || typeof pubKey !== 'string' || !privKey || typeof privKey !== 'string') return null;
          return { pubKey, sign: (message) => signMessageStub(message, privKey) };
        },
      },
      '../utils/appSyncEvents': appSyncEventsModule,
    };

    loadWithConfig = (fluxappsOverrides) => {
      const realConfig = require('config');
      return proxyquire('../../ZelBack/src/services/appMessaging/appSyncOrchestrator', {
        ...proxyquireMap,
        config: {
          ...realConfig,
          database: realConfig.database,
          fluxapps: { ...realConfig.fluxapps, ...fluxappsOverrides },
        },
      });
    };

    ({ AppSyncOrchestrator, STATES } = proxyquire('../../ZelBack/src/services/appMessaging/appSyncOrchestrator', proxyquireMap));
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
      expect(startBroadcastingStub.calledOnce).to.be.true;
    });

    it('should start sync from the latched level when the threshold edge fired before start', async () => {
      // peerThresholdReached is edge-triggered and latched in FluxPeerManager:
      // if peers connected before start() subscribed, the edge never re-fires.
      // start() must read the level after subscribing — no edge is emitted here.
      const orchestrator = makeOrchestrator({ isAboveThreshold: () => true });
      orchestrator.start(defaultBootContext);
      await clock.tickAsync(0);
      expect(getEligibleSyncPeersStub.calledOnce).to.be.true;
      expect(startBroadcastingStub.calledOnce).to.be.true;
    });

    it('should not start sync from the level when the threshold has not been reached', async () => {
      const orchestrator = makeOrchestrator({ isAboveThreshold: () => false });
      orchestrator.start(defaultBootContext);
      await clock.tickAsync(0);
      expect(getEligibleSyncPeersStub.called).to.be.false;
    });

    it('should transition to DEGRADED on peersBelowThreshold when READY', async () => {
      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);


      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      for (let i = 0; i < 260; i += 1) {
        blockEmitter.emit('blocksProcessed', 2555000 + i);
      }
      await clock.tickAsync(0);

      expect(orchestrator.state).to.equal(STATES.READY);
      peerEmitter.emit('peersBelowThreshold', 3);
      expect(orchestrator.state).to.equal(STATES.DEGRADED);
    });

    // The floor is an invariant of the node, not of an enumerated state list:
    // a collapse during RESYNCING must land DEGRADED, and the in-flight
    // resync's completion must not promote past it - READY entry reads the
    // peer level like every other readiness condition.
    it('lands DEGRADED, never READY, when the floor collapses mid-RESYNCING', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      for (let i = 0; i < 3; i += 1) {
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apprunning');
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'appinstalling');
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apperrors');
      }
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(STATES.READY);

      peerEmitter.emit('peersBelowThreshold', 3);
      expect(orchestrator.state).to.equal(STATES.DEGRADED);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(STATES.RESYNCING);

      // Every peer gone while the resync is in flight...
      peerEmitter.emit('peersBelowThreshold', 0);
      // ...and the rounds already in flight then complete anyway.
      for (let i = 0; i < 3; i += 1) {
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apprunning');
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'appinstalling');
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apperrors');
      }
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(STATES.DEGRADED);
    });

    // A degrade closes the sync epoch: the block timer that backstopped the
    // PREVIOUS epoch must not release the next one. A node that reached READY
    // on the timer, degraded, and recovered its peers has a resync to run —
    // promoting on the dead epoch's expired timer skips the hash sync
    // entirely (gate-3 suite 108: RESYNCING -> READY in 2.3s, no sync ran).
    it('starts recovery with a fresh block timer - the old epoch\'s expiry cannot promote', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      for (let i = 0; i < 130; i += 1) {
        blockEmitter.emit('blocksProcessed', 2555000 + i);
      }
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(STATES.READY);

      peerEmitter.emit('peersBelowThreshold', 3);
      expect(orchestrator.state).to.equal(STATES.DEGRADED);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(STATES.RESYNCING);
    });

    it('should emit readinessLost on degradation', async () => {
      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);

      const spy = sinon.spy();
      appSyncEvents.on(EVENTS.READINESS_LOST, spy);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      for (let i = 0; i < 260; i += 1) {
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

    // A pool that cannot be filled yet is still worth part-filling. Waiting for
    // enough candidates to arrive before asking ANY of them was a road out of
    // the request path that sent nothing at all, and the answers it declined to
    // collect are exactly the ones that would have been banked by the time the
    // rest of the fleet showed up.
    it('asks the peers it has, even when there are fewer than the requirement', async () => {
      const peers = makeEligiblePeers(2);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);

      for (const peer of peers) {
        expect(peer.send.callCount, 'a peer that could have answered was not asked').to.equal(4);
      }
    });

    // A node asks one peer, the connection dies before the bytes leave, and the
    // request is lost silently - a send into a closing socket does not throw. The
    // peer was recorded as asked, so every later pass filtered it out, logged
    // "No new eligible sync peers to ask" and asked nobody. The node stayed
    // SYNCING and never reached READY, permanently, from one lost message.
    //
    // Seen on a real fleet: 74ms for one direction of the same 3-node fleet, 30s
    // and zero completions for the other, and that log line 15 times in another
    // suite's node.
    //
    // What ends the stranding is the SLOT being freed, not the peer being
    // offered again: a peer that dropped mid-attempt has had its turn, and the
    // deficit it leaves behind is filled by someone who has not.
    it('fills the slot from another peer when a connection went away before it answered', async () => {
      const peers = makeEligiblePeers(3);
      const spares = ['10.0.0.7:16127', '10.0.0.8:16127', '10.0.0.9:16127'].map(makePeer);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);

      const asked = peers.filter((p) => p.send.called);
      expect(asked.length).to.be.greaterThan(0);

      // The peer goes. The request it was sent is gone with it and no answer
      // will ever arrive.
      // Both, so the test can tell a peer being SKIPPED from one simply not
      // being offered: under the rule this replaced, the dropped peers become
      // candidates again and are the first thing a pass reaches for.
      getEligibleSyncPeersStub.returns([...asked, ...spares]);
      asked.forEach((p) => p.send.resetHistory());
      asked.forEach((p) => removePeer(p.key));
      await clock.tickAsync(0);

      expect(spares.some((p) => p.send.called), 'the slot a dropped peer freed was never refilled').to.equal(true);
      expect(asked.some((p) => p.send.called), 'a peer that dropped mid-attempt was asked again').to.equal(false);
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

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);


      // Get to READY via block-count fallback
      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      for (let i = 0; i < 260; i += 1) {
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

  // The pool of outstanding requests equalled the requirement exactly: three
  // asked, three completions needed, no spare. When one asked peer's connection
  // went away the request went with it and nothing re-asked - the only trigger
  // was `peerThresholdReached`, a latched edge that had already been spent and
  // that is cleared only below the DEGRADED level, so the count never fell.
  // The node then waited for the block timer: 125 minutes in SYNCING with the
  // spawner paused, observed on a three-node fleet booting 50ms apart.
  describe('re-driving the sync when a peer joins', () => {
    it('asks a peer that joins after an asked one was lost, with no second threshold edge', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      for (const peer of peers) expect(peer.send.callCount).to.equal(4);

      // What remove() does: the mark dies with the connection, and the peer is
      // no longer eligible because it is no longer in the peer map.
      removePeer(peers[0].key);
      const joiner = makePeer('10.0.0.9:16127');
      getEligibleSyncPeersStub.returns([peers[1], peers[2], joiner]);

      // No threshold event. The latch fired before the loss and the count never
      // dropped below DEGRADED, so on `development` nothing happens here.
      peerEmitter.emit('peerConnected', joiner.key, 99);
      await clock.tickAsync(0);

      expect(joiner.send.callCount, 'the peer that joined was never asked').to.equal(4);
    });

    it('sends nothing when a peer joins and the pool is still whole', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);

      // Nothing was lost, so nothing is owed. A boot brings peers in steadily
      // and every one of them arrives here; asking on each is the over-asking
      // this must not become - two extra event-log streams per node boot,
      // fleet-wide and permanently, to cover a rare case.
      const joiner = makePeer('10.0.0.9:16127');
      getEligibleSyncPeersStub.returns([...peers, joiner]);
      peerEmitter.emit('peerConnected', joiner.key, 99);
      await clock.tickAsync(0);

      expect(joiner.send.called, 'a joining peer was asked while the pool was whole').to.equal(false);
      for (const peer of peers) expect(peer.send.callCount).to.equal(4);
    });

    it('asks the shortfall and no more when several peers are available', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);

      // Two of the three go; one asked peer is still outstanding, so the
      // deficit is two - not a fresh round of three.
      removePeer(peers[0].key);
      removePeer(peers[1].key);
      const joiners = [makePeer('10.0.0.7:16127'), makePeer('10.0.0.8:16127'), makePeer('10.0.0.9:16127')];
      getEligibleSyncPeersStub.returns([peers[2], ...joiners]);

      peerEmitter.emit('peerConnected', joiners[0].key, 99);
      await clock.tickAsync(0);

      const asked = joiners.filter((p) => p.send.called);
      expect(asked.length, 'asked a different number of peers than were missing').to.equal(2);
      expect(peers[2].send.callCount, 'the peer still outstanding was asked twice').to.equal(4);
    });

    it('asks nobody once the state sync is complete', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);

      completeAllTypes(3);
      await clock.tickAsync(0);

      // Completion clears the marks, so without the state-sync guard every
      // later join looks like a pool that owes three requests - and it is the
      // ALREADY-ASKED peers it would ask again, since they come first in the
      // eligible list. Asserting only that the joiner is quiet passes on the
      // slice order rather than on the guard, so count every peer.
      const before = peers.map((p) => p.send.callCount);
      const joiner = makePeer('10.0.0.9:16127');
      getEligibleSyncPeersStub.returns([...peers, joiner]);
      peerEmitter.emit('peerConnected', joiner.key, 99);
      await clock.tickAsync(0);

      expect(joiner.send.called, 'a joining peer was asked after the sync was complete').to.equal(false);
      expect(peers.map((p) => p.send.callCount), 'peers were asked again after the sync was complete').to.deep.equal(before);
    });

    it('does not ask before the threshold has started the sync', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);

      // Peers arrive before the threshold is crossed. The first ask belongs to
      // the threshold edge; joining early must not bring it forward.
      peerEmitter.emit('peerConnected', peers[0].key, 99);
      await clock.tickAsync(0);

      for (const peer of peers) expect(peer.send.called, 'asked before the sync had started').to.equal(false);
    });

    // The pool was part-filled because that was all there was, so the join
    // completes it rather than starting it. The peers already asked are not
    // asked again, which is the record doing its job.
    it('asks a joiner for the shortfall a part-filled pool still carries', async () => {
      const peers = makeEligiblePeers(2);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      for (const peer of peers) expect(peer.send.callCount).to.equal(4);

      const joiner = makePeer('10.0.0.9:16127');
      getEligibleSyncPeersStub.returns([...peers, joiner]);
      peerEmitter.emit('peerConnected', joiner.key, 99);
      await clock.tickAsync(0);

      for (const peer of peers) expect(peer.send.callCount, 'an outstanding request was sent twice').to.equal(4);

      for (const peer of [...peers, joiner]) {
        expect(peer.send.callCount, 'the fleet reached three eligible peers and still asked nobody').to.equal(4);
      }
    });
  });

  // Completion needs MIN_SYNC_COMPLETIONS answers because three peers' views of
  // the network are what make the result trustworthy. Counting answers rather
  // than peers meant one peer could satisfy all three, and the node concluded
  // it had surveyed the network when it had surveyed one node.
  describe('a completion is a peer, not a tally', () => {
    const driveToRequests = async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);
      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      return orchestrator;
    };

    it('does not complete on three answers from one peer', async () => {
      const orchestrator = await driveToRequests();

      for (let i = 0; i < 3; i += 1) {
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apprunning', '10.0.0.1:16127');
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'appinstalling', '10.0.0.1:16127');
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apperrors', '10.0.0.1:16127');
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apptemp', '10.0.0.1:16127');
      }
      await clock.tickAsync(0);

      expect(orchestrator.state, 'one peer answering three times completed the sync').to.equal(STATES.SYNCING);
    });

    it('completes on the same nine answers spread across three peers', async () => {
      const orchestrator = await driveToRequests();

      completeAllTypes(3);
      await clock.tickAsync(0);

      expect(orchestrator.state).to.equal(STATES.READY);
    });

    // The response handlers have the key and always had it. A completion
    // arriving without one means that path stopped saying, and absorbing it
    // silently is how the tally came back.
    it('refuses a completion that cannot be attributed to a peer', async () => {
      const orchestrator = await driveToRequests();

      for (let i = 0; i < 3; i += 1) {
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apprunning');
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'appinstalling');
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apperrors');
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apptemp');
      }
      await clock.tickAsync(0);

      expect(orchestrator.state, 'unattributed completions were counted').to.equal(STATES.SYNCING);
      expect(logStub.error.called, 'an unattributable completion was absorbed silently').to.equal(true);
    });
  });

  // NOTHING IS HOLDING THE RECONCILER'S PROMISE. Its five triggers all call and
  // return, and one of them is a timer, so a throw inside a pass is a rejection
  // with no owner - which node raises to the process handler in apiServer, and
  // that answers by exiting the node.
  describe('a reconcile pass that fails does not take the node with it', () => {
    const driveToThreshold = async (orchestrator) => {
      orchestrator.start(defaultBootContext);
      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
    };

    it('reports a failed pass instead of leaving a rejection with no owner', async () => {
      const rejections = [];
      const onRejection = (reason) => rejections.push(reason);
      process.on('unhandledRejection', onRejection);
      getEligibleSyncPeersStub = sinon.stub().throws(new Error('the peer list is unavailable'));

      const orchestrator = makeOrchestrator();
      try {
        await driveToThreshold(orchestrator);
        await clock.tickAsync(0);
      } finally {
        process.removeListener('unhandledRejection', onRejection);
        await orchestrator.stop();
      }

      expect(rejections, 'a failed pass left a rejection nobody was holding').to.deep.equal([]);
      expect(
        logStub.error.calledWith(sinon.match(/Reconcile pass failed: the peer list is unavailable/)),
        'a failed pass went unreported',
      ).to.equal(true);
    });

    // The pass gives up; the reconciler does not. A pool left short by a failed
    // pass is filled by the next trigger, which is what the two passes that
    // already return early rely on too.
    it('asks again on the next trigger after a pass has failed', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub();
      getEligibleSyncPeersStub.onFirstCall().throws(new Error('the peer list is unavailable'));
      getEligibleSyncPeersStub.returns(peers);

      const orchestrator = makeOrchestrator();
      await driveToThreshold(orchestrator);

      expect(peers.some((p) => p.send.called), 'a pass that threw still sent requests').to.equal(false);

      peerEmitter.emit('peerConnected', peers[0].key, 99);
      await clock.tickAsync(0);

      expect(peers.every((p) => p.send.called), 'the reconciler stopped after one pass failed').to.equal(true);
      await orchestrator.stop();
    });
  });

  // A STREAM WITH A HOLE IN IT IS NOT A SURVEY. A chunk this node cannot
  // attribute ends the peer's request where a refusal or a stall would, rather
  // than being stepped over and the rest of the answer counted.
  describe('a peer whose response cannot be verified is replaced', () => {
    it('ends the request and asks another peer', async () => {
      const peers = makeEligiblePeers(3);
      const spare = makePeer('10.0.0.9:16127');
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);

      getEligibleSyncPeersStub.returns([peers[1], peers[2], spare]);
      appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_UNVERIFIED, peers[0].key);
      await clock.tickAsync(0);

      expect(spare.send.called, 'a peer that sent an unverifiable chunk kept its slot').to.equal(true);
      expect(
        orchestrator.isSyncResponseWanted(peers[0]),
        'a peer whose stream had a hole in it was still being waited on',
      ).to.equal(false);
      await orchestrator.stop();
    });

    // The response path has the key and always had it. One arriving without a
    // peer means that path stopped saying, which is a fault to report.
    it('refuses to act on an unverifiable response that names no peer', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);

      appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_UNVERIFIED);
      await clock.tickAsync(0);

      expect(orchestrator.isSyncResponseWanted(peers[0]), 'an unattributed failure closed a peer\'s request')
        .to.equal(true);
      expect(logStub.error.called, 'an unattributable failure was absorbed silently').to.equal(true);
      await orchestrator.stop();
    });
  });

  // A PEER IS CREDITED WHEN IT HAS FINISHED, not when the part of it the tally
  // reads has. A request asks for four streams and the record that admits a
  // peer's responses closes on the credit, so crediting on three closed the
  // record while the fourth was still arriving and the rest of that stream was
  // dropped. Pending registrations are small - single figures on mainnet - so
  // waiting for that stream costs the sync nothing measurable.
  describe('a peer is credited once every stream it was asked for has ended', () => {
    const driveToRequests = async (peers) => {
      getEligibleSyncPeersStub = sinon.stub().returns(peers);
      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      return orchestrator;
    };

    it('does not complete the sync on the three surveys alone', async () => {
      const orchestrator = await driveToRequests(makeEligiblePeers(3));

      completeAllTypes(3, ['apprunning', 'appinstalling', 'apperrors']);
      await clock.tickAsync(0);

      expect(orchestrator.state, 'a peer was credited before its last stream had ended')
        .to.equal(STATES.SYNCING);

      completeAllTypes(3, ['apptemp']);
      await clock.tickAsync(0);

      expect(orchestrator.state).to.equal(STATES.READY);
    });

    it('goes on admitting a peer whose last stream is still arriving', async () => {
      const peers = makeEligiblePeers(3);
      const orchestrator = await driveToRequests(peers);

      for (const type of ['apprunning', 'appinstalling', 'apperrors']) {
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, type, peers[0].key);
      }
      await clock.tickAsync(0);

      expect(
        orchestrator.isSyncResponseWanted(peers[0]),
        'the surveys finishing cut off a stream that was still arriving',
      ).to.equal(true);

      appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apptemp', peers[0].key);
      await clock.tickAsync(0);

      expect(
        orchestrator.isSyncResponseWanted(peers[0]),
        'a peer that had delivered everything was still being waited on',
      ).to.equal(false);
      await orchestrator.stop();
    });
  });

  // A peer that declines has ANSWERED, and the answer is not a completion. It
  // leaves the candidate pool for that connection, so the deficit #requestSyncs
  // asks against opens by one and someone who may actually know gets asked.
  describe('a peer that declines is replaced', () => {
    it('asks another peer when one declines', async () => {
      const peers = makeEligiblePeers(3);
      const spare = makePeer('10.0.0.9:16127');
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      for (const peer of peers) expect(peer.send.callCount).to.equal(4);

      // Declining takes it out of the eligible list, exactly as the flag on the
      // socket takes it out of getEligibleSyncPeers.
      getEligibleSyncPeersStub.returns([peers[1], peers[2], spare]);
      appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_REFUSED, 'apprunning', peers[0].key);
      await clock.tickAsync(0);

      expect(spare.send.callCount, 'a peer declined and nobody else was asked').to.equal(4);
    });

    it('does not start a second round for a refusal from a peer it never asked', async () => {
      const peers = makeEligiblePeers(3);
      const spare = makePeer('10.0.0.9:16127');
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);

      // Nothing was marked, so the pool never lost a member. The deficit is what
      // decides, and a whole pool owes nothing however the pass was reached.
      getEligibleSyncPeersStub.returns([...peers, spare]);
      appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_REFUSED, 'apprunning', '203.0.113.1:16127');
      await clock.tickAsync(0);

      expect(spare.send.called).to.equal(false);
      for (const peer of peers) expect(peer.send.callCount).to.equal(4);
    });

    it('replaces a peer once however many types it declines', async () => {
      const peers = makeEligiblePeers(3);
      const spares = [makePeer('10.0.0.7:16127'), makePeer('10.0.0.8:16127'), makePeer('10.0.0.9:16127')];
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);

      // A node refuses every stream when it refuses any, and the passes after
      // the first find the pool already topped up.
      getEligibleSyncPeersStub.returns([peers[1], peers[2], ...spares]);
      for (const type of ['apprunning', 'appinstalling', 'apperrors', 'apptemp']) {
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_REFUSED, type, peers[0].key);
      }
      await clock.tickAsync(0);

      const asked = spares.filter((p) => p.send.called);
      expect(asked.length, 'one declining peer pulled in more than one replacement').to.equal(1);
    });

    it('asks nobody more once the state sync is complete', async () => {
      const peers = makeEligiblePeers(3);
      const spare = makePeer('10.0.0.9:16127');
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      completeAllTypes(3);
      await clock.tickAsync(0);

      getEligibleSyncPeersStub.returns([peers[1], peers[2], spare]);
      appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_REFUSED, 'apprunning', peers[0].key);
      await clock.tickAsync(0);

      expect(spare.send.called).to.equal(false);
    });

    it('reports a refusal that names no peer instead of absorbing it', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);

      appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_REFUSED, 'apprunning');
      await clock.tickAsync(0);

      expect(logStub.error.called, 'a refusal with no peer was absorbed silently').to.equal(true);
    });

    it('stops listening for refusals on stop', async () => {
      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      await orchestrator.stop();

      expect(appSyncEvents.listenerCount(EVENTS.EPHEMERAL_SYNC_REFUSED)).to.equal(0);
    });
  });

  // The sync responder reads this to decide whether its own answer is worth
  // another node's survey. It has to follow the rule, not a copy of it.
  describe('the state-sync verdict is published for the responder', () => {
    it('is false while the sync is incomplete and true once it completes', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);

      expect(globalStateStub.appStateAuthoritative, 'authoritative before anyone answered').to.equal(false);

      completeAllTypes(3);
      await clock.tickAsync(0);

      expect(globalStateStub.appStateAuthoritative).to.equal(true);
    });

    it('goes false again when the peers go and the sync is reset', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      completeAllTypes(3);
      await clock.tickAsync(0);
      expect(globalStateStub.appStateAuthoritative).to.equal(true);

      peerEmitter.emit('peersBelowThreshold', 3);
      await clock.tickAsync(0);

      expect(globalStateStub.appStateAuthoritative, 'a degraded node still claimed authority').to.equal(false);
    });

    // Authority is a claim about a network this orchestrator is tracking, and
    // the guards that answer a peer's sync request read it from a global that
    // outlives the instance.
    it('drops authority when it stops', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      completeAllTypes(3);
      await clock.tickAsync(0);
      expect(globalStateStub.appStateAuthoritative).to.equal(true);

      await orchestrator.stop();

      expect(globalStateStub.appStateAuthoritative, 'a stopped orchestrator still claimed authority').to.equal(false);
    });
  });

  // The block fallback was two literals, so no fleet could have a node that
  // was able to answer a sync request from the moment it started - and on a
  // fleet where every node is still syncing, every node declines every other
  // and they all wait out 250 blocks.
  describe('the block fallback is configured, not hardcoded', () => {
    it('is authoritative from the moment it starts when told to wait no blocks', async () => {
      const mod = loadWithConfig({ appSyncFallbackMinutes: 0 });
      const orchestrator = new mod.AppSyncOrchestrator({
        blockEmitter, ...makePeerOptions(),
      });
      orchestrator.onMessageCapabilityChange(true);

      await orchestrator.start(defaultBootContext);

      expect(globalStateStub.appStateAuthoritative, 'a node told to wait no blocks still declined').to.equal(true);
    });

    it('is not authoritative at start on the production budget', async () => {
      const mod = loadWithConfig({ appSyncFallbackMinutes: 125 });
      const orchestrator = new mod.AppSyncOrchestrator({
        blockEmitter, ...makePeerOptions(),
      });
      orchestrator.onMessageCapabilityChange(true);

      await orchestrator.start(defaultBootContext);

      expect(globalStateStub.appStateAuthoritative).to.equal(false);
    });

    it('reaches readiness on the configured number of blocks rather than 250', async () => {
      const mod = loadWithConfig({ appSyncFallbackMinutes: 2 });
      getEligibleSyncPeersStub = sinon.stub().returns([]);
      const orchestrator = new mod.AppSyncOrchestrator({
        blockEmitter, ...makePeerOptions(),
      });
      orchestrator.onMessageCapabilityChange(true);
      await orchestrator.start(defaultBootContext);
      peersUp();

      // 2 minutes at 2 blocks a minute, so the fourth block is past it and the
      // 250th is not the bar any more.
      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      for (let i = 1; i <= 4; i += 1) blockEmitter.emit('blocksProcessed', 2555000 + i);
      await clock.tickAsync(0);

      expect(orchestrator.state).to.equal(mod.STATES.READY);
      expect(globalStateStub.appStateAuthoritative).to.equal(true);
    });
  });

  // A PEERLESS NODE MUST NOT REACH SPAWNING READINESS. Every gate
  // #checkReadiness would hold a node at - hash sync, the DB rebuild, the state
  // sync - is waived by the block fallback, and #canSendMessages is on-chain
  // confirmation rather than anything to do with peers. So the fallback counter
  // IS the invariant: gate it and a node with nobody to learn from cannot
  // arrive, gate anything else and there are three other roads.
  //
  // Two minutes of fallback, so four blocks. Small enough that the arithmetic
  // is the assertion rather than a loop of 260.
  describe('the block fallback is time spent WITH PEERS, not uptime', () => {
    const FALLBACK_BLOCKS = 4;

    function makeAtTwoMinutes() {
      const mod = loadWithConfig({ appSyncFallbackMinutes: 2 });
      const orchestrator = new mod.AppSyncOrchestrator({ blockEmitter, ...makePeerOptions() });
      orchestrator.onMessageCapabilityChange(true);
      return { mod, orchestrator };
    }

    // The first block also starts the explorer, and #onBlocksProcessed counts it
    // as one because there is no previous height to difference against.
    async function driveBlocks(from, count) {
      for (let i = 0; i < count; i += 1) {
        blockEmitter.emit('blocksProcessed', from + i);
      }
      await clock.tickAsync(0);
    }

    it('never reaches READY with no peers, however many blocks arrive', async () => {
      const { mod, orchestrator } = makeAtTwoMinutes();
      await orchestrator.start(defaultBootContext);

      // Ten times the budget. The hash sync and DB rebuild both succeed here, so
      // the ONLY thing left between this node and READY is the fallback.
      await driveBlocks(2555000, FALLBACK_BLOCKS * 10);

      expect(orchestrator.state, 'a node with no peers reached spawning readiness').to.equal(mod.STATES.SYNCING);
      expect(globalStateStub.appStateAuthoritative, 'it also offered to answer peers about app state').to.equal(false);
    });

    it('reaches READY on the budget once the peer set is up', async () => {
      const { mod, orchestrator } = makeAtTwoMinutes();
      await orchestrator.start(defaultBootContext);
      peersUp();
      await clock.tickAsync(0);

      await driveBlocks(2555000, FALLBACK_BLOCKS - 1);
      expect(orchestrator.state, 'three blocks is not four').to.equal(mod.STATES.SYNCING);

      await driveBlocks(2555000 + FALLBACK_BLOCKS - 1, 1);
      expect(orchestrator.state).to.equal(mod.STATES.READY);
    });

    it('starts the budget again from zero after the peer set is lost and recovered', async () => {
      const { mod, orchestrator } = makeAtTwoMinutes();
      await orchestrator.start(defaultBootContext);
      peersUp();
      await clock.tickAsync(0);

      await driveBlocks(2555000, 3);
      expect(orchestrator.state).to.equal(mod.STATES.SYNCING);

      peerEmitter.emit('peersBelowThreshold', 3);
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(mod.STATES.DEGRADED);

      peersUp();
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(mod.STATES.RESYNCING);

      // Three more. Six in total, which would be past the budget twice over if
      // the credit earned before the gap still counted.
      // Contiguous with the three above: #onBlocksProcessed credits the
      // DIFFERENCE between heights, so a gap in the numbers is a gap in blocks
      // and would hand this node the budget it is supposed to have lost.
      await driveBlocks(2555003, 3);
      expect(orchestrator.state, 'credit accumulated across a gap with no peers').to.equal(mod.STATES.RESYNCING);

      await driveBlocks(2555006, 1);
      expect(orchestrator.state).to.equal(mod.STATES.READY);
    });

    // THE CASE NO STATE CHANGE MARKS. #onPeersDegraded only acts from READY and
    // SYNCING, so a node that has already recovered once - it is in RESYNCING -
    // and then loses its peers again transitions nowhere. Nothing about the
    // state machine records it, and before this fix nothing about the budget
    // did either: the level stayed latched from the recovery and the counter
    // went on advancing with no peers to advance it. It is the road to READY
    // with an empty peer set that survives every other guard.
    it('stops the budget when the peer set goes a second time, which moves no state', async () => {
      const { mod, orchestrator } = makeAtTwoMinutes();
      await orchestrator.start(defaultBootContext);
      peersUp();
      await clock.tickAsync(0);
      await driveBlocks(2555000, 3);

      peerEmitter.emit('peersBelowThreshold', 3);
      await clock.tickAsync(0);
      peersUp();
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(mod.STATES.RESYNCING);

      peerEmitter.emit('peersBelowThreshold', 2);
      await clock.tickAsync(0);
      expect(orchestrator.state, 'a second loss is meant to be invisible to the state machine').to.equal(mod.STATES.RESYNCING);

      await driveBlocks(2555003, FALLBACK_BLOCKS * 5);

      expect(orchestrator.state, 'a node with no peers reached READY through RESYNCING').to.equal(mod.STATES.RESYNCING);
      expect(globalStateStub.appStateAuthoritative).to.equal(false);
    });

    // Between appSyncPeerThreshold (12) and appSyncDegradedThreshold (4)
    // FluxPeerManager emits NEITHER edge - that band is what the hysteresis is -
    // so a node oscillating between 5 and 11 peers reaches this class as
    // peerConnected/peerDisconnected and nothing else. Reading a raw count here
    // would reset the budget continuously and such a node would never finish.
    it('does not restart the budget for churn inside the hysteresis band', async () => {
      const { mod, orchestrator } = makeAtTwoMinutes();
      await orchestrator.start(defaultBootContext);
      peersUp();
      await clock.tickAsync(0);

      await driveBlocks(2555000, FALLBACK_BLOCKS - 1);

      for (let i = 0; i < 6; i += 1) {
        peerEmitter.emit('peerDisconnected', `10.0.0.${i + 1}:16127`, i + 1);
        peerEmitter.emit('peerConnected', `10.0.0.${i + 20}:16127`, i + 20);
      }
      await clock.tickAsync(0);

      await driveBlocks(2555000 + FALLBACK_BLOCKS - 1, 1);
      expect(orchestrator.state, 'peer churn short of the degraded threshold reset the budget').to.equal(mod.STATES.READY);
    });

    // A node that never reaches the threshold crosses neither peer edge, so the
    // budget standing still is the only symptom it has. Said once when it starts
    // and once when it stops, in both directions: a node that repeats it every
    // block is reporting a condition that has not changed, and one that says it
    // only once has nothing to say when the condition lifts.
    it('announces a stalled readiness budget on its edges, and only there', async () => {
      const { orchestrator } = makeAtTwoMinutes();
      await orchestrator.start(defaultBootContext);
      await clock.tickAsync(0);

      const stalls = () => logStub.warn.getCalls()
        .filter((c) => /Readiness budget not advancing/.test(c.args[0])).length;
      const resumes = () => logStub.info.getCalls()
        .filter((c) => /readiness budget is advancing again/.test(c.args[0])).length;

      // Never above the threshold: no peer event has fired and none will.
      await driveBlocks(2555000, 40);
      expect(stalls(), 'the stall was not reported, or was reported per block').to.equal(1);
      expect(resumes()).to.equal(0);

      peersUp();
      await clock.tickAsync(0);
      await driveBlocks(2555040, 5);
      expect(resumes(), 'the budget resumed without saying so, or said so repeatedly').to.equal(1);
      expect(stalls(), 'the stall was re-reported while peers were up').to.equal(1);

      // And it arms again, or a node that recovers once is silent ever after.
      // Asserted from RESYNCING rather than DEGRADED: a degraded node does not
      // process blocks at all, and its own transition already says why it is
      // held. RESYNCING with the peers gone again is the state that accrues
      // nothing and announces nothing on its own.
      peerEmitter.emit('peersBelowThreshold', 2);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      peerEmitter.emit('peersBelowThreshold', 2);
      await clock.tickAsync(0);

      await driveBlocks(2555045, 5);
      expect(stalls(), 'a second stall went unreported').to.equal(2);
      expect(resumes()).to.equal(1);
    });

    // A node past the fallback was answering peers' state-sync requests, and a
    // degrade takes that back. Not a loss - the claim the fallback buys is that
    // every holder of a running-app location has had time to announce itself TO
    // THIS NODE, and a node below four peers was not hearing them. It was
    // answering on a view it no longer had.
    it('stops answering peers about app state when the peer set goes', async () => {
      const { mod, orchestrator } = makeAtTwoMinutes();
      await orchestrator.start(defaultBootContext);
      peersUp();
      await clock.tickAsync(0);

      await driveBlocks(2555000, FALLBACK_BLOCKS);
      expect(orchestrator.state).to.equal(mod.STATES.READY);
      expect(globalStateStub.appStateAuthoritative).to.equal(true);

      peerEmitter.emit('peersBelowThreshold', 2);
      await clock.tickAsync(0);

      expect(globalStateStub.appStateAuthoritative, 'a node that lost its peers still claimed a full view').to.equal(false);
    });
  });

  // ONE RECORD PER REQUEST, ONE THING THAT WRITES IT.
  //
  // "there is a request outstanding to this peer" used to be written down three
  // times - an asked-mark on the peer manager, a slot here, a declined flag on
  // the socket - by different code, cleared by different rules. Every way they
  // could disagree was a defect, and the four below are those ways.
  describe('the request record is the only account of what has been asked', () => {
    const STALL_MS = 30000;
    const SYNC_TIMEOUT_MS = 120000;

    // FluxPeerManager.add() emits peerThresholdReached and then peerConnected from
    // the same call, so the trigger that starts the sync and one that tops it
    // up land in the same tick. Choosing peers cannot be one uninterrupted step
    // - the signing key is fetched in the middle - so without the reconciler
    // holding the table both passes read an empty pool and both fill it.
    it('asks each peer once when the threshold crossing and the join it rode in on both land', async () => {
      const peers = makeEligiblePeers(6);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      peerEmitter.emit('peerConnected', peers[0].key, 99);
      await clock.tickAsync(0);

      const asked = peers.filter((p) => p.send.called);
      expect(asked.length, 'a boot asked more peers than the pool holds').to.equal(3);
      for (const peer of asked) {
        expect(peer.send.callCount, 'a peer was sent the same four requests twice').to.equal(4);
      }
      await orchestrator.stop();
    });

    // A node below its degraded threshold has judged its own gossip
    // unreliable. Asking anyway would let it complete a survey from the peers
    // it has left and publish itself authoritative on the strength of them.
    it('stops asking once it has judged its own peer set unreliable', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      blockEmitter.emit('blocksProcessed', 2555000);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      for (const peer of peers) expect(peer.send.callCount).to.equal(4);

      // Degrading throws the sync progress away, so every peer is a candidate
      // again and a pass that ran would re-ask them. Asserted on THAT rather
      // than on the joiner: the joiner sits fourth in a list of four and a pool
      // of three never reaches it, so it goes unasked either way.
      peerEmitter.emit('peersBelowThreshold', 1);
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(STATES.DEGRADED);

      const joiner = makePeer('10.0.0.9:16127');
      getEligibleSyncPeersStub.returns([...peers, joiner]);
      peerEmitter.emit('peerConnected', joiner.key, 99);
      await clock.tickAsync(0);

      for (const peer of peers) {
        expect(peer.send.callCount, 'a degraded node asked its remaining peers for state').to.equal(4);
      }
      expect(joiner.send.called, 'a degraded node asked a joining peer for state').to.equal(false);
      expect(globalStateStub.appStateAuthoritative, 'a degraded node still claimed authority').to.equal(false);
      await orchestrator.stop();
    });

    // And it starts again - a guard that stops the asking has to be shown to
    // let it resume, or it is indistinguishable from wedging the node.
    it('asks again once enough peers are back for the threshold to re-arm', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      blockEmitter.emit('blocksProcessed', 2555000);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      peerEmitter.emit('peersBelowThreshold', 1);
      await clock.tickAsync(0);

      const recovered = makeEligiblePeers(3);
      getEligibleSyncPeersStub.returns(recovered);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);

      for (const peer of recovered) {
        expect(peer.send.callCount, 'a node that recovered its peers never asked again').to.equal(4);
      }
      await orchestrator.stop();
    });

    // WHAT THE RE-ENTRANCY GUARD BUYS, beyond holding the pool cap.
    //
    // It holds the cap: a pass counts the deficit, then fetches a signing key
    // before it can reserve anything, so a second pass admitted in that window
    // counts the same deficit and fills it twice - which is why deleting the
    // guard turns the double-ask test below red, not this one.
    //
    // This is the part only it does. A boot brings peers in a burst and every
    // one of them is a trigger, and each pass that reaches the await fetches
    // this node's signing key. One arrival, one key.
    it('fetches the signing key once however many triggers arrive together', async () => {
      const peers = makeEligiblePeers(6);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      getFluxNodePublicKeyStub.resetHistory();

      peerEmitter.emit('peerThresholdReached', 12);
      for (const peer of peers) peerEmitter.emit('peerConnected', peer.key, 99);
      await clock.tickAsync(0);

      expect(getFluxNodePublicKeyStub.callCount, 'a burst of joins fetched the node key once each').to.equal(1);
      await orchestrator.stop();
    });

    // WHAT THE RE-RUN BUYS, on its own.
    //
    // The guard stops a second pass running, but it does not stop the table
    // changing underneath the one that is: a deadline firing or a peer leaving
    // while the signing key is being fetched closes a request and widens the
    // deficit the pass already counted. Those triggers mark the table dirty
    // instead of acting, and the re-run is what then asks for the shortfall
    // they left. Without it the peer that went is not replaced until something
    // else happens to trigger, which on a quiet fleet is the block timer.
    it('replaces a peer that was lost while the signing key was being fetched', async () => {
      const peers = makeEligiblePeers(3);
      const spares = [makePeer('10.0.9.1:16127'), makePeer('10.0.9.2:16127')];
      getEligibleSyncPeersStub = sinon.stub().callsFake(
        () => [...peers, ...spares].filter((p) => !removed.has(p.key)),
      );

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      for (const peer of peers) expect(peer.send.callCount).to.equal(4);

      // The second key fetch is the one for the top-up below. While it is in
      // flight a second peer goes, so the deficit when the fetch returns is two
      // and not the one it was when the pass started.
      getFluxNodePublicKeyStub.onCall(1).callsFake(async () => {
        removePeer(peers[1].key);
        return '04testpubkey1234567890';
      });

      appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_REFUSED, 'apprunning', peers[0].key);
      await clock.tickAsync(0);

      const asked = spares.filter((p) => p.send.called).length;
      expect(asked, 'a peer lost during the key fetch went unreplaced').to.equal(2);
      await orchestrator.stop();
    });

    // A PASS THAT CANNOT SIGN COSTS NOTHING. Signing is the last thing that can
    // fail before a request goes out and it answers null rather than throwing,
    // so the signatures are taken before any record opens. Opening first leaves
    // a peer marked asked with a deadline armed against a request that was
    // never sent, and the attempt spends its budget waiting that out.
    it('asks the same peers again after a pass that could not sign', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);
      signMessageStub.returns(null);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);

      for (const peer of peers) expect(peer.send.callCount, 'a request went out unsigned').to.equal(0);

      signMessageStub.returns('fakesig==');
      peerEmitter.emit('peerConnected', peers[0].key, 99);
      await clock.tickAsync(0);

      for (const peer of peers) expect(peer.send.callCount, 'a peer was left marked asked by a pass that sent nothing').to.equal(4);
      await orchestrator.stop();
    });

    // The round's budget and the per-peer deadlines used to be kept in separate
    // places: the budget cleared the asked-marks and left the deadlines armed,
    // so a peer that was streaming perfectly went quiet only because this node
    // had stopped listening - and was then recorded as having stalled.
    it('ends a round without accusing a peer that was still delivering', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);

      // One peer keeps sending right up to the budget, inside every stall window.
      for (let elapsed = 0; elapsed < SYNC_TIMEOUT_MS; elapsed += STALL_MS - 1000) {
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_PROGRESS, peers[0].key);
        // eslint-disable-next-line no-await-in-loop
        await clock.tickAsync(STALL_MS - 1000);
      }
      await clock.tickAsync(SYNC_TIMEOUT_MS);

      const accusations = logStub.warn.getCalls()
        .map((c) => String(c.args[0]))
        .filter((m) => m.includes(peers[0].key) && m.includes('stopped mid-answer'));
      expect(accusations, 'a peer delivering to the last second was blamed for stalling').to.deep.equal([]);
      // And its request is closed, so nothing arriving afterwards is taken as
      // an answer to a round that is over.
      expect(orchestrator.isSyncResponseWanted(peers[0]), 'a finished round still wanted answers').to.equal(false);
      await orchestrator.stop();
    });

    // THE BUDGET BOUNDS THE ATTEMPT, not one round of an open-ended series.
    // When it runs out the attempt is over: the block fallback is what carries
    // this node to readiness, and nobody is asked anything more. Without that,
    // "how long before it gives up" has no answer - a peer arriving an hour
    // later would open another round with its own budget.
    it('asks nobody once the budget has been spent, however many peers arrive', async () => {
      const peers = makeEligiblePeers(3);
      const untried = makePeer('10.9.9.1:16127');
      getEligibleSyncPeersStub = sinon.stub().callsFake(() => [...peers, untried]);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);

      // Nobody answers, so the deadlines take everyone and the budget runs out.
      await clock.tickAsync(SYNC_TIMEOUT_MS + 1000);
      const spent = [...peers, untried].reduce((n, p) => n + p.send.callCount, 0);

      const joiner = makePeer('10.9.9.2:16127');
      getEligibleSyncPeersStub.callsFake(() => [...peers, untried, joiner]);
      peerEmitter.emit('peerConnected', joiner.key, 99);
      await clock.tickAsync(0);

      expect(joiner.send.called, 'a peer that joined after the budget was asked').to.equal(false);
      expect([...peers, untried].reduce((n, p) => n + p.send.callCount, 0),
        'the budget ran out and it went on asking').to.equal(spent);
      await orchestrator.stop();
    });

    // And a spent budget is not a permanent one. A guard that stops the asking
    // has to be shown to let it start again, or it cannot be told from a node
    // that has wedged itself.
    it('starts a fresh attempt when the sync genuinely restarts', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      blockEmitter.emit('blocksProcessed', 2555000);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      await clock.tickAsync(SYNC_TIMEOUT_MS + 1000);
      const spent = peers.reduce((n, p) => n + p.send.callCount, 0);

      // Losing the peers and getting them back is a restart of the sync, not a
      // continuation of the attempt that ran out.
      peerEmitter.emit('peersBelowThreshold', 1);
      await clock.tickAsync(0);
      const recovered = makeEligiblePeers(3);
      getEligibleSyncPeersStub.returns(recovered);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);

      expect(recovered.reduce((n, p) => n + p.send.callCount, 0),
        'a sync that restarted never asked anyone').to.be.greaterThan(0);
      expect(spent, 'the first attempt never asked at all').to.be.greaterThan(0);
      await orchestrator.stop();
    });

    // A PEER GETS ONE TURN. Its socket dying in the middle of the attempt is
    // its answer to that attempt, and a peer that cannot hold a connection long
    // enough to reply is not one to spend a second of very few slots on. The
    // replacement arrives without a removal - the address never leaves the map
    // and the count does not move - so the connection ending is the only thing
    // that says so, and it is announced.
    it('does not ask a peer that reconnected, and wants nothing from the connection that went', async () => {
      const peers = makeEligiblePeers(3);
      const spare = makePeer('10.0.0.9:16127');
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      const oldConnection = peers[0];
      expect(orchestrator.isSyncResponseWanted(oldConnection)).to.equal(true);

      const reconnected = reconnectPeer(peers[0].key);
      getEligibleSyncPeersStub.returns([reconnected, peers[1], peers[2], spare]);
      await clock.tickAsync(0);

      expect(orchestrator.isSyncResponseWanted(oldConnection), 'a dead connection could still complete the sync').to.equal(false);
      expect(reconnected.send.called, 'a peer that dropped mid-attempt was asked again on its new connection').to.equal(false);
      expect(spare.send.callCount, 'the slot the dropped peer freed was never refilled').to.equal(4);
      await orchestrator.stop();
    });

    // A peer refuses all three types when it refuses any. Only the first of
    // those ends the request, so the log says once what happened once.
    it('records one refusal when a peer declines every stream', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);

      for (const type of ['apprunning', 'appinstalling', 'apperrors', 'apptemp']) {
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_REFUSED, type, peers[0].key);
      }
      await clock.tickAsync(0);

      const declines = logStub.info.getCalls()
        .map((c) => String(c.args[0]))
        .filter((m) => m.includes(peers[0].key) && m.includes('declined'));
      expect(declines.length, 'one peer declining once was reported three times').to.equal(1);
      await orchestrator.stop();
    });
  });

  // THE POOL IS SLOTS, AND EVERY SLOT HAS ITS OWN CLOCK.
  //
  // The design this replaced fired its requests and then waited on one deadline
  // for the whole batch, so it only ever re-examined anything when something
  // external happened to poke it - a peer joined, a peer declined. A peer that
  // simply never replied was invisible until the whole budget expired, and an
  // earlier attempt to fix that by starting a timer on the FIRST answer failed
  // on the case that matters most: if none of them answer, there is no first
  // answer and no timer.
  //
  // syncTimeoutMs is 120000 here, so the first-response deadline is 10s and the
  // stall deadline 30s.
  describe('a slot is held by one peer and has its own deadline', () => {
    const FIRST_RESPONSE_MS = 10000;
    const STALL_MS = 30000;

    const askThree = async (spares = 3) => {
      const peers = makeEligiblePeers(3);
      const extra = Array.from({ length: spares }, (_, i) => makePeer(`10.0.9.${i + 1}:16127`));
      getEligibleSyncPeersStub = sinon.stub().returns(peers);
      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      for (const peer of peers) expect(peer.send.callCount).to.equal(4);

      // The manager offers every capable peer it holds, asked or not - which is
      // what it does in production now that no record of asking lives there.
      // Whether a peer is a candidate is decided by the orchestrator's own
      // request table, so a double that pre-filtered would hide that.
      getEligibleSyncPeersStub.callsFake(() => [
        ...peers.filter((p) => !removed.has(p.key)), ...extra,
      ]);
      return { orchestrator, peers, extra };
    };

    // The case the previous design could not see at all.
    it('replaces every peer when none of them ever says anything', async () => {
      const { peers, extra } = await askThree();

      await clock.tickAsync(FIRST_RESPONSE_MS + 1);

      expect(extra.filter((p) => p.send.called).length, 'silent peers were never replaced').to.equal(3);
      for (const peer of peers) expect(peer.send.callCount, 'a silent peer was asked twice').to.equal(4);
    });

    it('keeps a peer that is still sending, past the first-response deadline', async () => {
      const { peers, extra } = await askThree();

      // One batch is enough to prove it is working. A large answer arrives over
      // many of these and only the last one is a completion.
      appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_PROGRESS, peers[0].key);
      await clock.tickAsync(FIRST_RESPONSE_MS + 1);

      expect(extra.filter((p) => p.send.called).length, 'a peer mid-answer was replaced').to.equal(2);
    });

    it('replaces a peer that starts answering and then stops', async () => {
      const { orchestrator, peers } = await askThree(12);

      appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_PROGRESS, peers[0].key);
      await clock.tickAsync(FIRST_RESPONSE_MS + 1);
      const wantedAfterFirstWindow = orchestrator.isSyncResponseWanted(peers[0]);

      await clock.tickAsync(STALL_MS + 1);

      // Asserted on this peer's own record, not on how many spares were
      // consumed: the two that never spoke are replaced by spares that also
      // never speak, so a spare count reaches any number you like without this
      // peer's stall deadline ever firing. The record is also the fact the
      // response gate reads, so this is the difference that matters.
      expect(wantedAfterFirstWindow, 'a peer mid-answer was written off at the first-response deadline').to.equal(true);
      expect(orchestrator.isSyncResponseWanted(peers[0]), 'a peer that stopped mid-answer was never replaced').to.equal(false);
    });

    it('keeps a peer alive for as long as it keeps sending', async () => {
      const { orchestrator, peers } = await askThree(12);

      appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_PROGRESS, peers[0].key);
      // Four stall windows of steady batches: total elapsed is well past any
      // whole-answer deadline, which is the point - a peer ninety percent
      // through a large transfer must not be abandoned for taking a while.
      // Asserted on the peer itself rather than on how many spares were used,
      // because the silent two are replaced by spares that also go silent.
      for (let i = 0; i < 4; i += 1) {
        await clock.tickAsync(STALL_MS - 1);
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_PROGRESS, peers[0].key);
      }
      await clock.tickAsync(1);

      expect(orchestrator.isSyncResponseWanted(peers[0]), 'a peer delivering steadily was written off').to.equal(true);
      expect(peers[0].send.callCount, 'a peer delivering steadily was asked again').to.equal(4);
    });

    // A closed socket is a fact. Waiting out a deadline for something already
    // known would spend the whole first-response window for nothing.
    it('frees a slot the moment the socket closes, without waiting for a deadline', async () => {
      const { extra } = await askThree();

      removePeer('10.0.0.1:16127');
      await clock.tickAsync(0);

      expect(extra.filter((p) => p.send.called).length, 'a closed socket did not free its slot at once').to.equal(1);
    });

    it('holds no slot for a peer that has answered in full', async () => {
      const { extra } = await askThree();

      for (const type of ['apprunning', 'appinstalling', 'apperrors', 'apptemp']) {
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, type, '10.0.0.1:16127');
      }
      await clock.tickAsync(FIRST_RESPONSE_MS + 1);

      // Its answer is in, so its deadline is gone with it - only the two that
      // never spoke are replaced, and the finished peer is not asked again.
      expect(extra.filter((p) => p.send.called).length, 'a finished peer was replaced or re-asked').to.equal(2);
    });

    it('fires no slot deadline after stop', async () => {
      const { orchestrator, extra } = await askThree();

      await orchestrator.stop();
      await clock.tickAsync(STALL_MS * 2);

      expect(extra.some((p) => p.send.called), 'a stopped orchestrator went on asking peers').to.equal(false);
    });
  });

  describe('state sync readiness', () => {
    it('should reach READY when all sync types complete from 3 peers', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
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

      const orchestrator = makeOrchestrator();
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

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peersUp();

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);

      // After sync but before enough blocks, should still be SYNCING
      expect(orchestrator.state).to.equal(STATES.SYNCING);

      // Past the fallback's 250 blocks, so it reaches READY on the timer
      for (let i = 0; i < 260; i += 1) {
        blockEmitter.emit('blocksProcessed', 2555000 + i);
      }
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(STATES.READY);
    });

    it('should reset sync completions on degradation', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);

      const orchestrator = makeOrchestrator();
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

  describe('reconnect-triggered durable sync (mechanism B)', () => {
    // formal/record-convergence: a re-established peer is the one observable
    // trigger that a RUNNING node may have missed one-shot broadcasts.
    const RECONNECT_SLACK_MS = 120000;

    async function reachReady() {
      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      for (let i = 0; i < 3; i += 1) {
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apprunning');
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'appinstalling');
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apperrors');
      }
      await clock.tickAsync(0);
    }

    it('a re-established peer gets one scoped apprunning pull from its loss time', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);
      const markStub = sinon.stub();
      const orchestrator = makeOrchestrator({ isEnterprise: () => true, markSyncRequested: markStub });
      orchestrator.start(defaultBootContext);
      await reachReady();
      expect(orchestrator.state).to.equal(STATES.READY);

      const bootSends = peers[0].send.callCount;
      const otherSends = peers[1].send.callCount;
      markStub.resetHistory();
      // a positive clock baseline, or the slack subtraction floors at zero
      await clock.tickAsync(300000);
      const lostAtMs = Date.now() - 60000;
      peerEmitter.emit('peerReestablished', { key: peers[0].key, lostAtMs });
      await clock.tickAsync(0);

      expect(peers[0].send.callCount, 'one pull to the returned peer').to.equal(bootSends + 1);
      expect(peers[1].send.callCount, 'nobody else asked').to.equal(otherSends);
      expect(markStub.calledWith(peers[0].key), 'response gate opened for the peer').to.equal(true);
      const expectedSince = lostAtMs - RECONNECT_SLACK_MS;
      expect(buildSyncSigStub.calledWith(0x21, expectedSince), 'the signed ask names the scoped since').to.equal(true);
      expect(encodeAppRunningStub.calledWith(expectedSince), 'the frame carries the scoped since').to.equal(true);
    });

    it('a pull whose socket dies unanswered hands its loss back: the next re-establishment pulls from the original gap', async () => {
      // A peer at its inbound cap closes every accept within a second, and
      // each accept is a re-establishment: the credit spent on the refused
      // socket is not lost, and its since does not walk forward to the
      // refused socket's connect time.
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);
      const orchestrator = makeOrchestrator({ isEnterprise: () => true, markSyncRequested: sinon.stub() });
      orchestrator.start(defaultBootContext);
      await reachReady();
      await clock.tickAsync(300000);
      const bootSends = peers[0].send.callCount;
      const firstLoss = Date.now() - 60000;
      peerEmitter.emit('peerReestablished', { key: peers[0].key, lostAtMs: firstLoss });
      await clock.tickAsync(0);
      expect(peers[0].send.callCount, 'the pull went out on the first return').to.equal(bootSends + 1);

      peerEmitter.emit('syncPeerLost', { key: peers[0].key, connectionId: peers[0].connectionId }); // the far end refused the socket
      await clock.tickAsync(1000);
      const laterLoss = Date.now() - 500;
      peerEmitter.emit('peerReestablished', { key: peers[0].key, lostAtMs: laterLoss });
      await clock.tickAsync(0);
      expect(peers[0].send.callCount, 'the pull fires again on the next return').to.equal(bootSends + 2);
      expect(encodeAppRunningStub.lastCall.args[0], 'from the original gap, not the refused socket\'s connect time')
        .to.equal(firstLoss - RECONNECT_SLACK_MS);
    });

    it('a pull that was answered hands nothing back: a later loss starts its own gap', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);
      const orchestrator = makeOrchestrator({ isEnterprise: () => true, markSyncRequested: sinon.stub() });
      orchestrator.start(defaultBootContext);
      await reachReady();
      await clock.tickAsync(300000);
      const firstLoss = Date.now() - 60000;
      peerEmitter.emit('peerReestablished', { key: peers[0].key, lostAtMs: firstLoss });
      await clock.tickAsync(0);
      appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apprunning', peers[0].key);
      await clock.tickAsync(0);

      peerEmitter.emit('syncPeerLost', { key: peers[0].key, connectionId: peers[0].connectionId });
      await clock.tickAsync(1000);
      const laterLoss = Date.now() - 500;
      peerEmitter.emit('peerReestablished', { key: peers[0].key, lostAtMs: laterLoss });
      await clock.tickAsync(0);
      expect(encodeAppRunningStub.lastCall.args[0], 'the answered pull\'s gap is closed')
        .to.equal(laterLoss - RECONNECT_SLACK_MS);
    });

    it('a scoped pull completing is announced on appSyncEvents, so a returning node can run its placement check after it; a round completion is not', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);
      const orchestrator = makeOrchestrator({ isEnterprise: () => true, markSyncRequested: sinon.stub() });
      orchestrator.start(defaultBootContext);
      await reachReady();
      await clock.tickAsync(300000);
      peerEmitter.emit('peerReestablished', { key: peers[0].key, lostAtMs: Date.now() - 60000 });
      await clock.tickAsync(0);

      const heard = [];
      const listener = (key) => heard.push(key);
      appSyncEvents.on(EVENTS.RECONNECT_SYNC_COMPLETE, listener);
      try {
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apprunning', peers[1].key); // not a pull
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apprunning', peers[0].key); // the pull
        await clock.tickAsync(0);
        expect(heard).to.deep.equal([peers[0].key]);
      } finally {
        appSyncEvents.off(EVENTS.RECONNECT_SYNC_COMPLETE, listener);
      }
    });

    it('pulls in any state - a degraded-window node is the one that needs it most', async () => {
      // 1216 run five: the pocket sat outside READY through the whole heal
      // window (its resync round burned against its own side during the cut)
      // and a READY-gated pull never fired on the nodes missing the records.
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);
      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);
      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(STATES.SYNCING);

      peerEmitter.emit('peerReestablished', { key: peers[0].key, lostAtMs: Date.now() - 60000 });
      await clock.tickAsync(0);
      expect(peers[0].send.callCount, 'the scoped pull fires outside READY too').to.equal(1);
    });

    it('a peer the active round is already asking is not double-asked', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);
      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);
      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      const roundSends = peers[0].send.callCount;
      expect(roundSends, 'the round asked this peer').to.be.greaterThan(0);

      peerEmitter.emit('peerReestablished', { key: peers[0].key, lostAtMs: Date.now() - 60000 });
      await clock.tickAsync(0);
      expect(peers[0].send.callCount, 'the round already covers it at since=0').to.equal(roundSends);
    });

    it('a scoped pull completion never counts toward the round', async () => {
      const peers = makeEligiblePeers(4);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);
      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);
      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);

      // The 4th peer is outside the round; reconnect-pull it.
      peerEmitter.emit('peerReestablished', { key: peers[3].key, lostAtMs: Date.now() - 60000 });
      await clock.tickAsync(0);
      expect(peers[3].send.callCount).to.equal(1);

      // Its scoped answer completes, plus two round completions per type:
      // apprunning must still read 2 of 3 - the scoped pull is not a full sync.
      appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apprunning', peers[3].key);
      for (let i = 0; i < 2; i += 1) {
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apprunning');
      }
      for (let i = 0; i < 3; i += 1) {
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'appinstalling');
        appSyncEvents.emit(EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apperrors');
      }
      await clock.tickAsync(0);
      expect(orchestrator.state, 'a scoped answer must not stand in for a full one').to.equal(STATES.SYNCING);
    });

    it('pulls a peer that is connected but not yet a sync CANDIDATE - a fresh inbound accept has no reported uptime', async () => {
      // The second gate red: inbound re-establishments carry no uptime at
      // add() time, so an eligibility-filtered lookup missed the very peer
      // the event named - outbound redials pulled, inbound accepts never did.
      const peers = makeEligiblePeers(3);
      const freshInbound = makePeer('10.0.0.99:16127');
      getEligibleSyncPeersStub = sinon.stub().returns(peers);
      const orchestrator = makeOrchestrator({
        isEnterprise: () => true,
        getPeerByKey: (key) => (key === freshInbound.key ? freshInbound : null),
      });
      orchestrator.start(defaultBootContext);
      await reachReady();
      expect(orchestrator.state).to.equal(STATES.READY);

      peerEmitter.emit('peerReestablished', { key: freshInbound.key, lostAtMs: Date.now() - 60000 });
      await clock.tickAsync(0);
      expect(freshInbound.send.callCount, 'addressed by key, never filtered by candidacy').to.equal(1);
    });

    it('a pull blocked by lost message capability fires when capability returns, with the original since', async () => {
      // The third gate red: the heal\'s reconnection wave lands while the
      // healed side\'s chain view is still stale (capability lost), and a
      // one-shot event dropped there is a credit destroyed. The credit is
      // durable: stash and drain on capability-gained.
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);
      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);
      await reachReady();
      await clock.tickAsync(300000);

      orchestrator.onMessageCapabilityChange(false);
      const bootSends = peers[0].send.callCount;
      const lostAtMs = Date.now() - 60000;
      peerEmitter.emit('peerReestablished', { key: peers[0].key, lostAtMs });
      await clock.tickAsync(0);
      expect(peers[0].send.callCount, 'nothing sent while incapable').to.equal(bootSends);

      orchestrator.onMessageCapabilityChange(true);
      await clock.tickAsync(0);
      expect(peers[0].send.callCount, 'the stashed pull fires on capability return').to.equal(bootSends + 1);
      const expectedSince = lostAtMs - RECONNECT_SLACK_MS;
      expect(encodeAppRunningStub.calledWith(expectedSince), 'the original since survives the stash').to.equal(true);
    });

    it('repeated losses keep the EARLIEST since - the oldest unhealed gap bounds the miss', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);
      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);
      await reachReady();
      await clock.tickAsync(300000);

      orchestrator.onMessageCapabilityChange(false);
      const earlyLostAt = Date.now() - 90000;
      peerEmitter.emit('peerReestablished', { key: peers[0].key, lostAtMs: earlyLostAt });
      peerEmitter.emit('peerReestablished', { key: peers[0].key, lostAtMs: Date.now() - 10000 });
      await clock.tickAsync(0);

      orchestrator.onMessageCapabilityChange(true);
      await clock.tickAsync(0);
      expect(encodeAppRunningStub.calledWith(earlyLostAt - RECONNECT_SLACK_MS), 'earliest gap wins').to.equal(true);
    });

    it('a peer no longer connected is quietly skipped', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub = sinon.stub().returns(peers);
      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);
      await reachReady();
      expect(orchestrator.state).to.equal(STATES.READY);

      const sends = peers.map((p) => p.send.callCount);
      peerEmitter.emit('peerReestablished', { key: '10.9.9.9:16127', lostAtMs: Date.now() - 60000 });
      await clock.tickAsync(0);
      peers.forEach((p, i) => expect(p.send.callCount).to.equal(sends[i]));
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

    // The step means "my content register is caught up", so a round that identified work
    // and did none of it has not finished it. Latching there strands the node: the
    // per-block retry skips a step already marked complete, leaving only the steady-state
    // refresh a hundred blocks out, and meanwhile the node is live and serving content it
    // already knows has been superseded.
    it('stays gated when the round fetched less than the gap it found', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub.returns(peers);
      reconcileStub.resolves({
        peers: 3, indexesReceived: 1, requested: 1, fetched: 0,
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

    it('latches once a later round closes the gap', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub.returns(peers);
      reconcileStub.resolves({
        peers: 3, indexesReceived: 1, requested: 2, fetched: 0,
      });

      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);
      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      completeEphemeral();
      await clock.tickAsync(0);
      expect(orchestrator.state, 'held while the gap is open').to.equal(STATES.SYNCING);

      // The peers come good. The retry that carries the node out of this state runs only
      // for a step that never latched, which is what the assertion above protects.
      reconcileStub.resolves({
        peers: 3, indexesReceived: 1, requested: 2, fetched: 2,
      });
      blockEmitter.emit('blocksProcessed', 2555001);
      await clock.tickAsync(0);

      expect(orchestrator.state).to.equal(STATES.READY);
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

    it('retries an unlatched round on the next block, with no edge left to wait for', async () => {
      const peers = makeEligiblePeers(3);
      getEligibleSyncPeersStub.returns(peers);
      // A round that reaches peers and gets no index back: it consumed its wake-up
      // without changing anything, so nothing is coming to retry it.
      reconcileStub.resolves({ peers: 3, indexesReceived: 0, fetched: 0 });

      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);
      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      peerEmitter.emit('peerThresholdReached', 12);
      await clock.tickAsync(0);
      completeEphemeral();
      await clock.tickAsync(0);
      expect(orchestrator.state, 'still short of READY').to.equal(STATES.SYNCING);

      // The peer set never changes again — only the chain moves.
      reconcileStub.resetHistory();
      reconcileStub.resolves({ peers: 3, indexesReceived: 3, fetched: 1 });
      blockEmitter.emit('blocksProcessed', 2555001);
      await clock.tickAsync(0);
      await clock.tickAsync(0);

      expect(reconcileStub.called, 'the block re-drove the unlatched round').to.equal(true);
      expect(orchestrator.state).to.equal(STATES.READY);
    });

    it('resumes a recovery reconcile once peers become askable, after the threshold edge is spent', async () => {
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
      expect(orchestrator.state).to.equal(STATES.READY);

      // Full isolation, then heal. This is the case the peer-threshold edge cannot
      // cover: the peers are BACK and counted, so the edge fires and is spent, but
      // none of them is askable yet - a reconnected peer has not reported its uptime,
      // and pingAll takes every peer out of candidacy at once until its pong lands.
      peerEmitter.emit('peersBelowThreshold', 0);
      expect(orchestrator.state).to.equal(STATES.DEGRADED);
      reconcileStub.resetHistory();
      getEligibleSyncPeersStub.returns([]);

      peerEmitter.emit('peerThresholdReached', 8);
      await clock.tickAsync(0);
      completeEphemeral();
      await clock.tickAsync(0);

      // The round asked nobody, so it correctly did not latch - and the only edge
      // that would have retried it has now been consumed.
      expect(orchestrator.state).to.equal(STATES.RESYNCING);
      const roundsBefore = reconcileStub.callCount;

      // The peers become askable. That is the level the vacuous round was waiting
      // on, and it is what resumes the work.
      getEligibleSyncPeersStub.returns(peers);
      peerEmitter.emit('syncPeersAvailable');
      await clock.tickAsync(0);
      completeEphemeral();
      await clock.tickAsync(0);

      expect(reconcileStub.callCount, 'reconcile re-driven by availability').to.be.greaterThan(roundsBefore);
      expect(orchestrator.state).to.equal(STATES.READY);
    });

    it('ignores the availability edge once the permanent-plane steps have latched', async () => {
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
      expect(orchestrator.state).to.equal(STATES.READY);

      // Candidacy churns with every ping cycle, so this edge repeats in steady
      // state. A converged node must not re-run a round for it.
      reconcileStub.resetHistory();
      peerEmitter.emit('syncPeersAvailable');
      await clock.tickAsync(0);

      expect(reconcileStub.called, 'no redundant reconcile once latched').to.be.false;
    });

    it('stops listening for the availability edge after stop()', async () => {
      getEligibleSyncPeersStub.returns([]);
      const orchestrator = makeOrchestrator({ isEnterprise: () => true });
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      expect(orchestrator.state).to.equal(STATES.SYNCING);

      // Prove the edge drives work BEFORE stopping, so this cannot pass merely
      // because nothing was ever listening. History is cleared first so the boot
      // round's own (peerless) reconcile cannot stand in for the edge's effect.
      reconcileStub.resetHistory();
      getEligibleSyncPeersStub.returns(makeEligiblePeers(3));
      peerEmitter.emit('syncPeersAvailable');
      await clock.tickAsync(0);
      expect(reconcileStub.called, 'edge drives work while running').to.be.true;

      await orchestrator.stop();
      reconcileStub.resetHistory();

      peerEmitter.emit('syncPeersAvailable');
      await clock.tickAsync(0);

      expect(reconcileStub.called, 'no work driven after stop').to.be.false;
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

    it('samples refresh peers with its own token uptime floor, not the boot anti-flap gate', async () => {
      // The node that most needs the backstop (just healed from a partition) has
      // the freshest connections: the boot sync's ~2h uptime gate would blind the
      // refresh to every peer for hours after a heal. The refresh consults its own
      // floor (manifestRefreshMinPeerUptime, default 30s).
      const catchUp = sinon.stub().resolves();
      await toReady(catchUp);
      getEligibleSyncPeersStub.resetHistory();

      blockEmitter.emit('blocksProcessed', 2555200);
      await clock.tickAsync(0);
      sinon.assert.calledWith(getEligibleSyncPeersStub, 30);
      sinon.assert.neverCalledWith(getEligibleSyncPeersStub, 7500);
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
      peerEmitter.emit('syncPeerLost', { key: peers[0].key, connectionId: peers[0].connectionId });
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
      peerEmitter.emit('syncPeerLost', { key: peers[0].key, connectionId: peers[0].connectionId });
      await clock.tickAsync(0);

      expect(peers[3].send.called).to.be.false;
    });

    it('should never re-ask a peer that already failed, even when it reconnects', async () => {
      const peers = makeEligiblePeers(5);
      await startWithAskedPeers(peers);

      peerEmitter.emit('syncPeerLost', { key: peers[0].key, connectionId: peers[0].connectionId });
      await clock.tickAsync(0);
      expect(peers[3].send.callCount).to.equal(3); // replacement asked all 3 types (none delivered)

      // The lost peer reconnects and is eligible again; its replacement dies too
      peerEmitter.emit('syncPeerLost', { key: peers[3].key, connectionId: peers[3].connectionId });
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

      // By CONNECTION, not by address: the ledger and the arriving-response gate
      // both key on it, so a reconnected peer's answer cannot close a request
      // made on the socket before it.
      sinon.assert.calledWith(completeSyncRequestStub, peers[2].connectionId);
      expect(peers[3].send.callCount).to.equal(3); // replacement asked all 3 still-short types
      expect(logStub.warn.args.some((args) => String(args[0]).includes('missed the 120s deadline'))).to.be.true;
    });

    it('should retry the replacement on a later block when no fresh peer existed at failure time', async () => {
      const peers = makeEligiblePeers(3);
      await startWithAskedPeers(peers);

      peerEmitter.emit('syncPeerLost', { key: peers[0].key, connectionId: peers[0].connectionId });
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
        peerEmitter.emit('syncPeerLost', { key: peers[idx].key, connectionId: peers[idx].connectionId });
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

      peerEmitter.emit('syncPeerLost', { key: peers[1].key, connectionId: peers[1].connectionId });
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

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peersUp();


      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);

      // All 3 retries happen via timers — we can't wait for real timers in tests
      // But we can verify the block timer fallback works
      expect(orchestrator.state).to.equal(STATES.SYNCING);

      // Past the fallback's 250 blocks, so the block timer fires
      for (let i = 0; i < 260; i += 1) {
        blockEmitter.emit('blocksProcessed', 2555001 + i);
      }
      await clock.tickAsync(0);

      expect(orchestrator.state).to.equal(STATES.READY);
    });

    it('should reach READY via block timer when hash sync never completes', async () => {
      syncMissingHashesStub.rejects(new Error('failed'));

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peersUp();


      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);

      // Past the fallback's 250 blocks
      for (let i = 1; i <= 260; i += 1) {
        blockEmitter.emit('blocksProcessed', 2555000 + i);
      }
      await clock.tickAsync(0);

      // Block timer should have triggered DB rebuild and readiness
      expect(orchestrator.state).to.equal(STATES.READY);
      expect(reindexStub.called).to.be.true;
    });

    it('should not get stuck when DB rebuild fails', async () => {
      reindexStub.rejects(new Error('reindex failed'));

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peersUp();

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);

      // Hash sync succeeded but DB rebuild failed
      expect(syncMissingHashesStub.calledOnce).to.be.true;

      // Block timer should still allow readiness (will retry DB rebuild)
      for (let i = 1; i <= 260; i += 1) {
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

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peersUp();

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);

      for (let i = 1; i <= 260; i += 1) {
        blockEmitter.emit('blocksProcessed', 2555000 + i);
      }
      await clock.tickAsync(0);

      expect(orchestrator.state).to.equal(STATES.READY);
      expect(globalStateStub.dbReady).to.be.true;
    });

    it('should set dbReady when too few sync peers and block timer fires', async () => {
      getEligibleSyncPeersStub = sinon.stub().returns([]);

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peersUp();

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);

      for (let i = 1; i <= 260; i += 1) {
        blockEmitter.emit('blocksProcessed', 2555000 + i);
      }
      await clock.tickAsync(0);

      expect(orchestrator.state).to.equal(STATES.READY);
      expect(globalStateStub.dbReady).to.be.true;
    });

    it('should leave dbReady false when rebuildDb throws on fallback path', async () => {
      syncMissingHashesStub.rejects(new Error('failed'));
      reindexStub.rejects(new Error('reindex failed'));

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peersUp();

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);

      for (let i = 1; i <= 260; i += 1) {
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
      nodeStartupRepositoryStub.getHashSyncVersionMarker.resolves(null);

      const orchestrator = makeOrchestrator({ fluxVersion: '8.12.0' });
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);

      expect(resetHashSyncForUpgradeStub.calledOnce).to.be.true;
      expect(resetHashSyncForUpgradeStub.firstCall.args[0]).to.equal(2555000);
      expect(logStub.info.calledWith(sinon.match(/Version upgrade to 8\.12\.0/))).to.be.true;
    });

    it('should skip reset when version matches marker', async () => {
      nodeStartupRepositoryStub.getHashSyncVersionMarker.resolves({ _id: 'hashSyncVersion', version: '8.12.0' });

      const orchestrator = makeOrchestrator({ fluxVersion: '8.12.0' });
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);

      expect(resetHashSyncForUpgradeStub.called).to.be.false;
    });

    it('should write version marker after hash sync completes', async () => {
      nodeStartupRepositoryStub.getHashSyncVersionMarker.resolves(null);

      const orchestrator = makeOrchestrator({ fluxVersion: '8.12.0' });
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);

      sinon.assert.calledWith(nodeStartupRepositoryStub.setHashSyncVersionMarker, '8.12.0');
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
    it('should remove all listeners and clear intervals', async () => {
      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      await orchestrator.stop();
      expect(blockEmitter.listenerCount('blocksProcessed')).to.equal(0);
      expect(blockEmitter.listenerCount('hashesChanged')).to.equal(0);
      expect(peerEmitter.listenerCount('peerThresholdReached')).to.equal(0);
      expect(peerEmitter.listenerCount('peersBelowThreshold')).to.equal(0);
      expect(peerEmitter.listenerCount('peerConnected')).to.equal(0);
    });

    it('should clear heartbeat interval on stop', async () => {
      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      await orchestrator.stop();
      // No error thrown, interval cleaned up
    });
  });

  describe('readBootContext', () => {
    it('should detect machine reboot when boot_id differs', async () => {
      nodeStartupRepositoryStub.getHeartbeat.resolves({
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
      nodeStartupRepositoryStub.getHeartbeat.resolves({
        lastAlive: Date.now() - 5000,
        machineBootId: 'test-boot-id-12345',
        shutdownReason: 'sigterm',
      });

      const ctx = await AppSyncOrchestrator.readBootContext();

      expect(ctx.machineRebooted).to.be.false;
      expect(ctx.cleanShutdown).to.be.true;
    });

    it('should detect first boot when no heartbeat exists', async () => {
      nodeStartupRepositoryStub.getHeartbeat.resolves(null);

      const ctx = await AppSyncOrchestrator.readBootContext();

      expect(ctx.firstBoot).to.be.true;
      expect(ctx.machineRebooted).to.be.true;
      expect(ctx.downtimeMs).to.equal(Infinity);
    });

    it('should detect unclean shutdown when shutdownReason is absent', async () => {
      nodeStartupRepositoryStub.getHeartbeat.resolves({
        lastAlive: Date.now() - 120000,
        machineBootId: 'old-boot-id',
      });

      const ctx = await AppSyncOrchestrator.readBootContext();

      expect(ctx.cleanShutdown).to.be.false;
      expect(ctx.machineRebooted).to.be.true;
    });

    it('should compute downtime from lastAlive', async () => {
      const fiveMinAgo = Date.now() - 300000;
      nodeStartupRepositoryStub.getHeartbeat.resolves({
        lastAlive: fiveMinAgo,
        machineBootId: 'old-boot-id',
      });

      const ctx = await AppSyncOrchestrator.readBootContext();

      expect(ctx.downtimeMs).to.be.within(299000, 301000);
    });

    it('should return safe defaults on error', async () => {
      nodeStartupRepositoryStub.getHeartbeat.rejects(new Error('DB down'));

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

      sinon.assert.calledWith(nodeStartupRepositoryStub.setShutdownReason, 'sigterm');
    });

    it('should not throw on error', async () => {
      nodeStartupRepositoryStub.setShutdownReason.rejects(new Error('DB down'));
      await AppSyncOrchestrator.writeShutdownReason('sigterm');
      expect(logStub.error.calledWithMatch(/Failed to write shutdown reason/)).to.be.true;
    });
  });

  describe('heartbeat', () => {
    it('should write heartbeat immediately on start', async () => {
      const orchestrator = makeOrchestrator();
      await orchestrator.start(defaultBootContext);

      sinon.assert.called(nodeStartupRepositoryStub.writeHeartbeat);
      const beat = nodeStartupRepositoryStub.writeHeartbeat.firstCall.args[0];
      expect(beat.lastAlive).to.be.a('number');
      expect(beat.machineBootId).to.equal('test-boot-id-12345');
      await orchestrator.stop();
    });

    it('should store boot context and expose via getter', async () => {
      const orchestrator = makeOrchestrator();
      await orchestrator.start(defaultBootContext);

      expect(orchestrator.bootContext).to.deep.equal(defaultBootContext);
      await orchestrator.stop();
    });
  });

  describe('message capability changes', () => {
    function makeUncapableOrchestrator(overrides = {}) {
      return new AppSyncOrchestrator({ blockEmitter, ...makePeerOptions(), ...overrides });
    }

    it('should not reach READY without message capability', async () => {
      const orchestrator = makeUncapableOrchestrator();
      orchestrator.start(defaultBootContext);
      peersUp();

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      for (let i = 0; i < 260; i += 1) {
        blockEmitter.emit('blocksProcessed', 2555000 + i);
      }
      await clock.tickAsync(0);

      expect(orchestrator.state).to.equal(STATES.SYNCING);
    });

    it('should reach READY when capability gained after other conditions met', async () => {
      const orchestrator = makeUncapableOrchestrator();
      orchestrator.start(defaultBootContext);
      peersUp();

      // Explorer syncs but hash sync deferred (no capability)
      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      for (let i = 0; i < 260; i += 1) {
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

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peersUp();

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      for (let i = 0; i < 260; i += 1) {
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

      const orchestrator = makeOrchestrator();
      orchestrator.start(defaultBootContext);
      peersUp();


      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      for (let i = 0; i < 260; i += 1) {
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
      const orchestrator = makeUncapableOrchestrator();
      orchestrator.start(defaultBootContext);
      orchestrator.onMessageCapabilityChange(false);
      orchestrator.onMessageCapabilityChange(false);

      expect(logStub.info.calledWith('AppSyncOrchestrator - Message capability lost')).to.be.false;
    });

    it('should not produce log spam from block events when not confirmed', async () => {
      const orchestrator = makeUncapableOrchestrator();
      orchestrator.start(defaultBootContext);

      blockEmitter.emit('blocksProcessed', 2555000);
      await clock.tickAsync(0);
      for (let i = 0; i < 260; i += 1) {
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
