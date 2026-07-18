// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const specReconciler = require('../../ZelBack/src/services/appLifecycle/specReconciler');
const appUninstaller = require('../../ZelBack/src/services/appLifecycle/appUninstaller');
const appOperations = require('../../ZelBack/src/services/appLifecycle/appOperations');
const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');
const registryManager = require('../../ZelBack/src/services/appDatabase/registryManager');
const deploymentProvider = require('../../ZelBack/src/services/appRuntime/deploymentProvider');
const generalService = require('../../ZelBack/src/services/generalService');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const globalState = require('../../ZelBack/src/services/utils/globalState');
const shutdownPlan = require('../../ZelBack/src/services/appLifecycle/shutdownPlan');
const imageManager = require('../../ZelBack/src/services/appSecurity/imageManager');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const dockerService = require('../../ZelBack/src/services/dockerService');

describe('specReconciler tests', () => {
  const LOCAL_IP = '44.55.66.77:16127';
  const OUTPOINT_TXID = 'a'.repeat(64);

  // Registry/installed rows carry a REAL Placement instance so the ladder runs
  // the actual mode/resolution machinery rather than a hand-mocked shadow.
  async function specWith(placementBlob, {
    name = 'myapp', hash = 'h1', height = 100, expired = false, isEncrypted = false,
    requiresArcane = false,
  } = {}) {
    const { Placement } = await import('@runonflux/flux-spec');
    return {
      name,
      hash,
      height,
      owner: 'owner1',
      isEncrypted,
      // Mirrors InstantiatedSpec.requiresArcane(): every encrypted spec
      // requires Arcane; cleartext only via an Arcane-requiring feature.
      requiresArcane: () => isEncrypted || requiresArcane,
      placement: Placement.from(placementBlob),
      isExpired: () => expired,
      spec: { instances: 1 },
    };
  }

  let uninstallStub;
  let reconcileAppStub;
  let appLocationStub;

  function setup({ installed = [], globalRows = [], synced = true, dbReady = true } = {}) {
    sinon.stub(serviceHelper, 'delay').resolves();
    sinon.stub(generalService, 'checkSynced').resolves(synced);
    sinon.stub(generalService, 'obtainNodeCollateralInformation').resolves({ txhash: OUTPOINT_TXID, txindex: 0 });
    sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves(LOCAL_IP);
    sinon.stub(globalState, 'dbReady').get(() => dbReady);
    sinon.stub(appsRepository, 'listInstalledApps').resolves(installed);
    sinon.stub(appsRepository, 'listGlobalAppInfo').resolves(globalRows);
    sinon.stub(registryManager, 'getScannedHeight').resolves(1000000);
    // The named-mode per-identity diff enumerates this app's containers; no
    // real docker in unit tests (and none of these fixtures have containers).
    sinon.stub(dockerService, 'getAppContainerObjects').resolves([]);
    appLocationStub = sinon.stub(registryManager, 'appLocation').resolves([]);
    uninstallStub = sinon.stub(appUninstaller, 'uninstallApplication').resolves({ status: appUninstaller.UninstallStatus.REMOVED });
    reconcileAppStub = sinon.stub(appOperations, 'reconcileApp').resolves();
  }

  afterEach(() => {
    sinon.restore();
  });

  describe('convergence gates', () => {
    it('does nothing while the node is not synced', async () => {
      setup({ synced: false, installed: [await specWith({}, { expired: true })] });
      await specReconciler.requestFullConvergence({ reason: 'test' });
      expect(uninstallStub.called).to.equal(false);
    });

    it('does nothing while the db is not ready', async () => {
      setup({ dbReady: false, installed: [await specWith({}, { expired: true })] });
      await specReconciler.requestFullConvergence({ reason: 'test' });
      expect(uninstallStub.called).to.equal(false);
    });
  });

  describe('expiry', () => {
    it('removes an installed app whose authoritative global row is expired', async () => {
      const row = await specWith({}, { name: 'gone' });
      setup({
        installed: [row],
        globalRows: [await specWith({}, { name: 'gone', expired: true })],
      });
      await specReconciler.requestFullConvergence({ reason: 'test' });
      expect(uninstallStub.calledOnceWith('gone', sinon.match({ forceKill: false, background: true, broadcastRemoval: true }))).to.equal(true);
    });

    it('trusts the authoritative global row over a stale local one (renewed app stays)', async () => {
      setup({
        installed: [await specWith({}, { name: 'renewed', expired: true })],
        globalRows: [await specWith({}, { name: 'renewed', expired: false })],
      });
      await specReconciler.requestFullConvergence({ reason: 'test' });
      expect(uninstallStub.called).to.equal(false);
    });

    it('never expires a forever app (height 0)', async () => {
      setup({
        installed: [await specWith({}, { name: 'forever', expired: true })],
        globalRows: [await specWith({}, { name: 'forever', height: 0, expired: true })],
      });
      await specReconciler.requestFullConvergence({ reason: 'test' });
      expect(uninstallStub.called).to.equal(false);
    });

    it('falls back to the local row when the app has no global registration', async () => {
      setup({ installed: [await specWith({}, { name: 'manual', expired: true })] });
      await specReconciler.requestFullConvergence({ reason: 'test' });
      expect(uninstallStub.calledOnceWith('manual', sinon.match({ background: true }))).to.equal(true);
    });
  });

  describe('named placement (declarative diff)', () => {
    it('removes the app when named placement does not target this node', async () => {
      setup({
        installed: [await specWith({ targetIps: { '9.9.9.9': ['s1'] } })],
        globalRows: [await specWith({ targetIps: { '9.9.9.9': ['s1'] } })],
      });
      await specReconciler.requestFullConvergence({ reason: 'test' });
      expect(uninstallStub.calledOnceWith('myapp', sinon.match({ broadcastRemoval: true }))).to.equal(true);
    });

    it('keeps a targeted named replica and never consults the location count', async () => {
      setup({
        installed: [await specWith({ targetIps: { '44.55.66.77': ['s1'] } })],
        globalRows: [await specWith({ targetIps: { '44.55.66.77': ['s1'] } })],
      });
      await specReconciler.requestFullConvergence({ reason: 'test' });
      expect(uninstallStub.called).to.equal(false);
      expect(appLocationStub.called, 'named mode never counts instances').to.equal(false);
    });

    it('sheds exactly a de-targeted identity: the sibling replica is untouched', async () => {
      const blob = { targetIps: { '44.55.66.77': ['s1'] } };
      setup({
        installed: [await specWith(blob)],
        globalRows: [await specWith(blob)],
      });
      // The node still runs s1 AND s2, but the spec now assigns only s1.
      dockerService.getAppContainerObjects.resolves([
        { Names: ['/fluxweb_myapp_s1'], Labels: { 'runonflux.app': 'myapp', 'runonflux.replica': 's1' } },
        { Names: ['/fluxweb_myapp_s2'], Labels: { 'runonflux.app': 'myapp', 'runonflux.replica': 's2' } },
      ]);
      await specReconciler.requestFullConvergence({ reason: 'test' });
      expect(uninstallStub.calledOnceWith('myapp', sinon.match({ broadcastRemoval: true, replica: 's2' }))).to.equal(true);
    });

    it('requalifies a pre-qualification install: the unlabeled identity is shed', async () => {
      const blob = { targetIps: { '44.55.66.77': ['s1'] } };
      setup({
        installed: [await specWith(blob)],
        globalRows: [await specWith(blob)],
      });
      dockerService.getAppContainerObjects.resolves([
        { Names: ['/fluxweb_myapp'], Labels: { 'runonflux.app': 'myapp' } },
      ]);
      await specReconciler.requestFullConvergence({ reason: 'test' });
      expect(uninstallStub.calledOnceWith('myapp', sinon.match({ broadcastRemoval: true, replica: null }))).to.equal(true);
    });

    it('a co-located union with nothing locally present removes nothing', async () => {
      const blob = {
        targetIps: { '44.55.66.77': ['s1'] },
        targetOutpoints: { [`${OUTPOINT_TXID}:0`]: ['s2'] },
      };
      setup({
        installed: [await specWith(blob)],
        globalRows: [await specWith(blob)],
      });
      await specReconciler.requestFullConvergence({ reason: 'test' });
      expect(uninstallStub.called, 'assigned identities with no local containers must not remove anything').to.equal(false);
    });
  });

  describe('loose over-instance (rank by runningSince)', () => {
    it('removes a surplus instance when this node ranks past the requirement', async () => {
      setup({
        installed: [await specWith({ targetIps: { '44.55.66.77': null, '9.9.9.9': null } })],
        globalRows: [await specWith({ targetIps: { '44.55.66.77': null, '9.9.9.9': null } })],
      });
      appLocationStub.resolves([
        { ip: '9.9.9.9:16127', runningSince: 1 },
        { ip: LOCAL_IP, runningSince: 9 },
      ]);
      await specReconciler.requestFullConvergence({ reason: 'test' });
      expect(uninstallStub.calledOnceWith('myapp', sinon.match({ broadcastRemoval: true }))).to.equal(true);
    });

    it('keeps an instance that ranks within the requirement', async () => {
      setup({
        installed: [await specWith({ targetIps: { '44.55.66.77': null, '9.9.9.9': null } })],
        globalRows: [await specWith({ targetIps: { '44.55.66.77': null, '9.9.9.9': null } })],
      });
      appLocationStub.resolves([
        { ip: LOCAL_IP, runningSince: 1 },
        { ip: '9.9.9.9:16127', runningSince: 9 },
      ]);
      await specReconciler.requestFullConvergence({ reason: 'test' });
      expect(uninstallStub.called).to.equal(false);
    });
  });

  describe('image compliance (deep passes only)', () => {
    it('removes a blocklisted app on a compliance pass', async () => {
      setup({ installed: [await specWith({})], globalRows: [await specWith({})] });
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves({ allImages: () => ['bad/image:1'] });
      sinon.stub(imageManager, 'isImageBlocked').resolves({ blocked: true });
      await specReconciler.requestFullConvergence({ reason: 'test', includeCompliance: true });
      expect(uninstallStub.calledOnceWith('myapp', sinon.match({ broadcastRemoval: true }))).to.equal(true);
    });

    it('never consults the blocklist on a shallow pass', async () => {
      setup({ installed: [await specWith({})], globalRows: [await specWith({})] });
      const blocked = sinon.stub(imageManager, 'isImageBlocked');
      await specReconciler.requestFullConvergence({ reason: 'test' });
      expect(blocked.called).to.equal(false);
    });
  });

  describe('Arcane placement (requiresArcane)', () => {
    it('removes a cleartext Arcane-requiring app from a non-Arcane node', async () => {
      setup({
        installed: [await specWith({}, { name: 'otlpapp' })],
        globalRows: [await specWith({}, { name: 'otlpapp', requiresArcane: true })],
      });
      await specReconciler.requestFullConvergence({ reason: 'test' });
      expect(uninstallStub.calledOnceWith('otlpapp', sinon.match({ forceKill: true, broadcastRemoval: true }))).to.equal(true);
    });

    it('keeps the app when the node is Arcane', async () => {
      setup({
        installed: [await specWith({}, { name: 'otlpapp' })],
        globalRows: [await specWith({}, { name: 'otlpapp', requiresArcane: true })],
      });
      sinon.stub(globalState, 'isArcane').returns(true);
      await specReconciler.requestFullConvergence({ reason: 'test' });
      expect(uninstallStub.called).to.equal(false);
    });
  });

  describe('adoption scheduling', () => {
    let clock;

    beforeEach(() => {
      clock = sinon.useFakeTimers();
    });

    afterEach(() => {
      clock.restore();
    });

    it('schedules a staggered adoption when the hash differs, and fires reconcileApp', async () => {
      const installedRow = await specWith({ targetIps: { '44.55.66.77': ['s1'] } }, { hash: 'v1' });
      const registryRow = await specWith({ targetIps: { '44.55.66.77': ['s1'] } }, { hash: 'v2' });
      setup({ installed: [installedRow], globalRows: [registryRow] });
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(null);
      sinon.stub(appsRepository, 'getInstalledApp').resolves(installedRow);
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(registryRow);

      await specReconciler.requestFullConvergence({ reason: 'test' });
      expect(uninstallStub.called).to.equal(false);
      expect(reconcileAppStub.called, 'adoption never fires inline').to.equal(false);

      // s1 is ordinal 0 -> delay 0; the timer still defers to the next tick.
      await clock.tickAsync(1);
      expect(reconcileAppStub.calledOnce).to.equal(true);
    });

    it('coalesces: a newer stored spec supersedes the pending adoption', async () => {
      const installedRow = await specWith({ targetIps: { '44.55.66.77': null } }, { hash: 'v1' });
      const v2 = await specWith({ targetIps: { '44.55.66.77': null } }, { hash: 'v2' });
      const v3 = await specWith({ targetIps: { '44.55.66.77': null } }, { hash: 'v3' });
      setup({ installed: [installedRow] });
      sinon.stub(appsRepository, 'getInstalledApp').resolves(installedRow);
      const getGlobal = sinon.stub(appsRepository, 'getGlobalAppInfo');
      getGlobal.onFirstCall().resolves(v2);
      getGlobal.onSecondCall().resolves(v3);
      getGlobal.resolves(v3);

      await specReconciler.requestAppConvergence('myapp', { reason: 'test' });
      await specReconciler.requestAppConvergence('myapp', { reason: 'test' });

      // Both requests land within the loose stagger window; only the LAST
      // scheduled spec fires, once.
      await clock.tickAsync(300000);
      expect(reconcileAppStub.calledOnce, 'one adoption for the latest spec').to.equal(true);
    });

    it('re-checks at fire time and skips when another path already adopted', async () => {
      const installedRow = await specWith({ targetIps: { '44.55.66.77': null } }, { hash: 'v2' });
      const registryRow = await specWith({ targetIps: { '44.55.66.77': null } }, { hash: 'v2' });
      setup({ installed: [await specWith({ targetIps: { '44.55.66.77': null } }, { hash: 'v1' })] });
      sinon.stub(appsRepository, 'getInstalledApp').resolves(installedRow);
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(registryRow);

      await specReconciler.requestAppConvergence('myapp', { reason: 'test' });
      await clock.tickAsync(300000);
      expect(reconcileAppStub.called, 'hashes converged before the timer fired').to.equal(false);
    });
  });

  describe('adoptionDelayMs (stagger math)', () => {
    it('rolls named replicas by ordinal in sorted name order', async () => {
      sinon.stub(generalService, 'obtainNodeCollateralInformation').resolves({ txhash: OUTPOINT_TXID, txindex: 0 });
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves(LOCAL_IP);
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves(null);
      // this node holds s2 - ordinal 1 of [s1, s2, s3] -> one step
      const registryRow = await specWith({
        targetIps: { '44.55.66.77': ['s2'], '9.9.9.9': ['s1'], '8.8.8.8': ['s3'] },
      });
      const delay = await specReconciler.adoptionDelayMs(registryRow, LOCAL_IP);
      expect(delay).to.equal(60000);
    });

    it('floors the named step at the graceful-shutdown budget', async () => {
      sinon.stub(generalService, 'obtainNodeCollateralInformation').resolves({ txhash: OUTPOINT_TXID, txindex: 0 });
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves(LOCAL_IP);
      sinon.stub(deploymentProvider, 'getInstalledDeployment').resolves({ marker: 'deployment' });
      sinon.stub(shutdownPlan, 'appRequiresDaemonShutdown').returns(true);
      sinon.stub(shutdownPlan, 'appShutdownBudgetSeconds').returns(120); // 120s drain > 60s step
      const registryRow = await specWith({
        targetIps: { '44.55.66.77': ['s2'], '9.9.9.9': ['s1'] },
      });
      const delay = await specReconciler.adoptionDelayMs(registryRow, LOCAL_IP);
      expect(delay).to.equal(120000 + 15000); // ordinal 1 x (budget + start margin)
    });

    it('bounds a loose instance inside the stagger window, deterministically', async () => {
      const registryRow = await specWith({ targetIps: { '44.55.66.77': null } });
      const a = await specReconciler.adoptionDelayMs(registryRow, LOCAL_IP);
      const b = await specReconciler.adoptionDelayMs(registryRow, LOCAL_IP);
      expect(a).to.equal(b);
      expect(a).to.be.at.least(0);
      expect(a).to.be.below(300000);
    });
  });

  describe('notifySpecStored', () => {
    it('ignores specs for apps not installed here', async () => {
      setup();
      const exists = sinon.stub(appsRepository, 'existsInstalledApp').resolves(false);
      const getInstalled = sinon.stub(appsRepository, 'getInstalledApp');
      specReconciler.notifySpecStored({ name: 'foreign' });
      await new Promise((resolve) => { setImmediate(resolve); });
      expect(exists.calledOnceWith('foreign')).to.equal(true);
      expect(getInstalled.called).to.equal(false);
    });
  });
});
