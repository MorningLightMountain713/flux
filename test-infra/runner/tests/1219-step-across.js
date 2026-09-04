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
import { dbClient } from '../framework/db-client.js';
import { getState, advanceBlocks, stopTicker } from '../framework/daemon-control.js';
import { authenticate, signBtcMessage } from '../auth.js';
import { appOwnerKey } from '../framework/keys.js';

// The walk the nodes run, so the suite deals the same committees they do.
const require = createRequire(import.meta.url);
const { selectCommittee } = require('../../../ZelBack/src/services/utils/committeeSelector.js');

// A re-roll under a running master (STEP_ACROSS_DESIGN.md). Every referee
// that accepts or renews a term signs it; the holder keeps a quorum of those
// signatures as its credential; a referee on the re-rolled committee admits a
// verified carrier at its empty seat with no wait; the holder steps across to
// the new committee before it renews. Proved here: the master's container ID
// never changes, it holds the new generation's term, nobody else is granted,
// and the retired committee's rows lapse.
//
// Two committees that share a quorum of cells never ask the credential: the
// master is exempt at a shared cell by its own row (formal/quiet-window row
// 24). Nine-of-sixteen committees share five cells on average, a quorum, so
// the app's name is chosen with the walk the nodes run: its re-rolled
// committee shares at most quorum − 2 cells with the granting one, and the
// master's new term must stand on at least two cells that never held a row
// for it. The choice is checked against the cells.
//
// The retirement drain is measured in blocks; the ticker is stopped and the
// suite advances the blocks that lift it.

const HOLDERS = [0, 1, 2];
const NODES = 16;
const COMMITTEE_SIZE = 9; // production's held committee
const HELD_TTL_MS = 90000;
const DRAIN_BLOCKS = 3;

const outpointOf = (node) => `${node.txhash}:${node.outidx}`;
// rosterOverlay.walkKeyFor
const walkKeyFor = (name, generation) => `quorumgrant|${name}/master@${generation}`;

function committeeOf(membership, name, generation) {
  const dealt = selectCommittee(membership, walkKeyFor(name, generation), { size: COMMITTEE_SIZE });
  expect(dealt.refusal, `the walk seats a committee for ${name} at generation ${generation}`).to.equal(null);
  return { members: new Set(dealt.members.map(outpointOf)), quorum: dealt.quorum };
}

// An app whose re-rolled committee shares at most quorum − 2 cells with its
// granting one. A run that finds none says so.
function chooseFreshCellApp(membership, stem) {
  for (let i = 0; i < 400; i += 1) {
    const name = `${stem}${i.toString(36)}`;
    const granting = committeeOf(membership, name, 0);
    const reRolled = committeeOf(membership, name, 1);
    const shared = [...granting.members].filter((cell) => reRolled.members.has(cell));
    if (shared.length <= granting.quorum - 2) {
      return {
        name, granting, reRolled, shared,
      };
    }
  }
  throw new Error(`no app name off ${stem} in 400 tries whose re-rolled committee shares at most quorum − 2 cells with its granting one`);
}

