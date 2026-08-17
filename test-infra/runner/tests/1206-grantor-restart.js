// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { bootAndPeer, installOnNodes, seedSyncScopedData } from '../framework/reconciler-suite.js';
import { buildSeedableSyncthingApp } from '../framework/seed-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { setSynced } from '../framework/syncthing-control.js';
import { restartFluxos, getAppContainerStatus } from '../framework/container.js';
import { waitFor, waitForAppInstalled, assertNoEvent, waitForReconcileActuated } from '../framework/wait.js';

// A grantor that restarts must come back as the SAME grantor: its promises
// were journaled before every reply, so the record survives the process —
// same grantee, same epoch, byte for byte — and for one maximum term after
// boot it refuses to serve new decisions (the rejoin drain) while still
// answering reads, so nothing it might have forgotten can be contradicted.
// The master, meanwhile, must not so much as wobble: eight of nine
// referees renew the term straight through the ninth's absence.

const HOLDERS = [0, 1, 2];

describe('a grantor restarts, and its promises outlive the process', function () {
  let env;
  let name;
  let holderOutpoints;

  async function readCell(clientIndex) {
    try {
      // A restarting node may accept the TCP connect and never answer, so an
      // unbounded read hangs for undici's ~300s default and stalls the whole
      // verdict on one silent node. Silence is a non-answer; the quorum
      // arithmetic already tolerates missing cells.
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
      if (count >= 5) {
        const matching = live.filter((c) => c.accepted.grantee === grantee);
        return { grantee, epoch: Math.max(...matching.map((c) => c.accepted.epoch)) };
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

    name = `e2edrain${Date.now()}`;
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

  it('the restarted referee returns with the identical journaled record, and the term never wobbles', async function () {
    this.timeout(900000);

    let first = null;
    await waitFor(async () => {
      first = await quorumVerdict();
      return first !== null;
    }, { timeout: 240000, interval: 10000, label: 'a grant quorum forms' });

    // A pure referee: its cell answers the key, and it does not hold the
    // app — restarting it touches a ninth of the committee and nothing else.
    const cells = await Promise.all(env.clients.map((_, i) => readCell(i)));
    const refereeIndex = cells.findIndex(
      (cell, i) => !HOLDERS.includes(i) && cell?.accepted?.grantee === first.grantee,
    );
    expect(refereeIndex, 'a non-holder committee member exists').to.be.greaterThan(-1);
    const beforeCell = cells[refereeIndex];

    await restartFluxos(env.clients[refereeIndex].container);

    // The journal outlives the process: the very first read after boot —
    // reads are served even during the drain — answers the same accepted
    // term, same grantee, same epoch. A restart that forgot a promise
    // would answer emptiness here and lie to the next prepare instead.
    let afterCell = null;
    await waitFor(async () => {
      afterCell = await readCell(refereeIndex);
      return afterCell !== null;
    }, { timeout: 120000, interval: 5000, label: 'the restarted referee serves reads' });
    expect(afterCell.accepted?.grantee, 'the journaled grantee survived').to.equal(beforeCell.accepted.grantee);
    expect(afterCell.accepted?.epoch, 'the journaled epoch survived').to.equal(beforeCell.accepted.epoch);
    expect(afterCell.promisedEpoch, 'the journaled promise survived').to.equal(beforeCell.promisedEpoch);

    // Through the drain and past it, the term itself never wobbles: eight
    // referees renew it, no demotion fires on the master, and no epoch
    // bump — which would mean a re-fight — ever appears. Hold through the
    // full drain plus two terms.
    const masterIndex = Number(Object.keys(holderOutpoints).find((i) => holderOutpoints[i] === first.grantee));
    const deadline = Date.now() + 145000;
    while (Date.now() < deadline) {
      const verdict = await quorumVerdict();
      expect(verdict, 'the quorum view holds throughout').to.not.equal(null);
      expect(verdict.grantee, 'the master never changed').to.equal(first.grantee);
      expect(verdict.epoch, 'the term was renewed, never re-fought').to.equal(first.epoch);
      await new Promise((resolve) => { setTimeout(resolve, 15000); });
    }
    await assertNoEvent(env.clients[masterIndex], 'quorumGrant:demoted',
      (d) => d.key === `${name}/master`, 5000);

    // The drained referee rejoins the quorum: after the drain window its
    // cell's expiry advances again — proof it is granting renewals, at the
    // same epoch it journaled before the restart.
    const rejoinBaseline = (await readCell(refereeIndex))?.accepted?.expiresAt;
    await waitFor(async () => {
      const cell = await readCell(refereeIndex);
      return cell?.accepted?.expiresAt && cell.accepted.expiresAt !== rejoinBaseline
        && cell.accepted.epoch === first.epoch;
    }, { timeout: 180000, interval: 10000, label: 'the drained referee grants renewals again' });
  });
  it('the MASTER survives its own FluxOS restart without a second writer', async function () {
    this.timeout(600000);

    const first = await quorumVerdict();
    expect(first, 'a standing grant before the restart').to.not.equal(null);
    const masterIndex = Number(Object.keys(holderOutpoints).find((i) => holderOutpoints[i] === first.grantee));

    // The production case this consumer exists for: a release restarts every
    // node within a few hours, and a six-second FluxOS restart once produced a
    // second writer in-harness. The restart wipes the in-memory holder while
    // the app container keeps running, so the seam must DEFER rather than
    // conclude the grant was lost - stopping a healthy master because its own
    // process rebooted is self-inflicted failover - and re-acquire as the
    // incumbent before the grace runs out.
    //
    // Untestable until the unanimity probe was deleted: a restarting node
    // answers nothing, so its silence used to put the whole app on the legacy
    // path for exactly the window under test.
    // Sampled ACROSS the restart, not after it: the window where a second
    // writer could appear is precisely while the node is down, and a check
    // that begins once it is back would step over the thing being tested.
    // The app container and the inner dockerd are untouched by the restart,
    // so container state stays readable the whole way through.
    let restartError = null;
    const restart = restartFluxos(env.clients[masterIndex].container)
      .catch((error) => { restartError = error; });

    // Through the restart and two full terms after it: the master's container
    // never goes down and no second one ever comes up.
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      // Same rule as the fencing sample: a failed inspection is not evidence the
      // container stopped. Skip the sample rather than fail the run on an exec
      // that could not run - the restart is deliberately shaking this node.
      let status;
      let looked = true;
      try {
        status = await getAppContainerStatus(env.clients[masterIndex].container, name);
      } catch (error) {
        looked = false;
      }
      if (looked) {
        expect(status && status.status.startsWith('Up'), 'the master never stopped its own container').to.equal(true);
        expect(await runningMasters(), 'never two masters, at any instant').to.equal(1);
      }
      await new Promise((resolve) => { setTimeout(resolve, 10000); });
    }

    await restart;
    expect(restartError, `the restart itself failed: ${restartError && restartError.message}`).to.equal(null);

    // And it is still the same master: re-acquired as incumbent, never handed on.
    const after = await quorumVerdict();
    expect(after, 'the quorum view survives the restart').to.not.equal(null);
    expect(after.grantee, 'the incumbent kept the grant').to.equal(first.grantee);
    expect(after.epoch, 'epochs never move backwards').to.be.at.least(first.epoch);
  });

});
