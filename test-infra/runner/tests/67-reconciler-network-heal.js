import { expect } from 'chai';
import { describe, it, before, after } from 'mocha';
import { createTestEnv } from '../framework/test-env.js';
import {
  getAppContainerStatus, getAppContainerId, getAppContainerAttachment,
  disconnectAppNetwork, connectAppNetwork,
  getAppNetworkSubnet, removeAppNetworkRaw, createAppNetworkRaw,
  removeAppImage, restartFluxos, execInContainer,
} from '../framework/container.js';
import { waitFor, waitForReconcileActuated } from '../framework/wait.js';
import {
  bootAndPeer, seedSimpleApp, installOnNodes,
} from '../framework/reconciler-suite.js';
import { buildSeedableApp } from '../framework/seed-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

// The network-detach heal (dev PR #1766, ported onto the v9 lifecycle): a RUNNING
// container whose libnetwork endpoint is gone (NetworkMode still names its network,
// NetworkSettings.Networks no longer carries it) has no IP, no embedded DNS and no
// published ports, and no docker start ever repairs it - only a force-remove +
// recreate with a fresh endpoint. The remove is destructive, so it is guarded:
// confirmed in-pass, required to persist, storm-checked, network-existence-checked,
// volume-verified, paced on its own durable ladder - and it must NEVER reformat the
// app's data volume or escalate to an uninstall. Detection is event-driven: the
// bridge enqueues on docker network-disconnect events, so a live detach heals in
// seconds, not at the hourly sweep.

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// events since afterId for one identifier, by action (absence assertions)
function actuationsSince(client, identifier, afterId) {
  return client.getEventBuffer()
    .filter((e) => e.event === 'reconciler:actuated' && e.id > afterId && e.data.identifier === identifier)
    .map((e) => e.data);
}

async function waitForUp(client, appName, label) {
  await waitFor(async () => {
    const status = await getAppContainerStatus(client.container, appName);
    return status && status.status.startsWith('Up');
  }, { timeout: 90000, interval: 2000, label });
}

// the heal's recreate carries reason: networkDetached - the vanished path's does not
async function waitForHealRecreated(client, identifier, timeout, afterId) {
  return client.waitForEvent(
    'reconciler:actuated',
    (d) => d.identifier === identifier && d.action === 'recreated' && d.reason === 'networkDetached',
    timeout,
    { afterId },
  );
}

