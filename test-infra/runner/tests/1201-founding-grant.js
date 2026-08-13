// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { registerEncryptedV9App, updateEncryptedV9App } from '../framework/content-helper.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { queueAppTx, advanceBlocks, getState } from '../framework/daemon-control.js';
import { waitFor, waitForAppInstalled } from '../framework/wait.js';
import { authenticate, signBtcMessage } from '../auth.js';
import { appOwnerKey } from '../framework/keys.js';
import { execInContainer, requireAppContainerName } from '../framework/container.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';

// The founding grant across a real 3-node fleet: a container asks its own
// node "may I found?" and the node answers from a quorum-arbitrated,
// write-once register. What must hold:
//   1. EXACTLY ONE YES — all three instances ask at genesis and exactly one
//      is told yes, however the asks race; the others learn no. Yes is
//      idempotent for the recorded founder; no is stable for everyone else.
//   2. REGISTERS ARE PER COMPONENT — an update adding a component opens a
//      fresh founder question, answered under the committee photographed at
//      THAT update (the introducing anchor), and the first component's
//      founder does not move.
//   3. A RE-ADDED COMPONENT IS A NEW WORLD — remove a component, add it
//      back under the same name, and founding happens again: the dead
//      world's register and record never answer for the reborn namesake.
//   4. THE OWNER RE-ROLL RE-DEALS — the generation door refuses a skipped
//      generation teaching the next, accepts exactly stored+1 under a real
//      owner signature, and a fresh founding round runs in the new world.
// The committee here is the whole 3-node fleet (size floors at 3, quorum
// 2), so every node referees and every answer still has to be arbitrated —
// the smallest world where a founding race is a real race.

const COMPONENT = 'web';

// The app image is the harness's static-busybox (entrypoint sleeps): the
// founder asks run as `docker exec ... /bin/busybox wget` inside the app
// container, and the freestanding pause image has no binaries at all — an
// exec into it fails before any packet moves.
let appImage;

function componentSpec(name, hostPort) {
  return {
    name,
    description: 'founding grant test component',
    image: appImage,
    cpu: 0.5,
    memory: 300,
    rootFsGb: 2,
    persistentStorage: { sizeGb: 10, mounts: { '/data': { source: 'data', destination: '/data' } } },
    ports: { http: { containerPort: 80, hostPort } },
  };
}

