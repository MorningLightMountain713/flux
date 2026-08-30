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
  let pocketFounded = null; // the pocket's founded event payload (key, founder)
  let rungFounded = null; // the majority's founded event payload at the rung

  async function askFounder(clientIndex) {
    let containerName;
    try {
      containerName = await requireAppContainerName(
        env.clients[clientIndex].container, name, COMPONENT,
      );
    } catch {
      // The location view lags removals by the row's remaining life, so a
      // listed host whose container is gone is ABSENT from the founder
      // question — never an unsettled answer a poll can wait out.
      return 'absent';
    }
    try {
      const { stdout } = await execInContainer(
        env.clients[clientIndex].container,
        `docker exec ${containerName} /bin/busybox wget -qO- --post-data='' http://fluxnode.service:16101/mesh/founder`,
      );
      return JSON.parse(stdout)?.data?.answer ?? null;
    } catch {
      return null;
    }
  }

  // Instance placement CHURNS under a mass delist: coverage reads swing while
  // the list shrinks, survivors' spawners top up, and the excess trim removes
  // by rank — an original host can lose its instance mid-test. The founder
  // question therefore goes to the CURRENT hosts, read from the location view
  // of the given node, never to the seating test 1 arranged.
  async function currentHosts(viewIndex, side = null) {
    const cfg = getSubnetConfig();
    const res = await env.clients[viewIndex].getAppLocations(name).catch(() => null);
    const rows = res?.data ?? [];
    const idx = rows
      .map((r) => env.clients.findIndex((c, i) => r.ip && r.ip.startsWith(cfg.nodeIp(i + 1))))
      .filter((i) => i !== -1);
    const uniq = [...new Set(idx)];
    return side ? uniq.filter((i) => side.has(i)) : uniq;
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
          // renewInterval must sit strictly under lockDelayMs or
          // timingIsSafe refuses and the plane stays inert
          quorumGrantRenewIntervalMs: 5000,
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
    // A newborn tip at the cut: the freshness window the test name promises
    // starts full, not half-spent by test 1's install waits.
    await advanceBlocks(1);
    const cutMarkers = env.clients.map((c) => c.getLastEventId());
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

    const founded = await env.clients[hostIn].waitForEvent(
      'quorumGrant:founded',
      (d) => typeof d.key === 'string' && d.key.startsWith(`${name}/founder-`),
      30000,
      { afterId: cutMarkers[hostIn] },
    );
    pocketFounded = founded.data;
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

    const majoritySet = new Set(majority);
    let hosts = [];
    let answers = [];
    await waitFor(async () => {
      await advanceBlocks(1);
      hosts = await currentHosts(majority[0], majoritySet);
      if (hosts.length < 2) return false;
      answers = await Promise.all(hosts.map((i) => askFounder(i)));
      // Two majority-side yeses is a safety violation in ANY pass, settled
      // or not — fail loud, never retry past it.
      expect(answers.filter((a) => a === 'yes').length, `two founders on the majority side: ${answers} on hosts ${hosts}`).to.be.at.most(1);
      return answers.every((a) => a === 'yes' || a === 'no')
        && answers.filter((a) => a === 'yes').length === 1;
    }, { timeout: 300000, interval: 10000, label: 'the majority founds at the rung' });
    expect(answers.filter((a) => a === 'yes'), `majority answers: ${answers} on hosts ${hosts}`).to.have.length(1);

    // The rung founding is a SECOND world: its founded event names a key on
    // a different basis than the pocket's.
    const yesHost = hosts[answers.indexOf('yes')];
    const founded = await env.clients[yesHost].waitForEvent(
      'quorumGrant:founded',
      (d) => typeof d.key === 'string' && d.key.startsWith(`${name}/founder-`) && d.key !== pocketFounded.key,
      30000,
      { afterId: markers[majority.indexOf(yesHost)] },
    );
    rungFounded = founded.data;
    expect(rungFounded.key, 'the rung key is a new basis').to.not.equal(pocketFounded.key);
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

    // Record-plane convergence is the theorem (newest-decided-basis-wins):
    // the HIGHER rung's record reaches EVERY node — the pocket adopts it via
    // the world scan and its rung-0 founder stands down. The pocket's own
    // ladder never grows (its old committee stands again post-heal, so its
    // evaluator rightly never mints the rung), which is exactly why the scan
    // is knowledge-driven.
    const role = rungFounded.key.slice(name.length + 1);
    await waitFor(async () => {
      await advanceBlocks(1);
      const rows = await Promise.all(env.clients.map(
        (unused, i) => dbClient(i + 1).getMasterleaseRecord(name, role).catch(() => null),
      ));
      return rows.every((r) => r && r.grantee === rungFounded.founder);
    }, { timeout: 300000, interval: 10000, label: 'the rung record reaches every node' });

    // Live yes is BOUNDED, not guaranteed: instance churn may have removed
    // the rung founder's own host, and nobody else may ever say yes. At most
    // one yes among the current hosts, and any yes is the recorded founder's
    // own node. A lingering pocket yes here is the safety violation.
    let hosts = [];
    let finals = [];
    await waitFor(async () => {
      await advanceBlocks(1);
      hosts = await currentHosts(0);
      if (!hosts.length) return false;
      finals = await Promise.all(hosts.map((i) => askFounder(i)));
      const present = finals.filter((a) => a !== 'absent');
      return present.length > 0 && present.every((a) => a === 'yes' || a === 'no');
    }, { timeout: 180000, interval: 10000, label: 'founder answers settle post-heal' });
    const yeses = finals.filter((a) => a === 'yes');
    expect(yeses.length, `final answers: ${finals} on hosts ${hosts}`).to.be.at.most(1);
    if (yeses.length === 1) {
      const yesHost = hosts[finals.indexOf('yes')];
      const status = await env.clients[yesHost].getNodeStatus();
      expect(`${status.data.txhash}:${status.data.outidx}`, 'the one yes is the recorded rung founder')
        .to.equal(rungFounded.founder);
    }
  });
});
