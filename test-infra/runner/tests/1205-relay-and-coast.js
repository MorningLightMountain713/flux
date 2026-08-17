// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { bootAndPeer, installOnNodes } from '../framework/reconciler-suite.js';
import { buildSeedableSyncthingApp } from '../framework/seed-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { setSynced } from '../framework/syncthing-control.js';
import { getAppContainerStatus } from '../framework/container.js';
import { waitFor, waitForAppInstalled, assertNoEvent } from '../framework/wait.js';

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
          quorumGrantHeldTtlMs: 45000,
          quorumGrantRenewIntervalMs: 10000,
          quorumGrantLockDelayMs: 15000,
          quorumGrantDemotionSlackMs: 5000,
          quorumGrantMaxTtlMs: 60000,
          quorumGrantDrainMs: 45000,
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
    await installOnNodes(env, app, HOLDERS);
    await Promise.all(HOLDERS.map((i) => waitForAppInstalled(env.clients[i], name, 240000)));
    // Pin the app's folder fully synced on every node's stub view. The stub
    // never moves bytes, and a receive-only standby showing zero ingested
    // bytes beside a peer that holds data walks the stall ladder to LOCAL
    // APP REMOVAL (broadcastRemoval: true), which erases the standby's
    // location row fleet-wide - and with it the witness set, the relay
    // carriers and the spawner's instance count.
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
      expect(during.epoch, 'the term was renewed, never re-fought').to.equal(first.epoch);
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
    expect(after.epoch, 'the coasted term was never re-fought').to.equal(before.epoch);
    expect(await runningMasters()).to.equal(1);
  });
  it('a master cut off from EVERYONE fences itself before any successor starts', async function () {
    this.timeout(900000);

    const before = await quorumVerdict();
    expect(before, 'a standing grant before the isolation').to.not.equal(null);
    const masterIndex = Number(Object.keys(holderOutpoints).find((i) => holderOutpoints[i] === before.grantee));
    const everyoneElse = env.clients.map((_, i) => i).filter((i) => i !== masterIndex);

    // The property the whole plane exists for, and the one the deleted
    // unanimity probe made untestable: with the probe in place BOTH sides
    // stood the plane down here and both ran the legacy election, so this
    // scenario produced two masters and the plane had nothing to say about
    // it. Now the isolated master has no renewal path of any kind - not even
    // a relay, since its standbys are on the other side - so its term lapses
    // and it must take ITSELF down. A successor may only start after that.
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

    await env.partitionGroups([masterIndex], everyoneElse);
    try {
      let masterFenced = false;
      let successor = null;
      const deadline = Date.now() + 300000;
      while (Date.now() < deadline && !(masterFenced && successor)) {
        // A failed LOOK is not evidence the container went away. getAppContainerStatus
        // answers null when the container is definitively absent and throws when the
        // inspection itself could not run; only the first is fencing. Treating the
        // second as fencing would let a transient exec error pass this test.
        let status;
        let looked = true;
        try {
          status = await getAppContainerStatus(env.clients[masterIndex].container, name);
        } catch (error) {
          looked = false;
        }
        if (looked && (!status || !status.status.startsWith('Up'))) masterFenced = true;

        // Sampled at every step, not just at the end: two masters for even one
        // interval is the failure, and a check only at the end would miss it.
        expect(await runningMasters(), 'never two masters, at any instant').to.be.at.most(1);

        const verdict = await quorumVerdict();
        if (verdict && verdict.grantee !== before.grantee) successor = verdict;
        await new Promise((resolve) => { setTimeout(resolve, 5000); });
      }

      expect(masterFenced, 'the isolated master stopped its own container').to.equal(true);
      expect(successor, 'a survivor took the grant').to.not.equal(null);
      expect(successor.epoch, 'the successor holds a strictly later term').to.be.greaterThan(before.epoch);
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
