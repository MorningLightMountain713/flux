// weight: heavy
import { describe, it, before, after, afterEach } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import {
  advanceBlock, advanceBlocks, setNodeList, removeFromNodeList, restoreToNodeList, resetNodeList,
  getJournal, clearJournal, publishZmq, skipZmqSeq, silenceZmq, resumeZmq,
  restartZmqPublisher, getZmqState, reorgChain, getState,
} from '../framework/daemon-control.js';
import {
  waitForDaemonReady, waitForSubscriptionsStarted, waitForSubscriptionMode,
  waitForListAnchored, waitForDeltaApplied, waitForDeltaRefused, waitForReorg,
  waitForResync, waitFor, assertNoEvent,
} from '../framework/wait.js';
import { getSubnetConfig } from '../framework/subnet-config.js';

const subnet = getSubnetConfig();

// An asymmetric hash. 'ab' repeated is a palindrome under byte reversal and would let a
// reversed encoder through, which is the mistake every earlier client made.
const FOREIGN_HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('Daemon subscriptions: the push path', function () {
  let env;
  let client;

  before(async function () {
    this.timeout(180000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 1,
      tickerAutostart: false,
      zmqTopics: ALL_ZMQ_TOPICS,
    });
    client = env.clients[0];
    await waitForDaemonReady(client);
  });

  after(async function () {
    this.timeout(30000);
    await resetNodeList().catch(() => {});
    await resumeZmq().catch(() => {});
    await env?.teardown();
  });

  it('should subscribe to every topic the daemon publishes', async function () {
    this.timeout(60000);

    const started = await waitForSubscriptionsStarted(client);

    expect(started.data.topics).to.have.members(ALL_ZMQ_TOPICS.filter((t) => t !== 'hashblock'));
    expect(started.data.endpoint).to.contain(':16123');
  });

  it('should put every source on push rather than its polling fallback', async function () {
    this.timeout(60000);

    // Each source decides independently, so each is asserted independently — a source
    // silently polling while the others push is exactly the failure worth catching.
    await waitForSubscriptionMode(client, 'chainTipSource', 'push');
    await waitForSubscriptionMode(client, 'nodeListSource', 'push');
    await waitForSubscriptionMode(client, 'reorgSource', 'push');
  });

  it('should anchor the node list from the atomic snapshot', async function () {
    this.timeout(60000);

    const anchored = await waitForListAnchored(client);
    const chain = await getState();

    expect(anchored.data.reason).to.equal('startup');
    expect(anchored.data.nodes).to.be.greaterThan(0);
    expect(anchored.data.height).to.be.at.most(chain.currentHeight);
  });

  it('should track the chain by delta, never refetching the whole list', async function () {
    this.timeout(120000);

    await clearJournal();
    const start = (await getState()).currentHeight;

    const applied = [];
    for (let i = 0; i < 5; i += 1) {
      const height = start + i + 1;
      // eslint-disable-next-line no-await-in-loop
      const seen = waitForDeltaApplied(client, (d) => d.toHeight === height);
      // eslint-disable-next-line no-await-in-loop
      await advanceBlock();
      // eslint-disable-next-line no-await-in-loop
      applied.push((await seen).data);
    }

    // The whole economic case: the list stayed current without the ~7 MB fetch that
    // used to run about once a block.
    const full = await getJournal({ method: 'viewdeterministiczelnodelist', server: 'fluxd' });
    expect(full.total, 'the full list was refetched').to.equal(0);

    expect(applied).to.have.lengthOf(5);
    applied.forEach((delta) => {
      expect(delta.toHeight).to.equal(delta.fromHeight + 1);
    });
  });

  it('should resolve an added node without refetching the list', async function () {
    this.timeout(90000);

    // A one-node fleet leaves the stub holding a single entry, so removing any other
    // node is a no-op that publishes no delta and times out looking like a dead
    // subscription. Seed a list the removal can actually take a node out of, keeping
    // this node in it so its own confirmed state is unaffected.
    await setNodeList([
      { ip: subnet.nodeIp(1) },
      { ip: subnet.nodeIp(2) },
      { ip: subnet.nodeIp(3) },
      { ip: subnet.nodeIp(4) },
    ]);

    const removedIp = subnet.nodeIp(4);
    await removeFromNodeList(removedIp);
    await waitForDeltaApplied(client, (d) => d.removed > 0);

    await clearJournal();
    const readded = waitForDeltaApplied(client, (d) => d.added > 0);
    await restoreToNodeList(removedIp);
    const delta = (await readded).data;

    expect(delta.added).to.equal(1);

    // added_height is not on the wire and decides peer selection, so each addition costs
    // one filtered lookup — and only one.
    const lookups = await getJournal({ method: 'viewdeterministicfluxnodelist', server: 'fluxd' });
    const unfiltered = await getJournal({ method: 'viewdeterministiczelnodelist', server: 'fluxd' });
    expect(lookups.total + unfiltered.total).to.equal(1);
  });
});

