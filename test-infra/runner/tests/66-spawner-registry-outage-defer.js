import { describe, it, before, after } from 'mocha';
import { createTestEnv } from '../framework/test-env.js';
import { buildSeedableApp } from '../framework/seed-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { assertNoEvent, waitFor } from '../framework/wait.js';
import { getAppContainerStatus, pauseHostContainer, unpauseHostContainer } from '../framework/container.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { dbClient } from '../framework/db-client.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';

// A registry outage during a fresh install is a NODE condition, not a verdict on
// the app: the install DEFERS (spawner retries next cycle) instead of FAILING.
// Nothing is stored or broadcast - a fluxappinstallingerror from a node that
// merely couldn't reach the registry would count toward the network-wide >=5
// error gate and could suppress a healthy app. When the registry returns, the
// deferred app installs with no operator action and no bench to expire.
//
// The spec is db-seeded (not API-registered): registration itself verifies the
// image against the registry, so it cannot happen during the outage - and
// seeding after the registry stops also means the spawner's first-ever look at
// this app is already inside the outage (no install-before-outage race).

describe('Spawner: a registry outage during install defers, never fails or broadcasts', function () {
  let env;
  const appName = `e2eregout${Date.now()}`;
  dumpLogsOnFailure(() => env);

  before(async function () {
    this.timeout(600000);
    // Compress the transient re-ask pace (prod 2min; the verification cache and
    // the spawner back-off stack to 2x): the recovery half must converge within
    // its wait, not sit out prod-scale pacing. Threshold only.
    env = await createTestEnv({
      hookCtx: this,
      nodes: 10,
      tickerAutostart: false,
      configOverrides: { fluxapps: { registryTransientBackoffMs: 8000 } },
    });
    // the image must reach the registry's store BEFORE the outage, so the
    // recovery half of the test has something real to install
    await pushImage(appName, 'v1');
    await bootAndPeer(env);

    // Black-hole the registry, THEN make the app visible. Pause, not stop: a
    // real registry outage leaves DNS intact and stops answering - stop() would
    // deregister the docker alias, and the node's FIRST lookup (the spec is only
    // seeded now) would negative-cache the DNS miss past the recovery.
    await pauseHostContainer(env.containers.registry);

    const app = await buildSeedableApp({
      name: appName,
      compose: [{
        name: appName,
        description: 'app seeded across a registry outage',
        repotag: `${REGISTRY_REPO_HOST}/${appName}:v1`,
        ports: [39333],
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
    for (let i = 1; i <= env.nodeCount; i += 1) {
      const dc = dbClient(i);
      // eslint-disable-next-line no-await-in-loop
      await dc.seedGlobalAppSpec(app.spec);
      // eslint-disable-next-line no-await-in-loop
      await dc.seedPermanentMessage(app.permanentMessage);
      // eslint-disable-next-line no-await-in-loop
      await dc.seedAppHash(app.hash, app.permanentMessage.height, true);
    }
  });

  after(async function () {
    this.timeout(30000);
    // docker refuses to stop a paused container - make teardown unconditional
    await unpauseHostContainer(env.containers.registry).catch(() => { /* already unpaused */ });
    await env?.teardown();
  });

  it('defers through the outage: no install failure, no error broadcast, no install', async function () {
    // the window must cover at least one full spawn attempt: candidate selection
    // plus the verifier's 20s socket timeout against the black-holed registry
    this.timeout(180000);
    await Promise.all(env.clients.map((c) => Promise.all([
      assertNoEvent(c, 'spawner:installFailed', (d) => d.appName === appName, 90000),
      assertNoEvent(c, 'network:appinstallingerror', (d) => d.name === appName, 90000),
      assertNoEvent(c, 'app:installed', (d) => d.name === appName, 90000),
    ])));
  });

  it('installs cleanly once the registry returns - no bench to expire, no operator action', async function () {
    this.timeout(300000);
    await unpauseHostContainer(env.containers.registry);

    // the next spawn cycle picks the app back up (DEFERRED = retry next cycle,
    // not the 7-day bench) and the install runs to a proven first start
    const installed = await Promise.any(env.clients.map(async (c, i) => {
      await c.waitForEvent('app:installed', (d) => d.name === appName, 240000);
      return i;
    }));
    const client = env.clients[installed];
    await waitFor(async () => {
      const status = await getAppContainerStatus(client.container, appName);
      return status && status.status.startsWith('Up');
    }, { timeout: 90000, interval: 2000, label: `${appName} running after the registry returned` });
  });
});
