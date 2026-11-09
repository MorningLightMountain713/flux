// fleet: 4
/*
 * A running node fetches from its peers the app messages missing behind its payment records,
 * stores them, and writes the registry row of each app they belong to. Here the database
 * refuses the first of those row writes: the messages are stored and the rows are not.
 *
 * A message the node stores waits on no peer: the next pass writes the rows from the stored
 * copies. The node must hold every app at its newest message within a few passes, and must
 * never ask a peer again for a message it stored.
 *
 * The late log is paid and handed to the peers while the node is cut off from them, so it
 * records the payments and misses every message once before it fetches them.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { buildSeedableApp, buildSeedableUpdate } from '../framework/seed-helper.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { deliverWhileCutOff } from '../framework/app-delivery.js';
import { startTicker, stopTicker } from '../framework/daemon-control.js';
import { waitForDaemonReady, waitForOrchestratorState, waitFor } from '../framework/wait.js';
import { failCommands } from '../framework/mongo-control.js';
import { dbClient } from '../framework/db-client.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

const NODES = 4;
// the running node: held back until the fleet is up
const SUBJECT = NODES - 1;
const PEERS = [0, 1, 2];
const LATE_APPS = 10;
const UPDATES = 54;

function step(what) {
  console.log(`# 3311 ${new Date().toISOString()} ${what}`);
}

describe('a late message whose registry row could not be written gets it on the next pass', function () {
  let env;
  dumpLogsOnFailure(() => env);
  const stamp = Date.now();
  // the newest message of each app the late log brings, by name
  const governing = new Map();
  let lateHashes;
  let release;
  let failedWrites;
  let batchFetched;
  const db = () => dbClient(SUBJECT + 1);

  before(async function () {
    this.timeout(1200000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      deferredNodes: 1,
      // a pass comes every few blocks
      configOverrides: { fluxapps: { hashSyncFallbackRecheckBlocks: 2 } },
    });
    await bootAndPeer(env);

    const subject = await env.startNode(SUBJECT);
    await waitForDaemonReady(subject);
    await env.startDiscovery([SUBJECT]);
    await waitForOrchestratorState(subject, 'READY', 600000);
    await stopTicker();

    const late = [];
    for (let k = 0; k < LATE_APPS; k += 1) {
      const name = `e2eRowLate${k}x${stamp}`;
      // eslint-disable-next-line no-await-in-loop
      let current = await buildSeedableApp({ name });
      late.push(current);
      for (let j = 1; j <= UPDATES; j += 1) {
        // eslint-disable-next-line no-await-in-loop
        current = await buildSeedableUpdate(current, (spec) => { spec.description = `${name} revision ${j}`; });
        late.push(current);
      }
      governing.set(name, current.hash);
    }
    lateHashes = late.map((m) => m.hash);

    // Armed before the late log: nothing writes the node's registry while it is cut off, so the
    // first write it refuses is a late app's row.
    step('the subject\'s first registry row write refused');
    release = await failCommands(SUBJECT + 1, 'globalzelapps', 'zelappsinformation', { commands: ['update'], times: 1 });
    const anchor = subject.getLastEventId();
    step(`delivering ${late.length} late messages to the peers while the node is cut off`);
    await deliverWhileCutOff(env, late.map((m) => m.message), { cutOff: SUBJECT, peers: PEERS });
    await startTicker();
    batchFetched = await subject.waitForEvent('hashSync:batchFetched', (d) => d.stored > 0, 600000, { afterId: anchor })
      .catch(() => null);
    step('fetched in batches');
    // The rows are written after the messages are stored.
    await release.fired(1, 120000).catch(() => {});
  });

  after(async function () {
    this.timeout(60000);
    await release?.().catch(() => {});
    await env?.teardown();
  });

  it('took the late messages in batches', function () {
    expect(batchFetched, 'the node never fetched the late messages, so nothing below was tested').to.not.equal(null);
    expect(batchFetched.data).to.include({ stored: lateHashes.length, unheld: 0 });
  });

  it('had a registry row write refused by the database', async function () {
    failedWrites = await release();
    release = null;
    expect(failedWrites, 'the database refused none of the node\'s registry writes, so nothing below was tested').to.equal(1);
  });

  it('holds every late app at its newest message within a few passes', async function () {
    this.timeout(180000);
    const names = [...governing.keys()];
    await waitFor(async () => {
      const held = await Promise.all(names.map(async (name) => (await db().globalAppSpec(name))?.hash));
      return held.every((hash, i) => hash === governing.get(names[i]));
    }, { timeout: 150000, interval: 3000, label: 'every late app held at its newest message' });
  });

  it('never asked a peer again for a message it stored', async function () {
    const records = await db().appMessages({ hash: { $in: lateHashes } });
    expect(records.length, 'the node holds no record of the late hashes').to.equal(lateHashes.length);
    expect(records.filter((r) => !r.held).map((r) => r.hash), 'a late message not held').to.deep.equal([]);
    // Each was missed once, while the node was cut off; a second attempt is a peer asked for a message already stored.
    const askedAgain = records.filter((r) => (r.syncAttempts ?? 0) > 1).map((r) => r.hash);
    expect(askedAgain).to.deep.equal([]);
  });
});
