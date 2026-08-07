const log = require('../lib/log');
const daemonServiceUtils = require('./daemonService/daemonServiceUtils');
const daemonSubscriptionService = require('./daemonService/daemonSubscriptionService');
const fluxEventBus = require('./utils/fluxEventBus');

/**
 * Keeps the node list current from fluxnodelistdelta instead of refetching it.
 *
 * The full list is ~7 MB and was being pulled roughly once per block; the delta
 * carrying the same information is ~3 KB. What makes that safe is the bootstrap
 * order and the chain check, not the delta itself:
 *
 * Subscribe first, then snapshot. A snapshot taken before subscribing leaves a window
 * whose transitions nobody sees, and the stream cannot be replayed to recover them.
 * Deltas arriving during the snapshot RPC are buffered and applied afterwards, minus
 * those the snapshot already includes.
 *
 * Every delta names the block it starts from. If that is not the block the state sits
 * at, the delta is refused and the whole list is refetched — there is no partial
 * repair, because a delta stream has no history to replay.
 */

// Why the list is being rebuilt from a snapshot. A resync carries the subscription
// service's own token through instead of coining a second one for the same cause.
const BOOTSTRAP_REASONS = {
  startup: 'startup',
  deltaRefused: 'delta_refused',
};

let manager = null;
let fetchList = null;
let buffered = [];
let live = false;
let applied = {
  deltas: 0, added: 0, removed: 0, updated: 0, fromHeight: null, toHeight: null,
};
let bootstrapping = false;

/**
 * Fetches an atomic snapshot: height, block hash and nodes under one daemon lock.
 * @returns {Promise<{height: number, blockhash: string, nodes: Array}|null>} Snapshot.
 */
async function fetchSnapshot() {
  const response = await daemonServiceUtils.executeCall('getFluxnodeSnapshot', []);

  if (response.status !== 'success') {
    log.error(`nodeListSource - snapshot failed: ${response.data?.message || response.data}`);
    return null;
  }

  const { height, blockhash, nodes } = response.data;

  if (!Array.isArray(nodes) || !nodes.length || !blockhash) {
    log.error('nodeListSource - snapshot was empty or unanchored, ignoring');
    return null;
  }

  return { height, blockhash, nodes };
}

/**
 * Resolves added nodes to their full records.
 *
 * A delta carries less per node than the list exposes — `added_height` and
 * `payment_address` are absent, and both have consumers, one of them the sort that
 * decides peer selection. The daemon's list RPC takes a filter, so each addition
 * costs one small lookup rather than a full refetch.
 *
 * @param {Array<{txhash: string, outidx: number}>} outpoints Added node outpoints.
 * @returns {Promise<Array<object>>} Full records, in no guaranteed order.
 */
function emptyApplied() {
  return {
    deltas: 0, added: 0, removed: 0, updated: 0, fromHeight: null, toHeight: null,
  };
}

/**
 * What has been applied since this was last asked, and starts a fresh window.
 *
 * Deltas arrive every block and almost all of them are unremarkable, so they are
 * reported in aggregate rather than one line each. Anything that went wrong has already
 * logged at the moment it happened.
 *
 * @returns {{deltas: number, added: number, removed: number, updated: number,
 *   fromHeight: number|null, toHeight: number|null}}
 */
function takeAppliedSummary() {
  const summary = applied;
  applied = emptyApplied();
  return summary;
}

function publishApplied(delta) {
  fluxEventBus.publish('daemon:deltaApplied', {
    fromHeight: delta.fromHeight,
    toHeight: delta.toHeight,
    added: delta.added.length,
    removed: delta.removed.length,
    updated: delta.updated.length,
    isReorg: delta.isReorg === true,
  });
}

function publishRefused(delta, result) {
  fluxEventBus.publish('daemon:deltaRefused', {
    reason: result.code,
    fromHeight: delta.fromHeight,
    toHeight: delta.toHeight,
  });
}

