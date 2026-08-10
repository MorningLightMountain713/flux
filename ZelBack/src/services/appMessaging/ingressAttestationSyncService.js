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

const DIGEST_TIMEOUT_MS = config.fluxapps.ingressIndexTimeoutMs ?? 15000;
const FETCH_SETTLE_MS = config.fluxapps.ingressFetchSettleMs ?? 8000;

const DIGEST_REQUEST = 'fluxappingressindexrequest';
const FETCH_REQUEST = 'fluxappingressrequest';

let reconcileRunning = false;
// The in-flight round: the peers we asked (so their responses are accepted) and the bucket
// digests collected so far. Null between rounds.
let activeRound = null;

/** Whether a peer's ingress-reconcile response is solicited (it's in the live round) —
 *  the gate that replaces isSyncRequested for the two ingress response types. */
function isPeerInActiveRound(peerKey) {
  return !!activeRound && activeRound.peerKeys.has(peerKey);
}

/** Record a peer's bucket digests for the live round; resolve the wait once every asked
 *  peer has answered (one vector per peer; a late/dup is ignored). */
function depositDigests(peerKey, digests) {
  if (!activeRound || !activeRound.peerKeys.has(peerKey)) return;
  if (activeRound.digests.has(peerKey)) return;
  activeRound.digests.set(peerKey, Array.isArray(digests) ? digests : []);
  if (activeRound.digests.size >= activeRound.expected && activeRound.resolveDigests) {
    activeRound.resolveDigests();
  }
}

/**
 * Run one reconcile round against the given peers (objects with `.key` and `.send`).
 * Best-effort, bounded, single-flight. Never gates node readiness — attestations are
 * investigative metadata, not operational state.
 *
 * @param {Array<{key: string, send: Function}>} peers
 * @param {object} deps - { getLocalDigests?, sign?, delay?, now?, digestTimeoutMs?, fetchSettleMs? }
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
  } = deps;

  reconcileRunning = true;
  try {
    let resolveDigests;
    const digestsReady = new Promise((resolve) => { resolveDigests = resolve; });
    activeRound = {
      peerKeys: new Set(peers.map((peer) => peer.key)),
      digests: new Map(),
      expected: peers.length,
      resolveDigests,
    };

    // Step 1 — request every peer's K bucket digests. A fresh timestamp keeps the request
    // out of the gossip dedup cache so a later round is not silently dropped.
    const digestReq = await sign({ type: DIGEST_REQUEST, version: 1, timestamp: now() });
    for (const peer of peers) {
      try { peer.send(digestReq); } catch (error) { /* a dead peer just doesn't answer */ }
    }
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
      try { peer.send(fetchReq); } catch (error) { continue; }
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
  isPeerInActiveRound,
};
