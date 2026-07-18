const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('telemetryIdentityService tests', () => {
  let service;
  let dockerServiceStub;
  let geolocationServiceStub;
  let sinkCacheStub;
  let logStub;

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
      hasAnyTelemetryApps: sinon.stub().returns(false),
      onChange: sinon.stub(),
    };

    logStub = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };

    service = proxyquire('../../ZelBack/src/services/telemetryIdentityService', {
      'node:net': require('node:net'),
      'node:fs': require('node:fs'),
      'node:path': require('node:path'),
      '../lib/log': logStub,
      './dockerService': dockerServiceStub,
      './serviceHelper': { runCommand: sinon.stub().resolves({ error: null, stdout: '', stderr: '' }) },
      './geolocationService': geolocationServiceStub,
      './telemetrySinkCache': sinkCacheStub,
      './telemetryConfigService': { chownGroup: sinon.stub().resolves(), ensureNode: sinon.stub().resolves() },
    });
  });

  afterEach(() => {
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
    it('returns null for a non-flux container name', () => {
      sinkCacheStub.seed('nginx', datadogSink);
      expect(service.buildIdentity('/nginx', 'nginx:1', 'NA')).to.be.null;
    });

    it('returns null when the app has no cached sink (not a telemetry app)', () => {
      expect(service.buildIdentity('/fluxMyApp', 'nginx:1', 'NA')).to.be.null;
    });

    it('builds identity with sink and tags for a telemetry app', () => {
      sinkCacheStub.seed('MyApp', datadogSink);
      const id = service.buildIdentity('/frontend_MyApp', 'nginx:1.25', 'NA');
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

    it('omits region when none is available', () => {
      sinkCacheStub.seed('MyApp', datadogSink);
      const id = service.buildIdentity('/fluxMyApp', 'nginx:1', null);
      expect(id.tags).to.not.have.property('region');
    });
  });

  describe('otlp endpoint resolution (refreshAgentEndpoint + wire sink)', () => {
    const otlpSink = { provider: 'otlp', component: 'otelagent', port: 4318 };
    const agentNetworks = { fluxDockerNetwork_MyApp: { IPAddress: '172.23.11.3' } };

    it('an otlp container stays unannounced until the agent endpoint resolves', () => {
      sinkCacheStub.seed('MyApp', otlpSink);
      expect(service.buildIdentity('/fluxweb_MyApp', 'nginx:1', 'NA')).to.be.null;
    });

    it('resolves the endpoint from the agent container and projects the wire sink', () => {
      sinkCacheStub.seed('MyApp', otlpSink);
      expect(service.refreshAgentEndpoint('/fluxotelagent_MyApp', agentNetworks)).to.equal(true);
      const id = service.buildIdentity('/fluxweb_MyApp', 'nginx:1', 'NA');
      // The wire carries only provider + endpoint — never the declared
      // component/port shape the cache holds.
      expect(id.sink).to.deep.equal({ provider: 'otlp', endpoint: 'http://172.23.11.3:4318' });
    });

    it('ignores containers that are not the declared agent component', () => {
      sinkCacheStub.seed('MyApp', otlpSink);
      expect(service.refreshAgentEndpoint('/fluxweb_MyApp', agentNetworks)).to.equal(false);
    });

    it('ignores containers of non-otlp apps', () => {
      sinkCacheStub.seed('MyApp', datadogSink);
      expect(service.refreshAgentEndpoint('/fluxotelagent_MyApp', agentNetworks)).to.equal(false);
    });

    it('reports unchanged endpoints as false and a moved agent as true', () => {
      sinkCacheStub.seed('MyApp', otlpSink);
      expect(service.refreshAgentEndpoint('/fluxotelagent_MyApp', agentNetworks)).to.equal(true);
      expect(service.refreshAgentEndpoint('/fluxotelagent_MyApp', agentNetworks)).to.equal(false);
      const moved = { fluxDockerNetwork_MyApp: { IPAddress: '172.23.11.9' } };
      expect(service.refreshAgentEndpoint('/fluxotelagent_MyApp', moved)).to.equal(true);
      const id = service.buildIdentity('/fluxweb_MyApp', 'nginx:1', 'NA');
      expect(id.sink.endpoint).to.equal('http://172.23.11.9:4318');
    });

    it('prefers the app network address, falling back to any attached network', () => {
      sinkCacheStub.seed('MyApp', otlpSink);
      const foreignOnly = { fluxDockerNetwork_OtherApp: { IPAddress: '172.23.77.2' } };
      expect(service.refreshAgentEndpoint('/fluxotelagent_MyApp', foreignOnly)).to.equal(true);
      expect(service.buildIdentity('/fluxweb_MyApp', 'nginx:1', 'NA').sink.endpoint)
        .to.equal('http://172.23.77.2:4318');
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

    it('default send set excludes the same-app collector (feedback-loop gate)', () => {
      sinkCacheStub.seed('MyApp', { provider: 'otlp', component: 'otelagent', port: 4318 });
      service.refreshAgentEndpoint('/fluxotelagent_MyApp', { fluxDockerNetwork_MyApp: { IPAddress: '172.23.11.3' } });
      expect(service.buildIdentity('/fluxweb_MyApp', 'nginx:1', 'NA')).to.not.be.null;
      expect(service.buildIdentity('/fluxotelagent_MyApp', 'otel:1', 'NA'), 'a collector ingesting its own stream amplifies').to.be.null;
    });

    it('an explicit components list overrides the default and may include the collector', () => {
      sinkCacheStub.seed('MyApp', {
        provider: 'otlp', component: 'otelagent', port: 4318, components: ['web', 'otelagent'],
      });
      service.refreshAgentEndpoint('/fluxotelagent_MyApp', { fluxDockerNetwork_MyApp: { IPAddress: '172.23.11.3' } });
      expect(service.buildIdentity('/fluxweb_MyApp', 'nginx:1', 'NA')).to.not.be.null;
      expect(service.buildIdentity('/fluxotelagent_MyApp', 'otel:1', 'NA')).to.not.be.null;
    });

    it('a component outside the explicit list is never announced', () => {
      sinkCacheStub.seed('MyApp', {
        provider: 'otlp', component: 'otelagent', port: 4318, components: ['web'],
      });
      service.refreshAgentEndpoint('/fluxotelagent_MyApp', { fluxDockerNetwork_MyApp: { IPAddress: '172.23.11.3' } });
      expect(service.buildIdentity('/fluxweb_MyApp', 'nginx:1', 'NA')).to.not.be.null;
      expect(service.buildIdentity('/fluxworker_MyApp', 'img:1', 'NA')).to.be.null;
    });

    it('routes to a shareWith-linked collector and rotates every consumer when it moves', () => {
      sinkCacheStub.seed('shipper', { provider: 'otlp', app: 'logstack', component: 'collector', port: 4318 });
      expect(service.refreshAgentEndpoint('/fluxcollector_logstack', collectorNet)).to.equal(true);
      expect(service.buildIdentity('/fluxweb_shipper', 'img:1', 'NA').sink)
        .to.deep.equal({ provider: 'otlp', endpoint: 'http://172.23.40.2:4318' });

      const moved = { fluxDockerNetwork_logstack: { IPAddress: '172.23.40.9' } };
      expect(service.refreshAgentEndpoint('/fluxcollector_logstack', moved)).to.equal(true);
      expect(service.buildIdentity('/fluxweb_shipper', 'img:1', 'NA').sink.endpoint)
        .to.equal('http://172.23.40.9:4318');
    });

    it('one shared collector serves each consumer at its own declared port', () => {
      sinkCacheStub.seed('shipper', { provider: 'otlp', app: 'logstack', component: 'collector', port: 4318 });
      sinkCacheStub.seed('other', { provider: 'otlp', app: 'logstack', component: 'collector', port: 4317 });
      expect(service.refreshAgentEndpoint('/fluxcollector_logstack', collectorNet)).to.equal(true);
      expect(service.buildIdentity('/fluxweb_shipper', 'img:1', 'NA').sink.endpoint)
        .to.equal('http://172.23.40.2:4318');
      expect(service.buildIdentity('/fluxweb_other', 'img:1', 'NA').sink.endpoint)
        .to.equal('http://172.23.40.2:4317');
    });

    it('inter-app consumers default to shipping every component — the collector lives elsewhere', () => {
      sinkCacheStub.seed('shipper', { provider: 'otlp', app: 'logstack', component: 'collector', port: 4318 });
      service.refreshAgentEndpoint('/fluxcollector_logstack', collectorNet);
      // Even a local component that happens to share the collector's name
      // ships: the sink's collector is the linked app's component.
      expect(service.buildIdentity('/fluxcollector_shipper', 'img:1', 'NA')).to.not.be.null;
    });

    it('the collector app itself ships nothing unless it declares its own telemetry', () => {
      sinkCacheStub.seed('shipper', { provider: 'otlp', app: 'logstack', component: 'collector', port: 4318 });
      service.refreshAgentEndpoint('/fluxcollector_logstack', collectorNet);
      expect(service.buildIdentity('/fluxcollector_logstack', 'img:1', 'NA')).to.be.null;
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

  describe('resolveIdentity', () => {
    const containerId = 'a'.repeat(64);

    it('returns null when the container cannot be inspected', async () => {
      dockerServiceStub.dockerContainerInspect.resolves(null);
      expect(await service.resolveIdentity(containerId)).to.be.null;
    });

    it('returns null for a non-telemetry app', async () => {
      dockerServiceStub.dockerContainerInspect.resolves({ Id: containerId, Name: '/fluxMyApp', Config: { Image: 'nginx:1' } });
      expect(await service.resolveIdentity(containerId)).to.be.null;
    });

    it('resolves a telemetry app with sink, tags and region', async () => {
      dockerServiceStub.dockerContainerInspect.resolves({ Id: containerId, Name: '/fluxMyApp', Config: { Image: 'nginx:1.25' } });
      sinkCacheStub.seed('MyApp', datadogSink);
      const id = await service.resolveIdentity(containerId);
      expect(id.app_name).to.equal('MyApp');
      expect(id.sink).to.deep.equal(datadogSink);
      expect(id.tags.image_name).to.equal('nginx:1.25');
      expect(id.tags.region).to.equal('NA');
    });

    it('inspects by container id, not name (docker events carry raw ids)', async () => {
      dockerServiceStub.dockerContainerInspect.resolves(null);
      await service.resolveIdentity(containerId);
      expect(dockerServiceStub.dockerContainerInspect.firstCall.args[1]).to.deep.equal({ identifierType: 'id' });
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
      expect(msg.containers).to.have.length(1);
      expect(msg.containers[0].container_id).to.equal('c1'.padEnd(64, '0'));
      expect(msg.containers[0].identity.app_name).to.equal('TelemApp');
      expect(msg.containers[0].identity.sink).to.deep.equal(datadogSink);
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

  describe('onComponentCreated Arcane gate', () => {
    it('is a no-op when the server is not running (non-Arcane node)', async () => {
      // start() was never called, so server is null.
      await service.onComponentCreated({ identifier: 'fluxMyApp' });
      expect(dockerServiceStub.dockerContainerInspect.called).to.equal(false);
    });
  });

  describe('handleRequest (forward-compat lookup)', () => {
    it('rejects invalid JSON', async () => {
      const res = JSON.parse(await service.handleRequest('not json'));
      expect(res.ok).to.be.false;
      expect(res.error).to.equal('invalid JSON');
    });

    it('rejects an unknown op', async () => {
      const res = JSON.parse(await service.handleRequest('{"op":"delete"}'));
      expect(res.ok).to.be.false;
    });

    it('rejects a non-64-hex container_id', async () => {
      const res = JSON.parse(await service.handleRequest('{"op":"lookup","container_id":"short"}'));
      expect(res.ok).to.be.false;
      expect(res.error).to.equal('invalid container_id');
    });

    it('returns null identity for an unknown container', async () => {
      dockerServiceStub.dockerContainerInspect.resolves(null);
      const res = JSON.parse(await service.handleRequest(`{"op":"lookup","container_id":"${'a'.repeat(64)}"}`));
      expect(res.ok).to.be.true;
      expect(res.identity).to.be.null;
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
