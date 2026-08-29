'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const {
  loadSpecLibrary, V8_SUBMISSION, V9_SUBMISSION, v9Spec, instantiatedSpec,
} = require('./fixtures/fluxSpec');

// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. The double this file carried was a one-line `componentEntries: () =>
// [...]`, and it silently ignored the ONE option production passes it: the stop
// path asks for `componentEntries({ reverse: true })` so a composed app is torn
// down in the opposite order to the one it was started in. A double that returns
// the same array whatever it is asked leaves that reversal completely
// unexercised — the stop tests below now assert the ORDER, which is only
// meaningful against a real DeploymentSpec.
//
// The same double could not express an identity or a replica either, so every
// identifier it produced was the unqualified legacy form. A co-located app's two
// replicas get DISTINCT qualified identifiers, and they have to: monitoring keys
// on the identifier and appInspector.startAppMonitoring assigns
// `appsMonitored[identifier] = {}` outright, so two replicas sharing one key
// would mean one sibling's monitoring silently replacing the other's.
//
// What stays stubbed is I/O and node-local state: appInspector (docker stats
// intervals), the deployment provider (mongo + docker + spec resolution), the
// message envelope, the privilege check and the log.
let flux;

const APPS_FOLDER = '/tmp/apps';
const LEGACY_OWNER = '19z6SjrVrWqBTLiCXWLRjcu9ydnzWNz3UD';

/**
 * A real single-component legacy spec. v3 is deliberate: its one component is
 * named after the app, so its container identifier is the bare app name — the
 * unqualified form the old double hard-coded, here produced by the library
 * rather than asserted into existence.
 */
function legacySpec(name) {
  return flux.FluxAppSpecBase.getVersionClass(3).fromSubmission({
    version: 3,
    name,
    description: `${name} under test`,
    owner: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
    repotag: 'test/app:latest',
    ports: [30001],
    containerPorts: [8080],
    domains: [''],
    enviromentParameters: [],
    commands: [],
    containerData: '',
    cpu: 1,
    ram: 1000,
    hdd: 5,
    instances: 3,
  });
}

/**
 * A real multi-component legacy spec. v8 rather than v9 because the app names
 * this file uses are mixed case, which v9 refuses outright (see the last
 * describe block) — and because a composed legacy app is what produces the
 * `<component>_<app>` identifiers the assertions below name.
 */
function composedSpec(name, componentNames) {
  const [template] = V8_SUBMISSION.compose;
  return flux.FluxAppSpecV8.fromSubmission({
    ...V8_SUBMISSION,
    name,
    compose: componentNames.map((componentName, index) => ({
      ...template,
      name: componentName,
      description: componentName,
      ports: [31443 + index],
      containerPorts: [443 + index],
    })),
    owner: LEGACY_OWNER,
  });
}

/**
 * A real v9 spec PINNED to co-locate two named replicas on ONE node.
 *
 * The per-replica hostPort override is not decoration. Without it the library
 * refuses the spec outright — "co-located replicas need distinct hostPort
 * overrides" — because both replicas would bind 31000 on the same host. A
 * hand-written deployment double co-locates replicas for free and so cannot
 * express the constraint that makes co-location legal in the first place.
 */
async function coLocatedSpec() {
  const components = JSON.parse(JSON.stringify(V9_SUBMISSION.components));
  components.web.replicaOverrides = { r2: { ports: { http: { hostPort: 31001 } } } };
  return v9Spec({
    components,
    assignment: { targetIps: { '1.2.3.4:16127': ['r1', 'r2'] } },
    // `instances` is derived from the assignment, so it must not be authored
    // alongside it.
    instances: undefined,
  });
}

/** A real DeploymentSpec — the object monitoringOrchestrator iterates. */
function deploymentOf(spec, opts = {}) {
  return flux.DeploymentSpec.fromSpec(spec, APPS_FOLDER, {
    replica: opts.replica ?? null,
    identity: opts.identity ?? null,
  });
}

