'use strict';

const fs = require('fs').promises;
const config = require('config');
const log = require('../../lib/log');
const nodeStartupRepository = require('../appDatabase/nodeStartupRepository');
const appHashSyncService = require('./appHashSyncService');
const contentManifestSyncService = require('./contentManifestSyncService');
const ingressAttestationSyncService = require('./ingressAttestationSyncService');
const peerNotification = require('./peerNotification');
const registryManager = require('../appDatabase/registryManager');
const globalState = require('../utils/globalState');
const peerCodec = require('../utils/peerCodec');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const verificationHelper = require('../verificationHelper');
const { appSyncEvents, EVENTS } = require('../utils/appSyncEvents');
const fluxEventBus = require('../utils/fluxEventBus');


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
const FALLBACK_MINUTES = config.fluxapps.appSyncFallbackMinutes ?? 125;
// A chain fact, not a policy: blocks are 30 seconds since the PON fork
// (config.fluxapps.daemonPONFork), so two a minute. Not a knob - a node that
// disagrees with the chain about this converts appSyncFallbackMinutes into the
// wrong number of blocks and waits the wrong length of time in silence.
const BLOCKS_PER_MINUTE = 2;
// THE TWO WAYS A PEER CAN BE QUIET, and they mean different things.
//
// A slot must be able to fail and its replacement still finish inside the
// budget, so with S as a healthy peer's completion time - about a minute on our
// fleet - both of these have to satisfy `deadline + S <= SYNC_TIMEOUT_MS`.
//
// FIRST_RESPONSE is "never spoke". The only work between our send and the peer's
// first batch is a signature check, one indexed query and serialising 2000
// documents, so a twelfth of the budget is about an order of magnitude more than
// it needs - and a peer that has sent NOTHING is unambiguous, because a peer
// with nothing to report still sends an empty final batch.
//
// STALL is "spoke, then stopped", which needs more room because a peer may
// legitimately be working between batches. A quarter caps what a stalled peer
// can spend.
//
// Both are enforced by the per-block supervision rather than by a timer per
// request, which is this tree's shape and the one that cannot leak a timer.
// That costs granularity - a deadline is noticed at the next block, so ~30s -
// and the constraint above still holds at that resolution.
/**
 * A fresh record of WHICH peers have answered which stream.
 *
 * One place, because the tally is built twice - at construction and again
 * whenever a sync starts over - and a stream present in one copy and not the
 * other reads as a stream nobody has answered, forever.
 *
 * @returns {{apprunning: Set<string>, appinstalling: Set<string>, apperrors: Set<string>}}
 */
function freshSyncCompletions() {
  return { apprunning: new Set(), appinstalling: new Set(), apperrors: new Set() };
}

const FIRST_RESPONSE_MS = Math.max(1, Math.floor(SYNC_TIMEOUT_MS / 12));
const STALL_MS = Math.max(1, Math.floor(SYNC_TIMEOUT_MS / 4));
const MIN_UPTIME_SECONDS = config.fluxapps.appSyncMinPeerUptime ?? 7500;
const HASH_SYNC_MAX_RETRIES = config.fluxapps.hashSyncMaxRetries ?? 3;
const HASH_SYNC_RETRY_MS = config.fluxapps.hashSyncRetryMs ?? 300000;
const FALLBACK_RECHECK_BLOCKS = config.fluxapps.hashSyncFallbackRecheckBlocks ?? 100;
// Steady-state manifest anti-entropy: how often a READY node re-checks its content register
// against a few peers, and how many it samples. Bounds how long a node that silently missed
// an update (a partial partition above the degrade floor) can serve stale content.
const MANIFEST_REFRESH_BLOCKS = config.fluxapps.manifestRefreshBlocks ?? 100;
const MANIFEST_REFRESH_PEERS = config.fluxapps.manifestRefreshPeers ?? 3;
// The refresh's own peer-uptime floor, deliberately far below the boot hash sync's
// MIN_UPTIME_SECONDS anti-flap gate: manifests are owner-signed and the register only
// moves to a higher signed version, so a young peer can at worst waste one tiny
// round-trip — while the node that most needs the backstop (just healed from a
// partition) is exactly the one whose connections are freshest. The 2h gate would
// blind the refresh to every peer for hours after a heal, quietly stretching the
// backstop's staleness ceiling from ~50 min to ~2.5 h. The token floor only skips
// sockets still mid-handshake or dying instantly.
const MANIFEST_REFRESH_MIN_PEER_UPTIME_SECONDS = config.fluxapps.manifestRefreshMinPeerUptime ?? 30;

// Steady-state ingress-attestation anti-entropy, on its own (slower) cadence. Attestations
// are a forensic backstop — live gossip is the fast path and nothing is served from them —
// so a looser convergence ceiling is fine and roughly halves the index traffic vs the
// manifest cadence. NOTE: like the manifest reconcile this exchanges the FULL index each
// round (O(set size)); fine at current scale, a shared bucketed-digest reconcile is the
// planned upgrade for both once the confirmed set grows large. Reuses the manifest refresh's
// peer count and uptime floor.
const INGRESS_REFRESH_BLOCKS = config.fluxapps.ingressRefreshBlocks ?? 200;

