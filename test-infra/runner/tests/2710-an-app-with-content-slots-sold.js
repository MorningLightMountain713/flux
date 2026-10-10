// fleet: 8
/*
 * A v9 app with content slots, sold while it runs.
 *
 * A slot app stands on an owner-signed manifest; the sale names the manifest the
 * app stands on, in the spec's `content` block. The app names four nodes: two
 * that run it before the sale, one of which is off the network while the sale is
 * paid, and two that boot afterwards. Then:
 *   - while the sale waits unpaid, a content update is refused from the buyer,
 *     who is not yet the owner, and from the seller, since a sale waits;
 *   - the host's slots are unchanged: no slot applied, so its component was
 *     neither signalled nor restarted;
 *   - the returning node stands on the manifest the sale names;
 *   - the first node to boot afterwards installs its slots from a peer, the
 *     second, held off every node that holds the app, from FluxDrive alone;
 *   - the buyer's content update applies on every node and the seller's is
 *     refused;
 *   - a resale undone by a rewind leaves the buyer's manifest standing.
 *
 * The app runs the harness's busybox image, so its slot can be read inside the
 * container. Its slot reacts to an update with a signal, so a slot applied by
 * the sale would show.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { loadSharedConfig } from '../framework/coupled-knobs.js';
import { appOwnerKey } from '../framework/keys.js';
import { buyerKey } from '../framework/transfer-helper.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { confirmOnChain } from '../framework/app-helper.js';
import {
  deployContentApp, manifestStanding, pushContentUpdate, updateEncryptedV9App,
} from '../framework/content-helper.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';
import { readFileInContainer } from '../framework/container.js';
import { appView } from '../framework/app-view.js';
import {
  advanceBlocks, getState, queueAppTx, reorgChain, startTicker, stopTicker,
} from '../framework/daemon-control.js';
import {
  assertNoEvent, waitFor, waitForDaemonReady, waitForInstallSettled, waitForReorg,
} from '../framework/wait.js';

const NODES = 6;
const FROM_A_PEER = 4;
const FROM_FLUXDRIVE = 5;
const CONVERGE_MS = 300000;
const OUTAGE_LIMIT_MS = (loadSharedConfig().fluxapps.nodeDownGraceS - 20) * 1000;
const SLOT = 'cfg';
const SLOT_PATH = '/etc/app.conf';

describe('an app with content slots sold while it runs', function () {
  let env;
  let view;
  let host;
  let away;
  let registrar;
  let image;
  let saleHash;
  let namedManifest; // the hash of the manifest the sale names
  let buyersManifest;
  let hostContainer;
  let slotMark; // the host's event id once the sale has applied
  let targets;
  const seller = appOwnerKey();
  const buyer = buyerKey();
  const name = `slotsale${Date.now()}`;
  const v1 = Buffer.from(`slot v1 of ${name}\n`);
  const v2 = Buffer.from(`slot v2 the buyer of ${name} pushed\n`);
  const url = (i) => env.clients[i].url;
  const live = () => env.clients.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);

  const components = {
    web: {
      name: 'web',
      description: 'content slots sold',
      image: null,
      cpu: 0.5,
      memory: 300,
      rootFsGb: 2,
      persistentStorage: {
        sizeGb: 1,
        mounts: {
          '/data': { source: 'data', destination: '/data' },
          [SLOT_PATH]: {
            source: SLOT, destination: SLOT_PATH, type: 'file', contentSlot: SLOT, onUpdate: 'signal',
          },
        },
      },
      ports: { http: { containerPort: 80, hostPort: 31250 } },
    },
  };
  const shape = () => ({ instances: 4, placement: { targetIps: targets }, components });

  async function slotOn(index) {
    const r = await readFileInContainer(env.clients[index].container, name, 'web', SLOT_PATH).catch(() => null);
    return r?.exitCode === 0 ? r.content : null;
  }

  async function slotEverywhere(bytes, indices, label) {
    await waitFor(async () => (await Promise.all(indices.map(slotOn))).every((c) => c === bytes.toString()), {
      timeout: CONVERGE_MS, interval: 3000, label,
    });
  }

  async function standingOn(index) {
    return (await manifestStanding(url(index), name)).standing?.hash ?? null;
  }

  async function standingEverywhere(hash, indices, label) {
    await waitFor(async () => (await Promise.all(indices.map(standingOn))).every((h) => h === hash), {
      timeout: CONVERGE_MS, interval: 3000, label,
    });
  }

  async function slotSource(index, mark) {
    const resolved = await env.clients[index].waitForEvent(
      'content:blobResolved', (d) => d.appName === name, CONVERGE_MS, { afterId: mark },
    );
    return resolved.data.source;
  }

  before(async function () {
    this.timeout(1200000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      deferredNodes: 2,
      tickerAutostart: false,
      arcane: true,
      zmqTopics: ALL_ZMQ_TOPICS,
      configOverrides: { fluxapps: { minOutgoing: 2, adoptionStaggerStepMs: 5000, adoptionStaggerWindowMs: 10000 } },
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });
    view = appView(env, name, { component: 'web', timeout: CONVERGE_MS });
    const running = [0, 1, 2, 3];
    const ordinary = running.filter((i) => !env.establishedNodes.includes(i));
    [host, away] = ordinary;
    registrar = running.find((i) => i !== host && i !== away);
    const ip = (i) => getSubnetConfig().nodeIp(i + 1);
    targets = [host, away, FROM_A_PEER, FROM_FLUXDRIVE].map(ip);
    expect(buyer.zelid, 'the fixture names two owners').to.not.equal(seller.zelid);

    await pushBusybox(name);
    image = `${REGISTRY_REPO_HOST}/${name}:v1`;
    components.web.image = image;
    const reg = await deployContentApp(url(registrar), {
      name, ...shape(), contentSlots: [{ name: SLOT, destination: SLOT_PATH, bytes: v1, onUpdate: 'signal' }],
    });
    expect(reg.status, `the registration is accepted: ${JSON.stringify(reg).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(reg.data, env.clients.filter(Boolean));
    await Promise.all([host, away].map((i) => waitForInstallSettled(env.clients[i], name, CONVERGE_MS)));
  });

  after(async function () {
    this.timeout(120000);
    await env?.teardown();
  });

  it('runs the app with its slot on both hosts', async function () {
    this.timeout(CONVERGE_MS);
    await slotEverywhere(v1, [host, away], 'both hosts hold the slot');
    namedManifest = await standingOn(registrar);
    expect(namedManifest, 'the app stands on a manifest').to.be.a('string');
    hostContainer = await view.containerOn(host);
  });

  it('refuses a content update from either owner while the sale waits, then keeps the host\'s slot through it', async function () {
    this.timeout(1200000);
    const submitted = await updateEncryptedV9App(url(registrar), {
      name, ...shape(), owner: buyer.zelid, ownerKey: seller, specOverrides: { content: { manifest: namedManifest } },
    });
    expect(submitted.status, `the sale is accepted: ${JSON.stringify(submitted).slice(0, 300)}`).to.equal('success');
    saleHash = submitted.data;
    await waitFor(async () => {
      const held = await Promise.all(live().map(async (i) => (await env.clients[i].getTempMessages(saleHash)).data?.length > 0));
      return held.every(Boolean);
    }, { timeout: 60000, interval: 2000, label: 'every node holds the waiting sale' });

    const fromBuyer = await pushContentUpdate(url(registrar), { name, slots: [{ name: SLOT, bytes: v2 }], ownerKey: buyer });
    expect(fromBuyer.status, `the buyer's content update while the sale waits: ${JSON.stringify(fromBuyer).slice(0, 300)}`).to.equal('error');
    const fromSeller = await pushContentUpdate(url(registrar), { name, slots: [{ name: SLOT, bytes: v2 }], ownerKey: seller });
    expect(fromSeller.status, `the seller's content update while the sale waits: ${JSON.stringify(fromSeller).slice(0, 300)}`).to.equal('error');

    const mark = env.clients[host].getLastEventId();
    await env.disconnectNode(away);
    const wentAway = Date.now();
    const stayers = live().filter((i) => i !== away);
    await confirmOnChain(saleHash, stayers.map((i) => env.clients[i]));
    await env.reconnectNode(away);
    expect(Date.now() - wentAway, 'the node was away for less than the node-down grace').to.be.below(OUTAGE_LIMIT_MS);

    await view.listedEverywhere(saleHash, stayers, 'every node that stayed lists the sale');
    await view.installedEverywhere(saleHash, [host], 'the host adopts the sale');
    expect(await slotOn(host), 'the host\'s slot').to.equal(v1.toString());
    // No slot applied on the host since before the sale, so its component was not
    // signalled; the buyer's content update below is the canary that the event
    // is seen on this node.
    await assertNoEvent(env.clients[host], 'content:slotApplied', (d) => d.appName === name, 5000, { afterId: mark });
    slotMark = env.clients[host].getLastEventId();
    const now = await view.containerOn(host);
    expect(now.startedAt, 'the host\'s container was not restarted').to.equal(hostContainer.startedAt);
  });

  it('brings the returning node onto the manifest the sale names', async function () {
    this.timeout(CONVERGE_MS * 2);
    await waitForDaemonReady(env.clients[away]);
    await view.installedEverywhere(saleHash, [away], 'the returning node adopts the sale');
    await standingEverywhere(namedManifest, [away], 'the returning node stands on the named manifest');
    expect(await slotOn(away), 'the returning node\'s slot').to.equal(v1.toString());
  });

  it('installs the slot from a peer on a node that boots afterwards', async function () {
    this.timeout(CONVERGE_MS * 2);
    const fresh = await env.startNode(FROM_A_PEER);
    const mark = fresh.getLastEventId();
    await waitForDaemonReady(fresh);
    await env.startDiscovery([FROM_A_PEER]);
    await view.installedEverywhere(saleHash, [FROM_A_PEER], 'the node installs the app as sold');
    expect(await slotSource(FROM_A_PEER, mark), 'the slot came from a peer').to.not.equal('fluxdrive');
    await slotEverywhere(v1, [FROM_A_PEER], 'the node holds the slot');
  });

  it('installs the slot from FluxDrive alone on a node held off every node that holds the app', async function () {
    this.timeout(CONVERGE_MS * 2);
    const holders = [host, away, FROM_A_PEER];
    await env.holdOutPendingNode(FROM_FLUXDRIVE, holders);
    const fresh = await env.startNode(FROM_FLUXDRIVE);
    const mark = fresh.getLastEventId();
    await waitForDaemonReady(fresh);
    await env.startDiscovery([FROM_FLUXDRIVE]);
    await view.installedEverywhere(saleHash, [FROM_FLUXDRIVE], 'the node installs the app as sold');
    expect(await slotSource(FROM_FLUXDRIVE, mark), 'the slot came from FluxDrive').to.equal('fluxdrive');
    await slotEverywhere(v1, [FROM_FLUXDRIVE], 'the node holds the slot');
    await env.releasePendingNode(FROM_FLUXDRIVE, holders);
    await env.startDiscovery([FROM_FLUXDRIVE]);
  });

  it('applies the buyer\'s content update on every node and refuses the seller\'s', async function () {
    this.timeout(CONVERGE_MS * 2);
    const fromSeller = await pushContentUpdate(url(registrar), { name, slots: [{ name: SLOT, bytes: v2 }], ownerKey: seller });
    expect(fromSeller.status, 'the seller\'s content update').to.equal('error');

    const res = await pushContentUpdate(url(registrar), { name, slots: [{ name: SLOT, bytes: v2 }], ownerKey: buyer });
    expect(res.status, `the buyer's content update: ${JSON.stringify(res).slice(0, 300)}`).to.equal('success');
    await env.clients[host].waitForEvent('content:slotApplied', (d) => d.appName === name, CONVERGE_MS, { afterId: slotMark });
    const hosts = [host, away, FROM_A_PEER, FROM_FLUXDRIVE];
    await slotEverywhere(v2, hosts, 'every node holds the buyer\'s slot');
    buyersManifest = await standingOn(registrar);
    expect(buyersManifest, 'the buyer\'s manifest stands').to.not.equal(namedManifest);
    await standingEverywhere(buyersManifest, hosts, 'every node stands on the buyer\'s manifest');
  });

  it('leaves the buyer\'s manifest standing after a resale that a rewind undoes', async function () {
    this.timeout(1200000);
    const nodes = live();
    await stopTicker();
    const forkHeight = (await getState()).currentHeight;
    const resale = await updateEncryptedV9App(url(registrar), {
      name, ...shape(), owner: seller.zelid, ownerKey: buyer, specOverrides: { content: { manifest: buyersManifest } },
    });
    expect(resale.status, `the resale is accepted: ${JSON.stringify(resale).slice(0, 300)}`).to.equal('success');
    await waitFor(async () => {
      const held = await Promise.all(nodes.map(async (i) => (await env.clients[i].getTempMessages(resale.data)).data?.length > 0));
      return held.every(Boolean);
    }, { timeout: 60000, interval: 2000, label: 'every node holds the resale' });
    await queueAppTx(resale.data);
    await advanceBlocks(2);
    await view.listedEverywhere(resale.data, nodes, 'every node lists the resale');

    const mark = env.clients[registrar].getLastEventId();
    await reorgChain({ forkHeight });
    await waitForReorg(env.clients[registrar], (d) => d.forkHeight === forkHeight, 60000, { afterId: mark });
    await advanceBlocks(1);
    await standingEverywhere(buyersManifest, nodes, 'every node stands on the buyer\'s manifest');
    for (const i of nodes) {
      // eslint-disable-next-line no-await-in-loop
      expect((await view.listedOn(i)).owner, `node ${i}'s row names the buyer`).to.equal(buyer.zelid);
    }
    await startTicker();
  });
});
