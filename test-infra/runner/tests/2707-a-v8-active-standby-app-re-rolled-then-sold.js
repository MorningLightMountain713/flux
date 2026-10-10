// fleet: 12
/*
 * A v8 activeStandby app whose owner re-rolled it, then sold it.
 *
 * A v8 spec has no `grants` block, so a sale of a re-rolled v8 app names no
 * record: at the sale every node sets the seller's record aside and the app
 * stands on its registration again, generation 0, on the registration's
 * committee, which drains from the height the sale applied. The app is an
 * encrypted v8 app pinned to its primary, its standby and a node that boots after
 * the sale; a pin is an enterprise owner's, so those three are enterprise nodes
 * and both owners are on the enterprise list. Then:
 *   - the primary steps back to generation 0 and keeps the term and its
 *     container through the sale's drain;
 *   - the standby, away through the sale, returns holding it, still a standby;
 *   - the node that boots afterwards installs the app as a standby on
 *     generation 0, as every node stands;
 *   - the buyer re-rolls and every node stands on the buyer's record;
 *   - a resale undone by a rewind leaves every row as it stood and the buyer's
 *     record standing again.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { loadSharedConfig } from '../framework/coupled-knobs.js';
import { appOwnerKey, nodeKey } from '../framework/keys.js';
import { buyerKey, transferApp } from '../framework/transfer-helper.js';
import {
  bootAndPeer, installOnNodes, seedGlobalSpec, seedSyncScopedData,
} from '../framework/reconciler-suite.js';
import { buildSeedableEnterpriseApp, nodeOutpoint, syncedContainerData } from '../framework/seed-helper.js';
import { registerApp } from '../framework/app-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { appSyncthingFolderId, componentIdentifier } from '../framework/container.js';
import { setSynced } from '../framework/syncthing-control.js';
import { grantPlaneOverrides, grantVerdict } from '../framework/grant-record.js';
import { rerollRole } from '../framework/generation-record.js';
import { appView } from '../framework/app-view.js';
import {
  advanceBlocks, getState, queueAppTx, reorgChain, startTicker, stopTicker,
} from '../framework/daemon-control.js';
import {
  waitFor, waitForDaemonReady, waitForReconcileActuated, waitForReorg,
} from '../framework/wait.js';
import { generationRecordHash } from '@runonflux/flux-spec';

const NODES = 11;
const FRESH = 10; // boots after the sale
const QUORUM = 5;
// The blocks a re-roll's and a sale's committee drains before it serves:
// production's value.
const DRAIN_BLOCKS = 20;
const CONVERGE_MS = 300000;
const OUTAGE_LIMIT_MS = (loadSharedConfig().fluxapps.nodeDownGraceS - 20) * 1000;

describe('a v8 activeStandby app re-rolled, then sold', function () {
  let env;
  let view;
  let primary;
  let standby;
  let first;
  let second;
  let registrar;
  let key;
  let identifier;
  let registered;
  let sold;
  let sellersRecord;
  let buyersRecord;
  let masterGrantee;
  let primaryContainer;
  const seller = appOwnerKey();
  const buyer = buyerKey();
  const name = `v8rerollsale${Date.now()}`;

  const url = (i) => env.clients[i].url;
  const indexOfGrantee = (grantee) => env.clients.findIndex((c, i) => c && nodeOutpoint(i) === grantee);
  const verdict = () => grantVerdict(env.clients, key, { quorum: QUORUM });
  const live = () => env.clients.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);

  const reroll = (generation, ownerKey, holders) => rerollRole(env, {
    name,
    identity: registered.identity,
    identifier,
    generation,
    ownerKey,
    via: registrar,
    holders,
    drainBlocks: DRAIN_BLOCKS,
    quorum: QUORUM,
  });

  // The record every node named stands on for the role, by hash; null where
  // a node stands on the registration.
  async function standingOn(indices) {
    return Promise.all(indices.map(async (i) => {
      const res = await fetch(`${url(i)}/apps/grantgeneration/${registered.identity}/master`);
      const body = await res.json();
      return body.data?.record ? generationRecordHash(body.data.record) : null;
    }));
  }

  async function standingEverywhere(hash, indices, label) {
    await waitFor(async () => (await standingOn(indices)).every((h) => h === hash), {
      timeout: CONVERGE_MS, interval: 5000, label,
    });
  }

  // The app's spec as the next submission restates it: the registration's,
  // with the owner the submission names.
  function specFor(owner) {
    const spec = { ...registered.spec, owner };
    delete spec.hash;
    delete spec.uuid;
    delete spec.identity;
    return spec;
  }

  before(async function () {
    this.timeout(1800000);
    const running = Array.from({ length: FRESH }, (_, i) => i);
    // The hosts are chosen before the fleet exists, from what env.establishedNodes
    // will be: the last node the fleet boots with.
    [first, second] = running;
    registrar = running[2];
    const enterprisenodes = Object.fromEntries(
      [first, second, FRESH].map((i) => [nodeKey(i + 1).pubkey, [seller.zelid, buyerKey().zelid]]),
    );
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      deferredNodes: 1,
      tickerAutostart: false,
      zmqTopics: ALL_ZMQ_TOPICS,
      policy: { documents: { enterprisenodes } },
      configOverrides: {
        fluxapps: grantPlaneOverrides({
          quorumGrantGenerationDrainBlocks: DRAIN_BLOCKS, adoptionStaggerStepMs: 5000, adoptionStaggerWindowMs: 10000,
        }),
      },
    });
    expect(env.establishedNodes, 'the hosts are outside the established set').to.not.include.members([first, second]);
    await bootAndPeer(env);
    view = appView(env, name, { timeout: CONVERGE_MS });
    expect(buyer.zelid, 'the fixture names two owners').to.not.equal(seller.zelid);

    await pushImage(name, 'v1');
    registered = await buildSeedableEnterpriseApp({
      name,
      pinnedTo: [first, second, FRESH],
      instances: 3,
      compose: [{
        name,
        description: 'v8 activeStandby, re-rolled, then sold',
        repotag: `${REGISTRY_REPO_HOST}/${name}:v1`,
        ports: [],
        domains: [''],
        environmentParameters: [],
        commands: [],
        containerPorts: [80],
        containerData: syncedContainerData('activeStandby'),
        cpu: 0.1,
        ram: 100,
        hdd: 1,
        repoauth: '',
      }],
    });
    key = `${registered.identity}/master`;
    identifier = componentIdentifier(registered);

    const markers = env.clients.map((c) => c?.getLastEventId());
    await seedGlobalSpec(env, registered, live().filter((i) => i !== first && i !== second));
    await installOnNodes(env, registered, [first, second]);
    await Promise.all([first, second].map(async (i) => {
      await waitForReconcileActuated(env.clients[i], identifier, 'dataCleared', 120000, { afterId: markers[i] });
      await seedSyncScopedData(env, name, i);
    }));
    await setSynced({ folder: await appSyncthingFolderId(env.clients[first], name, name) });
    await waitFor(async () => (await verdict()) !== null, {
      timeout: CONVERGE_MS, interval: 10000, label: 'a term forms',
    });

    sellersRecord = await reroll(1, seller, [first, second]);
    await standingEverywhere(generationRecordHash(sellersRecord), live(), 'every node stands on the seller\'s record');
    primary = indexOfGrantee((await verdict()).grantee);
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

  it('steps the primary back to generation 0 through a sale that names no record, keeping its term and container', async function () {
    this.timeout(1200000);
    await env.disconnectNode(standby);
    const wentAway = Date.now();
    const stayers = live().filter((i) => i !== standby);
    const result = await transferApp(url(registrar), seller, registered, stayers.map((i) => env.clients[i]));
    await env.reconnectNode(standby);
    expect(Date.now() - wentAway, 'the standby was away for less than the node-down grace').to.be.below(OUTAGE_LIMIT_MS);
    expect(result.status, `the sale is accepted: ${JSON.stringify(result).slice(0, 300)}`).to.equal('success');
    sold = result.app;

    await view.listedEverywhere(sold.spec.hash, stayers, 'every node that stayed lists the sale');
    await standingEverywhere(null, stayers, 'every node that stayed stands on the registration');
    await waitFor(async () => (await getState()).currentHeight >= result.targetHeight + DRAIN_BLOCKS, {
      timeout: CONVERGE_MS, interval: 5000, label: 'the chain passes the sale\'s drain',
    });
    await waitFor(async () => {
      const term = await verdict();
      return term?.grantee === masterGrantee && term.generation === 0;
    }, { timeout: CONVERGE_MS, interval: 5000, label: 'the primary holds a live generation-0 term past the drain' });
    const now = await view.containerOn(primary);
    expect(now.id, 'the primary\'s container was not recreated').to.equal(primaryContainer.id);
    expect(now.startedAt, 'the primary\'s container was not restarted').to.equal(primaryContainer.startedAt);
    expect(await view.runningCount(), 'exactly one master runs').to.equal(1);
  });

  it('brings the standby back holding the sale, still a standby', async function () {
    this.timeout(CONVERGE_MS * 2);
    await waitForDaemonReady(env.clients[standby]);
    await view.installedEverywhere(sold.spec.hash, [standby], 'the standby adopts the sale');
    await standingEverywhere(null, [standby], 'the standby stands on the registration');
    expect((await view.containerOn(standby)).running, 'the standby is stopped').to.equal(false);
  });

  it('installs the app as a standby on generation 0 on a node that boots afterwards', async function () {
    this.timeout(CONVERGE_MS * 2);
    const fresh = await env.startNode(FRESH);
    await waitForDaemonReady(fresh);
    await env.startDiscovery([FRESH]);
    await view.installedEverywhere(sold.spec.hash, [FRESH], 'the fresh node installs the app as sold');
    await waitForReconcileActuated(fresh, identifier, 'dataCleared', 120000);
    await seedSyncScopedData(env, name, FRESH);
    await standingEverywhere(null, [FRESH], 'the fresh node stands on the registration');
    expect((await view.containerOn(FRESH)).running, 'the fresh node holds it as a standby').to.equal(false);
    expect(await view.runningCount(), 'exactly one master runs').to.equal(1);
  });

  it('follows the buyer\'s re-roll: every node stands on the buyer\'s record', async function () {
    this.timeout(1200000);
    buyersRecord = await reroll(1, buyer, [primary, standby, FRESH]);
    await standingEverywhere(generationRecordHash(buyersRecord), live(), 'every node stands on the buyer\'s record');
    await waitFor(async () => (await view.runningCount()) === 1, {
      timeout: CONVERGE_MS, interval: 5000, label: 'exactly one master runs',
    });
  });

  it('leaves every row as it stood, and the buyer\'s record standing, before a resale that a rewind undoes', async function () {
    this.timeout(1200000);
    const nodes = live();
    const before = (await view.listedOn(registrar)).hash;
    await stopTicker();
    const forkHeight = (await getState()).currentHeight;
    const resale = await registerApp(url(registrar), buyer, specFor(seller.zelid), 'fluxappupdate', { signerKey: buyer });
    expect(resale.status, `the resale is accepted: ${JSON.stringify(resale).slice(0, 300)}`).to.equal('success');
    await waitFor(async () => {
      const held = await Promise.all(nodes.map(async (i) => (await env.clients[i].getTempMessages(resale.data)).data?.length > 0));
      return held.every(Boolean);
    }, { timeout: 60000, interval: 2000, label: 'every node holds the resale' });
    await queueAppTx(resale.data);
    await advanceBlocks(2);
    await view.listedEverywhere(resale.data, nodes, 'every node lists the resale');
    await standingEverywhere(null, nodes, 'the resale sets the buyer\'s record aside');

    const mark = env.clients[registrar].getLastEventId();
    await reorgChain({ forkHeight });
    await waitForReorg(env.clients[registrar], (d) => d.forkHeight === forkHeight, 60000, { afterId: mark });
    await advanceBlocks(1);
    await view.listedEverywhere(before, nodes, 'every node lists the sale again');
    await standingEverywhere(generationRecordHash(buyersRecord), nodes, 'the buyer\'s record stands again');
    await startTicker();
  });
});
