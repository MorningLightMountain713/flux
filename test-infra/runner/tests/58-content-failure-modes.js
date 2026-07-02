import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { deployContentApp, pushContentUpdate } from '../framework/content-helper.js';
import {
  getFluxDriveState, setFluxDriveMode, resetFluxDrive,
} from '../framework/fluxdrive-control.js';
import { pushImage } from '../framework/registry-helper.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
import { waitForAppInstalled, assertNoEvent } from '../framework/wait.js';
import { dbClient, closeDb } from '../framework/db-client.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

// Content-delivery FAILURE modes: the negative paths the happy-path suites
// (51/53/54) don't cover. Four independent scenarios, all asserted on the SSE
// event bus + the /apps/appregister|contentupdate response status + the FluxDrive
// stub state + the appcontentmanifests DB row — never log scraping:
//   1. a non-arcane (legacy) node refuses to spawn an encrypted/content app while
//      the arcane nodes install it;
//   2. a FluxDrive 5xx aborts the synchronous content-blob upload, so the register
//      fails — and succeeds once FluxDrive recovers;
//   3. a content update whose version is not newer than the stored one is rejected,
//      leaving the stored manifest untouched;
//   4. the best-effort FluxDrive manifest-backstop PUT failing is swallowed — the
//      content update still succeeds (gossip is primary).
//
// nodes:5 with fluxapps.minOutgoing lowered to 2 (a 5-node full mesh only reaches
// ~2 outbound/node — peers connect inbound first and FluxOS dedups); arcane:true
// so the arcane nodes accept content apps and run the benchmark crypto;
// legacyNodes:[4] makes node 4 NON-arcane (no FLUX_ARCANE_NODE) — the refuser.

const LEGACY = 4;
const ARCANE = [0, 1, 2, 3];

