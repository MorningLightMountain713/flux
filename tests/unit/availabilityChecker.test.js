'use strict';

// Set NODE_CONFIG_DIR before any requires
if (!process.env.NODE_CONFIG_DIR) {
  process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;
}

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
// eslint-disable-next-line no-unused-vars
const axios = require('axios');
const config = require('config');

const availabilityChecker = require('../../ZelBack/src/services/appMonitoring/availabilityChecker');
const nodeConfirmationService = require('../../ZelBack/src/services/nodeConfirmationService');
const deploymentProvider = require('../../ZelBack/src/services/appRuntime/deploymentProvider');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
// eslint-disable-next-line no-unused-vars
const verificationHelper = require('../../ZelBack/src/services/verificationHelper');
const daemonStatus = require('../../ZelBack/src/services/daemonService/daemonStatus');
const upnpService = require('../../ZelBack/src/services/upnpService');
const networkStateService = require('../../ZelBack/src/services/networkStateService');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const fluxHttpTestServer = require('../../ZelBack/src/services/utils/fluxHttpTestServer');
const fluxUdpTestServer = require('../../ZelBack/src/services/utils/fluxUdpTestServer');
const portManager = require('../../ZelBack/src/services/appNetwork/portManager');
const registryManager = require('../../ZelBack/src/services/appDatabase/registryManager');
const policyStore = require('../../ZelBack/src/services/policyStore');
const {
  loadSpecLibrary, V8_SUBMISSION, registeredSpec, assertAnswers,
} = require('./fixtures/fluxSpec');
const { stubHostedInstances, installedRecord } = require('./fixtures/appRecords');

const signer = { pubKey: 'pubkey', sign: () => 'signature' };
// the check with a node that can sign its port test
const signingAvailabilityChecker = proxyquire('../../ZelBack/src/services/appMonitoring/availabilityChecker', {
  '../utils/nodeSigner': { nodeSigner: async () => signer },
});

// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. This checker asks each installed app for the host ports it occupies
// and then refuses to probe one of them, so the port list is the whole point of
// the module. The doubles it carried made that list impossible to exercise:
// `{ allHostPorts: () => [30001, 30002, 30003] }` never had to agree with any
// spec, and `{ name: 'App1', version: 3, ports: [30001] }` was handed to the
// checker as an INSTALLED APP, whose ports the checker does not read at all —
// it reads them off the deployment. With the default deployment stub answering
// undefined, the app-port list was empty on every run and the "port in use"
// branch was never taken by any test in this file.
//
// What stays stubbed is I/O and node-local facts: the daemon sync RPC, the
// confirmation flag, the local socket address, the firewall and UPnP calls, the
// peer picker and the installed-app query.
let flux;

const APPS_FOLDER = '/tmp/apps';

/**
 * A real multi-component legacy spec occupying the given host ports. v8 because
 * the app names here are mixed case, which v9 refuses.
 */
function multiPortSpec(name, hostPorts) {
  const [template] = V8_SUBMISSION.compose;
  return flux.FluxAppSpecV8.fromSubmission({
    ...V8_SUBMISSION,
    name,
    compose: hostPorts.map((hostPort, index) => ({
      ...template,
      name: `Component${index + 1}`,
      description: `Component${index + 1}`,
      ports: [hostPort],
      containerPorts: [8080 + index],
    })),
  }, { chain: flux.Chain.MAIN });
}

/** A real DeploymentSpec — the object the checker calls allHostPorts() on. */
function deploymentOf(spec) {
  return flux.DeploymentSpec.fromSpec(spec, APPS_FOLDER, { replica: null });
}

