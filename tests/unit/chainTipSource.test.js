const { expect } = require('chai');
const sinon = require('sinon');

const chainTipSource = require('../../ZelBack/src/services/daemonService/chainTipSource');
const daemonServiceMiscRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceMiscRpcs');
const daemonSubscriptionService = require('../../ZelBack/src/services/daemonService/daemonSubscriptionService');

describe('chainTipSource tests', () => {
  let isTopicAvailableStub;
  let subscribeStub;
  let blockchainInfoStub;
  let recordChainTipStub;
  let pollServiceStub;

  beforeEach(() => {
    isTopicAvailableStub = sinon.stub(daemonSubscriptionService, 'isTopicAvailable').returns(true);
    subscribeStub = sinon.stub(daemonSubscriptionService, 'subscribe');
    blockchainInfoStub = sinon.stub(daemonServiceMiscRpcs, 'fluxDaemonBlockchainInfo').resolves(true);
    recordChainTipStub = sinon.stub(daemonServiceMiscRpcs, 'recordChainTip');
    pollServiceStub = sinon.stub(daemonServiceMiscRpcs, 'daemonBlockchainInfoService').resolves();
  });

  afterEach(() => {
    chainTipSource.stop();
    sinon.restore();
  });

  describe('mode selection tests', () => {
    it('should take the push path when the daemon publishes hashblockheight', async () => {
      const mode = await chainTipSource.start();

      expect(mode).to.equal('push');
      sinon.assert.calledOnce(subscribeStub);
      sinon.assert.notCalled(pollServiceStub);
    });

    it('should fall back to polling when the daemon does not publish it', async () => {
      isTopicAvailableStub.returns(false);

      const mode = await chainTipSource.start();

      expect(mode).to.equal('poll');
      sinon.assert.calledOnce(pollServiceStub);
      sinon.assert.notCalled(subscribeStub);
    });

    it('should check availability of the hashblockheight topic specifically', async () => {
      await chainTipSource.start();

      sinon.assert.calledWith(isTopicAvailableStub, 'hashblockheight');
    });

    it('should be idempotent on repeated starts', async () => {
      await chainTipSource.start();
      await chainTipSource.start();

      sinon.assert.calledOnce(subscribeStub);
    });
  });

  describe('push handling tests', () => {
    it('should record the tip height from a pushed message', async () => {
      await chainTipSource.start();
      const handler = subscribeStub.firstCall.args[1];

      handler.onMessage({ height: 2837899, hash: 'ab'.repeat(32) });

      sinon.assert.calledOnceWithExactly(recordChainTipStub, 2837899);
    });

    it('should refresh authoritatively when messages were missed', async () => {
      await chainTipSource.start();
      blockchainInfoStub.resetHistory();
      const handler = subscribeStub.firstCall.args[1];

      await handler.onResync('missed 3 message(s)');

      sinon.assert.calledOnce(blockchainInfoStub);
    });

    it('should seed the tip from RPC before the first block arrives', async () => {
      await chainTipSource.start();

      sinon.assert.calledOnce(blockchainInfoStub);
    });
  });

  describe('header refresh tests', () => {
    it('should keep refreshing headers on the configured interval', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      try {
        await chainTipSource.start();
        blockchainInfoStub.resetHistory();

        await clock.tickAsync(300000);
        sinon.assert.calledOnce(blockchainInfoStub);

        await clock.tickAsync(300000);
        sinon.assert.calledTwice(blockchainInfoStub);
      } finally {
        clock.restore();
      }
    });

    it('should stop refreshing once stopped', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      try {
        await chainTipSource.start();
        blockchainInfoStub.resetHistory();
        chainTipSource.stop();

        await clock.tickAsync(900000);

        sinon.assert.notCalled(blockchainInfoStub);
      } finally {
        clock.restore();
      }
    });

    it('should keep refreshing after a failed refresh rather than give up', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      try {
        await chainTipSource.start();
        blockchainInfoStub.resetHistory();
        blockchainInfoStub.resolves(false);

        await clock.tickAsync(300000);
        await clock.tickAsync(300000);

        sinon.assert.calledTwice(blockchainInfoStub);
      } finally {
        clock.restore();
      }
    });
  });
});
