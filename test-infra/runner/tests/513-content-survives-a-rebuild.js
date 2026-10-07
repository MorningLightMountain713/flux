// fleet: 5
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { deployContentApp, listedIdentity } from '../framework/content-helper.js';
import { blobHash } from '../framework/content-crypto-v9.js';
import { resetFluxDrive, setFluxDriveMode } from '../framework/fluxdrive-control.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
import {
  waitFor, waitForAppInstalled, waitForComponentRedeployed, waitForUp,
} from '../framework/wait.js';
import {
  appContainerName, execInContainer, getAppContainerId, readFileInContainer,
} from '../framework/container.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { authenticate } from '../auth.js';
import { appOwnerKey } from '../framework/keys.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

// A container is created with its content, whichever path creates it. The one
// create step writes a component's blobs and its slots onto its mount sources
// before docker creates the container, so a rebuild (the volume recreated) and a
// redeploy (the volume kept) both bring the container up on the files the app
// stands on, and a rebuild while a file cannot be had is refused before anything
// is torn down.
//
// One content app on one node (instances: 1), so no peer serves its files and
// FluxDrive is the only remote source: taking a file out of the node's store and
// failing FluxDrive is what makes a file one that cannot be had. The component
// runs the static-busybox fixture so the host can `docker exec` into it.
// arcane:true, nodes:5 with minOutgoing 2, as every content suite.

