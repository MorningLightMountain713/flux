// fleet: 4
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { restartFluxos } from '../framework/container.js';
import { waitFor } from '../framework/wait.js';
import { queueAppTx } from '../framework/daemon-control.js';
import { dbClient } from '../framework/db-client.js';
import { confirmTwoUpdatesInOneBlock } from '../framework/same-block-updates.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

// A node's payment records carry each transaction's position in its block, as
// the explorer meets them. A node whose records carry none - records made
// before positions were recorded - gets them back from the daemon's address
// index when FluxOS starts, and decides them in that order. A record at a
// height its transaction is not at takes the chain's and is decided there. A record the chain does not hold is no payment, and a
// block paying its hash records the payment in its place. The backfill reads
// only the records without a position, through the index the node builds.

const NODES = 4;
const NODE = 0;

describe('payment positions a node never recorded are recovered from the chain at start', function () {
  let env;
  let outcome;
  let db;
  const name = `e2epaypos${Date.now()}`;

  dumpLogsOnFailure(() => env);

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({ hookCtx: this, nodes: NODES, tickerAutostart: false });
    await bootAndPeer(env);
    outcome = await confirmTwoUpdatesInOneBlock(env, name);
    db = dbClient(NODE + 1);
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('records each payment\'s position in its block as the explorer meets it', async () => {
    expect((await db.appHashRecord(outcome.standing.hash)).txIndex).to.equal(1);
    expect((await db.appHashRecord(outcome.superseded.hash)).txIndex).to.equal(0);
  });

  it('given records carried without positions, has the positions back after restarting and decides the update later in the block', async function () {
    this.timeout(420000);
    // Records carried from before positions were recorded: no position and no decision yet.
    for (const { hash } of [outcome.standing, outcome.superseded]) {
      // eslint-disable-next-line no-await-in-loop
      await db.unsetTxIndex(hash);
      // eslint-disable-next-line no-await-in-loop
      await db.removeDecision(hash);
    }
    // The canary: the records really are without a position or a decision before the restart.
    expect((await db.appHashRecord(outcome.standing.hash)).txIndex).to.equal(undefined);
    expect((await db.appHashRecord(outcome.superseded.hash)).txIndex).to.equal(undefined);
    expect(await db.decision(outcome.standing.hash)).to.equal(null);

    await restartFluxos(env.clients[NODE].container);
    await waitFor(async () => (await db.decision(outcome.standing.hash)) !== null
      && (await db.decision(outcome.superseded.hash)) !== null,
    { timeout: 360000, interval: 3000, label: 'both records decided again' });

    expect((await db.appHashRecord(outcome.standing.hash)).txIndex).to.equal(1);
    expect((await db.appHashRecord(outcome.superseded.hash)).txIndex).to.equal(0);
    expect((await db.appHashRecord(outcome.standing.hash)).notOnChain).to.equal(undefined);
    expect(await db.decision(outcome.superseded.hash)).to.include({ decision: 'applied', txIndex: 0 });
    expect(await db.decision(outcome.standing.hash)).to.include({ decision: 'applied', txIndex: 1 });
    const r = await env.clients[NODE].getAppSpecs(name);
    expect(r.data.description).to.equal(outcome.standing.description);
  });

  it('decides a record carried without a position at a height its transaction is not at, at the chain\'s height', async function () {
    this.timeout(420000);
    const { hash } = outcome.standing;
    const chainHeight = (await db.appHashRecord(hash)).height;
    // a block the explorer left: above the transaction, below the tip, so the backfill places it
    const strayHeight = chainHeight + 1;
    // A record carried from before positions were recorded: no position, the
    // height of a block that left the chain, and no decision yet.
    await db.unsetTxIndex(hash);
    await db.setAppHashHeight(hash, strayHeight);
    await db.removeDecision(hash);
    // The canary: the record is at the stray height and undecided before the restart.
    expect((await db.appHashRecord(hash)).height).to.equal(strayHeight);
    expect(await db.decision(hash)).to.equal(null);

    await restartFluxos(env.clients[NODE].container);
    await waitFor(async () => (await db.decision(hash)) !== null,
      { timeout: 360000, interval: 3000, label: 'the record decided again' });

    expect((await db.appHashRecord(hash)).height).to.equal(chainHeight);
    expect(await db.decision(hash)).to.include({ decision: 'applied', height: chainHeight });
  });

  it('records a block\'s payment of a hash in place of a record the chain does not hold, and the message and registry follow it', async function () {
    this.timeout(300000);
    const { hash } = outcome.standing;
    const before = await db.appHashRecord(hash);
    await db.markNotOnChain(hash);
    // The canary: the record is marked before the block pays the hash.
    expect((await db.appHashRecord(hash)).notOnChain).to.equal(true);

    const { nextBlockHeight } = await queueAppTx(hash);
    await waitFor(async () => {
      const record = await db.appHashRecord(hash);
      return record.notOnChain === undefined && record.height >= nextBlockHeight;
    }, { timeout: 180000, interval: 2000, label: 'the block\'s payment recorded in place of the marked record' });

    const record = await db.appHashRecord(hash);
    expect(record.txid).to.not.equal(before.txid);
    await waitFor(async () => (await db.appMessages({ hash }))[0].height === record.height,
      { timeout: 120000, interval: 2000, label: 'the stored message at the new payment\'s height' });
    await waitFor(async () => {
      const rows = await db.appSpecRows(name);
      return rows.length === 1 && rows[0].hash === hash && rows[0].height === record.height;
    }, { timeout: 120000, interval: 2000, label: 'the registry at the new payment\'s height' });
  });

  it('reads only the payment records without a position when it looks for ones to backfill', async () => {
    const { hash } = outcome.superseded;
    await db.unsetTxIndex(hash);

    const stats = await db.explainAppMessagesRead((messages) => messages.withoutPosition());

    // The canary: the read finds the record without a position.
    expect(stats.nReturned).to.equal(1);
    expect(stats.totalDocsExamined, 'the backfill read records that have a position').to.equal(stats.nReturned);
  });
});
