// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { bootAndPeer, installOnNodes } from '../framework/reconciler-suite.js';
import { buildSeedableSyncthingApp } from '../framework/seed-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { pauseHostContainer, unpauseHostContainer } from '../framework/container.js';
import { waitFor, waitForAppInstalled } from '../framework/wait.js';
import { getState } from '../framework/daemon-control.js';
import { authenticate, signBtcMessage } from '../auth.js';
import { appOwnerKey } from '../framework/keys.js';

// Tier one and tier two against a real fleet. A referee that answers
// nobody for a full term is voted off by the committee itself: the holder
// proposes remove-dark-add-next-in-walk, a quorum of grantors signs, the
// roster chain rides the published record, and the freshly seated
// replacement answers for a grant its own register never heard of. And
// when the OWNER re-rolls the generation, the whole committee re-deals
// from a salted walk: the old world's grantors refuse teaching the new
// number, and the master re-acquires under generation 1 without the app
// ever stopping. Ten nodes: committee nine of ten, so the walk has a
// spare seat to promote — the smallest fleet where a heal has somewhere
// to go.

const HOLDERS = [0, 1, 2];

describe('the committee heals its dark seat, and the owner re-deals the walk', function () {
  let env;
  let name;
  let outpoints; // node index -> outpoint, all ten
  let ownerAuth0;
  let refereeIndex;

  async function readCell(clientIndex) {
    try {
      const res = await fetch(
        `${env.clients[clientIndex].url}/flux/quorumgrant/record?key=${encodeURIComponent(`${name}/master`)}`,
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
    ownerAuth0 = (await authenticate(env.clients[0].url, appOwnerKey())).zelidauth;

    name = `e2eheal${Date.now()}`;
    await pushImage(name, 'v1');
    const app = await buildSeedableSyncthingApp({ name, mode: 'g' });
    await installOnNodes(env, app, HOLDERS);
    await Promise.all(HOLDERS.map((i) => waitForAppInstalled(env.clients[i], name, 240000)));

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
    const spareIndexes = cells
      .map((cell, i) => ({ cell, i }))
      .filter(({ cell, i }) => !HOLDERS.includes(i) && i !== refereeIndex && !cell?.accepted)
      .map(({ i }) => i);

    const masterIndex = Number(Object.keys(outpoints).find((i) => outpoints[i] === first.grantee));
    await pauseHostContainer(env.clients[refereeIndex].container);

    // The heal announces itself: the holder publishes the healed event
    // with the entry it installed, and the registers read back the chain
    // with its quorum of signatures.
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
    expect(entry.acceptances.length, 'a quorum signed the seat change').to.be.at.least(5);
    expect(entry.add, 'the replacement is a real node').to.not.equal(undefined);
    const addedIndex = Number(Object.keys(outpoints).find((i) => outpoints[i] === entry.add));
    expect(spareIndexes, `replacement ${entry.add} came off the walk's spare seats`).to.include(addedIndex);

    // The freshly seated grantor answers for a grant its register never
    // held: the holder's seeding accept (or the next renewal) lands there.
    await waitFor(async () => {
      const cell = await readCell(addedIndex);
      return cell?.accepted?.grantee === first.grantee;
    }, { timeout: 180000, interval: 10000, label: 'the seeded replacement answers the grant' });
  });

  it('the owner re-deals the walk, and the master re-acquires under the new generation', async function () {
    this.timeout(600000);

    const before = await quorumVerdict();
    expect(before, 'a standing grant before the re-roll').to.not.equal(null);
    expect(before.generation).to.equal(0);

    const owner = appOwnerKey();
    const { currentHeight } = await getState();
    const at = Date.now();
    const canonical = `fluxgrantgeneration:${name}|master|1|${currentHeight}|${at}`;
    const signature = await signBtcMessage(canonical, owner.privkey);
    const res = await fetch(`${env.clients[0].url}/apps/grantgeneration`, {
      method: 'POST',
      headers: { zelidauth: ownerAuth0, 'content-type': 'application/json' },
      body: JSON.stringify({
        appName: name, role: 'master', generation: 1, height: currentHeight, at, signature,
      }),
    });
    expect(res.status, await res.text().catch(() => '')).to.equal(200);

    // The record reaches every holder (its own event on each node), the
    // salted walk deals a fresh committee, the old world's grantors refuse
    // renewals teaching generation 1, and the master re-acquires there
    // without the app changing hands — its granted event under the new
    // generation, then the registers: same grantee, generation 1 on a
    // quorum of cells.
    await Promise.all(HOLDERS.map((i) => env.clients[i].waitForEvent(
      'quorumGrant:generationRecord',
      (d) => d.appName === name && d.role === 'master' && d.generation === 1,
      120000,
    )));
    await Promise.any(HOLDERS.map((i) => env.clients[i].waitForEvent(
      'quorumGrant:granted',
      (d) => d.key === `${name}/master` && d.generation === 1,
      360000,
    )));
    await waitFor(async () => {
      const verdict = await quorumVerdict();
      return verdict !== null && verdict.generation === 1;
    }, { timeout: 60000, interval: 5000, label: 'a generation-1 quorum forms' });

    const after = await quorumVerdict();
    expect(after.grantee, 'the master survives its own re-deal').to.equal(before.grantee);

    await unpauseHostContainer(env.clients[refereeIndex].container);
  });
});
