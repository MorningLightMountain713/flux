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
import { execInContainer, appContainersFor, getAppNetwork, requireAppContainerName } from '../framework/container.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';

const { gateway: GATEWAY } = getSubnetConfig();

// The slot mechanism (DNS_SERVICE_DISCOVERY_SRV.md §11): each member claims
// the lowest vacant ordinal and asserts it through the message flows the
// network already gossips; the ordinal is the member's canonical identity.
// Four nodes, three instances — the fourth node is the replacement pool.
//
// Phase one (steady state): three members claim three DISTINCT ordinals with
// no coordinator; the container carries the identity (env, hostname — the
// k8s StatefulSet convention); the component name still resolves locally via
// the network alias; PTR gives the ordinal FQDN; and slots survive a FluxOS
// restart unchanged (echoed from the node's own prior assertion, never
// re-elected).
//
// Phase two (the lifecycle): a member node's FluxOS is stopped outright and
// the location TTLs are tuned low (they are config, not constants), so its
// rows expire and its slot vacates; the spawner replaces the instance onto
// the free node, which claims the lowest vacancy — REPLACEMENT INHERITS THE
// ORDINAL. The stopped node then returns: its runningSince restamps (its own
// rows expired too), so the deterministic arbitration keeps the slot with
// the replacement — the zombie CANNOT yank its number back. Throughout, the
// invariant that consensus bootstrap depends on holds: the SRV answer names
// exactly `instances` ordinal targets, each slot exactly once.
//
// The returned member ends over-target (4 running, 3 wanted), a transient
// state the network reaps on its own schedule — so the suite asserts the
// INVARIANT (slot ownership and the bounded named set), never which node the
// reaper picks. The drift-rebuild engine that re-identifies a demoted or
// promoted member's container is pinned by the unit suites
// (meshIdentityDrift, meshReconciler, appReconciler).

const RESOLVER_ADDR = '169.254.43.53';
const LOCATION_TTL_S = 150;

