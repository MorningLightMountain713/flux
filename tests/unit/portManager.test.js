const { expect } = require('chai');
const sinon = require('sinon');
const config = require('config');
const proxyquire = require('proxyquire').noCallThru();

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
    config: { server: { apiport: 16127 }, fluxapps: config.fluxapps },
    axios: overrides.axios || { post: sinon.stub().resolves({ data: { status: 'success' } }) },
    '../utils/hostMutationLock': { withHostMutationLock: (fn) => fn() },
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
      extractPort: (addr) => (addr && addr.includes(':') ? Number(addr.split(':')[1]) : 16127),
    },
    '../utils/fluxHttpTestServer': {
      FluxHttpTestServer: sinon.stub(),
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
      getRandomSocketAddressSample: sinon.stub().resolves([]),
      ...(overrides.networkStateService || {}),
    },
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
      initial: { apiport: 16127 },
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
        { name: 'myapp', identity: 'myapp', version: 3, ports: [30001] },
      ].map(mockDeployment));

      const incoming = mockDeployment({ name: 'myapp', identity: 'a1b2c3d4e5f6', version: 3, ports: [30001] });

      let err;
      try {
        await portManager.ensureApplicationPortsNotUsed(incoming, []);
      } catch (e) { err = e; }

      expect(err, 'a name match must not read as "myself"').to.be.an('error');
      expect(err.message).to.include('port 30001 already used');
    });

    it('still allows an app to keep its own ports across an update', async () => {
      stubs.deploymentProviderStub.listInstalledDeployments.resolves([
        { name: 'myapp', identity: 'a1b2c3d4e5f6', version: 3, ports: [30001] },
      ].map(mockDeployment));

      const sameApp = mockDeployment({ name: 'myapp', identity: 'a1b2c3d4e5f6', version: 3, ports: [30001] });

      expect(await portManager.ensureApplicationPortsNotUsed(sameApp, [])).to.equal(true);
    });
  });

  describe('assignedPortsInstalledApps tests', () => {
    it('should return ports assigned by installed apps', async () => {
      stubs.deploymentProviderStub.listInstalledDeployments.resolves([
        { name: 'App1', version: 3, ports: [30001, 30002] },
        { name: 'App2', version: 3, ports: [30003, 30004] },
      ].map(mockDeployment));

      const result = await portManager.assignedPortsInstalledApps();

      expect(result).to.be.an('array').with.lengthOf(2);
      const app1 = result.find((app) => app.name === 'App1');
      expect(app1).to.exist;
      expect(app1.ports).to.include(30001);
      expect(app1.ports).to.include(30002);
    });

    it('should handle version 1 apps', async () => {
      stubs.deploymentProviderStub.listInstalledDeployments.resolves([
        { name: 'OldApp', version: 1, port: 30005 },
      ].map(mockDeployment));

      const result = await portManager.assignedPortsInstalledApps();

      const oldApp = result.find((app) => app.name === 'OldApp');
      expect(oldApp).to.exist;
      expect(oldApp.ports).to.include(30005);
    });

    it('should handle version 4+ compose apps', async () => {
      stubs.deploymentProviderStub.listInstalledDeployments.resolves([
        {
          name: 'ComposedApp',
          version: 4,
          compose: [
            { name: 'Component1', ports: [30006, 30007] },
            { name: 'Component2', ports: [30008] },
          ],
        },
      ].map(mockDeployment));

      const result = await portManager.assignedPortsInstalledApps();

      const composedApp = result.find((app) => app.name === 'ComposedApp');
      expect(composedApp).to.exist;
      expect(composedApp.ports).to.include(30006);
      expect(composedApp.ports).to.include(30007);
      expect(composedApp.ports).to.include(30008);
    });
  });

  describe('ensureApplicationPortsNotUsed tests', () => {
    it('should pass if ports are not used', async () => {
      stubs.deploymentProviderStub.listInstalledDeployments.resolves([
        { name: 'ExistingApp', version: 3, ports: [30001, 30002] },
      ].map(mockDeployment));

      const deployment = mockDeployment({ name: 'NewApp', version: 3, ports: [30010, 30011] });
      const result = await portManager.ensureApplicationPortsNotUsed(deployment, []);

      expect(result).to.be.true;
    });

    it('should throw error if port is already used by different app', async () => {
      stubs.deploymentProviderStub.listInstalledDeployments.resolves([
        { name: 'ExistingApp', version: 3, ports: [30001, 30002] },
      ].map(mockDeployment));

      const deployment = mockDeployment({ name: 'NewApp', version: 3, ports: [30001, 30011] });

      try {
        await portManager.ensureApplicationPortsNotUsed(deployment, []);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('port 30001 already used');
      }
    });

    it('should allow same app to use its own ports', async () => {
      stubs.deploymentProviderStub.listInstalledDeployments.resolves([
        { name: 'ExistingApp', version: 3, ports: [30001, 30002] },
      ].map(mockDeployment));

      const deployment = mockDeployment({ name: 'ExistingApp', version: 3, ports: [30001, 30002] });
      const result = await portManager.ensureApplicationPortsNotUsed(deployment, []);

      expect(result).to.be.true;
    });

    it('should handle version 1 apps with conflicting port', async () => {
      stubs.deploymentProviderStub.listInstalledDeployments.resolves([
        { name: 'ExistingApp', version: 3, ports: [30001, 30002] },
      ].map(mockDeployment));

      const deployment = mockDeployment({ name: 'OldNewApp', version: 1, port: 30001 });

      try {
        await portManager.ensureApplicationPortsNotUsed(deployment, []);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('port 30001 already used');
      }
    });

    it('should handle version 4+ compose apps with conflicting port', async () => {
      stubs.deploymentProviderStub.listInstalledDeployments.resolves([
        { name: 'ExistingApp', version: 3, ports: [30001, 30002] },
      ].map(mockDeployment));

      const deployment = mockDeployment({
        name: 'NewComposedApp',
        version: 4,
        compose: [
          { name: 'Component1', ports: [30001] },
          { name: 'Component2', ports: [30020] },
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
        { name: 'App1', version: 3, ports: [30001, 30002] },
        { name: 'App2', version: 3, ports: [30002, 30003] },
      ].map(mockDeployment));

      const result = await portManager.getAllUsedPorts();

      expect(result).to.be.an('array');
      expect(result).to.include(30001);
      expect(result).to.include(30002);
      expect(result).to.include(30003);
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
        { name: 'App1', version: 3, ports: [30001] },
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
        { name: 'App1', version: 3, ports: [30001] },
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
      installApp({ name: 'App1', version: 3, ports: [30001] });
      const { localPm, removeAppLocally } = loadUpnpFailing();

      await localPm.restoreAppsPortsSupport();

      sinon.assert.notCalled(removeAppLocally);
      expect(localPm.upnpMapFailures.get('App1').cycles).to.equal(1);
    });

    it('should retry a failed port within the cycle and record no failure on recovery', async () => {
      installApp({ name: 'App1', version: 3, ports: [30001] });
      const mapUpnpPort = sinon.stub().resolves(true);
      mapUpnpPort.onFirstCall().resolves(false);
      const { localPm, removeAppLocally } = loadUpnpFailing({ mapUpnpPort });

      await localPm.restoreAppsPortsSupport();

      sinon.assert.notCalled(removeAppLocally);
      expect(localPm.upnpMapFailures.has('App1')).to.be.false;
    });

    it('should not remove before the sustained window even after enough failing cycles', async () => {
      installApp({ name: 'App1', version: 3, ports: [30001] });
      const { localPm, removeAppLocally } = loadUpnpFailing();

      await localPm.restoreAppsPortsSupport();
      await localPm.restoreAppsPortsSupport();
      await localPm.restoreAppsPortsSupport();

      // 3 consecutive cycles, but the wall-clock window has not elapsed
      sinon.assert.notCalled(removeAppLocally);
      expect(localPm.upnpMapFailures.get('App1').cycles).to.equal(3);
    });

    it('should remove and broadcast only after sustained failure (cycles AND window)', async () => {
      installApp({ name: 'App1', version: 3, ports: [30001] });
      const { localPm, removeAppLocally } = loadUpnpFailing();
      const nowMonotonicMs = Number(process.hrtime.bigint() / 1000000n);
      // one strike short of the cycle gate, already past the wall-clock window
      localPm.upnpMapFailures.set('App1', { cycles: 2, firstFailureAtMs: nowMonotonicMs - (31 * 60 * 1000) });

      await localPm.restoreAppsPortsSupport();

      sinon.assert.calledWith(removeAppLocally, 'App1', null, true, true, true);
      expect(localPm.upnpMapFailures.has('App1')).to.be.false;
    });

    it('should clear the failure tracker once mapping succeeds again', async () => {
      installApp({ name: 'App1', version: 3, ports: [30001] });
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
        { name: 'App1', version: 3, ports: [30001] },
        { name: 'App2', version: 3, ports: [30002] },
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

  describe('signCheckAppData tests', () => {
    it('should sign message data', async () => {
      stubs.verificationHelperStub.signMessage.resolves('test-signature-string');

      const result = await portManager.signCheckAppData(JSON.stringify({ test: 'data' }));

      expect(result).to.be.a('string');
      expect(result.length).to.be.greaterThan(0);
      expect(result).to.equal('test-signature-string');
    });
  });
});

// Pure-logic probe helpers - no mongo, so a separate top-level describe.
describe('portManager port-reachability probe', () => {
  afterEach(() => sinon.restore());

  function loadProbe({ axiosPost, sample } = {}) {
    const stubs = makeStubs();
    const post = axiosPost || sinon.stub().resolves({ data: { status: 'success' } });
    const getRandomSocketAddressSample = sample || sinon.stub().resolves([]);
    const portManager = loadPortManager(stubs, {
      axios: { post },
      networkStateService: { getRandomSocketAddressSample },
    });
    return { portManager, post, getRandomSocketAddressSample };
  }

  describe('portless guard', () => {
    it('returns true immediately for a portless app without probing peers', async () => {
      const getLocalSocketAddress = sinon.stub().resolves('1.2.3.4:16127');
      const stubs = makeStubs();
      const portManager = loadPortManager(stubs, { fluxNetworkHelper: { getLocalSocketAddress } });

      expect(await portManager.checkInstallingAppPortAvailable([])).to.equal(true);
      expect(await portManager.checkInstallingAppPortAvailable()).to.equal(true);

      sinon.assert.notCalled(getLocalSocketAddress);
    });
  });

  describe('askPeerPortReachability', () => {
    it('reports reachable when the peer answers success', async () => {
      const { portManager } = loadProbe({ axiosPost: sinon.stub().resolves({ data: { status: 'success' } }) });
      const r = await portManager.askPeerPortReachability('5.5.5.5:16127', '{}', {});
      expect(r).to.deep.equal({ answered: true, reachable: true });
    });

    it('reports unreachable + failedPort when the peer answers error', async () => {
      const { portManager } = loadProbe({ axiosPost: sinon.stub().resolves({ data: { status: 'error', data: { message: 'Failed port: 30000' } } }) });
      const r = await portManager.askPeerPortReachability('5.5.5.5:16127', '{}', {});
      expect(r).to.deep.equal({ answered: true, reachable: false, failedPort: 30000 });
    });

    it('reports not-answered when the peer itself is unreachable', async () => {
      const { portManager } = loadProbe({ axiosPost: sinon.stub().rejects(new Error('ECONNREFUSED')) });
      const r = await portManager.askPeerPortReachability('5.5.5.5:16127', '{}', {});
      expect(r).to.deep.equal({ answered: false });
    });
  });

  describe('arePortsReachableViaPeers', () => {
    const data = { ip: '9.9.9.9', port: 16127, ports: [30000] };
    const threePeers = ['1.1.1.1:16127', '2.2.2.2:16127', '3.3.3.3:16127'];

    it('returns true on the first peer that reaches us (single round)', async () => {
      const { portManager, getRandomSocketAddressSample } = loadProbe({
        axiosPost: sinon.stub().resolves({ data: { status: 'success' } }),
        sample: sinon.stub().resolves(threePeers),
      });
      expect(await portManager.arePortsReachableViaPeers(data, 'me:16127')).to.equal(true);
      sinon.assert.calledOnce(getRandomSocketAddressSample);
      // peer independence is defined by the configurable prefix, not a hardcoded /16
      expect(getRandomSocketAddressSample.firstCall.args[1].prefixLength).to.equal(16);
    });

    it('returns false when >=2 distinct peers agree it is unreachable', async () => {
      const { portManager } = loadProbe({
        axiosPost: sinon.stub().resolves({ data: { status: 'error', data: { message: 'Failed port: 30000' } } }),
        sample: sinon.stub().resolves(threePeers),
      });
      expect(await portManager.arePortsReachableViaPeers(data, 'me:16127')).to.equal(false);
    });

    it('retries a fresh round when a round is inconclusive (no peer answered)', async () => {
      const post = sinon.stub();
      post.onCall(0).rejects(new Error('x'));
      post.onCall(1).rejects(new Error('x'));
      post.onCall(2).rejects(new Error('x'));
      post.resolves({ data: { status: 'success' } });
      const { portManager, getRandomSocketAddressSample } = loadProbe({ axiosPost: post, sample: sinon.stub().resolves(threePeers) });
      expect(await portManager.arePortsReachableViaPeers(data, 'me:16127')).to.equal(true);
      sinon.assert.calledTwice(getRandomSocketAddressSample);
    });

    it('fails closed after portTestMaxRounds when no peer ever answers', async () => {
      const sample = sinon.stub().resolves(threePeers);
      const { portManager } = loadProbe({ axiosPost: sinon.stub().rejects(new Error('unreachable')), sample });
      expect(await portManager.arePortsReachableViaPeers(data, 'me:16127')).to.equal(false);
      expect(sample.callCount).to.equal(config.fluxapps.portTestMaxRounds);
    });

    it('retries without crashing when a round yields no eligible peers', async () => {
      const sample = sinon.stub().resolves([]);
      const post = sinon.stub();
      const { portManager } = loadProbe({ axiosPost: post, sample });
      expect(await portManager.arePortsReachableViaPeers(data, 'me:16127')).to.equal(false);
      expect(sample.callCount).to.equal(config.fluxapps.portTestMaxRounds);
      sinon.assert.notCalled(post);
    });
  });
});
