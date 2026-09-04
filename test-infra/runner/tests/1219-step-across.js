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

// The walk itself, never a copy of it: which cells a re-rolled committee
// shares with the granting one is decided by the function the nodes run.
const require = createRequire(import.meta.url);
const { selectCommittee } = require('../../../ZelBack/src/services/utils/committeeSelector.js');

// Step-across (STEP_ACROSS_DESIGN.md, shape stamped 2026-09-03): the owner
// re-rolls an app's committee while its master RUNS, and the master keeps its
// container. Today a re-roll is stop-first — ownerGenerationController refuses
// it under a live term, because the fresh referees have never heard of the
// master: their seats are empty, and a standby that took them would be a
// second master. The build this suite proves: every referee that accepts or
// renews a term signs it (termaccept); the holder keeps a quorum of those
// signatures as its credential; a referee that never sat on the granting
// committee verifies the carried credential and admits the carrier at its
// empty seat with no wait; and the holder, on learning a newer generation
// stands, steps across to the new committee with the credential before it
// renews. The stop-first door lifts for good only once this suite is green
// (the design's step 5); this suite passes it by its own rule, below.
//
// THE DOOR AS BUILT is a door for one TTL. It refuses while the published
// masterlease record is younger than its ttlMs, and its comment says a
// renewing master keeps that record fresh — but nothing republishes on a
// renewal: publishRecord runs at the grant, a heal, a refresh and the
// step-across, and the record's broadcastedAt is stamped at publish. So a
// re-roll submitted one TTL after the master's grant lands UNDER THE RUNNING
// MASTER today, on any fleet. 1203's door assertion passed on timing (its
// submission came seconds after a fresh grant). This suite makes the hole a
// run: the first submission, seconds after the grant, is refused; the same
// submission lands once the record ages past its TTL, with the master
// renewing throughout — which is exactly the situation the step-across
// exists to make safe.
//
// The vacuity trap (formal/quiet-window row 24, and the thirteen-peer unit
// fixture before it): in a small world two committees share a QUORUM of cells,
// the master is exempt at a shared cell by its own row, and the credential is
// never the deciding fact. Nine-of-sixteen committees share five cells on
// average — a quorum. So the app's NAME is chosen, with the walk the nodes
// run, so that its re-rolled committee shares at most quorum − 2 cells with
// the granting one: the master's new term needs at least two cells that never
// held a row for it, and only the credential admits it there ahead of the
// empty-seat wait. The choice is then checked against the cells themselves.
//
// The chain is driven by hand: the retirement drain is measured in blocks,
// and with the ticker stopped the blocks that lift it are exactly the ones
// this suite advances.

const HOLDERS = [0, 1, 2];
const NODES = 16;
const COMMITTEE_SIZE = 9; // production's held committee
const HELD_TTL_MS = 90000;
const DRAIN_BLOCKS = 3;

const outpointOf = (node) => `${node.txhash}:${node.outidx}`;
// rosterOverlay.walkKeyFor: the generation-salted walk key
const walkKeyFor = (name, generation) => `quorumgrant|${name}/master@${generation}`;

function committeeOf(membership, name, generation) {
  const dealt = selectCommittee(membership, walkKeyFor(name, generation), { size: COMMITTEE_SIZE });
  expect(dealt.refusal, `the walk seats a committee for ${name} at generation ${generation}`).to.equal(null);
  return { members: new Set(dealt.members.map(outpointOf)), quorum: dealt.quorum };
}

