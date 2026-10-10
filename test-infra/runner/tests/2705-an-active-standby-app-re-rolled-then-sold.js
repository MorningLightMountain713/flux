// fleet: 12
/*
 * An activeStandby app whose owner re-rolled it, then sold it.
 *
 * A v9 encrypted app whose one component syncs activeStandby names three nodes:
 * its primary's, its standby's, and a node that boots after the sale. The owner
 * re-rolls its master role to generation 1, then sells it through the door while
 * the standby is off the network; the sale names the generation-1 record in its
 * `grants` block. Then:
 *   - the primary keeps the term, at generation 1, and its container;
 *   - the standby returns holding the sale and is still a standby;
 *   - the node that boots afterwards installs the app as a standby, holds the
 *     record the sale names although the outgoing owner signed it, and takes the
 *     term when the primary and the standby both stand down;
 *   - the buyer re-rolls to generation 2 and the fleet follows;
 *   - a resale undone by a rewind leaves every row as it stood.
 *
 * A re-roll is the owner's sequence: the app yields and stops, the record is
 * posted, the app restarts, and the generation's drain lifts after its blocks.
 * Standing down is a local yield, so no node leaves the network for longer than
 * the node-down grace.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { loadSharedConfig } from '../framework/coupled-knobs.js';
import { authenticate } from '../auth.js';
import { appOwnerKey } from '../framework/keys.js';
import { buyerKey, transferApp } from '../framework/transfer-helper.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { confirmOnChain } from '../framework/app-helper.js';
import { registerEncryptedV9App, updateEncryptedV9App } from '../framework/content-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { nodeOutpoint } from '../framework/seed-helper.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';
import {
  appDataRoot, appSyncthingFolderId, componentIdentifier, execInContainer,
} from '../framework/container.js';
import { setSynced } from '../framework/syncthing-control.js';
import { grantPlaneOverrides, grantVerdict } from '../framework/grant-record.js';
import { postGenerationRecord } from '../framework/generation-record.js';
import { appView } from '../framework/app-view.js';
import {
  advanceBlocks, getState, queueAppTx, reorgChain, startTicker, stopTicker,
} from '../framework/daemon-control.js';
import {
  waitFor, waitForDaemonReady, waitForInstallSettled, waitForReconcileActuated, waitForReorg,
} from '../framework/wait.js';
import { appIdentityFromUuid, appUuid, generationRecordHash } from '@runonflux/flux-spec';

const NODES = 11;
const FRESH = 10; // boots after the sale
const QUORUM = 5;
const DRAIN_BLOCKS = 3;
const CONVERGE_MS = 300000;
const OUTAGE_LIMIT_MS = (loadSharedConfig().fluxapps.nodeDownGraceS - 20) * 1000;

describe('an activeStandby app re-rolled, then sold', function () {
  let env;
  let view;
  let primary;
  let standby;
  let registrar;
  let key; // `<identity>/master`
  let identifier;
  let registered;
  let sold;
  let shape;
  let sellersRecord; // the generation-1 record the sale names
  let buyersRecord; // the generation-2 record
  let masterGrantee;
  let primaryContainer;
  const seller = appOwnerKey();
  const buyer = buyerKey();
  const name = `rerollsale${Date.now()}`;

  const url = (i) => env.clients[i].url;
  const indexOfGrantee = (grantee) => env.clients.findIndex((c, i) => c && nodeOutpoint(i) === grantee);
  const verdict = () => grantVerdict(env.clients, key, { quorum: QUORUM });
  const live = () => env.clients.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);

  async function seedData(index) {
    const dir = `${await appDataRoot(env.clients[index].container, name, null)}/appdata`;
    const r = await execInContainer(env.clients[index].container, `sh -c 'mkdir -p ${dir} && echo seeded > ${dir}/seed-data'`);
    expect(r.exitCode, `seed data written on node ${index}: ${r.output}`).to.equal(0);
  }

  async function ownerGet(index, path, ownerKey) {
    const { zelidauth } = await authenticate(url(index), ownerKey);
    const res = await fetch(`${url(index)}${path}`, { headers: { zelidauth } });
    const body = await res.json();
    expect(body.status, `${path} on node ${index}: ${JSON.stringify(body).slice(0, 200)}`).to.equal('success');
    return body;
  }

  // The owner's re-roll of the master role to `generation`, the app stopped across
  // it: yield and stop everywhere, post the record, restart, and mine the drain.
  async function reroll(generation, ownerKey, holders) {
    await stopTicker();
    try {
      const markers = env.clients.map((c) => c?.getLastEventId());
      await ownerGet(registrar, `/apps/appyield/${name}/true`, ownerKey);
      await Promise.all(holders.map((i) => waitForReconcileActuated(
        env.clients[i], identifier, 'settledStopped', 120000, { afterId: markers[i] },
      )));
      const { zelidauth } = await authenticate(url(registrar), ownerKey);
      const posted = await postGenerationRecord(url(registrar), {
        name, identity: registered.identity, role: 'master', generation, ownerKey, auth: zelidauth,
      });
      expect(posted.status, `the generation-${generation} record: ${posted.body}`).to.equal(200);
      await Promise.all(holders.map((i) => env.clients[i].waitForEvent(
        'quorumGrant:generationRecord',
        (d) => d.identity === registered.identity && d.role === 'master' && d.generation === generation,
        120000,
        { afterId: markers[i] },
      )));
      await ownerGet(registrar, `/apps/apprestart/${name}/true`, ownerKey);
      await advanceBlocks(DRAIN_BLOCKS);
      await waitFor(async () => (await verdict())?.generation === generation, {
        timeout: CONVERGE_MS, interval: 5000, label: `a generation-${generation} term forms`,
      });
      return posted.record;
    } finally {
      await startTicker();
    }
  }

  // The generation-`generation` record every node named holds for the role.
  async function heldEverywhere(record, indices, label) {
    const hash = generationRecordHash(record);
    await waitFor(async () => {
      const held = await Promise.all(indices.map(async (i) => {
        const res = await fetch(`${url(i)}/apps/grantgeneration/${registered.identity}/master`);
        const body = await res.json();
        return (body.data?.records ?? []).some((r) => generationRecordHash(r) === hash);
      }));
      return held.every(Boolean);
    }, { timeout: CONVERGE_MS, interval: 5000, label });
  }

  before(async function () {
    this.timeout(1800000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      deferredNodes: 1,
      tickerAutostart: false,
      zmqTopics: ALL_ZMQ_TOPICS,
      configOverrides: {
        fluxapps: grantPlaneOverrides({
          quorumGrantGenerationDrainBlocks: DRAIN_BLOCKS,
          adoptionStaggerStepMs: 5000,
          adoptionStaggerWindowMs: 10000,
        }),
      },
    });
    await bootAndPeer(env, { pricing: true });
    view = appView(env, name, { component: 'web', timeout: CONVERGE_MS });

    const running = Array.from({ length: FRESH }, (_, i) => i);
    const ordinary = running.filter((i) => !env.establishedNodes.includes(i));
    const [first, second] = ordinary;
    registrar = running.find((i) => i !== first && i !== second);
    expect(buyer.zelid, 'the fixture names two owners').to.not.equal(seller.zelid);

    await pushImage(name, 'v1');
    const ip = (i) => getSubnetConfig().nodeIp(i + 1);
    shape = {
      instances: 3,
      placement: { targetIps: [ip(first), ip(second), ip(FRESH)] },
      components: {
        web: {
          name: 'web',
          description: 're-rolled, then sold',
          image: `${REGISTRY_REPO_HOST}/${name}:v1`,
          cpu: 0.5,
          memory: 300,
          rootFsGb: 2,
          persistentStorage: {
            sizeGb: 1,
            mounts: { '/appdata': { source: 'appdata', destination: '/appdata' } },
            sync: { mode: 'activeStandby' },
          },
          ports: { http: { containerPort: 80, hostPort: 31220 } },
        },
      },
    };
    const reg = await registerEncryptedV9App(url(registrar), { name, ...shape });
    expect(reg.status, `the registration is accepted: ${JSON.stringify(reg).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(reg.data, env.clients.filter(Boolean));
    const uuid = appUuid(name, reg.data);
    registered = {
      spec: { name, owner: seller.zelid, hash: reg.data }, hash: reg.data, uuid, identity: appIdentityFromUuid(uuid),
    };
    key = `${registered.identity}/master`;
    identifier = componentIdentifier(registered, 'web');

    await Promise.all([first, second].map((i) => waitForInstallSettled(env.clients[i], name, CONVERGE_MS)));
    await Promise.all([first, second].map((i) => seedData(i)));
    await setSynced({ folder: await appSyncthingFolderId(env.clients[first], name, null) });
    await waitFor(async () => (await verdict()) !== null, {
      timeout: CONVERGE_MS, interval: 10000, label: 'a term forms',
    });

    sellersRecord = await reroll(1, seller, [first, second]);
    await heldEverywhere(sellersRecord, live(), 'every node holds the seller\'s generation-1 record');
    const term = await verdict();
    primary = indexOfGrantee(term.grantee);
    expect([first, second], 'the term is held by one of the two hosts').to.include(primary);
    standby = primary === first ? second : first;
  });

  after(async function () {
    this.timeout(120000);
    await env?.teardown();
  });

  it('runs the app on its primary at generation 1, with the standby stopped', async function () {
    this.timeout(CONVERGE_MS);
    await waitFor(async () => (await view.containerOn(primary)).running && !(await view.containerOn(standby)).running, {
      timeout: CONVERGE_MS, interval: 5000, label: 'the primary runs and the standby is stopped',
    });
    primaryContainer = await view.containerOn(primary);
    const term = await verdict();
    masterGrantee = term.grantee;
    expect(term.generation, 'the term stands at generation 1').to.equal(1);
  });

  it('keeps the primary\'s term and container through a sale that names the generation-1 record', async function () {
    this.timeout(1200000);
    await env.disconnectNode(standby);
    const wentAway = Date.now();
    const stayers = live().filter((i) => i !== standby);
    const result = await transferApp(url(registrar), seller, registered, stayers.map((i) => env.clients[i]), {
      v9: shape,
      standsOn: { grants: { master: generationRecordHash(sellersRecord) } },
    });
    await env.reconnectNode(standby);
    expect(Date.now() - wentAway, 'the standby was away for less than the node-down grace').to.be.below(OUTAGE_LIMIT_MS);
    expect(result.status, `the sale is accepted: ${JSON.stringify(result).slice(0, 300)}`).to.equal('success');
    sold = result.app;

    await view.listedEverywhere(sold.spec.hash, stayers, 'every node that stayed lists the sale');
    await view.installedEverywhere(sold.spec.hash, [primary], 'the primary adopts the sale');
    const term = await verdict();
    expect(term?.grantee, 'the primary still holds the term').to.equal(masterGrantee);
    expect(term?.generation, 'at generation 1').to.equal(1);
    expect((await view.containerOn(primary)).id, 'the primary\'s container was not recreated').to.equal(primaryContainer.id);
    expect(await view.runningCount(), 'exactly one master runs').to.equal(1);
  });

  it('brings the standby back holding the sale, still a standby', async function () {
    this.timeout(CONVERGE_MS * 2);
    await waitForDaemonReady(env.clients[standby]);
    await view.installedEverywhere(sold.spec.hash, [standby], 'the standby adopts the sale');
    expect((await view.installedOn(standby)).owner, 'the standby\'s record names the buyer').to.equal(buyer.zelid);
    expect((await view.containerOn(standby)).running, 'the standby is stopped').to.equal(false);
  });

  it('installs the app as a standby on a node that boots afterwards, which holds the named record and takes the term when the others stand down', async function () {
    this.timeout(CONVERGE_MS * 3);
    const fresh = await env.startNode(FRESH);
    await waitForDaemonReady(fresh);
    await env.startDiscovery([FRESH]);
    await view.installedEverywhere(sold.spec.hash, [FRESH], 'the fresh node installs the app as sold');
    await seedData(FRESH);
    expect((await view.containerOn(FRESH)).running, 'the fresh node holds it as a standby').to.equal(false);
    await heldEverywhere(sellersRecord, [FRESH], 'the fresh node holds the record the sale names');

    await ownerGet(standby, `/apps/appyield/${name}`, buyer);
    await ownerGet(primary, `/apps/appyield/${name}`, buyer);
    await waitFor(async () => (await verdict())?.grantee === nodeOutpoint(FRESH), {
      timeout: CONVERGE_MS, interval: 5000, label: 'the fresh node takes the term',
    });
    expect((await verdict()).generation, 'at generation 1').to.equal(1);
    await waitFor(async () => (await view.containerOn(FRESH)).running, {
      timeout: CONVERGE_MS, interval: 5000, label: 'the fresh node runs the app',
    });
    await ownerGet(standby, `/apps/apprestart/${name}`, buyer);
    await ownerGet(primary, `/apps/apprestart/${name}`, buyer);
    await waitFor(async () => (await view.runningCount()) === 1, {
      timeout: CONVERGE_MS, interval: 5000, label: 'exactly one master runs once the others return as standbys',
    });
  });

  it('follows the buyer\'s re-roll to generation 2', async function () {
    this.timeout(1200000);
    buyersRecord = await reroll(2, buyer, [primary, standby, FRESH]);
    await heldEverywhere(buyersRecord, live(), 'every node holds the buyer\'s generation-2 record');
    expect((await verdict()).generation, 'the term stands at generation 2').to.equal(2);
    await waitFor(async () => (await view.runningCount()) === 1, {
      timeout: CONVERGE_MS, interval: 5000, label: 'exactly one master runs',
    });
  });

  it('leaves every row as it stood before a resale that a rewind undoes', async function () {
    this.timeout(1200000);
    const nodes = live();
    const before = (await view.listedOn(registrar)).hash;
    await stopTicker();
    const forkHeight = (await getState()).currentHeight;
    const resale = await updateEncryptedV9App(url(registrar), {
      name, ...shape, owner: seller.zelid, ownerKey: buyer,
      specOverrides: { grants: { master: generationRecordHash(buyersRecord) } },
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
    await view.listedEverywhere(before, nodes, 'every node lists the sale again');
    for (const i of nodes) {
      // eslint-disable-next-line no-await-in-loop
      expect((await view.listedOn(i)).owner, `node ${i}'s row names the buyer`).to.equal(buyer.zelid);
    }
    await startTicker();
  });
});
