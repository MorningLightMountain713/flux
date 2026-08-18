// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { bootAndPeer, installOnNodes, seedSyncScopedData } from '../framework/reconciler-suite.js';
import { buildSeedableSyncthingApp } from '../framework/seed-helper.js';
import { pushImage, pushUpdatedImage } from '../framework/registry-helper.js';
import { setSynced } from '../framework/syncthing-control.js';
import { getAppContainerStatus } from '../framework/container.js';
import {
  waitFor, waitForAppInstalled, waitForReconcileActuated, assertNoEvent,
  waitForImageUpdateRedeployComplete,
} from '../framework/wait.js';
import { authenticate } from '../auth.js';
import { appOwnerKey } from '../framework/keys.js';

// The operator's two verbs against a held mastership, and the routine
// lifecycle operation between them — the three ways an operator or the
// platform touches a master's CONTAINER, each with a stated grant meaning:
//
//   APPSTOP — maintenance. The grant HOLDS: the Holder keeps renewing a
//   term for a stopped container, the standbys rest, and no failover
//   happens behind the operator's back. The app is down because the
//   operator said down. apprestart resumes the same master.
//
//   APPYIELD — failover. The operator stop LOCK lands first, then the
//   grant is voluntarily released, so a standby is seated with no
//   lock-delay; the deposed node's gate is unconsulted (it must never
//   re-acquire its own yield — the first run measured exactly that race)
//   and it returns as a STANDBY on restart.
//
//   SOFT REDEPLOY — neither. An image update recreates the master's
//   container and the grant must never move: a release here would churn
//   mastership fleet-wide on every routine spec/image update.
//
// Intent arrives as a COMMAND in every case: a stopped container cannot
// say which of these it is, and the plane refuses to guess.

const HOLDERS = [0, 1, 2];

