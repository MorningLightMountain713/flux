'use strict';

const config = require('config');
const serviceHelper = require('../serviceHelper');
const appsRepository = require('../appDatabase/appsRepository');
const { serialiseAndSignFluxBroadcast } = require('../utils/fluxBroadcastHelper');
const fluxEventBus = require('../utils/fluxEventBus');

// The content manifest is a permanent, latest-wins register reconciled OFF the
// ephemeral boot-sync plane. A returning node converges its register to the network's
// via a two-step in-band exchange (the permanent-message discipline: request only the
// missing, never re-pull everything), peer-sourced since the manifest has no on-chain
// anchor:
//   1. INDEX  — ask peers for their (appName, version) vector (cheap, no bodies),
//               union it, and compute which apps are missing/stale locally.
//   2. FETCH  — pull only those bodies, one peer at a time, re-checking the gap after
//               each so every body is fetched once from the first peer that has it
//               (fan-out for freshness on the cheap index, single-copy on the bodies).
// Bodies land via the shared fluxappcontentmanifestsync receive path
// (storeBatchContentManifests: full owner-sig + spec gate, latest-wins). The change-only
// gossip stays the live-update path; this backfills a node that was away.
//
// The LOCAL gap view counts every held row, quarantined included: on a truly cold node
// the fetched body races the app-spec sync and lands confirmed:false, but transport is
// done — it promotes when the spec confirms, and re-fetching from another peer would
// hit the same local spec gate. Only the index SERVED to peers is confirmed-only.

const INDEX_TIMEOUT_MS = config.fluxapps.manifestIndexTimeoutMs ?? 15000;
const FETCH_SETTLE_MS = config.fluxapps.manifestFetchSettleMs ?? 8000;

const INDEX_REQUEST = 'fluxappcontentmanifestindexrequest';
const FETCH_REQUEST = 'fluxappcontentmanifestrequest';

// The round in flight, if any. A second caller joins it rather than being turned
// away: the old single-flight returned peers:0, which is indistinguishable from
// "nobody answered", so the caller treated a collision as a vacuous round, left
// its step unlatched, and had nothing to retry it. Joining hands back the real
// outcome of a round that did compare against peers.
let reconcileInFlight = null;
// The in-flight round: the peers we asked (so their index/body responses are accepted)
// and the indexes collected so far. Null between rounds.
let activeRound = null;

/** Whether a peer's manifest-reconcile response is solicited (it's in the live round) —
 *  the gate that replaces isSyncRequested for the two manifest response types. */
function isPeerInActiveRound(peerKey) {
  return !!activeRound && activeRound.peerKeys.has(peerKey);
}

/** Record a peer's (appName, version) index for the live round; resolve the wait once
 *  every asked peer has answered (one index per peer; a late/dup is ignored). */
function depositIndex(peerKey, index) {
  if (!activeRound || !activeRound.peerKeys.has(peerKey)) return;
  if (activeRound.indexes.has(peerKey)) return;
  activeRound.indexes.set(peerKey, Array.isArray(index) ? index : []);
  if (activeRound.indexes.size >= activeRound.expected && activeRound.resolveIndexes) {
    activeRound.resolveIndexes();
  }
}

/** A peer has finished answering the body request it was sent — the `done` flag its reply
 *  already carries. The settle delay is the bound for a peer that never says so; without
 *  this the round pays that bound for every peer, however fast the answer came. */
function depositFetchDone(peerKey) {
  if (!activeRound || !activeRound.peerKeys.has(peerKey)) return;
  const resolveFetch = activeRound.fetchWaiters.get(peerKey);
  if (resolveFetch) {
    activeRound.fetchWaiters.delete(peerKey);
    resolveFetch();
  }
}

function unionTarget(indexes) {
  const target = new Map();
  for (const index of indexes.values()) {
    for (const entry of index) {
      if (!entry || !entry.appName || entry.version == null) continue;
      const current = target.get(entry.appName);
      if (current == null || entry.version > current) target.set(entry.appName, entry.version);
    }
  }
  return target;
}

/** Apps the local register is missing or stale on, given the union target. */
function computeNeeded(target, local) {
  const needed = [];
  for (const [appName, version] of target) {
    const have = local.get(appName);
    if (have == null || version > have) needed.push(appName);
  }
  return needed;
}

/**
 * Run one reconcile round against the given peers (objects with `.key` and `.send`).
 * Best-effort and bounded: completes after the index wait + the per-peer fetch settles,
 * so it can gate boot readiness (the spawner waits on the manifest view converging) while
 * still releasing if peers are slow/absent. One round at a time: a caller arriving
 * mid-round joins it and receives that round's real outcome.
 *
 * @param {Array<{key: string, send: Function}>} peers
 * @param {object} deps - { getLocalVersions?, sign?, delay?, now?, indexTimeoutMs?, fetchSettleMs? }
 * @returns {Promise<{peers: number, indexesReceived: number, fetched: number,
 *                    requested: number, remaining: string[]}>}
 */
async function reconcile(peers, deps = {}) {
  if (reconcileInFlight) return reconcileInFlight;
  if (!Array.isArray(peers) || peers.length === 0) {
    return {
      peers: 0, indexesReceived: 0, fetched: 0, requested: 0, remaining: [],
    };
  }

  reconcileInFlight = runReconcile(peers, deps).finally(() => { reconcileInFlight = null; });
  return reconcileInFlight;
}

