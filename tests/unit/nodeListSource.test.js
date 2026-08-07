const { expect } = require('chai');
const sinon = require('sinon');

const daemonServiceUtils = require('../../ZelBack/src/services/daemonService/daemonServiceUtils');
const daemonSubscriptionService = require('../../ZelBack/src/services/daemonService/daemonSubscriptionService');
const nodeListSource = require('../../ZelBack/src/services/nodeListSource');
const fluxEventBus = require('../../ZelBack/src/services/utils/fluxEventBus');

function publishedAs(spy, name) {
  return spy.getCalls().filter((call) => call.args[0] === name).map((call) => call.args[1]);
}

function rpcNode(overrides = {}) {
  return {
    txhash: 'a'.repeat(64),
    outidx: 0,
    ip: '10.0.0.1',
    added_height: 1000,
    confirmed_height: 1100,
    last_paid_height: 1200,
    tier: 'CUMULUS',
    payment_address: 't1payment',
    pubkey: 'pub-a',
    ...overrides,
  };
}

function delta(overrides = {}) {
  return {
    fromHeight: 2000,
    toHeight: 2001,
    fromHash: 'f'.repeat(64),
    toHash: '2'.repeat(64),
    isReorg: false,
    added: [],
    removed: [],
    updated: [],
    ...overrides,
  };
}

