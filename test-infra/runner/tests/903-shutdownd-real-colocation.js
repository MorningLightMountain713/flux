// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { registerEncryptedV9App, updateEncryptedV9App } from '../framework/content-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { queueAppTx, advanceBlock, advanceBlocks } from '../framework/daemon-control.js';
import { waitFor } from '../framework/wait.js';
import {
  appContainersFor, getAppContainerStatus, execInContainer,
} from '../framework/container.js';
import { closeDb } from '../framework/db-client.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';

// The REAL flux-shutdownd against real FluxOS, co-located replicas only.
//
// Suite 80 pins the FluxOS half of the daemon contract against the mock: that
// one plan is pushed per deployed identity and that a de-target drains under
// the departing replica's name. The mock answers those calls by construction —
// it is our own code agreeing with itself — so it is structurally blind to the
// two real ends disagreeing. This suite closes that gap for co-location by
// running the actual Rust daemon (the pinned build from
// test-infra/flux-shutdownd) in place of the mock:
//
//   - the plans land in the daemon's OWN encrypted store, keyed per identity,
//     and are read back through `shutdownctl` — the operator's view, not a test
//     fixture's;
//   - the drain is resolved by the daemon's OWN container grouping, which reads
//     the runonflux.replica label off each container and pairs it with that
//     identity's component plan. A label the daemon cannot read, or a key shape
//     the two sides disagree on, fails here and nowhere else.
//
// Scope is deliberately narrow: the drain semantics the daemon shares with
// loose placement (end states, budgets, the node-pipeline rejection) are the
// mock suites' 59/62/63 territory and have their own real-daemon gap, tracked
// separately.
//
// Port slice: 37xxx.

const subnet = getSubnetConfig();
const nodeIp = (num) => subnet.nodeIp(num);

const HOST_NODE = 2;
const HOST_IDX = HOST_NODE - 1;

