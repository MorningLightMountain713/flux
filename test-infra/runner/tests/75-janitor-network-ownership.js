import { expect } from 'chai';
import { describe, it, before, after } from 'mocha';
import { createTestEnv } from '../framework/test-env.js';
import {
  getAppContainerStatus, getAppNetwork, getAppNetworkSubnet, networkExists,
  stopAppContainer, createAppNetworkRaw, createNetworkNamed,
} from '../framework/container.js';
import { waitFor } from '../framework/wait.js';
import { bootAndPeer, seedSimpleApp } from '../framework/reconciler-suite.js';

// The janitor's debris sweep removes what this node holds for apps it does not
// have installed. It decides by OWNERSHIP, never by docker's idea of "unused" -
// docker calls a network unused the moment nothing is attached to it, which is
// true of every healthy app whose container is momentarily down (crash loop,
// restart, standby, operator stop). A sweep keyed on that reads a live app as
// debris, deletes its network, and leaves it unable to start at all.
//
// That is not hypothetical: it is what wedged a production app and what failed
// suite 31 - the janitor pruned a crash-looping app's network in the millisecond
// its container was down.
//
// The old guard against this was to skip the whole sweep whenever ANY installed
// component was not running, which on a real node meant it never ran and debris
// accumulated forever. Ownership scoping replaces it, so these tests also prove
// the sweep still does its job while an app sits stopped.

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// The sweeps are single-flight and publish their summary; wait for one to land
// rather than sleeping a guessed interval, so an assertion can never pass
// vacuously against a sweep that never ran.
async function waitForDebrisSweep(client, timeout, afterId) {
  return client.waitForEvent(
    'janitor:sweep',
    (d) => d.sweep === 'dockerDebris',
    timeout,
    { afterId },
  );
}

async function waitForUp(client, appName, label) {
  await waitFor(async () => {
    const status = await getAppContainerStatus(client.container, appName);
    return status && status.status.startsWith('Up');
  }, { timeout: 90000, interval: 2000, label });
}

describe('janitor reaps app networks by ownership, not by docker "unused"', function () {
  let env;
  let idx;
  let client;
  const appName = `e2ejanitor${Date.now()}`;

  before(async function () {
    this.timeout(420000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 10,
      tickerAutostart: false,
      configOverrides: {
        fluxapps: {
          // The debris sweep is a 6-hour cadence in the harness default, so it
          // fires once at boot and never again. Compress it so a test can watch
          // several sweeps pass over a deliberately-stopped app.
          dockerDebrisIntervalMs: 10000,
          // Keep the orphan sweep out of the way: it removes apps with no
          // installed row, which is a different contract and would tear down the
          // unowned network's app before the debris sweep is asked about it.
          orphanSweepIntervalMs: 3600000,
          crashBackoffDelaysMs: [0, 2000, 5000, 10000, 15000],
        },
      },
    });
    await bootAndPeer(env);
    ({ index: idx } = await seedSimpleApp(env, appName));
    client = env.clients[idx];
    await waitForUp(client, appName, 'app running before the sweeps');
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('keeps an installed app\'s network while its container is stopped', async function () {
    this.timeout(180000);
    const subnetBefore = await getAppNetworkSubnet(client.container, appName);
    expect(subnetBefore, 'the app network exists before the stop').to.be.a('string');

    // Stop the container: docker now reports the network as having nothing
    // attached, i.e. exactly what a prune would consider collectable.
    await stopAppContainer(client.container, appName, appName);
    await waitFor(async () => {
      const s = await getAppContainerStatus(client.container, appName, { all: true });
      return s && !s.status.startsWith('Up');
    }, { timeout: 60000, interval: 1000, label: 'container stopped' });

    // Two sweeps, so this cannot pass on a sweep that happened to miss the window.
    const afterId = client.getLastEventId();
    await waitForDebrisSweep(client, 60000, afterId);
    await waitForDebrisSweep(client, 60000, client.getLastEventId());

    const net = await getAppNetwork(client.container, appName);
    expect(net, 'an installed app keeps its network however long its container is down').to.not.equal(null);
    expect(await getAppNetworkSubnet(client.container, appName), 'and keeps the same subnet').to.equal(subnetBefore);
  });

  it('lets the app come back up on the network it never lost', async function () {
    this.timeout(180000);
    // The reconciler owns run state and wants it running again; the point here is
    // that the start has a network to attach to, which is what used to be lost.
    await waitForUp(client, appName, 'restarted after the sweeps');
    const subnet = await getAppNetworkSubnet(client.container, appName);
    expect(subnet, 'started onto a live network').to.be.a('string');
  });

  it('still reaps a network no installed app owns - the sweep is not simply disabled', async function () {
    this.timeout(180000);
    // A leftover from an app this node does not have installed: what an
    // interrupted uninstall leaves, or what a restored node comes back with.
    const orphanName = `e2eorphan${Date.now()}`;
    const mk = await createAppNetworkRaw(client.container, orphanName, '172.23.199.0/24');
    expect(mk.exitCode, `could not create the orphan network: ${mk.output}`).to.equal(0);
    expect(await getAppNetwork(client.container, orphanName), 'orphan network is there to begin with').to.not.equal(null);

    const afterId = client.getLastEventId();
    await waitForDebrisSweep(client, 60000, afterId);
    // The reap runs inside the sweep, so give the removal itself a moment rather
    // than racing the event that announces the sweep completed.
    await waitFor(
      async () => (await getAppNetwork(client.container, orphanName)) === null,
      { timeout: 60000, interval: 2000, label: 'orphan network reaped' },
    );

    // and the live app's network is still untouched by that same sweep
    expect(await getAppNetwork(client.container, appName), 'reaping an orphan never touches an owned network').to.not.equal(null);
  });

  it('leaves a network it cannot attribute to any app', async function () {
    this.timeout(180000);
    // Nothing names an owner here: no ownership label, and a name close enough to
    // be swept up by the flux name filter but NOT following the per-app
    // convention, so no app name can be read out of it. Absence of an owner is
    // not evidence of absence of an owner, so the sweep declines rather than
    // guesses - the estate is entirely unlabelled after an upgrade.
    const oddball = 'fluxDockerNetworkOddball';
    const mk = await createNetworkNamed(client.container, oddball, '172.23.198.0/24');
    expect(mk.exitCode, `could not create the unattributable network: ${mk.output}`).to.equal(0);

    const afterId = client.getLastEventId();
    await waitForDebrisSweep(client, 60000, afterId);
    await delay(5000);

    expect(await networkExists(client.container, oddball), 'what it cannot attribute, it leaves alone').to.be.true;
  });

  it('never removes the node-wide flux network', async function () {
    this.timeout(180000);
    // Only ever created through the admin API, so a harness node has none until
    // we make one. It shares the app networks' name prefix, which is exactly why
    // the sweep has to recognise it rather than read it as an app called "".
    const mk = await createNetworkNamed(client.container, 'fluxDockerNetwork', '172.23.0.0/24');
    expect(mk.exitCode, `could not create the node-wide network: ${mk.output}`).to.equal(0);

    const afterId = client.getLastEventId();
    await waitForDebrisSweep(client, 60000, afterId);
    await delay(5000);

    expect(await networkExists(client.container, 'fluxDockerNetwork'), 'the node-wide network is not an app network').to.be.true;
  });
});
