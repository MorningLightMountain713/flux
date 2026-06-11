const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

// drainServer is loaded against the REAL globalState so these tests cover the
// drain socket handlers and the LB-state store as one behavioral unit.
const globalState = require('../../ZelBack/src/services/utils/globalState');

describe('drainServer tests', () => {
  let drainServer;
  let rebroadcastStub;
  let enqueueAllStub;
  let clock;

  const TEST_APPS = ['myapp', 'otherapp'];

  beforeEach(() => {
    clock = sinon.useFakeTimers({ now: 1_000_000_000_000 });
    rebroadcastStub = sinon.stub();
    enqueueAllStub = sinon.stub().resolves();
    drainServer = proxyquire('../../ZelBack/src/services/appMessaging/drainServer', {
      './peerNotification': { checkAndNotifyPeersOfRunningApps: rebroadcastStub },
      '../appMonitoring/appReconciler': { enqueueAll: enqueueAllStub },
      '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
    });
  });

  afterEach(() => {
    drainServer.stop();
    TEST_APPS.forEach((app) => globalState.clearAppLbState(app));
    clock.restore();
    sinon.restore();
  });

  function call(method, params, id = 1) {
    return drainServer.handleRequest(JSON.stringify({
      jsonrpc: '2.0', id, method, params,
    }));
  }

  function futureDeadline(seconds) {
    const deadlineUnixSeconds = Math.floor(Date.now() / 1000) + seconds;
    return deadlineUnixSeconds;
  }

  describe('handleRequest', () => {
    it('marks the app draining and triggers a rebroadcast on drain_app', () => {
      const response = call('drain_app', {
        app_name: 'myapp', component_name: 'web', owner_flux_id: '1abc', reason: 'reboot', deadline: futureDeadline(600),
      }, 7);

      expect(response).to.deep.equal({ jsonrpc: '2.0', id: 7, result: { ok: true } });
      expect(globalState.getAppLbState('myapp')).to.equal('draining');
      expect(rebroadcastStub.calledOnce).to.be.true;
    });

    it('marks the app stopping on stop_app', () => {
      call('stop_app', { app_name: 'myapp', deadline: futureDeadline(600) });

      expect(globalState.getAppLbState('myapp')).to.equal('stopping');
      expect(rebroadcastStub.calledOnce).to.be.true;
    });

    it('stop_app overrides a prior draining state', () => {
      call('drain_app', { app_name: 'myapp', deadline: futureDeadline(600) });
      call('stop_app', { app_name: 'myapp', deadline: futureDeadline(600) });

      expect(globalState.getAppLbState('myapp')).to.equal('stopping');
    });

    it('clears the state and rebroadcasts on clear_app', () => {
      call('drain_app', { app_name: 'myapp', deadline: futureDeadline(600) });
      rebroadcastStub.resetHistory();

      const response = call('clear_app', { app_name: 'myapp' });

      expect(response.result).to.deep.equal({ ok: true, existed: true });
      expect(globalState.getAppLbState('myapp')).to.equal(null);
      expect(rebroadcastStub.calledOnce).to.be.true;
      // recovery is reconciler-driven: the clear sweeps the app back to life
      expect(enqueueAllStub.calledOnceWith('drain-cleared')).to.be.true;
    });

    it('clear_app of an unknown app reports existed false and stays quiet', () => {
      const response = call('clear_app', { app_name: 'myapp' });

      expect(response.result).to.deep.equal({ ok: true, existed: false });
      expect(rebroadcastStub.called).to.be.false;
    });

    it('errors when drain_app omits app_name', () => {
      const response = call('drain_app', {});

      expect(response.error.code).to.equal(-32000);
      expect(response.error.message).to.contain('app_name required');
      expect(rebroadcastStub.called).to.be.false;
    });

    it('errors on an unknown method', () => {
      const response = call('nope', {});

      expect(response.error.code).to.equal(-32601);
      expect(globalState.hasAppLbStates()).to.be.false;
    });

    it('errors on malformed JSON', () => {
      const response = drainServer.handleRequest('{ not json');

      expect(response.error.code).to.equal(-32700);
    });
  });

  describe('state expiry', () => {
    it('keeps the state through the pipeline deadline plus slack, then expires it', () => {
      call('drain_app', { app_name: 'myapp', deadline: futureDeadline(600) });

      clock.tick((600 + 119) * 1000);
      expect(globalState.getAppLbState('myapp')).to.equal('draining');

      clock.tick(2 * 1000);
      expect(globalState.getAppLbState('myapp')).to.equal(null);
    });

    it('falls back to a bounded TTL when the deadline is missing or already past', () => {
      call('drain_app', { app_name: 'myapp', deadline: 0 });
      call('stop_app', { app_name: 'otherapp' });

      clock.tick(29 * 60 * 1000);
      expect(globalState.getAppLbState('myapp')).to.equal('draining');
      expect(globalState.getAppLbState('otherapp')).to.equal('stopping');

      clock.tick(2 * 60 * 1000);
      expect(globalState.getAppLbState('myapp')).to.equal(null);
      expect(globalState.getAppLbState('otherapp')).to.equal(null);
    });

    it('the sweep rebroadcasts expired apps so the network reverts to active', () => {
      call('drain_app', { app_name: 'myapp', deadline: futureDeadline(60) });
      rebroadcastStub.resetHistory();

      clock.tick((60 + 121) * 1000);

      // the interval sweep already fired via the fake clock; expired entry is
      // gone and the reversion was broadcast
      expect(globalState.hasAppLbStates()).to.be.false;
      expect(rebroadcastStub.called).to.be.true;
      expect(enqueueAllStub.calledWith('drain-expired')).to.be.true;
    });

    it('the sweep stays quiet while states are still live', () => {
      call('drain_app', { app_name: 'myapp', deadline: futureDeadline(600) });
      rebroadcastStub.resetHistory();

      const expired = drainServer.sweepExpiredStates();

      expect(expired).to.deep.equal([]);
      expect(rebroadcastStub.called).to.be.false;
      expect(globalState.getAppLbState('myapp')).to.equal('draining');
    });
  });

  describe('daemonAccessGid', () => {
    function loadWithEtcGroup(readFile) {
      return proxyquire('../../ZelBack/src/services/appMessaging/drainServer', {
        'node:fs': { promises: { readFile } },
        './peerNotification': { checkAndNotifyPeersOfRunningApps: rebroadcastStub },
        '../appMonitoring/appReconciler': { enqueueAll: enqueueAllStub },
        '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
      });
    }

    it('resolves the gid of flux-daemon-access from /etc/group', async () => {
      const etcGroup = 'docker:x:986:fluxadm\nflux-daemon-access:x:1000:fluxadm\n';
      const loaded = loadWithEtcGroup(sinon.stub().resolves(etcGroup));

      expect(await loaded.daemonAccessGid()).to.equal(1000);
    });

    it('returns null when the group is absent (dev boxes)', async () => {
      const loaded = loadWithEtcGroup(sinon.stub().resolves('docker:x:986:fluxadm\n'));

      expect(await loaded.daemonAccessGid()).to.equal(null);
    });

    it('returns null when /etc/group is unreadable', async () => {
      const loaded = loadWithEtcGroup(sinon.stub().rejects(new Error('EACCES')));

      expect(await loaded.daemonAccessGid()).to.equal(null);
    });
  });
});
