// fleet: 3
/*
 * Mesh traffic across a link smaller than the overlay.
 *
 * A node behind a VPN carries less than the 1500 bytes a plain link does
 * (WireGuard's default is 1420), and nebula wraps every overlay packet in its
 * own headers, so a packet that fills the overlay does not fit that node's link
 * unwrapped. Here one node's link is shrunk to WireGuard's 1420, dropping what
 * does not fit with no reply, as a path that filters the "too big" message
 * does. A member on that node must still exchange packets as large as its mesh
 * device carries with its peers, in both directions.
 */
import {
  describe, it, before, after, afterEach,
} from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { registerEncryptedV9App } from '../framework/content-helper.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
import { waitFor, waitForAppInstalled } from '../framework/wait.js';
import { authenticate } from '../auth.js';
import { appOwnerKey } from '../framework/keys.js';
import { execInContainer, requireAppContainerName } from '../framework/container.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';

const { gateway: GATEWAY } = getSubnetConfig();
const SMALL_LINK_MTU = 1420;
const BEHIND = 1; // the node whose link is shrunk
const PEER = 0;
// The container's flux-mesh0 carries 1400 bytes: 1372 of ping payload, 8 of
// ICMP header and 20 of IPv4.
const FULL_PAYLOAD = 1372;

