// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import {
  bootAndPeer, installOnNodes, seedGlobalSpec, seedSyncScopedData,
} from '../framework/reconciler-suite.js';
import { buildSeedableSyncthingApp } from '../framework/seed-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { setSynced } from '../framework/syncthing-control.js';
import { getAppContainerStatus, getAppContainerId } from '../framework/container.js';
import {
  waitFor, waitForAppInstalled, waitForReconcileActuated, assertNoEvent,
} from '../framework/wait.js';
import { dbClient } from '../framework/db-client.js';

// A published masterlease record is a claim; the granting committee's signed
// term acceptances are its proof, verified at every node's intake against the
// membership the record's fingerprint names. A listed node that publishes a
// record naming itself as an app's master — with no acceptances, with forged
// ones, or with a membership nobody can rebuild — never displaces the
// verified record, and the master's container never stops. The stub peer is a
// listed node with its own registered key: its broadcasts pass the announcer
// binding and fail only the proof.

const HOLDERS = [0, 1, 2];
const NODES = 10;
const STUB = 9;
const REAL = Array.from({ length: NODES }, (unused, i) => i).filter((i) => i !== STUB);

describe('masterlease proof: a listed node\'s claim without the committee\'s signatures never becomes the record', function () {
  let env;
  let name;
  let outpoints; // real node index -> outpoint
  let stub;
  let stubOutpoint;

  const key = () => `${name}/master`;
  const label = (i) => `node-${env.clients[i].num} (${env.clients[i].ip})`;

  async function readCell(i) {
    try {
      const res = await fetch(
        `${env.clients[i].url}/flux/quorumgrant/record?key=${encodeURIComponent(key())}`,
        { signal: AbortSignal.timeout(5000) },
      );
      const body = await res.json();
      return body?.data ?? null;
    } catch {
      return null;
    }
  }

  async function quorumVerdict() {
    const cells = await Promise.all(REAL.map((i) => readCell(i)));
    const live = cells.filter((c) => c?.accepted?.grantee && !c.accepted.released && c.remainingMs > 0);
    const counts = new Map();
    for (const cell of live) {
      counts.set(cell.accepted.grantee, (counts.get(cell.accepted.grantee) ?? 0) + 1);
    }
    for (const [grantee, count] of counts.entries()) {
      if (count >= 5) {
        const matching = live.filter((c) => c.accepted.grantee === grantee);
        return { grantee, epoch: Math.max(...matching.map((c) => c.accepted.epoch)) };
      }
    }
    return null;
  }

  const upHolders = async () => {
    const statuses = await Promise.all(HOLDERS.map(
      (i) => getAppContainerStatus(env.clients[i].container, name).catch(() => null),
    ));
    return HOLDERS.filter((_, k) => statuses[k] && statuses[k].status.startsWith('Up'));
  };

  // Every real node's stored record names the master and is verified.
  const recordsNameTheMaster = async (master) => {
    const records = await Promise.all(REAL.map((i) => dbClient(i + 1).getMasterleaseRecord(name, 'master')));
    return records.every((r) => r?.grantee === master && r.verified === true);
  };

  // Broadcast from the stub until at least one connected peer received it.
  const broadcastFromStub = async (data) => {
    let sent = 0;
    await waitFor(async () => {
      ({ sent } = await stub.broadcast(data));
      return sent >= 1;
    }, { timeout: 120000, interval: 10000, label: 'the stub peer has a connected node to broadcast to' });
    return sent;
  };

  const droppedOnAnyNode = (afterIds, reason, timeoutMs) => Promise.any(REAL.map((i) => env.clients[i].waitForEvent(
    'quorumGrant:masterleaseDropped',
    (d) => d.appName === name && d.grantee === stubOutpoint && d.reason === reason,
    timeoutMs,
    { afterId: afterIds[i] },
  ).then(() => i))).catch(() => null);

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      stubPeers: [STUB],
      tickerAutostart: false,
      zmqTopics: ALL_ZMQ_TOPICS,
      configOverrides: {
        fluxapps: {
          quorumGrantMastership: true,
          quorumGrantHeldTtlMs: 90000,
          quorumGrantRenewIntervalMs: 10000,
          quorumGrantLockDelayMs: 15000,
          quorumGrantDemotionSlackMs: 5000,
          quorumGrantMaxTtlMs: 120000,
          quorumGrantDrainMs: 90000,
          quorumGrantMinHolderAgeMs: 0,
          quorumGrantPursuitIntervalMs: 10000,
          quorumGrantActivationHeight: 2_100_000,
        },
      },
    });
    await bootAndPeer(env, REAL);
    stub = env.stubPeerClients.get(STUB) ?? [...env.stubPeerClients.values()][0];
    expect(stub, 'a stub peer client exists').to.be.an('object');

    name = `e2eproof${Date.now()}`;
    await pushImage(name, 'v1');
    const app = await buildSeedableSyncthingApp({ name, syncMode: 'activeStandby' });
    const installAfters = HOLDERS.map((i) => env.clients[i].getLastEventId());
    await installOnNodes(env, app, HOLDERS);
    await seedGlobalSpec(env, app, REAL.filter((i) => !HOLDERS.includes(i)));
    await Promise.all(HOLDERS.map((i) => waitForAppInstalled(env.clients[i], name, 240000)));
    await Promise.all(HOLDERS.map(async (i, k) => {
      await waitForReconcileActuated(env.clients[i], `${name}_${name}`, 'dataCleared', 60000, { afterId: installAfters[k] });
      await seedSyncScopedData(env, name, i);
    }));
    await setSynced({ folder: `flux${name}_${name}` });

    outpoints = {};
    for (const i of REAL) {
      const status = await env.clients[i].getNodeStatus();
      outpoints[i] = `${status.data.txhash}:${status.data.outidx}`;
    }
    const listed = await fetch(`${env.clients[0].url}/daemon/viewdeterministicfluxnodelist`, { signal: AbortSignal.timeout(10000) });
    const entry = ((await listed.json())?.data ?? []).find((node) => String(node.ip).split(':')[0] === stub.ip);
    expect(entry, `the stub peer ${stub.ip} is a listed node`).to.be.an('object');
    stubOutpoint = `${entry.txhash}:${entry.outidx}`;
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('no acceptances, forged acceptances, and an unverifiable membership each fail to displace the verified record; the master never stops', async function () {
    this.timeout(900000);

    // 1. A grant quorum seats a master; every real node stores its verified record.
    let first = null;
    await waitFor(async () => {
      first = await quorumVerdict();
      return first !== null;
    }, { timeout: 240000, interval: 10000, label: 'a grant quorum forms' });
    const master = REAL.find((i) => outpoints[i] === first.grantee);
    expect(HOLDERS, `master ${first.grantee} maps to a holder`).to.include(master);
    const container = await getAppContainerId(env.clients[master].container, name, name);
    await waitFor(() => recordsNameTheMaster(first.grantee),
      { timeout: 120000, interval: 5000, label: 'every real node holds the master\'s verified record' });
    const record = await dbClient(master + 1).getMasterleaseRecord(name, 'master');
    expect(record.acceptances.length, 'the record carries a quorum of acceptances').to.be.at.least(5);

    const claim = (overrides = {}) => ({
      type: 'fluxmasterlease',
      version: 1,
      ip: `${stub.ip}:16127`,
      appName: name,
      role: 'master',
      grantee: stubOutpoint,
      epoch: record.epoch + 5,
      mode: 'held',
      generation: record.generation ?? 0,
      fingerprint: record.fingerprint,
      ttlMs: 90000,
      broadcastedAt: Date.now(),
      ...overrides,
    });

    // 2. No acceptances: dropped as malformed at intake.
    let markers = env.clients.map((c) => (c ? c.getLastEventId() : 0));
    await broadcastFromStub(claim());
    const droppedA = await droppedOnAnyNode(markers, 'malformed acceptances', 60000);
    expect(droppedA, 'a node received the claim and dropped it as malformed').to.not.equal(null);

    // 3. Forged acceptances naming the real committee's members: dropped as unproved.
    const forged = record.acceptances.map((a) => ({ grantor: a.grantor, signature: 'Zm9yZ2Vk' }));
    markers = env.clients.map((c) => (c ? c.getLastEventId() : 0));
    await broadcastFromStub(claim({ epoch: record.epoch + 6, acceptances: forged, broadcastedAt: Date.now() }));
    const droppedB = await droppedOnAnyNode(markers, 'acceptances do not verify against the granting committee', 60000);
    expect(droppedB, 'a node received the forged claim and dropped it as unproved').to.not.equal(null);

    // 4. A membership nobody can rebuild: stored unverified on whoever received
    //    it, and it never outranks the verified record.
    markers = env.clients.map((c) => (c ? c.getLastEventId() : 0));
    await broadcastFromStub(claim({
      epoch: record.epoch + 7, fingerprint: 'f'.repeat(64), acceptances: forged, broadcastedAt: Date.now(),
    }));
    const unverifiedOn = await Promise.any(REAL.map((i) => env.clients[i].waitForEvent(
      'quorumGrant:masterleaseUnverified',
      (d) => d.appName === name && d.grantee === stubOutpoint,
      60000,
      { afterId: markers[i] },
    ).then(() => i))).catch(() => null);
    expect(unverifiedOn, 'a node received the unverifiable claim and stored it unverified').to.not.equal(null);

    // 5. Every real node's record still names the master, verified; the
    //    master's container never stopped and no standby started.
    await waitFor(() => recordsNameTheMaster(first.grantee),
      { timeout: 60000, interval: 5000, label: 'every real node\'s record still names the master, verified' });
    const stored = await dbClient(unverifiedOn + 1).getMasterleaseRecord(name, 'master');
    expect(stored.grantee, `${label(unverifiedOn)} kept the verified record over the unverified claim`).to.equal(first.grantee);
    expect(stored.verified).to.equal(true);
    await assertNoEvent(env.clients[master], 'quorumGrant:demoted', (d) => d.key === key(), 15000);
    expect(await getAppContainerId(env.clients[master].container, name, name), 'the same container').to.equal(container);
    const up = await upHolders();
    expect(up, 'exactly one holder runs the app').to.have.lengthOf(1);
    expect(label(up[0])).to.equal(label(master));
  });
});
