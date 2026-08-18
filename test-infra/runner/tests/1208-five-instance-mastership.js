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
import { waitFor, waitForAppInstalled, waitForReconcileActuated, assertNoEvent } from '../framework/wait.js';
import { dbClient } from '../framework/db-client.js';

// The mastership plane beyond the three-instance fixture every other suite
// uses: FIVE holders on a ten-node fleet. Everything N-sensitive changes
// shape at once — the founding scramble has five dueling pursuers instead of
// three (the residue-promise pressure that deposed the 1205 master rises
// with every contender), the witness set and the relay-carrier pool are four
// standbys instead of two, and a dead master leaves four rivals whose
// pursuit jitter must still converge on exactly one successor.
//
// Also the fleet home of the REPAIR chore: a referee whose journal row is
// gone still ANSWERS (no_grant) — a refusal is an answer, so the roster heal
// never replaces it — and before the chore existed such a cell sat out the
// term for the term's whole life, one silently lost seat per incident. Here
// a wiped cell is re-seated at the CURRENT epoch while the master never
// wobbles.
//
// Epoch assertions in this suite are grantee-shaped on purpose: the repair
// chore may legitimately refresh the incumbent's own term to a higher epoch
// (clearing a scramble residue), so "the master never changed" means the
// GRANTEE never changed and the epoch never regressed — a different grantee
// is the only re-fight.

const HOLDERS = [0, 1, 2, 3, 4];
const OUTSIDERS = [5, 6, 7, 8, 9];