// An app whose re-rolled committee shares at most quorum − 2 cells with its
// granting one. Names are tried in order off one stem; the walk is a hash, so
// a few dozen suffice — and a run that finds none says so rather than proving
// nothing.
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

  // The cells whose register names a grantee at a generation, live or lapsed —
  // read off every node, so a row that landed off the walk shows up.
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

  // Every grant of the key since the markers, on any node, named — so
  // 'granted elsewhere' arrives as an equality failure naming the winner.
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
      // committees pin at anchored membership — the ZMQ delta machinery
      // production runs, never the polling path
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
          // Small but real: the master must COAST through it and step across
          // only at its lift — a zero here would never exercise the drain.
          quorumGrantGenerationDrainBlocks: DRAIN_BLOCKS,
          // the plane governs from the fleet's first block
          quorumGrantActivationHeight: 2_100_000,
        },
      },
    });
    await bootAndPeer(env);
    // bootAndPeer starts the ticker whatever tickerAutostart says; the drain
    // below is measured in blocks, so the chain is driven by hand from here.
    await stopTicker();
    ownerAuth0 = (await authenticate(env.clients[0].url, appOwnerKey())).zelidauth;

    // The walk's input: the deterministic list as the nodes hold it.
    const listed = await fetch(`${env.clients[0].url}/daemon/viewdeterministicfluxnodelist`, { signal: AbortSignal.timeout(10000) });
    const membership = (await listed.json())?.data;
    expect(membership, 'the deterministic list is the whole fleet').to.have.lengthOf(NODES);
    ({ name, ...walk } = chooseFreshCellApp(membership, `e2estep${Date.now()}`));

    await pushImage(name, 'v1');
    const app = await buildSeedableSyncthingApp({ name, syncMode: 'activeStandby' });
    const installAfters = HOLDERS.map((i) => env.clients[i].getLastEventId());
    await installOnNodes(env, app, HOLDERS);
    // Every node must know the app: the outsider grantors verify the owner's
    // generation record against their own copy of the spec and drop it
    // otherwise (1203's lesson).
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

    // 1. The plane seats a master under generation 0, and the cells holding
    //    its rows are the granting committee the suite dealt — the walk the
    //    suite computed is the walk the fleet ran.
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

    // 2. The re-roll, under the RUNNING master. Seconds after the grant the
    //    record is fresh and the door refuses, teaching stop-first. Then the
    //    door opens BY ITSELF: nothing republishes the record on a renewal, so
    //    one TTL after the grant the same submission lands — with the master
    //    still renewing (its passes keep answering held), never demoted,
    //    never yielded, the container untouched. The door's own answer is the
    //    observable; only the record's age paces it, never a timer here.
    const beforeFirstAsk = env.clients.map((c) => c.getLastEventId());
    const refused = await submitReroll();
    expect(refused.status, `a re-roll seconds after the grant is refused, teaching stop-first: ${refused.body}`).to.equal(409);
    expect(refused.body).to.match(/live held term stands/);
    // The markers are taken before the attempt that lands: node 0 stores the
    // record and fires its own event inside the submit path, before answering.
    let beforeReroll = null;
    await waitFor(async () => {
      const markers = env.clients.map((c) => c.getLastEventId());
      const attempt = await submitReroll();
      if (attempt.status !== 200) return false;
      beforeReroll = markers;
      return true;
    }, { timeout: HELD_TTL_MS + 90000, interval: 10000, label: 'the door opens on its own once the record ages past its TTL' });
    const renewedWhileWaiting = env.clients[master].getEventBuffer()
      .filter((e) => e.event === 'quorumGrant:assess' && e.id > beforeFirstAsk[master]
        && e.data?.key === key() && e.data?.outcome === 'held' && e.data?.quorumRenewed === true);
    expect(renewedWhileWaiting.length, 'the master renewed its term while the door aged open').to.be.at.least(1);
    expect(env.clients[master].getEventBuffer()
      .some((e) => e.event === 'quorumGrant:demoted' && e.id > beforeFirstAsk[master] && e.data?.key === key()),
    'the master was never demoted before the re-roll landed').to.equal(false);
    expect(await getAppContainerId(env.clients[master].container, name, name),
      'the re-roll landed under the very same running container').to.equal(container);

    // 3. The record reaches every holder — its own event on each node.
    await Promise.all(HOLDERS.map((i) => env.clients[i].waitForEvent(
      'quorumGrant:generationRecord',
      (d) => d.appName === name && d.role === 'master' && d.generation === 1,
      120000,
      { afterId: beforeReroll[i] },
    )));

    // 4. THE RETIREMENT DRAIN. The old cells refuse the retired generation,
    //    the new cells are draining and answer serving:false, the witnesses
    //    count nobody — and the master COASTS (the drain-aware coast's
    //    generation half, inert under stop-first until this fleet). Nothing
    //    is granted at generation 1 while the chain stands still, and the
    //    container is untouched.
    await env.clients[master].waitForEvent('quorumGrant:coasting', (d) => d.key === key(), 120000, { afterId: beforeReroll[master] });
    await Promise.all(env.clients.map((c) => assertNoEvent(
      c, 'quorumGrant:granted', (d) => d.key === key() && d.generation === 1, 30000,
    )));
    expect(await getAppContainerId(env.clients[master].container, name, name),
      'the container is untouched through the drain').to.equal(container);
    expect(grantsSince(beforeReroll), 'nobody was granted inside the drain').to.deep.equal([]);

    // 5. THE LIFT: the blocks that end the drain are the ones this suite
    //    advances. The master's next pass steps across — probe, prepare,
    //    accept over the NEW committee, carrying the credential — and holds
    //    the new world without its container ever stopping. The renewal that
    //    follows in the same pass already runs under the new committee.
    const beforeLift = env.clients.map((c) => c.getLastEventId());
    await advanceBlocks(DRAIN_BLOCKS);
    await env.clients[master].waitForEvent('quorumGrant:steppedAcross',
      (d) => d.key === key() && d.generation === 1, 180000, { afterId: beforeLift[master] });
    await env.clients[master].waitForEvent('quorumGrant:assess',
      (d) => d.key === key() && d.outcome === 'held' && d.quorumRenewed === true, 60000, { afterId: beforeLift[master] });
    expect(grantsSince(beforeReroll), 'nobody was GRANTED at generation 1: the master stepped across, no standby was seated')
      .to.deep.equal([]);
    await assertNoEvent(env.clients[master], 'quorumGrant:demoted', (d) => d.key === key(), 15000);
    expect(await getAppContainerId(env.clients[master].container, name, name),
      'the very same container across the re-roll').to.equal(container);

    // 6. The new world names the master: a generation-1 quorum on the cells
    //    at a fresh epoch, and the published record on a standby.
    let second = null;
    await waitFor(async () => {
      second = await quorumVerdict(walk.reRolled.quorum);
      return second !== null && second.generation === 1;
    }, { timeout: 60000, interval: 5000, label: 'a generation-1 quorum forms' });
    expect(second.grantee, 'and it names the SAME master').to.equal(first.grantee);
    expect(second.epoch, 'the step-across took a fresh epoch over the new committee').to.be.greaterThan(first.epoch);
    const standby = HOLDERS.find((i) => i !== master);
    await waitFor(async () => {
      const record = await dbClient(standby + 1).getMasterleaseRecord(name, 'master');
      return record?.grantee === first.grantee && record.generation === 1;
    }, { timeout: 90000, interval: 5000, label: 'the published record names the master at generation 1' });

    // 7. The credential was the deciding fact: the master's generation-1
    //    rows sit on the walk's re-rolled committee, and at least two of them
    //    on cells that never held a row for it — cells where only the carried
    //    credential admits a candidate ahead of the empty-seat wait.
    const rows1 = await cellsNaming(first.grantee, 1);
    expect([...rows1].filter((cell) => !walk.reRolled.members.has(cell)),
      `every generation-1 row sits on the walk's re-rolled committee (${describeCells(walk.reRolled.members)})`).to.deep.equal([]);
    expect(rows1.size, 'a quorum of the re-rolled committee holds the master\'s new row').to.be.at.least(walk.reRolled.quorum);
    const freshSeats = [...rows1].filter((cell) => !walk.granting.members.has(cell));
    expect(freshSeats.length,
      `the new term stands on cells that never held a row for the master (shared cells ${walk.shared.length}, quorum ${walk.reRolled.quorum})`)
      .to.be.at.least(2);

    // 8. THE OLD ROWS LAPSE: the retired committee's cells outside the new
    //    one keep their generation-0 row, unrenewed, until its TTL runs out;
    //    nothing rewrites them. And the master still runs the same container.
    const retiredOnly = [...walk.granting.members].filter((cell) => !walk.reRolled.members.has(cell)).map(indexOf);
    expect(retiredOnly.length, 'the retired committee has cells the new one does not').to.be.at.least(1);
    await waitFor(async () => {
      const cells = await Promise.all(retiredOnly.map((i) => readCell(i)));
      return cells.every((cell) => cell?.accepted?.grantee === first.grantee
        && (cell.accepted.generation ?? 0) === 0
        && cell.remainingMs === 0);
    }, { timeout: HELD_TTL_MS + 60000, interval: 10000, label: 'the retired committee\'s own rows lapse, untouched' });
    expect(await getAppContainerId(env.clients[master].container, name, name),
      'still the same container once the old rows have lapsed').to.equal(container);
    const stillUp = await upHolders();
    expect(stillUp, 'exactly one holder runs the app').to.have.lengthOf(1);
    expect(label(stillUp[0]), 'and it is the master that stepped across').to.equal(label(master));
    await assertNoEvent(env.clients[master], 'quorumGrant:demoted', (d) => d.key === key(), 10000);
  });
});
