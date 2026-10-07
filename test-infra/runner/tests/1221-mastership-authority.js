// fleet: 16
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
import {
  appSyncthingFolderId,
  componentIdentifier,
  getAppContainerId,
  getAppContainerStatus,
  pauseHostContainer,
  unpauseHostContainer,
} from '../framework/container.js';
import {
  waitFor, waitForAppInstalled, waitForReconcileActuated, assertNoEvent,
} from '../framework/wait.js';
import { advanceBlocks, stopTicker } from '../framework/daemon-control.js';
import { electMaster, resetFdm, getFdmState } from '../framework/fdm-control.js';
import { authenticate } from '../auth.js';
import { postGenerationRecord } from '../framework/generation-record.js';
import { appOwnerKey } from '../framework/keys.js';

import { committeeFor } from '../framework/committee.js';
import { readGrantRecord } from '../framework/grant-record.js';

// FluxOS is the sole mastership authority. Two properties, on a real fleet:
//   1. A re-roll under a running master keeps the app up even when one new
//      committee cell is unreachable at the drain lift — the master steps
//      across on the reachable quorum instead of restarting.
//   2. FDM never decides who the master is for a plane-governed app: a wrong
//      FDM election changes nothing, and the FDM /appips endpoint is never
//      polled for the app at all.

const HOLDERS = [0, 1, 2];
const NODES = 16;
const COMMITTEE_SIZE = 9;
const HELD_TTL_MS = 90000;
const DRAIN_BLOCKS = 3;


// The committee the walk seats for a BUILT app, read from a node: the key
// carries the identity its registration mints, so a candidate name is judged
// only once its app is built.
function committeeOf(nodeUrl, app, generation) {
  return committeeFor(nodeUrl, `${app.identity}/master`, generation);
}

async function chooseFreshCellApp(nodeUrl, stem) {
  for (let i = 0; i < 400; i += 1) {
    const name = `${stem}${i.toString(36)}`;
    // eslint-disable-next-line no-await-in-loop
    const app = await buildSeedableSyncthingApp({ name, syncMode: 'activeStandby', pinnedTo: HOLDERS });
    // eslint-disable-next-line no-await-in-loop
    const [granting, reRolled] = await Promise.all([committeeOf(nodeUrl, app, 0), committeeOf(nodeUrl, app, 1)]);
    const shared = [...granting.members].filter((cell) => reRolled.members.has(cell));
    if (shared.length <= granting.quorum - 2) return { name, app, granting, reRolled };
  }
  throw new Error(`no app name off ${stem} shares at most quorum − 2 cells between generations`);
}

