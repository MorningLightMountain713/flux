// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { registerEncryptedV9App } from '../framework/content-helper.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
import { waitFor, waitForAppInstalled, assertNoEvent } from '../framework/wait.js';
import { pushImage } from '../framework/registry-helper.js';
import { execInContainer, getAppContainerStatus } from '../framework/container.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { authenticate } from '../auth.js';
import { appOwnerKey } from '../framework/keys.js';

// A v9 component may declare `persistentStorage.sizeGb: 0` — or omit the field
// entirely, which materializes to the same thing — and keep nothing across a
// restart. An observability agent is the motivating case: it holds no state
// worth surviving, so reserving a persistent volume for it is pure waste the
// customer pays for.
//
// The interesting part is not that the spec validates (unit-covered on both
// sides) but that the NODE agrees. Every lifecycle stage previously assumed a
// volume existed, and each assumption fails differently:
//   - createAppVolume would fallocate a 0G file and hand mke2fs an empty image;
//   - verifyAppVolumeMount would fail on a mountpoint deliberately never made;
//   - the reconciler's mount gate would defer ALL actuation forever AND record
//     a volume_missing tampering event on every pass — the container would
//     never start, and the node would report its own app as tampered with;
//   - the recreate guard would refuse to rebuild a container it must rebuild;
//   - the network heal would be permanently blocked for the same reason.
// So this suite runs a stateless component beside a stateful sibling and holds
// both to their own contracts — the sibling is the control that proves the
// assertions can tell the two apart rather than passing vacuously.
//
// Note the harness's own 2G volume cap (appVolumeService: `test && !isStateless`)
// deliberately does NOT apply to a stateless component; without that carve-out
// every suite would silently get a volume and none of this would be reachable.
//
// Port slice: 38xxx.

const NODES = 5;
const APP = `stateless${Date.now()}`;
const WEB_PORT = 38010;

const STATEFUL = 'keeper'; // control: a real persistent volume
const STATELESS = 'agent'; // the component under test

const containerName = (comp) => `flux${comp}_${APP}`;
const appDir = (comp) => `/mnt/appdata/flux-apps/${containerName(comp)}`;
const volFile = (comp) => `/mnt/appdata/${containerName(comp)}FLUXFSVOL`;

const components = {
  [STATEFUL]: {
    name: STATEFUL,
    description: 'stateful control component',
    image: `${REGISTRY_REPO_HOST}/${APP}:v1`,
    cpu: 0.2,
    memory: 200,
    rootFsGb: 2,
    persistentStorage: { sizeGb: 1, mounts: {} },
    ports: { http: { containerPort: 80, hostPort: WEB_PORT } },
  },
  [STATELESS]: {
    name: STATELESS,
    description: 'stateless component — persistentStorage omitted entirely',
    image: `${REGISTRY_REPO_HOST}/${APP}:v1`,
    cpu: 0.2,
    memory: 200,
    rootFsGb: 2,
    // No persistentStorage key at all: this IS the stateless declaration, and
    // fromSubmission materializes it to sizeGb 0 with no mounts.
  },
};

