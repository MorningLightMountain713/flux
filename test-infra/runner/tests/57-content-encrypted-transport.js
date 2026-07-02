import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { deployContentApp, pushContentUpdate } from '../framework/content-helper.js';
import { blobHash } from '../framework/content-crypto-v9.js';
import { resetFluxDrive } from '../framework/fluxdrive-control.js';
import { pushImage, pushBusybox } from '../framework/registry-helper.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
import { waitForAppInstalled, waitFor } from '../framework/wait.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { dbClient } from '../framework/db-client.js';
import { readFileInContainer, statFileInContainer, inodeInContainer } from '../framework/container.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

// The HPKE capstone for v9 content delivery. Every content app the harness deploys
// is ALWAYS transport-encrypted (the sparse spec is HPKE-sealed toward the node's
// per-app transport key and opened locally via the benchmark channel) AND encrypted
// at rest (isEncrypted = wasTransportEncrypted, so the stored spec is backend-sealed).
// This suite proves the full crypto round-trip end to end:
//   1. a transport-encrypted spec opens locally and installs (the node opened the
//      envelope + the contentHash bound the decrypted canonical, else register fails);
//   2. an encrypted slot app's gossip manifest is sealed at rest (slots = { sealed },
//      no plaintext hashes) yet the running app still opens + applies the cleartext;
//   3. a 2-component dependsOn app with 1 contentRef + 2 contentSlots (atomic/signal
//      under /io.runonflux/ + in-place/restart) provisions, applies, reacts, and
//      honours start ordering — the atomic-vs-in-place inode behaviour included.
// Assertions are SSE events + real state (FluxDrive-backed install, appcontentmanifests
// rows, in-container cat/stat/inode), never log scraping.
//
// nodes:5 with fluxapps.minOutgoing lowered to 2 (a 5-node full mesh only reaches
// ~2 outbound/node — peers connect inbound first and FluxOS dedups); arcane:true is required
// for content/encrypted apps and the benchmark crypto.

