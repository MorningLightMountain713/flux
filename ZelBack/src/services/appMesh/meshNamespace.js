// Operations on one mesh app's network namespace: the bind-mounted netns, the
// uplink into the host, the veth into each component container, the FLUX-MESH
// iptables chains, and the systemd units that live inside the namespace.
//
// Everything here is a primitive the reconciler composes; nothing decides
// membership or timing. Namespaces, veths and rules do not survive a reboot
// (/run is tmpfs, iptables is not persisted), so every ensure* is written to
// be re-run from scratch: link creation deletes any stale device first —
// rebuilding a virtual cable is cheaper and more honest than diffing one.
//
// Traffic plan the routes below implement:
//   outbound  container → (10.127/20 route) veth → app ns → siit0 (tayga,
//             v4→v6) → mesh0 (nebula) → peer node
//   inbound   nebula → mesh0, destination in this node's /96 block →
//             /96 route → siit0 (tayga, v6→v4) → presented /32 route →
//             veth → container
// The /96-into-tayga route outranks mesh0's connected /48; each container's
// presented /32 outranks the 10.127/20 into tayga.
const fsp = require('node:fs/promises');

const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');
const meshRuntimeConfig = require('./meshRuntimeConfig');

// Where `ip netns add` bind-mounts namespaces — also what the systemd units'
// NetworkNamespacePath points into.
const NETNS_DIR = '/run/netns';
const NETNS_PREFIX = 'flux-mesh-';
// Interface names are capped at 15 chars, so link ids stay short. The
// container-side device is always flux-mesh0 — it lives in the container's own
// namespace where nothing else of ours exists.
const CONTAINER_DEVICE = 'flux-mesh0';

const INSTANCE_RE = /^[a-z0-9][a-z0-9-]*$/;
const LINK_ID_RE = /^[a-z0-9]{1,8}$/;

function assertInstance(instance) {
  if (typeof instance !== 'string' || !INSTANCE_RE.test(instance)) {
    throw new TypeError('instance must be the app\'s identity segment');
  }
}

function netnsName(instance) {
  assertInstance(instance);
  return `${NETNS_PREFIX}${instance}`;
}

async function run(cmd, params, { tolerate } = {}) {
  const result = await serviceHelper.runCommand(cmd, { runAsRoot: true, logError: false, params });
  if (result.error) {
    const detail = `${result.error.message} ${result.stderr || ''}`;
    if (tolerate && detail.includes(tolerate)) return result;
    throw new Error(`${cmd} ${params.join(' ')} failed: ${detail.trim()}`);
  }
  return result;
}

const ip = (params, opts) => run('ip', params, opts);
const iptables = (params, opts) => run('iptables', params, opts);

/**
 * The app's namespace, created if absent. `ip netns add` bind-mounts it under
 * /run/netns, so it persists with zero processes in it.
 * @param {string} instance
 */
async function ensureNamespace(instance) {
  await ip(['netns', 'add', netnsName(instance)], { tolerate: 'File exists' });
}

/**
 * Tear the namespace down. The units inside it must already be stopped.
 * @param {string} instance
 */
async function destroyNamespace(instance) {
  await ip(['netns', 'delete', netnsName(instance)], { tolerate: 'No such file' });
}

/**
 * The identity segments of every mesh namespace present on the host. Empty
 * on a node with none — including one whose netns dir does not exist at all.
 * @returns {Promise<string[]>}
 */
