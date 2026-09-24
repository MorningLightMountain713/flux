// fleet: 3
import {
  describe, it, before, after,
} from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { authenticate } from '../auth.js';
import { appOwnerKey } from '../framework/keys.js';
import { bootAndPeer, installOnNodes } from '../framework/reconciler-suite.js';
import { buildSeedableTestApp } from '../framework/seed-helper.js';
import { pushTestApp } from '../framework/registry-helper.js';
import { appComponentIdentifiers, getAppContainerStatus } from '../framework/container.js';
import { waitForUp, waitFor } from '../framework/wait.js';

// A backup on a legacy node. With no flux-shutdownd the reconciler stops the
// container through docker itself and reports it stopped only once it is down;
// the backup then archives and gives the hold back, and the app runs again.
// Every other backup and restore suite runs on Arcane nodes, where the stop is
// the daemon's and the backup waits out its drain.

const NODES = 3;
const NODE_IDX = 0;

async function isUp(client, appName) {
  const status = await getAppContainerStatus(client.container, appName);
  return !!(status && status.status.startsWith('Up'));
}

describe('backup on a legacy node stops through docker and comes back', function () {
  let env;
  let client;
  const appName = `e2eblegacy${Date.now()}`;

  before(async function () {
    this.timeout(420000);
    env = await createTestEnv({
      hookCtx: this, nodes: NODES, tickerAutostart: false, arcane: false,
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1 });
    client = env.clients[NODE_IDX];
    await pushTestApp(appName);
    const app = await buildSeedableTestApp({ name: appName, exitCode: 0 });
    await installOnNodes(env, app, [NODE_IDX]);
    await waitForUp(client, appName, 'app running before backup');
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('the reconciler stops the container itself, the backup completes, and the app runs again', async function () {
    this.timeout(300000);
    const [identifier] = await appComponentIdentifiers(client.container, appName);
    const auth = await authenticate(client.url, appOwnerKey());
    const afterId = client.getLastEventId();

    // the unresolved promise is the backup's hold window
    const backupDone = client.appendBackupTask(appName, [appName], auth.zelidauth);

    // the stop is the backup's hold, taken by the reconciler; with no daemon to
    // hand it to, the reconciler reports it only once docker has it down
    const stopped = await client.waitForEvent(
      'reconciler:actuated',
      (d) => d.identifier === identifier && d.action === 'stopped',
      120000,
      { afterId },
    );
    expect(stopped.data.reason, 'the stop is the backup operation\'s hold').to.equal('operationHold');
    expect(await isUp(client, appName), 'a legacy stop is reported after the container is down').to.equal(false);

    const body = await backupDone;
    expect(body).to.match(/Finalizing/, `backup did not complete: ${body.slice(-300)}`);
    expect(body).to.not.match(/Refus/i, `backup refused: ${body.slice(-300)}`);

    await waitFor(async () => isUp(client, appName), {
      timeout: 120000, interval: 3000, label: 'app running again after the backup released its hold',
    });
  });
});
