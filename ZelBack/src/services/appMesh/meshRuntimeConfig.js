'use strict';

// Generators for every runtime artifact a mesh app needs on one node: the
// nebula config, the tayga translator config, and the iptables rules for the
// FLUX-MESH chains. All pure — membership in, text/rules out — because the
// generated config is where this design can fail silently (a missing
// local_cidr drops every container packet with nothing logged), so the exact
// output is pinned by golden vectors and the writers stay trivial.
//
// Emitted YAML is hand-rolled and deterministic (members sorted by overlay
// address): byte-stable output means a reconciler can compare generated
// against deployed text to decide whether a reload is due.
const path = require('node:path');

const meshDerivation = require('./meshDerivation');
const { MESH_STATE_ROOT, TRUST_BUNDLE_FILE } = require('./meshCertificates');

// The overlay tun carries 1420 so that the IPv4 face's 1400 always fits after
// the 20-byte IPv6 growth — with both faces fixed, no packet can ever exceed
// either side, and the translator never needs to send packet-too-big across
// the overlay.
const OVERLAY_MTU = 1420;
const IPV4_FACE_MTU = 1400;
const NEBULA_TUN_DEVICE = 'mesh0';
const TAYGA_TUN_DEVICE = 'siit0';
// The per-app IPv4 view: local components' presented addresses and remote
// members' synthetic addresses are both assigned from this range. It is
// container-local (never on the wire, never agreed between nodes), and the
// whole range is routed into every mesh container — so it is sized to the
// need, not the octet: 4,094 addresses covers the 200-member ceiling today
// (20 instances × 10 components) and the ~100-node cap the design gates
// behind a future PoC, while shadowing as little as possible of the
// customer's own 10/8 inside their container. 10.127 echoes the 16127 port
// family and is clear of the defaults that share hosts with us: Docker
// (172.16/12), podman (10.88/16), OpenVPN (10.8), k3s (10.42/10.43),
// Kubernetes services (10.96) and flannel (10.244).
const MESH_IPV4_RANGE = '10.127.0.0/20';
// The translator's IPv4 for locally originated ICMP errors: 192.0.0.2 is the
// address RFC 7335 reserves for exactly this role, unroutable by design.
const TAYGA_IPV4_ADDR = '192.0.0.2';
// Nebula's embedded SSH interface, on the namespace's own loopback: the only
// query surface the daemon has (peer table, loaded certificate), read by the
// impersonation detector and the renewal read-back. Loopback is per-namespace,
// so nothing outside the host can reach it; nebula refuses port 22.
const SSHD_LISTEN = '127.0.0.1:2222';
const SSHD_USER = 'fluxos';
const SSH_HOST_KEY_FILE = 'ssh_host_ed25519_key';

const quoted = (value) => `"${value}"`;

function assertMembers(members) {
  if (!Array.isArray(members)) {
    throw new TypeError('members must be an array of peer members');
  }
  members.forEach((member) => {
    if (!member || typeof member.address !== 'string' || typeof member.block !== 'string'
      || typeof member.endpoint !== 'string'
      || !Array.isArray(member.caShas) || member.caShas.length === 0
      || member.caShas.some((sha) => typeof sha !== 'string' || sha === '')) {
      throw new TypeError('each member needs address, block, endpoint and a non-empty caShas array');
    }
  });
}

