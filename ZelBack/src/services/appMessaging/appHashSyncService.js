'use strict';

const config = require('config');
const messageHelper = require('../messageHelper');
const verificationHelper = require('../verificationHelper');
const serviceHelper = require('../serviceHelper');
const messageBatchRequests = require('./messageBatchRequests');
const { serialiseAndSignFluxBroadcast } = require('../utils/fluxBroadcastHelper');
const { peerManager } = require('../utils/peerState');
const fluxCommunicationUtils = require('../fluxCommunicationUtils');
const { openEphemeralConnection } = require('../fluxCommunication');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const { normalizeSocketAddress } = require('../utils/socketAddressUtils');
const { CLOSE_CODES } = require('../utils/FluxPeerSocket');
const { appSyncEvents, EVENTS } = require('../utils/appSyncEvents');
const { HASH_EXPIRY_BLOCKS, HASH_RETRY_BACKOFF } = require('../utils/appConstants');
const log = require('../../lib/log');
const fluxEventBus = require('../utils/fluxEventBus');
const { invalidMessages } = require('../invalidMessages');
const appRecords = require('../appDatabase/appRecords');
const { Privilege, authOf } = require('../utils/privileges');


const SETTLE_TIME_MS = config.get('fluxapps.hashSyncSettleMs');
const RESPONSE_TIME_PER_HASH_MS = config.get('fluxapps.hashSyncResponseTimePerHashMs');
const BUFFER_MS = config.get('fluxapps.hashSyncBufferMs');
const MAX_ROUNDS = config.get('fluxapps.hashSyncMaxRounds');
const PEERS_PER_ROUND = config.get('fluxapps.hashSyncPeersPerRound');
const EPHEMERAL_PEERS_COUNT = config.get('fluxapps.hashSyncEphemeralPeers');

let syncRunning = false;

async function getMissingHashes(options = {}) {
  const { force = false, currentHeight = 0 } = options;
  const results = await appRecords.messages().awaitingContents({ height: currentHeight, force });
  return results.filter((r) => {
    if (force) return true;
    return !invalidMessages.find((m) => m.hash === r.hash && m.txid === r.txid);
  });
}

// Requests a node keeps open to one peer at once, so the peer reads the next
// while this node stores the last.
const BATCH_REQUESTS_PER_PEER = 2;

/**
 * Asks every peer that answers message batches for the contents of these hashes,
 * MAX_REQUEST_HASHES at a time, BATCH_REQUESTS_PER_PEER requests open to each
 * peer at once. Hashes a request leaves unheld - the peer holds them not, or its
 * connection closed - are asked of a peer not yet asked for them. A peer asked
 * for every hash still unheld, or gone, is asked nothing more.
 * @param {string[]} hashes
 * @returns {Promise<{peers: number, requests: number, stored: number, unheld: number}>}
 */
async function syncByBatches(hashes) {
  const peers = [...peerManager.allValues()].filter((peer) => peer.remoteCapabilities?.has(messageBatchRequests.CAPABILITY));
  if (peers.length === 0 || hashes.length === 0) return { peers: peers.length, requests: 0, stored: 0, unheld: hashes.length };
  const started = Date.now();
  const queue = [];
  for (let offset = 0; offset < hashes.length; offset += messageBatchRequests.MAX_REQUEST_HASHES) {
    queue.push({ hashes: hashes.slice(offset, offset + messageBatchRequests.MAX_REQUEST_HASHES), asked: new Set() });
  }
  let requests = 0;
  let stored = 0;
  let inFlight = 0;
  let wake;
  let changed = new Promise((resolve) => { wake = resolve; });
  const notify = () => {
    const woken = wake;
    changed = new Promise((resolve) => { wake = resolve; });
    woken();
  };

  async function askFrom(key) {
    for (;;) {
      const socket = peerManager.get(key);
      if (!socket) return;
      const index = queue.findIndex((chunk) => !chunk.asked.has(key));
      if (index === -1) {
        if (inFlight === 0) return;
        // eslint-disable-next-line no-await-in-loop
        await changed;
        continue;
      }
      const [chunk] = queue.splice(index, 1);
      chunk.asked.add(key);
      inFlight += 1;
      try {
        const { message, done } = messageBatchRequests.openRequest(key, chunk.hashes);
        // eslint-disable-next-line no-await-in-loop
        const signed = await serialiseAndSignFluxBroadcast(message);
        if (signed) socket.send(signed);
        requests += 1;
        // eslint-disable-next-line no-await-in-loop
        const outcome = await done;
        stored += outcome.stored;
        if (outcome.missing.length) queue.push({ hashes: outcome.missing, asked: chunk.asked });
      } finally {
        inFlight -= 1;
        notify();
      }
    }
  }

  await Promise.all(peers.flatMap((peer) => Array.from({ length: BATCH_REQUESTS_PER_PEER }, () => askFrom(peer.key))));
  const unheld = queue.reduce((total, chunk) => total + chunk.hashes.length, 0);
  log.info(`syncMissingHashes - ${stored} of ${hashes.length} stored from ${peers.length} peers in ${requests} batch requests, ${unheld} unheld, in ${Date.now() - started} ms`);
  fluxEventBus.publish('hashSync:batchFetched', {
    peers: peers.length, requests, requested: hashes.length, stored, unheld, ms: Date.now() - started,
  });
  return {
    peers: peers.length, requests, stored, unheld,
  };
}

