import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { deployContentApp, pushContentUpdate } from '../framework/content-helper.js';
import { getFluxDriveState, resetFluxDrive } from '../framework/fluxdrive-control.js';
import { pushImage } from '../framework/registry-helper.js';
import { queueAppTx, advanceBlocks, getState } from '../framework/daemon-control.js';
import { waitForAppSpecStored } from '../framework/wait.js';
import { dbClient, closeDb } from '../framework/db-client.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

// Content lifecycle GC: the permanent content-manifest register is reaped to the
// live-app set and the FluxDrive blob set is reconciled to the live slot-locator
// set. One slot app drives its whole lifecycle on the submitting node (node 0):
//   - register  → the bundled v1 manifest is stored CONFIRMED + its slot blob lands
//                 in FluxDrive (source 'slot'); confirm on-chain so the global spec
//                 (the live-set membership the reaper keys on) exists.
//   - update v2 → the GC reconcile is pushed and FluxDrive TOMBSTONES the superseded
//                 v1 slot blob (the blob-set complement of the manifest register).
//   - latest-wins → a higher version (v3) supersedes; a stale version (v2) is refused
//                 without advancing the register.
//   - reaper    → once the app leaves globalappsspecifications, the periodic sweep in
//                 the block loop (after expireGlobalApplications) drops the confirmed
//                 manifest row.
// Asserts on the SSE event bus + the appcontentmanifests DB row + the FluxDrive stub
// state (reconciles, tombstoned blobs), never log scraping. Complements suite 53
// (which proves onUpdate reactions on the RUNNING node); this suite is install-free —
// every assertion is a control-plane fact, so it operates entirely on the submitter.
//
// nodes:5 with fluxapps.minOutgoing lowered to 2 (a 5-node full mesh only reaches
// ~2 outbound/node — peers connect inbound first and FluxOS dedups); arcane:true so
// the node accepts content apps, runs the benchmark crypto, and opens sealed content.

