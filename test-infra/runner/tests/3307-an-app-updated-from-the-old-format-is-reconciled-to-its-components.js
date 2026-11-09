// fleet: 3
/*
 * An app installed at specification version 3 is updated to a version that has
 * components. Each holder brings it to the new specification in place: its
 * container is replaced by one made for the new specification, and the node's
 * record of the app is the new specification (appOperations.reconcileApp,
 * app:reconciled).
 *
 * On node 1 the database refuses the write of that record once. The update fails
 * there and the node keeps the app: it tells no peer it has gone, and the update is
 * adopted again while the installed specification is not the listed one, and
 * completes. Node 2's update completes the first time.
 *
 * A version 3 specification names three instances and no nodes, so a three-node
 * fleet holds it on every node. Adoption runs at every tip block once the spread
 * this suite compresses (adoptionStaggerWindowMs) has passed.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { pushImage } from '../framework/registry-helper.js';
import { buildSeedableApp, buildSeedableLegacyApp, buildSeedableUpdate } from '../framework/seed-helper.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { bootAndPeer, installOnNodes, seedSpecUpdate } from '../framework/reconciler-suite.js';
import { execInContainer, getAppContainerId } from '../framework/container.js';
import { waitFor, assertNoEvent } from '../framework/wait.js';
import { failWrites } from '../framework/mongo-control.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

const NODES = 3;
const REFUSED = 1;
const COMPLETES = 2;
const ADOPTION_MS = 600000;

// The specification an old-format app is updated to: the one a new app of its name
// would carry, signed by its owner as an update.
async function upgradeOf(env, legacy) {
  const { name } = legacy.spec;
  const target = await buildSeedableApp({
    env,
    name,
    instances: 3,
    compose: [{
      name,
      description: `${name} upgraded`,
      repotag: `${REGISTRY_REPO_HOST}/${name}:v1`,
      ports: [],
      domains: [''],
      environmentParameters: [],
      commands: [],
      containerPorts: [80],
      containerData: '/tmp',
      cpu: 0.1,
      ram: 100,
      hdd: 1,
      repoauth: '',
    }],
  });
  return buildSeedableUpdate(legacy, (spec) => {
    Object.keys(spec).forEach((key) => { delete spec[key]; });
    const { hash, height, ...fields } = target.spec;
    Object.assign(spec, fields);
  });
}

// Whether a container of that id is still on the node.
async function containerExists(container, id) {
  const { stdout } = await execInContainer(container, `docker inspect --format '{{.Id}}' ${id} 2>/dev/null || echo ""`);
  return stdout.trim() !== '';
}

async function installedHash(client, name) {
  const res = await client.getInstalledApps();
  if (res.status !== 'success') return null;
  return (res.data ?? []).find((a) => a.name === name)?.hash ?? null;
}

describe('an app updated from the old format is reconciled to its components', function () {
  let env;
  dumpLogsOnFailure(() => env);
  const appName = `e2elegacyup${Date.now()}`;
  let upgraded;
  let release;
  let anchors;
  // Each node's container of the app at the old specification.
  let oldContainers;

  const reconciled = (i, outcome, afterId = anchors[i]) => env.clients[i].getEventBuffer()
    .find((e) => e.id > afterId && e.event === 'app:reconciled' && e.data.name === appName && e.data.outcome === outcome);

  before(async function () {
    this.timeout(600000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      tickerAutostart: false,
      configOverrides: { fluxapps: { adoptionStaggerStepMs: 5000, adoptionStaggerWindowMs: 10000 } },
    });
    await bootAndPeer(env);

    await pushImage(appName, 'v1');
    const legacy = await buildSeedableLegacyApp({ name: appName });
    await installOnNodes(env, legacy, [...Array(NODES).keys()]);
    await waitFor(async () => {
      oldContainers = await Promise.all(env.clients.map((c) => getAppContainerId(c.container, appName)));
      return oldContainers.every(Boolean);
    }, { timeout: 180000, interval: 2000, label: 'every node runs the old-format app' });

    upgraded = await upgradeOf(env, legacy);
    anchors = env.clients.map((client) => client.getLastEventId());
    release = await failWrites(REFUSED + 1, 'localzelapps', 'zelappsinformation', { times: 1 });
    await seedSpecUpdate(env, upgraded, [...Array(NODES).keys()]);
  });

  after(async function () {
    this.timeout(60000);
    await release?.().catch(() => {});
    await env?.teardown();
  });

  it('brings the app to its new specification, in a container made for it', async function () {
    this.timeout(ADOPTION_MS + 120000);
    const node = env.clients[COMPLETES];
    await waitFor(() => Boolean(reconciled(COMPLETES, 'complete')), {
      timeout: ADOPTION_MS, interval: 2000, label: 'node 2 completes the update',
    });
    expect(await installedHash(node, appName), 'the node records another specification').to.equal(upgraded.hash);
    let current;
    await waitFor(async () => {
      current = await getAppContainerId(node.container, appName);
      return Boolean(current);
    }, { timeout: 120000, interval: 2000, label: 'the app runs at its new specification' });
    expect(current, 'the app runs in its old-format container').to.not.equal(oldContainers[COMPLETES]);
    expect(await containerExists(node.container, oldContainers[COMPLETES]), 'the old-format container is still there').to.equal(false);
  });

  it('keeps the app when the write of its new record is refused, and tells no peer it has gone', async function () {
    this.timeout(ADOPTION_MS + 60000);
    await waitFor(() => Boolean(reconciled(REFUSED, 'failed')), {
      timeout: ADOPTION_MS, interval: 2000, label: 'node 1 fails the update',
    });
    expect(await installedHash(env.clients[REFUSED], appName), 'node 1 no longer holds the app').to.not.equal(null);
    const peers = [...Array(NODES).keys()].filter((i) => i !== REFUSED);
    await Promise.all(peers.map((i) => assertNoEvent(env.clients[i], 'network:appremoved',
      (d) => d.name === appName && d.ip.startsWith(env.clients[REFUSED].ip), 0, { afterId: anchors[i] })));
  });

  it('had the write of the app\'s new record refused by the database', async function () {
    const failed = await release();
    release = null;
    expect(failed, 'the database refused none of node 1\'s record writes, so nothing above was tested').to.equal(1);
  });

  it('adopts the update again on the node that failed it, and completes it', async function () {
    this.timeout(ADOPTION_MS + 120000);
    const failedAt = reconciled(REFUSED, 'failed').id;
    await waitFor(() => Boolean(reconciled(REFUSED, 'complete', failedAt)), {
      timeout: ADOPTION_MS, interval: 2000, label: 'node 1 completes the update on a later adoption',
    });
    const node = env.clients[REFUSED];
    expect(await installedHash(node, appName), 'node 1 records another specification').to.equal(upgraded.hash);
    await waitFor(async () => Boolean(await getAppContainerId(node.container, appName)), {
      timeout: 120000, interval: 2000, label: 'the app runs at its new specification on node 1',
    });
  });
});