/**
 * Poll until responses settle or timeout. Responses arrive asynchronously
 * via gossip — we detect resolution by checking getMissingHashes() count.
 * @param {number} previousCount - Missing count before this round
 * @param {number} maxWaitMs - Maximum time to wait
 * @param {boolean} force - Pass to getMissingHashes
 * @returns {Promise<Array>} Remaining missing hashes
 */
async function waitForResolution(pendingHashes, maxWaitMs, force, currentHeight) {
  const deadline = Date.now() + maxWaitMs;
  let lastActivityAt = Date.now();

  const handler = (hash) => { if (pendingHashes.has(hash)) lastActivityAt = Date.now(); };
  appSyncEvents.on(EVENTS.HASH_RESPONSE_RECEIVED, handler);

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await serviceHelper.delay(1000);
      const current = await getMissingHashes({ force, currentHeight });
      if (current.length === 0) return [];
      if (Date.now() - lastActivityAt >= SETTLE_TIME_MS) return current;
      if (Date.now() >= deadline) return current;
    }
  } finally {
    appSyncEvents.removeListener(EVENTS.HASH_RESPONSE_RECEIVED, handler);
  }
}

/**
 * Pick N random held peers that haven't been tried yet, whatever their source:
 * a ring duty or a witness dial is a peer like any other for a hash request.
 * @param {object} peerManager
 * @param {number} count
 * @param {object} [options]
 * @param {Set} [options.excludeKeys] - Peer keys already tried
 * @returns {Array} Array of peer objects
 */
