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
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

// A returning node must reconcile its content-manifest register no matter which of its two
// recovery wake-ups (peers-back / capability-back) lands first. The dangerous interleaving
// is peers-BEFORE-capability: the RESYNCING pass completes the hash sync but can't send yet,
// so the manifest reconcile defers; if the capability-gain retry keys on "hash isn't done"
// (which it now is) it never re-runs the manifest step, and the node ships READY with a
// permanently stale register. The unified sync driver re-runs whatever is still incomplete,
// so the manifest reconciles once capability returns.
//
// The interleaving is forced with two independent levers: setNodeStatus EXPIRED makes the
// daemon RPC reachable-but-unconfirmed (message capability drops, but the app is NOT removed
// — daemon-stale removal only fires on an UNREACHABLE daemon), and disconnectNode partitions
// the peers. Confirmation windows are widened so the partition (which also cuts the shared
// daemon) doesn't remove the app mid-test; appSyncPeerThreshold 3 so a single isolated node
// drops below the degrade floor. SSE can't cross the partition, so the degrade gate reads the
// node's own docker log; behavioural asserts use the shared appcontentmanifests rows + the
// node's own bus once healed.

async function waitForSpecEverywhere(env, name, timeout = 150000) {
  await waitFor(async () => {
    const rows = await Promise.all(env.clients.map((c) => c.getAppSpecs(name).catch(() => null)));
    return rows.every((r) => r && r.status === 'success' && r.data && r.data.name === name);
  }, { timeout, interval: 3000, label: `global spec for ${name} on all nodes` });
}

describe('content manifest recovery through a message-capability round-trip', function () {
  let env;
  let dbClients;
  dumpLogsOnFailure(() => env);

  before(async function () {
    this.timeout(540000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 5,
      tickerAutostart: false,
      arcane: true,
      configOverrides: {
        confirmation: { daemonStaleMs: 300000, daemonExpiredMs: 600000 },
        fluxapps: { appSyncPeerThreshold: 3 },
      },
    });
    await bootAndPeer(env, { pricing: true });
    await resetFluxDrive();
    dbClients = env.clients.map((_, i) => dbClient(i + 1));
  });

  after(async function () {
    this.timeout(30000);
    await clearAllNodeStatus();
    await env?.teardown();
  });

  it('reconciles the manifest after a peers-first, capability-second recovery (never wedges in RESYNCING)', async function () {
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

    // 3. Recover peers FIRST. The node re-peers and enters RESYNCING, but the resync cannot
    //    send yet (still uncapable), so the manifest reconcile is correctly deferred — and it
    //    stays in RESYNCING (the old wedge would strand it there permanently).
    await env.reconnectNode(N);
    await env.startDiscovery();
    await waitForOrchestratorState(node, 'RESYNCING', 60000, { afterId: cursor });

    // 4. Capability SECOND. The unified driver re-runs whatever is incomplete, so the manifest
    //    reconciles (fetched >= 1) and the node reaches READY — under finding-2's wedge the
    //    capability-gain retry would key on the already-complete hash sync and skip it forever.
    await clearNodeStatus(node.ip);
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
