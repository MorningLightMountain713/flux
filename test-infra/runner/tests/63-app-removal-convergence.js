import {
  describe, it, before, after,
} from 'mocha';
import { createTestEnv } from '../framework/test-env.js';
import { authenticate } from '../auth.js';
import { appOwnerKey } from '../framework/keys.js';
import { bootAndPeer, installOnNodes } from '../framework/reconciler-suite.js';
import { buildSeedableTestApp } from '../framework/seed-helper.js';
import { pushTestApp } from '../framework/registry-helper.js';
import { dbClient } from '../framework/db-client.js';
import {
  pauseDockerd, resumeDockerd, restartFluxos,
} from '../framework/container.js';
import { waitForUp, waitForAppFullyGone } from '../framework/wait.js';

// Removal is a converged reconciler desired state ("gone"), not a one-shot job. Every
// permanent removal writes a durable owed-teardown record before deleting the local row;
// the reconciler drives that record to completion (container + docker network + appdata
// volume all gone) and RE-DRIVES it with backoff if a pass leaves work owed - instead of
// abandoning a partial teardown until the next boot.
//
// This suite proves the convergence end-to-end on a real node, against real docker/mongo.
// The lever is a genuine docker OUTAGE held open with pauseDockerd: a teardown that runs
// while docker is down cannot remove its container and cannot confirm it gone, so it
// leaves a SURVIVOR (never delete on uncertainty) and hands it to the reconciler - the
// deterministic way to provoke a partial teardown now that the reconcile-start race
// converges in one pass. Non-arcane (no flux-shutdownd): the stop short-circuits, so the
// outage isolates the container-removal path.
const NODES = 5;
const NODE_IDX = 0; // install + drive every scenario on node 0

describe('app removal converges to fully gone via the reconciler', function () {
  let env;
  let client;

  before(async function () {
    this.timeout(600000);
    // arcane:false is the suite's premise (see the design comment above): the
    // legacy stop short-circuit keeps flux-shutdownd out of the teardown, so the
    // docker outage isolates the container-removal path this suite proves.
    env = await createTestEnv({
      hookCtx: this, nodes: NODES, tickerAutostart: false, arcane: false,
    });
    await bootAndPeer(env, { minOutbound: 2, minInbound: 1 });
    client = env.clients[NODE_IDX];
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  // Install a plain app on node 0, then drop its global spec so the spawner can never
  // respawn it - the test then observes ONLY the teardown convergence, not re-placement.
  async function installLocalOnly(name) {
    await pushTestApp(name);
    const app = await buildSeedableTestApp({ name, exitCode: 0 });
    await installOnNodes(env, app, [NODE_IDX]);
    await waitForUp(client, name, `${name} running before removal`);
    await dbClient(NODE_IDX + 1).deleteGlobalAppSpec(name);
  }

  const ownerAuth = () => authenticate(client.url, appOwnerKey());
  // reconciler:actuated events carry the component identifier; match on the app substring
  // so the exact component-id shape (flat vs composed) doesn't matter.
  const removalEvent = (name, action, afterId, timeout = 120000) => client.waitForEvent(
    'reconciler:actuated',
    (d) => typeof d.identifier === 'string' && d.identifier.includes(name) && d.action === action,
    timeout,
    { afterId },
  );

  it('re-drives an owed teardown to fully gone after a docker outage, with no restart', async function () {
    this.timeout(300000);
    const name = `rmconv${Date.now()}`;
    await installLocalOnly(name);
    // grab auth BEFORE the outage: the node's login-phrase endpoint needs docker
    const auth = await ownerAuth();
    const afterId = client.getLastEventId();

    // hold a real docker outage across the removal: the teardown's remove + presence-check
    // fail, so it leaves a survivor and hands the owed teardown to the reconciler.
    await pauseDockerd(client.container);
    await client.removeApp(name, { zelidauth: auth.zelidauth }).catch(() => {});

    // the reconciler owns the owed teardown now and keeps re-driving it while docker is down
    await removalEvent(name, 'removalDeferred', afterId, 90000);

    // restore docker; the reconciler's next re-drive converges to FULLY gone - no restart,
    // no waiting for the next boot.
    await resumeDockerd(client.container);
    await removalEvent(name, 'removed', afterId, 150000);
    await waitForAppFullyGone(client, name);
  });

  it('boot recovery hands an interrupted teardown to the reconciler, converging to fully gone', async function () {
    this.timeout(300000);
    const name = `rmboot${Date.now()}`;
    await installLocalOnly(name);
    // grab auth BEFORE the outage: the node's login-phrase endpoint needs docker
    const auth = await ownerAuth();
    const afterId = client.getLastEventId();

    // interrupt a teardown mid-flight: the outage leaves a survivor, so an owed record
    // persists past the removal call.
    await pauseDockerd(client.container);
    await client.removeApp(name, { zelidauth: auth.zelidauth }).catch(() => {});
    await removalEvent(name, 'removalDeferred', afterId, 90000);

    // restart FluxOS (in-memory state wiped) while the teardown is still owed AND docker is
    // still down: boot recovery must re-enqueue the owed teardown for the reconciler rather
    // than abandon it. Restoring docker then lets the reconciler-driven teardown converge.
    await restartFluxos(client.container);
    await resumeDockerd(client.container);

    // proven by the real end state - the event id space resets across a restart, so assert
    // the outcome, not an event: nothing of the app remains on the node.
    await waitForAppFullyGone(client, name, { timeout: 180000 });
  });
});
