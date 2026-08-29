'use strict';

// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const {
  loadSpecLibrary, V9_SUBMISSION, v9Spec, instantiatedSpec, assertAnswers,
} = require('./fixtures/fluxSpec');
const specReconciler = require('../../ZelBack/src/services/appLifecycle/specReconciler');
const appUninstaller = require('../../ZelBack/src/services/appLifecycle/appUninstaller');
const appOperations = require('../../ZelBack/src/services/appLifecycle/appOperations');
const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');
const registryManager = require('../../ZelBack/src/services/appDatabase/registryManager');
const deploymentProvider = require('../../ZelBack/src/services/appRuntime/deploymentProvider');
const generalService = require('../../ZelBack/src/services/generalService');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const globalState = require('../../ZelBack/src/services/utils/globalState');
const imageManager = require('../../ZelBack/src/services/appSecurity/imageManager');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const dockerService = require('../../ZelBack/src/services/dockerService');

// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. Every installed/registry row below is a real InstantiatedSpec over a
// real FluxAppSpecV9, so the whole ladder reads the fields production reads:
// placement.mode(), assignment.replicasFor(), requiresArcane(), isExpired(),
// spec.instances. What stays stubbed is I/O and the actuators — mongo through
// appsRepository, docker, the uninstaller, the blocklist and reconcileApp.
describe('specReconciler tests', () => {
  const LOCAL_IP = '44.55.66.77:16127';
  const LOCAL_TARGET = '44.55.66.77';
  const OTHER_TARGET = '9.9.9.9';
  const THIRD_TARGET = '8.8.8.8';
  const OUTPOINT_TXID = 'a'.repeat(64);

  // Expiry is the REAL v9 rule — registeredAt + ttl < tipBlockTime — never a
  // stubbed predicate. V9_SUBMISSION's ttl is 30 days, so a row registered here
  // is long past it against wall-clock time, and one registered "now" is not.
  const LONG_EXPIRED_AT = 1751628800;

  let flux;

  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30000);
    flux = await loadSpecLibrary();
  });

  /**
   * A docker inspect object for one identity of `myapp`. The SHAPE is docker's,
   * so a literal is right; the label KEYS are a flux-spec contract, and the
   * reconciler reads them from the library, so the fixture takes them from the
   * same place. A hardcoded 'io.runonflux.replica' would survive a rename and
   * quietly stop matching anything.
   */
  function containerFor(replica) {
    const labels = { [flux.LABEL_KEYS.APP]: 'myapp' };
    if (replica !== null) labels[flux.LABEL_KEYS.REPLICA] = replica;
    return { Names: [replica === null ? '/fluxweb_myapp' : `/fluxweb_myapp_${replica}`], Labels: labels };
  }

  /** V9_SUBMISSION's single component with fields overridden. Cloned: the
   * frozen fixture is shared with every other suite. */
  function componentsWith(overrides) {
    const components = structuredClone(V9_SUBMISSION.components);
    Object.assign(components.web, overrides);
    return components;
  }

  /**
   * A real InstantiatedSpec over a real FluxAppSpecV9, from the terse targeting
   * shorthand the old hand-written double used: an entry `{ identity: null }` is
   * a candidate (loose) target, `{ identity: [names] }` pins those named
   * replicas.
   *
   * The shorthand now feeds the REAL split. Named entries become the sealed
   * `assignment`; the cleartext `placement` identity set, `placement.mode` and
   * `instances` are then DERIVED from it by the class (authoring `instances`
   * alongside an assignment is exactly what FluxAppSpecV9 rejects). Loose
   * entries go straight onto `placement`, where they derive mode 'candidate',
   * and no entries at all derive mode 'none'.
   *
   * The row's `hash` defaults to the spec's own `contentHash()`. That is what
   * makes "the spec changed" and "the spec did not change" mean something: two
   * rows built from the same arguments are byte-identical and hash-identical, so
   * the converged rung is reachable, while a row built with a different `cpu` is
   * a genuinely different spec whose hash genuinely differs. A hand-set label
   * let a test claim an update where it had handed over the same spec twice.
   */
  async function specWith(targetsBlob, {
    name = 'myapp', height = 2550000, expired = false, instances = 1,
    cpu, preStop = false, hash,
  } = {}) {
    const placement = { targetIps: [], targetOutpoints: [], targetOperators: [] };
    const assignment = { targetIps: {}, targetOutpoints: {} };
    let pinned = false;
    for (const field of ['targetIps', 'targetOutpoints', 'targetOperators']) {
      const map = targetsBlob && targetsBlob[field];
      if (!map) continue;
      for (const [identity, names] of Object.entries(map)) {
        // Operators cannot pin — one key backs arbitrarily many nodes, and the
        // real class refuses a pinned placement that names any.
        if (field === 'targetOperators' || !Array.isArray(names) || names.length === 0) {
          placement[field].push(identity);
        } else {
          assignment[field][identity] = names;
          pinned = true;
        }
      }
    }

    const overrides = { name, placement };
    if (pinned) {
      overrides.assignment = assignment;
      overrides.instances = undefined; // derived from the assignment
    } else {
      overrides.instances = instances;
    }

    const componentOverrides = {};
    if (cpu !== undefined) componentOverrides.cpu = cpu;
    // A cleartext v9 spec that requires ArcaneOS: preStop is one of
    // ARCANE_REQUIRING_FIELDS, so requiresArcane() is the class's own answer.
    // Its 110s timeout plus docker's 10s default grace is also a real 120s
    // graceful-shutdown budget, which the stagger floor reads back out.
    if (preStop) {
      componentOverrides.preStop = { type: 'exec', cmd: ['/bin/sh', '-c', 'flush-cache'], timeout: 110 };
    }
    if (Object.keys(componentOverrides).length) {
      overrides.components = componentsWith(componentOverrides);
    }

    const spec = await v9Spec(overrides);
    return instantiatedSpec(spec, {
      hash: hash ?? spec.contentHash(),
      height,
      registeredAt: expired ? LONG_EXPIRED_AT : Math.floor(Date.now() / 1000),
    });
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
    // The per-identity diff enumerates this app's containers; no real docker in
    // unit tests (and none of these fixtures have containers).
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
        installed: [await specWith({ targetIps: { [OTHER_TARGET]: ['s1'] } })],
        globalRows: [await specWith({ targetIps: { [OTHER_TARGET]: ['s1'] } })],
      });
      await specReconciler.requestFullConvergence({ reason: 'test' });
      expect(uninstallStub.calledOnceWith('myapp', sinon.match({ broadcastRemoval: true }))).to.equal(true);
    });

    it('keeps a targeted named replica and never consults the location count', async () => {
      setup({
        installed: [await specWith({ targetIps: { [LOCAL_TARGET]: ['s1'] } })],
        globalRows: [await specWith({ targetIps: { [LOCAL_TARGET]: ['s1'] } })],
      });
      await specReconciler.requestFullConvergence({ reason: 'test' });
      expect(uninstallStub.called).to.equal(false);
      expect(appLocationStub.called, 'named mode never counts instances').to.equal(false);
    });

    it('sheds exactly a de-targeted identity: the sibling replica is untouched', async () => {
      const blob = { targetIps: { [LOCAL_TARGET]: ['s1'] } };
      setup({
        installed: [await specWith(blob)],
        globalRows: [await specWith(blob)],
      });
      // The node still runs s1 AND s2, but the spec now assigns only s1.
      dockerService.getAppContainerObjects.resolves([containerFor('s1'), containerFor('s2')]);
      await specReconciler.requestFullConvergence({ reason: 'test' });
      expect(uninstallStub.calledOnceWith('myapp', sinon.match({ broadcastRemoval: true, replica: 's2' }))).to.equal(true);
    });

    it('requalifies a pre-qualification install: the unlabeled identity is shed', async () => {
      const blob = { targetIps: { [LOCAL_TARGET]: ['s1'] } };
      setup({
        installed: [await specWith(blob)],
        globalRows: [await specWith(blob)],
      });
      dockerService.getAppContainerObjects.resolves([containerFor(null)]);
      await specReconciler.requestFullConvergence({ reason: 'test' });
      expect(uninstallStub.calledOnceWith('myapp', sinon.match({ broadcastRemoval: true, replica: null }))).to.equal(true);
    });

    it('a co-located union with nothing locally present removes nothing', async () => {
      const blob = {
        targetIps: { [LOCAL_TARGET]: ['s1'] },
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

  describe('loose placement de-qualifies', () => {
    const looseBlob = { targetIps: { [LOCAL_TARGET]: null, [OTHER_TARGET]: null } };

    it('sheds a qualified replica left behind when placement switched back to loose', async () => {
      setup({
        installed: [await specWith(looseBlob)],
        globalRows: [await specWith(looseBlob)],
      });
      // The node still runs the container from the app's named phase. Loose
      // placement is never qualified, so that identity cannot stay: without the
      // shed the installed row keeps its replica key and the reconciler starts
      // the stale identity forever.
      dockerService.getAppContainerObjects.resolves([containerFor('m1')]);
      await specReconciler.requestFullConvergence({ reason: 'test' });
      expect(uninstallStub.calledOnceWith('myapp', sinon.match({ broadcastRemoval: true, replica: 'm1' }))).to.equal(true);
    });

    it('leaves a loose instance alone: the unqualified identity is the one loose assigns', async () => {
      setup({
        installed: [await specWith(looseBlob)],
        globalRows: [await specWith(looseBlob)],
      });
      dockerService.getAppContainerObjects.resolves([containerFor(null)]);
      await specReconciler.requestFullConvergence({ reason: 'test' });
      expect(uninstallStub.called).to.equal(false);
    });
  });

  describe('loose over-instance (rank by runningSince)', () => {
    const looseBlob = { targetIps: { [LOCAL_TARGET]: null, [OTHER_TARGET]: null } };

    it('removes a surplus instance when this node ranks past the requirement', async () => {
      // instances is the spec's own field, read off the real class as
      // installed.spec.instances — one seat, two claimants.
      setup({
        installed: [await specWith(looseBlob, { instances: 1 })],
        globalRows: [await specWith(looseBlob, { instances: 1 })],
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
        installed: [await specWith(looseBlob, { instances: 1 })],
        globalRows: [await specWith(looseBlob, { instances: 1 })],
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
      const row = await specWith({});
      setup({ installed: [row], globalRows: [await specWith({})] });
      // The deployment view is built for real from the real spec, so the image
      // list handed to the blocklist is the one the app actually declares.
      sinon.stub(appsRepository, 'getInstalledApp').resolves(row);
      const blocked = sinon.stub(imageManager, 'isImageBlocked').resolves({ blocked: true });
      await specReconciler.requestFullConvergence({ reason: 'test', includeCompliance: true });
      expect(uninstallStub.calledOnceWith('myapp', sinon.match({ broadcastRemoval: true }))).to.equal(true);
      const [handedName, handedImages, handedProvenance] = blocked.firstCall.args;
      expect(handedName).to.equal('myapp');
      expect(handedImages, 'the blocklist is asked about the real deployment\'s images').to.deep.equal(['nginx:latest']);
      // The stubbed collaborator reads owner + hash off the row: both are the
      // real spec's, not a literal ('owner1' is not an address the class accepts).
      expect(handedProvenance).to.deep.equal({ owner: row.owner, hash: row.hash });
      expect(handedProvenance.owner).to.equal(V9_SUBMISSION.owner);
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
      // requiresArcane() is the class's own verdict over a cleartext spec whose
      // component declares a preStop hook — flux-shutdownd runs only on Arcane.
      const row = await specWith({}, { name: 'otlpapp', preStop: true });
      expect(row.requiresArcane(), 'the fixture must really require Arcane').to.equal(true);
      setup({ installed: [row], globalRows: [await specWith({}, { name: 'otlpapp', preStop: true })] });
      await specReconciler.requestFullConvergence({ reason: 'test' });
      expect(uninstallStub.calledOnceWith('otlpapp', sinon.match({ forceKill: true, broadcastRemoval: true }))).to.equal(true);
    });

    it('keeps the app when the node is Arcane', async () => {
      setup({
        installed: [await specWith({}, { name: 'otlpapp', preStop: true })],
        globalRows: [await specWith({}, { name: 'otlpapp', preStop: true })],
      });
      sinon.stub(globalState, 'isArcane').returns(true);
      await specReconciler.requestFullConvergence({ reason: 'test' });
      expect(uninstallStub.called).to.equal(false);
    });
  });

  describe('adoption scheduling', () => {
    let clock;

    afterEach(() => {
      if (clock) clock.restore();
      clock = null;
    });

    it('does no work at all when the stored spec is the one already installed', async () => {
      // The converged rung, reachable only because the two rows are the SAME
      // real spec and therefore carry the same hash. A double whose hash is a
      // hand-set label can assert this without the specs matching at all.
      const installedRow = await specWith({ targetIps: { [LOCAL_TARGET]: ['s1'] } });
      const registryRow = await specWith({ targetIps: { [LOCAL_TARGET]: ['s1'] } });
      expect(registryRow.hash, 'same spec, same content hash').to.equal(installedRow.hash);
      expect(registryRow.spec.equals(installedRow.spec), 'and the real deep compare agrees').to.equal(true);
      setup({ installed: [installedRow], globalRows: [registryRow] });
      // fireAdoption's first act is to re-read the installed row, so these
      // staying untouched across the whole stagger window is what "nothing was
      // scheduled" means.
      const getInstalled = sinon.stub(appsRepository, 'getInstalledApp').resolves(installedRow);
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(registryRow);
      clock = sinon.useFakeTimers();

      await specReconciler.requestFullConvergence({ reason: 'test' });
      expect(uninstallStub.called).to.equal(false);
      await clock.tickAsync(300000);
      expect(getInstalled.called, 'nothing is scheduled for an unchanged spec').to.equal(false);
      expect(reconcileAppStub.called).to.equal(false);
    });

    it('schedules a staggered adoption when the hash differs, and fires reconcileApp', async () => {
      const installedRow = await specWith({ targetIps: { [LOCAL_TARGET]: ['s1'] } }, { cpu: 0.5 });
      const registryRow = await specWith({ targetIps: { [LOCAL_TARGET]: ['s1'] } }, { cpu: 1 });
      expect(registryRow.hash, 'a real spec change moves the content hash').to.not.equal(installedRow.hash);
      setup({ installed: [installedRow], globalRows: [registryRow] });
      sinon.stub(appsRepository, 'getInstalledApp').resolves(installedRow);
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(registryRow);
      clock = sinon.useFakeTimers();

      await specReconciler.requestFullConvergence({ reason: 'test' });
      expect(uninstallStub.called).to.equal(false);
      expect(reconcileAppStub.called, 'adoption never fires inline').to.equal(false);

      // s1 is ordinal 0 -> delay 0; the timer still defers to the next tick.
      await clock.tickAsync(1);
      expect(reconcileAppStub.calledOnce).to.equal(true);

      // reconcileApp stays stubbed, so nothing else proves what it was handed.
      // It reads name/identity off the installed row and pushes the registry row
      // straight into deploymentProvider.buildDeployments.
      const [handedInstalled, handedRegistry] = reconcileAppStub.firstCall.args;
      assertAnswers(handedInstalled, ['serialize']);
      assertAnswers(handedRegistry, ['serialize']);
      expect(handedInstalled.name).to.equal('myapp');
      expect(handedRegistry.hash).to.equal(registryRow.hash);
      const deployments = await deploymentProvider.buildDeployments(
        handedRegistry, { identity: handedInstalled.identity ?? null },
      );
      expect(deployments.map((deployment) => deployment.replica)).to.deep.equal(['s1']);
    });

    it('coalesces: a newer stored spec supersedes the pending adoption', async () => {
      const loose = { targetIps: { [LOCAL_TARGET]: null } };
      const installedRow = await specWith(loose, { cpu: 0.5 });
      const v2 = await specWith(loose, { cpu: 1 });
      const v3 = await specWith(loose, { cpu: 1.5 });
      setup({ installed: [installedRow] });
      sinon.stub(appsRepository, 'getInstalledApp').resolves(installedRow);
      const getGlobal = sinon.stub(appsRepository, 'getGlobalAppInfo');
      getGlobal.onFirstCall().resolves(v2);
      getGlobal.onSecondCall().resolves(v3);
      getGlobal.resolves(v3);
      clock = sinon.useFakeTimers();

      await specReconciler.requestAppConvergence('myapp', { reason: 'test' });
      await specReconciler.requestAppConvergence('myapp', { reason: 'test' });

      // Both requests land within the loose stagger window; only the LAST
      // scheduled spec fires, once.
      await clock.tickAsync(300000);
      expect(reconcileAppStub.calledOnce, 'one adoption for the latest spec').to.equal(true);
      expect(reconcileAppStub.firstCall.args[1].hash).to.equal(v3.hash);
    });

    it('re-checks at fire time and skips when another path already adopted', async () => {
      const loose = { targetIps: { [LOCAL_TARGET]: null } };
      const staleRow = await specWith(loose, { cpu: 0.5 });
      const registryRow = await specWith(loose, { cpu: 1 });
      setup({ installed: [staleRow] });
      const getInstalled = sinon.stub(appsRepository, 'getInstalledApp');
      // The scheduling read sees the stale row; by the time the timer fires,
      // another path (install, reconcile) has already stored the new spec.
      getInstalled.onFirstCall().resolves(staleRow);
      getInstalled.resolves(registryRow);
      sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(registryRow);
      clock = sinon.useFakeTimers();

      await specReconciler.requestAppConvergence('myapp', { reason: 'test' });
      expect(getInstalled.callCount, 'the convergence pass read the installed row once').to.equal(1);
      await clock.tickAsync(300000);
      // The second read is fireAdoption's own: an adoption really was scheduled
      // and really did re-check, rather than never having been scheduled at all.
      expect(getInstalled.callCount, 'the timer fired and re-read the installed row').to.equal(2);
      expect(reconcileAppStub.called, 'hashes converged before the timer fired').to.equal(false);
    });
  });

  describe('adoptionDelayMs (stagger math)', () => {
    it('rolls named replicas by ordinal in sorted name order', async () => {
      sinon.stub(generalService, 'obtainNodeCollateralInformation').resolves({ txhash: OUTPOINT_TXID, txindex: 0 });
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves(LOCAL_IP);
      // this node holds s2 - ordinal 1 of [s1, s2, s3] -> one step
      const registryRow = await specWith({
        targetIps: { [LOCAL_TARGET]: ['s2'], [OTHER_TARGET]: ['s1'], [THIRD_TARGET]: ['s3'] },
      });
      // The deployment view is built for real; this app declares no shutdown
      // feature, so the step keeps the configured 60s.
      sinon.stub(appsRepository, 'getInstalledApp').resolves(registryRow);
      const delay = await specReconciler.adoptionDelayMs(registryRow, LOCAL_IP);
      expect(delay).to.equal(60000);
    });

    it('floors the named step at the graceful-shutdown budget', async () => {
      sinon.stub(generalService, 'obtainNodeCollateralInformation').resolves({ txhash: OUTPOINT_TXID, txindex: 0 });
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves(LOCAL_IP);
      // preStop 110s + docker's 10s default grace = a real 120s drain budget,
      // read back out of the real DeploymentSpec by shutdownPlan — no stub in
      // the arithmetic.
      const registryRow = await specWith({
        targetIps: { [LOCAL_TARGET]: ['s2'], [OTHER_TARGET]: ['s1'] },
      }, { preStop: true });
      sinon.stub(appsRepository, 'getInstalledApp').resolves(registryRow);
      const delay = await specReconciler.adoptionDelayMs(registryRow, LOCAL_IP);
      expect(delay).to.equal(120000 + 15000); // ordinal 1 x (budget + start margin)
    });

    it('bounds a loose instance inside the stagger window, deterministically', async () => {
      const registryRow = await specWith({ targetIps: { [LOCAL_TARGET]: null } });
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
      // The exact bytes the store writes: an InstantiatedSpec's serialization.
      const doc = (await specWith({}, { name: 'foreign' })).serialize();
      const exists = sinon.stub(appsRepository, 'existsInstalledApp').resolves(false);
      const getInstalled = sinon.stub(appsRepository, 'getInstalledApp');
      specReconciler.notifySpecStored(doc);
      await new Promise((resolve) => { setImmediate(resolve); });
      expect(exists.calledOnceWith('foreign')).to.equal(true);
      expect(getInstalled.called).to.equal(false);
    });
  });
});
