// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { bootAndPeer, installOnNodes, seedSyncScopedData } from '../framework/reconciler-suite.js';
import { buildSeedableSyncthingApp } from '../framework/seed-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { setSynced } from '../framework/syncthing-control.js';
import { getAppContainerStatus, pauseHostContainer, unpauseHostContainer } from '../framework/container.js';
import { waitFor, waitForAppInstalled, waitForReconcileActuated, assertNoEvent } from '../framework/wait.js';
import { removeFromNodeList, resetNodeList, advanceBlock } from '../framework/daemon-control.js';

// Dark referees: nodes the chain still lists as valid while they answer
// nothing — the confirmation gap means the list stays polluted for hours, and
// the committee walk can only choose from that list. 1203 proves the heal
// replaces ONE dark seat; this suite pins the two boundaries around it:
//
//   FAIL-SAFE FOUNDING — an app founded while MOST of the list is dark can
//   never assemble a quorum, and the gate's answer must be to hold the app
//   DOWN (fail closed), never to run it masterless or grant against thin
//   air. Darkness lifting is what lets it found — nothing else.
//
//   DECONFIRMATION STEERS THE HEAL — when the chain finally drops a dark
//   node (today by slow deconfirmation; the confirmation-gap workstream will
//   make it prompt), the heal's replacement walk reads CURRENT membership,
//   so the reclaimed seat lands on a live node and the removed node holds no
//   cell. This is the assertion the confirmation-gap work will inherit: the
//   faster the list gets honest, the faster this path runs — the mechanism
//   consuming it exists today.
//
// A paused container still accepts the TCP connect and then never answers —
// the truest "dark": present in every list, silent on every ask.

const HOLDERS = [0, 1, 2];
const DARKABLE = [3, 4, 5, 6, 7, 8]; // non-holders that go dark in t1
const SPARE = 9;