/**
 * The nebula configuration for one mesh app on this node.
 *
 * Every choice here that is not obvious carries its reason:
 * - `disconnect_invalid` is nebula's code default but the published docs claim
 *   otherwise, and eviction depends on it entirely — so it is pinned.
 * - `static_host_map` carries every peer and no lighthouse exists: with at
 *   most 20 members the full map is gossiped, and a lighthouse would be an
 *   admission point the trust model does not have.
 * - `local_allow_list` suppresses the private ranges, or members advertise
 *   their docker-bridge and link-local addresses as candidate endpoints and
 *   peers waste handshakes on them.
 * - `use_relays` is off: the design carries no relay role.
 * - The embedded `sshd` is the daemon's only query surface. It answers on the
 *   namespace's own loopback to a single authorized key FluxOS holds, and
 *   behind it is nebula's fixed command set — no shell, no file transfer.
 * - Firewall rules are per (member, authority), `ca_sha`-bound, with `cidr`
 *   AND `local_cidr` on BOTH directions: a certificate carrying
 *   unsafeNetworks turns off nebula's "local CIDR defaults to any", so an
 *   outbound rule without `local_cidr` silently drops every packet sourced
 *   from a container. A member carries every authority of its published
 *   bundle (two during a rotation overlap), one rule pair each.
 * - `unsafe_routes` sends each peer's block via that peer's own address —
 *   containers live behind their node, not on the overlay.
 *
 * @param {{instance: string, appUuid: string, outpoint: string, listenPort: number,
 *   members: Array<{address: string, block: string, endpoint: string, caShas: string[]}>,
 *   sshClientPublicKey: string}} app
 *   members are the accepted peers, this node excluded; sshClientPublicKey is
 *   the node-wide OpenSSH public key line the detector authenticates with
 * @returns {string} config.yml text
 */
