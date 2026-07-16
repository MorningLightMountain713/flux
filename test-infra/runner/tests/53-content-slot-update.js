import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { deployContentApp, pushContentUpdate } from '../framework/content-helper.js';
import { getFluxDriveState, getFluxDriveManifest, resetFluxDrive } from '../framework/fluxdrive-control.js';
import { pushImage, pushTestApp } from '../framework/registry-helper.js';
import { appOwnerKey } from '../framework/keys.js';
import { blobHash } from '../framework/content-crypto-v9.js';
import benchCrypto from '../../daemon-stub/benchCrypto.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
import { waitFor } from '../framework/wait.js';
import { getAppContainerStatus, execInContainer, isAppContainerRunning } from '../framework/container.js';
import { dbClient, closeDb } from '../framework/db-client.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';

// Standalone content-slot updates (POST /apps/contentupdate): the owner pushes a
// new owner-signed manifest version with fresh slot bytes, sealed as one HPKE
// content envelope toward the running node's transport key. Proves the update is
// applied end to end — the version advances, FluxDrive's manifest backstop PUTs
// the new version, the GC reconcile is pushed, and the running container reacts per
// the slot's onUpdate (restart / signal / none). One app per reaction so each
// reaction is asserted in isolation; the update is POSTed to the node RUNNING the
// app so it is both the submitter (contentUpdateApplied / reconcilePushed) and the
// applier (slotApplied). App D (two slots) pins the carry-over submission contract:
// rotating one slot attaches one file — the unchanged slot is declared by hash and
// presence-checked (one HEAD) instead of re-uploaded, and a hash the prior version
// never delivered is a precise fail-closed reject. Asserts on the SSE event bus +
// the FluxDrive stub state + the appcontentmanifests DB row + docker container
// state, never log scraping.
//
// nodes:5 with fluxapps.minOutgoing lowered to 2 (a 5-node full mesh only reaches
// ~2 outbound/node — peers connect inbound first and FluxOS dedups); arcane:true
// so the node accepts content apps, runs the benchmark crypto, and opens the sealed
// content-update envelope.

// StartedAt of the app's (single) container, '' when absent. The restart vs
// signal/none distinction is whether this value moves across an update.
async function containerStartedAt(client, appName) {
  const cont = await getAppContainerStatus(client.container, appName);
  if (!cont) return '';
  const { stdout } = await execInContainer(
    client.container,
    `docker inspect --format '{{.State.StartedAt}}' ${cont.name}`,
  );
  return stdout.trim();
}

// Merged stdout+stderr of the app container (the signal fixture logs 'RELOAD <sig>'
// to stdout on the signal it catches).
async function containerLogs(client, appName) {
  const cont = await getAppContainerStatus(client.container, appName);
  if (!cont) return '';
  const { stdout, output } = await execInContainer(client.container, `docker logs ${cont.name} 2>&1`);
  return stdout || output || '';
}