describe('monitoringOrchestrator tests', () => {
  let monitoringOrchestrator;
  let appInspectorStub;
  let getInstalledDeploymentsStub;
  let logStub;
  // name -> DeploymentSpec[], keyed the way the real provider is: by app NAME.
  let installed;

  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(60000);
    flux = await loadSpecLibrary();
  });

  beforeEach(() => {
    appInspectorStub = {
      startAppMonitoring: sinon.stub(),
      stopAppMonitoring: sinon.stub(),
    };

    installed = new Map();
    // Keyed by name rather than by call order, because that is what the real
    // provider keys on — and because sinon's `withArgs` cannot tell two frozen
    // DeploymentSpec instances apart.
    getInstalledDeploymentsStub = sinon.stub().callsFake(
      async (name) => installed.get(name) ?? [],
    );

    logStub = {
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
    };

    monitoringOrchestrator = proxyquire('../../ZelBack/src/services/appMonitoring/monitoringOrchestrator', {
      '../messageHelper': {
        createSuccessMessage: sinon.stub().returnsArg(0),
        createErrorMessage: sinon.stub().returnsArg(0),
        errUnauthorizedMessage: sinon.stub().returns('Unauthorized'),
      },
      '../serviceHelper': { ensureString: sinon.stub().returnsArg(0) },
      '../verificationHelper': { verifyPrivilege: sinon.stub().resolves(true) },
      '../appManagement/appInspector': appInspectorStub,
      '../appRuntime/deploymentProvider': { getInstalledDeployments: getInstalledDeploymentsStub },
      '../../lib/log': logStub,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  /**
   * The deployment provider stays stubbed, so nothing here exercises what the
   * real one does with what it is handed. It is handed `app.name` and looks the
   * app up by it, so assert the NAME arrived — off the real spec, as a usable
   * string. An app object with no `name` reaches the real provider as
   * `getInstalledApp(undefined)`, which finds nothing and reports the app as
   * simply not installed here.
   */
  function assertLookedUpByName(specs) {
    const handed = getInstalledDeploymentsStub.getCalls().map((call) => call.args[0]);
    handed.forEach((name) => {
      expect(name, 'the provider is looked up by a real name string').to.be.a('string');
      expect(name).to.have.length.above(0);
    });
    expect(handed).to.deep.equal(specs.map((spec) => spec.name));
  }

  /** The identifiers monitoring was started for, in call order. */
  const startedIdentifiers = () => appInspectorStub.startAppMonitoring
    .getCalls().map((call) => call.args[0]);

  /** The identifiers monitoring was stopped for, in call order. */
  const stoppedIdentifiers = () => appInspectorStub.stopAppMonitoring
    .getCalls().map((call) => call.args[0]);

  describe('startMonitoringOfApps tests', () => {
    it('should start monitoring for single-component apps', async () => {
      const specs = ['App1', 'App2', 'App3'].map(legacySpec);
      const apps = await Promise.all(specs.map((spec) => instantiatedSpec(spec)));
      specs.forEach((spec) => installed.set(spec.name, [deploymentOf(spec)]));

      const appsMonitored = {};
      await monitoringOrchestrator.startMonitoringOfApps(apps, appsMonitored, null);

      sinon.assert.calledThrice(appInspectorStub.startAppMonitoring);
      // The identifiers are the library's, not the fixture's claim about them:
      // a v3 app's single component is named after the app, so the container
      // identifier is the bare name.
      expect(startedIdentifiers()).to.deep.equal(['App1', 'App2', 'App3']);
      startedIdentifiers().forEach((id) => {
        sinon.assert.calledWith(appInspectorStub.startAppMonitoring, id, appsMonitored);
      });
      assertLookedUpByName(specs);
    });

    it('should start monitoring for multi-component apps', async () => {
      const spec = composedSpec('ComposedApp', ['Component1', 'Component2']);
      const apps = [await instantiatedSpec(spec)];
      installed.set(spec.name, [deploymentOf(spec)]);

      const appsMonitored = {};
      await monitoringOrchestrator.startMonitoringOfApps(apps, appsMonitored, null);

      sinon.assert.calledTwice(appInspectorStub.startAppMonitoring);
      // Declaration order on the way up — the counterpart of the reversal the
      // stop path asks for.
      expect(startedIdentifiers()).to.deep.equal(['Component1_ComposedApp', 'Component2_ComposedApp']);
      sinon.assert.calledWith(appInspectorStub.startAppMonitoring, 'Component1_ComposedApp', appsMonitored);
      sinon.assert.calledWith(appInspectorStub.startAppMonitoring, 'Component2_ComposedApp', appsMonitored);
    });

    it('should get installed apps if no apps provided', async () => {
      const spec = legacySpec('App1');
      const apps = [await instantiatedSpec(spec)];
      const installedAppsFn = sinon.stub().resolves({ status: 'success', data: apps });
      installed.set(spec.name, [deploymentOf(spec)]);

      const appsMonitored = {};
      await monitoringOrchestrator.startMonitoringOfApps(null, appsMonitored, installedAppsFn);

      sinon.assert.calledOnce(installedAppsFn);
      sinon.assert.calledOnce(appInspectorStub.startAppMonitoring);
      expect(startedIdentifiers()).to.deep.equal(['App1']);
      assertLookedUpByName([spec]);
    });

    it('should skip apps that fail to resolve', async () => {
      const good = legacySpec('GoodApp');
      const bad = legacySpec('BadApp');
      const apps = await Promise.all([good, bad].map((spec) => instantiatedSpec(spec)));
      // GoodApp is installed here; BadApp is a spec this node holds no
      // deployment for, which is what the real provider answers with [] for.
      installed.set(good.name, [deploymentOf(good)]);

      const appsMonitored = {};
      await monitoringOrchestrator.startMonitoringOfApps(apps, appsMonitored, null);

      sinon.assert.calledOnce(appInspectorStub.startAppMonitoring);
      sinon.assert.calledWith(appInspectorStub.startAppMonitoring, 'GoodApp', appsMonitored);
      // Both apps were still LOOKED UP - the skip is the provider's empty
      // answer, not the orchestrator declining to ask.
      assertLookedUpByName([good, bad]);
    });

    it('should handle errors gracefully', async () => {
      const spec = legacySpec('App1');
      getInstalledDeploymentsStub.rejects(new Error('deployment resolution failed'));

      await monitoringOrchestrator.startMonitoringOfApps([await instantiatedSpec(spec)], {}, null);

      sinon.assert.calledOnce(logStub.error);
      sinon.assert.notCalled(appInspectorStub.startAppMonitoring);
    });

    it('monitors each co-located replica under its own identifier', async () => {
      // The outer loop over deployments, which the old double could not reach:
      // it produced exactly one deployment per app and no replica at all. A
      // pinned v9 app co-located on this node runs one container per replica,
      // and appInspector.startAppMonitoring assigns `appsMonitored[id] = {}`
      // outright — so two replicas sharing an identifier would mean the second
      // silently replacing the first's monitoring.
      const spec = await coLocatedSpec();
      const stored = await instantiatedSpec(spec, { identity: 'deadbeef' });
      expect(stored.identity, 'the identity is read off the row, never recomputed').to.equal('deadbeef');
      installed.set(spec.name, [
        deploymentOf(spec, { replica: 'r1', identity: stored.identity }),
        deploymentOf(spec, { replica: 'r2', identity: stored.identity }),
      ]);

      const appsMonitored = {};
      await monitoringOrchestrator.startMonitoringOfApps([stored], appsMonitored, null);

      const ids = startedIdentifiers();
      expect(ids).to.deep.equal(['web_deadbeef_r1', 'web_deadbeef_r2']);
      expect(new Set(ids).size, 'two replicas must not share one monitoring key').to.equal(ids.length);
    });
  });

  describe('stopMonitoringOfApps tests', () => {
    it('should stop monitoring for single-component apps', async () => {
      const spec = legacySpec('App1');
      const apps = [await instantiatedSpec(spec)];
      installed.set(spec.name, [deploymentOf(spec)]);

      const appsMonitored = {};
      await monitoringOrchestrator.stopMonitoringOfApps(apps, false, appsMonitored, null);

      sinon.assert.calledOnce(appInspectorStub.stopAppMonitoring);
      sinon.assert.calledWith(appInspectorStub.stopAppMonitoring, 'App1', false, appsMonitored);
      assertLookedUpByName([spec]);
    });

    it('should stop monitoring for multi-component apps, in reverse declaration order', async () => {
      // The reversal is the option the hand-written double ignored. Production
      // asks for `componentEntries({ reverse: true })`; the double returned the
      // same array whatever it was asked, so this ordering was asserted nowhere
      // and could have been dropped from flux-spec with the suite still green.
      const spec = composedSpec('ComposedApp', ['Component1', 'Component2']);
      const apps = [await instantiatedSpec(spec)];
      const deployment = deploymentOf(spec);
      expect(
        deployment.componentEntries({ reverse: true }).map(([name]) => name),
        'the real deployment honours the reverse option',
      ).to.deep.equal(['Component2', 'Component1']);
      installed.set(spec.name, [deployment]);

      const appsMonitored = {};
      await monitoringOrchestrator.stopMonitoringOfApps(apps, true, appsMonitored, null);

      sinon.assert.calledTwice(appInspectorStub.stopAppMonitoring);
      expect(stoppedIdentifiers()).to.deep.equal(['Component2_ComposedApp', 'Component1_ComposedApp']);
      sinon.assert.calledWith(appInspectorStub.stopAppMonitoring, 'Component1_ComposedApp', true, appsMonitored);
      sinon.assert.calledWith(appInspectorStub.stopAppMonitoring, 'Component2_ComposedApp', true, appsMonitored);
    });

    it('should get installed apps if no apps provided', async () => {
      const spec = legacySpec('App1');
      const apps = [await instantiatedSpec(spec)];
      const installedAppsFn = sinon.stub().resolves({ status: 'success', data: apps });
      installed.set(spec.name, [deploymentOf(spec)]);

      const appsMonitored = {};
      await monitoringOrchestrator.stopMonitoringOfApps(null, false, appsMonitored, installedAppsFn);

      sinon.assert.calledOnce(installedAppsFn);
      sinon.assert.calledOnce(appInspectorStub.stopAppMonitoring);
      expect(stoppedIdentifiers()).to.deep.equal(['App1']);
    });

    it('stops exactly the identifiers it started, for a co-located app', async () => {
      // Start and stop must agree on the monitoring key or a replica is left
      // running its one-minute interval forever. Same identifiers, opposite
      // order within each deployment.
      const spec = await coLocatedSpec();
      const stored = await instantiatedSpec(spec, { identity: 'deadbeef' });
      installed.set(spec.name, [
        deploymentOf(spec, { replica: 'r1', identity: stored.identity }),
        deploymentOf(spec, { replica: 'r2', identity: stored.identity }),
      ]);

      const appsMonitored = {};
      await monitoringOrchestrator.startMonitoringOfApps([stored], appsMonitored, null);
      await monitoringOrchestrator.stopMonitoringOfApps([stored], true, appsMonitored, null);

      expect(stoppedIdentifiers().slice().sort()).to.deep.equal(startedIdentifiers().slice().sort());
      expect(stoppedIdentifiers()).to.have.lengthOf(2);
    });
  });

  // The fixtures above are the versions they are because the real library
  // refuses the alternative. Asserted rather than commented, so a fixture
  // cannot quietly drift back.
  describe('fictions the real library refuses', () => {
    it('refuses a mixed-case app name at v9', async () => {
      // Every app name this file uses is mixed case, which only a legacy spec
      // accepts: v9 names match ^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$. A double
      // named `App1` at any version proves nothing about either rule.
      let threw = null;
      await v9Spec({ name: 'App1' }).catch((err) => { threw = err; });
      expect(threw, 'a mixed-case v9 name').to.be.an('error');
      expect(threw.message).to.include('name');

      // v8 enforces neither the character set nor the prefix rule, which is why
      // the composed fixture above is a v8 and really is called ComposedApp.
      expect(composedSpec('ComposedApp', ['Component1', 'Component2']).name).to.equal('ComposedApp');
    });

    it('refuses co-located replicas that would bind the same host port', async () => {
      // The co-location fixture carries a per-replica hostPort override because
      // the library will not accept it otherwise: two replicas of the same
      // component on one node cannot both bind 31000. A hand-written deployment
      // double co-locates for free, so every co-location it modelled was one no
      // node could ever have been asked to run.
      let threw = null;
      await v9Spec({
        assignment: { targetIps: { '1.2.3.4:16127': ['r1', 'r2'] } },
        instances: undefined,
      }).catch((err) => { threw = err; });
      expect(threw, 'two replicas of one component on one host port').to.be.an('error');
      expect(threw.message).to.include('hostPort');

      // And the override really is what makes it legal — the two replicas end
      // up on different host ports, which is the point of the constraint.
      const spec = await coLocatedSpec();
      expect(deploymentOf(spec, { replica: 'r1' }).allHostPorts()).to.deep.equal([31000]);
      expect(deploymentOf(spec, { replica: 'r2' }).allHostPorts()).to.deep.equal([31001]);
    });
  });
});