describe('mesh ordinal slots — claim, identity, replacement inheritance', function () {
  let env;
  let name;
  let ownerAuths;

  async function meshStatus(clientIndex) {
    const res = await fetch(`${env.clients[clientIndex].url}/apps/mesh/status/${name}`, {
      headers: { zelidauth: ownerAuths[clientIndex] },
    }).catch(() => null);
    if (!res) return { status: 'error' };
    return res.json().catch(() => ({ status: 'error' }));
  }

  // Which nodes currently hold the app, by the mesh operator surface.
  async function holderIndices() {
    const statuses = await Promise.all(env.clients.map((_, i) => meshStatus(i)));
    return statuses
      .map((s, i) => (s.status === 'success' && s.data?.identity ? i : null))
      .filter((i) => i !== null);
  }

  async function ownSlotOf(clientIndex) {
    const status = await meshStatus(clientIndex);
    return status?.data?.lastPass?.ownSlot ?? null;
  }

  // Container names are built from the app's minted identity, so they are RESOLVED
  // through the labels FluxOS stamps rather than reconstructed here.
  async function appContainerName(clientIndex) {
    return requireAppContainerName(env.clients[clientIndex].container, name, 'web');
  }

  async function inApp(clientIndex, command) {
    const containerName = await appContainerName(clientIndex);
    return execInContainer(env.clients[clientIndex].container, `docker exec ${containerName} ${command}`);
  }

  function srvRows(stdout) {
    return [...stdout.matchAll(/service = (\d+) (\d+) (\d+) (\S+)/gi)]
      .map((m) => ({ port: Number(m[3]), target: m[4].replace(/\.$/, '') }));
  }

  // The named cluster set, queried from a holder's container.
  async function srvTargets(clientIndex) {
    const out = await inApp(clientIndex, `/bin/busybox nslookup -type=srv _mesh-echo._tcp.web.${name}.mesh.flux ${RESOLVER_ADDR}`);
    return srvRows(out.stdout).map((r) => r.target).sort();
  }

  const FULL_SET = () => [
    `web-0.${name}.mesh.flux`,
    `web-1.${name}.mesh.flux`,
    `web-2.${name}.mesh.flux`,
  ];

  before(async function () {
    this.timeout(1200000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 4,
      tickerAutostart: false,
      systemdMode: true,
      shutdowndMock: false,
      dnsdReal: true,
      arcane: true,
      configOverrides: {
        fluxapps: {
          meshReconcileIntervalMs: 15000,
          minOutgoing: 1,
          minIncoming: 1,
          // The lifecycle phase rides row expiry, so the TTLs come down from
          // their production values (125 min / 7 min) to suite scale.
          locationTtlS: LOCATION_TTL_S,
          sigtermTtlS: 60,
          peerNotifyIntervalMs: 20000,
        },
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

  it('installs on three of four nodes and the overlay comes up', async function () {
    this.timeout(600000);
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

    await waitFor(async () => (await holderIndices()).length === 3,
      { timeout: 420000, interval: 5000, label: 'three of four nodes hold the app' });
    const holders = await holderIndices();
    await Promise.all(holders.map((i) => waitForAppInstalled(env.clients[i], name, 300000)));

    await waitFor(async () => {
      const statuses = await Promise.all(holders.map((i) => meshStatus(i)));
      return statuses.every((s) => s.status === 'success'
        && s.data.unitActive === true
        && (s.data.lastPass?.members?.length ?? 0) === 2
        && !s.data.lastPass.error);
    }, { timeout: 240000, interval: 5000, label: 'overlay live on all three holders' });
  });

  it('three members claim three distinct ordinals with no coordinator', async function () {
    this.timeout(240000);
    const holders = await holderIndices();
    await waitFor(async () => {
      const slots = await Promise.all(holders.map((i) => ownSlotOf(i)));
      return new Set(slots.filter(Number.isInteger)).size === 3;
    }, { timeout: 180000, interval: 5000, label: 'all three holders hold distinct slots' });
    const slots = await Promise.all(holders.map((i) => ownSlotOf(i)));
    expect(new Set(slots), 'the dense slot space, fully assigned').to.deep.equal(new Set([0, 1, 2]));
    expect(await srvTargets(holders[0])).to.deep.equal(FULL_SET());
  });

  it('the container carries its ordinal identity: env and hostname agree', async function () {
    this.timeout(120000);
    const [holder] = await holderIndices();
    const envOut = await inApp(holder, '/bin/busybox sh -c "/bin/busybox env | /bin/busybox grep FLUX_MESH"');
    const ordinal = envOut.stdout.match(/FLUX_MESH_ORDINAL=(\d+)/)?.[1];
    expect(ordinal, 'FLUX_MESH_ORDINAL present').to.be.a('string');
    expect(envOut.stdout).to.include(`FLUX_MESH_SELF=web-${ordinal}`);
    expect(envOut.stdout).to.include(`FLUX_MESH_SELF_FQDN=web-${ordinal}.${name}.mesh.flux`);
    const hostOut = await inApp(holder, '/bin/busybox hostname');
    expect(hostOut.stdout.trim(), 'hostname is the member name').to.equal(`web-${ordinal}`);
  });

  it('the component name still resolves locally through the network alias', async function () {
    this.timeout(120000);
    const [holder] = await holderIndices();
    const out = await inApp(holder, '/bin/busybox nslookup web');
    expect(out.stdout, 'the alias answers on the app network').to.match(/Address: *172\./);
    expect(out.stdout, 'and it is not a mesh answer').to.not.match(/10\.127\./);
  });

  it('PTR names the ordinal identity for a peer address', async function () {
    this.timeout(120000);
    const [holder] = await holderIndices();
    const groupOut = await inApp(holder, `/bin/busybox nslookup web.${name}.mesh.flux ${RESOLVER_ADDR}`);
    const envOut = await inApp(holder, '/bin/busybox sh -c "/bin/busybox env | /bin/busybox grep FLUX_MESH_SELF_IP"');
    const selfIp = envOut.stdout.match(/FLUX_MESH_SELF_IP=([0-9.]+)/)?.[1];
    const peerIp = (groupOut.stdout.match(/10\.127\.[0-9.]+/g) ?? []).find((ip) => ip !== selfIp);
    expect(peerIp, 'a peer presented address').to.be.a('string');
    const ptrOut = await inApp(holder, `/bin/busybox nslookup ${peerIp} ${RESOLVER_ADDR}`);
    expect(ptrOut.stdout).to.match(new RegExp(`web-[0-2]\\.${name}\\.mesh\\.flux`));
  });

  it('slots survive a FluxOS restart — echoed, never re-elected', async function () {
    this.timeout(420000);
    const holders = await holderIndices();
    const beforeSlots = await Promise.all(holders.map((i) => ownSlotOf(i)));
    await execInContainer(env.clients[holders[1]].container, 'systemctl restart fluxos');
    await waitFor(async () => {
      const status = await meshStatus(holders[1]);
      return status.status === 'success'
        && status.data.unitActive === true
        && Number.isInteger(status.data.lastPass?.ownSlot)
        && !status.data.lastPass.error;
    }, { timeout: 300000, interval: 5000, label: 'restarted holder completes a mesh pass' });
    const afterSlots = await Promise.all(holders.map((i) => ownSlotOf(i)));
    expect(afterSlots, 'every node keeps its slot').to.deep.equal(beforeSlots);
  });

  it('a replacement on a fresh node INHERITS the vacated ordinal', async function () {
    this.timeout(900000);
    const holders = await holderIndices();
    const spare = env.clients.findIndex((_, i) => !holders.includes(i));
    expect(spare, 'a spare node exists').to.be.at.least(0);
    const victim = holders[holders.length - 1];
    const victimSlot = await ownSlotOf(victim);
    expect(victimSlot, 'the victim holds a slot').to.be.a('number');

    // Kill the victim's FluxOS ungracefully and KEEP it down: SIGKILL first
    // so no shutdown handler runs and no leave broadcast goes out, then an
    // immediate stop — the process is already gone, so stop delivers no
    // signal to the app; it only cancels the Restart=always respawn inside
    // its RestartSec window. A runtime mask does NOT hold a loaded
    // Restart=always unit down on this systemd (measured on the image,
    // daemon-reload or not) — the old mask idiom left the victim free to
    // resurrect, and test 8's victim check raced its boot.
    await execInContainer(env.clients[victim].container,
      'systemctl kill --signal=SIGKILL fluxos && systemctl stop fluxos');

    await waitFor(async () => {
      const status = await meshStatus(spare);
      return status.status === 'success' && status.data?.identity
        && Number.isInteger(status.data.lastPass?.ownSlot);
    }, {
      timeout: 720000,
      interval: 10000,
      label: `the spare node ${spare} installs the replacement and resolves a slot`,
    });
    expect(await ownSlotOf(spare), 'the replacement claims the vacated ordinal').to.equal(victimSlot);

    // The named cluster set is whole again: exactly three ordinal targets.
    const survivor = holders.find((i) => i !== victim);
    await waitFor(async () => {
      const targets = await srvTargets(survivor);
      return targets.length === 3 && targets.every((t, idx) => t === FULL_SET()[idx]);
    }, { timeout: 180000, interval: 5000, label: 'SRV names exactly the three ordinals again' });
  });

  it('the returned node cannot yank its ordinal back', async function () {
    this.timeout(600000);
    // The victim returns after its own rows expired, so its runningSince
    // restamps and the deterministic arbitration keeps the slot with the
    // replacement. The victim is now an over-target member the network reaps
    // on its own schedule — either way, the invariant holds: the slot stays
    // with the replacement and the named set stays exactly the three
    // ordinals, each exactly once.
    const holders = await holderIndices(); // now includes the replacement
    const spareSlots = await Promise.all(holders.map((i) => ownSlotOf(i)));
    const victim = env.clients.findIndex((_, i) => !holders.includes(i));
    expect(victim, 'the stopped node is identifiable').to.be.at.least(0);
    await execInContainer(env.clients[victim].container,
      'systemctl start fluxos');

    // Settled means the returned node COMPLETED a mesh pass in this process
    // lifetime and resolved itself without a stolen slot. lastPass is
    // in-memory and a completed pass always writes the ownSlot key, so the
    // key's presence is the completion signal — a mid-boot or erroring node
    // keeps the poll waiting rather than reading as settled. The reaper
    // removing the app from the victim entirely also settles it.
    await waitFor(async () => {
      // "the reaper took the app off this node" — its containers and its network are
      // gone. Deliberately not the appdata check: that is keyed on the identifiers the
      // app was named from, which only a live app can supply, and a settle signal must
      // never be able to answer "yes" for want of somewhere to look.
      const gone = await appContainersFor(env.clients[victim].container, name)
        .then(async (cs) => cs.length === 0 && !(await getAppNetwork(env.clients[victim].container, name)))
        .catch(() => false);
      if (gone) return true;
      const status = await meshStatus(victim);
      if (status.status !== 'success' || !status.data?.identity) return false;
      const slot = status.data.lastPass?.ownSlot;
      if (slot === undefined) return false;
      return slot === null || !spareSlots.includes(slot);
    }, { timeout: 300000, interval: 10000, label: 'the returned node completes a post-restart pass without stealing a slot' });

    const targets = await srvTargets(holders[0]);
    expect(targets, 'the named set is still exactly the three ordinals').to.deep.equal(FULL_SET());
    const currentSlots = await Promise.all(holders.map((i) => ownSlotOf(i)));
    expect(currentSlots, 'the replacement and survivors keep their slots').to.deep.equal(spareSlots);
  });
});