describe('content slot updates (contentupdate): version advance + onUpdate reactions', function () {
  let env;

  const base = `slotupd${Date.now()}`;
  // App A drives the version-advance/FluxDrive/reconcile assertions AND the null
  // (self-watching, atomic) reaction; B is restart; C is signal (test-app fixture);
  // D (two slots) is the carry-over contract — rotating one slot attaches one file.
  const nameNull = `${base}a`;
  const nameRestart = `${base}b`;
  const nameSignal = `${base}c`;
  const nameCarry = `${base}d`;

  // App D's slot payloads: 'keep' is never rotated (carried over by hash on the
  // v2 update); 'rotate' moves v1 -> v2 with bytes attached.
  const KEEP_BYTES = Buffer.from('carry keep v1');
  const ROTATE_V1 = Buffer.from('carry rotate v1');
  const ROTATE_V2 = Buffer.from('carry rotate v2');

  // The installed node index per app (the spawner self-selects; instances:1 so
  // exactly one node runs each app and is where we POST + assert).
  const node = {};

  // App A's pre-update snapshot, captured in the advance test and reused by the
  // null-reaction test (the events are already in the persistent SSE buffer).
  let aAfterId = 0;
  let aStartedAt = '';

  async function registerSlotApp({ name, image, slots }) {
    const res = await deployContentApp(env.clients[0].url, {
      name, image, instances: 1, contentSlots: slots,
    });
    expect(res.status, `register ${name}`).to.equal('success');
    return res.data; // appHash
  }

  // instances:1 races several nodes into the install-collision election; the first
  // node to report "installed" can be a loser whose container is then torn down.
  // The assertable node is the one whose container is still running once the fleet
  // converges to exactly one — held across consecutive polls so a mid-election
  // transient can't latch.
  async function findRunningIndex(name) {
    let winner = null;
    let last = null;
    let stable = 0;
    await waitFor(
      async () => {
        const states = await Promise.all(env.clients.map((c) => isAppContainerRunning(c.container, name)));
        const running = states.flatMap((r, i) => (r ? [i] : []));
        if (running.length === 1 && running[0] === last) {
          stable += 1;
        } else {
          stable = 0;
        }
        last = running.length === 1 ? running[0] : null;
        if (stable >= 2) {
          winner = last;
          return true;
        }
        return false;
      },
      { timeout: 240000, interval: 3000, label: `${name} converged to one running instance` },
    );
    return winner;
  }

  before(async function () {
    this.timeout(600000);
    env = await createTestEnv({
      hookCtx: this, nodes: 5, tickerAutostart: false, arcane: true,
      configOverrides: { fluxapps: { minOutgoing: 2 } },
    });
    await bootAndPeer(env, { minOutbound: 2, minInbound: 2, pricing: true });
    await resetFluxDrive();

    // pause stays up for the restart/none/carry apps (we only inspect docker
    // StartedAt); the test-app fixture for the signal app (it logs RELOAD SIGHUP
    // to stdout).
    await pushImage(nameNull, 'v1');
    await pushImage(nameRestart, 'v1');
    await pushTestApp(nameSignal, 'v1');
    await pushImage(nameCarry, 'v1');

    // A null (self-watching) slot requires atomic delivery under the reserved
    // /io.runonflux/ namespace; restart/signal slots are in-place single-file binds.
    const nullHash = await registerSlotApp({
      name: nameNull,
      image: `${REGISTRY_REPO_HOST}/${nameNull}:v1`,
      slots: [{
        name: 'config', destination: '/io.runonflux/config.conf', bytes: Buffer.from('null slot v1'), onUpdate: null, atomic: true,
      }],
    });
    const restartHash = await registerSlotApp({
      name: nameRestart,
      image: `${REGISTRY_REPO_HOST}/${nameRestart}:v1`,
      slots: [{
        name: 'config', destination: '/etc/slot.conf', bytes: Buffer.from('restart slot v1'), onUpdate: { action: 'restart' },
      }],
    });
    const signalHash = await registerSlotApp({
      name: nameSignal,
      image: `${REGISTRY_REPO_HOST}/${nameSignal}:v1`,
      slots: [{
        name: 'config', destination: '/etc/slot.conf', bytes: Buffer.from('signal slot v1'), onUpdate: { action: 'signal', signal: 'SIGHUP' },
      }],
    });
    const carryHash = await registerSlotApp({
      name: nameCarry,
      image: `${REGISTRY_REPO_HOST}/${nameCarry}:v1`,
      slots: [
        {
          name: 'keep', destination: '/etc/keep.conf', bytes: KEEP_BYTES, onUpdate: { action: 'restart' },
        },
        {
          name: 'rotate', destination: '/etc/rotate.conf', bytes: ROTATE_V1, onUpdate: { action: 'restart' },
        },
      ],
    });

    // Confirm all four (one block drains the whole tx queue), then find where each
    // app landed. No running peer holds them, so the install provisions the bundled
    // v1 manifest from the FluxDrive backstop.
    await queueAppTx(nullHash);
    await queueAppTx(restartHash);
    await queueAppTx(signalHash);
    await queueAppTx(carryHash);
    await advanceBlocks(3);

    node.null = await findRunningIndex(nameNull);
    node.restart = await findRunningIndex(nameRestart);
    node.signal = await findRunningIndex(nameSignal);
    node.carry = await findRunningIndex(nameCarry);
  });

  after(async function () {
    this.timeout(30000);
    await closeDb();
    await env?.teardown();
  });

  it('applies a v2 content update: version advances, FluxDrive manifest PUTs v2, reconcile pushed', async function () {
    this.timeout(120000);
    const client = env.clients[node.null];
    aAfterId = client.getLastEventId();
    aStartedAt = await containerStartedAt(client, nameNull);

    const res = await pushContentUpdate(client.url, {
      name: nameNull, version: 2, slots: [{ name: 'config', bytes: Buffer.from('null slot v2') }],
    });
    expect(res.status).to.equal('success');

    // The submitter publishes contentUpdateApplied after it stores + gossips the v2
    // manifest, and reconcilePushed after it tells FluxDrive's GC the new live set.
    await client.waitForEvent(
      'content:contentUpdateApplied',
      (d) => d.appName === nameNull && d.version === 2,
      60000,
      { afterId: aAfterId },
    );
    const reconciled = await client.waitForEvent(
      'content:reconcilePushed',
      (d) => d.appName === nameNull && d.version === 2,
      60000,
      { afterId: aAfterId },
    );
    expect(reconciled.data.source).to.equal('slot');

    // FluxDrive's manifest backstop PUT advanced to v2 (was v1 from register).
    await waitFor(
      async () => (await getFluxDriveManifest(nameNull)).version === 2,
      { timeout: 30000, interval: 1000, label: 'FluxDrive manifest v2' },
    );

    // The GC reconcile was accepted with the slot source at v2.
    const state = await getFluxDriveState();
    const entry = state.reconciles.find((r) => r.appName === nameNull && r.source === 'slot' && r.version === 2);
    expect(entry, 'slot reconcile v2 recorded').to.exist;
    expect(entry.accepted).to.equal(true);

    // The running node's own appcontentmanifests register advanced to v2.
    const row = await dbClient(client.num).getContentManifest(nameNull);
    expect(row, 'local manifest row present').to.exist;
    expect(row.version).to.equal(2);
  });

  it('onUpdate:restart restarts the component (StartedAt moves)', async function () {
    this.timeout(120000);
    const client = env.clients[node.restart];
    const afterId = client.getLastEventId();
    const before = await containerStartedAt(client, nameRestart);
    expect(before, 'container running before update').to.not.equal('');

    const res = await pushContentUpdate(client.url, {
      name: nameRestart, version: 2, slots: [{ name: 'config', bytes: Buffer.from('restart slot v2') }],
    });
    expect(res.status).to.equal('success');

    const applied = await client.waitForEvent(
      'content:slotApplied',
      (d) => d.appName === nameRestart && d.version === 2,
      60000,
      { afterId },
    );
    expect(applied.data.reaction).to.equal('restart');

    // The restart reaction recreated/restarted the container, so its StartedAt moved
    // and it is running again.
    await waitFor(
      async () => {
        const now = await containerStartedAt(client, nameRestart);
        return now !== '' && now !== before;
      },
      { timeout: 60000, interval: 2000, label: 'restart app StartedAt moved' },
    );
  });

  it('onUpdate:signal SIGHUPs the component without restarting it (StartedAt unchanged)', async function () {
    this.timeout(120000);
    const client = env.clients[node.signal];
    const afterId = client.getLastEventId();
    const before = await containerStartedAt(client, nameSignal);
    expect(before, 'container running before update').to.not.equal('');

    const res = await pushContentUpdate(client.url, {
      name: nameSignal, version: 2, slots: [{ name: 'config', bytes: Buffer.from('signal slot v2') }],
    });
    expect(res.status).to.equal('success');

    const applied = await client.waitForEvent(
      'content:slotApplied',
      (d) => d.appName === nameSignal && d.version === 2,
      60000,
      { afterId },
    );
    expect(applied.data.reaction).to.equal('signal');

    // The fixture logs 'RELOAD SIGHUP' on the signal it catches.
    await waitFor(
      async () => (await containerLogs(client, nameSignal)).includes('RELOAD SIGHUP'),
      { timeout: 30000, interval: 1500, label: 'RELOAD SIGHUP in container logs' },
    );

    // Exactly ONE delivery: the submitter's own apply and the gossip echo of the
    // same manifest must not both fire the reaction. Settle briefly so a straggling
    // duplicate would have landed before we count.
    await new Promise((resolve) => { setTimeout(resolve, 5000); });
    const logs = await containerLogs(client, nameSignal);
    const deliveries = logs.split('RELOAD SIGHUP').length - 1;
    expect(deliveries, 'SIGHUP delivered exactly once').to.equal(1);

    // A signal is not a restart: the same container kept running, StartedAt unchanged.
    const after = await containerStartedAt(client, nameSignal);
    expect(after).to.equal(before);
  });

  it('onUpdate:null applies the slot with no reaction and no restart', async function () {
    this.timeout(60000);
    const client = env.clients[node.null];

    // App A's v2 update happened in the advance test; the null slot's reaction event
    // is already in the persistent SSE buffer, found via the snapshot afterId.
    const applied = await client.waitForEvent(
      'content:slotApplied',
      (d) => d.appName === nameNull && d.version === 2,
      30000,
      { afterId: aAfterId },
    );
    expect(applied.data.reaction).to.equal('none');

    // A null (self-watching) reaction never touches the container: StartedAt is the
    // same as before the v2 update.
    const after = await containerStartedAt(client, nameNull);
    expect(after).to.equal(aStartedAt);
  });

  it('rejects a content update whose version is not newer than the stored one', async function () {
    this.timeout(60000);
    const client = env.clients[node.null];
    // App A is at v2 (from the advance test); a version <= current must be refused.
    const res = await pushContentUpdate(client.url, {
      name: nameNull, version: 1, slots: [{ name: 'config', bytes: Buffer.from('null slot stale') }],
    });
    expect(res.status).to.equal('error');

    // The stored manifest stayed at v2 (the stale push changed nothing).
    const row = await dbClient(client.num).getContentManifest(nameNull);
    expect(row.version).to.equal(2);
  });

  it('carry-over: rotating one slot of two attaches one file (one upload, one presence HEAD)', async function () {
    this.timeout(120000);
    const client = env.clients[node.carry];
    const afterId = client.getLastEventId();

    const owner = appOwnerKey().zelid;
    const locatorOf = (bytes) => benchCrypto.locatorFor({ appName: nameCarry, fluxID: owner, contentHash: blobHash(bytes) });
    const keepLocator = locatorOf(KEEP_BYTES);
    const rotateV1Locator = locatorOf(ROTATE_V1);
    const rotateV2Locator = locatorOf(ROTATE_V2);

    // Pre-update snapshot: the register delivered both slots' blobs. The HEAD
    // probe log is counted from here so only this update's probes are attributed.
    const beforeState = await getFluxDriveState();
    const beforeBlobs = beforeState.blobs.filter((b) => b.appName === nameCarry);
    expect(beforeBlobs.map((b) => b.locator).sort()).to.deep.equal([keepLocator, rotateV1Locator].sort());
    const headsBefore = beforeState.heads.length;
    const keepBefore = beforeBlobs.find((b) => b.locator === keepLocator);

    // v2 rotates 'rotate' (bytes attached + owner-signed) and carries 'keep'
    // over by hash — no bytes, no signature for the unchanged file.
    const res = await pushContentUpdate(client.url, {
      name: nameCarry,
      version: 2,
      slots: [
        { name: 'keep', hash: blobHash(KEEP_BYTES) },
        { name: 'rotate', bytes: ROTATE_V2 },
      ],
    });
    expect(res.status).to.equal('success');

    await client.waitForEvent(
      'content:contentUpdateApplied',
      (d) => d.appName === nameCarry && d.version === 2,
      60000,
      { afterId },
    );
    await client.waitForEvent(
      'content:reconcilePushed',
      (d) => d.appName === nameCarry && d.version === 2,
      60000,
      { afterId },
    );

    const state = await getFluxDriveState();

    // Exactly ONE upload: the rotated slot's v2 ciphertext is the only new locator.
    const after = state.blobs.filter((b) => b.appName === nameCarry);
    expect(after.map((b) => b.locator).sort()).to.deep.equal(
      [keepLocator, rotateV1Locator, rotateV2Locator].sort(),
    );

    // Exactly ONE presence probe: the carried slot's locator, found in storage.
    const probes = state.heads.slice(headsBefore);
    expect(probes.length, 'one HEAD presence probe').to.equal(1);
    expect(probes[0].locator).to.equal(keepLocator);
    expect(probes[0].found).to.equal(true);

    // The carried blob was presence-checked, not re-uploaded: its stored entry
    // is the register-time row verbatim (same timestamp and sigs), still live.
    const keepAfter = after.find((b) => b.locator === keepLocator);
    expect(keepAfter).to.deep.equal(keepBefore);

    // The GC reconcile carries the FULL v2 live set (carried + rotated); the
    // superseded rotate-v1 blob is tombstoned, the carried blob is not.
    const rec = state.reconciles.find((r) => r.appName === nameCarry && r.source === 'slot' && r.version === 2);
    expect(rec, 'slot reconcile v2 recorded').to.exist;
    expect(rec.accepted).to.equal(true);
    expect([...rec.liveLocators].sort()).to.deep.equal([keepLocator, rotateV2Locator].sort());
    expect(after.find((b) => b.locator === rotateV1Locator).tombstoned).to.equal(true);

    // The running node's manifest register advanced to v2.
    const row = await dbClient(client.num).getContentManifest(nameCarry);
    expect(row.version).to.equal(2);
  });

  it('rejects a carried-over hash the previous version never delivered', async function () {
    this.timeout(60000);
    const client = env.clients[node.carry];

    // v3 declares 'rotate' by a hash no prior version delivered, with no bytes
    // attached: fail-closed with the precise attach-the-bytes reject — carry-over
    // is scoped to the immediately previous version, never "any hash ever seen".
    const res = await pushContentUpdate(client.url, {
      name: nameCarry,
      version: 3,
      slots: [
        { name: 'keep', hash: blobHash(KEEP_BYTES) },
        { name: 'rotate', hash: blobHash(Buffer.from('carry rotate v3 never uploaded')) },
      ],
    });
    expect(res.status).to.equal('error');
    expect(res.data.message).to.include('missing blob part');

    // Nothing advanced, nothing uploaded: register + one rotation = 3 blobs,
    // manifest still v2.
    const state = await getFluxDriveState();
    expect(state.blobs.filter((b) => b.appName === nameCarry).length).to.equal(3);
    const row = await dbClient(client.num).getContentManifest(nameCarry);
    expect(row.version).to.equal(2);
  });
});