describe('the mastership grant with five instances', function () {
  let env;
  let name;
  let holderOutpoints;

  async function readCell(clientIndex) {
    try {
      // a paused node completes the TCP connect and never answers — bound
      // the read; silence is a non-answer the quorum arithmetic tolerates
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
          quorumGrantMinFluxOSVersion: '8.13.1',
        },
      },
    });
    await bootAndPeer(env);

    name = `e2efive${Date.now()}`;
    await pushImage(name, 'v1');
    const app = await buildSeedableSyncthingApp({ name, syncMode: 'activeStandby', instances: 5 });
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

  it('five dueling pursuers seat exactly one master, and the term holds through the scramble\'s residue', async function () {
    this.timeout(600000);

    // Five gates race for the founding grant. The scramble is normal Paxos —
    // what must NOT happen is the 1205 fight: a residue promise left by a
    // losing pursuit deposing the winner on an early renewal pass.
    await Promise.any(HOLDERS.map((i) => env.clients[i].waitForEvent(
      'quorumGrant:granted', (d) => d.key === `${name}/master`, 240000,
    )));
    let first = null;
    await waitFor(async () => {
      first = await quorumVerdict();
      return first !== null;
    }, { timeout: 60000, interval: 5000, label: 'a grant quorum forms' });
    expect(Object.values(holderOutpoints), `grantee ${first.grantee}`).to.include(first.grantee);
    const masterIndex = Number(Object.keys(holderOutpoints).find((i) => holderOutpoints[i] === first.grantee));

    // Hold through several renewal rounds — the window in which a residue
    // used to demote. The grantee must not move; the epoch may only move
    // forward under the same grantee (a repair refresh, never a re-fight).
    await new Promise((resolve) => { setTimeout(resolve, 60000); });
    await assertNoEvent(env.clients[masterIndex], 'quorumGrant:demoted',
      (d) => d.key === `${name}/master`, 5000);
    const during = await quorumVerdict();
    expect(during, 'the quorum view stands').to.not.equal(null);
    expect(during.grantee, 'the master never changed').to.equal(first.grantee);
    expect(during.epoch, 'the epoch never regresses').to.be.at.least(first.epoch);
    expect(await runningMasters(), 'exactly one master among five instances').to.equal(1);
  });

  it('a wiped referee register is repaired back into the term, and the master never wobbles', async function () {
    this.timeout(600000);

    const before = await quorumVerdict();
    expect(before, 'a standing grant before the wipe').to.not.equal(null);
    const masterIndex = Number(Object.keys(holderOutpoints).find((i) => holderOutpoints[i] === before.grantee));

    // A committee referee that is NOT a holder: its cell carries the accepted
    // grant (that is what proves committee membership from the outside), and
    // wiping it perturbs nothing but the plane. Control probe first — prove
    // the instrument SEES the record before its absence means anything.
    let wipedIndex = null;
    for (const i of OUTSIDERS) {
      // eslint-disable-next-line no-await-in-loop -- probing one at a time, first hit wins
      const cell = await readCell(i);
      if (cell && cell.grantee === before.grantee) { wipedIndex = i; break; }
    }
    expect(wipedIndex, 'an outsider committee cell holds the record').to.not.equal(null);

    const wiped = await dbClient(wipedIndex + 1).wipeQuorumGrantRegister(`${name}/master`);
    expect(wiped, 'the wipe removed the row').to.equal(1);
    await waitFor(async () => (await readCell(wipedIndex)) === null, {
      timeout: 30000, interval: 5000, label: 'the cell reads empty after the wipe',
    });

    // The wiped cell answers no_grant to every renewal now. Within a few
    // rounds the repair chore counts it answering-empty and seeds it back at
    // the CURRENT epoch — no lapse, no demotion, no successor.
    await waitFor(async () => {
      const cell = await readCell(wipedIndex);
      return cell !== null && cell.grantee === before.grantee;
    }, { timeout: 240000, interval: 10000, label: 'the repair chore re-seats the wiped cell' });

    const cell = await readCell(wipedIndex);
    const now = await quorumVerdict();
    expect(now, 'the quorum view stands').to.not.equal(null);
    expect(now.grantee, 'the master never changed').to.equal(before.grantee);
    expect(cell.epoch, 'the re-seated cell carries the term the quorum holds').to.equal(now.epoch);
    await assertNoEvent(env.clients[masterIndex], 'quorumGrant:demoted',
      (d) => d.key === `${name}/master`, 10000);
    expect(await runningMasters(), 'exactly one master throughout').to.equal(1);
  });

  it('a dead master among five: one of FOUR rivals wins, exactly one container, no reclaim', async function () {
    this.timeout(900000);

    const first = await quorumVerdict();
    expect(first, 'a standing grant before the failure').to.not.equal(null);
    const masterIndex = Number(Object.keys(holderOutpoints).find((i) => holderOutpoints[i] === first.grantee));
    expect(Number.isInteger(masterIndex), `master ${first.grantee} maps to a node`).to.equal(true);

    const survivors = HOLDERS.filter((i) => i !== masterIndex);
    // after-id discipline: earlier tests leave granted events in since-boot
    // buffers, and an undisciplined wait "finds" a stale win instantly
    const survivorAfters = new Map(survivors.map((i) => [i, env.clients[i].getLastEventId()]));
    await pauseHostContainer(env.clients[masterIndex].container);
    try {
      // Four standbys pursue on jitter once the term lapses; the registers
      // serialize them into exactly one successor at a higher epoch.
      await Promise.any(survivors.map((i) => env.clients[i].waitForEvent(
        'quorumGrant:granted', (d) => d.key === `${name}/master`, 300000, { afterId: survivorAfters.get(i) },
      ))).catch((err) => {
        throw new Error(`no survivor acquired ${name}/master after the master died (${err.errors?.[0]?.message ?? err.message})`);
      });
      let second = null;
      await waitFor(async () => {
        second = await quorumVerdict();
        return second !== null && second.grantee !== first.grantee;
      }, { timeout: 120000, interval: 10000, label: 'a successor holds the grant' });

      expect(second.epoch, 'epochs never move backwards').to.be.greaterThan(first.epoch);
      expect(Object.values(holderOutpoints)).to.include(second.grantee);
      expect(await runningMasters(), 'at most one master container fleet-wide').to.be.at.most(1);
    } finally {
      await unpauseHostContainer(env.clients[masterIndex].container);
    }

    // The corpse returns to a register full of its successor: it adopts,
    // and the fleet settles at exactly one running master.
    await waitFor(async () => (await runningMasters()) === 1, {
      timeout: 240000, interval: 10000, label: 'exactly one master after the corpse returns',
    });
    const settled = await quorumVerdict();
    expect(settled, 'the quorum view stands after the return').to.not.equal(null);
    expect(settled.grantee, 'the corpse did not reclaim').to.not.equal(first.grantee);
  });
});
