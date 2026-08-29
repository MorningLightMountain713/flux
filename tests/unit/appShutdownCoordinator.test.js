'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const { appsFolder } = require('../../ZelBack/src/services/utils/appConstants');
// The REAL shutdown planner. The daemon deadline is made of the budget it reads
// off a DeploymentSpec, so stubbing it to a constant left nothing checking that
// the coordinator budgets for the app it is actually stopping.
const shutdownPlan = require('../../ZelBack/src/services/appLifecycle/shutdownPlan');
const {
  loadSpecLibrary, V9_SUBMISSION, v9Spec, instantiatedSpec, assertAnswers,
} = require('./fixtures/fluxSpec');

// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. The coordinator reads an InstantiatedSpec off the identifier index and
// budgets over the DeploymentSpecs projected from it, so those are the two real
// classes below; what stays stubbed is I/O and FluxOS policy (mongo, the
// flux-shutdownd socket, the reconciler queue, the Arcane check).

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
  let flux;

  // The local install rows as the coordinator sees them: per app, the real
  // InstantiatedSpec the row hydrates to plus the real DeploymentSpec the
  // deployment layer projects from it; and the identifier index that maps a
  // component identifier back to its app (the only way an identifier resolves —
  // a minted identity cannot be split back into a name).
  const apps = new Map();
  const identifierIndex = new Map();

  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30000);
    flux = await loadSpecLibrary();
  });

  /**
   * A real FluxAppSpecV9 with the named components. Two components may not share
   * a hostPort, so each gets its own; everything else comes from the shared
   * submission fixture.
   */
  const v9App = (appName, components) => {
    let hostPort = 31000;
    const built = {};
    for (const [name, over] of Object.entries(components)) {
      hostPort += 1;
      built[name] = {
        ...V9_SUBMISSION.components.web,
        name,
        ports: { http: { containerPort: 80, hostPort } },
        ...over,
      };
    }
    return v9Spec({ name: appName, components: built });
  };

  /**
   * Install an app on this node: the real InstantiatedSpec + the real
   * DeploymentSpec, registered in the identifier index the same way a row's
   * recorded component identifiers are.
   *
   * `identity` is the app-identity segment container identifiers are named from
   * — stated, never derived, exactly as DeploymentSpec.fromSpec demands.
   */
  const install = async (appName, { identity = null, components = { web: {} } } = {}) => {
    const spec = await v9App(appName, components);
    const inst = await instantiatedSpec(spec, { identity });
    const deployment = flux.DeploymentSpec.fromSpec(spec, appsFolder, { replica: null, identity });
    apps.set(appName, { inst, deployment });
    for (const [, c] of deployment.componentEntries()) identifierIndex.set(c.identifier, appName);
    return { inst, deployment };
  };

  /** The real container identifier of one component — never assembled by hand. */
  const idOf = (appName, componentName = 'web') => apps.get(appName).deployment
    .getComponent(componentName).identifier;

  beforeEach(async () => {
    apps.clear();
    identifierIndex.clear();
    await install('myapp');

    stubs = {
      log: { warn: sinon.stub(), info: sinon.stub(), error: sinon.stub() },
      appsRepository: {
        // The identifier index: it answers only for identifiers a row actually
        // recorded, which is what makes the minted-identity case resolvable at all.
        getInstalledAppByComponentIdentifier: sinon.stub().callsFake(async (id) => {
          const appName = identifierIndex.get(id);
          return appName ? apps.get(appName).inst : null;
        }),
      },
      // Hands back the REAL DeploymentSpec built for the row it is given — the
      // same class the real provider projects, so componentEntries, the shutdown
      // block and the port set are all the library's answers.
      deploymentProvider: {
        buildDeployment: sinon.stub().callsFake(async (inst) => {
          const entry = apps.get(inst.name);
          return entry ? entry.deployment : null;
        }),
        // Delegates at call time so per-test overrides of buildDeployment flow
        // through the plural entry the coordinator uses.
        get buildDeployments() {
          const single = this.buildDeployment;
          return async (inst) => {
            const deployment = await single(inst);
            return deployment ? [deployment] : [];
          };
        },
      },
      globalState: {
        isArcane: sinon.stub().returns(true),
        setAppShutdownPipelineState: sinon.stub(),
        clearAppShutdownPipelineState: sinon.stub(),
      },
      fluxShutdowndClient: {
        SHUTDOWN_REASON,
        beginAppStop: sinon.stub().resolves({ outcome: 'complete' }),
      },
      appReconciler: { enqueueComponent: sinon.stub() },
    };
    coordinator = proxyquire('../../ZelBack/src/services/appLifecycle/appShutdownCoordinator', {
      '../../lib/log': stubs.log,
      '../appDatabase/appsRepository': stubs.appsRepository,
      '../appRuntime/deploymentProvider': stubs.deploymentProvider,
      '../utils/globalState': stubs.globalState,
      '../utils/fluxShutdowndClient': stubs.fluxShutdowndClient,
      '../appMonitoring/appReconciler': stubs.appReconciler,
    });
  });

  afterEach(() => sinon.restore());

  it('returns false off Arcane so the reconciler stops locally', async () => {
    stubs.globalState.isArcane.returns(false);
    const res = await coordinator.requestGracefulStop(idOf('myapp'), 'condemned');
    expect(res).to.equal(false);
    expect(stubs.fluxShutdowndClient.beginAppStop.called).to.equal(false);
  });

  it('resolves a minted-identity component through the identifier index, not the name split', async () => {
    // A v9 identifier carries the MINTED IDENTITY, not the app name: taking
    // `web_5df148117fa5` apart yields the identity, which resolves as no app at
    // all. Only the index recorded against the row can name the app — and the
    // identifier here is the real DeploymentSpec's, built from that identity.
    const { inst } = await install('myapp2', { identity: '5df148117fa5' });
    const identifier = idOf('myapp2');
    expect(identifier).to.equal('web_5df148117fa5');
    expect(
      flux.DeploymentSpec.appNameFromIdentifier(identifier),
      'the name split cannot recover the app from a minted identifier',
    ).to.not.equal(inst.name);

    const result = await coordinator.requestGracefulStop(identifier, 'operatorStopped');
    expect(result).to.equal(true);
    expect(stubs.fluxShutdowndClient.beginAppStop.calledWith(inst.owner, 'myapp2')).to.equal(true);
  });

  it('returns false for an app not in the local database', async () => {
    // an identifier the index has never seen — nothing is installed under it
    const res = await coordinator.requestGracefulStop('web_notinstalled', 'condemned');
    expect(res).to.equal(false);
    expect(stubs.fluxShutdowndClient.beginAppStop.called).to.equal(false);
  });

  it('routes a graceful stop to the daemon (owner/app/reason) and returns true', async () => {
    const { inst, deployment } = apps.get('myapp');
    // Freeze the clock so the deadline is asserted exactly rather than within a
    // fudge window. The specs are built above — the library never runs under
    // fake timers.
    const clock = sinon.useFakeTimers({ now: 1700000000000 });
    const res = await coordinator.requestGracefulStop(idOf('myapp'), 'condemned');
    expect(res).to.equal(true);
    expect(stubs.fluxShutdowndClient.beginAppStop.calledOnce).to.equal(true);
    const [owner, app, reason, opts] = stubs.fluxShutdowndClient.beginAppStop.firstCall.args;
    // the owner is the row's real FluxID, not a placeholder
    expect(owner).to.equal(inst.owner);
    expect(app).to.equal('myapp');
    expect(reason).to.equal('eviction'); // condemned -> eviction
    expect(opts.force).to.equal(false);
    // The deadline is the REAL planner's budget over the REAL deployment — the
    // node's figure and the daemon's have to agree, so neither side may be a
    // constant a fixture chose.
    expect(opts.deadline).to.equal(1700000000 + shutdownPlan.appShutdownBudgetSeconds(deployment));

    // The stubbed provider received the install row: the real one reads its
    // name and identity and resolves its cleartext through isEncrypted/spec.
    const [handed] = stubs.deploymentProvider.buildDeployment.firstCall.args;
    expect(handed.name).to.equal('myapp');
    expect(handed.identity).to.equal(null);
    expect(handed.isEncrypted).to.equal(false);
    // and the real provider then asks that cleartext's Placement which replicas
    // this node runs, before it builds anything.
    assertAnswers(handed.spec.placement, ['mode', 'hasTargets']);
    clock.restore();
  });

  it('budgets the deadline off the components\' declared graceful shutdown', async () => {
    // The same call, on an app that actually declares a shutdown contract: two
    // components, 45s + 20s graceful. A stubbed planner returning a constant
    // could not tell this app from the default one above.
    const { deployment } = await install('gracefulapp', {
      components: {
        web: { shutdown: { gracefulTimeout: 45 } },
        db: { shutdown: { gracefulTimeout: 20 } },
      },
    });
    expect(shutdownPlan.appShutdownBudgetSeconds(deployment)).to.equal(65);

    const clock = sinon.useFakeTimers({ now: 1700000000000 });
    const res = await coordinator.requestGracefulStop(idOf('gracefulapp'), 'condemned');
    expect(res).to.equal(true);
    const [, , , opts] = stubs.fluxShutdowndClient.beginAppStop.firstCall.args;
    expect(opts.deadline).to.equal(1700000000 + 65);
    clock.restore();
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
      // A distinct app per case so the single-flight guard doesn't swallow it.
      // v9 names are lower-case only (^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$), so the
      // reason is folded — an app called `appoperatorStopped` does not exist.
      const appName = reconcilerReason.toLowerCase();
      // eslint-disable-next-line no-await-in-loop
      await install(appName);
      // eslint-disable-next-line no-await-in-loop
      await coordinator.requestGracefulStop(idOf(appName), reconcilerReason);
      expect(stubs.fluxShutdowndClient.beginAppStop.firstCall.args[2], reconcilerReason).to.equal(wire);
    }
  });

  it('single-flights concurrent stops of the same app (one drain)', async () => {
    // two components of ONE app: the second must ride the first's drain
    await install('twocomp', { components: { web: {}, db: {} } });
    let resolveDrain;
    stubs.fluxShutdowndClient.beginAppStop.returns(new Promise((r) => { resolveDrain = r; }));
    const first = await coordinator.requestGracefulStop(idOf('twocomp', 'web'), 'condemned');
    const second = await coordinator.requestGracefulStop(idOf('twocomp', 'db'), 'condemned');
    expect(first).to.equal(true);
    expect(second).to.equal(true);
    expect(stubs.fluxShutdowndClient.beginAppStop.calledOnce).to.equal(true);
    resolveDrain({ outcome: 'complete' });
  });

  it('on an unreachable daemon: clears the gate, enqueues, and the next pass stops locally', async () => {
    stubs.fluxShutdowndClient.beginAppStop.resolves({ outcome: 'unreachable' });
    const first = await coordinator.requestGracefulStop(idOf('myapp'), 'condemned');
    expect(first).to.equal(true);
    await flush();
    expect(stubs.globalState.clearAppShutdownPipelineState.calledWith('myapp')).to.equal(true);
    expect(stubs.appReconciler.enqueueComponent.calledWith(idOf('myapp'))).to.equal(true);

    // the re-driven pass falls back to a local stop (returns false), then re-allows the daemon
    const second = await coordinator.requestGracefulStop(idOf('myapp'), 'condemned');
    expect(second).to.equal(false);
  });

  it('a COMPLETED drain clears the gate and re-drives - an apprestart issued mid-drain must not stay wedged', async () => {
    stubs.fluxShutdowndClient.beginAppStop.resolves({ outcome: 'complete' });
    const res = await coordinator.requestGracefulStop(idOf('myapp'), 'condemned');
    expect(res).to.equal(true);
    await flush();
    // the drain is over: nothing left for the gate to protect. Without the clear,
    // reconciles stay suppressed for the rest of the budget window and a restart
    // issued during the drain leaves the app down, broadcasting 'stopping'.
    expect(stubs.globalState.clearAppShutdownPipelineState.calledWith('myapp')).to.equal(true);
    expect(stubs.appReconciler.enqueueComponent.calledWith(idOf('myapp'))).to.equal(true);
  });

  it('rejected_pipeline_active keeps the gate - the node-wide pipeline owns the stop', async () => {
    stubs.fluxShutdowndClient.beginAppStop.resolves({ outcome: 'rejected_pipeline_active' });
    const res = await coordinator.requestGracefulStop(idOf('myapp'), 'condemned');
    expect(res).to.equal(true);
    await flush();
    expect(stubs.globalState.clearAppShutdownPipelineState.called).to.equal(false);
    expect(stubs.appReconciler.enqueueComponent.called).to.equal(false);
  });
});
