// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
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
const DELISTED = [3, 4, 5, 6, 7, 8]; // never the holders (0,1,2), never node 9

describe('the founding committee rots, and the exit re-deals it from the survivors', function () {
  let env;
  let name;

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
      arcane: true,
      configOverrides: {
        fluxapps: { meshReconcileIntervalMs: 15000 },
      },
    });
    await bootAndPeer(env, { pricing: true });
  });

  after(async function () {
    this.timeout(60000);
    for (const i of DELISTED) {
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

    // The spawner picks three; the founder asks below come from whichever
    // nodes ended up hosting, resolved per ask.
    await waitFor(async () => {
      const installed = await Promise.all(env.clients.map(
        (c) => waitForAppInstalled(c, name, 1).then(() => true).catch(() => false),
      ));
      return installed.filter(Boolean).length >= 3;
    }, { timeout: 360000, interval: 10000, label: 'three nodes host the app' });
  });

  it('six referees leave the list, and founding still gets its one yes from the re-dealt committee', async function () {
    this.timeout(900000);

    // NOBODY asks to found before the rot: the register stays empty, so the
    // answer below can only come through the exit re-derivation — a photo
    // committee below quorum cannot grant anything.
    for (const i of DELISTED) {
      await removeFromNodeList(getSubnetConfig().nodeIp(i + 1));
    }
    await advanceBlocks(2);

    // Ask from every hosting node's container until the verdicts settle:
    // exactly one yes, everyone else no — referees drawn from the four
    // survivors, or this waits forever and the exit is broken.
    const hosts = [];
    await waitFor(async () => {
      hosts.length = 0;
      for (let i = 0; i < env.clients.length; i += 1) {
        const found = await requireAppContainerName(env.clients[i].container, name, COMPONENT)
          .then(() => true).catch(() => false);
        if (found) hosts.push(i);
      }
      return hosts.length >= 3;
    }, { timeout: 120000, interval: 5000, label: 'the hosting nodes are identified' });

    let answers = [];
    await waitFor(async () => {
      answers = await Promise.all(hosts.map((i) => askFounder(i)));
      return answers.every((a) => a === 'yes' || a === 'no');
    }, { timeout: 300000, interval: 10000, label: 'founder answers settle on the re-dealt committee' });

    expect(answers.filter((a) => a === 'yes'), `answers: ${answers}`).to.have.length(1);
  });
});
