// The transport-port allocator: one host UDP port per mesh app per node, from
// 16226–16299 — inside the existing bannedPorts reservation, so apps cannot
// request these and no bannedPorts change is needed.
//
// Behind UPnP the pool is shared per GATEWAY, not per node: co-located nodes
// draw from the same ~74 ports, and AddPortMapping does what it is asked — it
// maps the port you name or errors, it does not assign one, and some routers
// silently overwrite an existing mapping instead of erroring. So allocation
// is enumerate → pick free → map → VERIFY by re-reading that the mapping
// points at this node → only then publish. A mapping that verifies as another
// node's is never removed and never fought over — the allocator just tries a
// different port; a port change is always a new port, never an edited
// mapping, because conntrack keeps applying the old translation to live
// flows.
//
// Without UPnP (a node on its own public address) the pool is node-local and
// allocation is just "not already used here".
const crypto = require('node:crypto');

const log = require('../../lib/log');
const upnpService = require('../upnpService');
const meshPorts = require('./meshPorts');

const MESH_PORT_START = 16226;
const MESH_PORT_END = 16299;
const POOL_SIZE = MESH_PORT_END - MESH_PORT_START + 1;
// How many candidate ports one allocation attempt tries before giving up —
// enough to ride out races with co-located nodes without hammering the
// router.
const MAX_MAP_ATTEMPTS = 8;

/**
 * The router's UDP mappings inside the mesh pool, by public port. Null when
 * the router cannot enumerate (some IGDs refuse GetGenericPortMappingEntry) —
 * distinct from "no mappings", which is an empty map.
 * @returns {Promise<Map<number, object>|null>}
 */
async function poolMappings() {
  try {
    const mappings = await upnpService.getUpnpMappings();
    const inPool = new Map();
    for (const entry of mappings || []) {
      const port = entry?.public?.port;
      if (String(entry?.protocol).toLowerCase() === 'udp'
        && Number.isInteger(port) && port >= MESH_PORT_START && port <= MESH_PORT_END) {
        inPool.set(port, entry);
      }
    }
    return inPool;
  } catch (error) {
    return null;
  }
}

async function mappingIsMine(port) {
  const mappings = await poolMappings();
  if (mappings === null) return null;
  const entry = mappings.get(port);
  if (!entry) return false;
  const myAddress = await upnpService.getLocalGatewayAddress();
  return entry.private?.host === myAddress;
}

async function mapAndVerify(port, instance) {
  const mapped = await upnpService.mapUpnpPort(port, `Flux_Mesh_${instance}`);
  if (!mapped) return false;
  const mine = await mappingIsMine(port);
  if (mine === null) {
    // The router mapped without erroring but cannot enumerate, so ownership
    // is unverifiable — the one hijack window the design closes stays open on
    // this router. Proceed on the map result, loudly.
    log.warn(`meshPortAllocator - router does not enumerate mappings; port ${port} for ${instance} is mapped but ownership is unverified`);
    return true;
  }
  return mine;
}

/**
 * Free ports of the pool in rotated order: a random starting offset so
 * co-located nodes racing an allocation spread over the pool instead of all
 * colliding on the lowest free port.
 */
function candidatePorts(taken, startOffset = crypto.randomInt(POOL_SIZE)) {
  const candidates = [];
  for (let i = 0; i < POOL_SIZE; i += 1) {
    const port = MESH_PORT_START + ((startOffset + i) % POOL_SIZE);
    if (!taken.has(port)) candidates.push(port);
  }
  return candidates;
}

/**
 * The app's secured transport port, allocating one on first use. Idempotent:
 * an existing verified allocation is kept and refreshed; an allocation the
 * router has since handed to someone else is replaced with a NEW port (the
 * next broadcast publishes it) and the old one is left alone.
 *
 * @param {string} instance the app's identity segment
 * @param {{startOffset?: number}} [opts] test seam for the rotation offset
 * @returns {Promise<number>}
 */
async function ensureTransportPort(instance, { startOffset } = {}) {
  const existing = await meshPorts.getPort(instance);
  const upnp = upnpService.isUPNP();

  if (!upnp) {
    if (existing) return existing;
    const taken = new Set(Object.values(await meshPorts.allPorts()));
    const [port] = candidatePorts(taken, startOffset ?? 0);
    if (!port) throw new Error('The mesh transport port pool is exhausted on this node');
    await meshPorts.setPort(instance, port);
    return port;
  }

  if (existing) {
    const mine = await mappingIsMine(existing);
    if (mine !== false) {
      // Verified ours, or unverifiable: refresh the mapping in place.
      await upnpService.mapUpnpPort(existing, `Flux_Mesh_${instance}`);
      return existing;
    }
    log.error(`meshPortAllocator - the router's mapping for port ${existing} (${instance}) now points elsewhere; allocating a new port`);
    await meshPorts.removePort(instance);
  }

  const mappings = await poolMappings();
  const taken = new Set([
    ...Object.values(await meshPorts.allPorts()),
    ...(mappings ? mappings.keys() : []),
  ]);
  const candidates = candidatePorts(taken, startOffset).slice(0, MAX_MAP_ATTEMPTS);
  if (candidates.length === 0) {
    throw new Error('The mesh transport port pool is exhausted on this gateway');
  }
  // eslint-disable-next-line no-restricted-syntax
  for (const port of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const secured = await mapAndVerify(port, instance);
    if (secured) {
      // eslint-disable-next-line no-await-in-loop
      await meshPorts.setPort(instance, port);
      return port;
    }
  }
  throw new Error(`No mesh transport port could be secured for ${instance} after ${candidates.length} attempts`);
}

/**
 * Release an app's port on uninstall: unmap ours, forget the allocation.
 * @param {string} instance
 */
async function releaseTransportPort(instance) {
  const port = await meshPorts.getPort(instance);
  if (!port) return;
  if (upnpService.isUPNP()) {
    const mine = await mappingIsMine(port);
    // Never remove a mapping that verifies as someone else's.
    if (mine !== false) await upnpService.removeMapUpnpPort(port);
  }
  await meshPorts.removePort(instance);
}

/**
 * The refresh sweep, on the existing UPnP cadence: re-assert every allocation
 * still ours; replace any the router has handed away. Returns the instances
 * whose port CHANGED — their next broadcast republishes, and the reconciler
 * regenerates their nebula config.
 *
 * @returns {Promise<string[]>}
 */
async function refreshTransportPorts() {
  if (!upnpService.isUPNP()) return [];
  const changed = [];
  const allocations = await meshPorts.allPorts();
  // eslint-disable-next-line no-restricted-syntax
  for (const [instance, port] of Object.entries(allocations)) {
    // eslint-disable-next-line no-await-in-loop
    const kept = await ensureTransportPort(instance);
    if (kept !== port) changed.push(instance);
  }
  return changed;
}

/**
 * Every instance currently holding a port allocation on this node.
 * @returns {Promise<string[]>}
 */
async function allocatedInstances() {
  return Object.keys(await meshPorts.allPorts());
}

module.exports = {
  MESH_PORT_START,
  MESH_PORT_END,
  ensureTransportPort,
  releaseTransportPort,
  refreshTransportPorts,
  allocatedInstances,
};
