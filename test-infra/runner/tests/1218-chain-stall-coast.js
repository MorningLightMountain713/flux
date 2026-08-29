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

// A chain stall must coast every master, never demote one. When no node's
// daemon has seen a block past chainStaleAfterMs — a chain halt, a fleet
// upgrade wave — every grantor's view-freshness gate refuses to referee.
// That is committee-down in every way that matters for a takeover: nobody
// can be granted anything. The witness poll must read it exactly that way —
// grantors answer record READS throughout, and a witness that counted a
// read as "quorum reachable" would talk the incumbent out of the coast at
// the one moment the coast is the whole point. So the record read carries
// `refereeing`, witnesses count only refereeing cells, and the master rides
// the stall out running. The chain resuming is what ends the coast: the
// grantors referee again, renewals land, and the term is simply held.
//
// Ten nodes, one shared daemon stub: pausing the stub IS the stall — every
// node's RPC poll fails, every staleness stamp freezes, and the fleet goes
// stale together ~45s later on this suite's compressed clock.

const HOLDERS = [0, 1, 2];

describe('a chain stall coasts every master and demotes none', function () {
  let env;
  let name;
  let outpoints;
  let masterIndex;
  let stubPaused = false;

  async function readCell(clientIndex) {
    try {
      const res = await fetch(
        `${env.clients[clientIndex].url}/flux/quorumgrant/record?key=${encodeURIComponent(`${name}/master`)}`,
        { signal: AbortSignal.timeout(5000) },
      );
      const body = await res.json();
      return body?.data ?? null;
    } catch {
      return null;
    }
  }

  async function quorumVerdict() {
    const cells = await Promise.all(env.clients.map((_, i) => readCell(i)));
    const live = cells.filter((c) => c?.accepted?.grantee && !c.accepted.released);
    const counts = new Map();
    for (const cell of live) {
      counts.set(cell.accepted.grantee, (counts.get(cell.accepted.grantee) ?? 0) + 1);
    }
    for (const [grantee, count] of counts.entries()) {
      if (count >= 5) return { grantee };
    }
    return null;
  }

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 10,
      tickerAutostart: false,
      zmqTopics: ALL_ZMQ_TOPICS,
      configOverrides: {
        daemon: {
          subscriptions: {
            // Production's 300s compressed: the stall must outlive it inside
            // a test, and every grantor reads the SAME node-config value.
            chainStaleAfterMs: 45000,
          },
        },
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
          // Recovery latency after the stall lifts is one poll: the next
          // successful getBlockchainInfo refreshes the staleness stamp.
          daemonInfoIntervalMs: 10000,
        },
      },
    });
    await bootAndPeer(env);

    name = `e2estall${Date.now()}`;
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

    outpoints = {};
    for (let i = 0; i < env.clients.length; i += 1) {
      const status = await env.clients[i].getNodeStatus();
      outpoints[i] = `${status.data.txhash}:${status.data.outidx}`;
    }

    let verdict = null;
    await waitFor(async () => {
      verdict = await quorumVerdict();
      return verdict !== null;
    }, { timeout: 240000, interval: 10000, label: 'a grant quorum forms' });
    masterIndex = Number(Object.keys(outpoints).find((i) => outpoints[i] === verdict.grantee));
    expect(HOLDERS, `master ${verdict.grantee} maps to a holder`).to.include(masterIndex);
  });

  after(async function () {
    this.timeout(120000);
    if (stubPaused) await unpauseHostContainer(env.containers.daemonStub).catch(() => {});
    await env?.teardown();
  });

  it('the stalled fleet refuses to referee, the witnesses read it as committee-down, and the master coasts', async function () {
    this.timeout(600000);

    const coastAfter = env.clients[masterIndex].getLastEventId();
    await pauseHostContainer(env.containers.daemonStub);
    stubPaused = true;

    // Every grantor goes stale together once the frozen stamp ages past the
    // window; from then on held asks are refused, visibly.
    await Promise.any(env.clients.map((c) => c.waitForEvent(
      'quorumGrant:served',
      (d) => d.key === `${name}/master` && d.outcome === 'refusedStale',
      180000,
    )));

    // The coast is the verdict under test: the witnesses see no refereeing
    // quorum anywhere, affirm no takeover is possible, and the master keeps
    // running with its demotion alarm disarmed.
    await env.clients[masterIndex].waitForEvent(
      'quorumGrant:coasting',
      (d) => d.key === `${name}/master`,
      180000,
      { afterId: coastAfter },
    );

    // Longer than a full deadline cycle (ttl 90s + slack 5s): a demotion
    // that was merely late would land inside this window.
    await assertNoEvent(
      env.clients[masterIndex],
      'quorumGrant:demoted',
      (d) => d.key === `${name}/master`,
      120000,
    );
    const status = await getAppContainerStatus(env.clients[masterIndex].container, name);
    expect(status?.status?.startsWith('Up'), 'the master container rode the stall out').to.equal(true);
  });

  it('the chain resuming ends the coast: renewals land again and the term was simply held', async function () {
    this.timeout(300000);

    const resumeAfter = env.clients[masterIndex].getLastEventId();
    await unpauseHostContainer(env.containers.daemonStub);
    stubPaused = false;

    // One poll refreshes the stamp, the next renewal pass reaches a quorum
    // that referees again, and the holder reports itself held.
    await env.clients[masterIndex].waitForEvent(
      'quorumGrant:assess',
      (d) => d.key === `${name}/master` && d.outcome === 'held',
      120000,
      { afterId: resumeAfter },
    );
    await assertNoEvent(
      env.clients[masterIndex],
      'quorumGrant:demoted',
      (d) => d.key === `${name}/master`,
      60000,
    );

    const verdict = await quorumVerdict();
    expect(verdict, 'the grant quorum stands again').to.not.equal(null);
    expect(verdict.grantee, 'the same master holds the term').to.equal(outpoints[masterIndex]);
  });
});
