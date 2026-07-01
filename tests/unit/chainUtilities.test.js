// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const config = require('config');
const chainUtilities = require('../../ZelBack/src/services/utils/chainUtilities');

describe('chainUtilities tests', () => {
  describe('getChainParamsPriceUpdates', () => {
    const configStub = {
      database: { chainparams: { database: 'chainparams', collections: { chainMessages: 'chainmessages' } } },
      fluxapps: { price: [{ height: 0, minPrice: 1 }, { height: 1000, minPrice: 2 }] },
    };

    function load(findInDatabase) {
      return proxyquire('../../ZelBack/src/services/utils/chainUtilities', {
        config: configStub,
        '../dbHelper': { databaseConnection: () => ({ db: () => ({}) }), findInDatabase },
        '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
      });
    }

    it('answers the configured forks and the chain\'s, oldest first', async () => {
      const chainUtilities = load(sinon.stub().resolves([{ height: 500, message: 'p_1_2_3_4' }]));

      const forks = await chainUtilities.getChainParamsPriceUpdates();

      expect(forks.map((fork) => fork.height)).to.deep.equal([0, 500, 1000]);
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

describe('chainUtilities app-payment address helpers', () => {
  const [base, multisigA, multisigB] = config.fluxapps.appPaymentAddresses;
  // The development-only receiver is absent from the mainnet config array; it must
  // never be accepted as a payment receiver here.
  const devAddress = 't1Mzja9iJcEYeW5B4m4s1tJG8M42odFZ16A';

  describe('isAppPaymentReceiver', () => {
    it('accepts the base address at any height', () => {
      expect(chainUtilities.isAppPaymentReceiver(base.address, 0)).to.equal(true);
      expect(chainUtilities.isAppPaymentReceiver(base.address, 2_000_000)).to.equal(true);
    });

    it('accepts a multisig only at or after its activation height', () => {
      expect(chainUtilities.isAppPaymentReceiver(multisigA.address, multisigA.activeFromHeight - 1)).to.equal(false);
      expect(chainUtilities.isAppPaymentReceiver(multisigA.address, multisigA.activeFromHeight)).to.equal(true);
      expect(chainUtilities.isAppPaymentReceiver(multisigB.address, multisigB.activeFromHeight - 1)).to.equal(false);
      expect(chainUtilities.isAppPaymentReceiver(multisigB.address, multisigB.activeFromHeight)).to.equal(true);
    });

    it('never accepts the development-only address on a mainnet config', () => {
      expect(chainUtilities.isAppPaymentReceiver(devAddress, 0)).to.equal(false);
      expect(chainUtilities.isAppPaymentReceiver(devAddress, 2_000_000)).to.equal(false);
    });

    it('rejects an unrelated address', () => {
      expect(chainUtilities.isAppPaymentReceiver('t1SomeoneElse', 2_000_000)).to.equal(false);
    });
  });

  describe('currentAppPaymentAddress', () => {
    it('returns the latest-activated address at a height', () => {
      expect(chainUtilities.currentAppPaymentAddress(100_000)).to.equal(base.address);
      expect(chainUtilities.currentAppPaymentAddress(multisigA.activeFromHeight + 1000)).to.equal(multisigA.address);
      expect(chainUtilities.currentAppPaymentAddress(multisigB.activeFromHeight + 1000)).to.equal(multisigB.address);
    });
  });

  describe('legacyMessageAuthorities', () => {
    it('returns only the flagged multisigs, not the base address', () => {
      const authorities = chainUtilities.legacyMessageAuthorities();
      expect(authorities).to.deep.equal([multisigA.address, multisigB.address]);
      expect(authorities).to.not.include(base.address);
    });
  });
});
