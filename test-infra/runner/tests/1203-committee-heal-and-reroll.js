// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { bootAndPeer, installOnNodes, seedGlobalSpec, seedSyncScopedData } from '../framework/reconciler-suite.js';
import { buildSeedableSyncthingApp } from '../framework/seed-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { setSynced } from '../framework/syncthing-control.js';
import { pauseHostContainer, unpauseHostContainer } from '../framework/container.js';
import { waitFor, waitForAppInstalled, waitForReconcileActuated, assertNoEvent } from '../framework/wait.js';
import { dbClient } from '../framework/db-client.js';
import { getState, advanceBlock, stopTicker, startTicker } from '../framework/daemon-control.js';
import { authenticate, signBtcMessage } from '../auth.js';
import { appOwnerKey } from '../framework/keys.js';

// Tier one and tier two against a real fleet. A referee that answers
// nobody for a full term is voted off by the committee itself: the holder
// proposes remove-dark-add-next-in-walk, a quorum of grantors signs, the
// roster chain rides the published record, and the freshly seated
// replacement answers for a grant its own register never heard of. And
// when the OWNER re-rolls a stopped app's generation, the whole committee
// re-deals from a salted walk: the old world's grantors refuse teaching the
// new number, and the restarted instances take generation 1 through its
// drain. Ten nodes: committee nine of ten, so the walk has a
// spare seat to promote — the smallest fleet where a heal has somewhere
// to go.

const HOLDERS = [0, 1, 2];

