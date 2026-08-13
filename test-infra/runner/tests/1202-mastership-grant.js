// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer, installOnNodes } from '../framework/reconciler-suite.js';
import { buildSeedableSyncthingApp } from '../framework/seed-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { pauseHostContainer, unpauseHostContainer } from '../framework/container.js';
import { waitFor, waitForAppInstalled } from '../framework/wait.js';

// The held mastership grant on a 10-node fleet — the DECIDED transition
// story (David, 2026-08-13): the grant plane is strictly additive. While
// every holder of an app provably speaks it, the grant names the one
// master and shields it; ANY doubt — a legacy holder, a dead one, a
// partition — resolves identically everywhere to today's behavior, because
// a dead node and a non-speaking node are the same silence and telling
// them apart would be a per-node reachability opinion, the thing this
// plane bans. The cost is deliberate and self-healing: a dead master's
// failover is bridged by the legacy election, the dead node's location row
// ages out, holder unanimity is restored among the survivors, and whoever
// the bridge promoted acquires the grant properly — back under the shield
// with no operator and no reclaim by the returning corpse.
//
// Fleet sizing: 10 nodes at the default peering (nodes >= 2*minOutgoing+1,
// forward and backward ring sets disjoint), the TARGETED install path so
// the register door never gates, and a committee of nine among ten owners
// — quorum 5 — with the app on three nodes. Grant timings are tuned down
// in config (never bypassed in code): term 45s, lock-delay 15s, demotion
// slack 5s below the lock-delay, no holder-age floor.

const HOLDERS = [0, 1, 2];

describe('the mastership grant on a multi-node fleet', function () {
  let env;
  let name;
  let holderOutpoints; // node index -> outpoint string, for the three holders

  async function readCell(clientIndex) {
    try {
      const res = await fetch(
        `${env.clients[clientIndex].url}/flux/quorumgrant/record?key=${encodeURIComponent(`${name}/master`)}`,
      );
      const body = await res.json();
      return body?.data?.accepted ?? null;
    } catch {
      return null;
    }
  }

  // The quorum's view of the term: the (grantee, highest epoch) at least
  // five cells agree on, or null while no quorum agrees.
  async function quorumVerdict() {
    const cells = await Promise.all(env.clients.map((_, i) => readCell(i)));
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

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 10,
      tickerAutostart: false,
      configOverrides: {
        fluxapps: {
          quorumGrantMastership: true,
          quorumGrantHeldTtlMs: 45000,
          quorumGrantRenewIntervalMs: 10000,
          quorumGrantLockDelayMs: 15000,
          quorumGrantDemotionSlackMs: 5000,
          quorumGrantMaxTtlMs: 60000,
          quorumGrantDrainMs: 45000,
          quorumGrantMinHolderAgeMs: 0,
          quorumGrantPursuitIntervalMs: 10000,
          quorumGrantUnknownGraceMs: 30000,
          quorumGrantUnanimityCacheMs: 15000,
        },
      },
    });
    await bootAndPeer(env);

    name = `e2emaster${Date.now()}`;
    await pushImage(name, 'v1');
    const app = await buildSeedableSyncthingApp({ name, mode: 'g' });
    await installOnNodes(env, app, HOLDERS);
    await Promise.all(HOLDERS.map((i) => waitForAppInstalled(env.clients[i], name, 240000)));

    holderOutpoints = {};
    for (const i of HOLDERS) {
      const status = await env.clients[i].getNodeStatus();
      holderOutpoints[i] = `${status.data.collateralHash ?? status.data.txhash}:${status.data.collateralIndex ?? status.data.txindex ?? 0}`;
    }
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('a quorum of register cells names exactly one master, and it is a holder', async function () {
    this.timeout(300000);

    let verdict = null;
    await waitFor(async () => {
      verdict = await quorumVerdict();
      return verdict !== null;
    }, { timeout: 240000, interval: 10000, label: 'a grant quorum forms' });

    expect(Object.values(holderOutpoints), `grantee ${verdict.grantee}`).to.include(verdict.grantee);
    this.test.ctx.first = verdict;
  });

  it('a dead master is bridged, the survivors re-acquire, and the term moves strictly forward', async function () {
    this.timeout(900000);

    const first = await quorumVerdict();
    expect(first, 'a standing grant before the failure').to.not.equal(null);
    const masterIndex = Number(Object.keys(holderOutpoints).find((i) => holderOutpoints[i] === first.grantee));
    expect(Number.isInteger(masterIndex), `master ${first.grantee} maps to a node`).to.equal(true);

    await pauseHostContainer(env.clients[masterIndex].container);
    this.test.ctx.pausedIndex = masterIndex;

    // The decided sequence: term lapses unrenewed, the legacy election
    // bridges the app, the dead node's location row ages out of the
    // survivors' unanimity probe, and the bridge's winner acquires the
    // grant. What the plane must show for it: a NEW grantee at a HIGHER
    // epoch, agreed by a quorum that no longer includes the corpse.
    let second = null;
    await waitFor(async () => {
      second = await quorumVerdict();
      return second !== null && second.grantee !== first.grantee;
    }, { timeout: 720000, interval: 15000, label: 'a successor holds the grant' });

    expect(second.epoch, 'epochs never move backwards').to.be.greaterThan(first.epoch);
    expect(Object.values(holderOutpoints)).to.include(second.grantee);
    this.test.ctx.second = second;
  });

  it('the returning corpse does not reclaim, and the epoch never regresses', async function () {
    this.timeout(300000);

    const { pausedIndex } = this.test.ctx;
    const before = await quorumVerdict();
    await unpauseHostContainer(env.clients[pausedIndex].container);

    // The old master wakes holding a lapsed term and a register full of a
    // successor's epoch: it must adopt, never contest. Hold the assertion
    // through two full terms so a late reclaim cannot hide.
    await new Promise((resolve) => { setTimeout(resolve, 100000); });
    const after = await quorumVerdict();
    expect(after, 'the grant quorum survives the return').to.not.equal(null);
    expect(after.grantee).to.equal(before.grantee);
    expect(after.epoch).to.be.at.least(before.epoch);
  });
});
