// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import {
  bootAndPeer, installOnNodes, seedSyncScopedData, redialAndPeer,
} from '../framework/reconciler-suite.js';
import { buildSeedableSyncthingApp } from '../framework/seed-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { setSynced } from '../framework/syncthing-control.js';
import { getAppContainerStatus, getAppContainerId, restartFluxos } from '../framework/container.js';
import { advanceBlocks, stopTicker, getState } from '../framework/daemon-control.js';
import {
  waitFor, waitForAppInstalled, waitForReconcileActuated, assertNoEvent,
} from '../framework/wait.js';

// The moment the plane takes over from the legacy election, on a fleet that is
// already running apps — the one state no other suite covers. 1211 pins the half
// below the activation height; every other 12xx suite pins the half above it. This
// is the crossing itself.
//
// The claim is that the switch is a NO-OP for a healthy app. An app whose master is
// alive keeps that master: the same node, the same container, no stop and no start.
// The plane inherits what the election decided rather than re-deciding it.
//
// How (ACTIVATION_CROSSING_DESIGN.md, stamped 2026-09-02): two heights. The
// referees serve a fresh key from activateAt - preWindowBlocks; the plane governs
// from activateAt. Inside that window only a node whose OWN docker says it runs
// the container asks — no head start, no clock, no opinion about anyone else —
// so the running node holds its lease before the height and at the height the
// standbys read the record and rest. The 45 s head start this replaces was
// measured spending itself against a shut register twice (gate 8, and this
// suite's own red at 75fce434b); the model then showed the patch class was
// bottomless (formal/cold-key-crossing, rows 1–19).
//
// The vacuity trap is sharp here: 'nothing moved' is trivially true if the plane
// never engaged. So the crossing is proved BEFORE the no-op is asserted — a granted
// term naming the incumbent, taken inside the window and before the height, then
// the plane announcing itself on every holder. A run that cannot show both fails
// rather than passing quietly.
//
// The chain is driven by hand. bootAndPeer starts the ticker whatever
// tickerAutostart says (handover 09-02C: both quorum reds were a ticker the suites
// believed off), so it is stopped right after, and every height the suite cares
// about is reached by advanceBlocks from a height it has just read.

const HOLDERS = [0, 1, 2];
const PRE_WINDOW = 40;
// Far enough past the seed height that the setup's own blocks — bootAndPeer's one,
// the install confirm, whatever the ticker managed before it was stopped — stay
// below the window's first block. The suite advances to it by hand.
const ACTIVATION_HEIGHT = 2_100_200;
const OPENS_AT = ACTIVATION_HEIGHT - PRE_WINDOW;
const REFEREE_DRAIN_MS = 90000;

async function bringUpFleet(hookCtx) {
  const env = await createTestEnv({
    hookCtx,
    nodes: 10,
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
        quorumGrantDrainMs: REFEREE_DRAIN_MS,
        quorumGrantMinHolderAgeMs: 0,
        quorumGrantPursuitIntervalMs: 10000,
        // Ahead of the chain's start, so the fleet boots and settles under the
        // legacy election exactly as production does today, and the crossing is
        // something this suite performs rather than something it starts inside.
        quorumGrantActivationHeight: ACTIVATION_HEIGHT,
        quorumGrantPreWindowBlocks: PRE_WINDOW,
      },
    },
  });
  await bootAndPeer(env);
  await stopTicker();

  const name = `e2ecross${Date.now()}`;
  await pushImage(name, 'v1');
  const app = await buildSeedableSyncthingApp({ name, syncMode: 'activeStandby' });
  const installAfters = HOLDERS.map((i) => env.clients[i].getLastEventId());
  await installOnNodes(env, app, HOLDERS);
  await Promise.all(HOLDERS.map((i) => waitForAppInstalled(env.clients[i], name, 240000)));
  await Promise.all(HOLDERS.map(async (i, k) => {
    await waitForReconcileActuated(env.clients[i], `${name}_${name}`, 'dataCleared', 60000, { afterId: installAfters[k] });
    await seedSyncScopedData(env, name, i);
  }));
  await setSynced({ folder: `flux${name}_${name}` });

  const { currentHeight } = await getState();
  expect(currentHeight, 'the setup stayed below the window; the suite opens it by hand')
    .to.be.below(OPENS_AT);
  return { env, name };
}

