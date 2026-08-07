const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('fluxnodeStatusSource', () => {
  let source;
  let isTopicAvailableStub;
  let subscribeStub;
  let startStub;
  let pollStub;
  let applyPushedStatusStub;
  let reevaluateStub;
  let stopStub;
  let logStub;

  const TOPICS = {
    hashBlockHeight: 'hashblockheight',
    chainReorg: 'chainreorg',
    fluxnodeListDelta: 'fluxnodelistdelta',
    fluxnodeStatus: 'fluxnodestatus',
  };

  beforeEach(() => {
    isTopicAvailableStub = sinon.stub().returns(true);
    subscribeStub = sinon.stub();
    startStub = sinon.stub().resolves();
    pollStub = sinon.stub().resolves(true);
    applyPushedStatusStub = sinon.stub().resolves();
    reevaluateStub = sinon.stub().resolves();
    stopStub = sinon.stub();
    logStub = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };

    source = proxyquire('../../ZelBack/src/services/daemonService/fluxnodeStatusSource', {
      './daemonSubscriptionService': {
        TOPICS,
        isTopicAvailable: isTopicAvailableStub,
        subscribe: subscribeStub,
      },
      '../nodeConfirmationService': {
        start: startStub,
        poll: pollStub,
        applyPushedStatus: applyPushedStatusStub,
        reevaluate: reevaluateStub,
        stop: stopStub,
      },
      '../../lib/log': logStub,
    });
  });

  afterEach(() => {
    source.stop();
    sinon.restore();
  });

  function handlerFor(topic) {
    return subscribeStub.getCalls().find((c) => c.args[0] === topic).args[1];
  }

  it('should take the push path when the daemon publishes the topic', async () => {
    const mode = await source.start();

    expect(mode).to.equal('push');
    expect(subscribeStub.calledWith(TOPICS.fluxnodeStatus)).to.be.true;
    // The confirmation service must be told, or it arms its own poll loop as well.
    sinon.assert.calledWithMatch(startStub, { push: true });
  });

  it('should poll when the daemon does not publish the topic', async () => {
    isTopicAvailableStub.withArgs(TOPICS.fluxnodeStatus).returns(false);

    const mode = await source.start();

    expect(mode).to.equal('poll');
    expect(subscribeStub.called).to.be.false;
    sinon.assert.calledOnce(startStub);
    expect(startStub.firstCall.args[0]).to.be.undefined;
  });

  it('should seed over RPC even on the push path', async () => {
    // The topic publishes on change, so a node that just booted would otherwise hold
    // no status at all until its next confirmation, hours away.
    await source.start();

    sinon.assert.calledOnce(startStub);
  });

  it('should hand a pushed status to the confirmation service', async () => {
    await source.start();
    const decoded = { status: 'CONFIRMED', txhash: 'ab', outidx: 0 };

    await handlerFor(TOPICS.fluxnodeStatus).onMessage(decoded);

    sinon.assert.calledOnceWithExactly(applyPushedStatusStub, decoded);
  });

  it('should refetch over RPC when messages were missed', async () => {
    // Nothing is replayed, so a gap leaves a status that may already be wrong.
    await source.start();

    await handlerFor(TOPICS.fluxnodeStatus).onResync('missed 2 message(s)');

    sinon.assert.calledOnce(pollStub);
  });

  it('should re-examine the windows on every block', async () => {
    // Expiry is a block count, so the chain advancing is what turns a confirmation
    // that was inside its deadline into one that is not.
    await source.start();

    await handlerFor(TOPICS.hashBlockHeight).onMessage({ height: 2000 });

    sinon.assert.calledOnce(reevaluateStub);
  });

  it('should not subscribe twice when started again', async () => {
    await source.start();
    const callsAfterFirst = subscribeStub.callCount;

    const mode = await source.start();

    expect(mode).to.equal('push');
    expect(subscribeStub.callCount).to.equal(callsAfterFirst);
  });
});
