// fleet: 4
/*
 * The real FluxDrive keeps a v9 app's content-ref files across updates and a
 * sale, and removes each file an applied update drops.
 *
 * The seller registers the app with one file and replaces it by a spec update;
 * then, with GC passes run at the times the suite names:
 *   - the replaced file is kept through the grace and removed after it, the file
 *     the app names kept;
 *   - the seller replaces the file again and sells the app before that grace
 *     ends: past every grace both files are kept, because the owner who dropped
 *     the earlier one no longer holds the app;
 *   - a node held off every node that runs the app installs it from FluxDrive
 *     alone with the file the sale names;
 *   - the buyer replaces the file: the buyer's update drops both earlier files,
 *     which are kept through the grace and removed after it, the buyer's kept.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { appOwnerKey } from '../framework/keys.js';
import { buyerKey } from '../framework/transfer-helper.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { confirmOnChain } from '../framework/app-helper.js';
import {
  deployContentApp, requestBlobLocator, updateContentApp, updateEncryptedV9App,
} from '../framework/content-helper.js';
import { blobHash } from '../framework/content-crypto-v9.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';
import { readFileInContainer } from '../framework/container.js';
import { appView } from '../framework/app-view.js';
import { harnessNow } from '../framework/harness-clock.js';
import { fluxDriveHolds, fluxDrivePending, fluxDriveSweep } from '../framework/fluxdrive-real.js';
import { waitFor, waitForDaemonReady, waitForInstallSettled } from '../framework/wait.js';

const NODES = 4;
const RUNNING = [0, 1, 2];
const FRESH = 3; // boots after the sale, held off every node that runs the app
const CONVERGE_MS = 300000;
const REF_PATH = '/etc/ref.conf';
const DAY_MS = 24 * 3600 * 1000;
// FluxDrive's grace for content an owner superseded (CONTENT_GC_GRACE_MS, its floor)
const GRACE_MS = 2 * DAY_MS;
// FluxDrive's grace for content of an app that left the list (CONTENT_GC_LIFECYCLE_GRACE_MS)
const LIFECYCLE_GRACE_MS = 30 * DAY_MS;

describe('a content file replaced and sold, on the real FluxDrive', function () {
  let env;
  let view;
  let host;
  let registrar;
  let image;
  let targets;
  let sale;
  const locators = {};
  const seller = appOwnerKey();
  const buyer = buyerKey();
  const name = `refsale${Date.now()}`;
  const files = {
    v1: Buffer.from(`the file ${name} registered with\n`),
    v2: Buffer.from(`the seller of ${name} replaced it with this\n`),
    v3: Buffer.from(`and then with this before selling ${name}\n`),
    v4: Buffer.from(`the buyer of ${name} replaced it with this\n`),
  };
  const url = (i) => env.clients[i].url;
  const live = () => [...RUNNING, FRESH].filter((i) => env.clients[i]);

  // The component, mounting the file whose hash it names.
  function components(bytes) {
    return {
      web: {
        name: 'web',
        description: 'a content file replaced and sold',
        image,
        cpu: 0.5,
        memory: 300,
        rootFsGb: 2,
        persistentStorage: {
          sizeGb: 1,
          mounts: {
            '/data': { source: 'data', destination: '/data' },
            [REF_PATH]: {
              source: 'ref.conf', destination: REF_PATH, type: 'file', contentRef: { hash: blobHash(bytes) },
            },
          },
        },
        ports: { http: { containerPort: 80, hostPort: 31254 } },
      },
    };
  }
  const shape = (bytes) => ({ instances: 2, placement: { targetIps: targets }, components: components(bytes) });

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

  // The owner every node's unfiltered app list names: the list FluxDrive's GC
  // reads, which a node serves from its route cache.
  async function listedOwnerOn(index) {
    const res = await fetch(`${url(index)}/apps/globalappsspecifications`);
    const body = await res.json();
    const row = (body.data || []).find((spec) => spec.name === name);
    return row ? row.owner : null;
  }

  async function fluxDriveReadsOwner(owner, label) {
    await waitFor(async () => (await Promise.all(RUNNING.map(listedOwnerOn))).every((o) => o === owner), {
      timeout: CONVERGE_MS, interval: 3000, label,
    });
  }

  async function fileOn(index) {
    const r = await readFileInContainer(env.clients[index].container, name, 'web', REF_PATH).catch(() => null);
    return r?.exitCode === 0 ? r.content : null;
  }

  async function fileEverywhere(bytes, indices, label) {
    await waitFor(async () => (await Promise.all(indices.map(fileOn))).every((c) => c === bytes.toString()), {
      timeout: CONVERGE_MS, interval: 3000, label,
    });
  }

  const holds = async (...tags) => Object.fromEntries(await Promise.all(tags.map(async (tag) => [tag, await fluxDriveHolds(locators[tag])])));

  // A spec update replacing the file: the node it is submitted to sends FluxDrive
  // the update's keep list, which FluxDrive applies once the nodes decide the
  // update applied.
  async function replaceFile(bytes, ownerKey, label) {
    const mark = env.clients[registrar].getLastEventId();
    const update = await updateContentApp(url(registrar), {
      name, contentRef: bytes, ...shape(bytes), owner: ownerKey.zelid, ownerKey,
    });
    expect(update.status, `${label}: ${JSON.stringify(update).slice(0, 300)}`).to.equal('success');
    const sent = await env.clients[registrar].waitForEvent('content:keepListSent', (d) => d.appName === name, 60000, { afterId: mark });
    expect(sent.data, `${label}: the keep list names the update and keeps the one file`).to.include({ pendingMessageHash: update.data, kept: 1 });
    await confirmOnChain(update.data, live().map((i) => env.clients[i]));
    await decidedEverywhere(update.data, `${label}: every node decides it applied`);
    const pending = await fluxDrivePending(harnessNow());
    expect(pending.applied, `${label}: FluxDrive applies its keep list: ${JSON.stringify(pending)}`).to.be.at.least(1);
    return update.data;
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
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });
    view = appView(env, name, { component: 'web', timeout: CONVERGE_MS });
    const ordinary = RUNNING.filter((i) => !env.establishedNodes.includes(i));
    [host] = ordinary;
    registrar = RUNNING.find((i) => i !== host);
    targets = [host, FRESH].map((i) => getSubnetConfig().nodeIp(i + 1));
    expect(buyer.zelid, 'the fixture names two owners').to.not.equal(seller.zelid);
    await pushBusybox(name);
    image = `${REGISTRY_REPO_HOST}/${name}:v1`;
  });

  after(async function () {
    this.timeout(120000);
    await env?.teardown();
  });

  it('removes the file the seller replaced once the grace has run, and keeps the one the app names', async function () {
    this.timeout(CONVERGE_MS * 3);
    const registration = await deployContentApp(url(registrar), {
      name, contentRef: files.v1, ...shape(files.v1), ownerKey: seller,
    });
    expect(registration.status, `the registration is accepted: ${JSON.stringify(registration).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(registration.data, RUNNING.map((i) => env.clients[i]));
    await decidedEverywhere(registration.data, 'every node decides the registration applied');
    await waitForInstallSettled(env.clients[host], name, CONVERGE_MS);
    locators.v1 = await locatorOf(files.v1, seller);
    expect(await holds('v1'), 'FluxDrive holds the registration\'s file').to.deep.equal({ v1: true });

    await replaceFile(files.v2, seller, 'the seller\'s update to v2');
    locators.v2 = await locatorOf(files.v2, seller);
    await fileEverywhere(files.v2, [host], 'the host runs v2');

    await sweep(harnessNow() + GRACE_MS - DAY_MS);
    expect(await holds('v1', 'v2'), 'inside the grace both files are kept').to.deep.equal({ v1: true, v2: true });
    await sweep(harnessNow() + GRACE_MS + DAY_MS);
    expect(await holds('v1', 'v2'), 'past the grace the replaced file is removed').to.deep.equal({ v1: false, v2: true });
  });

  it('keeps every file past every grace when the seller replaces the file and sells before the grace ends', async function () {
    this.timeout(CONVERGE_MS * 3);
    await replaceFile(files.v3, seller, 'the seller\'s update to v3');
    locators.v3 = await locatorOf(files.v3, seller);
    await fileEverywhere(files.v3, [host], 'the host runs v3');

    const sold = await updateEncryptedV9App(url(registrar), {
      name, ...shape(files.v3), owner: buyer.zelid, ownerKey: seller,
    });
    expect(sold.status, `the sale is accepted: ${JSON.stringify(sold).slice(0, 300)}`).to.equal('success');
    sale = sold.data;
    await confirmOnChain(sale, RUNNING.map((i) => env.clients[i]));
    await decidedEverywhere(sale, 'every node decides the sale applied');
    await view.listedEverywhere(sale, RUNNING, 'every node lists the sale');
    await fluxDriveReadsOwner(buyer.zelid, 'the app list FluxDrive reads names the buyer');

    await sweep(harnessNow());
    const past = await sweep(harnessNow() + LIFECYCLE_GRACE_MS + DAY_MS);
    expect(await holds('v2', 'v3'), `past every grace the seller's dropped file and the file the sale names are kept: ${JSON.stringify(past)}`).to.deep.equal({ v2: true, v3: true });
  });

  it('installs the file the sale names from FluxDrive alone on a node held off every node that runs the app', async function () {
    this.timeout(CONVERGE_MS * 2);
    await env.holdOutPendingNode(FRESH, [host]);
    const fresh = await env.startNode(FRESH);
    const mark = fresh.getLastEventId();
    await waitForDaemonReady(fresh);
    await env.startDiscovery([FRESH]);
    await view.installedEverywhere(sale, [FRESH], 'the node installs the app as sold');
    const resolved = await fresh.waitForEvent('content:blobResolved', (d) => d.appName === name, CONVERGE_MS, { afterId: mark });
    expect(resolved.data.source, 'the file came from FluxDrive').to.equal('fluxdrive');
    await fileEverywhere(files.v3, [FRESH], 'the node holds the file the sale names');
    await env.releasePendingNode(FRESH, [host]);
    await env.startDiscovery([FRESH]);
  });

  it('removes both earlier files once the buyer replaces the file and the grace has run, and keeps the buyer\'s', async function () {
    this.timeout(CONVERGE_MS * 3);
    await replaceFile(files.v4, buyer, 'the buyer\'s update to v4');
    locators.v4 = await locatorOf(files.v4, buyer);
    await fileEverywhere(files.v4, [host, FRESH], 'both hosts run v4');

    await sweep(harnessNow() + GRACE_MS - DAY_MS);
    expect(await holds('v2', 'v3', 'v4'), 'inside the grace every file is kept').to.deep.equal({ v2: true, v3: true, v4: true });
    await sweep(harnessNow() + GRACE_MS + DAY_MS);
    expect(await holds('v2', 'v3', 'v4'), 'past the grace only the buyer\'s file is kept').to.deep.equal({ v2: false, v3: false, v4: true });
  });
});
