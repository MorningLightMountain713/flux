// weight: medium
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
import {
  removeFromNodeList, resetNodeList, setNodeStatus, clearAllNodeStatus,
} from '../framework/daemon-control.js';
import { getSubnetConfig, REGISTRY_REPO_HOST } from '../framework/subnet-config.js';

// A node that leaves the deterministic node list, on a real fleet (R10 of
// NODE_DOWN_SCENARIOS.md; NODESTATUSMONITOR_DECOMPOSITION.md §3). The old
// answer was nodeStatusMonitor's eviction loop — a twenty-minute tick, an
// HTTP probe of every off-list address, an unsigned `evicted` event relayed
// by sync — and it is deleted. What replaces it, and what this suite pins:
//   1. THE GRACE HOLDS — inside OFF_LIST_GRACE_MS of the list change the
//      delisted node still stands in every other node's location view. A
//      list change alone negates nothing; a two-block glitch in one node's
//      own daemon cannot hand its spawner a wrong count.
//   2. THE NEGATION IS LOCAL — past the grace every other node's view drops
//      the node, and NO certificate about it exists anywhere: it was
//      reachable throughout, its drops carried a policy code, no juror
//      looked. Nothing but each node's own derivation from its own copy of
//      the list did this, and nothing was sent.
//   3. THE NODE REMOVES ITS OWN APPS — its daemon says it is not confirmed,
//      and a non-member runs no apps (davew 2026-09-05; the self-defence
//      half of nodeStatusMonitor, unchanged).
//   4. THE FLEET PLACES A REPLACEMENT — the app is back at its instance
//      count, on nodes that are members.
// Delisting needs no jury, so the fleet is small.

const subnet = getSubnetConfig();
const NODES = 8;
const SUBJECT = 3;
const CO_HOLDER = 5;
const WITNESS = 0;
// ZelBack/src/services/appDatabase/offListDepartures.js OFF_LIST_GRACE_MS —
// a code constant, the same on every node.
const OFF_LIST_GRACE_MS = 2 * 60 * 1000;
// A reading well inside the grace: the list change is observed within a
// block, and this leaves a block and a half before the grace can end.
const INSIDE_GRACE_MS = 45 * 1000;
// The grace, one block for the list change to be observed, one for the
// capped fetch, and the reader's own interval.
const PAST_GRACE_TIMEOUT_MS = OFF_LIST_GRACE_MS + 120 * 1000;

const list = JSON.parse(
  readFileSync(new URL('../../fixtures/deterministic-list.json', import.meta.url), 'utf-8'),
);
const subjectOutpoint = `${list[SUBJECT].txhash}:${list[SUBJECT].outidx}`;

function ipMatches(rowIp, nodeIp) {
  return rowIp === nodeIp || String(rowIp).startsWith(`${nodeIp}:`);
}

describe('a delisted node is negated by every other node\'s own derivation, with no certificate and no message', function () {
  let env;
  let others;
  const appName = `e2edelist${Date.now()}`;

  const subjectIp = () => subnet.nodeIp(SUBJECT + 1);
  const coHolderIp = () => subnet.nodeIp(CO_HOLDER + 1);

  async function locationsSeenBy(index) {
    const res = await env.clients[index].getAppLocations(appName);
    return (res?.data ?? []).map((row) => row.ip);
  }

  async function subjectStandsAt(index) {
    const ips = await locationsSeenBy(index);
    return ips.some((ip) => ipMatches(ip, subjectIp()));
  }

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      tickerAutostart: false,
      zmqTopics: ALL_ZMQ_TOPICS,
    });
    others = env.clients.map((_, i) => i).filter((i) => i !== SUBJECT);
    await bootAndPeer(env);
  });

  after(async function () {
    this.timeout(60000);
    await clearAllNodeStatus().catch(() => {});
    await resetNodeList().catch(() => {});
    await env?.teardown();
  });

  it('installs the app on the subject and a co-holder, visible fleet-wide', async function () {
    this.timeout(300000);
    await pushImage(appName, 'v1');
    const app = await buildSeedableApp({
      name: appName,
      compose: [{
        name: appName,
        description: 'node-down delisting e2e component',
        repotag: `${REGISTRY_REPO_HOST}/${appName}:v1`,
        ports: [31314],
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

  it('inside the grace the delisted subject still stands everywhere; past it every other node drops it, and no certificate about it exists', async function () {
    this.timeout(PAST_GRACE_TIMEOUT_MS + 300000);
    // The chain drops the node: it leaves the deterministic list (the stub
    // advances a block, so every node's list refresh is triggered), and its
    // own daemon reads the same chain — its status is no longer CONFIRMED.
    await setNodeStatus(subjectIp(), 'EXPIRED');
    const delistedAt = Date.now();
    await removeFromNodeList(subjectIp());

    await new Promise((resolve) => { setTimeout(resolve, INSIDE_GRACE_MS - (Date.now() - delistedAt)); });
    const insideGrace = await Promise.all(others.map((i) => subjectStandsAt(i)));
    expect(insideGrace, 'inside the grace the subject stands in every other view').to.deep.equal(others.map(() => true));

    let views = [];
    await waitFor(async () => {
      views = await Promise.all(others.map((i) => locationsSeenBy(i)));
      return views.every((ips) => !ips.some((ip) => ipMatches(ip, subjectIp())));
    }, { timeout: PAST_GRACE_TIMEOUT_MS, interval: 5000, label: 'the subject gone from every other location view' })
      .catch((error) => {
        throw new Error(`${error.message}\n    views: ${JSON.stringify(views)}`);
      });
    const elapsedMs = Date.now() - delistedAt;
    expect(elapsedMs, 'the rows fell no sooner than the grace').to.be.at.least(OFF_LIST_GRACE_MS);
    views.forEach((ips) => {
      expect(ips.some((ip) => ipMatches(ip, coHolderIp())), 'the co-holder stands').to.equal(true);
    });

    // Reachable throughout, so no juror ever looked: the negation is each
    // node's own derivation, not a certificate and not an event.
    const rows = await Promise.all(others.map((i) => dbClient(i + 1).getNodeDownRecords(subjectOutpoint)));
    expect(rows.map((r) => r.length), 'no nodedown row about the subject on any node').to.deep.equal(others.map(() => 0));
  });

  it('the subject removes its own app on its daemon\'s "not confirmed"', async function () {
    this.timeout(300000);
    await waitFor(async () => {
      const res = await env.clients[SUBJECT].getInstalledApps();
      return !(res?.data ?? []).some((app) => app.name === appName);
    }, { timeout: 240000, interval: 10000, label: 'the subject removed its app' });
  });

  it('the fleet places a replacement on a member', async function () {
    this.timeout(900000);
    let ips = [];
    await waitFor(async () => {
      ips = await locationsSeenBy(WITNESS);
      const holders = ips.filter((ip) => !ipMatches(ip, subjectIp()));
      return holders.length >= 2 && holders.some((ip) => ipMatches(ip, coHolderIp()));
    }, { timeout: 720000, interval: 10000, label: 'two member holders in the witness view' })
      .catch((error) => {
        throw new Error(`${error.message}\n    last location view: ${JSON.stringify(ips)}`);
      });
    expect(ips.some((ip) => ipMatches(ip, subjectIp())), 'the subject is not among them').to.equal(false);
  });
});
