// weight: heavy
import { describe, it, before, after } from 'mocha';
import { createTestEnv } from '../framework/test-env.js';
import { getAppContainerStatus, killAppContainer, removeAppImage } from '../framework/container.js';
import { waitFor, waitForReconcileActuated } from '../framework/wait.js';
import { bootAndPeer, seedSimpleApp } from '../framework/reconciler-suite.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';

// A vanished container (docker emits destroy; no die fires for absence) is recreated
// by the reconciler when Docker is reachable. When the registry cannot be REACHED
// (transient-class failure) but the image is still on disk, the rebuild uses the
// LOCAL copy - an outage never keeps a runnable app down. Only when there is
// genuinely nothing to run (registry unreachable AND no local image) does the
// §14.5 disposition apply: a component that has PROVEN a run here is never
// destroyed by a failed rebuild. It degrades to down, keeps retrying on the crash
// ladder, and self-heals when the image returns - a broken registry must not
// delete an established app and its data. (Only a never-proven fresh install is
// removed on recreate failure; that verdict belongs to the install trial.)

async function waitForUp(client, appName, label) {
  await waitFor(async () => {
    const status = await getAppContainerStatus(client.container, appName);
    return status && status.status.startsWith('Up');
  }, { timeout: 60000, interval: 2000, label });
}

describe('reconciler recreates a missing container', function () {
  let env;
  let idx;
  const appName = `e2emissing${Date.now()}`;
  const identifier = `${appName}_${appName}`;

  before(async function () {
    this.timeout(300000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 10,
      tickerAutostart: false,
      // Recreate-failure retries and the post-recreate start pace on the crash
      // ladder; at prod rungs (30s/5m) the self-heal assertion would sit minutes
      // in backoff. The stopped registry is a TCP black hole (freed IP), so the
      // failure surfaces at the verifier's 20s socket timeout - which classes it
      // transient. The provision ceiling must NOT fire first (its error reads
      // permanent and would flip the disposition), so it sits above the verify
      // timeout. Thresholds only - ladder shape and recreate flow are unchanged.
      configOverrides: {
        fluxapps: {
          crashBackoffDelaysMs: [0, 2000, 5000, 10000, 15000],
          recreateProvisionCapMs: 60000,
        },
      },
    });
    await bootAndPeer(env);
    ({ index: idx } = await seedSimpleApp(env, appName));
    // The app must be PROVEN before any tampering: an unproven app is still inside
    // its install trial, where an external kill counts toward the trial's bounded
    // start attempts and draws a rollback verdict — not this suite's subject.
    await waitForReconcileActuated(env.clients[idx], identifier, 'firstRunProven', 60000);
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('recreates a container that was removed out from under it', async function () {
    this.timeout(150000);
    const client = env.clients[idx];
    await waitForUp(client, appName, 'running before removal');

    const afterId = client.getLastEventId();
    await killAppContainer(client.container, appName); // docker rm -f -> gone

    // docker is reachable, so exists:false is a genuine miss -> recreate
    await waitForReconcileActuated(client, identifier, 'recreated', 90000, { afterId });
    await waitForUp(client, appName, 'recreated and running again');
  });

  it('recreates from the LOCAL image when the registry is unreachable', async function () {
    this.timeout(150000);
    const client = env.clients[idx];
    await waitForUp(client, appName, 'running before the outage');

    // a stopped registry is a TCP black hole; the recreate's verify fails at its
    // socket timeout with a transient class, and the image is still on disk
    await env.containers.registry.stop({ remove: false, removeVolumes: false });

    const afterId = client.getLastEventId();
    await killAppContainer(client.container, appName);

    // the rebuild proceeds from the local copy: 'recreated', never 'recreateFailed'
    // (had the keep-path fired instead, the app would sit down until the registry
    // returned - which this test never does)
    await waitForReconcileActuated(client, identifier, 'recreated', 120000, { afterId });
    await waitForUp(client, appName, 'recreated from the local image, registry still down');
  });

  it('keeps a proven app down when there is nothing to run, and self-heals when the image returns', async function () {
    this.timeout(300000);
    const client = env.clients[idx];
    await waitForUp(client, appName, 'running before forced recreate failure');
    // registry is still stopped from the previous test - this test needs it down

    const afterId = client.getLastEventId();
    await killAppContainer(client.container, appName);
    // Remove the local copy too, while the recreate is stuck in its ~20s verify
    // against the black-holed registry (a running container pins its image, so
    // the rmi has to land after the kill; the verify window makes that race-free).
    // Registry unreachable AND no local image = genuinely nothing to run.
    await removeAppImage(client.container, `${REGISTRY_REPO_HOST}/${appName}:v1`);

    // the recreate fails -> the app has proven a run here, so it is KEPT (down,
    // ladder-paced retries), never uninstalled
    await waitForReconcileActuated(client, identifier, 'recreateFailed', 120000, { afterId });
    await waitForReconcileActuated(client, identifier, 'recreateFailedKept', 120000, { afterId });

    // the image returns -> a paced retry re-pulls and restarts it: full self-heal
    // with the same install and app data, no removal ever having happened
    await env.containers.registry.restart();
    await waitForReconcileActuated(client, identifier, 'recreated', 120000, { afterId });
    await waitForUp(client, appName, 'self-healed after the registry returned');
  });
});
