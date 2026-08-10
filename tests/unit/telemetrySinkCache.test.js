'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('telemetrySinkCache tests', () => {
  let cache;
  let deploymentProviderStub;
  let logStub;

  function load() {
    return proxyquire('../../ZelBack/src/services/telemetrySinkCache', {
      './appRuntime/deploymentProvider': deploymentProviderStub,
      '../lib/log': logStub,
    });
  }

  beforeEach(() => {
    deploymentProviderStub = {
      listInstalledDeployments: sinon.stub().resolves([]),
    };
    logStub = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };
    // Fresh module instance each test resets the in-memory map.
    cache = load();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('extractSink', () => {
    it('returns the sink from a deployment with full telemetry', () => {
      const sink = cache.extractSink({ telemetry: { provider: 'datadog', site: 'datadoghq.eu', apiKey: 'k1' } });
      expect(sink).to.deep.equal({ provider: 'datadog', apiKey: 'k1', site: 'datadoghq.eu' });
    });

    it('omits site when the telemetry entry has none', () => {
      const sink = cache.extractSink({ telemetry: { provider: 'datadog', apiKey: 'k1' } });
      expect(sink).to.deep.equal({ provider: 'datadog', apiKey: 'k1' });
    });

    it('returns null when telemetry is absent', () => {
      expect(cache.extractSink({ telemetry: null })).to.equal(null);
      expect(cache.extractSink({})).to.equal(null);
      expect(cache.extractSink(null)).to.equal(null);
    });

    it('returns null when the credential is missing', () => {
      expect(cache.extractSink({ telemetry: { provider: 'datadog', apiKey: '' } })).to.equal(null);
    });
  });

  describe('extractSink (otlp)', () => {
    it('returns the declared target for an otlp telemetry entry', () => {
      const deployment = { telemetry: { provider: 'otlp', component: 'otelagent', port: 4318 } };
      expect(cache.extractSink(deployment)).to.deep.equal({ provider: 'otlp', component: 'otelagent', port: 4318 });
    });

    it('defaults the port when the entry has none', () => {
      const deployment = { telemetry: { provider: 'otlp', component: 'otelagent' } };
      expect(cache.extractSink(deployment)).to.deep.equal({ provider: 'otlp', component: 'otelagent', port: 4318 });
    });

    it('returns null for an otlp entry without a component', () => {
      expect(cache.extractSink({ telemetry: { provider: 'otlp' } })).to.be.null;
    });

    it('never returns a credential field for otlp', () => {
      const deployment = { telemetry: { provider: 'otlp', component: 'otelagent', port: 4318 } };
      expect(cache.extractSink(deployment)).to.not.have.property('apiKey');
    });

    it('carries app and components through when the spec routes cross-app / per-component', () => {
      const deployment = {
        telemetry: {
          provider: 'otlp', app: 'logstack', component: 'collector', components: ['web', 'worker'], port: 4318,
        },
      };
      expect(cache.extractSink(deployment)).to.deep.equal({
        provider: 'otlp', app: 'logstack', component: 'collector', components: ['web', 'worker'], port: 4318,
      });
    });

    it('omits app and components when the spec has neither — absence is the meaning', () => {
      const sink = cache.extractSink({ telemetry: { provider: 'otlp', component: 'otelagent' } });
      expect(sink).to.not.have.property('app');
      expect(sink).to.not.have.property('components');
    });

    it('copies the components array rather than aliasing the deployment view', () => {
      const telemetry = { provider: 'otlp', component: 'collector', components: ['web'] };
      const sink = cache.extractSink({ telemetry });
      telemetry.components.push('mutated');
      expect(sink.components).to.deep.equal(['web']);
    });
  });

  describe('entries', () => {
    it('iterates every cached [appKey, sink] pair for the reverse collector lookup', () => {
      cache.setSink('AppOne', { provider: 'otlp', component: 'collector', port: 4318 });
      cache.setSink('apptwo', { provider: 'datadog', apiKey: 'k1' });
      const all = [...cache.entries()];
      expect(all.map(([k]) => k).sort()).to.deep.equal(['appone', 'apptwo']);
    });
  });

  describe('set/get/delete (otlp)', () => {
    it('stores an otlp sink (usable without a credential)', () => {
      const sink = { provider: 'otlp', component: 'otelagent', port: 4318 };
      cache.setSink('OtlpApp', sink);
      expect(cache.getSink('otlpapp')).to.deep.equal(sink);
      expect(cache.hasAnyTelemetryApps()).to.equal(true);
    });

    it('clears the entry for an otlp sink without a component', () => {
      cache.setSink('OtlpApp', { provider: 'otlp', component: 'otelagent', port: 4318 });
      cache.setSink('OtlpApp', { provider: 'otlp', port: 4318 });
      expect(cache.getSink('OtlpApp')).to.be.null;
    });
  });

  describe('set/get/delete', () => {
    it('stores and retrieves a sink', () => {
      cache.setSink('MyApp', { provider: 'datadog', apiKey: 'k1' });
      expect(cache.getSink('MyApp')).to.deep.equal({ provider: 'datadog', apiKey: 'k1' });
    });

    it('matches app names case-insensitively', () => {
      cache.setSink('MyApp', { provider: 'datadog', apiKey: 'k1' });
      expect(cache.getSink('myapp')).to.deep.equal({ provider: 'datadog', apiKey: 'k1' });
    });

    it('setSink with a null or credential-less sink clears the entry', () => {
      cache.setSink('app1', { provider: 'datadog', apiKey: 'k1' });
      cache.setSink('app1', null);
      expect(cache.getSink('app1')).to.equal(null);

      cache.setSink('app2', { provider: 'datadog', apiKey: 'k2' });
      cache.setSink('app2', { provider: 'datadog', apiKey: '' });
      expect(cache.getSink('app2')).to.equal(null);
    });

    it('deleteSink removes an entry', () => {
      cache.setSink('app1', { provider: 'datadog', apiKey: 'k1' });
      cache.deleteSink('app1');
      expect(cache.getSink('app1')).to.equal(null);
    });

    it('hasAnyTelemetryApps reflects the populated state', () => {
      expect(cache.hasAnyTelemetryApps()).to.equal(false);
      cache.setSink('app1', { provider: 'datadog', apiKey: 'k1' });
      expect(cache.hasAnyTelemetryApps()).to.equal(true);
      cache.deleteSink('app1');
      expect(cache.hasAnyTelemetryApps()).to.equal(false);
    });

    it('getSink returns null for an unknown app', () => {
      expect(cache.getSink('nope')).to.equal(null);
    });
  });

  describe('onChange', () => {
    it('notifies when a sink appears, changes, or is removed', () => {
      const listener = sinon.stub();
      cache.onChange(listener);

      cache.setSink('app1', { provider: 'datadog', apiKey: 'k1' });
      expect(listener.callCount).to.equal(1);

      cache.setSink('app1', { provider: 'datadog', apiKey: 'k2' });
      expect(listener.callCount).to.equal(2);

      cache.deleteSink('app1');
      expect(listener.callCount).to.equal(3);
    });

    it('does not notify when the stored sink is unchanged (reconcile sweeps re-seed every cycle)', () => {
      const listener = sinon.stub();
      cache.onChange(listener);

      const sink = { provider: 'datadog', apiKey: 'k1' };
      cache.setSink('app1', sink);
      cache.setSink('app1', { ...sink });
      cache.setSink('absent', null);
      expect(listener.callCount).to.equal(1);
    });
  });

  describe('reconcileFromInstalled', () => {
    it('rebuilds the cache from installed telemetry apps and drops non-telemetry ones', async () => {
      deploymentProviderStub.listInstalledDeployments.resolves([
        { appName: 'telemApp', telemetry: { provider: 'datadog', site: 'datadoghq.com', apiKey: 'k1' } },
        { appName: 'plainApp', telemetry: null },
      ]);

      await cache.reconcileFromInstalled();

      expect(cache.getSink('telemApp')).to.deep.equal({ provider: 'datadog', apiKey: 'k1', site: 'datadoghq.com' });
      expect(cache.getSink('plainApp')).to.equal(null);
      expect(cache.hasAnyTelemetryApps()).to.equal(true);
    });

    it('clears stale entries no longer installed', async () => {
      cache.setSink('goneApp', { provider: 'datadog', apiKey: 'old' });
      deploymentProviderStub.listInstalledDeployments.resolves([]);

      await cache.reconcileFromInstalled();

      expect(cache.getSink('goneApp')).to.equal(null);
      expect(cache.hasAnyTelemetryApps()).to.equal(false);
    });

    it('logs and leaves the cache intact when the provider throws', async () => {
      cache.setSink('keepApp', { provider: 'datadog', apiKey: 'k1' });
      deploymentProviderStub.listInstalledDeployments.rejects(new Error('db down'));

      await cache.reconcileFromInstalled();

      expect(logStub.error.called).to.equal(true);
      expect(cache.getSink('keepApp')).to.deep.equal({ provider: 'datadog', apiKey: 'k1' });
    });
  });
});
