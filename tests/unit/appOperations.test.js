// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const appOperations = require('../../ZelBack/src/services/appLifecycle/appOperations');
const appSpecHistory = require('../../ZelBack/src/services/appDatabase/appSpecHistory');
const appVolumeService = require('../../ZelBack/src/services/appLifecycle/appVolumeService');
const appInstaller = require('../../ZelBack/src/services/appLifecycle/appInstaller');
const appUninstaller = require('../../ZelBack/src/services/appLifecycle/appUninstaller');
const deploymentProvider = require('../../ZelBack/src/services/appRuntime/deploymentProvider');
const dbHelper = require('../../ZelBack/src/services/dbHelper');

describe('appOperations tests', () => {
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
      appOperations.setInstallationInProgressTrue();

      const inProgress = appOperations.getInstallationInProgress();
      expect(inProgress).to.be.true;
    });

    it('should reset installation in progress', () => {
      appOperations.setInstallationInProgressTrue();
      appOperations.installationInProgressReset();

      const inProgress = appOperations.getInstallationInProgress();
      expect(inProgress).to.be.false;
    });

    it('should set specific app installation in progress', () => {
      appOperations.setInstallationInProgress('TestApp', true);

      const inProgress = appOperations.getInstallationInProgress();
      // When setting specific app, function returns the app name, not just true
      expect(inProgress).to.equal('TestApp');
    });
  });

  describe('setRemovalInProgress and getRemovalInProgress tests', () => {
    it('should set removal in progress', () => {
      appOperations.setRemovalInProgressToTrue();

      const inProgress = appOperations.getRemovalInProgress();
      expect(inProgress).to.be.true;
    });

    it('should reset removal in progress', () => {
      appOperations.setRemovalInProgressToTrue();
      appOperations.removalInProgressReset();

      const inProgress = appOperations.getRemovalInProgress();
      expect(inProgress).to.be.false;
    });

    it('should set specific app removal in progress', () => {
      appOperations.setRemovalInProgress('TestApp', true);

      const inProgress = appOperations.getRemovalInProgress();
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
      appOperations.addToRestoreProgress('TestApp');

      // eslint-disable-next-line global-require
      const globalState = require('../../ZelBack/src/services/utils/globalState');
      expect(globalState.restoreInProgress).to.include('TestApp');
    });

    it('should remove app from restore progress', () => {
      appOperations.addToRestoreProgress('TestApp');
      appOperations.removeFromRestoreProgress('TestApp');

      // eslint-disable-next-line global-require
      const globalState = require('../../ZelBack/src/services/utils/globalState');
      expect(globalState.restoreInProgress).to.not.include('TestApp');
    });

    it('should not duplicate apps in restore progress', () => {
      appOperations.addToRestoreProgress('TestApp');
      appOperations.addToRestoreProgress('TestApp');

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

      await appOperations.redeployComponentAPI(req, res);

      expect(res.json.calledOnce).to.be.true;
      const response = res.json.firstCall.args[0];
      expect(response.status).to.equal('error');
      expect(response.data.message).to.include('No Flux App specified');
    });

    it('should return error if component is not provided', async () => {
      req.params.appname = 'myapp';

      await appOperations.redeployComponentAPI(req, res);

      expect(res.json.calledOnce).to.be.true;
      const response = res.json.firstCall.args[0];
      expect(response.status).to.equal('error');
      expect(response.data.message).to.include('No component specified');
    });

    it('should return error if appname contains underscore', async () => {
      req.params.appname = 'frontend_myapp';
      req.params.component = 'frontend';

      await appOperations.redeployComponentAPI(req, res);

      expect(res.json.calledOnce).to.be.true;
      const response = res.json.firstCall.args[0];
      expect(response.status).to.equal('error');
      expect(response.data.message).to.include('Invalid app name format');
    });

    it('should skip redeploy if app is in restore progress', async () => {
      req.params.appname = 'myapp';
      req.params.component = 'frontend';

      // Use the proper method to add to restore progress
      appOperations.addToRestoreProgress('myapp');

      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);

      await appOperations.redeployComponentAPI(req, res);

      expect(res.json.calledOnce).to.be.true;
      const response = res.json.firstCall.args[0];
      expect(response.status).to.equal('warning');
      expect(response.data.message).to.include('Restore is running');

      // Clean up
      appOperations.removeFromRestoreProgress('myapp');
    });

    it('should return unauthorized error if not authorized', async () => {
      req.params.appname = 'myapp';
      req.params.component = 'frontend';

      sinon.stub(verificationHelper, 'verifyPrivilege').resolves(false);

      await appOperations.redeployComponentAPI(req, res);

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

      await appOperations.redeployComponentAPI(req, res);

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
      await appOperations.redeployComponent('myapp', 'frontend', { onStatus: (msg) => messages.push(msg) });
      expect(messages).to.have.lengthOf(1);
      expect(messages[0]).to.include('Another operation is in progress');
    });

    it('should return early if installation is in progress', async () => {
      globalState.installationInProgress = true;
      const messages = [];
      await appOperations.redeployComponent('myapp', 'frontend', { onStatus: (msg) => messages.push(msg) });
      expect(messages).to.have.lengthOf(1);
      expect(messages[0]).to.include('Another operation is in progress');
    });

    it('should return early if soft redeploy is in progress', async () => {
      globalState.softRedeployInProgress = true;
      const messages = [];
      await appOperations.redeployComponent('myapp', 'frontend', { onStatus: (msg) => messages.push(msg) });
      expect(messages).to.have.lengthOf(1);
      expect(messages[0]).to.include('Another operation is in progress');
    });

    it('should return early if hard redeploy is in progress', async () => {
      globalState.hardRedeployInProgress = true;
      const messages = [];
      await appOperations.redeployComponent('myapp', 'frontend', { onStatus: (msg) => messages.push(msg) });
      expect(messages).to.have.lengthOf(1);
      expect(messages[0]).to.include('Another operation is in progress');
    });

    it('should call uninstallApplication when application not found', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(null);
      sinon.stub(appUninstaller, 'uninstallApplication').resolves();

      await appOperations.redeployComponent('myapp', 'frontend', { onStatus: () => {} });

      expect(globalState.softRedeployInProgress).to.be.false;
      expect(appUninstaller.uninstallApplication.calledOnce).to.be.true;
    });

    it('should call uninstallApplication when component not found in app', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves({
        getComponent: () => null,
      });
      sinon.stub(appUninstaller, 'uninstallApplication').resolves();

      await appOperations.redeployComponent('myapp', 'frontend', { onStatus: () => {} });

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
      await appOperations.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: (msg) => messages.push(msg) });
      expect(messages).to.have.lengthOf(1);
      expect(messages[0]).to.include('Another operation is in progress');
    });

    it('should return early if installation is in progress', async () => {
      globalState.installationInProgress = true;
      const messages = [];
      await appOperations.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: (msg) => messages.push(msg) });
      expect(messages).to.have.lengthOf(1);
      expect(messages[0]).to.include('Another operation is in progress');
    });

    it('should return early if soft redeploy is in progress', async () => {
      globalState.softRedeployInProgress = true;
      const messages = [];
      await appOperations.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: (msg) => messages.push(msg) });
      expect(messages).to.have.lengthOf(1);
      expect(messages[0]).to.include('Another operation is in progress');
    });

    it('should return early if hard redeploy is in progress', async () => {
      globalState.hardRedeployInProgress = true;
      const messages = [];
      await appOperations.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: (msg) => messages.push(msg) });
      expect(messages).to.have.lengthOf(1);
      expect(messages[0]).to.include('Another operation is in progress');
    });

    it('should call uninstallApplication when application not found', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(null);
      sinon.stub(appUninstaller, 'uninstallApplication').resolves();

      await appOperations.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: () => {} });

      expect(globalState.hardRedeployInProgress).to.be.false;
      expect(appUninstaller.uninstallApplication.calledOnce).to.be.true;
    });

    it('should call uninstallApplication when component not found in app', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves({
        getComponent: () => null,
      });
      sinon.stub(appUninstaller, 'uninstallApplication').resolves();

      await appOperations.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: () => {} });

      expect(globalState.hardRedeployInProgress).to.be.false;
      expect(appUninstaller.uninstallApplication.calledOnce).to.be.true;
    });

    it('should reset hardRedeployInProgress on error', async () => {
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(null);
      sinon.stub(appUninstaller, 'uninstallApplication').resolves();

      await appOperations.redeployComponent('myapp', 'frontend', { createVolumes: true, onStatus: () => {} });

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

      await appOperations.coordinateActiveStandbyApps();

      expect(deploymentProviderStub.called).to.be.false;
    });

    it('should skip execution if removal is in progress', async () => {
      globalStateRef.removalInProgress = true;

      await appOperations.coordinateActiveStandbyApps();

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

      await appOperations.coordinateActiveStandbyApps();

      expect(deploymentProviderStub.called).to.be.true;
      expect(axiosGetStub.called).to.be.false;
      globalStateRef.backupInProgress.length = 0;
    });

    it('stops only the g: component on a standby node, leaving non-g siblings running', async () => {
      const appName = 'n8napp';
      const dockerService = require('../../ZelBack/src/services/dockerService');
      dockerServiceStub.returns('fluxn8n_n8napp');
      const appDockerStopStub = sinon.stub(dockerService, 'appDockerStop').resolves();

      // Mixed compose app: n8n uses g: master/slave, pgcluster needs all instances running
      const installedApps = sinon.stub().resolves({
        status: 'success',
        data: [
          {
            name: appName,
            version: 8,
            compose: [
              { name: 'n8n', containerData: 'g:/home/node/.n8n' },
              { name: 'pgcluster', containerData: '/var/lib/postgresql/data' },
            ],
          },
        ],
      });
      // Both components currently running on this node
      const listRunningApps = sinon.stub().resolves({
        status: 'success',
        data: [
          { Names: ['/fluxn8n_n8napp'] },
          { Names: ['/fluxpgcluster_n8napp'] },
        ],
      });

      const receiveOnlyCache = new Map();
      const https = require('https');

      // FDM reports the primary is another node
      serviceHelperStub.resolves({ data: { status: 'success', data: { ips: ['192.168.1.99'] } } });
      // This node's address differs from the FDM primary -> we are a standby
      fluxNetworkHelperStub.resolves('192.168.1.5:16127');

      await advancedWorkflows.masterSlaveApps(
        globalState,
        installedApps,
        listRunningApps,
        receiveOnlyCache,
        [],
        [],
        https,
      );

      // Only the g: component must be stopped - not the whole app, not the pgcluster sibling
      expect(appDockerStopStub.calledWith('n8n_n8napp')).to.be.true;
      expect(appDockerStopStub.neverCalledWith('pgcluster_n8napp')).to.be.true;
      expect(appDockerStopStub.neverCalledWith(appName)).to.be.true;
    });

    it('does not stop anything on a standby node when the g: component is already stopped', async () => {
      const appName = 'n8napp';
      const dockerService = require('../../ZelBack/src/services/dockerService');
      dockerServiceStub.returns('fluxn8n_n8napp');
      const appDockerStopStub = sinon.stub(dockerService, 'appDockerStop').resolves();

      const installedApps = sinon.stub().resolves({
        status: 'success',
        data: [
          {
            name: appName,
            version: 8,
            compose: [
              { name: 'n8n', containerData: 'g:/home/node/.n8n' },
              { name: 'pgcluster', containerData: '/var/lib/postgresql/data' },
            ],
          },
        ],
      });
      // Steady state on a standby: only the non-g component is running
      const listRunningApps = sinon.stub().resolves({
        status: 'success',
        data: [
          { Names: ['/fluxpgcluster_n8napp'] },
        ],
      });

      const receiveOnlyCache = new Map();
      const https = require('https');

      // FDM reports the primary is another node
      serviceHelperStub.resolves({ data: { status: 'success', data: { ips: ['192.168.1.99'] } } });
      fluxNetworkHelperStub.resolves('192.168.1.5:16127');

      await advancedWorkflows.masterSlaveApps(
        globalState,
        installedApps,
        listRunningApps,
        receiveOnlyCache,
        [],
        [],
        https,
      );

      // The g: component is not running here and we are not primary - nothing to stop.
      // The running pgcluster sibling must be left alone.
      expect(appDockerStopStub.called).to.be.false;
    });

    it('does NOT stop its own container when it is the primary on a UPnP (non-default) port', async () => {
      // Regression: FDM returns a bare master IP (production format). A UPnP node (e.g.
      // :16157) that IS the primary must recognise itself and keep running. The pre-fix
      // code compared with socketAddressesMatch, which normalized the bare IP to :16127,
      // failed to match its own :16157 socket, and repeatedly stopped its own container
      // (start/stop flap loop). ipsMatch compares on IP only, so it matches.
      const appName = 'valheim1777035136949';
      const dockerService = require('../../ZelBack/src/services/dockerService');
      dockerServiceStub.returns('fluxvalheim_valheim1777035136949');
      const appDockerStopStub = sinon.stub(dockerService, 'appDockerStop').resolves();

      // Compose app with a g: component so the identifier is component_app: this makes the
      // (mistaken) stop call hit dockerService.appDockerStop directly, so the assertion
      // actually observes the bug if it regresses.
      const installedApps = sinon.stub().resolves({
        status: 'success',
        data: [
          {
            name: appName,
            version: 8,
            compose: [
              { name: 'valheim', containerData: 'g:/root/.config/valheim' },
            ],
          },
        ],
      });
      // The g: component is currently running on this node (it is the primary).
      const listRunningApps = sinon.stub().resolves({
        status: 'success',
        data: [
          { Names: ['/fluxvalheim_valheim1777035136949'] },
        ],
      });

      const receiveOnlyCache = new Map();
      const https = require('https');

      // FDM returns a bare IP (current production behavior - no FDM change required).
      serviceHelperStub.resolves({ data: { status: 'success', data: { ips: ['90.228.196.203'] } } });
      // This node's API socket is on a non-default UPnP port at the same IP -> we are the primary.
      fluxNetworkHelperStub.resolves('90.228.196.203:16157');

      await advancedWorkflows.masterSlaveApps(
        globalState,
        installedApps,
        listRunningApps,
        receiveOnlyCache,
        [],
        [],
        https,
      );

      // We are the primary - the container must be left running, never stopped.
      expect(appDockerStopStub.called).to.be.false;
    });

    it('stops the g: component on a UPnP standby when FDM names a different primary IP', async () => {
      // Guards the inverse: a genuine standby (different IP, itself on a non-default port)
      // must still be detected and stopped - ipsMatch must not over-match across IPs.
      const appName = 'n8napp';
      const dockerService = require('../../ZelBack/src/services/dockerService');
      dockerServiceStub.returns('fluxn8n_n8napp');
      const appDockerStopStub = sinon.stub(dockerService, 'appDockerStop').resolves();

      const installedApps = sinon.stub().resolves({
        status: 'success',
        data: [
          {
            name: appName,
            version: 8,
            compose: [
              { name: 'n8n', containerData: 'g:/home/node/.n8n' },
              { name: 'pgcluster', containerData: '/var/lib/postgresql/data' },
            ],
          },
        ],
      });
      const listRunningApps = sinon.stub().resolves({
        status: 'success',
        data: [
          { Names: ['/fluxn8n_n8napp'] },
          { Names: ['/fluxpgcluster_n8napp'] },
        ],
      });

      const receiveOnlyCache = new Map();
      const https = require('https');

      // FDM primary is a different node, returned as a bare IP (production format).
      serviceHelperStub.resolves({ data: { status: 'success', data: { ips: ['192.168.1.99'] } } });
      // This node has a different IP (and its own non-default port) -> we are a standby.
      fluxNetworkHelperStub.resolves('192.168.1.5:16137');

      await advancedWorkflows.masterSlaveApps(
        globalState,
        installedApps,
        listRunningApps,
        receiveOnlyCache,
        [],
        [],
        https,
      );

      // Only the g: component is stopped; the non-g sibling is left running.
      expect(appDockerStopStub.calledWith('n8n_n8napp')).to.be.true;
      expect(appDockerStopStub.neverCalledWith('pgcluster_n8napp')).to.be.true;
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
