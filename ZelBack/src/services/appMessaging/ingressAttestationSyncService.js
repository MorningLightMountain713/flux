'use strict';

const config = require('config');
const serviceHelper = require('../serviceHelper');
const appsRepository = require('../appDatabase/appsRepository');
const setReconciler = require('./setReconciler');
const { serialiseAndSignFluxBroadcast } = require('../utils/fluxBroadcastHelper');

// Ingress attestations are a permanent, append-only set keyed by (hash, node) — where a
// register/update entered the network. Live gossip (emit/receive) reaches online nodes;
// this backfills a node that was away, via the shared bucketed-digest anti-entropy
// (setReconciler): exchange K fixed bucket digests, fetch only the buckets that differ,
// and union the records in. A converged pair matches on every digest and fetches nothing.
// Merge is set-union — records are immutable, so any (hash, node) a peer has that we lack
// is pulled and stored (each verified by its own node signature in the receive path). No
// rebroadcast — this is a targeted backfill.

const DIGEST_TIMEOUT_MS = config.get('fluxapps.ingressIndexTimeoutMs');
const FETCH_SETTLE_MS = config.get('fluxapps.ingressFetchSettleMs');

const DIGEST_REQUEST = 'fluxappingressindexrequest';
const FETCH_REQUEST = 'fluxappingressrequest';

let reconcileRunning = false;
// The in-flight round: the peers we asked (so their responses are accepted) and the bucket
// digests collected so far. Null between rounds.
let activeRound = null;

/** Whether a peer's ingress-reconcile response is solicited (it's in the live round) —
 *  the counterpart of the orchestrator's isSyncResponseWanted for the two ingress response types. */
function isPeerInActiveRound(peerKey) {
  return !!activeRound && activeRound.peerKeys.has(peerKey);
}

/** The digest wait ends when every asked peer has answered or cannot: a peer the request
 *  never reached, or whose connection ended with the ask outstanding, is not waited for. */
function settleDigestWait() {
  if (!activeRound || !activeRound.resolveDigests) return;
  if (activeRound.digests.size + activeRound.unreached.size < activeRound.expected) return;
  activeRound.resolveDigests();
}

/** Record a peer's bucket digests for the live round; resolve the wait once every asked
 *  peer has answered (one vector per peer; a late/dup is ignored). */
function depositDigests(peerKey, digests) {
  if (!activeRound || !activeRound.peerKeys.has(peerKey)) return;
  if (activeRound.digests.has(peerKey)) return;
  activeRound.digests.set(peerKey, Array.isArray(digests) ? digests : []);
  activeRound.unreached.delete(peerKey);
  settleDigestWait();
}

/**
 * A connection to a peer in the live round has ended. An ask written into it is dead and
 * its answer, if one was on the way, died with it. A crossing closed the pair's losing
 * socket and the peer is still connected over the kept one, so the ask is sent again
 * there; any other ending makes the peer one the round cannot hear from. A connection the
 * round did not ask on says nothing about it.
 *
 * @param {string} peerKey ip:port of the peer
 * @param {{connectionId?: number|null, crossing?: boolean}} [ending]
 */
function peerConnectionEnded(peerKey, { connectionId = null, crossing = false } = {}) {
  if (!activeRound || !activeRound.peerKeys.has(peerKey)) return;
  const asked = activeRound.channels.get(peerKey);
  if (connectionId !== null && asked != null && asked !== connectionId) return;
  if (activeRound.digests.has(peerKey) || activeRound.unreached.has(peerKey)) return;
  if (crossing && activeRound.digestReq) {
    const kept = activeRound.resolvePeer(peerKey, null);
    if (kept && sendTo(kept, activeRound.digestReq)) {
      activeRound.channels.set(peerKey, kept.connectionId ?? null);
      return;
    }
  }
  activeRound.unreached.add(peerKey);
  settleDigestWait();
}

/** Whether a message reached the socket: send() reports a dead socket by returning false
 *  and never throws, so the boolean is the only liveness signal a round gets. */
function sendTo(peer, message) {
  try { return peer.send(message) !== false; } catch (error) { return false; }
}

