const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('daemonUsageReporter', () => {
  let reporter;
  let takeRpcCallCountsStub;
  let takeAppliedSummaryStub;
  let logStub;

  function summary(overrides = {}) {
    return {
      deltas: 0, added: 0, removed: 0, updated: 0, fromHeight: null, toHeight: null, ...overrides,
    };
  }

  beforeEach(() => {
    takeRpcCallCountsStub = sinon.stub().returns(new Map());
    takeAppliedSummaryStub = sinon.stub().returns(summary());
    logStub = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };

    reporter = proxyquire('../../ZelBack/src/services/daemonService/daemonUsageReporter', {
      './daemonServiceUtils': { takeRpcCallCounts: takeRpcCallCountsStub },
      '../nodeListSource': { takeAppliedSummary: takeAppliedSummaryStub },
      '../../lib/log': logStub,
    });
  });

  afterEach(() => {
    reporter.stop();
    sinon.restore();
  });

  it('should total the calls and name each method', () => {
    takeRpcCallCountsStub.returns(new Map([['getblock', 7], ['getblockchaininfo', 2]]));

    reporter.report();

    const line = logStub.info.firstCall.args[0];
    expect(line).to.contain('rpc calls 9');
    expect(line).to.contain('getblock 7');
    expect(line).to.contain('getblockchaininfo 2');
  });

  it('should order methods by how often they were called', () => {
    takeRpcCallCountsStub.returns(new Map([['rare', 1], ['common', 50]]));

    reporter.report();

    const line = logStub.info.firstCall.args[0];
    expect(line.indexOf('common 50')).to.be.lessThan(line.indexOf('rare 1'));
  });

  it('should report the delta window with the heights it covered', () => {
    takeAppliedSummaryStub.returns(summary({
      deltas: 10, added: 3, removed: 1, updated: 174, fromHeight: 2840204, toHeight: 2840214,
    }));

    reporter.report();

    const line = logStub.info.firstCall.args[0];
    expect(line).to.contain('10 over 2840204→2840214');
    expect(line).to.contain('3 added / 1 removed / 174 updated');
  });

  it('should say so plainly when nothing arrived', () => {
    // A quiet window and a dead subscription must not read the same, which is the
    // whole reason this line exists.
    reporter.report();

    const line = logStub.info.firstCall.args[0];
    expect(line).to.contain('rpc calls 0 (none)');
    expect(line).to.contain('no deltas applied');
  });

  it('should take the counters so each window stands alone', () => {
    reporter.report();
    reporter.report();

    sinon.assert.calledTwice(takeRpcCallCountsStub);
    sinon.assert.calledTwice(takeAppliedSummaryStub);
  });

  it('should not stack timers when started twice', () => {
    const clock = sinon.useFakeTimers();

    reporter.start();
    reporter.start();
    clock.tick(300000);

    sinon.assert.calledOnce(logStub.info);
  });
});
