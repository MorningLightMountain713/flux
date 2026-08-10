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

let reconcileRunning = false;
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
 * still releasing if peers are slow/absent. Single-flight.
 *
 * @param {Array<{key: string, send: Function}>} peers
 * @param {object} deps - { getLocalVersions?, sign?, delay?, now?, indexTimeoutMs?, fetchSettleMs? }
 * @returns {Promise<{peers: number, indexesReceived: number, fetched: number}>}
 */
async function reconcile(peers, deps = {}) {
  if (reconcileRunning) return { peers: 0, indexesReceived: 0, fetched: 0, skipped: true };
  if (!Array.isArray(peers) || peers.length === 0) return { peers: 0, indexesReceived: 0, fetched: 0 };

  const {
    getLocalVersions = appsRepository.listContentManifestVersions,
    sign = serialiseAndSignFluxBroadcast,
    delay = serviceHelper.delay,
    now = Date.now,
    indexTimeoutMs = INDEX_TIMEOUT_MS,
    fetchSettleMs = FETCH_SETTLE_MS,
  } = deps;

  reconcileRunning = true;
  try {
    let resolveIndexes;
    const indexesReady = new Promise((resolve) => { resolveIndexes = resolve; });
    activeRound = {
      peerKeys: new Set(peers.map((peer) => peer.key)),
      indexes: new Map(),
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
    for (const peer of peers) {
      if (remaining.length === 0) break;
      // eslint-disable-next-line no-await-in-loop
      const fetchReq = await sign({ type: FETCH_REQUEST, version: 1, appNames: remaining, timestamp: now() });
      try { peer.send(fetchReq); } catch (error) { continue; }
      // eslint-disable-next-line no-await-in-loop
      await delay(fetchSettleMs);
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
    return { peers: peers.length, indexesReceived, fetched };
  } finally {
    activeRound = null;
    reconcileRunning = false;
  }
}

module.exports = {
  reconcile,
  depositIndex,
  isPeerInActiveRound,
  // exposed for tests
  unionTarget,
  computeNeeded,
};
