// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { getAppContainerStatus, killAppContainer, execInContainer } from '../framework/container.js';
import { getSyncthingState } from '../framework/syncthing-control.js';
import {
  waitFor, waitForReconcileActuated, assertNoEvent,
} from '../framework/wait.js';
import { bootAndPeer, seedSyncthingApp } from '../framework/reconciler-suite.js';

// s: (plain sync) replicates data between instances but, unlike activeStandby
// (the election decides which instance runs) and syncFirst (the sync readiness
// decider starts it once its data is complete), no decider owns its run-state.
// A plain-sync component must behave like any normal component: started at
// install, folder sendreceive from the first configuration, and recreated by
// the reconciler when its container dies - with no controller opinion anywhere.

async function waitForUp(client, appName, label) {
  await waitFor(async () => {
    const status = await getAppContainerStatus(client.container, appName);
    return status && status.status.startsWith('Up');
  }, { timeout: 60000, interval: 2000, label });
}

describe('plain-sync (s:) components run like normal components', function () {
  let env;
  let idx; let folder; let identifier;
  const appName = `e2eplains${Date.now()}`;

  before(async function () {
    this.timeout(360000);
    env = await createTestEnv({ hookCtx: this, nodes: 10, tickerAutostart: false });
    await bootAndPeer(env);
    ({ index: idx, folder, identifier } = await seedSyncthingApp(env, {
      name: appName, syncMode: 'sync',
    }));
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('starts at install with no decider involvement', async function () {
    this.timeout(90000);
    const client = env.clients[idx];
    await waitForUp(client, appName, 's: app running right after install');
    // No controller ever declares a run-state for plain sync - a desiredChanged
    // for this component would mean a decider wrongly adopted it
    await assertNoEvent(client, 'reconciler:desiredChanged', (d) => d.identifier === identifier, 12000);
  });

  it('configures its syncthing folder as sendreceive from the first configuration', async function () {
    this.timeout(30000);
    const state = await getSyncthingState();
    const registered = state.nodes.flatMap((n) => n.folders).filter((f) => f.id === folder);
    expect(registered.length, 'folder registered with syncthing').to.be.greaterThan(0);
    for (const f of registered) {
      expect(f.type).to.equal('sendreceive');
    }
  });

  it('is recreated by the reconciler with its data intact (no controller opinion needed)', async function () {
    this.timeout(150000);
    const client = env.clients[idx];
    const mountDir = `/mnt/appdata/flux-apps/flux${identifier}/appdata`;

    await execInContainer(client.container, `sh -c "echo persisted > ${mountDir}/e2e-marker"`);

    const afterId = client.getLastEventId();
    await killAppContainer(client.container, appName); // docker rm -f -> gone

    // a vanished s: container is a genuine miss: recreate without any decider
    await waitForReconcileActuated(client, identifier, 'recreated', 90000, { afterId });
    await waitForUp(client, appName, 'recreated and running again');

    // the recreated container carries the bind mount (this is the assertion
    // that catches a deployment producing zero binds) and the data survived
    const inspect = await execInContainer(client.container, `docker inspect flux${identifier} --format '{{json .Mounts}}'`);
    const mounts = JSON.parse(inspect.stdout.trim());
    const appdata = mounts.find((m) => m.Destination === '/appdata');
    expect(appdata, 'bind mount present in the recreated container').to.not.equal(undefined);
    expect(appdata.Source).to.include(`flux${identifier}`);

    const marker = await execInContainer(client.container, `cat ${mountDir}/e2e-marker`);
    expect(marker.stdout).to.include('persisted');
  });
});
