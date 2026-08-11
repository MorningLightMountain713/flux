// weight: heavy
import { describe, it, before, after, afterEach } from 'mocha';
import { expect } from 'chai';
import { createTestEnv, deterministicNodes } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS, ALL_ZMQ_TOPICS_WITH_STATUS } from '../framework/fluxd-conf.js';
import {
  advanceBlock, advanceBlocks, setNodeList, removeFromNodeList, restoreToNodeList, resetNodeList,
  getJournal, clearJournal, publishZmq, skipZmqSeq, silenceZmq, resumeZmq,
  restartZmqPublisher, getZmqState, reorgChain, getState,
} from '../framework/daemon-control.js';
import {
  waitForDaemonReady, waitForSubscriptionsStarted, waitForSubscriptionMode, waitForBlockProcessed,
  waitForListAnchored, waitForDeltaApplied, waitForDeltaRefused, waitForReorg,
  waitForResync, waitFor, assertNoEvent, waitForOwnStatus,
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
    // subscription. These carry outpoints because that, not the address, is what
    // identifies a node on the wire: entries without one collapse together under the
    // diff and a removal among them publishes nothing.
    await setNodeList(deterministicNodes(4));

    // Seeding re-bases what the next delta is measured against without publishing
    // anything, so the node is still holding the list it anchored at startup. Bounce
    // the publisher to make it take a fresh snapshot, otherwise the removal below
    // announces a node this one never had and applies as no change at all.
    await restartZmqPublisher();
    await waitForListAnchored(client, (d) => d.reason !== 'startup');

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

    // A gap is the distance from the last sequence this node held, so it needs to
    // hold one first. Straight after anchoring there is no baseline and the first
    // delta to arrive cannot be short of anything, however far the counter was
    // moved — the snapshot already covers everything before it.
    const baseline = (await getState()).currentHeight + 1;
    const settled = waitForDeltaApplied(client, (d) => d.toHeight === baseline);
    await advanceBlock();
    await settled;

    const before = await getZmqState();
    const gap = waitForResync(client, (d) => d.reason === 'message_gap');
    await skipZmqSeq('fluxnodelistdelta', 3);
    const skipped = await getZmqState();
    await advanceBlock();
    const after = await getZmqState();

    // Which side to look at if this fails. The skip has to move the counter, and the
    // block after it has to consume one more: a stub that published nothing leaves
    // this unchanged, and a gap the node never acted on leaves it advanced.
    expect(skipped.nextSeq.fluxnodelistdelta, 'the skip did not move the counter')
      .to.be.greaterThan(before.nextSeq.fluxnodelistdelta ?? 0);
    expect(after.nextSeq.fluxnodelistdelta, 'the block published no delta')
      .to.be.greaterThan(skipped.nextSeq.fluxnodelistdelta);

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
    // A rewind must read as a restart and never as messages lost.
    const anchored = waitForListAnchored(client, (d) => d.reason === 'reconnected');
    const noLoss = assertNoEvent(client, 'daemon:resync', (d) => d.reason === 'message_gap', 20000);

    await restartZmqPublisher();
    const state = await getZmqState();
    expect(state.nextSeq.hashblockheight ?? 0).to.equal(0);

    // Sequence continuity cannot survive the bounce, so the repair is a fresh
    // snapshot rather than the deltas for whatever moved meanwhile. Asking for
    // deltaApplied here would be asking the node to replay what it deliberately
    // does not keep.
    await advanceBlocks(2);
    expect((await anchored).data.nodes).to.be.greaterThan(0);
    await noLoss;

    // And the stream is live afterwards: the next block chains onto the new anchor.
    const target = (await getState()).currentHeight + 1;
    const applied = waitForDeltaApplied(client, (d) => d.toHeight === target);
    await advanceBlock();
    await applied;
  });

  it('should keep applying deltas after the socket comes back', async function () {
    this.timeout(120000);

    // Silencing consumes no sequence, so nothing announces the blocks that passed
    // while the stream was quiet. The first delta after it therefore starts above
    // the height this node holds and cannot be applied over good state.
    //
    // Both waits are pinned above the current height, not just to their reason. The
    // previous test in this fleet refuses a delta and re-anchors for the same two
    // reasons, and those events are still in the stream's buffer — matching them
    // would satisfy this test before it has done anything.
    const from = (await getState()).currentHeight;
    const refused = waitForDeltaRefused(client, (d) => d.reason === 'chain_mismatch' && d.toHeight > from);
    const anchored = waitForListAnchored(client, (d) => d.reason === 'delta_refused' && d.height > from);

    await silenceZmq('all');
    await advanceBlocks(2);
    await resumeZmq();
    await advanceBlock();

    await refused;
    await anchored;

    // Recovered, not merely reconnected: the block after the re-anchor chains onto
    // it and applies, which is the half that proves the stream is carrying state
    // again rather than just being open.
    const target = (await getState()).currentHeight + 1;
    const applied = waitForDeltaApplied(client, (d) => d.toHeight === target);
    await advanceBlock();
    expect((await applied).data.toHeight).to.equal(target);
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
    // The reorg is driven first and its own fork height identifies the event. The
    // previous test's reorg also left the tip where it found it, so an unpinned wait
    // is satisfied by that one and this test proves nothing.
    const reorg = await reorgChain({ depth: 1, newHeight: before.currentHeight });
    const event = (await waitForReorg(client, (d) => d.forkHeight === reorg.fork.height)).data;

    expect(event.newTipHeight).to.equal(event.oldTipHeight);
    expect(event.newTipHeight).to.equal(before.currentHeight);

    // Same height, different block — identity is the hash, never the number.
    const after = await getState();
    expect(after.bestBlockHash).to.not.equal(before.bestBlockHash);
  });

  it('should accept a chain that got shorter', async function () {
    this.timeout(90000);

    const before = await getState();
    const reorg = await reorgChain({ depth: 4, newHeight: before.currentHeight - 2 });
    const event = (await waitForReorg(client, (d) => d.forkHeight === reorg.fork.height)).data;

    expect(event.newTipHeight).to.be.lessThan(event.oldTipHeight);

    // The list has to keep tracking a tip that moved backwards.
    const target = (await getState()).currentHeight + 1;
    const applied = waitForDeltaApplied(client, (d) => d.toHeight === target);
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
    const target = (await getState()).currentHeight + 1;
    const applied = waitForDeltaApplied(client, (d) => d.toHeight === target);
    await advanceBlock();
    await applied;
  });
});

