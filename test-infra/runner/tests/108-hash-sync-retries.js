// fleet: 5
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import {
  waitForDaemonReady, waitForNodeStatus, waitForBlockProcessed,
  waitForExplorerReady, waitForOrchestratorStarted, waitForOrchestratorState,
  waitForPeerThreshold,
  waitFor,
} from '../framework/wait.js';
import {
  advanceBlock, advanceBlocks, startTicker, stopTicker,
} from '../framework/daemon-control.js';
import { dbClient } from '../framework/db-client.js';

async function bootToReady(env) {
  await Promise.all(env.clients.map((c) => waitForDaemonReady(c)));
  await Promise.all(env.clients.map((c) => waitForNodeStatus(c, (d) => d.confirmed === true, 30000)));
  await waitForExplorerReady(env.clients[0]);
  await waitForOrchestratorStarted(env.clients[0]);
  await advanceBlock();
  await waitForBlockProcessed(env.clients[0], () => true, 20000);
  await env.startDiscovery();
  await waitForPeerThreshold(env.clients[0], 120000);
  await startTicker();
  await waitForOrchestratorState(env.clients[0], 'READY', 120000);
  await stopTicker();
}

// A failed hash-sync pass is retried after HASH_SYNC_RETRY_MIN_MS, doubling each
// time up to HASH_SYNC_RETRY_MAX_MS, without end.
const HASH_SYNC_RETRY_MIN_MS = 2000;
const HASH_SYNC_RETRY_MAX_MS = 8000;
const RETRY_CONFIG = {
  fluxapps: { hashSyncRetryMinMs: HASH_SYNC_RETRY_MIN_MS, hashSyncRetryMaxMs: HASH_SYNC_RETRY_MAX_MS },
};

// Boots every node but the last, then starts the last with every read of its
// payment records failing, so its first hash-sync pass fails: a node syncs its
// hashes as soon as its scan first catches up, so the fault has to be in place
// before it boots.
async function bootWithFailingLastNode(env) {
  const started = env.clients.filter(Boolean);
  await Promise.all(started.map((c) => waitForDaemonReady(c)));
  await Promise.all(started.map((c) => waitForNodeStatus(c, (d) => d.confirmed === true, 30000)));
  await env.startDiscovery();
  const last = env.lastNodeIndex;
  await dbClient(last + 1).failpointFind('zelappshashes', { always: true });
  await env.startNode(last);
  const client = env.clients[last];
  await waitForDaemonReady(client);
  return client;
}

describe('Hash sync: retry on failure', function () {
  let env;
  let client;

  before(async function () {
    this.timeout(300000);
    env = await createTestEnv({
      hookCtx: this, nodes: 5, deferredNodes: 1, tickerAutostart: false, configOverrides: RETRY_CONFIG,
    });
    client = await bootWithFailingLastNode(env);
  });

  after(async function () {
    this.timeout(30000);
    await dbClient(env.lastNodeIndex + 1).failpointClear();
    await env?.teardown();
  });

  it('retries a failed pass after the minimum wait, doubling it each time', async function () {
    this.timeout(60000);
    const first = await client.waitForEvent('hashSync:failed', (d) => d.attempt === 1, 30000);
    expect(first.data.retryInMs).to.equal(HASH_SYNC_RETRY_MIN_MS);
    const second = await client.waitForEvent('hashSync:failed', (d) => d.attempt === 2, 30000, { afterId: first.id });
    expect(second.data.retryInMs).to.equal(2 * HASH_SYNC_RETRY_MIN_MS);
  });

  it('never gives up, and caps the wait', async function () {
    this.timeout(90000);
    const fourth = await client.waitForEvent('hashSync:failed', (d) => d.attempt === 4, 60000);
    expect(fourth.data.retryInMs).to.equal(HASH_SYNC_RETRY_MAX_MS);
  });

  it('completes once the node can read its records again', async function () {
    this.timeout(60000);
    const mark = client.getLastEventId();
    await dbClient(env.lastNodeIndex + 1).failpointClear();
    const done = await client.waitForEvent('hashSync:complete', () => true, 40000, { afterId: mark });
    expect(done.data.attempt).to.be.above(4);
  });
});

