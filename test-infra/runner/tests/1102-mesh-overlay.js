// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { registerEncryptedV9App } from '../framework/content-helper.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
import { waitFor, waitForAppInstalled } from '../framework/wait.js';
import { authenticate } from '../auth.js';
import { appOwnerKey } from '../framework/keys.js';
import { execInContainer } from '../framework/container.js';
import { unitState } from '../framework/systemd-control.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';

const { gateway: GATEWAY } = getSubnetConfig();

// The mesh data plane, driven end to end by FluxOS on a real 3-node systemd
// fleet: suite 1101 proved every node derives the same overlay; this proves
// packets actually cross it. What must hold:
//   1. UNITS — the reconciler starts one nebula (flux-mesh@) and one tayga
//      (flux-mesh-tayga@) per mesh app per node, and the status surface
//      reports the overlay live (unitActive true, no retained pass error).
//   2. ATTACHMENT — each component container carries the flux-mesh0 veth with
//      its presented IPv4 and the FLUX_MESH_* identity env.
//   3. CONNECTIVITY — a container dials a peer's presented address and gets
//      bytes back. That one round trip crosses the whole design: veth into
//      the app's namespace, tayga translating IPv4 to the overlay's IPv6,
//      nebula's encrypted tunnel to the peer node, the peer's tayga
//      translating back, and the peer's veth to its container. Proven in
//      both directions across different node pairs.
// The resolver is deliberately absent here (suite 1103 adds it): peers are
// dialed by address, from the same snapshot the resolver would serve.