describe('Daemon subscriptions: the scan on a daemon with no block events', function () {
  let env;
  let client;

  before(async function () {
    this.timeout(180000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 1,
      tickerAutostart: false,
      // Publishes nothing at all, so the scan has no block event to wake it and falls
      // back to its own timer. That timer is the only thing keeping this node's view
      // of the chain moving.
      zmqTopics: [],
    });
    client = env.clients[0];
    await waitForDaemonReady(client);
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('should keep scanning after a drain that had work to do', async function () {
    this.timeout(120000);

    const first = (await getState()).currentHeight + 1;
    const seenFirst = waitForBlockProcessed(client, (d) => d.height >= first, 60000);
    await advanceBlock();
    await seenFirst;

    // The second block is the assertion; the first only proves the scan ran once.
    // Arming the fallback timer solely on the exit where a drain found nothing to do
    // left a node that scanned a backlog and then slept while the chain moved on —
    // and it logged nothing, because a scanner doing no work is indistinguishable
    // from a scanner with no work.
    const second = (await getState()).currentHeight + 1;
    const seenSecond = waitForBlockProcessed(client, (d) => d.height >= second, 60000);
    await advanceBlock();
    await seenSecond;
  });
});

describe('Daemon subscriptions: own status on a per-node socket', function () {
  let env;

  before(async function () {
    this.timeout(240000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 2,
      tickerAutostart: false,
      // Own status is about the receiver, not the chain, so it only means anything
      // addressed. Each node reads from its own publisher; the fleet-wide topics are
      // fanned out to those same sockets, which the second test here pins.
      zmqTopics: ALL_ZMQ_TOPICS_WITH_STATUS,
      perNodeZmq: true,
    });
    await Promise.all(env.clients.map((c) => waitForDaemonReady(c)));
    await Promise.all(env.clients.map((c) => waitForSubscriptionsStarted(c)));
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('should put own status on push when the daemon publishes the topic', async function () {
    this.timeout(60000);
    await Promise.all(env.clients.map((c) => waitForSubscriptionMode(c, 'fluxnodeStatusSource', 'push')));
  });

  it('should deliver a status to the node it names, and to no other', async function () {
    this.timeout(120000);
    const chain = await getState();
    const targetNum = 2;
    const target = env.clients[targetNum - 1];
    const other = env.clients[0];

    // The other node's cursor is taken BEFORE the publish. assertNoEvent takes its own
    // cursor when it is called, which here would be after the delivery it is meant to
    // rule out — a window that opens too late cannot see what it is looking for, and
    // would pass for that reason rather than because nothing arrived.
    const otherBefore = other.getLastEventId();
    const seen = waitForOwnStatus(
      target,
      (d) => d.lastConfirmedHeight === chain.currentHeight,
      60000,
      { afterId: target.getLastEventId() },
    );

    await publishZmq({
      topic: 'fluxnodestatus',
      node: targetNum,
      fields: {
        blockHeight: chain.currentHeight,
        status: 'CONFIRMED',
        tier: 'CUMULUS',
        confirmedHeight: chain.currentHeight - 100,
        lastConfirmedHeight: chain.currentHeight,
        lastPaidHeight: chain.currentHeight - 50,
        txhash: '0'.repeat(64),
        outidx: 0,
        ip: env.clients[targetNum - 1].ip,
      },
    });

    await seen;

    // The whole point of the per-node socket: on the shared publisher this same message
    // would have told BOTH nodes they were the confirmed one.
    const leaked = other.getEventBuffer().find(
      (e) => e.event === 'daemon:ownStatus' && e.id > otherBefore
        && e.data.lastConfirmedHeight === chain.currentHeight,
    );
    expect(leaked, `node 1 must not receive node ${targetNum}'s status`).to.equal(undefined);
  });

  it('should still see the fleet-wide chain on its own socket', async function () {
    this.timeout(90000);
    // A node dialling its own port must not end up on a private, quieter chain: the
    // fleet-wide topics are fanned out to every per-node socket, and a block is the
    // cheapest proof that fan-out reaches both of them.
    const next = (await getState()).currentHeight + 1;
    const seen = env.clients.map((c) => waitForBlockProcessed(c, (d) => d.height >= next, 60000));
    await advanceBlock();
    await Promise.all(seen);
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
