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

  describe('parseContainerName', () => {
    it('parses a flux-prefixed name', () => {
      expect(service.parseContainerName('fluxMyApp')).to.deep.equal({ appName: 'MyApp', componentName: null, replica: null });
    });

    it('parses a component name: app at segment [1], replica at [2]', () => {
      // No component, app, or replica name may contain '_' (schema-enforced),
      // so the segments are unambiguous.
      expect(service.parseContainerName('fluxdb_MyApp')).to.deep.equal({ appName: 'MyApp', componentName: 'db', replica: null });
      expect(service.parseContainerName('fluxdb_MyApp_s1')).to.deep.equal({ appName: 'MyApp', componentName: 'db', replica: 's1' });
    });

    it('returns null for empty or non-flux names', () => {
      expect(service.parseContainerName('')).to.be.null;
      expect(service.parseContainerName('nginx')).to.be.null;
    });
  });

  describe('buildIdentity (telemetry scoping gate)', () => {
    it('returns null for a non-flux container name', async () => {
      sinkCacheStub.seed('nginx', datadogSink);
      expect(await service.buildIdentity('/nginx', 'nginx:1', 'NA')).to.be.null;
    });

    it('returns null when the app has no cached sink (not a telemetry app)', async () => {
      expect(await service.buildIdentity('/fluxMyApp', 'nginx:1', 'NA')).to.be.null;
    });

    it('builds identity with sink and tags for a telemetry app', async () => {
      sinkCacheStub.seed('MyApp', datadogSink);
      const id = await service.buildIdentity('/frontend_MyApp', 'nginx:1.25', 'NA');
      expect(id.app_name).to.equal('MyApp');
      expect(id.sink).to.deep.equal(datadogSink);
      expect(id.tags).to.deep.equal({
        component: 'frontend',
        image_name: 'nginx:1.25',
        container_name: 'frontend_MyApp',
        region: 'NA',
      });
      expect(sinkCacheStub.getSink.calledWith('MyApp')).to.equal(true);
    });

    it('omits region when none is available', async () => {
      sinkCacheStub.seed('MyApp', datadogSink);
      const id = await service.buildIdentity('/fluxMyApp', 'nginx:1', null);
      expect(id.tags).to.not.have.property('region');
    });
  });

  describe('otlp endpoint resolution (refreshAgentEndpoint + wire sink)', () => {
    const otlpSink = { provider: 'otlp', component: 'otelagent', port: 4318 };
    const agentNetworks = { fluxDockerNetwork_MyApp: { IPAddress: '172.23.11.3' } };

    it('an otlp container stays unannounced until the agent endpoint resolves', async () => {
      sinkCacheStub.seed('MyApp', otlpSink);
      expect(await service.buildIdentity('/fluxweb_MyApp', 'nginx:1', 'NA')).to.be.null;
    });

    it('resolves the endpoint from the agent container and projects the wire sink', async () => {
      sinkCacheStub.seed('MyApp', otlpSink);
      expect(await service.refreshAgentEndpoint('/fluxotelagent_MyApp', agentNetworks)).to.equal(true);
      const id = await service.buildIdentity('/fluxweb_MyApp', 'nginx:1', 'NA');
      // The wire carries only provider + endpoint — never the declared
      // component/port shape the cache holds.
      expect(id.sink).to.deep.equal({ provider: 'otlp', endpoint: 'http://172.23.11.3:4318' });
    });

    it('ignores containers that are not the declared agent component', async () => {
      sinkCacheStub.seed('MyApp', otlpSink);
      expect(await service.refreshAgentEndpoint('/fluxweb_MyApp', agentNetworks)).to.equal(false);
    });

    it('ignores containers of non-otlp apps', async () => {
      sinkCacheStub.seed('MyApp', datadogSink);
      expect(await service.refreshAgentEndpoint('/fluxotelagent_MyApp', agentNetworks)).to.equal(false);
    });

    it('reports unchanged endpoints as false and a moved agent as true', async () => {
      sinkCacheStub.seed('MyApp', otlpSink);
      expect(await service.refreshAgentEndpoint('/fluxotelagent_MyApp', agentNetworks)).to.equal(true);
      expect(await service.refreshAgentEndpoint('/fluxotelagent_MyApp', agentNetworks)).to.equal(false);
      const moved = { fluxDockerNetwork_MyApp: { IPAddress: '172.23.11.9' } };
      expect(await service.refreshAgentEndpoint('/fluxotelagent_MyApp', moved)).to.equal(true);
      const id = await service.buildIdentity('/fluxweb_MyApp', 'nginx:1', 'NA');
      expect(id.sink.endpoint).to.equal('http://172.23.11.9:4318');
    });

    it('prefers the app network address, falling back to any attached network', async () => {
      sinkCacheStub.seed('MyApp', otlpSink);
      const foreignOnly = { fluxDockerNetwork_OtherApp: { IPAddress: '172.23.77.2' } };
      expect(await service.refreshAgentEndpoint('/fluxotelagent_MyApp', foreignOnly)).to.equal(true);
      expect((await service.buildIdentity('/fluxweb_MyApp', 'nginx:1', 'NA')).sink.endpoint)
        .to.equal('http://172.23.77.2:4318');
    });

    it('resolves an app whose identity is not its name, off the labels', async () => {
      // Every fixture above is an app whose identity EQUALS its name, which is the one
      // shape that cannot catch a name-vs-identity confusion. A minted identity puts a
      // string in the container name that the sink cache has never heard of: keyed from
      // there, the collector resolves to nothing and the consumer is never announced.
      const labels = { 'io.runonflux.app': 'MyApp' };
      const net = { fluxDockerNetwork_a1b2c3d4e5f6: { IPAddress: '172.23.11.3' } };
      sinkCacheStub.seed('MyApp', otlpSink);

      expect(await service.refreshAgentEndpoint('/fluxotelagent_a1b2c3d4e5f6', net, labels))
        .to.equal(true);

      const id = await service.buildIdentity('/fluxweb_a1b2c3d4e5f6', 'nginx:1', 'NA', labels);
      expect(id, 'the consumer resolves an identity at all').to.not.be.null;
      expect(id.sink).to.deep.equal({ provider: 'otlp', endpoint: 'http://172.23.11.3:4318' });
      // The wire carries the NAME an operator declared the sink under, not the identity.
      expect(id.app_name).to.equal('MyApp');
    });

    it('sendSync resolves agent endpoints from the live container list', async () => {
      sinkCacheStub.seed('MyApp', otlpSink);
      dockerServiceStub.dockerListContainers.resolves([
        {
          Id: 'a'.repeat(64),
          Names: ['/fluxotelagent_MyApp'],
          Image: 'otel/opentelemetry-collector-contrib:latest',
          NetworkSettings: { Networks: agentNetworks },
        },
        {
          Id: 'b'.repeat(64),
          Names: ['/fluxweb_MyApp'],
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
      await service.refreshAgentEndpoint('/fluxotelagent_MyApp', { fluxDockerNetwork_MyApp: { IPAddress: '172.23.11.3' } });
      expect(await service.buildIdentity('/fluxweb_MyApp', 'nginx:1', 'NA')).to.not.be.null;
      expect(await service.buildIdentity('/fluxotelagent_MyApp', 'otel:1', 'NA'), 'a collector ingesting its own stream amplifies').to.be.null;
    });

    it('an explicit components list overrides the default and may include the collector', async () => {
      sinkCacheStub.seed('MyApp', {
        provider: 'otlp', component: 'otelagent', port: 4318, components: ['web', 'otelagent'],
      });
      await service.refreshAgentEndpoint('/fluxotelagent_MyApp', { fluxDockerNetwork_MyApp: { IPAddress: '172.23.11.3' } });
      expect(await service.buildIdentity('/fluxweb_MyApp', 'nginx:1', 'NA')).to.not.be.null;
      expect(await service.buildIdentity('/fluxotelagent_MyApp', 'otel:1', 'NA')).to.not.be.null;
    });

    it('a component outside the explicit list is never announced', async () => {
      sinkCacheStub.seed('MyApp', {
        provider: 'otlp', component: 'otelagent', port: 4318, components: ['web'],
      });
      await service.refreshAgentEndpoint('/fluxotelagent_MyApp', { fluxDockerNetwork_MyApp: { IPAddress: '172.23.11.3' } });
      expect(await service.buildIdentity('/fluxweb_MyApp', 'nginx:1', 'NA')).to.not.be.null;
      expect(await service.buildIdentity('/fluxworker_MyApp', 'img:1', 'NA')).to.be.null;
    });

    it('routes to a shareWith-linked collector and rotates every consumer when it moves', async () => {
      sinkCacheStub.seed('shipper', { provider: 'otlp', app: 'logstack', component: 'collector', port: 4318 });
      expect(await service.refreshAgentEndpoint('/fluxcollector_logstack', collectorNet)).to.equal(true);
      expect((await service.buildIdentity('/fluxweb_shipper', 'img:1', 'NA')).sink)
        .to.deep.equal({ provider: 'otlp', endpoint: 'http://172.23.40.2:4318' });

      const moved = { fluxDockerNetwork_logstack: { IPAddress: '172.23.40.9' } };
      expect(await service.refreshAgentEndpoint('/fluxcollector_logstack', moved)).to.equal(true);
      expect((await service.buildIdentity('/fluxweb_shipper', 'img:1', 'NA')).sink.endpoint)
        .to.equal('http://172.23.40.9:4318');
    });

    it('one shared collector serves each consumer at its own declared port', async () => {
      sinkCacheStub.seed('shipper', { provider: 'otlp', app: 'logstack', component: 'collector', port: 4318 });
      sinkCacheStub.seed('other', { provider: 'otlp', app: 'logstack', component: 'collector', port: 4317 });
      expect(await service.refreshAgentEndpoint('/fluxcollector_logstack', collectorNet)).to.equal(true);
      expect((await service.buildIdentity('/fluxweb_shipper', 'img:1', 'NA')).sink.endpoint)
        .to.equal('http://172.23.40.2:4318');
      expect((await service.buildIdentity('/fluxweb_other', 'img:1', 'NA')).sink.endpoint)
        .to.equal('http://172.23.40.2:4317');
    });

    it('inter-app consumers default to shipping every component — the collector lives elsewhere', async () => {
      sinkCacheStub.seed('shipper', { provider: 'otlp', app: 'logstack', component: 'collector', port: 4318 });
      await service.refreshAgentEndpoint('/fluxcollector_logstack', collectorNet);
      // Even a local component that happens to share the collector's name
      // ships: the sink's collector is the linked app's component.
      expect(await service.buildIdentity('/fluxcollector_shipper', 'img:1', 'NA')).to.not.be.null;
    });

    it('the collector app itself ships nothing unless it declares its own telemetry', async () => {
      sinkCacheStub.seed('shipper', { provider: 'otlp', app: 'logstack', component: 'collector', port: 4318 });
      await service.refreshAgentEndpoint('/fluxcollector_logstack', collectorNet);
      expect(await service.buildIdentity('/fluxcollector_logstack', 'img:1', 'NA')).to.be.null;
    });

    it('sendSync warns loudly for a consumer whose collector never resolved', async () => {
      sinkCacheStub.seed('shipper', { provider: 'otlp', app: 'logstack', component: 'nosuch', port: 4318 });
      dockerServiceStub.dockerListContainers.resolves([
        { Id: 'c'.repeat(64), Names: ['/fluxweb_shipper'], Image: 'img:1', NetworkSettings: { Networks: {} } },
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
        { Id: 'c1'.padEnd(64, '0'), Names: ['/fluxTelemApp'], Image: 'img:1' },
        { Id: 'c2'.padEnd(64, '0'), Names: ['/fluxPlainApp'], Image: 'img:2' },
      ]);
      // Only TelemApp has a sink.
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
        { Id: id, Names: ['/fluxTelemApp'], Image: 'img:1' },
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
        { Id: 'c1'.padEnd(64, '0'), Names: ['/fluxTelemApp'], Image: 'img:1' },
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
        { Id: 'c2'.padEnd(64, '0'), Names: ['/fluxPlainApp'], Image: 'img:2' },
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
      expect(service.TAG_ALLOWLIST.size).to.equal(4);
      ['region', 'component', 'image_name', 'container_name'].forEach((t) => {
        expect(service.TAG_ALLOWLIST.has(t)).to.be.true;
      });
    });
  });
});
