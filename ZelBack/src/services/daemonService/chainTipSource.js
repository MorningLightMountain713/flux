'use strict';

const config = require('config');

const log = require('../../lib/log');
const daemonServiceMiscRpcs = require('./daemonServiceMiscRpcs');
const daemonSubscriptionService = require('./daemonSubscriptionService');
const fluxEventBus = require('../utils/fluxEventBus');

/**
 * Keeps the daemon's chain tip current for `isDaemonSynced` and its 34 readers.
 *
 * Push supplies the height every block, which is the part that was costing a 30s RPC.
 * It cannot supply `headers` — what the chain claims to be — and the two are not
 * interchangeable: a daemon past initial download but still catching up publishes a
 * block per connection, so a height inferred as the header would read as synced while
 * the node is behind. The authoritative pair therefore still comes from RPC, at a
 * tenth of the old rate, and immediately whenever messages were missed.
 */

let headerTimer = null;
let stopped = false;
let mode = null;

async function refreshAuthoritative(reason) {
  const updated = await daemonServiceMiscRpcs.fluxDaemonBlockchainInfo();
  if (!updated) log.warn(`chainTipSource - authoritative refresh failed (${reason})`);
  return updated;
}

function scheduleHeaderRefresh() {
  if (stopped) return;

  headerTimer = setTimeout(async () => {
    headerTimer = null;
    await refreshAuthoritative('scheduled');
    scheduleHeaderRefresh();
  }, config.daemon.subscriptions.headerRefreshIntervalMs);
}

/**
 * Begins tracking the chain tip, by push where the daemon offers it and by polling
 * where it does not.
 * @returns {Promise<string>} The mode taken, 'push' or 'poll'.
 */
async function start() {
  if (mode) return mode;

  stopped = false;
  const topic = daemonSubscriptionService.TOPICS.hashBlockHeight;

  if (!daemonSubscriptionService.isTopicAvailable(topic)) {
    log.info('chainTipSource - daemon does not publish hashblockheight, polling instead');
    mode = 'poll';
    fluxEventBus.publish('daemon:subscriptionMode', { source: 'chainTipSource', mode, topic });
    daemonServiceMiscRpcs.daemonBlockchainInfoService();
    return mode;
  }

  daemonSubscriptionService.subscribe(topic, {
    onMessage: (decoded) => daemonServiceMiscRpcs.recordChainTip(decoded.height),
    // Deltas are not replayed, so a gap or a reconnection means an unknown number of
    // missed tips. One RPC restores both numbers exactly.
    onResync: (reason) => refreshAuthoritative(reason),
  });

  mode = 'push';
  fluxEventBus.publish('daemon:subscriptionMode', { source: 'chainTipSource', mode, topic });

  // Seed before the first block arrives; a node that starts mid-block would otherwise
  // read as never updated for up to a block time.
  await refreshAuthoritative('startup');
  scheduleHeaderRefresh();

  log.info('chainTipSource - tracking the chain tip from hashblockheight');
  return mode;
}

/**
 * Stops the header refresh. The subscription itself is owned by the subscription
 * service and closes with it.
 * @returns {void}
 */
function stop() {
  stopped = true;
  mode = null;

  if (headerTimer) {
    clearTimeout(headerTimer);
    headerTimer = null;
  }
}

module.exports = {
  refreshAuthoritative,
  start,
  stop,
  currentMode: () => mode,
};