describe('a container is created with its content, whichever path creates it', function () {
  let env;
  dumpLogsOnFailure(() => env);

  const appName = `rebuild${Date.now()}`;
  const COMPONENT = 'web';
  const BLOB_DEST = '/etc/ref.conf';
  const BLOB_BYTES = Buffer.from('the blob the spec names, immutable');
  const SLOT_DEST = '/etc/app.conf';
  const SLOT_BYTES = Buffer.from('the slot the manifest names, version one');
  // A file on the data volume, written through the running container: gone
  // after a rebuild, kept across a redeploy. What tells the two apart.
  const MARKER = '/data/written-before';

  let holder;
  let auth;

  async function contentInContainer() {
    return {
      blob: await readFileInContainer(holder.container, appName, COMPONENT, BLOB_DEST),
      slot: await readFileInContainer(holder.container, appName, COMPONENT, SLOT_DEST),
    };
  }

  function expectContent({ blob, slot }, when) {
    expect(blob.exitCode, `${when}: the blob is readable`).to.equal(0);
    expect(blob.content.trim(), `${when}: the blob's bytes`).to.equal(BLOB_BYTES.toString());
    expect(slot.exitCode, `${when}: the slot is readable`).to.equal(0);
    expect(slot.content.trim(), `${when}: the slot's bytes`).to.equal(SLOT_BYTES.toString());
  }

  async function writeMarker() {
    const name = await appContainerName(holder.container, appName, COMPONENT);
    const r = await execInContainer(holder.container, `docker exec ${name} /bin/busybox sh -c 'echo marker > ${MARKER}'`);
    expect(r.exitCode, `could not write the marker: ${r.output}`).to.equal(0);
    expect(await markerPresent(), 'the marker was written').to.equal(true);
  }

  async function markerPresent() {
    return (await readFileInContainer(holder.container, appName, COMPONENT, MARKER)).exitCode === 0;
  }

  const containerId = () => getAppContainerId(holder.container, appName, COMPONENT);

  // The body is the progress stream, one envelope per step; the last one is
  // what answers.
  function lastStatus(body) {
    const statuses = [...body.matchAll(/"status"\s*:\s*"([^"]*)"/g)].map((m) => m[1]);
    return statuses[statuses.length - 1];
  }

  // A different container id is the only evidence that separates a container
  // that was replaced from one that was restarted.
  async function replacedContainer(before, label) {
    await waitFor(async () => {
      const id = await containerId();
      return id !== null && id !== before;
    }, { timeout: 180000, interval: 2000, label });
    await waitForUp(holder, appName, `${label}: running`);
  }

  before(async function () {
    this.timeout(720000);
    env = await createTestEnv({
      hookCtx: this, nodes: 5, tickerAutostart: false, arcane: true,
      configOverrides: { fluxapps: { minOutgoing: 2 } },
    });
    await bootAndPeer(env, { minOutbound: 2, minInbound: 2, pricing: true });
    await pushBusybox(appName, 'v1');
    await resetFluxDrive();

    const res = await deployContentApp(env.clients[0].url, {
      name: appName,
      image: `${REGISTRY_REPO_HOST}/${appName}:v1`,
      instances: 1,
      contentRef: BLOB_BYTES,
      contentSlots: [
        {
          name: 'conf', destination: SLOT_DEST, bytes: SLOT_BYTES, onUpdate: { action: 'restart' },
        },
      ],
    });
    expect(res.status, `register: ${JSON.stringify(res)}`).to.equal('success');

    await queueAppTx(res.data);
    await advanceBlocks(3);
    const index = await Promise.any(env.clients.map(async (c, i) => {
      await waitForAppInstalled(c, appName, 240000);
      return i;
    }));
    holder = env.clients[index];
    await waitForUp(holder, appName, 'the app running after its install');
    auth = await authenticate(holder.url, appOwnerKey());
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('starts with the blob and the slot in its container', async function () {
    this.timeout(60000);
    expectContent(await contentInContainer(), 'after the install');
  });

  it('a rebuild of the app brings the files back onto the fresh volume', async function () {
    this.timeout(420000);
    await writeMarker();
    const before = await containerId();
    expect(before, 'a container before the rebuild').to.be.a('string');

    const body = await holder.redeployApp(appName, auth.zelidauth, { force: true });
    expect(body, `rebuild refused: ${body.slice(0, 400)}`).to.not.match(/Unauthorized/i);
    expect(lastStatus(body), `the rebuild did not finish: ${body.slice(-600)}`).to.equal('success');

    await replacedContainer(before, 'the app rebuilt');
    expect(await markerPresent(), 'the volume was not rebuilt').to.equal(false);
    expectContent(await contentInContainer(), 'after the rebuild of the app');
  });

  it('a rebuild of one component does the same', async function () {
    this.timeout(420000);
    await writeMarker();
    const before = await containerId();
    const from = holder.getLastEventId();

    const body = await holder.redeployComponent(appName, COMPONENT, auth.zelidauth, { force: true });
    expect(lastStatus(body), `the component rebuild did not finish: ${body.slice(-600)}`).to.equal('success');

    await waitForComponentRedeployed(holder, appName, COMPONENT, true, 240000, { afterId: from });
    await replacedContainer(before, 'the component rebuilt');
    expect(await markerPresent(), 'the volume was not rebuilt').to.equal(false);
    expectContent(await contentInContainer(), 'after the rebuild of the component');
  });

  it('a redeploy keeps the files on the volume it keeps', async function () {
    this.timeout(420000);
    await writeMarker();
    const before = await containerId();
    const from = holder.getLastEventId();

    const body = await holder.redeployComponent(appName, COMPONENT, auth.zelidauth);
    expect(lastStatus(body), `the redeploy did not finish: ${body.slice(-600)}`).to.equal('success');

    await waitForComponentRedeployed(holder, appName, COMPONENT, false, 240000, { afterId: from });
    await replacedContainer(before, 'the component redeployed');
    expect(await markerPresent(), 'a redeploy destroyed the volume it keeps').to.equal(true);
    expectContent(await contentInContainer(), 'after the redeploy');
  });

  it('a file that cannot be had refuses the rebuild with the app running, and the rebuild goes through once it can', async function () {
    this.timeout(600000);
    // The node's own copy of the blob, under the store's layout
    // <store>/<identity>/<hex of the hash>; found, not spelled, so a store
    // laid out elsewhere fails here and not on a refusal that never comes.
    const identity = await listedIdentity(holder.url, appName);
    const hex = blobHash(BLOB_BYTES).slice('sha256:'.length);
    const found = await execInContainer(holder.container, `find /mnt/appdata/flux-content/${identity} -name ${hex}`);
    const stored = found.stdout.trim().split('\n').filter(Boolean);
    expect(stored, `the blob is in the node's store under the app's identity: ${found.output}`).to.have.lengthOf(1);
    const removed = await execInContainer(holder.container, `rm -f ${stored[0]}`);
    expect(removed.exitCode, `could not remove the stored blob: ${removed.output}`).to.equal(0);

    await setFluxDriveMode({ fail5xx: true });
    try {
      await writeMarker();
      const before = await containerId();

      const body = await holder.redeployApp(appName, auth.zelidauth, { force: true });

      expect(lastStatus(body), `the rebuild was not refused: ${body.slice(-600)}`).to.equal('error');
      expect(body, 'refused for the file that cannot be had').to.match(/no source/);
      // Refused before anything was torn down: the same container, running, its data intact.
      expect(await containerId(), 'the container was replaced by a refused rebuild').to.equal(before);
      expect(await markerPresent(), 'the volume was destroyed by a refused rebuild').to.equal(true);
      expectContent(await contentInContainer(), 'after the refused rebuild');
    } finally {
      await setFluxDriveMode({ fail5xx: false });
    }

    const before = await containerId();
    const body = await holder.redeployApp(appName, auth.zelidauth, { force: true });
    expect(lastStatus(body), `the rebuild did not finish once the file could be had: ${body.slice(-600)}`).to.equal('success');

    await replacedContainer(before, 'the app rebuilt once the file could be had');
    expect(await markerPresent(), 'the volume was not rebuilt').to.equal(false);
    expectContent(await contentInContainer(), 'after the rebuild that went through');
    // A file fetched from FluxDrive is written through to the store.
    const back = await execInContainer(holder.container, `test -f ${stored[0]}`);
    expect(back.exitCode, 'the fetched blob is back in the store').to.equal(0);
  });
});
