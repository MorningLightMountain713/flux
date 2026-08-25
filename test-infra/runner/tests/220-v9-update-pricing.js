// weight: medium
//
// v9 pricing, end to end: real messages, real blocks, the real PricingEngine,
// the real registry row. v9 is the unified regime — the on-chain price equals
// the display price — so unlike the chain-floor suite next door, what an update
// owes here actually depends on what it asks for.
//
// Every scenario the update path can be in is covered: no price on chain at
// all, registration paid and underpaid, an update that grows the app, one that
// changes nothing, one that asks for more time, a cancellation, and the
// free-update rate limit. Two of them exist because they failed silently — an
// update priced against itself is free however much it grew, and a free update
// that restarts the term renews an app for nothing.
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { appOwnerKey } from '../framework/keys.js';
import { confirmOnChain, waitForPricingVerdict } from '../framework/app-helper.js';
import { registerEncryptedV9App, updateEncryptedV9App } from '../framework/content-helper.js';
import { bootstrapPricing } from '../framework/price-helper.js';
import { startTicker, advanceBlock } from '../framework/daemon-control.js';
import { waitForDaemonReady, waitFor, waitForBlockProcessed, waitForNodeStatus } from '../framework/wait.js';
import { dbClient } from '../framework/db-client.js';
import { pushImage } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';

let env;
let db;

// 0.01 FLUX — the minPrice backstop bootstrapPricing puts in force. The least
// any priced message can owe, and so the payment that separates "this update was
// priced" from "this update was free".
const FLOOR_SAT = 1000000;
// Comfortably above any fee these specs can reach.
const AMPLE_SAT = 200000000;

// The image lives in the harness registry - the fleet is hermetic, and an
// external tag dies in Docker Hub verification with no DNS to resolve it.
const PRICING_IMAGE = 'v9pricing';

const SMALL = {
  web: {
    name: 'web',
    description: 'pricing test component',
    image: `${REGISTRY_REPO_HOST}/${PRICING_IMAGE}:v1`,
    cpu: 0.5,
    memory: 300,
    rootFsGb: 2,
    persistentStorage: { sizeGb: 10, mounts: { '/data': { source: 'data', destination: '/data' } } },
    ports: { http: { containerPort: 80, hostPort: 31000 } },
  },
};

// Four times the cpu, memory and storage. Whatever the rates, an update to this
// cannot come out at the floor unless it was never priced at all.
const GROWN = {
  web: { ...SMALL.web, cpu: 2, memory: 1200, persistentStorage: { sizeGb: 40, mounts: SMALL.web.persistentStorage.mounts } },
};

// Half again over GROWN. What makes an update priced is growth over what
// stands, so an app already at GROWN needs somewhere bigger to go for its
// next update to owe a fee.
const GROWN2 = {
  web: { ...SMALL.web, cpu: 3, memory: 1800, persistentStorage: { sizeGb: 60, mounts: SMALL.web.persistentStorage.mounts } },
};

const url = () => env.clients[0].url;
const ownerKey = () => appOwnerKey();

async function confirmAndSettle(hash, valueSat) {
  const result = await confirmOnChain(hash, env.clients, { valueSat });
  await waitForBlockProcessed(env.clients[0], (d) => d.height >= result.targetHeight, 60000);
  await waitForPricingVerdict(env.clients[0], db, hash);
  return result;
}

async function registerV9(name, { components = SMALL, ttl, valueSat = AMPLE_SAT } = {}) {
  const res = await registerEncryptedV9App(url(), { name, ownerKey: ownerKey(), components, ttl });
  expect(res.status, `register ${name}: ${JSON.stringify(res.data)}`).to.equal('success');
  await confirmAndSettle(res.data, valueSat);
  return res;
}

async function updateV9(name, { components = SMALL, ttl, valueSat } = {}) {
  const res = await updateEncryptedV9App(url(), { name, ownerKey: ownerKey(), components, ttl });
  expect(res.status, `update ${name}: ${JSON.stringify(res.data)}`).to.equal('success');
  await confirmAndSettle(res.data, valueSat);
  return res;
}

async function row(name) {
  return db.getGlobalApp(name);
}

