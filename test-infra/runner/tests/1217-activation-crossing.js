// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { bootAndPeer, installOnNodes, seedSyncScopedData } from '../framework/reconciler-suite.js';
import { buildSeedableSyncthingApp } from '../framework/seed-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { setSynced } from '../framework/syncthing-control.js';
import { getAppContainerStatus, getAppContainerId } from '../framework/container.js';
import { advanceBlocks } from '../framework/daemon-control.js';
import { waitFor, waitForAppInstalled, waitForReconcileActuated } from '../framework/wait.js';

// The moment the plane takes over from the legacy election, on a fleet that is
// already running apps — the one state no other suite covers. 1211 pins the half
// below the activation height; every other 12xx suite pins the half above it. This
// is the crossing itself.
//
// The claim is that the switch is a NO-OP for a healthy app. An app whose master is
// alive keeps that master: the same node, the same container, no stop and no start.
// The plane inherits what the election decided rather than re-deciding it.
//
// That is not free. At the crossing no grant exists for any app — the grantors have
// no memory of a regime that never ran — so every candidate sees a cold key. Without
// incumbent priority the term goes to whoever's pursuit jitter fires first, which is
// not the node holding the container, and EVERY activeStandby app on the network
// would re-race its mastership at one instant. For a shared-volume app that means a
// stop, a start elsewhere and a syncthing re-settle, fleet-wide, for nothing.
//
// The vacuity trap is sharp here: 'nothing moved' is trivially true if the plane
// never engaged. So the crossing is proved BEFORE the no-op is asserted — a granted
// term naming the incumbent. A run that cannot show the grant fails rather than
// passing quietly.

const HOLDERS = [0, 1, 2];
const ACTIVATION_HEIGHT = 2_100_060;

describe('activation crossing: the plane inherits the running master, it does not re-elect', function () {
  let env;
  let name;

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 10,
      tickerAutostart: false,
      zmqTopics: ALL_ZMQ_TOPICS,
      configOverrides: {
        fluxapps: {
          quorumGrantMastership: true,
          quorumGrantHeldTtlMs: 90000,
          quorumGrantRenewIntervalMs: 10000,
          quorumGrantLockDelayMs: 15000,
          quorumGrantDemotionSlackMs: 5000,
          quorumGrantMaxTtlMs: 120000,
          quorumGrantDrainMs: 90000,
          quorumGrantMinHolderAgeMs: 0,
          quorumGrantPursuitIntervalMs: 10000,
          quorumGrantUnknownGraceMs: 30000,
          // Ahead of the chain's start, so the fleet boots and settles under the
          // legacy election exactly as production does today, and the crossing is
          // something this suite performs rather than something it starts inside.
          quorumGrantActivationHeight: ACTIVATION_HEIGHT,
        },
      },
    });
    await bootAndPeer(env);

    name = `e2ecross${Date.now()}`;
    await pushImage(name, 'v1');
    const app = await buildSeedableSyncthingApp({ name, syncMode: 'activeStandby' });
    const installAfters = HOLDERS.map((i) => env.clients[i].getLastEventId());
    await installOnNodes(env, app, HOLDERS);
    await Promise.all(HOLDERS.map((i) => waitForAppInstalled(env.clients[i], name, 240000)));
    await Promise.all(HOLDERS.map(async (i, k) => {
      await waitForReconcileActuated(env.clients[i], `${name}_${name}`, 'dataCleared', 60000, { afterId: installAfters[k] });
      await seedSyncScopedData(env, name, i);
    }));
    await setSynced({ folder: `flux${name}_${name}` });
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('the same node holds the app across the crossing, and its container never restarts', async function () {
    this.timeout(900000);

    // 1. The legacy election seats exactly one master, below the height.
    const upHolders = async () => {
      const statuses = await Promise.all(HOLDERS.map(
        (i) => getAppContainerStatus(env.clients[i].container, name).catch(() => null),
      ));
      return HOLDERS.filter((_, k) => statuses[k] && statuses[k].status.startsWith('Up'));
    };
    await waitFor(async () => (await upHolders()).length === 1,
      { timeout: 240000, interval: 10000, label: 'the legacy election seats exactly one master' });

    const [incumbent] = await upHolders();
    // The container ID, not its status string: a restart keeps the name and the
    // 'Up' and takes a new ID, so the ID is the only thing that says the workload
    // was never interrupted.
    const incumbentContainer = await getAppContainerId(env.clients[incumbent].container, name, name);
    expect(incumbentContainer, 'the incumbent has a container to keep').to.be.a('string');
    const afterIds = env.clients.map((c) => c.getLastEventId());

    // 2. Cross the activation height.
    await advanceBlocks(80);

    // 3. Prove the plane actually engaged, BEFORE asserting nothing moved —
    //    otherwise a plane that never woke up passes this suite trivially.
    const granted = await env.clients[incumbent].waitForEvent(
      'quorumGrant:granted', (d) => d.key === `${name}/master`, 300000,
      { afterId: afterIds[incumbent] },
    );
    expect(granted, 'the crossing happened: a term was granted').to.not.equal(undefined);

    // 4. The no-op: same holder, same container, and no one else ever ran it.
    const stillUp = await upHolders();
    expect(stillUp, 'exactly one holder still runs the app').to.have.lengthOf(1);
    expect(stillUp[0], 'and it is the SAME node the election had seated').to.equal(incumbent);
    expect(
      await getAppContainerId(env.clients[incumbent].container, name, name),
      'the very same container - not stopped, not recreated',
    ).to.equal(incumbentContainer);
  });
});
