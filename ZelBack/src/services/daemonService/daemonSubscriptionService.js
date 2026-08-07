const config = require('config');

const log = require('../../lib/log');
const daemonServiceUtils = require('./daemonServiceUtils');
const fluxEventBus = require('../utils/fluxEventBus');
const { createFluxdLiveness } = require('../utils/fluxdLiveness');
const { createFluxdSubscriber } = require('../utils/fluxdSubscriber');

const TOPICS = {
  hashBlockHeight: 'hashblockheight',
  chainReorg: 'chainreorg',
  fluxnodeListDelta: 'fluxnodelistdelta',
  fluxnodeStatus: 'fluxnodestatus',
};

// Why a consumer is being asked to rebuild. Stable tokens rather than prose: a
// consumer logs this, and the harness compares it.
const RESYNC_REASONS = {
  messageGap: 'message_gap',
  reconnected: 'reconnected',
};

/**
 * The one subscription to fluxd, and the router in front of it.
 *
 * Availability is decided per topic rather than globally. The topic set is written by
 * flux_configd on Arcane and by systemService on legacy, in two repos and two
 * languages with nothing keeping them aligned, and a daemon can predate any given
 * topic. A consumer whose topic is missing runs its own polling instead of the whole
 * subscription failing.
 */

const subscribers = new Map();

let subscriber = null;
let liveness = null;
let availableTopics = [];
let started = false;

/**
 * Whether this daemon publishes a topic, from its own config file.
 * @param {string} topic Topic name, without the `zmqpub` prefix.
 * @returns {boolean} True when the daemon is configured to publish it.
 */
function isTopicAvailable(topic) {
  return Boolean(daemonServiceUtils.getConfigValue(`zmqpub${topic}`));
}

/**
 * Registers interest in a topic.
 *
 * `onResync` is the important half. It fires when messages were missed — a sequence
 * gap, or a reconnection across which the publisher sent nothing to us — and means
 * the consumer's state can no longer be trusted to be incremental. Deltas cannot be
 * replayed, so the only repair is to rebuild from RPC.
 *
 * @param {string} topic Topic name.
 * @param {{onMessage: function, onResync?: function}} handler Consumer callbacks.
 * @returns {void}
 */
function subscribe(topic, handler) {
  if (!Object.values(TOPICS).includes(topic)) {
    throw new Error(`Unknown topic ${topic}`);
  }

  if (!handler || typeof handler.onMessage !== 'function') {
    throw new Error(`Topic ${topic} needs an onMessage handler`);
  }

  if (!subscribers.has(topic)) subscribers.set(topic, []);
  subscribers.get(topic).push(handler);
}

function dispatch(topic, decoded, seq) {
  const handlers = subscribers.get(topic);
  if (!handlers) return;

  handlers.forEach((handler) => handler.onMessage(decoded, seq));
}

function requestResync(topic, reason) {
  const handlers = subscribers.get(topic);
  if (!handlers) return;

  fluxEventBus.publish('daemon:resync', { topic, reason });

  handlers.forEach((handler) => {
    if (handler.onResync) handler.onResync(reason);
  });
}

function resyncAll(reason) {
  [...subscribers.keys()].forEach((topic) => requestResync(topic, reason));
}

/**
 * Asks the daemon directly whether it is answering. Uncached deliberately — a cached
 * answer would let a dead daemon look alive for the length of the cache TTL, and this
 * call exists precisely to be the authority.
 * @returns {Promise<boolean>} True when the daemon answered.
 */
async function probeDaemon() {
  const response = await daemonServiceUtils.executeCall('getBlockCount', []);
  return response.status === 'success';
}

/**
 * Opens the subscription for whichever topics the daemon publishes.
 * @returns {boolean} True when at least one topic was subscribed.
 */
function start() {
  if (started) return availableTopics.length > 0;
  started = true;

  const settings = config.daemon.subscriptions;
  const endpoint = `tcp://${config.daemon.host}:${config.daemon.zmqport}`;

  availableTopics = Object.values(TOPICS).filter(isTopicAvailable);

  const missing = Object.values(TOPICS).filter((topic) => !availableTopics.includes(topic));
  if (missing.length) {
    log.warn(`daemonSubscriptions - daemon does not publish ${missing.join(', ')}; consumers of those will poll`);
  }

  if (!availableTopics.length) {
    log.warn('daemonSubscriptions - daemon publishes no known topics, every consumer will poll');
    fluxEventBus.publish('daemon:subscriptionsStarted', { endpoint, topics: [] });
    return false;
  }

  subscriber = createFluxdSubscriber({
    endpoint,
    topics: availableTopics,
    receiveHighWaterMark: settings.receiveHighWaterMark,
    onMessage: dispatch,
    onGap: (topic) => requestResync(topic, RESYNC_REASONS.messageGap),
    // Nothing is buffered for us across an outage, so a reconnection means an
    // unknown number of missed transitions, not zero.
    onConnect: ({ reconnected }) => {
      if (reconnected) resyncAll(RESYNC_REASONS.reconnected);
    },
  });

  liveness = createFluxdLiveness({
    elapsedSinceMessageMs: subscriber.elapsedSinceMessageMs,
    probe: probeDaemon,
    silenceThresholdMs: settings.silenceThresholdMs,
    probeIntervalMs: settings.probeIntervalMs,
    checkIntervalMs: settings.livenessCheckIntervalMs,
  });

  subscriber.start();
  liveness.start();

  log.info(`daemonSubscriptions - started on ${endpoint} for ${availableTopics.join(', ')}`);
  fluxEventBus.publish('daemon:subscriptionsStarted', { endpoint, topics: [...availableTopics] });
  return true;
}

/**
 * Closes the subscription and stops liveness evaluation.
 * @returns {void}
 */
function stop() {
  if (subscriber) subscriber.stop();
  if (liveness) liveness.stop();

  subscriber = null;
  liveness = null;
  availableTopics = [];
  started = false;
}

/**
 * Whether the daemon is reachable. True until a probe proves otherwise, because the
 * cost of a wrong negative here is every app on the node being removed.
 * @returns {boolean} Liveness verdict.
 */
function daemonAlive() {
  return liveness ? liveness.alive() : true;
}

module.exports = {
  TOPICS,
  RESYNC_REASONS,
  daemonAlive,
  isTopicAvailable,
  probeDaemon,
  start,
  stop,
  subscribe,
  // exported for tests
  availableTopics: () => [...availableTopics],
  resetForTesting: () => {
    subscribers.clear();
    stop();
  },
};
