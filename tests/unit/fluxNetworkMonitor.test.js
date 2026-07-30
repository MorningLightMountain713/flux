const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const fs = require('node:fs/promises');
const path = require('node:path');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const daemonServiceMiscRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceMiscRpcs');
const daemonServiceWalletRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceWalletRpcs');
const daemonServiceFluxnodeRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceFluxnodeRpcs');
const fluxCommunicationUtils = require('../../ZelBack/src/services/fluxCommunicationUtils');
const benchmarkService = require('../../ZelBack/src/services/benchmarkService');
const networkStateService = require('../../ZelBack/src/services/networkStateService');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const geolocationService = require('../../ZelBack/src/services/geolocationService');
const fluxNetworkMonitor = require('../../ZelBack/src/services/fluxNetworkMonitor');
const nodeDosState = require('../../ZelBack/src/services/nodeDosState');
const { requireMongo } = require('./dbTestHelper');

chai.use(chaiAsPromised);

describe('fluxNetworkMonitor tests', () => {
  // adjustExternalIP fires setNodeGeolocation() without awaiting it; left real it does
  // a live ip-api lookup that writes nondeterministic geolocation to the shared test DB
  // (polluting suites that read it) and self-reschedules a 10s retry that outlives the
  // test. Neutralise it for every real-module describe in this file.
  beforeEach(() => {
    sinon.stub(geolocationService, 'setNodeGeolocation').resolves();
  });

  describe('checkMyFluxAvailability tests', () => {
    let getRandomSocketAddress;

    before(requireMongo);

    beforeEach(() => {
      // checkMyFluxAvailability calls adjustExternalIP when the benchmark reports
      // a different public IP, and adjustExternalIP rewrites the node's real
      // config/userconfig.js. Unstubbed, these tests overwrite the developer's
      // own node configuration with fixture values.
      sinon.stub(fs, 'writeFile').resolves();
      fluxNetworkHelper.setStoredFluxBenchAllowed('6.2.0');
      fluxNetworkHelper.setLocalSocketAddress('129.3.3.3');
      const deterministicFluxnodeListResponse = [
        {
          collateral: 'COutPoint(38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174, 0)',
          txhash: '38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174',
          outidx: '0',
          ip: '129.1.1.1',
          network: '',
          added_height: 1076533,
          confirmed_height: 1076535,
          last_confirmed_height: 1079888,
          last_paid_height: 1077653,
          tier: 'CUMULUS',
          payment_address: 't1Z6mWoCrFC2g3iTCFdFkYdTfwtG84E3y2o',
          pubkey: '04378c8585d45861c8783f9c8cd0c85478164c12ce3fd13af1b44ebc8fe1ad6c786e92b211cb9566c596b6e2454d394a06bc44f748afb3c9ee48caa096d704abac',
          activesince: '1647197272',
          lastpaid: '1647333786',
          amount: '1000.00',
          rank: 0,
        },
      ];
      sinon.stub(fluxCommunicationUtils, 'deterministicFluxList').returns(deterministicFluxnodeListResponse);
      sinon.stub(daemonServiceWalletRpcs, 'createConfirmationTransaction').returns(true);
      sinon.stub(serviceHelper, 'delay').returns(true);
      getRandomSocketAddress = sinon.stub(networkStateService, 'getRandomSocketAddress');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return false if the flux bench version is lower than allowed', async () => {
      fluxNetworkHelper.setStoredFluxBenchAllowed('2.0.0');

      const result = await fluxNetworkMonitor.checkMyFluxAvailability();

      expect(result).to.be.false;
    });

    it('should return false if fluxIp is null', async () => {
      fluxNetworkHelper.setLocalSocketAddress(null);

      const result = await fluxNetworkMonitor.checkMyFluxAvailability();

      expect(result).to.be.false;
    });

    it('should return false if axsiosGet throws error', async () => {
      sinon.stub(serviceHelper, 'axiosGet').rejects();

      getRandomSocketAddress.resolves('1.2.3.4:16127');

      const result = await fluxNetworkMonitor.checkMyFluxAvailability();

      expect(result).to.be.false;
    });

    it('should return false if axsiosGet resolves null', async () => {
      sinon.stub(serviceHelper, 'axiosGet').resolves(null);

      getRandomSocketAddress.resolves('1.2.3.4:16127');

      const result = await fluxNetworkMonitor.checkMyFluxAvailability();

      expect(result).to.be.false;
    });

    it('should return true if axios status response is success', async () => {
      const axiosGetResponse = {
        data: {
          status: 'success',
          data: {
            message: 'all is good!',
          },
        },
      };

      getRandomSocketAddress.resolves('1.2.3.4:16127');
      sinon.stub(serviceHelper, 'axiosGet').resolves(axiosGetResponse);

      const result = await fluxNetworkMonitor.checkMyFluxAvailability();

      expect(result).to.be.true;
    });

    it('should return false if getPublicIp status is not a success', async () => {
      const getPublicIptResponse = {
        status: 'error',
      };
      sinon.stub(benchmarkService, 'getPublicIp').returns(getPublicIptResponse);
      const axiosGetResponse = {
        data: {
          status: 'error',
          data: {
            message: 'all is good!',
          },
        },
      };
      sinon.stub(serviceHelper, 'axiosGet').resolves(axiosGetResponse);

      const result = await fluxNetworkMonitor.checkMyFluxAvailability();

      expect(result).to.be.false;
    });

    it('should return true if getPublicIp status is a success and has a proper ip', async () => {
      const getPublicIptResponse = {
        status: 'success',
        data: '129.0.0.1',
      };
      sinon.stub(benchmarkService, 'getPublicIp').returns(getPublicIptResponse);
      const axiosGetResponse = {
        data: {
          status: 'error',
          data: {
            message: 'all is good!',
          },
        },
      };

      getRandomSocketAddress.resolves('1.2.3.4:16127');
      sinon.stub(serviceHelper, 'axiosGet').resolves(axiosGetResponse);

      const result = await fluxNetworkMonitor.checkMyFluxAvailability();

      expect(result).to.be.true;
    });

    it('should return false if getPublicIp status is a success but does not have a proper ip', async () => {
      const getPublicIptResponse = {
        status: 'success',
        data: '120',
      };
      sinon.stub(benchmarkService, 'getPublicIp').returns(getPublicIptResponse);
      const axiosGetResponse = {
        data: {
          status: 'error',
          data: {
            message: 'all is good!',
          },
        },
      };
      sinon.stub(serviceHelper, 'axiosGet').resolves(axiosGetResponse);

      const result = await fluxNetworkMonitor.checkMyFluxAvailability();

      expect(result).to.be.false;
    });
  });

  describe('adjustExternalIP tests', () => {
    let writeFileStub;
    let originalUserConfig;

    beforeEach(() => {
      writeFileStub = sinon.stub(fs, 'writeFile').resolves();
      // Writing a new IP also announces it on chain; unstubbed that is a real
      // RPC to the daemon port.
      sinon.stub(daemonServiceWalletRpcs, 'createConfirmationTransaction').returns(true);
      // Backup original userconfig
      originalUserConfig = globalThis.userconfig;
      // Mock userconfig with expected test values
      globalThis.userconfig = {
        initial: {
          ipaddress: '127.0.0.1',
          zelid: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
          kadena: 'kadena:3a2e6166907d0c2fb28a16cd6966a705de129e8358b9872d9cefe694e910d5b2?chainid=0',
          testnet: false,
          development: false,
          apiport: 16127,
          routerIP: '',
          pgpPrivateKey: '',
          pgpPublicKey: '',
          blockedPorts: [],
          blockedRepositories: [],
        },
      };
    });
    afterEach(() => {
      sinon.restore();
      // Restore original userconfig
      globalThis.userconfig = originalUserConfig;
    });

    it('should properly write a new ip to the config', async () => {
      const newIp = '127.0.0.66';
      const callPath = path.join(__dirname, '../../config/userconfig.js');

      await fluxNetworkMonitor.adjustExternalIP(newIp);

      sinon.assert.calledOnceWithMatch(writeFileStub, callPath, sinon.match(/module.exports = {/gm));
      sinon.assert.calledOnceWithMatch(writeFileStub, callPath, sinon.match(/initial: {/gm));
      sinon.assert.calledOnceWithMatch(writeFileStub, callPath, sinon.match(/ipaddress: '127.0.0.66',/gm));
      sinon.assert.calledOnceWithMatch(writeFileStub, callPath, sinon.match(/zelid: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',/gm));
      sinon.assert.calledOnceWithMatch(writeFileStub, callPath, sinon.match(/kadena: 'kadena:3a2e6166907d0c2fb28a16cd6966a705de129e8358b9872d9cefe694e910d5b2\?chainid=0',/gm));
      sinon.assert.calledOnceWithMatch(writeFileStub, callPath, sinon.match(/testnet: false,/gm));
      sinon.assert.calledOnceWithMatch(writeFileStub, callPath, sinon.match(/development: false,/gm));
      sinon.assert.calledOnceWithMatch(writeFileStub, callPath, sinon.match(/apiport: 16127,/gm));
      sinon.assert.calledOnceWithMatch(writeFileStub, callPath, sinon.match(/routerIP: '',/gm));
      sinon.assert.calledOnceWithMatch(writeFileStub, callPath, sinon.match(/pgpPrivateKey: ``,/gm));
      sinon.assert.calledOnceWithMatch(writeFileStub, callPath, sinon.match(/pgpPublicKey: ``,/gm));
    });

    it('should not write to file if the config already has same exact ip', async () => {
      const newIp = userconfig.initial.ipaddress;

      await fluxNetworkMonitor.adjustExternalIP(newIp);

      sinon.assert.notCalled(writeFileStub);
    });

    it('should not write to file if ip does not have a proper format', async () => {
      const newIp = '127111111';

      await fluxNetworkMonitor.adjustExternalIP(newIp);

      sinon.assert.notCalled(writeFileStub);
    });

    it('should not write to file if ip is not a string', async () => {
      const newIp = 121;

      await fluxNetworkMonitor.adjustExternalIP(newIp);

      sinon.assert.notCalled(writeFileStub);
    });

    it('should not write to file if ip is empty', async () => {
      const newIp = '';

      await fluxNetworkMonitor.adjustExternalIP(newIp);

      sinon.assert.notCalled(writeFileStub);
    });
  });

  describe('adjustExternalIP static IP app handling tests', () => {
    let writeFileStub;
    let originalUserConfig;
    let appQueryServiceStub;
    let registryManagerStub;
    let appUninstallerStub;
    let appControllerStub;
    let specCutoverStub;
    let geolocationServiceStub;
    let fluxCommunicationMessagesSenderStub;

    beforeEach(() => {
      writeFileStub = sinon.stub(fs, 'writeFile').resolves();

      // Backup original userconfig
      originalUserConfig = globalThis.userconfig;

      // Mock userconfig with expected test values
      globalThis.userconfig = {
        initial: {
          ipaddress: '127.0.0.1',
          zelid: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
          kadena: '',
          testnet: false,
          development: false,
          apiport: 16127,
          routerIP: '',
          pgpPrivateKey: '',
          pgpPublicKey: '',
          blockedPorts: [],
          blockedRepositories: [],
        },
      };

      // Stub daemonServiceWalletRpcs
      sinon.stub(daemonServiceWalletRpcs, 'createConfirmationTransaction').resolves({ status: 'success' });

      // Stub serviceHelper.delay
      sinon.stub(serviceHelper, 'delay').resolves();

      // Stub fluxNetworkHelper internal functions
      fluxNetworkHelper.setStoredFluxBenchAllowed('6.2.0');
      fluxNetworkHelper.setLocalSocketAddress('127.0.0.1');
    });

    afterEach(() => {
      sinon.restore();
      globalThis.userconfig = originalUserConfig;
    });

    it('should uninstall apps requiring static IP when IP changes', async () => {
      const newIp = '192.168.1.100';

      // Mock installed apps with staticip requirement
      const mockApps = {
        status: 'success',
        data: [
          { name: 'staticApp', version: 7, staticip: true },
          { name: 'normalApp', version: 7, staticip: false },
        ],
      };

      // Stub appQueryService
      appQueryServiceStub = {
        installedApps: sinon.stub().resolves(mockApps),
      };

      // Stub registryManager
      registryManagerStub = {
        appLocation: sinon.stub().resolves([]),
      };

      // Stub appUninstaller
      appUninstallerStub = {
        uninstallApplication: sinon.stub().resolves(),
      };

      // Stub appController
      appControllerStub = {
        requestAppRestart: sinon.stub().resolves(),
      };

      // Stub specCutover
      specCutoverStub = {
        resolveSpec: sinon.stub().callsFake((app) => Promise.resolve(app)),
      };

      // Stub geolocationService
      geolocationServiceStub = {
        setNodeGeolocation: sinon.stub(),
      };

      // Stub fluxCommunicationMessagesSender
      fluxCommunicationMessagesSenderStub = {
        broadcastMessageToOutgoing: sinon.stub().resolves(),
        broadcastMessageToIncoming: sinon.stub().resolves(),
      };

      // Use proxyquire to inject stubs
      const fluxNetworkMonitorWithStubs = proxyquire('../../ZelBack/src/services/fluxNetworkMonitor', {
        './appQuery/appQueryService': appQueryServiceStub,
        './appDatabase/registryManager': registryManagerStub,
        './appLifecycle/appUninstaller': appUninstallerStub,
        './appManagement/appController': appControllerStub,
        './utils/specCutover': specCutoverStub,
        './geolocationService': geolocationServiceStub,
        './fluxCommunicationMessagesSender': fluxCommunicationMessagesSenderStub,
        './daemonService/daemonServiceWalletRpcs': daemonServiceWalletRpcs,
        './serviceHelper': serviceHelper,
        'node:fs/promises': { writeFile: writeFileStub },
      });

      await fluxNetworkMonitorWithStubs.adjustExternalIP(newIp);

      // Verify static IP app was uninstalled
      sinon.assert.calledOnce(appUninstallerStub.uninstallApplication);
      sinon.assert.calledWith(appUninstallerStub.uninstallApplication, 'staticApp');

      // Verify normal app was restarted (not uninstalled)
      sinon.assert.calledOnce(appControllerStub.requestAppRestart);
      sinon.assert.calledWith(appControllerStub.requestAppRestart, 'normalApp');

      // Verify geolocation service was called
      sinon.assert.calledOnce(geolocationServiceStub.setNodeGeolocation);
    });

    it('should decrypt enterprise app specs before checking staticip requirement', async () => {
      const newIp = '192.168.1.101';

      // Mock installed enterprise app with encrypted specs
      const mockApps = {
        status: 'success',
        data: [
          { name: 'enterpriseApp', version: 8, enterprise: 'encrypted_data' },
        ],
      };

      appQueryServiceStub = {
        installedApps: sinon.stub().resolves(mockApps),
      };

      registryManagerStub = {
        appLocation: sinon.stub().resolves([]),
      };

      appUninstallerStub = {
        uninstallApplication: sinon.stub().resolves(),
      };

      appControllerStub = {
        requestAppRestart: sinon.stub().resolves(),
      };

      // Stub specCutover to return decrypted specs with staticip: true
      specCutoverStub = {
        resolveSpec: sinon.stub().resolves({
          name: 'enterpriseApp',
          version: 8,
          enterprise: 'encrypted_data',
          staticip: true,
        }),
      };

      geolocationServiceStub = {
        setNodeGeolocation: sinon.stub(),
      };

      fluxCommunicationMessagesSenderStub = {
        broadcastMessageToOutgoing: sinon.stub().resolves(),
        broadcastMessageToIncoming: sinon.stub().resolves(),
      };

      const fluxNetworkMonitorWithStubs = proxyquire('../../ZelBack/src/services/fluxNetworkMonitor', {
        './appQuery/appQueryService': appQueryServiceStub,
        './appDatabase/registryManager': registryManagerStub,
        './appLifecycle/appUninstaller': appUninstallerStub,
        './appManagement/appController': appControllerStub,
        './utils/specCutover': specCutoverStub,
        './geolocationService': geolocationServiceStub,
        './fluxCommunicationMessagesSender': fluxCommunicationMessagesSenderStub,
        './daemonService/daemonServiceWalletRpcs': daemonServiceWalletRpcs,
        './serviceHelper': serviceHelper,
        'node:fs/promises': { writeFile: writeFileStub },
      });

      await fluxNetworkMonitorWithStubs.adjustExternalIP(newIp);

      // Verify enterprise helper was called to decrypt specs
      sinon.assert.calledOnce(specCutoverStub.resolveSpec);

      // Verify app was uninstalled due to staticip requirement
      sinon.assert.calledOnce(appUninstallerStub.uninstallApplication);
      sinon.assert.calledWith(appUninstallerStub.uninstallApplication, 'enterpriseApp');
    });

    it('should handle enterprise decryption failure gracefully', async () => {
      const newIp = '192.168.1.102';

      const mockApps = {
        status: 'success',
        data: [
          { name: 'enterpriseApp', version: 8, enterprise: 'encrypted_data', staticip: false },
        ],
      };

      appQueryServiceStub = {
        installedApps: sinon.stub().resolves(mockApps),
      };

      registryManagerStub = {
        appLocation: sinon.stub().resolves([]),
      };

      appUninstallerStub = {
        uninstallApplication: sinon.stub().resolves(),
      };

      appControllerStub = {
        requestAppRestart: sinon.stub().resolves(),
      };

      // Stub specCutover to throw error
      specCutoverStub = {
        resolveSpec: sinon.stub().rejects(new Error('Decryption failed')),
      };

      geolocationServiceStub = {
        setNodeGeolocation: sinon.stub(),
      };

      fluxCommunicationMessagesSenderStub = {
        broadcastMessageToOutgoing: sinon.stub().resolves(),
        broadcastMessageToIncoming: sinon.stub().resolves(),
      };

      const fluxNetworkMonitorWithStubs = proxyquire('../../ZelBack/src/services/fluxNetworkMonitor', {
        './appQuery/appQueryService': appQueryServiceStub,
        './appDatabase/registryManager': registryManagerStub,
        './appLifecycle/appUninstaller': appUninstallerStub,
        './appManagement/appController': appControllerStub,
        './utils/specCutover': specCutoverStub,
        './geolocationService': geolocationServiceStub,
        './fluxCommunicationMessagesSender': fluxCommunicationMessagesSenderStub,
        './daemonService/daemonServiceWalletRpcs': daemonServiceWalletRpcs,
        './serviceHelper': serviceHelper,
        'node:fs/promises': { writeFile: writeFileStub },
      });

      await fluxNetworkMonitorWithStubs.adjustExternalIP(newIp);

      // Should skip the app entirely when decryption fails - neither uninstall nor restart
      sinon.assert.notCalled(appUninstallerStub.uninstallApplication);
      sinon.assert.notCalled(appControllerStub.requestAppRestart);
    });

    it('should not uninstall v6 apps even with staticip field', async () => {
      const newIp = '192.168.1.103';

      const mockApps = {
        status: 'success',
        data: [
          { name: 'oldApp', version: 6, staticip: true },
        ],
      };

      appQueryServiceStub = {
        installedApps: sinon.stub().resolves(mockApps),
      };

      registryManagerStub = {
        appLocation: sinon.stub().resolves([]),
      };

      appUninstallerStub = {
        uninstallApplication: sinon.stub().resolves(),
      };

      appControllerStub = {
        requestAppRestart: sinon.stub().resolves(),
      };

      specCutoverStub = {
        resolveSpec: sinon.stub().callsFake((app) => Promise.resolve(app)),
      };

      geolocationServiceStub = {
        setNodeGeolocation: sinon.stub(),
      };

      fluxCommunicationMessagesSenderStub = {
        broadcastMessageToOutgoing: sinon.stub().resolves(),
        broadcastMessageToIncoming: sinon.stub().resolves(),
      };

      const fluxNetworkMonitorWithStubs = proxyquire('../../ZelBack/src/services/fluxNetworkMonitor', {
        './appQuery/appQueryService': appQueryServiceStub,
        './appDatabase/registryManager': registryManagerStub,
        './appLifecycle/appUninstaller': appUninstallerStub,
        './appManagement/appController': appControllerStub,
        './utils/specCutover': specCutoverStub,
        './geolocationService': geolocationServiceStub,
        './fluxCommunicationMessagesSender': fluxCommunicationMessagesSenderStub,
        './daemonService/daemonServiceWalletRpcs': daemonServiceWalletRpcs,
        './serviceHelper': serviceHelper,
        'node:fs/promises': { writeFile: writeFileStub },
      });

      await fluxNetworkMonitorWithStubs.adjustExternalIP(newIp);

      // v6 apps should not be checked for staticip (only v7+)
      sinon.assert.notCalled(appUninstallerStub.uninstallApplication);
      sinon.assert.calledOnce(appControllerStub.requestAppRestart);
    });
  });

  describe('checkDeterministicNodesCollisions tests', () => {
    let getBenchmarksStub;
    let isDaemonSyncedStub;
    let deterministicFluxListStub;
    let getFluxNodeStatusStub;
    let deterministicFluxnodeListResponse;

    beforeEach(() => {
      fluxNetworkHelper.setStoredFluxBenchAllowed('6.2.0');
      fluxNetworkHelper.setLocalSocketAddress('129.3.3.3');
      sinon.stub(daemonServiceWalletRpcs, 'createConfirmationTransaction').returns(true);
      sinon.stub(serviceHelper, 'delay').returns(true);
      // The collision path probes the other node's /flux/version over HTTP; the
      // fixture IPs below are addresses this test must never actually dial.
      sinon.stub(serviceHelper, 'axiosGet').rejects(new Error('unreachable'));
      sinon.stub(fluxCommunicationUtils, 'socketAddressInFluxList').resolves(true);
      deterministicFluxnodeListResponse = [
        {
          collateral: 'COutPoint(38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174, 0)',
          txhash: '38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174',
          outidx: '0',
          ip: '127.0.0.1:5050',
          network: '',
          added_height: 1076533,
          confirmed_height: 1076535,
          last_confirmed_height: 1079888,
          last_paid_height: 1077653,
          tier: 'CUMULUS',
          payment_address: 't1Z6mWoCrFC2g3iTCFdFkYdTfwtG84E3y2o',
          pubkey: '04378c8585d45861c8783f9c8cd0c85478164c12ce3fd13af1b44ebc8fe1ad6c786e92b211cb9566c596b6e2454d394a06bc44f748afb3c9ee48caa096d704abac',
          activesince: '1647197272',
          lastpaid: '1647333786',
          amount: '1000.00',
          rank: 0,
        }];
      getBenchmarksStub = sinon.stub(benchmarkService, 'getBenchmarks');
      isDaemonSyncedStub = sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced');
      deterministicFluxListStub = sinon.stub(fluxCommunicationUtils, 'deterministicFluxList');
      getFluxNodeStatusStub = sinon.stub(daemonServiceFluxnodeRpcs, 'getFluxNodeStatus');
      nodeDosState.setDosMessage(null);
      nodeDosState.setDosStateValue(0);
    });

    afterEach(() => {
      sinon.restore();
      fluxNetworkHelper.setLocalSocketAddress(null);
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should not change dosMessage', async () => {
      const ip = '127.0.0.1:5050';
      const getBenchmarkResponseData = {
        status: 'success',
        data: { ipaddress: ip },
      };
      getBenchmarksStub.resolves(getBenchmarkResponseData);
      isDaemonSyncedStub.returns({ data: { synced: true } });
      deterministicFluxListStub.returns(deterministicFluxnodeListResponse);
      getFluxNodeStatusStub.returns(
        {
          status: 'success',
          data: {
            status: 'CONFIRMED',
            collateral: 'COutPoint(38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174, 0)',
          },
        },
      );

      await fluxNetworkMonitor.checkDeterministicNodesCollisions();

      expect(nodeDosState.getDosMessage()).to.be.null;
      expect(nodeDosState.getDosStateValue()).to.equal(0);
    });

    it('should skip availability check when node status is not CONFIRMED', async () => {
      const ip = '127.0.0.1:5050';
      const getBenchmarkResponseData = {
        status: 'success',
        data: { ipaddress: ip },
      };
      getBenchmarksStub.resolves(getBenchmarkResponseData);
      isDaemonSyncedStub.returns({ data: { synced: true } });
      // Node is not in the deterministic list (expired)
      deterministicFluxListStub.returns([]);
      getFluxNodeStatusStub.returns(
        {
          status: 'success',
          data: {
            status: 'expired',
            collateral: 'COutPoint(38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174, 0)',
          },
        },
      );

      await fluxNetworkMonitor.checkDeterministicNodesCollisions();

      // Node is expired and not in list — availability check is skipped, no DOS penalty
      expect(nodeDosState.getDosMessage()).to.be.null;
      expect(nodeDosState.getDosStateValue()).to.equal(0);
    });

    it('should skip availability check when IP is not in confirmed flux list', async () => {
      const ip = '127.0.0.1:5050';
      const getBenchmarkResponseData = {
        status: 'success',
        data: { ipaddress: ip },
      };
      getBenchmarksStub.resolves(getBenchmarkResponseData);
      isDaemonSyncedStub.returns({ data: { synced: true } });
      deterministicFluxListStub.returns(deterministicFluxnodeListResponse);
      getFluxNodeStatusStub.returns(
        {
          status: 'success',
          data: {
            status: 'CONFIRMED',
            collateral: 'COutPoint(38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174, 0)',
          },
        },
      );
      // Our IP changed and is not in the confirmed list
      fluxCommunicationUtils.socketAddressInFluxList.resolves(false);

      await fluxNetworkMonitor.checkDeterministicNodesCollisions();

      // CONFIRMED but IP not in list — availability check is skipped, no DOS penalty
      expect(nodeDosState.getDosMessage()).to.be.null;
      expect(nodeDosState.getDosStateValue()).to.equal(0);
    });

    it('should find the same node instances and warn about earlier collision detection', async () => {
      const multipleNodesList = [
        deterministicFluxnodeListResponse[0],
        {
          collateral: 'COutPoint(38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174, 0)',
          txhash: '38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174',
          outidx: '0',
          ip: '127.0.0.1:5050',
          network: '',
          added_height: 1076533,
          confirmed_height: 1076535,
          last_confirmed_height: 1079888,
          last_paid_height: 1077653,
          tier: 'CUMULUS',
          payment_address: 't1Z6mWoCrFC2g3iTCFdFkYdTfwtG84E3y2o',
          pubkey: '04378c8585d45861c8783f9c8cd0c85478164c12ce3fd13af1b44ebc8fe1ad6c786e92b211cb9566c596b6e2454d394a06bc44f748afb3c9ee48caa096d704abac',
          activesince: '1647197272',
          lastpaid: '1647333786',
          amount: '1000.00',
          rank: 0,
        },
      ];
      const ip = '127.0.0.1:5050';
      fluxNetworkHelper.setLocalSocketAddress(ip);
      const getBenchmarkResponseData = {
        status: 'success',
        data: { ipaddress: ip },
      };
      getBenchmarksStub.resolves(getBenchmarkResponseData);
      isDaemonSyncedStub.returns({ data: { synced: true } });
      deterministicFluxListStub.returns(multipleNodesList);
      getFluxNodeStatusStub.returns(
        {
          status: 'success',
          data: {
            collateral: 'COutPoint(38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174, 0)',
          },
        },
      );

      await fluxNetworkMonitor.checkDeterministicNodesCollisions();

      expect(nodeDosState.getDosMessage()).to.equal('Flux earlier collision detection on ip:127.0.0.1:5050');
      expect(nodeDosState.getDosStateValue()).to.equal(100);
    });

    it('should trigger collision detection if the collateral is not matching', async () => {
      const ip = '127.0.0.1:5050';
      fluxNetworkHelper.setLocalSocketAddress(ip);
      const getBenchmarkResponseData = {
        status: 'success',
        data: { ipaddress: ip },
      };
      getBenchmarksStub.resolves(getBenchmarkResponseData);
      isDaemonSyncedStub.returns({ data: { synced: true } });
      deterministicFluxListStub.returns(deterministicFluxnodeListResponse);
      getFluxNodeStatusStub.returns(
        {
          status: 'success',
          data: {
            collateral: 'COutPoint(38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e123556, 0)',
          },
        },
      );

      await fluxNetworkMonitor.checkDeterministicNodesCollisions();

      expect(nodeDosState.getDosMessage()).to.equal('Flux collision detection. Another ip:port is confirmed on flux network with the same collateral transaction information.');
      expect(nodeDosState.getDosStateValue()).to.equal(100);
    });

    it('should trigger collision detection when same collateral exists on different IP and other node is reachable', async () => {
      const myIp = '192.168.1.100:16127';
      const otherIp = '192.168.1.200:16127';
      fluxNetworkHelper.setLocalSocketAddress(myIp);
      const sharedCollateral = 'COutPoint(38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174, 0)';
      const nodeListWithDifferentIp = [
        {
          collateral: sharedCollateral,
          txhash: '38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174',
          outidx: '0',
          ip: myIp,
          network: '',
          added_height: 1076533,
          confirmed_height: 1076535,
          last_confirmed_height: 1079888,
          last_paid_height: 1077653,
          tier: 'CUMULUS',
          payment_address: 't1Z6mWoCrFC2g3iTCFdFkYdTfwtG84E3y2o',
          pubkey: '04378c8585d45861c8783f9c8cd0c85478164c12ce3fd13af1b44ebc8fe1ad6c786e92b211cb9566c596b6e2454d394a06bc44f748afb3c9ee48caa096d704abac',
          activesince: '1647197272',
          lastpaid: '1647333786',
          amount: '1000.00',
          rank: 0,
        },
        {
          collateral: sharedCollateral,
          txhash: '38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174',
          outidx: '0',
          ip: otherIp,
          network: '',
          added_height: 1076533,
          confirmed_height: 1076535,
          last_confirmed_height: 1079888,
          last_paid_height: 1077653,
          tier: 'CUMULUS',
          payment_address: 't1Z6mWoCrFC2g3iTCFdFkYdTfwtG84E3y2o',
          pubkey: '04378c8585d45861c8783f9c8cd0c85478164c12ce3fd13af1b44ebc8fe1ad6c786e92b211cb9566c596b6e2454d394a06bc44f748afb3c9ee48caa096d704abac',
          activesince: '1647197272',
          lastpaid: '1647333786',
          amount: '1000.00',
          rank: 0,
        },
      ];
      const getBenchmarkResponseData = {
        status: 'success',
        data: { ipaddress: myIp },
      };
      getBenchmarksStub.resolves(getBenchmarkResponseData);
      isDaemonSyncedStub.returns({ data: { synced: true } });
      deterministicFluxListStub.returns(nodeListWithDifferentIp);
      getFluxNodeStatusStub.returns({
        status: 'success',
        data: {
          status: 'CONFIRMED',
          collateral: sharedCollateral,
        },
      });

      // Mock successful axios call - other node is reachable
      const axiosGetStub = serviceHelper.axiosGet.resolves({ data: { version: '6.0.0' } });

      await fluxNetworkMonitor.checkDeterministicNodesCollisions();

      expect(axiosGetStub.calledOnce).to.be.true;
      expect(axiosGetStub.firstCall.args[0]).to.include('192.168.1.200:16127');
      expect(nodeDosState.getDosMessage()).to.include('Node at 192.168.1.200:16127 is confirmed and reachable');
      expect(nodeDosState.getDosStateValue()).to.equal(100);
    });

    it('should take over collateral when same collateral exists on different IP and other node is unreachable after grace period', async () => {
      const myIp = '192.168.1.100:16127';
      const otherIp = '192.168.1.200:16127';
      fluxNetworkHelper.setLocalSocketAddress(myIp);
      const sharedCollateral = 'COutPoint(38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174, 0)';
      const nodeListWithDifferentIp = [
        {
          collateral: sharedCollateral,
          txhash: '38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174',
          outidx: '0',
          ip: myIp,
          network: '',
          added_height: 1076533,
          confirmed_height: 1076535,
          last_confirmed_height: 1079888,
          last_paid_height: 1077653,
          tier: 'CUMULUS',
          payment_address: 't1Z6mWoCrFC2g3iTCFdFkYdTfwtG84E3y2o',
          pubkey: '04378c8585d45861c8783f9c8cd0c85478164c12ce3fd13af1b44ebc8fe1ad6c786e92b211cb9566c596b6e2454d394a06bc44f748afb3c9ee48caa096d704abac',
          activesince: '1647197272',
          lastpaid: '1647333786',
          amount: '1000.00',
          rank: 0,
        },
        {
          collateral: sharedCollateral,
          txhash: '38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174',
          outidx: '0',
          ip: otherIp,
          network: '',
          added_height: 1076533,
          confirmed_height: 1076535,
          last_confirmed_height: 1079888,
          last_paid_height: 1077653,
          tier: 'CUMULUS',
          payment_address: 't1Z6mWoCrFC2g3iTCFdFkYdTfwtG84E3y2o',
          pubkey: '04378c8585d45861c8783f9c8cd0c85478164c12ce3fd13af1b44ebc8fe1ad6c786e92b211cb9566c596b6e2454d394a06bc44f748afb3c9ee48caa096d704abac',
          activesince: '1647197272',
          lastpaid: '1647333786',
          amount: '1000.00',
          rank: 0,
        },
      ];
      const getBenchmarkResponseData = {
        status: 'success',
        data: { ipaddress: myIp },
      };
      getBenchmarksStub.resolves(getBenchmarkResponseData);
      isDaemonSyncedStub.returns({ data: { synced: true } });
      deterministicFluxListStub.returns(nodeListWithDifferentIp);
      getFluxNodeStatusStub.returns({
        status: 'success',
        data: {
          status: 'CONFIRMED',
          collateral: sharedCollateral,
        },
      });

      // Mock axios to fail (other node unreachable) on both calls
      const axiosGetStub = serviceHelper.axiosGet.rejects(new Error('Connection refused'));

      await fluxNetworkMonitor.checkDeterministicNodesCollisions();

      expect(axiosGetStub.calledTwice).to.be.true;
      // DOS state should remain clear since we successfully took over
      expect(nodeDosState.getDosStateValue()).to.equal(0);
    });

    it('should handle case when other node comes back online during grace period', async () => {
      const myIp = '192.168.1.100:16127';
      const otherIp = '192.168.1.200:16127';
      fluxNetworkHelper.setLocalSocketAddress(myIp);
      const sharedCollateral = 'COutPoint(38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174, 0)';
      const nodeListWithDifferentIp = [
        {
          collateral: sharedCollateral,
          txhash: '38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174',
          outidx: '0',
          ip: myIp,
          network: '',
          added_height: 1076533,
          confirmed_height: 1076535,
          last_confirmed_height: 1079888,
          last_paid_height: 1077653,
          tier: 'CUMULUS',
          payment_address: 't1Z6mWoCrFC2g3iTCFdFkYdTfwtG84E3y2o',
          pubkey: '04378c8585d45861c8783f9c8cd0c85478164c12ce3fd13af1b44ebc8fe1ad6c786e92b211cb9566c596b6e2454d394a06bc44f748afb3c9ee48caa096d704abac',
          activesince: '1647197272',
          lastpaid: '1647333786',
          amount: '1000.00',
          rank: 0,
        },
        {
          collateral: sharedCollateral,
          txhash: '38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174',
          outidx: '0',
          ip: otherIp,
          network: '',
          added_height: 1076533,
          confirmed_height: 1076535,
          last_confirmed_height: 1079888,
          last_paid_height: 1077653,
          tier: 'CUMULUS',
          payment_address: 't1Z6mWoCrFC2g3iTCFdFkYdTfwtG84E3y2o',
          pubkey: '04378c8585d45861c8783f9c8cd0c85478164c12ce3fd13af1b44ebc8fe1ad6c786e92b211cb9566c596b6e2454d394a06bc44f748afb3c9ee48caa096d704abac',
          activesince: '1647197272',
          lastpaid: '1647333786',
          amount: '1000.00',
          rank: 0,
        },
      ];
      const getBenchmarkResponseData = {
        status: 'success',
        data: { ipaddress: myIp },
      };
      getBenchmarksStub.resolves(getBenchmarkResponseData);
      isDaemonSyncedStub.returns({ data: { synced: true } });
      deterministicFluxListStub.returns(nodeListWithDifferentIp);
      getFluxNodeStatusStub.returns({
        status: 'success',
        data: {
          status: 'CONFIRMED',
          collateral: sharedCollateral,
        },
      });

      // Mock axios to fail first call but succeed on second (node comes back online)
      const axiosGetStub = serviceHelper.axiosGet;
      axiosGetStub.onFirstCall().rejects(new Error('Connection refused'));
      axiosGetStub.onSecondCall().resolves({ data: { version: '6.0.0' } });

      await fluxNetworkMonitor.checkDeterministicNodesCollisions();

      expect(axiosGetStub.calledTwice).to.be.true;
      // DOS state should remain at 0 since this is not an error condition
      expect(nodeDosState.getDosStateValue()).to.equal(0);
    });
  });
});