function nebulaConfig({
  instance, appUuid, outpoint, listenPort, members, sshClientPublicKey,
}) {
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    throw new TypeError('listenPort must be a valid port number');
  }
  if (typeof sshClientPublicKey !== 'string' || sshClientPublicKey === ''
    || sshClientPublicKey.includes('\n')) {
    throw new TypeError('sshClientPublicKey must be a single-line OpenSSH public key');
  }
  assertMembers(members);
  const dir = path.join(MESH_STATE_ROOT, instance);
  const ownBlock = meshDerivation.nodeBlock(appUuid, outpoint);
  const peers = [...members].sort((a, b) => (a.address < b.address ? -1 : 1));

  const lines = [
    `# Generated by FluxOS for mesh app ${instance}. Rewritten on membership`,
    '# change; do not edit.',
    'pki:',
    `  ca: ${path.join(dir, TRUST_BUNDLE_FILE)}`,
    `  cert: ${path.join(dir, 'host.crt')}`,
    `  key: ${path.join(dir, 'host.key')}`,
    '  disconnect_invalid: true',
    'static_host_map:',
    ...peers.map((m) => `  ${quoted(m.address)}: [${quoted(m.endpoint)}]`),
    'lighthouse:',
    '  am_lighthouse: false',
    '  hosts: []',
    '  local_allow_list:',
    `    ${quoted('10.0.0.0/8')}: false`,
    `    ${quoted('172.16.0.0/12')}: false`,
    `    ${quoted('192.168.0.0/16')}: false`,
    `    ${quoted('169.254.0.0/16')}: false`,
    'listen:',
    `  host: ${quoted('0.0.0.0')}`,
    `  port: ${listenPort}`,
    'punchy:',
    '  punch: true',
    '  respond: true',
    'relay:',
    '  am_relay: false',
    '  use_relays: false',
    'sshd:',
    '  enabled: true',
    `  listen: ${quoted(SSHD_LISTEN)}`,
    `  host_key: ${path.join(dir, SSH_HOST_KEY_FILE)}`,
    '  authorized_users:',
    `    - user: ${SSHD_USER}`,
    '      keys:',
    `        - ${quoted(sshClientPublicKey)}`,
    'tun:',
    `  dev: ${NEBULA_TUN_DEVICE}`,
    `  mtu: ${OVERLAY_MTU}`,
  ];
  if (peers.length === 0) {
    lines.push('  unsafe_routes: []');
  } else {
    lines.push('  unsafe_routes:');
    peers.forEach((m) => {
      lines.push(`    - route: ${quoted(m.block)}`);
      lines.push(`      via: ${quoted(m.address)}`);
    });
  }
  lines.push('firewall:');
  for (const direction of ['outbound', 'inbound']) {
    if (peers.length === 0) {
      lines.push(`  ${direction}: []`);
    } else {
      lines.push(`  ${direction}:`);
      peers.forEach((m) => {
        m.caShas.forEach((caSha) => {
          lines.push('    - port: any');
          lines.push('      proto: any');
          lines.push(`      ca_sha: ${quoted(caSha)}`);
          lines.push(`      cidr: ${quoted(m.block)}`);
          lines.push(`      local_cidr: ${quoted(ownBlock)}`);
        });
      });
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The tayga configuration for one mesh app on this node: the stateless SIIT
 * map between every member's overlay IPv6 and the IPv4 this node presents for
 * it. Map entries are the caller's (the same assignment the resolver snapshot
 * publishes); a membership change is a rewrite plus a unit restart — tayga
 * has no reload.
 *
 * @param {{instance: string, appUuid: string, outpoint: string,
 *   mapEntries: Array<{ipv4: string, ipv6: string}>}} app
 * @returns {string} tayga.conf text
 */
function taygaConfig({
  instance, appUuid, outpoint, mapEntries,
}) {
  if (!Array.isArray(mapEntries)) {
    throw new TypeError('mapEntries must be an array');
  }
  mapEntries.forEach((entry) => {
    if (!entry || typeof entry.ipv4 !== 'string' || typeof entry.ipv6 !== 'string') {
      throw new TypeError('each map entry needs ipv4 and ipv6');
    }
  });
  const sorted = [...mapEntries].sort((a, b) => (a.ipv4 < b.ipv4 ? -1 : 1));
  const lines = [
    `# Generated by FluxOS for mesh app ${instance}. Rewritten on membership`,
    '# change (tayga has no reload; the unit is restarted); do not edit.',
    `tun-device ${TAYGA_TUN_DEVICE}`,
    `ipv4-addr ${TAYGA_IPV4_ADDR}`,
    `ipv6-addr ${meshDerivation.translatorAddress(appUuid, outpoint)}`,
    ...sorted.map((entry) => `map ${entry.ipv4} ${entry.ipv6}`),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * The iptables rules for one mesh app, as argv arrays for the three FLUX-MESH
 * chains. The chains themselves are FluxOS-owned (created and flushed whole,
 * jumps re-asserted by the reconciler — Docker rebuilds FORWARD on restart);
 * these are only the per-app rule bodies.
 *
 * The DNAT is scoped to the external interface: unscoped it also matches the
 * namespace's own egress and loops it straight back ("Refusing to handshake
 * with myself").
 *
 * @param {{externalInterface: string, meshPort: number, transitSubnet: string,
 *   transitNamespaceIp: string}} app
 * @returns {{pre: string[][], post: string[][], fwd: string[][]}}
 */
function firewallRules({
  externalInterface, meshPort, transitSubnet, transitNamespaceIp,
}) {
  if (typeof externalInterface !== 'string' || externalInterface === '') {
    throw new TypeError('externalInterface must be a non-empty string');
  }
  if (!Number.isInteger(meshPort) || meshPort < 1 || meshPort > 65535) {
    throw new TypeError('meshPort must be a valid port number');
  }
  if (typeof transitSubnet !== 'string' || !transitSubnet.includes('/')) {
    throw new TypeError('transitSubnet must be a CIDR');
  }
  if (typeof transitNamespaceIp !== 'string' || transitNamespaceIp === '') {
    throw new TypeError('transitNamespaceIp must be an address');
  }
  return {
    pre: [[
      '-i', externalInterface, '-p', 'udp', '--dport', String(meshPort),
      '-j', 'DNAT', '--to-destination', `${transitNamespaceIp}:${meshPort}`,
    ]],
    post: [[
      '-s', transitSubnet, '-j', 'MASQUERADE',
    ]],
    fwd: [
      ['-d', transitSubnet, '-j', 'ACCEPT'],
      ['-s', transitSubnet, '-j', 'ACCEPT'],
    ],
  };
}

module.exports = {
  MESH_IPV4_RANGE,
  OVERLAY_MTU,
  IPV4_FACE_MTU,
  NEBULA_TUN_DEVICE,
  TAYGA_TUN_DEVICE,
  SSHD_LISTEN,
  SSHD_USER,
  SSH_HOST_KEY_FILE,
  nebulaConfig,
  taygaConfig,
  firewallRules,
};
