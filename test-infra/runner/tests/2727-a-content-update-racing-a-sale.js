// fleet: 5
/*
 * The seller's content update racing a sale of a v9 app with a content slot,
 * on the real FluxDrive.
 *
 * The seller sells the app naming the manifest it stands on, and the sale waits
 * for payment. Through a node cut off from the fleet while the sale gossips,
 * which therefore holds no transfer, the seller pushes a content update: the
 * node takes it and FluxDrive confirms it, the seller still holding the app.
 * Then, the node back in the fleet and the sale paid:
 *   - every node stands on the manifest the sale names, the node that took the
 *     update among them;
 *   - past the grace, a node held off every node that runs the app installs it
 *     from FluxDrive alone with the content the sale names: a change of holder
 *     retires none of the seller's versions;
 *   - once the buyer updates the content and the grace has run, FluxDrive holds
 *     only the buyer's.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { appOwnerKey } from '../framework/keys.js';
import { buyerKey, transferApp } from '../framework/transfer-helper.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { confirmOnChain } from '../framework/app-helper.js';
import {
  deployContentApp, manifestStanding, pushContentUpdate, requestBlobLocator,
} from '../framework/content-helper.js';
import { blobHash } from '../framework/content-crypto-v9.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';
import { readFileInContainer } from '../framework/container.js';
import { appView } from '../framework/app-view.js';
import { partition, healPartition } from '../framework/partition.js';
import { harnessNow } from '../framework/harness-clock.js';
import {
  fluxDriveHolds, fluxDriveManifests, fluxDrivePending, fluxDriveSweep,
} from '../framework/fluxdrive-real.js';
import { waitFor, waitForDaemonReady, waitForInstallSettled } from '../framework/wait.js';

const NODES = 5;
const RUNNING = [0, 1, 2, 3];
const FRESH = 4; // boots after the sale, held off every node that runs the app
const CONVERGE_MS = 300000;
const SLOT = { name: 'conf', destination: '/etc/app.conf', onUpdate: { action: 'restart' } };
const DAY_MS = 24 * 3600 * 1000;
// FluxDrive's grace for content an owner superseded (CONTENT_GC_GRACE_MS, its floor)
const GRACE_MS = 2 * DAY_MS;

describe('a content update racing a sale, on the real FluxDrive', function () {
  let env;
  let view;
  let host;
  let registrar;
  let racer; // the node cut off while the sale gossips
  let targets;
  let image;
  let named; // the manifest the sale names: { hash, version, ownedFrom }
  let sale;
  const locators = {};
  const seller = appOwnerKey();
  const buyer = buyerKey();
  const name = `racesale${Date.now()}`;
  const bytes = {
    v1: Buffer.from(`conf ${name} registered with\n`),
    v2: Buffer.from(`conf the seller of ${name} pushed while the sale waited\n`),
    v3: Buffer.from(`conf the buyer of ${name} pushed\n`),
  };
  const url = (i) => env.clients[i].url;
  const elsewhere = () => RUNNING.filter((i) => i !== racer);

  const components = () => ({
    web: {
      name: 'web',
      description: 'a content update racing a sale',
      image,
      cpu: 0.5,
      memory: 300,
      rootFsGb: 2,
      persistentStorage: {
        sizeGb: 1,
        mounts: {
          '/data': { source: 'data', destination: '/data' },
          [SLOT.destination]: {
            source: SLOT.name, destination: SLOT.destination, type: 'file', contentSlot: SLOT.name, onUpdate: SLOT.onUpdate,
          },
        },
      },
      ports: { http: { containerPort: 80, hostPort: 31261 } },
    },
  });
  const shape = () => ({ instances: 2, placement: { targetIps: targets }, components: components() });

  async function locatorOf(content, ownerKey) {
    const res = await requestBlobLocator(url(registrar), { name, contentHash: blobHash(content), ownerKey });
    expect(res.status, `the locator of ${content.toString().trim()}: ${JSON.stringify(res).slice(0, 300)}`).to.equal('success');
    return res.data.locator;
  }

  async function decisionOn(index, hash) {
    const { status, data } = await env.clients[index].request('GET', `/v2/apps/messages/${hash}/decision`);
    return status === 200 ? data.data.decision : null;
  }

  async function decidedEverywhere(hash, label) {
    await waitFor(async () => (await Promise.all(RUNNING.map((i) => decisionOn(i, hash)))).every((d) => d === 'applied'), {
      timeout: CONVERGE_MS, interval: 3000, label,
    });
  }

  const holds = async (index, hash) => (await env.clients[index].getTempMessages(hash)).data?.length > 0;
  const standingOn = async (index) => (await manifestStanding(url(index), name)).standing;
  const servedBy = async (owner) => (await fluxDriveManifests(name)).filter((m) => m.owner === owner);

  async function slotOn(index) {
    const r = await readFileInContainer(env.clients[index].container, name, 'web', SLOT.destination).catch(() => null);
    return r?.exitCode === 0 ? r.content : null;
  }

  async function sweep(now) {
    const pass = await fluxDriveSweep(now);
    expect(pass.skipped, `the pass at ${new Date(now).toISOString()} reads the live set: ${JSON.stringify(pass)}`).to.not.equal(true);
    return pass;
  }

  before(async function () {
    this.timeout(1200000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      deferredNodes: 1,
      tickerAutostart: false,
      arcane: true,
      harnessClock: true,
      fluxDrive: 'real',
      timing: { partitions: true },
    });
    await bootAndPeer(env, { pricing: true });
    view = appView(env, name, { component: 'web', timeout: CONVERGE_MS });
    const ordinary = RUNNING.filter((i) => !env.establishedNodes.includes(i));
    [host] = ordinary;
    [registrar, racer] = RUNNING.filter((i) => i !== host);
    targets = [host, FRESH].map((i) => getSubnetConfig().nodeIp(i + 1));
    expect(buyer.zelid, 'the fixture names two owners').to.not.equal(seller.zelid);
    await pushBusybox(name);
    image = `${REGISTRY_REPO_HOST}/${name}:v1`;

    const registration = await deployContentApp(url(registrar), {
      name, ...shape(), ownerKey: seller, contentSlots: [{ ...SLOT, bytes: bytes.v1 }],
    });
    expect(registration.status, `the registration is accepted: ${JSON.stringify(registration).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(registration.data, RUNNING.map((i) => env.clients[i]));
    await decidedEverywhere(registration.data, 'every node decides the registration applied');
    expect(await fluxDrivePending(harnessNow()), 'the registration\'s manifest put applies').to.include({ applied: 1 });
    await waitForInstallSettled(env.clients[host], name, CONVERGE_MS);
    locators.v1 = await locatorOf(bytes.v1, seller);
  });

  after(async function () {
    this.timeout(120000);
    await env?.teardown();
  });

  it('takes the seller\'s content update on a node that never received the sale, and FluxDrive confirms it', async function () {
    this.timeout(CONVERGE_MS * 2);
    named = await standingOn(registrar);
    expect(named.version, 'the sale names the registration\'s manifest').to.equal(1);

    await partition(env, [racer], { cutChain: false });
    try {
      const submitted = await transferApp(url(registrar), seller, { spec: { name } }, elsewhere().map((i) => env.clients[i]), {
        sellerKey: seller, buyerKey: buyer, standsOn: { manifest: named.hash }, v9: shape(), pay: false,
      });
      expect(submitted.status, `the sale is accepted: ${JSON.stringify(submitted).slice(0, 300)}`).to.equal('success');
      sale = submitted.appHash;
      await waitFor(async () => (await Promise.all(elsewhere().map((i) => holds(i, sale)))).every(Boolean), {
        timeout: 60000, interval: 2000, label: 'every node in the fleet holds the sale waiting for payment',
      });
      expect(await holds(racer, sale), 'the node cut off holds no sale').to.equal(false);

      const update = await pushContentUpdate(url(racer), { name, slots: [{ name: SLOT.name, bytes: bytes.v2 }], ownerKey: seller });
      expect(update.status, `the node cut off takes the seller's content update: ${JSON.stringify(update).slice(0, 300)}`).to.equal('success');
      await waitFor(async () => (await standingOn(racer))?.version === 2, {
        timeout: 60000, interval: 2000, label: 'the node cut off stands on the seller\'s update',
      });
      await waitFor(async () => (await servedBy(seller.zelid)).length === 2, {
        timeout: 60000, interval: 2000, label: 'FluxDrive serves both of the seller\'s manifests',
      });
      locators.v2 = await locatorOf(bytes.v2, seller);
      expect(await fluxDriveHolds(locators.v2), 'FluxDrive holds the seller\'s update').to.equal(true);
    } finally {
      await healPartition(env, [racer]);
    }
  });

  it('stands every node on the manifest the sale names once it applies, the node that took the update among them', async function () {
    this.timeout(CONVERGE_MS * 2);
    await confirmOnChain(sale, elsewhere().map((i) => env.clients[i]));
    await decidedEverywhere(sale, 'every node decides the sale applied');
    await view.listedEverywhere(sale, RUNNING, 'every node lists the sale');
    await waitFor(async () => (await Promise.all(RUNNING.map(standingOn))).every((s) => s?.hash === named.hash), {
      timeout: CONVERGE_MS, interval: 3000, label: 'every node stands on the manifest the sale names',
    });
  });

  it('installs the content the sale names from FluxDrive alone past the grace, on a node held off every node that runs the app', async function () {
    this.timeout(CONVERGE_MS * 2);
    const past = await sweep(harnessNow() + GRACE_MS + DAY_MS);
    expect(await fluxDriveHolds(locators.v1), `past the grace FluxDrive holds the content the sale names: ${JSON.stringify(past)}`).to.equal(true);

    await env.holdOutPendingNode(FRESH, [host]);
    const fresh = await env.startNode(FRESH);
    const mark = fresh.getLastEventId();
    await waitForDaemonReady(fresh);
    await env.startDiscovery([FRESH]);
    await view.installedEverywhere(sale, [FRESH], 'the node installs the app as sold');
    const resolved = await fresh.waitForEvent('content:blobResolved', (d) => d.appName === name, CONVERGE_MS, { afterId: mark });
    expect(resolved.data.source, 'the content came from FluxDrive').to.equal('fluxdrive');
    await waitFor(async () => (await slotOn(FRESH)) === bytes.v1.toString(), {
      timeout: CONVERGE_MS, interval: 3000, label: 'the node holds the content the sale names',
    });
    await env.releasePendingNode(FRESH, [host]);
    await env.startDiscovery([FRESH]);
  });

  it('holds only the buyer\'s content once the buyer updates it and the grace has run', async function () {
    this.timeout(CONVERGE_MS * 2);
    const update = await pushContentUpdate(url(registrar), { name, slots: [{ name: SLOT.name, bytes: bytes.v3 }], ownerKey: buyer });
    expect(update.status, `the buyer's content update: ${JSON.stringify(update).slice(0, 300)}`).to.equal('success');
    await waitFor(async () => (await servedBy(buyer.zelid)).length === 1, {
      timeout: 60000, interval: 2000, label: 'FluxDrive serves the buyer\'s manifest',
    });
    locators.v3 = await locatorOf(bytes.v3, buyer);

    await sweep(harnessNow() + GRACE_MS + DAY_MS);
    await sweep(harnessNow() + 2 * (GRACE_MS + DAY_MS));
    expect(await servedBy(seller.zelid), 'the seller\'s manifests are retired').to.deep.equal([]);
    expect(await fluxDriveHolds(locators.v1), 'the content the sale named is removed').to.equal(false);
    expect(await fluxDriveHolds(locators.v2), 'the seller\'s update is removed').to.equal(false);
    expect(await fluxDriveHolds(locators.v3), 'the buyer\'s content is kept').to.equal(true);
  });
});
