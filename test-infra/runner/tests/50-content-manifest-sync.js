import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { deployContentApp } from '../framework/content-helper.js';
import { resetFluxDrive } from '../framework/fluxdrive-control.js';
import { pushImage } from '../framework/registry-helper.js';
import {
  startTicker, advanceBlock, advanceBlocks, queueAppTx,
} from '../framework/daemon-control.js';
import {
  waitForDaemonReady, waitForNodeStatus, waitForBlockProcessed, waitForAppInstalled, waitFor,
} from '../framework/wait.js';
import { dbClient } from '../framework/db-client.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';
import { bootstrapPricing } from '../framework/price-helper.js';

// Content-manifest sync: the permanent latest-wins register reconciled OFF the
// ephemeral boot-sync plane (the two-step in-band exchange in
// contentManifestSyncService + appSyncOrchestrator.#runManifestSync). A node that
// missed a slot app's manifest while down converges its register on boot via an
// INDEX round (peers' (appName,version) vector) then a FETCH round (only the
// bodies it lacks), gated by #manifestSyncComplete so the spawner can't start a
// slot app until the register has converged.
//
// nodes:10 with one DEFERRED node: nodes 0-8 boot and install a slot app (so its
// owner-signed manifest is confirmed + envelope-bearing on the fleet), then node 9
// joins cold and reconciles the manifest it never saw. Asserts on the SSE event
// bus (content:manifestSync* / content:manifestReconciled) plus the
// appcontentmanifests DB rows (dbClient.getContentManifest) — never log scraping.
// arcane:true so the node accepts the v9 content app and runs the benchmark crypto.

const NODES = 10;
const DEFERRED = NODES - 1; // index 9 — the cold joiner
const INITIAL_IDX = Array.from({ length: DEFERRED }, (_, i) => i); // 0..8

// Index-taking bootAndPeer: the shared reconciler-suite bootAndPeer iterates every
// client (the deferred index is a null gap until startNode), so a deferred-node
// suite uses the 22-state-sync local variant that peers only the initial fleet.
async function bootAndPeerInitial(env, nodeIndices) {
  const clients = nodeIndices.map((i) => env.clients[i]).filter(Boolean);
  for (const client of clients) await waitForDaemonReady(client);
  await Promise.all(clients.map(
    (c) => waitForNodeStatus(c, (d) => d.confirmed === true, 30000),
  ));
  await advanceBlock();
  for (const client of clients) {
    await waitForBlockProcessed(client, (d) => d.height > 2100000, 50000);
  }
  await env.startDiscovery(nodeIndices);
  await clients[0].waitForEvent('peers:added', (d) => d.outbound >= 4, 120000);
  await clients[0].waitForEvent('peers:added', (d) => d.inbound >= 2, 120000);
  await startTicker();
}

