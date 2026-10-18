// fleet: 4
/*
 * A spec update that adds a content slot, on the real FluxDrive.
 *
 * The update carries the file list for every slot the new spec declares, and
 * FluxDrive holds its writes pending until the nodes answer, by the update's
 * own hash, whether it applied. With pending and GC passes run at the times the
 * suite names:
 *   - an update that rotates the slot and adds another, never paid, leaves the
 *     node's slots, the manifest FluxDrive serves and the live blob as they were,
 *     past the grace;
 *   - two updates adding a slot each, applied between two passes, both reach
 *     FluxDrive in one pass, the first though the app list never named its spec,
 *     and the host fills each new slot when its update applies;
 *   - a node held off every node that runs the app installs it from FluxDrive
 *     alone with every slot filled.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { appOwnerKey } from '../framework/keys.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { confirmOnChain } from '../framework/app-helper.js';
import { deployContentApp, requestBlobLocator, updateContentApp } from '../framework/content-helper.js';
import { blobHash } from '../framework/content-crypto-v9.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';
import { readFileInContainer } from '../framework/container.js';
import { appView } from '../framework/app-view.js';
import { advanceBlocks } from '../framework/daemon-control.js';
import { advanceHarnessClock, harnessNow } from '../framework/harness-clock.js';
import {
  fluxDriveHolds, fluxDriveManifests, fluxDrivePending, fluxDriveSweep,
} from '../framework/fluxdrive-real.js';
import { waitFor, waitForDaemonReady, waitForInstallSettled } from '../framework/wait.js';

const NODES = 4;
const RUNNING = [0, 1, 2];
const FRESH = 3; // boots after both updates, held off every node that runs the app
const CONVERGE_MS = 300000;
const HOUR_S = 3600;
const DAY_MS = 24 * HOUR_S * 1000;
// FluxDrive's grace for content an owner superseded (CONTENT_GC_GRACE_MS, its floor)
const GRACE_MS = 2 * DAY_MS;
// A node drops an unpaid message once a block stamped past its payment window
// (an hour after its signing) is this many blocks deep: fluxd's MAX_REORG_LENGTH.
const REORG_DEPTH = 40;

const CONF = { name: 'conf', destination: '/etc/app.conf', onUpdate: { action: 'restart' } };
const EXTRA = { name: 'extra', destination: '/etc/extra.conf', onUpdate: { action: 'restart' } };
const MORE = { name: 'more', destination: '/etc/more.conf', onUpdate: { action: 'restart' } };

describe('a slot added by a spec update, on the real FluxDrive', function () {
  let env;
  let view;
  let host;
  let registrar;
  let image;
  let targets;
  let registration;
  let second;
  const locators = {};
  const owner = appOwnerKey();
  const name = `slotadded${Date.now()}`;
  const bytes = {
    conf1: Buffer.from(`conf ${name} registered with\n`),
    conf2: Buffer.from(`conf an unpaid update of ${name} rotates to\n`),
    unpaidExtra: Buffer.from(`extra an unpaid update of ${name} adds\n`),
    extra: Buffer.from(`extra the first paid update of ${name} adds\n`),
    more: Buffer.from(`more the second paid update of ${name} adds\n`),
  };
  const url = (i) => env.clients[i].url;

  // The component, mounting every slot the spec declares.
  function components(slots) {
    const mounts = { '/data': { source: 'data', destination: '/data' } };
    for (const s of slots) {
      mounts[s.destination] = {
        source: s.name, destination: s.destination, type: 'file', contentSlot: s.name, onUpdate: s.onUpdate,
      };
    }
    return {
      web: {
        name: 'web',
        description: 'a slot added by a spec update',
        image,
        cpu: 0.5,
        memory: 300,
        rootFsGb: 2,
        persistentStorage: { sizeGb: 1, mounts },
        ports: { http: { containerPort: 80, hostPort: 31255 } },
      },
    };
  }
  const shape = (slots) => ({ instances: 2, placement: { targetIps: targets }, components: components(slots) });

  async function locatorOf(content) {
    const res = await requestBlobLocator(url(registrar), { name, contentHash: blobHash(content), ownerKey: owner });
    expect(res.status, `the locator of ${content.toString().trim()}: ${JSON.stringify(res).slice(0, 300)}`).to.equal('success');
    return res.data.locator;
  }

  async function decisionOn(index, hash) {
    const { status, data } = await env.clients[index].request('GET', `/v2/apps/messages/${hash}/decision`);
    return status === 200 ? data.data.decision : null;
  }

  async function decidedEverywhere(hash, decision, label) {
    await waitFor(async () => (await Promise.all(RUNNING.map((i) => decisionOn(i, hash)))).every((d) => d === decision), {
      timeout: CONVERGE_MS, interval: 3000, label,
    });
  }

  async function slotOn(index, slot) {
    const r = await readFileInContainer(env.clients[index].container, name, 'web', slot.destination).catch(() => null);
    return r?.exitCode === 0 ? r.content : null;
  }

  async function slotEverywhere(slot, content, indices, label) {
    await waitFor(async () => (await Promise.all(indices.map((i) => slotOn(i, slot)))).every((c) => c === content.toString()), {
      timeout: CONVERGE_MS, interval: 3000, label,
    });
  }

  async function sweep(now) {
    const pass = await fluxDriveSweep(now);
    expect(pass.skipped, `the pass at ${new Date(now).toISOString()} reads the live set: ${JSON.stringify(pass)}`).to.not.equal(true);
    return pass;
  }

  const servedVersions = async () => (await fluxDriveManifests(name)).map((m) => m.version).sort((a, b) => a - b);

  // A paid update adding a slot: applied on every node, and the host fills the
  // new slot when it applies.
  async function addSlot(slots, added, label) {
    const update = await updateContentApp(url(registrar), { name, ...shape(slots.map((s) => s.slot)), ownerKey: owner, contentSlots: slots.map((s) => ({ ...s.slot, ...s.entry })) });
    expect(update.status, `${label}: ${JSON.stringify(update).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(update.data, RUNNING.map((i) => env.clients[i]));
    await decidedEverywhere(update.data, 'applied', `${label}: every node decides it applied`);
    await view.listedEverywhere(update.data, RUNNING, `${label}: every node lists it`);
    await slotEverywhere(added.slot, added.content, [host], `${label}: the host fills the new slot`);
    return update;
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
    await pushBusybox(name);
    image = `${REGISTRY_REPO_HOST}/${name}:v1`;
  });

  after(async function () {
    this.timeout(120000);
    await env?.teardown();
  });

  it('leaves the slots, the manifest FluxDrive serves and the live blob as they were when an update adding a slot is never paid', async function () {
    this.timeout(CONVERGE_MS * 3);
    registration = await deployContentApp(url(registrar), {
      name, ...shape([CONF]), ownerKey: owner, contentSlots: [{ ...CONF, bytes: bytes.conf1 }],
    });
    expect(registration.status, `the registration is accepted: ${JSON.stringify(registration).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(registration.data, RUNNING.map((i) => env.clients[i]));
    await decidedEverywhere(registration.data, 'applied', 'every node decides the registration applied');
    expect(await fluxDrivePending(harnessNow()), 'the registration\'s manifest put applies').to.include({ applied: 1 });
    await waitForInstallSettled(env.clients[host], name, CONVERGE_MS);
    await slotEverywhere(CONF, bytes.conf1, [host], 'the host fills the registration\'s slot');
    locators.conf1 = await locatorOf(bytes.conf1);

    const unpaid = await updateContentApp(url(registrar), {
      name,
      ...shape([CONF, EXTRA]),
      ownerKey: owner,
      contentSlots: [{ ...CONF, bytes: bytes.conf2 }, { ...EXTRA, bytes: bytes.unpaidExtra }],
    });
    expect(unpaid.status, `the update is accepted: ${JSON.stringify(unpaid).slice(0, 300)}`).to.equal('success');
    await waitFor(async () => (await Promise.all(RUNNING.map(async (i) => (await env.clients[i].getTempMessages(unpaid.data)).data?.length > 0))).every(Boolean), {
      timeout: 60000, interval: 2000, label: 'every node holds the update waiting for payment',
    });
    const asked = await fluxDrivePending(harnessNow());
    expect(asked.kept, `FluxDrive keeps the update's writes pending while it waits: ${JSON.stringify(asked)}`).to.be.at.least(1);

    // the payment window closes, then the chain moves past the reorg depth
    await advanceHarnessClock(2 * HOUR_S);
    await advanceBlocks(REORG_DEPTH + 2);
    await decidedEverywhere(unpaid.data, 'unpayable', 'every node records the update unpayable');

    const past = harnessNow() + GRACE_MS + DAY_MS;
    const settled = await fluxDrivePending(past);
    expect(settled.discarded, `FluxDrive discards the unpaid update's writes: ${JSON.stringify(settled)}`).to.be.at.least(1);
    const pass = await sweep(past);
    expect(await servedVersions(), `FluxDrive serves the registration's manifest alone: ${JSON.stringify(pass)}`).to.deep.equal([1]);
    expect(await fluxDriveHolds(locators.conf1), 'FluxDrive holds the live blob').to.equal(true);
    expect(await slotOn(host, CONF), 'the host\'s slot is unchanged').to.equal(bytes.conf1.toString());
    expect(await slotOn(host, EXTRA), 'the host has no slot the unpaid update declares').to.equal(null);
    await view.listedEverywhere(registration.data, RUNNING, 'every node still lists the registration');
  });

  it('applies the writes of two updates adding a slot in one pass, the first though the app list never named its spec', async function () {
    this.timeout(CONVERGE_MS * 4);
    const first = await addSlot([
      { slot: CONF, entry: { hash: blobHash(bytes.conf1) } },
      { slot: EXTRA, entry: { bytes: bytes.extra } },
    ], { slot: EXTRA, content: bytes.extra }, 'the first update');
    second = await addSlot([
      { slot: CONF, entry: { hash: blobHash(bytes.conf1) } },
      { slot: EXTRA, entry: { hash: blobHash(bytes.extra) } },
      { slot: MORE, entry: { bytes: bytes.more } },
    ], { slot: MORE, content: bytes.more }, 'the second update');

    const pass = await fluxDrivePending(harnessNow());
    expect(pass.applied, `one pass applies both updates' writes: ${JSON.stringify(pass)}`).to.be.at.least(2);
    expect(await servedVersions(), 'FluxDrive serves the registration\'s manifest and both updates\'')
      .to.deep.equal([1, first.manifest.version, second.manifest.version]);
    locators.extra = await locatorOf(bytes.extra);
    locators.more = await locatorOf(bytes.more);
    expect(await fluxDriveHolds(locators.extra), 'FluxDrive holds the first update\'s blob').to.equal(true);
    expect(await fluxDriveHolds(locators.more), 'FluxDrive holds the second update\'s blob').to.equal(true);
  });

  it('installs every slot from FluxDrive alone on a node held off every node that runs the app', async function () {
    this.timeout(CONVERGE_MS * 2);
    await env.holdOutPendingNode(FRESH, [host]);
    const fresh = await env.startNode(FRESH);
    const mark = fresh.getLastEventId();
    await waitForDaemonReady(fresh);
    await env.startDiscovery([FRESH]);
    await view.installedEverywhere(second.data, [FRESH], 'the node installs the app as updated');
    const resolved = await fresh.waitForEvent('content:blobResolved', (d) => d.appName === name, CONVERGE_MS, { afterId: mark });
    expect(resolved.data.source, 'the files came from FluxDrive').to.equal('fluxdrive');
    await slotEverywhere(CONF, bytes.conf1, [FRESH], 'the node fills the registration\'s slot');
    await slotEverywhere(EXTRA, bytes.extra, [FRESH], 'the node fills the first update\'s slot');
    await slotEverywhere(MORE, bytes.more, [FRESH], 'the node fills the second update\'s slot');
    await env.releasePendingNode(FRESH, [host]);
    await env.startDiscovery([FRESH]);
  });
});
