import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import {
  deployContentApp, pushContentUpdate, assertManifestSynced, injectForgedManifestGossip,
} from '../framework/content-helper.js';
import { getFluxDriveState, resetFluxDrive } from '../framework/fluxdrive-control.js';
import { pushImage } from '../framework/registry-helper.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
import { waitForAppInstalled, waitFor } from '../framework/wait.js';
import { dbClient } from '../framework/db-client.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

// Content-slot manifest GOSSIP + BOOT recovery. A slot app's owner-signed manifest
// is a permanent latest-wins register that rides the change-only gossip plane for
// live updates and the in-band reconcile plane for a node that was away. This suite
// proves the four manifest-plane behaviours on a real 5-node fleet, asserting on the
// SSE event bus + the appcontentmanifests rows + the FluxDrive stub state (never logs):
//   1. gossip propagation + latest-wins — a v2 update reaches every node that holds
//      the spec (content:manifestReceived) and the register advances 1 -> 2 everywhere.
//   2. manifest-before-spec quarantine — at submission the manifest gossips ahead of
//      the (unconfirmed) spec, so non-origin nodes QUARANTINE it
//      (content:manifestStored{confirmed:false}) rather than dropping it.
//   3. forged owner-signature drop — a peer stub gossips a manifest whose owner sig is
//      from a non-owner key; a spec-holding node drops it (manifestDropped{forged_signature}).
//   4. boot recovery — a node down while a version is published catches it up on boot
//      and stages it before its container starts (content:bootReconcile).
//   5. FluxDrive backstop — the first (cold, peerless) installer provisions its slot
//      content from the FluxDrive deep backstop, not a peer.
//
// nodes:6 (five real nodes + one peer stub at index 5, used to inject the forged-sig
// gossip) with fluxapps.minOutgoing lowered to 2 (a small full mesh only reaches
// ~2 outbound/node — peers connect inbound first and FluxOS dedups); arcane:true so the nodes
// accept content apps and run the benchmark crypto.