async function advanceTo(height) {
  const { currentHeight } = await getState();
  expect(currentHeight, `the chain is at most ${height} before advancing to it`).to.be.at.most(height);
  await advanceBlocks(height - currentHeight);
  const { currentHeight: reached } = await getState();
  expect(reached, `the chain reached ${height}`).to.equal(height);
}

function helpers(env, name) {
  const key = `${name}/master`;
  const label = (i) => `node-${env.clients[i].num} (${env.clients[i].ip})`;

  const upHolders = async () => {
    const statuses = await Promise.all(HOLDERS.map(
      (i) => getAppContainerStatus(env.clients[i].container, name).catch(() => null),
    ));
    return HOLDERS.filter((_, k) => statuses[k] && statuses[k].status.startsWith('Up'));
  };

  // The legacy election seats exactly one master, below the window.
  const seatByElection = async () => {
    await waitFor(async () => (await upHolders()).length === 1,
      { timeout: 240000, interval: 10000, label: 'the legacy election seats exactly one master' });
    const [incumbent] = await upHolders();
    // The container ID, not its status string: a restart keeps the name and the
    // 'Up' and takes a new ID, so the ID is the only thing that says the workload
    // was never interrupted.
    const container = await getAppContainerId(env.clients[incumbent].container, name, name);
    expect(container, 'the incumbent has a container to keep').to.be.a('string');
    return { incumbent, container };
  };

  // Who was granted the key since the markers, if anyone — asked of EVERY node so
  // 'granted elsewhere' arrives as an equality failure naming the winner instead
  // of as a silent timeout.
  const grantedSince = (afterIds, timeoutMs) => Promise.any(env.clients.map(
    (c, i) => c.waitForEvent('quorumGrant:granted', (d) => d.key === key, timeoutMs,
      { afterId: afterIds[i] }).then(() => i),
  )).catch(() => null);

  const grantsInBufferSince = (afterIds) => env.clients
    .map((c, i) => ({ i, hits: c.getEventBuffer().filter((e) => e.event === 'quorumGrant:granted' && e.id > afterIds[i] && e.data?.key === key) }))
    .filter(({ hits }) => hits.length)
    .map(({ i }) => label(i));

  const activationsInBufferSince = (afterIds) => env.clients
    .map((c, i) => ({ i, hits: c.getEventBuffer().filter((e) => e.event === 'quorumGrant:planeActivated' && e.id > afterIds[i]) }))
    .filter(({ hits }) => hits.length)
    .map(({ i }) => label(i));

  // Every named cell answers its record read with refereeing: true — the boot
  // sync has completed and the serve gates would take an ask. Asked of the
  // cells themselves, never inferred from time.
  const waitRefereeing = (nodes, timeoutMs) => waitFor(async () => {
    const cells = await Promise.all(nodes.map((i) => readCell(i)));
    return cells.every((cell) => cell?.refereeing === true);
  }, { timeout: timeoutMs, interval: 5000, label: `cells ${nodes.map(label).join(', ')} referee again` });
  const readCell = async (i) => {
    try {
      const res = await fetch(
        `${env.clients[i].url}/flux/quorumgrant/record?key=${encodeURIComponent(key)}`,
        { signal: AbortSignal.timeout(5000) },
      );
      const body = await res.json();
      return body?.data ?? null;
    } catch {
      return null;
    }
  };

  // The crossing proper: cross activateAt, prove the plane engaged on every
  // holder, then the no-op — same holder, same container, nobody else ever ran
  // it, and no second grant anywhere.
  const crossAndAssertNothingMoved = async ({ incumbent, container }) => {
    const afterIds = env.clients.map((c) => c.getLastEventId());
    await advanceTo(ACTIVATION_HEIGHT);

    // Every holder SAW the height. Until that is true no verdict about who holds
    // the term means anything — the plane simply had not started.
    await Promise.all(HOLDERS.map((i) => env.clients[i].waitForEvent(
      'quorumGrant:planeActivated', () => true, 180000, { afterId: afterIds[i] },
    ).catch((error) => {
      throw new Error(`${label(i)} never saw the activation height: ${error.message}`);
    })));

    // A few coordinator and reconciler passes under the governing plane: the
    // standbys read the record and rest; a demotion or a second grant would show
    // here.
    await assertNoEvent(env.clients[incumbent], 'quorumGrant:demoted', (d) => d.key === key, 30000);
    expect(grantsInBufferSince(afterIds), 'no term was granted at the crossing — the key was warm')
      .to.deep.equal([]);

    const stillUp = await upHolders();
    expect(stillUp, 'exactly one holder still runs the app').to.have.lengthOf(1);
    expect(label(stillUp[0]), 'and it is the SAME node the election had seated').to.equal(label(incumbent));
    expect(
      await getAppContainerId(env.clients[incumbent].container, name, name),
      'the very same container - not stopped, not recreated',
    ).to.equal(container);
  };

  return {
    key, label, upHolders, seatByElection, grantedSince, grantsInBufferSince, activationsInBufferSince, readCell, waitRefereeing, crossAndAssertNothingMoved,
  };
}

