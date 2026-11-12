// fleet: 3
/*
 * A removal marks the app's record owed before it tears anything down, and deletes the
 * record last. When the database refuses that delete, the removal stops with the app
 * part removed: its containers and volume are gone, its record is not. The node holds
 * it owed - never announced - and the reconciler runs the teardown again until the
 * delete goes through, then tells the network it no longer holds the app.
 *
 * The removal is the node operator's own, of the app on this node. The node's deletes
 * of the record are refused REFUSED times: the removal's and the reconciler's next
 * runs of it, so the app is held across at least one announcement. A second app on
 * the node is in every announcement, which shows announcements went out.
 *
 * While the app is held, nothing installs it: the teardown that finishes it would take
 * whatever held its name. An install sent while the app is owed is refused.
 *
 * The node's own spawner is held for the app throughout, so the app it removed is not
 * placed on it again.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { pushImage } from '../framework/registry-helper.js';
import { buildSeedableApp } from '../framework/seed-helper.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { bootAndPeer, holdSpawnerExcept, installOnNodes } from '../framework/reconciler-suite.js';
import { getAppContainerId } from '../framework/container.js';
import { waitFor } from '../framework/wait.js';
import { failCommands } from '../framework/mongo-control.js';
import { authenticate } from '../auth.js';
import { fluxTeamKey } from '../framework/keys.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

const HOLDER = 0;
// The removal, and the reconciler's runs of the teardown 5 s and 30 s after it
// (appReconciler REMOVAL_BACKOFF_MS); the next run, 5 min on, goes through. The
// node announces every 86 s, so the app is held across at least one announcement.
const REFUSED = 3;
const FINISHED_MS = (5 + 30 + 300 + 120) * 1000;

function step(what) {
  console.log(`# 3309 ${new Date().toISOString()} ${what}`);
}

const removeHere = async (client, appName) => {
  const auth = await authenticate(client.url, fluxTeamKey());
  const res = await fetch(`${client.url}/apps/appremove/${appName}`, { headers: { zelidauth: auth.zelidauth } });
  return res.text();
};

const component = (name) => ({
  name,
  description: 'part removal test container',
  repotag: `${REGISTRY_REPO_HOST}/${name}:v1`,
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
});

describe('a removal that stops part way is finished', function () {
  let env;
  dumpLogsOnFailure(() => env);
  const stamp = Date.now();
  const appName = `e2epartremoved${stamp}`;
  const otherName = `e2epartother${stamp}`;
  let holder;
  let release;
  let anchors;
  let failedAt;

  const holds = async (name) => (await holder.getInstalledApps()).data?.some((a) => a.name === name) ?? null;

  before(async function () {
    this.timeout(600000);
    env = await createTestEnv({ hookCtx: this, nodes: 3, tickerAutostart: false });
    await bootAndPeer(env);
    holder = env.clients[HOLDER];

    await Promise.all([appName, otherName].map((name) => pushImage(name, 'v1')));
    const app = await buildSeedableApp({ pinnedTo: [HOLDER], name: appName, compose: [component(appName)] });
    const other = await buildSeedableApp({ pinnedTo: [HOLDER], name: otherName, compose: [component(otherName)] });
    await installOnNodes(env, app, [HOLDER]);
    await installOnNodes(env, other, [HOLDER]);
    await waitFor(async () => Boolean(await getAppContainerId(holder.container, appName, appName))
      && Boolean(await getAppContainerId(holder.container, otherName, otherName)), {
      timeout: 120000, interval: 2000, label: 'both apps run before the redeploy',
    });

    await holdSpawnerExcept(env, appName, []);
    release = await failCommands(HOLDER + 1, 'localzelapps', 'zelappsinformation', { commands: ['delete'], times: REFUSED });
    anchors = env.clients.map((client) => client?.getLastEventId());
    failedAt = holder.getLastEventId();
    step(`removal with the record delete refused ${REFUSED} times`);
    const body = await removeHere(holder, appName);
    if (/Unauthorized/i.test(body)) throw new Error(`removal refused: ${body.slice(0, 400)}`);
    step('removal returned');
  });

  after(async function () {
    this.timeout(60000);
    await release?.().catch(() => {});
    await env?.teardown();
  });

  it('no longer holds the app once its removal finishes', async function () {
    this.timeout(FINISHED_MS + 30000);
    await waitFor(async () => (await holds(appName)) === false, {
      timeout: FINISHED_MS, interval: 2000, label: 'the node no longer holds the app',
    });
  });

  it('had its deletes of the app\'s record refused by the database', async function () {
    const failed = await release();
    release = null;
    expect(failed, 'the database refused none of the node\'s row deletes, so nothing here was tested').to.be.at.least(1);
  });

  it('never announces the app once its removal has stopped part way', function () {
    const announcements = holder.getEventBuffer().filter((e) => e.id > failedAt && e.event === 'app:running');
    expect(
      announcements.some((e) => e.data.apps?.some((a) => a.name === otherName)),
      'the node announced nothing while the app was held, so nothing here was tested',
    ).to.equal(true);
    expect(
      announcements.filter((e) => e.data.apps?.some((a) => a.name === appName)).length,
      'the node announced an app it had part removed',
    ).to.equal(0);
  });

  it('tells the network it no longer holds the app', async function () {
    this.timeout(90000);
    const peers = env.clients.filter((client, i) => client && i !== HOLDER);
    const heard = await Promise.any(peers.map((peer) => peer.waitForEvent(
      'network:appremoved',
      (d) => d.name === appName && d.ip.startsWith(holder.ip),
      60000,
      { afterId: anchors[env.clients.indexOf(peer)] },
    ))).catch(() => null);
    expect(heard, 'no node was told the app had gone').to.not.equal(null);
  });
});

describe('an app whose removal is pending takes no install', function () {
  let env;
  dumpLogsOnFailure(() => env);
  const appName = `e2eheldnoinstall${Date.now()}`;
  let holder;
  let release;
  let afterFailure;
  let failedDeletes;

  before(async function () {
    this.timeout(600000);
    env = await createTestEnv({ hookCtx: this, nodes: 3, tickerAutostart: false });
    await bootAndPeer(env);
    holder = env.clients[HOLDER];

    await pushImage(appName, 'v1');
    const app = await buildSeedableApp({ pinnedTo: [HOLDER], name: appName, compose: [component(appName)] });
    await installOnNodes(env, app, [HOLDER]);
    await waitFor(async () => Boolean(await getAppContainerId(holder.container, appName, appName)), {
      timeout: 120000, interval: 2000, label: 'the app runs before the redeploys',
    });

    await holdSpawnerExcept(env, appName, []);
    release = await failCommands(HOLDER + 1, 'localzelapps', 'zelappsinformation', { commands: ['delete'], times: 1 });
    step('removal with the record delete refused once');
    const removed = await removeHere(holder, appName);
    if (/Unauthorized/i.test(removed)) throw new Error(`removal refused: ${removed.slice(0, 400)}`);
    failedDeletes = await release();
    release = null;
    afterFailure = holder.getLastEventId();
    step('install while the app is owed');
    const auth = await authenticate(holder.url, fluxTeamKey());
    await holder.installAppLocally(appName, auth.zelidauth);
    step('install returned');
  });

  after(async function () {
    this.timeout(60000);
    await release?.().catch(() => {});
    await env?.teardown();
  });

  it('had its delete of the app\'s record refused by the database', function () {
    expect(failedDeletes, 'the database refused none of the node\'s row deletes, so nothing here was tested').to.equal(1);
  });

  it('no longer holds the app once its removal finishes', async function () {
    this.timeout(120000);
    await waitFor(async () => (await holder.getInstalledApps()).data?.some((a) => a.name === appName) === false, {
      timeout: 90000, interval: 2000, label: 'the node no longer holds the app',
    });
  });

  it('never installs the app while its removal is pending', function () {
    const installed = holder.getEventBuffer().filter((e) => e.id > afterFailure && e.event === 'app:installed'
      && e.data.name === appName);
    expect(installed.length, 'the node installed an app its pending removal then took').to.equal(0);
  });
});
