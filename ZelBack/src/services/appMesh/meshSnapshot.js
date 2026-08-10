'use strict';

// The resolver feed: one node-wide membership.json, written to the contract
// flux-dnsd pins in its README. The writer must land a temp file in the SAME
// directory and rename it over the target (the daemon reloads only on that
// rename; a cross-filesystem move is not a rename and never triggers it), and
// `generation` must STRICTLY increase — the daemon rejects equal as replay.
//
// The snapshot doubles as the address ledger: each (component, node) member
// keeps the IPv4 it was presented with in the previous snapshot, and only new
// members are assigned fresh addresses from the mesh range. Stability matters
// because the same assignment feeds the tayga map and the DNS answers — a
// member whose address moved mid-flow would strand connections for no reason.
// Losing the file loses only assignments: everything reassigns on the next
// write and containers re-resolve within the 5-second DNS TTL.
const fsp = require('node:fs/promises');
const path = require('node:path');

const { MESH_IPV4_RANGE } = require('./meshRuntimeConfig');

const RESOLVER_DIR = '/var/lib/flux-mesh/resolver';
const SNAPSHOT_FILE = 'membership.json';
const SCHEMA_VERSION = 1;

const rangeBase = MESH_IPV4_RANGE.split('/')[0].split('.').map(Number);
const rangeBits = Number(MESH_IPV4_RANGE.split('/')[1]);
const RANGE_SIZE = 2 ** (32 - rangeBits);

function ipAtOffset(offset) {
  const base = ((rangeBase[0] * 256 + rangeBase[1]) * 256 + rangeBase[2]) * 256 + rangeBase[3];
  const value = base + offset;
  return [
    Math.floor(value / 16777216) % 256,
    Math.floor(value / 65536) % 256,
    Math.floor(value / 256) % 256,
    value % 256,
  ].join('.');
}

/**
 * The currently deployed snapshot, or null before the first write.
 * @returns {Promise<object|null>}
 */
async function readCurrentSnapshot() {
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(RESOLVER_DIR, SNAPSHOT_FILE), 'utf8'));
    return Number.isInteger(parsed.generation) ? parsed : null;
  } catch (error) {
    return null;
  }
}

/**
 * Assign each (app, component, node) member its presented IPv4, keeping every
 * assignment the previous snapshot made and drawing fresh addresses for new
 * members from the lowest free offsets. Pure.
 *
 * @param {object|null} previous the current snapshot (the ledger)
 * @param {Array<{name: string, members: Array<{component: string, nodeId: string}>}>} apps
 * @returns {Map<string, string>} `${app}|${nodeId}|${component}` → IPv4
 */
function assignMemberAddresses(previous, apps) {
  const assigned = new Map();
  const used = new Set();
  for (const app of previous?.apps ?? []) {
    for (const member of app.members ?? []) {
      if (typeof member.ip === 'string') {
        assigned.set(`${app.name}|${member.nodeId}|${member.component}`, member.ip);
        used.add(member.ip);
      }
    }
  }
  let cursor = 1; // offset 0 is the range base; never presented
  const nextFree = () => {
    while (cursor < RANGE_SIZE - 1) {
      const ip = ipAtOffset(cursor);
      cursor += 1;
      if (!used.has(ip)) return ip;
    }
    throw new Error('mesh IPv4 range exhausted');
  };
  const result = new Map();
  for (const app of apps) {
    for (const member of app.members) {
      const key = `${app.name}|${member.nodeId}|${member.component}`;
      let ip = assigned.get(key);
      if (!ip) {
        ip = nextFree();
        used.add(ip);
      }
      result.set(key, ip);
    }
  }
  return result;
}

/**
 * Build and atomically deploy the snapshot. Returns what was written,
 * including every member's assigned address (the same assignment the caller
 * feeds into the tayga map).
 *
 * Members carry no liveness: DNS answers the membership set (admitted to the
 * overlay), and whether a member is up right now is the cluster software's
 * own protocol to decide. `components` is the SRV feed — each component's
 * mesh-advertised ports by name.
 *
 * @param {string} ownNodeId this node's member id
 * @param {Array<{name: string,
 *   components: Object<string, {ports: Object<string, {port: number, proto: string}>}>,
 *   members: Array<{component: string, nodeId: string, ordinal?: number}>,
 *   containers: Array<{component: string, sourceIp: string}>}>} apps
 * @returns {Promise<{generation: number, snapshot: object, addresses: Map<string, string>}>}
 */
async function writeSnapshot(ownNodeId, apps) {
  const previous = await readCurrentSnapshot();
  const addresses = assignMemberAddresses(previous, apps);
  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    generation: (previous?.generation ?? 0) + 1,
    nodeId: ownNodeId,
    apps: apps.map((app) => ({
      name: app.name,
      components: app.components ?? {},
      members: app.members.map((member) => ({
        component: member.component,
        nodeId: member.nodeId,
        ip: addresses.get(`${app.name}|${member.nodeId}|${member.component}`),
        ...(Number.isInteger(member.ordinal) ? { ordinal: member.ordinal } : {}),
      })),
      containers: app.containers,
    })),
  };
  await fsp.mkdir(RESOLVER_DIR, { recursive: true, mode: 0o755 });
  const target = path.join(RESOLVER_DIR, SNAPSHOT_FILE);
  const tmp = path.join(RESOLVER_DIR, `.${SNAPSHOT_FILE}.tmp`);
  await fsp.writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
  await fsp.rename(tmp, target);
  return { generation: snapshot.generation, snapshot, addresses };
}

module.exports = {
  RESOLVER_DIR,
  readCurrentSnapshot,
  assignMemberAddresses,
  writeSnapshot,
};
