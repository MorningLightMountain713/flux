import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { nodeKey } from '../framework/keys.js';
import { buildAppSpec, registerAndConfirm } from '../framework/app-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { advanceBlock, advanceBlocks, startTicker, stopTicker } from '../framework/daemon-control.js';
import {
  waitForDaemonReady, waitForNodeStatus, waitForBlockProcessed,
  waitForOrchestratorState, waitForAppSpecStored, assertNoEvent, waitFor,
} from '../framework/wait.js';
import { getAppContainerStatus } from '../framework/container.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';

// A registry outage during a fresh install is a NODE condition, not a verdict on
// the app: the install DEFERS (spawner retries next cycle) instead of FAILING.
// Nothing is stored or broadcast - a fluxappinstallingerror from a node that
// merely couldn't reach the registry would count toward the network-wide >=5
// error gate and could suppress a healthy app. When the registry returns, the
// deferred app installs with no operator action and no bench to expire.

const REGISTRY = REGISTRY_REPO_HOST;

async function bootToSpawnerReady(env) {
  for (const c of env.clients) await waitForDaemonReady(c);
  await Promise.all(env.clients.map((c) => waitForNodeStatus(c, (d) => d.confirmed === true, 30000)));
  await advanceBlock();
  for (const c of env.clients) {
    await waitForBlockProcessed(c, (d) => d.height > 2100000, 50000);
  }
  await env.startDiscovery();
  await env.clients[0].waitForEvent('peers:added', (d) => d.outbound >= 4, 120000);
  await env.clients[0].waitForEvent('peers:added', (d) => d.inbound >= 2, 120000);
  await startTicker();
  await advanceBlocks(260);
  await waitForOrchestratorState(env.clients[0], 'READY', 120000);
}

describe('Spawner: a registry outage during install defers, never fails or broadcasts', function () {
  let env;
  const appName = `e2eregout${Date.now()}`;
  const repoName = appName;
  dumpLogsOnFailure(() => env);

  before(async function () {
    this.timeout(600000);
    env = await createTestEnv({ hookCtx: this, nodes: 10, tickerAutostart: false });
    // the image must exist in the registry BEFORE the outage, so the recovery
    // half of the test has something real to install
    await pushImage(repoName, 'v1');
    await bootToSpawnerReady(env);

    const spec = buildAppSpec({
      name: appName,
      instances: 3,
      compose: [{
        name: appName,
        description: 'app registered across a registry outage',
        repotag: `${REGISTRY}/${repoName}:v1`,
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

    // stop the registry BEFORE the spec lands: every spawn attempt during the
    // outage hits the black hole at the verify step (transient class -> DEFER)
    await env.containers.registry.stop({ remove: false, removeVolumes: false });

    const result = await registerAndConfirm(env.clients[0].url, nodeKey(1), spec, env.clients);
    expect(result.status).to.equal('success');
    await waitForBlockProcessed(env.clients[0], (d) => d.height >= result.targetHeight, 60000);
    await waitForAppSpecStored(env.clients[0], appName);
  });

  after(async function () {
    this.timeout(30000);
    await stopTicker().catch(() => {});
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
    await env.containers.registry.restart();

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