describe('content delivery: failure modes', function () {
  let env;
  dumpLogsOnFailure(() => env);

  const base = `cfm${Date.now()}`;

  // Confirm a registered app on-chain and resolve the FIRST arcane node index that
  // installs it. Only the arcane nodes are awaited — the legacy node never installs a
  // content app, so awaiting it would just burn the full timeout on a Promise.any loser.
  async function confirmAndFindArcaneInstaller(appHash, name, timeout = 240000) {
    await queueAppTx(appHash);
    await advanceBlocks(3);
    return Promise.any(ARCANE.map(async (i) => {
      await waitForAppInstalled(env.clients[i], name, timeout);
      return i;
    }));
  }

  before(async function () {
    this.timeout(480000);
    env = await createTestEnv({
      hookCtx: this, nodes: 5, tickerAutostart: false, arcane: true, legacyNodes: [LEGACY],
      configOverrides: { fluxapps: { minOutgoing: 2 } },
    });
    await bootAndPeer(env, { minOutbound: 2, minInbound: 2, pricing: true });
    await resetFluxDrive();
  });

  after(async function () {
    this.timeout(30000);
    await closeDb();
    await env?.teardown();
  });

  it('a non-arcane node refuses to spawn a content app while the arcane nodes install it', async function () {
    this.timeout(300000);
    const name = `${base}leg`;
    await pushImage(name, 'v1');

    const res = await deployContentApp(env.clients[0].url, {
      name,
      image: `${REGISTRY_REPO_HOST}/${name}:v1`,
      instances: 1,
      contentRef: Buffer.from('legacy-refusal contentRef payload'),
    });
    expect(res.status, 'register on arcane node').to.equal('success');

    // Snapshot the legacy node's event cursor BEFORE confirming, so the absence check
    // below covers the whole spawn window (the gate is definitive: an encrypted app
    // never installs on a non-arcane node).
    const legacyBefore = env.clients[LEGACY].getLastEventId();

    const installedIdx = await confirmAndFindArcaneInstaller(res.data, name);
    expect(ARCANE).to.include(installedIdx);

    // Positive: the app really is installed on the arcane node that won placement.
    const arcaneApps = await env.clients[installedIdx].getInstalledApps();
    expect((arcaneApps.data || []).some((a) => a.name === name), 'installed on an arcane node').to.equal(true);

    // Negative: the legacy node never installs it — no forward app:installed in a full
    // spawn window, none anywhere in its buffer since before confirm, and absent from
    // its installed set.
    await assertNoEvent(env.clients[LEGACY], 'app:installed', (d) => d.name === name, 15000);
    const legacyInstalledEvent = env.clients[LEGACY].getEventBuffer().find(
      (e) => e.event === 'app:installed' && e.id > legacyBefore && e.data.name === name,
    );
    expect(legacyInstalledEvent, 'legacy node never emitted app:installed for the content app').to.be.undefined;
    const legacyApps = await env.clients[LEGACY].getInstalledApps();
    expect((legacyApps.data || []).find((a) => a.name === name), 'content app absent on the legacy node').to.be.undefined;
  });

  it('a FluxDrive 5xx aborts the register (synchronous blob upload), then succeeds once FluxDrive recovers', async function () {
    this.timeout(180000);
    const name = `${base}5xx`;
    await pushImage(name, 'v1');
    const contentBytes = Buffer.from('blob upload must be durable before gossip');

    // FluxDrive down: the content-blob upload is synchronous in the submission path
    // (durable-before-gossip), so a 503 propagates and the register fails.
    await setFluxDriveMode({ fail5xx: true });
    const failed = await deployContentApp(env.clients[0].url, {
      name,
      image: `${REGISTRY_REPO_HOST}/${name}:v1`,
      instances: 1,
      contentRef: contentBytes,
    });
    expect(failed.status, 'register aborts while FluxDrive is 5xx').to.equal('error');

    // The aborted register stored nothing in FluxDrive (the first upload threw).
    let state = await getFluxDriveState();
    expect(state.blobs.some((b) => b.appName === name), 'no blob stored from the failed register').to.equal(false);

    // FluxDrive recovers: the SAME name registers cleanly (a failed submission must not
    // poison the name — it never reached the temp-message broadcast or global store).
    await setFluxDriveMode({ fail5xx: false });
    const node = env.clients[0];
    const afterId = node.getLastEventId();
    const ok = await deployContentApp(node.url, {
      name,
      image: `${REGISTRY_REPO_HOST}/${name}:v1`,
      instances: 1,
      contentRef: contentBytes,
    });
    expect(ok.status, 'register succeeds once FluxDrive is back').to.equal('success');

    const uploaded = await node.waitForEvent(
      'content:blobUploaded',
      (d) => d.appName === name && d.source === 'blob',
      30000,
      { afterId },
    );
    expect(uploaded.data.locator).to.match(/^[0-9a-f]{64}$/);

    state = await getFluxDriveState();
    const stored = state.blobs.find((b) => b.locator === uploaded.data.locator);
    expect(stored, 'blob now durably in FluxDrive').to.exist;
    expect(stored.appName).to.equal(name);
  });

  it('rejects a content update whose version is not newer than the stored one (stored manifest unchanged)', async function () {
    this.timeout(300000);
    const name = `${base}ver`;
    await pushImage(name, 'v1');

    const reg = await deployContentApp(env.clients[0].url, {
      name,
      image: `${REGISTRY_REPO_HOST}/${name}:v1`,
      instances: 1,
      contentSlots: [{
        name: 'config',
        destination: '/etc/slot.conf',
        bytes: Buffer.from('version-guard slot v1'),
        onUpdate: { action: 'signal', signal: 'SIGHUP' },
      }],
    });
    expect(reg.status, 'register slot app').to.equal('success');

    const installedIdx = await confirmAndFindArcaneInstaller(reg.data, name);
    const client = env.clients[installedIdx];

    // Advance to v2 so there is a stored floor to fail against.
    const v2 = await pushContentUpdate(client.url, {
      name, version: 2, slots: [{ name: 'config', bytes: Buffer.from('version-guard slot v2') }],
    });
    expect(v2.status, 'v2 update accepted').to.equal('success');
    await client.waitForEvent('content:contentUpdateApplied', (d) => d.appName === name && d.version === 2, 60000);

    // A re-submission at v1 (<= stored v2) is refused before any FluxDrive write.
    const stale = await pushContentUpdate(client.url, {
      name, version: 1, slots: [{ name: 'config', bytes: Buffer.from('version-guard slot stale') }],
    });
    expect(stale.status, 'stale v1 update rejected').to.equal('error');

    // The stored manifest stayed at v2 — the stale push changed nothing.
    const row = await dbClient(client.num).getContentManifest(name);
    expect(row, 'local manifest row present').to.exist;
    expect(row.version, 'stored manifest unchanged at v2').to.equal(2);
  });

  it('swallows a failing FluxDrive manifest-backstop PUT — the content update still succeeds', async function () {
    this.timeout(300000);
    const name = `${base}put`;
    await pushImage(name, 'v1');

    // Register + install in normal mode so the register's blob upload, the v1 manifest
    // backstop, and the cold-start install all succeed.
    const reg = await deployContentApp(env.clients[0].url, {
      name,
      image: `${REGISTRY_REPO_HOST}/${name}:v1`,
      instances: 1,
      contentSlots: [{
        name: 'config',
        destination: '/etc/slot.conf',
        bytes: Buffer.from('backstop-swallow slot v1'),
        onUpdate: { action: 'signal', signal: 'SIGHUP' },
      }],
    });
    expect(reg.status, 'register slot app').to.equal('success');

    const installedIdx = await confirmAndFindArcaneInstaller(reg.data, name);
    const client = env.clients[installedIdx];

    // Make ONLY the manifest backstop PUT fail (503). A global fail5xx can't be used here:
    // the content update's slot-blob upload is synchronous and mandatory (it would abort the
    // whole update before content:contentUpdateApplied). failManifestPut fails just the
    // backstop PUT; the node's backstopManifest() catches it and carries on (gossip + peers
    // are primary).
    await setFluxDriveMode({ failManifestPut: true });

    try {
      const afterId = client.getLastEventId();
      const upd = await pushContentUpdate(client.url, {
        name, version: 2, slots: [{ name: 'config', bytes: Buffer.from('backstop-swallow slot v2') }],
      });
      expect(upd.status, 'update succeeds despite the backstop PUT failing').to.equal('success');

      await client.waitForEvent(
        'content:contentUpdateApplied',
        (d) => d.appName === name && d.version === 2,
        60000,
        { afterId },
      );

      // The whole handler (including the backstop PUT attempt) has returned by now; let
      // any trailing SSE land, then assert the swallowed PUT emitted no backstopped event.
      await new Promise((r) => { setTimeout(r, 3000); });
      const backstopped = client.getEventBuffer().find(
        (e) => e.event === 'content:manifestBackstopped' && e.id > afterId && e.data.appName === name,
      );
      expect(backstopped, 'a swallowed backstop PUT emits no content:manifestBackstopped').to.be.undefined;

      // FluxDrive's stored manifest is untouched (the v2 PUT 503'd, never landed; the v1
      // backstop written at register remains).
      const state = await getFluxDriveState();
      expect(state.manifests[name], 'FluxDrive manifest from register still present').to.exist;
      expect(state.manifests[name].version, 'FluxDrive manifest version unchanged by the failed PUT').to.equal(1);

      // The primary path still advanced this node's own register to v2.
      const row = await dbClient(client.num).getContentManifest(name);
      expect(row, 'local manifest row present').to.exist;
      expect(row.version, 'gossip/store advanced the local manifest to v2').to.equal(2);
    } finally {
      await setFluxDriveMode({ failManifestPut: false });
    }
  });
});