describe('flux-shutdownd (real): per-identity plans and replica-scoped drains', function () {
  let env;
  let host;

  const appName = `rcoloc${Date.now()}`;

  function webComponents({ hostPort, replicaOverrides } = {}) {
    return {
      web: {
        name: 'web',
        description: 'real-daemon co-location component',
        image: `${REGISTRY_REPO_HOST}/${appName}:v1`,
        cpu: 0.5,
        memory: 300,
        rootFsGb: 2,
        persistentStorage: { sizeGb: 10, mounts: { '/data': { source: 'data', destination: '/data' } } },
        ports: { game: { containerPort: 8080, hostPort } },
        // Graceful shutdown is what earns the app a daemon plan at all, and the
        // budget is what the daemon must honour per container — without it the
        // stop is indistinguishable from a plain docker stop.
        shutdown: { gracefulTimeout: 5 },
        ...(replicaOverrides ? { replicaOverrides } : {}),
      },
    };
  }

  async function shutdownctl(args) {
    const { stdout } = await execInContainer(host.container, `shutdownctl ${args}`);
    return stdout.trim();
  }

  async function inspectReplica(replica, format) {
    const cont = await getAppContainerStatus(host.container, appName, { replica });
    if (!cont) return null;
    const { stdout } = await execInContainer(
      host.container,
      `docker inspect --format '${format}' ${cont.name}`,
    );
    return stdout.trim();
  }

  async function replicaStartedAt(replica) {
    return (await inspectReplica(replica, '{{.State.StartedAt}}')) ?? '';
  }

  async function runningReplicas() {
    const conts = await appContainersFor(host.container, appName);
    return conts
      .filter((c) => c.status?.startsWith('Up'))
      .map((c) => c.name.split('_').pop())
      .sort();
  }

  async function untilWithBlocks(check, { rounds = 45, label } = {}) {
    for (let i = 0; i < rounds; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const { currentHeight } = await advanceBlock();
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(env.clients.map((c) => c.waitForEvent(
        'block:processed', (d) => d.height >= currentHeight, 60000,
      )));
      // eslint-disable-next-line no-await-in-loop
      if (await check()) return;
    }
    throw new Error(`${label} not reached within ${rounds} block-advancing rounds`);
  }

  before(async function () {
    this.timeout(600000);
    env = await createTestEnv({
      hookCtx: this, nodes: 5, tickerAutostart: false, arcane: true, shutdowndReal: true,
      configOverrides: {
        fluxapps: {
          minOutgoing: 2,
          spawnDeferrals: { targetedNodesMs: { encrypted: 30000, standard: 30000 } },
          adoptionStaggerStepMs: 15000,
          adoptionStaggerWindowMs: 15000,
        },
      },
    });
    await bootAndPeer(env, { minOutbound: 2, minInbound: 2, pricing: true });
    host = env.clients[HOST_IDX];

    await pushImage(appName, 'v1');

    const res = await registerEncryptedV9App(env.clients[0].url, {
      name: appName,
      assignment: { targetIps: { [nodeIp(HOST_NODE)]: ['s1', 's2'] } },
      components: webComponents({
        hostPort: 37010,
        replicaOverrides: { s2: { ports: { game: { hostPort: 37011 } } } },
      }),
    });
    expect(res.status, `register ${appName}`).to.equal('success');
    await queueAppTx(res.data);
    await advanceBlocks(3);

    await waitFor(
      async () => (await runningReplicas()).join(',') === 's1,s2',
      { timeout: 420000, interval: 3000, label: `${appName} co-located pair running` },
    );
  });

  after(async function () {
    this.timeout(30000);
    await closeDb();
    await env?.teardown();
  });

  it('is the real daemon, answering on its own dbus interface', async function () {
    this.timeout(60000);
    // The mock has no dbus surface at all: if this answers, the process under
    // test is the Rust daemon rather than the stand-in.
    const status = await shutdownctl('status');
    expect(status, `shutdownctl status: ${status}`).to.not.equal('');
  });

  it('holds one plan per identity in its own store, keyed by replica', async function () {
    this.timeout(120000);
    await waitFor(
      async () => {
        const out = await shutdownctl('plans');
        return out.includes('replica=s1') && out.includes('replica=s2');
      },
      { timeout: 90000, interval: 3000, label: 'both identities present in the daemon plan store' },
    );

    const out = await shutdownctl('plans');
    const lines = out.split('\n').filter((l) => l.includes(appName));
    expect(lines.length, `one plan line per identity, got:\n${out}`).to.equal(2);
    // Two plans for ONE app on ONE node is the shape a per-app key cannot
    // represent — under the old key the second push replaced the first.
    expect(lines.filter((l) => l.includes('replica=s1')).length).to.equal(1);
    expect(lines.filter((l) => l.includes('replica=s2')).length).to.equal(1);
  });

  it('drains only the de-targeted identity, resolved from the container labels', async function () {
    this.timeout(420000);
    const s1Before = await replicaStartedAt('s1');
    expect(s1Before, 's1 running before the de-target').to.not.equal('');

    const upd = await updateEncryptedV9App(env.clients[0].url, {
      name: appName,
      assignment: { targetIps: { [nodeIp(HOST_NODE)]: ['s1'] } },
      components: webComponents({ hostPort: 37010 }),
    });
    expect(upd.status, `update ${appName}`).to.equal('success');
    await queueAppTx(upd.data);
    await advanceBlocks(3);

    // The daemon groups the app's containers by their runonflux.replica label
    // and drains only the group it was named. Getting this wrong takes the
    // sibling down, which is exactly what the label grouping exists to prevent.
    await untilWithBlocks(
      async () => (await runningReplicas()).join(',') === 's1',
      { rounds: 60, label: `${appName} converged to s1 alone` },
    );
    expect(await replicaStartedAt('s1'), 's1 must serve unbroken through its sibling\'s drain').to.equal(s1Before);

    // The departed identity's plan is gone from the real store; s1's remains.
    await waitFor(
      async () => {
        const out = await shutdownctl('plans');
        return out.includes('replica=s1') && !out.includes('replica=s2');
      },
      { timeout: 120000, interval: 3000, label: "only s1's plan remains in the daemon store" },
    );
  });
});