describe('Daemon subscriptions: recovering from loss', function () {
  let env;
  let client;

  before(async function () {
    this.timeout(180000);
    env = await createTestEnv({
      hookCtx: this, nodes: 1, tickerAutostart: false, zmqTopics: ALL_ZMQ_TOPICS,
    });
    client = env.clients[0];
    await waitForDaemonReady(client);
    await waitForListAnchored(client);
  });

  afterEach(async function () {
    this.timeout(20000);
    await resumeZmq().catch(() => {});
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('should resync when messages were missed rather than apply the next one', async function () {
    this.timeout(90000);

    const gap = waitForResync(client, (d) => d.reason === 'message_gap');
    await skipZmqSeq('fluxnodelistdelta', 3);
    await advanceBlock();

    const resync = await gap;
    expect(resync.data.topic).to.equal('fluxnodelistdelta');

    // Nothing is replayed, so the only repair is a fresh snapshot.
    const anchored = await waitForListAnchored(client, (d) => d.reason !== 'startup');
    expect(anchored.data.nodes).to.be.greaterThan(0);
  });

  it('should refuse a delta that does not chain onto what it holds', async function () {
    this.timeout(90000);

    const chain = await getState();
    const refused = waitForDeltaRefused(client);

    // from_hash names a block this node never held, which is the signature of divergence
    // and must never be applied over good state.
    await publishZmq({
      topic: 'fluxnodelistdelta',
      fields: {
        fromHeight: chain.currentHeight,
        toHeight: chain.currentHeight + 1,
        fromHash: FOREIGN_HASH,
        toHash: FOREIGN_HASH,
        added: [],
        removed: [],
        updated: [],
      },
    });

    expect((await refused).data.reason).to.equal('chain_mismatch');
    await waitForListAnchored(client, (d) => d.reason !== 'startup');
  });

  it('should treat a restarted publisher as a restart, not as loss', async function () {
    this.timeout(90000);

    // Sequence counters live in the daemon's memory, so a restart rewinds them to zero.
    // Read as a gap that would resync on every daemon bounce.
    await restartZmqPublisher();
    const state = await getZmqState();
    expect(state.nextSeq.hashblockheight ?? 0).to.equal(0);

    const applied = waitForDeltaApplied(client);
    await advanceBlocks(2);
    await applied;
  });

  it('should keep applying deltas after the socket comes back', async function () {
    this.timeout(120000);

    await silenceZmq('all');
    await advanceBlocks(2);
    await resumeZmq();

    const applied = waitForDeltaApplied(client);
    await advanceBlock();
    const delta = (await applied).data;

    const chain = await getState();
    expect(delta.toHeight).to.equal(chain.currentHeight);
  });
});

describe('Daemon subscriptions: reorgs', function () {
  let env;
  let client;

  before(async function () {
    this.timeout(180000);
    env = await createTestEnv({
      hookCtx: this, nodes: 1, tickerAutostart: false, zmqTopics: ALL_ZMQ_TOPICS,
    });
    client = env.clients[0];
    await waitForDaemonReady(client);
    await waitForListAnchored(client);
    await advanceBlocks(10);
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('should report the fork height, which nothing else supplies', async function () {
    this.timeout(90000);

    const before = await getState();
    const seen = waitForReorg(client);
    const reorg = await reorgChain({ depth: 3 });

    const event = (await seen).data;
    expect(event.forkHeight).to.equal(reorg.fork.height);
    expect(event.oldTipHeight).to.equal(before.currentHeight);
    expect(event.depth).to.be.greaterThan(0);
  });

  it('should accept a replacement block at the same height', async function () {
    this.timeout(90000);

    const before = await getState();
    const seen = waitForReorg(client);
    await reorgChain({ depth: 1, newHeight: before.currentHeight });

    const event = (await seen).data;
    expect(event.newTipHeight).to.equal(event.oldTipHeight);

    // Same height, different block — identity is the hash, never the number.
    const after = await getState();
    expect(after.bestBlockHash).to.not.equal(before.bestBlockHash);
  });

  it('should accept a chain that got shorter', async function () {
    this.timeout(90000);

    const before = await getState();
    const seen = waitForReorg(client);
    await reorgChain({ depth: 4, newHeight: before.currentHeight - 2 });

    const event = (await seen).data;
    expect(event.newTipHeight).to.be.lessThan(event.oldTipHeight);

    // The list has to keep tracking a tip that moved backwards.
    const applied = waitForDeltaApplied(client);
    await advanceBlock();
    expect((await applied).data.toHeight).to.be.greaterThan(event.newTipHeight);
  });
});

describe('Daemon subscriptions: silence is not death', function () {
  let env;
  let client;

  before(async function () {
    this.timeout(180000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 1,
      tickerAutostart: false,
      zmqTopics: ALL_ZMQ_TOPICS,
      // Reach the silence threshold inside a test rather than in ninety seconds.
      configOverrides: {
        daemon: { subscriptions: { silenceThresholdMs: 5000, livenessCheckIntervalMs: 1000 } },
      },
    });
    client = env.clients[0];
    await waitForDaemonReady(client);
  });

  after(async function () {
    this.timeout(30000);
    await resumeZmq().catch(() => {});
    await env?.teardown();
  });

  it('should not declare a quiet daemon dead while it still answers', async function () {
    this.timeout(90000);

    // A quiet chain and a dead publisher look identical on the socket. Only a failed RPC
    // probe may produce a verdict, because that verdict sheds every app on the node.
    await silenceZmq('all');

    await assertNoEvent(client, 'daemon:unreachable', () => true, 20000);

    await resumeZmq();
    const applied = waitForDeltaApplied(client);
    await advanceBlock();
    await applied;
  });
});

describe('Daemon subscriptions: the polling fallback', function () {
  let env;
  let client;

  before(async function () {
    this.timeout(180000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 1,
      tickerAutostart: false,
      // The mixed case the capability detection exists for: this daemon publishes blocks
      // but not the node list, so one source pushes while another polls.
      zmqTopics: ['hashblock', 'hashblockheight', 'chainreorg'],
    });
    client = env.clients[0];
    await waitForDaemonReady(client);
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('should push the topics it has and poll the ones it does not', async function () {
    this.timeout(60000);

    await waitForSubscriptionMode(client, 'chainTipSource', 'push');
    await waitForSubscriptionMode(client, 'nodeListSource', 'poll');
  });

  it('should keep the node list correct on the fetch path', async function () {
    this.timeout(120000);

    const removedIp = subnet.nodeIp(4);
    await removeFromNodeList(removedIp);
    await advanceBlocks(2);

    await waitFor(async () => {
      const peers = await client.getFluxInfo();
      return peers.status === 'success';
    }, { timeout: 60000, interval: 2000, label: 'node answering on the fetch path' });

    // No delta can have been applied, because no delta was published.
    await assertNoEvent(client, 'daemon:deltaApplied', () => true, 5000);
    await restoreToNodeList(removedIp);
  });
});
