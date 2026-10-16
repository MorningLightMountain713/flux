'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const nodeCrypto = require('node:crypto');
const nodeNet = require('node:net');
const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');

describe('telemetryIdentityService tests', () => {
  let service;
  let runCommandStub;
  let dockerServiceStub;
  let geolocationServiceStub;
  let sinkCacheStub;
  let logStub;
  let collateralStub;
  let eventStreamStub;

  const datadogSink = { provider: 'datadog', site: 'datadoghq.com', apiKey: 'k1' };

  // The identity labels FluxOS stamps on a container. A component born before v9
  // has its name as its key; an app with no minted identity has its name as one.
  function labelsFor(app, component, { key = component, identity = app, replica } = {}) {
    const labels = {
      'io.runonflux.app': app,
      'io.runonflux.component': component,
      'io.runonflux.identifier': [key, identity, replica].filter(Boolean).join('_'),
      'io.runonflux.identity': identity,
    };
    if (replica) labels['io.runonflux.replica'] = replica;
    return labels;
  }

  beforeEach(() => {
    dockerServiceStub = {
      dockerListContainers: sinon.stub().resolves([]),
      dockerContainerInspect: sinon.stub().resolves(null),
    };

    geolocationServiceStub = {
      getNodeGeolocation: sinon.stub().resolves({ continentCode: 'NA', country: 'US' }),
    };

    // Map-backed fake mirroring the real cache's semantics (lowercased keys,
    // entries() for the reverse collector lookup) — getSink stays a sinon
    // stub so call assertions keep working. Seed via sinkCacheStub.seed().
    const sinkMap = new Map();
    sinkCacheStub = {
      seed: (app, sink) => sinkMap.set(String(app).toLowerCase(), sink),
      getSink: sinon.stub().callsFake((app) => sinkMap.get(String(app).toLowerCase()) || null),
      entries: () => sinkMap.entries(),
      onChange: sinon.stub(),
    };

    logStub = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };

    runCommandStub = sinon.stub().resolves({ error: null, stdout: '', stderr: '' });
    collateralStub = sinon.stub().resolves({ txhash: 'ab'.repeat(32) });
    eventStreamStub = { start: sinon.stub().resolves(), stop: sinon.stub() };
    service = proxyquire('../../ZelBack/src/services/telemetryIdentityService', {
      'node:crypto': nodeCrypto,
      'node:net': nodeNet,
      'node:fs': nodeFs,
      '../lib/log': logStub,
      './dockerService': dockerServiceStub,
      './serviceHelper': { runCommand: runCommandStub },
      './geolocationService': geolocationServiceStub,
      './telemetrySinkCache': sinkCacheStub,
      './generalService': { obtainNodeCollateralInformation: collateralStub },
      './utils/dockerEventStream': { createDockerEventStream: () => eventStreamStub },
    });
  });

  afterEach(async () => {
    await service.stop();
    sinon.restore();
  });

  describe('buildIdentity (telemetry scoping gate)', () => {
    it('returns null for a container without the identity labels', async () => {
      sinkCacheStub.seed('MyApp', datadogSink);
      expect(await service.buildIdentity('/fluxweb_MyApp', 'nginx:1', 'NA', {})).to.be.null;
      expect(await service.buildIdentity('/nginx', 'nginx:1', 'NA', undefined)).to.be.null;
    });

    it('returns null when the app has no cached sink (not a telemetry app)', async () => {
      expect(await service.buildIdentity('/fluxweb_MyApp', 'nginx:1', 'NA', labelsFor('MyApp', 'web'))).to.be.null;
    });

    it('builds identity with sink and tags for a telemetry app', async () => {
      sinkCacheStub.seed('MyApp', datadogSink);
      const id = await service.buildIdentity('/fluxfrontend_MyApp', 'nginx:1.25', 'NA', labelsFor('MyApp', 'frontend'));
      expect(id.app_name).to.equal('MyApp');
      expect(id.sink).to.deep.equal(datadogSink);
      expect(id.tags).to.deep.equal({
        component: 'frontend',
        identifier: 'frontend_MyApp',
        identity: 'MyApp',
        image_name: 'nginx:1.25',
        container_name: 'fluxfrontend_MyApp',
        region: 'NA',
      });
      expect(sinkCacheStub.getSink.calledWith('MyApp')).to.equal(true);
    });

    it('omits region when none is available', async () => {
      sinkCacheStub.seed('MyApp', datadogSink);
      const id = await service.buildIdentity('/fluxweb_MyApp', 'nginx:1', null, labelsFor('MyApp', 'web'));
      expect(id.tags).to.not.have.property('region');
    });
  });

  describe('a component named by its key', () => {
    const identity = 'a1b2c3d4e5f6';
    const webKey = 'c7f3k2m9q4w8e6r1t5y0u2i7o3p9a4s8d6f1g5h0j2k7l3z9x4c';
    const agentKey = 'c2v8b4n6m1q9w3e7r5t0y8u2i6o4p1a9s3d7f5g0h8j2k6l4z1x';
    const otlpSink = { provider: 'otlp', component: 'otelagent', port: 4318 };
    const net = { [`fluxDockerNetwork_${identity}`]: { IPAddress: '172.23.11.3' } };
    const web = labelsFor('MyApp', 'web', { key: webKey, identity });
    const agent = labelsFor('MyApp', 'otelagent', { key: agentKey, identity });

    it('tags the component by its name', async () => {
      sinkCacheStub.seed('MyApp', datadogSink);
      const id = await service.buildIdentity(`/flux${webKey}_${identity}`, 'nginx:1', 'NA', web);
      expect(id.app_name).to.equal('MyApp');
      expect(id.tags.component).to.equal('web');
    });

    it('is matched by a components list', async () => {
      sinkCacheStub.seed('MyApp', { ...otlpSink, components: ['web'] });
      await service.refreshAgentEndpoint(net, agent);
      expect(await service.buildIdentity(`/flux${webKey}_${identity}`, 'nginx:1', 'NA', web)).to.not.be.null;
    });

    it('is recognised as its app\'s collector, at its address on the identity\'s network', async () => {
      sinkCacheStub.seed('MyApp', otlpSink);
      expect(await service.refreshAgentEndpoint(
        { fluxDockerNetwork_Other: { IPAddress: '172.23.77.2' }, ...net },
        agent,
      )).to.equal(true);
      expect((await service.buildIdentity(`/flux${webKey}_${identity}`, 'nginx:1', 'NA', web)).sink)
        .to.deep.equal({ provider: 'otlp', endpoint: 'http://172.23.11.3:4318' });
      expect(await service.buildIdentity(`/flux${agentKey}_${identity}`, 'otel:1', 'NA', agent),
        'a collector ingesting its own stream amplifies').to.be.null;
    });

    it('reports a renamed component under its new name', async () => {
      sinkCacheStub.seed('MyApp', datadogSink);
      const id = await service.buildIdentity('/fluxdb_MyApp', 'mongo:7', 'NA', labelsFor('MyApp', 'database', { key: 'db' }));
      expect(id.tags.component).to.equal('database');
      expect(id.tags.identifier).to.equal('db_MyApp');
    });

    it('carries the identifier, the identity and the replica', async () => {
      sinkCacheStub.seed('MyApp', datadogSink);
      const labels = labelsFor('MyApp', 'web', { key: webKey, identity, replica: 'r1' });
      const id = await service.buildIdentity(`/flux${webKey}_${identity}_r1`, 'nginx:1', 'NA', labels);
      expect(id.tags.identifier).to.equal(`${webKey}_${identity}_r1`);
      expect(id.tags.identity).to.equal(identity);
      expect(id.tags.replica).to.equal('r1');
    });
  });

  describe('otlp endpoint resolution (refreshAgentEndpoint + wire sink)', () => {
    const otlpSink = { provider: 'otlp', component: 'otelagent', port: 4318 };
    const agentNetworks = { fluxDockerNetwork_MyApp: { IPAddress: '172.23.11.3' } };

    it('an otlp container stays unannounced until the agent endpoint resolves', async () => {
      sinkCacheStub.seed('MyApp', otlpSink);
      expect(await service.buildIdentity('/fluxweb_MyApp', 'nginx:1', 'NA', labelsFor('MyApp', 'web'))).to.be.null;
    });

    it('resolves the endpoint from the agent container and projects the wire sink', async () => {
      sinkCacheStub.seed('MyApp', otlpSink);
      expect(await service.refreshAgentEndpoint(agentNetworks, labelsFor('MyApp', 'otelagent'))).to.equal(true);
      const id = await service.buildIdentity('/fluxweb_MyApp', 'nginx:1', 'NA', labelsFor('MyApp', 'web'));
      // The wire carries only provider + endpoint — never the declared
      // component/port shape the cache holds.
      expect(id.sink).to.deep.equal({ provider: 'otlp', endpoint: 'http://172.23.11.3:4318' });
    });

    it('ignores containers that are not the declared agent component', async () => {
      sinkCacheStub.seed('MyApp', otlpSink);
      expect(await service.refreshAgentEndpoint(agentNetworks, labelsFor('MyApp', 'web'))).to.equal(false);
    });

    it('ignores containers of non-otlp apps', async () => {
      sinkCacheStub.seed('MyApp', datadogSink);
      expect(await service.refreshAgentEndpoint(agentNetworks, labelsFor('MyApp', 'otelagent'))).to.equal(false);
    });

    it('reports unchanged endpoints as false and a moved agent as true', async () => {
      sinkCacheStub.seed('MyApp', otlpSink);
      expect(await service.refreshAgentEndpoint(agentNetworks, labelsFor('MyApp', 'otelagent'))).to.equal(true);
      expect(await service.refreshAgentEndpoint(agentNetworks, labelsFor('MyApp', 'otelagent'))).to.equal(false);
      const moved = { fluxDockerNetwork_MyApp: { IPAddress: '172.23.11.9' } };
      expect(await service.refreshAgentEndpoint(moved, labelsFor('MyApp', 'otelagent'))).to.equal(true);
      const id = await service.buildIdentity('/fluxweb_MyApp', 'nginx:1', 'NA', labelsFor('MyApp', 'web'));
      expect(id.sink.endpoint).to.equal('http://172.23.11.9:4318');
    });

    it('prefers the app network address, falling back to any attached network', async () => {
      sinkCacheStub.seed('MyApp', otlpSink);
      const foreignOnly = { fluxDockerNetwork_OtherApp: { IPAddress: '172.23.77.2' } };
      expect(await service.refreshAgentEndpoint(foreignOnly, labelsFor('MyApp', 'otelagent'))).to.equal(true);
      expect((await service.buildIdentity('/fluxweb_MyApp', 'nginx:1', 'NA', labelsFor('MyApp', 'web'))).sink.endpoint)
        .to.equal('http://172.23.77.2:4318');
    });

    it('sendSync resolves agent endpoints from the live container list', async () => {
      sinkCacheStub.seed('MyApp', otlpSink);
      dockerServiceStub.dockerListContainers.resolves([
        {
          Id: 'a'.repeat(64),
          Names: ['/fluxotelagent_MyApp'],
          Labels: labelsFor('MyApp', 'otelagent'),
          Image: 'otel/opentelemetry-collector-contrib:latest',
          NetworkSettings: { Networks: agentNetworks },
        },
        {
          Id: 'b'.repeat(64),
          Names: ['/fluxweb_MyApp'],
          Labels: labelsFor('MyApp', 'web'),
          Image: 'nginx:1',
          NetworkSettings: { Networks: {} },
        },
      ]);
      const socket = { destroyed: false, write: sinon.stub() };
      await service.sendSync(socket);
      const payload = JSON.parse(socket.write.firstCall.args[0]);
      expect(payload.op).to.equal('sync');
      // web routes through the resolved collector; the collector itself sits
      // outside the default send set (the feedback-loop gate).
      expect(payload.containers).to.have.length(1);
      expect(payload.containers[0].identity.tags.component).to.equal('web');
      expect(payload.containers[0].identity.sink).to.deep.equal({ provider: 'otlp', endpoint: 'http://172.23.11.3:4318' });
    });
  });

  describe('otlp log-shipping routing (cross-app collectors + send set)', () => {
    const collectorNet = { fluxDockerNetwork_logstack: { IPAddress: '172.23.40.2' } };

    it('default send set excludes the same-app collector (feedback-loop gate)', async () => {
      sinkCacheStub.seed('MyApp', { provider: 'otlp', component: 'otelagent', port: 4318 });
      await service.refreshAgentEndpoint({ fluxDockerNetwork_MyApp: { IPAddress: '172.23.11.3' } }, labelsFor('MyApp', 'otelagent'));
      expect(await service.buildIdentity('/fluxweb_MyApp', 'nginx:1', 'NA', labelsFor('MyApp', 'web'))).to.not.be.null;
      expect(await service.buildIdentity('/fluxotelagent_MyApp', 'otel:1', 'NA', labelsFor('MyApp', 'otelagent')), 'a collector ingesting its own stream amplifies').to.be.null;
    });

    it('an explicit components list overrides the default and may include the collector', async () => {
      sinkCacheStub.seed('MyApp', {
        provider: 'otlp', component: 'otelagent', port: 4318, components: ['web', 'otelagent'],
      });
      await service.refreshAgentEndpoint({ fluxDockerNetwork_MyApp: { IPAddress: '172.23.11.3' } }, labelsFor('MyApp', 'otelagent'));
      expect(await service.buildIdentity('/fluxweb_MyApp', 'nginx:1', 'NA', labelsFor('MyApp', 'web'))).to.not.be.null;
      expect(await service.buildIdentity('/fluxotelagent_MyApp', 'otel:1', 'NA', labelsFor('MyApp', 'otelagent'))).to.not.be.null;
    });

    it('a component outside the explicit list is never announced', async () => {
      sinkCacheStub.seed('MyApp', {
        provider: 'otlp', component: 'otelagent', port: 4318, components: ['web'],
      });
      await service.refreshAgentEndpoint({ fluxDockerNetwork_MyApp: { IPAddress: '172.23.11.3' } }, labelsFor('MyApp', 'otelagent'));
      expect(await service.buildIdentity('/fluxweb_MyApp', 'nginx:1', 'NA', labelsFor('MyApp', 'web'))).to.not.be.null;
      expect(await service.buildIdentity('/fluxworker_MyApp', 'img:1', 'NA', labelsFor('MyApp', 'worker'))).to.be.null;
    });

    it('routes to a shareWith-linked collector and rotates every consumer when it moves', async () => {
      sinkCacheStub.seed('shipper', { provider: 'otlp', app: 'logstack', component: 'collector', port: 4318 });
      expect(await service.refreshAgentEndpoint(collectorNet, labelsFor('logstack', 'collector'))).to.equal(true);
      expect((await service.buildIdentity('/fluxweb_shipper', 'img:1', 'NA', labelsFor('shipper', 'web'))).sink)
        .to.deep.equal({ provider: 'otlp', endpoint: 'http://172.23.40.2:4318' });

      const moved = { fluxDockerNetwork_logstack: { IPAddress: '172.23.40.9' } };
      expect(await service.refreshAgentEndpoint(moved, labelsFor('logstack', 'collector'))).to.equal(true);
      expect((await service.buildIdentity('/fluxweb_shipper', 'img:1', 'NA', labelsFor('shipper', 'web'))).sink.endpoint)
        .to.equal('http://172.23.40.9:4318');
    });

    it('one shared collector serves each consumer at its own declared port', async () => {
      sinkCacheStub.seed('shipper', { provider: 'otlp', app: 'logstack', component: 'collector', port: 4318 });
      sinkCacheStub.seed('other', { provider: 'otlp', app: 'logstack', component: 'collector', port: 4317 });
      expect(await service.refreshAgentEndpoint(collectorNet, labelsFor('logstack', 'collector'))).to.equal(true);
      expect((await service.buildIdentity('/fluxweb_shipper', 'img:1', 'NA', labelsFor('shipper', 'web'))).sink.endpoint)
        .to.equal('http://172.23.40.2:4318');
      expect((await service.buildIdentity('/fluxweb_other', 'img:1', 'NA', labelsFor('other', 'web'))).sink.endpoint)
        .to.equal('http://172.23.40.2:4317');
    });

    it('inter-app consumers default to shipping every component — the collector lives elsewhere', async () => {
      sinkCacheStub.seed('shipper', { provider: 'otlp', app: 'logstack', component: 'collector', port: 4318 });
      await service.refreshAgentEndpoint(collectorNet, labelsFor('logstack', 'collector'));
      // Even a local component that happens to share the collector's name
      // ships: the sink's collector is the linked app's component.
      expect(await service.buildIdentity('/fluxcollector_shipper', 'img:1', 'NA', labelsFor('shipper', 'collector'))).to.not.be.null;
    });

    it('the collector app itself ships nothing unless it declares its own telemetry', async () => {
      sinkCacheStub.seed('shipper', { provider: 'otlp', app: 'logstack', component: 'collector', port: 4318 });
      await service.refreshAgentEndpoint(collectorNet, labelsFor('logstack', 'collector'));
      expect(await service.buildIdentity('/fluxcollector_logstack', 'img:1', 'NA', labelsFor('logstack', 'collector'))).to.be.null;
    });

    it('sendSync warns loudly for a consumer whose collector never resolved', async () => {
      sinkCacheStub.seed('shipper', { provider: 'otlp', app: 'logstack', component: 'nosuch', port: 4318 });
      dockerServiceStub.dockerListContainers.resolves([
        { Id: 'c'.repeat(64), Names: ['/fluxweb_shipper'], Image: 'img:1', Labels: labelsFor('shipper', 'web'), NetworkSettings: { Networks: {} } },
      ]);
      const socket = { destroyed: false, write: sinon.stub() };
      await service.sendSync(socket);
      const payload = JSON.parse(socket.write.firstCall.args[0]);
      expect(payload.containers).to.deep.equal([]);
      expect(logStub.warn.calledWithMatch(/unresolved/), 'the resync must say why nothing is announced').to.equal(true);
    });
  });

  describe('sendSync', () => {
    function fakeSocket() {
      return { destroyed: false, written: [], write(s) { this.written.push(s); } };
    }

    it('announces only telemetry-app containers, each with its sink', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Id: 'c1'.padEnd(64, '0'), Names: ['/fluxweb_TelemApp'], Image: 'img:1', Labels: labelsFor('TelemApp', 'web') },
        { Id: 'c2'.padEnd(64, '0'), Names: ['/fluxweb_PlainApp'], Image: 'img:2', Labels: labelsFor('PlainApp', 'web') },
        { Id: 'c3'.padEnd(64, '0'), Names: ['/watchtower'], Image: 'img:3', Labels: {} },
      ]);
      // Only TelemApp has a sink; watchtower is not a container FluxOS manages.
      sinkCacheStub.seed('TelemApp', datadogSink);

      const socket = fakeSocket();
      await service.sendSync(socket);

      expect(socket.written).to.have.length(1);
      const msg = JSON.parse(socket.written[0]);
      expect(msg.op).to.equal('sync');
      expect(msg.opaqueId, 'the node tag rides every sync').to.match(/^[0-9a-f]{64}$/);
      expect(msg.containers).to.have.length(1);
      expect(msg.containers[0].container_id).to.equal('c1'.padEnd(64, '0'));
      expect(msg.containers[0].identity.app_name).to.equal('TelemApp');
      expect(msg.containers[0].identity.sink).to.deep.equal(datadogSink);
    });

    it('grants log access to every container it puts in the sync', async () => {
      // The sync is an announce like any other. It used to enumerate and send
      // without granting, so a container first seen here — daemon reconnect,
      // boot reconcile, or a sink rotation resync — reached the daemon with an
      // unreadable log. The daemon attached, got EACCES, and that container's
      // logs never shipped again, silently.
      const id = 'c1'.padEnd(64, '0');
      dockerServiceStub.dockerListContainers.resolves([
        { Id: id, Names: ['/fluxweb_TelemApp'], Image: 'img:1', Labels: labelsFor('TelemApp', 'web') },
      ]);
      sinkCacheStub.seed('TelemApp', datadogSink);

      await service.sendSync(fakeSocket());

      const grantedFor = runCommandStub.getCalls()
        .filter((c) => c.args[0] === 'setfacl')
        .some((c) => JSON.stringify(c.args[1].params).includes(id));
      expect(grantedFor, 'the sync must grant log access before announcing').to.equal(true);
    });

    it('omits a container whose log-access grant failed', async () => {
      // Announcing a container the daemon cannot read is worse than omitting
      // it: the daemon attaches, fails, and stays silent for that container's
      // whole life. Better to ship nothing and say so.
      dockerServiceStub.dockerListContainers.resolves([
        { Id: 'c1'.padEnd(64, '0'), Names: ['/fluxweb_TelemApp'], Image: 'img:1', Labels: labelsFor('TelemApp', 'web') },
      ]);
      sinkCacheStub.seed('TelemApp', datadogSink);
      runCommandStub.resolves({ error: new Error('setfacl: Operation not permitted') });

      const socket = fakeSocket();
      await service.sendSync(socket);

      const msg = JSON.parse(socket.written[0]);
      expect(msg.containers, 'an ungrantable container must not be announced').to.have.length(0);
      expect(logStub.error.calledWithMatch(/could not grant/), 'and it must be loud').to.equal(true);
    });

    it('emits an empty sync when no telemetry apps are running', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Id: 'c2'.padEnd(64, '0'), Names: ['/fluxweb_PlainApp'], Image: 'img:2', Labels: labelsFor('PlainApp', 'web') },
      ]);
      const socket = fakeSocket();
      await service.sendSync(socket);

      const msg = JSON.parse(socket.written[0]);
      expect(msg.op).to.equal('sync');
      expect(msg.containers).to.deep.equal([]);
    });
  });

  describe('deriveOpaqueId', () => {
    it('is a 64-hex hash of the collateral, stable for the node', async () => {
      const first = await service.deriveOpaqueId();
      expect(first).to.match(/^[0-9a-f]{64}$/);
      expect(await service.deriveOpaqueId()).to.equal(first);
      collateralStub.resolves({ txhash: 'cd'.repeat(32) });
      expect(await service.deriveOpaqueId()).to.not.equal(first);
    });

    it('fails without a collateral', async () => {
      collateralStub.resolves(null);
      let error;
      try { await service.deriveOpaqueId(); } catch (e) { error = e; }
      expect(error).to.be.an('error');
    });
  });

  describe('the connection to flux-telemetryd', () => {
    let dir;
    let socketPath;
    let server;
    let streams;

    // A stand-in daemon: listens where systemd puts the socket and records
    // every line fluxos sends, per connection.
    function listen() {
      streams = [];
      server = nodeNet.createServer((conn) => {
        const stream = { conn, lines: [] };
        streams.push(stream);
        let buffer = '';
        conn.on('data', (chunk) => {
          buffer += chunk.toString();
          let i = buffer.indexOf('\n');
          while (i !== -1) {
            stream.lines.push(JSON.parse(buffer.slice(0, i)));
            buffer = buffer.slice(i + 1);
            i = buffer.indexOf('\n');
          }
        });
      });
      return new Promise((resolve) => { server.listen(socketPath, resolve); });
    }

    async function until(check, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs;
      while (!check()) {
        if (Date.now() > deadline) throw new Error('timed out');
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => { setTimeout(r, 20); });
      }
    }

    beforeEach(() => {
      dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'telemetry-identity-'));
      socketPath = nodePath.join(dir, 'identity.sock');
    });

    afterEach(async () => {
      await service.stop();
      if (server) await new Promise((r) => { server.close(r); });
      server = null;
      nodeFs.rmSync(dir, { recursive: true, force: true });
    });

    it('does nothing, and says nothing, where the daemon does not run', async () => {
      await service.start({ socketPath });
      await service.onComponentCreated({ identifier: 'fluxMyApp' });
      expect(dockerServiceStub.dockerContainerInspect.called).to.equal(false);
      expect(eventStreamStub.start.called).to.equal(false);
      expect(logStub.info.called || logStub.warn.called || logStub.error.called).to.equal(false);
    });

    it('sends a sync carrying the node tag on connect, then pushes track', async () => {
      await listen();
      await service.start({ socketPath });
      await until(() => streams.length === 1 && streams[0].lines.length === 1);
      expect(streams[0].lines[0].op).to.equal('sync');
      expect(streams[0].lines[0].opaqueId).to.match(/^[0-9a-f]{64}$/);

      service.broadcastTrack('c'.repeat(64), { app_name: 'App' });
      await until(() => streams[0].lines.length === 2);
      expect(streams[0].lines[1]).to.deep.equal({ op: 'track', container_id: 'c'.repeat(64), identity: { app_name: 'App' } });
    });

    it('reconnects when the daemon drops the stream, and syncs again', async function reconnects() {
      this.timeout(6000);
      await listen();
      await service.start({ socketPath });
      await until(() => streams.length === 1 && streams[0].lines.length === 1);

      streams[0].conn.destroy();
      await until(() => streams.length === 2 && streams[1].lines.length === 1);
      expect(streams[1].lines[0].op).to.equal('sync');
    });

    it('closes the stream on stop and does not reconnect', async function stops() {
      this.timeout(4000);
      await listen();
      await service.start({ socketPath });
      await until(() => streams.length === 1 && streams[0].lines.length === 1);
      const ended = new Promise((r) => { streams[0].conn.on('close', r); });

      await service.stop();
      await ended;
      await new Promise((r) => { setTimeout(r, 1500); });
      expect(streams).to.have.length(1);
    });
  });

  describe('TAG_ALLOWLIST', () => {
    it('contains exactly the expected public tags', () => {
      expect(service.TAG_ALLOWLIST.size).to.equal(7);
      ['region', 'component', 'identifier', 'identity', 'replica', 'image_name', 'container_name'].forEach((t) => {
        expect(service.TAG_ALLOWLIST.has(t)).to.be.true;
      });
    });
  });
});
