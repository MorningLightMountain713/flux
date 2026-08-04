// weight: light
//
// The seam no unit test reaches: a confirmed update travelling the whole
// promotion path — real message, real chain confirmation, real pricing, real
// registry row. Every unit test either side of it stubs the other side, which
// is how an update came to be priced against itself.
//
// These specs are v1-v8, so this is the chain-floor regime: an update owes the
// minPrice floor and no more, deliberately, and that is what the network has
// enforced since height 1004000. What is pinned here is that it still does.
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { nodeKey } from '../framework/keys.js';
import { buildAppSpec, registerAndConfirm } from '../framework/app-helper.js';
import { startTicker, advanceBlock } from '../framework/daemon-control.js';
import { waitForDaemonReady, waitFor, waitForBlockProcessed, waitForNodeStatus } from '../framework/wait.js';
import { dbClient } from '../framework/db-client.js';

let env;

// 0.01 FLUX — the minPrice floor in force from height 1004000, and the whole
// consensus fee for a legacy update.
const FLOOR_SAT = 1000000;

async function specOnNode(client, appName) {
  const res = await client.getAppSpecs(appName);
  return res.status === 'success' && res.data ? res.data : null;
}

/**
 * Wait until the node has reached a verdict on a confirmed message.
 *
 * Promotion stores the permanent message before it prices anything, so the
 * message appearing means the fee has been computed and acted on. Waiting for
 * it is what lets a refusal be asserted as a refusal rather than as a race with
 * an acceptance that had not landed yet.
 */
async function waitForVerdict(client, appHash) {
  const db = dbClient(1);
  await waitFor(
    async () => Boolean(await db.getPermanentMessage(appHash)),
    { timeout: 60000, interval: 1000, label: `permanent message ${appHash.slice(0, 12)}` },
  );
  // The registry write follows in the same promotion, so let the node settle it
  // before reading the row.
  await waitFor(
    async () => (await client.isExplorerSynced()).data === true,
    { timeout: 60000, interval: 1000, label: 'explorer settled after promotion' },
  );
}

describe('App update pricing', function () {
  before(async function () {
    this.timeout(300000);
    env = await createTestEnv({ hookCtx: this, nodes: 10, tickerAutostart: false });
    await Promise.all(env.clients.map((c) => waitForDaemonReady(c)));
    await Promise.all(env.clients.map((c) => waitForNodeStatus(c, (d) => d.confirmed === true, 30000)));
    await advanceBlock();
    await waitForBlockProcessed(env.clients[0], (d) => d.height > 2100000, 50000);
    await env.startDiscovery();
    await env.clients[0].waitForEvent('peers:added', (d) => d.outbound >= 4, 120000);
    await env.clients[0].waitForEvent('peers:added', (d) => d.inbound >= 2, 120000);
    await startTicker();
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  // Registration is priced in full — an underpaid one is refused. Without this,
  // the update tests below could pass with the fee gate switched off entirely.
  describe('the fee gate is live', function () {
    const appName = `e2eUnderpaid${Date.now()}`;

    it('refuses a registration that pays the update floor rather than its price', async function () {
      this.timeout(180000);
      const spec = buildAppSpec({ name: appName });
      const result = await registerAndConfirm(
        env.clients[0].url, nodeKey(1), spec, env.clients, { valueSat: FLOOR_SAT },
      );
      expect(result.status).to.equal('success');
      await waitForBlockProcessed(env.clients[0], (d) => d.height >= result.targetHeight, 60000);
      await waitForVerdict(env.clients[0], result.appHash);

      expect(await specOnNode(env.clients[0], appName)).to.equal(null);
    });
  });

  describe('a confirmed update', function () {
    const appName = `e2eUpdate${Date.now()}`;
    const UPDATED = 'updated through the chain';
    let originalSpec;

    before(async function () {
      this.timeout(180000);
      const spec = buildAppSpec({ name: appName });
      const registered = await registerAndConfirm(env.clients[0].url, nodeKey(1), spec, env.clients);
      expect(registered.status).to.equal('success');
      await waitForBlockProcessed(env.clients[0], (d) => d.height >= registered.targetHeight, 60000);
      await waitFor(
        async () => Boolean(await specOnNode(env.clients[0], appName)),
        { timeout: 60000, label: `registration row for ${appName}` },
      );
      originalSpec = await specOnNode(env.clients[0], appName);
    });

    // The whole path in one assertion: the update is priced against the spec it
    // supersedes, clears the floor, and replaces the row.
    it('is applied when it pays the floor', async function () {
      this.timeout(180000);
      const updated = buildAppSpec({ name: appName, description: UPDATED });
      const result = await registerAndConfirm(
        env.clients[0].url, nodeKey(1), updated, env.clients,
        { type: 'fluxappupdate', valueSat: FLOOR_SAT },
      );
      expect(result.status).to.equal('success');
      await waitForBlockProcessed(env.clients[0], (d) => d.height >= result.targetHeight, 60000);

      await waitFor(async () => {
        const current = await specOnNode(env.clients[0], appName);
        return current && current.description === UPDATED;
      }, { timeout: 60000, label: `updated spec for ${appName}` });

      const current = await specOnNode(env.clients[0], appName);
      expect(current.description).to.equal(UPDATED);
      expect(current.description).to.not.equal(originalSpec.description);
    });

    // The floor is the whole legacy fee, so an update one satoshi under it is
    // refused. This is what pins the legacy regime: were its resolution to
    // change, the required fee would rise above the floor and the accepted case
    // above would start failing — this one holds the other edge.
    it('is refused when it pays one satoshi under the floor', async function () {
      this.timeout(180000);
      const previous = await specOnNode(env.clients[0], appName);
      const updated = buildAppSpec({ name: appName, description: 'should never be applied' });
      const result = await registerAndConfirm(
        env.clients[0].url, nodeKey(1), updated, env.clients,
        { type: 'fluxappupdate', valueSat: FLOOR_SAT - 1 },
      );
      expect(result.status).to.equal('success');
      await waitForBlockProcessed(env.clients[0], (d) => d.height >= result.targetHeight, 60000);
      await waitForVerdict(env.clients[0], result.appHash);

      const current = await specOnNode(env.clients[0], appName);
      expect(current.description).to.equal(previous.description);
    });

    it('reaches every node, not just the one it was submitted to', async function () {
      this.timeout(120000);
      await waitFor(async () => {
        const specs = await Promise.all(env.clients.map((c) => specOnNode(c, appName)));
        return specs.every((s) => s && s.description === UPDATED);
      }, { timeout: 90000, label: `updated spec on all ${env.clients.length} nodes` });
    });
  });
});