describe('content manifest sync: cold-boot in-band reconcile off the ephemeral plane', function () {
  let env;
  dumpLogsOnFailure(() => env);
  const appName = `manifestsync${Date.now()}`;
  const contentSlots = [{
    name: 'conf',
    destination: '/etc/app/app.conf',
    bytes: Buffer.from(`manifest-sync slot v1 for ${appName}`),
    onUpdate: { action: 'restart' },
  }];

  let appHash;
  let installedIndex = -1; // an initial node that installed the slot app (post-READY)
  let installedEntry = null; // its app:installed SSE entry
  let deferredClient = null; // the cold joiner, started in the first it()

  before(async function () {
    this.timeout(600000);
    env = await createTestEnv({
      hookCtx: this, nodes: NODES, deferredNodes: 1, tickerAutostart: false, arcane: true,
    });
    await bootAndPeerInitial(env, INITIAL_IDX);
    // this suite boots its fleet through the local index-taking helper, so it
    // drives price-helper directly instead of bootAndPeer's pricing option
    await bootstrapPricing();
    await pushImage(appName, 'v1');
    await resetFluxDrive();

    // Deploy + confirm a slot app on the initial fleet so its v1 manifest exists
    // BEFORE the cold node joins. The submission stores the manifest confirmed +
    // envelope-bearing on the register node and gossips it; on-chain confirm lets
    // the spawner install it (which proves the readiness gate in test 2).
    const res = await deployContentApp(env.clients[0].url, {
      name: appName,
      image: `${REGISTRY_REPO_HOST}/${appName}:v1`,
      contentSlots,
    });
    expect(res.status).to.equal('success');
    appHash = res.data;

    await queueAppTx(appHash);
    await advanceBlocks(3);

    const winner = await Promise.any(INITIAL_IDX.map(async (i) => {
      const entry = await waitForAppInstalled(env.clients[i], appName, 200000);
      return { i, entry };
    }));
    installedIndex = winner.i;
    installedEntry = winner.entry;

    // The register node (0) holds the confirmed, envelope-bearing v1 row the cold
    // joiner will fetch from. Wait for it so the joiner's reconcile sees a real gap.
    await waitFor(async () => {
      const row = await dbClient(1).getContentManifest(appName).catch(() => null);
      return !!(row && row.version === 1 && row.confirmed === true);
    }, { timeout: 60000, interval: 2000, label: 'manifest confirmed on register node' });
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('reconciles the missed slot-app manifest on cold boot (syncStarted then syncComplete, DB converges)', async function () {
    this.timeout(300000);
    // Bring the cold node online. Its event stream connects in startNode, well
    // before the boot sync runs, so the reconcile events are captured.
    deferredClient = await env.startNode(DEFERRED);
    await waitForDaemonReady(deferredClient);
    await waitForNodeStatus(deferredClient, (d) => d.confirmed === true, 30000);
    // Actively initiate peering so the reconcile has eligible peers to ask.
    await env.startDiscovery([DEFERRED]);

    // The permanent-plane reconcile: started, then complete carrying the round
    // accounting. It is NOT one of the ephemeral SYNC_TYPES — it rides its own
    // in-band index/fetch exchange off the boot-sync plane.
    const started = await deferredClient.waitForEvent('content:manifestSyncStarted', () => true, 240000);
    const complete = await deferredClient.waitForEvent(
      'content:manifestSyncComplete', () => true, 240000, { afterId: started.id },
    );
    // The joiner asked peers (peers>=1), at least one answered the cheap index
    // (indexesReceived>=1), and it fetched the one body it was missing (fetched>=1).
    expect(complete.data.peers).to.be.at.least(1);
    expect(complete.data.indexesReceived).to.be.at.least(1);
    expect(complete.data.fetched).to.be.at.least(1);

    // The cold node's appcontentmanifests register converges to the network version.
    // The fetched body lands QUARANTINED (the spec races it) and promotes on the
    // app-message-confirm path, which on a cold joiner needs the explorer catch-up
    // plus a hashSyncIntervalMs (30s) retry tick to materialize the spec — allow a
    // couple of ticks.
    await waitFor(async () => {
      const row = await dbClient(DEFERRED + 1).getContentManifest(appName).catch(() => null);
      return !!(row && row.version === 1 && row.confirmed === true);
    }, { timeout: 150000, interval: 3000, label: 'cold node manifest converged to v1' });
    const row = await dbClient(DEFERRED + 1).getContentManifest(appName);
    expect(row.appName).to.equal(appName);
    expect(row.version).to.equal(1);
    expect(row.confirmed).to.equal(true);
  });

  it('gates the spawner on #manifestSyncComplete before a slot app starts (readiness gate)', async function () {
    this.timeout(30000);
    // On the node that installed the slot app, the boot-time manifest reconcile
    // completed BEFORE the orchestrator went READY, and READY is the gate the
    // spawner waits behind — so the manifest register had converged before the
    // slot app's install/run. (On this initial node the boot reconcile saw no
    // manifests yet; the gate ordering is what is asserted.)
    expect(installedIndex, 'an initial node installed the slot app').to.be.at.least(0);
    const buffer = env.clients[installedIndex].getEventBuffer();

    const manifestComplete = buffer.find((e) => e.event === 'content:manifestSyncComplete');
    expect(manifestComplete, 'manifestSyncComplete on the installing node').to.exist;

    const ready = buffer.find((e) => e.event === 'orchestrator:stateChanged' && e.data.to === 'READY');
    expect(ready, 'orchestrator reached READY').to.exist;

    // manifestSyncComplete -> READY -> slot app installed.
    expect(manifestComplete.id).to.be.lessThan(ready.id);
    expect(ready.id).to.be.lessThan(installedEntry.id);
  });

  it('emits content:manifestReconciled with the round accounting { requested, fetched } (single-flight round)', async function () {
    this.timeout(30000);
    // The cold joiner's single boot reconcile round publishes exactly one
    // manifestReconciled carrying the gap accounting: it requested the one app it
    // lacked and fetched it (fetched===requested, fully converged). reconcile() is
    // single-flight (reconcileRunning guard) so one round yields one such event.
    expect(deferredClient, 'cold node was started in test 1').to.exist;
    const reconciled = deferredClient.getEventBuffer()
      .filter((e) => e.event === 'content:manifestReconciled');
    expect(reconciled.length, 'at least one reconcile round').to.be.at.least(1);

    const withGap = reconciled.find((e) => e.data.requested >= 1);
    expect(withGap, 'a reconcile round with a non-empty gap').to.exist;
    expect(withGap.data.fetched).to.be.at.most(withGap.data.requested);
    expect(withGap.data.fetched).to.equal(withGap.data.requested); // gap fully closed
    expect(withGap.data.fetched).to.be.at.least(1);
  });
});
