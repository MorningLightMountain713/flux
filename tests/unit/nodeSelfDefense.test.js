'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

// Self-defence: this node removes every app it runs the moment it is no longer
// a member. Three events, no loop; a sweep re-lists until nothing is left and
// says what stayed.
describe('nodeSelfDefense', () => {
  let nodeSelfDefense;
  let logStub;
  let installedApps;
  let uninstallApplication;
  let listeners;
  const UninstallStatus = Object.freeze({
    REMOVED: 'removed', SKIPPED: 'skipped', DEFERRED: 'deferred', FAILED: 'failed',
  });

  beforeEach(() => {
    logStub = { error: sinon.stub(), info: sinon.stub(), warn: sinon.stub() };
    installedApps = sinon.stub();
    uninstallApplication = sinon.stub().resolves({ status: UninstallStatus.REMOVED, reason: null });
    listeners = { confirmation: null, stale: null, dos: null };

    nodeSelfDefense = proxyquire('../../ZelBack/src/services/appMonitoring/nodeSelfDefense', {
      config: { fluxapps: { nodeMonitorRemovalDelayMs: 0 } },
      '../serviceHelper': { delay: sinon.stub().resolves() },
      '../nodeDosState': { onNodeDos: (cb) => { listeners.dos = cb; } },
      '../nodeConfirmationService': {
        onConfirmationChange: (cb) => { listeners.confirmation = cb; },
        onDaemonStale: (cb) => { listeners.stale = cb; },
        canSendMessages: sinon.stub().returns(false),
      },
      '../appLifecycle/appUninstaller': { uninstallApplication, UninstallStatus },
      '../appQuery/appQueryService': { installedApps },
      '../../lib/log': logStub,
    });
    nodeSelfDefense.initialize();
  });

  afterEach(() => {
    sinon.restore();
  });

  const apps = (...names) => ({ status: 'success', data: names.map((name) => ({ name })) });
  const removedNames = () => uninstallApplication.args.map(([name]) => name);

  it('subscribes to the three membership events and nothing else', () => {
    expect(listeners.confirmation).to.be.a('function');
    expect(listeners.stale).to.be.a('function');
    expect(listeners.dos).to.be.a('function');
    expect(nodeSelfDefense.monitorNodeStatus).to.equal(undefined);
  });

  it('losing confirmation removes every installed app, re-listing until nothing is left', async () => {
    // A and B at the first read; C installed while the sweep ran; then nothing.
    installedApps.onCall(0).resolves(apps('A', 'B'));
    installedApps.onCall(1).resolves(apps('C'));
    installedApps.onCall(2).resolves(apps());

    const result = await listeners.confirmation(false);

    expect(removedNames()).to.deep.equal(['A', 'B', 'C']);
    expect(uninstallApplication.firstCall.args[1]).to.deep.equal({ forceKill: true, broadcastRemoval: false });
    expect(result).to.deep.equal({ removed: 3, remaining: [] });
    expect(installedApps.callCount).to.equal(3);
  });

  it('gaining confirmation removes nothing', async () => {
    await listeners.confirmation(true);
    expect(installedApps.called).to.equal(false);
  });

  it('a pass that removes nothing ends the sweep and names what stayed and why', async () => {
    installedApps.resolves(apps('A', 'B'));
    uninstallApplication.withArgs('A').resolves({ status: UninstallStatus.DEFERRED, reason: 'An operation is already in progress for A' });
    uninstallApplication.withArgs('B').resolves({ status: UninstallStatus.FAILED, reason: 'teardown errored' });

    const result = await listeners.confirmation(false);

    // one pass, not a spin
    expect(installedApps.callCount).to.equal(1);
    expect(result.removed).to.equal(0);
    expect(result.remaining).to.deep.equal([
      { name: 'A', status: 'deferred', reason: 'An operation is already in progress for A' },
      { name: 'B', status: 'failed', reason: 'teardown errored' },
    ]);
    const said = logStub.error.args.map(([line]) => line).join('\n');
    expect(said).to.include('A=deferred');
    expect(said).to.include('B=failed');
  });

  it('an app the uninstaller no longer finds is not counted as remaining, and does not keep the sweep going', async () => {
    installedApps.resolves(apps('A'));
    uninstallApplication.resolves({ status: UninstallStatus.SKIPPED, reason: 'Flux App not found' });

    const result = await listeners.confirmation(false);

    expect(installedApps.callCount).to.equal(1);
    expect(result).to.deep.equal({ removed: 0, remaining: [] });
  });

  it('a daemon gone stale removes every app', async () => {
    installedApps.onCall(0).resolves(apps('A'));
    installedApps.onCall(1).resolves(apps());
    await listeners.stale();
    expect(removedNames()).to.deep.equal(['A']);
  });

  it('the DOS score crossing the limit removes every app', async () => {
    installedApps.onCall(0).resolves(apps('A'));
    installedApps.onCall(1).resolves(apps());
    await listeners.dos();
    expect(removedNames()).to.deep.equal(['A']);
  });

  it('a sweep that cannot list the apps is logged, and the trigger never rejects', async () => {
    installedApps.rejects(new Error('db down'));
    const outcome = await listeners.confirmation(false);
    expect(outcome).to.equal(undefined);
    expect(logStub.error.args.some(([line]) => line.includes('db down'))).to.equal(true);
  });

  it('a second trigger during a sweep is folded into it', async () => {
    let releaseFirst;
    installedApps.onCall(0).returns(new Promise((resolve) => { releaseFirst = () => resolve(apps('A')); }));
    installedApps.onCall(1).resolves(apps());

    const first = listeners.confirmation(false);
    const second = await listeners.stale();
    expect(second).to.deep.equal({ removed: 0, remaining: [], folded: true });
    releaseFirst();
    const result = await first;

    expect(removedNames()).to.deep.equal(['A']);
    expect(result).to.deep.equal({ removed: 1, remaining: [] });
  });
});
