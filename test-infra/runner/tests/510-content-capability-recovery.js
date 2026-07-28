// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer, installedInstanceIndices } from '../framework/reconciler-suite.js';
import { deployContentApp, pushContentUpdate, assertManifestSynced } from '../framework/content-helper.js';
import { resetFluxDrive } from '../framework/fluxdrive-control.js';
import { pushImage } from '../framework/registry-helper.js';
import {
  queueAppTx, advanceBlocks, setNodeStatus, clearNodeStatus, clearAllNodeStatus,
} from '../framework/daemon-control.js';
import { waitFor, waitForOrchestratorState, waitForNodeStatus } from '../framework/wait.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { dbClient } from '../framework/db-client.js';

// A node that degrades AND loses daemon confirmation must still reconcile its content-manifest
// register on recovery. FluxOS gates peer discovery on confirmation (fluxDiscovery throws while
// unconfirmed), so recovery is always capability-FIRST: confirmation returns, the capability-
// gain sync round runs while the node is still peerless (discovery only just resumed), THEN
// peers reconnect. The trap is that peerless round — the old code marked the manifest reconcile
// "done" on a round that asked no one (a vacuous latch), so the later peers-ready resync
// skipped it and the node shipped READY with a permanently stale register. The evidence-based
// latch only marks it done once a peer actually answered, so the manifest reconciles for real
// when peers return.
//
// Two independent levers set it up: setNodeStatus EXPIRED makes the daemon reachable-but-
// unconfirmed (message capability drops, but the app is NOT removed — daemon-stale removal only
// fires on an UNREACHABLE daemon), and disconnectNode drops the peers so the node degrades
// (resetting the manifest latch). Widened confirmation windows keep the app alive through the
// partition; appSyncPeerThreshold 3 + degrade floor 1 so isolating one node degrades only it;
// minOutgoing/minIncoming lowered to the 5-node mesh's submission gate. SSE can't cross the
// partition, so the degrade gate reads the node's own docker log; behavioural asserts use the
// shared appcontentmanifests rows + the node's own bus once recovered.

async function waitForSpecEverywhere(env, name, timeout = 150000) {
  await waitFor(async () => {
    const rows = await Promise.all(env.clients.map((c) => c.getAppSpecs(name).catch(() => null)));
    return rows.every((r) => r && r.status === 'success' && r.data && r.data.name === name);
  }, { timeout, interval: 3000, label: `global spec for ${name} on all nodes` });
}