describe('stateless components: a v9 component with no persistent volume', function () {
  let env;
  let client;

  const X = (cmd) => execInContainer(client.container, cmd);
  const exists = async (path) => (await X(`test -e ${path}`)).exitCode === 0;
  const isMountpoint = async (dir) => (await X(`mountpoint -q ${dir}`)).exitCode === 0;
  const isUp = async (comp) => {
    const status = await getAppContainerStatus(client.container, containerName(comp));
    return !!(status && status.status.startsWith('Up'));
  };

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      tickerAutostart: false,
      // Registration-door shape for a 5-node mesh (suite 52/69 sizing note).
      configOverrides: { fluxapps: { minOutgoing: 2 } },
    });
    await bootAndPeer(env, { minOutbound: 2, minInbound: 2, pricing: true });

    await pushImage(APP, 'v1');
    const res = await registerEncryptedV9App(env.clients[0].url, {
      name: APP,
      components,
      instances: 3,
    });
    expect(res.status, JSON.stringify(res)).to.equal('success');

    await queueAppTx(res.data);
    await advanceBlocks(3);
    const installedIndex = await Promise.any(env.clients.map(async (c, i) => {
      await waitForAppInstalled(c, APP, 300000);
      return i;
    }));
    client = env.clients[installedIndex];
  });

  after(async function () {
    this.timeout(120000);
    await env?.teardown();
  });

  it('runs the stateless component with no volume, while its stateful sibling gets one', async function () {
    this.timeout(180000);
    await waitFor(async () => await isUp(STATELESS) && await isUp(STATEFUL),
      { timeout: 150000, interval: 3000, label: 'both components running' });

    // The control: the stateful sibling proves the volume machinery still works
    // on this node, so the absences asserted below are meaningful rather than a
    // suite that would pass against any node at all.
    expect(await exists(volFile(STATEFUL)), 'stateful sibling has a backing volume image').to.equal(true);
    expect(await isMountpoint(appDir(STATEFUL)), 'stateful sibling app dir is a real mountpoint').to.equal(true);

    // The component under test: nothing allocated, nothing mounted.
    expect(await exists(volFile(STATELESS)), 'stateless component must have NO backing volume image').to.equal(false);
    expect(await isMountpoint(appDir(STATELESS)), 'stateless component app dir must not be a mountpoint').to.equal(false);
  });

  it('gives the stateless container no bind mounts', async function () {
    this.timeout(60000);
    // mounts derive entirely from persistentStorage, so an empty map must reach
    // docker as an empty Mounts array — not a bind onto a bare host path, which
    // is how an unmounted app dir silently becomes host-filesystem writes.
    const r = await X(`docker inspect -f '{{len .Mounts}}' ${containerName(STATELESS)}`);
    expect(r.stdout.trim(), 'stateless container mount count').to.equal('0');
  });

  it('reconciles normally instead of deferring on a volume that will never exist', async function () {
    this.timeout(120000);
    // The regression this suite exists for: the mount gate used to fail closed,
    // so a stateless component deferred every pass AND recorded a tampering
    // event each time. Both are absences, so they are asserted over a window
    // rather than by waiting for something to happen.
    await assertNoEvent(
      client,
      'reconciler:actuated',
      (d) => d.identifier === `${STATELESS}_${APP}` && d.action === 'volumeUnavailable',
      20000,
    );
    expect(await isUp(STATELESS), 'stateless component still running after the observation window').to.equal(true);
  });

  it('recreates a removed stateless container', async function () {
    this.timeout(300000);
    // The recreate guard refuses to rebuild a container whose volume cannot be
    // verified — correct for a stateful component (it would reformat data),
    // wrong for one that never had a volume. Without the carve-out this hangs
    // forever.
    const rm = await X(`docker rm -f ${containerName(STATELESS)}`);
    expect(rm.exitCode, rm.output).to.equal(0);

    await waitFor(async () => isUp(STATELESS),
      { timeout: 240000, interval: 5000, label: 'reconciler recreated the stateless container' });

    // Still stateless after the rebuild — a recreate must not quietly grow a volume.
    expect(await exists(volFile(STATELESS)), 'recreate must not create a volume').to.equal(false);
  });

  it('uninstalls cleanly, leaving nothing behind for either component', async function () {
    this.timeout(300000);
    const { zelidauth } = await authenticate(client.url, appOwnerKey());
    await client.removeApp(APP, { zelidauth });

    await waitFor(async () => {
      const stateless = await getAppContainerStatus(client.container, containerName(STATELESS));
      const stateful = await getAppContainerStatus(client.container, containerName(STATEFUL));
      return !stateless && !stateful;
    }, { timeout: 240000, interval: 5000, label: 'both containers removed' });

    // The stateful sibling's volume and app dir go; the stateless component's
    // teardown must be a clean no-op rather than an error path.
    expect(await exists(volFile(STATEFUL)), 'stateful volume image removed').to.equal(false);
    expect(await exists(appDir(STATEFUL)), 'stateful app dir removed').to.equal(false);
    expect(await exists(appDir(STATELESS)), 'stateless app dir never created and still absent').to.equal(false);
  });
});
