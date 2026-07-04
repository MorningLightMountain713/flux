const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const { EventEmitter } = require('node:events');
// Real registry singleton - un-stubbed in proxyquire, so the bridge and the test share it.
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');

describe('containerEventBridge', () => {
  let stubs;
  let containerEventBridge;

  beforeEach(() => {
    stubs = {
      log: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
      dockerService: { dockerGetEvents: sinon.stub() },
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
    it('routes die / start / health_status to the right handler by Action', async () => {
      await containerEventBridge.handleContainerEvent(dieEvent('fluxa_app', 5));
      expect(stubs.appReconciler.enqueue.calledWith('fluxa_app'), 'die -> enqueue self').to.be.true;

      containerEventBridge.handleContainerEvent(startEvent('fluxb_app'));
      expect(stubs.appReconciler.enqueueDependents.calledWith('fluxb_app'), 'start -> wake dependents').to.be.true;

      containerEventBridge.handleContainerEvent(healthEvent('fluxc_app', 'unhealthy'));
      expect(stubs.appReconciler.enqueue.calledWith('fluxc_app'), 'unhealthy -> enqueue self').to.be.true;
    });
  });

  // The event stream is the reconciler's primary trigger; losing it silently
  // means events go unnoticed until the hourly sweep. Every way the stream
  // can die must lead to exactly ONE resubscribe: 'close' can fire without
  // 'error'/'end' (raw socket teardown), and one outage firing several of the
  // signals must not double the stream (each duplicate doubles every event's
  // handling from then on).
  describe('event stream lifecycle', () => {
    const makeStream = () => {
      const stream = new EventEmitter();
      stream.destroy = sinon.stub();
      return stream;
    };

    it('subscribes to die, start and health_status container events', async () => {
      stubs.dockerService.dockerGetEvents.resolves(makeStream());
      try {
        await containerEventBridge.start();
        const { filters } = stubs.dockerService.dockerGetEvents.firstCall.args[0];
        expect(filters.event).to.have.members(['die', 'start', 'health_status']);
      } finally {
        containerEventBridge.stop();
      }
    });

    it('resubscribes when the stream closes without error or end', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
      try {
        const first = makeStream();
        stubs.dockerService.dockerGetEvents.resolves(makeStream());
        stubs.dockerService.dockerGetEvents.onFirstCall().resolves(first);
        await containerEventBridge.start();
        expect(stubs.dockerService.dockerGetEvents.callCount).to.equal(1);

        first.emit('close');
        clock.tick(10000 + 1);
        await new Promise((resolve) => { setImmediate(resolve); });
        expect(stubs.dockerService.dockerGetEvents.callCount, 'a closed stream must be resubscribed').to.equal(2);
      } finally {
        containerEventBridge.stop();
        clock.restore();
      }
    });

    it('collapses error+end+close from one outage into a single resubscribe', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
      try {
        const first = makeStream();
        stubs.dockerService.dockerGetEvents.resolves(makeStream());
        stubs.dockerService.dockerGetEvents.onFirstCall().resolves(first);
        await containerEventBridge.start();

        first.emit('error', new Error('stream died'));
        first.emit('end');
        first.emit('close');
        clock.tick(10000 + 1);
        await new Promise((resolve) => { setImmediate(resolve); });
        await new Promise((resolve) => { setImmediate(resolve); });
        expect(stubs.dockerService.dockerGetEvents.callCount, 'one outage must produce exactly one new stream').to.equal(2);
      } finally {
        containerEventBridge.stop();
        clock.restore();
      }
    });
  });
});