async function listNamespaces() {
  let entries;
  try {
    entries = await fsp.readdir(NETNS_DIR);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((name) => name.startsWith(NETNS_PREFIX))
    .map((name) => name.slice(NETNS_PREFIX.length))
    .filter((instance) => INSTANCE_RE.test(instance));
}

/**
 * The veth pair joining the app namespace to the host — the underlay path
 * nebula's UDP rides. The host side carries the transit address the DNAT
 * targets; the namespace side becomes the namespace's default route.
 *
 * @param {string} instance
 * @param {{linkId: string, hostIp: string, namespaceIp: string, prefixLength: number}} transit
 */
async function ensureUplink(instance, {
  linkId, hostIp, namespaceIp, prefixLength,
}) {
  const ns = netnsName(instance);
  if (typeof linkId !== 'string' || !LINK_ID_RE.test(linkId)) {
    throw new TypeError('linkId must be 1-8 lowercase alphanumerics');
  }
  const hostIf = `fmu-${linkId}`;
  await ip(['link', 'delete', hostIf], { tolerate: 'Cannot find device' });
  await ip(['link', 'add', hostIf, 'type', 'veth', 'peer', 'name', 'uplink0', 'netns', ns]);
  await ip(['address', 'add', `${hostIp}/${prefixLength}`, 'dev', hostIf]);
  await ip(['link', 'set', hostIf, 'up']);
  await ip(['-n', ns, 'address', 'add', `${namespaceIp}/${prefixLength}`, 'dev', 'uplink0']);
  await ip(['-n', ns, 'link', 'set', 'uplink0', 'up']);
  await ip(['-n', ns, 'link', 'set', 'lo', 'up']);
  await ip(['-n', ns, 'route', 'replace', 'default', 'via', hostIp, 'dev', 'uplink0']);
}

/**
 * Packet forwarding inside the namespace — it routes between veths and tuns.
 * @param {string} instance
 */
async function enableForwarding(instance) {
  const ns = netnsName(instance);
  await run('ip', ['netns', 'exec', ns, 'sysctl', '-q', '-w', 'net.ipv4.ip_forward=1']);
  await run('ip', ['netns', 'exec', ns, 'sysctl', '-q', '-w', 'net.ipv6.conf.all.forwarding=1']);
}

/**
 * The veth into one component container, rebuilt whole: created host-side,
 * one end pushed into the app namespace, the other into the container by pid
 * and renamed to the stable in-container device. The container routes the
 * whole mesh IPv4 range at the link; the namespace proxy-ARPs for it and
 * routes the container's presented /32 back. Container recreation replumbs
 * only this — the namespace and its tunnels stay up.
 *
 * @param {string} instance
 * @param {{linkId: string, containerPid: number, presentedIp: string}} link
 *   linkId must be unique per component within the app
 */
async function attachContainer(instance, { linkId, containerPid, presentedIp }) {
  const ns = netnsName(instance);
  if (typeof linkId !== 'string' || !LINK_ID_RE.test(linkId)) {
    throw new TypeError('linkId must be 1-8 lowercase alphanumerics');
  }
  if (!Number.isInteger(containerPid) || containerPid <= 0) {
    throw new TypeError('containerPid must be the container\'s init pid');
  }
  const nsIf = `c-${linkId}`;
  const tmpIf = `fmt-${linkId}`;
  const nsenter = (params) => run('nsenter', ['-t', String(containerPid), '-n', ...params]);

  await ip(['-n', ns, 'link', 'delete', nsIf], { tolerate: 'Cannot find device' });
  await ip(['link', 'delete', tmpIf], { tolerate: 'Cannot find device' });
  await ip(['link', 'add', tmpIf, 'type', 'veth', 'peer', 'name', nsIf, 'netns', ns]);
  await ip(['link', 'set', tmpIf, 'netns', String(containerPid)]);
  await nsenter(['ip', 'link', 'set', tmpIf, 'name', CONTAINER_DEVICE]);
  await nsenter(['ip', 'address', 'add', `${presentedIp}/32`, 'dev', CONTAINER_DEVICE]);
  await nsenter(['ip', 'link', 'set', CONTAINER_DEVICE, 'mtu', String(meshRuntimeConfig.IPV4_FACE_MTU), 'up']);
  await nsenter(['ip', 'route', 'replace', meshRuntimeConfig.MESH_IPV4_RANGE, 'dev', CONTAINER_DEVICE]);

  await ip(['-n', ns, 'link', 'set', nsIf, 'mtu', String(meshRuntimeConfig.IPV4_FACE_MTU), 'up']);
  await run('ip', ['netns', 'exec', ns, 'sysctl', '-q', '-w', `net.ipv4.conf.${nsIf}.proxy_arp=1`]);
  await ip(['-n', ns, 'route', 'replace', `${presentedIp}/32`, 'dev', nsIf]);
}

/**
 * The presented address a container's mesh device currently carries, or null
 * when the device is absent — the probe that lets the reconciler skip
 * replumbing a healthy attachment (rebuilding one bounces the app's mesh
 * traffic, so it is reserved for actual drift).
 *
 * @param {number} containerPid
 * @returns {Promise<string|null>}
 */
async function containerAttachment(containerPid) {
  if (!Number.isInteger(containerPid) || containerPid <= 0) {
    throw new TypeError('containerPid must be the container\'s init pid');
  }
  const result = await serviceHelper.runCommand('nsenter', {
    runAsRoot: true,
    logError: false,
    params: ['-t', String(containerPid), '-n', 'ip', '-o', '-4', 'addr', 'show', CONTAINER_DEVICE],
  });
  if (result.error) return null;
  const match = /inet (\d+\.\d+\.\d+\.\d+)\//.exec(result.stdout);
  return match ? match[1] : null;
}

/**
 * Routes that steer traffic into the translator's tun. Callable only after
 * the tayga unit is up (the device exists only while it runs), which is why
 * they are separate from the namespace bring-up.
 *
 * @param {string} instance
 * @param {{ownBlock: string}} app the node's /96 in this app
 */
async function ensureTranslatorRoutes(instance, { ownBlock }) {
  const ns = netnsName(instance);
  const device = meshRuntimeConfig.TAYGA_TUN_DEVICE;
  await ip(['-n', ns, 'link', 'set', device, 'mtu', String(meshRuntimeConfig.IPV4_FACE_MTU), 'up']);
  await ip(['-n', ns, '-6', 'route', 'replace', ownBlock, 'dev', device]);
  await ip(['-n', ns, 'route', 'replace', meshRuntimeConfig.MESH_IPV4_RANGE, 'dev', device]);
}

// chain → [table, parent] — the three FLUX-MESH chains and where they hang.
const MESH_CHAINS = Object.freeze({
  'FLUX-MESH-PRE': ['nat', 'PREROUTING'],
  'FLUX-MESH-POST': ['nat', 'POSTROUTING'],
  'FLUX-MESH-FWD': ['filter', 'FORWARD'],
});

/**
 * The FLUX-MESH chains and their jumps from the built-in chains. iptables is
 * not idempotent, so existence is probed first; the jumps are re-asserted
 * every reconcile pass because Docker rebuilds FORWARD on daemon restart.
 */
async function ensureMeshChains() {
  for (const [chain, [table, parent]] of Object.entries(MESH_CHAINS)) {
    try {
      await iptables(['-t', table, '-L', chain, '-n']);
    } catch (error) {
      await iptables(['-t', table, '-N', chain]);
      log.info(`IPTABLES: ${chain} chain created`);
    }
    try {
      await iptables(['-t', table, '-C', parent, '-j', chain]);
    } catch (error) {
      await iptables(['-t', table, '-I', parent, '-j', chain]);
      log.info(`IPTABLES: ${chain} jump inserted into ${parent}`);
    }
  }
}

/**
 * Rewrite the FLUX-MESH chains to exactly the given rules — the union across
 * every mesh app, from meshRuntimeConfig.firewallRules. Flush-and-rewrite is
 * the whole point of owning the chains: no delete-by-exact-match, no
 * accumulation of stale rules.
 *
 * @param {{pre: string[][], post: string[][], fwd: string[][]}} rules
 */
async function setMeshChainRules({ pre, post, fwd }) {
  const bodies = { 'FLUX-MESH-PRE': pre, 'FLUX-MESH-POST': post, 'FLUX-MESH-FWD': fwd };
  for (const [chain, [table]] of Object.entries(MESH_CHAINS)) {
    await iptables(['-t', table, '-F', chain]);
    for (const rule of bodies[chain] || []) {
      await iptables(['-t', table, '-A', chain, ...rule]);
    }
  }
}

const systemctl = (action, unit) => run('systemctl', [action, unit]);

/**
 * The per-app units, by their template names. Nebula reloads in place;
 * tayga has no reload — a membership change rewrites tayga.conf and
 * restarts the unit (stateless SIIT, flows resume across it).
 */
const meshUnits = {
  startAll: (instance) => {
    assertInstance(instance);
    return Promise.all([
      systemctl('start', `flux-mesh@${instance}`),
      systemctl('start', `flux-mesh-tayga@${instance}`),
    ]);
  },
  nebulaActive: async (instance) => {
    assertInstance(instance);
    const result = await serviceHelper.runCommand('systemctl', {
      runAsRoot: true, logError: false, params: ['is-active', '--quiet', `flux-mesh@${instance}`],
    });
    return !result.error;
  },
  reloadNebula: (instance) => {
    assertInstance(instance);
    return systemctl('reload', `flux-mesh@${instance}`);
  },
  restartTayga: (instance) => {
    assertInstance(instance);
    return systemctl('restart', `flux-mesh-tayga@${instance}`);
  },
  stopAll: (instance) => {
    assertInstance(instance);
    return Promise.all([
      systemctl('stop', `flux-mesh@${instance}`),
      systemctl('stop', `flux-mesh-tayga@${instance}`),
    ]);
  },
};

module.exports = {
  netnsName,
  ensureNamespace,
  destroyNamespace,
  listNamespaces,
  ensureUplink,
  enableForwarding,
  attachContainer,
  containerAttachment,
  ensureTranslatorRoutes,
  ensureMeshChains,
  setMeshChainRules,
  meshUnits,
};
