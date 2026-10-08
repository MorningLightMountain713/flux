// fleet: 6
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { buildSeedableApp } from '../framework/seed-helper.js';
import { submitSignedApp } from '../framework/app-helper.js';
import { nodeKey } from '../framework/keys.js';
import { dbClient } from '../framework/db-client.js';
import {
  advanceBlocks, getState, queueAppTx, reorgChain, startTicker, stopTicker,
} from '../framework/daemon-control.js';
import { waitFor, waitForBlockProcessed, waitForReorg } from '../framework/wait.js';
import {
  bootstrapAvailabilityKey, publishVoid, VOID_WINDOW_OPENS_AFTER_BLOCKS,
} from '../framework/unclaimed-payment-helper.js';

// The chain carries only an app message's payment; the contents are gossiped.
// A paid hash whose contents never appear is voided by the availability key
// inside the payment's void window, and from then on no node asks for the
// contents, stores them when handed them, or decides the app from them. A
// rewind that drops the void gives the hash back.
//
// Two apps are paid for without their contents: one is voided and one is
// claimed inside the window, so every refusal asserted of the first is beside
// an acceptance of the second on the same nodes.

// The message as its owner signed it, in the shape the submission door takes.
const signedOf = (app) => ({
  type: app.message.type,
  version: app.message.version,
  appSpecification: app.message.appSpecifications,
  timestamp: app.message.timestamp,
  signature: app.message.signature,
});

// Blocks between hash-sync retry passes on a harness fleet
// (hashSyncFallbackRecheckBlocks), plus two.
const RETRY_PASS_BLOCKS = 12;

