// fleet: 8
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { pushTestApp } from '../framework/registry-helper.js';
import { buildSeedableTestApp } from '../framework/seed-helper.js';
import { bootAndPeer, seedSpawnerApp, waitForInstanceCount } from '../framework/reconciler-suite.js';
import { waitFor, assertNoEvent } from '../framework/wait.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

// An app that cannot run is rolled back wherever it is tried, and once the
// network knows it fails, no node places it again.
//
// An install ends in a trial: the reconciler starts each component, and one that
// never completes a successful run within the trial's start attempts fails it
// (appReconciler failConvergeIfExhausted). The installer then broadcasts an
// install error for the app's hash and uninstalls it (appInstaller, "provisioned
// but did not converge"), and the node's spawner caches the hash as failed. A node
// that has not tried the app refuses it once it holds five install errors for the
// hash (appSpawner, `errorCount >= 5`). Without both halves an app that cannot
// run keeps spreading: on mainnet in September 2026 one app whose daemon could
// not start reached 618 nodes against an `instances` of 30.
const INSTANCES = 2;
// The network's refusal threshold (appSpawner `errorCount >= 5`).
const ERROR_THRESHOLD = 5;
// Trials run INSTANCES at a time (running + installing >= instances holds the rest
// off), so failures arrive in pairs: 2, 4, then 6 >= ERROR_THRESHOLD. Six nodes
// try; eight leaves two that must refuse on the network's count alone.
const NODES = 8;
// Three rounds of trials in series. One round, selection to rollback, takes
// about 50s on a gate box at load 15-18; 480s allows each round 160s.
const SETTLE_MS = 480_000;
// Long enough for a node that refuses the app to be offered it on several spawner
// passes (asserted below), not merely once.
const HOLD_MS = 120_000;

const verdictsOf = (client, appName, afterId) => client.getEventBuffer().filter((e) => e.id > afterId
  && ((e.event === 'app:installOutcome' && e.data?.name === appName && e.data?.outcome === 'failed')
    || (e.event === 'spawner:networkErrorSkip' && e.data?.appName === appName)));

describe('an app that cannot run is rolled back and not placed again', function () {
  let env;
  dumpLogsOnFailure(() => env);

  before(async function () {
    this.timeout(420_000);
    env = await createTestEnv({ hookCtx: this, nodes: NODES, tickerAutostart: false });
    await bootAndPeer(env);
  });

  after(async function () {
    this.timeout(30_000);
    await env?.teardown();
  });

  it('rolls back every trial, and the network refuses the app once it knows', async function () {
    this.timeout(SETTLE_MS + HOLD_MS + 240_000);
    const appName = `e2eheld${Date.now()}`;
    await pushTestApp(appName);
    // Starts, then is gone in 50ms, on every node, for ever: no start ever
    // completes a successful run, so every trial fails.
    const app = await buildSeedableTestApp({
      name: appName, instances: INSTANCES, exitCode: 1, exitAfterMs: 50,
    });
    const seededAt = env.clients.map((c) => c.getLastEventId());
    await seedSpawnerApp(env, app);

    // Every node reaches a verdict: its own trial failed, or it refused the app on
    // the network's count. A node that failed never offers the app again, so no
    // node carries both.
    let firstVerdicts;
    await waitFor(async () => {
      firstVerdicts = env.clients.map((c, i) => verdictsOf(c, appName, seededAt[i])[0]);
      return firstVerdicts.every(Boolean);
    }, { timeout: SETTLE_MS, interval: 3000, label: `every node's verdict on ${appName}` });

    const tried = firstVerdicts.flatMap((e, i) => (e.event === 'app:installOutcome' ? [i] : []));
    const refused = firstVerdicts.flatMap((e, i) => (e.event === 'spawner:networkErrorSkip' ? [i] : []));
    expect(tried.length, `nodes whose trial failed: [${tried}]`).to.be.at.least(ERROR_THRESHOLD);
    expect(refused, 'a node that never tried the app refuses it').to.not.be.empty;
    refused.forEach((i) => {
      expect(firstVerdicts[i].data.errorCount, `node ${i} refused on the network's count`)
        .to.be.at.least(ERROR_THRESHOLD);
    });

    // A node publishes app:installed before its trial runs, so the "never placed
    // again" window opens at that node's verdict.
    const verdictIds = firstVerdicts.map((e) => e.id);
    await Promise.all([
      waitForInstanceCount(env, appName, 0, { timeout: 30_000, stableMs: HOLD_MS, exact: true }),
      ...env.clients.map((c, i) => assertNoEvent(
        c, 'app:installed', (d) => d.name === appName, HOLD_MS, { afterId: verdictIds[i] },
      )),
    ]);

    // Canary for the window: a refusing node was offered the app, and refused it,
    // on more than one spawner pass inside it.
    refused.forEach((i) => {
      const skips = verdictsOf(env.clients[i], appName, verdictIds[i])
        .filter((e) => e.event === 'spawner:networkErrorSkip');
      expect(skips.length, `node ${i} refusals after its first`).to.be.at.least(1);
    });
  });
});
