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

// The two rungs on a real fleet (NODE_DOWN_SCENARIOS.md R6, stamped
// 2026-09-02): PLACEMENT FREEZE at two standing certification rows, LOCKOUT
// at four, one six-hour window, every certificate counting. What must hold,
// each anchored on something the mechanism itself produces:
//   1. EACH DEATH IS ITS OWN ROW — every partition-and-return lands its own
//      certification row on every survivor; the count is over rows, refuted
//      ones included; and each death inside the last one's verdict lifetime
//      is certified all the same (the re-held duty retires the stale answer).
//   2. TWO ROWS FREEZE PLACEMENT — the subject's own spawner reads the same
//      rows and declines; nothing else changes: its inbound is admitted, and
//      its return announce brings its row back.
//   3. FOUR ROWS LOCK IT OUT — every survivor says so on its bus, refuses the
//      subject's dials with the lockout close and says that too; and the
//      subject, hearing the fourth certificate about itself, removes its app
//      without a word.
// The record-lapse probe (six hours) is pinned in unit tests; no suite waits
// for it. The fleet is 16 nodes, as in 1301, so the quorum has no margin.

const subnet = getSubnetConfig();
const NODES = 16;
const SUBJECT = 5;
const CO_HOLDER = 8;
const WITNESS = 0;
const FREEZE_ROWS = 2;
const LOCKOUT_ROWS = 4;

const list = JSON.parse(
  readFileSync(new URL('../../fixtures/deterministic-list.json', import.meta.url), 'utf-8'),
);
const subjectOutpoint = `${list[SUBJECT].txhash}:${list[SUBJECT].outidx}`;

function ipMatches(rowIp, nodeIp) {
  return rowIp === nodeIp || String(rowIp).startsWith(`${nodeIp}:`);
}

describe('node-down placement freeze and lockout end to end', function () {
  let env;
  let survivors;
  const appName = `e2elockout${Date.now()}`;

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

  // One death: cut the subject from every survivor, wait for its row, heal,
  // and wait for its return announce to restore its row on the witness.
  async function dieAndReturn(death) {
    await env.partitionGroups([SUBJECT], survivors);
    await rowsOnEverySurvivor(death);
    await env.healPartition([SUBJECT], survivors);
    await subjectLocationRestoredAt(WITNESS);
    await waitFor(async () => {
      const rows = await dbClient(WITNESS + 1).getNodeDownRecords(subjectOutpoint);
      return rows.length === death;
    }, { timeout: 30000, interval: 5000, label: 'row count settled' });
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
        description: 'node-down lockout e2e component',
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

  it('one death, one row, refuted by the return: nothing holds', async function () {
    this.timeout(600000);
    await dieAndReturn(1);
    const rows = await dbClient(WITNESS + 1).getNodeDownRecords(subjectOutpoint);
    expect(rows.length).to.equal(1);
  });

  it('the second death, inside the first verdicts\' lifetime, is certified all the same and freezes placement: the subject declines new apps, its inbound is admitted, its row is back', async function () {
    this.timeout(900000);
    const anchor = env.clients[SUBJECT].getLastEventId();
    await dieAndReturn(FREEZE_ROWS);
    const rows = await dbClient(WITNESS + 1).getNodeDownRecords(subjectOutpoint);
    const heights = new Set(rows.map((row) => row.data?.certificate?.height));
    expect(heights.size, 'each death certified at its own height').to.equal(FREEZE_ROWS);

    const frozen = await env.clients[SUBJECT].waitForEvent(
      'spawner:blocked',
      (data) => data.reason === 'placementFrozen',
      300000,
      { afterId: anchor },
    );
    expect(frozen.data.count).to.be.at.least(FREEZE_ROWS);
    // the freeze is the whole consequence: the subject is placed, heard, and admitted
    const ips = await locationsSeenBy(WITNESS);
    expect(ips.some((ip) => ipMatches(ip, subjectIp())), 'the subject stands in the location view').to.equal(true);
    expect(ips.some((ip) => ipMatches(ip, coHolderIp())), 'the co-holder stands').to.equal(true);
  });

  it('a third death holds nothing more', async function () {
    this.timeout(600000);
    await dieAndReturn(LOCKOUT_ROWS - 1);
    const ips = await locationsSeenBy(WITNESS);
    expect(ips.some((ip) => ipMatches(ip, subjectIp())), 'the subject still stands').to.equal(true);
  });

  it('the fourth death locks the subject out on every survivor, they refuse its inbound and say so, and the subject removes its app on hearing the certificate', async function () {
    this.timeout(900000);
    const anchors = survivors.map((i) => env.clients[i].getLastEventId());
    await env.partitionGroups([SUBJECT], survivors);
    await rowsOnEverySurvivor(LOCKOUT_ROWS);

    const locked = await Promise.all(survivors.map((i, k) => env.clients[i].waitForEvent(
      'nodedown:lockedOut',
      (data) => data.subject === subjectOutpoint,
      180000,
      { afterId: anchors[k] },
    )));
    locked.forEach((event) => expect(event.data.count).to.be.at.least(LOCKOUT_ROWS));

    await env.healPartition([SUBJECT], survivors);
    // The subject re-dials its duties on return; every watcher answers with
    // the lockout close. One refusal on one watcher is the mechanism firing.
    const refused = await Promise.any(survivors.map((i) => env.clients[i].waitForEvent(
      'nodedown:inboundRefused',
      (data) => data.subject === subjectOutpoint,
      240000,
    )));
    expect(refused.data.count).to.be.at.least(LOCKOUT_ROWS);

    // The lockout's self-uninstall: the fourth certificate about itself reaches
    // the subject, the node-level check finds it locked out, and every app goes
    // — no broadcast, and the fleet's rows were negated at since + the grace.
    await waitFor(async () => {
      const res = await env.clients[SUBJECT].getInstalledApps();
      return !(res?.data ?? []).some((app) => app.name === appName);
    }, { timeout: 600000, interval: 10000, label: 'the subject removed its app' });
    const ips = await locationsSeenBy(WITNESS);
    expect(ips.some((ip) => ipMatches(ip, coHolderIp())), 'the co-holder stands').to.equal(true);
    expect(ips.some((ip) => ipMatches(ip, subjectIp())), 'the subject is gone from the location view').to.equal(false);
  });
});
