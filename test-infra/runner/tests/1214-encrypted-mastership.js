// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { registerEncryptedV9App } from '../framework/content-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
import { setSynced } from '../framework/syncthing-control.js';
import {
  getAppContainerStatus, appComponentIdentifiers, execInContainer,
  pauseHostContainer, unpauseHostContainer,
} from '../framework/container.js';
import { waitFor, waitForAppInstalled } from '../framework/wait.js';
import { authenticate } from '../auth.js';
import { fluxTeamKey } from '../framework/keys.js';

// The encrypted referee (owed since 13C): a SEALED spec as the grant consumer.
// Everything the plane reads must come off the encrypted path's cleartext
// surfaces — the owner for the committee walk's hard rules, the registration
// anchor for the founding photo, the identity-minted identifiers for the
// physical world (an encrypted v9 component's identifier carries no trace of
// the app's name, so every name-derived shortcut in the fixtures is a lie
// here — the suite reads identifiers off the containers, as production does).
// One held term forming and one failover through it prove the whole read path.

describe('encrypted mastership: a sealed spec holds and fails over a term', function () {
  let env;
  let name;
  let hosts = [];
  let identifiers = new Map(); // node index -> physical identifier

  async function readCell(clientIndex) {
    try {
      const res = await fetch(
        `${env.clients[clientIndex].url}/flux/quorumgrant/record?key=${encodeURIComponent(`${name}/master`)}`,
        { signal: AbortSignal.timeout(5000) },
      );
      const body = await res.json();
      return body?.data?.accepted ?? null;
    } catch {
      return null;
    }
  }

  async function quorumVerdict() {
    const cells = await Promise.all(env.clients.map((_, i) => readCell(i)));
    const live = cells.filter((c) => c && c.grantee && !c.released);
    const counts = new Map();
    for (const cell of live) {
      counts.set(cell.grantee, (counts.get(cell.grantee) ?? 0) + 1);
    }
    for (const [grantee, count] of counts.entries()) {
      if (count >= 5) return { grantee };
    }
    return null;
  }

  async function runningMasters(skip = new Set()) {
    const statuses = await Promise.all(env.clients.map(
      (c, i) => (skip.has(i) ? Promise.resolve(null) : getAppContainerStatus(c.container, name).catch(() => null)),
    ));
    return statuses.filter((st) => st && st.status.startsWith('Up')).length;
  }

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 10,
      tickerAutostart: false,
      zmqTopics: ALL_ZMQ_TOPICS,
      configOverrides: {
        fluxapps: {
          quorumGrantMastership: true,
          quorumGrantHeldTtlMs: 90000,
          quorumGrantRenewIntervalMs: 10000,
          quorumGrantLockDelayMs: 15000,
          quorumGrantDemotionSlackMs: 5000,
          quorumGrantMaxTtlMs: 120000,
          quorumGrantDrainMs: 90000,
          quorumGrantMinHolderAgeMs: 0,
          quorumGrantPursuitIntervalMs: 10000,
          quorumGrantUnknownGraceMs: 30000,
          quorumGrantMinFluxOSVersion: '8.13.1',
        },
      },
    });
    // A REAL registration prices the spec at validation: the pricing
    // bootstrap is part of boot for every suite that registers on-chain.
    await bootAndPeer(env, { pricing: true });

    name = `e2eseal${Date.now()}`;
    await pushImage(name, 'v1');
    const reg = await registerEncryptedV9App(env.clients[0].url, {
      name,
      instances: 3,
      image: `${REGISTRY_REPO_HOST}/${name}:v1`,
      components: {
        web: {
          name: 'web',
          description: 'sealed activeStandby component',
          image: `${REGISTRY_REPO_HOST}/${name}:v1`,
          cpu: 0.5,
          memory: 300,
          rootFsGb: 2,
          persistentStorage: {
            sizeGb: 10,
            mounts: { '/appdata': { source: 'appdata', destination: '/appdata' } },
            sync: { mode: 'activeStandby' },
          },
          ports: { http: { containerPort: 80, hostPort: 31200 } },
        },
      },
    });
    expect(reg.status, JSON.stringify(reg).slice(0, 300)).to.equal('success');
    await queueAppTx(reg.data);
    await advanceBlocks(3);

    await waitFor(async () => {
      const rows = await Promise.all(env.clients.map((c) => c.getAppSpecs(name).catch(() => null)));
      return rows.every((r) => r && r.status === 'success' && r.data && r.data.name === name);
    }, { timeout: 180000, interval: 5000, label: `global spec for ${name} on all nodes` });

    // Targeted installs: the spawner's same-ip-range guard refuses to
    // co-place a syncthing app twice inside one /24, and the whole harness
    // fleet IS one /24 — production spread semantics, unreachable here. The
    // install endpoint reads the propagated sealed spec and runs the real
    // decrypt+install path on each chosen node.
    hosts = [0, 1, 2];
    const teamKey = fluxTeamKey();
    for (const i of hosts) {
      const auth = await authenticate(env.clients[i].url, teamKey);
      const body = await env.clients[i].installAppLocally(name, auth.zelidauth);
      if (/error/i.test(body) && !/success/i.test(body.slice(-300))) {
        throw new Error(`installapplocally failed on node ${i}: ${body.slice(-600)}`);
      }
    }
    await Promise.all(hosts.map((i) => waitForAppInstalled(env.clients[i], name, 240000)));

    // The spawner can race a 4th instance into the claim-propagation window,
    // and the surplus trim then sheds by runningSince rank — possibly one of
    // the targeted nodes (gate 3: node-05 spawned itself in, node-02
    // self-evicted 4s after its own install). Placement is the network's
    // decision: wait for it to settle at the spec's 3 and RE-DERIVE the
    // hosting set from the surviving locations, never assume the targeted
    // three all kept their seats.
    const ipToIndex = new Map(env.clients.map((c, i) => (c ? [c.ip, i] : null)).filter(Boolean));
    let survivorIps = [];
    await waitFor(async () => {
      const res = await env.clients[0].getAppLocations(name).catch(() => null);
      const ips = (res && res.data ? res.data : []).map((l) => String(l.ip).split(':')[0]);
      if (ips.length !== 3) { survivorIps = []; return false; }
      const same = survivorIps.length === 3 && ips.every((ip) => survivorIps.includes(ip));
      survivorIps = ips;
      return same; // three instances, stable across two consecutive polls
    }, { timeout: 180000, interval: 5000, label: 'placement settled at the spec\'s 3 instances' });
    hosts = survivorIps.map((ip) => ipToIndex.get(ip)).filter((i) => i != null).sort((a, b) => a - b);
    expect(hosts.length, `every surviving location maps to a fleet node (${survivorIps.join(',')})`).to.equal(3);

    // Identity-minted identifiers are opaque, so the physical names are read
    // OFF the containers — never derived from the name.
    identifiers = new Map();
    for (const i of hosts) {
      const ids = await appComponentIdentifiers(env.clients[i].container, name).catch(() => []);
      expect(ids.length, `an identifier resolved on node ${i}`).to.be.greaterThan(0);
      identifiers.set(i, ids[0]);
    }

    // Synced-on-every-holder before the term forms, by IDENTIFIER — the stall
    // ladder otherwise removes the standbys mid-test (see 1209's before).
    await Promise.all(hosts.map(async (i) => {
      const appDataDir = `/mnt/appdata/flux-apps/flux${identifiers.get(i)}/appdata`;
      const r = await execInContainer(env.clients[i].container, `sh -c 'mkdir -p ${appDataDir} && echo seeded > ${appDataDir}/seed-data'`);
      expect(r.exitCode, `seed data written on node ${i}: ${r.output}`).to.equal(0);
    }));
    await setSynced({ folder: `flux${identifiers.get(hosts[0])}` });
  });

  after(async function () {
    this.timeout(120000);
    await env?.teardown();
  });

  it('a held term forms through the sealed spec and exactly one master runs', async function () {
    this.timeout(600000);

    let verdict = null;
    await waitFor(async () => {
      verdict = await quorumVerdict();
      return verdict !== null;
    }, { timeout: 300000, interval: 10000, label: 'a grant quorum forms for the sealed app' });

    await waitFor(async () => (await runningMasters()) === 1, {
      timeout: 180000, interval: 10000, label: 'exactly one master runs',
    });
  });

  it('the sealed term fails over: a dead master is replaced through the same committee', async function () {
    this.timeout(600000);

    const before1 = await quorumVerdict();
    expect(before1, 'a standing term').to.not.equal(null);
    // The master is whichever host runs the container.
    let masterIndex = -1;
    for (const i of hosts) {
      const st = await getAppContainerStatus(env.clients[i].container, name).catch(() => null);
      if (st && st.status.startsWith('Up')) masterIndex = i;
    }
    expect(masterIndex, 'the master is one of the hosts').to.be.greaterThan(-1);

    await pauseHostContainer(env.clients[masterIndex].container);
    try {
      await waitFor(async () => {
        const now = await quorumVerdict();
        return now !== null && now.grantee !== before1.grantee;
      }, { timeout: 300000, interval: 10000, label: 'a standby takes the term' });
      await waitFor(async () => (await runningMasters(new Set([masterIndex]))) === 1, {
        timeout: 180000, interval: 10000, label: 'exactly one successor runs',
      });
    } finally {
      await unpauseHostContainer(env.clients[masterIndex].container).catch(() => {});
    }
  });
});
