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
import { loadSharedConfig } from '../framework/coupled-knobs.js';
import { getSubnetConfig, REGISTRY_REPO_HOST } from '../framework/subnet-config.js';

// The node-down certificate plane, end to end on a real fleet — the first
// execution of every wire path in it. What must hold:
//   1. THE RING RECONCILER PEERS THE FLEET — every node ends up above the
//      outbound and inbound floors with no legacy selection loop left to help.
//   2. A VANISHED NODE EARNS A CERTIFICATE — the subject's watchers notice the
//      drop, probe, sign verdicts, push them to collectors over ephemeral
//      connections, and the assembled certificate lands in every survivor's
//      event log: one row, quorum-signed, keyed to the incident.
//   3. THE CERTIFICATE NEGATES THE SUBJECT'S APP ROW — the location derivation
//      drops the subject once since + the grace has passed with the
//      certificate standing (R4); a co-holder's row is untouched.
//   4. A NODE THAT LOST THE RECORD RECOVERS IT OVER SYNC — gossip is one
//      flood, so a node that missed it is made whole by the app-state sync
//      (the boot round or a reconnect pull — the same serve, the same
//      verifier the gossip intake uses).
//   5. A RETURN PAST THE GRACE REMOVES — the network has moved on from the
//      subject's rows together, so the returning node removes its app and
//      announces nothing (R5): the record stands on every survivor, the
//      subject never comes back into the location view, and it re-holds the
//      fleet through its own dials, since its watchers hold a subject whose
//      record stands out of their dial plan.
// The fleet is 16 nodes — the manifest's maximum. The jury walk picks 14
// owners and the quorum is 10, so killing one node leaves every watcher alive
// and no margin: any silent watcher failure shows up here as a missing quorum.

const subnet = getSubnetConfig();
const NODES = 16;
const SUBJECT = 5; // the node this suite makes unreachable (holds one app instance)
const CO_HOLDER = 8; // keeps its instance through the incident
const REBOOTER = 12; // wiped and rebooted mid-incident to prove the sync path
const WITNESS = 0; // the survivor whose view the location assertions read
// The node-down grace every node of this fleet runs (test-infra/config/shared.js);
// the margin past it is absolute, as in 1303.
const shared = loadSharedConfig();
const NODE_DOWN_GRACE_MS = shared.fluxapps.nodeDownGraceS * 1000;
const PAST_GRACE_MARGIN_MS = 60_000;

const list = JSON.parse(
  readFileSync(new URL('../../fixtures/deterministic-list.json', import.meta.url), 'utf-8'),
);
const subjectOutpoint = `${list[SUBJECT].txhash}:${list[SUBJECT].outidx}`;

