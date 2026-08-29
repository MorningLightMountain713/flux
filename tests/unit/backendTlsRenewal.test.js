'use strict';

// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');

const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');
const backendTlsRenewal = require('../../ZelBack/src/services/appLifecycle/backendTlsRenewal');
const {
  loadSpecLibrary, V9_SUBMISSION, v9Spec, instantiatedSpec, assertAnswers,
} = require('./fixtures/fluxSpec');

// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. Every deployment the sweep walks is a real DeploymentSpec over a real
// v9 `loadBalancing` block, so the three things this module depends on are the
// library's own and not the test's: the verify:required predicate
// (DeploymentComponent.requiresBackendTls), the materialized platform-TLS mount
// the cert is written into (backendTlsPaths), and the container identifier the
// reload reaction is fired at.
//
// backendTlsService is real too — reloadReaction reads the resolved loadBalancing
// straight off the component, so the owner's declared reaction is honoured through
// the library's defaulting rather than a literal the test asserted.
//
// What stays stubbed is I/O: the installed-apps query, the deployment provider
// (two daemon RPCs and the docker socket), certificate issuance, and the docker
// signal/restart calls.

// One fixed apps folder for every DeploymentSpec here, so a component's own
// `dir` and the TLS paths derived from it cannot drift apart.
const APPS_FOLDER = '/tmp/flux/apps/';

let flux;

// ── Component roles ───────────────────────────────────────────────────
// Each role is the backendTls half of a real haproxy-http load balancer entry.
// `provider` is mandatory, `haproxy` requires a `mode`, and backendTls exists
// only on the http mode — the schema rejects every other shape.

/** Platform-managed cert, reload left to the schema default (SIGHUP). */
const MANAGED = Object.freeze({ backendTls: { verify: 'required' } });
/** Platform-managed cert; the owner wants the container recreated instead. */
const RESTART = Object.freeze({ backendTls: { verify: 'required', reload: { action: 'restart' } } });
/** Platform-managed cert; an explicit null reload means the app watches the files itself. */
const SELF_WATCH = Object.freeze({ backendTls: { verify: 'required', reload: null } });
/** The owner brings their own cert — nothing to provision, nothing to renew. */
const OWN_CERT = Object.freeze({ backendTls: { verify: 'none' } });
/** No load balancer at all: the other way a component opts out. */
const UNROUTED = null;

/**
 * Real v9 submission components, one per role. Host ports are handed out per
 * component because co-resident components cannot both claim 31000, and the
 * load-balancing key must name a declared port — the real schema is what says so.
 */
function componentsFor(roles) {
  const components = {};
  Object.entries(roles).forEach(([name, role], index) => {
    components[name] = {
      ...V9_SUBMISSION.components.web,
      name,
      ports: { http: { containerPort: 80, hostPort: 31000 + index } },
      loadBalancing: role === UNROUTED
        ? undefined
        : { http: { provider: 'haproxy', mode: 'http', ...role } },
    };
  });
  return components;
}

/** A real FluxAppSpecV9 carrying those roles. */
function specOf(roles, appName = 'myapp') {
  return v9Spec({ name: appName, components: componentsFor(roles) });
}

/** A real DeploymentSpec — the class deploymentProvider hands the sweep. */
function deploymentFor(spec, replica = null) {
  return flux.DeploymentSpec.fromSpec(spec, APPS_FOLDER, { replica });
}

/** The installed-list row appQueryService.installedApps actually produces: a
 *  real InstantiatedSpec's own serialization, not a `{ name }` literal. */
async function installedRow(spec) {
  return (await instantiatedSpec(spec)).serialize();
}

