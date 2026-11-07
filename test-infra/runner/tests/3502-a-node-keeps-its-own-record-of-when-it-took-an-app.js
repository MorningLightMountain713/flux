// fleet: 3
/*
 * A node announces each instance it holds from when it took it: the placedAt its
 * resources hold, which follows the instance's data. The install that creates the
 * resources dates them (app:placementRecorded, source install); a rebuild, which
 * recreates the volumes, dates them again (source rebuild); a soft redeploy keeps
 * the volumes and the date; the removal takes the resources and the date with them.
 * A rebuilt copy holds none of the data the old date stood for, so it must not
 * rank as the senior copy its peers choose a primary from.
 *
 * One instance, pinned to the middle of a three-node ring.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { pushImage } from '../framework/registry-helper.js';
import { buildSeedableApp } from '../framework/seed-helper.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { bootAndPeer, installOnNodes } from '../framework/reconciler-suite.js';
import { dbClient } from '../framework/db-client.js';
import { socketAddr } from '../framework/state-events.js';
import { waitFor, assertNoEvent, waitForAppRemoved } from '../framework/wait.js';
import { authenticate } from '../auth.js';
import { appOwnerKey } from '../framework/keys.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

const HOLDER = 1;
const OTHERS = [0, 2];
const bare = (address) => String(address).replace(/:16127$/, '');

describe('a node keeps its own record of when it took an app', function () {
  let env;
  dumpLogsOnFailure(() => env);
  const appName = `e2eplacement${Date.now()}`;
  let holder;
  let holderAddress;
  let auth;
  // The holder's runningSince for the app, as its announcements carry it.
  let announcedSince;

  const runningSinceIn = (data) => {
    const entry = data.apps?.find((a) => a.name === appName);
    return entry ? new Date(entry.runningSince).getTime() : null;
  };
  const marks = () => env.clients.map((c) => c.getLastEventId());
  // The runningSince each other node stored from the holder's next announcement
  // after `afterIds`.
  async function nextStoredRunningSince(afterIds, timeout = 240000) {
    const events = await Promise.all(OTHERS.map((i) => env.clients[i].waitForEvent(
      'network:apprunning',
      (d) => bare(d.ip) === bare(holderAddress) && d.apps?.some((a) => a.name === appName),
      timeout,
      { afterId: afterIds[i] },
    )));
    return events.map(({ data }) => runningSinceIn(data));
  }
  const ledgerDate = async () => {
    const [row] = await dbClient(HOLDER + 1).placementsOf(appName);
    return row?.placedAt ? new Date(row.placedAt).getTime() : null;
  };
  // The redeploy's progress stream: the last status is what answers.
  const lastStatus = (body) => {
    const statuses = [...body.matchAll(/"status"\s*:\s*"([^"]*)"/g)].map((m) => m[1]);
    return statuses[statuses.length - 1];
  };

  before(async function () {
    this.timeout(600000);
    env = await createTestEnv({ hookCtx: this, nodes: 3, tickerAutostart: false });
    await bootAndPeer(env);
    holder = env.clients[HOLDER];
    holderAddress = socketAddr(HOLDER + 1);
    await pushImage(appName, 'v1');
    const app = await buildSeedableApp({
      name: appName,
      instances: 1,
      pinnedTo: [HOLDER],
      compose: [{
        name: appName,
        description: 'placement record',
        repotag: `${REGISTRY_REPO_HOST}/${appName}:v1`,
        ports: [],
        domains: [''],
        environmentParameters: [],
        commands: [],
        containerPorts: [80],
        containerData: '/tmp',
        cpu: 0.1,
        ram: 100,
        hdd: 1,
        repoauth: '',
      }],
    });
    const installMark = holder.getLastEventId();
    await installOnNodes(env, app, [HOLDER]);
    const { data: recorded } = await holder.waitForEvent('app:placementRecorded', (d) => d.name === appName, 120000, { afterId: installMark });
    expect(recorded.source, 'fixture: the install dated the instance').to.equal('install');
    announcedSince = new Date(recorded.placedAt).getTime();
    auth = await authenticate(holder.url, appOwnerKey());
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('records when it took the app at install, and announces that', async function () {
    this.timeout(300000);
    expect(await ledgerDate(), 'the resources do not hold the install\'s date').to.equal(announcedSince);
    const stored = await nextStoredRunningSince(marks());
    expect(stored, 'a peer stored a runningSince other than the install\'s').to.deep.equal(OTHERS.map(() => announcedSince));
  });

  it('keeps the date, and the time it announces, through a soft redeploy', async function () {
    this.timeout(420000);
    const afterIds = marks();
    const body = await holder.redeployApp(appName, auth.zelidauth, { force: false });
    expect(lastStatus(body), `the redeploy did not finish: ${body.slice(-600)}`).to.equal('success');

    await assertNoEvent(holder, 'app:placementRecorded', (d) => d.name === appName, 0, { afterId: afterIds[HOLDER] });
    expect(await ledgerDate(), 'the soft redeploy changed the date').to.equal(announcedSince);
    const stored = await nextStoredRunningSince(marks());
    expect(stored, 'the soft redeploy re-dated the app').to.deep.equal(OTHERS.map(() => announcedSince));
  });

  // A rebuild starts the app again from an empty volume: the copy holds none of
  // the data the old date stood for.
  it('dates the app again, and announces it, after a rebuild', async function () {
    this.timeout(420000);
    const afterIds = marks();
    const body = await holder.redeployApp(appName, auth.zelidauth, { force: true });
    expect(lastStatus(body), `the rebuild did not finish: ${body.slice(-600)}`).to.equal('success');

    const { data: recorded } = await holder.waitForEvent('app:placementRecorded', (d) => d.name === appName, 10000, { afterId: afterIds[HOLDER] });
    expect(recorded.source).to.equal('rebuild');
    const placedAt = new Date(recorded.placedAt).getTime();
    expect(placedAt, 'the rebuild\'s date is not newer than the install\'s').to.be.above(announcedSince);
    expect(await ledgerDate(), 'the resources do not hold the rebuild\'s date').to.equal(placedAt);

    const stored = await nextStoredRunningSince(marks());
    expect(stored, 'the announced runningSince is not the rebuild\'s').to.deep.equal(OTHERS.map(() => placedAt));
    announcedSince = placedAt;
  });

  it('drops the date with the app', async function () {
    this.timeout(240000);
    expect(await dbClient(HOLDER + 1).placementsOf(appName), 'the instance\'s resources before the removal').to.have.lengthOf(1);
    const mark = holder.getLastEventId();
    const body = await holder.removeAppLocally(appName, auth.zelidauth);
    await waitForAppRemoved(holder, appName, 180000, { afterId: mark })
      .catch(() => { throw new Error(`the app was not removed: ${body.slice(-400)}`); });

    await waitFor(async () => (await dbClient(HOLDER + 1).placementsOf(appName)).length === 0, {
      timeout: 60000, interval: 2000, label: 'the instance\'s resources are gone with it',
    });
  });
});
