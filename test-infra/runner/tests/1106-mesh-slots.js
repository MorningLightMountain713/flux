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
import { pushBusybox } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';

const { gateway: GATEWAY } = getSubnetConfig();

// The slot mechanism (DNS_SERVICE_DISCOVERY_SRV.md §11): each member claims
// the lowest vacant ordinal and asserts it through the message flows the
// network already gossips; the ordinal is the member's canonical identity.
// On a 3-node fleet this locks in:
//   1. Three members, three DISTINCT ordinals 0..2 — the claims split without
//      any coordinator, and the SRV answer is exactly the named cluster set.
//   2. The container carries the identity: FLUX_MESH_ORDINAL, the ordinal
//      FLUX_MESH_SELF/FQDN, and the docker hostname all agree (the k8s
//      StatefulSet convention images derive their identity from).
//   3. The component name still resolves locally — the network alias that
//      keeps existing `<component>` references working now that the hostname
//      is the member name.
//   4. PTR gives the ordinal FQDN — the canonical identity — for a peer's
//      presented address.
//   5. Slots survive a FluxOS restart unchanged: the assertion is echoed from
//      the node's own prior announcement, never re-elected.
// NOT covered here, deliberately: different-node replacement inheritance and
// standby promotion — both ride the location-TTL expiry (~125 min), which no
// harness suite can wait out. The claim/arbitration unit suites pin that
// logic; the campaign proves it on a real fleet over real time.

const RESOLVER_ADDR = '169.254.43.53';

