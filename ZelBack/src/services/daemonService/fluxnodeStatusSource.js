'use strict';

const log = require('../../lib/log');
const daemonSubscriptionService = require('./daemonSubscriptionService');
const nodeConfirmationService = require('../nodeConfirmationService');
const fluxEventBus = require('../utils/fluxEventBus');

/**
 * Keeps this node's own deterministic-list status current.
 *
 * The status changes rarely — a node re-confirms once every few hundred blocks — so
 * asking every 30 seconds spent an uncached RPC to be told nothing had happened almost
 * every time. The topic publishes on change, which is the whole of the signal.
 *
 * RPC is kept for the two moments push cannot cover: seeding at startup, because a node
 * that has just booted has no status and the topic will not fire until one changes, and
 * repair after messages were missed, because nothing is replayed. The seed is for our
 * own restarts — the daemon treats its first block after starting as a change and
 * publishes then, so a fluxd restart supplies one unprompted.
 *
 * The chain tip is subscribed alongside it. Confirmation expiry is a block count, so a
 * status that was comfortably inside its deadline stops being so as the chain advances
 * — with no new status to prompt it, the block is what prompts the re-examination.
 */

let mode = null;

/**
 * Begins tracking own status, by push where the daemon offers it and by polling where
 * it does not.
 * @returns {Promise<string>} The mode taken, 'push' or 'poll'.
 */
async function start() {
  if (mode) return mode;

  const statusTopic = daemonSubscriptionService.TOPICS.fluxnodeStatus;

  if (!daemonSubscriptionService.isTopicAvailable(statusTopic)) {
    log.info('fluxnodeStatusSource - daemon does not publish fluxnodestatus, polling instead');
    mode = 'poll';
    fluxEventBus.publish('daemon:subscriptionMode', { source: 'fluxnodeStatusSource', mode, topic: statusTopic });
    await nodeConfirmationService.start();
    return mode;
  }

  daemonSubscriptionService.subscribe(statusTopic, {
    onMessage: (decoded) => nodeConfirmationService.applyPushedStatus(decoded),
    onResync: async (reason) => {
      log.warn(`fluxnodeStatusSource - refetching own status (${reason})`);
      await nodeConfirmationService.poll();
    },
  });

  daemonSubscriptionService.subscribe(daemonSubscriptionService.TOPICS.hashBlockHeight, {
    onMessage: () => nodeConfirmationService.reevaluate(),
  });

  mode = 'push';
  fluxEventBus.publish('daemon:subscriptionMode', { source: 'fluxnodeStatusSource', mode, topic: statusTopic });

  // Seeds the first status, and opens the gate every startup path waits on.
  await nodeConfirmationService.start({ push: true });

  log.info('fluxnodeStatusSource - tracking own status from fluxnodestatus');
  return mode;
}

/**
 * Stops tracking. The subscriptions themselves are owned by the subscription service
 * and close with it.
 * @returns {void}
 */
function stop() {
  mode = null;
  nodeConfirmationService.stop();
}

module.exports = {
  start,
  stop,
  currentMode: () => mode,
};
