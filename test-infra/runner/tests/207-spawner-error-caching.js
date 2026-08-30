// weight: light
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { nodeKey } from '../framework/keys.js';
import { buildAppSpec, registerAndConfirm } from '../framework/app-helper.js';
import { buildSeedableApp } from '../framework/seed-helper.js';
import { pushBrokenImage, pushImage } from '../framework/registry-helper.js';
import { advanceBlock, advanceBlocks, startTicker, stopTicker } from '../framework/daemon-control.js';
import {
  waitForDaemonReady, waitForNodeStatus, waitForBlockProcessed,
  waitForOrchestratorState, waitForAppSpecStored,
} from '../framework/wait.js';
import { dbClient } from '../framework/db-client.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';

const REGISTRY = REGISTRY_REPO_HOST;

async function bootToSpawnerReady(env) {
  for (const c of env.clients) await waitForDaemonReady(c);
  await Promise.all(env.clients.map((c) => waitForNodeStatus(c, (d) => d.confirmed === true, 30000)));
  await advanceBlock();
  for (const c of env.clients) {
    await waitForBlockProcessed(c, (d) => d.height > 2100000, 50000);
  }
  await env.startDiscovery();
  await env.clients[0].waitForEvent('peers:added', (d) => d.total >= 6, 120000);
  await startTicker();
  // Advance past the 250-block threshold so orchestrator reaches READY via block fallback
  await advanceBlocks(260);
  await waitForOrchestratorState(env.clients[0], 'READY', 120000);
}

