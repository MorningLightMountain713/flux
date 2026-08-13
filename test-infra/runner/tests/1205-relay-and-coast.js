// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer, installOnNodes } from '../framework/reconciler-suite.js';
import { buildSeedableSyncthingApp } from '../framework/seed-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { getAppContainerStatus } from '../framework/container.js';
import { waitFor, waitForAppInstalled } from '../framework/wait.js';

// The two rules that keep a master's safety independent of its own network
// path, on a real partitioned fleet:
//
//   RELAY — cut the master off from every non-holder node and its renewals
//   still land: any holder may carry a signed renewal, the envelope is
//   end-to-end, and the standbys can reach the committee. The term never
//   wobbles: same grantee, same epoch, for term after term.
//
//   THE APP ISLAND — cut ALL the holders off from the rest of the fleet.
//   No renewal path exists at all; the witness rule decides between
//   coasting and a clean stop, and its every outcome must satisfy one
//   invariant: AT MOST ONE master container runs, anywhere, at every
//   instant — the standbys cannot acquire (no quorum reachable), and the
//   nodes outside the island hold nothing to promote. On heal, exactly one
//   master stands and the epoch never regressed.
//
// The island assertion is deliberately the union of the safe outcomes
// (coast through, or demote with no successor until heal): the coast
// verdict requires witnesses that are not mid-pursuit, and the consumer
// kicks pursuit even for a settled standby, so which safe outcome occurs
// is timing. The invariant is not.

const HOLDERS = [0, 1, 2];
const OUTSIDERS = [3, 4, 5, 6, 7, 8, 9];

describe('relay renewal and the partitioned app island', function () {
  let env;
  let name;
  let holderOutpoints;

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

  async function runningMasters() {
    const statuses = await Promise.all(env.clients.map(
      (c) => getAppContainerStatus(c.container, name).catch(() => null),
    ));
    return statuses.filter((s) => s && s.status.startsWith('Up')).length;
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

    name = `e2erelay${Date.now()}`;
    await pushImage(name, 'v1');
    const app = await buildSeedableSyncthingApp({ name, mode: 'g' });
    await installOnNodes(env, app, HOLDERS);
    await Promise.all(HOLDERS.map((i) => waitForAppInstalled(env.clients[i], name, 240000)));

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

  it('a master cut off from every non-holder keeps its term through relayed renewals', async function () {
    this.timeout(600000);

    let first = null;
    await waitFor(async () => {
      first = await quorumVerdict();
      return first !== null;
    }, { timeout: 240000, interval: 10000, label: 'a grant quorum forms' });

    const masterIndex = Number(Object.keys(holderOutpoints).find((i) => holderOutpoints[i] === first.grantee));
    expect(Number.isInteger(masterIndex), `master ${first.grantee} maps to a holder`).to.equal(true);

    // The master alone versus every non-holder: its direct committee reach
    // is at most itself and the two standbys — below quorum — so from here
    // on, only renewals CARRIED by the standbys keep the term alive.
    await env.partitionGroups([masterIndex], OUTSIDERS);
    try {
      // Hold through four full terms: a term that lapses anywhere in the
      // window would seat a successor at a higher epoch and fail the check.
      await new Promise((resolve) => { setTimeout(resolve, 180000); });
      const during = await quorumVerdict();
      expect(during, 'the quorum view survives the partition').to.not.equal(null);
      expect(during.grantee, 'the master never changed').to.equal(first.grantee);
      expect(during.epoch, 'the term was renewed, never re-fought').to.equal(first.epoch);
    } finally {
      await env.healPartition([masterIndex], OUTSIDERS);
    }

    await waitFor(async () => (await quorumVerdict()) !== null, {
      timeout: 120000, interval: 10000, label: 'the fleet reconverges after the heal',
    });
  });

  it('the app island keeps at most one master at every instant, and heals to exactly one', async function () {
    this.timeout(900000);

    const before = await quorumVerdict();
    expect(before, 'a standing grant before the island forms').to.not.equal(null);

    // Every holder versus the rest of the fleet: no renewal quorum exists
    // for anyone, no successor can be seated anywhere, and the witness rule
    // decides between coasting and a clean stop. Sample the invariant
    // through three full terms: never two masters.
    await env.partitionGroups(HOLDERS, OUTSIDERS);
    try {
      const deadline = Date.now() + 150000;
      while (Date.now() < deadline) {
        const running = await runningMasters();
        expect(running, 'at most one master container fleet-wide').to.be.at.most(1);
        await new Promise((resolve) => { setTimeout(resolve, 10000); });
      }
    } finally {
      await env.healPartition(HOLDERS, OUTSIDERS);
    }

    // Healed: exactly one master stands — coasted through, or re-seated
    // after the stop — and the epoch never moved backwards.
    let after = null;
    await waitFor(async () => {
      after = await quorumVerdict();
      return after !== null && (await runningMasters()) === 1;
    }, { timeout: 360000, interval: 10000, label: 'exactly one master after the heal' });
    expect(after.epoch).to.be.at.least(before.epoch);
    expect(Object.values(holderOutpoints)).to.include(after.grantee);
  });
});