describe('the founding grant on a multi-node fleet', function () {
  let env;
  let name;
  let ownerAuth0;

  // One founder ask from inside a component's container on one node:
  // 'yes' | 'no' | 'wait' | null (transport not up yet, container missing).
  async function askFounder(clientIndex, component) {
    try {
      const containerName = await requireAppContainerName(
        env.clients[clientIndex].container, name, component,
      );
      const { stdout } = await execInContainer(
        env.clients[clientIndex].container,
        `docker exec ${containerName} /bin/busybox wget -qO- --post-data='' http://fluxnode.service:16101/mesh/founder`,
      );
      const parsed = JSON.parse(stdout);
      return parsed?.data?.answer ?? null;
    } catch {
      return null;
    }
  }

  // Ask from every node until every answer settles to yes/no; the register
  // is write-once, so the settled answers are the verdict.
  async function settledAnswers(component) {
    let answers = [];
    await waitFor(async () => {
      answers = await Promise.all(env.clients.map((_, i) => askFounder(i, component)));
      return answers.every((a) => a === 'yes' || a === 'no');
    }, { timeout: 180000, interval: 5000, label: `founder answers settle for ${component}` });
    return answers;
  }

  async function waitForComponentContainers(component, present) {
    await waitFor(async () => {
      const names = await Promise.all(env.clients.map((c) => requireAppContainerName(c.container, name, component)
        .catch(() => null)));
      return present ? names.every((n) => n) : names.every((n) => !n);
    }, {
      timeout: 240000,
      interval: 5000,
      label: `${component} containers ${present ? 'present' : 'gone'} on all nodes`,
    });
  }

  async function pushUpdate(components) {
    const upd = await updateEncryptedV9App(env.clients[0].url, {
      name,
      instances: 3,
      components,
      specOverrides: { network: { mesh: true } },
    });
    expect(upd.status, JSON.stringify(upd)).to.equal('success');
    await queueAppTx(upd.data);
    await advanceBlocks(3);
  }

  async function readGeneration() {
    const res = await fetch(`${env.clients[0].url}/apps/grantgeneration/${name}/founder`);
    return res.json();
  }

  before(async function () {
    this.timeout(540000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 3,
      tickerAutostart: false,
      // The founding photos pin committees at spec anchor heights, which
      // needs the ANCHORED membership history — the ZMQ delta machinery
      // production runs. The harness default is the polling path, whose
      // history carries no chain anchors and can never answer at-height.
      zmqTopics: ALL_ZMQ_TOPICS,
      arcane: true,
      // Peering sized for a 3-node ring (nodes >= 2*minOutgoing+1), as the
      // mesh suites size it.
      configOverrides: {
        fluxapps: { meshReconcileIntervalMs: 15000, minOutgoing: 1, minIncoming: 1 },
      },
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });
    ownerAuth0 = (await authenticate(env.clients[0].url, appOwnerKey())).zelidauth;
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('registers a mesh app and the spawner installs it on all three nodes', async function () {
    this.timeout(360000);
    name = `e2efound${Date.now()}`;
    await pushBusybox(name);
    appImage = `${REGISTRY_REPO_HOST}/${name}:v1`;

    const reg = await registerEncryptedV9App(env.clients[0].url, {
      name,
      instances: 3,
      components: { [COMPONENT]: componentSpec(COMPONENT, 31000) },
      specOverrides: { network: { mesh: true } },
    });
    expect(reg.status, JSON.stringify(reg)).to.equal('success');
    await queueAppTx(reg.data);
    await advanceBlocks(3);

    await waitFor(async () => {
      const rows = await Promise.all(env.clients.map((c) => c.getAppSpecs(name).catch(() => null)));
      return rows.every((r) => r && r.status === 'success' && r.data && r.data.name === name);
    }, { timeout: 120000, interval: 3000, label: `global spec for ${name} on all nodes` });

    await Promise.all(env.clients.map((c) => waitForAppInstalled(c, name, 240000)));
  });

  it('exactly one container is told yes, and the verdict is stable and idempotent', async function () {
    this.timeout(300000);

    const answers = await settledAnswers(COMPONENT);
    expect(answers.filter((a) => a === 'yes'), `answers: ${answers}`).to.have.length(1);
    expect(answers.filter((a) => a === 'no')).to.have.length(2);

    // The write-once register does not change its mind: a second sweep
    // lands identically, and the founder is told yes again — a crash
    // between the ask and the bootstrap action must not wedge the app.
    const again = await Promise.all(env.clients.map((_, i) => askFounder(i, COMPONENT)));
    expect(again).to.deep.equal(answers);
  });

  it('an update adding a component opens its own founder question at its own anchor', async function () {
    this.timeout(480000);

    await pushUpdate({
      [COMPONENT]: componentSpec(COMPONENT, 31000),
      db: componentSpec('db', 31001),
    });
    await waitForComponentContainers('db', true);

    const dbAnswers = await settledAnswers('db');
    expect(dbAnswers.filter((a) => a === 'yes'), `answers: ${dbAnswers}`).to.have.length(1);

    // The first component's world did not move: its verdict re-reads
    // unchanged, from the record, with no fresh round.
    const webAnswers = await Promise.all(env.clients.map((_, i) => askFounder(i, COMPONENT)));
    expect(webAnswers.filter((a) => a === 'yes')).to.have.length(1);
  });

  it('a removed and re-added component is a NEW world and founds again', async function () {
    this.timeout(600000);

    await pushUpdate({ [COMPONENT]: componentSpec(COMPONENT, 31000) });
    await waitForComponentContainers('db', false);

    await pushUpdate({
      [COMPONENT]: componentSpec(COMPONENT, 31000),
      db: componentSpec('db', 31001),
    });
    await waitForComponentContainers('db', true);

    // The dead world's register recorded a founder; the reborn namesake
    // must not inherit it — founding happens AGAIN, exactly once.
    const answers = await settledAnswers('db');
    expect(answers.filter((a) => a === 'yes'), `answers: ${answers}`).to.have.length(1);
  });

  it('the generation door teaches, accepts exactly stored+1, and the re-roll re-deals founding', async function () {
    this.timeout(480000);

    const before = await readGeneration();
    expect(before.status).to.equal('success');
    expect(before.data.generation).to.equal(0);

    const owner = appOwnerKey();
    const { currentHeight } = await getState();
    const at = Date.now();

    async function submitGeneration(generation) {
      const canonical = `fluxgrantgeneration:${name}|founder|${generation}|${currentHeight}|${at}`;
      const signature = await signBtcMessage(canonical, owner.privkey);
      const res = await fetch(`${env.clients[0].url}/apps/grantgeneration`, {
        method: 'POST',
        headers: { zelidauth: ownerAuth0, 'content-type': 'application/json' },
        body: JSON.stringify({
          appName: name, role: 'founder', generation, height: currentHeight, at, signature,
        }),
      });
      return { code: res.status, body: await res.json() };
    }

    // A skipped generation is refused, teaching the next honest submission.
    const skipped = await submitGeneration(2);
    expect(skipped.code).to.equal(409);
    expect(skipped.body.data.message).to.contain('the next is 1');

    const accepted = await submitGeneration(1);
    expect(accepted.code, JSON.stringify(accepted.body)).to.equal(200);

    // The record broadcast reaches every node's read surface.
    await waitFor(async () => {
      const reads = await Promise.all(env.clients.map(async (c) => {
        const res = await fetch(`${c.url}/apps/grantgeneration/${name}/founder`);
        return res.json();
      }));
      return reads.every((r) => r.status === 'success' && r.data.generation === 1);
    }, { timeout: 120000, interval: 5000, label: 'generation 1 standing on all nodes' });

    // The re-rolled world runs a fresh founding round: new cells, one yes.
    const answers = await settledAnswers(COMPONENT);
    expect(answers.filter((a) => a === 'yes'), `answers: ${answers}`).to.have.length(1);
  });
});
