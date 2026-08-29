'use strict';

const daemonServiceFluxnodeRpcs = require('./daemonService/daemonServiceFluxnodeRpcs');
const nodeListSource = require('./nodeListSource');
const networkStateManager = require('./utils/networkStateManager');
const fluxEventBus = require('./utils/fluxEventBus');
const { NodeDownTopology } = require('./utils/nodeDownTopology');

/**
 * @typedef {import('./utils/networkStateManager').Fluxnode} Fluxnode
 * @typedef {import('./fluxCommunicationUtils').FluxNetworkMessage} FluxNetworkMessage
 */

/**
 * The NetworkStateManager object. Responsible for fetching the nodelist,
 * and maintaining indexes for fast access.
 * @type {networkStateManager.NetworkStateManager | null}
 */
let stateManager = null;

/**
 * Resolves once the node list has been fetched and indexed. It exists before
 * start() is called, so a caller that arrives early waits for the state rather
 * than being handed an empty list and reading it as a network with no nodes.
 */
let resolveStarted;
let started = new Promise((resolve) => { resolveStarted = resolve; });

/**
 * The ring topology over the live list, one instance per manager lifecycle.
 * @type {NodeDownTopology | null}
 */
let ringTopology = null;
let ringTopologyManager = null;

/**
 * Throttle state for daemon RPC calls
 */
// eslint-disable-next-line no-unused-vars
const lastDaemonCallTimestamp = 0;
// eslint-disable-next-line no-unused-vars
const lastDaemonCallResult = [];
// eslint-disable-next-line no-unused-vars
const DAEMON_CALL_THROTTLE_MS = 30000; // 30 seconds

const fetcher = async (filter = null) => {
  // this is not how the function is supposed to be used, but it shouldn't take
  // an express req, res pair either. There should be an api function in front of it
  const rpcOptions = { params: { filter }, query: { filter: null } };

  const res = await daemonServiceFluxnodeRpcs.viewDeterministicFluxNodeList(
    rpcOptions,
  );

  const nodes = res.status === 'success' ? res.data : [];

  return nodes;
};

/**
 * Waits for the manager to fill itself by fetching, driven either by block events or
 * by its own timer. Used when the daemon does not publish the delta topic.
 * @param {number} waitTimeoutMs How long to wait before giving up, 0 for forever.
 * @returns {Promise<void>} Resolves once the state is populated.
 */
function startByFetching(waitTimeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = waitTimeoutMs ? setTimeout(
      () => reject(new Error('Unable To start NetworkStateService: Timeout reached')),
      waitTimeoutMs,
    ) : null;

    stateManager.once('populated', () => {
      clearTimeout(timeout);
      resolveStarted();
      resolve();
    });

    // Every refresh, with what the node now believes the fleet to be. Nothing in
    // production consumes it - the bus is test-only - and it exists because a
    // test that changes the node list otherwise has no way to know when this
    // node has read the change: the list is polled on a timer, and the only
    // endpoints that report one ask the daemon rather than this cache. Sleeping
    // long enough instead is the thing that turns into a flaky suite.
    stateManager.on('updated', () => {
      fluxEventBus.publish('networkstate:updated', { nodes: stateManager.nodeCount });
    });

    setImmediate(() => stateManager.start());
  });
}

/**
 * Brings up the flux network state.
 *
 * Prefers the delta stream, which keeps the list current for ~3 KB a block instead of
 * refetching ~7 MB. Falls back to fetching — on block events where an emitter is
 * supplied, on a timer otherwise — when the daemon does not publish the topic.
 *
 * @param {{
 *   waitTimeoutMs?: number,
 *   stateEmitter?: EventEmitter
 * }} options waitTimeoutMs - How long to wait for the promise to resolve  \
 * stateEmitter - the block eventEmitter
 * @returns {Promise<void>}
 */
async function start(options = {}) {
  if (stateManager) return;

  const waitTimeoutMs = options.waitTimeoutMs || 0;
  const stateEmitter = options.stateEmitter || null;

  stateManager = new networkStateManager.NetworkStateManager(fetcher, {
    stateEmitter,
    stateEvent: 'blocksProcessed',
    progressEvent: 'syncProgress',
  });

  const usingDeltas = await nodeListSource.start({ stateManager, listFetcher: fetcher });

  // The snapshot that anchors the delta stream has already populated the state, so
  // there is nothing left to wait for.
  if (usingDeltas) return;

  await startByFetching(waitTimeoutMs);
}

/**
 *
 * @returns {Promise<void>}
 */
async function stop() {
  if (!stateManager) return;

  nodeListSource.stop();
  await stateManager.stop();
  stateManager = null;
  started = new Promise((resolve) => { resolveStarted = resolve; });
}

/**
 * Returns the entire fluxnode network state
 * @param {{sort?: boolean}} options Sort by added height, then txid
 * @returns {Array<Fluxnode>}
 */
function networkState(options = {}) {
  if (!stateManager) return [];

  const sort = options.sort || false;

  const state = stateManager.state({ sort });

  return state;
}

/**
 * Whether the node list has been fetched and indexed.
 *
 * The bulk accessors - networkState(), nodeCount() - answer an unknown state
 * and a genuinely empty one with the same value, so a caller that would read
 * those differently asks this first rather than guessing. The lookups that
 * answer a question about one node do not: they wait for the list rather than
 * report it absent from a state that has never held it.
 * @returns {boolean}
 */
function isReady() {
  return Boolean(stateManager && stateManager.started);
}

/**
 * Runs a callback once the network state is known, immediately if it already is.
 *
 * This is for work that cannot begin without the node list, so that it starts
 * when the list arrives rather than whenever the next poll happens to come
 * round. Callers on a schedule of their own should use isReady() instead.
 * @param {Function} callback
 * @returns {void}
 */
