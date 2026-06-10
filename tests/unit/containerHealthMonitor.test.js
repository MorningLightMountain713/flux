const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('containerHealthMonitor tests', () => {
  let containerHealthMonitor;
  let globalStateStub;

  beforeEach(() => {
    globalStateStub = {
      waitForBootContainerStateSettled: sinon.stub().resolves(),
      isOperationInProgress: sinon.stub().returns(false),
      backupInProgress: [],
      restoreInProgress: [],
      appsMonitored: new Map(),
      getAppLbState: sinon.stub().returns(null),
    };

    containerHealthMonitor = proxyquire('../../ZelBack/src/services/appMonitoring/containerHealthMonitor', {
      '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
      '../dbHelper': { databaseConnection: sinon.stub(), findInDatabase: sinon.stub(), findOneInDatabase: sinon.stub() },
      '../dockerService': { getDockerContainer: sinon.stub().resolves(null), appDockerStart: sinon.stub(), dockerListContainers: sinon.stub() },
      '../appDatabase/appsRepository': { getGlobalAppInfo: sinon.stub() },
      '../appLifecycle/appInstaller': { installComponent: sinon.stub().resolves() },
      '../appLifecycle/appUninstaller': { uninstallApplication: sinon.stub().resolves() },
      '../appRuntime/deploymentProvider': { buildDeployment: sinon.stub() },
      '../appManagement/appInspector': { startAppMonitoring: sinon.stub() },
      '../appTamperingDetectionService': { recordEvent: sinon.stub().resolves(), isNetworkMissingError: sinon.stub().returns(false) },
      '../utils/globalState': globalStateStub,
      '../utils/cacheManager': { default: { stoppedAppsCache: new Map() } },
      '../utils/volumeService': { verifyAppVolumeMount: sinon.stub().resolves(true) },
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
});
