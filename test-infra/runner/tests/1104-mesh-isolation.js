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
const RESOLVER_ADDR = '169.254.43.53';

// Multi-tenancy isolation: two mesh apps on the SAME three nodes must not be
// able to reach or discover each other. Each app is its own overlay — its own
// namespace, nebula, trust bundle and /48 — so the separation is structural,
// and this proves it holds at the two seams a tenant could probe:
//   DNS  — the resolver is one node-wide service scoping answers by the calling
//          container's source; app A must not resolve app B's names.
//   VPN  — app A's container is attached only to app A's namespace and its tayga
//          maps only app A's members; app A must not reach app B's addresses.
// Every negative is paired with a positive control on the same path, so a
// vacuous pass (app A reaching nothing at all) cannot masquerade as isolation.
describe('mesh isolation between two apps on one host', function () {
  let env;
  let ownerAuths;
  const apps = {};

  async function meshStatus(clientIndex, appName) {
    const res = await fetch(`${env.clients[clientIndex].url}/apps/mesh/status/${appName}`, {
      headers: { zelidauth: ownerAuths[clientIndex] },
    });
    return res.json();
  }

  // A component container is named flux{component}_{identity}; the identity
  // comes from that app's mesh status on that node.
  async function appContainerName(clientIndex, appName) {
    const status = await meshStatus(clientIndex, appName);
    const identity = status?.data?.identity;
    expect(identity, `${appName} identity on node ${clientIndex}`).to.be.a('string');
    const containerName = `fluxweb_${identity}`;
    const { stdout } = await execInContainer(
      env.clients[clientIndex].container,
      `docker ps --format '{{.Names}}' --filter name=${containerName}`,
    );
    expect(stdout.trim(), `container ${containerName} on node ${clientIndex}`).to.include(containerName);
    return containerName;
  }

  async function inApp(clientIndex, appName, command) {
    const containerName = await appContainerName(clientIndex, appName);
    return execInContainer(env.clients[clientIndex].container, `docker exec ${containerName} ${command}`);
  }

  // The presented addresses an app answers for its own group name, read from a
  // container of THAT app (which is allowed to resolve it).
  async function ownGroupAddresses(clientIndex, appName) {
    const out = await inApp(clientIndex, appName, `/bin/busybox nslookup web.${appName}.mesh.flux ${RESOLVER_ADDR}`);
    return [...new Set(out.stdout.match(/10\.127\.[0-9.]+/g) ?? [])];
  }

  async function registerMeshApp(name, hostPort) {
    await pushBusybox(name);
    const reg = await registerEncryptedV9App(env.clients[0].url, {
      name,
      instances: 3,
      specOverrides: { network: { mesh: true } },
      components: {
        web: {
          name: 'web',
          description: 'mesh isolation echo component',
          image: `${REGISTRY_REPO_HOST}/${name}:v1`,
          cpu: 0.5,
          memory: 300,
          rootFsGb: 2,
          entrypoint: ['/bin/busybox', 'sh', '-c',
            'while true; do /bin/busybox nc -l -p 8080 -e /bin/busybox echo MESH-OK; done'],
          ports: { echo: { containerPort: 8080, hostPort } },
        },
      },
    });
    expect(reg.status, JSON.stringify(reg)).to.equal('success');
    await queueAppTx(reg.data);
  }

  before(async function () {
    this.timeout(1200000);
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
    // The harness network is Internal (no default route); a real node has one and
    // the reconciler scopes its firewall to it. Provision it, as 1102/1103 do.
    await Promise.all(env.clients.map((c) => execInContainer(
      c.container, `ip route replace default via ${GATEWAY} dev eth0`,
    )));
    ownerAuths = await Promise.all(env.clients.map(async (c) => (await authenticate(c.url, appOwnerKey())).zelidauth));
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('installs two mesh apps on the same fleet, both overlays live on every node', async function () {
    this.timeout(600000);
    apps.a = `e2eisola${Date.now()}`;
    apps.b = `e2eisolb${Date.now()}`;
    await registerMeshApp(apps.a, 31282);
    await registerMeshApp(apps.b, 31283);
    await advanceBlocks(3);

    await waitFor(async () => {
      const rows = await Promise.all(env.clients.flatMap((c) => [apps.a, apps.b]
        .map((n) => c.getAppSpecs(n).catch(() => null))));
      return rows.every((r) => r && r.status === 'success' && r.data);
    }, { timeout: 180000, interval: 3000, label: 'both global specs on all nodes' });

    await Promise.all(env.clients.flatMap((c) => [apps.a, apps.b]
      .map((n) => waitForAppInstalled(c, n, 300000))));

    await waitFor(async () => {
      const statuses = await Promise.all(env.clients.flatMap((_, i) => [apps.a, apps.b]
        .map((n) => meshStatus(i, n))));
      return statuses.every((s) => s.status === 'success'
        && s.data.unitActive === true
        && (s.data.lastPass?.members?.length ?? 0) === 2
        && !s.data.lastPass.error);
    }, { timeout: 300000, interval: 5000, label: 'both overlays live on all three nodes' });
  });

  it('each app resolves its OWN names — the positive control', async function () {
    this.timeout(180000);
    await waitFor(async () => (await ownGroupAddresses(0, apps.a)).length === 3,
      { timeout: 120000, interval: 5000, label: `${apps.a} resolves its own group` });
    expect(await ownGroupAddresses(0, apps.b), `${apps.b} resolves its own group`).to.have.length(3);
  });

  it('the resolver refuses every one of the other app\'s name forms, both directions', async function () {
    this.timeout(120000);
    // flux-dnsd is one node-wide process, so its source-scoping is the DNS
    // tenant boundary. From an app A container, NONE of app B's name forms may
    // answer — the component group, a specific member, the retired whole-app
    // name, or an SRV name — and the same holds from B toward A. The
    // per-member name needs B's node id, read from B's own status.
    const forms = async (foreign) => {
      const status = await meshStatus(0, foreign);
      const peerNodeId = status.data.lastPass.members[0].nodeId;
      return [
        [`web.${foreign}.mesh.flux`, ''],
        [`web-${peerNodeId}.${foreign}.mesh.flux`, ''],
        [`${foreign}.mesh.flux`, ''],
        [`_echo._tcp.web.${foreign}.mesh.flux`, '-type=srv '],
      ];
    };
    // eslint-disable-next-line no-restricted-syntax
    for (const [caller, foreign] of [[apps.a, apps.b], [apps.b, apps.a]]) {
      // eslint-disable-next-line no-await-in-loop
      const names = await forms(foreign);
      // eslint-disable-next-line no-restricted-syntax
      for (const [name, typeFlag] of names) {
        // eslint-disable-next-line no-await-in-loop
        const out = await inApp(0, caller, `/bin/busybox nslookup ${typeFlag}${name} ${RESOLVER_ADDR}`);
        expect(out.stdout, `${caller} must not resolve ${name}`).to.not.match(/10\.127\./);
        expect(out.stdout, `${caller} must get no SRV rows for ${name}`).to.not.match(/service = /i);
      }
    }
  });

  it('an app reaches its OWN peer over the overlay — the positive control', async function () {
    this.timeout(180000);
    const peer = (await meshStatus(0, apps.a)).data.lastPass.members[0];
    const own = await ownGroupAddresses(0, apps.a);
    const selfEnv = await inApp(0, apps.a, '/bin/busybox sh -c "/bin/busybox env | /bin/busybox grep FLUX_MESH_SELF_IP"');
    const selfIp = selfEnv.stdout.match(/FLUX_MESH_SELF_IP=([0-9.]+)/)?.[1];
    const peerIp = own.find((ip) => ip !== selfIp);
    expect(peerIp, `a peer address for ${apps.a}`).to.be.a('string');
    await waitFor(async () => {
      const out = await inApp(0, apps.a, `/bin/busybox nc -w 5 ${peerIp} 8080`);
      return out.stdout.includes('MESH-OK');
    }, { timeout: 90000, interval: 5000, label: `${apps.a} reaches its own peer ${peerIp}`, extra: { peer } });
  });

  it('an app cannot reach the other app\'s overlay addresses', async function () {
    this.timeout(120000);
    // app B's presented addresses, learned from a B container (which may see
    // them); app A's namespace has no tayga map for them, so a dial from an A
    // container must not translate or route.
    const bAddresses = await ownGroupAddresses(0, apps.b);
    expect(bAddresses, `${apps.b} presented addresses`).to.have.length(3);
    for (const bIp of bAddresses) {
      // eslint-disable-next-line no-await-in-loop
      const out = await inApp(0, apps.a, `/bin/busybox nc -w 5 ${bIp} 8080`);
      expect(out.stdout, `${apps.a} must not reach ${apps.b} at ${bIp}`).to.not.include('MESH-OK');
    }
  });
});
