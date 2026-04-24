// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const advancedWorkflows = require('../../ZelBack/src/services/appLifecycle/advancedWorkflows');
const dbHelper = require('../../ZelBack/src/services/dbHelper');

describe('advancedWorkflows tests', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('getPreviousAppSpecifications tests', () => {
    it('should return null if no previous message found', async () => {
      const specifications = { name: 'NewApp' };
      const verificationTimestamp = Date.now();

      sinon.stub(dbHelper, 'databaseConnection').returns({
        db: () => ({}),
      });
      sinon.stub(dbHelper, 'findInDatabase').resolves([]);

      const result = await advancedWorkflows.getPreviousAppSpecifications(specifications, verificationTimestamp);
      expect(result).to.be.null;
    });
  });

  describe('setInstallationInProgress and getInstallationInProgress tests', () => {
    it('should set installation in progress', () => {
      advancedWorkflows.setInstallationInProgressTrue();

      const inProgress = advancedWorkflows.getInstallationInProgress();
      expect(inProgress).to.be.true;
    });

    it('should reset installation in progress', () => {
      advancedWorkflows.setInstallationInProgressTrue();
      advancedWorkflows.installationInProgressReset();

      const inProgress = advancedWorkflows.getInstallationInProgress();
      expect(inProgress).to.be.false;
    });

    it('should set specific app installation in progress', () => {
      advancedWorkflows.setInstallationInProgress('TestApp', true);

      const inProgress = advancedWorkflows.getInstallationInProgress();
      // When setting specific app, function returns the app name, not just true
      expect(inProgress).to.equal('TestApp');
    });
  });

  describe('setRemovalInProgress and getRemovalInProgress tests', () => {
    it('should set removal in progress', () => {
      advancedWorkflows.setRemovalInProgressToTrue();

      const inProgress = advancedWorkflows.getRemovalInProgress();
      expect(inProgress).to.be.true;
    });

    it('should reset removal in progress', () => {
      advancedWorkflows.setRemovalInProgressToTrue();
      advancedWorkflows.removalInProgressReset();

      const inProgress = advancedWorkflows.getRemovalInProgress();
      expect(inProgress).to.be.false;
    });

    it('should set specific app removal in progress', () => {
      advancedWorkflows.setRemovalInProgress('TestApp', true);

      const inProgress = advancedWorkflows.getRemovalInProgress();
      // When setting specific app, function returns the app name, not just true
      expect(inProgress).to.equal('TestApp');
    });
  });

  describe('addToRestoreProgress and removeFromRestoreProgress tests', () => {
    beforeEach(() => {
      // eslint-disable-next-line global-require
      const globalState = require('../../ZelBack/src/services/utils/globalState');
      globalState.restoreInProgress = [];
    });

    it('should add app to restore progress', () => {
      advancedWorkflows.addToRestoreProgress('TestApp');

      // eslint-disable-next-line global-require
      const globalState = require('../../ZelBack/src/services/utils/globalState');
      expect(globalState.restoreInProgress).to.include('TestApp');
    });

    it('should remove app from restore progress', () => {
      advancedWorkflows.addToRestoreProgress('TestApp');
      advancedWorkflows.removeFromRestoreProgress('TestApp');

      // eslint-disable-next-line global-require
      const globalState = require('../../ZelBack/src/services/utils/globalState');
      expect(globalState.restoreInProgress).to.not.include('TestApp');
    });

    it('should not duplicate apps in restore progress', () => {
      advancedWorkflows.addToRestoreProgress('TestApp');
      advancedWorkflows.addToRestoreProgress('TestApp');

      // eslint-disable-next-line global-require
      const globalState = require('../../ZelBack/src/services/utils/globalState');
      const count = globalState.restoreInProgress.filter((app) => app === 'TestApp').length;
      expect(count).to.equal(1);
    });
  });

  describe('redeployComponentAPI tests', () => {
    let req;
    let res;
    let globalState;
    let verificationHelper;

    beforeEach(() => {
      // eslint-disable-next-line global-require
      globalState = require('../../ZelBack/src/services/utils/globalState');
      globalState.removalInProgress = false;
      globalState.installationInProgress = false;
      globalState.softRedeployInProgress = false;
      globalState.hardRedeployInProgress = false;
      globalState.restoreInProgress = [];

      // eslint-disable-next-line global-require
      verificationHelper = require('../../ZelBack/src/services/verificationHelper');

      req = {
        params: {},
        query: {},
        headers: {},
      };
      res = {
        json: sinon.stub(),
        write: sinon.stub(),
        flush: sinon.stub(),
        setHeader: sinon.stub(),
      };
    });

    it('should return error if appname is not provided', async () => {
      req.params.component = 'frontend';

      await advancedWorkflows.redeployComponentAPI(req, res);

      expect(res.json.calledOnce).to.be.true;
      const response = res.json.firstCall.args[0];
      expect(response.status).to.equal('error');
      expect(response.data.message).to.include('No Flux App specified');
    });

    it('should return error if component is not provided', async () => {
      req.params.appname = 'myapp';

      await advancedWorkflows.redeployComponentAPI(req, res);

      expect(res.json.calledOnce).to.be.true;
      const response = res.json.firstCall.args[0];
      expect(response.status).to.equal('error');
      expect(response.data.message).to.include('No component specified');
    });

    it('should return error if appname contains underscore', async () => {
      req.params.appname = 'frontend_myapp';
      req.params.component = 'frontend';

      await advancedWorkflows.redeployComponentAPI(req, res);

      expect(res.json.calledOnce).to.be.true;
      const response = res.json.firstCall.args[0];
      expect(response.status).to.equal('error');
      expect(response.data.message).to.include('Invalid app name format');
    });

    it('should skip redeploy if app is in restore progress', async () => {
      req.params.appname = 'myapp';
      req.params.component = 'frontend';

      // Use the proper method to add to restore progress
      advancedWorkflows.addToRestoreProgress('myapp');

      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);

      await advancedWorkflows.redeployComponentAPI(req, res);

      expect(res.json.calledOnce).to.be.true;
      const response = res.json.firstCall.args[0];
      expect(response.status).to.equal('warning');
      expect(response.data.message).to.include('Restore is running');

      // Clean up
      advancedWorkflows.removeFromRestoreProgress('myapp');
    });

    it('should return unauthorized error if not authorized', async () => {
      req.params.appname = 'myapp';
      req.params.component = 'frontend';

      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(false);

      await advancedWorkflows.redeployComponentAPI(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(verificationHelper.verifyPrivilege.calledWith('appownerabove', req, 'myapp')).to.be.true;
    });

    it('should handle force parameter from query string', async () => {
      req.params.appname = 'myapp';
      req.params.component = 'frontend';
      req.query.force = 'true';

      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
      sinon.stub(dbHelper, 'databaseConnection').returns({
        db: () => ({}),
      });
      sinon.stub(dbHelper, 'findOneInDatabase').resolves(null);

      await advancedWorkflows.redeployComponentAPI(req, res);

      // Should attempt to call hardRedeployComponent but will fail because app not found
      expect(res.json.calledOnce).to.be.true;
    });
  });

  describe('softRedeployComponent tests', () => {
    let globalState;
    let res;

    beforeEach(() => {
      // eslint-disable-next-line global-require
      globalState = require('../../ZelBack/src/services/utils/globalState');
      globalState.removalInProgress = false;
      globalState.installationInProgress = false;
      globalState.softRedeployInProgress = false;
      globalState.hardRedeployInProgress = false;

      res = {
        write: sinon.stub(),
        flush: sinon.stub(),
      };
    });

    it('should return early if removal is in progress', async () => {
      globalState.removalInProgress = true;

      await advancedWorkflows.softRedeployComponent('myapp', 'frontend', res);

      expect(res.write.calledOnce).to.be.true;
      const response = res.write.firstCall.args[0];
      expect(response).to.include('Another application is undergoing removal');
    });

    it('should return early if installation is in progress', async () => {
      globalState.installationInProgress = true;

      await advancedWorkflows.softRedeployComponent('myapp', 'frontend', res);

      expect(res.write.calledOnce).to.be.true;
      const response = res.write.firstCall.args[0];
      expect(response).to.include('Another application is undergoing installation');
    });

    it('should return early if soft redeploy is in progress', async () => {
      globalState.softRedeployInProgress = true;

      await advancedWorkflows.softRedeployComponent('myapp', 'frontend', res);

      expect(res.write.calledOnce).to.be.true;
      const response = res.write.firstCall.args[0];
      expect(response).to.include('Another application is undergoing soft redeploy');
    });

    it('should return early if hard redeploy is in progress', async () => {
      globalState.hardRedeployInProgress = true;

      await advancedWorkflows.softRedeployComponent('myapp', 'frontend', res);

      expect(res.write.calledOnce).to.be.true;
      const response = res.write.firstCall.args[0];
      expect(response).to.include('Another application is undergoing hard redeploy');
    });

    it('should throw error if application not found', async () => {
      sinon.stub(dbHelper, 'databaseConnection').returns({
        db: () => ({}),
      });
      sinon.stub(dbHelper, 'findOneInDatabase').resolves(null);

      try {
        await advancedWorkflows.softRedeployComponent('myapp', 'frontend', res);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Application myapp not found');
        expect(globalState.softRedeployInProgress).to.be.false;
      }
    });

    it('should throw error if app not found', async () => {
      sinon.stub(dbHelper, 'databaseConnection').returns({
        db: () => ({}),
      });
      sinon.stub(dbHelper, 'findOneInDatabase').resolves(null);

      try {
        await advancedWorkflows.softRedeployComponent('myapp', 'frontend', res);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('not found');
        expect(globalState.softRedeployInProgress).to.be.false;
      }
    });

    it('should throw error if component not found in app', async () => {
      sinon.stub(dbHelper, 'databaseConnection').returns({
        db: () => ({}),
      });
      sinon.stub(dbHelper, 'findOneInDatabase').resolves({
        name: 'myapp',
        version: 4,
        description: 'test',
        owner: '1abc',
        instances: 3,
        compose: [
          { name: 'backend', description: '', repotag: 'myapp/backend:1.0', ports: [30000], containerPorts: [8080], domains: [''], environmentParameters: [], commands: [], containerData: '', cpu: 0.5, ram: 500, hdd: 5 },
        ],
      });

      try {
        await advancedWorkflows.softRedeployComponent('myapp', 'frontend', res);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Component frontend not found');
        expect(globalState.softRedeployInProgress).to.be.false;
      }
    });
  });

  describe('hardRedeployComponent tests', () => {
    let globalState;
    let res;

    beforeEach(() => {
      // eslint-disable-next-line global-require
      globalState = require('../../ZelBack/src/services/utils/globalState');
      globalState.removalInProgress = false;
      globalState.installationInProgress = false;
      globalState.softRedeployInProgress = false;
      globalState.hardRedeployInProgress = false;

      res = {
        write: sinon.stub(),
        flush: sinon.stub(),
      };
    });

    it('should return early if removal is in progress', async () => {
      globalState.removalInProgress = true;

      await advancedWorkflows.hardRedeployComponent('myapp', 'frontend', res);

      expect(res.write.calledOnce).to.be.true;
      const response = res.write.firstCall.args[0];
      expect(response).to.include('Another application is undergoing removal');
    });

    it('should return early if installation is in progress', async () => {
      globalState.installationInProgress = true;

      await advancedWorkflows.hardRedeployComponent('myapp', 'frontend', res);

      expect(res.write.calledOnce).to.be.true;
      const response = res.write.firstCall.args[0];
      expect(response).to.include('Another application is undergoing installation');
    });

    it('should return early if soft redeploy is in progress', async () => {
      globalState.softRedeployInProgress = true;

      await advancedWorkflows.hardRedeployComponent('myapp', 'frontend', res);

      expect(res.write.calledOnce).to.be.true;
      const response = res.write.firstCall.args[0];
      expect(response).to.include('Another application is undergoing soft redeploy');
    });

    it('should return early if hard redeploy is in progress', async () => {
      globalState.hardRedeployInProgress = true;

      await advancedWorkflows.hardRedeployComponent('myapp', 'frontend', res);

      expect(res.write.calledOnce).to.be.true;
      const response = res.write.firstCall.args[0];
      expect(response).to.include('Another application is undergoing hard redeploy');
    });

    it('should throw error if application not found', async () => {
      sinon.stub(dbHelper, 'databaseConnection').returns({
        db: () => ({}),
      });
      sinon.stub(dbHelper, 'findOneInDatabase').resolves(null);

      try {
        await advancedWorkflows.hardRedeployComponent('myapp', 'frontend', res);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Application myapp not found');
        expect(globalState.hardRedeployInProgress).to.be.false;
      }
    });

    it('should throw error if app not found', async () => {
      sinon.stub(dbHelper, 'databaseConnection').returns({
        db: () => ({}),
      });
      sinon.stub(dbHelper, 'findOneInDatabase').resolves(null);

      try {
        await advancedWorkflows.hardRedeployComponent('myapp', 'frontend', res);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('not found');
        expect(globalState.hardRedeployInProgress).to.be.false;
      }
    });

    it('should throw error if component not found in app', async () => {
      sinon.stub(dbHelper, 'databaseConnection').returns({
        db: () => ({}),
      });
      sinon.stub(dbHelper, 'findOneInDatabase').resolves({
        name: 'myapp',
        version: 4,
        description: 'test',
        owner: '1abc',
        instances: 3,
        compose: [
          { name: 'backend', description: '', repotag: 'myapp/backend:1.0', ports: [30000], containerPorts: [8080], domains: [''], environmentParameters: [], commands: [], containerData: '', cpu: 0.5, ram: 500, hdd: 5 },
        ],
      });

      try {
        await advancedWorkflows.hardRedeployComponent('myapp', 'frontend', res);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Component frontend not found');
        expect(globalState.hardRedeployInProgress).to.be.false;
      }
    });

    it('should set hardRedeployInProgress to false on error', async () => {
      sinon.stub(dbHelper, 'databaseConnection').returns({
        db: () => ({}),
      });
      sinon.stub(dbHelper, 'findOneInDatabase').resolves(null);

      try {
        await advancedWorkflows.hardRedeployComponent('myapp', 'frontend', res);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(globalState.hardRedeployInProgress).to.be.false;
      }
    });
  });

  describe('ensureMountSourcesExist tests', () => {
    let fsStub;
    let serviceHelperStub;
    let logStub;
    let proxyquire;

    beforeEach(() => {
      // eslint-disable-next-line global-require
      proxyquire = require('proxyquire').noCallThru();

      fsStub = {
        access: sinon.stub(),
      };

      serviceHelperStub = {
        runCommand: sinon.stub().resolves({ error: null }),
      };

      logStub = {
        info: sinon.stub(),
        warn: sinon.stub(),
        error: sinon.stub(),
      };
    });

    afterEach(() => {
      sinon.restore();
    });

    function buildDeployComp(mounts) {
      return { mounts };
    }

    function loadModule() {
      return proxyquire('../../ZelBack/src/services/appLifecycle/advancedWorkflows', {
        'node:fs/promises': fsStub,
        '../serviceHelper': serviceHelperStub,
        '../../lib/log': logStub,
      });
    }

    it('skips creating paths that already exist', async () => {
      fsStub.access = sinon.stub().resolves();
      const mod = loadModule();
      const deployComp = buildDeployComp([
        { Source: '/apps/fluxweb_test/html', sourceType: 'directory' },
        { Source: '/apps/fluxweb_test/config.yaml', sourceType: 'file' },
      ]);

      await mod.ensureMountSourcesExist(deployComp);

      expect(fsStub.access.callCount).to.equal(2);
      expect(serviceHelperStub.runCommand.called).to.be.false;
    });

    it('creates missing file with touch and chmod', async () => {
      fsStub.access = sinon.stub().rejects(new Error('ENOENT'));
      const mod = loadModule();
      const deployComp = buildDeployComp([
        { Source: '/apps/fluxweb_test/config.yaml', sourceType: 'file' },
      ]);

      await mod.ensureMountSourcesExist(deployComp);

      expect(serviceHelperStub.runCommand.calledWith('touch', sinon.match({ params: ['/apps/fluxweb_test/config.yaml'], runAsRoot: true }))).to.be.true;
      expect(serviceHelperStub.runCommand.calledWith('chmod', sinon.match({ params: ['777', '/apps/fluxweb_test/config.yaml'], runAsRoot: true }))).to.be.true;
    });

    it('creates missing directory with mkdir', async () => {
      fsStub.access = sinon.stub().rejects(new Error('ENOENT'));
      const mod = loadModule();
      const deployComp = buildDeployComp([
        { Source: '/apps/fluxweb_test/logs', sourceType: 'directory' },
      ]);

      await mod.ensureMountSourcesExist(deployComp);

      expect(serviceHelperStub.runCommand.calledWith('mkdir', sinon.match({ params: ['-p', '/apps/fluxweb_test/logs'], runAsRoot: true }))).to.be.true;
    });

    it('handles mixed files and directories', async () => {
      fsStub.access = sinon.stub();
      fsStub.access.onCall(0).resolves();
      fsStub.access.onCall(1).rejects(new Error('ENOENT'));
      fsStub.access.onCall(2).rejects(new Error('ENOENT'));

      const mod = loadModule();
      const deployComp = buildDeployComp([
        { Source: '/apps/fluxweb_test/html', sourceType: 'directory' },
        { Source: '/apps/fluxweb_test/logs', sourceType: 'directory' },
        { Source: '/apps/fluxweb_test/config.yaml', sourceType: 'file' },
      ]);

      await mod.ensureMountSourcesExist(deployComp);

      expect(serviceHelperStub.runCommand.calledWith('mkdir', sinon.match({ params: ['-p', '/apps/fluxweb_test/logs'] }))).to.be.true;
      expect(serviceHelperStub.runCommand.calledWith('touch', sinon.match({ params: ['/apps/fluxweb_test/config.yaml'] }))).to.be.true;
    });

    it('handles empty mounts array', async () => {
      const mod = loadModule();
      const deployComp = buildDeployComp([]);

      await mod.ensureMountSourcesExist(deployComp);

      expect(fsStub.access.called).to.be.false;
      expect(serviceHelperStub.runCommand.called).to.be.false;
    });
  });

  // Note: masterSlaveApps is a recursive function that continuously runs in production.
  // These tests use a counter to prevent infinite recursion after the first iteration.
  describe('masterSlaveApps tests', () => {
    let globalState;
    let serviceHelperStub;
    let serviceHelperDelayStub;
    let fluxNetworkHelperStub;
    let registryManagerStub;
    let dockerServiceStub;
    let syncthingServiceStub;
    let syncthingServiceHealthStub;
    let decryptEnterpriseAppsStub;
    let recursionCounter;

    beforeEach(() => {
      recursionCounter = 0;
      globalState = require('../../ZelBack/src/services/utils/globalState');
      globalState.masterSlaveAppsRunning = false;
      globalState.installationInProgress = false;
      globalState.removalInProgress = false;
      globalState.softRedeployInProgress = false;
      globalState.hardRedeployInProgress = false;

      // Setup stubs
      const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
      serviceHelperStub = sinon.stub(serviceHelper, 'axiosGet');

      // Stub delay to prevent recursive calls - after first call, block recursion
      serviceHelperDelayStub = sinon.stub(serviceHelper, 'delay').callsFake(async () => {
        recursionCounter += 1;
        if (recursionCounter > 1) {
          // Prevent recursion by returning a promise that never resolves
          return new Promise(() => {});
        }
        return Promise.resolve();
      });

      const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
      fluxNetworkHelperStub = sinon.stub(fluxNetworkHelper, 'getMyFluxIPandPort');

      const registryManager = require('../../ZelBack/src/services/appDatabase/registryManager');
      registryManagerStub = sinon.stub(registryManager, 'appLocation');

      const dockerService = require('../../ZelBack/src/services/dockerService');
      dockerServiceStub = sinon.stub(dockerService, 'getAppIdentifier');

      const syncthingService = require('../../ZelBack/src/services/syncthingService');
      syncthingServiceStub = sinon.stub(syncthingService, 'getConfigFolders');
      syncthingServiceHealthStub = sinon.stub(syncthingService, 'getHealth').resolves({
        status: 'success',
        data: { status: 'OK' },
      });

      // Stub decryptEnterpriseApps to return apps as-is
      const appQueryService = require('../../ZelBack/src/services/appQuery/appQueryService');
      decryptEnterpriseAppsStub = sinon.stub(appQueryService, 'decryptEnterpriseApps').callsFake((apps) => Promise.resolve(apps));

      // Stub database connection to prevent actual DB access
      sinon.stub(dbHelper, 'databaseConnection').returns({
        db: () => ({}),
      });
      sinon.stub(dbHelper, 'findOneInDatabase').resolves(null);
    });

    it('should skip execution if installation is in progress', async () => {
      globalState.installationInProgress = true;

      const installedApps = sinon.stub().resolves({ status: 'success', data: [] });
      const listRunningApps = sinon.stub().resolves({ status: 'success', data: [] });
      const receiveOnlyCache = new Map();
      const backupInProgress = [];
      const restoreInProgress = [];
      const https = require('https');

      await advancedWorkflows.masterSlaveApps(
        globalState,
        installedApps,
        listRunningApps,
        receiveOnlyCache,
        backupInProgress,
        restoreInProgress,
        https,
      );

      expect(installedApps.called).to.be.false;
    });

    it('should skip execution if removal is in progress', async () => {
      globalState.removalInProgress = true;

      const installedApps = sinon.stub().resolves({ status: 'success', data: [] });
      const listRunningApps = sinon.stub().resolves({ status: 'success', data: [] });
      const receiveOnlyCache = new Map();
      const backupInProgress = [];
      const restoreInProgress = [];
      const https = require('https');

      await advancedWorkflows.masterSlaveApps(
        globalState,
        installedApps,
        listRunningApps,
        receiveOnlyCache,
        backupInProgress,
        restoreInProgress,
        https,
      );

      expect(installedApps.called).to.be.false;
    });

    it('should skip apps in backup progress', async () => {
      const appName = 'testapp';
      const installedApps = sinon.stub().resolves({
        status: 'success',
        data: [
          {
            name: appName,
            version: 3,
            containerData: 'g:data',
          },
        ],
      });
      const listRunningApps = sinon.stub().resolves({ status: 'success', data: [] });
      const receiveOnlyCache = new Map();
      const backupInProgress = [appName];
      const restoreInProgress = [];
      const https = require('https');

      // Mock FDM to return no errors
      serviceHelperStub.resolves({ data: [] });

      // Execute - should skip processing this app due to backup
      await advancedWorkflows.masterSlaveApps(
        globalState,
        installedApps,
        listRunningApps,
        receiveOnlyCache,
        backupInProgress,
        restoreInProgress,
        https,
      );

      // Function should have been called to get installed apps
      expect(installedApps.called).to.be.true;
      // But FDM should not be queried since app is skipped
      expect(serviceHelperStub.called).to.be.false;
    });

    it('should handle apps with g: containerData (master-slave mode)', async () => {
      const appName = 'masterslaveapp';
      dockerServiceStub.returns('zel_masterslaveapp');

      const installedApps = sinon.stub().resolves({
        status: 'success',
        data: [
          {
            name: appName,
            version: 3,
            description: 'test',
            owner: '1abc',
            repotag: 'repo/app:latest',
            cpu: 0.5,
            ram: 500,
            hdd: 5,
            ports: [30000],
            containerPorts: [8080],
            domains: [''],
            containerData: 'g:syncdata',
            instances: 3,
          },
        ],
      });
      const listRunningApps = sinon.stub().resolves({
        status: 'success',
        data: [],
      });

      const receiveOnlyCache = new Map();
      receiveOnlyCache.set('zel_masterslaveapp', { restarted: true });

      const backupInProgress = [];
      const restoreInProgress = [];
      const https = require('https');

      // Mock FDM responses (no IP)
      serviceHelperStub.resolves({ data: [] });

      // Mock node IP
      fluxNetworkHelperStub.resolves('192.168.1.5:16127');

      // Mock running app list - this node is at index 0
      registryManagerStub.resolves([
        {
          name: appName,
          ip: '192.168.1.5:16127',
          runningSince: null,
        },
        {
          name: appName,
          ip: '192.168.1.10:16127',
          runningSince: null,
        },
      ]);

      // Mock syncthing folder check
      syncthingServiceStub.resolves({
        status: 'success',
        data: [
          {
            path: '/root/.flux/ZelApps/zel_masterslaveapp',
            type: 'sendreceive',
          },
        ],
      });

      // This should attempt to start the app since this node is at index 0
      await advancedWorkflows.masterSlaveApps(
        globalState,
        installedApps,
        listRunningApps,
        receiveOnlyCache,
        backupInProgress,
        restoreInProgress,
        https,
      );

      // Verify FDM was queried
      expect(serviceHelperStub.called).to.be.true;
    });

    it('should schedule non-index-0 nodes when no FDM IP and no history', async () => {
      const appName = 'masterslaveapp';
      dockerServiceStub.returns('zel_masterslaveapp');

      const installedApps = sinon.stub().resolves({
        status: 'success',
        data: [
          {
            name: appName,
            version: 3,
            description: 'test',
            owner: '1abc',
            repotag: 'repo/app:latest',
            cpu: 0.5,
            ram: 500,
            hdd: 5,
            ports: [30000],
            containerPorts: [8080],
            domains: [''],
            containerData: 'g:syncdata',
            instances: 3,
          },
        ],
      });
      const listRunningApps = sinon.stub().resolves({
        status: 'success',
        data: [],
      });

      const receiveOnlyCache = new Map();
      receiveOnlyCache.set('zel_masterslaveapp', { restarted: true });

      const backupInProgress = [];
      const restoreInProgress = [];
      const https = require('https');

      // Mock FDM responses (no IP)
      serviceHelperStub.resolves({ data: [] });

      // Mock node IP - this node is at index 1 (second in list)
      fluxNetworkHelperStub.resolves('192.168.1.10:16127');

      // Mock running app list - sorted by IP
      registryManagerStub.resolves([
        {
          name: appName,
          ip: '192.168.1.5:16127',
          runningSince: null,
        },
        {
          name: appName,
          ip: '192.168.1.10:16127', // This node
          runningSince: null,
        },
      ]);

      // Mock syncthing folder check
      syncthingServiceStub.resolves({
        status: 'success',
        data: [
          {
            path: '/root/.flux/ZelApps/zel_masterslaveapp',
            type: 'sendreceive',
          },
        ],
      });

      await advancedWorkflows.masterSlaveApps(
        globalState,
        installedApps,
        listRunningApps,
        receiveOnlyCache,
        backupInProgress,
        restoreInProgress,
        https,
      );

      // Node at index 1 should schedule start for 3 minutes later, not start immediately
      // This is verified by the function logic - it should NOT call appDockerRestart immediately
      expect(serviceHelperStub.called).to.be.true;
      expect(fluxNetworkHelperStub.called).to.be.true;
    });
  });

  describe.skip('validateApplicationUpdateCompatibility — moved to UpdatePolicy.assertCompatible in flux-spec', () => {
    it('should allow component count changes for version 8+ apps', async () => {
      const oldAppSpecs = {
        name: 'TestApp',
        description: 'Test application',
        owner: 'testowner',
        version: 8,
        instances: 3,
        contacts: [],
        geolocation: [],
        expire: 10000,
        nodes: [],
        staticip: false,
        enterprise: '',
        compose: [
          { name: 'frontend', repotag: 'repo/frontend:1.0', ports: ['8080'], containerPorts: ['8080'], domains: [], environmentParameters: [], commands: [] },
          { name: 'backend', repotag: 'repo/backend:1.0', ports: ['3000'], containerPorts: ['3000'], domains: [], environmentParameters: [], commands: [] },
        ],
      };

      const newAppSpecs = {
        name: 'TestApp',
        description: 'Test application',
        owner: 'testowner',
        version: 8,
        instances: 3,
        contacts: [],
        geolocation: [],
        expire: 10000,
        nodes: [],
        staticip: false,
        enterprise: '',
        compose: [
          { name: 'frontend', repotag: 'repo/frontend:1.0', ports: ['8080'], containerPorts: ['8080'], domains: [], environmentParameters: [], commands: [] },
          { name: 'backend', repotag: 'repo/backend:1.0', ports: ['3000'], containerPorts: ['3000'], domains: [], environmentParameters: [], commands: [] },
          { name: 'database', repotag: 'repo/database:1.0', ports: ['5432'], containerPorts: ['5432'], domains: [], environmentParameters: [], commands: [] },
        ],
      };

      // Should not throw error for v8+ apps with component changes
      const result = await advancedWorkflows.validateApplicationUpdateCompatibility(
        newAppSpecs,
        oldAppSpecs,
      );

      expect(result).to.be.true;
    });

    it('should allow component name changes for version 8+ apps', async () => {
      const oldAppSpecs = {
        name: 'TestApp',
        description: 'Test application',
        owner: 'testowner',
        version: 8,
        instances: 3,
        contacts: [],
        geolocation: [],
        expire: 10000,
        nodes: [],
        staticip: false,
        enterprise: '',
        compose: [
          { name: 'frontend', repotag: 'repo/frontend:1.0', ports: ['8080'], containerPorts: ['8080'], domains: [], environmentParameters: [], commands: [] },
          { name: 'backend', repotag: 'repo/backend:1.0', ports: ['3000'], containerPorts: ['3000'], domains: [], environmentParameters: [], commands: [] },
        ],
      };

      const newAppSpecs = {
        name: 'TestApp',
        description: 'Test application',
        owner: 'testowner',
        version: 8,
        instances: 3,
        contacts: [],
        geolocation: [],
        expire: 10000,
        nodes: [],
        staticip: false,
        enterprise: '',
        compose: [
          { name: 'frontend', repotag: 'repo/frontend:1.0', ports: ['8080'], containerPorts: ['8080'], domains: [], environmentParameters: [], commands: [] },
          { name: 'api', repotag: 'repo/api:1.0', ports: ['3000'], containerPorts: ['3000'], domains: [], environmentParameters: [], commands: [] }, // Renamed from 'backend' to 'api'
        ],
      };

      // Should not throw error for v8+ apps with component name changes
      const result = await advancedWorkflows.validateApplicationUpdateCompatibility(
        newAppSpecs,
        oldAppSpecs,
      );

      expect(result).to.be.true;
    });

    it('should reject component count changes for version 4-7 apps', async () => {
      const oldAppSpecs = {
        name: 'TestApp',
        description: 'Test application',
        owner: 'testowner',
        version: 7,
        instances: 3,
        contacts: [],
        geolocation: [],
        expire: 10000,
        nodes: [],
        staticip: false,
        repoAuth: '',
        compose: [
          { name: 'frontend', description: '', repotag: 'repo/frontend:1.0', ports: [8080], containerPorts: [8080], domains: [''], environmentParameters: [], commands: [], containerData: '', cpu: 0.5, ram: 500, hdd: 5 },
          { name: 'backend', description: '', repotag: 'repo/backend:1.0', ports: [3000], containerPorts: [3000], domains: [''], environmentParameters: [], commands: [], containerData: '', cpu: 0.5, ram: 500, hdd: 5 },
        ],
      };

      const newAppSpecs = {
        name: 'TestApp',
        description: 'Test application',
        owner: 'testowner',
        version: 7,
        instances: 3,
        contacts: [],
        geolocation: [],
        expire: 10000,
        nodes: [],
        staticip: false,
        repoAuth: '',
        compose: [
          { name: 'frontend', description: '', repotag: 'repo/frontend:1.0', ports: [8080], containerPorts: [8080], domains: [''], environmentParameters: [], commands: [], containerData: '', cpu: 0.5, ram: 500, hdd: 5 },
          { name: 'backend', description: '', repotag: 'repo/backend:1.0', ports: [3000], containerPorts: [3000], domains: [''], environmentParameters: [], commands: [], containerData: '', cpu: 0.5, ram: 500, hdd: 5 },
          { name: 'database', description: '', repotag: 'repo/database:1.0', ports: [5432], containerPorts: [5432], domains: [''], environmentParameters: [], commands: [], containerData: '', cpu: 0.5, ram: 500, hdd: 5 },
        ],
      };

      // Should throw error for v4-7 apps with component count changes
      try {
        await advancedWorkflows.validateApplicationUpdateCompatibility(
          newAppSpecs,
          oldAppSpecs,
        );
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Cannot change the number of components');
        expect(error.message).to.include('v4-7 applications');
        expect(error.message).to.include('Upgrade to version 8');
      }
    });

    it('should reject component name changes for version 4-7 apps', async () => {
      const oldAppSpecs = {
        name: 'TestApp',
        description: 'Test application',
        owner: 'testowner',
        version: 6,
        instances: 3,
        contacts: [],
        geolocation: [],
        expire: 10000,
        nodes: [],
        staticip: false,
        repoAuth: '',
        compose: [
          { name: 'frontend', description: '', repotag: 'repo/frontend:1.0', ports: [8080], containerPorts: [8080], domains: [''], environmentParameters: [], commands: [], containerData: '', cpu: 0.5, ram: 500, hdd: 5 },
          { name: 'backend', description: '', repotag: 'repo/backend:1.0', ports: [3000], containerPorts: [3000], domains: [''], environmentParameters: [], commands: [], containerData: '', cpu: 0.5, ram: 500, hdd: 5 },
        ],
      };

      const newAppSpecs = {
        name: 'TestApp',
        description: 'Test application',
        owner: 'testowner',
        version: 6,
        instances: 3,
        contacts: [],
        geolocation: [],
        expire: 10000,
        nodes: [],
        staticip: false,
        repoAuth: '',
        compose: [
          { name: 'frontend', description: '', repotag: 'repo/frontend:1.0', ports: [8080], containerPorts: [8080], domains: [''], environmentParameters: [], commands: [], containerData: '', cpu: 0.5, ram: 500, hdd: 5 },
          { name: 'api', description: '', repotag: 'repo/api:1.0', ports: [3000], containerPorts: [3000], domains: [''], environmentParameters: [], commands: [], containerData: '', cpu: 0.5, ram: 500, hdd: 5 },
        ],
      };

      // Should throw error for v4-7 apps with component name changes
      try {
        await advancedWorkflows.validateApplicationUpdateCompatibility(
          newAppSpecs,
          oldAppSpecs,
        );
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Component "backend" not found');
        expect(error.message).to.include('v4-7 applications');
        expect(error.message).to.include('Upgrade to version 8');
      }
    });

    it('should allow version changes (policy enforced elsewhere)', async () => {
      const oldAppSpecs = {
        name: 'TestApp',
        version: 5,
        compose: [
          { name: 'app', repotag: 'repo/app:1.0', ports: ['8080'], containerPorts: ['8080'], domains: [], environmentParameters: [], commands: [], tiered: false },
        ],
      };

      const newAppSpecs = {
        name: 'TestApp',
        version: 6,
        compose: [
          { name: 'app', repotag: 'repo/app:1.0', ports: ['8080'], containerPorts: ['8080'], domains: [], environmentParameters: [], commands: [], tiered: false },
        ],
      };

      // validateApplicationUpdateCompatibility no longer enforces version upgrade policy —
      // that is now handled in storeAppTemporaryMessage. Structural compatibility should pass.
      const result = await advancedWorkflows.validateApplicationUpdateCompatibility(
        newAppSpecs,
        oldAppSpecs,
      );

      expect(result).to.be.true;
    });

    it('should allow repotag changes for all v4+ apps', async () => {
      const oldAppSpecs = {
        name: 'TestApp',
        description: 'Test application',
        owner: 'testowner',
        version: 7,
        instances: 3,
        contacts: [],
        geolocation: [],
        expire: 10000,
        nodes: [],
        staticip: false,
        repoAuth: '',
        compose: [
          { name: 'frontend', description: '', repotag: 'repo/frontend:1.0', ports: [8080], containerPorts: [8080], domains: [''], environmentParameters: [], commands: [], containerData: '', cpu: 0.5, ram: 500, hdd: 5 },
          { name: 'backend', description: '', repotag: 'repo/backend:1.0', ports: [3000], containerPorts: [3000], domains: [''], environmentParameters: [], commands: [], containerData: '', cpu: 0.5, ram: 500, hdd: 5 },
        ],
      };

      const newAppSpecs = {
        name: 'TestApp',
        description: 'Test application',
        owner: 'testowner',
        version: 7,
        instances: 3,
        contacts: [],
        geolocation: [],
        expire: 10000,
        nodes: [],
        staticip: false,
        repoAuth: '',
        compose: [
          { name: 'frontend', description: '', repotag: 'repo/frontend:2.0', ports: [8080], containerPorts: [8080], domains: [''], environmentParameters: [], commands: [], containerData: '', cpu: 0.5, ram: 500, hdd: 5 },
          { name: 'backend', description: '', repotag: 'repo/backend:2.0', ports: [3000], containerPorts: [3000], domains: [''], environmentParameters: [], commands: [], containerData: '', cpu: 0.5, ram: 500, hdd: 5 },
        ],
      };

      // Should allow repotag changes for v4+ apps
      const result = await advancedWorkflows.validateApplicationUpdateCompatibility(
        newAppSpecs,
        oldAppSpecs,
      );

      expect(result).to.be.true;
    });
  });

  describe('softRedeploy component structure change handling tests', () => {
    let findInDatabaseStub;
    let databaseConnectionStub;

    beforeEach(() => {
      // Reset global state
      // eslint-disable-next-line global-require
      const globalState = require('../../ZelBack/src/services/utils/globalState');
      globalState.removalInProgress = false;
      globalState.installationInProgress = false;
      globalState.softRedeployInProgress = false;
      globalState.hardRedeployInProgress = false;

      // Setup database connection stub
      databaseConnectionStub = sinon.stub(dbHelper, 'databaseConnection').returns({
        db: () => ({}),
      });
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should escalate to hard redeploy when component count changes for v8+ app', async () => {
      const v8Comp = (name, tag, port) => ({ name, description: '', repotag: tag, ports: [port], containerPorts: [port], domains: [''], environmentParameters: [], commands: [], containerData: '', cpu: 0.5, ram: 500, hdd: 5 });
      const v8Base = { description: 'test', owner: '1abc', instances: 3, contacts: [], geolocation: [], expire: 22000, nodes: [], staticip: false };
      const installedApp = {
        ...v8Base,
        name: 'TestApp',
        version: 8,
        compose: [
          v8Comp('frontend', 'repo/frontend:1.0', 30000),
          v8Comp('backend', 'repo/backend:1.0', 30001),
        ],
      };

      const newAppSpecs = {
        ...v8Base,
        name: 'TestApp',
        version: 8,
        compose: [
          v8Comp('frontend', 'repo/frontend:1.0', 30000),
          v8Comp('backend', 'repo/backend:1.0', 30001),
          v8Comp('database', 'repo/database:1.0', 30002),
        ],
      };

      findInDatabaseStub = sinon.stub(dbHelper, 'findInDatabase').resolves([installedApp]);

      // Stub appUninstaller so hardRedeploy doesn't actually try to remove the app
      // eslint-disable-next-line global-require
      const appUninstaller = require('../../ZelBack/src/services/appLifecycle/appUninstaller');
      sinon.stub(appUninstaller, 'removeAppLocally').resolves();

      // Stub appInstaller so hardRedeploy doesn't actually try to install the app
      // eslint-disable-next-line global-require
      const appInstaller = require('../../ZelBack/src/services/appLifecycle/appInstaller');
      sinon.stub(appInstaller, 'checkAppRequirements').resolves();
      sinon.stub(appInstaller, 'registerAppLocally').resolves();

      // Stub serviceHelper.delay so hardRedeploy doesn't wait
      // eslint-disable-next-line global-require
      const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
      sinon.stub(serviceHelper, 'delay').resolves();

      // Create a mock response object
      const res = {
        write: sinon.stub(),
        flush: sinon.stub(),
        end: sinon.stub(),
      };

      await advancedWorkflows.softRedeploy(newAppSpecs, res);

      // Should have called dbHelper.findInDatabase to check for structure changes
      expect(findInDatabaseStub.called).to.be.true;

      // Should have written escalation message to response
      expect(res.write.called).to.be.true;
      const messages = res.write.getCalls().map(call => call.args[0]);
      const escalationMessage = messages.find(msg => msg.includes('Component structure changed'));
      expect(escalationMessage).to.exist;
      expect(escalationMessage).to.include('hard redeploy');
    });

    it('should escalate to hard redeploy when component names change for v8+ app', async () => {
      const v8Comp = (name, tag, port) => ({ name, description: '', repotag: tag, ports: [port], containerPorts: [port], domains: [''], environmentParameters: [], commands: [], containerData: '', cpu: 0.5, ram: 500, hdd: 5 });
      const v8Base = { description: 'test', owner: '1abc', instances: 3, contacts: [], geolocation: [], expire: 22000, nodes: [], staticip: false };
      const installedApp = {
        ...v8Base,
        name: 'TestApp',
        version: 8,
        compose: [
          v8Comp('frontend', 'repo/frontend:1.0', 30000),
          v8Comp('backend', 'repo/backend:1.0', 30001),
        ],
      };

      const newAppSpecs = {
        ...v8Base,
        name: 'TestApp',
        version: 8,
        compose: [
          v8Comp('frontend', 'repo/frontend:1.0', 30000),
          v8Comp('api', 'repo/api:1.0', 30001),
        ],
      };

      findInDatabaseStub = sinon.stub(dbHelper, 'findInDatabase').resolves([installedApp]);

      // Stub appUninstaller so hardRedeploy doesn't actually try to remove the app
      // eslint-disable-next-line global-require
      const appUninstaller = require('../../ZelBack/src/services/appLifecycle/appUninstaller');
      sinon.stub(appUninstaller, 'removeAppLocally').resolves();

      // Stub appInstaller so hardRedeploy doesn't actually try to install the app
      // eslint-disable-next-line global-require
      const appInstaller = require('../../ZelBack/src/services/appLifecycle/appInstaller');
      sinon.stub(appInstaller, 'checkAppRequirements').resolves();
      sinon.stub(appInstaller, 'registerAppLocally').resolves();

      // Stub serviceHelper.delay so hardRedeploy doesn't wait
      // eslint-disable-next-line global-require
      const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
      sinon.stub(serviceHelper, 'delay').resolves();

      const res = {
        write: sinon.stub(),
        flush: sinon.stub(),
        end: sinon.stub(),
      };

      await advancedWorkflows.softRedeploy(newAppSpecs, res);

      // Should have called dbHelper.findInDatabase to check for structure changes
      expect(findInDatabaseStub.called).to.be.true;

      // Should have written escalation message to response
      expect(res.write.called).to.be.true;
      const messages = res.write.getCalls().map(call => call.args[0]);
      const escalationMessage = messages.find(msg => msg.includes('Component structure changed'));
      expect(escalationMessage).to.exist;
      expect(escalationMessage).to.include('hard redeploy');
    });

    it('should proceed with normal soft redeploy when no component structure changes', async () => {
      const installedApp = {
        name: 'TestApp',
        version: 8,
        compose: [
          { name: 'frontend', repotag: 'repo/frontend:1.0' },
          { name: 'backend', repotag: 'repo/backend:1.0' },
        ],
      };

      const newAppSpecs = {
        name: 'TestApp',
        version: 8,
        compose: [
          { name: 'frontend', repotag: 'repo/frontend:2.0' }, // Only tag changed
          { name: 'backend', repotag: 'repo/backend:2.0' }, // Only tag changed
        ],
      };

      // Stub dbHelper.findInDatabase to return the installed app
      findInDatabaseStub = sinon.stub(dbHelper, 'findInDatabase').resolves([installedApp]);

      // Mock other required dependencies for soft redeploy
      sinon.stub(advancedWorkflows, 'softRemoveAppLocally').resolves();
      sinon.stub(advancedWorkflows, 'softRegisterAppLocally').resolves();

      // Stub appInstaller.checkAppRequirements so softRedeploy doesn't validate real env
      // eslint-disable-next-line global-require
      const appInstaller = require('../../ZelBack/src/services/appLifecycle/appInstaller');
      sinon.stub(appInstaller, 'checkAppRequirements').resolves();

      const clock = sinon.useFakeTimers();

      const res = {
        write: sinon.stub(),
        flush: sinon.stub(),
        end: sinon.stub(),
      };

      const softRedeployPromise = advancedWorkflows.softRedeploy(newAppSpecs, res);
      await clock.tickAsync(31 * 1000);
      await softRedeployPromise;

      expect(findInDatabaseStub.called).to.be.true;

      // Should not have written escalation message to response
      const messages = res.write.getCalls().map(call => call.args[0]);
      const escalationMessage = messages.find(msg => msg.includes('Component structure changed'));
      expect(escalationMessage).to.not.exist;
    });

    it('should not check component structure for v4-7 apps during soft redeploy', async () => {
      const installedApp = {
        name: 'TestApp',
        version: 7,
        compose: [
          { name: 'frontend', repotag: 'repo/frontend:1.0' },
          { name: 'backend', repotag: 'repo/backend:1.0' },
        ],
      };

      const newAppSpecs = {
        name: 'TestApp',
        version: 7,
        compose: [
          { name: 'frontend', repotag: 'repo/frontend:2.0' },
          { name: 'backend', repotag: 'repo/backend:2.0' },
        ],
      };

      findInDatabaseStub = sinon.stub(dbHelper, 'findInDatabase').resolves([installedApp]);

      // Mock other required dependencies
      sinon.stub(advancedWorkflows, 'softRemoveAppLocally').resolves();
      sinon.stub(advancedWorkflows, 'softRegisterAppLocally').resolves();

      // Stub appInstaller.checkAppRequirements so softRedeploy doesn't validate real env
      // eslint-disable-next-line global-require
      const appInstaller = require('../../ZelBack/src/services/appLifecycle/appInstaller');
      sinon.stub(appInstaller, 'checkAppRequirements').resolves();

      const clock = sinon.useFakeTimers();

      const res = {
        write: sinon.stub(),
        flush: sinon.stub(),
        end: sinon.stub(),
      };

      const softRedeployPromise = advancedWorkflows.softRedeploy(newAppSpecs, res);
      await clock.tickAsync(31 * 1000);
      await softRedeployPromise;

      // For v4-7 apps, component structure checks are not applicable.
      expect(findInDatabaseStub.called).to.be.false;
    });

    it('should not escalate to hard redeploy when enterprise compose is redacted in local DB', async () => {
      const installedApp = {
        name: 'TestApp',
        version: 8,
        enterprise: 'encryptedEnterprisePayload',
        compose: [], // Redacted in local DB
        hash: 'testhash',
      };

      const newAppSpecs = {
        name: 'TestApp',
        version: 8,
        compose: [
          { name: 'frontend', repotag: 'repo/frontend:2.0' },
          { name: 'backend', repotag: 'repo/backend:2.0' },
        ],
      };

      findInDatabaseStub = sinon.stub(dbHelper, 'findInDatabase').resolves([installedApp]);

      sinon.stub(advancedWorkflows, 'softRemoveAppLocally').resolves();
      sinon.stub(advancedWorkflows, 'softRegisterAppLocally').resolves();

      // Stub appInstaller.checkAppRequirements so softRedeploy doesn't validate real env
      // eslint-disable-next-line global-require
      const appInstaller = require('../../ZelBack/src/services/appLifecycle/appInstaller');
      sinon.stub(appInstaller, 'checkAppRequirements').resolves();

      const clock = sinon.useFakeTimers();

      const res = {
        write: sinon.stub(),
        flush: sinon.stub(),
        end: sinon.stub(),
      };

      const softRedeployPromise = advancedWorkflows.softRedeploy(newAppSpecs, res);
      await clock.tickAsync(31 * 1000);
      await softRedeployPromise;

      expect(findInDatabaseStub.called).to.be.true;

      const messages = res.write.getCalls().map(call => call.args[0]);
      const escalationMessage = messages.find(msg => msg.includes('Component structure changed'));
      expect(escalationMessage).to.not.exist;
    });
  });

  // Note: verifyAppUpdateParameters, createAppVolume,
  // getPeerAppsInstallingErrorMessages, and stopSyncthingApp are
  // complex integration functions or HTTP request handlers that require extensive
  // mocking of database connections, HTTP requests, and external services.
  // These should be tested in integration tests rather than unit tests.
  // masterSlaveApps is included above with basic tests, but full integration testing
  // is recommended for comprehensive coverage of the master-slave coordination logic.
});