describe('availabilityChecker tests', () => {
  let mockDosState;
  let mockPortsNotWorking;
  let mockFailedNodesCache;
  let waitMs;
  let listInstalledAppsStub;
  let buildDeploymentStub;
  let delayStub;
  let udpServers;
  let udpToken;

  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(60_000);
    flux = await loadSpecLibrary();
  });

  /**
   * deploymentProvider stays stubbed, so nothing here exercises what the real
   * one does with the HostedInstance it is handed. buildDeployments reads
   * `.isEncrypted` and `.spec` (through resolveRegisteredSpec), `.name` for
   * its error messages and `.identity` for every container name it derives,
   * then asks the resolved spec's placement for its mode. Assert all of that
   * off the object that actually arrived: the `{ name: 'App1' }` literal this
   * file used to hand over answers exactly one of those and would have reached
   * the real provider as a spec-less object.
   */
  function assertBuildDeploymentGotARealSpec(expected) {
    const [handed] = buildDeploymentStub.firstCall.args;
    expect(handed, 'nothing was handed to the deployment provider').to.be.an('object');
    expect(handed.name, 'the provider names the app in every failure it logs').to.equal(expected.name);
    expect(handed.isEncrypted, 'resolveRegisteredSpec branches on this').to.be.a('boolean');
    expect(handed.identity, 'read off the row, never recomputed - it names every container')
      .to.satisfy((id) => id === null || typeof id === 'string');
    expect(handed.spec, 'resolveRegisteredSpec returns this for a cleartext row').to.be.an('object');
    // resolveLocalReplicas asks the RESOLVED spec's placement for its mode
    // before it will build anything.
    assertAnswers(handed.spec.placement, ['mode', 'hasTargets']);
  }

  beforeEach(() => {
    listInstalledAppsStub = sinon.stub().resolves([]);
    stubHostedInstances().apps.callsFake(async () => (await listInstalledAppsStub()).map((record) => installedRecord(record)));
    buildDeploymentStub = sinon.stub(deploymentProvider, 'buildDeployment');
    // Delegates at call time so per-test overrides of buildDeployment flow
    // through the plural entry the checker uses.
    sinon.stub(deploymentProvider, 'buildDeployments').callsFake(async (inst) => {
      const deployment = await deploymentProvider.buildDeployment(inst);
      return deployment ? [deployment] : [];
    });
    mockDosState = {
      dosMessage: null,
      dosStateValue: 0,
      testingPort: null,
      nextTestingPort: null,
      originalPortFailed: null,
      routerRefusalsSeen: 0,
    };
    mockPortsNotWorking = new Set();
    mockFailedNodesCache = new Map();
    waitMs = undefined;

    delayStub = sinon.stub(serviceHelper, 'delay').resolves();
    fluxNetworkHelper.setUdpReachability(null);

    // No application at this address holds a port, unless a test says so.
    sinon.stub(registryManager, 'getRunningAppIpList').resolves([]);
    sinon.stub(portManager, 'assignedPortsGlobalApps').resolves([]);
    sinon.stub(portManager, 'siblingHoldingPort').resolves(null);

    udpServers = [];
    udpToken = null;
    sinon.stub(fluxUdpTestServer, 'FluxUdpTestServer').callsFake((token) => {
      udpToken = token;
      const server = { listen: sinon.stub().resolves(), allow: sinon.stub(), close: sinon.stub() };
      udpServers.push(server);
      return server;
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('checkMyAppsAvailability tests', () => {
    it('should return early if daemon not synced', async () => {
      sinon.stub(daemonStatus, 'daemonSyncState').returns({ synced: false });

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      sinon.assert.notCalled(listInstalledAppsStub);
      expect(waitMs).to.equal(240_000);
    });

    it('should return early if node not confirmed', async () => {
      sinon.stub(daemonStatus, 'daemonSyncState').returns({ synced: true });
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(false);

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      sinon.assert.notCalled(listInstalledAppsStub);
    });

    it('should return early if no public IP found', async () => {
      sinon.stub(daemonStatus, 'daemonSyncState').returns({ synced: true });
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves(null);

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      sinon.assert.notCalled(listInstalledAppsStub);
    });

    it('should return early if failed to get installed apps', async () => {
      sinon.stub(daemonStatus, 'daemonSyncState').returns({ synced: true });
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      listInstalledAppsStub.rejects(new Error('Failed'));

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      sinon.assert.calledOnce(listInstalledAppsStub);
    });

    it('should collect ports via DeploymentSpec.allHostPorts', async () => {
      const spec = multiPortSpec('App1', [31_001, 31_002, 31_003]);
      const registered = await registeredSpec(spec);
      const deployment = deploymentOf(spec);
      // The ports are the library's, derived from the components, not a
      // fixture's claim about them.
      expect(deployment.allHostPorts()).to.deep.equal([31_001, 31_002, 31_003]);

      listInstalledAppsStub.resolves([registered]);
      buildDeploymentStub.resolves(deployment);

      sinon.stub(daemonStatus, 'daemonSyncState').returns({ synced: true });
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      sinon.stub(networkStateService, 'getRandomExternalObserver').resolves(null);

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      sinon.assert.calledOnce(listInstalledAppsStub);
      sinon.assert.calledOnce(buildDeploymentStub);
      sinon.assert.calledWith(buildDeploymentStub, sinon.match.instanceOf(flux.HostedInstance).and(sinon.match.has('record', registered)));
      assertBuildDeploymentGotARealSpec(spec);
      expect(waitMs).to.equal(240_000);
    });

    it('should skip banned ports', async () => {
      const apps = [];

      sinon.stub(daemonStatus, 'daemonSyncState').returns({ synced: true });
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      listInstalledAppsStub.resolves(apps);
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(true);

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      expect(waitMs).to.equal(15_000);
    });

    it('should skip UPNP banned ports when UPNP enabled', async () => {
      const apps = [];

      sinon.stub(daemonStatus, 'daemonSyncState').returns({ synced: true });
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      listInstalledAppsStub.resolves(apps);
      sinon.stub(upnpService, 'isUPNP').returns(true);
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      sinon.stub(fluxNetworkHelper, 'isPortUPNPBanned').returns(true);

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      expect(waitMs).to.be.a('number');
    });


    it('should skip ports already in use by apps', async () => {
      // The port under test is CHOSEN by the checker, never read from the state
      // it was handed - so pinning `testingPort` beforehand, as this case used
      // to, was overwritten on the next line of production code and the branch
      // never ran. `nextTestingPort` is the field that actually steers it.
      const spec = multiPortSpec('App1', [31_001, 31_002, 31_003]);
      const registered = await registeredSpec(spec);
      listInstalledAppsStub.resolves([registered]);
      buildDeploymentStub.resolves(deploymentOf(spec));
      mockDosState.nextTestingPort = 31_002;

      sinon.stub(daemonStatus, 'daemonSyncState').returns({ synced: true });
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      // Reached only if the "in use" branch does NOT fire, so leaving this
      // stubbed proves the branch by what it does not do.
      const peerPicker = sinon.stub(networkStateService, 'getRandomExternalObserver').resolves(null);

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      expect(mockDosState.testingPort).to.equal(31_002);
      // timeouts.failure - the port belongs to an installed app, so it is not
      // probed at all.
      expect(waitMs).to.equal(15_000);
      sinon.assert.notCalled(peerPicker);
    });

    it('probes a port no installed app occupies', async () => {
      // The contrast that makes the case above non-vacuous: same apps, same
      // stubs, one port outside the set the real deployment reports. This one
      // gets as far as picking a peer.
      const spec = multiPortSpec('App1', [31_001, 31_002, 31_003]);
      const registered = await registeredSpec(spec);
      listInstalledAppsStub.resolves([registered]);
      buildDeploymentStub.resolves(deploymentOf(spec));
      mockDosState.nextTestingPort = 31_009;

      sinon.stub(daemonStatus, 'daemonSyncState').returns({ synced: true });
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      const peerPicker = sinon.stub(networkStateService, 'getRandomExternalObserver').resolves(null);

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      expect(mockDosState.testingPort).to.equal(31_009);
      sinon.assert.calledOnce(peerPicker);
      expect(waitMs).to.equal(240_000);
    });

    it('keeps the ports of the apps it can resolve when one app cannot be built', async () => {
      // The per-app catch in the collection loop. An app whose spec will not
      // resolve - an encrypted one this node cannot decrypt - must not cost the
      // sweep the ports of every app after it, or the checker would probe a
      // port an app is listening on and DOS itself over the failure.
      const broken = multiPortSpec('BrokenApp', [31_005]);
      const healthy = multiPortSpec('HealthyApp', [31_002]);
      const brokenRegistered = await registeredSpec(broken);
      const healthyRegistered = await registeredSpec(healthy);
      listInstalledAppsStub.resolves([brokenRegistered, healthyRegistered]);
      // sinon's withArgs cannot tell two frozen RegisteredSpec instances
      // apart, so the answer is keyed off an identity Map instead.
      const answers = new Map([[healthyRegistered, deploymentOf(healthy)]]);
      buildDeploymentStub.callsFake(async (install) => {
        const deployment = answers.get(install.record);
        if (!deployment) throw new Error(`Could not resolve spec for ${install.name}`);
        return deployment;
      });
      mockDosState.nextTestingPort = 31_002;

      sinon.stub(daemonStatus, 'daemonSyncState').returns({ synced: true });
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      const peerPicker = sinon.stub(networkStateService, 'getRandomExternalObserver').resolves(null);

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      sinon.assert.calledTwice(buildDeploymentStub);
      expect(waitMs, 'the healthy app still shields its own port').to.equal(15_000);
      sinon.assert.notCalled(peerPicker);
    });

    it('should skip if remote socket address not available', async () => {
      const apps = [];

      sinon.stub(daemonStatus, 'daemonSyncState').returns({ synced: true });
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      listInstalledAppsStub.resolves(apps);
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      sinon.stub(networkStateService, 'getRandomExternalObserver').resolves(null);

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      expect(waitMs).to.equal(240_000);
    });

    it('should skip if remote node in failed cache', async () => {
      const apps = [];
      mockFailedNodesCache.set('192.168.1.200:16127', '');

      sinon.stub(daemonStatus, 'daemonSyncState').returns({ synced: true });
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      listInstalledAppsStub.resolves(apps);
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      sinon.stub(networkStateService, 'getRandomExternalObserver').resolves('192.168.1.200:16127');

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      expect(waitMs).to.equal(15_000);
    });

    describe('a node behind UPnP', () => {
      const UPNP_DOS = 'Not possible to run applications on the node, router returning exceptions when creating UPNP ports mappings';
      let refusals;
      let mapUpnpPortStub;
      let removeMapUpnpPortStub;
      let portTestStub;

      const refused = (code, routerWide) => ({
        mapped: false, code, reason: `TCP 1 not mapped: UPnP error ${code}`, routerWide,
      });
      const MAPPED = {
        mapped: true, code: null, reason: null, routerWide: false,
      };
      // the router refuses `count` mappings of others - an install's, a restore's
      const routerRefusesOthers = (count) => { refusals += count; };

      beforeEach(() => {
        refusals = 0;
        sinon.stub(daemonStatus, 'daemonSyncState').returns({ synced: true });
        sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);
        sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
        listInstalledAppsStub.resolves([]);
        sinon.stub(upnpService, 'isUPNP').returns(true);
        sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
        // The port under test is drawn at random, so this gate has to be closed
        // too: left real, it refuses whenever the draw lands in upnpBannedPorts
        // and the run returns before it ever reaches mapUpnpPort.
        sinon.stub(fluxNetworkHelper, 'isPortUPNPBanned').returns(false);
        sinon.stub(networkStateService, 'getRandomExternalObserver').resolves('192.168.1.200:16127');
        sinon.stub(fluxNetworkHelper, 'isFirewallActive').resolves(true);
        sinon.stub(fluxNetworkHelper, 'allowTestPort').resolves();
        sinon.stub(fluxNetworkHelper, 'deleteTestPortRule').resolves();
        sinon.stub(upnpService, 'routerRefusals').callsFake(() => refusals);
        sinon.stub(upnpService, 'removalPending').returns(false);
        mapUpnpPortStub = sinon.stub(upnpService, 'mapUpnpPort').resolves(MAPPED);
        removeMapUpnpPortStub = sinon.stub(upnpService, 'removeMapUpnpPort').resolves(true);
        sinon.stub(fluxHttpTestServer.FluxHttpTestServer.prototype, 'listen').callsFake(function listen() {
          this.emit('listening');
          return this;
        });
        sinon.stub(fluxHttpTestServer.FluxHttpTestServer.prototype, 'close').callsFake((callback) => callback && callback());
        portTestStub = sinon.stub(axios, 'post').resolves({ data: { status: 'success', data: { message: 'Ports reachable' } } });
      });

      // the test mapping refused as `result` gives it, one router-wide refusal counted when it is
      const testMappingRefused = (result) => mapUpnpPortStub.callsFake(async () => {
        if (result.routerWide) refusals += 1;
        return result;
      });

      const pass = async () => signingAvailabilityChecker.waitForNextPass(
        await signingAvailabilityChecker.runAvailabilityCheckOnce(mockDosState, mockPortsNotWorking, mockFailedNodesCache),
      );

      it('counts a test mapping the router refused for its own reason', async () => {
        testMappingRefused(refused(728, true));

        await pass();

        expect(mockDosState.portFailureScore).to.equal(4);
        expect(mockDosState.dosStateValue, 'the node\'s DOS, which a count below the threshold leaves alone').to.equal(0);
        sinon.assert.notCalled(portTestStub);
        sinon.assert.calledWith(delayStub, 60_000);
      });

      it('does not count a test mapping refused for its port alone', async () => {
        testMappingRefused(refused(718, false));

        await pass();

        expect(mockDosState.portFailureScore ?? 0).to.equal(0);
      });

      // A pass costs the router one mapping and one removal.
      it('maps the port under test for one protocol a pass, TCP first', async () => {
        await pass();

        sinon.assert.calledOnceWithExactly(mapUpnpPortStub, mockDosState.testingPort, 'Flux_Test_App', { protocols: ['TCP'] });
        expect(JSON.parse(portTestStub.firstCall.args[1]).protocols).to.deep.equal(['tcp']);
        sinon.assert.notCalled(fluxUdpTestServer.FluxUdpTestServer);
      });

      it('tests UDP alone on the pass after a TCP pass that passed, and TCP after that', async () => {
        await pass();
        portTestStub.callsFake(async (url, body) => {
          const { ports: [port] } = JSON.parse(body);
          return { data: { status: 'success', data: { udpAnswered: { [port]: fluxUdpTestServer.udpReply(udpToken).toString() } } } };
        });
        await pass();

        expect(mapUpnpPortStub.secondCall.args[2]).to.deep.equal({ protocols: ['UDP'] });
        expect(JSON.parse(portTestStub.secondCall.args[1]).protocols).to.deep.equal(['udp']);
        expect(fluxHttpTestServer.FluxHttpTestServer.prototype.listen.callCount, 'a TCP test server on the UDP pass').to.equal(1);
        expect(fluxNetworkHelper.getUdpReachability()).to.deep.equal({ reachable: true });

        await pass();
        expect(mapUpnpPortStub.thirdCall.args[2]).to.deep.equal({ protocols: ['TCP'] });
      });

      // A peer that does not know `protocols` tests TCP, finds it unmapped, and
      // says the port failed: on a UDP pass that is no evidence at all.
      it('reads nothing from a peer\'s TCP failure on a UDP pass, and tests UDP again with another peer', async () => {
        mockDosState.testingProtocol = 'udp';
        portTestStub.callsFake(async (url, body) => {
          const { ports: [port] } = JSON.parse(body);
          return { data: { status: 'error', data: { message: `Flux Applications on 1.2.3.4:16127 are not available. Failed port: ${port}` } } };
        });

        await pass();

        expect(mockPortsNotWorking.size).to.equal(0);
        expect(mockDosState.portFailureScore ?? 0).to.equal(0);
        expect(mockDosState.nextTestingPort).to.equal(mockDosState.testingPort);
        expect(mockDosState.testingProtocol).to.equal('udp');
        sinon.assert.calledWith(delayStub.lastCall, 15_000);
      });

      it('goes back to TCP after as many UDP passes as learn nothing', async () => {
        mockDosState.testingProtocol = 'udp';
        portTestStub.resolves({ data: { status: 'error', data: { message: 'Failed port: 1' } } });

        await pass();
        await pass();
        expect(mockDosState.testingProtocol, 'gave up early').to.equal('udp');
        await pass();

        expect(mockDosState.testingProtocol).to.equal('tcp');
        expect(mockDosState.udpUnsettled).to.equal(0);
      });

      // A router refusing the UDP mapping is as broken as one refusing TCP.
      it('counts a UDP mapping the router refused for its own reason as a router fault, and stays on UDP', async () => {
        mockDosState.testingProtocol = 'udp';
        testMappingRefused(refused(606, true));

        await pass();

        expect(mockDosState.portFailureScore).to.equal(4);
        expect(mockDosState.testingProtocol).to.equal('udp');
        sinon.assert.notCalled(portTestStub);
      });

      it('stays on TCP while its TCP test fails', async () => {
        portTestStub.resolves({ data: { status: 'error', data: { message: 'Failed port: 1' } } });

        await pass();

        expect(mockPortsNotWorking.size).to.equal(1);
        expect(mockDosState.testingProtocol ?? 'tcp').to.equal('tcp');
      });

      it('makes no test mapping, opens no port, and counts a failed check while the router has yet to remove a mapping of this node', async () => {
        upnpService.removalPending.returns(true);

        await pass();

        sinon.assert.notCalled(mapUpnpPortStub);
        sinon.assert.notCalled(fluxNetworkHelper.allowTestPort);
        sinon.assert.notCalled(portTestStub);
        expect(mockDosState.portFailureScore).to.equal(4);
        sinon.assert.calledWith(delayStub, 60_000);
      });

      it('holds the node out of service once the router has yet to remove a mapping for as many passes as the threshold takes', async () => {
        upnpService.removalPending.returns(true);

        // eslint-disable-next-line no-restricted-syntax
        for (let i = 0; i < 25; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await pass();
        }

        expect(mockDosState.portFailureScore).to.equal(100);
        expect(mockDosState.dosMessage).to.equal(UPNP_DOS);
        expect(mockDosState.dosStateValue).to.equal(100);
        sinon.assert.calledWith(delayStub.lastCall, 300_000);
      });

      it('waits no longer than an error\'s wait after a pass that left a removal pending', async () => {
        upnpService.removalPending.onFirstCall().returns(false).returns(true);

        await pass();

        sinon.assert.calledOnce(portTestStub);
        sinon.assert.calledWith(delayStub.lastCall, 60_000);
      });

      it('waits no longer than an error\'s wait after a passing test in a pass that counted a router refusal', async () => {
        routerRefusesOthers(1);

        await pass();

        sinon.assert.calledOnce(portTestStub);
        sinon.assert.calledWith(delayStub.lastCall, 60_000);
      });

      it('waits no longer than an error\'s wait after a pass the router refused a mapping during', async () => {
        portTestStub.callsFake(async () => {
          routerRefusesOthers(1);
          return { data: { status: 'success', data: { message: 'Ports reachable' } } };
        });

        await pass();

        expect(mockDosState.portFailureScore ?? 0, 'counted by the next pass').to.equal(0);
        sinon.assert.calledWith(delayStub.lastCall, 60_000);
      });

      it('waits a DOS\'s wait after a pass that counted a router refusal while out of service', async () => {
        mockDosState.portFailureScore = 100;
        mockDosState.dosStateValue = 100;
        mockDosState.dosMessage = UPNP_DOS;
        routerRefusesOthers(1);

        await pass();

        sinon.assert.calledWith(delayStub.lastCall, 300_000);
      });

      it('waits the whole wait after a passing test that left nothing pending', async () => {
        await pass();

        sinon.assert.calledWith(delayStub.lastCall, 3_600_000);
      });

      // eslint-disable-next-line no-restricted-syntax
      for (const event of ['mappingRefused', 'removalPending', 'removalsClear']) {
        it(`starts its next pass at once on UPnP's ${event}`, async () => {
          delayStub.returns(new Promise(() => {}));
          let waited = false;
          const done = pass().then(() => { waited = true; });
          // eslint-disable-next-line no-await-in-loop
          for (let i = 0; i < 1000 && !delayStub.called; i += 1) await Promise.resolve();
          sinon.assert.calledOnceWithExactly(delayStub, 3_600_000);
          expect(waited, 'still waiting').to.equal(false);

          upnpService.routerEvents.emit(event);
          upnpService.routerEvents.emit(event);
          await done;

          expect(waited).to.equal(true);
        });
      }

      it('starts no pass on a wake while it is not waiting', async () => {
        portTestStub.callsFake(async () => {
          upnpService.routerEvents.emit('removalsClear');
          return { data: { status: 'success', data: { message: 'Ports reachable' } } };
        });

        await pass();
        sinon.assert.calledWith(delayStub.lastCall, 3_600_000);
      });

      it('removes what the router kept of a test mapping it refused', async () => {
        testMappingRefused(refused(718, false));

        await pass();

        sinon.assert.calledOnceWithExactly(removeMapUpnpPortStub, mockDosState.testingPort, 'Flux_Test_App');
      });

      it('opens the port under test to IPv4 only, and deletes only that rule', async () => {
        testMappingRefused(refused(728, true));
        const allowBoth = sinon.stub(fluxNetworkHelper, 'allowPort').resolves();
        const deleteBoth = sinon.stub(fluxNetworkHelper, 'deleteAllowPortRule').resolves();

        await pass();

        expect(fluxNetworkHelper.allowTestPort.args).to.deep.equal([[mockDosState.testingPort, 'tcp']]);
        expect(fluxNetworkHelper.deleteTestPortRule.args).to.deep.equal([[mockDosState.testingPort, 'tcp']]);
        sinon.assert.notCalled(allowBoth);
        sinon.assert.notCalled(deleteBoth);
      });

      it('counts once a pass however many mappings the router refused since the last', async () => {
        routerRefusesOthers(7);

        await pass();

        expect(mockDosState.portFailureScore).to.equal(4);
        expect(mockDosState.routerRefusalsSeen).to.equal(7);
      });

      it('counts nothing for refusals an earlier pass counted', async () => {
        routerRefusesOthers(7);
        mockDosState.routerRefusalsSeen = 7;

        await pass();

        expect(mockDosState.portFailureScore ?? 0).to.equal(0);
      });

      it('keeps its router DOS through a pass whose test worked while the router refused others', async () => {
        mockDosState.portFailureScore = 100;
        mockDosState.dosStateValue = 100;
        mockDosState.dosMessage = UPNP_DOS;
        routerRefusesOthers(1);

        await pass();

        sinon.assert.calledOnce(portTestStub);
        expect(mockDosState.dosMessage).to.equal(UPNP_DOS);
        expect(mockDosState.dosStateValue).to.equal(100);
        expect(mockDosState.portFailureScore).to.equal(100);
      });

      it('ends its router DOS on a pass whose test worked and the router refused nothing', async () => {
        mockDosState.portFailureScore = 100;
        mockDosState.dosStateValue = 100;
        mockDosState.dosMessage = UPNP_DOS;
        routerRefusesOthers(3);
        mockDosState.routerRefusalsSeen = 3;

        await pass();

        sinon.assert.calledOnce(portTestStub);
        expect(mockDosState.dosMessage).to.equal(null);
        expect(mockDosState.dosStateValue).to.equal(0);
        expect(mockDosState.portFailureScore).to.equal(0);
      });

      it('leaves another check\'s DOS message standing when its own UPnP failures reach the threshold', async () => {
        mockDosState.portFailureScore = 96;
        mockDosState.dosStateValue = 12;
        mockDosState.dosMessage = 'Flux is not available for outside communication';
        testMappingRefused(refused(728, true));

        await pass();

        expect(mockDosState.portFailureScore).to.equal(100);
        expect(mockDosState.dosStateValue).to.equal(12);
        expect(mockDosState.dosMessage).to.equal('Flux is not available for outside communication');
      });

      it('holds the node out of service with its own message when its UPnP failures reach the threshold and no other stands', async () => {
        mockDosState.portFailureScore = 96;
        testMappingRefused(refused(728, true));

        await pass();

        expect(mockDosState.dosMessage).to.equal(UPNP_DOS);
        expect(mockDosState.dosStateValue).to.equal(100);
        sinon.assert.calledWith(delayStub, 300_000);
      });
    });

    describe('proof over TCP and UDP', () => {
      const PEERS = ['192.168.1.200:16127', '192.168.1.201:16127', '192.168.1.202:16127', '192.168.1.203:16127', '192.168.1.204:16127'];
      let observer;
      let portTestStub;

      // What a peer that reads the port and probes UDP answers: `tcp` and `udp`
      // are 'ours', another application's bytes, or null for silence; `udp`
      // undefined is a peer that does not probe UDP.
      const reading = (tcp, udp) => async (url, body) => {
        const { ports: [port] } = JSON.parse(body);
        const value = (v, ours) => (v === 'ours' ? ours : v);
        const data = { message: 'Ports reachable', answered: { [port]: value(tcp, `X-Flux-Port-Test: ${udpToken}`) } };
        if (udp !== undefined) data.udpAnswered = { [port]: value(udp, fluxUdpTestServer.udpReply(udpToken).toString()) };
        return { data: { status: 'success', data } };
      };

      beforeEach(() => {
        sinon.stub(daemonStatus, 'daemonSyncState').returns({ synced: true });
        sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);
        sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
        listInstalledAppsStub.resolves([]);
        sinon.stub(upnpService, 'isUPNP').returns(false);
        sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
        observer = -1;
        sinon.stub(networkStateService, 'getRandomExternalObserver').callsFake(async () => {
          observer += 1;
          return PEERS[observer];
        });
        sinon.stub(fluxNetworkHelper, 'isFirewallActive').resolves(false);
        sinon.stub(fluxHttpTestServer.FluxHttpTestServer.prototype, 'listen').callsFake(function listen() {
          this.emit('listening');
          return this;
        });
        sinon.stub(fluxHttpTestServer.FluxHttpTestServer.prototype, 'close').callsFake((callback) => callback && callback());
        portTestStub = sinon.stub(axios, 'post').callsFake(reading('ours', 'ours'));
      });

      const pass = async () => signingAvailabilityChecker.waitForNextPass(
        await signingAvailabilityChecker.runAvailabilityCheckOnce(mockDosState, mockPortsNotWorking, mockFailedNodesCache),
      );

      it('asks the peer to read the port and probe it over UDP, answering only that peer', async () => {
        await pass();

        const body = JSON.parse(portTestStub.firstCall.args[1]);
        expect(body.echo).to.equal(true);
        expect(body.protocols).to.deep.equal(['tcp', 'udp']);
        sinon.assert.calledOnceWithExactly(udpServers[0].listen, mockDosState.testingPort);
        sinon.assert.calledOnceWithExactly(udpServers[0].allow, '192.168.1.200');
        expect(udpServers[0].allow.calledBefore(portTestStub)).to.equal(true);
        sinon.assert.calledOnce(udpServers[0].close);
      });

      it('passes, and reports UDP reachable, on our token over TCP and UDP', async () => {
        await pass();

        expect(mockPortsNotWorking.size).to.equal(0);
        expect(fluxNetworkHelper.getUdpReachability()).to.deep.equal({ reachable: true });
        sinon.assert.calledWith(delayStub.lastCall, 3_600_000);
      });

      // Whatever holds the port, this node cannot serve an application on it.
      it('counts a port that answered as something other than this node as failed', async () => {
        portTestStub.callsFake(reading('somebody else entirely', undefined));

        await pass();

        expect(mockPortsNotWorking.has(mockDosState.testingPort)).to.equal(true);
      });

      it('takes a peer that does not read ports at its word', async () => {
        portTestStub.resolves({ data: { status: 'success', data: { message: 'Ports reachable' } } });

        await pass();

        expect(mockPortsNotWorking.size).to.equal(0);
        expect(fluxNetworkHelper.getUdpReachability()).to.equal(null);
      });

      it('skips a port an application at this address holds, testing nothing', async () => {
        sinon.stub(Math, 'random').returns(0.5);
        const { fluxapps: { portMin, portMax } } = config;
        const port = Math.floor(0.5 * (portMax - portMin) + portMin);
        registryManager.getRunningAppIpList.resolves([{ name: 'neighbour' }]);
        portManager.assignedPortsGlobalApps.resolves([{ name: 'neighbour', ports: [port] }]);

        await pass();

        sinon.assert.calledWith(portManager.assignedPortsGlobalApps, ['neighbour']);
        sinon.assert.notCalled(portTestStub);
        expect(mockPortsNotWorking.size).to.equal(0);
      });

      it('skips a port a node sharing this address says it holds, testing nothing', async () => {
        portManager.siblingHoldingPort.resolves({ address: '192.168.1.100:16137', port: 1 });

        await pass();

        sinon.assert.notCalled(portTestStub);
      });

      // UDP loses datagrams: one peer's silence is tested again by another.
      it('counts nothing on one peer\'s silence over UDP, and tests the port again with another peer', async () => {
        portTestStub.callsFake(reading('ours', null));

        await pass();
        const port = mockDosState.testingPort;

        expect(mockPortsNotWorking.size).to.equal(0);
        expect(mockDosState.nextTestingPort).to.equal(port);
        sinon.assert.calledWith(delayStub.lastCall, 15_000);
        expect(fluxNetworkHelper.getUdpReachability()).to.equal(null);

        await pass();

        expect(mockDosState.testingPort).to.equal(port);
        sinon.assert.calledWith(networkStateService.getRandomExternalObserver.secondCall, '192.168.1.100:16127', { exclude: [PEERS[0]] });
      });

      // A pass whose TCP passes is a passing pass for TCP, whatever UDP needs next.
      it('clears its failed ports and lifts its DOS on a TCP pass whose first peer heard nothing over UDP, and still retests UDP', async () => {
        mockPortsNotWorking.add(1234);
        mockDosState.portFailureScore = 8;
        mockDosState.dosMessage = 'Ports tested not reachable from outside, DMZ or UPNP required! All ports that have failed: [1234]';
        mockDosState.dosStateValue = 100;
        portTestStub.callsFake(reading('ours', null));

        await pass();

        expect(mockPortsNotWorking.size, 'failed ports left until the retest').to.equal(0);
        expect(mockDosState.dosMessage, 'its DOS left until the retest').to.equal(null);
        expect(mockDosState.nextTestingPort).to.equal(mockDosState.testingPort);
        sinon.assert.calledWith(delayStub.lastCall, 15_000);
      });

      it('takes our token heard by a second peer over the first peer\'s silence', async () => {
        portTestStub.onFirstCall().callsFake(reading('ours', null));

        await pass();
        await pass();

        expect(fluxNetworkHelper.getUdpReachability()).to.deep.equal({ reachable: true });
        expect(mockDosState.udpSuspect).to.equal(null);
      });

      it('reports UDP unreachable, and counts nothing, when two peers hear nothing and policy has not switched the DOS on', async () => {
        portTestStub.callsFake(reading('ours', null));

        await pass();
        await pass();

        expect(fluxNetworkHelper.getUdpReachability()).to.deep.equal({
          reachable: false, port: mockDosState.testingPort, peers: ['192.168.1.200', '192.168.1.201'],
        });
        expect(mockPortsNotWorking.size).to.equal(0);
      });

      it('counts the port failed when two peers hear nothing and policy has switched the DOS on', async () => {
        sinon.stub(policyStore, 'getDocument').withArgs('udpportdos').returns(true);
        portTestStub.callsFake(reading('ours', null));

        await pass();
        await pass();

        expect(mockPortsNotWorking.has(mockDosState.testingPort)).to.equal(true);
        expect(fluxNetworkHelper.getUdpReachability().reachable).to.equal(false);
      });

      it('drops one peer\'s silence unconfirmed after as many passes as find no peer that probes UDP', async () => {
        portTestStub.onFirstCall().callsFake(reading('ours', null));
        portTestStub.callsFake(reading('ours', undefined));

        await pass();
        const port = mockDosState.testingPort;
        await pass();
        await pass();
        expect(mockDosState.nextTestingPort, 'stopped retesting early').to.equal(port);
        await pass();

        expect(mockDosState.udpSuspect).to.equal(null);
        expect(mockDosState.nextTestingPort).to.equal(null);
        expect(fluxNetworkHelper.getUdpReachability()).to.equal(null);
      });
    });

    it('should handle errors gracefully and retry', async () => {
      sinon.stub(daemonStatus, 'daemonSyncState').throws(new Error('Service error'));

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      expect(waitMs).to.equal(240_000);
    });

    it('should use random port from config range when nextTestingPort not set', async () => {
      const apps = [];

      sinon.stub(daemonStatus, 'daemonSyncState').returns({ synced: true });
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      listInstalledAppsStub.resolves(apps);
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      sinon.stub(networkStateService, 'getRandomExternalObserver').resolves(null);

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      expect(mockDosState.testingPort).to.be.a('number');
      expect(mockDosState.testingPort).to.be.at.least(config.fluxapps.portMin);
      expect(mockDosState.testingPort).to.be.at.most(config.fluxapps.portMax);
    });

    it('should use nextTestingPort when set', async () => {
      const apps = [];
      mockDosState.nextTestingPort = 31_050;

      sinon.stub(daemonStatus, 'daemonSyncState').returns({ synced: true });
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      listInstalledAppsStub.resolves(apps);
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      sinon.stub(networkStateService, 'getRandomExternalObserver').resolves(null);

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      expect(mockDosState.testingPort).to.equal(31_050);
    });
  });

  describe('releaseOwnDos', () => {
    const ports = 'Ports tested not reachable from outside, DMZ or UPNP required! All ports that have failed: [1]';

    it('ends its count, and the node\'s DOS when the message is this check\'s', () => {
      const state = { dosMessage: ports, dosStateValue: 100, portFailureScore: 100 };

      availabilityChecker.releaseOwnDos(state);

      expect(state).to.deep.equal({ dosMessage: null, dosStateValue: 0, portFailureScore: 0 });
    });

    it('ends its count and leaves the node\'s count when no check holds the node out of service', () => {
      const state = { dosMessage: null, dosStateValue: 8, portFailureScore: 40 };

      availabilityChecker.releaseOwnDos(state);

      expect(state).to.deep.equal({ dosMessage: null, dosStateValue: 8, portFailureScore: 0 });
    });

    it('ends its count and leaves another check\'s DOS alone', () => {
      const state = { dosMessage: 'Flux IP detection failed', dosStateValue: 11, portFailureScore: 100 };

      availabilityChecker.releaseOwnDos(state);

      expect(state).to.deep.equal({ dosMessage: 'Flux IP detection failed', dosStateValue: 11, portFailureScore: 0 });
    });
  });

  describe('countPortFailure', () => {
    const ports = 'Ports tested not reachable from outside, DMZ or UPNP required! All ports that have failed: [1]';

    it('counts four a failure toward its own threshold, leaving the node\'s DOS alone below it', () => {
      const state = { dosMessage: null, dosStateValue: 3, portFailureScore: 92 };

      expect(availabilityChecker.countPortFailure(state, 100, ports)).to.equal(false);

      expect(state).to.deep.equal({ dosMessage: null, dosStateValue: 3, portFailureScore: 96 });
    });

    it('holds the node out of service at the threshold when no other check does', () => {
      const state = { dosMessage: null, dosStateValue: 3, portFailureScore: 96 };

      expect(availabilityChecker.countPortFailure(state, 100, ports)).to.equal(true);

      expect(state).to.deep.equal({ dosMessage: ports, dosStateValue: 100, portFailureScore: 100 });
    });

    it('does not take over another check\'s DOS at the threshold', () => {
      const state = { dosMessage: 'Flux IP detection failed', dosStateValue: 11, portFailureScore: 96 };

      expect(availabilityChecker.countPortFailure(state, 100, ports)).to.equal(false);

      expect(state).to.deep.equal({ dosMessage: 'Flux IP detection failed', dosStateValue: 11, portFailureScore: 100 });
    });
  });
});
