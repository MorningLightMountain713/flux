// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { registerEncryptedV9App } from '../framework/content-helper.js';
import { authenticate } from '../auth.js';
import { fluxTeamKey } from '../framework/keys.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';
import {
  queueAppTx, advanceBlocks, removeFromNodeList, restoreToNodeList,
} from '../framework/daemon-control.js';
import { waitFor, waitForAppInstalled } from '../framework/wait.js';
import { dbClient } from '../framework/db-client.js';
import { execInContainer, requireAppContainerName } from '../framework/container.js';
import { partition, healPartition } from '../framework/partition.js';

// The TLC run-7 trace, replayed on real machinery (formal/founder-pin-expiry,
// §8.5): the irreducible residue of the flip is a founding validly completed
// inside a network pocket whose record reaches nobody while the majority's
// gate reads "undecided", flips, and founds again. The model proved no rule
// closes it and proved the convergence that reconciles it; this suite pins
// that convergence end to end — two founders born on opposite sides of a
// cut, and on heal exactly one survives, the pocket's folding to the
// HIGHER rung by the record alone (its own evaluator rightly never mints
// the rung: post-heal its old committee stands again).
//
// The partition is iptables inside the pocket nodes (framework/partition.js)
// — other fleet nodes and the chain feed cut, the on-box stand-ins (mongo,
// syncthing stub) kept, the runner's observability untouched.

const COMPONENT = 'web';