describe('backendTlsRenewal.renewalSweep', () => {
  let deps;
  let anyHeld;
  let managedSpec;

  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30000);
    flux = await loadSpecLibrary();
  });

  beforeEach(async () => {
    anyHeld = sinon.stub(operationRegistry, 'anyHeld').returns(false);
    managedSpec = await specOf({ web: MANAGED });
    deps = {
      listInstalled: sinon.stub().resolves({ status: 'success', data: [await installedRow(managedSpec)] }),
      getDeployments: sinon.stub().resolves([deploymentFor(managedSpec)]),
      needsRenewal: sinon.stub().resolves(true),
      provisionCert: sinon.stub().resolves(),
      signal: sinon.stub().resolves(),
      restart: sinon.stub().resolves(),
    };
  });

  afterEach(() => sinon.restore());

  it('re-issues a due cert into the materialized mount source and signals the container', async () => {
    const deployment = deploymentFor(managedSpec);
    const [[, web]] = deployment.componentEntries();
    // The sweep walks the deployment and asks the component two questions; both
    // must survive in flux-spec for any of the rest of this file to mean anything.
    assertAnswers(deployment, ['componentEntries']);
    assertAnswers(web, ['requiresBackendTls', 'backendTlsPaths']);

    const result = await backendTlsRenewal.renewalSweep(deps);

    expect(result).to.deep.equal({ checked: 1, renewed: 1 });
    expect(deps.provisionCert.calledOnce).to.equal(true);
    // The cert is issued for the app's NAME (the lease), not its identity.
    expect(deps.provisionCert.firstCall.args[0]).to.equal('myapp');
    expect(deps.provisionCert.firstCall.args[1]).to.deep.equal(web.backendTlsPaths());

    // ...and those paths are the mount flux-spec materialized, not a path the
    // sweep rebuilt: a caller that joined its own would write outside the bind.
    const mount = (web.mounts || []).find((m) => m.Target === flux.RESERVED_PLATFORM_TLS_PREFIX);
    expect(mount, 'a verify:required component gets the platform TLS bind').to.be.an('object');
    expect(web.backendTlsPaths().dir).to.equal(mount.Source);
    expect(mount.Source).to.have.string(web.dir);

    expect(web.identifier, 'the real container-naming rule').to.equal('web_myapp');
    expect(deps.signal.calledOnceWith(web.identifier, 'SIGHUP')).to.equal(true);
    expect(deps.restart.called).to.equal(false);
  });

  it('leaves a cert that is not due alone', async () => {
    deps.needsRenewal.resolves(false);

    const result = await backendTlsRenewal.renewalSweep(deps);

    expect(result).to.deep.equal({ checked: 1, renewed: 0 });
    expect(deps.provisionCert.called).to.equal(false);
    expect(deps.signal.called).to.equal(false);
  });

  it('ignores components that do not use platform-verified TLS', async () => {
    // Both ways of opting out: the owner's own cert on a load-balanced port, and
    // a component with no load balancer at all.
    const deployment = deploymentFor(await specOf({ web: OWN_CERT, db: UNROUTED }));
    deps.getDeployments.resolves([deployment]);

    // The real predicate is what excludes them — verify:none provisions nothing,
    // so flux-spec materializes no TLS mount and there is no path to write into.
    for (const [, comp] of deployment.componentEntries()) {
      expect(comp.requiresBackendTls(), `${comp.name} takes no managed cert`).to.equal(false);
      expect(comp.backendTlsPaths(), `${comp.name} has no managed cert path`).to.equal(null);
    }

    const result = await backendTlsRenewal.renewalSweep(deps);

    expect(result).to.deep.equal({ checked: 0, renewed: 0 });
    expect(deps.provisionCert.called).to.equal(false);
  });

  it('honours the owner reload reaction: restart, and null (self-watch) signals nothing', async () => {
    const deployment = deploymentFor(await specOf({ web: RESTART, api: SELF_WATCH }));
    deps.getDeployments.resolves([deployment]);

    const result = await backendTlsRenewal.renewalSweep(deps);

    expect(result).to.deep.equal({ checked: 2, renewed: 2 });
    expect(deps.restart.calledOnceWith('web_myapp')).to.equal(true);
    expect(deps.signal.called).to.equal(false);
  });

  it('renews each co-located replica independently - one identity per deployment', async () => {
    // Two deployments of ONE spec, each bound to its own named replica: exactly
    // what a co-located node holds, and the identifiers are the real qualified
    // form rather than a string the test appended `_r2` to.
    deps.getDeployments.resolves([deploymentFor(managedSpec, 'r1'), deploymentFor(managedSpec, 'r2')]);

    const result = await backendTlsRenewal.renewalSweep(deps);

    expect(result).to.deep.equal({ checked: 2, renewed: 2 });
    expect(deps.signal.args.map(([id]) => id)).to.deep.equal(['web_myapp_r1', 'web_myapp_r2']);
    // Each replica owns its own keypair, so each cert goes to its own directory.
    const [dirA, dirB] = deps.provisionCert.args.map(([, paths]) => paths.dir);
    expect(dirA).to.not.equal(dirB);
  });

  it('isolates a failed re-issue: the rest of the node still renews', async () => {
    const bad = await specOf({ web: MANAGED }, 'bad');
    const good = await specOf({ web: MANAGED }, 'good');
    deps.listInstalled.resolves({
      status: 'success',
      data: [await installedRow(bad), await installedRow(good)],
    });
    deps.getDeployments
      .withArgs('bad').resolves([deploymentFor(bad)])
      .withArgs('good').resolves([deploymentFor(good)]);
    deps.provisionCert.withArgs('bad').rejects(new Error('signer unreachable'));

    const result = await backendTlsRenewal.renewalSweep(deps);

    expect(result).to.deep.equal({ checked: 2, renewed: 1 });
    // the failed app is never signalled - there is no new cert to reload
    expect(deps.signal.calledOnceWith('web_good', 'SIGHUP')).to.equal(true);
  });

  it('does not fail the renewal when the reload reaction throws (a stopped container)', async () => {
    deps.signal.rejects(new Error('container is not running'));

    const result = await backendTlsRenewal.renewalSweep(deps);

    // the cert is on disk and is read on the next start
    expect(result).to.deep.equal({ checked: 1, renewed: 1 });
    expect(deps.provisionCert.calledOnce).to.equal(true);
  });

  it('skips the pass while a lifecycle operation holds the node', async () => {
    anyHeld.returns(true);

    const result = await backendTlsRenewal.renewalSweep(deps);

    expect(result).to.deep.equal({ skipped: 'operation in flight' });
    expect(deps.listInstalled.called).to.equal(false);
  });

  it('skips the pass rather than guessing when the installed list is unavailable', async () => {
    deps.listInstalled.resolves({ status: 'error' });

    const result = await backendTlsRenewal.renewalSweep(deps);

    expect(result).to.deep.equal({ skipped: 'installed list failed' });
    expect(deps.provisionCert.called).to.equal(false);
  });
});

describe('backendTlsRenewal.runSweep', () => {
  afterEach(() => sinon.restore());

  it('never throws - a sweep failure is logged and retried on the next cadence', async () => {
    sinon.stub(operationRegistry, 'anyHeld').throws(new Error('boom'));

    const result = await backendTlsRenewal.runSweep();

    expect(result).to.equal(null);
  });
});