describe('content lifecycle GC: manifest reaper, reconcile tombstone, latest-wins', function () {
  let env;
  dumpLogsOnFailure(() => env);

  const appName = `lifecyclegc${Date.now()}`;
  const SLOT = 'config';
  const DEST = '/etc/slot.conf';

  let dbc; // node 0's DB client (its appcontentmanifests + globalappsspecifications)
  let appHash;
  let v1Locator; // the v1 slot blob locator (uploaded at register)
  let v2Locator; // the v2 slot blob locator (uploaded by the v2 update)

  before(async function () {
    this.timeout(420000);
    // contentManifestReapGraceMs: the prod default (2h) would keep test 4's
    // just-stored manifest un-reapable for the whole suite; 30s still covers this
    // suite's own register window (manifest stored before the app tx confirms)
    // while letting the reap land inside test 4's wait as ticker blocks sweep.
    env = await createTestEnv({
      hookCtx: this, nodes: 5, tickerAutostart: false, arcane: true,
      configOverrides: { fluxapps: { minOutgoing: 2, contentManifestReapGraceMs: 30000 } },
    });
    await bootAndPeer(env, { minOutbound: 2, minInbound: 2, pricing: true });
    await pushImage(appName, 'v1');
    await resetFluxDrive();
    dbc = dbClient(env.clients[0].num);
  });

  after(async function () {
    this.timeout(30000);
    await closeDb();
    await env?.teardown();
  });

  it('registers a slot app: the bundled v1 manifest is stored confirmed, its slot blob lands in FluxDrive, then confirms on-chain', async function () {
    this.timeout(240000);
    const node = env.clients[0];
    const afterId = node.getLastEventId();

    const res = await deployContentApp(node.url, {
      name: appName,
      image: `${REGISTRY_REPO_HOST}/${appName}:v1`,
      instances: 1,
      contentSlots: [{
        name: SLOT, destination: DEST, bytes: Buffer.from('lifecycle slot v1'), onUpdate: { action: 'restart' },
      }],
    });
    expect(res.status).to.equal('success');
    appHash = res.data;

    // The register synchronously uploads the slot blob (source 'slot') and stores the
    // bundled v1 manifest confirmed — both before any on-chain confirmation exists.
    const uploaded = await node.waitForEvent(
      'content:blobUploaded',
      (d) => d.appName === appName && d.source === 'slot',
      30000,
      { afterId },
    );
    expect(uploaded.data.locator).to.match(/^[0-9a-f]{64}$/);
    v1Locator = uploaded.data.locator;

    const stored = await node.waitForEvent(
      'content:manifestStored',
      (d) => d.appName === appName && d.version === 1,
      30000,
      { afterId },
    );
    expect(stored.data.confirmed).to.equal(true);

    // The confirmed v1 manifest row is present at register time (asserted pre-confirm,
    // before the global spec exists, so it is independent of the install path).
    const row = await dbc.getContentManifest(appName);
    expect(row, 'v1 manifest row present at register').to.exist;
    expect(row.version).to.equal(1);
    expect(row.confirmed).to.equal(true);

    // The slot blob is in FluxDrive under the upload's locator, tagged source 'slot'.
    const state = await getFluxDriveState();
    const blob = state.blobs.find((b) => b.locator === v1Locator);
    expect(blob, 'v1 slot blob present in FluxDrive').to.exist;
    expect(blob.source).to.equal('slot');
    expect(blob.tombstoned).to.equal(false);

    // Confirm on-chain so the app enters globalappsspecifications — the live-set
    // membership the reaper checks, and the spec contentupdate's getApp reads.
    await queueAppTx(appHash);
    await advanceBlocks(3);
    await waitForAppSpecStored(node, appName, 200000);
  });

  it('a v2 content update pushes the live slot-locator set to FluxDrive and tombstones the superseded v1 blob', async function () {
    this.timeout(120000);
    const node = env.clients[0];
    const afterId = node.getLastEventId();

    const res = await pushContentUpdate(node.url, {
      name: appName,
      version: 2,
      slots: [{ name: SLOT, bytes: Buffer.from('lifecycle slot v2') }],
    });
    expect(res.status).to.equal('success');

    // The v2 update uploads a NEW slot blob (distinct locator), applies the update, and
    // pushes the GC reconcile for the slot source.
    const uploaded = await node.waitForEvent(
      'content:blobUploaded',
      (d) => d.appName === appName && d.source === 'slot',
      30000,
      { afterId },
    );
    v2Locator = uploaded.data.locator;
    expect(v2Locator).to.not.equal(v1Locator);

    await node.waitForEvent(
      'content:contentUpdateApplied',
      (d) => d.appName === appName && d.version === 2,
      60000,
      { afterId },
    );
    const pushed = await node.waitForEvent(
      'content:reconcilePushed',
      (d) => d.appName === appName && d.version === 2,
      60000,
      { afterId },
    );
    expect(pushed.data.source).to.equal('slot');

    // The manifest register advanced to v2.
    const row = await dbc.getContentManifest(appName);
    expect(row.version).to.equal(2);

    // FluxDrive recorded an ACCEPTED v2 reconcile whose live set is exactly the v2 slot
    // locator (not the v1 one), and tombstoned the now-superseded v1 slot blob while
    // leaving v2 live — the blob-set complement of the manifest version advance.
    const state = await getFluxDriveState();
    const rec = state.reconciles.find((r) => r.appName === appName && r.source === 'slot' && r.version === 2);
    expect(rec, 'v2 slot reconcile recorded').to.exist;
    expect(rec.accepted).to.equal(true);
    expect(rec.liveLocators).to.include(v2Locator);
    expect(rec.liveLocators).to.not.include(v1Locator);

    const v1Blob = state.blobs.find((b) => b.locator === v1Locator);
    const v2Blob = state.blobs.find((b) => b.locator === v2Locator);
    expect(v1Blob, 'v1 slot blob still present').to.exist;
    expect(v1Blob.tombstoned, 'superseded v1 slot blob tombstoned by the v2 reconcile').to.equal(true);
    expect(v2Blob, 'v2 slot blob present').to.exist;
    expect(v2Blob.tombstoned, 'live v2 slot blob not tombstoned').to.equal(false);
  });

  it('latest-wins store: a higher version (v3) supersedes, a stale version (v2) is refused without advancing the register', async function () {
    this.timeout(120000);
    const node = env.clients[0];
    const afterId = node.getLastEventId();

    // Higher version wins: v3 supersedes the stored v2.
    const v3 = await pushContentUpdate(node.url, {
      name: appName,
      version: 3,
      slots: [{ name: SLOT, bytes: Buffer.from('lifecycle slot v3') }],
    });
    expect(v3.status).to.equal('success');
    await node.waitForEvent(
      'content:contentUpdateApplied',
      (d) => d.appName === appName && d.version === 3,
      60000,
      { afterId },
    );
    expect((await dbc.getContentManifest(appName)).version).to.equal(3);

    // Stale version loses: a v2 resubmission is rejected (not newer than the stored v3).
    // The register stays at v3 and no update is applied — the submission path throws on
    // the version-monotonicity check before storing or applying anything.
    const staleAfterId = node.getLastEventId();
    const stale = await pushContentUpdate(node.url, {
      name: appName,
      version: 2,
      slots: [{ name: SLOT, bytes: Buffer.from('lifecycle slot stale-v2') }],
    });
    expect(stale.status).to.equal('error');

    // pushContentUpdate awaits the full response, so any event the stale push would have
    // emitted is already buffered — a race-free check that none applied.
    const appliedStale = node.getEventBuffer().some(
      (e) => e.event === 'content:contentUpdateApplied' && e.id > staleAfterId && e.data.appName === appName,
    );
    expect(appliedStale, 'stale update must not apply').to.equal(false);
    expect((await dbc.getContentManifest(appName)).version).to.equal(3);
  });

  it('the periodic reaper drops the confirmed manifest once the app leaves globalappsspecifications', async function () {
    this.timeout(180000);
    const node = env.clients[0];

    // Precondition: the confirmed v3 manifest is present and the app is in the live set.
    const before = await dbc.getContentManifest(appName);
    expect(before, 'confirmed manifest present before removal').to.exist;
    expect(before.version).to.equal(3);
    expect(before.confirmed).to.equal(true);

    // Remove the app from the global set — the only condition the reaper keys on (a
    // confirmed manifest whose app is no longer in globalappsspecifications). This is
    // the durable equivalent of appremove/expiry: appremove only uninstalls locally and
    // expiry needs registeredAt+ttl<now (min ttl is 1 day), so neither removes the
    // global spec row inside a test — a direct delete is the deterministic lever.
    await dbc.deleteGlobalAppSpec(appName);

    const afterId = node.getLastEventId();

    // The reaper runs after expireGlobalApplications on the synced block loop, every
    // 2*speedMultiplier blocks (speedMultiplier=4 above the PON fork → every 8 blocks).
    // Two subtleties make a single blind advance unreliable: the cadence branch only
    // evaluates on a block processed AT the tip (an explorer catching up in a batch
    // sees confirmations >= 2 for all but the last), and rows younger than
    // contentManifestReapGraceMs (30s here) are never reaped. So each round lands the
    // tip EXACTLY on a sweep boundary and waits; the reap fires on the first
    // boundary past the grace.
    const deadline = Date.now() + 120000;
    let reaped;
    for (;;) {
      const { currentHeight } = await getState();
      await advanceBlocks(8 - (currentHeight % 8) || 8);
      try {
        reaped = await node.waitForEvent(
          'content:manifestReaped',
          (d) => d.count >= 1,
          15000,
          { afterId },
        );
        break;
      } catch (err) {
        if (Date.now() > deadline) throw err;
      }
    }
    expect(reaped.data.count).to.be.at.least(1);

    // The confirmed manifest row for the dead app is gone.
    const after = await dbc.getContentManifest(appName);
    expect(after, 'manifest row reaped').to.not.exist;
  });
});
