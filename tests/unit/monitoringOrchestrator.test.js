'use strict';

const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('monitoringOrchestrator tests', () => {
  let monitoringOrchestrator;
  let appInspectorStub;
  let getInstalledDeploymentsStub;
  let logStub;

  beforeEach(() => {
    appInspectorStub = {
      startAppMonitoring: sinon.stub(),
      stopAppMonitoring: sinon.stub(),
    };

    getInstalledDeploymentsStub = sinon.stub().resolves([]);

    logStub = {
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
    };

    monitoringOrchestrator = proxyquire('../../ZelBack/src/services/appMonitoring/monitoringOrchestrator', {
      '../messageHelper': {
        createSuccessMessage: sinon.stub().returnsArg(0),
        createErrorMessage: sinon.stub().returnsArg(0),
        errUnauthorizedMessage: sinon.stub().returns('Unauthorized'),
      },
      '../serviceHelper': { ensureString: sinon.stub().returnsArg(0) },
      '../verificationHelper': { verifyPrivilege: sinon.stub().resolves(true) },
      '../appManagement/appInspector': appInspectorStub,
      '../appRuntime/deploymentProvider': { getInstalledDeployments: getInstalledDeploymentsStub },
      '../../lib/log': logStub,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  function mockDeployment(componentIdentifiers) {
    return {
      componentEntries: () => componentIdentifiers.map((id) => {
        const name = id.includes('_') ? id.split('_')[0] : id;
        return [name, { identifier: id }];
      }),
    };
  }

  describe('startMonitoringOfApps tests', () => {
    it('should start monitoring for single-component apps', async () => {
      const apps = [
        { name: 'App1' },
        { name: 'App2' },
        { name: 'App3' },
      ];

      getInstalledDeploymentsStub
        .onFirstCall().resolves([mockDeployment(['App1'])])
        .onSecondCall().resolves([mockDeployment(['App2'])])
        .onThirdCall().resolves([mockDeployment(['App3'])]);

      const appsMonitored = {};
      await monitoringOrchestrator.startMonitoringOfApps(apps, appsMonitored, null);

      sinon.assert.calledThrice(appInspectorStub.startAppMonitoring);
      sinon.assert.calledWith(appInspectorStub.startAppMonitoring, 'App1', appsMonitored);
      sinon.assert.calledWith(appInspectorStub.startAppMonitoring, 'App2', appsMonitored);
      sinon.assert.calledWith(appInspectorStub.startAppMonitoring, 'App3', appsMonitored);
    });

    it('should start monitoring for multi-component apps', async () => {
      const apps = [{ name: 'ComposedApp' }];

      getInstalledDeploymentsStub.resolves([mockDeployment(['Component1_ComposedApp', 'Component2_ComposedApp'])]);

      const appsMonitored = {};
      await monitoringOrchestrator.startMonitoringOfApps(apps, appsMonitored, null);

      sinon.assert.calledTwice(appInspectorStub.startAppMonitoring);
      sinon.assert.calledWith(appInspectorStub.startAppMonitoring, 'Component1_ComposedApp', appsMonitored);
      sinon.assert.calledWith(appInspectorStub.startAppMonitoring, 'Component2_ComposedApp', appsMonitored);
    });

    it('should get installed apps if no apps provided', async () => {
      const apps = [{ name: 'App1' }];
      const installedAppsFn = sinon.stub().resolves({ status: 'success', data: apps });

      getInstalledDeploymentsStub.resolves([mockDeployment(['App1'])]);

      const appsMonitored = {};
      await monitoringOrchestrator.startMonitoringOfApps(null, appsMonitored, installedAppsFn);

      sinon.assert.calledOnce(installedAppsFn);
      sinon.assert.calledOnce(appInspectorStub.startAppMonitoring);
    });

    it('should skip apps that fail to resolve', async () => {
      const apps = [
        { name: 'GoodApp' },
        { name: 'BadApp' },
      ];

      getInstalledDeploymentsStub
        .onFirstCall().resolves([mockDeployment(['GoodApp'])])
        .onSecondCall().resolves([]);

      const appsMonitored = {};
      await monitoringOrchestrator.startMonitoringOfApps(apps, appsMonitored, null);

      sinon.assert.calledOnce(appInspectorStub.startAppMonitoring);
      sinon.assert.calledWith(appInspectorStub.startAppMonitoring, 'GoodApp', appsMonitored);
    });

    it('should handle errors gracefully', async () => {
      getInstalledDeploymentsStub.rejects(new Error('deployment resolution failed'));

      await monitoringOrchestrator.startMonitoringOfApps([{ name: 'App1' }], {}, null);

      sinon.assert.calledOnce(logStub.error);
      sinon.assert.notCalled(appInspectorStub.startAppMonitoring);
    });
  });

  describe('stopMonitoringOfApps tests', () => {
    it('should stop monitoring for single-component apps', async () => {
      const apps = [{ name: 'App1' }];

      getInstalledDeploymentsStub.resolves([mockDeployment(['App1'])]);

      const appsMonitored = {};
      await monitoringOrchestrator.stopMonitoringOfApps(apps, false, appsMonitored, null);

      sinon.assert.calledOnce(appInspectorStub.stopAppMonitoring);
      sinon.assert.calledWith(appInspectorStub.stopAppMonitoring, 'App1', false, appsMonitored);
    });

    it('should stop monitoring for multi-component apps', async () => {
      const apps = [{ name: 'ComposedApp' }];

      getInstalledDeploymentsStub.resolves([mockDeployment(['Component1_ComposedApp', 'Component2_ComposedApp'])]);

      const appsMonitored = {};
      await monitoringOrchestrator.stopMonitoringOfApps(apps, true, appsMonitored, null);

      sinon.assert.calledTwice(appInspectorStub.stopAppMonitoring);
      sinon.assert.calledWith(appInspectorStub.stopAppMonitoring, 'Component1_ComposedApp', true, appsMonitored);
      sinon.assert.calledWith(appInspectorStub.stopAppMonitoring, 'Component2_ComposedApp', true, appsMonitored);
    });

    it('should get installed apps if no apps provided', async () => {
      const apps = [{ name: 'App1' }];
      const installedAppsFn = sinon.stub().resolves({ status: 'success', data: apps });

      getInstalledDeploymentsStub.resolves([mockDeployment(['App1'])]);

      const appsMonitored = {};
      await monitoringOrchestrator.stopMonitoringOfApps(null, false, appsMonitored, installedAppsFn);

      sinon.assert.calledOnce(installedAppsFn);
      sinon.assert.calledOnce(appInspectorStub.stopAppMonitoring);
    });
  });
});
