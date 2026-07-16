import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer, installedInstanceIndices } from '../framework/reconciler-suite.js';
import {
  deployContentApp, pushContentUpdate, assertManifestSynced, assertContentApplied,
} from '../framework/content-helper.js';
import { resetFluxDrive } from '../framework/fluxdrive-control.js';
import { pushImage } from '../framework/registry-helper.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
import { waitFor } from '../framework/wait.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { dbClient } from '../framework/db-client.js';

// The silent-staleness gap: change-only manifest gossip is fire-once, and the boot/recovery
// reconcile only re-arms when a node DEGRADES (drops below the peer floor). A node held in a
// partial partition that keeps >= the floor of peers never degrades, so it misses the gossip,
// never resyncs, and — once healed — serves the OLD content indefinitely while its register
// and container both sit a version behind. The steady-state backstop closes this: a low-
// frequency pull-reconcile on the block cadence converges the register AND catches the running
// container up (a synced fetch stores the manifest but does not itself apply it — the apply is
// what makes the container actually serve the new content, the half suite 56 never proved).
//
// The "keeps some peers, never degrades" case is reproduced faithfully with a full isolation
// and appSyncDegradedThreshold 0 — the orchestrator cannot tell "kept some peers above the
// floor" from "the floor is unreachable", both mean it never crosses the degrade line and so
// never re-arms a resync. manifestRefreshBlocks 3 fires the backstop within the suite;
// confirmation windows widened so the isolation (which cuts the shared daemon) neither removes
// the app nor drops capability (either would knock the node out of READY and trigger a resync,
// defeating the point). SSE can't cross the partition, so divergence is read from the shared
// appcontentmanifests rows; convergence + the apply are asserted on the node's own bus + rows
// once healed.

async function waitForSpecEverywhere(env, name, timeout = 150000) {
  await waitFor(async () => {
    const rows = await Promise.all(env.clients.map((c) => c.getAppSpecs(name).catch(() => null)));
    return rows.every((r) => r && r.status === 'success' && r.data && r.data.name === name);
  }, { timeout, interval: 3000, label: `global spec for ${name} on all nodes` });
}

describe('steady-state manifest backstop converges a silently-stale node', function () {
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
        fluxapps: {
          appSyncPeerThreshold: 3,
          appSyncDegradedThreshold: 0, // never degrade — reproduce "stayed above the floor"
          manifestRefreshBlocks: 3, // fire the steady-state refresh within the suite
          minOutgoing: 2, minIncoming: 1, // app-submission peer gate, lowered to the 5-node mesh
          // No appSyncMinPeerUptime override: the refresh must find the healed
          // peers through its OWN uptime floor (manifestRefreshMinPeerUptime) -
          // that behavior is part of what this suite proves. Lowered to keep the
          // suite fast; the boot sync's 2h gate stays untouched either way.
          manifestRefreshMinPeerUptime: 2,
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
    await env?.teardown();
  });

  it('converges a node that missed an update without degrading, and applies it to the running container', async function () {
    this.timeout(420000);
    const name = `e2ebackstop${Date.now()}`;
    await pushImage(name, 'v1');

    // Slot app on every node (so node N runs it and can apply content), confirmed + spec
    // gossiped, fleet brought to v2 in both register and delivered content.
    const dep = await deployContentApp(env.clients[0].url, {
      name,
      image: `${REGISTRY_REPO_HOST}/${name}:v1`,
      instances: env.nodeCount,
      contentSlots: [{
        name: 'conf', destination: '/etc/app.conf', bytes: Buffer.from('backstop v1'), onUpdate: { action: 'restart' },
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
      name, version: 2, slots: [{ name: 'conf', bytes: Buffer.from('backstop v2') }],
    });
    await waitFor(
      async () => (await assertManifestSynced(dbClients, name, 2)).synced,
      { timeout: 120000, interval: 2000, label: 'fleet register at v2' },
    );

    const N = 4;
    const node = env.clients[N];
    // Baseline: node N has DELIVERED v2 to its container (appliedVersion 2), so a later v3
    // apply is unambiguous.
    await waitFor(
      async () => (await assertContentApplied([dbClients[N]], name, 2)).applied,
      { timeout: 60000, interval: 2000, label: `node ${N} delivered v2` },
    );
    const backstopAfter = node.getLastEventId();
    const degradedBefore = env.nodeLogCount(N, 'Degraded, pausing spawner');

    // Isolate node N. With the degrade floor at 0 it NEVER degrades — stays READY, never
    // re-arms a resync: exactly the silently-stale case.
    await env.disconnectNode(N);

    // v3 on the connected side; node N misses the gossip.
    await pushContentUpdate(env.clients[0].url, {
      name, version: 3, slots: [{ name: 'conf', bytes: Buffer.from('backstop v3') }],
    });
    const dbConnected = [0, 1, 2, 3].map((i) => dbClients[i]);
    await waitFor(
      async () => (await assertManifestSynced(dbConnected, name, 3)).synced,
      { timeout: 120000, interval: 2000, label: 'connected side at v3' },
    );

    // Divergence: node N is a version behind in BOTH its register and its delivered content,
    // and it never degraded — nothing has re-armed a reconcile.
    const isoRow = await dbClients[N].getContentManifest(name);
    expect(isoRow.version, `node ${N} register diverged at v2`).to.equal(2);
    expect(isoRow.appliedVersion, `node ${N} still serving v2`).to.equal(2);
    expect(env.nodeLogCount(N, 'Degraded, pausing spawner'), `node ${N} never degraded`).to.equal(degradedBefore);

    // Heal. Node N re-peers but — never having degraded — runs no boot/recovery resync. Only
    // the steady-state refresh (block-cadence, READY-gated) can converge it now.
    await env.reconnectNode(N);
    await env.startDiscovery();
    await advanceBlocks(6); // cross the refresh cadence a couple of times

    // The backstop pulls v3 into the register (content:manifestReconciled) AND catches the
    // running container up (content:slotApplied v3). Suite 56 proved only the register; this
    // proves the delivered content.
    await node.waitForEvent('content:manifestReconciled', (d) => d.fetched >= 1, 180000, { afterId: backstopAfter });
    await node.waitForEvent('content:slotApplied', (d) => d.appName === name && d.version === 3, 120000, { afterId: backstopAfter });

    // Real state: node N converged register AND delivered content to v3.
    await waitFor(
      async () => {
        const row = await dbClients[N].getContentManifest(name);
        return row && row.version === 3 && row.appliedVersion === 3;
      },
      { timeout: 90000, interval: 2000, label: `node ${N} converged register + delivered to v3` },
    );
  });
});