describe('mesh ordinal slots — claim, identity, and stability', function () {
  let env;
  let name;
  let ownerAuths;

  async function meshStatus(clientIndex) {
    const res = await fetch(`${env.clients[clientIndex].url}/apps/mesh/status/${name}`, {
      headers: { zelidauth: ownerAuths[clientIndex] },
    }).catch(() => null);
    if (!res) return { status: 'error' };
    return res.json();
  }

  async function appContainerName(clientIndex) {
    const status = await meshStatus(clientIndex);
    const identity = status?.data?.identity;
    expect(identity, `mesh identity on node ${clientIndex}`).to.be.a('string');
    return `fluxweb_${identity}`;
  }

  async function inApp(clientIndex, command) {
    const containerName = await appContainerName(clientIndex);
    return execInContainer(env.clients[clientIndex].container, `docker exec ${containerName} ${command}`);
  }

  async function ownSlots() {
    const statuses = await Promise.all(env.clients.map((_, i) => meshStatus(i)));
    return statuses.map((s) => s?.data?.lastPass?.ownSlot);
  }

  function srvRows(stdout) {
    return [...stdout.matchAll(/service = (\d+) (\d+) (\d+) (\S+)/gi)]
      .map((m) => ({ port: Number(m[3]), target: m[4].replace(/\.$/, '') }));
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
    await Promise.all(env.clients.map((c) => execInContainer(
      c.container, `ip route replace default via ${GATEWAY} dev eth0`,
    )));
    ownerAuths = await Promise.all(env.clients.map(async (c) => (await authenticate(c.url, appOwnerKey())).zelidauth));
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('installs a mesh app and the overlay comes up', async function () {
    this.timeout(480000);
    name = `e2emeshslot${Date.now()}`;
    await pushBusybox(name);

    const reg = await registerEncryptedV9App(env.clients[0].url, {
      name,
      instances: 3,
      specOverrides: { network: { mesh: true } },
      components: {
        web: {
          name: 'web',
          description: 'slot identity component',
          image: `${REGISTRY_REPO_HOST}/${name}:v1`,
          cpu: 0.5,
          memory: 300,
          rootFsGb: 2,
          entrypoint: ['/bin/busybox', 'sh', '-c',
            'while true; do /bin/busybox nc -l -p 8080 -e /bin/busybox echo SLOT-OK; done'],
          ports: { echo: { containerPort: 8080, hostPort: 31283 } },
          meshPorts: { 'mesh-echo': { containerPort: 8080 } },
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

  it('three members claim three distinct ordinals with no coordinator', async function () {
    this.timeout(240000);
    // Every node's own resolved slot, from the operator surface — and the SRV
    // answer, which is the named cluster set built from the same assertions.
    await waitFor(async () => {
      const slots = await ownSlots();
      return new Set(slots.filter(Number.isInteger)).size === 3;
    }, { timeout: 180000, interval: 5000, label: 'all three nodes hold distinct slots' });
    const slots = await ownSlots();
    expect(new Set(slots), 'the dense slot space, fully assigned').to.deep.equal(new Set([0, 1, 2]));

    const out = await inApp(0, `/bin/busybox nslookup -type=srv _mesh-echo._tcp.web.${name}.mesh.flux ${RESOLVER_ADDR}`);
    const targets = new Set(srvRows(out.stdout).map((r) => r.target));
    expect(targets).to.deep.equal(new Set([
      `web-0.${name}.mesh.flux`,
      `web-1.${name}.mesh.flux`,
      `web-2.${name}.mesh.flux`,
    ]));
  });

  it('the container carries its ordinal identity: env and hostname agree', async function () {
    this.timeout(120000);
    const envOut = await inApp(0, '/bin/busybox sh -c "/bin/busybox env | /bin/busybox grep FLUX_MESH"');
    const ordinal = envOut.stdout.match(/FLUX_MESH_ORDINAL=(\d+)/)?.[1];
    expect(ordinal, 'FLUX_MESH_ORDINAL present').to.be.a('string');
    expect(envOut.stdout).to.include(`FLUX_MESH_SELF=web-${ordinal}`);
    expect(envOut.stdout).to.include(`FLUX_MESH_SELF_FQDN=web-${ordinal}.${name}.mesh.flux`);
    const hostOut = await inApp(0, '/bin/busybox hostname');
    expect(hostOut.stdout.trim(), 'hostname is the member name').to.equal(`web-${ordinal}`);
  });

  it('the component name still resolves locally through the network alias', async function () {
    this.timeout(120000);
    // Bare `web` rides docker's embedded DNS (the alias), never the mesh: it
    // answers the app-network address, exactly as before the hostname moved.
    const out = await inApp(0, '/bin/busybox nslookup web');
    expect(out.stdout, 'the alias answers on the app network').to.match(/Address: *172\./);
    expect(out.stdout, 'and it is not a mesh answer').to.not.match(/10\.127\./);
  });

  it('PTR names the ordinal identity for a peer address', async function () {
    this.timeout(120000);
    const groupOut = await inApp(0, `/bin/busybox nslookup web.${name}.mesh.flux ${RESOLVER_ADDR}`);
    const envOut = await inApp(0, '/bin/busybox sh -c "/bin/busybox env | /bin/busybox grep FLUX_MESH_SELF_IP"');
    const selfIp = envOut.stdout.match(/FLUX_MESH_SELF_IP=([0-9.]+)/)?.[1];
    const peerIp = (groupOut.stdout.match(/10\.127\.[0-9.]+/g) ?? []).find((ip) => ip !== selfIp);
    expect(peerIp, 'a peer presented address').to.be.a('string');
    const ptrOut = await inApp(0, `/bin/busybox nslookup ${peerIp} ${RESOLVER_ADDR}`);
    expect(ptrOut.stdout).to.match(new RegExp(`web-[0-2]\\.${name}\\.mesh\\.flux`));
  });

  it('slots survive a FluxOS restart — echoed, never re-elected', async function () {
    this.timeout(420000);
    const beforeSlots = await ownSlots();
    await execInContainer(env.clients[1].container, 'systemctl restart fluxos');
    await waitFor(async () => {
      const status = await meshStatus(1);
      return status.status === 'success'
        && status.data.unitActive === true
        && Number.isInteger(status.data.lastPass?.ownSlot)
        && !status.data.lastPass.error;
    }, { timeout: 300000, interval: 5000, label: 'node 1 mesh pass complete after restart' });
    const afterSlots = await ownSlots();
    expect(afterSlots, 'every node keeps its slot').to.deep.equal(beforeSlots);
  });
});
