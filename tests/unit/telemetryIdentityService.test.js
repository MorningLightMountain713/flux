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

    sinkCacheStub = {
      getSink: sinon.stub().returns(null),
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
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('parseContainerName', () => {
    it('parses a flux-prefixed name', () => {
      expect(service.parseContainerName('fluxMyApp')).to.deep.equal({ appName: 'MyApp', componentName: null });
    });

    it('parses a legacy zel-prefixed name', () => {
      expect(service.parseContainerName('zelKadena')).to.deep.equal({ appName: 'Kadena', componentName: null });
    });

    it('parses a component name (first underscore is the separator)', () => {
      expect(service.parseContainerName('db_My_Complex_App')).to.deep.equal({ appName: 'My_Complex_App', componentName: 'db' });
    });

    it('returns null for empty or non-flux names', () => {
      expect(service.parseContainerName('')).to.be.null;
      expect(service.parseContainerName('nginx')).to.be.null;
    });
  });

  describe('buildIdentity (telemetry scoping gate)', () => {
    it('returns null for a non-flux container name', () => {
      sinkCacheStub.getSink.returns(datadogSink);
      expect(service.buildIdentity('/nginx', 'nginx:1', 'NA')).to.be.null;
    });

    it('returns null when the app has no cached sink (not a telemetry app)', () => {
      sinkCacheStub.getSink.returns(null);
      expect(service.buildIdentity('/fluxMyApp', 'nginx:1', 'NA')).to.be.null;
    });

    it('builds identity with sink and tags for a telemetry app', () => {
      sinkCacheStub.getSink.returns(datadogSink);
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
      sinkCacheStub.getSink.returns(datadogSink);
      const id = service.buildIdentity('/fluxMyApp', 'nginx:1', null);
      expect(id.tags).to.not.have.property('region');
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
      sinkCacheStub.getSink.returns(null);
      expect(await service.resolveIdentity(containerId)).to.be.null;
    });

    it('resolves a telemetry app with sink, tags and region', async () => {
      dockerServiceStub.dockerContainerInspect.resolves({ Id: containerId, Name: '/fluxMyApp', Config: { Image: 'nginx:1.25' } });
      sinkCacheStub.getSink.returns(datadogSink);
      const id = await service.resolveIdentity(containerId);
      expect(id.app_name).to.equal('MyApp');
      expect(id.sink).to.deep.equal(datadogSink);
      expect(id.tags.image_name).to.equal('nginx:1.25');
      expect(id.tags.region).to.equal('NA');
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
      sinkCacheStub.getSink.withArgs('TelemApp').returns(datadogSink);
      sinkCacheStub.getSink.withArgs('PlainApp').returns(null);

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
      sinkCacheStub.getSink.returns(null);

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