describe('content encrypted transport (HPKE capstone): open, seal-at-rest, multi-component', function () {
  let env;
  dumpLogsOnFailure(() => env);

  const stamp = Date.now();
  // App names: lowercase-alnum (also used verbatim as registry repo names).
  const transportApp = `enctr${stamp}`;
  const sealApp = `encsl${stamp}`;
  const capApp = `enccap${stamp}`;
  const capDepRepo = `${capApp}d`; // the dependency component's image repo

  before(async function () {
    this.timeout(480000);
    env = await createTestEnv({
      hookCtx: this, nodes: 5, tickerAutostart: false, arcane: true,
      configOverrides: { fluxapps: { minOutgoing: 2 } },
    });
    await bootAndPeer(env, { minOutbound: 2, minInbound: 2, pricing: true });
    // transportApp: pause (no in-container inspection). sealApp + capApp(web): busybox
    // (cat/stat/inode). capApp(dep): pause (the dependsOn target, stays up).
    await pushImage(transportApp, 'v1');
    await pushBusybox(sealApp, 'v1');
    await pushBusybox(capApp, 'v1');
    await pushImage(capDepRepo, 'v1');
    await resetFluxDrive();
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('opens a transport-encrypted spec locally and installs (contentHash binds the decrypted canonical)', async function () {
    this.timeout(240000);
    const submitNode = env.clients[0];
    const refBytes = Buffer.from('transport-encrypted contentref payload v1');

    // deployContentApp HPKE-seals the sparse spec toward the node's transport key;
    // register only succeeds if the node opened that envelope AND the signed
    // contentHash matched the decrypted canonical (a mismatch throws DECRYPT_FAILED).
    const res = await deployContentApp(submitNode.url, {
      name: transportApp,
      image: `${REGISTRY_REPO_HOST}/${transportApp}:v1`,
      contentRef: refBytes,
    });
    expect(res.status, JSON.stringify(res)).to.equal('success');
    expect(res.contentHash).to.be.a('string').with.length.greaterThan(0);
    const appHash = res.data;

    // Confirm on-chain → the spawner self-selects a node and provisions the blob from
    // the FluxDrive backstop (no running peer holds it yet). A blobProvisioned event
    // means the opened spec's contentRef hash drove a real, hash-verified fetch.
    const beforeIds = env.clients.map((c) => c.getLastEventId());
    await queueAppTx(appHash);
    await advanceBlocks(3);

    const installedIndex = await Promise.any(env.clients.map(async (c, i) => {
      await waitForAppInstalled(c, transportApp, 200000);
      return i;
    }));
    const node = env.clients[installedIndex];

    const resolved = await node.waitForEvent(
      'content:blobResolved',
      (d) => d.appName === transportApp,
      60000,
      { afterId: beforeIds[installedIndex] },
    );
    expect(resolved.data.source).to.equal('fluxdrive');
    await node.waitForEvent(
      'content:blobProvisioned',
      (d) => d.appName === transportApp,
      60000,
      { afterId: beforeIds[installedIndex] },
    );

    // The opened spec is the one that installed: it is in this node's installed set.
    const installed = await node.getInstalledApps();
    expect(installed.status).to.equal('success');
    expect(installed.data.find((a) => a.name === transportApp), 'app not installed').to.exist;
  });

  it('seals the encrypted slot app manifest at rest (slots not plaintext) yet still applies the cleartext', async function () {
    this.timeout(240000);
    const submitNode = env.clients[0];
    const slotV1 = Buffer.from('encrypted-slot-content-v1');
    const slotV2 = Buffer.from('encrypted-slot-content-v2');
    const SLOT_DEST = '/etc/app.conf';

    // A single-component busybox slot app (in-place, restart-on-update). The harness
    // bundles the initial owner-signed manifest; the node seals its slots at rest
    // (the app is encrypted) before storing + gossiping.
    const res = await deployContentApp(submitNode.url, {
      name: sealApp,
      image: `${REGISTRY_REPO_HOST}/${sealApp}:v1`,
      contentSlots: [{
        name: 'cfg', destination: SLOT_DEST, source: 'cfgsrc', onUpdate: { action: 'restart' }, atomic: false, bytes: slotV1,
      }],
    });
    expect(res.status, JSON.stringify(res)).to.equal('success');
    const appHash = res.data;

    await queueAppTx(appHash);
    await advanceBlocks(3);
    const installedIndex = await Promise.any(env.clients.map(async (c, i) => {
      await waitForAppInstalled(c, sealApp, 200000);
      return i;
    }));
    const node = env.clients[installedIndex];
    const dbc = dbClient(installedIndex + 1);

    // The stored gossip manifest (v1) carries SEALED slots — no plaintext hash leaks —
    // while appName/version stay cleartext (the owner signed the plaintext form).
    let row;
    await waitFor(async () => {
      row = await dbc.getContentManifest(sealApp);
      return !!(row && row.data && row.data.manifest && row.confirmed !== false);
    }, { timeout: 30000, interval: 1000, label: 'confirmed sealed manifest v1' });
    const v1Slots = row.data.manifest.slots;
    expect(v1Slots, 'manifest slots').to.have.property('sealed');
    expect(JSON.stringify(v1Slots), 'no plaintext hash in sealed slots').to.not.include('sha256:');
    expect(row.data.manifest.appName).to.equal(sealApp);
    expect(row.data.manifest.version).to.equal(1);

    // The running app still got the cleartext: the node opened the sealed manifest at
    // provision time and wrote the plaintext slot content into the container.
    await waitFor(async () => {
      const r = await readFileInContainer(node.container, sealApp, 'web', SLOT_DEST);
      return r.exitCode === 0 && r.content.includes('encrypted-slot-content-v1');
    }, { timeout: 90000, interval: 2000, label: 'in-container slot content v1' });

    // Push a content update (v2). The node opens the new sealed manifest, re-seals it
    // at rest, applies the cleartext to the running app, and emits slotApplied.
    const afterId = node.getLastEventId();
    const up = await pushContentUpdate(node.url, {
      name: sealApp, version: 2, slots: [{ name: 'cfg', bytes: slotV2 }],
    });
    expect(up.status, JSON.stringify(up)).to.equal('success');

    const applied = await node.waitForEvent(
      'content:slotApplied',
      (d) => d.appName === sealApp && d.version === 2,
      120000,
      { afterId },
    );
    expect(applied.data.reaction).to.equal('restart');
    await node.waitForEvent(
      'content:contentUpdateApplied',
      (d) => d.appName === sealApp && d.version === 2,
      30000,
      { afterId },
    );

    // v2 is STILL sealed at rest...
    let row2;
    await waitFor(async () => {
      row2 = await dbc.getContentManifest(sealApp);
      return !!(row2 && row2.version === 2 && row2.data && row2.data.manifest);
    }, { timeout: 30000, interval: 1000, label: 'stored manifest v2' });
    expect(row2.data.manifest.slots, 'v2 slots still sealed').to.have.property('sealed');
    expect(JSON.stringify(row2.data.manifest.slots)).to.not.include('sha256:');

    // ...yet the running app applied the v2 cleartext (open round-trip end to end).
    await waitFor(async () => {
      const r = await readFileInContainer(node.container, sealApp, 'web', SLOT_DEST);
      return r.exitCode === 0 && r.content.includes('encrypted-slot-content-v2');
    }, { timeout: 90000, interval: 2000, label: 'in-container slot content v2' });
  });

  it('provisions, applies and reacts for a 2-component dependsOn app (contentRef + atomic/in-place slots)', async function () {
    this.timeout(360000);
    const submitNode = env.clients[0];

    const refBytes = Buffer.from('capstone-contentref-v1');
    const inplaceV1 = Buffer.from('inplace-slot-v1');
    const inplaceV2 = Buffer.from('inplace-slot-v2');
    const atomicV1 = Buffer.from('atomic-slot-v1');
    const atomicV2 = Buffer.from('atomic-slot-v2');
    const refHash = blobHash(refBytes);

    const REF_DEST = '/etc/ref.conf';
    const INPLACE_DEST = '/etc/inplace.conf';
    const ATOMIC_DEST = '/io.runonflux/atomic.conf';

    // Component A (web, busybox, INSPECTED) carries the contentRef + both slots and
    // dependsOn B (dep, pause). Both slots live on A so the inode behaviour of each
    // is inspectable on the same busybox container. The atomic slot lives under the
    // reserved /io.runonflux/ namespace (validation requires it); the in-place slot
    // must NOT. A's single applyManifest reaction is restart (restart subsumes the
    // signal slot's reaction per the documented "restart > signal > none" rule — see
    // the return note: a distinct signal reaction needs the slots split across
    // components, which would forfeit inode-inspecting the atomic file).
    const components = {
      dep: {
        name: 'dep',
        description: 'dependsOn target',
        image: `${REGISTRY_REPO_HOST}/${capDepRepo}:v1`,
        cpu: 0.5,
        memory: 200,
        rootFsGb: 2,
        swapGb: 0,
        persistentStorage: {
          sizeGb: 1,
          mounts: { '/data': { source: 'depdata', destination: '/data' } },
        },
      },
      web: {
        name: 'web',
        description: 'content component (depends on dep)',
        image: `${REGISTRY_REPO_HOST}/${capApp}:v1`,
        cpu: 0.5,
        memory: 300,
        rootFsGb: 2,
        swapGb: 0,
        persistentStorage: {
          sizeGb: 1,
          mounts: {
            '/data': { source: 'webdata', destination: '/data' },
            [REF_DEST]: {
              source: 'refconf', destination: REF_DEST, type: 'file', contentRef: { hash: refHash },
            },
            [INPLACE_DEST]: {
              source: 'inplaceconf', destination: INPLACE_DEST, type: 'file', contentSlot: 'inplace', onUpdate: { action: 'restart' }, atomic: false,
            },
            [ATOMIC_DEST]: {
              source: 'atomicconf', destination: ATOMIC_DEST, type: 'file', contentSlot: 'atomic', onUpdate: { action: 'signal', signal: 'SIGHUP' }, atomic: true,
            },
          },
        },
        dependsOn: { dep: { condition: 'started' } },
      },
    };

    const res = await deployContentApp(submitNode.url, {
      name: capApp,
      image: `${REGISTRY_REPO_HOST}/${capApp}:v1`,
      components,
      contentRef: refBytes,
      contentSlots: [
        {
          name: 'inplace', destination: INPLACE_DEST, source: 'inplaceconf', onUpdate: { action: 'restart' }, atomic: false, bytes: inplaceV1,
        },
        {
          name: 'atomic', destination: ATOMIC_DEST, source: 'atomicconf', onUpdate: { action: 'signal', signal: 'SIGHUP' }, atomic: true, bytes: atomicV1,
        },
      ],
    });
    expect(res.status, JSON.stringify(res)).to.equal('success');
    const appHash = res.data;

    const beforeIds = env.clients.map((c) => c.getLastEventId());
    await queueAppTx(appHash);
    await advanceBlocks(3);
    const installedIndex = await Promise.any(env.clients.map(async (c, i) => {
      await waitForAppInstalled(c, capApp, 240000);
      return i;
    }));
    const node = env.clients[installedIndex];
    const afterInstall = beforeIds[installedIndex];

    // contentRef provisioned (hash-verified) from the FluxDrive backstop at install.
    await node.waitForEvent(
      'content:blobProvisioned',
      (d) => d.appName === capApp,
      90000,
      { afterId: afterInstall },
    );

    // dependsOn ordering: the reconciler holds web at awaitingDependency until dep is
    // running, so dep's firstStart precedes web's (event ids are monotonic). Match
    // either action name (the reconciler refactor renamed 'started' -> 'firstStart').
    const startMatch = (id) => (d) => d.identifier === id && (d.action === 'firstStart' || d.action === 'started');
    const depStart = await node.waitForEvent('reconciler:actuated', startMatch(`dep_${capApp}`), 120000, { afterId: afterInstall });
    const webStart = await node.waitForEvent('reconciler:actuated', startMatch(`web_${capApp}`), 120000, { afterId: afterInstall });
    expect(depStart.id, 'dep must start before web (dependsOn)').to.be.lessThan(webStart.id);

    // Install-time content landed (web is up now): every injected file is the cleartext
    // and root:root 0444 (injected content is read-only, never world-writable).
    const expectInjected = async (dest, expectedSubstr, label) => {
      await waitFor(async () => {
        const r = await readFileInContainer(node.container, capApp, 'web', dest);
        return r.exitCode === 0 && r.content.includes(expectedSubstr);
      }, { timeout: 90000, interval: 2000, label });
      const st = await statFileInContainer(node.container, capApp, 'web', dest);
      expect(st.mode, `${label} mode`).to.equal('444');
      expect(st.uid, `${label} uid`).to.equal('0');
      expect(st.gid, `${label} gid`).to.equal('0');
    };
    await expectInjected(REF_DEST, 'capstone-contentref-v1', 'contentRef');
    await expectInjected(INPLACE_DEST, 'inplace-slot-v1', 'in-place slot v1');
    await expectInjected(ATOMIC_DEST, 'atomic-slot-v1', 'atomic slot v1');

    // Inode baseline (host inodes, exposed through the binds).
    const inplaceInode0 = await inodeInContainer(node.container, capApp, 'web', INPLACE_DEST);
    const atomicInode0 = await inodeInContainer(node.container, capApp, 'web', ATOMIC_DEST);
    expect(inplaceInode0, 'in-place inode present').to.be.a('number');
    expect(atomicInode0, 'atomic inode present').to.be.a('number');

    // Push a content update (v2) for both slots. web reacts once (restart, subsuming
    // the atomic slot's signal); contentUpdateApplied confirms the full pipeline.
    const afterUpdate = node.getLastEventId();
    const up = await pushContentUpdate(node.url, {
      name: capApp,
      version: 2,
      slots: [{ name: 'inplace', bytes: inplaceV2 }, { name: 'atomic', bytes: atomicV2 }],
    });
    expect(up.status, JSON.stringify(up)).to.equal('success');

    const applied = await node.waitForEvent(
      'content:slotApplied',
      (d) => d.appName === capApp && d.version === 2,
      120000,
      { afterId: afterUpdate },
    );
    expect(applied.data.reaction, 'restart subsumes the signal slot on the same component').to.equal('restart');
    await node.waitForEvent(
      'content:contentUpdateApplied',
      (d) => d.appName === capApp && d.version === 2,
      30000,
      { afterId: afterUpdate },
    );

    // Both files now hold v2 (the container restarted and re-read the binds).
    await waitFor(async () => {
      const r = await readFileInContainer(node.container, capApp, 'web', INPLACE_DEST);
      return r.exitCode === 0 && r.content.includes('inplace-slot-v2');
    }, { timeout: 90000, interval: 2000, label: 'in-place slot v2' });
    await waitFor(async () => {
      const r = await readFileInContainer(node.container, capApp, 'web', ATOMIC_DEST);
      return r.exitCode === 0 && r.content.includes('atomic-slot-v2');
    }, { timeout: 90000, interval: 2000, label: 'atomic slot v2' });

    // The delivery-mechanism inode contract: an atomic slot (managed parent-dir temp
    // +rename) changes inode across the update; an in-place single-file bind overwrite
    // keeps the same inode (the inode-pinning property of a single-file bind).
    const inplaceInode1 = await inodeInContainer(node.container, capApp, 'web', INPLACE_DEST);
    const atomicInode1 = await inodeInContainer(node.container, capApp, 'web', ATOMIC_DEST);
    expect(inplaceInode1, 'in-place inode present after update').to.be.a('number');
    expect(atomicInode1, 'atomic inode present after update').to.be.a('number');
    expect(inplaceInode1, 'in-place single-file bind keeps its inode').to.equal(inplaceInode0);
    expect(atomicInode1, 'atomic delivery swaps the inode').to.not.equal(atomicInode0);
  });
});
