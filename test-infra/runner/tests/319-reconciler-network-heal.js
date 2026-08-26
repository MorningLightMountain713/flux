// weight: heavy
import { expect } from 'chai';
import { describe, it, before, after } from 'mocha';
import { createTestEnv } from '../framework/test-env.js';
import {
  getAppContainerStatus, getAppContainerId, getAppContainerAttachment,
  disconnectAppNetwork, connectAppNetwork,
  getAppNetwork, getAppNetworkSubnet, removeAppNetworkRaw, stopAndPruneAppNetwork,
  removeAppImage, restartFluxos, execInContainer,
} from '../framework/container.js';
import { waitFor, waitForReconcileActuated } from '../framework/wait.js';
import {
  bootAndPeer, seedSimpleApp, installOnNodes,
} from '../framework/reconciler-suite.js';
import { buildSeedableApp } from '../framework/seed-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';

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
  let idx;
  let client;
  const healName = `e2eheal${Date.now()}`;
  const healId = `${healName}_${healName}`;
  const stormName = `e2estorm${Date.now()}`;
  const stormComps = ['www', 'api', 'db'];
  const restartName = `e2ehealboot${Date.now()}`;
  const restartId = `${restartName}_${restartName}`;
  const stopName = `e2ehealstop${Date.now()}`;
  const stopId = `${stopName}_${stopName}`;
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

    // The stopped-container app: exercises the state no recreate path observes -
    // container present but not running, network gone underneath it.
    await pushImage(stopName, 'v1');
    const stopApp = await buildSeedableApp({
      name: stopName,
      compose: [{
        name: stopName,
        description: 'stopped-with-pruned-network component',
        repotag: `${REGISTRY_REPO_HOST}/${stopName}:v1`,
        ports: [31116],
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
    await installOnNodes(env, stopApp, [idx]);
    await waitForReconcileActuated(client, stopId, 'firstRunProven', 90000);
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

  it('rebuilds its own missing network and heals - no operator restore needed', async function () {
    this.timeout(120000);
    await waitForUp(client, healName, 'running before the prune');
    expect(await getAppNetworkSubnet(client.container, healName), 'the app network must exist before the prune').to.be.a('string');

    const afterId = client.getLastEventId();
    await disconnectAppNetwork(client.container, healName);
    const rm = await removeAppNetworkRaw(client.container, healName);
    expect(rm.exitCode, `network rm failed: ${rm.output}`).to.equal(0);

    // The network exists because the app is installed, so the node rebuilds it
    // rather than parking until somebody restores it. Nothing below recreates
    // the network by hand - that is the point of the test.
    await waitForReconcileActuated(client, healId, 'networkPruned', 60000, { afterId });
    await waitForHealRecreated(client, healId, 90000, afterId);
    await waitForUp(client, healName, 'healed on its own after the network was pruned');

    expect(await getAppNetworkSubnet(client.container, healName), 'the node rebuilt the network itself').to.be.a('string');
    const attachment = await getAppContainerAttachment(client.container, healName);
    expect(attachment.attached, 'and the container came back attached to it').to.be.true;
    const r = await execInContainer(client.container, `cat ${markerPath(healName)}`);
    expect(r.stdout.trim(), 'appdata survives this heal too').to.equal('precious');
  });

  it('starts a STOPPED container whose network was pruned - the state that wedged forever', async function () {
    this.timeout(150000);
    // The production wedge, and suite 31's failure. A container that exists but is
    // not running never reaches a recreate path, so nothing used to re-ensure its
    // network: every start failed "network not found" and it backed off forever.
    await waitForUp(client, stopName, 'running before the stop');

    const afterId = client.getLastEventId();
    // The premise is a state the product REPAIRS, not one it leaves alone:
    // controllerDesired is running and the crash-backoff ladder starts at 0ms, so the
    // reconciler restarts this container as soon as it sees it stop. Stopping and then
    // pruning in two calls leaves a round trip for a pass to land in, and when one did
    // the rm failed `has active endpoints` — the container measured `Up 8 seconds` at
    // that moment, so the message meant "it is running again", never a slow endpoint
    // release. Both halves go in one exec, and losing anyway is retried rather than
    // asserted on: sampling a transient state is what this is, and the alternative is
    // asserting against whichever state we happened to land in.
    // Sized against the restart ladder, not picked. Every lost attempt is another
    // restart, which walks the reconciler further down crashBackoffDelaysMs — so each
    // attempt faces a WIDER window than the last, and the loop converges because the
    // product's own backoff opens the door. The ladder is five long; a run with the
    // window deliberately widened to 8s needed all five, so the bound sits above it.
    let pruned = { ok: false, output: 'not attempted' };
    let attempts = 0;
    for (; attempts < 8 && !pruned.ok; attempts += 1) {
      // eslint-disable-next-line no-await-in-loop
      pruned = await stopAndPruneAppNetwork(client.container, stopName, stopName);
    }
    expect(pruned.ok, `could not catch the app stopped with its network pruned in ${attempts} attempts: ${pruned.output}`).to.be.true;
    // Say when the race actually fired: a retry nobody can see is a retry nobody
    // knows is load-bearing, and a quiet run would hide the loop rotting.
    if (attempts > 1) console.log(`# stopped+pruned on attempt ${attempts} (the reconciler won the earlier ones)`);
    expect(await getAppNetwork(client.container, stopName), 'the network really is gone').to.equal(null);

    // The controller still wants it running, so the next pass must rebuild the
    // network and start the EXISTING container - no recreate, no uninstall.
    await waitForUp(client, stopName, 'started again on a rebuilt network');
    expect(await getAppNetworkSubnet(client.container, stopName), 'the network was rebuilt').to.be.a('string');
    const attachment = await getAppContainerAttachment(client.container, stopName);
    expect(attachment.attached).to.be.true;

    const acts = actuationsSince(client, stopId, afterId);
    expect(acts.some((a) => a.action === 'uninstalled'), 'a missing network must never escalate to an uninstall').to.be.false;
  });

  it('a node-wide detach is a docker fault: the storm guard refuses to rebuild the workload', async function () {
    this.timeout(120000);
    const ids = {};
    for (const comp of stormComps) {
      // eslint-disable-next-line no-await-in-loop
      await waitForUp(client, stormName, `${comp} running before the storm`);
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

    // A recreate with genuinely nothing to run: black-holed registry, and the
    // image UNTAGGED while the container still runs (rmi -f unties the tag;
    // the layers stay pinned by ID under the live container, and the recreate
    // pulls by tag). Staged BEFORE the detach: the heal runs remove->recreate
    // inside one pass, so there is no observable removed-but-not-recreated
    // window to sequence an image removal into - both gates lost that race,
    // each at a different sample point.
    await env.containers.registry.stop({ remove: false, removeVolumes: false });
    await removeAppImage(client.container, `${REGISTRY_REPO_HOST}/${restartName}:v1`);

    const afterId = client.getLastEventId();
    await disconnectAppNetwork(client.container, restartName);
    await waitForReconcileActuated(client, restartId, 'networkDetached', 60000, { afterId });
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
