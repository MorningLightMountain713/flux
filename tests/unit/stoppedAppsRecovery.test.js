const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('stoppedAppsRecovery tests', () => {
  let stoppedAppsRecovery;
  let logStub;
  let appsRepositoryStub;
  let deploymentProviderStub;
  let dockerServiceStub;
  let serviceHelperStub;
  let fluxNetworkHelperStub;
  let registryManagerStub;
  let advancedWorkflowsStub;
  let appUninstallerStub;

  beforeEach(() => {
    logStub = {
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
    };

    appsRepositoryStub = {
      getAppLocation: sinon.stub(),
      listInstalledApps: sinon.stub().resolves([]),
    };

    deploymentProviderStub = {
      listInstalledDeployments: sinon.stub().resolves([]),
      getInstalledDeployment: sinon.stub().resolves(null),
    };

    dockerServiceStub = {
      dockerListContainers: sinon.stub(),
    };

    serviceHelperStub = {
      delay: sinon.stub().resolves(),
    };

    fluxNetworkHelperStub = {
      getMyFluxIPandPort: sinon.stub(),
    };

    registryManagerStub = {
      getApplicationGlobalSpecifications: sinon.stub(),
    };

    advancedWorkflowsStub = {
      startApplication: sinon.stub().resolves(),
    };

    appUninstallerStub = {
      removeAppLocally: sinon.stub().resolves(),
      uninstallApplication: sinon.stub().resolves(),
    };

    stoppedAppsRecovery = proxyquire('../../ZelBack/src/services/appLifecycle/stoppedAppsRecovery', {
      '../../lib/log': logStub,
      '../appDatabase/appsRepository': appsRepositoryStub,
      '../appRuntime/deploymentProvider': deploymentProviderStub,
      '../dockerService': dockerServiceStub,
      '../serviceHelper': serviceHelperStub,
      '../fluxNetworkHelper': fluxNetworkHelperStub,
      '../appDatabase/registryManager': registryManagerStub,
      './advancedWorkflows': advancedWorkflowsStub,
      './appUninstaller': appUninstallerStub,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('appHasValidLocationOnNode', () => {
    it('should return true when expireAt is in the future', async () => {
      const expireAt = new Date(Date.now() + (60 * 1000));
      appsRepositoryStub.getAppLocation.resolves({ expireAt });

      const result = await stoppedAppsRecovery.appHasValidLocationOnNode('myApp', '10.0.0.1:16127');

      expect(result).to.equal(true);
    });

    it('should return false when no location record exists', async () => {
      appsRepositoryStub.getAppLocation.resolves(null);

      const result = await stoppedAppsRecovery.appHasValidLocationOnNode('myApp', '10.0.0.1:16127');

      expect(result).to.equal(false);
    });

    it('should return false when expireAt is in the past', async () => {
      const expireAt = new Date(Date.now() - (60 * 1000));
      appsRepositoryStub.getAppLocation.resolves({ expireAt });

      const result = await stoppedAppsRecovery.appHasValidLocationOnNode('myApp', '10.0.0.1:16127');

      expect(result).to.equal(false);
    });

    it('should return true on database error (fail-safe)', async () => {
      appsRepositoryStub.getAppLocation.rejects(new Error('DB connection lost'));

      const result = await stoppedAppsRecovery.appHasValidLocationOnNode('myApp', '10.0.0.1:16127');

      expect(result).to.equal(true);
    });

    it('should query with correct app name and IP', async () => {
      appsRepositoryStub.getAppLocation.resolves(null);

      await stoppedAppsRecovery.appHasValidLocationOnNode('testApp', '192.168.1.1:16127');

      expect(appsRepositoryStub.getAppLocation.calledWith('testApp', '192.168.1.1:16127')).to.equal(true);
    });

    it('should return false when expireAt field is missing from record', async () => {
      appsRepositoryStub.getAppLocation.resolves({ broadcastedAt: new Date() });

      const result = await stoppedAppsRecovery.appHasValidLocationOnNode('myApp', '10.0.0.1:16127');

      expect(result).to.equal(false);
    });
  });

  describe('startStoppedAppsOnBoot - location check and removal', () => {
    const stoppedFluxContainers = [
      { Names: ['/fluxAppA'], State: 'exited' },
      { Names: ['/fluxAppB'], State: 'exited' },
      { Names: ['/fluxAppC'], State: 'exited' },
    ];

    const installedApps = [
      { name: 'AppA' },
      { name: 'AppB' },
      { name: 'AppC' },
    ];

    beforeEach(() => {
      appsRepositoryStub.listInstalledApps.resolves(installedApps);

      dockerServiceStub.dockerListContainers.resolves(stoppedFluxContainers);

      registryManagerStub.getApplicationGlobalSpecifications.resolves({ version: 3, containerData: '' });

      fluxNetworkHelperStub.getMyFluxIPandPort.resolves('10.0.0.1:16127');
    });

    it('should start app when location record has not expired', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Names: ['/fluxAppA'], State: 'exited' },
      ]);
      appsRepositoryStub.listInstalledApps.resolves([{ name: 'AppA' }]);

      const futureExpiry = new Date(Date.now() + (300 * 1000));
      appsRepositoryStub.getAppLocation.resolves({ expireAt: futureExpiry });

      const results = await stoppedAppsRecovery.startStoppedAppsOnBoot();

      expect(results.appsStarted).to.deep.equal(['AppA']);
      expect(results.appsRemoved).to.deep.equal([]);
      expect(advancedWorkflowsStub.startApplication.calledWith('AppA')).to.equal(true);
    });

    it('should remove app when location record has expired', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Names: ['/fluxAppA'], State: 'exited' },
      ]);
      appsRepositoryStub.listInstalledApps.resolves([{ name: 'AppA' }]);

      const pastExpiry = new Date(Date.now() - (60 * 1000));
      appsRepositoryStub.getAppLocation.resolves({ expireAt: pastExpiry });

      const results = await stoppedAppsRecovery.startStoppedAppsOnBoot();

      expect(results.appsRemoved).to.deep.equal(['AppA']);
      expect(results.appsStarted).to.deep.equal([]);
      expect(appUninstallerStub.uninstallApplication.calledOnce).to.equal(true);
      expect(advancedWorkflowsStub.startApplication.called).to.equal(false);
    });

    it('should remove app when location record is missing', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Names: ['/fluxAppA'], State: 'exited' },
      ]);
      appsRepositoryStub.listInstalledApps.resolves([{ name: 'AppA' }]);

      appsRepositoryStub.getAppLocation.resolves(null);

      const results = await stoppedAppsRecovery.startStoppedAppsOnBoot();

      expect(results.appsRemoved).to.deep.equal(['AppA']);
      expect(results.appsStarted).to.deep.equal([]);
      expect(appUninstallerStub.uninstallApplication.called).to.equal(true);
    });

    it('should skip location check and start app when IP is not available', async () => {
      fluxNetworkHelperStub.getMyFluxIPandPort.resolves(null);

      dockerServiceStub.dockerListContainers.resolves([
        { Names: ['/fluxAppA'], State: 'exited' },
      ]);
      appsRepositoryStub.listInstalledApps.resolves([{ name: 'AppA' }]);

      const results = await stoppedAppsRecovery.startStoppedAppsOnBoot();

      expect(results.appsStarted).to.deep.equal(['AppA']);
      expect(results.appsRemoved).to.deep.equal([]);
    });

    it('should handle mixed apps: start valid, remove expired', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Names: ['/fluxAppA'], State: 'exited' },
        { Names: ['/fluxAppB'], State: 'exited' },
      ]);
      appsRepositoryStub.listInstalledApps.resolves([
        { name: 'AppA' },
        { name: 'AppB' },
      ]);

      const futureExpiry = new Date(Date.now() + (300 * 1000));
      const pastExpiry = new Date(Date.now() - (60 * 1000));
      appsRepositoryStub.getAppLocation
        .withArgs('AppA', '10.0.0.1:16127').resolves({ expireAt: futureExpiry });
      appsRepositoryStub.getAppLocation
        .withArgs('AppB', '10.0.0.1:16127').resolves({ expireAt: pastExpiry });

      const results = await stoppedAppsRecovery.startStoppedAppsOnBoot();

      expect(results.appsStarted).to.deep.equal(['AppA']);
      expect(results.appsRemoved).to.deep.equal(['AppB']);
    });

    it('should record failure when removeAppLocally throws', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Names: ['/fluxAppA'], State: 'exited' },
      ]);
      appsRepositoryStub.listInstalledApps.resolves([{ name: 'AppA' }]);

      appsRepositoryStub.getAppLocation.resolves(null);

      appUninstallerStub.uninstallApplication.rejects(new Error('Remove failed'));

      const results = await stoppedAppsRecovery.startStoppedAppsOnBoot();

      expect(results.appsRemoved).to.deep.equal([]);
      expect(results.appsFailed).to.have.lengthOf(1);
      expect(results.appsFailed[0].app).to.equal('AppA');
      expect(results.appsFailed[0].error).to.equal('Remove failed');
    });

    it('should still start app when location DB check errors (fail-safe)', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Names: ['/fluxAppA'], State: 'exited' },
      ]);
      appsRepositoryStub.listInstalledApps.resolves([{ name: 'AppA' }]);

      appsRepositoryStub.getAppLocation.rejects(new Error('DB error'));

      const results = await stoppedAppsRecovery.startStoppedAppsOnBoot();

      expect(results.appsStarted).to.deep.equal(['AppA']);
      expect(results.appsRemoved).to.deep.equal([]);
    });

    it('should skip active-standby syncthing apps and check location for normal apps', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Names: ['/fluxSyncApp'], State: 'exited' },
        { Names: ['/fluxNormalApp'], State: 'exited' },
      ]);
      appsRepositoryStub.listInstalledApps.resolves([
        { name: 'SyncApp' },
        { name: 'NormalApp' },
      ]);

      const mockActiveStandbyDeployment = {
        componentEntries: () => [[
          'main',
          { hasActiveStandbySyncthing: () => true },
        ]],
      };
      deploymentProviderStub.getInstalledDeployment.withArgs('SyncApp').resolves(mockActiveStandbyDeployment);
      deploymentProviderStub.getInstalledDeployment.withArgs('NormalApp').resolves(null);

      appsRepositoryStub.getAppLocation.resolves(null);

      const results = await stoppedAppsRecovery.startStoppedAppsOnBoot();

      expect(results.appsSkippedGMode).to.deep.equal(['SyncApp']);
      expect(results.appsRemoved).to.deep.equal(['NormalApp']);
      expect(results.appsStarted).to.deep.equal([]);
    });
  });
});
