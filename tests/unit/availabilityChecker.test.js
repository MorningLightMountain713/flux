'use strict';

// Set NODE_CONFIG_DIR before any requires
if (!process.env.NODE_CONFIG_DIR) {
  process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;
}

const { expect } = require('chai');
const sinon = require('sinon');
// eslint-disable-next-line no-unused-vars
const axios = require('axios');
const config = require('config');

const availabilityChecker = require('../../ZelBack/src/services/appMonitoring/availabilityChecker');
const nodeConfirmationService = require('../../ZelBack/src/services/nodeConfirmationService');
const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');
const deploymentProvider = require('../../ZelBack/src/services/appRuntime/deploymentProvider');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
// eslint-disable-next-line no-unused-vars
const verificationHelper = require('../../ZelBack/src/services/verificationHelper');
const daemonServiceMiscRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceMiscRpcs');
const upnpService = require('../../ZelBack/src/services/upnpService');
const networkStateService = require('../../ZelBack/src/services/networkStateService');
const {
  loadSpecLibrary, V8_SUBMISSION, instantiatedSpec, assertAnswers,
} = require('./fixtures/fluxSpec');

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
  });
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

  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(60000);
    flux = await loadSpecLibrary();
  });

  /**
   * deploymentProvider stays stubbed, so nothing here exercises what the real
   * one does with the InstantiatedSpec it is handed. buildDeployments reads
   * `.isEncrypted` and `.spec` (through resolveInstantiatedSpec), `.name` for
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
    expect(handed.isEncrypted, 'resolveInstantiatedSpec branches on this').to.be.a('boolean');
    expect(handed.identity, 'read off the row, never recomputed - it names every container')
      .to.satisfy((id) => id === null || typeof id === 'string');
    expect(handed.spec, 'resolveInstantiatedSpec returns this for a cleartext row').to.be.an('object');
    // resolveLocalReplicas asks the RESOLVED spec's placement for its mode
    // before it will build anything.
    assertAnswers(handed.spec.placement, ['mode', 'hasTargets']);
  }

  beforeEach(() => {
    listInstalledAppsStub = sinon.stub(appsRepository, 'listInstalledApps').resolves([]);
    buildDeploymentStub = sinon.stub(deploymentProvider, 'buildDeployment');
    // Delegates at call time so per-test overrides of buildDeployment flow
    // through the plural entry the checker uses.
    sinon.stub(deploymentProvider, 'buildDeployments').callsFake(async (inst) => {
      const deployment = await deploymentProvider.buildDeployment(inst);
      return deployment ? [deployment] : [];
    });
    mockDosState = {
      dosMessage: null,
      dosMountMessage: null,
      dosDuplicateAppMessage: null,
      dosStateValue: 0,
      testingPort: null,
      nextTestingPort: null,
      originalPortFailed: null,
      lastUPNPMapFailed: false,
    };
    mockPortsNotWorking = new Set();
    mockFailedNodesCache = new Map();
    waitMs = undefined;
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('checkMyAppsAvailability tests', () => {
    it('should delay and retry if DOS mount message present', async () => {
      mockDosState.dosMountMessage = 'Mount error detected';

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      expect(mockDosState.dosMessage).to.equal('Mount error detected');
      expect(mockDosState.dosStateValue).to.equal(100);
      expect(waitMs).to.equal(240_000);
    });

    it('should delay and retry if DOS duplicate app message present', async () => {
      mockDosState.dosDuplicateAppMessage = 'Duplicate app detected';

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      expect(mockDosState.dosMessage).to.equal('Duplicate app detected');
      expect(mockDosState.dosStateValue).to.equal(100);
    });

    it('should return early if daemon not synced', async () => {
      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: false },
      });

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      sinon.assert.notCalled(listInstalledAppsStub);
      expect(waitMs).to.equal(240_000);
    });

    it('should return early if node not confirmed', async () => {
      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(false);

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      sinon.assert.notCalled(listInstalledAppsStub);
    });

    it('should return early if no public IP found', async () => {
      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
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
      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
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
      const spec = multiPortSpec('App1', [30001, 30002, 30003]);
      const instantiated = await instantiatedSpec(spec);
      const deployment = deploymentOf(spec);
      // The ports are the library's, derived from the components, not a
      // fixture's claim about them.
      expect(deployment.allHostPorts()).to.deep.equal([30001, 30002, 30003]);

      listInstalledAppsStub.resolves([instantiated]);
      buildDeploymentStub.resolves(deployment);

      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      sinon.stub(networkStateService, 'getRandomSocketAddress').resolves(null);

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      sinon.assert.calledOnce(listInstalledAppsStub);
      sinon.assert.calledOnce(buildDeploymentStub);
      sinon.assert.calledWith(buildDeploymentStub, instantiated);
      assertBuildDeploymentGotARealSpec(spec);
      expect(waitMs).to.equal(240_000);
    });

    it('should skip banned ports', async () => {
      const apps = [];

      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
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

      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
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
      const spec = multiPortSpec('App1', [30001, 30002, 30003]);
      const instantiated = await instantiatedSpec(spec);
      listInstalledAppsStub.resolves([instantiated]);
      buildDeploymentStub.resolves(deploymentOf(spec));
      mockDosState.nextTestingPort = 30002;

      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      // Reached only if the "in use" branch does NOT fire, so leaving this
      // stubbed proves the branch by what it does not do.
      const peerPicker = sinon.stub(networkStateService, 'getRandomSocketAddress').resolves(null);

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      expect(mockDosState.testingPort).to.equal(30002);
      // timeouts.failure - the port belongs to an installed app, so it is not
      // probed at all.
      expect(waitMs).to.equal(15_000);
      sinon.assert.notCalled(peerPicker);
    });

    it('probes a port no installed app occupies', async () => {
      // The contrast that makes the case above non-vacuous: same apps, same
      // stubs, one port outside the set the real deployment reports. This one
      // gets as far as picking a peer.
      const spec = multiPortSpec('App1', [30001, 30002, 30003]);
      const instantiated = await instantiatedSpec(spec);
      listInstalledAppsStub.resolves([instantiated]);
      buildDeploymentStub.resolves(deploymentOf(spec));
      mockDosState.nextTestingPort = 30009;

      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      const peerPicker = sinon.stub(networkStateService, 'getRandomSocketAddress').resolves(null);

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      expect(mockDosState.testingPort).to.equal(30009);
      sinon.assert.calledOnce(peerPicker);
      expect(waitMs).to.equal(240_000);
    });

    it('keeps the ports of the apps it can resolve when one app cannot be built', async () => {
      // The per-app catch in the collection loop. An app whose spec will not
      // resolve - an encrypted one this node cannot decrypt - must not cost the
      // sweep the ports of every app after it, or the checker would probe a
      // port an app is listening on and DOS itself over the failure.
      const broken = multiPortSpec('BrokenApp', [30005]);
      const healthy = multiPortSpec('HealthyApp', [30002]);
      const brokenInstantiated = await instantiatedSpec(broken);
      const healthyInstantiated = await instantiatedSpec(healthy);
      listInstalledAppsStub.resolves([brokenInstantiated, healthyInstantiated]);
      // sinon's withArgs cannot tell two frozen InstantiatedSpec instances
      // apart, so the answer is keyed off an identity Map instead.
      const answers = new Map([[healthyInstantiated, deploymentOf(healthy)]]);
      buildDeploymentStub.callsFake(async (inst) => {
        const deployment = answers.get(inst);
        if (!deployment) throw new Error(`Could not resolve spec for ${inst.name}`);
        return deployment;
      });
      mockDosState.nextTestingPort = 30002;

      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      const peerPicker = sinon.stub(networkStateService, 'getRandomSocketAddress').resolves(null);

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

      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      listInstalledAppsStub.resolves(apps);
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      sinon.stub(networkStateService, 'getRandomSocketAddress').resolves(null);

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

      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      listInstalledAppsStub.resolves(apps);
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      sinon.stub(networkStateService, 'getRandomSocketAddress').resolves('192.168.1.200:16127');

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      expect(waitMs).to.equal(15_000);
    });

    it('should handle UPNP mapping failures', async () => {
      const apps = [];

      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      listInstalledAppsStub.resolves(apps);
      sinon.stub(upnpService, 'isUPNP').returns(true);
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      // The port under test is chosen at random from portMin..portMax, and the
      // test config bans 81-442 for UPNP - so leaving this unstubbed returns
      // early on roughly one run in 180 and never reaches the mapping at all.
      sinon.stub(fluxNetworkHelper, 'isPortUPNPBanned').returns(false);
      sinon.stub(networkStateService, 'getRandomSocketAddress').resolves('192.168.1.200:16127');
      sinon.stub(fluxNetworkHelper, 'isFirewallActive').resolves(true);
      sinon.stub(fluxNetworkHelper, 'allowPort').resolves();
      sinon.stub(upnpService, 'mapUpnpPort').resolves(false); // Failed
      sinon.stub(fluxNetworkHelper, 'deleteAllowPortRule').resolves();
      sinon.stub(upnpService, 'removeMapUpnpPort').resolves();

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      expect(mockDosState.lastUPNPMapFailed).to.be.true;
    });

    it('should increase DOS state on repeated UPNP failures', async () => {
      const apps = [];
      mockDosState.lastUPNPMapFailed = true; // Already failed once

      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      listInstalledAppsStub.resolves(apps);
      sinon.stub(upnpService, 'isUPNP').returns(true);
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      // Same randomness as above: unstubbed, a banned random port returns before
      // the mapping is ever attempted.
      sinon.stub(fluxNetworkHelper, 'isPortUPNPBanned').returns(false);
      sinon.stub(networkStateService, 'getRandomSocketAddress').resolves('192.168.1.200:16127');
      sinon.stub(fluxNetworkHelper, 'isFirewallActive').resolves(true);
      sinon.stub(fluxNetworkHelper, 'allowPort').resolves();
      sinon.stub(upnpService, 'mapUpnpPort').resolves(false);
      sinon.stub(fluxNetworkHelper, 'deleteAllowPortRule').resolves();
      sinon.stub(upnpService, 'removeMapUpnpPort').resolves();

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      expect(mockDosState.dosStateValue).to.equal(4);
    });

    it('should handle errors gracefully and retry', async () => {
      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').throws(new Error('Service error'));

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      expect(waitMs).to.equal(240_000);
    });

    it('should use random port from config range when nextTestingPort not set', async () => {
      const apps = [];

      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      listInstalledAppsStub.resolves(apps);
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      sinon.stub(networkStateService, 'getRandomSocketAddress').resolves(null);

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
      mockDosState.nextTestingPort = 30050;

      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      listInstalledAppsStub.resolves(apps);
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      sinon.stub(networkStateService, 'getRandomSocketAddress').resolves(null);

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      expect(mockDosState.testingPort).to.equal(30050);
    });
  });
});
