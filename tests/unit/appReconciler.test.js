const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
// The real registry singleton — the reconciler's hasOperationLease reads it, and
// proxyquire (un-stubbed dep) gives the reconciler this same instance.
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');

// Mirrors appUninstaller.UninstallStatus (proxyquire.noCallThru stubs the real module out).
const UninstallStatus = Object.freeze({
  REMOVED: 'removed',
  SKIPPED: 'skipped',
  DEFERRED: 'deferred',
  FAILED: 'failed',
});

describe('appReconciler tests', () => {
  let appReconciler;
  let stubs;
  let localSpec; // the app spec getLocalComponentSpec will resolve

  const fakeDeployment = (spec) => {
    const entries = (spec.version >= 4 && Array.isArray(spec.compose))
      ? spec.compose
      : [{ name: spec.name, containerData: spec.containerData }];
    const comps = entries.map((c) => {
      const primary = (c.containerData || '').split('|')[0];
      const isG = primary.startsWith('g:');
      const isR = primary.startsWith('r:');
      const isSync = isG || isR || primary.startsWith('s:');
      return {
        name: c.name,
        appName: spec.name,
        identifier: (spec.version >= 4) ? `${c.name}_${spec.name}` : spec.name,
        hasActiveStandbySyncthing: () => isG,
        requiresSyncBeforeStart: () => isR,
        hasSyncthing: () => isSync,
        restartPolicy: c.restartPolicy ?? 'always',
        hasDependencies: () => !!c.dependsOn && Object.keys(c.dependsOn).length > 0,
        dependencyEntries: () => (c.dependsOn ? Object.entries(c.dependsOn).map(([n, v]) => [n, v.condition]) : []),
      };
    });
    return {
      appName: spec.name,
      linkedApps: spec.linkedApps || [],
      getComponent: (n) => comps.find((c) => c.name === n) || null,
      componentForIdentifier: (id) => comps.find((c) => c.identifier === id) || null,
      componentEntries: () => comps.map((c) => [c.name, c]),
      dependentsOf: (name) => comps.filter((c) => c.dependencyEntries().some(([dn]) => dn === name)).map((c) => c.name),
    };
  };

  beforeEach(() => {
    localSpec = {
      name: 'App', version: 4, compose: [{ name: 'www', containerData: '/data' }],
    };

    stubs = {
      log: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
      appsRepository: {
        getInstalledApp: sinon.stub().callsFake(async () => (localSpec
          ? { name: localSpec.name, owner: localSpec.owner ?? 'owner1', isEncrypted: Boolean(localSpec.enterprise) }
          : null)),
      },
      // mirrors the deployment view the reconciler reads: primary-mount g: =>
      // activeStandby, r:/s: => replicated sync (full parsing lives in flux-spec)
      deploymentProvider: {
        buildDeployment: sinon.stub().callsFake(async () => fakeDeployment(localSpec)),
      },
      appVolumeService: { ensureMountSourcesExist: sinon.stub().resolves() },
      dockerService: {
        dockerContainerInspect: sinon.stub().resolves({ State: { Running: false, Status: 'exited', ExitCode: 1 } }),
        // reachability probe used by dockerActual on an inspect failure; resolves => docker up
        dockerListContainers: sinon.stub().resolves([]),
        // final existence re-check before the remove-on-recreate-failure fallback
        getDockerContainerOnly: sinon.stub().resolves(undefined),
        appDockerStart: sinon.stub().resolves(),
        appDockerStop: sinon.stub().resolves(),
        appDockerRestart: sinon.stub().resolves(),
        appDockerKill: sinon.stub().resolves(),
        getAppIdentifier: (id) => `flux${id}`,
        getAppDockerNameIdentifier: (id) => `/flux${id}`,
        getBaseAppName: (id) => (id.startsWith('flux') ? id.slice(4) : id),
      },
      globalState: {
        appsMonitored: {},
        bootContainerStateSettled: true,
        waitForBootContainerStateSettled: () => Promise.resolve(),
        getAppLbState: sinon.stub().returns(null),
      },
      appInspector: { startAppMonitoring: sinon.stub(), stopAppMonitoring: sinon.stub() },
      appsRuntimeState: {
        isOperatorStopped: sinon.stub().resolves(false),
        isCondemned: sinon.stub().resolves(false),
        restartWaitMs: sinon.stub().resolves(0),
        recordRestart: sinon.stub().resolves(),
        recordExit: sinon.stub().resolves(),
        getState: sinon.stub().resolves(null),
        setSuccessfullyStarted: sinon.stub().resolves(),
        recordRestartGeneration: sinon.stub().resolves(),
      },
      appQueryService: {
        installedApps: sinon.stub().resolves({ status: 'success', data: [] }),
      },
      containerHealthMonitor: { recreateMissingContainers: sinon.stub().resolves() },
      appNetworkLinker: {
        ensureContainerNetworkMembership: sinon.stub().resolves({ connected: [], disconnected: [], failed: [] }),
        // Default: every declared link resolves to an installed same-owner network.
        // A membership test that drops a link overrides this for a specific name.
        resolveActiveLinkedNetworks: sinon.stub().callsFake(async (owner, names) => (names || []).map((n) => `fluxDockerNetwork_${n}`)),
      },
      appUninstaller: { UninstallStatus, uninstallApplication: sinon.stub().resolves({ status: UninstallStatus.REMOVED, reason: null }) },
      appTamperingDetectionService: { recordEvent: sinon.stub().resolves(), isNetworkMissingError: () => false },
      dockerOperations: { appDeleteDataInMountPoint: sinon.stub().resolves() },
      serviceHelper: { delay: sinon.stub().resolves() },
      telemetrySinkCache: { setSink: sinon.stub(), extractSink: sinon.stub().returns(null) },
    };

    // the lightweight scheduling seam the engine drives; proxyquired with the same
    // low-level stubs so the queue + engine integrate exactly as in production
    const reconcilerQueue = proxyquire('../../ZelBack/src/services/appMonitoring/reconcilerQueue', {
      '../../lib/log': stubs.log,
      '../utils/globalState': stubs.globalState,
      '../dockerService': stubs.dockerService,
    });

    appReconciler = proxyquire('../../ZelBack/src/services/appMonitoring/appReconciler', {
      './reconcilerQueue': reconcilerQueue,
      '../../lib/log': stubs.log,
      '../dockerService': stubs.dockerService,
      '../utils/globalState': stubs.globalState,
      '../appManagement/appInspector': stubs.appInspector,
      '../appDatabase/appsRepository': stubs.appsRepository,
      '../appRuntime/deploymentProvider': stubs.deploymentProvider,
      '../appLifecycle/appVolumeService': stubs.appVolumeService,
      '../appManagement/appsRuntimeState': stubs.appsRuntimeState,
      '../appQuery/appQueryService': stubs.appQueryService,
      './containerHealthMonitor': stubs.containerHealthMonitor,
      '../appLifecycle/appNetworkLinker': stubs.appNetworkLinker,
      '../appLifecycle/appUninstaller': stubs.appUninstaller,
      '../appTamperingDetectionService': stubs.appTamperingDetectionService,
      '../appManagement/dockerOperations': stubs.dockerOperations,
      '../serviceHelper': stubs.serviceHelper,
      '../telemetrySinkCache': stubs.telemetrySinkCache,
      '../utils/appConstants': { localAppsInformation: 'zelappsinformation' },
      '../utils/componentIdentifier': {
        appNameFromIdentifier: (id) => { const i = id.lastIndexOf('_'); return i === -1 ? id : id.slice(i + 1); },
        componentNameFromIdentifier: (id) => { const i = id.lastIndexOf('_'); return i === -1 ? id : id.slice(0, i); },
      },
      '../utils/specLibs': { getSpecBackend: sinon.stub().resolves() },
    });
  });

  afterEach(() => { appReconciler.stop(); operationRegistry.clear(); sinon.restore(); });

  // resolves exactly when its .resolve() is called — lets tests await the real
  // completion signal of an async reconcile instead of guessing with timer ticks
  const deferred = () => {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
  };

  describe('network-membership convergence', () => {
    it('steady state: converges a running container onto its own + linked networks', async () => {
      localSpec = {
        name: 'App', version: 4, owner: 'owner1', compose: [{ name: 'www', containerData: '/data' }], linkedApps: ['collector'],
      };
      stubs.dockerService.dockerContainerInspect.resolves({
        State: { Running: true, Status: 'running' },
        NetworkSettings: { Networks: { fluxDockerNetwork_App: {} } },
      });

      await appReconciler.reconcile('www_App');

      // Desired-set validation runs with the CONSUMER's own owner threaded through.
      sinon.assert.calledWith(stubs.appNetworkLinker.resolveActiveLinkedNetworks, 'owner1', ['collector']);
      sinon.assert.calledOnceWithExactly(
        stubs.appNetworkLinker.ensureContainerNetworkMembership,
        'www_App',
        ['fluxDockerNetwork_App', 'fluxDockerNetwork_collector'],
        ['fluxDockerNetwork_App'],
      );
    });

    it('wires memberships BEFORE starting a created/stopped container', async () => {
      localSpec = {
        name: 'App', version: 4, compose: [{ name: 'www', containerData: '/data' }], linkedApps: ['collector'],
      };
      stubs.dockerService.dockerContainerInspect.resolves({
        State: { Running: false, Status: 'created' },
        NetworkSettings: { Networks: { fluxDockerNetwork_App: {} } },
      });

      await appReconciler.reconcile('www_App');

      sinon.assert.calledOnce(stubs.appNetworkLinker.ensureContainerNetworkMembership);
      sinon.assert.calledOnce(stubs.dockerService.appDockerStart);
      sinon.assert.callOrder(stubs.appNetworkLinker.ensureContainerNetworkMembership, stubs.dockerService.appDockerStart);
    });

    it('a failed membership change never blocks the start - it paces a retry instead', async () => {
      localSpec = {
        name: 'App', version: 4, compose: [{ name: 'www', containerData: '/data' }], linkedApps: ['collector'],
      };
      stubs.appNetworkLinker.ensureContainerNetworkMembership.resolves({ connected: [], disconnected: [], failed: ['fluxDockerNetwork_collector'] });
      stubs.dockerService.dockerContainerInspect.resolves({
        State: { Running: false, Status: 'created' },
        NetworkSettings: { Networks: { fluxDockerNetwork_App: {} } },
      });

      await appReconciler.reconcile('www_App');

      sinon.assert.calledOnce(stubs.dockerService.appDockerStart);
    });
  });

  describe('shutdown pipeline holds (LB drain state)', () => {
    it('takes no action on a stopped component while its app is stopping', async () => {
      stubs.globalState.getAppLbState.returns('stopping');
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
    });

    it('does not stop a still-running component while its app is draining', async () => {
      stubs.globalState.getAppLbState.returns('draining');
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
    });

    it('does not restart a running-but-unhealthy component while its app is draining', async () => {
      // the shutdown-pipeline hold (desired:null) must win over the livenessProbe actuator
      stubs.globalState.getAppLbState.returns('draining');
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0, Health: { Status: 'unhealthy' } } });
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerRestart.called).to.be.false;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
    });

    it('restarts the stopped component on the first reconcile after the state clears', async () => {
      stubs.globalState.getAppLbState.returns(null);
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerStart.calledWith('www_App')).to.be.true;
    });
  });

  describe('policyAllowsRun', () => {
    it('always restarts under the default policy regardless of exit code', () => {
      expect(appReconciler.policyAllowsRun('always', 0)).to.be.true;
      expect(appReconciler.policyAllowsRun('always', 1)).to.be.true;
    });
    it('onFailure restarts only on non-zero exit', () => {
      expect(appReconciler.policyAllowsRun('onFailure', 0)).to.be.false;
      expect(appReconciler.policyAllowsRun('onFailure', 1)).to.be.true;
      expect(appReconciler.policyAllowsRun('onFailure', null)).to.be.true; // never ran -> initial start
    });
    it('never only allows an initial start, never a restart after an exit', () => {
      expect(appReconciler.policyAllowsRun('never', null)).to.be.true;
      expect(appReconciler.policyAllowsRun('never', 0)).to.be.false;
      expect(appReconciler.policyAllowsRun('never', 5)).to.be.false;
    });
    it('reads the per-component spec field', () => {
      expect(appReconciler.getRestartPolicy({ comp: { restartPolicy: 'onFailure' } })).to.equal('onFailure');
    });

    it('does not restart a completed run-once component (onFailure, exit 0)', async () => {
      localSpec = { name: 'App', version: 9, compose: [{ name: 'init', containerData: '/data', restartPolicy: 'onFailure' }] };
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: false, Status: 'exited', ExitCode: 0 } });
      await appReconciler.reconcile('init_App');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('restarts a failed onFailure component (non-zero exit)', async () => {
      localSpec = { name: 'App', version: 9, compose: [{ name: 'init', containerData: '/data', restartPolicy: 'onFailure' }] };
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: false, Status: 'exited', ExitCode: 1 } });
      await appReconciler.reconcile('init_App');
      expect(stubs.dockerService.appDockerStart.calledOnceWith('init_App')).to.be.true;
    });

    it('never restarts a never-policy component after it has run', async () => {
      localSpec = { name: 'App', version: 9, compose: [{ name: 'job', containerData: '/data', restartPolicy: 'never' }] };
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: false, Status: 'exited', ExitCode: 137 } });
      await appReconciler.reconcile('job_App');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });
  });

  describe('livenessProbe actuator (restart running-but-unhealthy)', () => {
    const runningUnhealthy = { State: { Running: true, Status: 'running', ExitCode: 0, Health: { Status: 'unhealthy' } } };

    it('restarts a running container whose healthcheck reports unhealthy', async () => {
      stubs.dockerService.dockerContainerInspect.resolves(runningUnhealthy);
      await appReconciler.reconcile('www_App');
      expect(stubs.appsRuntimeState.recordRestart.calledOnceWith('www_App')).to.be.true;
      expect(stubs.dockerService.appDockerRestart.calledOnceWith('www_App')).to.be.true;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
    });

    it('paces the unhealthy restart off the running-now ladder, not the death-based one', async () => {
      stubs.dockerService.dockerContainerInspect.resolves(runningUnhealthy);
      await appReconciler.reconcile('www_App');
      const [id, opts] = stubs.appsRuntimeState.restartWaitMs.firstCall.args;
      expect(id).to.equal('www_App');
      expect(opts).to.deep.equal({ runningNow: true });
    });

    it('backs off instead of restarting an unhealthy container during its cooldown', async () => {
      stubs.dockerService.dockerContainerInspect.resolves(runningUnhealthy);
      stubs.appsRuntimeState.restartWaitMs.resolves(30000);
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerRestart.called).to.be.false;
      expect(stubs.appsRuntimeState.recordRestart.called).to.be.false;
    });

    it('leaves a running healthy container alone', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0, Health: { Status: 'healthy' } } });
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerRestart.called).to.be.false;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
    });

    it('leaves a running container in the starting grace period alone', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0, Health: { Status: 'starting' } } });
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerRestart.called).to.be.false;
    });

    it('leaves a running container with no healthcheck alone', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerRestart.called).to.be.false;
    });

    it('retries with the managed delay when the unhealthy restart throws', async () => {
      stubs.dockerService.dockerContainerInspect.resolves(runningUnhealthy);
      stubs.dockerService.appDockerRestart.rejects(new Error('docker busy'));
      await appReconciler.reconcile('www_App'); // must not throw
      const loggedFailure = stubs.log.error.getCalls().some((c) => /failed to restart unhealthy/.test(c.args[0]));
      expect(loggedFailure).to.be.true;
    });
  });

  describe('dependsOn condition gating', () => {
    const flush = async () => {
      for (let i = 0; i < 6; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setImmediate(resolve); });
      }
    };

    // web depends on db; db's container state is driven per-identifier via withArgs.
    const twoComp = (condition) => ({
      name: 'App',
      version: 9,
      compose: [
        { name: 'db', containerData: '/data', restartPolicy: condition === 'completed' ? 'never' : 'always' },
        { name: 'web', containerData: '/data', dependsOn: { db: { condition } } },
      ],
    });
    // a fresh (never-started) dependent the reconciler would start once unblocked
    const webCreated = { State: { Running: false, Status: 'created', ExitCode: 0 } };

    it('holds a started-dependent while its target is not running', async () => {
      localSpec = twoComp('started');
      stubs.dockerService.dockerContainerInspect.withArgs('web_App').resolves(webCreated);
      stubs.dockerService.dockerContainerInspect.withArgs('db_App').resolves({ State: { Running: false, Status: 'exited', ExitCode: 0 } });
      await appReconciler.reconcile('web_App');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('starts a started-dependent once its target is running', async () => {
      localSpec = twoComp('started');
      stubs.dockerService.dockerContainerInspect.withArgs('web_App').resolves(webCreated);
      stubs.dockerService.dockerContainerInspect.withArgs('db_App').resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('web_App');
      expect(stubs.dockerService.appDockerStart.calledWith('web_App')).to.be.true;
    });

    it('holds a healthy-dependent while its target is only starting, starts it once healthy', async () => {
      localSpec = twoComp('healthy');
      stubs.dockerService.dockerContainerInspect.withArgs('web_App').resolves(webCreated);
      stubs.dockerService.dockerContainerInspect.withArgs('db_App').resolves({ State: { Running: true, Status: 'running', ExitCode: 0, Health: { Status: 'starting' } } });
      await appReconciler.reconcile('web_App');
      expect(stubs.dockerService.appDockerStart.called, 'held while dep only starting').to.be.false;

      stubs.dockerService.dockerContainerInspect.withArgs('db_App').resolves({ State: { Running: true, Status: 'running', ExitCode: 0, Health: { Status: 'healthy' } } });
      await appReconciler.reconcile('web_App');
      expect(stubs.dockerService.appDockerStart.calledWith('web_App'), 'starts once dep healthy').to.be.true;
    });

    it('holds a completed-dependent until its run-once target exits 0', async () => {
      localSpec = twoComp('completed');
      stubs.dockerService.dockerContainerInspect.withArgs('web_App').resolves(webCreated);
      stubs.dockerService.dockerContainerInspect.withArgs('db_App').resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('web_App');
      expect(stubs.dockerService.appDockerStart.called, 'held while target still running').to.be.false;

      stubs.dockerService.dockerContainerInspect.withArgs('db_App').resolves({ State: { Running: false, Status: 'exited', ExitCode: 0 } });
      await appReconciler.reconcile('web_App');
      expect(stubs.dockerService.appDockerStart.calledWith('web_App'), 'starts once target exits 0').to.be.true;
    });

    it('treats a completed dependency as satisfied even after its container is removed (durable exit)', async () => {
      localSpec = twoComp('completed');
      stubs.dockerService.dockerContainerInspect.withArgs('web_App').resolves(webCreated);
      // db_App vanished: inspect throws, docker's list (default []) confirms it's gone
      stubs.dockerService.dockerContainerInspect.withArgs('db_App').rejects(new Error('no such container'));
      stubs.appsRuntimeState.getState.withArgs('db_App').resolves({ lastExitCode: 0 });
      await appReconciler.reconcile('web_App');
      expect(stubs.dockerService.appDockerStart.calledWith('web_App')).to.be.true;
    });

    it('does not re-run a completed run-once component whose container has vanished (durable exit)', async () => {
      localSpec = { name: 'App', version: 9, compose: [{ name: 'job', containerData: '/data', restartPolicy: 'never' }] };
      stubs.dockerService.dockerContainerInspect.rejects(new Error('no such container'));
      stubs.dockerService.dockerListContainers.resolves([]); // docker confirms it's gone -> exists:false
      stubs.appsRuntimeState.getState.withArgs('job_App').resolves({ lastExitCode: 0 });
      await appReconciler.reconcile('job_App');
      expect(stubs.dockerService.appDockerStart.called, 'must not re-run a completed run-once container').to.be.false;
      expect(stubs.containerHealthMonitor.recreateMissingContainers.called).to.be.false;
    });

    it('enqueueDependents re-evaluates every dependent of a component', async () => {
      localSpec = {
        name: 'App',
        version: 9,
        compose: [
          { name: 'db', containerData: '/data' },
          { name: 'web', containerData: '/data', dependsOn: { db: { condition: 'started' } } },
          { name: 'cache', containerData: '/data', dependsOn: { db: { condition: 'started' } } },
        ],
      };
      stubs.dockerService.dockerContainerInspect.withArgs('db_App').resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      stubs.dockerService.dockerContainerInspect.withArgs('web_App').resolves(webCreated);
      stubs.dockerService.dockerContainerInspect.withArgs('cache_App').resolves(webCreated);
      const started = [];
      stubs.dockerService.appDockerStart.callsFake(async (id) => { started.push(id); });

      await appReconciler.enqueueDependents('db_App');
      await flush();
      expect(started).to.have.members(['web_App', 'cache_App']);
    });

    it('does not hold a plain component that has no dependsOn', async () => {
      localSpec = { name: 'App', version: 9, compose: [{ name: 'solo', containerData: '/data' }] };
      stubs.dockerService.dockerContainerInspect.resolves(webCreated);
      await appReconciler.reconcile('solo_App');
      expect(stubs.dockerService.appDockerStart.calledWith('solo_App')).to.be.true;
    });
  });

  describe('reconcile decisions', () => {
    it('does nothing when the app is not installed locally', async () => {
      localSpec = null;
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
    });

    it('fails loud on invalid containerData (sync flag on a non-primary mount): no start/stop, no throw', async () => {
      // '/data|g:/...' puts the sync flag on a non-primary mount -> unparseable per the
      // mount model (real prod shape: roundcube). The reconciler must not attempt a start
      // (volume construction would throw) and must surface it, not silently loop "not ready".
      localSpec = { name: 'App', version: 4, compose: [{ name: 'www', containerData: '/data|g:/var/roundcube/db' }] };
      stubs.deploymentProvider.buildDeployment.rejects(new Error('invalid containerData: sync flag on a non-primary mount'));
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
      const failedLoud = stubs.log.error.getCalls().some((c) => /invalid containerData/.test(c.args[0]));
      expect(failedLoud, 'should log the invalid-spec error (fail loud), not silently loop').to.equal(true);
    });

    it('defers (does not drop) the reconcile when the local spec read fails transiently', async () => {
      // a momentary DB read failure must not be mistaken for "not installed" - the
      // reconcile defers and retries rather than silently dropping the recovery
      stubs.appsRepository.getInstalledApp.rejects(new Error('connection reset'));
      await appReconciler.reconcile('www_App'); // must not throw
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
      const deferred = stubs.log.warn.getCalls().some((c) => /spec read failed, deferring/.test(c.args[0]));
      expect(deferred, 'should log the transient defer, not silently no-op as not-installed').to.equal(true);
    });

    it('stops a running container the operator has stopped', async () => {
      stubs.appsRuntimeState.isOperatorStopped.resolves(true);
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerStop.calledOnceWith('www_App')).to.be.true;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('leaves an operator-stopped container alone if already stopped', async () => {
      stubs.appsRuntimeState.isOperatorStopped.resolves(true);
      await appReconciler.reconcile('www_App'); // inspect default: stopped
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('gracefully stops a running condemned container and never starts it (tombstoning)', async () => {
      stubs.appsRuntimeState.isCondemned.resolves(true);
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerStop.calledOnceWith('www_App')).to.be.true;
      expect(stubs.dockerService.appDockerKill.called).to.be.false;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('leaves an already-stopped condemned container alone (no re-stop)', async () => {
      stubs.appsRuntimeState.isCondemned.resolves(true);
      await appReconciler.reconcile('www_App'); // inspect default: stopped
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('condemned wins over the operator lock and stays graceful (operatorStopForce must not leak to a condemn)', async () => {
      stubs.appsRuntimeState.isCondemned.resolves(true);
      stubs.appsRuntimeState.isOperatorStopped.resolves(true);
      // operator force is set, but the reason is 'condemned' so only condemnedForce applies
      stubs.appsRuntimeState.getState.resolves({ operatorStopForce: true });
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerStop.calledOnceWith('www_App')).to.be.true;
      expect(stubs.dockerService.appDockerKill.called).to.be.false;
    });

    it('force-kills a condemned-with-force container (operator hard-cancel)', async () => {
      stubs.appsRuntimeState.isCondemned.resolves(true);
      stubs.appsRuntimeState.getState.resolves({ condemnedForce: true });
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerKill.calledOnceWith('www_App')).to.be.true;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
    });

    it('skips the data-clear wipe for a condemned component (never races the teardown rm -rf)', async () => {
      stubs.appsRuntimeState.isCondemned.resolves(true);
      appReconciler.requestStopAndClearData('www_App', 'test'); // dataDesired = 'clear'
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerOperations.appDeleteDataInMountPoint.called).to.be.false;
      // still stopped (condemned desired:false), just not wiped (calledWith, not
      // calledOnce: requestStopAndClearData also enqueues a reconcile)
      expect(stubs.dockerService.appDockerStop.calledWith('www_App')).to.be.true;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('aborts the start when condemned lands mid-reconcile (actuation-time re-read)', async () => {
      // not condemned at the entry gate, but condemned by the time we re-read at actuation
      stubs.appsRuntimeState.isCondemned.onCall(0).resolves(false);
      stubs.appsRuntimeState.isCondemned.onCall(1).resolves(true);
      await appReconciler.reconcile('www_App'); // a stopped component that would otherwise start
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('starts a stopped plain component that should run (default always policy)', async () => {
      await appReconciler.reconcile('www_App');
      expect(stubs.appsRuntimeState.recordRestart.calledOnceWith('www_App')).to.be.true;
      expect(stubs.dockerService.appDockerStart.calledOnceWith('www_App')).to.be.true;
      expect(stubs.appInspector.startAppMonitoring.calledOnce).to.be.true;
    });

    it('marks hasSuccessfullyStarted on a first start (the durable signal that gates firstStart vs the install-window rollback)', async () => {
      // getState resolves null by default — never started here, so this is a first start.
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerStart.calledOnceWith('www_App')).to.be.true;
      expect(stubs.appsRuntimeState.setSuccessfullyStarted.calledOnceWith('www_App')).to.be.true;
    });

    it('does not re-mark hasSuccessfullyStarted when restarting a component that has run here before', async () => {
      stubs.appsRuntimeState.getState.withArgs('www_App').resolves({ hasSuccessfullyStarted: true });
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerStart.calledOnceWith('www_App')).to.be.true;
      expect(stubs.appsRuntimeState.setSuccessfullyStarted.called).to.be.false;
    });

    it('awaitConvergence resolves settled once a converging component reconciles to running', async () => {
      // awaitConvergence registers a waiter, enqueues, and blocks until the reconcile
      // settles the component (here: a stopped-should-run component starts).
      const result = await appReconciler.awaitConvergence(['www_App']);
      expect(stubs.dockerService.appDockerStart.calledWith('www_App')).to.be.true;
      expect(result.converged).to.be.true;
      expect(result.failed).to.deep.equal([]);
    });

    it('hard-kills (not graceful-stops) a running operator-stopped component when force is set', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      stubs.appsRuntimeState.isOperatorStopped.resolves(true);
      stubs.appsRuntimeState.getState.withArgs('www_App').resolves({ operatorStopForce: true });
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerKill.calledOnceWith('www_App')).to.be.true;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
    });

    it('gracefully stops a running operator-stopped component when force is not set', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      stubs.appsRuntimeState.isOperatorStopped.resolves(true);
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerStop.calledOnceWith('www_App')).to.be.true;
      expect(stubs.dockerService.appDockerKill.called).to.be.false;
    });

    it('bounces a running component when a restart is requested (desired generation > actuated)', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      stubs.appsRuntimeState.getState.withArgs('www_App').resolves({ restartGeneration: 1, actuatedRestartGeneration: 0 });
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerRestart.calledOnceWith('www_App')).to.be.true;
      expect(stubs.appsRuntimeState.recordRestartGeneration.calledOnceWith('www_App', 1)).to.be.true;
    });

    it('does not bounce a running component whose restart generation is already actuated', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      stubs.appsRuntimeState.getState.withArgs('www_App').resolves({ restartGeneration: 2, actuatedRestartGeneration: 2 });
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerRestart.called).to.be.false;
    });

    it('re-seeds the telemetry sink on every successful deployment build', async () => {
      // The boot-time sink rebuild races fluxbenchd's unseal; the reconcile
      // retry path is what converges sink state once decryption is available.
      const sink = { provider: 'datadog', apiKey: 'k' };
      stubs.telemetrySinkCache.extractSink.returns(sink);
      await appReconciler.reconcile('www_App');
      expect(stubs.telemetrySinkCache.setSink.calledWith('App', sink)).to.be.true;
    });

    it('ensures mount sources exist (recreating any syncthing-cleaned source) before starting', async () => {
      await appReconciler.reconcile('www_App');
      expect(stubs.appVolumeService.ensureMountSourcesExist.calledOnce).to.be.true;
      const [comp] = stubs.appVolumeService.ensureMountSourcesExist.firstCall.args;
      expect(comp.identifier).to.equal('www_App');
      // and the ensure must happen before the docker start, or the start could fail on a missing mount
      sinon.assert.callOrder(stubs.appVolumeService.ensureMountSourcesExist, stubs.dockerService.appDockerStart);
    });

    it('does not start (or record a restart) when ensuring mount paths fails', async () => {
      stubs.appVolumeService.ensureMountSourcesExist.rejects(new Error('mkdir failed'));
      let threw = false;
      try {
        await appReconciler.reconcile('www_App');
      } catch (err) {
        threw = true;
        expect(err.message).to.equal('mkdir failed');
      }
      expect(threw).to.be.true;
      expect(stubs.appsRuntimeState.recordRestart.called).to.be.false;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('does nothing when the container is already running', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('recreates a missing container that should run (docker reachable)', async () => {
      // production shape of a genuinely-missing container: getDockerContainerOnly
      // returns undefined -> docker.getContainer(undefined.Id) throws a TypeError.
      stubs.dockerService.dockerContainerInspect.rejects(new TypeError("Cannot read properties of undefined (reading 'Id')"));
      stubs.dockerService.dockerListContainers.resolves([]); // probe: docker is up
      await appReconciler.reconcile('www_App');
      expect(stubs.appTamperingDetectionService.recordEvent.calledWithMatch('App', 'container_vanished')).to.be.true;
      expect(stubs.containerHealthMonitor.recreateMissingContainers.calledOnceWith('www_App')).to.be.true;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('removes a NEVER-RAN app when recreation fails (fresh-install rollback)', async () => {
      stubs.dockerService.dockerContainerInspect.rejects(new TypeError("Cannot read properties of undefined (reading 'Id')"));
      stubs.dockerService.dockerListContainers.resolves([]); // probe: docker is up
      stubs.containerHealthMonitor.recreateMissingContainers.rejects(new Error('boom'));
      // getState defaults to null -> never ran here -> removable
      await appReconciler.reconcile('www_App');
      expect(stubs.appTamperingDetectionService.recordEvent.calledWithMatch('App', 'recreation_failed')).to.be.true;
      expect(stubs.appUninstaller.uninstallApplication.calledOnceWith('App', { broadcastRemoval: true })).to.be.true;
    });

    // §14.5: a component that has run here before must NEVER be destroyed on a
    // failed rebuild (unpullable image, bad update) — it degrades to down + retry,
    // so a broken update can't delete an established app + its data.
    it('keeps a HAS-RUN app down and retries instead of removing it when recreation fails', async () => {
      stubs.dockerService.dockerContainerInspect.rejects(new TypeError("Cannot read properties of undefined (reading 'Id')"));
      stubs.dockerService.dockerListContainers.resolves([]); // probe: docker is up
      stubs.containerHealthMonitor.recreateMissingContainers.rejects(new Error('image not found'));
      stubs.appsRuntimeState.getState.resolves({ hasSuccessfullyStarted: true });
      await appReconciler.reconcile('www_App');
      expect(stubs.appUninstaller.uninstallApplication.called, 'must NOT destroy an app that has run here').to.be.false;
      expect(stubs.appsRuntimeState.recordRestart.calledWith('www_App')).to.be.true;
    });

    it('retries the reconcile when the post-recreate-failure removal is deferred (busy)', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
      stubs.dockerService.dockerContainerInspect.rejects(new TypeError("Cannot read properties of undefined (reading 'Id')"));
      stubs.dockerService.dockerListContainers.resolves([]); // probe: docker is up
      stubs.containerHealthMonitor.recreateMissingContainers.rejects(new Error('boom'));
      // a deferred removal means the app is still there - the reconcile must retry, not assume it's gone
      stubs.appUninstaller.uninstallApplication.resolves({ status: UninstallStatus.DEFERRED, reason: 'busy' });

      await appReconciler.reconcile('www_App');
      expect(stubs.appUninstaller.uninstallApplication.callCount).to.equal(1);

      clock.tick(6000); // past MANAGED_RETRY_MS
      await new Promise((resolve) => { setImmediate(() => { setImmediate(resolve); }); });
      expect(stubs.appUninstaller.uninstallApplication.callCount).to.equal(2);
      clock.restore();
    });

    // "Vanished" requires docker to CONFIRM absence: the reachability probe
    // already fetched the full container list, and if the container appears in
    // it the inspect failure was transient (one-off timeout, dockerd finishing
    // a restart between the two calls). Acting on it would falsely write a
    // container_vanished tamper event and recreate->409->uninstall a healthy
    // app. Defer instead - the next inspect succeeds.
    it('defers when inspect fails but the container appears in the docker list (transient inspect failure)', async () => {
      stubs.dockerService.dockerContainerInspect.rejects(new TypeError("Cannot read properties of undefined (reading 'Id')"));
      stubs.dockerService.dockerListContainers.resolves([
        { Names: ['/fluxwww_App'], State: 'running' }, // the "missing" container, alive
        { Names: ['/fluxother_Other'], State: 'running' },
      ]);
      await appReconciler.reconcile('www_App');
      expect(stubs.containerHealthMonitor.recreateMissingContainers.called, 'must not recreate an existing container').to.be.false;
      expect(stubs.appTamperingDetectionService.recordEvent.called, 'must not write tamper events on a transient failure').to.be.false;
      expect(stubs.appUninstaller.uninstallApplication.called).to.be.false;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
      const deferred = stubs.log.warn.getCalls().some((c) => /deferring/.test(c.args[0]));
      expect(deferred, 'should defer loudly, not silently drop the reconcile').to.equal(true);
    });

    // Removal must be justified by the state of the world at REMOVAL time, not
    // at classification time: between them sits a whole recreate attempt (image
    // pull - seconds to minutes), during which a redeploy can legitimately
    // create the container (hasOperationLease is only sampled at entry), or
    // our own recreate can fail AFTER creating it (start/network step failed).
    it('does not remove the app when the container exists by the time recreation fails', async () => {
      stubs.dockerService.dockerContainerInspect.rejects(new TypeError("Cannot read properties of undefined (reading 'Id')"));
      stubs.dockerService.dockerListContainers.resolves([]); // genuinely missing at classification
      stubs.containerHealthMonitor.recreateMissingContainers.rejects(new Error('409 Conflict: name already in use'));
      stubs.dockerService.getDockerContainerOnly.resolves({ Id: 'abc123' }); // exists at re-check
      await appReconciler.reconcile('www_App');
      expect(stubs.appUninstaller.uninstallApplication.called, 'must not remove - the container exists').to.be.false;
      const recordedFailure = stubs.appTamperingDetectionService.recordEvent.getCalls()
        .some((c) => c.args[1] === 'recreation_failed');
      expect(recordedFailure, 'a moot recreate failure must not pollute the tamper ledger').to.be.false;
    });

    it('defers (never recreates/uninstalls) when docker is unreachable', async () => {
      // dockerd is down (e.g. restarting): inspect throws AND the reachability
      // probe throws too -> must defer, not mistake it for a vanished container.
      const connErr = new Error('connect ENOENT /var/run/docker.sock');
      connErr.code = 'ENOENT';
      stubs.dockerService.dockerContainerInspect.rejects(connErr);
      stubs.dockerService.dockerListContainers.rejects(connErr); // probe: docker is down
      await appReconciler.reconcile('www_App');
      expect(stubs.containerHealthMonitor.recreateMissingContainers.called).to.be.false;
      expect(stubs.appUninstaller.uninstallApplication.called).to.be.false;
      expect(stubs.appTamperingDetectionService.recordEvent.called).to.be.false;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('does NOT start a g: component until a controller elects it', async () => {
      localSpec = { name: 'App', version: 4, compose: [{ name: 'db', containerData: 'g:/data' }] };
      await appReconciler.reconcile('db_App'); // controllerDesired unset
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('starts a g: component once a controller sets it running', async () => {
      localSpec = { name: 'App', version: 4, compose: [{ name: 'db', containerData: 'g:/data' }] };
      // set desired without triggering the workqueue (boot gate closed -> enqueue held)
      stubs.globalState.bootContainerStateSettled = false;
      appReconciler.setControllerDesired('db_App', 'running', 'test');
      stubs.globalState.bootContainerStateSettled = true;
      await appReconciler.reconcile('db_App');
      expect(stubs.dockerService.appDockerStart.calledOnceWith('db_App')).to.be.true;
    });

    // The controller verdict is sampled at reconcile entry, but the syncthing
    // decider's stop wrapper runs OUTSIDE the reconciler's single-flight: it can
    // flip the verdict and begin a data wipe while this reconcile is awaiting
    // (mount-path recreation, DB reads). The verdict must therefore be re-read at
    // actuation time - starting onto a folder mid-wipe corrupts the fresh sync.
    it('aborts the start when the controller verdict flips to stopped mid-reconcile', async () => {
      localSpec = { name: 'App', version: 4, compose: [{ name: 'db', containerData: 'g:/data' }] };
      stubs.globalState.bootContainerStateSettled = false;
      appReconciler.setControllerDesired('db_App', 'running', 'test');
      stubs.globalState.bootContainerStateSettled = true;
      // decider stop+wipe lands during the mount-path await
      stubs.appVolumeService.ensureMountSourcesExist.callsFake(async () => {
        appReconciler.setControllerDesired('db_App', 'stopped', 'decider stop+wipe');
      });
      await appReconciler.reconcile('db_App');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('aborts the start when the controller verdict is cleared mid-reconcile (uninstall seam)', async () => {
      localSpec = { name: 'App', version: 4, compose: [{ name: 'db', containerData: 'g:/data' }] };
      stubs.globalState.bootContainerStateSettled = false;
      appReconciler.setControllerDesired('db_App', 'running', 'test');
      stubs.globalState.bootContainerStateSettled = true;
      stubs.appVolumeService.ensureMountSourcesExist.callsFake(async () => {
        appReconciler.clearControllerDesired('db_App');
      });
      await appReconciler.reconcile('db_App');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('does NOT act on a cleared controller verdict (removal seam wipes it)', async () => {
      // uninstall fires appUninstaller's component-removed seam -> serviceManager
      // wires it to clearControllerDesired: a reinstalled g: component must await a
      // fresh election rather than inherit the pre-uninstall verdict
      localSpec = { name: 'App', version: 4, compose: [{ name: 'db', containerData: 'g:/data' }] };
      stubs.globalState.bootContainerStateSettled = false;
      appReconciler.setControllerDesired('db_App', 'running', 'test');
      stubs.globalState.bootContainerStateSettled = true;
      appReconciler.clearControllerDesired('db_App');
      await appReconciler.reconcile('db_App');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
    });

    // the actuation half of the masterSlave standby path: the decider sets a running
    // g: component desired-stopped, the reconciler is what actually stops Docker.
    it('stops a running g: component a controller has set stopped (masterSlave standby)', async () => {
      localSpec = { name: 'App', version: 4, compose: [{ name: 'db', containerData: 'g:/data' }] };
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      stubs.globalState.bootContainerStateSettled = false;
      appReconciler.setControllerDesired('db_App', 'stopped', 'masterSlave standby');
      stubs.globalState.bootContainerStateSettled = true;
      await appReconciler.reconcile('db_App');
      expect(stubs.dockerService.appDockerStop.calledOnceWith('db_App')).to.be.true;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    // controllerDesired is in-memory, so a FluxOS restart wipes it while the
    // container keeps running (Docker is independent of the FluxOS process). With
    // no controller opinion yet the reconciler must leave a running g:/r: container
    // alone - stopping it here would bounce every running syncthing app on every
    // FluxOS restart. The decider re-derives intent within its next cycle.
    it('leaves a running g: component alone when no controller has spoken yet', async () => {
      localSpec = { name: 'App', version: 4, compose: [{ name: 'db', containerData: 'g:/data' }] };
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('db_App'); // controllerDesired unset
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('leaves a running r: component alone when no controller has spoken yet (FluxOS-restart case)', async () => {
      localSpec = { name: 'App', version: 4, compose: [{ name: 'web', containerData: 'r:/data' }] };
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('web_App'); // controllerDesired unset
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    // Plain sync replicates data but no decider owns its run-state: a stopped
    // s: component must restart like any normal component, with no controller
    // opinion required - holding it would leave a crashed one down forever.
    it('starts a stopped s: component without any controller opinion', async () => {
      localSpec = { name: 'App', version: 4, compose: [{ name: 'cache', containerData: 's:/data' }] };
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: false, Status: 'exited', ExitCode: 137 } });
      await appReconciler.reconcile('cache_App'); // controllerDesired unset
      expect(stubs.dockerService.appDockerStart.calledOnceWith('cache_App')).to.be.true;
    });

    it('leaves a running s: component running (no controller involvement either way)', async () => {
      localSpec = { name: 'App', version: 4, compose: [{ name: 'cache', containerData: 's:/data' }] };
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('cache_App');
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    // the syncthing decider wires its callbacks to the flux-prefixed docker name,
    // while masterSlave/die-events use the bare identifier. The reconciler must
    // canonicalise at its boundary so both forms key the same component: a desired
    // state written under the prefixed id is honoured by a reconcile of the bare id.
    it('canonicalises a flux-prefixed controller id to the bare component', async () => {
      localSpec = { name: 'App', version: 4, compose: [{ name: 'db', containerData: 'g:/data' }] };
      stubs.globalState.bootContainerStateSettled = false;
      appReconciler.setControllerDesired('fluxdb_App', 'running', 'syncthing synced');
      stubs.globalState.bootContainerStateSettled = true;
      await appReconciler.reconcile('db_App');
      expect(stubs.dockerService.appDockerStart.calledOnceWith('db_App')).to.be.true;
    });

    it('defers while an app-scoped operation holds the parent app lease', async () => {
      // any app-scoped lease on the parent app (here: install) owns the whole app's
      // runtime - a reconcile of any component must not actuate. Per-app, not node-wide.
      operationRegistry.acquire('App', 'install', 'test');
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
    });

    it('does NOT defer when the lease is on a DIFFERENT app (no node-wide freeze)', async () => {
      operationRegistry.acquire('OtherApp', 'install', 'test');
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerStart.calledOnceWith('www_App')).to.be.true;
    });

    // The backup/restore lease: while the parent app holds a backup/restore lease
    // (keyed on the bare MAIN APP name, exactly as appendBackupTask /
    // appendRestoreTask acquire it), the operation owns the whole app's runtime.
    // A reconcile of ANY component of that app must not actuate - not start,
    // not stop, not recreate - while the lease is held; the next reconcile
    // after release enforces desired state again.
    describe('operation leases', () => {
      // Container-construction operations build or destroy containers, so the
      // reconciler stands down while one runs to avoid racing construction.
      ['install', 'remove', 'softRedeploy', 'hardRedeploy', 'reconcile'].forEach((type) => {
        it(`defers while a ${type} lease is held on the app`, async () => {
          operationRegistry.acquire('App', type, 'test');
          await appReconciler.reconcile('www_App');
          expect(stubs.dockerService.appDockerStart.called).to.be.false;
          expect(stubs.appsRuntimeState.recordRestart.called).to.be.false;
        });
      });

      // backup/restore do NOT freeze the reconciler — they hold run-state through
      // the transient operationDesired (drive()), so the reconciler keeps actuating.
      // The lease alone must never strand a component.
      ['backup', 'restore'].forEach((type) => {
        it(`keeps actuating while a ${type} lease is held (run-state is held via drive, not the lease)`, async () => {
          operationRegistry.acquire('App', type, 'test');
          await appReconciler.reconcile('www_App'); // stopped, should-run, no operation hold
          expect(stubs.dockerService.appDockerStart.calledOnceWith('www_App')).to.be.true;
        });
      });

      // The real backup/restore protection: once it has DRIVEN the component to a
      // hold, the reconciler keeps it stopped and never recreates a missing
      // container (the desired-false short-circuit runs before the recreate path),
      // so it cannot race the volume work.
      it('holds a driven component stopped and does not recreate it when missing during a backup', async () => {
        operationRegistry.acquire('App', 'backup', 'test');
        stubs.dockerService.dockerContainerInspect.rejects(new TypeError("Cannot read properties of undefined (reading 'Id')"));
        stubs.dockerService.dockerListContainers.resolves([]); // probe: docker is up, container vanished
        await appReconciler.drive(['www_App'], 'stopped');
        expect(stubs.dockerService.appDockerStart.called).to.be.false;
        expect(stubs.containerHealthMonitor.recreateMissingContainers.called).to.be.false;
        expect(stubs.appUninstaller.uninstallApplication.called).to.be.false;
      });

      it('enforces desired state again once a construction lease is released', async () => {
        operationRegistry.acquire('App', 'install', 'test');
        await appReconciler.reconcile('www_App');
        expect(stubs.dockerService.appDockerStart.called).to.be.false; // held

        operationRegistry.release('App'); // lease released
        await appReconciler.reconcile('www_App');
        expect(stubs.dockerService.appDockerStart.calledOnceWith('www_App')).to.be.true;
      });
    });

    it('defers while the component holds a stopping lease (transient stop)', async () => {
      operationRegistry.acquire('fluxwww_App', 'stopping', 'test'); // prefixed docker name, as dockerService acquires it
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('backs off instead of restarting when a wait is pending', async () => {
      stubs.appsRuntimeState.restartWaitMs.resolves(30 * 1000);
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
      expect(stubs.appsRuntimeState.recordRestart.called).to.be.false;
    });

    // No die event fires for a FAILED start (the container never ran), so a start
    // throw that is merely logged leaves the component down until the hourly
    // sweep. The failure must schedule its own retry; pacing is free because the
    // attempt was recorded before the start - the retry walks the ladder.
    it('schedules its own retry when the start fails (not the hourly sweep)', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
      stubs.dockerService.appDockerStart.rejects(new Error('failed to attach network'));

      await appReconciler.reconcile('www_App'); // must not throw

      expect(stubs.dockerService.appDockerStart.callCount).to.equal(1);
      clock.tick(6000); // past the near-term retry
      await new Promise((resolve) => { setImmediate(() => { setImmediate(resolve); }); });
      expect(stubs.dockerService.appDockerStart.callCount).to.equal(2);
      // each attempt was recorded, so the follow-ups pace via the backoff ladder
      expect(stubs.appsRuntimeState.recordRestart.callCount).to.equal(2);
      clock.restore();
    });

    it('does not schedule a retry after a successful start', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });

      await appReconciler.reconcile('www_App');

      expect(stubs.dockerService.appDockerStart.callCount).to.equal(1);
      clock.tick(60 * 1000);
      await new Promise((resolve) => { setImmediate(() => { setImmediate(resolve); }); });
      expect(stubs.dockerService.appDockerStart.callCount).to.equal(1);
      clock.restore();
    });

    it('hands docker FinishedAt to the backoff decision (true death time even when the die event was missed)', async () => {
      const finishedAt = '2026-06-12T08:00:00.000Z';
      stubs.dockerService.dockerContainerInspect.resolves({
        State: {
          Running: false, Status: 'exited', ExitCode: 1, FinishedAt: finishedAt,
        },
      });
      await appReconciler.reconcile('www_App');
      sinon.assert.calledWithExactly(stubs.appsRuntimeState.restartWaitMs, 'www_App', { lastFinishedAtMs: Date.parse(finishedAt) });
    });

    it('passes no death evidence for a container that never ran (docker zero FinishedAt)', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({
        State: {
          Running: false, Status: 'created', ExitCode: 0, FinishedAt: '0001-01-01T00:00:00Z',
        },
      });
      await appReconciler.reconcile('www_App');
      sinon.assert.calledWithExactly(stubs.appsRuntimeState.restartWaitMs, 'www_App', { lastFinishedAtMs: null });
    });
  });

  // The sync layer's first-run / new-app reset was previously an imperative
  // stop+rm-rf done OUTSIDE the reconciler's single-flight, so a backoff-elapsed
  // start could land in the wipe window and corrupt fresh data (the S1 data-loss
  // race). The wipe is now declared as desired data-state and actuated by the
  // reconciler - the sole container/data actuator - inside the per-key single-
  // flight, which makes start-into-wipe structurally impossible.
  describe('data-clear (sync-layer wipe via the reconciler)', () => {
    // requestStopAndClearData is wired with the flux-prefixed docker name (the form
    // the syncthing flow uses); the reconciler keys state by the bare component id
    // and re-prefixes for the on-disk wipe path.
    it('wipes local appdata (prefixed path) and does not start, on a clear request', async () => {
      localSpec = { name: 'App', version: 4, compose: [{ name: 'db', containerData: 'g:/data' }] };
      stubs.globalState.bootContainerStateSettled = false;
      appReconciler.requestStopAndClearData('fluxdb_App', 'syncthing first-run');
      stubs.globalState.bootContainerStateSettled = true;
      await appReconciler.reconcile('db_App');
      expect(stubs.dockerOperations.appDeleteDataInMountPoint.calledOnceWith('fluxdb_App')).to.be.true;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    // The structural guarantee: even with a contradictory running verdict, the
    // pending clear is resolved before the run decision in the SAME single-flight,
    // so a start can never race the wipe.
    it('never starts while a clear is pending, even if the controller says running', async () => {
      localSpec = { name: 'App', version: 4, compose: [{ name: 'db', containerData: 'g:/data' }] };
      stubs.globalState.bootContainerStateSettled = false;
      appReconciler.requestStopAndClearData('fluxdb_App', 'syncthing first-run');
      appReconciler.setControllerDesired('fluxdb_App', 'running', 'contrived contradiction');
      stubs.globalState.bootContainerStateSettled = true;
      await appReconciler.reconcile('db_App');
      expect(stubs.dockerOperations.appDeleteDataInMountPoint.called).to.be.true;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('stops a running container before wiping (no rm -rf under a live container)', async () => {
      localSpec = { name: 'App', version: 4, compose: [{ name: 'db', containerData: 'g:/data' }] };
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      stubs.globalState.bootContainerStateSettled = false;
      appReconciler.requestStopAndClearData('fluxdb_App', 'syncthing reset');
      stubs.globalState.bootContainerStateSettled = true;
      await appReconciler.reconcile('db_App');
      expect(stubs.dockerService.appDockerStop.calledWith('db_App')).to.be.true;
      sinon.assert.callOrder(stubs.dockerService.appDockerStop, stubs.dockerOperations.appDeleteDataInMountPoint);
    });

    it('is one-shot: wipes first, then the next reconcile starts once the verdict is running', async () => {
      localSpec = { name: 'App', version: 4, compose: [{ name: 'db', containerData: 'g:/data' }] };
      stubs.globalState.bootContainerStateSettled = false;
      appReconciler.requestStopAndClearData('fluxdb_App', 'syncthing first-run');
      // sync layer has already confirmed a source and elected running; the pending
      // clear must still win the first pass
      appReconciler.setControllerDesired('fluxdb_App', 'running', 'syncthing synced');
      stubs.globalState.bootContainerStateSettled = true;

      await appReconciler.reconcile('db_App'); // clear wins -> wipes, no start
      expect(stubs.dockerOperations.appDeleteDataInMountPoint.calledOnce).to.be.true;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;

      await appReconciler.reconcile('db_App'); // flag cleared -> now starts
      expect(stubs.dockerService.appDockerStart.calledOnceWith('db_App')).to.be.true;
      expect(stubs.dockerOperations.appDeleteDataInMountPoint.calledOnce).to.be.true; // no second wipe
    });

    it('keys the clear per-component (clearing one app does not wipe another)', async () => {
      stubs.globalState.bootContainerStateSettled = false;
      appReconciler.requestStopAndClearData('fluxdb_App', 'reset db');
      appReconciler.setControllerDesired('fluxweb_Other', 'running', 'synced');
      stubs.globalState.bootContainerStateSettled = true;
      localSpec = { name: 'Other', version: 4, compose: [{ name: 'web', containerData: 'r:/data' }] };
      await appReconciler.reconcile('web_Other');
      expect(stubs.dockerOperations.appDeleteDataInMountPoint.called).to.be.false;
      expect(stubs.dockerService.appDockerStart.calledOnceWith('web_Other')).to.be.true;
    });

    // A failed stop/wipe (busy mount, fs error, docker blip) is the one actuation
    // path that otherwise just drops to the hourly sweep (~1h down). It must arm its
    // own quick retry like the start path does.
    it('schedules its own retry when the wipe fails (not the hourly sweep)', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
      localSpec = { name: 'App', version: 4, compose: [{ name: 'db', containerData: 'g:/data' }] };
      stubs.dockerOperations.appDeleteDataInMountPoint.rejects(new Error('mount busy'));
      stubs.globalState.bootContainerStateSettled = false;
      appReconciler.requestStopAndClearData('fluxdb_App', 'syncthing first-run');
      stubs.globalState.bootContainerStateSettled = true;

      await appReconciler.reconcile('db_App'); // must not throw

      expect(stubs.dockerOperations.appDeleteDataInMountPoint.callCount).to.equal(1);
      clock.tick(6000); // past the near-term retry (MANAGED_RETRY_MS)
      await new Promise((resolve) => { setImmediate(() => { setImmediate(resolve); }); });
      expect(stubs.dockerOperations.appDeleteDataInMountPoint.callCount).to.equal(2);
      clock.restore();
    });

    // The data-safety invariant must survive a failed wipe: the clear stays pending so
    // a later reconcile re-runs the (idempotent) wipe and can NEVER start the container
    // on un-wiped data, even when the controller already says running.
    it('keeps the clear pending on a failed wipe — never starts on un-wiped data', async () => {
      localSpec = { name: 'App', version: 4, compose: [{ name: 'db', containerData: 'g:/data' }] };
      stubs.dockerOperations.appDeleteDataInMountPoint.rejects(new Error('mount busy'));
      stubs.globalState.bootContainerStateSettled = false;
      appReconciler.requestStopAndClearData('fluxdb_App', 'syncthing first-run');
      appReconciler.setControllerDesired('fluxdb_App', 'running', 'contrived contradiction');
      stubs.globalState.bootContainerStateSettled = true;

      await appReconciler.reconcile('db_App'); // first attempt: wipe throws, caught

      stubs.dockerOperations.appDeleteDataInMountPoint.resetHistory();
      await appReconciler.reconcile('db_App'); // flag still 'clear' -> re-wipes, no start
      expect(stubs.dockerOperations.appDeleteDataInMountPoint.called).to.be.true;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });
  });

  // The reconciler owns the monitoring lifecycle on BOTH ends: it starts
  // monitoring on the start branch, so it must stop monitoring when it stops a
  // container, or a deliberately-stopped container is left with a polling interval
  // erroring against it every minute.
  describe('monitoring follows run-state', () => {
    it('stops monitoring when it stops a running operator-stopped component', async () => {
      stubs.appsRuntimeState.isOperatorStopped.resolves(true);
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerStop.calledOnceWith('www_App')).to.be.true;
      expect(stubs.appInspector.stopAppMonitoring.calledOnceWith('www_App', false)).to.be.true;
    });
  });

  // An in-flight operation (backup/restore) drives a component to a desired
  // run-state THROUGH the reconciler (the sole actuator) via drive(), which sets a
  // transient hold (operationDesired) and awaits convergence — it never calls
  // Docker itself.
  describe('drive (operation run-state hold)', () => {
    it('drives a running component to stopped and resolves converged', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      const result = await appReconciler.drive(['www_App'], 'stopped');
      expect(result.converged).to.be.true;
      expect(stubs.dockerService.appDockerStop.calledOnceWith('www_App')).to.be.true;
      expect(stubs.appInspector.stopAppMonitoring.calledOnceWith('www_App', false)).to.be.true;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('keeps a held component stopped on a later reconcile (transient hold persists)', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: false, Status: 'exited', ExitCode: 0 } });
      await appReconciler.drive(['www_App'], 'stopped');
      stubs.dockerService.appDockerStart.resetHistory();
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('drives a held component back to running once the hold is released', async () => {
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: false, Status: 'exited', ExitCode: 0 } });
      await appReconciler.drive(['www_App'], 'stopped');
      const result = await appReconciler.drive(['www_App'], 'running');
      expect(result.converged).to.be.true;
      expect(stubs.dockerService.appDockerStart.calledOnceWith('www_App')).to.be.true;
    });

    it('settles a driveRunning to stopped when the operator lock still holds (no churn start)', async () => {
      stubs.appsRuntimeState.isOperatorStopped.resolves(true);
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: false, Status: 'exited', ExitCode: 0 } });
      const result = await appReconciler.drive(['www_App'], 'running');
      expect(result.converged).to.be.true;
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });
  });

  describe('component selection and enterprise decryption', () => {
    // The reconciler is per-component: reconcile(<comp>_<app>) must resolve exactly the
    // matching compose entry out of a multi-entry app, so a partial state (one component
    // crashed while siblings run) is enforced on the right component with the right type.
    it('selects the matching entry from a multi-component compose (partial state)', async () => {
      localSpec = {
        name: 'App',
        version: 4,
        compose: [
          { name: 'www', containerData: '/data' },
          { name: 'db', containerData: 'g:/data' }, // master/slave - needs a controller
          { name: 'cache', containerData: '/cache' }, // plain - always policy
        ],
      };
      // 'cache' is plain -> a stopped one is started (picked 'cache', not 'www' or g: 'db')
      await appReconciler.reconcile('cache_App');
      expect(stubs.dockerService.appDockerStart.calledOnceWith('cache_App')).to.be.true;

      // 'db' is g: -> NOT started without a controller (picked 'db', not plain 'cache'/'www')
      stubs.dockerService.appDockerStart.resetHistory();
      await appReconciler.reconcile('db_App');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
    });

    it('acts on the decrypted spec, not the encrypted one, for an enterprise app', async () => {
      // stored (encrypted) spec has no usable containerData; decryption reveals it is g:
      localSpec = {
        name: 'App', version: 8, enterprise: 'CIPHERTEXT', compose: [{ name: 'db', containerData: '' }],
      };
      stubs.deploymentProvider.buildDeployment.callsFake(async () => fakeDeployment(
        { name: 'App', version: 8, compose: [{ name: 'db', containerData: 'g:/data' }] },
      ));
      await appReconciler.reconcile('db_App');
      // treated as g: from the DECRYPTED containerData -> not started without a controller.
      // If it had acted on the encrypted spec (containerData '') it would be a plain start.
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('defers (does not act on encrypted data) when enterprise decryption fails', async () => {
      localSpec = {
        name: 'App', version: 8, enterprise: 'CIPHERTEXT', compose: [{ name: 'db', containerData: '' }],
      };
      // decryption failing (e.g. key not loaded at boot) must defer, not act on ciphertext
      stubs.deploymentProvider.buildDeployment.rejects(new Error('Could not resolve spec for App'));
      await appReconciler.reconcile('db_App'); // must not throw
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
      const deferred = stubs.log.warn.getCalls().some((c) => /spec read failed, deferring/.test(c.args[0]));
      expect(deferred, 'should defer on decrypt failure, never act on still-encrypted data').to.equal(true);
    });
  });

  // The sweep contract (v9): enqueueAll enqueues every installed app BY NAME;
  // reconcile expands each app-level id to its component identifiers through the
  // deployment layer (which owns version dispatch + decryption) and reconciles
  // each. An app whose spec can't be resolved (e.g. enterprise decrypt fails)
  // DEFERS at reconcile - never acted on with ciphertext - and one failing app
  // never aborts the sweep for the others. Assertions target that coverage.
  describe('enqueueAll sweep coverage', () => {
    // enqueueAll -> reconcile(app) -> expand -> reconcile(component) -> start is a
    // two-hop chain off immediately-resolving stubs; a handful of macrotask turns
    // deterministically drains it rather than guessing exact tick counts.
    const flush = async () => {
      for (let i = 0; i < 6; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setImmediate(resolve); });
      }
    };

    it('enqueues an app by name and reconciles every component it expands to', async () => {
      localSpec = {
        name: 'EntApp', version: 8, enterprise: 'CIPHERTEXT',
        compose: [{ name: 'c1', containerData: '/data' }, { name: 'c2', containerData: '/data' }],
      };
      stubs.appQueryService.installedApps.resolves({ status: 'success', data: [{ name: 'EntApp' }] });

      const started = [];
      stubs.dockerService.appDockerStart.callsFake(async (id) => { started.push(id); });

      await appReconciler.enqueueAll('test');
      await flush();
      // the app id expands through the deployment layer to its component ids,
      // each reconciled to a start
      expect(started).to.have.members(['c1_EntApp', 'c2_EntApp']);
    });

    it('defers an app whose spec cannot be resolved (decrypt fails) - never acts on ciphertext', async () => {
      localSpec = {
        name: 'EntApp', version: 8, enterprise: 'CIPHERTEXT', compose: [{ name: 'c1', containerData: '/data' }],
      };
      stubs.appQueryService.installedApps.resolves({ status: 'success', data: [{ name: 'EntApp' }] });
      // benchd unavailable: building the deployment for the still-encrypted spec throws
      stubs.deploymentProvider.buildDeployment.rejects(new Error('benchd unavailable'));

      await appReconciler.enqueueAll('test');
      await flush();
      // the encrypted app defers at reconcile - no expansion onto, nor actuation of, ciphertext
      expect(stubs.dockerService.appDockerStart.called, 'must never start on an unresolved spec').to.be.false;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
    });

    it('one app failing to resolve does not abort the sweep for the others', async () => {
      const plain = { name: 'Plain', version: 4, compose: [{ name: 'www', containerData: '/data' }] };
      // the failing app FIRST: a sweep that died on it would never reach Plain
      stubs.appQueryService.installedApps.resolves({ status: 'success', data: [{ name: 'EntApp' }, { name: 'Plain' }] });
      stubs.appsRepository.getInstalledApp.callsFake(async (n) => ({ name: n, isEncrypted: n === 'EntApp' }));
      stubs.deploymentProvider.buildDeployment.callsFake(async (inst) => {
        if (inst.name === 'EntApp') throw new Error('benchd unavailable');
        return fakeDeployment(plain);
      });

      const started = [];
      stubs.dockerService.appDockerStart.callsFake(async (id) => { started.push(id); });

      await appReconciler.enqueueAll('test');
      await flush();
      expect(started, 'the resolvable app must still reconcile and start').to.include('www_Plain');
    });

    it('sweeps a single-component (flat) app under its bare app name', async () => {
      localSpec = { name: 'Legacy', version: 3, containerData: '/data' };
      stubs.appQueryService.installedApps.resolves({ status: 'success', data: [{ name: 'Legacy' }] });

      const started = [];
      stubs.dockerService.appDockerStart.callsFake(async (id) => { started.push(id); });

      await appReconciler.enqueueAll('test');
      await flush();
      // a flat (v1-3) component identifier IS the bare app name, so reconcile
      // resolves it directly (no expansion stutter)
      expect(started).to.deep.equal(['Legacy']);
    });
  });

  // The boot-drain gate: the first apprunning broadcast must not race the boot
  // reconciles (a too-early snapshot misses apps whose rows then expire on the
  // sigterm TTL). waitForBootDrainSettled() resolves once every boot-held
  // component has completed ONE reconcile pass (started, backoff-deferred,
  // awaiting-controller, or failed loudly) - NOT "all containers running" - and
  // is capped so a wedged reconcile cannot suppress network presence forever.
  describe('boot drain gate', () => {
    const flush = async () => {
      await new Promise((resolve) => { setImmediate(resolve); });
      await new Promise((resolve) => { setImmediate(resolve); });
    };

    it('opens only after every boot-held reconcile completes one pass', async () => {
      stubs.globalState.bootContainerStateSettled = false;
      let openBootGate;
      stubs.globalState.waitForBootContainerStateSettled = () => new Promise((resolve) => { openBootGate = resolve; });
      let finishInspect;
      stubs.dockerService.dockerContainerInspect = sinon.stub().callsFake(() => new Promise((resolve) => {
        finishInspect = () => resolve({ State: { Running: false, Status: 'exited', ExitCode: 1 } });
      }));

      appReconciler.enqueue('www_App'); // held in bootPending
      const startPromise = appReconciler.start();
      let drainSettled = false;
      appReconciler.waitForBootDrainSettled().then(() => { drainSettled = true; });

      stubs.globalState.bootContainerStateSettled = true;
      openBootGate();
      await startPromise;
      await flush();
      expect(drainSettled, 'gate must hold while a boot reconcile is still in flight').to.be.false;

      finishInspect(); // the held reconcile completes its pass (start path runs on stubs)
      await flush();
      expect(drainSettled, 'gate opens once the drained reconciles complete one pass').to.be.true;
    });

    it('opens after the cap even if a boot reconcile wedges', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
      try {
        stubs.globalState.bootContainerStateSettled = false;
        let openBootGate;
        stubs.globalState.waitForBootContainerStateSettled = () => new Promise((resolve) => { openBootGate = resolve; });
        stubs.dockerService.dockerContainerInspect = sinon.stub().callsFake(() => new Promise(() => {})); // wedged forever

        appReconciler.enqueue('www_App');
        const startPromise = appReconciler.start();
        let drainSettled = false;
        appReconciler.waitForBootDrainSettled().then(() => { drainSettled = true; });

        stubs.globalState.bootContainerStateSettled = true;
        openBootGate();
        await startPromise;
        await flush();
        expect(drainSettled).to.be.false;

        clock.tick(2 * 60 * 1000 + 1); // the cap (~2min) fires
        await flush();
        expect(drainSettled, 'the cap must open the gate despite a wedged reconcile').to.be.true;
      } finally {
        clock.restore();
      }
    });
  });

  // The started-nudge: a container start is information the network wants NOW
  // (a backoff straggler that starts minutes after boot must refresh its
  // appsLocations row inside the ~7min sigterm TTL window, not at the hourly
  // tick). serviceManager wires this callback to the peer broadcast, mirroring
  // appInstaller.setOnInstallComplete; the broadcast layer coalesces bursts.
  describe('container-started notification', () => {
    it('notifies the registered callback after a successful start', async () => {
      const onStarted = sinon.stub();
      appReconciler.setOnContainerStarted(onStarted);
      await appReconciler.reconcile('www_App'); // stopped + always policy -> starts
      expect(stubs.dockerService.appDockerStart.calledOnce).to.be.true;
      expect(onStarted.calledOnceWith('www_App')).to.be.true;
    });

    it('does not notify on a stop or a failed start', async () => {
      const onStarted = sinon.stub();
      appReconciler.setOnContainerStarted(onStarted);

      // reconcile that stops an operator-stopped running container
      stubs.appsRuntimeState.isOperatorStopped.resolves(true);
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerStop.calledOnce).to.be.true;
      expect(onStarted.called).to.be.false;

      // reconcile whose docker start throws
      stubs.appsRuntimeState.isOperatorStopped.resolves(false);
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: false, Status: 'exited', ExitCode: 1 } });
      stubs.dockerService.appDockerStart.rejects(new Error('boom'));
      await appReconciler.reconcile('www_App').catch(() => {});
      expect(onStarted.called).to.be.false;
    });
  });

  describe('workqueue', () => {
    it('enqueue runs a reconcile once the boot gate is open', async () => {
      // startAppMonitoring is the last step of a start-path reconcile
      const done = deferred();
      stubs.appInspector.startAppMonitoring = sinon.stub().callsFake(() => done.resolve());
      appReconciler.enqueue('www_App');
      await done.promise;
      expect(stubs.dockerService.appDockerStart.calledOnceWith('www_App')).to.be.true;
    });

    it('holds enqueues until boot settles, then drains them on start()', async () => {
      let openGate;
      stubs.globalState.bootContainerStateSettled = false;
      stubs.globalState.waitForBootContainerStateSettled = () => new Promise((res) => { openGate = res; });

      appReconciler.enqueue('www_App');
      // enqueue is synchronous while the gate is closed, so this is a real assertion
      expect(stubs.dockerService.dockerContainerInspect.called).to.be.false; // held

      const done = deferred();
      stubs.appInspector.startAppMonitoring = sinon.stub().callsFake(() => done.resolve());
      const startPromise = appReconciler.start();
      stubs.globalState.bootContainerStateSettled = true;
      openGate();
      await startPromise;
      await done.promise; // the drained reconcile actually completed
      expect(stubs.dockerService.dockerContainerInspect.called).to.be.true;
    });

    it('expands an app-level identifier to per-component reconciles (boot recovery, sweep)', async () => {
      // Component identifiers live inside the deployment (sometimes behind
      // encryption), so boot recovery and the hourly sweep can only enqueue
      // the bare app name. The reconciler must fan out, not silently drop it.
      localSpec = {
        name: 'App',
        version: 4,
        compose: [
          { name: 'web', containerData: '/data' },
          { name: 'cache', containerData: '/data' },
        ],
      };
      const started = [];
      const done = deferred();
      stubs.dockerService.appDockerStart = sinon.stub().callsFake(async (id) => {
        started.push(id);
        if (started.length === 2) done.resolve();
      });
      appReconciler.enqueue('App'); // bare app name - no component identifier matches
      await done.promise;
      expect(started.sort()).to.deep.equal(['cache_App', 'web_App']);
    });

    it('expands the bare name of a component named like its app to the name_name identifier', async () => {
      // 146 live production apps are single-component with the component
      // named after the app; their container identifier is the stutter, so a
      // bare-name enqueue must expand rather than half-match the component.
      localSpec = {
        name: 'App',
        version: 4,
        compose: [{ name: 'App', containerData: '/data' }],
      };
      const done = deferred();
      stubs.dockerService.appDockerStart = sinon.stub().callsFake(async (id) => done.resolve(id));
      appReconciler.enqueue('App');
      expect(await done.promise).to.equal('App_App');
    });

    it('surfaces a component identifier that matches nothing instead of dropping it', async () => {
      const done = deferred();
      stubs.log.error = sinon.stub().callsFake(() => done.resolve());
      appReconciler.enqueue('gone_App'); // component "gone" does not exist
      await done.promise;
      expect(stubs.log.error.firstCall.args[0]).to.include('does not match any component');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('coalesces concurrent enqueues for the same id into a single re-run', async () => {
      const resolvers = [];
      const reachedInspect = [deferred(), deferred()];
      stubs.dockerService.dockerContainerInspect = sinon.stub().callsFake(() => new Promise((res) => {
        resolvers.push(() => res({ State: { Running: true, Status: 'running', ExitCode: 0 } }));
        const d = reachedInspect[resolvers.length - 1];
        if (d) d.resolve();
      }));

      appReconciler.enqueue('www_App'); // reconcile #1 -> blocks at inspect
      await reachedInspect[0].promise;
      expect(resolvers).to.have.lengthOf(1);

      appReconciler.enqueue('www_App'); // in-flight -> mark dirty
      appReconciler.enqueue('www_App'); // still dirty (coalesced, not a separate run)
      resolvers[0](); // finish #1 -> exactly one coalesced re-run
      await reachedInspect[1].promise;
      expect(resolvers).to.have.lengthOf(2); // one re-run, not two
      resolvers[1]();
    });
  });

  describe('graceful stop-but-keep routing to the shutdown coordinator', () => {
    beforeEach(() => {
      // desired=false (condemned) + actual running => the reconciler's stop branch
      stubs.appsRuntimeState.isCondemned.resolves(true);
      stubs.dockerService.dockerContainerInspect.resolves({ State: { Running: true, Status: 'running', ExitCode: 0 } });
    });

    it('routes a non-force condemned stop through the coordinator and takes no docker action when it owns it', async () => {
      const requestGracefulStop = sinon.stub().resolves(true);
      appReconciler.setRequestGracefulStop(requestGracefulStop);

      await appReconciler.reconcile('www_App');

      expect(requestGracefulStop.calledOnceWith('www_App', 'condemned')).to.equal(true);
      expect(stubs.dockerService.appDockerStop.called).to.equal(false);
      expect(stubs.dockerService.appDockerKill.called).to.equal(false);
    });

    it('falls back to a local appDockerStop when the coordinator declines (non-Arcane)', async () => {
      appReconciler.setRequestGracefulStop(sinon.stub().resolves(false));

      await appReconciler.reconcile('www_App');

      expect(stubs.dockerService.appDockerStop.calledOnceWith('www_App')).to.equal(true);
      expect(stubs.dockerService.appDockerKill.called).to.equal(false);
    });

    it('does a local appDockerStop when no coordinator is wired', async () => {
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerStop.calledOnceWith('www_App')).to.equal(true);
    });

    it('still hard-kills a force-condemned app, never routing to the coordinator', async () => {
      stubs.appsRuntimeState.getState.resolves({ condemnedForce: true });
      const requestGracefulStop = sinon.stub().resolves(true);
      appReconciler.setRequestGracefulStop(requestGracefulStop);

      await appReconciler.reconcile('www_App');

      expect(stubs.dockerService.appDockerKill.calledOnceWith('www_App')).to.equal(true);
      expect(requestGracefulStop.called).to.equal(false);
      expect(stubs.dockerService.appDockerStop.called).to.equal(false);
    });
  });
});
