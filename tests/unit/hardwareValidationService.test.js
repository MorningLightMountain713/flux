const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('hardwareValidationService tests', () => {
  let hardwareValidationService;
  let logStub;
  let configStub;
  let appsRepositoryStub;
  let hwRequirementsStub;
  let appUninstallerStub;
  let serviceHelperStub;
  let deploymentProviderStub;

  beforeEach(() => {
    logStub = {
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
    };

    // Config stub - 4 CPU node (40 CPU units), 8GB RAM, 100GB storage
    configStub = {
      lockedSystemResources: {
        cpu: 10, // 1 CPU reserved
        ram: 2000, // 2GB reserved
        hdd: 10, // 10GB reserved
        extrahdd: 0,
      },
      fluxapps: {
        hddFileSystemMinimum: 5, // 5GB per app
        defaultSwap: 2, // 2GB swap per app
      },
    };

    appsRepositoryStub = {
      listInstalledApps: sinon.stub().resolves([]),
    };

    hwRequirementsStub = {
      getNodeSpecs: sinon.stub(),
    };

    appUninstallerStub = {
      uninstallApplication: sinon.stub().resolves(),
    };

    serviceHelperStub = {
      delay: sinon.stub().resolves(),
    };

    deploymentProviderStub = {
      getInstalledDeployment: sinon.stub().resolves(null),
    };

    hardwareValidationService = proxyquire('../../ZelBack/src/services/appLifecycle/hardwareValidationService', {
      '../../lib/log': logStub,
      config: configStub,
      '../appRequirements/hwRequirements': hwRequirementsStub,
      './appUninstaller': appUninstallerStub,
      '../serviceHelper': serviceHelperStub,
      '../appRuntime/deploymentProvider': deploymentProviderStub,
      '../appDatabase/appsRepository': appsRepositoryStub,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  function fakeDeployment(resources) {
    return { totalResources: () => resources };
  }

  describe('performBootTimeHardwareValidation', () => {
    it('should return empty results if no apps are installed', async () => {
      appsRepositoryStub.listInstalledApps.resolves([]);

      const result = await hardwareValidationService.performBootTimeHardwareValidation();

      expect(result).to.deep.equal({
        appsChecked: 0,
        appsRemoved: [],
        appsFailed: [],
      });
      expect(logStub.info.calledWith('hardwareValidationService - No installed apps found')).to.equal(true);
    });

    it('should not remove apps if all apps meet hardware requirements', async () => {
      const installedApps = [
        { name: 'app1', height: 1000 },
        { name: 'app2', height: 2000 },
      ];

      hwRequirementsStub.getNodeSpecs.resolves({
        cpuCores: 4,
        ram: 8192,
        ssdStorage: 100,
      });

      appsRepositoryStub.listInstalledApps.resolves(installedApps);
      deploymentProviderStub.getInstalledDeployment.resolves(fakeDeployment({ cpu: 1, memory: 1024, storage: 5 }));

      const result = await hardwareValidationService.performBootTimeHardwareValidation();

      expect(result.appsChecked).to.equal(2);
      expect(result.appsRemoved).to.have.length(0);
      expect(result.appsFailed).to.have.length(0);
      expect(logStub.info.calledWith('hardwareValidationService - All installed apps meet hardware requirements')).to.equal(true);
      expect(appUninstallerStub.uninstallApplication.called).to.equal(false);
    });

    it('should handle critical error gracefully', async () => {
      appsRepositoryStub.listInstalledApps.rejects(new Error('Database connection failed'));

      const result = await hardwareValidationService.performBootTimeHardwareValidation();

      expect(result).to.deep.equal({
        appsChecked: 0,
        appsRemoved: [],
        appsFailed: [],
      });
      expect(logStub.error.calledWith(sinon.match(/Critical error/))).to.equal(true);
    });
  });

  describe('validateAppsCumulatively', () => {
    it('should return empty array if all apps fit within capacity', async () => {
      const installedApps = [
        { name: 'app1', height: 1000 },
        { name: 'app2', height: 2000 },
      ];

      hwRequirementsStub.getNodeSpecs.resolves({
        cpuCores: 4,
        ram: 8192,
        ssdStorage: 100,
      });

      deploymentProviderStub.getInstalledDeployment.resolves(fakeDeployment({ cpu: 1, memory: 1024, storage: 5 }));

      const result = await hardwareValidationService.validateAppsCumulatively(installedApps);

      expect(result).to.have.length(0);
    });

    it('should remove app that individually exceeds CPU capacity', async () => {
      const installedApps = [
        { name: 'bigApp', height: 1000 },
      ];

      hwRequirementsStub.getNodeSpecs.resolves({
        cpuCores: 4,
        ram: 8192,
        ssdStorage: 100,
      });

      deploymentProviderStub.getInstalledDeployment.resolves(fakeDeployment({ cpu: 5, memory: 1024, storage: 5 }));

      const result = await hardwareValidationService.validateAppsCumulatively(installedApps);

      expect(result).to.have.length(1);
      expect(result[0].name).to.equal('bigApp');
      expect(result[0].reason).to.include('requires 5 CPU');
    });

    it('should remove app that individually exceeds RAM capacity', async () => {
      const installedApps = [
        { name: 'bigApp', height: 1000 },
      ];

      hwRequirementsStub.getNodeSpecs.resolves({
        cpuCores: 4,
        ram: 8192,
        ssdStorage: 100,
      });

      deploymentProviderStub.getInstalledDeployment.resolves(fakeDeployment({ cpu: 1, memory: 7168, storage: 5 }));

      const result = await hardwareValidationService.validateAppsCumulatively(installedApps);

      expect(result).to.have.length(1);
      expect(result[0].name).to.equal('bigApp');
      expect(result[0].reason).to.include('requires 7168MB RAM');
    });

    it('should remove app that individually exceeds storage capacity', async () => {
      const installedApps = [
        { name: 'bigApp', height: 1000 },
      ];

      hwRequirementsStub.getNodeSpecs.resolves({
        cpuCores: 4,
        ram: 8192,
        ssdStorage: 100,
      });

      deploymentProviderStub.getInstalledDeployment.resolves(fakeDeployment({ cpu: 1, memory: 1024, storage: 80 }));

      const result = await hardwareValidationService.validateAppsCumulatively(installedApps);

      expect(result).to.have.length(1);
      expect(result[0].name).to.equal('bigApp');
      expect(result[0].reason).to.include('requires 87GB storage');
    });

    it('should remove newer apps when cumulative CPU exceeds capacity', async () => {
      const installedApps = [
        { name: 'app1', height: 1000 },
        { name: 'app2', height: 2000 },
      ];

      hwRequirementsStub.getNodeSpecs.resolves({
        cpuCores: 4,
        ram: 8192,
        ssdStorage: 100,
      });

      deploymentProviderStub.getInstalledDeployment.resolves(fakeDeployment({ cpu: 2, memory: 1024, storage: 5 }));

      const result = await hardwareValidationService.validateAppsCumulatively(installedApps);

      expect(result).to.have.length(1);
      expect(result[0].name).to.equal('app2');
      expect(result[0].reason).to.include('Cumulative CPU limit exceeded');
    });

    it('should remove newer apps when cumulative RAM exceeds capacity', async () => {
      const installedApps = [
        { name: 'app1', height: 1000 },
        { name: 'app2', height: 2000 },
      ];

      hwRequirementsStub.getNodeSpecs.resolves({
        cpuCores: 4,
        ram: 8192,
        ssdStorage: 100,
      });

      deploymentProviderStub.getInstalledDeployment.resolves(fakeDeployment({ cpu: 1, memory: 4096, storage: 5 }));

      const result = await hardwareValidationService.validateAppsCumulatively(installedApps);

      expect(result).to.have.length(1);
      expect(result[0].name).to.equal('app2');
      expect(result[0].reason).to.include('Cumulative RAM limit exceeded');
    });

    it('should remove newer apps when cumulative storage exceeds capacity', async () => {
      const installedApps = [
        { name: 'app1', height: 1000 },
        { name: 'app2', height: 2000 },
      ];

      hwRequirementsStub.getNodeSpecs.resolves({
        cpuCores: 4,
        ram: 8192,
        ssdStorage: 100,
      });

      deploymentProviderStub.getInstalledDeployment.resolves(fakeDeployment({ cpu: 1, memory: 1024, storage: 40 }));

      const result = await hardwareValidationService.validateAppsCumulatively(installedApps);

      expect(result).to.have.length(1);
      expect(result[0].name).to.equal('app2');
      expect(result[0].reason).to.include('Cumulative storage limit exceeded');
    });

    it('should sort apps by height and keep oldest apps', async () => {
      const installedApps = [
        { name: 'newestApp', height: 3000 },
        { name: 'oldestApp', height: 1000 },
        { name: 'middleApp', height: 2000 },
      ];

      hwRequirementsStub.getNodeSpecs.resolves({
        cpuCores: 4,
        ram: 8192,
        ssdStorage: 100,
      });

      deploymentProviderStub.getInstalledDeployment.resolves(fakeDeployment({ cpu: 1.5, memory: 1024, storage: 5 }));

      const result = await hardwareValidationService.validateAppsCumulatively(installedApps);

      expect(result).to.have.length(1);
      expect(result[0].name).to.equal('newestApp');
      expect(result[0].height).to.equal(3000);
    });

    it('should handle apps with missing height field (treat as 0)', async () => {
      const installedApps = [
        { name: 'app1' },
        { name: 'app2', height: 1000 },
      ];

      hwRequirementsStub.getNodeSpecs.resolves({
        cpuCores: 4,
        ram: 8192,
        ssdStorage: 100,
      });

      deploymentProviderStub.getInstalledDeployment.resolves(fakeDeployment({ cpu: 1, memory: 1024, storage: 5 }));

      const result = await hardwareValidationService.validateAppsCumulatively(installedApps);

      expect(result).to.have.length(0);
    });

    it('should skip app if deployment is not found', async () => {
      const installedApps = [
        { name: 'app1', height: 1000 },
        { name: 'app2', height: 2000 },
      ];

      hwRequirementsStub.getNodeSpecs.resolves({
        cpuCores: 4,
        ram: 8192,
        ssdStorage: 100,
      });

      deploymentProviderStub.getInstalledDeployment.onFirstCall().resolves(null);
      deploymentProviderStub.getInstalledDeployment.onSecondCall().resolves(fakeDeployment({ cpu: 1, memory: 1024, storage: 5 }));

      const result = await hardwareValidationService.validateAppsCumulatively(installedApps);

      expect(result).to.have.length(0);
      expect(logStub.warn.calledWith('hardwareValidationService - No deployment found for app1, skipping')).to.equal(true);
    });

    it('should return empty array if storage is 0', async () => {
      const installedApps = [
        { name: 'app1', height: 1000 },
      ];

      hwRequirementsStub.getNodeSpecs.resolves({
        cpuCores: 4,
        ram: 8192,
        ssdStorage: 0,
      });

      const result = await hardwareValidationService.validateAppsCumulatively(installedApps);

      expect(result).to.have.length(0);
      expect(logStub.error.calledWith(sinon.match(/No storage detected/))).to.equal(true);
    });
  });

  describe('removeNonCompliantApps', () => {
    it('should return empty results if no apps to remove', async () => {
      const result = await hardwareValidationService.removeNonCompliantApps([]);

      expect(result).to.deep.equal({
        removed: [],
        failed: [],
      });
      expect(appUninstallerStub.uninstallApplication.called).to.equal(false);
    });

    it('should successfully remove a single app', async () => {
      const appsToRemove = [
        { name: 'app1', reason: 'CPU requirements not met', height: 1000 },
      ];

      appUninstallerStub.uninstallApplication.resolves();

      const result = await hardwareValidationService.removeNonCompliantApps(appsToRemove);

      expect(result.removed).to.have.length(1);
      expect(result.removed[0]).to.equal('app1');
      expect(result.failed).to.have.length(0);
      expect(logStub.warn.calledWith(sinon.match(/REMOVAL REASON: Hardware downgrade - app1/))).to.equal(true);
      expect(logStub.info.calledWith(sinon.match(/Successfully removed app1/))).to.equal(true);
      expect(appUninstallerStub.uninstallApplication.firstCall.args[0]).to.equal('app1');
    });

    it('should successfully remove multiple apps', async () => {
      const appsToRemove = [
        { name: 'app1', reason: 'CPU requirements not met', height: 1000 },
        { name: 'app2', reason: 'RAM requirements not met', height: 2000 },
        { name: 'app3', reason: 'Storage requirements not met', height: 3000 },
      ];

      appUninstallerStub.uninstallApplication.resolves();

      const result = await hardwareValidationService.removeNonCompliantApps(appsToRemove);

      expect(result.removed).to.have.length(3);
      expect(result.removed).to.include('app1');
      expect(result.removed).to.include('app2');
      expect(result.removed).to.include('app3');
      expect(result.failed).to.have.length(0);
      expect(appUninstallerStub.uninstallApplication.callCount).to.equal(3);
      expect(serviceHelperStub.delay.callCount).to.equal(3);
    });

    it('should handle removal failure and add to failed list', async () => {
      const appsToRemove = [
        { name: 'app1', reason: 'CPU requirements not met', height: 1000 },
      ];

      appUninstallerStub.uninstallApplication.rejects(new Error('Container not found'));

      const result = await hardwareValidationService.removeNonCompliantApps(appsToRemove);

      expect(result.removed).to.have.length(0);
      expect(result.failed).to.have.length(1);
      expect(result.failed[0].name).to.equal('app1');
      expect(result.failed[0].error).to.equal('Container not found');
      expect(logStub.error.calledWith(sinon.match(/Failed to remove app1/))).to.equal(true);
    });

    it('should handle mixed success and failure', async () => {
      const appsToRemove = [
        { name: 'app1', reason: 'CPU requirements not met', height: 1000 },
        { name: 'app2', reason: 'RAM requirements not met', height: 2000 },
        { name: 'app3', reason: 'Storage requirements not met', height: 3000 },
      ];

      appUninstallerStub.uninstallApplication.onFirstCall().resolves();
      appUninstallerStub.uninstallApplication.onSecondCall().rejects(new Error('Removal failed'));
      appUninstallerStub.uninstallApplication.onThirdCall().resolves();

      const result = await hardwareValidationService.removeNonCompliantApps(appsToRemove);

      expect(result.removed).to.have.length(2);
      expect(result.removed).to.include('app1');
      expect(result.removed).to.include('app3');
      expect(result.failed).to.have.length(1);
      expect(result.failed[0].name).to.equal('app2');
    });

    it('should delay 5 seconds between removals', async () => {
      const appsToRemove = [
        { name: 'app1', reason: 'CPU requirements not met', height: 1000 },
        { name: 'app2', reason: 'RAM requirements not met', height: 2000 },
      ];

      appUninstallerStub.uninstallApplication.resolves();

      await hardwareValidationService.removeNonCompliantApps(appsToRemove);

      expect(serviceHelperStub.delay.callCount).to.equal(2);
      expect(serviceHelperStub.delay.alwaysCalledWith(5000)).to.equal(true);
    });

    it('should call uninstallApplication with correct parameters', async () => {
      const appsToRemove = [
        { name: 'app1', reason: 'CPU requirements not met', height: 1000 },
      ];

      appUninstallerStub.uninstallApplication.resolves();

      await hardwareValidationService.removeNonCompliantApps(appsToRemove);

      expect(appUninstallerStub.uninstallApplication.calledOnce).to.equal(true);
      const call = appUninstallerStub.uninstallApplication.getCall(0);
      expect(call.args[0]).to.equal('app1');
      expect(call.args[1]).to.deep.equal({ forceKill: true, skipGuard: true, broadcastRemoval: true });
    });
  });
});
