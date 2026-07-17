import {
  describe, it, before, after,
} from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer, installOnNodes } from '../framework/reconciler-suite.js';
import { registerEncryptedV9App } from '../framework/content-helper.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
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
// install, announce, reconnect-sync, agent recreation, and the scoping gate.
// The daemon's own half (cgroup sampling, OTLP protobuf emission, exporter
// rotation on a changed endpoint) is covered by the daemon's unit tests and the
// live-node validation — the harness cannot run a host daemon.
const NODES = 3;
const APP = 'otlptelapp';
const AGENT = 'otelagent';
const AGENT_PORT = 4318;
const PLAIN = 'otlplainapp';

const agentContainer = `flux${AGENT}_${APP}`;

// The agent's address on the app's network, read from the node's inner dockerd
// (each node is DinD; app containers live inside it).
async function agentIp(client) {
  const r = await execInContainer(
    client.container,
    `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${agentContainer}`,
  );
  if (r.exitCode !== 0) throw new Error(`agent inspect failed: ${r.output}`);
  const ip = r.output.trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error(`agent inspect returned no IP: ${r.output}`);
  return ip;
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
    });
    await bootAndPeer(env, { minOutbound: 2, minInbound: 1, pricing: true });

    await pushTestApp(APP);
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

  it('re-announces the app with a fresh endpoint after the agent container is recreated', async function () {
    this.timeout(240000);
    await control.reset();

    // Kill the agent out from under FluxOS: the reconciler recreates it (a new
    // container, possibly a new address), its announce re-resolves the
    // endpoint, and the sink-change resync re-announces the app's containers.
    const r = await execInContainer(client.container, `docker rm -f ${agentContainer}`);
    expect(r.exitCode, `docker rm -f: ${r.output}`).to.equal(0);

    await waitForTelemetryEvent(control, (e) => {
      const ids = forApp(announcedIdentities([e]), APP);
      return ids.some((a) => a.identity.tags?.component === AGENT);
    }, { timeout: 180000 });

    const ip = await agentIp(client);
    const endpoint = `http://${ip}:${AGENT_PORT}`;
    await waitForTelemetryEvent(control, (e) => {
      const ids = forApp(announcedIdentities([e]), APP);
      return ids.some((a) => a.identity.tags?.component === 'web' && a.identity.sink?.endpoint === endpoint);
    }, { timeout: 60000 });
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
});