describe('nodeListSource tests', () => {
  let stateManager;
  let listFetcher;
  let executeCallStub;
  let subscribeStub;
  let isTopicAvailableStub;
  let handler;
  let publishSpy;

  beforeEach(() => {
    publishSpy = sinon.spy(fluxEventBus, 'publish');
    stateManager = {
      applySnapshot: sinon.stub().resolves(),
      applyDelta: sinon.stub().resolves({ applied: true }),
    };

    listFetcher = sinon.stub().resolves([rpcNode()]);

    executeCallStub = sinon.stub(daemonServiceUtils, 'executeCall').resolves({
      status: 'success',
      data: { height: 2000, blockhash: 'f'.repeat(64), nodes: [rpcNode()] },
    });

    isTopicAvailableStub = sinon.stub(daemonSubscriptionService, 'isTopicAvailable').returns(true);
    subscribeStub = sinon.stub(daemonSubscriptionService, 'subscribe').callsFake((topic, h) => {
      handler = h;
    });
  });

  afterEach(() => {
    nodeListSource.stop();
    handler = null;
    sinon.restore();
  });

  describe('availability tests', () => {
    it('should keep the fetch path when the daemon does not publish the delta topic', async () => {
      isTopicAvailableStub.returns(false);

      const used = await nodeListSource.start({ stateManager, listFetcher });

      expect(used).to.equal(false);
      sinon.assert.notCalled(subscribeStub);
      sinon.assert.notCalled(executeCallStub);
    });

    it('should subscribe before taking the snapshot', async () => {
      await nodeListSource.start({ stateManager, listFetcher });

      expect(subscribeStub.calledBefore(executeCallStub)).to.equal(true);
    });

    it('should take the snapshot from the atomic rpc', async () => {
      await nodeListSource.start({ stateManager, listFetcher });

      // One call, so the height, the block hash and the nodes all describe the same
      // moment. Asking for them separately would let a block land in between.
      sinon.assert.calledOnceWithExactly(executeCallStub, 'getFluxnodeSnapshot', []);
    });

    it('should anchor the state to the snapshot block', async () => {
      await nodeListSource.start({ stateManager, listFetcher });

      sinon.assert.calledOnceWithExactly(
        stateManager.applySnapshot,
        [rpcNode()],
        2000,
        'f'.repeat(64),
      );
    });
  });

  describe('bootstrap buffering tests', () => {
    it('should buffer deltas that arrive before the state is anchored', async () => {
      let releaseSnapshot;
      executeCallStub.returns(new Promise((resolve) => { releaseSnapshot = resolve; }));

      const starting = nodeListSource.start({ stateManager, listFetcher });

      handler.onMessage(delta({ fromHeight: 2000, toHeight: 2001 }));
      expect(nodeListSource.bufferedCount()).to.equal(1);

      releaseSnapshot({
        status: 'success',
        data: { height: 2000, blockhash: 'f'.repeat(64), nodes: [rpcNode()] },
      });
      await starting;

      sinon.assert.calledOnce(stateManager.applyDelta);
    });

    it('should discard buffered deltas the snapshot already includes', async () => {
      let releaseSnapshot;
      executeCallStub.returns(new Promise((resolve) => { releaseSnapshot = resolve; }));

      const starting = nodeListSource.start({ stateManager, listFetcher });

      handler.onMessage(delta({ fromHeight: 1998, toHeight: 1999 }));
      handler.onMessage(delta({ fromHeight: 1999, toHeight: 2000 }));
      handler.onMessage(delta({ fromHeight: 2000, toHeight: 2001 }));

      releaseSnapshot({
        status: 'success',
        data: { height: 2000, blockhash: 'f'.repeat(64), nodes: [rpcNode()] },
      });
      await starting;

      sinon.assert.calledOnce(stateManager.applyDelta);
      expect(stateManager.applyDelta.firstCall.args[0].toHeight).to.equal(2001);
    });

    it('should apply buffered deltas in transition order', async () => {
      let releaseSnapshot;
      executeCallStub.returns(new Promise((resolve) => { releaseSnapshot = resolve; }));

      const starting = nodeListSource.start({ stateManager, listFetcher });

      handler.onMessage(delta({ fromHeight: 2002, toHeight: 2003 }));
      handler.onMessage(delta({ fromHeight: 2000, toHeight: 2001 }));
      handler.onMessage(delta({ fromHeight: 2001, toHeight: 2002 }));

      releaseSnapshot({
        status: 'success',
        data: { height: 2000, blockhash: 'f'.repeat(64), nodes: [rpcNode()] },
      });
      await starting;

      const order = stateManager.applyDelta.getCalls().map((c) => c.args[0].toHeight);
      expect(order).to.eql([2001, 2002, 2003]);
    });

    it('should report failure when the snapshot cannot be taken', async () => {
      executeCallStub.resolves({ status: 'error', data: { message: 'refused' } });

      const used = await nodeListSource.start({ stateManager, listFetcher });

      expect(used).to.equal(false);
      expect(nodeListSource.isLive()).to.equal(false);
      sinon.assert.notCalled(stateManager.applySnapshot);
    });

    it('should refuse an empty snapshot rather than wipe the list', async () => {
      executeCallStub.resolves({
        status: 'success',
        data: { height: 2000, blockhash: 'f'.repeat(64), nodes: [] },
      });

      const used = await nodeListSource.start({ stateManager, listFetcher });

      expect(used).to.equal(false);
      sinon.assert.notCalled(stateManager.applySnapshot);
    });
  });

  describe('live application tests', () => {
    beforeEach(async () => {
      await nodeListSource.start({ stateManager, listFetcher });
      stateManager.applyDelta.resetHistory();
      stateManager.applySnapshot.resetHistory();
      executeCallStub.resetHistory();
    });

    it('should apply a delta once live', async () => {
      await handler.onMessage(delta());

      sinon.assert.calledOnce(stateManager.applyDelta);
      sinon.assert.notCalled(executeCallStub);
    });

    it('should refetch the list when a delta does not chain on', async () => {
      stateManager.applyDelta.resolves({ applied: false, reason: 'chain break' });

      await handler.onMessage(delta());

      sinon.assert.calledOnce(executeCallStub);
      sinon.assert.calledOnce(stateManager.applySnapshot);
    });

    it('should re-bootstrap when the subscription reports missed messages', async () => {
      await handler.onResync('missed 4 message(s)');

      sinon.assert.calledOnce(executeCallStub);
    });
  });

  describe('added node resolution tests', () => {
    beforeEach(async () => {
      await nodeListSource.start({ stateManager, listFetcher });
      listFetcher.resetHistory();
    });

    it('should look each added node up by its txhash', async () => {
      const added = [{ txhash: 'b'.repeat(64), outidx: 2 }];
      listFetcher.resolves([rpcNode({ txhash: 'b'.repeat(64), outidx: 2 })]);

      const resolved = await nodeListSource.resolveAdded(added);

      sinon.assert.calledOnceWithExactly(listFetcher, 'b'.repeat(64));
      expect(resolved).to.have.length(1);
      expect(resolved[0].added_height).to.equal(1000);
    });

    it('should pick the record matching the outpoint when a txhash returns several', async () => {
      listFetcher.resolves([
        rpcNode({ txhash: 'b'.repeat(64), outidx: 0, ip: '10.0.0.7' }),
        rpcNode({ txhash: 'b'.repeat(64), outidx: 1, ip: '10.0.0.8' }),
      ]);

      const resolved = await nodeListSource.resolveAdded([{ txhash: 'b'.repeat(64), outidx: 1 }]);

      expect(resolved).to.have.length(1);
      expect(resolved[0].ip).to.equal('10.0.0.8');
    });

    it('should drop an addition it cannot resolve rather than invent a record', async () => {
      listFetcher.resolves([]);

      const resolved = await nodeListSource.resolveAdded([{ txhash: 'c'.repeat(64), outidx: 0 }]);

      expect(resolved).to.eql([]);
    });

    it('should resolve several additions concurrently', async () => {
      listFetcher.callsFake(async (filter) => [rpcNode({ txhash: filter, outidx: 0 })]);

      const resolved = await nodeListSource.resolveAdded([
        { txhash: 'd'.repeat(64), outidx: 0 },
        { txhash: 'e'.repeat(64), outidx: 0 },
      ]);

      expect(resolved).to.have.length(2);
      sinon.assert.calledTwice(listFetcher);
    });
  });

  describe('observability tests', () => {
    it('should announce the push mode it took, and the topic carrying it', async () => {
      await nodeListSource.start({ stateManager, listFetcher });

      expect(publishedAs(publishSpy, 'daemon:subscriptionMode')).to.eql([
        { source: 'nodeListSource', mode: 'push', topic: 'fluxnodelistdelta' },
      ]);
    });

    it('should announce the fetch path it kept when the topic is absent', async () => {
      isTopicAvailableStub.returns(false);

      await nodeListSource.start({ stateManager, listFetcher });

      expect(publishedAs(publishSpy, 'daemon:subscriptionMode')).to.eql([
        { source: 'nodeListSource', mode: 'poll', topic: 'fluxnodelistdelta' },
      ]);
    });

    it('should announce the block the list is anchored to', async () => {
      await nodeListSource.start({ stateManager, listFetcher });

      expect(publishedAs(publishSpy, 'daemon:listAnchored')).to.eql([
        {
          height: 2000, blockhash: 'f'.repeat(64), nodes: 1, reason: 'startup',
        },
      ]);
    });

    it('should not announce an anchor the snapshot never established', async () => {
      executeCallStub.resolves({ status: 'error', data: { message: 'refused' } });

      await nodeListSource.start({ stateManager, listFetcher });

      expect(publishedAs(publishSpy, 'daemon:listAnchored')).to.eql([]);
    });

    describe('once live', () => {
      beforeEach(async () => {
        await nodeListSource.start({ stateManager, listFetcher });
        publishSpy.resetHistory();
      });

      it('should announce what a delta changed, in counts', async () => {
        // Distinct counts per bucket: equal ones would let the three fields be
        // transposed and still match.
        await handler.onMessage(delta({
          added: [{ txhash: 'b'.repeat(64), outidx: 0 }],
          removed: [{ txid: 'c'.repeat(64), index: 1 }, { txid: 'c'.repeat(64), index: 2 }],
          updated: [
            { txhash: 'd'.repeat(64), outidx: 0 },
            { txhash: 'd'.repeat(64), outidx: 1 },
            { txhash: 'e'.repeat(64), outidx: 0 },
          ],
        }));

        expect(publishedAs(publishSpy, 'daemon:deltaApplied')).to.eql([
          {
            fromHeight: 2000,
            toHeight: 2001,
            added: 1,
            removed: 2,
            updated: 3,
            isReorg: false,
          },
        ]);
      });

      it('should carry the reorg flag the delta arrived with', async () => {
        await handler.onMessage(delta({ isReorg: true }));

        expect(publishedAs(publishSpy, 'daemon:deltaApplied')[0].isReorg).to.equal(true);
      });

      it('should announce a refusal with the token behind it, not the prose', async () => {
        stateManager.applyDelta.resolves({
          applied: false,
          code: 'chain_mismatch',
          reason: 'delta starts at aaaa but state is at ffff',
        });

        await handler.onMessage(delta({ fromHeight: 2010, toHeight: 2011 }));

        expect(publishedAs(publishSpy, 'daemon:deltaRefused')).to.eql([
          { reason: 'chain_mismatch', fromHeight: 2010, toHeight: 2011 },
        ]);
      });

      it('should not announce a refused delta as applied', async () => {
        stateManager.applyDelta.resolves({ applied: false, code: 'not_anchored', reason: 'state is not anchored to a block' });

        await handler.onMessage(delta());

        expect(publishedAs(publishSpy, 'daemon:deltaApplied')).to.eql([]);
      });

      it('should announce the re-anchor a refusal forced', async () => {
        stateManager.applyDelta.resolves({ applied: false, code: 'chain_mismatch', reason: 'prose' });

        await handler.onMessage(delta());

        expect(publishedAs(publishSpy, 'daemon:listAnchored').map((d) => d.reason)).to.eql(['delta_refused']);
      });

      it('should carry the subscription service reason through a resync re-anchor', async () => {
        await handler.onResync('message_gap');

        expect(publishedAs(publishSpy, 'daemon:listAnchored').map((d) => d.reason)).to.eql(['message_gap']);
      });
    });

    it('should announce buffered deltas the bootstrap applied', async () => {
      let releaseSnapshot;
      executeCallStub.returns(new Promise((resolve) => { releaseSnapshot = resolve; }));

      const starting = nodeListSource.start({ stateManager, listFetcher });

      handler.onMessage(delta({ fromHeight: 2000, toHeight: 2001 }));
      handler.onMessage(delta({ fromHeight: 2001, toHeight: 2002 }));

      releaseSnapshot({
        status: 'success',
        data: { height: 2000, blockhash: 'f'.repeat(64), nodes: [rpcNode()] },
      });
      await starting;

      expect(publishedAs(publishSpy, 'daemon:deltaApplied').map((d) => d.toHeight)).to.eql([2001, 2002]);
    });

    it('should announce the buffered delta that broke the chain, and stop there', async () => {
      let releaseSnapshot;
      executeCallStub.returns(new Promise((resolve) => { releaseSnapshot = resolve; }));

      const starting = nodeListSource.start({ stateManager, listFetcher });

      handler.onMessage(delta({ fromHeight: 2000, toHeight: 2001 }));
      handler.onMessage(delta({ fromHeight: 2005, toHeight: 2006 }));

      stateManager.applyDelta.onSecondCall().resolves({
        applied: false,
        code: 'chain_mismatch',
        reason: 'delta starts at aaaa but state is at ffff',
      });

      releaseSnapshot({
        status: 'success',
        data: { height: 2000, blockhash: 'f'.repeat(64), nodes: [rpcNode()] },
      });
      await starting;

      expect(publishedAs(publishSpy, 'daemon:deltaApplied').map((d) => d.toHeight)).to.eql([2001]);
      expect(publishedAs(publishSpy, 'daemon:deltaRefused')).to.eql([
        { reason: 'chain_mismatch', fromHeight: 2005, toHeight: 2006 },
      ]);
    });
  });
});
