// weight: light
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import {
  waitForDaemonReady, waitForNodeStatus, waitForBlockProcessed,
  waitForExplorerReady, waitForOrchestratorStarted, waitForOrchestratorState,
  waitForPeerThreshold, waitForMessageCapabilityChanged,
  waitForSpawnerPaused, waitForSpawnerResumed,
} from '../framework/wait.js';
import {
  advanceBlock, advanceBlocks, startTicker, stopTicker,
  enableRpcFailure, disableAllRpcFailure, clearAllNodeStatus,
} from '../framework/daemon-control.js';

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

describe('Compound failures: peer loss + daemon failure during READY', function () {
  let env;

  before(async function () {
    this.timeout(300000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 5,
      tickerAutostart: false,
      configOverrides: {
        // An unreachable daemon deliberately PRESERVES message capability - the
        // node still knows who it is and can still broadcast - so the only thing
        // that withdraws it while the poll goes unanswered is the confirmation
        // ageing out on chain. The stub confirms every node 10 blocks back, so a
        // limit of 11 leaves one block owed: reachable either as a couple of
        // blocks on the live chain view or as one block's worth of time once that
        // view goes stale. Nodes that can still poll are untouched by the limit -
        // the expiry branch only runs for a node with no answer at all.
        confirmation: { confirmExpirationBlocks: 11, blockIntervalMs: 10000 },
      },
    });
    await bootToReady(env);
  });

  after(async function () {
    this.timeout(30000);
    await disableAllRpcFailure();
    await clearAllNodeStatus();
    await env?.teardown();
  });

  it('should enter DEGRADED and pause spawner exactly once', async function () {
    this.timeout(60000);
    await enableRpcFailure(env.clients[0].ip);
    for (let i = 1; i < env.clients.length; i++) {
      await env.disconnectNode(i);
    }
    await waitForOrchestratorState(env.clients[0], 'DEGRADED', 30000);
    await waitForSpawnerPaused(env.clients[0], 10000);

    const pauseEvents = env.clients[0].getEventBuffer()
      .filter((e) => e.event === 'spawner:paused');
    expect(pauseEvents.length).to.equal(1, 'READINESS_LOST should fire exactly once');
  });

  it('should enter RESYNCING but NOT READY once the stranded confirmation expires', async function () {
    this.timeout(180000);
    for (let i = 1; i < env.clients.length; i++) {
      await env.reconnectNode(i);
    }
    await waitForOrchestratorState(env.clients[0], 'RESYNCING', 60000);

    // Establish the premise rather than assuming it. Losing the daemon does not
    // cost the node its capability, so this waits for the node to say the
    // capability is gone and takes that event as the floor - everything before it
    // is a node that was still entitled to go READY, and counting it would make
    // the assertion true or false for reasons that have nothing to do with the
    // rule under test.
    await advanceBlocks(260);
    const lost = await waitForMessageCapabilityChanged(env.clients[0], false, 90000);

    // Only now is denying promotion meaningful, so drive the block timer here:
    // the assertion has to be given the chance it is denying.
    await advanceBlocks(260);
    const stateEvents = env.clients[0].getEventBuffer()
      .filter((e) => e.event === 'orchestrator:stateChanged' && e.id > lost.id);
    const reachedReady = stateEvents.find((e) => e.data.to === 'READY');
    expect(reachedReady, 'should not reach READY while canSendMessages is false').to.be.undefined;
  });

  it('should fully recover to READY when RPC restored', async function () {
    this.timeout(120000);
    await disableAllRpcFailure();
    await startTicker();
    await waitForOrchestratorState(env.clients[0], 'READY', 90000);
    await waitForSpawnerResumed(env.clients[0], 10000);
  });
});

describe('Compound failures: rapid peer oscillation', function () {
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

  it('should not be stuck in DEGRADED after reconnecting all peers', async function () {
    this.timeout(60000);
    for (let i = 1; i < env.clients.length; i++) {
      await env.disconnectNode(i);
    }
    for (let i = 1; i < env.clients.length; i++) {
      await env.reconnectNode(i);
    }
    for (let i = 1; i < env.clients.length; i++) {
      await env.disconnectNode(i);
    }
    for (let i = 1; i < env.clients.length; i++) {
      await env.reconnectNode(i);
    }

    // Wait for READY or RESYNCING — either means not stuck in DEGRADED
    await waitForOrchestratorState(env.clients[0], 'READY', 30000).catch(() => {});
    const stateEvents = env.clients[0].getEventBuffer()
      .filter((e) => e.event === 'orchestrator:stateChanged');
    const lastState = stateEvents[stateEvents.length - 1];
    expect(['READY', 'RESYNCING']).to.include(lastState.data.to,
      'should not be stuck in DEGRADED with peers connected');
  });
});