describe('mesh traffic across a link smaller than the overlay', function () {
  let env;
  let name;
  let ownerAuths;

  async function meshStatus(index) {
    const res = await fetch(`${env.clients[index].url}/apps/mesh/status/${name}`, {
      headers: { zelidauth: ownerAuths[index] },
    });
    return res.json();
  }

  async function inApp(index, command) {
    const container = await requireAppContainerName(env.clients[index].container, name, 'web');
    return execInContainer(env.clients[index].container, `docker exec ${container} ${command}`);
  }

  async function selfIp(index) {
    const out = await inApp(index, '/bin/busybox sh -c "/bin/busybox env | /bin/busybox grep FLUX_MESH_SELF_IP"');
    return out.stdout.match(/FLUX_MESH_SELF_IP=([0-9.]+)/)?.[1];
  }

  async function snapshotOf(index) {
    const { stdout } = await execInContainer(env.clients[index].container, 'cat /var/lib/flux-mesh/resolver/membership.json');
    return JSON.parse(stdout);
  }

  // The address node `from` presents for node `to`'s member, which its
  // snapshot lists under `to`'s node id.
  async function addressOf(from, to) {
    const { nodeId } = await snapshotOf(to);
    const app = (await snapshotOf(from)).apps.find((a) => a.name === name);
    return app.members.find((m) => m.nodeId === nodeId)?.ip ?? null;
  }

  async function received(from, to, payload) {
    const ip = await addressOf(from, to);
    const out = await inApp(from, `/bin/busybox ping -c 3 -W 3 -s ${payload} ${ip}`);
    return Number(out.stdout.match(/(\d+) packets received/)?.[1] ?? 0);
  }

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 3,
      tickerAutostart: false,
      systemdMode: true,
      shutdownd: 'none',
      arcane: true,
      // Founding photos pin committees at spec anchor heights, which needs the
      // anchored membership history the ZMQ delta machinery keeps.
      zmqTopics: ALL_ZMQ_TOPICS,
      configOverrides: {
        fluxapps: {
          meshReconcileIntervalMs: 15000,
          minOutgoing: 1,
          minIncoming: 1,
          quorumGrantMaxTtlMs: 30000,
          quorumGrantDrainMs: 20000,
          quorumGrantLockDelayMs: 10000,
          quorumGrantRenewIntervalMs: 5000,
          quorumGrantAskTimeoutMs: 3000,
        },
      },
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });
    // The mesh reconciler scopes its firewall to the default-route interface,
    // which a real node has and the harness network does not.
    await Promise.all(env.clients.map((c) => execInContainer(c.container, `ip route replace default via ${GATEWAY} dev eth0`)));
    ownerAuths = await Promise.all(env.clients.map(async (c) => (await authenticate(c.url, appOwnerKey())).zelidauth));
  });

  // A failed test keeps how the node behind the small link treats the overlay's
  // outer packets: the path MTU its mesh namespace holds for each peer node,
  // whether it may fragment, and its fragmentation and ICMP counters.
  afterEach(async function () {
    if (this.currentTest.state !== 'failed' || !env) return;
    this.timeout(120000);
    const peers = [0, 2].map((i) => getSubnetConfig().nodeIp(i + 1));
    const script = [
      'ns=$(ip netns list | grep -o "flux-mesh-[a-z0-9]*" | head -1)',
      'echo "ns=$ns"',
      'sysctl net.ipv4.ip_no_pmtu_disc net.ipv4.ip_forward_use_pmtu',
      'ip netns exec "$ns" sysctl net.ipv4.ip_no_pmtu_disc',
      ...peers.map((peer) => `ip netns exec "$ns" ip route get ${peer}`),
      'ip netns exec "$ns" ip route show cache',
      'nstat -az 2>/dev/null | grep -E "IpFrag|IcmpOutDestUnreachs|IcmpInDestUnreachs|IpReasm|IpOutDiscards|IpInDiscards"',
      'ip netns exec "$ns" nstat -az 2>/dev/null | grep -E "IpFrag|IcmpInDestUnreachs|IcmpOutDestUnreachs|IpReasm"',
      'iptables -S FLUX-MESH-FWD; iptables -t nat -S FLUX-MESH-POST',
    ].join('; ');
    const out = await execInContainer(env.clients[BEHIND].container, script).catch((e) => ({ stdout: String(e) }));
    console.log(`--- node ${BEHIND}, behind the small link ---\n${out.stdout}\n${out.stderr ?? ''}`);
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('installs a mesh app and the overlay comes up', async function () {
    this.timeout(600000);
    name = `e2emtu${Date.now()}`;
    await pushBusybox(name);
    const reg = await registerEncryptedV9App(env.clients[0].url, {
      name,
      instances: 3,
      specOverrides: { network: { mesh: true } },
      components: {
        web: {
          name: 'web',
          description: 'a member that answers pings',
          image: `${REGISTRY_REPO_HOST}/${name}:v1`,
          cpu: 0.5,
          memory: 300,
          rootFsGb: 2,
          ports: { echo: { containerPort: 8080, hostPort: 31282 } },
        },
      },
    });
    expect(reg.status, JSON.stringify(reg)).to.equal('success');
    await queueAppTx(reg.data);
    await advanceBlocks(3);
    await Promise.all(env.clients.map((c) => waitForAppInstalled(c, name, 300000)));
    await waitFor(async () => {
      const statuses = await Promise.all(env.clients.map((_, i) => meshStatus(i)));
      return statuses.every((s) => s.status === 'success' && s.data.unitActive === true
        && (s.data.lastPass?.members?.length ?? 0) === 2 && !s.data.lastPass.error);
    }, { timeout: 240000, interval: 5000, label: 'overlay live on all three nodes' });
    await Promise.all([0, 1, 2].map((i) => waitFor(async () => Boolean(await selfIp(i)), {
      timeout: 120000, interval: 5000, label: `node ${i}'s member carries its presented address`,
    })));
  });

  it('carries full-size packets both ways while every link is a full one', async function () {
    this.timeout(180000);
    await waitFor(async () => (await received(PEER, BEHIND, 56)) > 0 && (await received(BEHIND, PEER, 56)) > 0, {
      timeout: 120000, interval: 5000, label: 'small packets cross both ways',
    });
    expect(await received(PEER, BEHIND, FULL_PAYLOAD), 'full-size, toward the member').to.be.above(0);
    expect(await received(BEHIND, PEER, FULL_PAYLOAD), 'full-size, from the member').to.be.above(0);
  });

  it('carries full-size packets both ways to a member behind a link smaller than the overlay', async function () {
    this.timeout(180000);
    const shrunk = await execInContainer(env.clients[BEHIND].container, `ip link set eth0 mtu ${SMALL_LINK_MTU}`);
    expect(shrunk.exitCode, `node ${BEHIND}'s link is ${SMALL_LINK_MTU}`).to.equal(0);
    expect(await received(PEER, BEHIND, 56), 'small packets still cross toward the member').to.be.above(0);
    expect(await received(BEHIND, PEER, 56), 'small packets still cross from the member').to.be.above(0);
    const from = await received(BEHIND, PEER, FULL_PAYLOAD);
    const toward = await received(PEER, BEHIND, FULL_PAYLOAD);
    expect({ from, toward }, 'full-size packets received, of three each way')
      .to.satisfy(({ from: f, toward: t }) => f > 0 && t > 0);
  });
});
