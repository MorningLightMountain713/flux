// fleet: 4
/*
 * A node that is running finds app messages missing behind payments its scan recorded, and its
 * hash retry fetches them from its peers in batches. It writes the registry row of each app
 * those messages belong to, and touches no other: the registry is built in full only on the
 * way to ready.
 *
 * The node boots holding two apps. The late log is then paid and handed to the peers while the
 * node is cut off from them, so it records the payments but not the messages: ten new apps with
 * long update chains, and late updates to one of the two it already holds. The other is
 * untouched by the late log: its row is written again only if the node rewrites rows the late
 * log does not touch. A row write is the node's app:specStored.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { buildSeedableApp, buildSeedableUpdate } from '../framework/seed-helper.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { deliverAppMessage, deliverWhileCutOff } from '../framework/app-delivery.js';
import { startTicker, stopTicker } from '../framework/daemon-control.js';
import { waitForDaemonReady, waitForOrchestratorState, waitFor } from '../framework/wait.js';
import { dbClient } from '../framework/db-client.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

const NODES = 4;
// the running node: held back until the apps it boots holding are in place
const SUBJECT = NODES - 1;
const PEERS = [0, 1, 2];
const LATE_APPS = 10;
const UPDATES = 54;
const LATE_UPDATES_TO_HELD = 5;

function step(what) {
  console.log(`# 3305 ${new Date().toISOString()} ${what}`);
}

describe('a running node applies late messages app by app', function () {
  let env;
  dumpLogsOnFailure(() => env);
  const stamp = Date.now();
  // the newest message of each app the late log brings, by name
  const governing = new Map();
  let untouched;
  let updated;
  let lateCount;
  let anchor;
  let batchFetched;
  const db = () => dbClient(SUBJECT + 1);
  const nameOf = (app) => app.message.appSpecifications.name;

  before(async function () {
    this.timeout(1200000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      deferredNodes: 1,
      // the retry that finds the late log comes within a few blocks
      configOverrides: { fluxapps: { hashSyncFallbackRecheckBlocks: 2 } },
    });
    await bootAndPeer(env);
    await stopTicker();

    // the two apps the node boots holding
    untouched = await buildSeedableApp({ name: `e2eHeld${stamp}` });
    updated = await buildSeedableApp({ name: `e2eHeldUp${stamp}` });
    await deliverAppMessage(env, untouched.message, PEERS);
    await deliverAppMessage(env, updated.message, PEERS);
    const subject = await env.startNode(SUBJECT);
    await waitForDaemonReady(subject);
    await env.startDiscovery([SUBJECT]);
    await waitForOrchestratorState(subject, 'READY', 600000);
    await waitFor(async () => (await db().globalAppSpec(nameOf(updated)))?.hash === updated.hash
      && (await db().globalAppSpec(nameOf(untouched)))?.hash === untouched.hash, {
      timeout: 120000, interval: 2000, label: 'the node holds the two apps it booted with',
    });

    // the late log
    const late = [];
    let current = updated;
    for (let j = 1; j <= LATE_UPDATES_TO_HELD; j += 1) {
      // eslint-disable-next-line no-await-in-loop
      current = await buildSeedableUpdate(current, (spec) => { spec.description = `held app revision ${j}`; });
      late.push(current);
    }
    governing.set(nameOf(updated), current.hash);
    for (let k = 0; k < LATE_APPS; k += 1) {
      const name = `e2eLate${k}x${stamp}`;
      // eslint-disable-next-line no-await-in-loop
      current = await buildSeedableApp({ name });
      late.push(current);
      for (let j = 1; j <= UPDATES; j += 1) {
        // eslint-disable-next-line no-await-in-loop
        current = await buildSeedableUpdate(current, (spec) => { spec.description = `${name} revision ${j}`; });
        late.push(current);
      }
      governing.set(name, current.hash);
    }
    lateCount = late.length;

    anchor = subject.getLastEventId();
    step(`delivering ${lateCount} late messages to the peers while the node is cut off`);
    await deliverWhileCutOff(env, late.map((m) => m.message), { cutOff: SUBJECT, peers: PEERS });
    await startTicker();
    batchFetched = await subject.waitForEvent('hashSync:batchFetched', (d) => d.stored > 0, 600000, { afterId: anchor });
    step('fetched in batches');
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('took the late messages in batches while running', function () {
    expect(batchFetched.data, JSON.stringify(batchFetched.data)).to.include({ stored: lateCount, unheld: 0 });
  });

  it('holds every app the late log brings at its newest message', async function () {
    this.timeout(180000);
    const names = [...governing.keys()];
    await waitFor(async () => {
      const held = await Promise.all(names.map(async (name) => (await db().globalAppSpec(name))?.hash));
      return held.every((hash, i) => hash === governing.get(names[i]));
    }, { timeout: 150000, interval: 3000, label: 'every late app held at its newest message' });
  });

  it('brings an app it already held up to its late update', async function () {
    expect((await db().globalAppSpec(nameOf(updated))).hash).to.equal(governing.get(nameOf(updated)));
  });

  it('rewrites no row the late log does not touch', async function () {
    const written = env.clients[SUBJECT].getEventBuffer()
      .filter((entry) => entry.id > anchor && entry.event === 'app:specStored')
      .map((entry) => entry.data.name);
    // The canary: the held app's row was written after the late log, so row writes were being seen.
    expect(written, 'the held app the late log updates').to.include(nameOf(updated));
    expect(written, 'the app the late log does not touch').to.not.include(nameOf(untouched));
    expect((await db().globalAppSpec(nameOf(untouched)))?.hash, 'the untouched app still listed').to.equal(untouched.hash);
  });
});
