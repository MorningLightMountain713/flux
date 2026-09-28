// fleet: 5
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { dbClient } from '../framework/db-client.js';
import {
  advanceBlocks, driveUntil, startTicker, stopTicker, setSystemSecure, clearSystemSecure,
} from '../framework/daemon-control.js';
import { waitFor, waitForGiveUpConsidered } from '../framework/wait.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';
import {
  subnet, TARGET, SECOND_TARGET, bootResidentialFleet, seedApp, returnToService,
  elapseSettleWindow, departureWaitMs,
} from '../framework/residential-fleet.js';

// Where an app runs, as node 2 derives it from its app state event log and
// serves it: rows carry the holder's ip:port.
async function locationsOf(env, name) {
  const res = await env.clients[2].getAppLocations(name);
  return Array.isArray(res?.data) ? res.data : [];
}

// A FLEET OF ITS OWN. Both holders here need a departure to actually happen, and a
// node sheds ONE app per departure interval; on suite 55's fleet this would sit
// behind every app its tests leave on node 1.
describe('Residential node evacuation: one holder at a time', function () {
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

  it('only one residential node gives up an app at a time', async function () {
    this.timeout(900000);

    // The claim that makes the drain terminate: a departure takes the app below
    // its instance count, and every OTHER evacuating holder sees that and waits.
    // With one target node it is untestable by construction - it needs two.
    // Node 3 is published residential like node 1, so withdrawing its
    // attestation puts it in the same position.
    await returnToService(env, TARGET);

    await seedApp(env, 'sharedapp', { instances: 5 });
    await advanceBlocks(3);
    await waitFor(async () => (await locationsOf(env, 'sharedapp')).length >= 5,
      { timeout: 300000, label: 'sharedapp reaches its instance count across the fleet' });

    await setSystemSecure(subnet.nodeIp(TARGET), false);
    await setSystemSecure(subnet.nodeIp(SECOND_TARGET), false);
    await Promise.all([TARGET, SECOND_TARGET].map((node) => waitFor(
      async () => (await dbClient(node).residentialMarker()) !== null,
      { timeout: 120000, label: `node ${node} starts its settling window` },
    )));

    // Opened together, so both nodes are evacuating through the same turns.
    await Promise.all([TARGET, SECOND_TARGET].map((node) => elapseSettleWindow(node)));

    // Whichever goes first, the other must be refused while the app is short -
    // by the pacing decision, which refuses a short app before the pass ever
    // consults appEvacuationSafety.
    let refusal = null;
    const refusedForBeingShort = Promise.race([TARGET, SECOND_TARGET].map((node) => waitForGiveUpConsidered(
      env.clients[node - 1], 'sharedapp',
      (d) => d.giveUp === false && d.code === 'BELOW_INSTANCE_COUNT', 600000,
    ))).then((v) => { refusal = v; return v; });
    refusedForBeingShort.catch(() => {});

    // Keep driving UNTIL the refusal arrives, not just until the first
    // departure. The give-up pass only runs on a block, so stopping the chain
    // the moment one node leaves means the other never gets a pass in which to
    // refuse, and the wait times out on a suite that stopped the clock itself.
    // STOP ON THE VIOLATION TOO, not only on the refusal. The property here is
    // that the second holder does NOT depart, so a run where it does has already
    // answered the question - and waiting out the full departure budget for a
    // refusal that cannot now arrive reports it as a slow box. Three sessions
    // have read this timeout as one.
    // A departure is the app LEAVING the node. The pacing half's READY is not
    // one: the safety half reads the location table again before it removes,
    // and refuses an app that went short between the two reads.
    const departures = () => [TARGET, SECOND_TARGET]
      .map((node) => env.clients[node - 1].getEventBuffer()
        .filter((e) => e.event === 'app:removed' && e.data?.name === 'sharedapp').length)
      .reduce((a, b) => a + b, 0);

    await stopTicker();
    await driveUntil(env.clients[TARGET - 1],
      async () => refusal !== null || departures() >= 2,
      { timeoutMs: departureWaitMs([TARGET, SECOND_TARGET]) });
    await startTicker();

    expect(departures(), 'both holders handed the same app back, so one-at-a-time did not hold')
      .to.be.lessThan(2);

    const verdict = await refusedForBeingShort;
    expect(verdict.data.code).to.equal('BELOW_INSTANCE_COUNT');
    expect(verdict.data.detail).to.contain('below its instance count');
  });
});
