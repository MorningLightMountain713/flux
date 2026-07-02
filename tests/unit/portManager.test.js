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
    },
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

  describe('isPortAvailable tests', () => {
    beforeEach(() => {
      stubs.deploymentProviderStub.listInstalledDeployments.resolves([
        { name: 'App1', version: 3, ports: [30001, 30002] },
        { name: 'App2', version: 3, ports: [30003] },
      ].map(mockDeployment));
    });

    it('should return false if port is used', async () => {
      const result = await portManager.isPortAvailable(30001);

      expect(result).to.be.false;
    });

    it('should return true if port is not used', async () => {
      const result = await portManager.isPortAvailable(30100);

      expect(result).to.be.true;
    });

    it('should exclude specified app from check', async () => {
      const result = await portManager.isPortAvailable(30001, 'App1');

      expect(result).to.be.true;
    });

    it('should not exclude different app from check', async () => {
      const result = await portManager.isPortAvailable(30001, 'App2');

      expect(result).to.be.false;
    });
  });

  describe('findNextAvailablePort tests', () => {
    beforeEach(() => {
      stubs.deploymentProviderStub.listInstalledDeployments.resolves([
        { name: 'App1', version: 3, ports: [30001, 30002, 30003] },
      ].map(mockDeployment));
    });

    it('should find next available port', async () => {
      const result = await portManager.findNextAvailablePort(30001, 30010);

      expect(result).to.equal(30004);
    });

    it('should return null if no available port in range', async () => {
      const result = await portManager.findNextAvailablePort(30001, 30003);

      expect(result).to.be.null;
    });

    it('should return first port if available', async () => {
      const result = await portManager.findNextAvailablePort(30010, 30020);

      expect(result).to.equal(30010);
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
