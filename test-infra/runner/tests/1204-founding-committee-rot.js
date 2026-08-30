// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { registerEncryptedV9App } from '../framework/content-helper.js';
import { pushBusybox } from '../framework/registry-helper.js';
import {
  queueAppTx, advanceBlocks, removeFromNodeList, restoreToNodeList,
} from '../framework/daemon-control.js';
import { waitFor, waitForAppInstalled } from '../framework/wait.js';
import { execInContainer, requireAppContainerName } from '../framework/container.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';

// David's year-old-referees challenge, run for real: the founding photo
// pins nine referees at registration, and then most of them LEAVE the
// network before the app ever founds. THE FLIP must carry it (8.5 — the
// old read-time exit rule was the two-committees-one-register hazard the
// model broke): rot sustained past the gate lag arms the world, the
// evaluator photographs a NEW basis at the next rung of the fixed grid —
// a chain height, so every node mints the same answer — and the founder
// asks move to the rung's register, where the survivors' committee gives
// its one yes. Ten nodes: the photo seats nine, six get delisted (at
// least five of them committee seats, since only one node was ever off
// it), the rung's committee re-deals from the four survivors. Dead
// referees never wedge a register — and never fork one either.

const COMPONENT = 'web';
// Six seats leave. The photo seats nine of the ten nodes, so delisting six
// drops the survivors to four however the seats fell — below the photo's
// quorum of five, which is the rot the gate measures. WHICH six is a run-time
// decision: the spawner places the app, so the hosting nodes are not known
// until it has, and delisting a host would take the ASKING side down with
// the referees rather than testing them.
const DELIST_COUNT = 6;