describe('Unclaimed payment void', function () {
  let env;
  let withheld;
  let claimed;
  let paymentHeight;
  let voidHeight;

  const db = (index) => dbClient(index + 1);
  const everyNode = (fn) => Promise.all(env.clients.map((client, index) => fn(client, db(index), index)));

  async function tipProcessedEverywhere(timeout = 90000) {
    const { currentHeight } = await getState();
    await everyNode((client) => waitForBlockProcessed(client, (d) => d.height >= currentHeight, timeout));
    return currentHeight;
  }

  async function hashRetryCount(client, outcome) {
    const counters = await client.getTestCounters();
    return counters?.['hashSync:retry']?.[outcome] ?? 0;
  }

  // Mine one void into a block of its own and answer its height.
  async function voidAt(hash, label) {
    await stopTicker();
    await publishVoid(hash, label);
    const { currentHeight } = await getState();
    await startTicker();
    return currentHeight;
  }

  before(async function () {
    this.timeout(300000);
    env = await createTestEnv({
      hookCtx: this, nodes: 6, tickerAutostart: false, zmqTopics: ALL_ZMQ_TOPICS,
    });
    await bootAndPeer(env);
    await bootstrapAvailabilityKey();
    withheld = await buildSeedableApp({ name: `e2eWithheld${Date.now() % 100000}` });
    claimed = await buildSeedableApp({ name: `e2eClaimed${Date.now() % 100000}` });
  });

  after(async function () {
    this.timeout(30000);
    await stopTicker().catch(() => {});
    await env?.teardown();
  });

  it('records a payment whose contents nobody holds, and asks the network for them', async function () {
    this.timeout(150000);
    await queueAppTx(withheld.hash);
    await queueAppTx(claimed.hash);
    await advanceBlocks(1);
    await tipProcessedEverywhere();

    const records = await everyNode((client, nodeDb) => nodeDb.getAppHash(withheld.hash));
    records.forEach((record, index) => {
      expect(record, `node ${index} holds the payment record`).to.exist;
      expect(record.message, `node ${index} has no contents`).to.equal(false);
      expect(record.voided, `node ${index} nothing voided`).to.equal(undefined);
    });
    paymentHeight = records[0].height;

    await advanceBlocks(RETRY_PASS_BLOCKS);
    await waitFor(
      async () => (await hashRetryCount(env.clients[0], 'missingRemain')) > 0,
      { timeout: 90000, label: 'a hash-sync pass finds the contents missing' },
    );
  });

  it('takes contents handed inside the window, and decides the app from them', async function () {
    this.timeout(150000);
    const res = await submitSignedApp(env.clients[0].url, nodeKey(1), signedOf(claimed));
    expect(res.status, JSON.stringify(res.data)).to.equal('success');
    expect(res.data, 'the door hashes the message as its owner did').to.equal(claimed.hash);

    await waitFor(
      async () => Boolean(await db(1).getPermanentMessage(claimed.hash)),
      { timeout: 90000, label: 'the claimed contents stored on a peer' },
    );
    await waitFor(
      async () => Boolean(await db(1).getGlobalApp(claimed.spec.name)),
      { timeout: 60000, label: 'the claimed app decided on a peer' },
    );
  });

  it('ignores a void published before the window opens', async function () {
    this.timeout(90000);
    const { currentHeight } = await getState();
    expect(currentHeight + 1, 'the window must still be closed').to.be.below(paymentHeight + VOID_WINDOW_OPENS_AFTER_BLOCKS);

    await voidAt(withheld.hash, 'void-early');
    await tipProcessedEverywhere();

    const records = await everyNode((client, nodeDb) => nodeDb.getAppHash(withheld.hash));
    records.forEach((record, index) => expect(record.voided, `node ${index}`).to.equal(undefined));
  });

  it('voids the payment with a void inside the window: every node marks the record and stops asking for the contents', async function () {
    this.timeout(180000);
    const { currentHeight } = await getState();
    const untilOpen = paymentHeight + VOID_WINDOW_OPENS_AFTER_BLOCKS - (currentHeight + 1);
    if (untilOpen > 0) await advanceBlocks(untilOpen);
    const clearBefore = await hashRetryCount(env.clients[0], 'clear');

    voidHeight = await voidAt(withheld.hash, 'void');
    expect(voidHeight).to.be.at.least(paymentHeight + VOID_WINDOW_OPENS_AFTER_BLOCKS);
    await tipProcessedEverywhere();

    const records = await everyNode((client, nodeDb) => nodeDb.getAppHash(withheld.hash));
    records.forEach((record, index) => expect(record.voided, `node ${index} voided`).to.equal(true));
    expect((await db(0).getAppHash(claimed.hash)).voided, 'the claimed payment stands').to.equal(undefined);

    await advanceBlocks(RETRY_PASS_BLOCKS);
    await waitFor(
      async () => (await hashRetryCount(env.clients[0], 'clear')) > clearBefore,
      { timeout: 90000, label: 'a hash-sync pass with nothing left to ask for' },
    );
  });

  it('refuses the contents handed after the void: they reach the nodes and are never stored or decided', async function () {
    this.timeout(180000);
    const res = await submitSignedApp(env.clients[0].url, nodeKey(1), signedOf(withheld));
    expect(res.status, JSON.stringify(res.data)).to.equal('success');
    expect(res.data).to.equal(withheld.hash);

    await waitFor(
      async () => ((await env.clients[1].getTempMessages(withheld.hash)).data?.length ?? 0) > 0,
      { timeout: 60000, label: 'the withheld contents reach a peer as a temporary message' },
    );
    const clearBefore = await hashRetryCount(env.clients[1], 'clear');
    await advanceBlocks(RETRY_PASS_BLOCKS);
    await waitFor(
      async () => (await hashRetryCount(env.clients[1], 'clear')) > clearBefore,
      { timeout: 90000, label: 'a hash-sync pass on the peer after the contents arrived' },
    );

    expect(await db(1).getPermanentMessage(claimed.hash), 'the claimed contents are stored on the same node').to.exist;
    expect(await db(1).getPermanentMessage(withheld.hash)).to.equal(null);
    expect(await db(1).getGlobalApp(withheld.spec.name)).to.equal(null);
  });

  it('gives the hash back on a rewind that drops the void, and takes the contents the network holds', async function () {
    this.timeout(240000);
    const forkHeight = voidHeight - 1;
    const seen = waitForReorg(env.clients[1], (d) => d.forkHeight === forkHeight, 60000);
    await reorgChain({ forkHeight });
    await seen;

    await waitFor(
      async () => (await db(1).getAppHash(withheld.hash))?.voided !== true,
      { timeout: 60000, label: 'the payment record unmarked' },
    );
    await advanceBlocks(RETRY_PASS_BLOCKS);
    await waitFor(
      async () => Boolean(await db(1).getPermanentMessage(withheld.hash)),
      { timeout: 120000, label: 'the withheld contents stored once the void fell' },
    );
    await waitFor(
      async () => Boolean(await db(1).getGlobalApp(withheld.spec.name)),
      { timeout: 60000, label: 'the withheld app decided' },
    );
  });
});
