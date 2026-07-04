const fs = require('fs').promises;
const config = require('config');
const log = require('../../lib/log');
const dbHelper = require('../dbHelper');
const appHashSyncService = require('./appHashSyncService');
const contentManifestSyncService = require('./contentManifestSyncService');
const peerNotification = require('./peerNotification');
const registryManager = require('../appDatabase/registryManager');
const globalState = require('../utils/globalState');
const peerCodec = require('../utils/peerCodec');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const verificationHelper = require('../verificationHelper');
const { appSyncEvents, EVENTS } = require('../utils/appSyncEvents');
const fluxEventBus = require('../utils/fluxEventBus');

const startupCollection = config.database.local.collections.nodeStartupTracker;

const STATES = Object.freeze({
  INITIALIZING: 'INITIALIZING',
  SYNCING: 'SYNCING',
  READY: 'READY',
  DEGRADED: 'DEGRADED',
  RESYNCING: 'RESYNCING',
});

const MIN_SYNC_COMPLETIONS = config.fluxapps.appSyncMinCompletions ?? 3;
// Per-peer deadline: each asked peer gets this long, from the moment it is
// asked, to deliver all sync types before it is failed and replaced.
const SYNC_TIMEOUT_MS = config.fluxapps.syncTimeoutMs ?? 120000;
// Total distinct peers a sync round may ask (initial batch + replacements).
// Bounds the worst case to (1 + MAX - MIN) sequential deadlines before the
// block timer remains the only path to readiness.
const MAX_SYNC_PEERS = config.fluxapps.appSyncMaxPeers ?? 5;
const MIN_UPTIME_SECONDS = config.fluxapps.appSyncMinPeerUptime ?? 7500;
const HASH_SYNC_MAX_RETRIES = config.fluxapps.hashSyncMaxRetries ?? 3;
const HASH_SYNC_RETRY_MS = config.fluxapps.hashSyncRetryMs ?? 300000;
const FALLBACK_RECHECK_BLOCKS = config.fluxapps.hashSyncFallbackRecheckBlocks ?? 100;

// The counted ephemeral sync types — each gates boot readiness. Temp messages are
// requested with the initial batch but are best-effort and never counted toward it. The
// content manifest is NOT here: it is permanent data reconciled on its own plane (a
// two-step in-band exchange via contentManifestSyncService) and gated by
// #manifestSyncComplete, parallel to the permanent-message hash sync.
const SYNC_TYPES = Object.freeze(['apprunning', 'appinstalling', 'apperrors']);