function pickRandomPeers(peerManager, count, options = {}) {
  const { excludeKeys = new Set() } = options;
  const candidates = [];
  for (const peer of peerManager.allValues()) {
    if (excludeKeys.has(peer.key)) continue;
    candidates.push(peer);
  }
  // Shuffle
  for (let i = candidates.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates.slice(0, count);
}

/**
 * Sign a fluxapprequest v2 message once and send to all peers.
 * @param {Array<string>} hashes - Hashes to request
 * @param {Array<object>} peers - Peer sockets to send to
 */
async function broadcastHashRequest(hashes, peers) {
  const message = {
    type: 'fluxapprequest',
    version: 2,
    hashes,
  };
  const signed = await serialiseAndSignFluxBroadcast(message);
  if (!signed) return;
  for (const peer of peers) {
    peer.send(signed);
  }
}

/**
 * Pick target IPs for the ephemeral round: random nodes of the deterministic
 * list this node does not hold. The rounds before it asked held peers; this
 * round reaches the nodes they could not.
 * @param {number} count
 * @returns {Promise<string[]>} Array of ip:port strings
 */
async function pickEphemeralTargets(count) {
  const nodeList = await fluxCommunicationUtils.deterministicFluxList();
  const localSocketAddress = await fluxNetworkHelper.getLocalSocketAddress();
  if (!localSocketAddress) return [];
  const held = new Set();
  for (const peer of peerManager.allValues()) {
    held.add(peer.key);
  }
  const unheld = [];
  for (const node of nodeList) {
    if (!node.ip) continue;
    const key = normalizeSocketAddress(node.ip);
    if (key === localSocketAddress || held.has(key)) continue;
    unheld.push(key);
  }
  for (let i = unheld.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [unheld[i], unheld[j]] = [unheld[j], unheld[i]];
  }
  return unheld.slice(0, count);
}

/**
 * Open ephemeral connections to random nodes, request hashes, wait for
 * responses, then close all connections.
 * @param {string[]} hashes - Hashes to request
 * @param {boolean} force - Pass to getMissingHashes
 * @returns {Promise<Array>} Remaining missing hashes
 */
async function ephemeralHashRound(hashes, force, currentHeight) {
  const targets = await pickEphemeralTargets(EPHEMERAL_PEERS_COUNT);
  if (targets.length === 0) {
    log.info('syncMissingHashes - No ephemeral targets available');
    return getMissingHashes({ force, currentHeight });
  }

  log.info(`syncMissingHashes - Ephemeral round: attempting ${targets.length} connections: ${targets.join(', ')}`);
  fluxEventBus.publish('hashSync:ephemeralRound', { targets: targets.length, hashes: hashes.length });
  const connections = await Promise.all(targets.map((t) => openEphemeralConnection(t)));
  const peers = connections.filter(Boolean);
  if (peers.length === 0) {
    log.info(`syncMissingHashes - All ${targets.length} ephemeral connections failed`);
    return getMissingHashes({ force, currentHeight });
  }

  const peerKeys = peers.map((p) => p.key).join(', ');
  log.info(`syncMissingHashes - Ephemeral round: requesting ${hashes.length} hashes from ${peers.length} peers: ${peerKeys}`);

  try {
    for (let offset = 0; offset < hashes.length; offset += 500) {
      // eslint-disable-next-line no-await-in-loop
      await broadcastHashRequest(hashes.slice(offset, offset + 500), peers);
    }

    const maxWait = hashes.length * RESPONSE_TIME_PER_HASH_MS + BUFFER_MS;
    const remaining = await waitForResolution(new Set(hashes), maxWait, force, currentHeight);

    return remaining;
  } finally {
    for (const peer of peers) {
      try { peer.close(CLOSE_CODES.EPHEMERAL_DONE, 'done'); } catch (_e) { /* noop */ }
    }
  }
}

async function syncMissingHashes(options = {}) {
  const { onProgress = null, force = false, currentHeight = 0 } = options;

  if (syncRunning) {
    log.info('syncMissingHashes - Already running, skipping');
    return { resolved: 0, missing: 0, unreachable: 0 };
  }

  syncRunning = true;
  fluxEventBus.count('hashSync:run');
  try {
    let missingHashes = await getMissingHashes({ force, currentHeight });
    log.info(`syncMissingHashes - Found ${missingHashes.length} missing hashes`);

    if (missingHashes.length === 0) {
      return { resolved: 0, missing: 0, unreachable: 0 };
    }

    const localResolved = 0;

    const initialCount = missingHashes.length;
    let resolved = localResolved;

    // In batches from every peer that answers them; what they do not hold is
    // asked for below, a message per hash.
    const batches = await syncByBatches([...new Set(missingHashes.map((record) => record.hash))]);
    if (batches.requests > 0) {
      resolved += batches.stored;
      missingHashes = await getMissingHashes({ force, currentHeight });
      if (onProgress) onProgress({ resolved, missing: missingHashes.length });
    }

    // Targeted fetch via fluxapprequest v2 (capped at 500 per request)
    if (missingHashes.length > 0) {
      log.info(`syncMissingHashes - ${missingHashes.length} missing, requesting from peers`);
      const triedPeers = new Set();

      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        if (missingHashes.length === 0) break;

        const peers = pickRandomPeers(peerManager, PEERS_PER_ROUND, { excludeKeys: triedPeers });
        if (peers.length === 0) {
          log.info(`syncMissingHashes - No more untried peers available`);
          break;
        }

        for (const peer of peers) {
          triedPeers.add(peer.key);
        }

        const allHashes = missingHashes.map((h) => h.hash);
        for (let offset = 0; offset < allHashes.length; offset += 500) {
          const hashChunk = allHashes.slice(offset, offset + 500);
          const peerKeys = peers.map((p) => p.key).join(', ');
          log.info(`syncMissingHashes - Round ${round + 1}: requesting ${hashChunk.length} hashes from ${peers.length} peers: ${peerKeys}`);

          // eslint-disable-next-line no-await-in-loop
          await broadcastHashRequest(hashChunk, peers);
        }

        const maxWait = allHashes.length * RESPONSE_TIME_PER_HASH_MS + BUFFER_MS;
        const beforeCount = missingHashes.length;
        missingHashes = await waitForResolution(new Set(allHashes), maxWait, force, currentHeight);
        const resolvedThisRound = beforeCount - missingHashes.length;
        resolved += resolvedThisRound;

        log.info(`syncMissingHashes - Round ${round + 1}: resolved ${resolvedThisRound}, ${missingHashes.length} remaining`);
        if (onProgress) onProgress({ resolved, missing: missingHashes.length });
      }
    }

    // Ephemeral round: connect to random nodes outside our peer pool
    if (missingHashes.length > 0) {
      const beforeEphemeral = missingHashes.length;
      const hashes = missingHashes.map((h) => h.hash);
      missingHashes = await ephemeralHashRound(hashes, force, currentHeight);
      const resolvedEphemeral = beforeEphemeral - missingHashes.length;
      resolved += resolvedEphemeral;
      log.info(`syncMissingHashes - Ephemeral round: resolved ${resolvedEphemeral}, ${missingHashes.length} remaining`);
    }

    // Update backoff for unresolved hashes
    const finalMissing = await getMissingHashes({ force: false, currentHeight });

    let unreachable = 0;
    let minNextRetry = null;
    const backoffOps = [];
    for (const hashDoc of finalMissing) {
      // A hash is looked for for HASH_EXPIRY_BLOCKS from this node's first look,
      // not from its payment: a node that records an old payment has not been
      // looking for it since.
      const retryFromHeight = hashDoc.retryFromHeight ?? currentHeight;
      if (currentHeight - retryFromHeight > HASH_EXPIRY_BLOCKS) {
        // eslint-disable-next-line no-await-in-loop
        await appRecords.messages().markNotFound(hashDoc.hash);
        unreachable += 1;
      } else {
        const attempts = (hashDoc.syncAttempts ?? 0) + 1;
        // The ladder's first rung is the first failure: the next sweep asks
        // again; the second failure waits the second rung, and so on.
        const backoffIdx = Math.min(attempts - 1, HASH_RETRY_BACKOFF.length - 1);
        const nextRetry = currentHeight + HASH_RETRY_BACKOFF[backoffIdx];
        if (minNextRetry === null || nextRetry < minNextRetry) {
          minNextRetry = nextRetry;
        }
        // eslint-disable-next-line no-await-in-loop
        await appRecords.messages().markSyncAttempt(hashDoc.hash, { syncAttempts: attempts, nextRetryHeight: nextRetry })
          .catch((err) => log.error(`syncMissingHashes backoff update: ${err.message}`));
        backoffOps.push(hashDoc.hash);
      }
    }

    const remaining = finalMissing.length - unreachable;
    log.info(`syncMissingHashes - Complete: ${resolved}/${initialCount} resolved, ${remaining} missing (${backoffOps.length} backed off), ${unreachable} unreachable`);
    return { resolved, missing: remaining, unreachable, nextRetryHeight: minNextRetry };
  } finally {
    syncRunning = false;
  }
}

async function triggerAppHashesCheckAPI(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege(Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
      return;
    }
    appSyncEvents.emit(EVENTS.HASH_CHECK_REQUESTED);
    const resultsResponse = messageHelper.createSuccessMessage('Sync on missing application messages queued');
    res.json(resultsResponse);
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

async function resetHashSyncForUpgrade(currentHeight) {
  return appRecords.messages().resetSyncState(currentHeight);
}

module.exports = {
  syncMissingHashes,
  getMissingHashes,
  resetHashSyncForUpgrade,
  triggerAppHashesCheckAPI,
};
