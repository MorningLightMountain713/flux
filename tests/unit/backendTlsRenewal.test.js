'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');
const backendTlsRenewal = require('../../ZelBack/src/services/appLifecycle/backendTlsRenewal');

// A resolved DeploymentComponent as the sweep sees it: the TLS mount is what
// flux-spec materializes for a verify:required component, and requiresBackendTls
// is the same predicate DeploymentComponent exposes.
function component(name, { tls = true, reload = { action: 'signal', signal: 'SIGHUP' }, appName = 'myapp' } = {}) {
  const loadBalancing = tls
    ? { 80: { backendTls: { verify: 'required', reload } } }
    : { 80: { backendTls: { verify: 'none' } } };
  const tlsDir = `/host/flux${name}_${appName}/io.runonflux/tls`;
  return {
    name,
    appName,
    identifier: `${name}_${appName}`,
    loadBalancing,
    requiresBackendTls() {
      return Object.values(this.loadBalancing).some((e) => e.backendTls && e.backendTls.verify === 'required');
    },
    // the domain type's own accessor - the sweep never rebuilds these paths
    backendTlsPaths: () => (tls
      ? { dir: tlsDir, certPath: `${tlsDir}/cert.pem`, keyPath: `${tlsDir}/key.pem` }
      : null),
  };
}

function deployment(...comps) {
  return { componentEntries: () => comps.map((c) => [c.name, c]) };
}

describe('backendTlsRenewal.renewalSweep', () => {
  let deps;
  let anyHeld;

  beforeEach(() => {
    anyHeld = sinon.stub(operationRegistry, 'anyHeld').returns(false);
    deps = {
      listInstalled: sinon.stub().resolves({ status: 'success', data: [{ name: 'myapp' }] }),
      getDeployments: sinon.stub().resolves([deployment(component('web'))]),
      needsRenewal: sinon.stub().resolves(true),
      provisionCert: sinon.stub().resolves(),
      signal: sinon.stub().resolves(),
      restart: sinon.stub().resolves(),
    };
  });

  afterEach(() => sinon.restore());

  it('re-issues a due cert into the materialized mount source and signals the container', async () => {
    const result = await backendTlsRenewal.renewalSweep(deps);

    expect(result).to.deep.equal({ checked: 1, renewed: 1 });
    expect(deps.provisionCert.calledOnce).to.equal(true);
    expect(deps.provisionCert.firstCall.args[0]).to.equal('myapp');
    expect(deps.provisionCert.firstCall.args[1]).to.deep.equal(component('web').backendTlsPaths());
    expect(deps.signal.calledOnceWith('web_myapp', 'SIGHUP')).to.equal(true);
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
    deps.getDeployments.resolves([deployment(component('web', { tls: false }), component('db', { tls: false }))]);

    const result = await backendTlsRenewal.renewalSweep(deps);

    expect(result).to.deep.equal({ checked: 0, renewed: 0 });
    expect(deps.provisionCert.called).to.equal(false);
  });

  it('honours the owner reload reaction: restart, and null (self-watch) signals nothing', async () => {
    deps.getDeployments.resolves([deployment(
      component('web', { reload: { action: 'restart' } }),
      component('api', { reload: null }),
    )]);

    const result = await backendTlsRenewal.renewalSweep(deps);

    expect(result).to.deep.equal({ checked: 2, renewed: 2 });
    expect(deps.restart.calledOnceWith('web_myapp')).to.equal(true);
    expect(deps.signal.called).to.equal(false);
  });

  it('renews each co-located replica independently - one identity per deployment', async () => {
    deps.getDeployments.resolves([
      deployment(component('web')),
      deployment({ ...component('web'), identifier: 'web_myapp_r2', requiresBackendTls: () => true }),
    ]);

    const result = await backendTlsRenewal.renewalSweep(deps);

    expect(result).to.deep.equal({ checked: 2, renewed: 2 });
    expect(deps.signal.args.map(([id]) => id)).to.deep.equal(['web_myapp', 'web_myapp_r2']);
  });

  it('isolates a failed re-issue: the rest of the node still renews', async () => {
    deps.listInstalled.resolves({ status: 'success', data: [{ name: 'bad' }, { name: 'good' }] });
    deps.getDeployments
      .withArgs('bad').resolves([deployment(component('web', { appName: 'bad' }))])
      .withArgs('good').resolves([deployment(component('web', { appName: 'good' }))]);
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
