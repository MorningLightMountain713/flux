const config = require('config');
const log = require('../../lib/log');
const dockerService = require('../dockerService');
const playgroundEgress = require('./playgroundEgress');

// The docker network a playground session runs on: which slot it takes out of
// the reserved octet, and getting it created with the egress policy already in
// force.
//
// The firewall and rate-cap work lives in playgroundEgress, which deliberately
// does not import dockerService - fluxNetworkHelper has to call into it to
// restore the DOCKER-USER jump, and dockerService imports fluxNetworkHelper.

const { BRIDGE_PREFIX } = playgroundEgress;

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
 * @returns {Promise<number|null>} slot index, or null when all are taken
 */
async function allocateSlot() {
  const networks = await dockerService.getFluxDockerNetworks();
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
 * Create the network a session runs on, and put its rate cap in place.
 *
 * The egress policy is ensured on every session rather than once at startup: it
 * costs a handful of idempotent iptables calls, and it means a chain something
 * else flushed is rebuilt BEFORE a guest's container is attached to it rather
 * than after.
 *
 * @param {string} appName - names the docker network
 * @returns {Promise<{slot: number, bridge: string, subnet: string}>}
 */
async function createSessionNetwork(appName) {
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

  await dockerService.createFluxAppDockerNetwork(appName, octet, {
    prefix: networkPrefix(),
    base,
    bridgeName: bridge,
  });

  const shaped = await playgroundEgress.shapeBridge(bridge);
  if (!shaped) {
    // Not fatal: the egress policy is what contains a session, and that is
    // already in force. An uncapped session is still bounded by the duty cycle.
    log.warn(`playground: ${bridge} is running without a rate cap`);
  }

  return { slot, bridge, subnet: `172.23.${octet}.${base}/${networkPrefix()}` };
}

module.exports = {
  slotCount,
  slotBase,
  bridgeFor,
  allocateSlot,
  createSessionNetwork,
};
