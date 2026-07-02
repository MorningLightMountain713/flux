import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer, installedInstanceIndices } from '../framework/reconciler-suite.js';
import {
  deployContentApp, pushContentUpdate, assertManifestSynced,
} from '../framework/content-helper.js';
import { resetFluxDrive } from '../framework/fluxdrive-control.js';
import { pushImage } from '../framework/registry-helper.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
import { waitForAppInstalled, waitFor } from '../framework/wait.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { dbClient } from '../framework/db-client.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

// Multi-node content propagation: the slot-manifest register is a permanent latest-wins
// value that must converge to the same version on every node by TWO complementary paths,
// and the content bodies must be fetched once per missing holder (never amplified):
//   1. LIVE gossip — a contentupdate broadcast applies on the submitter
//      (content:contentUpdateApplied) and lands on every other node holding the spec
//      (content:manifestReceived), so the whole fleet's appcontentmanifests row reaches v2.
//   2. ECONOMY of fetches — a blob body is served once per distinct missing holder
//      (content:blobServed == the peer-resolving holders), not peers x bodies.
//   3. RECONCILE backfill — a node that was partitioned away (and so MISSED the live
//      gossip) converges its register to the network's higher version via the two-step
//      in-band reconcile (content:manifestReconciled), not a fresh gossip that never re-fires.
//
// nodes:10 so a partition leaves both sides comfortably above the harness peer thresholds
// (appSyncPeerThreshold 2 / appSyncDegradedThreshold 1) — the connected side keeps
// gossiping while the isolated side degrades, then reconciles on reconnect. arcane:true so
// the nodes accept content apps and run the benchmark crypto. Assert on the SSE bus plus
// the real appcontentmanifests rows (read directly from the shared mongod), never logs.

// Count buffered events of `name` after `afterId` matching `predicate` on one node.
function countEvents(node, name, afterId, predicate = () => true) {
  return node.getEventBuffer().filter(
    (e) => e.event === name && e.id > afterId && predicate(e.data),
  ).length;
}

// Wait until every node's global spec for `name` is present — the precondition for a
// gossiped manifest to be owner-verified and confirm-stored (rather than quarantined).
async function waitForSpecEverywhere(env, name, timeout = 150000) {
  await waitFor(async () => {
    const rows = await Promise.all(env.clients.map((c) => c.getAppSpecs(name).catch(() => null)));
    return rows.every((r) => r && r.status === 'success' && r.data && r.data.name === name);
  }, { timeout, interval: 3000, label: `global spec for ${name} on all nodes` });
}

