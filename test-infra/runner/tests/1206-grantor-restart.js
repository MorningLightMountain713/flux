// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { bootAndPeer, installOnNodes } from '../framework/reconciler-suite.js';
import { buildSeedableSyncthingApp } from '../framework/seed-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { restartFluxos } from '../framework/container.js';
import { waitFor, waitForAppInstalled, assertNoEvent } from '../framework/wait.js';

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
        return { grantee, epoch: Math.max(...matching.map((c) => c.accepted.epoch)) };
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
          quorumGrantUnanimityCacheMs: 15000,
        },
      },
    });
    await bootAndPeer(env);

    name = `e2edrain${Date.now()}`;
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
});
