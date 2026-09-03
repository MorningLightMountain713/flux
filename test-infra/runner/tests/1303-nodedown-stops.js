// weight: heavy
import { readFileSync } from 'node:fs';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { bootAndPeer, installOnNodes, seedGlobalSpec } from '../framework/reconciler-suite.js';
import { pushImage } from '../framework/registry-helper.js';
import { buildSeedableApp } from '../framework/seed-helper.js';
import { waitFor } from '../framework/wait.js';
import { dbClient } from '../framework/db-client.js';
import { execInContainer, restartFluxos } from '../framework/container.js';
import { setNodeStatus, clearNodeStatus } from '../framework/daemon-control.js';
import { getSubnetConfig, REGISTRY_REPO_HOST } from '../framework/subnet-config.js';

// The map of stops on a real fleet (NODE_DOWN_SCENARIOS.md §6, stamped
// 2026-09-02): what the jurors do with each kind of stop, and what the
// fleet and the node do with the certificate. Each scenario is anchored on
// something the mechanism itself produces — a certification row and its
// reason and since, the location view, the subject's own installed apps.
//   A. A FluxOS restart under apps closes with RESTARTING: no certificate,
//      no replacement, the app never moves.
//   B. A clean reboot inside the grace closes with SHUTTING_DOWN: the same.
//   C. A crash back inside the grace is certified at the drop (reason
//      unannounced) and nothing else happens: the row stands, nothing is
//      placed, the return announce refutes.
//   D. A crash past the grace: the row falls at since + 420 s, the spawner
//      places a replacement, and the returning node removes its app and
//      never refutes.
//   E. The overrunning reboot the ping probe exists for: a SHUTTING_DOWN
//      close, then a node that is back and listening but never confirms.
//      The jurors' grace-end look connects, is hung up on before a pong,
//      and certifies with reason shutdown and since = the drop; the rows go
//      on arrival.
//   F. The courtesy edge: twelve FluxOS restarts are honoured, the
//      thirteenth is certified at the drop with reason restart.
// The fleet is 16 nodes, as in 1301, so the quorum has no margin. The app
// asks for two instances, so a replacement is one more holder.

const subnet = getSubnetConfig();
const NODES = 16;
const SUBJECT = 5;
const CO_HOLDER = 8;
const WITNESS = 0;
const INSTANCES = 2;
const NODE_DOWN_GRACE_MS = 420_000;
const RESTART_GRACE_MS = 120_000;
const RESTART_COURTESY = 12;

const list = JSON.parse(
  readFileSync(new URL('../../fixtures/deterministic-list.json', import.meta.url), 'utf-8'),
);
const subjectOutpoint = `${list[SUBJECT].txhash}:${list[SUBJECT].outidx}`;

