// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
// Real registry singleton - un-stubbed in proxyquire, so the module and the test share it.
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');
// Real registry singleton for the same reason: the janitor and the test must
// agree on which playground sessions are live.
const playgroundSessionRegistry = require('../../ZelBack/src/services/appPlayground/playgroundSessionRegistry');

describe('appJanitor tests', () => {
  let appJanitor;
  let logStub;
  let dockerServiceStub;
  let fluxNetworkHelperStub;
  let fluxEventBusStub;
  let appsRepositoryStub;
  let registryManagerStub;
  let appQueryServiceStub;
  let appDockerNetworkStub;
  let appUninstallerStub;

  const container = (name, labels = null) => ({
    Names: [name],
    ...(labels ? { Labels: labels } : {}),
  });

  beforeEach(() => {
    logStub = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };
    dockerServiceStub = {
      appDockerForceRemove: sinon.stub().resolves(),
    };
    appDockerNetworkStub = {
      removeUnownedAppNetworks: sinon.stub().resolves({ removed: [], unidentified: 0 }),
    };
    fluxNetworkHelperStub = {
      getLocalSocketAddress: sinon.stub().resolves('192.168.1.1:16127'),
    };
    fluxEventBusStub = { publish: sinon.stub() };
    appsRepositoryStub = {
      appLocationFromEvents: sinon.stub().resolves([]),
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
      '../appNetwork/appDockerNetwork': appDockerNetworkStub,
      './appUninstaller': appUninstallerStub,
    });
  });

  afterEach(() => {
    operationRegistry.clear();
    playgroundSessionRegistry.reset();
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
      appsRepositoryStub.appLocationFromEvents.callsFake(async ({ appname }) => (appname === 'located' ? [{ name: appname }] : []));

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
      expect(appDockerNetworkStub.removeUnownedAppNetworks.called).to.be.false;
      expect(dockerServiceStub.appDockerForceRemove.called).to.be.false;
    });

    it('runs while an installed app sits stopped - ownership decides, not run state', async () => {
      // The old guard skipped the whole sweep whenever any installed component
      // was down, which on a real node meant it never ran at all.
      appQueryServiceStub.installedApps.resolves({ status: 'success', data: [{ name: 'stoppedapp' }] });
      appQueryServiceStub.listAllApps.resolves({
        status: 'success', data: [{ ...container('/fluxweb_stoppedapp'), State: 'exited' }],
      });

      const result = await appJanitor.sweepDockerDebris();

      expect(result.skipped).to.equal(undefined);
      sinon.assert.calledOnce(appDockerNetworkStub.removeUnownedAppNetworks);
      // and the stopped app's own network is not up for collection
      const [installedAppNames] = appDockerNetworkStub.removeUnownedAppNetworks.firstCall.args;
      expect(installedAppNames.has('stoppedapp')).to.be.true;
    });

    it('hands the installed set to the network reap, so ownership is what decides', async () => {
      appQueryServiceStub.installedApps.resolves({
        status: 'success', data: [{ name: 'liveapp' }, { name: 'stoppedapp' }],
      });
      appDockerNetworkStub.removeUnownedAppNetworks.resolves({ removed: ['goneapp'], unidentified: 0 });

      const result = await appJanitor.sweepDockerDebris();

      const [installedAppNames] = appDockerNetworkStub.removeUnownedAppNetworks.firstCall.args;
      expect([...installedAppNames].sort()).to.deep.equal(['liveapp', 'stoppedapp']);
      expect(result.networksRemoved).to.equal(1);
    });

    // A session's network is named and stamped for the SESSION, so this sweep
    // cannot see it and needs no exception for it. The protected set is the
    // installed apps and nothing else - a live session no longer contributes a
    // name to defend, because there is no longer a name to defend.
    it('protects only installed apps, and never names a live session', async () => {
      appQueryServiceStub.installedApps.resolves({ status: 'success', data: [{ name: 'liveapp' }] });
      playgroundSessionRegistry.add({ sessionId: 'op_1', appName: 'guestapp' });

      await appJanitor.sweepDockerDebris();

      const [protectedNames] = appDockerNetworkStub.removeUnownedAppNetworks.firstCall.args;
      expect([...protectedNames]).to.deep.equal(['liveapp']);
    });
  });

  describe('playground containers are not app debris', () => {
    const playgroundContainer = (name, sessionId) => ({
      Names: [name],
      Labels: { 'runonflux.app': 'guestapp', 'flux.playground': sessionId },
    });

    // The orphan sweep removes containers with no installed-app row by running a
    // full app uninstall - ports, mounts, crontab, data - against an app that was
    // never installed. A playground session is exactly that shape by design.
    it('never hands a playground container to the uninstaller', async () => {
      appQueryServiceStub.listAllApps.resolves({
        status: 'success',
        data: [playgroundContainer('/fluxweb_guestapp', 'op_1')],
      });

      await appJanitor.sweepDockerOrphans();

      expect(appUninstallerStub.uninstallApplication.called).to.be.false;
    });

    // Even after the session is gone: its containers are the playground reaper's
    // to collect, and the uninstaller would still be the wrong tool.
    it('leaves an abandoned playground container to the playground reaper', async () => {
      appQueryServiceStub.listAllApps.resolves({
        status: 'success',
        data: [playgroundContainer('/fluxweb_guestapp', 'op_gone')],
      });
      playgroundSessionRegistry.reset();

      await appJanitor.sweepDockerOrphans();

      expect(appUninstallerStub.uninstallApplication.called).to.be.false;
    });

    it('still removes a genuine orphan sitting alongside a playground container', async () => {
      appQueryServiceStub.listAllApps.resolves({
        status: 'success',
        data: [
          playgroundContainer('/fluxweb_guestapp', 'op_1'),
          container('/fluxweb_realghost', { 'runonflux.app': 'realghost' }),
        ],
      });

      await appJanitor.sweepDockerOrphans();

      sinon.assert.calledOnceWithMatch(appUninstallerStub.uninstallApplication, 'realghost');
    });

    it('leaves containers to the orphan sweep - it removes them through the uninstaller', async () => {
      // The debris sweep never actuates container run-state: a container with no
      // installed app is the orphan sweep's, which tears it down with its volumes,
      // ports and shutdown budget instead of pulling it out from under docker.
      appQueryServiceStub.installedApps.resolves({ status: 'success', data: [] });
      appQueryServiceStub.listAllApps.resolves({
        status: 'success', data: [{ ...container('/fluxweb_goneapp'), State: 'exited' }],
      });

      await appJanitor.sweepDockerDebris();

      expect(appUninstallerStub.uninstallApplication.called).to.be.false;
      expect(dockerServiceStub.appDockerForceRemove.called).to.be.false;
    });

    it('reports what it declined to attribute rather than removing it', async () => {
      appQueryServiceStub.installedApps.resolves({ status: 'success', data: [] });
      appDockerNetworkStub.removeUnownedAppNetworks.resolves({ removed: [], unidentified: 2 });

      const result = await appJanitor.sweepDockerDebris();

      expect(result.unidentified).to.equal(2);
      expect(result.networksRemoved).to.equal(0);
    });

    it('skips entirely when the installed set cannot be read - everything would look unowned', async () => {
      appQueryServiceStub.installedApps.resolves({ status: 'error' });

      const result = await appJanitor.sweepDockerDebris();

      expect(result.skipped).to.equal('installed list failed');
      expect(appDockerNetworkStub.removeUnownedAppNetworks.called).to.be.false;
    });

    it('logs and absorbs a failure instead of throwing', async () => {
      appQueryServiceStub.installedApps.rejects(new Error('mongo down'));

      const result = await appJanitor.sweepDockerDebris();

      expect(result).to.equal(null);
      expect(logStub.error.calledWithMatch(sinon.match(/dockerDebris sweep failed/))).to.be.true;
      expect(appDockerNetworkStub.removeUnownedAppNetworks.called).to.be.false;
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
