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
import { buildAppSpec, registerAndConfirm, waitForPricingVerdict } from '../framework/app-helper.js';
import { startTicker, advanceBlock, advanceBlocks } from '../framework/daemon-control.js';
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
      await waitForPricingVerdict(env.clients[0], dbClient(1), result.appHash);

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

    // The floor is the whole legacy fee, and it is also the explorer's
    // indexing bar: a tx paying under minPrice is never recorded as an app
    // transaction at all ("min of X flux had to be paid for us bothering
    // checking"). One satoshi under the floor is therefore refused by
    // INVISIBILITY - no promotion, no permanent message, no verdict - which in
    // the legacy regime (fee == floor == bar) is the only refusal shape an
    // underpaid update can have. The temp message's fleet-wide presence is the
    // control: the message travelled, and only the chain leg ignored it.
    it('is refused when it pays one satoshi under the floor', async function () {
      this.timeout(180000);
      const previous = await specOnNode(env.clients[0], appName);
      const updated = buildAppSpec({ name: appName, description: 'should never be applied' });
      const result = await registerAndConfirm(
        env.clients[0].url, nodeKey(1), updated, env.clients,
        { type: 'fluxappupdate', valueSat: FLOOR_SAT - 1 },
      );
      expect(result.status).to.equal('success');
      expect(result.tempPropagation.count, 'the message itself reached the fleet').to.equal(env.clients.length);
      await waitForBlockProcessed(env.clients[0], (d) => d.height >= result.targetHeight, 60000);

      // Settle two more blocks so a promotion that were going to happen has had
      // every trigger it will ever get, then assert the tx stayed invisible.
      await advanceBlocks(2);
      await waitForBlockProcessed(env.clients[0], (d) => d.height >= result.targetHeight + 2, 60000);

      expect(await dbClient(1).getPermanentMessage(result.appHash), 'no permanent message - the tx was never indexed').to.equal(null);
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

  // The defining property of the chain-floor regime: the floor is the whole fee
  // however big the app is. A big app's registration costs many times a small
  // one's, and its update costs the same 0.01 FLUX — which is the "two numbers,
  // on purpose" split, not an accident of size.
  describe('the floor does not scale with the app', function () {
    const appName = `e2eBig${Date.now()}`;

    function bigSpec(overrides = {}) {
      const spec = buildAppSpec({ name: appName, ...overrides });
      spec.compose = [{ ...spec.compose[0], cpu: 2, ram: 4000, hdd: 40 }];
      return spec;
    }

    before(async function () {
      this.timeout(180000);
      const registered = await registerAndConfirm(env.clients[0].url, nodeKey(1), bigSpec(), env.clients);
      expect(registered.status).to.equal('success');
      await waitForBlockProcessed(env.clients[0], (d) => d.height >= registered.targetHeight, 60000);
      await waitFor(
        async () => Boolean(await specOnNode(env.clients[0], appName)),
        { timeout: 60000, label: `registration row for ${appName}` },
      );
    });

    it('charges a large app the same floor to update as a small one', async function () {
      this.timeout(180000);
      const updated = bigSpec({ description: 'big app, floor fee' });
      const result = await registerAndConfirm(
        env.clients[0].url, nodeKey(1), updated, env.clients,
        { type: 'fluxappupdate', valueSat: FLOOR_SAT },
      );
      expect(result.status).to.equal('success');
      await waitForBlockProcessed(env.clients[0], (d) => d.height >= result.targetHeight, 60000);

      await waitFor(async () => {
        const current = await specOnNode(env.clients[0], appName);
        return current && current.description === 'big app, floor fee';
      }, { timeout: 60000, label: `big-app update applied for ${appName}` });
    });
  });
});
