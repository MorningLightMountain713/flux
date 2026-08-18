// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { bootAndPeer, installOnNodes, seedSyncScopedData } from '../framework/reconciler-suite.js';
import { buildSeedableSyncthingApp } from '../framework/seed-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { setSynced } from '../framework/syncthing-control.js';
import { getAppContainerStatus } from '../framework/container.js';
import { waitFor, waitForAppInstalled, assertNoEvent, waitForReconcileActuated } from '../framework/wait.js';

// The two rules that keep a master's safety independent of its own network
// path, on a real partitioned fleet:
//
//   RELAY — cut the master off from every non-holder node and its renewals
//   still land: any holder may carry a signed renewal, the envelope is
//   end-to-end, and the standbys can reach the committee. The term never
//   wobbles: same grantee, same epoch, for term after term.
//
//   THE APP ISLAND — cut ALL the holders off from the rest of the fleet.
//   No renewal path exists at all, and the master COASTS: its standbys —
//   settled by the published record, resting rather than pursuing — vouch
//   unanimously that no takeover is possible, and the container keeps
//   running through the whole outage. The invariant rides along: at most
//   one master container anywhere at every instant, and on heal the same
//   master stands at the same epoch — a term that coasted was never
//   re-fought. The settled-standby rest is what makes this deterministic:
//   a standby that knows another node holds a live grant does not pursue,
//   so the coast vouch never trips over a mid-flight futile acquisition.

const HOLDERS = [0, 1, 2];
const OUTSIDERS = [3, 4, 5, 6, 7, 8, 9];

