const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('monitoringOrchestrator tests', () => {
  let monitoringOrchestrator;
  let appInspectorStub;
  let getInstalledDeploymentsStub;
  let listInstalledDeploymentsStub;
  let logStub;

  beforeEach(() => {
    appInspectorStub = {
      startAppMonitoring: sinon.stub(),
    };

    getInstalledDeploymentsStub = sinon.stub().resolves([]);
    listInstalledDeploymentsStub = sinon.stub().resolves([]);

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
      '../appRuntime/deploymentProvider': {
        getInstalledDeployments: getInstalledDeploymentsStub,
        listInstalledDeployments: listInstalledDeploymentsStub,
      },
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

      await monitoringOrchestrator.startMonitoringOfApps(apps);

      sinon.assert.calledThrice(appInspectorStub.startAppMonitoring);
      sinon.assert.calledWith(appInspectorStub.startAppMonitoring, 'App1');
      sinon.assert.calledWith(appInspectorStub.startAppMonitoring, 'App2');
      sinon.assert.calledWith(appInspectorStub.startAppMonitoring, 'App3');
    });

    it('should start monitoring for multi-component apps', async () => {
      const apps = [{ name: 'ComposedApp' }];

      getInstalledDeploymentsStub.resolves([mockDeployment(['Component1_ComposedApp', 'Component2_ComposedApp'])]);

      await monitoringOrchestrator.startMonitoringOfApps(apps);

      sinon.assert.calledTwice(appInspectorStub.startAppMonitoring);
      sinon.assert.calledWith(appInspectorStub.startAppMonitoring, 'Component1_ComposedApp');
      sinon.assert.calledWith(appInspectorStub.startAppMonitoring, 'Component2_ComposedApp');
    });

    it('monitors every installed deployment when no apps are given', async () => {
      listInstalledDeploymentsStub.resolves([mockDeployment(['App1'])]);

      await monitoringOrchestrator.startMonitoringOfApps();

      sinon.assert.calledOnce(listInstalledDeploymentsStub);
      sinon.assert.notCalled(getInstalledDeploymentsStub);
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

      await monitoringOrchestrator.startMonitoringOfApps(apps);

      sinon.assert.calledOnce(appInspectorStub.startAppMonitoring);
      sinon.assert.calledWith(appInspectorStub.startAppMonitoring, 'GoodApp');
    });

    it('should handle errors gracefully', async () => {
      getInstalledDeploymentsStub.rejects(new Error('deployment resolution failed'));

      await monitoringOrchestrator.startMonitoringOfApps([{ name: 'App1' }]);

      sinon.assert.calledOnce(logStub.error);
      sinon.assert.notCalled(appInspectorStub.startAppMonitoring);
    });
  });
});
