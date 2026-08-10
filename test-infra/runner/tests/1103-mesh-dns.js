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
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';

// Mesh service discovery through the real flux-dnsd, on top of the real
// overlay: 1102 proved packets cross the mesh by address; this proves the
// names work. What must hold:
//   1. The resolver is a boot service — active on every node before any app
//      exists, serving refusal-free on 169.254.43.53.
//   2. Containers get the resolver first in their DNS chain.
//   3. `<component>.<app>.mesh.flux` answers every member's presented
//      address; `<component>-<nodeid>.` answers exactly that member;
//      `self.mesh.flux` answers the caller's own address.
//   4. Answers are scoped by the calling container: the node itself (not a
//      mesh container) gets no mesh answer for the same name.
//   5. A container dials a peer BY NAME and gets bytes back — resolution,
//      the IPv4 shim, and the tunnel exercised as one path.
// Public-name forwarding is not asserted: the harness network is internal by
// design, so there is no upstream that resolves anything public.

const RESOLVER_ADDR = '169.254.43.53';

describe('mesh DNS through the real resolver', function () {
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

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 3,
      tickerAutostart: false,
      systemdMode: true,
      shutdowndMock: false,
      dnsdReal: true,
      arcane: true,
      configOverrides: {
        fluxapps: { meshReconcileIntervalMs: 15000, minOutgoing: 1, minIncoming: 1 },
      },
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });
    ownerAuths = await Promise.all(env.clients.map(async (c) => (await authenticate(c.url, appOwnerKey())).zelidauth));
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('flux-dnsd is a boot service on every node, up before any app exists', async function () {
    this.timeout(120000);
    for (const client of env.clients) {
      // eslint-disable-next-line no-await-in-loop
      expect(await unitState(client.container, 'flux-dnsd')).to.equal('active');
    }
  });

  it('installs a mesh app and the overlay comes up', async function () {
    this.timeout(420000);
    name = `e2emeshdns${Date.now()}`;
    await pushBusybox(name);

    const reg = await registerEncryptedV9App(env.clients[0].url, {
      name,
      instances: 3,
      specOverrides: { network: { mesh: true } },
      components: {
        web: {
          name: 'web',
          description: 'mesh dns echo component',
          image: `${REGISTRY_REPO_HOST}/${name}:v1`,
          cpu: 0.5,
          memory: 300,
          rootFsGb: 2,
          entrypoint: ['/bin/busybox', 'sh', '-c',
            'while true; do /bin/busybox nc -l -p 8080 -e /bin/busybox echo MESH-OK; done'],
          ports: { echo: { containerPort: 8080, hostPort: 31281 } },
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

    await waitFor(async () => {
      const statuses = await Promise.all(env.clients.map((_, i) => meshStatus(i)));
      return statuses.every((s) => s.status === 'success'
        && s.data.unitActive === true
        && (s.data.lastPass?.members?.length ?? 0) === 2
        && !s.data.lastPass.error);
    }, { timeout: 240000, interval: 5000, label: 'overlay live on all three nodes' });
  });

  it('containers query the resolver first', async function () {
    this.timeout(120000);
    const { stdout } = await inApp(0, '/bin/busybox cat /etc/resolv.conf');
    const first = stdout.split('\n').find((l) => l.startsWith('nameserver'));
    expect(first, 'first nameserver').to.include(RESOLVER_ADDR);
  });

  it('mesh names resolve: the group, one member, and self', async function () {
    this.timeout(180000);

    // The group name carries every member's presented address.
    await waitFor(async () => {
      const out = await inApp(0, `/bin/busybox nslookup web.${name}.mesh.flux ${RESOLVER_ADDR}`);
      return (out.stdout.match(/10\.127\.[0-9.]+/g) ?? []).length === 3;
    }, { timeout: 120000, interval: 5000, label: 'group name answers all three members' });

    // A per-member name answers exactly that member. The status members are
    // this node's PEERS, so the name and the expected address pair up.
    const status = await meshStatus(0);
    const peer = status.data.lastPass.members[0];
    const memberOut = await inApp(0, `/bin/busybox nslookup web-${peer.nodeId}.${name}.mesh.flux ${RESOLVER_ADDR}`);
    const memberIps = memberOut.stdout.match(/10\.127\.[0-9.]+/g) ?? [];
    expect(new Set(memberIps).size, 'one member, one address').to.equal(1);

    // self.mesh.flux answers the caller's own presented address.
    const envOut = await inApp(0, '/bin/busybox sh -c "/bin/busybox env | /bin/busybox grep FLUX_MESH_SELF_IP"');
    const selfIp = envOut.stdout.match(/FLUX_MESH_SELF_IP=([0-9.]+)/)?.[1];
    const selfOut = await inApp(0, `/bin/busybox nslookup self.mesh.flux ${RESOLVER_ADDR}`);
    expect(selfOut.stdout).to.include(selfIp);
  });

  it('answers are scoped to mesh containers: the node itself gets none', async function () {
    this.timeout(120000);
    const probe = 'node -e "const {Resolver}=require(\'node:dns\');const r=new Resolver();'
      + `r.setServers(['${RESOLVER_ADDR}']);r.resolve4('web.${name}.mesh.flux',`
      + '(e,a)=>console.log(e?String(e.code):JSON.stringify(a)))"';
    const { stdout } = await execInContainer(env.clients[0].container, probe);
    expect(stdout, 'no mesh answer for a non-mesh caller').to.not.match(/10\.127\./);
  });

  it('a container dials a peer by name and gets bytes back', async function () {
    this.timeout(180000);
    const status = await meshStatus(0);
    const peer = status.data.lastPass.members[0];
    await waitFor(async () => {
      const out = await inApp(0, `/bin/busybox nc -w 5 web-${peer.nodeId}.${name}.mesh.flux 8080`);
      return out.stdout.includes('MESH-OK');
    }, { timeout: 90000, interval: 5000, label: `dial web-${peer.nodeId} by name over the mesh` });
  });
});
