'use strict';

const config = require('config');
const serviceHelper = require('../serviceHelper');
const appRecords = require('../appDatabase/appRecords');
const { serialiseAndSignFluxBroadcast } = require('../utils/fluxBroadcastHelper');
const fluxEventBus = require('../utils/fluxEventBus');
const { getSpec } = require('../utils/specLibs');

// The content manifests a node holds are a permanent store reconciled OFF the
// ephemeral boot-sync plane. A returning node converges its store to the network's
// via a two-step in-band exchange (the permanent-message discipline: request only the
// missing, never re-pull everything), peer-sourced since the manifest has no on-chain
// anchor:
//   1. INDEX  — ask peers for the rank of the manifest each app stands on, as
//               (identity, version, ownedFrom) (cheap, no bodies), union it by rank,
//               and compute which apps are missing or behind locally.
//   2. FETCH  — pull only those bodies, one peer at a time, re-checking the gap after
//               each so every body is fetched once from the first peer that has it
//               (fan-out for freshness on the cheap index, single-copy on the bodies).
// Bodies land via the shared fluxappcontentmanifestsync receive path
// (storeBatchContentManifests: each judged and kept). The change-only gossip stays
// the live-update path; this backfills a node that was away.
//
// Rank is the height at which the signer took the app, then the version within
// that ownership (the library's rule), so a buyer's first manifest outranks the
// seller's last. The LOCAL gap view counts every held row, those held for an app not
// yet listed included: on a truly cold node the fetched body races the app-spec sync
// and lands unresolved, but transport is done — it is judged when the row is written,
// and re-fetching from another peer would meet the same missing row. Only the index
// SERVED to peers is of standing manifests.

const INDEX_TIMEOUT_MS = config.get('fluxapps.manifestIndexTimeoutMs');
const FETCH_SETTLE_MS = config.get('fluxapps.manifestFetchSettleMs');

const INDEX_REQUEST = 'fluxappcontentmanifestindexrequest';
const FETCH_REQUEST = 'fluxappcontentmanifestrequest';

// The round in flight, if any. A second caller joins it rather than being turned
// away: the old single-flight returned peers:0, which is indistinguishable from
// "nobody answered", so the caller treated a collision as a vacuous round, left
// its step unlatched, and had nothing to retry it. Joining hands back the real
// outcome of a round that did compare against peers.
let reconcileInFlight = null;
// The round queued behind the one in flight, when a caller mid-round names a peer
// the running round did not ask: every such caller folds its peers in here and
// receives that one follow-up round's outcome. Null when nothing is queued.
let queuedRound = null;
// The in-flight round: the peers we asked (so their index/body responses are accepted)
// and the indexes collected so far. Null between rounds.
let activeRound = null;

/** Whether a peer's manifest-reconcile response is solicited (it's in the live round) —
 *  the counterpart of the orchestrator's isSyncResponseWanted for the two manifest response types. */
function isPeerInActiveRound(peerKey) {
  return !!activeRound && activeRound.peerKeys.has(peerKey);
}

/** Record a peer's (identity, version) index for the live round; resolve the wait once
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

/** The rank an index entry carries: the ownership height, then the version. */
const rankOf = (entry) => ({ ownedFrom: Number(entry.ownedFrom ?? 0), number: Number(entry.version) });

/**
 * The highest rank per app across every peer index.
 * @param {Map<string, object[]>} indexes - peer key -> [{ identity, version, ownedFrom }]
 * @param {(a, b) => boolean} outranks - the library's rank order
 * @returns {Map<string, {version: number, ownedFrom: number}>}
 */
function unionTarget(indexes, outranks) {
  const target = new Map();
  for (const index of indexes.values()) {
    for (const entry of index) {
      if (!entry || !entry.identity || entry.version == null) continue;
      const current = target.get(entry.identity);
      if (current == null || outranks(rankOf(entry), rankOf(current))) {
        target.set(entry.identity, { version: Number(entry.version), ownedFrom: Number(entry.ownedFrom ?? 0) });
      }
    }
  }
  return target;
}

/**
 * The highest rank held locally per app, from every row.
 * @param {Array<{identity: string, version: number, ownedFrom: number}>} rows
 * @param {(a, b) => boolean} outranks
 * @returns {Map<string, {version: number, ownedFrom: number}>}
 */
function localBest(rows, outranks) {
  return unionTarget(new Map([['local', rows]]), outranks);
}

/**
 * Apps the local store is missing or behind on, given the union target.
 * @param {Map<string, object>} target
 * @param {Map<string, object>} local
 * @param {(a, b) => boolean} outranks
 * @returns {string[]}
 */
function computeNeeded(target, local, outranks) {
  const needed = [];
  for (const [identity, best] of target) {
    const have = local.get(identity);
    if (have == null || outranks(rankOf(best), rankOf(have))) needed.push(identity);
  }
  return needed;
}

/**
 * Run one reconcile round against the given peers (objects with `.key` and `.send`).
 * Best-effort and bounded: completes after the index wait + the per-peer fetch settles,
 * so it can gate boot readiness (the spawner waits on the manifest view converging) while
 * still releasing if peers are slow/absent. One round at a time. A round selects its
 * peers when it starts, so a caller arriving mid-round whose peers the round already
 * asked joins it and receives its real outcome, and one naming a peer the round did not
 * ask receives the outcome of a single follow-up round, run after this one with every
 * peer the mid-round callers named: a peer that connected during a round is asked.
 *
 * @param {Array<{key: string, send: Function}>} peers
 * @param {object} deps - { getLocalVersions?, sign?, delay?, now?, indexTimeoutMs?, fetchSettleMs? }
 * @returns {Promise<{peers: number, indexesReceived: number, fetched: number,
 *                    requested: number, remaining: string[]}>}
 */
async function reconcile(peers, deps = {}) {
  const named = Array.isArray(peers) ? peers : [];
  if (reconcileInFlight) {
    const covered = (peer) => activeRound?.peerKeys.has(peer.key) || queuedRound?.peers.has(peer.key);
    if (named.every(covered)) return reconcileInFlight;
    if (!queuedRound) {
      queuedRound = { peers: new Map(), deps };
      reconcileInFlight = reconcileInFlight.then(runQueuedRound, runQueuedRound);
    }
    for (const peer of named) queuedRound.peers.set(peer.key, peer);
    return reconcileInFlight;
  }
  if (named.length === 0) {
    return {
      peers: 0, indexesReceived: 0, fetched: 0, requested: 0, remaining: [],
    };
  }
  reconcileInFlight = runRound(named, deps);
  return reconcileInFlight;
}

function runQueuedRound() {
  const next = queuedRound;
  queuedRound = null;
  return runRound([...next.peers.values()], next.deps);
}

async function runRound(peers, deps) {
  try {
    return await runReconcile(peers, deps);
  } finally {
    if (!queuedRound) reconcileInFlight = null;
  }
}

async function runReconcile(peers, deps = {}) {
  const {
    getLocalRanks = () => appRecords.manifests().ranks(),
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
    const { outranks } = await getSpec();
    const target = unionTarget(activeRound.indexes, outranks);
    let remaining = computeNeeded(target, localBest(await getLocalRanks(), outranks), outranks);
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
      const fetchReq = await sign({ type: FETCH_REQUEST, version: 1, identities: remaining, timestamp: now() });
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
      const after = localBest(await getLocalRanks(), outranks);
      remaining = remaining.filter((identity) => {
        const have = after.get(identity);
        return have == null || outranks(rankOf(target.get(identity)), rankOf(have));
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
  localBest,
  computeNeeded,
};
