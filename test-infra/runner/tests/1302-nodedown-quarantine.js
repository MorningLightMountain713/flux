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
import { getSubnetConfig, REGISTRY_REPO_HOST } from '../framework/subnet-config.js';

// The severe flap-quarantine tier on a real fleet. A node certified down three
// times while those records still stand is held out of the network. What must
// hold, each anchored on something the mechanism itself produces:
//   1. THREE DEATHS, THREE ROWS — each partition-and-return lands its own
//      certification row on every survivor; the count is over rows, refuted
//      ones included.
//   2. THE THIRD ROW TRIPS THE HOLD — every survivor says so on its bus.
//   3. THE RETURN ANNOUNCE IS HEARD AND IGNORED — the witness receives the
//      subject's own apprunning broadcast and its location view still excludes
//      the subject while the co-holder stands. The certificate is refuted; the
//      derivation ignores the refutation.
//   4. THE SUBJECT'S INBOUND IS REFUSED — its watchers refuse its dials with the
//      quarantine close, and say so.
//   5. THE SUBJECT PLACES NOTHING — its own spawner reads the same rows and
//      blocks itself.
// The record-lapse probe (six hours) is pinned in unit tests; no suite waits
// for it. The fleet is 16 nodes, as in 1301, so the quorum has no margin.

const subnet = getSubnetConfig();
const NODES = 16;
const SUBJECT = 5;
const CO_HOLDER = 8;
const WITNESS = 0;
const DEATHS = 3;

const list = JSON.parse(
  readFileSync(new URL('../../fixtures/deterministic-list.json', import.meta.url), 'utf-8'),
);
const subjectOutpoint = `${list[SUBJECT].txhash}:${list[SUBJECT].outidx}`;

function ipMatches(rowIp, nodeIp) {
  return rowIp === nodeIp || String(rowIp).startsWith(`${nodeIp}:`);
}

describe('node-down severe quarantine end to end', function () {
  let env;
  let survivors;
  const appName = `e2equarantine${Date.now()}`;

  const subjectIp = () => subnet.nodeIp(SUBJECT + 1);
  const coHolderIp = () => subnet.nodeIp(CO_HOLDER + 1);

  async function locationsSeenBy(index) {
    const res = await env.clients[index].getAppLocations(appName);
    return (res?.data ?? []).map((row) => row.ip);
  }

  async function rowsOnEverySurvivor(atLeast) {
    let counts = [];
    await waitFor(async () => {
      counts = await Promise.all(survivors.map(
        async (i) => (await dbClient(i + 1).getNodeDownRecords(subjectOutpoint)).length,
      ));
      return counts.every((count) => count >= atLeast);
    }, { timeout: 240000, interval: 5000, label: `${atLeast} nodedown row(s) on every survivor` })
      .catch((error) => {
        throw new Error(`${error.message}\n    rows per survivor: ${JSON.stringify(counts)}`);
      });
  }

  async function subjectLocationRestoredAt(index) {
    let ips = [];
    await waitFor(async () => {
      ips = await locationsSeenBy(index);
      return ips.some((ip) => ipMatches(ip, subjectIp()));
    }, { timeout: 240000, interval: 5000, label: 'subject location restored after return' })
      .catch((error) => {
        throw new Error(`${error.message}\n    last location view: ${JSON.stringify(ips)}`);
      });
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
    await env?.healPartition([SUBJECT], survivors).catch(() => {});
    await env?.teardown();
  });

  it('installs the app on the subject and a co-holder, visible fleet-wide', async function () {
    this.timeout(300000);
    await pushImage(appName, 'v1');
    const app = await buildSeedableApp({
      name: appName,
      compose: [{
        name: appName,
        description: 'node-down quarantine e2e component',
        repotag: `${REGISTRY_REPO_HOST}/${appName}:v1`,
        ports: [31312],
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

  it('two deaths, each certified and each refuted by the return, hold nothing', async function () {
    this.timeout(1200000);
    for (let death = 1; death < DEATHS; death += 1) {
      /* eslint-disable no-await-in-loop */
      await env.partitionGroups([SUBJECT], survivors);
      await rowsOnEverySurvivor(death);
      await env.healPartition([SUBJECT], survivors);
      // The return announce refutes the standing certificate: the location
      // comes back, and the next death is a new incident with its own row.
      await subjectLocationRestoredAt(WITNESS);
      // The jury's verdict piles must age past the verdict lifetime before a
      // new pile can assemble; the ticker runs, so this is blocks, not hope.
      await waitFor(async () => {
        const rows = await dbClient(WITNESS + 1).getNodeDownRecords(subjectOutpoint);
        return rows.length === death;
      }, { timeout: 30000, interval: 5000, label: 'row count settled' });
      /* eslint-enable no-await-in-loop */
    }
    const rows = await dbClient(WITNESS + 1).getNodeDownRecords(subjectOutpoint);
    expect(rows.length).to.equal(DEATHS - 1);
    const heights = new Set(rows.map((row) => row.data?.certificate?.height));
    expect(heights.size, 'each death certified at its own height').to.equal(DEATHS - 1);
  });

  it('the third death trips the hold on every survivor', async function () {
    this.timeout(600000);
    const anchors = survivors.map((i) => env.clients[i].getLastEventId());
    await env.partitionGroups([SUBJECT], survivors);
    await rowsOnEverySurvivor(DEATHS);

    const tripped = await Promise.all(survivors.map((i, k) => env.clients[i].waitForEvent(
      'nodedown:quarantined',
      (data) => data.subject === subjectOutpoint,
      180000,
      { afterId: anchors[k] },
    )));
    tripped.forEach((event) => expect(event.data.count).to.be.at.least(DEATHS));
  });

  it('the return announce is heard and ignored: the subject stays out of the location view', async function () {
    this.timeout(600000);
    const afterId = env.clients[WITNESS].getLastEventId();
    await env.healPartition([SUBJECT], survivors);

    // The subject's own apprunning broadcast reaches the witness — the
    // refutation that would, without the hold, restore the row.
    await env.clients[WITNESS].waitForEvent(
      'network:apprunning',
      (data) => ipMatches(data?.ip ?? '', subjectIp()),
      240000,
      { afterId },
    );
    const ips = await locationsSeenBy(WITNESS);
    expect(ips.some((ip) => ipMatches(ip, coHolderIp())), 'the co-holder stands').to.equal(true);
    expect(ips.some((ip) => ipMatches(ip, subjectIp())), 'the subject is ignored').to.equal(false);
  });

  it('the subject\'s inbound is refused by its watchers, and they say so', async function () {
    this.timeout(600000);
    // The subject re-dials its duties on return; every watcher answers with
    // the quarantine close. One refusal on one watcher is the mechanism firing.
    const refused = await Promise.any(survivors.map((i) => env.clients[i].waitForEvent(
      'nodedown:inboundRefused',
      (data) => data.subject === subjectOutpoint,
      240000,
    )));
    expect(refused.data.count).to.be.at.least(DEATHS);
  });

  it('the subject places nothing while its own count holds it out', async function () {
    this.timeout(600000);
    const blocked = await env.clients[SUBJECT].waitForEvent(
      'spawner:blocked',
      (data) => data.reason === 'quarantined',
      300000,
    );
    expect(blocked.data.count).to.be.at.least(DEATHS);
  });
});