/**
 * Run one reconcile round against the given peers (objects with `.key` and `.send`).
 * Best-effort, bounded, single-flight. Never gates node readiness — attestations are
 * investigative metadata, not operational state.
 *
 * @param {Array<{key: string, send: Function}>} peers
 * @param {object} deps - { getLocalDigests?, sign?, delay?, now?, digestTimeoutMs?, fetchSettleMs?, resolvePeer? }
 * @returns {Promise<{peers: number, indexesReceived: number, fetched: number}>}
 */
async function reconcile(peers, deps = {}) {
  if (reconcileRunning) return { peers: 0, indexesReceived: 0, fetched: 0, skipped: true };
  if (!Array.isArray(peers) || peers.length === 0) return { peers: 0, indexesReceived: 0, fetched: 0 };

  const {
    getLocalDigests = appsRepository.listIngressAttestationDigests,
    sign = serialiseAndSignFluxBroadcast,
    delay = serviceHelper.delay,
    now = Date.now,
    digestTimeoutMs = DIGEST_TIMEOUT_MS,
    fetchSettleMs = FETCH_SETTLE_MS,
    // Identity, not liveness, is what a round can carry: the caller supplies the lookup
    // that turns a key back into whatever socket currently serves that peer, and null when
    // no socket does any more. Defaults to the captured handle.
    resolvePeer = (key, captured) => captured,
  } = deps;

  reconcileRunning = true;
  try {
    let resolveDigests;
    const digestsReady = new Promise((resolve) => { resolveDigests = resolve; });
    activeRound = {
      peerKeys: new Set(peers.map((peer) => peer.key)),
      digests: new Map(),
      // The peers the ask did not reach, or whose connection ended with it outstanding.
      unreached: new Set(),
      // The connection each ask went out on, so an ending names the ask it kills.
      channels: new Map(),
      expected: peers.length,
      resolveDigests,
      resolvePeer,
      digestReq: null,
    };

    // Step 1 — request every peer's K bucket digests. A fresh timestamp keeps the request
    // out of the gossip dedup cache so a later round is not silently dropped. Each peer is
    // resolved by key at the moment of sending: the handle was captured when the peer was
    // selected, and a socket replaced or closed since cannot be told from it. A peer the
    // ask does not reach is not waited for.
    const digestReq = await sign({ type: DIGEST_REQUEST, version: 1, timestamp: now() });
    activeRound.digestReq = digestReq;
    for (const peer of peers) {
      const live = resolvePeer(peer.key, peer);
      if (live && sendTo(live, digestReq)) {
        activeRound.channels.set(peer.key, live.connectionId ?? null);
      } else {
        activeRound.unreached.add(peer.key);
      }
    }
    settleDigestWait();
    await Promise.race([digestsReady, delay(digestTimeoutMs)]);

    const digestsReceived = activeRound.digests.size;
    let localDigests = await getLocalDigests();
    let bucketsResolved = 0;

    // Step 2 — per peer, fetch the buckets whose digests differ, re-checking the local
    // digests after each so the next peer is only asked for what is still divergent.
    for (const peer of peers) {
      const peerDigests = activeRound.digests.get(peer.key);
      if (!peerDigests) continue;
      const diff = setReconciler.differingBuckets(localDigests, peerDigests);
      if (diff.length === 0) continue;
      // eslint-disable-next-line no-await-in-loop
      const fetchReq = await sign({ type: FETCH_REQUEST, version: 1, buckets: diff, timestamp: now() });
      // Re-resolved at the moment of sending; a peer the request cannot reach must not buy
      // a settle window.
      const live = resolvePeer(peer.key, peer);
      if (!live || !sendTo(live, fetchReq)) continue;
      // eslint-disable-next-line no-await-in-loop
      await delay(fetchSettleMs);
      // eslint-disable-next-line no-await-in-loop
      const updated = await getLocalDigests();
      bucketsResolved += diff.length - setReconciler.differingBuckets(updated, peerDigests).length;
      localDigests = updated;
    }

    return { peers: peers.length, indexesReceived: digestsReceived, fetched: bucketsResolved };
  } finally {
    activeRound = null;
    reconcileRunning = false;
  }
}

module.exports = {
  reconcile,
  depositDigests,
  peerConnectionEnded,
  isPeerInActiveRound,
};