describe('reconciler network-detach heal', function () {
  let env;
  dumpLogsOnFailure(() => env);
  let idx;
  let client;
  const healName = `e2eheal${Date.now()}`;
  const healId = `${healName}_${healName}`;
  const stormName = `e2estorm${Date.now()}`;
  const stormComps = ['www', 'api', 'db'];
  const restartName = `e2ehealboot${Date.now()}`;
  const restartId = `${restartName}_${restartName}`;
  const markerPath = (app) => `/mnt/appdata/flux-apps/flux${app}_${app}/appdata/heal-marker`;

  before(async function () {
    this.timeout(420000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 10,
      tickerAutostart: false,
      // The heal's windows at production size (60s persist per episode, 5m pruned
      // re-check) would put most of this suite in dead waits; compress them the same
      // way the crash ladder is compressed. The heal ladder itself IS the crash
      // ladder's shape (appsRuntimeState BACKOFF_DELAYS_MS), so compressing
      // crashBackoffDelaysMs paces both. recreateProvisionCapMs sits above the
      // registry verify timeout so a black-holed pull classes transient (suite 33).
      configOverrides: {
        fluxapps: {
          crashBackoffDelaysMs: [0, 2000, 5000, 10000, 15000],
          networkHealConfirmMs: 1000,
          networkHealDetachedPersistMs: 5000,
          networkHealPrunedRetryMs: 4000,
          postStartVerifyMs: 3000,
          recreateProvisionCapMs: 60000,
        },
      },
    });
    await bootAndPeer(env);

    ({ index: idx } = await seedSimpleApp(env, healName));
    client = env.clients[idx];
    // Proven before any tampering: an unproven app is still inside its install
    // trial, where external interference draws a rollback verdict - not this
    // suite's subject.
    await waitForReconcileActuated(client, healId, 'firstRunProven', 90000);

    // The storm app: three components of ONE app = three containers sharing one
    // fluxDockerNetwork, all on the node under test (targeted install - the storm
    // guard counts detached containers per node).
    await pushImage(stormName, 'v1');
    const stormApp = await buildSeedableApp({
      name: stormName,
      compose: stormComps.map((comp, i) => ({
        name: comp,
        description: 'storm component',
        repotag: `${REGISTRY_REPO_HOST}/${stormName}:v1`,
        ports: [31112 + i],
        domains: [''],
        environmentParameters: [],
        commands: [],
        containerPorts: [80],
        containerData: '/tmp',
        cpu: 0.1,
        ram: 100,
        hdd: 1,
        repoauth: '',
      })),
    });
    await installOnNodes(env, stormApp, [idx]);
    for (const comp of stormComps) {
      // eslint-disable-next-line no-await-in-loop
      await waitForReconcileActuated(client, `${comp}_${stormName}`, 'firstRunProven', 90000);
    }

    // The restart-mid-heal app, pinned to the same node.
    await pushImage(restartName, 'v1');
    const restartApp = await buildSeedableApp({
      name: restartName,
      compose: [{
        name: restartName,
        description: 'restart-mid-heal component',
        repotag: `${REGISTRY_REPO_HOST}/${restartName}:v1`,
        ports: [31115],
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
    await installOnNodes(env, restartApp, [idx]);
    await waitForReconcileActuated(client, restartId, 'firstRunProven', 90000);
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('heals a detached container: recreated attached, ports restored, appdata NEVER reformatted', async function () {
    this.timeout(120000);
    await waitForUp(client, healName, 'running before the detach');
    // the marker is what the heal must carry across the force-remove + recreate:
    // its recreate is forbidden from creating (reformatting) the data volume
    const w = await execInContainer(client.container, `sh -c 'echo precious > ${markerPath(healName)}'`);
    expect(w.exitCode, `marker write failed: ${w.output}`).to.equal(0);

    const afterId = client.getLastEventId();
    await disconnectAppNetwork(client.container, healName);

    // event-driven detection -> confirm -> persistence window -> guarded remove
    await waitForReconcileActuated(client, healId, 'networkDetached', 60000, { afterId });
    await waitForHealRecreated(client, healId, 60000, afterId);
    await waitForUp(client, healName, 'recreated and running after the heal');

    const attachment = await getAppContainerAttachment(client.container, healName);
    expect(attachment.attached, 'the recreated container must hold a fresh endpoint with an IP').to.be.true;

    const r = await execInContainer(client.container, `cat ${markerPath(healName)}`);
    expect(r.stdout.trim(), 'appdata must survive the heal byte-for-byte').to.equal('precious');

    // the episode closes: a later pass sees it attached and clears the heal state,
    // so nothing here keeps actuating
    const uninstalls = actuationsSince(client, healId, afterId).filter((d) => d.action === 'removed');
    expect(uninstalls, 'the heal must never uninstall the app').to.deep.equal([]);
  });

  it('a transient detach destroys nothing: reattached within the persistence window, same container', async function () {
    this.timeout(60000);
    await waitForUp(client, healName, 'running before the transient detach');
    const idBefore = await getAppContainerId(client.container, healName);
    expect(idBefore).to.be.a('string');

    const afterId = client.getLastEventId();
    await disconnectAppNetwork(client.container, healName);
    await delay(2000); // inside the (compressed 5s) persistence window
    await connectAppNetwork(client.container, healName);

    // let the persistence window + the armed re-check pass fully elapse
    await delay(10000);

    const idAfter = await getAppContainerId(client.container, healName);
    expect(idAfter, 'a transient detach must never recreate the container').to.equal(idBefore);
    const destructive = actuationsSince(client, healId, afterId)
      .filter((d) => ['networkDetached', 'recreated'].includes(d.action));
    expect(destructive, 'no destructive actuation for a detach that did not persist').to.deep.equal([]);
  });

  it('refuses to destroy a container whose network is GONE, and heals once the network returns', async function () {
    this.timeout(120000);
    await waitForUp(client, healName, 'running before the prune');
    const subnet = await getAppNetworkSubnet(client.container, healName);
    expect(subnet, 'the app network must exist (with a subnet) before the prune').to.be.a('string');
    const idBefore = await getAppContainerId(client.container, healName);

    const afterId = client.getLastEventId();
    await disconnectAppNetwork(client.container, healName);
    const rm = await removeAppNetworkRaw(client.container, healName);
    expect(rm.exitCode, `network rm failed: ${rm.output}`).to.equal(0);

    // docker itself confirms the network is absent -> refuse the remove, record it
    await waitForReconcileActuated(client, healId, 'networkPruned', 60000, { afterId });
    const status = await getAppContainerStatus(client.container, healName, { all: true });
    expect(status?.status?.startsWith('Up'), 'the un-recreatable container must be left in place, running').to.be.true;
    expect(await getAppContainerId(client.container, healName), 'and untouched').to.equal(idBefore);

    // the network returns (same subnet, as a restore would) -> the parked heal
    // proceeds on its re-check pace: remove, recreate, attach
    const mk = await createAppNetworkRaw(client.container, healName, subnet);
    expect(mk.exitCode, `network create failed: ${mk.output}`).to.equal(0);
    await waitForHealRecreated(client, healId, 90000, afterId);
    await waitForUp(client, healName, 'healed after the network returned');
    const attachment = await getAppContainerAttachment(client.container, healName);
    expect(attachment.attached).to.be.true;
    const r = await execInContainer(client.container, `cat ${markerPath(healName)}`);
    expect(r.stdout.trim(), 'appdata survives this heal too').to.equal('precious');
  });

  it('a node-wide detach is a docker fault: the storm guard refuses to rebuild the workload', async function () {
    this.timeout(120000);
    const ids = {};
    for (const comp of stormComps) {
      // eslint-disable-next-line no-await-in-loop
      await waitForUp(client, `${comp}_${stormName}`, `${comp} running before the storm`);
      // eslint-disable-next-line no-await-in-loop
      ids[comp] = await getAppContainerId(client.container, stormName, comp);
    }

    const afterId = client.getLastEventId();
    await Promise.all(stormComps.map((comp) => disconnectAppNetwork(client.container, stormName, comp)));

    await client.waitForEvent(
      'reconciler:actuated',
      (d) => d.action === 'networkDetachStorm' && d.identifier.endsWith(`_${stormName}`),
      60000,
      { afterId },
    );

    for (const comp of stormComps) {
      const compId = `${comp}_${stormName}`;
      // eslint-disable-next-line no-await-in-loop
      const nowId = await getAppContainerId(client.container, stormName, comp);
      expect(nowId, `${comp} must not be force-removed under a storm`).to.equal(ids[comp]);
      const destructive = actuationsSince(client, compId, afterId)
        .filter((d) => ['networkDetached', 'recreated'].includes(d.action));
      expect(destructive, `${comp}: no destructive actuation under the storm guard`).to.deep.equal([]);
    }

    // end the episode: reattach all three and let the parked re-checks observe it,
    // so the storm state cannot leak into the next test
    await Promise.all(stormComps.map((comp) => connectAppNetwork(client.container, stormName, comp)));
    await delay(10000);
  });

  it('a FluxOS restart mid-heal recreates from the durable flag: never tampering, never an uninstall', async function () {
    this.timeout(300000);
    await waitForUp(client, restartName, 'running before the mid-heal restart');

    // A recreate with genuinely nothing to run: black-holed registry now, local
    // image gone the moment the heal's remove unpins it (inside the pull-verify
    // window, the same race-free trick as suite 33).
    await env.containers.registry.stop({ remove: false, removeVolumes: false });

    const afterId = client.getLastEventId();
    await disconnectAppNetwork(client.container, restartName);
    await waitForReconcileActuated(client, restartId, 'networkDetached', 60000, { afterId });
    await waitFor(async () => !(await getAppContainerStatus(client.container, restartName, { all: true })),
      { timeout: 30000, interval: 500, label: 'heal removed the detached container' });
    await removeAppImage(client.container, `${REGISTRY_REPO_HOST}/${restartName}:v1`);
    await waitForReconcileActuated(client, restartId, 'networkHealRecreateFailed', 120000, { afterId });

    // FluxOS dies between the remove and a successful recreate. The durable
    // networkHealRemoval flag is the only memory that the absence was deliberate.
    await restartFluxos(client.container);

    // registry returns -> a paced heal attempt recreates; the app was never
    // uninstalled and its absence never recorded as a vanish
    await env.containers.registry.restart();
    const postRestartId = 0; // fresh process; assert on fresh events + end state
    await waitForHealRecreated(client, restartId, 180000, postRestartId);
    await waitForUp(client, restartName, 'recreated after the restart + registry return');

    const vanishedPath = client.getEventBuffer()
      .filter((e) => e.event === 'reconciler:actuated' && e.data.identifier === restartId)
      .filter((e) => e.data.action === 'recreated' && e.data.reason !== 'networkDetached');
    expect(vanishedPath, 'the absence must ride the heal path, never the vanished/tampering path').to.deep.equal([]);

    const installed = await client.getInstalledApps();
    expect(installed.status).to.equal('success');
    expect(installed.data.some((a) => a.name === restartName), 'the app must still be installed').to.be.true;
  });
});
