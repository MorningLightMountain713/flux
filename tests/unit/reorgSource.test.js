const { expect } = require('chai');
const sinon = require('sinon');

const cacheManager = require('../../ZelBack/src/services/utils/cacheManager').default;
const daemonServiceUtils = require('../../ZelBack/src/services/daemonService/daemonServiceUtils');
const daemonSubscriptionService = require('../../ZelBack/src/services/daemonService/daemonSubscriptionService');
const reorgSource = require('../../ZelBack/src/services/daemonService/reorgSource');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');

function reorgEvent(overrides = {}) {
  return {
    oldTip: { hash: 'a'.repeat(64), height: 2000 },
    newTip: { hash: 'b'.repeat(64), height: 2001 },
    fork: { hash: 'c'.repeat(64), height: 1997 },
    depth: 3,
    ...overrides,
  };
}

describe('reorgSource tests', () => {
  afterEach(() => {
    reorgSource.stop();
    sinon.restore();
  });

  describe('cache invalidation tests', () => {
    beforeEach(() => {
      cacheManager.daemonBlockCache.clear();
      cacheManager.daemonTxCache.clear();
      cacheManager.daemonGenericCache.clear();
    });

    function blockKey(identifier, verbosity) {
      return `getBlock${serviceHelper.ensureString([identifier, verbosity])}`;
    }

    it('should drop cached blocks above the fork height', () => {
      cacheManager.daemonBlockCache.set(blockKey(1998, 2), { height: 1998 });
      cacheManager.daemonBlockCache.set(blockKey(2000, 2), { height: 2000 });

      const dropped = daemonServiceUtils.invalidateCachesFromHeight(1997);

      expect(dropped.blocks).to.equal(2);
      expect(cacheManager.daemonBlockCache.get(blockKey(2000, 2))).to.equal(undefined);
    });

    it('should keep cached blocks at or below the fork height', () => {
      cacheManager.daemonBlockCache.set(blockKey(1500, 2), { height: 1500 });
      cacheManager.daemonBlockCache.set(blockKey(1997, 2), { height: 1997 });

      const dropped = daemonServiceUtils.invalidateCachesFromHeight(1997);

      expect(dropped.blocks).to.equal(0);
      expect(cacheManager.daemonBlockCache.get(blockKey(1500, 2))).to.eql({ height: 1500 });
    });

    it('should keep hash keyed blocks, which still name the same block', () => {
      const key = blockKey('d'.repeat(64), 1);
      cacheManager.daemonBlockCache.set(key, { hash: 'd'.repeat(64) });

      daemonServiceUtils.invalidateCachesFromHeight(1997);

      expect(cacheManager.daemonBlockCache.get(key)).to.not.equal(undefined);
    });

    it('should drop every cached transaction, since a txid cannot say which block it was in', () => {
      cacheManager.daemonTxCache.set('getRawTransaction["abc",1]', { txid: 'abc' });

      const dropped = daemonServiceUtils.invalidateCachesFromHeight(1997);

      expect(dropped.transactions).to.equal(1);
      expect(cacheManager.daemonTxCache.get('getRawTransaction["abc",1]')).to.equal(undefined);
    });

    it('should drop the generic cache, which holds the tip and chain tips', () => {
      cacheManager.daemonGenericCache.set('getBlockCount[]', 2001);

      const dropped = daemonServiceUtils.invalidateCachesFromHeight(1997);

      expect(dropped.generic).to.equal(1);
      expect(cacheManager.daemonGenericCache.get('getBlockCount[]')).to.equal(undefined);
    });

    it('should drop a block entry whose key it cannot parse rather than reason about it', () => {
      cacheManager.daemonBlockCache.set('getBlocknot-json', { some: 'thing' });

      const dropped = daemonServiceUtils.invalidateCachesFromHeight(1997);

      expect(dropped.blocks).to.equal(1);
    });
  });

  describe('subscription tests', () => {
    it('should subscribe when the daemon publishes chainreorg', () => {
      sinon.stub(daemonSubscriptionService, 'isTopicAvailable').returns(true);
      const subscribeStub = sinon.stub(daemonSubscriptionService, 'subscribe');

      expect(reorgSource.start()).to.equal(true);
      sinon.assert.calledWith(subscribeStub, 'chainreorg');
    });

    it('should stay out of the way when the daemon does not publish it', () => {
      sinon.stub(daemonSubscriptionService, 'isTopicAvailable').returns(false);
      const subscribeStub = sinon.stub(daemonSubscriptionService, 'subscribe');

      expect(reorgSource.start()).to.equal(false);
      sinon.assert.notCalled(subscribeStub);
    });
  });

  describe('handling tests', () => {
    let invalidateStub;

    beforeEach(() => {
      invalidateStub = sinon.stub(daemonServiceUtils, 'invalidateCachesFromHeight')
        .returns({ blocks: 0, transactions: 0, generic: 0 });
    });

    it('should invalidate from the fork height, not the tip height', () => {
      reorgSource.handleReorg(reorgEvent());

      sinon.assert.calledOnceWithExactly(invalidateStub, 1997);
    });

    it('should pass the reorg to every registered consumer', () => {
      const first = sinon.stub();
      const second = sinon.stub();
      reorgSource.onReorg(first);
      reorgSource.onReorg(second);

      reorgSource.handleReorg(reorgEvent());

      sinon.assert.calledOnce(first);
      sinon.assert.calledOnce(second);
      expect(first.firstCall.args[0].fork.height).to.equal(1997);
    });

    it('should keep notifying consumers after one of them throws', () => {
      const second = sinon.stub();
      reorgSource.onReorg(() => { throw new Error('test: consumer blew up'); });
      reorgSource.onReorg(second);

      expect(() => reorgSource.handleReorg(reorgEvent())).to.not.throw();
      sinon.assert.calledOnce(second);
    });

    it('should not leave a rejected consumer promise unhandled', async () => {
      reorgSource.onReorg(async () => { throw new Error('test: async consumer blew up'); });

      expect(() => reorgSource.handleReorg(reorgEvent())).to.not.throw();
      await new Promise((resolve) => { setImmediate(resolve); });
    });
  });
});
