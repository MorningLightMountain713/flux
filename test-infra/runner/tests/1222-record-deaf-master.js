// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createRequire } from 'node:module';
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
import { getState, advanceBlocks, stopTicker } from '../framework/daemon-control.js';
import { authenticate, signBtcMessage } from '../auth.js';
import { appOwnerKey } from '../framework/keys.js';

// The walk the nodes run, so the suite deals the same committees they do.
const require = createRequire(import.meta.url);
const { selectCommittee } = require('../../../ZelBack/src/services/utils/committeeSelector.js');

// A re-roll under a running master whose whole side MISSED the record
// (formal/quiet-window Run 34 and row 40; COMMITTEE_RECOVERY_DESIGN.md
// 2026-09-05, family K). The master's node and every cell of its granting
// committee are partitioned from the rest of the fleet while the owner's
// record is broadcast on the far side, then the partition heals. Nothing
// re-delivers a missed broadcast: the master's side is deaf, not dark. Its
// old cells keep renewing it — they do not know the record, and production
// retires by record receipt — so it never coasts and never polls a witness;
// nothing it hears from knows. The standbys, on the far side, received the
// record and will pursue at the lift.
//
// What closes the door: the cells the re-roll seats carry the record to
// every instance of the app. Proved here: the master learns the generation
// only after the heal and only from a courier, steps across at the lift on
// the same container, and nobody else is ever granted the new generation.
// The mutant that disables the courier is red at that last line: the
// standby seats the new generation under a live master.
//
// The app's name is chosen with the walk the nodes run: at most one holder
// sits on the granting committee (whichever holder becomes master, at least
// one standby is then on the far side, holding the record and able to
// pursue — the mutant's challenger), the re-rolled committee shares at most
// quorum − 2 cells with the granting one (the fresh-cell door), and at
// least a quorum of re-rolled cells stands outside both the granting
// committee and the holders (the couriers, and a challenger's quorum for
// the mutant). The choice is checked against the cells.

const HOLDERS = [0, 1, 2];
const NODES = 16;
const COMMITTEE_SIZE = 9;
const HELD_TTL_MS = 90000;
const DRAIN_BLOCKS = 3;
const RENEW_MS = 10000;

const outpointOf = (node) => `${node.txhash}:${node.outidx}`;
const walkKeyFor = (name, generation) => `quorumgrant|${name}/master@${generation}`;

function committeeOf(membership, name, generation) {
  const dealt = selectCommittee(membership, walkKeyFor(name, generation), { size: COMMITTEE_SIZE });
  expect(dealt.refusal, `the walk seats a committee for ${name} at generation ${generation}`).to.equal(null);
  return { members: new Set(dealt.members.map(outpointOf)), quorum: dealt.quorum };
}

function chooseDeafableApp(membership, stem, holderOutpoints) {
  for (let i = 0; i < 2000; i += 1) {
    const name = `${stem}${i.toString(36)}`;
    const granting = committeeOf(membership, name, 0);
    const reRolled = committeeOf(membership, name, 1);
    if (holderOutpoints.filter((holder) => granting.members.has(holder)).length > 1) continue;
    const shared = [...granting.members].filter((cell) => reRolled.members.has(cell));
    if (shared.length > granting.quorum - 2) continue;
    const farSideNew = [...reRolled.members].filter((cell) => !granting.members.has(cell) && !holderOutpoints.includes(cell));
    if (farSideNew.length < reRolled.quorum) continue;
    return {
      name, granting, reRolled, shared, farSideNew,
    };
  }
  throw new Error(`no app name off ${stem} in 2000 tries seats at most one holder on its granting committee, shares at most quorum − 2 cells, and leaves a quorum of re-rolled cells outside both`);
}