// Mechanism B's slack (fluxModels formal/record-convergence): how far before
// the observed loss the scoped reconnect pull reaches back, covering
// publishes in flight either side of the drop.
const RECONNECT_SYNC_SLACK_MS = config.fluxapps.reconnectSyncSlackMs ?? 120000;

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
  #getPeerByKey = null;
  #onPeerEvent = null;
  #offPeerEvent = null;
  #markSyncRequested = null;
  #clearSyncRequested = null;
  #completeSyncRequest = null;
  #isEnterprise = null;
  #waitForNetworkState = null;
  #networkReady = false;
  #peersAtFloor = false;
  // Epoch-scoped fact, not a remembered edge: did the peer floor get attained
  // since this sync epoch (SYNCING/RESYNCING entry) began. Discriminates the
  // two below-floor worlds in the rule table: losing a network you had is an
  // incident; never finding one is a startup condition the timer may release.
  #floorAttainedThisEpoch = false;
  #evaluating = false;
  #reevaluate = false;
  #explorerSynced = false;
  #hashSyncComplete = false;
  #dbRebuilt = false;
  #blocksSinceSyncStarted = 0;
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
  // WHICH peers answered, not how many answers arrived. Three responses from one
  // peer are one peer's view of the network, and counting them as three
  // satisfied the requirement without ever asking anyone else - which is the
  // whole thing the minimum exists to prevent.
  #syncCompletions = freshSyncCompletions();
  #manifestSyncComplete = false;
  #ingressSyncComplete = false;
  #stateSyncComplete = false;
  #syncRoundAbandoned = false;
  #peerDisconnectedHandler = null;
  #peerConnectedHandler = null;
  #ephemeralRefusedHandler = null;
  #ephemeralUnverifiedHandler = null;
  #ephemeralProgressHandler = null;
  #syncPeersAvailableHandler = null;
  #peerReestablishedHandler = null;
  // Peers with a scoped reconnect pull in flight, each with the loss its pull
  // covers: their completion is the pull's, never the round's - a scoped
  // answer must not stand in for a full one. A round that asks such a peer
  // reclaims it (round membership wins). A pull whose socket dies unanswered
  // hands its loss back to the credits.
  #reconnectPulls = new Map();
  // Reconnect credits not yet spent: key -> earliest lostAtMs. The
  // re-establishment event is one-shot but the credit it grants is DURABLE
  // until a pull is sent or a round covers the peer at since=0 - a transient
  // gate (message capability lost while the healed side's chain catches up)
  // must delay the pull, never destroy it.
  #pendingReconnectPulls = new Map();
  #hashSyncAttempts = 0;
  #hashSyncRetryTimer = null;
  #nextHashRetryHeight = 0;
  #lastBlockHeight = 0;
  #fluxVersion = null;
  #heartbeatInterval = null;
  #bootContext = null;
  #canSendMessages = false;
  #peerCountIfAboveThreshold = () => 0;
  #catchUpRunningContent = async () => {};
  #nextManifestRefreshHeight = 0;
  #manifestRefreshInProgress = false;
  #nextIngressRefreshHeight = 0;
  #ingressRefreshInProgress = false;

  constructor(options = {}) {
    this.#blockEmitter = options.blockEmitter;
    this.#getEligibleSyncPeers = options.getEligibleSyncPeers;
    this.#getPeerByKey = options.getPeerByKey ?? (() => null);
    this.#onPeerEvent = options.onPeerEvent;
    this.#offPeerEvent = options.offPeerEvent;
    this.#markSyncRequested = options.markSyncRequested ?? (() => {});
    this.#clearSyncRequested = options.clearSyncRequested ?? (() => {});
    this.#completeSyncRequest = options.completeSyncRequest ?? (() => {});
    this.#isEnterprise = options.isEnterprise ?? (() => false);
    this.#peerCountIfAboveThreshold = options.peerCountIfAboveThreshold ?? (() => 0);
    this.#catchUpRunningContent = options.catchUpRunningContent ?? (async () => {});
    this.#waitForNetworkState = options.networkStateReady ?? null;
    this.#fluxVersion = options.fluxVersion ?? null;
  }

  get state() {
    return this.#state;
  }

  /**
   * Whether a sync response arriving on this connection is still wanted.
   *
   * The round's own record answers it. What this node asked for, and of which
   * CONNECTION, is written here when the request goes out and unwritten when
   * the request ends - by a completion, a refusal, an unverifiable chunk, a
   * deadline or the socket closing. A second copy of that record elsewhere is
   * a second answer to one question, and the two disagree exactly where it
   * matters: on the peer that dropped and came back.
   *
   * Per connection, not per address. A peer that reconnects keeps its ip:port,
   * so a response on the new socket would otherwise be accepted against a
   * request written into the old one - a stale view counted as this round's
   * survey.
   *
   * @param {{key: string, connectionId?: number|null}} peer the socket a response arrived on
   * @returns {boolean}
   */
  isSyncResponseWanted(peer) {
    if (!peer || !peer.key) return false;
    if (this.#stateSyncComplete) return false;
    const progress = this.#peerProgress.get(peer.key);
    if (!progress || progress.failed) return false;
    const connectionId = peer.connectionId ?? null;
    // Either end not naming a connection is the pre-connectionId case and
    // cannot be told apart, so it is admitted on the address alone.
    if (connectionId !== null && progress.connectionId !== null
      && progress.connectionId !== connectionId) return false;
    return true;
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
      this.#peersAtFloor = true;
      this.#floorAttainedThisEpoch = true;
      this.#own(this.#onPeersReady());
    };
    this.#peersBelowHandler = (count) => {
      log.info(`AppSyncOrchestrator - Peers below threshold (${count} peers)`);
      // A downward crossing proves the floor WAS attained - the edge carries
      // the level's history, covering an upward edge this instance never saw
      // (raced the subscription or the startup seed).
      this.#floorAttainedThisEpoch = true;
      this.#peersAtFloor = false;
      this.#own(this.#evaluate());
    };
    // A CONNECTION ENDING is the announcement, not the manager's opinion about
    // whether a sync was riding on it. `syncPeerLost` was that opinion, read off
    // a SECOND copy of the asked-peer record kept inside FluxPeerManager - and
    // it is not emitted at all when a peer re-dials under the same key, where
    // the manager's own comment says a request written into that socket is as
    // dead as one whose peer went away. The orchestrator holds the record that
    // decides, and #onSyncPeerLost already ignores a connection it was not
    // waiting on, so it takes the unfiltered event and answers for itself.
    this.#peerDisconnectedHandler = (key, connectionId = null) => this.#onSyncPeerLost({ key, connectionId });
    // The counterpart, and the only thing that completes a round the fleet was
    // too small to fill when it opened. The peer threshold is an edge and fires
    // once, so without this a part-filled pool stays part-filled however many
    // peers arrive afterwards.
    this.#peerConnectedHandler = () => this.#own(this.#onPeersReady());
    this.#syncPeersAvailableHandler = () => this.#onSyncPeersAvailable();
    this.#peerReestablishedHandler = (info) => {
      this.#onPeerReestablished(info).catch((error) => {
        log.error(`AppSyncOrchestrator - reconnect sync failed: ${error.message}`);
      });
    };
    this.#onPeerEvent('peerThresholdReached', this.#peerThresholdHandler);
    this.#onPeerEvent('peersBelowThreshold', this.#peersBelowHandler);
    this.#onPeerEvent('peerDisconnected', this.#peerDisconnectedHandler);
    this.#onPeerEvent('peerConnected', this.#peerConnectedHandler);
    this.#onPeerEvent('syncPeersAvailable', this.#syncPeersAvailableHandler);
    this.#onPeerEvent('peerReestablished', this.#peerReestablishedHandler);

    // peerThresholdReached is edge-triggered and latched in FluxPeerManager:
    // if peers connected fast enough that the threshold was crossed BEFORE the
    // subscriptions above (e.g. inbound reconnects racing a restart), the edge
    // has already fired and never re-fires, which would leave #peersReady
    // false and stall ephemeral state sync until the block timer. Read the
    // level after subscribing to the edge.
    const peersAlready = this.#peerCountIfAboveThreshold();
    if (peersAlready && !this.#peersAtFloor) {
      this.#peerThresholdHandler(peersAlready);
    }

    this.#ephemeralSyncHandler = (syncType, peerKey) => this.#onEphemeralSyncComplete(syncType, peerKey);
    appSyncEvents.on(EVENTS.EPHEMERAL_SYNC_COMPLETE, this.#ephemeralSyncHandler);

    // The other three answers a peer can give. fluxCommunication has always
    // emitted them - a refusal, an unverifiable response, and any sign of life
    // mid-answer - and nothing listened, so the round waited out the full
    // deadline on a peer that had already said no.
    this.#ephemeralRefusedHandler = (syncType, peerKey) => this.#onEphemeralSyncRefused(syncType, peerKey);
    appSyncEvents.on(EVENTS.EPHEMERAL_SYNC_REFUSED, this.#ephemeralRefusedHandler);

    this.#ephemeralUnverifiedHandler = (peerKey) => this.#onEphemeralSyncUnverified(peerKey);
    appSyncEvents.on(EVENTS.EPHEMERAL_SYNC_UNVERIFIED, this.#ephemeralUnverifiedHandler);

    this.#ephemeralProgressHandler = (peerKey) => this.#onEphemeralSyncProgress(peerKey);
    appSyncEvents.on(EVENTS.EPHEMERAL_SYNC_PROGRESS, this.#ephemeralProgressHandler);

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
    // The floor may already be attained here (live edge during the
    // network-state wait, or the latched-level check above), so always attempt
    // the start.
    this.#own(this.#onPeersReady());
  }

  /**
   * End one peer's request without counting it, and get another peer asked.
   *
   * @param {string} peerKey ip:port
   * @param {string} outcome for the log
   * @returns {boolean} whether this call was the one that ended it
   */
  #endRequest(peerKey, outcome) {
    const progress = this.#peerProgress.get(peerKey);
    if (!progress || progress.failed) return false;
    progress.failed = true;
    this.#completeSyncRequest(progress.connectionId);
    log.info(`AppSyncOrchestrator - ${peerKey} ${outcome}, asking another peer`);
    // The deficit decides. A pool that is already whole asks nobody, so this is
    // unconditional rather than guarded - a guard here would only be a second
    // way of saying the same thing, and one no test could tell from its absence.
    this.#topUpSyncPeers();
    return true;
  }

  /**
   * A peer answered by DECLINING, which is not a completion.
   *
   * A node whose own app state is not authoritative yet says so rather than
   * sending a fraction of the network's view. Its request ends here, so it
   * stops being a candidate and the pool shows a deficit the next pass fills
   * from a peer that may actually know something.
   *
   * A peer refuses all four streams when it refuses any, and only the first of
   * those closes the request - so the log says once what happened once.
   *
   * @param {string} syncType apptemp | apprunning | appinstalling | apperrors
   * @param {string} peerKey ip:port of the peer that declined
   */
  #onEphemeralSyncRefused(syncType, peerKey) {
    if (this.#stateSyncComplete) return;
    if (!peerKey) {
      log.error(`AppSyncOrchestrator - ${syncType} sync declined with no peer, cannot replace it`);
      return;
    }
    this.#endRequest(peerKey, `declined the ${syncType} sync`);
  }

  /**
   * A peer sent something this node cannot attribute to it.
   *
   * Its request ends here rather than on a deadline, because the answer is
   * already known: a stream with a hole in it is not a survey, and waiting the
   * peer out would spend one of very few slots on an answer that cannot be
   * counted whatever else arrives.
   *
   * @param {string} peerKey ip:port of the peer whose response failed
   */
  #onEphemeralSyncUnverified(peerKey) {
    if (this.#stateSyncComplete) return;
    if (!peerKey) {
      log.error('AppSyncOrchestrator - An unverifiable sync response named no peer, cannot replace it');
      return;
    }
    if (this.#endRequest(peerKey, 'sent a response this node could not verify')) {
      fluxEventBus.publish('ephemeralSync:peerUnverified', { peer: peerKey });
    }
  }

  /**
   * Anything arriving from a peer proves it is working, so its clock restarts.
   *
   * A peer part-way through a large answer is doing exactly what was asked and
   * may legitimately pause between batches. Which stream it arrived on does not
   * matter - the question this answers is whether the peer is still there, and
   * any of its responses says so.
   *
   * @param {string} peerKey ip:port
   */
  #onEphemeralSyncProgress(peerKey) {
    const progress = this.#peerProgress.get(peerKey);
    if (!progress || progress.failed) return;
    // The first arrival moves it off the short "never spoke" deadline and onto
    // the longer stall one, and every arrival restarts the clock.
    progress.spoken = true;
    progress.lastHeardAt = Date.now();
  }

  #onEphemeralSyncComplete(syncType, peerKey) {
    // A scoped reconnect pull completing is the pull's own business - it
    // answered from a since bound, not the round's since=0. It is announced:
    // a node back from unreachability runs its placement check on it.
    if (this.#reconnectPulls.delete(peerKey)) {
      appSyncEvents.emit(EVENTS.RECONNECT_SYNC_COMPLETE, peerKey);
      return;
    }
    if (this.#stateSyncComplete) return;
    // A completion is a PEER. The response handlers have the key and always had
    // it, so one arriving without it means that path stopped saying - and
    // banking it anyway is how the count went back to being a tally of answers,
    // which one peer answering three times satisfies.
    if (!peerKey) {
      log.error(`AppSyncOrchestrator - ${syncType} sync completed with no peer, refusing to count it`);
      return;
    }
    if (this.#syncCompletions[syncType] === undefined) return;
    const progress = this.#peerProgress.get(peerKey);
    if (progress && !progress.failed) progress.done.add(syncType);
    this.#syncCompletions[syncType].add(peerKey);
    log.info(`AppSyncOrchestrator - ${syncType} sync complete from ${peerKey} (${this.#syncCompletions[syncType].size}/${MIN_SYNC_COMPLETIONS} peers)`);
    fluxEventBus.publish('ephemeralSync:peerComplete', {
      syncType,
      completions: this.#syncCompletions[syncType].size,
      required: MIN_SYNC_COMPLETIONS,
    });
    if (this.#syncCompletions.apprunning.size >= MIN_SYNC_COMPLETIONS
      && this.#syncCompletions.appinstalling.size >= MIN_SYNC_COMPLETIONS
      && this.#syncCompletions.apperrors.size >= MIN_SYNC_COMPLETIONS) {
      this.#stateSyncComplete = true;
      this.#publishStateSyncAuthority();
      this.#clearSyncRequested();
      this.#peerProgress.clear();
      log.info('AppSyncOrchestrator - All state syncs complete');
      fluxEventBus.publish('ephemeralSync:allComplete', {
        apprunning: this.#syncCompletions.apprunning.size,
        appinstalling: this.#syncCompletions.appinstalling.size,
        apperrors: this.#syncCompletions.apperrors.size,
      });
      this.#own(this.#evaluate());
    }
  }

  // A permanent-plane round that found no askable peer leaves its step incomplete
  // and has already consumed the peer-threshold edge, which is latched and does not
  // re-fire. Peers becoming askable is the level that round actually waited on, so
  // it is what resumes the work - no timer, and a step that has latched complete is
  // never re-run.
  #onSyncPeersAvailable() {
    if (this.#hashSyncComplete && this.#manifestSyncComplete) return;
    if (this.#state !== STATES.SYNCING && this.#state !== STATES.RESYNCING) return;
    this.#own(this.#advanceSync());
  }

  /**
   * A peer we asked dropped its connection. If it still owed sync types, it
   * is failed and what it never delivered is re-asked from a fresh peer. Its
   * delivered types stay banked in the completion counts.
   * @param {string} key ip:port of the lost peer
   */
  #onSyncPeerLost({ key, connectionId = null }) {
    // A scoped pull that dies with its socket was never answered: its loss
    // goes back to the credits, so the next re-establishment pulls from the
    // earliest gap and not from the connect time of a socket the far end
    // refused (a peer at its inbound cap closes every accept within a
    // second, and each accept is a re-establishment).
    const lostAtMs = this.#reconnectPulls.get(key);
    if (lostAtMs !== undefined) {
      this.#reconnectPulls.delete(key);
      const existing = this.#pendingReconnectPulls.get(key);
      this.#pendingReconnectPulls.set(key, existing === undefined ? lostAtMs : Math.min(existing, lostAtMs));
    }
    if (this.#stateSyncComplete) return;
    const progress = this.#peerProgress.get(key);
    if (!progress || progress.failed) return;
    // Only the connection this round is actually waiting on. A peer that
    // reconnects keeps its ip:port, so a loss announced for the socket BEFORE
    // the one in use would otherwise cancel the live request and replace a peer
    // that is answering perfectly well.
    if (connectionId !== null && progress.connectionId !== null
      && progress.connectionId !== connectionId) {
      return;
    }
    const missing = SYNC_TYPES.filter((type) => !progress.done.has(type));
    if (missing.length === 0) return;
    progress.failed = true;
    this.#completeSyncRequest(progress.connectionId);
    log.warn(`AppSyncOrchestrator - Sync peer ${key} disconnected mid-sync (missing: ${missing.join(', ')})`);
    fluxEventBus.publish('ephemeralSync:peerDisconnected', { peer: key, connectionId, missing });
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
      // Which silence this is. A peer that has said nothing is judged on the
      // short deadline; one that spoke and stopped gets the longer one, because
      // it may legitimately be working between batches.
      const deadline = progress.spoken ? STALL_MS : FIRST_RESPONSE_MS;
      const why = progress.spoken ? 'stopped mid-answer' : 'said nothing';
      if (now - progress.lastHeardAt < deadline) continue;
      progress.failed = true;
      this.#completeSyncRequest(progress.connectionId);
      log.warn(`AppSyncOrchestrator - Sync peer ${key} ${why} within its ${Math.round(deadline / 1000)}s deadline (missing: ${missing.join(', ')})`);
      // Named for what happened, not for the fact that something did: a
      // deadline, a disconnection and an unverifiable answer are three different
      // findings about a peer and a reader acts on them differently.
      fluxEventBus.publish('ephemeralSync:peerTimedOut', { peer: key, reason: why, missing });
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
      (type) => this.#syncCompletions[type].size + pending[type] < MIN_SYNC_COMPLETIONS,
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
      (type) => MIN_SYNC_COMPLETIONS - this.#syncCompletions[type].size - pending[type],
    ));
    const peersToAsk = fresh.slice(0, Math.min(needed, budget));
    const peerKeys = peersToAsk.map((peer) => peer.key).join(', ');
    log.info(`AppSyncOrchestrator - Replacing failed sync peers: asking ${peerKeys} for ${typesNeeded.join(', ')}`);
    this.#askPeersForTypes(peersToAsk, typesNeeded, false);
  }

  /**
   * OWN THE PROMISE.
   *
   * Every trigger this orchestrator has calls a pass and returns - a block
   * arriving, a peer joining, a peer going, a retry timer - so a throw inside
   * one is a rejection nobody is holding. node raises those to apiServer's
   * process handler, and that handler answers by exiting: one reconcile pass
   * that could not read the peer list takes the node down with it.
   *
   * A pass that could not run is a pass that did not run. It is reported, and
   * the state it was going to change is left exactly as it was - so the next
   * trigger runs it again, which is what the passes that already return early
   * depend on.
   *
   * @param {Promise<*>} pass
   */
  #own(pass) {
    Promise.resolve(pass).catch((error) => {
      log.error(`AppSyncOrchestrator - Reconcile pass failed: ${error.message}`);
    });
  }

  async #onPeersReady() {
    if (!this.#networkReady || !this.#peersAtFloor) return;
    // The transition (DEGRADED -> RESYNCING, or nothing) belongs to the rule
    // table; this handler only wakes the I/O that peers arriving unblocks.
    await this.#evaluate();

    this.#own(this.#startAppRunningBroadcast());
    // Awaited, so a failure inside it is this pass's failure and not an
    // orphaned rejection thrown after the pass has already returned.
    await this.#requestSyncs();

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
    if (eligible.length === 0) {
      log.info('AppSyncOrchestrator - No eligible sync peers yet, waiting for peers to arrive');
      return;
    }

    // A pool that cannot be filled yet is still worth part-filling. Waiting for
    // MIN_SYNC_COMPLETIONS candidates before asking ANY of them sent nothing at
    // all on a small or slowly-arriving fleet, and the answers it declined to
    // collect are exactly the ones that would have been banked by the time the
    // rest of the fleet showed up. The shortfall is asked of whoever joins next.
    if (eligible.length < MIN_SYNC_COMPLETIONS) {
      log.info(`AppSyncOrchestrator - Only ${eligible.length} eligible sync peers (need ${MIN_SYNC_COMPLETIONS}), asking them and topping up as peers arrive`);
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
      const connectionId = peer.connectionId ?? null;
      this.#markSyncRequested(connectionId);
      // The CONNECTION this peer was asked on, carried so a loss announced for
      // a connection this round has already replaced cannot cancel the live
      // request - and so a response arriving on a newer socket is not counted
      // against a request made on the old one.
      this.#peerProgress.set(peer.key, {
        askedAt, lastHeardAt: askedAt, spoken: false, connectionId, done: new Set(), failed: false,
      });
      // round membership wins: this peer's next completion is the round's
      this.#reconnectPulls.delete(peer.key);
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

  // Mechanism B (fluxModels formal/record-convergence): durable records are
  // published once, the boot sync runs at boot, and the degrade resync needs
  // the peer set to collapse below the floor — a re-established connection is
  // the one observable trigger that a RUNNING node may have missed one-shot
  // broadcasts. One scoped apprunning pull per re-establishment (that stream
  // carries the durable types unconditionally), reaching back to the moment
  // the peer was lost less the slack; the responder's per-peer throttle
  // bounds a flapping peer.
  async #onPeerReestablished({ key, lostAtMs }) {
    // ANY state: the node that most needs the pull is one inside a degraded
    // window whose resync round burned against its own side of a partition
    // (1216 run five). The credit is stashed first - repeated losses keep the
    // EARLIEST gap - and drained now if nothing gates it.
    const existing = this.#pendingReconnectPulls.get(key);
    this.#pendingReconnectPulls.set(key, existing === undefined ? lostAtMs : Math.min(existing, lostAtMs));
    await this.#drainReconnectPulls();
  }

  async #drainReconnectPulls() {
    if (!this.#canSendMessages) return;
    for (const [key, lostAtMs] of [...this.#pendingReconnectPulls]) {
      // A peer the active round is asking at since=0 is covered outright.
      if (this.#peerProgress.has(key)) {
        this.#pendingReconnectPulls.delete(key);
        continue;
      }
      // Addressed BY KEY, never filtered by sync candidacy: a fresh inbound
      // accept has no reported uptime at add() time, so an eligibility lookup
      // misses the very peer the event names (outbound redials pulled,
      // inbound accepts never did - the second 1216 gate red). A peer gone
      // right now keeps its credit: its return re-fires the event.
      const peer = this.#getPeerByKey(key);
      if (!peer) continue;
      const sinceTs = Math.max(0, lostAtMs - RECONNECT_SYNC_SLACK_MS);
      // eslint-disable-next-line no-await-in-loop
      const pubkey = await fluxNetworkHelper.getFluxNodePublicKey();
      // eslint-disable-next-line no-await-in-loop
      const privkey = await fluxNetworkHelper.getFluxNodePrivateKey();
      const requestTs = Date.now();
      const msg = peerCodec.buildSyncSignatureMessage(peerCodec.MSG_TYPE.REQUEST_APP_RUNNING, sinceTs, requestTs);
      const sig = verificationHelper.signMessage(msg, privkey);
      this.#pendingReconnectPulls.delete(key);
      this.#reconnectPulls.set(key, lostAtMs);
      this.#markSyncRequested(key);
      this.#sendRequests([peer], 'apprunning (reconnect)', peerCodec.encodeRequestAppRunning(sinceTs, requestTs, pubkey, sig));
      fluxEventBus.publish('ephemeralSync:reconnectRequested', { peer: key, sinceTimestamp: sinceTs });
    }
  }

  #enterDegraded() {
    this.#setState(STATES.DEGRADED);
    this.#hashSyncComplete = false;
    this.#dbRebuilt = false;
    globalState.dbReady = false;
    this.#resetSyncState();
    log.warn('AppSyncOrchestrator - Degraded, pausing spawner');
  }

  #resetSyncState() {
    this.#askedPeers.clear();
    this.#peerProgress.clear();
    this.#clearSyncRequested();
    // The block timer is EPOCH state: it backstops the sync that is starting,
    // and one carried over from before the degrade is already expired — which
    // would promote the recovery straight to READY without a sync running.
    this.#blocksSinceSyncStarted = 0;
    this.#syncCompletions = freshSyncCompletions();
    this.#manifestSyncComplete = false;
    this.#stateSyncComplete = false;
    this.#publishStateSyncAuthority();
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
    let advanced = false;
    if (!this.#explorerSynced) {
      this.#explorerSynced = true;
      log.info(`AppSyncOrchestrator - Explorer synced at block ${blockHeight}`);
      if (this.#state === STATES.INITIALIZING) {
        this.#own(this.#evaluate());
        this.#own(this.#advanceSync());
        advanced = true;
      }
    }
    if (this.#state === STATES.SYNCING || this.#state === STATES.READY || this.#state === STATES.RESYNCING) {
      this.#blocksSinceSyncStarted += count;
      this.#superviseStateSync();
      this.#own(this.#evaluate());
      this.#own(this.#checkHashRetry(blockHeight));
      this.#own(this.#checkManifestRefresh(blockHeight));
      this.#own(this.#checkIngressRefresh(blockHeight));
      // A permanent-plane step that has not latched gets another go on the next
      // block. Its own wake-ups are edges — peers crossing the threshold, peers
      // becoming askable — and a round that reached peers and simply got no index
      // back consumes one without changing anything, so there may be no further
      // edge to wait for. Readiness is 250 blocks away, and the steady-state
      // refresh cannot help because it only runs once READY, which is the state
      // this node cannot reach. Retrying per block bounds that stall to one block
      // instead of hours; the rounds themselves are cheap and idempotent, and a
      // step that has latched is skipped.
      if (!advanced
        && (this.#state === STATES.SYNCING || this.#state === STATES.RESYNCING)
        && (!this.#hashSyncComplete || !this.#manifestSyncComplete)) {
        this.#own(this.#advanceSync());
      }
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
      this.#own(this.#evaluate());
      return;
    }
    log.info('AppSyncOrchestrator - Sync started');
    if (!this.#hashSyncComplete) {
      await this.#checkVersionUpgrade();
      await this.#runHashSync();
    }
    await this.#runManifestSync();
    // Best-effort, never gates readiness — attribution metadata, not operational state.
    await this.#runIngressSync();
    this.#own(this.#evaluate());
  }

  async #checkVersionUpgrade() {
    if (!this.#fluxVersion) return;
    try {
      const marker = await nodeStartupRepository.getHashSyncVersionMarker();
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
      await nodeStartupRepository.setHashSyncVersionMarker(this.#fluxVersion);
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
          this.#own(this.#runHashSync().then(() => this.#evaluate()));
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
      const result = await contentManifestSyncService.reconcile(peers, {
        // The round selects its peers up front but can send seconds later, by which time a
        // socket may be closed or replaced by a reconnect on the same address. Re-resolving
        // by key is how the reconnect pull already addresses a peer at the moment it uses it.
        resolvePeer: (key, captured) => this.#getPeerByKey(key) ?? captured,
      });
      // Latch complete only on evidence the register was actually compared against a peer
      // (>=1 index received) AND that the gap the comparison found was closed. A vacuous
      // round — no eligible peers, a single-flight collision, a silent index timeout — has
      // asked nobody; a round that identified manifests and fetched none of them has asked
      // and failed. Both must stay incomplete so a later wake-up retries: the per-block
      // retry skips a step already marked complete, so latching either one leaves the
      // steady-state refresh a full period away as the only remaining attempt, with the
      // node live and serving content it already knows has been superseded.
      const outstanding = result.requested ?? 0;
      if (result.indexesReceived >= 1 && result.fetched >= outstanding) {
        this.#manifestSyncComplete = true;
        log.info(`AppSyncOrchestrator - Manifest reconcile complete (peers=${result.peers}, indexes=${result.indexesReceived}, fetched=${result.fetched ?? 0})`);
        fluxEventBus.publish('content:manifestSyncComplete', result);
      } else if (result.indexesReceived >= 1) {
        // Named, not counted: an operator asking why a node is holding needs to know which
        // apps it is behind on, and a count cannot answer that.
        const behind = (result.remaining ?? []).join(', ') || 'unknown';
        log.warn(`AppSyncOrchestrator - Manifest reconcile fetched ${result.fetched} of ${outstanding} (still behind on ${behind}), will retry`);
      } else {
        log.info(`AppSyncOrchestrator - Manifest reconcile made no peer contact (peers=${result.peers}), will retry`);
      }
    } catch (error) {
      log.error(`AppSyncOrchestrator - Manifest reconcile failed: ${error.message}`);
      // Leave incomplete; the block timer releases readiness, gossip + per-app catch-up backfill.
    }
  }

  // Backfill ingress attestations missed while offline. Best-effort and never gates
  // readiness; steady-state catch-up rides the manifest refresh cadence below.
  async #runIngressSync() {
    if (this.#ingressSyncComplete) return;
    if (!this.#canSendMessages) return;
    try {
      const peers = this.#getEligibleSyncPeers(MIN_UPTIME_SECONDS);
      const result = await ingressAttestationSyncService.reconcile(peers);
      if (result.indexesReceived >= 1) {
        this.#ingressSyncComplete = true;
        log.info(`AppSyncOrchestrator - Ingress attestation reconcile complete (peers=${result.peers}, indexes=${result.indexesReceived}, fetched=${result.fetched ?? 0})`);
      }
    } catch (error) {
      log.error(`AppSyncOrchestrator - Ingress attestation reconcile failed: ${error.message}`);
    }
  }

  // ONE NUMBER, and it is not a preference. FALLBACK_MINUTES is the lifetime of
  // a running-app location record, so it is the point at which every holder has
  // had to announce itself at least once: wait it out and what this node holds
  // is a full view, whether or not a sync ever completed.
  //
  // It was 125 hardcoded, times a hardcoded 2 - the same 250 blocks whatever
  // config said, so appSyncFallbackMinutes had no reader at all and the harness
  // set it to 5 and to 0 and was ignored both times.
  //
  // There used to be a second, shorter value for enterprise nodes, halved in the
  // manner of the spawner's enterprise deferrals. Those are a PRIORITY - how
  // long before a node may compete for an app - and halving one grants an
  // advantage. This is not that: it is how long before a node assumes it knows
  // what the network looks like, and there is no advantage in assuming it
  // sooner. A node can be given priority; it cannot be given information it has
  // not received.
  #isBlockTimerExpired() {
    return this.#blocksSinceSyncStarted >= FALLBACK_MINUTES * BLOCKS_PER_MINUTE;
  }

  /**
   * Mirror the state-sync verdict where the SYNC RESPONDER can read it.
   *
   * Called wherever an input to #isStateSyncReady moves, so the value never
   * disagrees with the rule. A peer asking this node for app state gets a
   * refusal while it is false, because an empty answer from a node that does
   * not yet know is indistinguishable from an empty answer from a node that
   * does - and the asker counts both as a completed survey.
   *
   * globalState.appStateAuthoritative had two readers in
   * fluxCommunicationMessagesSender and NO writer, so it sat at its initial
   * false for the life of the process and every node refused every ephemeral
   * state-sync request it was ever asked.
   * @returns {void}
   */
  #publishStateSyncAuthority() {
    globalState.appStateAuthoritative = this.#isStateSyncReady();
  }

  #isStateSyncReady() {
    if (this.#stateSyncComplete) return true;
    return this.#isBlockTimerExpired();
  }

  // The state is a pure function of the LEVELS; events only update a level and
  // call #evaluate(). Entry actions run on the transition. The table:
  //
  // | levels                                                   | state             |
  // |----------------------------------------------------------|-------------------|
  // | chain feed never seen                                     | INITIALIZING      |
  // | floor attained this sync epoch, now below it              | DEGRADED          |
  // | DEGRADED and the floor re-attained                        | RESYNCING (new epoch) |
  // | READY and the message capability lost                     | SYNCING           |
  // | below floor, never attained this epoch, timer not expired | SYNCING/RESYNCING (hold) |
  // | below floor, never attained this epoch, timer expired     | READY (lone-node backstop) |
  // | at floor, readiness levels incomplete                     | SYNCING/RESYNCING (hold) |
  // | at floor, readiness levels met (or timer-backstopped)     | READY             |
  //
  // "Floor attained this epoch, now lost" outranks everything below it: losing
  // a network you had is an incident; never finding one is a startup condition
  // the timer may release.
  async #evaluate() {
    if (this.#evaluating) {
      this.#reevaluate = true;
      return;
    }
    this.#evaluating = true;
    try {
      do {
        this.#reevaluate = false;
        // eslint-disable-next-line no-await-in-loop
        await this.#evaluateOnce();
      } while (this.#reevaluate);
    } catch (error) {
      log.error(`AppSyncOrchestrator - evaluate failed: ${error.message}`);
    } finally {
      this.#evaluating = false;
    }
  }

  async #evaluateOnce() {
    // INITIALIZING holds until the chain feed proves itself; the first block
    // starts the first sync epoch.
    if (!this.#explorerSynced) return;
    if (this.#state === STATES.INITIALIZING) {
      this.#setState(STATES.SYNCING);
    }

    // An attained-then-lost floor is an incident, whatever the machine was doing.
    if (this.#floorAttainedThisEpoch && !this.#peersAtFloor) {
      if (this.#state !== STATES.DEGRADED) this.#enterDegraded();
      return;
    }

    // DEGRADED leaves only by re-attaining the floor - a new sync epoch.
    if (this.#state === STATES.DEGRADED) {
      if (!this.#peersAtFloor) return;
      this.#setState(STATES.RESYNCING);
      this.#floorAttainedThisEpoch = true;
      log.info('AppSyncOrchestrator - Peers recovered, resyncing');
    }

    // READY holds only while its levels hold.
    if (this.#state === STATES.READY) {
      if (!this.#canSendMessages) {
        this.#setState(STATES.SYNCING);
        log.warn('AppSyncOrchestrator - Readiness lost (message capability), pausing spawner');
      }
      return;
    }

    await this.#tryPromoteReady();
  }

  async #tryPromoteReady() {
    if (this.#state !== STATES.SYNCING && this.#state !== STATES.RESYNCING) return;

    const blockTimerExpired = this.#isBlockTimerExpired();
    // The timer is the other input to the rule: once it has expired this node
    // answers from what it has rather than refusing forever.
    this.#publishStateSyncAuthority();
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
    // First steady-state refresh one period out — boot/recovery just reconciled, so there is
    // nothing to re-check immediately.
    this.#nextManifestRefreshHeight = this.#lastBlockHeight + MANIFEST_REFRESH_BLOCKS;
    this.#nextIngressRefreshHeight = this.#lastBlockHeight + INGRESS_REFRESH_BLOCKS;
    log.info('AppSyncOrchestrator - All readiness conditions met');
  }

  // Steady-state anti-entropy for the permanent content-manifest register. Change-only
  // gossip misses a node cut off by a partial partition (one that stays above the degrade
  // floor, so it never resyncs), and the boot/recovery reconcile only fires on (re)join —
  // so a READY node can silently serve stale content indefinitely. A low-frequency pull
  // against a few random peers bounds that to one refresh period: reconcile the register
  // (fetch any newer manifest), then catch up the running containers whose register advanced.
  async #checkManifestRefresh(blockHeight) {
    if (this.#state !== STATES.READY) return;
    if (!this.#canSendMessages) return;
    if (this.#manifestRefreshInProgress) return;
    if (blockHeight < this.#nextManifestRefreshHeight) return;
    this.#nextManifestRefreshHeight = blockHeight + MANIFEST_REFRESH_BLOCKS;

    // The refresh's own (token) uptime floor, NOT the boot sync's anti-flap gate —
    // see MANIFEST_REFRESH_MIN_PEER_UPTIME_SECONDS.
    const eligible = this.#getEligibleSyncPeers(MANIFEST_REFRESH_MIN_PEER_UPTIME_SECONDS);
    if (eligible.length === 0) return;
    const sample = this.#samplePeers(eligible, MANIFEST_REFRESH_PEERS);

    this.#manifestRefreshInProgress = true;
    try {
      const result = await contentManifestSyncService.reconcile(sample);
      if (result.fetched > 0) {
        log.info(`AppSyncOrchestrator - Manifest refresh pulled ${result.fetched} update(s) from ${result.peers} peer(s)`);
      }
      await this.#catchUpRunningContent();
    } catch (error) {
      log.error(`AppSyncOrchestrator - Manifest refresh failed: ${error.message}`);
    } finally {
      this.#manifestRefreshInProgress = false;
    }
  }

  // Steady-state ingress-attestation anti-entropy on its own slower cadence — a permanent
  // off-chain set like the manifest, best-effort and never readiness-gating.
  async #checkIngressRefresh(blockHeight) {
    if (this.#state !== STATES.READY) return;
    if (!this.#canSendMessages) return;
    if (this.#ingressRefreshInProgress) return;
    if (blockHeight < this.#nextIngressRefreshHeight) return;
    this.#nextIngressRefreshHeight = blockHeight + INGRESS_REFRESH_BLOCKS;

    const eligible = this.#getEligibleSyncPeers(MANIFEST_REFRESH_MIN_PEER_UPTIME_SECONDS);
    if (eligible.length === 0) return;
    const sample = this.#samplePeers(eligible, MANIFEST_REFRESH_PEERS);

    this.#ingressRefreshInProgress = true;
    try {
      const result = await ingressAttestationSyncService.reconcile(sample);
      if (result.fetched > 0) {
        log.info(`AppSyncOrchestrator - Ingress attestation refresh pulled ${result.fetched} record(s) from ${result.peers} peer(s)`);
      }
    } catch (error) {
      log.error(`AppSyncOrchestrator - Ingress attestation refresh failed: ${error.message}`);
    } finally {
      this.#ingressRefreshInProgress = false;
    }
  }

  // A small random subset: steady-state convergence needs only a few peers (any few will
  // almost surely carry an update the rest of the network already has), and random spreads
  // the tiny load rather than always hitting the same peers.
  #samplePeers(peers, n) {
    if (peers.length <= n) return peers;
    const pool = [...peers];
    const picked = [];
    for (let i = 0; i < n; i += 1) {
      const idx = Math.floor(Math.random() * pool.length);
      picked.push(pool.splice(idx, 1)[0]);
    }
    return picked;
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
      this.#own(this.#advanceSync());
      // Reconnect credits stashed while incapable are spent now - the heal's
      // reconnection wave lands while the healed side's chain is still
      // catching up, before capability returns.
      this.#drainReconnectPulls().catch((error) => {
        log.error(`AppSyncOrchestrator - reconnect pull drain failed: ${error.message}`);
      });
    } else {
      log.info('AppSyncOrchestrator - Message capability lost');
      this.#own(this.#evaluate());
    }
  }

  async #startAppRunningBroadcast() {
    if (this.#broadcastStarted) return;
    this.#broadcastStarted = true;
    log.info('AppSyncOrchestrator - App running broadcast started');
    await globalState.waitForBootContainerStateSettled();
    // startBroadcasting, not one bare broadcast: it sets peerNotification's
    // `broadcasting` flag, which is what arms the recurring cycle and what the
    // message-capability-regained handler checks before re-triggering.
    peerNotification.startBroadcasting();
  }

  get bootContext() {
    return this.#bootContext;
  }

  set bootContext(ctx) {
    this.#bootContext = ctx;
  }

  static async readBootContext() {
    try {
      const heartbeat = await nodeStartupRepository.getHeartbeat();

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
      await nodeStartupRepository.clearShutdownReason();
    } catch (error) {
      log.error(`Failed to clear shutdown reason: ${error.message}`);
    }
  }

  #startHeartbeat() {
    const writeHeartbeat = async () => {
      try {
        await nodeStartupRepository.writeHeartbeat({
          lastAlive: Date.now(),
          machineBootId: this.#bootContext?.currentBootId,
        });
      } catch (error) {
        log.error(`Heartbeat write failed: ${error.message}`);
      }
    };
    this.#own(this.#clearShutdownReason());
    writeHeartbeat();
    this.#heartbeatInterval = setInterval(writeHeartbeat, config.system.heartbeatIntervalMs ?? 30000);
  }

  static async writeShutdownReason(reason) {
    try {
      await nodeStartupRepository.setShutdownReason(reason);
    } catch (error) {
      log.error(`Failed to write shutdown reason: ${error.message}`);
    }
  }

  async stop() {
    this.#started = false;
    // A stopped orchestrator is not authoritative about anything. Left true, a
    // node mid-shutdown goes on answering surveys from a view it is no longer
    // maintaining.
    globalState.appStateAuthoritative = false;
    if (this.#heartbeatInterval) {
      clearInterval(this.#heartbeatInterval);
      this.#heartbeatInterval = null;
    }
    if (this.#ephemeralSyncHandler) {
      appSyncEvents.removeListener(EVENTS.EPHEMERAL_SYNC_COMPLETE, this.#ephemeralSyncHandler);
      appSyncEvents.removeListener(EVENTS.EPHEMERAL_SYNC_REFUSED, this.#ephemeralRefusedHandler);
      appSyncEvents.removeListener(EVENTS.EPHEMERAL_SYNC_UNVERIFIED, this.#ephemeralUnverifiedHandler);
      appSyncEvents.removeListener(EVENTS.EPHEMERAL_SYNC_PROGRESS, this.#ephemeralProgressHandler);
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
    if (this.#peerDisconnectedHandler) {
      this.#offPeerEvent('peerDisconnected', this.#peerDisconnectedHandler);
    }
    if (this.#peerConnectedHandler) {
      this.#offPeerEvent('peerConnected', this.#peerConnectedHandler);
    }
    if (this.#syncPeersAvailableHandler) {
      this.#offPeerEvent('syncPeersAvailable', this.#syncPeersAvailableHandler);
    }
    if (this.#peerReestablishedHandler) {
      this.#offPeerEvent('peerReestablished', this.#peerReestablishedHandler);
    }
    await peerNotification.stopBroadcasting();
    this.#broadcastStarted = null;
    if (this.#hashSyncRetryTimer) {
      clearTimeout(this.#hashSyncRetryTimer);
      this.#hashSyncRetryTimer = null;
    }
  }
}

module.exports = { AppSyncOrchestrator, STATES };
