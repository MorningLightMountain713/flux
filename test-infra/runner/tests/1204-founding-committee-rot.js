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
// network before the app ever founds. The exit rule must carry it — once
// fewer than a quorum of the photo's owners remain on the current list,
// every reader independently re-derives a fresh committee from the
// survivors, same arithmetic, same answer everywhere — and a founder ask
// that would otherwise wait forever gets its one yes from referees that
// exist. Ten nodes: the photo seats nine, six get delisted (at least five
// of them committee seats, since only one node was ever off it), and the
// four survivors re-deal a committee of four, quorum three. Dead referees
// never wedge a register.

const COMPONENT = 'web';
// Six seats leave. The photo seats nine of the ten nodes, so delisting six
// drops the survivors to four however the seats fell — below the photo's
// quorum of five, which is the exit's trigger. WHICH six is a run-time
// decision: the spawner places the app, so the hosting nodes are not known
// until it has, and delisting a host would take the ASKING side down with
// the referees rather than testing them.
const DELIST_COUNT = 6;

describe('the founding committee rots, and the exit re-deals it from the survivors', function () {
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
          quorumGrantAskTimeoutMs: 3000,
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

  it('six referees leave the list, and founding still gets its one yes from the re-dealt committee', async function () {
    this.timeout(900000);

    // NOBODY asks to found before the rot: the register stays empty, so the
    // answer below can only come through the exit re-derivation — a photo
    // committee below quorum cannot grant anything.
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

    // Ask from every hosting node's container until the verdicts settle:
    // exactly one yes, everyone else no — referees drawn from the four
    // survivors, or this waits forever and the exit is broken.

    let answers = [];
    await waitFor(async () => {
      answers = await Promise.all(hosts.map((i) => askFounder(i)));
      return answers.every((a) => a === 'yes' || a === 'no');
    }, { timeout: 300000, interval: 10000, label: 'founder answers settle on the re-dealt committee' });

    expect(answers.filter((a) => a === 'yes'), `answers: ${answers}`).to.have.length(1);
  });
});
