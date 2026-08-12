'use strict';

const daemonServiceFluxnodeRpcs = require('./daemonService/daemonServiceFluxnodeRpcs');
const nodeListSource = require('./nodeListSource');
const networkStateManager = require('./utils/networkStateManager');

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
      resolve();
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

async function waitStarted() {
  if (!stateManager) return;

  await stateManager.waitStarted;
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

module.exports = {
  getFluxnodeBySocketAddress,
  getFluxnodesByPubkey,
  getRandomSocketAddress,
  getRandomSocketAddressSample,
  membershipAt,
  membershipFingerprint,
  membershipFingerprintAt,
  networkState,
  nodeCount,
  pubkeyInNetworkState,
  socketAddressInNetworkState,
  start,
  stop,
  waitStarted,
};
