// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { registerEncryptedV9App, updateEncryptedV9App } from '../framework/content-helper.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
import { waitFor, waitForAppInstalled } from '../framework/wait.js';
import { authenticate } from '../auth.js';
import { appOwnerKey } from '../framework/keys.js';
import { execInContainer, requireAppContainerName } from '../framework/container.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';

const { gateway: GATEWAY } = getSubnetConfig();

// The membership LEVEL API (DNS_SERVICE_DISCOVERY_SRV.md §12): the piece that
// lets a consensus app react to membership changes with a six-line loop and
// no orchestrator. The contract is a level, never an event stream — a reactor
// reads the membership, converges its cluster to it, and long-polls for the
// generation to move; join/leave is its own set-difference, so no transition
// can be lost (there is nothing in flight to lose). What must hold:
//   1. From inside an app container, GET fluxnode.service:16101/mesh/membership
//      answers the caller's own app: a generation, self matching
//      FLUX_MESH_SELF, every member under its canonical (ordinal) name and
//      ready-made FQDN — and NO addresses (identity here, addressing in DNS).
//   2. A long-poll behind the current generation answers immediately; one AT
//      the current generation parks, and WAKES when membership changes (an
//      uninstall on another node), answering the shrunken level.
//   3. The node itself — any non-app-container caller — is refused: the
//      containers table is the tenant boundary, exactly as it is for DNS.

const MEMBERSHIP_URL = 'http://fluxnode.service:16101/mesh/membership';

