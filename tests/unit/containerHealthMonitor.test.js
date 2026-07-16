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
  let shutdownPlanStub;
  let dockerServiceStub;
  let componentProvisionerStub;
  let appVolumeServiceStub;
  let appNetworkLinkerStub;
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
    shutdownPlanStub = { appRequiresDaemonShutdown: sinon.stub().returns(true) };
    dockerServiceStub = { getDockerContainer: sinon.stub().resolves(null) };
    componentProvisionerStub = { installComponent: sinon.stub().resolves() };
    appVolumeServiceStub = { ensureMountSourcesExist: sinon.stub().resolves() };
    appNetworkLinkerStub = { resolveLogCollector: sinon.stub().resolves({ syslogTarget: null, crossAppLogCollector: null }) };
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
      '../appLifecycle/componentProvisioner': componentProvisionerStub,
      '../appLifecycle/appVolumeService': appVolumeServiceStub,
      '../appLifecycle/appUninstaller': appUninstallerStub,
      '../appDatabase/appsRepository': appsRepositoryStub,
      '../appRuntime/deploymentProvider': deploymentProviderStub,
      '../appLifecycle/appNetworkLinker': appNetworkLinkerStub,
      '../appLifecycle/shutdownPlan': shutdownPlanStub,
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

    describe('allowVolumeCreation (the network-detach heal)', () => {
      // Creating a volume runs fallocate + mke2fs on the app's volume file, i.e. it
      // REFORMATS the app's data (installComponent createVolumes). The heal
      // deliberately force-removes a LIVE container whose data is intact, so it must
      // never be able to trigger that path - a transient verifyAppVolumeMount
      // failure would wipe user data.
      it('throws instead of creating the volume for a component whose volume cannot be verified', async () => {
        volumeServiceStub.verifyAppVolumeMount.resolves(false);
        let err;
        try {
          await containerHealthMonitor.recreateMissingContainers('web_testapp', { allowVolumeCreation: false });
        } catch (e) { err = e; }

        expect(err).to.be.an('error');
        expect(err.message).to.include('without creating (reformatting) its data volume');
        expect(componentProvisionerStub.installComponent.called, 'must never reach a volume-creating install for a container it was asked to rebuild without one').to.be.false;
      });

      it('throws instead of creating volumes on the whole-app path', async () => {
        volumeServiceStub.verifyAppVolumeMount.resolves(false);
        let err;
        try {
          await containerHealthMonitor.recreateMissingContainers('testapp', { allowVolumeCreation: false });
        } catch (e) { err = e; }

        expect(err).to.be.an('error');
        expect(componentProvisionerStub.installComponent.called).to.be.false;
      });

      it('still recreates normally (no volume creation) when the volume is verified', async () => {
        volumeServiceStub.verifyAppVolumeMount.resolves(true);

        await containerHealthMonitor.recreateMissingContainers('web_testapp', { allowVolumeCreation: false });

        expect(componentProvisionerStub.installComponent.calledOnce).to.be.true;
        expect(componentProvisionerStub.installComponent.firstCall.args[1].createVolumes).to.be.false;
      });

      it('leaves the default (vanished-container) path free to create the volume', async () => {
        volumeServiceStub.verifyAppVolumeMount.resolves(false);

        await containerHealthMonitor.recreateMissingContainers('web_testapp');

        expect(componentProvisionerStub.installComponent.calledOnce, 'a container that is gone anyway may still be rebuilt from scratch').to.be.true;
        expect(componentProvisionerStub.installComponent.firstCall.args[1].createVolumes).to.be.true;
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
      expect(componentProvisionerStub.installComponent.called).to.be.false;
    });

    it('throws when the component is not part of the app', async () => {
      let err;
      try {
        await containerHealthMonitor.recreateMissingContainers('ghost_testapp');
      } catch (e) { err = e; }
      expect(err).to.be.an('error');
      expect(err.message).to.include('Component ghost not found');
      expect(componentProvisionerStub.installComponent.called).to.be.false;
    });

    it('keeps existing volumes when the component volume is still mounted', async () => {
      volumeServiceStub.verifyAppVolumeMount.resolves(true);
      await containerHealthMonitor.recreateMissingContainers('web_testapp');
      expect(componentProvisionerStub.installComponent.calledOnce).to.be.true;
      const [deployComp, opts] = componentProvisionerStub.installComponent.firstCall.args;
      expect(deployComp.name).to.equal('web');
      expect(opts.createVolumes).to.be.false;
    });

    it('remakes vanished bind-mount sources before a soft recreate', async () => {
      volumeServiceStub.verifyAppVolumeMount.resolves(true);
      await containerHealthMonitor.recreateMissingContainers('web_testapp');
      expect(appVolumeServiceStub.ensureMountSourcesExist.calledOnce).to.be.true;
      expect(appVolumeServiceStub.ensureMountSourcesExist.firstCall.args[0]).to.equal(webComp);
      // the sources must exist before the container is recreated
      sinon.assert.callOrder(appVolumeServiceStub.ensureMountSourcesExist, componentProvisionerStub.installComponent);
    });

    it('recreates volumes when the component volume is gone', async () => {
      volumeServiceStub.verifyAppVolumeMount.resolves(false);
      await containerHealthMonitor.recreateMissingContainers('web_testapp');
      expect(componentProvisionerStub.installComponent.calledOnce).to.be.true;
      const [, opts] = componentProvisionerStub.installComponent.firstCall.args;
      expect(opts.createVolumes).to.be.true;
    });

    it('does not remake sources on a hard recreate (the fresh volume creates them)', async () => {
      volumeServiceStub.verifyAppVolumeMount.resolves(false);
      await containerHealthMonitor.recreateMissingContainers('web_testapp');
      expect(appVolumeServiceStub.ensureMountSourcesExist.called).to.be.false;
    });

    it('treats an unreadable volume state as not mounted', async () => {
      volumeServiceStub.verifyAppVolumeMount.rejects(new Error('mount probe failed'));
      await containerHealthMonitor.recreateMissingContainers('web_testapp');
      const [, opts] = componentProvisionerStub.installComponent.firstCall.args;
      expect(opts.createVolumes).to.be.true;
    });

    it('forwards the app owner to the create path (load-bearing shutdown label)', async () => {
      await containerHealthMonitor.recreateMissingContainers('web_testapp');
      const [, opts] = componentProvisionerStub.installComponent.firstCall.args;
      expect(opts.owner).to.equal('1OwnerAddress');
    });

    it('recomputes the graceful-shutdown gate and forwards it, so a recreate keeps its budget labels', async () => {
      shutdownPlanStub.appRequiresDaemonShutdown.returns(true);
      await containerHealthMonitor.recreateMissingContainers('web_testapp');
      expect(shutdownPlanStub.appRequiresDaemonShutdown.calledWith(fakeDeployment)).to.be.true;
      const [, opts] = componentProvisionerStub.installComponent.firstCall.args;
      expect(opts.requiresEncryption).to.equal(true);
    });

    it('forwards requiresEncryption=false for a non-graceful app (budget labels skipped)', async () => {
      shutdownPlanStub.appRequiresDaemonShutdown.returns(false);
      await containerHealthMonitor.recreateMissingContainers('web_testapp');
      const [, opts] = componentProvisionerStub.installComponent.firstCall.args;
      expect(opts.requiresEncryption).to.equal(false);
    });

    it('recreates every component for a whole-app identifier', async () => {
      await containerHealthMonitor.recreateMissingContainers('testapp');
      expect(componentProvisionerStub.installComponent.callCount).to.equal(2);
      const recreated = componentProvisionerStub.installComponent.getCalls().map((c) => c.args[0].name);
      expect(recreated).to.deep.equal(['web', 'db']);
    });
  });
});
