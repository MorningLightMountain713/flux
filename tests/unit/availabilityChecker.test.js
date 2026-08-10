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

describe('availabilityChecker tests', () => {
  let mockDosState;
  let mockPortsNotWorking;
  let mockFailedNodesCache;
  let waitMs;
  let listInstalledAppsStub;
  let buildDeploymentStub;

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
      const mockInstantiated = { name: 'App1' };
      listInstalledAppsStub.resolves([mockInstantiated]);
      buildDeploymentStub.resolves({ allHostPorts: () => [30001, 30002, 30003] });

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
      sinon.assert.calledWith(buildDeploymentStub, mockInstantiated);
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
      mockDosState.testingPort = 30001;
      const apps = [
        { name: 'App1', version: 3, ports: [30001] },
      ];

      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      listInstalledAppsStub.resolves(apps);
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);

      waitMs = await availabilityChecker.runAvailabilityCheckOnce(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
      );

      expect(waitMs).to.be.a('number');
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
