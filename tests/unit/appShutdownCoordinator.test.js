const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const SHUTDOWN_REASON = {
  TTL_EXPIRED: 'ttl-expired',
  USER_CANCEL: 'user-cancel',
  REDEPLOY: 'redeploy',
  EVICTION: 'eviction',
  MANUAL: 'manual',
};

// Let queued microtasks (the background drain's .then) run.
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('appShutdownCoordinator', () => {
  let coordinator;
  let stubs;

  beforeEach(() => {
    stubs = {
      log: { warn: sinon.stub(), info: sinon.stub(), error: sinon.stub() },
      appsRepository: { getInstalledApp: sinon.stub().resolves({ name: 'myapp', owner: '1own' }) },
      deploymentProvider: { buildDeployment: sinon.stub().resolves({ componentEntries: () => [] }) },
      globalState: {
        isArcane: sinon.stub().returns(true),
        setAppLbState: sinon.stub(),
        clearAppLbState: sinon.stub(),
      },
      fluxShutdowndClient: {
        SHUTDOWN_REASON,
        beginAppStop: sinon.stub().resolves({ outcome: 'complete' }),
      },
      shutdownPlan: { appShutdownBudgetSeconds: sinon.stub().returns(30) },
      appReconciler: { enqueue: sinon.stub() },
    };
    coordinator = proxyquire('../../ZelBack/src/services/appLifecycle/appShutdownCoordinator', {
      '../../lib/log': stubs.log,
      '../appDatabase/appsRepository': stubs.appsRepository,
      '../appRuntime/deploymentProvider': stubs.deploymentProvider,
      '../utils/globalState': stubs.globalState,
      '../utils/fluxShutdowndClient': stubs.fluxShutdowndClient,
      './shutdownPlan': stubs.shutdownPlan,
      '../appMonitoring/appReconciler': stubs.appReconciler,
    });
  });

  afterEach(() => sinon.restore());

  it('returns false off Arcane so the reconciler stops locally', async () => {
    stubs.globalState.isArcane.returns(false);
    const res = await coordinator.requestGracefulStop('web_myapp', 'condemned');
    expect(res).to.equal(false);
    expect(stubs.fluxShutdowndClient.beginAppStop.called).to.equal(false);
  });

  it('returns false for an app not in the local database', async () => {
    stubs.appsRepository.getInstalledApp.resolves(null);
    const res = await coordinator.requestGracefulStop('web_myapp', 'condemned');
    expect(res).to.equal(false);
    expect(stubs.fluxShutdowndClient.beginAppStop.called).to.equal(false);
  });

  it('routes a graceful stop to the daemon (owner/app/reason) and returns true', async () => {
    const res = await coordinator.requestGracefulStop('web_myapp', 'condemned');
    expect(res).to.equal(true);
    expect(stubs.fluxShutdowndClient.beginAppStop.calledOnce).to.equal(true);
    const [owner, app, reason, opts] = stubs.fluxShutdowndClient.beginAppStop.firstCall.args;
    expect(owner).to.equal('1own');
    expect(app).to.equal('myapp');
    expect(reason).to.equal('eviction'); // condemned -> eviction
    expect(opts.force).to.equal(false);
  });

  it('maps each reconciler reason to its wire reason (default manual)', async () => {
    const cases = {
      condemned: 'eviction',
      operatorStopped: 'user-cancel',
      operationHold: 'manual',
      controllerDesired: 'manual',
      policy: 'manual',
    };
    for (const [reconcilerReason, wire] of Object.entries(cases)) {
      stubs.fluxShutdowndClient.beginAppStop.resetHistory();
      // distinct app per case so the single-flight guard doesn't swallow it
      // eslint-disable-next-line no-await-in-loop
      await coordinator.requestGracefulStop(`web_app${reconcilerReason}`, reconcilerReason);
      expect(stubs.fluxShutdowndClient.beginAppStop.firstCall.args[2], reconcilerReason).to.equal(wire);
    }
  });

  it('single-flights concurrent stops of the same app (one drain)', async () => {
    let resolveDrain;
    stubs.fluxShutdowndClient.beginAppStop.returns(new Promise((r) => { resolveDrain = r; }));
    const first = await coordinator.requestGracefulStop('web_myapp', 'condemned');
    const second = await coordinator.requestGracefulStop('db_myapp', 'condemned'); // same app
    expect(first).to.equal(true);
    expect(second).to.equal(true);
    expect(stubs.fluxShutdowndClient.beginAppStop.calledOnce).to.equal(true);
    resolveDrain({ outcome: 'complete' });
  });

  it('on an unreachable daemon: clears the gate, enqueues, and the next pass stops locally', async () => {
    stubs.fluxShutdowndClient.beginAppStop.resolves({ outcome: 'unreachable' });
    const first = await coordinator.requestGracefulStop('web_myapp', 'condemned');
    expect(first).to.equal(true);
    await flush();
    expect(stubs.globalState.clearAppLbState.calledWith('myapp')).to.equal(true);
    expect(stubs.appReconciler.enqueue.calledWith('web_myapp')).to.equal(true);

    // the re-driven pass falls back to a local stop (returns false), then re-allows the daemon
    const second = await coordinator.requestGracefulStop('web_myapp', 'condemned');
    expect(second).to.equal(false);
  });
});
