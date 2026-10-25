'use strict';

// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const chainUtilities = require('../../ZelBack/src/services/utils/chainUtilities');

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