async function runReconcile(peers, deps = {}) {
  const {
    getLocalVersions = appsRepository.listContentManifestVersions,
    sign = serialiseAndSignFluxBroadcast,
    delay = serviceHelper.delay,
    now = Date.now,
    indexTimeoutMs = INDEX_TIMEOUT_MS,
    fetchSettleMs = FETCH_SETTLE_MS,
    // Identity, not liveness, is what a round can carry: the caller supplies the lookup
    // that turns a key back into whatever socket currently serves that peer, and null when
    // no socket does any more. Defaults to the captured handle, so a caller that has no
    // lookup behaves exactly as before.
    resolvePeer = (key, captured) => captured,
  } = deps;

  try {
    let resolveIndexes;
    const indexesReady = new Promise((resolve) => { resolveIndexes = resolve; });
    activeRound = {
      peerKeys: new Set(peers.map((peer) => peer.key)),
      indexes: new Map(),
      fetchWaiters: new Map(),
      expected: peers.length,
      resolveIndexes,
    };

    // Step 1 — request every peer's index. A fresh timestamp keeps the request out of the
    // gossip dedup cache so a later round is not silently dropped.
    const indexReq = await sign({ type: INDEX_REQUEST, version: 1, timestamp: now() });
    for (const peer of peers) {
      try { peer.send(indexReq); } catch (error) { /* a dead peer just doesn't answer */ }
    }
    await Promise.race([indexesReady, delay(indexTimeoutMs)]);

    const indexesReceived = activeRound.indexes.size;
    const target = unionTarget(activeRound.indexes);
    const localList = await getLocalVersions();
    const local = new Map(localList.map((row) => [row.appName, row.version]));
    let remaining = computeNeeded(target, local);
    const neededCount = remaining.length;

    // Step 2 — fetch the bodies, one peer at a time, re-checking the gap from the store
    // after each so every body is pulled once (the next peer only sees what's still missing).
    // Only peers that answered the index: silence tells us nothing about what a peer holds,
    // and asking anyway costs a full settle window per peer for an answer it never claimed
    // it could give (the ingress-attestation round skips them the same way).
    for (const peer of peers) {
      if (remaining.length === 0) break;
      if (!activeRound.indexes.has(peer.key)) continue;
      // Re-resolved at the moment of sending. The peer object was captured when the round
      // selected it, and a socket that has closed since — or been replaced by a reconnect
      // on the same address — cannot be detected through that handle. send() reports a
      // dead socket by returning false and never throws, so the boolean is the liveness
      // signal; a peer we cannot reach must not buy a settle window.
      const live = resolvePeer(peer.key, peer);
      if (!live) continue;
      // eslint-disable-next-line no-await-in-loop
      const fetchReq = await sign({ type: FETCH_REQUEST, version: 1, appNames: remaining, timestamp: now() });
      // Armed BEFORE the send: the answer can land before the sending call has even
      // returned, and a waiter registered afterwards would miss it and then wait out the
      // full settle for a peer that had already finished.
      const peerDone = new Promise((resolve) => { activeRound.fetchWaiters.set(peer.key, resolve); });
      let sent = false;
      try { sent = live.send(fetchReq) !== false; } catch (error) { sent = false; }
      if (!sent) { activeRound.fetchWaiters.delete(peer.key); continue; }
      // The settle delay is the bound for a peer that never reports done, not the pace.
      // eslint-disable-next-line no-await-in-loop
      await Promise.race([peerDone, delay(fetchSettleMs)]);
      activeRound.fetchWaiters.delete(peer.key);
      // eslint-disable-next-line no-await-in-loop
      const after = new Map((await getLocalVersions()).map((row) => [row.appName, row.version]));
      remaining = remaining.filter((appName) => {
        const have = after.get(appName);
        return have == null || target.get(appName) > have;
      });
    }

    const fetched = neededCount - remaining.length;
    // peers/indexesReceived ride the event, not just the return value: without them
    // "asked nobody, heard nothing" and "compared against peers, already current" are the
    // same {requested: 0, fetched: 0}. The boot path already refuses to latch on a round
    // with no indexes for exactly that reason, so any observer of a round needs the same
    // datum to tell a converged node from one that reconciled against silence.
    fluxEventBus.publish('content:manifestReconciled', {
      requested: neededCount, fetched, peers: peers.length, indexesReceived,
    });
    // `requested` rides the RETURN as well as the event: the caller decides from this
    // whether its catch-up step is finished, and without the gap it set out to close
    // "asked for one and got nothing" is indistinguishable from "asked for nothing because
    // I was already current". `remaining` names the apps still owed, so a node that is
    // behind can say which apps rather than only that it is.
    return {
      peers: peers.length, indexesReceived, fetched, requested: neededCount, remaining,
    };
  } finally {
    activeRound = null;
  }
}

module.exports = {
  reconcile,
  depositIndex,
  depositFetchDone,
  isPeerInActiveRound,
  // exposed for tests
  unionTarget,
  computeNeeded,
};
