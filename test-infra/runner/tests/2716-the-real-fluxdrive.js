// fleet: 4
/*
 * The real FluxDrive beside the fleet.
 *
 * FluxDrive's own API, mongo and kubo, its GC passes run by the suite at the
 * times it names, all on the suite's clock:
 *   - a slot app's registration writes are held until the nodes answer that the
 *     registration applied, then served;
 *   - every node stands on the manifest, and a node held off every node that
 *     runs the app installs the slot from FluxDrive alone;
 *   - an upload whose arcane signature the benchmark channel did not make is
 *     refused, and the same upload signed by the channel is stored;
 *   - a GC pass inside the grace keeps the blob a content update superseded,
 *     and a pass past every grace removes it and keeps the live one;
 *   - an update's writes are discarded once the nodes record the update
 *     unpayable.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { appOwnerKey } from '../framework/keys.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { confirmOnChain } from '../framework/app-helper.js';
import {
  deployContentApp, manifestStanding, pushContentUpdate, requestBlobLocator, updateContentApp,
} from '../framework/content-helper.js';
import { blobHash, buildOwnerSigs } from '../framework/content-crypto-v9.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';
import { readFileInContainer } from '../framework/container.js';
import { appView } from '../framework/app-view.js';
import { advanceBlocks, signBlobWrite } from '../framework/daemon-control.js';
import { advanceHarnessClock, harnessNow } from '../framework/harness-clock.js';
import {
  fluxDriveHolds, fluxDriveManifests, fluxDrivePending, fluxDriveSweep, uploadToFluxDrive,
} from '../framework/fluxdrive-real.js';
import { waitFor, waitForDaemonReady, waitForInstallSettled } from '../framework/wait.js';

const NODES = 4;
const FROM_FLUXDRIVE = 3;
const RUNNING = [0, 1, 2];
const CONVERGE_MS = 300000;
const SLOT = 'cfg';
const SLOT_PATH = '/etc/app.conf';
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
// FluxDrive's grace for content an owner superseded (CONTENT_GC_GRACE_MS, its floor)
const GRACE_MS = 2 * DAY_MS;
// FluxDrive's grace for content of an app that left the list (CONTENT_GC_LIFECYCLE_GRACE_MS)
const LIFECYCLE_GRACE_MS = 30 * DAY_MS;
// FluxOS's payment window (decisionRule PAYMENT_WINDOW_MS), by block stamp
const PAYMENT_WINDOW_S = 3600;
// blocks after the window closes before a node drops an unpaid message (temporaryPoolSweep)
const MAX_REORG_LENGTH = 40;

describe('the real FluxDrive', function () {
  let env;
  let view;
  let host;
  let registrar;
  let targets;
  let registration;
  let identity;
  const owner = appOwnerKey();
  const name = `realdrive${Date.now()}`;
  const v1 = Buffer.from(`slot v1 of ${name}\n`);
  const v2 = Buffer.from(`slot v2 of ${name}\n`);
  const v3 = Buffer.from(`slot v3 of ${name}, never paid\n`);
  const url = (i) => env.clients[i].url;

  const components = {
    web: {
      name: 'web',
      description: 'the real FluxDrive',
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
      ports: { http: { containerPort: 80, hostPort: 31252 } },
    },
  };
  const shape = () => ({ instances: 2, placement: { targetIps: targets }, components });
  const slot = (bytes) => ({
    name: SLOT, destination: SLOT_PATH, bytes, onUpdate: { action: 'signal', signal: 'SIGHUP' },
  });

  async function decisionOn(index, hash) {
    const { status, data } = await env.clients[index].request('GET', `/v2/apps/messages/${hash}/decision`);
    return status === 200 ? data.data.decision : null;
  }

  async function decidedEverywhere(hash, decision, label) {
    await waitFor(async () => (await Promise.all(RUNNING.map((i) => decisionOn(i, hash)))).every((d) => d === decision), {
      timeout: CONVERGE_MS, interval: 3000, label,
    });
  }

  async function locatorOf(bytes) {
    const res = await requestBlobLocator(url(registrar), { name, contentHash: blobHash(bytes), ownerKey: owner });
    expect(res.status, `the locator of ${bytes.toString().trim()}: ${JSON.stringify(res).slice(0, 300)}`).to.equal('success');
    return res.data.locator;
  }

  async function slotOn(index) {
    const r = await readFileInContainer(env.clients[index].container, name, 'web', SLOT_PATH).catch(() => null);
    return r?.exitCode === 0 ? r.content : null;
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
      configOverrides: { fluxapps: { minOutgoing: 2 } },
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });
    view = appView(env, name, { component: 'web', timeout: CONVERGE_MS });
    const ordinary = RUNNING.filter((i) => !env.establishedNodes.includes(i));
    [host] = ordinary;
    registrar = RUNNING.find((i) => i !== host);
    targets = [host, FROM_FLUXDRIVE].map((i) => getSubnetConfig().nodeIp(i + 1));
    await pushBusybox(name);
  });

  after(async function () {
    this.timeout(120000);
    await env?.teardown();
  });

  it('holds the registration\'s writes until the nodes answer that it applied, then serves them', async function () {
    this.timeout(CONVERGE_MS * 2);
    registration = await deployContentApp(url(registrar), { name, ...shape(), contentSlots: [slot(v1)] });
    expect(registration.status, `the registration is accepted: ${JSON.stringify(registration).slice(0, 300)}`).to.equal('success');

    const waiting = await fluxDrivePending(harnessNow());
    expect(waiting, 'the manifest put and the reconcile wait on the registration').to.include({ pending: 2, kept: 2, applied: 0 });
    expect(await fluxDriveManifests(name), 'FluxDrive serves no manifest while the writes wait').to.deep.equal([]);

    await confirmOnChain(registration.data, RUNNING.map((i) => env.clients[i]));
    await decidedEverywhere(registration.data, 'applied', 'every node decides the registration applied');
    const decided = await fluxDrivePending(harnessNow());
    expect(decided, 'both writes apply once the nodes answer').to.include({ pending: 2, applied: 2 });

    ({ identity } = await manifestStanding(url(registrar), name));
    const served = await fluxDriveManifests(name);
    expect(served.map((m) => m.version), 'FluxDrive serves the registration\'s manifest').to.deep.equal([1]);
    expect(served[0].manifest.identity, 'under the identity the registration made').to.equal(identity);
    expect(await fluxDriveHolds(await locatorOf(v1)), 'FluxDrive holds the slot\'s blob').to.equal(true);
  });

  it('serves the manifest from every node, and the slot from FluxDrive to a node held off every node that runs the app', async function () {
    this.timeout(CONVERGE_MS * 3);
    await waitForInstallSettled(env.clients[host], name, CONVERGE_MS);
    const standing = (await manifestStanding(url(registrar), name)).standing?.hash;
    expect(standing, 'the app stands on a manifest').to.be.a('string');
    await waitFor(async () => (await Promise.all(RUNNING.map(async (i) => (await manifestStanding(url(i), name)).standing?.hash))).every((h) => h === standing), {
      timeout: CONVERGE_MS, interval: 3000, label: 'every node stands on the manifest',
    });

    await env.holdOutPendingNode(FROM_FLUXDRIVE, [host]);
    const fresh = await env.startNode(FROM_FLUXDRIVE);
    const mark = fresh.getLastEventId();
    await waitForDaemonReady(fresh);
    await env.startDiscovery([FROM_FLUXDRIVE]);
    await view.installedEverywhere(registration.data, [FROM_FLUXDRIVE], 'the node held off the host installs the app');
    const resolved = await fresh.waitForEvent('content:blobResolved', (d) => d.appName === name, CONVERGE_MS, { afterId: mark });
    expect(resolved.data.source, 'the slot came from FluxDrive').to.equal('fluxdrive');
    await waitFor(async () => (await slotOn(FROM_FLUXDRIVE)) === v1.toString(), {
      timeout: CONVERGE_MS, interval: 3000, label: 'the node holds the slot',
    });
    await env.releasePendingNode(FROM_FLUXDRIVE, [host]);
    await env.startDiscovery([FROM_FLUXDRIVE]);
  });

  it('refuses an upload whose arcane signature the benchmark channel did not make, and stores it signed by the channel', async function () {
    this.timeout(120000);
    const bytes = Buffer.from(`an upload probe for ${name}`);
    const locator = await locatorOf(bytes);
    const timestamp = harnessNow();
    const sigs = await buildOwnerSigs({
      hashes: [blobHash(bytes)], identity, ownerKey: owner, timestamp, locatorFor: () => locator,
    });
    const upload = {
      bytes, locator, appName: name, identity, timestamp, ownerSig: sigs[blobHash(bytes)].sig,
    };

    const forged = await uploadToFluxDrive({ ...upload, arcaneSig: Buffer.alloc(64, 1).toString('base64') });
    expect(forged.status, `a forged arcane signature: ${JSON.stringify(forged.body)}`).to.equal(401);
    expect(await fluxDriveHolds(locator), 'nothing is stored under the forged upload').to.equal(false);

    const arcaneSig = await signBlobWrite({
      kind: 'upload', locator, identity, timestamp,
    });
    const signed = await uploadToFluxDrive({ ...upload, arcaneSig });
    expect(signed.status, `the channel's signature: ${JSON.stringify(signed.body)}`).to.equal(200);
    expect(await fluxDriveHolds(locator), 'the signed upload is stored').to.equal(true);
  });

  it('keeps a superseded blob through the grace, then removes it and keeps the live one', async function () {
    this.timeout(CONVERGE_MS);
    const update = await pushContentUpdate(url(registrar), { name, slots: [{ name: SLOT, bytes: v2 }], ownerKey: owner });
    expect(update.status, `the content update: ${JSON.stringify(update).slice(0, 300)}`).to.equal('success');
    await waitFor(async () => (await fluxDriveManifests(name)).some((m) => m.version === 2), {
      timeout: 60000, interval: 2000, label: 'FluxDrive serves the update\'s manifest',
    });
    const superseded = await locatorOf(v1);
    const live = await locatorOf(v2);
    expect(await fluxDriveHolds(live), 'FluxDrive holds the update\'s blob').to.equal(true);

    const inside = await fluxDriveSweep(harnessNow());
    expect(inside.skipped, `the pass inside the grace reads the live set: ${JSON.stringify(inside)}`).to.not.equal(true);
    expect(await fluxDriveHolds(superseded), 'the superseded blob is kept through the grace').to.equal(true);

    const past = await fluxDriveSweep(harnessNow() + Math.max(GRACE_MS, LIFECYCLE_GRACE_MS) + DAY_MS);
    expect(past.skipped, `the pass past every grace reads the live set: ${JSON.stringify(past)}`).to.not.equal(true);
    expect(await fluxDriveHolds(superseded), 'the superseded blob is removed').to.equal(false);
    expect(await fluxDriveHolds(live), 'the live blob is kept').to.equal(true);
  });

  it('discards an update\'s writes once the nodes record the update unpayable', async function () {
    this.timeout(CONVERGE_MS * 2);
    const servedBefore = (await fluxDriveManifests(name)).map((m) => m.version);
    const update = await updateContentApp(url(registrar), { name, ...shape(), contentSlots: [slot(v3)], ownerKey: owner });
    expect(update.status, `the update is accepted: ${JSON.stringify(update).slice(0, 300)}`).to.equal('success');
    await decidedEverywhere(update.data, 'undecided', 'every node holds the unpaid update');
    const waiting = await fluxDrivePending(harnessNow());
    expect(waiting, 'the update\'s manifest put and reconcile wait on it').to.include({ pending: 2, kept: 2 });

    await advanceHarnessClock(PAYMENT_WINDOW_S + 60);
    await advanceBlocks(MAX_REORG_LENGTH + 1);
    await decidedEverywhere(update.data, 'unpayable', 'every node records the update unpayable');

    const decided = await fluxDrivePending(harnessNow());
    expect(decided, 'both writes are discarded').to.include({ pending: 2, discarded: 2, applied: 0 });
    expect((await fluxDriveManifests(name)).map((m) => m.version), 'FluxDrive serves what it served before the update').to.deep.equal(servedBefore);
  });
});
