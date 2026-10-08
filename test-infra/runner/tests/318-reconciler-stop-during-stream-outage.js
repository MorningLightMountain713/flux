// fleet: 10
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { getAppContainerStatus, killDockerd } from '../framework/container.js';
import { authenticate } from '../auth.js';
import { appOwnerKey } from '../framework/keys.js';
import { bootAndPeer, seedSimpleApp } from '../framework/reconciler-suite.js';
import {
  waitForUp, waitForDown, assertNoEvent, waitForOperatorIntent, waitForCapabilityDown, waitForCapabilityUp,
} from '../framework/wait.js';

// Docker's reachability, to the node, is its event stream: lost with it, back
// with it, retried from one second. Across a dockerd outage that proves three
// things. A stop sent while the node cannot see docker is refused, not taken on
// trust and lost. The containers the outage stopped (no live-restore) died
// unseen, and the reconnect sweep restores them from actual state. And once
// the stream is back a stop lands, holds against the sweep, and a later
// appstart works: the operator lock is recorded before the docker op, so the
// die event's loss costs nothing.

describe('a stop across a docker outage: refused while docker is unseen, landing once the stream is back', function () {
  let env;
  const appName = `e2estreamout${Date.now()}`;
  let identifier;
  let idx;

  before(async function () {
    this.timeout(420000);
    env = await createTestEnv({ hookCtx: this, nodes: 10, tickerAutostart: false });
    await bootAndPeer(env);
    ({ index: idx, identifier } = await seedSimpleApp(env, appName));
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('refuses the stop while the stream is down, restores what the outage stopped, then stops and restarts on request', async function () {
    this.timeout(300000);
    const client = env.clients[idx];
    await waitForUp(client, appName, 'running before the outage');
    const mark = client.getLastEventId();

    // dockerd goes, its containers go with it, and the event stream dies: the
    // node marks docker unreachable on the stream's loss, not on a later ping.
    await killDockerd(client.container);
    const down = await waitForCapabilityDown(client, 'dockerReachable', 30000, { afterId: mark });

    // Inside the outage the stop is refused. The watchdog needs a second or more
    // to respawn dockerd and the stream's first retry is a second after its
    // loss; this request leaves within milliseconds of the loss's edge.
    const auth = await authenticate(client.url, appOwnerKey());
    const refused = await client.getAuthed(`/apps/appstop/${appName}`, auth.zelidauth);
    expect(refused.status, JSON.stringify(refused)).to.equal('error');
    expect(refused.data.code, JSON.stringify(refused)).to.equal(503);

    // The stream returns with dockerd and docker is reachable again at that
    // instant. Events during the outage are gone, so the bridge sweeps every
    // component from actual state and restarts the container the outage stopped.
    const up = await waitForCapabilityUp(client, 'dockerReachable', 60000, { afterId: down.id });
    const swept = await client.waitForEvent('reconciler:swept', (d) => d.reason === 'reconnect', 60000, { afterId: up.id });
    await client.waitForEvent(
      'reconciler:actuated',
      (d) => d.identifier === identifier && (d.action === 'restart' || d.action === 'firstStart'),
      60000,
      { afterId: swept.id },
    );
    await waitForUp(client, appName, 'restored by the reconnect sweep');

    // Now the stop lands, and it holds: no restart against the operator lock,
    // no start/stop flapping.
    const stopRes = await client.getAuthed(`/apps/appstop/${appName}`, auth.zelidauth);
    expect(stopRes.status, JSON.stringify(stopRes)).to.equal('success');
    const intent = await waitForOperatorIntent(client, identifier, true);
    await waitForDown(client, appName, 'stopped on request');
    await assertNoEvent(client, 'reconciler:actuated', (d) => d.identifier === identifier && (d.action === 'firstStart' || d.action === 'restart'), 20000, { afterId: intent.id });
    const status = await getAppContainerStatus(client.container, appName, { all: true });
    expect(status && status.status.startsWith('Up')).to.not.equal(true);

    // and nothing is wedged: a normal appstart brings it back
    const auth2 = await authenticate(client.url, appOwnerKey());
    await client.getAuthed(`/apps/appstart/${appName}`, auth2.zelidauth);
    await waitForUp(client, appName, 'running again after appstart');
  });
});