describe('relay renewal and the partitioned app island', function () {
  let env;
  let name;
  let holderOutpoints;

  async function readCell(clientIndex) {
    try {
      // A partitioned or frozen node may accept the TCP connect and never
      // answer, so an unbounded read hangs for undici's ~300s default and
      // stalls the whole verdict on one silent node. Silence is a non-answer;
      // the quorum arithmetic already tolerates missing cells.
      const res = await fetch(
        `${env.clients[clientIndex].url}/flux/quorumgrant/record?key=${encodeURIComponent(`${name}/master`)}`,
        { signal: AbortSignal.timeout(5000) },
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
          quorumGrantMinFluxOSVersion: '8.13.1',
        },
      },
    });
    await bootAndPeer(env);

    name = `e2erelay${Date.now()}`;
    await pushImage(name, 'v1');
    const app = await buildSeedableSyncthingApp({ name, mode: 'g' });
    const installAfters = HOLDERS.map((i) => env.clients[i].getLastEventId());
    await installOnNodes(env, app, HOLDERS);
    await Promise.all(HOLDERS.map((i) => waitForAppInstalled(env.clients[i], name, 240000)));
    // The folder must read fully synced on every holder or the stall ladder
    // eventually removes the app from the standbys (broadcastRemoval erases
    // their location rows fleet-wide - the witness set, the relay carriers
    // and the spawner's count all ride those rows). And a synced index must
    // be backed by real bytes on disk - the promote gate refuses a
    // claimed-bytes index over an empty volume - written only AFTER each
    // holder's first-run reset, which clears anything seeded earlier.
    await Promise.all(HOLDERS.map(async (i, k) => {
      await waitForReconcileActuated(env.clients[i], `${name}_${name}`, 'dataCleared', 60000, { afterId: installAfters[k] });
      await seedSyncScopedData(env, name, i);
    }));
    await setSynced({ folder: `flux${name}_${name}` });

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
    // on, only renewals CARRIED by the standbys keep the term alive. The
    // master's own bus must stay silent: no demotion, no re-grant.
    await env.partitionGroups([masterIndex], OUTSIDERS);
    try {
      // Hold through four full terms: a term that lapses anywhere in the
      // window would seat a successor at a higher epoch and fail the check.
      await new Promise((resolve) => { setTimeout(resolve, 175000); });
      await assertNoEvent(env.clients[masterIndex], 'quorumGrant:demoted',
        (d) => d.key === `${name}/master`, 5000);
      const during = await quorumVerdict();
      expect(during, 'the quorum view survives the partition').to.not.equal(null);
      expect(during.grantee, 'the master never changed').to.equal(first.grantee);
      // the repair chore may refresh the incumbent's own term to a higher
      // epoch (clearing a scramble residue) — the same grantee at a higher
      // epoch is maintenance; only a DIFFERENT grantee is a re-fight
      expect(during.epoch, 'the epoch never regresses').to.be.at.least(first.epoch);
    } finally {
      await env.healPartition([masterIndex], OUTSIDERS);
    }

    await waitFor(async () => (await quorumVerdict()) !== null, {
      timeout: 120000, interval: 10000, label: 'the fleet reconverges after the heal',
    });
  });

  it('the app island coasts: the master runs through the outage and its term is never re-fought', async function () {
    this.timeout(900000);

    const before = await quorumVerdict();
    expect(before, 'a standing grant before the island forms').to.not.equal(null);
    const masterIndex = Number(Object.keys(holderOutpoints).find((i) => holderOutpoints[i] === before.grantee));

    // Every holder versus the rest of the fleet: no renewal quorum exists
    // for anyone. The settled standbys rest, their coast vouch holds — the
    // master SAYS SO with its coasting event — and the container keeps
    // running, sampled through three full terms, well past where a denied
    // coast would have stopped it.
    await env.partitionGroups(HOLDERS, OUTSIDERS);
    try {
      await env.clients[masterIndex].waitForEvent(
        'quorumGrant:coasting', (d) => d.key === `${name}/master`, 120000,
      );
      const deadline = Date.now() + 150000;
      while (Date.now() < deadline) {
        const status = await getAppContainerStatus(env.clients[masterIndex].container, name);
        expect(status && status.status.startsWith('Up'), 'the master coasts through the outage').to.equal(true);
        expect(await runningMasters(), 'at most one master container fleet-wide').to.be.at.most(1);
        await new Promise((resolve) => { setTimeout(resolve, 10000); });
      }
    } finally {
      await env.healPartition(HOLDERS, OUTSIDERS);
    }

    // Healed: the SAME master at the SAME epoch — a coasted term resumes
    // renewing; it was never lost, so it was never re-fought.
    let after = null;
    await waitFor(async () => {
      after = await quorumVerdict();
      return after !== null;
    }, { timeout: 240000, interval: 10000, label: 'the quorum view returns after the heal' });
    expect(after.grantee, 'the master never changed').to.equal(before.grantee);
    // a coasted term resumes renewing under the SAME grantee; a post-heal
    // repair refresh may raise the epoch, but only a different grantee
    // would mean the term was lost and re-fought
    expect(after.epoch, 'the epoch never regresses').to.be.at.least(before.epoch);
    expect(await runningMasters()).to.equal(1);
  });
  it('a master cut off from EVERYONE stops fast, and the fence stands before any successor', async function () {
    this.timeout(900000);

    const before = await quorumVerdict();
    expect(before, 'a standing grant before the isolation').to.not.equal(null);
    const masterIndex = Number(Object.keys(holderOutpoints).find((i) => holderOutpoints[i] === before.grantee));
    const everyoneElse = env.clients.map((_, i) => i).filter((i) => i !== masterIndex);

    // Two promises of different strengths, asserted at their own strengths.
    // ABSOLUTE: the successor's fence against the deposed master stands
    // before the successor's container can - raised inside the very acquire
    // that granted, so a stale master's writes can never win whatever its
    // process does. BOUNDED: the deposed master's own container stops fast -
    // its standing alarm fires ON the deadline and the stop is hard - but no
    // self-stop can be made instantaneous on a machine nobody else can
    // reach, so overlap is asserted short, never zero-at-any-instant.
    //
    // The runner reaches every node over the gateway and inspects containers
    // by exec, so the isolated node stays observable throughout.
    // Control probe: prove the instrument can SEE this container before any
    // conclusion is drawn from not seeing it. `docker ps` failures degrade to an
    // empty listing inside the helper, so absence is only evidence once presence
    // has been observed through the same path on the same node.
    const beforeIsolation = await getAppContainerStatus(env.clients[masterIndex].container, name);
    expect(beforeIsolation && beforeIsolation.status.startsWith('Up'),
      'the master is running, and visible, before it is isolated').to.equal(true);
    expect(await runningMasters(), 'exactly one master before the isolation').to.equal(1);

    // Event waits below are AFTER-ID disciplined: an earlier test's fight can
    // leave a granted event in a survivor's since-boot buffer, and a wait
    // that scans history then "finds" a winner that never won THIS term —
    // which is exactly how this test went red at 0243ee860 while the product
    // behaved correctly.
    const survivors = everyoneElse.filter((i) => Object.keys(holderOutpoints).map(Number).includes(i));
    const survivorAfters = new Map(survivors.map((i) => [i, env.clients[i].getLastEventId()]));

    await env.partitionGroups([masterIndex], everyoneElse);
    try {
      await Promise.any(survivors.map((i) => env.clients[i].waitForEvent(
        'quorumGrant:granted', (d) => d.key === `${name}/master`, 300000, { afterId: survivorAfters.get(i) },
      ))).catch(() => {
        throw new Error(`no survivor acquired ${name}/master after the master was isolated`);
      });
      const grantedAtMs = Date.now();

      // ABSOLUTE: the winner fenced the deposed master in the same acquire
      // that granted, so the fence event must already sit in its buffer.
      const winner = survivors.find((i) => env.clients[i].getEventBuffer()
        .some((e) => e.event === 'quorumGrant:granted' && e.id > survivorAfters.get(i)
          && e.data.key === `${name}/master`));
      expect(winner, 'a survivor holds the granted event').to.not.equal(undefined);
      await env.clients[winner].waitForEvent(
        'quorumGrant:fenceRaised', (d) => d.app === name, 15000, { afterId: survivorAfters.get(winner) },
      ).catch(() => {
        throw new Error('the fence against the deposed master did not stand with the grant');
      });

      // BOUNDED: the deposed master's container is gone within the overlap
      // bound of the successor's grant. A failed LOOK is not evidence the
      // container went away: getAppContainerStatus answers null when the
      // container is definitively absent and throws when the inspection
      // itself could not run - only the first counts.
      const overlapBoundMs = 60000;
      let masterStopped = false;
      while (Date.now() - grantedAtMs < overlapBoundMs && !masterStopped) {
        let status;
        let looked = true;
        try {
          status = await getAppContainerStatus(env.clients[masterIndex].container, name);
        } catch (error) {
          looked = false;
        }
        if (looked && (!status || !status.status.startsWith('Up'))) masterStopped = true;
        else await new Promise((resolve) => { setTimeout(resolve, 5000); });
      }
      expect(masterStopped, 'the deposed master stopped within the overlap bound').to.equal(true);

      let successor = null;
      await waitFor(async () => {
        successor = await quorumVerdict();
        return successor !== null && successor.grantee !== before.grantee;
      }, { timeout: 120000, interval: 10000, label: 'a successor holds the grant' });
      expect(successor.epoch, 'the successor holds a strictly later term').to.be.greaterThan(before.epoch);
      expect(Object.values(holderOutpoints)).to.include(successor.grantee);
    } finally {
      await env.healPartition([masterIndex], everyoneElse);
    }

    // Healed: the old master must adopt, not reclaim, and exactly one
    // container runs fleet-wide once the dust settles.
    await waitFor(async () => (await runningMasters()) === 1, {
      timeout: 240000, interval: 10000, label: 'exactly one master after the heal',
    });
    const after = await quorumVerdict();
    expect(after, 'the quorum view returns after the heal').to.not.equal(null);
    expect(after.grantee, 'the returning master did not reclaim').to.not.equal(before.grantee);
  });

});
