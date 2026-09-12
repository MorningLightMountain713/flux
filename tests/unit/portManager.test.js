'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const { asConfig } = require('./fixtures/config');

// ── Mock helpers ──────────────────────────────────────────────────

/**
 * Given a raw/plain spec object (v1, v2-3, or v4+), extract ports the way
 * the real DeploymentSpec does.
 */
function extractPorts(spec) {
  if (!spec) return [];
  if (spec.compose) {
    const all = [];
    for (const c of spec.compose) {
      if (c.ports) all.push(...c.ports);
    }
    return [...new Set(all)].sort((a, b) => a - b);
  }
  if (spec.ports) return [...spec.ports];
  if (spec.port) return [spec.port];
  return [];
}

function mockDeployment(spec) {
  const ports = extractPorts(spec);
  return {
    appName: spec.name,
    // Resolved, never null: an app that stated no identity had its identifiers
    // built from its name, so that is what DeploymentSpec.identity reports.
    identity: spec.identity ?? spec.name,
    allHostPorts() { return ports; },
  };
}

function makeStubs() {
  const appsRepositoryStub = {
    listGlobalAppInfo: sinon.stub().resolves([]),
  };

  const deploymentProviderStub = {
    listInstalledDeployments: sinon.stub().resolves([]),
    buildDeployment: sinon.stub().callsFake(async (inst) => mockDeployment(inst)),
    // Delegates at call time so per-test overrides of buildDeployment flow
    // through the plural entry the port collector uses.
    get buildDeployments() {
      const single = this.buildDeployment;
      return async (inst) => {
        const deployment = await single(inst);
        return deployment ? [deployment] : [];
      };
    },
  };

  const verificationHelperStub = {
    signMessage: sinon.stub().resolves('test-signature'),
  };

  return { appsRepositoryStub, deploymentProviderStub, verificationHelperStub };
}

function buildProxyquireMap(stubs, overrides = {}) {
  const fluxNet = overrides.fluxNetworkHelper || {};
  const upnp = overrides.upnpService || {};
  return {
    config: asConfig({
      server: { apiport: 16_127 },
      fluxapps: {
        // The reachability probe's knobs. Read through config.get, so a probe
        // test without them throws rather than silently taking a default.
        portTestPeerTimeoutMs: 5,
        portTestBindDelayMs: 0,
        portTestPropagationDelayMs: 0,
        portTestMaxAttempts: 5,
        portTestPeerQueryCount: 3,
        portTestMaxRounds: 3,
        portTestPrefixLength: 16,
        ...(overrides.fluxapps || {}),
      },
    }),
    axios: overrides.axios || { post: sinon.stub().resolves({ data: { status: 'success' } }) },
    '../dbHelper': {},
    '../appDatabase/appsRepository': stubs.appsRepositoryStub,
    '../appRuntime/deploymentProvider': stubs.deploymentProviderStub,
    '../utils/appConstants': {
      localAppsInformation: 'zelappsinformation',
      globalAppsInformation: 'zelappsglobalinformation',
      appsFolder: '/tmp/fluxapps/',
    },
    '../utils/socketAddressUtils': {
      extractIp: (addr) => (addr ? addr.split(':')[0] : null),
      extractPort: (addr) => (addr && addr.includes(':') ? Number(addr.split(':')[1]) : 16_127),
    },
    '../utils/fluxHttpTestServer': {
      // The real one listens on the port and serves the token back. These tests
      // are about what the probe CONCLUDES from peer answers, so the bind is
      // faked - but it has to emit 'listening', or the probe never gets past it.
      FluxHttpTestServer: overrides.FluxHttpTestServer || class {
        constructor(token) { this.token = token; this.handlers = {}; }

        once(event, handler) { this.handlers[event] = handler; return this; }

        removeAllListeners() { return this; }

        listen() { setImmediate(() => this.handlers.listening && this.handlers.listening()); }

        close(cb) { if (cb) cb(); }
      },
    },
    '../fluxNetworkHelper': {
      getLocalSocketAddress: sinon.stub().resolves('127.0.0.1:16127'),
      getFluxNodePrivateKey: sinon.stub().resolves('testprivkey'),
      getFluxNodePublicKey: sinon.stub().resolves('testpubkey'),
      isFirewallActive: sinon.stub().resolves(false),
      allowPort: sinon.stub().resolves(true),
      deleteAllowPortRule: sinon.stub().resolves(true),
      isPortBanned: sinon.stub().returns(false),
      isPortUPNPBanned: sinon.stub().returns(false),
      ...fluxNet,
    },
    '../upnpService': {
      isUPNP: sinon.stub().returns(false),
      setupUPNP: sinon.stub().resolves(true),
      mapUpnpPort: sinon.stub().resolves(true),
      removeMapUpnpPort: sinon.stub().resolves(true),
      ...upnp,
    },
    '../verificationHelper': stubs.verificationHelperStub,
    '../networkStateService': {
      getRandomSocketAddress: sinon.stub().resolves('192.168.1.1:16127'),
      getRandomExternalObserver: sinon.stub().resolves('192.168.1.1:16127'),
      // The reachability probe draws a diverse SAMPLE per round, not one peer.
      getRandomSocketAddressSample: sinon.stub().resolves([]),
      ...(overrides.networkStateService || {}),
    },
    '../utils/nodeSigner': {
      nodeSigner: sinon.stub().resolves({ pubKey: 'testpubkey', sign: () => 'testsig' }),
      ...(overrides.nodeSigner || {}),
    },
    '../utils/fluxEventBus': { publish: sinon.stub(), ...(overrides.fluxEventBus || {}) },
    '../serviceHelper': {
      ensureNumber: (v) => Number(v),
      delay: sinon.stub().resolves(),
      ...(overrides.serviceHelper || {}),
    },
    // lazily required inside restoreAppsPortsSupport's sustained-failure removal
    '../appLifecycle/appUninstaller': overrides.appUninstaller || { removeAppLocally: sinon.stub().resolves() },
    '../../lib/log': {
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
    },
  };
}

