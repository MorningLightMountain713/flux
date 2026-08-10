'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
// Real registry singleton - un-stubbed in proxyquire, so the uninstaller and the test share it.
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');

describe('appUninstaller tests', () => {
  let appUninstaller;
  let verificationHelperStub;
  let messageHelperStub;
  let logStub;
  let configStub;
  let globalStateStub;
  let dockerServiceStub;
  let appsRepositoryStub;
  let fluxShutdowndClientStub;
  let appNetworkLinkerStub;
  let pendingTeardownStoreStub;

  beforeEach(() => {
    configStub = {
      database: {
        url: 'mongodb://localhost:27017',
        daemon: {
          collections: { scannedHeight: 'scannedHeight', appsHashes: 'appsHashes' },
          database: 'daemon',
        },
        appslocal: {
          collections: { appsInformation: 'localAppsInformation' },
          database: 'localapps',
        },
        appsglobal: {
          collections: {
            appsMessages: 'appsMessages',
            appsInformation: 'globalAppsInformation',
            appsTemporaryMessages: 'appsTemporaryMessages',
          },
          database: 'globalapps',
        },
      },
      fluxapps: {
        newMinBlocksAllowance: 22000,
        newMinBlocksAllowanceBlock: 1000000,
        minBlocksAllowance: 5000,
        manageCollectorLifecycle: false,
      },
    };

    verificationHelperStub = {
      verifyPrivilege: sinon.stub(),
    };

    messageHelperStub = {
      createErrorMessage: sinon.stub(),
      errUnauthorizedMessage: sinon.stub(),
      createSuccessMessage: sinon.stub().returns({ status: 'success' }),
    };

    logStub = {
      error: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
    };

    globalStateStub = {
      abortInstall: sinon.stub(),
      installAborted: sinon.stub().returns(false),
      runningAppsCache: new Set(),
      trySpawningGlobalAppCache: new Map(),
    };

    dockerServiceStub = {
      appDockerStop: sinon.stub().resolves(),
      appDockerKill: sinon.stub().resolves(),
      appDockerRemove: sinon.stub().resolves(),
      // container gone after a successful remove: the teardown reclaims host storage
      getDockerContainer: sinon.stub().resolves(null),
      appDockerImageRemove: sinon.stub().resolves(),
      dockerListContainers: sinon.stub().resolves([]),
      forceRemoveFluxAppDockerNetwork: sinon.stub().resolves(),
      removeFluxAppDockerNetwork: sinon.stub().resolves(),
      getAppIdentifier: sinon.stub().returns('testapp'),
      getBaseAppName: sinon.stub().callsFake((id) => id),
    };

    fluxShutdowndClientStub = {
      SHUTDOWN_REASON: {
        TTL_EXPIRED: 'ttl-expired', USER_CANCEL: 'user-cancel', REDEPLOY: 'redeploy', EVICTION: 'eviction', MANUAL: 'manual',
      },
      beginAppStop: sinon.stub().resolves({ outcome: 'not_arcane' }),
      forceAppStop: sinon.stub().resolves({ outcome: 'forced' }),
      deleteAppPlanBestEffort: sinon.stub().resolves(),
    };

    appsRepositoryStub = {
      getInstalledApp: sinon.stub().resolves(null),
      getGlobalAppInfo: sinon.stub().resolves(null),
      getAppMessage: sinon.stub().resolves(null),
      removeInstalledApp: sinon.stub().resolves(),
      removeInstalledIdentity: sinon.stub().resolves(),
      countInstalledIdentities: sinon.stub().resolves(0),
      listInstalledApps: sinon.stub().resolves([]),
      listGlobalAppInfo: sinon.stub().resolves([]),
      removeGlobalAppInfo: sinon.stub().resolves(),
    };

    appNetworkLinkerStub = {
      isPureFollowerApp: sinon.stub().resolves(false),
      findInstalledWorkloadsRequiring: sinon.stub().resolves([]),
      findUnrequiredInstalledDependencies: sinon.stub().resolves([]),
    };

    pendingTeardownStoreStub = {
      writeTeardown: sinon.stub().resolves(),
      clearTeardown: sinon.stub().resolves(),
      teardownOwedFor: sinon.stub().resolves(false),
      listTeardowns: sinon.stub().resolves([]),
    };

    appUninstaller = proxyquire('../../ZelBack/src/services/appLifecycle/appUninstaller', {
      config: configStub,
      '../verificationHelper': verificationHelperStub,
      '../messageHelper': messageHelperStub,
      '../serviceHelper': {
        ensureString: sinon.stub().returnsArg(0),
        ensureBoolean: sinon.stub().returnsArg(0),
        ensureNumber: sinon.stub().callsFake((v) => Number(v)),
        delay: sinon.stub().resolves(),
      },
      '../dockerService': dockerServiceStub,
      // Required by appUninstaller and previously left real: getVolumeFilePath and
      // isPathMounted run through the real serviceHelper and spawn processes.
      '../utils/volumeService': {
        getVolumeFilePath: sinon.stub().resolves('/tmp/flux-test-volume'),
        isPathMounted: sinon.stub().resolves(false),
      },
      // Left real, this reads the developer's own crontab.
      crontab: { load: (cb) => cb(null, null) },
      '../../lib/log': logStub,
      '../utils/globalState': globalStateStub,
      '../telemetryConfigService': {
        ensureNode: sinon.stub().resolves(),
        remove: sinon.stub().resolves(),
      },
      // Stubbed so the standalone run never reaches the real imageCacheStore,
      // whose DB fail-safe ("keep") would mask the reference-gated GC under test.
      './imageCacheRetention': {
        shouldRetainImage: sinon.stub().resolves(false),
      },
      '../upnpService': {
        removeMapUpnpPort: sinon.stub().resolves(),
        isUPNP: sinon.stub().returns(false),
      },
      '../fluxNetworkHelper': {
        closeConnection: sinon.stub().resolves(),
        isFirewallActive: sinon.stub().resolves(false),
        allowPort: sinon.stub().resolves(true),
        getLocalSocketAddress: sinon.stub().resolves('7.7.7.7:16127'),
      },
      '../fluxCommunicationMessagesSender': {
        broadcastMessageToOutgoing: sinon.stub().resolves(),
        broadcastMessageToIncoming: sinon.stub().resolves(),
        broadcastMessageToAll: sinon.stub().resolves(),
      },
      '../appDatabase/appsRepository': appsRepositoryStub,
      './appNetworkLinker': appNetworkLinkerStub,
      './pendingTeardownStore': pendingTeardownStoreStub,
      '../appManagement/appsRuntimeState': {
        setCondemned: sinon.stub().resolves(),
        removeComponentState: sinon.stub().resolves(),
      },
      '../appRuntime/deploymentProvider': {
        getInstalledDeployment: sinon.stub().resolves(null),
        buildDeployment: sinon.stub().resolves(null),
        localIdentities: sinon.stub().resolves([null]),
      },
      '../appManagement/appInspector': {
        stopAppMonitoring: sinon.stub().resolves(),
      },
      '../utils/fluxShutdowndClient': fluxShutdowndClientStub,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('removeAppLocallyApi', () => {
    it('should reject unauthorized users', async () => {
      const req = {
        params: { appname: 'testapp' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      verificationHelperStub.verifyPrivilege.resolves(false);
      messageHelperStub.errUnauthorizedMessage.returns({ status: 'error' });

      await appUninstaller.removeAppLocallyApi(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(verificationHelperStub.verifyPrivilege.called).to.be.true;
    });

    it('should handle missing appname parameter', async () => {
      const req = {
        params: {},
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      messageHelperStub.createErrorMessage.returns({ status: 'error' });

      await appUninstaller.removeAppLocallyApi(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(logStub.error.called).to.be.true;
    });
  });

  describe('uninstallApplication tests', () => {
    it('reports the error via onStatus and returns FAILED if no app name is specified', async () => {
      const messages = [];
      const result = await appUninstaller.uninstallApplication(undefined, { onStatus: (msg) => messages.push(msg) });
      expect(messages.some((m) => m.includes('No App specified'))).to.be.true;
      expect(result.status).to.equal(appUninstaller.UninstallStatus.FAILED);
    });

    it('reports not found via onStatus and returns SKIPPED when the app is missing and skipGuard is false', async () => {
      const messages = [];
      const result = await appUninstaller.uninstallApplication('nonexistent', { onStatus: (msg) => messages.push(msg) });
      expect(messages.some((m) => m.includes('Flux App not found'))).to.be.true;
      expect(result.status).to.equal(appUninstaller.UninstallStatus.SKIPPED);
    });

    it('returns DEFERRED without attempting removal when the app holds an operation lease', async () => {
      operationRegistry.acquire('anyapp', 'install', 'test');
      try {
        const result = await appUninstaller.uninstallApplication('anyapp', {});
        expect(result.status).to.equal(appUninstaller.UninstallStatus.DEFERRED);
      } finally {
        operationRegistry.clear();
      }
    });

    it('skipGuard never bypasses an ACTIVE remove lease (no double teardown)', async () => {
      operationRegistry.acquire('anyapp', 'remove', 'other-teardown');
      try {
        const result = await appUninstaller.uninstallApplication('anyapp', { forceKill: true, skipGuard: true });
        expect(result.status).to.equal(appUninstaller.UninstallStatus.DEFERRED);
      } finally {
        operationRegistry.clear();
      }
    });

    it('skipGuard still barges past a NON-remove lease (install cleanup / force past a redeploy)', async () => {
      operationRegistry.acquire('anyapp', 'install', 'the-install');
      appsRepositoryStub.getInstalledApp.resolves(null);
      appsRepositoryStub.getGlobalAppInfo.resolves(null);
      try {
        const result = await appUninstaller.uninstallApplication('anyapp', { forceKill: true, skipGuard: true });
        // it proceeds past the install lease (does not defer); the app is simply not found here
        expect(result.status).to.not.equal(appUninstaller.UninstallStatus.DEFERRED);
      } finally {
        operationRegistry.clear();
      }
    });

    it('operatorForce defers when a remove lease is held but nothing is draining to escalate', async () => {
      operationRegistry.acquire('anyapp', 'remove', 'the-teardown'); // no escalation registered
      try {
        const result = await appUninstaller.uninstallApplication('anyapp', { forceKill: true, skipGuard: true, operatorForce: true });
        expect(result.status).to.equal(appUninstaller.UninstallStatus.DEFERRED);
      } finally {
        operationRegistry.clear();
      }
    });
  });

  describe('reclaimUnusedImages (reference-gated image GC)', () => {
    const noop = () => {};

    it('removes an image no remaining container references', async () => {
      dockerServiceStub.dockerListContainers.resolves([]);
      await appUninstaller.reclaimUnusedImages(['alpine:latest'], noop);
      expect(dockerServiceStub.appDockerImageRemove.calledOnceWithExactly('alpine:latest')).to.be.true;
    });

    it('leaves an image still referenced by another container (matched by tag)', async () => {
      dockerServiceStub.dockerListContainers.resolves([{ Image: 'alpine:latest' }]);
      await appUninstaller.reclaimUnusedImages(['alpine:latest'], noop);
      expect(dockerServiceStub.appDockerImageRemove.called).to.be.false;
    });

    it('leaves an image still referenced by ImageID', async () => {
      dockerServiceStub.dockerListContainers.resolves([{ Image: 'other:tag', ImageID: 'sha256:abc' }]);
      await appUninstaller.reclaimUnusedImages(['sha256:abc'], noop);
      expect(dockerServiceStub.appDockerImageRemove.called).to.be.false;
    });

    it('deduplicates a shared image to a single removal', async () => {
      dockerServiceStub.dockerListContainers.resolves([]);
      await appUninstaller.reclaimUnusedImages(['alpine:latest', 'alpine:latest', 'alpine:latest'], noop);
      expect(dockerServiceStub.appDockerImageRemove.calledOnce).to.be.true;
    });

    it('treats a Docker "must force" 409 as benign (no error logged)', async () => {
      dockerServiceStub.dockerListContainers.resolves([]);
      dockerServiceStub.appDockerImageRemove.rejects(new Error('(HTTP code 409) unable to remove repository reference "alpine:latest" (must force)'));
      await appUninstaller.reclaimUnusedImages(['alpine:latest'], noop);
      expect(logStub.error.called).to.be.false;
    });

    it('no-ops on an empty list without listing containers', async () => {
      await appUninstaller.reclaimUnusedImages([], noop);
      expect(dockerServiceStub.dockerListContainers.called).to.be.false;
    });
  });

  describe('runTeardown stop routing through flux-shutdownd', () => {
    const doc = () => ({
      key: 'myapp',
      name: 'myapp',
      networkName: 'myapp',
      forceKill: false,
      owner: '1own',
      reason: 'user-cancel',
      shutdownBudgetSeconds: 30,
      components: [{
        identifier: 'web_myapp', appId: 'fluxweb_myapp', label: 'web', ports: [],
      }],
    });

    it('passes the persisted reason + force to beginAppStop', async () => {
      fluxShutdowndClientStub.beginAppStop.resolves({ outcome: 'rejected_pipeline_active' });
      await appUninstaller.runTeardown(doc());
      expect(fluxShutdowndClientStub.beginAppStop.calledOnce).to.equal(true);
      const [owner, name, reason, opts] = fluxShutdowndClientStub.beginAppStop.firstCall.args;
      expect(owner).to.equal('1own');
      expect(name).to.equal('myapp');
      expect(reason).to.equal('user-cancel');
      expect(opts.force).to.equal(false);
      // A doc with no replica is a whole-app stop: replica must arrive as
      // definite null, never undefined.
      expect(opts.replica).to.equal(null);
    });

    it('scopes the daemon stop to the teardown doc identity (a scale-down never drains the sibling)', async () => {
      fluxShutdowndClientStub.beginAppStop.resolves({ outcome: 'rejected_pipeline_active' });
      await appUninstaller.runTeardown({ ...doc(), key: 'myapp_s2', replica: 's2' });
      const opts = fluxShutdowndClientStub.beginAppStop.firstCall.args[3];
      expect(opts.replica).to.equal('s2');
    });

    it('defers (no local stop, no remove) when a node-wide shutdown owns the stop', async () => {
      fluxShutdowndClientStub.beginAppStop.resolves({ outcome: 'rejected_pipeline_active' });
      await appUninstaller.runTeardown(doc());
      expect(dockerServiceStub.appDockerStop.called).to.equal(false);
      expect(dockerServiceStub.appDockerKill.called).to.equal(false);
      expect(dockerServiceStub.appDockerRemove.called).to.equal(false);
    });

    it('stops locally (appDockerStop, never kill) when the daemon is absent (non-Arcane)', async () => {
      fluxShutdowndClientStub.beginAppStop.resolves({ outcome: 'not_arcane' });
      // the host teardown after the stop loop touches unmocked deps; the stop loop runs first.
      await appUninstaller.runTeardown(doc()).catch(() => {});
      expect(dockerServiceStub.appDockerStop.calledWith('fluxweb_myapp')).to.equal(true);
      expect(dockerServiceStub.appDockerKill.called).to.equal(false);
    });

    it('skips the local stop when the daemon already drained it (Arcane)', async () => {
      fluxShutdowndClientStub.beginAppStop.resolves({ outcome: 'complete' });
      await appUninstaller.runTeardown(doc()).catch(() => {});
      expect(dockerServiceStub.appDockerStop.called).to.equal(false);
      expect(dockerServiceStub.appDockerKill.called).to.equal(false);
    });

    it('force-disconnects endpoints and removes the network even on a graceful teardown (no leak)', async () => {
      fluxShutdowndClientStub.beginAppStop.resolves({ outcome: 'complete' });
      await appUninstaller.runTeardown(doc()).catch(() => {});
      expect(dockerServiceStub.forceRemoveFluxAppDockerNetwork.calledWith('myapp')).to.equal(true);
      expect(dockerServiceStub.removeFluxAppDockerNetwork.called).to.equal(false);
    });

    it('refuses a second concurrent teardown of the same app (single-flight)', async () => {
      // Hold the first teardown open at the shutdownd stop so the second overlaps it.
      let releaseStop;
      fluxShutdowndClientStub.beginAppStop.onFirstCall().returns(new Promise((resolve) => { releaseStop = resolve; }));
      fluxShutdowndClientStub.beginAppStop.onSecondCall().resolves({ outcome: 'not_arcane' });

      const first = appUninstaller.runTeardown(doc()).catch(() => {});
      await appUninstaller.runTeardown(doc()); // same key -> single-flight bail, returns at once

      expect(fluxShutdowndClientStub.beginAppStop.callCount, 'the second teardown must not start a second stop').to.equal(1);
      releaseStop({ outcome: 'not_arcane' });
      await first;
    });

    it('an operator force-remove escalates the in-flight graceful drain via the daemon', async () => {
      const settle = () => new Promise((resolve) => { setImmediate(() => setImmediate(resolve)); });
      // A graceful teardown in flight, held at the drain, registers its escalation.
      let releaseStop;
      fluxShutdowndClientStub.beginAppStop.onFirstCall().returns(new Promise((resolve) => { releaseStop = resolve; }));
      const draining = appUninstaller.runTeardown(doc()).catch(() => {});
      await settle();

      // The in-flight teardown holds its remove lease; an operator force-remove of the
      // same app escalates it rather than starting a second teardown.
      operationRegistry.acquire('myapp', 'remove', 'the-teardown');
      const result = await appUninstaller.uninstallApplication('myapp', { forceKill: true, skipGuard: true, operatorForce: true });
      operationRegistry.clear();

      expect(fluxShutdowndClientStub.forceAppStop.calledWith('1own', 'myapp'), 'escalated the drain via the daemon').to.equal(true);
      expect(result.status).to.equal(appUninstaller.UninstallStatus.REMOVED);

      releaseStop({ outcome: 'forced' });
      await draining;
    });
  });

  describe('clearSpawnThrottleForPinnedReinstall (throttle clear on operator removal)', () => {
    const pinnedSpec = (matches = true, hasTargets = true) => ({
      hash: 'pinhash',
      placement: {
        hasTargets: () => hasTargets,
        matchesTarget: () => matches,
        isPinnedTo(nodeInfo) { return this.hasTargets() && this.matchesTarget(nodeInfo); },
      },
    });

    it('clears the throttle for a foreground non-force removal of an app pinned to this node', async () => {
      appsRepositoryStub.getGlobalAppInfo.resolves(pinnedSpec());
      globalStateStub.trySpawningGlobalAppCache = new Map([['pinhash', '']]);

      await appUninstaller.clearSpawnThrottleForPinnedReinstall('pinApp', { forceKill: false, background: false });

      expect(globalStateStub.trySpawningGlobalAppCache.has('pinhash')).to.equal(false);
    });

    it('does NOT clear (and does not even look up) for a force removal', async () => {
      appsRepositoryStub.getGlobalAppInfo.resolves(pinnedSpec());
      globalStateStub.trySpawningGlobalAppCache = new Map([['pinhash', '']]);

      await appUninstaller.clearSpawnThrottleForPinnedReinstall('pinApp', { forceKill: true, background: false });

      expect(globalStateStub.trySpawningGlobalAppCache.has('pinhash')).to.equal(true);
      expect(appsRepositoryStub.getGlobalAppInfo.called).to.equal(false);
    });

    it('does NOT clear (and does not even look up) for a background removal (expiry/cancel)', async () => {
      appsRepositoryStub.getGlobalAppInfo.resolves(pinnedSpec());
      globalStateStub.trySpawningGlobalAppCache = new Map([['pinhash', '']]);

      await appUninstaller.clearSpawnThrottleForPinnedReinstall('pinApp', { forceKill: false, background: true });

      expect(globalStateStub.trySpawningGlobalAppCache.has('pinhash')).to.equal(true);
      expect(appsRepositoryStub.getGlobalAppInfo.called).to.equal(false);
    });

    it('does NOT clear when the app is not pinned to this node', async () => {
      appsRepositoryStub.getGlobalAppInfo.resolves(pinnedSpec(false)); // matchesTarget -> false
      globalStateStub.trySpawningGlobalAppCache = new Map([['pinhash', '']]);

      await appUninstaller.clearSpawnThrottleForPinnedReinstall('pinApp', { forceKill: false, background: false });

      expect(globalStateStub.trySpawningGlobalAppCache.has('pinhash')).to.equal(true);
    });

    it('does NOT clear for an unpinned app (no placement targets)', async () => {
      appsRepositoryStub.getGlobalAppInfo.resolves(pinnedSpec(true, false)); // hasTargets -> false
      globalStateStub.trySpawningGlobalAppCache = new Map([['pinhash', '']]);

      await appUninstaller.clearSpawnThrottleForPinnedReinstall('pinApp', { forceKill: false, background: false });

      expect(globalStateStub.trySpawningGlobalAppCache.has('pinhash')).to.equal(true);
    });

    it('is a no-op when the app is no longer globally registered', async () => {
      appsRepositoryStub.getGlobalAppInfo.resolves(null);
      globalStateStub.trySpawningGlobalAppCache = new Map([['pinhash', '']]);

      await appUninstaller.clearSpawnThrottleForPinnedReinstall('gone', { forceKill: false, background: false });

      expect(globalStateStub.trySpawningGlobalAppCache.has('pinhash')).to.equal(true);
    });
  });

  describe('collector lifecycle: reverse cascade + orphan sweep', () => {
    const spec = (name) => ({ name, owner: '1own' });

    function warnLogged(substr) {
      return logStub.warn.getCalls().some((c) => typeof c.args[0] === 'string' && c.args[0].includes(substr));
    }
    function infoLogged(substr) {
      return logStub.info.getCalls().some((c) => typeof c.args[0] === 'string' && c.args[0].includes(substr));
    }
    const tick = () => new Promise((resolve) => { setImmediate(() => setImmediate(resolve)); });

    afterEach(() => {
      operationRegistry.clear();
    });

    it('graceful removal of a follower uninstalls its requiring workload FIRST (teardown record order proves it)', async () => {
      configStub.fluxapps.manageCollectorLifecycle = true;
      appsRepositoryStub.getInstalledApp.callsFake(async (name) => spec(name));
      appNetworkLinkerStub.isPureFollowerApp.callsFake(async (s) => s.name === 'collector');
      appNetworkLinkerStub.findInstalledWorkloadsRequiring.resolves([spec('workload')]);

      await appUninstaller.uninstallApplication('collector', { forceKill: false, background: true });

      expect(infoLogged('Reverse dependency cascade: uninstalling workload workload'), 'cascade announced').to.equal(true);
      expect(warnLogged('APP REMOVAL TRIGGERED: workload'), 'nested workload removal ran').to.equal(true);
      // The workload's teardown record must be written before the collector's own.
      const keys = pendingTeardownStoreStub.writeTeardown.getCalls().map((c) => c.args[0].key);
      expect(keys.indexOf('workload'), 'workload record exists').to.be.at.least(0);
      expect(keys.indexOf('workload')).to.be.lessThan(keys.indexOf('collector'));
    });

    it('defers the follower teardown when a requiring workload is mid-operation (DEFERRED)', async () => {
      configStub.fluxapps.manageCollectorLifecycle = true;
      appsRepositoryStub.getInstalledApp.callsFake(async (name) => spec(name));
      appNetworkLinkerStub.isPureFollowerApp.callsFake(async (s) => s.name === 'collector');
      appNetworkLinkerStub.findInstalledWorkloadsRequiring.resolves([spec('workload')]);
      // the requiring workload holds a redeploy lease, so its removal DEFERS
      operationRegistry.acquire('workload', 'redeploy', 'the-redeploy');
      try {
        const result = await appUninstaller.uninstallApplication('collector', { forceKill: false, background: true });
        expect(result.status, 'the follower teardown must defer while its consumer is mid-operation').to.equal(appUninstaller.UninstallStatus.DEFERRED);
        const keys = pendingTeardownStoreStub.writeTeardown.getCalls().map((c) => c.args[0].key);
        expect(keys.indexOf('collector'), 'the follower must NOT have started tearing down').to.equal(-1);
      } finally {
        operationRegistry.clear();
      }
    });

    it('a force-kill of a follower does NOT cascade', async () => {
      configStub.fluxapps.manageCollectorLifecycle = true;
      appsRepositoryStub.getInstalledApp.callsFake(async (name) => spec(name));
      appNetworkLinkerStub.isPureFollowerApp.resolves(true);

      await appUninstaller.uninstallApplication('collector', { forceKill: true, background: true });

      expect(appNetworkLinkerStub.findInstalledWorkloadsRequiring.called).to.equal(false);
    });

    it('does not cascade with the lifecycle toggle off (default)', async () => {
      appsRepositoryStub.getInstalledApp.callsFake(async (name) => spec(name));
      appNetworkLinkerStub.isPureFollowerApp.resolves(true);

      await appUninstaller.uninstallApplication('collector', { forceKill: false, background: true });

      expect(appNetworkLinkerStub.findInstalledWorkloadsRequiring.called).to.equal(false);
    });

    it('a graceful workload removal triggers the deferred orphan sweep', async () => {
      configStub.fluxapps.manageCollectorLifecycle = true;
      appsRepositoryStub.getInstalledApp.callsFake(async (name) => spec(name));
      appNetworkLinkerStub.isPureFollowerApp.resolves(false);

      const result = await appUninstaller.uninstallApplication('workload', { forceKill: false, background: true });
      expect(result.status).to.equal(appUninstaller.UninstallStatus.REMOVED);
      await tick();

      expect(appNetworkLinkerStub.findUnrequiredInstalledDependencies.called, 'sweep ran after the removal settled').to.equal(true);
    });

    it('a force-kill of a follower does NOT trigger the sweep', async () => {
      configStub.fluxapps.manageCollectorLifecycle = true;
      appsRepositoryStub.getInstalledApp.callsFake(async (name) => spec(name));
      appNetworkLinkerStub.isPureFollowerApp.resolves(true);

      await appUninstaller.uninstallApplication('collector', { forceKill: true, skipGuard: true, background: true });
      await tick();

      expect(appNetworkLinkerStub.findUnrequiredInstalledDependencies.called).to.equal(false);
    });

    it('removeUnrequiredDependencies unwinds a chain until no orphans remain, consumer-first', async () => {
      const datadog = spec('datadog');
      const alloy = spec('alloy');
      // The linker returns orphans already ordered consumer-first — it holds the
      // resolved views the ordering depends on. This exercises the unwind loop;
      // the ordering itself is covered in the linker's own suite.
      appNetworkLinkerStub.findUnrequiredInstalledDependencies.onCall(0).resolves([datadog, alloy]);
      appNetworkLinkerStub.findUnrequiredInstalledDependencies.onCall(1).resolves([alloy]);
      appNetworkLinkerStub.findUnrequiredInstalledDependencies.onCall(2).resolves([]);

      await appUninstaller.removeUnrequiredDependencies();

      const removals = logStub.info.getCalls()
        .map((c) => c.args[0])
        .filter((m) => typeof m === 'string' && m.startsWith('Dependency cleanup: removing'));
      expect(removals[0]).to.include('datadog');
      expect(removals[1]).to.include('alloy');
    });

    it('re-runs the sweep when a trigger arrives mid-pass (dirty flag), never dropping it', async () => {
      let releaseFind;
      appNetworkLinkerStub.findUnrequiredInstalledDependencies.returns(new Promise((resolve) => { releaseFind = resolve; }));

      const first = appUninstaller.removeUnrequiredDependencies();
      const second = appUninstaller.removeUnrequiredDependencies();
      await second; // the concurrent trigger returns immediately, marking the running sweep dirty
      expect(appNetworkLinkerStub.findUnrequiredInstalledDependencies.callCount).to.equal(1);

      releaseFind([]); // first pass finds nothing to remove...
      await first;
      // ...but the dirty flag forces one more pass instead of dropping the concurrent trigger.
      expect(appNetworkLinkerStub.findUnrequiredInstalledDependencies.callCount).to.equal(2);
    });
  });

});