describe('content propagation across a multi-node fleet', function () {
  let env;
  let dbClients;
  dumpLogsOnFailure(() => env);

  before(async function () {
    this.timeout(540000);
    env = await createTestEnv({
      hookCtx: this, nodes: 10, tickerAutostart: false, arcane: true,
    });
    await bootAndPeer(env, { pricing: true });
    await resetFluxDrive();
    dbClients = env.clients.map((_, i) => dbClient(i + 1));
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('propagates a contentupdate to v2 fleet-wide: submitter applies, peers receive, every row reaches v2', async function () {
    this.timeout(360000);
    const name = `e2eprop${Date.now()}`;
    await pushImage(name, 'v1');

    // Register a slot app (auto-bundled v1 manifest) and confirm it, so its global spec
    // gossips to the whole fleet (the gate every peer needs to confirm-store a v2 gossip).
    const dep = await deployContentApp(env.clients[0].url, {
      name,
      image: `${REGISTRY_REPO_HOST}/${name}:v1`,
      contentSlots: [{
        name: 'conf', destination: '/etc/app.conf', bytes: Buffer.from('prop config v1'), onUpdate: { action: 'restart' },
      }],
    });
    expect(dep.status).to.equal('success');
    await queueAppTx(dep.data);
    await advanceBlocks(3);
    await Promise.any(env.clients.map((c, i) => waitForAppInstalled(c, name, 220000).then(() => i)));
    await waitForSpecEverywhere(env, name);

    // Push v2 from node 0. The submitter applies locally (contentUpdateApplied); the
    // broadcast reaches every peer holding the spec (manifestReceived). Gossip never loops
    // back, so node 0 emits only the apply, the other nine emit only the receive.
    const afterIds = env.clients.map((c) => c.getLastEventId());
    const up = await pushContentUpdate(env.clients[0].url, {
      name, version: 2, slots: [{ name: 'conf', bytes: Buffer.from('prop config v2') }],
    });
    expect(up.status, JSON.stringify(up)).to.equal('success');
    expect(up.data.version).to.equal(2);

    await env.clients[0].waitForEvent(
      'content:contentUpdateApplied',
      (d) => d.appName === name && d.version === 2,
      90000,
      { afterId: afterIds[0] },
    );
    await Promise.all(env.clients.slice(1).map((c, i) => c.waitForEvent(
      'content:manifestReceived',
      (d) => d.appName === name && d.version === 2,
      120000,
      { afterId: afterIds[i + 1] },
    )));

    // Real state: every node's appcontentmanifests register converged to v2.
    await waitFor(
      async () => (await assertManifestSynced(dbClients, name, 2)).synced,
      { timeout: 90000, interval: 2000, label: `all ${env.nodeCount} rows at v2` },
    );
    const { versions } = await assertManifestSynced(dbClients, name, 2);
    expect(versions).to.have.lengthOf(env.nodeCount);
    expect(versions.every((v) => v === 2)).to.equal(true);
  });

  it('fetches each blob body once per missing holder: blobServed equals the peer-resolving holders, not peers x bodies', async function () {
    this.timeout(360000);
    const name = `e2eserve${Date.now()}`;
    await pushImage(name, 'v1'); // /bin/pause: the holder stays up to serve peers
    const contentBytes = Buffer.from('immutable contentRef body for the serve-economy suite');

    // Register a multi-instance contentRef app. The synchronous upload gives us the
    // locator; the spawner then self-selects several nodes which each provision the body.
    const afterDeploy = env.clients[0].getLastEventId();
    const dep = await deployContentApp(env.clients[0].url, {
      name,
      image: `${REGISTRY_REPO_HOST}/${name}:v1`,
      contentRef: contentBytes,
      instances: 5,
    });
    expect(dep.status).to.equal('success');
    const uploaded = await env.clients[0].waitForEvent(
      'content:blobUploaded',
      (d) => d.appName === name && d.source === 'blob',
      30000,
      { afterId: afterDeploy },
    );
    const { locator } = uploaded.data;
    expect(locator).to.match(/^[0-9a-f]{64}$/);

    // Snapshot every node's event cursor before confirm; the provision events (resolved/
    // served/provisioned) all fire during install, after this point.
    const afterIds = env.clients.map((c) => c.getLastEventId());
    await queueAppTx(dep.data);
    await advanceBlocks(3);

    // Let the spawner place several instances (it staggers via the installing-broadcast
    // backoff, so later holders find an already-running peer and fetch the body from it).
    await waitFor(
      async () => (await installedInstanceIndices(env, name)).length >= 3,
      { timeout: 220000, interval: 3000, label: `>=3 instances of ${name}` },
    );
    const installed = await installedInstanceIndices(env, name);

    // Each installed node must have provisioned the single body exactly once — the
    // "fetch each body once" invariant, regardless of which source served it.
    await Promise.all(installed.map((i) => env.clients[i].waitForEvent(
      'content:blobProvisioned',
      (d) => d.appName === name,
      60000,
      { afterId: afterIds[i] },
    )));

    let totalServed = 0;
    let totalPeerResolved = 0;
    let totalFluxResolved = 0;
    for (const i of installed) {
      const node = env.clients[i];
      const provisioned = countEvents(node, 'content:blobProvisioned', afterIds[i], (d) => d.appName === name);
      const resolved = countEvents(node, 'content:blobResolved', afterIds[i], (d) => d.appName === name);
      expect(provisioned, `node ${i} provisioned the body exactly once`).to.equal(1);
      expect(resolved, `node ${i} resolved the body exactly once (no re-fetch across peers)`).to.equal(1);
      totalPeerResolved += countEvents(node, 'content:blobResolved', afterIds[i], (d) => d.appName === name && d.source === 'peer');
      totalFluxResolved += countEvents(node, 'content:blobResolved', afterIds[i], (d) => d.appName === name && d.source === 'fluxdrive');
    }
    // blobServed fires only on the SERVING side; sum it for this locator across the fleet.
    for (let i = 0; i < env.clients.length; i++) {
      totalServed += countEvents(env.clients[i], 'content:blobServed', afterIds[i], (d) => d.appName === name && d.locator === locator);
    }

    // Conservation: every peer fetch is exactly one serve. If the resolver had amplified
    // to peers x bodies, served would exceed the peer-resolving holders.
    expect(totalServed, 'one serve per peer-resolving holder (== distinct missing holders served by a peer)').to.equal(totalPeerResolved);
    // Each install provisioned the one body once: peer + fluxdrive resolutions == installs.
    expect(totalPeerResolved + totalFluxResolved, 'every installed holder resolved the body exactly once').to.equal(installed.length);
    // And no body was served more times than there were holders needing it.
    expect(totalServed).to.be.at.most(installed.length);
  });

  it('converges a partitioned-away node to the higher version via reconcile, not a fresh gossip', async function () {
    this.timeout(480000);
    const name = `e2ediverge${Date.now()}`;
    await pushImage(name, 'v1');

    // Register + confirm a slot app, then bring the WHOLE fleet to v2 by gossip so both
    // sides of the coming partition start from the same real version (true divergence).
    const dep = await deployContentApp(env.clients[0].url, {
      name,
      image: `${REGISTRY_REPO_HOST}/${name}:v1`,
      contentSlots: [{
        name: 'conf', destination: '/etc/app.conf', bytes: Buffer.from('diverge v1'), onUpdate: { action: 'restart' },
      }],
    });
    expect(dep.status).to.equal('success');
    await queueAppTx(dep.data);
    await advanceBlocks(3);
    await Promise.any(env.clients.map((c, i) => waitForAppInstalled(c, name, 220000).then(() => i)));
    await waitForSpecEverywhere(env, name);

    await pushContentUpdate(env.clients[0].url, {
      name, version: 2, slots: [{ name: 'conf', bytes: Buffer.from('diverge v2') }],
    });
    await waitFor(
      async () => (await assertManifestSynced(dbClients, name, 2)).synced,
      { timeout: 120000, interval: 2000, label: 'whole fleet at v2 pre-partition' },
    );

    // Partition: isolate the last three nodes from the docker network entirely. The
    // connected seven keep >=2 peers (above the degraded threshold) and keep gossiping;
    // the three isolated nodes drop to 0 peers and degrade.
    const isolated = [7, 8, 9];
    const connected = [0, 1, 2, 3, 4, 5, 6];
    for (const i of isolated) {
      await env.disconnectNode(i);
    }

    // Push v3 on the connected side only — it can't reach the isolated nodes.
    await pushContentUpdate(env.clients[0].url, {
      name, version: 3, slots: [{ name: 'conf', bytes: Buffer.from('diverge v3') }],
    });
    const dbConnected = connected.map((i) => dbClients[i]);
    await waitFor(
      async () => (await assertManifestSynced(dbConnected, name, 3)).synced,
      { timeout: 120000, interval: 2000, label: 'connected side at v3' },
    );

    // Divergence proven: the isolated side is stuck at v2 (it missed the v3 gossip).
    for (const i of isolated) {
      const row = await dbClients[i].getContentManifest(name);
      expect(row && row.version, `isolated node ${i} still at v2`).to.equal(2);
    }

    // Hold the partition until the fleet has DETECTED it: socket death is
    // pong-timeout driven (wsPingIntervalMs 2s x 3 missed pongs ~ 6s here), and
    // healing before detection means the isolated nodes never leave READY and
    // never resync. The connected side's peers:removed for each isolated address
    // is the live observable (the isolated side runs the same ping cadence, and
    // the post-heal reconcile waits fail loudly if its own detection lagged). Any
    // connected node removing the address counts — the mesh is dense but not
    // necessarily complete.
    const isolatedAddrs = isolated.map((i) => `198.18.0.${10 + i}`);
    await Promise.all(isolatedAddrs.map((addr) => Promise.any(
      connected.map((c) => env.clients[c].waitForEvent(
        'peers:removed',
        (d) => d.ip === addr,
        60000,
        { afterId: 0 },
      )),
    )));

    // Heal the partition. The reconnected nodes re-peer, cross the peer threshold, and
    // the orchestrator runs DEGRADED -> RESYNCING -> the two-step manifest reconcile.
    for (const i of isolated) {
      await env.reconnectNode(i);
    }
    await env.startDiscovery();

    // Convergence is via RECONCILE: each isolated node fetches the missing higher version
    // in-band (content:manifestReconciled with fetched>=1). A fresh gossip would not re-fire
    // for a value broadcast while the node was away, so reconcile is the only path here.
    await Promise.all(isolated.map((i) => env.clients[i].waitForEvent(
      'content:manifestReconciled',
      (d) => d.fetched >= 1,
      240000,
      { afterId: 0 },
    )));

    // Real state: the isolated side's appcontentmanifests register caught up to v3.
    const dbIsolated = isolated.map((i) => dbClients[i]);
    await waitFor(
      async () => (await assertManifestSynced(dbIsolated, name, 3)).synced,
      { timeout: 150000, interval: 3000, label: 'isolated side converged to v3' },
    );
    const { versions } = await assertManifestSynced(dbClients, name, 3);
    expect(versions.every((v) => v === 3)).to.equal(true);
  });
});