// A location row's ip may carry the api port; a bare prefix match would also
// swallow ip 10 when looking for ip 1.
function ipMatches(rowIp, nodeIp) {
  return rowIp === nodeIp || String(rowIp).startsWith(`${nodeIp}:`);
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

describe('node-down certificates end to end', function () {
  let env;
  let survivors; // indices still connected while the subject is dark
  const appName = `e2enodedown${Date.now()}`;

  const subjectIp = () => subnet.nodeIp(SUBJECT + 1);
  const coHolderIp = () => subnet.nodeIp(CO_HOLDER + 1);

  async function locationsSeenBy(index) {
    const res = await env.clients[index].getAppLocations(appName);
    return (res?.data ?? []).map((row) => row.ip);
  }

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      tickerAutostart: false,
      // Certificate verification recomputes the jury at the fingerprint the
      // verdicts name, which needs the ANCHORED membership history the ZMQ
      // delta path records; the polling default carries no anchors.
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

  it('the ring reconciler holds every node above the peer floor', async function () {
    this.timeout(120000);
    // Direction-agnostic on purpose: duty pairs are reciprocal, one
    // connection serves the pair, and which end wears the outbound label is
    // a dial-race outcome — a node can be perfectly held with every pair
    // labelled inbound. What the floor means is distinct peers HELD.
    let counts = [];
    await waitFor(async () => {
      counts = await Promise.all(env.clients.map(async (c) => {
        const [outbound, inbound] = await Promise.all([c.getPeers(), c.getIncomingPeers()]);
        return (outbound.data ?? []).length + (inbound.data ?? []).length;
      }));
      return counts.every((held) => held >= 4);
    }, { timeout: 90000, interval: 5000, label: 'every node holds >=4 peers' })
      .catch((error) => {
        throw new Error(`${error.message}\n    per-node held: ${JSON.stringify(counts)}`);
      });
  });

  it('installs the app on the subject and a co-holder, visible fleet-wide', async function () {
    this.timeout(300000);
    await pushImage(appName, 'v1');
    const app = await buildSeedableApp({
      name: appName,
      compose: [{
        name: appName,
        description: 'node-down e2e component',
        repotag: `${REGISTRY_REPO_HOST}/${appName}:v1`,
        ports: [31311],
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
    // Every node holds the global spec, as production nodes do via message
    // sync — the witnesses derive locations, not just the holders.
    await seedGlobalSpec(env, app, env.clients.map((_, i) => i)
      .filter((i) => i !== SUBJECT && i !== CO_HOLDER));
    await installOnNodes(env, app, [SUBJECT, CO_HOLDER], { timeout: 180000 });

    await waitFor(async () => {
      const ips = await locationsSeenBy(WITNESS);
      return ips.some((ip) => ipMatches(ip, subjectIp()))
        && ips.some((ip) => ipMatches(ip, coHolderIp()));
    }, { timeout: 120000, interval: 5000, label: 'both holders in the witness location view' });
  });

  it('a vanished node earns a quorum certificate in every survivor event log', async function () {
    this.timeout(360000);
    // The partition severs node-to-node traffic both ways and returns only
    // once the sockets are really gone; the subject keeps its daemon and db,
    // which is exactly the certificate's meaning — unreachable, not dead.
    await env.partitionGroups([SUBJECT], survivors);

    let holders = [];
    await waitFor(async () => {
      const rows = await Promise.all(survivors.map(
        (i) => dbClient(i + 1).getNodeDownRecords(subjectOutpoint),
      ));
      holders = survivors.filter((_, k) => rows[k].length >= 1);
      return holders.length === survivors.length;
    }, { timeout: 240000, interval: 5000, label: 'nodedown record on every survivor' })
      .catch((error) => {
        throw new Error(`${error.message}\n    holders so far: ${holders.length}/${survivors.length} (${holders.join(',')})`);
      });

    const [row] = await dbClient(WITNESS + 1).getNodeDownRecords(subjectOutpoint);
    expect(row.subject).to.equal(subjectOutpoint);
    // the row is keyed on the death's number as the jury counted it, and
    // this is the subject's first: every juror's verdict named 1, the
    // certificate carries the middle of its quorum, the store keyed on it
    expect(row.dedupKey, 'keyed on the death number').to.equal(`nodedown:${subjectOutpoint}:1`);
    expect(row.death).to.equal(1);
    const certificate = row.data?.certificate;
    expect(certificate, 'stored row carries the certificate').to.exist;
    expect(certificate.subject).to.equal(subjectOutpoint);
    expect(certificate.death, 'the certificate names the death').to.equal(1);
    expect(certificate.verdicts.every((verdict) => verdict.death === 1), 'every counted verdict named it').to.equal(true);
    // Quorum for a 14-owner jury is 10 — fewer signed verdicts must never
    // have been stored, whatever the transport delivered.
    expect(certificate.verdicts.length).to.be.at.least(10);
  });

  it('the standing certificate negates the subject app row and spares the co-holder', async function () {
    this.timeout(180000);
    let ips = [];
    await waitFor(async () => {
      ips = await locationsSeenBy(WITNESS);
      return !ips.some((ip) => ipMatches(ip, subjectIp()))
        && ips.some((ip) => ipMatches(ip, coHolderIp()));
    }, { timeout: 120000, interval: 5000, label: 'subject negated, co-holder standing' })
      .catch((error) => {
        throw new Error(`${error.message}\n    last location view: ${JSON.stringify(ips)}`);
      });
  });

  it('a node that lost the record recovers it over the sync stream, verified', async function () {
    this.timeout(360000);
    // Stage "missed the one-flood gossip": wipe the row, then reboot. The
    // restore must arrive through the sync intake, and the stored event's
    // source field proves the path. What the first fleet runs taught: a
    // standing certificate is never re-FLOODED — late gossip copies die as
    // duplicates — but every apprunning sync response re-serves durable
    // rows, reconnect pulls included, so even a running node that lost the
    // row is made whole within seconds. One-flood is a gossip property, not
    // a sync property, so no absence window exists to control on. The
    // anchor sits before the wipe to catch the event whichever sync flavor
    // delivers first; the reboot keeps the cold-boot verification leg
    // exercised — by now the certificate is well past the verdict lifetime,
    // exactly the late-reader shape.
    const afterId = env.clients[REBOOTER].getLastEventId();
    const wiped = await dbClient(REBOOTER + 1).wipeNodeDownRecords(subjectOutpoint);
    expect(wiped, 'the rebooter held the record before the wipe').to.be.at.least(1);

    await env.restartNode(REBOOTER, { timeout: 30000 });

    const stored = await env.clients[REBOOTER].waitForEvent(
      'nodedown:stored',
      (data) => data.subject === subjectOutpoint,
      180000,
      { afterId },
    );
    expect(stored.data.source, 'restored through sync, never a gossip re-flood').to.equal('sync');

    // Restored through the verifier, not copied blind: the row it stored
    // carries the same incident the fleet certified.
    const [row] = await dbClient(REBOOTER + 1).getNodeDownRecords(subjectOutpoint);
    expect(row, 'the stored row backs the event').to.exist;
    expect(row.data?.certificate?.subject).to.equal(subjectOutpoint);
  });

  it('a return past the grace: the subject removes its app and never refutes, its record stands, and it re-holds the fleet by its own dials', async function () {
    this.timeout(1200000);
    // The rows went at since + G (R4), and the return rule reads the same
    // clock (R5): a node whose certificate stands with since + G passed has
    // been replaced by the network and removes everything, announcing
    // nothing — an announce would put its rows back on every survivor. Past
    // the grace by construction, not by the preceding tests' durations.
    const [row] = await dbClient(WITNESS + 1).getNodeDownRecords(subjectOutpoint);
    const graceEnd = new Date(row.since).getTime() + NODE_DOWN_GRACE_MS + PAST_GRACE_MARGIN_MS;
    await sleep(Math.max(0, graceEnd - Date.now()));
    await env.healPartition([SUBJECT], survivors);

    await waitFor(async () => {
      const res = await env.clients[SUBJECT].getInstalledApps();
      return !(res?.data ?? []).some((app) => app.name === appName);
    }, { timeout: 600000, interval: 10000, label: 'the subject removed its app on return' });

    // The subject dials its own duties on return and the survivors admit it
    // (only a lockout refuses at the door). Its watchers hold a subject whose
    // record stands out of their dial plan, so the fleet re-holds it through
    // its own dials.
    await waitFor(async () => {
      const [outbound, inbound] = await Promise.all([
        env.clients[SUBJECT].getPeers(),
        env.clients[SUBJECT].getIncomingPeers(),
      ]);
      return (outbound.data ?? []).length + (inbound.data ?? []).length >= 2;
    }, { timeout: 240000, interval: 5000, label: 'subject re-held by the fleet' });

    // Held and app-less, the subject has had every chance to announce, and an
    // empty announcement is never broadcast: the record stands unrefuted on
    // every survivor and the subject never returns to the location view.
    await sleep(PAST_GRACE_MARGIN_MS);
    const states = await Promise.all(survivors.map(
      (i) => dbClient(i + 1).getNodeDownRecordState(subjectOutpoint),
    ));
    expect(states.every((state) => state === 'standing'), `the record is never refuted: ${JSON.stringify(states)}`).to.equal(true);
    const ips = await locationsSeenBy(WITNESS);
    expect(ips.some((ip) => ipMatches(ip, subjectIp())), 'the subject never refutes').to.equal(false);
    expect(ips.some((ip) => ipMatches(ip, coHolderIp())), 'the co-holder stands').to.equal(true);
  });
});
