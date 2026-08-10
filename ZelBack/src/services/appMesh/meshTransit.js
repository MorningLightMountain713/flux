// The transit subnet allocator: the /30 each mesh app's uplink veth carries
// between the host and the app's namespace. Assignments are node-local and
// nothing durable references them — every consumer (veth addresses, DNAT,
// MASQUERADE, routes) is rebuilt in the same reconcile pass that asks — so
// nothing is persisted. A running app's slot is adopted from the address its
// live uplink already carries, which keeps a FluxOS restart from renumbering
// a working underlay; genuinely new apps take the lowest slot no live
// interface holds.
const serviceHelper = require('../serviceHelper');
const meshNamespace = require('./meshNamespace');

// 169.254 is unroutable by definition and the established home of the node's
// own container-facing services (fluxNodeService .43.43, flux-dnsd .43.53);
// this block is clear of both. 256 /30 slots, far above the per-gateway mesh
// app ceiling.
const TRANSIT_RANGE = '169.254.108.0/22';
const PREFIX_LENGTH = 30;
const SLOT_COUNT = 256;

const RANGE_BASE = (((169 * 256 + 254) * 256 + 108) * 256);

// instance → slot, the process-lifetime ledger. Repopulated by adoption after
// a restart; emptied per app on release.
const assignments = new Map();

// Allocation decisions read shared state across awaits, so they are
// serialised — two apps arriving together must not scan past each other and
// pick the same slot.
let allocationChain = Promise.resolve();
function serialised(fn) {
  const next = allocationChain.then(fn, fn);
  allocationChain = next.catch(() => {});
  return next;
}

function ipOfOffset(offset) {
  const value = RANGE_BASE + offset;
  return [
    Math.floor(value / 16777216) % 256,
    Math.floor(value / 65536) % 256,
    Math.floor(value / 256) % 256,
    value % 256,
  ].join('.');
}

/**
 * The addressing of one transit slot. Pure.
 *
 * @param {number} slot 0..255
 * @returns {{slot: number, linkId: string, subnet: string, hostIp: string,
 *   namespaceIp: string, prefixLength: number}}
 */
function transitForSlot(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) {
    throw new TypeError(`slot must be an integer in 0..${SLOT_COUNT - 1}`);
  }
  const base = slot * 4;
  return {
    slot,
    linkId: String(slot),
    subnet: `${ipOfOffset(base)}/${PREFIX_LENGTH}`,
    hostIp: ipOfOffset(base + 1),
    namespaceIp: ipOfOffset(base + 2),
    prefixLength: PREFIX_LENGTH,
  };
}

/**
 * The slot a namespace-side uplink address belongs to, or null when the
 * address is not a transit namespace address. Pure.
 *
 * @param {string} ip
 * @returns {number|null}
 */
function slotOfNamespaceIp(ip) {
  const parts = typeof ip === 'string' ? ip.split('.').map(Number) : [];
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  const value = ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
  const offset = value - RANGE_BASE;
  if (offset < 0 || offset >= SLOT_COUNT * 4 || offset % 4 !== 2) return null;
  return (offset - 2) / 4;
}

/**
 * Slots held by live uplink interfaces, read off `ip -o link show` output —
 * the interfaces of apps this process has not adopted yet. Pure.
 *
 * @param {string} linkShowOutput
 * @returns {Set<number>}
 */
function slotsOfLinkShow(linkShowOutput) {
  const slots = new Set();
  const re = /\bfmu-(\d+)[@:]/g;
  let match = re.exec(linkShowOutput);
  while (match !== null) {
    const slot = Number(match[1]);
    if (slot >= 0 && slot < SLOT_COUNT) slots.add(slot);
    match = re.exec(linkShowOutput);
  }
  return slots;
}

/**
 * The slot the app's live uplink actually carries right now, or null when no
 * addressed uplink exists. The adoption read, also the reconciler's health
 * probe — a live slot equal to the assignment means the veth needs no
 * rebuild.
 *
 * @param {string} instance
 * @returns {Promise<number|null>}
 */
async function observedSlot(instance) {
  const ns = meshNamespace.netnsName(instance);
  const result = await serviceHelper.runCommand('ip', {
    runAsRoot: true,
    logError: false,
    params: ['-n', ns, '-o', '-4', 'addr', 'show', 'uplink0'],
  });
  if (result.error) return null;
  const match = /inet (\d+\.\d+\.\d+\.\d+)\/(\d+)/.exec(result.stdout);
  if (!match || Number(match[2]) !== PREFIX_LENGTH) return null;
  return slotOfNamespaceIp(match[1]);
}

/**
 * The app's transit slot: the in-memory assignment, else the one its live
 * uplink already carries, else the lowest slot no assignment and no live
 * fmu-* interface holds.
 *
 * @param {string} instance the app's identity segment
 * @returns {Promise<{slot: number, linkId: string, subnet: string,
 *   hostIp: string, namespaceIp: string, prefixLength: number}>}
 */
function ensureTransit(instance) {
  return serialised(async () => {
    meshNamespace.netnsName(instance);
    if (assignments.has(instance)) return transitForSlot(assignments.get(instance));

    const adopted = await observedSlot(instance);
    if (adopted !== null) {
      assignments.set(instance, adopted);
      return transitForSlot(adopted);
    }

    const links = await serviceHelper.runCommand('ip', {
      runAsRoot: true, logError: false, params: ['-o', 'link', 'show'],
    });
    const occupied = links.error ? new Set() : slotsOfLinkShow(links.stdout);
    assignments.forEach((slot) => occupied.add(slot));
    for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
      if (!occupied.has(slot)) {
        assignments.set(instance, slot);
        return transitForSlot(slot);
      }
    }
    throw new Error('The mesh transit range is exhausted on this node');
  });
}

/**
 * Forget an app's assignment (uninstall; the veth pair dies with the
 * namespace).
 * @param {string} instance
 */
function releaseTransit(instance) {
  assignments.delete(instance);
}

/**
 * Every instance currently holding a transit assignment.
 * @returns {string[]}
 */
function assignedInstances() {
  return [...assignments.keys()];
}

module.exports = {
  TRANSIT_RANGE,
  transitForSlot,
  slotOfNamespaceIp,
  slotsOfLinkShow,
  observedSlot,
  ensureTransit,
  releaseTransit,
  assignedInstances,
};