describe('mesh membership level API', function () {
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

  // Container names are built from the app's minted identity, so they are RESOLVED
  // through the labels FluxOS stamps rather than reconstructed here.
  async function appContainerName(clientIndex) {
    return requireAppContainerName(env.clients[clientIndex].container, name, 'db');
  }

  async function inApp(clientIndex, command) {
    const containerName = await appContainerName(clientIndex);
    return execInContainer(env.clients[clientIndex].container, `docker exec ${containerName} ${command}`);
  }

  async function readLevel(clientIndex, query = '') {
    const out = await inApp(clientIndex, `/bin/busybox wget -qO- "${MEMBERSHIP_URL}${query}"`);
    return JSON.parse(out.stdout);
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
    name = `e2emeshlvl${Date.now()}`;
    await pushBusybox(name);

    const reg = await registerEncryptedV9App(env.clients[0].url, {
      name,
      instances: 3,
      specOverrides: { network: { mesh: true } },
      components: {
        db: {
          name: 'db',
          description: 'membership level consumer',
          image: `${REGISTRY_REPO_HOST}/${name}:v1`,
          cpu: 0.5,
          memory: 300,
          rootFsGb: 2,
          entrypoint: ['/bin/busybox', 'sh', '-c',
            'while true; do /bin/busybox nc -l -p 7001 -e /bin/busybox echo LVL-OK; done'],
          ports: { echo: { containerPort: 7001, hostPort: 31284 } },
          meshPorts: { 'db-server': { containerPort: 7001 } },
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

  it('a container reads its own level: generation, self, canonical names, no addresses', async function () {
    this.timeout(360000);
    // Wait for CONVERGED identity, not just a full slot set. Simultaneous
    // installs can bake colliding provision-time picks (claim-and-go:
    // publishClaimSlot is best-effort and arbitration converges the losers
    // through the drift-rebuild), so the arbitrated set can be complete
    // while a container still carries a losing identity — and a pending
    // rebuild would also recreate the container under the next test's
    // parked poll. Settled means: every node's own pass resolved a slot,
    // the slots are distinct, and identityDrift is empty — a completed
    // pass always writes both keys, and drift empty on the same pass as a
    // settled slot proves the running container matches it.
    await waitFor(async () => {
      const statuses = await Promise.all(env.clients.map((_, i) => meshStatus(i)));
      if (!statuses.every((s) => s.status === 'success' && s.data?.lastPass && !s.data.lastPass.error)) return false;
      const slots = statuses.map((s) => s.data.lastPass.ownSlot);
      if (!slots.every((slot) => Number.isInteger(slot))) return false;
      if (new Set(slots).size !== slots.length) return false;
      return statuses.every((s) => (s.data.lastPass.identityDrift ?? []).length === 0);
    }, { timeout: 300000, interval: 5000, label: 'slots settled and every container identity converged' });

    await waitFor(async () => {
      const level = await readLevel(0).catch(() => null);
      return level?.status === 'success'
        && level.data.members.length === 3
        && level.data.members.every((m) => Number.isInteger(m.ordinal));
    }, { timeout: 60000, interval: 5000, label: 'the level shows three slot-holders' });

    const level = await readLevel(0);
    const { data } = level;
    expect(data.app).to.equal(name);
    expect(data.generation).to.be.a('number');

    const envOut = await inApp(0, '/bin/busybox sh -c "/bin/busybox env | /bin/busybox grep FLUX_MESH_SELF="');
    const selfName = envOut.stdout.match(/FLUX_MESH_SELF=(\S+)/)?.[1];
    expect(data.self.member, 'self matches the container identity').to.equal(selfName);
    expect(data.self.fqdn).to.equal(`${selfName}.${name}.mesh.flux`);

    const ordinals = data.members.map((m) => m.ordinal);
    expect(new Set(ordinals)).to.deep.equal(new Set([0, 1, 2]));
    data.members.forEach((m) => {
      expect(m.member).to.equal(`db-${m.ordinal}`);
      expect(m.fqdn).to.equal(`db-${m.ordinal}.${name}.mesh.flux`);
    });
    // Identity only: addressing belongs to DNS, and the presented IPv4 is
    // node-local — the level must never hand out something to persist.
    expect(JSON.stringify(data)).to.not.match(/10\.127\./);
  });

  it('a long-poll behind the current generation answers immediately', async function () {
    this.timeout(120000);
    const before = Date.now();
    const level = await readLevel(0, '?waitAfter=0&timeoutS=120');
    expect(level.status).to.equal('success');
    expect(Date.now() - before, 'no park on a stale cursor').to.be.below(30000);
  });

  it('a parked long-poll WAKES on a membership change and answers the shrunken level', async function () {
    this.timeout(420000);
    const current = (await readLevel(0)).data.generation;

    // Park a poll inside a container, writing its answer to a file. Parked on
    // nodes 0 AND 1: the shrink below removes ONE instance by rank, so at
    // least one of the two parked polls survives to be read.
    const park = async (i) => {
      const containerName = await appContainerName(i);
      await execInContainer(env.clients[i].container,
        `docker exec ${containerName} /bin/busybox sh -c '`
        + `rm -f /tmp/woken.json && (/bin/busybox wget -qO /tmp/woken.json `
        + `"${MEMBERSHIP_URL}?waitAfter=${current}&timeoutS=300" && `
        + `echo done > /tmp/woken.flag) &'`);
    };
    await park(0);
    await park(1);

    // The membership change must be DURABLE: a raw appremove un-happens - the
    // spec still demands 3 instances on a 3-node fleet, so the spawner heals
    // the hole within a pass and the snapshot returns byte-identical, waking
    // nothing. Shrinking the SPEC to 2 instances is the operator's real move:
    // the healer has nothing to undo, membership genuinely contracts.
    const upd = await updateEncryptedV9App(env.clients[0].url, {
      name,
      instances: 2,
      specOverrides: { network: { mesh: true } },
      components: {
        db: {
          name: 'db',
          description: 'membership level consumer',
          image: `${REGISTRY_REPO_HOST}/${name}:v1`,
          cpu: 0.5,
          memory: 300,
          rootFsGb: 2,
          entrypoint: ['/bin/busybox', 'sh', '-c',
            'while true; do /bin/busybox nc -l -p 7001 -e /bin/busybox echo LVL-OK; done'],
          ports: { echo: { containerPort: 7001, hostPort: 31284 } },
          meshPorts: { 'db-server': { containerPort: 7001 } },
        },
      },
    });
    expect(upd.status, JSON.stringify(upd)).to.equal('success');
    await queueAppTx(upd.data);
    await advanceBlocks(3);

    // A survivor whose parked poll can still be read: whichever of 0/1 keeps
    // its container after the trim.
    const survivor = async () => {
      for (const i of [0, 1]) {
        // eslint-disable-next-line no-await-in-loop
        const alive = await appContainerName(i).then(() => i).catch(() => null);
        if (alive != null) return i;
      }
      return null;
    };
    let woke = null;
    await waitFor(async () => {
      const i = await survivor();
      if (i == null) return false;
      const out = await inApp(i, '/bin/busybox cat /tmp/woken.flag').catch(() => null);
      if (!out?.stdout?.includes('done')) return false;
      woke = i;
      return true;
    }, { timeout: 240000, interval: 5000, label: 'a surviving parked poll woke' });

    const out = await inApp(woke, '/bin/busybox cat /tmp/woken.json');
    const woken = JSON.parse(out.stdout);
    expect(woken.status).to.equal('success');
    expect(woken.data.generation, 'the level moved').to.be.greaterThan(current);
    expect(woken.data.members, 'the departed member is gone').to.have.length(2);
  });

  it('the node itself is refused — the containers table is the tenant boundary', async function () {
    this.timeout(120000);
    const probe = 'node -e "fetch(\'http://169.254.43.43:16101/mesh/membership\')'
      + '.then((r)=>r.json()).then((b)=>console.log(JSON.stringify(b)))'
      + '.catch((e)=>console.log(String(e)))"';
    const { stdout } = await execInContainer(env.clients[0].container, probe);
    expect(stdout, 'no membership for a non-app caller').to.not.include('"generation"');
  });
});
