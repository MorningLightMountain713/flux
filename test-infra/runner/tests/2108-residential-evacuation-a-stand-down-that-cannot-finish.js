// fleet: 5
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { dbClient } from '../framework/db-client.js';
import {
  advanceBlocks, driveUntil, startTicker, stopTicker, setSystemSecure, clearSystemSecure,
} from '../framework/daemon-control.js';
import { waitFor } from '../framework/wait.js';
import { setNoPeerData, setPeerHasData, setSynced } from '../framework/syncthing-control.js';
import { electMaster } from '../framework/fdm-control.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';
import {
  subnet, TARGET, bootResidentialFleet, seedApp, returnToService, elapseSettleWindow,
  runningComponents, departureWaitMs, RESIDENTIAL_PACING, PASS_MS,
} from '../framework/residential-fleet.js';
import { keysOf, turnOwner, untilOwnedTurnEndsMs } from '../framework/handback-turns.js';

// A FLEET OF ITS OWN, so a stood-down app stays on node 1 without delaying the
// departures suite 2107 waits for.
describe('Residential node evacuation: a stand-down that cannot finish', function () {
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

  /** Node TARGET, the elected primary of a fresh g: app, drains until it stands down. */
  async function standDown(appName) {
    const folder = `flux${appName}_${appName}`;
    await returnToService(env, TARGET);
    await electMaster(appName, subnet.nodeIp(TARGET));
    await seedApp(env, appName, { instances: 5, syncMode: 'activeStandby' });
    await setSynced({ folder });
    await setPeerHasData({ folder });
    await advanceBlocks(3);
    await waitFor(async () => (await dbClient(2).getAppLocations(appName)).length >= 5,
      { timeout: 300000, label: `${appName} reaches its instance count across the fleet` });
    await waitFor(async () => (await runningComponents(env, TARGET)).includes(folder),
      { timeout: 300000, label: 'the elected primary is running the activeStandby component' });

    await setSystemSecure(subnet.nodeIp(TARGET), false);
    await waitFor(async () => (await dbClient(TARGET).residentialMarker()) !== null,
      { timeout: 120000, label: 'the settling window starts' });
    await elapseSettleWindow(TARGET);

    const client = env.clients[TARGET - 1];
    const anchor = client.getLastEventId();
    const stoodDown = () => client.getEventBuffer().find((e) => e.id > anchor && e.event === 'giveUp:standDown'
      && e.data?.appName === appName);
    await stopTicker();
    await driveUntil(client, async () => stoodDown() !== undefined, { timeoutMs: departureWaitMs([TARGET]) });
    return { event: stoodDown(), folder };
  }

  it('stands for election again once it has owned a turn since without being able to leave', async function () {
    this.timeout(900000);
    const client = env.clients[TARGET - 1];
    const { event, folder } = await standDown('releaseapp');
    // No peer holds the folder any more, so its next owned turn cannot remove.
    await setNoPeerData({ folder });
    const stoodDownTurn = client.getEventBuffer()
      .filter((e) => e.event === 'giveUp:turn' && e.data?.appName === 'releaseapp' && e.id < event.id).pop().data.turn;
    const released = () => client.getEventBuffer().find((e) => e.id > event.id && e.event === 'giveUp:standDownReleased'
      && e.data?.identifier === 'releaseapp_releaseapp');

    await driveUntil(client, async () => released() !== undefined, {
      timeoutMs: untilOwnedTurnEndsMs({
        holders: keysOf([1, 2, 3, 4, 5]),
        owners: keysOf([TARGET]),
        turnMs: RESIDENTIAL_PACING.residentialTurnMs,
        fromMs: (stoodDownTurn + 1) * RESIDENTIAL_PACING.residentialTurnMs,
      }) + RESIDENTIAL_PACING.residentialTurnMs + (2 * PASS_MS),
    });
    await startTicker();

    expect(released().data.reason).to.equal('OWNED_TURN_PASSED');
    // Released in a turn after the one it owned: it had that whole turn to leave in.
    const at = client.getEventBuffer()
      .filter((e) => e.event === 'giveUp:turn' && e.data?.appName === 'releaseapp' && e.id < released().id).pop().data.turn;
    const owned = Array.from({ length: at - stoodDownTurn - 1 }, (_, i) => stoodDownTurn + 1 + i)
      .filter((turn) => turnOwner(keysOf([1, 2, 3, 4, 5]), turn) === keysOf([TARGET])[0]);
    expect(owned, 'released before it owned a whole turn').to.not.be.empty;
    const installed = await client.get('/apps/installedapps');
    expect(installed.data.map((a) => a.name)).to.include('releaseapp');
  });

  it('stands for election again once the node stops evacuating', async function () {
    this.timeout(900000);
    const client = env.clients[TARGET - 1];
    const { event } = await standDown('returnapp');
    await setSystemSecure(subnet.nodeIp(TARGET), true);
    const released = () => client.getEventBuffer().find((e) => e.id > event.id && e.event === 'giveUp:standDownReleased'
      && e.data?.identifier === 'returnapp_returnapp');

    await driveUntil(client, async () => released() !== undefined, { timeoutMs: 120000 + (2 * PASS_MS) });
    await startTicker();

    expect(released().data.reason).to.equal('NOT_EVACUATING');
  });
});
