// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const advancedWorkflows = require('../../ZelBack/src/services/appLifecycle/advancedWorkflows');
const appSpecHistory = require('../../ZelBack/src/services/appDatabase/appSpecHistory');
const appVolumeService = require('../../ZelBack/src/services/appLifecycle/appVolumeService');
const appInstaller = require('../../ZelBack/src/services/appLifecycle/appInstaller');
const appUninstaller = require('../../ZelBack/src/services/appLifecycle/appUninstaller');
const deploymentProvider = require('../../ZelBack/src/services/appRuntime/deploymentProvider');
const dbHelper = require('../../ZelBack/src/services/dbHelper');

describe('advancedWorkflows tests', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('previous spec lookup', () => {
    it('should return null if no previous message found', async () => {
      const specifications = { name: 'NewApp' };
      const verificationTimestamp = Date.now();

      sinon.stub(dbHelper, 'databaseConnection').returns({
        db: () => ({}),
      });
      sinon.stub(dbHelper, 'findInDatabase').resolves([]);

      const result = await appSpecHistory.getPreviousSpec(specifications, verificationTimestamp);
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

  describe('redeployComponent (redeploy) tests', () => {
    let globalState;

    beforeEach(() => {
      // eslint-disable-next-line global-require
      globalState = require('../../ZelBack/src/services/utils/globalState');
      globalState.removalInProgress = false;
      globalState.installationInProgress = false;
      globalState.softRedeployInProgress = false;
      globalState.hardRedeployInProgress = false;
      globalState.reconciliationInProgress = false;
    });

    it('should return early if removal is in progress', async () => {
      globalState.removalInProgress = true;
      const messages = [];
      await advancedWorkflows.redeployComponent('myapp', 'frontend', { onStatus: (msg) => messages.push(msg) });
      expect(messages).to.have.lengthOf(1);
      expect(messages[0]).to.include('Another operation is in progress');
    });

    it('should return early if installation is in progress', async () => {
      globalState.installationInProgress = true;
      const messages = [];
      await advancedWorkflows.redeployComponent('myapp', 'frontend', { onStatus: (msg) => messages.push(msg) });
      expect(messages).to.have.lengthOf(1);
      expect(messages[0]).to.include('Another operation is in progress');
    });

    it('should return early if soft redeploy is in progress', async () => {
      globalState.softRedeployInProgress = true;
      const messages = [];
      await advancedWorkflows.redeployComponent('myapp', 'frontend', { onStatus: (msg) => messages.push(msg) });
      expect(messages).to.have.lengthOf(1);
      expect(messages[0]).to.include('Another operation is in progress');
    });

    it('should return early if hard redeploy is in progress', async () => {
      globalState.hardRedeployInProgress = true;
      const messages = [];
      await advancedWorkflows.redeployComponent('myapp', 'frontend', { onStatus: (msg) => messages.push(msg) });
      expect(messages).to.have.lengthOf(1);
      expect(messages[0]).to.include('Another operation is in progress');
    });

    it('should call uninstallApplication when application not found', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(null);
      sinon.stub(appUninstaller, 'uninstallApplication').resolves();

      await advancedWorkflows.redeployComponent('myapp', 'frontend', { onStatus: () => {} });

      expect(globalState.softRedeployInProgress).to.be.false;
      expect(appUninstaller.uninstallApplication.calledOnce).to.be.true;
    });

    it('should call uninstallApplication when component not found in app', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves({
        getComponent: () => null,
      });
      sinon.stub(appUninstaller, 'uninstallApplication').resolves();

      await advancedWorkflows.redeployComponent('myapp', 'frontend', { onStatus: () => {} });

      expect(globalState.softRedeployInProgress).to.be.false;
      expect(appUninstaller.uninstallApplication.calledOnce).to.be.true;
    });
  });

  describe('redeployComponent (rebuild) tests', () => {
    let globalState;

    beforeEach(() => {
      // eslint-disable-next-line global-require
      globalState = require('../../ZelBack/src/services/utils/globalState');
      globalState.removalInProgress = false;
      globalState.installationInProgress = false;
      globalState.softRedeployInProgress = false;
      globalState.hardRedeployInProgress = false;
      globalState.reconciliationInProgress = false;
    });

    it('should return early if removal is in progress', async () => {
      globalState.removalInProgress = true;
      const messages = [];
      await advancedWorkflows.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: (msg) => messages.push(msg) });
      expect(messages).to.have.lengthOf(1);
      expect(messages[0]).to.include('Another operation is in progress');
    });

    it('should return early if installation is in progress', async () => {
      globalState.installationInProgress = true;
      const messages = [];
      await advancedWorkflows.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: (msg) => messages.push(msg) });
      expect(messages).to.have.lengthOf(1);
      expect(messages[0]).to.include('Another operation is in progress');
    });

    it('should return early if soft redeploy is in progress', async () => {
      globalState.softRedeployInProgress = true;
      const messages = [];
      await advancedWorkflows.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: (msg) => messages.push(msg) });
      expect(messages).to.have.lengthOf(1);
      expect(messages[0]).to.include('Another operation is in progress');
    });

    it('should return early if hard redeploy is in progress', async () => {
      globalState.hardRedeployInProgress = true;
      const messages = [];
      await advancedWorkflows.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: (msg) => messages.push(msg) });
      expect(messages).to.have.lengthOf(1);
      expect(messages[0]).to.include('Another operation is in progress');
    });

    it('should call uninstallApplication when application not found', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(null);
      sinon.stub(appUninstaller, 'uninstallApplication').resolves();

      await advancedWorkflows.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: () => {} });

      expect(globalState.hardRedeployInProgress).to.be.false;
      expect(appUninstaller.uninstallApplication.calledOnce).to.be.true;
    });

    it('should call uninstallApplication when component not found in app', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves({
        getComponent: () => null,
      });
      sinon.stub(appUninstaller, 'uninstallApplication').resolves();

      await advancedWorkflows.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: () => {} });

      expect(globalState.hardRedeployInProgress).to.be.false;
      expect(appUninstaller.uninstallApplication.calledOnce).to.be.true;
    });

    it('should reset hardRedeployInProgress on error', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(null);
      sinon.stub(appUninstaller, 'uninstallApplication').resolves();

      await advancedWorkflows.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: () => {} });

      expect(globalState.hardRedeployInProgress).to.be.false;
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
      return proxyquire('../../ZelBack/src/services/appLifecycle/appVolumeService', {
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

  // coordinateActiveStandbyApps is a recursive function that continuously runs in production.
  // These tests use a counter to prevent infinite recursion after the first iteration.
  describe('coordinateActiveStandbyApps tests', () => {
    let globalStateRef;
    let serviceHelperDelayStub;
    let deploymentProviderStub;
    let listRunningContainersStub;

    beforeEach(() => {
      let recursionCounter = 0;
      globalStateRef = require('../../ZelBack/src/services/utils/globalState');
      globalStateRef.activeStandbyCoordinationRunning = false;
      globalStateRef.installationInProgress = false;
      globalStateRef.removalInProgress = false;
      globalStateRef.softRedeployInProgress = false;
      globalStateRef.hardRedeployInProgress = false;
      globalStateRef.reconciliationInProgress = false;

      const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
      serviceHelperDelayStub = sinon.stub(serviceHelper, 'delay').callsFake(async () => {
        recursionCounter += 1;
        if (recursionCounter > 1) {
          return new Promise(() => {});
        }
        return Promise.resolve();
      });

      const syncthingService = require('../../ZelBack/src/services/syncthingService');
      sinon.stub(syncthingService, 'getHealth').resolves({
        status: 'success',
        data: { status: 'OK' },
      });

      const dp = require('../../ZelBack/src/services/appRuntime/deploymentProvider');
      deploymentProviderStub = sinon.stub(dp, 'listInstalledDeployments').resolves([]);

      const appQueryService = require('../../ZelBack/src/services/appQuery/appQueryService');
      listRunningContainersStub = sinon.stub(appQueryService, 'listRunningContainers').resolves([]);

      sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({}) });
      sinon.stub(dbHelper, 'findOneInDatabase').resolves(null);
    });

    it('should skip execution if installation is in progress', async () => {
      globalStateRef.installationInProgress = true;

      await advancedWorkflows.coordinateActiveStandbyApps();

      expect(deploymentProviderStub.called).to.be.false;
    });

    it('should skip execution if removal is in progress', async () => {
      globalStateRef.removalInProgress = true;

      await advancedWorkflows.coordinateActiveStandbyApps();

      expect(deploymentProviderStub.called).to.be.false;
    });

    it('should skip apps in backup progress', async () => {
      const appName = 'testapp';
      const mockDeployment = {
        appName,
        componentEntries: () => [[appName, {
          identifier: appName,
          hasActiveStandbySyncthing: () => true,
          hasSyncthing: () => true,
        }]],
      };
      deploymentProviderStub.resolves([mockDeployment]);
      globalStateRef.backupInProgress.push(appName);

      const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
      const axiosGetStub = sinon.stub(serviceHelper, 'axiosGet');

      await advancedWorkflows.coordinateActiveStandbyApps();

      expect(deploymentProviderStub.called).to.be.true;
      expect(axiosGetStub.called).to.be.false;
      globalStateRef.backupInProgress.length = 0;
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

  // Note: verifyAppUpdateParameters, createAppVolume,
  // getPeerAppsInstallingErrorMessages, and stopSyncthingApp are
  // complex integration functions or HTTP request handlers that require extensive
  // mocking of database connections, HTTP requests, and external services.
  // These should be tested in integration tests rather than unit tests.
  // masterSlaveApps is included above with basic tests, but full integration testing
  // is recommended for comprehensive coverage of the master-slave coordination logic.
});
