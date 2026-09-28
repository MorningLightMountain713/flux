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
  subnet, DEPARTURE_WAIT_MS, seedApp, returnToService, elapseSettleWindow, TARGET, locationsOf, SECOND_TARGET, bootResidentialFleet,
} from '../framework/residential-evacuation.js';

// A FLEET OF ITS OWN. Both tests need a departure to happen, and a node sheds one
// app per departure interval while a node inside that interval accrues nothing
// towards any other app's turn. On a fleet whose node 1 already held other apps these
// would queue behind them, and DEPARTURE_WAIT_MS - two cycles - would not contain
// the departure.
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

    // Opened TOGETHER, not one after the other. The queue ticket is
    // `observed >= base + position*step`, and `observed` starts when a node
    // first sees the app whole - so it fixes a different DURATION per node, not
    // a different deadline. Open the two windows a few seconds apart and the
    // later start with the shorter wait lands on the same instant as the earlier
    // start with the longer one, both nodes decide in the same pass, and the
    // ordering the test exists to prove is gone. In production both holders
    // start observing together, which is what makes position decide.
    await Promise.all([TARGET, SECOND_TARGET].map((node) => elapseSettleWindow(node)));

    // Whichever goes first, the other must be refused while the app is short.
    //
    // Read from the PACING decision, not the safety gate. The strength test sits
    // in the queue ticket now - an app short of its count accrues nothing
    // towards its turn - so a short app is refused before the pass ever consults
    // appEvacuationSafety, and the safety event this used to wait on is never
    // published. The refusal itself is unchanged, and it carries the same name
    // for the same fact one layer up.
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
      { timeoutMs: DEPARTURE_WAIT_MS });
    await startTicker();

    expect(departures(), 'both holders handed the same app back, so one-at-a-time did not hold')
      .to.be.lessThan(2);

    const verdict = await refusedForBeingShort;
    expect(verdict.data.code).to.equal('BELOW_INSTANCE_COUNT');
    expect(verdict.data.detail).to.contain('below its instance count');
  });

  it('serves a fresh queue turn after a departure, not one that matured during it', async function () {
    this.timeout(900000);

    // The ticket is the only thing separating two holders of one app, and it
    // separates them only while it is still binding. A node inside its
    // departure interval cannot act on anything, so time passing there is not
    // evidence about any app it holds - but the ticket used to keep maturing
    // through the block anyway, and the node came out of it instantly ready for
    // everything at once. Two holders whose blocks expire in the same pass -
    // and the pass is fired from a block height, so the whole fleet runs it
    // together - then hand back the same app in the same pass, both read it at
    // full strength, and both delete.
    //
    // Written as ONE node's second departure rather than two nodes colliding:
    // the collision needs both blocks to expire on the same pass, which is a
    // coincidence to arrange and a tautology to assert. What actually fixes it
    // is that a departure restarts the queue, and that is directly observable.
    await returnToService(env, TARGET);
    await returnToService(env, SECOND_TARGET);

    await seedApp(env, 'firstout', { instances: 5 });
    await seedApp(env, 'secondout', { instances: 5 });
    await advanceBlocks(3);
    await waitFor(async () => {
      const first = await locationsOf(env, 'firstout');
      const second = await locationsOf(env, 'secondout');
      return first.length >= 5 && second.length >= 5;
    }, { timeout: 300000, label: 'both apps reach their instance count across the fleet' });

    await setSystemSecure(subnet.nodeIp(TARGET), false);
    await waitFor(async () => (await dbClient(TARGET).residentialMarker()) !== null,
      { timeout: 120000, label: 'the settling window starts' });
    await elapseSettleWindow(TARGET);

    const client = env.clients[TARGET - 1];
    const seeded = ['firstout', 'secondout'];
    const wentFirst = (e) => e.event === 'app:removed' && seeded.includes(e.data?.name);

    await stopTicker();
    await driveUntil(env.clients[TARGET - 1], async () => client.getEventBuffer().some(wentFirst),
      { timeoutMs: DEPARTURE_WAIT_MS });
    const gone = client.getEventBuffer().filter(wentFirst).pop();
    const remaining = gone.data.name === 'firstout' ? 'secondout' : 'firstout';

    // Through the block every pass refuses with 'next departure in'. The first
    // time it says 'its turn is in' AFTER that departure, the block has cleared
    // and the ticket has started over - which is the claim. On the accounting
    // this replaces the ticket had matured inside the block, so the same pass
    // removed the second app instead and this never arrives.
    const turnRestarted = (e) => e.event === 'giveUp:considered'
      && e.data?.appName === remaining
      && e.data?.giveUp === false
      && /its turn is in/.test(e.data?.detail || '')
      && e.id > gone.id;

    await driveUntil(env.clients[TARGET - 1], async () => client.getEventBuffer().some(turnRestarted),
      { timeoutMs: DEPARTURE_WAIT_MS });
    await startTicker();

    // One stream, monotonic ids: the second app was still waiting its turn on a
    // pass that came after the first one left, rather than leaving with it.
    const verdict = client.getEventBuffer().filter(turnRestarted).pop();
    expect(verdict, `${remaining} never served a fresh turn after the departure`).to.not.be.undefined;
    expect(client.getEventBuffer().some(
      (e) => e.event === 'app:removed' && e.data?.name === remaining && e.id < verdict.id,
    ), `${remaining} left during the departure interval instead of serving a turn`).to.equal(false);
  });
});
