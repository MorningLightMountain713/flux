// fleet: 11
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { nodeKey } from '../framework/keys.js';
import { buildAppSpec, registerAndConfirm } from '../framework/app-helper.js';
import { waitForDaemonReady, waitForBlockProcessed, waitFor, waitForNodeStatus } from '../framework/wait.js';
import { advanceBlock, startTicker } from '../framework/daemon-control.js';
import { dbClient } from '../framework/db-client.js';

async function bootAndPeer(env) {
  for (const client of env.clients) {
    if (client) await waitForDaemonReady(client);
  }
  for (const client of env.clients) {
    if (client) await waitForNodeStatus(client, (d) => d.confirmed === true, 30000);
  }
  await advanceBlock();
  for (const client of env.clients) {
    if (client) await waitForBlockProcessed(client, (d) => d.height > env.initialHeight, 50000);
  }
  await env.startDiscovery();
  await env.clients[0].waitForEvent('peers:added', (d) => d.total >= 6, 120000);
  await startTicker();
}

async function registerApp(env, { excludeNodes = [] } = {}) {
  const appName = `e2eHash${Date.now()}`;
  const spec = buildAppSpec({ name: appName, instances: 3 });
  const onlineClients = env.clients.filter((c, i) => c !== null && !excludeNodes.includes(i));
  const result = await registerAndConfirm(env.clients[0].url, nodeKey(1), spec, onlineClients);
  expect(result.status).to.equal('success');
  return { appName, appHash: result.appHash };
}

async function waitForHashResolved(nodeNum, initialResolved, timeout = 120000) {
  const db = dbClient(nodeNum);
  await waitFor(async () => {
    const counts = await db.hashCounts();
    return counts.resolved > initialResolved;
  }, { timeout, interval: 5000, label: `hash resolved on node ${nodeNum} via sync` });
}

describe('Hash sync: late-joining node', function () {
  let env;

  before(async function () {
    this.timeout(300000);
    env = await createTestEnv({ hookCtx: this, nodes: 10, deferredNodes: 1, tickerAutostart: false });
    await bootAndPeer(env);

    await registerApp(env);

    await waitFor(async () => {
      const counts = await dbClient(1).hashCounts();
      return counts.resolved > 0;
    }, { timeout: 60000, interval: 5000, label: 'node 1 has resolved hash' });

    await env.startNode(env.lastNodeIndex);
    await waitForDaemonReady(env.clients[env.lastNodeIndex]);
    await waitForNodeStatus(env.clients[env.lastNodeIndex], (d) => d.confirmed === true, 30000);
    await waitForBlockProcessed(env.clients[env.lastNodeIndex], (d) => d.height > env.initialHeight, 60000);
    await env.startDiscovery();
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('should resolve hash by fetching permanent message from peers', async function () {
    this.timeout(120000);
    await waitForHashResolved(env.nodeCount, 0);
    const counts = await dbClient(env.nodeCount).hashCounts();
    expect(counts.resolved).to.be.greaterThan(0);
  });

  it('should create permanent message from resolved hash', async function () {
    const count = await dbClient(env.nodeCount).permanentMessageCount();
    expect(count).to.be.greaterThan(0);
  });

  it('should create app spec from permanent message', async function () {
    this.timeout(60000);
    await waitFor(async () => (await dbClient(env.nodeCount).appSpecCount()) > 0,
      { timeout: 50000, interval: 5000, label: `app spec on node ${env.nodeCount}` });
    expect(await dbClient(env.nodeCount).appSpecCount()).to.be.greaterThan(0);
  });
});

describe('Hash sync: network partition', function () {
  let env;

  before(async function () {
    this.timeout(300000);
    env = await createTestEnv({ hookCtx: this, nodes: 10, tickerAutostart: false });
    await bootAndPeer(env);

    await env.disconnectNode(env.lastNodeIndex);

    await registerApp(env, { excludeNodes: [env.lastNodeIndex] });

    await waitFor(async () => {
      const counts = await dbClient(1).hashCounts();
      return counts.resolved > 0;
    }, { timeout: 60000, interval: 5000, label: 'node 1 has resolved hash' });

    await env.reconnectNode(env.lastNodeIndex);
    await waitForDaemonReady(env.clients[env.lastNodeIndex]);
    await waitForBlockProcessed(env.clients[env.lastNodeIndex], () => true, 60000);
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('should resolve hash after reconnecting to network', async function () {
    this.timeout(120000);
    await waitForHashResolved(env.nodeCount, 0);
    const counts = await dbClient(env.nodeCount).hashCounts();
    expect(counts.resolved).to.be.greaterThan(0);
  });

  it('should create permanent message from resolved hash', async function () {
    const count = await dbClient(env.nodeCount).permanentMessageCount();
    expect(count).to.be.greaterThan(0);
  });

  it('should create app spec from permanent message', async function () {
    this.timeout(60000);
    await waitFor(async () => (await dbClient(env.nodeCount).appSpecCount()) > 0,
      { timeout: 50000, interval: 5000, label: `app spec on node ${env.nodeCount}` });
    expect(await dbClient(env.nodeCount).appSpecCount()).to.be.greaterThan(0);
  });
});

// A node that holds a message's payment and has lost its contents asks its
// peers for them again and stores the same message.
describe('Hash sync: stale state recovery', function () {
  let env;
  let appHash;
  let db;

  before(async function () {
    this.timeout(300000);
    env = await createTestEnv({ hookCtx: this, nodes: 10, tickerAutostart: false });
    await bootAndPeer(env);
    ({ appHash } = await registerApp(env));

    db = dbClient(env.nodeCount);
    await waitFor(async () => (await db.appHashRecord(appHash))?.message === true,
      { timeout: 60000, interval: 5000, label: `node ${env.nodeCount} holds the message` });
    await db.deletePermanentMessage(appHash);
    // The canary: the node holds the payment and not the contents.
    const record = await db.appHashRecord(appHash);
    expect(record.message, 'the contents are gone').to.equal(false);
    expect(record.txid, 'the payment stays').to.be.a('string');
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('stores the message again from its peers', async function () {
    this.timeout(240000);
    await waitFor(async () => (await db.appHashRecord(appHash))?.message === true,
      { timeout: 210000, interval: 2000, label: `node ${env.nodeCount} stored the message again` });
  });

  it('holds exactly that message again', async () => {
    expect((await db.appMessages({ hash: appHash, held: true })).map((m) => m.hash)).to.deep.equal([appHash]);
  });
});