describe('operator commands against a held mastership', function () {
  let env;
  let name;
  let holderOutpoints;
  let ownerAuths; // node index -> zelidauth for the app owner

  async function readCell(clientIndex) {
    try {
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

  async function masterIndexOf(verdict) {
    return Number(Object.keys(holderOutpoints).find((i) => holderOutpoints[i] === verdict.grantee));
  }

  async function operatorCommand(nodeIndex, command) {
    const res = await fetch(
      `${env.clients[nodeIndex].url}/apps/${command}/${name}`,
      { headers: { zelidauth: ownerAuths.get(nodeIndex) }, signal: AbortSignal.timeout(15000) },
    );
    const body = await res.json();
    expect(body.status, `${command} on node ${nodeIndex}: ${JSON.stringify(body).slice(0, 200)}`).to.equal('success');
    return body;
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

    name = `e2eyield${Date.now()}`;
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
    ownerAuths = new Map();
    for (const i of HOLDERS) {
      const status = await env.clients[i].getNodeStatus();
      holderOutpoints[i] = `${status.data.txhash}:${status.data.outidx}`;
      ownerAuths.set(i, (await authenticate(env.clients[i].url, appOwnerKey())).zelidauth);
    }
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('appstop is maintenance: the grant holds a full term over a stopped container, and apprestart resumes the same master', async function () {
    this.timeout(600000);

    let first = null;
    await waitFor(async () => {
      first = await quorumVerdict();
      return first !== null;
    }, { timeout: 240000, interval: 10000, label: 'a grant quorum forms' });
    const masterIndex = await masterIndexOf(first);
    expect(Number.isInteger(masterIndex), `master ${first.grantee} maps to a holder`).to.equal(true);
    const standbys = HOLDERS.filter((i) => i !== masterIndex);

    await operatorCommand(masterIndex, 'appstop');
    await waitFor(async () => {
      const status = await getAppContainerStatus(env.clients[masterIndex].container, name).catch(() => null);
      return !status || !status.status.startsWith('Up');
    }, { timeout: 90000, interval: 5000, label: 'the operator stop lands' });

    // A full term with the container down: the Holder keeps renewing, the
    // standbys rest — down because the operator said down is not a failure.
    await Promise.all(standbys.map((i) => assertNoEvent(
      env.clients[i], 'quorumGrant:granted', (d) => d.key === `${name}/master`, 100000,
    )));
    const during = await quorumVerdict();
    expect(during, 'the quorum view stands').to.not.equal(null);
    expect(during.grantee, 'the master never changed').to.equal(first.grantee);
    expect(await runningMasters(), 'nobody runs — the operator said stop').to.equal(0);

    await operatorCommand(masterIndex, 'apprestart');
    await waitFor(async () => (await runningMasters()) === 1, {
      timeout: 180000, interval: 10000, label: 'the same master resumes',
    });
    const resumed = await quorumVerdict();
    expect(resumed.grantee, 'maintenance never moved the term').to.equal(first.grantee);
  });

  it('appyield is failover: the grant releases first, a standby is seated with no lock-delay, and the old master returns as a standby', async function () {
    this.timeout(600000);

    const before = await quorumVerdict();
    expect(before, 'a standing grant before the yield').to.not.equal(null);
    const masterIndex = await masterIndexOf(before);
    const standbys = HOLDERS.filter((i) => i !== masterIndex);
    const standbyAfters = new Map(standbys.map((i) => [i, env.clients[i].getLastEventId()]));

    await operatorCommand(masterIndex, 'appyield');

    // Voluntary release = no lock-delay: a successor should be seated on the
    // standbys' next rest-check cadence, minutes faster than a dead-master
    // failover.
    await Promise.any(standbys.map((i) => env.clients[i].waitForEvent(
      'quorumGrant:granted', (d) => d.key === `${name}/master`, 120000, { afterId: standbyAfters.get(i) },
    ))).catch((err) => {
      throw new Error(`no standby was seated after the yield (${err.errors?.[0]?.message ?? err.message})`);
    });
    let second = null;
    await waitFor(async () => {
      second = await quorumVerdict();
      return second !== null && second.grantee !== before.grantee;
    }, { timeout: 60000, interval: 5000, label: 'the successor holds the quorum view' });
    expect(second.epoch, 'the term moved strictly forward').to.be.greaterThan(before.epoch);
    expect(Object.values(holderOutpoints)).to.include(second.grantee);

    // The deposed node is operator-stopped: its gate is unconsulted, so it
    // cannot re-acquire behind the successor — and its container stays down.
    await assertNoEvent(env.clients[masterIndex], 'quorumGrant:granted',
      (d) => d.key === `${name}/master`, 45000);
    // Bounded, not a single sample: the yield's stop is asynchronous (operator
    // lock, reconciler pass, graceful drain) and the successor seating above is
    // another node's clock — sampling at that instant can catch a healthy stop
    // mid-flight.
    await waitFor(async () => {
      const oldStatus = await getAppContainerStatus(env.clients[masterIndex].container, name).catch(() => null);
      return !oldStatus || !oldStatus.status.startsWith('Up');
    }, { timeout: 90000, interval: 5000, label: 'the yielded master stops' });
    expect(await runningMasters(), 'exactly one master runs').to.equal(1);

    // apprestart returns it as a STANDBY: adopt, never reclaim.
    await operatorCommand(masterIndex, 'apprestart');
    await new Promise((resolve) => { setTimeout(resolve, 60000); });
    const after = await quorumVerdict();
    expect(after.grantee, 'the returning node adopted, never reclaimed').to.equal(second.grantee);
    expect(await runningMasters(), 'still exactly one master').to.equal(1);
  });

  it('a soft redeploy never releases the grant — a routine image update must not churn mastership', async function () {
    this.timeout(600000);

    const before = await quorumVerdict();
    expect(before, 'a standing grant before the redeploy').to.not.equal(null);
    const masterIndex = await masterIndexOf(before);
    const masterAfter = env.clients[masterIndex].getLastEventId();

    await pushUpdatedImage(name, 'v1');
    await waitForImageUpdateRedeployComplete(env.clients[masterIndex], name, 180000);

    const buffered = env.clients[masterIndex].getEventBuffer();
    const demoted = buffered.find((e) => e.event === 'quorumGrant:demoted'
      && e.id > masterAfter && e.data.key === `${name}/master`);
    expect(demoted, 'the redeploy demoted nobody').to.equal(undefined);

    const after = await quorumVerdict();
    expect(after, 'the quorum view stands').to.not.equal(null);
    expect(after.grantee, 'the master never changed').to.equal(before.grantee);
    await waitFor(async () => (await runningMasters()) === 1, {
      timeout: 120000, interval: 10000, label: 'the redeployed master runs',
    });
  });
});