describe('Spawner error caching: local install failure', function () {
  let env;
  const appName = `e2eBroken${Date.now()}`;
  const repoName = 'broken-app';
  const brokenRepotag = `${REGISTRY}/${repoName}:v1`;

  before(async function () {
    this.timeout(300000);
    env = await createTestEnv({ hookCtx: this, nodes: 10, tickerAutostart: false });
    await pushBrokenImage(repoName, 'v1');
    await bootToSpawnerReady(env);

    const spec = buildAppSpec({
      name: appName,
      instances: 3,
      compose: [{
        name: appName,
        description: 'broken test app',
        repotag: brokenRepotag,
        ports: [39111],
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

  it('should emit installFailed event after broken app install attempt', async function () {
    this.timeout(180000);
    const event = await Promise.any(
      env.clients.map((c) => c.waitForEvent(
        'spawner:installFailed',
        (d) => d.appName === appName,
        170000,
      )),
    );
    expect(event.data.appName).to.equal(appName);
    expect(event.data.hash).to.be.a('string');
  });

  it('should broadcast install error to other nodes', async function () {
    this.timeout(60000);
    const received = await Promise.any(
      env.clients.map((c) => c.waitForEvent(
        'network:appinstallingerror',
        (d) => d.name === appName,
        50000,
      )),
    );
    expect(received.data.name).to.equal(appName);
  });

  it('should not retry the app on the node that failed (7-day cache)', async function () {
    this.timeout(60000);
    let failedNodeIdx = -1;
    for (let i = 0; i < env.clients.length; i++) {
      const buf = env.clients[i].getEventBuffer();
      if (buf.some((e) => e.event === 'spawner:installFailed' && e.data.appName === appName)) {
        failedNodeIdx = i;
        break;
      }
    }
    expect(failedNodeIdx).to.be.gte(0, 'should have found a node with installFailed');

    const mark = env.clients[failedNodeIdx].getLastEventId();
    await new Promise((r) => { setTimeout(r, 30000); });

    const buf = env.clients[failedNodeIdx].getEventBuffer();
    const retries = buf.filter(
      (e) => e.id > mark && e.event === 'spawner:installFailed' && e.data.appName === appName,
    );
    expect(retries.length).to.equal(0, 'failed node should not retry the app');
  });
});

// TODO: re-enable once error classification (transient vs permanent) is implemented.
// Network-wide error blocking disabled — spawner now logs+emits but does not skip.
// See dev/app-state-sync/installing-errors-analysis.md for redesign plan.
describe('Spawner error caching: network-wide error skip', function () {
  let env;
  const appName = `e2eNetErr${Date.now()}`;
  const goodRepoName = 'good-app';
  const goodRepotag = `${REGISTRY}/${goodRepoName}:v1`;
  let appHash;

  before(async function () {
    this.timeout(300000);
    env = await createTestEnv({ hookCtx: this, nodes: 10, tickerAutostart: false });
    await pushImage(goodRepoName, 'v1');
    await bootToSpawnerReady(env);

    // Db-seeded, NOT API-registered, and errors FIRST: the gate is only consulted
    // while an app is a fresh candidate. A registered app is visible to the
    // spawner the moment its spec stores - it gets engaged (deferrals, install
    // attempts, installing broadcasts) before the error docs land, and every
    // later pass filters it upstream of the gate, which is then never evaluated
    // again. Seeding errors before the spec exists makes the first-ever look at
    // the app hit an armed gate.
    const app = await buildSeedableApp({
      name: appName,
      instances: 3,
      compose: [{
        name: appName,
        description: 'good test app for network error test',
        repotag: goodRepotag,
        ports: [39222],
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
    appHash = app.hash;

    for (let n = 1; n <= env.nodeCount; n += 1) {
      const db = dbClient(n);
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await db.seedInstallingError({
          name: appName,
          hash: appHash,
          ip: `10.0.0.${i + 1}`,
          error: `simulated failure ${i + 1}`,
          broadcastedAt: Date.now(),
        });
      }
    }

    for (let n = 1; n <= env.nodeCount; n += 1) {
      const dc = dbClient(n);
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
    await stopTicker().catch(() => {});
    await env?.teardown();
  });

  it('should emit networkErrorSkip when error count >= 5', async function () {
    this.timeout(180000);
    // precondition, not paranoia: the event wait below can only mean "the gate
    // never fired" if the seeded docs are provably visible under this hash
    const seeded = await dbClient(1).countInstallingErrors(appHash);
    expect(seeded, `seeded install-error docs visible for hash ${appHash}`).to.be.gte(5);
    const event = await Promise.any(
      env.clients.map((c) => c.waitForEvent(
        'spawner:networkErrorSkip',
        (d) => d.appName === appName,
        170000,
      )),
    );
    expect(event.data.appName).to.equal(appName);
    expect(event.data.errorCount).to.be.gte(5);
  });

  it('should not have installed the app on the skipping node', async function () {
    this.timeout(10000);
    let skipNodeIdx = -1;
    for (let i = 0; i < env.clients.length; i++) {
      const buf = env.clients[i].getEventBuffer();
      if (buf.some((e) => e.event === 'spawner:networkErrorSkip' && e.data.appName === appName)) {
        skipNodeIdx = i;
        break;
      }
    }
    expect(skipNodeIdx).to.be.gte(0);

    const buf = env.clients[skipNodeIdx].getEventBuffer();
    const installed = buf.some((e) => e.event === 'app:installed' && e.data.name === appName);
    expect(installed).to.equal(false, 'app should not have been installed on skipping node');
  });

  it('skips without a local install attempt - the shared error docs are the backoff, no local failure drawn', async function () {
    this.timeout(10000);
    let skipNodeIdx = -1;
    for (let i = 0; i < env.clients.length; i++) {
      const buf = env.clients[i].getEventBuffer();
      if (buf.some((e) => e.event === 'spawner:networkErrorSkip' && e.data.appName === appName)) {
        skipNodeIdx = i;
        break;
      }
    }
    expect(skipNodeIdx).to.be.gte(0);

    const buf = env.clients[skipNodeIdx].getEventBuffer();
    const localFailed = buf.some((e) => e.event === 'spawner:installFailed' && e.data.appName === appName);
    expect(localFailed).to.equal(false, 'network error skip should not trigger local install failure event');
  });
});
