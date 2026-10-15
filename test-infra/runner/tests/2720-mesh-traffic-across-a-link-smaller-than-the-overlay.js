// fleet: 3
/*
 * Mesh traffic across a link smaller than the overlay.
 *
 * A node behind a VPN carries less than the 1500 bytes a plain link does
 * (WireGuard's default is 1420), and nebula wraps every overlay packet in its
 * own headers, so a packet that fills the overlay does not fit that node's link
 * once wrapped. Here one node's link is shrunk to WireGuard's 1420, dropping
 * what does not fit with no reply, as a path that filters the "too big" message
 * does, and the node restarts, as one booting behind a VPN, and measures it. It
 * announces what it measured, its peers size their routes to it, and a member
 * there exchanges a stream of full-size segments with a peer in both
 * directions, byte for byte.
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
import { restartFluxos } from '../framework/systemd-control.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';

const { gateway: GATEWAY } = getSubnetConfig();
const SMALL_LINK_MTU = 1420;
// The overlay route to the node behind it: the small link less nebula's 60
// bytes of wrapping.
const ROUTE_MTU = SMALL_LINK_MTU - 60;
const BEHIND = 1; // the node whose link is shrunk
const PEER = 0;
const STREAM_KB = 200;
const STREAM_PORT = 8091;

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

  // A stream of STREAM_KB random kilobytes from node `from`'s member to node
  // `to`'s, over the overlay: whether it arrived byte for byte.
  async function streamArrives(from, to) {
    const ip = await addressOf(from, to);
    const receiver = await requireAppContainerName(env.clients[to].container, name, 'web');
    await execInContainer(env.clients[to].container,
      `docker exec -d ${receiver} /bin/busybox sh -c "/bin/busybox nc -l -p ${STREAM_PORT} > /tmp/received"`);
    await inApp(from, `/bin/busybox sh -c "/bin/busybox dd if=/dev/urandom of=/tmp/sent bs=1024 count=${STREAM_KB} 2>/dev/null"`);
    await inApp(from, `/bin/busybox sh -c "/bin/busybox nc -w 15 ${ip} ${STREAM_PORT} < /tmp/sent"`);
    const sent = (await inApp(from, '/bin/busybox md5sum /tmp/sent')).stdout.split(' ')[0];
    let received = null;
    await waitFor(async () => {
      received = (await inApp(to, '/bin/busybox md5sum /tmp/received')).stdout.split(' ')[0];
      return received === sent;
    }, { timeout: 30000, interval: 2000, label: `node ${from} to node ${to}: ${STREAM_KB} KB arrive whole` }).catch(() => {});
    return received === sent;
  }

  async function uplinkMtu(index) {
    const res = await fetch(`${env.clients[index].url}/flux/info`);
    return (await res.json()).data?.flux?.uplink?.mtu ?? null;
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

  it('carries a stream of full-size segments both ways while every link is a full one', async function () {
    this.timeout(180000);
    expect(await streamArrives(PEER, BEHIND), 'toward the member').to.equal(true);
    expect(await streamArrives(BEHIND, PEER), 'from the member').to.equal(true);
  });

  it('carries it both ways to a member behind a link smaller than the overlay', async function () {
    this.timeout(600000);
    const shrunk = await execInContainer(env.clients[BEHIND].container, `ip link set eth0 mtu ${SMALL_LINK_MTU}`);
    expect(shrunk.exitCode, `node ${BEHIND}'s link is ${SMALL_LINK_MTU}`).to.equal(0);
    await restartFluxos(env.clients[BEHIND].container);
    await waitFor(async () => (await uplinkMtu(BEHIND)) === SMALL_LINK_MTU, {
      timeout: 180000, interval: 5000, label: `node ${BEHIND} measures its link at ${SMALL_LINK_MTU}`,
    });
    await waitFor(async () => {
      const text = (await execInContainer(env.clients[PEER].container, 'cat /dat/var/lib/flux-mesh/*/config.yml')).stdout;
      return text.includes(`      mtu: ${ROUTE_MTU}`);
    }, { timeout: 240000, interval: 5000, label: `node ${PEER} sizes its route to node ${BEHIND} at ${ROUTE_MTU}` });

    expect(await streamArrives(PEER, BEHIND), 'toward the member').to.equal(true);
    expect(await streamArrives(BEHIND, PEER), 'from the member').to.equal(true);
  });
});