function ipMatches(rowIp, nodeIp) {
  return rowIp === nodeIp || String(rowIp).startsWith(`${nodeIp}:`);
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

describe('node-down: the map of stops end to end', function () {
  let env;
  let survivors;
  const appName = `e2estops${Date.now()}`;

  const subjectIp = () => subnet.nodeIp(SUBJECT + 1);
  const coHolderIp = () => subnet.nodeIp(CO_HOLDER + 1);
  const subjectContainer = () => env.clients[SUBJECT].container;

  async function locationsSeenBy(index) {
    const res = await env.clients[index].getAppLocations(appName);
    return (res?.data ?? []).map((row) => row.ip);
  }

  async function subjectHoldsApp() {
    const res = await env.clients[SUBJECT].getInstalledApps();
    return (res?.data ?? []).some((app) => app.name === appName);
  }

  async function rowsOnWitness() {
    return dbClient(WITNESS + 1).getNodeDownRecords(subjectOutpoint);
  }

  async function rowsOnEverySurvivor(atLeast, { timeout = 240000 } = {}) {
    let counts = [];
    await waitFor(async () => {
      counts = await Promise.all(survivors.map(
        async (i) => (await dbClient(i + 1).getNodeDownRecords(subjectOutpoint)).length,
      ));
      return counts.every((count) => count >= atLeast);
    }, { timeout, interval: 5000, label: `${atLeast} nodedown row(s) on every survivor` })
      .catch((error) => {
        throw new Error(`${error.message}\n    rows per survivor: ${JSON.stringify(counts)}`);
      });
  }

  async function subjectListedAt(index, listed, label) {
    let ips = [];
    await waitFor(async () => {
      ips = await locationsSeenBy(index);
      return ips.some((ip) => ipMatches(ip, subjectIp())) === listed;
    }, { timeout: 240000, interval: 5000, label })
      .catch((error) => {
        throw new Error(`${error.message}\n    last location view: ${JSON.stringify(ips)}`);
      });
  }

  // A machine shutdown as FluxOS detects it: the systemd scheduled-shutdown
  // marker, read by isSystemShuttingDown before the SHUTTING_DOWN close.
  async function markMachineShutdown(container) {
    await execInContainer(container, 'mkdir -p /run/systemd/shutdown && touch /run/systemd/shutdown/scheduled');
  }
  async function unmarkMachineShutdown(container) {
    await execInContainer(container, 'rm -f /run/systemd/shutdown/scheduled');
  }

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      tickerAutostart: false,
      zmqTopics: ALL_ZMQ_TOPICS,
    });
    survivors = env.clients.map((_, i) => i).filter((i) => i !== SUBJECT);
    await bootAndPeer(env);
  });

  after(async function () {
    this.timeout(60000);
    await clearNodeStatus(subjectIp()).catch(() => {});
    await env?.healPartition([SUBJECT], survivors).catch(() => {});
    await env?.teardown();
  });

  it('installs the app on the subject and a co-holder, visible fleet-wide', async function () {
    this.timeout(300000);
    await pushImage(appName, 'v1');
    const app = await buildSeedableApp({
      name: appName,
      instances: INSTANCES,
      compose: [{
        name: appName,
        description: 'node-down stops e2e component',
        repotag: `${REGISTRY_REPO_HOST}/${appName}:v1`,
        ports: [31313],
        domains: [''],
        environmentParameters: [],
        commands: [],
        containerPorts: [80],
        containerData: '/tmp',
        cpu: 0.1,
        ram: 100,
        hdd: 1,
        repoauth: '',
      }],
    });
    await seedGlobalSpec(env, app, env.clients.map((_, i) => i)
      .filter((i) => i !== SUBJECT && i !== CO_HOLDER));
    await installOnNodes(env, app, [SUBJECT, CO_HOLDER], { timeout: 180000 });
    await waitFor(async () => {
      const ips = await locationsSeenBy(WITNESS);
      return ips.some((ip) => ipMatches(ip, subjectIp()))
        && ips.some((ip) => ipMatches(ip, coHolderIp()));
    }, { timeout: 120000, interval: 5000, label: 'both holders in the witness location view' });
  });

  it('A. a FluxOS restart under apps is announced on the socket: no certificate, no replacement, the app never moves', async function () {
    this.timeout(400000);
    const before = (await rowsOnWitness()).length;
    await restartFluxos(subjectContainer());
    // past the RESTARTING grace and the next sweep: had a juror looked and
    // certified, the row would be here by now
    await sleep(RESTART_GRACE_MS + 90_000);
    expect((await rowsOnWitness()).length, 'no certification row for a restart').to.equal(before);
    const ips = await locationsSeenBy(WITNESS);
    expect(ips.filter((ip) => ipMatches(ip, subjectIp()) || ipMatches(ip, coHolderIp())).length, 'both holders stand').to.equal(2);
    expect(ips.length, 'nothing was placed elsewhere').to.equal(INSTANCES);
    expect(await subjectHoldsApp(), 'the subject kept its app').to.equal(true);
  });

  it('B. a clean reboot inside the grace is announced on the socket: no certificate, the app comes back where it was', async function () {
    this.timeout(400000);
    const before = (await rowsOnWitness()).length;
    await markMachineShutdown(subjectContainer());
    await env.restartNode(SUBJECT, { timeout: 30000 });
    await unmarkMachineShutdown(subjectContainer());
    await sleep(120_000);
    expect((await rowsOnWitness()).length, 'no certification row for a clean reboot inside the grace').to.equal(before);
    await subjectListedAt(WITNESS, true, 'the subject stands in the location view after its reboot');
    expect(await subjectHoldsApp(), 'the subject kept its app').to.equal(true);
  });

  it('C. a crash back inside the grace is certified at the drop and moves nothing: the row stands, the return refutes', async function () {
    this.timeout(600000);
    const before = (await rowsOnWitness()).length;
    await env.partitionGroups([SUBJECT], survivors);
    await rowsOnEverySurvivor(before + 1);
    const rows = await rowsOnWitness();
    const newest = rows.reduce((a, b) => (new Date(a.broadcastedAt) > new Date(b.broadcastedAt) ? a : b));
    expect(newest.reason, 'an unannounced death').to.equal('unannounced');
    expect(new Date(newest.since).getTime(), 'since is the drop, near the broadcast').to.be.closeTo(new Date(newest.broadcastedAt).getTime(), 90_000);

    // inside the grace the row stands and nothing is placed
    await sleep(60_000);
    let ips = await locationsSeenBy(WITNESS);
    expect(ips.some((ip) => ipMatches(ip, subjectIp())), 'the subject stands inside the grace').to.equal(true);
    expect(ips.length, 'nothing placed inside the grace').to.equal(INSTANCES);

    await env.healPartition([SUBJECT], survivors);
    await subjectListedAt(WITNESS, true, 'the subject stands after its return');
    ips = await locationsSeenBy(WITNESS);
    expect(ips.length, 'still two holders').to.equal(INSTANCES);
    expect(await subjectHoldsApp(), 'the subject kept its app').to.equal(true);
  });

  it('D. a crash past the grace: the row falls at since + 420 s, a replacement is placed, and the returning node removes its app and never refutes', async function () {
    this.timeout(1500000);
    const before = (await rowsOnWitness()).length;
    await env.partitionGroups([SUBJECT], survivors);
    await rowsOnEverySurvivor(before + 1);
    const droppedAt = Date.now();

    await subjectListedAt(WITNESS, false, 'the subject row falls once the grace has run');
    expect(Date.now() - droppedAt, 'not before the grace').to.be.at.least(NODE_DOWN_GRACE_MS - 90_000);

    // the spawner on the survivors places one more holder
    let ips = [];
    await waitFor(async () => {
      ips = await locationsSeenBy(WITNESS);
      return ips.length >= INSTANCES && !ips.some((ip) => ipMatches(ip, subjectIp()));
    }, { timeout: 600000, interval: 10000, label: 'a replacement placed elsewhere' })
      .catch((error) => {
        throw new Error(`${error.message}\n    last location view: ${JSON.stringify(ips)}`);
      });

    await env.healPartition([SUBJECT], survivors);
    // the return rule: the rows no longer place the subject, so it removes,
    // and it never announces the app again
    await waitFor(async () => !(await subjectHoldsApp()), { timeout: 600000, interval: 10000, label: 'the subject removed its app on return' });
    await sleep(120_000);
    ips = await locationsSeenBy(WITNESS);
    expect(ips.some((ip) => ipMatches(ip, subjectIp())), 'the subject never refutes').to.equal(false);
    expect(ips.length, 'the co-holder and the replacement').to.equal(INSTANCES);
  });

  it('E. the overrunning reboot: a SHUTTING_DOWN close, then a node back but never confirmed, is certified at the grace end by the ping exchange with since = the drop, and its rows go on arrival', async function () {
    this.timeout(1200000);
    // the subject holds an app again for this one: seat it back
    const app = await buildSeedableApp({
      name: appName,
      instances: INSTANCES,
      compose: [{
        name: appName,
        description: 'node-down stops e2e component',
        repotag: `${REGISTRY_REPO_HOST}/${appName}:v1`,
        ports: [31313],
        domains: [''],
        environmentParameters: [],
        commands: [],
        containerPorts: [80],
        containerData: '/tmp',
        cpu: 0.1,
        ram: 100,
        hdd: 1,
        repoauth: '',
      }],
    });
    await installOnNodes(env, app, [SUBJECT], { timeout: 180000 }).catch(() => {});
    await subjectListedAt(WITNESS, true, 'the subject seated again');
    const before = (await rowsOnWitness()).length;

    // the machine "reboots": SHUTTING_DOWN on every held connection, then the
    // watchdog respawns FluxOS into a daemon that never confirms it
    await setNodeStatus(subjectIp(), 'STARTED');
    await markMachineShutdown(subjectContainer());
    await execInContainer(subjectContainer(), 'kill -TERM "$(cat /tmp/fluxos.pid 2>/dev/null)" 2>/dev/null || true');
    const droppedAt = Date.now();
    await unmarkMachineShutdown(subjectContainer());

    // inside the grace: no certificate, the row stands
    await sleep(RESTART_GRACE_MS + 60_000);
    expect((await rowsOnWitness()).length, 'no certificate inside the shutdown grace').to.equal(before);
    expect((await locationsSeenBy(WITNESS)).some((ip) => ipMatches(ip, subjectIp())), 'the row stands inside the grace').to.equal(true);

    // the grace end: the jurors look, the node hangs up before the pong
    await rowsOnEverySurvivor(before + 1, { timeout: NODE_DOWN_GRACE_MS + 180_000 });
    const rows = await rowsOnWitness();
    const newest = rows.reduce((a, b) => (new Date(a.broadcastedAt) > new Date(b.broadcastedAt) ? a : b));
    expect(newest.reason, 'the reason the socket carried').to.equal('shutdown');
    expect(new Date(newest.since).getTime(), 'since is the drop, not the look').to.be.closeTo(droppedAt, 90_000);
    expect(new Date(newest.broadcastedAt).getTime() - new Date(newest.since).getTime(), 'certified at the grace end').to.be.at.least(NODE_DOWN_GRACE_MS - 30_000);
    // since + the grace had passed when it arrived: the rows go at once
    await subjectListedAt(WITNESS, false, 'the subject row falls on the certificate\'s arrival');

    await clearNodeStatus(subjectIp());
  });

  it('F. the courtesy edge: twelve FluxOS restarts are honoured, the thirteenth is certified at the drop with the real reason', async function () {
    this.timeout(1500000);
    await clearNodeStatus(subjectIp()).catch(() => {});
    await env.healPartition([SUBJECT], survivors).catch(() => {});
    await sleep(60_000);
    const before = (await rowsOnWitness()).length;
    for (let i = 0; i < RESTART_COURTESY; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await restartFluxos(subjectContainer());
      // the jurors re-hold the duty before the next close
      // eslint-disable-next-line no-await-in-loop
      await sleep(30_000);
    }
    expect((await rowsOnWitness()).length, 'twelve honoured restarts leave no row').to.equal(before);

    await restartFluxos(subjectContainer());
    await rowsOnEverySurvivor(before + 1, { timeout: 300000 });
    const rows = await rowsOnWitness();
    const newest = rows.reduce((a, b) => (new Date(a.broadcastedAt) > new Date(b.broadcastedAt) ? a : b));
    expect(newest.reason, 'the reason the socket carried').to.equal('restart');
    expect(new Date(newest.broadcastedAt).getTime() - new Date(newest.since).getTime(), 'certified at the drop, not the grace end').to.be.below(RESTART_GRACE_MS);
  });
});