class AppSyncOrchestrator {
  #state = STATES.INITIALIZING;
  #blockEmitter = null;
  #getEligibleSyncPeers = null;
  #onPeerEvent = null;
  #offPeerEvent = null;
  #markSyncRequested = null;
  #clearSyncRequested = null;
  #completeSyncRequest = null;
  #isEnterprise = null;
  #waitForNetworkState = null;
  #networkReady = false;
  #peersReady = false;
  #explorerSynced = false;
  #hashSyncComplete = false;
  #dbRebuilt = false;
  #blocksSinceSyncStarted = 0;
  #blockThreshold = 0;
  #blockReceivedHandler = null;
  #peerThresholdHandler = null;
  #peersBelowHandler = null;
  #ephemeralSyncHandler = null;
  #hashUnresolvedHandler = null;
  #hashesChangedHandler = null;
  #broadcastStarted = null;
  #started = false;
  #syncInProgress = false;
  #askedPeers = new Set();
  // Per asked peer: { askedAt, done: Set<syncType>, failed }. A failed peer
  // (disconnected or past its deadline) keeps its delivered types counted in
  // #syncCompletions; only what it never delivered is re-asked elsewhere.
  #peerProgress = new Map();
  #syncCompletions = {
    apprunning: 0, appinstalling: 0, apperrors: 0,
  };
  #manifestSyncComplete = false;
  #stateSyncComplete = false;
  #syncRoundAbandoned = false;
  #syncPeerLostHandler = null;
  #hashSyncAttempts = 0;
  #hashSyncRetryTimer = null;
  #nextHashRetryHeight = 0;
  #lastBlockHeight = 0;
  #fluxVersion = null;
  #heartbeatInterval = null;
  #bootContext = null;
  #canSendMessages = false;
  #peerCountIfAboveThreshold = () => 0;

  constructor(options = {}) {
    this.#blockEmitter = options.blockEmitter;
    this.#getEligibleSyncPeers = options.getEligibleSyncPeers;
    this.#onPeerEvent = options.onPeerEvent;
    this.#offPeerEvent = options.offPeerEvent;
    this.#markSyncRequested = options.markSyncRequested ?? (() => {});
    this.#clearSyncRequested = options.clearSyncRequested ?? (() => {});
    this.#completeSyncRequest = options.completeSyncRequest ?? (() => {});
    this.#isEnterprise = options.isEnterprise ?? (() => false);
    this.#peerCountIfAboveThreshold = options.peerCountIfAboveThreshold ?? (() => 0);
    this.#waitForNetworkState = options.networkStateReady ?? null;
    this.#fluxVersion = options.fluxVersion ?? null;
  }

  get state() {
    return this.#state;
  }

  #setState(newState) {
    const prevState = this.#state;
    if (prevState === newState) return;
    this.#state = newState;
    fluxEventBus.publish('orchestrator:stateChanged', { from: prevState, to: newState });
    if (prevState === STATES.READY && newState !== STATES.READY) {
      appSyncEvents.emit(EVENTS.READINESS_LOST);
    }
    if (newState === STATES.READY && prevState !== STATES.READY) {
      appSyncEvents.emit(EVENTS.SPAWNER_READY);
    }
  }

  async start(bootContext) {
    if (this.#started) return;
    this.#started = true;
    log.info(`AppSyncOrchestrator - Starting in state ${this.#state}`);

    this.#bootContext = bootContext;
    this.#startHeartbeat();

    this.#peerThresholdHandler = (count) => {
      log.info(`AppSyncOrchestrator - Peer threshold reached (${count} peers)`);
      this.#peersReady = true;
      this.#tryStartSync();
    };
    this.#peersBelowHandler = (count) => {
      log.info(`AppSyncOrchestrator - Peers below threshold (${count} peers)`);
      this.#onPeersDegraded();
    };
    this.#syncPeerLostHandler = (key) => this.#onSyncPeerLost(key);
    this.#onPeerEvent('peerThresholdReached', this.#peerThresholdHandler);
    this.#onPeerEvent('peersBelowThreshold', this.#peersBelowHandler);
    this.#onPeerEvent('syncPeerLost', this.#syncPeerLostHandler);

    // peerThresholdReached is edge-triggered and latched in FluxPeerManager:
    // if peers connected fast enough that the threshold was crossed BEFORE the
    // subscriptions above (e.g. inbound reconnects racing a restart), the edge
    // has already fired and never re-fires, which would leave #peersReady
    // false and stall ephemeral state sync until the block timer. Read the
    // level after subscribing to the edge.
    const peersAlready = this.#peerCountIfAboveThreshold();
    if (peersAlready && !this.#peersReady) {
      this.#peerThresholdHandler(peersAlready);
    }

    this.#ephemeralSyncHandler = (syncType, peerKey) => this.#onEphemeralSyncComplete(syncType, peerKey);
    appSyncEvents.on(EVENTS.EPHEMERAL_SYNC_COMPLETE, this.#ephemeralSyncHandler);

    this.#hashUnresolvedHandler = () => this.#onHashUnresolved();
    appSyncEvents.on(EVENTS.HASH_UNRESOLVED, this.#hashUnresolvedHandler);

    this.#blockReceivedHandler = (blockHeight) => {
      this.#onBlocksProcessed(blockHeight);
    };
    this.#blockEmitter.on('blocksProcessed', this.#blockReceivedHandler);

    this.#hashesChangedHandler = () => this.#onHashesChanged();
    this.#blockEmitter.on('hashesChanged', this.#hashesChangedHandler);

    fluxEventBus.publish('orchestrator:started', { state: this.#state, bootContext });

    if (this.#waitForNetworkState) {
      await this.#waitForNetworkState();
      this.#networkReady = true;
      log.info('AppSyncOrchestrator - Network state ready');
    } else {
      this.#networkReady = true;
    }
    // #peersReady may already be true here (live edge during the network-state
    // wait, or the latched-level check above), so always attempt the start.
    this.#tryStartSync();
  }

  #tryStartSync() {
    if (!this.#networkReady || !this.#peersReady) return;
    this.#onPeersReady();
  }

  #onEphemeralSyncComplete(syncType, peerKey) {
    if (this.#stateSyncComplete) return;
    if (this.#syncCompletions[syncType] === undefined) return;
    const progress = this.#peerProgress.get(peerKey);
    if (progress && !progress.failed) progress.done.add(syncType);
    this.#syncCompletions[syncType] += 1;
    log.info(`AppSyncOrchestrator - ${syncType} sync complete (${this.#syncCompletions[syncType]}/${MIN_SYNC_COMPLETIONS})`);
    fluxEventBus.publish('ephemeralSync:peerComplete', {
      syncType,
      completions: this.#syncCompletions[syncType],
      required: MIN_SYNC_COMPLETIONS,
    });
    if (this.#syncCompletions.apprunning >= MIN_SYNC_COMPLETIONS
      && this.#syncCompletions.appinstalling >= MIN_SYNC_COMPLETIONS
      && this.#syncCompletions.apperrors >= MIN_SYNC_COMPLETIONS) {
      this.#stateSyncComplete = true;
      this.#clearSyncRequested();
      this.#peerProgress.clear();
      log.info('AppSyncOrchestrator - All state syncs complete');
      fluxEventBus.publish('ephemeralSync:allComplete', {
        apprunning: this.#syncCompletions.apprunning,
        appinstalling: this.#syncCompletions.appinstalling,
        apperrors: this.#syncCompletions.apperrors,
      });
      this.#checkReadiness();
    }
  }

  /**
   * A peer we asked dropped its connection. If it still owed sync types, it
   * is failed and what it never delivered is re-asked from a fresh peer. Its
   * delivered types stay banked in the completion counts.
   * @param {string} key ip:port of the lost peer
   */
  #onSyncPeerLost(key) {
    if (this.#stateSyncComplete) return;
    const progress = this.#peerProgress.get(key);
    if (!progress || progress.failed) return;
    const missing = SYNC_TYPES.filter((type) => !progress.done.has(type));
    if (missing.length === 0) return;
    progress.failed = true;
    log.warn(`AppSyncOrchestrator - Sync peer ${key} disconnected mid-sync (missing: ${missing.join(', ')})`);
    fluxEventBus.publish('ephemeralSync:peerFailed', { peer: key, reason: 'disconnected', missing });
    this.#topUpSyncPeers();
  }

  /**
   * Per-block supervision of an open sync round: fail peers that missed
   * their per-peer deadline (their late responses are no longer accepted),
   * then retry any replacement that previously found no fresh peer.
   */
  #superviseStateSync() {
    if (this.#stateSyncComplete || this.#syncRoundAbandoned) return;
    if (this.#askedPeers.size === 0) return;
    const now = Date.now();
    for (const [key, progress] of this.#peerProgress) {
      if (progress.failed) continue;
      const missing = SYNC_TYPES.filter((type) => !progress.done.has(type));
      if (missing.length === 0) continue;
      if (now - progress.askedAt < SYNC_TIMEOUT_MS) continue;
      progress.failed = true;
      this.#completeSyncRequest(key);
      log.warn(`AppSyncOrchestrator - Sync peer ${key} missed the ${Math.round(SYNC_TIMEOUT_MS / 1000)}s deadline (missing: ${missing.join(', ')})`);
      fluxEventBus.publish('ephemeralSync:peerFailed', { peer: key, reason: 'deadline', missing });
    }
    this.#topUpSyncPeers();
  }

  /**
   * Replace failed sync peers: for every type still short of
   * MIN_SYNC_COMPLETIONS after counting live in-flight peers, ask fresh
   * never-asked peers for exactly the missing types. Bounded by
   * MAX_SYNC_PEERS per sync round; when the budget is spent and nothing is
   * in flight, the round is abandoned and the block timer remains the only
   * path to readiness (the pre-existing terminal fallback).
   */
  #topUpSyncPeers() {
    if (this.#stateSyncComplete || this.#syncRoundAbandoned) return;
    if (this.#askedPeers.size === 0) return;

    const pending = {
      apprunning: 0, appinstalling: 0, apperrors: 0,
    };
    let anyLivePending = false;
    for (const progress of this.#peerProgress.values()) {
      if (progress.failed) continue;
      for (const type of SYNC_TYPES) {
        if (!progress.done.has(type)) {
          pending[type] += 1;
          anyLivePending = true;
        }
      }
    }
    const typesNeeded = SYNC_TYPES.filter(
      (type) => this.#syncCompletions[type] + pending[type] < MIN_SYNC_COMPLETIONS,
    );
    if (typesNeeded.length === 0) return;

    const budget = MAX_SYNC_PEERS - this.#askedPeers.size;
    if (budget <= 0) {
      if (!anyLivePending) {
        this.#syncRoundAbandoned = true;
        this.#clearSyncRequested();
        this.#peerProgress.clear();
        log.warn(`AppSyncOrchestrator - State sync abandoned after ${this.#askedPeers.size} peers, block timer will force readiness`);
      }
      return;
    }

    const eligible = this.#getEligibleSyncPeers(MIN_UPTIME_SECONDS);
    const fresh = eligible.filter((peer) => !this.#askedPeers.has(peer.key));
    if (fresh.length === 0) return; // re-checked on every processed block

    const needed = Math.max(...typesNeeded.map(
      (type) => MIN_SYNC_COMPLETIONS - this.#syncCompletions[type] - pending[type],
    ));
    const peersToAsk = fresh.slice(0, Math.min(needed, budget));
    const peerKeys = peersToAsk.map((peer) => peer.key).join(', ');
    log.info(`AppSyncOrchestrator - Replacing failed sync peers: asking ${peerKeys} for ${typesNeeded.join(', ')}`);
    this.#askPeersForTypes(peersToAsk, typesNeeded, false);
  }

  async #onPeersReady() {
    if (this.#state === STATES.DEGRADED) {
      this.#setState(STATES.RESYNCING);
      log.info('AppSyncOrchestrator - Peers recovered, resyncing');
    }

    this.#startAppRunningBroadcast();
    this.#requestSyncs();

    // Peers arriving is also a wake-up for the permanent-plane syncs: on boot the
    // manifest round may have run before discovery connected anyone (nothing to
    // compare against, so it never latched), and recovery needs a real peer set to
    // resync against. #advanceSync runs only the steps still incomplete.
    if (this.#state === STATES.SYNCING || this.#state === STATES.RESYNCING) {
      await this.#advanceSync();
    }
  }

  async #requestSyncs() {
    if (this.#stateSyncComplete) return;
    if (this.#askedPeers.size > 0) {
      // A round is already open (e.g. a peer-threshold re-fire) - only
      // replace what is actually missing instead of asking a fresh batch.
      this.#topUpSyncPeers();
      return;
    }

    const eligible = this.#getEligibleSyncPeers(MIN_UPTIME_SECONDS);
    if (eligible.length < MIN_SYNC_COMPLETIONS) {
      log.info(`AppSyncOrchestrator - Only ${eligible.length} eligible sync peers (need ${MIN_SYNC_COMPLETIONS}), falling back to block timer`);
      return;
    }

    const peersToAsk = eligible.slice(0, MIN_SYNC_COMPLETIONS);
    await this.#askPeersForTypes(peersToAsk, SYNC_TYPES, true);
  }

  #sendRequests(peers, label, message) {
    const peerKeys = peers.map((p) => p.key).join(', ');
    log.info(`AppSyncOrchestrator - Requesting ${label} sync from ${peers.length} peers: ${peerKeys}`);
    for (const peer of peers) {
      try {
        peer.send(message);
      } catch (error) {
        log.error(`AppSyncOrchestrator - Failed to request ${label} from ${peer.key}: ${error.message}`);
      }
    }
  }

  /**
   * Send sync requests for the given types to the given peers. Peers are
   * registered in the asked ledger and progress map synchronously, before the
   * async signing work, so concurrent top-up triggers cannot double-ask. If
   * signing fails the registered peers never receive requests; their deadline
   * expiry replaces them.
   * @param {Array<{key: string, send: Function}>} peersToAsk
   * @param {string[]} types Counted sync types to request
   * @param {boolean} includeTemp Also request temp messages (initial batch only)
   */
  async #askPeersForTypes(peersToAsk, types, includeTemp) {
    const askedAt = Date.now();
    for (const peer of peersToAsk) {
      this.#askedPeers.add(peer.key);
      this.#markSyncRequested(peer.key);
      this.#peerProgress.set(peer.key, { askedAt, done: new Set(), failed: false });
    }

    let pubkey;
    let requestTs;
    let signMsg;
    try {
      pubkey = await fluxNetworkHelper.getFluxNodePublicKey();
      const privkey = await fluxNetworkHelper.getFluxNodePrivateKey();
      requestTs = Date.now();
      signMsg = (type, sinceTs) => {
        const msg = peerCodec.buildSyncSignatureMessage(type, sinceTs, requestTs);
        return verificationHelper.signMessage(msg, privkey);
      };
    } catch (error) {
      log.error(`AppSyncOrchestrator - Failed to sign sync requests: ${error.message}`);
      return;
    }

    if (includeTemp) {
      const tempSig = signMsg(peerCodec.MSG_TYPE.REQUEST_TEMP_MESSAGES, 0);
      this.#sendRequests(peersToAsk, 'temp messages', peerCodec.encodeRequestTempMessages(0, requestTs, pubkey, tempSig));
    }

    const codecs = {
      apprunning: { msgType: peerCodec.MSG_TYPE.REQUEST_APP_RUNNING, encode: peerCodec.encodeRequestAppRunning },
      appinstalling: { msgType: peerCodec.MSG_TYPE.REQUEST_APP_INSTALLING, encode: peerCodec.encodeRequestAppInstalling },
      apperrors: { msgType: peerCodec.MSG_TYPE.REQUEST_APP_INSTALLING_ERRORS, encode: peerCodec.encodeRequestAppInstallingErrors },
    };
    for (const type of types) {
      const { msgType, encode } = codecs[type];
      const sig = signMsg(msgType, 0);
      this.#sendRequests(peersToAsk, type, encode(0, requestTs, pubkey, sig));
    }

    fluxEventBus.publish('ephemeralSync:requested', {
      peerCount: peersToAsk.length,
      peers: peersToAsk.map((peer) => peer.key),
      types,
    });
  }

  #onPeersDegraded() {
    if (this.#state === STATES.READY || this.#state === STATES.SYNCING) {
      this.#setState(STATES.DEGRADED);
      this.#hashSyncComplete = false;
      this.#dbRebuilt = false;
      globalState.dbReady = false;
      this.#resetSyncState();
      log.warn('AppSyncOrchestrator - Degraded, pausing spawner');
    }
  }

  #resetSyncState() {
    this.#askedPeers.clear();
    this.#peerProgress.clear();
    this.#clearSyncRequested();
    this.#syncCompletions = {
      apprunning: 0, appinstalling: 0, apperrors: 0,
    };
    this.#manifestSyncComplete = false;
    this.#stateSyncComplete = false;
    this.#syncRoundAbandoned = false;
    this.#hashSyncAttempts = 0;
    if (this.#hashSyncRetryTimer) {
      clearTimeout(this.#hashSyncRetryTimer);
      this.#hashSyncRetryTimer = null;
    }
  }

  #onBlocksProcessed(blockHeight) {
    const count = this.#lastBlockHeight > 0 ? blockHeight - this.#lastBlockHeight : 1;
    this.#lastBlockHeight = blockHeight;
    if (!this.#explorerSynced) {
      this.#explorerSynced = true;
      log.info(`AppSyncOrchestrator - Explorer synced at block ${blockHeight}`);
      if (this.#state === STATES.INITIALIZING) {
        this.#setState(STATES.SYNCING);
        this.#ensureBlockThreshold();
        this.#advanceSync();
      }
    }
    if (this.#state === STATES.SYNCING || this.#state === STATES.READY || this.#state === STATES.RESYNCING) {
      this.#blocksSinceSyncStarted += count;
      this.#superviseStateSync();
      this.#checkReadiness();
      this.#checkHashRetry(blockHeight);
    }
  }

  #onHashUnresolved() {
    if (!this.#hashSyncComplete) return;
    // New unresolved hash — schedule immediate check on next block
    this.#nextHashRetryHeight = 0;
  }

  #onHashesChanged() {
    if (!this.#hashSyncComplete) return;
    log.info('AppSyncOrchestrator - Reconstruct audit found changes, scheduling immediate hash recheck');
    this.#nextHashRetryHeight = 0;
  }

  async #checkHashRetry(blockHeight) {
    if (!this.#hashSyncComplete) return;
    if (!this.#canSendMessages) return;
    if (this.#syncInProgress) return;
    if (blockHeight < this.#nextHashRetryHeight) return;

    this.#syncInProgress = true;
    try {
      const result = await appHashSyncService.syncMissingHashes({ currentHeight: this.#lastBlockHeight });
      this.#nextHashRetryHeight = result.nextRetryHeight ?? (this.#lastBlockHeight + FALLBACK_RECHECK_BLOCKS);
      if (result.missing > 0) {
        log.info(`AppSyncOrchestrator - Hash retry: ${result.resolved} resolved, ${result.missing} remaining, next check at block ${this.#nextHashRetryHeight}`);
      }
    } catch (error) {
      log.error(`AppSyncOrchestrator - Hash retry failed: ${error.message}`);
      this.#nextHashRetryHeight = this.#lastBlockHeight + FALLBACK_RECHECK_BLOCKS;
    } finally {
      this.#syncInProgress = false;
    }
  }

  // The single driver for the permanent-plane syncs (hash then manifest). Every
  // wake-up — explorer synced, message-capability gained, peers ready — funnels
  // through here rather than each one hand-picking which step to run off a flag
  // proxy, so no interleaving of the three signals can leave a step un-run. Each
  // step self-guards on its own completion latch: one that already succeeded is
  // skipped, one that never truly ran is retried by whichever signal arrives next.
  // Deferred until the node can both verify against synced specs (explorer) and
  // send requests (capability); the block timer stays the terminal readiness
  // backstop.
  async #advanceSync() {
    if (this.#syncInProgress) return;
    if (!this.#explorerSynced || !this.#canSendMessages) {
      log.info(`AppSyncOrchestrator - Sync deferred (explorerSynced=${this.#explorerSynced}, canSendMessages=${this.#canSendMessages})`);
      return;
    }
    // Both permanent-plane steps already converged — nothing to run, just re-evaluate.
    if (this.#hashSyncComplete && this.#manifestSyncComplete) {
      this.#checkReadiness();
      return;
    }
    log.info('AppSyncOrchestrator - Sync started');
    if (!this.#hashSyncComplete) {
      await this.#checkVersionUpgrade();
      await this.#runHashSync();
    }
    await this.#runManifestSync();
    this.#checkReadiness();
  }

  async #checkVersionUpgrade() {
    if (!this.#fluxVersion) return;
    try {
      const db = dbHelper.databaseConnection();
      const database = db.db(config.database.local.database);
      const marker = await dbHelper.findOneInDatabase(database, startupCollection, { _id: 'hashSyncVersion' });
      if (!marker || marker.version !== this.#fluxVersion) {
        const resetCount = await appHashSyncService.resetHashSyncForUpgrade(this.#lastBlockHeight);
        log.info(`AppSyncOrchestrator - Version upgrade to ${this.#fluxVersion}, reset ${resetCount} hash sync entries`);
      }
    } catch (error) {
      log.error(`AppSyncOrchestrator - Version upgrade check failed: ${error.message}`);
    }
  }

  async #writeVersionMarker() {
    if (!this.#fluxVersion) return;
    try {
      const db = dbHelper.databaseConnection();
      const database = db.db(config.database.local.database);
      await dbHelper.findOneAndUpdateInDatabase(
        database, startupCollection,
        { _id: 'hashSyncVersion' },
        { $set: { version: this.#fluxVersion } },
        { upsert: true },
      );
    } catch (error) {
      log.error(`AppSyncOrchestrator - Failed to update hashSyncVersion marker: ${error.message}`);
    }
  }

  async #runHashSync() {
    if (this.#syncInProgress) return;
    this.#syncInProgress = true;
    try {
      this.#hashSyncAttempts += 1;
      const result = await appHashSyncService.syncMissingHashes({ currentHeight: this.#lastBlockHeight });
      if (result.missing > 0) {
        log.warn(`AppSyncOrchestrator - Hash sync has ${result.missing} unresolvable hashes, proceeding`);
      } else {
        log.info('AppSyncOrchestrator - Hash sync complete');
      }
      this.#hashSyncComplete = true;
      this.#nextHashRetryHeight = result.nextRetryHeight ?? (this.#lastBlockHeight + FALLBACK_RECHECK_BLOCKS);
      await this.#writeVersionMarker();
      await this.#rebuildDb();
      fluxEventBus.publish('hashSync:complete', { attempt: this.#hashSyncAttempts, missing: result.missing });
    } catch (error) {
      log.error(`AppSyncOrchestrator - Hash sync failed (attempt ${this.#hashSyncAttempts}/${HASH_SYNC_MAX_RETRIES}): ${error.message}`);
      const willRetry = this.#hashSyncAttempts < HASH_SYNC_MAX_RETRIES;
      fluxEventBus.publish('hashSync:failed', { attempt: this.#hashSyncAttempts, maxRetries: HASH_SYNC_MAX_RETRIES, willRetry, error: error.message });
      if (willRetry) {
        log.info(`AppSyncOrchestrator - Scheduling hash sync retry in ${HASH_SYNC_RETRY_MS / 1000}s`);
        this.#hashSyncRetryTimer = setTimeout(() => {
          this.#hashSyncRetryTimer = null;
          this.#runHashSync().then(() => this.#checkReadiness());
        }, HASH_SYNC_RETRY_MS);
      } else {
        log.warn('AppSyncOrchestrator - Hash sync retries exhausted, falling back to block timer');
      }
    } finally {
      this.#syncInProgress = false;
    }
  }

  async #rebuildDb() {
    try {
      log.info('AppSyncOrchestrator - Rebuilding globalAppsInformation');
      await registryManager.reindexGlobalAppsInformation();
      this.#dbRebuilt = true;
      globalState.dbReady = true;
      log.info('AppSyncOrchestrator - DB ready');
    } catch (error) {
      log.error(`AppSyncOrchestrator - DB rebuild failed: ${error.message}`);
    }
  }

  // Reconcile the permanent content-manifest register off the ephemeral plane (two-step
  // in-band exchange). Gates readiness like the hash sync, so the spawner waits on the
  // manifest view converging before it starts a slot app — but best-effort and bounded,
  // so slow/absent peers fall back to the block timer rather than stalling boot. Run
  // after the hash sync so the global specs the manifests verify against are present.
  async #runManifestSync() {
    if (this.#manifestSyncComplete) return;
    if (!this.#canSendMessages) return;
    fluxEventBus.publish('content:manifestSyncStarted', {});
    try {
      const peers = this.#getEligibleSyncPeers(MIN_UPTIME_SECONDS);
      const result = await contentManifestSyncService.reconcile(peers);
      // Latch complete only on evidence the register was actually compared against a
      // peer (>=1 index received). A vacuous round — no eligible peers, a single-flight
      // collision, or a silent index timeout — must stay incomplete so a later wake-up
      // retries; otherwise the node ships READY believing it converged when it asked no one.
      if (result.indexesReceived >= 1) {
        this.#manifestSyncComplete = true;
        log.info(`AppSyncOrchestrator - Manifest reconcile complete (peers=${result.peers}, indexes=${result.indexesReceived}, fetched=${result.fetched ?? 0})`);
        fluxEventBus.publish('content:manifestSyncComplete', result);
      } else {
        log.info(`AppSyncOrchestrator - Manifest reconcile made no peer contact (peers=${result.peers}), will retry`);
      }
    } catch (error) {
      log.error(`AppSyncOrchestrator - Manifest reconcile failed: ${error.message}`);
      // Leave incomplete; the block timer releases readiness, gossip + per-app catch-up backfill.
    }
  }

  #ensureBlockThreshold() {
    if (this.#blockThreshold === 0) {
      const enterprise = this.#isEnterprise();
      const blocksPerMinute = 2;
      this.#blockThreshold = enterprise
        ? 62 * blocksPerMinute
        : 125 * blocksPerMinute;
    }
  }

  #isBlockTimerExpired() {
    this.#ensureBlockThreshold();
    return this.#blocksSinceSyncStarted >= this.#blockThreshold;
  }

  #isStateSyncReady() {
    if (this.#stateSyncComplete) return true;
    return this.#isBlockTimerExpired();
  }

  async #checkReadiness() {
    if (this.#state !== STATES.SYNCING && this.#state !== STATES.RESYNCING) return;
    if (!this.#explorerSynced) return;

    const blockTimerExpired = this.#isBlockTimerExpired();
    if (!this.#hashSyncComplete && !blockTimerExpired) return;
    if (!this.#dbRebuilt && !blockTimerExpired) return;
    // The permanent manifest register must converge before the spawner starts a slot app
    // (parallel to the hash-sync gate); the block timer is the same backstop.
    if (!this.#manifestSyncComplete && !blockTimerExpired) return;

    // Block timer fired but hash sync / DB rebuild never completed — rebuild from whatever data we have
    if (blockTimerExpired && !this.#dbRebuilt) {
      await this.#rebuildDb();
      if (!this.#dbRebuilt) return;
    }

    if (!this.#isStateSyncReady()) return;

    if (!this.#canSendMessages) return;

    this.#setState(STATES.READY);
    log.info('AppSyncOrchestrator - All readiness conditions met');
  }

  onMessageCapabilityChange(capable) {
    const prev = this.#canSendMessages;
    this.#canSendMessages = capable;
    if (prev === capable) return;
    if (capable) {
      log.info('AppSyncOrchestrator - Message capability gained');
      // Re-run whatever is still incomplete (hash and/or manifest), not just when
      // hash is unfinished: on a peers-first recovery the RESYNCING pass completes
      // the hash sync but leaves the manifest un-reconciled, and keying the retry on
      // #hashSyncComplete alone would skip it forever.
      this.#advanceSync();
    } else {
      log.info('AppSyncOrchestrator - Message capability lost');
      if (this.#state === STATES.READY) {
        this.#setState(STATES.SYNCING);
        log.warn('AppSyncOrchestrator - Readiness lost (message capability), pausing spawner');
      }
    }
  }

  async #startAppRunningBroadcast() {
    if (this.#broadcastStarted) return;
    this.#broadcastStarted = true;
    log.info('AppSyncOrchestrator - App running broadcast started');
    await globalState.waitForBootContainerStateSettled();
    peerNotification.checkAndNotifyPeersOfRunningApps();
  }

  get bootContext() {
    return this.#bootContext;
  }

  set bootContext(ctx) {
    this.#bootContext = ctx;
  }

  static async readBootContext() {
    try {
      const db = dbHelper.databaseConnection();
      const database = db.db(config.database.local.database);
      const heartbeat = await dbHelper.findOneInDatabase(database, startupCollection, { _id: 'heartbeat' });

      let currentBootId = null;
      try {
        const bootIdPath = config.system.bootIdPath ?? '/proc/sys/kernel/random/boot_id';
        currentBootId = (await fs.readFile(bootIdPath, 'utf8')).trim();
      } catch (err) {
        log.warn(`Failed to read boot_id: ${err.message}, assuming machine rebooted`);
      }

      const machineRebooted = !currentBootId || !heartbeat || heartbeat.machineBootId !== currentBootId;
      const downtimeMs = heartbeat ? Date.now() - heartbeat.lastAlive : Infinity;
      const cleanShutdown = heartbeat?.shutdownReason === 'sigterm';

      const ctx = {
        machineRebooted,
        downtimeMs,
        cleanShutdown,
        currentBootId,
        firstBoot: !heartbeat,
      };

      log.info(`Boot context: machineRebooted=${machineRebooted} downtime=${Math.round(downtimeMs / 1000)}s cleanShutdown=${cleanShutdown} firstBoot=${!heartbeat}`);
      return ctx;
    } catch (error) {
      log.error(`Failed to read boot context: ${error.message}`);
      return { machineRebooted: true, downtimeMs: Infinity, cleanShutdown: false, currentBootId: null, firstBoot: true };
    }
  }

  async #clearShutdownReason() {
    try {
      const db = dbHelper.databaseConnection();
      const database = db.db(config.database.local.database);
      await dbHelper.findOneAndUpdateInDatabase(database, startupCollection, { _id: 'heartbeat' }, { $unset: { shutdownReason: '' } });
    } catch (error) {
      log.error(`Failed to clear shutdown reason: ${error.message}`);
    }
  }

  #startHeartbeat() {
    const writeHeartbeat = async () => {
      try {
        const db = dbHelper.databaseConnection();
        const database = db.db(config.database.local.database);
        const update = { $set: { lastAlive: Date.now() } };
        if (this.#bootContext?.currentBootId) {
          update.$set.machineBootId = this.#bootContext.currentBootId;
        }
        await dbHelper.findOneAndUpdateInDatabase(database, startupCollection, { _id: 'heartbeat' }, update, { upsert: true });
      } catch (error) {
        log.error(`Heartbeat write failed: ${error.message}`);
      }
    };
    this.#clearShutdownReason();
    writeHeartbeat();
    this.#heartbeatInterval = setInterval(writeHeartbeat, config.system.heartbeatIntervalMs ?? 30000);
  }

  static async writeShutdownReason(reason) {
    try {
      const db = dbHelper.databaseConnection();
      if (!db) return;
      const database = db.db(config.database.local.database);
      await Promise.race([
        dbHelper.findOneAndUpdateInDatabase(
          database,
          config.database.local.collections.nodeStartupTracker,
          { _id: 'heartbeat' },
          { $set: { shutdownReason: reason } },
          { upsert: true },
        ),
        new Promise((_, reject) => { setTimeout(() => reject(new Error('shutdown write timeout')), 3000); }),
      ]);
    } catch (error) {
      log.error(`Failed to write shutdown reason: ${error.message}`);
    }
  }

  stop() {
    this.#started = false;
    if (this.#heartbeatInterval) {
      clearInterval(this.#heartbeatInterval);
      this.#heartbeatInterval = null;
    }
    if (this.#ephemeralSyncHandler) {
      appSyncEvents.removeListener(EVENTS.EPHEMERAL_SYNC_COMPLETE, this.#ephemeralSyncHandler);
    }
    if (this.#hashUnresolvedHandler) {
      appSyncEvents.removeListener(EVENTS.HASH_UNRESOLVED, this.#hashUnresolvedHandler);
    }
    if (this.#blockReceivedHandler) {
      this.#blockEmitter.removeListener('blocksProcessed', this.#blockReceivedHandler);
    }
    if (this.#hashesChangedHandler) {
      this.#blockEmitter.removeListener('hashesChanged', this.#hashesChangedHandler);
    }
    if (this.#peerThresholdHandler) {
      this.#offPeerEvent('peerThresholdReached', this.#peerThresholdHandler);
    }
    if (this.#peersBelowHandler) {
      this.#offPeerEvent('peersBelowThreshold', this.#peersBelowHandler);
    }
    if (this.#syncPeerLostHandler) {
      this.#offPeerEvent('syncPeerLost', this.#syncPeerLostHandler);
    }
    peerNotification.stopBroadcastInterval();
    this.#broadcastStarted = null;
    if (this.#hashSyncRetryTimer) {
      clearTimeout(this.#hashSyncRetryTimer);
      this.#hashSyncRetryTimer = null;
    }
  }
}

module.exports = { AppSyncOrchestrator, STATES };