describe('the committee heals its dark seat, and the owner re-deals the walk', function () {
  let env;
  let name;
  let outpoints; // node index -> outpoint, all ten
  let ownerAuth0;
  let refereeIndex;
  let addedIndex; // the healed replacement seat, found by test 1

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
        return {
          grantee,
          epoch: Math.max(...matching.map((c) => c.accepted.epoch)),
          generation: Math.max(...matching.map((c) => c.accepted.generation ?? 0)),
        };
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
          // Small but real: the re-roll test asserts the retirement drain
          // HOLDS while blocks stand still and lifts when they pass — a
          // zero here would turn the only re-roll suite into one that never
          // exercises the drain at all.
          quorumGrantGenerationDrainBlocks: 3,
          // The plane governs only once the network's enforced floor guarantees
          // every node carries it. The harness pins the requirement to the floor
          // already in force so the gate is live under test; production pins it
          // to the release that actually ships the plane.
          quorumGrantActivationHeight: 2_100_000,
        },
      },
    });
    await bootAndPeer(env);
    ownerAuth0 = (await authenticate(env.clients[0].url, appOwnerKey())).zelidauth;

    name = `e2eheal${Date.now()}`;
    await pushImage(name, 'v1');
    const app = await buildSeedableSyncthingApp({ name, syncMode: 'activeStandby' });
    const installAfters = HOLDERS.map((i) => env.clients[i].getLastEventId());
    await installOnNodes(env, app, HOLDERS);
    // Every node must know the app, not just its holders: the outsider
    // GRANTORS verify the owner-generation record against their own copy of
    // the spec and silently drop it otherwise — which held the re-roll at
    // generation 0 on a quorum of specless cells for two full runs. On
    // production the message sync gives every node every spec; the targeted
    // install shortcut skips that, so the suite restores the parity.
    await seedGlobalSpec(env, app, env.clients.map((_, i) => i).filter((i) => !HOLDERS.includes(i)));
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

    outpoints = {};
    for (let i = 0; i < env.clients.length; i += 1) {
      const status = await env.clients[i].getNodeStatus();
      outpoints[i] = `${status.data.txhash}:${status.data.outidx}`;
    }
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('a dark referee is voted off, and the walk seat that replaces it starts answering', async function () {
    this.timeout(900000);

    let first = null;
    await waitFor(async () => {
      first = await quorumVerdict();
      return first !== null;
    }, { timeout: 240000, interval: 10000, label: 'a grant quorum forms' });

    // A pure referee: on the committee (its cell answers the key), not a
    // holder — pausing it darkens a seat without touching the master.
    const cells = await Promise.all(env.clients.map((_, i) => readCell(i)));
    refereeIndex = cells.findIndex(
      (cell, i) => !HOLDERS.includes(i) && cell?.accepted?.grantee === first.grantee,
    );
    expect(refereeIndex, 'a non-holder committee member exists').to.be.greaterThan(-1);
    // Spare seats are every node OFF the current committee — holders
    // included: the walk seats grantors by HRW and a holder is as walkable
    // as anyone (1208's five-instance overlap is built on exactly that).
    // With 9 seats over 10 nodes the single spare is often a holder, and a
    // holder-excluding filter reads as an empty spare list the moment the
    // replacement lands there.
    const spareIndexes = cells
      .map((cell, i) => ({ cell, i }))
      .filter(({ cell, i }) => i !== refereeIndex && !cell?.accepted)
      .map(({ i }) => i);

    const masterIndex = Number(Object.keys(outpoints).find((i) => outpoints[i] === first.grantee));
    await pauseHostContainer(env.clients[refereeIndex].container);
    try {
      // The heal announces itself: the holder publishes the healed event
      // with the entry it installed, and the registers read back the chain.
      await env.clients[masterIndex].waitForEvent(
        'quorumGrant:healed',
        (d) => d.key === `${name}/master` && d.remove === outpoints[refereeIndex],
        480000,
      );
      let healed = null;
      await waitFor(async () => {
        const now = await Promise.all(env.clients.map((_, i) => readCell(i)));
        healed = now.find((cell) => (cell?.roster?.chain ?? [])
          .some((entry) => entry.remove === outpoints[refereeIndex]));
        return Boolean(healed);
      }, { timeout: 60000, interval: 5000, label: 'the roster chain names the dark seat out' });

      const entry = healed.roster.chain.find((e) => e.remove === outpoints[refereeIndex]);
      expect(entry.add, 'the replacement is a real node').to.not.equal(undefined);
      addedIndex = Number(Object.keys(outpoints).find((i) => outpoints[i] === entry.add));
      expect(spareIndexes, `replacement ${entry.add} came off the walk's spare seats`).to.include(addedIndex);

      // A register's own journaled chain is trusted and deliberately BARE —
      // {seq, remove, add, at} and nothing else; the self-verifying object
      // (the quorum of signed acceptances) rides the PUBLISHED record. Read
      // the proof where it lives, from the master's own synced copy.
      let publishedEntry = null;
      await waitFor(async () => {
        const roster = await dbClient(masterIndex + 1).getMasterleaseRoster(name, 'master');
        publishedEntry = (roster?.chain ?? [])
          .find((e) => e.remove === outpoints[refereeIndex]) ?? null;
        return publishedEntry !== null;
      }, { timeout: 60000, interval: 5000, label: 'the published record carries the healed chain' });
      expect(publishedEntry.acceptances.length, 'a quorum signed the seat change').to.be.at.least(5);

      // The freshly seated grantor answers for a grant its register never
      // held: the holder's seeding accept (or the next renewal) lands there.
      await waitFor(async () => {
        const cell = await readCell(addedIndex);
        return cell?.accepted?.grantee === first.grantee;
      }, { timeout: 180000, interval: 10000, label: 'the seeded replacement answers the grant' });
    } finally {
      // The heal is proven; the dark node returns to the fleet HERE, never
      // as a later test's leftover — today's first run left it paused
      // through the whole re-roll test and its SSE stream died with it.
      await unpauseHostContainer(env.clients[refereeIndex].container);
    }
  });

  it('a dead master fails over THROUGH the healed committee', async function () {
    this.timeout(600000);

    // The heal reshaped the committee; the next election must run on the
    // RESHAPED one: the challenger's asks carry the roster chain, the
    // replacement seat verifies it and answers for a register it never
    // originally sat on, and the successor's quorum includes that seat.
    // Heal proven but never exercised by an election would be a committee
    // that exists only on paper.
    const before = await quorumVerdict();
    expect(before, 'a standing grant before the failure').to.not.equal(null);
    const masterIndex = Number(Object.keys(outpoints).find((i) => outpoints[i] === before.grantee));
    expect(HOLDERS, `master ${before.grantee} maps to a holder`).to.include(masterIndex);
    const survivors = HOLDERS.filter((i) => i !== masterIndex);
    const survivorAfters = new Map(survivors.map((i) => [i, env.clients[i].getLastEventId()]));

    await pauseHostContainer(env.clients[masterIndex].container);
    try {
      await Promise.any(survivors.map((i) => env.clients[i].waitForEvent(
        'quorumGrant:granted', (d) => d.key === `${name}/master`, 300000, { afterId: survivorAfters.get(i) },
      ))).catch((err) => {
        throw new Error(`no survivor acquired through the healed committee (${err.errors?.[0]?.message ?? err.message})`);
      });
      let second = null;
      await waitFor(async () => {
        second = await quorumVerdict();
        return second !== null && second.grantee !== before.grantee;
      }, { timeout: 120000, interval: 10000, label: 'a successor holds the grant' });
      expect(second.epoch, 'epochs never move backwards').to.be.greaterThan(before.epoch);

      // the healed seat took part: the replacement's cell holds the NEW term
      await waitFor(async () => {
        const cell = await readCell(addedIndex);
        return cell?.accepted?.grantee === second.grantee;
      }, { timeout: 60000, interval: 5000, label: 'the replacement seat holds the successor grant' });
    } finally {
      await unpauseHostContainer(env.clients[masterIndex].container);
    }

    // the corpse adopts on return, and the app settles at one master
    await waitFor(async () => {
      const verdict = await quorumVerdict();
      return verdict !== null && verdict.grantee !== before.grantee;
    }, { timeout: 120000, interval: 10000, label: 'the returning corpse adopted' });
  });

  it('the owner re-deals a stopped app\'s walk, and the restarted instances take the new generation through its drain', async function () {
    this.timeout(600000);

    // The retirement drain below is measured in BLOCKS, and bootAndPeer starts
    // the ticker whatever tickerAutostart says (handover 09-02C: both quorum
    // reds were a ticker the suites believed off). Off for the re-roll, so the
    // three blocks that lift the drain are the three this test advances and
    // nothing else; back on at the end for whatever follows.
    await stopTicker();
    try {
      await rerollUnderAStoppedChain();
    } finally {
      await startTicker();
    }
  });

  async function rerollUnderAStoppedChain() {
    const before = await quorumVerdict();
    expect(before, 'a standing grant before the re-roll').to.not.equal(null);
    expect(before.generation).to.equal(0);

    const owner = appOwnerKey();
    async function submitReroll() {
      const { currentHeight } = await getState();
      const at = Date.now();
      const canonical = `fluxgrantgeneration:${name}|master|1|${currentHeight}|${at}`;
      const signature = await signBtcMessage(canonical, owner.privkey);
      return fetch(`${env.clients[0].url}/apps/grantgeneration`, {
        method: 'POST',
        headers: { zelidauth: ownerAuth0, 'content-type': 'application/json' },
        body: JSON.stringify({
          appName: name, role: 'master', generation: 1, height: currentHeight, at, signature,
        }),
      });
    }

    // Release-and-stop: the master yields its term and every instance stops
    // under the operator lock. The re-roll lands at once.
    const yielded = await fetch(`${env.clients[0].url}/apps/appyield/${name}/true`, {
      headers: { zelidauth: ownerAuth0 },
    });
    expect(yielded.status).to.equal(200);
    const submitted = await submitReroll();
    const submittedBody = await submitted.text();
    expect(submitted.status, submittedBody).to.equal(200);

    // The record reaches every holder (its own event on each node), the
    // salted walk deals a fresh committee, and the stopped world restarts
    // into it: the operator lock lifts and the instances pursue generation
    // 1 — into the retirement drain first.
    await Promise.all(HOLDERS.map((i) => env.clients[i].waitForEvent(
      'quorumGrant:generationRecord',
      (d) => d.appName === name && d.role === 'master' && d.generation === 1,
      120000,
    )));

    const restarted = await fetch(`${env.clients[0].url}/apps/apprestart/${name}/true`, {
      headers: { zelidauth: ownerAuth0 },
    });
    expect(restarted.status).to.equal(200);

    // THE RETIREMENT DRAIN: the record names the current height, so the
    // fresh committee may not serve until three blocks pass — and with the
    // ticker off, none do. The master's pursuit fires every ~10s into
    // draining refusals; nothing may be granted at generation 1 while the
    // chain stands still. Inside the master's own demotion arithmetic
    // (deadline ~TTL+slack after the old world stops renewing), so the app
    // still never changes hands.
    await Promise.all(HOLDERS.map((i) => assertNoEvent(
      env.clients[i],
      'quorumGrant:granted',
      (d) => d.key === `${name}/master` && d.generation === 1,
      40000,
    )));
    // The passage of blocks is the one thing that lifts the drain — the
    // discriminator between "draining" and any other slowness.
    await advanceBlock();
    await advanceBlock();
    await advanceBlock();
    await Promise.any(HOLDERS.map((i) => env.clients[i].waitForEvent(
      'quorumGrant:granted',
      (d) => d.key === `${name}/master` && d.generation === 1,
      360000,
    )));
    await waitFor(async () => {
      const verdict = await quorumVerdict();
      return verdict !== null && verdict.generation === 1;
    }, { timeout: 60000, interval: 5000, label: 'a generation-1 quorum forms' });

    // The app was stopped before the re-deal, so the new world's term goes to
    // whichever restarted instance wins: one clean generation-1 quorum. The
    // carry under a running master is 1219's.
    const after = await quorumVerdict();
    expect(after.generation, 'one clean generation-1 world').to.equal(1);
  }
});
