import { describe, it, before, after } from 'mocha';
import { createTestEnv } from '../framework/test-env.js';
import { getAppContainerStatus, killAppContainer } from '../framework/container.js';
import { waitFor, waitForReconcileActuated } from '../framework/wait.js';
import { bootAndPeer, seedSimpleApp } from '../framework/reconciler-suite.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

// A vanished container (docker emits destroy; no die fires for absence) is recreated
// by the reconciler when Docker is reachable. If recreation itself fails — e.g. the
// image can no longer be pulled — the disposition is the §14.5 principle: a component
// that has PROVEN a run here is never destroyed by a failed rebuild. It degrades to
// down, keeps retrying on the crash ladder, and self-heals when the image returns —
// a broken registry must not delete an established app and its data. (Only a
// never-proven fresh install is removed on recreate failure; that verdict belongs to
// the install trial, not this suite.)

async function waitForUp(client, appName, label) {
  await waitFor(async () => {
    const status = await getAppContainerStatus(client.container, appName);
    return status && status.status.startsWith('Up');
  }, { timeout: 60000, interval: 2000, label });
}

describe('reconciler recreates a missing container', function () {
  let env;
  dumpLogsOnFailure(() => env);
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
      // recreate attempt only fails at the provision cap - compress it too.
      // Thresholds only — ladder shape and recreate flow are unchanged.
      configOverrides: {
        fluxapps: {
          crashBackoffDelaysMs: [0, 2000, 5000, 10000, 15000],
          recreateProvisionCapMs: 15000,
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

  it('keeps a proven app down when recreation fails, and self-heals when the image returns', async function () {
    this.timeout(300000);
    const client = env.clients[idx];
    await waitForUp(client, appName, 'running before forced recreate failure');

    // make the recreate genuinely fail: stop the registry (keeping the container and
    // its image storage) so the recreate's pull errors for real. No spec mutation —
    // the image is simply unavailable, like a deleted/tampered image.
    await env.containers.registry.stop({ remove: false, removeVolumes: false });

    const afterId = client.getLastEventId();
    await killAppContainer(client.container, appName);

    // the recreate fails -> the app has proven a run here, so it is KEPT (down,
    // ladder-paced retries), never uninstalled
    await waitForReconcileActuated(client, identifier, 'recreateFailed', 120000, { afterId });
    await waitForReconcileActuated(client, identifier, 'recreateFailedKept', 120000, { afterId });

    // the image returns -> a paced retry recreates and restarts it: full self-heal
    // with the same install and app data, no removal ever having happened
    await env.containers.registry.restart();
    await waitForReconcileActuated(client, identifier, 'recreated', 120000, { afterId });
    await waitForUp(client, appName, 'self-healed after the registry returned');
  });
});
