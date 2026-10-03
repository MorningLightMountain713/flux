// fleet: 5
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { dbClient } from '../framework/db-client.js';
import {
  advanceBlocks, driveUntil, startTicker, stopTicker, setSystemSecure, clearSystemSecure,
} from '../framework/daemon-control.js';
import { waitFor, waitForGiveUpSafety, waitForReconcileActuated } from '../framework/wait.js';
import { seedSyncScopedData } from '../framework/reconciler-suite.js';
import { setPeerHasData, setSynced } from '../framework/syncthing-control.js';
import { sleepUnlessInfraDead } from '../framework/infra-death.js';
import { electMaster, startFdmOutage, endFdmOutage } from '../framework/fdm-control.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';
import { loadSharedConfig } from '../framework/coupled-knobs.js';
import {
  subnet, DEPARTURE_WAIT_MS, seedApp, returnToService, elapseSettleWindow, runningComponents, TARGET, locationsOf, SECOND_TARGET, bootResidentialFleet,
} from '../framework/residential-evacuation.js';

// A FLEET OF ITS OWN. Every app seeded asks for five instances on a five-node fleet,
// so it lands on every node, and evacuation gives up one app per departure interval,
// restarting the turn of everything still held. These tests need one node that is the
// elected primary of one app and is draining; on a fleet already holding other apps
// the stand-down would queue behind every one of them.
describe('Residential node evacuation: standing down as the elected primary', function () {
  let env;
  dumpLogsOnFailure(() => env);

  before(async function () {
    this.timeout(600000);
    env = await bootResidentialFleet(this);
  });

  after(async function () {
    this.timeout(120000);
    await clearSystemSecure().catch(() => {});
    await stopTicker().catch(() => {});
    if (env) await env.teardown();
  });

  it('stands down as the elected primary rather than handing the app back from under itself', async function () {
    this.timeout(900000);

    // The elected primary is the node WRITING to the volume. Handing the app
    // back from under it drops whatever it has written since the peer last
    // reported the folder complete. So it stops the component first and asks
    // again next pass, by which time the election has given the role to a peer.
    await returnToService(env, SECOND_TARGET);
    // Node 1 too - it is still held from the previous test, and a held node
    // takes no new apps, so the app would reach four instances and never five.
    await returnToService(env, TARGET);

    const seededAfter = env.clients[TARGET - 1].getLastEventId();
    await seedApp(env, 'primaryapp', { instances: 5, syncMode: 'activeStandby' });
    const primaryContainer = await dbClient(TARGET).appContainerName('primaryapp', 'primaryapp');
    await setSynced({ folder: 'fluxprimaryapp_primaryapp' });
    await setPeerHasData({ folder: 'fluxprimaryapp_primaryapp' });
    await advanceBlocks(3);
    await waitFor(async () => (await locationsOf(env, 'primaryapp')).length >= 5,
      { timeout: 300000, label: 'primaryapp reaches its instance count across the fleet' });

    // A folder pinned synced must hold on disk what its index claims, or the
    // mount-safety guard keeps it receiveonly and the election never starts the
    // writer here. The spawner's install writes nothing, and the sync layer's
    // first-run reset clears local appdata, so the seed goes after that reset.
    await waitForReconcileActuated(env.clients[TARGET - 1], 'primaryapp_primaryapp', 'dataCleared', 120_000,
      { afterId: seededAfter });
    await seedSyncScopedData(env, 'primaryapp', TARGET - 1);

    // FDM names node 1 the primary, which is what the election reads.
    await electMaster('primaryapp', subnet.nodeIp(TARGET));

    // And the component has to be RUNNING here before the drain starts: the gate asks
    // the election question only of a node running the activeStandby component, so a pass that
    // reaches a node the election has not yet started answers SYNCED_ELSEWHERE and
    // hands the app back, which is correct and tests nothing.
    await waitFor(async () => (await runningComponents(env, TARGET)).includes(primaryContainer),
      { timeout: 300000, label: 'the elected primary is running the activeStandby component' });

    await setSystemSecure(subnet.nodeIp(TARGET), false);
    await waitFor(async () => (await dbClient(TARGET).residentialMarker()) !== null,
      { timeout: 120000, label: 'the settling window starts' });
    await elapseSettleWindow(TARGET);

    let standDownVerdict = null;
    const stoodDown = waitForGiveUpSafety(env.clients[TARGET - 1], 'primaryapp',
      (d) => d.safe === false && d.code === 'STAND_DOWN_REQUIRED', 600000)
      .then((v) => { standDownVerdict = v; return v; });
    stoodDown.catch(() => {});

    // Two cycles is enough here BECAUSE this fleet is fresh: the node holds
    // primaryapp and nothing else, so the stand-down is the first thing its
    // evacuation reaches rather than the seventh. On the shared fleet above it
    // would need a departure per app held, which is what the split exists to
    // avoid rather than to budget for.
    await stopTicker();
    await driveUntil(env.clients[TARGET - 1], async () => standDownVerdict !== null,
      { timeoutMs: DEPARTURE_WAIT_MS });
    await startTicker();

    const verdict = await stoodDown;
    expect(verdict.data.code).to.equal('STAND_DOWN_REQUIRED');

    // STANDING DOWN IS A TRANSITION, so it is read as one. The reconciler
    // publishes the desired state it sets and the reason it set it, which is
    // what two samples of container state can never be: a transition that
    // completes between the samples is invisible to them, and the only thing
    // that used to make it visible was an image that ignored SIGTERM and so
    // spent docker's whole stop grace on its way out.
    //
    // The reason is half the property. A stopped container says nothing about
    // WHY it stopped, so sampling could not tell a stand-down from a crash or
    // from a component that was never running. This can. It also names the
    // identifier, which is what stops the negative assertion below being
    // satisfied by an empty answer - `!includes(...)` over an empty list is
    // true, so a failed request or a changed shape would otherwise read as
    // "stopped" while the node is still writing.
    const desired = await env.clients[TARGET - 1].waitForEvent(
      'reconciler:desiredChanged',
      (d) => d.identifier === 'primaryapp_primaryapp' && d.state === 'stopped',
      180000,
      // ANCHORED ON THE VERDICT, because the stand-down is what this transition
      // has to have been caused by. The install stops the component too, with
      // its own reason, and that lands whenever the local lifecycle gets there -
      // after the location count this test waits on, which is a database
      // reading. Anchoring anywhere before the decision picks that one up.
      { afterId: verdict.id },
    );
    expect(desired.data.reason, 'the component stopped for some reason other than standing down')
      .to.contain('standing down');

    // The intent above, carried out. Both are worth having: the reconciler can
    // record a desired state it never applies.
    await waitFor(async () => !(await runningComponents(env, TARGET)).includes(primaryContainer),
      { timeout: 180000, label: 'the activeStandby component is stopped on the standing-down node' });

    // And it must STAY stopped. appReconciler takes an activeStandby component's desired
    // state from controllerDesired, so a stand-down that stops the container
    // without telling the controller is undone on the next sweep.
    await advanceBlocks(3);
    expect(await runningComponents(env, TARGET)).to.not.include(primaryContainer);
  });

  it('hands the app back on the pass after standing down, and the app survives elsewhere', async function () {
    this.timeout(900000);

    // Runs on from the test above: node TARGET has stopped primaryapp's g:
    // component and is no longer a candidate for it, so the next pass finds the
    // component not running here, re-proves a connected peer holds the folder
    // with nothing left to write, and removes.
    await waitFor(async () => {
      const locations = await locationsOf(env, 'primaryapp');
      return !locations.map((l) => l.ip.split(':')[0]).includes(subnet.nodeIp(TARGET));
    }, { timeout: 600000, label: 'the standing-down node hands primaryapp back' });

    const locations = await locationsOf(env, 'primaryapp');
    expect(locations.length).to.be.greaterThan(0);
    expect(locations.map((l) => l.ip.split(':')[0])).to.not.include(subnet.nodeIp(TARGET));
  });

  it('will not hand back an activeStandby app it is running while no FDM can name the primary', async function () {
    this.timeout(900000);

    // The other half of the same question, and the one that used to answer
    // "safe". An election that has NOT RUN and an election that named another
    // node were the same answer - false - and the gate deleted the volume on
    // it. Every other unavailable input in that gate refuses.
    //
    // SEEDS ITS OWN APP. After the stand-down tests the app has left node TARGET and
    // nothing considers it again, so the primary this refusal needs is built here.
    await returnToService(env, TARGET);

    const seededAfter = env.clients[TARGET - 1].getLastEventId();
    await seedApp(env, 'lockedapp', { instances: 5, syncMode: 'activeStandby' });
    const lockedContainer = await dbClient(TARGET).appContainerName('lockedapp', 'lockedapp');
    await setSynced({ folder: 'fluxlockedapp_lockedapp' });
    await setPeerHasData({ folder: 'fluxlockedapp_lockedapp' });
    await advanceBlocks(3);
    await waitFor(async () => (await locationsOf(env, 'lockedapp')).length >= 5,
      { timeout: 300000, label: 'lockedapp reaches its instance count across the fleet' });

    // A folder pinned synced must hold on disk what its index claims, or the
    // mount-safety guard keeps it receiveonly and the election never starts the
    // writer here; the seed goes after the sync layer's first-run reset.
    await waitForReconcileActuated(env.clients[TARGET - 1], 'lockedapp_lockedapp', 'dataCleared', 120_000,
      { afterId: seededAfter });
    await seedSyncScopedData(env, 'lockedapp', TARGET - 1);

    // A peer holds the folder in full, so the synced-peer loop PASSES and the
    // pass reaches the election question. That ordering is the safety property
    // this suite proves elsewhere; here it is the precondition, because a node
    // refused at the peer loop never gets far enough to refuse on the election.

    // Elected while FDM is still answering. The refusal under test is a verdict
    // going STALE, not one that never existed, so the node has to have reached
    // one before the outage starts.
    await electMaster('lockedapp', subnet.nodeIp(TARGET));

    // And the component has to be RUNNING here before FDM goes down. The gate
    // asks the election question only of a node running the activeStandby component - a
    // node not running it cannot be the writer - so without this the pass
    // answers SYNCED_ELSEWHERE and hands the app back, which is correct and
    // tests nothing. masterSlaveApps only starts the component because FDM
    // named this node, so taking FDM down first means it never starts at all.
    await waitFor(async () => (await runningComponents(env, TARGET)).includes(lockedContainer),
      { timeout: 300000, label: 'the elected primary is running the activeStandby component' });

    // The stub closes its listening socket, not an empty ips array. An empty
    // array is FDM ANSWERING that nobody is primary; this is nobody answering,
    // and a refused connection is the signature a real FDM outage carries - the
    // error reaches the node with no response on it at all. The gate is allowed
    // to act on the first and must not act on the second.
    await startFdmOutage('refuse');

    // The try opens HERE rather than after the staging below. Everything between
    // the outage and the assertions can throw - the settling-marker wait carries a
    // 120s timeout - and 'refuse' closes the stub's listening socket rather than
    // answering 503, so an outage left behind is a dead socket for whatever runs
    // next. Contained today only because this is the last test in the file and the
    // stub dies with the env, and neither is a property anyone maintains on purpose.
    try {
      // THE ORDER HERE IS THE TEST. The verdict has to go stale BEFORE the node
      // starts draining, and it is the stand-down that makes that so: a draining
      // node that still remembers being primary now hands the app over and
      // leaves, so the verdict never survives long enough to expire. Withdrawing
      // attestation first - which is what this test used to inherit from the
      // stand-down tests before them - reaches STAND_DOWN_REQUIRED instead, and
      // ELECTION_UNKNOWN becomes unreachable.
      //
      // Waited rather than observed, because staleness has no external signal:
      // primaryElectionCheckedAt is refreshed only where FDM ANSWERED, so with
      // no region answering at all nothing touches it and it ages out on wall clock.
      // Derived from the knob it is a multiple of, never written as a literal -
      // PRIMARY_ELECTION_STALE_MS is masterSlaveIntervalMs x 10, and the harness
      // compresses that knob to 3s, so this costs ~30s here and tracks the knob
      // if it moves. One extra cycle of margin so the expiry is past, not level.
      const electionCycleMs = loadSharedConfig().fluxapps.masterSlaveIntervalMs;
      await sleepUnlessInfraDead((electionCycleMs * 10) + electionCycleMs);

      await setSystemSecure(subnet.nodeIp(TARGET), false);
      await waitFor(async () => (await dbClient(TARGET).residentialMarker()) !== null,
        { timeout: 120000, label: 'the settling window starts' });
      await elapseSettleWindow(TARGET);

      let unknownRefusal = null;
      const refused = waitForGiveUpSafety(env.clients[TARGET - 1], 'lockedapp',
        (d) => d.safe === false && d.code === 'ELECTION_UNKNOWN', 600000)
        .then((v) => { unknownRefusal = v; return v; });
      refused.catch(() => {});

      // Driven from the start rather than after a sleep. The verdict has to age
      // past PRIMARY_ELECTION_STALE_MS before the gate reports ELECTION_UNKNOWN,
      // and until it does the pass refuses with ELECTION_PRIMARY instead - so
      // the passes in between are not wasted, they are the evidence that the
      // node kept answering from what it knew while FDM was up. Waiting for the
      // refusal to change rather than sleeping for the window means the test
      // ends when the property holds, not when a timer says it should.
      //
      // That window is ten election cycles derived from masterSlaveIntervalMs,
      // which the harness already compresses 10x to 3s - so this costs ~30s and
      // shortening it means compressing masterSlaveIntervalMs further, which
      // has its own couplings to check first.
      await stopTicker();
      await driveUntil(env.clients[TARGET - 1], async () => unknownRefusal !== null,
      { timeoutMs: DEPARTURE_WAIT_MS });
      await startTicker();

      const verdict = await refused;

      expect(verdict.data.code).to.equal('ELECTION_UNKNOWN');
      expect(verdict.data.detail).to.contain('cannot say who is primary');
      // And the app is still here. A refusal that let the removal through
      // anyway would satisfy the assertions above and lose the volume.
      const stillInstalled = await env.clients[TARGET - 1].get('/apps/installedapps');
      expect(stillInstalled.data.map((a) => a.name)).to.include('lockedapp');
    } finally {
      await endFdmOutage();
    }
  });
});
