// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { bootAndPeer, installOnNodes, seedSyncScopedData } from '../framework/reconciler-suite.js';
import { buildSeedableSyncthingApp } from '../framework/seed-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { setSynced } from '../framework/syncthing-control.js';
import { pauseHostContainer, unpauseHostContainer, getAppContainerStatus } from '../framework/container.js';
import { waitFor, waitForAppInstalled, waitForReconcileActuated } from '../framework/wait.js';

// Two activeStandby apps on the SAME three holders: every other suite runs
// the plane single-tenant, but production nodes referee and hold MANY apps
// at once, sharing the per-key serialized registers, the keep-alive socket
// pool, and the per-peer ask ceiling. What must hold: the two terms are
// fully independent — one app's election, failure, or churn moves nothing
// in the other's — and a dead node fails over exactly the apps it mastered.

const HOLDERS = [0, 1, 2];

describe('two apps share their holders, and their terms never entangle', function () {
  let env;
  let names; // [appA, appB]
  let holderOutpoints;

  async function readCell(appName, clientIndex) {
    try {
      const res = await fetch(
        `${env.clients[clientIndex].url}/flux/quorumgrant/record?key=${encodeURIComponent(`${appName}/master`)}`,
        { signal: AbortSignal.timeout(5000) },
      );
      const body = await res.json();
      return body?.data?.accepted ?? null;
    } catch {
      return null;
    }
  }

  async function quorumVerdict(appName) {
    const cells = await Promise.all(env.clients.map((_, i) => readCell(appName, i)));
    const live = cells.filter((c) => c && c.grantee && !c.released);
    const counts = new Map();
    for (const cell of live) {
      counts.set(cell.grantee, (counts.get(cell.grantee) ?? 0) + 1);
    }
    for (const [grantee, count] of counts.entries()) {
      if (count >= 5) {
        const epoch = Math.max(...live.filter((c) => c.grantee === grantee).map((c) => c.epoch));
        return { grantee, epoch };
      }
    }
    return null;
  }

  async function runningMasters(appName) {
    const statuses = await Promise.all(env.clients.map(
      (c) => getAppContainerStatus(c.container, appName).catch(() => null),
    ));
    return statuses.filter((st) => st && st.status.startsWith('Up')).length;
  }

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 10,
      tickerAutostart: false,
      // The founding photos pin committees at spec anchor heights, which
      // needs the ANCHORED membership history — the ZMQ delta machinery
      // production runs. The harness default is the polling path, whose
      // history carries no chain anchors and can never answer at-height.
      zmqTopics: ALL_ZMQ_TOPICS,
      configOverrides: {
        fluxapps: {
          quorumGrantMastership: true,
          // The term must outlive a full FAILED pass cycle: direct round,
          // relay carriers and the witness poll each burn a whole ask
          // timeout serially under a partition (~35s at the 5s default), and
          // a term shorter than two such cycles lets one bad round demote a
          // master the next round would have renewed. Squeezing the ask
          // timeout instead starves healthy-load tails into the same
          // spurious demotions - so the term carries the compression.
          quorumGrantHeldTtlMs: 90000,
          quorumGrantRenewIntervalMs: 10000,
          quorumGrantLockDelayMs: 15000,
          quorumGrantDemotionSlackMs: 5000,
          quorumGrantMaxTtlMs: 120000,
          quorumGrantDrainMs: 90000,
          quorumGrantMinHolderAgeMs: 0,
          quorumGrantPursuitIntervalMs: 10000,
          quorumGrantUnknownGraceMs: 30000,
          // The plane governs only once the network's enforced floor guarantees
          // every node carries it. The harness pins the requirement to the floor
          // already in force so the gate is live under test; production pins it
          // to the release that actually ships the plane.
          quorumGrantActivationHeight: 2_100_000,
        },
      },
    });
    await bootAndPeer(env);

    const stamp = Date.now();
    names = [`e2etwina${stamp}`, `e2etwinb${stamp}`];
    // eslint-disable-next-line no-restricted-syntax
    for (const name of names) {
      // eslint-disable-next-line no-await-in-loop
      await pushImage(name, 'v1');
      // eslint-disable-next-line no-await-in-loop
      const app = await buildSeedableSyncthingApp({ name, syncMode: 'activeStandby', ports: [31111 + names.indexOf(name) * 10] });
      const installAfters = HOLDERS.map((i) => env.clients[i].getLastEventId());
      // eslint-disable-next-line no-await-in-loop
      await installOnNodes(env, app, HOLDERS);
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(HOLDERS.map((i) => waitForAppInstalled(env.clients[i], name, 240000)));
      // The folder must read fully synced on every holder or the stall ladder
      // eventually removes the app from the standbys; a synced index must be
      // backed by real bytes, written only AFTER each holder's first-run
      // reset (suite 309's ordering, load-bearing on every step).
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(HOLDERS.map(async (i, k) => {
        await waitForReconcileActuated(env.clients[i], `${name}_${name}`, 'dataCleared', 60000, { afterId: installAfters[k] });
        await seedSyncScopedData(env, name, i);
      }));
      // eslint-disable-next-line no-await-in-loop
      await setSynced({ folder: `flux${name}_${name}` });
    }

    holderOutpoints = {};
    for (const i of HOLDERS) {
      const status = await env.clients[i].getNodeStatus();
      holderOutpoints[i] = `${status.data.txhash}:${status.data.outidx}`;
    }
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('both grants form and hold concurrently — shared registers, independent terms', async function () {
    this.timeout(600000);

    const verdicts = {};
    await waitFor(async () => {
      const [a, b] = await Promise.all(names.map((n) => quorumVerdict(n)));
      verdicts[names[0]] = a;
      verdicts[names[1]] = b;
      return a !== null && b !== null;
    }, { timeout: 300000, interval: 10000, label: 'both grant quorums form' });

    // hold through several renewal rounds: neither term may move because
    // the other exists
    await new Promise((resolve) => { setTimeout(resolve, 60000); });
    // eslint-disable-next-line no-restricted-syntax
    for (const name of names) {
      // eslint-disable-next-line no-await-in-loop
      const now = await quorumVerdict(name);
      expect(now, `${name}: the quorum view stands`).to.not.equal(null);
      expect(now.grantee, `${name}: the master never changed`).to.equal(verdicts[name].grantee);
      // eslint-disable-next-line no-await-in-loop
      expect(await runningMasters(name), `${name}: exactly one master`).to.equal(1);
    }
  });

  it('a dead node fails over exactly the apps it mastered', async function () {
    this.timeout(900000);

    const before = {};
    // eslint-disable-next-line no-restricted-syntax
    for (const name of names) {
      // eslint-disable-next-line no-await-in-loop
      before[name] = await quorumVerdict(name);
      expect(before[name], `${name}: a standing grant before the failure`).to.not.equal(null);
    }
    const masterOf = (name) => Number(Object.keys(holderOutpoints)
      .find((i) => holderOutpoints[i] === before[name].grantee));
    const target = masterOf(names[0]);
    const mustFailOver = names.filter((name) => masterOf(name) === target);
    const mustHold = names.filter((name) => masterOf(name) !== target);

    await pauseHostContainer(env.clients[target].container);
    try {
      // every app the dead node mastered gets a successor...
      // eslint-disable-next-line no-restricted-syntax
      for (const name of mustFailOver) {
        let second = null;
        // eslint-disable-next-line no-await-in-loop
        await waitFor(async () => {
          second = await quorumVerdict(name);
          return second !== null && second.grantee !== before[name].grantee;
        }, { timeout: 420000, interval: 10000, label: `${name}: a successor holds the grant` });
        expect(second.epoch, `${name}: epochs never move backwards`).to.be.greaterThan(before[name].epoch);
      }
      // ...and every app it did NOT master never wobbles
      // eslint-disable-next-line no-restricted-syntax
      for (const name of mustHold) {
        // eslint-disable-next-line no-await-in-loop
        const now = await quorumVerdict(name);
        expect(now, `${name}: the quorum view stands`).to.not.equal(null);
        expect(now.grantee, `${name}: an unrelated failure moved this term`).to.equal(before[name].grantee);
      }
    } finally {
      await unpauseHostContainer(env.clients[target].container);
    }

    // the fleet settles at exactly one master per app
    // eslint-disable-next-line no-restricted-syntax
    for (const name of names) {
      // eslint-disable-next-line no-await-in-loop
      await waitFor(async () => (await runningMasters(name)) === 1, {
        timeout: 240000, interval: 10000, label: `${name}: exactly one master after the return`,
      });
    }
  });
});
