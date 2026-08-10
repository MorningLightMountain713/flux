'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const daemonSubscriptionService = require('../../ZelBack/src/services/daemonService/daemonSubscriptionService');
const reorgSource = require('../../ZelBack/src/services/daemonService/reorgSource');
const fluxEventBus = require('../../ZelBack/src/services/utils/fluxEventBus');

function publishedAs(spy, name) {
  return spy.getCalls().filter((call) => call.args[0] === name).map((call) => call.args[1]);
}

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

  describe('observability tests', () => {
    it('should announce the reorg with the heights that describe it', () => {
      const publishSpy = sinon.spy(fluxEventBus, 'publish');

      reorgSource.handleReorg(reorgEvent());

      expect(publishedAs(publishSpy, 'daemon:reorg')).to.eql([
        {
          oldTipHeight: 2000, newTipHeight: 2001, forkHeight: 1997, depth: 3,
        },
      ]);
    });

    it('should announce the reorg even when every consumer throws', () => {
      const publishSpy = sinon.spy(fluxEventBus, 'publish');
      reorgSource.onReorg(() => { throw new Error('test: consumer blew up'); });

      reorgSource.handleReorg(reorgEvent());

      expect(publishedAs(publishSpy, 'daemon:reorg')).to.have.lengthOf(1);
    });

    it('should announce the push mode it took, and the topic carrying it', () => {
      const publishSpy = sinon.spy(fluxEventBus, 'publish');
      sinon.stub(daemonSubscriptionService, 'isTopicAvailable').returns(true);
      sinon.stub(daemonSubscriptionService, 'subscribe');

      reorgSource.start();

      expect(publishedAs(publishSpy, 'daemon:subscriptionMode')).to.eql([
        { source: 'reorgSource', mode: 'push', topic: 'chainreorg' },
      ]);
    });

    it('should announce the poll mode it fell back to', () => {
      const publishSpy = sinon.spy(fluxEventBus, 'publish');
      sinon.stub(daemonSubscriptionService, 'isTopicAvailable').returns(false);

      reorgSource.start();

      expect(publishedAs(publishSpy, 'daemon:subscriptionMode')).to.eql([
        { source: 'reorgSource', mode: 'poll', topic: 'chainreorg' },
      ]);
    });
  });
});
