// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
// Real registry singleton - un-stubbed in proxyquire, so the module and the test share it.
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');

describe('appJanitor tests', () => {
  let appJanitor;
  let logStub;
  let dockerServiceStub;
  let fluxNetworkHelperStub;
  let fluxEventBusStub;
  let appsRepositoryStub;
  let registryManagerStub;
  let appQueryServiceStub;
  let deploymentProviderStub;
  let appUninstallerStub;

  const container = (name, labels = null) => ({
    Names: [name],
    ...(labels ? { Labels: labels } : {}),
  });

  beforeEach(() => {
    logStub = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };
    dockerServiceStub = {
      pruneContainers: sinon.stub().resolves(),
      pruneNetworks: sinon.stub().resolves(),
      pruneVolumes: sinon.stub().resolves(),
    };
    fluxNetworkHelperStub = {
      getLocalSocketAddress: sinon.stub().resolves('192.168.1.1:16127'),
    };
    fluxEventBusStub = { publish: sinon.stub() };
    appsRepositoryStub = {
      getAppLocation: sinon.stub().resolves(null),
      listGlobalAppInfo: sinon.stub().resolves([]),
      removeGlobalAppInfo: sinon.stub().resolves(),
      removeAppInstallingErrorRecords: sinon.stub().resolves(),
      reapOrphanedContentManifests: sinon.stub().resolves({ reaped: 0, orphans: [] }),
    };
    registryManagerStub = {
      getScannedHeight: sinon.stub().resolves(1000000),
    };
    appQueryServiceStub = {
      listAllApps: sinon.stub().resolves({ status: 'success', data: [] }),
      installedApps: sinon.stub().resolves({ status: 'success', data: [] }),
      listRunningApps: sinon.stub().resolves({ status: 'success', data: [] }),
    };
    deploymentProviderStub = {
      listInstalledDeployments: sinon.stub().resolves([]),
    };
    appUninstallerStub = {
      uninstallApplication: sinon.stub().resolves({ status: 'removed', reason: null }),
    };

    appJanitor = proxyquire.noCallThru()('../../ZelBack/src/services/appLifecycle/appJanitor', {
      '../../lib/log': logStub,
      '../dockerService': dockerServiceStub,
      '../fluxNetworkHelper': fluxNetworkHelperStub,
      '../utils/fluxEventBus': fluxEventBusStub,
      '../appDatabase/appsRepository': appsRepositoryStub,
      '../appDatabase/registryManager': registryManagerStub,
      '../appQuery/appQueryService': appQueryServiceStub,
      '../appRuntime/deploymentProvider': deploymentProviderStub,
      './appUninstaller': appUninstallerStub,
    });
  });

  afterEach(() => {
    operationRegistry.clear();
    sinon.restore();
  });

  describe('sweepDockerOrphans', () => {
    it('skips while any operation is in flight', async () => {
      operationRegistry.acquire('someapp', 'install', 'test');
      appQueryServiceStub.listAllApps.resolves({ status: 'success', data: [container('/fluxcomp_ghost')] });

      const result = await appJanitor.sweepDockerOrphans();

      expect(result.skipped).to.equal('operation in flight');
      expect(appUninstallerStub.uninstallApplication.called).to.be.false;
    });

    it('resolves the app from the runonflux.app label, not the container name', async () => {
      appQueryServiceStub.listAllApps.resolves({
        status: 'success',
        data: [container('/fluxweb_misleading', { 'runonflux.app': 'labelapp' })],
      });

      await appJanitor.sweepDockerOrphans();

      sinon.assert.calledOnceWithMatch(appUninstallerStub.uninstallApplication, 'labelapp');
    });

    it('falls back to name parsing for pre-label containers', async () => {
      appQueryServiceStub.listAllApps.resolves({
        status: 'success',
        data: [container('/fluxcomp_legacyapp'), container('/fluxbareapp')],
      });

      await appJanitor.sweepDockerOrphans();

      sinon.assert.calledWithMatch(appUninstallerStub.uninstallApplication, 'legacyapp');
      sinon.assert.calledWithMatch(appUninstallerStub.uninstallApplication, 'bareapp');
    });

    it('leaves apps with an installed row alone', async () => {
      appQueryServiceStub.listAllApps.resolves({
        status: 'success',
        data: [container('/fluxweb_owned', { 'runonflux.app': 'owned' })],
      });
      appQueryServiceStub.installedApps.resolves({ status: 'success', data: [{ name: 'owned' }] });

      const result = await appJanitor.sweepDockerOrphans();

      expect(appUninstallerStub.uninstallApplication.called).to.be.false;
      expect(result.removed).to.equal(0);
    });

    it('exempts watchtower', async () => {
      appQueryServiceStub.listAllApps.resolves({
        status: 'success',
        data: [container('/fluxwatchtower')],
      });

      await appJanitor.sweepDockerOrphans();

      expect(appUninstallerStub.uninstallApplication.called).to.be.false;
    });

    it('removes gracefully and backgrounded, broadcasting only with a location row', async () => {
      appQueryServiceStub.listAllApps.resolves({
        status: 'success',
        data: [
          container('/fluxweb_located', { 'runonflux.app': 'located' }),
          container('/fluxweb_unlocated', { 'runonflux.app': 'unlocated' }),
        ],
      });
      appsRepositoryStub.getAppLocation.callsFake(async (name) => (name === 'located' ? { name } : null));

      await appJanitor.sweepDockerOrphans();

      sinon.assert.calledWithMatch(
        appUninstallerStub.uninstallApplication,
        'located',
        sinon.match({ forceKill: false, skipGuard: true, broadcastRemoval: true, background: true }),
      );
      sinon.assert.calledWithMatch(
        appUninstallerStub.uninstallApplication,
        'unlocated',
        sinon.match({ forceKill: false, broadcastRemoval: false, background: true }),
      );
    });

    it('publishes the sweep result for harness observability', async () => {
      await appJanitor.sweepDockerOrphans();

      sinon.assert.calledWithMatch(fluxEventBusStub.publish, 'janitor:sweep', sinon.match({ sweep: 'dockerOrphans' }));
    });
  });

  describe('sweepRegistryExpiry', () => {
    const spec = (name, expired) => ({ name, isExpired: () => expired });

    it('drops expired global rows with their error records and reaps manifests', async () => {
      appsRepositoryStub.listGlobalAppInfo.resolves([spec('deadapp', true), spec('liveapp', false)]);
      appsRepositoryStub.reapOrphanedContentManifests.resolves({ reaped: 2, orphans: ['x', 'y'] });

      const result = await appJanitor.sweepRegistryExpiry();

      sinon.assert.calledOnceWithExactly(appsRepositoryStub.removeGlobalAppInfo, 'deadapp');
      sinon.assert.calledOnceWithExactly(appsRepositoryStub.removeAppInstallingErrorRecords, 'deadapp');
      expect(result).to.deep.equal({ expired: 1, manifestsReaped: 2 });
    });

    it('never uninstalls anything - expired local installs are the reconciler\'s', async () => {
      appsRepositoryStub.listGlobalAppInfo.resolves([spec('deadapp', true)]);

      await appJanitor.sweepRegistryExpiry();

      expect(appUninstallerStub.uninstallApplication.called).to.be.false;
    });

    it('skips cleanly before scanning is initiated', async () => {
      registryManagerStub.getScannedHeight.rejects(new Error('no row'));

      const result = await appJanitor.sweepRegistryExpiry();

      expect(result.skipped).to.equal('scanning not initiated');
      expect(appsRepositoryStub.removeGlobalAppInfo.called).to.be.false;
    });
  });

  describe('sweepDockerDebris', () => {
    it('skips while any operation is in flight', async () => {
      operationRegistry.acquire('someapp', 'install', 'test');

      const result = await appJanitor.sweepDockerDebris();

      expect(result.skipped).to.equal('operation in flight');
      expect(dockerServiceStub.pruneContainers.called).to.be.false;
    });

    it('skips when an installed component is not running - prune would eat its volumes', async () => {
      deploymentProviderStub.listInstalledDeployments.resolves([{
        componentEntries: () => [['web', { identifier: 'web_stoppedapp' }]],
      }]);

      const result = await appJanitor.sweepDockerDebris();

      expect(result.skipped).to.equal('stopped apps present');
      expect(dockerServiceStub.pruneContainers.called).to.be.false;
    });

    it('prunes containers, networks and volumes when every installed component runs', async () => {
      deploymentProviderStub.listInstalledDeployments.resolves([{
        componentEntries: () => [['web', { identifier: 'web_runningapp' }]],
      }]);
      appQueryServiceStub.listRunningApps.resolves({ status: 'success', data: [{ Names: ['/fluxweb_runningapp'] }] });

      const result = await appJanitor.sweepDockerDebris();

      expect(result.pruned).to.be.true;
      sinon.assert.calledOnce(dockerServiceStub.pruneContainers);
      sinon.assert.calledOnce(dockerServiceStub.pruneNetworks);
      sinon.assert.calledOnce(dockerServiceStub.pruneVolumes);
    });

    it('logs and absorbs a failure instead of throwing', async () => {
      appQueryServiceStub.listRunningApps.resolves({ status: 'error' });

      const result = await appJanitor.sweepDockerDebris();

      expect(result).to.equal(null);
      expect(logStub.error.calledWithMatch(sinon.match(/dockerDebris sweep failed/))).to.be.true;
      expect(dockerServiceStub.pruneContainers.called).to.be.false;
    });
  });

  describe('single-flight', () => {
    it('a sweep call while the same sweep runs is absorbed', async () => {
      let release;
      appQueryServiceStub.listAllApps.returns(new Promise((resolve) => {
        release = () => resolve({ status: 'success', data: [] });
      }));

      const first = appJanitor.sweepDockerOrphans();
      const second = await appJanitor.sweepDockerOrphans();
      expect(second).to.equal(null);

      release();
      const firstResult = await first;
      expect(firstResult.removed).to.equal(0);
    });
  });
});
