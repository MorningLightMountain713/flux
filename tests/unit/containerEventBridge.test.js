const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
// Real registry singleton - un-stubbed in proxyquire, so the bridge and the test share it.
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');

describe('containerEventBridge', () => {
  let stubs;
  let containerEventBridge;

  beforeEach(() => {
    stubs = {
      log: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
      dockerService: { dockerGetEvents: sinon.stub(), dockerListContainers: sinon.stub().resolves([]) },
      dockerEventStream: {
        createDockerEventStream: sinon.stub().callsFake((options) => {
          stubs.subscriptionOptions = options;
          return { start: sinon.stub().resolves(), stop: sinon.stub(), connected: () => true };
        }),
      },
      globalState: { bootContainerStateSettled: true },
      appsRuntimeState: { recordExit: sinon.stub().resolves() },
      appReconciler: {
        enqueue: sinon.stub(),
        enqueueAll: sinon.stub().resolves(),
        enqueueDependents: sinon.stub().resolves(),
      },
    };
    containerEventBridge = proxyquire('../../ZelBack/src/services/appMonitoring/containerEventBridge', {
      '../../lib/log': stubs.log,
      '../dockerService': stubs.dockerService,
      '../utils/dockerEventStream': stubs.dockerEventStream,
      '../utils/globalState': stubs.globalState,
      '../appManagement/appsRuntimeState': stubs.appsRuntimeState,
      './appReconciler': stubs.appReconciler,
    });
  });

  afterEach(() => {
    operationRegistry.clear();
    sinon.restore();
  });

  const dieEvent = (name, exitCode = 1) => ({ Action: 'die', Actor: { Attributes: { name, exitCode: String(exitCode) } } });
  const startEvent = (name) => ({ Action: 'start', Actor: { Attributes: { name } } });
  const healthEvent = (name, status) => ({ Action: `health_status: ${status}`, Actor: { Attributes: { name } } });

  describe('die', () => {
    it('enqueues a reconcile for a flux container crash die (raw name; the reconciler canonicalises)', async () => {
      await containerEventBridge.handleContainerDie(dieEvent('fluxwww_app', 137));
      // pass the RAW container name - enqueue/recordExit canonicalise to the bare
      // component id (one strip, in one place), exactly like every other enqueue caller
      expect(stubs.appReconciler.enqueue.calledOnceWith('fluxwww_app')).to.be.true;
      expect(stubs.appsRuntimeState.recordExit.calledOnceWith('fluxwww_app', 137)).to.be.true;
    });

    it('does not wake dependents on a non-zero exit (only a clean exit satisfies completed)', async () => {
      await containerEventBridge.handleContainerDie(dieEvent('fluxinit_app', 1));
      expect(stubs.appReconciler.enqueueDependents.called).to.be.false;
    });

    it('wakes dependents on a clean exit (a completed run-once target)', async () => {
      await containerEventBridge.handleContainerDie(dieEvent('fluxinit_app', 0));
      expect(stubs.appReconciler.enqueue.calledOnceWith('fluxinit_app')).to.be.true;
      expect(stubs.appReconciler.enqueueDependents.calledOnceWith('fluxinit_app')).to.be.true;
    });

    it('does NOT reconcile a deliberate-stop die while the stop operation holds the lease', async () => {
      operationRegistry.acquire('fluxwww_app', 'stopping', 'test'); // held by an in-flight appDockerStop
      await containerEventBridge.handleContainerDie(dieEvent('fluxwww_app', 0));
      expect(stubs.appReconciler.enqueue.called).to.be.false;
      expect(stubs.appReconciler.enqueueDependents.called).to.be.false;
      expect(stubs.appsRuntimeState.recordExit.called).to.be.false;
      // the lease is OWNED by the stop operation (released in its finally), not by
      // this event - the handler must not release it out from under the operation
      expect(operationRegistry.isHeld('fluxwww_app')).to.be.true;
    });

    it('does NOT reconcile a die while a teardown holds the removing lease (also stop-aligned)', async () => {
      operationRegistry.acquire('fluxwww_app', 'removing', 'test'); // held by an in-flight teardown
      await containerEventBridge.handleContainerDie(dieEvent('fluxwww_app', 0));
      expect(stubs.appReconciler.enqueue.called).to.be.false;
      expect(stubs.appsRuntimeState.recordExit.called).to.be.false;
    });

    // A die while an 'actuating' (create/start) lease is held is a genuine crash-on-start,
    // NOT a deliberate stop — it must be recorded and re-reconciled, never swallowed. This
    // is the guard that keeps the new start lease from eating crash dies (which would
    // otherwise leave the component down until the hourly sweep).
    it('DOES reconcile a die while an actuating (start) lease is held — a crash-on-start is real', async () => {
      operationRegistry.acquire('fluxwww_app', 'actuating', 'test'); // held by an in-flight appDockerStart
      await containerEventBridge.handleContainerDie(dieEvent('fluxwww_app', 137));
      expect(stubs.appReconciler.enqueue.calledOnceWith('fluxwww_app')).to.be.true;
      expect(stubs.appsRuntimeState.recordExit.calledOnceWith('fluxwww_app', 137)).to.be.true;
    });

    it('ignores non-flux containers', async () => {
      await containerEventBridge.handleContainerDie(dieEvent('some_other_container'));
      expect(stubs.appReconciler.enqueue.called).to.be.false;
      expect(stubs.appsRuntimeState.recordExit.called).to.be.false;
    });
  });

  // destroy = the container was REMOVED. A deliberate teardown holds its stop-aligned
  // lease while destroying (skip); anything else is an out-of-band removal (docker
  // rm -f under us) whose vanish the reconciler must discover NOW — the die often
  // races the rm window ("exists but stopped") and without destroy the vanish waits
  // for a paced retry or the hourly sweep.
  describe('destroy', () => {
    const destroyEvent = (name) => ({ Action: 'destroy', Actor: { Attributes: { name } } });

    it('enqueues a reconcile for an out-of-band removal of a flux container', () => {
      containerEventBridge.handleContainerDestroy(destroyEvent('fluxwww_app'));
      expect(stubs.appReconciler.enqueue.calledOnceWith('fluxwww_app')).to.be.true;
    });

    it('does NOT reconcile a teardown-owned destroy while the removing lease is held', () => {
      operationRegistry.acquire('fluxwww_app', 'removing', 'test'); // an in-flight uninstall
      containerEventBridge.handleContainerDestroy(destroyEvent('fluxwww_app'));
      expect(stubs.appReconciler.enqueue.called).to.be.false;
      expect(operationRegistry.isHeld('fluxwww_app')).to.be.true;
    });

    it('ignores non-flux containers', () => {
      containerEventBridge.handleContainerDestroy(destroyEvent('some_other_container'));
      expect(stubs.appReconciler.enqueue.called).to.be.false;
    });
  });

  describe('start', () => {
    it('wakes the dependents of a started container (satisfies a dependsOn started)', () => {
      containerEventBridge.handleContainerStart(startEvent('fluxdb_app'));
      expect(stubs.appReconciler.enqueueDependents.calledOnceWith('fluxdb_app')).to.be.true;
      // a start event for the container itself is a no-op for the container - the
      // reconciler is level-based and only dependents need re-evaluating
      expect(stubs.appReconciler.enqueue.called).to.be.false;
    });

    it('ignores non-flux containers', () => {
      containerEventBridge.handleContainerStart(startEvent('postgres'));
      expect(stubs.appReconciler.enqueueDependents.called).to.be.false;
    });
  });

  describe('health_status', () => {
    // The status is NOT parsed from the event: docker carries it only as a free-form
    // Action suffix ("health_status: <status-or-raw-output>"), which it documents as "far
    // from ideal". Any health event re-reconciles the container (the reconciler reads the
    // authoritative .State.Health.Status from inspect and restarts it if unhealthy) and
    // re-evaluates its dependents (a dependsOn 'healthy' dependent starts once the target
    // reads healthy).
    it('re-reconciles the container and re-evaluates its dependents on any health event', () => {
      containerEventBridge.handleContainerHealth(healthEvent('fluxweb_app', 'unhealthy'));
      expect(stubs.appReconciler.enqueue.calledOnceWith('fluxweb_app')).to.be.true;
      expect(stubs.appReconciler.enqueueDependents.calledOnceWith('fluxweb_app')).to.be.true;
    });

    it('behaves identically for a free-form health Action (which the old colon-parse would mangle)', () => {
      containerEventBridge.handleContainerEvent({ Action: 'health_status: probe failed: connection refused', Actor: { Attributes: { name: 'fluxdb_app' } } });
      expect(stubs.appReconciler.enqueue.calledOnceWith('fluxdb_app')).to.be.true;
      expect(stubs.appReconciler.enqueueDependents.calledOnceWith('fluxdb_app')).to.be.true;
    });

    it('ignores non-flux containers', () => {
      containerEventBridge.handleContainerHealth(healthEvent('redis', 'unhealthy'));
      expect(stubs.appReconciler.enqueue.called).to.be.false;
      expect(stubs.appReconciler.enqueueDependents.called).to.be.false;
    });
  });

  describe('handleContainerEvent dispatch', () => {
    it('routes die / destroy / start / health_status to the right handler by Action', async () => {
      await containerEventBridge.handleContainerEvent(dieEvent('fluxa_app', 5));
      expect(stubs.appReconciler.enqueue.calledWith('fluxa_app'), 'die -> enqueue self').to.be.true;

      containerEventBridge.handleContainerEvent({ Action: 'destroy', Actor: { Attributes: { name: 'fluxd_app' } } });
      expect(stubs.appReconciler.enqueue.calledWith('fluxd_app'), 'destroy -> enqueue self').to.be.true;

      containerEventBridge.handleContainerEvent(startEvent('fluxb_app'));
      expect(stubs.appReconciler.enqueueDependents.calledWith('fluxb_app'), 'start -> wake dependents').to.be.true;

      containerEventBridge.handleContainerEvent(healthEvent('fluxc_app', 'unhealthy'));
      expect(stubs.appReconciler.enqueue.calledWith('fluxc_app'), 'unhealthy -> enqueue self').to.be.true;
    });
  });

  // The stream plumbing itself - chunk reassembly, one-resubscribe-per-outage,
  // the stale-stream guard - belongs to dockerEventStream and is tested there.
  // What is the bridge's own is WHAT it asks for and WHERE the events go.
  // A session runs under the spec's own app name, so it passes isFluxContainer.
  // Recognising it has to happen before anything routes.
  describe('playground containers', () => {
    const { PLAYGROUND_LABEL } = require('../../ZelBack/src/services/appPlayground/playgroundSessionRegistry');

    const sessionEvent = (action, name) => ({
      Action: action,
      Actor: { Attributes: { name, exitCode: '1', [PLAYGROUND_LABEL]: 'sess-abc' } },
    });

    it('does not record an exit for a session container', async () => {
      // recordExit upserts, so this would leave an appsRuntimeState row for a
      // component that was never installed, and nothing ever removes it.
      await containerEventBridge.handleContainerEvent(sessionEvent('die', 'fluxmyapp'));

      expect(stubs.appsRuntimeState.recordExit.called).to.be.false;
    });

    it('does not enqueue a reconcile for a session container', async () => {
      // A session component that dies IS the verdict its owner is shown; a
      // restart policy applied to it would report a pass for an app that crashes.
      await containerEventBridge.handleContainerEvent(sessionEvent('die', 'fluxmyapp'));

      expect(stubs.appReconciler.enqueue.called).to.be.false;
    });

    it('drops destroy, start and health_status for a session container too', async () => {
      await containerEventBridge.handleContainerEvent(sessionEvent('destroy', 'fluxmyapp'));
      await containerEventBridge.handleContainerEvent(sessionEvent('start', 'fluxmyapp'));
      await containerEventBridge.handleContainerEvent(sessionEvent('health_status: healthy', 'fluxmyapp'));

      expect(stubs.appReconciler.enqueue.called).to.be.false;
      expect(stubs.appReconciler.enqueueDependents.called).to.be.false;
    });

    it('drops a session container network disconnect without resolving it', async () => {
      await containerEventBridge.handleContainerEvent({
        Type: 'network',
        Action: 'disconnect',
        Actor: { Attributes: { name: 'fluxDockerNetwork_myapp', container: 'abc', [PLAYGROUND_LABEL]: 'sess-abc' } },
      });

      expect(stubs.dockerService.dockerListContainers.called).to.be.false;
      expect(stubs.appReconciler.enqueue.called).to.be.false;
    });

    it('still handles an ordinary flux container - the drop is label-scoped', async () => {
      await containerEventBridge.handleContainerEvent(dieEvent('fluxwww_app', 137));

      expect(stubs.appReconciler.enqueue.calledOnceWith('fluxwww_app')).to.be.true;
      expect(stubs.appsRuntimeState.recordExit.calledOnceWith('fluxwww_app', 137)).to.be.true;
    });
  });

  describe('event subscription', () => {
    it('asks for the container lifecycle events and network disconnects', async () => {
      await containerEventBridge.start();

      const { filters } = stubs.subscriptionOptions;
      expect(filters.type).to.have.members(['container', 'network']);
      expect(filters.event).to.have.members(['die', 'destroy', 'start', 'health_status', 'disconnect']);
      containerEventBridge.stop();
    });

    it('routes received events through its own handler', async () => {
      await containerEventBridge.start();

      await stubs.subscriptionOptions.onEvent(dieEvent('fluxwww_app', 137));

      expect(stubs.appReconciler.enqueue.calledOnceWith('fluxwww_app')).to.be.true;
      containerEventBridge.stop();
    });

    it('reconciles everything on a reconnect - the outage hid whatever died in it', async () => {
      await containerEventBridge.start();

      await stubs.subscriptionOptions.onReconnect();

      expect(stubs.appReconciler.enqueueAll.calledOnceWith('reconnect')).to.be.true;
      containerEventBridge.stop();
    });

    it('does not reconcile on reconnect before boot container state has settled', async () => {
      // Enqueuing everything against a half-known world would fight the boot
      // path rather than help it.
      stubs.globalState.bootContainerStateSettled = false;
      await containerEventBridge.start();

      await stubs.subscriptionOptions.onReconnect();

      expect(stubs.appReconciler.enqueueAll.called).to.be.false;
      containerEventBridge.stop();
    });

    it('reuses one subscription across start/stop cycles', async () => {
      await containerEventBridge.start();
      containerEventBridge.stop();
      await containerEventBridge.start();

      expect(stubs.dockerEventStream.createDockerEventStream.calledOnce).to.be.true;
      containerEventBridge.stop();
    });
  });

  describe('network disconnect', () => {
    // docker network events carry the CONTAINER ID (Actor.Attributes.container) and
    // the NETWORK name (Actor.Attributes.name) - the handler resolves the id itself
    const disconnectEvent = (networkName, containerId) => ({
      Type: 'network', Action: 'disconnect', Actor: { Attributes: { name: networkName, container: containerId } },
    });

    beforeEach(() => {
      stubs.dockerService.dockerListContainers = sinon.stub().resolves([
        { Id: 'abc123', Names: ['/fluxwww_app'] },
      ]);
    });

    it('enqueues a reconcile when a flux container is disconnected from its flux network', async () => {
      await containerEventBridge.handleNetworkDisconnect(disconnectEvent('fluxDockerNetwork_app', 'abc123'));
      expect(stubs.appReconciler.enqueue.calledOnceWith('fluxwww_app')).to.be.true;
    });

    it('ignores disconnects on networks flux does not own', async () => {
      await containerEventBridge.handleNetworkDisconnect(disconnectEvent('bridge', 'abc123'));
      expect(stubs.appReconciler.enqueue.called).to.be.false;
      expect(stubs.dockerService.dockerListContainers.called, 'must not even resolve the container').to.be.false;
    });

    it('ignores a disconnect whose container is already gone (the destroy handler owns absence)', async () => {
      stubs.dockerService.dockerListContainers.resolves([]);
      await containerEventBridge.handleNetworkDisconnect(disconnectEvent('fluxDockerNetwork_app', 'abc123'));
      expect(stubs.appReconciler.enqueue.called).to.be.false;
      expect(stubs.log.error.called, 'a trailing disconnect after removal is normal, never an error').to.be.false;
    });

    it('ignores a disconnect of a non-flux container from a flux network', async () => {
      stubs.dockerService.dockerListContainers.resolves([{ Id: 'abc123', Names: ['/interloper'] }]);
      await containerEventBridge.handleNetworkDisconnect(disconnectEvent('fluxDockerNetwork_app', 'abc123'));
      expect(stubs.appReconciler.enqueue.called).to.be.false;
    });

    it('does NOT reconcile a deliberate teardown disconnect while its stop-aligned lease is held', async () => {
      operationRegistry.acquire('fluxwww_app', 'stopping', 'test');
      await containerEventBridge.handleNetworkDisconnect(disconnectEvent('fluxDockerNetwork_app', 'abc123'));
      expect(stubs.appReconciler.enqueue.called).to.be.false;
      expect(operationRegistry.isHeld('fluxwww_app'), 'the lease belongs to the operation, never released here').to.be.true;
    });

    it('routes Type network/disconnect through the dispatcher and ignores other network actions', async () => {
      await containerEventBridge.handleContainerEvent(disconnectEvent('fluxDockerNetwork_app', 'abc123'));
      expect(stubs.appReconciler.enqueue.calledOnceWith('fluxwww_app')).to.be.true;
      stubs.appReconciler.enqueue.resetHistory();
      await containerEventBridge.handleContainerEvent({ Type: 'network', Action: 'connect', Actor: { Attributes: { name: 'fluxDockerNetwork_app', container: 'abc123' } } });
      expect(stubs.appReconciler.enqueue.called).to.be.false;
    });
  });
});
