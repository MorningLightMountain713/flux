const log = require('../../lib/log');
const daemonServiceUtils = require('./daemonServiceUtils');
const daemonSubscriptionService = require('./daemonSubscriptionService');

/**
 * Turns the daemon's reorg notification into the two things FluxOS has to do about it.
 *
 * The event itself is informational and is deliberately not acted on beyond this: the
 * node list is not cleared and nothing is resynced from it, because the delta that
 * follows carries the net effect and clearing here would throw away state the delta
 * expects to find. What the event is good for is the fork height, which nothing else
 * supplies — the daemon has already moved `chainActive` by the time anything else can
 * ask, so this is the only moment the common ancestor is known for free.
 *
 * Before this existed a reorg was only noticed by polling `getChainTips`, gated to
 * once per 101 blocks and only while the tip was not advancing.
 */

const listeners = [];

/**
 * Registers a consumer for reorgs. Called with {oldTip, newTip, fork, depth}.
 * @param {function} callback Reorg handler.
 * @returns {void}
 */
function onReorg(callback) {
  listeners.push(callback);
}

function handleReorg(reorg) {
  log.warn(
    `reorgSource - chain reorg depth ${reorg.depth}: `
    + `${reorg.oldTip.height}/${reorg.oldTip.hash.slice(0, 16)} -> `
    + `${reorg.newTip.height}/${reorg.newTip.hash.slice(0, 16)}, `
    + `fork at ${reorg.fork.height}`,
  );

  const dropped = daemonServiceUtils.invalidateCachesFromHeight(reorg.fork.height);
  log.info(
    `reorgSource - dropped ${dropped.blocks} cached block(s) above ${reorg.fork.height}, `
    + `${dropped.transactions} transaction(s), ${dropped.generic} other`,
  );

  listeners.forEach((listener) => {
    try {
      const result = listener(reorg);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => log.error(`reorgSource - handler error: ${err.message}`));
      }
    } catch (err) {
      log.error(`reorgSource - handler error: ${err.message}`);
    }
  });
}

/**
 * Subscribes to chain reorgs, where the daemon publishes them.
 * @returns {boolean} True when the push path is in use.
 */
function start() {
  const topic = daemonSubscriptionService.TOPICS.chainReorg;

  if (!daemonSubscriptionService.isTopicAvailable(topic)) {
    log.info('reorgSource - daemon does not publish chainreorg, reorgs stay poll-detected');
    return false;
  }

  daemonSubscriptionService.subscribe(topic, {
    onMessage: (reorg) => handleReorg(reorg),
  });

  return true;
}

function stop() {
  listeners.length = 0;
}

module.exports = {
  handleReorg,
  onReorg,
  start,
  stop,
  listenerCount: () => listeners.length,
};