describe('mesh overlay across a real systemd fleet', function () {
  let env;
  let name;
  let ownerAuths;

  async function meshStatus(clientIndex) {
    const res = await fetch(`${env.clients[clientIndex].url}/apps/mesh/status/${name}`, {
      headers: { zelidauth: ownerAuths[clientIndex] },
    });
    return res.json();
  }

  // The app's component container on a node. v9 names containers by the
  // component identifier — flux{component}_{identity} — so the app NAME never
  // appears in docker ps; the identity comes from the mesh status this suite
  // already reads.
  async function appContainerName(clientIndex) {
    const status = await meshStatus(clientIndex);
    const identity = status?.data?.identity;
    expect(identity, `mesh identity on node ${clientIndex}`).to.be.a('string');
    const containerName = `fluxweb_${identity}`;
    const { stdout } = await execInContainer(
      env.clients[clientIndex].container,
      `docker ps --format '{{.Names}}' --filter name=${containerName}`,
    );
    expect(stdout.trim(), `container ${containerName} on node ${clientIndex}`).to.include(containerName);
    return containerName;
  }

  async function inApp(clientIndex, command) {
    const containerName = await appContainerName(clientIndex);
    return execInContainer(env.clients[clientIndex].container, `docker exec ${containerName} ${command}`);
  }

  async function nodeSnapshotMembers(clientIndex) {
    const { stdout } = await execInContainer(
      env.clients[clientIndex].container,
      'cat /var/lib/flux-mesh/resolver/membership.json 2>/dev/null || echo ""',
    );
    const snapshot = JSON.parse(stdout);
    const app = snapshot.apps?.find((a) => a.name === name);
    return app?.members ?? [];
  }

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 3,
      tickerAutostart: false,
      systemdMode: true,
      shutdowndMock: false,
      arcane: true,
      configOverrides: {
        fluxapps: { meshReconcileIntervalMs: 15000, minOutgoing: 1, minIncoming: 1 },
      },
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });
    // The harness network is Internal, so docker installs no default route; a
    // real Flux node always has one, and the mesh reconciler scopes its DNAT and
    // MASQUERADE to the default-route interface. Give each node the route it
    // would have in production (peers stay directly reachable on the /24; the
    // gateway does not forward off-net, so hermeticity holds).
    await Promise.all(env.clients.map((c) => execInContainer(
      c.container, `ip route replace default via ${GATEWAY} dev eth0`,
    )));
    ownerAuths = await Promise.all(env.clients.map(async (c) => (await authenticate(c.url, appOwnerKey())).zelidauth));
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('installs a mesh app whose container answers on its own port', async function () {
    this.timeout(420000);
    name = `e2eoverlay${Date.now()}`;
    await pushBusybox(name);

    const reg = await registerEncryptedV9App(env.clients[0].url, {
      name,
      instances: 3,
      specOverrides: { network: { mesh: true } },
      components: {
        web: {
          name: 'web',
          description: 'mesh overlay echo component',
          image: `${REGISTRY_REPO_HOST}/${name}:v1`,
          cpu: 0.5,
          memory: 300,
          rootFsGb: 2,
          entrypoint: ['/bin/busybox', 'sh', '-c',
            'while true; do /bin/busybox nc -l -p 8080 -e /bin/busybox echo MESH-OK; done'],
          ports: { echo: { containerPort: 8080, hostPort: 31280 } },
        },
      },
    });
    expect(reg.status, JSON.stringify(reg)).to.equal('success');
    await queueAppTx(reg.data);
    await advanceBlocks(3);

    await waitFor(async () => {
      const rows = await Promise.all(env.clients.map((c) => c.getAppSpecs(name).catch(() => null)));
      return rows.every((r) => r && r.status === 'success' && r.data && r.data.name === name);
    }, { timeout: 120000, interval: 3000, label: `global spec for ${name} on all nodes` });

    await Promise.all(env.clients.map((c) => waitForAppInstalled(c, name, 300000)));
  });

  it('the reconciler brings the overlay up: nebula and tayga units active on every node', async function () {
    this.timeout(300000);

    await waitFor(async () => {
      const statuses = await Promise.all(env.clients.map((_, i) => meshStatus(i)));
      return statuses.every((s) => s.status === 'success'
        && s.data.meshEnabled === true
        && s.data.unitActive === true
        && (s.data.lastPass?.members?.length ?? 0) === 2
        && !s.data.lastPass.error);
    }, { timeout: 240000, interval: 5000, label: 'overlay live on all three nodes' });

    const statuses = await Promise.all(env.clients.map((_, i) => meshStatus(i)));
    for (const [i, s] of statuses.entries()) {
      const { identity } = s.data;
      expect(await unitState(env.clients[i].container, `flux-mesh@${identity}`)).to.equal('active');
      expect(await unitState(env.clients[i].container, `flux-mesh-tayga@${identity}`)).to.equal('active');
    }
  });

  it('each container carries its mesh identity: flux-mesh0, presented address, env', async function () {
    this.timeout(180000);

    for (let i = 0; i < env.clients.length; i += 1) {
      // The FLUX_MESH_* env is fixed at container creation, so it is stable.
      // eslint-disable-next-line no-await-in-loop
      const envOut = await inApp(i, '/bin/busybox sh -c "/bin/busybox env | /bin/busybox grep FLUX_MESH_"');
      expect(envOut.stdout).to.include(`FLUX_MESH_APP=${name}`);
      expect(envOut.stdout).to.match(/FLUX_MESH_SELF=web-[0-9a-f]+/);
      const selfIp = envOut.stdout.match(/FLUX_MESH_SELF_IP=([0-9.]+)/)?.[1];
      expect(selfIp, `presented address on node ${i}`).to.be.a('string');
      // The flux-mesh0 veth is attached by the reconciler AFTER the container
      // starts (mesh recreates it), so it is eventually-consistent — poll until
      // the interface carries the presented address, as the dial test polls.
      // eslint-disable-next-line no-await-in-loop
      await waitFor(async () => {
        const iface = await inApp(i, '/bin/busybox ip -o -4 addr show flux-mesh0');
        return iface.stdout.includes(selfIp);
      }, { timeout: 120000, interval: 5000, label: `flux-mesh0 carries ${selfIp} on node ${i}` });
    }
  });

  it('a container reaches its peers through the overlay, both directions', async function () {
    this.timeout(240000);

    // Peer presented addresses, from the same snapshot the resolver would
    // serve: everyone minus this container's own address.
    const dial = async (fromIndex) => {
      const envOut = await inApp(fromIndex, '/bin/busybox sh -c "/bin/busybox env | /bin/busybox grep FLUX_MESH_SELF_IP"');
      const selfIp = envOut.stdout.match(/FLUX_MESH_SELF_IP=([0-9.]+)/)?.[1];
      const members = await nodeSnapshotMembers(fromIndex);
      const peerIps = members.map((m) => m.ip).filter((ip) => ip && ip !== selfIp);
      expect(peerIps, `peer addresses visible from node ${fromIndex}`).to.have.length(2);
      // eslint-disable-next-line no-restricted-syntax
      for (const peerIp of peerIps) {
        // eslint-disable-next-line no-await-in-loop
        await waitFor(async () => {
          const out = await inApp(fromIndex, `/bin/busybox nc -w 5 ${peerIp} 8080`);
          return out.stdout.includes('MESH-OK');
        }, { timeout: 90000, interval: 5000, label: `node ${fromIndex} reaches ${peerIp}:8080 over the mesh` });
      }
    };

    await dial(0);
    await dial(1);
  });
});