describe('Hash sync: a node whose hash sync keeps failing', function () {
  let env;
  let client;

  before(async function () {
    this.timeout(300000);
    env = await createTestEnv({
      hookCtx: this, nodes: 5, deferredNodes: 1, tickerAutostart: false, configOverrides: RETRY_CONFIG,
    });
    client = await bootWithFailingLastNode(env);
    await client.waitForEvent('hashSync:failed', (d) => d.attempt === 1, 30000);
  });

  after(async function () {
    this.timeout(30000);
    await dbClient(env.lastNodeIndex + 1).failpointClear();
    await env?.teardown();
  });

  it('still reaches READY via block fallback', async function () {
    this.timeout(300000);
    // Block threshold is 250 (125 min * 2 blocks/min). Advance past it.
    await advanceBlocks(260);
    await waitForOrchestratorState(client, 'READY', 120000);
  });
});

describe('Hash sync: retry timer cancelled during DEGRADED', function () {
  let env;

  before(async function () {
    this.timeout(300000);
    env = await createTestEnv({
      hookCtx: this, nodes: 5, tickerAutostart: false, configOverrides: RETRY_CONFIG,
    });
    await bootToReady(env);
  });

  after(async function () {
    this.timeout(30000);
    const db = dbClient(1);
    await db.failpointClear();
    await env?.teardown();
  });

  it('should not fire hash sync retry during DEGRADED', async function () {
    this.timeout(120000);

    const db = dbClient(1);
    const heightBefore = await db.explorerHeight();
    const fakeHash = 'deadbeef'.repeat(8);
    await advanceBlock(fakeHash);
    await waitForBlockProcessed(env.clients[0], (d) => d.height > heightBefore, 20000);

    // Disconnect all peers → DEGRADED (resetSyncState cancels any pending retry timer)
    for (let i = 1; i < env.clients.length; i++) {
      // eslint-disable-next-line no-await-in-loop
      await env.disconnectNode(i);
    }
    await waitForOrchestratorState(env.clients[0], 'DEGRADED', 30000);

    // Counted by run STARTS: a run in flight at the transition still logs its
    // own ending lines afterwards, and only a retry begins another.
    const countAtDegraded = env.nodeLogCount(0, 'syncMissingHashes - Found');

    // Longer than the largest retry wait
    await new Promise((r) => { setTimeout(r, HASH_SYNC_RETRY_MAX_MS + 5000); });

    const countAfterWait = env.nodeLogCount(0, 'syncMissingHashes - Found');
    expect(countAfterWait).to.equal(countAtDegraded,
      'hash sync retry should not fire during DEGRADED');
  });
});

