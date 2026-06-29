import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { deployContentApp, pushContentUpdate } from '../framework/content-helper.js';
import { getFluxDriveState, getFluxDriveManifest, resetFluxDrive } from '../framework/fluxdrive-control.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
import { waitForAppInstalled, waitForUp } from '../framework/wait.js';
import {
  readFileInContainer, statFileInContainer, inodeInContainer, assertNodeRunsAsRoot,
} from '../framework/container.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

// Content slots + bind mounting: the mutable half of v9 content delivery. Proves
// the owner-signed manifest is recorded/backstopped at register, the declared slot
// content is injected into the container at install (peers-first, FluxDrive
// backstop), the injected-file permission model (root:root 0444 default, data
// mounts stay 777, per-mount uid/gid/mode override), and the two delivery axes —
// an atomic:false single-file bind overwritten in place (inode pinned) vs an
// atomic:true managed-dir swap under /io.runonflux/ (inode replaced, torn-safe).
//
// Inspected components run the static-busybox fixture so the host (the DinD node)
// can `docker exec /bin/busybox cat|stat` into them. nodes:5 so the submission's
// minOutgoing>=4 peer gate is satisfiable; arcane:true so the node accepts the
// encrypted/content app and runs the benchmark-channel crypto. Asserts on the SSE
// bus + the FluxDrive stub state + container inspectors, never log scraping.

