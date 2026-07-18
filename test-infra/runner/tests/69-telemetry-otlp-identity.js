import {
  describe, it, before, after,
} from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer, installOnNodes } from '../framework/reconciler-suite.js';
import { registerEncryptedV9App, updateEncryptedV9App } from '../framework/content-helper.js';
import { queueAppTx, advanceBlock, advanceBlocks } from '../framework/daemon-control.js';
import { waitForAppInstalled } from '../framework/wait.js';
import { pushTestApp } from '../framework/registry-helper.js';
import { buildSeedableTestApp } from '../framework/seed-helper.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { execInContainer } from '../framework/container.js';
import {
  telemetrydControl, waitForTelemetryEvent, announcedIdentities,
} from '../framework/telemetryd-control.js';

// OTLP telemetry (Option B): the app declares its own observability agent as an
// ordinary component, and flux-telemetryd emits OTLP to that agent's receiver on
// the app's Docker network. What crosses the identity socket for such an app is
// a sink of exactly `{provider:'otlp', endpoint:'http://<agent-ip>:<port>'}` —
// FluxOS resolves the agent container's address; the daemon never learns the
// declared component/port shape and never talks to Docker.
//
// This suite stands up an Arcane fleet with the mock flux-telemetryd
// (telemetrydMock — the daemon-side CLIENT of the identity socket) and drives
// the FluxOS half end to end: registration through the real submission door,
// install, announce, reconnect-sync, agent recreation, the scoping gate, and a
// port-changing spec update.
// The daemon's own half (cgroup sampling, OTLP protobuf emission, exporter
// rotation on a changed endpoint) is covered by the daemon's unit tests and the
// live-node validation — the harness cannot run a host daemon.
// 5 nodes: the peering bar below (minOutbound 2) needs a mesh big enough that
// dial-dedupe still leaves ~2 outbound per node — see suite 68's sizing note.
const NODES = 5;
const APP = 'otlptelapp';
const AGENT = 'otelagent';
const AGENT_PORT = 4318;
const UPDATED_PORT = 4317;
const PLAIN = 'otlplainapp';

const agentContainer = `flux${AGENT}_${APP}`;

const image = `${REGISTRY_REPO_HOST}/${APP}:v1`;
const components = {
  web: {
    name: 'web',
    description: 'workload component',
    image,
    cpu: 0.2,
    memory: 200,
    rootFsGb: 2,
    persistentStorage: { sizeGb: 1, mounts: {} },
    ports: { http: { containerPort: 80, hostPort: 31350 } },
  },
  // The agent is portless on purpose: it is reachable only node-locally on
  // the app's network — exactly the deployment model the telemetry block
  // points at. It does not need to speak OTLP here; the daemon side is
  // mocked, and FluxOS resolves addresses without probing ports.
  [AGENT]: {
    name: AGENT,
    description: 'customer observability agent (OTLP receiver)',
    image,
    cpu: 0.2,
    memory: 200,
    rootFsGb: 2,
    persistentStorage: { sizeGb: 1, mounts: {} },
  },
};

