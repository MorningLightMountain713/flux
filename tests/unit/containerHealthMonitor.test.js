const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

// containerHealthMonitor's monitorAndRecoverApps (the old hourly restart
// actuator) was removed by the reconciler rearchitecture — restart/start
// decisions live in appReconciler now (see appReconciler.test.js). What
// remains here is the recreate path: rebuilding a missing container from the
// installed deployment, and the masterSlave wrapper that escalates to removal
// when recreation is impossible. Component sizing (tier overrides) happens
// inside deploymentProvider.buildDeployment, so it is covered there, not here.

describe('containerHealthMonitor tests', () => {
  let containerHealthMonitor;
  let appsRepositoryStub;
  let deploymentProviderStub;
  let dockerServiceStub;
  let appInstallerStub;
  let appUninstallerStub;
  let appInspectorStub;
  let tamperingStub;
  let volumeServiceStub;
  let globalStateStub;
  let instantiated;
  let webComp;
  let dbComp;
  let fakeDeployment;

  beforeEach(() => {
    instantiated = { name: 'testapp', owner: '1OwnerAddress' };
    webComp = { name: 'web' };
    dbComp = { name: 'db' };
    fakeDeployment = {
      getComponent: sinon.stub().callsFake((name) => ({ web: webComp, db: dbComp }[name])),
      componentEntries: sinon.stub().returns([['web', webComp], ['db', dbComp]]),
    };

    appsRepositoryStub = { getInstalledApp: sinon.stub().resolves(instantiated) };
    deploymentProviderStub = { buildDeployment: sinon.stub().resolves(fakeDeployment) };
    dockerServiceStub = { getDockerContainer: sinon.stub().resolves(null) };
    appInstallerStub = { installComponent: sinon.stub().resolves() };
    appUninstallerStub = { uninstallApplication: sinon.stub().resolves() };
    appInspectorStub = { startAppMonitoring: sinon.stub() };
    tamperingStub = {
      recordEvent: sinon.stub().resolves(),
      isNetworkMissingError: sinon.stub().returns(false),
    };
    volumeServiceStub = { verifyAppVolumeMount: sinon.stub().resolves(false) };
    globalStateStub = { appsMonitored: new Map() };

    containerHealthMonitor = proxyquire('../../ZelBack/src/services/appMonitoring/containerHealthMonitor', {
      '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
      '../dockerService': dockerServiceStub,
      '../appLifecycle/appInstaller': appInstallerStub,
      '../appLifecycle/appUninstaller': appUninstallerStub,
      '../appDatabase/appsRepository': appsRepositoryStub,
      '../appRuntime/deploymentProvider': deploymentProviderStub,
      '../appManagement/appInspector': appInspectorStub,
      '../appTamperingDetectionService': tamperingStub,
      '../utils/globalState': globalStateStub,
      '../utils/volumeService': volumeServiceStub,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('module surface', () => {
    it('no longer exposes monitorAndRecoverApps - the reconciler owns runtime recovery', () => {
      expect(containerHealthMonitor.monitorAndRecoverApps).to.be.undefined;
      expect(containerHealthMonitor.recreateMissingContainers).to.be.a('function');
    });

    describe('softOnly (the network-detach heal)', () => {
      // A hard install runs createAppVolume: fallocate + mke2fs on the app's volume
      // file, i.e. it REFORMATS the app's data. The heal deliberately force-removes a
      // LIVE container whose data is intact, so it must never be able to trigger that
      // fallback - a transient verifyAppVolumeMount failure would wipe user data.
      it('throws instead of hard-installing a component whose volume cannot be verified', async () => {
        volumeServiceStub.verifyAppVolumeMount.resolves(false);
        let err;
        try {
          await containerHealthMonitor.recreateMissingContainers('web_testapp', { softOnly: true });
        } catch (e) { err = e; }

        expect(err).to.be.an('error');
        expect(err.message).to.include('without reformatting its volume');
        expect(appInstallerStub.installApplicationHard.called, 'must never reformat the data volume of a container it was asked to rebuild softly').to.be.false;
      });

      it('throws instead of hard-installing on the whole-app path', async () => {
        volumeServiceStub.verifyAppVolumeMount.resolves(false);
        let err;
        try {
          await containerHealthMonitor.recreateMissingContainers('testapp', { softOnly: true });
        } catch (e) { err = e; }

        expect(err).to.be.an('error');
        expect(appInstallerStub.installApplicationHard.called).to.be.false;
      });

      it('still soft-installs normally when the volume is verified', async () => {
        volumeServiceStub.verifyAppVolumeMount.resolves(true);

        await containerHealthMonitor.recreateMissingContainers('web_testapp', { softOnly: true });

        expect(appInstallerStub.installApplicationSoft.calledOnce).to.be.true;
      });

      it('leaves the default (vanished-container) path free to hard-install', async () => {
        volumeServiceStub.verifyAppVolumeMount.resolves(false);

        await containerHealthMonitor.recreateMissingContainers('web_testapp');

        expect(appInstallerStub.installApplicationHard.calledOnce, 'a container that is gone anyway may still be rebuilt from scratch').to.be.true;
      });
    });
  });

  describe('recreateMissingContainers', () => {
    it('throws when the app is not in the local database', async () => {
      appsRepositoryStub.getInstalledApp.resolves(null);
      let err;
      try {
        await containerHealthMonitor.recreateMissingContainers('web_testapp');
      } catch (e) { err = e; }
      expect(err).to.be.an('error');
      expect(err.message).to.include('not found in local database');
      expect(appInstallerStub.installComponent.called).to.be.false;
    });

    it('throws when the component is not part of the app', async () => {
      let err;
      try {
        await containerHealthMonitor.recreateMissingContainers('ghost_testapp');
      } catch (e) { err = e; }
      expect(err).to.be.an('error');
      expect(err.message).to.include('Component ghost not found');
      expect(appInstallerStub.installComponent.called).to.be.false;
    });

    it('keeps existing volumes when the component volume is still mounted', async () => {
      volumeServiceStub.verifyAppVolumeMount.resolves(true);
      await containerHealthMonitor.recreateMissingContainers('web_testapp');
      expect(appInstallerStub.installComponent.calledOnce).to.be.true;
      const [deployComp, opts] = appInstallerStub.installComponent.firstCall.args;
      expect(deployComp.name).to.equal('web');
      expect(opts.createVolumes).to.be.false;
    });

    it('recreates volumes when the component volume is gone', async () => {
      volumeServiceStub.verifyAppVolumeMount.resolves(false);
      await containerHealthMonitor.recreateMissingContainers('web_testapp');
      expect(appInstallerStub.installComponent.calledOnce).to.be.true;
      const [, opts] = appInstallerStub.installComponent.firstCall.args;
      expect(opts.createVolumes).to.be.true;
    });

    it('treats an unreadable volume state as not mounted', async () => {
      volumeServiceStub.verifyAppVolumeMount.rejects(new Error('mount probe failed'));
      await containerHealthMonitor.recreateMissingContainers('web_testapp');
      const [, opts] = appInstallerStub.installComponent.firstCall.args;
      expect(opts.createVolumes).to.be.true;
    });

    it('forwards the app owner to the create path (load-bearing shutdown label)', async () => {
      await containerHealthMonitor.recreateMissingContainers('web_testapp');
      const [, opts] = appInstallerStub.installComponent.firstCall.args;
      expect(opts.owner).to.equal('1OwnerAddress');
    });

    it('recreates every component for a whole-app identifier', async () => {
      await containerHealthMonitor.recreateMissingContainers('testapp');
      expect(appInstallerStub.installComponent.callCount).to.equal(2);
      const recreated = appInstallerStub.installComponent.getCalls().map((c) => c.args[0].name);
      expect(recreated).to.deep.equal(['web', 'db']);
    });
  });

  describe('handleMissingMasterSlaveContainer', () => {
    it('does nothing when the container actually exists', async () => {
      dockerServiceStub.getDockerContainer.resolves({ Id: 'abc' });
      await containerHealthMonitor.handleMissingMasterSlaveContainer('web_testapp', 'testapp');
      expect(appInstallerStub.installComponent.called).to.be.false;
      expect(appUninstallerStub.uninstallApplication.called).to.be.false;
    });

    it('recreates a missing container and restarts monitoring', async () => {
      await containerHealthMonitor.handleMissingMasterSlaveContainer('web_testapp', 'testapp');
      expect(appInstallerStub.installComponent.calledOnce).to.be.true;
      expect(appInspectorStub.startAppMonitoring.calledOnceWith('web_testapp', globalStateStub.appsMonitored)).to.be.true;
      expect(appUninstallerStub.uninstallApplication.called).to.be.false;
    });

    it('skips removal when recreation failed but another process created the container', async () => {
      appInstallerStub.installComponent.rejects(new Error('install boom'));
      dockerServiceStub.getDockerContainer
        .onFirstCall().resolves(null)
        .onSecondCall().resolves({ Id: 'raced' });
      await containerHealthMonitor.handleMissingMasterSlaveContainer('web_testapp', 'testapp');
      expect(appUninstallerStub.uninstallApplication.called).to.be.false;
      expect(tamperingStub.recordEvent.called).to.be.false;
    });

    it('records the failure and removes the app when recreation truly fails', async () => {
      appInstallerStub.installComponent.rejects(new Error('install boom'));
      await containerHealthMonitor.handleMissingMasterSlaveContainer('web_testapp', 'testapp');
      expect(tamperingStub.recordEvent.calledWith('testapp', 'recreation_failed')).to.be.true;
      expect(appUninstallerStub.uninstallApplication.calledOnce).to.be.true;
      const [removedApp, removeOpts] = appUninstallerStub.uninstallApplication.firstCall.args;
      expect(removedApp).to.equal('testapp');
      expect(removeOpts).to.deep.equal({ broadcastRemoval: true });
    });

    it('additionally records network_pruned when the failure is a missing docker network', async () => {
      appInstallerStub.installComponent.rejects(new Error('network fluxDockerNetwork_testapp not found'));
      tamperingStub.isNetworkMissingError.returns(true);
      await containerHealthMonitor.handleMissingMasterSlaveContainer('web_testapp', 'testapp');
      expect(tamperingStub.recordEvent.calledWith('testapp', 'network_pruned')).to.be.true;
      expect(appUninstallerStub.uninstallApplication.calledOnce).to.be.true;
    });
  });
});
