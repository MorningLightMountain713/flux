const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('peerNotification tests', () => {
  let peerNotification;
  let logStub;
  let dockerServiceStub;
  let appInstallerStub;
  let appUninstallerStub;
  let appInspectorStub;
  let deploymentProviderStub;

  beforeEach(() => {
    logStub = {
      error: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
    };

    dockerServiceStub = {
      getDockerContainerOnly: sinon.stub().resolves(null),
    };

    appInstallerStub = {
      installComponent: sinon.stub().resolves(),
    };

    appUninstallerStub = {
      uninstallApplication: sinon.stub().resolves(),
    };

    appInspectorStub = {
      startAppMonitoring: sinon.stub(),
      stopAppMonitoring: sinon.stub(),
    };

    deploymentProviderStub = {
      getInstalledDeployment: sinon.stub().resolves(null),
    };

    peerNotification = proxyquire('../../ZelBack/src/services/appMessaging/peerNotification', {
      '../dockerService': dockerServiceStub,
      '../generalService': {
        isNodeStatusConfirmed: sinon.stub().resolves(true),
        nodeTier: sinon.stub().resolves('cumulus'),
      },
      '../benchmarkService': {
        getBenchmarks: sinon.stub().resolves({
          status: 'success',
          data: { ipaddress: '192.168.1.1' },
        }),
      },
      '../geolocationService': {
        isStaticIP: sinon.stub().returns(true),
      },
      '../fluxCommunicationMessagesSender': {
        broadcastMessageToOutgoing: sinon.stub().resolves(),
        broadcastMessageToIncoming: sinon.stub().resolves(),
        broadcastMessageToAll: sinon.stub().resolves(),
      },
      './messageStore': {
        storeAppRunningMessage: sinon.stub().resolves(),
      },
      '../appDatabase/registryManager': {
        getApplicationGlobalSpecifications: sinon.stub().resolves(null),
      },
      '../appDatabase/appsRepository': {
        listInstalledApps: sinon.stub().resolves([]),
        getAppLocation: sinon.stub().resolves(null),
      },
      '../appManagement/appInspector': appInspectorStub,
      '../appLifecycle/appUninstaller': appUninstallerStub,
      '../appLifecycle/appInstaller': appInstallerStub,
      '../appRuntime/deploymentProvider': deploymentProviderStub,
      '../appQuery/appQueryService': {
        listRunningContainers: sinon.stub().resolves([]),
      },
      '../utils/globalState': {
        backupInProgress: [],
        restoreInProgress: [],
        appsMonitored: new Map(),
      },
      '../../lib/log': logStub,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('checkAndNotifyPeersOfRunningApps', () => {
    it('should be exported as a function', () => {
      expect(peerNotification.checkAndNotifyPeersOfRunningApps).to.be.a('function');
    });
  });

  describe('handleMissingMasterSlaveContainer', () => {
    it('should return early if container exists', async () => {
      dockerServiceStub.getDockerContainerOnly.resolves({ Id: 'abc123' });

      await peerNotification.handleMissingMasterSlaveContainer(
        'MyComponent_testapp', 'testapp',
      );

      expect(appInstallerStub.installComponent.called).to.be.false;
      expect(appUninstallerStub.uninstallApplication.called).to.be.false;
    });

    it('should recreate container when missing and deployment exists', async () => {
      dockerServiceStub.getDockerContainerOnly.resolves(null);
      const mockComponent = { identifier: 'MyComponent_testapp', name: 'MyComponent' };
      deploymentProviderStub.getInstalledDeployment.resolves({
        componentEntries: () => [['MyComponent', mockComponent]],
      });

      await peerNotification.handleMissingMasterSlaveContainer(
        'MyComponent_testapp', 'testapp',
      );

      expect(appInstallerStub.installComponent.calledOnce).to.be.true;
      expect(appInstallerStub.installComponent.firstCall.args[0]).to.equal(mockComponent);
      expect(appInspectorStub.startAppMonitoring.calledWith('MyComponent_testapp')).to.be.true;
      expect(appUninstallerStub.uninstallApplication.called).to.be.false;
    });

    it('should remove app when recreation fails and container still missing', async () => {
      dockerServiceStub.getDockerContainerOnly.resolves(null);
      deploymentProviderStub.getInstalledDeployment.resolves(null);

      await peerNotification.handleMissingMasterSlaveContainer(
        'MyComponent_testapp', 'testapp',
      );

      expect(appUninstallerStub.uninstallApplication.calledOnce).to.be.true;
      expect(appUninstallerStub.uninstallApplication.firstCall.args[0]).to.equal('testapp');
      expect(logStub.warn.calledWithMatch(/REMOVAL REASON/)).to.be.true;
    });

    it('should skip removal when recreation fails but container was created by another process', async () => {
      dockerServiceStub.getDockerContainerOnly
        .onFirstCall().resolves(null)
        .onSecondCall().resolves({ Id: 'abc123' });
      deploymentProviderStub.getInstalledDeployment.resolves(null);

      await peerNotification.handleMissingMasterSlaveContainer(
        'MyComponent_testapp', 'testapp',
      );

      expect(appUninstallerStub.uninstallApplication.called).to.be.false;
      expect(logStub.info.calledWithMatch(/created by another process/)).to.be.true;
    });
  });
});