// The agent's address on the app's network, read from the node's inner dockerd
// (each node is DinD; app containers live inside it). Polls: during a recreate
// there is a window where the container is absent or created-but-unstarted, and
// an unset address renders as "invalid IP" (netip zero value), not "".
async function agentIp(client, { timeout = 30000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const r = await execInContainer(
      client.container,
      `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${agentContainer}`,
    );
    const ip = r.output.trim();
    if (r.exitCode === 0 && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
    if (Date.now() > deadline) throw new Error(`agent has no IP within ${timeout}ms: ${r.output}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 500); });
  }
}

const forApp = (identities, appName) => identities.filter((a) => a.identity.app_name === appName);

describe('otlp telemetry: the identity socket carries the resolved agent endpoint', function () {
  let env;
  let client;
  let control;
  let installedIndex;

  before(async function () {
    this.timeout(600000);
    env = await createTestEnv({
      hookCtx: this, nodes: NODES, tickerAutostart: false, telemetrydMock: true,
      // The registration door checks the submit node's own peer counts against
      // config; relax minOutgoing to what a 5-node mesh actually yields. The
      // stagger overrides bound the update-adoption delay (default window is
      // 5min — production pacing) so the port-change scenario converges inside
      // its budget.
      configOverrides: {
        fluxapps: {
          minOutgoing: 2,
          adoptionStaggerStepMs: 15000,
          adoptionStaggerWindowMs: 15000,
        },
      },
    });
    await bootAndPeer(env, { minOutbound: 2, minInbound: 2, pricing: true });

    await pushTestApp(APP);
    const res = await registerEncryptedV9App(env.clients[0].url, {
      name: APP,
      components,
      instances: 3,
      specOverrides: { telemetry: { provider: 'otlp', component: AGENT } },
    });
    expect(res.status, JSON.stringify(res)).to.equal('success');

    await queueAppTx(res.data);
    await advanceBlocks(3);
    installedIndex = await Promise.any(env.clients.map(async (c, i) => {
      await waitForAppInstalled(c, APP, 240000);
      return i;
    }));
    client = env.clients[installedIndex];
    control = telemetrydControl(installedIndex + 1);
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('announces every container of the app with the resolved otlp endpoint', async function () {
    this.timeout(120000);
    const ip = await agentIp(client);
    const endpoint = `http://${ip}:${AGENT_PORT}`;

    // Both components — the agent is itself part of the app and gets telemetry
    // too — announced with the same resolved endpoint.
    await waitForTelemetryEvent(control, (e) => {
      const ids = forApp(announcedIdentities([e]), APP);
      return ids.some((a) => a.identity.tags?.component === 'web' && a.identity.sink?.endpoint === endpoint);
    }, { timeout: 90000 });
    await waitForTelemetryEvent(control, (e) => {
      const ids = forApp(announcedIdentities([e]), APP);
      return ids.some((a) => a.identity.tags?.component === AGENT && a.identity.sink?.endpoint === endpoint);
    }, { timeout: 30000 });
  });

  it('puts only {provider, endpoint} on the wire — never the declared component/port shape', async () => {
    const ids = forApp(announcedIdentities(await control.getEvents()), APP);
    expect(ids.length).to.be.greaterThan(0);
    for (const a of ids) {
      expect(Object.keys(a.identity.sink).sort()).to.deep.equal(['endpoint', 'provider']);
      expect(a.identity.sink.provider).to.equal('otlp');
      expect(a.identity.sink.endpoint).to.match(/^http:\/\/\d+\.\d+\.\d+\.\d+:4318$/);
    }
  });

  it('replays a full sync with resolved endpoints when the daemon reconnects', async function () {
    this.timeout(60000);
    // The reconnect sync is the daemon-restart / fluxos-restart recovery path:
    // the server rebuilds the snapshot from the live container list, so the
    // endpoint must resolve without any docker event having fired.
    const { conn: before } = await control.health();
    await control.disconnect();
    await waitForTelemetryEvent(control, (e) => e.op === 'sync'
      && e.conn > before
      && (e.containers || []).some((c) => c.identity.app_name === APP
        && /^http:\/\/\d+\.\d+\.\d+\.\d+:4318$/.test(c.identity.sink?.endpoint || '')), { timeout: 45000 });
  });

  it('keeps the announced endpoint correct across an agent recreate', async function () {
    this.timeout(240000);
    await control.reset();

    // Kill the agent out from under FluxOS: the reconciler recreates it and the
    // new container is announced with a resolved endpoint. The IP allocator
    // hands the lowest free address back, so a solo recreate reuses the same
    // address — the endpoint must come through unchanged, and no resync fires
    // (rotation on an actually-changed endpoint is unit-covered on both sides;
    // no deterministic recreate stimulus can change the address here).
    const r = await execInContainer(client.container, `docker rm -f ${agentContainer}`);
    expect(r.exitCode, `docker rm -f: ${r.output}`).to.equal(0);

    await waitForTelemetryEvent(control, (e) => {
      const ids = forApp(announcedIdentities([e]), APP);
      return ids.some((a) => a.identity.tags?.component === AGENT
        && /^http:\/\/\d+\.\d+\.\d+\.\d+:4318$/.test(a.identity.sink?.endpoint || ''));
    }, { timeout: 180000 });

    const ip = await agentIp(client);
    const endpoint = `http://${ip}:${AGENT_PORT}`;
    const agentAnnounces = forApp(announcedIdentities(await control.getEvents()), APP)
      .filter((a) => a.identity.tags?.component === AGENT);
    expect(agentAnnounces.at(-1).identity.sink?.endpoint).to.equal(endpoint);

    // A reconnect sync rebuilds the snapshot from the live container list, so
    // this pins the post-recreate state: every component of the app routes at
    // the recreated agent's address.
    const { conn } = await control.health();
    await control.disconnect();
    await waitForTelemetryEvent(control, (e) => e.op === 'sync'
      && e.conn > conn
      && ['web', AGENT].every((comp) => (e.containers || []).some((c) => c.identity.app_name === APP
        && c.identity.tags?.component === comp
        && c.identity.sink?.endpoint === endpoint)), { timeout: 45000 });
  });

  it('announces nothing for an app without telemetry (the scoping gate)', async function () {
    this.timeout(180000);
    await pushTestApp(PLAIN);
    const plain = await buildSeedableTestApp({ name: PLAIN, port: 31351 });
    await installOnNodes(env, plain, [installedIndex]);

    // The announce (if any) fires during install (create/start); the install
    // has completed, so a short settle covers the async event path.
    await new Promise((resolve) => { setTimeout(resolve, 3000); });
    const ids = forApp(announcedIdentities(await control.getEvents()), PLAIN);
    expect(ids, 'a sinkless app must never reach the identity socket').to.deep.equal([]);
  });

  it('routes every container at the new port after a spec update changes it', async function () {
    this.timeout(300000);
    await control.reset();

    // Change nothing but the telemetry port. Update adoption soft-redeploys
    // the app (containers are recreated on any spec change), so this pins the
    // pipeline end to end: update door → respec → sink re-seed → fresh
    // resolution → announces carrying the new port, with the stale cached
    // endpoint replaced. The isolated live-rotation path (sink change with no
    // container lifecycle event) has no deterministic harness stimulus and is
    // unit-covered on both sides.
    const res = await updateEncryptedV9App(env.clients[0].url, {
      name: APP,
      components,
      instances: 3,
      specOverrides: { telemetry: { provider: 'otlp', component: AGENT, port: UPDATED_PORT } },
    });
    expect(res.status, JSON.stringify(res)).to.equal('success');
    await queueAppTx(res.data);
    await advanceBlocks(3);

    // Update convergence runs at blocks processed at the tip (see suite 68's
    // sizing note) — advance one block per round, wait for every node to
    // process that height, then check the daemon-side view.
    const endpointRe = new RegExp(`^http://\\d+\\.\\d+\\.\\d+\\.\\d+:${UPDATED_PORT}$`);
    const announcedAtNewPort = (events, comp) => forApp(announcedIdentities(events), APP)
      .some((a) => a.identity.tags?.component === comp && endpointRe.test(a.identity.sink?.endpoint || ''));

    let converged = false;
    for (let round = 0; round < 40 && !converged; round += 1) {
      // eslint-disable-next-line no-await-in-loop
      const { currentHeight } = await advanceBlock();
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(env.clients.map((c) => c.waitForEvent(
        'block:processed', (d) => d.height >= currentHeight, 60000,
      )));
      // eslint-disable-next-line no-await-in-loop
      const events = await control.getEvents();
      converged = announcedAtNewPort(events, 'web') && announcedAtNewPort(events, AGENT);
    }
    expect(converged, 'both components announced at the updated port').to.equal(true);

    // Ground truth and shape: every new-port announce carries exactly the
    // recreated agent's live address, and only {provider, endpoint} ever
    // crossed the wire during the update churn.
    const ip = await agentIp(client);
    const endpoint = `http://${ip}:${UPDATED_PORT}`;
    const ids = forApp(announcedIdentities(await control.getEvents()), APP);
    const atNewPort = ids.filter((a) => endpointRe.test(a.identity.sink?.endpoint || ''));
    expect(atNewPort.length).to.be.greaterThan(0);
    for (const a of atNewPort) {
      expect(a.identity.sink.endpoint).to.equal(endpoint);
    }
    for (const a of ids) {
      expect(Object.keys(a.identity.sink).sort()).to.deep.equal(['endpoint', 'provider']);
    }
  });
});
