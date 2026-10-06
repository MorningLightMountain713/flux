// fleet: 5
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer, installedInstanceIndices } from '../framework/reconciler-suite.js';
import { deployContentApp, updateContentApp, assertContentApplied } from '../framework/content-helper.js';
import { handAppMessage } from '../framework/app-delivery.js';
import { blobHash } from '../framework/content-crypto-v9.js';
import { askFluxDrivePending, getFluxDriveManifest, resetFluxDrive } from '../framework/fluxdrive-control.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
import { waitFor } from '../framework/wait.js';
import { readFileInContainer } from '../framework/container.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { dbClient, closeDb } from '../framework/db-client.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

// A spec update that adds a content slot carries the file list covering every slot
// the new spec declares. The list rides in the update's own message, outside the
// text its hash and signature cover: every node holds it with the message while the
// update waits for payment, and stores it as the app's manifest when the update
// applies, so a component recreated for the new spec starts with the slot filled.
//
// Because the list is outside the hash, a node can be handed the genuine update
// without it. Such a node is not left without the file list: a manifest that does
// not cover every slot its spec declares counts as none, and the node asks the
// nodes running the app and then FluxDrive, which holds the owner's own copy from
// the submission. The second test hands a node cut off from the update exactly
// that: the message as the fleet holds it, the list taken off.
//
// The steady-state manifest refresh is left at its production cadence, far beyond
// the blocks this suite mines, so it is never what brings a node to the list.
//
// Asserts on what each node holds (its manifest rows, its decision route) and on
// the bytes in the running container, never on log lines.

async function waitForSpecEverywhere(env, name, timeout = 150000) {
  await waitFor(async () => {
    const rows = await Promise.all(env.clients.map((c) => c.getAppSpecs(name).catch(() => null)));
    return rows.every((r) => r && r.status === 'success' && r.data && r.data.name === name);
  }, { timeout, interval: 3000, label: `global spec for ${name} on all nodes` });
}