describe('content slots + bind mounting: manifest, injection, perms, atomic delivery', function () {
  let env;
  dumpLogsOnFailure(() => env);

  const SUITE = `slots${Date.now()}`;
  const baseApp = `${SUITE}base`;
  const inplaceApp = `${SUITE}inplace`;
  const atomicApp = `${SUITE}atomic`;

  // base app slots: a default-perms restart slot + a uid/gid/mode-override slot.
  const CONF_DEST = '/etc/app.conf';
  const CONF_BYTES = Buffer.from('base-conf-payload-v1');
  const OWNED_DEST = '/etc/owned.conf';
  const OWNED_BYTES = Buffer.from('base-owned-payload-v1');

  // single-file (atomic:false) bind, overwritten in place across an update.
  const INPLACE_DEST = '/etc/inplace.conf';
  const INPLACE_V1 = Buffer.from('inplace-content-version-one');
  const INPLACE_V2 = Buffer.from('inplace-content-version-two-rewritten-in-place');

  // atomic:true managed-dir slot under the reserved namespace, swapped across an update.
  const ATOMIC_DEST = '/io.runonflux/atomic.conf';
  const ATOMIC_V1 = Buffer.from('atomic-content-version-one');
  const ATOMIC_V2 = Buffer.from('atomic-content-version-two-swapped-atomically');

  let baseClient;
  let inplaceClient;
  let atomicClient;
  let rootGate;
  let baseManifestAfterId;

  before(async function () {
    this.timeout(720000);
    env = await createTestEnv({
      hookCtx: this, nodes: 5, tickerAutostart: false, arcane: true,
    });
    await bootAndPeer(env);
    await Promise.all([
      pushBusybox(baseApp, 'v1'),
      pushBusybox(inplaceApp, 'v1'),
      pushBusybox(atomicApp, 'v1'),
    ]);
    await resetFluxDrive();

    const node = env.clients[0];

    // Capture the event cursor BEFORE the base register so the synchronous
    // manifestStored emitted in the submission path is attributable to it.
    baseManifestAfterId = node.getLastEventId();
    const baseRes = await deployContentApp(node.url, {
      name: baseApp,
      image: `${REGISTRY_REPO_HOST}/${baseApp}:v1`,
      instances: 1,
      contentSlots: [
        { name: 'baseconf', destination: CONF_DEST, bytes: CONF_BYTES, onUpdate: { action: 'restart' } },
        {
          name: 'baseowned', destination: OWNED_DEST, bytes: OWNED_BYTES, onUpdate: { action: 'restart' }, uid: 1000, gid: 1000, mode: '0640',
        },
      ],
    });
    expect(baseRes.status, 'base register').to.equal('success');

    const inplaceRes = await deployContentApp(node.url, {
      name: inplaceApp,
      image: `${REGISTRY_REPO_HOST}/${inplaceApp}:v1`,
      instances: 1,
      contentSlots: [
        {
          name: 'inplaceslot', destination: INPLACE_DEST, bytes: INPLACE_V1, onUpdate: { action: 'restart' }, atomic: false,
        },
      ],
    });
    expect(inplaceRes.status, 'inplace register').to.equal('success');

    const atomicRes = await deployContentApp(node.url, {
      name: atomicApp,
      image: `${REGISTRY_REPO_HOST}/${atomicApp}:v1`,
      instances: 1,
      contentSlots: [
        {
          name: 'atomicslot', destination: ATOMIC_DEST, bytes: ATOMIC_V1, onUpdate: null, atomic: true,
        },
      ],
    });
    expect(atomicRes.status, 'atomic register').to.equal('success');

    // Confirm all three on-chain so the spawner self-selects an installer for each;
    // with no running peer the slots/manifest resolve from the FluxDrive backstop.
    await queueAppTx(baseRes.data);
    await queueAppTx(inplaceRes.data);
    await queueAppTx(atomicRes.data);
    await advanceBlocks(3);

    const pick = (name) => Promise.any(env.clients.map(async (c, i) => {
      await waitForAppInstalled(c, name, 240000);
      return i;
    }));
    const [bi, ii, ai] = await Promise.all([pick(baseApp), pick(inplaceApp), pick(atomicApp)]);
    baseClient = env.clients[bi];
    inplaceClient = env.clients[ii];
    atomicClient = env.clients[ai];

    // Containers must be running for the docker-exec inspectors to reach in.
    await waitForUp(baseClient, baseApp, 'base container up');
    await waitForUp(inplaceClient, inplaceApp, 'inplace container up');
    await waitForUp(atomicClient, atomicApp, 'atomic container up');

    // ROOT gate: every injected write does chown root:root + chmod, which only
    // works if FluxOS runs as uid 0 in the DinD container. Capture once here.
    rootGate = await assertNodeRunsAsRoot(baseClient.container);
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('runs FluxOS as root so injected content can be chowned/chmod-locked', function () {
    expect(rootGate.fluxosUid, 'FluxOS process uid').to.equal('0');
    expect(rootGate.rootOpsOk, 'root chown+chmod on the appdata volume').to.equal(true);
  });

  it('records the initial manifest at version 1, backstops it to FluxDrive, and pushes no reconcile', async function () {
    this.timeout(60000);
    const ev = await env.clients[0].waitForEvent(
      'content:manifestStored',
      (d) => d.appName === baseApp && d.version === 1,
      60000,
      { afterId: baseManifestAfterId },
    );
    expect(ev.data.version).to.equal(1);

    // The register-time backstop PUT lands the gossip-form manifest in FluxDrive
    // (the cold-start manifest source for the first, peerless installer).
    const fd = await getFluxDriveManifest(baseApp);
    expect(fd.version, 'FluxDrive backstop manifest version').to.equal(1);
    expect(fd.manifest.appName).to.equal(baseApp);

    // Version 1 supersedes nothing, so reconcileSlots is a deliberate no-op — no
    // GC reconcile is pushed for the app at register.
    const state = await getFluxDriveState();
    const slotReconciles = state.reconciles.filter((r) => r.appName === baseApp);
    expect(slotReconciles, 'no reconcile at register (v1 supersedes nothing)').to.have.lengthOf(0);
  });

  it('injects each declared slot file into the container at install time', async function () {
    this.timeout(60000);
    const conf = await readFileInContainer(baseClient.container, baseApp, 'web', CONF_DEST);
    expect(conf.exitCode).to.equal(0);
    expect(conf.content.trim()).to.equal(CONF_BYTES.toString());

    const owned = await readFileInContainer(baseClient.container, baseApp, 'web', OWNED_DEST);
    expect(owned.exitCode).to.equal(0);
    expect(owned.content.trim()).to.equal(OWNED_BYTES.toString());
  });

  it('locks injected slot files to root:root 0444 while data dir mounts stay world-writable (777)', async function () {
    this.timeout(60000);
    const slotPerms = await statFileInContainer(baseClient.container, baseApp, 'web', CONF_DEST);
    expect(slotPerms.uid, 'injected slot uid').to.equal('0');
    expect(slotPerms.gid, 'injected slot gid').to.equal('0');
    expect(slotPerms.mode, 'injected slot mode').to.equal('444');

    // The default /data directory mount (no per-mount perms) keeps today's
    // world-writable behaviour — content perms must not regress it.
    const dataPerms = await statFileInContainer(baseClient.container, baseApp, 'web', '/data');
    expect(dataPerms.mode, 'data dir mount mode').to.equal('777');
  });

  it('applies per-mount uid/gid/mode overrides to an injected slot file', async function () {
    this.timeout(60000);
    const perms = await statFileInContainer(baseClient.container, baseApp, 'web', OWNED_DEST);
    expect(perms.uid, 'overridden uid').to.equal('1000');
    expect(perms.gid, 'overridden gid').to.equal('1000');
    expect(perms.mode, 'overridden mode').to.equal('640');
  });

  it('overwrites an atomic:false single-file bind in place — inode preserved, content replaced', async function () {
    this.timeout(180000);
    const before = await inodeInContainer(inplaceClient.container, inplaceApp, 'web', INPLACE_DEST);
    expect(before, 'install-time slot inode').to.be.a('number');

    const afterId = inplaceClient.getLastEventId();
    const res = await pushContentUpdate(inplaceClient.url, {
      name: inplaceApp,
      version: 2,
      slots: [{ name: 'inplaceslot', bytes: INPLACE_V2 }],
    });
    expect(res.status, 'content update').to.equal('success');

    const ev = await inplaceClient.waitForEvent(
      'content:slotApplied',
      (d) => d.appName === inplaceApp && d.version === 2,
      120000,
      { afterId },
    );
    expect(ev.data.reaction, 'onUpdate restart reaction').to.equal('restart');

    await waitForUp(inplaceClient, inplaceApp, 'inplace back up after restart');

    const after = await inodeInContainer(inplaceClient.container, inplaceApp, 'web', INPLACE_DEST);
    expect(after, 'in-place overwrite keeps the same inode (single-file bind is inode-pinned)').to.equal(before);

    const content = await readFileInContainer(inplaceClient.container, inplaceApp, 'web', INPLACE_DEST);
    expect(content.content.trim()).to.equal(INPLACE_V2.toString());
  });

  it('atomically swaps an atomic:true slot under /io.runonflux/ — inode changes, full new content, no restart', async function () {
    this.timeout(180000);
    const before = await inodeInContainer(atomicClient.container, atomicApp, 'web', ATOMIC_DEST);
    expect(before, 'install-time atomic slot inode').to.be.a('number');

    const afterId = atomicClient.getLastEventId();
    const res = await pushContentUpdate(atomicClient.url, {
      name: atomicApp,
      version: 2,
      slots: [{ name: 'atomicslot', bytes: ATOMIC_V2 }],
    });
    expect(res.status, 'content update').to.equal('success');

    const ev = await atomicClient.waitForEvent(
      'content:slotApplied',
      (d) => d.appName === atomicApp && d.version === 2,
      120000,
      { afterId },
    );
    // Self-watching slot (onUpdate null) — the managed atomic swap is torn-safe, so
    // there is no container reaction.
    expect(ev.data.reaction, 'self-watch reaction').to.equal('none');

    const after = await inodeInContainer(atomicClient.container, atomicApp, 'web', ATOMIC_DEST);
    expect(after, 'atomic temp+rename allocates a new inode').to.be.a('number');
    expect(after, 'managed-dir swap replaces the inode').to.not.equal(before);

    const content = await readFileInContainer(atomicClient.container, atomicApp, 'web', ATOMIC_DEST);
    expect(content.content.trim()).to.equal(ATOMIC_V2.toString());
  });
});
