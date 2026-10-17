// fleet: 5
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { deployContentApp, pushContentUpdate } from '../framework/content-helper.js';
import { getFluxDriveState, resetFluxDrive } from '../framework/fluxdrive-control.js';
import { pushImage } from '../framework/registry-helper.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
import { waitForAppSpecStored } from '../framework/wait.js';
import { dbClient, closeDb } from '../framework/db-client.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';

// Content lifecycle GC: the content manifests a node holds are reaped to the
// live-app set and the FluxDrive blob set follows the slot locators the newest
// manifest keeps. One slot app drives its whole lifecycle on the submitting node (node 0):
//   - register  → the bundled v1 manifest is HELD (signer null) + its slot blob lands
//                 in FluxDrive (source 'slot'); confirm on-chain so the global spec
//                 (the live-set membership the reaper keys on) exists and the row
//                 write resolves the held manifest to its signer.
//   - update v2 → the v2 manifest reaches FluxDrive with the slot locators it keeps,
//                 and FluxDrive TOMBSTONES the superseded v1 slot blob (the
//                 blob-set complement of the manifest rows).
//   - the door  → a higher version (v3) is taken and stands; a version below the
//                 next within the ownership (v2) is refused at the door.
//   - reaper    → the janitor's sweep drops the resolved manifest rows of an
//                 identity another registration of its name has displaced, once
//                 that registration is a reorg cap (40 blocks) deep; the listed
//                 app's own rows stay.
// Asserts on the SSE event bus + the appcontentmanifests DB row + the FluxDrive stub
// state (kept lists, tombstoned blobs), never log scraping. Complements suite 53
// (which proves onUpdate reactions on the RUNNING node); this suite is install-free —
// every assertion is a control-plane fact, so it operates entirely on the submitter.
//
// nodes:5 with fluxapps.minOutgoing lowered to 2 (a 5-node full mesh only reaches
// ~2 outbound/node — peers connect inbound first and FluxOS dedups); arcane:true so
// the node accepts content apps, runs the benchmark crypto, and opens sealed content.

