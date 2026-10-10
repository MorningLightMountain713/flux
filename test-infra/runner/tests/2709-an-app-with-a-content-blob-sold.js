// fleet: 8
/*
 * A v9 app with a content blob, sold while it runs.
 *
 * The app's immutable blob is keyed by the app's identity, which a sale keeps.
 * The app names four nodes: two that run it before the sale, one of which is off
 * the network through the sale, and two that boot afterwards. Then:
 *   - the blob on the node that ran through the sale is the same bytes, and its
 *     container never restarted;
 *   - the returning node holds the sale with the same blob;
 *   - the first node to boot afterwards installs with the blob from a peer, so
 *     the hosts still serve it;
 *   - the second is held off every node that holds the app and installs with the
 *     blob from FluxDrive alone;
 *   - the buyer's update with a new blob delivers it to every node;
 *   - a resale undone by a rewind leaves every row as it stood.
 *
 * The app runs the harness's busybox image, so its file can be read inside the
 * container.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { loadSharedConfig } from '../framework/coupled-knobs.js';
import { appOwnerKey } from '../framework/keys.js';
import { buyerKey, transferApp } from '../framework/transfer-helper.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { confirmOnChain } from '../framework/app-helper.js';
import { deployContentApp, updateContentApp, updateEncryptedV9App } from '../framework/content-helper.js';
import { blobHash } from '../framework/content-crypto-v9.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';
import { readFileInContainer } from '../framework/container.js';
import { appView } from '../framework/app-view.js';
import {
  advanceBlocks, getState, queueAppTx, reorgChain, startTicker, stopTicker,
} from '../framework/daemon-control.js';
import {
  waitFor, waitForDaemonReady, waitForInstallSettled, waitForReorg,
} from '../framework/wait.js';
import { appIdentityFromUuid, appUuid } from '@runonflux/flux-spec';

const NODES = 6;
const FROM_A_PEER = 4; // boots after the sale and fetches from a host
const FROM_FLUXDRIVE = 5; // boots after the sale, held off every host
const CONVERGE_MS = 300000;
const OUTAGE_LIMIT_MS = (loadSharedConfig().fluxapps.nodeDownGraceS - 20) * 1000;
const REF_PATH = '/etc/ref.conf';

describe('an app with a content blob sold while it runs', function () {
  let env;
  let view;
  let host;
  let away;
  let registrar;
  let image;
  let registered;
  let sold;
  let buyersUpdate;
  let hostContainer;
  const seller = appOwnerKey();
  const buyer = buyerKey();
  const name = `blobsale${Date.now()}`;
  const v1 = Buffer.from(`the blob ${name} registered with\n`);
  const v2 = Buffer.from(`the blob the buyer of ${name} delivers\n`);
  const url = (i) => env.clients[i].url;
  const live = () => env.clients.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
  let targets;

  // The component, mounting the blob whose hash it names.
  function components(bytes) {
    return {
      web: {
        name: 'web',
        description: 'content blob sold',
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
        ports: { http: { containerPort: 80, hostPort: 31240 } },
      },
    };
  }

  const shape = (bytes) => ({ instances: 4, placement: { targetIps: targets }, components: components(bytes) });

  async function blobOn(index) {
    const r = await readFileInContainer(env.clients[index].container, name, 'web', REF_PATH).catch(() => null);
    return r?.exitCode === 0 ? r.content : null;
  }

  async function blobEverywhere(bytes, indices, label) {
    await waitFor(async () => (await Promise.all(indices.map(blobOn))).every((c) => c === bytes.toString()), {
      timeout: CONVERGE_MS, interval: 3000, label,
    });
  }

  // The source a node's install took the blob from.
  async function blobSource(index, mark) {
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
      // The chain's push path: a node hears the rewind as it happens.
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
    const reg = await deployContentApp(url(registrar), { name, contentRef: v1, ...shape(v1) });
    expect(reg.status, `the registration is accepted: ${JSON.stringify(reg).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(reg.data, env.clients.filter(Boolean));
    const uuid = appUuid(name, reg.data);
    registered = {
      spec: { name, owner: seller.zelid, hash: reg.data }, hash: reg.data, uuid, identity: appIdentityFromUuid(uuid),
    };
    await Promise.all([host, away].map((i) => waitForInstallSettled(env.clients[i], name, CONVERGE_MS)));
  });

  after(async function () {
    this.timeout(120000);
    await env?.teardown();
  });

  it('runs the app with its blob on both hosts', async function () {
    this.timeout(CONVERGE_MS);
    await blobEverywhere(v1, [host, away], 'both hosts hold the blob');
    hostContainer = await view.containerOn(host);
  });

  it('keeps the host\'s blob and container through a sale made while the other host is away', async function () {
    this.timeout(1200000);
    await env.disconnectNode(away);
    const wentAway = Date.now();
    const stayers = live().filter((i) => i !== away);
    const result = await transferApp(url(registrar), seller, registered, stayers.map((i) => env.clients[i]), { v9: shape(v1) });
    await env.reconnectNode(away);
    expect(Date.now() - wentAway, 'the node was away for less than the node-down grace').to.be.below(OUTAGE_LIMIT_MS);
    expect(result.status, `the sale is accepted: ${JSON.stringify(result).slice(0, 300)}`).to.equal('success');
    sold = result.app;
    await view.installedEverywhere(sold.spec.hash, [host], 'the host adopts the sale');
    expect(await blobOn(host), 'the host\'s blob').to.equal(v1.toString());
    const now = await view.containerOn(host);
    expect(now.id, 'the host\'s container was not recreated').to.equal(hostContainer.id);
    expect(now.startedAt, 'the host\'s container was not restarted').to.equal(hostContainer.startedAt);
  });

  it('brings the returning host to the sale with the same blob', async function () {
    this.timeout(CONVERGE_MS * 2);
    await waitForDaemonReady(env.clients[away]);
    await view.installedEverywhere(sold.spec.hash, [away], 'the returning node adopts the sale');
    expect(await blobOn(away), 'the returning node\'s blob').to.equal(v1.toString());
  });

  it('installs the blob from a peer on a node that boots afterwards', async function () {
    this.timeout(CONVERGE_MS * 2);
    const fresh = await env.startNode(FROM_A_PEER);
    const mark = fresh.getLastEventId();
    await waitForDaemonReady(fresh);
    await env.startDiscovery([FROM_A_PEER]);
    await view.installedEverywhere(sold.spec.hash, [FROM_A_PEER], 'the node installs the app as sold');
    expect(await blobSource(FROM_A_PEER, mark), 'the blob came from a peer').to.not.equal('fluxdrive');
    await blobEverywhere(v1, [FROM_A_PEER], 'the node holds the blob');
  });

  it('installs the blob from FluxDrive alone on a node held off every node that holds the app', async function () {
    this.timeout(CONVERGE_MS * 2);
    const holders = [host, away, FROM_A_PEER];
    await env.holdOutPendingNode(FROM_FLUXDRIVE, holders);
    const fresh = await env.startNode(FROM_FLUXDRIVE);
    const mark = fresh.getLastEventId();
    await waitForDaemonReady(fresh);
    await env.startDiscovery([FROM_FLUXDRIVE]);
    await view.installedEverywhere(sold.spec.hash, [FROM_FLUXDRIVE], 'the node installs the app as sold');
    expect(await blobSource(FROM_FLUXDRIVE, mark), 'the blob came from FluxDrive').to.equal('fluxdrive');
    await blobEverywhere(v1, [FROM_FLUXDRIVE], 'the node holds the blob');
    await env.releasePendingNode(FROM_FLUXDRIVE, holders);
    await env.startDiscovery([FROM_FLUXDRIVE]);
  });

  it('delivers the buyer\'s new blob to every node', async function () {
    this.timeout(1200000);
    const res = await updateContentApp(url(registrar), {
      name, contentRef: v2, ...shape(v2), owner: buyer.zelid, ownerKey: buyer,
    });
    expect(res.status, `the buyer's update is accepted: ${JSON.stringify(res).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(res.data, env.clients.filter(Boolean));
    buyersUpdate = res.data;
    const hosts = [host, away, FROM_A_PEER, FROM_FLUXDRIVE];
    await view.installedEverywhere(buyersUpdate, hosts, 'every node runs the buyer\'s update');
    await blobEverywhere(v2, hosts, 'every node holds the buyer\'s blob');
  });

  it('leaves every row as it stood before a resale that a rewind undoes', async function () {
    this.timeout(1200000);
    const nodes = live();
    await stopTicker();
    const forkHeight = (await getState()).currentHeight;
    const resale = await updateEncryptedV9App(url(registrar), {
      name, ...shape(v2), owner: seller.zelid, ownerKey: buyer,
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
    await view.listedEverywhere(buyersUpdate, nodes, 'every node lists the buyer\'s update again');
    for (const i of nodes) {
      // eslint-disable-next-line no-await-in-loop
      expect((await view.listedOn(i)).owner, `node ${i}'s row names the buyer`).to.equal(buyer.zelid);
    }
    await startTicker();
  });
});
