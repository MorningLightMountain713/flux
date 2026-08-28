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

// The held mastership grant on a 10-node fleet, governing on its own.
//
// The plane never runs beside the legacy election - two elections over one
// app is the split brain it exists to prevent - and what guarantees that is
// SEQUENCING, not detection: the code ships everywhere inert, the network's
// enforced version floor rises to the release carrying it, and only then
// does the flag mean anything. So there is no runtime probe of who speaks
// the plane, and nothing stands the plane down when a node goes quiet.
//
// Which makes a dead master the plane's own problem, and this suite pins
// that: the term simply stops being renewed, a standby takes it at a higher
// epoch, and at no instant do two masters run. No bridge, no fallback, no
// waiting on a holder's row to age out of a probe that no longer exists.
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
  let pausedIndex;

  async function readCell(clientIndex) {
    try {
      // A paused node still accepts the TCP connect and then never answers, so
      // an unbounded read hangs for undici's ~300s default and stalls the whole
      // verdict on one frozen node. Silence is a non-answer; the quorum
      // arithmetic already tolerates missing cells.
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

  // The safety property the plane exists for: never two writers. Standbys of a
  // g: app run no container, so a healthy fleet reads exactly one.
  async function runningMasters() {
    const statuses = await Promise.all(env.clients.map(
      (c) => getAppContainerStatus(c.container, name).catch(() => null),
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
          // The plane governs only once the network's enforced floor guarantees
          // every node carries it. The harness pins the requirement to the floor
          // already in force so the gate is live under test; production pins it
          // to the release that actually ships the plane.
          quorumGrantActivationHeight: 2_100_000,
        },
      },
    });
    await bootAndPeer(env);

    name = `e2emaster${Date.now()}`;
    await pushImage(name, 'v1');
    const app = await buildSeedableSyncthingApp({ name, syncMode: 'activeStandby' });
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

  it('a quorum of register cells names exactly one master, and it is a holder', async function () {
    this.timeout(300000);

    // The grant plane says when; the registers say what. One holder wins
    // the race and publishes the granted event; the quorum view then reads
    // back the term it seated.
    await Promise.any(HOLDERS.map((i) => env.clients[i].waitForEvent(
      'quorumGrant:granted', (d) => d.key === `${name}/master`, 240000,
    )));
    let verdict = null;
    await waitFor(async () => {
      verdict = await quorumVerdict();
      return verdict !== null;
    }, { timeout: 60000, interval: 5000, label: 'a grant quorum forms' });

    expect(Object.values(holderOutpoints), `grantee ${verdict.grantee}`).to.include(verdict.grantee);
  });

  it('a standby going quiet is a non-event, and the term does not move', async function () {
    this.timeout(300000);

    const before = await quorumVerdict();
    expect(before, 'a standing grant before the silence').to.not.equal(null);
    const masterIndex = Number(Object.keys(holderOutpoints).find((i) => holderOutpoints[i] === before.grantee));
    const standby = HOLDERS.find((i) => i !== masterIndex);

    // One holder stops answering anything. Under the deleted unanimity probe
    // this single silence put the WHOLE app back on the legacy election, on
    // every node at once. Now it is one absent standby and nothing else: the
    // master renews through it, the term does not move, and the app runs on.
    await pauseHostContainer(env.clients[standby].container);
    try {
      await new Promise((resolve) => { setTimeout(resolve, 100000); });
      const after = await quorumVerdict();
      expect(after, 'the quorum view survives a silent standby').to.not.equal(null);
      expect(after.grantee, 'the master never changed').to.equal(before.grantee);
      // the repair chore may refresh the incumbent's own term to a higher
      // epoch (clearing a founding-scramble residue) — same grantee, higher
      // epoch is maintenance; only a different grantee is a re-fight
      expect(after.epoch, 'the epoch never regresses').to.be.at.least(before.epoch);
      expect(await runningMasters(), 'the master kept running').to.equal(1);
    } finally {
      await unpauseHostContainer(env.clients[standby].container);
    }
  });

  it('a dead master is failed over by the plane itself, and the term moves strictly forward', async function () {
    // Sized to the plane's own clocks now - term, record expiry, lock delay,
    // jitter - not to the holder location TTL the deleted probe waited on.
    this.timeout(600000);

    const first = await quorumVerdict();
    expect(first, 'a standing grant before the failure').to.not.equal(null);
    const masterIndex = Number(Object.keys(holderOutpoints).find((i) => holderOutpoints[i] === first.grantee));
    expect(Number.isInteger(masterIndex), `master ${first.grantee} maps to a node`).to.equal(true);

    const survivors = HOLDERS.filter((i) => i !== masterIndex);
    // after-id discipline: a scramble in an earlier test can leave a granted
    // event in a survivor's since-boot buffer, and an undisciplined wait
    // would "find" that stale win instantly
    const survivorAfters = new Map(survivors.map((i) => [i, env.clients[i].getLastEventId()]));
    await pauseHostContainer(env.clients[masterIndex].container);
    pausedIndex = masterIndex;

    // Nothing bridges this. The term lapses unrenewed, the dead master's
    // published record stops being republished and expires, the settled
    // standbys stop resting and pursue, and one of them takes the grant at
    // a higher epoch - announced by its own granted event, then read back
    // from a quorum of registers that no longer includes the corpse.
    //
    // Budget: term (45s) + the record's own expiry and sweep + lock delay
    // (15s) + pursuit jitter, with room to spare. It no longer waits on the
    // holder's location row, which is what made this minutes long before.
    await Promise.any(survivors.map((i) => env.clients[i].waitForEvent(
      'quorumGrant:granted', (d) => d.key === `${name}/master`, 300000, { afterId: survivorAfters.get(i) },
    ))).catch(() => {
      throw new Error(
        `no survivor acquired ${name}/master after the master died - with no `
        + 'legacy election to bridge it, the plane is the only thing that can '
        + 'fail this app over',
      );
    });
    let second = null;
    await waitFor(async () => {
      second = await quorumVerdict();
      return second !== null && second.grantee !== first.grantee;
    }, { timeout: 120000, interval: 10000, label: 'a successor holds the grant' });

    expect(second.epoch, 'epochs never move backwards').to.be.greaterThan(first.epoch);
    expect(Object.values(holderOutpoints)).to.include(second.grantee);
    expect(await runningMasters(), 'at most one master container fleet-wide').to.be.at.most(1);
  });

  it('the returning corpse does not reclaim, and the epoch never regresses', async function () {
    this.timeout(300000);

    const before = await quorumVerdict();
    await unpauseHostContainer(env.clients[pausedIndex].container);

    // The old master wakes holding a lapsed term and a register full of a
    // successor's epoch: it must adopt, never contest - and with no legacy
    // election running underneath, adopting is the only thing that can stop
    // it starting its container again. Hold through two full terms so a late
    // reclaim cannot hide.
    await new Promise((resolve) => { setTimeout(resolve, 100000); });
    const after = await quorumVerdict();
    expect(after, 'the grant quorum survives the return').to.not.equal(null);
    expect(after.grantee).to.equal(before.grantee);
    expect(after.epoch).to.be.at.least(before.epoch);
    expect(await runningMasters(), 'the corpse did not start a second master').to.equal(1);
  });
});