describe('the founding committee rots, and the flip re-anchors it at the rung', function () {
  let env;
  let name;
  let hosts = []; // node indexes the spawner placed the app on
  let delisted = []; // node indexes taken off the list, restored on teardown

  async function askFounder(clientIndex) {
    try {
      const containerName = await requireAppContainerName(
        env.clients[clientIndex].container, name, COMPONENT,
      );
      const { stdout } = await execInContainer(
        env.clients[clientIndex].container,
        `docker exec ${containerName} /bin/busybox wget -qO- --post-data='' http://fluxnode.service:16101/mesh/founder`,
      );
      return JSON.parse(stdout)?.data?.answer ?? null;
    } catch {
      return null;
    }
  }

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 10,
      tickerAutostart: false,
      // The founding photos pin committees at spec anchor heights, which
      // needs the ANCHORED membership history — the ZMQ delta machinery
      // production runs. The harness default is the polling path, whose
      // history carries no chain anchors and can never answer at-height.
      zmqTopics: ALL_ZMQ_TOPICS,
      arcane: true,
      configOverrides: {
        fluxapps: {
          meshReconcileIntervalMs: 15000,
          // Grant timings compressed like every decider cadence the harness
          // overlays - production values are minutes, and the boot drain
          // alone (maxTtl) would eat the whole settle window.
          quorumGrantMaxTtlMs: 30000,
          quorumGrantDrainMs: 20000,
          quorumGrantLockDelayMs: 10000,
          // renewInterval must sit strictly under lockDelayMs or
          // timingIsSafe refuses and the plane stays inert
          quorumGrantRenewIntervalMs: 5000,
          quorumGrantAskTimeoutMs: 3000,
          // The flip dials, compressed like every other cadence: a rung
          // grid of 4 blocks, rot aged 2 blocks before the gate, a
          // 1-block quiet zone, the evaluator every 2s. Production runs
          // hours on all four (the 8.5 dial rule).
          founderFlipNBlocks: 4,
          founderGateLagBlocks: 2,
          founderQuietZoneBlocks: 1,
          founderFlipEvaluateIntervalMs: 2000,
        },
      },
    });
    await bootAndPeer(env, { pricing: true });
  });

  after(async function () {
    this.timeout(60000);
    for (const i of delisted) {
      await restoreToNodeList(getSubnetConfig().nodeIp(i + 1)).catch(() => {});
    }
    await env?.teardown();
  });

  it('registers a mesh app on the full fleet and installs it on three nodes', async function () {
    this.timeout(480000);
    name = `e2erot${Date.now()}`;
    // static busybox, not pause: the founder asks exec wget in-container
    await pushBusybox(name);

    const reg = await registerEncryptedV9App(env.clients[0].url, {
      name,
      instances: 3,
      image: `${REGISTRY_REPO_HOST}/${name}:v1`,
      specOverrides: { network: { mesh: true } },
    });
    expect(reg.status, JSON.stringify(reg)).to.equal('success');
    await queueAppTx(reg.data);
    await advanceBlocks(3);

    await waitFor(async () => {
      const rows = await Promise.all(env.clients.map((c) => c.getAppSpecs(name).catch(() => null)));
      return rows.every((r) => r && r.status === 'success' && r.data && r.data.name === name);
    }, { timeout: 180000, interval: 5000, label: `global spec for ${name} on all nodes` });

    // The spawner picks three. Which three decides everything below: the
    // founder asks come from these containers, and the seats that leave are
    // drawn from the rest.
    await waitFor(async () => {
      const installed = await Promise.all(env.clients.map(
        (c) => waitForAppInstalled(c, name, 1).then(() => true).catch(() => false),
      ));
      return installed.filter(Boolean).length >= 3;
    }, { timeout: 360000, interval: 10000, label: 'three nodes host the app' });

    hosts = [];
    for (let i = 0; i < env.clients.length; i += 1) {
      const found = await requireAppContainerName(env.clients[i].container, name, COMPONENT)
        .then(() => true).catch(() => false);
      if (found) hosts.push(i);
    }
    expect(hosts.length, `hosting nodes: ${hosts}`).to.be.at.least(3);
  });

  it('six referees leave the list, the flip mints the rung, and founding gets its one yes there', async function () {
    this.timeout(900000);

    // NOBODY asks to found before the rot: the register stays empty, so the
    // answer below can only come through the flip — a photo committee below
    // quorum cannot grant anything, and the old basis never re-deals.
    const nonHosts = env.clients.map((_, i) => i).filter((i) => !hosts.includes(i));
    expect(nonHosts.length, `non-hosting nodes: ${nonHosts}`).to.be.at.least(DELIST_COUNT);
    delisted = nonHosts.slice(0, DELIST_COUNT);
    for (const i of delisted) {
      await removeFromNodeList(getSubnetConfig().nodeIp(i + 1));
    }
    await advanceBlocks(2);

    // The rot took referees only, so the asking side is untouched — confirm
    // that before asking, or a missing container would read as the register
    // refusing to answer.
    await waitFor(async () => {
      const present = await Promise.all(hosts.map(
        (i) => requireAppContainerName(env.clients[i].container, name, COMPONENT)
          .then(() => true).catch(() => false),
      ));
      return present.every(Boolean);
    }, { timeout: 120000, interval: 5000, label: 'the hosting nodes still hold their containers' });

    // THE FLIP ITSELF must run — drive the chain to the rung and demand
    // the mint event on a quorum's worth of nodes. The rung height is grid
    // arithmetic every node computes identically; the event names the
    // world and the rung, so a re-derivation of the OLD basis can never
    // fake this green.
    const markers = env.clients.map((c) => c.getLastEventId());
    await waitFor(async () => {
      await advanceBlocks(1);
      const flipped = await Promise.all(env.clients.map(
        (c, i) => c.waitForEvent('quorumGrant:founderFlip', (d) => d.appName === name, 1, { afterId: markers[i] })
          .then(() => true).catch(() => false),
      ));
      return flipped.filter(Boolean).length >= 3;
    }, { timeout: 240000, interval: 5000, label: 'the flip rung mints across the fleet' });

    // Ask from every hosting node's container until the verdicts settle:
    // exactly one yes, everyone else no — the register at the rung, its
    // committee drawn from the survivors, or this waits forever and the
    // flip is broken. A block per pass keeps every view inside the
    // freshness gate, as the real chain would.
    let answers = [];
    await waitFor(async () => {
      await advanceBlocks(1);
      answers = await Promise.all(hosts.map((i) => askFounder(i)));
      return answers.every((a) => a === 'yes' || a === 'no');
    }, { timeout: 300000, interval: 10000, label: 'founder answers settle at the rung' });

    expect(answers.filter((a) => a === 'yes'), `answers: ${answers}`).to.have.length(1);
  });
});