describe('step-across: the owner re-rolls the committee under a running master, and the master keeps its container', function () {
  let env;
  let name;
  let outpoints; // node index -> outpoint
  let ownerAuth0;
  let walk; // { granting, reRolled, shared } as the suite dealt them

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

  // The cells whose register names a grantee at a generation, live or lapsed.
  async function cellsNaming(grantee, generation) {
    const cells = await Promise.all(env.clients.map((_, i) => readCell(i)));
    return new Set(cells
      .map((cell, i) => ({ cell, i }))
      .filter(({ cell }) => cell?.accepted?.grantee === grantee
        && !cell.accepted.released
        && (cell.accepted.generation ?? 0) === generation)
      .map(({ i }) => outpoints[i]));
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

  // Every grant of the key since the markers, on any node, named.
  const grantsSince = (afterIds) => env.clients
    .map((c, i) => ({
      i,
      hits: c.getEventBuffer().filter((e) => e.event === 'quorumGrant:granted' && e.id > afterIds[i] && e.data?.key === key()),
    }))
    .filter(({ hits }) => hits.length)
    .map(({ i, hits }) => `${label(i)} at generation ${hits.map((e) => e.data?.generation ?? 0).join('/')}`);

  async function submitReroll() {
    const owner = appOwnerKey();
    const { currentHeight } = await getState();
    const at = Date.now();
    const canonical = `fluxgrantgeneration:${name}|master|1|${currentHeight}|${at}`;
    const signature = await signBtcMessage(canonical, owner.privkey);
    const res = await fetch(`${env.clients[0].url}/apps/grantgeneration`, {
      method: 'POST',
      headers: { zelidauth: ownerAuth0, 'content-type': 'application/json' },
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
      // committees pin at anchored membership: the ZMQ delta path
      zmqTopics: ALL_ZMQ_TOPICS,
      configOverrides: {
        fluxapps: {
          quorumGrantMastership: true,
          quorumGrantHeldCommitteeSize: COMMITTEE_SIZE,
          quorumGrantHeldTtlMs: HELD_TTL_MS,
          quorumGrantRenewIntervalMs: 10000,
          quorumGrantLockDelayMs: 15000,
          quorumGrantDemotionSlackMs: 5000,
          quorumGrantMaxTtlMs: 120000,
          quorumGrantDrainMs: 90000,
          quorumGrantMinHolderAgeMs: 0,
          quorumGrantPursuitIntervalMs: 10000,
          // the master coasts through the drain and steps across at its lift
          quorumGrantGenerationDrainBlocks: DRAIN_BLOCKS,
          // the plane governs from the fleet's first block
          quorumGrantActivationHeight: 2_100_000,
        },
      },
    });
    await bootAndPeer(env);
    // bootAndPeer starts the ticker; the drain is measured in blocks
    await stopTicker();
    ownerAuth0 = (await authenticate(env.clients[0].url, appOwnerKey())).zelidauth;

    // the walk's input: the deterministic list as the nodes hold it
    const listed = await fetch(`${env.clients[0].url}/daemon/viewdeterministicfluxnodelist`, { signal: AbortSignal.timeout(10000) });
    const membership = (await listed.json())?.data;
    expect(membership, 'the deterministic list is the whole fleet').to.have.lengthOf(NODES);
    ({ name, ...walk } = chooseFreshCellApp(membership, `e2estep${Date.now()}`));

    await pushImage(name, 'v1');
    const app = await buildSeedableSyncthingApp({ name, syncMode: 'activeStandby' });
    const installAfters = HOLDERS.map((i) => env.clients[i].getLastEventId());
    await installOnNodes(env, app, HOLDERS);
    // grantors verify the owner's record against their own copy of the spec
    await seedGlobalSpec(env, app, env.clients.map((_, i) => i).filter((i) => !HOLDERS.includes(i)));
    await Promise.all(HOLDERS.map((i) => waitForAppInstalled(env.clients[i], name, 240000)));
    await Promise.all(HOLDERS.map(async (i, k) => {
      await waitForReconcileActuated(env.clients[i], `${name}_${name}`, 'dataCleared', 60000, { afterId: installAfters[k] });
      await seedSyncScopedData(env, name, i);
    }));
    await setSynced({ folder: `flux${name}_${name}` });

    outpoints = {};
    for (let i = 0; i < env.clients.length; i += 1) {
      const status = await env.clients[i].getNodeStatus();
      outpoints[i] = `${status.data.txhash}:${status.data.outidx}`;
    }
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('the master steps across on its credential: same container, the new generation\'s term, nobody else granted, the old rows lapse', async function () {
    this.timeout(900000);

    // 1. A generation-0 quorum seats a master; its rows sit on the committee
    //    the suite dealt.
    let first = null;
    await waitFor(async () => {
      first = await quorumVerdict(walk.granting.quorum);
      return first !== null;
    }, { timeout: 240000, interval: 10000, label: 'a generation-0 grant quorum forms' });
    expect(first.generation, 'the first world is generation 0').to.equal(0);
    const master = indexOf(first.grantee);
    expect(HOLDERS, `master ${first.grantee} maps to a holder`).to.include(master);
    const container = await getAppContainerId(env.clients[master].container, name, name);
    expect(container, 'the master has a container to keep').to.be.a('string');
    const rows0 = await cellsNaming(first.grantee, 0);
    expect([...rows0].filter((cell) => !walk.granting.members.has(cell)),
      `every generation-0 row sits on the walk's granting committee (${describeCells(walk.granting.members)})`).to.deep.equal([]);
    expect(rows0.size, 'a quorum of the granting committee holds the master\'s row').to.be.at.least(walk.granting.quorum);

    // 2. The re-roll lands under the running master. Markers are taken before
    //    the submission: node 0 stores the record before it answers.
    const beforeReroll = env.clients.map((c) => c.getLastEventId());
    const rerolled = await submitReroll();
    expect(rerolled.status, `the re-roll lands under the running master: ${rerolled.body}`).to.equal(200);

    // 3. The record reaches every holder.
    await Promise.all(HOLDERS.map((i) => env.clients[i].waitForEvent(
      'quorumGrant:generationRecord',
      (d) => d.appName === name && d.role === 'master' && d.generation === 1,
      120000,
      { afterId: beforeReroll[i] },
    )));

    // 4. The retirement drain: the old cells refuse the retired generation,
    //    the new cells answer serving:false, the master coasts. Nothing is
    //    granted at generation 1 while the chain stands still; the container
    //    is untouched.
    await env.clients[master].waitForEvent('quorumGrant:coasting', (d) => d.key === key(), 120000, { afterId: beforeReroll[master] });
    await Promise.all(env.clients.map((c) => assertNoEvent(
      c, 'quorumGrant:granted', (d) => d.key === key() && d.generation === 1, 30000,
    )));
    expect(await getAppContainerId(env.clients[master].container, name, name),
      'the container is untouched through the drain').to.equal(container);
    expect(grantsSince(beforeReroll), 'nobody was granted inside the drain').to.deep.equal([]);

    // 5. The lift: the master's next pass steps across over the new committee
    //    with its credential; its next assess is held under that committee.
    //    Nobody was granted at generation 1, no demotion, same container.
    const beforeLift = env.clients.map((c) => c.getLastEventId());
    await advanceBlocks(DRAIN_BLOCKS);
    await env.clients[master].waitForEvent('quorumGrant:steppedAcross',
      (d) => d.key === key() && d.generation === 1, 180000, { afterId: beforeLift[master] });
    await env.clients[master].waitForEvent('quorumGrant:assess',
      (d) => d.key === key() && d.outcome === 'held' && d.quorumRenewed === true, 60000, { afterId: beforeLift[master] });
    expect(grantsSince(beforeReroll), 'nobody was granted at generation 1: the master stepped across')
      .to.deep.equal([]);
    await assertNoEvent(env.clients[master], 'quorumGrant:demoted', (d) => d.key === key(), 15000);
    expect(await getAppContainerId(env.clients[master].container, name, name),
      'the same container across the re-roll').to.equal(container);

    // 6. The new world names the same master at a fresh epoch, on the cells
    //    and in the published record.
    let second = null;
    await waitFor(async () => {
      second = await quorumVerdict(walk.reRolled.quorum);
      return second !== null && second.generation === 1;
    }, { timeout: 60000, interval: 5000, label: 'a generation-1 quorum forms' });
    expect(second.grantee, 'it names the same master').to.equal(first.grantee);
    expect(second.epoch, 'at a fresh epoch').to.be.greaterThan(first.epoch);
    const standby = HOLDERS.find((i) => i !== master);
    await waitFor(async () => {
      const record = await dbClient(standby + 1).getMasterleaseRecord(name, 'master');
      return record?.grantee === first.grantee && record.generation === 1;
    }, { timeout: 90000, interval: 5000, label: 'the published record names the master at generation 1' });

    // 7. The credential decided: the generation-1 rows sit on the re-rolled
    //    committee, at least two on cells that never held a row for the
    //    master, and each such cell served the master's accept on a verified
    //    credential while a stranger would still have waited at that seat.
    const rows1 = await cellsNaming(first.grantee, 1);
    expect([...rows1].filter((cell) => !walk.reRolled.members.has(cell)),
      `every generation-1 row sits on the walk's re-rolled committee (${describeCells(walk.reRolled.members)})`).to.deep.equal([]);
    expect(rows1.size, 'a quorum of the re-rolled committee holds the master\'s new row').to.be.at.least(walk.reRolled.quorum);
    const freshSeats = [...rows1].filter((cell) => !walk.granting.members.has(cell));
    expect(freshSeats.length,
      `the new term stands on cells that never held a row for the master (shared cells ${walk.shared.length}, quorum ${walk.reRolled.quorum})`)
      .to.be.at.least(2);
    const verifiedAt = freshSeats.filter((cell) => {
      const i = indexOf(cell);
      return env.clients[i].getEventBuffer().some((e) => e.event === 'quorumGrant:served'
        && e.id > beforeLift[i]
        && e.data?.type === 'accept' && e.data?.key === key() && e.data?.candidate === first.grantee
        && e.data?.outcome === 'served' && e.data?.code === undefined
        && e.data?.carried === 'verified' && e.data?.seatWaitMs > 0);
    });
    expect(verifiedAt.length,
      `fresh cells that admitted the master on a verified credential ahead of the seat wait: ${describeCells(verifiedAt) || 'none'}`)
      .to.be.at.least(2);

    // 8. The old rows lapse: every cell outside the new committee that held
    //    the master's generation-0 row keeps it, unrenewed, to its TTL. A
    //    granting cell in its boot drain at the grant holds no row. Same
    //    container, one holder, no demotion.
    const retiredOnly = [...rows0].filter((cell) => !walk.reRolled.members.has(cell)).map(indexOf);
    expect(retiredOnly.length, 'a retired cell holds the master\'s generation-0 row').to.be.at.least(1);
    await waitFor(async () => {
      const cells = await Promise.all(retiredOnly.map((i) => readCell(i)));
      return cells.every((cell) => cell?.accepted?.grantee === first.grantee
        && (cell.accepted.generation ?? 0) === 0
        && cell.remainingMs === 0);
    }, { timeout: HELD_TTL_MS + 60000, interval: 10000, label: 'the retired committee\'s own rows lapse' });
    expect(await getAppContainerId(env.clients[master].container, name, name),
      'the same container once the old rows have lapsed').to.equal(container);
    const stillUp = await upHolders();
    expect(stillUp, 'exactly one holder runs the app').to.have.lengthOf(1);
    expect(label(stillUp[0]), 'the master that stepped across').to.equal(label(master));
    await assertNoEvent(env.clients[master], 'quorumGrant:demoted', (d) => d.key === key(), 10000);
  });
});
