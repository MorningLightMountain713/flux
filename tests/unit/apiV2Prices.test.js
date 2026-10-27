'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

chai.use(chaiAsPromised);
const { expect } = chai;

// GET /v2/apps/prices: the handler's own decisions, with the pricing at its seam.
describe('GET /v2/apps/prices', () => {
  const NOW = 1_760_000_000_000;
  const IN_FORCE = {
    pricedAt: { time: NOW / 1000, height: 201 },
    prices: { cpuRate: 150_000 },
    fluxUsdPriceE4: 653,
    modifiers: { fiatMarkupBp: 500 },
  };
  let apps;
  let pricesInForceFor;

  const respond = () => ({
    ok: sinon.stub().returnsArg(0),
    fail: sinon.stub().callsFake((code, message, extra) => ({ code, message, ...extra })),
  });

  beforeEach(() => {
    sinon.useFakeTimers({ now: NOW, toFake: ['Date'] });
    pricesInForceFor = sinon.stub().resolves(IN_FORCE);
    apps = proxyquire('../../ZelBack/src/services/apiV2/apps', {
      '../pricing/v9PricingRegime': { pricesInForceFor },
    });
  });

  afterEach(() => sinon.restore());

  it('answers the prices in force for a message signed now when no timestamp is given', async () => {
    const res = respond();
    await apps.prices({ query: {} }, res);
    sinon.assert.calledOnceWithExactly(pricesInForceFor, NOW);
    sinon.assert.calledOnceWithExactly(res.ok, IN_FORCE);
  });

  it('answers the prices in force for the timestamp given', async () => {
    await apps.prices({ query: { timestamp: String(NOW - 1000) } }, respond());
    sinon.assert.calledOnceWithExactly(pricesInForceFor, NOW - 1000);
  });

  for (const [what, timestamp] of [['a timestamp that is not a number', 'soon'], ['a fractional timestamp', '1760000000000.5'], ['a repeated timestamp', ['1', '2']]]) {
    it(`refuses ${what} as a bad request`, async () => {
      const res = respond();
      await apps.prices({ query: { timestamp } }, res);
      expect(res.fail.firstCall.args[0]).to.equal('BAD_REQUEST');
      sinon.assert.notCalled(pricesInForceFor);
    });
  }

  it('refuses a timestamp a submission would refuse', async () => {
    const res = respond();
    await apps.prices({ query: { timestamp: String(NOW - 61 * 60 * 1000) } }, res);
    expect(res.fail.firstCall.args[0]).to.equal('UNPROCESSABLE');
    expect(res.fail.firstCall.args[1]).to.match(/over 1 hour old/);
    sinon.assert.notCalled(pricesInForceFor);
  });

  it('reports by name that on-chain pricing is not active', async () => {
    const refusal = new Error('On-chain pricing is not yet active (no PriceMessage in force).');
    refusal.name = 'PricingNotActive';
    pricesInForceFor.rejects(refusal);
    const res = respond();
    await apps.prices({ query: {} }, res);
    expect(res.fail.firstCall.args).to.deep.equal(['UNPROCESSABLE', refusal.message, { reason: 'PricingNotActive' }]);
  });

  it('lets any other failure out to the surface\'s error handler', async () => {
    pricesInForceFor.rejects(new Error('Daemon not yet synced.'));
    await expect(apps.prices({ query: {} }, respond())).to.be.rejectedWith('Daemon not yet synced.');
  });
});