describe('Hash sync: attempts reset after degrade/recover', function () {
  let env;

  before(async function () {
    this.timeout(300000);
    env = await createTestEnv({
      hookCtx: this, nodes: 5, deferredNodes: 1, tickerAutostart: false, configOverrides: RETRY_CONFIG,
    });
    const client = await bootWithFailingLastNode(env);

    // Two failed passes, so the node carries attempts into the degrade below
    await client.waitForEvent('hashSync:failed', (d) => d.attempt === 2, 30000);
    await dbClient(env.lastNodeIndex + 1).failpointClear();
    await client.waitForEvent('hashSync:complete', () => true, 30000);

    // Block threshold is 250 (125 min * 2 blocks/min). Advance past it.
    await advanceBlocks(260);
    await waitForOrchestratorState(client, 'READY', 120000);
  });

  after(async function () {
    this.timeout(30000);
    await dbClient(env.lastNodeIndex + 1).failpointClear();
    await env?.teardown();
  });

  it('should run hash sync successfully after degrade/recover cycle', async function () {
    this.timeout(120000);
    const last = env.lastNodeIndex;
    const client = env.clients[last];
    const mark = client.getLastEventId();

    // Degrade: disconnect all its peers
    for (let i = 0; i < last; i++) {
      // eslint-disable-next-line no-await-in-loop
      await env.disconnectNode(i);
    }
    await waitForOrchestratorState(client, 'DEGRADED', 30000);

    // Reconnect peers → RESYNCING → hash sync runs with reset counter
    for (let i = 0; i < last; i++) {
      // eslint-disable-next-line no-await-in-loop
      await env.reconnectNode(i);
    }

    const event = await client.waitForEvent('hashSync:complete', () => true, 60000, { afterId: mark });
    expect(event.data.attempt).to.equal(1);
  });

  it('should retry if hash sync fails after recovery', async function () {
    this.timeout(180000);
    // ESTABLISH THE PRECONDITION RATHER THAN INHERIT IT. This test degrades a second time
    // and waits for the transition, which only happens from READY or SYNCING - so the node
    // has to BE in one of them first.
    //
    // The previous test leaves it in RESYNCING, and it does not come back on its own: a
    // degrade zeroes the block counter, so recovery needs a WHOLE fresh budget rather than
    // one more block, and nothing here is advancing blocks. Waiting for a state change from
    // RESYNCING is waiting for something the state machine will not do.
    const last = env.lastNodeIndex;
    const client = env.clients[last];
    await advanceBlocks(260);
    await waitForOrchestratorState(client, 'READY', 120000);

    const mark = client.getLastEventId();
    const db = dbClient(last + 1);

    // Degrade again
    for (let i = 0; i < last; i++) {
      // eslint-disable-next-line no-await-in-loop
      await env.disconnectNode(i);
    }
    await waitForOrchestratorState(client, 'DEGRADED', 30000, { afterId: mark });

    // Inject failpoint after DEGRADED — node is quiet (no blocks processing,
    // no explorer queries) so the failpoint won't be consumed before hash sync.
    await db.failpointFind('zelappshashes', { times: 1 });

    // Reconnect
    for (let i = 0; i < last; i++) {
      // eslint-disable-next-line no-await-in-loop
      await env.reconnectNode(i);
    }

    // The degrade reset the attempts, so this failure is the first again and
    // waits the minimum before its retry.
    const failEvent = await client.waitForEvent('hashSync:failed', () => true, 50000, { afterId: mark });
    expect(failEvent.data.attempt).to.equal(1);
    expect(failEvent.data.retryInMs).to.equal(HASH_SYNC_RETRY_MIN_MS);

    await db.failpointClear();

    const completeEvent = await client.waitForEvent('hashSync:complete', () => true, 30000, { afterId: failEvent.id });
    expect(completeEvent.data.attempt).to.equal(2);
  });
});

describe('Hash sync: block-timer retry with unresolvable hash', function () {
  let env;

  before(async function () {
    this.timeout(300000);
    env = await createTestEnv({ hookCtx: this, nodes: 5, tickerAutostart: false });
    await bootToReady(env);
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('should create unresolved hash from block with fake app tx', async function () {
    this.timeout(30000);
    const db = dbClient(1);
    const heightBefore = await db.explorerHeight();
    const fakeHash = 'abcdabcd'.repeat(8);
    await advanceBlock(fakeHash);
    await waitForBlockProcessed(env.clients[0], (d) => d.height > heightBefore, 20000);
    const counts = await db.hashCounts();
    expect(counts.missing).to.equal(1);
  });

  it('should trigger hash retry after enough blocks pass', async function () {
    this.timeout(60000);
    // Advance past hashSyncFallbackRecheckBlocks (10 in test config)
    // so checkHashRetry fires
    await advanceBlocks(12);
    await waitFor(
      () => env.nodeHasLog(0, 'Hash retry'),
      { timeout: 30000, interval: 2000, label: 'hash retry log' },
    );
    expect(env.nodeHasLog(0, 'Hash retry')).to.equal(true);
  });
});