describe('dark referees: the list lies, the plane must not', function () {
  let env;
  let name;
  const paused = new Set();

  async function readCell(clientIndex) {
    try {
      const res = await fetch(
        `${env.clients[clientIndex].url}/flux/quorumgrant/record?key=${encodeURIComponent(`${name}/master`)}`,
        { signal: AbortSignal.timeout(5000) },
      );
      const body = await res.json();
      // The RECORD, not just the accepted row: the roster chain rides beside it.
      return body?.data ?? null;
    } catch {
      return null;
    }
  }

  async function runningMasters() {
    const statuses = await Promise.all(env.clients.map(
      (c) => getAppContainerStatus(c.container, name).catch(() => null),
    ));
    return statuses.filter((st) => st && st.status.startsWith('Up')).length;
  }

  async function pause(i) {
    await pauseHostContainer(env.clients[i].container);
    paused.add(i);
  }

  async function unpause(i) {
    await unpauseHostContainer(env.clients[i].container);
    paused.delete(i);
  }

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
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
          quorumGrantDrainMs: 90000,
          quorumGrantMinHolderAgeMs: 0,
          quorumGrantPursuitIntervalMs: 10000,
          quorumGrantUnknownGraceMs: 30000,
          quorumGrantMinFluxOSVersion: '8.13.1',
        },
      },
    });
    await bootAndPeer(env);

    // The fleet is DARK before the app exists: t1 is about founding into it.
    await Promise.all(DARKABLE.map((i) => pause(i)));

    name = `e2edark${Date.now()}`;
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
  });

  after(async function () {
    this.timeout(120000);
    await Promise.all([...paused].map(
      (i) => unpauseHostContainer(env.clients[i].container).catch(() => {}),
    ));
    await resetNodeList().catch(() => {});
    await env?.teardown();
  });

  it('a majority-dark list fails the founding closed; darkness lifting is what founds it', async function () {
    this.timeout(600000);

    // Four live nodes (three holders + the spare) can never reach a quorum of
    // five: no grant may form, and the gate must hold the app DOWN — running
    // it masterless is the split-brain the plane exists to prevent.
    await Promise.all(env.clients.map((c, i) => (paused.has(i) ? Promise.resolve() : assertNoEvent(
      c, 'quorumGrant:granted', (d) => d.key === `${name}/master`, 120000,
    ))));
    expect(await runningMasters(), 'fail closed: nobody runs without a term').to.equal(0);

    // Lift the darkness; the same pursuit machinery founds and seats a master.
    await Promise.all([...DARKABLE].map((i) => unpause(i)));
    await waitFor(async () => (await runningMasters()) === 1, {
      timeout: 300000, interval: 10000, label: 'the grant founds and exactly one master runs',
    });
  });

  it('deconfirmation steers the heal: the reclaimed seat lands on a live listed node', async function () {
    this.timeout(600000);

    // The held term's cells name the committee. Find a NON-HOLDER cell to
    // send dark — a referee seat, not a holder's.
    let verdictGrantee = null;
    await waitFor(async () => {
      const cells = await Promise.all(env.clients.map((_, i) => readCell(i)));
      const live = cells.filter((c) => c?.accepted?.grantee && !c.accepted.released);
      if (live.length < 5) return false;
      verdictGrantee = live[0].accepted.grantee;
      return true;
    }, { timeout: 120000, interval: 5000, label: 'a held term with a live quorum' });

    const outpoints = {};
    for (let i = 0; i < env.clients.length; i += 1) {
      const status = await env.clients[i].getNodeStatus();
      outpoints[i] = `${status.data.txhash}:${status.data.outidx}`;
    }
    const masterIndex = Number(Object.keys(outpoints).find((i) => outpoints[i] === verdictGrantee));
    expect(Number.isInteger(masterIndex), 'the grantee maps to a node').to.equal(true);

    const cells = await Promise.all(env.clients.map((_, i) => readCell(i)));
    const refereeIndex = cells.findIndex(
      (c, i) => !HOLDERS.includes(i) && i !== SPARE && c?.accepted?.grantee === verdictGrantee,
    );
    expect(refereeIndex, 'a non-holder referee cell exists').to.be.greaterThan(-1);

    // Dark AND deconfirmed: pause it, then drop it from the chain's list —
    // the prompt-deconfirmation world the confirmation-gap work builds.
    await pause(refereeIndex);
    await removeFromNodeList(`${env.clients[refereeIndex].ip}:16127`);
    await advanceBlock();

    // THE HEAL ITSELF must run — a single dark seat leaves 8 of 9 cells
    // answering, so a bare quorum count recovers without any heal and proves
    // nothing. The holder announces the heal naming the removed seat; the
    // roster entry's replacement must be a live node the list still carries —
    // never the delisted one, which the walk can no longer see.
    await env.clients[masterIndex].waitForEvent(
      'quorumGrant:healed',
      (d) => d.key === `${name}/master` && d.remove === outpoints[refereeIndex],
      480000,
    );
    let healedEntry = null;
    await waitFor(async () => {
      const now = await Promise.all(env.clients.map((_, i) => readCell(i)));
      const withChain = now.find((cell) => (cell?.roster?.chain ?? [])
        .some((entry) => entry.remove === outpoints[refereeIndex]));
      healedEntry = withChain?.roster?.chain?.find((e) => e.remove === outpoints[refereeIndex]) ?? null;
      return Boolean(healedEntry);
    }, { timeout: 60000, interval: 5000, label: 'the roster chain names the dark seat out' });
    expect(healedEntry.add, 'a replacement was seated').to.not.equal(undefined);
    expect(healedEntry.add, 'the replacement is not the delisted node').to.not.equal(outpoints[refereeIndex]);
    const liveOutpoints = Object.entries(outpoints)
      .filter(([i]) => Number(i) !== refereeIndex)
      .map(([, op]) => op);
    expect(liveOutpoints, 'the replacement is a live listed node').to.include(healedEntry.add);

    expect(await runningMasters(), 'the master never churned').to.equal(1);
  });
});