describe('activation crossing: the running node takes its lease inside the window, and nothing moves at the height', function () {
  let env;
  let name;

  before(async function () {
    this.timeout(900000);
    ({ env, name } = await bringUpFleet(this));
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('the incumbent holds BEFORE the height, alone; at the height its container never restarts', async function () {
    this.timeout(900000);
    const h = helpers(env, name);

    // 1. The legacy election seats exactly one master, below the window.
    const seated = await h.seatByElection();
    const { incumbent } = seated;

    // 2. Below the window the register is shut and nobody asks: no grant anywhere.
    const beforeWindow = env.clients.map((c) => c.getLastEventId());
    expect(await h.grantedSince(beforeWindow, 15000), 'no grant below the window')
      .to.equal(null);

    // 3. Open the window — one block short of it first, then the block itself,
    //    so an off-by-one on either side lands as its own failure.
    await advanceTo(OPENS_AT - 1);
    const shortOfWindow = env.clients.map((c) => c.getLastEventId());
    expect(await h.grantedSince(shortOfWindow, 15000), 'one block short of the window, still no grant')
      .to.equal(null);
    await advanceTo(OPENS_AT);

    // 4. The running node — and only it — takes the lease INSIDE the window. The
    //    wait is on every node, so 'granted elsewhere' names the winner.
    const grantedOn = await h.grantedSince(shortOfWindow, 300000);
    expect(grantedOn, `no node was granted ${h.key} within 300s of the window opening`).to.not.equal(null);
    expect(h.label(grantedOn), 'the lease went to the node running the container').to.equal(h.label(incumbent));
    expect(h.grantsInBufferSince(shortOfWindow), 'and to nobody else').to.deep.equal([h.label(incumbent)]);

    // 5. And the plane has NOT engaged: the height is still below activateAt and
    //    no node announced activation. The seat came from the window, not from a
    //    crossing that happened early.
    const { currentHeight } = await getState();
    expect(currentHeight, 'the lease was taken below the activation height').to.be.below(ACTIVATION_HEIGHT);
    expect(h.activationsInBufferSince(beforeWindow), 'no node announced the plane before the height').to.deep.equal([]);

    // 6. The crossing itself: a no-op.
    await h.crossAndAssertNothingMoved(seated);
  });
});

describe('activation crossing: a referee majority restarting inside the window costs the incumbent nothing at the height', function () {
  let env;
  let name;

  before(async function () {
    this.timeout(900000);
    ({ env, name } = await bringUpFleet(this));
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('the lapsed lease is re-acquired at the taught time, the container is never stopped, and nothing moves at the height', async function () {
    this.timeout(1200000);
    const h = helpers(env, name);

    // 1. Seat by election, open the window, let the incumbent take its lease.
    const seated = await h.seatByElection();
    const { incumbent, container } = seated;
    await advanceTo(OPENS_AT);
    const windowOpen = env.clients.map((c) => c.getLastEventId());
    const grantedOn = await h.grantedSince(windowOpen, 300000);
    expect(grantedOn !== null && h.label(grantedOn), 'the incumbent holds inside the window').to.equal(h.label(incumbent));

    // 2. A referee majority restarts inside the window — an update wave. The
    //    committee is read off the cells: a non-holder whose register names the
    //    incumbent is a pure referee; five of them are a majority of nine.
    const cells = await Promise.all(env.clients.map((_, i) => h.readCell(i)));
    const status = await env.clients[incumbent].getNodeStatus();
    const incumbentOutpoint = `${status.data.txhash}:${status.data.outidx}`;
    const referees = cells
      .map((cell, i) => ({ cell, i }))
      .filter(({ cell, i }) => !HOLDERS.includes(i) && cell?.accepted?.grantee === incumbentOutpoint)
      .map(({ i }) => i);
    expect(referees.length, 'at least five non-holder referees exist').to.be.at.least(5);
    const restarting = referees.slice(0, 5);

    const preRestart = env.clients.map((c) => c.getLastEventId());
    await Promise.all(restarting.map((i) => restartFluxos(env.clients[i].container)));
    await redialAndPeer(env, restarting, preRestart);
    // A restarted node's app-state sync starts on its FIRST processed block (the
    // orchestrator holds INITIALIZING until the chain feed proves itself), and
    // this suite drives the chain by hand — so give the returning cells one
    // block, far below the height, and wait until each referees again. Without
    // it they answer 'not refereeing' for ever, the witnesses count nobody, and
    // the incumbent COASTS instead of lapsing (the first run at 24582fb1f: five
    // cells stuck at 'app-state sync incomplete' for the whole 240 s).
    await advanceTo((await getState()).currentHeight + 1);
    await h.waitRefereeing(restarting, 180000);

    // 3. The incumbent cannot renew against four cells and its lease lapses —
    //    the demotion fires. Below the height that is a re-acquire, NEVER a
    //    docker stop: the very same container is still up right after it.
    await env.clients[incumbent].waitForEvent('quorumGrant:demoted', (d) => d.key === h.key, 240000, { afterId: preRestart[incumbent] });
    const afterDemotion = env.clients.map((c) => c.getLastEventId());
    const statusAfterDemotion = await getAppContainerStatus(env.clients[incumbent].container, name);
    expect(statusAfterDemotion?.status, 'the container is still up after the demotion').to.match(/^Up/);
    expect(await getAppContainerId(env.clients[incumbent].container, name, name),
      'the same container — the plane governs nothing below the height').to.equal(container);

    // 4. The returning referees refuse inside their drain and TEACH the figure;
    //    the incumbent retries at it and seats again once a quorum is open. The
    //    budget is the drain plus one ask round plus the retry's own slack;
    //    nobody else is granted meanwhile.
    const regrantedOn = await h.grantedSince(afterDemotion, REFEREE_DRAIN_MS + 120000);
    expect(regrantedOn !== null && h.label(regrantedOn), 'the incumbent re-acquired its lease inside the window')
      .to.equal(h.label(incumbent));
    expect(h.grantsInBufferSince(afterDemotion), 'and nobody else was granted').to.deep.equal([h.label(incumbent)]);
    expect(await getAppContainerId(env.clients[incumbent].container, name, name),
      'still the same container').to.equal(container);
    const { currentHeight } = await getState();
    expect(currentHeight, 'all of it below the activation height').to.be.below(ACTIVATION_HEIGHT);

    // 5. The crossing itself: a no-op, restart wave and all.
    await h.crossAndAssertNothingMoved(seated);
  });
});
