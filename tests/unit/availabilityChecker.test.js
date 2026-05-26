const { expect } = require('chai');
const sinon = require('sinon');
// eslint-disable-next-line no-unused-vars
const axios = require('axios');
const config = require('config');
const availabilityChecker = require('../../ZelBack/src/services/appMonitoring/availabilityChecker');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const generalService = require('../../ZelBack/src/services/generalService');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
// eslint-disable-next-line no-unused-vars
const verificationHelper = require('../../ZelBack/src/services/verificationHelper');
const daemonServiceMiscRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceMiscRpcs');
const upnpService = require('../../ZelBack/src/services/upnpService');
const networkStateService = require('../../ZelBack/src/services/networkStateService');
const deploymentProvider = require('../../ZelBack/src/services/appRuntime/deploymentProvider');

describe('availabilityChecker tests', () => {
  let mockDosState;
  let mockPortsNotWorking;
  let mockFailedNodesCache;
  let isArcane;
  let delayStub;
  let setImmediateStub;

  beforeEach(() => {
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
    isArcane = false;

    // Stub delay to prevent actual waiting
    delayStub = sinon.stub(serviceHelper, 'delay').resolves();
    // Stub setImmediate to prevent infinite recursion
    setImmediateStub = sinon.stub(global, 'setImmediate');
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('checkMyAppsAvailability tests', () => {
    it('should delay and retry if DOS mount message present', async () => {
      mockDosState.dosMountMessage = 'Mount error detected';

      await availabilityChecker.checkMyAppsAvailability(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
        isArcane,
      );

      expect(mockDosState.dosMessage).to.equal('Mount error detected');
      expect(mockDosState.dosStateValue).to.equal(100);
      sinon.assert.calledOnce(delayStub);
      sinon.assert.calledWith(delayStub, 240_000);
    });

    it('should delay and retry if DOS duplicate app message present', async () => {
      mockDosState.dosDuplicateAppMessage = 'Duplicate app detected';

      await availabilityChecker.checkMyAppsAvailability(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
        isArcane,
      );

      expect(mockDosState.dosMessage).to.equal('Duplicate app detected');
      expect(mockDosState.dosStateValue).to.equal(100);
    });

    it('should return early if daemon not synced', async () => {
      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: false },
      });

      await availabilityChecker.checkMyAppsAvailability(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
        isArcane,
      );

      sinon.assert.calledOnce(setImmediateStub);
      sinon.assert.calledWith(delayStub, 240_000);
    });

    it('should return early if node not confirmed', async () => {
      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(generalService, 'isNodeStatusConfirmed').resolves(false);

      await availabilityChecker.checkMyAppsAvailability(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
        isArcane,
      );

    });

    it('should return early if no public IP found', async () => {
      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(generalService, 'isNodeStatusConfirmed').resolves(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves(null);

      await availabilityChecker.checkMyAppsAvailability(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
        isArcane,
      );

    });

    it('should handle empty deployments list', async () => {
      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(generalService, 'isNodeStatusConfirmed').resolves(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves([]);
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      sinon.stub(fluxNetworkHelper, 'isPortUserBlocked').returns(false);
      sinon.stub(networkStateService, 'getRandomSocketAddress').resolves(null);

      await availabilityChecker.checkMyAppsAvailability(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
        isArcane,
      );

      sinon.assert.calledOnce(deploymentProvider.listInstalledDeployments);
    });

    it('should collect ports from single-port apps', async () => {
      const deployments = [
        { allHostPorts: () => [30001] },
      ];

      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(generalService, 'isNodeStatusConfirmed').resolves(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves(deployments);
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      sinon.stub(fluxNetworkHelper, 'isPortUserBlocked').returns(false);
      sinon.stub(networkStateService, 'getRandomSocketAddress').resolves(null);

      await availabilityChecker.checkMyAppsAvailability(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
        isArcane,
      );

      // Port should be skipped if it's in use
      sinon.assert.calledOnce(deploymentProvider.listInstalledDeployments);
    });

    it('should collect ports from multi-port apps', async () => {
      const deployments = [
        { allHostPorts: () => [30001, 30002, 30003] },
      ];

      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(generalService, 'isNodeStatusConfirmed').resolves(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves(deployments);
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      sinon.stub(fluxNetworkHelper, 'isPortUserBlocked').returns(false);
      sinon.stub(networkStateService, 'getRandomSocketAddress').resolves(null);

      await availabilityChecker.checkMyAppsAvailability(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
        isArcane,
      );

      sinon.assert.calledOnce(deploymentProvider.listInstalledDeployments);
    });

    it('should collect ports from multi-component apps', async () => {
      const deployments = [
        { allHostPorts: () => [30001, 30002, 30003] },
      ];

      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(generalService, 'isNodeStatusConfirmed').resolves(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves(deployments);
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      sinon.stub(fluxNetworkHelper, 'isPortUserBlocked').returns(false);
      sinon.stub(networkStateService, 'getRandomSocketAddress').resolves(null);

      await availabilityChecker.checkMyAppsAvailability(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
        isArcane,
      );

      sinon.assert.calledOnce(deploymentProvider.listInstalledDeployments);
    });

    it('should skip banned ports', async () => {
      const deployments = [];

      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(generalService, 'isNodeStatusConfirmed').resolves(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves(deployments);
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(true);
      sinon.stub(fluxNetworkHelper, 'isPortUserBlocked').returns(false);

      await availabilityChecker.checkMyAppsAvailability(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
        isArcane,
      );

      sinon.assert.calledWith(delayStub, 15_000);
    });

    it('should skip UPNP banned ports when UPNP enabled', async () => {
      const deployments = [];

      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(generalService, 'isNodeStatusConfirmed').resolves(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves(deployments);
      sinon.stub(upnpService, 'isUPNP').returns(true);
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      sinon.stub(fluxNetworkHelper, 'isPortUPNPBanned').returns(true);
      sinon.stub(fluxNetworkHelper, 'isPortUserBlocked').returns(false);

      await availabilityChecker.checkMyAppsAvailability(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
        isArcane,
      );

      sinon.assert.called(delayStub);
    });

    it('should skip user blocked ports', async () => {
      const deployments = [];

      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(generalService, 'isNodeStatusConfirmed').resolves(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves(deployments);
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      sinon.stub(fluxNetworkHelper, 'isPortUserBlocked').returns(true);

      await availabilityChecker.checkMyAppsAvailability(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
        isArcane,
      );

      sinon.assert.called(delayStub);
    });

    it('should skip ports already in use by apps', async () => {
      mockDosState.testingPort = 30001;
      const deployments = [
        { allHostPorts: () => [30001] },
      ];

      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(generalService, 'isNodeStatusConfirmed').resolves(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves(deployments);
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      sinon.stub(fluxNetworkHelper, 'isPortUserBlocked').returns(false);

      await availabilityChecker.checkMyAppsAvailability(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
        isArcane,
      );

      sinon.assert.called(delayStub);
    });

    it('should skip if remote socket address not available', async () => {
      const deployments = [];

      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(generalService, 'isNodeStatusConfirmed').resolves(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves(deployments);
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      sinon.stub(fluxNetworkHelper, 'isPortUserBlocked').returns(false);
      sinon.stub(networkStateService, 'getRandomSocketAddress').resolves(null);

      await availabilityChecker.checkMyAppsAvailability(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
        isArcane,
      );

      sinon.assert.calledWith(delayStub, 240_000);
    });

    it('should skip if remote node in failed cache', async () => {
      const deployments = [];
      mockFailedNodesCache.set('192.168.1.200:16127', '');

      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(generalService, 'isNodeStatusConfirmed').resolves(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves(deployments);
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      sinon.stub(fluxNetworkHelper, 'isPortUserBlocked').returns(false);
      sinon.stub(networkStateService, 'getRandomSocketAddress').resolves('192.168.1.200:16127');

      await availabilityChecker.checkMyAppsAvailability(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
        isArcane,
      );

      sinon.assert.calledWith(delayStub, 15_000);
    });

    it('should handle UPNP mapping failures', async () => {
      const deployments = [];

      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(generalService, 'isNodeStatusConfirmed').resolves(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves(deployments);
      sinon.stub(upnpService, 'isUPNP').returns(true);
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      sinon.stub(fluxNetworkHelper, 'isPortUserBlocked').returns(false);
      sinon.stub(networkStateService, 'getRandomSocketAddress').resolves('192.168.1.200:16127');
      sinon.stub(fluxNetworkHelper, 'isFirewallActive').resolves(true);
      sinon.stub(fluxNetworkHelper, 'allowPort').resolves();
      sinon.stub(upnpService, 'mapUpnpPort').resolves(false); // Failed
      sinon.stub(fluxNetworkHelper, 'deleteAllowPortRule').resolves();
      sinon.stub(upnpService, 'removeMapUpnpPort').resolves();

      await availabilityChecker.checkMyAppsAvailability(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
        isArcane,
      );

      expect(mockDosState.lastUPNPMapFailed).to.be.true;
    });

    it('should increase DOS state on repeated UPNP failures', async () => {
      const deployments = [];
      mockDosState.lastUPNPMapFailed = true; // Already failed once

      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(generalService, 'isNodeStatusConfirmed').resolves(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves(deployments);
      sinon.stub(upnpService, 'isUPNP').returns(true);
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      sinon.stub(fluxNetworkHelper, 'isPortUserBlocked').returns(false);
      sinon.stub(networkStateService, 'getRandomSocketAddress').resolves('192.168.1.200:16127');
      sinon.stub(fluxNetworkHelper, 'isFirewallActive').resolves(true);
      sinon.stub(fluxNetworkHelper, 'allowPort').resolves();
      sinon.stub(upnpService, 'mapUpnpPort').resolves(false);
      sinon.stub(fluxNetworkHelper, 'deleteAllowPortRule').resolves();
      sinon.stub(upnpService, 'removeMapUpnpPort').resolves();

      await availabilityChecker.checkMyAppsAvailability(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
        isArcane,
      );

      expect(mockDosState.dosStateValue).to.equal(4);
    });

    it('should handle errors gracefully and retry', async () => {
      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').throws(new Error('Service error'));

      await availabilityChecker.checkMyAppsAvailability(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
        isArcane,
      );

      sinon.assert.calledWith(delayStub, 240_000);
      sinon.assert.calledOnce(setImmediateStub);
    });

    it('should use random port from config range when nextTestingPort not set', async () => {
      const deployments = [];

      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(generalService, 'isNodeStatusConfirmed').resolves(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves(deployments);
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      sinon.stub(fluxNetworkHelper, 'isPortUserBlocked').returns(false);
      sinon.stub(networkStateService, 'getRandomSocketAddress').resolves(null);

      await availabilityChecker.checkMyAppsAvailability(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
        isArcane,
      );

      expect(mockDosState.testingPort).to.be.a('number');
      expect(mockDosState.testingPort).to.be.at.least(config.fluxapps.portMin);
      expect(mockDosState.testingPort).to.be.at.most(config.fluxapps.portMax);
    });

    it('should use nextTestingPort when set', async () => {
      const deployments = [];
      mockDosState.nextTestingPort = 30050;

      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        data: { synced: true },
      });
      sinon.stub(generalService, 'isNodeStatusConfirmed').resolves(true);
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.100:16127');
      sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves(deployments);
      sinon.stub(fluxNetworkHelper, 'isPortBanned').returns(false);
      sinon.stub(fluxNetworkHelper, 'isPortUserBlocked').returns(false);
      sinon.stub(networkStateService, 'getRandomSocketAddress').resolves(null);

      await availabilityChecker.checkMyAppsAvailability(
        mockDosState,
        mockPortsNotWorking,
        mockFailedNodesCache,
        isArcane,
      );

      expect(mockDosState.testingPort).to.equal(30050);
    });
  });
});
