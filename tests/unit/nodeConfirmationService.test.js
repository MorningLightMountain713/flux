const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const generalService = require('../../ZelBack/src/services/generalService');

describe('nodeConfirmationService', () => {
  let service;
  let clock;
  let getFluxNodeStatusStub;
  let getLocalSocketAddressStub;
  let getFluxNodePublicKeyStub;
  let getFluxnodeBySocketAddressStub;
  let isDaemonSyncedStub;
  let logStub;

  beforeEach(() => {
    clock = sinon.useFakeTimers({ shouldAdvanceTime: false });
    getFluxNodeStatusStub = sinon.stub();
    getLocalSocketAddressStub = sinon.stub();
    getFluxNodePublicKeyStub = sinon.stub();
    getFluxnodeBySocketAddressStub = sinon.stub();
    // No chain view by default, so the estimate path is what runs unless a test
    // supplies a tip.
    isDaemonSyncedStub = sinon.stub().returns({ data: { height: 0, synced: false } });
    logStub = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };

    service = proxyquire('../../ZelBack/src/services/nodeConfirmationService', {
      './daemonService/daemonServiceFluxnodeRpcs': { getFluxNodeStatus: getFluxNodeStatusStub },
      './daemonService/daemonServiceMiscRpcs': { isDaemonSynced: isDaemonSyncedStub },
      './daemonService/daemonSubscriptionService': { daemonAlive: () => true },
      './fluxNetworkHelper': {
        getLocalSocketAddress: getLocalSocketAddressStub,
        getFluxNodePublicKey: getFluxNodePublicKeyStub,
      },
      './networkStateService': { getFluxnodeBySocketAddress: getFluxnodeBySocketAddressStub },
      '../lib/log': logStub,
    });
  });

  afterEach(() => {
    clock.restore();
    sinon.restore();
  });

  function setupConfirmed() {
    getFluxNodeStatusStub.resolves({ status: 'success', data: { status: 'CONFIRMED', last_confirmed_height: 1000 } });
    getFluxNodePublicKeyStub.resolves('04abcdef1234567890');
    getLocalSocketAddressStub.resolves('1.2.3.4:16127');
    getFluxnodeBySocketAddressStub.resolves({ pubkey: '04abcdef1234567890' });
  }

  function setupNotConfirmed() {
    getFluxNodeStatusStub.resolves({ status: 'success', data: { status: 'STARTED' } });
  }

  function setupConfirmedButIpMissing() {
    getFluxNodeStatusStub.resolves({ status: 'success', data: { status: 'CONFIRMED', last_confirmed_height: 1000 } });
    getFluxNodePublicKeyStub.resolves('04abcdef1234567890');
    getLocalSocketAddressStub.resolves('1.2.3.4:16127');
    getFluxnodeBySocketAddressStub.resolves(null);
  }

  async function advancePoll() {
    await clock.tickAsync(30 * 1000);
  }

  describe('isConfirmed', () => {
    it('should return null before start', () => {
      expect(service.isConfirmed()).to.be.null;
    });

    it('should return true when daemon reports CONFIRMED', async () => {
      setupConfirmed();
      await service.start();
      expect(service.isConfirmed()).to.be.true;
    });

    it('should return false when daemon reports non-CONFIRMED status', async () => {
      setupNotConfirmed();
      await service.start();
      expect(service.isConfirmed()).to.be.false;
    });

    it('should preserve previous state when daemon RPC fails', async () => {
      setupConfirmed();
      await service.start();
      expect(service.isConfirmed()).to.be.true;

      getFluxNodeStatusStub.rejects(new Error('connection refused'));
      await advancePoll();
      expect(service.isConfirmed()).to.be.true;
    });

    it('should preserve previous state when daemon returns error status', async () => {
      setupConfirmed();
      await service.start();
      expect(service.isConfirmed()).to.be.true;

      getFluxNodeStatusStub.resolves({ status: 'error', data: 'daemon loading' });
      await advancePoll();
      expect(service.isConfirmed()).to.be.true;
    });

    it('should remain null on first poll when RPC fails', async () => {
      getFluxNodeStatusStub.rejects(new Error('connection refused'));
      await service.start();
      expect(service.isConfirmed()).to.be.null;
    });
  });

  describe('canSendMessages', () => {
    it('should return false before start', () => {
      expect(service.canSendMessages()).to.be.false;
    });

    it('should return true when all four checks pass', async () => {
      setupConfirmed();
      await service.start();
      expect(service.canSendMessages()).to.be.true;
    });

    it('should return false when confirmed but IP not in deterministic list', async () => {
      setupConfirmedButIpMissing();
      await service.start();
      expect(service.isConfirmed()).to.be.true;
      expect(service.canSendMessages()).to.be.false;
    });

    it('should return false when confirmed but pubkey mismatch', async () => {
      getFluxNodeStatusStub.resolves({ status: 'success', data: { status: 'CONFIRMED' } });
      getFluxNodePublicKeyStub.resolves('04abcdef1234567890');
      getLocalSocketAddressStub.resolves('1.2.3.4:16127');
      getFluxnodeBySocketAddressStub.resolves({ pubkey: '04different9876543210' });

      await service.start();

      expect(service.isConfirmed()).to.be.true;
      expect(service.canSendMessages()).to.be.false;
    });

    it('should return false when confirmed but IP detection fails', async () => {
      getFluxNodeStatusStub.resolves({ status: 'success', data: { status: 'CONFIRMED' } });
      getFluxNodePublicKeyStub.resolves('04abcdef1234567890');
      getLocalSocketAddressStub.resolves(null);

      await service.start();

      expect(service.isConfirmed()).to.be.true;
      expect(service.canSendMessages()).to.be.false;
    });

    it('should return false when not confirmed', async () => {
      setupNotConfirmed();
      await service.start();
      expect(service.canSendMessages()).to.be.false;
    });
  });

  describe('onMessageCapabilityChange', () => {
    it('should fire callback on false→true transition', async () => {
      const callback = sinon.spy();
      service.onMessageCapabilityChange(callback);

      setupConfirmed();
      await service.start();

      expect(callback.calledOnce).to.be.true;
      expect(callback.calledWith(true)).to.be.true;
    });

    it('should fire callback on true→false transition', async () => {
      const callback = sinon.spy();
      service.onMessageCapabilityChange(callback);

      setupConfirmed();
      await service.start();
      expect(callback.calledOnce).to.be.true;
      expect(callback.firstCall.calledWith(true)).to.be.true;

      setupNotConfirmed();
      await advancePoll();

      expect(callback.calledTwice).to.be.true;
      expect(callback.secondCall.calledWith(false)).to.be.true;
    });

    it('should not fire callback when state unchanged', async () => {
      const callback = sinon.spy();
      service.onMessageCapabilityChange(callback);

      setupNotConfirmed();
      await service.start();
      await advancePoll();

      expect(callback.called).to.be.false;
    });

    it('should not fire when confirmed changes but canSendMessages stays false', async () => {
      const callback = sinon.spy();
      service.onMessageCapabilityChange(callback);

      setupNotConfirmed();
      await service.start();

      setupConfirmedButIpMissing();
      await advancePoll();

      expect(callback.called).to.be.false;
    });

    it('should fire when IP appears in deterministic list after delay', async () => {
      const callback = sinon.spy();
      service.onMessageCapabilityChange(callback);

      setupConfirmedButIpMissing();
      await service.start();
      expect(callback.called).to.be.false;

      setupConfirmed();
      await advancePoll();

      expect(callback.calledOnce).to.be.true;
      expect(callback.calledWith(true)).to.be.true;
    });
  });

  describe('onConfirmationChange', () => {
    it('should fire on false→true transition', async () => {
      const callback = sinon.spy();
      service.onConfirmationChange(callback);

      setupConfirmed();
      await service.start();

      expect(callback.calledOnce).to.be.true;
      expect(callback.calledWith(true)).to.be.true;
    });

    it('should fire on true→false transition', async () => {
      const callback = sinon.spy();
      service.onConfirmationChange(callback);

      setupConfirmed();
      await service.start();

      setupNotConfirmed();
      await advancePoll();

      expect(callback.calledTwice).to.be.true;
      expect(callback.secondCall.calledWith(false)).to.be.true;
    });

    it('should not fire when RPC is unreachable', async () => {
      const callback = sinon.spy();
      service.onConfirmationChange(callback);

      setupConfirmed();
      await service.start();
      expect(callback.calledOnce).to.be.true;

      getFluxNodeStatusStub.rejects(new Error('connection refused'));
      await advancePoll();

      expect(callback.calledOnce).to.be.true;
    });

    it('should not fire when daemon returns error status', async () => {
      const callback = sinon.spy();
      service.onConfirmationChange(callback);

      setupConfirmed();
      await service.start();
      expect(callback.calledOnce).to.be.true;

      getFluxNodeStatusStub.resolves({ status: 'error', data: 'daemon loading' });
      await advancePoll();

      expect(callback.calledOnce).to.be.true;
    });

    it('should fire independently from message capability', async () => {
      const confirmCb = sinon.spy();
      const messageCb = sinon.spy();
      service.onConfirmationChange(confirmCb);
      service.onMessageCapabilityChange(messageCb);

      setupConfirmedButIpMissing();
      await service.start();

      expect(confirmCb.calledOnce).to.be.true;
      expect(confirmCb.calledWith(true)).to.be.true;
      expect(messageCb.called).to.be.false;
    });
  });

  describe('waitForConfirmed', () => {
    it('should resolve immediately when already confirmed', async () => {
      setupConfirmed();
      await service.start();

      let resolved = false;
      service.waitForConfirmed().then(() => { resolved = true; });
      await Promise.resolve();
      expect(resolved).to.be.true;
    });

    it('should wait until confirmed', async () => {
      setupNotConfirmed();
      await service.start();

      let resolved = false;
      service.waitForConfirmed().then(() => { resolved = true; });
      await Promise.resolve();
      expect(resolved).to.be.false;

      setupConfirmed();
      await advancePoll();
      expect(resolved).to.be.true;
    });

    it('should resolve multiple waiters on confirmation', async () => {
      setupNotConfirmed();
      await service.start();

      let resolved1 = false;
      let resolved2 = false;
      service.waitForConfirmed().then(() => { resolved1 = true; });
      service.waitForConfirmed().then(() => { resolved2 = true; });
      await Promise.resolve();
      expect(resolved1).to.be.false;
      expect(resolved2).to.be.false;

      setupConfirmed();
      await advancePoll();
      expect(resolved1).to.be.true;
      expect(resolved2).to.be.true;
    });
  });

  describe('daemon staleness', () => {
    async function setStatusAgeMinutes(minutes) {
      // Age the last observed status, then fire a single poll so it observes the
      // elapsed window. Ticking the full span would fire one poll per 30s
      // interval (252 polls for 126 min, 642 for 321 min); under full-suite
      // load those event-loop turns flake against mocha's 2s timeout.
      service.setLastStatusAgeMs(minutes * 60 * 1000);
      await clock.tickAsync(30 * 1000);
    }

    it('should not be stale initially', async () => {
      setupConfirmed();
      await service.start();
      expect(service.isDaemonStale()).to.be.false;
    });

    it('should become stale after 125 minutes of RPC failure', async () => {
      setupConfirmed();
      await service.start();

      getFluxNodeStatusStub.rejects(new Error('connection refused'));
      await setStatusAgeMinutes(126);

      expect(service.isDaemonStale()).to.be.true;
      expect(service.isConfirmed()).to.be.true;
    });

    it('should not become stale from a wall clock jump alone', async () => {
      const callback = sinon.spy();
      service.onDaemonStale(callback);

      setupConfirmed();
      await service.start();

      // An NTP correction or a resumed VM moves the wall clock without any real
      // time passing. The daemon has not actually been unreachable for a moment.
      getFluxNodeStatusStub.rejects(new Error('connection refused'));
      clock.setSystemTime(Date.now() + 400 * 60 * 1000);
      await clock.tickAsync(30 * 1000);

      expect(service.isDaemonStale()).to.be.false;
      expect(service.isConfirmed()).to.be.true;
      expect(callback.called).to.be.false;
    });

    it('should not be stale after brief RPC failure', async () => {
      setupConfirmed();
      await service.start();

      getFluxNodeStatusStub.rejects(new Error('connection refused'));
      await setStatusAgeMinutes(10);

      expect(service.isDaemonStale()).to.be.false;
      expect(service.isConfirmed()).to.be.true;
    });

    it('should fire onDaemonStale callback at 125 minutes', async () => {
      const callback = sinon.spy();
      service.onDaemonStale(callback);

      setupConfirmed();
      await service.start();

      getFluxNodeStatusStub.rejects(new Error('connection refused'));
      await setStatusAgeMinutes(124);
      expect(callback.called).to.be.false;

      await setStatusAgeMinutes(126);
      expect(callback.calledOnce).to.be.true;
    });

    it('should not fire onDaemonStale on brief RPC failures', async () => {
      const callback = sinon.spy();
      service.onDaemonStale(callback);

      setupConfirmed();
      await service.start();

      getFluxNodeStatusStub.rejects(new Error('connection refused'));
      await setStatusAgeMinutes(10);

      expect(callback.called).to.be.false;
    });

    it('should preserve messageCapable during staleness', async () => {
      setupConfirmed();
      await service.start();
      expect(service.canSendMessages()).to.be.true;

      getFluxNodeStatusStub.rejects(new Error('connection refused'));
      await setStatusAgeMinutes(126);

      expect(service.isDaemonStale()).to.be.true;
      expect(service.canSendMessages()).to.be.true;
    });

    // Expiry is a block count. The node was last confirmed at 1000, and fluxd drops it
    // once the chain is more than 640 blocks past that.
    it('should lose confirmation once the chain passes the expiration height', async () => {
      const confirmCb = sinon.spy();
      service.onConfirmationChange(confirmCb);

      setupConfirmed();
      isDaemonSyncedStub.returns({ data: { height: 1200, synced: true } });
      await service.start();
      expect(confirmCb.calledOnce).to.be.true;

      // The status RPC is down but the push socket keeps delivering the tip.
      getFluxNodeStatusStub.rejects(new Error('connection refused'));
      isDaemonSyncedStub.returns({ data: { height: 1641, synced: true } });
      await setStatusAgeMinutes(10);

      expect(service.isConfirmed()).to.be.false;
      expect(service.canSendMessages()).to.be.false;
      expect(confirmCb.calledTwice).to.be.true;
      expect(confirmCb.secondCall.calledWith(false)).to.be.true;
    });

    it('should keep confirmation while the chain is short of the expiration height', async () => {
      setupConfirmed();
      isDaemonSyncedStub.returns({ data: { height: 1200, synced: true } });
      await service.start();

      // Hours unreachable, but the chain says we are still inside the window.
      getFluxNodeStatusStub.rejects(new Error('connection refused'));
      isDaemonSyncedStub.returns({ data: { height: 1639, synced: true } });
      await setStatusAgeMinutes(600);

      expect(service.isConfirmed()).to.be.true;
    });

    // The tip is held at 1200 — 200 blocks in, well short of 640. Reading it as
    // current would say "not expired" for as long as the daemon stayed down, which is
    // the whole window this has to answer in. Once it is no longer current the
    // deadline comes from the blocks that were left at last contact: 440 of them,
    // so ~220 minutes at 30s a block.
    it('should estimate the deadline from the blocks left when the chain view is gone', async () => {
      setupConfirmed();
      isDaemonSyncedStub.returns({ data: { height: 1200, synced: true } });
      await service.start();

      getFluxNodeStatusStub.rejects(new Error('connection refused'));
      isDaemonSyncedStub.returns({ data: { height: 1200, synced: false } });

      await setStatusAgeMinutes(219);
      expect(service.isConfirmed()).to.be.true;

      await setStatusAgeMinutes(221);
      expect(service.isConfirmed()).to.be.false;
    });

    it('should recover when daemon comes back after staleness', async () => {
      const staleCb = sinon.spy();
      service.onDaemonStale(staleCb);

      setupConfirmed();
      await service.start();

      getFluxNodeStatusStub.rejects(new Error('connection refused'));
      await setStatusAgeMinutes(126);
      expect(service.isDaemonStale()).to.be.true;
      expect(staleCb.calledOnce).to.be.true;

      setupConfirmed();
      await advancePoll();
      expect(service.isDaemonStale()).to.be.false;
      expect(service.isConfirmed()).to.be.true;
      expect(service.canSendMessages()).to.be.true;
    });
  });

  describe('applyPushedStatus', () => {
    // fluxd sends display order on every topic and the decoder does not reverse.
    // An asymmetric hash is what catches a reversal; 'ab'.repeat(32) would not.
    const txhash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

    function pushed(overrides = {}) {
      return {
        blockHeight: 2000,
        status: 'CONFIRMED',
        tier: 'CUMULUS',
        confirmedHeight: 1500,
        lastConfirmedHeight: 1000,
        lastPaidHeight: 1400,
        txhash,
        outidx: 0,
        ip: '1.2.3.4:16127',
        ...overrides,
      };
    }

    it('should compose a collateral the existing parser reads back', async () => {
      // fluxNetworkMonitor matches on this string and generalService splits it apart,
      // so the two fields the topic carries have to rebuild exactly what RPC sends.
      setupConfirmed();
      await service.start();
      await service.applyPushedStatus(pushed({ outidx: 3 }));

      const { collateral } = service.getNodeStatus();
      expect(collateral).to.equal(`COutPoint(${txhash}, 3)`);
      expect(generalService.getCollateralInfo(collateral)).to.eql({ txhash, txindex: 3 });
    });

    it('should not reverse the transaction hash', async () => {
      setupConfirmed();
      await service.start();
      await service.applyPushedStatus(pushed());

      expect(service.getNodeStatus().txhash).to.equal(txhash);
    });

    it('should lose confirmation when the pushed status is no longer CONFIRMED', async () => {
      const confirmCb = sinon.spy();
      service.onConfirmationChange(confirmCb);

      setupConfirmed();
      await service.start();
      expect(service.isConfirmed()).to.be.true;

      await service.applyPushedStatus(pushed({ status: 'EXPIRED' }));

      expect(service.isConfirmed()).to.be.false;
      expect(confirmCb.lastCall.calledWith(false)).to.be.true;
    });

    it('should keep the identity fields RPC supplied and the topic does not carry', async () => {
      getFluxNodeStatusStub.resolves({
        status: 'success',
        data: { status: 'CONFIRMED', last_confirmed_height: 1000, payment_address: 't1abc' },
      });
      getFluxNodePublicKeyStub.resolves('04abcdef1234567890');
      getLocalSocketAddressStub.resolves('1.2.3.4:16127');
      getFluxnodeBySocketAddressStub.resolves({ pubkey: '04abcdef1234567890' });
      await service.start();

      await service.applyPushedStatus(pushed());

      expect(service.getNodeStatus().payment_address).to.equal('t1abc');
    });
  });

  describe('reevaluate', () => {
    it('should expire on a block that carries the chain past the deadline', async () => {
      // No new status arrives — the node simply stopped confirming, and it is the
      // chain advancing that has to notice.
      setupConfirmed();
      isDaemonSyncedStub.returns({ data: { height: 1200, synced: true } });
      await service.start();
      expect(service.isConfirmed()).to.be.true;

      isDaemonSyncedStub.returns({ data: { height: 1641, synced: true } });
      await service.reevaluate();

      expect(service.isConfirmed()).to.be.false;
    });

    it('should leave a confirmation inside its deadline alone', async () => {
      setupConfirmed();
      isDaemonSyncedStub.returns({ data: { height: 1200, synced: true } });
      await service.start();

      isDaemonSyncedStub.returns({ data: { height: 1639, synced: true } });
      await service.reevaluate();

      expect(service.isConfirmed()).to.be.true;
    });
  });

  describe('start', () => {
    it('should not start twice', async () => {
      setupNotConfirmed();
      await service.start();
      await service.start();
      expect(getFluxNodeStatusStub.calledOnce).to.be.true;
    });
  });
});
