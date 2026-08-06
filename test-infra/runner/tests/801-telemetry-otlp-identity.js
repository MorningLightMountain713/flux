// weight: heavy
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
// install, announce (send-set gated — the same-app collector stays out by
// default), reconnect-sync, agent recreation, the scoping gate, a
// port-changing spec update that also overrides the send set, and inter-app
// collector routing via shareWith.
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
const COLLECTOR_APP = 'otlplogstack';
const SHIPPER = 'otlpshipper';

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

// A container's address on its app network, read from the node's inner
// dockerd (each node is DinD; app containers live inside it). Polls: during
// a recreate there is a window where the container is absent or
// created-but-unstarted, and an unset address renders as "invalid IP"
// (netip zero value), not "".
async function containerIp(client, containerName, { timeout = 30000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const r = await execInContainer(
      client.container,
      `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${containerName}`,
    );
    const ip = r.output.trim();
    if (r.exitCode === 0 && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
    if (Date.now() > deadline) throw new Error(`${containerName} has no IP within ${timeout}ms: ${r.output}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 500); });
  }
}

const agentIp = (client, opts) => containerIp(client, agentContainer, opts);

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

  it('announces the send set at the resolved endpoint — the collector itself stays out', async function () {
    this.timeout(120000);
    const ip = await agentIp(client);
    const endpoint = `http://${ip}:${AGENT_PORT}`;

    await waitForTelemetryEvent(control, (e) => {
      const ids = forApp(announcedIdentities([e]), APP);
      return ids.some((a) => a.identity.tags?.component === 'web' && a.identity.sink?.endpoint === endpoint);
    }, { timeout: 90000 });

    // The default send set excludes the same-app collector: a collector
    // ingesting its own log stream feedback-amplifies. Settle past the
    // create/start announce window before pinning the absence.
    await new Promise((resolve) => { setTimeout(resolve, 3000); });
    const agents = forApp(announcedIdentities(await control.getEvents()), APP)
      .filter((a) => a.identity.tags?.component === AGENT);
    expect(agents, 'the same-app collector must never announce by default').to.deep.equal([]);
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

    // Kill the agent out from under FluxOS: the reconciler recreates it. The
    // IP allocator hands the lowest free address back, so a solo recreate
    // reuses the same address — the endpoint must come through unchanged
    // (rotation on an actually-changed endpoint is unit-covered on both
    // sides; no deterministic recreate stimulus can change the address
    // here). The collector is outside the send set, so its recreate emits
    // no announce of its own — docker is the recreate signal.
    const r = await execInContainer(client.container, `docker rm -f ${agentContainer}`);
    expect(r.exitCode, `docker rm -f: ${r.output}`).to.equal(0);

    const ip = await agentIp(client, { timeout: 180000 });
    const endpoint = `http://${ip}:${AGENT_PORT}`;

    // A reconnect sync rebuilds the snapshot from the live container list, so
    // this pins the post-recreate state: the send set routes at the recreated
    // agent's address, and the collector still announces nothing.
    const { conn } = await control.health();
    await control.disconnect();
    await waitForTelemetryEvent(control, (e) => e.op === 'sync'
      && e.conn > conn
      && (e.containers || []).some((c) => c.identity.app_name === APP
        && c.identity.tags?.component === 'web'
        && c.identity.sink?.endpoint === endpoint), { timeout: 45000 });
    const agents = forApp(announcedIdentities(await control.getEvents()), APP)
      .filter((a) => a.identity.tags?.component === AGENT);
    expect(agents, 'the recreated collector must stay out of the send set').to.deep.equal([]);
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

  it('routes the updated send set at the new port after a spec update', async function () {
    this.timeout(300000);
    await control.reset();

    // The update changes the telemetry port AND sets an explicit components
    // list that includes the collector — the customer's deliberate override
    // of the default exclusion. Update adoption redeploys the app
    // (containers are recreated on any spec change), so this pins the
    // pipeline end to end: update door → respec → sink re-seed → fresh
    // resolution → BOTH components announced at the new port, stale cached
    // endpoint replaced. The isolated live-rotation path (sink change with
    // no container lifecycle event) has no deterministic harness stimulus
    // and is unit-covered on both sides.
    const res = await updateEncryptedV9App(env.clients[0].url, {
      name: APP,
      components,
      instances: 3,
      specOverrides: {
        telemetry: {
          provider: 'otlp', component: AGENT, components: ['web', AGENT], port: UPDATED_PORT,
        },
      },
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

  it('routes a consumer at a shareWith-linked collector where they co-reside — and stays silent elsewhere', async function () {
    this.timeout(480000);

    // Two apps through the real door: a collector app with no telemetry of
    // its own, and a consumer whose sink routes cross-app.
    await pushTestApp(COLLECTOR_APP);
    const collectorRes = await registerEncryptedV9App(env.clients[0].url, {
      name: COLLECTOR_APP,
      components: {
        collector: {
          name: 'collector',
          description: 'shared log collector',
          image: `${REGISTRY_REPO_HOST}/${COLLECTOR_APP}:v1`,
          cpu: 0.2,
          memory: 200,
          rootFsGb: 2,
          persistentStorage: { sizeGb: 1, mounts: {} },
        },
      },
      instances: 3,
    });
    expect(collectorRes.status, JSON.stringify(collectorRes)).to.equal('success');
    await queueAppTx(collectorRes.data);
    await advanceBlocks(3);
    await Promise.any(env.clients.map((c) => waitForAppInstalled(c, COLLECTOR_APP, 240000)));

    await pushTestApp(SHIPPER);
    const shipperRes = await registerEncryptedV9App(env.clients[0].url, {
      name: SHIPPER,
      components: {
        sender: {
          name: 'sender',
          description: 'workload shipping to the linked collector',
          image: `${REGISTRY_REPO_HOST}/${SHIPPER}:v1`,
          cpu: 0.2,
          memory: 200,
          rootFsGb: 2,
          persistentStorage: { sizeGb: 1, mounts: {} },
          ports: { http: { containerPort: 80, hostPort: 31352 } },
        },
      },
      instances: 3,
      specOverrides: {
        network: { shareWith: [COLLECTOR_APP] },
        telemetry: { provider: 'otlp', app: COLLECTOR_APP, component: 'collector' },
      },
    });
    expect(shipperRes.status, JSON.stringify(shipperRes)).to.equal('success');
    await queueAppTx(shipperRes.data);
    await advanceBlocks(3);
    await Promise.any(env.clients.map((c) => waitForAppInstalled(c, SHIPPER, 300000)));

    // Loose placement spreads 3 collector + 3 sender instances over 5 nodes:
    // co-residency SOMEWHERE is pigeonhole-guaranteed; everywhere is not —
    // manageCollectorLifecycle is off (the console owns collector lifecycle;
    // a dependency is "ready" once installed anywhere). Drive blocks until
    // both apps reach their instance counts, then hold each node to its own
    // contract: a co-resident sender routes at the local collector, a sender
    // without one stays off the wire (the loud-warn unresolved state).
    const present = async (client, name) => {
      const r = await execInContainer(client.container, `docker ps --format '{{.Names}}' --filter name=${name}`);
      return r.exitCode === 0 && r.output.includes(name);
    };
    let placement = [];
    for (let round = 0; round < 40; round += 1) {
      // eslint-disable-next-line no-await-in-loop
      const { currentHeight } = await advanceBlock();
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(env.clients.map((c) => c.waitForEvent(
        'block:processed', (d) => d.height >= currentHeight, 60000,
      )));
      // eslint-disable-next-line no-await-in-loop
      placement = await Promise.all(env.clients.map(async (c) => ({
        sender: await present(c, `fluxsender_${SHIPPER}`),
        collector: await present(c, `fluxcollector_${COLLECTOR_APP}`),
      })));
      if (placement.filter((p) => p.sender).length >= 3
        && placement.filter((p) => p.collector).length >= 3) break;
    }
    const overlap = placement.flatMap((p, i) => (p.sender && p.collector ? [i] : []));
    const senderOnly = placement.flatMap((p, i) => (p.sender && !p.collector ? [i] : []));
    expect(overlap.length, `no co-resident node: ${JSON.stringify(placement)}`).to.be.greaterThan(0);

    for (const i of overlap) {
      // eslint-disable-next-line no-await-in-loop
      const ip = await containerIp(env.clients[i], `fluxcollector_${COLLECTOR_APP}`);
      const endpoint = `http://${ip}:${AGENT_PORT}`;
      // eslint-disable-next-line no-await-in-loop
      await waitForTelemetryEvent(telemetrydControl(i + 1), (e) => {
        const ids = forApp(announcedIdentities([e]), SHIPPER);
        return ids.some((a) => a.identity.tags?.component === 'sender' && a.identity.sink?.endpoint === endpoint);
      }, { timeout: 90000 });
    }

    // Senders with no local collector stay off the wire, and the collector
    // app itself ships nothing anywhere (it declares no telemetry).
    for (const [i] of env.clients.entries()) {
      // eslint-disable-next-line no-await-in-loop
      const events = await telemetrydControl(i + 1).getEvents();
      expect(forApp(announcedIdentities(events), COLLECTOR_APP),
        'a sinkless collector app must never announce').to.deep.equal([]);
      if (senderOnly.includes(i)) {
        expect(forApp(announcedIdentities(events), SHIPPER),
          `node ${i} has no local collector — its sender must stay unannounced`).to.deep.equal([]);
      }
    }
  });
});