describe('record-deaf master: the cells the re-roll seats carry the record to the master, and it steps across', function () {
  let env;
  let name;
  let outpoints; // node index -> outpoint
  let ownerAuthFar;
  let walk;

  const key = () => `${name}/master`;
  const label = (i) => `node-${env.clients[i].num} (${env.clients[i].ip})`;
  const indexOf = (outpoint) => Number(Object.keys(outpoints).find((i) => outpoints[i] === outpoint));
  const describeCells = (cells) => [...cells].map((cell) => label(indexOf(cell))).join(', ');

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

  async function quorumVerdict(quorum) {
    const cells = await Promise.all(env.clients.map((_, i) => readCell(i)));
    const live = cells.filter((c) => c?.accepted?.grantee && !c.accepted.released && c.remainingMs > 0);
    const counts = new Map();
    for (const cell of live) {
      counts.set(cell.accepted.grantee, (counts.get(cell.accepted.grantee) ?? 0) + 1);
    }
    for (const [grantee, count] of counts.entries()) {
      if (count >= quorum) {
        const matching = live.filter((c) => c.accepted.grantee === grantee);
        return {
          grantee,
          epoch: Math.max(...matching.map((c) => c.accepted.epoch)),
          generation: Math.max(...matching.map((c) => c.accepted.generation ?? 0)),
        };
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

  // Every grant of the key at a generation since the markers, on any node, named.
  const grantsSince = (afterIds, generation) => env.clients
    .map((c, i) => ({
      i,
      hits: c.getEventBuffer().filter((e) => e.event === 'quorumGrant:granted' && e.id > afterIds[i]
        && e.data?.key === key() && (e.data?.generation ?? 0) === generation),
    }))
    .filter(({ hits }) => hits.length)
    .map(({ i, hits }) => `${label(i)} x${hits.length}`);

  const recordEventsSince = (i, afterId) => env.clients[i].getEventBuffer()
    .filter((e) => e.event === 'quorumGrant:generationRecord' && e.id > afterId
      && e.data?.appName === name && e.data?.role === 'master' && e.data?.generation === 1);

  // Drop every cross-group WebSocket upgrade by content, on both sides, so
  // the peerings the sever cut never return while plain HTTP flows.
  const UPGRADE_RULE = (ip) => ['sh', '-c', `iptables -I INPUT -s ${ip} -p tcp -m string --string "Upgrade: websocket" --algo bm --icase -j DROP`];
  const UPGRADE_RULE_OFF = (ip) => ['sh', '-c', `iptables -D INPUT -s ${ip} -p tcp -m string --string "Upgrade: websocket" --algo bm --icase -j DROP || true`];
  function crossGroupPairs(groupA, groupB) {
    const pairs = [];
    for (const a of groupA) {
      for (const b of groupB) {
        pairs.push([a, env.clients[b].ip]);
        pairs.push([b, env.clients[a].ip]);
      }
    }
    return pairs;
  }
  async function keepPeeringsSevered(groupA, groupB) {
    await Promise.all(crossGroupPairs(groupA, groupB).map(async ([node, otherIp]) => {
      const res = await env.clients[node].container.exec(UPGRADE_RULE(otherIp));
      if (res.exitCode !== 0) throw new Error(`upgrade drop on ${label(node)} for ${otherIp} failed (exit ${res.exitCode}): ${res.output}`);
    }));
  }
  async function releasePeerings(groupA, groupB) {
    await Promise.all(crossGroupPairs(groupA, groupB).map(([node, otherIp]) => env.clients[node].container.exec(UPGRADE_RULE_OFF(otherIp))));
  }

  async function submitRerollAt(i) {
    const owner = appOwnerKey();
    const { currentHeight } = await getState();
    const at = Date.now();
    const canonical = `fluxgrantgeneration:${name}|master|1|${currentHeight}|${at}`;
    const signature = await signBtcMessage(canonical, owner.privkey);
    const res = await fetch(`${env.clients[i].url}/apps/grantgeneration`, {
      method: 'POST',
      headers: { zelidauth: ownerAuthFar, 'content-type': 'application/json' },
      body: JSON.stringify({
        appName: name, role: 'master', generation: 1, height: currentHeight, at, signature,
      }),
    });
    return { status: res.status, body: await res.text(), height: currentHeight };
  }

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      tickerAutostart: false,
      zmqTopics: ALL_ZMQ_TOPICS,
      // partitionGroups holds until the cross-group sockets are gone — that
      // wait is peer liveness, declared rather than left on the fleet default
      timing: { partitions: true },
      configOverrides: {
        fluxapps: {
          quorumGrantMastership: true,
          quorumGrantHeldCommitteeSize: COMMITTEE_SIZE,
          quorumGrantHeldTtlMs: HELD_TTL_MS,
          quorumGrantRenewIntervalMs: RENEW_MS,
          quorumGrantLockDelayMs: 15000,
          quorumGrantDemotionSlackMs: 5000,
          quorumGrantMaxTtlMs: 120000,
          quorumGrantDrainMs: 90000,
          quorumGrantMinHolderAgeMs: 0,
          quorumGrantPursuitIntervalMs: 10000,
          quorumGrantGenerationDrainBlocks: DRAIN_BLOCKS,
          quorumGrantActivationHeight: 2_100_000,
        },
      },
    });
    await bootAndPeer(env);
    await stopTicker();

    const listed = await fetch(`${env.clients[0].url}/daemon/viewdeterministicfluxnodelist`, { signal: AbortSignal.timeout(10000) });
    const membership = (await listed.json())?.data;
    expect(membership, 'the deterministic list is the whole fleet').to.have.lengthOf(NODES);

    outpoints = {};
    for (let i = 0; i < env.clients.length; i += 1) {
      const status = await env.clients[i].getNodeStatus();
      outpoints[i] = `${status.data.txhash}:${status.data.outidx}`;
    }
    ({ name, ...walk } = chooseDeafableApp(membership, `e2edeaf${Date.now()}`, HOLDERS.map((i) => outpoints[i])));

    await pushImage(name, 'v1');
    const app = await buildSeedableSyncthingApp({ name, syncMode: 'activeStandby' });
    const installAfters = HOLDERS.map((i) => env.clients[i].getLastEventId());
    await installOnNodes(env, app, HOLDERS);
    await seedGlobalSpec(env, app, env.clients.map((_, i) => i).filter((i) => !HOLDERS.includes(i)));
    await Promise.all(HOLDERS.map((i) => waitForAppInstalled(env.clients[i], name, 240000)));
    await Promise.all(HOLDERS.map(async (i, k) => {
      await waitForReconcileActuated(env.clients[i], `${name}_${name}`, 'dataCleared', 60000, { afterId: installAfters[k] });
      await seedSyncScopedData(env, name, i);
    }));
    await setSynced({ folder: `flux${name}_${name}` });
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('a master whose whole side missed the re-roll learns it from a courier after the heal and steps across; nobody else is granted', async function () {
    this.timeout(1200000);

    // 1. A generation-0 quorum seats a master on the committee the suite dealt.
    const startMarkers = env.clients.map((c) => c.getLastEventId());
    let first = null;
    await waitFor(async () => {
      first = await quorumVerdict(walk.granting.quorum);
      return first !== null;
    }, { timeout: 240000, interval: 10000, label: 'a generation-0 grant quorum forms' });
    expect(first.generation, 'the first world is generation 0').to.equal(0);
    const master = indexOf(first.grantee);
    expect(HOLDERS, `master ${first.grantee} maps to a holder`).to.include(master);
    await env.clients[master].waitForEvent('quorumGrant:granted', (d) => d.key === key(), 60000, { afterId: startMarkers[master] });
    const container = await getAppContainerId(env.clients[master].container, name, name);
    expect(container, 'the master has a container to keep').to.be.a('string');
    const standbys = HOLDERS.filter((i) => i !== master);

    // 2. The deaf side: the master and every granting cell, cut from the
    //    rest until the cross-group sockets are gone. The master keeps its
    //    whole committee, so it stays held throughout.
    const deafSide = [...new Set([master, ...[...walk.granting.members].map(indexOf)])];
    const farSide = env.clients.map((_, i) => i).filter((i) => !deafSide.includes(i));
    // a standby that is itself a granting cell is deaf with the master; at
    // least one standby stands on the far side by the app's choice
    const farStandbys = standbys.filter((i) => farSide.includes(i));
    expect(farStandbys, 'a standby is on the far side to receive the record').to.have.length.of.at.least(1);
    const couriers = walk.farSideNew.map(indexOf);
    expect(couriers.filter((i) => deafSide.includes(i)), 'every courier cell is on the far side').to.deep.equal([]);
    expect(couriers, 'a quorum of the re-rolled committee stands on the far side').to.have.length.of.at.least(walk.reRolled.quorum);
    ownerAuthFar = (await authenticate(env.clients[farStandbys[0]].url, appOwnerKey())).zelidauth;

    await env.partitionGroups(deafSide, farSide);
    let healed = false;
    try {
      await assertNoEvent(env.clients[master], 'quorumGrant:demoted', (d) => d.key === key(), 5000);

      // 3. The owner's record is broadcast on the far side. Every courier cell
      //    and both standbys store it; the master does not — nothing crosses
      //    the partition, and nothing re-delivers a missed broadcast.
      const beforeReroll = env.clients.map((c) => c.getLastEventId());
      const rerolled = await submitRerollAt(farStandbys[0]);
      expect(rerolled.status, `the re-roll lands on the far side: ${rerolled.body}`).to.equal(200);
      await Promise.all([...couriers, ...farStandbys].map((i) => env.clients[i].waitForEvent(
        'quorumGrant:generationRecord',
        (d) => d.appName === name && d.role === 'master' && d.generation === 1,
        120000,
        { afterId: beforeReroll[i] },
      )));
      // the couriers on the re-rolled committee try to deliver and cannot reach
      // the master: the delivery is retried, never given up inside a term
      await env.clients[couriers[0]].waitForEvent('quorumGrant:generationCarried',
        (d) => d.key === key() && d.generation === 1 && d.remaining > 0, 60000, { afterId: beforeReroll[couriers[0]] });
      await assertNoEvent(env.clients[master], 'quorumGrant:generationRecord',
        (d) => d.appName === name && d.generation === 1, 2 * RENEW_MS + 5000);
      expect(recordEventsSince(master, beforeReroll[master]), 'the master is deaf to the re-roll while cut off').to.deep.equal([]);
      await assertNoEvent(env.clients[master], 'quorumGrant:coasting', (d) => d.key === key(), 5000);
      expect(await getAppContainerId(env.clients[master].container, name, name),
        'the container is untouched while the master is deaf').to.equal(container);

      // 4. The heal — packets, not peerings. A peer connection that is lost
      //    and returns makes the sync orchestrator pull the running-state
      //    events published while it was gone (appSyncOrchestrator
      //    #drainReconnectPulls, the ephemeralSync:reconnectRequested event),
      //    and that sync carries generation records: a deaf side whose
      //    sockets return learns by the product's own backstop, not by the
      //    courier — and the peer managers re-dial lost peers on their own,
      //    discovery or not (the fifth run: every deaf node pulled). The deaf
      //    world this suite constructs is a broadcast MISSED with no lost
      //    peer returning, so before the packet drops come off, every
      //    cross-group WebSocket upgrade is dropped by content on both sides
      //    (the string match the node image's iptables carries), and the
      //    premise is asserted below from the pull's own event. The courier's
      //    delivery, the asks and the record reads are plain HTTP and flow.
      //    The master learns the generation from the courier — its own cells
      //    still do not know it, and it never polled a witness — and stays
      //    held under its old world until the lift.
      const beforeHeal = env.clients.map((c) => c.getLastEventId());
      await keepPeeringsSevered(deafSide, farSide);
      await env.healPartition(deafSide, farSide);
      healed = true;
      await env.clients[master].waitForEvent('quorumGrant:generationRecord',
        (d) => d.appName === name && d.role === 'master' && d.generation === 1, 120000, { afterId: beforeHeal[master] });
      const pullsSince = (i, afterId) => env.clients[i].getEventBuffer()
        .filter((e) => e.event === 'ephemeralSync:reconnectRequested' && e.id > afterId);
      expect(deafSide.filter((i) => pullsSince(i, beforeHeal[i]).length).map(label),
        'no reconnect pull ran on the deaf side: the premise of a missed broadcast holds').to.deep.equal([]);
      await waitFor(() => couriers.some((i) => env.clients[i].getEventBuffer().some((e) => e.event === 'quorumGrant:generationCarried'
        && e.id > beforeHeal[i] && e.data?.key === key() && e.data?.generation === 1 && e.data?.remaining === 0)),
      { timeout: 120000, interval: 5000, label: 'a courier cell reports every instance acknowledged' });
      const deafCells = [...walk.granting.members].map(indexOf);
      expect(deafCells.filter((i) => recordEventsSince(i, beforeReroll[i]).length),
        'the granting cells never receive the record: the master learned from a courier, not from a refusal').to.deep.equal([]);
      expect(grantsSince(beforeReroll, 1), 'nobody was granted at generation 1 before the lift').to.deep.equal([]);
      await assertNoEvent(env.clients[master], 'quorumGrant:demoted', (d) => d.key === key(), 5000);

      // 5. The lift: the master steps across on the far-side cells with its
      //    credential; the standbys, who knew first, never seat. Same container.
      const beforeLift = env.clients.map((c) => c.getLastEventId());
      await advanceBlocks(DRAIN_BLOCKS);
      await env.clients[master].waitForEvent('quorumGrant:steppedAcross',
        (d) => d.key === key() && d.generation === 1, 180000, { afterId: beforeLift[master] });
      await env.clients[master].waitForEvent('quorumGrant:assess',
        (d) => d.key === key() && d.outcome === 'held' && d.quorumRenewed === true, 60000, { afterId: beforeLift[master] });
      let second = null;
      await waitFor(async () => {
        second = await quorumVerdict(walk.reRolled.quorum);
        return second !== null && second.generation === 1;
      }, { timeout: 60000, interval: 5000, label: 'a generation-1 quorum forms' });
      expect(second.grantee, 'the new world names the same master').to.equal(first.grantee);
      expect(grantsSince(beforeReroll, 1), 'nobody else was granted at generation 1: the master stepped across')
        .to.deep.equal([]);
      await Promise.all(standbys.map((i) => assertNoEvent(env.clients[i], 'quorumGrant:granted',
        (d) => d.key === key(), 2 * 15000)));
      expect(await getAppContainerId(env.clients[master].container, name, name),
        'the same container across the re-roll').to.equal(container);
      await assertNoEvent(env.clients[master], 'quorumGrant:demoted', (d) => d.key === key(), 10000);
      const stillUp = await upHolders();
      expect(stillUp, 'exactly one holder runs the app').to.have.lengthOf(1);
      expect(label(stillUp[0]), 'the master that stepped across').to.equal(label(master));
      expect(describeCells(walk.reRolled.members), 'the re-rolled committee the suite dealt').to.be.a('string');
    } finally {
      if (!healed) await env.healPartition(deafSide, farSide);
      await releasePeerings(deafSide, farSide);
    }
  });
});