describe('a spec update that adds a slot carries the file list for it', function () {
  let env;
  let dbClients;

  const name = `e2ecarried${Date.now()}`;
  const image = `${REGISTRY_REPO_HOST}/${name}:v1`;

  const CONF = { name: 'conf', destination: '/etc/app.conf', onUpdate: { action: 'restart' } };
  const EXTRA = { name: 'extra', destination: '/etc/extra.conf', onUpdate: { action: 'restart' } };
  const MORE = { name: 'more', destination: '/etc/more.conf', onUpdate: { action: 'restart' } };
  const CONF_BYTES = Buffer.from('carried conf v1');
  const EXTRA_BYTES = Buffer.from('carried extra v2');
  const MORE_BYTES = Buffer.from('carried more v3');

  // One node is cut off from the nodes that take the second update, and keeps its
  // daemon. The rest stay four, which the update route's peer floor needs of the
  // node that takes the submission.
  const MAJORITY = [0, 1, 2, 3];
  const MINORITY = [4];
  const HANDED = 4;

  dumpLogsOnFailure(() => env);

  // The update's message as a node holds it while it waits for payment.
  async function heldInPool(client, hash) {
    let held = null;
    await waitFor(async () => {
      const res = await client.getTempMessages(hash);
      held = res.status === 'success' && Array.isArray(res.data) ? res.data[0] : null;
      return Boolean(held);
    }, { timeout: 60000, interval: 1000, label: `node ${client.num} holds the update ${hash.slice(0, 12)} in its pool` });
    return held;
  }

  // Which list a node holds is its ownership height and its version together:
  // versions count within an ownership, and a registration's list is signed
  // before its height exists, so the number alone names no list.
  const isList = (row, list) => Boolean(row) && row.ownedFrom === list.ownedFrom && row.version === list.version;

  async function standOn(indices, list) {
    const rows = await Promise.all(indices.map((i) => dbClients[i].getContentManifest(name).catch(() => null)));
    return rows.every((row) => isList(row, list));
  }

  async function haveDelivered(indices, list) {
    const rows = await Promise.all(indices.map((i) => dbClients[i].getAppliedContentManifest(name).catch(() => null)));
    return rows.every((row) => isList(row, list));
  }

  async function slotBytes(index, slot) {
    const { content, exitCode } = await readFileInContainer(env.clients[index].container, name, 'web', slot.destination);
    return exitCode === 0 ? content : null;
  }

  async function waitForSlotOn(indices, slot, bytes) {
    await waitFor(async () => {
      const read = await Promise.all(indices.map((i) => slotBytes(i, slot)));
      return read.every((content) => content === bytes.toString());
    }, { timeout: 240000, interval: 3000, label: `${slot.destination} holds its bytes in the container on nodes ${indices.join(', ')}` });
  }

  before(async function () {
    this.timeout(720000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 5,
      tickerAutostart: false,
      arcane: true,
      // partitionGroups returns once the cross-group sockets are gone; declaring the
      // partition is what compresses that wait.
      timing: { partitions: true },
      configOverrides: {
        confirmation: { daemonStaleMs: 300000 },
        fluxapps: {
          appSyncPeerThreshold: 3,
          // The cut-off node keeps its daemon and is not to degrade on its peer
          // count: a degraded node is a different subject.
          appSyncDegradedThreshold: 0,
          minOutgoing: 2,
          minIncoming: 1,
        },
      },
    });
    await bootAndPeer(env, { pricing: true, minOutbound: 2 });
    await resetFluxDrive();
    dbClients = env.clients.map((_, i) => dbClient(i + 1));
    await pushBusybox(name, 'v1');

    // A slot app on every node, so every node runs it and has a container to fill.
    const dep = await deployContentApp(env.clients[0].url, {
      name, image, instances: env.nodeCount, contentSlots: [{ ...CONF, bytes: CONF_BYTES }],
    });
    expect(dep.status, 'registration').to.equal('success');
    await queueAppTx(dep.data);
    await advanceBlocks(3);
    await waitFor(
      async () => (await installedInstanceIndices(env, name)).length >= env.nodeCount,
      { timeout: 280000, interval: 3000, label: `all ${env.nodeCount} instances of ${name}` },
    );
    await waitForSpecEverywhere(env, name);
    await waitFor(
      async () => (await assertContentApplied(dbClients, name, 1)).applied,
      { timeout: 120000, interval: 2000, label: 'every node delivered the registration\'s file list' },
    );
  });

  after(async function () {
    this.timeout(60000);
    await env?.healPartition(MINORITY, MAJORITY).catch(() => {});
    await closeDb();
    await env?.teardown();
  });

  it('holds the list with the update on every node, and fills the new slot when the update applies', async function () {
    this.timeout(420000);
    const everyNode = env.clients.map((_, i) => i);

    const update = await updateContentApp(env.clients[0].url, {
      name,
      image,
      instances: env.nodeCount,
      contentSlots: [{ ...CONF, hash: blobHash(CONF_BYTES) }, { ...EXTRA, bytes: EXTRA_BYTES }],
    });
    expect(update.status, `update: ${JSON.stringify(update.data)}`).to.equal('success');
    const hash = update.data;
    const list = update.manifest;
    expect(list.ownedFrom, 'the list is signed under the listed ownership').to.be.greaterThan(0);

    // A node that only heard of the update holds the list with it.
    const held = await heldInPool(env.clients[1], hash);
    expect(held.contentManifest, 'the update\'s message carries its file list').to.be.an('object');
    expect(isList(held.contentManifest, list), 'the list held with the update is the one submitted').to.equal(true);

    // Not the app's manifest yet: the update has not applied.
    expect(await standOn([1], list), 'the list takes effect when the update applies, not before').to.equal(false);

    await queueAppTx(hash);
    await advanceBlocks(3);

    await waitFor(
      () => standOn(everyNode, list),
      { timeout: 180000, interval: 2000, label: 'every node stands on the list the update carried' },
    );
    await waitForSlotOn(everyNode, EXTRA, EXTRA_BYTES);
    await waitForSlotOn(everyNode, CONF, CONF_BYTES);
    await waitFor(
      () => haveDelivered(everyNode, list),
      { timeout: 120000, interval: 2000, label: 'every node delivered the list the update carried' },
    );
  });

  it('brings a node handed the update without its list to the list all the same', async function () {
    this.timeout(600000);
    const handed = env.clients[HANDED];

    await env.partitionGroups(MINORITY, MAJORITY);

    const update = await updateContentApp(env.clients[0].url, {
      name,
      image,
      instances: env.nodeCount,
      contentSlots: [
        { ...CONF, hash: blobHash(CONF_BYTES) },
        { ...EXTRA, hash: blobHash(EXTRA_BYTES) },
        { ...MORE, bytes: MORE_BYTES },
      ],
    });
    expect(update.status, `update: ${JSON.stringify(update.data)}`).to.equal('success');
    const hash = update.data;
    const list = update.manifest;

    const held = await heldInPool(env.clients[1], hash);
    expect(isList(held.contentManifest, list), 'the fleet holds the list with the update').to.equal(true);

    await queueAppTx(hash);
    await advanceBlocks(3);

    // The majority applies the update with its list, and FluxDrive, told so by the
    // nodes, serves the owner's copy.
    await waitFor(
      () => standOn(MAJORITY, list),
      { timeout: 180000, interval: 2000, label: 'the majority stands on the list the update carried' },
    );
    await askFluxDrivePending();
    await waitFor(async () => {
      const served = await getFluxDriveManifest(name);
      return isList({ ownedFrom: Number(served.manifest?.ownedFrom ?? 0), version: Number(served.version) }, list);
    }, { timeout: 60000, interval: 2000, label: 'FluxDrive serves the owner\'s copy of the list' });

    // The cut-off node has seen the payment and has no message for it: no node
    // that holds one can be reached.
    await waitFor(async () => {
      const { status, data } = await handed.request('GET', `/v2/apps/messages/${hash}/decision`);
      return status === 200 && data.data.decision === 'undecided';
    }, { timeout: 120000, interval: 2000, label: `node ${HANDED} has recorded the payment and holds no message for it` });
    expect(await standOn([HANDED], list), `node ${HANDED} does not stand on this update's list`).to.equal(false);

    // The genuine update, as the fleet holds it, with the list taken off.
    await handAppMessage(env, {
      type: held.type,
      version: held.version,
      appSpecifications: held.appSpecifications,
      hash: held.hash,
      contentHash: held.contentHash,
      timestamp: held.timestamp,
      extend: held.extend,
      signature: held.signature,
      arcaneAttestation: held.arcaneAttestation,
    }, [HANDED]);

    // Still cut off from every node that holds the list: FluxDrive is where it
    // comes from.
    await waitFor(
      () => standOn([HANDED], list),
      { timeout: 240000, interval: 3000, label: `node ${HANDED} stands on the list it was not handed` },
    );

    await env.healPartition(MINORITY, MAJORITY);
    await env.startDiscovery();

    const everyNode = env.clients.map((_, i) => i);
    await waitForSlotOn(everyNode, MORE, MORE_BYTES);
    await waitFor(
      () => haveDelivered(everyNode, list),
      { timeout: 180000, interval: 2000, label: 'every node delivered the list' },
    );
  });
});
