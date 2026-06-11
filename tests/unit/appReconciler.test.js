const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

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
        identifier: (spec.version >= 4) ? `${c.name}_${spec.name}` : spec.name,
        hasActiveStandbySyncthing: () => isG,
        requiresSyncBeforeStart: () => isR,
        hasSyncthing: () => isSync,
        restartPolicy: c.restartPolicy ?? 'always',
      };
    });
    return {
      getComponent: (n) => comps.find((c) => c.name === n) || null,
      componentEntries: () => comps.map((c) => [c.name, c]),
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
          ? { name: localSpec.name, isEncrypted: Boolean(localSpec.enterprise) }
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
        appDockerStart: sinon.stub().resolves(),
        appDockerStop: sinon.stub().resolves(),
        getAppIdentifier: (id) => `flux${id}`,
        getBaseAppName: (id) => (id.startsWith('flux') ? id.slice(4) : id),
      },
      globalState: {
        appsMonitored: {},
        stoppingContainers: new Set(),
        backupInProgress: [],
        restoreInProgress: [],
        isOperationInProgress: () => false,
        bootContainerStateSettled: true,
        waitForBootContainerStateSettled: () => Promise.resolve(),
        getAppLbState: sinon.stub().returns(null),
      },
      appInspector: { startAppMonitoring: sinon.stub() },
      appsRuntimeState: {
        isOperatorStopped: sinon.stub().resolves(false),
        restartWaitMs: sinon.stub().resolves(0),
        recordRestart: sinon.stub().resolves(),
        recordExit: sinon.stub().resolves(),
      },
      appQueryService: {
        decryptEnterpriseApps: sinon.stub().callsFake(async (arr) => arr),
        installedApps: sinon.stub().resolves({ status: 'success', data: [] }),
      },
      containerHealthMonitor: { recreateMissingContainers: sinon.stub().resolves() },
      appUninstaller: { uninstallApplication: sinon.stub().resolves() },
      appTamperingDetectionService: { recordEvent: sinon.stub().resolves(), isNetworkMissingError: () => false },
    };

    appReconciler = proxyquire('../../ZelBack/src/services/appMonitoring/appReconciler', {
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
      '../appLifecycle/appUninstaller': stubs.appUninstaller,
      '../appTamperingDetectionService': stubs.appTamperingDetectionService,
      '../utils/appConstants': { localAppsInformation: 'zelappsinformation' },
    });
  });

  afterEach(() => { appReconciler.stop(); sinon.restore(); });

  // resolves exactly when its .resolve() is called — lets tests await the real
  // completion signal of an async reconcile instead of guessing with timer ticks
  const deferred = () => {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
  };

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

    it('starts a stopped plain component that should run (default always policy)', async () => {
      await appReconciler.reconcile('www_App');
      expect(stubs.appsRuntimeState.recordRestart.calledOnceWith('www_App')).to.be.true;
      expect(stubs.dockerService.appDockerStart.calledOnceWith('www_App')).to.be.true;
      expect(stubs.appInspector.startAppMonitoring.calledOnce).to.be.true;
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

    it('removes the app locally when recreation fails (docker reachable)', async () => {
      stubs.dockerService.dockerContainerInspect.rejects(new TypeError("Cannot read properties of undefined (reading 'Id')"));
      stubs.dockerService.dockerListContainers.resolves([]); // probe: docker is up
      stubs.containerHealthMonitor.recreateMissingContainers.rejects(new Error('boom'));
      await appReconciler.reconcile('www_App');
      expect(stubs.appTamperingDetectionService.recordEvent.calledWithMatch('App', 'recreation_failed')).to.be.true;
      expect(stubs.appUninstaller.uninstallApplication.calledOnceWith('App', { broadcastRemoval: true })).to.be.true;
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

    it('defers while another operation owns the container', async () => {
      stubs.globalState.isOperationInProgress = () => true;
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
      expect(stubs.dockerService.appDockerStop.called).to.be.false;
    });

    it('defers while the container is in stoppingContainers (transient stop)', async () => {
      stubs.globalState.stoppingContainers.add('fluxwww_App');
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
    });

    it('backs off instead of restarting when a wait is pending', async () => {
      stubs.appsRuntimeState.restartWaitMs.resolves(30 * 1000);
      await appReconciler.reconcile('www_App');
      expect(stubs.dockerService.appDockerStart.called).to.be.false;
      expect(stubs.appsRuntimeState.recordRestart.called).to.be.false;
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
});