function onReady(callback) {
  if (isReady()) {
    callback();
    return;
  }

  started.then(callback);
}

/**
 * Waits until the network state is known.
 *
 * Only for one-shot startup gates. Anything on a repeating schedule must use
 * isReady() - several of those only re-arm once they have finished, so awaiting
 * here would retire them for the life of the process rather than delay them.
 * @returns {Promise<void>}
 */
async function waitStarted() {
  await started;
}

function nodeCount() {
  if (!stateManager) return 0;

  return stateManager.nodeCount;
}

/**
 *
 * @param {string} pubkey
 * @returns {Promise<Map<string, Fluxnode>> | null>} Clone of state
 */
async function getFluxnodesByPubkey(pubkey) {
  if (!stateManager) return null;

  const nodes = await stateManager.search(pubkey, 'pubkey');

  return nodes;
}

/**
 *
 * @param {string} socketAddress
 * @returns {Promise<boolean>}
 */
async function socketAddressInNetworkState(socketAddress) {
  if (!stateManager) return false;

  // Default-port format ("ip" vs "ip:16127") is reconciled inside
  // networkStateManager, which canonicalises both index keys and lookups.
  return stateManager.includes(socketAddress, 'socketAddress');
}

/**
 *
 * @param {string} pubkey
 * @returns {Promise<boolean>}
 */
async function pubkeyInNetworkState(pubkey) {
  if (!stateManager) return false;

  const found = await stateManager.includes(pubkey, 'pubkey');

  return found;
}

/**
 *
 * @param {string} socketAddress
 * @returns {Promise<string | null>}
 */
async function getRandomSocketAddress(socketAddress) {
  if (!stateManager) return null;

  const random = await stateManager.getRandomSocketAddress(socketAddress);

  return random;
}

/**
 * Returns a sample of up to `count` random socket addresses from the network state,
 * honouring the diversity/exclusion options of NetworkStateManager.getRandomSocketAddressSample.
 * @param {number} count
 * @param {{excludeSocketAddress?: string, distinctPrefixes?: boolean, prefixLength?: number}} [options]
 * @returns {Promise<string[]>}
 */
async function getRandomSocketAddressSample(count, options) {
  if (!stateManager) return [];

  return stateManager.getRandomSocketAddressSample(count, options);
}

/**

/**
 * A random node that can observe this one from outside its address - i.e. not a
 * Flux node sharing our public address. Null when there is no such node.
 *
 * @param {string} socketAddress
 * @returns {Promise<string | null>}
 */
async function getRandomExternalObserver(socketAddress, options = {}) {
  if (!stateManager) return null;

  return stateManager.getRandomExternalObserver(socketAddress, options);
}

/**
 *
 * @param {string} socketAddress
 * @returns {Promise<Fluxnode | null>}
 */
async function getFluxnodeBySocketAddress(socketAddress) {
  if (!stateManager) return null;

  const node = await stateManager.search(socketAddress, 'socketAddress');

  return node;
}

/**
 * The fingerprint of the membership held now, or null before the first
 * snapshot lands.
 * @returns {string|null}
 */
function membershipFingerprint() {
  if (!stateManager) return null;
  return stateManager.membershipHistory.currentFingerprint();
}

/**
 * The membership at a fingerprint — the (txhash, outidx, pubkey, ip) triples
 * the committee walk consumes — or null when the fingerprint falls outside
 * the retained window. Exact or absent, never approximate.
 * @param {string} fingerprint
 * @returns {Array<object>|null}
 */
function membershipAt(fingerprint) {
  if (!stateManager) return null;
  return stateManager.membershipHistory.membershipAt(fingerprint);
}

/**
 * The fingerprint that was current at a height, or null when the window does
 * not reach back that far — how a founding ask resolves its registration
 * height to a committee basis.
 * @param {number} height
 * @returns {string|null}
 */
function membershipFingerprintAt(height) {
  if (!stateManager) return null;
  return stateManager.membershipHistory.fingerprintAt(height);
}

async function main() {
  start();

  console.log('Waiting for started');
  await stateManager.waitStarted;
  console.log('After started');

  setInterval(() => {
    console.log(stateManager.search('045ae66321cfc172086d79252323b6cd4b83460e580e88f220582affda8a83b3ec68078ad80f7e465c42c3ef9bc01b912b3663e2ba09057bc43fbedf0afa9f3864', 'pubkey'));
  }, 5_000);
}

if (require.main === module) {
  main();
}

/**
 * The node-down ring topology — jury, duty and at-fingerprint reads over the
 * SAME list and membership history the manager maintains (one substrate, R9).
 *
 * @returns {NodeDownTopology | null} null until the state manager exists
 */
function nodeDownTopology() {
  if (!stateManager) return null;
  if (ringTopology && ringTopologyManager === stateManager) return ringTopology;

  const manager = stateManager;
  ringTopology = new NodeDownTopology({
    nodes: () => manager.state(),
    membershipHistory: manager.membershipHistory,
  });
  ringTopologyManager = manager;
  return ringTopology;
}

module.exports = {
  getFluxnodeBySocketAddress,
  getFluxnodesByPubkey,
  getRandomSocketAddress,
  getRandomSocketAddressSample,
  getRandomExternalObserver,
  isReady,
  membershipAt,
  membershipFingerprint,
  membershipFingerprintAt,
  networkState,
  nodeCount,
  onReady,
  nodeDownTopology,
  pubkeyInNetworkState,
  socketAddressInNetworkState,
  start,
  stop,
  waitStarted,
};
