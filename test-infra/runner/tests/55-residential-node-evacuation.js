// fleet: 5
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { dbClient } from '../framework/db-client.js';
import {
  advanceBlocks, driveUntil, startTicker, stopTicker, setSystemSecure, clearSystemSecure,
} from '../framework/daemon-control.js';
import {
  waitForDaemonReady, waitForAppInstalled, waitForSpawnerBlocked, waitFor, waitForGiveUpConsidered, waitForGiveUpSafety, waitForResidentialDecision,
} from '../framework/wait.js';
import { setNoPeerData, setPeerHasData, setSynced } from '../framework/syncthing-control.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';
import {
  subnet, DEPARTURE_WAIT_MS, seedApp, whenGone, returnToService, elapseSettleWindow, TARGET, locationsOf, TABLE_DECIDED, VETOING, SECOND_TARGET, bootResidentialFleet,
} from '../framework/residential-evacuation.js';

describe('Residential node evacuation', function () {
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

  it('classifies the node RESIDENTIAL from the operator, not the registrant org', async function () {
    this.timeout(120000);

    // The node persists what it OBSERVED, not the verdict it drew from it - the
    // verdict also needs the published table, which arrives later, so it is
    // reached when asked rather than stored and left to go stale.
    await waitFor(async () => {
      const geo = await dbClient(TARGET).geolocation();
      return geo?.networkEvidence?.classification === 'RESIDENTIAL';
    }, { timeout: 90000, label: 'node 1 observes itself on an access network' });

    const geo = await dbClient(TARGET).geolocation();
    expect(geo.networkEvidence.evidenceAgainst).to.be.empty;
    expect(geo.networkEvidence.evidenceFor).to.not.be.empty;
    // The org string names a reseller. Reading it, as the old classifier did,
    // would have decided this node on the wrong field entirely.
    expect(geo.geolocation.org).to.equal('Some Reseller Ltd');
  });

  it('leaves an attested data-centre node alone', async function () {
    this.timeout(120000);

    const geo = await dbClient(2).geolocation();
    expect(geo.networkEvidence.classification).to.equal('DATACENTER');

    const info = await env.clients[1].get('/flux/info', { noCache: true });
    expect(info.data.flux.dos.dosState).to.be.below(100);
  });

  it('takes the published verdict where the node has nothing of its own to go on', async function () {
    this.timeout(120000);

    await waitFor(async () => {
      const geo = await dbClient(TABLE_DECIDED).geolocation();
      return geo?.networkEvidence != null;
    }, { timeout: 90000, label: 'node 3 gathers its evidence' });

    const info = await env.clients[TABLE_DECIDED - 1].get('/flux/info', { noCache: true });
    expect(info.data.flux.dos.dosState).to.be.below(100);

    // Its own reading is UNKNOWN - no signal for, none against - so a verdict of
    // RESIDENTIAL can only have come from the table.
    //
    // The dosState assertion above is guaranteed by this node's attestation and
    // establishes nothing on its own; what this test rests on is the evidence
    // below. Withdrawing the attestation to make the verdict decide, as the
    // veto test does, is not available here: node 3 is SECOND_TARGET for the
    // later drain tests and has to arrive at them attested.
    const geo = await dbClient(TABLE_DECIDED).geolocation();
    expect(geo.networkEvidence.classification).to.equal('UNKNOWN');
    expect(geo.networkEvidence.evidenceFor).to.be.empty;
    expect(geo.networkEvidence.evidenceAgainst).to.be.empty;
  });

  it('declines a published verdict its own address contradicts', async function () {
    this.timeout(120000);

    await waitFor(async () => {
      const geo = await dbClient(VETOING).geolocation();
      return geo?.networkEvidence != null;
    }, { timeout: 90000, label: 'node 5 gathers its evidence' });

    // Published residential along with its neighbours, but it can see hosting
    // evidence about itself - 213.44.137.57 on Bouygues is the live instance.
    // The veto only ever removes a node from enforcement.
    const geo = await dbClient(VETOING).geolocation();
    expect(geo.networkEvidence.evidenceAgainst).to.not.be.empty;

    // Attestation alone keeps this node below 100, so asserting only that
    // proves nothing about the veto: shouldEnforce is `residential && !arcane`,
    // and deleting the veto entirely left this test green. Withdraw the
    // attestation and the verdict is the only thing left deciding. Node 5 is
    // used by no later test, so it stays withdrawn.
    await setSystemSecure(subnet.nodeIp(VETOING), false);

    // The node now publishes what each tick concluded, so this waits for the
    // decision instead of waiting out thirty seconds and inferring it from
    // nothing having happened.
    //
    // Matched on the VERDICT, not on enforce. A veto lands the node in
    // CONFLICTED, and isResidential collapses CONFLICTED to null the same as
    // UNKNOWN and the same as no-table-consulted - so enforce alone cannot tell
    // "this node declined a published verdict about its own address" from
    // "this node has read nothing yet". source: node-veto is the assertion that
    // the veto is what did it.
    const decision = await waitForResidentialDecision(
      env.clients[VETOING - 1], (d) => d.source === 'node-veto', 60000,
    );
    expect(decision.data.classification, 'a vetoed verdict is CONFLICTED').to.equal('CONFLICTED');
    expect(decision.data.enforce, 'and CONFLICTED enforces nothing').to.equal(null);

    expect(await dbClient(VETOING).residentialMarker(), 'a vetoing node must not start a settling window').to.equal(null);
    const after = await env.clients[VETOING - 1].get('/flux/info', { noCache: true });
    expect(after.data.flux.dos.dosState).to.be.below(100);
  });

  it('leaves a residential node alone while it is still attested', async function () {
    this.timeout(300000);

    // ArcaneOS is the whole discriminator. A residential connection on its own
    // enforces nothing, and this node has to be able to take work like any
    // other - otherwise there would be nothing to evacuate later.
    const info = await env.clients[TARGET - 1].get('/flux/info', { noCache: true });
    expect(info.data.flux.dos.dosState).to.be.below(100);
    // A residential node that IS attested reports nothing at all. The field
    // names the staging, not the connection - otherwise every residential
    // operator running ArcaneOS reads it and asks what is wrong with their node.
    expect(info.data.flux.dosStaging).to.equal(null);

    await seedApp(env, 'residentapp', { instances: 5 });
    await advanceBlocks(3);
    await waitForAppInstalled(env.clients[TARGET - 1], 'residentapp', 240000);

    const installed = await env.clients[TARGET - 1].get('/apps/installedapps');
    expect(installed.data.map((a) => a.name)).to.include('residentapp');
  });

  it('stops taking new apps the moment attestation is withdrawn, deleting nothing', async function () {
    this.timeout(300000);

    await setSystemSecure(subnet.nodeIp(TARGET), false);

    await waitForSpawnerBlocked(env.clients[TARGET - 1], 'placement_hold', 120000);

    // The hold is immediate; nothing it already runs is touched by it, and the
    // DOS path - the one that deletes - must not have been taken.
    const info = await env.clients[TARGET - 1].get('/flux/info', { noCache: true });
    expect(info.data.flux.dos.dosState).to.be.below(100);

    // And the node SAYS so. Without this the stage is invisible: a held node
    // takes no new apps and is otherwise indistinguishable from one that has
    // simply not been given work - and this is the stage, lasting a whole
    // settling window, where the operator can still put it right and lose
    // nothing at all.
    expect(info.data.flux.dosStaging).to.equal('HOLD');

    const installed = await env.clients[TARGET - 1].get('/apps/installedapps');
    expect(installed.data.map((a) => a.name)).to.include('residentapp');
  });

  it('hands the app back once the settling window has passed', async function () {
    this.timeout(600000);

    // The clock is persisted and wall-clock, so a node cannot restart its way
    // out of the drain. Which is also what lets the test open the gate: put the
    // start of the window far enough in the past that it has elapsed.
    const marker = await dbClient(TARGET).residentialMarker();
    expect(marker, 'the settling window should be running').to.not.be.null;

    await elapseSettleWindow(TARGET);

    // The stage moves when the WINDOW is served, before any app has moved -
    // which is the ordering the staging is built on, and the one an operator
    // reads. Asserted here rather than after the removal, so it cannot pass on a
    // stage that only appeared once the app had already gone.
    await waitFor(async () => {
      const staged = await env.clients[TARGET - 1].get('/flux/info', { noCache: true });
      return staged?.data?.flux?.dosStaging === 'EVACUATE';
    }, { timeout: 120000, interval: 2000, label: 'the node reports it is evacuating' });

    const stillHeld = await env.clients[TARGET - 1].get('/apps/installedapps');
    expect(stillHeld.data.map((a) => a.name), 'the stage moved only after the app had gone')
      .to.include('residentapp');

    // Drive the chain from here rather than letting the ticker free-run, so the
    // give-up pass is reached on a block the node processed AS the tip. See
    // driveUntil.
    await stopTicker();
    // Read from the EVENT STREAM, not by polling two endpoints.
    //
    // What this has to establish is an ORDER: the app goes, and only then does
    // DOS land. "goes into DOS only once it holds nothing" cannot see a
    // violation on its own, because nodeStatusMonitor removes every local app
    // at DOS >= 100 - so a premature DOS empties the node and satisfies that
    // test's waits FASTER than the correct behaviour does.
    //
    // Polling cannot establish it. Two earlier forms of this check failed for
    // two different reasons: asserting DOS unconditionally fails on the correct
    // sequence, because DOS follows the departure by about two seconds and the
    // next poll sees 100 with nothing held; and gating that assertion on
    // /apps/installedapps fails because the installed-apps RECORD is dropped
    // LAST, after the runtime state - measured at 20s behind "Application
    // residentapp locally removed", which the whenGone wait below exists to
    // absorb. The endpoint says held long after the node holds nothing, and
    // `Checking 0 installed apps for image updates` in the same log says so.
    //
    // app:removed and dos:changed arrive on ONE stream with monotonic ids, so
    // comparing their ids is a fact about what happened rather than a race
    // between two reads of two different sources.
    //
    // Both waits are armed BEFORE the pass runs, because both events are the
    // subject: the claim is that one precedes the other, so neither may be
    // sampled from a buffer read at a moment of this test's choosing. An
    // earlier form read the buffer as soon as app:removed landed and found no
    // DOS at all - DOS follows the departure by about two seconds, so it had
    // not happened yet. Awaiting both is what makes the comparison meaningful
    // rather than a race against whichever arrived first.
    const removal = env.clients[TARGET - 1].waitForEvent(
      'app:removed', (d) => d.name === 'residentapp', 300000,
    );
    const dosLanded = env.clients[TARGET - 1].waitForEvent(
      'dos:changed', (d) => d.dosState >= 100, 300000,
    );

    // Only the removal needs blocks. DOS is applied by the residential tick on
    // its own residentialCheckIntervalMs timer, so it arrives with the chain
    // stopped - which is also why it cannot be driven for.
    await driveUntil(env.clients[TARGET - 1], async () => {
      const buffer = env.clients[TARGET - 1].getEventBuffer();
      return buffer.some((e) => e.event === 'app:removed' && e.data?.name === 'residentapp');
    }, { timeoutMs: DEPARTURE_WAIT_MS });

    const [removedEvent, dosEvent] = await Promise.all([removal, dosLanded]);

    // One stream, monotonic ids, so this is an ordering fact rather than two
    // polls of two sources that disagree about what happened first.
    expect(dosEvent.id, 'DOS landed before the app was handed back')
      .to.be.above(removedEvent.id);

    // The node's own view, not app:removed - that event is published part-way
    // through the uninstall, after the runtime state is dropped and before the
    // installed-apps record is, so asserting on the record when it lands still
    // finds the app.
    await whenGone(env, TARGET, 'residentapp', 120000);
    await startTicker();
  });

  it('the app survives the departure on every other host', async function () {
    this.timeout(300000);

    // The point of the whole design: the app is still on the network. PR #1784
    // as originally written deleted this node's copy along with everything else
    // it held, and for an app whose every instance sat on residential nodes
    // that was the last copy.
    //
    // The replacement itself is not asserted here and cannot be on this fleet:
    // the app asks for five instances and all five nodes already ran it, so
    // there is no node left that is both short of it and not held. Refilling a
    // deficit is appSpawner's existing 120s loop, unchanged by this branch.
    // Wait for what is actually being asserted - the departure reaching the
    // rest of the fleet. Waiting on a COUNT was meaningless here: the app was
    // already at five instances including the one leaving, so `>= 4` was
    // satisfied before anything had happened.
    const targetIp = subnet.nodeIp(TARGET);
    await waitFor(async () => {
      const current = await locationsOf(env, 'residentapp');
      return !current.map((l) => l.ip.split(':')[0]).includes(targetIp);
    }, { timeout: 240000, label: 'the departure reaches the other nodes' });

    const locations = await locationsOf(env, 'residentapp');
    expect(locations.length).to.be.at.least(4);
  });

  it('goes into DOS only once it holds nothing', async function () {
    this.timeout(300000);

    await waitFor(async () => {
      const installed = await env.clients[TARGET - 1].get('/apps/installedapps');
      return installed.data.length === 0;
    }, { timeout: 240000, label: 'node 1 empties' });

    await waitFor(async () => {
      const info = await env.clients[TARGET - 1].get('/flux/info', { noCache: true });
      return info.data.flux.dos.dosState >= 100;
    }, { timeout: 120000, label: 'node 1 enters DOS after emptying' });

    const info = await env.clients[TARGET - 1].get('/flux/info', { noCache: true });
    expect(info.data.flux.dos.dosMessage).to.contain('Residential node not running ArcaneOS');
  });

  it('releases the node the moment it becomes attested', async function () {
    this.timeout(300000);

    await setSystemSecure(subnet.nodeIp(TARGET), true);

    await waitFor(async () => {
      const info = await env.clients[TARGET - 1].get('/flux/info', { noCache: true });
      return info.data.flux.dos.dosState < 100;
    }, { timeout: 120000, label: 'node 1 leaves DOS after migrating to ArcaneOS' });

    // And the settling window is torn down with it, so a node that flips back
    // serves the full window again rather than resuming a part-served one.
    await waitFor(async () => {
      const marker = await dbClient(TARGET).residentialMarker();
      return marker === null;
    }, { timeout: 60000, label: 'the settling marker is torn down with the verdict' });
  });

  it('will not hand back a stateful app while no peer demonstrably holds its data', async function () {
    this.timeout(600000);

    // worldapp mounts s:, so its volume IS the product - the shape of the ten
    // Palworld and Minecraft worlds on the real fleet, which sit at exactly two
    // instances. Nothing reports holding a copy of it.
    await seedApp(env, 'worldapp', { instances: 5, containerData: 's:/appdata' });

    // A synced folder has to be DECLARED before the app can run. The stub's
    // default for a folder nobody has spoken about is "no evidence", and a
    // sync-mounted component does not start against that - so without this the
    // app installs nowhere and never reaches an instance count at all.
    await setSynced({ folder: 'fluxworldapp_worldapp' });
    await setPeerHasData({ folder: 'fluxworldapp_worldapp' });

    await advanceBlocks(3);
    await waitForAppInstalled(env.clients[TARGET - 1], 'worldapp', 300000);

    // Let it reach full strength before enforcing. The pass refuses to act on an
    // app that is already short - that is the serialisation gate, and it fires
    // BEFORE the data check, so a test that starts too early proves nothing
    // about the data check at all.
    await waitFor(async () => (await locationsOf(env, 'worldapp')).length >= 5,
      { timeout: 300000, label: 'worldapp reaches its instance count across the fleet' });

    // Now take the evidence away: the data was there, and no peer can be shown
    // to hold it any more. This is the state the gate exists for.
    await setNoPeerData({ folder: 'fluxworldapp_worldapp' });

    await setSystemSecure(subnet.nodeIp(TARGET), false);
    await waitFor(async () => (await dbClient(TARGET).residentialMarker()) !== null,
      { timeout: 120000, label: 'the settling window starts again' });
    await elapseSettleWindow(TARGET);

    // Drive the chain so the pass is reached deterministically, and keep
    // driving until the verdict lands: the queue ticket is WALL-CLOCK, so
    // driving a fixed few blocks races through the chain in seconds and stops
    // long before this node's turn comes round.
    await stopTicker();
    let safetyVerdict = null;
    const considered = waitForGiveUpConsidered(env.clients[TARGET - 1], 'worldapp',
      (d) => d.giveUp === true && d.reason === 'EVACUATION', 300000);
    considered.catch(() => {});
    const refused = waitForGiveUpSafety(env.clients[TARGET - 1], 'worldapp',
      (d) => d.safe === false, 300000).then((v) => { safetyVerdict = v; return v; });
    refused.catch(() => {});
    await driveUntil(env.clients[TARGET - 1], async () => safetyVerdict !== null,
      { timeoutMs: DEPARTURE_WAIT_MS });
    await startTicker();

    // The pass reports on every app it holds, every pass, so this proves the
    // pass RAN and wanted this app - not merely that nothing happened.
    await considered;

    // And the gate is what stopped it. Before this, every removal path decided
    // on an instance count alone, and a count cannot tell a redundant copy from
    // the last one holding the data.
    const verdict = await refused;
    expect(verdict.data.detail).to.contain('fluxworldapp_worldapp');

    const installed = await env.clients[TARGET - 1].get('/apps/installedapps');
    expect(installed.data.map((a) => a.name)).to.include('worldapp');
  });

  it('hands the stateful app back once a peer holds it in full', async function () {
    this.timeout(600000);

    // The same node, the same pass, the same app - the only thing that changed
    // is that a connected peer now reports the folder complete. That contrast
    // is what shows the refusal above was the gate deciding rather than the
    // node simply being slow.
    await setPeerHasData({ folder: 'fluxworldapp_worldapp' });

    await stopTicker();
    await driveUntil(env.clients[TARGET - 1], async () => {
      const current = await env.clients[TARGET - 1].get('/apps/installedapps');
      return !current.data.map((a) => a.name).includes('worldapp');
    }, { timeoutMs: DEPARTURE_WAIT_MS });
    await startTicker();

    await whenGone(env, TARGET, 'worldapp', 120000);

    const locations = await locationsOf(env, 'worldapp');
    expect(locations.map((l) => l.ip.split(':')[0])).to.not.include(subnet.nodeIp(TARGET));
  });

  it('keeps the settling clock across a restart, so restarting cannot postpone the drain', async function () {
    this.timeout(600000);

    // The clock is persisted precisely so that bouncing FluxOS - on a cron, say
    // - cannot keep a node permanently just short of the window. An in-memory
    // counter of agreeing ticks would reset here, and this is the test that
    // would have caught that.
    //
    // What the window counts is time the node OBSERVED the verdict, not time
    // that elapsed, so the total observed is the half that has to survive: a
    // first-seen timestamp surviving a restart proves nothing on its own now.
    await returnToService(env, TARGET);

    // It has to be HOLDING something. An empty target goes straight to DOS -
    // there is no data at stake - and never starts a settling window at all.
    await seedApp(env, 'clockapp', { instances: 5 });
    await advanceBlocks(3);
    await waitForAppInstalled(env.clients[TARGET - 1], 'clockapp', 300000);

    await setSystemSecure(subnet.nodeIp(TARGET), false);
    await waitFor(async () => (await dbClient(TARGET).residentialMarker()) !== null,
      { timeout: 120000, label: 'the settling window starts' });
    // Let it confirm at least twice, so there is observed time to lose.
    await waitFor(async () => ((await dbClient(TARGET).residentialMarker()).observedMs || 0) > 0,
      { timeout: 120000, label: 'the node has accrued observed time' });
    const before = await dbClient(TARGET).residentialMarker();

    await env.restartNode(TARGET - 1);
    await waitForDaemonReady(env.clients[TARGET - 1]);

    // Positive evidence that the restarted node's residential service has run,
    // not just that mongo still holds a document. Mongo is a separate container
    // and restartNode restarts only FluxOS, so the marker survives whatever the
    // node does; and waitFor evaluates its condition on the first iteration, so
    // "the marker is still there" returned immediately and compared two reads
    // of a row nothing was required to touch. The service's only writer sits
    // behind nodeReady, which is raised by SPAWNER_READY - and the placement
    // hold is published by the same pass that would rewrite the marker.
    await waitForSpawnerBlocked(env.clients[TARGET - 1], 'placement_hold', 180000);
    const after = await dbClient(TARGET).residentialMarker();
    expect(after.residentialSince).to.eql(before.residentialSince);
    // The restart cost it nothing it had already watched.
    expect(after.observedMs).to.be.at.least(before.observedMs);
  });
});