describe('content manifest recovery through a message-capability round-trip', function () {
  let env;
  let dbClients;

  before(async function () {
    this.timeout(540000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 5,
      tickerAutostart: false,
      arcane: true,
      configOverrides: {
        confirmation: { daemonStaleMs: 300000, daemonExpiredMs: 600000 },
        // 5-node fleet: READY at 3 peers, a degrade floor of 1 so isolating ONE node degrades
        // only it (drops to 0) while the connected four (3 peers each) stay healthy, and the
        // app-submission peer gate (minOutgoing/minIncoming default 8/4) lowered to the mesh.
        fluxapps: {
          appSyncPeerThreshold: 3, appSyncDegradedThreshold: 1, minOutgoing: 2, minIncoming: 1,
        },
      },
    });
    // minOutbound 2: a 5-node fleet can't reliably reach the default 4 outbound on node 0.
    await bootAndPeer(env, { pricing: true, minOutbound: 2 });
    await resetFluxDrive();
    dbClients = env.clients.map((_, i) => dbClient(i + 1));
  });

  after(async function () {
    this.timeout(30000);
    await clearAllNodeStatus();
    await env?.teardown();
  });

  it('reconciles the manifest through a capability-loss recovery, not a vacuous latch', async function () {
    this.timeout(420000);
    const name = `e2ecaprec${Date.now()}`;
    await pushImage(name, 'v1');

    // Slot app on every node, confirmed + spec gossiped, whole fleet brought to v2 by gossip.
    const dep = await deployContentApp(env.clients[0].url, {
      name,
      image: `${REGISTRY_REPO_HOST}/${name}:v1`,
      instances: env.nodeCount,
      contentSlots: [{
        name: 'conf', destination: '/etc/app.conf', bytes: Buffer.from('caprec v1'), onUpdate: { action: 'restart' },
      }],
    });
    expect(dep.status).to.equal('success');
    await queueAppTx(dep.data);
    await advanceBlocks(3);
    await waitFor(
      async () => (await installedInstanceIndices(env, name)).length >= env.nodeCount,
      { timeout: 280000, interval: 3000, label: `all ${env.nodeCount} instances of ${name}` },
    );
    await waitForSpecEverywhere(env, name);
    await pushContentUpdate(env.clients[0].url, {
      name, version: 2, slots: [{ name: 'conf', bytes: Buffer.from('caprec v2') }],
    });
    await waitFor(
      async () => (await assertManifestSynced(dbClients, name, 2)).synced,
      { timeout: 120000, interval: 2000, label: 'fleet at v2' },
    );

    const N = 4;
    const node = env.clients[N];
    // One pre-disturbance cursor scopes every later wait past the boot transitions the
    // reconnect will replay (waitForEvent scans the buffer, and reconnect replays history —
    // afterId 0 would stale-match the boot READY/SYNCING).
    const cursor = node.getLastEventId();

    // 1. Drop capability FIRST (reachable-but-unconfirmed → messageCapable false, app kept).
    await setNodeStatus(node.ip, 'EXPIRED');
    await waitForNodeStatus(node, (d) => d.confirmed === false, 30000, { afterId: cursor });

    // 2. Then partition it: peers drop below the floor, so it degrades (resetting the manifest
    //    latch) and misses the coming v3. Degrade gated on the node's own docker log, the one
    //    channel that crosses a partition.
    const degradedBefore = env.nodeLogCount(N, 'Degraded, pausing spawner');
    await env.disconnectNode(N);
    await waitFor(
      () => env.nodeLogCount(N, 'Degraded, pausing spawner') > degradedBefore,
      { timeout: 60000, interval: 1000, label: `node ${N} DEGRADED` },
    );

    // v3 on the connected side; the isolated node misses the gossip.
    await pushContentUpdate(env.clients[0].url, {
      name, version: 3, slots: [{ name: 'conf', bytes: Buffer.from('caprec v3') }],
    });
    const dbConnected = [0, 1, 2, 3].map((i) => dbClients[i]);
    await waitFor(
      async () => (await assertManifestSynced(dbConnected, name, 3)).synced,
      { timeout: 120000, interval: 2000, label: 'connected side at v3' },
    );
    const isoRow = await dbClients[N].getContentManifest(name);
    expect(isoRow && isoRow.version, `node ${N} diverged at v2`).to.equal(2);

    // 3. Recover. FluxOS gates peer discovery on daemon confirmation (fluxDiscovery throws
    //    "Node not confirmed" while unconfirmed), so a returning node ALWAYS regains capability
    //    before it can re-peer — capability-first is the only reachable order. Restore the
    //    network + confirmation; discovery then resumes and the node re-peers.
    await env.reconnectNode(N);
    await clearNodeStatus(node.ip);
    await env.startDiscovery();

    // Capability returns while the node is still peerless (discovery only just resumed), so
    // the capability-gain sync round finds no peers. The evidence-based latch keeps the
    // manifest INCOMPLETE through that round; when peers reconnect the resync reconciles it
    // for real (fetched >= 1) and the node reaches READY. The old vacuous latch would mark the
    // peerless round "done" and leave the register permanently stale at v2.
    await node.waitForEvent('content:manifestReconciled', (d) => d.fetched >= 1, 180000, { afterId: cursor });
    await waitForOrchestratorState(node, 'READY', 120000, { afterId: cursor });

    // Real state: node N's register caught up to v3 (stuck at v2 under the wedge).
    await waitFor(
      async () => {
        const row = await dbClients[N].getContentManifest(name);
        return row && row.version === 3;
      },
      { timeout: 60000, interval: 2000, label: `node ${N} register at v3 post-recovery` },
    );
  });
});
