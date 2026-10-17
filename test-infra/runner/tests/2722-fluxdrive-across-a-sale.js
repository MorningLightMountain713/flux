// fleet: 3
/*
 * The real FluxDrive across a sale of a v9 app with a content slot.
 *
 * The seller registers the app and updates its slot, so FluxDrive holds two of
 * the seller's manifests and two blobs, the first superseded by the second. The
 * seller sells the app, naming the manifest it stands on. Then, with GC passes
 * run at the times the suite names:
 *   - past every grace, FluxDrive still serves both of the seller's manifests,
 *     the one the sale names among them, and holds both blobs: a change of
 *     holder retires nothing;
 *   - once the buyer updates the slot, a pass inside the grace keeps the
 *     seller's content, and a pass past it leaves only the buyer's manifest and
 *     blob.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { appOwnerKey } from '../framework/keys.js';
import { buyerKey } from '../framework/transfer-helper.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { confirmOnChain } from '../framework/app-helper.js';
import {
  deployContentApp, manifestStanding, pushContentUpdate, requestBlobLocator, updateEncryptedV9App,
} from '../framework/content-helper.js';
import { blobHash } from '../framework/content-crypto-v9.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';
import { appView } from '../framework/app-view.js';
import { harnessNow } from '../framework/harness-clock.js';
import {
  fluxDriveHolds, fluxDriveManifests, fluxDrivePending, fluxDriveSweep,
} from '../framework/fluxdrive-real.js';
import { waitFor, waitForInstallSettled } from '../framework/wait.js';

const NODES = 3;
const RUNNING = [0, 1, 2];
const CONVERGE_MS = 300000;
const SLOT = 'cfg';
const SLOT_PATH = '/etc/app.conf';
const DAY_MS = 24 * 3600 * 1000;
// FluxDrive's grace for content an owner superseded (CONTENT_GC_GRACE_MS, its floor)
const GRACE_MS = 2 * DAY_MS;
// FluxDrive's grace for content of an app that left the list (CONTENT_GC_LIFECYCLE_GRACE_MS)
const LIFECYCLE_GRACE_MS = 30 * DAY_MS;

describe('the real FluxDrive across a sale', function () {
  let env;
  let view;
  let host;
  let registrar;
  let targets;
  let named; // the standing manifest the sale names: { hash, version, ownedFrom }
  const locators = {};
  const seller = appOwnerKey();
  const buyer = buyerKey();
  const name = `drivesale${Date.now()}`;
  const v1 = Buffer.from(`slot v1 of ${name}\n`);
  const v2 = Buffer.from(`slot v2 the seller of ${name} pushed\n`);
  const v3 = Buffer.from(`slot v3 the buyer of ${name} pushed\n`);
  const url = (i) => env.clients[i].url;

  const components = {
    web: {
      name: 'web',
      description: 'FluxDrive across a sale',
      image: `${REGISTRY_REPO_HOST}/${name}:v1`,
      cpu: 0.5,
      memory: 300,
      rootFsGb: 2,
      persistentStorage: {
        sizeGb: 1,
        mounts: {
          '/data': { source: 'data', destination: '/data' },
          [SLOT_PATH]: {
            source: SLOT, destination: SLOT_PATH, type: 'file', contentSlot: SLOT, onUpdate: { action: 'signal', signal: 'SIGHUP' },
          },
        },
      },
      ports: { http: { containerPort: 80, hostPort: 31253 } },
    },
  };
  const shape = () => ({ instances: 2, placement: { targetIps: targets }, components });

  async function locatorOf(bytes, ownerKey) {
    const res = await requestBlobLocator(url(registrar), { name, contentHash: blobHash(bytes), ownerKey });
    expect(res.status, `the locator of ${bytes.toString().trim()}: ${JSON.stringify(res).slice(0, 300)}`).to.equal('success');
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

  async function sweep(now) {
    const pass = await fluxDriveSweep(now);
    expect(pass.skipped, `the pass at ${new Date(now).toISOString()} reads the live set: ${JSON.stringify(pass)}`).to.not.equal(true);
    return pass;
  }

  const servedBy = async (owner) => (await fluxDriveManifests(name)).filter((m) => m.owner === owner);

  before(async function () {
    this.timeout(1200000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      tickerAutostart: false,
      arcane: true,
      harnessClock: true,
      fluxDrive: 'real',
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });
    view = appView(env, name, { component: 'web', timeout: CONVERGE_MS });
    const ordinary = RUNNING.filter((i) => !env.establishedNodes.includes(i));
    [host] = ordinary;
    registrar = RUNNING.find((i) => i !== host);
    const second = RUNNING.find((i) => i !== host && i !== registrar);
    targets = [host, second].map((i) => getSubnetConfig().nodeIp(i + 1));
    expect(buyer.zelid, 'the fixture names two owners').to.not.equal(seller.zelid);
    await pushBusybox(name);
  });

  after(async function () {
    this.timeout(120000);
    await env?.teardown();
  });

  it('serves both of the seller\'s manifests and holds both blobs', async function () {
    this.timeout(CONVERGE_MS * 2);
    const registration = await deployContentApp(url(registrar), {
      name,
      ...shape(),
      ownerKey: seller,
      contentSlots: [{
        name: SLOT, destination: SLOT_PATH, bytes: v1, onUpdate: { action: 'signal', signal: 'SIGHUP' },
      }],
    });
    expect(registration.status, `the registration is accepted: ${JSON.stringify(registration).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(registration.data, RUNNING.map((i) => env.clients[i]));
    await decidedEverywhere(registration.data, 'every node decides the registration applied');
    expect(await fluxDrivePending(harnessNow()), 'the registration\'s manifest put applies').to.include({ applied: 1 });
    await waitForInstallSettled(env.clients[host], name, CONVERGE_MS);

    const update = await pushContentUpdate(url(registrar), { name, slots: [{ name: SLOT, bytes: v2 }], ownerKey: seller });
    expect(update.status, `the seller's content update: ${JSON.stringify(update).slice(0, 300)}`).to.equal('success');
    await waitFor(async () => (await servedBy(seller.zelid)).length === 2, {
      timeout: 60000, interval: 2000, label: 'FluxDrive serves both of the seller\'s manifests',
    });
    locators.v1 = await locatorOf(v1, seller);
    locators.v2 = await locatorOf(v2, seller);
    expect(await fluxDriveHolds(locators.v1), 'FluxDrive holds the superseded blob').to.equal(true);
    expect(await fluxDriveHolds(locators.v2), 'FluxDrive holds the live blob').to.equal(true);
  });

  it('keeps every version past every grace once the app is sold, the one the sale names among them', async function () {
    this.timeout(CONVERGE_MS * 2);
    await waitFor(async () => (await Promise.all(RUNNING.map(async (i) => (await manifestStanding(url(i), name)).standing?.version))).every((v) => v === 2), {
      timeout: CONVERGE_MS, interval: 3000, label: 'every node stands on the seller\'s second manifest',
    });
    named = (await manifestStanding(url(registrar), name)).standing;

    const sale = await updateEncryptedV9App(url(registrar), {
      name, ...shape(), owner: buyer.zelid, ownerKey: seller, specOverrides: { content: { manifest: named.hash } },
    });
    expect(sale.status, `the sale is accepted: ${JSON.stringify(sale).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(sale.data, RUNNING.map((i) => env.clients[i]));
    await decidedEverywhere(sale.data, 'every node decides the sale applied');
    await view.listedEverywhere(sale.data, RUNNING, 'every node lists the sale');

    await sweep(harnessNow());
    await sweep(harnessNow() + LIFECYCLE_GRACE_MS + DAY_MS);

    const served = await servedBy(seller.zelid);
    expect(served.map((m) => m.version).sort(), 'FluxDrive serves both of the seller\'s manifests').to.deep.equal([1, 2]);
    expect(served.some((m) => m.version === named.version && m.ownedFrom === named.ownedFrom), 'the manifest the sale names among them').to.equal(true);
    expect(await fluxDriveHolds(locators.v1), 'the superseded blob is kept').to.equal(true);
    expect(await fluxDriveHolds(locators.v2), 'the blob the sale names is kept').to.equal(true);
  });

  it('keeps the seller\'s content through the grace once the buyer updates, then serves only the buyer\'s', async function () {
    this.timeout(CONVERGE_MS * 2);
    const update = await pushContentUpdate(url(registrar), { name, slots: [{ name: SLOT, bytes: v3 }], ownerKey: buyer });
    expect(update.status, `the buyer's content update: ${JSON.stringify(update).slice(0, 300)}`).to.equal('success');
    await waitFor(async () => (await servedBy(buyer.zelid)).length === 1, {
      timeout: 60000, interval: 2000, label: 'FluxDrive serves the buyer\'s manifest',
    });
    locators.v3 = await locatorOf(v3, buyer);
    expect(await fluxDriveHolds(locators.v3), 'FluxDrive holds the buyer\'s blob').to.equal(true);

    await sweep(harnessNow());
    expect((await servedBy(seller.zelid)).length, 'the seller\'s manifests are kept through the grace').to.equal(2);
    expect(await fluxDriveHolds(locators.v1), 'the seller\'s first blob is kept through the grace').to.equal(true);
    expect(await fluxDriveHolds(locators.v2), 'the seller\'s second blob is kept through the grace').to.equal(true);

    await sweep(harnessNow() + GRACE_MS + DAY_MS);
    expect(await servedBy(seller.zelid), 'the seller\'s manifests are retired').to.deep.equal([]);
    expect(await servedBy(buyer.zelid), 'the buyer\'s manifest is served').to.have.length(1);
    expect(await fluxDriveHolds(locators.v1), 'the seller\'s first blob is removed').to.equal(false);
    expect(await fluxDriveHolds(locators.v2), 'the seller\'s second blob is removed').to.equal(false);
    expect(await fluxDriveHolds(locators.v3), 'the buyer\'s blob is kept').to.equal(true);
  });
});