function loadPortManager(stubs, overrides = {}) {
  return proxyquire('../../ZelBack/src/services/appNetwork/portManager',
    buildProxyquireMap(stubs, overrides));
}

// ── Tests ─────────────────────────────────────────────────────────

describe('portManager tests', () => {
  let portManager;
  let stubs;
  let originalUserConfig;

  before(() => {
    originalUserConfig = globalThis.userconfig;
    globalThis.userconfig = {
      initial: { apiport: 16_127 },
    };
  });

  after(() => {
    globalThis.userconfig = originalUserConfig;
  });

  beforeEach(() => {
    stubs = makeStubs();
    portManager = loadPortManager(stubs);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('port conflicts across two apps sharing one name', () => {
    // A name is briefly held by two apps at once - the one expiring and the one
    // re-registering it. They are different apps with different data, and only
    // their identity says so.
    it('refuses the port when a leftover install of the PREVIOUS holder still has it', async () => {
      stubs.deploymentProviderStub.listInstalledDeployments.resolves([
        { name: 'myapp', identity: 'myapp', version: 3, ports: [30_001] },
      ].map(mockDeployment));

      const incoming = mockDeployment({ name: 'myapp', identity: 'a1b2c3d4e5f6', version: 3, ports: [30_001] });

      let err;
      try {
        await portManager.ensureApplicationPortsNotUsed(incoming, []);
      } catch (e) { err = e; }

      expect(err, 'a name match must not read as "myself"').to.be.an('error');
      expect(err.message).to.include('port 30001 already used');
    });

    // The co-located case: one replica installed here, a second assigned to the
    // same node with its own hostPort override. The app's GLOBAL spec carries
    // every replica's port, so the incoming replica meets its own app in the
    // port map — a match on the app it IS, not a different one.
    it('allows a second co-located replica whose port its own global spec already lists', async () => {
      stubs.deploymentProviderStub.listInstalledDeployments.resolves([
        { name: 'myapp', identity: 'a1b2c3d4e5f6', version: 3, ports: [36_020] },
      ].map(mockDeployment));
      stubs.appsRepositoryStub.listGlobalAppInfo.resolves([
        { name: 'myapp', identity: 'a1b2c3d4e5f6', version: 3, ports: [36_020, 36_021] },
      ]);

      const incomingReplica = mockDeployment({
        name: 'myapp', identity: 'a1b2c3d4e5f6', version: 3, ports: [36_021],
      });

      expect(await portManager.ensureApplicationPortsNotUsed(incomingReplica, ['myapp'])).to.equal(true);
    });

    it('still allows an app to keep its own ports across an update', async () => {
      stubs.deploymentProviderStub.listInstalledDeployments.resolves([
        { name: 'myapp', identity: 'a1b2c3d4e5f6', version: 3, ports: [30_001] },
      ].map(mockDeployment));

      const sameApp = mockDeployment({ name: 'myapp', identity: 'a1b2c3d4e5f6', version: 3, ports: [30_001] });

      expect(await portManager.ensureApplicationPortsNotUsed(sameApp, [])).to.equal(true);
    });
  });

  describe('assignedPortsInstalledApps tests', () => {
    it('should return ports assigned by installed apps', async () => {
      stubs.deploymentProviderStub.listInstalledDeployments.resolves([
        { name: 'App1', version: 3, ports: [30_001, 30_002] },
        { name: 'App2', version: 3, ports: [30_003, 30_004] },
      ].map(mockDeployment));

      const result = await portManager.assignedPortsInstalledApps();

      expect(result).to.be.an('array').with.lengthOf(2);
      const app1 = result.find((app) => app.name === 'App1');
      expect(app1).to.exist;
      expect(app1.ports).to.include(30_001);
      expect(app1.ports).to.include(30_002);
    });

    it('should handle version 1 apps', async () => {
      stubs.deploymentProviderStub.listInstalledDeployments.resolves([
        { name: 'OldApp', version: 1, port: 30_005 },
      ].map(mockDeployment));

      const result = await portManager.assignedPortsInstalledApps();

      const oldApp = result.find((app) => app.name === 'OldApp');
      expect(oldApp).to.exist;
      expect(oldApp.ports).to.include(30_005);
    });

    it('should handle version 4+ compose apps', async () => {
      stubs.deploymentProviderStub.listInstalledDeployments.resolves([
        {
          name: 'ComposedApp',
          version: 4,
          compose: [
            { name: 'Component1', ports: [30_006, 30_007] },
            { name: 'Component2', ports: [30_008] },
          ],
        },
      ].map(mockDeployment));

      const result = await portManager.assignedPortsInstalledApps();

      const composedApp = result.find((app) => app.name === 'ComposedApp');
      expect(composedApp).to.exist;
      expect(composedApp.ports).to.include(30_006);
      expect(composedApp.ports).to.include(30_007);
      expect(composedApp.ports).to.include(30_008);
    });
  });

  describe('ensureApplicationPortsNotUsed tests', () => {
    it('should pass if ports are not used', async () => {
      stubs.deploymentProviderStub.listInstalledDeployments.resolves([
        { name: 'ExistingApp', version: 3, ports: [30_001, 30_002] },
      ].map(mockDeployment));

      const deployment = mockDeployment({ name: 'NewApp', version: 3, ports: [30_010, 30_011] });
      const result = await portManager.ensureApplicationPortsNotUsed(deployment, []);

      expect(result).to.be.true;
    });

    it('should throw error if port is already used by different app', async () => {
      stubs.deploymentProviderStub.listInstalledDeployments.resolves([
        { name: 'ExistingApp', version: 3, ports: [30_001, 30_002] },
      ].map(mockDeployment));

      const deployment = mockDeployment({ name: 'NewApp', version: 3, ports: [30_001, 30_011] });

      try {
        await portManager.ensureApplicationPortsNotUsed(deployment, []);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('port 30001 already used');
      }
    });

    it('should allow same app to use its own ports', async () => {
      stubs.deploymentProviderStub.listInstalledDeployments.resolves([
        { name: 'ExistingApp', version: 3, ports: [30_001, 30_002] },
      ].map(mockDeployment));

      const deployment = mockDeployment({ name: 'ExistingApp', version: 3, ports: [30_001, 30_002] });
      const result = await portManager.ensureApplicationPortsNotUsed(deployment, []);

      expect(result).to.be.true;
    });

    it('should handle version 1 apps with conflicting port', async () => {
      stubs.deploymentProviderStub.listInstalledDeployments.resolves([
        { name: 'ExistingApp', version: 3, ports: [30_001, 30_002] },
      ].map(mockDeployment));

      const deployment = mockDeployment({ name: 'OldNewApp', version: 1, port: 30_001 });

      try {
        await portManager.ensureApplicationPortsNotUsed(deployment, []);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('port 30001 already used');
      }
    });

    it('should handle version 4+ compose apps with conflicting port', async () => {
      stubs.deploymentProviderStub.listInstalledDeployments.resolves([
        { name: 'ExistingApp', version: 3, ports: [30_001, 30_002] },
      ].map(mockDeployment));

      const deployment = mockDeployment({
        name: 'NewComposedApp',
        version: 4,
        compose: [
          { name: 'Component1', ports: [30_001] },
          { name: 'Component2', ports: [30_020] },
        ],
      });

      try {
        await portManager.ensureApplicationPortsNotUsed(deployment, []);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('port 30001 already used');
      }
    });
  });



  describe('getAllUsedPorts tests', () => {
    it('should return all used ports without duplicates', async () => {
      stubs.deploymentProviderStub.listInstalledDeployments.resolves([
        { name: 'App1', version: 3, ports: [30_001, 30_002] },
        { name: 'App2', version: 3, ports: [30_002, 30_003] },
      ].map(mockDeployment));

      const result = await portManager.getAllUsedPorts();

      expect(result).to.be.an('array');
      expect(result).to.include(30_001);
      expect(result).to.include(30_002);
      expect(result).to.include(30_003);
      expect(result.length).to.equal(new Set(result).size);
    });
  });

  describe('restoreFluxPortsSupport tests', () => {
    it('should setup firewall rules when firewall is active', async () => {
      const fluxNetOverride = {
        isFirewallActive: sinon.stub().resolves(true),
        allowPort: sinon.stub().resolves(true),
      };

      const localPm = loadPortManager(stubs, { fluxNetworkHelper: fluxNetOverride });

      await localPm.restoreFluxPortsSupport();

      sinon.assert.called(fluxNetOverride.allowPort);
    });

    it('should setup UPNP when UPNP is active', async () => {
      const upnpOverride = {
        isUPNP: sinon.stub().returns(true),
        setupUPNP: sinon.stub().resolves(true),
      };

      const localPm = loadPortManager(stubs, { upnpService: upnpOverride });

      await localPm.restoreFluxPortsSupport();

      sinon.assert.called(upnpOverride.setupUPNP);
    });

    it('should handle errors gracefully', async () => {
      const fluxNetOverride = {
        isFirewallActive: sinon.stub().rejects(new Error('Firewall error')),
      };

      const localPm = loadPortManager(stubs, { fluxNetworkHelper: fluxNetOverride });

      // Should not throw
      await localPm.restoreFluxPortsSupport();
    });
  });

  describe('restoreAppsPortsSupport tests', () => {
    it('should setup firewall for app ports when active', async () => {
      stubs.deploymentProviderStub.listInstalledDeployments.resolves([
        { name: 'App1', version: 3, ports: [30_001] },
      ].map(mockDeployment));

      const fluxNetOverride = {
        isFirewallActive: sinon.stub().resolves(true),
        allowPort: sinon.stub().resolves(true),
      };

      const localPm = loadPortManager(stubs, { fluxNetworkHelper: fluxNetOverride });

      await localPm.restoreAppsPortsSupport();

      sinon.assert.called(fluxNetOverride.allowPort);
    });

    it('should setup UPNP for app ports when active', async () => {
      stubs.deploymentProviderStub.listInstalledDeployments.resolves([
        { name: 'App1', version: 3, ports: [30_001] },
      ].map(mockDeployment));

      const upnpOverride = {
        isUPNP: sinon.stub().returns(true),
        mapUpnpPort: sinon.stub().resolves(true),
      };

      const localPm = loadPortManager(stubs, { upnpService: upnpOverride });

      await localPm.restoreAppsPortsSupport();

      sinon.assert.called(upnpOverride.mapUpnpPort);
    });

    it('should handle errors gracefully', async () => {
      const fluxNetOverride = {
        allowPort: sinon.stub().rejects(new Error('Firewall error')),
      };

      const localPm = loadPortManager(stubs, { fluxNetworkHelper: fluxNetOverride });

      // Should not throw
      await localPm.restoreAppsPortsSupport();
    });

    // A failed UPnP mapping is routine on consumer-router (UPnP) nodes and the
    // app keeps running regardless; removal now requires sustained failure
    // (>=3 consecutive cycles AND 30 wall-clock minutes), tracked per app.
    function loadUpnpFailing(overrides = {}) {
      const mapUpnpPort = overrides.mapUpnpPort || sinon.stub().resolves(false);
      const delay = sinon.stub().resolves();
      const removeAppLocally = sinon.stub().resolves();
      const localPm = loadPortManager(stubs, {
        upnpService: { isUPNP: sinon.stub().returns(true), mapUpnpPort },
        appUninstaller: { removeAppLocally },
        serviceHelper: { delay },
      });
      return {
        localPm, mapUpnpPort, delay, removeAppLocally,
      };
    }

    function installApp(...specs) {
      stubs.deploymentProviderStub.listInstalledDeployments.resolves(specs.map(mockDeployment));
    }

    it('should NOT remove an app on a single UPNP mapping failure', async () => {
      // the incident regression: one failed map used to escalate straight to
      // removeAppLocally(force, sendMessage) - a transient router blip nuked a
      // running app and broadcast its removal to the network
      installApp({ name: 'App1', version: 3, ports: [30_001] });
      const { localPm, removeAppLocally } = loadUpnpFailing();

      await localPm.restoreAppsPortsSupport();

      sinon.assert.notCalled(removeAppLocally);
      expect(localPm.upnpMapFailures.get('App1').cycles).to.equal(1);
    });

    it('should retry a failed port within the cycle and record no failure on recovery', async () => {
      installApp({ name: 'App1', version: 3, ports: [30_001] });
      const mapUpnpPort = sinon.stub().resolves(true);
      mapUpnpPort.onFirstCall().resolves(false);
      const { localPm, removeAppLocally } = loadUpnpFailing({ mapUpnpPort });

      await localPm.restoreAppsPortsSupport();

      sinon.assert.notCalled(removeAppLocally);
      expect(localPm.upnpMapFailures.has('App1')).to.be.false;
    });

    it('should not remove before the sustained window even after enough failing cycles', async () => {
      installApp({ name: 'App1', version: 3, ports: [30_001] });
      const { localPm, removeAppLocally } = loadUpnpFailing();

      await localPm.restoreAppsPortsSupport();
      await localPm.restoreAppsPortsSupport();
      await localPm.restoreAppsPortsSupport();

      // 3 consecutive cycles, but the wall-clock window has not elapsed
      sinon.assert.notCalled(removeAppLocally);
      expect(localPm.upnpMapFailures.get('App1').cycles).to.equal(3);
    });

    it('should remove and broadcast only after sustained failure (cycles AND window)', async () => {
      installApp({ name: 'App1', version: 3, ports: [30_001] });
      const { localPm, removeAppLocally } = loadUpnpFailing();
      const nowMonotonicMs = Number(process.hrtime.bigint() / 1_000_000n);
      // one strike short of the cycle gate, already past the wall-clock window
      localPm.upnpMapFailures.set('App1', { cycles: 2, firstFailureAtMs: nowMonotonicMs - (31 * 60 * 1000) });

      await localPm.restoreAppsPortsSupport();

      sinon.assert.calledWith(removeAppLocally, 'App1', null, true, true, true);
      expect(localPm.upnpMapFailures.has('App1')).to.be.false;
    });

    it('should clear the failure tracker once mapping succeeds again', async () => {
      installApp({ name: 'App1', version: 3, ports: [30_001] });
      const mapUpnpPort = sinon.stub().resolves(false);
      const { localPm, removeAppLocally } = loadUpnpFailing({ mapUpnpPort });

      await localPm.restoreAppsPortsSupport();
      expect(localPm.upnpMapFailures.get('App1').cycles).to.equal(1);

      mapUpnpPort.resolves(true);
      await localPm.restoreAppsPortsSupport();

      expect(localPm.upnpMapFailures.has('App1')).to.be.false;
      sinon.assert.notCalled(removeAppLocally);
    });

    it('should pay the retry pause at most once per cycle across failing apps', async () => {
      installApp(
        { name: 'App1', version: 3, ports: [30_001] },
        { name: 'App2', version: 3, ports: [30_002] },
      );
      const { localPm, mapUpnpPort, delay } = loadUpnpFailing();

      await localPm.restoreAppsPortsSupport();

      // both apps still get their retry attempt and their strike, but the
      // recovery pause is shared - not stacked per app
      sinon.assert.calledOnce(delay);
      expect(mapUpnpPort.callCount).to.equal(4);
      expect(localPm.upnpMapFailures.get('App1').cycles).to.equal(1);
      expect(localPm.upnpMapFailures.get('App2').cycles).to.equal(1);
    });
  });

  // THE REACHABILITY PROBE. This file had no coverage of it at all, which is how
  // a rewrite of it could look safe. The property it exists to hold: the peer
  // reads each port and hands back what it found, and the comparison happens
  // HERE against a token the peer was never given - so a neighbour at the same
  // public address cannot pass itself off as this node, and a peer that is old,
  // broken or lying cannot manufacture a token it never saw.
  describe('checkInstallingAppPortAvailable', () => {
    // The peer echoes what it read on each port. Our own token coming back is
    // the proof; anything else is one peer's report.
    const echoes = (ports, token) => ({
      status: 'success',
      data: { answered: Object.fromEntries(ports.map((port) => [port, token])) },
    });

    it('probes nothing at all for an app with no ports', async () => {
      const axiosPost = sinon.stub().resolves({ data: { status: 'success' } });
      const sample = sinon.stub().resolves(['10.1.0.1:16127']);
      portManager = loadPortManager(stubs, {
        axios: { post: axiosPost },
        networkStateService: { getRandomSocketAddressSample: sample },
      });

      const verdict = await portManager.checkInstallingAppPortAvailable([]);

      // A portless app has nothing that a peer's silence could be about, and the
      // probe can spend every round's timeout before answering "nothing was
      // learned". Its install must not hinge on reaching a random peer.
      expect(verdict.ok).to.equal(true);
      expect(verdict.reason).to.equal('noPorts');
      sinon.assert.notCalled(sample);
      sinon.assert.notCalled(axiosPost);
    });

    it('one peer returning this node\'s own token settles it', async () => {
      let token = null;
      const FakeServer = class {
        constructor(t) { token = t; this.handlers = {}; }

        once(event, handler) { this.handlers[event] = handler; return this; }

        removeAllListeners() { return this; }

        listen() { setImmediate(() => this.handlers.listening()); }

        close(cb) { if (cb) cb(); }
      };
      const axiosPost = sinon.stub().callsFake(async () => ({ data: echoes([31_000], token) }));
      portManager = loadPortManager(stubs, {
        FluxHttpTestServer: FakeServer,
        axios: { post: axiosPost },
        networkStateService: {
          getRandomSocketAddressSample: sinon.stub().resolves(['10.1.0.1:16127']),
        },
      });

      const verdict = await portManager.checkInstallingAppPortAvailable([31_000]);

      expect(verdict.ok).to.equal(true);
      expect(verdict.reason).to.equal('proven');
    });

    it('asks a whole round of peers at once, not one at a time', async () => {
      const peers = ['10.1.0.1:16127', '10.2.0.1:16127', '10.3.0.1:16127'];
      let concurrent = 0;
      let peak = 0;
      const axiosPost = sinon.stub().callsFake(async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => { setImmediate(resolve); });
        concurrent -= 1;
        return null;
      });
      const sample = sinon.stub().resolves(peers);
      portManager = loadPortManager(stubs, {
        axios: { post: axiosPost },
        networkStateService: { getRandomSocketAddressSample: sample },
        fluxapps: { portTestMaxRounds: 1 },
      });

      await portManager.checkInstallingAppPortAvailable([31_000]);

      // Reachability is external, so the peer round-trip is the only signal and
      // there is nothing local to wait for. Serially, a round of silent peers
      // costs their timeouts end to end before the install can start.
      expect(peak, 'the round was asked in series').to.equal(3);
      expect(sample.firstCall.args[1]).to.include({ distinctPrefixes: true });
      expect(sample.firstCall.args[1].excludeSocketAddress).to.equal('127.0.0.1:16127');
    });

    it('two peers reading something other than this node refuses the install', async () => {
      const axiosPost = sinon.stub().resolves({ data: echoes([31_000], 'someone-elses-token') });
      portManager = loadPortManager(stubs, {
        axios: { post: axiosPost },
        networkStateService: {
          getRandomSocketAddressSample: sinon.stub().resolves(['10.1.0.1:16127', '10.2.0.1:16127']),
        },
      });

      const verdict = await portManager.checkInstallingAppPortAvailable([31_000]);

      expect(verdict.ok).to.equal(false);
      expect(verdict.reason).to.equal('notOurs');
      expect(verdict.port).to.equal(31_000);
      expect(verdict.peers).to.have.lengthOf(2);
    });

    it('one peer alone is a witness, not a verdict', async () => {
      const axiosPost = sinon.stub().resolves({ data: echoes([31_000], 'someone-elses-token') });
      portManager = loadPortManager(stubs, {
        axios: { post: axiosPost },
        networkStateService: {
          // one peer this round, and none left after it
          getRandomSocketAddressSample: sinon.stub().resolves(['10.1.0.1:16127']),
        },
      });

      const verdict = await portManager.checkInstallingAppPortAvailable([31_000]);

      // What was not corroborated does not refuse an install - that is what
      // stops the first nodes to upgrade refusing everything while the rest of
      // the network catches up.
      expect(verdict.ok).to.equal(true);
      expect(verdict.reason).to.equal('noOtherObserver');
      expect(verdict.port).to.equal(31_000);
    });

    it('peers that never answer decide nothing', async () => {
      const axiosPost = sinon.stub().rejects(new Error('unreachable'));
      portManager = loadPortManager(stubs, {
        axios: { post: axiosPost },
        networkStateService: {
          getRandomSocketAddressSample: sinon.stub().resolves(['10.1.0.1:16127', '10.2.0.1:16127']),
        },
        // One round, so the loop ends on its own bound. Left to run, it would
        // redraw the same two peers, filter them as already asked and end on
        // "nobody left to ask" - which is a different fact and reads as one.
        fluxapps: { portTestMaxRounds: 1 },
      });

      const verdict = await portManager.checkInstallingAppPortAvailable([31_000]);

      expect(verdict.ok).to.equal(true);
      expect(verdict.reason).to.equal('noneAnswered');
      expect(verdict.silent).to.equal(true);
    });

    it('a peer on older code that cannot read ports back is not a witness', async () => {
      const axiosPost = sinon.stub().resolves({ data: { status: 'success', data: {} } });
      portManager = loadPortManager(stubs, {
        axios: { post: axiosPost },
        networkStateService: {
          getRandomSocketAddressSample: sinon.stub().resolves(['10.1.0.1:16127', '10.2.0.1:16127']),
        },
        fluxapps: { portTestMaxRounds: 1 },
      });

      const verdict = await portManager.checkInstallingAppPortAvailable([31_000]);

      expect(verdict.ok).to.equal(true);
      expect(verdict.reason).to.equal('noReader');
    });

    it('a banned port is refused before any peer is asked', async () => {
      const sample = sinon.stub().resolves(['10.1.0.1:16127']);
      portManager = loadPortManager(stubs, {
        fluxNetworkHelper: { isPortBanned: sinon.stub().returns(true) },
        networkStateService: { getRandomSocketAddressSample: sample },
      });

      const verdict = await portManager.checkInstallingAppPortAvailable([31_000]);

      expect(verdict.ok).to.equal(false);
      expect(verdict.reason).to.equal('portBanned');
      sinon.assert.notCalled(sample);
    });
  });
});
