// fleet: 5
// base-image: FLUX_E2E_BASE_TAG
/*
 * An activeStandby app registered before v9, run by v9 nodes and an 8.20 node,
 * on real syncthing.
 *
 * The app asks for three instances, and three nodes can hold it: a v9 node
 * that installs it first and runs it as primary, an 8.20 node
 * (FLUX_E2E_BASE_TAG) and a fresh v9 node, the last two booting afterwards; the
 * two other v9 nodes, there so the ring closes, hold no room for it. A spec of
 * a version before v9 that names its nodes is an enterprise app's, so the
 * spawners place it. A v9 node names the component's container by the
 * app's identity; an 8.20 node asks each peer's /apps/heldcomponents for the
 * container's 8.x name, flux<component>_<name>, before it starts the component.
 *   - the 8.20 node installs the app and does not start the component, the v9
 *     primary answering that it holds it under its 8.x name, and the same
 *     through a restart of the 8.20 node's FluxOS;
 *   - the fresh v9 node shares the component's data under the 8.x folder id the
 *     registration fixes, syncs the primary's data, and shares the folder with
 *     both peers;
 *   - when the primary and the 8.20 node leave the network, the fresh node
 *     starts the component with that data.
 *
 * The 8.20 node's decision is its own masterSlave:decision counter, heldOnPeer,
 * read over /flux/testcounters.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { deliverAppMessage } from '../framework/app-delivery.js';
import { buildSeedableSyncthingApp } from '../framework/seed-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import {
  appDataRoot, appSyncthingFolderId, execInContainer, legacyFolderId, restartFluxos,
} from '../framework/container.js';
import { appView } from '../framework/app-view.js';
import { getDeviceId, getFolders, isDaemonUp } from '../framework/syncthing-real.js';
import { waitFor, waitForDaemonReady, waitForInstallSettled } from '../framework/wait.js';

const BASE_TAG = process.env.FLUX_E2E_BASE_TAG;
const NODES = 5;
const PRIMARY = 0;
const OLD = 3; // the 8.20 node
const FRESH = 4; // the fresh v9 node
const FULL = [1, 2]; // close the ring, hold no room for the app
// more than any tier's disk: the spawner's space check refuses every app
const NO_ROOM = { lockedSystemResources: { extrahdd: 1000 } };
const CONVERGE_MS = 300000;
const MARKER = 'written-on-the-primary';

describe('an app registered before v9, beside an 8.20 node', function () {
  let env;
  let view;
  let app;
  let legacyName; // flux<component>_<name>: the 8.x container name and folder id
  const name = `oldbeside${Date.now()}`;

  // Whether node `index` runs the container named `container`, read off its docker.
  async function running(index, container) {
    const r = await execInContainer(env.clients[index].container, `docker inspect -f '{{.State.Running}}' ${container} 2>/dev/null || echo absent`);
    return r.stdout.trim();
  }

  const heldOnPeer = () => env.clients[OLD].getDecisionCount('masterSlave:decision', `${name}_${name}`, 'heldOnPeer');

  async function dataFile(index) {
    const dir = `${await appDataRoot(env.clients[index].container, name)}/appdata`;
    const r = await execInContainer(env.clients[index].container, `cat ${dir}/marker 2>/dev/null || true`);
    return r.stdout.trim();
  }

  async function bootLate(index) {
    const client = await env.startNode(index);
    await waitForDaemonReady(client);
    await env.startDiscovery([index]);
    await waitFor(() => isDaemonUp(client), { timeout: 180000, interval: 3000, label: `syncthing up on node ${index}` });
    return client;
  }

  before(async function () {
    this.timeout(1200000);
    if (!BASE_TAG) {
      throw new Error('FLUX_E2E_BASE_TAG names the node image of released FluxOS 8.20: build it with FLUX_E2E_TAG=<base-tag> ./test-infra/build-release-image.sh v8.20.0');
    }
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      deferredNodes: 2,
      nodeImageTags: { [OLD]: BASE_TAG },
      nodeConfigOverrides: Object.fromEntries(FULL.map((i) => [i, NO_ROOM])),
      syncthing: 'real',
      tickerAutostart: false,
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1 });
    await waitFor(() => isDaemonUp(env.clients[PRIMARY]), { timeout: 180000, interval: 3000, label: 'syncthing up on the primary' });
    view = appView(env, name, { component: name, timeout: CONVERGE_MS });

    await pushImage(name, 'v1');
    app = await buildSeedableSyncthingApp({ name, syncMode: 'activeStandby', instances: 3 });
    expect(app.registrationVersion, 'the app is registered before v9').to.be.below(9);
    legacyName = legacyFolderId(name);
    await deliverAppMessage(env, app.message, [PRIMARY]);
    await waitForInstallSettled(env.clients[PRIMARY], name, CONVERGE_MS);
    await waitFor(async () => (await view.containerOn(PRIMARY))?.running, {
      timeout: CONVERGE_MS, interval: 3000, label: 'the v9 node runs the component',
    });
    const dir = `${await appDataRoot(env.clients[PRIMARY].container, name)}/appdata`;
    const wrote = await execInContainer(env.clients[PRIMARY].container, `sh -c 'mkdir -p ${dir} && echo ${MARKER} > ${dir}/marker'`);
    expect(wrote.exitCode, `the marker is written on the primary: ${wrote.output}`).to.equal(0);
  });

  after(async function () {
    this.timeout(120000);
    await env?.teardown();
  });

  it('installs the app on the 8.20 node and does not start the component the v9 primary holds', async function () {
    this.timeout(CONVERGE_MS * 2);
    const old = await bootLate(OLD);
    await waitForInstallSettled(old, name, CONVERGE_MS);
    await waitFor(async () => (await heldOnPeer()) >= 1, {
      timeout: CONVERGE_MS, interval: 3000, label: 'the 8.20 node finds the component held on a peer',
    });
    expect(await running(OLD, legacyName), `the 8.20 node's ${legacyName} is not running`).to.equal('false');
    expect((await view.containerOn(PRIMARY))?.running, 'the primary still runs the component').to.equal(true);
  });

  it('does not start it through a restart of the 8.20 node\'s FluxOS', async function () {
    this.timeout(CONVERGE_MS * 2);
    await restartFluxos(env.clients[OLD].container);
    await waitForDaemonReady(env.clients[OLD]);
    await waitFor(async () => (await heldOnPeer()) >= 1, {
      timeout: CONVERGE_MS, interval: 3000, label: 'the restarted 8.20 node finds the component held on a peer',
    });
    expect(await running(OLD, legacyName), `the 8.20 node's ${legacyName} is not running`).to.equal('false');
    expect((await view.containerOn(PRIMARY))?.running, 'the primary still runs the component').to.equal(true);
  });

  it('shares the data under the 8.x folder id on a fresh v9 node, syncs the primary\'s data, and shares the folder with both peers', async function () {
    this.timeout(CONVERGE_MS * 2);
    const fresh = await bootLate(FRESH);
    await waitForInstallSettled(fresh, name, CONVERGE_MS);
    expect(await appSyncthingFolderId(fresh, name, name), 'the fresh node\'s folder id is the 8.x name').to.equal(legacyName);
    await waitFor(async () => (await dataFile(FRESH)) === MARKER, {
      timeout: CONVERGE_MS, interval: 3000, label: 'the fresh node holds the primary\'s data',
    });
    const peers = await Promise.all([PRIMARY, OLD].map((i) => getDeviceId(env.clients[i])));
    await waitFor(async () => {
      const row = (await getFolders(fresh)).find((f) => f.id === legacyName);
      const shared = new Set((row?.devices || []).map((d) => d.deviceID));
      return peers.every((id) => shared.has(id));
    }, { timeout: CONVERGE_MS, interval: 5000, label: 'the fresh node shares the folder with the primary and the 8.20 node' });
  });

  it('starts the component with that data on the fresh node when the primary and the 8.20 node leave the network', async function () {
    this.timeout(CONVERGE_MS * 3);
    await env.disconnectNode(OLD);
    await env.disconnectNode(PRIMARY);
    try {
      await waitFor(async () => (await view.containerOn(FRESH))?.running, {
        timeout: CONVERGE_MS * 2, interval: 5000, label: 'the fresh node starts the component',
      });
      expect(await dataFile(FRESH), 'the component starts with the primary\'s data').to.equal(MARKER);
    } finally {
      await env.reconnectNode(PRIMARY);
      await env.reconnectNode(OLD);
    }
  });
});
