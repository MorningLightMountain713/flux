'use strict';

// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const config = require('config');
const { load } = require('@runonflux/flux-spec-cjs');

// The credit an early update gets back for time it has not used. It scales a
// price quoted per MONTH, so it must be a fraction of TIME: a fraction of
// BLOCKS answers differently across a rate change, and the PON fork is one.
//
// The rule is stated once below and then driven through updateFee, which is
// what a node actually charges from. Both halves are needed: the defect was
// that three sites computed this credit differently and none agreed, so a test
// of the arithmetic alone would pass while the node charged from another
// expression entirely.
describe('the early-update credit', () => {
  const FORK = config.get('fluxapps.daemonPONFork');
  let spec;

  before(async function loadLibrary() {
    this.timeout(30_000);
    spec = await load();
  });

  // The subscription and the elapsed time, both in seconds, is the whole rule.
  // Stated here directly so a case below can be read without running it.
  const creditFor = (registeredHeight, expire, atHeight) => {
    const paid = spec.subscriptionSeconds({ height: registeredHeight, expire });
    const elapsed = spec.secondsBetweenHeights(registeredHeight, atHeight);
    return (paid - elapsed) / paid;
  };

  describe('across the PON fork, where every previous version disagreed', () => {
    // The case that paid nothing. Registered 20,000 blocks before the fork for
    // 40,000 blocks; updated 40,000 blocks after it. Three quarters of the
    // subscription's TIME is gone, so a quarter comes back - where block-space
    // arithmetic reported MORE elapsed than the subscription contained.
    it('credits a quarter where the old arithmetic credited nothing', () => {
      const credit = creditFor(FORK - 20_000, 40_000, FORK + 40_000);
      expect(credit).to.be.closeTo(0.25, 1e-9);
    });

    it('is never more elapsed than the subscription holds', () => {
      // The shape of the defect: elapsed exceeded the span it was subtracted
      // from, so the fraction went negative while time remained.
      for (let updatedAt = FORK - 20_000; updatedAt <= FORK + 80_000; updatedAt += 5000) {
        const credit = creditFor(FORK - 20_000, 40_000, updatedAt);
        expect(credit, `at height ${updatedAt}`).to.be.at.most(1);
        if (updatedAt < FORK + 80_000) expect(credit, `at height ${updatedAt}`).to.be.above(-1);
      }
    });

    it('runs out exactly at the expiry height, not before or after', () => {
      const registered = FORK - 20_000;
      const expiresAt = spec.expiresAtHeightFor({ height: registered, expire: 40_000 });

      expect(creditFor(registered, 40_000, expiresAt - 1)).to.be.above(0);
      expect(creditFor(registered, 40_000, expiresAt)).to.be.closeTo(0, 1e-9);
      expect(creditFor(registered, 40_000, expiresAt + 1)).to.be.below(0);
    });
  });

  describe('wholly one side of the fork, where blocks and time agree', () => {
    it('credits the untouched half of a pre-fork subscription', () => {
      expect(creditFor(FORK - 200_000, 40_000, FORK - 180_000)).to.be.closeTo(0.5, 1e-9);
    });

    it('credits the untouched half of a post-fork subscription', () => {
      expect(creditFor(FORK + 100_000, 40_000, FORK + 120_000)).to.be.closeTo(0.5, 1e-9);
    });

    // Where no rate change is spanned, a block fraction IS a time fraction -
    // so these two agree with the arithmetic that was replaced, which is what
    // says the change is scoped to the crossing.
    it('agrees with the block fraction when no rate change is spanned', () => {
      const registered = FORK + 100_000;
      const blockFraction = (40_000 - 20_000) / 40_000;
      expect(creditFor(registered, 40_000, registered + 20_000)).to.be.closeTo(blockFraction, 1e-9);
    });
  });

  describe('the ends', () => {
    it('credits the whole subscription when nothing has elapsed', () => {
      expect(creditFor(FORK - 20_000, 40_000, FORK - 20_000)).to.equal(1);
    });

    it('credits nothing once the subscription is long spent', () => {
      expect(creditFor(FORK - 20_000, 40_000, FORK + 500_000)).to.be.below(0);
    });

    it('holds for a subscription that starts exactly at the fork', () => {
      expect(creditFor(FORK, 40_000, FORK + 20_000)).to.be.closeTo(0.5, 1e-9);
    });

    it('holds for a subscription that ends exactly at the fork', () => {
      const registered = FORK - 40_000;
      expect(creditFor(registered, 40_000, FORK)).to.be.closeTo(0, 1e-9);
    });
  });

  // The arithmetic above is the rule; this is the node applying it. Without
  // this, reverting the source leaves every test above green.
  describe('updateFee, which is what the node charges', () => {
    const proxyquire = require('proxyquire').noCallThru();

    // One rate card, priced off storage alone, so the monthly figure is a
    // known constant and the fee moves only with the credit. A near-zero
    // minPrice keeps the floor from hiding the subtraction.
    const CARD = {
      height: 0, cpu: 0, ram: 0, hdd: 100, port: 0, scope: 0, staticip: 0, minPrice: 0.001,
    };
    const loadRegime = () => proxyquire('../../ZelBack/src/services/pricing/legacyPricingRegime', {
      '../utils/chainUtilities': { getChainParamsPriceUpdates: async () => [CARD] },
    });

    // Answers only what pricing asks. 30GB at 100 FLUX/GB is 3000 a month,
    // quoted a third at a time, so 1000.
    const specOf = (expire) => ({
      expire,
      version: 8,
      instances: 1,
      pricesFlatPerApp: false,
      isEncrypted: false,
      placement: {
        staticIp: false, targetIps: [], targetOutpoints: [], targetOperators: [],
      },
      resourceTotals: () => ({ cpu: 0, memoryMb: 0, storageGb: 30 }),
      componentEntries: () => [],
    });

    const feeFor = async (registeredHeight, expire, atHeight) => {
      const regime = loadRegime();
      const fee = await regime.updateFee(
        specOf(expire), specOf(expire), atHeight, registeredHeight,
      );
      return Number(fee) / 1e8;
    };

    it('charges less for a fork-crossing update than for a spent subscription', async () => {
      const registered = FORK - 20_000;
      // A quarter of the subscription's time remains here...
      const withCredit = await feeFor(registered, 40_000, FORK + 40_000);
      // ...and none here, long past its expiry.
      const spent = await feeFor(registered, 40_000, FORK + 500_000);

      expect(withCredit, 'unused time must reduce the fee').to.be.below(spent);
    });

    // Exact, not a ratio: the fee with credit differs from the fee without it
    // by the credit times the previous subscription's price, times the 0.9 the
    // function applies to both. A price high enough that the minimum-price
    // floor never binds, or the subtraction would be invisible.
    it('subtracts exactly the credit the rule states', async () => {
      const registered = FORK - 20_000;
      const regime = loadRegime();
      const fee = async (atHeight) => Number(
        await regime.updateFee(specOf(40_000), specOf(40_000), atHeight, registered),
      ) / 1e8;

      const credited = await fee(FORK + 40_000);
      const spent = await fee(FORK + 500_000);

      const previousSpecsPrice = 1000 * (40_000 / spec.legacyDefaultExpire(registered));
      const expectedCredit = creditFor(registered, 40_000, FORK + 40_000) * previousSpecsPrice * 0.9;

      expect(spent - credited).to.be.closeTo(expectedCredit, 0.02);
    });
  });
});
