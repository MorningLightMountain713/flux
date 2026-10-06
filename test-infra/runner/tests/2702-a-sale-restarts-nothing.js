// fleet: 5
/*
 * An app is sold while it runs.
 *
 * A sale is an update whose specification names another owner, signed by the
 * owner on record. It changes no component, so a node running the app adopts
 * it without touching a container: nothing on a container says who owns its
 * app, and flux-shutdownd knows the app by its identity, which a sale keeps.
 * Who may open a terminal or a log stream on the app's containers is read from
 * the app's record, so once the sale has applied they open for the buyer and
 * not for the seller.
 *
 * The seller and the buyer each hold a signed session throughout, so every
 * refusal here is the owner check's and never the session check's.
 *
 * The sale enters by the delivery route, as every seeded update does: the node
 * is handed the seller's signed message and its payment is mined. The
 * submission door (/apps/appupdate) is another suite's subject.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { io } from 'socket.io-client';
import { createTestEnv } from '../framework/test-env.js';
import { authenticate } from '../auth.js';
import { appOwnerKey } from '../framework/keys.js';
import { buyerKey } from '../framework/transfer-helper.js';
import { bootAndPeer, installOnNodes, seedSpecUpdate } from '../framework/reconciler-suite.js';
import { buildSeedableApp, buildSeedableUpdate } from '../framework/seed-helper.js';
import { pushTestApp } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import {
  componentIdentifier, execInContainer, getAppContainerId, requireAppContainerName,
} from '../framework/container.js';
import { waitForUp } from '../framework/wait.js';
import { driveUntil, stopTicker } from '../framework/daemon-control.js';
import { shutdowndControl, waitForShutdowndCall } from '../framework/shutdownd-control.js';

const NODES = 5;
const NODE_IDX = 0; // the one node the app is pinned to
const GRACEFUL_S = 3;
const SOCKET_TIMEOUT_MS = 20000;

// Asks a node for the log stream of a container and resolves with its answer:
// { subscribed: true }, { error } or, when it says nothing, { timedOut: true }.
function openLogStream(client, zelidauth, nameOrId) {
  return new Promise((resolve, reject) => {
    const socket = io(`${client.url}/applogs`, {
      transports: ['websocket'], reconnection: false, timeout: SOCKET_TIMEOUT_MS,
    });
    let timer = null;
    const done = (result) => {
      clearTimeout(timer);
      socket.close();
      resolve(result);
    };
    timer = setTimeout(() => done({ timedOut: true }), SOCKET_TIMEOUT_MS);
    socket.on('subscribed', () => done({ subscribed: true }));
    socket.on('error', (message) => done({ error: String(message) }));
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      socket.close();
      reject(new Error(`applogs: connect_error ${err.message}`));
    });
    socket.on('connect', () => socket.emit('subscribe', zelidauth, nameOrId));
  });
}

// Asks a node for a terminal in a container and resolves with its answer:
// { opened: true } once the session streams, { error }, or { timedOut: true }.
// The test app's image holds one binary and no shell, so the session runs that
// binary; the pty echoes what is typed into it, and that echo is the stream.
function openTerminal(client, zelidauth, nameOrId) {
  return new Promise((resolve, reject) => {
    const socket = io(`${client.url}/terminal`, {
      transports: ['websocket'], reconnection: false, timeout: SOCKET_TIMEOUT_MS,
    });
    let timer = null;
    let typer = null;
    const done = (result) => {
      clearTimeout(timer);
      clearInterval(typer);
      socket.close();
      resolve(result);
    };
    timer = setTimeout(() => done({ timedOut: true }), SOCKET_TIMEOUT_MS);
    socket.on('show', () => done({ opened: true }));
    socket.on('error', (message) => done({ error: String(message) }));
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      socket.close();
      reject(new Error(`terminal: connect_error ${err.message}`));
    });
    socket.on('connect', () => {
      socket.emit('exec', zelidauth, nameOrId, '/bin/test-app', '', '');
      typer = setInterval(() => socket.emit('cmd', 'x'), 100);
    });
  });
}

describe('an app sold while it runs is restarted by nothing, and its terminal and log stream pass to the buyer', function () {
  let env;
  let client;
  let control;
  let app;
  let sold;
  // The container's own name, which a socket is given.
  let identifier;
  let seller;
  let buyer;
  // What the node ran, and what the daemon held, before the sale.
  let containerBefore;
  let plansBefore;

  const appName = `e2esale${Date.now()}`;

  async function localSpec() {
    const res = await client.getInstalledApps();
    if (res.status !== 'success') return null;
    return (res.data ?? []).find((a) => a.name === appName) ?? null;
  }

  // The container docker holds for the app: its id, which a recreate changes,
  // and when it last started, which a restart changes.
  async function runningContainer() {
    const id = await getAppContainerId(client.container, appName, appName);
    const name = await requireAppContainerName(client.container, appName, appName);
    const { stdout } = await execInContainer(client.container, `docker inspect --format '{{.State.StartedAt}}' ${name}`);
    return { id, startedAt: stdout.trim() };
  }

  before(async function () {
    this.timeout(600000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      tickerAutostart: false,
      arcane: true,
      shutdownd: 'stub',
      // A pinned app's update is adopted on a stagger; kept short so the
      // adoption falls inside the blocks the test drives.
      configOverrides: { fluxapps: { adoptionStaggerStepMs: 5000, adoptionStaggerWindowMs: 10000 } },
    });
    await bootAndPeer(env, { minOutbound: 2, minInbound: 1 });
    client = env.clients[NODE_IDX];
    control = shutdowndControl(NODE_IDX + 1);

    await pushTestApp(appName);
    // Graceful, so the daemon holds a plan for it; writing log lines, so its
    // stream has something to follow.
    app = await buildSeedableApp({
      pinnedTo: [NODE_IDX],
      name: appName,
      instances: 1,
      compose: [{
        name: appName,
        description: `sold while it runs. gracefulShutdownSec:${GRACEFUL_S}`,
        repotag: `${REGISTRY_REPO_HOST}/${appName}:v1`,
        ports: [],
        domains: [''],
        environmentParameters: ['EXIT_CODE=0', 'LOG_EVERY_MS=200'],
        commands: [],
        containerPorts: [80],
        containerData: '/tmp',
        cpu: 0.1,
        ram: 100,
        hdd: 1,
        repoauth: '',
      }],
    });
    await installOnNodes(env, app, [NODE_IDX]);
    await waitForUp(client, appName, `${appName} running before the sale`);
    identifier = componentIdentifier(app);

    seller = await authenticate(client.url, appOwnerKey());
    buyer = await authenticate(client.url, buyerKey());
    expect(buyerKey().zelid, 'the fixture names two owners').to.not.equal(appOwnerKey().zelid);
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('before the sale, opens the terminal and the log stream for the owner and refuses another signed-in user', async function () {
    this.timeout(120000);

    expect(await openLogStream(client, seller.zelidauth, identifier), 'the owner\'s log stream').to.deep.equal({ subscribed: true });
    expect(await openTerminal(client, seller.zelidauth, identifier), 'the owner\'s terminal').to.deep.equal({ opened: true });

    expect((await openLogStream(client, buyer.zelidauth, identifier)).error, 'a log stream for a user who is not the owner').to.match(/Not authorized/);
    expect((await openTerminal(client, buyer.zelidauth, identifier)).error, 'a terminal for a user who is not the owner').to.match(/Not authorized/);
  });

  it('adopts the sale: the node\'s records name the buyer', async function () {
    // A backstop: the block budget below is what bounds this test.
    this.timeout(1500000);

    containerBefore = await runningContainer();
    plansBefore = (await control.getState()).plans;
    expect(plansBefore, 'the daemon holds the app\'s plan under its identity before the sale').to.include(app.identity);
    // The plans outlive a reset; the call log starts again, so what it holds
    // afterwards is the sale's traffic alone.
    await control.reset();

    sold = await buildSeedableUpdate(app, (spec) => { spec.owner = buyerKey().zelid; });
    expect(sold.hash, 'the sale is another message').to.not.equal(app.hash);
    expect(sold.identity, 'a sale keeps the app\'s identity').to.equal(app.identity);

    await seedSpecUpdate(env, sold, [NODE_IDX]);
    // The only advancer from here: a second one leaves every other block stale
    // on arrival.
    await stopTicker();
    await driveUntil(
      client,
      async () => (await localSpec())?.hash === sold.hash,
      { blocks: 108, label: 'the node adopts the sale' },
    );

    expect((await localSpec()).owner, 'the installed record names the buyer').to.equal(buyerKey().zelid);
    const listed = await client.getAppSpecs(appName);
    expect(listed.data?.owner, 'the registry names the buyer').to.equal(buyerKey().zelid);
  });

  it('restarts nothing: the container is the one that was running, and nothing was stopped through the daemon', async function () {
    this.timeout(60000);

    const containerAfter = await runningContainer();
    expect(containerAfter.id, 'the container was not recreated').to.equal(containerBefore.id);
    expect(containerAfter.startedAt, 'the container was not restarted').to.equal(containerBefore.startedAt);

    // The adoption's own call to the daemon, the last thing it does: once it is
    // in the log, every stop the adoption could have asked for is too.
    await waitForShutdowndCall(control, (c) => c.method === 'upsert_app_plan' && c.identity === app.identity);
    const calls = await control.getCalls();
    expect(
      calls.filter((c) => c.method === 'begin_app_stop' || c.method === 'force_app_stop'),
      'no stop was asked of the daemon',
    ).to.deep.equal([]);
  });

  it('leaves the daemon\'s plan where it was: one plan, under the app\'s identity', async function () {
    this.timeout(60000);

    expect((await control.getState()).plans).to.deep.equal(plansBefore);
    const calls = await control.getCalls();
    expect(calls.filter((c) => c.method === 'delete_app_plan'), 'no plan was deleted').to.deep.equal([]);
  });

  it('after the sale, opens the terminal and the log stream for the buyer and refuses the seller', async function () {
    this.timeout(120000);

    expect(await openLogStream(client, buyer.zelidauth, identifier), 'the buyer\'s log stream').to.deep.equal({ subscribed: true });
    expect(await openTerminal(client, buyer.zelidauth, identifier), 'the buyer\'s terminal').to.deep.equal({ opened: true });

    expect((await openLogStream(client, seller.zelidauth, identifier)).error, 'a log stream for the seller').to.match(/Not authorized/);
    expect((await openTerminal(client, seller.zelidauth, identifier)).error, 'a terminal for the seller').to.match(/Not authorized/);
  });
});
