import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { deployContentApp, fetchTransportPubKey } from '../framework/content-helper.js';
import { getFluxDriveState, resetFluxDrive } from '../framework/fluxdrive-control.js';
import { pushImage } from '../framework/registry-helper.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
import { waitForAppInstalled } from '../framework/wait.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { appOwnerKey } from '../framework/keys.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

// Content blobs (contentRef): the smallest content-delivery surface. Proves the
// real v9 submission path end to end — the multipart /apps/appregister, the HPKE
// spec + content envelopes, the benchmark-channel crypto, and the FluxDrive stub —
// then that the spawner provisions the blob (peers-first, FluxDrive backstop,
// hash-verified) on install. Asserts on the SSE event bus (the deterministic
// signal) plus the FluxDrive stub state, never log scraping.
//
// nodes:5 so the submission's minOutgoing>=4 peer gate is satisfiable; arcane:true
// so the node accepts encrypted/content apps and runs the benchmark crypto.

describe('content blobs (contentRef): register, upload, provision', function () {
  let env;
  dumpLogsOnFailure(() => env);
  const appName = `e2eblob${Date.now()}`;
  const contentBytes = Buffer.from('immutable contentRef payload for the e2e blob suite');
  let appHash;

  before(async function () {
    this.timeout(420000);
    env = await createTestEnv({
      hookCtx: this, nodes: 5, tickerAutostart: false, arcane: true,
    });
    await bootAndPeer(env);
    await pushImage(appName, 'v1');
    await resetFluxDrive();
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('registers and synchronously uploads the contentRef blob to FluxDrive before gossip', async function () {
    this.timeout(120000);
    const node = env.clients[0];
    const afterId = node.getLastEventId();

    const res = await deployContentApp(node.url, {
      name: appName,
      image: `${REGISTRY_REPO_HOST}/${appName}:v1`,
      contentRef: contentBytes,
    });
    expect(res.status).to.equal('success');
    appHash = res.data;

    // The upload is synchronous in the submission path, so the event is already
    // emitted by the time the register call returns.
    const ev = await node.waitForEvent(
      'content:blobUploaded',
      (d) => d.appName === appName && d.source === 'blob',
      30000,
      { afterId },
    );
    expect(ev.data.locator).to.match(/^[0-9a-f]{64}$/);
    expect(ev.data.hash).to.match(/^sha256:[0-9a-f]{64}$/);

    // FluxDrive holds the ciphertext under that locator, recorded as source 'blob'.
    const state = await getFluxDriveState();
    const stored = state.blobs.find((b) => b.locator === ev.data.locator);
    expect(stored, 'blob present in FluxDrive').to.exist;
    expect(stored.source).to.equal('blob');
    expect(stored.appName).to.equal(appName);
    expect(stored.byteLength).to.be.greaterThan(contentBytes.length); // nonce+ct+tag framing
  });

  it('serves the per-app transport public key', async function () {
    this.timeout(30000);
    const pub = await fetchTransportPubKey(env.clients[0].url, appName, appOwnerKey().zelid);
    expect(Buffer.from(pub, 'base64')).to.have.lengthOf(32);
  });

  it('confirms on-chain and the spawner provisions the blob from the FluxDrive backstop', async function () {
    this.timeout(240000);
    expect(appHash, 'register produced an app hash').to.be.a('string');
    const beforeIds = env.clients.map((c) => c.getLastEventId());

    // Confirm the registration so the spawner picks it up; no running peer holds the
    // app yet, so provisioning resolves the blob from the FluxDrive backstop.
    await queueAppTx(appHash);
    await advanceBlocks(3);

    const installedIndex = await Promise.any(env.clients.map(async (c, i) => {
      await waitForAppInstalled(c, appName, 200000);
      return i;
    }));
    const node = env.clients[installedIndex];

    // The provision hash-verifies before writing, so a blobProvisioned event means
    // the correct bytes landed; blobResolved reports which source served it.
    const resolved = await node.waitForEvent(
      'content:blobResolved',
      (d) => d.appName === appName,
      60000,
      { afterId: beforeIds[installedIndex] },
    );
    expect(resolved.data.source).to.equal('fluxdrive');

    await node.waitForEvent(
      'content:blobProvisioned',
      (d) => d.appName === appName,
      60000,
      { afterId: beforeIds[installedIndex] },
    );
  });
});
