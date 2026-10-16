'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

const appDomain = require('./fixtures/appDomain');
const legacyPricingRegime = require('../../ZelBack/src/services/pricing/legacyPricingRegime');
const v9PricingRegime = require('../../ZelBack/src/services/pricing/v9PricingRegime');
const appEventVerifier = require('../../ZelBack/src/services/appMessaging/appEventVerifier');

const RENEWER = '1MCBJn6qsy3YRY2YasdYMYdJcdhy1ev8Rd';

function loadChain({ lookupBlockTime = sinon.stub().resolves(1_700_000_000) } = {}) {
  const { createChain } = proxyquire('../../ZelBack/src/services/appDecisions/decisionChain', {
    '../appMessaging/confirmedMessageStore': { lookupBlockTime },
  });
  return { createChain, lookupBlockTime };
}

describe('decisionChain', () => {
  afterEach(() => sinon.restore());

  it('names the renewal signers in force at a height, and the update signers an event has there', async () => {
    const chain = await loadChain().createChain();
    expect(chain.renewalSignersAt(2_000_000)).to.include(RENEWER);
    const event = await appDomain.legacyEvent({ spec: await appDomain.v8Spec() });
    const updateSigners = sinon.stub(appEventVerifier, 'updateSignersAt').returns([RENEWER]);
    expect(chain.updateSignersAt(event, 2_000_000)).to.deep.equal([RENEWER]);
    sinon.assert.calledOnceWithExactly(updateSigners, event, 2_000_000);
  });

  it('asks a spec\'s own regime whether it is priced at the height', async () => {
    const chain = await loadChain().createChain();
    const v9 = sinon.stub(v9PricingRegime, 'pricedAt').resolves(false);
    const legacy = sinon.stub(legacyPricingRegime, 'pricedAt').resolves(true);
    expect(await chain.pricedAt(await appDomain.v9Spec(), 1234)).to.equal(false);
    expect(await chain.pricedAt(await appDomain.v8Spec(), 1234)).to.equal(true);
    sinon.assert.calledOnceWithExactly(v9, 1234);
    sinon.assert.calledOnceWithExactly(legacy, 1234);
  });

  it('reads the activation height of each version from the enforcement heights', async () => {
    const chain = await loadChain().createChain();
    expect(chain.activationHeight(4)).to.equal(1_004_000);
    expect(chain.activationHeight(99)).to.equal(undefined);
  });

  describe('blockTime', () => {
    it('reads a record\'s own block time without asking the daemon', async () => {
      const { createChain, lookupBlockTime } = loadChain();
      const chain = await createChain();
      expect(await chain.blockTime({ record: { height: 5, blockTime: 123 } })).to.equal(123);
      sinon.assert.notCalled(lookupBlockTime);
    });

    it('asks the daemon once per height for a record without one, and for an ended term\'s height', async () => {
      const { createChain, lookupBlockTime } = loadChain();
      const chain = await createChain();
      await chain.blockTime({ record: { height: 5, blockTime: null } });
      expect(await chain.blockTime({ record: { height: 5 } })).to.equal(1_700_000_000);
      expect(await chain.blockTimeAtHeight(5)).to.equal(1_700_000_000);
      sinon.assert.calledOnceWithExactly(lookupBlockTime, 5);
    });

    it('cannot answer when the daemon has no time for the height', async () => {
      const { createChain } = loadChain({ lookupBlockTime: sinon.stub().resolves(null) });
      const chain = await createChain();
      let thrown = null;
      try { await chain.blockTime({ record: { height: 5 } }); } catch (error) { thrown = error; }
      expect(thrown).to.be.an('error');
    });
  });
});
