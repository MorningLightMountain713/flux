const config = require('config');
const log = require('../../lib/log');
const dockerService = require('../dockerService');
const { getSpecBackend } = require('../utils/specLibs');
const playgroundEgress = require('./playgroundEgress');

// The docker network a playground session runs on: which slot it takes out of
// the reserved octet, and getting it created with the egress policy already in
// force.
//
// The firewall and rate-cap work lives in playgroundEgress, which deliberately
// does not import dockerService - fluxNetworkHelper has to call into it to
// restore the DOCKER-USER jump, and dockerService imports fluxNetworkHelper.
//
// A session's network is named for the SESSION, never for the spec's app name.
// An app network is created idempotently - an existing one of the same name is
// adopted, not rejected - so a session sharing the name of an app this node
// runs would silently hand a paid app the session's rate-capped /27, or attach
// a stranger's containers to the app's /24 with no egress policy at all. The
// two namespaces cannot overlap, so neither can happen.

const { BRIDGE_PREFIX } = playgroundEgress;

// Names the docker network. Distinct from fluxDockerNetwork_ by construction,
// which also takes session networks out of the app debris sweep - it enumerates
// on the app prefix, so it can no longer reap one out from under a live session.
const NETWORK_PREFIX = 'fluxPlayground_';

/** The docker network one session owns. */
function networkNameFor(sessionId) {
  return `${NETWORK_PREFIX}${sessionId}`;
}

function networkOctet() {
  return config.fluxapps.playgroundNetworkOctet ?? 255;
}

function networkPrefix() {
  return config.fluxapps.playgroundNetworkPrefix ?? 27;
}

/** Addresses in one session subnet: 32 at /27. */
function subnetSize() {
  return 2 ** (32 - networkPrefix());
}

/** How many session subnets fit in the reserved octet: 8 at /27. */
function slotCount() {
  return Math.floor(256 / subnetSize());
}

function slotBase(slot) {
  return slot * subnetSize();
}

function bridgeFor(slot) {
  return `${BRIDGE_PREFIX}${slot}`;
}

/**
 * The lowest session slot whose bridge is not already in use.
 *
 * Read from docker rather than tracked in memory, so a restart cannot hand out
 * a slot whose network still exists.
 *
 * Enumerated by LABEL rather than by name. Session networks sit outside the app
 * namespace, so the app-prefixed listing does not see them at all - asking it
 * would report every slot free and hand the same bridge name to two concurrent
 * sessions.
 *
 * @returns {Promise<number|null>} slot index, or null when all are taken
 */
async function allocateSlot() {
  const { LABEL_KEYS } = await getSpecBackend();
  const networks = await dockerService.dockerListNetworksByLabel(LABEL_KEYS.PLAYGROUND_SESSION);
  const taken = new Set();

  networks.forEach((network) => {
    const named = network.Options && network.Options['com.docker.network.bridge.name'];
    if (named && named.startsWith(BRIDGE_PREFIX)) {
      const slot = Number(named.slice(BRIDGE_PREFIX.length));
      if (Number.isInteger(slot)) taken.add(slot);
    }
  });

  for (let slot = 0; slot < slotCount(); slot += 1) {
    if (!taken.has(slot)) return slot;
  }
  return null;
}

/**
 * Remove the session networks no live session claims.
 *
 * The app debris sweep used to collect these incidentally, back when a session
 * network was named like an app's and looked unowned. It cannot see them any
 * more, and a leaked network holds its bridge slot for the life of the node -
 * so the sweep the playground already runs over its containers has to cover its
 * networks too. After a restart there are no live ids and every one of them is
 * by definition abandoned.
 *
 * @param {Set<string>} liveSessionIds ids the service still owns
 * @returns {Promise<{removed: number, networks: string[]}>}
 */
async function reapOrphanNetworks(liveSessionIds) {
  const { LABEL_KEYS } = await getSpecBackend();
  let networks;
  try {
    networks = await dockerService.dockerListNetworksByLabel(LABEL_KEYS.PLAYGROUND_SESSION);
  } catch (error) {
    log.warn(`playground: network sweep could not list networks: ${error.message}`);
    return { removed: 0, networks: [] };
  }

  const removed = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const network of networks) {
    const sessionId = network.Labels && network.Labels[LABEL_KEYS.PLAYGROUND_SESSION];
    // eslint-disable-next-line no-continue
    if (!sessionId || liveSessionIds.has(sessionId)) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await dockerService.forceRemoveFluxAppDockerNetwork(null, { networkName: network.Name });
      removed.push(network.Name);
      log.info(`playground: reaped orphaned session network ${network.Name}`);
    } catch (error) {
      log.warn(`playground: could not reap ${network.Name}: ${error.message}`);
    }
  }

  return { removed: removed.length, networks: removed };
}

/**
 * Create the network a session runs on, and put its rate cap in place.
 *
 * The egress policy is ensured on every session rather than once at startup: it
 * costs a handful of idempotent iptables calls, and it means a chain something
 * else flushed is rebuilt BEFORE a guest's container is attached to it rather
 * than after.
 *
 * @param {string} sessionId - names the docker network and stamps its ownership
 * @returns {Promise<{slot: number, bridge: string, subnet: string, networkName: string}>}
 */
async function createSessionNetwork(sessionId) {
  const { LABEL_KEYS } = await getSpecBackend();
  const inForce = await playgroundEgress.ensureEgressPolicy();
  if (!inForce) {
    // Refused rather than run unshielded. A session with no egress policy is
    // precisely what this feature must never hand a stranger.
    throw new Error('This node could not put the playground egress policy in place, so it is not starting a session.');
  }

  const slot = await allocateSlot();
  if (slot === null) {
    const busy = new Error('This node has no free playground network slot. Try another node.');
    busy.kind = 'busy';
    throw busy;
  }

  const octet = networkOctet();
  const base = slotBase(slot);
  const bridge = bridgeFor(slot);
  const networkName = networkNameFor(sessionId);

  await dockerService.createFluxAppDockerNetwork(null, octet, {
    prefix: networkPrefix(),
    base,
    bridgeName: bridge,
    networkName,
    // The session's own stamp, not an app-network one. It is what the slot
    // allocator and the network sweep enumerate on, and what keeps the app
    // debris sweep from ever attributing this network to an app.
    labels: { [LABEL_KEYS.PLAYGROUND_SESSION]: sessionId },
  });

  const shaped = await playgroundEgress.shapeBridge(bridge);
  if (!shaped) {
    // Not fatal: the egress policy is what contains a session, and that is
    // already in force. An uncapped session is still bounded by the duty cycle.
    log.warn(`playground: ${bridge} is running without a rate cap`);
  }

  return {
    slot, bridge, networkName, subnet: `172.23.${octet}.${base}/${networkPrefix()}`,
  };
}

module.exports = {
  NETWORK_PREFIX,
  networkNameFor,
  slotCount,
  slotBase,
  bridgeFor,
  allocateSlot,
  createSessionNetwork,
  reapOrphanNetworks,
};
