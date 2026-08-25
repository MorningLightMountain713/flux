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
import { execInContainer, requireAppContainerName } from '../framework/container.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';

const { gateway: GATEWAY } = getSubnetConfig();

// Mesh SRV discovery, and the membership-not-liveness contract, on the first
// genuinely multi-component mesh app the harness runs. 1103 proved A names;
// this proves the named-port half of discovery and what the DNS answer means:
//   1. `_<service>._tcp.<component>.<app>.mesh.flux` answers one SRV per
//      member carrying the meshPorts-declared port — exact match on the
//      service label, single-port fallback when a component declares one.
//   2. SRV targets are member FQDNs the A path resolves, and dialing the
//      discovered target:port crosses the overlay — SRV -> A -> tunnel as one
//      path, web component to db component, across nodes.
//   3. An unknown label on a multi-port component answers empty, and the
//      whole-app name (`<app>.mesh.flux`) no longer exists.
//   4. FLUX_MESH_SELF_FQDN is handed in and resolves to the caller's own
//      presented address — the identifier cluster software advertises.
//   5. A member whose container is DOWN keeps answering in the group and SRV
//      answers: DNS carries membership; liveness is the cluster's own job.

const RESOLVER_ADDR = '169.254.43.53';

describe('mesh SRV discovery and membership-not-liveness', function () {
  let env;
  let name;
  let ownerAuths;

  async function meshStatus(clientIndex) {
    const res = await fetch(`${env.clients[clientIndex].url}/apps/mesh/status/${name}`, {
      headers: { zelidauth: ownerAuths[clientIndex] },
    });
    return res.json();
  }

  // Container names are built from the app's minted identity, so they are RESOLVED
  // through the labels FluxOS stamps rather than reconstructed here.
  async function appContainerName(clientIndex, component) {
    return requireAppContainerName(env.clients[clientIndex].container, name, component);
  }

  async function inApp(clientIndex, component, command) {
    const containerName = await appContainerName(clientIndex, component);
    return execInContainer(env.clients[clientIndex].container, `docker exec ${containerName} ${command}`);
  }

  // busybox nslookup SRV rows: `<qname> service = <prio> <weight> <port> <target>`.
  function srvRows(stdout) {
    return [...stdout.matchAll(/service = (\d+) (\d+) (\d+) (\S+)/gi)]
      .map((m) => ({ port: Number(m[3]), target: m[4].replace(/\.$/, '') }));
  }

  async function srvQuery(clientIndex, component, srvName) {
    const out = await inApp(clientIndex, component,
      `/bin/busybox nslookup -type=srv ${srvName} ${RESOLVER_ADDR}`);
    return { stdout: out.stdout, rows: srvRows(out.stdout) };
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
    // The harness network is Internal, so docker installs no default route; a
    // real Flux node always has one, and the mesh reconciler scopes its DNAT and
    // MASQUERADE to the default-route interface.
    await Promise.all(env.clients.map((c) => execInContainer(
      c.container, `ip route replace default via ${GATEWAY} dev eth0`,
    )));
    ownerAuths = await Promise.all(env.clients.map(async (c) => (await authenticate(c.url, appOwnerKey())).zelidauth));
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('installs a multi-component mesh app and the overlay comes up', async function () {
    this.timeout(480000);
    name = `e2emeshsrv${Date.now()}`;
    await pushBusybox(name);

    const reg = await registerEncryptedV9App(env.clients[0].url, {
      name,
      instances: 3,
      specOverrides: { network: { mesh: true } },
      components: {
        web: {
          name: 'web',
          description: 'srv client component',
          image: `${REGISTRY_REPO_HOST}/${name}:v1`,
          cpu: 0.5,
          memory: 300,
          rootFsGb: 2,
          entrypoint: ['/bin/busybox', 'sh', '-c',
            'while true; do /bin/busybox nc -l -p 8080 -e /bin/busybox echo WEB-OK; done'],
          ports: { echo: { containerPort: 8080, hostPort: 31282 } },
          // One mesh port: any SRV service label falls back to it.
          meshPorts: { 'mesh-echo': { containerPort: 8080 } },
        },
        db: {
          name: 'db',
          description: 'srv server component - unpublished cluster ports',
          image: `${REGISTRY_REPO_HOST}/${name}:v1`,
          cpu: 0.5,
          memory: 300,
          rootFsGb: 2,
          entrypoint: ['/bin/busybox', 'sh', '-c',
            'while true; do /bin/busybox nc -l -p 7001 -e /bin/busybox echo DB-OK; done'],
          // No published ports at all: these are reachable only inside the
          // overlay, which is exactly the class of port SRV exists for.
          meshPorts: {
            'db-server': { containerPort: 7001 },
            'db-client': { containerPort: 7002 },
          },
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

  it('FLUX_MESH_SELF_FQDN is handed in and resolves to the caller\'s own address', async function () {
    this.timeout(180000);
    // The mesh identity rebuild force-removes and recreates a container whose
    // ordinal moved; a one-shot exec can land inside that window. Retry the
    // read until a container answers.
    let envOut;
    await waitFor(async () => {
      envOut = await inApp(0, 'web',
        '/bin/busybox sh -c "/bin/busybox env | /bin/busybox grep FLUX_MESH_SELF"').catch(() => null);
      return !!envOut?.stdout?.includes('FLUX_MESH_SELF');
    }, { timeout: 120000, interval: 3000, label: 'web container answers with its mesh identity' });
    const fqdn = envOut.stdout.match(/FLUX_MESH_SELF_FQDN=(\S+)/)?.[1];
    const selfIp = envOut.stdout.match(/FLUX_MESH_SELF_IP=([0-9.]+)/)?.[1];
    // Three instances, three slots: every member is a slot-holder, so the
    // identity is the ordinal form (1106 covers the slot mechanics).
    expect(fqdn, 'FLUX_MESH_SELF_FQDN present').to.match(new RegExp(`^web-[0-2]\\.${name}\\.mesh\\.flux$`));
    expect(selfIp, 'FLUX_MESH_SELF_IP present').to.be.a('string');
    await waitFor(async () => {
      const out = await inApp(0, 'web', `/bin/busybox nslookup ${fqdn} ${RESOLVER_ADDR}`);
      const answers = out.stdout.match(/10\.127\.[0-9.]+/g) ?? [];
      return answers.includes(selfIp) && new Set(answers).size === 1;
    }, { timeout: 120000, interval: 5000, label: 'own FQDN answers exactly the own presented address' });
  });

  it('SRV exact-match: one record per member carrying the declared port', async function () {
    this.timeout(180000);
    await waitFor(async () => {
      const { rows } = await srvQuery(0, 'web', `_db-server._tcp.db.${name}.mesh.flux`);
      return rows.length === 3 && rows.every((r) => r.port === 7001);
    }, { timeout: 120000, interval: 5000, label: '_db-server answers three members at 7001' });

    const { rows } = await srvQuery(0, 'web', `_db-client._tcp.db.${name}.mesh.flux`);
    expect(rows, '_db-client answers the sibling port').to.have.length(3);
    rows.forEach((r) => expect(r.port).to.equal(7002));
    // Targets are ordinal member FQDNs — the named cluster set, one per
    // slot-holder, all distinct.
    const targets = new Set(rows.map((r) => r.target));
    expect(targets.size, 'three distinct member targets').to.equal(3);
    targets.forEach((t) => expect(t).to.match(new RegExp(`^db-[0-2]\\.${name}\\.mesh\\.flux$`)));
  });

  it('a single-mesh-port component answers any service label', async function () {
    this.timeout(120000);
    const { rows } = await srvQuery(0, 'web', `_whatever._tcp.web.${name}.mesh.flux`);
    expect(rows, 'fallback answers all members').to.have.length(3);
    rows.forEach((r) => expect(r.port).to.equal(8080));
  });

  it('an unknown label on a multi-port component answers empty, not NXDOMAIN', async function () {
    this.timeout(120000);
    const { stdout, rows } = await srvQuery(0, 'web', `_nosuch._tcp.db.${name}.mesh.flux`);
    expect(rows, 'no SRV records').to.have.length(0);
    expect(stdout, 'the name exists (NODATA, never NXDOMAIN)').to.not.match(/NXDOMAIN/i);
  });

  it('a discovered SRV target dials across the mesh — web reaches db on another node', async function () {
    this.timeout(180000);
    const envOut = await inApp(0, 'db',
      '/bin/busybox sh -c "/bin/busybox env | /bin/busybox grep FLUX_MESH_SELF_FQDN"');
    const ownDbFqdn = envOut.stdout.match(/FLUX_MESH_SELF_FQDN=(\S+)/)?.[1];
    const { rows } = await srvQuery(0, 'web', `_db-server._tcp.db.${name}.mesh.flux`);
    const remote = rows.find((r) => r.target !== ownDbFqdn);
    expect(remote, 'an SRV target on another node').to.exist;
    await waitFor(async () => {
      const out = await inApp(0, 'web', `/bin/busybox nc -w 5 ${remote.target} ${remote.port}`);
      return out.stdout.includes('DB-OK');
    }, { timeout: 90000, interval: 5000, label: `dial ${remote.target}:${remote.port} discovered via SRV` });
  });

  it('the whole-app name no longer resolves', async function () {
    this.timeout(120000);
    const out = await inApp(0, 'web', `/bin/busybox nslookup ${name}.mesh.flux ${RESOLVER_ADDR}`);
    expect(out.stdout, 'no heterogeneous all-components answer').to.not.match(/10\.127\./);
  });

  it('a stopped member stays in the group and SRV answers — membership, not liveness', async function () {
    this.timeout(240000);
    // Stop node 1's db container outright. Its node keeps announcing the app
    // (assignment, not container liveness), so every resolver keeps answering
    // the full membership: hiding a down member is what breaks cluster
    // bootstrap and rejoin, and the cluster's own protocol owns liveness.
    const downContainer = await appContainerName(1, 'db');
    await execInContainer(env.clients[1].container, `docker stop ${downContainer}`);

    // Hold the assertion across at least one reconcile pass (15s interval), so
    // this proves the member STAYS, not merely that removal is slow.
    await new Promise((resolve) => { setTimeout(resolve, 25000); });

    const groupOut = await inApp(0, 'web', `/bin/busybox nslookup db.${name}.mesh.flux ${RESOLVER_ADDR}`);
    const addrs = new Set(groupOut.stdout.match(/10\.127\.[0-9.]+/g) ?? []);
    expect(addrs.size, 'group name still answers every member').to.equal(3);

    const { rows } = await srvQuery(0, 'web', `_db-server._tcp.db.${name}.mesh.flux`);
    expect(rows, 'SRV still answers every member').to.have.length(3);
  });
});
