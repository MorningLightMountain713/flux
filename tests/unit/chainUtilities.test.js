'use strict';

// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const chainUtilities = require('../../ZelBack/src/services/utils/chainUtilities');

describe('chainUtilities tests', () => {
  describe('getChainParamsPriceUpdates', () => {
    function load(getLegacyPriceSchedule) {
      return proxyquire('../../ZelBack/src/services/utils/chainUtilities', {
        '../pricing/priceOracleState': { getLegacyPriceSchedule },
        '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
      });
    }

    it('answers the price cards the chain state holds, oldest first, as a copy', async () => {
      const schedule = [{ height: 0, minPrice: 1 }, { height: 500, minPrice: 4 }, { height: 1000, minPrice: 2 }];
      const chainUtilities = load(sinon.stub().resolves(schedule));

      const forks = await chainUtilities.getChainParamsPriceUpdates();

      expect(forks.map((fork) => fork.height)).to.deep.equal([0, 500, 1000]);
      expect(forks, 'the held schedule itself was handed out').to.not.equal(schedule);
    });

    // A list without the chain's forks prices every app against stale prices,
    // and one without the configured forks too prices nothing.
    it('rejects when the chain\'s forks cannot be read', async () => {
      const chainUtilities = load(sinon.stub().rejects(new Error('connection timed out')));

      const outcome = await chainUtilities.getChainParamsPriceUpdates().catch((err) => err);

      expect(outcome, 'a price list was answered without the chain\'s forks').to.be.an('error');
    });
  });
});


// The test config runs on mainnet, so these are mainnet's payment rules.
const BASE = 't1LUs6quf7TB2zVZmexqPQdnqmrFMGZGjV6';
const MULTISIG = 't3aGJvdtd8NR6GrnqnRuVEzH6MbrXuJFLUX';
const MULTISIG_B = 't3NryfAQLGeFs9jEoeqsxmBN2QLRaRKFLUX';

describe('chainUtilities app-payment helpers', () => {
  describe('appPaymentsFrom', () => {
    it('is the height payments count from on this node\'s chain', () => {
      expect(chainUtilities.appPaymentsFrom()).to.equal(694_000);
    });
  });

  describe('appPaymentAddresses', () => {
    it('holds every address in force at a height on this node\'s chain', () => {
      expect(chainUtilities.appPaymentAddresses(1_299_999)).to.deep.equal([BASE]);
      expect(chainUtilities.appPaymentAddresses(1_670_000)).to.deep.equal([BASE, MULTISIG, MULTISIG_B]);
    });
  });

  describe('currentAppPaymentAddress', () => {
    it('is the newest address in force at a height', () => {
      expect(chainUtilities.currentAppPaymentAddress(100_000)).to.equal(BASE);
      expect(chainUtilities.currentAppPaymentAddress(1_301_000)).to.equal(MULTISIG);
      expect(chainUtilities.currentAppPaymentAddress(1_671_000)).to.equal(MULTISIG_B);
    });
  });

  describe('legacyMessageAuthorities', () => {
    it('is the two foundation multisigs, not the base address', () => {
      expect(chainUtilities.legacyMessageAuthorities()).to.deep.equal([MULTISIG, MULTISIG_B]);
    });
  });
});
