'use strict';

// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
// Real capability singleton - un-stubbed in proxyquire, so the module and the test share it.
const capabilities = require('../../ZelBack/src/services/utils/capabilities');
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');

const TWO_HOURS = 2 * 60 * 60 * 1000;

describe('daemonHealthMonitor tests', () => {
  let daemonHealthMonitor;
  let logStub;
  let appsRepositoryStub;
  let appUninstallerStub;
  let reachable;
  let synced;
  let clock;

  beforeEach(() => {
    capabilities.resetForTests();
    reachable = capabilities.claim('daemonReachable', 'daemonStatus');
    synced = capabilities.claim('daemonSynced', 'daemonStatus');
    reachable.raise('RPC answered');
    clock = sinon.useFakeTimers();

    logStub = {
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
    };
    appsRepositoryStub = {
      listInstalledApps: sinon.stub().resolves([{ name: 'app1' }, { name: 'app2' }]),
    };
    appUninstallerStub = {
      uninstallApplication: sinon.stub().resolves(),
    };

    daemonHealthMonitor = proxyquire.noCallThru()('../../ZelBack/src/services/appMonitoring/daemonHealthMonitor', {
      '../../lib/log': logStub,
      '../appDatabase/appsRepository': appsRepositoryStub,
      '../appLifecycle/appUninstaller': appUninstallerStub,
    });
  });

  afterEach(() => {
    clock.restore();
    sinon.restore();
    capabilities.resetForTests();
  });

  // Lets the removal the deadline started run through its awaits.
  async function settle() {
    await clock.tickAsync(0);
  }

  it('removes every app once the daemon has been unsynced for two hours', async () => {
    synced.raise('synced');
    daemonHealthMonitor.start();

    synced.lower('behind');
    await clock.tickAsync(TWO_HOURS - 1);
    expect(appUninstallerStub.uninstallApplication.called, 'not before the two hours').to.equal(false);

    await clock.tickAsync(1);
    await settle();
    expect(appUninstallerStub.uninstallApplication.callCount).to.equal(2);
    sinon.assert.calledWith(appUninstallerStub.uninstallApplication, 'app1', {
      forceKill: true, skipGuard: true, broadcastRemoval: true, background: true,
    });
  });

  it('cancels the removal when the daemon syncs again inside the two hours', async () => {
    synced.raise('synced');
    daemonHealthMonitor.start();

    synced.lower('behind');
    await clock.tickAsync(TWO_HOURS / 2);
    synced.raise('caught up');
    await clock.tickAsync(TWO_HOURS);
    await settle();

    expect(appUninstallerStub.uninstallApplication.called).to.equal(false);
  });

  it('arms at once when the daemon is not synced as it starts', async () => {
    daemonHealthMonitor.start();

    await clock.tickAsync(TWO_HOURS);
    await settle();

    expect(appUninstallerStub.uninstallApplication.callCount).to.equal(2);
  });

  it('counts an unreachable daemon as unsynced', async () => {
    synced.raise('synced');
    daemonHealthMonitor.start();

    reachable.lower('RPC did not answer');
    await clock.tickAsync(TWO_HOURS);
    await settle();

    expect(appUninstallerStub.uninstallApplication.callCount).to.equal(2);
  });

  // A canary for the negative tests above: the same timeline with the daemon
  // staying down does remove.
  it('measures the two hours from the down edge, and a second down edge starts a new two hours', async () => {
    synced.raise('synced');
    daemonHealthMonitor.start();

    synced.lower('behind');
    await clock.tickAsync(TWO_HOURS / 2);
    synced.raise('caught up');
    synced.lower('behind again');
    await clock.tickAsync(TWO_HOURS - 1);
    await settle();
    expect(appUninstallerStub.uninstallApplication.called, 'the first window was cancelled').to.equal(false);

    await clock.tickAsync(1);
    await settle();
    expect(appUninstallerStub.uninstallApplication.callCount).to.equal(2);
  });

  it('removes even while an operation is in flight - the uninstaller handles a busy app', async () => {
    operationRegistry.acquire('app1', 'backup', 'test');
    daemonHealthMonitor.start();

    await clock.tickAsync(TWO_HOURS);
    await settle();
    operationRegistry.clear();

    expect(appUninstallerStub.uninstallApplication.callCount).to.equal(2);
  });

  it('keeps removing the rest when one removal fails', async () => {
    appsRepositoryStub.listInstalledApps.resolves([{ name: 'app1' }, { name: 'app2' }, { name: 'app3' }]);
    appUninstallerStub.uninstallApplication.onCall(1).rejects(new Error('Removal failed'));
    daemonHealthMonitor.start();

    await clock.tickAsync(TWO_HOURS);
    await settle();

    expect(appUninstallerStub.uninstallApplication.callCount).to.equal(3);
    expect(logStub.error.calledWith('Failed to remove app2: Removal failed')).to.equal(true);
  });

  it('removes nothing when no apps are installed', async () => {
    appsRepositoryStub.listInstalledApps.resolves(null);
    daemonHealthMonitor.start();

    await clock.tickAsync(TWO_HOURS);
    await settle();

    expect(logStub.info.calledWith('No apps installed, nothing to remove')).to.equal(true);
    expect(appUninstallerStub.uninstallApplication.called).to.equal(false);
  });
});