async function resolveAdded(outpoints) {
  const resolved = await Promise.all(outpoints.map(async (outpoint) => {
    const candidates = await fetchList(outpoint.txhash);

    // The filter is a substring match over the whole list, so one txhash can return
    // several nodes. The delta already told us which output it means.
    const match = candidates.find(
      (node) => node.txhash === outpoint.txhash && Number(node.outidx) === Number(outpoint.outidx),
    );

    if (!match) {
      log.warn(`nodeListSource - could not resolve added node ${outpoint.txhash}:${outpoint.outidx}`);
    }

    return match || null;
  }));

  return resolved.filter(Boolean);
}

/**
 * Takes a snapshot and applies whichever buffered deltas it does not already include.
 * @param {string} reason A BOOTSTRAP_REASONS or RESYNC_REASONS token for why.
 * @returns {Promise<boolean>} True when the state is anchored and live.
 */
async function bootstrap(reason) {
  if (bootstrapping) return false;
  bootstrapping = true;
  live = false;

  try {
    const snapshot = await fetchSnapshot();
    if (!snapshot) return false;

    await manager.applySnapshot(snapshot.nodes, snapshot.height, snapshot.blockhash);

    // Anything that ended at or before the snapshot is already in it.
    const pending = buffered
      .filter((delta) => delta.toHeight > snapshot.height)
      .sort((a, b) => a.fromHeight - b.fromHeight);

    buffered = [];

    // eslint-disable-next-line no-restricted-syntax
    for (const delta of pending) {
      // eslint-disable-next-line no-await-in-loop
      const result = await manager.applyDelta(delta, resolveAdded);
      if (!result.applied) {
        publishRefused(delta, result);
        log.warn(`nodeListSource - buffered delta did not chain on (${result.reason}), dropping the rest`);
        break;
      }
      publishApplied(delta);
    }

    live = true;
    log.info(`nodeListSource - anchored at ${snapshot.height} (${reason})`);
    fluxEventBus.publish('daemon:listAnchored', {
      height: snapshot.height,
      blockhash: snapshot.blockhash,
      nodes: snapshot.nodes.length,
      reason,
    });
    return true;
  } finally {
    bootstrapping = false;
  }
}

async function onDelta(delta) {
  // Still bootstrapping: hold it until there is something to apply it to.
  if (!live) {
    buffered.push(delta);
    return;
  }

  const result = await manager.applyDelta(delta, resolveAdded);

  if (result.applied) {
    applied.deltas += 1;
    applied.added += delta.added.length;
    applied.removed += delta.removed.length;
    applied.updated += delta.updated.length;
    applied.toHeight = delta.toHeight;
    if (applied.fromHeight === null) applied.fromHeight = delta.fromHeight;
    publishApplied(delta);
    return;
  }

  publishRefused(delta, result);
  log.warn(`nodeListSource - delta refused (${result.reason}), refetching the list`);
  await bootstrap(BOOTSTRAP_REASONS.deltaRefused);
}

/**
 * Starts tracking the node list by push, if the daemon publishes the topic.
 * @param {object} options
 * @param {object} options.stateManager The NetworkStateManager to keep current.
 * @param {(filter: string|null) => Promise<Array>} options.listFetcher Filtered list fetch.
 * @returns {Promise<boolean>} True when the push path is in use.
 */
async function start(options) {
  const topic = daemonSubscriptionService.TOPICS.fluxnodeListDelta;

  if (!daemonSubscriptionService.isTopicAvailable(topic)) {
    log.info('nodeListSource - daemon does not publish fluxnodelistdelta, keeping the fetch path');
    fluxEventBus.publish('daemon:subscriptionMode', { source: 'nodeListSource', mode: 'poll', topic });
    return false;
  }

  manager = options.stateManager;
  fetchList = options.listFetcher;
  buffered = [];
  live = false;

  // Subscribe before the snapshot, never after.
  daemonSubscriptionService.subscribe(topic, {
    onMessage: (delta) => onDelta(delta),
    onResync: (reason) => bootstrap(reason),
  });

  fluxEventBus.publish('daemon:subscriptionMode', { source: 'nodeListSource', mode: 'push', topic });

  return bootstrap(BOOTSTRAP_REASONS.startup);
}

function stop() {
  manager = null;
  fetchList = null;
  buffered = [];
  live = false;
  bootstrapping = false;
}

module.exports = {
  takeAppliedSummary,
  bootstrap,
  resolveAdded,
  start,
  stop,
  isLive: () => live,
  bufferedCount: () => buffered.length,
};
