// fleet: 6
/*
 * Every node decides the same app list from the chain, whatever order and route
 * its app messages reached it by, and what it refuses stays refused.
 *
 * An app's registration and its update are handed to one node, paid in two
 * blocks, while two nodes are cut off from their peers but still follow the
 * chain. The rest of the fleet takes both from the node they were handed to.
 * One cut-off node is then handed the update before the registration: it
 * refuses the update while it holds nothing to update, and applies both once
 * the registration arrives. The other fetches both from its peers once it is
 * back. Every node then lists the update, under the identity the registration
 * made.
 *
 * Then, on every node: a registration paying the price floor is refused and listed
 * nowhere; an update signed by a key that is not the owner's is refused and the
 * owner's row stands; a v9 app is listed under the identity its registration
 * made. All of it holds on a node killed and restarted, and on a node that boots
 * afterwards and takes the whole list from its peers.
 *
 * The v8 apps are installed nowhere: every spawner is held for them, so the
 * suite's subject is the list and not where the apps run.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createRequire } from 'node:module';
import { createTestEnv } from '../framework/test-env.js';
import { loadSharedConfig } from '../framework/coupled-knobs.js';
import { buyerKey } from '../framework/transfer-helper.js';
import { bootAndPeer, holdSpawnerExcept } from '../framework/reconciler-suite.js';
import { buildSeedableApp, buildSeedableUpdate } from '../framework/seed-helper.js';
import { deliverAppMessage } from '../framework/app-delivery.js';
import { confirmOnChain } from '../framework/app-helper.js';
import { registerCleartextV9App } from '../framework/content-helper.js';
import { pushTestApp } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';
import { advanceBlock, queueAppTx } from '../framework/daemon-control.js';
import { partition, healPartition } from '../framework/partition.js';
import { waitForCapabilityState } from '../framework/capability-state.js';
import { waitFor, waitForDaemonReady } from '../framework/wait.js';

const require = createRequire(import.meta.url);
const production = require('../../../ZelBack/config/default.js');

const NODES = 6;
const RUNNING = [0, 1, 2, 3, 4];
const REGISTRAR = 0; // handed every message the chain pays for
const RESTARTED = 1; // killed and restarted
const POCKET = 3; // cut off, then handed the update before its registration
const FETCHER = 4; // cut off, then fetches both messages from its peers
const FRESH = 5; // boots once everything else is decided
const ALL = [...RUNNING, FRESH];
const CONVERGE_MS = 240000;
// A node with no peers for the node-down grace is certified down, which is
// another suite's subject: the cut ends well inside it.
const CUT_LIMIT_MS = (loadSharedConfig().fluxapps.nodeDownGraceS - 20) * 1000;
// The least a payment carries for the scan to record it as one: an underpaid
// registration pays this, which is below any registration's fee.
const FLOOR_SAT = Math.round(production.fluxapps.price.at(-1).minPrice * 1e8);

function v9Components(name) {
  return {
    web: {
      name: 'web',
      description: 'listed under its identity',
      image: `${REGISTRY_REPO_HOST}/${name}:v1`,
      cpu: 0.5,
      memory: 300,
      rootFsGb: 2,
      persistentStorage: { sizeGb: 1, mounts: { '/data': { source: 'data', destination: '/data' } } },
      ports: { http: { containerPort: 80, hostPort: 36111 } },
    },
  };
}

describe('every node decides the same app list', function () {
  let env;
  const base = `samelist${Date.now()}`;
  const ordered = {}; // a registration and its update, reaching nodes in different orders
  const underpaid = {}; // a registration paying the price floor, below its fee
  const forged = {}; // a registration, and an update signed by a key that is not the owner's
  const v9 = { name: `${base}v` };
  let cutAt = null;

  // The node's decision on a paid message, or null while it answers none.
  async function decisionOn(index, hash) {
    const { status, data } = await env.clients[index].request('GET', `/v2/apps/messages/${hash}/decision`);
    return status === 200 ? data.data : null;
  }

  // Each named node's decision on a paid message, once none is undecided.
  async function decided(hash, indices, label) {
    let decisions = [];
    await waitFor(async () => {
      decisions = await Promise.all(indices.map((i) => decisionOn(i, hash)));
      return decisions.every((d) => d && d.decision !== 'undecided');
    }, { timeout: CONVERGE_MS, interval: 3000, label });
    return decisions;
  }

  async function appliedOn(hash, indices, label) {
    const decisions = await decided(hash, indices, label);
    decisions.forEach((d, k) => expect(d, `node ${indices[k]}: ${label}`).to.include({ decision: 'applied' }));
  }

  async function refusedOn(hash, indices, reason, label) {
    const decisions = await decided(hash, indices, label);
    decisions.forEach((d, k) => expect(d, `node ${indices[k]}: ${label}`).to.include({ decision: 'refused', reason }));
  }

  // The node's registry row for a name, or null when it lists none.
  async function listedOn(index, name) {
    const res = await fetch(`${env.clients[index].url}/apps/globalappsspecifications?appname=${encodeURIComponent(name)}`);
    const body = await res.json();
    return body.status === 'success' && Array.isArray(body.data) ? body.data[0] ?? null : null;
  }

  // Hands a node a paid message, once its scan has the payment: the delivery
  // route, with no wait for the node's decision.
  async function hand(index, message) {
    let refusal = null;
    await waitFor(async () => {
      const { status, data } = await env.clients[index].request('POST', '/v2/apps/messages', { body: message });
      if (status === 422) {
        refusal = data?.error?.message ?? 'no reason given';
        return true;
      }
      return status === 201 || status === 200;
    }, { timeout: 120000, interval: 1000, label: `node ${index} takes ${message.hash} once its scan has the payment` });
    if (refusal !== null) throw new Error(`node ${index} refused ${message.hash}: ${refusal}`);
  }

  async function pay(message, valueSat) {
    await queueAppTx(message.hash, valueSat);
    await advanceBlock();
  }

  async function holdSpawners(name) {
    await holdSpawnerExcept(env, name, []);
  }

  // Every named node lists the app at this message, under one identity.
  async function sameRowOn(name, hash, identity, indices, label) {
    let rows = [];
    await waitFor(async () => {
      rows = await Promise.all(indices.map((i) => listedOn(i, name)));
      return rows.every((row) => row?.hash === hash);
    }, { timeout: CONVERGE_MS, interval: 3000, label });
    rows.forEach((row, k) => expect(row.identity, `node ${indices[k]}: ${label}: the identity`).to.equal(identity));
  }

  async function unlistedOn(name, indices, label) {
    const rows = await Promise.all(indices.map((i) => listedOn(i, name)));
    rows.forEach((row, k) => expect(row, `node ${indices[k]}: ${label}`).to.equal(null));
  }

  before(async function () {
    this.timeout(1200000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      deferredNodes: 1,
      arcane: true,
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });

    ordered.registered = await buildSeedableApp({ name: `${base}o`, instances: 3 });
    ordered.updated = await buildSeedableUpdate(ordered.registered, (spec) => {
      spec.description = `updated ${base}o`;
    });
    underpaid.registered = await buildSeedableApp({ name: `${base}u`, instances: 3 });
    forged.registered = await buildSeedableApp({ name: `${base}f`, instances: 3 });
    forged.updated = await buildSeedableUpdate(forged.registered, (spec) => {
      spec.description = `updated by a stranger ${base}f`;
    }, { signerKey: buyerKey() });
    for (const app of [ordered, underpaid, forged]) {
      // eslint-disable-next-line no-await-in-loop
      await holdSpawners(app.registered.spec.name);
    }
  });

  after(async function () {
    this.timeout(60000);
    if (cutAt !== null) await healPartition(env, [POCKET, FETCHER]).catch(() => {});
    await env?.teardown();
  });

  it('refuses an update handed over before its registration, then applies both once the registration arrives', async function () {
    this.timeout(1200000);
    await partition(env, [POCKET], { cutChain: false });
    await partition(env, [FETCHER], { cutChain: false });
    cutAt = Date.now();
    try {
      await deliverAppMessage(env, ordered.registered.message, [REGISTRAR]);
      await deliverAppMessage(env, ordered.updated.message, [REGISTRAR]);
      const connected = RUNNING.filter((i) => i !== POCKET && i !== FETCHER);
      await appliedOn(ordered.updated.hash, connected, 'every connected node takes the update from the node it was handed to');

      await hand(POCKET, ordered.updated.message);
      await refusedOn(ordered.updated.hash, [POCKET], 'nothing-to-update', 'the cut-off node judges the update with nothing to update');
      await hand(POCKET, ordered.registered.message);
      await appliedOn(ordered.registered.hash, [POCKET], 'the cut-off node applies the registration');
      await appliedOn(ordered.updated.hash, [POCKET], 'the cut-off node applies the update after it');
      expect(Date.now() - cutAt, 'the nodes were cut off for less than the node-down grace').to.be.below(CUT_LIMIT_MS);
    } finally {
      // The fleet is whole for every test after this one, whatever this one found.
      await healPartition(env, [FETCHER]);
      await healPartition(env, [POCKET]);
      cutAt = null;
    }
  });

  it('lists the update on every node, under the identity the registration made, whatever order and route it arrived by', async function () {
    this.timeout(CONVERGE_MS * 2);
    await appliedOn(ordered.registered.hash, RUNNING, 'every node applies the registration');
    await appliedOn(ordered.updated.hash, RUNNING, 'every node applies the update');
    const { identity } = await listedOn(REGISTRAR, ordered.registered.spec.name);
    expect(identity, 'the node handed the registration lists the app under an identity').to.be.a('string').and.not.equal('');
    ordered.identity = identity;
    await sameRowOn(ordered.registered.spec.name, ordered.updated.hash, identity, RUNNING, 'every node lists the update');
  });

  it('refuses an underpaid registration on every node and lists it on none', async function () {
    this.timeout(CONVERGE_MS * 2);
    await pay(underpaid.registered.message, FLOOR_SAT);
    await hand(REGISTRAR, underpaid.registered.message);
    await refusedOn(underpaid.registered.hash, RUNNING, 'underpaid', 'every node refuses the registration');
    await unlistedOn(underpaid.registered.spec.name, RUNNING, 'the underpaid app is not listed');
  });

  it('refuses an update signed by a key that is not the owner\'s on every node, and the owner\'s row stands', async function () {
    this.timeout(CONVERGE_MS * 2);
    await deliverAppMessage(env, forged.registered.message, [REGISTRAR]);
    await appliedOn(forged.registered.hash, RUNNING, 'every node applies the owner\'s registration');
    forged.identity = (await listedOn(REGISTRAR, forged.registered.spec.name)).identity;
    await pay(forged.updated.message);
    await hand(REGISTRAR, forged.updated.message);
    await refusedOn(forged.updated.hash, RUNNING, 'unauthorized', 'every node refuses the stranger\'s update');
    await sameRowOn(forged.registered.spec.name, forged.registered.hash, forged.identity, RUNNING, 'every node lists the owner\'s registration');
  });

  it('lists a v9 app on every node under the identity its registration made', async function () {
    this.timeout(CONVERGE_MS * 2);
    await pushTestApp(v9.name);
    const res = await registerCleartextV9App(env.clients[REGISTRAR].url, {
      name: v9.name,
      components: v9Components(v9.name),
      placement: { targetIps: [0, 1, 2].map((i) => getSubnetConfig().nodeIp(i + 1)) },
      instances: 3,
    });
    expect(res.status, `the registration is accepted: ${JSON.stringify(res).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(res.data, RUNNING.map((i) => env.clients[i]));
    v9.hash = res.data;
    await appliedOn(v9.hash, RUNNING, 'every node applies the v9 registration');
    v9.identity = (await listedOn(REGISTRAR, v9.name)).identity;
    expect(v9.identity, 'the node the registration was submitted to lists it under an identity').to.be.a('string').and.not.equal('');
    await sameRowOn(v9.name, v9.hash, v9.identity, RUNNING, 'every node lists the v9 app');
  });

  // What every node holds once everything above is decided: the same rows, the
  // same refusals.
  async function holdsTheList(indices, label) {
    await sameRowOn(ordered.registered.spec.name, ordered.updated.hash, ordered.identity, indices, `${label}: the reordered app`);
    await sameRowOn(forged.registered.spec.name, forged.registered.hash, forged.identity, indices, `${label}: the owner's app`);
    await sameRowOn(v9.name, v9.hash, v9.identity, indices, `${label}: the v9 app`);
    await refusedOn(underpaid.registered.hash, indices, 'underpaid', `${label}: the underpaid registration`);
    await unlistedOn(underpaid.registered.spec.name, indices, `${label}: the underpaid app`);
    await refusedOn(forged.updated.hash, indices, 'unauthorized', `${label}: the stranger's update`);
  }

  it('holds the same list, refusals and identities on a node killed and restarted', async function () {
    this.timeout(CONVERGE_MS * 2);
    await env.restartNode(RESTARTED, { timeout: 0 });
    for (const app of [ordered, underpaid, forged]) {
      // eslint-disable-next-line no-await-in-loop
      await holdSpawners(app.registered.spec.name);
    }
    await waitForCapabilityState(env.clients[RESTARTED], 'appRegistryConsistent', 'up', { timeout: CONVERGE_MS });
    await holdsTheList([RESTARTED], 'the restarted node');
  });

  it('holds the same list, refusals and identities on a node that boots afterwards and takes the list from its peers', async function () {
    this.timeout(CONVERGE_MS * 3);
    const fresh = await env.startNode(FRESH);
    for (const app of [ordered, underpaid, forged]) {
      // eslint-disable-next-line no-await-in-loop
      await holdSpawners(app.registered.spec.name);
    }
    await waitForDaemonReady(fresh);
    await env.startDiscovery([FRESH]);
    await waitForCapabilityState(fresh, 'appRegistryConsistent', 'up', { timeout: CONVERGE_MS });
    await holdsTheList([FRESH], 'the fresh node');
    await holdsTheList(ALL.filter((i) => i !== FRESH), 'every other node');
  });
});
