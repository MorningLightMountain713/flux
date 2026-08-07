const { expect } = require('chai');
const sinon = require('sinon');

const daemonSubscriptionService = require('../../ZelBack/src/services/daemonService/daemonSubscriptionService');
const reorgSource = require('../../ZelBack/src/services/daemonService/reorgSource');

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