describe('two founders born across a partition converge to one on heal', function () {
  let env;
  let name;
  let anchor;
  let pocket = []; // node indexes cut off, ⊇ a committee quorum, incl. one host
  let hostIn = null; // the pocket's hosting node
  let hostsOut = []; // majority-side hosting nodes
  let delisted = [];

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
      zmqTopics: ALL_ZMQ_TOPICS,
      arcane: true,
      configOverrides: {
        fluxapps: {
          meshReconcileIntervalMs: 15000,
          quorumGrantMaxTtlMs: 30000,
          quorumGrantDrainMs: 20000,
          quorumGrantLockDelayMs: 10000,
          quorumGrantAskTimeoutMs: 3000,
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
    await healPartition(env, pocket).catch(() => {});
    for (const i of delisted) {
      await restoreToNodeList(getSubnetConfig().nodeIp(i + 1)).catch(() => {});
    }
    await env?.teardown();
  });

  it('registers the app, learns the committee, and seats hosts astride the future cut', async function () {
    this.timeout(480000);
    name = `e2epocket${Date.now()}`;
    await pushBusybox(name);

    const reg = await registerEncryptedV9App(env.clients[0].url, {
      name,
      instances: 3,
      image: `${REGISTRY_REPO_HOST}/${name}:v1`,
      specOverrides: { network: { mesh: true } },
    });
    expect(reg.status, JSON.stringify(reg).slice(0, 300)).to.equal('success');
    await queueAppTx(reg.data);
    await advanceBlocks(3);

    await waitFor(async () => {
      const rows = await Promise.all(env.clients.map((c) => c.getAppSpecs(name).catch(() => null)));
      return rows.every((r) => r && r.status === 'success' && r.data && r.data.name === name);
    }, { timeout: 180000, interval: 5000, label: `global spec for ${name} on all nodes` });

    // The anchor is row metadata, not spec content: the API serves the
    // serialized spec without it, the stored row carries it.
    anchor = (await dbClient(1).getGlobalApp(name))?.height;
    expect(Number.isInteger(anchor), `the stored row carries the anchor height (${anchor})`).to.equal(true);

    // The committee decides the pocket: read it from the discovery endpoint
    // (public facts) and cut off SIX members — a quorum of five plus one
    // spare — so the pocket can found alone and the survivors' list rots.
    const res = await fetch(
      `${env.clients[0].url}/flux/quorumgrant/foundingbasis?app=${encodeURIComponent(name)}&anchor=${anchor}`,
      { signal: AbortSignal.timeout(10000) },
    );
    const body = await res.json();
    const members = body?.data?.basis?.members ?? [];
    expect(members.length, 'the photo seats nine').to.equal(9);
    const cfg = getSubnetConfig();
    const memberIdx = members
      .map((m) => env.clients.findIndex((c, i) => m.ip && m.ip.startsWith(cfg.nodeIp(i + 1))))
      .filter((i) => i !== -1);
    expect(memberIdx.length, 'committee members map to fleet nodes').to.equal(9);
    pocket = memberIdx.slice(0, 6);
    [hostIn] = pocket;
    hostsOut = env.clients.map((unused, i) => i).filter((i) => !pocket.includes(i)).slice(0, 2);

    // Targeted installs astride the cut (owners cannot pick nodes — the
    // fixture authenticates as the flux team, the 1214 lesson).
    const teamKey = fluxTeamKey();
    for (const i of [hostIn, ...hostsOut]) {
      // eslint-disable-next-line no-await-in-loop
      const auth = await authenticate(env.clients[i].url, teamKey);
      // eslint-disable-next-line no-await-in-loop
      const installBody = await env.clients[i].installAppLocally(name, auth.zelidauth);
      if (/error/i.test(installBody) && !/success/i.test(installBody.slice(-300))) {
        throw new Error(`installapplocally failed on node ${i}: ${installBody.slice(-600)}`);
      }
    }
    await Promise.all([hostIn, ...hostsOut].map((i) => waitForAppInstalled(env.clients[i], name, 240000)));
  });

  it('the pocket founds inside its freshness window, unseen', async function () {
    this.timeout(480000);
    await partition(env, pocket);

    // Inside the pocket everything looks healthy for chainStaleAfterMs: the
    // committee quorum is reachable, the tip is minutes old, the asker gate
    // passes. The founding is LEGITIMATE — that is the whole point.
    let answer = null;
    await waitFor(async () => {
      answer = await askFounder(hostIn);
      return answer === 'yes';
    }, { timeout: 180000, interval: 10000, label: 'the pocket seats its founder' });
    expect(answer).to.equal('yes');
  });

  it('the majority delists the silent pocket, flips, and founds at the rung', async function () {
    this.timeout(900000);
    delisted = [...pocket];
    for (const i of delisted) {
      // eslint-disable-next-line no-await-in-loop
      await removeFromNodeList(getSubnetConfig().nodeIp(i + 1));
    }
    await advanceBlocks(2);

    const majority = env.clients.map((unused, i) => i).filter((i) => !pocket.includes(i));
    const markers = majority.map((i) => env.clients[i].getLastEventId());
    await waitFor(async () => {
      await advanceBlocks(1);
      const flipped = await Promise.all(majority.map(
        (i, k) => env.clients[i].waitForEvent('quorumGrant:founderFlip', (d) => d.appName === name, 1, { afterId: markers[k] })
          .then(() => true).catch(() => false),
      ));
      return flipped.filter(Boolean).length >= 3;
    }, { timeout: 240000, interval: 5000, label: 'the flip rung mints on the majority' });

    let answers = [];
    await waitFor(async () => {
      await advanceBlocks(1);
      answers = await Promise.all(hostsOut.map((i) => askFounder(i)));
      return answers.every((a) => a === 'yes' || a === 'no');
    }, { timeout: 300000, interval: 10000, label: 'the majority founds at the rung' });
    expect(answers.filter((a) => a === 'yes'), `majority answers: ${answers}`).to.have.length(1);
  });

  it('heal: the pocket founder reads the higher rung and stands down — one founder everywhere', async function () {
    this.timeout(600000);
    for (const i of delisted) {
      // eslint-disable-next-line no-await-in-loop
      await restoreToNodeList(getSubnetConfig().nodeIp(i + 1));
    }
    delisted = [];
    await healPartition(env, pocket);
    await advanceBlocks(2);

    // The pocket syncs; the HIGHER rung's record retires its founding via
    // the world scan — its own ladder never grows (its old committee stands
    // again post-heal, so its evaluator rightly never mints the rung), and
    // that is exactly why the scan is knowledge-driven.
    let pocketAnswer = null;
    await waitFor(async () => {
      await advanceBlocks(1);
      pocketAnswer = await askFounder(hostIn);
      return pocketAnswer === 'no';
    }, { timeout: 300000, interval: 10000, label: 'the pocket founder stands down to the rung record' });
    expect(pocketAnswer).to.equal('no');

    // Exactly one yes fleet-wide, and it is on the majority side.
    const finals = await Promise.all([hostIn, ...hostsOut].map((i) => askFounder(i)));
    expect(finals.filter((a) => a === 'yes'), `final answers: ${finals}`).to.have.length(1);
    expect(finals[0], 'the pocket founder stays down').to.equal('no');
  });
});