describe('content slots: manifest gossip propagation + boot recovery', function () {
  let env;
  dumpLogsOnFailure(() => env);
  const appName = `gossipboot${Date.now()}`;
  const slotName = 'conf';
  const slotDestination = '/etc/app/conf';
  const v1Bytes = Buffer.from('slot content v1 — initial owner-signed manifest');
  const v2Bytes = Buffer.from('slot content v2 — gossiped update');
  const v3Bytes = Buffer.from('slot content v3 — published while a node is down');
  let dbClients;
  let appHash;
  let installedIndex;

  before(async function () {
    this.timeout(420000);
    env = await createTestEnv({
      hookCtx: this, nodes: 6, stubPeers: [5], tickerAutostart: false, arcane: true,
      configOverrides: { fluxapps: { minOutgoing: 2 } },
    });
    await bootAndPeer(env, { minOutbound: 2, minInbound: 1, pricing: true });
    await pushImage(appName, 'v1');
    await resetFluxDrive();
    dbClients = env.clients.map((_, i) => dbClient(i + 1));
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('gossips the v1 manifest at submission; non-origin nodes quarantine it before the spec arrives', async function () {
    this.timeout(120000);
    const origin = env.clients[0];
    const beforeIds = env.clients.map((c) => (c ? c.getLastEventId() : 0)); // stub slot is null

    const res = await deployContentApp(origin.url, {
      name: appName,
      image: `${REGISTRY_REPO_HOST}/${appName}:v1`,
      contentSlots: [{
        name: slotName, destination: slotDestination, bytes: v1Bytes, onUpdate: { action: 'restart' },
      }],
    });
    expect(res.status).to.equal('success');
    appHash = res.data;

    // Origin stored the manifest verified (it held the spec in-hand at submission) and
    // populated the FluxDrive backstop so a cold installer has a manifest source.
    const stored = await origin.waitForEvent(
      'content:manifestStored',
      (d) => d.appName === appName && d.version === 1 && d.confirmed === true,
      30000,
      { afterId: beforeIds[0] },
    );
    expect(stored.data.confirmed).to.equal(true);
    await origin.waitForEvent(
      'content:manifestBackstopped',
      (d) => d.appName === appName && d.version === 1,
      30000,
      { afterId: beforeIds[0] },
    );

    // The other four nodes receive the gossip but do not yet hold the (unconfirmed)
    // spec, so they QUARANTINE (confirmed:false) — never a drop. This IS scenario 2.
    await Promise.all([1, 2, 3, 4].map((i) => env.clients[i].waitForEvent(
      'content:manifestStored',
      (d) => d.appName === appName && d.confirmed === false,
      45000,
      { afterId: beforeIds[i] },
    )));

    // The quarantine is durable in the register: a confirmed:false row at version 1.
    for (const i of [1, 2, 3, 4]) {
      // eslint-disable-next-line no-await-in-loop
      const row = await dbClients[i].getContentManifest(appName);
      expect(row, `node ${i} holds a quarantined manifest`).to.exist;
      expect(row.version).to.equal(1);
      expect(row.confirmed).to.equal(false);
    }
  });

  it('confirms on-chain; the first cold installer provisions slot content from the FluxDrive backstop', async function () {
    this.timeout(240000);
    expect(appHash, 'submission produced an app hash').to.be.a('string');
    const beforeIds = env.clients.map((c) => (c ? c.getLastEventId() : 0)); // stub slot is null

    await queueAppTx(appHash);
    await advanceBlocks(3);

    installedIndex = await Promise.any(env.clients.map(async (c, i) => {
      if (!c) throw new Error('stub slot'); // never installs; rejected out of the race
      await waitForAppInstalled(c, appName, 200000);
      return i;
    }));
    const node = env.clients[installedIndex];

    // No node runs the app yet (no peers), so the install-hold resolves both the
    // manifest and the slot bytes from the FluxDrive deep backstop. A blobProvisioned
    // event means the hash-verified slot bytes landed; blobResolved names the source.
    const resolved = await node.waitForEvent(
      'content:blobResolved',
      (d) => d.appName === appName,
      90000,
      { afterId: beforeIds[installedIndex] },
    );
    expect(resolved.data.source).to.equal('fluxdrive');
    await node.waitForEvent(
      'content:blobProvisioned',
      (d) => d.appName === appName,
      60000,
      { afterId: beforeIds[installedIndex] },
    );

    // FluxDrive holds both the manifest backstop (version 1) and the sealed slot blob
    // (source 'slot') the cold node just read.
    const state = await getFluxDriveState();
    expect(state.manifests[appName], 'manifest backstop present').to.exist;
    expect(state.manifests[appName].version).to.equal(1);
    const slotBlob = state.blobs.find((b) => b.appName === appName && b.source === 'slot' && !b.tombstoned);
    expect(slotBlob, 'slot blob present in FluxDrive').to.exist;
  });

  it('propagates a v2 content update to every spec-holding node and advances the register latest-wins', async function () {
    this.timeout(180000);
    // After confirmation each non-origin node promotes its quarantined v1 row once the
    // spec lands (the promote-on-confirm hook); a confirmed:true row is the durable
    // proof the spec is now local, so receiveManifest will store (not re-quarantine) v2.
    await Promise.all([1, 2, 3, 4].map((i) => waitFor(
      async () => {
        const row = await dbClients[i].getContentManifest(appName);
        return !!(row && row.version === 1 && row.confirmed === true);
      },
      { timeout: 120000, interval: 3000, label: `node ${i} promotes v1 on spec-confirm` },
    )));

    const beforeIds = env.clients.map((c) => (c ? c.getLastEventId() : 0)); // stub slot is null
    const up = await pushContentUpdate(env.clients[0].url, {
      name: appName, version: 2, slots: [{ name: slotName, bytes: v2Bytes }],
    });
    expect(up.status).to.equal('success');

    // Every non-origin node receives + verifies + stores v2 (the change-only gossip
    // live-update path). The origin is the submitter, so it emits contentUpdateApplied,
    // not manifestReceived (gossip never loops back to itself).
    await Promise.all([1, 2, 3, 4].map((i) => env.clients[i].waitForEvent(
      'content:manifestReceived',
      (d) => d.appName === appName && d.version === 2,
      60000,
      { afterId: beforeIds[i] },
    )));

    // Latest-wins: the monotonic register advances 1 -> 2 on EVERY node (origin included).
    await waitFor(
      async () => {
        const { synced } = await assertManifestSynced(dbClients, appName, 2);
        return synced;
      },
      { timeout: 60000, interval: 3000, label: 'every node converges to manifest v2' },
    );
  });

  it('drops a forged owner-signature gossiped by a peer (content:manifestDropped{forged_signature})', async function () {
    this.timeout(120000);
    // The peer stub (a trusted node-list member at index 5) gossips a manifest at a
    // fresh-high version — clearing the latest-wins floor — whose owner signature is from
    // a NON-owner key. The stub's node envelope is valid so the relay check passes; the
    // owner-sig check then fails and the spec-holding node drops it. Models a Byzantine
    // peer relaying an owner-unverified manifest, which honest nodes never do.
    const stub = env.stubPeerClients.get(5);
    const target = env.clients[1];
    const beforeId = target.getLastEventId();

    const res = await injectForgedManifestGossip(stub, {
      appName,
      version: 99,
      slots: [{ name: slotName, bytes: Buffer.from('forged slot bytes') }],
    });
    expect(res.sent, 'stub pushed the gossip to at least one connected node').to.be.greaterThan(0);

    const dropped = await target.waitForEvent(
      'content:manifestDropped',
      (d) => d.appName === appName && d.reason === 'forged_signature',
      45000,
      { afterId: beforeId },
    );
    expect(dropped.data.reason).to.equal('forged_signature');

    // Dropped, not stored: the forged manifest never advanced the register.
    const row = await dbClients[1].getContentManifest(appName);
    expect(row, 'node 1 still holds its manifest row').to.exist;
    expect(row.version, 'the dropped forged manifest never advanced the register').to.be.below(99);
  });

  it('recovers on boot: a node down while v3 is published catches it up and stages it before start', async function () {
    this.timeout(300000);
    expect(installedIndex, 'an installer was selected').to.be.a('number');
    // Publish v3 from a node that is NOT the one we take down (and never the origin if
    // the origin is the installer), so the update genuinely lands on the live fleet.
    const pushIndex = installedIndex === 0 ? 1 : 0;

    // 1) Take the installer off the network: it is now "down" for the v3 publish window
    //    and will miss the change-only gossip (gossip is not replayed retroactively).
    await env.disconnectNode(installedIndex);

    // 2) Publish v3 on the live fleet. The submitter stores it synchronously, so its own
    //    register is at v3 the moment the call returns — proof the version is published.
    const up = await pushContentUpdate(env.clients[pushIndex].url, {
      name: appName, version: 3, slots: [{ name: slotName, bytes: v3Bytes }],
    });
    expect(up.status).to.equal('success');
    await waitFor(
      async () => {
        const row = await dbClients[pushIndex].getContentManifest(appName);
        return !!(row && row.version === 3);
      },
      { timeout: 60000, interval: 2000, label: `live node ${pushIndex} holds v3` },
    );

    // 3) Reconnect (re-attach to the network) then restart FluxOS. Boot recovery only
    //    runs on a real process boot. Re-trigger discovery so the rebooted node re-peers
    //    and its in-band manifest reconcile can pull the version it missed while down.
    await env.reconnectNode(installedIndex);
    await env.restartNode(installedIndex);
    await env.startDiscovery();
    const node = env.clients[installedIndex];

    // Boot recovery stages the slot content before the container (re)starts. The
    // event fires for the installed slot app on boot (afterId omitted: it can fire
    // during boot, just after the SSE stream reconnects).
    const boot = await node.waitForEvent(
      'content:bootReconcile',
      (d) => d.appName === appName,
      180000,
    );
    expect(boot.data.version, 'bootReconcile carries a manifest version').to.be.a('number');

    // Ground truth: the rebooted node converges its register to v3 — the version that
    // was published while it was down — via the in-band manifest reconcile.
    await waitFor(
      async () => {
        const row = await dbClients[installedIndex].getContentManifest(appName);
        return !!(row && row.version === 3 && row.confirmed === true);
      },
      { timeout: 180000, interval: 3000, label: 'rebooted node catches up v3 published while down' },
    );
  });
});