describe('content lifecycle GC: manifest reaper, the kept list\'s tombstone, the version door', function () {
  let env;

  const appName = `lifecyclegc${Date.now()}`;
  const SLOT = 'config';
  const DEST = '/etc/slot.conf';

  let dbc; // node 0's DB client (its appcontentmanifests + globalappsspecifications)
  let appHash;
  let v1Locator; // the v1 slot blob locator (uploaded at register)
  let v2Locator; // the v2 slot blob locator (uploaded by the v2 update)

  before(async function () {
    this.timeout(420000);
    env = await createTestEnv({
      hookCtx: this, nodes: 5, tickerAutostart: false, arcane: true,
      configOverrides: { fluxapps: { minOutgoing: 2 } },
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

  it('registers a slot app: the bundled v1 manifest is held until the registration applies, its slot blob lands in FluxDrive, then confirms on-chain', async function () {
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

    // The register synchronously uploads the slot blob (source 'slot') and holds the
    // bundled v1 manifest unresolved — both before any on-chain confirmation exists.
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
    expect(stored.data.resolved).to.equal(false);

    // The held v1 manifest row is present at register time (asserted pre-confirm,
    // before the global spec exists, so it is independent of the install path).
    const identity = stored.data.identity;
    const row = await dbc.getContentManifestByIdentity(identity);
    expect(row, 'v1 manifest row present at register').to.exist;
    expect(row.version).to.equal(1);
    expect(row.signer, 'held unresolved until the app is listed').to.equal(null);

    // The slot blob is in FluxDrive under the upload's locator, tagged source 'slot'.
    const state = await getFluxDriveState();
    const blob = state.blobs.find((b) => b.locator === v1Locator);
    expect(blob, 'v1 slot blob present in FluxDrive').to.exist;
    expect(blob.source).to.equal('slot');
    expect(blob.tombstoned).to.equal(false);

    // Confirm on-chain so the app enters globalappsspecifications — the live-set
    // membership the reaper checks, and the spec contentupdate's getApp reads. The
    // row write judges the held manifest: its signer is the listed owner.
    await queueAppTx(appHash);
    await advanceBlocks(3);
    await waitForAppSpecStored(node, appName, 200000);
    await node.waitForEvent(
      'content:manifestPromoted',
      (d) => d.appName === appName && d.version === 1,
      60000,
      { afterId },
    );
    const resolved = await dbc.getContentManifest(appName);
    expect(resolved.signer, 'resolved to the listed owner at the row write').to.be.a('string');
    expect(resolved.version).to.equal(1);
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
    // backstops the v2 manifest with the slot locators it keeps.
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
    const backstopped = await node.waitForEvent(
      'content:manifestBackstopped',
      (d) => d.appName === appName && d.version === 2,
      60000,
      { afterId },
    );
    expect(backstopped.data.kept).to.equal(1);

    // The highest-ranked row this node holds is now v2.
    const row = await dbc.getContentManifest(appName);
    expect(row.version).to.equal(2);

    // FluxDrive applied the v2 manifest's kept list, exactly the v2 slot locator (not
    // the v1 one), and tombstoned the now-superseded v1 slot blob while leaving v2
    // live — the blob-set complement of the new standing manifest.
    const state = await getFluxDriveState();
    const kept = state.keptLists.find((k) => k.appName === appName && k.version === 2);
    expect(kept, 'v2 kept list recorded').to.exist;
    expect(kept.applied).to.equal(true);
    expect(kept.keptLocators).to.deep.equal([v2Locator]);

    const v1Blob = state.blobs.find((b) => b.locator === v1Locator);
    const v2Blob = state.blobs.find((b) => b.locator === v2Locator);
    expect(v1Blob, 'v1 slot blob still present').to.exist;
    expect(v1Blob.tombstoned, 'superseded v1 slot blob tombstoned by the v2 kept list').to.equal(true);
    expect(v2Blob, 'v2 slot blob present').to.exist;
    expect(v2Blob.tombstoned, 'live v2 slot blob not tombstoned').to.equal(false);
  });

  it('the door: a higher version (v3) is taken and stands, a version below the next (v2) is refused without a row', async function () {
    this.timeout(120000);
    const node = env.clients[0];
    const afterId = node.getLastEventId();

    // The next version within the ownership: v3 is taken and outranks v2.
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

    // Below the next: a v2 resubmission is refused at the door (the next within the
    // ownership is 4). Nothing is stored or applied — the submission path throws on
    // the version rule before storing or applying anything.
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

  it('the periodic reaper drops the rows of an identity another registration of the name displaced, and keeps the listed app\'s', async function () {
    this.timeout(300000);
    const node = env.clients[0];

    // Precondition: the listed app's resolved v3 manifest is present.
    const before = await dbc.getContentManifest(appName);
    expect(before, 'resolved manifest present').to.exist;
    expect(before.version).to.equal(3);
    expect(before.signer).to.be.a('string');
    const { identity } = before;

    // A resolved row under the same name for another identity: what a node holds
    // for an earlier app of the name once this registration displaced it. Seeded,
    // since an earlier registration of the name would have had to expire first.
    const displaced = `b${'c'.repeat(52)}`;
    await dbc.seedContentManifest({
      appName, version: 5, hash: 'displaced-v5', signer: 'earlierowner', manifest: { appName, identity: displaced, version: 5, ownedFrom: 0, slots: {} },
    });
    expect(await dbc.getContentManifestsByIdentity(displaced)).to.have.length(1);
    const afterId = node.getLastEventId();

    // The registration that displaced it must be a reorg cap deep before the rows
    // go; the janitor sweeps every orphanSweepIntervalMs (120 s in the harness).
    await advanceBlocks(41);
    const reaped = await node.waitForEvent('content:manifestReaped', (d) => d.identities?.includes(displaced), 300000, { afterId });
    expect(reaped.data.count).to.equal(1);

    expect(await dbc.getContentManifestsByIdentity(displaced), 'the displaced identity\'s rows').to.deep.equal([]);
    const kept = await dbc.getContentManifest(appName);
    expect(kept, 'the listed app\'s rows stay').to.exist;
    expect(kept.identity).to.equal(identity);
    expect(kept.version).to.equal(3);
  });
});