describe('mastership authority: FluxOS keeps the app up and FDM never decides the master', function () {
  let env;
  let name;
  let app;
  let walk;
  let outpoints;
  let ownerAuth0;

  const key = () => `${app.identity}/master`;
  const label = (i) => `node-${env.clients[i].num} (${env.clients[i].ip})`;
  const indexOf = (outpoint) => Number(Object.keys(outpoints).find((i) => outpoints[i] === outpoint));

  const readCell = (i) => readGrantRecord(env.clients[i].url, key());

  async function quorumVerdict(quorum) {
    const cells = await Promise.all(env.clients.map((_, i) => readCell(i)));
    const live = cells.filter((c) => c?.accepted?.grantee && !c.accepted.released && c.remainingMs > 0);
    const counts = new Map();
    for (const cell of live) counts.set(cell.accepted.grantee, (counts.get(cell.accepted.grantee) ?? 0) + 1);
    for (const [grantee, count] of counts.entries()) {
      if (count >= quorum) {
        const rows = live.filter((c) => c.accepted.grantee === grantee);
        return { grantee, generation: Math.max(...rows.map((c) => c.accepted.generation ?? 0)) };
      }
    }
    return null;
  }

  const upHolders = async () => {
    const statuses = await Promise.all(HOLDERS.map((i) => getAppContainerStatus(env.clients[i].container, name).catch(() => null)));
    return HOLDERS.filter((_, k) => statuses[k] && statuses[k].status.startsWith('Up'));
  };

  function submitReroll(generation) {
    return postGenerationRecord(env.clients[0].url, {
      name, identity: app.identity, role: 'master', generation, ownerKey: appOwnerKey(), auth: ownerAuth0,
    });
  }

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      tickerAutostart: false,
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
          quorumGrantGenerationDrainBlocks: DRAIN_BLOCKS,
          quorumGrantActivationHeight: 2_100_000,
        },
      },
    });
    await bootAndPeer(env);
    await stopTicker();
    await resetFdm();
    ownerAuth0 = (await authenticate(env.clients[0].url, appOwnerKey())).zelidauth;

    const listed = await fetch(`${env.clients[0].url}/daemon/viewdeterministicfluxnodelist`, { signal: AbortSignal.timeout(10000) });
    const membership = (await listed.json())?.data;
    expect(membership, 'the deterministic list is the whole fleet').to.have.lengthOf(NODES);
    ({ name, app, ...walk } = await chooseFreshCellApp(env.clients[0].url, `e2eauth${Date.now()}`));

    await pushImage(name, 'v1');
    const installAfters = HOLDERS.map((i) => env.clients[i].getLastEventId());
    await installOnNodes(env, app, HOLDERS);
    await seedGlobalSpec(env, app, env.clients.map((_, i) => i).filter((i) => !HOLDERS.includes(i)));
    await Promise.all(HOLDERS.map((i) => waitForAppInstalled(env.clients[i], name, 240000)));
    await Promise.all(HOLDERS.map(async (i, k) => {
      await waitForReconcileActuated(env.clients[i], componentIdentifier(app), 'dataCleared', 60000, { afterId: installAfters[k] });
      await seedSyncScopedData(env, name, i);
    }));
    await setSynced({ folder: await appSyncthingFolderId(env.clients[HOLDERS[0]], name, name) });

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

  it('a re-roll with one new committee cell unreachable at the drain lift: the master steps across on the reachable quorum, container unchanged', async function () {
    this.timeout(900000);

    let first = null;
    await waitFor(async () => { first = await quorumVerdict(walk.granting.quorum); return first !== null; },
      { timeout: 240000, interval: 10000, label: 'a generation-0 grant quorum forms' });
    expect(first.generation).to.equal(0);
    const master = indexOf(first.grantee);
    expect(HOLDERS, `master ${first.grantee} maps to a holder`).to.include(master);
    const container = await getAppContainerId(env.clients[master].container, name, name);

    // pause one generation-1 committee cell that is neither a holder nor the
    // master — it will be silent to the step-across probe at the drain lift
    const silent = [...walk.reRolled.members].map(indexOf).find((i) => !HOLDERS.includes(i) && i !== master);
    expect(silent, 'the re-rolled committee has a non-holder cell to silence').to.be.a('number');
    const beforeReroll = env.clients.map((c) => c.getLastEventId());
    const rolled = await submitReroll(1);
    expect(rolled.status, `the re-roll lands under the running master: ${rolled.body}`).to.equal(200);
    await Promise.all(HOLDERS.map((i) => env.clients[i].waitForEvent(
      'quorumGrant:generationRecord', (d) => d.identity === app.identity && d.generation === 1, 120000, { afterId: beforeReroll[i] },
    )));

    await pauseHostContainer(env.clients[silent].container);
    try {
      const beforeLift = env.clients.map((c) => c.getLastEventId());
      await advanceBlocks(DRAIN_BLOCKS);
      await env.clients[master].waitForEvent('quorumGrant:steppedAcross',
        (d) => d.key === key() && d.generation === 1, 180000, { afterId: beforeLift[master] });
      await env.clients[master].waitForEvent('quorumGrant:assess',
        (d) => d.key === key() && d.outcome === 'held' && d.quorumRenewed === true, 60000, { afterId: beforeLift[master] });
      await assertNoEvent(env.clients[master], 'quorumGrant:demoted', (d) => d.key === key(), 15000);
      expect(await getAppContainerId(env.clients[master].container, name, name),
        'the same container across the re-roll, despite a silent cell').to.equal(container);
      let second = null;
      await waitFor(async () => { second = await quorumVerdict(walk.reRolled.quorum); return second !== null && second.generation === 1; },
        { timeout: 60000, interval: 5000, label: 'a generation-1 quorum forms on the reachable cells' });
      expect(second.grantee, 'the same master holds the new generation').to.equal(first.grantee);
      const up = await upHolders();
      expect(up, 'exactly one holder runs the app').to.have.lengthOf(1);
      expect(label(up[0])).to.equal(label(master));
    } finally {
      await unpauseHostContainer(env.clients[silent].container);
    }
  });

  it('FDM never decides the master: a wrong FDM election changes nothing, and the app is never polled from FDM', async function () {
    this.timeout(300000);

    const held = await quorumVerdict(walk.reRolled.quorum) ?? await quorumVerdict(walk.granting.quorum);
    expect(held, 'a master is held before the FDM test').to.not.equal(null);
    const master = indexOf(held.grantee);
    const container = await getAppContainerId(env.clients[master].container, name, name);

    // FDM is told, adversarially, that a different node is the primary. FDM is
    // a dumb router; it must not sway FluxOS's election.
    const wrong = HOLDERS.find((i) => i !== master);
    await resetFdm();
    await electMaster(name, env.clients[wrong].ip);

    // let several coordinator cycles pass under the standing plane
    const beforeWindow = env.clients[master].getLastEventId();
    await env.clients[master].waitForEvent('quorumGrant:assess', (d) => d.key === key(), 60000, { afterId: beforeWindow });
    await new Promise((resolve) => { setTimeout(resolve, 40000); });

    const fdm = await getFdmState();
    expect(fdm.queries?.[name] ?? 0, 'the plane-governed app is never polled from FDM').to.equal(0);
    const still = await quorumVerdict(walk.reRolled.quorum) ?? await quorumVerdict(walk.granting.quorum);
    expect(still.grantee, 'the master is unchanged despite FDM naming another node').to.equal(held.grantee);
    await assertNoEvent(env.clients[master], 'quorumGrant:demoted', (d) => d.key === key(), 5000);
    expect(await getAppContainerId(env.clients[master].container, name, name), 'the master\'s container is untouched').to.equal(container);
    const up = await upHolders();
    expect(up, 'exactly one holder runs the app').to.have.lengthOf(1);
    expect(label(up[0]), 'and it is the granted master, not FDM\'s pick').to.equal(label(master));
  });
});