describe('v9 update pricing', function () {
  before(async function () {
    this.timeout(300000);
    env = await createTestEnv({ hookCtx: this, nodes: 10, tickerAutostart: false });
    db = dbClient(1);
    await pushImage(PRICING_IMAGE, 'v1');
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

  // Runs before bootstrapPricing, so the chain quotes nothing. A v9 fee of zero
  // can only mean pricing is not in force — never that the app is free — and the
  // registration path fail-closes on it rather than minting a free app.
  describe('with no price on chain', function () {
    const appName = `v9nopricing${Date.now()}`;

    it('refuses a registration rather than minting a free app', async function () {
      this.timeout(180000);
      const res = await registerEncryptedV9App(url(), { name: appName, ownerKey: ownerKey(), components: SMALL });
      expect(res.status, `register ${appName}: ${JSON.stringify(res.data)}`).to.equal('success');
      await confirmAndSettle(res.data, AMPLE_SAT);

      expect(await row(appName)).to.equal(null);
    });
  });

  describe('once pricing is in force', function () {
    before(async function () {
      this.timeout(180000);
      await bootstrapPricing();
    });

    describe('registration', function () {
      it('is applied when it pays its price', async function () {
        this.timeout(180000);
        const appName = `v9regpaid${Date.now()}`;
        await registerV9(appName);
        expect(await row(appName)).to.not.equal(null);
      });

      // v9 prices a registration in full, so the floor is nowhere near enough
      // for a real app — the opposite of the chain-floor regime next door.
      it('is refused when it pays only the floor', async function () {
        this.timeout(180000);
        const appName = `v9regfloor${Date.now()}`;
        const res = await registerEncryptedV9App(url(), { name: appName, ownerKey: ownerKey(), components: GROWN });
        expect(res.status).to.equal('success');
        await confirmAndSettle(res.data, FLOOR_SAT);

        expect(await row(appName)).to.equal(null);
      });
    });

    // The headline defect. Priced against the message it supersedes, growing an
    // app costs real money. Priced against itself — which is what promotion did
    // before, having already stored the message it then looked up — every rule
    // in the free-update policy compares the spec with itself, passes, and the
    // update is free however much it grew.
    describe('an update that grows the app', function () {
      const appName = `v9grow${Date.now()}`;

      before(async function () {
        this.timeout(180000);
        await registerV9(appName, { components: SMALL });
      });

      it('is refused at the floor, because growth is priced', async function () {
        this.timeout(180000);
        const before = await row(appName);
        await updateV9(appName, { components: GROWN, valueSat: FLOOR_SAT });

        const current = await row(appName);
        expect(current.hash).to.equal(before.hash);
      });

      it('is applied when it pays what the growth costs', async function () {
        this.timeout(180000);
        const before = await row(appName);
        await updateV9(appName, { components: GROWN, valueSat: AMPLE_SAT });

        const current = await row(appName);
        expect(current.hash).to.not.equal(before.hash);
      });

      // Only an update that OWES a fee buys a term: the fee credits back
      // whatever time was left on the old one, so the clock restarts. A
      // shrink owes nothing — it is a free update whatever payment rides the
      // transaction, and a free update keeps the standing term (the
      // changes-nothing tests below pin that side).
      it('starts a new term when it owes a fee, having paid for one', async function () {
        this.timeout(180000);
        const before = await row(appName);
        await updateV9(appName, { components: GROWN2, valueSat: AMPLE_SAT });

        const current = await row(appName);
        expect(current.hash).to.not.equal(before.hash);
        expect(current.registeredAt).to.be.greaterThan(before.registeredAt);
      });
    });

    // An unchanged update is free, deliberately — changing an env var should not
    // cost a second subscription. What it must not do is hand back a fresh term,
    // which is a renewal for nothing, repeatable to the rate limit forever.
    describe('an update that changes nothing', function () {
      const appName = `v9same${Date.now()}`;

      before(async function () {
        this.timeout(180000);
        await registerV9(appName, { components: SMALL });
      });

      // "Free" means the fee is zero, not the transaction: the explorer's
      // indexing bar ignores any tx under minPrice by design (anti-spam), so a
      // free update pays the floor and owes nothing above it.
      it('is applied at the floor, owing nothing above it', async function () {
        this.timeout(180000);
        const before = await row(appName);
        await updateV9(appName, { components: SMALL, valueSat: FLOOR_SAT });

        const current = await row(appName);
        expect(current.hash).to.not.equal(before.hash);
        expect(current.height).to.be.greaterThan(before.height);
      });

      it('does not move the app expiry, having bought no time', async function () {
        this.timeout(180000);
        const before = await row(appName);
        await updateV9(appName, { components: SMALL, valueSat: FLOOR_SAT });

        const current = await row(appName);
        expect(current.hash).to.not.equal(before.hash);
        expect(current.registeredAt).to.equal(before.registeredAt);
      });
    });

    // Rule 1 of the free-update policy, end to end: more time is the one thing
    // an owner always pays for.
    describe('an update that asks for more time', function () {
      const appName = `v9ttl${Date.now()}`;
      const SHORT_TTL = 2592000;

      before(async function () {
        this.timeout(180000);
        await registerV9(appName, { components: SMALL, ttl: SHORT_TTL });
      });

      it('is refused at the floor, because a longer ttl is not free', async function () {
        this.timeout(180000);
        const before = await row(appName);
        await updateV9(appName, { components: SMALL, ttl: SHORT_TTL * 2, valueSat: FLOOR_SAT });

        const current = await row(appName);
        expect(current.hash).to.equal(before.hash);
      });

      it('is applied when it pays for the longer term', async function () {
        this.timeout(180000);
        const before = await row(appName);
        await updateV9(appName, { components: SMALL, ttl: SHORT_TTL * 2, valueSat: AMPLE_SAT });

        const current = await row(appName);
        expect(current.hash).to.not.equal(before.hash);
      });
    });

    // ttl 0 releases the app's resources. It is free by its own rule, ahead of
    // every other — an owner giving capacity back is never charged for it.
    describe('a cancellation', function () {
      const appName = `v9cancel${Date.now()}`;

      before(async function () {
        this.timeout(180000);
        await registerV9(appName, { components: SMALL });
      });

      it('is free, and the app stops being current', async function () {
        this.timeout(180000);
        await updateV9(appName, { components: SMALL, ttl: 0, valueSat: FLOOR_SAT });

        await waitFor(async () => (await row(appName)) === null, {
          timeout: 60000, label: `${appName} released after cancellation`,
        });
      });
    });

    // Rule 7. Free updates are relayed, verified and stored permanently by every
    // node on the network, so they are capped: 5 in 24h. Past the cap, payment
    // converts nothing: a free-shaped update is refused whatever rides the
    // transaction, because money never changes what an update is — the spec
    // does. The pay path is asking for something (growth or time), which is
    // priced like any other update.
    describe('the free-update rate limit', function () {
      const appName = `v9ratelimit${Date.now()}`;

      before(async function () {
        this.timeout(600000);
        await registerV9(appName, { components: SMALL });
        // Five free updates inside the window — the whole allowance.
        for (let i = 0; i < 5; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await updateV9(appName, { components: SMALL, valueSat: FLOOR_SAT });
        }
      });

      it('refuses a sixth free update in the window', async function () {
        this.timeout(180000);
        const before = await row(appName);
        await updateV9(appName, { components: SMALL, valueSat: FLOOR_SAT });

        const current = await row(appName);
        expect(current.hash).to.equal(before.hash);
      });

      it('still refuses the sixth free-shaped update, however much it pays', async function () {
        this.timeout(180000);
        const before = await row(appName);
        await updateV9(appName, { components: SMALL, valueSat: AMPLE_SAT });

        const current = await row(appName);
        expect(current.hash).to.equal(before.hash);
      });

      it('accepts a sixth update that buys something, priced like any other', async function () {
        this.timeout(180000);
        const before = await row(appName);
        await updateV9(appName, { components: GROWN, valueSat: AMPLE_SAT });

        const current = await row(appName);
        expect(current.hash).to.not.equal(before.hash);
      });
    });
  });
});
