// fleet: 10
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { bootAndPeer, installOnNodes, seedSyncScopedData } from '../framework/reconciler-suite.js';
import { buildSeedableSyncthingApp } from '../framework/seed-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { setSynced } from '../framework/syncthing-control.js';
import {
  appSyncthingFolderId, componentIdentifier, crashFluxos, releaseFluxos, getAppContainerStatus,
} from '../framework/container.js';
import { waitFor, waitForAppInstalled, waitForReconcileActuated } from '../framework/wait.js';
import { grantPlaneDaemon, grantPlaneOverrides, grantVerdict } from '../framework/grant-record.js';
import { PRODUCTION_LOCATION_EXPIRIES } from '../framework/coupled-knobs.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

// A certificate says a master's FluxOS stopped, not its machine: its container and
// its syncthing run on, and nothing is left on that node to stop them. The grant
// makes two promises about this, of different strengths. A stale master's writes
// can never win: the successor raises the peer fence inside the acquire, without the
// corpse's cooperation, before its own container starts. At most one container runs
// with the overlap bounded: that one is a latency claim on a process that can run,
// and a master with no FluxOS cannot make it, so the corpse's container runs until
// its FluxOS is back. The first is asserted absolutely, the second read as the overlap
// it is.
//
// The syncthing stub carries no data: that a fenced peer's writes reach nobody is
// proved over real syncthing by 3316. Here the order is what is asserted.

const HOLDERS = [0, 1, 2];
const QUORUM = 5;

describe('a master whose FluxOS crashes while its app runs', function () {
  let env;
  dumpLogsOnFailure(() => env);
  const name = `e2ecorpse${Date.now()}`;
  let app;
  let identifier;
  let key;
  let outpoints;
  let first;
  let masterIndex;
  let survivors;
  let successorIndex;
  let second;

  const isUp = async (i) => {
    const status = await getAppContainerStatus(env.clients[i].container, name).catch(() => null);
    return Boolean(status?.status?.startsWith('Up'));
  };
  const verdict = () => grantVerdict(env.clients.filter((_, i) => i !== masterIndex), key, { quorum: QUORUM });

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 10,
      tickerAutostart: false,
      zmqTopics: ALL_ZMQ_TOPICS,
      configOverrides: {
        daemon: grantPlaneDaemon(),
        // The crash outlasts the fleet's grace otherwise, and boot removes the app
        // before the grant is asked.
        fluxapps: grantPlaneOverrides(PRODUCTION_LOCATION_EXPIRIES),
      },
    });
    await bootAndPeer(env);

    await pushImage(name, 'v1');
    app = await buildSeedableSyncthingApp({
      name, syncMode: 'activeStandby', instances: HOLDERS.length, pinnedTo: HOLDERS,
    });
    identifier = componentIdentifier(app);
    key = `${app.identity}/master`;
    const installAfters = HOLDERS.map((i) => env.clients[i].getLastEventId());
    await installOnNodes(env, app, HOLDERS);
    await Promise.all(HOLDERS.map((i) => waitForAppInstalled(env.clients[i], name, 240000)));
    await Promise.all(HOLDERS.map(async (i, k) => {
      await waitForReconcileActuated(env.clients[i], identifier, 'dataCleared', 60000, { afterId: installAfters[k] });
      await seedSyncScopedData(env, name, i);
    }));
    await setSynced({ folder: await appSyncthingFolderId(env.clients[HOLDERS[0]], name, name) });

    outpoints = {};
    // eslint-disable-next-line no-restricted-syntax
    for (const i of HOLDERS) {
      // eslint-disable-next-line no-await-in-loop
      const status = await env.clients[i].getNodeStatus();
      outpoints[i] = `${status.data.txhash}:${status.data.outidx}`;
    }
    await waitFor(async () => {
      first = await grantVerdict(env.clients, key, { quorum: QUORUM });
      return Boolean(first?.grantee);
    }, { timeout: 240000, interval: 5000, label: 'a grant quorum forms' });
    masterIndex = Number(Object.keys(outpoints).find((i) => outpoints[i] === first.grantee));
    survivors = HOLDERS.filter((i) => i !== masterIndex);
    await waitFor(() => isUp(masterIndex), { timeout: 240000, interval: 3000, label: 'the master runs the app' });
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('seats one successor at a higher epoch once the master\'s FluxOS is gone, its app still running', async function () {
    this.timeout(600000);
    const froms = new Map(survivors.map((i) => [i, env.clients[i].getLastEventId()]));

    await crashFluxos(env.clients[masterIndex].container, { hold: true });

    const granted = await Promise.any(survivors.map(async (i) => {
      await env.clients[i].waitForEvent('quorumGrant:granted', (d) => d.key === key, 420000, { afterId: froms.get(i) });
      return i;
    }));
    successorIndex = granted;
    await waitFor(async () => {
      second = await verdict();
      return Boolean(second?.grantee) && second.grantee !== first.grantee;
    }, { timeout: 120000, interval: 5000, label: 'a successor holds the grant' });

    expect(second.epoch, 'epochs never move backwards').to.be.greaterThan(first.epoch);
    expect(second.grantee).to.equal(outpoints[successorIndex]);
    expect(await isUp(masterIndex), 'the corpse\'s app stopped, so nothing here is tested').to.equal(true);
  });

  it('fences the corpse before the successor\'s container starts', async function () {
    this.timeout(180000);
    const client = env.clients[successorIndex];
    await waitFor(() => isUp(successorIndex), { timeout: 150000, interval: 3000, label: 'the successor runs the app' });

    const buffer = client.getEventBuffer();
    const fenced = buffer.find((e) => e.event === 'syncthing:fenceRaised' && e.data?.app === app.identity);
    const started = buffer.find((e) => e.event === 'reconciler:actuated' && e.data?.identifier === identifier
      && ['started', 'firstStart'].includes(e.data?.action));
    expect(fenced, 'the successor raised no fence').to.not.equal(undefined);
    expect(started, 'fixture: the successor\'s container start was not seen').to.not.equal(undefined);
    expect(fenced.id, 'the successor\'s container started before the fence').to.be.below(started.id);
  });

  it('stops the corpse\'s app once its FluxOS is back, and it does not reclaim', async function () {
    this.timeout(420000);
    const corpse = env.clients[masterIndex];
    const returnedFrom = corpse.getLastEventId();
    await releaseFluxos(corpse.container, { readyTimeoutMs: 180000 });

    await corpse.waitForEvent(
      'reconciler:actuated',
      (d) => d.identifier === identifier && d.reason === 'peerHoldsGrant',
      300000,
      { afterId: returnedFrom },
    );
    await waitFor(async () => !(await isUp(masterIndex)), {
      timeout: 120000, interval: 3000, label: 'the returned master stops its app',
    });
    expect(await isUp(successorIndex), 'the successor stopped its app').to.equal(true);
    const settled = await verdict();
    expect(settled?.grantee, 'the corpse reclaimed the grant').to.equal(outpoints[successorIndex]);
  });
});
